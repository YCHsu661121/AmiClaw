// Copyright (c) 2026 YCHsu. All rights reserved.
// Licensed under the MIT License.

/**
 * 偵測 LLM 是否回了「我做不到 / 你自己去終端機跑」這類拒絕回應。
 * 用於在 agent 模式中觸發重試或切換策略，避免「卡住但仍占用 turn」。
 */
const REFUSAL_PATTERNS: string[] = [
  // 中文拒絕語
  '無法直接',
  '我無法看到',
  '我無法直接',
  '我目前無法',
  '無法執行',
  '我的權限',
  '沙盒環境',
  '你可以在終端機',
  '你可以輸入以下',
  '你可以透過以下',
  '請將檔案內容貼給我',
  '把結果貼給我',
  '請把清單貼上',
  '你可以執行以下',
  '你可以嘗試以下',
  'find . -type f',
  'wc -l',
  'dir /s /b',
  'get-childitem -recurse',
  // gemma4 / 其他模型特有的拒絕語句
  '權限僅限於',
  '僅限於「讀取',
  '僅限於讀取',
  'read-only',
  '唯讀模式',
  '讀取模式',
  '切換至.*agent',
  '切換到.*agent',
  '請切換模式',
  '切換為 agent',
  '我沒有辦法執行',
  '我沒有能力執行',
  '無法直接存取',
  '我無法存取',
  '我目前的權限',
  '目前模式不支援',
  '此模式不允許',
  // 英文拒絕語
  "i can't directly",
  "i cannot directly",
  "i don't have access",
  "i don't have the ability",
  "i'm not able to",
  'unable to access your',
  'you can run the following',
  'you can execute',
  'paste the output',
  'read-only mode',
  'switch to agent',
  'i only have read',
  'limited to read',
];

export function isRefusalResponse(text: string): boolean {
  const lower = text.toLowerCase();
  return REFUSAL_PATTERNS.some(p => {
    if (p.includes('.*')) {
      try { return new RegExp(p, 'i').test(text); } catch { return false; }
    }
    return lower.includes(p.toLowerCase());
  });
}
