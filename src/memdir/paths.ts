import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';

function sanitizeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}

export function getMemoryBaseDir(): string {
  const cfg = vscode.workspace.getConfiguration('amiAiClaw');
  const overrideSetting = cfg.get<string>('memoryDir') ?? '';
  const env = process.env['AMICLAW_MEMORY_BASE'] || process.env['CLAUDE_COWORK_MEMORY_PATH_OVERRIDE'];
  if (overrideSetting && overrideSetting.trim()) return path.resolve(overrideSetting);
  if (env && env.trim()) return path.resolve(env);
  return path.join(os.homedir(), '.amiclaw');
}

export function getWorkspaceMemoryDir(): string | null {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) return null;

  // Prefer workspace folder that corresponds to active editor (multi-root friendly)
  const active = vscode.window.activeTextEditor?.document.uri;
  let chosenRoot: string | undefined;
  if (active) {
    const wf = vscode.workspace.getWorkspaceFolder(active);
    if (wf) chosenRoot = wf.uri.fsPath;
  }
  // fallback to workspaceFolders[0]
  if (!chosenRoot) chosenRoot = folders[0].uri.fsPath;
  if (!chosenRoot) return null;

  // prefer a workspace-local memory directory under the chosen workspace root
  return path.join(chosenRoot, '.amiclaw', 'memory');
}

export function getDefaultMemoryDir(): string {
  // prefer workspace-scoped memory dir when possible
  const w = getWorkspaceMemoryDir();
  if (w) return w;
  return path.join(getMemoryBaseDir(), 'global', 'memory');
}

export function validateMemoryPath(p: string): boolean {
  if (!p) return false;
  // reject root-like paths
  const normalized = path.resolve(p);
  if (normalized === path.parse(normalized).root) return false;
  if (normalized.includes('\0')) return false;
  return true;
}

export default {
  getMemoryBaseDir,
  getWorkspaceMemoryDir,
  getDefaultMemoryDir,
  validateMemoryPath,
};
