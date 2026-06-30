// Copyright (c) 2026 YCHsu. All rights reserved.
// Licensed under the MIT License.
import * as vscode from 'vscode';

export type AuditEntry = {
  ts: number;
  session: string;
  tool: string;
  argsSnippet: string;
  error: boolean;
};

export function summarizeToolArgsForAudit(args: Record<string, unknown>): string {
  return JSON.stringify(args).slice(0, 120);
}

/**
 * 200-entry ring buffer，並同步落地到 VS Code globalState（最多保留 500 筆）。
 */
export class ToolAuditLog {
  private _entries: AuditEntry[] = [];
  private static readonly RUNTIME_MAX = 200;
  private static readonly STORAGE_MAX = 500;
  private static readonly STORAGE_KEY = 'amiAiClaw.auditLog';

  public constructor(private readonly _context: vscode.ExtensionContext) {
    this._entries = (this._context.globalState.get<AuditEntry[]>(ToolAuditLog.STORAGE_KEY) ?? []).slice(-ToolAuditLog.RUNTIME_MAX);
  }

  /** 取得儲存的完整 log（最多 500 筆）。會同步刷新 in-memory 視圖。 */
  public getAll(): AuditEntry[] {
    const stored = this._context.globalState.get<AuditEntry[]>(ToolAuditLog.STORAGE_KEY) ?? this._entries;
    this._entries = stored.slice(-ToolAuditLog.RUNTIME_MAX);
    return stored;
  }

  public push(entry: AuditEntry): void {
    this._entries.push(entry);
    if (this._entries.length > ToolAuditLog.RUNTIME_MAX) { this._entries.shift(); }
    const saved = this._context.globalState.get<AuditEntry[]>(ToolAuditLog.STORAGE_KEY) ?? [];
    saved.push(entry);
    if (saved.length > ToolAuditLog.STORAGE_MAX) { saved.splice(0, saved.length - ToolAuditLog.STORAGE_MAX); }
    void this._context.globalState.update(ToolAuditLog.STORAGE_KEY, saved);
  }
}
