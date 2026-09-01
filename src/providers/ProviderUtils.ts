// Copyright (c) 2026 YCHsu. All rights reserved.
// Licensed under the MIT License.
// Shared provider utilities: token estimation, sensitive-info filtering, model-ID codec,
// context-length cache, and memory parsing helpers.

import * as vscode from 'vscode';

// ── Sensitive info redaction ──────────────────────────────────────────────────

export function filterSensitiveInfo(text: string): string {
  return text
    .replace(/eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{5,}\.[a-zA-Z0-9_-]{5,}/g, '[JWT_REDACTED]')
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, '[AWS_KEY_REDACTED]')
    .replace(/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g, '[PRIVATE_KEY_REDACTED]')
    .replace(/(Authorization:\s*Bearer\s+)[A-Za-z0-9_\-.+/]{20,}/gi, '$1[REDACTED]')
    .replace(/\bgh[pousr]_[a-zA-Z0-9]{36,}\b/g, '[GH_TOKEN_REDACTED]')
    .replace(/\bsk-[a-zA-Z0-9]{20,}\b/g, '[API_KEY_REDACTED]')
    .replace(/(["\'']?(?:api_?key|secret|password|passwd|token|access_?key|auth_?key|private_?key)["\'']?\s*[:=]\s*["\'']?)[A-Za-z0-9_\-.+/]{16,}(["\'']?)/gi, '$1[REDACTED]$2');
}

// ── Token estimation ──────────────────────────────────────────────────────────

export function estimateTokens(text: string): number {
  let count = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    count += code > 0x2E7F ? 1 : 0.25;
  }
  return Math.ceil(count);
}

// ── Model context-length cache (TTL 5 min) ────────────────────────────────────

const _modelCtxCache = new Map<string, { len: number; ts: number }>();
const MODEL_CTX_TTL = 5 * 60 * 1000;

export function clearModelCtxCache(): void { _modelCtxCache.clear(); }
export function getModelCtxCache(): typeof _modelCtxCache { return _modelCtxCache; }
export { MODEL_CTX_TTL };

// ── Ollama URL config helper ──────────────────────────────────────────────────

export function getOllamaUrls(cfg: vscode.WorkspaceConfiguration): string[] {
  const arr = (cfg.get<string[]>('urls') ?? []).filter((u: string) => u.trim());
  if (arr.length > 0) {
    const count = new Map<string, number>();
    for (const u of arr) count.set(u, (count.get(u) ?? 0) + 1);
    const enabled = arr.filter(u => count.get(u) === 1);
    return enabled.length > 0 ? enabled : [];
  }
  return [cfg.get<string>('url') ?? 'http://localhost:11434'];
}

// ── Model ID codec (multi-server: "http://host||modelname") ──────────────────

export function decodeOllamaModel(modelId: string, fallbackUrls: string[]): { url: string; model: string } {
  if (modelId.startsWith('openai::')) {
    const inner = modelId.slice('openai::'.length);
    const sep = inner.indexOf('||');
    if (sep !== -1) return { url: inner.slice(0, sep), model: 'openai::' + inner.slice(sep + 2) };
    return { url: fallbackUrls[0] ?? 'http://localhost:11434', model: 'openai::' + inner };
  }
  const sep = modelId.indexOf('||');
  if (sep !== -1) return { url: modelId.slice(0, sep), model: modelId.slice(sep + 2) };
  return { url: fallbackUrls[0] ?? 'http://localhost:11434', model: modelId };
}

export function encodeOllamaModelId(url: string, model: string, allUrls: string[]): string {
  if (model.startsWith('openai::')) { return model; }
  return allUrls.length > 1 ? `${url}||${model}` : model;
}

export function ollamaDisplayLabel(url: string, model: string, allUrls: string[]): string {
  if (model.startsWith('openai::')) {
    const inner = model.slice('openai::'.length);
    const sep = inner.indexOf('||');
    const sourceUrl = sep !== -1 ? inner.slice(0, sep) : url;
    const modelName = sep !== -1 ? inner.slice(sep + 2) : inner;
    if (allUrls.length <= 1 && sep === -1) { return modelName; }
    try {
      const u = new URL(sourceUrl);
      return `[${u.hostname}:${u.port || (u.protocol === 'https:' ? '443' : '80')}] ${modelName}`;
    } catch { return modelName; }
  }
  if (allUrls.length <= 1) return model;
  try { const u = new URL(url); return `[${u.hostname}:${u.port || '11434'}] ${model}`; } catch { return model; }
}

// ── Memory item extraction parser ─────────────────────────────────────────────

export function parseExtractMemoriesJson(raw: string): import('../services/extractMemories/extractMemories').ExtractedMemoryItem[] {
  if (!raw) return [];
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  let candidate = fence ? fence[1] : raw;
  const arrayStart = candidate.indexOf('[');
  const arrayEnd = candidate.lastIndexOf(']');
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    candidate = candidate.slice(arrayStart, arrayEnd + 1);
  }
  try {
    const parsed: unknown = JSON.parse(candidate);
    if (!Array.isArray(parsed)) return [];
    const valid: import('../services/extractMemories/extractMemories').ExtractedMemoryItem[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const o = item as Record<string, unknown>;
      const type = String(o.type ?? '');
      if (type !== 'fact' && type !== 'preference' && type !== 'pattern' && type !== 'context') continue;
      const title = String(o.title ?? '').trim();
      const body = String(o.body ?? '').trim();
      const slug = String(o.slug ?? '').trim();
      const oneLineHook = String(o.oneLineHook ?? title).trim();
      if (!title || !body) continue;
      const tags = Array.isArray(o.tags) ? o.tags.map(t => String(t)).slice(0, 10) : undefined;
      valid.push({ type, title, slug, body, oneLineHook, tags });
    }
    return valid;
  } catch { return []; }
}

// ── Misc ──────────────────────────────────────────────────────────────────────

export function getNonce(): string { return Math.random().toString(36).substring(2, 15); }
