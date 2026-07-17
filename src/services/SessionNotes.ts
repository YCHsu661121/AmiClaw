/**
 * SessionNotes — 移植自 claude-code SessionMemory。
 *
 * 在 Agent 執行期間維護一份 markdown 筆記（session-notes.md），
 * 每 N 次工具呼叫自動更新一次，並於下次 Agent 啟動時注入 system prompt，
 * 解決「任務做到一半忘記自己去哪了」的問題。
 *
 * 設計原則：
 *   - 不需要 subagent — 直接從 CarryoverState 序列化，零額外 API 呼叫
 *   - 工作區範圍：存於 <workspace>/.amiclaw/memory/session-notes.md
 *   - 無工作區時 fallback 至 ~/.amiclaw/global/memory/session-notes.md
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import type { CarryoverState } from '../chat/AgentCarryover';

// ─────────────────────────────────────────────
// 路徑解析
// ─────────────────────────────────────────────

function getSessionNotesPath(): string {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const active = vscode.window.activeTextEditor?.document.uri;
  let root: string | undefined;
  if (active) {
    const wf = vscode.workspace.getWorkspaceFolder(active);
    if (wf) root = wf.uri.fsPath;
  }
  if (!root && folders.length > 0) root = folders[0].uri.fsPath;

  if (root) return path.join(root, '.amiclaw', 'memory', 'session-notes.md');

  // fallback to ~/.amiclaw/global/memory/
  const homeDir = process.env['HOME'] || process.env['USERPROFILE'] || '.';
  return path.join(homeDir, '.amiclaw', 'global', 'memory', 'session-notes.md');
}

// ─────────────────────────────────────────────
// I/O
// ─────────────────────────────────────────────

/**
 * 讀取 session-notes.md；檔案不存在時回傳空字串。
 */
export async function loadSessionNotes(): Promise<string> {
  const p = getSessionNotesPath();
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    return '';
  }
}

/**
 * 寫入 session-notes.md（自動建立父目錄）。
 */
export async function saveSessionNotes(content: string): Promise<void> {
  const p = getSessionNotesPath();
  try {
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content, 'utf8');
  } catch {
    // 非致命：記憶體寫入失敗不中斷主流程
  }
}

/**
 * 清除 session-notes.md（新任務開始時呼叫）。
 */
export async function clearSessionNotes(): Promise<void> {
  await saveSessionNotes('');
}

// ─────────────────────────────────────────────
// 從 CarryoverState 序列化筆記
// ─────────────────────────────────────────────

export interface SessionNotesContext {
  carryover: CarryoverState;
  /** 使用者的原始任務描述（第一條 user 訊息） */
  taskDescription: string;
  /** 執行至今的工具呼叫數 */
  toolCallCount: number;
  /** 最近遇到的錯誤（可空） */
  recentErrors?: string[];
}

/**
 * 從 CarryoverState 建立（或更新）session notes 內容。
 *
 * 保留既有的「## Task」與「## Errors」sections（追加而非覆蓋），
 * 其餘 sections 每次全量覆寫。
 */
export function buildSessionNotes(ctx: SessionNotesContext, existing: string): string {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const c = ctx.carryover;

  // ── 解析既有筆記中的 Errors 區段（保留歷史） ──
  const existingErrorsMatch = existing.match(/## Errors & Fixes\n([\s\S]*?)(?=\n## |\n# |$)/);
  const existingErrors = existingErrorsMatch ? existingErrorsMatch[1].trim() : '';

  // ── 組裝新 Errors 區段 ──
  const newErrors = (ctx.recentErrors ?? []).map(e => `- ${e.slice(0, 200)}`).join('\n');
  const errorsSection = [existingErrors, newErrors].filter(Boolean).join('\n');

  // ── Current State：結合目標 + 最近 worklog ──
  const pendingLine = c.taskGoal ? `**當前目標：** ${c.taskGoal}` : '';
  const worklogLines = c.recentWorkLog.slice(-8).map(w => `- ${w}`).join('\n');
  const currentStateLines = [pendingLine, worklogLines ? `\n**最近執行：**\n${worklogLines}` : ''].filter(Boolean).join('\n');

  // ── Key Files ──
  const keyFilesLines = [
    ...c.activeArtifacts.slice(-8).map(f => `- ${f}`),
  ].join('\n');

  // ── Verified Work ──
  const verifiedLines = c.verifiedWork.slice(-10).map(w => `- ${w}`).join('\n');

  const notes = [
    `# Session Notes`,
    `_更新時間：${now}（累計工具呼叫 ${ctx.toolCallCount} 次）_`,
    ``,
    `## Task`,
    ctx.taskDescription ? ctx.taskDescription.slice(0, 400) : '_（未記錄）_',
    ``,
    `## Current State`,
    currentStateLines || '_（尚無記錄）_',
    ``,
    `## Key Files`,
    keyFilesLines || '_（尚無記錄）_',
    ``,
    `## Verified Work`,
    verifiedLines || '_（尚無記錄）_',
    ``,
    `## Errors & Fixes`,
    errorsSection || '_（無）_',
  ].join('\n');

  return notes;
}

// ─────────────────────────────────────────────
// 計數觸發邏輯
// ─────────────────────────────────────────────

/** 每隔幾次工具呼叫自動更新一次筆記（預設 5） */
export const DEFAULT_UPDATE_INTERVAL = 5;

/**
 * 判斷是否應執行本次更新（每 interval 次一次，或強制）。
 */
export function shouldUpdateNotes(toolCallCount: number, interval = DEFAULT_UPDATE_INTERVAL, force = false): boolean {
  if (force) return true;
  return toolCallCount > 0 && toolCallCount % interval === 0;
}
