import * as fs from 'fs/promises';
import * as path from 'path';
import memdir from './memdir';

export interface MemoryHeader { path: string; mtimeMs: number; summary?: string }

export async function scanMemoryFiles(limit = 200): Promise<MemoryHeader[]> {
  const files = await memdir.listMemoryFiles();
  const results: MemoryHeader[] = [];
  for (const f of files) {
    try {
      const stat = await fs.stat(f);
      results.push({ path: f, mtimeMs: stat.mtimeMs });
    } catch {}
  }
  results.sort((a,b)=>b.mtimeMs - a.mtimeMs);
  return results.slice(0, limit);
}

export default { scanMemoryFiles };
