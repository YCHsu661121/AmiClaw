import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import paths from './paths';

const INDEX_NAME = 'MEMORY.md';

export async function ensureMemoryDirExists(): Promise<string> {
  const dir = paths.getDefaultMemoryDir();
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (e) {
    // ignore, rethrow only if fatal
  }
  return dir;
}

export async function readMemoryIndex(): Promise<string> {
  // Prefer workspace-scoped memory index when available.
  const wsDir = paths.getWorkspaceMemoryDir();
  if (wsDir) {
    const wp = path.join(wsDir, INDEX_NAME);
    try {
      const b = await fs.readFile(wp, 'utf8');
      return b;
    } catch (e) {
      // if workspace dir missing index, fallthrough to check global/base dir
    }
  }

  // fallback to base/global memory dir
  const dir = paths.getDefaultMemoryDir();
  const p = path.join(dir, INDEX_NAME);
  try {
    const b = await fs.readFile(p, 'utf8');
    // if we have a workspace dir available, migrate the index there for future reads
    if (wsDir) {
      try {
        await fs.mkdir(wsDir, { recursive: true });
        await fs.writeFile(path.join(wsDir, INDEX_NAME), b, 'utf8');
      } catch {
        // ignore migration errors
      }
    }
    return b;
  } catch (e) {
    return '';
  }
}

export async function saveMemoryIndex(text: string): Promise<void> {
  const dir = await ensureMemoryDirExists();
  const p = path.join(dir, INDEX_NAME);
  await fs.writeFile(p, text, 'utf8');
}

export async function listMemoryFiles(): Promise<string[]> {
  // Prefer workspace-scoped memory files when present
  const wsDir = paths.getWorkspaceMemoryDir();
  if (wsDir) {
    try {
      const items = await fs.readdir(wsDir, { withFileTypes: true });
      return items.filter(i => i.isFile() && i.name.endsWith('.md')).map(i => path.join(wsDir, i.name));
    } catch (e) {
      // fallthrough to default dir
    }
  }
  const dir = paths.getDefaultMemoryDir();
  try {
    const items = await fs.readdir(dir, { withFileTypes: true });
    return items.filter(i => i.isFile() && i.name.endsWith('.md')).map(i => path.join(dir, i.name));
  } catch (e) {
    return [];
  }
}

export async function migrateGlobalIndexToWorkspace(): Promise<{ migrated: boolean; details?: string }> {
  const wsDir = paths.getWorkspaceMemoryDir();
  if (!wsDir) return { migrated: false, details: 'no-workspace' };

  // legacy location under memory base: /projects/{projectId}/memory
  const wsRoot = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]?.uri.fsPath;
  if (!wsRoot) return { migrated: false, details: 'no-workspace-root' };
  const projectId = wsRoot ? wsRoot.split(/[\\/]/).pop()?.replace(/[^a-zA-Z0-9._-]/g, '_') : 'unknown';
  const legacyDir = path.join(paths.getMemoryBaseDir(), 'projects', projectId || 'unknown', 'memory');

  try {
    const existing = await fs.readdir(legacyDir, { withFileTypes: true }).catch(() => []);
    if (!existing || existing.length === 0) return { migrated: false, details: 'no-legacy-files' };
    await fs.mkdir(wsDir, { recursive: true }).catch(() => null);
    let copied = 0;
    for (const e of existing) {
      if (!e.isFile() || !e.name.endsWith('.md')) continue;
      const src = path.join(legacyDir, e.name);
      const dest = path.join(wsDir, e.name);
      try {
        const b = await fs.readFile(src, 'utf8');
        await fs.writeFile(dest, b, 'utf8');
        copied++;
      } catch {
        // ignore individual failures
      }
    }
    return { migrated: copied > 0, details: `copied:${copied}` };
  } catch (e) {
    return { migrated: false, details: String(e) };
  }
}

export default {
  ensureMemoryDirExists,
  readMemoryIndex,
  saveMemoryIndex,
  listMemoryFiles,
  loadRulesLayer,
};

const RULES_NAME = 'RULES.md';

/**
 * 載入「規則層」——每次請求必常注入的專案規範 / 編碼規則 / flow 描述。
 * 搜尋順序： workspace/.amiclaw/RULES.md → ~/.amiclaw/RULES.md
 */
export async function loadRulesLayer(): Promise<string> {
  // 1. 各工作區根目錄 .amiclaw/RULES.md
  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of folders) {
    const candidate = path.join(folder.uri.fsPath, '.amiclaw', RULES_NAME);
    try { return (await fs.readFile(candidate, 'utf8')).trim(); } catch { /* 試下一個 */ }
  }
  // 2. 全域： ~/.amiclaw/RULES.md
  try { return (await fs.readFile(path.join(paths.getMemoryBaseDir(), RULES_NAME), 'utf8')).trim(); } catch {}
  return '';
}
