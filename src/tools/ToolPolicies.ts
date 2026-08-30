// Copyright (c) 2026 YCHsu. All rights reserved.
// Licensed under the MIT License.
import * as vscode from 'vscode';
import {
  decideAutoPilotAction,
} from '../autopilot/AutoPilotPolicy';
import { isAutoPilotActive } from '../autopilot/AutoPilotState';
import { recordAutoPilotDenial, recordAutoPilotSuccess } from '../autopilot/AutoPilotDenials';
import type { AutoPilotClassifierServices, AutoPilotTranscriptMessage } from '../autopilot/AutoPilotClassifier';

/** 與 AutoPilotClassifierServices 相同結構，單獨 export 避免模組循環依賴 */
export type AutoPilotClassifierServicesShim = AutoPilotClassifierServices;

export interface ToolPermissionDiff {
  filePath: string;
  before: string;
  after: string;
  mode?: 'replace' | 'write';
  oldStr?: string;
  newStr?: string;
}

export interface ToolPoliciesCallbacks {
  postToWebview: (msg: object) => void;
  isWaAgentMode: () => boolean;
  log: (msg: string) => void;
  /** AutoPilot LLM 分類器服務（未注入時略過 AutoPilot 判斷）*/
  getAutoPilotServices?: () => AutoPilotClassifierServicesShim;
  /** 最近的 agent transcript（供 AutoPilot classifier 判斷 user intent）*/
  getRecentTranscript?: () => AutoPilotTranscriptMessage[];
}

const AUTO_WRITE_TOOLS = new Set([
  'write_file', 'replace_in_file', 'insert_in_file', 'replace_all_in_file',
  'batch_replace', 'rename_file', 'copy_file', 'todo_write', 'memory_write',
]);

// ── Effect-based rule DSL ──────────────────────────────────────────────────────────────────────

export type ToolEffect = 'write' | 'shell' | 'network' | 'delete' | 'any';

/**
 * Single ACL rule. Stored in `amiAiClaw.toolPolicyRules` (VS Code setting).
 * Rules are evaluated top-to-bottom; first match wins.
 * Effects: write=file mutations, shell=commands, network=HTTP/browser, delete=destructive.
 * Pattern: glob for write/delete (file path); substring for shell (command) / network (URL).
 */
export interface PolicyRule {
  effect: ToolEffect;
  action: 'allow' | 'deny' | 'ask';
  pattern?: string;
}

const _WRITE_EFFECT = new Set([
  'write_file','replace_in_file','insert_in_file','replace_all_in_file',
  'batch_replace','rename_file','copy_file','todo_write','memory_write','lsp_rename_symbol',
]);
const _SHELL_EFFECT  = new Set(['run_command','run_terminal','run_python']);
const _NET_EFFECT    = new Set(['http_request','fetch_url','browser_navigate','browser_screenshot','browser_script']);

function _getEffect(toolName: string): ToolEffect | null {
  if (_WRITE_EFFECT.has(toolName)) return 'write';
  if (_SHELL_EFFECT.has(toolName)) return 'shell';
  if (_NET_EFFECT.has(toolName))   return 'network';
  if (toolName === 'delete_file')  return 'delete';
  return null;
}

/** Minimal glob: * = any non-separator chars, ** = anything including /. */
function _globMatch(pattern: string, value: string): boolean {
  const v = value.replace(/\\/g, '/');
  const re = pattern
    .replace(/\\/g, '/')
    .replace(/[.+^${}()|[\]]/g, '\\$&')
    .replace(/\*\*/g, '\x00')
    .replace(/\*/g, '[^/]*')
    .replace(/\x00/g, '.*');
  // match against full path or path suffix (allows `src/**` to match `C:/ws/src/foo.ts`)
  return new RegExp(`(^|/)${re}$`, 'i').test(v) || new RegExp(`^${re}$`, 'i').test(v);
}

/** Evaluate ordered rules; returns first matching action or null. */
export function evaluatePolicyRules(
  rules: PolicyRule[],
  effect: ToolEffect,
  value: string,
): 'allow' | 'deny' | 'ask' | null {
  for (const rule of rules) {
    if (rule.effect !== effect && rule.effect !== 'any') continue;
    if (!rule.pattern) return rule.action;
    if (effect === 'write' || effect === 'delete') {
      if (_globMatch(rule.pattern, value)) return rule.action;
    } else {
      if (value.toLowerCase().includes(rule.pattern.toLowerCase())) return rule.action;
    }
  }
  return null;
}

/**
 * 工具權限政策：alwaysAllow 集合 + 一次性確認佇列（pending promise）。
 * 把 forceConfirm / WA agent auto-allow / agentAutoApproveWrite / config alwaysAllowList
 * 這幾條規則整合在 requestPermission 內。
 */
export class ToolPolicies {
  private _alwaysAllow = new Set<string>();
  private _pendingPermission: ((allow: boolean) => void) | null = null;

  public constructor(private readonly _cb: ToolPoliciesCallbacks) {}

  public getAlwaysAllow(): ReadonlySet<string> {
    return this._alwaysAllow;
  }

  public addAlwaysAllow(category: string): void {
    this._alwaysAllow.add(category);
  }

  public hasPending(): boolean {
    return this._pendingPermission !== null;
  }

  public resolvePending(allow: boolean): boolean {
    if (!this._pendingPermission) { return false; }
    const resolve = this._pendingPermission;
    this._pendingPermission = null;
    resolve(allow);
    return true;
  }

  public async requestPermission(
    category: string,
    description: string,
    toolName = '',
    diff?: ToolPermissionDiff,
  ): Promise<boolean> {
    // ── Effect-based rule DSL（最優先）───────────────────────────────────────
    if (toolName) {
      const ruleCfg = vscode.workspace.getConfiguration('amiAiClaw');
      const rules = ruleCfg.get<PolicyRule[]>('toolPolicyRules') ?? [];
      if (rules.length > 0) {
        const effect = _getEffect(toolName);
        if (effect) {
          let matchValue = description;
          if (effect === 'write' || effect === 'delete') {
            matchValue = diff?.filePath ?? '';
          } else if (effect === 'network') {
            const m = description.match(/https?:\/\/[^\s]+/);
            if (m) matchValue = m[0];
          }
          const ruleDecision = evaluatePolicyRules(rules, effect, matchValue);
          if (ruleDecision === 'allow') { this._cb.log(`Rule DSL allow: ${toolName} [${effect}] ${matchValue.slice(0,60)}`); return true; }
          if (ruleDecision === 'deny')  { this._cb.log(`Rule DSL deny: ${toolName} [${effect}] ${matchValue.slice(0,60)}`);  return false; }
          // 'ask' 跳過 AutoPilot，直接展示對話框
          if (ruleDecision === 'ask') return new Promise<boolean>((resolve) => {
            this._pendingPermission = resolve;
            this._cb.postToWebview({ type: 'permissionRequest', category, description, forceConfirm: true, diff });
          });
        }
      }
    }
    // ── AutoPilot gateway（次優先，短路後續所有邏輯）───────────────────────
    if (isAutoPilotActive() && this._cb.getAutoPilotServices) {
      const services = this._cb.getAutoPilotServices();
      const transcript = this._cb.getRecentTranscript?.() ?? [];
      const wsFolders = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
      try {
        // Build full toolArgs for classifier (was: only filePath)
        const apArgs: Record<string, unknown> = {};
        if (diff) {
          apArgs.path = diff.filePath;
          if (diff.oldStr) apArgs.old_str = diff.oldStr;
          if (diff.newStr) apArgs.new_str = diff.newStr;
          if (diff.mode)   apArgs.mode    = diff.mode;
        }
        if ((toolName === 'run_command' || toolName === 'run_terminal') && !apArgs.command) {
          apArgs.command = description.replace(/^[^:：]+[：:]\s*/, '');
        }
        if (!apArgs.url) { const urlM = description.match(/https?:\/\/\S+/); if (urlM) apArgs.url = urlM[0]; }
        const decision = await decideAutoPilotAction({
          toolName,
          toolArgs: apArgs,
          toolDisplay: description,
          recentTranscript: transcript,
          workspaceFolders: wsFolders,
          services,
        });
        if (decision.kind === 'allow') {
          this._cb.log(`AutoPilot allow: ${toolName} — ${decision.reason}`);
          recordAutoPilotSuccess();
          return true;
        }
        if (decision.kind === 'deny') {
          this._cb.log(`AutoPilot deny: ${toolName} — ${decision.reason}`);
          recordAutoPilotDenial({ toolName: toolName || category, display: description, reason: decision.reason, timestamp: Date.now() });
          this._cb.postToWebview({ type: 'autoPilotDenied', tool: toolName, reason: decision.reason });
          return false;
        }
        // pass-through / fallback-ask → 繼續走下面原本邏輯
      } catch (e) {
        this._cb.log(`AutoPilot gateway error（fallback to manual）: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // ── 原本邏輯（不變）──────────────────────────────────────────────────────
    const pcfg = vscode.workspace.getConfiguration('amiAiClaw');
    const alwaysAllowList = pcfg.get<string[]>('toolAlwaysAllow') ?? [];
    const alwaysConfirmList = pcfg.get<string[]>('toolAlwaysConfirm') ?? [];
    const forceConfirm = toolName ? alwaysConfirmList.includes(toolName) : false;

    if (this._cb.isWaAgentMode() && !forceConfirm && category !== 'delete') {
      this._cb.log(`WA agent: auto-allow tool category=${category} tool=${toolName || '(none)'}`);
      return Promise.resolve(true);
    }
    if (pcfg.get<boolean>('agentAutoApproveWrite', false) && (category === 'write' || (toolName && AUTO_WRITE_TOOLS.has(toolName)))) {
      return Promise.resolve(true);
    }
    if ((toolName && alwaysAllowList.includes(toolName)) || alwaysAllowList.includes(category)) {
      return Promise.resolve(true);
    }
    if (!forceConfirm && this._alwaysAllow.has(category)) { return Promise.resolve(true); }

    return new Promise<boolean>((resolve) => {
      this._pendingPermission = resolve;
      this._cb.postToWebview({ type: 'permissionRequest', category, description, forceConfirm, diff });
    });
  }
}
