// Copyright (c) 2026 YCHsu. All rights reserved.
// Licensed under the MIT License.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, exec, ChildProcess } from 'child_process';
import type { IToolProvider, ToolExecutionContext } from './IToolProvider';

interface BgTask {
  id: string;
  description: string;
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

const GC_THRESHOLD_MS = 2 * 60 * 60 * 1000; // auto-remove finished tasks after 2h

const TOOLS = new Set(['run_in_background', 'bg_task_status', 'bg_task_read', 'bg_task_kill', 'bg_task_wait']);

export class BackgroundProvider implements IToolProvider {
  readonly tools: ReadonlySet<string> = TOOLS;

  execute(name: string, args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
    switch (name) {
      case 'run_in_background': return this._run(args, ctx);
      case 'bg_task_status':    return this._status(args);
      case 'bg_task_read':      return this._read(args);
      case 'bg_task_kill':      return this._kill(args);
      case 'bg_task_wait':      return this._wait(args);
      default: return Promise.resolve(`BackgroundProvider: unknown "${name}"`);
    }
  }

  private async _run(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
    const command     = String(args.command     ?? '').trim();
    const description = String(args.description ?? command).slice(0, 200);
    if (!command) return 'command 為必填';

    const wsRoot = (vscode.workspace.workspaceFolders ?? [])[0]?.uri.fsPath ?? process.cwd();
    const rawCwd = args.cwd as string;
    const cwd = rawCwd
      ? (path.isAbsolute(rawCwd) ? rawCwd : path.join(wsRoot, rawCwd))
      : wsRoot;

    const allowed = await ctx.requestPermission('shell', `背景執行: ${command}`, 'run_in_background');
    if (!allowed) return '使用者已拒絕執行操作';

    return _spawnTask(command, description, cwd, wsRoot);
  }

  private async _status(args: Record<string, unknown>): Promise<string> {
    _gc();
    const taskId = String(args.task_id ?? '').trim();

    if (!taskId) {
      const list = Array.from(_tasks.values()).map(t => ({
        id: t.id, description: t.description, command: t.command.slice(0, 70),
        status: t.status, pid: t.pid, exitCode: t.exitCode, elapsed: _elapsed(t),
        outputSizeBytes: _fileSize(t.outputPath),
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
      taskId: task.id, description: task.description, command: task.command,
      status: task.status, pid: task.pid, exitCode: task.exitCode,
      elapsed: _elapsed(task), outputPath: task.outputPath,
      outputSizeBytes: _fileSize(task.outputPath), outputPreview: preview,
    }, null, 2);
  }

  private async _read(args: Record<string, unknown>): Promise<string> {
    const taskId = String(args.task_id ?? '').trim();
    if (!taskId) return 'task_id 為必填';
    const task = _tasks.get(taskId);
    if (!task) return `找不到任務 ${taskId}`;

    try {
      // Byte-offset delta mode: reads a slice starting at from_offset, up to max_bytes.
      // Supports paging through GB-level output without loading the whole file.
      const fromOffset = args.from_offset !== undefined ? Math.max(0, Number(args.from_offset)) : undefined;
      if (fromOffset !== undefined) {
        const MAX_DELTA = 8 * 1024 * 1024; // 8 MB safety cap
        const maxBytes  = Math.min(MAX_DELTA, Math.max(1024, Number(args.max_bytes ?? MAX_DELTA)));
        const stat  = fs.statSync(task.outputPath);
        const total = stat.size;
        const start = Math.min(fromOffset, total);
        const len   = Math.min(maxBytes, total - start);
        const buf   = Buffer.alloc(len);
        const fd    = fs.openSync(task.outputPath, 'r');
        try { fs.readSync(fd, buf, 0, len, start); } finally { fs.closeSync(fd); }
        const content   = buf.toString('utf8');
        const newOffset = start + len;
        const hasMore   = newOffset < total;
        const omitted   = start > 0 ? `[前 ${Math.round(start / 1024)}KB 已略過]\n` : '';
        const trailer   = hasMore ? `\n[下一批: from_offset=${newOffset}, 剩餘 ${Math.round((total - newOffset) / 1024)}KB]` : '\n[已到檔案尾端]';
        return `[${taskId} | ${task.status} | 位元組 ${start}–${newOffset}/${total}]\n${omitted}${content}${trailer}`;
      }

      // Line-based mode (backward compatible)
      const content = fs.readFileSync(task.outputPath, 'utf8');
      const lines = content.split('\n');
      const tail  = Number(args.tail ?? 0);
      const start = Math.max(0, Number(args.start_line ?? 1) - 1);
      const end   = args.end_line ? Math.min(lines.length, Number(args.end_line)) : lines.length;
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
      _killProcess(task);
      task.status = 'killed';
      task.endedAt = Date.now();
      task.stream.end();
      return `✅ 任務 ${taskId} 已終止（PID ${task.pid}）`;
    } catch (e) {
      return `終止失敗：${e instanceof Error ? e.message : String(e)}`;
    }
  }

  /** Waits for a running task to finish (polling), then returns tail output. */
  private async _wait(args: Record<string, unknown>): Promise<string> {
    const taskId   = String(args.task_id ?? '').trim();
    const timeoutMs = Math.min(300_000, Math.max(1000, Number(args.timeout_ms ?? 30_000)));
    const tailLines = Math.max(1, Number(args.tail ?? 100));
    if (!taskId) return 'task_id 為必填';

    const task = _tasks.get(taskId);
    if (!task) return `找不到任務 ${taskId}`;

    if (task.status !== 'running') {
      // Already done — just return output
      return this._read({ task_id: taskId, tail: tailLines });
    }

    const deadline = Date.now() + timeoutMs;
    const POLL_MS = 250;
    await new Promise<void>(resolve => {
      const poll = () => {
        if (task.status !== 'running' || Date.now() >= deadline) { resolve(); return; }
        setTimeout(poll, POLL_MS);
      };
      setTimeout(poll, POLL_MS);
    });

    if (task.status === 'running') {
      const sizKb = Math.round(_fileSize(task.outputPath) / 1024);
      return `⏱️ 等待超時（${timeoutMs / 1000}s），任務仍在執行中。\n輸出: ${sizKb}KB，可用 bg_task_read(task_id="${taskId}", tail=${tailLines}) 繼續查看，或 bg_task_kill 中止。`;
    }

    return this._read({ task_id: taskId, tail: tailLines });
  }
}

/** Internal helper: spawn a process and register it. Returns the JSON init message. */
export function _spawnTask(command: string, description: string, cwd: string, wsRoot: string): string {
  const taskId    = `bg-${Date.now().toString(36)}-${++_seq}`;
  const outputDir = path.join(wsRoot, '.amiclaw', 'outputs');
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `${taskId}.txt`);
  const stream     = fs.createWriteStream(outputPath, { flags: 'w' });

  const isWin = process.platform === 'win32';
  const proc  = spawn(isWin ? 'cmd' : 'sh', isWin ? ['/c', command] : ['-c', command], {
    cwd, stdio: ['ignore', 'pipe', 'pipe'],
  });

  const task: BgTask = {
    id: taskId, description, command, cwd, pid: proc.pid,
    status: 'running', startedAt: Date.now(), outputPath, stream, proc,
  };
  _tasks.set(taskId, task);

  proc.stdout?.on('data', (d: Buffer) => stream.write(d));
  proc.stderr?.on('data', (d: Buffer) => stream.write(`[stderr] ${d}`));
  proc.on('close', (code) => {
    task.status = code === 0 ? 'completed' : 'failed';
    task.exitCode = code ?? undefined;
    task.endedAt  = Date.now();
    stream.end();
  });
  proc.on('error', (err) => {
    task.status  = 'failed';
    task.endedAt = Date.now();
    stream.write(`\n[error] ${err.message}\n`);
    stream.end();
  });

  return JSON.stringify({ taskId, pid: proc.pid, description, command, outputPath, status: 'running' });
}

/** Kill a process and its children. On Windows uses taskkill /F /T. */
function _killProcess(task: BgTask): void {
  if (!task.proc || task.pid === undefined) return;
  if (process.platform === 'win32') {
    exec(`taskkill /F /T /PID ${task.pid}`, () => { /* ignore */ });
  } else {
    try { process.kill(-task.pid, 'SIGTERM'); } catch { task.proc.kill('SIGTERM'); }
  }
}

function _fileSize(filePath: string): number {
  try { return fs.statSync(filePath).size; } catch { return 0; }
}

function _gc(): void {
  const now = Date.now();
  for (const [id, t] of _tasks) {
    if (t.status !== 'running' && t.endedAt && now - t.endedAt > GC_THRESHOLD_MS) {
      _tasks.delete(id);
    }
  }
}

function _elapsed(t: BgTask): string {
  const ms = (t.endedAt ?? Date.now()) - t.startedAt;
  return t.endedAt
    ? `${(ms / 1000).toFixed(1)}s`
    : `${(ms / 1000).toFixed(1)}s (running)`;
}

