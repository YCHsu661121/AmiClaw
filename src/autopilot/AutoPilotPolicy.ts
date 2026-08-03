// Copyright (c) 2026 YCHsu. All rights reserved.
// Licensed under the MIT License.

/**
 * AutoPilot 決策樞紐：對單一 tool call 做出 allow / deny / fallback 的最終判斷。
 *
 * 呼叫順序（短路求值）：
 *   1. 未啟用 → pass-through，交回原始確認流程
 *   2. circuit broken → fallback-ask
 *   3. 連續拒絕已達上限 → fallback-ask（避免 auto-deny 卡住 agent）
 *   4. 在 safe allowlist → allow（不浪費 LLM 呼叫）
 *   5. 呼叫 classifier
 *      - unavailable → fallback-ask
 *      - allow → 記 success、回 allow
 *      - block → 記 denial、回 deny
 *
 * 本檔案不直接寫檔、不彈視窗。所有 IO（UI 提示、規則持久化）由呼叫端處理。
 */

import {
  isAutoPilotActive, isAutoPilotCircuitBroken,
} from './AutoPilotState';
import { isSafeAutoPilotTool } from './safeAllowlist';
import {
  recordAutoPilotDenial, recordAutoPilotSuccess, shouldAutoPilotFallbackToAsk,
} from './AutoPilotDenials';
import {
  classifyAutoPilotAction,
  type AutoPilotClassifierResult,
  type AutoPilotClassifierServices,
  type AutoPilotTranscriptMessage,
} from './AutoPilotClassifier';
import type { AutoPilotPromptRules } from './AutoPilotPrompt';
import * as path from 'path';

// 會寫入檔案的工具集合
const WRITE_TOOLS = new Set([
  'write_file', 'replace_in_file', 'insert_in_file', 'replace_all_in_file',
  'batch_replace', 'rename_file', 'copy_file', 'todo_write', 'memory_write', 'delete_file',
]);

// 高風險指令 pattern（run_command 用）
const HIGH_RISK_CMD = [
  /rm\s+-[rRf]+[rRf]+/i,       // rm -rf
  /Remove-Item.*-Recurse.*-Force/i,
  /\|\s*bash/i,                 // curl|bash
  /iwr[^|]*\|\s*iex/i,          // iwr | iex
  /\bsudo\b/, /\brunas\b/,
  /\bnpx\s+--yes\b/i,
  /\bgit\s+push.*--force\b/i,
];

// 高風險路徑 (shell RC / 排程)
const HIGH_RISK_PATHS = [
  '.bashrc', '.zshrc', '.profile', 'Profile.ps1', '.bash_profile',
  'crontab', '.crontab', 'systemd', 'launchd', 'authorized_keys',
];

/**
 * 影子規則檢查：不呼叫 LLM，純規則判斷是否自動放行。
 * only ask when: 會寫 workspace 外 OR 高風險操作
 */
export function shadowRuleCheck(
  toolName: string,
  toolArgs: Record<string, unknown>,
  workspaceFolders: string[],
): 'allow' | 'ask' {
  // 純讀工具直接放行
  if (isSafeAutoPilotTool(toolName)) return 'allow';

  // run_command: 檢查高風險 pattern
  if (toolName === 'run_command' || toolName === 'run_terminal') {
    const cmd = String(toolArgs.command ?? '');
    if (HIGH_RISK_CMD.some(re => re.test(cmd))) return 'ask';
    return 'allow';
  }

  // 寫入模型工具：檢查路徑
  if (WRITE_TOOLS.has(toolName)) {
    const filePath = String(toolArgs.path ?? toolArgs.file ?? '');
    if (filePath) {
      // 高風險路徑（shell RC 等）
      const base = path.basename(filePath);
      if (HIGH_RISK_PATHS.some(h => base === h || filePath.includes(h))) return 'ask';
      // workspace 外寫入
      if (workspaceFolders.length > 0) {
        const normalised = path.resolve(filePath).replace(/\\/g, '/');
        const inside = workspaceFolders.some(ws => normalised.startsWith(path.resolve(ws).replace(/\\/g, '/')));
        if (!inside) return 'ask';
      }
    }
    return 'allow';
  }

  // 其他工具（包含 run_python, git_commit, lint_fix, manage_todo 等）一律放行
  return 'allow';
}

export type AutoPilotDecision =
  | { kind: 'pass-through' }
  | { kind: 'allow'; reason: string; source: 'safe-allowlist' | 'classifier'; classifier?: AutoPilotClassifierResult }
  | { kind: 'deny'; reason: string; classifier?: AutoPilotClassifierResult }
  | { kind: 'fallback-ask'; reason: string };

export interface AutoPilotDecideArgs {
  toolName: string;
  toolArgs: Record<string, unknown>;
  /** 人類可讀的 tool call 摘要（如 "rm -rf D:\\old"），記錄到 denial log 用。 */
  toolDisplay: string;
  recentTranscript: AutoPilotTranscriptMessage[];
  rules?: AutoPilotPromptRules;
  workspaceFolders?: string[];
  services: AutoPilotClassifierServices;
  signal?: AbortSignal;
}

export async function decideAutoPilotAction(args: AutoPilotDecideArgs): Promise<AutoPilotDecision> {
  // 1. 未啟用：把決策權還給原本的 ToolPolicies.requestPermission
  if (!isAutoPilotActive()) {
    return { kind: 'pass-through' };
  }

  // 2. circuit broken：例如分類器連續多次拋例外被熔斷，後續一律 fallback
  if (isAutoPilotCircuitBroken()) {
    return { kind: 'fallback-ask', reason: 'AutoPilot circuit breaker is open' };
  }

  // 3. 連續拒絕太多次：可能規則設定有問題或 LLM 過度保守，回到人工流程
  if (shouldAutoPilotFallbackToAsk()) {
    return { kind: 'fallback-ask', reason: 'AutoPilot has denied too many consecutive actions; falling back to manual confirm' };
  }

  // 4. safe allowlist：純讀類 tool 直接放行，省一次 LLM 呼叫
  if (isSafeAutoPilotTool(args.toolName)) {
    recordAutoPilotSuccess();
    return { kind: 'allow', reason: 'safe-tool allowlist', source: 'safe-allowlist' };
  }

  // 5. 影子規則檢查（不呼叫 LLM，繪過大多數情況）
  const shadowVerdict = shadowRuleCheck(args.toolName, args.toolArgs, args.workspaceFolders ?? []);
  if (shadowVerdict === 'allow') {
    recordAutoPilotSuccess();
    return { kind: 'allow', reason: 'shadow-rules: within workspace, non-high-risk', source: 'safe-allowlist' };
  }
  if (shadowVerdict === 'ask') {
    return { kind: 'fallback-ask', reason: 'shadow-rules: high-risk action or write outside workspace' };
  }

  // 6. 剩餘邊界情況才和叫 LLM classifier
  const classifier = await classifyAutoPilotAction({
    toolName: args.toolName,
    toolArgs: args.toolArgs,
    recentTranscript: args.recentTranscript,
    rules: args.rules,
    signal: args.signal,
    services: args.services,
  });

  switch (classifier.verdict) {
    case 'unavailable':
      return { kind: 'fallback-ask', reason: classifier.reason };

    case 'allow':
      recordAutoPilotSuccess();
      return { kind: 'allow', reason: classifier.reason, source: 'classifier', classifier };

    case 'block':
      recordAutoPilotDenial({
        toolName: args.toolName,
        display: args.toolDisplay,
        reason: classifier.reason,
        timestamp: Date.now(),
      });
      return { kind: 'deny', reason: classifier.reason, classifier };
  }
}
