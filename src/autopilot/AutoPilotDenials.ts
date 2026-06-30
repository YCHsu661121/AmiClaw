// Copyright (c) 2026 YCHsu. All rights reserved.
// Licensed under the MIT License.

/**
 * AutoPilot 拒絕追蹤：當 classifier 連續拒絕太多次（或一輪總拒絕太多次）
 * 就 fallback 到人工確認，避免 agent 陷入「auto-deny 死循環」。
 *
 * 對應 claude-code `autoModeDenials.ts` + `denialTracking.ts`。
 * 採用模組層級狀態（單一 chat session 共用），對齊 AutoPilotState.ts。
 */

export interface AutoPilotDenial {
  toolName: string;
  display: string;       // 人類可讀描述（例如 "rm -rf /data"）
  reason: string;        // classifier 給的拒絕原因
  timestamp: number;     // Date.now()
}

const RING_MAX = 20;
const _denials: AutoPilotDenial[] = [];

let _consecutiveDenials = 0;
let _totalDenials = 0;

export const AUTOPILOT_DENIAL_LIMITS = {
  /** 連續拒絕達到此數時，回退到人工確認模式（不再走 classifier）。 */
  CONSECUTIVE_THRESHOLD: 3,
  /** 整個 session 累積拒絕達到此數時，建議 UI 提示使用者檢視規則。 */
  TOTAL_THRESHOLD: 10,
} as const;

export function recordAutoPilotDenial(denial: AutoPilotDenial): void {
  _denials.push(denial);
  if (_denials.length > RING_MAX) { _denials.shift(); }
  _consecutiveDenials += 1;
  _totalDenials += 1;
}

/** 任何成功通過 classifier 或人工允許的 tool 執行後呼叫，重置連續拒絕計數。 */
export function recordAutoPilotSuccess(): void {
  _consecutiveDenials = 0;
}

export function getAutoPilotDenials(): ReadonlyArray<AutoPilotDenial> {
  return _denials;
}

export function getAutoPilotConsecutiveDenials(): number {
  return _consecutiveDenials;
}

export function getAutoPilotTotalDenials(): number {
  return _totalDenials;
}

/** 連續拒絕已達上限：呼叫端應退回人工確認流程，而不是繼續 auto-deny。 */
export function shouldAutoPilotFallbackToAsk(): boolean {
  return _consecutiveDenials >= AUTOPILOT_DENIAL_LIMITS.CONSECUTIVE_THRESHOLD;
}

/** 整個 session 拒絕次數已多，建議 UI 顯示「請檢視自動允許規則」提示。 */
export function shouldSuggestAutoPilotRulesReview(): boolean {
  return _totalDenials >= AUTOPILOT_DENIAL_LIMITS.TOTAL_THRESHOLD;
}

export function _resetAutoPilotDenialsForTesting(): void {
  _denials.length = 0;
  _consecutiveDenials = 0;
  _totalDenials = 0;
}
