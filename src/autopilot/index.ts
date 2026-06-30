// Copyright (c) 2026 YCHsu. All rights reserved.
// Licensed under the MIT License.

/**
 * AutoPilot 模組 barrel。
 *
 * 來源：移植自 claude-code 的 auto-mode 子系統（`src/services/autoMode/` 與
 * `src/utils/permissions/yolo-classifier-prompts/`），改名為 AutoPilot 以避免與
 * AmiClaw 既有 `AgentExecutor._autoRunning`（多輪 auto-continue）相撞。
 *
 * v1 狀態：純移植，**尚未** wire-in。沒有任何現有檔案 import 這個模組，所以
 * 移植本身不會改變既有行為。後續整合步驟：
 *
 *   1. 在 extension activation 讀取設定 `amiAiClaw.autoPilot.enabled`，
 *      呼叫 `setAutoPilotEnabledBySetting(true)` + `setAutoPilotActive(true)`。
 *   2. 在 `ToolPolicies.requestPermission()` 一進函式時呼叫
 *      `decideAutoPilotAction(...)`，依 `kind` 分流：
 *        - pass-through → 走原本 `new Promise` 確認 UI
 *        - allow        → 直接 `resolve(true)`，並把 reason 寫到 audit log
 *        - deny         → 直接 `resolve(false)`
 *        - fallback-ask → 走原本確認 UI（並可加 hint 「AutoPilot 已連續拒絕，請手動確認」）
 *   3. 注入 `AutoPilotClassifierServices.callModel` 適配器，串接 ollamaGenerate
 *      或 Copilot API。建議把 system + user 串成單一 prompt 餵給小模型
 *      （例如 qwen2.5-coder:7b 或 gemma3:4b）。
 *   4. WebView UI 加入 toggle 與 denial log 檢視（可從 `getAutoPilotDenials()` 取）。
 */

export {
  isAutoPilotActive, setAutoPilotActive,
  isAutoPilotCircuitBroken, setAutoPilotCircuitBroken,
  isAutoPilotEnabledBySetting, setAutoPilotEnabledBySetting,
  _resetAutoPilotStateForTesting,
} from './AutoPilotState';

export {
  AUTOPILOT_SAFE_TOOLS, isSafeAutoPilotTool,
} from './safeAllowlist';

export {
  AUTOPILOT_DENIAL_LIMITS,
  recordAutoPilotDenial, recordAutoPilotSuccess,
  getAutoPilotDenials, getAutoPilotConsecutiveDenials, getAutoPilotTotalDenials,
  shouldAutoPilotFallbackToAsk, shouldSuggestAutoPilotRulesReview,
  _resetAutoPilotDenialsForTesting,
  type AutoPilotDenial,
} from './AutoPilotDenials';

export {
  buildAutoPilotSystemPrompt, formatActionForClassifier, AUTOPILOT_OUTPUT_RULES,
  type AutoPilotPromptRules,
} from './AutoPilotPrompt';

export {
  classifyAutoPilotAction,
  type AutoPilotClassifierServices,
  type AutoPilotCallModelOptions,
  type AutoPilotCallModelResult,
  type AutoPilotClassifierResult,
  type AutoPilotClassifierVerdict,
  type AutoPilotClassifyArgs,
  type AutoPilotTranscriptMessage,
} from './AutoPilotClassifier';

export {
  decideAutoPilotAction,
  type AutoPilotDecideArgs,
  type AutoPilotDecision,
} from './AutoPilotPolicy';
