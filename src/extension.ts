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

  // VS Code 開啟時自動在背景初始化（不顯示 panel）以接受 WhatsApp 指令
  OllamaChatPanel.createSilent(context);

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

  // Jira 快速指令 (Ctrl+Shift+J)
  context.subscriptions.push(
    vscode.commands.registerCommand('amiAiClaw.jira', async () => {
      type JiraAction = { label: string; description: string; id: string };
      const actions: JiraAction[] = [
        { label: '$(search)  搜尋我的 Issues', description: 'assignee=currentUser() 未完成', id: 'mine' },
        { label: '$(eye)  待 Review Issues', description: 'status In Review / Code Review', id: 'review' },
        { label: '$(person)  依指定人搜尋', description: '輸入 assignee displayName', id: 'assignee' },
        { label: '$(list-filter)  JQL 自訂搜尋', description: '直接輸入 JQL 語句', id: 'jql' },
        { label: '$(tag)  查詢特定 Issue', description: '輸入 Issue Key（如 BIOS-123）', id: 'fetch' },
        { label: '$(clock)  記錄工時', description: '選 Issue Key + 時間（如 16h）', id: 'logtime' },
        { label: '$(add)  建立 Issue', description: '開啟建立 Issue 面板', id: 'create' },
        { label: '$(sync)  轉換 Issue 狀態', description: '輸入 Issue Key 後開啟轉換面板', id: 'transition' },
      ];

      const picked = await vscode.window.showQuickPick(actions, {
        title: 'Jira 快速指令',
        placeHolder: '選擇 Jira 操作…',
        matchOnDescription: true,
      });
      if (!picked) { return; }

      let prompt = '';

      switch (picked.id) {
        case 'mine':
          prompt = '列出我名下所有未完成的 Jira Issues（使用 jira_search，jql="assignee=currentUser() AND status!=Done ORDER BY updated DESC"），並以清單顯示。';
          break;

        case 'review': {
          prompt = '列出目前待 Review 的 Jira Issues（使用 jira_search，jql="status IN (\\"In Review\\",\\"Code Review\\",\\"PR Review\\") ORDER BY updated DESC"），並以清單顯示。';
          break;
        }

        case 'assignee': {
          const name = await vscode.window.showInputBox({ prompt: '輸入指派人名稱（displayName 或帳號）', placeHolder: '例：許元信' });
          if (!name) { return; }
          prompt = `列出指派給「${name}」的所有 Jira Issues（使用 jira_search，assignee="${name}"），以清單顯示。`;
          break;
        }

        case 'jql': {
          const jql = await vscode.window.showInputBox({ prompt: '輸入 JQL 查詢語句', placeHolder: 'project = BIOS AND status = "In Progress" ORDER BY updated DESC' });
          if (!jql) { return; }
          prompt = `使用以下 JQL 搜尋 Jira Issues 並以清單顯示：${jql}`;
          break;
        }

        case 'fetch': {
          const key = await vscode.window.showInputBox({ prompt: '輸入 Jira Issue Key', placeHolder: '例：BIOS-123' });
          if (!key) { return; }
          prompt = `立即呼叫 jira_fetch 取得 ${key.trim().toUpperCase()} 的完整詳情並顯示。`;
          break;
        }

        case 'logtime': {
          const ltKey = await vscode.window.showInputBox({ prompt: '輸入 Jira Issue Key', placeHolder: '例：BIOS-123' });
          if (!ltKey) { return; }
          const ltTime = await vscode.window.showInputBox({ prompt: '輸入工時', placeHolder: '例：16h、2h 30m、1d', value: '8h' });
          if (!ltTime) { return; }
          const ltDateOptions = ['今天 (today)', '昨天 (yesterday)', '自訂日期…'];
          const ltDatePick = await vscode.window.showQuickPick(ltDateOptions, { title: '選擇日期', placeHolder: '工時日期' });
          if (!ltDatePick) { return; }
          let ltDate = 'today';
          if (ltDatePick === '昨天 (yesterday)') { ltDate = 'yesterday'; }
          else if (ltDatePick === '自訂日期…') {
            const d = await vscode.window.showInputBox({ prompt: '輸入日期 (YYYY-MM-DD)', placeHolder: '例：2026-03-24' });
            if (!d) { return; }
            ltDate = d.trim();
          }
          const ltComment = await vscode.window.showInputBox({ prompt: '備註（可空白）', placeHolder: '可選' }) ?? '';
          prompt = `請立即呼叫 jira_log_time，記錄 ${ltKey.trim().toUpperCase()} 的工時：time_spent="${ltTime.trim()}"，date="${ltDate}"${ltComment ? `，comment="${ltComment}"` : ''}。完成後回報結果。`;
          break;
        }

        case 'create':
          prompt = '請立即呼叫 jira_create 開啟 Jira 建立 Issue 面板。';
          break;

        case 'transition': {
          const tKey = await vscode.window.showInputBox({ prompt: '輸入 Jira Issue Key', placeHolder: '例：BIOS-123' });
          if (!tKey) { return; }
          prompt = `請立即呼叫 jira_transition 開啟 ${tKey.trim().toUpperCase()} 的狀態轉換面板。`;
          break;
        }

        default: return;
      }

      if (prompt) {
        openAndSend(context, { type: 'agentSend', prompt });
      }
    })
  );
}

export function deactivate() {}
