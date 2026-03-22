// Copyright (c) 2026 YCHsu. All rights reserved.
// Licensed under the MIT License.
import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as os from 'os';
import { execSync } from 'child_process';
import { URL } from 'url';

// (Copied implementation from top-level file)
export class OllamaChatPanel {
  public static currentPanel: OllamaChatPanel | undefined;
  public static readonly viewType = 'amiAiClaw.chat';
  private static _log: vscode.OutputChannel;
  /** Called by extension.ts to keep sidebar in sync */
  public static onSessionsChanged?: (sessions: { id: string; title: string }[], activeId: string) => void;

  private readonly _panel: vscode.WebviewPanel;
  private readonly _disposables: vscode.Disposable[] = [];
  private _autoRunning = false;
  private _autoCancel = false;
  private _autoMaxIterations = 50;
  private _streamMode = false;
  private _agentRunning = false;
  private _agentCancel = false;
  private _agentMessagesBySession: Record<string, ChatMessage[]> = { default: [] };
  private _agentMessages: ChatMessage[] = this._agentMessagesBySession.default;
  private _agentTodos: { id: number; text: string; done: boolean }[] = [];
  private _teamCancel = false;
  private _atlasJiraCred: { baseApiUrl: string; accessToken: string; expiry: number } | null = null;
  private _rovoDevCache: { url: string; token: string; expiry: number } | undefined = undefined;
  private _rovoDevNullUntil = 0;
  /** 寫入/刪除/執行 永遠允許集合（session 內持續）*/
  private _alwaysAllow = new Set<string>();
  /** 稽核日誌：記錄所有 Agent 工具呼叫（記憶體內最近 200 筆）*/
  private _auditLog: Array<{ ts: number; session: string; tool: string; argsSnippet: string; error: boolean }> = [];
  /** 等待使用者確認的 pending promise resolve */
  private _pendingPermission: ((allow: boolean) => void) | null = null;
  /** Ask / Copilot 串流的取消 token source，新請求送出時先 cancel 前一個以避免舊回應混入 */
  private _pendingSendCts: vscode.CancellationTokenSource | null = null;
  /** 最後一次送出請求的 Ollama server URL + model（切換時需清 VRAM，但只在同一台 server）*/
  private _lastOllamaUrl = '';
  private _lastOllamaModel = '';
  /** Agent 工具快取：快取 list_dir / read_file 唯讀結果（30s TTL），寫入/刪除時自動失效 */
  private _toolCache = new Map<string, { value: string; ts: number }>();
  private static readonly TOOL_CACHE_TTL = 30_000;
  /** 使用量統計：各 model 累計 token 與 Copilot 費率 */
  private _usageStats: Record<string, { tokens: number; isCopilot: boolean; multiplier: string }> = {};
  /** Debate 即時換模型：key='A'|'B'|'J'，value=新 model id，每次 handleDebateSend 開始時重置 */
  private _debateSwap: { A?: string; B?: string; J?: string } = {};
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  private _context!: vscode.ExtensionContext;
  private _chatHistories: Record<string, ChatMessage[]> = { default: [] };
  private _activeSessionId = 'default';
  private _chatHistory: ChatMessage[] = this._chatHistories.default;

  private static log(msg: string): void {
    if (!vscode.workspace.getConfiguration('amiAiClaw').get<boolean>('enableDebugLog', false)) { return; }
    if (!OllamaChatPanel._log) {
      OllamaChatPanel._log = vscode.window.createOutputChannel('AMI-AiClaw');
    }
    OllamaChatPanel._log.appendLine(`[${new Date().toISOString()}] ${msg}`);
  }

  /** 記錄一次 API 呼叫的 token 使用量，並推送更新到前端。 */
  private trackUsage(model: string, tokens: number, multiplier = ''): void {
    if (!tokens || tokens <= 0) { return; }
    const isCopilot = model.startsWith('copilot::') || model.startsWith('copilot/');
    const key = model.replace(/^copilot[::\/]+/, '');
    const existing = this._usageStats[key];
    if (existing) {
      existing.tokens += tokens;
    } else {
      this._usageStats[key] = { tokens, isCopilot, multiplier };
    }
    // 持久化累計值
    const saved = this._context.globalState.get<Record<string, { tokens: number; isCopilot: boolean; multiplier: string }>>('amiAiClaw.usageStats') ?? {};
    const sk = saved[key];
    if (sk) { sk.tokens += tokens; } else { saved[key] = { tokens, isCopilot, multiplier }; }
    this._context.globalState.update('amiAiClaw.usageStats', saved);
    this._panel.webview.postMessage({ type: 'usageUpdate', stats: this._usageStats });
  }

  private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
    this._panel = panel;
    this._context = context;
    // 載入持久化的使用量統計
    this._usageStats = context.globalState.get<Record<string, { tokens: number; isCopilot: boolean; multiplier: string }>>('amiAiClaw.usageStats') ?? {};
    OllamaChatPanel.log('Constructor: start');
    vscode.window.showInformationMessage('AMI-AiClaw: Extension activated');

    // Seed long-term memory with Atlassian rules (re-seed when version tag changes)
    const LTM_SEED_VER = 'atlassian-v3';
    const existingLtm = context.globalState.get<string>('amiAiClaw.longTermMemory') ?? '';
    const atlassianSeed = `[${LTM_SEED_VER}]
【Atlassian for VS Code — atlassian.atlascode】

【強制規則，絕對不得違反】
1. 訊息中出現 [A-Z][A-Z0-9]*-\\d+（例 UOEM2-3476、BIOS-123）→ Jira Issue Key。
2. 分析 / RCA / 查看內容：第一步必須立即呼叫 jira_fetch，取得內容後再回答。
3. 「我將」「我會」「我打算」等宣告意圖而不伴隨工具呼叫，一律禁止。
4. 工具判斷：jira_fetch=取得內容供分析; jira_open=開 VS Code UI; jira_create=建立; jira_transition=轉狀態; bb_create_pr=開 PR; rovo_ask=問 Rovo Dev（回傳 AI 回覆，可含 Jira/Confluence 知識）。`;
    if (!existingLtm.includes(LTM_SEED_VER)) {
      // Remove any previous atlassian seed block before re-seeding
      const stripped = existingLtm.replace(/\[atlassian-v\d+\][\s\S]*?(?=\n\n\[|$)/g, '').trim();
      const seeded = stripped ? stripped + '\n\n' + atlassianSeed : atlassianSeed;
      context.globalState.update('amiAiClaw.longTermMemory', seeded);
    }

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(async message => {
      OllamaChatPanel.log('Received message: ' + message.type);
      try {
        switch (message.type) {
          case 'send':
            await this.handleSend(message.prompt, message.model, message.sessionId);
            break;
          case 'insert':
            await this.handleInsert(message.code);
            break;
          case 'toggleStream':
            this._streamMode = !!message.enabled;
            this._panel.webview.postMessage({ type: 'streamMode', enabled: this._streamMode });
            break;
          case 'summarize':
            await this.summarizeText(message.text, message.model);
            break;
          case 'startAuto':
            this.startAuto(message.prompt, message.model);
            break;
          case 'stopAuto':
            this._autoCancel = true;
            break;
          case 'fetchModels':
            await this.fetchModelsFromServer();
            break;
          case 'testConnection':
            await this.testConnectionStatus();
            break;
          case 'pickFile':
            await this.handlePickFile();
            break;
          case 'webviewReady':
            OllamaChatPanel.log('webviewReady received — calling fetchModelsFromServer');
            await this.fetchModelsFromServer();
            break;
          case 'agentSend':
            this.switchChatSession(message.sessionId);
            await this.handleAgent(message.prompt, message.model);
            break;
          case 'agentStop':
            this._agentCancel = true;
            break;
          case 'permissionResponse': {
            if (this._pendingPermission) {
              if (message.always) { this._alwaysAllow.add(message.category as string); }
              const resolve = this._pendingPermission;
              this._pendingPermission = null;
              resolve(!!message.allow);
            }
            break;
          }
          case 'fetchTeamModels':
            await this.fetchTeamModels();
            break;
          case 'teamSend':
            this.switchChatSession(message.sessionId);
            this.handleTeamSend(message.prompt, message.models, message.rounds, message.teamExecMode, message.maxParallel).catch(() => {});
            break;
          case 'teamStop':
            this._teamCancel = true;
            break;
          case 'debateSend':
            this.switchChatSession(message.sessionId);
            this.handleDebateSend(message.prompt, message.models, message.rounds).catch(() => {});
            break;
          case 'debateStop':
            this._teamCancel = true;
            break;
          case 'switchChatSession':
            this.switchChatSession(message.sessionId);
            this._panel.webview.postMessage({ type: 'historyCount', count: this._chatHistory.length, sessionId: this._activeSessionId });
            break;
          case 'applyToFile':
            await this.handleApplyToFile(message.code);
            break;
          case 'clearHistory':
            this._agentMessages = [];
            this._agentMessagesBySession[this._activeSessionId] = this._agentMessages;
            this.switchChatSession(message.sessionId);
            this._chatHistory = [];
            this._chatHistories[this._activeSessionId] = this._chatHistory;
            this._panel.webview.postMessage({ type: 'historyCount', count: 0, sessionId: this._activeSessionId });
            break;
          case 'memoryGet': {
            this.switchChatSession(message.sessionId);
            const cfg2 = vscode.workspace.getConfiguration('amiAiClaw');
            const persona2 = cfg2.get<string>('systemPrompt') ?? '';
            const previewMsgs = this._chatHistory.slice(-10);
            const historyPreview = previewMsgs.map(m => {
              const role = m.role === 'user' ? '👤 你' : '🤖 AI';
              const text = (m.content ?? '').slice(0, 200);
              return `${role}：${text}${(m.content ?? '').length > 200 ? '…' : ''}`;
            }).join('\n\n');
            this._panel.webview.postMessage({ type: 'memoryLoaded', ltm: this.getLongTermMemory(), persona: persona2, historyCount: this._chatHistory.length, historyPreview, sessionId: this._activeSessionId, usageStats: this._usageStats });
            break;
          }
          case 'memorySave':
            await this.saveLongTermMemory(message.ltm as string);
            this._panel.webview.postMessage({ type: 'memorySaved' });
            break;
          case 'exportChat': {
            // 將指定 session 的 _chatHistory 存檔
            const exportSid = (message.sessionId as string) || this._activeSessionId;
            const exportHist = this._chatHistories[exportSid] ?? [];
            const exportTitle = (message.title as string) || exportSid;
            const exportFmt = (message.format as string) || 'json';
            let exportContent = '';
            if (exportFmt === 'markdown') {
              exportContent = `# ${exportTitle}\n\n` + exportHist.map(m => {
                const role = m.role === 'user' ? '**👤 你**' : '**🤖 AI**';
                return `${role}\n\n${m.content ?? ''}\n`;
              }).join('\n---\n\n');
            } else {
              exportContent = JSON.stringify({ title: exportTitle, sessionId: exportSid, exportedAt: new Date().toISOString(), messages: exportHist }, null, 2);
            }
            const exportUri = await vscode.window.showSaveDialog({
              defaultUri: vscode.Uri.file(`${exportTitle.replace(/[/\\?%*:|"<>]/g, '_')}.${exportFmt === 'markdown' ? 'md' : 'json'}`),
              filters: exportFmt === 'markdown' ? { 'Markdown': ['md'] } : { 'JSON': ['json'] }
            });
            if (exportUri) {
              await vscode.workspace.fs.writeFile(exportUri, Buffer.from(exportContent, 'utf-8'));
              this._panel.webview.postMessage({ type: 'exportDone', path: exportUri.fsPath });
            }
            break;
          }
          case 'importChat': {
            const importUris = await vscode.window.showOpenDialog({
              canSelectMany: false,
              filters: { 'JSON 對話': ['json'] },
              title: '匯入對話 JSON'
            });
            if (!importUris || !importUris[0]) { break; }
            try {
              const raw = Buffer.from(await vscode.workspace.fs.readFile(importUris[0])).toString('utf-8');
              const parsed = JSON.parse(raw) as { title?: string; sessionId?: string; messages?: { role: string; content?: string }[] };
              if (!Array.isArray(parsed.messages)) { throw new Error('無效的 JSON 格式：缺少 messages 陣列'); }
              const importId = 'chat-import-' + Date.now();
              const importTitle = (parsed.title ?? '匯入的對話').slice(0, 30);
              this._chatHistories[importId] = parsed.messages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content ?? '' }));
              this._panel.webview.postMessage({ type: 'importDone', sessionId: importId, title: importTitle });
            } catch (e) {
              this._panel.webview.postMessage({ type: 'error', text: '匯入失敗：' + (e instanceof Error ? e.message : String(e)) });
            }
            break;
          }
          case 'searchConversations': {
            const q = ((message.query as string) || '').toLowerCase().trim();
            if (!q) { this._panel.webview.postMessage({ type: 'searchResults', results: [] }); break; }
            const results: { sessionId: string; title: string; snippet: string }[] = [];
            for (const [sid, hist] of Object.entries(this._chatHistories)) {
              for (const m of hist) {
                const text = (m.content ?? '').toLowerCase();
                const idx = text.indexOf(q);
                if (idx !== -1) {
                  const start = Math.max(0, idx - 30);
                  const snippet = (idx > 30 ? '\u2026' : '') + (m.content ?? '').slice(start, start + 120) + (start + 120 < (m.content ?? '').length ? '\u2026' : '');
                  results.push({ sessionId: sid, title: sid, snippet });
                  break; // one hit per session
                }
              }
            }
            this._panel.webview.postMessage({ type: 'searchResults', results });
            break;
          }
          case 'resetUsage':
            this._usageStats = {};
            this._context.globalState.update('amiAiClaw.usageStats', {});
            this._panel.webview.postMessage({ type: 'usageUpdate', stats: {} });
            break;
          case 'debateSwapModel':
            if (message.speaker === 'A' || message.speaker === 'B' || message.speaker === 'J') {
              this._debateSwap[message.speaker as 'A' | 'B' | 'J'] = message.modelId;
            }
            break;
          case 'memoryConsolidate':
            await this.handleMemoryConsolidate(message.sessionId);
            break;
          case 'saveModel': {
            const newModel = message.model as string;
            if (newModel) {
              const cfg3 = vscode.workspace.getConfiguration('amiAiClaw');
              await cfg3.update('model', newModel, vscode.ConfigurationTarget.Global);
              OllamaChatPanel.log('saveModel: ' + newModel);
            }
            break;
          }
          case 'openSettings':
            vscode.commands.executeCommand('workbench.action.openSettings', 'amiAiClaw.systemPrompt');
            break;
          case 'editMessage': {
            // 訊息編輯：截斷歷史到第 userIdx 個 user 訊息之前，再重新送出
            this.switchChatSession(message.sessionId);
            const editUserIdx = message.userIdx as number;
            let uc2 = 0, histCut = 0;
            for (let i = 0; i < this._chatHistory.length; i++) {
              if (this._chatHistory[i].role === 'user') {
                if (uc2 === editUserIdx) { histCut = i; break; }
                uc2++;
              }
            }
            this._chatHistory = this._chatHistory.slice(0, histCut);
            this._chatHistories[this._activeSessionId] = this._chatHistory;
            this._agentMessages = [];
            this._agentMessagesBySession[this._activeSessionId] = this._agentMessages;
            await this.handleSend(message.newText as string, message.model as string | undefined, message.sessionId);
            break;
          }
          case 'forkSession': {
            // 對話分支：依 userCount 複製歷史，建立新 session
            this.switchChatSession(message.sessionId);
            const forkUserCount = message.userCount as number;
            let uc3 = 0, histEnd = this._chatHistory.length;
            for (let i = 0; i < this._chatHistory.length; i++) {
              if (this._chatHistory[i].role === 'user') {
                uc3++;
                if (uc3 === forkUserCount) {
                  // Include this user msg + all subsequent non-user msgs up to next user msg
                  histEnd = i + 1;
                  while (histEnd < this._chatHistory.length && this._chatHistory[histEnd].role !== 'user') histEnd++;
                  break;
                }
              }
            }
            const forkId = 'session_' + Date.now();
            this._chatHistories[forkId] = this._chatHistory.slice(0, histEnd);
            this._agentMessagesBySession[forkId] = [];
            this._panel.webview.postMessage({ type: 'forkSessionDone', sessionId: forkId, forkHtml: message.forkHtml });
            break;
          }
          case 'notifySessionsChanged':
            if (OllamaChatPanel.onSessionsChanged && Array.isArray(message.sessions)) {
              OllamaChatPanel.onSessionsChanged(
                message.sessions as { id: string; title: string }[],
                typeof message.activeId === 'string' ? message.activeId : 'default'
              );
            }
            break;
          default:
            OllamaChatPanel.log('Unknown message type: ' + message.type);
            break;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        OllamaChatPanel.log('Message handler error: ' + msg);
        this._panel.webview.postMessage({ type: 'error', text: msg });
      }
    }, null, this._disposables);

    OllamaChatPanel.log('Setting webview HTML');
    this._panel.webview.html = this.getHtmlForWebview(this._panel.webview);
    OllamaChatPanel.log('HTML set, starting async IIFE');
    const _webview = this._panel.webview;
    const _self = this;
    (async () => {
      const cfg = vscode.workspace.getConfiguration('amiAiClaw');
      const ollamaUrls = getOllamaUrls(cfg);
      const liveModels: { id: string; label: string }[] = [];
      let connOk = false;
      let connMsg = '';
      let connUrl = ollamaUrls[0];
      for (const url of ollamaUrls) {
        try {
          const models = await ollamaListModels(url);
          for (const m of models) {
            liveModels.push({ id: encodeOllamaModelId(url, m, ollamaUrls), label: ollamaDisplayLabel(url, m, ollamaUrls) });
          }
          if (!connOk) { connOk = true; connMsg = ollamaUrls.length > 1 ? `${ollamaUrls.length} 台伺服器已連線` : 'OK'; connUrl = url; }
          OllamaChatPanel.log('Models from ' + url + ': ' + models.join(', '));
        } catch (e) {
          const emsg = e instanceof Error ? e.message : String(e);
          if (!connOk) { connMsg = emsg; connUrl = url; }
          OllamaChatPanel.log('Model fetch error from ' + url + ': ' + emsg);
        }
      }
      let copilotModels0: { id: string; name: string; multiplier: string }[] = [];
      try {
        const lms0 = await vscode.lm.selectChatModels({ vendor: 'copilot' });
        const seen0 = new Set<string>();
        for (const m of lms0) {
          if (!seen0.has(m.id)) { seen0.add(m.id); const n0 = (m.name || m.family).replace(/\s+\d+x\b|\s+x\d+\b/gi,'').trim(); copilotModels0.push({ id: m.id, name: n0, multiplier: getCopilotMultiplier(m) }); }
        }
      } catch { /* Copilot not available */ }
      const current = cfg.get<string>('model') ?? liveModels[0]?.id ?? '';
      // 預熱模型（keep_alive=600s）：讓 Ollama 提前載入，減少第一次請求延遲
      if (current && !current.startsWith('copilot::')) {
        const { url: warmUrl, model: warmModel } = decodeOllamaModel(current, ollamaUrls);
        ollamaWarmupModel(warmUrl, warmModel);
        OllamaChatPanel.log(`Model warmup (init): ${warmModel} @ ${warmUrl}`);
      }
      // Push result to webview via postMessage (safe: listener is already registered)
      const r1 = await _webview.postMessage({ type: 'modelList', models: liveModels, copilotModels: copilotModels0, current });
      OllamaChatPanel.log('postMessage modelList delivered=' + r1);
      const r2 = await _webview.postMessage({ type: 'connectionStatus', ok: connOk, url: connUrl, message: connMsg });
      OllamaChatPanel.log('postMessage connectionStatus delivered=' + r2);
    })().catch((e) => { OllamaChatPanel.log('Async IIFE error: ' + (e instanceof Error ? e.message : String(e))); });
  }

  /** Send any message to the webview from outside the class (e.g. from extension.ts commands) */
  public postMessageToWebview(msg: object): void {
    this._panel.webview.postMessage(msg);
  }

  /** 顯示稽核日誌（Quick Pick 清單）—列出最近 200 筆 Agent 工具呼叫紀錄 */
  public showAuditLog(): void {
    type AuditEntry = { ts: number; session: string; tool: string; argsSnippet: string; error: boolean };
    const entries = this._context.globalState.get<AuditEntry[]>('amiAiClaw.auditLog') ?? [];
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

  public static createOrShow(context: vscode.ExtensionContext) {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (OllamaChatPanel.currentPanel) {
      OllamaChatPanel.currentPanel._panel.reveal(column, true);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      OllamaChatPanel.viewType,
      'AMI-AiClaw',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true }
    );

    OllamaChatPanel.currentPanel = new OllamaChatPanel(panel, context);
  }

  private resolveSessionId(sessionId?: string): string {
    const raw = typeof sessionId === 'string' ? sessionId.trim() : '';
    return raw || 'default';
  }

  private switchChatSession(sessionId?: string): void {
    const id = this.resolveSessionId(sessionId);
    if (!this._chatHistories[id]) {
      this._chatHistories[id] = [];
    }
    if (!this._agentMessagesBySession[id]) {
      this._agentMessagesBySession[id] = [];
    }
    this._activeSessionId = id;
    this._chatHistory = this._chatHistories[id];
    this._agentMessages = this._agentMessagesBySession[id];
  }

  /**
   * Send one or more URIs (files or folders) to the open chat panel as context.
   * Call AFTER createOrShow so currentPanel is guaranteed to exist.
   */
  public static async sendUrisToChat(uris: vscode.Uri[]): Promise<void> {
    const panel = OllamaChatPanel.currentPanel;
    if (!panel) { return; }

    // Small delay so the webview has time to initialize if it was just created
    await new Promise(r => setTimeout(r, 500));

    for (const uri of uris) {
      let stat: vscode.FileStat;
      try { stat = await vscode.workspace.fs.stat(uri); } catch { continue; }

      if (stat.type & vscode.FileType.Directory) {
        // Send directory listing
        const entries = await vscode.workspace.fs.readDirectory(uri);
        const listing = entries.map(([name, type]) =>
          (type & vscode.FileType.Directory) ? name + '/' : name
        ).join('\n');
        panel._panel.webview.postMessage({
          type: 'fileAttached',
          name: uri.fsPath,
          content: `[目錄列表]\n${listing}`
        });
      } else {
        // Send file content (limit to 500 KB)
        const MAX = 500 * 1024;
        const raw = await vscode.workspace.fs.readFile(uri);
        const content = raw.byteLength > MAX
          ? Buffer.from(raw).toString('utf8', 0, MAX) + '\n...(截斷)'
          : Buffer.from(raw).toString('utf8');
        panel._panel.webview.postMessage({
          type: 'fileAttached',
          name: uri.fsPath,
          content
        });
      }
    }
  }

  public dispose() {
    OllamaChatPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) { const d = this._disposables.pop(); if (d) { d.dispose(); } }
  }

  private getHtmlForWebview(_webview: vscode.Webview): string {
    const nonce = getNonce();
    const cfg = vscode.workspace.getConfiguration('amiAiClaw');
    const defaultModel = cfg.get<string>('model') ?? '';
    const models = cfg.get<string[]>('models') ?? (defaultModel ? [defaultModel] : []);
    const optionsHtml = models.map(m => `<option value="${m}" ${m === defaultModel ? 'selected' : ''}>${m}</option>`).join('');
    const sendKey = cfg.get<string>('sendKey') ?? 'Enter';

    return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>AMI-AiClaw</title>
    <style>
      *{box-sizing:border-box}
      body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial;margin:0;padding:0;height:100vh;display:flex;flex-direction:column;background:var(--vscode-editor-background);color:var(--vscode-editor-foreground)}
      #chat{flex:1;overflow-y:auto;padding:12px 14px;display:flex;flex-direction:column;gap:10px}
      .msg{max-width:100%;word-break:break-word}
      .msg.user .bubble{background:var(--vscode-button-background,#0e639c);color:var(--vscode-button-foreground,#fff);border-radius:14px 14px 4px 14px;padding:7px 12px;display:inline-block;max-width:88%}
      .msg.user{display:flex;justify-content:flex-end}
      .msg.assistant .bubble{background:var(--vscode-editorWidget-background,rgba(128,128,128,0.12));border-radius:4px 14px 14px 14px;padding:7px 12px;display:inline-block;max-width:96%}
      .msg.assistant{display:flex;justify-content:flex-start}
      pre{background:rgba(0,0,0,0.08);padding:8px;border-radius:4px;white-space:pre-wrap;margin:4px 0;font-size:0.88em}
      .bubble button{font-size:11px;padding:2px 7px;margin:3px 3px 0 0;cursor:pointer;border-radius:4px;background:rgba(128,128,128,0.15);border:1px solid rgba(128,128,128,0.25);color:inherit}
      #bottomBar{border-top:1px solid rgba(128,128,128,0.15);background:var(--vscode-editor-background);padding:6px 8px;display:flex;flex-direction:column;gap:4px}
      #topBar{display:flex;align-items:center;gap:6px;padding:0 2px 2px}
      #chatSessionSelect{max-width:170px;font-size:12px;padding:3px 6px;background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);border:1px solid var(--vscode-dropdown-border,rgba(128,128,128,0.4));border-radius:4px}
      #chatSearchBar{display:none;align-items:center;gap:4px;padding:2px 0}
      #chatSearchInput{flex:1;font-size:12px;padding:3px 8px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,rgba(128,128,128,0.4));border-radius:4px;outline:none}
      #chatSearchInput:focus{border-color:var(--vscode-focusBorder,#007fd4)}
      #chatSearchResults{font-size:11px;padding:4px 6px;background:var(--vscode-editor-background);border:1px solid rgba(128,128,128,0.2);border-radius:4px;max-height:160px;overflow-y:auto;display:none}
      .search-hit{padding:3px 6px;cursor:pointer;border-radius:3px}
      .search-hit:hover{background:rgba(128,128,128,0.15)}
      .search-hit-title{font-weight:600;font-size:11px}
      .search-hit-snippet{opacity:0.65;font-size:11px;white-space:pre-wrap;word-break:break-all}
      .session-tag{font-size:10px;padding:1px 5px;border-radius:9px;background:rgba(79,193,255,0.18);color:var(--vscode-editorInfo-foreground,#4fc1ff);margin-left:3px;vertical-align:middle}
      #modelSelect{flex:1;max-width:220px;font-size:12px;padding:3px 6px;background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);border:1px solid var(--vscode-dropdown-border,rgba(128,128,128,0.4));border-radius:4px}
      .icon-btn{background:none;border:none;cursor:pointer;padding:3px 6px;border-radius:4px;font-size:15px;color:var(--vscode-editor-foreground);opacity:0.7;line-height:1}
      .icon-btn:hover{opacity:1;background:rgba(128,128,128,0.15)}
      .icon-btn.active{color:var(--vscode-button-background,#0e639c);opacity:1}
      #inputRow{display:flex;align-items:flex-end;gap:6px}
      #prompt{flex:1;min-height:36px;max-height:160px;resize:none;padding:7px 10px;font-size:13px;font-family:inherit;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,rgba(128,128,128,0.4));border-radius:8px;outline:none;overflow-y:auto;line-height:1.4}
      #prompt:focus{border-color:var(--vscode-focusBorder,#007fd4)}
      #sendBtn{background:var(--vscode-button-background,#0e639c);color:var(--vscode-button-foreground,#fff);border:none;border-radius:8px;padding:7px 13px;cursor:pointer;font-size:16px;line-height:1;align-self:flex-end;flex-shrink:0}
      #sendBtn:disabled{opacity:0.4;cursor:default}
      #statusBar{font-size:11px;opacity:0.75;padding:1px 4px;text-align:center;min-height:14px}
      #attachedFiles{display:flex;flex-wrap:wrap;gap:3px;padding:0 2px}
      .file-chip{display:inline-flex;align-items:center;gap:3px;background:rgba(0,120,215,0.14);border:1px solid rgba(0,120,215,0.3);border-radius:10px;padding:1px 8px;font-size:11px}
      .file-chip .rm{padding:0 2px;font-size:12px;background:none;border:none;cursor:pointer;opacity:0.6;color:inherit;line-height:1}
      details.think { border:1px solid rgba(79,193,255,0.5); margin:8px 0 4px; padding:0; background:rgba(79,193,255,0.06); border-radius:6px; overflow:hidden; width:100% }
      details.think summary { background:rgba(79,193,255,0.2); padding:5px 10px; cursor:pointer; color:var(--vscode-editorInfo-foreground,#4fc1ff); font-size:0.83em; font-weight:600; user-select:none; list-style:none; display:flex; align-items:center; gap:6px }
      details.think summary .think-icon { display:inline-block; width:8px; height:8px; border-radius:50%; background:var(--vscode-editorInfo-foreground,#4fc1ff); flex-shrink:0 }
      details.think summary .think-icon.pulse { animation: pulse 1.2s ease-in-out infinite }
      @keyframes pulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:0.3;transform:scale(0.6)} }
      details.think summary::before { content:none }
      details.think[open] summary::before { content:none }
      details.think pre { margin:0; padding:6px 10px; white-space:pre-wrap; color:var(--vscode-editor-foreground); opacity:0.85; font-size:0.82em; max-height:96px; overflow-y:auto; background:transparent }
      .file-chip { display:inline-flex; align-items:center; gap:3px; background:rgba(0,120,215,0.14); border:1px solid rgba(0,120,215,0.3); border-radius:3px; padding:1px 6px; font-size:11px; margin:2px }
      .file-chip .rm { padding:0 2px; font-size:11px; background:none; border:none; cursor:pointer; opacity:0.6; color:inherit; line-height:1 }
      #attachedFiles { padding:2px 8px; display:flex; flex-wrap:wrap; min-height:0 }
      @keyframes blink{0%,80%,100%{opacity:.25}40%{opacity:1}}
      .loading-dots{display:inline-flex;align-items:center;gap:4px;padding:4px 2px}
      .loading-dots span{animation:blink 1.4s infinite both;display:inline-block;width:7px;height:7px;border-radius:50%;background:currentColor}
      .loading-dots span:nth-child(2){animation-delay:.16s}
      .loading-dots span:nth-child(3){animation-delay:.32s}
      .tool-step{border-left:3px solid var(--vscode-debugConsole-warningForeground,#cca700);margin:3px 0;padding:2px 8px;background:rgba(128,128,128,0.05);border-radius:2px;font-size:0.85em}
      .tool-step summary{cursor:pointer;color:var(--vscode-descriptionForeground,#999);list-style:none;padding:2px 0;user-select:none;display:flex;align-items:center;gap:4px}
      .tool-step summary::before{content:'▶  ';font-size:0.7em;flex-shrink:0}
      .tool-step[open] summary::before{content:'▼  ';font-size:0.7em}
      .tool-step[data-s=running] .step-status::after{content:' ⏳'}
      .tool-step[data-s=done] .step-status{color:var(--vscode-terminal-ansiGreen,#4ec94e)}
      .tool-step[data-s=done] .step-status::after{content:' ✓'}
      .tool-step[data-s=error] .step-status{color:var(--vscode-errorForeground,red)}
      .tool-step[data-s=error] .step-status::after{content:' ✗'}
      .tool-step pre{margin:3px 0;white-space:pre-wrap;font-size:0.82em;max-height:140px;overflow:auto;color:var(--vscode-descriptionForeground,#999);background:transparent}
      .code-block-wrap{margin:4px 0}
      .code-actions{display:flex;gap:4px;margin:2px 0 1px;flex-wrap:wrap}
      /* 團隊討論模式 */
      .team-member-node { width:100% }
      .team-member-node .bubble { border-left:3px solid; padding-left:10px; width:100% }
      .team-header { display:flex; align-items:center; gap:6px; padding:0 0 5px; border-bottom:1px solid rgba(128,128,128,0.12); margin-bottom:6px }
      .team-badge { border-radius:3px; padding:1px 8px; font-size:0.75em; font-weight:700; border:1px solid }
      .team-status-text { font-size:0.75em; opacity:0.65 }
      .team-synth-node .bubble { border-left:3px solid #f0c040; background:rgba(240,192,64,0.06); padding:8px 10px; width:100%; border-radius:6px }
      .team-synth-header { font-size:0.8em; font-weight:700; color:#f0c040; padding:0 0 5px; margin-bottom:6px; border-bottom:1px solid rgba(240,192,64,0.25) }
      .team-agent-header { text-align:center; color:#f7cc65; font-size:0.82em; font-weight:700; margin:14px 0 6px; padding:5px 0; border-top:1px dashed rgba(247,204,101,0.4); border-bottom:1px dashed rgba(247,204,101,0.4); letter-spacing:0.03em }
      .team-orchestrator-node .bubble { border-left:3px solid #f7cc65; background:rgba(247,204,101,0.05); padding:8px 10px; width:100%; border-radius:6px }
      .team-orchestrator-header { font-size:0.78em; font-weight:700; color:#f7cc65; display:flex; align-items:center; gap:6px; padding:0 0 5px; margin-bottom:5px; border-bottom:1px solid rgba(247,204,101,0.25) }
      .team-orchestrator-body { white-space:pre-wrap; font-size:0.85em; max-height:12em; overflow-y:auto; background:rgba(0,0,0,0.14); border-radius:4px; padding:4px 8px; margin-top:3px; }
      .team-task-label { font-size:0.78em; opacity:0.72; margin:3px 0 5px; font-style:italic; line-height:1.4; padding:2px 0 }
      .team-round-sep { font-size:0.73em; opacity:0.55; text-align:center; margin:7px 0 3px; border-top:1px solid rgba(128,128,128,0.18); padding-top:5px; letter-spacing:0.04em }
      .team-review-section { margin:5px 0 2px; padding:4px 8px; background:rgba(247,204,101,0.07); border-left:2px solid rgba(247,204,101,0.45); border-radius:3px; font-size:0.8em; line-height:1.5 }
      .team-review-label { font-weight:700; color:#f7cc65; margin-right:4px }
      .team-review-body { white-space:pre-wrap; opacity:0.9 }
      .team-round-approved { color:var(--vscode-terminal-ansiGreen,#4ec94e); font-weight:700; margin-left:4px }
      .team-round-iterate { color:#f7cc65; margin-left:4px }
      .response-body-collapsed { max-height:14em; overflow:hidden; position:relative }
      .response-body-collapsed::after { content:''; position:absolute; bottom:0; left:0; right:0; height:2.5em; background:linear-gradient(transparent, var(--vscode-editorWidget-background,rgba(30,30,30,0.95))) }
      /* Markdown 渲染 */
      .md-table{border-collapse:collapse;margin:6px 0;max-width:100%;font-size:0.88em;display:block;overflow-x:auto}
      .md-table th,.md-table td{border:1px solid rgba(128,128,128,0.3);padding:4px 9px;text-align:left;vertical-align:top;white-space:nowrap}
      .md-table th{background:rgba(128,128,128,0.12);font-weight:600}
      .md-table tbody tr:hover td{background:rgba(128,128,128,0.06)}
      .task-item{display:flex;align-items:baseline;gap:5px;padding:1px 0;line-height:1.5}
      .math-inline{font-family:Georgia,serif;color:var(--vscode-editorInfo-foreground,#4fc1ff);font-style:italic;background:rgba(79,193,255,0.08);padding:1px 4px;border-radius:3px;white-space:nowrap}
      .math-block{font-family:Georgia,serif;color:var(--vscode-editorInfo-foreground,#4fc1ff);font-style:italic;background:rgba(79,193,255,0.07);padding:6px 12px;border-radius:4px;display:block;margin:6px 0;white-space:pre-wrap;overflow-x:auto}
      .response-expand-btn { display:block; font-size:11px; padding:2px 10px; margin:4px 0 0; cursor:pointer; border-radius:4px; background:rgba(128,128,128,0.15); border:1px solid rgba(128,128,128,0.3); color:inherit; width:100%; text-align:center }
      .team-todos-panel { background:rgba(128,128,128,0.06); border:1px solid rgba(128,128,128,0.2); border-radius:6px; padding:6px 10px; margin:8px 0; width:100%; box-sizing:border-box }
      .team-todos-header { font-size:0.78em; font-weight:700; color:#f7cc65; margin-bottom:5px; display:flex; align-items:center; gap:5px }
      .team-todo-item { display:flex; align-items:flex-start; gap:5px; padding:2px 0; font-size:0.78em; line-height:1.5 }
      .team-todo-status { width:14px; text-align:center; flex-shrink:0; padding-top:1px }
      .team-todo-task { opacity:0.85; line-height:1.4; word-break:break-word }
      .team-todo-item.t-done .team-todo-task { text-decoration:line-through; opacity:0.42 }
      .team-todo-item.t-running .team-todo-task { color:#4fc1ff }
      .team-todo-worker { font-size:0.72em; opacity:0.5; margin-left:3px; font-style:italic; white-space:nowrap }
      /* 對話模式 */
      .debate-turn { margin:6px 0; border-radius:6px; overflow:hidden }
      .debate-turn-header { font-size:0.78em; font-weight:700; padding:3px 10px; display:flex; align-items:center; gap:5px }
      .debate-turn-body { padding:6px 10px; white-space:pre-wrap; font-size:0.87em; line-height:1.55 }
      .debate-consensus { text-align:center; font-size:0.82em; font-weight:700; color:var(--vscode-terminal-ansiGreen,#4ec94e); margin:8px 0; padding:5px 0; border-top:1px dashed rgba(128,128,128,0.3); border-bottom:1px dashed rgba(128,128,128,0.3) }
      .debate-ended { text-align:center; font-size:0.82em; opacity:0.6; margin:6px 0 }
      #debatePicker{display:none;padding:4px 8px 6px;border:1px solid rgba(128,128,128,0.25);border-radius:6px;margin:2px 0;background:rgba(128,128,128,0.05);max-height:130px;overflow-y:auto}
      #debatePicker.visible{display:block}
      #teamPicker{display:none;padding:4px 8px 6px;border:1px solid rgba(128,128,128,0.25);border-radius:6px;margin:2px 0;background:rgba(128,128,128,0.05);max-height:130px;overflow-y:auto}
      #teamPicker.visible{display:block}
      #teamPickerBar,#debatePickerBar{display:flex;align-items:center;gap:6px;margin-bottom:4px;flex-wrap:wrap}
      .team-pick-row{display:flex;align-items:center;gap:5px;padding:1px 2px}
      .team-pick-row label{font-size:12px;cursor:pointer;user-select:none}
      .tpl-copilot{color:#f7cc65}.tpl-ollama{color:#4fc1ff}
      .role-badge{font-size:10px;font-weight:700;padding:1px 5px;border-radius:10px;margin-left:5px;vertical-align:middle;white-space:nowrap}
      .role-badge-manager{background:#f7cc65;color:#1e1e1e}.role-badge-member{background:#4fc1ff;color:#1e1e1e}.role-badge-coordinator{background:#4ec9b0;color:#1e1e1e}.role-badge-discussor{background:#c586c0;color:#fff}.role-badge-agent{background:#ce9178;color:#1e1e1e}
      .team-pick-mini-btn{font-size:11px;padding:1px 7px;border-radius:3px;background:rgba(128,128,128,0.15);border:1px solid rgba(128,128,128,0.3);color:inherit;cursor:pointer}
      #teamPickerCount{font-size:11px;opacity:0.7}
      /* 記憶管理 Modal */
      #memModal{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:200;align-items:flex-start;justify-content:center;padding-top:40px}
      #memModal.open{display:flex}
      #memBox{background:var(--vscode-editor-background);border:1px solid rgba(128,128,128,0.35);border-radius:10px;padding:18px;width:min(540px,95vw);max-height:80vh;overflow-y:auto;display:flex;flex-direction:column;gap:12px;box-shadow:0 8px 32px rgba(0,0,0,0.4)}
      #memBox h3{margin:0;font-size:14px;font-weight:700;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid rgba(128,128,128,0.2);padding-bottom:10px}
      #memBox h3 .mem-close-btn{background:none;border:none;cursor:pointer;font-size:18px;opacity:0.6;color:inherit;padding:0 4px;line-height:1}
      #memBox h3 .mem-close-btn:hover{opacity:1}
      .mem-section{border:1px solid rgba(128,128,128,0.2);border-radius:6px;padding:10px 12px;display:flex;flex-direction:column;gap:6px}
      .mem-section-title{font-size:12px;font-weight:700;opacity:0.9;margin:0}
      .mem-section-desc{font-size:11px;opacity:0.6;margin:0;line-height:1.4}
      .mem-section textarea{width:100%;min-height:72px;max-height:200px;resize:vertical;font-size:12px;font-family:inherit;padding:6px 8px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,rgba(128,128,128,0.4));border-radius:5px;outline:none;line-height:1.5}
      .mem-section textarea:focus{border-color:var(--vscode-focusBorder,#007fd4)}
      .mem-section textarea[readonly]{opacity:0.75;cursor:default}
      .mem-row{display:flex;gap:6px;flex-wrap:wrap}
      .mem-btn{font-size:11px;padding:4px 10px;cursor:pointer;border-radius:4px;background:rgba(128,128,128,0.15);border:1px solid rgba(128,128,128,0.3);color:inherit}
      .mem-btn:hover{background:rgba(128,128,128,0.25)}
      .mem-btn.primary{background:var(--vscode-button-background,#0e639c);color:var(--vscode-button-foreground,#fff);border-color:transparent}
      .mem-btn.primary:hover{opacity:0.88}
      /* 使用量統計表格 */
      .usage-table{width:100%;border-collapse:collapse;font-size:11px;margin:2px 0}
      .usage-table th{opacity:0.6;font-weight:600;text-align:left;padding:2px 6px;border-bottom:1px solid rgba(128,128,128,0.25)}
      .usage-table td{padding:2px 6px;border-bottom:1px solid rgba(128,128,128,0.1);word-break:break-all}
      .usage-copilot td{color:var(--vscode-editorInfo-foreground,#4fc1ff)}
      /* 棋盤視覺化 */
      .debate-board{background:var(--vscode-editor-background,#1e1e1e);border:1px solid rgba(128,128,128,0.25);border-radius:4px;padding:6px 10px;font-family:Consolas,'Courier New',monospace;font-size:12px;line-height:1.4;white-space:pre;overflow-x:auto;margin:4px 0;color:var(--vscode-editor-foreground,#d4d4d4)}
      #debateSwapBar{padding:6px 8px;border-top:1px solid rgba(128,128,128,0.2);display:flex;flex-wrap:wrap;align-items:center;gap:4px}
      #debateSwapBar select{font-size:11px;padding:2px 4px;border-radius:3px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,rgba(128,128,128,0.4));max-width:130px}
      /* LTM 條目編輯器 */
      .ltm-tabs{display:flex;gap:2px;margin-bottom:0}
      .ltm-tab-btn{font-size:11px;padding:3px 12px;border-radius:4px 4px 0 0;background:rgba(128,128,128,0.1);border:1px solid rgba(128,128,128,0.25);cursor:pointer;color:inherit;opacity:0.65}
      .ltm-tab-btn.active{background:var(--vscode-editor-background);border-bottom:1px solid var(--vscode-editor-background);opacity:1;font-weight:700}
      .ltm-tag-filter{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:4px;min-height:20px}
      .ltm-tag-chip{font-size:10px;padding:1px 7px;border-radius:10px;background:rgba(79,193,255,0.12);border:1px solid rgba(79,193,255,0.3);cursor:pointer;color:#4fc1ff;white-space:nowrap;opacity:0.75}
      .ltm-tag-chip.all{background:rgba(128,128,128,0.12);border-color:rgba(128,128,128,0.3);color:inherit}
      .ltm-tag-chip.active{opacity:1;font-weight:700}
      .ltm-entry-list{display:flex;flex-direction:column;gap:2px;max-height:160px;overflow-y:auto;margin-bottom:4px;border:1px solid rgba(128,128,128,0.15);border-radius:4px;padding:3px 4px}
      .ltm-entry{display:flex;align-items:flex-start;gap:5px;padding:2px 3px;border-radius:3px}
      .ltm-entry:hover{background:rgba(128,128,128,0.08)}
      .ltm-entry-tag{font-size:10px;padding:1px 6px;border-radius:8px;background:rgba(79,193,255,0.18);color:#4fc1ff;white-space:nowrap;cursor:pointer;flex-shrink:0;border:none;font-family:inherit;line-height:1.6}
      .ltm-entry-tag.no-tag{background:rgba(128,128,128,0.15);color:inherit;cursor:default}
      .ltm-entry-text{flex:1;font-size:12px;line-height:1.45;word-break:break-word;cursor:pointer}
      .ltm-entry-text:hover{text-decoration:underline;text-decoration-style:dotted}
      .ltm-entry-del{background:none;border:none;cursor:pointer;color:inherit;opacity:0.35;padding:0 2px;font-size:13px;line-height:1;flex-shrink:0}
      .ltm-entry-del:hover{opacity:1;color:#f87070}
      .ltm-add-row{display:flex;gap:4px;align-items:center;margin-top:3px}
      .ltm-add-tag{width:80px;font-size:11px;padding:3px 6px;border-radius:4px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,rgba(128,128,128,0.4));outline:none}
      .ltm-add-text{flex:1;font-size:11px;padding:3px 6px;border-radius:4px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,rgba(128,128,128,0.4));outline:none}
      /* Permission dialog */
      #permissionBar{display:none;padding:8px 10px;background:rgba(247,150,50,0.12);border:1px solid rgba(247,150,50,0.5);border-radius:6px;margin:4px 0;gap:8px;flex-direction:column}
      #permissionBar.visible{display:flex}
      #permissionDesc{font-size:12px;line-height:1.5;word-break:break-all}
      #permissionBtns{display:flex;gap:6px;flex-wrap:wrap}
      .perm-btn{font-size:12px;padding:4px 12px;border-radius:4px;border:1px solid;cursor:pointer;font-weight:600}
      .perm-btn-allow{background:rgba(0,180,0,0.18);border-color:rgba(0,200,0,0.5);color:var(--vscode-terminal-ansiGreen,#4ec94e)}
      .perm-btn-allow:hover{background:rgba(0,180,0,0.32)}
      .perm-btn-always{background:rgba(0,122,204,0.2);border-color:rgba(0,140,240,0.5);color:#4fc1ff}
      .perm-btn-always:hover{background:rgba(0,122,204,0.32)}
      .perm-btn-deny{background:rgba(220,30,30,0.18);border-color:rgba(220,50,50,0.5);color:var(--vscode-terminal-ansiRed,#f87070)}
      .perm-btn-deny:hover{background:rgba(220,30,30,0.32)}
      /* 程式碼語法高亮 token（深色主题） */
      .hl-kw{color:#569cd6;font-weight:500}.hl-str{color:#ce9178}.hl-cmt{color:#6a9955;font-style:italic}.hl-num{color:#b5cea8}.hl-fn{color:#dcdcaa}.hl-type{color:#4ec9b0}
      /* 淺色主题覆寫 */
      body.vscode-light .hl-kw{color:#0000ff}body.vscode-light .hl-str{color:#a31515}body.vscode-light .hl-cmt{color:#008000}body.vscode-light .hl-num{color:#098658}body.vscode-light .hl-fn{color:#795e26}body.vscode-light .hl-type{color:#267f99}
      /* 程式碼塊標頭 */
      .code-block-header{display:flex;align-items:center;justify-content:space-between;padding:3px 10px;background:rgba(0,0,0,0.18);border-radius:4px 4px 0 0;font-size:11px;font-family:Consolas,'Courier New',monospace;opacity:0.75;user-select:none}
      body.vscode-light .code-block-header{background:rgba(0,0,0,0.07)}
      .code-block-wrap pre{border-radius:0 0 4px 4px;margin:0;overflow-x:auto}
      /* 訊息動作按鈕（編輯 / 分支） */
      .msg-actions{display:none;gap:3px;margin-top:3px;flex-wrap:wrap}
      .msg:hover .msg-actions,.msg.editing .msg-actions{display:flex}
      .msg-action-btn{font-size:10px;padding:1px 6px;border-radius:3px;background:rgba(128,128,128,0.12);border:1px solid rgba(128,128,128,0.25);cursor:pointer;color:inherit;opacity:0.65;line-height:1.5}
      .msg-action-btn:hover{opacity:1;background:rgba(128,128,128,0.22)}
      /* 內嵌編輯覆蓋層 */
      .user-edit-overlay{display:flex;flex-direction:column;gap:4px;width:100%}
      .user-edit-textarea{min-height:48px;max-height:200px;resize:vertical;padding:6px 8px;font-size:13px;font-family:inherit;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-focusBorder,#007fd4);border-radius:6px;outline:none;width:100%;box-sizing:border-box}
      .user-edit-actions{display:flex;gap:5px}
    </style>
  </head>
  <body>
    <div id="chat"></div>
    <div id="bottomBar">
      <div id="topBar">
        <select id="chatSessionSelect" aria-label="選擇聊天"></select>
        <button class="icon-btn" id="newChat" title="新增聊天">➕</button>
        <button class="icon-btn" id="renameChat" title="&#x8A2D;&#x5B9A;&#x8173;&#x5929;&#x6A19;&#x984C;">&#x1F3F7;&#xFE0F;</button>
        <button class="icon-btn" id="exportChat" title="&#x532F;&#x51FA;&#x5C0D;&#x8A71;">&#x1F4E4;</button>
        <button class="icon-btn" id="importChat" title="&#x532F;&#x5165;&#x5C0D;&#x8A71;">&#x1F4E5;</button>
        <button class="icon-btn" id="searchChatBtn" title="&#x641C;&#x5C0B;&#x6240;&#x6709;&#x5C0D;&#x8A71;">&#x1F50D;</button>
        <select id="modelSelect" aria-label="&#x9078;&#x64C7;&#x6A21;&#x578B;">${optionsHtml}</select><span id="modelMultiplier" style="font-size:11px;opacity:0.65;padding:0 3px;white-space:nowrap"></span>
        <button class="icon-btn" id="refreshModels" title="重整模型 / 測試連線">🔄</button>
        <button class="icon-btn" id="pickFile" title="附加檔案">📎</button>
        <button class="icon-btn" id="toggleStream" title="切換串流模式">⚡</button>
        <button class="icon-btn" id="agentMode" title="Agent 模式 (AI 可讀寫檔案、執行命令)">🤖</button>
        <button class="icon-btn" id="teamMode" title="團隊討論模式 (多個 AI 並行思考👥)">👥</button>
        <button class="icon-btn" id="debateMode" title="對話模式：2 個 AI 辯論/對弈，可加第 3 個裁判 ⚔️">⚔️</button>
        <button class="icon-btn" id="stopAgent" title="停止 Agent">⏹</button>
        <button class="icon-btn" id="memBtn" title="記憶管理">🧠</button>
        <button class="icon-btn" id="clear" title="清除對話">🗑</button>
        <button class="icon-btn" id="debugBtn" title="Debug Console" style="font-size:12px;">🐛</button>
        <span style="flex:1"></span>
        <span id="connStatus" style="font-size:11px;opacity:0.8">\u9023\u7dda\uff1a\u6aa2\u67e5\u4e2d\u2026</span>
      </div>
      <div id="attachedFiles"></div>
      <div id="chatSearchBar">
        <input id="chatSearchInput" type="text" placeholder="&#x641C;&#x5C0B;&#x6240;&#x6709;&#x5C0D;&#x8A71;&#x2026;">
        <button class="team-pick-mini-btn" id="chatSearchGo">&#x641C;&#x5C0B;</button>
        <button class="team-pick-mini-btn" id="chatSearchClose">&#x2715;</button>
      </div>
      <div id="chatSearchResults"></div>
      <div id="teamPicker">
        <div id="teamPickerBar">
          <span style="font-size:11px;font-weight:700">&#x1F465; 選擇團隊成員（最多 5 個）</span>
            <button class="team-pick-mini-btn" id="teamPickerRefresh">&#x1F504;</button>
            <label style="font-size:11px;margin-left:8px">模式：</label>
            <select id="teamModeSelect" style="font-size:11px;padding:3px 6px;border-radius:4px">
              <option value="task" selected>&#x1F9E9; 任務分解</option>
              <option value="discussion">&#x1F4AC; 討論模式</option>
              <option value="agent">&#x1F916; Agent 模式</option>
              <option value="manager">&#x1F3E2; 主管模式</option>
            </select>
            <label style="font-size:11px;margin-left:6px">回合：</label>
            <select id="teamRoundsSelect" style="font-size:11px;padding:3px 6px;border-radius:4px">
              <option value="10">10</option>
              <option value="20" selected>20</option>
              <option value="30">30</option>
              <option value="150">150</option>
              <option value="infinite">無限</option>
            </select>
            <label style="font-size:11px;margin-left:6px" title="同時執行的子任務上限">並行：</label>
            <select id="teamMaxParallelSelect" style="font-size:11px;padding:3px 6px;border-radius:4px" title="同時執行的子任務上限（1=完全序列）">
              <option value="1">1</option>
              <option value="2">2</option>
              <option value="3" selected>3</option>
              <option value="5">5</option>
            </select>
            <span style="flex:1"></span>
            <span id="teamPickerCount">0/5 已選</span>
        </div>
        <div id="teamPickerList"><span style="font-size:11px;opacity:0.6">載入中…</span></div>
      </div>
      <div id="debatePicker">
        <div id="debatePickerBar">
          <span style="font-size:11px;font-weight:700">&#x2694;&#xFE0F; 對話成員（2 個應戰，可加第 3 個裁判）</span>
            <button class="team-pick-mini-btn" id="debatePickerRefresh">&#x1F504;</button>
            <label style="font-size:11px;margin-left:8px">回合：</label>
            <select id="debateRoundsSelect" style="font-size:11px;padding:3px 6px;border-radius:4px">
              <option value="10">10</option>
              <option value="20" selected>20</option>
              <option value="30">30</option>
              <option value="150">150</option>
              <option value="infinite">無限</option>
              <option value="custom">自訂…</option>
            </select>
            <input type="number" id="debateRoundsCustomInput" min="1" max="9999" style="display:none;font-size:11px;width:56px;padding:2px 4px;border-radius:4px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,rgba(128,128,128,0.4))" placeholder="輪數">
            <span style="flex:1"></span>
            <span id="debatePickerCount">0/3 已選</span>
        </div>
        <div id="debatePickerList"><span style="font-size:11px;opacity:0.6">載入中…</span></div>
        <div id="debateSwapBar" style="display:none">
          <span style="font-size:11px;opacity:0.7">&#x2699;&#xFE0F; 即時換模型：</span>
          <label style="font-size:11px">A:</label><select id="debateSwapA"><option value="">─ 保持 ─</option></select>
          <label style="font-size:11px">B:</label><select id="debateSwapB"><option value="">─ 保持 ─</option></select>
          <label style="font-size:11px">J:</label><select id="debateSwapJ"><option value="">─ 保持 ─</option></select>
        </div>
      </div>
      <div id="inputRow">
        <textarea id="prompt" rows="1" placeholder="輸入訊息… (Enter 送出 / Ctrl+Enter 換行)"></textarea>
        <button id="sendBtn" title="送出 (Enter)">&#9658;</button>
      </div>
      <div id="permissionBar">
        <div id="permissionDesc"></div>
        <div id="permissionBtns">
          <button class="perm-btn perm-btn-allow" id="permAllow">✅ 允許（此次）</button>
          <button class="perm-btn perm-btn-always" id="permAlways">♾️ 永遠允許此類</button>
          <button class="perm-btn perm-btn-deny" id="permDeny">❌ 拒絕</button>
        </div>
      </div>
      <div id="statusBar"></div>
    </div>
    <div id="memModal">
      <div id="memBox">
        <h3>&#x1F9E0; 記憶管理 <button class="mem-close-btn" id="memClose">✕</button></h3>
        <div class="mem-section">
          <p class="mem-section-title">&#x1F4CB; 角色設定（System Prompt）</p>
          <p class="mem-section-desc">每次對話都自動套用，在 VS Code 設定中編輯</p>
          <textarea id="personaPreview" readonly rows="3" placeholder="（讀取中...）"></textarea>
          <div class="mem-row"><button class="mem-btn" id="editPersonaBtn">&#x2699;&#xFE0F; 在設定中編輯角色</button></div>
        </div>
        <div class="mem-section">
          <p class="mem-section-title">&#x1F5C2; 長期記憶（跨對話持續保存）</p>
          <p class="mem-section-desc">每次對話都會套用此記憶為背景知識。可寫入專案偏好、環境、重要事實等。</p>
          <div class="ltm-tabs">
            <button class="ltm-tab-btn active" id="ltmTabEntry">&#x1F4CB; 條目</button>
            <button class="ltm-tab-btn" id="ltmTabRaw">&#x1F4C4; 原始文字</button>
          </div>
          <div id="ltmEntryView">
            <div id="ltmTagFilter" class="ltm-tag-filter"></div>
            <div id="ltmEntryList" class="ltm-entry-list"><span style="font-size:11px;opacity:0.5">載入中…</span></div>
            <div class="ltm-add-row">
              <input type="text" class="ltm-add-tag" id="ltmAddTag" placeholder="#標籤（選填）" maxlength="24">
              <input type="text" class="ltm-add-text" id="ltmAddText" placeholder="新增記憶條目…（Enter 送出）">
              <button class="mem-btn primary" id="ltmAddBtn">&#xFF0B;</button>
            </div>
          </div>
          <div id="ltmRawView" style="display:none">
            <input id="ltmSearch" type="text" placeholder="&#x1F50D; 搜尋關鍵字…" style="width:100%;box-sizing:border-box;font-size:11px;padding:3px 8px;margin-bottom:4px;border-radius:4px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,rgba(128,128,128,0.4));outline:none">
            <textarea id="ltmArea" rows="7" placeholder="#標籤 條目內容&#10;例如：&#10;#環境 用 Windows 11 + WSL2&#10;#專案 此專案用 TypeScript strict mode&#10;- 無標籤的一般備忘（- 開頭）"></textarea>
          </div>
          <div class="mem-row">
            <button class="mem-btn primary" id="saveLtmBtn">&#x1F4BE; 儲存長期記憶</button>
            <button class="mem-btn" id="clearLtmBtn">&#x1F5D1; 清除</button>
            <button class="mem-btn" id="exportLtmBtn">&#x1F4E4; 匯出</button>
            <input type="file" id="importLtmInput" accept=".json" style="display:none">
            <button class="mem-btn" id="importLtmBtn">&#x1F4E5; 匯入</button>
          </div>
        </div>
        <div class="mem-section">
          <p class="mem-section-title">&#x1F4AC; 短期記憶（本次對話歷史）</p>
          <p class="mem-section-desc">關閉 Panel 後消失。AI 會記得本次對話中所有問答內容。</p>
          <p id="historyInfo" style="font-size:12px;margin:2px 0;">對話歷史：0 條訊息</p>
          <textarea id="historyPreview" readonly rows="5" placeholder="（開啟此面板時載入最近 10 條）" style="font-size:11px;opacity:0.85;background:var(--vscode-input-background,#1e1e1e);color:var(--vscode-input-foreground,#ccc);border:1px solid var(--vscode-input-border,#555);border-radius:4px;width:100%;box-sizing:border-box;padding:4px 6px;resize:vertical;margin:4px 0"></textarea>
          <div class="mem-row" style="gap:6px;flex-wrap:wrap">
            <button class="mem-btn primary" id="consolidateLtmBtn">&#x1F9E0; AI 整理為長期記憶</button>
            <button class="mem-btn" id="clearHistoryBtn2">&#x1F5D1; 清除對話歷史</button>
          </div>
          <p id="consolidateStatus" style="font-size:11px;opacity:0.7;margin:2px 0;display:none"></p>
        </div>
        <!-- 使用量統計 -->
        <div class="mem-section">
          <p class="mem-section-title">&#x1F4CA; API 使用量統計</p>
          <div id="usageTableWrap"><p style="font-size:11px;opacity:0.55;margin:2px 0">尚無資料</p></div>
          <div class="mem-row">
            <button class="mem-btn" id="resetUsageBtn">&#x1F5D1; 重置統計</button>
          </div>
        </div>
      </div>
    </div>
    <script nonce="${nonce}">
      // Pre-create debugPanel so errors from the main script are visible
      (function(){
        var dp = document.createElement('pre');
        dp.id = 'debugPanel';
        dp.style.cssText = 'display:block;position:fixed;top:0;left:0;right:0;z-index:9999;background:rgba(0,0,0,0.9);color:#f44;font-size:11px;padding:6px 10px;white-space:pre-wrap;font-family:Consolas,monospace;max-height:200px;overflow:auto;border-bottom:2px solid #f44;';
        dp.textContent = 'Loading...';
        document.body.appendChild(dp);
        window._debugLog = [];
        window.onerror = function(msg, src, line, col, err) {
          dp.style.display = 'block';
          dp.textContent += '\\nERR:' + msg + ' L' + line + ':' + col + (err && err.stack ? '\\n' + err.stack : '');
        };
      })();
    </script>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      var cfgSendKey = ${JSON.stringify(sendKey)};

      // ── Debug Console ──────
      window._debugLog = [];
      function dbg(msg) { var t = new Date().toISOString().slice(11,23); window._debugLog.push(t + ' ' + msg); var dp = document.getElementById('debugPanel'); if (dp && dp.style.display !== 'none') { dp.textContent = window._debugLog.slice(-10).join('\\n'); } }
      dbg('webview init start');
      var debugPanel = document.createElement('pre');
      debugPanel.id = 'debugPanel';
      debugPanel.style.cssText = 'display:none;position:fixed;top:0;left:0;right:0;z-index:9999;background:rgba(0,0,0,0.85);color:#0f0;font-size:11px;padding:6px 10px;overflow:hidden;white-space:pre-wrap;font-family:Consolas,monospace;max-height:160px;border-bottom:1px solid #0f0;';
      document.body.appendChild(debugPanel);
      window.onerror = function(msg, src, line, col) { dbg('ERROR: ' + msg + ' at line ' + line + ':' + col); return false; };

      // ── 使用者訊息計數 / 歷史長度追蹤 ────
      var _userMsgCount = 0;   // 已加入的 user message 數（用於 editMessage / forkSession）
      var _lastHistLen  = 0;   // 最近一次 historyCount 回傳的後端歷史長度
      var _lastTokenInfo = ''; // streamEnd 設定的 token 資訊文字（供 agentStatus restore 用）

      // ── 訊息處理 (最先掛上，避免後續程式碼拋例外導致 listener 遺失) ──────
      window.addEventListener('message', function(event) {
        try {
          const msg = event.data;
          dbg('MSG: ' + msg.type + (msg.ok !== undefined ? ' ok=' + msg.ok : '') + (msg.url ? ' url=' + msg.url : '') + (msg.message ? ' msg=' + msg.message : ''));
          if (debugPanel.style.display === 'block') { debugPanel.textContent = window._debugLog.join('\\n'); debugPanel.scrollTop = debugPanel.scrollHeight; }
          if (msg.type === 'assistant')          { clearPendingBubble(); _agentStepNode = null; _streamNode = null; setSendEnabled(true); appendMessage('assistant', msg.text, msg.thinking, msg.tokens); if (statusBar && msg.tokens) { var _aML = agentMode ? '\uD83E\uDD16 Agent \u6A21\u5F0F' : (teamMode ? '\uD83D\uDC65 Team \u6A21\u5F0F' : '\uD83D\uDCAC Ask \u6A21\u5F0F'); statusBar.textContent = _aML + '\u2003\u2014\u2003~' + msg.tokens + ' tokens'; } }
          else if (msg.type === 'streamStart')   { _streamNode = null; /* dots stay until first thinkChunk/assistantChunk */ }
          else if (msg.type === 'thinkChunk')    { appendThinkChunk(msg.chunk); }
          else if (msg.type === 'assistantChunk'){ appendChunk(msg.chunk); }
          else if (msg.type === 'streamAbort')   { if (_streamNode && chat.contains(_streamNode)) { _streamNode.remove(); } _streamNode = null; }
          else if (msg.type === 'streamEnd')     { _agentStepNode = null; setSendEnabled(true);
            var _sbE = _streamNode && chat.contains(_streamNode) ? _streamNode.querySelector('.bubble') : null;
            if (_sbE) {
              var _tb = _sbE.querySelector('.stream-token-badge');
              if (!_tb) { _tb = document.createElement('span'); _tb.className = 'stream-token-badge'; _tb.style.cssText = 'font-size:10px;opacity:0.5;margin-top:3px;display:block'; _sbE.appendChild(_tb); }
              if (_lastStreamTokens) {
                _tb.textContent = '~' + _lastStreamTokens + ' tokens  ' + _lastStreamTps.toFixed(1) + ' t/s';
              } else {
                // eval_count 未回傳時，依字元類型估算（CJK ≈ 1 token, ASCII ≈ 4 chars/token）
                var _rb = _sbE.querySelector('.response-body');
                var _est = 0;
                if (_rb) { var _t = _rb.textContent || ''; for (var _ci = 0; _ci < _t.length; _ci++) { _est += _t.codePointAt(_ci) > 0x2E7F ? 1 : 0.25; } _est = Math.max(1, Math.ceil(_est)); }
                if (!_est) { var _thinkPre = _sbE.querySelector('details.think pre.think-stream'); if (_thinkPre) { var _tt = _thinkPre.textContent || ''; for (var _tk = 0; _tk < _tt.length; _tk++) { _est += _tt.codePointAt(_tk) > 0x2E7F ? 1 : 0.25; } _est = Math.max(1, Math.ceil(_est)); } }
                if (_est) _tb.textContent = '\u2248' + _est + ' tokens (\u4f30\u7b97)';
              }
            }
            // 串流結束後重新渲染 response-body 為 Markdown
            if (_sbE) { rerenderBubbleMd(_sbE); }
            // 更新 statusBar 顯示 token 資訊
            if (statusBar) {
              var _modeLabel = agentMode ? '\uD83E\uDD16 Agent \u6A21\u5F0F' : (teamMode ? '\uD83D\uDC65 Team \u6A21\u5F0F' : '\uD83D\uDCAC Ask \u6A21\u5F0F');
              var _tokText = '';
              if (_lastStreamTokens) {
                _tokText = '~' + _lastStreamTokens + ' tokens  ' + _lastStreamTps.toFixed(1) + ' t/s';
              } else if (_sbE) {
                var _rbStat = _sbE.querySelector('.response-body');
                var _estStat = 0;
                if (_rbStat) { var _ts = _rbStat.textContent || ''; for (var _cj = 0; _cj < _ts.length; _cj++) { _estStat += _ts.codePointAt(_cj) > 0x2E7F ? 1 : 0.25; } _estStat = Math.max(1, Math.ceil(_estStat)); }
                if (!_estStat) { var _thinkPre2 = _sbE.querySelector('details.think pre.think-stream'); if (_thinkPre2) { var _tt2 = _thinkPre2.textContent || ''; for (var _tk2 = 0; _tk2 < _tt2.length; _tk2++) { _estStat += _tt2.codePointAt(_tk2) > 0x2E7F ? 1 : 0.25; } _estStat = Math.max(1, Math.ceil(_estStat)); } }
                if (_estStat) _tokText = '\u2248' + _estStat + ' tokens (\u4f30\u7b97)';
              }
              if (_tokText) {
                _lastTokenInfo = _modeLabel + '\u2003\u2014\u2003' + _tokText;
                statusBar.textContent = _lastTokenInfo;
              }
            }
            _streamNode = null; _lastStreamTokens = 0; _lastStreamTps = 0;
          }
          else if (msg.type === 'streamStats')   {
            _lastStreamTokens = msg.tokens; _lastStreamTps = msg.tps;
            var _sb = _streamNode && chat.contains(_streamNode) ? _streamNode.querySelector('.bubble') : null;
            if (_sb) {
              var _det = _sb.querySelector('details.think');
              if (_det) { var _lbl = _det.querySelector('.think-label'); var _secs = _det._thinkEnd ? Math.round((_det._thinkEnd - (_det._thinkStart||_det._thinkEnd)) / 1000) : 0; if (_lbl) _lbl.textContent = '\u{1F9E0} \u601d\u8003\u904e\u7a0b (' + msg.tokens + ' tokens, \u8017\u6642 ' + _secs + 's, ' + msg.tps.toFixed(1) + ' t/s)'; }
              var _tb2 = _sb.querySelector('.stream-token-badge'); if (!_tb2) { _tb2 = document.createElement('span'); _tb2.className = 'stream-token-badge'; _tb2.style.cssText = 'font-size:10px;opacity:0.5;margin-top:3px;display:block'; _sb.appendChild(_tb2); } _tb2.textContent = '~' + msg.tokens + ' tokens  ' + msg.tps.toFixed(1) + ' t/s';
            }
          }
          else if (msg.type === 'error')         { clearPendingBubble(); _agentStepNode = null; _streamNode = null; setSendEnabled(true); appendMessage('assistant', '\u932f\u8aa4\uff1a' + msg.text); }
          else if (msg.type === 'teamMemberStart') { createTeamMember(msg.id, msg.model, msg.color, msg.task); }
          else if (msg.type === 'teamThinkChunk')  { appendTeamThinkChunk(msg.id, msg.color, msg.chunk); }
          else if (msg.type === 'teamResponseChunk'){ appendTeamResponseChunk(msg.id, msg.chunk); }
          else if (msg.type === 'teamMemberEnd')   { finalizeTeamMember(msg.id); }
          else if (msg.type === 'teamOrchestratorStart') { createOrchestratorBubble(msg.model); }
          else if (msg.type === 'teamOrchestratorThinkChunk') { appendOrchestratorThinkChunk(msg.chunk); }
          else if (msg.type === 'teamOrchestratorChunk') { appendOrchestratorChunk(msg.chunk); }
          else if (msg.type === 'teamOrchestratorEnd')   { finalizeOrchestratorBubble(); }
          else if (msg.type === 'teamRoundStart')        { startTeamRound(msg.id, msg.round); }
          else if (msg.type === 'teamRoundReviewStart')  { startTeamReview(msg.id); }
          else if (msg.type === 'teamRoundReviewChunk')  { appendTeamReviewChunk(msg.id, msg.chunk); }
          else if (msg.type === 'teamRoundDone')         { finalizeTeamRound(msg.id, msg.approved); }
          else if (msg.type === 'teamSynthStart')  { createTeamSynthBubble(); }
          else if (msg.type === 'teamSynthChunk')  { appendTeamSynthChunk(msg.chunk); }
          else if (msg.type === 'teamEnd')         { if (!msg.agentFollows) { setSendEnabled(true); if (statusBar) statusBar.textContent = '\u5718隊討論完成'; } else { if (statusBar) statusBar.textContent = '\u5718隊討論完成，交棒給 Agent\u2026'; } }
          else if (msg.type === 'teamAgentStart')  { var tah = document.createElement('div'); tah.className = 'team-agent-header'; tah.textContent = '\uD83E\uDD16 Agent \u63A5\u529B\u57F7\u884C\u8A08\u5283\uFF08' + (msg.model||'') + '\uFF09'; chat.appendChild(tah); chat.scrollTop = chat.scrollHeight; }
          else if (msg.type === 'teamModelList')   { populateTeamPicker(msg.models); populateDebatePicker(msg.models); }
          else if (msg.type === 'teamTodoList')  { createTodoPanel(msg.tasks); }
          else if (msg.type === 'teamTodoStart') { updateTodo(msg.idx, 'running', msg.worker); }
          else if (msg.type === 'teamTodoDone')  { updateTodo(msg.idx, 'done'); }
          else if (msg.type === 'debateStart')   { _debateRunning = true; var _dsBar = document.getElementById('debateSwapBar'); if (_dsBar) _dsBar.style.display = 'flex'; createDebateHeader(msg.labelA, msg.labelB, msg.labelJ, msg.colorA, msg.colorB, msg.colorJ, msg.gameType, msg.speakerLabels, msg.speakerColors); }
          else if (msg.type === 'debateTurnStart') { startDebateTurn(msg.speaker, msg.round, msg.label, msg.color); }
          else if (msg.type === 'debateChunk')   { appendDebateChunk(msg.speaker, msg.chunk); }
          else if (msg.type === 'debateThinkChunk') { appendDebateThinkChunk(msg.speaker, msg.chunk); }
          else if (msg.type === 'debateTurnEnd') { finalizeDebateTurn(msg.speaker, msg.tokens, msg.tps); }
          else if (msg.type === 'debateEnd')     { _debateRunning = false; var _dsBar2 = document.getElementById('debateSwapBar'); if (_dsBar2) _dsBar2.style.display = 'none'; finalizeDebate(msg.consensus); setSendEnabled(true); if (statusBar) statusBar.textContent = '\u2694\ufe0f \u5c0d\u8a71\u7d50\u675f'; }
          else if (msg.type === 'agentStatus')   {
            if (msg.running) {
              if (statusBar) statusBar.textContent = '\u2699\ufe0f Agent \u57f7\u884c\u4e2d\u2026';
              _lastTokenInfo = '';
            } else {
              if (statusBar) statusBar.textContent = _lastTokenInfo || (agentMode ? '\ud83e\udd16 Agent \u6a21\u5f0f' : '');
            }
            setSendEnabled(!msg.running);
          }
          else if (msg.type === 'agentStep')     { appendAgentStep(msg.icon, msg.title, msg.fullPath); }
          else if (msg.type === 'agentStepDone') { finalizeAgentStep(msg.result, msg.isError); }
          else if (msg.type === 'permissionRequest') { showPermissionBar(msg.category, msg.description, msg.forceConfirm); }
          else if (msg.type === 'autoStatus')    { if (statusBar) statusBar.textContent = msg.running ? '\u23f3 \u81ea\u52d5\u57f7\u884c\u4e2d\u2026' : ''; setSendEnabled(!msg.running); }
          else if (msg.type === 'autoPaused')    { appendMessage('assistant', '\u5df2\u6682\u505c\uff0c\u9700\u5b58\u53d6 ' + (msg.path || '\u672a\u77e5\u8def\u5f91')); if (statusBar) statusBar.textContent = '\u23f8 \u6682\u505c'; }
          else if (msg.type === 'streamMode')    { const t = document.getElementById('toggleStream'); if (t) t.classList.toggle('active', msg.enabled); }
          else if (msg.type === 'modelList')     { dbg('modelList received: ' + (msg.models||[]).length + ' ollama + ' + (msg.copilotModels||[]).length + ' copilot'); updateModelSelect(msg.models, msg.current, msg.copilotModels); var _pickerModels = []; (msg.models||[]).forEach(function(m) { var id = (typeof m === 'string') ? m : m.id; var label = (typeof m === 'string') ? m : m.label; _pickerModels.push({ id: id, label: label, vendor: 'ollama' }); }); (msg.copilotModels||[]).forEach(function(cm) { _pickerModels.push({ id: 'copilot::' + cm.id, label: cm.name, vendor: 'copilot', multiplier: cm.multiplier || '' }); }); if (_pickerModels.length) { populateTeamPicker(_pickerModels); populateDebatePicker(_pickerModels); } }
          else if (msg.type === 'connectionStatus') { dbg('connectionStatus received ok=' + msg.ok + ' url=' + msg.url); updateConnStatus(msg.ok, msg.url, msg.message); }
          else if (msg.type === 'fileAttached')  { addFileChip(msg.name, msg.content); }
          else if (msg.type === 'memoryLoaded')  { onMemoryLoaded(msg); }
          else if (msg.type === 'memorySaved')   { var slb = document.getElementById('saveLtmBtn'); if (slb) { slb.textContent = '\u2713 \u5df2\u5132\u5b58'; setTimeout(function() { slb.textContent = '\uD83D\uDCBE \u5132\u5b58\u9577\u671f\u8a18\u61b6'; }, 1500); } }
          else if (msg.type === 'historyCount')  { if (!msg.sessionId || msg.sessionId === _activeChatSessionId) { var hii = document.getElementById('historyInfo'); if (hii) hii.textContent = '\u5c0d\u8a71\u6b77\u53f2\uff1a' + (msg.count || 0) + ' \u689d\u8a0a\u606f'; _lastHistLen = msg.count || 0; } }
          else if (msg.type === 'consolidateStart') { var cs = document.getElementById('consolidateStatus'); if (cs) { cs.style.display = ''; cs.textContent = '\u2699\ufe0f AI \u6574\u7406\u4e2d\u2026'; } var clb = document.getElementById('consolidateLtmBtn'); if (clb) clb.disabled = true; }
          else if (msg.type === 'consolidateChunk') { var cs2 = document.getElementById('consolidateStatus'); if (cs2) cs2.textContent = '\u2699\ufe0f AI \u6574\u7406\u4e2d\u2026 ' + (msg.chunk || '').slice(0, 40); }
          else if (msg.type === 'usageUpdate') { renderUsageTable(msg.stats); }
          else if (msg.type === 'consolidateDone') {
            var clb2 = document.getElementById('consolidateLtmBtn'); if (clb2) clb2.disabled = false;
            var cs3 = document.getElementById('consolidateStatus');
            if (msg.error) { if (cs3) { cs3.style.display = ''; cs3.textContent = '\u274c \u6574\u7406\u5931\u6557\uff1a' + msg.error; } }
            else if (msg.skipped) { if (cs3) { cs3.style.display = ''; cs3.textContent = '\u26a0\ufe0f \u5c0d\u8a71\u6b77\u53f2\u70ba\u7a7a\uff0c\u7121\u9700\u6574\u7406'; } }
            else { if (cs3) { cs3.style.display = ''; cs3.textContent = '\u2713 \u5df2\u6574\u7406\u4e26\u5132\u5b58\u5230\u9577\u671f\u8a18\u61b6'; } var a2 = document.getElementById('ltmArea'); if (a2) a2.value = msg.ltm || ''; renderLtmEntries(); chat.innerHTML = ''; _streamNode = null; _agentStepNode = null; _pendingBubble = null; saveActiveSessionSnapshot(); var hp2 = document.getElementById('historyPreview'); if (hp2) hp2.value = '（已整理並清除）'; var hii2 = document.getElementById('historyInfo'); if (hii2) hii2.textContent = '對話歷史：0 條訊息'; }
          }
          // --- Messages FROM extension host (sidebar commands) ---
          else if (msg.type === 'newChatSession') { createNewSession(); }
          else if (msg.type === 'switchChatSessionFromHost') { if (msg.sessionId) switchChatSession(msg.sessionId); }
          else if (msg.type === 'renameChatSessionFromHost') {
            var rnSess = null;
            for (var ri2 = 0; ri2 < _chatSessions.length; ri2++) { if (_chatSessions[ri2].id === msg.sessionId) { rnSess = _chatSessions[ri2]; break; } }
            if (rnSess && msg.title) { rnSess.title = msg.title; rnSess.manualTitle = true; renderChatSessionSelect(); persistSessionState(); }
          }
          else if (msg.type === 'exportDone')   { if (statusBar) statusBar.textContent = '\u2705 \u5df2\u532f\u51fa: ' + (msg.path || ''); setTimeout(function() { if (statusBar && statusBar.textContent.startsWith('\u2705 \u5df2\u532f\u51fa')) statusBar.textContent = ''; }, 3000); }
          else if (msg.type === 'importDone')   {
            _chatSeq += 1;
            var iSess = { id: msg.sessionId, title: msg.title || '\u532f\u5165\u5c0d\u8a71', html: '', manualTitle: true };
            _chatSessions.push(iSess);
            switchChatSession(msg.sessionId);
            if (statusBar) statusBar.textContent = '\u2705 \u5df2\u532f\u5165: ' + iSess.title;
            setTimeout(function() { if (statusBar && statusBar.textContent.startsWith('\u2705 \u5df2\u532f\u5165')) statusBar.textContent = ''; }, 3000);
          }
          else if (msg.type === 'searchResults') {
            if (!chatSearchResults) return;
            chatSearchResults.innerHTML = '';
            if (!msg.results || !msg.results.length) {
              chatSearchResults.style.display = '';
              chatSearchResults.innerHTML = '<div style="padding:4px 8px;opacity:0.6;font-size:11px">\u7121\u7b26\u5408\u7d50\u679c</div>';
              return;
            }
            chatSearchResults.style.display = '';
            msg.results.forEach(function(r) {
              // \u5c0d\u6620 session title
              var titleLabel = r.title;
              for (var si = 0; si < _chatSessions.length; si++) { if (_chatSessions[si].id === r.sessionId) { titleLabel = _chatSessions[si].title || r.sessionId; break; } }
              var row = document.createElement('div'); row.className = 'search-hit';
              row.innerHTML = '<div class="search-hit-title">' + titleLabel + '</div><div class="search-hit-snippet">' + r.snippet.replace(/</g,'&lt;') + '</div>';
              row.addEventListener('click', function() {
                switchChatSession(r.sessionId);
                if (chatSearchBar) chatSearchBar.style.display = 'none';
                if (chatSearchResults) chatSearchResults.style.display = 'none';
              });
              chatSearchResults.appendChild(row);
            });
          }
          // \u5c0d\u8a71\u5206\u652f\u5b8c\u6210 \u2014 \u5728\u524d\u7aef\u5efa\u7acb\u65b0\u5c0d\u8a71\u5206\u652f
          else if (msg.type === 'forkSessionDone') {
            saveActiveSessionSnapshot();
            _chatSeq += 1;
            var forkId = msg.sessionId;
            var forkSess = { id: forkId, title: '\uD83C\uDF3F \u5206\u652f ' + _chatSeq, html: msg.forkHtml || '', manualTitle: false };
            _chatSessions.push(forkSess);
            _activeChatSessionId = forkId;
            resetTransientNodes();
            chat.innerHTML = forkSess.html || '';
            _userMsgCount = chat.querySelectorAll('.msg.user').length;
            clearFiles();
            renderChatSessionSelect();
            vscode.postMessage({ type: 'switchChatSession', sessionId: forkId });
            persistSessionState();
            if (statusBar) statusBar.textContent = '\uD83C\uDF3F \u5df2\u5efa\u7acb\u5206\u652f\u5c0d\u8a71';
            setTimeout(function() { if (statusBar && statusBar.textContent.startsWith('\uD83C\uDF3F')) statusBar.textContent = ''; }, 3000);
          }
          // \u5c1a\u7126\u8f38\u5165\u6846\uff08\u5feb\u6377\u9375 Ctrl+L\uff09
          else if (msg.type === 'focusInput') { var pEl = document.getElementById('prompt'); if (pEl) pEl.focus(); }
        } catch(e) { dbg('CATCH: ' + (e && e.message ? e.message : String(e))); }
      });

      const chat = document.getElementById('chat');
      const prompt = document.getElementById('prompt');
      const modelSelect = document.getElementById('modelSelect');
      let streamMode = false;
      let attachedFiles = [];
      let _streamNode = null;
      let _lastStreamTokens = 0;
      let _lastStreamTps = 0;
      let _pendingBubble = null;
      let agentMode = true;
      let teamMode = false;
      let debateMode = false;
      let _debateRunning = false;
      let _agentStepNode = null;
      const _teamNodes = {}; // id -> { node, bubble, thinkNode, responseNode, charCount, thinkStart, thinkTimer }
      var _todosPanel = null;
      var _todoChecked = 0;
      let _synthNode = null;
      let _orchestratorNode = null;
      let _orchestratorModel = '';
      let _teamAvailModels = []; // [{id, label, vendor}]
      const _debateNodes = {}; // speaker -> { node, body, thinkNode, thinkChars, thinkStart, thinkTimer }
      let _debateLabelA = '', _debateLabelB = '', _debateLabelJ = '';
      let _debateColorA = '#4fc1ff', _debateColorB = '#ce9178', _debateColorJ = '#89d185';
      let _speakerLabels = {}; // speaker key -> display label (supports N-model discussion)
      let _speakerColors = {}; // speaker key -> color

      const sendBtn = document.getElementById('sendBtn');
      const statusBar = document.getElementById('statusBar');
      const chatSessionSelect = document.getElementById('chatSessionSelect');
      const newChatBtn = document.getElementById('newChat');
      const renameChatBtn = document.getElementById('renameChat');

      function defaultSessionState() {
        return { sessions: [{ id: 'default', title: '聊天 1', html: '', manualTitle: false }], activeId: 'default', seq: 1 };
      }

      const savedState = vscode.getState && vscode.getState();
      let _chatSessions = (savedState && Array.isArray(savedState.sessions) && savedState.sessions.length) ? savedState.sessions : defaultSessionState().sessions;
      let _activeChatSessionId = (savedState && savedState.activeId) ? savedState.activeId : 'default';
      let _chatSeq = (savedState && typeof savedState.seq === 'number') ? savedState.seq : 1;

      function getActiveSession() {
        for (var i = 0; i < _chatSessions.length; i++) {
          if (_chatSessions[i].id === _activeChatSessionId) return _chatSessions[i];
        }
        return null;
      }

      function persistSessionState() {
        if (!vscode.setState) return;
        vscode.setState({ sessions: _chatSessions, activeId: _activeChatSessionId, seq: _chatSeq });
        // Notify extension host (sidebar) of the current session list
        vscode.postMessage({
          type: 'notifySessionsChanged',
          sessions: _chatSessions.map(function(s) { return { id: s.id, title: s.title }; }),
          activeId: _activeChatSessionId
        });
      }

      function saveActiveSessionSnapshot() {
        var s = getActiveSession();
        if (!s) return;
        s.html = chat.innerHTML;
        persistSessionState();
      }

      function resetTransientNodes() {
        _streamNode = null; _agentStepNode = null; _pendingBubble = null;
        _synthNode = null; _orchestratorNode = null; _orchestratorModel = '';
        Object.keys(_teamNodes).forEach(function(k){ delete _teamNodes[k]; });
        Object.keys(_debateNodes).forEach(function(k){ delete _debateNodes[k]; });
      }

      function renderChatSessionSelect() {
        if (!chatSessionSelect) return;
        chatSessionSelect.innerHTML = '';
        _chatSessions.forEach(function(s) {
          var opt = document.createElement('option');
          var tags = (s.tags && s.tags.length) ? ' [' + s.tags.join(', ') + ']' : '';
          opt.value = s.id; opt.textContent = (s.title || s.id) + tags;
          if (s.id === _activeChatSessionId) opt.selected = true;
          chatSessionSelect.appendChild(opt);
        });
      }

      function switchChatSession(sessionId) {
        if (!sessionId) return;
        saveActiveSessionSnapshot();
        _activeChatSessionId = sessionId;
        var s = getActiveSession();
        if (!s) {
          s = { id: sessionId, title: '聊天', html: '', manualTitle: false };
          _chatSessions.push(s);
        }
        resetTransientNodes();
        chat.innerHTML = s.html || '';
        clearFiles();
        renderChatSessionSelect();
        vscode.postMessage({ type: 'switchChatSession', sessionId: _activeChatSessionId });
        persistSessionState();
      }

      function autoTitleFromPrompt(text) {
        var s = getActiveSession();
        if (!s || s.manualTitle) return;
        if (!s.title || /^聊天\s*\d+$/.test(s.title)) {
          var t = (text || '').replace(/\s+/g, ' ').trim();
          if (!t) return;
          s.title = t.length > 18 ? t.slice(0, 18) + '…' : t;
          renderChatSessionSelect();
          persistSessionState();
        }
      }

      function createNewSession() {
        saveActiveSessionSnapshot();
        _chatSeq += 1;
        var id = 'chat-' + Date.now() + '-' + _chatSeq;
        var s = { id: id, title: '聊天 ' + _chatSeq, html: '', manualTitle: false };
        _chatSessions.push(s);
        _activeChatSessionId = id;
        resetTransientNodes();
        chat.innerHTML = '';
        clearFiles();
        renderChatSessionSelect();
        vscode.postMessage({ type: 'switchChatSession', sessionId: _activeChatSessionId });
        persistSessionState();
      }

      function renameActiveSession() {
        var s = getActiveSession();
        if (!s) return;
        var title = window.prompt('請輸入聊天標題：', s.title || '');
        if (title === null) return;
        var t = title.trim();
        if (!t) return;
        s.title = t;
        s.manualTitle = true;
        // 標籤機能：詢問是否水設定標籤
        var tagInput = window.prompt('設定分類標籤（多個用逗號隔開，留空不變）：', (s.tags || []).join(', '));
        if (tagInput !== null) {
          var tags = tagInput.split(',').map(function(tg) { return tg.trim(); }).filter(function(tg) { return tg.length > 0; });
          s.tags = tags;
        }
        renderChatSessionSelect();
        persistSessionState();
      }

      function deleteChatSession(sessionId) {
        if (_chatSessions.length <= 1) return; // keep at least one session
        var idx = -1;
        for (var i = 0; i < _chatSessions.length; i++) { if (_chatSessions[i].id === sessionId) { idx = i; break; } }
        if (idx === -1) return;
        _chatSessions.splice(idx, 1);
        if (_activeChatSessionId === sessionId) {
          var newIdx = Math.min(idx, _chatSessions.length - 1);
          _activeChatSessionId = _chatSessions[newIdx].id;
          var ns = _chatSessions[newIdx];
          resetTransientNodes();
          chat.innerHTML = ns.html || '';
          clearFiles();
          vscode.postMessage({ type: 'switchChatSession', sessionId: _activeChatSessionId });
        }
        renderChatSessionSelect();
        persistSessionState();
      }

      renderChatSessionSelect();
      switchChatSession(_activeChatSessionId);
      if (chatSessionSelect) chatSessionSelect.addEventListener('change', function() { switchChatSession(chatSessionSelect.value); });
      if (newChatBtn) newChatBtn.addEventListener('click', function() { createNewSession(); });
      if (renameChatBtn) renameChatBtn.addEventListener('click', function() { renameActiveSession(); });

      // \u532f\u51fa\u5c0d\u8a71
      var exportChatBtn = document.getElementById('exportChat');
      if (exportChatBtn) exportChatBtn.addEventListener('click', function() {
        var s = getActiveSession();
        var fmt = window.confirm('\u9078\u64c7\u532f\u51fa\u683c\u5f0f\uff1a\u78ba\u5b9a = JSON\uff0c\u53d6\u6d88 = Markdown') ? 'json' : 'markdown';
        vscode.postMessage({ type: 'exportChat', sessionId: _activeChatSessionId, title: s ? s.title : '\u5c0d\u8a71', format: fmt });
      });
      // \u532f\u5165\u5c0d\u8a71
      var importChatBtn = document.getElementById('importChat');
      if (importChatBtn) importChatBtn.addEventListener('click', function() {
        vscode.postMessage({ type: 'importChat' });
      });
      // \u641c\u5c0b\u5c0d\u8a71
      var searchChatBtnEl = document.getElementById('searchChatBtn');
      var chatSearchBar = document.getElementById('chatSearchBar');
      var chatSearchInput = document.getElementById('chatSearchInput');
      var chatSearchResults = document.getElementById('chatSearchResults');
      var chatSearchGo = document.getElementById('chatSearchGo');
      var chatSearchClose = document.getElementById('chatSearchClose');
      if (searchChatBtnEl) searchChatBtnEl.addEventListener('click', function() {
        if (chatSearchBar) chatSearchBar.style.display = chatSearchBar.style.display === 'flex' ? 'none' : 'flex';
        if (chatSearchResults) chatSearchResults.style.display = 'none';
        if (chatSearchInput) { chatSearchInput.value = ''; chatSearchInput.focus(); }
      });
      if (chatSearchClose) chatSearchClose.addEventListener('click', function() {
        if (chatSearchBar) chatSearchBar.style.display = 'none';
        if (chatSearchResults) chatSearchResults.style.display = 'none';
      });
      function doSearchConversations() {
        var q = chatSearchInput ? chatSearchInput.value.trim() : '';
        if (!q) return;
        vscode.postMessage({ type: 'searchConversations', query: q, sessions: _chatSessions.map(function(s) { return { id: s.id, title: s.title }; }) });
      }
      if (chatSearchGo) chatSearchGo.addEventListener('click', doSearchConversations);
      if (chatSearchInput) chatSearchInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') doSearchConversations(); });

      // auto-grow textarea
      function resizePrompt() {
        prompt.style.height = 'auto';
        prompt.style.height = Math.min(prompt.scrollHeight, 160) + 'px';
      }
      prompt.addEventListener('input', resizePrompt);

      // ── Jira key auto-detect ──────────────────────────────────────────────
      var _jiraChips = document.createElement('div');
      _jiraChips.id = 'jiraChips';
      _jiraChips.style.cssText = 'display:none;padding:2px 6px 4px;display:flex;flex-wrap:wrap;gap:4px;';
      prompt.parentNode.insertBefore(_jiraChips, prompt);
      var _jiraKeyRe = /\b([A-Z][A-Z0-9]*-\d+)\b/g;
      prompt.addEventListener('input', function() {
        _jiraChips.innerHTML = '';
        var text = prompt.value;
        var keys = [];
        var m2;
        _jiraKeyRe.lastIndex = 0;
        while ((m2 = _jiraKeyRe.exec(text)) !== null) {
          if (keys.indexOf(m2[1]) === -1) keys.push(m2[1]);
        }
        if (keys.length === 0) { _jiraChips.style.display = 'none'; return; }
        _jiraChips.style.display = 'flex';
        keys.forEach(function(key) {
          var chip = document.createElement('button');
          chip.textContent = '\uD83C\uDFAB ' + key;
          chip.title = '\u958b\u555f Jira Issue: ' + key;
          chip.style.cssText = 'font-size:11px;padding:2px 8px;border-radius:10px;background:rgba(0,122,204,0.25);border:1px solid rgba(0,122,204,0.5);color:inherit;cursor:pointer;';
          chip.addEventListener('click', function() {
            vscode.postMessage({ type: 'agentSend', prompt: '\u5f9e Jira \u67e5\u770b Issue ' + key, model: modelSelect ? modelSelect.value : undefined });
          });
          _jiraChips.appendChild(chip);
        });
      });

      // ── 送出 helper ──────────────────────────────────────────────────────
      function appendLoadingBubble() {
        if (_pendingBubble) { _pendingBubble.remove(); _pendingBubble = null; }
        const node = document.createElement('div'); node.className = 'msg assistant';
        const bub = document.createElement('div'); bub.className = 'bubble';
        const dots = document.createElement('span'); dots.className = 'loading-dots';
        dots.innerHTML = '<span></span><span></span><span></span>';
        bub.appendChild(dots); node.appendChild(bub);
        chat.appendChild(node); chat.scrollTop = chat.scrollHeight;
        _pendingBubble = node;
      }
      function clearPendingBubble() {
        if (_pendingBubble) { _pendingBubble.remove(); _pendingBubble = null; }
      }

      function doSend() {
        const text = prompt.value.trim(); if (!text) return;
        const m = modelSelect ? modelSelect.value : undefined;
        const label = text.length > 60 ? text.slice(0, 60) + '\u2026' : text;
        autoTitleFromPrompt(text);
        appendMessage('user', label + (attachedFiles.length ? ' (\uD83D\uDCCE ' + attachedFiles.length + ')' : ''), undefined, undefined, text);
        if (teamMode) {
            var selModels = getSelectedTeamModels();
            var roundsEl = document.getElementById('teamRoundsSelect');
            var roundsVal = roundsEl ? roundsEl.value : '20';
            var teamModeEl = document.getElementById('teamModeSelect');
            var teamExecMode = teamModeEl ? teamModeEl.value : 'task';
            var maxParEl = document.getElementById('teamMaxParallelSelect');
            var maxParVal = maxParEl ? parseInt(maxParEl.value) : 3;
            var tModeLabel = teamExecMode === 'discussion' ? '\u{1F4AC} \u8a0e\u8ad6\u4e2d\u2026' : teamExecMode === 'agent' ? '\u{1F916} Agent \u57f7\u884c\u4e2d\u2026' : teamExecMode === 'manager' ? '\u{1F3E2} \u4e3b\u7ba1\u6a21\u5f0f\u57f7\u884c\u4e2d\u2026' : '\u{1F465} \u5718\u968a\u8a0e\u8ad6\u4e2d\u2026';
            vscode.postMessage({ type: 'teamSend', prompt: buildPromptWithFiles(text), models: selModels, rounds: roundsVal, teamExecMode: teamExecMode, maxParallel: maxParVal, sessionId: _activeChatSessionId });
            prompt.value = ''; resizePrompt(); clearFiles(); setSendEnabled(false);
            if (statusBar) statusBar.textContent = tModeLabel;
            return;
        }
        if (debateMode) {
            var debSel = getSelectedDebateModels();
            var roundsElD = document.getElementById('debateRoundsSelect');
            var roundsValD = roundsElD ? roundsElD.value : '20';
            if (roundsValD === 'custom') {
              var customRoundsEl = document.getElementById('debateRoundsCustomInput');
              roundsValD = (customRoundsEl && customRoundsEl.value) ? customRoundsEl.value : '20';
            }
            vscode.postMessage({ type: 'debateSend', prompt: buildPromptWithFiles(text), models: debSel, rounds: roundsValD, sessionId: _activeChatSessionId });
            prompt.value = ''; resizePrompt(); clearFiles(); setSendEnabled(false);
            if (statusBar) statusBar.textContent = '\u2694\ufe0f \u5c0d\u8a71\u4e2d\u2026';
            return;
        }
        vscode.postMessage({ type: agentMode ? 'agentSend' : 'send', prompt: buildPromptWithFiles(text), model: m, sessionId: _activeChatSessionId });
        prompt.value = ''; resizePrompt(); clearFiles();
        setSendEnabled(false);
        appendLoadingBubble();
      }

      function setSendEnabled(on) {
        if (sendBtn) sendBtn.disabled = !on;
      }
      prompt.addEventListener('input', function() { setSendEnabled(prompt.value.trim().length > 0); });
      setSendEnabled(true);

      // Apply default agentMode=true state to UI
      document.getElementById('agentMode').classList.add('active');
      var _skHint = cfgSendKey === 'Ctrl+Enter' ? 'Ctrl+Enter \u9001\u51fa' : 'Enter \u9001\u51fa';
      prompt.placeholder = '\u8f38\u5165\u4efb\u52d9\u2026 Agent \u6703\u81ea\u52d5\u4f7f\u7528\u5de5\u5177 (' + _skHint + ')';
      if (statusBar) statusBar.textContent = '\uD83E\uDD16 Agent \u6a21\u5f0f';

      sendBtn.addEventListener('click', doSend);

      // Enter/Ctrl+Enter 送出設定由 cfgSendKey 控制
      prompt.addEventListener('keydown', function(e) {
        if (cfgSendKey === 'Ctrl+Enter') {
          if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); doSend(); }
        } else {
          if (e.key === 'Enter' && !e.ctrlKey && !e.shiftKey && !e.altKey) { e.preventDefault(); doSend(); }
        }
      });

      document.getElementById('clear').addEventListener('click', function() {
        chat.innerHTML = ''; _streamNode = null; _agentStepNode = null; _pendingBubble = null;
        Object.keys(_teamNodes).forEach(function(k){ delete _teamNodes[k]; }); _synthNode = null; _orchestratorNode = null; _orchestratorModel = '';
        saveActiveSessionSnapshot();
        vscode.postMessage({ type: 'clearHistory', sessionId: _activeChatSessionId });
      });

      document.getElementById('agentMode').addEventListener('click', function() {
        agentMode = !agentMode;
        document.getElementById('agentMode').classList.toggle('active', agentMode);
        if (agentMode && teamMode) { teamMode = false; document.getElementById('teamMode').classList.remove('active'); document.getElementById('teamPicker').classList.remove('visible'); }
        if (agentMode && debateMode) { debateMode = false; document.getElementById('debateMode').classList.remove('active'); document.getElementById('debatePicker').classList.remove('visible'); }
        if (statusBar) statusBar.textContent = agentMode ? '\uD83E\uDD16 Agent \u6A21\u5F0F \u2014 AI \u53EF\u81EA\u52D5\u8B80\u5BEB\u6A94\u6848\u3001\u57F7\u884C\u547D\u4EE4' : '\uD83D\uDCAC Ask \u6A21\u5F0F \u2014 \u76F4\u63A5\u5C0D\u8A71\uFF0C\u4E0D\u4F7F\u7528\u5DE5\u5177';
        var _ph = cfgSendKey === 'Ctrl+Enter' ? 'Ctrl+Enter \u9001\u51fa' : 'Enter \u9001\u51fa';
        prompt.placeholder = agentMode ? '\u8f38\u5165\u4efb\u52d9\u2026 Agent \u6703\u81ea\u52d5\u4f7f\u7528\u5de5\u5177 (' + _ph + ')' : '\u8f38\u5165\u8a0a\u606f\u2026 (' + _ph + (cfgSendKey === 'Ctrl+Enter' ? ' / Enter \u63db\u884c' : ' / Ctrl+Enter \u63db\u884c') + ')';
      });

      document.getElementById('teamMode').addEventListener('click', function() {
        teamMode = !teamMode;
        document.getElementById('teamMode').classList.toggle('active', teamMode);
        if (teamMode && agentMode) { agentMode = false; document.getElementById('agentMode').classList.remove('active'); }
        if (teamMode && debateMode) { debateMode = false; document.getElementById('debateMode').classList.remove('active'); document.getElementById('debatePicker').classList.remove('visible'); }
        var picker = document.getElementById('teamPicker');
        if (picker) picker.classList.toggle('visible', teamMode);
        if (teamMode) { vscode.postMessage({ type: 'fetchTeamModels' }); if (statusBar) statusBar.textContent = '\u{1F465} \u9078\u64c7\u5718\u968a\u6210\u54e1\u5f8c\u8f38\u5165\u554f\u984c'; }
        else { if (statusBar) statusBar.textContent = ''; }
        prompt.placeholder = teamMode ? '\u8f38\u5165\u554f\u984c\u2026 \u6240\u9078 AI \u6703\u540c\u6642\u56de\u7b54 (Enter \u9001\u51fa)' : '\u8f38\u5165\u8a0a\u606f\u2026 (Enter \u9001\u51fa / Ctrl+Enter \u63db\u884c)';
      });
      var tpr = document.getElementById('teamPickerRefresh');
      if (tpr) tpr.addEventListener('click', function() { vscode.postMessage({ type: 'fetchTeamModels' }); });
      var tmodeEl = document.getElementById('teamModeSelect');
      if (tmodeEl) tmodeEl.addEventListener('change', function() { updateTeamRoleLabels(); });

      var debateModeBtn = document.getElementById('debateMode');
      if (debateModeBtn) debateModeBtn.addEventListener('click', function() {
        debateMode = !debateMode;
        debateModeBtn.classList.toggle('active', debateMode);
        if (debateMode && agentMode) { agentMode = false; document.getElementById('agentMode').classList.remove('active'); }
        if (debateMode && teamMode) { teamMode = false; document.getElementById('teamMode').classList.remove('active'); document.getElementById('teamPicker').classList.remove('visible'); }
        var dp = document.getElementById('debatePicker');
        if (dp) dp.classList.toggle('visible', debateMode);
        if (debateMode) { vscode.postMessage({ type: 'fetchTeamModels' }); if (statusBar) statusBar.textContent = '\u2694\ufe0f \u5c0d\u8a71\u6a21\u5f0f\uff1a\u9078 2 \u500b AI \u8f2f\u8ad6\uff0c\u53ef\u52a0\u5730 3 \u500b\u88c1\u5224'; }
        else { if (statusBar) statusBar.textContent = ''; }
        prompt.placeholder = debateMode ? '\u8f38\u5165\u8bae\u9898\u6216\u4efb\u52d9\u2026 (Enter \u9001\u51fa)' : '\u8f38\u5165\u8a0a\u606f\u2026 (Enter \u9001\u51fa / Ctrl+Enter \u63db\u884c)';
      });
      var dpr = document.getElementById('debatePickerRefresh');
      if (dpr) dpr.addEventListener('click', function() { vscode.postMessage({ type: 'fetchTeamModels' }); });
      var debateRoundsSelEl = document.getElementById('debateRoundsSelect');
      if (debateRoundsSelEl) debateRoundsSelEl.addEventListener('change', function() {
        var ci = document.getElementById('debateRoundsCustomInput');
        if (ci) ci.style.display = this.value === 'custom' ? '' : 'none';
      });
      ['A', 'B', 'J'].forEach(function(sp) {
        var swapSel = document.getElementById('debateSwap' + sp);
        if (swapSel) swapSel.addEventListener('change', function() {
          if (this.value) vscode.postMessage({ type: 'debateSwapModel', speaker: sp, modelId: this.value });
        });
      });

      document.getElementById('stopAgent').addEventListener('click', function() { vscode.postMessage({ type: 'agentStop' }); vscode.postMessage({ type: 'teamStop' }); });

      document.getElementById('toggleStream').addEventListener('click', function() {
        streamMode = !streamMode;
        vscode.postMessage({ type: 'toggleStream', enabled: streamMode });
        document.getElementById('toggleStream').classList.toggle('active', streamMode);
        if (statusBar) statusBar.textContent = streamMode ? '\u26a1 \u4e32\u6d41\u6a21\u5f0f\u958b\u555f' : '';
      });

      document.getElementById('pickFile').addEventListener('click', function() {
        vscode.postMessage({ type: 'pickFile' });
      });

      if (modelSelect) {
        modelSelect.addEventListener('change', function() {
          if (statusBar) statusBar.textContent = '\u6a21\u578b\uff1a' + modelSelect.value;
          var selOpt = modelSelect.options[modelSelect.selectedIndex];
          var multEl = document.getElementById('modelMultiplier');
          if (multEl) multEl.textContent = selOpt && selOpt.dataset.multiplier ? selOpt.dataset.multiplier : '';
          vscode.postMessage({ type: 'saveModel', model: modelSelect.value });
        });
      }

      // ── 附加檔案 ─────────────────────────────────────────────────────────
      function buildPromptWithFiles(text) {
        if (!attachedFiles.length) return text;
        return attachedFiles.map(function(f) {
          return '--- \u9644\u52a0\u6a94\u6848: ' + f.name + ' ---\\n' + f.content;
        }).join('\\n\\n') + '\\n\\n' + text;
      }

      function addFileChip(name, content) {
        attachedFiles.push({ name: name, content: content });
        const af = document.getElementById('attachedFiles');
        const chip = document.createElement('span'); chip.className = 'file-chip';
        chip.appendChild(document.createTextNode('\uD83D\uDCCE ' + name + ' '));
        const rm = document.createElement('button'); rm.className = 'rm'; rm.textContent = '\u00D7'; rm.title = '\u79fb\u9664';
        rm.addEventListener('click', function() {
          attachedFiles = attachedFiles.filter(function(f) { return f.name !== name; });
          chip.remove();
        });
        chip.appendChild(rm); af.appendChild(chip);
      }

      function clearFiles() {
        attachedFiles = [];
        const af = document.getElementById('attachedFiles'); if (af) af.innerHTML = '';
      }

      // ── 思考過程 ─────────────────────────────────────────────────────────
      function makeThinkBlock(text, open) {
        const d = document.createElement('details'); d.className = 'think'; if (open) d.setAttribute('open', '');
        const s = document.createElement('summary');
        const icon = document.createElement('span'); icon.className = 'think-icon';
        const label = document.createElement('span'); label.className = 'think-label'; label.textContent = '\u601d\u8003\u904e\u7a0b';
        s.appendChild(icon); s.appendChild(label);
        const p = document.createElement('pre'); p.textContent = text;
        d.appendChild(s); d.appendChild(p); return d;
      }

      // ── 訊息 ─────────────────────────────────────────────────────────────
      // -- Markdown 渲染工具函式 -------------------------------------------
      function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
      function renderInline(txt) {
        // 先跳脫 HTML，再套用 inline 語法
        txt = escHtml(txt);
        // $$...$$ → 行內數學（保護，避免後面 $...$ 匹配）
        var PH = '\x02';
        txt = txt.replace(/\\$\\$([^$\\n]+?)\\$\\$/g, function(_,m){ return '<code class="math-inline">'+m+'</code>'; });
        // $...$ → 行內數學
        txt = txt.replace(/\\$([^$\\n]{1,80}?)\\$/g, function(_,m){ return '<code class="math-inline">'+m+'</code>'; });
        // **bold**
        txt = txt.replace(/\\*\\*([^*\\n]+?)\\*\\*/g, '<strong>$1</strong>');
        txt = txt.replace(/__([^_\\n]+?)__/g, '<strong>$1</strong>');
        // *italic*  (skip *** and **)
        txt = txt.replace(/(?<!\\*)\\*([^*\\n]+?)\\*(?!\\*)/g, '<em>$1</em>');
        // inline code (backtick)
        var BTCK = String.fromCharCode(96);
        var btRe = new RegExp(BTCK + '([^' + BTCK + '\\n]+?)' + BTCK, 'g');
        txt = txt.replace(btRe, function(_,c){ return '<code>'+c+'</code>'; });
        return txt;
      }
      function renderMdTable(tblLines) {
        var spl = function(r){ var c=r.split('|'); if(!c[0].trim())c.shift(); if(c.length&&!c[c.length-1].trim())c.pop(); return c; };
        var h='<table class="md-table"><thead><tr>';
        spl(tblLines[0]).forEach(function(c){ h+='<th>'+renderInline(c.trim())+'</th>'; });
        h+='</tr></thead><tbody>';
        for(var r=2;r<tblLines.length;r++){ if(!tblLines[r].trim())continue; h+='<tr>'; spl(tblLines[r]).forEach(function(c){ h+='<td>'+renderInline(c.trim())+'</td>'; }); h+='</tr>'; }
        return h+'</tbody></table>';
      }
      function renderTextBlock(raw) {
        var lines=raw.split('\\n'), html='', i=0, mathBuf='', inMath=false;
        while(i<lines.length){
          var ln=lines[i];
          // $$ 區塊
          if(ln.trim()==='$$'){ if(!inMath){inMath=true;mathBuf='';i++;continue;}else{inMath=false;html+='<code class="math-block">'+escHtml(mathBuf.trim())+'</code>';mathBuf='';i++;continue;} }
          if(inMath){mathBuf+=ln+'\\n';i++;continue;}
          // 表格
          if(ln.includes('|')&&i+1<lines.length&&/^\\|?[\\s:|-]+\\|/.test(lines[i+1])){
            var tl=[ln],j=i+1; while(j<lines.length&&lines[j].includes('|')){tl.push(lines[j]);j++;}
            html+=renderMdTable(tl); i=j; continue;
          }
          // 任務清單
          var tm=ln.match(/^(\\s*)-\\s+\\[([ xX])\\]\\s*(.*)/);
          if(tm){ var ck=tm[2].toLowerCase()==='x'; html+='<div class="task-item"><span style="font-family:monospace;color:'+(ck?'#4ec94e':'rgba(128,128,128,0.55)')+'">'+(ck?'[x]':'[ ]')+'</span> <span style="'+(ck?'text-decoration:line-through;opacity:0.55':'')+'">'+renderInline(tm[3])+'</span></div>'; i++;continue; }
          // 無序清單
          var um=ln.match(/^(\\s*)[-*+] (.*)/);
          if(um){ html+='<div style="padding-left:'+(um[1].length*8+14)+'px;margin:1px 0">&bull; '+renderInline(um[2])+'</div>'; i++;continue; }
          // 有序清單
          var om=ln.match(/^(\\s*)(\\d+)\\. (.*)/);
          if(om){ html+='<div style="padding-left:'+(om[1].length*8+16)+'px;margin:1px 0">'+om[2]+'. '+renderInline(om[3])+'</div>'; i++;continue; }
          // 標題
          var hm=ln.match(/^(#{1,4})\\s+(.*)/);
          if(hm){ var lv=hm[1].length,fs=['1.2em','1.1em','1em','0.95em'][lv-1]; html+='<div style="font-weight:700;font-size:'+fs+';margin:6px 0 2px;'+(lv<=2?'border-bottom:1px solid rgba(128,128,128,0.2)':'')+'">'+renderInline(hm[2])+'</div>'; i++;continue; }
          // 空行
          if(!ln.trim()){html+='<div style="height:5px"></div>';i++;continue;}
          // 一般行
          html+='<div style="line-height:1.55;white-space:pre-wrap">'+renderInline(ln)+'</div>';
          i++;
        }
        if(inMath&&mathBuf) html+='<code class="math-block">'+escHtml(mathBuf.trim())+'</code>';
        return html;
      }
      function rerenderBubbleMd(bubble) {
        var rb = bubble && bubble.querySelector('.response-body');
        if (!rb) return;
        var rawText = rb.textContent || '';
        if (!rawText.trim()) return;
        rb.innerHTML = ''; rb.style.whiteSpace = '';
        parseBlocks(rawText).forEach(function(p) {
          if (p.t === 'code') { rb.appendChild(makeCodeBlock(p.v, p.lang)); }
          else if (p.v.trim()) { var d = document.createElement('div'); d.innerHTML = renderTextBlock(p.v); rb.appendChild(d); }
        });
      }
      // -- parseBlocks + makeCodeBlock + highlightCode --------------------------
      function parseBlocks(text) {
        var TICK = String.fromCharCode(96, 96, 96);
        var parts = []; var rest = text;
        while (true) {
          var s = rest.indexOf(TICK);
          if (s === -1) { if (rest) parts.push({ t: 'text', v: rest }); break; }
          if (s > 0) parts.push({ t: 'text', v: rest.slice(0, s) });
          rest = rest.slice(s + 3);
          var nl = rest.indexOf('\\n');
          var lang = nl !== -1 ? rest.slice(0, nl).trim() : '';
          if (nl !== -1) rest = rest.slice(nl + 1);
          var e = rest.indexOf(TICK);
          var code = e !== -1 ? rest.slice(0, e) : rest;
          parts.push({ t: 'code', lang: lang, v: code });
          rest = e !== -1 ? rest.slice(e + 3) : '';
        }
        return parts.length ? parts : [{ t: 'text', v: text }];
      }

      // -- 語法高亮（輕量內嵌 tokenizer，支援 JS/TS/Python/Shell/CSS/JSON）------
      function highlightCode(code, lang) {
        var L = (lang || '').toLowerCase().replace(/[^a-z0-9#+]/g, '');
        var isJS  = /^(js|ts|jsx|tsx|javascript|typescript|mjs|cjs|node)$/.test(L);
        var isPy  = /^(py|python|python3)$/.test(L);
        var isSh  = /^(sh|bash|shell|zsh|fish|ps|ps1|powershell|cmd|bat)$/.test(L);
        var isCss = /^(css|scss|less|sass|styl)$/.test(L);
        var isJson= /^(json|jsonc)$/.test(L);
        if (!isJS && !isPy && !isSh && !isCss && !isJson) {
          return code.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        }
        var KW_JS = 'break,case,catch,class,const,continue,debugger,default,delete,do,else,export,extends,finally,for,function,if,import,in,instanceof,let,new,null,of,return,static,super,switch,throw,try,typeof,undefined,var,void,while,yield,async,await,from,as,type,interface,enum,implements,namespace,declare,abstract,readonly,override,public,private,protected,true,false,this,constructor,get,set,keyof,infer,never,any,unknown,string,number,boolean,object,symbol,bigint'.split(',');
        var KW_PY = 'and,as,assert,async,await,break,class,continue,def,del,elif,else,except,False,finally,for,from,global,if,import,in,is,lambda,None,nonlocal,not,or,pass,raise,return,True,try,while,with,yield,self,cls,print,super,range,len,list,dict,set,tuple,str,int,float,bool,isinstance,hasattr,property,staticmethod,classmethod'.split(',');
        var KW_SH = 'if,then,else,elif,fi,for,while,do,done,case,esac,in,function,return,export,local,declare,readonly,echo,printf,exit,break,continue,set,unset,read,true,false'.split(',');
        var kwMap = {}; (isJS||isJson ? KW_JS : isPy ? KW_PY : isSh ? KW_SH : []).forEach(function(k){kwMap[k]=1;});
        var isPyOrSh = isPy || isSh;
        var TK = String.fromCharCode(96);
        var html='', i=0, n=code.length;
        function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
        function sp(cls,s){return '<span class="'+cls+'">'+esc(s)+'</span>';}
        while(i<n){
          var c=code[i];
          // Python/Shell # comment
          if(c==='#'&&isPyOrSh){ var e1=code.indexOf('\\n',i); if(e1===-1)e1=n; html+=sp('hl-cmt',code.slice(i,e1)); i=e1; continue; }
          // // comment
          if(c==='/'&&code[i+1]==='/'&&!isPy){ var e2=code.indexOf('\\n',i); if(e2===-1)e2=n; html+=sp('hl-cmt',code.slice(i,e2)); i=e2; continue; }
          // /* ... */
          if(c==='/'&&code[i+1]==='*'){ var e3=code.indexOf('*/',i+2); var ce=e3!==-1?e3+2:n; html+=sp('hl-cmt',code.slice(i,ce)); i=ce; continue; }
          // Python triple-quote
          if(isPy&&(code.slice(i,i+3)==='"""'||code.slice(i,i+3)==="'''")){var q3=code.slice(i,i+3),e4=code.indexOf(q3,i+3);var se=e4!==-1?e4+3:n;html+=sp('hl-str',code.slice(i,se));i=se;continue;}
          // string " or '
          if(c==='"'||c==="'"){var q=c,ss=q,si=i+1;while(si<n){var sc=code[si];if(sc==='\\\\'){ss+=sc+(code[si+1]||'');si+=2;continue;}ss+=sc;si++;if(sc===q)break;}html+=sp('hl-str',ss);i=si;continue;}
          // template literal (backtick)
          if(c===TK&&isJS){var ss2=TK,si2=i+1;while(si2<n){var sc2=code[si2];if(sc2==='\\\\'){ss2+=sc2+(code[si2+1]||'');si2+=2;continue;}ss2+=sc2;si2++;if(sc2===TK)break;}html+=sp('hl-str',ss2);i=si2;continue;}
          // number
          if(c>='0'&&c<='9'){var ns='',ni=i;while(ni<n&&/[0-9._xXa-fA-FbBoOpP]/.test(code[ni])){ns+=code[ni];ni++;}html+=sp('hl-num',ns);i=ni;continue;}
          // identifier → keyword / Type / function()
          if(/[a-zA-Z_$]/.test(c)){var id='',ii=i;while(ii<n&&/[\\w$]/.test(code[ii])){id+=code[ii];ii++;}
            if(kwMap[id]){html+=sp('hl-kw',id);}
            else if(/^[A-Z]/.test(id)&&id.length>1&&!/^[A-Z_]+$/.test(id)){html+=sp('hl-type',id);}
            else{var ni2=ii;while(ni2<n&&(code[ni2]===' '||code[ni2]==='\\t'))ni2++;html+=(code[ni2]==='('?sp('hl-fn',id):id);}
            i=ii;continue;}
          if(c==='<'){html+='&lt;';i++;continue;}
          if(c==='>'){html+='&gt;';i++;continue;}
          if(c==='&'){html+='&amp;';i++;continue;}
          html+=c;i++;
        }
        return html;
      }

      function makeCodeBlock(code, lang) {
        var L = (lang || '').trim();
        var wrap = document.createElement('div'); wrap.className = 'code-block-wrap';
        // 語言標頭列
        var hdr = document.createElement('div'); hdr.className = 'code-block-header';
        hdr.textContent = L || 'text';
        wrap.appendChild(hdr);
        var pre = document.createElement('pre');
        if (L) { pre.innerHTML = highlightCode(code, L); } else { pre.textContent = code; }
        wrap.appendChild(pre);
        var acts = document.createElement('div'); acts.className = 'code-actions';
        var applyBtn = document.createElement('button'); applyBtn.textContent = '\uD83D\uDCCB \u5957\u7528\u5230\u6a94\u6848';
        applyBtn.addEventListener('click', function() { vscode.postMessage({ type: 'applyToFile', code: code }); });
        var insertBtn = document.createElement('button'); insertBtn.textContent = '\u2B07 \u63d2\u5165\u6e38\u6a19';
        insertBtn.addEventListener('click', function() { vscode.postMessage({ type: 'insert', code: code }); });
        var copyBtn = document.createElement('button'); copyBtn.textContent = '\u8907\u88fd';
        copyBtn.addEventListener('click', function() {
          if (navigator.clipboard) {
            navigator.clipboard.writeText(code).then(function() {
              copyBtn.textContent = '\u2713 \u5df2\u8907\u88fd'; setTimeout(function() { copyBtn.textContent = '\u8907\u88fd'; }, 1500);
            }).catch(function() { copyBtn.textContent = '\u5931\u6557'; });
          }
        });
        acts.appendChild(applyBtn); acts.appendChild(insertBtn); acts.appendChild(copyBtn);
        wrap.appendChild(acts); return wrap;
      }

      // -- appendMessage (fullText = 5th param, user messages only) ------------
      function appendMessage(who, text, thinkingText, tokens, fullText) {
        var node = document.createElement('div'); node.className = 'msg ' + who;
        var bubble = document.createElement('div'); bubble.className = 'bubble';
        if (who === 'assistant' && thinkingText) bubble.appendChild(makeThinkBlock(thinkingText, false));
        if (who === 'assistant') {
          var _curUserCount = _userMsgCount; // 捕捉此時的 user count，供 fork 使用
          node.dataset.userCount = String(_curUserCount);
          parseBlocks(text).forEach(function(p) {
            if (p.t === 'code') {
              bubble.appendChild(makeCodeBlock(p.v, p.lang));
            } else if (p.v.trim()) {
              var d = document.createElement('div'); d.innerHTML = renderTextBlock(p.v); bubble.appendChild(d);
            }
          });
          var statRow = document.createElement('div'); statRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-top:4px';
          var sumBtn = document.createElement('button'); sumBtn.textContent = '\u6458\u8981';
          sumBtn.addEventListener('click', function() { vscode.postMessage({ type: 'summarize', text: text, model: modelSelect ? modelSelect.value : undefined }); });
          statRow.appendChild(sumBtn);
          if (tokens) { var tokSpan = document.createElement('span'); tokSpan.style.cssText = 'font-size:10px;opacity:0.5'; tokSpan.textContent = '~' + tokens + ' tokens'; statRow.appendChild(tokSpan); }
          bubble.appendChild(statRow);
          // ── Fork (分支) 按鈕
          var acts2 = document.createElement('div'); acts2.className = 'msg-actions';
          var forkBtn = document.createElement('button'); forkBtn.className = 'msg-action-btn'; forkBtn.textContent = '\uD83C\uDF3F \u5EFA\u7ACB\u5206\u652F';
          forkBtn.title = '\u5F9E\u6B64\u8655\u5EFA\u7ACB\u65B0\u7684\u5C0D\u8A71\u5206\u652F';
          forkBtn.addEventListener('click', function() {
            var allMsgs = Array.from(chat.querySelectorAll('.msg'));
            var nodeIdx = allMsgs.indexOf(node);
            var uc = 0;
            for (var _fi = 0; _fi <= nodeIdx; _fi++) { if (allMsgs[_fi].classList.contains('user')) uc++; }
            var forkHtml = allMsgs.slice(0, nodeIdx + 1).map(function(n2) { return n2.outerHTML; }).join('');
            vscode.postMessage({ type: 'forkSession', userCount: uc, forkHtml: forkHtml, sessionId: _activeChatSessionId });
          });
          acts2.appendChild(forkBtn); bubble.appendChild(acts2);
        } else {
          // ── 使用者訊息 — 記錄索引 + edit 按鈕
          var _myUserIdx = _userMsgCount;
          node.dataset.userIdx = String(_myUserIdx);
          node.dataset.fullText = fullText || text;
          _userMsgCount++;
          var body = document.createElement('div'); body.textContent = text; bubble.appendChild(body);
          // Edit 按鈕區
          var editActs = document.createElement('div'); editActs.className = 'msg-actions';
          var editBtn = document.createElement('button'); editBtn.className = 'msg-action-btn'; editBtn.textContent = '\u270F\uFE0F \u7DE8\u8F2F';
          editBtn.title = '\u4FEE\u6539\u6B64\u8A0A\u606F\u4E26\u91CD\u65B0\u7522\u751F\u56DE\u61C9';
          (function(capturedNode, capturedBody, capturedIdx) {
            editBtn.addEventListener('click', function() { startEditMessage(capturedNode, capturedBody, capturedIdx); });
          })(node, body, _myUserIdx);
          editActs.appendChild(editBtn); bubble.appendChild(editActs);
        }
        node.appendChild(bubble);
        chat.appendChild(node); chat.scrollTop = chat.scrollHeight;
      }

      // ── 訊息編輯 ─────────────────────────────────────────────────────────
      function startEditMessage(node, bodyEl, userIdx) {
        if (node.classList.contains('editing')) return;
        node.classList.add('editing');
        var origText = node.dataset.fullText || (bodyEl ? bodyEl.textContent : '');
        var overlay = document.createElement('div'); overlay.className = 'user-edit-overlay';
        var ta = document.createElement('textarea'); ta.className = 'user-edit-textarea'; ta.value = origText;
        var actRow = document.createElement('div'); actRow.className = 'user-edit-actions';
        var confirmBtn = document.createElement('button'); confirmBtn.className = 'msg-action-btn'; confirmBtn.style.cssText = 'background:rgba(0,180,0,0.2);border-color:rgba(0,200,0,0.4)'; confirmBtn.textContent = '\u2713 \u78BA\u8A8D\u537B\u66F4\u65B0';
        var cancelBtn  = document.createElement('button'); cancelBtn.className = 'msg-action-btn'; cancelBtn.textContent = '\u2715 \u53D6\u6D88';
        actRow.appendChild(confirmBtn); actRow.appendChild(cancelBtn); overlay.appendChild(ta); overlay.appendChild(actRow);
        if (bodyEl) bodyEl.style.display = 'none';
        node.querySelector('.msg-actions') && (node.querySelector('.msg-actions').style.display = 'none');
        var bubble = node.querySelector('.bubble'); if (bubble) bubble.appendChild(overlay);
        ta.focus(); ta.select();
        function doCancel() {
          overlay.remove();
          if (bodyEl) bodyEl.style.display = '';
          node.querySelector('.msg-actions') && (node.querySelector('.msg-actions').style.display = '');
          node.classList.remove('editing');
        }
        cancelBtn.addEventListener('click', doCancel);
        confirmBtn.addEventListener('click', function() {
          var newText = ta.value.trim();
          if (!newText) { doCancel(); return; }
          // \u66F4\u65B0 DOM \u986F\u793A\u6587\u5B57
          var label = newText.length > 60 ? newText.slice(0, 60) + '\u2026' : newText;
          if (bodyEl) { bodyEl.textContent = label; bodyEl.style.display = ''; }
          node.dataset.fullText = newText;
          overlay.remove();
          node.querySelector('.msg-actions') && (node.querySelector('.msg-actions').style.display = '');
          node.classList.remove('editing');
          // \u522A\u9664\u6B64\u8A0A\u606F\u4E4B\u5F8C\u7684\u6240\u6709 DOM \u8A0A\u606F
          var allMsgs = Array.from(chat.querySelectorAll('.msg'));
          var nodeIdx = allMsgs.indexOf(node);
          for (var _di = allMsgs.length - 1; _di > nodeIdx; _di--) { allMsgs[_di].remove(); }
          _userMsgCount = userIdx + 1;
          appendLoadingBubble();
          vscode.postMessage({ type: 'editMessage', userIdx: userIdx, newText: newText, model: modelSelect ? modelSelect.value : undefined, sessionId: _activeChatSessionId });
        });
      }

      // ── 串流 ─────────────────────────────────────────────────────────────
      function getOrCreateStreamNode() {
        if (_streamNode && chat.contains(_streamNode)) return _streamNode;
        const node = document.createElement('div'); node.className = 'msg assistant';
        const bubble = document.createElement('div'); bubble.className = 'bubble';
        node.appendChild(bubble); chat.appendChild(node); _streamNode = node; return node;
      }

      function getStreamBubble() {
        const n = getOrCreateStreamNode();
        let b = n.querySelector('.bubble');
        if (!b) { b = document.createElement('div'); b.className = 'bubble'; n.appendChild(b); }
        return b;
      }

      function appendThinkChunk(chunk) {
        clearPendingBubble();
        const bubble = getStreamBubble();
        let d = bubble.querySelector('details.think');
        if (!d) {
          d = document.createElement('details'); d.className = 'think'; d.setAttribute('open', '');
          const s = document.createElement('summary');
          const icon = document.createElement('span'); icon.className = 'think-icon pulse';
          const label = document.createElement('span'); label.className = 'think-label'; label.textContent = '\u{1F9E0} \u601d\u8003\u4e2d\u2026';
          s.appendChild(icon); s.appendChild(label);
          const p = document.createElement('pre'); p.className = 'think-stream';
          d.appendChild(s); d.appendChild(p); 
          // 插入到 bubble 最前面，讓思考區塊出現在回應內容之前
          if (bubble.firstChild) { bubble.insertBefore(d, bubble.firstChild); } else { bubble.appendChild(d); }
          d._charCount = 0;
          d._thinkStart = Date.now();
          d._thinkTimer = setInterval(function() {
            if (!d.hasAttribute('open')) { clearInterval(d._thinkTimer); return; }
            const secs = Math.round((Date.now() - d._thinkStart) / 1000);
            const approxTok2 = Math.round((d._charCount || 0) / 4);
            const lbl2 = d.querySelector('.think-label');
            if (lbl2) lbl2.textContent = '\u{1F9E0} \u601d\u8003\u4e2d\u2026 (~' + approxTok2 + ' tokens, ' + secs + 's)';
          }, 1000);
        }
        d._charCount = (d._charCount || 0) + chunk.length;
        const approxTok = Math.round(d._charCount / 4);
        const secs = Math.round((Date.now() - (d._thinkStart || Date.now())) / 1000);
        const lbl = d.querySelector('.think-label');
        if (lbl) lbl.textContent = '\u{1F9E0} \u601d\u8003\u4e2d\u2026 (~' + approxTok + ' tokens, ' + secs + 's)';
        const p = d.querySelector('pre.think-stream');
        if (p) { p.textContent = (p.textContent || '') + chunk; p.scrollTop = p.scrollHeight; }
        chat.scrollTop = chat.scrollHeight;
      }

      function appendChunk(chunk) {
        clearPendingBubble(); // remove loading dots before creating stream node
        const bubble = getStreamBubble();
        const d = bubble.querySelector('details.think');
        if (d && d.hasAttribute('open')) {
          d.removeAttribute('open');
          d._thinkEnd = Date.now();
          if (d._thinkTimer) { clearInterval(d._thinkTimer); d._thinkTimer = null; }
          const icon = d.querySelector('.think-icon'); if (icon) icon.classList.remove('pulse');
          const lbl = d.querySelector('.think-label');
          const approxTok = Math.round((d._charCount || 0) / 4);
          const totalSecs = Math.round((Date.now() - (d._thinkStart || Date.now())) / 1000);
          if (lbl) lbl.textContent = '\u{1F9E0} \u601d\u8003\u904e\u7a0b (~' + approxTok + ' tokens, \u8017\u6642 ' + totalSecs + 's)';
        }
        let body = bubble.querySelector('.response-body');
        if (!body) { body = document.createElement('div'); body.className = 'response-body'; body.style.whiteSpace = 'pre-wrap'; bubble.appendChild(body); }
        body.textContent = (body.textContent || '') + chunk;
        chat.scrollTop = chat.scrollHeight;
      }

      // ── Agent 工具步驟 ───────────────────────────────────────────────────────────
      function ensureLastAssistantBubble() {
        clearPendingBubble();
        var last = chat.lastElementChild;
        if (last && last.classList.contains('msg') && last.classList.contains('assistant')) {
          return last.querySelector('.bubble');
        }
        var node = document.createElement('div'); node.className = 'msg assistant';
        var bub = document.createElement('div'); bub.className = 'bubble';
        node.appendChild(bub); chat.appendChild(node); return bub;
      }

      function appendAgentStep(icon, title, fullPath) {
        var bub = ensureLastAssistantBubble();
        var d = document.createElement('details'); d.className = 'tool-step'; d.dataset.s = 'running';
        var s = document.createElement('summary');
        var span = document.createElement('span'); span.textContent = (icon || '\uD83D\uDD27') + '\u00A0' + title;
        if (fullPath) { span.title = fullPath; }
        var status = document.createElement('span'); status.className = 'step-status';
        s.appendChild(span); s.appendChild(status);
        d.appendChild(s); bub.appendChild(d); _agentStepNode = d;
        chat.scrollTop = chat.scrollHeight;
      }

      function finalizeAgentStep(result, isError) {
        if (!_agentStepNode) return;
        _agentStepNode.dataset.s = isError ? 'error' : 'done';
        if (result) { var pre = document.createElement('pre'); pre.textContent = result; _agentStepNode.appendChild(pre); }
        _agentStepNode = null; chat.scrollTop = chat.scrollHeight;
      }

      // ── 團隊模式 ──────────────────────────────────────────────────────────
      var TEAM_COLORS = ['#4fc1ff','#89d185','#ce9178','#c586c0','#dcdcaa','#f7cc65'];

      function createTeamMember(id, model, color, task) {
        clearPendingBubble();
        var node = document.createElement('div'); node.className = 'msg assistant team-member-node';
        var bub = document.createElement('div'); bub.className = 'bubble'; bub.style.borderLeftColor = color;
        var hdr = document.createElement('div'); hdr.className = 'team-header';
        var badge = document.createElement('span'); badge.className = 'team-badge';
        badge.textContent = model; badge.style.color = color; badge.style.borderColor = color; badge.style.background = color + '22';
        var st = document.createElement('span'); st.className = 'team-status-text'; st.textContent = '\u601d\u8003\u4e2d\u2026';
        hdr.appendChild(badge); hdr.appendChild(st); bub.appendChild(hdr);
        if (task) { var tl = document.createElement('div'); tl.className = 'team-task-label'; tl.textContent = '\uD83D\uDCCC ' + task; bub.appendChild(tl); }
        node.appendChild(bub);
        chat.appendChild(node); chat.scrollTop = chat.scrollHeight;
        _teamNodes[id] = { node: node, bubble: bub, status: st, thinkNode: null, responseNode: null, reviewNode: null, charCount: 0, thinkStart: null, thinkTimer: null };
      }

      function appendTeamThinkChunk(id, color, chunk) {
        var m = _teamNodes[id]; if (!m) return;
        if (!m.thinkNode) {
          var d = document.createElement('details'); d.className = 'think'; d.setAttribute('open', '');
          var s = document.createElement('summary');
          var icon = document.createElement('span'); icon.className = 'think-icon pulse'; icon.style.background = color;
          var lbl = document.createElement('span'); lbl.className = 'think-label'; lbl.textContent = '\u{1F9E0} \u601d\u8003\u4e2d\u2026';
          s.appendChild(icon); s.appendChild(lbl);
          var p = document.createElement('pre'); p.className = 'think-stream';
          d.appendChild(s); d.appendChild(p); m.bubble.appendChild(d);
          m.thinkNode = d; m.thinkStart = Date.now(); m.charCount = 0;
          m.thinkTimer = setInterval(function() {
            if (!d.hasAttribute('open')) { clearInterval(m.thinkTimer); return; }
            var secs = Math.round((Date.now() - m.thinkStart) / 1000);
            var tok = Math.round((m.charCount || 0) / 4);
            var l2 = d.querySelector('.think-label'); if (l2) l2.textContent = '\u{1F9E0} \u601d\u8003\u4e2d\u2026 (~' + tok + ' tokens, ' + secs + 's)';
          }, 1000);
        }
        m.charCount = (m.charCount || 0) + chunk.length;
        var tok = Math.round(m.charCount / 4);
        var secs = Math.round((Date.now() - (m.thinkStart || Date.now())) / 1000);
        var ll = m.thinkNode.querySelector('.think-label'); if (ll) ll.textContent = '\u{1F9E0} \u601d\u8003\u4e2d\u2026 (~' + tok + ' tokens, ' + secs + 's)';
        var pre = m.thinkNode.querySelector('pre.think-stream'); if (pre) { pre.textContent += chunk; pre.scrollTop = pre.scrollHeight; }
        chat.scrollTop = chat.scrollHeight;
      }

      function appendTeamResponseChunk(id, chunk) {
        var m = _teamNodes[id]; if (!m) return;
        if (m.thinkNode && m.thinkNode.hasAttribute('open')) {
          m.thinkNode.removeAttribute('open');
          if (m.thinkTimer) { clearInterval(m.thinkTimer); m.thinkTimer = null; }
          var icon = m.thinkNode.querySelector('.think-icon'); if (icon) icon.classList.remove('pulse');
          var lbl = m.thinkNode.querySelector('.think-label');
          var tok = Math.round((m.charCount || 0) / 4);
          var secs = Math.round((Date.now() - (m.thinkStart || Date.now())) / 1000);
          if (lbl) lbl.textContent = '\u{1F9E0} \u601d\u8003\u904e\u7a0b (~' + tok + ' tokens, \u8017\u6642 ' + secs + 's)';
        }
        if (m.status) m.status.textContent = '\u56de\u7b54\u4e2d\u2026';
        if (!m.responseNode) {
          var rb = document.createElement('div'); rb.className = 'response-body'; rb.style.whiteSpace = 'pre-wrap';
          m.bubble.appendChild(rb); m.responseNode = rb;
        }
        m.responseNode.textContent += chunk;
        chat.scrollTop = chat.scrollHeight;
      }

      function finalizeTeamMember(id) {
        var m = _teamNodes[id]; if (!m) return;
        if (m.status) m.status.textContent = '\u2713 \u5b8c\u6210';
        if (m.thinkTimer) { clearInterval(m.thinkTimer); m.thinkTimer = null; }
        if (m.thinkNode && m.thinkNode.hasAttribute('open')) { m.thinkNode.removeAttribute('open'); }
        if (m.responseNode) {
          var lineCount = (m.responseNode.textContent || '').split('\\n').length;
          if (lineCount > 10) {
            m.responseNode.classList.add('response-body-collapsed');
            var xBtn = document.createElement('button'); xBtn.className = 'response-expand-btn';
            xBtn.textContent = '\u25bc \u5c55\u958b\u5168\u6587 (' + lineCount + ' \u884c)';
            xBtn.onclick = function() { m.responseNode.classList.remove('response-body-collapsed'); xBtn.remove(); };
            m.bubble.appendChild(xBtn);
          }
        }
      }

      function createTeamSynthBubble() {
        var node = document.createElement('div'); node.className = 'msg assistant team-synth-node';
        var bub = document.createElement('div'); bub.className = 'bubble';
        var hdr = document.createElement('div'); hdr.className = 'team-synth-header'; hdr.textContent = '\u2728 \u5718\u968a\u7d9c\u5408\u5efa\u8b70';
        var body = document.createElement('div'); body.className = 'response-body'; body.style.whiteSpace = 'pre-wrap';
        bub.appendChild(hdr); bub.appendChild(body); node.appendChild(bub);
        chat.appendChild(node); chat.scrollTop = chat.scrollHeight;
        _synthNode = { node: node, bubble: bub, body: body };
      }

      function appendTeamSynthChunk(chunk) {
        if (!_synthNode) return;
        _synthNode.body.textContent += chunk;
        chat.scrollTop = chat.scrollHeight;
      }

      function createOrchestratorBubble(model) {
        clearPendingBubble();
        _orchestratorModel = model || '\uD83D\uDC19 \u5354\u8abf\u54e1';
        var node = document.createElement('div'); node.className = 'msg assistant team-orchestrator-node';
        var bub = document.createElement('div'); bub.className = 'bubble';
        var hdr = document.createElement('div'); hdr.className = 'team-orchestrator-header';
        hdr.textContent = _orchestratorModel + ' \u2014 \u5206\u914D\u5DE5\u4F5C\u4E2D\u2026';
        var body = document.createElement('div'); body.className = 'team-orchestrator-body';
        bub.appendChild(hdr); bub.appendChild(body); node.appendChild(bub);
        chat.appendChild(node); chat.scrollTop = chat.scrollHeight;
        _orchestratorNode = { node: node, bubble: bub, body: body, hdr: hdr };
      }

      function appendOrchestratorThinkChunk(chunk) {
        if (!_orchestratorNode) return;
        if (!_orchestratorNode.thinkNode) {
          var d = document.createElement('details'); d.className = 'think'; d.setAttribute('open', '');
          var s = document.createElement('summary');
          var icon = document.createElement('span'); icon.className = 'think-icon pulse'; icon.style.background = '#f7cc65';
          var lbl = document.createElement('span'); lbl.className = 'think-label'; lbl.textContent = '\u{1F9E0} \u601d\u8003\u4e2d\u2026';
          s.appendChild(icon); s.appendChild(lbl);
          var p = document.createElement('pre'); p.className = 'think-stream';
          d.appendChild(s); d.appendChild(p);
          _orchestratorNode.bubble.insertBefore(d, _orchestratorNode.body);
          _orchestratorNode.thinkNode = d; _orchestratorNode.thinkStart = Date.now(); _orchestratorNode.thinkChars = 0;
          _orchestratorNode.thinkTimer = setInterval(function() {
            if (!d.hasAttribute('open')) { clearInterval(_orchestratorNode.thinkTimer); return; }
            var secs = Math.round((Date.now() - _orchestratorNode.thinkStart) / 1000);
            var tok = Math.round((_orchestratorNode.thinkChars || 0) / 4);
            var l2 = d.querySelector('.think-label'); if (l2) l2.textContent = '\u{1F9E0} \u601d\u8003\u4e2d\u2026 (~' + tok + ' tokens, ' + secs + 's)';
          }, 1000);
        }
        _orchestratorNode.thinkChars = (_orchestratorNode.thinkChars || 0) + chunk.length;
        var pre = _orchestratorNode.thinkNode.querySelector('pre.think-stream'); if (pre) { pre.textContent += chunk; pre.scrollTop = pre.scrollHeight; }
        chat.scrollTop = chat.scrollHeight;
      }

      function appendOrchestratorChunk(chunk) {
        if (!_orchestratorNode) return;
        if (_orchestratorNode.thinkNode && _orchestratorNode.thinkNode.hasAttribute('open')) {
          _orchestratorNode.thinkNode.removeAttribute('open');
          if (_orchestratorNode.thinkTimer) { clearInterval(_orchestratorNode.thinkTimer); _orchestratorNode.thinkTimer = null; }
          var icon = _orchestratorNode.thinkNode.querySelector('.think-icon'); if (icon) icon.classList.remove('pulse');
          var lbl = _orchestratorNode.thinkNode.querySelector('.think-label');
          var tok = Math.round((_orchestratorNode.thinkChars || 0) / 4);
          var secs = Math.round((Date.now() - (_orchestratorNode.thinkStart || Date.now())) / 1000);
          if (lbl) lbl.textContent = '\u{1F9E0} \u601d\u8003\u904e\u7a0b (~' + tok + ' tokens, \u8017\u6642 ' + secs + 's)';
        }
        _orchestratorNode.body.textContent += chunk;
        chat.scrollTop = chat.scrollHeight;
      }

      function finalizeOrchestratorBubble() {
        if (!_orchestratorNode) return;
        if (_orchestratorNode.thinkTimer) { clearInterval(_orchestratorNode.thinkTimer); _orchestratorNode.thinkTimer = null; }
        if (_orchestratorNode.thinkNode && _orchestratorNode.thinkNode.hasAttribute('open')) {
          _orchestratorNode.thinkNode.removeAttribute('open');
          var lbl = _orchestratorNode.thinkNode.querySelector('.think-label');
          var tok = Math.round((_orchestratorNode.thinkChars || 0) / 4);
          if (lbl) lbl.textContent = '\u{1F9E0} \u601d\u8003\u5b8c\u6210 (~' + tok + ' tokens)';
          var icon = _orchestratorNode.thinkNode.querySelector('.think-icon'); if (icon) icon.classList.remove('pulse');
        }
        if (_orchestratorNode.hdr) _orchestratorNode.hdr.textContent = _orchestratorNode.hdr.textContent.replace('\u5206\u914D\u5DE5\u4F5C\u4E2D\u2026', '\u2713 \u5DE5\u4F5C\u5206\u914D\u5B8C\u6210');
      }

      function createTodoPanel(tasks) {
        var wrap = document.createElement('div'); wrap.className = 'msg';
        var bub = document.createElement('div'); bub.className = 'team-todos-panel';
        var hdr = document.createElement('div'); hdr.className = 'team-todos-header';
        var ttl = document.createElement('span'); ttl.id = 'todosTitle'; ttl.textContent = '\u4efb\u52d9\u6e05\u55ae (0/' + tasks.length + ')';
        hdr.appendChild(document.createTextNode('\uD83D\uDCCB ')); hdr.appendChild(ttl);
        bub.appendChild(hdr);
        for (var i = 0; i < tasks.length; i++) {
          var row = document.createElement('div'); row.className = 'team-todo-item'; row.id = 'todo_item_' + i;
          var st = document.createElement('span'); st.className = 'team-todo-status'; st.textContent = '\u23f3';
          var tk = document.createElement('span'); tk.className = 'team-todo-task'; tk.textContent = tasks[i];
          var wk = document.createElement('span'); wk.className = 'team-todo-worker'; wk.id = 'todo_worker_' + i;
          row.appendChild(st); row.appendChild(tk); row.appendChild(wk); bub.appendChild(row);
        }
        wrap.appendChild(bub); chat.appendChild(wrap); chat.scrollTop = chat.scrollHeight;
        _todosPanel = bub; _todoChecked = 0;
      }
      function updateTodo(idx, status, worker) {
        var row = document.getElementById('todo_item_' + idx); if (!row) return;
        row.className = 'team-todo-item' + (status === 'done' ? ' t-done' : status === 'running' ? ' t-running' : '');
        var st = row.querySelector('.team-todo-status'); if (st) st.textContent = status === 'done' ? '\u2705' : status === 'running' ? '\uD83D\uDD04' : '\u23f3';
        var wk = document.getElementById('todo_worker_' + idx); if (wk && worker) wk.textContent = '\u2190 ' + worker;
        if (status === 'done') {
          _todoChecked++;
          var total = _todosPanel ? _todosPanel.querySelectorAll('.team-todo-item').length : 0;
          var ttl2 = document.getElementById('todosTitle'); if (ttl2) ttl2.textContent = '\u4efb\u52d9\u6e05\u55ae (' + _todoChecked + '/' + total + ')';
        }
      }

      function startTeamRound(id, round) {
        var m = _teamNodes[id]; if (!m) return;
        if (round > 0) {
          if (m.thinkNode && m.thinkNode.hasAttribute('open')) {
            m.thinkNode.removeAttribute('open');
            if (m.thinkTimer) { clearInterval(m.thinkTimer); m.thinkTimer = null; }
          }
          m.thinkNode = null; m.responseNode = null; m.reviewNode = null;
          var sep = document.createElement('div'); sep.className = 'team-round-sep';
          sep.textContent = '\u2500\u2500 \u7b2c ' + (round + 1) + ' \u8f2a \u2500\u2500';
          m.bubble.appendChild(sep);
        }
        if (m.status) m.status.textContent = (round > 0 ? '\u8fed\u4ee3\u4e2d\u2026' : '\u601d\u8003\u4e2d\u2026');
      }

      function startTeamReview(id) {
        var m = _teamNodes[id]; if (!m) return;
        var rv = document.createElement('div'); rv.className = 'team-review-section';
        var rvh = document.createElement('span'); rvh.className = 'team-review-label'; rvh.textContent = (_orchestratorModel || '\uD83D\uDC19 \u5354\u8abf\u54e1') + '\uff1a';
        var rvb = document.createElement('span'); rvb.className = 'team-review-body';
        rv.appendChild(rvh); rv.appendChild(rvb); m.bubble.appendChild(rv);
        m.reviewNode = rvb; chat.scrollTop = chat.scrollHeight;
      }

      function appendTeamReviewChunk(id, chunk) {
        var m = _teamNodes[id]; if (!m || !m.reviewNode) return;
        m.reviewNode.textContent += chunk; chat.scrollTop = chat.scrollHeight;
      }

      function finalizeTeamRound(id, approved) {
        var m = _teamNodes[id]; if (!m) return;
        if (m.reviewNode && m.reviewNode.parentNode) {
          var badge = document.createElement('span');
          badge.className = approved ? 'team-round-approved' : 'team-round-iterate';
          badge.textContent = approved ? ' \u2713' : ' \u21bb \u6539\u9032\u4e2d';
          m.reviewNode.parentNode.appendChild(badge);
        }
        m.reviewNode = null;
      }

      // ── 團隊模式 — 成員選擇面板 ──────────────────────────────────────
      function populateTeamPicker(models) {
        _teamAvailModels = models || [];
        var list = document.getElementById('teamPickerList'); if (!list) return;
        list.innerHTML = '';
        if (!_teamAvailModels.length) {
          list.innerHTML = '<span style="font-size:11px;opacity:0.6">\u7121\u53ef\u7528\u6a21\u578b\uff08Ollama \u672a\u5b89\u88dd\u6a21\u578b / Copilot \u672a\u767b\u5165\uff09</span>';
          return;
        }
        _teamAvailModels.forEach(function(m, i) {
          var row = document.createElement('div'); row.className = 'team-pick-row';
          var cb = document.createElement('input'); cb.type = 'checkbox'; cb.id = 'tp' + i; cb.value = m.id;
          cb.addEventListener('change', updateTeamPickerCount);
          var lbl = document.createElement('label'); lbl.htmlFor = 'tp' + i;
          lbl.className = m.vendor === 'copilot' ? 'tpl-copilot' : 'tpl-ollama';
          lbl.textContent = (m.vendor === 'copilot' ? '\uD83D\uDC19 ' : '\uD83E\uDD99 ') + m.label + (m.vendor === 'copilot' && m.multiplier ? '  ' + m.multiplier : '');
          row.appendChild(cb); row.appendChild(lbl); list.appendChild(row);
        });
        updateTeamPickerCount();
      }
      function updateTeamPickerCount() {
        var cbs = document.querySelectorAll('#teamPickerList input[type=checkbox]');
        var n = 0; cbs.forEach(function(c) { if (c.checked) n++; });
        var el = document.getElementById('teamPickerCount'); if (el) el.textContent = n + '/5 \u5df2\u9078';
        cbs.forEach(function(c) { if (!c.checked) c.disabled = n >= 5; });
        updateTeamRoleLabels();
      }
      function updateTeamRoleLabels() {
        var modeEl = document.getElementById('teamModeSelect');
        var mode = modeEl ? modeEl.value : 'task';
        var memberIdx = 0;
        document.querySelectorAll('#teamPickerList .team-pick-row').forEach(function(row) {
          var cb = row.querySelector('input[type=checkbox]');
          var lbl = row.querySelector('label');
          if (!cb || !lbl) return;
          var badge = lbl.querySelector('.role-badge');
          if (!badge) { badge = document.createElement('span'); badge.className = 'role-badge'; lbl.appendChild(badge); }
          if (cb.checked) {
            if (mode === 'manager') {
              if (memberIdx === 0) {
                badge.textContent = '\uD83C\uDFE2 \u4e3b\u7ba1'; badge.className = 'role-badge role-badge-manager';
              } else {
                badge.textContent = '\uD83D\uDC68\u200D\uD83D\uDCBB \u7d44\u54e1 #' + memberIdx; badge.className = 'role-badge role-badge-member';
              }
            } else if (mode === 'task') {
              if (memberIdx === 0) {
                badge.textContent = '\uD83C\uDFAF \u5354\u8abf\u54e1'; badge.className = 'role-badge role-badge-coordinator';
              } else {
                badge.textContent = '\uD83D\uDC68\u200D\uD83D\uDCBB \u7d44\u54e1 #' + memberIdx; badge.className = 'role-badge role-badge-member';
              }
            } else if (mode === 'discussion') {
              badge.textContent = '\uD83D\uDCAC \u8a0e\u8ad6\u8005 #' + (memberIdx + 1); badge.className = 'role-badge role-badge-discussor';
            } else if (mode === 'agent') {
              badge.textContent = '\uD83E\uDD16 Agent #' + (memberIdx + 1); badge.className = 'role-badge role-badge-agent';
            } else {
              badge.textContent = '\uD83D\uDC64 \u6210\u54e1 #' + (memberIdx + 1); badge.className = 'role-badge role-badge-member';
            }
            badge.style.display = '';
            memberIdx++;
          } else {
            badge.style.display = 'none';
          }
        });
      }
      function getSelectedTeamModels() {
        var r = [];
        document.querySelectorAll('#teamPickerList input[type=checkbox]:checked').forEach(function(c) { r.push(c.value); });
        return r;
      }

      function populateDebatePicker(models) {
        _teamAvailModels = models || [];
        var list = document.getElementById('debatePickerList'); if (!list) return;
        list.innerHTML = '';
        if (!_teamAvailModels.length) {
          list.innerHTML = '<span style="font-size:11px;opacity:0.6">\u7121\u53ef\u7528\u6a21\u578b</span>';
          return;
        }
        _teamAvailModels.forEach(function(m, i) {
          var row = document.createElement('div'); row.className = 'team-pick-row';
          var cb = document.createElement('input'); cb.type = 'checkbox'; cb.id = 'dp' + i; cb.value = m.id;
          cb.addEventListener('change', updateDebatePickerCount);
          var lbl = document.createElement('label'); lbl.htmlFor = 'dp' + i;
          lbl.className = m.vendor === 'copilot' ? 'tpl-copilot' : 'tpl-ollama';
          lbl.textContent = (m.vendor === 'copilot' ? '\uD83D\uDC19 ' : '\uD83E\uDD99 ') + m.label + (m.vendor === 'copilot' && m.multiplier ? '  ' + m.multiplier : '');
          row.appendChild(cb); row.appendChild(lbl); list.appendChild(row);
        });
        updateDebatePickerCount();
        // 更新即時換模型下拉選單
        var _optBase = '<option value="">\u2500 \u4fdd持 \u2500</option>';
        ['A', 'B', 'J'].forEach(function(sp) {
          var ss = document.getElementById('debateSwap' + sp); if (!ss) return;
          var curVal = ss.value;
          ss.innerHTML = _optBase;
          _teamAvailModels.forEach(function(m) {
            var opt = document.createElement('option'); opt.value = m.id;
            opt.textContent = (m.vendor === 'copilot' ? '\uD83D\uDC19 ' : '\uD83E\uDD99 ') + m.label;
            ss.appendChild(opt);
          });
          if (curVal) ss.value = curVal;
        });
        // 預設選揇現在對話模型
        var curSel = getSelectedDebateModels();
        ['A', 'B', 'J'].forEach(function(sp, i) {
          var ss = document.getElementById('debateSwap' + sp);
          if (ss && curSel[i]) ss.value = curSel[i];
        });
      }
      function updateDebatePickerCount() {
        var cbs = document.querySelectorAll('#debatePickerList input[type=checkbox]');
        var n = 0; cbs.forEach(function(c) { if (c.checked) n++; });
        var el = document.getElementById('debatePickerCount'); if (el) el.textContent = n + '/3 \u5df2\u9078';
        cbs.forEach(function(c) { if (!c.checked) c.disabled = n >= 3; });
      }
      function getSelectedDebateModels() {
        var r = [];
        document.querySelectorAll('#debatePickerList input[type=checkbox]:checked').forEach(function(c) { r.push(c.value); });
        return r;
      }

      // ── Debate bubble functions ──────────────────────────────────────────
      function createDebateHeader(labelA, labelB, labelJ, colorA, colorB, colorJ, gameType, speakerLabels, speakerColors) {
        _debateLabelA = labelA; _debateLabelB = labelB; _debateLabelJ = labelJ || '';
        _debateColorA = colorA; _debateColorB = colorB; _debateColorJ = colorJ;
        _speakerLabels = speakerLabels || {};
        _speakerColors = speakerColors || {};
        Object.keys(_debateNodes).forEach(function(k) { delete _debateNodes[k]; });
        var hdr = document.createElement('div');
        hdr.style.cssText = 'text-align:center;font-size:0.82em;font-weight:700;margin:10px 0 4px;padding:5px 0;border-top:1px dashed rgba(128,128,128,0.3);border-bottom:1px dashed rgba(128,128,128,0.3)';
        if (gameType === 'team-discussion') {
          // N-model discussion: show all members as a list
          var memberTags = Object.keys(_speakerLabels).sort(function(a,b){return Number(a)-Number(b);}).map(function(k) {
            return '<span style="color:' + (_speakerColors[k] || colorA) + '">' + _speakerLabels[k] + '</span>';
          });
          hdr.innerHTML = '\uD83D\uDCAC \u8a0e\u8ad6\u6a21\u5f0f\uff1a' + memberTags.join(' \u00B7 ');
        } else {
          var tagA = '<span style="color:' + colorA + '">' + labelA + '</span>';
          var tagB = '<span style="color:' + colorB + '">' + labelB + '</span>';
          var tagJ = labelJ ? ' &#x00B7; <span style="color:' + colorJ + '">[' + labelJ + ' \u88c1\u5244]</span>' : '';
          var gameTag = (gameType && gameType !== 'discussion' && gameType !== 'generic') ? ' <span style="opacity:0.55;font-size:0.9em">[' + gameType + ']</span>' : '';
          hdr.innerHTML = '\u2694\ufe0f \u5c0d\u8a71\u6a21\u5f0f\uff1a' + tagA + ' vs ' + tagB + tagJ + gameTag;
        }
        chat.appendChild(hdr); chat.scrollTop = chat.scrollHeight;
      }
      function startDebateTurn(speaker, round, overrideLabel, overrideColor) {
        var _ICONS = ['\uD83D\uDFE6','\uD83D\uDFE7','\uD83D\uDFE9','\uD83D\uDFE8','\uD83D\uDFEA','\uD83D\uDFEB'];
        var label = overrideLabel || _speakerLabels[speaker] || (speaker === 'A' ? _debateLabelA : speaker === 'B' ? _debateLabelB : (_debateLabelJ || '') + ' (\u88c1\u5224)');
        var color = overrideColor || _speakerColors[speaker] || (speaker === 'A' ? _debateColorA : speaker === 'B' ? _debateColorB : _debateColorJ);
        var _idx = isNaN(Number(speaker)) ? (speaker === 'A' ? 0 : speaker === 'B' ? 1 : 2) : Number(speaker);
        var roleIcon = (speaker === 'J') ? '\u2696\ufe0f' : (_ICONS[_idx] || '\uD83D\uDFE6');
        var node = document.createElement('div'); node.className = 'msg assistant';
        var bub = document.createElement('div'); bub.className = 'bubble debate-turn';
        bub.style.borderLeft = '3px solid ' + color;
        var h = document.createElement('div'); h.className = 'debate-turn-header';
        h.style.color = color;
        h.innerHTML = roleIcon + ' <strong>' + label + '</strong>' + (round >= 0 ? ' <span style="opacity:0.5;font-weight:normal">\u7b2c ' + (round + 1) + ' \u8f2a</span>' : '');
        var boardNode = document.createElement('pre'); boardNode.className = 'debate-board'; boardNode.style.display = 'none';
        var body = document.createElement('div'); body.className = 'debate-turn-body';
        bub.appendChild(h); bub.appendChild(boardNode); bub.appendChild(body); node.appendChild(bub);
        chat.appendChild(node); chat.scrollTop = chat.scrollHeight;
        _debateNodes[speaker] = { node: node, bub: bub, body: body, boardNode: boardNode, rawBuf: '', thinkNode: null, thinkChars: 0, thinkStart: 0, thinkTimer: null };
      }
      function appendDebateThinkChunk(speaker, chunk) {
        var d = _debateNodes[speaker]; if (!d) return;
        if (!d.thinkNode) {
          var det = document.createElement('details'); det.className = 'think'; det.setAttribute('open', '');
          var s = document.createElement('summary');
          var color = _speakerColors[speaker] || (speaker === 'A' ? _debateColorA : speaker === 'B' ? _debateColorB : _debateColorJ);
          var icon = document.createElement('span'); icon.className = 'think-icon pulse'; icon.style.background = color;
          var lbl = document.createElement('span'); lbl.className = 'think-label'; lbl.textContent = '🧠 思考中…';
          s.appendChild(icon); s.appendChild(lbl);
          var p = document.createElement('pre'); p.className = 'think-stream';
          det.appendChild(s); det.appendChild(p);
          d.bub.insertBefore(det, d.body);
          d.thinkNode = det; d.thinkStart = Date.now(); d.thinkChars = 0;
          d.thinkTimer = setInterval(function() {
            if (!det.hasAttribute('open')) { clearInterval(d.thinkTimer); return; }
            var secs = Math.round((Date.now() - d.thinkStart) / 1000);
            var tok = Math.round((d.thinkChars || 0) / 4);
            var ll = det.querySelector('.think-label'); if (ll) ll.textContent = '🧠 思考中… (~' + tok + ' tokens, ' + secs + 's)';
          }, 1000);
        }
        d.thinkChars = (d.thinkChars || 0) + chunk.length;
        var pre = d.thinkNode.querySelector('pre.think-stream'); if (pre) { pre.textContent += chunk; pre.scrollTop = pre.scrollHeight; }
        chat.scrollTop = chat.scrollHeight;
      }
      function appendDebateChunk(speaker, chunk) {
        var d = _debateNodes[speaker]; if (!d) return;
        if (d.thinkNode && d.thinkNode.hasAttribute('open')) {
          d.thinkNode.removeAttribute('open');
          d.thinkEnd = Date.now();
          if (d.thinkTimer) { clearInterval(d.thinkTimer); d.thinkTimer = null; }
          var icon = d.thinkNode.querySelector('.think-icon'); if (icon) icon.classList.remove('pulse');
          var lbl = d.thinkNode.querySelector('.think-label');
          var tok = Math.round((d.thinkChars || 0) / 4); var secs = Math.round((Date.now() - d.thinkStart) / 1000);
          if (lbl) lbl.textContent = '🧠 思考過程 (~' + tok + ' tokens, 耗時 ' + secs + 's)';
        }
        d.rawBuf = (d.rawBuf || '') + chunk;
        var boardMatch = d.rawBuf.match(/\[BOARD\]([\s\S]*?)\[\/BOARD\]/);
        if (boardMatch && d.boardNode) {
          d.boardNode.textContent = boardMatch[1].replace(/^\\n/, '').replace(/\\n$/, '');
          d.boardNode.style.display = '';
        }
        d.body.textContent = d.rawBuf.replace(/\[BOARD\][\s\S]*?\[\/BOARD\]/g, '').replace(/\[BOARD\][\s\S]*$/, '').trim();
        chat.scrollTop = chat.scrollHeight;
      }
      function finalizeDebateTurn(speaker, tokens, tps) {
        var d = _debateNodes[speaker]; if (!d) return;
        if (d.thinkTimer) { clearInterval(d.thinkTimer); d.thinkTimer = null; }
        if (d.thinkNode && d.thinkNode.hasAttribute('open')) {
          d.thinkNode.removeAttribute('open');
          d.thinkEnd = Date.now();
          var icon = d.thinkNode.querySelector('.think-icon'); if (icon) icon.classList.remove('pulse');
        }
        if (d.thinkNode && tokens !== undefined && tps !== undefined) {
          var lbl = d.thinkNode.querySelector('.think-label');
          var secs = d.thinkEnd ? Math.round((d.thinkEnd - d.thinkStart) / 1000) : 0;
          if (lbl) lbl.textContent = '🧠 思考過程 (' + tokens + ' tokens, 耗時 ' + secs + 's, ' + tps.toFixed(1) + ' t/s)';
        }
      }
      function finalizeDebate(consensus) {
        var div = document.createElement('div');
        div.className = consensus ? 'debate-consensus' : 'debate-ended';
        div.textContent = consensus ? '\u2705 \u96d9\u65b9\u5df2\u9054\u6210\u5171\u8b58' : '\u2694\ufe0f \u5c0d\u8a71\u7d50\u675f';
        chat.appendChild(div); chat.scrollTop = chat.scrollHeight;
      }

      function updateModelSelect(models, current, copilotModels) {
        if (!modelSelect) return;
        modelSelect.innerHTML = '';
        var hasAny = false;
        if (models && models.length) {
          // 支援 {id,label}[] 格式（多 URL 模式）和舊版 string[] 格式
          var serverGroups = {}; var serverOrder = [];
          models.forEach(function(m) {
            var id = (typeof m === 'string') ? m : m.id;
            var label = (typeof m === 'string') ? m : m.label;
            var grpKey = 'Ollama';
            if (id.indexOf('||') !== -1) {
              var urlPart = id.slice(0, id.indexOf('||'));
              try { var u = new URL(urlPart); grpKey = u.hostname + ':' + (u.port || '11434'); } catch { grpKey = urlPart; }
            }
            if (!serverGroups[grpKey]) { serverGroups[grpKey] = []; serverOrder.push(grpKey); }
            serverGroups[grpKey].push({ id: id, label: label });
          });
          serverOrder.forEach(function(grpKey) {
            var grpO = document.createElement('optgroup'); grpO.label = '\u2B2C ' + grpKey;
            serverGroups[grpKey].forEach(function(m) {
              var opt = document.createElement('option'); opt.value = m.id; opt.textContent = m.label;
              if (m.id === current || m.label === current) opt.selected = true;
              grpO.appendChild(opt); hasAny = true;
            });
            modelSelect.appendChild(grpO);
          });
        }
        if (copilotModels && copilotModels.length) {
          var grpC = document.createElement('optgroup'); grpC.label = '\u2728 Copilot';
          copilotModels.forEach(function(cm) {
            var opt = document.createElement('option');
            var val = 'copilot::' + cm.id;
            opt.value = val; opt.textContent = cm.name + (cm.multiplier ? '  ' + cm.multiplier : '');
            if (cm.multiplier) opt.dataset.multiplier = cm.multiplier;
            if (val === current) opt.selected = true;
            grpC.appendChild(opt); hasAny = true;
          });
          modelSelect.appendChild(grpC);
        }
        if (!modelSelect.value && hasAny) { var firstOpt = modelSelect.querySelector('option'); if (firstOpt) modelSelect.value = firstOpt.value; }
        // 更新倍數標籤
        (function() { var selOpt = modelSelect.options[modelSelect.selectedIndex]; var multEl = document.getElementById('modelMultiplier'); if (multEl) multEl.textContent = selOpt && selOpt.dataset.multiplier ? selOpt.dataset.multiplier : ''; })();
        // 同步當前選擇到後端設定（確保 handleAgent fallback 不使用舊模型名稱）
        if (modelSelect.value) { vscode.postMessage({ type: 'saveModel', model: modelSelect.value }); }
      }

      function updateConnStatus(ok, url, message) {
        const el = document.getElementById('connStatus'); if (!el) return;
        el.style.color = ok ? 'var(--vscode-terminal-ansiGreen,green)' : 'var(--vscode-errorForeground,red)';
        el.textContent = (ok ? '\u2705 ' : '\u274c ') + url + (message && message !== 'OK' ? '  \u2014  ' + message : '');
      }

      const refreshBtn = document.getElementById('refreshModels');
      if (refreshBtn) refreshBtn.addEventListener('click', function() {
        const el = document.getElementById('connStatus');
        if (el) { el.style.color = ''; el.textContent = '\u23f3 \u9023\u7dda\uff1a\u6aa2\u67e5\u4e2d\u2026'; }
        vscode.postMessage({ type: 'fetchModels' });
      });

      // Tell backend the webview is ready; delay to ensure VS Code message bridge is initialized
      setTimeout(function() { dbg('posting webviewReady'); vscode.postMessage({ type: 'webviewReady' }); dbg('webviewReady posted'); }, 0);
      window.addEventListener('beforeunload', function() { saveActiveSessionSnapshot(); });

      // ── \u8a18\u61b6\u7ba1\u7406 Modal ──────────────────────────────────────────────────────
      function onMemoryLoaded(msg) {
        if (msg.sessionId && msg.sessionId !== _activeChatSessionId) return;
        var area = document.getElementById('ltmArea');
        if (area) area.value = msg.ltm || '';
        renderLtmEntries();
        var pp = document.getElementById('personaPreview');
        if (pp) pp.value = msg.persona || '(\u672a\u8a2d\u5b9a)';
        var hii = document.getElementById('historyInfo');
        if (hii) hii.textContent = '\u5c0d\u8a71\u6b77\u53f2\uff1a' + (msg.historyCount || 0) + ' \u689d\u8a0a\u606f';
        var hp = document.getElementById('historyPreview');
        if (hp) hp.value = msg.historyPreview || (msg.historyCount ? '（歷史存在但無預覽）' : '（目前沒有對話歷史）');
        if (msg.usageStats) { renderUsageTable(msg.usageStats); }
      }

      function renderUsageTable(stats) {
        var wrap = document.getElementById('usageTableWrap');
        if (!wrap) return;
        var keys = stats ? Object.keys(stats) : [];
        if (keys.length === 0) { wrap.innerHTML = '<p style="font-size:11px;opacity:0.55;margin:2px 0">尚無資料</p>'; return; }
        var html = '<table class="usage-table"><thead><tr><th>模型</th><th>Tokens</th><th>費率</th></tr></thead><tbody>';
        var totalTokens = 0;
        keys.forEach(function(k) {
          var v = stats[k];
          var mult = v.multiplier || (v.isCopilot ? '1x' : '-');
          var dispTokens = v.tokens.toLocaleString();
          totalTokens += v.tokens;
          var cls = v.isCopilot ? ' class="usage-copilot"' : '';
          html += '<tr' + cls + '><td>' + k + '</td><td>' + dispTokens + '</td><td>' + mult + '</td></tr>';
        });
        if (keys.length > 1) { html += '<tr style="font-weight:600;border-top:1px solid rgba(128,128,128,0.3)"><td>合計</td><td>' + totalTokens.toLocaleString() + '</td><td></td></tr>'; }
        html += '</tbody></table>';
        wrap.innerHTML = html;
      }

      var memModal = document.getElementById('memModal');
      var memBtn = document.getElementById('memBtn');
      if (memBtn) {
        memBtn.addEventListener('click', function() {
          if (memModal) memModal.classList.add('open');
          vscode.postMessage({ type: 'memoryGet', sessionId: _activeChatSessionId });
        });
      }
      var memClose = document.getElementById('memClose');
      if (memClose) memClose.addEventListener('click', function() { if (memModal) memModal.classList.remove('open'); });
      if (memModal) memModal.addEventListener('click', function(e) { if (e.target === memModal) memModal.classList.remove('open'); });

      var saveLtmBtn = document.getElementById('saveLtmBtn');
      if (saveLtmBtn) saveLtmBtn.addEventListener('click', function() {
        var area = document.getElementById('ltmArea');
        vscode.postMessage({ type: 'memorySave', ltm: area ? area.value : '' });
      });
      var clearLtmBtn = document.getElementById('clearLtmBtn');
      if (clearLtmBtn) clearLtmBtn.addEventListener('click', function() {
        var area = document.getElementById('ltmArea');
        if (area) area.value = '';
        renderLtmEntries();
        vscode.postMessage({ type: 'memorySave', ltm: '' });
      });
      var resetUsageBtn = document.getElementById('resetUsageBtn');
      if (resetUsageBtn) resetUsageBtn.addEventListener('click', function() {
        vscode.postMessage({ type: 'resetUsage' });
      });
      var ltmSearch = document.getElementById('ltmSearch');
      if (ltmSearch) ltmSearch.addEventListener('input', function() {
        var q = ltmSearch.value.trim().toLowerCase();
        if (!q) { ltmSearch.style.color = ''; ltmSearch.title = ''; return; }
        var area = document.getElementById('ltmArea');
        var lines = area ? area.value.split('\\n') : [];
        var matched = lines.filter(function(l) { return l.toLowerCase().indexOf(q) >= 0; });
        ltmSearch.style.color = matched.length > 0 ? '' : 'var(--vscode-inputValidation-errorBorder,#f48771)';
        ltmSearch.title = matched.length > 0 ? matched.length + ' \u884c\u7b26\u5408' : '\u7121\u7b26\u5408\u7d50\u679c';
      });
      var exportLtmBtn = document.getElementById('exportLtmBtn');
      if (exportLtmBtn) exportLtmBtn.addEventListener('click', function() {
        var area = document.getElementById('ltmArea');
        var content = area ? area.value : '';
        var d = new Date();
        var ds = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
        var data = JSON.stringify({ version: 1, exportedAt: d.toISOString(), ltm: content }, null, 2);
        var blob = new Blob([data], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a'); a.href = url; a.download = 'ltm-backup-' + ds + '.json'; a.click(); URL.revokeObjectURL(url);
      });
      var importLtmBtn = document.getElementById('importLtmBtn');
      var importLtmInput = document.getElementById('importLtmInput');
      if (importLtmBtn && importLtmInput) {
        importLtmBtn.addEventListener('click', function() { importLtmInput.click(); });
        importLtmInput.addEventListener('change', function() {
          var file = importLtmInput.files && importLtmInput.files[0];
          if (!file) return;
          var reader = new FileReader();
          reader.onload = function(e) {
            try {
              var obj = JSON.parse(e.target.result);
              var ltmText = typeof obj.ltm === 'string' ? obj.ltm : JSON.stringify(obj, null, 2);
              var area = document.getElementById('ltmArea');
              if (area) area.value = ltmText;
              renderLtmEntries();
              importLtmBtn.textContent = '\u2713 \u5df2\u532f\u5165';
              setTimeout(function() { importLtmBtn.textContent = '\uD83D\uDCE5 \u532f\u5165 JSON'; }, 2000);
            } catch(ex) {
              importLtmBtn.textContent = '\u274C \u683c\u5f0f\u932f\u8aa4';
              setTimeout(function() { importLtmBtn.textContent = '\uD83D\uDCE5 \u532f\u5165 JSON'; }, 2000);
            }
          };
          reader.readAsText(file); importLtmInput.value = '';
        });
      }
      // ── LTM 條目編輯器 與 分類標籤 ──────────────────────────────────────────
      var _ltmFilterTag = '';
      function parseLtmToEntries(text) {
        var lines = (text || '').split('\\n'), entries = [];
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i].trim(); if (!line) continue;
          var m = line.match(/^#(\S+)\s+([\s\S]*)$/);
          if (m) { entries.push({ tag: m[1], text: m[2] }); }
          else { entries.push({ tag: '', text: line }); }
        }
        return entries;
      }
      function entriesToLtm(entries) {
        return entries.map(function(e) { return e.tag ? '#' + e.tag + ' ' + e.text : e.text; }).join('\\n');
      }
      function renderLtmEntries() {
        var area = document.getElementById('ltmArea');
        var entries = parseLtmToEntries(area ? area.value : '');
        var tagCounts = {};
        entries.forEach(function(e) { if (e.tag) tagCounts[e.tag] = (tagCounts[e.tag] || 0) + 1; });
        var filterDiv = document.getElementById('ltmTagFilter');
        if (filterDiv) {
          filterDiv.innerHTML = '';
          var allChip = document.createElement('span'); allChip.className = 'ltm-tag-chip all' + (_ltmFilterTag === '' ? ' active' : '');
          allChip.textContent = '\u5168\u90e8 (' + entries.length + ')';
          allChip.addEventListener('click', function() { _ltmFilterTag = ''; renderLtmEntries(); }); filterDiv.appendChild(allChip);
          Object.keys(tagCounts).sort().forEach(function(tag) {
            var chip = document.createElement('span'); chip.className = 'ltm-tag-chip' + (_ltmFilterTag === tag ? ' active' : '');
            chip.textContent = '#' + tag + ' (' + tagCounts[tag] + ')';
            (function(t) { chip.addEventListener('click', function() { _ltmFilterTag = t; renderLtmEntries(); }); })(tag);
            filterDiv.appendChild(chip);
          });
        }
        var list = document.getElementById('ltmEntryList'); if (!list) return;
        var filtered = _ltmFilterTag ? entries.filter(function(e) { return e.tag === _ltmFilterTag; }) : entries;
        list.innerHTML = '';
        if (!filtered.length) { list.innerHTML = '<span style="font-size:11px;opacity:0.5;padding:4px">' + (entries.length ? '\u7121\u7b26\u5408\u6a19\u7c64\u7684\u689d\u76ee' : '\u5c1a\u7121\u8a18\u61b6\u689d\u76ee') + '</span>'; return; }
        filtered.forEach(function(entry) {
          var actualIdx = entries.indexOf(entry);
          var row = document.createElement('div'); row.className = 'ltm-entry';
          var tagEl = document.createElement('button'); tagEl.className = 'ltm-entry-tag' + (entry.tag ? '' : ' no-tag');
          tagEl.textContent = entry.tag ? '#' + entry.tag : '\u2014';
          if (entry.tag) { (function(t) { tagEl.title = '\u7be9\u9078 #' + t; tagEl.addEventListener('click', function() { _ltmFilterTag = t; renderLtmEntries(); }); })(entry.tag); }
          var textEl = document.createElement('span'); textEl.className = 'ltm-entry-text'; textEl.textContent = entry.text; textEl.title = '\u9ede\u64ca\u7de8\u8f2f';
          (function(idx, e) { textEl.addEventListener('click', function() {
            var inp = prompt('\u7de8\u8f2f\u689d\u76ee\uff1a', e.text);
            if (inp !== null && inp.trim() !== '') {
              var all = parseLtmToEntries(document.getElementById('ltmArea') ? document.getElementById('ltmArea').value : '');
              all[idx].text = inp.trim();
              var ar = document.getElementById('ltmArea'); if (ar) ar.value = entriesToLtm(all);
              renderLtmEntries();
            }
          }); })(actualIdx, entry);
          var del = document.createElement('button'); del.className = 'ltm-entry-del'; del.textContent = '\u2715'; del.title = '\u522a\u9664';
          (function(idx) { del.addEventListener('click', function() {
            var all = parseLtmToEntries(document.getElementById('ltmArea') ? document.getElementById('ltmArea').value : '');
            all.splice(idx, 1);
            var ar = document.getElementById('ltmArea'); if (ar) ar.value = entriesToLtm(all);
            renderLtmEntries();
          }); })(actualIdx);
          row.appendChild(tagEl); row.appendChild(textEl); row.appendChild(del); list.appendChild(row);
        });
      }
      function switchLtmTab(mode) {
        var ev = document.getElementById('ltmEntryView'); var rv = document.getElementById('ltmRawView');
        var te = document.getElementById('ltmTabEntry'); var tr = document.getElementById('ltmTabRaw');
        if (mode === 'entry') {
          if (ev) ev.style.display = ''; if (rv) rv.style.display = 'none';
          if (te) te.classList.add('active'); if (tr) tr.classList.remove('active');
          renderLtmEntries();
        } else {
          if (ev) ev.style.display = 'none'; if (rv) rv.style.display = '';
          if (te) te.classList.remove('active'); if (tr) tr.classList.add('active');
        }
      }
      var ltmTabEntryBtn = document.getElementById('ltmTabEntry');
      if (ltmTabEntryBtn) ltmTabEntryBtn.addEventListener('click', function() { switchLtmTab('entry'); });
      var ltmTabRawBtn = document.getElementById('ltmTabRaw');
      if (ltmTabRawBtn) ltmTabRawBtn.addEventListener('click', function() { switchLtmTab('raw'); });
      var ltmAddBtn = document.getElementById('ltmAddBtn');
      if (ltmAddBtn) ltmAddBtn.addEventListener('click', function() {
        var tagInp = document.getElementById('ltmAddTag'); var textInp = document.getElementById('ltmAddText');
        var tag = tagInp ? tagInp.value.trim().replace(/^#+/, '').replace(/\s+/g, '_') : '';
        var text = textInp ? textInp.value.trim() : '';
        if (!text) { if (textInp) textInp.focus(); return; }
        var area = document.getElementById('ltmArea');
        var all = parseLtmToEntries(area ? area.value : '');
        all.push({ tag: tag, text: text });
        if (area) area.value = entriesToLtm(all);
        if (tagInp) tagInp.value = ''; if (textInp) textInp.value = '';
        renderLtmEntries();
      });
      var ltmAddTextEl = document.getElementById('ltmAddText');
      if (ltmAddTextEl) ltmAddTextEl.addEventListener('keydown', function(e) { if (e.key === 'Enter') { var b = document.getElementById('ltmAddBtn'); if (b) b.click(); } });
      var clearHistoryBtn2 = document.getElementById('clearHistoryBtn2');
      if (clearHistoryBtn2) clearHistoryBtn2.addEventListener('click', function() {
        chat.innerHTML = ''; _streamNode = null; _agentStepNode = null; _pendingBubble = null;
        var hp = document.getElementById('historyPreview'); if (hp) hp.value = '（已清除）';
        var hii = document.getElementById('historyInfo'); if (hii) hii.textContent = '對話歷史：0 條訊息';
        saveActiveSessionSnapshot();
        vscode.postMessage({ type: 'clearHistory', sessionId: _activeChatSessionId });
      });
      var consolidateLtmBtn = document.getElementById('consolidateLtmBtn');
      if (consolidateLtmBtn) consolidateLtmBtn.addEventListener('click', function() {
        vscode.postMessage({ type: 'memoryConsolidate', sessionId: _activeChatSessionId });
      });
      var editPersonaBtn = document.getElementById('editPersonaBtn');
      if (editPersonaBtn) editPersonaBtn.addEventListener('click', function() {
        vscode.postMessage({ type: 'openSettings' });
      });

      // JS-side safety net: if connectionStatus never arrives in 5s, ask again
      // ── Permission dialog ───────────────────────────────────────────────
      var _currentPermCategory = '';
      function showPermissionBar(category, description, forceConfirm) {
        _currentPermCategory = category || '';
        var bar = document.getElementById('permissionBar');
        var desc = document.getElementById('permissionDesc');
        if (!bar || !desc) return;
        var catLabel = { write: '\u{1F4BE} \u5beb\u5165\u6a94\u6848', delete: '\u{1F5D1} \u522a\u9664\u6a94\u6848', run: '\u{25B6}\uFE0F \u57f7\u884c\u6307\u4ee4' }[category] || '\u26A0\uFE0F \u654f\u611f\u64cd\u4f5c';
        desc.textContent = catLabel + '\uff1a' + description;
        bar.classList.add('visible');
        var permAlwaysEl = document.getElementById('permAlways');
        if (permAlwaysEl) { permAlwaysEl.style.display = forceConfirm ? 'none' : ''; }
      }
      function hidePermissionBar() {
        var bar = document.getElementById('permissionBar');
        if (bar) bar.classList.remove('visible');
        _currentPermCategory = '';
      }
      var permAllow = document.getElementById('permAllow');
      var permAlways = document.getElementById('permAlways');
      var permDeny = document.getElementById('permDeny');
      if (permAllow) permAllow.addEventListener('click', function() {
        var cat = _currentPermCategory;
        hidePermissionBar();
        vscode.postMessage({ type: 'permissionResponse', allow: true, always: false, category: cat });
      });
      if (permAlways) permAlways.addEventListener('click', function() {
        var cat = _currentPermCategory;
        hidePermissionBar();
        vscode.postMessage({ type: 'permissionResponse', allow: true, always: true, category: cat });
      });
      if (permDeny) permDeny.addEventListener('click', function() {
        var cat = _currentPermCategory;
        hidePermissionBar();
        vscode.postMessage({ type: 'permissionResponse', allow: false, always: false, category: cat });
      });

      var debugBtnEl = document.getElementById('debugBtn');
      dbg('debugBtn found: ' + !!debugBtnEl);
      if (debugBtnEl) {
        debugBtnEl.addEventListener('click', function() {
          var dp = document.getElementById('debugPanel');
          if (!dp) return;
          if (dp.style.display === 'none') {
            dp.style.display = 'block';
            dp.textContent = (window._debugLog || ['(no logs)']).join('\\n');
            dp.scrollTop = dp.scrollHeight;
          } else {
            dp.style.display = 'none';
          }
        });
      }
      dbg('connStatus initial: ' + (document.getElementById('connStatus') || {}).textContent);
      dbg('script completed OK, all functions defined');

      setTimeout(function() {
        dbg('safety-net timer fired, connStatus=' + ((document.getElementById('connStatus') || {}).textContent || '?'));
        var el = document.getElementById('connStatus');
        if (el && el.textContent.indexOf('\u6aa2\u67e5\u4e2d') !== -1) {
          vscode.postMessage({ type: 'fetchModels' });
        }
      }, 5000);
    </script>
  </body>
</html>`;
  }

  private async handleTeamSend(prompt: string, selectedModels?: string[], rounds?: string | number, teamExecMode?: string, maxParallel?: number): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('amiAiClaw');
    const urls = getOllamaUrls(cfg);
    const defaultBaseUrl = urls[0];
    const isOllamaModel = (m: string) => !m.startsWith('copilot/') && !m.startsWith('copilot::');
    // Decode URL from model ID (multi-server: "http://host:port||model")
    const getWorkerUrl = (m: string) => isOllamaModel(m) ? decodeOllamaModel(m, urls).url : defaultBaseUrl;
    const getWorkerModel = (m: string) => isOllamaModel(m) ? decodeOllamaModel(m, urls).model : m;
    // Use first selected model as primary; fallback to config or first live model (never hardcode llama3)
    const configuredModel = cfg.get<string>('model') ?? '';
    const primaryOllamaModel = (selectedModels && selectedModels.length > 0)
      ? selectedModels.find(m => isOllamaModel(m)) ?? selectedModels[0]
      : configuredModel;
    const allModels = (selectedModels && selectedModels.length > 0) ? selectedModels.slice(0, 5) : (primaryOllamaModel ? [primaryOllamaModel] : []);

    const COLORS = ['#4fc1ff', '#89d185', '#ce9178', '#c586c0', '#dcdcaa', '#f7cc65'];
    this._teamCancel = false;
    // Parse rounds parameter: 'infinite' or numeric; default 20
    const roundsSelected = rounds ?? '20';
    const roundsNum = String(roundsSelected) === 'infinite' ? Infinity : Number(roundsSelected) || 20;
    // 記錄使用者輸入到短期記憶
    this._chatHistory.push({ role: 'user', content: prompt });
    this._chatHistories[this._activeSessionId] = this._chatHistory;
    this._panel.webview.postMessage({ type: 'historyCount', count: this._chatHistory.length, sessionId: this._activeSessionId });

    // ── 討論模式：全員針對同一問題各自回答，依回合數重複，最後合成 ──────
    if (teamExecMode === 'discussion') {
      return this._handleTeamDiscussion(prompt, allModels, roundsNum);
    }

    // ── Agent 模式：每個成員用 handleAgent（含工具）各自獨立完成任務 ──────
    if (teamExecMode === 'agent') {
      return this._handleTeamAgent(prompt, allModels);
    }
    if (teamExecMode === 'manager') {
      return this._handleTeamManager(prompt, allModels, roundsNum);
    }

    let finalDebateSummary = '';
    const systemContent = this.buildSystemContent();
    // Workspace context for all team prompts
    const wsFolders = vscode.workspace.workspaceFolders ?? [];
    const wsRoot = wsFolders.map(f => f.uri.fsPath).join(', ') || process.cwd();
    const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath ?? '';
    const openFiles = vscode.workspace.textDocuments.filter(d => !d.isUntitled && d.uri.scheme === 'file').map(d => d.uri.fsPath);
    const wsContext = `【工作區】${wsRoot}${activeFile ? '\n【作用中檔案】' + activeFile : ''}${openFiles.length ? '\n【開啟的檔案】\n' + openFiles.join('\n') : ''}`;
    // Normalize copilot prefix for handleAgent: copilot/xxx → copilot::xxx
    const normalizeForAgent = (m: string) => m.startsWith('copilot/') ? 'copilot::' + m.slice('copilot/'.length) : (m.includes('||') ? 'copilot::' + getWorkerModel(m) : m);
    const getDisplay = (m: string) => {
      if (m.startsWith('copilot/')) return '\uD83D\uDC19 ' + m.slice('copilot/'.length);
      if (m.startsWith('copilot::')) return '\uD83D\uDC19 ' + m.slice('copilot::'.length);
      if (m.includes('||')) { const { url, model } = decodeOllamaModel(m, urls); try { const u = new URL(url); return `[${u.hostname}:${u.port||'11434'}] ${model}`; } catch { return model; } }
      return m;
    };

    // Detect orchestrator: first Copilot model in the selection
    const copilotIdx = allModels.findIndex(m => m.startsWith('copilot/') || m.startsWith('copilot::'));
    const hasOrchestrator = copilotIdx >= 0;
    const orchestratorFamily = hasOrchestrator ? (allModels[copilotIdx].startsWith('copilot::') ? allModels[copilotIdx].slice('copilot::'.length) : allModels[copilotIdx].slice('copilot/'.length)) : '';
    const workerModels = hasOrchestrator
      ? [...allModels.slice(0, copilotIdx), ...allModels.slice(copilotIdx + 1)]
      : allModels;
    // Ensure at least one worker in orchestration mode
    const effectiveWorkers = (hasOrchestrator && workerModels.length === 0) ? [primaryOllamaModel] : workerModels;

    const results: { model: string; response: string }[] = [];

    if (hasOrchestrator) {
      // ── Orchestration mode ────────────────────────────────────────────────
      const orchestratorDisplay = '\uD83D\uDC19 ' + orchestratorFamily;

      // Phase 0: Orchestrator generates granular task list
      this._panel.webview.postMessage({ type: 'teamOrchestratorStart', model: orchestratorDisplay });
      const numCopilotTasks = Math.max(effectiveWorkers.length * 2, 4);
      const cAvailWorkerNames = effectiveWorkers.map(m => getDisplay(m)).join(', ');
      const planPrompt = `你是 AI 工作協調員。請分析下面的任務，拆分成 ${numCopilotTasks} 個細緻子任務。\n可用助手（依名稱指派）：${cAvailWorkerNames}\n\n${wsContext}\n\n【任務】\n${prompt}\n\n只回傳 JSON（不含說明文字），格式範例：\n{"assignments":[\n  {"index":0,"task":"子任務描述","preferred_model":"助手名稱片段(可省略)","deps":[]},\n  {"index":1,"task":"子任務描述","deps":[0]}\n]}\ndeps: 依賴的前置任務索引陣列（空=立即可執行）。preferred_model: 適合的助手名稱片段（可省略）。`;
      interface CAssignItem { index: number; task: string; deps: number[]; preferred_model?: string; _taken: boolean; _done: boolean; _retries: number; }
      let assignments: CAssignItem[] = [{ index: 0, task: prompt, deps: [], _taken: false, _done: false, _retries: 0 }];
      try {
        const planText = await this.copilotStream(
          orchestratorFamily, planPrompt,
          (chunk) => { if (!this._teamCancel) this._panel.webview.postMessage({ type: 'teamOrchestratorChunk', chunk }); }
        );
        const jsonMatch = planText.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [null, null];
        const jsonStr = (jsonMatch[1] ?? planText).trim();
        const parsed = JSON.parse(jsonStr);
        if (Array.isArray(parsed.assignments)) {
          const raw = parsed.assignments.map((a: { index: number; task: string; preferred_model?: string; deps?: number[] }) => ({
            index: Number(a.index), task: String(a.task),
            deps: Array.isArray(a.deps) ? a.deps.map(Number) : [],
            preferred_model: a.preferred_model ? String(a.preferred_model) : undefined,
            _taken: false, _done: false, _retries: 0
          }));
          const seen = new Set<string>();
          assignments = raw.filter((a: CAssignItem) => { if (seen.has(a.task)) return false; seen.add(a.task); return true; });
          if (assignments.length === 0) assignments = [{ index: 0, task: prompt, deps: [], _taken: false, _done: false, _retries: 0 }];
        }
      } catch { /* use default single-task fallback */ }
      this._panel.webview.postMessage({ type: 'teamOrchestratorEnd' });
      this._panel.webview.postMessage({ type: 'teamTodoList', tasks: assignments.map(a => a.task) });

      if (this._teamCancel) { this._panel.webview.postMessage({ type: 'teamEnd' }); return; }

      // Phase 1: Workers pick tasks from queue, each reviewed by Copilot orchestrator
      const copilotReviewFn = (p: string, onChunk: (c: string) => void) =>
        this.copilotStream(orchestratorFamily, p, onChunk);
      const maxPar = Math.max(1, Math.min(Number(maxParallel ?? 3), effectiveWorkers.length));
      let cWorkerIdx = 0;
      const nextAvailCopilotTask = (): CAssignItem | null => {
        const t = assignments.find(a => !a._taken && !a._done &&
          a.deps.every(dep => assignments.find(d => d.index === dep)?._done));
        if (t) { t._taken = true; }
        return t ?? null;
      };

      await Promise.all(Array.from({ length: maxPar }, async () => {
        let taskItem: CAssignItem | null;
        while ((taskItem = nextAvailCopilotTask()) !== null && !this._teamCancel) {
          const prefModel = taskItem.preferred_model
            ? effectiveWorkers.find(m => getDisplay(m).toLowerCase().includes((taskItem!.preferred_model ?? '').toLowerCase()))
            : undefined;
          const model = prefModel ?? effectiveWorkers[cWorkerIdx % effectiveWorkers.length];
          cWorkerIdx++;
          const displayName = getDisplay(model);
          const id = `team_t${taskItem.index}`;
          const color = COLORS[taskItem.index % COLORS.length];
          this._panel.webview.postMessage({ type: 'teamTodoStart', idx: taskItem.index, worker: displayName });
          this._panel.webview.postMessage({ type: 'teamMemberStart', id, model: displayName, color, task: taskItem.task });
          if (taskItem._retries > 0) {
            this._panel.webview.postMessage({ type: 'teamResponseChunk', id, chunk: `\uD83D\uDD04 \u7b2c ${taskItem._retries} \u6b21\u91cd\u8a66\uff0c\u6539\u7528 ${displayName}...\n` });
          }
          try {
              const response = await this.runWorkerDiscussion(getWorkerModel(model), copilotReviewFn, getWorkerUrl(model), taskItem.task, id, color, roundsNum);
            taskItem._done = true;
            results.push({ model: displayName, response });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            this._panel.webview.postMessage({ type: 'teamResponseChunk', id, chunk: `[\u932f\u8aa4] ${msg}` });
            taskItem._retries++;
            if (taskItem._retries < 2) {
              taskItem._taken = false; // re-queue for retry with different worker
              this._panel.webview.postMessage({ type: 'teamOrchestratorChunk', chunk: `\n\u26a0\ufe0f \u4efb\u52d9#${taskItem.index} \u5931\u6557\uff0c\u6392\u5165\u7b2c ${taskItem._retries} \u6b21\u91cd\u8a66...\n` });
            } else {
              taskItem._done = true; // give up
              results.push({ model: displayName, response: `\u932f\u8aa4: ${msg}` });
              this._panel.webview.postMessage({ type: 'teamOrchestratorChunk', chunk: `\n\u274c \u4efb\u52d9#${taskItem.index} \u5df2\u9054\u91cd\u8a66\u4e0a\u9650\uff0c\u8df3\u904e\u3002\n` });
            }
          }
          this._panel.webview.postMessage({ type: 'teamMemberEnd', id });
          if (taskItem._done) {
            this._panel.webview.postMessage({ type: 'teamTodoDone', idx: taskItem.index });
          }
        }
      }));

      if (this._teamCancel) { this._panel.webview.postMessage({ type: 'teamEnd' }); return; }

      // Phase 2: Orchestrator (Copilot) synthesizes all worker results
      let synthResult = '';
      if (results.length > 0) {
        const synthPrompt = `【原始任務】\n${prompt}\n\n各助手已完成分配的工作，結果如下：\n${results.map(r => `\n--- ${r.model} ---\n${r.response}`).join('')}\n\n請以繁體中文，整合所有結果，給出完整的綜合回覆（條列重點）：`;
        this._panel.webview.postMessage({ type: 'teamSynthStart' });
        try {
          synthResult = await this.copilotStream(
            orchestratorFamily, synthPrompt,
            (chunk) => { if (!this._teamCancel) this._panel.webview.postMessage({ type: 'teamSynthChunk', chunk }); }
          );
        } catch { /* ignore */ }
        // 將協調員的綜合結果記入短期記憶
        if (synthResult && synthResult.trim()) {
          this._chatHistory.push({ role: 'assistant', content: synthResult });
          this._chatHistories[this._activeSessionId] = this._chatHistory;
          this._panel.webview.postMessage({ type: 'historyCount', count: this._chatHistory.length, sessionId: this._activeSessionId });
        }
      }

      // Phase 3: Agent executor
      const agentModel = normalizeForAgent(effectiveWorkers.find(m => !m.startsWith('copilot/') && !m.startsWith('copilot::')) ?? primaryOllamaModel ?? effectiveWorkers[0] ?? '');
      const willRunAgent = !this._teamCancel && synthResult.trim().length > 0 && !!agentModel;
      this._panel.webview.postMessage({ type: 'teamEnd', agentFollows: willRunAgent });
      if (willRunAgent) {
        this._panel.webview.postMessage({ type: 'teamAgentStart', model: agentModel });
        this._agentMessages = [];
        this._agentMessagesBySession[this._activeSessionId] = this._agentMessages;
        await this.handleAgent(`根據以下團隊討論結論，立即執行必要操作來完成使用者的任務。\n\n${wsContext}\n\n【原始任務】\n${prompt}\n\n【團隊綜合結論】\n${synthResult}\n\n【強制規則】\n- 訊息中出現 Jira Key（如 UOEM2-3476）→ 立即呼叫 jira_fetch，禁止說「我將查詢」。\n- 需要理解工作區代碼 → 立即呼叫 read_file / search_workspace，禁止假設內容。\n- 看到任務就執行工具，不得宣告意圖後停止。\n\n請逐步執行。`, agentModel, false);
      }

    } else {
      // ── Ollama-only: 最具思考能力的模型擔任協調員 ──────────────────────────
      // Ollama 同一 URL 同時只能跑一個 LLM，所有呼叫必須序列執行
      const thinkModel = OllamaChatPanel.pickThinkingModel(effectiveWorkers);

      // 序列 Ollama wrapper：使用 retry（ECONNRESET/timeout → 等 60s 再試，最多 10 次）
      // model 可能為 "url||model" 格式，自動 decode
      const postStatus = (msg: string) => { this._panel.webview.postMessage({ type: 'teamOrchestratorChunk', chunk: msg }); };
      const ollamaCall = (model: string, prompt2: string,
        onResp: (c: string) => void, onThink?: (c: string) => void) => {
        const { url: mUrl, model: mName } = decodeOllamaModel(model, urls);
        return ollamaGenerateStreamWithRetry(
          mUrl, mName, prompt2, onResp, onThink,
          (attempt, waitSec, err) => {
            postStatus(`\n⚠️ [${mName}] 連線失敗 (${err})，第 ${attempt} 次重試，等待 ${waitSec}s...\n`);
          }
        );
      };

      if (effectiveWorkers.length === 1) {
        // 單一模型：直接執行，無需討論
        const soloModel = effectiveWorkers[0];
        const soloId = 'team_0';
        const soloColor = COLORS[0];
        const soloPrompt = systemContent.trim() ? `System: ${systemContent}\n\nUser: ${prompt}` : prompt;
        this._panel.webview.postMessage({ type: 'teamMemberStart', id: soloId, model: soloModel, color: soloColor });
        try {
          let soloThinkBuf = ''; let soloThinkTimer: ReturnType<typeof setTimeout> | null = null;
          const soloFlushThink = () => {
            if (soloThinkBuf) { this._panel.webview.postMessage({ type: 'teamThinkChunk', id: soloId, color: soloColor, chunk: soloThinkBuf }); soloThinkBuf = ''; }
            soloThinkTimer = null;
          };
          const soloResponse = await ollamaCall(
            soloModel, soloPrompt,
            (chunk) => { if (!this._teamCancel) this._panel.webview.postMessage({ type: 'teamResponseChunk', id: soloId, chunk }); },
            (tc) => { if (!this._teamCancel) { soloThinkBuf += tc; if (!soloThinkTimer) soloThinkTimer = setTimeout(soloFlushThink, 80); } }
          );
          if (soloThinkTimer) { clearTimeout(soloThinkTimer); } soloFlushThink();
          results.push({ model: soloModel, response: soloResponse });
          // 記錄單一模型回覆到短期記憶
          if (soloResponse && soloResponse.trim()) {
            this._chatHistory.push({ role: 'assistant', content: soloResponse });
            this._chatHistories[this._activeSessionId] = this._chatHistory;
            this._panel.webview.postMessage({ type: 'historyCount', count: this._chatHistory.length, sessionId: this._activeSessionId });
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          this._panel.webview.postMessage({ type: 'teamResponseChunk', id: soloId, chunk: `[錯誤] ${msg}` });
          results.push({ model: soloModel, response: `錯誤: ${msg}` });
        }
        this._panel.webview.postMessage({ type: 'teamMemberEnd', id: soloId });
        this._panel.webview.postMessage({ type: 'teamEnd', agentFollows: false });

      } else {
        // 多模型序列模式：思考模型擔任協調員，所有 Ollama 呼叫依序執行
        // Phase 0: 思考模型生成細緻任務清單 (JSON)
        this._panel.webview.postMessage({ type: 'teamOrchestratorStart', model: '\uD83D\uDC19 ' + thinkModel });
        const numOllamaTasks = Math.max(effectiveWorkers.length * 2, 4);
        const tAvailWorkerNames = effectiveWorkers.map(m => getDisplay(m)).join(', ');
        const tPlanPrompt = `你是 AI 工作協調員。請分析下面的任務，拆分成 ${numOllamaTasks} 個細緻子任務。\n可用助手（依名稱指派）：${tAvailWorkerNames}\n\n${wsContext}\n\n【任務】\n${prompt}\n\n只回傳 JSON（不含說明文字），格式範例：\n{"assignments":[\n  {"index":0,"task":"子任務描述","preferred_model":"助手名稱片段(可省略)","deps":[]},\n  {"index":1,"task":"子任務描述","deps":[0]}\n]}\ndeps: 依賴的前置任務索引陣列（空=立即可執行）。preferred_model: 適合的助手名稱片段（可省略）。`;
        // Tasks: pending=not started, running=in progress, done=completed, failed=error
        type TaskStatus = 'pending' | 'running' | 'done' | 'failed';
        interface TaskItem { index: number; task: string; status: TaskStatus; assignedTo?: string; response?: string; deps: number[]; preferred_model?: string; retries: number; }
        let tTasks: TaskItem[] = [{ index: 0, task: prompt, status: 'pending' as TaskStatus, deps: [], retries: 0 }];
        try {
          const tPlanText = await ollamaCall(
            thinkModel, tPlanPrompt,
            (chunk) => { if (!this._teamCancel) this._panel.webview.postMessage({ type: 'teamOrchestratorChunk', chunk }); },
            (tc) => { if (!this._teamCancel) this._panel.webview.postMessage({ type: 'teamOrchestratorThinkChunk', chunk: tc }); }
          );
          const tJsonMatch = tPlanText.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [null, null];
          const tJsonStr = (tJsonMatch[1] ?? tPlanText).trim();
          const tParsed = JSON.parse(tJsonStr);
          if (Array.isArray(tParsed.assignments)) {
            const raw = tParsed.assignments.map((a: { index: number; task: string; preferred_model?: string; deps?: number[] }) => ({
              index: Number(a.index), task: String(a.task), status: 'pending' as TaskStatus,
              deps: Array.isArray(a.deps) ? a.deps.map(Number) : [],
              preferred_model: a.preferred_model ? String(a.preferred_model) : undefined,
              retries: 0
            }));
            const seen = new Set<string>();
            tTasks = raw.filter((a: TaskItem) => { if (seen.has(a.task)) return false; seen.add(a.task); return true; });
            if (tTasks.length === 0) tTasks = [{ index: 0, task: prompt, status: 'pending' as TaskStatus, deps: [], retries: 0 }];
          }
        } catch { /* use default single-task fallback */ }
        this._panel.webview.postMessage({ type: 'teamOrchestratorEnd' });
        this._panel.webview.postMessage({ type: 'teamTodoList', tasks: tTasks.map(a => a.task) });
        if (this._teamCancel) { this._panel.webview.postMessage({ type: 'teamEnd' }); return; }

        // Phase 1: 序列執行 — 依序讓每個模型處理一個任務，巡迴直到全部完成
        // 序列佇列：一次只跑一個 Ollama call（包括 review）
        const ollamaReviewFn = async (p: string, onChunk: (c: string) => void) =>
          ollamaCall(thinkModel, p, onChunk);

        // DAG-aware: only pick tasks whose deps are all 'done'
        const getNextPending = () => tTasks.find(t =>
          t.status === 'pending' &&
          t.deps.every(dep => tTasks.find(d => d.index === dep)?.status === 'done')
        ) ?? null;
        const workerCycle = [...effectiveWorkers];
        let workerIdx = 0;

        while (!this._teamCancel) {
          const activeItem = getNextPending();
          if (!activeItem) break;

          // Dynamic role assignment: prefer model matching preferred_model hint
          let model = workerCycle[workerIdx % workerCycle.length];
          workerIdx++;
          if (activeItem.preferred_model) {
            const preferred = workerCycle.find(m => getDisplay(m).toLowerCase().includes((activeItem.preferred_model ?? '').toLowerCase()));
            if (preferred) { model = preferred; }
          }
          activeItem.status = 'running';
          activeItem.assignedTo = model;

          const id = `team_t${activeItem.index}`;
          const color = COLORS[activeItem.index % COLORS.length];
          this._panel.webview.postMessage({ type: 'teamTodoStart', idx: activeItem.index, worker: model });
          this._panel.webview.postMessage({ type: 'teamMemberStart', id, model, color, task: activeItem.task });
          if (activeItem.retries > 0) {
            this._panel.webview.postMessage({ type: 'teamResponseChunk', id, chunk: `\uD83D\uDD04 \u7b2c ${activeItem.retries} \u6b21\u91cd\u8a66\uff0c\u6539\u7528 ${getDisplay(model)}...\n` });
          }

          try {
            const response = await this.runWorkerDiscussion(
              getWorkerModel(model), ollamaReviewFn, getWorkerUrl(model), activeItem.task, id, color, roundsNum,
              ollamaCall
            );
            activeItem.status = 'done';
            activeItem.response = response;
            results.push({ model, response });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            this._panel.webview.postMessage({ type: 'teamResponseChunk', id, chunk: `[\u932f\u8aa4] ${msg}` });
            activeItem.retries++;
            if (activeItem.retries < 2) {
              activeItem.status = 'pending'; // re-queue for retry with different worker
              this._panel.webview.postMessage({ type: 'teamOrchestratorChunk', chunk: `\n\u26a0\ufe0f \u4efb\u52d9#${activeItem.index} \u5931\u6557\uff0c\u6392\u5165\u7b2c ${activeItem.retries} \u6b21\u91cd\u8a66...\n` });
            } else {
              activeItem.status = 'failed';
              results.push({ model, response: `\u932f\u8aa4: ${msg}` });
              this._panel.webview.postMessage({ type: 'teamOrchestratorChunk', chunk: `\n\u274c \u4efb\u52d9#${activeItem.index} \u5df2\u9054\u91cd\u8a66\u4e0a\u9650\uff0c\u8df3\u904e\u3002\n` });
            }
          }
          this._panel.webview.postMessage({ type: 'teamMemberEnd', id });
          if (activeItem.status === 'done' || activeItem.status === 'failed') {
            this._panel.webview.postMessage({ type: 'teamTodoDone', idx: activeItem.index });
          }
        }

        // Cascade-fail: pending tasks blocked by failed deps
        for (const t of tTasks.filter(t => t.status === 'pending')) {
          t.status = 'failed';
          results.push({ model: thinkModel, response: `[\u4efb\u52d9#${t.index} \u56e0\u4f9d\u8cf4\u4efb\u52d9\u672a\u5b8c\u6210\u800c\u8df3\u904e]` });
          this._panel.webview.postMessage({ type: 'teamTodoDone', idx: t.index });
          this._panel.webview.postMessage({ type: 'teamOrchestratorChunk', chunk: `\n\u26d4 \u4efb\u52d9#${t.index}\uff08${t.task.slice(0, 30)}\uff09\u56e0\u524d\u7f6e\u4efb\u52d9\u672a\u5b8c\u6210\u800c\u8df3\u904e\u3002\n` });
        }

        if (this._teamCancel) { this._panel.webview.postMessage({ type: 'teamEnd' }); return; }

        // Phase 2: 思考模型綜合所有工作結果
        let tSynthResult = '';
        if (results.length > 0) {
          const tSynthPrompt = `【原始任務】\n${prompt}\n\n各助手已完成分配的工作，結果如下：\n${results.map(r => `\n--- ${r.model} ---\n${r.response}`).join('')}\n\n請以繁體中文，整合所有結果，給出完整的綜合回覆（條列重點）：`;
          this._panel.webview.postMessage({ type: 'teamSynthStart' });
          try {
            tSynthResult = await ollamaCall(
              thinkModel, tSynthPrompt,
              (chunk) => { if (!this._teamCancel) this._panel.webview.postMessage({ type: 'teamSynthChunk', chunk }); }
            );
          } catch { /* ignore */ }
        }

        // Phase 3: Agent executor
        const tAgentModel = normalizeForAgent(thinkModel);
        const tWillRunAgent = !this._teamCancel && tSynthResult.trim().length > 0;
        this._panel.webview.postMessage({ type: 'teamEnd', agentFollows: tWillRunAgent });
        if (tWillRunAgent) {
          this._panel.webview.postMessage({ type: 'teamAgentStart', model: tAgentModel });
          this._agentMessages = [];
          this._agentMessagesBySession[this._activeSessionId] = this._agentMessages;
          await this.handleAgent(`根據以下團隊討論結論，立即執行必要操作來完成使用者的任務。\n\n${wsContext}\n\n【原始任務】\n${prompt}\n\n【團隊綜合結論】\n${tSynthResult}\n\n【強制規則】\n- 訊息中出現 Jira Key（如 UOEM2-3476）→ 立即呼叫 jira_fetch，禁止說「我將查詢」。\n- 需要理解工作區代碼 → 立即呼叫 read_file / search_workspace，禁止假設內容。\n- 看到任務就執行工具，不得宣告意圖後停止。\n\n請逐步執行。`, tAgentModel, false);
        }
      }
    }
  }

  private static pickThinkingModel(models: string[]): string {
    if (models.length === 0) { return ''; }
    const RANK = [/deepseek-r1/i, /qwq/i, /r1/i, /thinking/i, /reasoner/i, /reflect/i];
    let best = models[0]; let bestScore = -1;
    for (const m of models) {
      const score = RANK.findIndex(r => r.test(m));
      const s = score === -1 ? RANK.length : score;
      if (bestScore === -1 || s < bestScore) { bestScore = s; best = m; }
    }
    return best;
  }

  // ── Team 討論模式 ────────────────────────────────────────────────────────
  /** 全員同題作答，每回合每人輪流發言，最後一輪收尾合成 */
  private async _handleTeamDiscussion(prompt: string, allModels: string[], maxRounds: number): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('amiAiClaw');
    const urls = getOllamaUrls(cfg);
    const COLORS = ['#4fc1ff', '#89d185', '#ce9178', '#c586c0', '#dcdcaa', '#f7cc65'];
    const isOllamaModel = (m: string) => !m.startsWith('copilot/') && !m.startsWith('copilot::');
    const getDisplay = (m: string) => {
      if (m.startsWith('copilot::')) return '\uD83D\uDC19 ' + m.slice('copilot::'.length);
      const { url, model } = decodeOllamaModel(m, urls);
      try { const u = new URL(url); return `[${u.hostname}:${u.port||'11434'}] ${model}`; } catch { return model; }
    };

    // ── 掃描並讀取工作區原始碼 + teamscontext.md ─────────────────────────────
    const _wsFolders = vscode.workspace.workspaceFolders ?? [];
    const _wsRoot = _wsFolders.length > 0 ? _wsFolders[0].uri.fsPath : process.cwd();
    this._panel.webview.postMessage({ type: 'debateStart',
      labelA: getDisplay(allModels[0]), labelB: getDisplay(allModels[1] ?? allModels[0]),
      labelJ: allModels[2] ? getDisplay(allModels[2]) : null,
      colorA: COLORS[0], colorB: COLORS[1], colorJ: COLORS[2],
      gameType: 'team-discussion',
      speakerLabels: Object.fromEntries(allModels.map((m,i) => [String(i), getDisplay(m)])),
      speakerColors: Object.fromEntries(allModels.map((m,i) => [String(i), COLORS[i % COLORS.length]])) });
    this._panel.webview.postMessage({ type: 'teamSynthChunk', chunk: '🔍 正在掃描工作區原始碼與 teamscontext.md…\n' });
    // 讀取 teamscontext.md（若存在）
    const _teamsCtxPath = path.join(_wsRoot, 'teamscontext.md');
    let _teamsCtxContent = '';
    try {
      const _tcBytes = await vscode.workspace.fs.readFile(vscode.Uri.file(_teamsCtxPath));
      _teamsCtxContent = Buffer.from(_tcBytes).toString('utf-8').trim();
    } catch { /* 不存在則略過 */ }
    // 掃描工作區所有原始碼
    const _SKIP_EXT = new Set(['.png','.jpg','.jpeg','.gif','.ico','.svg','.woff','.woff2','.ttf','.eot','.vsix','.zip','.tar','.gz','.exe','.dll','.pdf','.db','.sqlite','.lock']);
    const _SKIP_DIRS = '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**,**/build/**,**/.vscode-test/**,**/coverage/**}';
    // 上限提高至 2000，確保深層子目錄也能收集到；按路徑排序確保各子目錄均勻分布
    const _allUris = await vscode.workspace.findFiles('**/*', _SKIP_DIRS, 2000);
    _allUris.sort((a, b) => a.fsPath.localeCompare(b.fsPath));
    // Pass 1：生成完整路徑清單（不論內容是否被讀取，AI 至少知道所有檔案存在）
    const _filteredUris = _allUris.filter(uri => !_SKIP_EXT.has(path.extname(uri.fsPath).toLowerCase()));
    const _allRelPaths = _filteredUris.map(uri => path.relative(_wsRoot, uri.fsPath).replace(/\\/g, '/'));
    const _fileListBlock = `【工作區檔案清單（${_allRelPaths.length} 個）】\n${_allRelPaths.map(p => `  - ${p}`).join('\n')}`;
    // Pass 2：讀取原始碼內容，分批（每批 80KB），無法一口氣讀完則分批拼湊
    const _BATCH_SIZE = 80000;
    const _MAX_FILE = 15000;
    const _discBatches: string[][] = [];
    let _discCurBatch: string[] = [];
    let _discCurBatchBytes = 0;
    let _totalBytes = 0;
    for (const uri of _filteredUris) {
      const rel = path.relative(_wsRoot, uri.fsPath).replace(/\\/g, '/');
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        let text = Buffer.from(bytes).toString('utf-8');
        if (text.length > _MAX_FILE) { text = text.slice(0, _MAX_FILE) + `\n...（${rel} 已截斷，僅顯示前段）`; }
        const entry = `### ${rel}\n\`\`\`\n${text}\n\`\`\``;
        if (_discCurBatchBytes + entry.length > _BATCH_SIZE && _discCurBatch.length > 0) {
          _discBatches.push(_discCurBatch);
          _discCurBatch = []; _discCurBatchBytes = 0;
        }
        _discCurBatch.push(entry);
        _discCurBatchBytes += entry.length;
        _totalBytes += text.length;
      } catch { /* 略過無法讀取的二進位檔 */ }
    }
    if (_discCurBatch.length > 0) _discBatches.push(_discCurBatch);
    const _discReadCount = _discBatches.reduce((s, b) => s + b.length, 0);
    this._panel.webview.postMessage({ type: 'teamSynthChunk', chunk: `✅ 掃描完成：找到 ${_allRelPaths.length} 個檔案，分 ${_discBatches.length} 批讀取 ${_discReadCount} 個內容（${Math.round(_totalBytes/1024)}KB）\n` });

    // 建立多輪批次注入的初始對話歷史
    const _discBaseCtx = [
      `【工作區路徑】${_wsRoot}`,
      _teamsCtxContent ? `【teamscontext.md — 先前討論紀錄】\n${_teamsCtxContent}` : '',
      _fileListBlock,
    ].filter(Boolean).join('\n\n');
    const _batchedInitHist: { role: 'user'|'assistant'; content: string }[] = [];
    if (_discBatches.length > 0) {
      _batchedInitHist.push({ role: 'user', content:
        `${_discBaseCtx}\n\n【第 1/${_discBatches.length} 批原始碼（${_discBatches[0].length} 個檔案）】\n\n${_discBatches[0].join('\n\n')}`
      });
      for (let _bi = 1; _bi < _discBatches.length; _bi++) {
        _batchedInitHist.push({ role: 'assistant', content: `已閱讀第 ${_bi}/${_discBatches.length} 批（${_discBatches[_bi-1].length} 個檔案），繼續接收下一批。` });
        _batchedInitHist.push({ role: 'user', content:
          `【第 ${_bi+1}/${_discBatches.length} 批原始碼（${_discBatches[_bi].length} 個檔案）】\n\n${_discBatches[_bi].join('\n\n')}`
        });
      }
      _batchedInitHist.push({ role: 'assistant', content: `已完整閱讀全部 ${_discBatches.length} 批共 ${_allRelPaths.length} 個檔案（${Math.round(_totalBytes/1024)}KB）。請提出問題。` });
    } else {
      _batchedInitHist.push({ role: 'user', content: _discBaseCtx });
      _batchedInitHist.push({ role: 'assistant', content: '已閱讀工作區資訊。請提出問題。' });
    }
    _batchedInitHist.push({ role: 'user', content: prompt });
    // Copilot 走單字串路徑（copilotStream API 不支援多輪注入）
    const _copilotBatchCtx = [_discBaseCtx, ..._discBatches.map((b,i) => `【第 ${i+1}/${_discBatches.length} 批原始碼】\n\n${b.join('\n\n')}`)].join('\n\n');
    const _promptWithCtx = _copilotBatchCtx ? `${_copilotBatchCtx}\n\n---\n\n${prompt}` : prompt;

    const roundsLimit = isFinite(maxRounds) ? maxRounds : 4; // 討論模式無限預設 4 輪
    const summaryLines: string[] = [];

    // Each model has independent context; cross-model responses injected after each round
    const histories: Map<string, { role: 'user'|'assistant'; content: string }[]> = new Map();
    for (const m of allModels) { histories.set(m, [..._batchedInitHist]); }

    for (let round = 0; round < roundsLimit && !this._teamCancel; round++) {
      const roundResponses: { mi: number; display: string; response: string }[] = [];
      for (let mi = 0; mi < allModels.length && !this._teamCancel; mi++) {
        const model = allModels[mi];
        const color = COLORS[mi % COLORS.length];
        const display = getDisplay(model);
        const speakerKey = String(mi); // use index as "speaker" for debateTurn
        this._panel.webview.postMessage({ type: 'debateTurnStart', speaker: speakerKey, round, label: display, color });

        const hist = histories.get(model)!;
        let response = '';
        try {
          if (model.startsWith('copilot::')) {
            const family = model.slice('copilot::'.length);
            response = await this.copilotStream(family, _promptWithCtx,
              (c) => { if (!this._teamCancel) this._panel.webview.postMessage({ type: 'debateChunk', speaker: speakerKey, chunk: c }); });
          } else {
            const { url, model: mName } = decodeOllamaModel(model, urls);
            const messages: ChatMessage[] = [
              { role: 'system', content: `你是 ${display}，正在和其他 AI 討論以下問題。你可以參考工作區檔案內容進行分析。每次回答請根據前幾輪的對話內容延伸，不要重複，請提出新觀點或補充說明。` },
              ...hist.map(h => ({ role: h.role as 'user'|'assistant', content: h.content }))
            ];
            if (messages[messages.length - 1].role !== 'user') messages.push({ role: 'user', content: '請繼續。' });
            response = await ollamaChatStream(url, mName, messages,
              (c) => { if (!this._teamCancel) this._panel.webview.postMessage({ type: 'debateChunk', speaker: speakerKey, chunk: c }); },
              undefined,
              (tokens) => { this.trackUsage(mName, tokens); });
          }
        } catch (e) {
          response = '[錯誤: ' + (e instanceof Error ? e.message : String(e)) + ']';
          this._panel.webview.postMessage({ type: 'debateChunk', speaker: speakerKey, chunk: response });
        }
        this._panel.webview.postMessage({ type: 'debateTurnEnd', speaker: speakerKey });
        // Append own assistant turn; cross-model context injected after all models complete this round
        hist.push({ role: 'assistant', content: response });
        roundResponses.push({ mi, display, response });
        summaryLines.push(`【${display} 第${round+1}輪】\n${response}`);
      }
      // Cross-feed: inject other members' responses as the next user turn for each model
      if (!this._teamCancel) {
        for (let mi = 0; mi < allModels.length; mi++) {
          const hist = histories.get(allModels[mi])!;
          const others = roundResponses.filter(r => r.mi !== mi);
          if (others.length > 0) {
            const crossContext = others.map(o => `【${o.display}】：\n${o.response}`).join('\n\n---\n\n');
            hist.push({ role: 'user', content: `以下是其他成員在第 ${round + 1} 輪的觀點：\n\n${crossContext}\n\n請回應或補充上述觀點，提出你的反駁或延伸論點。` });
          } else {
            hist.push({ role: 'user', content: '請進一步補充說明。' });
          }
        }
      }
    }

    // 合成：用第一個模型或思考模型
    if (!this._teamCancel && summaryLines.length > 0) {
      const synthModel = OllamaChatPanel.pickThinkingModel(allModels.filter(m => isOllamaModel(m))) || allModels[0];
      const synthPrompt = `【原始問題】\n${prompt}\n\n【各成員觀點】\n${summaryLines.join('\n\n---\n\n')}\n\n請整合所有觀點，給出完整的綜合結論：`;
      this._panel.webview.postMessage({ type: 'teamSynthStart' });
      let synthResult = '';
      try {
        if (synthModel.startsWith('copilot::')) {
          synthResult = await this.copilotStream(synthModel.slice('copilot::'.length), synthPrompt,
            (c) => { if (!this._teamCancel) this._panel.webview.postMessage({ type: 'teamSynthChunk', chunk: c }); });
        } else {
          const { url, model: mName } = decodeOllamaModel(synthModel, urls);
          synthResult = await ollamaGenerateStream(url, mName, synthPrompt,
            (c) => { if (!this._teamCancel) this._panel.webview.postMessage({ type: 'teamSynthChunk', chunk: c }); });
        }
      } catch { /* ignore */ }
      if (synthResult) {
        this._chatHistory.push({ role: 'assistant', content: synthResult });
        this._chatHistories[this._activeSessionId] = this._chatHistory;
        this._panel.webview.postMessage({ type: 'historyCount', count: this._chatHistory.length, sessionId: this._activeSessionId });
      } else if (summaryLines.length) {
        this._chatHistory.push({ role: 'assistant', content: summaryLines.join('\n\n---\n\n') });
        this._chatHistories[this._activeSessionId] = this._chatHistory;
        this._panel.webview.postMessage({ type: 'historyCount', count: this._chatHistory.length, sessionId: this._activeSessionId });
      }
      // 儲存討論結果到 teamscontext.md
      const _discFinal = synthResult || summaryLines.join('\n\n---\n\n');
      if (_discFinal.trim()) {
        try {
          const _now = new Date().toISOString().replace('T', ' ').slice(0, 19);
          const _existing = _teamsCtxContent ? `${_teamsCtxContent}\n\n---\n\n` : '';
          const _newEntry = `## 討論紀錄 ${_now}\n\n**議題：** ${prompt.slice(0, 200)}${prompt.length > 200 ? '…' : ''}\n\n${_discFinal}`;
          await vscode.workspace.fs.writeFile(
            vscode.Uri.file(_teamsCtxPath),
            Buffer.from(_existing + _newEntry, 'utf-8')
          );
          this._panel.webview.postMessage({ type: 'teamSynthChunk', chunk: `\n\n---\n📝 討論結果已儲存至 teamscontext.md` });
        } catch (e) {
          this._panel.webview.postMessage({ type: 'teamSynthChunk', chunk: `\n\n⚠️ 無法儲存 teamscontext.md: ${e instanceof Error ? e.message : String(e)}` });
        }
      }
    }
    this._panel.webview.postMessage({ type: 'debateEnd', consensus: false });
    this._panel.webview.postMessage({ type: 'teamEnd', agentFollows: false });
  }

  // ── Team Agent 模式 ──────────────────────────────────────────────────────
  /** 每個選定的模型各自以 Agent 身份（含工具）處理同一個任務 */
  private async _handleTeamAgent(prompt: string, allModels: string[]): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('amiAiClaw');
    const urls = getOllamaUrls(cfg);
    const COLORS = ['#4fc1ff', '#89d185', '#ce9178', '#c586c0', '#dcdcaa', '#f7cc65'];
    const getDisplay = (m: string) => {
      if (m.startsWith('copilot::')) return '\uD83D\uDC19 ' + m.slice('copilot::'.length);
      const { url, model } = decodeOllamaModel(m, urls);
      try { const u = new URL(url); return `[${u.hostname}:${u.port||'11434'}] ${model}`; } catch { return model; }
    };

    this._panel.webview.postMessage({ type: 'teamTodoList', tasks: allModels.map(m => `[Agent] ${getDisplay(m)}`) });

    for (let mi = 0; mi < allModels.length && !this._teamCancel; mi++) {
      const model = allModels[mi];
      const color = COLORS[mi % COLORS.length];
      const display = getDisplay(model);
      const id = `tagent_${mi}`;
      this._panel.webview.postMessage({ type: 'teamTodoStart', idx: mi, worker: display });
      this._panel.webview.postMessage({ type: 'teamMemberStart', id, model: `🤖 ${display}`, color, task: prompt });

      // Pipe agent output to the team member bubble
      const origPost = this._panel.webview.postMessage.bind(this._panel.webview);
      const patchedPost = (msg: object & { type?: string }): Thenable<boolean> => {
        const t = (msg as { type?: string }).type;
        if (t === 'assistant') {
          origPost({ type: 'teamResponseChunk', id, chunk: (msg as { text?: string }).text ?? '' });
          return Promise.resolve(true);
        }
        if (t === 'assistantChunk') {
          origPost({ type: 'teamResponseChunk', id, chunk: (msg as { chunk?: string }).chunk ?? '' });
          return Promise.resolve(true);
        }
        if (t === 'agentStep' || t === 'agentStepDone' || t === 'agentStatus') {
          return origPost(msg); // pass through agent step indicators
        }
        return origPost(msg);
      };
      (this._panel.webview as { postMessage: (msg: object) => Thenable<boolean> }).postMessage = patchedPost;

      // Reset agent state for this worker
      this._agentMessages = [];
      this._agentMessagesBySession[this._activeSessionId] = this._agentMessages;

      try {
        await this.handleAgent(prompt, model, false);
      } catch { /* continue with next worker */ }

      // Restore original postMessage
      (this._panel.webview as { postMessage: (msg: object) => Thenable<boolean> }).postMessage = origPost;

      this._panel.webview.postMessage({ type: 'teamMemberEnd', id });
      this._panel.webview.postMessage({ type: 'teamTodoDone', idx: mi });
    }

    // restore a clean agent context
    this._agentMessages = [];
    this._agentMessagesBySession[this._activeSessionId] = this._agentMessages;
    this._panel.webview.postMessage({ type: 'teamEnd', agentFollows: false });
    this._panel.webview.postMessage({ type: 'agentStatus', running: false });
  }

  // ── Team 主管模式 ────────────────────────────────────────────────────────
  /**
   * 主管模式流程：
   * Phase-0 主管架構分析 → Phase-1 組員提案 → Phase-2 主管審核（循環直到 [APPROVED]）
   * → Phase-3 Agent 執行 → Phase-4 全員 Review
   * 人格與記憶分離：每個模型擁有自己獨立的系統提示詞與對話歷史。
   */
  private async _handleTeamManager(prompt: string, allModels: string[], maxRounds: number): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('amiAiClaw');
    const urls = getOllamaUrls(cfg);
    const COLORS = ['#f7cc65', '#4fc1ff', '#89d185', '#ce9178', '#c586c0', '#dcdcaa'];
    const isOllamaModel = (m: string) => !m.startsWith('copilot/') && !m.startsWith('copilot::');
    const getDisplay = (m: string) => {
      if (m.startsWith('copilot::')) return '🐙 ' + m.slice('copilot::'.length);
      const { url, model } = decodeOllamaModel(m, urls);
      try { const u = new URL(url); return `[${u.hostname}:${u.port || '11434'}] ${model}`; } catch { return model; }
    };
    if (allModels.length < 1) {
      this._panel.webview.postMessage({ type: 'error', text: '主管模式至少需要 1 個 AI 模型（第一個為主管）' });
      return;
    }

    // ── 掃描並讀取工作區原始碼 + teamscontext.md ─────────────────────────────
    const _mgrWsFolders = vscode.workspace.workspaceFolders ?? [];
    const _mgrWsRoot = _mgrWsFolders.length > 0 ? _mgrWsFolders[0].uri.fsPath : process.cwd();
    this._panel.webview.postMessage({ type: 'teamOrchestratorStart', model: '🔍 掃描工作區' });
    this._panel.webview.postMessage({ type: 'teamOrchestratorChunk', chunk: '🔍 正在掃描工作區原始碼與 teamscontext.md…\n' });
    // 讀取 teamscontext.md（若存在）
    const _mgrTeamsCtxPath = path.join(_mgrWsRoot, 'teamscontext.md');
    let _mgrTeamsCtxContent = '';
    try {
      const _mgrTcBytes = await vscode.workspace.fs.readFile(vscode.Uri.file(_mgrTeamsCtxPath));
      _mgrTeamsCtxContent = Buffer.from(_mgrTcBytes).toString('utf-8').trim();
    } catch { /* 不存在則略過 */ }
    // 掃描工作區所有原始碼
    const _mgrSKIP_EXT = new Set(['.png','.jpg','.jpeg','.gif','.ico','.svg','.woff','.woff2','.ttf','.eot','.vsix','.zip','.tar','.gz','.exe','.dll','.pdf','.db','.sqlite','.lock']);
    const _mgrSKIP_DIRS = '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**,**/build/**,**/.vscode-test/**,**/coverage/**}';
    // 上限提高至 2000，確保深層子目錄也能收集到；按路徑排序確保各子目錄均勻分布
    const _mgrAllUris = await vscode.workspace.findFiles('**/*', _mgrSKIP_DIRS, 2000);
    _mgrAllUris.sort((a, b) => a.fsPath.localeCompare(b.fsPath));
    // Pass 1：生成完整路徑清單（不論內容是否被讀取，AI 至少知道所有檔案存在）
    const _mgrFilteredUris = _mgrAllUris.filter(uri => !_mgrSKIP_EXT.has(path.extname(uri.fsPath).toLowerCase()));
    const _mgrAllRelPaths = _mgrFilteredUris.map(uri => path.relative(_mgrWsRoot, uri.fsPath).replace(/\\/g, '/'));
    const _mgrFileListBlock = `【工作區檔案清單（${_mgrAllRelPaths.length} 個）】\n${_mgrAllRelPaths.map(p => `  - ${p}`).join('\n')}`;
    // Pass 2：讀取原始碼內容，分批（每批 80KB），無法一口氣讀完則分批拼湊
    const _mgrBATCH_SIZE = 80000;
    const _mgrMAX_FILE = 15000;
    const _mgrBatches: string[][] = [];
    let _mgrCurBatch: string[] = [];
    let _mgrCurBatchBytes = 0;
    let _mgrTotalBytes = 0;
    for (const uri of _mgrFilteredUris) {
      const rel = path.relative(_mgrWsRoot, uri.fsPath).replace(/\\/g, '/');
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        let text = Buffer.from(bytes).toString('utf-8');
        if (text.length > _mgrMAX_FILE) { text = text.slice(0, _mgrMAX_FILE) + `\n...（${rel} 已截斷，僅顯示前段）`; }
        const entry = `### ${rel}\n\`\`\`\n${text}\n\`\`\``;
        if (_mgrCurBatchBytes + entry.length > _mgrBATCH_SIZE && _mgrCurBatch.length > 0) {
          _mgrBatches.push(_mgrCurBatch);
          _mgrCurBatch = []; _mgrCurBatchBytes = 0;
        }
        _mgrCurBatch.push(entry);
        _mgrCurBatchBytes += entry.length;
        _mgrTotalBytes += text.length;
      } catch { /* 略過二進位檔 */ }
    }
    if (_mgrCurBatch.length > 0) _mgrBatches.push(_mgrCurBatch);
    const _mgrReadCount = _mgrBatches.reduce((s, b) => s + b.length, 0);
    this._panel.webview.postMessage({ type: 'teamOrchestratorChunk', chunk: `✅ 掃描完成：找到 ${_mgrAllRelPaths.length} 個檔案，分 ${_mgrBatches.length} 批讀取 ${_mgrReadCount} 個內容（${Math.round(_mgrTotalBytes/1024)}KB）\n` });
    this._panel.webview.postMessage({ type: 'teamOrchestratorEnd' });
    // 建構 manager/member 多輪批次注入的初始歷史（所有成員共用相同的工作區閱讀序列）
    const _mgrBaseCtx = [
      `【工作區路徑】${_mgrWsRoot}`,
      _mgrTeamsCtxContent ? `【teamscontext.md — 先前討論紀錄】\n${_mgrTeamsCtxContent}` : '',
      _mgrFileListBlock,
    ].filter(Boolean).join('\n\n');
    const _mgrBatchedInitHist: { role: 'user'|'assistant'; content: string }[] = [];
    if (_mgrBatches.length > 0) {
      _mgrBatchedInitHist.push({ role: 'user', content:
        `${_mgrBaseCtx}\n\n【第 1/${_mgrBatches.length} 批原始碼（${_mgrBatches[0].length} 個檔案）】\n\n${_mgrBatches[0].join('\n\n')}`
      });
      for (let _bi = 1; _bi < _mgrBatches.length; _bi++) {
        _mgrBatchedInitHist.push({ role: 'assistant', content: `已閱讀第 ${_bi}/${_mgrBatches.length} 批（${_mgrBatches[_bi-1].length} 個檔案），繼續接收下一批。` });
        _mgrBatchedInitHist.push({ role: 'user', content:
          `【第 ${_bi+1}/${_mgrBatches.length} 批原始碼（${_mgrBatches[_bi].length} 個檔案）】\n\n${_mgrBatches[_bi].join('\n\n')}`
        });
      }
      _mgrBatchedInitHist.push({ role: 'assistant', content: `已完整閱讀全部 ${_mgrBatches.length} 批共 ${_mgrAllRelPaths.length} 個檔案（${Math.round(_mgrTotalBytes/1024)}KB）。請提出任務。` });
    }
    // _mgrWsContext 仍保留，用於 system prompt（人格描述）中說明工作區路徑
    const _mgrWsContext = _mgrBaseCtx;

    // Phase-0a 專用輕量歷史（僅含路徑清單，不含程式碼內容）
    // 避免把幾百 KB 原始碼一次送給大型模型造成長時間無反應
    const _mgrLightHist: { role: 'user'|'assistant'; content: string }[] = [
      { role: 'user', content: `${_mgrBaseCtx}

以上是工作區所有檔案的路徑清單（共 ${_mgrAllRelPaths.length} 個），請記住此專案結構。` },
      { role: 'assistant', content: `已記住工作區結構，共 ${_mgrAllRelPaths.length} 個檔案。請提出任務或問題。` }
    ];

    const managerModel   = allModels[0];
    const memberModels   = allModels.slice(1);
    const managerDisplay = '🏢 主管 (' + getDisplay(managerModel) + ')';
    const memberDisplays = memberModels.map((m, i) => `👨‍💻 工程師 #${i + 1} (${getDisplay(m)})`);

    // ─ 人格設定（分離，含工作區資訊）
    const _wsBlock = _mgrWsContext ? `\n\n你可以參考以下工作區資訊進行分析：\n${_mgrWsContext}` : '';
    const managerPersona =
      `你是資深技術主管兼架構師。職責：\n` +
      `1. 分析技術需求與架構\n` +
      `2. 指派任務給工程師\n` +
      `3. 審查提案並給出具體改進意見\n` +
      `4. 確認方案無誤後才核准（回覆末尾輸出 [APPROVED]）\n` +
      `5. 對執行結果進行最終 Review\n` +
      `風格：嚴謹簡潔，繁體中文回答。${_wsBlock}`;
    const memberPersona = (i: number) =>
      `你是工程師 #${i + 1}。職責：根據主管指示提出具體實作方案與程式碼修改建議。\n` +
      `重要：你只看得到自己的對話歷史，不知道其他工程師的內容。繁體中文回答。${_wsBlock}`;

    // ─ 記憶分離：各自獨立的對話歷史，以批次閱讀歷史預填
    const managerHist: { role: 'user' | 'assistant'; content: string }[] = [..._mgrBatchedInitHist];
    const memberHists: { role: 'user' | 'assistant'; content: string }[][] = memberModels.map(() => [..._mgrBatchedInitHist]);

    // 工程師可使用與 Agent 模式完全相同的工具集
    const MGR_MEMBER_TOOLS = AGENT_TOOLS;
    // 主任用工具：與工程師相同，但排除寫入／執行／破壞性操作（唯讀審核）
    const _MGR_WRITE_DENY = new Set(['write_file','replace_in_file','delete_file','create_dir','run_terminal','run_command','run_python','git_commit','lint_fix','jenkins_build','whatsapp_send','whatsapp_send_template','browser_script','jira_create','jira_transition','bb_create_pr']);
    const MGR_MANAGER_TOOLS = AGENT_TOOLS.filter(t => !_MGR_WRITE_DENY.has(t.function.name));

    // Helper：用各自 persona + 獨立 history 呼叫模型，支援工具呼叫迴圈
    const callModel = async (
      model: string,
      persona: string,
      hist: { role: 'user' | 'assistant'; content: string }[],
      userMsg: string,
      onChunk: (c: string) => void,
      onThink?: (c: string) => void,
      tools: unknown[] = []
    ): Promise<string> => {
      if (model.startsWith('copilot::')) {
        const family = model.slice('copilot::'.length);
        const messages: vscode.LanguageModelChatMessage[] = [
          vscode.LanguageModelChatMessage.User(persona),
          ...hist.map(h => h.role === 'user'
            ? vscode.LanguageModelChatMessage.User(h.content)
            : vscode.LanguageModelChatMessage.Assistant(h.content)),
          vscode.LanguageModelChatMessage.User(userMsg)
        ];
        const cts = new vscode.CancellationTokenSource();
        const cancelTimer = setInterval(() => { if (this._teamCancel) { cts.cancel(); } }, 200);
        try {
          const [lm] = await vscode.lm.selectChatModels({ vendor: 'copilot', family });
          if (!lm) { throw new Error(`Copilot 模型 "${family}" 不可用`); }
          const resp = await lm.sendRequest(messages, {}, cts.token);
          let full = '';
          for await (const part of resp.stream) {
            if (this._teamCancel) { break; }
            if (part instanceof vscode.LanguageModelTextPart) { full += part.value; onChunk(part.value); }
          }
          return full;
        } finally { clearInterval(cancelTimer); cts.dispose(); }
      } else {
        const { url, model: mName } = decodeOllamaModel(model, urls);
        if (tools.length === 0) {
          // 無工具：直接用串流
          let thinkBuf = '';
          let thinkTimer: ReturnType<typeof setTimeout> | null = null;
          const flushThink = () => { if (thinkBuf && onThink) { onThink(thinkBuf); thinkBuf = ''; } thinkTimer = null; };
          const messages: ChatMessage[] = [
            { role: 'system', content: persona },
            ...hist.map(h => ({ role: h.role as 'user' | 'assistant', content: h.content })),
            { role: 'user', content: userMsg }
          ];
          const text = await ollamaChatStream(url, mName, messages, onChunk,
            (tc) => { thinkBuf += tc; if (!thinkTimer) { thinkTimer = setTimeout(flushThink, 80); } },
            (tokens) => { this.trackUsage(mName, tokens); });
          if (thinkTimer) { clearTimeout(thinkTimer); } flushThink();
          return text;
        } else {
          // 有工具：tool-calling 迴圈（最多 12 輪）
          const messages: ChatMessage[] = [
            { role: 'system', content: persona },
            ...hist.map(h => ({ role: h.role as 'user' | 'assistant', content: h.content })),
            { role: 'user', content: userMsg }
          ];
          let finalText = '';
          for (let _tLoop = 0; _tLoop < 12 && !this._teamCancel; _tLoop++) {
            const assistantMsg = await ollamaChatCallStream(url, mName, messages, tools,
              (tc) => { if (onThink && !this._teamCancel) onThink(tc); },
              (tc) => { if (!this._teamCancel) { onChunk(tc); finalText += tc; } },
              (tokens) => { this.trackUsage(mName, tokens); });
            messages.push(assistantMsg as ChatMessage);
            if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) { break; }
            // 執行工具
            for (const tc of assistantMsg.tool_calls) {
              const fn = tc.function;
              const args = typeof fn.arguments === 'string' ? (() => { try { return JSON.parse(fn.arguments as string); } catch { return {}; } })() : fn.arguments as Record<string, unknown>;
              onChunk(`\n🔧 ${fn.name}(${JSON.stringify(args).slice(0, 80)})\n`);
              let toolResult: string;
              try { toolResult = await this.executeTool(fn.name, args); }
              catch (e) { toolResult = `工具錯誤: ${e instanceof Error ? e.message : String(e)}`; }
              onChunk(`→ ${toolResult.slice(0, 200)}${toolResult.length > 200 ? '…' : ''}\n`);
              messages.push({ role: 'tool', content: toolResult, tool_call_id: tc.id ?? fn.name });
            }
          }
          return finalText;
        }
      }
    };

    this._teamCancel = false;

    // ── Phase-0a  全員閱讀理解工作區（主任 + 所有工程師）────────────────────────
    // 先讓每個 LLM 門閱讀工作區，確認充分理解後才開始分配工作
    const _readUnderstandMsg =
      `請仔細閱讀以上工作區所有原始碼，然後簡要說明：\n` +
      `1. 你理解了哪些主要模組？（列出檔案路徑）\n` +
      `2. 現有程式碼的架構為何？\n` +
      `3. 針對以下需求，你認為最相關的檔案與入口點為何？\n\n需求：${prompt}`;

    const understandings: string[] = [];
    // 主任先閱讀（使用輕量歷史，僅送路徑清單，避免大型模型處理幾百 KB 而卡住）
    this._panel.webview.postMessage({ type: 'teamOrchestratorStart', model: `${managerDisplay} — 閱讀工作區` });
    let managerUnderstanding = '';
    try {
      managerUnderstanding = await callModel(managerModel, managerPersona, _mgrLightHist, _readUnderstandMsg,
        (c) => { if (!this._teamCancel) { this._panel.webview.postMessage({ type: 'teamOrchestratorChunk', chunk: c }); } },
        (t) => { if (!this._teamCancel) { this._panel.webview.postMessage({ type: 'teamOrchestratorThinkChunk', chunk: t }); } });
    } catch (e) {
      managerUnderstanding = '[主任閱讀失敗: ' + (e instanceof Error ? e.message : String(e)) + ']';
      this._panel.webview.postMessage({ type: 'teamOrchestratorChunk', chunk: managerUnderstanding });
    }
    // Phase-0a 結果 push 進完整歷史（Phase-0b 以後用含程式碼內容的完整 context）
    managerHist.push({ role: 'user', content: _readUnderstandMsg });
    managerHist.push({ role: 'assistant', content: managerUnderstanding });
    understandings.push(`【${managerDisplay}】\n${managerUnderstanding}`);
    this._panel.webview.postMessage({ type: 'teamOrchestratorEnd' });
    if (this._teamCancel) { this._panel.webview.postMessage({ type: 'teamEnd' }); return; }

    // 工程師們閱讀（同樣使用輕量歷史）
    for (let mi = 0; mi < memberModels.length && !this._teamCancel; mi++) {
      const id = `mgr_read_m${mi}`;
      const color = COLORS[(mi + 1) % COLORS.length];
      this._panel.webview.postMessage({ type: 'teamMemberStart', id, model: `${memberDisplays[mi]} — 閱讀工作區`, color, task: '閱讀工作區' });
      let memberUnderstanding = '';
      try {
        memberUnderstanding = await callModel(memberModels[mi], memberPersona(mi), _mgrLightHist, _readUnderstandMsg,
          (c) => { if (!this._teamCancel) { this._panel.webview.postMessage({ type: 'teamResponseChunk', id, chunk: c }); } },
          (t) => { if (!this._teamCancel) { this._panel.webview.postMessage({ type: 'teamThinkChunk', id, color, chunk: t }); } });
      } catch (e) {
        memberUnderstanding = '[閱讀失敗: ' + (e instanceof Error ? e.message : String(e)) + ']';
        this._panel.webview.postMessage({ type: 'teamResponseChunk', id, chunk: memberUnderstanding });
      }
      memberHists[mi].push({ role: 'user', content: _readUnderstandMsg });
      memberHists[mi].push({ role: 'assistant', content: memberUnderstanding });
      understandings.push(`【${memberDisplays[mi]}】\n${memberUnderstanding}`);
      this._panel.webview.postMessage({ type: 'teamMemberEnd', id });
    }
    if (this._teamCancel) { this._panel.webview.postMessage({ type: 'teamEnd' }); return; }

    // ── Phase-0b  主任整合理解並提出架構計劃 ──────────────────────────────────
    this._panel.webview.postMessage({ type: 'teamOrchestratorStart', model: `${managerDisplay} — 架構計劃` });
    const p0 =
      `【所有成員的工作區理解】\n${understandings.join('\n\n')}\n\n` +
      `【任務需求】\n${prompt}\n\n` +
      `所有成員已充分閱讀工作區。請提出架構計劃：\n` +
      `1. 基於大家對原始碼的共同理解，說明架構方向\n` +
      `2. 列出需要修改的具體檔案（附路徑）\n` +
      (memberModels.length > 0
        ? `3. 為 ${memberModels.length} 位工程師分配具體子任務（指定檔案與函式）\n4. 說明技術限制與注意事項`
        : `3. 列出子任務清單`);
    let managerAnalysis = '';
    try {
      managerAnalysis = await callModel(managerModel, managerPersona, managerHist, p0,
        (c) => { if (!this._teamCancel) { this._panel.webview.postMessage({ type: 'teamOrchestratorChunk', chunk: c }); } },
        (t) => { if (!this._teamCancel) { this._panel.webview.postMessage({ type: 'teamOrchestratorThinkChunk', chunk: t }); } },
        MGR_MANAGER_TOOLS);
    } catch (e) {
      managerAnalysis = '[主任架構計劃失敗: ' + (e instanceof Error ? e.message : String(e)) + ']';
      this._panel.webview.postMessage({ type: 'teamOrchestratorChunk', chunk: managerAnalysis });
    }
    managerHist.push({ role: 'user', content: p0 });
    managerHist.push({ role: 'assistant', content: managerAnalysis });
    this._panel.webview.postMessage({ type: 'teamOrchestratorEnd' });
    if (this._teamCancel) { this._panel.webview.postMessage({ type: 'teamEnd' }); return; }

    // ── Phase-1/2  組員提案 ↔ 主管審核（循環）────────────────────────────────
    const roundsLimit = isFinite(maxRounds) ? Math.min(maxRounds, 10) : 5;
    let approved = false;
    let managerFeedback = '';
    let memberProposals: string[] = [];

    for (let round = 0; round < roundsLimit && !this._teamCancel && !approved; round++) {
      memberProposals = [];
      // 組員各自提案（序列執行避免 Ollama 衝突）
      for (let mi = 0; mi < memberModels.length && !this._teamCancel; mi++) {
        const id = `mgr_r${round}_m${mi}`;
        const color = COLORS[(mi + 1) % COLORS.length];
        const taskMsg = round === 0
          ? `【主管架構分析與任務分配】\n${managerAnalysis}\n\n你是工程師 #${mi + 1}，請根據主管分配給你的工作項目，直接使用工具讀取相關檔案並實作（write_file / replace_in_file）。若模型不支援工具，請提出含完整程式碼的詳細方案：`
          : `【主管第 ${round} 輪審核意見】\n${managerFeedback}\n\n請根據主管意見修改並改進，直接使用工具更新檔案：`;
        this._panel.webview.postMessage({ type: 'teamMemberStart', id, model: memberDisplays[mi], color, task: `第 ${round + 1} 輪提案` });
        let proposal = '';
        try {
          proposal = await callModel(memberModels[mi], memberPersona(mi), memberHists[mi], taskMsg,
            (c) => { if (!this._teamCancel) { this._panel.webview.postMessage({ type: 'teamResponseChunk', id, chunk: c }); } },
            (t) => { if (!this._teamCancel) { this._panel.webview.postMessage({ type: 'teamThinkChunk', id, color, chunk: t }); } },
            MGR_MEMBER_TOOLS);
        } catch (e) {
          proposal = '[錯誤: ' + (e instanceof Error ? e.message : String(e)) + ']';
          this._panel.webview.postMessage({ type: 'teamResponseChunk', id, chunk: proposal });
        }
        memberHists[mi].push({ role: 'user', content: taskMsg });
        memberHists[mi].push({ role: 'assistant', content: proposal });
        memberProposals.push(proposal);
        this._panel.webview.postMessage({ type: 'teamMemberEnd', id });
      }
      if (this._teamCancel) { break; }

      // 主管審核
      const reviewContent = memberModels.length > 0
        ? memberProposals.map((p, i) => `【工程師 #${i + 1} 第 ${round + 1} 輪提案】\n${p}`).join('\n\n---\n\n')
        : `（無組員，自行審查）\n${managerAnalysis}`;
      const reviewMsg =
        `${reviewContent}\n\n` +
        `請審核以上方案：\n` +
        `- 若方案完整可執行，請在回覆最後輸出：[APPROVED]\n` +
        `- 若需改進，請指出具體問題要求修改（不要輸出 [APPROVED]）`;
      this._panel.webview.postMessage({ type: 'teamOrchestratorStart', model: `${managerDisplay} — 審核第 ${round + 1} 輪` });
      let reviewResp = '';
      try {
        reviewResp = await callModel(managerModel, managerPersona, managerHist, reviewMsg,
          (c) => { if (!this._teamCancel) { this._panel.webview.postMessage({ type: 'teamOrchestratorChunk', chunk: c }); } },
          (t) => { if (!this._teamCancel) { this._panel.webview.postMessage({ type: 'teamOrchestratorThinkChunk', chunk: t }); } });
      } catch (e) {
        reviewResp = '[審核失敗: ' + (e instanceof Error ? e.message : String(e)) + ']';
        this._panel.webview.postMessage({ type: 'teamOrchestratorChunk', chunk: reviewResp });
      }
      managerHist.push({ role: 'user', content: reviewMsg });
      managerHist.push({ role: 'assistant', content: reviewResp });
      this._panel.webview.postMessage({ type: 'teamOrchestratorEnd' });
      approved = reviewResp.includes('[APPROVED]');
      if (!approved) { managerFeedback = reviewResp; }
    }
    if (this._teamCancel) { this._panel.webview.postMessage({ type: 'teamEnd' }); return; }

    // ── Phase-3  主管批准後執行 ──────────────────────────────────────────────
    let execResult = '';
    if (approved) {
      const approvedId = 'mgr_exec_hdr';
      this._panel.webview.postMessage({ type: 'teamMemberStart', id: approvedId, model: managerDisplay, color: COLORS[0], task: '✅ 方案已核准，開始執行' });
      this._panel.webview.postMessage({ type: 'teamResponseChunk', id: approvedId, chunk: '✅ 主管已核准方案，交由 Agent 執行...' });
      this._panel.webview.postMessage({ type: 'teamMemberEnd', id: approvedId });
      const agentModel = allModels.find(m => isOllamaModel(m) || m.startsWith('copilot::')) ?? allModels[0];
      if (agentModel) {
        const execPrompt =
          `主管已核准以下工程師方案，請立即執行必要操作來完成任務。\n\n` +
          `【原始任務】\n${prompt}\n\n` +
          `【已核准方案】\n` +
          (memberProposals.length > 0
            ? memberProposals.map((p, i) => `工程師 #${i + 1}:\n${p}`).join('\n\n')
            : managerAnalysis) +
          `\n\n請逐步執行，不得僅宣告意圖而不行動。`;
        this._panel.webview.postMessage({ type: 'teamAgentStart', model: agentModel });
        this._agentMessages = [];
        this._agentMessagesBySession[this._activeSessionId] = this._agentMessages;
        await this.handleAgent(execPrompt, agentModel, false);
        execResult = '已執行完畢，請查看上方 Agent 執行記錄。';
      }
    } else {
      const skipId = 'mgr_skip';
      this._panel.webview.postMessage({ type: 'teamMemberStart', id: skipId, model: managerDisplay, color: COLORS[0], task: '⚠️ 未獲批准' });
      this._panel.webview.postMessage({ type: 'teamResponseChunk', id: skipId, chunk: '⚠️ 方案未在回合限制內獲得批准，跳過執行。' });
      this._panel.webview.postMessage({ type: 'teamMemberEnd', id: skipId });
      execResult = '方案未獲批准，未執行。';
    }
    if (this._teamCancel) { this._panel.webview.postMessage({ type: 'teamEnd' }); return; }

    // ── Phase-4  全員 Review（人格與記憶分離）──────────────────────────────────
    const rvHdrId = 'mgr_rv_hdr';
    this._panel.webview.postMessage({ type: 'teamMemberStart', id: rvHdrId, model: '📋 全員 Review', color: '#aaaaaa', task: '各成員獨立審查執行結果' });
    this._panel.webview.postMessage({ type: 'teamResponseChunk', id: rvHdrId, chunk: '主管與工程師將各自獨立進行 Review（記憶分離，互不影響）...' });
    this._panel.webview.postMessage({ type: 'teamMemberEnd', id: rvHdrId });

    const rvPrompt =
      `【原始任務】\n${prompt}\n\n【執行狀態】\n${execResult}\n\n` +
      `請以你的專業角色對執行結果進行 Review：\n` +
      `1. 是否符合需求？\n2. 有哪些潛在問題或風險？\n3. 建議的改進方向？`;

    const rvPersonas = [managerPersona, ...memberModels.map((_, i) => memberPersona(i))];
    const rvHists: { role: 'user' | 'assistant'; content: string }[][] = [managerHist, ...memberHists];
    const reviewResults: string[] = [];

    for (let ri = 0; ri < allModels.length && !this._teamCancel; ri++) {
      const rvId = `mgr_rv_${ri}`;
      const color = COLORS[ri % COLORS.length];
      const display = ri === 0 ? managerDisplay : memberDisplays[ri - 1];
      this._panel.webview.postMessage({ type: 'teamMemberStart', id: rvId, model: `🔍 ${display}`, color, task: 'Review' });
      let rvResp = '';
      try {
        rvResp = await callModel(allModels[ri], rvPersonas[ri], rvHists[ri], rvPrompt,
          (c) => { if (!this._teamCancel) { this._panel.webview.postMessage({ type: 'teamResponseChunk', id: rvId, chunk: c }); } },
          (t) => { if (!this._teamCancel) { this._panel.webview.postMessage({ type: 'teamThinkChunk', id: rvId, color, chunk: t }); } });
      } catch (e) {
        rvResp = '[Review 失敗: ' + (e instanceof Error ? e.message : String(e)) + ']';
        this._panel.webview.postMessage({ type: 'teamResponseChunk', id: rvId, chunk: rvResp });
      }
      rvHists[ri].push({ role: 'user', content: rvPrompt });
      rvHists[ri].push({ role: 'assistant', content: rvResp });
      reviewResults.push(`【${display} Review】\n${rvResp}`);
      this._panel.webview.postMessage({ type: 'teamMemberEnd', id: rvId });
    }

    const finalSummary = reviewResults.join('\n\n---\n\n');
    if (finalSummary.trim()) {
      this._chatHistory.push({ role: 'assistant', content: finalSummary });
      this._chatHistories[this._activeSessionId] = this._chatHistory;
      this._panel.webview.postMessage({ type: 'historyCount', count: this._chatHistory.length, sessionId: this._activeSessionId });
      // 儲存主管模式結果到 teamscontext.md
      try {
        const _mgrNow = new Date().toISOString().replace('T', ' ').slice(0, 19);
        const _mgrExisting = _mgrTeamsCtxContent ? `${_mgrTeamsCtxContent}\n\n---\n\n` : '';
        const _mgrEntry =
          `## 主管模式紀錄 ${_mgrNow}\n\n` +
          `**議題：** ${prompt.slice(0, 200)}${prompt.length > 200 ? '…' : ''}\n\n` +
          `**執行狀態：** ${execResult}\n\n` +
          `**全員 Review：**\n${finalSummary}`;
        await vscode.workspace.fs.writeFile(
          vscode.Uri.file(_mgrTeamsCtxPath),
          Buffer.from(_mgrExisting + _mgrEntry, 'utf-8')
        );
        const _saveId = 'mgr_save_ctx';
        this._panel.webview.postMessage({ type: 'teamMemberStart', id: _saveId, model: '📝 teamscontext.md', color: '#aaaaaa', task: '儲存討論紀錄' });
        this._panel.webview.postMessage({ type: 'teamResponseChunk', id: _saveId, chunk: `✅ 主管模式結果已儲存至 teamscontext.md` });
        this._panel.webview.postMessage({ type: 'teamMemberEnd', id: _saveId });
      } catch (e) {
        const _saveErrId = 'mgr_save_err';
        this._panel.webview.postMessage({ type: 'teamMemberStart', id: _saveErrId, model: '⚠️ teamscontext.md', color: '#ce9178', task: '儲存失敗' });
        this._panel.webview.postMessage({ type: 'teamResponseChunk', id: _saveErrId, chunk: `無法儲存 teamscontext.md: ${e instanceof Error ? e.message : String(e)}` });
        this._panel.webview.postMessage({ type: 'teamMemberEnd', id: _saveErrId });
      }
    }
    this._agentMessages = [];
    this._agentMessagesBySession[this._activeSessionId] = this._agentMessages;
    this._panel.webview.postMessage({ type: 'teamEnd', agentFollows: false });
    this._panel.webview.postMessage({ type: 'agentStatus', running: false });
  }

  // ── Debate / Dialogue Mode ───────────────────────────────────────────────
  /** 對話模式：2 個 AI 互相辯論/對弈；3 個 AI 則第三個當裁判 */
  private async handleDebateSend(prompt: string, selectedModels?: string[], rounds?: string | number): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('amiAiClaw');
    const urls = getOllamaUrls(cfg);
    const allModels = (selectedModels && selectedModels.length >= 2) ? selectedModels.slice(0, 3) : [];
    if (allModels.length < 2) {
      this._panel.webview.postMessage({ type: 'error', text: '對話模式需要選擇至少 2 個 AI 模型' });
      return;
    }
    const COLORS = ['#4fc1ff', '#ce9178', '#89d185'];
    this._teamCancel = false;
    this._debateSwap = {};
    // Parse rounds parameter (default 20)
    const roundsSelected = rounds ?? '20';
    const maxRounds = String(roundsSelected) === 'infinite' ? Infinity : Number(roundsSelected) || 20;
    // 記錄使用者輸入到短期記憶
    this._chatHistory.push({ role: 'user', content: prompt });
    this._chatHistories[this._activeSessionId] = this._chatHistory;
    this._panel.webview.postMessage({ type: 'historyCount', count: this._chatHistory.length, sessionId: this._activeSessionId });

    const isOllama = (m: string) => !m.startsWith('copilot/') && !m.startsWith('copilot::');
    const getLabel = (m: string) => {
      if (m.startsWith('copilot/')) return m.slice('copilot/'.length);
      if (m.startsWith('copilot::')) return m.slice('copilot::'.length);
      if (m.includes('||')) { const { url, model } = decodeOllamaModel(m, urls); try { const u = new URL(url); return `[${u.hostname}:${u.port||'11434'}] ${model}`; } catch { return model; } }
      return m;
    };

    // Role assignment
    const modelA = allModels[0];
    const modelB = allModels[1];
    const judgeModel = allModels[2] ?? null;

    const labelA = getLabel(modelA);
    const labelB = getLabel(modelB);
    const labelJ = judgeModel ? getLabel(judgeModel) : null;

    const callModel = async (
      model: string,
      systemPrompt: string,
      history: { role: 'user' | 'assistant'; content: string }[],
      onChunk: (c: string) => void,
      onThink?: (c: string) => void
    ): Promise<{ text: string; tokens?: number; tps?: number }> => {
      if (model.startsWith('copilot/') || model.startsWith('copilot::')) {
        const family = model.startsWith('copilot/') ? model.slice('copilot/'.length) : model.slice('copilot::'.length);
        const [lm] = await vscode.lm.selectChatModels({ vendor: 'copilot', family });
        if (!lm) { throw new Error(`Copilot 模型 "${family}" 不可用`); }
        const cts = new vscode.CancellationTokenSource();
        const cancelInterval = setInterval(() => { if (this._teamCancel) cts.cancel(); }, 200);
        const vmMsgs: vscode.LanguageModelChatMessage[] = [
          vscode.LanguageModelChatMessage.User(systemPrompt),
          ...history.map(h => h.role === 'user'
            ? vscode.LanguageModelChatMessage.User(h.content)
            : vscode.LanguageModelChatMessage.Assistant(h.content))
        ];
        try {
          const resp = await lm.sendRequest(vmMsgs, {}, cts.token);
          let full = '';
          for await (const part of resp.stream) {
            if (this._teamCancel) break;
            if (part instanceof vscode.LanguageModelTextPart) { full += part.value; onChunk(part.value); }
          }
          return { text: full };
        } finally { clearInterval(cancelInterval); cts.dispose(); }
      } else {
        await this.ensureModelReady(...((): [string, string] => { const d = decodeOllamaModel(model, urls); return [d.url, d.model]; })());
        const { url: ollamaUrl, model: ollamaModel } = decodeOllamaModel(model, urls);
        const messages: ChatMessage[] = [
          { role: 'system', content: systemPrompt },
          ...history.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))
        ];
        if (messages[messages.length - 1].role !== 'user') {
          messages.push({ role: 'user', content: '請繼續。' });
        }
        let statsTokens: number | undefined;
        let statsTps: number | undefined;
        const text = await ollamaChatStream(ollamaUrl, ollamaModel, messages, onChunk, onThink,
          (tokens, tps) => { statsTokens = tokens; statsTps = tps; });
        return { text, tokens: statsTokens, tps: statsTps };
      }
    };

    // Determine context type from prompt keywords
    const isGame = /五子棋|圍棋|象棋|將棋|西洋棋|chess|go\b|tic.tac|gomoku|shogi|遊戲|下棋|黑白棋|othello|reversi|跳棋|checkers|draughts|橋牌/i.test(prompt);
    const gameType = /黑白棋|othello|reversi/i.test(prompt) ? 'othello'
      : /跳棋|checkers|draughts/i.test(prompt) ? 'checkers'
      : /橋牌/i.test(prompt) ? 'bridge'
      : /五子棋|gomoku/i.test(prompt) ? 'gomoku'
      : /圍棋/i.test(prompt) ? 'go'
      : /象棋|xiangqi/i.test(prompt) ? 'xiangqi'
      : /將棋|shogi/i.test(prompt) ? 'shogi'
      : /西洋棋/i.test(prompt) ? 'chess'
      : 'generic';

    // ── Game mode: A & B take turns, A's move is passed to B as board state ──
    if (isGame) {
      this._panel.webview.postMessage({ type: 'debateStart', labelA, labelB, labelJ, colorA: COLORS[0], colorB: COLORS[1], colorJ: COLORS[2], gameType });
      const _boardInstr = gameType !== 'bridge' ? ` 每次落子後，請在回應末尾用 [BOARD] 和 [/BOARD] 標記輸出完整 ASCII 棋盤，格式：[BOARD]\n棋盤內容\n[/BOARD]。` : '';
      const _gA: Record<string, string> = { gomoku: '五子棋棋手（●黑方）', othello: '黑白棋棋手（●黑方），8x8棋盤，指定落子座標如 d3', checkers: '跳棋棋手（紅方），指定移動如 c3→d4', bridge: `橋牌玩家（${labelA}）`, go: '圍棋棋手（●黑方），指定落子座標', xiangqi: '象棋紅方，用標準記譜法如：馬2進3', chess: '西洋棋白方，用代數記法如：e2-e4', shogi: '将棋先手番、標準記法使用' };
      const _gB: Record<string, string> = { gomoku: '五子棋棋手（○白方）', othello: '黑白棋棋手（○白方），8x8棋盤，指定落子座標如 d3', checkers: '跳棋棋手（黑方），指定移動如 c3→d4', bridge: `橋牌玩家（${labelB}）`, go: '圍棋棋手（○白方），指定落子座標', xiangqi: '象棋黑方，用標準記譜法', chess: '西洋棋黑方，用代數記法如：e7-e5', shogi: '将棋後手番、標準記法使用' };
      const gameSystemA = `你是${_gA[gameType] ?? '棋手，正在進行棋局'}。每次只說明你這一步的落子位置和簡短理由，不要發表其他評論。${_boardInstr}`;
      const gameSystemB = `你是${_gB[gameType] ?? '棋手，正在進行棋局'}。根據對手的上一步，回應你的落子位置和簡短理由，不要發表其他評論。${_boardInstr}`;
      const initPrompt = prompt;
      // historyA = A's own turns; gameMoves = shared move log passed to B each turn
      const historyA: { role: 'user' | 'assistant'; content: string }[] = [{ role: 'user', content: initPrompt + '\n\n請下第一手。' }];
      const gameMoves: string[] = [];
      const MAX_GAME_ROUNDS = maxRounds;
      let finalDebateSummary = '';

      for (let round = 0; round < MAX_GAME_ROUNDS && !this._teamCancel; round++) {
        // A moves
        this._panel.webview.postMessage({ type: 'debateTurnStart', speaker: 'A', round });
        let moveA = '';
        let statsA: { tokens?: number; tps?: number } = {};
        try {
          const rA = await callModel(this._debateSwap.A ?? modelA, gameSystemA, historyA,
            (c) => { if (!this._teamCancel) this._panel.webview.postMessage({ type: 'debateChunk', speaker: 'A', chunk: c }); },
            (t) => { if (!this._teamCancel) this._panel.webview.postMessage({ type: 'debateThinkChunk', speaker: 'A', chunk: t }); });
          moveA = rA.text; statsA = { tokens: rA.tokens, tps: rA.tps };
        } catch (e) {
          moveA = '[錯誤: ' + (e instanceof Error ? e.message : String(e)) + ']';
          if (!this._teamCancel) this._panel.webview.postMessage({ type: 'debateChunk', speaker: 'A', chunk: moveA });
        }
        this._panel.webview.postMessage({ type: 'debateTurnEnd', speaker: 'A', tokens: statsA.tokens, tps: statsA.tps });
        if (this._teamCancel) break;
        historyA.push({ role: 'assistant', content: moveA });
        gameMoves.push(`第 ${round + 1} 手（${labelA}）：${moveA}`);

        // B responds to A's move
        this._panel.webview.postMessage({ type: 'debateTurnStart', speaker: 'B', round });
        let moveB = '';
        let statsB: { tokens?: number; tps?: number } = {};
        const boardState = initPrompt + '\n\n目前棋譜：\n' + gameMoves.join('\n') + '\n\n請回應你的下一手。';
        try {
          const rB = await callModel(this._debateSwap.B ?? modelB, gameSystemB, [{ role: 'user', content: boardState }],
            (c) => { if (!this._teamCancel) this._panel.webview.postMessage({ type: 'debateChunk', speaker: 'B', chunk: c }); },
            (t) => { if (!this._teamCancel) this._panel.webview.postMessage({ type: 'debateThinkChunk', speaker: 'B', chunk: t }); });
          moveB = rB.text; statsB = { tokens: rB.tokens, tps: rB.tps };
        } catch (e) {
          moveB = '[錯誤: ' + (e instanceof Error ? e.message : String(e)) + ']';
          if (!this._teamCancel) this._panel.webview.postMessage({ type: 'debateChunk', speaker: 'B', chunk: moveB });
        }
        this._panel.webview.postMessage({ type: 'debateTurnEnd', speaker: 'B', tokens: statsB.tokens, tps: statsB.tps });
        if (this._teamCancel) break;
        gameMoves.push(`第 ${round + 1} 手（${labelB}）：${moveB}`);
        // Feed B's reply back to A as the next user turn
        historyA.push({ role: 'user', content: `對手（${labelB}）下了：${moveB}\n請回應你的下一手。` });
      }

      // Judge summarizes the game if present
      const _effectiveJudgeGame = this._debateSwap.J ?? judgeModel;
      if (_effectiveJudgeGame && !this._teamCancel) {
        this._panel.webview.postMessage({ type: 'debateTurnStart', speaker: 'J', round: -1 });
        const gameSummary = initPrompt + '\n\n完整棋譜：\n' + gameMoves.join('\n') + '\n\n請分析這場對局，說明雙方的策略與得失。';
        let statsJ: { tokens?: number; tps?: number } = {};
        try {
          const rJ = await callModel(_effectiveJudgeGame, '你是棋局分析師，請客觀分析以下對局。', [{ role: 'user', content: gameSummary }],
            (c) => { if (!this._teamCancel) this._panel.webview.postMessage({ type: 'debateChunk', speaker: 'J', chunk: c }); });
          statsJ = { tokens: rJ.tokens, tps: rJ.tps };
          finalDebateSummary = rJ.text || '';
        } catch (e) {
          const errJ = '[錯誤: ' + (e instanceof Error ? e.message : String(e)) + ']';
          if (!this._teamCancel) this._panel.webview.postMessage({ type: 'debateChunk', speaker: 'J', chunk: errJ });
        }
        this._panel.webview.postMessage({ type: 'debateTurnEnd', speaker: 'J', tokens: statsJ.tokens, tps: statsJ.tps });
      }

      // 儲存遊戲/裁判總結到短期記憶
      if (finalDebateSummary && finalDebateSummary.trim()) {
        this._chatHistory.push({ role: 'assistant', content: finalDebateSummary });
      } else if (gameMoves.length) {
        this._chatHistory.push({ role: 'assistant', content: gameMoves.join('\n') });
      }
      this._chatHistories[this._activeSessionId] = this._chatHistory;
      this._panel.webview.postMessage({ type: 'historyCount', count: this._chatHistory.length, sessionId: this._activeSessionId });

      this._panel.webview.postMessage({ type: 'debateEnd', consensus: false });
      this._panel.webview.postMessage({ type: 'agentStatus', running: false });
      return;
    }

    // ── Discussion mode (non-game) ────────────────────────────────────────────
    const roleADesc = '請針對以下議題提出你的分析與見解：\n\n' + prompt;
    const roleBDesc = '請針對以下議題提出你的分析與見解：\n\n' + prompt;
    const roleJDesc = '請整合以下多份針對同一議題的分析，做出客觀的綜合總結：';

    // Announce start
    this._panel.webview.postMessage({ type: 'debateStart', labelA, labelB, labelJ, colorA: COLORS[0], colorB: COLORS[1], colorJ: COLORS[2], gameType: 'discussion' });

    // True cross-model debate: A's response is fed to B before B speaks, and vice versa
    // historyA/B grow as [user, assistant, user(B's rebuttal), assistant, ...]
    const historyA: { role: 'user' | 'assistant'; content: string }[] = [];
    const historyB: { role: 'user' | 'assistant'; content: string }[] = [];
    // Collected responses for judge summary
    const summaryLines: string[] = [];
    const MAX_ROUNDS = maxRounds;

    for (let round = 0; round < MAX_ROUNDS && !this._teamCancel; round++) {
      // Prime A's turn: round 0 gets original prompt; round 1+ already has B's rebuttal appended
      if (round === 0) { historyA.push({ role: 'user', content: prompt }); }

      // A speaks
      this._panel.webview.postMessage({ type: 'debateTurnStart', speaker: 'A', round });
      let responseA = '';
      let statsDA: { tokens?: number; tps?: number } = {};
      try {
        const rA = await callModel(
          this._debateSwap.A ?? modelA, roleADesc, historyA,
          (c) => { if (!this._teamCancel) this._panel.webview.postMessage({ type: 'debateChunk', speaker: 'A', chunk: c }); },
          (t) => { if (!this._teamCancel) this._panel.webview.postMessage({ type: 'debateThinkChunk', speaker: 'A', chunk: t }); }
        );
        responseA = rA.text; statsDA = { tokens: rA.tokens, tps: rA.tps };
      } catch (e) {
        responseA = '[錯誤: ' + (e instanceof Error ? e.message : String(e)) + ']';
        if (!this._teamCancel) this._panel.webview.postMessage({ type: 'debateChunk', speaker: 'A', chunk: responseA });
      }
      this._panel.webview.postMessage({ type: 'debateTurnEnd', speaker: 'A', tokens: statsDA.tokens, tps: statsDA.tps });
      if (this._teamCancel) break;
      historyA.push({ role: 'assistant', content: responseA });
      summaryLines.push(`【${labelA}】\n${responseA}`);

      // Feed A's response to B as context before B speaks (cross-model injection)
      if (round === 0) {
        historyB.push({ role: 'user', content: `議題：${prompt}\n\n【${labelA}】的論點：\n${responseA}\n\n請提出你的立場，如有不同意見請明確指出。` });
      } else {
        historyB.push({ role: 'user', content: `【${labelA}】反駁道：\n${responseA}\n\n請回應上述論點，維護你的立場或提出新論據。` });
      }

      // B speaks (now sees A's latest response)
      this._panel.webview.postMessage({ type: 'debateTurnStart', speaker: 'B', round });
      let responseB = '';
      let statsDB: { tokens?: number; tps?: number } = {};
      try {
        const rB = await callModel(
          this._debateSwap.B ?? modelB, roleBDesc, historyB,
          (c) => { if (!this._teamCancel) this._panel.webview.postMessage({ type: 'debateChunk', speaker: 'B', chunk: c }); },
          (t) => { if (!this._teamCancel) this._panel.webview.postMessage({ type: 'debateThinkChunk', speaker: 'B', chunk: t }); }
        );
        responseB = rB.text; statsDB = { tokens: rB.tokens, tps: rB.tps };
      } catch (e) {
        responseB = '[錯誤: ' + (e instanceof Error ? e.message : String(e)) + ']';
        if (!this._teamCancel) this._panel.webview.postMessage({ type: 'debateChunk', speaker: 'B', chunk: responseB });
      }
      this._panel.webview.postMessage({ type: 'debateTurnEnd', speaker: 'B', tokens: statsDB.tokens, tps: statsDB.tps });
      if (this._teamCancel) break;
      historyB.push({ role: 'assistant', content: responseB });
      summaryLines.push(`【${labelB}】\n${responseB}`);

      // Feed B's response to A as context for next round (cross-model injection)
      historyA.push({ role: 'user', content: `【${labelB}】反駁道：\n${responseB}\n\n請回應上述論點，維護你的立場或提出新論據。` });
    }

    // Judge sees a plain-text summary of all responses — no cross-model raw content
    const _effectiveJudge = this._debateSwap.J ?? judgeModel;
    if (_effectiveJudge && !this._teamCancel) {
      const judgeMsgs: { role: 'user' | 'assistant'; content: string }[] = [
        { role: 'user', content: summaryLines.join('\n\n---\n\n') + '\n\n請做出綜合總結。' }
      ];
      this._panel.webview.postMessage({ type: 'debateTurnStart', speaker: 'J', round: -1 });
      let statsDJ: { tokens?: number; tps?: number } = {};
      let judgeSummary = '';
      try {
        const rJ = await callModel(
          _effectiveJudge, roleJDesc, judgeMsgs,
          (c) => { if (!this._teamCancel) this._panel.webview.postMessage({ type: 'debateChunk', speaker: 'J', chunk: c }); }
        );
        statsDJ = { tokens: rJ.tokens, tps: rJ.tps };
        judgeSummary = rJ.text || '';
      } catch (e) {
        const errJ = '[錯誤: ' + (e instanceof Error ? e.message : String(e)) + ']';
        if (!this._teamCancel) this._panel.webview.postMessage({ type: 'debateChunk', speaker: 'J', chunk: errJ });
      }
      this._panel.webview.postMessage({ type: 'debateTurnEnd', speaker: 'J', tokens: statsDJ.tokens, tps: statsDJ.tps });

      // 儲存裁判綜合或摘要到短期記憶
      if (!this._teamCancel) {
        if (judgeSummary && judgeSummary.trim()) {
          this._chatHistory.push({ role: 'assistant', content: judgeSummary });
        } else if (summaryLines.length) {
          this._chatHistory.push({ role: 'assistant', content: summaryLines.join('\n\n---\n\n') });
        }
        this._chatHistories[this._activeSessionId] = this._chatHistory;
        this._panel.webview.postMessage({ type: 'historyCount', count: this._chatHistory.length, sessionId: this._activeSessionId });
      }
    }

    // 無裁判時：直接將討論摘要存入短期記憶
    if (!judgeModel && !this._teamCancel && summaryLines.length > 0) {
      this._chatHistory.push({ role: 'assistant', content: summaryLines.join('\n\n---\n\n') });
      this._chatHistories[this._activeSessionId] = this._chatHistory;
      this._panel.webview.postMessage({ type: 'historyCount', count: this._chatHistory.length, sessionId: this._activeSessionId });
    }

    this._panel.webview.postMessage({ type: 'debateEnd', consensus: false });
    this._panel.webview.postMessage({ type: 'agentStatus', running: false });
  }

  private async fetchTeamModels(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('amiAiClaw');
    const ollamaUrls = getOllamaUrls(cfg);
    const teamModels: { id: string; label: string; vendor: string; multiplier?: string }[] = [];
    // Ollama models — all servers
    for (const url of ollamaUrls) {
      try {
        const models = await ollamaListModels(url);
        for (const m of models) {
          teamModels.push({ id: encodeOllamaModelId(url, m, ollamaUrls), label: ollamaDisplayLabel(url, m, ollamaUrls), vendor: 'ollama' });
        }
      } catch { /* server not reachable */ }
    }
    // GitHub Copilot models
    try {
      const copilotModels = await vscode.lm.selectChatModels({ vendor: 'copilot' });
      const seen = new Set<string>();
      for (const m of copilotModels) {
        const id = `copilot::${m.id}`;
        const rawName = m.name || m.family;
        const cleanName = rawName.replace(/\s+\d+x\b|\s+x\d+\b/gi, '').trim();
        if (!seen.has(id)) { seen.add(id); teamModels.push({ id, label: cleanName, vendor: 'copilot', multiplier: getCopilotMultiplier(m) }); }
      }
    } catch { /* Copilot not available */ }
    this._panel.webview.postMessage({ type: 'teamModelList', models: teamModels });
  }

  private async runWorkerDiscussion(
    workerModel: string,
    reviewFn: (prompt: string, onChunk: (c: string) => void) => Promise<string>,
    baseUrl: string,
    assignedTask: string,
    id: string,
    color: string,
    maxRounds = 100,
    ollamaCall?: (model: string, prompt: string, onResp: (c: string) => void, onThink?: (c: string) => void) => Promise<string>
  ): Promise<string> {
    const isCopilot = workerModel.startsWith('copilot/') || workerModel.startsWith('copilot::');
    const workerFamily = workerModel.startsWith('copilot::') ? workerModel.slice('copilot::'.length) : workerModel.startsWith('copilot/') ? workerModel.slice('copilot/'.length) : workerModel;
    const callOllama = ollamaCall ?? ollamaGenerateStream.bind(null, baseUrl);
    let currentPrompt = assignedTask;
    let lastResponse = '';

    for (let round = 0; round < maxRounds && !this._teamCancel; round++) {
      this._panel.webview.postMessage({ type: 'teamRoundStart', id, round });

      // Worker generates response
      if (isCopilot) {
        lastResponse = await this.copilotStream(
          workerFamily, currentPrompt,
          (chunk) => { if (!this._teamCancel) this._panel.webview.postMessage({ type: 'teamResponseChunk', id, chunk }); }
        );
      } else {
        let thinkBuf = ''; let thinkTimer: ReturnType<typeof setTimeout> | null = null;
        const flushThink = () => { if (thinkBuf) { this._panel.webview.postMessage({ type: 'teamThinkChunk', id, color, chunk: thinkBuf }); thinkBuf = ''; } thinkTimer = null; };
        lastResponse = await callOllama(
          workerModel, currentPrompt,
          (chunk) => { if (!this._teamCancel) this._panel.webview.postMessage({ type: 'teamResponseChunk', id, chunk }); },
          (tc) => { if (!this._teamCancel) { thinkBuf += tc; if (!thinkTimer) thinkTimer = setTimeout(flushThink, 80); } }
        );
        if (thinkTimer) { clearTimeout(thinkTimer); } flushThink();
      }

      if (this._teamCancel || round === maxRounds - 1) {
        this._panel.webview.postMessage({ type: 'teamRoundDone', id, approved: true });
        break;
      }

      // Orchestrator reviews and decides: approve or give feedback
      this._panel.webview.postMessage({ type: 'teamRoundReviewStart', id });
      const reviewPrompt = `你是 AI 協調員，正在指導一個工作助手.

【分配的任務】
${assignedTask}

【助手第 ${round + 1} 輪的回覆】
${lastResponse}

請單就回覆品質做出判斷：
- 若已達到最優解或內容足夠完整，就只回覆：[APPROVED]
- 若需改進，給出一句具體的改進指示（不超過 60 字，繁體中文）：`;
      let reviewText = '';
      try {
        reviewText = await reviewFn(
          reviewPrompt,
          (chunk) => { if (!this._teamCancel) this._panel.webview.postMessage({ type: 'teamRoundReviewChunk', id, chunk }); }
        );
      } catch { /* accept current response on error */ }
      const approved = reviewText.includes('[APPROVED]') || reviewText.trim() === '';
      this._panel.webview.postMessage({ type: 'teamRoundDone', id, approved });
      if (approved && round >= 2) { break; }

      // Feed orchestrator feedback back to worker
      currentPrompt = `${assignedTask}

【你的上一輪回覆】
${lastResponse}

【協調員的改進建議】
${reviewText.replace('[APPROVED]', '').trim()}

請根據忩迴建議，重新回覆（改進版本）：`;
    }
    return lastResponse;
  }

  private async copilotStream(
    modelFamily: string,
    prompt: string,
    onChunk: (chunk: string) => void
  ): Promise<string> {
    const [model] = await vscode.lm.selectChatModels({ vendor: 'copilot', family: modelFamily });
    if (!model) { throw new Error(`Copilot 模型 "${modelFamily}" 不可用，請確認 GitHub Copilot 已安裝並登入`); }
    const cts = new vscode.CancellationTokenSource();
    const cancelInterval = setInterval(() => { if (this._teamCancel) { cts.cancel(); } }, 200);
    try {
      const response = await model.sendRequest(
        [vscode.LanguageModelChatMessage.User(prompt)],
        {},
        cts.token
      );
      let fullText = '';
      for await (const part of response.stream) {
        if (this._teamCancel) { break; }
        if (part instanceof vscode.LanguageModelTextPart) {
          fullText += part.value;
          onChunk(part.value);
        }
      }
      return fullText;
    } finally {
      clearInterval(cancelInterval);
      cts.dispose();
    }
  }

  private async handleSend(prompt: string, modelOverride?: string, sessionId?: string): Promise<void> {
    this.switchChatSession(sessionId);
    const cfg = vscode.workspace.getConfiguration('amiAiClaw');
    const urls = getOllamaUrls(cfg);
    const rawModel = modelOverride ?? cfg.get<string>('model') ?? '';
    const { url: baseUrl, model } = rawModel.startsWith('copilot') ? { url: urls[0], model: rawModel } : decodeOllamaModel(rawModel, urls);

    // 切換 Ollama 模型時先卸載舊模型並等待 VRAM 釋放
    await this.ensureModelReady(baseUrl, model);

    // Build a single prompt string from system + history + current message
    // (uses /api/generate which has confirmed thinking field support)
    const systemContent = this.buildSystemContent();
    const recent = this._chatHistory.slice(-20);

    let fullPrompt = '';
    if (systemContent.trim()) {
      fullPrompt += `System: ${systemContent}\n\n`;
    }
    for (const m of recent) {
      const role = m.role === 'user' ? 'User' : 'Assistant';
      fullPrompt += `${role}: ${m.content ?? ''}\n\n`;
    }
    fullPrompt += `User: ${prompt}`;

    // Optimistically add user msg to history
    this._chatHistory.push({ role: 'user', content: prompt });
    this._panel.webview.postMessage({ type: 'historyCount', count: this._chatHistory.length, sessionId: this._activeSessionId });

    this._panel.webview.postMessage({ type: 'streamStart' });
    let fullResponse = '';
    // Cancel any previous in-flight Copilot request (stale response guard)
    if (this._pendingSendCts) { this._pendingSendCts.cancel(); this._pendingSendCts.dispose(); this._pendingSendCts = null; }
    try {
      if (model.startsWith('copilot::')) {
        const copilotId = model.slice('copilot::'.length);
        const cts0 = new vscode.CancellationTokenSource();
        this._pendingSendCts = cts0;
        try {
          const vmMsgs0: vscode.LanguageModelChatMessage[] = [];
          if (systemContent.trim()) { vmMsgs0.push(vscode.LanguageModelChatMessage.User(`[系統]\n${systemContent}`)); }
          for (const h of recent) {
            vmMsgs0.push(h.role === 'user' ? vscode.LanguageModelChatMessage.User(h.content ?? '') : vscode.LanguageModelChatMessage.Assistant(h.content ?? ''));
          }
          vmMsgs0.push(vscode.LanguageModelChatMessage.User(prompt));
          fullResponse = await copilotStreamText(copilotId, vmMsgs0, (chunk) => { this._panel.webview.postMessage({ type: 'assistantChunk', chunk }); }, cts0.token);
          const copilotTokenEst = Math.ceil(estimateTokens(fullResponse));
          this.trackUsage(copilotId, copilotTokenEst, getCopilotMultiplierById(copilotId));
        } finally { this._pendingSendCts = null; cts0.dispose(); }
      } else {
        fullResponse = await ollamaGenerateStream(
          baseUrl, model, fullPrompt,
          (chunk) => { this._panel.webview.postMessage({ type: 'assistantChunk', chunk }); },
          (thinkChunk) => {
            // 即時發送，不緩衝，確保 think block 在回應內容前顯示
            this._panel.webview.postMessage({ type: 'thinkChunk', chunk: thinkChunk });
          },
          (tokens, tps) => { this._panel.webview.postMessage({ type: 'streamStats', tokens, tps }); this.trackUsage(model, tokens); }
        );
      }
      // Save assistant response to short-term memory
      this._chatHistory.push({ role: 'assistant', content: fullResponse });
      this._panel.webview.postMessage({ type: 'streamEnd' });
      this._panel.webview.postMessage({ type: 'historyCount', count: this._chatHistory.length, sessionId: this._activeSessionId });
    } catch (e: unknown) {
      // Roll back optimistic user msg
      this._chatHistory.pop();
      const msg = e instanceof Error ? e.message : String(e);
      this._panel.webview.postMessage({ type: 'error', text: msg });
    }
  }

  private async handleMemoryConsolidate(sessionId?: string): Promise<void> {
    this.switchChatSession(sessionId);
    if (this._chatHistory.length < 2) {
      this._panel.webview.postMessage({ type: 'consolidateDone', ltm: this.getLongTermMemory(), skipped: true });
      return;
    }
    const cfg = vscode.workspace.getConfiguration('amiAiClaw');
    const urls = getOllamaUrls(cfg);
    const rawModel = cfg.get<string>('model') ?? '';
    const { url: baseUrl, model } = rawModel.startsWith('copilot') ? { url: urls[0], model: rawModel } : decodeOllamaModel(rawModel, urls);
    const currentLtm = this.getLongTermMemory();
    const historyText = this._chatHistory.map(m => {
      const role = m.role === 'user' ? '使用者' : 'AI';
      return `[${role}]: ${(m.content ?? '').slice(0, 500)}`;
    }).join('\n\n');
    const consolidatePrompt = `你是記憶整理助手。請從以下【短期對話記錄】中，提取值得長期保存的重要資訊（使用者習慣、偏好、結論、技術事實、環境設定等），與【現有長期記憶】合併，去掉重複或過時的內容，以簡潔的條列格式（每行一個重點，用 - 開頭）輸出整合後的長期記憶。不要加任何前言或說明，直接輸出條列內容。

【現有長期記憶】
${currentLtm.trim() || '（空）'}

【短期對話記錄】
${historyText}

整合後的長期記憶：`;
    this._panel.webview.postMessage({ type: 'consolidateStart' });
    try {
      let newLtm = '';
      if (model.startsWith('copilot::')) {
        const cts = new vscode.CancellationTokenSource();
        try {
          newLtm = await copilotStreamText(model.slice('copilot::'.length), [vscode.LanguageModelChatMessage.User(consolidatePrompt)], (chunk) => { this._panel.webview.postMessage({ type: 'consolidateChunk', chunk }); }, cts.token);
        } finally { cts.dispose(); }
      } else {
        newLtm = await ollamaGenerateStream(baseUrl, model, consolidatePrompt, (chunk) => { this._panel.webview.postMessage({ type: 'consolidateChunk', chunk }); });
      }
      newLtm = newLtm.trim();
      if (newLtm) {
        await this.saveLongTermMemory(newLtm);
      }
      this._chatHistory = [];
      this._chatHistories[this._activeSessionId] = this._chatHistory;
      this._agentMessages = [];
      this._agentMessagesBySession[this._activeSessionId] = this._agentMessages;
      this._panel.webview.postMessage({ type: 'consolidateDone', ltm: newLtm || currentLtm });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this._panel.webview.postMessage({ type: 'consolidateDone', ltm: currentLtm, error: msg });
    }
  }

  private getLongTermMemory(): string {
    return this._context.globalState.get<string>('amiAiClaw.longTermMemory') ?? '';
  }

  private async saveLongTermMemory(text: string): Promise<void> {
    await this._context.globalState.update('amiAiClaw.longTermMemory', text);
  }

  private buildSystemContent(): string {
    const cfg = vscode.workspace.getConfiguration('amiAiClaw');
    const persona = cfg.get<string>('systemPrompt') ?? '';
    const ltm = this.getLongTermMemory();
    let content = persona.trim();

    // 工作區資訊（每次對話固定注入）
    const wsFolders = vscode.workspace.workspaceFolders ?? [];
    const wsRoot = wsFolders.length > 0 ? wsFolders.map(f => f.uri.fsPath).join(', ') : process.cwd();
    const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath ?? '';
    const openFiles = vscode.window.tabGroups?.activeTabGroup?.tabs
      .map(t => (t.input as { uri?: vscode.Uri })?.uri?.fsPath ?? '')
      .filter(Boolean) ?? [];
    let wsInfo = `\n\n## 工作區資訊\n【工作區路徑】${wsRoot}`;
    if (activeFile) { wsInfo += `\n【作用中檔案】${activeFile}`; }
    if (openFiles.length) { wsInfo += `\n【開啟的檔案】\n` + openFiles.map(f => `  - ${f}`).join('\n'); }
    content += wsInfo;

    if (ltm.trim()) {
      content += '\n\n## 長期記憶（關於使用者的重要資訊）\n' + ltm.trim();
    }
    content += `\n\n## Atlassian 整合（atlassian.atlascode）
\
【強制規則—不得違反】
\
1. 訊息中出現 [A-Z][A-Z0-9]*-\\d+（例 UOEM2-3476、BIOS-123）→ Jira Issue Key。
\
2. 種類判斷與動作：
\
   - 「幫我分析 / RCA / 查看內容」任何分析許求 → 第一步必須立即呼叫 \`jira_fetch\`，取得內容後才可分析回答。
\
   - 「開啟 / 查看 / 顯示」 → 呼叫 \`jira_open\`（純 UI，不回傳內容）。
\
   - 建立 Issue → jira_create | 轉換狀態 → jira_transition | 開 PR → bb_create_pr | 問 Rovo Dev（AI 分析）→ rovo_ask（回傳回覆）
\
3. 【絕對禁止】不得說「我將查詢」「我會去取得」等宣告意圖的語句而不實際呼叫工具。看到 Jira Key 就直接呼叫工具，立即執行，不詄語。`;
    return content;
  }

  private async summarizeText(text: string, modelOverride?: string): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('amiAiClaw');
    const baseUrl = cfg.get<string>('url') ?? 'http://localhost:11434';
    const model = modelOverride ?? cfg.get<string>('model') ?? '';

    const prompt = `請以繁體中文，將下面內容濃縮成三條要點（每條 1 行），簡潔扼要：\n\n${text}`;
    try {
      const result = await ollamaGenerate(baseUrl, model, prompt);
      this._panel.webview.postMessage({ type: 'assistant', text: `（摘要）\n${result.response}` });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this._panel.webview.postMessage({ type: 'error', text: msg });
    }
  }

  private async handleInsert(code: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { vscode.window.showWarningMessage('沒有開啟的編輯器可供插入程式碼'); return; }
    await editor.edit(editBuilder => { editBuilder.insert(editor.selection.active, code); });
    vscode.window.showInformationMessage('已將程式碼插入到目前游標位置。');
  }

  private async handlePickFile(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      openLabel: '附加到對話',
      filters: { 'All Files': ['*'] }
    });
    if (!uris || uris.length === 0) { return; }
    for (const uri of uris) {
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const raw = Buffer.from(bytes).toString('utf8');
        const name = uri.fsPath.split(/[\\/]/).pop() ?? uri.fsPath;
        const content = raw.length > 65536 ? raw.slice(0, 65536) + '\n…（已截斷至 64 KB）' : raw;
        this._panel.webview.postMessage({ type: 'fileAttached', name, content });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this._panel.webview.postMessage({ type: 'error', text: '無法讀取檔案：' + msg });
      }
    }
  }

  private async startAuto(initialPrompt: string, modelOverride?: string): Promise<void> {
    if (this._autoRunning) { vscode.window.showInformationMessage('自動執行已在進行中'); return; }
    this._autoRunning = true;
    this._autoCancel = false;
    this._panel.webview.postMessage({ type: 'autoStatus', running: true });

    const cfg = vscode.workspace.getConfiguration('amiAiClaw');
    const baseUrl = cfg.get<string>('url') ?? 'http://localhost:11434';
    const model = modelOverride ?? cfg.get<string>('model') ?? '';

    // 切換 Ollama 模型時先卸載舊模型並等待 VRAM 釋放
    await this.ensureModelReady(baseUrl, model);

    let currentPrompt = initialPrompt + "\n\n請開始並持續改進直到完成；若需要存取工作目錄外的檔案，請回傳 'NEEDS_ACCESS: <path>'；完成時回傳 'DONE'.";
    let lastResult = '';

    for (let i = 0; i < this._autoMaxIterations && !this._autoCancel; i++) {
      try {
        this._panel.webview.postMessage({ type: 'assistant', text: `（自動輪次 ${i + 1}）執行中…` });
        const result = await ollamaGenerate(baseUrl, model, currentPrompt);
        lastResult = result.response;

        const accessMatch = /NEEDS_ACCESS:\s*([^\n\r]+)/i.exec(result.response) || /need access to\s*([^\n\r]+)/i.exec(result.response);
        if (accessMatch) {
          const pathRequested = (accessMatch[1] || '').trim();
          this._panel.webview.postMessage({ type: 'assistant', text: result.response, thinking: result.thinking });
          this._panel.webview.postMessage({ type: 'autoPaused', path: pathRequested });
          this._autoRunning = false;

          const grant = await vscode.window.showWarningMessage(`Assistant requests access to: ${pathRequested}`, 'Grant Access', 'Cancel');
          if (grant === 'Grant Access') {
            const uris = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectMany: false, openLabel: 'Grant Access' });
            if (!uris || uris.length === 0) {
              vscode.window.showInformationMessage('未授權存取，已停止自動執行。');
              break;
            }
            const grantedPath = uris[0].fsPath;
            this._panel.webview.postMessage({ type: 'assistant', text: `User granted access to ${grantedPath}. Resuming...` });
            currentPrompt = `User granted access to ${grantedPath}. Continue your previous work. If you need specific files, ask the user. If finished, reply 'DONE'.`;
            this._autoRunning = true;
            continue;
          } else {
            this._panel.webview.postMessage({ type: 'assistant', text: 'User denied access. Stopping auto-run.' });
            break;
          }
        }

        if (/\bDONE\b/i.test(result.response) || /已完成|完成了/i.test(result.response)) {
          this._panel.webview.postMessage({ type: 'assistant', text: result.response, thinking: result.thinking });
          this._panel.webview.postMessage({ type: 'autoStatus', running: false });
          this._autoRunning = false;
          break;
        }

        this._panel.webview.postMessage({ type: 'assistant', text: result.response, thinking: result.thinking });
        const codeMatch = /\`\`\`([\s\S]*?)\`\`\`/.exec(result.response);
        if (codeMatch) {
          try { await this.handleInsert(codeMatch[1]); } catch { /* ignore insertion errors */ }
        }

        currentPrompt = `基於你剛才的回應：\n${result.response}\n\n請繼續改進或完成。若需要存取工作目錄外的檔案，請回傳 'NEEDS_ACCESS: <path>'；若已完成請回傳 'DONE'。只回覆必要內容與程式碼區塊。`;
        await new Promise(r => setTimeout(r, 600));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this._panel.webview.postMessage({ type: 'error', text: `Auto-run error: ${msg}` });
        break;
      }
    }

    this._autoRunning = false;
    this._autoCancel = false;
    this._panel.webview.postMessage({ type: 'autoStatus', running: false });
    if (!this._autoCancel) { vscode.window.showInformationMessage('自動執行已結束。'); } else { vscode.window.showInformationMessage('自動執行已被中止。'); }
  }

  /** 要求使用者確認敏感操作，回傳是否允許。
   *  - toolName: 工具名稱（可選），用於 settings toolAlwaysAllow/toolAlwaysConfirm 比對。
   *  - 設定 toolAlwaysAllow：含 category 或 toolName 則自動允許（不彈確認對話框）。
   *  - 設定 toolAlwaysConfirm：含 toolName 則每次必問（不能被 session 永遠允許覆蓋）。
   */
  private requestPermission(category: string, description: string, toolName = ''): Promise<boolean> {
    const pcfg = vscode.workspace.getConfiguration('amiAiClaw');
    const alwaysAllowList = pcfg.get<string[]>('toolAlwaysAllow') ?? [];
    const alwaysConfirmList = pcfg.get<string[]>('toolAlwaysConfirm') ?? [];
    if ((toolName && alwaysAllowList.includes(toolName)) || alwaysAllowList.includes(category)) {
      return Promise.resolve(true);
    }
    const forceConfirm = toolName ? alwaysConfirmList.includes(toolName) : false;
    if (!forceConfirm && this._alwaysAllow.has(category)) { return Promise.resolve(true); }
    return new Promise<boolean>((resolve) => {
      this._pendingPermission = resolve;
      this._panel.webview.postMessage({ type: 'permissionRequest', category, description, forceConfirm });
    });
  }

  private async handleAgent(userPrompt: string, modelOverride?: string, recordToShortTerm = true): Promise<void> {
    if (this._agentRunning) { vscode.window.showInformationMessage('Agent 已在執行中'); return; }
    this._agentRunning = true;
    this._agentCancel = false;
    this._panel.webview.postMessage({ type: 'agentStatus', running: true });

    const cfg = vscode.workspace.getConfiguration('amiAiClaw');
    const urls = getOllamaUrls(cfg);
    const rawModel = modelOverride ?? cfg.get<string>('model') ?? '';
    const { url: baseUrl, model } = rawModel.startsWith('copilot') ? { url: urls[0], model: rawModel } : decodeOllamaModel(rawModel, urls);

    // 切換 Ollama 模型時先卸載舊模型並等待 VRAM 釋放
    await this.ensureModelReady(baseUrl, model);

    if (this._agentMessages.length === 0) {
      const folders = vscode.workspace.workspaceFolders ?? [];
      const folderList = folders.map(f => f.uri.fsPath).join(', ') || process.cwd();
      const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath ?? '';
      const openFiles = vscode.workspace.textDocuments
        .filter(d => !d.isUntitled && d.uri.scheme === 'file')
        .map(d => d.uri.fsPath);
      const openFilesStr = openFiles.length > 0 ? `\n目前編輯器中開啟的檔案:\n${openFiles.join('\n')}` : '';
      const activeFileStr = activeFile ? `\n目前作用中的檔案: ${activeFile}` : '';
      this._agentTodos = [];
      const ltmForAgent = this.getLongTermMemory();
      this._agentMessages.push({
        role: 'system',
        content: `你是 VS Code 程式開發助手 Agent，可存取的工作區資料夾: ${folderList}。${activeFileStr}${openFilesStr}

執行必違規則：
- 不得說「我將」「我會」等宣告意圖而不實際呼叫工具。看到需求就直接呼叫對應工具，立即執行。
- 不確定時優先查閱本地程式碼，而非假設或憑空生成。

執行策略：
1. 先用 search_workspace 搜尋工作區中的檔案名稱、函式名稱、類別名稱等
2. 讀取相關檔案確認實際內容
3. 根據工作區實際程式碼進行修改或回答

## Atlassian 整合（atlassian.atlascode）【強制】
訊息中出現 [A-Z][A-Z0-9]*-\d+（例 UOEM2-3476、BIOS-123）→ Jira Issue Key。

【絕對禁止】不得說「我將查詢」「我會去取得」等宣告意圖而不實際呼叫工具。

工具選擇規則：
- 任何分析 / RCA / 查看內容 → 第一步必須立即呼叫 jira_fetch，取得 Issue 內容後再回答
- 開啟 VS Code 面板 → jira_open（純 UI，不回傳內容）
- 建立 Issue → jira_create；轉換狀態 → jira_transition；開 PR → bb_create_pr；問 Rovo Dev（AI 分析，回傳回覆）→ rovo_ask
${ltmForAgent.trim() ? '\n## 長期記憶\n' + ltmForAgent.trim() : ''}

請使用繁體中文回答，完成後告知使用者結果。`
      });
    }
    this._agentMessages.push({ role: 'user', content: userPrompt });
    // 同步到短期記憶（若呼叫者需要記錄）
    if (recordToShortTerm) {
      this._chatHistory.push({ role: 'user', content: userPrompt });
      this._chatHistories[this._activeSessionId] = this._chatHistory;
      this._panel.webview.postMessage({ type: 'historyCount', count: this._chatHistory.length, sessionId: this._activeSessionId });
    }

    try {
      for (let step = 0; step < 20 && !this._agentCancel; step++) {
        let resp: ChatMessage | undefined;
        const isOllama = !model.startsWith('copilot::');
        // 主動摘要：每步開始前檢查進行上下文大小，超過閾値就自動壓縮
        await this._autoSummarizeHistory(model, baseUrl);
        // Ollama: stream each call so thinking appears in real-time
        if (isOllama) { this._panel.webview.postMessage({ type: 'streamStart' }); }
        const onThinkCb = isOllama ? (c: string) => { this._panel.webview.postMessage({ type: 'thinkChunk', chunk: c }); } : undefined;
        const onTextCb  = isOllama ? (c: string) => { this._panel.webview.postMessage({ type: 'assistantChunk', chunk: c }); } : undefined;
        const onStatsCb = isOllama ? (t: number, tps: number) => { this._panel.webview.postMessage({ type: 'streamStats', tokens: t, tps }); this.trackUsage(model, t); } : undefined;
        try {
          resp = model.startsWith('copilot::')
            ? await copilotChatCallWithCts(model.slice('copilot::'.length), this._agentMessages, AGENT_TOOLS)
            : await ollamaChatCallStream(baseUrl, model, this._agentMessages, AGENT_TOOLS, onThinkCb, onTextCb, onStatsCb);
          if (resp && !isOllama) { this.trackUsage(model, Math.ceil(estimateTokens(resp.content ?? '')), getCopilotMultiplierById(model.slice('copilot::'.length))); }
        } catch (e) {
          if (isOllama) { this._panel.webview.postMessage({ type: 'streamAbort' }); }
          const emsg = e instanceof Error ? e.message : String(e);
          if (/does not support tools/i.test(emsg)) {
            this._panel.webview.postMessage({ type: 'error', text: `模型 ${model} 不支援工具呼叫（tools API）。\nAgent 模式需要支援 tools 的模型，例如：qwen2.5:7b、llama3.1:8b、mistral-nemo。\n請在 AMI-AiClaw 設定中更換模型。` });
            break;
          }
          if (/token|limit|context|exceed/i.test(emsg) && this._agentMessages.length > 4) {
            await this._autoSummarizeHistory(model, baseUrl);
            if (isOllama) { this._panel.webview.postMessage({ type: 'streamStart' }); }
            resp = model.startsWith('copilot::')
              ? await copilotChatCallWithCts(model.slice('copilot::'.length), this._agentMessages, AGENT_TOOLS)
              : await ollamaChatCallStream(baseUrl, model, this._agentMessages, AGENT_TOOLS, onThinkCb, onTextCb, onStatsCb);
          } else {
            throw e;
          }
        }
        if (!resp) { if (isOllama) { this._panel.webview.postMessage({ type: 'streamAbort' }); } break; }

        if (resp.tool_calls && resp.tool_calls.length > 0) {
          // Tool call: discard streamed content (was empty for tool decisions)
          if (isOllama) { this._panel.webview.postMessage({ type: 'streamAbort' }); }
          this._agentMessages.push({ role: 'assistant', content: resp.content ?? null, tool_calls: resp.tool_calls });
          // 循序執行工具（保持 _agentStepNode 追蹤正確 + requestPermission 單一 pending 不衝突）
          for (const tc of resp.tool_calls) {
            const fn = tc.function;
            const args = (typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : fn.arguments) as Record<string, unknown>;
            this._panel.webview.postMessage({ type: 'agentStep', icon: getToolIcon(fn.name), title: formatToolTitle(fn.name, args), fullPath: (args.path as string) || (args.command as string) || '' });
            let result: string;
            let isError = false;
            try {
              result = await this.executeTool(fn.name, args);
            } catch (e) {
              result = '錯誤：' + (e instanceof Error ? e.message : String(e));
              isError = true;
            }
            // 敏感資訊過濾（預設啟用，可由 amiAiClaw.filterSensitiveInfo 設定關閉）
            if (vscode.workspace.getConfiguration('amiAiClaw').get<boolean>('filterSensitiveInfo', true)) {
              result = filterSensitiveInfo(result);
            }
            // 稽核日誌：記錄工具呼叫與結果
            const _auditEntry = { ts: Date.now(), session: this._activeSessionId, tool: fn.name, argsSnippet: JSON.stringify(args).slice(0, 120), error: isError };
            this._auditLog.push(_auditEntry);
            if (this._auditLog.length > 200) { this._auditLog.shift(); }
            const _savedAudit = this._context.globalState.get<typeof _auditEntry[]>('amiAiClaw.auditLog') ?? [];
            _savedAudit.push(_auditEntry);
            if (_savedAudit.length > 500) { _savedAudit.splice(0, _savedAudit.length - 500); }
            void this._context.globalState.update('amiAiClaw.auditLog', _savedAudit);
            const preview = result.length > 400 ? result.slice(0, 400) + '\n…（已截斷）' : result;
            this._panel.webview.postMessage({ type: 'agentStepDone', result: preview, isError });
            this._agentMessages.push({ role: 'tool', content: result, tool_call_id: tc.id ?? fn.name });
            if (recordToShortTerm) {
              // Tool 回傳作為短期記憶的一部分（以 preview 儲存）
              this._chatHistory.push({ role: 'assistant', content: preview });
              this._chatHistories[this._activeSessionId] = this._chatHistory;
              this._panel.webview.postMessage({ type: 'historyCount', count: this._chatHistory.length, sessionId: this._activeSessionId });
            }
          }
        } else {
          const rawText = resp.content ?? '';
          // 提取 <think>...</think> 區塊供思考視窗顯示
          const thinkContent = resp.thinking ||
            (() => { const m = rawText.match(/^<think>([\s\S]*?)<\/think>\s*/); return m ? m[1].trim() : ''; })();
          const text = thinkContent ? rawText.replace(/^<think>[\s\S]*?<\/think>\s*/, '') : rawText;
          const tokenEst = Math.ceil(estimateTokens(rawText));
          this._agentMessages.push({ role: 'assistant', content: rawText });
          if (recordToShortTerm) {
            this._chatHistory.push({ role: 'assistant', content: text || rawText });
            this._chatHistories[this._activeSessionId] = this._chatHistory;
            this._panel.webview.postMessage({ type: 'historyCount', count: this._chatHistory.length, sessionId: this._activeSessionId });
          }
          if (isOllama) {
            // Content was already streamed via assistantChunk; just finalize the stream node
            this._panel.webview.postMessage({ type: 'streamEnd' });
          } else {
            // Copilot: non-streaming, post as complete message
            this._panel.webview.postMessage({ type: 'assistant', text: text || rawText, thinking: thinkContent || undefined, tokens: tokenEst });
          }
          break;
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this._panel.webview.postMessage({ type: 'error', text: 'Agent 錯誤：' + msg });
    } finally {
      this._agentRunning = false;
      this._agentCancel = false;
      this._panel.webview.postMessage({ type: 'agentStatus', running: false });
    }
  }

  /** 自動摘要 _agentMessages：token 超過閾值時以 AI 壓縮舊訊息，保留最近 4 則 + system prompt。
   *  若設定關閉或摘要失敗則降級為直接丟棄舊訊息對。
   */
  private async _autoSummarizeHistory(model: string, baseUrl: string): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('amiAiClaw');
    const enabled = cfg.get<boolean>('autoSummarizeHistory', true);
    const threshold = cfg.get<number>('autoSummarizeThreshold', 8000);
    const sys = this._agentMessages[0];
    const rest = this._agentMessages.slice(1);
    const total = estimateTokens((sys?.content ?? '') + rest.map(m => m.content ?? '').join(''));
    if (total < threshold) { return; }

    const dropFallback = (r: ChatMessage[]) => {
      let trimmed = r;
      while (trimmed.length > 2 && estimateTokens((sys?.content ?? '') + trimmed.map(m => m.content ?? '').join('')) >= threshold) {
        trimmed = trimmed.slice(2);
      }
      this._agentMessages = [sys, ...trimmed];
      this._agentMessagesBySession[this._activeSessionId] = this._agentMessages;
    };

    if (!enabled) { dropFallback(rest); return; }

    // 保留最近4 則不壓縮，將其餘小結與 AI
    const keepTail = rest.slice(-4);
    const toSummarize = rest.slice(0, Math.max(rest.length - 4, 0));
    if (toSummarize.length < 2) { return; }

    this._panel.webview.postMessage({ type: 'agentStep', icon: '📝', title: `對話歷史過長（≈${total} tokens），自動摘要舊訊息中…`, fullPath: '' });
    const summaryMsgs: ChatMessage[] = [
      { role: 'system', content: '你是對話摘要助手。請將以下對話記錄濃縮成一段繁體中文摘要，保留重要的決策、已完成的操作、重要的程式碼路徑或資訊，省略冗餘問答。摘要長度不超過 600 字，直接輸出摘要內容不需要前言。' },
      { role: 'user', content: '請摘要以下對話記錄：\n\n' + toSummarize.map(m => `[${m.role}]: ${(m.content ?? '').slice(0, 800)}`).join('\n\n').slice(0, 12000) }
    ];
    let summary = '';
    try {
      const sResp = model.startsWith('copilot::')
        ? await copilotChatCallWithCts(model.slice('copilot::'.length), summaryMsgs, [])
        : await ollamaChatCallStream(baseUrl, model, summaryMsgs, []);
      summary = (sResp?.content ?? '').trim();
    } catch { /* 摘要失敗，降級主動丟棄 */ }

    if (!summary) {
      dropFallback(rest);
      this._panel.webview.postMessage({ type: 'agentStep', icon: '⚠️', title: '摘要失敗，改用裁剪模式', fullPath: '' });
      return;
    }

    this._agentMessages = [
      sys,
      { role: 'user', content: `[自動摘要 — 先前 ${toSummarize.length} 則對話重點]\n${summary}` },
      { role: 'assistant', content: '已了解先前對話的進度與重要資訊，繼續執行任務。' },
      ...keepTail
    ];
    this._agentMessagesBySession[this._activeSessionId] = this._agentMessages;
    this._panel.webview.postMessage({ type: 'agentStep', icon: '✅', title: `摘要完成：${toSummarize.length} 則壓縮為 1 則摘要，釋出≈${total - estimateTokens(summary)} tokens`, fullPath: '' });
  }

  /** 從 atlassian.atlascode 擷取 Jira auth (bearer token + baseApiUrl)。
   *  只支援 Windows，使用 Python (內建模組) + Node.js crypto 解密。
   *  cache：到期前 5 分鐘更新。
   */
  private async getAtlascodeJiraAuth(): Promise<{ baseApiUrl: string; accessToken: string } | null> {
    if (this._atlasJiraCred && this._atlasJiraCred.expiry > Date.now() + 300_000) {
      return this._atlasJiraCred;
    }
    try {
      const appData = process.env['APPDATA'];
      if (!appData) { return null; }
      const localStatePath = path.join(appData, 'Code', 'Local State');
      if (!fs.existsSync(localStatePath)) { return null; }

      // Python 腳本：使用內建模組讀 SQLite + DPAPI 解密 master key，輸出 JSON
      // 路徑用 JSON.stringify 嵌入：Python 解析 "C:\\Users\\..." = C:\Users\... (正確)
      const pyScript = [
        'import sqlite3,json,ctypes,base64,os,sys',
        `app=${JSON.stringify(appData)}`,
        `db=os.path.join(app,'Code','User','globalStorage','state.vscdb')`,
        `ls_path=os.path.join(app,'Code','Local State')`,
        'with open(ls_path,encoding="utf-8") as f: ls=json.load(f)',
        'enc=base64.b64decode(ls["os_crypt"]["encrypted_key"])[5:]',
        'class B(ctypes.Structure): _fields_=[("n",ctypes.c_ulong),("p",ctypes.POINTER(ctypes.c_char))]',
        'i=(ctypes.c_char*len(enc))(*enc); ib=B(len(enc),i); ob=B()',
        'ok=ctypes.windll.crypt32.CryptUnprotectData(ctypes.byref(ib),None,None,None,None,0,ctypes.byref(ob))',
        'if not ok: print(json.dumps({"error":"dpapi"})); sys.exit(1)',
        'mk=list(ctypes.string_at(ob.p,ob.n)); ctypes.windll.kernel32.LocalFree(ob.p)',
        'c=sqlite3.connect(db)',
        'r=c.execute("SELECT value FROM ItemTable WHERE key=?",["atlassian.atlascode"]).fetchone()',
        'if not r: print(json.dumps({"error":"no_state"})); sys.exit(1)',
        'st=json.loads(r[0]); sites=st.get("jiraSites",[])',
        'if not sites: print(json.dumps({"error":"no_sites"})); sys.exit(1)',
        's=sites[0]',
        'ck=\'secret://{"extensionId":"atlassian.atlascode","key":"jira-\'+s["credentialId"]+\'"}\'',
        'er=c.execute("SELECT value FROM ItemTable WHERE key=?",[ck]).fetchone(); c.close()',
        'if not er: print(json.dumps({"error":"no_cred"})); sys.exit(1)',
        'ed=json.loads(er[0])',
        'print(json.dumps({"mk":mk,"buf":ed["data"],"baseApiUrl":s["baseApiUrl"],"host":s.get("host","")}))',
      ].join('\n');

      // 寫入 temp file 執行，避免 Windows stdin pipe hang 問題
      // 嘗試 py (Windows Launcher) → python → python3
      const tmpPy = path.join(appData, 'ami-atlas-auth-tmp.py');
      fs.writeFileSync(tmpPy, pyScript, 'utf-8');
      let raw = '';
      let lastErr: unknown;
      const pythonCmds = process.platform === 'win32' ? ['py', 'python'] : ['python3', 'python'];
      try {
        for (const cmd of pythonCmds) {
          try {
            raw = execSync(`${cmd} "${tmpPy}"`, { encoding: 'utf-8', timeout: 12_000 }).trim();
            lastErr = undefined;
            break;
          } catch (e) { lastErr = e; }
        }
        if (lastErr) { throw lastErr; }
      } finally {
        try { fs.unlinkSync(tmpPy); } catch { /* ignore */ }
      }
      const parsed = JSON.parse(raw) as {
        error?: string; mk?: number[]; buf?: number[];
        baseApiUrl?: string; host?: string;
      };
      if (parsed.error || !parsed.mk || !parsed.buf || !parsed.baseApiUrl) {
        OllamaChatPanel.log(`atlascode auth: ${parsed.error ?? 'missing fields'}`);
        return null;
      }

      // AES-256-GCM 解密：v10(3) + nonce(12) + ciphertext + tag(16)
      const masterKey = Buffer.from(parsed.mk);
      const buf = Buffer.from(parsed.buf);
      const nonce = buf.slice(3, 15);
      const ciphertext = buf.slice(15, buf.length - 16);
      const tag = buf.slice(buf.length - 16);
      const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, nonce);
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      const cred = JSON.parse(plain.toString('utf-8')) as { access?: string; refresh?: string };
      if (!cred.access) { return null; }

      // 解析 JWT expiry
      let expiry = Date.now() + 3_600_000; // 預設 1h
      try {
        const payload = JSON.parse(Buffer.from(cred.access.split('.')[1], 'base64').toString('utf-8'));
        if (payload.exp) { expiry = payload.exp * 1000; }
      } catch { /* ignore */ }

      this._atlasJiraCred = { baseApiUrl: parsed.baseApiUrl, accessToken: cred.access, expiry };
      return this._atlasJiraCred;
    } catch (e) {
      OllamaChatPanel.log(`getAtlascodeJiraAuth error: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  /** 探索 Rovo Dev 本地 HTTP server (127.0.0.1:{port})，優先讀 env var，否則掃描 Windows 程序表。
   *  正向結果快取 5 分鐘；負向結果快取 30 秒。*/
  private async discoverRovoDevUrl(): Promise<{ url: string; token: string } | null> {
    if (this._rovoDevCache && Date.now() < this._rovoDevCache.expiry) {
      return { url: this._rovoDevCache.url, token: this._rovoDevCache.token };
    }
    if (!this._rovoDevCache && Date.now() < this._rovoDevNullUntil) { return null; }

    const envToken = process.env['ROVODEV_SERVE_SESSION_TOKEN'] ?? '';

    const tryUrl = async (url: string): Promise<boolean> => {
      return new Promise(resolve => {
        try {
          const u = new URL('/healthcheck', url);
          const headers: Record<string, string> = envToken ? { 'Authorization': `Bearer ${envToken}` } : {};
          const req = http.request({ hostname: u.hostname, port: parseInt(u.port || '80'), path: u.pathname, method: 'GET', headers }, res => {
            res.resume(); resolve(res.statusCode === 200);
          });
          req.on('error', () => resolve(false));
          req.setTimeout(2000, () => { req.destroy(); resolve(false); });
          req.end();
        } catch { resolve(false); }
      });
    };

    // 1. Env var (Boysenberry mode)
    const envPort = process.env['ROVODEV_PORT'];
    if (envPort && /^\d+$/.test(envPort)) {
      const url = `http://127.0.0.1:${envPort}`;
      if (await tryUrl(url)) {
        this._rovoDevCache = { url, token: envToken, expiry: Date.now() + 5 * 60_000 };
        return { url, token: envToken };
      }
    }

    // 2. Windows: find atlassian_cli_rovodev.exe port via tasklist + netstat
    if (process.platform === 'win32') {
      const port = this.findRovoDevPortWindows();
      if (port) {
        const url = `http://127.0.0.1:${port}`;
        if (await tryUrl(url)) {
          this._rovoDevCache = { url, token: envToken, expiry: Date.now() + 5 * 60_000 };
          return { url, token: envToken };
        }
      }
    }

    this._rovoDevCache = undefined;
    this._rovoDevNullUntil = Date.now() + 30_000;
    return null;
  }

  /** 用 tasklist + netstat 同步取得 Rovo Dev 監聽 port (Windows)。*/
  private findRovoDevPortWindows(): string | null {
    try {
      const taskOut = execSync('tasklist /FI "IMAGENAME eq atlassian_cli_rovodev.exe" /FO CSV /NH 2>nul',
        { shell: 'cmd.exe', timeout: 3000, windowsHide: true }).toString();
      const pidMatch = taskOut.match(/"atlassian_cli_rovodev\.exe","(\d+)"/);
      if (!pidMatch) return null;
      const pid = pidMatch[1];
      const netOut = execSync('netstat -ano 2>nul | findstr " LISTENING"',
        { shell: 'cmd.exe', timeout: 5000, windowsHide: true }).toString();
      for (const line of netOut.split('\n')) {
        if (!line.trimEnd().endsWith(pid)) { continue; }
        const m = line.match(/127\.0\.0\.1:(\d+)/);
        if (!m) { continue; }
        const p = parseInt(m[1]);
        if (p >= 40000 && p <= 41000) { return String(p); }
      }
      return null;
    } catch { return null; }
  }

  /** 切換 Ollama 模型時先卸載舊模型（keep_alive=0），然後輪詢 /api/ps 確認卸載完成。
   *  最長等待 90s；確認消失後立即繼續。Copilot 模型不需此流程。
   *  注意：只有切換到「相同 Ollama server」時才需要等待 VRAM 釋放；
   *  若新模型在不同 server，直接繼續即可。*/
  private async ensureModelReady(baseUrl: string, model: string): Promise<void> {
    if (model.startsWith('copilot::')) { return; }
    const prevUrl = this._lastOllamaUrl;
    const prev = this._lastOllamaModel;
    this._lastOllamaUrl = baseUrl;
    this._lastOllamaModel = model;
    // No previous model, same model, or different server → no VRAM wait needed
    if (!prev || prev === model) { return; }
    if (prevUrl && prevUrl !== baseUrl) {
      OllamaChatPanel.log(`Model switch: ${prev}@${prevUrl} -> ${model}@${baseUrl}，不同 server，跳過 VRAM 釋放`);
      return;
    }

    OllamaChatPanel.log(`Model switch: ${prev} -> ${model}，正在卸載舊模型並等待 VRAM 釋放`);
    // Await unload request so Ollama receives the keep_alive=0 signal
    await ollamaUnloadModel(baseUrl, prev);

    // Poll /api/ps until the previous model disappears (max 90s)
    const maxWait = 90;
    for (let s = maxWait; s > 0; s--) {
      this._panel.webview.postMessage({
        type: 'assistant',
        text: `⏳ 模型切換（${prev.split('/').pop()} → ${model.split('/').pop()}），等待 VRAM 釋放… ${s}s`
      });
      const running = await ollamaListRunningModels(baseUrl);
      const stillLoaded = running.some(n => n === prev || n.startsWith(prev.split(':')[0]));
      if (!stillLoaded) {
        OllamaChatPanel.log(`VRAM 已釋放，等待結束（剩 ${s}s）`);
        this._panel.webview.postMessage({ type: 'assistant', text: `✅ VRAM 釋放完成，正在載入 ${model.split('/').pop()}…` });
        break;
      }
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  /** 向 Rovo Dev 本地 HTTP server 提問並以 SSE stream 收集文字回覆。
   *  回傳 AI 回覆文字，若無法連線則回傳 null。*/
  private async callRovoDevApi(question: string): Promise<string | null> {
    const target = await this.discoverRovoDevUrl();
    if (!target) { return null; }
    const { url, token } = target;
    const reqHeaders: Record<string, string> = { 'Content-Type': 'application/json', 'accept': 'text/event-stream' };
    if (token) { reqHeaders['Authorization'] = `Bearer ${token}`; }

    // Step 1: POST /v3/set_chat_message
    const body = JSON.stringify({ message: question, context: [] });
    const step1Ok = await new Promise<boolean>(resolve => {
      try {
        const u = new URL('/v3/set_chat_message', url);
        const req = http.request({
          hostname: u.hostname, port: parseInt(u.port || '80'),
          path: u.pathname, method: 'POST',
          headers: { ...reqHeaders, 'Content-Length': Buffer.byteLength(body) },
        }, res => { res.resume(); resolve(res.statusCode !== undefined && res.statusCode < 400); });
        req.on('error', () => resolve(false));
        req.setTimeout(10000, () => { req.destroy(); resolve(false); });
        req.write(body); req.end();
      } catch { resolve(false); }
    });
    if (!step1Ok) {
      // Auth or connection failed – invalidate cache so we re-discover next time
      this._rovoDevCache = undefined; this._rovoDevNullUntil = 0;
      return null;
    }

    // Step 2: GET /v3/stream_chat (SSE) and collect text parts
    return new Promise<string | null>(resolve => {
      try {
        const u = new URL('/v3/stream_chat?pause_on_call_tools_start=false&enable_deferred_tools=true', url);
        const req = http.request({
          hostname: u.hostname, port: parseInt(u.port || '80'),
          path: u.pathname + u.search, method: 'GET',
          headers: reqHeaders,
        }, res => {
          if (res.statusCode !== 200) { res.resume(); resolve(null); return; }
          let sseBuffer = '';
          const parts: string[] = [];
          res.on('data', (chunk: Buffer) => {
            sseBuffer += chunk.toString('utf8');
            const blocks = sseBuffer.split(/\r?\n\r?\n/g);
            sseBuffer = blocks.pop() ?? '';
            for (const block of blocks) {
              if (block.startsWith(': ping')) { continue; }
              const m = block.match(/^event: ([^\r\n]+)\r?\ndata: ([\s\S]*)$/);
              if (!m) { continue; }
              const kind = m[1].trim();
              let data: Record<string, unknown> = {};
              try { data = JSON.parse(m[2]); } catch { continue; }
              if (kind === 'text') {
                const c = (data['content'] ?? data['content_delta'] ?? '') as string;
                if (c) { parts.push(c); }
              } else if (kind === 'part_start') {
                const part = (data['part'] ?? {}) as Record<string, unknown>;
                if (part['part_kind'] === 'text' && part['content']) { parts.push(part['content'] as string); }
              } else if (kind === 'part_delta') {
                const delta = (data['delta'] ?? {}) as Record<string, unknown>;
                if (delta['part_delta_kind'] === 'text' && delta['content_delta']) { parts.push(delta['content_delta'] as string); }
              }
            }
          });
          res.on('end', () => { resolve(parts.join('').trim() || null); });
          res.on('error', () => resolve(null));
        });
        req.on('error', () => resolve(null));
        req.setTimeout(60000, () => { req.destroy(); resolve(null); });
        req.end();
      } catch { resolve(null); }
    });
  }

  private async executeTool(name: string, args: Record<string, unknown>): Promise<string> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const wsRoot = folders[0]?.uri.fsPath ?? '';
    const resolvePath = (p: string) => {
      if (!p) { return wsRoot; }
      if (path.isAbsolute(p)) { return p; }
      // Check if the relative path exists under any workspace folder
      for (const f of folders) {
        const candidate = path.join(f.uri.fsPath, p);
        // Return first folder that contains the relative prefix
        const rel = p.split(/[\\/]/)[0];
        if (rel) {
          try { require('fs').accessSync(path.join(f.uri.fsPath, rel)); return candidate; } catch { /* try next */ }
        }
      }
      return path.join(wsRoot, p);
    };
    switch (name) {
      case 'get_active_file': {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { return '沒有開啟的檔案'; }
        return `檔案: ${editor.document.uri.fsPath}\n\n${editor.document.getText()}`;
      }
      case 'read_file': {
        const fpath = resolvePath(args.path as string);
        const rfKey = `rf:${fpath}`;
        const rfCached = this._toolCache.get(rfKey);
        if (rfCached && Date.now() - rfCached.ts < OllamaChatPanel.TOOL_CACHE_TTL) { return rfCached.value; }
        // 先檢查檔案大小，避免大型二進位/文字檔案讓 webview 凍結
        let fileStat: vscode.FileStat;
        try { fileStat = await vscode.workspace.fs.stat(vscode.Uri.file(fpath)); }
        catch { return `錯誤：找不到檔案 ${fpath}`; }
        const MAX_BYTES = 5 * 1024 * 1024; // 5 MB
        if (fileStat.size > MAX_BYTES) {
          return `檔案過大（${(fileStat.size / 1024 / 1024).toFixed(1)} MB > 5 MB），拒絕讀取以防止凍結。請改用 search_regex 或指定行範圍。`;
        }
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(fpath));
        const text = Buffer.from(bytes).toString('utf8');
        const rfResult = text.length > 50000 ? text.slice(0, 50000) + '\n…（已截斷至 50KB）' : text;
        if (text.length <= 10000) { this._toolCache.set(rfKey, { value: rfResult, ts: Date.now() }); }
        return rfResult;
      }
      case 'write_file': {
        const fpath = resolvePath(args.path as string);
        const content = (args.content as string) ?? '';
        const allowed = await this.requestPermission('write', `寫入檔案: ${fpath}（${content.length} 字元）`, 'write_file');
        if (!allowed) { return '使用者已拒絕寫入操作'; }
        await vscode.workspace.fs.writeFile(vscode.Uri.file(fpath), Buffer.from(content, 'utf8'));
        this._toolCache.delete(`rf:${fpath}`);
        return `已寫入 ${fpath}（${content.length} 字元）`;
      }
      case 'replace_in_file': {
        const fpath = resolvePath(args.path as string);
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(fpath));
        const original = Buffer.from(bytes).toString('utf8');
        const oldStr = args.old_str as string;
        const newStr = (args.new_str as string) ?? '';
        if (!original.includes(oldStr)) { return `錯誤：在 ${fpath} 中找不到指定的字串`; }
        const allowed = await this.requestPermission('write', `編輯檔案: ${fpath}`, 'replace_in_file');
        if (!allowed) { return '使用者已拒絕編輯操作'; }
        await vscode.workspace.fs.writeFile(vscode.Uri.file(fpath), Buffer.from(original.replace(oldStr, newStr), 'utf8'));
        this._toolCache.delete(`rf:${fpath}`);
        return `已更新 ${fpath}`;
      }
      case 'list_dir': {
        const dirArg = (args.path as string) || '';
        const ldKey = `ld:${dirArg}`;
        const ldCached = this._toolCache.get(ldKey);
        if (ldCached && Date.now() - ldCached.ts < OllamaChatPanel.TOOL_CACHE_TTL) { return ldCached.value; }
        let ldResult: string;
        if (!dirArg && folders.length > 1) {
          // List all workspace folders
          const results: string[] = [];
          for (const f of folders) {
            const entries = await vscode.workspace.fs.readDirectory(f.uri);
            const listing = entries.map(([n, t]) => t === vscode.FileType.Directory ? n + '/' : n).sort().join('\n');
            results.push(`=== ${f.uri.fsPath} ===\n${listing}`);
          }
          ldResult = results.join('\n\n');
        } else {
          const dpath = resolvePath(dirArg);
          const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dpath));
          ldResult = entries.map(([n, t]) => t === vscode.FileType.Directory ? n + '/' : n).sort().join('\n');
        }
        this._toolCache.set(ldKey, { value: ldResult, ts: Date.now() });
        return ldResult;
      }
      case 'run_terminal': {
        const cmd = args.command as string;
        const cwd = (args.cwd as string) ? resolvePath(args.cwd as string) : (folders[0]?.uri.fsPath ?? process.cwd());
        const allowed = await this.requestPermission('run', `終端機執行: ${cmd}`, 'run_terminal');
        if (!allowed) { return '使用者已拒絕執行操作'; }
        const rtCfg = vscode.workspace.getConfiguration('amiAiClaw');
        if (rtCfg.get<boolean>('sandboxUseDocker', false)) {
          const rtImg = rtCfg.get<string>('sandboxDockerImage', 'ubuntu:24.04');
          return await runDockerShell(cmd, rtImg, 125000);
        }
        // Show in VS Code terminal for user visibility
        const terminals = vscode.window.terminals;
        const terminal = terminals.length > 0 ? terminals[terminals.length - 1] : vscode.window.createTerminal('Agent');
        terminal.show(true);
        terminal.sendText(cmd);
        // Also capture output via exec with 120s timeout
        return new Promise<string>((resolve) => {
          const { exec } = require('child_process') as typeof import('child_process');
          exec(cmd, { cwd, timeout: 120_000, shell: true as unknown as string, maxBuffer: 4 * 1024 * 1024 }, (_err, stdout, stderr) => {
            const out = (stdout || '') + (stderr ? `\n[stderr]\n${stderr}` : '');
            const trimmed = out.trim();
            resolve(trimmed.length > 10000 ? trimmed.slice(0, 10000) + '\n…（已截斷至 10KB）' : trimmed || '(無輸出)');
          });
        });
      }
      case 'search_workspace': {
        const query = ((args.query as string) ?? '').toLowerCase();
        if (!query) { return '請提供搜尋關鍵字'; }
        const allUris = await vscode.workspace.findFiles('**/*', '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**}', 200);
        const fileMatches = allUris.map(u => u.fsPath).filter(p => path.basename(p).toLowerCase().includes(query));
        const contentMatches: string[] = [];
        for (const uri of allUris) {
          if (contentMatches.length >= 40) { break; }
          try {
            const ext = path.extname(uri.fsPath).toLowerCase();
            if (['.png','.jpg','.ico','.vsix','.zip','.exe','.dll','.pdf'].includes(ext)) { continue; }
            const bytes = await vscode.workspace.fs.readFile(uri);
            const text = Buffer.from(bytes).toString('utf8');
            const lines = text.split('\n');
            for (let li = 0; li < lines.length && contentMatches.length < 40; li++) {
              if (lines[li].toLowerCase().includes(query)) {
                contentMatches.push(`${uri.fsPath}:${li + 1}: ${lines[li].trim().slice(0, 120)}`);
              }
            }
          } catch { /* skip binary */ }
        }
        const parts: string[] = [];
        if (fileMatches.length > 0) { parts.push(`=== 檔案名稱匹配 (${fileMatches.length}) ===\n${fileMatches.slice(0, 30).join('\n')}`); }
        if (contentMatches.length > 0) { parts.push(`=== 程式碼內容匹配 (${contentMatches.length}) ===\n${contentMatches.join('\n')}`); }
        return parts.length > 0 ? parts.join('\n\n') : `找不到符合 "${args.query}" 的結果`;
      }
      case 'delete_file': {
        const fpath = resolvePath(args.path as string);
        const allowed = await this.requestPermission('delete', `刪除: ${fpath}`, 'delete_file');
        if (!allowed) { return '使用者已拒絕刪除操作'; }
        await vscode.workspace.fs.delete(vscode.Uri.file(fpath), { recursive: (args.recursive as boolean) ?? false });
        this._toolCache.delete(`rf:${fpath}`);
        this._toolCache.delete(`ld:${path.dirname(fpath)}`);
        return `已刪除 ${fpath}`;
      }
      case 'create_dir': {
        const dpath = resolvePath(args.path as string);
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(dpath));
        return `已建立目錄 ${dpath}`;
      }
      case 'run_command': {
        const cmd = args.command as string;
        const cwd = (args.cwd as string) ? resolvePath(args.cwd as string) : (folders[0]?.uri.fsPath ?? process.cwd());
        const allowed = await this.requestPermission('run', `執行指令: ${cmd}`, 'run_command');
        if (!allowed) { return '使用者已拒絕執行操作'; }
        const rcCfg = vscode.workspace.getConfiguration('amiAiClaw');
        if (rcCfg.get<boolean>('sandboxUseDocker', false)) {
          const rcImg = rcCfg.get<string>('sandboxDockerImage', 'ubuntu:24.04');
          return await runDockerShell(cmd, rcImg, 35000);
        }
        return new Promise<string>((resolve) => {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { exec } = require('child_process') as typeof import('child_process');
          exec(cmd, { cwd, timeout: 30000, shell: true as unknown as string }, (_err, stdout, stderr) => {
            const out = (stdout || '') + (stderr ? `\n[stderr]\n${stderr}` : '');
            resolve(out.trim().slice(0, 8000) || '(無輸出)');
          });
        });
      }
      case 'fetch_url': {
        const rawUrl = args.url as string;
        return new Promise<string>((resolve) => {
          const protocol = rawUrl.startsWith('https') ? https : http;
          let buf = '';
          const req = protocol.get(rawUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (AmiClaw-Agent)' } }, (res) => {
            if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
              resolve(`重導到: ${res.headers.location} (請再呼叫 fetch_url)`);
              return;
            }
            res.setEncoding('utf8');
            res.on('data', (d: string) => { buf += d; if (buf.length > 300000) { res.destroy(); } });
            res.on('end', () => {
              const stripped = buf
                .replace(/<script[\s\S]*?<\/script>/gi, '')
                .replace(/<style[\s\S]*?<\/style>/gi, '')
                .replace(/<[^>]+>/g, ' ')
                .replace(/[ \t]{2,}/g, ' ')
                .replace(/\n{3,}/g, '\n\n')
                .trim();
              resolve(stripped.slice(0, 12000));
            });
            res.on('error', (e: Error) => resolve(`網路錯誤: ${e.message}`));
          });
          req.on('error', (e: Error) => resolve(`網路錯誤: ${e.message}`));
          req.setTimeout(15000, () => { req.destroy(); resolve('超時 (15s)'); });
        });
      }
      case 'open_browser': {
        const url = args.url as string;
        try {
          await vscode.commands.executeCommand('simpleBrowser.api.open', url);
          return `已在 VS Code 簡易瀏覽器開啟: ${url}`;
        } catch {
          await vscode.env.openExternal(vscode.Uri.parse(url));
          return `已在系統瀏覽器開啟: ${url}`;
        }
      }
      case 'manage_todo': {
        const action = (args.action as string) || 'list';
        if (action === 'add') {
          const text = args.text as string;
          if (!text) { return '請提供 todo 內容 (text 參數)'; }
          this._agentTodos.push({ id: this._agentTodos.length + 1, text, done: false });
          return `已新增 Todo #${this._agentTodos.length}: ${text}`;
        } else if (action === 'done') {
          const id = Number(args.id);
          const item = this._agentTodos.find(t => t.id === id);
          if (!item) { return `找不到 Todo #${id}`; }
          item.done = true;
          return `✅ Todo #${id} 已完成: ${item.text}`;
        } else if (action === 'clear') {
          this._agentTodos = [];
          return 'Todo 清單已清空';
        } else {
          if (this._agentTodos.length === 0) { return 'Todo 清單是空的，請先用 add 新增任務'; }
          return this._agentTodos.map(t => `${t.done ? '✅' : '⏳'} #${t.id}: ${t.text}`).join('\n');
        }
      }
      case 'vscode_action': {
        const action = (args.action as string) || '';
        if (action === 'open_file') {
          const fpath = resolvePath(args.path as string);
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fpath));
          const editor = await vscode.window.showTextDocument(doc, { preview: true });
          if (args.line) {
            const pos = new vscode.Position(Math.max(0, Number(args.line) - 1), 0);
            editor.selection = new vscode.Selection(pos, pos);
            editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
          }
          return `已開啟 ${fpath}${args.line ? ` 第 ${args.line} 行` : ''}`;
        } else if (action === 'get_workspace_info') {
          const wsFolders = vscode.workspace.workspaceFolders ?? [];
          const openDocs = vscode.workspace.textDocuments.filter(d => !d.isUntitled && d.uri.scheme === 'file');
          return `工作區: ${wsFolders.map(f => f.uri.fsPath).join(', ') || '(none)'}\n開啟中檔案:\n${openDocs.map(d => d.uri.fsPath).join('\n') || '(none)'}`;
        } else if (action === 'show_notification') {
          vscode.window.showInformationMessage(String(args.message ?? ''));
          return '已顯示通知';
        } else if (action === 'run_command') {
          await vscode.commands.executeCommand(args.command as string, ...(Array.isArray(args.args) ? args.args : []));
          return `已執行 VS Code 指令: ${args.command}`;
        }
        return `未知 vscode_action: ${action}`;
      }
      case 'jira_fetch': {
        const fetchKey = (args.issue_key as string || '').trim().toUpperCase();
        if (!fetchKey) return '請提供 issue_key，例如 BIOS-123';

        // 決定 auth：優先嘗試 atlascode 已登入憑證，fallback 到手動設定
        let issueApiUrl: string;
        let authHeader: string;
        const atlasAuth = await this.getAtlascodeJiraAuth();
        if (atlasAuth) {
          // atlascode auth：baseApiUrl = https://api.atlassian.com/ex/jira/<id>/rest
          const fieldsParam = 'summary,description,status,assignee,reporter,priority,issuetype,labels,comment,attachment,created,updated';
          issueApiUrl = `${atlasAuth.baseApiUrl}/api/2/issue/${fetchKey}?fields=${fieldsParam}`;
          authHeader = `Bearer ${atlasAuth.accessToken}`;
        } else {
          // fallback：手動設定
          const jiraCfg = vscode.workspace.getConfiguration('amiAiClaw');
          const jiraBase = (jiraCfg.get<string>('jiraBaseUrl') ?? '').replace(/\/$/, '');
          const jiraEmail = jiraCfg.get<string>('jiraEmail') ?? '';
          const jiraPat = jiraCfg.get<string>('jiraPat') ?? '';
          if (!jiraBase) return '找不到 atlassian.atlascode 登入資訊，請在 VS Code 設定中填寫 amiAiClaw.jiraBaseUrl';
          if (!jiraPat)  return '找不到 atlassian.atlascode 登入資訊，請在 VS Code 設定中填寫 amiAiClaw.jiraPat';
          const fieldsParam = 'summary,description,status,assignee,reporter,priority,issuetype,labels,comment,attachment,created,updated';
          issueApiUrl = `${jiraBase}/rest/api/2/issue/${fetchKey}?fields=${fieldsParam}`;
          authHeader = jiraEmail
            ? 'Basic ' + Buffer.from(`${jiraEmail}:${jiraPat}`).toString('base64')
            : 'Bearer ' + jiraPat;
        }

        return new Promise<string>((resolve) => {
          try {
            const u = new URL(issueApiUrl);
            const proto = u.protocol === 'https:' ? https : http;
            const req = proto.request({
              hostname: u.hostname, port: u.port ? parseInt(u.port) : (u.protocol === 'https:' ? 443 : 80),
              path: u.pathname + u.search, method: 'GET',
              headers: { 'Authorization': authHeader, 'Accept': 'application/json', 'Content-Type': 'application/json' }
            }, (res) => {
              let data = '';
              res.on('data', (c: Buffer) => { data += c; });
              res.on('end', () => {
                if (res.statusCode === 401 || res.statusCode === 403) {
                  // token 可能過期，清除 cache 下次重新取得
                  this._atlasJiraCred = null;
                  resolve(`Jira 認證失敗 (HTTP ${res.statusCode})，請確認 atlassian.atlascode 已登入，或在設定中填寫 amiAiClaw.jiraPat。`);
                  return;
                }
                if (res.statusCode === 404) { resolve(`找不到 Issue ${fetchKey}，請確認 Key 正確或使用者有權限。`); return; }
                if (res.statusCode !== 200) { resolve(`Jira API 回傳 HTTP ${res.statusCode}: ${data.substring(0, 200)}`); return; }
                try {
                  const j = JSON.parse(data);
                  const f = j.fields || {};
                  const comments = (f.comment?.comments ?? []).slice(-3).map((c: Record<string, unknown>) => `  [${c.author && (c.author as Record<string,unknown>).displayName}] ${String(c.body ?? '').substring(0, 300)}`).join('\n');
                  const attachments = (f.attachment ?? []) as Array<{ filename: string; size: number; mimeType: string; content: string }>;
                  const attachLines = attachments.length > 0
                    ? `\nAttachments (${attachments.length}):\n` + attachments.map(a => `  [${a.filename}] ${(a.size / 1024).toFixed(1)}KB  ${a.mimeType}  url=${a.content}`).join('\n')
                    : '';
                  resolve([
                    `Issue: ${fetchKey}  (${f.issuetype?.name ?? ''})`,
                    `Status: ${f.status?.name ?? ''}`,
                    `Priority: ${f.priority?.name ?? ''}`,
                    `Reporter: ${f.reporter?.displayName ?? ''}`,
                    `Assignee: ${f.assignee?.displayName ?? '未指派'}`,
                    `Labels: ${(f.labels ?? []).join(', ') || '(none)'}`,
                    `Summary: ${f.summary ?? ''}`,
                    `Description:\n${String(f.description ?? '(empty)').substring(0, 2000)}`,
                    comments ? `\nLatest Comments:\n${comments}` : '',
                    attachLines
                  ].filter(Boolean).join('\n'));
                } catch { resolve(`無法解析 Jira API 回應: ${data.substring(0, 300)}`); }
              });
            });
            req.on('error', (e: Error) => resolve(`Jira fetch 錯誤: ${e.message}`));
            req.setTimeout(15000, () => { req.destroy(); resolve('Jira fetch 逾時 (15s)'); });
            req.end();
          } catch (e) { resolve(`jira_fetch 錯誤: ${e instanceof Error ? e.message : String(e)}`); }
        });
      }
      case 'jira_attachment_download': {
        const attachUrl = (args.url as string || '').trim();
        if (!attachUrl) return '請提供 url 參數（來自 jira_fetch 附件清單的 url= 欄位）';
        let rawFilename = (args.filename as string || '').trim();
        if (!rawFilename) {
          try { rawFilename = decodeURIComponent(path.basename(new URL(attachUrl).pathname)); } catch { rawFilename = 'attachment'; }
        }
        // Sanitize filename to prevent path traversal
        const safeFilename = rawFilename.replace(/[/\\:*?"<>|]/g, '_').replace(/^\.+/, '_');

        let dlAuthHeader: string;
        const atlasAuth3 = await this.getAtlascodeJiraAuth();
        if (atlasAuth3) {
          dlAuthHeader = `Bearer ${atlasAuth3.accessToken}`;
        } else {
          const jiraCfg3 = vscode.workspace.getConfiguration('amiAiClaw');
          const jiraEmail3 = jiraCfg3.get<string>('jiraEmail') ?? '';
          const jiraPat3 = jiraCfg3.get<string>('jiraPat') ?? '';
          if (!jiraPat3) return '找不到 Jira 認證，請確認 atlassian.atlascode 已登入';
          dlAuthHeader = jiraEmail3 ? 'Basic ' + Buffer.from(`${jiraEmail3}:${jiraPat3}`).toString('base64') : 'Bearer ' + jiraPat3;
        }

        const tmpDir = os.tmpdir();
        const outFile = path.join(tmpDir, safeFilename);

        const dlResult = await new Promise<{ ok: boolean; err?: string }>((resolve) => {
          try {
            const u = new URL(attachUrl);
            const proto = u.protocol === 'https:' ? https : http;
            const req = proto.request({
              hostname: u.hostname,
              port: u.port ? parseInt(u.port) : (u.protocol === 'https:' ? 443 : 80),
              path: u.pathname + u.search, method: 'GET',
              headers: { 'Authorization': dlAuthHeader },
            }, (res) => {
              if (res.statusCode !== 200) { res.resume(); resolve({ ok: false, err: `HTTP ${res.statusCode}` }); return; }
              const chunks: Buffer[] = [];
              res.on('data', (c: Buffer) => chunks.push(c));
              res.on('end', () => { try { fs.writeFileSync(outFile, Buffer.concat(chunks)); resolve({ ok: true }); } catch(e) { resolve({ ok: false, err: e instanceof Error ? e.message : String(e) }); } });
              res.on('error', (e: Error) => resolve({ ok: false, err: e.message }));
            });
            req.on('error', (e: Error) => resolve({ ok: false, err: e.message }));
            req.setTimeout(60000, () => { req.destroy(); resolve({ ok: false, err: '下載逾時 (60s)' }); });
            req.end();
          } catch (e) { resolve({ ok: false, err: e instanceof Error ? e.message : String(e) }); }
        });

        if (!dlResult.ok) return `附件下載失敗: ${dlResult.err}`;

        const ext = path.extname(safeFilename).toLowerCase();
        if (ext === '.zip') {
          const extractDir = outFile + '_extracted';
          try {
            if (fs.existsSync(extractDir)) { execSync(`rmdir /s /q "${extractDir}"`, { shell: 'cmd.exe', timeout: 10000, windowsHide: true }); }
            execSync(`powershell -NoProfile -Command "Expand-Archive -LiteralPath '${outFile}' -DestinationPath '${extractDir}' -Force"`, { timeout: 30000, windowsHide: true });
            const listFiles = (dir: string, base = ''): string[] => {
              const entries: string[] = [];
              try {
                for (const name of fs.readdirSync(dir)) {
                  const rel = base ? `${base}/${name}` : name;
                  const full = path.join(dir, name);
                  if (fs.statSync(full).isDirectory()) entries.push(...listFiles(full, rel));
                  else entries.push(rel);
                }
              } catch { /* ignore permission errors */ }
              return entries;
            };
            const files = listFiles(extractDir);
            const lines: string[] = [`📦 ${safeFilename} 解壓縮完成，共 ${files.length} 個檔案:\n`];
            lines.push(...files.slice(0, 80).map(f => `  ${f}`));
            if (files.length > 80) lines.push(`  … (共 ${files.length} 個)`);
            // Show contents of small text files
            const textExts = new Set(['.txt', '.log', '.md', '.json', '.xml', '.csv', '.ini', '.cfg', '.py', '.ts', '.js', '.sh', '.bat', '.diff', '.patch']);
            let shown = 0;
            for (const rel of files) {
              if (shown >= 5) break;
              if (!textExts.has(path.extname(rel).toLowerCase())) continue;
              const full = path.join(extractDir, rel);
              try {
                const stat = fs.statSync(full);
                if (stat.size > 60000) continue;
                const content = fs.readFileSync(full, 'utf-8');
                lines.push(`\n--- ${rel} ---\n${content.substring(0, 4000)}${content.length > 4000 ? '\n…（已截斷）' : ''}`);
                shown++;
              } catch { /* ignore */ }
            }
            lines.push(`\n解壓縮目錄: ${extractDir}`);
            return lines.join('\n');
          } catch (e) {
            return `ZIP 解壓縮失敗: ${e instanceof Error ? e.message : String(e)}\n檔案已存至: ${outFile}`;
          }
        } else {
          // Try reading as UTF-8 text
          try {
            const content = fs.readFileSync(outFile, 'utf-8');
            return `📄 ${safeFilename}\n\n${content.substring(0, 6000)}${content.length > 6000 ? '\n…（已截斷）' : ''}`;
          } catch {
            return `✅ ${safeFilename} 已下載至 ${outFile}（二進位檔案）`;
          }
        }
      }
      case 'jira_open': {
        const key = (args.issue_key as string || '').trim().toUpperCase();
        if (!key) return '請提供 issue_key，例如 BIOS-123';
        try {
          await vscode.commands.executeCommand('atlascode.jira.showIssueForKey', key);
          return `已開啟 Jira Issue: ${key}`;
        } catch (e) { return `無法開啟 Jira Issue: ${e instanceof Error ? e.message : String(e)}`; }
      }
      case 'jira_create': {
        try {
          await vscode.commands.executeCommand('atlascode.jira.createIssue', args.summary ? { summary: args.summary, description: args.description } : undefined);
          return '已開啟 Jira 建立 Issue 面板';
        } catch (e) { return `開啟失敗: ${e instanceof Error ? e.message : String(e)}`; }
      }
      case 'jira_transition': {
        const key = (args.issue_key as string || '').trim().toUpperCase();
        if (!key) return '請提供 issue_key';
        try {
          await vscode.commands.executeCommand('atlascode.jira.transitionIssue', { key });
          return `已開啟 ${key} 狀態轉換面板`;
        } catch (e) { return `失敗: ${e instanceof Error ? e.message : String(e)}`; }
      }
      case 'bb_create_pr': {
        try {
          await vscode.commands.executeCommand('atlascode.bb.createPullRequest');
          return '已開啟 Bitbucket 建立 Pull Request 面板';
        } catch (e) { return `失敗: ${e instanceof Error ? e.message : String(e)}`; }
      }
      case 'rovo_ask': {
        const question = (args.question as string || '').trim();
        if (!question) return '請提供 question 參數';
        // Try Rovo Dev local HTTP server first (returns actual AI response)
        try {
          const rovoResp = await this.callRovoDevApi(question);
          if (rovoResp) { return `[Rovo Dev 回覆]\n${rovoResp}`; }
        } catch { /* fall through */ }
        // Fallback: open interactive panel (no return value)
        try {
          await vscode.commands.executeCommand('atlascode.rovodev.askInteractive', question);
          return `已在 Rovo Dev 面板提問（無法直接取回回覆），請查看 Rovo Dev 面板。`;
        } catch (e) { return `失敗: ${e instanceof Error ? e.message : String(e)}`; }
      }
      case 'run_python': {
        const pyCode = (args.code as string || '').trim();
        if (!pyCode) return '請提供 code 參數';
        // Detect destructive operations to ask permission
        const isDestructive = /os\.remove|os\.rmdir|shutil\.rmtree|shutil\.move|open\s*\(.*['"]w['"]|open\s*\(.*['"]a['"]|Path.*\.unlink|Path.*\.rmdir|copyfile|shutil\.copy/i.test(pyCode);
        const rpCfg = vscode.workspace.getConfiguration('amiAiClaw');
        const rpSandbox = rpCfg.get<boolean>('sandboxUseDocker', false);
        if (isDestructive && !rpSandbox) {
          const descLine = (args.description as string || pyCode.split('\n')[0]).slice(0, 120);
          const allowed = await this.requestPermission('run', `Python（含檔案操作）: ${descLine}`, 'run_python');
          if (!allowed) return '使用者已拒絕執行操作';
        }
        if (rpSandbox) {
          const rpImg = rpCfg.get<string>('sandboxDockerImage', 'ubuntu:24.04');
          // 沙箱 Python 影像：少必 ubuntu:24.04 內建 python3，也可用 python:3.12-slim
          const rpPyImg = rpImg.includes('python') ? rpImg : 'python:3.12-slim';
          return await runDockerPython(pyCode, rpPyImg, 35000);
        }
        const tmpDir = os.tmpdir();
        const tmpFile = path.join(tmpDir, `ami_ai_claw_py_${Date.now()}.py`);
        try {
          fs.writeFileSync(tmpFile, pyCode, 'utf-8');
          return await new Promise<string>((resolve) => {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { exec } = require('child_process') as typeof import('child_process');
            const pythonCmds = process.platform === 'win32' ? ['py', 'python', 'python3'] : ['python3', 'python'];
            let tried = 0;
            const tryNext = () => {
              if (tried >= pythonCmds.length) { resolve('錯誤：找不到 Python 執行環境，請確認已安裝 Python 3'); return; }
              const cmd = pythonCmds[tried++];
              exec(`${cmd} "${tmpFile}"`, { cwd: wsRoot || process.cwd(), timeout: 30000 }, (_err, stdout, stderr) => {
                // Exit code non-zero is ok if there's output; only retry on ENOENT
                if (_err && (_err as NodeJS.ErrnoException).code === 'ENOENT') { tryNext(); return; }
                const out = (stdout || '') + (stderr ? (stdout ? '\n[stderr]\n' : '[stderr]\n') + stderr : '');
                resolve((out.trim() || '（無輸出）').slice(0, 8000));
              });
            };
            tryNext();
          });
        } finally {
          try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
        }
      }
      case 'git_status': {
        const gitRoot = (args.path as string) ? resolvePath(args.path as string) : (wsRoot || process.cwd());
        return await new Promise<string>((resolve) => {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { exec } = require('child_process') as typeof import('child_process');
          exec('git status', { cwd: gitRoot, timeout: 10000 }, (_err, stdout, stderr) => {
            resolve((stdout || stderr || '（無輸出）').trim().slice(0, 8000));
          });
        });
      }
      case 'git_diff': {
        const gitRoot2 = wsRoot || process.cwd();
        const diffFile = (args.file as string) || '';
        const diffStaged = (args.staged as boolean) ? '--cached ' : '';
        const diffCmd = ('git diff ' + diffStaged + diffFile).trim();
        return await new Promise<string>((resolve) => {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { exec } = require('child_process') as typeof import('child_process');
          exec(diffCmd, { cwd: gitRoot2, timeout: 15000 }, (_err, stdout, stderr) => {
            const out = (stdout || stderr || '').trim();
            resolve((out || '（無變更）').slice(0, 16000));
          });
        });
      }
      case 'git_log': {
        const gitRoot3 = wsRoot || process.cwd();
        const logCount = Math.min(Number(args.count || 20), 100);
        const logFile = (args.file as string) ? ('-- ' + args.file) : '';
        const logCmd = ('git log --oneline -' + logCount + ' ' + logFile).trim();
        return await new Promise<string>((resolve) => {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { exec } = require('child_process') as typeof import('child_process');
          exec(logCmd, { cwd: gitRoot3, timeout: 10000 }, (_err, stdout, stderr) => {
            resolve((stdout || stderr || '（無歷史）').trim().slice(0, 8000));
          });
        });
      }
      case 'git_commit': {
        const gitRoot4 = wsRoot || process.cwd();
        const commitMsg = ((args.message as string) || '').trim();
        if (!commitMsg) return '請提供 commit message';
        const addAll = (args.add_all as boolean) !== false;
        const allowed = await this.requestPermission('run', `Git Commit: ${commitMsg}`, 'git_commit');
        if (!allowed) return '使用者已拒絕 git commit 操作';
        const safeMsg = commitMsg.replace(/"/g, '\\"');
        const commitCmd = addAll ? `git add -A && git commit -m "${safeMsg}"` : `git commit -m "${safeMsg}"`;
        return await new Promise<string>((resolve) => {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { exec } = require('child_process') as typeof import('child_process');
          exec(commitCmd, { cwd: gitRoot4, timeout: 30000, shell: true as unknown as string }, (_err, stdout, stderr) => {
            const out = (stdout || '') + (stderr ? (stdout ? '\n[stderr]\n' : '[stderr]\n') + stderr : '');
            resolve((out.trim() || '（無輸出）').slice(0, 4000));
          });
        });
      }
      case 'http_request': {
        const reqMethod = ((args.method as string) || 'GET').toUpperCase();
        const reqUrl = (args.url as string || '').trim();
        if (!reqUrl) return '請提供 url 參數';
        const reqHeaders = (args.headers as Record<string, string>) || {};
        const reqBody = args.body ? String(args.body) : undefined;
        const reqTimeout = Number(args.timeout || 15000);
        if (reqMethod !== 'GET' && reqMethod !== 'HEAD') {
          const allowed = await this.requestPermission('run', `HTTP ${reqMethod}: ${reqUrl}`, 'http_request');
          if (!allowed) return '使用者已拒絕 HTTP 請求';
        }
        return new Promise<string>((resolve) => {
          let parsedUrl: URL;
          try { parsedUrl = new URL(reqUrl); } catch { resolve('無效的 URL'); return; }
          const protocol = parsedUrl.protocol === 'https:' ? https : http;
          const bodyBuf = reqBody ? Buffer.from(reqBody, 'utf8') : undefined;
          const options = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: reqMethod,
            headers: {
              'User-Agent': 'AMI-AiClaw-Agent/1.0',
              'Accept': 'application/json, text/plain, */*',
              ...(bodyBuf ? { 'Content-Type': 'application/json', 'Content-Length': bodyBuf.length } : {}),
              ...reqHeaders,
            },
          };
          let buf = '';
          const req = protocol.request(options, (res) => {
            res.setEncoding('utf8');
            res.on('data', (d: string) => { buf += d; if (buf.length > 100000) { res.destroy(); } });
            res.on('end', () => {
              const statusLine = `HTTP ${res.statusCode} ${res.statusMessage}`;
              const hdrs = Object.entries(res.headers).slice(0, 8).map(([k, v]) => `${k}: ${v}`).join('\n');
              resolve(`${statusLine}\n${hdrs}\n\n${buf.trim().slice(0, 8000)}`);
            });
            res.on('error', (e: Error) => resolve(`回應錯誤: ${e.message}`));
          });
          req.on('error', (e: Error) => resolve(`網路錯誤: ${e.message}`));
          req.setTimeout(reqTimeout, () => { req.destroy(); resolve(`超時 (${reqTimeout}ms)`); });
          if (bodyBuf) { req.write(bodyBuf); }
          req.end();
        });
      }
      case 'db_query': {
        const dbPath = resolvePath(args.db_path as string);
        const sqlQuery = (args.query as string || '').trim();
        if (!sqlQuery) return '請提供 query 參數';
        const sqlParams = args.params ? JSON.stringify(args.params) : '[]';
        const isWriteOp = /^\s*(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|ATTACH|DETACH)/i.test(sqlQuery);
        if (isWriteOp) {
          const allowed = await this.requestPermission('run', `SQLite 寫入: ${sqlQuery.slice(0, 80)}`, 'db_query');
          if (!allowed) return '使用者已拒絕資料庫寫入操作';
        }
        const pyCode = `import sqlite3, json, sys
db_path = ${JSON.stringify(dbPath)}
query = ${JSON.stringify(sqlQuery)}
params = json.loads(${JSON.stringify(sqlParams)})
try:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute(query, params)
    if cur.description:
        cols = [d[0] for d in cur.description]
        rows = [list(r) for r in cur.fetchmany(200)]
        col_widths = [max(len(str(c)), max((len(str(r[i])) for r in rows), default=0)) for i, c in enumerate(cols)]
        sep = '+' + '+'.join('-'*(w+2) for w in col_widths) + '+'
        header = '|' + '|'.join(f' {c:<{w}} ' for c, w in zip(cols, col_widths)) + '|'
        print(sep); print(header); print(sep)
        for row in rows: print('|' + '|'.join(f' {str(v):<{w}} ' for v, w in zip(row, col_widths)) + '|')
        print(sep)
        print(f'({len(rows)} rows)')
    else:
        conn.commit()
        print(f'OK, affected rows: {cur.rowcount}')
    conn.close()
except Exception as e:
    print(f'Error: {e}', file=sys.stderr)
`;
        const dbTmpFile = path.join(os.tmpdir(), `ami_ai_claw_py_${Date.now()}.py`);
        try {
          fs.writeFileSync(dbTmpFile, pyCode, 'utf-8');
          return await new Promise<string>((resolve) => {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { exec } = require('child_process') as typeof import('child_process');
            const pythonCmds = process.platform === 'win32' ? ['py', 'python', 'python3'] : ['python3', 'python'];
            let tried = 0;
            const tryNext = () => {
              if (tried >= pythonCmds.length) { resolve('錯誤：找不到 Python，無法執行 SQLite 查詢'); return; }
              const pcmd = pythonCmds[tried++];
              exec(`${pcmd} "${dbTmpFile}"`, { cwd: wsRoot || process.cwd(), timeout: 30000 }, (_err, stdout, stderr) => {
                if (_err && (_err as NodeJS.ErrnoException).code === 'ENOENT') { tryNext(); return; }
                const out = (stdout || '') + (stderr ? (stdout ? '\n[stderr]\n' : '[stderr]\n') + stderr : '');
                resolve((out.trim() || '（無輸出）').slice(0, 8000));
              });
            };
            tryNext();
          });
        } finally { try { fs.unlinkSync(dbTmpFile); } catch { /* ignore */ } }
      }
      case 'agentic_file_search': {
        const afQuery = ((args.query as string) ?? '').trim();
        if (!afQuery) return '請提供 query 參數';
        const afInclude = (args.include as string) || '**/*.{ts,js,tsx,jsx,py,cs,java,go,rs,cpp,c,h,vue,svelte}';
        const afTopK = Math.min(Math.max(Number(args.top_k) || 10, 1), 30);
        // 從 query 中抽取關鍵字（切 camelCase/snake_case，小寫，去掉停用詞）
        const afStopWords = new Set(['的','在','裡','中','使用','處理','負責','找出','哪個','檔案','函式','類別','實作','實現','相關','所有','一個','如何','為何','what','which','file','for','the','and','or','that','with','from','this','how','where','when']);
        const afKeywords = afQuery
          .replace(/([a-z])([A-Z])/g, '$1 $2') // camelCase
          .replace(/[_\-./]/g, ' ')
          .toLowerCase().split(/\s+/)
          .filter(w => w.length >= 2 && !afStopWords.has(w));
        const SKIP_BINARY = new Set(['.png','.jpg','.jpeg','.gif','.ico','.svg','.woff','.woff2','.ttf','.eot','.vsix','.zip','.tar','.gz','.exe','.dll','.pdf','.db','.sqlite','.lock','.wasm']);
        // 宣告抽取：函式/類別/介面/const/export
        const afDeclRe = /^(?:export\s+)?(?:(?:async\s+)?function\s+([\w$]+)|class\s+([\w$]+)|interface\s+([\w$]+)|type\s+([\w$]+)\s*=|(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[\w$]+)\s*=>|def\s+([\w_]+)|func\s+([\w_]+)|public\s+(?:static\s+)?(?:\w+\s+)?([\w_]+)\s*\()/m;
        const afDeclReLines = /^\s*(?:export\s+)?(?:(?:async\s+)?function\*?\s+([\w$]+)|class\s+([\w$]+)|interface\s+([\w$]+)|type\s+([\w$]+)\s*(?:<[^>]*>)?\s*=|(?:const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>|def\s+([\w_]+)|func\s+([\w_]+)\s*\(|public\s+(?:static\s+)?\S+\s+([\w_]+)\s*\()/;
        const afAllUris = await vscode.workspace.findFiles(afInclude, '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**,**/build/**}', 1000);
        const afScores: { rel: string; score: number; decls: string[] }[] = [];
        for (const uri of afAllUris) {
          const ext = path.extname(uri.fsPath).toLowerCase();
          if (SKIP_BINARY.has(ext)) continue;
          const rel = path.relative(wsRoot, uri.fsPath).replace(/\\/g, '/');
          // filename match
          const relLower = rel.toLowerCase();
          let score = afKeywords.reduce((s, kw) => s + (relLower.includes(kw) ? 3 : 0), 0);
          let decls: string[] = [];
          try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            const text = Buffer.from(bytes).toString('utf8').slice(0, 60000);
            const lines = text.split('\n');
            for (let li = 0; li < lines.length; li++) {
              const m2 = afDeclReLines.exec(lines[li]);
              if (m2) {
                const declName = m2.slice(1).find(Boolean) ?? '';
                if (declName) decls.push(`L${li+1} ${declName}`);
              }
            }
            // content keyword score
            const contentLower = text.toLowerCase();
            score += afKeywords.reduce((s, kw) => {
              const occurrences = (contentLower.match(new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
              return s + Math.min(occurrences, 5);
            }, 0);
            // bonus: declaration name matches keyword
            score += decls.reduce((s, d) => s + afKeywords.reduce((ss, kw) => ss + (d.toLowerCase().includes(kw) ? 4 : 0), 0), 0);
          } catch { /* skip binary */ }
          if (score > 0 || decls.length > 0) afScores.push({ rel, score, decls });
        }
        afScores.sort((a, b) => b.score - a.score);
        const afTop = afScores.slice(0, afTopK);
        if (afTop.length === 0) return `找不到與「${afQuery}」相關的檔案`;
        const afOut = afTop.map((f, i) => {
          const declStr = f.decls.length > 0
            ? `\n  宣告: ${f.decls.slice(0, 20).join(', ')}${f.decls.length > 20 ? ` …(+${f.decls.length-20})` : ''}`
            : '';
          return `${i+1}. ${f.rel} (相關度:${f.score})${declStr}`;
        }).join('\n');
        return `=== 語意搜尋「${afQuery}」結果 (前 ${afTop.length}/${afScores.length} 個相關檔案) ===\n${afOut}`;
      }
      case 'search_regex': {
        const pattern = (args.pattern as string || '').trim();
        if (!pattern) return '請提供 pattern 參數';
        const reFlags = ((args.flags as string) || 'i').replace(/[^gimu]/g, '');
        let regex: RegExp;
        try { regex = new RegExp(pattern, reFlags); } catch (e) { return `無效的正規表達式: ${e}`; }
        const includeGlob = (args.include as string) || '**/*';
        const allUris = await vscode.workspace.findFiles(includeGlob, '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**}', 500);
        const reMatches: string[] = [];
        for (const uri of allUris) {
          if (reMatches.length >= 100) break;
          try {
            const ext = path.extname(uri.fsPath).toLowerCase();
            if (['.png','.jpg','.jpeg','.ico','.vsix','.zip','.exe','.dll','.pdf','.wasm'].includes(ext)) continue;
            const bytes = await vscode.workspace.fs.readFile(uri);
            const text = Buffer.from(bytes).toString('utf8');
            const lines = text.split('\n');
            for (let li = 0; li < lines.length && reMatches.length < 100; li++) {
              if (regex.test(lines[li])) { reMatches.push(`${uri.fsPath}:${li + 1}: ${lines[li].trim().slice(0, 120)}`); }
            }
          } catch { /* skip binary */ }
        }
        return reMatches.length > 0
          ? `=== RegExp /${pattern}/${reFlags} 匹配 (${reMatches.length}) ===\n${reMatches.join('\n')}`
          : `找不到符合 /${pattern}/${reFlags} 的結果`;
      }
      case 'lint_fix': {
        const fixPath = resolvePath((args.path as string) || '.');
        const fixTool = (args.tool as string) || 'both';
        const lfAllowed = await this.requestPermission('run', `程式碼格式化: ${fixPath} (${fixTool})`, 'lint_fix');
        if (!lfAllowed) { return '使用者已拒絕程式碼格式化操作'; }
        const lfCwd = folders[0]?.uri.fsPath ?? process.cwd();
        const runFmt = (cmd: string) => new Promise<string>(res => {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { exec } = require('child_process') as typeof import('child_process');
          exec(cmd, { cwd: lfCwd, timeout: 30000 }, (_e, o, e) => res(((o || '') + (e ? '\n[stderr]\n' + e : '')).trim() || '(無輸出)'));
        });
        const lfResults: string[] = [];
        if (fixTool === 'eslint' || fixTool === 'both') { lfResults.push('[ESLint] ' + await runFmt(`npx eslint --fix "${fixPath}"`)); }
        if (fixTool === 'prettier' || fixTool === 'both') { lfResults.push('[Prettier] ' + await runFmt(`npx prettier --write "${fixPath}"`)); }
        return lfResults.join('\n\n') || '(無輸出)';
      }
      case 'run_tests': {
        const rtFilter = (args.filter as string) || '';
        const rtDir = (args.path as string) ? resolvePath(args.path as string) : (folders[0]?.uri.fsPath ?? process.cwd());
        const rtAllowed = await this.requestPermission('run', `執行測試${rtFilter ? ': ' + rtFilter : ''}`, 'run_tests');
        if (!rtAllowed) { return '使用者已拒絕執行測試'; }
        let rtRunner = 'npx jest --passWithNoTests';
        try {
          const rtPkgTxt = fs.readFileSync(path.join(folders[0]?.uri.fsPath ?? process.cwd(), 'package.json'), 'utf-8');
          const rtPkg = JSON.parse(rtPkgTxt) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string> };
          const rtDeps = { ...rtPkg.dependencies, ...rtPkg.devDependencies };
          const rtScripts = rtPkg.scripts ?? {};
          if (rtDeps['vitest'] || Object.values(rtScripts).some(s => s.includes('vitest'))) { rtRunner = 'npx vitest run'; }
          else if (rtDeps['mocha']) { rtRunner = 'npx mocha'; }
          else if (rtDeps['pytest'] || rtDeps['py.test']) { rtRunner = 'python -m pytest -v'; }
        } catch { /* use default */ }
        const rtFilterFlag = rtFilter
          ? (rtRunner.includes('vitest') || rtRunner.includes('jest') ? ` -t "${rtFilter}"` : rtRunner.includes('pytest') ? ` -k "${rtFilter}"` : '')
          : '';
        const rtCmd = `${rtRunner}${rtFilterFlag}`.trim();
        return await new Promise<string>(res => {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { exec } = require('child_process') as typeof import('child_process');
          exec(rtCmd, { cwd: rtDir, timeout: 60000 }, (_e, o, e) => {
            const out = ((o || '') + (e ? '\n[stderr]\n' + e : '')).trim();
            res(out.slice(0, 10000) || '(無輸出)');
          });
        });
      }
      case 'browser_navigate': {
        const bnUrl = (args.url as string || '').trim();
        if (!bnUrl) return '請提供 url 參數';
        const bnWaitFor = (args.wait_for as string) || 'networkidle';
        const bnSelector = (args.selector as string) || '';
        const bnTimeout = Math.min(Number(args.timeout_ms || 20000), 60000);
        const bnAllowed = await this.requestPermission('run', `瀏覽器訪問: ${bnUrl}`, 'browser_navigate');
        if (!bnAllowed) return '使用者已拒絕瀏覽器操作';
        const bnCfg = vscode.workspace.getConfiguration('amiAiClaw');
        const bnUseDocker = bnCfg.get<boolean>('browserUseDocker', false);
        const bnDockerImage = bnCfg.get<string>('browserDockerImage', 'mcr.microsoft.com/playwright/python:v1.49.0-jammy');
        const bnPyCore = [
          'import asyncio, json, sys',
          ...(bnUseDocker
            ? ['from playwright.async_api import async_playwright']
            : ['try:', '    from playwright.async_api import async_playwright',
               'except ImportError:',
               '    print(json.dumps({"error": "找不到 playwright，請執行: pip install playwright && playwright install chromium"}))',
               '    sys.exit(0)']),
          'async def main():',
          '    async with async_playwright() as p:',
          '        browser = await p.chromium.launch(headless=True)',
          '        page = await browser.new_page()',
          '        page.set_default_timeout(' + bnTimeout + ')',
          '        try:',
          '            await page.goto(' + JSON.stringify(bnUrl) + ', wait_until=' + JSON.stringify(bnWaitFor) + ', timeout=' + bnTimeout + ')',
          ...(bnSelector ? ['            await page.wait_for_selector(' + JSON.stringify(bnSelector) + ', timeout=10000)'] : []),
          '            title = await page.title()',
          '            current_url = page.url',
          '            try:',
          '                text = await page.inner_text("body")',
          '            except Exception:',
          '                text = await page.content()',
          '            links = await page.eval_on_selector_all("a[href]", "els => els.slice(0,20).map(e => ({text: e.innerText.trim(), href: e.href}))")',
          '            print(json.dumps({"title": title, "url": current_url, "text": text[:8000], "links": links}, ensure_ascii=False))',
          '        except Exception as e:',
          '            print(json.dumps({"error": str(e)}))',
          '        finally:',
          '            await browser.close()',
          'asyncio.run(main())',
        ].join('\n');
        const parseBnResult = (raw: string): string => {
          try {
            const j = JSON.parse(raw) as { error?: string; title?: string; url?: string; text?: string; links?: Array<{ text: string; href: string }> };
            if (j.error) return `瀏覽器錯誤: ${j.error}`;
            const linksStr = j.links && j.links.length > 0 ? '\n\n=== 連結 ===\n' + j.links.map(l => `[${l.text || '(no text)'}] ${l.href}`).join('\n') : '';
            return `標題: ${j.title}\n網址: ${j.url}\n\n=== 頁面文字 ===\n${j.text}${linksStr}`;
          } catch { return raw.slice(0, 8000) || '(無輸出)'; }
        };
        if (bnUseDocker) { return parseBnResult(await runDockerPython(bnPyCore, bnDockerImage, bnTimeout + 15000)); }
        const bnTmp = path.join(os.tmpdir(), `ami_browser_nav_${Date.now()}.py`);
        try {
          fs.writeFileSync(bnTmp, bnPyCore, 'utf-8');
          return await new Promise<string>(res => {
            const { exec } = require('child_process') as typeof import('child_process');
            const cmds = process.platform === 'win32' ? ['py', 'python', 'python3'] : ['python3', 'python'];
            let tried = 0;
            const tryNext = () => {
              if (tried >= cmds.length) { res('錯誤：找不到 Python'); return; }
              const pc = cmds[tried++];
              exec(`${pc} "${bnTmp}"`, { cwd: wsRoot || process.cwd(), timeout: bnTimeout + 10000 }, (_e, o, e) => {
                if (_e && (_e as NodeJS.ErrnoException).code === 'ENOENT') { tryNext(); return; }
                res(parseBnResult((o || e || '').trim()));
              });
            };
            tryNext();
          });
        } finally { try { fs.unlinkSync(bnTmp); } catch { /* ignore */ } }
      }
      case 'browser_screenshot': {
        const bsUrl = (args.url as string || '').trim();
        if (!bsUrl) return '請提供 url 參數';
        const bsOutRaw = (args.path as string || `screenshot_${Date.now()}.png`);
        const bsOut = path.isAbsolute(bsOutRaw) ? bsOutRaw : path.join(folders[0]?.uri.fsPath ?? process.cwd(), bsOutRaw);
        const bsSelector = (args.selector as string) || '';
        const bsAllowed = await this.requestPermission('write', `瀏覽器截圖: ${bsUrl} → ${bsOut}`, 'browser_screenshot');
        if (!bsAllowed) return '使用者已拒絕截圖操作';
        const bsCfg = vscode.workspace.getConfiguration('amiAiClaw');
        const bsUseDocker = bsCfg.get<boolean>('browserUseDocker', false);
        const bsDockerImage = bsCfg.get<string>('browserDockerImage', 'mcr.microsoft.com/playwright/python:v1.49.0-jammy');
        // Docker 模式：Python 輸出 base64 JSON（避免改容器路徑挂載問題）
        if (bsUseDocker) {
          const bsPyDocker = [
            'import asyncio, json, base64',
            'from playwright.async_api import async_playwright',
            'async def main():',
            '    async with async_playwright() as p:',
            '        browser = await p.chromium.launch(headless=True)',
            '        page = await browser.new_page(viewport={"width": 1280, "height": 800})',
            '        try:',
            '            await page.goto(' + JSON.stringify(bsUrl) + ', wait_until="networkidle", timeout=25000)',
            ...(bsSelector ? ['            await page.wait_for_selector(' + JSON.stringify(bsSelector) + ', timeout=10000)'] : []),
            '            target = page if not ' + JSON.stringify(bsSelector) + ' else await page.query_selector(' + JSON.stringify(bsSelector || 'body') + ')',
            '            data = await target.screenshot(full_page=True)',
            '            print(json.dumps({"ok": True, "b64": base64.b64encode(data).decode()}))',
            '        except Exception as e:',
            '            print(json.dumps({"error": str(e)}))',
            '        finally:',
            '            await browser.close()',
            'asyncio.run(main())',
          ].join('\n');
          const rawBs = await runDockerPython(bsPyDocker, bsDockerImage, 40000);
          try {
            const j = JSON.parse(rawBs) as { ok?: boolean; b64?: string; error?: string };
            if (j.error) return `截圖錯誤: ${j.error}`;
            if (j.b64) { fs.writeFileSync(bsOut, Buffer.from(j.b64, 'base64')); return `截圖已儲存: ${bsOut}`; }
          } catch { return rawBs || '(無輸出)'; }
        }
        // 本機模式：直接儲存檔案
        const bsPyLocal = [
          'import asyncio, json, sys',
          'try:',
          '    from playwright.async_api import async_playwright',
          'except ImportError:',
          '    print(json.dumps({"error": "找不到 playwright，請執行: pip install playwright && playwright install chromium"}))',
          '    sys.exit(0)',
          'async def main():',
          '    async with async_playwright() as p:',
          '        browser = await p.chromium.launch(headless=True)',
          '        page = await browser.new_page(viewport={"width": 1280, "height": 800})',
          '        try:',
          '            await page.goto(' + JSON.stringify(bsUrl) + ', wait_until="networkidle", timeout=20000)',
          ...(bsSelector ? ['            await page.wait_for_selector(' + JSON.stringify(bsSelector) + ', timeout=10000)'] : []),
          '            target = page if not ' + JSON.stringify(bsSelector) + ' else await page.query_selector(' + JSON.stringify(bsSelector || 'body') + ')',
          '            out_path = ' + JSON.stringify(bsOut),
          '            await target.screenshot(path=out_path, full_page=True)',
          '            print(json.dumps({"ok": True, "path": out_path}))',
          '        except Exception as e:',
          '            print(json.dumps({"error": str(e)}))',
          '        finally:',
          '            await browser.close()',
          'asyncio.run(main())',
        ].join('\n');
        const bsTmp = path.join(os.tmpdir(), `ami_browser_ss_${Date.now()}.py`);
        try {
          fs.writeFileSync(bsTmp, bsPyLocal, 'utf-8');
          return await new Promise<string>(res => {
            const { exec } = require('child_process') as typeof import('child_process');
            const cmds = process.platform === 'win32' ? ['py', 'python', 'python3'] : ['python3', 'python'];
            let tried = 0;
            const tryNext = () => {
              if (tried >= cmds.length) { res('錯誤：找不到 Python'); return; }
              const pc = cmds[tried++];
              exec(`${pc} "${bsTmp}"`, { cwd: wsRoot || process.cwd(), timeout: 35000 }, (_e, o, e) => {
                if (_e && (_e as NodeJS.ErrnoException).code === 'ENOENT') { tryNext(); return; }
                const raw = (o || e || '').trim();
                try {
                  const j = JSON.parse(raw) as { ok?: boolean; path?: string; error?: string };
                  if (j.error) { res(`截圖錯誤: ${j.error}`); return; }
                  res(`截圖已儲存: ${j.path}`);
                } catch { res(raw || '(無輸出)'); }
              });
            };
            tryNext();
          });
        } finally { try { fs.unlinkSync(bsTmp); } catch { /* ignore */ } }
      }
      case 'browser_script': {
        const bscCode = (args.script as string || '').trim();
        if (!bscCode) return '請提供 script 參數（Python playwright 程式碼）';
        const bscDesc = (args.description as string || bscCode.split('\n')[0]).slice(0, 120);
        const bscAllowed = await this.requestPermission('run', `瀏覽器腳本: ${bscDesc}`, 'browser_script');
        if (!bscAllowed) return '使用者已拒絕瀏覽器腳本執行';
        const bscCfg = vscode.workspace.getConfiguration('amiAiClaw');
        const bscUseDocker = bscCfg.get<boolean>('browserUseDocker', false);
        const bscDockerImage = bscCfg.get<string>('browserDockerImage', 'mcr.microsoft.com/playwright/python:v1.49.0-jammy');
        const bscFull = bscCode.includes('playwright') ? bscCode
          : 'from playwright.sync_api import sync_playwright\n' + bscCode;
        if (bscUseDocker) { return await runDockerPython(bscFull, bscDockerImage, 130000); }
        const bscTmp = path.join(os.tmpdir(), `ami_browser_script_${Date.now()}.py`);
        try {
          fs.writeFileSync(bscTmp, bscFull, 'utf-8');
          return await new Promise<string>(res => {
            const { exec } = require('child_process') as typeof import('child_process');
            const cmds = process.platform === 'win32' ? ['py', 'python', 'python3'] : ['python3', 'python'];
            let tried = 0;
            const tryNext = () => {
              if (tried >= cmds.length) { res('錯誤：找不到 Python'); return; }
              const pc = cmds[tried++];
              exec(`${pc} "${bscTmp}"`, { cwd: wsRoot || process.cwd(), timeout: 120000 }, (_e, o, e) => {
                if (_e && (_e as NodeJS.ErrnoException).code === 'ENOENT') { tryNext(); return; }
                const out = ((o || '') + (e ? '\n[stderr]\n' + e : '')).trim();
                res(out.slice(0, 10000) || '(無輸出)');
              });
            };
            tryNext();
          });
        } finally { try { fs.unlinkSync(bscTmp); } catch { /* ignore */ } }
      }
      case 'generate_docs': {
        const gdDocPath = (args.path as string) ? resolvePath(args.path as string) : (folders[0]?.uri.fsPath ?? process.cwd());
        const gdTool = (args.tool as string) || 'auto';
        const gdOutput = (args.output as string) || 'docs';
        const gdCwd = folders[0]?.uri.fsPath ?? process.cwd();
        const gdAllowed = await this.requestPermission('run', `產生 API 文件: ${gdDocPath} (${gdTool})`, 'generate_docs');
        if (!gdAllowed) { return '使用者已拒絕文件產生操作'; }
        let actualDocTool = gdTool;
        if (actualDocTool === 'auto') {
          try {
            const gdPkgTxt = fs.readFileSync(path.join(gdCwd, 'package.json'), 'utf-8');
            const gdPkg = JSON.parse(gdPkgTxt) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
            const gdDeps = { ...gdPkg.dependencies, ...gdPkg.devDependencies };
            if (gdDeps['typedoc']) { actualDocTool = 'typedoc'; }
            else if (gdDeps['jsdoc']) { actualDocTool = 'jsdoc'; }
            else if (fs.existsSync(path.join(gdCwd, 'typedoc.json')) || fs.existsSync(path.join(gdCwd, 'typedoc.config.js'))) { actualDocTool = 'typedoc'; }
            else if (fs.existsSync(path.join(gdCwd, '.jsdocrc')) || fs.existsSync(path.join(gdCwd, '.jsdocrc.js'))) { actualDocTool = 'jsdoc'; }
            else { actualDocTool = 'typedoc'; }
          } catch { actualDocTool = 'typedoc'; }
        }
        const gdCmd = actualDocTool === 'jsdoc'
          ? `npx jsdoc -d "${gdOutput}" -r "${gdDocPath}"`
          : `npx typedoc --out "${gdOutput}" "${gdDocPath}"`;
        return await new Promise<string>(res => {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { exec } = require('child_process') as typeof import('child_process');
          exec(gdCmd, { cwd: gdCwd, timeout: 60000 }, (_e, o, e) => {
            const out = ((o || '') + (e ? '\n[stderr]\n' + e : '')).trim();
            const outDir = path.join(gdCwd, gdOutput);
            const existsMsg = fs.existsSync(outDir) ? `\n\n✅ 文件已產生至: ${outDir}` : '';
            res((out.slice(0, 8000) || '(無輸出)') + existsMsg);
          });
        });
      }
      case 'refactor_suggest': {
        const rsFilePath = resolvePath(args.path as string);
        const rsFocus = (args.focus as string) || 'all';
        const rsAllowed = await this.requestPermission('read', `讀取並分析: ${rsFilePath}`, 'refactor_suggest');
        if (!rsAllowed) { return '使用者已拒絕程式碼分析'; }
        let rsContent: string;
        try {
          const rsStats = fs.statSync(rsFilePath);
          if (rsStats.size > 500 * 1024) { return '檔案超過 500KB，無法一次分析，請指定較小的檔案或特定函式'; }
          rsContent = fs.readFileSync(rsFilePath, 'utf-8');
        } catch (e) { return `讀取檔案失敗: ${e instanceof Error ? e.message : String(e)}`; }
        const rsCwd = folders[0]?.uri.fsPath ?? process.cwd();
        const rsTmpCfg = path.join(os.tmpdir(), `ami_eslint_rs_${Date.now()}.json`);
        const rsEslintCfg = { env: { browser: true, es2020: true, node: true }, rules: { complexity: ['warn', 10], 'max-lines-per-function': ['warn', 60], 'max-depth': ['warn', 4], 'max-params': ['warn', 5] } };
        fs.writeFileSync(rsTmpCfg, JSON.stringify(rsEslintCfg), 'utf-8');
        let rsEslintOut = '(跳過 ESLint 分析)';
        try {
          rsEslintOut = await new Promise<string>(res => {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { exec } = require('child_process') as typeof import('child_process');
            exec(`npx eslint --no-eslintrc -c "${rsTmpCfg}" --format compact "${rsFilePath}"`, { cwd: rsCwd, timeout: 20000 }, (_e, o, e) => {
              res(((o || '') + (e && !o ? '\n' + e : '')).trim().slice(0, 3000) || '✅ 無複雜度警告');
            });
          });
        } finally { try { fs.unlinkSync(rsTmpCfg); } catch { /* ignore */ } }
        const rsLines = rsContent.split('\n');
        const rsFocusNote = rsFocus !== 'all' ? `\n分析重點: ${rsFocus}` : '';
        const rsNumbered = rsLines.slice(0, 500).map((l, i) => `${String(i + 1).padStart(4)}: ${l}`).join('\n');
        const rsReport = [
          `=== 重構分析: ${rsFilePath} ===`,
          `行數: ${rsLines.length} | 字元數: ${rsContent.length}${rsFocusNote}`,
          '',
          '--- ESLint 複雜度/品質警告 ---',
          rsEslintOut,
          '',
          '--- 原始碼（含行號，供 AI 標記問題位置）---',
          rsNumbered,
          rsLines.length > 500 ? `\n...[省略 ${rsLines.length - 500} 行，請用 read_file 取得剩餘內容]` : ''
        ].join('\n');
        return rsReport.slice(0, 20000);
      }
      case 'whatsapp_send': {
        const waToCfg = vscode.workspace.getConfiguration('amiAiClaw');
        const waToken = waToCfg.get<string>('whatsappAccessToken', '').trim();
        const waPhoneId = waToCfg.get<string>('whatsappPhoneNumberId', '').trim();
        const waApiVer = waToCfg.get<string>('whatsappApiVersion', 'v20.0').trim();
        if (!waToken) return '請先在設定中配置 amiAiClaw.whatsappAccessToken（Meta WhatsApp Business 存取權斜殇）';
        if (!waPhoneId) return '請先在設定中配置 amiAiClaw.whatsappPhoneNumberId（Meta 商業管理平台 Phone Number ID）';
        const waTo = ((args.to as string) || '').replace(/[\s\-()]/g, '');
        if (!waTo) return '請提供收件人電話號碼（to），含國碼，例如 +886912345678';
        const waMsg = (args.message as string || '').trim();
        if (!waMsg) return '請提供訊息內容（message）';
        const waAllowed = await this.requestPermission('run', `發送 WhatsApp 訊息至 ${waTo}: ${waMsg.slice(0, 80)}`, 'whatsapp_send');
        if (!waAllowed) return '使用者已拒絕發送 WhatsApp 訊息';
        const waBody = JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: waTo,
          type: 'text',
          text: { preview_url: false, body: waMsg }
        });
        return new Promise<string>(resolve => {
          const waBuf = Buffer.from(waBody, 'utf8');
          const waOpts = {
            hostname: 'graph.facebook.com',
            port: 443,
            path: `/${waApiVer}/${waPhoneId}/messages`,
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${waToken}`,
              'Content-Type': 'application/json',
              'Content-Length': waBuf.length
            }
          };
          let waBufResp = '';
          const waReq = https.request(waOpts, res => {
            res.setEncoding('utf8');
            res.on('data', (d: string) => { waBufResp += d; });
            res.on('end', () => {
              try {
                const j = JSON.parse(waBufResp) as Record<string, unknown>;
                if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                  const msgs = j.messages as Array<{ id: string }> | undefined;
                  resolve(`✅ WhatsApp 訊息已發送成功至 ${waTo}${msgs?.[0]?.id ? ' (message_id: ' + msgs[0].id + ')' : ''}`);
                } else {
                  const err = j.error as Record<string, unknown> | undefined;
                  resolve(`發送失敗 HTTP ${res.statusCode}: ${err?.message ?? waBufResp.slice(0, 300)}`);
                }
              } catch { resolve(`HTTP ${res.statusCode} 回應解析失敗: ${waBufResp.slice(0, 300)}`); }
            });
          });
          waReq.on('error', (e: Error) => resolve(`網路錯誤: ${e.message}`));
          waReq.setTimeout(15000, () => { waReq.destroy(); resolve('超時 (15s)'); });
          waReq.write(waBuf);
          waReq.end();
        });
      }
      case 'whatsapp_send_template': {
        const wtCfg = vscode.workspace.getConfiguration('amiAiClaw');
        const wtToken = wtCfg.get<string>('whatsappAccessToken', '').trim();
        const wtPhoneId = wtCfg.get<string>('whatsappPhoneNumberId', '').trim();
        const wtApiVer = wtCfg.get<string>('whatsappApiVersion', 'v20.0').trim();
        if (!wtToken) return '請先在設定中配置 amiAiClaw.whatsappAccessToken';
        if (!wtPhoneId) return '請先在設定中配置 amiAiClaw.whatsappPhoneNumberId';
        const wtTo = ((args.to as string) || '').replace(/[\s\-()]/g, '');
        if (!wtTo) return '請提供收件人電話號碼（to）';
        const wtTpl = (args.template_name as string || '').trim();
        if (!wtTpl) return '請提供樣板名稱（template_name）';
        const wtLang = (args.language_code as string || 'zh_TW').trim();
        const wtParams = args.body_params as string[] | undefined;
        const wtAllowed = await this.requestPermission('run', `發送 WhatsApp 樣板 [${wtTpl}] 至 ${wtTo}`, 'whatsapp_send_template');
        if (!wtAllowed) return '使用者已拒絕發送 WhatsApp 樣板訊息';
        const wtBodyComp: Record<string, unknown>[] = [];
        if (wtParams && wtParams.length > 0) {
          wtBodyComp.push({ type: 'body', parameters: wtParams.map(v => ({ type: 'text', text: v })) });
        }
        const wtPayload: Record<string, unknown> = {
          messaging_product: 'whatsapp',
          to: wtTo,
          type: 'template',
          template: {
            name: wtTpl,
            language: { code: wtLang },
            ...(wtBodyComp.length > 0 ? { components: wtBodyComp } : {})
          }
        };
        return new Promise<string>(resolve => {
          const wtBuf = Buffer.from(JSON.stringify(wtPayload), 'utf8');
          const wtOpts = {
            hostname: 'graph.facebook.com',
            port: 443,
            path: `/${wtApiVer}/${wtPhoneId}/messages`,
            method: 'POST',
            headers: { 'Authorization': `Bearer ${wtToken}`, 'Content-Type': 'application/json', 'Content-Length': wtBuf.length }
          };
          let wtResp = '';
          const wtReq = https.request(wtOpts, res => {
            res.setEncoding('utf8');
            res.on('data', (d: string) => { wtResp += d; });
            res.on('end', () => {
              try {
                const j = JSON.parse(wtResp) as Record<string, unknown>;
                if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                  const msgs = j.messages as Array<{ id: string }> | undefined;
                  resolve(`✅ WhatsApp 樣板 [${wtTpl}] 已發送成功至 ${wtTo}${msgs?.[0]?.id ? ' (message_id: ' + msgs[0].id + ')' : ''}`);
                } else {
                  const err = j.error as Record<string, unknown> | undefined;
                  resolve(`發送失敗 HTTP ${res.statusCode}: ${err?.message ?? wtResp.slice(0, 300)}`);
                }
              } catch { resolve(`HTTP ${res.statusCode} 回應解析失敗: ${wtResp.slice(0, 300)}`); }
            });
          });
          wtReq.on('error', (e: Error) => resolve(`網路錯誤: ${e.message}`));
          wtReq.setTimeout(15000, () => { wtReq.destroy(); resolve('超時 (15s)'); });
          wtReq.write(wtBuf);
          wtReq.end();
        });
      }
      case 'jenkins_build': {
        const jbCfg = vscode.workspace.getConfiguration('amiAiClaw');
        const jbUrl = jbCfg.get<string>('jenkinsUrl', 'http://localdev.visualebios').replace(/\/+$/, '');
        const jbUser = jbCfg.get<string>('jenkinsUser', '').trim();
        const jbToken = jbCfg.get<string>('jenkinsToken', '').trim();
        const jbDefaultJob = jbCfg.get<string>('jenkinsDefaultJob', 'SeamlessBuild').trim();
        const jbJob = ((args.job as string) || jbDefaultJob).trim();
        const jbParams = args.params as Record<string, string> | undefined;
        const jbWait = args.wait !== false; // 預設等待 30s 驗收結果
        const jbAllowed = await this.requestPermission('run', `觸發 Jenkins 樣式: ${jbUrl}/job/${jbJob}${jbParams ? ' (' + JSON.stringify(jbParams).slice(0, 80) + ')' : ''}`, 'jenkins_build');
        if (!jbAllowed) return '使用者已拒絕 Jenkins Build';
        const jbAuth = (jbUser && jbToken) ? 'Basic ' + Buffer.from(`${jbUser}:${jbToken}`).toString('base64') : '';
        // 取得 CSRF Crumb
        const jbGetCrumb = (): Promise<{ field: string; value: string } | null> => new Promise(res => {
          const cu = new URL('/crumbIssuer/api/json', jbUrl);
          const isHttps = cu.protocol === 'https:';
          const proto = isHttps ? https : http;
          const crumbOpts = {
            hostname: cu.hostname, port: cu.port || (isHttps ? 443 : 80),
            path: cu.pathname, method: 'GET',
            headers: { 'Accept': 'application/json', ...(jbAuth ? { 'Authorization': jbAuth } : {}) }
          };
          let cb = ''; const cReq = proto.request(crumbOpts, r => {
            r.setEncoding('utf8'); r.on('data', (d: string) => { cb += d; });
            r.on('end', () => {
              try { const j = JSON.parse(cb) as Record<string, string>; res({ field: j.crumbRequestField, value: j.crumb }); }
              catch { res(null); }
            });
          });
          cReq.on('error', () => res(null)); cReq.setTimeout(5000, () => { cReq.destroy(); res(null); }); cReq.end();
        });
        // 發送 HTTP 請求的通用函數
        const jbHttp = (urlStr: string, method: string, postBody?: string, extraHdrs: Record<string, string> = {}): Promise<{ status: number; body: string; location?: string }> =>
          new Promise(res => {
            let pu: URL; try { pu = new URL(urlStr); } catch { res({ status: 0, body: '無效 URL: ' + urlStr }); return; }
            const isHttps = pu.protocol === 'https:';
            const proto = isHttps ? https : http;
            const bodyBuf = postBody ? Buffer.from(postBody, 'utf8') : undefined;
            const opts = {
              hostname: pu.hostname, port: pu.port || (isHttps ? 443 : 80),
              path: pu.pathname + pu.search, method,
              headers: {
                'Accept': 'application/json',
                ...(jbAuth ? { 'Authorization': jbAuth } : {}),
                ...(bodyBuf ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': bodyBuf.length } : {}),
                ...extraHdrs
              }
            };
            let rb = '';
            const req = proto.request(opts, r => {
              r.setEncoding('utf8'); r.on('data', (d: string) => { rb += d; });
              r.on('end', () => res({ status: r.statusCode ?? 0, body: rb, location: r.headers.location as string | undefined }));
            });
            req.on('error', (e: Error) => res({ status: 0, body: '網路錯誤: ' + e.message }));
            req.setTimeout(15000, () => { req.destroy(); res({ status: 0, body: '超時 (15s)' }); });
            if (bodyBuf) { req.write(bodyBuf); }
            req.end();
          });
        const crumb = await jbGetCrumb();
        const crumbHdr: Record<string, string> = crumb ? { [crumb.field]: crumb.value } : {};
        // 建立對應的觸發端點
        let jbTriggerPath: string;
        let jbPostBody: string | undefined;
        if (jbParams && Object.keys(jbParams).length > 0) {
          jbTriggerPath = `${jbUrl}/job/${encodeURIComponent(jbJob)}/buildWithParameters`;
          jbPostBody = Object.entries(jbParams).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
        } else {
          jbTriggerPath = `${jbUrl}/job/${encodeURIComponent(jbJob)}/build`;
        }
        const triggerResp = await jbHttp(jbTriggerPath, 'POST', jbPostBody, crumbHdr);
        if (triggerResp.status === 0) return `無法連線 Jenkins: ${triggerResp.body}`;
        if (triggerResp.status >= 400) return `Jenkins Build 觸發失敗 HTTP ${triggerResp.status}: ${triggerResp.body.slice(0, 300)}`;
        const queueUrl = triggerResp.location;
        let queueMsg = queueUrl ? `\n排隊位置: ${queueUrl}` : '';
        let buildNumber: number | null = null;
        // 如果要求等待，輪詢 queue item
        if (jbWait && queueUrl) {
          const jbPoll = async (): Promise<number | null> => {
            for (let i = 0; i < 12; i++) {
              await new Promise(r => setTimeout(r, 5000));
              const qa = queueUrl.replace(/\/?$/, '/api/json');
              const qr = await jbHttp(qa, 'GET');
              if (qr.status === 200) {
                try {
                  const qj = JSON.parse(qr.body) as Record<string, unknown>;
                  const ex = qj.executable as Record<string, unknown> | undefined;
                  if (ex?.number) { return ex.number as number; }
                } catch { /* continue polling */ }
              }
            }
            return null;
          };
          this._panel.webview.postMessage({ type: 'agentStep', icon: '⏳', title: `等待 Jenkins [${jbJob}] 第 one 次輪詢 Job 開始…`, fullPath: '' });
          buildNumber = await jbPoll();
          if (buildNumber) {
            const statusResp = await jbHttp(`${jbUrl}/job/${encodeURIComponent(jbJob)}/${buildNumber}/api/json`, 'GET');
            if (statusResp.status === 200) {
              try {
                const sj = JSON.parse(statusResp.body) as Record<string, unknown>;
                const result = (sj.result as string | null) ?? '進行中';
                const dur = sj.duration ? ` | 耗時: ${Math.round(Number(sj.duration) / 1000)}s` : '';
                queueMsg += `\n編號: #${buildNumber} | 狀態: ${result}${dur}`;
              } catch { /* ignore */ }
            }
          }
        }
        return `✅ Jenkins Build 已觸發: ${jbUrl}/job/${jbJob}${queueMsg}${buildNumber ? `\n建置詳情: ${jbUrl}/job/${encodeURIComponent(jbJob)}/${buildNumber}` : '\n提示: 可用 jenkins_status 工具查詢建置結果'}`;
      }
      case 'jenkins_status': {
        const jsCfg = vscode.workspace.getConfiguration('amiAiClaw');
        const jsUrl = jsCfg.get<string>('jenkinsUrl', 'http://localdev.visualebios').replace(/\/+$/, '');
        const jsUser = jsCfg.get<string>('jenkinsUser', '').trim();
        const jsToken = jsCfg.get<string>('jenkinsToken', '').trim();
        const jsDefaultJob = jsCfg.get<string>('jenkinsDefaultJob', 'SeamlessBuild').trim();
        const jsJob = ((args.job as string) || jsDefaultJob).trim();
        const jsBuildNum = args.build_number ? String(args.build_number) : 'lastBuild';
        const jsIncludeLog = args.include_log !== false;
        const jsLogLines = Math.min(Number(args.log_lines || 100), 500);
        const jsAuth = (jsUser && jsToken) ? 'Basic ' + Buffer.from(`${jsUser}:${jsToken}`).toString('base64') : '';
        const jsHttp = (urlStr: string): Promise<{ status: number; body: string }> =>
          new Promise(res => {
            let pu: URL; try { pu = new URL(urlStr); } catch { res({ status: 0, body: '無效 URL' }); return; }
            const isHttps = pu.protocol === 'https:';
            const proto = isHttps ? https : http;
            let rb = '';
            const req = proto.request({
              hostname: pu.hostname, port: pu.port || (isHttps ? 443 : 80),
              path: pu.pathname + pu.search, method: 'GET',
              headers: { 'Accept': 'application/json, text/plain, */*', ...(jsAuth ? { 'Authorization': jsAuth } : {}) }
            }, r => {
              r.setEncoding('utf8'); r.on('data', (d: string) => { rb += d; if (rb.length > 200000) r.destroy(); });
              r.on('end', () => res({ status: r.statusCode ?? 0, body: rb }));
            });
            req.on('error', (e: Error) => res({ status: 0, body: '網路錯誤: ' + e.message }));
            req.setTimeout(15000, () => { req.destroy(); res({ status: 0, body: '超時' }); });
            req.end();
          });
        const infoResp = await jsHttp(`${jsUrl}/job/${encodeURIComponent(jsJob)}/${jsBuildNum}/api/json`);
        if (infoResp.status === 0) return `無法連線 Jenkins: ${infoResp.body}`;
        if (infoResp.status === 404) return `建置不存在: ${jsUrl}/job/${jsJob}/${jsBuildNum}`;
        if (infoResp.status >= 400) return `Jenkins API 錯誤 HTTP ${infoResp.status}: ${infoResp.body.slice(0, 200)}`;
        let statusOut = '';
        try {
          const bj = JSON.parse(infoResp.body) as Record<string, unknown>;
          const result = (bj.result as string | null) ?? '進行中';
          const building = bj.building as boolean | undefined;
          const dur = bj.duration ? Math.round(Number(bj.duration) / 1000) + 's' : (bj.estimatedDuration ? '預估 ' + Math.round(Number(bj.estimatedDuration) / 1000) + 's' : 'N/A');
          const ts = bj.timestamp ? new Date(Number(bj.timestamp)).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }) : 'N/A';
          const causes = ((bj.actions as Array<Record<string, unknown>>) ?? []).flatMap(a => (a.causes as Array<Record<string, string>>) ?? []).map(c => c.shortDescription ?? c.userName ?? '').filter(Boolean).join(', ');
          statusOut = [
            `=== Jenkins Build: ${jsUrl}/job/${jsJob}/${bj.number ?? jsBuildNum} ===`,
            `狀態: ${building ? '⚙️ 建置中' : (result === 'SUCCESS' ? '✅ ' : result === 'FAILURE' ? '❌ ' : result === 'ABORTED' ? '⛔ ' : '⏳ ') + result}`,
            `起始時間: ${ts}  | 耗時: ${dur}`,
            causes ? `觸發原因: ${causes}` : '',
            `建置編號: #${bj.number ?? jsBuildNum}  | URL: ${bj.url ?? ''}`,
          ].filter(Boolean).join('\n');
        } catch {
          statusOut = `HTTP ${infoResp.status}: ${infoResp.body.slice(0, 500)}`;
        }
        let consoleOut = '';
        if (jsIncludeLog) {
          const logResp = await jsHttp(`${jsUrl}/job/${encodeURIComponent(jsJob)}/${jsBuildNum}/consoleText`);
          if (logResp.status === 200) {
            const lines = logResp.body.split('\n');
            const tail = lines.slice(-jsLogLines);
            consoleOut = '\n\n--- Console 輸出 (最後 ' + tail.length + ' 行) ---\n' + tail.join('\n').slice(0, 15000);
          } else {
            consoleOut = `\n(Console 輸出無法檢索 HTTP ${logResp.status})`;
          }
        }
        return statusOut + consoleOut;
      }
      default:
        return `未知工具: ${name}`;
    }
  }

  private async handleApplyToFile(code: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { vscode.window.showWarningMessage('沒有開啟的編輯器'); return; }
    const doc = editor.document;
    const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
    const lines = doc.getText().split('\n').length;
    if (lines > 50) {
      const ans = await vscode.window.showWarningMessage(
        `將替換 ${doc.fileName.split(/[\\/]/).pop()} (${lines} 行) 的全部內容，確定?`,
        '確定替換', '取消'
      );
      if (ans !== '確定替換') { return; }
    }
    await editor.edit(eb => eb.replace(fullRange, code));
    vscode.window.showInformationMessage('已套用到檔案');
  }

  private async fetchModelsFromServer(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('amiAiClaw');
    const ollamaUrls = getOllamaUrls(cfg);
    OllamaChatPanel.log('fetchModelsFromServer: ' + ollamaUrls.join(', '));
    const liveModels: { id: string; label: string }[] = [];
    let copilotModels: { id: string; name: string; multiplier: string }[] = [];
    let connOk2 = false;
    let connMsg2 = '連線失敗';
    let connUrl2 = ollamaUrls[0];
    for (const url of ollamaUrls) {
      try {
        const models = await ollamaListModels(url);
        for (const m of models) {
          liveModels.push({ id: encodeOllamaModelId(url, m, ollamaUrls), label: ollamaDisplayLabel(url, m, ollamaUrls) });
        }
        if (!connOk2) { connOk2 = true; connMsg2 = ollamaUrls.length > 1 ? `${ollamaUrls.length} 台伺服器已連線` : 'OK'; connUrl2 = url; }
        OllamaChatPanel.log('fetchModelsFromServer OK from ' + url);
      } catch (e: unknown) {
        const emsg = e instanceof Error ? e.message : String(e);
        if (!connOk2) { connMsg2 = emsg; connUrl2 = url; }
        OllamaChatPanel.log('fetchModelsFromServer error from ' + url + ': ' + emsg);
      }
    }
    try {
      const lms2 = await vscode.lm.selectChatModels({ vendor: 'copilot' });
      const seen2 = new Set<string>();
      for (const m of lms2) {
        if (!seen2.has(m.id)) { seen2.add(m.id); const n2 = (m.name || m.family).replace(/\s+\d+x\b|\s+x\d+\b/gi, '').trim(); copilotModels.push({ id: m.id, name: n2, multiplier: getCopilotMultiplier(m) }); }
      }
    } catch { /* Copilot not available */ }
    const current2 = cfg.get<string>('model') ?? liveModels[0]?.id ?? '';
    // 預熱模型（keep_alive=600s）：讓 Ollama 提前載入，減少第一次請求延遲
    if (current2 && !current2.startsWith('copilot::')) {
      const { url: warmUrl, model: warmModel } = decodeOllamaModel(current2, ollamaUrls);
      ollamaWarmupModel(warmUrl, warmModel);
      OllamaChatPanel.log(`Model warmup: ${warmModel} @ ${warmUrl}`);
    }
    const r1 = await this._panel.webview.postMessage({ type: 'modelList', models: liveModels, copilotModels, current: current2 });
    const r2 = await this._panel.webview.postMessage({ type: 'connectionStatus', ok: connOk2, url: connUrl2, message: connMsg2 });
    OllamaChatPanel.log('fetchModelsFromServer postMessage results: modelList=' + r1 + ' connectionStatus=' + r2);
  }

  private async testConnectionStatus(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('amiAiClaw');
    const baseUrl = cfg.get<string>('url') ?? 'http://localhost:11434';
    const result = await ollamaCheckConnection(baseUrl);
    this._panel.webview.postMessage({ type: 'connectionStatus', ok: result.ok, url: baseUrl, message: result.message });
  }
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  thinking?: string;
  tool_calls?: Array<{ id?: string; function: { name: string; arguments: Record<string, unknown> | string } }>;
  tool_call_id?: string;
}

const AGENT_TOOLS = [
  { type: 'function', function: { name: 'get_active_file', description: '取得目前編輯器開啟的檔案路徑與內容', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'read_file', description: '讀取工作區內的檔案內容', parameters: { type: 'object', properties: { path: { type: 'string', description: '相對或絕對路徑' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write_file', description: '寫入(建立/覆寫)檔案', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'replace_in_file', description: '在檔案中替換特定字串', parameters: { type: 'object', properties: { path: { type: 'string' }, old_str: { type: 'string', description: '要替換的原始字串' }, new_str: { type: 'string', description: '替換後的字串' } }, required: ['path', 'old_str', 'new_str'] } } },
  { type: 'function', function: { name: 'list_dir', description: '列出目錄內容', parameters: { type: 'object', properties: { path: { type: 'string', description: '目錄路徑，空白表示工作區根目錄' } }, required: [] } } },
  { type: 'function', function: { name: 'run_terminal', description: '在 VS Code 終端機執行命令（無輸出捕獲）', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'search_workspace', description: '在工作區中搜尋檔案名稱、函式名稱、類別名稱或程式碼關鍵字。處理任何問題前請優先呼叫此工具確認工作區現有程式碼', parameters: { type: 'object', properties: { query: { type: 'string', description: '搜尋關鍵字（如檔案名稱、函式名稱、類別名稱、變數名稱）' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'delete_file', description: '刪除檔案或目錄', parameters: { type: 'object', properties: { path: { type: 'string' }, recursive: { type: 'boolean', description: '是否遞迴刪除目錄' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'create_dir', description: '建立目錄（包含中間目錄）', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'run_command', description: '執行指令並回傳輸出結果（stdout+stderr）。適合需要知道執行結果的場合', parameters: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string', description: '執行目錄，空白表示工作區根目錄' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'fetch_url', description: '下載網頁內容（自動去除 HTML 標籤）。適合查閱文件、API 文件、搜尋網路資料', parameters: { type: 'object', properties: { url: { type: 'string', description: '完整 HTTP/HTTPS URL' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'open_browser', description: '在 VS Code 簡易瀏覽器中開啟網址', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'manage_todo', description: 'Agent 內部任務清單。複雜任務請先建立任務清單，逐一完成後標記为done', parameters: { type: 'object', properties: { action: { type: 'string', enum: ['add','done','list','clear'], description: 'add=新增, done=完成, list=查看, clear=清空' }, text: { type: 'string', description: '任務內容（action=add 時必須）' }, id: { type: 'number', description: '任務 ID（action=done 時必須）' } }, required: ['action'] } } },
  { type: 'function', function: { name: 'vscode_action', description: 'VS Code 操作：開啟檔案到指定行、取得工作區信息、顯示通知、執行 VS Code 內建指令', parameters: { type: 'object', properties: { action: { type: 'string', enum: ['open_file','get_workspace_info','show_notification','run_command'], description: 'open_file=開檔, get_workspace_info=工作區信息, show_notification=通知, run_command=執行内建指令' }, path: { type: 'string', description: 'open_file 用' }, line: { type: 'number', description: '開啟到哪一行' }, message: { type: 'string', description: 'show_notification 用' }, command: { type: 'string', description: 'run_command 用，VS Code 指令 ID' }, args: { type: 'array', items: { type: 'string' }, description: '指令參數' } }, required: ['action'] } } },
  { type: 'function', function: { name: 'jira_fetch', description: '【立即執行】直接呼叫 Jira REST API 取得 Issue 完整詳情（Summary、Description、Status、Assignee、Priority、最近留言、附件清單）供分析。看到 Jira Key 就呼叫，禁止先說「我將查詢」等意圖語句而不行動。', parameters: { type: 'object', properties: { issue_key: { type: 'string', description: 'Jira Issue Key，例如 UOEM2-3476' } }, required: ['issue_key'] } } },
  { type: 'function', function: { name: 'jira_attachment_download', description: '下載 Jira Issue 附件（URL 來自 jira_fetch 結果的 url= 欄位）。ZIP 檔案自動解壓縮並列出內容及文字檔內容；文字/patch/log 檔直接顯示。', parameters: { type: 'object', properties: { url: { type: 'string', description: '附件下載 URL（來自 jira_fetch 附件清單的 url= 後方網址）' }, filename: { type: 'string', description: '指定儲存檔名（可選，預設從 URL 推斷）' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'jira_open', description: '在 VS Code 中開啟 Jira Issue UI 面板（不回傳內容，純介面操作）。需要 Issue 內容供分析時請用 jira_fetch 而非此工具。', parameters: { type: 'object', properties: { issue_key: { type: 'string', description: 'Jira Issue Key，例如 BIOS-123 或 PROJ-456' } }, required: ['issue_key'] } } },
  { type: 'function', function: { name: 'jira_create', description: '開啟 Jira 建立 Issue 面板（需要安裝 Atlassian 插件）', parameters: { type: 'object', properties: { summary: { type: 'string', description: 'Issue 標題（可選，預填）' }, description: { type: 'string', description: 'Issue 詳細描述（可選，預填）' } } } } },
  { type: 'function', function: { name: 'jira_transition', description: '開啟 Jira Issue 狀態轉換面板（如 TODO → IN PROGRESS → DONE）', parameters: { type: 'object', properties: { issue_key: { type: 'string', description: 'Jira Issue Key' } }, required: ['issue_key'] } } },
  { type: 'function', function: { name: 'bb_create_pr', description: '開啟 Bitbucket 建立 Pull Request 面板（需要安裝 Atlassian 插件）', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'rovo_ask', description: '向 Atlassian Rovo Dev AI 提問並回傳回覆（需要 Rovo Dev 本地 server 正在執行）。可查詢 Jira/Confluence 知識庫、RCA 分析等。若 Rovo Dev 未執行則退化為開啟面板。', parameters: { type: 'object', properties: { question: { type: 'string', description: '要問 Rovo Dev 的問題' } }, required: ['question'] } } },
  { type: 'function', function: { name: 'run_python', description: '執行一段 Python 程式碼並回傳 stdout+stderr。支援所有 Python 標準模組（os、shutil、pathlib 等），可進行檔案刪除、複製、寫入、資料處理、數學計算等。程式碼中使用 print() 輸出結果。若需要寫入或刪除檔案，會先向使用者確認。', parameters: { type: 'object', properties: { code: { type: 'string', description: '要執行的 Python 程式碼（多行字串，支援 import）' }, description: { type: 'string', description: '一行說明這段程式碼的用途（顯示在步驟列）' } }, required: ['code'] } } },
  { type: 'function', function: { name: 'git_status', description: '取得工作區 Git 狀態（modified/staged/untracked 檔案列表）', parameters: { type: 'object', properties: { path: { type: 'string', description: '工作區路徑（可選，預設工作區根目錄）' } }, required: [] } } },
  { type: 'function', function: { name: 'git_diff', description: '取得 Git diff（工作區變更或 staged 變更）', parameters: { type: 'object', properties: { file: { type: 'string', description: '指定檔案路徑（可選，空白表示全部）' }, staged: { type: 'boolean', description: '是否顯示 staged diff（預設 false）' } }, required: [] } } },
  { type: 'function', function: { name: 'git_log', description: '取得 Git commit 歷史（oneline 格式）', parameters: { type: 'object', properties: { count: { type: 'number', description: '回傳筆數（預設 20，最多 100）' }, file: { type: 'string', description: '指定檔案的 commit 歷史（可選）' } }, required: [] } } },
  { type: 'function', function: { name: 'git_commit', description: '建立 Git commit（預設 git add -A 後 commit，需使用者確認）', parameters: { type: 'object', properties: { message: { type: 'string', description: 'Commit 訊息' }, add_all: { type: 'boolean', description: '是否 git add -A（預設 true）' } }, required: ['message'] } } },
  { type: 'function', function: { name: 'http_request', description: '發送 HTTP 請求（GET/POST/PUT/DELETE/PATCH）並回傳回應內容。適合呼叫 REST API、切換 Webhook、測試端點。非 GET 請求需使用者確認。', parameters: { type: 'object', properties: { method: { type: 'string', enum: ['GET','POST','PUT','DELETE','PATCH','HEAD'], description: 'HTTP 方法（預設 GET）' }, url: { type: 'string', description: '完整 HTTP/HTTPS URL' }, headers: { type: 'object', description: '自訂請求標頭（可選）', additionalProperties: { type: 'string' } }, body: { type: 'string', description: '請求本文（POST/PUT 用，JSON 字串或純文字）' }, timeout: { type: 'number', description: '超時毫秒（預設 15000）' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'db_query', description: '對 SQLite 資料庫執行 SQL 查詢（SELECT/INSERT/UPDATE/DELETE）並回傳結果表格。寫入操作需使用者確認。', parameters: { type: 'object', properties: { db_path: { type: 'string', description: 'SQLite 資料庫檔案路徑（.db 檔）' }, query: { type: 'string', description: '要執行的 SQL 語句' }, params: { type: 'array', items: {}, description: 'SQL 參數（防止 SQL injection，? 佔位符對應）' } }, required: ['db_path', 'query'] } } },
  { type: 'function', function: { name: 'search_regex', description: '使用正規表達式在工作區搜尋檔案內容。支援 glob 檔案樣式、大小寫、multiline 等 flag。', parameters: { type: 'object', properties: { pattern: { type: 'string', description: 'JavaScript 正規表達式字串（不包括 //）' }, include: { type: 'string', description: 'glob 檔案樣式（預設 **/*），如 **/*.ts' }, flags: { type: 'string', description: 'regex flags（預設 i，可用 g/i/m）' } }, required: ['pattern'] } } },
  { type: 'function', function: { name: 'agentic_file_search', description: '智慧語意搜尋：根據自然語言描述找出最相關的原始碼檔案，並回傳每個檔案的函式/類別/介面/匯出宣告摘要。適合「找處理 authentication 的檔案」、「哪個檔案負責 WebSocket 連線」等情況，比 search_workspace 更能理解功能意圖。', parameters: { type: 'object', properties: { query: { type: 'string', description: '用自然語言描述你要找的功能或責任，例如「處理使用者登入的邏輯」' }, include: { type: 'string', description: 'glob 檔案樣式（預設 **/*.{ts,js,tsx,jsx,py,cs,java,go,rs,cpp,c,h}）' }, top_k: { type: 'number', description: '回傳最相關的前 N 個檔案（預設 10，最多 30）' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'lint_fix', description: '對指定路徑的檔案或目錄執行 ESLint --fix 和/或 Prettier --write 修正程式碼風格問題', parameters: { type: 'object', properties: { path: { type: 'string', description: '要格式化的檔案或目錄路徑（可選，預設工作區根目錄）' }, tool: { type: 'string', enum: ['eslint', 'prettier', 'both'], description: '要執行的工具（預設 both）' } }, required: [] } } },
  { type: 'function', function: { name: 'run_tests', description: '執行專案測試套件（自動偵測 jest/vitest/mocha/pytest），回傳測試結果輸出', parameters: { type: 'object', properties: { path: { type: 'string', description: '測試目錄路徑（可選，預設工作區根目錄）' }, filter: { type: 'string', description: '測試名稱過濾（-t / -k pattern，可選）' } }, required: [] } } },
  { type: 'function', function: { name: 'browser_navigate', description: '使用 Playwright 無頭瀏覽器訪問網頁，回傳頁面標題、文字內容與連結清單。適合需要執行 JavaScript 的 SPA 或動態頁面（靜態頁面請用 fetch_url）。需要 Python playwright：pip install playwright && playwright install chromium', parameters: { type: 'object', properties: { url: { type: 'string', description: '完整 HTTP/HTTPS URL' }, selector: { type: 'string', description: '等待此 CSS selector 出現後再擷取內容（可選）' }, wait_for: { type: 'string', enum: ['load', 'networkidle', 'domcontentloaded'], description: '等待頁面事件（預設 networkidle）' }, timeout_ms: { type: 'number', description: '超時毫秒（預設 20000，最大 60000）' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'browser_screenshot', description: '使用 Playwright 無頭瀏覽器截取網頁截圖並儲存為 PNG 檔案。需要 Python playwright。', parameters: { type: 'object', properties: { url: { type: 'string', description: '完整 HTTP/HTTPS URL' }, path: { type: 'string', description: '輸出 PNG 檔案路徑（預設 screenshot_<ts>.png 存於工作區根目錄）' }, selector: { type: 'string', description: '只截取此 CSS selector 元素（可選，預設整頁）' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'browser_script', description: '執行 Python Playwright 自動化腳本（適合表單填寫、點擊、多步驟操作等複雜流程）。腳本中用 print() 輸出結果。需要 Python playwright。', parameters: { type: 'object', properties: { script: { type: 'string', description: 'Python playwright 腳本（sync_api），包含完整邏輯，用 print() 輸出結果' }, description: { type: 'string', description: '一行說明腳本用途（顯示在步驟列）' } }, required: ['script'] } } },
  { type: 'function', function: { name: 'generate_docs', description: '為專案或指定檔案自動產生 API 文件。自動偵測 TypeDoc（TypeScript）或 JSDoc（JavaScript），若都未安裝則嘗試 TypeDoc。', parameters: { type: 'object', properties: { path: { type: 'string', description: '要產生文件的原始碼檔案或目錄路徑（可選，預設工作區根目錄）' }, tool: { type: 'string', enum: ['auto', 'typedoc', 'jsdoc'], description: '文件工具（預設 auto，自動從 package.json 偵測）' }, output: { type: 'string', description: '輸出目錄名稱（預設 docs）' } }, required: [] } } },
  { type: 'function', function: { name: 'refactor_suggest', description: '讀取指定原始碼檔案，執行 ESLint 複雜度/品質分析，並回傳含行號的原始碼供 AI 提供重構建議。分析包含循環複雜度、函式長度、巢狀深度等指標。', parameters: { type: 'object', properties: { path: { type: 'string', description: '要分析的原始碼檔案路徑（必填）' }, focus: { type: 'string', enum: ['all', 'complexity', 'naming', 'duplication', 'solid'], description: '分析重點方向（預設 all，AI 會依此強調對應建議）' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'whatsapp_send', description: '透過 Meta WhatsApp Business Cloud API 發送文字訊息至指定手機號碼。適用於 24 小時內看過訊息的聯絡人。需要先在設定配置 whatsappAccessToken 和 whatsappPhoneNumberId。', parameters: { type: 'object', properties: { to: { type: 'string', description: '收件人手機號碼，必須含國碼，例如 +886912345678' }, message: { type: 'string', description: '要發送的文字訊息內容' } }, required: ['to', 'message'] } } },
  { type: 'function', function: { name: 'whatsapp_send_template', description: '透過 Meta WhatsApp Business Cloud API 發送已審核的樣板訊息。適用於初次聯絡或 24 小時窗口外的訊息（不受 24 小時限制）。需要先建立並審核樣板。', parameters: { type: 'object', properties: { to: { type: 'string', description: '收件人手機號碼，必須含國碼' }, template_name: { type: 'string', description: 'Meta 商業管理平台已審核的樣板名稱' }, language_code: { type: 'string', description: '樣板語言碼（預設 zh_TW，可選 en_US、zh_CN 等）' }, body_params: { type: 'array', items: { type: 'string' }, description: '樣板主體 {{1}} {{2}} 參數列表（可選）' } }, required: ['to', 'template_name'] } } },
  { type: 'function', function: { name: 'jenkins_build', description: '觸發 Jenkins 任動建置（Build）並回傳排隊 / 映射編號。依設定自動取得 CSRF Crumb。預設連接 localdev.visualebios 。', parameters: { type: 'object', properties: { job: { type: 'string', description: 'Jenkins Job 名稱（預設使用 amiAiClaw.jenkinsDefaultJob，未設定則 SeamlessBuild）' }, params: { type: 'object', description: 'Build 參數（key-value，可選），有參數自動使用 buildWithParameters 端點', additionalProperties: { type: 'string' } }, wait: { type: 'boolean', description: '是否等待 Job 開始建置並回傳編號/狀態（預設 true，最多等待 60s）' } }, required: [] } } },
  { type: 'function', function: { name: 'jenkins_status', description: '查詢 Jenkins Job 最新 Build 或指定 Build 編號的狀態及 Console 輸出。預設連接 localdev.visualebios 。', parameters: { type: 'object', properties: { job: { type: 'string', description: 'Jenkins Job 名稱（預設使用 amiAiClaw.jenkinsDefaultJob）' }, build_number: { type: 'number', description: 'Build 編號（可選，預設 lastBuild）' }, include_log: { type: 'boolean', description: '是否包含 Console 輸出（預設 true）' }, log_lines: { type: 'number', description: 'Console 輸出最後幾行（預設 100，最大 500）' } }, required: [] } } },
];

function getToolIcon(name: string): string {
  const m: Record<string, string> = { get_active_file: '📝', read_file: '📄', write_file: '💾', replace_in_file: '✏️', list_dir: '📁', run_terminal: '⚡', search_workspace: '🔍', delete_file: '🗑️', create_dir: '📂', run_command: '▶️', fetch_url: '🌐', open_browser: '💻', manage_todo: '📝', vscode_action: '🎨', jira_fetch: '📋', jira_open: '🎫', jira_create: '🎫', jira_transition: '🔄', jira_attachment_download: '📎', bb_create_pr: '🔀', rovo_ask: '🤖', run_python: '🐍', git_status: '📊', git_diff: '🔀', git_log: '📜', git_commit: '✅', http_request: '📡', db_query: '🗃️', search_regex: '🔎', agentic_file_search: '🧠', lint_fix: '🧹', run_tests: '🧪', browser_navigate: '🧭', browser_screenshot: '📸', browser_script: '🎭', generate_docs: '📚', refactor_suggest: '🔬', whatsapp_send: '💬', whatsapp_send_template: '📣', jenkins_build: '🛠️', jenkins_status: '📊' };
  return m[name] ?? '🔧';
}

function formatToolTitle(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'get_active_file': return '取得目前檔案';
    case 'read_file': return `讀取檔案: ${args.path}`;
    case 'write_file': return `寫入檔案: ${args.path}`;
    case 'replace_in_file': return `編輯檔案: ${args.path}`;
    case 'list_dir': return `列出目錄: ${args.path || '(根目錄)'}`;
    case 'run_terminal': return `執行命令: ${args.command}`;
    case 'search_workspace': return `搜尋工作區: ${args.query}`;
    case 'delete_file': return `刪除: ${args.path}`;
    case 'create_dir': return `建立目錄: ${args.path}`;
    case 'run_command': return `執行並捕獲輸出: ${args.command}`;
    case 'fetch_url': return `擷取網頁: ${args.url}`;
    case 'open_browser': return `開啟瀏覽器: ${args.url}`;
    case 'manage_todo': return `Todo (${args.action}${args.text ? ': ' + args.text : args.id ? ' #' + args.id : ''})`;
    case 'vscode_action': return `VS Code (${args.action}${args.path ? ': ' + args.path : args.command ? ': ' + args.command : ''})`;
    case 'jira_fetch': return `Jira 從 API 取得: ${args.issue_key}`;
    case 'jira_attachment_download': return `Jira 附件下載: ${(args.filename as string) || path.basename(String(args.url || '')).split('?')[0]}`;
    case 'jira_open': return `Jira 開啟 Issue: ${args.issue_key}`;
    case 'jira_create': return `Jira 建立 Issue${args.summary ? ': ' + args.summary : ''}`;
    case 'jira_transition': return `Jira 轉換狀態: ${args.issue_key}`;
    case 'bb_create_pr': return 'Bitbucket 建立 PR';
    case 'rovo_ask': return `Rovo Dev: ${args.question}`;
    case 'run_python': return `Python: ${(args.description as string) || (args.code as string || '').split('\n')[0].slice(0, 60)}`;
    case 'git_status': return `Git Status${args.path ? ': ' + args.path : ''}`;
    case 'git_diff': return `Git Diff${args.file ? ': ' + args.file : (args.staged ? ' (staged)' : '')}`;
    case 'git_log': return `Git Log (最近 ${args.count || 20} 筆${args.file ? ', ' + args.file : ''})`;
    case 'git_commit': return `Git Commit: ${args.message}`;
    case 'http_request': return `HTTP ${(args.method as string || 'GET').toUpperCase()}: ${args.url}`;
    case 'db_query': return `SQLite: ${(args.query as string || '').trim().slice(0, 60)}`;
    case 'search_regex': return `RegExp /${args.pattern}/${args.flags || 'i'}`;
    case 'agentic_file_search': return `語意搜尋: ${args.query}${args.include ? ' [' + args.include + ']' : ''}`;
    case 'lint_fix': return `程式碼格式化: ${args.path || '.'} (${args.tool || 'both'})`;
    case 'run_tests': return `執行測試${args.filter ? ': ' + args.filter : args.path ? ' @ ' + args.path : ''}`;
    case 'browser_navigate': return `瀏覽器訪問: ${args.url}`;
    case 'browser_screenshot': return `瀏覽器截圖: ${args.url}${args.path ? ' → ' + args.path : ''}`;
    case 'browser_script': return `Playwright: ${(args.description as string) || (args.script as string || '').split('\n')[0].slice(0, 60)}`;
    case 'generate_docs': return `產生 API 文件: ${args.path || '(工作區)'} [${args.tool || 'auto'}] → ${args.output || 'docs'}`;
    case 'refactor_suggest': return `重構分析: ${args.path}${args.focus && args.focus !== 'all' ? ' (' + args.focus + ')' : ''}`;
    case 'whatsapp_send': return `💬 WhatsApp 發送至 ${args.to}: ${(args.message as string || '').slice(0, 60)}`;
    case 'whatsapp_send_template': return `📣 WhatsApp 樣板 [${args.template_name}] 至 ${args.to}`;
    case 'jenkins_build': return `🛠️ Jenkins Build: ${args.job || '(default job)'}${args.params ? ' ' + JSON.stringify(args.params).slice(0, 50) : ''}`;
    case 'jenkins_status': return `📊 Jenkins 狀態: ${args.job || '(default job)'}${args.build_number ? ' #' + args.build_number : ' (lastBuild)'}`;
    default: return name;
  }
}

/** Docker 模式瀏覽器工具執行助手：透過 stdin 將 Python 程式碼傳送至容器，回傳 stdout。
 *  使用 `docker run --rm -i <image> python -` ，不需要挂載影約或在害端安裝 playwright。
 */
function runDockerPython(pyCode: string, dockerImage: string, timeoutMs: number): Promise<string> {
  return new Promise(res => {
    try {
      const { spawn } = require('child_process') as typeof import('child_process');
      const proc = spawn('docker', ['run', '--rm', '-i', '--network=host', dockerImage, 'python', '-']);
      let out = '', err = '';
      proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
      proc.stderr.on('data', (d: Buffer) => { err += d.toString(); });
      proc.on('close', () => {
        const combined = (out + (err ? '\n[stderr]\n' + err : '')).trim();
        res(combined.slice(0, 10000) || '(無輸出)');
      });
      proc.on('error', (e: Error) => res(`Docker 錯誤: ${e.message} — 請確認 Docker Desktop 正在執行`));
      const timer = setTimeout(() => { try { proc.kill(); } catch { /* noop */ } res('逾時 (' + timeoutMs + 'ms)'); }, timeoutMs);
      proc.on('close', () => clearTimeout(timer));
      proc.stdin.write(pyCode, 'utf-8');
      proc.stdin.end();
    } catch (e) {
      res(`Docker 執行失敗: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
}

/** 沙箱 Shell 執行助手：透過 `docker run --rm -i <image> sh -c "<cmd>"` 執行 shell 指令。
 *  容器沒有工作區檔案（純命令執行隔離）。
 */
function runDockerShell(cmd: string, dockerImage: string, timeoutMs: number): Promise<string> {
  return new Promise(res => {
    try {
      const { spawn } = require('child_process') as typeof import('child_process');
      const proc = spawn('docker', ['run', '--rm', '--network=host', dockerImage, 'sh', '-c', cmd]);
      let out = '', err = '';
      proc.stdout.on('data', (d: Buffer) => { out += d.toString(); if ((out + err).length > 512000) { try { proc.kill(); } catch { /* noop */ } } });
      proc.stderr.on('data', (d: Buffer) => { err += d.toString(); });
      proc.on('close', () => {
        const combined = (out + (err ? '\n[stderr]\n' + err : '')).trim();
        const r = combined.length > 10000 ? combined.slice(0, 10000) + '\n…（已截斷）' : combined || '(無輸出)';
        res(r);
      });
      proc.on('error', (e: Error) => res(`Docker 錯誤: ${e.message} — 請確認 Docker Desktop 正在執行且已拉取影像`));
      const timer = setTimeout(() => { try { proc.kill(); } catch { /* noop */ } res(`逾時 (${timeoutMs}ms)`); }, timeoutMs);
      proc.on('close', () => clearTimeout(timer));
    } catch (e) {
      res(`Docker 執行失敗: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
}

/** 過濾輸出文字中的敏感資訊（API key、token、密碼等），避免模型學習或外洩憑證。 */
function filterSensitiveInfo(text: string): string {
  return text
    // JWT tokens (Header.Payload.Signature)
    .replace(/eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{5,}\.[a-zA-Z0-9_-]{5,}/g, '[JWT_REDACTED]')
    // AWS access key IDs
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, '[AWS_KEY_REDACTED]')
    // PEM private key blocks
    .replace(/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g, '[PRIVATE_KEY_REDACTED]')
    // Authorization Bearer headers
    .replace(/(Authorization:\s*Bearer\s+)[A-Za-z0-9_\-.+/]{20,}/gi, '$1[REDACTED]')
    // GitHub personal access tokens
    .replace(/\bgh[pousr]_[a-zA-Z0-9]{36,}\b/g, '[GH_TOKEN_REDACTED]')
    // OpenAI / Anthropic / generic sk- API keys
    .replace(/\bsk-[a-zA-Z0-9]{20,}\b/g, '[API_KEY_REDACTED]')
    // Generic credential key=value or "key": "value" patterns
    .replace(/(["\'']?(?:api_?key|secret|password|passwd|token|access_?key|auth_?key|private_?key)["\'']?\s*[:=]\s*["\'']?)[A-Za-z0-9_\-.+/]{16,}(["\'']?)/gi, '$1[REDACTED]$2');
}

/** 估算文字的約略 token 數（CJK 字元每個約 1 token，ASCII 每 4 字元約 1 token）。 */
function estimateTokens(text: string): number {
  let count = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    count += code > 0x2E7F ? 1 : 0.25;  // CJK/special ≈ 1 token; ASCII ≈ 1/4 token
  }
  return Math.ceil(count);
}

/** 傳送 keep_alive=600 給 Ollama 以預熱（fire-and-forget），讓模型提前載入以減少首次請求延遲。 */
function ollamaWarmupModel(baseUrl: string, model: string): void {
  try {
    const url = new URL('/api/generate', baseUrl);
    const body = JSON.stringify({ model, prompt: '', keep_alive: 600 });
    const protocol = url.protocol === 'https:' ? https : http;
    const req = protocol.request({
      hostname: url.hostname,
      port: url.port ? parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 11434),
      path: url.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => { res.resume(); });
    req.on('error', () => {});
    req.setTimeout(30000, () => { req.destroy(); });
    req.write(body); req.end();
  } catch { /* ignore */ }
}

/** 傳送 keep_alive=0 給 Ollama 要求立即卸載模型（釋放 VRAM）。等待 Ollama 回應後 resolve。*/
function ollamaUnloadModel(baseUrl: string, model: string): Promise<void> {
  return new Promise(resolve => {
    try {
      const url = new URL('/api/generate', baseUrl);
      // prompt:'' must be present; keep_alive:0 tells Ollama to unload immediately
      const body = JSON.stringify({ model, prompt: '', keep_alive: 0 });
      const protocol = url.protocol === 'https:' ? https : http;
      const req = protocol.request({
        hostname: url.hostname,
        port: url.port ? parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 11434),
        path: url.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, res => { res.resume(); res.on('end', () => resolve()); res.on('error', () => resolve()); });
      req.on('error', () => resolve());
      req.setTimeout(30000, () => { req.destroy(); resolve(); });
      req.write(body); req.end();
    } catch { resolve(); }
  });
}

/** GET /api/ps → 傳回目前 Ollama 正在執行（已載入）的模型名稱清單。*/
function ollamaListRunningModels(baseUrl: string): Promise<string[]> {
  return new Promise(resolve => {
    try {
      const url = new URL('/api/ps', baseUrl);
      const protocol = url.protocol === 'https:' ? https : http;
      const req = protocol.request({
        hostname: url.hostname,
        port: url.port ? parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 11434),
        path: url.pathname, method: 'GET',
      }, res => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            const names = ((json.models ?? []) as { name: string }[]).map(m => m.name);
            resolve(names);
          } catch { resolve([]); }
        });
        res.on('error', () => resolve([]));
      });
      req.on('error', () => resolve([]));
      req.setTimeout(5000, () => { req.destroy(); resolve([]); });
      req.end();
    } catch { resolve([]); }
  });
}

function ollamaChatCall(baseUrl: string, model: string, messages: ChatMessage[], tools: unknown[]): Promise<ChatMessage> {
  return new Promise((resolve, reject) => {
    try {
      const url = new URL('/api/chat', baseUrl);
      const body = JSON.stringify({ model, messages, tools, stream: false, ...(supportsThinking(model) ? { think: true } : {}) });
      const protocol = url.protocol === 'https:' ? https : http;
      const options: http.RequestOptions = {
        hostname: url.hostname,
        port: url.port ? parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 11434),
        path: url.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      };
      const req = protocol.request(options, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`Ollama /api/chat 回傳 HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
            return;
          }
          try {
            const json = JSON.parse(data);
            const msg = json.message as ChatMessage & { thinking?: string };
            // Also extract <think>...</think> from content if no dedicated thinking field
            if (!msg.thinking && msg.content) {
              const m = (msg.content as string).match(/^<think>([\s\S]*?)<\/think>\s*/);
              if (m) { msg.thinking = m[1].trim(); msg.content = (msg.content as string).slice(m[0].length); }
            }
            resolve(msg);
          } catch { reject(new Error('無法解析 /api/chat 回應')); }
        });
      });
      req.on('error', (e: NodeJS.ErrnoException) => reject(ollamaConnectError(new URL(baseUrl).hostname, e)));
      req.setTimeout(600000, () => { req.destroy(new Error('Agent \u547c\u53eb\u903e\u6642 (600s)')); });
      req.write(body);
      req.end();
    } catch (e) { reject(e); }
  });
}

/** 串流版 /api/chat — 將 thinking 即時轉發給 onThinkChunk，累積回應後解析工具呼叫或文字回應 */
function ollamaChatCallStream(
  baseUrl: string, model: string, messages: ChatMessage[], tools: unknown[],
  onThinkChunk?: (chunk: string) => void,
  onTextChunk?: (chunk: string) => void,
  onStats?: (tokens: number, tps: number) => void
): Promise<ChatMessage> {
  return new Promise((resolve, reject) => {
    try {
      const url = new URL('/api/chat', baseUrl);
      const bodyObj: Record<string, unknown> = {
        model, messages, stream: true,
        ...(tools.length > 0 ? { tools } : {}),
        ...(supportsThinking(model) ? { think: true } : {})
      };
      const body = JSON.stringify(bodyObj);
      const protocol = url.protocol === 'https:' ? https : http;
      const options: http.RequestOptions = {
        hostname: url.hostname,
        port: url.port ? parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 11434),
        path: url.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      };
      let lineBuffer = '';
      let accContent = '';
      let accThinking = '';
      let finalToolCalls: unknown[] | undefined;
      const req = protocol.request(options, (res) => {
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          let errBody = '';
          res.setEncoding('utf8');
          res.on('data', (d: string) => { errBody += d; });
          res.on('end', () => {
            try { const j = JSON.parse(errBody); reject(new Error('Ollama 錯誤：' + (j.error ?? 'HTTP ' + res.statusCode))); }
            catch { reject(new Error('Ollama HTTP ' + res.statusCode)); }
          });
          return;
        }
        res.setEncoding('utf8');
        let streamError: string | null = null;
        res.on('data', (data: string) => {
          lineBuffer += data;
          const lines = lineBuffer.split('\n');
          lineBuffer = lines.pop() ?? '';
          for (const line of lines) {
            const t = line.trim(); if (!t) continue;
            try {
              const json = JSON.parse(t) as Record<string, unknown>;
              if (json.error) { streamError = json.error as string; return; }
              const msgFrag = json.message as (ChatMessage & { thinking?: string }) | undefined;
              if (msgFrag) {
                if (msgFrag.thinking) { accThinking += msgFrag.thinking; if (onThinkChunk) onThinkChunk(msgFrag.thinking); }
                if (msgFrag.content) { accContent += msgFrag.content; if (onTextChunk) onTextChunk(msgFrag.content); }
                if (msgFrag.tool_calls && Array.isArray(msgFrag.tool_calls) && msgFrag.tool_calls.length > 0) {
                  finalToolCalls = msgFrag.tool_calls;
                }
              }
              if (json.done) {
                const ec = json.eval_count as number | undefined;
                const ed = json.eval_duration as number | undefined;
                if (onStats && ec && ed && ed > 0) onStats(ec, ec / (ed / 1e9));
              }
            } catch { /* partial */ }
          }
        });
        res.on('end', () => {
          if (streamError) { reject(new Error('Ollama 錯誤：' + streamError)); return; }
          if (finalToolCalls && finalToolCalls.length > 0) {
            resolve({ role: 'assistant', content: accContent || null, tool_calls: finalToolCalls as ChatMessage['tool_calls'] });
          } else {
            // Extract <think> from content if no dedicated thinking field
            let content = accContent;
            if (!accThinking && content) {
              const m = content.match(/^<think>([\s\S]*?)<\/think>\s*/);
              if (m) { if (onThinkChunk) onThinkChunk(m[1].trim()); content = content.slice(m[0].length); }
            }
            resolve({ role: 'assistant', content: content || null, thinking: accThinking || undefined });
          }
        });
      });
      req.on('error', (e: NodeJS.ErrnoException) => reject(ollamaConnectError(new URL(baseUrl).hostname, e)));
      req.setTimeout(600000, () => { req.destroy(new Error('Agent 呼叫逾時 (600s)')); });
      req.write(body); req.end();
    } catch (e) { reject(e); }
  });
}

function getCopilotMultiplier(m: vscode.LanguageModelChat): string {
  const id = m.id.toLowerCase();
  const fam = (m.family || '').toLowerCase();
  if (id === 'auto' || fam === 'auto') return '10% off';
  if (id.includes('opus') || fam.includes('opus')) return '3x';
  if (id.includes('mini') || fam.includes('mini')) return '0x';
  if ((id.startsWith('gpt-4o') && !id.includes('mini')) || fam === 'gpt-4o' || id === 'gpt-4o') return '0x';
  return '1x';
}

function getCopilotMultiplierById(id: string): string {
  const i = id.toLowerCase();
  if (i === 'auto') { return '10% off'; }
  if (i.includes('opus')) { return '3x'; }
  if (i.includes('mini')) { return '0x'; }
  if (i.startsWith('gpt-4o') && !i.includes('mini')) { return '0x'; }
  return '1x';
}

async function copilotStreamText(
  modelId: string,
  messages: vscode.LanguageModelChatMessage[],
  onChunk: (c: string) => void,
  token: vscode.CancellationToken
): Promise<string> {
  const lms = await vscode.lm.selectChatModels({ id: modelId });
  const lm = lms[0];
  if (!lm) { throw new Error(`Copilot 找不到模型: ${modelId}`); }
  const response = await lm.sendRequest(messages, {}, token);
  let full = '';
  for await (const chunk of response.text) { full += chunk; onChunk(chunk); }
  return full;
}

async function copilotChatCallWithCts(
  modelId: string,
  messages: ChatMessage[],
  tools: unknown[]
): Promise<ChatMessage> {
  const lms = await vscode.lm.selectChatModels({ id: modelId });
  const lm = lms[0];
  if (!lm) { throw new Error(`Copilot 找不到模型: ${modelId}`); }

  // 正確轉換每種 role 為 VS Code LM API 對應的 Part 型別
  const vmMsgs: vscode.LanguageModelChatMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system' || m.role === 'user') {
      // system 沒有對應 role，以 User 訊息注入
      vmMsgs.push(vscode.LanguageModelChatMessage.User(m.content ?? ''));
    } else if (m.role === 'assistant') {
      // 助手訊息可能同時含文字與工具呼叫（Claude Sonnet tool-use 格式）
      const parts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[] = [];
      if (m.content) { parts.push(new vscode.LanguageModelTextPart(m.content)); }
      for (const tc of m.tool_calls ?? []) {
        const args = (typeof tc.function.arguments === 'string'
          ? JSON.parse(tc.function.arguments)
          : tc.function.arguments) as Record<string, unknown>;
        parts.push(new vscode.LanguageModelToolCallPart(tc.id ?? tc.function.name, tc.function.name, args));
      }
      if (parts.length === 0) { parts.push(new vscode.LanguageModelTextPart('')); }
      // 純文字時直接傳 string，避免不必要的 Part 包裝
      vmMsgs.push(parts.length === 1 && parts[0] instanceof vscode.LanguageModelTextPart
        ? vscode.LanguageModelChatMessage.Assistant(parts[0].value)
        : vscode.LanguageModelChatMessage.Assistant(parts));
    } else if (m.role === 'tool') {
      // 工具執行結果：用 LanguageModelToolResultPart，讓 Claude Sonnet 正確對應 tool_call_id
      vmMsgs.push(vscode.LanguageModelChatMessage.User([
        new vscode.LanguageModelToolResultPart(
          m.tool_call_id ?? '',
          [new vscode.LanguageModelTextPart(m.content ?? '')]
        )
      ]));
    }
  }

  type OllamaTool = { function: { name: string; description: string; parameters: object } };
  const vmTools = (tools as OllamaTool[]).map(t => ({
    name: t.function.name,
    description: t.function.description,
    inputSchema: t.function.parameters,
  }));
  const cts = new vscode.CancellationTokenSource();
  try {
    const response = await lm.sendRequest(vmMsgs, { tools: vmTools }, cts.token);
    let text = '';
    const toolCalls: NonNullable<ChatMessage['tool_calls']> = [];
    for await (const part of response.stream) {
      if (part instanceof vscode.LanguageModelTextPart) {
        text += part.value;
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        toolCalls.push({
          id: part.callId,
          function: {
            name: part.name,
            arguments: (typeof part.input === 'object' ? part.input : JSON.parse(String(part.input))) as Record<string, unknown>,
          },
        });
      }
    }
    return { role: 'assistant', content: text || null, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) };
  } finally {
    cts.dispose();
  }
}

function supportsThinking(model: string): boolean {
  if (model.toLowerCase().includes('hf.co/')) return true; // HuggingFace 模型通常是現代模型
  const m = model.toLowerCase().replace(/.*\//, ''); // strip hf.co/user/ prefix
  return m.startsWith('deepseek-r1') || m.startsWith('deepseek-r2') ||
    m.startsWith('qwq') || m.startsWith('qwen3') ||
    m.includes(':thinking') || m.includes('-thinking') ||
    m.includes('think') || m.includes('-r1') || m.includes(':r1') ||
    m.includes('r1-') || /^r1[:.-]/.test(m);
}

function ollamaGenerate(baseUrl: string, model: string, prompt: string): Promise<{ response: string; thinking?: string }> {
  return new Promise((resolve, reject) => {
    try {
      const url = new URL('/api/generate', baseUrl);
      const params: Record<string, unknown> = { model, prompt, stream: false };
      if (supportsThinking(model)) { params.think = true; }
      const body = JSON.stringify(params);
      const protocol = url.protocol === 'https:' ? https : http;

      const options: http.RequestOptions = {
        hostname: url.hostname,
        port: url.port ? parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 11434),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      };

      const req = protocol.request(options, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`Ollama returned HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
            return;
          }
          try {
            const json = JSON.parse(data);
            let response: string = (json.response as string) ?? data;
            let thinking: string | undefined = json.thinking as string | undefined;
            // fallback: extract <think>...</think> if model embeds it in response
            if (!thinking) {
              const m = /^<think>([\s\S]*?)<\/think>\s*/i.exec(response);
              if (m) { thinking = m[1]; response = response.slice(m[0].length); }
            }
            resolve({ response, thinking });
          } catch {
            resolve({ response: data });
          }
        });
      });
      req.on('error', (e) => reject(new Error(`無法連線到 Ollama (${baseUrl})：${e.message}`)));
      req.write(body);
      req.end();
    } catch (e) { reject(e); }
  });
}

const OLLAMA_RETRY_ERRORS = ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'socket hang up', '超時', 'timeout'];
function isRetryableOllamaError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return OLLAMA_RETRY_ERRORS.some(s => msg.toLowerCase().includes(s.toLowerCase()));
}
async function ollamaGenerateStreamWithRetry(
  baseUrl: string, model: string, prompt: string,
  onResponseChunk: (chunk: string) => void,
  onThinkChunk?: (chunk: string) => void,
  onRetry?: (attempt: number, waitSec: number, err: string) => void,
  maxRetries = 10,
  retrySec = 60,
  onStats?: (tokens: number, tps: number) => void
): Promise<string> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await ollamaGenerateStream(baseUrl, model, prompt, onResponseChunk, onThinkChunk, onStats);
    } catch (e) {
      if (attempt >= maxRetries || !isRetryableOllamaError(e)) throw e;
      const errMsg = e instanceof Error ? e.message : String(e);
      if (onRetry) onRetry(attempt + 1, retrySec, errMsg);
      await new Promise(r => setTimeout(r, retrySec * 1000));
    }
  }
  throw new Error('retry exhausted');
}

function ollamaGenerateStream(
  baseUrl: string, model: string, prompt: string,
  onResponseChunk: (chunk: string) => void,
  onThinkChunk?: (chunk: string) => void,
  onStats?: (tokens: number, tps: number) => void
): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      const url = new URL('/api/generate', baseUrl);
      const params: Record<string, unknown> = { model, prompt, stream: true };
      if (supportsThinking(model)) { params.think = true; }
      const body = JSON.stringify(params);
      const protocol = url.protocol === 'https:' ? https : http;

      const options: http.RequestOptions = {
        hostname: url.hostname,
        port: url.port ? parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 11434),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      };

      let lineBuffer = '';
      let fullResponse = '';
      let inThink = false;

      // Process a single response token, routing to think or response callbacks
      const processToken = (token: string) => {
        let rem = token;
        while (rem.length > 0) {
          if (!inThink) {
            const ts = rem.indexOf('<think>');
            if (ts === -1) { fullResponse += rem; onResponseChunk(rem); break; }
            if (ts > 0) { const b = rem.slice(0, ts); fullResponse += b; onResponseChunk(b); }
            inThink = true;
            rem = rem.slice(ts + 7);
          } else {
            const te = rem.indexOf('</think>');
            if (te === -1) { if (onThinkChunk) onThinkChunk(rem); break; }
            const tc = rem.slice(0, te);
            if (onThinkChunk && tc) onThinkChunk(tc);
            inThink = false;
            rem = rem.slice(te + 8);
          }
        }
      };

      const req = protocol.request(options, (res) => {
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          let errBody = '';
          res.setEncoding('utf8');
          res.on('data', (d: string) => { errBody += d; });
          res.on('end', () => {
            try { const j = JSON.parse(errBody); reject(new Error('Ollama 錯誤：' + (j.error ?? 'HTTP ' + res.statusCode))); }
            catch { reject(new Error('Ollama HTTP ' + res.statusCode)); }
          });
          return;
        }
        res.setEncoding('utf8');
        let streamError: string | null = null;
        res.on('data', (data: string) => {
          lineBuffer += data;
          const lines = lineBuffer.split('\n');
          lineBuffer = lines.pop() ?? '';
          for (const line of lines) {
            const t = line.trim();
            if (!t) continue;
            try {
              const json = JSON.parse(t);
              if (json.error) { streamError = json.error as string; return; }
              // dedicated thinking field (Ollama >= 0.9 with think models)
              if (json.thinking && onThinkChunk) onThinkChunk(json.thinking as string);
              if (json.response) processToken(json.response as string);
              if (json.done && onStats && typeof json.eval_count === 'number' && typeof json.eval_duration === 'number' && json.eval_duration > 0) {
                onStats(json.eval_count as number, (json.eval_count as number) / ((json.eval_duration as number) / 1e9));
              }
            } catch { /* partial or non-JSON line */ }
          }
        });
        res.on('end', () => {
          if (streamError) { reject(new Error('Ollama 錯誤：' + streamError)); return; }
          resolve(fullResponse);
        });
      });
      req.on('error', (e) => reject(new Error(`無法連線到 Ollama (${baseUrl})：${e.message}`)));
      req.write(body);
      req.end();
    } catch (e) { reject(e); }
  });
}

function ollamaChatStream(
  baseUrl: string, model: string, messages: ChatMessage[],
  onResponseChunk: (chunk: string) => void,
  onThinkChunk?: (chunk: string) => void,
  onStats?: (tokens: number, tps: number) => void
): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      const url = new URL('/api/chat', baseUrl);
      const params: Record<string, unknown> = { model, messages, stream: true };
      if (supportsThinking(model)) { params.think = true; }
      const body = JSON.stringify(params);
      const protocol = url.protocol === 'https:' ? https : http;
      const options: http.RequestOptions = {
        hostname: url.hostname,
        port: url.port ? parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 11434),
        path: url.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      };

      let lineBuffer = '';
      let fullResponse = '';
      let inThink = false;
      const processToken = (token: string) => {
        let rem = token;
        while (rem.length > 0) {
          if (!inThink) {
            const ts = rem.indexOf('<think>');
            if (ts === -1) { fullResponse += rem; onResponseChunk(rem); break; }
            if (ts > 0) { const b = rem.slice(0, ts); fullResponse += b; onResponseChunk(b); }
            inThink = true; rem = rem.slice(ts + 7);
          } else {
            const te = rem.indexOf('</think>');
            if (te === -1) { if (onThinkChunk) onThinkChunk(rem); break; }
            const tc = rem.slice(0, te);
            if (onThinkChunk && tc) onThinkChunk(tc);
            inThink = false; rem = rem.slice(te + 8);
          }
        }
      };

      const req = protocol.request(options, (res) => {
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          let errBody = '';
          res.setEncoding('utf8');
          res.on('data', (d: string) => { errBody += d; });
          res.on('end', () => {
            try { const j = JSON.parse(errBody); reject(new Error('Ollama 錯誤：' + (j.error ?? 'HTTP ' + res.statusCode))); }
            catch { reject(new Error('Ollama HTTP ' + res.statusCode)); }
          });
          return;
        }
        res.setEncoding('utf8');
        let streamError: string | null = null;
        res.on('data', (data: string) => {
          lineBuffer += data;
          const lines = lineBuffer.split('\n');
          lineBuffer = lines.pop() ?? '';
          for (const line of lines) {
            const t = line.trim(); if (!t) continue;
            try {
              const json = JSON.parse(t);
              if (json.error) { streamError = json.error as string; return; }
              // /api/chat stream format: json.message.thinking + json.message.content
              if (json.message?.thinking && onThinkChunk) onThinkChunk(json.message.thinking as string);
              if (json.message?.content) processToken(json.message.content as string);
              if (json.done && onStats && typeof json.eval_count === 'number' && typeof json.eval_duration === 'number' && json.eval_duration > 0) {
                onStats(json.eval_count as number, (json.eval_count as number) / ((json.eval_duration as number) / 1e9));
              }
            } catch { /* partial */ }
          }
        });
        res.on('end', () => {
          if (streamError) { reject(new Error('Ollama 錯誤：' + streamError)); return; }
          resolve(fullResponse);
        });
      });
      req.on('error', (e) => reject(new Error(`無法連線到 Ollama (${baseUrl})：${e.message}`)));
      req.write(body); req.end();
    } catch (e) { reject(e); }
  });
}

/** 讀取所有設定的 Ollama 伺服器 URL（amiAiClaw.urls）。 */
function getOllamaUrls(cfg: vscode.WorkspaceConfiguration): string[] {
  const arr = (cfg.get<string[]>('urls') ?? []).filter((u: string) => u.trim());
  if (arr.length > 0) {
    // 重複出現的 URL 視為停用：只保留恰好出現一次的 URL
    const count = new Map<string, number>();
    for (const u of arr) count.set(u, (count.get(u) ?? 0) + 1);
    const enabled = arr.filter(u => count.get(u) === 1);
    return enabled.length > 0 ? enabled : [];
  }
  return [cfg.get<string>('url') ?? 'http://localhost:11434'];
}

/** 解碼 Ollama model ID：多伺服器格式為 "http://host:port||modelname"，單伺服器為 "modelname"。 */
function decodeOllamaModel(modelId: string, fallbackUrls: string[]): { url: string; model: string } {
  const sep = modelId.indexOf('||');
  if (sep !== -1) return { url: modelId.slice(0, sep), model: modelId.slice(sep + 2) };
  return { url: fallbackUrls[0] ?? 'http://localhost:11434', model: modelId };
}

/** 編碼 Ollama model ID：多伺服器時加 URL 前綴，單伺服器時返回原始 model 名稱（向後相容）。 */
function encodeOllamaModelId(url: string, model: string, allUrls: string[]): string {
  return allUrls.length > 1 ? `${url}||${model}` : model;
}

/** 顯示標籤：多伺服器時加上 [hostname:port] 前綴。 */
function ollamaDisplayLabel(url: string, model: string, allUrls: string[]): string {
  if (allUrls.length <= 1) return model;
  try { const u = new URL(url); return `[${u.hostname}:${u.port || '11434'}] ${model}`; } catch { return model; }
}

function ollamaListModels(baseUrl: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    try {
      const url = new URL('/api/tags', baseUrl);
      const protocol = url.protocol === 'https:' ? https : http;
      const options: http.RequestOptions = {
        hostname: url.hostname,
        port: url.port ? parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 11434),
        path: url.pathname,
        method: 'GET',
      };
      const req = protocol.request(options, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); return; }
          try {
            const json = JSON.parse(data);
            const names: string[] = (json.models ?? []).map((m: { name: string }) => m.name).sort();
            resolve(names);
          } catch { reject(new Error('Invalid JSON from /api/tags')); }
        });
      });
      req.on('error', (e: NodeJS.ErrnoException) => reject(ollamaConnectError(url.hostname, e)));
      req.setTimeout(8000, () => { req.destroy(new Error('ETIMEDOUT')); });
      req.end();
    } catch (e) { reject(e); }
  });
}

function ollamaCheckConnection(baseUrl: string): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolve) => {
    try {
      const url = new URL('/api/tags', baseUrl);
      const protocol = url.protocol === 'https:' ? https : http;
      const options: http.RequestOptions = {
        hostname: url.hostname,
        port: url.port ? parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 11434),
        path: url.pathname,
        method: 'GET',
      };
      let settled = false;
      const req = protocol.request(options, (res) => {
        res.resume();
        if (!settled) {
          settled = true;
          resolve({ ok: res.statusCode === 200, message: res.statusCode === 200 ? 'OK' : 'HTTP ' + res.statusCode });
        }
      });
      req.on('error', (e: NodeJS.ErrnoException) => {
        if (!settled) { settled = true; resolve({ ok: false, message: ollamaConnectError(url.hostname, e).message }); }
      });
      req.setTimeout(8000, () => {
        if (!settled) { settled = true; req.destroy(); resolve({ ok: false, message: '連線逾時 (8s)，請確認主機 ' + url.hostname + ' 可達' }); }
      });
      req.end();
    } catch (e) { resolve({ ok: false, message: e instanceof Error ? e.message : String(e) }); }
  });
}

function ollamaConnectError(hostname: string, e: NodeJS.ErrnoException): Error {
  if (e.code === 'ENOTFOUND') {
    return new Error('主機名稱 \'' + hostname + '\' 無法解析（DNS），請確認 /etc/hosts 或 DNS 設定');
  }
  if (e.code === 'ECONNREFUSED') {
    return new Error('連線被拒絕（port 未開放），請確認 Ollama 伺服器已啟動：' + hostname + ':11434');
  }
  if (e.code === 'ETIMEDOUT' || e.message === 'ETIMEDOUT') {
    return new Error('連線逾時，請確認防火牆設定或主機 \'' + hostname + '\' 可達');
  }
  if (e.code === 'EHOSTUNREACH') {
    return new Error('無法到達主機 \'' + hostname + '\'，請確認網路路由設定');
  }
  return new Error((e.code ? e.code + ': ' : '') + e.message);
}

function getNonce(): string { return Math.random().toString(36).substring(2, 15); }
