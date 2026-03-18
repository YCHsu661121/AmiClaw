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

  private static log(msg: string): void {
    if (!OllamaChatPanel._log) {
      OllamaChatPanel._log = vscode.window.createOutputChannel('AmiClaw');
    }
    OllamaChatPanel._log.appendLine(`[${new Date().toISOString()}] ${msg}`);
  }

  private constructor(panel: vscode.WebviewPanel, _context: vscode.ExtensionContext) {
    this._panel = panel;
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
          case 'applyToFile':
            await this.handleApplyToFile(message.code);
            break;
          case 'clearHistory':
            this._agentMessages = [];
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
      details.think pre { margin:0; padding:6px 10px; white-space:pre-wrap; color:var(--vscode-editor-foreground); opacity:0.85; font-size:0.82em; max-height:260px; overflow-y:auto; background:transparent }
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
        <button class="icon-btn" id="stopAgent" title="停止 Agent">⏹</button>
        <button class="icon-btn" id="clear" title="清除對話">🗑</button>
        <span style="flex:1"></span>
        <span id="connStatus" style="font-size:11px;opacity:0.8">\u9023\u7dda\uff1a\u6aa2\u67e5\u4e2d\u2026</span>
      </div>
      <div id="attachedFiles"></div>
      <div id="inputRow">
        <textarea id="prompt" rows="1" placeholder="輸入訊息… (Enter 送出 / Ctrl+Enter 換行)"></textarea>
        <button id="sendBtn" title="送出 (Enter)">&#9658;</button>
      </div>
      <div id="statusBar"></div>
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
          else if (msg.type === 'agentStatus')   {
            if (statusBar) statusBar.textContent = msg.running ? '\u2699\ufe0f Agent \u57f7\u884c\u4e2d\u2026' : (agentMode ? '\ud83e\udd16 Agent \u6a21\u5f0f' : '');
            setSendEnabled(!msg.running);
          }
          else if (msg.type === 'agentStep')     { appendAgentStep(msg.icon, msg.title); }
          else if (msg.type === 'agentStepDone') { finalizeAgentStep(msg.result, msg.isError); }
          else if (msg.type === 'autoStatus')    { if (statusBar) statusBar.textContent = msg.running ? '\u23f3 \u81ea\u52d5\u57f7\u884c\u4e2d\u2026' : ''; setSendEnabled(!msg.running); }
          else if (msg.type === 'autoPaused')    { appendMessage('assistant', '\u5df2\u6682\u505c\uff0c\u9700\u5b58\u53d6 ' + (msg.path || '\u672a\u77e5\u8def\u5f91')); if (statusBar) statusBar.textContent = '\u23f8 \u6682\u505c'; }
          else if (msg.type === 'streamMode')    { const t = document.getElementById('toggleStream'); if (t) t.classList.toggle('active', msg.enabled); }
          else if (msg.type === 'modelList')     { updateModelSelect(msg.models, msg.current); }
          else if (msg.type === 'connectionStatus') { updateConnStatus(msg.ok, msg.url, msg.message); }
          else if (msg.type === 'fileAttached')  { addFileChip(msg.name, msg.content); }
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
      let _agentStepNode = null;

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
        vscode.postMessage({ type: 'clearHistory' });
      });

      document.getElementById('agentMode').addEventListener('click', function() {
        agentMode = !agentMode;
        document.getElementById('agentMode').classList.toggle('active', agentMode);
        if (statusBar) statusBar.textContent = agentMode ? '🤖 Agent 模式 — AI 可自動讀寫檔案、執行命令' : '';
        prompt.placeholder = agentMode ? '輸入任務… Agent 會自動使用工具 (Enter 送出)' : '輸入訊息… (Enter 送出 / Ctrl+Enter 換行)';
      });

      document.getElementById('stopAgent').addEventListener('click', function() { vscode.postMessage({ type: 'agentStop' }); });

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
        }
        d._charCount = (d._charCount || 0) + chunk.length;
        const approxTok = Math.round(d._charCount / 4);
        const lbl = d.querySelector('.think-label');
        if (lbl) lbl.textContent = '\u{1F9E0} \u601d\u8003\u4e2d\u2026 (~' + approxTok + ' tokens)';
        const p = d.querySelector('pre.think-stream');
        if (p) { p.textContent = (p.textContent || '') + chunk; p.scrollTop = p.scrollHeight; }
        chat.scrollTop = chat.scrollHeight;
      }

      function appendChunk(chunk) {
        const bubble = getStreamBubble();
        const d = bubble.querySelector('details.think');
        if (d && d.hasAttribute('open')) {
          d.removeAttribute('open');
          const icon = d.querySelector('.think-icon'); if (icon) icon.classList.remove('pulse');
          const lbl = d.querySelector('.think-label');
          const approxTok = Math.round((d._charCount || 0) / 4);
          if (lbl) lbl.textContent = '\u{1F9E0} \u601d\u8003\u904e\u7a0b (~' + approxTok + ' tokens)';
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

      function appendAgentStep(icon, title) {
        var bub = ensureLastAssistantBubble();
        var d = document.createElement('details'); d.className = 'tool-step'; d.dataset.s = 'running';
        var s = document.createElement('summary');
        var span = document.createElement('span'); span.textContent = (icon || '\uD83D\uDD27') + '\u00A0' + title;
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

  private async handleSend(prompt: string, modelOverride?: string): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('amiClaw');
    const baseUrl = cfg.get<string>('url') ?? 'http://localhost:11434';
    const model = modelOverride ?? cfg.get<string>('model') ?? 'llama3';

    // Always stream when model supports thinking so think chunks appear live
    const useStream = this._streamMode || supportsThinking(model);

    if (useStream) {
      this._panel.webview.postMessage({ type: 'streamStart' });
      try {
        // Batch think chunks every 80ms to avoid flooding the webview message queue
        let thinkBuf = '';
        let thinkTimer: ReturnType<typeof setTimeout> | null = null;
        const flushThink = () => {
          if (thinkBuf) { this._panel.webview.postMessage({ type: 'thinkChunk', chunk: thinkBuf }); thinkBuf = ''; }
          thinkTimer = null;
        };
        await ollamaGenerateStream(
          baseUrl, model, prompt,
          (chunk) => { this._panel.webview.postMessage({ type: 'assistantChunk', chunk }); },
          (thinkChunk) => {
            OllamaChatPanel.log('thinkChunk: ' + thinkChunk.substring(0, 50));
            thinkBuf += thinkChunk;
            if (!thinkTimer) thinkTimer = setTimeout(flushThink, 80);
          }
        );
        if (thinkTimer) { clearTimeout(thinkTimer); }
        flushThink();
        this._panel.webview.postMessage({ type: 'streamEnd' });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        this._panel.webview.postMessage({ type: 'error', text: msg });
      }
    } else {
      try {
        const result = await ollamaGenerate(baseUrl, model, prompt);
        this._panel.webview.postMessage({ type: 'assistant', text: result.response, thinking: result.thinking });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        this._panel.webview.postMessage({ type: 'error', text: msg });
      }
    }
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
      this._agentMessages.push({
        role: 'system',
        content: `你是 VS Code 程式開發助手 Agent，可存取的工作區資料夾: ${folderList}。你可以使用工具自動讀寫檔案、執行命令來完成任務。請使用繁體中文回答，并在完成後告知使用者結果。`
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
            this._panel.webview.postMessage({ type: 'agentStep', icon: getToolIcon(fn.name), title: formatToolTitle(fn.name, args) });
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
  { type: 'function', function: { name: 'run_terminal', description: '在 VS Code 終端機執行命令', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
];

function getToolIcon(name: string): string {
  const m: Record<string, string> = { get_active_file: '📝', read_file: '📄', write_file: '💾', replace_in_file: '✏️', list_dir: '📁', run_terminal: '⚡' };
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
      req.setTimeout(120000, () => { req.destroy(new Error('Agent 呼叫逾時 (120s)')); });
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
