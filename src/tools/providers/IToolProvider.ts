// Copyright (c) 2026 YCHsu. All rights reserved.
// Licensed under the MIT License.

import type { ToolCache } from '../ToolCache';
import type { ToolAuditLog } from '../ToolAuditLog';
import type { ToolPermissionDiff } from '../ToolPolicies';
import type { ToolExecutorCallbacks } from '../ToolTypes';
import type * as vscode from 'vscode';

/** 注入每個 Provider 的執行期共享上下文（不含 Provider 私有狀態） */
export interface ToolExecutionContext {
  callbacks: ToolExecutorCallbacks;
  cache: ToolCache;
  audit: ToolAuditLog;
  wsRoot: string;
  folders: readonly vscode.WorkspaceFolder[];
  /** 委派 ToolPolicies.requestPermission，Provider 不直接持有 policy 物件 */
  requestPermission(category: string, description: string, toolName?: string, diff?: ToolPermissionDiff): Promise<boolean>;
  /** 同步路徑解析（相對 → 絕對），處理日常 write/list 操作 */
  resolvePath(p: string): string;
  /** 非同步優先解析：依序嘗試磁碟 → 開啟文件 → findFiles，供 read 操作使用 */
  resolvePathSmart(p: string): Promise<string>;
  /** 呼叫主 dispatcher（Provider 遞迴呼叫其他工具時使用） */
  executeTool(name: string, args: Record<string, unknown>): Promise<string>;
  /** WhatsApp 工具委派（僅 IntegrationProvider 使用） */
  handleWhatsApp?(name: string, args: Record<string, unknown>): Promise<string>;
}

/**
 * 工具供應商（Provider）介面。
 *
 * 每個 Provider 封裝同一業務域的一組工具，
 * 持有自己的私有狀態（如 Jira token、WhatsApp socket）。
 *
 * 設計原則：
 * - `tools` 為靜態集合，ToolExecutor 用它做 O(1) dispatch
 * - `execute` 收到的 args 為 LLM 傳入的原始 JSON，Provider 自己做型別轉換
 * - Provider 不持有 ToolPolicies / ToolAuditLog；透過 ctx 委派
 */
export interface IToolProvider {
  readonly tools: ReadonlySet<string>;
  execute(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): Promise<string>;
}
