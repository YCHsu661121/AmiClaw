// Copyright (c) 2026 YCHsu. All rights reserved.
// Licensed under the MIT License.
import * as vscode from 'vscode';
import { getHtmlForWebview } from './webview/WebviewRenderer';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as os from 'os';
import { execSync } from 'child_process';
import { URL } from 'url';
import { WhatsAppManager } from './integrations/WhatsAppManager';
import { ToolExecutor, type ToolPermissionDiff } from './tools/ToolExecutor';
import { TeamManager } from './team/TeamManager';
import { DebateEngine } from './debate/DebateEngine';
import { QueryEngine } from './chat/QueryEngine';
import { AgentExecutor } from './chat/AgentExecutor';
import type { AgentExecutorServices } from './chat/AgentExecutor';

// (Copied implementation from top-level file)
export class OllamaChatPanel {
  public static currentPanel: OllamaChatPanel | undefined;
  public static readonly viewType = 'amiAiClaw.chat';
  private static _log: vscode.OutputChannel;
  /** Called by extension.ts to keep sidebar in sync */
  public static onSessionsChanged?: (sessions: { id: string; title: string }[], activeId: string) => void;

  private readonly _panel: vscode.WebviewPanel;
  private readonly _disposables: vscode.Disposable[] = [];
  private _disposed = false;
  private _streamMode = false;
  /** WhatsApp state and messaging – managed by WhatsAppManager */
  private _wa!: WhatsAppManager;
  private _team: TeamManager;
  private _debate: DebateEngine;
  private _tools: ToolExecutor;
  /** QueryEngine: handleSend, buildSystemContent, summarizeText, fetchModels, ensureModelReady */
  private _queryEngine!: QueryEngine;
  /** AgentExecutor: handleAgent, startAuto, agent/auto state */
  private _agentExecutor!: AgentExecutor;
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  private _context!: vscode.ExtensionContext;
  private _chatHistories: Record<string, ChatMessage[]> = { default: [] };
  private _activeSessionId = 'default';
  private _chatHistory: ChatMessage[] = this._chatHistories.default;
  /** 使用量統計：各 model 累計 token 與 Copilot 費率 */
  private _usageStats: Record<string, { tokens: number; isCopilot: boolean; multiplier: string; calls: number; toolCalls: number }> = {};
  /** 延遲記錄：每次請求完成時寫入 { model, ms, ts } */
  private _latencyLog: Array<{ model: string; ms: number; ts: number }> = [];

  private static log(msg: string): void {
    if (!vscode.workspace.getConfiguration('amiAiClaw').get<boolean>('enableDebugLog', false)) { return; }
    if (!OllamaChatPanel._log) {
      OllamaChatPanel._log = vscode.window.createOutputChannel('AMI-AiClaw');
    }
    OllamaChatPanel._log.appendLine(`[${new Date().toISOString()}] ${msg}`);
  }

  /** 記錄一次 API 呼叫的 token 使用量，並推送更新到前端。 */
  private trackUsage(model: string, tokens: number, multiplier = '', toolCall = false): void {
    if (!toolCall && (!tokens || tokens <= 0)) { return; }
    const isCopilot = model.startsWith('copilot::') || model.startsWith('copilot/');
    const key = model.replace(/^copilot[::\/]+/, '');
    const existing = this._usageStats[key];
    if (existing) {
      existing.tokens += tokens;
      if (tokens > 0) existing.calls = (existing.calls || 0) + 1;
      if (toolCall) existing.toolCalls = (existing.toolCalls || 0) + 1;
    } else {
      this._usageStats[key] = { tokens, isCopilot, multiplier, calls: tokens > 0 ? 1 : 0, toolCalls: toolCall ? 1 : 0 };
    }
    // 持久化累計值
    const saved = this._context.globalState.get<Record<string, { tokens: number; isCopilot: boolean; multiplier: string; calls: number; toolCalls: number }>>('amiAiClaw.usageStats') ?? {};
    const sk = saved[key];
    if (sk) { sk.tokens += tokens; if (tokens > 0) sk.calls = (sk.calls || 0) + 1; if (toolCall) sk.toolCalls = (sk.toolCalls || 0) + 1; }
    else { saved[key] = { tokens, isCopilot, multiplier, calls: tokens > 0 ? 1 : 0, toolCalls: toolCall ? 1 : 0 }; }
    this._context.globalState.update('amiAiClaw.usageStats', saved);
    this._panel.webview.postMessage({ type: 'usageUpdate', stats: this._usageStats });
  }

  /** 記錄一次請求的延遲，並推送到前端。 */
  private trackLatency(model: string, ms: number): void {
    const key = model.replace(/^copilot[::\/]+/, '');
    this._latencyLog.push({ model: key, ms, ts: Date.now() });
    if (this._latencyLog.length > 200) { this._latencyLog.shift(); }
    this._panel.webview.postMessage({ type: 'latencyUpdate', log: this._latencyLog });
  }

  private normalizeConfiguredModelId(modelId: string): string {
    return modelId.startsWith('copilot/') ? `copilot::${modelId.slice('copilot/'.length)}` : modelId;
  }

  private getProviderId(modelId: string): string {
    if (modelId.startsWith('copilot::') || modelId.startsWith('copilot/')) {
      return 'copilot';
    }
    if (modelId.startsWith('openai::')) {
      return 'openai';
    }
    return 'ollama';
  }

  private getProviderLabel(providerId: string): string {
    switch (providerId) {
      case 'copilot':
        return 'Copilot';
      case 'openai':
        return 'OpenAI Compatible';
      default:
        return 'Ollama';
    }
  }

  private normalizeModelOptions(
    ollamaModels: { id: string; label: string }[],
    copilotModels: { id: string; name: string; multiplier: string }[]
  ): WebviewModelOption[] {
    return [
      ...ollamaModels.map((model) => ({
        id: model.id,
        label: model.label,
        provider: 'ollama',
        providerLabel: 'Ollama',
      })),
      ...copilotModels.map((model) => ({
        id: `copilot::${model.id}`,
        label: model.name,
        provider: 'copilot',
        providerLabel: 'Copilot',
        multiplier: model.multiplier,
      })),
    ];
  }

  private buildProviderInfo(modelId?: string, models?: WebviewModelOption[]): ProviderInfo {
    const cfg = vscode.workspace.getConfiguration('amiAiClaw');
    const normalizedModelId = this.normalizeConfiguredModelId(modelId ?? cfg.get<string>('model') ?? '');
    const providerId = this.getProviderId(normalizedModelId);
    const displayName = models?.find((model) => model.id === normalizedModelId)?.label
      ?? normalizedModelId.replace(/^copilot::/, '').replace(/^openai::/, '');

    return {
      id: providerId,
      label: this.getProviderLabel(providerId),
      modelId: normalizedModelId,
      displayName,
    };
  }

  private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
    this._panel = panel;
    this._context = context;
    this._tools = new ToolExecutor({
      postToWebview: (msg) => this._panel.webview.postMessage(msg),
      getExtensionContext: () => this._context,
      isWaAgentMode: () => this._wa?.agentMode ?? false,
      log: (msg) => OllamaChatPanel.log(msg),
      getActiveSessionId: () => this._activeSessionId,
      handleWhatsAppTool: (name, args) => this._wa.handleTool(name, args),
    });
    // ── QueryEngine ────────────────────────────────────────────────────────────
    this._queryEngine = new QueryEngine(
      {
        postToWebview: (msg) => this._panel.webview.postMessage(msg),
        log: (msg) => OllamaChatPanel.log(msg),
        getChatHistory: () => this._chatHistory,
        getActiveSessionId: () => this._activeSessionId,
        getLongTermMemory: () => this.getLongTermMemory(),
        trackUsage: (m, t, mul, tc) => this.trackUsage(m, t, mul, tc),
        trackLatency: (m, ms) => this.trackLatency(m, ms),
        switchChatSession: (sid) => this.switchChatSession(sid),
      },
      {
        getOllamaUrls,
        decodeOllamaModel,
        encodeOllamaModelId,
        ollamaDisplayLabel,
        ollamaListModels,
        ollamaWarmupModel,
        ollamaUnloadModel,
        ollamaListRunningModels,
        ollamaCheckConnection,
        ollamaGenerate,
        ollamaGenerateStream,
        getCopilotMultiplier,
        getCopilotMultiplierById,
        copilotStreamText,
        estimateTokens,
      }
    );
    // ── AgentExecutor ──────────────────────────────────────────────────────────
    this._agentExecutor = new AgentExecutor(
      {
        postToWebview: (msg) => this._panel.webview.postMessage(msg),
        log: (msg) => OllamaChatPanel.log(msg),
        getChatHistory: () => this._chatHistory,
        getActiveSessionId: () => this._activeSessionId,
        getLongTermMemory: () => this.getLongTermMemory(),
        trackUsage: (m, t, mul, tc) => this.trackUsage(m, t, mul, tc),
        trackLatency: (m, ms) => this.trackLatency(m, ms),
        ensureModelReady: (url, mdl) => this._queryEngine.ensureModelReady(url, mdl),
        executeTool: (name, args) => this.executeTool(name, args),
        handleInsert: (code) => this.handleInsert(code),
        setWaAgentMode: (v) => this._wa.setAgentMode(v),
        clearAgentTodos: () => this._tools.clearAgentTodos(),
        recordAuditEntry: (tool, args, error) => this._tools.recordAuditEntry(tool, args, error),
      },
      {
        getOllamaUrls,
        decodeOllamaModel,
        ollamaChatCallStream: ollamaChatCallStream as AgentExecutorServices['ollamaChatCallStream'],
        openaiCompatChatCallStream: openaiCompatChatCallStream as AgentExecutorServices['openaiCompatChatCallStream'],
        copilotChatCallWithCts: copilotChatCallWithCts as AgentExecutorServices['copilotChatCallWithCts'],
        ollamaGenerate,
        estimateTokens,
        getCopilotMultiplierById,
        filterSensitiveInfo,
        getToolIcon,
        formatToolTitle,
        agentTools: AGENT_TOOLS,
      }
    );
    // Initialise WhatsApp manager (delegates all WA state and messaging)
    this._wa = new WhatsAppManager(context, {
      onAgentTrigger: (prompt, model) => this._agentExecutor.handleAgent(prompt, model || undefined, true, true),
      postToWebview:  (msg) => this._panel.webview.postMessage(msg),
      requestPermission: (category, description, toolName) => this.requestPermission(category, description, toolName),
      isAgentRunning: () => this._agentExecutor.isAgentRunning(),
      isDisposed:     () => this._disposed,
      log:            (msg) => OllamaChatPanel.log(msg),
    });
    this._team = new TeamManager({
      getWebview: () => this._panel.webview,
      getChatHistory: () => this._chatHistory,
      setChatHistory: (history) => { this._chatHistory = history; this._chatHistories[this._activeSessionId] = this._chatHistory; },
      getChatHistories: () => this._chatHistories,
      getActiveSessionId: () => this._activeSessionId,
      getAgentMessages: () => this._agentExecutor.getAgentMessages(),
      setAgentMessages: (messages) => { this._agentExecutor.setAgentMessages(messages); },
      getAgentMessagesBySession: () => this._agentExecutor.getAgentMessagesBySession(),
      executeAgent: (prompt, model, recordToShortTerm, waTriggered) => this._agentExecutor.handleAgent(prompt, model, recordToShortTerm, waTriggered),
      executeTool: (name, args) => this.executeTool(name, args),
      getSystemContent: (includeAtlassian = true) => this._queryEngine.buildSystemContent(includeAtlassian),
      trackUsage: (model, tokens, multiplier, toolCall) => this.trackUsage(model, tokens, multiplier, toolCall),
      trackLatency: (model, ms) => this.trackLatency(model, ms),
      getAgentTools: () => AGENT_TOOLS,
    }, {
      getOllamaUrls,
      decodeOllamaModel,
      ollamaGenerateStreamWithRetry,
      ollamaGenerateStream,
      ollamaChatStream,
      ollamaChatCallStream,
      copilotStreamText,
      estimateTokens,
      getCopilotMultiplierById,
    });
    this._debate = new DebateEngine({
      getWebview: () => this._panel.webview,
      getChatHistory: () => this._chatHistory,
      setChatHistory: (history) => { this._chatHistory = history; this._chatHistories[this._activeSessionId] = this._chatHistory; },
      getChatHistories: () => this._chatHistories,
      getActiveSessionId: () => this._activeSessionId,
      ensureModelReady: (baseUrl, model) => this._queryEngine.ensureModelReady(baseUrl, model),
    }, {
      getOllamaUrls,
      decodeOllamaModel,
      ollamaChatStream,
    });
    // 載入持久化的使用量統計
    this._usageStats = context.globalState.get<Record<string, { tokens: number; isCopilot: boolean; multiplier: string; calls: number; toolCalls: number }>>('amiAiClaw.usageStats') ?? {};
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
            await this._queryEngine.handleSend(message.prompt, message.model, message.sessionId, message.images as string[] | undefined);
            break;
          case 'insert':
            await this.handleInsert(message.code);
            break;
          case 'toggleStream':
            this._streamMode = !!message.enabled;
            this._panel.webview.postMessage({ type: 'streamMode', enabled: this._streamMode });
            break;
          case 'summarize':
            await this._queryEngine.summarizeText(message.text, message.model);
            break;
          case 'startAuto':
            this._agentExecutor.startAuto(message.prompt, message.model);
            break;
          case 'stopAuto':
            this._agentExecutor.cancelAuto();
            break;
          case 'fetchModels':
            await this._queryEngine.fetchModelsFromServer();
            break;
          case 'testConnection':
            await this._queryEngine.testConnectionStatus();
            break;
          case 'pickFile':
            await this.handlePickFile();
            break;
          case 'webviewReady':
            OllamaChatPanel.log('webviewReady received — calling fetchModelsFromServer');
            this._panel.webview.postMessage({
              type: 'initialState',
              providerInfo: this.buildProviderInfo(),
              streamMode: this._streamMode,
            });
            await this._queryEngine.fetchModelsFromServer();
            break;
          case 'agentSend':
            this.switchChatSession(message.sessionId);
            await this._agentExecutor.handleAgent(message.prompt, message.model);
            break;
          case 'agentStop':
            this._agentExecutor.cancelAgent();
            break;
          case 'permissionResponse': {
            if (this._tools.hasPendingPermission()) {
              if (message.always) { this._tools.addAlwaysAllow(message.category as string); }
              // "本次全允許"：將常見類別全部加入 session allow
              if (message.alwaysSession) {
                for (const c of ['write', 'run', 'read', 'delete']) { this._tools.addAlwaysAllow(c); }
              }
              this._tools.resolvePendingPermission(!!message.allow);
            }
            break;
          }
          case 'fetchTeamModels':
            await this.fetchTeamModels();
            break;
          case 'teamSend':
            this.switchChatSession(message.sessionId);
            this.handleTeamSend(message.prompt, message.models, message.rounds, message.teamExecMode, message.maxParallel, message.roles).catch(() => {});
            break;
          case 'teamStop':
            this._team.cancel();
            break;
          case 'debateSend':
            this.switchChatSession(message.sessionId);
            this.handleDebateSend(message.prompt, message.models, message.rounds).catch(() => {});
            break;
          case 'debateStop':
            this._debate.cancel();
            break;
          case 'waDisconnect':
            this._wa.disconnect().catch(() => {});
            break;
          case 'switchChatSession':
            this.switchChatSession(message.sessionId);
            this._panel.webview.postMessage({ type: 'historyCount', count: this._chatHistory.length, sessionId: this._activeSessionId });
            break;
          case 'applyToFile':
            await this.handleApplyToFile(message.code);
            break;
          case 'clearHistory':
            this._agentExecutor.clearSessionMessages(this.resolveSessionId(message.sessionId));
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
            this._latencyLog = [];
            this._context.globalState.update('amiAiClaw.usageStats', {});
            this._panel.webview.postMessage({ type: 'usageUpdate', stats: {} });
            this._panel.webview.postMessage({ type: 'latencyUpdate', log: [] });
            break;
          case 'statsOpen':
            this._panel.webview.postMessage({ type: 'usageUpdate', stats: this._usageStats });
            this._panel.webview.postMessage({ type: 'latencyUpdate', log: this._latencyLog });
            break;
          case 'debateSwapModel':
            if (message.speaker === 'A' || message.speaker === 'B' || message.speaker === 'J') {
              this._debate.swapModel(message.speaker as 'A' | 'B' | 'J', message.modelId);
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
              this._panel.webview.postMessage({
                type: 'providerInfo',
                providerInfo: this.buildProviderInfo(newModel),
              });
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
            this._agentExecutor.clearSessionMessages(this._activeSessionId);
            await this._queryEngine.handleSend(message.newText as string, message.model as string | undefined, message.sessionId);
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
            this._agentExecutor.initSessionMessages(forkId);
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
      const current = _self.normalizeConfiguredModelId(cfg.get<string>('model') ?? liveModels[0]?.id ?? '');
      // 預熱模型（keep_alive=600s）：讓 Ollama 提前載入，減少第一次請求延遲
      if (current && !current.startsWith('copilot::')) {
        const { url: warmUrl, model: warmModel } = decodeOllamaModel(current, ollamaUrls);
        ollamaWarmupModel(warmUrl, warmModel);
        OllamaChatPanel.log(`Model warmup (init): ${warmModel} @ ${warmUrl}`);
      }
      const normalizedModels = _self.normalizeModelOptions(liveModels, copilotModels0);
      // Push result to webview via postMessage (safe: listener is already registered)
      const r1 = await _webview.postMessage({
        type: 'modelList',
        models: normalizedModels,
        current,
        providerInfo: _self.buildProviderInfo(current, normalizedModels),
      });
      OllamaChatPanel.log('postMessage modelList delivered=' + r1);
      const r2 = await _webview.postMessage({ type: 'connectionStatus', ok: connOk, url: connUrl, message: connMsg });
      OllamaChatPanel.log('postMessage connectionStatus delivered=' + r2);
    })().catch((e) => { OllamaChatPanel.log('Async IIFE error: ' + (e instanceof Error ? e.message : String(e))); });
    // 等 webview 完全載入後，嘗試自動恢復 WhatsApp 連線（若有儲存的憑證）
    setTimeout(() => { this._wa.tryAutoReconnect().catch(() => {}); }, 3000);
  }

  /** Send any message to the webview from outside the class (e.g. from extension.ts commands) */
  public postMessageToWebview(msg: object): void {
    this._panel.webview.postMessage(msg);
  }

  /** 顯示稽核日誌（Quick Pick 清單）—列出最近 200 筆 Agent 工具呼叫紀錄 */
  public showAuditLog(): void {
    const entries = this._tools.getAuditLog();
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

  /**
   * 静默建立（不顯示 panel，不切換焦點）—— VS Code 開啟時自動呼叫，目的是發動 WA 自動重連。
   * 若 panel 已存在則跳過。
   */
  public static createSilent(context: vscode.ExtensionContext) {
    if (OllamaChatPanel.currentPanel) { return; }
    const panel = vscode.window.createWebviewPanel(
      OllamaChatPanel.viewType,
      'AMI-AiClaw',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true }
    );
    // 收起避免發出邊欄進來干擾使用者
    panel.reveal(vscode.ViewColumn.Beside, true);
    try { panel.dispose(); } catch { /* ignore */ }
    // 重建用 preserveFocus=true + retainContext
    const silentPanel = vscode.window.createWebviewPanel(
      OllamaChatPanel.viewType,
      'AMI-AiClaw',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true }
    );
    OllamaChatPanel.currentPanel = new OllamaChatPanel(silentPanel, context);
    OllamaChatPanel.log('AMI-AiClaw 已在背景初始化，WhatsApp 自動重連 開始…');
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
    this._activeSessionId = id;
    this._chatHistory = this._chatHistories[id];
    this._agentExecutor.switchSession(id);
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
    this._disposed = true;
    OllamaChatPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) { const d = this._disposables.pop(); if (d) { d.dispose(); } }
  }

  private getHtmlForWebview(_webview: vscode.Webview): string {
    return getHtmlForWebview(_webview);
  }

  private async handleTeamSend(prompt: string, selectedModels?: string[], rounds?: string | number, teamExecMode?: string, maxParallel?: number, roles?: string[]): Promise<void> {
    return this._team.handleTeamSend(prompt, selectedModels, rounds, teamExecMode, maxParallel, roles);
  }


  private async handleDebateSend(prompt: string, selectedModels?: string[], rounds?: string | number): Promise<void> {
    return this._debate.handleDebateSend(prompt, selectedModels, rounds);
  }

  private async fetchTeamModels(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('amiAiClaw');
    const ollamaUrls = getOllamaUrls(cfg);
    const teamModels: { id: string; label: string; provider: string; providerLabel: string; multiplier?: string }[] = [];
    // Ollama models — all servers
    for (const url of ollamaUrls) {
      try {
        const models = await ollamaListModels(url);
        for (const m of models) {
          teamModels.push({
            id: encodeOllamaModelId(url, m, ollamaUrls),
            label: ollamaDisplayLabel(url, m, ollamaUrls),
            provider: 'ollama',
            providerLabel: 'Ollama',
          });
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
        if (!seen.has(id)) {
          seen.add(id);
          teamModels.push({
            id,
            label: cleanName,
            provider: 'copilot',
            providerLabel: 'Copilot',
            multiplier: getCopilotMultiplier(m),
          });
        }
      }
    } catch { /* Copilot not available */ }
    const _rolesConfig = cfg.get<Array<{key:string;label:string;emoji:string;color:string;systemPrompt:string}>>('teamRoles', []);
    this._panel.webview.postMessage({ type: 'teamRolesConfig', roles: _rolesConfig });
    this._panel.webview.postMessage({ type: 'teamModelList', models: teamModels });
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
      this._agentExecutor.clearSessionMessages(this._activeSessionId);
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

  /** 要求使用者確認敏感操作，回傳是否允許。
   *  - toolName: 工具名稱（可選），用於 settings toolAlwaysAllow/toolAlwaysConfirm 比對。
   *  - 設定 toolAlwaysAllow：含 category 或 toolName 則自動允許（不彈確認對話框）。
   *  - 設定 toolAlwaysConfirm：含 toolName 則每次必問（不能被 session 永遠允許覆蓋）。
   */
  private requestPermission(category: string, description: string, toolName = '', diff?: ToolPermissionDiff): Promise<boolean> {
    return this._tools.requestPermission(category, description, toolName, diff);
  }

  private async executeTool(name: string, args: Record<string, unknown>): Promise<string> {
    return this._tools.executeTool(name, args);
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

}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  thinking?: string;
  tool_calls?: Array<{ id?: string; function: { name: string; arguments: Record<string, unknown> | string } }>;
  tool_call_id?: string;
  images?: string[];
}

interface WebviewModelOption {
  id: string;
  label: string;
  provider: string;
  providerLabel: string;
  multiplier?: string;
}

interface ProviderInfo {
  id: string;
  label: string;
  modelId: string;
  displayName: string;
}

export const AGENT_TOOLS = [
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
  { type: 'function', function: { name: 'jira_search', description: '用 JQL 搜尋 Jira Issues，支援列出指定人的工作項目（assignee/reporter）、專案、狀態過濾。例：列出我的/某人的待辦、列出某專案所有進行中 Issue。', parameters: { type: 'object', properties: { jql: { type: 'string', description: '完整 JQL 查詢語句（優先）。例：assignee = currentUser() AND status != Done ORDER BY updated DESC' }, assignee: { type: 'string', description: '指派人帳號名稱或 displayName（可選，自動組 JQL）' }, reporter: { type: 'string', description: '建立人帳號名稱（可選）' }, project: { type: 'string', description: '專案 Key，例如 BIOS、UOEM2（可選）' }, status: { type: 'string', description: '狀態篩選，例如 "In Progress"、"To Do"、"Done"（可選）' }, text: { type: 'string', description: '全文搜尋關鍵字（可選）' }, max_results: { type: 'number', description: '最多回傳筆數（預設 20，最多 50）' } }, required: [] } } },
  { type: 'function', function: { name: 'jira_fetch', description: '【立即執行】直接呼叫 Jira REST API 取得 Issue 完整詳情（Summary、Description、Status、Assignee、Priority、最近留言、附件清單）供分析。看到 Jira Key 就呼叫，禁止先說「我將查詢」等意圖語句而不行動。', parameters: { type: 'object', properties: { issue_key: { type: 'string', description: 'Jira Issue Key，例如 UOEM2-3476' } }, required: ['issue_key'] } } },
  { type: 'function', function: { name: 'jira_attachment_download', description: '下載 Jira Issue 附件（URL 來自 jira_fetch 結果的 url= 欄位）。ZIP 檔案自動解壓縮並列出內容及文字檔內容；文字/patch/log 檔直接顯示。', parameters: { type: 'object', properties: { url: { type: 'string', description: '附件下載 URL（來自 jira_fetch 附件清單的 url= 後方網址）' }, filename: { type: 'string', description: '指定儲存檔名（可選，預設從 URL 推斷）' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'jira_open', description: '在 VS Code 中開啟 Jira Issue UI 面板（不回傳內容，純介面操作）。需要 Issue 內容供分析時請用 jira_fetch 而非此工具。', parameters: { type: 'object', properties: { issue_key: { type: 'string', description: 'Jira Issue Key，例如 BIOS-123 或 PROJ-456' } }, required: ['issue_key'] } } },
  { type: 'function', function: { name: 'jira_log_time', description: '記錄 Jira Issue 工時（Worklog）。支援 "16h"、"2h 30m"、"1d" 等格式，可指定日期（today/yesterday/YYYY-MM-DD），預設今天。', parameters: { type: 'object', properties: { issue_key: { type: 'string', description: 'Jira Issue Key，例如 BIOS-123' }, time_spent: { type: 'string', description: '工時，例如 "16h"、"2h 30m"、"1d"、"90m"' }, date: { type: 'string', description: '日期（可選）："today"（預設）、"yesterday"、或 "YYYY-MM-DD"' }, comment: { type: 'string', description: '備註（可選）' } }, required: ['issue_key', 'time_spent'] } } },
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
  { type: 'function', function: { name: 'whatsapp_status', description: '查詢目前 WhatsApp Web 連線狀態（_waConnected、_waSock、creds.json 是否存在、已儲存電話號碼等），用於診斷連線或收訊問題。', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'whatsapp_connect', description: '連接個人 WhatsApp 帳號（WhatsApp Web 協議）。若已有儲存的 session 且仍有效，直接重連無需掃描 QR Code；session 過期時才顯示 QR 供掃描。重開 VS Code 後 session 會自動恢復（状態列顯示 💚）。若需強制重新綁定新帳號，傳入 force:true。', parameters: { type: 'object', properties: { force: { type: 'boolean', description: '強制清除已儲存的 session 並顯示全新 QR Code（用於切換帳號或 session 無法自動恢復時）。預設 false。' } }, required: [] } } },
  { type: 'function', function: { name: 'whatsapp_disconnect', description: '中斷 WhatsApp Web QR 綁定連線，登出目前裝置。', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'whatsapp_save_credentials', description: '儲存 Meta WhatsApp Business API 的 Access Token 和 Phone Number ID 到 VS Code（僅本機儲存，不寫入 settings.json）。儲存後 whatsapp_send / whatsapp_send_template 即可使用，無需手動設定。', parameters: { type: 'object', properties: { access_token: { type: 'string', description: 'Meta WhatsApp Business Cloud API Access Token' }, phone_number_id: { type: 'string', description: 'Meta 商業管理平台的 Phone Number ID（純數字）' } }, required: ['access_token', 'phone_number_id'] } } },
  { type: 'function', function: { name: 'whatsapp_send', description: '發送 WhatsApp 文字訊息至指定手機號碼。若已透過 QR Code 綁定（whatsapp_connect）則優先使用個人帳號連線；否則使用 Meta WhatsApp Business Cloud API（需設定 whatsappAccessToken）。', parameters: { type: 'object', properties: { to: { type: 'string', description: '收件人手機號碼，必須含國碼，例如 +886912345678' }, message: { type: 'string', description: '要發送的文字訊息內容' } }, required: ['to', 'message'] } } },
  { type: 'function', function: { name: 'whatsapp_send_template', description: '透過 Meta WhatsApp Business Cloud API 發送已審核的樣板訊息。適用於初次聯絡或 24 小時窗口外的訊息（不受 24 小時限制）。需要先建立並審核樣板。', parameters: { type: 'object', properties: { to: { type: 'string', description: '收件人手機號碼，必須含國碼' }, template_name: { type: 'string', description: 'Meta 商業管理平台已審核的樣板名稱' }, language_code: { type: 'string', description: '樣板語言碼（預設 zh_TW，可選 en_US、zh_CN 等）' }, body_params: { type: 'array', items: { type: 'string' }, description: '樣板主體 {{1}} {{2}} 參數列表（可選）' } }, required: ['to', 'template_name'] } } },
  { type: 'function', function: { name: 'jenkins_build', description: '觸發 Jenkins 任動建置（Build）並回傳排隊 / 映射編號。依設定自動取得 CSRF Crumb。預設連接 localdev.visualebios 。', parameters: { type: 'object', properties: { job: { type: 'string', description: 'Jenkins Job 名稱（預設使用 amiAiClaw.jenkinsDefaultJob，未設定則 SeamlessBuild）' }, params: { type: 'object', description: 'Build 參數（key-value，可選），有參數自動使用 buildWithParameters 端點', additionalProperties: { type: 'string' } }, wait: { type: 'boolean', description: '是否等待 Job 開始建置並回傳編號/狀態（預設 true，最多等待 60s）' } }, required: [] } } },
  { type: 'function', function: { name: 'jenkins_status', description: '查詢 Jenkins Job 最新 Build 或指定 Build 編號的狀態及 Console 輸出。預設連接 localdev.visualebios 。', parameters: { type: 'object', properties: { job: { type: 'string', description: 'Jenkins Job 名稱（預設使用 amiAiClaw.jenkinsDefaultJob）' }, build_number: { type: 'number', description: 'Build 編號（可選，預設 lastBuild）' }, include_log: { type: 'boolean', description: '是否包含 Console 輸出（預設 true）' }, log_lines: { type: 'number', description: 'Console 輸出最後幾行（預設 100，最大 500）' } }, required: [] } } },
  { type: 'function', function: { name: 'read_workspace', description: '遞迴讀取整個工作區所有原始碼檔案內容，回傳每個檔案路徑與完整內容。適合需要全域理解程式庫結構、跨檔案重構、全域搜尋替換等任務。大型工作區請透過 include/exclude 縮小範圍以避免超出 token 上限。', parameters: { type: 'object', properties: { include: { type: 'string', description: 'glob 檔案樣式（預設 **/*.{ts,js,tsx,jsx,py,cs,java,go,rs,cpp,c,h,md,json,yaml,yml,txt}）' }, exclude: { type: 'string', description: '額外排除的 glob 樣式（逗號分隔，預設已排除 node_modules/.git/dist/out/build）' }, max_file_kb: { type: 'number', description: '單檔最大讀取 KB（預設 128，超過截斷）' }, max_total_kb: { type: 'number', description: '所有檔案合計最大 KB（預設 512，超過停止並回報）' } }, required: [] } } },
];

export function getToolIcon(name: string): string {
  const m: Record<string, string> = { get_active_file: '📝', read_file: '📄', write_file: '💾', replace_in_file: '✏️', list_dir: '📁', run_terminal: '⚡', search_workspace: '🔍', delete_file: '🗑️', create_dir: '📂', run_command: '▶️', fetch_url: '🌐', open_browser: '💻', manage_todo: '📝', vscode_action: '🎨', jira_search: '🔍', jira_fetch: '📋', jira_open: '🎫', jira_create: '🎫', jira_transition: '🔄', jira_log_time: '⏱️', jira_attachment_download: '📎', bb_create_pr: '🔀', rovo_ask: '🤖', run_python: '🐍', git_status: '📊', git_diff: '🔀', git_log: '📜', git_commit: '✅', http_request: '📡', db_query: '🗃️', search_regex: '🔎', agentic_file_search: '🧠', lint_fix: '🧹', run_tests: '🧪', browser_navigate: '🧭', browser_screenshot: '📸', browser_script: '🎭', generate_docs: '📚', refactor_suggest: '🔬', whatsapp_connect: '📱', whatsapp_disconnect: '📵', whatsapp_status: '📶', whatsapp_save_credentials: '🔐', whatsapp_send: '💬', whatsapp_send_template: '📣', jenkins_build: '🛠️', jenkins_status: '📊', read_workspace: '🗂️' };
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
    case 'jira_search': {
      const jqlLabel = (args.jql as string) || [args.assignee && 'assignee='+args.assignee, args.reporter && 'reporter='+args.reporter, args.project && 'project='+args.project, args.status && 'status='+args.status, args.text && 'text~'+args.text].filter(Boolean).join(' ');
      return `Jira 搜尋: ${jqlLabel}`;
    }
    case 'jira_fetch': return `Jira 從 API 取得: ${args.issue_key}`;
    case 'jira_attachment_download': return `Jira 附件下載: ${(args.filename as string) || path.basename(String(args.url || '')).split('?')[0]}`;
    case 'jira_open': return `Jira 開啟 Issue: ${args.issue_key}`;
    case 'jira_create': return `Jira 建立 Issue${args.summary ? ': ' + args.summary : ''}`;
    case 'jira_log_time': return `Jira 記錄工時: ${args.issue_key} ${args.time_spent}${args.date ? ' @ ' + args.date : ''}${args.comment ? ' - ' + args.comment : ''}`;
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
    case 'read_workspace': return `讀取整個工作區${args.include ? ' [' + args.include + ']' : ''}${args.max_total_kb ? '（上限 ' + args.max_total_kb + ' KB）' : ''}`;
    default: return name;
  }
}

/** Docker 模式瀏覽器工具執行助手：透過 stdin 將 Python 程式碼傳送至容器，回傳 stdout。
 *  使用 `docker run --rm -i <image> python -` ，不需要挂載影約或在害端安裝 playwright。
 */
/** 過濾輸出文字中的敏感資訊（API key、token、密碼等），避免模型學習或外洩憑證。 */
export function filterSensitiveInfo(text: string): string {
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
export function estimateTokens(text: string): number {
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

export function ollamaChatCallStream(
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

/**
 * OpenAI-compatible /v1/chat/completions 串流呼叫（支援 tool_calls）。
 * 模型 ID 格式：openai::http://host:port||model-name 或 openai::model-name（使用預設 baseUrl）
 */
function openaiCompatChatCallStream(
  baseUrl: string, model: string, messages: ChatMessage[], tools: unknown[],
  onTextChunk?: (chunk: string) => void,
  onStats?: (tokens: number, tps: number) => void
): Promise<ChatMessage> {
  return new Promise((resolve, reject) => {
    try {
      const url = new URL('/v1/chat/completions', baseUrl);
      // 轉換 ChatMessage 格式為 OpenAI 格式
      const oaiMessages = messages.map(m => {
        if (m.role === 'tool') {
          return { role: 'tool' as const, content: m.content ?? '', tool_call_id: m.tool_call_id ?? '' };
        }
        if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
          return {
            role: 'assistant' as const,
            content: m.content ?? null,
            tool_calls: m.tool_calls.map(tc => ({
              id: tc.id ?? tc.function.name,
              type: 'function' as const,
              function: {
                name: tc.function.name,
                arguments: typeof tc.function.arguments === 'string'
                  ? tc.function.arguments
                  : JSON.stringify(tc.function.arguments),
              },
            })),
          };
        }
        return { role: m.role as 'system' | 'user' | 'assistant', content: m.content ?? '' };
      });
      // 轉換 tools 為 OpenAI 格式（與 Ollama 格式相同）
      const oaiTools = tools.length > 0 ? tools : undefined;
      const bodyObj: Record<string, unknown> = { model, messages: oaiMessages, stream: true };
      if (oaiTools) { bodyObj.tools = oaiTools; bodyObj.tool_choice = 'auto'; }
      const body = JSON.stringify(bodyObj);
      const protocol = url.protocol === 'https:' ? https : http;
      const options: http.RequestOptions = {
        hostname: url.hostname,
        port: url.port ? parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Accept': 'text/event-stream' },
      };
      let lineBuffer = '';
      let accContent = '';
      // tool_calls 是增量合併結構（index-based）
      const toolCallBuilders: Map<number, { id: string; name: string; args: string }> = new Map();
      let promptTokens = 0; let completionTokens = 0; const startMs = Date.now();
      const req = protocol.request(options, (res) => {
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          let errBody = '';
          res.setEncoding('utf8');
          res.on('data', (d: string) => { errBody += d; });
          res.on('end', () => {
            try { const j = JSON.parse(errBody); reject(new Error('OpenAI API 錯誤：' + (j.error?.message ?? 'HTTP ' + res.statusCode))); }
            catch { reject(new Error('OpenAI API HTTP ' + res.statusCode + ': ' + errBody.slice(0, 200))); }
          });
          return;
        }
        res.setEncoding('utf8');
        res.on('data', (data: string) => {
          lineBuffer += data;
          const lines = lineBuffer.split('\n');
          lineBuffer = lines.pop() ?? '';
          for (const line of lines) {
            const t = line.trim();
            if (!t || !t.startsWith('data:')) continue;
            const payload = t.slice(5).trim();
            if (payload === '[DONE]') continue;
            try {
              const chunk = JSON.parse(payload) as {
                choices?: Array<{
                  delta?: {
                    content?: string | null;
                    tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>;
                  };
                  finish_reason?: string;
                }>;
                usage?: { prompt_tokens?: number; completion_tokens?: number };
              };
              const delta = chunk.choices?.[0]?.delta;
              if (delta?.content) { accContent += delta.content; if (onTextChunk) onTextChunk(delta.content); }
              if (delta?.tool_calls) {
                for (const tc of delta.tool_calls) {
                  if (!toolCallBuilders.has(tc.index)) { toolCallBuilders.set(tc.index, { id: tc.id ?? '', name: tc.function?.name ?? '', args: '' }); }
                  const b = toolCallBuilders.get(tc.index)!;
                  if (tc.id) b.id = tc.id;
                  if (tc.function?.name) b.name += tc.function.name;
                  if (tc.function?.arguments) b.args += tc.function.arguments;
                }
              }
              if (chunk.usage) {
                promptTokens = chunk.usage.prompt_tokens ?? 0;
                completionTokens = chunk.usage.completion_tokens ?? 0;
              }
            } catch { /* partial */ }
          }
        });
        res.on('end', () => {
          if (onStats && completionTokens > 0) {
            const elapsed = (Date.now() - startMs) / 1000;
            onStats(promptTokens + completionTokens, elapsed > 0 ? completionTokens / elapsed : 0);
          }
          if (toolCallBuilders.size > 0) {
            const tool_calls = Array.from(toolCallBuilders.entries())
              .sort(([a], [b]) => a - b)
              .map(([, b]) => ({
                id: b.id || b.name,
                function: {
                  name: b.name,
                  arguments: (() => { try { return JSON.parse(b.args) as Record<string, unknown>; } catch { return {}; } })(),
                },
              }));
            resolve({ role: 'assistant', content: accContent || null, tool_calls });
          } else {
            resolve({ role: 'assistant', content: accContent || null });
          }
        });
        res.on('error', (e: Error) => reject(e));
      });
      req.on('error', (e: Error) => reject(new Error(`無法連線到 OpenAI-compatible server (${baseUrl})：${e.message}`)));
      req.setTimeout(600000, () => { req.destroy(new Error('OpenAI-compatible 呼叫逾時 (600s)')); });
      req.write(body); req.end();
    } catch (e) { reject(e); }
  });
}

export function getCopilotMultiplier(m: vscode.LanguageModelChat): string {
  const id = m.id.toLowerCase();
  const fam = (m.family || '').toLowerCase();
  if (id === 'auto' || fam === 'auto') return '10% off';
  if (id.includes('opus') || fam.includes('opus')) return '3x';
  if (id.includes('mini') || fam.includes('mini')) return '0x';
  if ((id.startsWith('gpt-4o') && !id.includes('mini')) || fam === 'gpt-4o' || id === 'gpt-4o') return '0x';
  return '1x';
}

export function getCopilotMultiplierById(id: string): string {
  const i = id.toLowerCase();
  if (i === 'auto') { return '10% off'; }
  if (i.includes('opus')) { return '3x'; }
  if (i.includes('mini')) { return '0x'; }
  if (i.startsWith('gpt-4o') && !i.includes('mini')) { return '0x'; }
  return '1x';
}

export async function copilotStreamText(
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

  // 防禦性過濾：移除孤立的 tool_result（找不到對應 tool_use 的 tool 訊息），避免 Bedrock/Anthropic 400 錯誤
  const sanitized = messages.filter((m, i) => {
    if (m.role !== 'tool') { return true; }
    // 往前找最近的 assistant 訊息，確認其 tool_calls 包含此 tool_call_id
    let ai = i - 1;
    while (ai >= 0 && messages[ai].role === 'tool') { ai--; }
    return ai >= 0 && messages[ai].role === 'assistant' &&
      (messages[ai].tool_calls ?? []).some(tc => (tc.id ?? tc.function.name) === m.tool_call_id);
  });

  // 正確轉換每種 role 為 VS Code LM API 對應的 Part 型別
  const vmMsgs: vscode.LanguageModelChatMessage[] = [];
  for (const m of sanitized) {
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
  // strip registry prefix (hf.co/user/) 後取純模型名稱
  const m = model.toLowerCase().replace(/^hf\.co\/[^/]+\//i, '').replace(/^.*\//, '');
  // 明確不支援 thinking 的關鍵字（coder / instruct 變體）
  if (m.includes('coder') || m.includes('-instruct') || m.includes(':instruct')) { return false; }
  // 明確支援 thinking 的模型
  return m.startsWith('deepseek-r1') || m.startsWith('deepseek-r2') ||
    m.startsWith('qwq') ||
    // qwen3 只有 thinking 系列才支援，判斷方式：名稱不含 coder/instruct 且根模型就叫 qwen3
    (m.startsWith('qwen3') && !m.includes('coder')) ||
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
export async function ollamaGenerateStreamWithRetry(
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

export function ollamaGenerateStream(
  baseUrl: string, model: string, prompt: string,
  onResponseChunk: (chunk: string) => void,
  onThinkChunk?: (chunk: string) => void,
  onStats?: (tokens: number, tps: number) => void,
  images?: string[]
): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      const url = new URL('/api/generate', baseUrl);
      const params: Record<string, unknown> = { model, prompt, stream: true };
      if (supportsThinking(model)) { params.think = true; }
      if (images && images.length > 0) { params.images = images; }
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

export function ollamaChatStream(
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
export function getOllamaUrls(cfg: vscode.WorkspaceConfiguration): string[] {
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

/** 解碼 Ollama model ID：多伺服器格式為 "http://host:port||modelname"，單伺服器為 "modelname"。
 *  OpenAI-compatible 格式："openai::http://host:port||modelname" 或 "openai::modelname"（使用 fallbackUrls[0]）。
 *  解碼後 model 保留 openai:: 前綴供後續路由判斷。
 */
export function decodeOllamaModel(modelId: string, fallbackUrls: string[]): { url: string; model: string } {
  // OpenAI-compatible 格式：openai::http://host:port||modelname 或 openai::modelname
  if (modelId.startsWith('openai::')) {
    const inner = modelId.slice('openai::'.length);
    const sep = inner.indexOf('||');
    if (sep !== -1) return { url: inner.slice(0, sep), model: 'openai::' + inner.slice(sep + 2) };
    return { url: fallbackUrls[0] ?? 'http://localhost:11434', model: 'openai::' + inner };
  }
  const sep = modelId.indexOf('||');
  if (sep !== -1) return { url: modelId.slice(0, sep), model: modelId.slice(sep + 2) };
  return { url: fallbackUrls[0] ?? 'http://localhost:11434', model: modelId };
}

/** 編碼 Ollama model ID：多伺服器時加 URL 前綴，單伺服器時返回原始 model 名稱（向後相容）。 */
export function encodeOllamaModelId(url: string, model: string, allUrls: string[]): string {
  return allUrls.length > 1 ? `${url}||${model}` : model;
}

/** 顯示標籤：多伺服器時加上 [hostname:port] 前綴。 */
export function ollamaDisplayLabel(url: string, model: string, allUrls: string[]): string {
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
