/**
 * TeamContextStore — teamscontext.md 的時間戳記與附加寫入。
 *
 * 抽出動機（見 ClaudeToDo.md §19.5 異味 6）：
 *   discussion / agent / manager 三個 mode 各有一份「讀既有 → 加分隔線 → 寫」的持久化邏輯。
 *   三者 entry 格式與 UI 訊息不同（留各 mode），唯一可安全共用的是時間戳記 + 附加寫入。
 *
 * ⚠️ 既有行為差異已忠實保留：
 *   - discussion / manager 使用 **掃描時的記憶體快取**（傳入 existingContent，空字串=新檔不加分隔線）。
 *   - agent 於寫入當下 **重新讀檔**（省略 existingContent）：讀到就加分隔線（即使內容為空），讀不到則為空。
 */
import * as vscode from 'vscode';

/** teamscontext.md 紀錄時間戳記（`YYYY-MM-DD HH:MM:SS`）。 */
export function teamContextTimestamp(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * 把一筆 entry 附加到 teamscontext.md（既有內容 + 分隔線 + 新 entry）。
 *
 * @param ctxPath teamscontext.md 的絕對路徑
 * @param entryMarkdown 已組裝好的 entry（含標題與內文，格式由呼叫端負責）
 * @param existingContent 既有內容快取；傳入時：非空才加分隔線（discussion / manager）。
 *   省略（undefined）時改從磁碟重新讀取（agent）：讀到就加分隔線，讀不到（新檔）則為空。
 */
export async function appendTeamContext(
  ctxPath: string,
  entryMarkdown: string,
  existingContent?: string
): Promise<void> {
  let prefix: string;
  if (existingContent !== undefined) {
    prefix = existingContent ? `${existingContent}\n\n---\n\n` : '';
  } else {
    try {
      prefix = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(ctxPath))).toString('utf-8').trim() + '\n\n---\n\n';
    } catch {
      prefix = '';
    }
  }
  await vscode.workspace.fs.writeFile(vscode.Uri.file(ctxPath), Buffer.from(prefix + entryMarkdown, 'utf-8'));
}
