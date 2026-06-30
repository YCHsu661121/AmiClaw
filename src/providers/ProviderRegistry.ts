// Copyright (c) 2026 YCHsu. All rights reserved.
// Licensed under the MIT License.

/**
 * 集中管理模型 ID 字首與 provider 對應。讓 QueryEngine / AgentExecutor 不再
 * 散落 `modelId.startsWith('copilot::')` 之類的判斷。
 *
 * Provider ID 字首：
 *   - `copilot::<copilotModelId>` — VS Code GitHub Copilot Language Model
 *   - `copilot/<copilotModelId>`  — 舊版字首（從 setting 載入時自動正規化為 copilot::）
 *   - `openai::<openaiModelName>` — OpenAI 相容端點（base url + key 由 setting 提供）
 *   - 其他不帶字首                  — Ollama（base url 由 url setting 提供）
 */

export type ProviderKind = 'ollama' | 'openai' | 'copilot';

export interface ProviderInfo {
  id: ProviderKind;
  label: string;
}

const COPILOT_PREFIX = 'copilot::';
const COPILOT_LEGACY_PREFIX = 'copilot/';
const OPENAI_PREFIX = 'openai::';

const KIND_LABEL: Record<ProviderKind, string> = {
  copilot: 'Copilot',
  openai: 'OpenAI Compatible',
  ollama: 'Ollama',
};

/** 把舊版 `copilot/xxx` 正規化為 `copilot::xxx`。 */
export function normalizeProviderModelId(modelId: string): string {
  return modelId.startsWith(COPILOT_LEGACY_PREFIX)
    ? COPILOT_PREFIX + modelId.slice(COPILOT_LEGACY_PREFIX.length)
    : modelId;
}

export function getProviderKind(modelId: string): ProviderKind {
  if (modelId.startsWith(COPILOT_PREFIX) || modelId.startsWith(COPILOT_LEGACY_PREFIX)) { return 'copilot'; }
  if (modelId.startsWith(OPENAI_PREFIX)) { return 'openai'; }
  return 'ollama';
}

export function getProviderLabel(kind: ProviderKind): string {
  return KIND_LABEL[kind];
}

export function getProviderInfo(modelId: string): ProviderInfo {
  const kind = getProviderKind(modelId);
  return { id: kind, label: getProviderLabel(kind) };
}

/** 將模型 ID 加上 provider 字首。Ollama 不需要字首，原樣回傳。 */
export function addProviderPrefix(kind: ProviderKind, modelName: string): string {
  if (kind === 'copilot') { return COPILOT_PREFIX + modelName; }
  if (kind === 'openai') { return OPENAI_PREFIX + modelName; }
  return modelName;
}

/** 去除 provider 字首，回傳純模型名（用於顯示或傳給 SDK）。 */
export function stripProviderPrefix(modelId: string): string {
  if (modelId.startsWith(COPILOT_PREFIX)) { return modelId.slice(COPILOT_PREFIX.length); }
  if (modelId.startsWith(COPILOT_LEGACY_PREFIX)) { return modelId.slice(COPILOT_LEGACY_PREFIX.length); }
  if (modelId.startsWith(OPENAI_PREFIX)) { return modelId.slice(OPENAI_PREFIX.length); }
  return modelId;
}

export function isCopilotModel(modelId: string): boolean {
  return getProviderKind(modelId) === 'copilot';
}

export function isOpenAIModel(modelId: string): boolean {
  return getProviderKind(modelId) === 'openai';
}

export function isOllamaModel(modelId: string): boolean {
  return getProviderKind(modelId) === 'ollama';
}
