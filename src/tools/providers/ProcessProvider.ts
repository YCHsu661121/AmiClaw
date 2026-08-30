// Copyright (c) 2026 YCHsu. All rights reserved.
// Licensed under the MIT License.

import * as vscode from 'vscode';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { runDockerPython, runDockerShell } from './DockerHelpers';
import type { IToolProvider, ToolExecutionContext } from './IToolProvider';

const TOOLS = new Set(['run_terminal', 'run_command', 'run_python']);

const OUTPUT_PERSIST_THRESHOLD = 16 * 1024; // persist to disk when output exceeds 16 KB

/** When output exceeds threshold, save to .amiclaw/outputs/ and return preview + path. */
function _persistIfLarge(out: string, prefix: string, wsRoot: string): string {
  if (out.length <= OUTPUT_PERSIST_THRESHOLD) return out;
  const dir = path.join(wsRoot, '.amiclaw', 'outputs');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const fname = `${prefix}_${Date.now().toString(36)}.txt`;
    const fpath = path.join(dir, fname);
    fs.writeFileSync(fpath, out, 'utf8');
    const lines = out.split('\n').length;
    return (
      out.slice(0, 4000) +
      `\n\n…[輸出已持久化至磁碟，共 ${out.length} 字元 / ${lines} 行]\n` +
      `路徑: ${fpath}\n` +
      `讀取方式: read_file_smart(path="${fpath}", tail=100) 或指定 start_line/end_line`
    );
  } catch {
    return out.slice(0, 8000) + '\n…（輸出過長已截斷）';
  }
}

export class ProcessProvider implements IToolProvider {
  readonly tools: ReadonlySet<string> = TOOLS;

  execute(name: string, args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
    const wsRoot = (vscode.workspace.workspaceFolders ?? [])[0]?.uri.fsPath ?? process.cwd();
    const cwd    = (args.cwd as string)
      ? (path.isAbsolute(args.cwd as string) ? (args.cwd as string) : path.join(wsRoot, args.cwd as string))
      : wsRoot;
    switch (name) {
      case 'run_terminal': return this._terminal(args, cwd, ctx);
      case 'run_command':  return this._command(args, cwd, ctx);
      case 'run_python':   return this._python(args, wsRoot, ctx);
      default: return Promise.resolve(`ProcessProvider: unknown tool "${name}"`);
    }
  }

  private async _terminal(args: Record<string, unknown>, cwd: string, ctx: ToolExecutionContext): Promise<string> {
    const cmd = args.command as string;
    const allowed = await ctx.requestPermission('run', `終端機執行: ${cmd}`, 'run_terminal');
    if (!allowed) return '使用者已拒絕執行操作';
    const cfg = vscode.workspace.getConfiguration('amiAiClaw');
    if (cfg.get<boolean>('sandboxUseDocker', false)) {
      return runDockerShell(cmd, cfg.get<string>('sandboxDockerImage', 'ubuntu:24.04'), 125000);
    }
    const terminals = vscode.window.terminals;
    const terminal  = terminals.length > 0 ? terminals[terminals.length - 1] : vscode.window.createTerminal('Agent');
    terminal.show(true);
    terminal.sendText(cmd);
    return new Promise<string>(resolve => {
      exec(cmd, { cwd, timeout: 120_000, shell: true as unknown as string, maxBuffer: 4 * 1024 * 1024 }, (_err, stdout, stderr) => {
        const out = (stdout || '') + (stderr ? `\n[stderr]\n${stderr}` : '');
        const t = out.trim();
        resolve(t.length > 10000 ? t.slice(0, 10000) + '\n…（已截斷至 10KB）' : t || '(無輸出)');
      });
    });
  }

  private async _command(args: Record<string, unknown>, cwd: string, ctx: ToolExecutionContext): Promise<string> {
    const cmd = args.command as string;
    const allowed = await ctx.requestPermission('run', `執行指令: ${cmd}`, 'run_command');
    if (!allowed) return '使用者已拒絕執行操作';
    const cfg = vscode.workspace.getConfiguration('amiAiClaw');
    if (cfg.get<boolean>('sandboxUseDocker', false)) {
      return runDockerShell(cmd, cfg.get<string>('sandboxDockerImage', 'ubuntu:24.04'), 35000);
    }
    const wsRoot = (vscode.workspace.workspaceFolders ?? [])[0]?.uri.fsPath ?? process.cwd();
    return new Promise<string>(resolve => {
      const unixCmdPattern = /^(find|grep|ls|cat|wc|head|tail|awk|sed|chmod|which|touch|mkdir|rm|cp|mv|echo|sort|uniq|xargs|cut|tr|diff|tar|curl|wget)\s/;
      const shellOpt = (process.platform === 'win32' && unixCmdPattern.test(cmd.trim())) ? 'powershell.exe' : true;
      exec(cmd, { cwd, timeout: 30000, shell: shellOpt as unknown as string }, (_err, stdout, stderr) => {
        const out = (stdout || '') + (stderr ? `\n[stderr]\n${stderr}` : '');
        resolve(_persistIfLarge(out.trim() || '(無輸出)', 'cmd', wsRoot));
      });
    });
  }

  private async _python(args: Record<string, unknown>, wsRoot: string, ctx: ToolExecutionContext): Promise<string> {
    const pyCode = (args.code as string || '').trim();
    if (!pyCode) return '請提供 code 參數';
    const isDestructive = /os\.remove|os\.rmdir|shutil\.rmtree|shutil\.move|open\s*\(.*['"]w['"]|open\s*\(.*['"]a['"]|Path.*\.unlink|Path.*\.rmdir|copyfile|shutil\.copy/i.test(pyCode);
    const cfg = vscode.workspace.getConfiguration('amiAiClaw');
    if (cfg.get<boolean>('sandboxUseDocker', false)) {
      const img = cfg.get<string>('sandboxDockerImage', 'ubuntu:24.04');
      return runDockerPython(pyCode, img.includes('python') ? img : 'python:3.12-slim', 35000);
    }
    if (isDestructive) {
      const desc = (args.description as string || pyCode.split('\n')[0]).slice(0, 120);
      const allowed = await ctx.requestPermission('run', `Python（含檔案操作）: ${desc}`, 'run_python');
      if (!allowed) return '使用者已拒絕執行操作';
    }
    const tmpFile = path.join(os.tmpdir(), `ami_ai_claw_py_${Date.now()}.py`);
    let raw = '';
    try {
      fs.writeFileSync(tmpFile, pyCode, 'utf-8');
      raw = await new Promise<string>(resolve => {
        const cmds = process.platform === 'win32' ? ['py', 'python', 'python3'] : ['python3', 'python'];
        let tried = 0;
        const tryNext = () => {
          if (tried >= cmds.length) { resolve('錯誤：找不到 Python 執行環境，請確認已安裝 Python 3'); return; }
          const c = cmds[tried++];
          exec(`${c} "${tmpFile}"`, { cwd: wsRoot, timeout: 30000 }, (_err, stdout, stderr) => {
            if (_err && (_err as NodeJS.ErrnoException).code === 'ENOENT') { tryNext(); return; }
            const out = (stdout || '') + (stderr ? (stdout ? '\n[stderr]\n' : '[stderr]\n') + stderr : '');
            resolve(out.trim() || '（無輸出）');
          });
        };
        tryNext();
      });
    } finally { try { fs.unlinkSync(tmpFile); } catch { /* ignore */ } }
    return _persistIfLarge(raw, 'py', wsRoot);
  }
}
