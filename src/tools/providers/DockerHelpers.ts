// Copyright (c) 2026 YCHsu. All rights reserved.
// Licensed under the MIT License.

import { spawn } from 'child_process';

export function runDockerPython(pyCode: string, dockerImage: string, timeoutMs: number): Promise<string> {
  return new Promise(res => {
    try {
      const proc = spawn('docker', ['run', '--rm', '-i', '--network=host', dockerImage, 'python', '-']);
      let out = '', err = '';
      proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
      proc.stderr.on('data', (d: Buffer) => { err += d.toString(); });
      proc.on('close', () => res((out + (err ? '\n[stderr]\n' + err : '')).trim().slice(0, 10000) || '(無輸出)'));
      proc.on('error', (e: Error) => res(`Docker 錯誤: ${e.message} — 請確認 Docker Desktop 正在執行`));
      const timer = setTimeout(() => { try { proc.kill(); } catch { /* noop */ } res(`逾時 (${timeoutMs}ms)`); }, timeoutMs);
      proc.on('close', () => clearTimeout(timer));
      proc.stdin.write(pyCode, 'utf-8');
      proc.stdin.end();
    } catch (e) { res(`Docker 執行失敗: ${e instanceof Error ? e.message : String(e)}`); }
  });
}

export function runDockerShell(cmd: string, dockerImage: string, timeoutMs: number): Promise<string> {
  return new Promise(res => {
    try {
      const proc = spawn('docker', ['run', '--rm', '--network=host', dockerImage, 'sh', '-c', cmd]);
      let out = '', err = '';
      proc.stdout.on('data', (d: Buffer) => { out += d.toString(); if ((out + err).length > 512000) { try { proc.kill(); } catch { /* noop */ } } });
      proc.stderr.on('data', (d: Buffer) => { err += d.toString(); });
      proc.on('close', () => {
        const r = (out + (err ? '\n[stderr]\n' + err : '')).trim();
        res((r.length > 10000 ? r.slice(0, 10000) + '\n…（已截斷）' : r) || '(無輸出)');
      });
      proc.on('error', (e: Error) => res(`Docker 錯誤: ${e.message} — 請確認 Docker Desktop 正在執行且已拉取影像`));
      const timer = setTimeout(() => { try { proc.kill(); } catch { /* noop */ } res(`逾時 (${timeoutMs}ms)`); }, timeoutMs);
      proc.on('close', () => clearTimeout(timer));
    } catch (e) { res(`Docker 執行失敗: ${e instanceof Error ? e.message : String(e)}`); }
  });
}
