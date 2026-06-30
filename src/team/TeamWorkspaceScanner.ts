/**
 * TeamWorkspaceScanner — Team 模式的工作區掃描 + 批次化 + 對話歷史建構。
 *
 * 抽出動機（見 ClaudeToDo.md §19.5 異味 3）：
 *   `_handleTeamDiscussion` 與 `_handleTeamManager` 各有一份 **逐字重複 ~60 行** 的
 *   「掃描工作區 → 讀 teamscontext.md → 過濾 → 80KB 批次 → 組裝多輪 init history」邏輯，
 *   僅變數前綴（_disc / _mgr）與結尾用語（請提出問題／任務）不同。
 *
 * 為何不復用 context/WorkspaceDigest.ts：
 *   WorkspaceDigest 產出的是「單一 markdown digest」供 system prompt 注入，
 *   且其 full 模式只回傳「請呼叫 read_workspace」指令、不真的倒程式碼；
 *   本掃描器則需要把 **整個 codebase 分批塞進多輪對話歷史**（TeamHistoryEntry[]），
 *   兩者輸出形狀與 glob/skip 集合都不同，強行共用會改變既有行為。
 *
 * 本模組為純函式（僅依賴 vscode / path），不持有任何 panel/this 狀態；
 * UI 進度訊息（teamSynthChunk vs teamOrchestrator*）刻意留在各 mode 由呼叫端發送。
 */
import * as path from 'path';
import * as vscode from 'vscode';
import { TeamHistoryEntry } from './TeamShared';

/** 即使路徑匹配也跳過的二進位 / 非原始碼副檔名。 */
const SKIP_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.woff', '.woff2', '.ttf', '.eot',
  '.vsix', '.zip', '.tar', '.gz', '.exe', '.dll', '.pdf', '.db', '.sqlite', '.lock',
]);

/** findFiles 排除的目錄 glob。 */
const SKIP_DIRS = '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**,**/build/**,**/.vscode-test/**,**/coverage/**}';

/** findFiles 上限。 */
const FIND_LIMIT = 2000;

/** 單一批次的 byte 上限（超過則切下一批）。 */
const BATCH_SIZE = 80000;

/** 單一檔案納入的字元上限（超過則截斷）。 */
const MAX_FILE = 15000;

/** 工作區掃描結果。 */
export interface TeamWorkspaceScan {
  /** 工作區根目錄（第一個 folder，或 process.cwd()）。 */
  wsRoot: string;
  /** teamscontext.md 的絕對路徑。 */
  teamsCtxPath: string;
  /** teamscontext.md 現有內容（trim 後；不存在則為空字串）。 */
  teamsCtxContent: string;
  /** 過濾後的相對路徑清單（POSIX 斜線）。 */
  allRelPaths: string[];
  /** 80KB 批次後的原始碼區塊（每批是多個 `### rel\n```...```` 字串）。 */
  batches: string[][];
  /** 實際納入的原始碼總字元數。 */
  totalBytes: number;
  /** 實際讀入的檔案數（= 所有批次的檔案數總和）。 */
  readCount: number;
  /** 共用基礎 context（工作區路徑 + teamscontext + 檔案清單）。 */
  baseCtx: string;
}

/**
 * 掃描工作區：讀 teamscontext.md、列出所有原始碼檔案、逐檔讀入並切成 80KB 批次。
 * 純資料產出，不發送任何 UI 訊息（由呼叫端依模式自行發送進度）。
 */
export async function scanWorkspaceForTeam(): Promise<TeamWorkspaceScan> {
  const wsFolders = vscode.workspace.workspaceFolders ?? [];
  const wsRoot = wsFolders.length > 0 ? wsFolders[0].uri.fsPath : process.cwd();

  const teamsCtxPath = path.join(wsRoot, 'teamscontext.md');
  let teamsCtxContent = '';
  try {
    const tcBytes = await vscode.workspace.fs.readFile(vscode.Uri.file(teamsCtxPath));
    teamsCtxContent = Buffer.from(tcBytes).toString('utf-8').trim();
  } catch { /* 不存在則略過 */ }

  const allUris = await vscode.workspace.findFiles('**/*', SKIP_DIRS, FIND_LIMIT);
  allUris.sort((a, b) => a.fsPath.localeCompare(b.fsPath));
  const filteredUris = allUris.filter(uri => !SKIP_EXT.has(path.extname(uri.fsPath).toLowerCase()));
  const allRelPaths = filteredUris.map(uri => path.relative(wsRoot, uri.fsPath).replace(/\\/g, '/'));
  const fileListBlock = `【工作區檔案清單（${allRelPaths.length} 個）】\n${allRelPaths.map(p => `  - ${p}`).join('\n')}`;

  const batches: string[][] = [];
  let curBatch: string[] = [];
  let curBatchBytes = 0;
  let totalBytes = 0;
  for (const uri of filteredUris) {
    const rel = path.relative(wsRoot, uri.fsPath).replace(/\\/g, '/');
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      let text = Buffer.from(bytes).toString('utf-8');
      if (text.length > MAX_FILE) { text = text.slice(0, MAX_FILE) + `\n...（${rel} 已截斷，僅顯示前段）`; }
      const entry = `### ${rel}\n\`\`\`\n${text}\n\`\`\``;
      if (curBatchBytes + entry.length > BATCH_SIZE && curBatch.length > 0) {
        batches.push(curBatch);
        curBatch = []; curBatchBytes = 0;
      }
      curBatch.push(entry);
      curBatchBytes += entry.length;
      totalBytes += text.length;
    } catch { /* 略過無法讀取的二進位檔 */ }
  }
  if (curBatch.length > 0) batches.push(curBatch);
  const readCount = batches.reduce((s, b) => s + b.length, 0);

  const baseCtx = [
    `【工作區路徑】${wsRoot}`,
    teamsCtxContent ? `【teamscontext.md — 先前討論紀錄】\n${teamsCtxContent}` : '',
    fileListBlock,
  ].filter(Boolean).join('\n\n');

  return { wsRoot, teamsCtxPath, teamsCtxContent, allRelPaths, batches, totalBytes, readCount, baseCtx };
}

/**
 * 把掃描結果組裝成「逐批餵碼」的多輪對話歷史。
 *   - 有批次：user(baseCtx+第1批) → assistant(已讀第N批) → user(第N+1批) → … → assistant(已讀完。{finalPrompt})
 *   - 無批次且提供 emptyFallbackAssistant：user(baseCtx) → assistant(emptyFallbackAssistant)
 *   - 無批次且未提供 fallback：回傳空陣列（manager 模式行為）
 *
 * @param finalPrompt 讀完後 assistant 收尾語（discussion="請提出問題。" / manager="請提出任務。"）
 * @param emptyFallbackAssistant 無批次時的 assistant 回覆（僅 discussion 提供）
 */
export function buildBatchedInitHistory(
  scan: TeamWorkspaceScan,
  finalPrompt: string,
  emptyFallbackAssistant?: string
): TeamHistoryEntry[] {
  const { baseCtx, batches, allRelPaths, totalBytes } = scan;
  const hist: TeamHistoryEntry[] = [];
  if (batches.length > 0) {
    hist.push({ role: 'user', content:
      `${baseCtx}\n\n【第 1/${batches.length} 批原始碼（${batches[0].length} 個檔案）】\n\n${batches[0].join('\n\n')}`
    });
    for (let bi = 1; bi < batches.length; bi++) {
      hist.push({ role: 'assistant', content: `已閱讀第 ${bi}/${batches.length} 批（${batches[bi - 1].length} 個檔案），繼續接收下一批。` });
      hist.push({ role: 'user', content:
        `【第 ${bi + 1}/${batches.length} 批原始碼（${batches[bi].length} 個檔案）】\n\n${batches[bi].join('\n\n')}`
      });
    }
    hist.push({ role: 'assistant', content: `已完整閱讀全部 ${batches.length} 批共 ${allRelPaths.length} 個檔案（${Math.round(totalBytes / 1024)}KB）。${finalPrompt}` });
  } else if (emptyFallbackAssistant !== undefined) {
    hist.push({ role: 'user', content: baseCtx });
    hist.push({ role: 'assistant', content: emptyFallbackAssistant });
  }
  return hist;
}

/**
 * 把掃描結果攤平成單一字串（供 Copilot 無多輪歷史的路徑使用）。
 */
export function buildCopilotBatchCtx(scan: TeamWorkspaceScan): string {
  const { baseCtx, batches } = scan;
  return [baseCtx, ...batches.map((b, i) => `【第 ${i + 1}/${batches.length} 批原始碼】\n\n${b.join('\n\n')}`)].join('\n\n');
}
