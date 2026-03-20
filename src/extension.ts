import * as vscode from 'vscode';
import { OllamaChatPanel } from './ollama-chat';

interface ChatSessionInfo { id: string; title: string; }

class ChatSessionsProvider implements vscode.TreeDataProvider<ChatSessionInfo> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private context: vscode.ExtensionContext) {}

  refresh(): void { this._onDidChangeTreeData.fire(); }

  getTreeItem(session: ChatSessionInfo): vscode.TreeItem {
    const activeId = this.context.globalState.get<string>('amiAiClaw.activeSessionId', 'default');
    const isActive = session.id === activeId;
    const item = new vscode.TreeItem(session.title, vscode.TreeItemCollapsibleState.None);
    item.command = { command: 'amiAiClaw.switchChatSession', title: '切換到此聊天', arguments: [session.id] };
    item.iconPath = new vscode.ThemeIcon(isActive ? 'comment-discussion' : 'comment');
    item.contextValue = 'chatSession';
    item.tooltip = session.title;
    if (isActive) { item.description = '▶ 活躍'; }
    return item;
  }

  getChildren(): vscode.ProviderResult<ChatSessionInfo[]> {
    const sessions = this.context.globalState.get<ChatSessionInfo[]>('amiAiClaw.sessions', []);
    return sessions.length > 0 ? sessions : [{ id: 'default', title: '聊天 1' }];
  }
}

function openAndSend(context: vscode.ExtensionContext, msg: object) {
  OllamaChatPanel.createOrShow(context);
  const send = () => OllamaChatPanel.currentPanel?.postMessageToWebview(msg);
  if (OllamaChatPanel.currentPanel) { send(); } else { setTimeout(send, 700); }
}

export function activate(context: vscode.ExtensionContext) {
  const sessionsProvider = new ChatSessionsProvider(context);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('amiAiClaw.openChat', sessionsProvider)
  );

  // Wire up callback so webview updates propagate to the sidebar
  OllamaChatPanel.onSessionsChanged = (sessions: ChatSessionInfo[], activeId: string) => {
    context.globalState.update('amiAiClaw.sessions', sessions);
    context.globalState.update('amiAiClaw.activeSessionId', activeId);
    sessionsProvider.refresh();
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('amiAiClaw.chat', () => {
      OllamaChatPanel.createOrShow(context);
    })
  );

  // ➕ New chat (view title button)
  context.subscriptions.push(
    vscode.commands.registerCommand('amiAiClaw.newChatSession', () => {
      openAndSend(context, { type: 'newChatSession' });
    })
  );

  // Click on a tree item → switch to that session
  context.subscriptions.push(
    vscode.commands.registerCommand('amiAiClaw.switchChatSession', (sessionId: string) => {
      openAndSend(context, { type: 'switchChatSessionFromHost', sessionId });
    })
  );

  // Rename (context menu)
  context.subscriptions.push(
    vscode.commands.registerCommand('amiAiClaw.renameChatSession', async (session: ChatSessionInfo) => {
      const title = await vscode.window.showInputBox({ prompt: '請輸入聊天標題', value: session?.title || '' });
      if (!title || !title.trim()) { return; }
      OllamaChatPanel.currentPanel?.postMessageToWebview({ type: 'renameChatSessionFromHost', sessionId: session.id, title: title.trim() });
    })
  );

  // Delete (context menu)
  context.subscriptions.push(
    vscode.commands.registerCommand('amiAiClaw.deleteChatSession', async (session: ChatSessionInfo) => {
      const confirm = await vscode.window.showWarningMessage(
        `刪除「${session?.title || '聊天'}」？此動作無法復原。`,
        { modal: true }, '刪除'
      );
      if (confirm !== '刪除') { return; }
      OllamaChatPanel.currentPanel?.postMessageToWebview({ type: 'deleteChatSessionFromHost', sessionId: session.id });
    })
  );

  // Right-click on file/folder in Explorer or Editor → send to chat
  context.subscriptions.push(
    vscode.commands.registerCommand('amiAiClaw.sendToChat', async (uri: vscode.Uri, allUris?: vscode.Uri[]) => {
      OllamaChatPanel.createOrShow(context);
      const uris = allUris && allUris.length > 0 ? allUris : (uri ? [uri] : []);
      if (uris.length > 0) {
        await OllamaChatPanel.sendUrisToChat(uris);
      }
    })
  );

  // 聚焦輸入框 (快捷鍵 Ctrl+L)
  context.subscriptions.push(
    vscode.commands.registerCommand('amiAiClaw.focusInput', () => {
      OllamaChatPanel.createOrShow(context);
      OllamaChatPanel.currentPanel?.postMessageToWebview({ type: 'focusInput' });
    })
  );

  // 顯示 Agent 工具呼叫稽核日誌
  context.subscriptions.push(
    vscode.commands.registerCommand('amiAiClaw.showAuditLog', () => {
      if (OllamaChatPanel.currentPanel) {
        OllamaChatPanel.currentPanel.showAuditLog();
      } else {
        // 未開啟面板時，直接從 globalState 讀取
        type AuditEntry = { ts: number; session: string; tool: string; argsSnippet: string; error: boolean };
        const entries = context.globalState.get<AuditEntry[]>('amiAiClaw.auditLog') ?? [];
        if (entries.length === 0) {
          vscode.window.showInformationMessage('稽核日誌為空 — 尚未有 Agent 工具呼叫記錄');
          return;
        }
        const items = entries.slice().reverse().slice(0, 200).map(e => ({
          label: `${e.error ? '❌' : '✅'} ${e.tool}`,
          description: new Date(e.ts).toLocaleString('zh-TW'),
          detail: e.argsSnippet,
        }));
        void vscode.window.showQuickPick(items, {
          title: `稽核日誌（共 ${entries.length} 筆工具呼叫）`,
          placeHolder: '工具呼叫歷程…',
        });
      }
    })
  );
}

export function deactivate() {}