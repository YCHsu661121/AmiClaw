// Copyright (c) 2026 YCHsu. All rights reserved.
// Licensed under the MIT License.
import * as vscode from 'vscode';
import {
  decideAutoPilotAction,
} from '../autopilot/AutoPilotPolicy';
import { isAutoPilotActive } from '../autopilot/AutoPilotState';
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
    // ── AutoPilot gateway（最優先，短路後續所有邏輯）───────────────────────
    if (isAutoPilotActive() && this._cb.getAutoPilotServices) {
      const services = this._cb.getAutoPilotServices();
      const transcript = this._cb.getRecentTranscript?.() ?? [];
      try {
        const decision = await decideAutoPilotAction({
          toolName,
          toolArgs: {},             // category-level；詳細 args 由 ToolExecutor 升級點傳入
          toolDisplay: description,
          recentTranscript: transcript,
          services,
        });
        if (decision.kind === 'allow') {
          this._cb.log(`AutoPilot allow: ${toolName} — ${decision.reason}`);
          return true;
        }
        if (decision.kind === 'deny') {
          this._cb.log(`AutoPilot deny: ${toolName} — ${decision.reason}`);
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
