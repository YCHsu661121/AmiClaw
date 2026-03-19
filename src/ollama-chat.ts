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
  public static readonly viewType = 'amiClaw.chat';
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
  /** 等待使用者確認的 pending promise resolve */
  private _pendingPermission: ((allow: boolean) => void) | null = null;
  /** 最後一次送出請求的 Ollama server URL + model（切換時需清 VRAM，但只在同一台 server）*/
  private _lastOllamaUrl = '';
  private _lastOllamaModel = '';
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  private _context!: vscode.ExtensionContext;
  private _chatHistories: Record<string, ChatMessage[]> = { default: [] };
  private _activeSessionId = 'default';
  private _chatHistory: ChatMessage[] = this._chatHistories.default;

  private static log(msg: string): void {
    if (!OllamaChatPanel._log) {
      OllamaChatPanel._log = vscode.window.createOutputChannel('AmiClaw');
    }
    OllamaChatPanel._log.appendLine(`[${new Date().toISOString()}] ${msg}`);
  }

  private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
    this._panel = panel;
    this._context = context;
    OllamaChatPanel.log('Constructor: start');
    vscode.window.showInformationMessage('AmiClaw: Extension activated');

    // Seed long-term memory with Atlassian rules (re-seed when version tag changes)
    const LTM_SEED_VER = 'atlassian-v3';
    const existingLtm = context.globalState.get<string>('amiClaw.longTermMemory') ?? '';
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
      context.globalState.update('amiClaw.longTermMemory', seeded);
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
            this.handleTeamSend(message.prompt, message.models).catch(() => {});
            break;
          case 'teamStop':
            this._teamCancel = true;
            break;
          case 'debateSend':
            this.switchChatSession(message.sessionId);
            this.handleDebateSend(message.prompt, message.models).catch(() => {});
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
            const cfg2 = vscode.workspace.getConfiguration('amiClaw');
            const persona2 = cfg2.get<string>('systemPrompt') ?? '';
            const previewMsgs = this._chatHistory.slice(-10);
            const historyPreview = previewMsgs.map(m => {
              const role = m.role === 'user' ? '👤 你' : '🤖 AI';
              const text = (m.content ?? '').slice(0, 200);
              return `${role}：${text}${(m.content ?? '').length > 200 ? '…' : ''}`;
            }).join('\n\n');
            this._panel.webview.postMessage({ type: 'memoryLoaded', ltm: this.getLongTermMemory(), persona: persona2, historyCount: this._chatHistory.length, historyPreview, sessionId: this._activeSessionId });
            break;
          }
          case 'memorySave':
            await this.saveLongTermMemory(message.ltm as string);
            this._panel.webview.postMessage({ type: 'memorySaved' });
            break;
          case 'memoryConsolidate':
            await this.handleMemoryConsolidate(message.sessionId);
            break;
          case 'openSettings':
            vscode.commands.executeCommand('workbench.action.openSettings', 'amiClaw.systemPrompt');
            break;
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
      const cfg = vscode.workspace.getConfiguration('amiClaw');
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

  public static createOrShow(context: vscode.ExtensionContext) {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (OllamaChatPanel.currentPanel) {
      OllamaChatPanel.currentPanel._panel.reveal(column, true);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      OllamaChatPanel.viewType,
      'AmiClaw',
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
    const cfg = vscode.workspace.getConfiguration('amiClaw');
    const defaultModel = cfg.get<string>('model') ?? '';
    const models = cfg.get<string[]>('models') ?? (defaultModel ? [defaultModel] : []);
    const optionsHtml = models.map(m => `<option value="${m}" ${m === defaultModel ? 'selected' : ''}>${m}</option>`).join('');

    return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>AmiClaw</title>
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
    </style>
  </head>
  <body>
    <div id="chat"></div>
    <div id="bottomBar">
      <div id="topBar">
        <select id="chatSessionSelect" aria-label="選擇聊天"></select>
        <button class="icon-btn" id="newChat" title="新增聊天">➕</button>
        <button class="icon-btn" id="renameChat" title="設定聊天標題">🏷️</button>
        <select id="modelSelect" aria-label="選擇模型">${optionsHtml}</select><span id="modelMultiplier" style="font-size:11px;opacity:0.65;padding:0 3px;white-space:nowrap"></span>
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
      <div id="teamPicker">
        <div id="teamPickerBar">
          <span style="font-size:11px;font-weight:700">&#x1F465; 選擇團隊成員（最多 5 個）</span>
          <button class="team-pick-mini-btn" id="teamPickerRefresh">&#x1F504;</button>
          <span style="flex:1"></span>
          <span id="teamPickerCount">0/5 已選</span>
        </div>
        <div id="teamPickerList"><span style="font-size:11px;opacity:0.6">載入中…</span></div>
      </div>
      <div id="debatePicker">
        <div id="debatePickerBar">
          <span style="font-size:11px;font-weight:700">&#x2694;&#xFE0F; 對話成員（2 個應戰，可加第 3 個裁判）</span>
          <button class="team-pick-mini-btn" id="debatePickerRefresh">&#x1F504;</button>
          <span style="flex:1"></span>
          <span id="debatePickerCount">0/3 已選</span>
        </div>
        <div id="debatePickerList"><span style="font-size:11px;opacity:0.6">載入中…</span></div>
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
          <textarea id="ltmArea" rows="5" placeholder="例如：- 用 Windows 11 + WSL2&#10;- 此專案用 TypeScript strict mode，將染色器用 VS Code，编譯器用 GCC 13，板子是 AMI Aptio V，它是基於 x64 UEFI。"></textarea>
          <div class="mem-row">
            <button class="mem-btn primary" id="saveLtmBtn">&#x1F4BE; 儲存長期記憶</button>
            <button class="mem-btn" id="clearLtmBtn">&#x1F5D1; 清除長期記憶</button>
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
      </div>
    </div>
    <script nonce="${nonce}">
      window.onerror = function(msg, src, line, col) { var ep = document.getElementById('debugPanel'); if (ep) ep.textContent += 'ERR:' + msg + ' L' + line + ':' + col + '\\n'; };
    </script>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();

      // ── Debug Console ──────
      window._debugLog = [];
      function dbg(msg) { var t = new Date().toISOString().slice(11,23); window._debugLog.push(t + ' ' + msg); var dp = document.getElementById('debugPanel'); if (dp && dp.style.display !== 'none') { dp.textContent = window._debugLog.slice(-10).join('\\n'); } }
      dbg('webview init start');
      var debugPanel = document.createElement('pre');
      debugPanel.id = 'debugPanel';
      debugPanel.style.cssText = 'display:none;position:fixed;top:0;left:0;right:0;z-index:9999;background:rgba(0,0,0,0.85);color:#0f0;font-size:11px;padding:6px 10px;overflow:hidden;white-space:pre-wrap;font-family:Consolas,monospace;max-height:160px;border-bottom:1px solid #0f0;';
      document.body.appendChild(debugPanel);
      window.onerror = function(msg, src, line, col) { dbg('ERROR: ' + msg + ' at line ' + line + ':' + col); return false; };

      // ── 訊息處理 (最先掛上，避免後續程式碼拋例外導致 listener 遺失) ──────
      window.addEventListener('message', function(event) {
        try {
          const msg = event.data;
          dbg('MSG: ' + msg.type + (msg.ok !== undefined ? ' ok=' + msg.ok : '') + (msg.url ? ' url=' + msg.url : '') + (msg.message ? ' msg=' + msg.message : ''));
          if (debugPanel.style.display === 'block') { debugPanel.textContent = window._debugLog.join('\\n'); debugPanel.scrollTop = debugPanel.scrollHeight; }
          if (msg.type === 'assistant')          { clearPendingBubble(); _agentStepNode = null; _streamNode = null; setSendEnabled(true); appendMessage('assistant', msg.text, msg.thinking); }
          else if (msg.type === 'streamStart')   { clearPendingBubble(); _streamNode = null; }
          else if (msg.type === 'thinkChunk')    { appendThinkChunk(msg.chunk); }
          else if (msg.type === 'assistantChunk'){ appendChunk(msg.chunk); }
          else if (msg.type === 'streamEnd')     { _agentStepNode = null; _streamNode = null; setSendEnabled(true); }
          else if (msg.type === 'streamStats')   { var _sb = _streamNode && chat.contains(_streamNode) ? _streamNode.querySelector('.bubble') : null; if (_sb) { var _det = _sb.querySelector('details.think'); if (_det) { var _lbl = _det.querySelector('.think-label'); var _secs = _det._thinkEnd ? Math.round((_det._thinkEnd - (_det._thinkStart||_det._thinkEnd)) / 1000) : 0; if (_lbl) _lbl.textContent = '\u{1F9E0} \u601d\u8003\u904e\u7a0b (' + msg.tokens + ' tokens, \u8017\u6642 ' + _secs + 's, ' + msg.tps.toFixed(1) + ' t/s)'; } } }
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
          else if (msg.type === 'debateStart')   { createDebateHeader(msg.labelA, msg.labelB, msg.labelJ, msg.colorA, msg.colorB, msg.colorJ); }
          else if (msg.type === 'debateTurnStart') { startDebateTurn(msg.speaker, msg.round); }
          else if (msg.type === 'debateChunk')   { appendDebateChunk(msg.speaker, msg.chunk); }
          else if (msg.type === 'debateThinkChunk') { appendDebateThinkChunk(msg.speaker, msg.chunk); }
          else if (msg.type === 'debateTurnEnd') { finalizeDebateTurn(msg.speaker, msg.tokens, msg.tps); }
          else if (msg.type === 'debateEnd')     { finalizeDebate(msg.consensus); setSendEnabled(true); if (statusBar) statusBar.textContent = '\u2694\ufe0f \u5c0d\u8a71\u7d50\u675f'; }
          else if (msg.type === 'agentStatus')   {
            if (statusBar) statusBar.textContent = msg.running ? '\u2699\ufe0f Agent \u57f7\u884c\u4e2d\u2026' : (agentMode ? '\ud83e\udd16 Agent \u6a21\u5f0f' : '');
            setSendEnabled(!msg.running);
          }
          else if (msg.type === 'agentStep')     { appendAgentStep(msg.icon, msg.title, msg.fullPath); }
          else if (msg.type === 'agentStepDone') { finalizeAgentStep(msg.result, msg.isError); }
          else if (msg.type === 'permissionRequest') { showPermissionBar(msg.category, msg.description); }
          else if (msg.type === 'autoStatus')    { if (statusBar) statusBar.textContent = msg.running ? '\u23f3 \u81ea\u52d5\u57f7\u884c\u4e2d\u2026' : ''; setSendEnabled(!msg.running); }
          else if (msg.type === 'autoPaused')    { appendMessage('assistant', '\u5df2\u6682\u505c\uff0c\u9700\u5b58\u53d6 ' + (msg.path || '\u672a\u77e5\u8def\u5f91')); if (statusBar) statusBar.textContent = '\u23f8 \u6682\u505c'; }
          else if (msg.type === 'streamMode')    { const t = document.getElementById('toggleStream'); if (t) t.classList.toggle('active', msg.enabled); }
          else if (msg.type === 'modelList')     { dbg('modelList received: ' + (msg.models||[]).length + ' ollama + ' + (msg.copilotModels||[]).length + ' copilot'); updateModelSelect(msg.models, msg.current, msg.copilotModels); var _pickerModels = []; (msg.models||[]).forEach(function(m) { var id = (typeof m === 'string') ? m : m.id; var label = (typeof m === 'string') ? m : m.label; _pickerModels.push({ id: id, label: label, vendor: 'ollama' }); }); (msg.copilotModels||[]).forEach(function(cm) { _pickerModels.push({ id: 'copilot::' + cm.id, label: cm.name, vendor: 'copilot', multiplier: cm.multiplier || '' }); }); if (_pickerModels.length) { populateTeamPicker(_pickerModels); populateDebatePicker(_pickerModels); } }
          else if (msg.type === 'connectionStatus') { dbg('connectionStatus received ok=' + msg.ok + ' url=' + msg.url); updateConnStatus(msg.ok, msg.url, msg.message); }
          else if (msg.type === 'fileAttached')  { addFileChip(msg.name, msg.content); }
          else if (msg.type === 'memoryLoaded')  { onMemoryLoaded(msg); }
          else if (msg.type === 'memorySaved')   { var slb = document.getElementById('saveLtmBtn'); if (slb) { slb.textContent = '\u2713 \u5df2\u5132\u5b58'; setTimeout(function() { slb.textContent = '\uD83D\uDCBE \u5132\u5b58\u9577\u671f\u8a18\u61b6'; }, 1500); } }
          else if (msg.type === 'historyCount')  { if (!msg.sessionId || msg.sessionId === _activeChatSessionId) { var hii = document.getElementById('historyInfo'); if (hii) hii.textContent = '\u5c0d\u8a71\u6b77\u53f2\uff1a' + (msg.count || 0) + ' \u689d\u8a0a\u606f'; } }
          else if (msg.type === 'consolidateStart') { var cs = document.getElementById('consolidateStatus'); if (cs) { cs.style.display = ''; cs.textContent = '\u2699\ufe0f AI \u6574\u7406\u4e2d\u2026'; } var clb = document.getElementById('consolidateLtmBtn'); if (clb) clb.disabled = true; }
          else if (msg.type === 'consolidateChunk') { var cs2 = document.getElementById('consolidateStatus'); if (cs2) cs2.textContent = '\u2699\ufe0f AI \u6574\u7406\u4e2d\u2026 ' + (msg.chunk || '').slice(0, 40); }
          else if (msg.type === 'consolidateDone') {
            var clb2 = document.getElementById('consolidateLtmBtn'); if (clb2) clb2.disabled = false;
            var cs3 = document.getElementById('consolidateStatus');
            if (msg.error) { if (cs3) { cs3.style.display = ''; cs3.textContent = '\u274c \u6574\u7406\u5931\u6557\uff1a' + msg.error; } }
            else if (msg.skipped) { if (cs3) { cs3.style.display = ''; cs3.textContent = '\u26a0\ufe0f \u5c0d\u8a71\u6b77\u53f2\u70ba\u7a7a\uff0c\u7121\u9700\u6574\u7406'; } }
            else { if (cs3) { cs3.style.display = ''; cs3.textContent = '\u2713 \u5df2\u6574\u7406\u4e26\u5132\u5b58\u5230\u9577\u671f\u8a18\u61b6'; } var a2 = document.getElementById('ltmArea'); if (a2) a2.value = msg.ltm || ''; chat.innerHTML = ''; _streamNode = null; _agentStepNode = null; _pendingBubble = null; saveActiveSessionSnapshot(); var hp2 = document.getElementById('historyPreview'); if (hp2) hp2.value = '（已整理並清除）'; var hii2 = document.getElementById('historyInfo'); if (hii2) hii2.textContent = '對話歷史：0 條訊息'; }
          }
          // --- Messages FROM extension host (sidebar commands) ---
          else if (msg.type === 'newChatSession') { createNewSession(); }
          else if (msg.type === 'switchChatSessionFromHost') { if (msg.sessionId) switchChatSession(msg.sessionId); }
          else if (msg.type === 'renameChatSessionFromHost') {
            var rnSess = null;
            for (var ri2 = 0; ri2 < _chatSessions.length; ri2++) { if (_chatSessions[ri2].id === msg.sessionId) { rnSess = _chatSessions[ri2]; break; } }
            if (rnSess && msg.title) { rnSess.title = msg.title; rnSess.manualTitle = true; renderChatSessionSelect(); persistSessionState(); }
          }
          else if (msg.type === 'deleteChatSessionFromHost') { deleteChatSession(msg.sessionId); }
        } catch(e) { dbg('CATCH: ' + (e && e.message ? e.message : String(e))); }
      });

      const chat = document.getElementById('chat');
      const prompt = document.getElementById('prompt');
      const modelSelect = document.getElementById('modelSelect');
      let streamMode = false;
      let attachedFiles = [];
      let _streamNode = null;
      let _pendingBubble = null;
      let agentMode = true;
      let teamMode = false;
      let debateMode = false;
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
          opt.value = s.id; opt.textContent = s.title || s.id;
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
        appendMessage('user', label + (attachedFiles.length ? ' (\uD83D\uDCCE ' + attachedFiles.length + ')' : ''));
        if (teamMode) {
          var selModels = getSelectedTeamModels();
          vscode.postMessage({ type: 'teamSend', prompt: buildPromptWithFiles(text), models: selModels, sessionId: _activeChatSessionId });
          prompt.value = ''; resizePrompt(); clearFiles(); setSendEnabled(false);
          if (statusBar) statusBar.textContent = '\u{1F465} \u5718\u968a\u8a0e\u8ad6\u4e2d\u2026';
          return;
        }
        if (debateMode) {
          var debSel = getSelectedDebateModels();
          vscode.postMessage({ type: 'debateSend', prompt: buildPromptWithFiles(text), models: debSel, sessionId: _activeChatSessionId });
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
      prompt.placeholder = '\u8f38\u5165\u4efb\u52d9\u2026 Agent \u6703\u81ea\u52d5\u4f7f\u7528\u5de5\u5177 (Enter \u9001\u51fa)';
      if (statusBar) statusBar.textContent = '\uD83E\uDD16 Agent \u6a21\u5f0f';

      sendBtn.addEventListener('click', doSend);

      // Enter = 送出；Ctrl+Enter = 換行
      prompt.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.ctrlKey && !e.shiftKey && !e.altKey) {
          e.preventDefault();
          doSend();
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
        if (statusBar) statusBar.textContent = agentMode ? '🤖 Agent 模式 — AI 可自動讀寫檔案、執行命令' : '💬 Ask 模式 — 直接對話，不使用工具';
        prompt.placeholder = agentMode ? '輸入任務… Agent 會自動使用工具 (Enter 送出)' : '輸入訊息… (Enter 送出 / Ctrl+Enter 換行)';
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
      // -- parseBlocks + makeCodeBlock -------------------------------------------
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

      function makeCodeBlock(code) {
        var wrap = document.createElement('div'); wrap.className = 'code-block-wrap';
        var pre = document.createElement('pre'); pre.textContent = code; wrap.appendChild(pre);
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

      // -- appendMessage --------------------------------------------------------
      function appendMessage(who, text, thinkingText) {
        var node = document.createElement('div'); node.className = 'msg ' + who;
        var bubble = document.createElement('div'); bubble.className = 'bubble';
        if (who === 'assistant' && thinkingText) bubble.appendChild(makeThinkBlock(thinkingText, false));
        if (who === 'assistant') {
          parseBlocks(text).forEach(function(p) {
            if (p.t === 'code') {
              bubble.appendChild(makeCodeBlock(p.v));
            } else if (p.v.trim()) {
              var d = document.createElement('div'); d.style.whiteSpace = 'pre-wrap'; d.textContent = p.v; bubble.appendChild(d);
            }
          });
          var sumBtn = document.createElement('button'); sumBtn.textContent = '\u6458\u8981';
          sumBtn.addEventListener('click', function() { vscode.postMessage({ type: 'summarize', text: text, model: modelSelect ? modelSelect.value : undefined }); });
          var sdiv = document.createElement('div'); sdiv.appendChild(sumBtn); bubble.appendChild(sdiv);
        } else {
          var body = document.createElement('div'); body.textContent = text; bubble.appendChild(body);
        }
        node.appendChild(bubble);
        chat.appendChild(node); chat.scrollTop = chat.scrollHeight;
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
          d.appendChild(s); d.appendChild(p); bubble.appendChild(d);
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
      function createDebateHeader(labelA, labelB, labelJ, colorA, colorB, colorJ) {
        _debateLabelA = labelA; _debateLabelB = labelB; _debateLabelJ = labelJ || '';
        _debateColorA = colorA; _debateColorB = colorB; _debateColorJ = colorJ;
        Object.keys(_debateNodes).forEach(function(k) { delete _debateNodes[k]; });
        var hdr = document.createElement('div');
        hdr.style.cssText = 'text-align:center;font-size:0.82em;font-weight:700;margin:10px 0 4px;padding:5px 0;border-top:1px dashed rgba(128,128,128,0.3);border-bottom:1px dashed rgba(128,128,128,0.3)';
        var tagA = '<span style="color:' + colorA + '">' + labelA + '</span>';
        var tagB = '<span style="color:' + colorB + '">' + labelB + '</span>';
        var tagJ = labelJ ? ' &#x00B7; <span style="color:' + colorJ + '">[' + labelJ + ' \u88c1\u5224]</span>' : '';
        hdr.innerHTML = '\u2694\ufe0f \u5c0d\u8a71\u6a21\u5f0f\uff1a' + tagA + ' vs ' + tagB + tagJ;
        chat.appendChild(hdr); chat.scrollTop = chat.scrollHeight;
      }
      function startDebateTurn(speaker, round) {
        var label = speaker === 'A' ? _debateLabelA : speaker === 'B' ? _debateLabelB : _debateLabelJ + ' (\u88c1\u5224)';
        var color = speaker === 'A' ? _debateColorA : speaker === 'B' ? _debateColorB : _debateColorJ;
        var roleIcon = speaker === 'A' ? '\ud83d\udfe6' : speaker === 'B' ? '\ud83d\udfe7' : '\u2696\ufe0f';
        var node = document.createElement('div'); node.className = 'msg assistant';
        var bub = document.createElement('div'); bub.className = 'bubble debate-turn';
        bub.style.borderLeft = '3px solid ' + color;
        var h = document.createElement('div'); h.className = 'debate-turn-header';
        h.style.color = color;
        h.innerHTML = roleIcon + ' <strong>' + label + '</strong>' + (round >= 0 ? ' <span style="opacity:0.5;font-weight:normal">\u7b2c ' + (round + 1) + ' \u8f2a</span>' : '');
        var body = document.createElement('div'); body.className = 'debate-turn-body';
        bub.appendChild(h); bub.appendChild(body); node.appendChild(bub);
        chat.appendChild(node); chat.scrollTop = chat.scrollHeight;
        _debateNodes[speaker] = { node: node, bub: bub, body: body, thinkNode: null, thinkChars: 0, thinkStart: 0, thinkTimer: null };
      }
      function appendDebateThinkChunk(speaker, chunk) {
        var d = _debateNodes[speaker]; if (!d) return;
        if (!d.thinkNode) {
          var det = document.createElement('details'); det.className = 'think'; det.setAttribute('open', '');
          var s = document.createElement('summary');
          var color = speaker === 'A' ? _debateColorA : speaker === 'B' ? _debateColorB : _debateColorJ;
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
        d.body.textContent += chunk; chat.scrollTop = chat.scrollHeight;
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
        var pp = document.getElementById('personaPreview');
        if (pp) pp.value = msg.persona || '(\u672a\u8a2d\u5b9a)';
        var hii = document.getElementById('historyInfo');
        if (hii) hii.textContent = '\u5c0d\u8a71\u6b77\u53f2\uff1a' + (msg.historyCount || 0) + ' \u689d\u8a0a\u606f';
        var hp = document.getElementById('historyPreview');
        if (hp) hp.value = msg.historyPreview || (msg.historyCount ? '（歷史存在但無預覽）' : '（目前沒有對話歷史）');
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
        vscode.postMessage({ type: 'memorySave', ltm: '' });
      });
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
      function showPermissionBar(category, description) {
        _currentPermCategory = category || '';
        var bar = document.getElementById('permissionBar');
        var desc = document.getElementById('permissionDesc');
        if (!bar || !desc) return;
        var catLabel = { write: '\u{1F4BE} \u5beb\u5165\u6a94\u6848', delete: '\u{1F5D1} \u522a\u9664\u6a94\u6848', run: '\u{25B6}\uFE0F \u57f7\u884c\u6307\u4ee4' }[category] || '\u26A0\uFE0F \u654f\u611f\u64cd\u4f5c';
        desc.textContent = catLabel + '\uff1a' + description;
        bar.classList.add('visible');
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

  private async handleTeamSend(prompt: string, selectedModels?: string[]): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('amiClaw');
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
      const planPrompt = `你是 AI 工作協調員。請分析下面的任務，拆分成 ${numCopilotTasks} 個可獨立執行的細緻子任務，讓多個 AI 助手從佇列中依序認領。\n\n${wsContext}\n\n【任務】\n${prompt}\n\n只回傳 JSON（不含說明文字），格式：\n{"assignments":[{"index":0,"task":"子任務描述"},{"index":1,"task":"子任務描述"},...]}`;
      let assignments: { index: number; task: string }[] = [{ index: 0, task: prompt }];
      try {
        const planText = await this.copilotStream(
          orchestratorFamily, planPrompt,
          (chunk) => { if (!this._teamCancel) this._panel.webview.postMessage({ type: 'teamOrchestratorChunk', chunk }); }
        );
        const jsonMatch = planText.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [null, null];
        const jsonStr = (jsonMatch[1] ?? planText).trim();
        const parsed = JSON.parse(jsonStr);
        if (Array.isArray(parsed.assignments)) {
          const raw = parsed.assignments.map((a: { index: number; task: string }) => ({ index: Number(a.index), task: String(a.task) }));
          // Deduplicate: remove tasks with identical text
          const seen = new Set<string>();
          assignments = raw.filter((a: { index: number; task: string }) => { if (seen.has(a.task)) return false; seen.add(a.task); return true; });
          if (assignments.length === 0) assignments = [{ index: 0, task: prompt }];
        }
      } catch { /* use default single-task fallback */ }
      this._panel.webview.postMessage({ type: 'teamOrchestratorEnd' });
      this._panel.webview.postMessage({ type: 'teamTodoList', tasks: assignments.map(a => a.task) });

      if (this._teamCancel) { this._panel.webview.postMessage({ type: 'teamEnd' }); return; }

      // Phase 1: Workers pick tasks from queue, each reviewed by Copilot orchestrator
      const copilotReviewFn = (p: string, onChunk: (c: string) => void) =>
        this.copilotStream(orchestratorFamily, p, onChunk);
      let copilotQueuePos = 0;
      const nextCopilotTask = () => copilotQueuePos < assignments.length ? assignments[copilotQueuePos++] : null;

      await Promise.all(effectiveWorkers.map(async (model) => {
        const displayName = getDisplay(model);
        let taskItem: { index: number; task: string } | null;
        while ((taskItem = nextCopilotTask()) !== null && !this._teamCancel) {
          const id = `team_t${taskItem.index}`;
          const color = COLORS[taskItem.index % COLORS.length];
          this._panel.webview.postMessage({ type: 'teamTodoStart', idx: taskItem.index, worker: displayName });
          this._panel.webview.postMessage({ type: 'teamMemberStart', id, model: displayName, color, task: taskItem.task });
          try {
            const response = await this.runWorkerDiscussion(getWorkerModel(model), copilotReviewFn, getWorkerUrl(model), taskItem.task, id, color);
            results.push({ model: displayName, response });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            this._panel.webview.postMessage({ type: 'teamResponseChunk', id, chunk: `[錯誤] ${msg}` });
            results.push({ model: displayName, response: `錯誤: ${msg}` });
          }
          this._panel.webview.postMessage({ type: 'teamMemberEnd', id });
          this._panel.webview.postMessage({ type: 'teamTodoDone', idx: taskItem.index });
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
      }

      // Phase 3: Agent executor
      const agentModel = normalizeForAgent(effectiveWorkers.find(m => !m.startsWith('copilot/') && !m.startsWith('copilot::')) ?? primaryOllamaModel ?? effectiveWorkers[0] ?? '');
      const willRunAgent = !this._teamCancel && synthResult.trim().length > 0 && !!agentModel;
      this._panel.webview.postMessage({ type: 'teamEnd', agentFollows: willRunAgent });
      if (willRunAgent) {
        this._panel.webview.postMessage({ type: 'teamAgentStart', model: agentModel });
        this._agentMessages = [];
        this._agentMessagesBySession[this._activeSessionId] = this._agentMessages;
        await this.handleAgent(`根據以下團隊討論結論，立即執行必要操作來完成使用者的任務。\n\n${wsContext}\n\n【原始任務】\n${prompt}\n\n【團隊綜合結論】\n${synthResult}\n\n【強制規則】\n- 訊息中出現 Jira Key（如 UOEM2-3476）→ 立即呼叫 jira_fetch，禁止說「我將查詢」。\n- 需要理解工作區代碼 → 立即呼叫 read_file / search_workspace，禁止假設內容。\n- 看到任務就執行工具，不得宣告意圖後停止。\n\n請逐步執行。`, agentModel);
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
        const tPlanPrompt = `你是 AI 工作協調員。請分析下面的任務，拆分成 ${numOllamaTasks} 個可獨立執行的細緻子任務，讓多個 AI 助手從佇列中依序認領。\n\n${wsContext}\n\n【任務】\n${prompt}\n\n只回傳 JSON（不含說明文字），格式：\n{"assignments":[{"index":0,"task":"子任務描述"},{"index":1,"task":"子任務描述"},...]}`;
        // Tasks: pending=not started, running=in progress, done=completed, failed=error
        type TaskStatus = 'pending' | 'running' | 'done' | 'failed';
        interface TaskItem { index: number; task: string; status: TaskStatus; assignedTo?: string; response?: string; }
        let tTasks: TaskItem[] = [{ index: 0, task: prompt, status: 'pending' as TaskStatus }];
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
            const raw = tParsed.assignments.map((a: { index: number; task: string }) => ({
              index: Number(a.index), task: String(a.task), status: 'pending' as TaskStatus
            }));
            const seen = new Set<string>();
            tTasks = raw.filter((a: TaskItem) => { if (seen.has(a.task)) return false; seen.add(a.task); return true; });
            if (tTasks.length === 0) tTasks = [{ index: 0, task: prompt, status: 'pending' as TaskStatus }];
          }
        } catch { /* use default single-task fallback */ }
        this._panel.webview.postMessage({ type: 'teamOrchestratorEnd' });
        this._panel.webview.postMessage({ type: 'teamTodoList', tasks: tTasks.map(a => a.task) });
        if (this._teamCancel) { this._panel.webview.postMessage({ type: 'teamEnd' }); return; }

        // Phase 1: 序列執行 — 依序讓每個模型處理一個任務，巡迴直到全部完成
        // 序列佇列：一次只跑一個 Ollama call（包括 review）
        const ollamaReviewFn = async (p: string, onChunk: (c: string) => void) =>
          ollamaCall(thinkModel, p, onChunk);

        const getNextPending = () => tTasks.find(t => t.status === 'pending') ?? null;
        const workerCycle = [...effectiveWorkers]; // round-robin workers
        let workerIdx = 0;

        while (!this._teamCancel) {
          const tItem = getNextPending();
          if (!tItem) break; // all tasks done or no more pending

          // Also check for failed tasks that can be reassigned
          const failedItem = tTasks.find(t => t.status === 'failed');
          const activeItem = failedItem ?? tItem;

          const model = workerCycle[workerIdx % workerCycle.length];
          workerIdx++;
          activeItem.status = 'running';
          activeItem.assignedTo = model;

          const id = `team_t${activeItem.index}`;
          const color = COLORS[activeItem.index % COLORS.length];
          this._panel.webview.postMessage({ type: 'teamTodoStart', idx: activeItem.index, worker: model });
          this._panel.webview.postMessage({ type: 'teamMemberStart', id, model, color, task: activeItem.task });
          if (failedItem) {
            // Show reassignment notice
            this._panel.webview.postMessage({ type: 'teamResponseChunk', id, chunk: `🔄 重新指派任務給 ${model}...\n` });
          }

          try {
            const response = await this.runWorkerDiscussion(
              getWorkerModel(model), ollamaReviewFn, getWorkerUrl(model), activeItem.task, id, color, 100,
              ollamaCall
            );
            activeItem.status = 'done';
            activeItem.response = response;
            results.push({ model, response });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            this._panel.webview.postMessage({ type: 'teamResponseChunk', id, chunk: `[錯誤] ${msg}` });
            activeItem.status = 'failed';
            // Orchestrator monitors: notify about failure and mark for reassignment
            this._panel.webview.postMessage({ type: 'teamOrchestratorChunk', chunk: `\n⚠️ 協調員偵測到 [任務#${activeItem.index}] 失敗（${model}），標記重新指派...\n` });
          }
          this._panel.webview.postMessage({ type: 'teamMemberEnd', id });
          if (activeItem.status === 'done') {
            this._panel.webview.postMessage({ type: 'teamTodoDone', idx: activeItem.index });
          }

          // Safety: if all workers have tried and all remaining tasks are failed, give up
          const allFailed = tTasks.every(t => t.status === 'done' || t.status === 'failed');
          if (allFailed && tTasks.some(t => t.status === 'failed')) {
            // Push failed tasks as error results and break
            for (const ft of tTasks.filter(t => t.status === 'failed')) {
              results.push({ model: ft.assignedTo ?? thinkModel, response: `[任務#${ft.index} 最終失敗，無法完成]` });
              this._panel.webview.postMessage({ type: 'teamTodoDone', idx: ft.index });
            }
            break;
          }
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
          await this.handleAgent(`根據以下團隊討論結論，立即執行必要操作來完成使用者的任務。\n\n${wsContext}\n\n【原始任務】\n${prompt}\n\n【團隊綜合結論】\n${tSynthResult}\n\n【強制規則】\n- 訊息中出現 Jira Key（如 UOEM2-3476）→ 立即呼叫 jira_fetch，禁止說「我將查詢」。\n- 需要理解工作區代碼 → 立即呼叫 read_file / search_workspace，禁止假設內容。\n- 看到任務就執行工具，不得宣告意圖後停止。\n\n請逐步執行。`, tAgentModel);
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

  // ── Debate / Dialogue Mode ───────────────────────────────────────────────
  /** 對話模式：2 個 AI 互相辯論/對弈；3 個 AI 則第三個當裁判 */
  private async handleDebateSend(prompt: string, selectedModels?: string[]): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('amiClaw');
    const urls = getOllamaUrls(cfg);
    const allModels = (selectedModels && selectedModels.length >= 2) ? selectedModels.slice(0, 3) : [];
    if (allModels.length < 2) {
      this._panel.webview.postMessage({ type: 'error', text: '對話模式需要選擇至少 2 個 AI 模型' });
      return;
    }
    const COLORS = ['#4fc1ff', '#ce9178', '#89d185'];
    this._teamCancel = false;

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
    const isGame = /五子棋|圍棋|象棋|將棋|西洋棋|chess|go\b|tic.tac|gomoku|shogi|遊戲|下棋/i.test(prompt);

    // ── Game mode: A & B take turns, A's move is passed to B as board state ──
    if (isGame) {
      this._panel.webview.postMessage({ type: 'debateStart', labelA, labelB, labelJ, colorA: COLORS[0], colorB: COLORS[1], colorJ: COLORS[2] });
      const gameSystemA = '你是棋手，正在進行以下棋局。每次只說明你這一步的落子位置（使用標準座標）和簡短理由，不要發表其他評論。';
      const gameSystemB = '你是棋手，正在進行以下棋局。根據對手的上一步，回應你的落子位置（使用標準座標）和簡短理由，不要發表其他評論。';
      const initPrompt = prompt;
      // historyA = A's own turns; gameMoves = shared move log passed to B each turn
      const historyA: { role: 'user' | 'assistant'; content: string }[] = [{ role: 'user', content: initPrompt + '\n\n請下第一手。' }];
      const gameMoves: string[] = [];
      const MAX_GAME_ROUNDS = 6;

      for (let round = 0; round < MAX_GAME_ROUNDS && !this._teamCancel; round++) {
        // A moves
        this._panel.webview.postMessage({ type: 'debateTurnStart', speaker: 'A', round });
        let moveA = '';
        let statsA: { tokens?: number; tps?: number } = {};
        try {
          const rA = await callModel(modelA, gameSystemA, historyA,
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
          const rB = await callModel(modelB, gameSystemB, [{ role: 'user', content: boardState }],
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
      if (judgeModel && !this._teamCancel) {
        this._panel.webview.postMessage({ type: 'debateTurnStart', speaker: 'J', round: -1 });
        const gameSummary = initPrompt + '\n\n完整棋譜：\n' + gameMoves.join('\n') + '\n\n請分析這場對局，說明雙方的策略與得失。';
        let statsJ: { tokens?: number; tps?: number } = {};
        try {
          const rJ = await callModel(judgeModel, '你是棋局分析師，請客觀分析以下對局。', [{ role: 'user', content: gameSummary }],
            (c) => { if (!this._teamCancel) this._panel.webview.postMessage({ type: 'debateChunk', speaker: 'J', chunk: c }); });
          statsJ = { tokens: rJ.tokens, tps: rJ.tps };
        } catch (e) {
          const errJ = '[錯誤: ' + (e instanceof Error ? e.message : String(e)) + ']';
          if (!this._teamCancel) this._panel.webview.postMessage({ type: 'debateChunk', speaker: 'J', chunk: errJ });
        }
        this._panel.webview.postMessage({ type: 'debateTurnEnd', speaker: 'J', tokens: statsJ.tokens, tps: statsJ.tps });
      }

      this._panel.webview.postMessage({ type: 'debateEnd', consensus: false });
      this._panel.webview.postMessage({ type: 'agentStatus', running: false });
      return;
    }

    // ── Discussion mode (non-game) ────────────────────────────────────────────
    const roleADesc = '請針對以下議題提出你的分析與見解：\n\n' + prompt;
    const roleBDesc = '請針對以下議題提出你的分析與見解：\n\n' + prompt;
    const roleJDesc = '請整合以下多份針對同一議題的分析，做出客觀的綜合總結：';

    // Announce start
    this._panel.webview.postMessage({ type: 'debateStart', labelA, labelB, labelJ, colorA: COLORS[0], colorB: COLORS[1], colorJ: COLORS[2] });

    // Each model has fully independent context — they don't know each other exists
    // historyA/B only contains that model's own [user, assistant, user, assistant, ...] turns
    const historyA: { role: 'user' | 'assistant'; content: string }[] = [{ role: 'user', content: prompt }];
    const historyB: { role: 'user' | 'assistant'; content: string }[] = [{ role: 'user', content: prompt }];
    // Collected responses for judge summary
    const summaryLines: string[] = [];
    const MAX_ROUNDS = 4;

    for (let round = 0; round < MAX_ROUNDS && !this._teamCancel; round++) {
      // A speaks — only sees its own prior turns
      this._panel.webview.postMessage({ type: 'debateTurnStart', speaker: 'A', round });
      let responseA = '';
      let statsDA: { tokens?: number; tps?: number } = {};
      try {
        const rA = await callModel(
          modelA, roleADesc, historyA,
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
      // A's own memory: append its answer, then prime next user turn
      historyA.push({ role: 'assistant', content: responseA });
      historyA.push({ role: 'user', content: '請進一步說明。' });
      summaryLines.push(`【${labelA}】\n${responseA}`);

      // B speaks — only sees its own prior turns
      this._panel.webview.postMessage({ type: 'debateTurnStart', speaker: 'B', round });
      let responseB = '';
      let statsDB: { tokens?: number; tps?: number } = {};
      try {
        const rB = await callModel(
          modelB, roleBDesc, historyB,
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
      // B's own memory: append its answer, then prime next user turn
      historyB.push({ role: 'assistant', content: responseB });
      historyB.push({ role: 'user', content: '請進一步說明。' });
      summaryLines.push(`【${labelB}】\n${responseB}`);
    }

    // Judge sees a plain-text summary of all responses — no cross-model raw content
    if (judgeModel && !this._teamCancel) {
      const judgeMsgs: { role: 'user' | 'assistant'; content: string }[] = [
        { role: 'user', content: summaryLines.join('\n\n---\n\n') + '\n\n請做出綜合總結。' }
      ];
      this._panel.webview.postMessage({ type: 'debateTurnStart', speaker: 'J', round: -1 });
      let statsDJ: { tokens?: number; tps?: number } = {};
      try {
        const rJ = await callModel(
          judgeModel, roleJDesc, judgeMsgs,
          (c) => { if (!this._teamCancel) this._panel.webview.postMessage({ type: 'debateChunk', speaker: 'J', chunk: c }); }
        );
        statsDJ = { tokens: rJ.tokens, tps: rJ.tps };
      } catch (e) {
        const errJ = '[錯誤: ' + (e instanceof Error ? e.message : String(e)) + ']';
        if (!this._teamCancel) this._panel.webview.postMessage({ type: 'debateChunk', speaker: 'J', chunk: errJ });
      }
      this._panel.webview.postMessage({ type: 'debateTurnEnd', speaker: 'J', tokens: statsDJ.tokens, tps: statsDJ.tps });
    }

    this._panel.webview.postMessage({ type: 'debateEnd', consensus: false });
    this._panel.webview.postMessage({ type: 'agentStatus', running: false });
  }

  private async fetchTeamModels(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('amiClaw');
    const ollamaUrls = getOllamaUrls(cfg);
    const teamModels: { id: string; label: string; vendor: string }[] = [];
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
        if (!seen.has(id)) { seen.add(id); teamModels.push({ id, label: cleanName, vendor: 'copilot' }); }
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
    const cfg = vscode.workspace.getConfiguration('amiClaw');
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

    this._panel.webview.postMessage({ type: 'streamStart' });
    let fullResponse = '';
    try {
      let thinkBuf = '';
      let thinkTimer: ReturnType<typeof setTimeout> | null = null;
      const flushThink = () => {
        if (thinkBuf) { this._panel.webview.postMessage({ type: 'thinkChunk', chunk: thinkBuf }); thinkBuf = ''; }
        thinkTimer = null;
      };
      if (model.startsWith('copilot::')) {
        const copilotId = model.slice('copilot::'.length);
        const cts0 = new vscode.CancellationTokenSource();
        try {
          const vmMsgs0: vscode.LanguageModelChatMessage[] = [];
          if (systemContent.trim()) { vmMsgs0.push(vscode.LanguageModelChatMessage.User(`[系統]\n${systemContent}`)); }
          for (const h of recent) {
            vmMsgs0.push(h.role === 'user' ? vscode.LanguageModelChatMessage.User(h.content ?? '') : vscode.LanguageModelChatMessage.Assistant(h.content ?? ''));
          }
          vmMsgs0.push(vscode.LanguageModelChatMessage.User(prompt));
          fullResponse = await copilotStreamText(copilotId, vmMsgs0, (chunk) => { this._panel.webview.postMessage({ type: 'assistantChunk', chunk }); }, cts0.token);
        } finally { cts0.dispose(); }
      } else {
        fullResponse = await ollamaGenerateStream(
          baseUrl, model, fullPrompt,
          (chunk) => { this._panel.webview.postMessage({ type: 'assistantChunk', chunk }); },
          (thinkChunk) => {
            OllamaChatPanel.log('thinkChunk: ' + thinkChunk.substring(0, 50));
            thinkBuf += thinkChunk;
            if (!thinkTimer) thinkTimer = setTimeout(flushThink, 80);
          },
          (tokens, tps) => { this._panel.webview.postMessage({ type: 'streamStats', tokens, tps }); }
        );
      }
      if (thinkTimer) { clearTimeout(thinkTimer); }
      flushThink();
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
    const cfg = vscode.workspace.getConfiguration('amiClaw');
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
    return this._context.globalState.get<string>('amiClaw.longTermMemory') ?? '';
  }

  private async saveLongTermMemory(text: string): Promise<void> {
    await this._context.globalState.update('amiClaw.longTermMemory', text);
  }

  private buildSystemContent(): string {
    const cfg = vscode.workspace.getConfiguration('amiClaw');
    const persona = cfg.get<string>('systemPrompt') ?? '';
    const ltm = this.getLongTermMemory();
    let content = persona.trim();
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
    const cfg = vscode.workspace.getConfiguration('amiClaw');
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

    const cfg = vscode.workspace.getConfiguration('amiClaw');
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

  /** 要求使用者確認敏感操作，回傳是否允許。已在 _alwaysAllow 則直接通過。*/
  private requestPermission(category: string, description: string): Promise<boolean> {
    if (this._alwaysAllow.has(category)) { return Promise.resolve(true); }
    return new Promise<boolean>((resolve) => {
      this._pendingPermission = resolve;
      this._panel.webview.postMessage({ type: 'permissionRequest', category, description });
    });
  }

  private async handleAgent(userPrompt: string, modelOverride?: string): Promise<void> {
    if (this._agentRunning) { vscode.window.showInformationMessage('Agent 已在執行中'); return; }
    this._agentRunning = true;
    this._agentCancel = false;
    this._panel.webview.postMessage({ type: 'agentStatus', running: true });

    const cfg = vscode.workspace.getConfiguration('amiClaw');
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

    try {
      for (let step = 0; step < 20 && !this._agentCancel; step++) {
        let resp: ChatMessage | undefined;
        try {
          resp = model.startsWith('copilot::')
            ? await copilotChatCallWithCts(model.slice('copilot::'.length), this._agentMessages, AGENT_TOOLS)
            : await ollamaChatCall(baseUrl, model, this._agentMessages, AGENT_TOOLS);
        } catch (e) {
          const emsg = e instanceof Error ? e.message : String(e);
          if (/token|limit|context|exceed/i.test(emsg) && this._agentMessages.length > 4) {
            this._trimAgentHistory();
            this._panel.webview.postMessage({ type: 'agentStep', icon: '✂️', title: '歷史記錄過長，已自動裁剪後重試', fullPath: '' });
            resp = model.startsWith('copilot::')
              ? await copilotChatCallWithCts(model.slice('copilot::'.length), this._agentMessages, AGENT_TOOLS)
              : await ollamaChatCall(baseUrl, model, this._agentMessages, AGENT_TOOLS);
          } else {
            throw e;
          }
        }
        if (!resp) { break; }

        if (resp.tool_calls && resp.tool_calls.length > 0) {
          this._agentMessages.push({ role: 'assistant', content: resp.content ?? null, tool_calls: resp.tool_calls });
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
            const preview = result.length > 400 ? result.slice(0, 400) + '\n…（已截斷）' : result;
            this._panel.webview.postMessage({ type: 'agentStepDone', result: preview, isError });
            this._agentMessages.push({ role: 'tool', content: result, tool_call_id: tc.id ?? fn.name });
          }
        } else {
          const text = resp.content ?? '';
          this._agentMessages.push({ role: 'assistant', content: text });
          this._panel.webview.postMessage({ type: 'assistant', text });
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

  /** 裁剪 _agentMessages：保留 system prompt + 最新 8 則訊息，避免超過 token 上限。 */
  private _trimAgentHistory(): void {
    const sys = this._agentMessages[0];
    const rest = this._agentMessages.slice(1);
    this._agentMessages = [sys, ...rest.slice(-8)];
    this._agentMessagesBySession[this._activeSessionId] = this._agentMessages;
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
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(fpath));
        const text = Buffer.from(bytes).toString('utf8');
        return text.length > 50000 ? text.slice(0, 50000) + '\n…（已截斷至 50KB）' : text;
      }
      case 'write_file': {
        const fpath = resolvePath(args.path as string);
        const content = (args.content as string) ?? '';
        const allowed = await this.requestPermission('write', `寫入檔案: ${fpath}（${content.length} 字元）`);
        if (!allowed) { return '使用者已拒絕寫入操作'; }
        await vscode.workspace.fs.writeFile(vscode.Uri.file(fpath), Buffer.from(content, 'utf8'));
        return `已寫入 ${fpath}（${content.length} 字元）`;
      }
      case 'replace_in_file': {
        const fpath = resolvePath(args.path as string);
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(fpath));
        const original = Buffer.from(bytes).toString('utf8');
        const oldStr = args.old_str as string;
        const newStr = (args.new_str as string) ?? '';
        if (!original.includes(oldStr)) { return `錯誤：在 ${fpath} 中找不到指定的字串`; }
        const allowed = await this.requestPermission('write', `編輯檔案: ${fpath}`);
        if (!allowed) { return '使用者已拒絕編輯操作'; }
        await vscode.workspace.fs.writeFile(vscode.Uri.file(fpath), Buffer.from(original.replace(oldStr, newStr), 'utf8'));
        return `已更新 ${fpath}`;
      }
      case 'list_dir': {
        const dirArg = (args.path as string) || '';
        if (!dirArg && folders.length > 1) {
          // List all workspace folders
          const results: string[] = [];
          for (const f of folders) {
            const entries = await vscode.workspace.fs.readDirectory(f.uri);
            const listing = entries.map(([n, t]) => t === vscode.FileType.Directory ? n + '/' : n).sort().join('\n');
            results.push(`=== ${f.uri.fsPath} ===\n${listing}`);
          }
          return results.join('\n\n');
        }
        const dpath = resolvePath(dirArg);
        const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dpath));
        return entries.map(([n, t]) => t === vscode.FileType.Directory ? n + '/' : n).sort().join('\n');
      }
      case 'run_terminal': {
        const cmd = args.command as string;
        const allowed = await this.requestPermission('run', `終端機執行: ${cmd}`);
        if (!allowed) { return '使用者已拒絕執行操作'; }
        const terminals = vscode.window.terminals;
        const terminal = terminals.length > 0 ? terminals[terminals.length - 1] : vscode.window.createTerminal('Agent');
        terminal.show(true);
        terminal.sendText(cmd);
        return `已在終端機執行: ${cmd}`;
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
        const allowed = await this.requestPermission('delete', `刪除: ${fpath}`);
        if (!allowed) { return '使用者已拒絕刪除操作'; }
        await vscode.workspace.fs.delete(vscode.Uri.file(fpath), { recursive: (args.recursive as boolean) ?? false });
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
        const allowed = await this.requestPermission('run', `執行指令: ${cmd}`);
        if (!allowed) { return '使用者已拒絕執行操作'; }
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
          const jiraCfg = vscode.workspace.getConfiguration('amiClaw');
          const jiraBase = (jiraCfg.get<string>('jiraBaseUrl') ?? '').replace(/\/$/, '');
          const jiraEmail = jiraCfg.get<string>('jiraEmail') ?? '';
          const jiraPat = jiraCfg.get<string>('jiraPat') ?? '';
          if (!jiraBase) return '找不到 atlassian.atlascode 登入資訊，請在 VS Code 設定中填寫 amiClaw.jiraBaseUrl';
          if (!jiraPat)  return '找不到 atlassian.atlascode 登入資訊，請在 VS Code 設定中填寫 amiClaw.jiraPat';
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
                  resolve(`Jira 認證失敗 (HTTP ${res.statusCode})，請確認 atlassian.atlascode 已登入，或在設定中填寫 amiClaw.jiraPat。`);
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
          const jiraCfg3 = vscode.workspace.getConfiguration('amiClaw');
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
    const cfg = vscode.workspace.getConfiguration('amiClaw');
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
    const r1 = await this._panel.webview.postMessage({ type: 'modelList', models: liveModels, copilotModels, current: current2 });
    const r2 = await this._panel.webview.postMessage({ type: 'connectionStatus', ok: connOk2, url: connUrl2, message: connMsg2 });
    OllamaChatPanel.log('fetchModelsFromServer postMessage results: modelList=' + r1 + ' connectionStatus=' + r2);
  }

  private async testConnectionStatus(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('amiClaw');
    const baseUrl = cfg.get<string>('url') ?? 'http://localhost:11434';
    const result = await ollamaCheckConnection(baseUrl);
    this._panel.webview.postMessage({ type: 'connectionStatus', ok: result.ok, url: baseUrl, message: result.message });
  }
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
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
];

function getToolIcon(name: string): string {
  const m: Record<string, string> = { get_active_file: '📝', read_file: '📄', write_file: '💾', replace_in_file: '✏️', list_dir: '📁', run_terminal: '⚡', search_workspace: '🔍', delete_file: '🗑️', create_dir: '📂', run_command: '▶️', fetch_url: '🌐', open_browser: '💻', manage_todo: '📝', vscode_action: '🎨', jira_fetch: '📋', jira_open: '🎫', jira_create: '🎫', jira_transition: '🔄', jira_attachment_download: '📎', bb_create_pr: '🔀', rovo_ask: '🤖' };
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
    default: return name;
  }
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
      const body = JSON.stringify({ model, messages, tools, stream: false });
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
            resolve(json.message as ChatMessage);
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

function getCopilotMultiplier(m: vscode.LanguageModelChat): string {
  const id = m.id.toLowerCase();
  const fam = (m.family || '').toLowerCase();
  if (id === 'auto' || fam === 'auto') return '10% off';
  if (id.includes('opus') || fam.includes('opus')) return '3x';
  if (id.includes('mini') || fam.includes('mini')) return '0x';
  if ((id.startsWith('gpt-4o') && !id.includes('mini')) || fam === 'gpt-4o' || id === 'gpt-4o') return '0x';
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
  const vmMsgs = messages.map(m => {
    const content = m.content ?? '';
    if (m.role === 'assistant') { return vscode.LanguageModelChatMessage.Assistant(content); }
    return vscode.LanguageModelChatMessage.User(content);
  });
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
  const m = model.toLowerCase();
  return m.startsWith('deepseek-r1') || m.startsWith('qwq') || m.includes('think');
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

/** 讀取所有設定的 Ollama 伺服器 URL。優先使用 amiClaw.urls，fallback 到 amiClaw.url。 */
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
