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
  // 詢問確認類（已授權操作不需二次確認）
  '請您確認是否同意',
  '您是否同意我',
  '是否允許我',
  '請確認是否可以',
  '需要您的確認',
  '是否繼續執行',
  // 虛假 token/content 限制藉口
  'token 限制',
  '超出 token',
  '無法在單次對話中',
  '內容太長無法',
  '請分批',
  '分次傳送',
  '分段輸出',
  'do you confirm',
  'please confirm before',
  'need your approval',
  'exceed.*token',
  'token.*limit.*cannot',
  // 通用「詢問確認」正則
  '請.*是否.*同意',
  '請.*確認.*是否',
  '您.*點頭.*我.*立即',
  '如果您.*同意.*我將',
  // ask 模式行為：指示使用者自行執行，而非 agent 直接呼叫工具
  'ask 模式',
  'ask mode',
  '在 ask',
  '你需要執行',
  '需要執行以下',
  '請執行以下',
  '按照以下步驟',
  '以下步驟',
  '建議.*執行',
  '建議你執行',
  '建議使用以下',
  '可以在.*執行以下',
  '在命令列.*執行',
  '在.*powershell.*執行',
  '在.*終端.*執行',
  'you should run',
  'you need to run',
  'try running',
  'try executing',
  'run the following',
  'execute the following',
  'here are the steps',
  'follow these steps',
  'the following command',
  'the following commands',
  'i recommend running',
  'i suggest running',
  'you would need to run',
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
