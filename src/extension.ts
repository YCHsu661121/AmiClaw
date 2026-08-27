import * as vscode from 'vscode';
import { exec as nodeExec } from 'child_process';
import { promisify } from 'util';
const exec = promisify(nodeExec);
import { OllamaChatPanel } from './ollama-chat';
import { setAutoPilotActive, setAutoPilotEnabledBySetting } from './autopilot';

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
  // createOrShow 為 async（內部會 await sidebar.focus），需先等它完成再 post
  void (async () => {
    try {
      await OllamaChatPanel.createOrShow(context);
      const panel = OllamaChatPanel.currentPanel;
      if (panel) {
        await panel.waitForWebviewReady();
        panel.postMessageToWebview(msg);
      }
    } catch (e) {
      OllamaChatPanel.reportDiagnostic('openAndSend failed', e);
      OllamaChatPanel.revealDiagnostics();
      void vscode.window.showErrorMessage('AMI-AiClaw 無法開啟，請查看輸出視窗「AMI-AiClaw Diagnostics」。');
    }
  })();
}

export function activate(context: vscode.ExtensionContext) {
  // ── Initialize AutoPilot State (Critical fix: was missing) ──────────────
  const autoPilotCfg = vscode.workspace.getConfiguration('amiAiClaw');
  const apEnabled = autoPilotCfg.get<boolean>('autoPilotEnabled', false);
  setAutoPilotEnabledBySetting(apEnabled);
  if (apEnabled) {
    setAutoPilotActive(true);
  } else {
    setAutoPilotActive(false);
  }

  OllamaChatPanel.reportDiagnostic('activate:start');
  const sessionsProvider = new ChatSessionsProvider(context);

  // ── 固定側邊欄 WebviewView Provider ──────────────────────────────────────
  const viewProvider: vscode.WebviewViewProvider = {
    resolveWebviewView(view: vscode.WebviewView) {
      try {
        OllamaChatPanel.createFromView(view, context);
      } catch (e) {
        OllamaChatPanel.reportDiagnostic('resolveWebviewView failed', e);
        OllamaChatPanel.revealDiagnostics();
        void vscode.window.showErrorMessage('AMI-AiClaw 側邊欄初始化失敗，請查看輸出視窗「AMI-AiClaw Diagnostics」。');
      }
    }
  };
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('amiAiClaw.chatView', viewProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  // VS Code 開啟時自動在背景初始化（不顯示 panel）以接受 WhatsApp 指令
  try {
    OllamaChatPanel.createSilent(context);
  } catch (e) {
    OllamaChatPanel.reportDiagnostic('createSilent failed', e);
  }

  // ── AmiClawToClaudeToDo.md 監聽器：存檔時自動將內容送入 Agent ──────────────
  const todoLog = vscode.window.createOutputChannel('AmiClaw-TodoWatcher');
  context.subscriptions.push(todoLog);

  // ── 對話記錄回呼：Agent 完成後將提示 + 回應 append 到 AmiClawTodoLog.md ────
  OllamaChatPanel.onTodoComplete = async (prompt: string, response: string) => {
    const folders = vscode.workspace.workspaceFolders ?? [];
    // 找到 AmiClawToClaudeToDo.md 所在的 folder，把 log 放在同目錄
    let logFolder = folders[0]?.uri;
    for (const folder of folders) {
      try {
        await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder.uri, 'AmiClawToClaudeToDo.md'));
        logFolder = folder.uri;
        break;
      } catch { /* 不在這個 folder */ }
    }
    if (!logFolder) { return; }
    const logUri = vscode.Uri.joinPath(logFolder, 'AmiClawTodoLog.md');
    const ts = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
    const entry = `\n---\n## 📋 ${ts} 任務\n${prompt}\n\n## 🤖 ${ts} Agent 回應\n${response}\n`;
    try {
      // 追加到已有的 log（如果存在），否則建立新檔
      let existing = '';
      try {
        const b = await vscode.workspace.fs.readFile(logUri);
        existing = Buffer.from(b).toString('utf8');
      } catch { /* 第一次建立 */ }
      const newContent = Buffer.from(existing + entry, 'utf8');
      await vscode.workspace.fs.writeFile(logUri, newContent);
      todoLog.appendLine(`[onTodoComplete] 已寫入 ${logUri.fsPath}（+${entry.length} 字）`);
      vscode.window.setStatusBarMessage(`📝 AmiClaw：對話已記錄到 AmiClawTodoLog.md`, 5000);
    } catch (e) {
      todoLog.appendLine(`[onTodoComplete] 寫入失敗: ${(e as Error)?.message ?? e}`);
    }
  };

  let _todoDebounce: ReturnType<typeof setTimeout> | undefined;

  async function processTodoFile(uri: vscode.Uri) {
    clearTimeout(_todoDebounce);
    _todoDebounce = setTimeout(async () => {
      try {
        todoLog.appendLine(`[processTodoFile] 觸發: ${uri.fsPath}`);
        const bytes = await vscode.workspace.fs.readFile(uri);
        const prompt = Buffer.from(bytes).toString('utf8').trim();
        if (!prompt) {
          todoLog.appendLine('[processTodoFile] 檔案為空，跳過');
          return;
        }
        todoLog.appendLine(`[processTodoFile] 內容長度=${prompt.length}，送入 agentSend`);
        // 確保 panel 已建立，再進入 todo 模式
        await OllamaChatPanel.createOrShow(context);
        OllamaChatPanel.currentPanel?.enterTodoMode(prompt);
        const send = () => OllamaChatPanel.currentPanel?.postMessageToWebview({ type: 'externalAgentSend', prompt });
        if (OllamaChatPanel.currentPanel) { send(); } else { setTimeout(send, 700); }
        vscode.window.setStatusBarMessage(`🤖 AmiClaw：已讀取 AmiClawToClaudeToDo.md (${prompt.length} 字)`, 5000);
      } catch (e) {
        const msg = (e as Error)?.message ?? String(e);
        todoLog.appendLine(`[processTodoFile] 錯誤: ${msg}`);
        vscode.window.showErrorMessage(`AmiClaw 讀取 AmiClawToClaudeToDo.md 失敗：${msg}`);
      }
    }, 500);
  }

  // 對每個 workspace folder 分別建立 RelativePattern watcher（multi-root 最可靠作法）
  function registerTodoWatchers(folders: readonly vscode.WorkspaceFolder[]) {
    for (const folder of folders) {
      const pattern = new vscode.RelativePattern(folder, 'AmiClawToClaudeToDo.md');
      const w = vscode.workspace.createFileSystemWatcher(pattern, false, false, true);
      w.onDidCreate(processTodoFile);
      w.onDidChange(processTodoFile);
      context.subscriptions.push(w);
      todoLog.appendLine(`[init] 監聽 ${folder.uri.fsPath}/AmiClawToClaudeToDo.md`);
    }
  }

  registerTodoWatchers(vscode.workspace.workspaceFolders ?? []);

  // 若之後動態加入 workspace folder，也自動加 watcher
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders((e) => {
      registerTodoWatchers(e.added);
    })
  );

  // 手動命令備用：Command Palette → "AmiClaw: 執行 AmiClawToClaudeToDo.md"
  context.subscriptions.push(
    vscode.commands.registerCommand('amiAiClaw.runTodoFile', async () => {
      const folders = vscode.workspace.workspaceFolders ?? [];
      for (const folder of folders) {
        const uri = vscode.Uri.joinPath(folder.uri, 'AmiClawToClaudeToDo.md');
        try {
          await vscode.workspace.fs.stat(uri);   // 確認檔案存在
          await processTodoFile(uri);
          return;
        } catch { /* 此 folder 沒有該檔案，繼續找下一個 */ }
      }
      vscode.window.showWarningMessage('找不到 AmiClawToClaudeToDo.md（請放在任一 workspace 根目錄）');
    })
  );

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
      await OllamaChatPanel.createOrShow(context);
      const uris = allUris && allUris.length > 0 ? allUris : (uri ? [uri] : []);
      if (uris.length > 0) {
        await OllamaChatPanel.sendUrisToChat(uris);
      }
    })
  );

  // 聚焦輸入框 (快捷鍵 Ctrl+L)
  context.subscriptions.push(
    vscode.commands.registerCommand('amiAiClaw.focusInput', async () => {
      await OllamaChatPanel.createOrShow(context);
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

  // UEFI Code Review 快速指令
  context.subscriptions.push(
    vscode.commands.registerCommand('amiAiClaw.uefiCodeReview', async () => {
      type ReviewInput = { label: string; description: string; id: string };
      const inputs: ReviewInput[] = [
        { label: '$(git-commit)  特定 Commit', description: '輸入 Commit SHA', id: 'commit' },
        { label: '$(git-pull-request)  Staged Changes', description: 'git add 後尚未 commit', id: 'staged' },
        { label: '$(diff)  Unstaged Changes', description: '工作區未 stage 的修改', id: 'unstaged' },
        { label: '$(git-branch)  Diff Range', description: '例：HEAD~3..HEAD', id: 'range' },
        { label: '$(file-code)  Patch 檔案', description: '指定 .patch 檔案路徑', id: 'patch' },
        { label: '$(file)  指定檔案', description: '指定一個或多個原始檔', id: 'files' },
        { label: '$(folder)  Folder Diff (ORG vs MOD)', description: '比較兩個資料夾', id: 'folder' },
      ];

      const picked = await vscode.window.showQuickPick(inputs, {
        title: 'UEFI Code Review — 選擇輸入來源',
        placeHolder: '選擇要 review 的內容…',
        matchOnDescription: true,
      });
      if (!picked) { return; }

      let target = '';
      switch (picked.id) {
        case 'commit': {
          const sha = await vscode.window.showInputBox({ prompt: '輸入 Commit SHA', placeHolder: '例：527d65b0' });
          if (!sha) { return; }
          target = `the changes introduced in this commit ID: ${sha.trim()}`;
          break;
        }
        case 'staged':    target = 'the staged changes'; break;
        case 'unstaged':  target = 'the unstaged changes'; break;
        case 'range': {
          const range = await vscode.window.showInputBox({ prompt: '輸入 diff range', placeHolder: '例：HEAD~3..HEAD', value: 'HEAD~1..HEAD' });
          if (!range) { return; }
          target = `the changes in the diff range ${range.trim()}`;
          break;
        }
        case 'patch': {
          const uris = await vscode.window.showOpenDialog({ filters: { 'Patch files': ['patch', 'diff'] }, canSelectMany: false, title: '選擇 patch 檔案' });
          if (!uris || uris.length === 0) { return; }
          target = `this ${uris[0].fsPath}`;
          break;
        }
        case 'files': {
          const f = await vscode.window.showInputBox({ prompt: '輸入檔案路徑（以空格分隔）', placeHolder: '例：AmiModulePkg/Usb/Pei/UsbPei.c' });
          if (!f) { return; }
          target = f.trim();
          break;
        }
        case 'folder': {
          const mod = await vscode.window.showInputBox({ prompt: '修改後資料夾路徑 (MOD)', placeHolder: '例：MyFeature/MOD' });
          if (!mod) { return; }
          const org = await vscode.window.showInputBox({ prompt: '原始資料夾路徑 (ORG)', placeHolder: '例：MyFeature/ORG' });
          if (!org) { return; }
          target = `by taking the diff between the ${mod.trim()} and ${org.trim()} folders`;
          break;
        }
        default: return;
      }

      // SourceTag
      const tagOptions = [
        { label: 'AptioV (預設)', description: 'AMI Aptio V UEFI BIOS', id: 'AptioV' },
        { label: 'AptioV + Unittesting', description: 'AptioV 含 Unit Test', id: 'AptioV, Unittesting' },
        { label: 'AptioPE', description: '純 UEFI/EDK2，無 AMI 建置系統', id: 'AptioPE' },
        { label: 'AMI Porting Changes Only', description: '只看 AMI porting 部分', id: '' },
      ];
      const tagPick = await vscode.window.showQuickPick(tagOptions, { title: 'SourceTag', placeHolder: '選擇 review 規則集…' });
      if (!tagPick) { return; }

      // Jira ID（可選）
      const jiraId = await vscode.window.showInputBox({ prompt: 'Jira ID（可留空）', placeHolder: '例：AOC-1234' }) ?? '';

      // 組合 prompt
      const sourceTagLine = tagPick.id ? `\nSourceTag: ${tagPick.id}` : '';
      const jiraLine = jiraId.trim() ? `\nJira Id: ${jiraId.trim()}` : '';
      const amiPortingLine = tagPick.id === '' ? ' AMI porting changes only' : '';
      const prompt = `Perform a code review of ${target}${amiPortingLine}.${sourceTagLine}${jiraLine}`;

      // externalAgentSend 會在 webview 側先呼叫 setInteractionMode('agent')，確保從 Team 切回 Agent
      openAndSend(context, { type: 'externalAgentSend', prompt });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('amiAiClaw.debugWriteMemory', async () => {
      const example = `# Demo MEMORY\n\nThis is a demo memory written at ${new Date().toISOString()}\n`;
      try {
        const mem = await import('./memdir/memdir');
        await mem.saveMemoryIndex(example);
        vscode.window.showInformationMessage('已寫入 MEMORY.md 至 memory 目錄（示範）');
      } catch (e) {
        vscode.window.showErrorMessage('寫入 MEMORY.md 失敗：' + (e instanceof Error ? e.message : String(e)));
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('amiAiClaw.migrateMemory', async () => {
      try {
        const mem = await import('./memdir/memdir');
        const res = await mem.migrateGlobalIndexToWorkspace();
        if (res.migrated) {
          vscode.window.showInformationMessage(`Memory migration completed (${res.details || 'ok'})`);
        } else {
          vscode.window.showInformationMessage(`Memory migration skipped: ${res.details || 'nothing to do'}`);
        }
      } catch (e) {
        vscode.window.showErrorMessage('Memory migration failed: ' + (e instanceof Error ? e.message : String(e)));
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('amiAiClaw.showMemoryPath', async () => {
      try {
        const paths = await import('./memdir/paths');
        const fs = await import('fs/promises');
        const wsDir = paths.getWorkspaceMemoryDir();
        const defDir = paths.getDefaultMemoryDir();
        let wsExists = false;
        let defExists = false;
        if (wsDir) {
          try { await fs.stat(wsDir); wsExists = true; } catch {}
        }
        try { await fs.stat(defDir); defExists = true; } catch {}
        const msg = `workspace: ${wsDir ?? '<none>'} (exists:${wsExists})\ndefault: ${defDir} (exists:${defExists})`;
        void vscode.window.showInformationMessage(msg, { modal: false } as any);
      } catch (e) {
        vscode.window.showErrorMessage('Cannot determine memory paths: ' + (e instanceof Error ? e.message : String(e)));
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('amiAiClaw.showFileCount', async () => {
      try {
        if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
          vscode.window.showInformationMessage('No workspace folder is open.');
          return;
        }
        // exclude common large folders
        const exclude = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**}';
        const uris = await vscode.workspace.findFiles('**/*', exclude);
        const count = uris.length;
        const msg = `Workspace file count: ${count.toLocaleString()} (excludes node_modules, .git, dist, out)`;
        const chan = vscode.window.createOutputChannel('AMI-AiClaw');
        chan.appendLine(msg);
        chan.show(true);
        vscode.window.showInformationMessage(msg);
      } catch (e) {
        vscode.window.showErrorMessage('Failed to count files: ' + (e instanceof Error ? e.message : String(e)));
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('amiAiClaw.execFileCountShell', async () => {
      try {
        if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
          vscode.window.showInformationMessage('No workspace folder is open.');
          return;
        }
        const activeUri = vscode.window.activeTextEditor?.document.uri;
        const wf = (activeUri && vscode.workspace.getWorkspaceFolder(activeUri)) ?? vscode.workspace.workspaceFolders[0];
        const root = wf.uri.fsPath;
        let cmd: string;
        if (process.platform === 'win32') {
          // Use PowerShell for reliable recursive file count
          cmd = `powershell -NoProfile -Command "(Get-ChildItem -Path '${root.replace(/'/g, "''")}' -File -Recurse -ErrorAction SilentlyContinue | Measure-Object).Count"`;
        } else {
          // POSIX: use ls -R | wc -l
          cmd = `sh -c "ls -R '${root.replace(/'/g, "'\\''")}' | wc -l"`;
        }

        const oc = vscode.window.createOutputChannel('AMI-AiClaw');
        oc.appendLine(`Running: ${cmd}`);
        oc.show(true);
        try {
          const { stdout, stderr } = await exec(cmd, { windowsHide: true, maxBuffer: 50 * 1024 * 1024 });
          if (stderr && String(stderr).trim()) oc.appendLine(String(stderr));
          const n = parseInt(String(stdout).trim().split(/\r?\n/).pop() || '', 10);
          if (!Number.isNaN(n)) {
            const msg = `Shell file count: ${n.toLocaleString()} (path: ${root})`;
            oc.appendLine(msg);
            vscode.window.showInformationMessage(msg);
            return;
          }
        } catch (e) {
          oc.appendLine('Shell command failed: ' + (e instanceof Error ? e.message : String(e)));
        }

        // Fallback to JS counting via workspace.findFiles
        oc.appendLine('Falling back to workspace.findFiles count...');
        const exclude = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**}';
        const uris = await vscode.workspace.findFiles('**/*', exclude);
        const count = uris.length;
        const msg = `Fallback file count: ${count.toLocaleString()} (excludes node_modules, .git, dist, out)`;
        oc.appendLine(msg);
        vscode.window.showInformationMessage(msg);
      } catch (e) {
        vscode.window.showErrorMessage('Failed to execute file-count: ' + (e instanceof Error ? e.message : String(e)));
      }
    })
  );
}

export function deactivate() {}
