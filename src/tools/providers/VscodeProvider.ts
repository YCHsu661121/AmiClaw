// Copyright (c) 2026 YCHsu. All rights reserved.
// Licensed under the MIT License.

import * as vscode from 'vscode';
import * as path from 'path';
import type { IToolProvider, ToolExecutionContext } from './IToolProvider';

const TOOLS = new Set(['vscode_action', 'manage_todo']);

export type AgentTodo = { id: number; text: string; done: boolean };

export class VscodeProvider implements IToolProvider {
  readonly tools: ReadonlySet<string> = TOOLS;
  private _todos: AgentTodo[] = [];

  /** Called by ToolExecutor.clearAgentTodos() */
  clearTodos(): void {
    this._todos = [];
  }

  /** Called by ToolExecutor.getAgentTodos() */
  getTodos(): AgentTodo[] {
    return this._todos;
  }

  execute(name: string, args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
    switch (name) {
      case 'vscode_action': return this._vscodeAction(args, ctx);
      case 'manage_todo':   return Promise.resolve(this._manageTodo(args, ctx));
      default: return Promise.resolve(`VscodeProvider: unknown tool "${name}"`);
    }
  }

  private async _vscodeAction(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
    const wsRoot = (vscode.workspace.workspaceFolders ?? [])[0]?.uri.fsPath ?? '';
    const resolvePath = (p: string) => path.isAbsolute(p) ? p : path.join(wsRoot, p);
    const action = (args.action as string) || '';
    if (action === 'open_file') {
      const fpath = resolvePath(args.path as string || '');
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fpath));
      const editor = await vscode.window.showTextDocument(doc, { preview: true });
      if (args.line) {
        const pos = new vscode.Position(Math.max(0, Number(args.line) - 1), 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      }
      return `已開啟 ${fpath}${args.line ? ` 第 ${args.line} 行` : ''}`;
    }
    if (action === 'get_workspace_info') {
      const wsFolders = vscode.workspace.workspaceFolders ?? [];
      const openDocs  = vscode.workspace.textDocuments.filter(d => !d.isUntitled && d.uri.scheme === 'file');
      return `工作區: ${wsFolders.map(f => f.uri.fsPath).join(', ') || '(none)'}\n開啟中檔案:\n${openDocs.map(d => d.uri.fsPath).join('\n') || '(none)'}`;
    }
    if (action === 'show_notification') {
      vscode.window.showInformationMessage(String(args.message ?? ''));
      return '已顯示通知';
    }
    if (action === 'run_command') {
      await vscode.commands.executeCommand(args.command as string, ...(Array.isArray(args.args) ? args.args : []));
      return `已執行 VS Code 指令: ${args.command}`;
    }
    return `未知 vscode_action: ${action}`;
  }

  private _manageTodo(args: Record<string, unknown>, ctx: ToolExecutionContext): string {
    const action = (args.action as string) || 'list';
    if (action === 'add') {
      const text = args.text as string;
      if (!text) return '請提供 todo 內容 (text 參數)';
      this._todos.push({ id: this._todos.length + 1, text, done: false });
      ctx.callbacks.postToWebview({ type: 'agentTodoUpdate', todos: [...this._todos] });
      return `已新增 Todo #${this._todos.length}: ${text}`;
    }
    if (action === 'done') {
      const id   = Number(args.id);
      const item = this._todos.find(t => t.id === id);
      if (!item) return `找不到 Todo #${id}`;
      item.done = true;
      ctx.callbacks.postToWebview({ type: 'agentTodoUpdate', todos: [...this._todos] });
      return `✅ Todo #${id} 已完成: ${item.text}`;
    }
    if (action === 'clear') {
      this._todos = [];
      ctx.callbacks.postToWebview({ type: 'agentTodoUpdate', todos: [] });
      return 'Todo 清單已清空';
    }
    if (this._todos.length === 0) return 'Todo 清單是空的，請先用 add 新增任務';
    return this._todos.map(t => `${t.done ? '✅' : '⏳'} #${t.id}: ${t.text}`).join('\n');
  }
}
