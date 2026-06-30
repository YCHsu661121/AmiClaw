// Copyright (c) 2026 YCHsu. All rights reserved.
// Licensed under the MIT License.

/**
 * AutoPilot 全域狀態：模組層級的小型狀態機，對應 claude-code `autoModeState.ts`。
 * - active：classifier 是否正在攔截 tool call
 * - circuitBroken：遠端 kill-switch 觸發（例如分類器連續無法回應）後關閉
 * - flagSetting：使用者在 settings.json 開啟 amiAiClaw.autoPilot.enabled
 *
 * 沒有 IO；persistence 由呼叫方（extension 啟動程式）決定要不要把它 mirror 到 globalState。
 */

let _active = false;
let _circuitBroken = false;
let _flagSetting = false;

export function isAutoPilotActive(): boolean {
  return _active && !_circuitBroken;
}

export function setAutoPilotActive(active: boolean): void {
  _active = active;
}

export function isAutoPilotCircuitBroken(): boolean {
  return _circuitBroken;
}

export function setAutoPilotCircuitBroken(broken: boolean): void {
  _circuitBroken = broken;
}

export function isAutoPilotEnabledBySetting(): boolean {
  return _flagSetting;
}

export function setAutoPilotEnabledBySetting(enabled: boolean): void {
  _flagSetting = enabled;
}

/** 測試用：清空所有 module-level 狀態。 */
export function _resetAutoPilotStateForTesting(): void {
  _active = false;
  _circuitBroken = false;
  _flagSetting = false;
}
