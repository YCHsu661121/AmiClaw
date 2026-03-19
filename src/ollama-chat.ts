import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import { URL } from 'url';

// (Copied implementation from top-level file)
export class OllamaChatPanel {
  public static currentPanel: OllamaChatPanel | undefined;
  public static readonly viewType = 'amiClaw.chat';
  private static _log: vscode.OutputChannel;

  private readonly _panel: vscode.WebviewPanel;
  private readonly _disposables: vscode.Disposable[] = [];
  private _autoRunning = false;
  private _autoCancel = false;
  private _autoMaxIterations = 50;
  private _streamMode = false;
  private _agentRunning = false;
  private _agentCancel = false;
  private _agentMessages: ChatMessage[] = [];
  private _agentTodos: { id: number; text: string; done: boolean }[] = [];
  private _teamCancel = false;
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  private _context!: vscode.ExtensionContext;
  private _chatHistory: ChatMessage[] = [];

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

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(async message => {
      OllamaChatPanel.log('Received message: ' + message.type);
      try {
        switch (message.type) {
          case 'send':
            await this.handleSend(message.prompt, message.model);
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
            await this.handleAgent(message.prompt, message.model);
            break;
          case 'agentStop':
            this._agentCancel = true;
            break;
          case 'fetchTeamModels':
            await this.fetchTeamModels();
            break;
          case 'teamSend':
            this.handleTeamSend(message.prompt, message.models).catch(() => {});
            break;
          case 'teamStop':
            this._teamCancel = true;
            break;
          case 'applyToFile':
            await this.handleApplyToFile(message.code);
            break;
          case 'clearHistory':
            this._agentMessages = [];
            this._chatHistory = [];
            this._panel.webview.postMessage({ type: 'historyCount', count: 0 });
            break;
          case 'memoryGet': {
            const cfg2 = vscode.workspace.getConfiguration('amiClaw');
            const persona2 = cfg2.get<string>('systemPrompt') ?? '';
            this._panel.webview.postMessage({ type: 'memoryLoaded', ltm: this.getLongTermMemory(), persona: persona2, historyCount: this._chatHistory.length });
            break;
          }
          case 'memorySave':
            await this.saveLongTermMemory(message.ltm as string);
            this._panel.webview.postMessage({ type: 'memorySaved' });
            break;
          case 'openSettings':
            vscode.commands.executeCommand('workbench.action.openSettings', 'amiClaw.systemPrompt');
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
      const baseUrl = cfg.get<string>('url') ?? 'http://localhost:11434';
      let liveModels: string[] = [];
      let connOk = false;
      let connMsg = '';
      try {
        OllamaChatPanel.log('Fetching models from ' + baseUrl);
        liveModels = await ollamaListModels(baseUrl);
        connOk = true;
        connMsg = 'OK';
        OllamaChatPanel.log('Models fetched OK: ' + liveModels.join(', '));
      } catch (e) {
        connMsg = e instanceof Error ? e.message : String(e);
        OllamaChatPanel.log('Model fetch error: ' + connMsg);
      }
      const current = cfg.get<string>('model') ?? liveModels[0] ?? 'llama3';
      // Push result to webview via postMessage (safe: listener is already registered)
      const r1 = await _webview.postMessage({ type: 'modelList', models: liveModels, current });
      OllamaChatPanel.log('postMessage modelList delivered=' + r1);
      const r2 = await _webview.postMessage({ type: 'connectionStatus', ok: connOk, url: baseUrl, message: connMsg });
      OllamaChatPanel.log('postMessage connectionStatus delivered=' + r2);
    })().catch((e) => { OllamaChatPanel.log('Async IIFE error: ' + (e instanceof Error ? e.message : String(e))); });
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
    const defaultModel = cfg.get<string>('model') ?? 'llama3';
    const models = cfg.get<string[]>('models') ?? [defaultModel, 'llama3', 'llama2', 'vicuna', 'mistral'];
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
      #modelSelect{flex:1;max-width:180px;font-size:12px;padding:3px 6px;background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);border:1px solid var(--vscode-dropdown-border,rgba(128,128,128,0.4));border-radius:4px}
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
      /* 團隊模式 — 成員選擇面板 */
      #teamPicker{display:none;padding:4px 8px 6px;border:1px solid rgba(128,128,128,0.25);border-radius:6px;margin:2px 0;background:rgba(128,128,128,0.05);max-height:130px;overflow-y:auto}
      #teamPicker.visible{display:block}
      #teamPickerBar{display:flex;align-items:center;gap:6px;margin-bottom:4px;flex-wrap:wrap}
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
    </style>
  </head>
  <body>
    <div id="chat"></div>
    <div id="bottomBar">
      <div id="topBar">
        <select id="modelSelect" aria-label="選擇模型">${optionsHtml}</select>
        <button class="icon-btn" id="refreshModels" title="重整模型 / 測試連線">🔄</button>
        <button class="icon-btn" id="pickFile" title="附加檔案">📎</button>
        <button class="icon-btn" id="toggleStream" title="切換串流模式">⚡</button>
        <button class="icon-btn" id="agentMode" title="Agent 模式 (AI 可讀寫檔案、執行命令)">🤖</button>
        <button class="icon-btn" id="teamMode" title="團隊討論模式 (多個 AI 並行思考👥)">👥</button>
        <button class="icon-btn" id="stopAgent" title="停止 Agent">⏹</button>
        <button class="icon-btn" id="memBtn" title="記憶管理">🧠</button>
        <button class="icon-btn" id="clear" title="清除對話">🗑</button>
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
      <div id="inputRow">
        <textarea id="prompt" rows="1" placeholder="輸入訊息… (Enter 送出 / Ctrl+Enter 換行)"></textarea>
        <button id="sendBtn" title="送出 (Enter)">&#9658;</button>
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
          <div class="mem-row"><button class="mem-btn" id="clearHistoryBtn2">&#x1F5D1; 清除對話歷史</button></div>
        </div>
      </div>
    </div>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();

      // ── 訊息處理 (最先掛上，避免後續程式碼拋例外導致 listener 遺失) ──────
      window.addEventListener('message', function(event) {
        try {
          const msg = event.data;
          if (msg.type === 'assistant')          { clearPendingBubble(); _agentStepNode = null; _streamNode = null; setSendEnabled(true); appendMessage('assistant', msg.text, msg.thinking); }
          else if (msg.type === 'streamStart')   { clearPendingBubble(); _streamNode = null; }
          else if (msg.type === 'thinkChunk')    { appendThinkChunk(msg.chunk); }
          else if (msg.type === 'assistantChunk'){ appendChunk(msg.chunk); }
          else if (msg.type === 'streamEnd')     { _agentStepNode = null; _streamNode = null; setSendEnabled(true); }
          else if (msg.type === 'error')         { clearPendingBubble(); _agentStepNode = null; _streamNode = null; setSendEnabled(true); appendMessage('assistant', '\u932f\u8aa4\uff1a' + msg.text); }
          else if (msg.type === 'teamMemberStart') { createTeamMember(msg.id, msg.model, msg.color, msg.task); }
          else if (msg.type === 'teamThinkChunk')  { appendTeamThinkChunk(msg.id, msg.color, msg.chunk); }
          else if (msg.type === 'teamResponseChunk'){ appendTeamResponseChunk(msg.id, msg.chunk); }
          else if (msg.type === 'teamMemberEnd')   { finalizeTeamMember(msg.id); }
          else if (msg.type === 'teamOrchestratorStart') { createOrchestratorBubble(msg.model); }
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
          else if (msg.type === 'teamModelList')   { populateTeamPicker(msg.models); }
          else if (msg.type === 'teamTodoList')  { createTodoPanel(msg.tasks); }
          else if (msg.type === 'teamTodoStart') { updateTodo(msg.idx, 'running', msg.worker); }
          else if (msg.type === 'teamTodoDone')  { updateTodo(msg.idx, 'done'); }
          else if (msg.type === 'agentStatus')   {
            if (statusBar) statusBar.textContent = msg.running ? '\u2699\ufe0f Agent \u57f7\u884c\u4e2d\u2026' : (agentMode ? '\ud83e\udd16 Agent \u6a21\u5f0f' : '');
            setSendEnabled(!msg.running);
          }
          else if (msg.type === 'agentStep')     { appendAgentStep(msg.icon, msg.title, msg.fullPath); }
          else if (msg.type === 'agentStepDone') { finalizeAgentStep(msg.result, msg.isError); }
          else if (msg.type === 'autoStatus')    { if (statusBar) statusBar.textContent = msg.running ? '\u23f3 \u81ea\u52d5\u57f7\u884c\u4e2d\u2026' : ''; setSendEnabled(!msg.running); }
          else if (msg.type === 'autoPaused')    { appendMessage('assistant', '\u5df2\u6682\u505c\uff0c\u9700\u5b58\u53d6 ' + (msg.path || '\u672a\u77e5\u8def\u5f91')); if (statusBar) statusBar.textContent = '\u23f8 \u6682\u505c'; }
          else if (msg.type === 'streamMode')    { const t = document.getElementById('toggleStream'); if (t) t.classList.toggle('active', msg.enabled); }
          else if (msg.type === 'modelList')     { updateModelSelect(msg.models, msg.current); }
          else if (msg.type === 'connectionStatus') { updateConnStatus(msg.ok, msg.url, msg.message); }
          else if (msg.type === 'fileAttached')  { addFileChip(msg.name, msg.content); }
          else if (msg.type === 'memoryLoaded')  { onMemoryLoaded(msg); }
          else if (msg.type === 'memorySaved')   { var slb = document.getElementById('saveLtmBtn'); if (slb) { slb.textContent = '\u2713 \u5df2\u5132\u5b58'; setTimeout(function() { slb.textContent = '\uD83D\uDCBE \u5132\u5b58\u9577\u671f\u8a18\u61b6'; }, 1500); } }
          else if (msg.type === 'historyCount')  { var hii = document.getElementById('historyInfo'); if (hii) hii.textContent = '\u5c0d\u8a71\u6b77\u53f2\uff1a' + (msg.count || 0) + ' \u689d\u8a0a\u606f'; }
        } catch(e) { /* swallow */ }
      });

      const chat = document.getElementById('chat');
      const prompt = document.getElementById('prompt');
      const modelSelect = document.getElementById('modelSelect');
      let streamMode = false;
      let attachedFiles = [];
      let _streamNode = null;
      let _pendingBubble = null;
      let agentMode = false;
      let teamMode = false;
      let _agentStepNode = null;
      const _teamNodes = {}; // id -> { node, bubble, thinkNode, responseNode, charCount, thinkStart, thinkTimer }
      var _todosPanel = null;
      var _todoChecked = 0;
      let _synthNode = null;
      let _orchestratorNode = null;
      let _teamAvailModels = []; // [{id, label, vendor}]

      const sendBtn = document.getElementById('sendBtn');
      const statusBar = document.getElementById('statusBar');

      // auto-grow textarea
      function resizePrompt() {
        prompt.style.height = 'auto';
        prompt.style.height = Math.min(prompt.scrollHeight, 160) + 'px';
      }
      prompt.addEventListener('input', resizePrompt);

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
        appendMessage('user', label + (attachedFiles.length ? ' (\uD83D\uDCCE ' + attachedFiles.length + ')' : ''));
        if (teamMode) {
          var selModels = getSelectedTeamModels();
          vscode.postMessage({ type: 'teamSend', prompt: buildPromptWithFiles(text), models: selModels });
          prompt.value = ''; resizePrompt(); clearFiles(); setSendEnabled(false);
          if (statusBar) statusBar.textContent = '\u{1F465} \u5718\u968a\u8a0e\u8ad6\u4e2d\u2026';
          return;
        }
        vscode.postMessage({ type: agentMode ? 'agentSend' : 'send', prompt: buildPromptWithFiles(text), model: m });
        prompt.value = ''; resizePrompt(); clearFiles();
        setSendEnabled(false);
        appendLoadingBubble();
      }

      function setSendEnabled(on) {
        if (sendBtn) sendBtn.disabled = !on;
      }
      prompt.addEventListener('input', function() { setSendEnabled(prompt.value.trim().length > 0); });
      setSendEnabled(true);

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
        Object.keys(_teamNodes).forEach(function(k){ delete _teamNodes[k]; }); _synthNode = null; _orchestratorNode = null;
        vscode.postMessage({ type: 'clearHistory' });
      });

      document.getElementById('agentMode').addEventListener('click', function() {
        agentMode = !agentMode;
        document.getElementById('agentMode').classList.toggle('active', agentMode);
        if (agentMode && teamMode) { teamMode = false; document.getElementById('teamMode').classList.remove('active'); }
        if (statusBar) statusBar.textContent = agentMode ? '🤖 Agent 模式 — AI 可自動讀寫檔案、執行命令' : '';
        prompt.placeholder = agentMode ? '輸入任務… Agent 會自動使用工具 (Enter 送出)' : '輸入訊息… (Enter 送出 / Ctrl+Enter 換行)';
      });

      document.getElementById('teamMode').addEventListener('click', function() {
        teamMode = !teamMode;
        document.getElementById('teamMode').classList.toggle('active', teamMode);
        if (teamMode && agentMode) { agentMode = false; document.getElementById('agentMode').classList.remove('active'); }
        var picker = document.getElementById('teamPicker');
        if (picker) picker.classList.toggle('visible', teamMode);
        if (teamMode) { vscode.postMessage({ type: 'fetchTeamModels' }); if (statusBar) statusBar.textContent = '\u{1F465} \u9078\u64c7\u5718\u968a\u6210\u54e1\u5f8c\u8f38\u5165\u554f\u984c'; }
        else { if (statusBar) statusBar.textContent = ''; }
        prompt.placeholder = teamMode ? '\u8f38\u5165\u554f\u984c\u2026 \u6240\u9078 AI \u6703\u540c\u6642\u56de\u7b54 (Enter \u9001\u51fa)' : '\u8f38\u5165\u8a0a\u606f\u2026 (Enter \u9001\u51fa / Ctrl+Enter \u63db\u884c)';
      });
      var tpr = document.getElementById('teamPickerRefresh');
      if (tpr) tpr.addEventListener('click', function() { vscode.postMessage({ type: 'fetchTeamModels' }); });

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
          var lineCount = (m.responseNode.textContent || '').split('\n').length;
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
        var node = document.createElement('div'); node.className = 'msg assistant team-orchestrator-node';
        var bub = document.createElement('div'); bub.className = 'bubble';
        var hdr = document.createElement('div'); hdr.className = 'team-orchestrator-header';
        hdr.textContent = '\uD83D\uDC19 ' + (model || '') + ' \u2014 \u5206\u914D\u5DE5\u4F5C\u4E2D\u2026';
        var body = document.createElement('div'); body.className = 'response-body'; body.style.whiteSpace = 'pre-wrap'; body.style.fontSize = '0.85em';
        bub.appendChild(hdr); bub.appendChild(body); node.appendChild(bub);
        chat.appendChild(node); chat.scrollTop = chat.scrollHeight;
        _orchestratorNode = { node: node, bubble: bub, body: body, hdr: hdr };
      }

      function appendOrchestratorChunk(chunk) {
        if (!_orchestratorNode) return;
        _orchestratorNode.body.textContent += chunk;
        chat.scrollTop = chat.scrollHeight;
      }

      function finalizeOrchestratorBubble() {
        if (!_orchestratorNode) return;
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
        var rvh = document.createElement('span'); rvh.className = 'team-review-label'; rvh.textContent = '\uD83D\uDC19 \u5354\u8abf\u54e1：';
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
          lbl.textContent = (m.vendor === 'copilot' ? '\uD83D\uDC19 ' : '\uD83E\uDD99 ') + m.label;
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

      function updateModelSelect(models, current) {
        if (!modelSelect || !models || !models.length) return;
        modelSelect.innerHTML = '';
        models.forEach(function(m) {
          const opt = document.createElement('option'); opt.value = m; opt.textContent = m;
          if (m === current) opt.selected = true;
          modelSelect.appendChild(opt);
        });
        if (!modelSelect.value && models.length) modelSelect.value = models[0];
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
      setTimeout(function() { vscode.postMessage({ type: 'webviewReady' }); }, 0);

      // ── \u8a18\u61b6\u7ba1\u7406 Modal ──────────────────────────────────────────────────────
      function onMemoryLoaded(msg) {
        var area = document.getElementById('ltmArea');
        if (area) area.value = msg.ltm || '';
        var pp = document.getElementById('personaPreview');
        if (pp) pp.value = msg.persona || '(\u672a\u8a2d\u5b9a)';
        var hii = document.getElementById('historyInfo');
        if (hii) hii.textContent = '\u5c0d\u8a71\u6b77\u53f2\uff1a' + (msg.historyCount || 0) + ' \u689d\u8a0a\u606f';
      }

      var memModal = document.getElementById('memModal');
      var memBtn = document.getElementById('memBtn');
      if (memBtn) {
        memBtn.addEventListener('click', function() {
          if (memModal) memModal.classList.add('open');
          vscode.postMessage({ type: 'memoryGet' });
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
        vscode.postMessage({ type: 'clearHistory' });
      });
      var editPersonaBtn = document.getElementById('editPersonaBtn');
      if (editPersonaBtn) editPersonaBtn.addEventListener('click', function() {
        vscode.postMessage({ type: 'openSettings' });
      });

      // JS-side safety net: if connectionStatus never arrives in 5s, ask again
      setTimeout(function() {
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
    const baseUrl = cfg.get<string>('url') ?? 'http://localhost:11434';
    const primaryOllamaModel = cfg.get<string>('model') ?? 'llama3';
    const allModels = (selectedModels && selectedModels.length > 0) ? selectedModels.slice(0, 5) : [primaryOllamaModel];

    const COLORS = ['#4fc1ff', '#89d185', '#ce9178', '#c586c0', '#dcdcaa', '#f7cc65'];
    this._teamCancel = false;
    const systemContent = this.buildSystemContent();
    const getDisplay = (m: string) => m.startsWith('copilot/') ? '\uD83D\uDC19 ' + m.slice('copilot/'.length) : m;

    // Detect orchestrator: first Copilot model in the selection
    const copilotIdx = allModels.findIndex(m => m.startsWith('copilot/'));
    const hasOrchestrator = copilotIdx >= 0;
    const orchestratorFamily = hasOrchestrator ? allModels[copilotIdx].slice('copilot/'.length) : '';
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
      const planPrompt = `你是 AI 工作協調員。請分析下面的任務，拆分成 ${numCopilotTasks} 個可獨立執行的細緻子任務，讓多個 AI 助手從佇列中依序認領。\n\n【任務】\n${prompt}\n\n只回傳 JSON（不含說明文字），格式：\n{"assignments":[{"index":0,"task":"子任務描述"},{"index":1,"task":"子任務描述"},...]}`;
      let assignments: { index: number; task: string }[] = Array.from({ length: numCopilotTasks }, (_, i) => ({ index: i, task: prompt }));
      try {
        const planText = await this.copilotStream(
          orchestratorFamily, planPrompt,
          (chunk) => { if (!this._teamCancel) this._panel.webview.postMessage({ type: 'teamOrchestratorChunk', chunk }); }
        );
        const jsonMatch = planText.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [null, null];
        const jsonStr = (jsonMatch[1] ?? planText).trim();
        const parsed = JSON.parse(jsonStr);
        if (Array.isArray(parsed.assignments)) {
          assignments = parsed.assignments.map((a: { index: number; task: string }) => ({ index: Number(a.index), task: String(a.task) }));
        }
      } catch { /* use default assignments */ }
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
            const response = await this.runWorkerDiscussion(model, copilotReviewFn, baseUrl, taskItem.task, id, color);
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
      const willRunAgent = !this._teamCancel && synthResult.trim().length > 0;
      this._panel.webview.postMessage({ type: 'teamEnd', agentFollows: willRunAgent });
      if (willRunAgent) {
        this._panel.webview.postMessage({ type: 'teamAgentStart', model: primaryOllamaModel });
        this._agentMessages = [];
        await this.handleAgent(`\u6839\u64da\u4ee5\u4e0b\u5718\u968a\u8a0e\u8ad6\u7d50\u8ad6\uff0c\u8acb\u57f7\u884c\u5fc5\u8981\u7684\u7a0b\u5f0f\u78bc\u6216\u6a94\u6848\u64cd\u4f5c\u4f86\u5b8c\u6210\u4f7f\u7528\u8005\u7684\u4efb\u52d9\u3002\n\n\u3010\u539f\u59cb\u4efb\u52d9\u3011\n${prompt}\n\n\u3010\u5718\u968a\u7d9c\u5408\u7d50\u8ad6\u3011\n${synthResult}\n\n\u8acb\u9010\u6b65\u57f7\u884c\u3002`, primaryOllamaModel);
      }

    } else {
      // ── Ollama-only: 最具思考能力的模型擔任協調員 ──────────────────────────
      const thinkModel = OllamaChatPanel.pickThinkingModel(effectiveWorkers);

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
          const soloResponse = await ollamaGenerateStream(
            baseUrl, soloModel, soloPrompt,
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
        // 多模型：思考模型擔任協調員，其餘為工作模型
        // Phase 0: 思考模型生成細緻任務清單 (JSON)
        this._panel.webview.postMessage({ type: 'teamOrchestratorStart', model: thinkModel });
        const numOllamaTasks = Math.max(effectiveWorkers.length * 2, 4);
        const tPlanPrompt = `你是 AI 工作協調員。請分析下面的任務，拆分成 ${numOllamaTasks} 個可獨立執行的細緻子任務，讓多個 AI 助手從佇列中依序認領。\n\n【任務】\n${prompt}\n\n只回傳 JSON（不含說明文字），格式：\n{"assignments":[{"index":0,"task":"子任務描述"},{"index":1,"task":"子任務描述"},...]}`;
        let tAssignments: { index: number; task: string }[] = Array.from({ length: numOllamaTasks }, (_, i) => ({ index: i, task: prompt }));
        try {
          const tPlanText = await ollamaGenerateStream(
            baseUrl, thinkModel, tPlanPrompt,
            (chunk) => { if (!this._teamCancel) this._panel.webview.postMessage({ type: 'teamOrchestratorChunk', chunk }); }
          );
          const tJsonMatch = tPlanText.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [null, null];
          const tJsonStr = (tJsonMatch[1] ?? tPlanText).trim();
          const tParsed = JSON.parse(tJsonStr);
          if (Array.isArray(tParsed.assignments)) {
            tAssignments = tParsed.assignments.map((a: { index: number; task: string }) => ({ index: Number(a.index), task: String(a.task) }));
          }
        } catch { /* use default assignments */ }
        this._panel.webview.postMessage({ type: 'teamOrchestratorEnd' });
        this._panel.webview.postMessage({ type: 'teamTodoList', tasks: tAssignments.map(a => a.task) });

        if (this._teamCancel) { this._panel.webview.postMessage({ type: 'teamEnd' }); return; }

        // Phase 1: 各工作模型從佇列認領任務，由思考模型審查
        const ollamaReviewFn = (p: string, onChunk: (c: string) => void) =>
          ollamaGenerateStream(baseUrl, thinkModel, p, onChunk);
        let ollamaQueuePos = 0;
        const nextOllamaTask = () => ollamaQueuePos < tAssignments.length ? tAssignments[ollamaQueuePos++] : null;

        await Promise.all(effectiveWorkers.map(async (model) => {
          let tItem: { index: number; task: string } | null;
          while ((tItem = nextOllamaTask()) !== null && !this._teamCancel) {
            const id = `team_t${tItem.index}`;
            const color = COLORS[tItem.index % COLORS.length];
            this._panel.webview.postMessage({ type: 'teamTodoStart', idx: tItem.index, worker: model });
            this._panel.webview.postMessage({ type: 'teamMemberStart', id, model, color, task: tItem.task });
            try {
              const response = await this.runWorkerDiscussion(model, ollamaReviewFn, baseUrl, tItem.task, id, color);
              results.push({ model, response });
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              this._panel.webview.postMessage({ type: 'teamResponseChunk', id, chunk: `[錯誤] ${msg}` });
              results.push({ model, response: `錯誤: ${msg}` });
            }
            this._panel.webview.postMessage({ type: 'teamMemberEnd', id });
            this._panel.webview.postMessage({ type: 'teamTodoDone', idx: tItem.index });
          }
        }));

        if (this._teamCancel) { this._panel.webview.postMessage({ type: 'teamEnd' }); return; }

        // Phase 2: 思考模型綜合所有工作結果
        let tSynthResult = '';
        if (results.length > 0) {
          const tSynthPrompt = `【原始任務】\n${prompt}\n\n各助手已完成分配的工作，結果如下：\n${results.map(r => `\n--- ${r.model} ---\n${r.response}`).join('')}\n\n請以繁體中文，整合所有結果，給出完整的綜合回覆（條列重點）：`;
          this._panel.webview.postMessage({ type: 'teamSynthStart' });
          try {
            tSynthResult = await ollamaGenerateStream(
              baseUrl, thinkModel, tSynthPrompt,
              (chunk) => { if (!this._teamCancel) this._panel.webview.postMessage({ type: 'teamSynthChunk', chunk }); }
            );
          } catch { /* ignore */ }
        }

        // Phase 3: Agent executor
        const tWillRunAgent = !this._teamCancel && tSynthResult.trim().length > 0;
        this._panel.webview.postMessage({ type: 'teamEnd', agentFollows: tWillRunAgent });
        if (tWillRunAgent) {
          this._panel.webview.postMessage({ type: 'teamAgentStart', model: thinkModel });
          this._agentMessages = [];
          await this.handleAgent(`根據以下團隊討論結論，請執行必要的程式碼或檔案操作來完成使用者的任務。\n\n【原始任務】\n${prompt}\n\n【團隊綜合結論】\n${tSynthResult}\n\n請逐步執行。`, thinkModel);
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

  private async fetchTeamModels(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('amiClaw');
    const baseUrl = cfg.get<string>('url') ?? 'http://localhost:11434';
    const teamModels: { id: string; label: string; vendor: string }[] = [];
    // Ollama models
    try {
      const ollamaModels = await ollamaListModels(baseUrl);
      for (const m of ollamaModels) { teamModels.push({ id: m, label: m, vendor: 'ollama' }); }
    } catch { /* Ollama not reachable */ }
    // GitHub Copilot models
    try {
      const copilotModels = await vscode.lm.selectChatModels({ vendor: 'copilot' });
      const seen = new Set<string>();
      for (const m of copilotModels) {
        const id = `copilot/${m.family}`;
        if (!seen.has(id)) { seen.add(id); teamModels.push({ id, label: m.name || m.family, vendor: 'copilot' }); }
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
    maxRounds = 100
  ): Promise<string> {
    const isCopilot = workerModel.startsWith('copilot/');
    const workerFamily = isCopilot ? workerModel.slice('copilot/'.length) : workerModel;
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
        lastResponse = await ollamaGenerateStream(
          baseUrl, workerModel, currentPrompt,
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

  private async handleSend(prompt: string, modelOverride?: string): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('amiClaw');
    const baseUrl = cfg.get<string>('url') ?? 'http://localhost:11434';
    const model = modelOverride ?? cfg.get<string>('model') ?? 'llama3';

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
      fullResponse = await ollamaGenerateStream(
        baseUrl, model, fullPrompt,
        (chunk) => { this._panel.webview.postMessage({ type: 'assistantChunk', chunk }); },
        (thinkChunk) => {
          OllamaChatPanel.log('thinkChunk: ' + thinkChunk.substring(0, 50));
          thinkBuf += thinkChunk;
          if (!thinkTimer) thinkTimer = setTimeout(flushThink, 80);
        }
      );
      if (thinkTimer) { clearTimeout(thinkTimer); }
      flushThink();
      // Save assistant response to short-term memory
      this._chatHistory.push({ role: 'assistant', content: fullResponse });
      this._panel.webview.postMessage({ type: 'streamEnd' });
      this._panel.webview.postMessage({ type: 'historyCount', count: this._chatHistory.length });
    } catch (e: unknown) {
      // Roll back optimistic user msg
      this._chatHistory.pop();
      const msg = e instanceof Error ? e.message : String(e);
      this._panel.webview.postMessage({ type: 'error', text: msg });
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
    return content;
  }

  private async summarizeText(text: string, modelOverride?: string): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('amiClaw');
    const baseUrl = cfg.get<string>('url') ?? 'http://localhost:11434';
    const model = modelOverride ?? cfg.get<string>('model') ?? 'llama3';

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
    const model = modelOverride ?? cfg.get<string>('model') ?? 'llama3';

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

  private async handleAgent(userPrompt: string, modelOverride?: string): Promise<void> {
    if (this._agentRunning) { vscode.window.showInformationMessage('Agent 已在執行中'); return; }
    this._agentRunning = true;
    this._agentCancel = false;
    this._panel.webview.postMessage({ type: 'agentStatus', running: true });

    const cfg = vscode.workspace.getConfiguration('amiClaw');
    const baseUrl = cfg.get<string>('url') ?? 'http://localhost:11434';
    const model = modelOverride ?? cfg.get<string>('model') ?? 'llama3';

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
      this._agentMessages.push({
        role: 'system',
        content: `你是 VS Code 程式開發助手 Agent，可存取的工作區資料夾: ${folderList}。${activeFileStr}${openFilesStr}\n\n執行策略（依優先順序）：\n1. 先用 search_workspace 搜尋工作區中的檔案名稱、函式名稱、類別名稱等\n2. 讀取相關檔案確認實際內容\n3. 根據工作區實際程式碼進行修改或回答\n不確定時優先查閱本地程式碼，而非假設或憑空生成。\n\n請使用繁體中文回答，完成後告知使用者結果。`
      });
    }
    this._agentMessages.push({ role: 'user', content: userPrompt });

    try {
      for (let step = 0; step < 20 && !this._agentCancel; step++) {
        const resp = await ollamaChatCall(baseUrl, model, this._agentMessages, AGENT_TOOLS);
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
    const baseUrl = cfg.get<string>('url') ?? 'http://localhost:11434';
    OllamaChatPanel.log('fetchModelsFromServer: ' + baseUrl);
    try {
      const models = await ollamaListModels(baseUrl);
      const current = cfg.get<string>('model') ?? 'llama3';
      OllamaChatPanel.log('fetchModelsFromServer OK: models=' + models.join(', '));
      const r1 = await this._panel.webview.postMessage({ type: 'modelList', models, current });
      const r2 = await this._panel.webview.postMessage({ type: 'connectionStatus', ok: true, url: baseUrl, message: 'OK' });
      OllamaChatPanel.log('fetchModelsFromServer postMessage results: modelList=' + r1 + ' connectionStatus=' + r2);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      OllamaChatPanel.log('fetchModelsFromServer error: ' + msg);
      this._panel.webview.postMessage({ type: 'connectionStatus', ok: false, url: baseUrl, message: msg });
    }
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
  { type: 'function', function: { name: 'vscode_action', description: 'VS Code 操作：開啟檔案到指定行、取得工作區信息、顯示通知、執行 VS Code 內建指令', parameters: { type: 'object', properties: { action: { type: 'string', enum: ['open_file','get_workspace_info','show_notification','run_command'], description: 'open_file=開檔, get_workspace_info=工作區信息, show_notification=通知, run_command=執行内建指令' }, path: { type: 'string', description: 'open_file 用' }, line: { type: 'number', description: '開啟到哪一行' }, message: { type: 'string', description: 'show_notification 用' }, command: { type: 'string', description: 'run_command 用，VS Code 指令 ID' }, args: { type: 'array', description: '指令參數' } }, required: ['action'] } } },
];

function getToolIcon(name: string): string {
  const m: Record<string, string> = { get_active_file: '📝', read_file: '📄', write_file: '💾', replace_in_file: '✏️', list_dir: '📁', run_terminal: '⚡', search_workspace: '🔍', delete_file: '🗑️', create_dir: '📂', run_command: '▶️', fetch_url: '🌐', open_browser: '💻', manage_todo: '📝', vscode_action: '🎨' };
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
    default: return name;
  }
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

function ollamaGenerateStream(
  baseUrl: string, model: string, prompt: string,
  onResponseChunk: (chunk: string) => void,
  onThinkChunk?: (chunk: string) => void
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
        res.setEncoding('utf8');
        res.on('data', (data: string) => {
          lineBuffer += data;
          const lines = lineBuffer.split('\n');
          lineBuffer = lines.pop() ?? '';
          for (const line of lines) {
            const t = line.trim();
            if (!t) continue;
            try {
              const json = JSON.parse(t);
              // dedicated thinking field (Ollama >= 0.9 with think models)
              if (json.thinking && onThinkChunk) onThinkChunk(json.thinking as string);
              if (json.response) processToken(json.response as string);
            } catch { /* partial or non-JSON line */ }
          }
        });
        res.on('end', () => resolve(fullResponse));
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
  onThinkChunk?: (chunk: string) => void
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
        res.setEncoding('utf8');
        res.on('data', (data: string) => {
          lineBuffer += data;
          const lines = lineBuffer.split('\n');
          lineBuffer = lines.pop() ?? '';
          for (const line of lines) {
            const t = line.trim(); if (!t) continue;
            try {
              const json = JSON.parse(t);
              // /api/chat stream format: json.message.thinking + json.message.content
              if (json.message?.thinking && onThinkChunk) onThinkChunk(json.message.thinking as string);
              if (json.message?.content) processToken(json.message.content as string);
            } catch { /* partial */ }
          }
        });
        res.on('end', () => resolve(fullResponse));
      });
      req.on('error', (e) => reject(new Error(`\u7121\u6cd5\u9023\u7dda\u5230 Ollama (${baseUrl})\uff1a${e.message}`)));
      req.write(body); req.end();
    } catch (e) { reject(e); }
  });
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
