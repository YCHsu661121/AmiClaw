// Copyright (c) 2026 YCHsu. All rights reserved.
// Licensed under the MIT License.

import * as vscode from 'vscode';
import type { IToolProvider, ToolExecutionContext } from './IToolProvider';

const TOOLS = new Set([
  'lsp_goto_definition',
  'lsp_find_references',
  'lsp_hover',
  'lsp_diagnostics',
  'lsp_rename_symbol',
  'lsp_document_symbols',
]);

export class LspProvider implements IToolProvider {
  readonly tools: ReadonlySet<string> = TOOLS;

  execute(name: string, args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
    switch (name) {
      case 'lsp_goto_definition':  return this._gotoDefinition(args, ctx);
      case 'lsp_find_references':  return this._findReferences(args, ctx);
      case 'lsp_hover':            return this._hover(args, ctx);
      case 'lsp_diagnostics':      return this._diagnostics(args, ctx);
      case 'lsp_rename_symbol':    return this._renameSymbol(args, ctx);
      case 'lsp_document_symbols': return this._documentSymbols(args, ctx);
      default: return Promise.resolve(`LspProvider: unknown tool "${name}"`);
    }
  }

  private _toUri(filePath: string, ctx: ToolExecutionContext): vscode.Uri {
    return vscode.Uri.file(ctx.resolvePath(filePath));
  }

  /** Convert 1-based line/col args to a 0-based vscode.Position. */
  private _pos(line: unknown, col: unknown): vscode.Position {
    return new vscode.Position(
      Math.max(0, Number(line ?? 1) - 1),
      Math.max(0, Number(col  ?? 1) - 1),
    );
  }

  // ── lsp_goto_definition ──────────────────────────────────────────────────

  private async _gotoDefinition(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
    const filePath = String(args.path ?? '');
    if (!filePath) return 'path 為必填';
    try {
      const locs: vscode.Location[] = await vscode.commands.executeCommand(
        'vscode.executeDefinitionProvider', this._toUri(filePath, ctx), this._pos(args.line, args.col),
      ) ?? [];
      if (!locs.length) return '找不到定義（語言伺服器未回應或 symbol 無法解析）';
      return locs.map(loc =>
        `${vscode.workspace.asRelativePath(loc.uri)}:${loc.range.start.line + 1}:${loc.range.start.character + 1}`
      ).join('\n');
    } catch (e) {
      return `LSP 錯誤：${e}`;
    }
  }

  // ── lsp_find_references ──────────────────────────────────────────────────

  private async _findReferences(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
    const filePath = String(args.path ?? '');
    if (!filePath) return 'path 為必填';
    const includeDecl = (args.include_declaration as boolean) !== false;
    try {
      const locs: vscode.Location[] = await vscode.commands.executeCommand(
        'vscode.executeReferenceProvider',
        this._toUri(filePath, ctx), this._pos(args.line, args.col),
        { includeDeclaration: includeDecl },
      ) ?? [];
      if (!locs.length) return '找不到參考';
      const lines = locs.map(loc =>
        `${vscode.workspace.asRelativePath(loc.uri)}:${loc.range.start.line + 1}:${loc.range.start.character + 1}`
      );
      return `共 ${lines.length} 個參考：\n${lines.join('\n')}`;
    } catch (e) {
      return `LSP 錯誤：${e}`;
    }
  }

  // ── lsp_hover ────────────────────────────────────────────────────────────

  private async _hover(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
    const filePath = String(args.path ?? '');
    if (!filePath) return 'path 為必填';
    try {
      const hovers: vscode.Hover[] = await vscode.commands.executeCommand(
        'vscode.executeHoverProvider', this._toUri(filePath, ctx), this._pos(args.line, args.col),
      ) ?? [];
      if (!hovers.length) return '無 hover 資訊（語言伺服器未回應或游標位置無 symbol）';
      const text = hovers
        .flatMap(h => h.contents.map(c => (typeof c === 'string' ? c : c.value)))
        .join('\n---\n');
      return text.slice(0, 4000);
    } catch (e) {
      return `LSP 錯誤：${e}`;
    }
  }

  // ── lsp_diagnostics ──────────────────────────────────────────────────────

  private async _diagnostics(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
    const filePath = String(args.path ?? '');
    const severityFilter = String(args.severity ?? 'all');

    const SNAME = ['ERROR', 'WARNING', 'INFO', 'HINT'];
    const minSev: number = severityFilter === 'error' ? 0 : severityFilter === 'warning' ? 1 : 4;

    let pairs: [vscode.Uri, readonly vscode.Diagnostic[]][];
    if (filePath) {
      const uri = this._toUri(filePath, ctx);
      pairs = [[uri, vscode.languages.getDiagnostics(uri)]];
    } else {
      pairs = vscode.languages.getDiagnostics();
    }

    const lines: string[] = [];
    for (const [uri, diags] of pairs) {
      const rel = vscode.workspace.asRelativePath(uri);
      for (const d of diags) {
        if (d.severity > minSev) continue; // lower number = higher severity
        lines.push(`${rel}:${d.range.start.line + 1} [${SNAME[d.severity] ?? 'HINT'}] ${d.message}`);
      }
    }
    if (!lines.length) return '無診斷問題 ✓';
    return lines.slice(0, 300).join('\n');
  }

  // ── lsp_rename_symbol ────────────────────────────────────────────────────

  private async _renameSymbol(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
    const filePath = String(args.path ?? '');
    const newName  = String(args.new_name ?? '').trim();
    if (!filePath) return 'path 為必填';
    if (!newName)  return 'new_name 為必填';

    const allowed = await ctx.requestPermission(
      'write', `LSP 重新命名 symbol → "${newName}"（影響多個檔案）`, 'lsp_rename_symbol',
    );
    if (!allowed) return '操作已取消';

    try {
      const edit: vscode.WorkspaceEdit = await vscode.commands.executeCommand(
        'vscode.executeDocumentRenameProvider',
        this._toUri(filePath, ctx), this._pos(args.line, args.col), newName,
      );
      if (!edit || edit.size === 0) return '找不到可重新命名的 symbol（語言伺服器未回應）';
      await vscode.workspace.applyEdit(edit);
      const affected = Array.from(edit.entries()).map(([u]) => vscode.workspace.asRelativePath(u));
      return `已重新命名，共影響 ${affected.length} 個檔案：\n${affected.join('\n')}`;
    } catch (e) {
      return `LSP 錯誤：${e}`;
    }
  }

  // ── lsp_document_symbols ─────────────────────────────────────────────────

  private async _documentSymbols(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
    const filePath = String(args.path ?? '');
    if (!filePath) return 'path 為必填';
    try {
      const symbols: (vscode.DocumentSymbol | vscode.SymbolInformation)[] =
        await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', this._toUri(filePath, ctx)) ?? [];
      if (!symbols.length) return '找不到 symbol（語言伺服器尚未啟動或不支援此檔案類型）';

      const kindName = (k: vscode.SymbolKind) => vscode.SymbolKind[k] ?? 'Unknown';
      const lines: string[] = [];

      const isDocSym = (s: vscode.DocumentSymbol | vscode.SymbolInformation): s is vscode.DocumentSymbol =>
        (s as vscode.DocumentSymbol).children !== undefined;

      const flatten = (syms: vscode.DocumentSymbol[], depth: number) => {
        for (const s of syms) {
          lines.push(`${'  '.repeat(depth)}${kindName(s.kind)} ${s.name}  L${s.range.start.line + 1}`);
          if (s.children.length) flatten(s.children, depth + 1);
        }
      };

      if (isDocSym(symbols[0])) {
        flatten(symbols as vscode.DocumentSymbol[], 0);
      } else {
        for (const s of symbols as vscode.SymbolInformation[]) {
          lines.push(`${kindName(s.kind)} ${s.name}  ${vscode.workspace.asRelativePath(s.location.uri)}:L${s.location.range.start.line + 1}`);
        }
      }
      return lines.slice(0, 500).join('\n');
    } catch (e) {
      return `LSP 錯誤：${e}`;
    }
  }
}
