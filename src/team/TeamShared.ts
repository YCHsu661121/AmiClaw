/**
 * TeamShared — TeamManager 各模式共用的純工具與常數。
 *
 * 抽出動機（見 ClaudeToDo.md §19.5 異味 4）：
 *   COLORS / isOllamaModel / getDisplay 原本在 6 個模式各自重定義，
 *   本檔集中為單一真相來源。注意：**並非所有變體都相同**，已保留語意差異：
 *     - 標準配色 vs 主管配色（主管 index 0 = 金色）
 *     - getWorkerDisplay 對應 discussion/agent/compare/clone/manager 的「Variant B」；
 *       default 模式（handleTeamSend 本體）另有處理 copilot/ 與 || 的 Variant A，故不在此抽出。
 */
import { URL } from 'url';

/** Team 各模式共用的精簡對話歷史條目（純 user/assistant 文字，不含 tool）。 */
export type TeamHistoryEntry = { role: 'user' | 'assistant'; content: string };

/** Team 模式的完整對話訊息（含 system/tool 角色與 tool_calls）。 */
export interface TeamManagerChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  thinking?: string;
  tool_calls?: Array<{ id?: string; function: { name: string; arguments: Record<string, unknown> | string } }>;
  tool_call_id?: string;
  images?: string[];
}

/** 標準成員配色（default / discussion / agent / compare 模式共用） */
export const TEAM_COLORS = ['#4fc1ff', '#89d185', '#ce9178', '#c586c0', '#dcdcaa', '#f7cc65'];

/** 主管模式配色（index 0 = 🏢 主管金色，其餘順延） */
export const TEAM_COLORS_MANAGER = ['#f7cc65', '#4fc1ff', '#89d185', '#ce9178', '#c586c0', '#dcdcaa'];

/** model id 是否為本機 Ollama（非 GitHub Copilot） */
export function isOllamaModel(m: string): boolean {
  return !m.startsWith('copilot/') && !m.startsWith('copilot::');
}

/** decodeOllamaModel 的型別（由 TeamManagerServices 注入） */
export type DecodeOllamaFn = (modelId: string, fallbackUrls: string[]) => { url: string; model: string };

/**
 * Worker 顯示名稱（discussion / agent / compare / clone / manager 模式共用，即 Variant B）。
 *   - `copilot::family` → `🐙 family`
 *   - 其餘 → decode 後顯示 `[host:port] model`，URL 解析失敗則退回 model
 *
 * ⚠️ default 模式（handleTeamSend 本體）使用 Variant A（額外處理 `copilot/` 前綴與 `||`，
 *    且非-`||` 的 Ollama 模型回傳原字串），語意不同，請勿用本函式取代。
 */
export function getWorkerDisplay(m: string, urls: string[], decode: DecodeOllamaFn): string {
  if (m.startsWith('copilot::')) return '🐙 ' + m.slice('copilot::'.length);
  const { url, model } = decode(m, urls);
  try {
    const u = new URL(url);
    return `[${u.hostname}:${u.port || '11434'}] ${model}`;
  } catch {
    return model;
  }
}
