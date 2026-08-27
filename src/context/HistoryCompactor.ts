/**
 * HistoryCompactor
 *
 * 移植自 claude-code `services/compact/compact.ts` 與 `prompt.ts` 的整段對話 summarize 機制。
 *
 * 觸發時機：token 使用量超過 autoCompact 閾值（由 TokenBudgetManager 計算）。
 * 執行方式：
 *   1. 取 boundary 之後的所有訊息
 *   2. 用 9-section prompt 呼叫 LLM 產生 summary
 *   3. 插入一個「compact boundary」標記訊息
 *   4. boundary 之後保留 user 摘要 + 最近 N 輪原文
 *
 * LLM 呼叫透過注入 callable，與 provider 解耦。
 */

import { estimateTokensRough } from './TokenBudgetManager';

export interface CompactableMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  thinking?: string;
  tool_calls?: Array<{ id?: string; function: { name: string; arguments: Record<string, unknown> | string } }>;
  tool_call_id?: string;
  images?: string[];
  /** 內部標記：是否為 compact boundary 訊息 */
  __compactBoundary?: boolean;
}

export interface CompactCaller {
  /** 對 messages 做一次性 LLM 呼叫並回傳 summary 文字 */
  summarize: (messages: CompactableMessage[], systemPrompt: string) => Promise<string>;
}

export interface HistoryCompactOptions {
  /** 保留 boundary 之後最近 N 輪原文（一輪 = user + assistant pair） */
  keepRecentRounds?: number;
  /** Summary 之前的訊息全部移除；若為 false 則僅標記 boundary */
  dropPreBoundary?: boolean;

  /** 最小訊息數，少於此值時跳過壓縮直接回傳原陣列（預設 10） */
  minMessages?: number;
}

export interface CompactionResult<T extends CompactableMessage> {
  messages: T[];
  summary: string;
  tokensBefore: number;
  tokensAfter: number;
  boundaryIndex: number;
}

// ============================================================================
// Prompt：9-section detailed summary（移植自 claude-code prompt.ts）
// ============================================================================

const NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.

`;

const ANALYSIS_INSTRUCTION = `Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points. In your analysis process:

1. Chronologically analyze each message and section of the conversation. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like file names, code snippets, function signatures, file edits
   - Errors that you ran into and how you fixed them
   - Pay special attention to specific user feedback that you received
2. Double-check for technical accuracy and completeness.`;

export const COMPACT_SUMMARY_PROMPT = `${NO_TOOLS_PREAMBLE}Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.

${ANALYSIS_INSTRUCTION}

Your summary should include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail.
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Include full code snippets where applicable and why this file is important.
4. Errors and fixes: List all errors that you ran into, and how you fixed them. Pay special attention to specific user feedback.
5. User Decisions & Commitments (CRITICAL — must never be lost):
   - List EVERY explicit choice, decision, approval, or commitment the user made.
   - Look for phrases like: "我選 / 我決定 / 我採用 / 我同意 / 用 A / 方案二 / 就這 / 照這樣 / 可以 / OK / 好 / go / proceed / yes / I choose / I'll go with / let's use / 用這個 / 選 X / 用 Y".
   - **Quote each decision verbatim** (in the original language).
   - Include what option was picked (A / B / C / 方案一 / 方案二), and what was rejected if explicit.
   - If the user reversed a prior decision, record both the original and the revision in order.
   - These are the highest-priority facts. Losing one causes the assistant to contradict the user's explicit choice.
6. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
7. All user messages: List ALL user messages that are not tool results. These are critical for understanding the users' feedback and changing intent.
8. Pending Tasks: Outline any pending tasks that you have explicitly been asked to work on.
9. Current Work: Describe in detail precisely what was being worked on immediately before this summary request. Include file names and code snippets where applicable.
10. Optional Next Step: List the next step that you will take. Ensure that this step is DIRECTLY in line with the user's most recent explicit requests. Include direct quotes from the most recent conversation showing exactly what task you were working on.

Output format:

<analysis>
... your detailed chronological analysis here ...
</analysis>

<summary>
1. Primary Request and Intent:
   ...

2. Key Technical Concepts:
   ...

(... and so on through section 9)
</summary>
`;

// ============================================================================
// Boundary 訊息
// ============================================================================

export function createCompactBoundaryMessage(summary: string): CompactableMessage {
  return {
    role: 'system',
    content: `[Previous conversation compacted — context summary below]\n\n${summary}`,
    __compactBoundary: true,
  };
}

export function isCompactBoundaryMessage(msg: CompactableMessage): boolean {
  return msg.__compactBoundary === true;
}

export function getMessagesAfterCompactBoundary<T extends CompactableMessage>(messages: T[]): T[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isCompactBoundaryMessage(messages[i])) {
      return messages.slice(i + 1);
    }
  }
  return messages;
}

/**
 * 從 LLM 回傳的 <analysis>...<summary>...</summary> 文字中抽出 summary 部分。
 * 同時相容繁體中文版 <分析>...<摘要>...</摘要>（AmiClaw 既有 prompt 採用此格式）。
 * Analysis 是 scratchpad，不送回主對話。
 */
export function formatCompactSummary(rawText: string): string {
  const enMatch = rawText.match(/<summary>([\s\S]*?)<\/summary>/);
  if (enMatch) return enMatch[1].trim();
  const zhMatch = rawText.match(/<摘要>([\s\S]*?)<\/摘要>/);
  if (zhMatch) return zhMatch[1].trim();

  // Fallback：若模型未產出標籤，整段保留（去掉 analysis 段）
  const stripped = rawText
    .replace(/<analysis>[\s\S]*?<\/analysis>/g, '')
    .replace(/<分析>[\s\S]*?<\/分析>/g, '')
    .trim();
  return stripped || rawText.trim();
}

// ============================================================================
// 主流程
// ============================================================================

/**
 * 執行 history compaction：
 *   1. 取 boundary 之後的所有訊息
 *   2. 呼叫 LLM summarize
 *   3. 回傳新訊息陣列（含 boundary + 摘要 + 保留的最近 N 輪）
 */
export async function compactHistory<T extends CompactableMessage>(
  messages: T[],
  caller: CompactCaller,
  options: HistoryCompactOptions = {}
): Promise<CompactionResult<T>> {
  const keepRecent = options.keepRecentRounds ?? 4;
  const dropPre = options.dropPreBoundary ?? false;
  const minMsgs = options.minMessages ?? 10;

  const activeMessages = getMessagesAfterCompactBoundary(messages);

  // Guard: skip compaction when there are too few messages to summarize
  // (avoids wasting a full LLM call on short sessions).
  if (activeMessages.length < minMsgs) {
    const tokens = activeMessages.reduce((s, m) => s + estimateTokensRough(m.content ?? ''), 0);
    return {
      messages,
      summary: '',
      tokensBefore: tokens,
      tokensAfter: tokens,
      boundaryIndex: -1,
    };
  }

  const tokensBefore = activeMessages.reduce((s, m) => s + estimateTokensRough(m.content ?? ''), 0);

  // 呼叫 LLM 產生 summary
  const rawSummary = await caller.summarize(activeMessages as CompactableMessage[], COMPACT_SUMMARY_PROMPT);
  const summary = formatCompactSummary(rawSummary);

  // 保留最近 N 輪原文（user/assistant pair）
  const recentTail: T[] = [];
  let rounds = 0;
  for (let i = activeMessages.length - 1; i >= 0 && rounds < keepRecent; i--) {
    const m = activeMessages[i];
    recentTail.unshift(m);
    if (m.role === 'user') rounds++;
  }

  const boundary = createCompactBoundaryMessage(summary) as T;

  const pre = dropPre
    ? messages.filter(isCompactBoundaryMessage)
    : messages.slice(0, messages.length - activeMessages.length);

  const newMessages: T[] = [...pre, boundary, ...recentTail];
  const tokensAfter = newMessages.reduce((s, m) => s + estimateTokensRough(m.content ?? ''), 0);

  return {
    messages: newMessages,
    summary,
    tokensBefore,
    tokensAfter,
    boundaryIndex: pre.length,
  };
}
