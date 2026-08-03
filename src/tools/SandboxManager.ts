// Copyright (c) 2026 YCHsu. All rights reserved.
// Licensed under the MIT License.

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execSync } from 'child_process';
import type {
  ISandboxManager, SandboxVerifyResult,
  ShadowFileEntry, ShadowWorkspaceState,
} from './SandboxTypes';

/** 需要路徑映射的工具參數鍵 */
const PATH_KEYS = ['path', 'src', 'dest', 'new_path', 'db_path', 'file', 'output', 'output_dir'];

/** 寫入類工具（需要在 shadow 模式下攔截）*/
export const SHADOW_WRITE_TOOLS = new Set([
  'write_file', 'replace_in_file', 'insert_in_file', 'replace_all_in_file',
  'batch_replace', 'rename_file', 'copy_file', 'delete_file', 'create_dir',
  'todo_write', 'memory_write',
]);

export class SandboxManager implements ISandboxManager {
  private _state: ShadowWorkspaceState = { status: 'idle', shadowDir: '', files: [] };
  private _wsRoot = '';

  // 🛠️ [DEMO] 模擬修改標記
  // 🛠️ [DEMO] 模擬修改標記
  constructor(
    private readonly _postToWebview: (msg: object) => void,
    private readonly _log: (msg: string) => void,
  ) {}

  // ── ISandboxManager ────────────────────────────────────────────────────────

  isActive(): boolean {
    return this._state.status !== 'idle'
      && this._state.status !== 'committed'
      && this._state.status !== 'rolled_back';
  }

  getState(): ShadowWorkspaceState {
    return { ...this._state, files: [...this._state.files] };
  }

  initShadow(sessionId: string): void {
    if (this.isActive()) { this.rollback(); }
    this._wsRoot = (vscode.workspace.workspaceFolders ?? [])[0]?.uri.fsPath ?? process.cwd();
    const shadowDir = path.join(os.tmpdir(), `ami-shadow-${sessionId}-${Date.now()}`);
    fs.mkdirSync(shadowDir, { recursive: true });
    this._state = { status: 'staging', shadowDir, files: [] };
    this._notify();
    this._log(`[Shadow] 初始化影子工作區: ${shadowDir}`);
  }

  mapToShadow(originalPath: string): string {
    const rel = path.isAbsolute(originalPath)
      ? path.relative(this._wsRoot, originalPath)
      : originalPath;
    return path.join(this._state.shadowDir, rel);
  }

  recordChange(entry: Omit<ShadowFileEntry, 'verified'>): void {
    const full: ShadowFileEntry = { ...entry, verified: false };
    const idx = this._state.files.findIndex(f => f.original === entry.original);
    if (idx >= 0) this._state.files[idx] = full;
    else this._state.files.push(full);
    this._state.status = 'staging';
    this._notify();
  }

  async verify(): Promise<SandboxVerifyResult> {
    if (!this.isActive() || this._state.files.length === 0) {
      return { passed: false, output: '影子區無待驗證檔案', errors: [] };
    }
    this._state.status = 'verifying';
    this._notify();

    const errors: SandboxVerifyResult['errors'] = [];
    let output = '';

    // 1. 確認影子檔案都存在
    for (const f of this._state.files) {
      if (f.op !== 'delete' && !fs.existsSync(f.shadow)) {
        errors.push({ file: f.original, message: `影子檔案不存在: ${f.shadow}` });
      }
    }

    // 2. TypeScript 檢查（僅針對 .ts / .tsx 檔案）
    const tsFiles = this._state.files.filter(f =>
      f.op !== 'delete' && (f.original.endsWith('.ts') || f.original.endsWith('.tsx'))
    );
    if (tsFiles.length > 0 && errors.length === 0) {
      const filePaths = tsFiles.map(f => `"${f.shadow}"`).join(' ');
      try {
        execSync(`tsc --noEmit --allowJs --skipLibCheck ${filePaths}`, { timeout: 30000, cwd: this._wsRoot });
        output += '✅ TypeScript 語法檢查通過\n';
        tsFiles.forEach(f => { f.verified = true; });
      } catch (e) {
        // 同時擷取 stdout + stderr，不截斷，完整寫入 log
        const err = e as { stdout?: Buffer | string; stderr?: Buffer | string };
        const toStr = (v: Buffer | string | undefined) =>
          v ? (Buffer.isBuffer(v) ? v.toString('utf8') : String(v)) : '';
        const fullOutput = [toStr(err.stdout), toStr(err.stderr)]
          .filter(Boolean).join('\n').trim()
          || (e instanceof Error ? e.message : String(e));
        output += `❌ TypeScript 錯誤:\n${fullOutput.slice(0, 4000)}${
          fullOutput.length > 4000 ? `\n…（共 ${fullOutput.length} 字，已截斷前 4000）` : ''}\n`;
        this._log(`[Shadow] tsc 完整輸出:\n${fullOutput}`);  // log 不截斷
        const lineRe = /(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)/g;
        let m: RegExpExecArray | null;
        while ((m = lineRe.exec(fullOutput)) !== null) {
          errors.push({ file: m[1], message: `${m[4]}: ${m[5]}`, line: Number(m[2]) });
        }
      }
    }

    const passed = errors.length === 0;
    this._state.verifyPassed = passed;
    this._state.verifyOutput = output + (errors.length > 0 ? `\n${errors.map(e => `  - ${path.basename(e.file)}:${e.line ?? ''} ${e.message}`).join('\n')}` : '');
    this._state.status = passed ? 'ready_to_commit' : 'staging';
    this._notify();
    return { passed, output: this._state.verifyOutput, errors };
  }

  async commit(): Promise<string[]> {
    const committed: string[] = [];
    for (const entry of this._state.files) {
      try {
        if (entry.op === 'delete') {
          fs.rmSync(entry.original, { force: true });
        } else {
          fs.mkdirSync(path.dirname(entry.original), { recursive: true });
          fs.copyFileSync(entry.shadow, entry.original);
        }
        committed.push(entry.original);
        this._postToWebview({ type: 'fileModified', filePath: entry.original, op: entry.op, ts: Date.now() });
        this._log(`[Shadow] ✅ 提交: ${entry.original}`);
      } catch (e) {
        this._log(`[Shadow] ❌ 提交失敗 ${entry.original}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    this._state.status = 'committed';
    this._notify();
    // 清理暫存區
    setTimeout(() => this._cleanup(), 3000);
    return committed;
  }

  rollback(): void {
    this._log(`[Shadow] 回滾影子工作區: ${this._state.shadowDir}`);
    this._cleanup();
    this._state = { status: 'rolled_back', shadowDir: '', files: [] };
    this._notify();
    setTimeout(() => {
      this._state = { status: 'idle', shadowDir: '', files: [] };
      this._notify();
    }, 2000);
  }

  // ── 路徑攔截（供 ToolExecutor 呼叫）────────────────────────────────────────

  /**
   * 接管工具呼叫：重寫 args 中的路徑指向影子區，
   * 執行後記錄變更。回傳影子化後的 args（供下游 provider 使用）。
   */
  remapArgs(
    toolName: string,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    const remapped: Record<string, unknown> = { ...args };
    for (const key of PATH_KEYS) {
      if (typeof remapped[key] === 'string' && remapped[key]) {
        const orig = remapped[key] as string;
        const shadow = this.mapToShadow(orig);
        // 確保影子目錄存在
        fs.mkdirSync(path.dirname(shadow), { recursive: true });
        // 若是讀類路徑且原始檔案存在但影子不存在，先複製過去（copy-on-write）
        if (fs.existsSync(orig) && !fs.existsSync(shadow)) {
          try { fs.copyFileSync(orig, shadow); } catch { /* ignore */ }
        }
        remapped[key] = shadow;
      }
    }
    // 記錄此次變更：每個工具明確定義哪些路徑鍵對映成哪种 op，覆蓋單一鍵取値的疑義
    const toolRecords: Record<string, Array<{ key: string; op: ShadowFileEntry['op'] }>> = {
      write_file:          [{ key: 'path', op: 'write' }],
      replace_in_file:     [{ key: 'path', op: 'replace' }],
      insert_in_file:      [{ key: 'path', op: 'insert' }],
      replace_all_in_file: [{ key: 'path', op: 'replace' }],
      batch_replace:       [{ key: 'path', op: 'replace' }],
      rename_file:         [{ key: 'src', op: 'delete' }, { key: 'dest', op: 'write' }],
      copy_file:           [{ key: 'dest', op: 'write' }],
      delete_file:         [{ key: 'path', op: 'delete' }],
      todo_write:          [{ key: 'path', op: 'write' }],
      memory_write:        [{ key: 'path', op: 'write' }],
      create_dir:          [{ key: 'path', op: 'write' }],
    };
    for (const { key, op } of toolRecords[toolName] ?? []) {
      const rawPath = args[key] as string | undefined;
      if (!rawPath) continue;
      const originalPath = path.isAbsolute(rawPath) ? rawPath : path.join(this._wsRoot, rawPath);
      this.recordChange({ original: originalPath, shadow: this.mapToShadow(originalPath), op });
    }
    return remapped;
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private _cleanup(): void {
    try {
      if (this._state.shadowDir && fs.existsSync(this._state.shadowDir)) {
        fs.rmSync(this._state.shadowDir, { recursive: true, force: true });
      }
    } catch { /* ignore cleanup errors */ }
  }

  private _notify(): void {
    this._postToWebview({ type: 'shadowStateUpdate', state: this.getState() });
  }
}
