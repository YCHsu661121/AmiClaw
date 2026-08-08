// Copyright (c) 2026 YCHsu. All rights reserved.
// Licensed under the MIT License.

import * as vscode from 'vscode';
import * as path from 'path';
import type { IToolProvider, ToolExecutionContext } from './IToolProvider';
import type { ToolPermissionDiff } from '../ToolPolicies';

// ── computeUnifiedDiff (moved from ToolExecutor top-level) ────────────────────
function computeUnifiedDiff(aLines: string[], bLines: string[], fileA: string, fileB: string, contextLines: number): string {
  const m = aLines.length, n = bLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) dp[i][j] = aLines[i-1] === bLines[j-1] ? dp[i-1][j-1]+1 : Math.max(dp[i-1][j], dp[i][j-1]);
  type Edit = { op: ' '|'-'|'+'; line: string; ai: number; bi: number };
  const edits: Edit[] = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && aLines[i-1] === bLines[j-1]) { edits.push({ op: ' ', line: aLines[i-1], ai: i, bi: j }); i--; j--; }
    else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) { edits.push({ op: '+', line: bLines[j-1], ai: i, bi: j }); j--; }
    else { edits.push({ op: '-', line: aLines[i-1], ai: i, bi: j }); i--; }
  }
  edits.reverse();
  const changed = new Set(edits.map((e, idx) => e.op !== ' ' ? idx : -1).filter(x => x >= 0));
  if (changed.size === 0) return '';
  const inHunk = new Set<number>();
  for (const c of changed) for (let k = Math.max(0, c-contextLines); k <= Math.min(edits.length-1, c+contextLines); k++) inHunk.add(k);
  const lines: string[] = [`--- ${fileA}`, `+++ ${fileB}`];
  let inBlock = false, aStart = 0, bStart = 0, aCount = 0, bCount = 0;
  const hunkLines: string[] = [];
  const flushHunk = () => { if (hunkLines.length) { lines.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`); lines.push(...hunkLines); hunkLines.length = 0; inBlock = false; } };
  let aIdx = 1, bIdx = 1;
  for (let k = 0; k < edits.length; k++) {
    const e = edits[k];
    if (inHunk.has(k)) {
      if (!inBlock) { flushHunk(); aStart = aIdx; bStart = bIdx; aCount = 0; bCount = 0; inBlock = true; }
      hunkLines.push(e.op + e.line);
      if (e.op !== '+') { aCount++; aIdx++; }
      if (e.op !== '-') { bCount++; bIdx++; }
    } else { if (inBlock) flushHunk(); if (e.op !== '+') aIdx++; if (e.op !== '-') bIdx++; }
  }
  flushHunk();
  return lines.join('\n');
}

function computeDiffStatsAndPatch(
  before: string, after: string, filePath: string, maxPatchBytes = 6000
): { linesAdded: number; linesRemoved: number; patch: string } {
  const aLines = before.split(/\r?\n/);
  const bLines = after.split(/\r?\n/);
  if (aLines.length + bLines.length > 4000) {
    return { linesAdded: Math.max(0, bLines.length - aLines.length), linesRemoved: Math.max(0, aLines.length - bLines.length), patch: '' };
  }
  const baseName = path.basename(filePath);
  let patch = computeUnifiedDiff(aLines, bLines, baseName, baseName, 3);
  if (patch.length > maxPatchBytes) { patch = patch.slice(0, maxPatchBytes) + '\n…（截斷）'; }
  const pLines = patch.split('\n');
  const linesAdded = pLines.filter(l => l.startsWith('+') && !l.startsWith('+++')).length;
  const linesRemoved = pLines.filter(l => l.startsWith('-') && !l.startsWith('---')).length;
  return { linesAdded, linesRemoved, patch };
}

const FS_TOOLS = new Set([
  'get_active_file','read_file','read_file_smart','grep_file','read_files',
  'write_file','replace_in_file','insert_in_file','replace_all_in_file','batch_replace',
  'glob','outline_file','todo_write','memory_read','memory_write',
  'rename_file','copy_file','diff_files','file_info',
  'list_dir','delete_file','create_dir','read_workspace',
]);

export class FileSystemProvider implements IToolProvider {
  readonly tools: ReadonlySet<string> = FS_TOOLS;

  execute(name: string, args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
    switch (name) {
      case 'get_active_file':      return Promise.resolve(this._getActiveFile());
      case 'read_file':            return this._readFile(args, ctx);
      case 'read_file_smart':      return this._readFileSmart(args, ctx);
      case 'grep_file':            return this._grepFile(args, ctx);
      case 'read_files':           return this._readFiles(args, ctx);
      case 'write_file':           return this._writeFile(args, ctx);
      case 'replace_in_file':      return this._replaceInFile(args, ctx);
      case 'insert_in_file':       return this._insertInFile(args, ctx);
      case 'replace_all_in_file':  return this._replaceAllInFile(args, ctx);
      case 'batch_replace':        return this._batchReplace(args, ctx);
      case 'glob':                 return this._glob(args, ctx);
      case 'outline_file':         return this._outlineFile(args, ctx);
      case 'todo_write':           return this._todoWrite(args, ctx);
      case 'memory_read':          return this._memoryRead(args, ctx);
      case 'memory_write':         return this._memoryWrite(args, ctx);
      case 'rename_file':          return this._renameFile(args, ctx);
      case 'copy_file':            return this._copyFile(args, ctx);
      case 'diff_files':           return this._diffFiles(args, ctx);
      case 'file_info':            return this._fileInfo(args, ctx);
      case 'list_dir':             return this._listDir(args, ctx);
      case 'delete_file':          return this._deleteFile(args, ctx);
      case 'create_dir':           return this._createDir(args, ctx);
      case 'read_workspace':       return this._readWorkspace(args, ctx);
      default: return Promise.resolve(`FileSystemProvider: unknown tool "${name}"`);
    }
  }

  // ── get_active_file ──────────────────────────────────────────────────────────
  private _getActiveFile(): string {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return '沒有開啟的檔案';
    return `檔案: ${editor.document.uri.fsPath}\n\n${editor.document.getText()}`;
  }

  // ── read_file ────────────────────────────────────────────────────────────────
  private async _readFile(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
    const fpath = await ctx.resolvePathSmart(args.path as string);
    const rfKey = `rf:${fpath}`;
    const cached = ctx.cache.get(rfKey);
    if (cached !== undefined) return cached;
    let stat: vscode.FileStat;
    try { stat = await vscode.workspace.fs.stat(vscode.Uri.file(fpath)); } catch { return `錯誤：找不到檔案 ${fpath}`; }
    const MAX_BYTES = 5 * 1024 * 1024;
    const LOG_SMART = 64 * 1024;
    const ext = fpath.split('.').pop()?.toLowerCase() ?? '';
    const isLog = ['log','txt','out','err','bld','build','trace'].includes(ext);
    const LOG_PAT = 'error:|Error:|ERROR|warning:|Warning:|WARNING|fatal:|Fatal:|FATAL|fail:|FAIL|FAILED|BUILD FAILURE|BUILD ERROR|assert|Assert|ASSERT|exception|Exception|EXCEPTION|undefined reference|cannot find|unresolved|Unresolved|ld returned|undefined symbol|Traceback|SyntaxError|TypeError|ReferenceError|ImportError|ModuleNotFoundError|abort|Abort|ABORT|crash|Crash|panic|Panic|PANIC|segfault|Segmentation fault|signal [0-9]|No such file|Permission denied|Access denied|not found';
    if (stat.size > MAX_BYTES) {
      const sizeMb = (stat.size/1024/1024).toFixed(1);
      if (isLog) {
        const [tail, errs] = await Promise.all([ctx.executeTool('read_file_smart',{path:args.path,tail:300,max_kb:96}), ctx.executeTool('read_file_smart',{path:args.path,pattern:LOG_PAT,context_lines:5,max_kb:128})]);
        return `⚠️ 檔案過大（${sizeMb} MB），自動分兩段回傳——\n\n【全檔錯誤/警告點（含前後 5 行 context）】\n${errs}\n\n【尾端 300 行（最終執行結果）】\n${tail}`;
      }
      return `⚠️ 檔案過大（${sizeMb} MB），自動回傳前 300 行：\n${await ctx.executeTool('read_file_smart',{path:args.path,head:300,max_kb:64})}`;
    }
    if (isLog && stat.size > LOG_SMART) {
      const sizeKb = (stat.size/1024).toFixed(0);
      const [errs, tail] = await Promise.all([ctx.executeTool('read_file_smart',{path:args.path,pattern:LOG_PAT,context_lines:5,max_kb:128}), ctx.executeTool('read_file_smart',{path:args.path,tail:100,max_kb:64})]);
      return `📋 Log 分析模式（${sizeKb} KB）——先掃描各式錯誤點，再補尾端執行結果\n\n【錯誤 / 警告點（含前後 5 行 context）】\n${errs}\n\n【尾端 100 行（執行結果）】\n${tail}`;
    }
    const text = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(fpath))).toString('utf8');
    const result = text.length > 50000 ? text.slice(0, 50000) + '\n…（已截斷至 50KB）' : text;
    if (text.length <= 10000) ctx.cache.set(rfKey, result);
    return result;
  }

  // ── read_file_smart ──────────────────────────────────────────────────────────
  private async _readFileSmart(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
    const fpath = await ctx.resolvePathSmart(args.path as string);
    const pattern   = args.pattern    ? String(args.pattern)   : null;
    const startLine = args.start_line ? Math.max(1, Number(args.start_line)) : null;
    const endLine   = args.end_line   ? Math.max(1, Number(args.end_line))   : null;
    const head      = args.head       ? Math.max(1, Number(args.head))       : null;
    const tail      = args.tail       ? Math.max(1, Number(args.tail))       : null;
    const ctxLines  = args.context_lines ? Math.max(0, Number(args.context_lines)) : 0;
    const maxKb     = args.max_kb     ? Math.max(1, Math.min(512, Number(args.max_kb))) : 128;
    try {
      const nodefs   = require('fs') as typeof import('fs');
      const readline = require('readline') as typeof import('readline');
      let stat: import('fs').Stats;
      try { stat = nodefs.statSync(fpath); } catch { return `錯誤：找不到檔案 ${fpath}`; }
      const fileSizeMb = (stat.size/1024/1024).toFixed(1);
      const regex = pattern ? new RegExp(pattern, 'i') : null;
      const maxBytes = maxKb * 1024;
      const matched: Array<{lineNo:number;text:string;isContext?:boolean}> = [];
      const ring: string[] = [];
      const pendingCtx = new Set<number>();
      let totalLines = 0;
      await new Promise<void>((resolve, reject) => {
        const rl = readline.createInterface({ input: nodefs.createReadStream(fpath, {encoding:'utf8'}), crlfDelay: Infinity });
        let lineNo = 0; let outBytes = 0; let collecting = true;
        let tailBuf: string[] = tail ? [] : [];
        rl.on('line', (line: string) => {
          lineNo++;
          if (!collecting) return;
          if (tail) { tailBuf.push(line); if (tailBuf.length > tail) tailBuf.shift(); return; }
          if (head && lineNo > head) { collecting = false; return; }
          if (startLine && lineNo < startLine) { if (ctxLines > 0) { ring.push(line); if (ring.length > ctxLines) ring.shift(); } return; }
          if (endLine && lineNo > endLine) { collecting = false; return; }
          const isMatch = regex ? regex.test(line) : true;
          if (isMatch) {
            if (ctxLines > 0 && regex) {
              for (let ri = 0; ri < ring.length; ri++) { const cn = lineNo-ring.length+ri; if (!matched.find(m=>m.lineNo===cn)) matched.push({lineNo:cn,text:ring[ri],isContext:true}); }
              ring.length = 0;
              for (let j = 1; j <= ctxLines; j++) pendingCtx.add(lineNo+j);
            }
            matched.push({lineNo,text:line});
            outBytes += line.length+1;
            if (outBytes > maxBytes) { collecting = false; return; }
          } else {
            if (pendingCtx.has(lineNo)) { pendingCtx.delete(lineNo); matched.push({lineNo,text:line,isContext:true}); outBytes += line.length+1; }
            if (ctxLines > 0 && regex) { ring.push(line); if (ring.length > ctxLines) ring.shift(); }
          }
        });
        rl.on('close', () => {
          totalLines = lineNo;
          if (tail && tailBuf.length > 0) { const s = lineNo-tailBuf.length+1; tailBuf.forEach((tl,i) => matched.push({lineNo:s+i,text:tl})); }
          resolve();
        });
        rl.on('error', reject);
      });
      const hdr = `📄 ${fpath}  (${fileSizeMb} MB, ${totalLines.toLocaleString()} 行)${pattern?`  pattern="${pattern}"`:''}${startLine?`  lines=${startLine}-${endLine??'∞'}`:''}${head?`  head=${head}`:''}${tail?`  tail=${tail}`:''}  matched=${matched.length} 行\n`;
      if (matched.length === 0) return hdr + '（無匹配行）';
      let totalOut = 0;
      const outputLines = matched.map(m => {
        totalOut += m.text.length+1;
        const pct = totalLines > 0 ? ` (${(m.lineNo*100/totalLines).toFixed(1)}%)` : '';
        return `${m.isContext?'  ':''}${String(m.lineNo).padStart(6)}${pct}: ${m.text}`;
      });
      return hdr + outputLines.join('\n') + (totalOut > maxBytes ? `\n…（已達 ${maxKb}KB 上限）` : '');
    } catch(e) { return `read_file_smart 錯誤：${e instanceof Error ? e.message : String(e)}`; }
  }

  // ── grep_file ─────────────────────────────────────────────────────────────────
  private async _grepFile(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
    const gfPath = await ctx.resolvePathSmart(args.path as string);
    const kws = Array.isArray(args.keywords) ? (args.keywords as unknown[]).map(String).filter(Boolean) : [];
    if (kws.length === 0) return '錯誤：keywords 為空';
    const gfCtx = args.context_lines ? Math.max(0, Number(args.context_lines)) : 3;
    const maxPerKw = args.max_matches_per_kw ? Math.max(1, Number(args.max_matches_per_kw)) : 30;
    const maxKb = args.max_kb ? Math.max(1, Math.min(512, Number(args.max_kb))) : 128;
    const caseSens = args.case_sensitive === true;
    const maxBytes = maxKb * 1024;
    try {
      const nodefs = require('fs') as typeof import('fs');
      const readline = require('readline') as typeof import('readline');
      let stat: import('fs').Stats;
      try { stat = nodefs.statSync(gfPath); } catch { return `錯誤：找不到檔案 ${gfPath}`; }
      const fileSizeMb = (stat.size/1024/1024).toFixed(1);
      const flag = caseSens ? '' : 'i';
      type KwGroup = { kw:string; re:RegExp; matches:Array<{lineNo:number;text:string;isCtx?:boolean}>; totalHits:number; capped:boolean };
      const groups: KwGroup[] = kws.map(kw => ({ kw, re: new RegExp(kw, flag), matches:[], totalHits:0, capped:false }));
      const ring: string[] = [];
      const pendingCtx: Set<number>[] = groups.map(() => new Set<number>());
      let totalFileLines = 0;
      await new Promise<void>((resolve, reject) => {
        const rl = readline.createInterface({ input: nodefs.createReadStream(gfPath, {encoding:'utf8'}), crlfDelay:Infinity });
        let lineNo = 0;
        rl.on('line', (line: string) => {
          lineNo++;
          for (let gi = 0; gi < groups.length; gi++) {
            const g = groups[gi];
            if (pendingCtx[gi].has(lineNo)) { pendingCtx[gi].delete(lineNo); if (!g.re.test(line) && !g.matches.find(m=>m.lineNo===lineNo)) g.matches.push({lineNo,text:line,isCtx:true}); }
            if (g.re.test(line)) {
              g.totalHits++;
              if (!g.capped) {
                if (g.totalHits <= maxPerKw) {
                  if (gfCtx > 0) { const rs = Math.max(0, ring.length-gfCtx); for (let ri = rs; ri < ring.length; ri++) { const cn = lineNo-(ring.length-ri); if (cn>=1 && !g.matches.find(m=>m.lineNo===cn)) g.matches.push({lineNo:cn,text:ring[ri],isCtx:true}); } }
                  const ex = g.matches.findIndex(m=>m.lineNo===lineNo); if (ex!==-1) g.matches.splice(ex,1);
                  g.matches.push({lineNo,text:line,isCtx:false});
                  for (let j = 1; j <= gfCtx; j++) pendingCtx[gi].add(lineNo+j);
                } else { g.capped = true; }
              }
            }
          }
          ring.push(line); if (ring.length > gfCtx+1) ring.shift();
        });
        rl.on('close', () => { totalFileLines = lineNo; resolve(); });
        rl.on('error', reject);
      });
      const allHits = groups.reduce((s,g) => s+g.totalHits, 0);
      const hdr = `📄 ${gfPath}  (${fileSizeMb} MB, ${totalFileLines.toLocaleString()} 行)\n🔍 Keywords: ${kws.map(k=>`"${k}"`).join(', ')}  |  context=${gfCtx}  |  total hits: ${allHits}\n`;
      const sections: string[] = []; let outBytes = hdr.length;
      for (const g of groups) {
        if (outBytes >= maxBytes) { sections.push(`…（已達 ${maxKb}KB 上限）`); break; }
        const sorted = g.matches.sort((a,b)=>a.lineNo-b.lineNo);
        const deduped: typeof sorted = [];
        for (const m of sorted) { if (!deduped.length || deduped[deduped.length-1].lineNo!==m.lineNo) deduped.push(m); else if (!m.isCtx) deduped[deduped.length-1].isCtx=false; }
        const capNote = g.capped ? ` (顯示前 ${maxPerKw}，共 ${g.totalHits} 處)` : ` (${g.totalHits} 處)`;
        let section = `\n━━━ "${g.kw}" ${g.totalHits===0?'— 無匹配':capNote} ━━━\n`;
        if (deduped.length === 0) { section += '（無匹配行）\n'; }
        else {
          const matchNos = deduped.filter(m=>!m.isCtx).map(m=>m.lineNo);
          if (matchNos.length > 0) section += `   📍 分布位置：${matchNos.map(n=>`${(n*100/totalFileLines).toFixed(1)}%`).join(', ')}\n`;
          let prev = -999;
          for (const m of deduped) {
            if (m.lineNo > prev+1 && prev !== -999) section += '   ——\n';
            const pct = totalFileLines > 0 ? ` (${(m.lineNo*100/totalFileLines).toFixed(1)}%)` : '';
            section += `${m.isCtx?'  ':'▶ '}${String(m.lineNo).padStart(6)}${pct}: ${m.text}\n`;
            prev = m.lineNo;
          }
        }
        if (outBytes + section.length > maxBytes) { section = section.slice(0, maxBytes-outBytes) + '\n…（截斷）\n'; }
        sections.push(section); outBytes += section.length;
      }
      return hdr + sections.join('');
    } catch(e) { return `grep_file 錯誤：${e instanceof Error ? e.message : String(e)}`; }
  }

  // ── read_files ───────────────────────────────────────────────────────────────
  private async _readFiles(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
    const rawPaths = Array.isArray(args.paths) ? (args.paths as unknown[]).map(String).filter(Boolean) : [];
    if (rawPaths.length === 0) return '錯誤：paths 為空陣列';
    const MAX_FILES = 30;
    const maxPerKb = Math.max(1, (args.max_per_file_kb as number) || 64) * 1024;
    const maxTotalKb = Math.max(1, (args.max_total_kb as number) || 256) * 1024;
    const truncated = rawPaths.slice(0, MAX_FILES);
    const overflow = rawPaths.length > MAX_FILES ? rawPaths.length - MAX_FILES : 0;
    const parts: string[] = []; let totalBytes = 0; const summary: string[] = [];
    for (const p of truncated) {
      if (totalBytes >= maxTotalKb) { summary.push(`⚠️ 已達總量上限 ${(maxTotalKb/1024)}KB，後續檔案跳過`); break; }
      const fpath = await ctx.resolvePathSmart(p);
      try {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(fpath));
        let text = Buffer.from(bytes).toString('utf8');
        if (text.length > maxPerKb) { text = text.slice(0, maxPerKb) + `\n…（${path.basename(fpath)} 已截斷 ${Math.round(maxPerKb/1024)}KB）`; }
        parts.push(`=== ${fpath} ===\n${text}`);
        totalBytes += text.length;
      } catch { parts.push(`=== ${fpath} ===\n錯誤：找不到或無法讀取`); }
    }
    if (overflow > 0) summary.push(`⚠️ paths 數量超過上限 ${MAX_FILES}，未處理 ${overflow} 個檔案。`);
    return summary.join('\n') + '\n\n' + parts.join('\n');
  }

  // ── write_file ───────────────────────────────────────────────────────────────
  private async _writeFile(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
    const fpath = ctx.resolvePath(args.path as string);
    const content = (args.content as string) ?? '';
    let before = ''; try { before = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(fpath))).toString('utf8'); } catch { /* new file */ }
    const diff: ToolPermissionDiff = { filePath: fpath, before, after: content, mode: 'write' };
    if (!await ctx.requestPermission('write', `寫入檔案: ${path.basename(fpath)}（${content.length} 字元）`, 'write_file', diff)) return '使用者已拒絕寫入操作';
    await vscode.workspace.fs.writeFile(vscode.Uri.file(fpath), Buffer.from(content, 'utf8'));
    ctx.cache.delete(`rf:${fpath}`);
    const wfStats = computeDiffStatsAndPatch(before, content, fpath);
    ctx.callbacks.postToWebview({ type: 'fileModified', filePath: fpath, op: 'write', ts: Date.now(), ...wfStats });
    return `已寫入 ${fpath}（${content.length} 字元）`;
  }

  // ── replace_in_file ──────────────────────────────────────────────────────────
  private async _replaceInFile(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
    const fpath = ctx.resolvePath(args.path as string);
    const original = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(fpath))).toString('utf8');
    const oldStr = args.old_str as string; const newStr = (args.new_str as string) ?? '';
    if (!original.includes(oldStr)) return `錯誤：在 ${fpath} 中找不到指定的字串`;
    const after = original.replace(oldStr, newStr);
    const diff: ToolPermissionDiff = { filePath: fpath, before: original, after, mode: 'replace', oldStr, newStr };
    if (!await ctx.requestPermission('write', `編輯檔案: ${path.basename(fpath)}`, 'replace_in_file', diff)) return '使用者已拒絕編輯操作';
    await vscode.workspace.fs.writeFile(vscode.Uri.file(fpath), Buffer.from(after, 'utf8'));
    ctx.cache.delete(`rf:${fpath}`);
    const rifStats = computeDiffStatsAndPatch(original, after, fpath);
    ctx.callbacks.postToWebview({ type: 'fileModified', filePath: fpath, op: 'replace', ts: Date.now(), ...rifStats });
    return `已更新 ${fpath}`;
  }

  // ── insert_in_file ───────────────────────────────────────────────────────────
  private async _insertInFile(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
    const fpath = ctx.resolvePath(args.path as string);
    const lineNum = Math.max(0, Number(args.line) || 0);
    const content = (args.content as string) ?? '';
    let original: string;
    try { original = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(fpath))).toString('utf8'); } catch { return `錯誤：找不到檔案 ${fpath}`; }
    const lineEnding = original.includes('\r\n') ? '\r\n' : '\n';
    const lines = original.split(/\r?\n/);
    if (lineNum > lines.length) return `錯誤：行號 ${lineNum} 超過檔案總行數 ${lines.length}`;
    const insertLines = content.split(/\r?\n/);
    lines.splice(lineNum, 0, ...insertLines);
    const newContent = lines.join(lineEnding);
    const diff: ToolPermissionDiff = { filePath: fpath, before: original, after: newContent, mode: 'replace', oldStr: '', newStr: content };
    if (!await ctx.requestPermission('write', `插入檔案: ${path.basename(fpath)} 第 ${lineNum} 行後（${insertLines.length} 行）`, 'insert_in_file', diff)) return '使用者已拒絕插入操作';
    await vscode.workspace.fs.writeFile(vscode.Uri.file(fpath), Buffer.from(newContent, 'utf8'));
    ctx.cache.delete(`rf:${fpath}`);
    const ifStats = computeDiffStatsAndPatch(original, newContent, fpath);
    ctx.callbacks.postToWebview({ type: 'fileModified', filePath: fpath, op: 'insert', ts: Date.now(), ...ifStats });
    return `已在 ${fpath} 第 ${lineNum} 行後插入 ${insertLines.length} 行`;
  }

  // ── replace_all_in_file ───────────────────────────────────────────────────────
  private async _replaceAllInFile(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
    const fpath = ctx.resolvePath(args.path as string || '');
    const oldStr = args.old_str as string; const newStr = args.new_str as string;
    if (!fpath || oldStr === undefined) return '請提供 path、old_str、new_str 參數';
    if (!await ctx.requestPermission('write', `全部取代 in ${fpath}: "${oldStr.slice(0,40)}"`, 'replace_all_in_file')) return '使用者已拒絕操作';
    const original = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(fpath))).toString('utf8');
    if (!original.includes(oldStr)) return `找不到字串: "${oldStr.slice(0,60)}" 於 ${fpath}`;
    const count = original.split(oldStr).length - 1;
    const raUpdated = original.split(oldStr).join(newStr);
    await vscode.workspace.fs.writeFile(vscode.Uri.file(fpath), Buffer.from(raUpdated, 'utf8'));
    ctx.cache.delete(`rf:${fpath}`);
    const raStats = computeDiffStatsAndPatch(original, raUpdated, fpath);
    ctx.callbacks.postToWebview({ type: 'fileModified', filePath: fpath, op: 'replace', ts: Date.now(), ...raStats });
    return `已取代 ${count} 處於 ${fpath}`;
  }

  // ── batch_replace ─────────────────────────────────────────────────────────────
  private async _batchReplace(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
    const brPattern = args.pattern as string; const brReplace = args.replace as string;
    const brGlob = (args.include as string) || '**/*';
    const brFlags = ((args.flags as string) || 'g').includes('g') ? (args.flags as string || 'g') : (args.flags as string || 'g') + 'g';
    if (!brPattern || brReplace === undefined) return '請提供 pattern 與 replace 參數';
    if (!await ctx.requestPermission('write', `批次取代: /${brPattern}/ → "${brReplace.slice(0,40)}" (${brGlob})`, 'batch_replace')) return '使用者已拒絕操作';
    let brRe: RegExp; try { brRe = new RegExp(brPattern, brFlags); } catch(e) { return `正規表達式錯誤: ${e}`; }
    const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(ctx.wsRoot, brGlob), '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**}', 2000);
    const results: string[] = []; let total = 0;
    for (const uri of uris) {
      try {
        const original = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
        const updated = original.replace(brRe, brReplace);
        if (updated !== original) {
          await vscode.workspace.fs.writeFile(uri, Buffer.from(updated, 'utf8'));
          ctx.cache.delete(`rf:${uri.fsPath}`);
          const brStats = computeDiffStatsAndPatch(original, updated, uri.fsPath);
          ctx.callbacks.postToWebview({ type: 'fileModified', filePath: uri.fsPath, op: 'replace', ts: Date.now(), ...brStats });
          results.push(`  ${path.relative(ctx.wsRoot, uri.fsPath).replace(/\\/g,'/')}  (${(original.match(new RegExp(brPattern, brFlags)) || []).length} 處)`);
          total++;
        }
      } catch { /* skip binary */ }
    }
    return total === 0 ? `找不到符合的內容 (/${brPattern}/ in ${brGlob})` : `批次取代完成，共修改 ${total} 個檔案:\n${results.join('\n')}`;
  }

  // ── glob ──────────────────────────────────────────────────────────────────────
  private async _glob(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
    const globPattern = (args.pattern as string) || '**/*';
    const globRoot = (args.root as string) ? ctx.resolvePath(args.root as string) : ctx.wsRoot;
    const globLimit = Math.min(Math.max(Number(args.limit) || 200, 1), 5000);
    try {
      const relPattern = path.isAbsolute(globPattern) ? path.relative(globRoot, globPattern) : globPattern;
      const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(globRoot, relPattern), '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**,**/build/**,**/__pycache__/**}', globLimit);
      if (uris.length === 0) return '(no matches)';
      const sorted = uris.map(u => path.relative(globRoot, u.fsPath).replace(/\\/g,'/')).sort();
      return sorted.join('\n') + `\n\n共 ${sorted.length} 個檔案`;
    } catch(e) { return `glob 錯誤: ${e}`; }
  }

  // ── outline_file ──────────────────────────────────────────────────────────────
  private async _outlineFile(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
    const fpath = ctx.resolvePath(args.path as string);
    let bytes: Uint8Array; try { bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(fpath)); } catch { return `錯誤：找不到檔案 ${fpath}`; }
    const text = Buffer.from(bytes).toString('utf8').slice(0, 200_000);
    const lines = text.split('\n'); const ext = path.extname(fpath).toLowerCase();
    const isCLike = ['.c','.h','.cpp','.cc','.cxx'].includes(ext);
    const isUefi  = ['.inf','.dec','.dsc','.fdf'].includes(ext);
    const results: string[] = [];
    if (isUefi) { for (let i = 0; i < lines.length; i++) { const m = /^\[([A-Za-z][\w.]+)\]/.exec(lines[i]); if (m) results.push(`L${i+1}  [${m[1]}]`); } }
    else if (isCLike) {
      const re = /^(?:[A-Z_a-z][\w*]+\s+)+(?:EFIAPI\s+)?(\w+)\s*\(|^typedef\s+.*?(\w+)\s*;|^(?:typedef\s+)?(?:struct|union|enum)\s+(\w+)|^#define\s+(\w+)/;
      for (let i = 0; i < lines.length; i++) { const m = re.exec(lines[i]); if (m) { const n = m[1]||m[2]||m[3]||m[4]; if (n) results.push(`L${i+1}  ${lines[i].trim().slice(0,80)}`); } }
    } else {
      const re = /^\s*(?:export\s+)?(?:(?:async\s+)?function\*?\s+([\w$]+)|class\s+([\w$]+)|interface\s+([\w$]+)|type\s+([\w$]+)\s*(?:<[^>]*>)?\s*=|(?:const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>|def\s+([\w_]+)|func\s+([\w_]+)\s*\(|public\s+(?:static\s+)?\S+\s+([\w_]+)\s*\()/;
      for (let i = 0; i < lines.length; i++) { const m = re.exec(lines[i]); if (m) { const n = m.slice(1).find(Boolean); if (n) results.push(`L${i+1}  ${n}`); } }
    }
    return results.length === 0 ? `${fpath}\n(未偵測到宣告)` : `=== ${path.basename(fpath)} 宣告摘要 (${results.length} 項) ===\n${results.join('\n')}`;
  }

  // ── todo_write ─────────────────────────────────────────────────────────────────
  private async _todoWrite(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
    const item = (args.item as string || '').trim(); if (!item) return '請提供 item 參數';
    const checked = !!(args.checked as boolean);
    const fpath = ctx.resolvePath((args.path as string) || 'TODO.md');
    let text = ''; try { text = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(fpath))).toString('utf8'); } catch { text = '# TODO\n'; }
    const unc = `- [ ] ${item}`, chk = `- [x] ${item}`, target = checked ? chk : unc;
    let updated = text;
    if (text.includes(unc) && checked) updated = text.replace(unc, chk);
    else if (!text.includes(target)) updated = text.trimEnd() + `\n${target}\n`;
    else return `無需更改 ${fpath}`;
    await vscode.workspace.fs.writeFile(vscode.Uri.file(fpath), Buffer.from(updated, 'utf8'));
    ctx.cache.delete(`rf:${fpath}`);
    const twStats = computeDiffStatsAndPatch(text, updated, fpath);
    ctx.callbacks.postToWebview({ type: 'fileModified', filePath: fpath, op: 'write', ts: Date.now(), ...twStats });
    return `已更新 ${fpath}: ${target}`;
  }

  // ── memory_read ───────────────────────────────────────────────────────────────
  private async _memoryRead(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
    const fpath = ctx.resolvePath((args.path as string) || 'MEMORY.md');
    try { return Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(fpath))).toString('utf8'); } catch { return `(MEMORY.md 不存在於 ${fpath})`; }
  }

  // ── memory_write ──────────────────────────────────────────────────────────────
  private async _memoryWrite(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
    const title = (args.title as string || '').trim(); const content = (args.content as string || '').trim();
    const action = (args.action as string || 'append'); const fpath = ctx.resolvePath((args.path as string) || 'MEMORY.md');
    if (!title && action !== 'replace') return '請提供 title 參數';
    let text = ''; try { text = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(fpath))).toString('utf8'); } catch { text = '# Memory\n'; }
    const ts = new Date().toISOString().slice(0, 10);
    let updated = text;
    if (action === 'delete') { updated = text.replace(new RegExp(`## ${title.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}[\\s\\S]*?(?=\n## |$)`, 'g'), '').replace(/\n{3,}/g, '\n\n'); }
    else if (action === 'replace') { updated = `# Memory\n${content}\n`; }
    else {
      const entry = `\n## ${title}\n> ${ts}\n\n${content}\n`;
      if (!text.includes(`## ${title}`)) updated = text.trimEnd() + entry;
      else { const re = new RegExp(`(## ${title.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')})[\\s\\S]*?(?=\n## |$)`); updated = text.replace(re, `$1\n> ${ts}\n\n${content}\n`); }
    }
    await vscode.workspace.fs.writeFile(vscode.Uri.file(fpath), Buffer.from(updated, 'utf8'));
    ctx.cache.delete(`rf:${fpath}`);
    const mwStats = computeDiffStatsAndPatch(text, updated, fpath);
    ctx.callbacks.postToWebview({ type: 'fileModified', filePath: fpath, op: 'write', ts: Date.now(), ...mwStats });
    return `已更新記憶：${fpath}（${action}）`;
  }

  // ── rename_file ───────────────────────────────────────────────────────────────
  private async _renameFile(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
    const src = ctx.resolvePath(args.src as string || args.path as string || '');
    const dst = ctx.resolvePath(args.dest as string || args.new_path as string || '');
    if (!src || !dst) return '請提供 src 與 dest 參數';
    if (!await ctx.requestPermission('write', `重新命名: ${src} → ${dst}`, 'rename_file')) return '使用者已拒絕操作';
    try { await vscode.workspace.fs.rename(vscode.Uri.file(src), vscode.Uri.file(dst), { overwrite: !!(args.overwrite as boolean) }); ctx.cache.delete(`rf:${src}`); ctx.cache.delete(`rf:${dst}`); ctx.callbacks.postToWebview({ type: 'fileModified', filePath: dst, op: 'rename', ts: Date.now() }); return `已重新命名: ${src} → ${dst}`; } catch(e) { return `rename_file 錯誤: ${e}`; }
  }

  // ── copy_file ─────────────────────────────────────────────────────────────────
  private async _copyFile(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
    const src = ctx.resolvePath(args.src as string || args.path as string || '');
    const dst = ctx.resolvePath(args.dest as string || args.new_path as string || '');
    if (!src || !dst) return '請提供 src 與 dest 參數';
    if (!await ctx.requestPermission('write', `複製: ${src} → ${dst}`, 'copy_file')) return '使用者已拒絕操作';
    try { await vscode.workspace.fs.copy(vscode.Uri.file(src), vscode.Uri.file(dst), { overwrite: !!(args.overwrite as boolean) }); ctx.cache.delete(`rf:${dst}`); ctx.callbacks.postToWebview({ type: 'fileModified', filePath: dst, op: 'write', ts: Date.now() }); return `已複製: ${src} → ${dst}`; } catch(e) { return `copy_file 錯誤: ${e}`; }
  }

  // ── diff_files ─────────────────────────────────────────────────────────────────
  private async _diffFiles(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
    const dfA = ctx.resolvePath(args.a as string || args.path_a as string || '');
    const dfB = ctx.resolvePath(args.b as string || args.path_b as string || '');
    if (!dfA || !dfB) return '請提供 a 與 b 參數';
    try {
      const [bytesA, bytesB] = await Promise.all([vscode.workspace.fs.readFile(vscode.Uri.file(dfA)), vscode.workspace.fs.readFile(vscode.Uri.file(dfB))]);
      const linesA = Buffer.from(bytesA).toString('utf8').split('\n');
      const linesB = Buffer.from(bytesB).toString('utf8').split('\n');
      const diff = computeUnifiedDiff(linesA, linesB, path.relative(ctx.wsRoot, dfA), path.relative(ctx.wsRoot, dfB), Number(args.context) || 3);
      return diff || '（兩個檔案完全相同）';
    } catch(e) { return `diff_files 錯誤: ${e}`; }
  }

  // ── file_info ─────────────────────────────────────────────────────────────────
  private async _fileInfo(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
    const fpath = ctx.resolvePath(args.path as string || ''); if (!fpath) return '請提供 path 參數';
    try {
      const [stat, bytes] = await Promise.all([vscode.workspace.fs.stat(vscode.Uri.file(fpath)), vscode.workspace.fs.readFile(vscode.Uri.file(fpath))]);
      const buf = Buffer.from(bytes);
      let encoding = 'UTF-8';
      if (buf[0]===0xEF&&buf[1]===0xBB&&buf[2]===0xBF) encoding='UTF-8 BOM';
      else if (buf[0]===0xFF&&buf[1]===0xFE) encoding='UTF-16 LE BOM';
      else if (buf[0]===0xFE&&buf[1]===0xFF) encoding='UTF-16 BE BOM';
      const text = buf.toString('utf8'); const lineCount = text.split('\n').length;
      const crlf = (text.match(/\r\n/g)||[]).length; const lf = (text.match(/(?<!\r)\n/g)||[]).length;
      const mtime = new Date(stat.mtime).toISOString().replace('T',' ').slice(0,19);
      return [`路徑: ${fpath}`,`類型: ${(stat.type&vscode.FileType.Directory)?'目錄':'檔案'}`,`大小: ${stat.size} bytes (${(stat.size/1024).toFixed(1)} KB)`,`行數: ${lineCount}`,`行尾: ${crlf>lf?'CRLF':'LF'} (CRLF:${crlf} / LF:${lf})`,`編碼: ${encoding}`,`修改時間: ${mtime} UTC`].join('\n');
    } catch(e) { return `file_info 錯誤: ${e}`; }
  }

  // ── list_dir ──────────────────────────────────────────────────────────────────
  private async _listDir(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
    const dirArg = (args.path as string) || '';
    const ldKey = `ld:${dirArg}`; const cached = ctx.cache.get(ldKey); if (cached !== undefined) return cached;
    let result: string;
    if (!dirArg && ctx.folders.length > 1) {
      const parts: string[] = [];
      for (const f of ctx.folders) { const entries = await vscode.workspace.fs.readDirectory(f.uri); parts.push(`=== ${f.uri.fsPath} ===\n${entries.map(([n,t])=>t===vscode.FileType.Directory?n+'/':n).sort().join('\n')}`); }
      result = parts.join('\n\n');
    } else {
      const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(ctx.resolvePath(dirArg)));
      result = entries.map(([n,t])=>t===vscode.FileType.Directory?n+'/':n).sort().join('\n');
    }
    ctx.cache.set(ldKey, result);
    return result;
  }

  // ── delete_file ───────────────────────────────────────────────────────────────
  private async _deleteFile(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
    const fpath = ctx.resolvePath(args.path as string);
    if (!await ctx.requestPermission('delete', `刪除: ${fpath}`, 'delete_file')) return '使用者已拒絕刪除操作';
    await vscode.workspace.fs.delete(vscode.Uri.file(fpath), { recursive: (args.recursive as boolean) ?? false });
    ctx.cache.delete(`rf:${fpath}`); ctx.cache.delete(`ld:${path.dirname(fpath)}`);
    return `已刪除 ${fpath}`;
  }

  // ── create_dir ────────────────────────────────────────────────────────────────
  private async _createDir(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
    const dpath = ctx.resolvePath(args.path as string);
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(dpath));
    return `已建立目錄 ${dpath}`;
  }

  // ── read_workspace ────────────────────────────────────────────────────────────
  private async _readWorkspace(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
    const include = (args.include as string) || '**/*.{ts,js,tsx,jsx,py,cs,java,go,rs,cpp,c,h,inf,dec,dsc,fdf,uni,nasm,asm,asl,md,json,yaml,yml,txt}';
    const extraExclude = ((args.exclude as string) || '').split(',').map(s=>s.trim()).filter(Boolean);
    const excludeGlob = '{' + ['**/node_modules/**','**/.git/**','**/dist/**','**/out/**','**/build/**','**/.next/**','**/__pycache__/**','**/*.min.js','**/*.map', ...extraExclude].join(',') + '}';
    const maxFileBytes = Math.max(1, (args.max_file_kb as number) || 128) * 1024;
    const maxTotalBytes = Math.max(1, (args.max_total_kb as number) || 512) * 1024;
    const offset = Math.max(0, Number(args.offset) || 0);
    const allUris = await vscode.workspace.findFiles(include, excludeGlob, 2000);
    const binaryExts = new Set(['.png','.jpg','.jpeg','.gif','.ico','.webp','.bmp','.vsix','.zip','.tar','.gz','.exe','.dll','.so','.dylib','.wasm','.pdf','.db','.sqlite']);
    const candidates = allUris.filter(u => !binaryExts.has(path.extname(u.fsPath).toLowerCase()));
    const sliced = candidates.slice(offset);
    const parts: string[] = []; let totalBytes = 0; let truncated = false; let processed = 0;
    for (const uri of sliced) {
      processed++;
      if (processed % 10 === 0) ctx.callbacks.postToWebview({ type: 'agentStepProgress', text: `📂 read_workspace 進度 ${processed}/${sliced.length} (≈${Math.round(totalBytes/1024)}KB)` });
      let content: string;
      try {
        const raw = Buffer.from(await vscode.workspace.fs.readFile(uri));
        content = raw.length > maxFileBytes ? raw.toString('utf8', 0, maxFileBytes) + `\n…（已截斷，原始檔案 ${Math.round(raw.length/1024)} KB）` : raw.toString('utf8');
      } catch { continue; }
      const entry = `### ${vscode.workspace.asRelativePath(uri)}\n\`\`\`\n${content}\n\`\`\``;
      if (totalBytes + Buffer.byteLength(entry, 'utf8') > maxTotalBytes) { truncated = true; processed--; break; }
      totalBytes += Buffer.byteLength(entry, 'utf8'); parts.push(entry);
    }
    const nextOffset = offset + processed; const remaining = Math.max(0, candidates.length - nextOffset);
    const header = `工作區共 ${candidates.length} 個檔案，本批讀取 ${parts.length} 個（offset=${offset}→${nextOffset}，合計 ≈${Math.round(totalBytes/1024)} KB）${truncated?'，已達容量上限提早停止':''}`;
    const hint = remaining > 0 ? `\n💡 剩餘 ${remaining} 個檔案未讀取，如需繼續請再次呼叫 read_workspace 並使用 offset=${nextOffset}。` : '\n✅ 所有符合條件的檔案已讀取完畢。';
    return header + hint + '\n\n' + parts.join('\n\n');
  }
}
