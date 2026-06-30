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

  // 5. 呼叫 classifier
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
