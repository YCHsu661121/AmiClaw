// Copyright (c) 2026 YCHsu. All rights reserved.
// Licensed under the MIT License.
// Ollama HTTP API client: context-length, model management, chat/generate streams.
// All functions are pure (no VS Code class dependencies) except ollamaGetContextLength
// which reads the openaiCompatApiKey setting.

import * as http from 'http';
import * as https from 'https';
import * as vscode from 'vscode';
import type { ChatMessage, ThinkingLevel } from '../types/chat-types';
import { getModelCtxCache, MODEL_CTX_TTL } from './ProviderUtils';

// ── Thinking level helpers ────────────────────────────────────────────────────

export function supportsThinking(model: string): boolean {
  const m = model.toLowerCase().replace(/^hf\.co\/[^/]+\//i, '').replace(/^.*\//, '');
  if (m.includes('coder') || m.includes('-instruct') || m.includes(':instruct')) { return false; }
  return m.startsWith('deepseek-r1') || m.startsWith('deepseek-r2') ||
    m.startsWith('qwq') ||
    (m.startsWith('qwen3') && !m.includes('coder')) ||
    m.includes(':thinking') || m.includes('-thinking') ||
    m.includes('think') || m.includes('-r1') || m.includes(':r1') ||
    m.includes('r1-') || /^r1[:.-]/.test(m);
}

export function getCurrentThinkingLevel(): ThinkingLevel {
  const v = vscode.workspace.getConfiguration('amiAiClaw').get<string>('thinkingLevel', 'medium');
  return (v === 'off' || v === 'low' || v === 'medium' || v === 'high' || v === 'max') ? v : 'medium';
}

export function getOllamaThinkParam(model: string): { think?: boolean | string } {
  const level = getCurrentThinkingLevel();
  if (level === 'off') { return { think: false }; }
  if (!supportsThinking(model)) { return {}; }
  if (level === 'low' || level === 'medium') { return { think: level }; }
  return { think: true };
}

// ── Connection error helper ───────────────────────────────────────────────────

export function ollamaConnectError(hostname: string, e: NodeJS.ErrnoException): Error {
  if (e.code === 'ENOTFOUND') return new Error(`主機名稱 '${hostname}' 無法解析（DNS），請確認 /etc/hosts 或 DNS 設定`);
  if (e.code === 'ECONNREFUSED') return new Error(`連線被拒絕（port 未開放），請確認 Ollama 伺服器已啟動：${hostname}:11434`);
  if (e.code === 'ETIMEDOUT' || e.message === 'ETIMEDOUT') return new Error(`連線逾時，請確認防火牆設定或主機 '${hostname}' 可達`);
  if (e.code === 'EHOSTUNREACH') return new Error(`無法到達主機 '${hostname}'，請確認網路路由設定`);
  return new Error((e.code ? e.code + ': ' : '') + e.message);
}

// ── Context length query ──────────────────────────────────────────────────────

export function ollamaGetContextLength(baseUrl: string, model: string): Promise<number> {
  const cacheKey = `${baseUrl}||${model}`;
  const cache = getModelCtxCache();
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < MODEL_CTX_TTL) { return Promise.resolve(cached.len); }

  const isOpenAiCompat = model.startsWith('openai::');
  const rawModel = isOpenAiCompat ? model.slice('openai::'.length) : model;

  if (isOpenAiCompat) {
    return new Promise<number>((resolve) => {
      try {
        const lmsUrl = new URL('/api/v0/models', baseUrl);
        const protocol = lmsUrl.protocol === 'https:' ? https : http;
        const _oaiKey = vscode.workspace.getConfiguration('amiAiClaw').get<string>('openaiCompatApiKey', '');
        const lmsReq = protocol.request({
          hostname: lmsUrl.hostname,
          port: lmsUrl.port ? parseInt(lmsUrl.port, 10) : (lmsUrl.protocol === 'https:' ? 443 : 80),
          path: lmsUrl.pathname, method: 'GET',
          headers: { 'Accept': 'application/json', ...(_oaiKey ? { 'Authorization': 'Bearer ' + _oaiKey } : {}) },
        }, (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => { data += chunk; });
          res.on('end', () => {
            if (res.statusCode === 200) {
              try {
                const json = JSON.parse(data);
                const models: Array<{ id?: string; max_context_length?: number }> = json.data ?? json;
                const entry = Array.isArray(models) ? models.find(m => m.id === rawModel) : null;
                const len = Number(entry?.max_context_length ?? 0);
                if (len > 0) { cache.set(cacheKey, { len, ts: Date.now() }); resolve(len); return; }
              } catch { /* fall through */ }
            }
            const encodedId = encodeURIComponent(rawModel);
            const url2 = new URL(`/v1/models/${encodedId}`, baseUrl);
            const req2 = protocol.request({
              hostname: url2.hostname,
              port: url2.port ? parseInt(url2.port, 10) : (url2.protocol === 'https:' ? 443 : 80),
              path: url2.pathname, method: 'GET',
              headers: { ...(_oaiKey ? { 'Authorization': 'Bearer ' + _oaiKey } : {}) },
            }, (res2) => {
              let d2 = '';
              res2.on('data', (c: Buffer) => { d2 += c; });
              res2.on('end', () => {
                try {
                  const j2 = JSON.parse(d2);
                  const len2 = Number(j2.max_model_len ?? 0);
                  if (len2 > 0) { cache.set(cacheKey, { len: len2, ts: Date.now() }); }
                  resolve(len2 > 0 ? len2 : 0);
                } catch { resolve(0); }
              });
            });
            req2.on('error', () => resolve(0));
            req2.setTimeout(3000, () => { req2.destroy(); resolve(0); });
            req2.end();
          });
        });
        lmsReq.on('error', () => resolve(0));
        lmsReq.setTimeout(5000, () => { lmsReq.destroy(); resolve(0); });
        lmsReq.end();
      } catch { resolve(0); }
    });
  }

  return new Promise<number>((resolve) => {
    try {
      const url = new URL('/api/show', baseUrl);
      const body = JSON.stringify({ name: rawModel });
      const protocol = url.protocol === 'https:' ? https : http;
      const req = protocol.request({
        hostname: url.hostname,
        port: url.port ? parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 11434),
        path: url.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            let len = 0;
            if (json.parameters) {
              const m = String(json.parameters).match(/num_ctx\s+(\d+)/);
              if (m) { len = Number(m[1]); }
            }
            if (!len) {
              const modelInfo: Record<string, unknown> = json.model_info ?? {};
              for (const k of Object.keys(modelInfo)) {
                if (k.endsWith('.context_length')) { len = Number(modelInfo[k]); break; }
              }
            }
            if (len > 0) { cache.set(cacheKey, { len, ts: Date.now() }); }
            resolve(len > 0 ? len : 0);
          } catch { resolve(0); }
        });
      });
      req.on('error', () => resolve(0));
      req.setTimeout(5000, () => { req.destroy(); resolve(0); });
      req.write(body); req.end();
    } catch { resolve(0); }
  });
}

// ── Model lifecycle ───────────────────────────────────────────────────────────

export function ollamaWarmupModel(baseUrl: string, model: string): void {
  try {
    const url = new URL('/api/generate', baseUrl);
    const body = JSON.stringify({ model, prompt: '', keep_alive: 600 });
    const protocol = url.protocol === 'https:' ? https : http;
    const req = protocol.request({
      hostname: url.hostname,
      port: url.port ? parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 11434),
      path: url.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => { res.resume(); });
    req.on('error', () => {});
    req.setTimeout(30000, () => { req.destroy(); });
    req.write(body); req.end();
  } catch { /* fire-and-forget */ }
}

export function ollamaUnloadModel(baseUrl: string, model: string): Promise<void> {
  return new Promise(resolve => {
    try {
      const url = new URL('/api/generate', baseUrl);
      const body = JSON.stringify({ model, prompt: '', keep_alive: 0 });
      const protocol = url.protocol === 'https:' ? https : http;
      const req = protocol.request({
        hostname: url.hostname,
        port: url.port ? parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 11434),
        path: url.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, res => { res.resume(); res.on('end', () => resolve()); res.on('error', () => resolve()); });
      req.on('error', () => resolve());
      req.setTimeout(30000, () => { req.destroy(); resolve(); });
      req.write(body); req.end();
    } catch { resolve(); }
  });
}

export function ollamaGetRunningModels(baseUrl: string): Promise<{ name: string; size_vram: number }[]> {
  return new Promise(resolve => {
    try {
      const url = new URL('/api/ps', baseUrl);
      const protocol = url.protocol === 'https:' ? https : http;
      const req = protocol.request({
        hostname: url.hostname,
        port: url.port ? parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 11434),
        path: url.pathname, method: 'GET',
      }, res => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            resolve(((json.models ?? []) as { name: string; size_vram?: number }[]).map(m => ({ name: m.name, size_vram: m.size_vram ?? 0 })));
          } catch { resolve([]); }
        });
        res.on('error', () => resolve([]));
      });
      req.on('error', () => resolve([]));
      req.setTimeout(5000, () => { req.destroy(); resolve([]); });
      req.end();
    } catch { resolve([]); }
  });
}

export function ollamaListRunningModels(baseUrl: string): Promise<string[]> {
  return new Promise(resolve => {
    try {
      const url = new URL('/api/ps', baseUrl);
      const protocol = url.protocol === 'https:' ? https : http;
      const req = protocol.request({
        hostname: url.hostname,
        port: url.port ? parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 11434),
        path: url.pathname, method: 'GET',
      }, res => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            resolve(((json.models ?? []) as { name: string }[]).map(m => m.name));
          } catch { resolve([]); }
        });
        res.on('error', () => resolve([]));
      });
      req.on('error', () => resolve([]));
      req.setTimeout(5000, () => { req.destroy(); resolve([]); });
      req.end();
    } catch { resolve([]); }
  });
}

// ── Chat (non-streaming) ──────────────────────────────────────────────────────

export function ollamaChatCall(baseUrl: string, model: string, messages: ChatMessage[], tools: unknown[]): Promise<ChatMessage> {
  return new Promise((resolve, reject) => {
    try {
      const url = new URL('/api/chat', baseUrl);
      const body = JSON.stringify({ model, messages, tools, stream: false, ...getOllamaThinkParam(model) });
      const protocol = url.protocol === 'https:' ? https : http;
      const req = protocol.request({
        hostname: url.hostname,
        port: url.port ? parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 11434),
        path: url.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode !== 200) { reject(new Error(`Ollama /api/chat 回傳 HTTP ${res.statusCode}: ${data.substring(0, 200)}`)); return; }
          try {
            const json = JSON.parse(data);
            const msg = json.message as ChatMessage & { thinking?: string };
            if (!msg.thinking && msg.content) {
              const m = (msg.content as string).match(/^<think>([\s\S]*?)<\/think>\s*/);
              if (m) { msg.thinking = m[1].trim(); msg.content = (msg.content as string).slice(m[0].length); }
            }
            resolve(msg);
          } catch { reject(new Error('無法解析 /api/chat 回應')); }
        });
      });
      req.on('error', (e: NodeJS.ErrnoException) => reject(ollamaConnectError(new URL(baseUrl).hostname, e)));
      req.setTimeout(600000, () => { req.destroy(new Error('Agent 呼叫逾時 (600s)')); });
      req.write(body); req.end();
    } catch (e) { reject(e); }
  });
}

// ── Chat streaming ────────────────────────────────────────────────────────────

export function ollamaChatCallStream(
  baseUrl: string, model: string, messages: ChatMessage[], tools: unknown[],
  onThinkChunk?: (chunk: string) => void,
  onTextChunk?: (chunk: string) => void,
  onStats?: (tokens: number, tps: number) => void
): Promise<ChatMessage> {
  return new Promise((resolve, reject) => {
    try {
      const url = new URL('/api/chat', baseUrl);
      const bodyObj: Record<string, unknown> = { model, messages, stream: true, ...(tools.length > 0 ? { tools } : {}), ...getOllamaThinkParam(model) };
      const body = JSON.stringify(bodyObj);
      const protocol = url.protocol === 'https:' ? https : http;
      let lineBuffer = '';
      let accContent = '';
      let accThinking = '';
      let finalToolCalls: unknown[] | undefined;
      let wasTruncated = false;
      const req = protocol.request({
        hostname: url.hostname,
        port: url.port ? parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 11434),
        path: url.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => {
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          let errBody = '';
          res.setEncoding('utf8');
          res.on('data', (d: string) => { errBody += d; });
          res.on('end', () => {
            try { const j = JSON.parse(errBody); reject(new Error('Ollama 錯誤：' + (j.error ?? 'HTTP ' + res.statusCode))); }
            catch { reject(new Error('Ollama HTTP ' + res.statusCode)); }
          });
          return;
        }
        res.setEncoding('utf8');
        let streamError: string | null = null;
        res.on('data', (data: string) => {
          lineBuffer += data;
          const lines = lineBuffer.split('\n');
          lineBuffer = lines.pop() ?? '';
          for (const line of lines) {
            const t = line.trim(); if (!t) continue;
            try {
              const json = JSON.parse(t) as Record<string, unknown>;
              if (json.error) { const e = json.error; streamError = typeof e === 'string' ? e : ((e as Record<string, unknown>).message as string | undefined) ?? JSON.stringify(e); return; }
              const msgFrag = json.message as (ChatMessage & { thinking?: string }) | undefined;
              if (msgFrag) {
                if (msgFrag.thinking) { accThinking += msgFrag.thinking; if (onThinkChunk) onThinkChunk(msgFrag.thinking); }
                if (msgFrag.content) { accContent += msgFrag.content; if (onTextChunk) onTextChunk(msgFrag.content); }
                if (msgFrag.tool_calls && Array.isArray(msgFrag.tool_calls) && msgFrag.tool_calls.length > 0) { finalToolCalls = msgFrag.tool_calls; }
              }
              if (json.done) {
                if ((json.done_reason as string | undefined) === 'length') wasTruncated = true;
                const ec = json.eval_count as number | undefined;
                const ed = json.eval_duration as number | undefined;
                if (onStats && ec && ed && ed > 0) onStats(ec, ec / (ed / 1e9));
              }
            } catch { /* partial */ }
          }
        });
        res.on('end', () => {
          if (streamError) { reject(new Error('Ollama 錯誤：' + streamError)); return; }
          if (finalToolCalls && finalToolCalls.length > 0) {
            resolve({ role: 'assistant', content: accContent || null, tool_calls: finalToolCalls as ChatMessage['tool_calls'] });
          } else {
            let content = accContent;
            if (!accThinking && content) {
              const m = content.match(/^<think>([\s\S]*?)<\/think>\s*/);
              if (m) { if (onThinkChunk) onThinkChunk(m[1].trim()); content = content.slice(m[0].length); }
            }
            resolve({ role: 'assistant', content: content || null, thinking: accThinking || undefined, truncated: wasTruncated || undefined });
          }
        });
      });
      req.on('error', (e: NodeJS.ErrnoException) => reject(ollamaConnectError(new URL(baseUrl).hostname, e)));
      req.setTimeout(600000, () => { req.destroy(new Error('Agent 呼叫逾時 (600s)')); });
      req.write(body); req.end();
    } catch (e) { reject(e); }
  });
}

// ── Generate (non-chat) ───────────────────────────────────────────────────────

export function ollamaGenerate(baseUrl: string, model: string, prompt: string): Promise<{ response: string; thinking?: string }> {
  return new Promise((resolve, reject) => {
    try {
      const url = new URL('/api/generate', baseUrl);
      const params: Record<string, unknown> = { model, prompt, stream: false };
      Object.assign(params, getOllamaThinkParam(model));
      const body = JSON.stringify(params);
      const protocol = url.protocol === 'https:' ? https : http;
      const req = protocol.request({
        hostname: url.hostname,
        port: url.port ? parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 11434),
        path: url.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode !== 200) { reject(new Error(`Ollama returned HTTP ${res.statusCode}: ${data.substring(0, 200)}`)); return; }
          try {
            const json = JSON.parse(data);
            let response: string = (json.response as string) ?? data;
            let thinking: string | undefined = json.thinking as string | undefined;
            if (!thinking) {
              const m = /^<think>([\s\S]*?)<\/think>\s*/i.exec(response);
              if (m) { thinking = m[1]; response = response.slice(m[0].length); }
            }
            resolve({ response, thinking });
          } catch { resolve({ response: data }); }
        });
      });
      req.on('error', (e) => reject(new Error(`無法連線到 Ollama (${baseUrl})：${(e as Error).message}`)));
      req.write(body); req.end();
    } catch (e) { reject(e); }
  });
}

const OLLAMA_RETRY_ERRORS = ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'socket hang up', '超時', 'timeout'];
export function isRetryableOllamaError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return OLLAMA_RETRY_ERRORS.some(s => msg.toLowerCase().includes(s.toLowerCase()));
}

// ── Generate stream (with retry) ─────────────────────────────────────────────

export async function ollamaGenerateStreamWithRetry(
  baseUrl: string, model: string, prompt: string,
  onResponseChunk: (chunk: string) => void,
  onThinkChunk?: (chunk: string) => void,
  onRetry?: (attempt: number, waitSec: number, err: string) => void,
  maxRetries = 10, retrySec = 60,
  onStats?: (tokens: number, tps: number) => void
): Promise<string> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try { return await ollamaGenerateStream(baseUrl, model, prompt, onResponseChunk, onThinkChunk, onStats); }
    catch (e) {
      if (attempt >= maxRetries || !isRetryableOllamaError(e)) throw e;
      const errMsg = e instanceof Error ? e.message : String(e);
      if (onRetry) onRetry(attempt + 1, retrySec, errMsg);
      await new Promise(r => setTimeout(r, retrySec * 1000));
    }
  }
  throw new Error('retry exhausted');
}

export function ollamaGenerateStream(
  baseUrl: string, model: string, prompt: string,
  onResponseChunk: (chunk: string) => void,
  onThinkChunk?: (chunk: string) => void,
  onStats?: (tokens: number, tps: number) => void,
  images?: string[]
): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      const url = new URL('/api/generate', baseUrl);
      const params: Record<string, unknown> = { model, prompt, stream: true };
      Object.assign(params, getOllamaThinkParam(model));
      if (images && images.length > 0) { params.images = images; }
      const body = JSON.stringify(params);
      const protocol = url.protocol === 'https:' ? https : http;
      let lineBuffer = '';
      let fullResponse = '';
      let inThink = false;
      const processToken = (token: string) => {
        let rem = token;
        while (rem.length > 0) {
          if (!inThink) {
            const ts = rem.indexOf('<think>');
            if (ts === -1) { fullResponse += rem; onResponseChunk(rem); break; }
            if (ts > 0) { const b = rem.slice(0, ts); fullResponse += b; onResponseChunk(b); }
            inThink = true; rem = rem.slice(ts + 7);
          } else {
            const te = rem.indexOf('</think>');
            if (te === -1) { if (onThinkChunk) onThinkChunk(rem); break; }
            const tc = rem.slice(0, te);
            if (onThinkChunk && tc) onThinkChunk(tc);
            inThink = false; rem = rem.slice(te + 8);
          }
        }
      };
      const req = protocol.request({
        hostname: url.hostname,
        port: url.port ? parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 11434),
        path: url.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => {
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          let errBody = '';
          res.setEncoding('utf8');
          res.on('data', (d: string) => { errBody += d; });
          res.on('end', () => {
            try { const j = JSON.parse(errBody); reject(new Error('Ollama 錯誤：' + (j.error ?? 'HTTP ' + res.statusCode))); }
            catch { reject(new Error('Ollama HTTP ' + res.statusCode)); }
          });
          return;
        }
        res.setEncoding('utf8');
        let streamError: string | null = null;
        res.on('data', (data: string) => {
          lineBuffer += data;
          const lines = lineBuffer.split('\n');
          lineBuffer = lines.pop() ?? '';
          for (const line of lines) {
            const t = line.trim(); if (!t) continue;
            try {
              const json = JSON.parse(t);
              if (json.error) { const e = json.error; streamError = typeof e === 'string' ? e : ((e as Record<string, unknown>).message as string | undefined) ?? JSON.stringify(e); return; }
              if (json.thinking && onThinkChunk) onThinkChunk(json.thinking as string);
              if (json.response) processToken(json.response as string);
              if (json.done && onStats && typeof json.eval_count === 'number' && typeof json.eval_duration === 'number' && json.eval_duration > 0) {
                onStats(json.eval_count as number, (json.eval_count as number) / ((json.eval_duration as number) / 1e9));
              }
            } catch { /* partial */ }
          }
        });
        res.on('end', () => { if (streamError) { reject(new Error('Ollama 錯誤：' + streamError)); return; } resolve(fullResponse); });
      });
      req.on('error', (e) => reject(new Error(`無法連線到 Ollama (${baseUrl})：${(e as Error).message}`)));
      req.write(body); req.end();
    } catch (e) { reject(e); }
  });
}

export function ollamaChatStream(
  baseUrl: string, model: string, messages: ChatMessage[],
  onResponseChunk: (chunk: string) => void,
  onThinkChunk?: (chunk: string) => void,
  onStats?: (tokens: number, tps: number) => void
): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      const url = new URL('/api/chat', baseUrl);
      const params: Record<string, unknown> = { model, messages, stream: true };
      Object.assign(params, getOllamaThinkParam(model));
      const body = JSON.stringify(params);
      const protocol = url.protocol === 'https:' ? https : http;
      let lineBuffer = '';
      let fullResponse = '';
      let inThink = false;
      const processToken = (token: string) => {
        let rem = token;
        while (rem.length > 0) {
          if (!inThink) {
            const ts = rem.indexOf('<think>');
            if (ts === -1) { fullResponse += rem; onResponseChunk(rem); break; }
            if (ts > 0) { const b = rem.slice(0, ts); fullResponse += b; onResponseChunk(b); }
            inThink = true; rem = rem.slice(ts + 7);
          } else {
            const te = rem.indexOf('</think>');
            if (te === -1) { if (onThinkChunk) onThinkChunk(rem); break; }
            const tc = rem.slice(0, te); if (onThinkChunk && tc) onThinkChunk(tc);
            inThink = false; rem = rem.slice(te + 8);
          }
        }
      };
      const req = protocol.request({
        hostname: url.hostname,
        port: url.port ? parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 11434),
        path: url.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => {
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          let errBody = '';
          res.setEncoding('utf8');
          res.on('data', (d: string) => { errBody += d; });
          res.on('end', () => {
            try { const j = JSON.parse(errBody); reject(new Error('Ollama 錯誤：' + (j.error ?? 'HTTP ' + res.statusCode))); }
            catch { reject(new Error('Ollama HTTP ' + res.statusCode)); }
          });
          return;
        }
        res.setEncoding('utf8');
        let streamError: string | null = null;
        res.on('data', (data: string) => {
          lineBuffer += data;
          const lines = lineBuffer.split('\n');
          lineBuffer = lines.pop() ?? '';
          for (const line of lines) {
            const t = line.trim(); if (!t) continue;
            try {
              const json = JSON.parse(t);
              if (json.error) { const e = json.error; streamError = typeof e === 'string' ? e : ((e as Record<string, unknown>).message as string | undefined) ?? JSON.stringify(e); return; }
              if (json.message?.thinking && onThinkChunk) onThinkChunk(json.message.thinking as string);
              if (json.message?.content) processToken(json.message.content as string);
              if (json.done && onStats && typeof json.eval_count === 'number' && typeof json.eval_duration === 'number' && json.eval_duration > 0) {
                onStats(json.eval_count as number, (json.eval_count as number) / ((json.eval_duration as number) / 1e9));
              }
            } catch { /* partial */ }
          }
        });
        res.on('end', () => { if (streamError) { reject(new Error('Ollama 錯誤：' + streamError)); return; } resolve(fullResponse); });
      });
      req.on('error', (e) => reject(new Error(`無法連線到 Ollama (${baseUrl})：${(e as Error).message}`)));
      req.write(body); req.end();
    } catch (e) { reject(e); }
  });
}

// ── Model management ──────────────────────────────────────────────────────────

export function ollamaListModels(baseUrl: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    try {
      const ollamaUrl = new URL('/api/tags', baseUrl);
      const openAiUrl = new URL('/v1/models', baseUrl);
      const loadOpenAiModels = () => {
        const p = openAiUrl.protocol === 'https:' ? https : http;
        const _lmKey = vscode.workspace.getConfiguration('amiAiClaw').get<string>('openaiCompatApiKey', '');
        const _lmHeaders: Record<string, string> = { 'Accept': 'application/json' };
        if (_lmKey) { _lmHeaders['Authorization'] = 'Bearer ' + _lmKey; }
        const req2 = p.request({
          hostname: openAiUrl.hostname,
          port: openAiUrl.port ? parseInt(openAiUrl.port, 10) : (openAiUrl.protocol === 'https:' ? 443 : 80),
          path: openAiUrl.pathname, method: 'GET', headers: _lmHeaders,
        }, (res2) => {
          let data2 = '';
          res2.on('data', (c: Buffer) => { data2 += c; });
          res2.on('end', () => {
            if (res2.statusCode !== 200) { reject(new Error('HTTP ' + res2.statusCode)); return; }
            try {
              const json = JSON.parse(data2);
              const EMBED_PAT = /embed|rerank|classifier|clip|stable-?diffusion/i;
              const ids: string[] = (json.data ?? []).map((m: { id?: string }) => m.id)
                .filter((id: unknown): id is string => typeof id === 'string' && id.trim().length > 0 && !EMBED_PAT.test(id))
                .map((id: string) => `openai::${baseUrl.replace(/\/$/, '')}||${id}`).sort();
              resolve(ids);
            } catch { reject(new Error('Invalid JSON from /v1/models')); }
          });
        });
        req2.on('error', (e: NodeJS.ErrnoException) => reject(ollamaConnectError(openAiUrl.hostname, e)));
        req2.setTimeout(8000, () => { req2.destroy(new Error('ETIMEDOUT')); });
        req2.end();
      };
      const protocol = ollamaUrl.protocol === 'https:' ? https : http;
      const req = protocol.request({
        hostname: ollamaUrl.hostname,
        port: ollamaUrl.port ? parseInt(ollamaUrl.port, 10) : (ollamaUrl.protocol === 'https:' ? 443 : 11434),
        path: ollamaUrl.pathname, method: 'GET',
      }, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const json = JSON.parse(data);
              resolve(((json.models ?? []) as { name: string }[]).map(m => m.name).sort());
            } catch { reject(new Error('Invalid JSON from /api/tags')); }
            return;
          }
          loadOpenAiModels();
        });
      });
      req.on('error', () => { loadOpenAiModels(); });
      req.setTimeout(8000, () => { req.destroy(new Error('ETIMEDOUT')); });
      req.end();
    } catch (e) { reject(e); }
  });
}

export function ollamaCheckConnection(baseUrl: string): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolve) => {
    try {
      const url = new URL('/api/tags', baseUrl);
      const openAiUrl = new URL('/v1/models', baseUrl);
      const protocol = url.protocol === 'https:' ? https : http;
      let settled = false;
      const probeOpenAi = () => {
        if (settled) return;
        const p = openAiUrl.protocol === 'https:' ? https : http;
        const req2 = p.request({
          hostname: openAiUrl.hostname,
          port: openAiUrl.port ? parseInt(openAiUrl.port, 10) : (openAiUrl.protocol === 'https:' ? 443 : 80),
          path: openAiUrl.pathname, method: 'GET',
        }, (res2) => {
          res2.resume();
          if (!settled) { settled = true; resolve({ ok: res2.statusCode === 200, message: res2.statusCode === 200 ? 'OpenAI-compatible OK' : 'HTTP ' + res2.statusCode }); }
        });
        req2.on('error', (e: NodeJS.ErrnoException) => { if (!settled) { settled = true; resolve({ ok: false, message: ollamaConnectError(openAiUrl.hostname, e).message }); } });
        req2.setTimeout(8000, () => { if (!settled) { settled = true; req2.destroy(); resolve({ ok: false, message: '連線逾時 (8s)，請確認主機 ' + openAiUrl.hostname + ' 可達' }); } });
        req2.end();
      };
      const req = protocol.request({
        hostname: url.hostname,
        port: url.port ? parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 11434),
        path: url.pathname, method: 'GET',
      }, (res) => {
        res.resume();
        if (!settled) { if (res.statusCode === 200) { settled = true; resolve({ ok: true, message: 'OK' }); } else { probeOpenAi(); } }
      });
      req.on('error', () => { if (!settled) { probeOpenAi(); } });
      req.setTimeout(8000, () => { if (!settled) { req.destroy(); probeOpenAi(); } });
      req.end();
    } catch (e) { resolve({ ok: false, message: e instanceof Error ? e.message : String(e) }); }
  });
}

export function ollamaDeleteModel(baseUrl: string, modelName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const url = new URL('/api/delete', baseUrl);
      const body = JSON.stringify({ model: modelName });
      const protocol = url.protocol === 'https:' ? https : http;
      const req = protocol.request({
        hostname: url.hostname,
        port: url.port ? parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 11434),
        path: url.pathname, method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => {
        res.resume();
        if (res.statusCode === 200) { resolve(); } else { reject(new Error('HTTP ' + res.statusCode)); }
      });
      req.on('error', (e: NodeJS.ErrnoException) => reject(ollamaConnectError(url.hostname, e)));
      req.setTimeout(15000, () => { req.destroy(new Error('ETIMEDOUT')); });
      req.write(body); req.end();
    } catch (e) { reject(e); }
  });
}

export function ollamaPullModel(
  baseUrl: string, modelName: string,
  onProgress: (status: string, percent: number | null) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const url = new URL('/api/pull', baseUrl);
      const body = JSON.stringify({ model: modelName, stream: true });
      const protocol = url.protocol === 'https:' ? https : http;
      const req = protocol.request({
        hostname: url.hostname,
        port: url.port ? parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 11434),
        path: url.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => {
        if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode)); return; }
        let buf = '';
        res.on('data', (chunk: Buffer) => {
          buf += chunk.toString();
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const obj = JSON.parse(line) as { status?: string; completed?: number; total?: number; error?: string };
              if (obj.error) { reject(new Error(obj.error)); return; }
              const pct = (obj.total && obj.total > 0) ? Math.round((obj.completed ?? 0) / obj.total * 100) : null;
              onProgress(obj.status ?? '', pct);
            } catch { /* skip */ }
          }
        });
        res.on('end', () => resolve());
        res.on('error', (e: Error) => reject(e));
      });
      req.on('error', (e: NodeJS.ErrnoException) => reject(ollamaConnectError(url.hostname, e)));
      req.write(body); req.end();
    } catch (e) { reject(e); }
  });
}
