// Copyright (c) 2026 YCHsu. All rights reserved.
// Licensed under the MIT License.

/**
 * AutoPilot 分類器：呼叫 LLM 判斷某個 tool call 是否安全。
 * 對應 claude-code `yoloClassifier.ts` 的 fast-stage（單呼叫 XML 版）。
 *
 * 為了不綁住 AmiClaw 既有的 Ollama / Copilot / OpenAI 多 provider 機制，
 * 這裡只接受抽象的 `callModel` callback。wire-in 端再從外面注入適配器。
 */

import { buildAutoPilotSystemPrompt, formatActionForClassifier, type AutoPilotPromptRules } from './AutoPilotPrompt';

export interface AutoPilotTranscriptMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
}

export interface AutoPilotCallModelOptions {
  system: string;
  user: string;
  maxTokens?: number;
  stopSequences?: string[];
  signal?: AbortSignal;
}

export interface AutoPilotCallModelResult {
  text: string;
  usage?: { inputTokens: number; outputTokens: number };
  durationMs?: number;
}

export interface AutoPilotClassifierServices {
  /** 呼叫一次小型 LLM，回傳純文字。由 wire-in 層適配 Ollama / Copilot / OpenAI 等 provider。 */
  callModel: (opts: AutoPilotCallModelOptions) => Promise<AutoPilotCallModelResult>;
  log?: (msg: string) => void;
}

export interface AutoPilotClassifyArgs {
  toolName: string;
  toolArgs: Record<string, unknown>;
  /** 最近的對話片段（已截短），用來判斷 user intent。建議保留最後 6~10 則訊息。 */
  recentTranscript: AutoPilotTranscriptMessage[];
  rules?: AutoPilotPromptRules;
  signal?: AbortSignal;
  services: AutoPilotClassifierServices;
}

export type AutoPilotClassifierVerdict = 'allow' | 'block' | 'unavailable';

export interface AutoPilotClassifierResult {
  verdict: AutoPilotClassifierVerdict;
  reason: string;
  rawText?: string;
  durationMs?: number;
  usage?: { inputTokens: number; outputTokens: number };
}

const MAX_TRANSCRIPT_CHARS = 12_000;

function renderTranscript(msgs: AutoPilotTranscriptMessage[]): string {
  const lines: string[] = ['<transcript>'];
  let total = 0;
  for (const m of msgs) {
    const piece = `  <${m.role}>${m.content}</${m.role}>`;
    if (total + piece.length > MAX_TRANSCRIPT_CHARS) {
      lines.push('  <truncated/>');
      break;
    }
    lines.push(piece);
    total += piece.length;
  }
  lines.push('</transcript>');
  return lines.join('\n');
}

/**
 * 解析 `<block>yes/no</block><reason>...</reason>`，容錯：
 * - 大小寫不敏感
 * - 允許前後空白 / 換行
 * - 找不到 <block> 時，視為 unavailable（safe default = block 由上層處理）
 */
function parseClassifierOutput(text: string): { verdict: AutoPilotClassifierVerdict; reason: string } {
  const blockMatch = /<block>\s*(yes|no)\s*<\/block>/i.exec(text);
  if (!blockMatch) {
    return { verdict: 'unavailable', reason: 'classifier returned malformed output' };
  }
  const reasonMatch = /<reason>([\s\S]*?)<\/reason>/i.exec(text);
  const reason = reasonMatch ? reasonMatch[1].trim().replace(/\s+/g, ' ') : '(no reason)';
  return blockMatch[1].toLowerCase() === 'yes'
    ? { verdict: 'block', reason }
    : { verdict: 'allow', reason };
}

/**
 * 呼叫分類器並回傳結果。任何 callModel 例外都會轉成 `unavailable`，
 * 上層 policy 會自動 fallback 到人工確認，不會拋。
 */
export async function classifyAutoPilotAction(args: AutoPilotClassifyArgs): Promise<AutoPilotClassifierResult> {
  const { toolName, toolArgs, recentTranscript, rules, signal, services } = args;
  const system = buildAutoPilotSystemPrompt(rules);
  const user = `${renderTranscript(recentTranscript)}\n\n## New action to classify\n${formatActionForClassifier(toolName, toolArgs)}`;
  const t0 = Date.now();
  try {
    const res = await services.callModel({
      system, user,
      maxTokens: 256,
      signal,
    });
    const parsed = parseClassifierOutput(res.text);
    return {
      verdict: parsed.verdict,
      reason: parsed.reason,
      rawText: res.text,
      durationMs: res.durationMs ?? (Date.now() - t0),
      usage: res.usage,
    };
  } catch (err) {
    services.log?.(`[AutoPilot] classifier callModel failed: ${(err as Error)?.message ?? err}`);
    return {
      verdict: 'unavailable',
      reason: `classifier error: ${(err as Error)?.message ?? 'unknown'}`,
      durationMs: Date.now() - t0,
    };
  }
}
