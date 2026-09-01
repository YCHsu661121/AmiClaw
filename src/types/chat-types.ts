// Copyright (c) 2026 YCHsu. All rights reserved.
// Licensed under the MIT License.
// Shared chat protocol types — imported by ollama-chat.ts and all provider modules.

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  thinking?: string;
  tool_calls?: Array<{ id?: string; function: { name: string; arguments: Record<string, unknown> | string } }>;
  tool_call_id?: string;
  images?: string[];
  truncated?: boolean;
}

export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'max';
