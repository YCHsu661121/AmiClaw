// Copyright (c) 2026 YCHsu. All rights reserved.
// Licensed under the MIT License.
// USD cost calculation for commercial LLM APIs ($ per million tokens).

export interface ModelPrice {
  inputPerMToken: number;
  outputPerMToken: number;
}

const PRICE_TABLE: Array<{ pattern: RegExp; price: ModelPrice }> = [
  // ── OpenAI ────────────────────────────────────────────────────────────────
  { pattern: /o3-mini/i,                 price: { inputPerMToken:  1.10, outputPerMToken:  4.40 } },
  { pattern: /o1-mini/i,                 price: { inputPerMToken:  1.10, outputPerMToken:  4.40 } },
  { pattern: /o1(?!-mini)/i,             price: { inputPerMToken: 15.0,  outputPerMToken: 60.0  } },
  { pattern: /gpt-4o-mini/i,             price: { inputPerMToken:  0.15, outputPerMToken:  0.60 } },
  { pattern: /gpt-4o/i,                  price: { inputPerMToken:  2.50, outputPerMToken: 10.0  } },
  { pattern: /gpt-4-turbo/i,             price: { inputPerMToken: 10.0,  outputPerMToken: 30.0  } },
  { pattern: /gpt-4/i,                   price: { inputPerMToken: 30.0,  outputPerMToken: 60.0  } },
  { pattern: /gpt-3\.5-turbo/i,          price: { inputPerMToken:  0.50, outputPerMToken:  1.50 } },
  // ── Anthropic Claude ──────────────────────────────────────────────────────
  { pattern: /claude-opus-4\.6.*fast/i,  price: { inputPerMToken: 30.0,  outputPerMToken: 150.0 } },
  { pattern: /claude-opus-4/i,           price: { inputPerMToken: 15.0,  outputPerMToken:  75.0 } },
  { pattern: /claude-sonnet-4/i,         price: { inputPerMToken:  3.00, outputPerMToken:  15.0 } },
  { pattern: /claude-3\.5-sonnet/i,      price: { inputPerMToken:  3.00, outputPerMToken:  15.0 } },
  { pattern: /claude-3-opus/i,           price: { inputPerMToken: 15.0,  outputPerMToken:  75.0 } },
  { pattern: /claude-haiku-4\.5/i,       price: { inputPerMToken:  1.00, outputPerMToken:   5.0 } },
  { pattern: /claude-haiku-3\.5/i,       price: { inputPerMToken:  0.80, outputPerMToken:   4.0 } },
  { pattern: /claude-3-haiku/i,          price: { inputPerMToken:  0.25, outputPerMToken:   1.25} },
  // ── Gemini ────────────────────────────────────────────────────────────────
  { pattern: /gemini-2\.5-pro/i,         price: { inputPerMToken:  1.25, outputPerMToken:  10.0 } },
  { pattern: /gemini-2\.0-flash/i,       price: { inputPerMToken:  0.10, outputPerMToken:   0.40} },
  { pattern: /gemini-1\.5-pro/i,         price: { inputPerMToken:  1.25, outputPerMToken:   5.0 } },
  { pattern: /gemini-1\.5-flash/i,       price: { inputPerMToken:  0.075,outputPerMToken:   0.30} },
  // ── GitHub Copilot (subscription, $0 per-token) ───────────────────────────
  { pattern: /copilot/i,                 price: { inputPerMToken:  0,    outputPerMToken:   0   } },
];

export function getModelPrice(model: string): ModelPrice | null {
  for (const entry of PRICE_TABLE) {
    if (entry.pattern.test(model)) return entry.price;
  }
  return null; // local/unknown → no price
}

export function calcCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = getModelPrice(model);
  if (!p) return 0;
  return (inputTokens  / 1_000_000) * p.inputPerMToken +
         (outputTokens / 1_000_000) * p.outputPerMToken;
}

/** Format USD cost: $X.XXXX for <$1, $X.XX for ≥$1, empty string if zero. */
export function formatCostUsd(usd: number): string {
  if (usd <= 0)    return '';
  if (usd >= 1.0)  return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(6)}`;
}
