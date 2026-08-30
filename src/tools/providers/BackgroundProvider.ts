// Copyright (c) 2026 YCHsu. All rights reserved.
// Licensed under the MIT License.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import type { IToolProvider, ToolExecutionContext } from './IToolProvider';

interface BgTask {
  id: string;
  command: string;
  cwd?: string;
  status: 'running' | 'completed' | 'failed' | 'killed';
  pid?: number;
  exitCode?: number;
  outputPath: string;
  startedAt: number;
  endedAt?: number;
  proc?: ChildProcess;
  stream: fs.WriteStream;
}

// Module-level store — tasks persist across tool calls within a VS Code session
const _tasks = new Map<string, BgTask>();
let _seq = 0;

const TOOLS = new Set(['run_in_background', 'bg_task_status', 'bg_task_read', 'bg_task_kill']);

export class BackgroundProvider implements IToolProvider {
  readonly tools: ReadonlySet<string> = TOOLS;

  execute(name: string, args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
    switch (name) {
      case 'run_in_background': return this._run(args, ctx);
      case 'bg_task_status':    return this._status(args);
      case 'bg_task_read':      return this._read(args);
      case 'bg_task_kill':      return this._kill(args);
      default: return Promise.resolve(`BackgroundProvider: unknown "${name}"`);
    }
  }

  private async _run(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
    const command = String(args.command ?? '').trim();
    if (!command) return 'command 為必填';

    const wsRoot = (vscode.workspace.workspaceFolders ?? [])[0]?.uri.fsPath ?? process.cwd();
    const rawCwd = args.cwd as string;
    const cwd = rawCwd
      ? (path.isAbsolute(rawCwd) ? rawCwd : path.join(wsRoot, rawCwd))
      : wsRoot;

    const allowed = await ctx.requestPermission('shell', `背景執行: ${command}`, 'run_in_background');
    if (!allowed) return '使用者已拒絕執行操作';

    const taskId = `bg-${Date.now().toString(36)}-${++_seq}`;
    const outputDir = path.join(wsRoot, '.amiclaw', 'outputs');
    fs.mkdirSync(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, `${taskId}.txt`);
    const stream = fs.createWriteStream(outputPath, { flags: 'w' });

    const isWin = process.platform === 'win32';
    const proc = spawn(isWin ? 'cmd' : 'sh', isWin ? ['/c', command] : ['-c', command], {
      cwd, stdio: ['ignore', 'pipe', 'pipe'],
    });

    const task: BgTask = {
      id: taskId, command, cwd, pid: proc.pid,
      status: 'running', startedAt: Date.now(),
      outputPath, stream, proc,
    };
    _tasks.set(taskId, task);

    proc.stdout?.on('data', (d: Buffer) => stream.write(d));
    proc.stderr?.on('data', (d: Buffer) => stream.write(`[stderr] ${d}`));
    proc.on('close', (code) => {
      task.status = code === 0 ? 'completed' : 'failed';
      task.exitCode = code ?? undefined;
      task.endedAt = Date.now();
      stream.end();
    });
    proc.on('error', (err) => {
      task.status = 'failed';
      task.endedAt = Date.now();
      stream.write(`\n[error] ${err.message}\n`);
      stream.end();
    });

    return JSON.stringify({ taskId, pid: proc.pid, command, outputPath, status: 'running' });
  }

  private async _status(args: Record<string, unknown>): Promise<string> {
    const taskId = String(args.task_id ?? '').trim();

    if (!taskId) {
      const list = Array.from(_tasks.values()).map(t => ({
        id: t.id, command: t.command.slice(0, 70), status: t.status,
        pid: t.pid, exitCode: t.exitCode,
        elapsed: _elapsed(t),
      }));
      return list.length ? JSON.stringify(list, null, 2) : '無背景任務';
    }

    const task = _tasks.get(taskId);
    if (!task) return `找不到任務 ${taskId}`;

    let preview = '（尚無輸出）';
    try {
      const content = fs.readFileSync(task.outputPath, 'utf8');
      const lines = content.split('\n');
      preview = lines.slice(-80).join('\n').slice(0, 3000);
    } catch { /* file may not exist yet */ }

    return JSON.stringify({
      taskId: task.id, command: task.command, status: task.status,
      pid: task.pid, exitCode: task.exitCode, elapsed: _elapsed(task),
      outputPath: task.outputPath, outputPreview: preview,
    }, null, 2);
  }

  private async _read(args: Record<string, unknown>): Promise<string> {
    const taskId = String(args.task_id ?? '').trim();
    if (!taskId) return 'task_id 為必填';
    const task = _tasks.get(taskId);
    if (!task) return `找不到任務 ${taskId}`;

    try {
      const content = fs.readFileSync(task.outputPath, 'utf8');
      const lines = content.split('\n');
      const tail   = Number(args.tail ?? 0);
      const start  = Math.max(0, Number(args.start_line ?? 1) - 1);
      const end    = args.end_line ? Math.min(lines.length, Number(args.end_line)) : lines.length;

      const result = tail > 0 ? lines.slice(-tail) : lines.slice(start, end);
      const header = `[${taskId} | ${task.status} | ${lines.length} 行 | 顯示 L${start + 1}–${start + result.length}]\n`;
      return header + result.join('\n');
    } catch {
      return `（輸出檔案尚未建立，任務狀態: ${task.status}）`;
    }
  }

  private async _kill(args: Record<string, unknown>): Promise<string> {
    const taskId = String(args.task_id ?? '').trim();
    if (!taskId) return 'task_id 為必填';
    const task = _tasks.get(taskId);
    if (!task) return `找不到任務 ${taskId}`;
    if (task.status !== 'running') return `任務 ${taskId} 已結束（${task.status}）`;

    try {
      task.proc?.kill('SIGTERM');
      task.status = 'killed';
      task.endedAt = Date.now();
      task.stream.end();
      return `✅ 任務 ${taskId} 已終止（PID ${task.pid}）`;
    } catch (e) {
      return `終止失敗：${e instanceof Error ? e.message : String(e)}`;
    }
  }
}

function _elapsed(t: BgTask): string {
  const ms = (t.endedAt ?? Date.now()) - t.startedAt;
  return t.endedAt
    ? `${(ms / 1000).toFixed(1)}s`
    : `${(ms / 1000).toFixed(1)}s (running)`;
}
