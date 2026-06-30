/**
 * Memory types & frontmatter
 *
 * 移植自 claude-code `memdir/memoryTypes.ts`。
 * 定義四種記憶分類與 frontmatter 範例，供 extractMemories 與 MEMORY.md 索引使用。
 */

export type MemoryType = 'fact' | 'preference' | 'pattern' | 'context';

export const MEMORY_TYPE_VALUES: readonly MemoryType[] = ['fact', 'preference', 'pattern', 'context'];

export interface MemoryFrontmatter {
  type: MemoryType;
  title: string;
  tags?: string[];
  /** ISO date */
  created?: string;
  /** ISO date */
  updated?: string;
}

export const MEMORY_TYPE_DESCRIPTIONS: Record<MemoryType, string> = {
  fact: '技術事實 / 規則 / constraint（例：「此專案 ESLint 用 X 規則」）',
  preference: '使用者偏好 / 格式要求（例：「回覆用繁體中文」「不要產 emoji」）',
  pattern: '常見解法 / 工作流（例：「build 失敗先看 Build.log 最後 50 行」）',
  context: '專案背景 / 架構（例：「`ollama-chat.ts` 是 god class，正在拆分中」）',
};

export const MEMORY_FRONTMATTER_EXAMPLE = [
  '---',
  'type: fact | preference | pattern | context',
  'title: One short descriptive title',
  'tags: [tag1, tag2]',
  'created: 2026-01-01',
  'updated: 2026-01-15',
  '---',
  '',
  '# Title',
  '',
  'Body content here. Keep it short and info-dense — bullet points preferred.',
];

export const WHAT_NOT_TO_SAVE = [
  '不要儲存：',
  '- 任何單次任務的執行細節（屬於 transcript，不屬於 memory）',
  '- 模型可從程式碼即時讀出的事實（重複的、低價值的）',
  '- 暫時性錯誤訊息、單次 build log',
  '- 包含密碼 / token / 機密的內容',
];

/**
 * 從 markdown 檔內容解析 frontmatter（簡化版，不引入 yaml lib）。
 */
export function parseMemoryFrontmatter(content: string): { meta: Partial<MemoryFrontmatter>; body: string } {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: content };

  const meta: Partial<MemoryFrontmatter> = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (!kv) continue;
    const key = kv[1];
    const val = kv[2].trim();
    if (key === 'type' && MEMORY_TYPE_VALUES.includes(val as MemoryType)) {
      meta.type = val as MemoryType;
    } else if (key === 'title') {
      meta.title = val.replace(/^["']|["']$/g, '');
    } else if (key === 'tags') {
      meta.tags = val.replace(/[[\]]/g, '').split(',').map(s => s.trim()).filter(Boolean);
    } else if (key === 'created' || key === 'updated') {
      meta[key] = val;
    }
  }
  return { meta, body: m[2] };
}

/**
 * 序列化 frontmatter 為 markdown 字串。
 */
export function stringifyMemoryFrontmatter(meta: MemoryFrontmatter, body: string): string {
  const lines = ['---', `type: ${meta.type}`, `title: ${meta.title}`];
  if (meta.tags && meta.tags.length > 0) lines.push(`tags: [${meta.tags.join(', ')}]`);
  if (meta.created) lines.push(`created: ${meta.created}`);
  if (meta.updated) lines.push(`updated: ${meta.updated}`);
  lines.push('---', '', body.trim(), '');
  return lines.join('\n');
}
