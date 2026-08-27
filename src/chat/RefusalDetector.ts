// Copyright (c) 2026 YCHsu. All rights reserved.
// Licensed under the MIT License.

/**
 * 偵測 LLM 是否回了「拒絕 / 推給使用者 / 等確認」類回應。
 * 重構版：加權計分 + whitelist 豁免 + 收緊 choice 判定。
 */

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

export type RefusalCategory =
  | 'hard_refusal'      // 直接「我做不到」
  | 'defer_to_user'     // 推給使用者自行執行
  | 'mode_switch'       // 要求切換 agent / 模式
  | 'confirm_gate'      // 等使用者點頭才動手
  | 'fake_limit';       // 虛構 token / context 限制

export interface RefusalVerdict {
  isRefusal: boolean;
  score: number;
  category: RefusalCategory | null;
  matched: string[];          // 命中 pattern 清單（debug 用）
  whitelistHits: string[];    // 命中 whitelist（debug 用）
}

export interface ChoiceVerdict {
  isChoice: boolean;
  score: number;
  matched: string[];
}

// ──────────────────────────────────────────────
// Weighted pattern tables
// ──────────────────────────────────────────────

interface Pattern {
  /** 正規表達式（lowercase 比對）；若為 null 則用 plain string */
  re: RegExp | null;
  str?: string;
  weight: number;             // 1–5
  category: RefusalCategory;
}

function P(str: string, weight: number, category: RefusalCategory): Pattern {
  return { re: null, str: str.toLowerCase(), weight, category };
}
function R(src: string, weight: number, category: RefusalCategory): Pattern {
  return { re: new RegExp(src, 'i'), weight, category };
}

const REFUSAL_PATTERNS: readonly Pattern[] = [
  // ── hard_refusal（直接說做不到）─────────────
  P('無法直接', 4, 'hard_refusal'),
  P('我無法看到', 5, 'hard_refusal'),
  P('我無法直接', 5, 'hard_refusal'),
  P('我目前無法', 4, 'hard_refusal'),
  P('無法執行', 4, 'hard_refusal'),
  P('我的權限', 3, 'hard_refusal'),
  P('沙盒環境', 3, 'hard_refusal'),
  P('權限僅限於', 4, 'hard_refusal'),
  P('僅限於「讀取', 4, 'hard_refusal'),
  P('僅限於讀取', 4, 'hard_refusal'),
  P('唯讀模式', 3, 'hard_refusal'),
  P('讀取模式', 3, 'hard_refusal'),
  P('我沒有辦法執行', 5, 'hard_refusal'),
  P('我沒有能力執行', 5, 'hard_refusal'),
  P('無法直接存取', 5, 'hard_refusal'),
  P('我無法存取', 5, 'hard_refusal'),
  P('我目前的權限', 4, 'hard_refusal'),
  P('目前模式不支援', 4, 'hard_refusal'),
  P('此模式不允許', 4, 'hard_refusal'),
  // EN
  P("i can't directly", 5, 'hard_refusal'),
  P('i cannot directly', 5, 'hard_refusal'),
  P("i don't have access", 5, 'hard_refusal'),
  P("i don't have the ability", 4, 'hard_refusal'),
  P("i'm not able to", 4, 'hard_refusal'),
  P('unable to access your', 4, 'hard_refusal'),
  P('i only have read', 4, 'hard_refusal'),
  P('limited to read', 4, 'hard_refusal'),

  // ── defer_to_user（推給使用者跑）────────────
  P('你可以在終端機', 5, 'defer_to_user'),
  P('你可以輸入以下', 4, 'defer_to_user'),
  P('你可以透過以下', 4, 'defer_to_user'),
  P('請將檔案內容貼給我', 4, 'defer_to_user'),
  P('把結果貼給我', 4, 'defer_to_user'),
  P('請把清單貼上', 4, 'defer_to_user'),
  P('你可以執行以下', 5, 'defer_to_user'),
  P('你可以嘗試以下', 4, 'defer_to_user'),
  P('你需要執行', 4, 'defer_to_user'),
  P('需要執行以下', 4, 'defer_to_user'),
  P('請執行以下', 4, 'defer_to_user'),
  P('按照以下步驟', 3, 'defer_to_user'),
  P('以下步驟', 2, 'defer_to_user'),
  R('建議.*執行', 3, 'defer_to_user'),
  P('建議你執行', 3, 'defer_to_user'),
  P('建議使用以下', 3, 'defer_to_user'),
  R('可以在.*執行以下', 4, 'defer_to_user'),
  R('在命令列.*執行', 4, 'defer_to_user'),
  R('在.*powershell.*執行', 4, 'defer_to_user'),
  R('在.*終端.*執行', 4, 'defer_to_user'),
  // EN
  P('you can run the following', 5, 'defer_to_user'),
  P('you can execute', 4, 'defer_to_user'),
  P('paste the output', 4, 'defer_to_user'),
  P('you should run', 4, 'defer_to_user'),
  P('you need to run', 4, 'defer_to_user'),
  P('try running', 3, 'defer_to_user'),
  P('try executing', 3, 'defer_to_user'),
  P('run the following', 4, 'defer_to_user'),
  P('execute the following', 4, 'defer_to_user'),
  P('here are the steps', 3, 'defer_to_user'),
  P('follow these steps', 3, 'defer_to_user'),
  P('the following command', 3, 'defer_to_user'),
  P('the following commands', 3, 'defer_to_user'),
  P('i recommend running', 3, 'defer_to_user'),
  P('i suggest running', 3, 'defer_to_user'),
  P('you would need to run', 4, 'defer_to_user'),

  // ── mode_switch（要求切 agent）──────────────
  R('切換至.*agent', 4, 'mode_switch'),
  R('切換到.*agent', 4, 'mode_switch'),
  P('請切換模式', 4, 'mode_switch'),
  P('切換為 agent', 4, 'mode_switch'),
  P('switch to agent', 4, 'mode_switch'),
  P('ask 模式', 3, 'mode_switch'),
  P('ask mode', 3, 'mode_switch'),
  P('在 ask', 3, 'mode_switch'),

  // ── confirm_gate（等使用者點頭）─────────────
  P('請您確認是否同意', 4, 'confirm_gate'),
  P('您是否同意我', 4, 'confirm_gate'),
  P('是否允許我', 3, 'confirm_gate'),
  P('請確認是否可以', 3, 'confirm_gate'),
  P('需要您的確認', 3, 'confirm_gate'),
  P('是否繼續執行', 3, 'confirm_gate'),
  R('請.*是否.*同意', 4, 'confirm_gate'),
  R('請.*確認.*是否', 4, 'confirm_gate'),
  R('您.*點頭.*我.*立即', 3, 'confirm_gate'),
  R('如果您.*同意.*我將', 3, 'confirm_gate'),
  // EN
  P('do you confirm', 4, 'confirm_gate'),
  P('please confirm before', 4, 'confirm_gate'),
  P('need your approval', 4, 'confirm_gate'),
  P('shall i proceed', 4, 'confirm_gate'),
  P('should i proceed', 4, 'confirm_gate'),
  P('do you want me to', 3, 'confirm_gate'),
  P('would you like me to', 3, 'confirm_gate'),
  P('please confirm if', 4, 'confirm_gate'),
  P('please let me know if', 3, 'confirm_gate'),
  P('confirm to proceed', 4, 'confirm_gate'),
  P('ready to proceed', 3, 'confirm_gate'),

  // ── fake_limit（虛構限制）──────────────────
  P('token 限制', 3, 'fake_limit'),
  P('超出 token', 3, 'fake_limit'),
  P('無法在單次對話中', 4, 'fake_limit'),
  P('內容太長無法', 3, 'fake_limit'),
  P('請分批', 3, 'fake_limit'),
  P('分次傳送', 3, 'fake_limit'),
  P('分段輸出', 3, 'fake_limit'),
  R('exceed.*token', 3, 'fake_limit'),
  R('token.*limit.*cannot', 4, 'fake_limit'),

  // ── 命令片段（暗示使用者自行跑）────────────
  P('find . -type f', 2, 'defer_to_user'),
  P('wc -l', 1, 'defer_to_user'),
  P('dir /s /b', 2, 'defer_to_user'),
  P('get-childitem -recurse', 2, 'defer_to_user'),
];

// ──────────────────────────────────────────────
// Whitelist — 若命中任一條，該 pattern 的計分歸零
// ──────────────────────────────────────────────

const WHITELIST_PATTERNS: readonly string[] = [
  // 正在「引用」拒絕語句（教學 / 文件 / 回覆用戶提問）
  '拒絕回應',
  'refusal detector',
  'refusal pattern',
  '以下為範例',
  'example:',
  // 實際執行成功的語境
  '執行成功',
  '已成功',
  'build succeeded',
  'completed successfully',
  '操作完成',
  // 說明 read-only 但非拒絕（描述屬性）
  'read-only attribute',
  '唯讀屬性',
  'read-only file system 的特性',
];

// ──────────────────────────────────────────────
// Choice patterns (tightened)
// ──────────────────────────────────────────────

interface ChoicePattern {
  re: RegExp | null;
  str?: string;
  weight: number;
}

function CP(str: string, weight: number): ChoicePattern {
  return { re: null, str: str.toLowerCase(), weight };
}
function CR(src: string, weight: number): ChoicePattern {
  return { re: new RegExp(src, 'i'), weight };
}

/**
 * 收緊判定：需同時滿足「選擇指示詞」+「待執行動作」才計分。
 * 單一 "option a" 不足以判定。
 */
const CHOICE_INDICATORS: readonly ChoicePattern[] = [
  P2('選項 a', 3), P2('選項 b', 3), P2('選項 c', 3),
  P2('option a', 3), P2('option b', 3), P2('option c', 3),
  P2('若無異議', 3), P2('若您同意', 3), P2('如果您同意', 3),
  P2('如果沒有問題', 2), P2('請確認是否', 3), P2('請問是否要', 3),
  P2('是否要我', 3), P2('shall i', 4), P2('should i', 4),
  P2('do you want me to', 3), P2('would you like me to', 3),
  P2('please confirm if', 3), P2('可以開始嗎', 3),
  P2('我可以開始', 3), P2('可以繼續嗎', 3),
];

function P2(str: string, weight: number): ChoicePattern {
  return { re: null, str: str.toLowerCase(), weight };
}

/** 必須搭配「待執行動詞」才有效 */
const CHOICE_ACTION_VERBS: readonly string[] = [
  '執行', '建立', '修改', '重構', '部署', '建置',
  'run', 'build', 'create', 'modify', 'refactor', 'deploy',
  '開始', '動手', 'proceed', 'start', 'begin',
];

// ──────────────────────────────────────────────
// Scoring thresholds
// ──────────────────────────────────────────────

const REFUSAL_THRESHOLD = 8;   // ≥ 8 判定為拒絕
const CHOICE_THRESHOLD = 6;    // ≥ 6 判定為等確認

// ──────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────

/**
 * 完整偵測：回傳分數、類別、命中清單。
 */
export function detectRefusal(text: string): RefusalVerdict {
  const lower = text.toLowerCase();

  // Whitelist check
  const whitelistHits = WHITELIST_PATTERNS.filter(w => lower.includes(w));
  if (whitelistHits.length > 0) {
    // 命中 whitelist → 強制非拒絕
    return {
      isRefusal: false,
      score: 0,
      category: null,
      matched: [],
      whitelistHits,
    };
  }

  let totalScore = 0;
  const matched: string[] = [];
  const categoryScores = new Map<RefusalCategory, number>();

  for (const pat of REFUSAL_PATTERNS) {
    let hit = false;
    if (pat.re) {
      hit = pat.re.test(text);
    } else if (pat.str) {
      hit = lower.includes(pat.str);
    }
    if (hit) {
      totalScore += pat.weight;
      matched.push(pat.str ?? pat.re!.source);
      const prev = categoryScores.get(pat.category) ?? 0;
      categoryScores.set(pat.category, prev + pat.weight);
    }
  }

  const isRefusal = totalScore >= REFUSAL_THRESHOLD;
  const topCategory = ((): RefusalCategory | null => {
    let best: RefusalCategory | null = null;
    let bestScore = 0;
    for (const [cat, sc] of categoryScores) {
      if (sc > bestScore) { best = cat; bestScore = sc; }
    }
    return best;
  })();

  return { isRefusal, score: totalScore, category: topCategory, matched, whitelistHits: [] };
}

/**
 * 收緊版 choice 偵測：選擇指示詞 + 動作動詞同時出現才計分。
 */
export function detectChoice(text: string): ChoiceVerdict {
  const lower = text.toLowerCase();

  // 先確認有動作動詞
  const hasActionVerb = CHOICE_ACTION_VERBS.some(v => lower.includes(v));
  if (!hasActionVerb) {
    return { isChoice: false, score: 0, matched: [] };
  }

  let score = 0;
  const matched: string[] = [];

  for (const pat of CHOICE_INDICATORS) {
    let hit = false;
    if (pat.re) {
      hit = pat.re.test(text);
    } else if (pat.str) {
      hit = lower.includes(pat.str);
    }
    if (hit) {
      score += pat.weight;
      matched.push(pat.str ?? pat.re!.source);
    }
  }

  // 有動作動詞加 2 分 bonus
  if (score > 0) score += 2;

  return { isChoice: score >= CHOICE_THRESHOLD, score, matched };
}

// ──────────────────────────────────────────────
// Backward-compatible shims（舊呼叫端可直接切換）
// ──────────────────────────────────────────────

export function isRefusalResponse(text: string): boolean {
  return detectRefusal(text).isRefusal;
}

export function isChoiceConfirmation(text: string): boolean {
  return detectChoice(text).isChoice;
}
