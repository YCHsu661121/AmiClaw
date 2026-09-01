// Copyright (c) 2026 YCHsu. All rights reserved.
// Licensed under the MIT License.
// OpenAI-compatible /v1/chat/completions client + GitHub Copilot LM API wrapper.

import * as http from 'http';
import * as https from 'https';
import * as vscode from 'vscode';
import type { ChatMessage } from '../types/chat-types';

// Module-level logger injected by OllamaChatPanel on startup.
let _log: (msg: string) => void = () => { /* no-op until panel injects logger */ };
export function setOpenAICompatLogger(fn: (msg: string) => void): void { _log = fn; }

// ── OpenAI-compatible streaming ───────────────────────────────────────────────

export function openaiCompatChatCallStream(
  baseUrl: string, model: string, messages: ChatMessage[], tools: unknown[],
  onTextChunk?: (chunk: string) => void,
  onStats?: (tokens: number, tps: number, usage?: { input: number; output: number }) => void,
  onThinkChunk?: (chunk: string) => void
): Promise<ChatMessage> {
  _log(`[openaiCompat] call url=${baseUrl} model=${model} msgs=${messages.length} tools=${tools.length}`);
  return new Promise((resolve, reject) => {
    try {
      const url = new URL('/v1/chat/completions', baseUrl);
      const oaiMessages = messages.map(m => {
        if (m.role === 'tool') return { role: 'tool' as const, content: m.content ?? '', tool_call_id: m.tool_call_id ?? '' };
        if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
          return {
            role: 'assistant' as const, content: m.content ?? null,
            tool_calls: m.tool_calls.map(tc => ({
              id: tc.id ?? tc.function.name, type: 'function' as const,
              function: { name: tc.function.name, arguments: typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments) },
            })),
          };
        }
        return { role: m.role as 'system' | 'user' | 'assistant', content: m.content ?? '' };
      });
      const protocol = url.protocol === 'https:' ? https : http;
      let triedWithoutTools = false;

      const sendRequest = (includeTools: boolean) => {
        const oaiTools = includeTools && tools.length > 0 ? tools : undefined;
        const bodyObj: Record<string, unknown> = { model, messages: oaiMessages, stream: true };
        if (oaiTools) { bodyObj.tools = oaiTools; }
        const body = JSON.stringify(bodyObj);
        const options: http.RequestOptions = {
          hostname: url.hostname,
          port: url.port ? parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname, method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Accept': 'text/event-stream' },
        };
        const _oaiKey = vscode.workspace.getConfiguration('amiAiClaw').get<string>('openaiCompatApiKey', '');
        if (_oaiKey) { (options.headers as Record<string, string>)['Authorization'] = 'Bearer ' + _oaiKey; }

        let lineBuffer = '';
        let accContent = '';
        let wasTruncated = false;
        const toolCallBuilders: Map<number, { id: string; name: string; args: string }> = new Map();
        let promptTokens = 0; let completionTokens = 0; const startMs = Date.now();
        let _thinkState: 0 | 1 | 2 = 0;
        let _tagBuf = '';
        const _dispatch = (raw: string) => {
          let s = _tagBuf + raw; _tagBuf = '';
          while (s.length > 0) {
            if (_thinkState === 0) {
              const openIdx = s.indexOf('<think>');
              if (openIdx === -1) {
                let cut = s.length;
                for (let p = Math.min(s.length, 6); p >= 1; p--) { if ('<think>'.startsWith(s.slice(s.length - p))) { cut = s.length - p; _tagBuf = s.slice(cut); break; } }
                if (cut > 0 && onTextChunk) onTextChunk(s.slice(0, cut)); s = '';
              } else {
                if (openIdx > 0 && onTextChunk) onTextChunk(s.slice(0, openIdx));
                s = s.slice(openIdx + 7); _thinkState = 1;
              }
            } else if (_thinkState === 1) {
              const closeIdx = s.indexOf('</think>');
              if (closeIdx === -1) {
                let cut = s.length;
                for (let p = Math.min(s.length, 7); p >= 1; p--) { if ('</think>'.startsWith(s.slice(s.length - p))) { cut = s.length - p; _tagBuf = s.slice(cut); break; } }
                if (cut > 0 && onThinkChunk) onThinkChunk(s.slice(0, cut)); s = '';
              } else {
                if (closeIdx > 0 && onThinkChunk) onThinkChunk(s.slice(0, closeIdx));
                s = s.slice(closeIdx + 8); _thinkState = 2;
              }
            } else { if (onTextChunk) onTextChunk(s); s = ''; }
          }
        };

        const req = protocol.request(options, (res) => {
          if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
            let errBody = '';
            res.setEncoding('utf8');
            res.on('data', (d: string) => { errBody += d; });
            res.on('end', () => {
              let apiMessage = 'HTTP ' + res.statusCode;
              try { const j = JSON.parse(errBody); apiMessage = j.error?.message ?? apiMessage; } catch { /* ignore */ }
              const isAutoToolChoiceError = apiMessage.includes('"auto" tool choice requires') || apiMessage.includes('--enable-auto-tool-choice');
              if (includeTools && !triedWithoutTools && isAutoToolChoiceError) { triedWithoutTools = true; sendRequest(false); return; }
              if (apiMessage.startsWith('HTTP ')) { reject(new Error('OpenAI API HTTP ' + res.statusCode + ': ' + errBody.slice(0, 200))); return; }
              reject(new Error('OpenAI API 錯誤：' + apiMessage));
            });
            return;
          }
          res.setEncoding('utf8');
          _log(`[openaiCompat] HTTP ${res.statusCode} headers=${JSON.stringify(res.headers).slice(0, 200)}`);
          let _firstChunk = true;
          let _sseEvent = '';
          let _sseError = '';
          res.on('data', (data: string) => {
            lineBuffer += data;
            const lines = lineBuffer.split('\n');
            lineBuffer = lines.pop() ?? '';
            for (const line of lines) {
              const t = line.trim();
              if (!t) { _sseEvent = ''; continue; }
              if (t.startsWith('event:')) { _sseEvent = t.slice(6).trim(); continue; }
              if (!t.startsWith('data:')) continue;
              const payload = t.slice(5).trim();
              if (payload === '[DONE]') continue;
              if (_sseEvent === 'error') {
                try { const errObj = JSON.parse(payload); _sseError = errObj?.error?.message ?? payload.slice(0, 300); } catch { _sseError = payload.slice(0, 300); }
                continue;
              }
              try {
                const chunk = JSON.parse(payload) as {
                  choices?: Array<{ delta?: { content?: string | null; reasoning_content?: string | null; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string }>;
                  usage?: { prompt_tokens?: number; completion_tokens?: number };
                };
                if (chunk.choices?.[0]?.finish_reason === 'length') wasTruncated = true;
                const delta = chunk.choices?.[0]?.delta;
                if (delta?.reasoning_content) {
                  if (_firstChunk) { _log(`[openaiCompat] first reasoning_content chunk: ${JSON.stringify(delta.reasoning_content.slice(0, 40))}`); _firstChunk = false; }
                  if (onThinkChunk) onThinkChunk(delta.reasoning_content);
                }
                if (delta?.content) {
                  if (_firstChunk) { _log(`[openaiCompat] first content chunk: ${JSON.stringify(delta.content.slice(0, 40))}`); _firstChunk = false; }
                  accContent += delta.content; _dispatch(delta.content);
                }
                if (delta?.tool_calls) {
                  for (const tc of delta.tool_calls) {
                    if (!toolCallBuilders.has(tc.index)) { toolCallBuilders.set(tc.index, { id: tc.id ?? '', name: '', args: '' }); }
                    const b = toolCallBuilders.get(tc.index)!;
                    if (tc.id) b.id = tc.id;
                    if (tc.function?.name) b.name += tc.function.name;
                    if (tc.function?.arguments) b.args += tc.function.arguments;
                  }
                }
                if (chunk.usage) { promptTokens = chunk.usage.prompt_tokens ?? 0; completionTokens = chunk.usage.completion_tokens ?? 0; }
              } catch { /* partial */ }
            }
          });
          res.on('end', () => {
            _log(`[openaiCompat] end: accContent.length=${accContent.length} toolCalls=${toolCallBuilders.size} sseError=${!!_sseError}`);
            if (_sseError) {
              const isCtxOverflow = /exceeds.*context|context.*size|context.*length/i.test(_sseError);
              if (includeTools && !triedWithoutTools && isCtxOverflow) { _log(`[openaiCompat] context overflow with tools, retrying without tools`); triedWithoutTools = true; sendRequest(false); return; }
              reject(new Error('OpenAI API 錯誤：' + _sseError)); return;
            }
            if (onStats && completionTokens > 0) {
              const elapsed = (Date.now() - startMs) / 1000;
              onStats(promptTokens + completionTokens, elapsed > 0 ? completionTokens / elapsed : 0, { input: promptTokens, output: completionTokens });
            }
            if (toolCallBuilders.size > 0) {
              const tool_calls = Array.from(toolCallBuilders.entries()).sort(([a], [b]) => a - b).map(([, b]) => ({
                id: b.id || b.name,
                function: { name: b.name, arguments: (() => { try { return JSON.parse(b.args) as Record<string, unknown>; } catch { return {}; } })() },
              }));
              resolve({ role: 'assistant', content: accContent || null, tool_calls });
            } else {
              resolve({ role: 'assistant', content: accContent || null, truncated: wasTruncated || undefined });
            }
          });
          res.on('error', (e: Error) => reject(e));
        });
        req.on('error', (e: Error) => reject(new Error(`無法連線到 OpenAI-compatible server (${baseUrl})：${e.message}`)));
        req.setTimeout(1200000, () => { req.destroy(new Error('OpenAI-compatible 呼叫逾時 (1200s)')); });
        req.write(body); req.end();
      };
      sendRequest(true);
    } catch (e) { reject(e); }
  });
}

export function fetchOpenAiCompatModels(baseUrl: string, apiKey: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    try {
      const url = new URL('/v1/models', baseUrl);
      const protocol = url.protocol === 'https:' ? https : http;
      const headers: Record<string, string> = { 'Accept': 'application/json' };
      if (apiKey) { headers['Authorization'] = 'Bearer ' + apiKey; }
      const req = protocol.request({ hostname: url.hostname, port: url.port ? parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 80), path: url.pathname, method: 'GET', headers }, (res) => {
        let data = '';
        res.on('data', (c: Buffer) => { data += c; });
        res.on('end', () => {
          if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
          try {
            const json = JSON.parse(data);
            const EMBED_PATTERN = /embed|rerank|classifier|clip|stable-?diffusion/i;
            const ids = (json.data ?? []).map((m: { id?: string }) => m.id)
              .filter((id: unknown): id is string => typeof id === 'string' && id.trim().length > 0 && !EMBED_PATTERN.test(id))
              .map((id: string) => `openai::${baseUrl.replace(/\/$/, '')}||${id}`).sort();
            resolve(ids);
          } catch { reject(new Error('Invalid JSON')); }
        });
      });
      req.on('error', reject);
      req.setTimeout(8000, () => { req.destroy(new Error('ETIMEDOUT')); });
      req.end();
    } catch (e) { reject(e); }
  });
}

// ── GitHub Copilot LM API ─────────────────────────────────────────────────────

export function getCopilotMultiplier(m: vscode.LanguageModelChat): string {
  const id = m.id.toLowerCase();
  const fam = (m.family || '').toLowerCase();
  if (id === 'auto' || fam === 'auto') return '10% off';
  if (id.includes('opus') || fam.includes('opus')) return '3x';
  if (id.includes('mini') || fam.includes('mini')) return '0x';
  if ((id.startsWith('gpt-4o') && !id.includes('mini')) || fam === 'gpt-4o' || id === 'gpt-4o') return '0x';
  return '1x';
}

export function getCopilotMultiplierById(id: string): string {
  const i = id.toLowerCase();
  if (i === 'auto') return '10% off';
  if (i.includes('opus')) return '3x';
  if (i.includes('mini')) return '0x';
  if (i.startsWith('gpt-4o') && !i.includes('mini')) return '0x';
  return '1x';
}

export async function copilotStreamText(
  modelId: string,
  messages: vscode.LanguageModelChatMessage[],
  onChunk: (c: string) => void,
  token: vscode.CancellationToken
): Promise<string> {
  const lms = await vscode.lm.selectChatModels({ id: modelId });
  const lm = lms[0];
  if (!lm) { throw new Error(`Copilot 找不到模型: ${modelId}`); }
  const response = await lm.sendRequest(messages, {}, token);
  let full = '';
  for await (const chunk of response.text) { full += chunk; onChunk(chunk); }
  return full;
}

export async function copilotChatCallWithCts(
  modelId: string, messages: ChatMessage[], tools: unknown[]
): Promise<ChatMessage> {
  const lms = await vscode.lm.selectChatModels({ id: modelId });
  const lm = lms[0];
  if (!lm) { throw new Error(`Copilot 找不到模型: ${modelId}`); }

  const sanitized = messages.filter((m, i) => {
    if (m.role !== 'tool') return true;
    let ai = i - 1;
    while (ai >= 0 && messages[ai].role === 'tool') { ai--; }
    return ai >= 0 && messages[ai].role === 'assistant' &&
      (messages[ai].tool_calls ?? []).some(tc => (tc.id ?? tc.function.name) === m.tool_call_id);
  });

  const vmMsgs: vscode.LanguageModelChatMessage[] = [];
  for (const m of sanitized) {
    if (m.role === 'system' || m.role === 'user') {
      vmMsgs.push(vscode.LanguageModelChatMessage.User(m.content ?? ''));
    } else if (m.role === 'assistant') {
      const parts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[] = [];
      if (m.content) { parts.push(new vscode.LanguageModelTextPart(m.content)); }
      for (const tc of m.tool_calls ?? []) {
        const args = (typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments) as Record<string, unknown>;
        parts.push(new vscode.LanguageModelToolCallPart(tc.id ?? tc.function.name, tc.function.name, args));
      }
      if (parts.length === 0) { parts.push(new vscode.LanguageModelTextPart('')); }
      vmMsgs.push(parts.length === 1 && parts[0] instanceof vscode.LanguageModelTextPart
        ? vscode.LanguageModelChatMessage.Assistant(parts[0].value)
        : vscode.LanguageModelChatMessage.Assistant(parts));
    } else if (m.role === 'tool') {
      vmMsgs.push(vscode.LanguageModelChatMessage.User([
        new vscode.LanguageModelToolResultPart(m.tool_call_id ?? '', [new vscode.LanguageModelTextPart(m.content ?? '')])
      ]));
    }
  }

  type OllamaTool = { function: { name: string; description: string; parameters: object } };
  const vmTools = (tools as OllamaTool[]).map(t => ({ name: t.function.name, description: t.function.description, inputSchema: t.function.parameters }));
  const cts = new vscode.CancellationTokenSource();
  try {
    const response = await lm.sendRequest(vmMsgs, { tools: vmTools }, cts.token);
    let text = '';
    const toolCalls: NonNullable<ChatMessage['tool_calls']> = [];
    for await (const part of response.stream) {
      if (part instanceof vscode.LanguageModelTextPart) { text += part.value; }
      else if (part instanceof vscode.LanguageModelToolCallPart) {
        toolCalls.push({ id: part.callId, function: { name: part.name, arguments: (typeof part.input === 'object' ? part.input : JSON.parse(String(part.input))) as Record<string, unknown> } });
      }
    }
    return { role: 'assistant', content: text || null, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) };
  } finally { cts.dispose(); }
}
