import { scanMemoryFiles } from './memoryScan';
import * as fs from 'fs/promises';

export interface SelectedMemory { path: string; excerpt: string; mtimeMs: number }

/**
 * Very small relevance selector: choose up to `max` most recently modified files
 * that contain any keyword from queryTokens. Returns excerpt (first 1000 chars).
 */
export async function findRelevantMemories(query: string, max = 5): Promise<SelectedMemory[]> {
  const headers = await scanMemoryFiles(200);
  if (!query || headers.length === 0) return [];
  const tokens = query.toLowerCase().split(/\W+/).filter(Boolean).slice(0, 10);
  const scored: Array<{ h: typeof headers[0]; score: number }> = [];
  for (const h of headers) {
    try {
      const raw = await fs.readFile(h.path, 'utf8');
      const text = raw.toLowerCase();
      let score = 0;
      for (const t of tokens) { if (text.includes(t)) score += 1; }
      // recency bonus: +3 today → +0 after 3+ days (newer files preferred)
      const daysSince = (Date.now() - h.mtimeMs) / (1000 * 60 * 60 * 24);
      if (daysSince < 3) score += Math.round(3 - daysSince);
      if (score > 0) scored.push({ h, score });
    } catch { /* ignore */ }
  }
  // return empty rather than injecting files with no content match
  if (scored.length === 0) return [];
  scored.sort((a,b)=>b.score - a.score || b.h.mtimeMs - a.h.mtimeMs);
  const out: SelectedMemory[] = [];
  for (const s of scored.slice(0, max)) {
    try {
      const raw = await fs.readFile(s.h.path, 'utf8');
      out.push({ path: s.h.path, excerpt: raw.slice(0, 1000), mtimeMs: s.h.mtimeMs });
    } catch { }
  }
  return out;
}

export default { findRelevantMemories };
