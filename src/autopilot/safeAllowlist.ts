// Copyright (c) 2026 YCHsu. All rights reserved.
// Licensed under the MIT License.

/**
 * AutoPilot 安全工具白名單：完全唯讀或對外無副作用的 tool，
 * 不需要呼叫 classifier 就可以直接允許執行（節省 token / 延遲）。
 *
 * 對應 claude-code `SAFE_YOLO_ALLOWLISTED_TOOLS`。原則：
 * - 純讀檔 / 搜尋
 * - 取得狀態類（status / info / log）
 * - 開 UI panel 但不寫資料
 * - todo / memory 「讀」端
 *
 * 任何「寫檔、執行指令、改變外部狀態」的 tool 都不應放進來。
 */
export const AUTOPILOT_SAFE_TOOLS: ReadonlySet<string> = new Set([
  // 讀檔 / 列檔
  'read_file', 'read_files', 'read_file_smart', 'read_workspace',
  'list_dir', 'glob', 'outline_file', 'file_info',
  'get_active_file',
  // 搜尋類
  'search_workspace', 'search_regex', 'agentic_file_search',
  // Git 唯讀
  'git_status', 'git_diff', 'git_log',
  // 記憶 / TODO 唯讀
  'memory_read',
  // Jira / Bitbucket / Jenkins / Rovo / WhatsApp 唯讀（純查詢，不發訊）
  'jira_fetch', 'jira_search', 'jira_open', 'jira_attachment_download',
  'jenkins_status',
  'whatsapp_status',
  'rovo_ask',
  // 比對 / 差異
  'diff_files',
  // 抓 URL 文字（不執行）
  'fetch_url',
]);

export function isSafeAutoPilotTool(name: string): boolean {
  return AUTOPILOT_SAFE_TOOLS.has(name);
}
