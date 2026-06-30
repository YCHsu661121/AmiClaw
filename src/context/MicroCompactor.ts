/**
 * MicroCompactor
 *
 * 移植自 claude-code `services/compact/microCompact.ts`。
 * 在每輪 agent loop 結束後，針對個別工具呼叫結果做剪裁，回收 token 但保留訊息結構。
 *
 * 策略：
 *   - 只壓縮屬於 COMPACTABLE_TOOLS 的工具結果（檔案/Bash/Grep/Web 等大型輸出）
 *   - 圖片結果若超過 2,000 token 直接清除
 *   - 舊工具結果（time-based）清為 `[Old tool result content cleared]`
 *   - 不動 user / assistant 一般訊息
 */

import { estimateTokensRough } from './TokenBudgetManager';

/** 預設可壓縮工具名單（與 AmiClaw 內建工具對齊；若名稱不同會無害略過） */
export const DEFAULT_COMPACTABLE_TOOLS: ReadonlySet<string> = new Set([
  'read_file',
  'file_read',
  'write_file',
  'file_write',
  'edit_file',
  'file_edit',
  'run_terminal',
  'bash',
  'grep',
  'glob',
  'list_dir',
  'web_search',
  'web_fetch',
  'fetch_webpage',
]);

export const IMAGE_MAX_TOKEN_SIZE = 2_000;
export const TIME_BASED_MC_CLEARED_MESSAGE = '[Old tool result content cleared]';
export const PER_RESULT_MAX_TOKENS = 4_000;
export const PER_RESULT_PREVIEW_TAIL_TOKENS = 200;

export interface CompactableToolMessage {
  role: 'tool' | 'assistant' | 'user' | 'system';
  content: string | null;
  tool_call_id?: string;
  /** 對應的工具名稱（若 role 是 'tool'） */
  toolName?: string;
  images?: string[];
}

export interface MicroCompactOptions {
  /** 可壓縮工具白名單 */
  compactableTools?: ReadonlySet<string>;
  /** 單一工具結果保留上限 (token) */
  perResultMaxTokens?: number;
  /** 舊結果視為「過時」的閾值（毫秒），預設 10 分鐘 */
  staleThresholdMs?: number;
  /** 訊息時間戳查詢（若無，所有訊息視為新鮮） */
  getMessageTimestamp?: (msg: CompactableToolMessage, index: number) => number | undefined;
}

export interface MicroCompactResult<T> {
  messages: T[];
  trimmedCount: number;
  tokensFreed: number;
}

/**
 * 對工具結果做剪裁：
 *  - 過大的結果保留前後 1,000 token + 中間以摘要替代
 *  - 過時的結果整段替換為 cleared message
 *  - 圖片過大則清除
 */
export function microCompact<T extends CompactableToolMessage>(
  messages: T[],
  options: MicroCompactOptions = {}
): MicroCompactResult<T> {
  const compactable = options.compactableTools ?? DEFAULT_COMPACTABLE_TOOLS;
  const perResultMax = options.perResultMaxTokens ?? PER_RESULT_MAX_TOKENS;
  const staleMs = options.staleThresholdMs ?? 10 * 60 * 1000;
  const now = Date.now();

  let trimmed = 0;
  let freed = 0;

  const out = messages.map((msg, idx) => {
    if (msg.role !== 'tool') return msg;
    if (!msg.toolName || !compactable.has(msg.toolName)) return msg;

    const ts = options.getMessageTimestamp?.(msg, idx);
    const isStale = ts !== undefined && now - ts > staleMs;

    // 過時：整段清除
    if (isStale && msg.content) {
      freed += estimateTokensRough(msg.content);
      trimmed++;
      return { ...msg, content: TIME_BASED_MC_CLEARED_MESSAGE };
    }

    // 圖片過大：清除
    let images = msg.images;
    if (images && images.length > 0) {
      const totalImgTokens = images.reduce((s, i) => s + estimateTokensRough(i), 0);
      if (totalImgTokens > IMAGE_MAX_TOKEN_SIZE) {
        freed += totalImgTokens;
        images = undefined;
        trimmed++;
      }
    }

    // 內容過大：保留頭尾 + 中間替換摘要
    if (msg.content) {
      const tokens = estimateTokensRough(msg.content);
      if (tokens > perResultMax) {
        const headChars = Math.floor((perResultMax - PER_RESULT_PREVIEW_TAIL_TOKENS) * 3);
        const tailChars = Math.floor(PER_RESULT_PREVIEW_TAIL_TOKENS * 3);
        const head = msg.content.slice(0, headChars);
        const tail = msg.content.slice(-tailChars);
        const collapsed = `${head}\n\n...[truncated ${tokens - perResultMax} tokens]...\n\n${tail}`;
        freed += tokens - estimateTokensRough(collapsed);
        trimmed++;
        return { ...msg, content: collapsed, images };
      }
    }

    if (images !== msg.images) return { ...msg, images };
    return msg;
  });

  return { messages: out, trimmedCount: trimmed, tokensFreed: freed };
}
