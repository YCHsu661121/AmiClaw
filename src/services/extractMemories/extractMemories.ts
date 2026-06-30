/**
 * extractMemories
 *
 * 移植自 claude-code `services/extractMemories/extractMemories.ts` 的長期記憶抽取機制。
 *
 * 觸發時機：每次完整 query loop 結束（model 輸出無 tool call）後在背景執行。
 * 行為：
 *   1. 取得最近 N 則訊息作為來源
 *   2. 讀 MEMORY.md 索引避免重複
 *   3. 用 LLM caller（注入）精煉成 fact/preference/pattern/context 四類記憶
 *   4. 每條記憶寫獨立 .md 檔（含 frontmatter）
 *   5. 更新 MEMORY.md 索引（每行 < 150 字）
 *
 * 若未注入 LLM caller，會退回成「快照寫檔」的舊行為（向後相容）。
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import memdir from '../../memdir/memdir';
import {
  MEMORY_TYPE_VALUES,
  MEMORY_TYPE_DESCRIPTIONS,
  stringifyMemoryFrontmatter,
  type MemoryType,
} from '../../memdir/memoryTypes';

const MIN_INTERVAL_MS = 30 * 1000;
const MAX_INDEX_LINES = 200;
const MAX_INDEX_LINE_LENGTH = 150;
const MAX_SOURCE_CHARS = 20_000;

let lastExtractionTs = 0;
let extractionInProgress = false;

// ============================================================================
// LLM caller 介面（與 provider 解耦）
// ============================================================================

export interface ExtractedMemoryItem {
  type: MemoryType;
  title: string;
  /** kebab-case filename without extension（slug） */
  slug: string;
  body: string;
  tags?: string[];
  /** 索引中的一行摘要（用於 MEMORY.md），< 150 字 */
  oneLineHook: string;
}

export interface MemoryExtractCaller {
  extract: (input: {
    sourceText: string;
    existingIndex: string;
    extractPrompt: string;
  }) => Promise<ExtractedMemoryItem[]>;
}

export function buildExtractPrompt(existingIndex: string): string {
  const typeBlock = MEMORY_TYPE_VALUES
    .map(t => `- **${t}** — ${MEMORY_TYPE_DESCRIPTIONS[t]}`)
    .join('\n');

  const indexBlock = existingIndex.trim().length > 0
    ? `\n\n## Existing memory index\n\n${existingIndex.trim()}\n\nCheck this list before creating new memories — prefer updating an existing entry over duplicating.`
    : '';

  return `You are the memory extraction subagent for AmiClaw.

Analyze the conversation snippet provided and extract any durable, reusable knowledge worth remembering across future sessions.

## Four memory types

${typeBlock}

## What to extract

- User preferences (language, format, tooling choices)
- Project facts that won't change quickly (architecture, key files, conventions)
- Workflow patterns that worked (commands, procedures, debugging steps)
- Constraints / rules the user mentioned

## What NOT to extract

- One-off task details (those belong in transcript)
- Trivial facts the model can re-derive from code
- Temporary error messages or single build logs
- Anything containing secrets, tokens, passwords${indexBlock}

## Output format

Reply with a single JSON array. Each element is one memory:

\`\`\`json
[
  {
    "type": "fact | preference | pattern | context",
    "title": "Short distinctive title (5-10 words)",
    "slug": "kebab-case-filename-no-ext",
    "tags": ["tag1", "tag2"],
    "oneLineHook": "One-line hook < 150 chars for MEMORY.md index",
    "body": "The actual memory body. Markdown. Bullet points preferred. Info-dense."
  }
]
\`\`\`

If nothing worth saving, reply with: \`[]\`
Do not wrap in any other text — just the JSON array.`;
}

// ============================================================================
// 主流程
// ============================================================================

export interface ExtractMemoriesOptions {
  caller?: MemoryExtractCaller;
  ignoreInterval?: boolean;
}

export interface ExtractMemoriesResult {
  written: string[];
  updatedIndex: boolean;
  fallback: boolean;
}

export async function executeExtractMemories(
  shortTermText: string,
  options: ExtractMemoriesOptions = {}
): Promise<ExtractMemoriesResult | null> {
  if (!shortTermText || shortTermText.trim().length === 0) return null;

  const now = Date.now();
  if (extractionInProgress) return null;
  if (!options.ignoreInterval && now - lastExtractionTs < MIN_INTERVAL_MS) return null;

  extractionInProgress = true;
  try {
    const dir = await memdir.ensureMemoryDirExists();
    const source = shortTermText.slice(0, MAX_SOURCE_CHARS);

    if (!options.caller) {
      // Fallback：無 LLM 時直接寫快照（向後相容舊行為）
      const name = `auto-${Date.now()}.md`;
      const p = path.join(dir, name);
      const body = `Source snapshot: ${new Date().toISOString()}\n\n${source}`;
      const meta = {
        type: 'context' as MemoryType,
        title: 'Auto-extracted snapshot',
        created: new Date().toISOString().slice(0, 10),
      };
      await fs.writeFile(p, stringifyMemoryFrontmatter(meta, body), 'utf8');
      lastExtractionTs = Date.now();
      return { written: [p], updatedIndex: false, fallback: true };
    }

    const existingIndex = await memdir.readMemoryIndex();
    const prompt = buildExtractPrompt(existingIndex);

    let items: ExtractedMemoryItem[] = [];
    try {
      items = await options.caller.extract({
        sourceText: source,
        existingIndex,
        extractPrompt: prompt,
      });
    } catch {
      lastExtractionTs = Date.now();
      return { written: [], updatedIndex: false, fallback: true };
    }

    if (items.length === 0) {
      lastExtractionTs = Date.now();
      return { written: [], updatedIndex: false, fallback: false };
    }

    const written: string[] = [];
    const today = new Date().toISOString().slice(0, 10);
    for (const item of items) {
      if (!MEMORY_TYPE_VALUES.includes(item.type)) continue;
      const safeSlug = sanitizeSlug(item.slug || item.title);
      if (!safeSlug) continue;
      const filename = `${safeSlug}.md`;
      const filepath = path.join(dir, filename);

      const existed = await fileExists(filepath);
      const meta: {
        type: MemoryType;
        title: string;
        tags?: string[];
        created?: string;
        updated: string;
      } = {
        type: item.type,
        title: item.title.slice(0, 200),
        tags: item.tags?.slice(0, 10),
        created: existed ? undefined : today,
        updated: today,
      };
      if (existed) {
        try {
          const old = await fs.readFile(filepath, 'utf8');
          const created = old.match(/^created:\s*(.+)$/m)?.[1]?.trim();
          if (created) meta.created = created;
        } catch { /* ignore */ }
      }
      await fs.writeFile(
        filepath,
        stringifyMemoryFrontmatter(meta as Required<Pick<typeof meta, 'type' | 'title' | 'updated'>> & typeof meta, item.body.trim()),
        'utf8'
      );
      written.push(filepath);
    }

    const updatedIndex = await updateMemoryIndex(items, existingIndex);
    lastExtractionTs = Date.now();
    return { written, updatedIndex, fallback: false };
  } catch {
    return null;
  } finally {
    extractionInProgress = false;
  }
}

// ============================================================================
// Helpers
// ============================================================================

function sanitizeSlug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\w\- ]+/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80);
}

async function fileExists(p: string): Promise<boolean> {
  try { await fs.stat(p); return true; } catch { return false; }
}

async function updateMemoryIndex(
  newItems: ExtractedMemoryItem[],
  existingIndex: string
): Promise<boolean> {
  try {
    const existingLines = existingIndex.split('\n');
    const seen = new Set<string>();
    for (const line of existingLines) {
      const m = line.match(/\[.*?\]\(([\w\-.]+)\)/);
      if (m) seen.add(m[1]);
    }

    const newLines: string[] = [];
    for (const it of newItems) {
      const slug = sanitizeSlug(it.slug || it.title);
      if (!slug) continue;
      const filename = `${slug}.md`;
      if (seen.has(filename)) continue;
      const hook = it.oneLineHook.replace(/\s+/g, ' ').slice(0, MAX_INDEX_LINE_LENGTH);
      newLines.push(`- [${it.title}](${filename}) — ${hook}`);
    }

    if (newLines.length === 0) return false;

    const header = existingLines.length > 0 && existingIndex.trim().length > 0
      ? existingIndex.trimEnd() + '\n'
      : '# Memory Index\n\n';
    let combined = header + newLines.join('\n') + '\n';

    const lines = combined.split('\n');
    if (lines.length > MAX_INDEX_LINES) {
      combined = lines.slice(0, MAX_INDEX_LINES).join('\n') + '\n';
    }
    await memdir.saveMemoryIndex(combined);
    return true;
  } catch {
    return false;
  }
}

export default { executeExtractMemories, buildExtractPrompt };
