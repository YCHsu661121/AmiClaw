/**
 * TokenBudgetManager
 *
 * 移植自 claude-code `services/compact/autoCompact.ts` 的 token 預算機制。
 * 用於決定何時觸發 micro / auto compaction、何時警告使用者。
 *
 * 移植來源關鍵常數：
 *   AUTOCOMPACT_BUFFER_TOKENS         = 13_000  ← 距離 context window 還剩這麼多就壓縮
 *   WARNING_THRESHOLD_BUFFER_TOKENS   = 20_000
 *   MAX_OUTPUT_TOKENS_FOR_SUMMARY     = 20_000  ← 預留給 summarize 輸出
 *   MAX_CONSECUTIVE_AUTOCOMPACT_FAILS = 3
 */

export const AUTOCOMPACT_BUFFER_TOKENS = 13_000;
export const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000;
export const ERROR_THRESHOLD_BUFFER_TOKENS = 20_000;
export const MANUAL_COMPACT_BUFFER_TOKENS = 3_000;
export const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000;
export const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3;

export interface TokenBudget {
  /** Provider 回報的 context window 上限（token 數） */
  contextWindow: number;
  /** 保留給輸出的 token 數 */
  maxOutputTokens: number;
}

export interface TokenWarningState {
  /** 剩餘 token 百分比 (0~100) */
  percentLeft: number;
  /** 已使用 token */
  used: number;
  /** 有效 context window（扣除輸出保留） */
  effectiveWindow: number;
  isAboveWarningThreshold: boolean;
  isAboveErrorThreshold: boolean;
  isAboveAutoCompactThreshold: boolean;
}

/**
 * 計算扣除輸出保留後的有效 context window。
 */
export function getEffectiveContextWindowSize(budget: TokenBudget): number {
  const reservedForOutput = Math.min(budget.maxOutputTokens, MAX_OUTPUT_TOKENS_FOR_SUMMARY);
  return Math.max(0, budget.contextWindow - reservedForOutput);
}

/**
 * 自動壓縮觸發點：有效視窗 − 13K buffer。
 */
export function getAutoCompactThreshold(budget: TokenBudget): number {
  return Math.max(0, getEffectiveContextWindowSize(budget) - AUTOCOMPACT_BUFFER_TOKENS);
}

/**
 * 警告閾值：有效視窗 − 20K buffer。
 */
export function getWarningThreshold(budget: TokenBudget): number {
  return Math.max(0, getEffectiveContextWindowSize(budget) - WARNING_THRESHOLD_BUFFER_TOKENS);
}

/**
 * 依目前 token 使用量計算警告狀態。
 */
export function calculateTokenWarningState(
  tokenUsage: number,
  budget: TokenBudget
): TokenWarningState {
  const effectiveWindow = getEffectiveContextWindowSize(budget);
  const autoCompactThreshold = getAutoCompactThreshold(budget);
  const warningThreshold = getWarningThreshold(budget);

  const percentLeft = effectiveWindow > 0
    ? Math.max(0, Math.min(100, ((effectiveWindow - tokenUsage) / effectiveWindow) * 100))
    : 0;

  return {
    percentLeft,
    used: tokenUsage,
    effectiveWindow,
    isAboveWarningThreshold: tokenUsage >= warningThreshold,
    isAboveErrorThreshold: tokenUsage >= effectiveWindow - ERROR_THRESHOLD_BUFFER_TOKENS,
    isAboveAutoCompactThreshold: tokenUsage >= autoCompactThreshold,
  };
}

/**
 * Circuit breaker：連續失敗超過 3 次即停止自動壓縮。
 */
export function shouldStopAutoCompact(consecutiveFailures: number): boolean {
  return consecutiveFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES;
}

/**
 * 預估字串 token 數。粗略估算：英文約 4 char / token，中文約 1.5 char / token。
 * 若上層已有更精準的 estimator（如 tiktoken），可從外部注入並覆蓋。
 */
export function estimateTokensRough(text: string): number {
  if (!text) return 0;
  // 中文字元算 1 token，其他每 4 char 算 1 token
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) cjk++;
    else other++;
  }
  return Math.ceil(cjk + other / 4);
}

/**
 * 強制截斷字串以符合 Token 限制。
 * 為確保絕對安全，我們採取「最保守估算」：將字串截斷至 maxTokens 個字元。
 * 因為即使全為中文字，token 數也只會等於字元數，絕不會超過 maxTokens。
 */
export function truncateToTokenLimit(text: string, maxTokens: number): string {
  if (estimateTokensRough(text) <= maxTokens) return text;
  return text.substring(0, maxTokens);
}
