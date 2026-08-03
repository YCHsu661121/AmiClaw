// Copyright (c) 2026 YCHsu. All rights reserved.
// Licensed under the MIT License.

import * as vscode from 'vscode';
import * as path from 'path';
import type { IToolProvider, ToolExecutionContext } from './IToolProvider';

const TOOLS = new Set(['search_workspace', 'search_regex', 'agentic_file_search']);

const SKIP_BINARY = new Set(['.png','.jpg','.jpeg','.gif','.ico','.svg','.woff','.woff2','.ttf','.eot','.vsix','.zip','.tar','.gz','.exe','.dll','.pdf','.db','.sqlite','.lock','.wasm']);

export class SearchProvider implements IToolProvider {
  readonly tools: ReadonlySet<string> = TOOLS;

  execute(name: string, args: Record<string, unknown>, _ctx: ToolExecutionContext): Promise<string> {
    switch (name) {
      case 'search_workspace':    return this._searchWorkspace(args);
      case 'search_regex':        return this._searchRegex(args);
      case 'agentic_file_search': return this._agenticSearch(args);
      default: return Promise.resolve(`SearchProvider: unknown tool "${name}"`);
    }
  }

  private async _searchWorkspace(args: Record<string, unknown>): Promise<string> {
    const query = ((args.query as string) ?? '').toLowerCase();
    if (!query) return '請提供搜尋關鍵字';
    const allUris = await vscode.workspace.findFiles('**/*', '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**}', 200);
    const fileMatches = allUris.map(u => u.fsPath).filter(p => path.basename(p).toLowerCase().includes(query));
    const contentMatches: string[] = [];
    for (const uri of allUris) {
      if (contentMatches.length >= 40) break;
      try {
        if (SKIP_BINARY.has(path.extname(uri.fsPath).toLowerCase())) continue;
        const bytes = await vscode.workspace.fs.readFile(uri);
        const lines = Buffer.from(bytes).toString('utf8').split('\n');
        for (let li = 0; li < lines.length && contentMatches.length < 40; li++) {
          if (lines[li].toLowerCase().includes(query)) {
            contentMatches.push(`${uri.fsPath}:${li + 1}: ${lines[li].trim().slice(0, 120)}`);
          }
        }
      } catch { /* skip binary */ }
    }
    const parts: string[] = [];
    if (fileMatches.length > 0)   parts.push(`=== 檔案名稱匹配 (${fileMatches.length}) ===\n${fileMatches.slice(0, 30).join('\n')}`);
    if (contentMatches.length > 0) parts.push(`=== 程式碼內容匹配 (${contentMatches.length}) ===\n${contentMatches.join('\n')}`);
    return parts.length > 0 ? parts.join('\n\n') : `找不到符合 "${args.query}" 的結果`;
  }

  private async _searchRegex(args: Record<string, unknown>): Promise<string> {
    const pattern = (args.pattern as string || '').trim();
    if (!pattern) return '請提供 pattern 參數';
    const reFlags = ((args.flags as string) || 'i').replace(/[^imu]/g, '');
    let regex: RegExp;
    try { regex = new RegExp(pattern, reFlags); } catch (e) { return `無效的正規表達式: ${e}`; }
    const allUris = await vscode.workspace.findFiles(
      (args.include as string) || '**/*',
      '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**}', 500);
    const matches: string[] = [];
    for (const uri of allUris) {
      if (matches.length >= 100) break;
      try {
        if (['.png','.jpg','.jpeg','.ico','.vsix','.zip','.exe','.dll','.pdf','.wasm'].includes(path.extname(uri.fsPath).toLowerCase())) continue;
        const lines = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8').split('\n');
        for (let li = 0; li < lines.length && matches.length < 100; li++) {
          if (regex.exec(lines[li]) !== null) matches.push(`${uri.fsPath}:${li + 1}: ${lines[li].trim().slice(0, 120)}`);
        }
      } catch { /* skip binary */ }
    }
    return matches.length > 0
      ? `=== RegExp /${pattern}/${reFlags} 匹配 (${matches.length}) ===\n${matches.join('\n')}`
      : `找不到符合 /${pattern}/${reFlags} 的結果`;
  }

  private async _agenticSearch(args: Record<string, unknown>): Promise<string> {
    const afQuery = ((args.query as string) ?? '').trim();
    if (!afQuery) return '請提供 query 參數';
    const wsRoot   = (vscode.workspace.workspaceFolders ?? [])[0]?.uri.fsPath ?? '';
    const afTopK   = Math.min(Math.max(Number(args.top_k) || 10, 1), 30);
    const stopWords = new Set(['的','在','裡','中','使用','處理','負責','找出','哪個','檔案','函式','類別','實作','實現','相關','所有','一個','如何','為何','what','which','file','for','the','and','or','that','with','from','this','how','where','when']);
    const keywords  = afQuery.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_\-./]/g, ' ').toLowerCase().split(/\s+/).filter(w => w.length >= 2 && !stopWords.has(w));
    const declRe    = /^\s*(?:export\s+)?(?:(?:async\s+)?function\*?\s+([\w$]+)|class\s+([\w$]+)|interface\s+([\w$]+)|type\s+([\w$]+)\s*(?:<[^>]*>)?\s*=|(?:const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>|def\s+([\w_]+)|func\s+([\w_]+)\s*\(|public\s+(?:static\s+)?\S+\s+([\w_]+)\s*\(|EFIAPI\s+([\w_]+)\s*\(|^\[([A-Za-z][\w.]+)\])/;
    const allUris   = await vscode.workspace.findFiles(
      (args.include as string) || '**/*.{ts,js,tsx,jsx,py,cs,java,go,rs,cpp,c,h,inf,dec,dsc,fdf,uni,nasm,asm,asl,vue,svelte}',
      '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**,**/build/**}', 1000);
    const scores: { rel: string; score: number; decls: string[] }[] = [];
    for (const uri of allUris) {
      if (SKIP_BINARY.has(path.extname(uri.fsPath).toLowerCase())) continue;
      const rel = path.relative(wsRoot, uri.fsPath).replace(/\\/g, '/');
      let score = keywords.reduce((s, kw) => s + (rel.toLowerCase().includes(kw) ? 3 : 0), 0);
      const decls: string[] = [];
      try {
        const text  = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8').slice(0, 60000);
        const lines = text.split('\n');
        for (let li = 0; li < lines.length; li++) {
          const m = declRe.exec(lines[li]);
          if (m) { const d = m.slice(1).find(Boolean) ?? ''; if (d) decls.push(`L${li+1} ${d}`); }
        }
        const cl = text.toLowerCase();
        score += keywords.reduce((s, kw) => s + Math.min((cl.match(new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 5), 0);
        score += decls.reduce((s, d) => s + keywords.reduce((ss, kw) => ss + (d.toLowerCase().includes(kw) ? 4 : 0), 0), 0);
      } catch { /* skip binary */ }
      if (score > 0 || decls.length > 0) scores.push({ rel, score, decls });
    }
    scores.sort((a, b) => b.score - a.score);
    const top = scores.slice(0, afTopK);
    if (top.length === 0) return `找不到與「${afQuery}」相關的檔案`;
    return `=== 語意搜尋「${afQuery}」結果 (前 ${top.length}/${scores.length} 個相關檔案) ===\n${top.map((f, i) => `${i+1}. ${f.rel} (相關度:${f.score})${f.decls.length > 0 ? `\n  宣告: ${f.decls.slice(0, 20).join(', ')}${f.decls.length > 20 ? ` …(+${f.decls.length-20})` : ''}` : ''}`).join('\n')}`;
  }
}
