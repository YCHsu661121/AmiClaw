// Copyright (c) 2026 YCHsu. All rights reserved.
// Licensed under the MIT License.

import * as vscode from 'vscode';
import { exec } from 'child_process';
import type { IToolProvider, ToolExecutionContext } from './IToolProvider';

const TOOLS = new Set(['git_status', 'git_diff', 'git_log', 'git_commit']);

export class GitProvider implements IToolProvider {
  readonly tools: ReadonlySet<string> = TOOLS;

  execute(name: string, args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
    const wsRoot = (vscode.workspace.workspaceFolders ?? [])[0]?.uri.fsPath ?? process.cwd();
    switch (name) {
      case 'git_status':  return this._status(args, wsRoot);
      case 'git_diff':    return this._diff(args, wsRoot);
      case 'git_log':     return this._log(args, wsRoot);
      case 'git_commit':  return this._commit(args, wsRoot, ctx);
      default: return Promise.resolve(`GitProvider: unknown tool "${name}"`);
    }
  }

  private _status(args: Record<string, unknown>, wsRoot: string): Promise<string> {
    const cwd = (args.path as string)
      ? (require('path') as typeof import('path')).resolve(args.path as string)
      : wsRoot;
    return new Promise(resolve => {
      exec('git status', { cwd, timeout: 10000 }, (_err, stdout, stderr) =>
        resolve((stdout || stderr || '（無輸出）').trim().slice(0, 8000)));
    });
  }

  private _diff(args: Record<string, unknown>, wsRoot: string): Promise<string> {
    const staged = (args.staged as boolean) ? '--cached ' : '';
    const file   = (args.file as string) || '';
    const cmd    = ('git diff ' + staged + file).trim();
    return new Promise(resolve => {
      exec(cmd, { cwd: wsRoot, timeout: 15000 }, (_err, stdout, stderr) =>
        resolve(((stdout || stderr || '').trim() || '（無變更）').slice(0, 16000)));
    });
  }

  private _log(args: Record<string, unknown>, wsRoot: string): Promise<string> {
    const count = Math.min(Number(args.count || 20), 100);
    const file  = (args.file as string) ? ('-- ' + args.file) : '';
    const cmd   = ('git log --oneline -' + count + ' ' + file).trim();
    return new Promise(resolve => {
      exec(cmd, { cwd: wsRoot, timeout: 10000 }, (_err, stdout, stderr) =>
        resolve((stdout || stderr || '（無歷史）').trim().slice(0, 8000)));
    });
  }

  private async _commit(
    args: Record<string, unknown>,
    wsRoot: string,
    ctx: ToolExecutionContext,
  ): Promise<string> {
    const msg = ((args.message as string) || '').trim();
    if (!msg) return '請提供 commit message';
    const allowed = await ctx.requestPermission('run', `Git Commit: ${msg}`, 'git_commit');
    if (!allowed) return '使用者已拒絕 git commit 操作';
    const safeMsg = msg.replace(/"/g, '\\"');
    const addAll  = (args.add_all as boolean) !== false;
    const cmd     = addAll
      ? `git add -A && git commit -m "${safeMsg}"`
      : `git commit -m "${safeMsg}"`;
    return new Promise(resolve => {
      exec(cmd, { cwd: wsRoot, timeout: 30000, shell: true as unknown as string }, (_err, stdout, stderr) => {
        const out = (stdout || '') + (stderr ? (stdout ? '\n[stderr]\n' : '[stderr]\n') + stderr : '');
        resolve((out.trim() || '（無輸出）').slice(0, 4000));
      });
    });
  }
}
