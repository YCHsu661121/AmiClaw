/**
 * SystemPromptBuilder
 *
 * 移植自 claude-code `context.ts` 的 system prompt 組裝管線。
 * 把分散的 system 內容（persona / memory / workspace / tool rules）統一為固定管線。
 *
 * 設計原則：
 *   - 每個 section 都是純函式 → 易測試、易選擇性啟用
 *   - 區塊間用清楚的分隔線，方便 model 解析
 *   - 順序固定：persona → policy → memory index → workspace → active file → custom rules
 */

export interface SystemPromptSection {
  /** Section 標題（會用 `## {title}` 包起來） */
  title: string;
  /** Section 內文；空字串會被略過 */
  content: string;
}

export interface BuildSystemPromptInput {
  /** Persona / role definition（最先） */
  persona?: string;
  /** Hard policy rules（如 Atlassian / 不要修改某些檔案） */
  policy?: string;
  /** MEMORY.md index 內容（短期 + 長期記憶索引） */
  memoryIndex?: string;
  /** Workspace 概況（git status, project root, open files 計數等） */
  workspaceSummary?: string;
  /** 當前 active file 摘要 */
  activeFileSummary?: string;
  /** 啟用中的工具規則摘要 */
  toolRules?: string;
  /** 額外自訂 sections（會接在最後） */
  extraSections?: SystemPromptSection[];
}

const SEP = '\n\n---\n\n';

/**
 * 組裝 system prompt：依固定順序拼接，空 section 略過。
 */
export function buildSystemPrompt(input: BuildSystemPromptInput): string {
  const parts: string[] = [];

  if (input.persona?.trim()) {
    parts.push(input.persona.trim());
  }

  if (input.policy?.trim()) {
    parts.push(`## Policy\n\n${input.policy.trim()}`);
  }

  if (input.memoryIndex?.trim()) {
    parts.push(`## Long-term memory index\n\n${input.memoryIndex.trim()}`);
  }

  if (input.workspaceSummary?.trim()) {
    parts.push(`## Workspace\n\n${input.workspaceSummary.trim()}`);
  }

  if (input.activeFileSummary?.trim()) {
    parts.push(`## Active file\n\n${input.activeFileSummary.trim()}`);
  }

  if (input.toolRules?.trim()) {
    parts.push(`## Tool rules\n\n${input.toolRules.trim()}`);
  }

  for (const sec of input.extraSections ?? []) {
    if (sec.content?.trim()) {
      parts.push(`## ${sec.title}\n\n${sec.content.trim()}`);
    }
  }

  return parts.join(SEP);
}

/**
 * 依 token 預算裁切 memoryIndex（避免吃光 system prompt）。
 * 對應 claude-code 的「MEMORY.md 超過 200 行截斷」策略。
 */
export function truncateMemoryIndex(text: string, maxLines = 200): string {
  if (!text) return text;
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  return [
    ...lines.slice(0, maxLines),
    `\n... [memory index truncated, ${lines.length - maxLines} more lines]`,
  ].join('\n');
}
