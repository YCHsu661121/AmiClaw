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
import { HeartbeatService } from './services/HeartbeatService';
import { ToolExecutor, type ToolPermissionDiff } from './tools/ToolExecutor';
import { ALL_TOOLS, getToolIcon, formatToolTitle } from './tools/ToolRegistry';
import { TeamManager } from './team/TeamManager';
import { DebateEngine } from './debate/DebateEngine';
import { QueryEngine, QueryEngineServices } from './chat/QueryEngine';
import * as memdir from './memdir/memdir';
import { AgentExecutor } from './chat/AgentExecutor';
import type { AgentExecutorServices, AgentExecutorChatMessage } from './chat/AgentExecutor';
import { loadSessionNotes, saveSessionNotes } from './services/SessionNotes';
import { PanelLike, WebviewViewAdapter } from './panels/ChatPanelAdapter';
import { setAutoPilotActive, setAutoPilotEnabledBySetting, isAutoPilotActive } from './autopilot';
import { getCurrentContextDepth, invalidateWorkspaceDigestCache } from './context/WorkspaceDigest';

// ── PanelLike：WebviewPanel 與 WebviewView 共用介面（搬到 ./panels/ChatPanelAdapter） ─

// (Copied implementation from top-level file)
export class OllamaChatPanel {
  public static currentPanel: OllamaChatPanel | undefined;
  public static readonly viewType = 'amiAiClaw.chat';
  private static _log: vscode.OutputChannel;
  private static _diag: vscode.OutputChannel;
  /** Called by extension.ts to keep sidebar in sync */
  public static onSessionsChanged?: (sessions: { id: string; title: string }[], activeId: string) => void;
  /** 工作檔對話記錄回呼：extension.ts 訂閱後，每次 AgentExecutor / QueryEngine 完成都會收到 { prompt, response } */
  public static onTodoComplete?: (prompt: string, response: string) => void;

  private readonly _panel: PanelLike;
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
  private _usageStats: Record<string, { tokens: number; inputTokens: number; outputTokens: number; costUsd: number; isCopilot: boolean; multiplier: string; calls: number; toolCalls: number }> = {};
  private _sessionCostUsd = 0;
  /** 延遲記錄：每次請求完成時寫入 { model, ms, ts } */
  private _latencyLog: Array<{ model: string; ms: number; ts: number }> = [];
  // 短期對話自動持久化相關
  private _chatDirty = false;
  private _persistTimer: NodeJS.Timeout | null = null;
  private _agentPersistTimer: NodeJS.Timeout | null = null;
  private _webviewSessionsPersistTimer: NodeJS.Timeout | null = null;
  private _latestWebviewSessions: unknown = null; // dispose 時強制 flush 用
  private _ltmCache = '';  // eager-loaded at init; avoids async race in getLongTermMemory()
  private _rulesCache = '';  // eager-loaded RULES.md (layer-1, always injected)
  // ── 工作檔對話記錄模式 ────────────────────────────────────────────────────────
  private _todoModePrompt: string | undefined;   // 非 undefined 表示目前在 todo 模式
  private _todoAccumulator = '';                  // 累積 agentChunk / assistant 文字
  private _persistDebounceMs = 500;
  private _maxMessagesPerSession = 500;

  private _readyPromise: Promise<void>;
  private _resolveReady!: () => void;
  private _isWebviewReady = false;
  private _messageQueue: object[] = []; // buffer messages until webviewReady is received

  public async waitForWebviewReady(): Promise<void> {
    return this._readyPromise;
  }

  private static formatError(error: unknown): string {
    if (error instanceof Error) {
      return error.stack || error.message;
    }
    if (typeof error === 'string') {
      return error;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  private static getDiagnosticChannel(): vscode.OutputChannel {
    if (!OllamaChatPanel._diag) {
      OllamaChatPanel._diag = vscode.window.createOutputChannel('AmiClaw Diagnostics');
    }
    return OllamaChatPanel._diag;
  }

  public static reportDiagnostic(msg: string, error?: unknown): void {
    const channel = OllamaChatPanel.getDiagnosticChannel();
    channel.appendLine(`[${new Date().toISOString()}] ${msg}`);
    if (error !== undefined) {
      for (const line of OllamaChatPanel.formatError(error).split(/\r?\n/)) {
        channel.appendLine(`  ${line}`);
      }
      console.error(`[AmiClaw] ${msg}`, error);
    }
  }

  public static revealDiagnostics(preserveFocus = true): void {
    OllamaChatPanel.getDiagnosticChannel().show(preserveFocus);
  }

  static log(msg: string): void {
    if (!vscode.workspace.getConfiguration('amiAiClaw').get<boolean>('enableDebugLog', false)) { return; }
    if (!OllamaChatPanel._log) {
      OllamaChatPanel._log = vscode.window.createOutputChannel('AmiClaw');
    }
    OllamaChatPanel._log.appendLine(`[${new Date().toISOString()}] ${msg}`);
  }

  // 建立一個 Proxy 用以攔截陣列變更並標記為需要儲存
  private createHistoryProxy(arr: ChatMessage[], sessionId: string): ChatMessage[] {
    const that = this;
    const target = Array.isArray(arr) ? arr : [];
    const handler: ProxyHandler<ChatMessage[]> = {
      set(t, prop, value) {
        const res = Reflect.set(t, prop, value);
        // 設定長度或數字索引時視為修改
        if (typeof prop === 'string' && (prop === 'length' || /^\d+$/.test(prop))) {
          that._chatDirty = true;
          that.schedulePersistChatHistories();
        }
        return res;
      },
      get(t, prop, receiver) {
        const v = Reflect.get(t, prop, receiver);
        if (typeof v === 'function') {
          const name = String(prop);
          if (['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin'].includes(name)) {
            return function (...args: any[]) {
              const r = (Array.prototype as any)[name].apply(t, args);
              that._chatDirty = true;
              that.schedulePersistChatHistories();
              return r;
            };
          }
        }
        return v;
      }
    };
    const proxy = new Proxy(target, handler) as ChatMessage[];
    (proxy as any).__isProxy = true;
    return proxy;
  }

  // 包裝所有已存在的 histories 為 proxy
  private wrapAllHistories(): void {
    for (const [id, arr] of Object.entries(this._chatHistories)) {
      if (!arr || !(arr as any).__isProxy) {
        this._chatHistories[id] = this.createHistoryProxy(arr || [], id);
      }
    }
    // 確保目前 active session 指向 proxy
    if (!this._chatHistories[this._activeSessionId]) {
      this._chatHistories[this._activeSessionId] = this.createHistoryProxy([], this._activeSessionId);
    }
    this._chatHistory = this._chatHistories[this._activeSessionId];
  }

  private schedulePersistChatHistories(): void {
    if (this._persistTimer) { clearTimeout(this._persistTimer); }
    this._persistTimer = setTimeout(() => { void this.persistChatHistories(); }, this._persistDebounceMs);
  }

  private async persistChatHistories(): Promise<void> {
    if (!this._chatDirty) return;
    try {
      const copy: Record<string, ChatMessage[]> = {};
      for (const [sid, arr] of Object.entries(this._chatHistories)) {
        const msgs = Array.isArray(arr) ? arr.slice(-this._maxMessagesPerSession) : [];
        copy[sid] = msgs.map(m => ({ role: m.role, content: (m.content ?? '').slice(0, 10000) }));
      }
      // 改用 workspaceState 实現工作區隔離
      await this._context.workspaceState.update('amiAiClaw.chatHistories', copy);
      this._chatDirty = false;
    } catch (e) {
      OllamaChatPanel.log('persistChatHistories error: ' + (e instanceof Error ? e.message : String(e)));
    }
  }

  private scheduleWebviewSessionsPersist(data: unknown): void {
    this._latestWebviewSessions = data;
    if (this._webviewSessionsPersistTimer) { clearTimeout(this._webviewSessionsPersistTimer); }
    this._webviewSessionsPersistTimer = setTimeout(() => {
      void this._context.workspaceState.update('amiAiClaw.webviewSessions', data);
    }, 1500);
  }

  private scheduleAgentPersist(): void {
    if (this._agentPersistTimer) { clearTimeout(this._agentPersistTimer); }
    this._agentPersistTimer = setTimeout(() => { void this.persistAgentMessages(); }, 2000);
  }

  private async persistAgentMessages(): Promise<void> {
    try {
      const msgs = this._agentExecutor.getAgentMessagesBySession();
      const copy: Record<string, { role: string; content: string | null }[]> = {};
      for (const [sid, arr] of Object.entries(msgs)) {
        if (!Array.isArray(arr) || arr.length === 0) continue;
        // 只儲存最近 60 則，且不包含工具呼叫結果（避免儲存過大）
        copy[sid] = arr.slice(-60)
          .filter(m => m.role === 'user' || m.role === 'assistant' || m.role === 'system')
          .map(m => ({ role: m.role, content: (m.content ?? '').slice(0, 8000) }));
      }
      await this._context.workspaceState.update('amiAiClaw.agentMessages', copy);
    } catch (e) {
      OllamaChatPanel.log('persistAgentMessages error: ' + (e instanceof Error ? e.message : String(e)));
    }
  }

  /** 記錄一次 API 呼叫的 token 使用量，並推送更新到前端。 */
  private trackUsage(model: string, tokens: number, multiplier = '', toolCall = false, inputTokens?: number, outputTokens?: number): void {
    if (!toolCall && (!tokens || tokens <= 0)) { return; }
    const { calcCostUsd } = require('./utils/ModelPricing') as typeof import('./utils/ModelPricing');
    const inTok  = inputTokens  ?? Math.round(tokens * 0.7);
    const outTok = outputTokens ?? Math.round(tokens * 0.3);
    const callCost = tokens > 0 ? calcCostUsd(model, inTok, outTok) : 0;
    const isCopilot = model.startsWith('copilot::') || model.startsWith('copilot/');
    const key = model.replace(/^copilot[::\/]+/, '');
    const existing = this._usageStats[key];
    if (existing) {
      existing.tokens      += tokens;
      existing.inputTokens  += inTok;
      existing.outputTokens += outTok;
      existing.costUsd      += callCost;
      if (tokens > 0) existing.calls = (existing.calls || 0) + 1;
      if (toolCall) existing.toolCalls = (existing.toolCalls || 0) + 1;
    } else {
      this._usageStats[key] = { tokens, inputTokens: inTok, outputTokens: outTok, costUsd: callCost, isCopilot, multiplier, calls: tokens > 0 ? 1 : 0, toolCalls: toolCall ? 1 : 0 };
    }
    this._sessionCostUsd += callCost;
    // 持久化累計值
    const saved = this._context.globalState.get<Record<string, { tokens: number; inputTokens: number; outputTokens: number; costUsd: number; isCopilot: boolean; multiplier: string; calls: number; toolCalls: number }>>('amiAiClaw.usageStats') ?? {};
    const sk = saved[key];
    if (sk) { sk.tokens += tokens; sk.inputTokens = (sk.inputTokens ?? 0) + inTok; sk.outputTokens = (sk.outputTokens ?? 0) + outTok; sk.costUsd = (sk.costUsd ?? 0) + callCost; if (tokens > 0) sk.calls = (sk.calls || 0) + 1; if (toolCall) sk.toolCalls = (sk.toolCalls || 0) + 1; }
    else { saved[key] = { tokens, inputTokens: inTok, outputTokens: outTok, costUsd: callCost, isCopilot, multiplier, calls: tokens > 0 ? 1 : 0, toolCalls: toolCall ? 1 : 0 }; }
    this._context.globalState.update('amiAiClaw.usageStats', saved);
    this._panel.webview.postMessage({ type: 'usageUpdate', stats: this._usageStats, totalCostUsd: this._sessionCostUsd });
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
      ...ollamaModels.map((model) => {
        const isOai = model.id.startsWith('openai::');
        return {
          id: model.id,
          label: model.label,
          provider: isOai ? 'openai' : 'ollama',
          providerLabel: isOai ? 'OpenAI Compatible' : 'Ollama',
        };
      }),
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

  private constructor(panel: PanelLike, context: vscode.ExtensionContext) {
    this._panel = panel;
    // Promise resolves when webview posts 'webviewReady'; callers use waitForWebviewReady()
    this._readyPromise = new Promise<void>(resolve => { this._resolveReady = resolve; });
    const hbSub = HeartbeatService.getInstance().onTick(() => {
      this.broadcastHeartbeat();
    });
    this._disposables.push(hbSub);

    // WA 定期回報：agent 執行中每 60s 推送一次進度（12 ticks × 5s）
    let _hbWaTick = 0;
    const hbWaSub = HeartbeatService.getInstance().onTick(() => {
      _hbWaTick++;
      if (_hbWaTick < 12) return;
      _hbWaTick = 0;
      const info = HeartbeatService.getInstance().getAgentInfo();
      if (!info.running || !this._wa?.connected) return;
      const elapsedMin = info.startedAt ? ((Date.now() - info.startedAt) / 60000).toFixed(1) : '?';
      const shadowNote = info.shadowRunning ? '（影子督促審查中）' : info.shadowCount > 0 ? `（已督促 ${info.shadowCount} 次）` : '';
      this._wa.notifyOwner(`🤖 Agent 進行中 — step ${info.step} | ${elapsedMin}m elapsed | ${info.lastActivity}${shadowNote}`);
    });
    this._disposables.push(hbWaSub);
    HeartbeatService.getInstance().start();


    this._context = context;
    this._tools = new ToolExecutor({
      postToWebview: (msg) => this._postToWebview(msg as Record<string, unknown>),
      getExtensionContext: () => this._context,
      isWaAgentMode: () => this._wa?.agentMode ?? false,
      log: (msg) => OllamaChatPanel.log(msg),
      getActiveSessionId: () => this._activeSessionId,
      handleWhatsAppTool: (name, args) => this._wa.handleTool(name, args),
      getAutoPilotServices: () => {
        const cfg = vscode.workspace.getConfiguration('amiAiClaw');
        const urls = getOllamaUrls(cfg);
        const configuredModel = cfg.get<string>('autoPilotClassifierModel') ?? cfg.get<string>('model') ?? 'llama3';
        const { url: baseUrl, model } = decodeOllamaModel(configuredModel, urls);
        return {
          callModel: async (opts: { system: string; user: string }) => {
            const t0 = Date.now();
            const text = model.startsWith('openai::')
              ? (await openaiCompatChatCallStream(baseUrl, model.slice('openai::'.length), [{ role: 'system', content: opts.system }, { role: 'user', content: opts.user }], [])).content ?? ''
              : (await ollamaGenerate(baseUrl, model, `${opts.system}\n\n${opts.user}`)).response;
            return { text, durationMs: Date.now() - t0 };
          },
          log: (msg: string) => OllamaChatPanel.log(`[AutoPilot] ${msg}`),
        };
      },
      getRecentTranscript: () => this._chatHistory.slice(-10).map(m => ({
        role: m.role as 'user' | 'assistant' | 'tool',
        content: (m.content ?? '').slice(0, 800),
      })),
    });
    // ── QueryEngine ────────────────────────────────────────────────────────────
    this._queryEngine = new QueryEngine(
      {
        postToWebview: (msg) => this._postToWebview(msg as Record<string, unknown>),
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
        fetchOpenAiCompatModels,
        ollamaGetContextLength,
        ollamaWarmupModel,
        ollamaUnloadModel,
        ollamaListRunningModels,
        ollamaGetRunningModels,
        ollamaCheckConnection,
        ollamaGenerate,
        ollamaGenerateStream,
        openaiCompatChatCallStream: openaiCompatChatCallStream as QueryEngineServices['openaiCompatChatCallStream'],
        getCopilotMultiplier,
        getCopilotMultiplierById,
        copilotStreamText,
        estimateTokens,
        ollamaChatCallStream: ollamaChatCallStream as QueryEngineServices['ollamaChatCallStream'],
        executeTool: (name, args) => this.executeTool(name, args),
        getToolIcon,
        formatToolTitle,
        filterSensitiveInfo,
        agentTools: ALL_TOOLS,
        clearModelCtxCache,
      }
    );
    // ── AgentExecutor ──────────────────────────────────────────────────────────
    this._agentExecutor = new AgentExecutor(
      {
        postToWebview: (msg) => this._postToWebview(msg as Record<string, unknown>),
        log: (msg) => OllamaChatPanel.log(msg),
        getChatHistory: () => this._chatHistory,
        getActiveSessionId: () => this._activeSessionId,
        getLongTermMemory: () => this.getLongTermMemory(),
        getProjectRules: () => this._rulesCache,
        trackUsage: (m, t, mul, tc) => this.trackUsage(m, t, mul, tc),
        trackLatency: (m, ms) => this.trackLatency(m, ms),
        ensureModelReady: (url, mdl) => this._queryEngine.ensureModelReady(url, mdl),
        executeTool: (name, args) => this.executeTool(name, args),
        handleInsert: (code) => this.handleInsert(code),
        setWaAgentMode: (v) => this._wa.setAgentMode(v),
        clearAgentTodos: () => this._tools.clearAgentTodos(),
        recordAuditEntry: (tool, args, error) => this._tools.recordAuditEntry(tool, args, error),
        expandFileMentions: (p) => this._queryEngine.expandFileMentions(p),
        getSessionNotes: () => loadSessionNotes(),
        onSessionNotesUpdate: (notes) => saveSessionNotes(notes),
        notifyWaOwner: (text) => this._wa.notifyOwner(text),
      },
      {
        getOllamaUrls,
        decodeOllamaModel,
        ollamaChatCallStream: ollamaChatCallStream as AgentExecutorServices['ollamaChatCallStream'],
        openaiCompatChatCallStream: openaiCompatChatCallStream as AgentExecutorServices['openaiCompatChatCallStream'],
        copilotChatCallWithCts: copilotChatCallWithCts as AgentExecutorServices['copilotChatCallWithCts'],
        ollamaGenerate,
        ollamaGetContextLength,
        estimateTokens,
        getCopilotMultiplierById,
        filterSensitiveInfo,
        getToolIcon,
        formatToolTitle,
        agentTools: ALL_TOOLS,
      }
    );
    // Initialise WhatsApp manager (delegates all WA state and messaging)
    this._wa = new WhatsAppManager(context, {
      onAgentTrigger: (prompt, model) => this._agentExecutor.handleAgent(prompt, model || undefined, true, true),
      postToWebview:  (msg) => this._postToWebview(msg as Record<string, unknown>),
      requestPermission: (category, description, toolName) => this.requestPermission(category, description, toolName),
      isAgentRunning: () => this._agentExecutor.isAgentRunning(),
      isDisposed:     () => this._disposed,
      log:            (msg) => OllamaChatPanel.log(msg),
    });
    this._team = new TeamManager({
      getWebview: () => this._panel.webview,
      getChatHistory: () => this._chatHistory,
      setChatHistory: (history) => { this._chatHistory = (history as any)?.__isProxy ? history : this.createHistoryProxy(history ?? [], this._activeSessionId); this._chatHistories[this._activeSessionId] = this._chatHistory; this.schedulePersistChatHistories(); },
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
      getAgentTools: () => ALL_TOOLS,
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
      setChatHistory: (history) => { this._chatHistory = (history as any)?.__isProxy ? history : this.createHistoryProxy(history ?? [], this._activeSessionId); this._chatHistories[this._activeSessionId] = this._chatHistory; this.schedulePersistChatHistories(); },
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
    // Eager-load LTM from file so first request never uses stale globalState
    void (async () => {
      try {
        const fileLtm = await memdir.readMemoryIndex();
        this._ltmCache = fileLtm.trim()
          ? fileLtm
          : (this._context.globalState.get<string>('amiAiClaw.longTermMemory') ?? '');
        // Load rules layer (always-injected project conventions)
        try { this._rulesCache = await memdir.loadRulesLayer(); } catch { this._rulesCache = ''; }
      } catch {
        this._ltmCache = this._context.globalState.get<string>('amiAiClaw.longTermMemory') ?? '';
      }
    })();
    // 載入先前序列化的短期對話（优先從 workspaceState 讀，後已寫入用 workspaceState）
    const persistedChats =
      this._context.workspaceState.get<Record<string, ChatMessage[]>>('amiAiClaw.chatHistories') ??
      this._context.globalState.get<Record<string, ChatMessage[]>>('amiAiClaw.chatHistories') ??
      undefined;
    if (persistedChats) {
      this._chatHistories = persistedChats as Record<string, ChatMessage[]>;
    }
    OllamaChatPanel.log('Constructor: start');
    OllamaChatPanel.reportDiagnostic('constructor:start');
    vscode.window.showInformationMessage('AmiClaw: Extension activated');

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

    // 載入先前序列化的 Agent 對話記錄
    const persistedAgent = this._context.workspaceState.get<Record<string, { role: string; content: string | null }[]>>('amiAiClaw.agentMessages');
    if (persistedAgent && Object.keys(persistedAgent).length > 0) {
      for (const [sid, msgs] of Object.entries(persistedAgent)) {
        this._agentExecutor.setAgentMessagesForSession(sid, msgs as AgentExecutorChatMessage[]);
      }
      OllamaChatPanel.log(`Restored agentMessages for ${Object.keys(persistedAgent).length} sessions`);
    }

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(async message => {
      OllamaChatPanel.log('Received message: ' + message.type);
      try {
        switch (message.type) {
          case 'send':
            OllamaChatPanel.log(`[Route] send (Ask模式) model=${message.model ?? '(none)'} modeSelect=${(message as Record<string,unknown>)._dbgModeSelect ?? '?'} agentMode=${(message as Record<string,unknown>)._dbgAgentMode ?? '?'}`);
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
          case 'generateChatTitle':
            void this._queryEngine.generateChatTitle(message.sessionId as string, message.userMsg as string, message.assistantMsg as string);
            break;
          case 'saveWebviewState':
            this.scheduleWebviewSessionsPersist({ sessions: message.sessions, activeId: message.activeId, seq: message.seq });
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
          case 'organizePhotosPick':
            await this.handleOrganizePhotosPick();
            break;
          case 'webviewReady':
            OllamaChatPanel.log('webviewReady received — calling fetchModelsFromServer');
            if (!this._isWebviewReady) {
              this._isWebviewReady = true;
              this._resolveReady();
              // flush messages that arrived before webview was ready
              for (const m of this._messageQueue) { this._panel.webview.postMessage(m); }
              this._messageQueue = [];
            }
            {
              const cfg = vscode.workspace.getConfiguration('amiAiClaw');
              const autoPilotCfg = cfg.get<boolean>('autoPilotEnabled', false);
              const autoApproveCfg = cfg.get<boolean>('agentAutoApproveWrite', false);
              // 啟動時同步設定到 module-level 狀態，確保 webview UI 與後端一致
              setAutoPilotEnabledBySetting(autoPilotCfg);
              setAutoPilotActive(autoPilotCfg);
              const defaultKws = ['分析','審查','review','analyze','讀取','檢查','debug','refactor','重構','架構','程式','code','找','問題','修正','實作'];
              this._panel.webview.postMessage({
                type: 'initialState',
                providerInfo: this.buildProviderInfo(),
                streamMode: this._streamMode,
                autoPilotEnabled: isAutoPilotActive(),
                autoApproveWrite: autoApproveCfg,
                thinkLevel: getCurrentThinkingLevel(),
                contextDepth: getCurrentContextDepth(),
                shadowTriggerKeywords: cfg.get<string[]>('shadowTriggerKeywords', defaultKws),
                webviewSessions: this._context.workspaceState.get('amiAiClaw.webviewSessions') ?? null,
              });
            }
            await this._queryEngine.fetchModelsFromServer();
            break;
          case 'agentSend':
            OllamaChatPanel.log(`[Route] agentSend (Coordinator+Worker) model=${message.model ?? '(none)'}`);
            this.switchChatSession(message.sessionId);
            await this._agentExecutor.handleCoordinator(message.prompt, message.model);
            this.scheduleAgentPersist();
            break;
          case 'agentStop':
            this._agentExecutor.cancelAgent();
            this._queryEngine.cancelSend();
            break;
          case 'autoApproveWrite': {
            await vscode.workspace.getConfiguration('amiAiClaw').update('agentAutoApproveWrite', !!message.enabled, vscode.ConfigurationTarget.Workspace);
            break;
          }
          case 'autoPilot': {
            const enabled = !!message.enabled;
            await vscode.workspace.getConfiguration('amiAiClaw').update('autoPilotEnabled', enabled, vscode.ConfigurationTarget.Workspace);
            setAutoPilotEnabledBySetting(enabled);
            setAutoPilotActive(enabled);
            this._panel.webview.postMessage({ type: 'autoPilotState', enabled: isAutoPilotActive() });
            break;
          }
          case 'thinkLevel': {
            const raw = String(message.level ?? 'medium');
            const level: ThinkingLevel = (raw === 'off' || raw === 'low' || raw === 'medium' || raw === 'high' || raw === 'max') ? raw : 'medium';
            await vscode.workspace.getConfiguration('amiAiClaw').update('thinkingLevel', level, vscode.ConfigurationTarget.Workspace);
            this._panel.webview.postMessage({ type: 'thinkLevelState', level });
            break;
          }
          case 'contextDepth': {
            const raw = String(message.depth ?? 'file');
            const depth = (raw === 'outline' || raw === 'full') ? raw : 'file';
            await vscode.workspace.getConfiguration('amiAiClaw').update('contextDepth', depth, vscode.ConfigurationTarget.Workspace);
            // 切換深度層級會讓既有 digest 失效，立即清掉快取
            invalidateWorkspaceDigestCache();
            this._panel.webview.postMessage({ type: 'contextDepthState', depth });
            break;
          }
          case 'updateShadowKeywords': {
            const kws = Array.isArray(message.keywords) ? (message.keywords as string[]).map(k => String(k).trim()).filter(k => k.length > 0) : [];
            await vscode.workspace.getConfiguration('amiAiClaw').update('shadowTriggerKeywords', kws, vscode.ConfigurationTarget.Workspace);
            break;
          }
          case 'openFile': {
            const fp = message.filePath as string;
            if (fp) { await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(fp)); }
            break;
          }
          case 'diffFiles': {
            const fpA = message.pathA as string;
            const fpB = message.pathB as string;
            if (fpA && fpB) {
              await vscode.commands.executeCommand('vscode.diff',
                vscode.Uri.file(fpA), vscode.Uri.file(fpB),
                `${fpA.split(/[\\/]/).pop()} ↔ ${fpB.split(/[\\/]/).pop()}`
              );
            }
            break;
          }
          case 'shadowInspectFile': {
            const orig   = message.original as string;
            const shadow = message.shadow   as string;
            if (orig && shadow) {
              await vscode.commands.executeCommand('vscode.diff',
                vscode.Uri.file(orig), vscode.Uri.file(shadow),
                `${orig.split(/[\\/]/).pop()} (原始) ↔ (影子變更)`
              );
            }
            break;
          }
          case 'shadowApplyFile': {
            const origPath   = message.original as string;
            const shadowPath = message.shadow   as string;
            if (origPath && shadowPath) {
              try {
                const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(shadowPath));
                await vscode.workspace.fs.writeFile(vscode.Uri.file(origPath), bytes);
                vscode.window.showInformationMessage(`✅ 已套用變更至: ${origPath.split(/[\\/]/).pop()}`);
              } catch (e) {
                vscode.window.showErrorMessage(`套用失敗: ${e instanceof Error ? e.message : String(e)}`);
              }
            }
            break;
          }
          case 'diffWithGit': {
            // 與 git HEAD 比對；git scheme 不可用時退回直接開啟
            const fp = message.filePath as string;
            if (fp) {
              const uri = vscode.Uri.file(fp);
              const gitUri = uri.with({ scheme: 'git', query: JSON.stringify({ path: fp, ref: 'HEAD' }) });
              await vscode.commands.executeCommand('vscode.diff', gitUri, uri, `${fp.split(/[\\/]/).pop()} (HEAD) ↔ (目前)`)
                .then(undefined, () => vscode.commands.executeCommand('vscode.open', uri));
            }
            break;
          }
          case 'shadowVerify': {
            const sandbox = this._tools.getSandboxManager();
            const result  = await sandbox.verify();
            this._panel?.webview.postMessage({ type: 'agentStepProgress', text: result.passed ? '✅ 影子驗證通過' : `❌ 驗證失敗：${result.errors.length} 個錯誤` });
            break;
          }
          case 'shadowApprove': {
            const sandbox = this._tools.getSandboxManager();
            const files   = await sandbox.commit();
            this._panel?.webview.postMessage({ type: 'agentStepProgress', text: `✅ 已提交 ${files.length} 個檔案至工作區` });
            break;
          }
          case 'shadowReject': {
            this._tools.getSandboxManager().rollback();
            this._panel?.webview.postMessage({ type: 'agentStepProgress', text: '🗑️ 影子變更已回滾，工作區未修動' });
            break;
          }
          case 'shadowInspect': {
            const state = this._tools.getSandboxManager().getState();
            if (state.shadowDir) {
              await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(state.shadowDir), { forceNewWindow: false });
            }
            break;
          }
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
          case 'slashCommand': {
            const sc = String(message.cmd ?? '').trim();
            switch (sc) {
              case 'doctor': {
                // 診斷：列出連線狀態、可用模型數、工具數
                const cfgSC = vscode.workspace.getConfiguration('amiAiClaw');
                const urlSC = (cfgSC.get<string[]>('ollamaUrls') ?? [cfgSC.get<string>('url') ?? 'http://localhost:11434'])[0];
                const modelSC = cfgSC.get<string>('model') ?? '（未設定）';
                const toolCount = 60; // ToolRegistry 常數
                const lines = [
                  '## 🩺 AmiClaw Doctor',
                  `- **Ollama URL**: ${urlSC}`,
                  `- **目前模型**: ${modelSC}`,
                  `- **工具數量**: ${toolCount} 個`,
                  `- **Extension Host**: 運作中 ✅`,
                  `- **Context Depth**: ${vscode.workspace.getConfiguration('amiAiClaw').get<string>('contextDepth', 'file')}`,
                ];
                this._panel.webview.postMessage({ type: 'assistant', text: lines.join('\n') });
                break;
              }
              case 'tools':
              case 'audit':
                this.showAuditLog();
                break;
              case 'compact': {
                // 壓縮：清除舊對話，只保留最近 10 則
                const hist = this._chatHistory.slice(-10);
                this._chatHistory.splice(0, this._chatHistory.length, ...hist);
                this._panel.webview.postMessage({ type: 'assistant', text: `🗜️ 對話歷史已壓縮，保留最近 ${hist.length} 則訊息。` });
                break;
              }
              case 'wa':
                this._panel.webview.postMessage({ type: 'assistant', text: `📱 WhatsApp：${this._wa.agentMode ? '✅ 已連線（Agent 模式）' : (this._wa ? '已初始化' : '未啟動')}` });
                break;
              case 'workflow': {
                // /workflow list | save <name> | run <name> | delete <name>
                const { listWorkflows, saveWorkflow, loadWorkflow, deleteWorkflow, buildWorkflowCoordinatorPrompt } = await import('./services/WorkflowEngine');
                const parts = sc === 'workflow' ? [] : message.args as string[] ?? [];
                const sub = parts[0] ?? 'list';
                if (sub === 'list') {
                  const wfs = await listWorkflows();
                  const txt = wfs.length === 0
                    ? '（尚無已儲存的工作流程）\n用 `/workflow save <名稱>` 儲存目前任務為工作流程'
                    : wfs.map(w => `⚙️ **${w.name}** （${w.steps.length} 步）\n　${w.description}${w.lastRun ? `\n　上次執行：${w.lastRun.slice(0, 10)}` : ''}`).join('\n\n');
                  this._panel.webview.postMessage({ type: 'assistant', text: `## 工作流程清單\n\n${txt}` });
                } else if (sub === 'run') {
                  const name = parts.slice(1).join(' ').trim();
                  const wf = await loadWorkflow(name);
                  if (!wf) { this._panel.webview.postMessage({ type: 'assistant', text: `找不到工作流程「${name}」` }); break; }
                  const prompt = buildWorkflowCoordinatorPrompt(wf);
                  this.switchChatSession(message.sessionId);
                  await this._agentExecutor.handleCoordinator(prompt, message.model);
                  this.scheduleAgentPersist();
                } else if (sub === 'save') {
                  const name = parts.slice(1).join(' ').trim() || '未命名';
                  const steps = this._chatHistory
                    .filter(m => m.role === 'user' && m.content)
                    .map(m => ({ prompt: (m.content ?? '').slice(0, 500), description: (m.content ?? '').slice(0, 60) }));
                  if (steps.length === 0) { this._panel.webview.postMessage({ type: 'assistant', text: '對話記錄為空，無法儲存' }); break; }
                  await saveWorkflow({ name, description: steps[0].prompt.slice(0, 120), steps, createdAt: new Date().toISOString() });
                  this._panel.webview.postMessage({ type: 'assistant', text: `✅ 已儲存工作流程「${name}」（${steps.length} 步）` });
                } else if (sub === 'delete') {
                  const name = parts.slice(1).join(' ').trim();
                  await deleteWorkflow(name);
                  this._panel.webview.postMessage({ type: 'assistant', text: `🗑️ 已刪除工作流程「${name}」` });
                } else {
                  this._panel.webview.postMessage({ type: 'assistant', text: '用法：`/workflow list` | `/workflow save <名稱>` | `/workflow run <名稱>` | `/workflow delete <名稱>`' });
                }
                break;
              }
              default:
                this._panel.webview.postMessage({ type: 'assistant', text: `❓ 未知指令：/${sc}` });
            }
            break;
          }
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
            const empty = this.createHistoryProxy([], this._activeSessionId);
            this._chatHistory = empty;
            this._chatHistories[this._activeSessionId] = this._chatHistory;
            this._panel.webview.postMessage({ type: 'historyCount', count: 0, sessionId: this._activeSessionId });
            break;
          case 'deleteSession': {
            const delSid = this.resolveSessionId(message.sessionId);
            this._agentExecutor.clearSessionMessages(delSid);
            delete this._chatHistories[delSid];
            if (delSid === this._activeSessionId) {
              const nextSid = Object.keys(this._chatHistories).find(k => k !== delSid);
              if (nextSid) this.switchChatSession(nextSid);
            }

            this.schedulePersistChatHistories();
            console.log('[DEBUG ollama-chat] deleteSession complete for', delSid, 'Remaining keys:', Object.keys(this._chatHistories).length);
            break;
          }
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
              this._chatHistories[importId] = this.createHistoryProxy(parsed.messages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content ?? '' })), importId);
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
          case 'listOllamaModelsForManage': {
            const cfg5 = vscode.workspace.getConfiguration('amiAiClaw');
            const mgmtUrls = getOllamaUrls(cfg5);
            const mgmtResults: { url: string; models: string[] }[] = [];
            for (const u of mgmtUrls) {
              try {
                const ms = await ollamaListModels(u);
                mgmtResults.push({ url: u, models: ms });
              } catch { mgmtResults.push({ url: u, models: [] }); }
            }
            this._panel.webview.postMessage({ type: 'ollamaModelsForManage', servers: mgmtResults });
            break;
          }
          case 'deleteOllamaModel': {
            const delUrl = message.url as string;
            const delModel = message.model as string;
            try {
              await ollamaDeleteModel(delUrl, delModel);
              this._panel.webview.postMessage({ type: 'ollamaModelDeleted', model: delModel, url: delUrl });
              await this._queryEngine.fetchModelsFromServer();
            } catch (e) {
              this._panel.webview.postMessage({ type: 'ollamaModelDeleteError', model: delModel, error: e instanceof Error ? e.message : String(e) });
            }
            break;
          }
          case 'pullOllamaModel': {
            const pullUrl = message.url as string;
            const pullModel = (message.model as string).trim();
            if (!pullModel) { break; }
            try {
              await ollamaPullModel(pullUrl, pullModel, (status, pct) => {
                this._panel.webview.postMessage({ type: 'ollamaModelPullProgress', model: pullModel, status, pct });
              });
              this._panel.webview.postMessage({ type: 'ollamaModelPulled', model: pullModel, url: pullUrl });
              await this._queryEngine.fetchModelsFromServer();
            } catch (e) {
              this._panel.webview.postMessage({ type: 'ollamaModelPullError', model: pullModel, error: e instanceof Error ? e.message : String(e) });
            }
            break;
          }
          default:
            OllamaChatPanel.log('Unknown message type: ' + message.type);
            break;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        OllamaChatPanel.log('Message handler error: ' + msg);
        OllamaChatPanel.reportDiagnostic('message handler error', e);
        this._panel.webview.postMessage({ type: 'error', text: msg });
      }
    }, null, this._disposables);

    OllamaChatPanel.log('Setting webview HTML');
    try {
      this._panel.webview.html = this.getHtmlForWebview(this._panel.webview);
    } catch (e) {
      OllamaChatPanel.reportDiagnostic('constructor: setting webview HTML failed', e);
      throw e;
    }
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
      // 掃描 OpenAI-compatible 伺服器（LM Studio、vLLM 等）
      const openaiUrls: string[] = cfg.get<string[]>('openaiUrls') ?? [];
      const oaiKey = cfg.get<string>('openaiCompatApiKey', '');
      for (const oaiUrl of openaiUrls) {
        try {
          const oaiModels = await fetchOpenAiCompatModels(oaiUrl, oaiKey);
          for (const m of oaiModels) {
            const sep = m.indexOf('||');
            const cleanLabel = sep !== -1 ? m.slice(sep + 2) : m.replace(/^openai::/, '');
            liveModels.push({ id: m, label: cleanLabel });
          }
          if (!connOk) { connOk = true; connMsg = 'OK'; connUrl = oaiUrl; }
          OllamaChatPanel.log('OpenAI-compat models from ' + oaiUrl + ': ' + oaiModels.join(', '));
        } catch (e) {
          OllamaChatPanel.log('OpenAI-compat fetch error from ' + oaiUrl + ': ' + (e instanceof Error ? e.message : String(e)));
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
      if (current && !current.startsWith('copilot::') && !current.startsWith('openai::')) {
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
    })().catch((e) => {
      OllamaChatPanel.log('Async IIFE error: ' + (e instanceof Error ? e.message : String(e)));
      OllamaChatPanel.reportDiagnostic('constructor async init error', e);
    });
    // 等 webview 完全載入後，嘗試自動恢復 WhatsApp 連線（若有儲存的憑證）
    setTimeout(() => { this._wa.tryAutoReconnect().catch(() => {}); }, 3000);
  }

  /** Send any message to the webview from outside the class (e.g. from extension.ts commands) */
  public postMessageToWebview(msg: object): void {
    if (!this._isWebviewReady) {
      this._messageQueue.push(msg);
      return;
    }
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

  public static async createOrShow(context: vscode.ExtensionContext) {
    // 優先：focus 側邊欄 view —— activity bar 內的 view 不會被使用者意外關掉，可常駐
    try {
      await vscode.commands.executeCommand('amiAiClaw.chatView.focus');
      // resolveWebviewView 會在 view 首次顯示時被 VS Code 呼叫，由 createFromView 建立實例
      if (OllamaChatPanel.currentPanel) { return; }
    } catch (e) {
      OllamaChatPanel.reportDiagnostic('createOrShow: chatView.focus failed, falling back to editor panel', e);
    }

    // 已存在的實例（不論是 WebviewView 或 editor panel）：直接 reveal
    if (OllamaChatPanel.currentPanel) {
      OllamaChatPanel.currentPanel._panel.reveal?.(vscode.ViewColumn.One, true);
      return;
    }

    // 最後備援：傳統 editor-column panel（注意：使用者關閉此 tab 後實例會 dispose）
    const panel = vscode.window.createWebviewPanel(
      OllamaChatPanel.viewType,
      'AmiClaw',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true }
    );

    try {
      OllamaChatPanel.currentPanel = new OllamaChatPanel(panel, context);
      OllamaChatPanel.reportDiagnostic('createOrShow: fallback editor panel created');
    } catch (e) {
      OllamaChatPanel.reportDiagnostic('createOrShow: fallback editor panel init failed', e);
      try { panel.dispose(); } catch { /* ignore */ }
      OllamaChatPanel.revealDiagnostics();
      void vscode.window.showErrorMessage('AmiClaw 啟動失敗，請查看輸出視窗「AmiClaw Diagnostics」。');
      throw e;
    }
  }

  /** 由 WebviewViewProvider.resolveWebviewView 呼叫，建立固定側邊欄實例 */
  public static createFromView(view: vscode.WebviewView, context: vscode.ExtensionContext) {
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    if (OllamaChatPanel.currentPanel) {
      OllamaChatPanel.reportDiagnostic('createFromView: replacing existing panel instance for sidebar re-resolve');
      try {
        OllamaChatPanel.currentPanel.dispose();
      } catch (e) {
        OllamaChatPanel.reportDiagnostic('createFromView: disposing existing panel failed', e);
      }
    }
    const adapter = new WebviewViewAdapter(view);
    try {
      OllamaChatPanel.currentPanel = new OllamaChatPanel(adapter, context);
      OllamaChatPanel.reportDiagnostic('createFromView: sidebar panel created');
    } catch (e) {
      OllamaChatPanel.reportDiagnostic('createFromView: sidebar panel init failed', e);
      OllamaChatPanel.revealDiagnostics();
      throw e;
    }
  }

  /**
   * 静默建立（不顯示 panel，不切換焦點）—— VS Code 開啟時自動呼叫，目的是發動 WA 自動重連。
   * 若 panel 已存在則跳過。
   *
   * 注意：以前會在 1.5s 後 fallback 建立 editor panel，但 editor panel 可以被使用者意外關掉、
   * 之後 currentPanel = undefined，造成「AmiClaw 無法常駐」。新版只觸發 sidebar view 解析
   * （VS Code 在 view 首次顯示時才會呼叫 resolveWebviewView），不再建立 editor panel。
   * WA 自動重連會等到使用者第一次開啟 AmiClaw 側邊欄時才啟動。
   */
  public static createSilent(_context: vscode.ExtensionContext) {
    if (OllamaChatPanel.currentPanel) { return; }
    // 不主動 focus（會搶走使用者焦點），等使用者點 activity bar 圖示時自然解析
    OllamaChatPanel.log('AmiClaw 等待使用者開啟側邊欄；開啟後 WhatsApp 等服務會自動初始化');
  }

  /**
   * 進入「工作檔模式」：後續 agentChunk / assistant 訊息都會被累積，
   * 直到 agentStatus.running===false 後觸發 onTodoComplete 回呼。
   * 注意：streamDone 只代表單次串流結束，Agent 可能還有多輪工具呼叫，不作為觸發條件。
   * 由 extension.ts 的 processTodoFile 呼叫。
   */
  public enterTodoMode(prompt: string): void {
    this._todoModePrompt = prompt;
    this._todoAccumulator = '';
  }

  /** 統一的 postToWebview 入口，在 todo 模式下攔截訊息以累積回應文字。 */
  private _postToWebview(msg: Record<string, unknown>): void {
    // 累積 agent / ask 的回應文字
    if (this._todoModePrompt !== undefined) {
      if (msg.type === 'agentChunk' && typeof msg.text === 'string') {
        this._todoAccumulator += msg.text;
      } else if (msg.type === 'assistant' && typeof msg.text === 'string') {
        this._todoAccumulator += msg.text;
      } else if (msg.type === 'agentStatus' && msg.running === false) {
        // Agent 全部輪次結束 → 觸發回呼（agentStatus.running===false 才是最終完成信號）
        const prompt = this._todoModePrompt;
        const response = this._todoAccumulator.trim();
        this._todoModePrompt = undefined;
        this._todoAccumulator = '';
        if (response && OllamaChatPanel.onTodoComplete) {
          OllamaChatPanel.onTodoComplete(prompt, response);
        }
      }
    }
    this._panel.webview.postMessage(msg);
  }

  private broadcastHeartbeat(): void {
    this._panel.webview.postMessage({ type: 'heartbeat', timestamp: Date.now() });
  }

  private resolveSessionId(sessionId?: string): string {
    const raw = typeof sessionId === 'string' ? sessionId.trim() : '';
    return raw || 'default';
  }

  private switchChatSession(sessionId?: string): void {
    const id = this.resolveSessionId(sessionId);
    if (!this._chatHistories[id]) {
      this._chatHistories[id] = this.createHistoryProxy([], id);
    }
    this._activeSessionId = id;
    // 若尚未為該 session 建立 proxy，包裝一次
    if (!(this._chatHistories[id] as any).__isProxy) {
      this._chatHistories[id] = this.createHistoryProxy(this._chatHistories[id] || [], id);
    }
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

    await panel.waitForWebviewReady();

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
    if (this._disposed) { return; }
    this._disposed = true;
    if (this._latestWebviewSessions) {
      if (this._webviewSessionsPersistTimer) { clearTimeout(this._webviewSessionsPersistTimer); this._webviewSessionsPersistTimer = null; }
      void this._context.workspaceState.update('amiAiClaw.webviewSessions', this._latestWebviewSessions);
    }
    OllamaChatPanel.currentPanel = undefined;
    try {
      this._panel.dispose();
    } catch (e) {
      OllamaChatPanel.reportDiagnostic('dispose: panel dispose failed', e);
    }
    while (this._disposables.length) { const d = this._disposables.pop(); if (d) { d.dispose(); } }
  }

  public getHtmlForWebview(_webview: vscode.Webview): string {
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
      } else if (model.startsWith('openai::')) {
        const res = await openaiCompatChatCallStream(baseUrl, model.slice('openai::'.length), [{ role: 'user', content: consolidatePrompt }], [], (chunk) => { this._panel.webview.postMessage({ type: 'consolidateChunk', chunk }); });
        newLtm = res.content ?? '';
      } else {
        newLtm = await ollamaGenerateStream(baseUrl, model, consolidatePrompt, (chunk) => { this._panel.webview.postMessage({ type: 'consolidateChunk', chunk }); });
      }
      newLtm = newLtm.trim();
      if (newLtm) {
        await this.saveLongTermMemory(newLtm);
      }
      // 自動抽取長期記憶：用當前模型（Copilot 或 Ollama）做 LLM-based 抽取，
      // 解析 JSON array 後寫入 `.amiclaw/memory/*.md` + 更新 MEMORY.md 索引。
      // 失敗時 extractMemories 內部會 fallback 成快照寫檔。
      try {
        const extractor = await import('./services/extractMemories/extractMemories');
        const caller: import('./services/extractMemories/extractMemories').MemoryExtractCaller = {
          extract: async ({ sourceText, extractPrompt }) => {
            const fullPrompt = `${extractPrompt}\n\n## Conversation snippet\n\n${sourceText}`;
            let raw = '';
            if (model.startsWith('copilot::')) {
              const cts2 = new vscode.CancellationTokenSource();
              try {
                raw = await copilotStreamText(
                  model.slice('copilot::'.length),
                  [vscode.LanguageModelChatMessage.User(fullPrompt)],
                  () => { /* no streaming UI for background extract */ },
                  cts2.token
                );
              } finally { cts2.dispose(); }
            } else if (model.startsWith('openai::')) {
              const res2 = await openaiCompatChatCallStream(baseUrl, model.slice('openai::'.length), [{ role: 'user', content: fullPrompt }], []);
              raw = res2.content ?? '';
            } else {
              raw = await ollamaGenerateStream(baseUrl, model, fullPrompt, () => { /* silent */ });
            }
            return parseExtractMemoriesJson(raw);
          },
        };
        void extractor.executeExtractMemories(historyText, { caller });
      } catch (e) { /* ignore */ }
      this._chatHistory = this.createHistoryProxy([], this._activeSessionId);
      this._chatHistories[this._activeSessionId] = this._chatHistory;
      this._agentExecutor.clearSessionMessages(this._activeSessionId);
      this._panel.webview.postMessage({ type: 'consolidateDone', ltm: newLtm || currentLtm });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this._panel.webview.postMessage({ type: 'consolidateDone', ltm: currentLtm, error: msg });
    }
  }

  private getLongTermMemory(): string {
    // _ltmCache is loaded eagerly at init and kept in sync by saveLongTermMemory()
    return this._ltmCache || (this._context.globalState.get<string>('amiAiClaw.longTermMemory') ?? '');
  }

  private async saveLongTermMemory(text: string): Promise<void> {
    this._ltmCache = text;  // keep in-memory cache in sync immediately
    try {
      await memdir.saveMemoryIndex(text);
    } catch (e) {
      OllamaChatPanel.log('saveMemoryIndex error: ' + (e instanceof Error ? e.message : String(e)));
    }
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

  /** 「整理照片」按鈕：選參考人臉（可選）+ 來源資料夾，組 prompt 交給 Agent 呼叫 organize_photos。 */
  private async handleOrganizePhotosPick(): Promise<void> {
    // 步驟 1：選參考人臉照片（可取消＝只依行為分類）
    const refUris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      canSelectFiles: true,
      canSelectFolders: false,
      openLabel: '選為參考人臉（可取消）',
      title: '整理照片 1/2：選擇要比對的人臉照片（可按取消＝只依行為分類）',
      filters: { '圖片': ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif'] },
    });
    const referenceImage = refUris && refUris.length > 0 ? refUris[0].fsPath : '';

    // 步驟 2：選來源資料夾（必選）
    const srcUris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      canSelectFiles: false,
      canSelectFolders: true,
      openLabel: '選為照片來源資料夾',
      title: '整理照片 2/2：選擇要掃描整理的照片資料夾',
    });
    if (!srcUris || srcUris.length === 0) {
      this._panel.webview.postMessage({ type: 'assistant', text: '🖼️ 已取消照片整理（未選擇來源資料夾）。' });
      return;
    }
    const sourceDir = srcUris[0].fsPath;

    const promptLines = [
      '請呼叫 organize_photos 工具整理照片。請使用以下「絕對路徑」參數，不要更改：',
      `- source_dir: ${sourceDir}`,
    ];
    if (referenceImage) {
      promptLines.push(`- reference_image: ${referenceImage}`);
      promptLines.push('依「人物 / 行為」兩層資料夾整理（複製、保留原檔）。');
    } else {
      promptLines.push('未提供參考人臉，請只依「行為 / 場景」分類（複製、保留原檔）。');
    }
    promptLines.push('整理完成後，請回報掃描張數、整理張數與行為分佈。');

    const label = referenceImage
      ? `🖼️ 整理照片：比對人臉「${path.basename(referenceImage)}」，來源資料夾「${sourceDir}」` 
      : `🖼️ 整理照片（依行為分類）：來源資料夾「${sourceDir}」`;

    this._panel.webview.postMessage({ type: 'organizePhotosPicked', prompt: promptLines.join('\n'), label });
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
  truncated?: boolean; // finish_reason/done_reason === 'length'
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

/** 快取：model context length（key = `${baseUrl}||${model}`）。TTL 5 分鐘。 */
const _modelCtxCache = new Map<string, { len: number; ts: number }>();
const MODEL_CTX_TTL = 5 * 60 * 1000;

/** 清除 context length 快取，讓下次查詢重新向伺服器取值。重整模型時呼叫。 */
export function clearModelCtxCache(): void { _modelCtxCache.clear(); }

/** 向 Ollama `/api/show` 或 vLLM/OpenAI-compat `/v1/models/{id}` 查詢模型實際 context window 大小（tokens）。
 *  - Ollama：解析 `model_info.*.context_length`（0.3+）或 `parameters` 段落的 `num_ctx`
 *  - vLLM / OpenAI-compat：解析 `GET /v1/models/{model_id}` 回應中的 `max_model_len`
 *  成功時回傳正整數；失敗時回傳 0。結果快取 5 分鐘。
 *  `model` 可帶 `openai::` 前綴，函式會自動去除後查詢。 */
function ollamaGetContextLength(baseUrl: string, model: string): Promise<number> {
  const cacheKey = `${baseUrl}||${model}`;
  const cached = _modelCtxCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < MODEL_CTX_TTL) { return Promise.resolve(cached.len); }

  const isOpenAiCompat = model.startsWith('openai::');
  const rawModel = isOpenAiCompat ? model.slice('openai::'.length) : model;

  // ── vLLM / OpenAI-compat：GET /v1/models/{model_id} ──────────────────────
  if (isOpenAiCompat) {
    return new Promise<number>((resolve) => {
      try {
        // LM Studio 內部 API：/api/v0/models 回傳 max_context_length
        const lmsUrl = new URL('/api/v0/models', baseUrl);
        const protocol = lmsUrl.protocol === 'https:' ? https : http;
        const _oaiKey = vscode.workspace.getConfiguration('amiAiClaw').get<string>('openaiCompatApiKey', '');
        const lmsReq = protocol.request({
          hostname: lmsUrl.hostname,
          port: lmsUrl.port ? parseInt(lmsUrl.port, 10) : (lmsUrl.protocol === 'https:' ? 443 : 80),
          path: lmsUrl.pathname,
          method: 'GET',
          headers: { 'Accept': 'application/json', ...(_oaiKey ? { 'Authorization': 'Bearer ' + _oaiKey } : {}) },
        }, (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => { data += chunk; });
          res.on('end', () => {
            if (res.statusCode === 200) {
              try {
                const json = JSON.parse(data);
                const models: Array<{ id?: string; max_context_length?: number }> = json.data ?? json;
                const entry = Array.isArray(models) ? models.find(m => m.id === rawModel) : null;
                const len = Number(entry?.max_context_length ?? 0);
                if (len > 0) { _modelCtxCache.set(cacheKey, { len, ts: Date.now() }); resolve(len); return; }
              } catch { /* fall through to vLLM path */ }
            }
            // vLLM fallback：GET /v1/models/{model_id}
            const encodedId = encodeURIComponent(rawModel);
            const url = new URL(`/v1/models/${encodedId}`, baseUrl);
            const req2 = protocol.request({
              hostname: url.hostname,
              port: url.port ? parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 80),
              path: url.pathname,
              method: 'GET',
              headers: { ...(_oaiKey ? { 'Authorization': 'Bearer ' + _oaiKey } : {}) },
            }, (res2) => {
              let d2 = '';
              res2.on('data', (c: Buffer) => { d2 += c; });
              res2.on('end', () => {
                try {
                  const j2 = JSON.parse(d2);
                  const len2 = Number(j2.max_model_len ?? 0);
                  if (len2 > 0) { _modelCtxCache.set(cacheKey, { len: len2, ts: Date.now() }); }
                  resolve(len2 > 0 ? len2 : 0);
                } catch { resolve(0); }
              });
            });
            req2.on('error', () => resolve(0));
            req2.setTimeout(3000, () => { req2.destroy(); resolve(0); });
            req2.end();
          });
        });
        lmsReq.on('error', () => resolve(0));
        lmsReq.setTimeout(5000, () => { lmsReq.destroy(); resolve(0); });
        lmsReq.end();
      } catch { resolve(0); }
    });
  }

  // ── Ollama：POST /api/show ────────────────────────────────────────────────
  return new Promise<number>((resolve) => {
    try {
      const url = new URL('/api/show', baseUrl);
      const body = JSON.stringify({ name: rawModel });
      const protocol = url.protocol === 'https:' ? https : http;
      const req = protocol.request({
        hostname: url.hostname,
        port: url.port ? parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 11434),
        path: url.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            // Priority 1: parameters.num_ctx = actual loaded window (Modelfile/user config)
            let len = 0;
            if (json.parameters) {
              const m = String(json.parameters).match(/num_ctx\s+(\d+)/);
              if (m) { len = Number(m[1]); }
            }
            // Priority 2: model_info.*.context_length = architecture capacity (may far exceed loaded window)
            if (!len) {
              const modelInfo: Record<string, unknown> = json.model_info ?? {};
              for (const k of Object.keys(modelInfo)) {
                if (k.endsWith('.context_length')) { len = Number(modelInfo[k]); break; }
              }
            }
            if (len > 0) { _modelCtxCache.set(cacheKey, { len, ts: Date.now() }); }
            resolve(len > 0 ? len : 0);
          } catch { resolve(0); }
        });
      });
      req.on('error', () => resolve(0));
      req.setTimeout(5000, () => { req.destroy(); resolve(0); });
      req.write(body);
      req.end();
    } catch { resolve(0); }
  });
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

/** GET /api/ps → 傳回目前 Ollama 正在執行的模型及其 VRAM 用量（bytes）。*/
function ollamaGetRunningModels(baseUrl: string): Promise<{ name: string; size_vram: number }[]> {
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
            const models = ((json.models ?? []) as { name: string; size_vram?: number }[])
              .map(m => ({ name: m.name, size_vram: m.size_vram ?? 0 }));
            resolve(models);
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
      const body = JSON.stringify({ model, messages, tools, stream: false, ...getOllamaThinkParam(model) });
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
        ...getOllamaThinkParam(model)
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
      let wasTruncated = false;
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
              if (json.error) { const e = json.error; streamError = typeof e === 'string' ? e : ((e as Record<string, unknown>).message as string | undefined) ?? JSON.stringify(e); return; }
              const msgFrag = json.message as (ChatMessage & { thinking?: string }) | undefined;
              if (msgFrag) {
                if (msgFrag.thinking) { accThinking += msgFrag.thinking; if (onThinkChunk) onThinkChunk(msgFrag.thinking); }
                if (msgFrag.content) { accContent += msgFrag.content; if (onTextChunk) onTextChunk(msgFrag.content); }
                if (msgFrag.tool_calls && Array.isArray(msgFrag.tool_calls) && msgFrag.tool_calls.length > 0) {
                  finalToolCalls = msgFrag.tool_calls;
                }
              }
              if (json.done) {
                if ((json.done_reason as string | undefined) === 'length') wasTruncated = true;
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
            let content = accContent;
            if (!accThinking && content) {
              const m = content.match(/^<think>([\s\S]*?)<\/think>\s*/);
              if (m) { if (onThinkChunk) onThinkChunk(m[1].trim()); content = content.slice(m[0].length); }
            }
            resolve({ role: 'assistant', content: content || null, thinking: accThinking || undefined, truncated: wasTruncated || undefined });
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
  onStats?: (tokens: number, tps: number) => void,
  onThinkChunk?: (chunk: string) => void
): Promise<ChatMessage> {
  OllamaChatPanel.log(`[openaiCompat] call url=${baseUrl} model=${model} msgs=${messages.length} tools=${tools.length}`);
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
      const protocol = url.protocol === 'https:' ? https : http;
      let triedWithoutTools = false;

      const sendRequest = (includeTools: boolean) => {
        const oaiTools = includeTools && tools.length > 0 ? tools : undefined;
        const bodyObj: Record<string, unknown> = { model, messages: oaiMessages, stream: true };
        if (oaiTools) { bodyObj.tools = oaiTools; }
        const body = JSON.stringify(bodyObj);

        const options: http.RequestOptions = {
          hostname: url.hostname,
          port: url.port ? parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname, method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Accept': 'text/event-stream' },
        };
        const _oaiKey = vscode.workspace.getConfiguration('amiAiClaw').get<string>('openaiCompatApiKey', '');
        if (_oaiKey) { (options.headers as Record<string, string>)['Authorization'] = 'Bearer ' + _oaiKey; }

        let lineBuffer = '';
        let accContent = '';
        let wasTruncated = false;
        // tool_calls 是增量合併結構（index-based）
        const toolCallBuilders: Map<number, { id: string; name: string; args: string }> = new Map();
        let promptTokens = 0; let completionTokens = 0; const startMs = Date.now();
        // <think> 串流路由狀態機（0=before, 1=in_think, 2=after）
        let _thinkState: 0 | 1 | 2 = 0;
        let _tagBuf = '';
        const _dispatch = (raw: string) => {
          let s = _tagBuf + raw; _tagBuf = '';
          while (s.length > 0) {
            if (_thinkState === 0) {
              const openIdx = s.indexOf('<think>');
              if (openIdx === -1) {
                let cut = s.length;
                for (let p = Math.min(s.length, 6); p >= 1; p--) { if ('<think>'.startsWith(s.slice(s.length - p))) { cut = s.length - p; _tagBuf = s.slice(cut); break; } }
                if (cut > 0 && onTextChunk) onTextChunk(s.slice(0, cut));
                s = '';
              } else {
                if (openIdx > 0 && onTextChunk) onTextChunk(s.slice(0, openIdx));
                s = s.slice(openIdx + 7); _thinkState = 1;
              }
            } else if (_thinkState === 1) {
              const closeIdx = s.indexOf('</think>');
              if (closeIdx === -1) {
                let cut = s.length;
                for (let p = Math.min(s.length, 7); p >= 1; p--) { if ('</think>'.startsWith(s.slice(s.length - p))) { cut = s.length - p; _tagBuf = s.slice(cut); break; } }
                if (cut > 0 && onThinkChunk) onThinkChunk(s.slice(0, cut));
                s = '';
              } else {
                if (closeIdx > 0 && onThinkChunk) onThinkChunk(s.slice(0, closeIdx));
                s = s.slice(closeIdx + 8); _thinkState = 2;
              }
            } else {
              if (onTextChunk) onTextChunk(s); s = '';
            }
          }
        };

        const req = protocol.request(options, (res)=> {
          if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
            let errBody = '';
            res.setEncoding('utf8');
            res.on('data', (d: string) => { errBody += d; });
            res.on('end', () => {
              let apiMessage = 'HTTP ' + res.statusCode;
              try {
                const j = JSON.parse(errBody);
                apiMessage = j.error?.message ?? apiMessage;
              } catch { /* ignore parse error */ }

              const isAutoToolChoiceError = apiMessage.includes('"auto" tool choice requires')
                || apiMessage.includes('--enable-auto-tool-choice');

              // vLLM 在未啟用 auto tool choice 時會拒絕 tools；自動降級為無工具重試一次。
              if (includeTools && !triedWithoutTools && isAutoToolChoiceError) {
                triedWithoutTools = true;
                sendRequest(false);
                return;
              }

              if (apiMessage.startsWith('HTTP ')) {
                reject(new Error('OpenAI API HTTP ' + res.statusCode + ': ' + errBody.slice(0, 200)));
                return;
              }
              reject(new Error('OpenAI API 錯誤：' + apiMessage));
            });
            return;
          }
          res.setEncoding('utf8');
          OllamaChatPanel.log(`[openaiCompat] HTTP ${res.statusCode} headers=${JSON.stringify(res.headers).slice(0,200)}`);
          let _firstChunk = true;
          let _sseEvent = '';       // track current SSE event type
          let _sseError = '';       // accumulate SSE error message
          res.on('data', (data: string) => {
            lineBuffer += data;
            const lines = lineBuffer.split('\n');
            lineBuffer = lines.pop() ?? '';
            for (const line of lines) {
              const t = line.trim();
              if (!t) { _sseEvent = ''; continue; }           // blank line resets event type
              if (t.startsWith('event:')) { _sseEvent = t.slice(6).trim(); continue; }
              if (!t.startsWith('data:')) continue;
              const payload = t.slice(5).trim();
              if (payload === '[DONE]') continue;
              // SSE error event: reject with the error message
              if (_sseEvent === 'error') {
                try {
                  const errObj = JSON.parse(payload);
                  const msg = errObj?.error?.message ?? payload.slice(0, 300);
                  _sseError = msg;
                } catch { _sseError = payload.slice(0, 300); }
                continue;
              }
              try {
                const chunk = JSON.parse(payload) as {
                  choices?: Array<{
                    delta?: {
                      content?: string | null;
                      reasoning_content?: string | null;   // LM Studio / OpenRouter 思考欄位
                      tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>;
                    };
                    finish_reason?: string;
                  }>;
                  usage?: { prompt_tokens?: number; completion_tokens?: number };
                };
                if (chunk.choices?.[0]?.finish_reason === 'length') wasTruncated = true;
                const delta = chunk.choices?.[0]?.delta;
                // reasoning_content → 思考框（Gemma 4 / OpenRouter thinking 格式）
                if (delta?.reasoning_content) {
                  if (_firstChunk) { OllamaChatPanel.log(`[openaiCompat] first reasoning_content chunk: ${JSON.stringify(delta.reasoning_content.slice(0,40))}`); _firstChunk = false; }
                  if (onThinkChunk) onThinkChunk(delta.reasoning_content);
                }
                if (delta?.content) {
                  if (_firstChunk) { OllamaChatPanel.log(`[openaiCompat] first content chunk: ${JSON.stringify(delta.content.slice(0,40))}`); _firstChunk = false; }
                  accContent += delta.content; _dispatch(delta.content);
                }
                if (delta?.tool_calls) {
                  for (const tc of delta.tool_calls) {
                    if (!toolCallBuilders.has(tc.index)) { toolCallBuilders.set(tc.index, { id: tc.id ?? '', name: '', args: '' }); }
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
            OllamaChatPanel.log(`[openaiCompat] end: accContent.length=${accContent.length} toolCalls=${toolCallBuilders.size} sseError=${!!_sseError}`);
            // SSE error event → check if context overflow + tools → retry without tools
            if (_sseError) {
              const isCtxOverflow = /exceeds.*context|context.*size|context.*length/i.test(_sseError);
              if (includeTools && !triedWithoutTools && isCtxOverflow) {
                OllamaChatPanel.log(`[openaiCompat] context overflow with tools, retrying without tools`);
                triedWithoutTools = true;
                sendRequest(false);
                return;
              }
              reject(new Error('OpenAI API 錯誤：' + _sseError));
              return;
            }
            if (onStats && completionTokens > 0) {
              const elapsed = (Date.now() - startMs) / 1000;
              onStats(promptTokens + completionTokens, elapsed > 0 ? completionTokens / elapsed : 0, { input: promptTokens, output: completionTokens });
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
              resolve({ role: 'assistant', content: accContent || null, truncated: wasTruncated || undefined });
            }
          });
          res.on('error', (e: Error) => reject(e));
        });

        req.on('error', (e: Error) => reject(new Error(`無法連線到 OpenAI-compatible server (${baseUrl})：${e.message}`)));
        req.setTimeout(1200000, () => { req.destroy(new Error('OpenAI-compatible 呼叫逾時 (1200s)')); });
        req.write(body); req.end();
      };

      sendRequest(true);
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

export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'max';

export function getCurrentThinkingLevel(): ThinkingLevel {
  const v = vscode.workspace.getConfiguration('amiAiClaw').get<string>('thinkingLevel', 'medium');
  return (v === 'off' || v === 'low' || v === 'medium' || v === 'high' || v === 'max') ? v : 'medium';
}

/**
 * 依使用者「思考等級」設定 + 模型能力，回傳要塞進 Ollama request body 的 think 參數。
 * - off: 強制 think:false（即使模型支援，也跳過思考，省 token & 加速）
 * - low/medium: 傳對應字串（各模型 Jinja 模板通用）
 * - high/max: 傳 true（布林），讓 Ollama 套用模型預設最大思考力，避免模板等級字串不相容
 * - 模型不支援思考時，不加 think key（讓 Ollama 用模型預設）
 */
function getOllamaThinkParam(model: string): { think?: boolean | string } {
  const level = getCurrentThinkingLevel();
  if (level === 'off') { return { think: false }; }
  if (!supportsThinking(model)) { return {}; }
  // 'low'/'medium' are universally supported strings; 'high'/'max' fall back to boolean true
  if (level === 'low' || level === 'medium') { return { think: level }; }
  return { think: true };
}

function ollamaGenerate(baseUrl: string, model: string, prompt: string): Promise<{ response: string; thinking?: string }> {
  return new Promise((resolve, reject) => {
    try {
      const url = new URL('/api/generate', baseUrl);
      const params: Record<string, unknown> = { model, prompt, stream: false };
      Object.assign(params, getOllamaThinkParam(model));
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

/**
 * 從 LLM 回傳文字中抽出 extractMemories 的 JSON array。
 * 容忍 ```json``` fence、前後解說文字、單一物件包裝等常見格式偏差。
 */
function parseExtractMemoriesJson(raw: string): import('./services/extractMemories/extractMemories').ExtractedMemoryItem[] {
  if (!raw) return [];
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  let candidate = fence ? fence[1] : raw;
  const arrayStart = candidate.indexOf('[');
  const arrayEnd = candidate.lastIndexOf(']');
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    candidate = candidate.slice(arrayStart, arrayEnd + 1);
  }
  try {
    const parsed: unknown = JSON.parse(candidate);
    if (!Array.isArray(parsed)) return [];
    const valid: import('./services/extractMemories/extractMemories').ExtractedMemoryItem[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const o = item as Record<string, unknown>;
      const type = String(o.type ?? '');
      if (type !== 'fact' && type !== 'preference' && type !== 'pattern' && type !== 'context') continue;
      const title = String(o.title ?? '').trim();
      const body = String(o.body ?? '').trim();
      const slug = String(o.slug ?? '').trim();
      const oneLineHook = String(o.oneLineHook ?? title).trim();
      if (!title || !body) continue;
      const tags = Array.isArray(o.tags) ? o.tags.map(t => String(t)).slice(0, 10) : undefined;
      valid.push({ type, title, slug, body, oneLineHook, tags });
    }
    return valid;
  } catch {
    return [];
  }
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
      Object.assign(params, getOllamaThinkParam(model));
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
              if (json.error) { const e = json.error; streamError = typeof e === 'string' ? e : ((e as Record<string, unknown>).message as string | undefined) ?? JSON.stringify(e); return; }
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
      Object.assign(params, getOllamaThinkParam(model));
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
              if (json.error) { const e = json.error; streamError = typeof e === 'string' ? e : ((e as Record<string, unknown>).message as string | undefined) ?? JSON.stringify(e); return; }
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
  if (model.startsWith('openai::')) { return model; }
  return allUrls.length > 1 ? `${url}||${model}` : model;
}

/** 顯示標籤：多伺服器時加上 [hostname:port] 前綴。 */
export function ollamaDisplayLabel(url: string, model: string, allUrls: string[]): string {
  if (model.startsWith('openai::')) {
    const inner = model.slice('openai::'.length);
    const sep = inner.indexOf('||');
    const sourceUrl = sep !== -1 ? inner.slice(0, sep) : url;
    const modelName = sep !== -1 ? inner.slice(sep + 2) : inner;
    if (allUrls.length <= 1 && sep === -1) { return modelName; }
    try {
      const u = new URL(sourceUrl);
      return `[${u.hostname}:${u.port || (u.protocol === 'https:' ? '443' : '80')}] ${modelName}`;
    } catch {
      return modelName;
    }
  }
  if (allUrls.length <= 1) return model;
  try { const u = new URL(url); return `[${u.hostname}:${u.port || '11434'}] ${model}`; } catch { return model; }
}

/** 查詢 OpenAI-compatible 伺服器的模型清單，返回 openai::url||model 格式的 ID 陣列。 */
export function fetchOpenAiCompatModels(baseUrl: string, apiKey: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    try {
      const url = new URL('/v1/models', baseUrl);
      const protocol = url.protocol === 'https:' ? https : http;
      const headers: Record<string, string> = { 'Accept': 'application/json' };
      if (apiKey) { headers['Authorization'] = 'Bearer ' + apiKey; }
      const req = protocol.request({ hostname: url.hostname, port: url.port ? parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 80), path: url.pathname, method: 'GET', headers }, (res) => {
        let data = '';
        res.on('data', (c: Buffer) => { data += c; });
        res.on('end', () => {
          if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
          try {
            const json = JSON.parse(data);
            // 過濾 embedding-only 模型（無法用於 chat completions）
            const EMBED_PATTERN = /embed|rerank|classifier|clip|stable-?diffusion/i;
            const ids = (json.data ?? [])
              .map((m: { id?: string }) => m.id)
              .filter((id: unknown): id is string => typeof id === 'string' && id.trim().length > 0 && !EMBED_PATTERN.test(id))
              .map((id: string) => `openai::${baseUrl.replace(/\/$/, '')}||${id}`)
              .sort();
            resolve(ids);
          } catch { reject(new Error('Invalid JSON')); }
        });
      });
      req.on('error', reject);
      req.setTimeout(8000, () => { req.destroy(new Error('ETIMEDOUT')); });
      req.end();
    } catch (e) { reject(e); }
  });
}

function ollamaListModels(baseUrl: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    try {
      const ollamaUrl = new URL('/api/tags', baseUrl);
      const openAiUrl = new URL('/v1/models', baseUrl);

      const loadOpenAiModels = () => {
        const openAiProtocol = openAiUrl.protocol === 'https:' ? https : http;
        const _lmKey = vscode.workspace.getConfiguration('amiAiClaw').get<string>('openaiCompatApiKey', '');
        const _lmHeaders: Record<string, string> = { 'Accept': 'application/json' };
        if (_lmKey) { _lmHeaders['Authorization'] = 'Bearer ' + _lmKey; }
        const openAiReq = openAiProtocol.request({
          hostname: openAiUrl.hostname,
          port: openAiUrl.port ? parseInt(openAiUrl.port, 10) : (openAiUrl.protocol === 'https:' ? 443 : 80),
          path: openAiUrl.pathname,
          method: 'GET',
          headers: _lmHeaders,
        }, (openAiRes) => {
          let openAiData = '';
          openAiRes.on('data', (chunk: Buffer) => { openAiData += chunk; });
          openAiRes.on('end', () => {
            if (openAiRes.statusCode !== 200) { reject(new Error('HTTP ' + openAiRes.statusCode)); return; }
            try {
              const json = JSON.parse(openAiData);
              const EMBED_PAT = /embed|rerank|classifier|clip|stable-?diffusion/i;
              const ids: string[] = (json.data ?? [])
                .map((m: { id?: string }) => m.id)
                .filter((id: unknown): id is string => typeof id === 'string' && id.trim().length > 0 && !EMBED_PAT.test(id))
                .map((id: string) => `openai::${baseUrl.replace(/\/$/, '')}||${id}`)
                .sort();
              resolve(ids);
            } catch { reject(new Error('Invalid JSON from /v1/models')); }
          });
        });
        openAiReq.on('error', (e: NodeJS.ErrnoException) => reject(ollamaConnectError(openAiUrl.hostname, e)));
        openAiReq.setTimeout(8000, () => { openAiReq.destroy(new Error('ETIMEDOUT')); });
        openAiReq.end();
      };

      const protocol = ollamaUrl.protocol === 'https:' ? https : http;
      const req = protocol.request({
        hostname: ollamaUrl.hostname,
        port: ollamaUrl.port ? parseInt(ollamaUrl.port, 10) : (ollamaUrl.protocol === 'https:' ? 443 : 11434),
        path: ollamaUrl.pathname,
        method: 'GET',
      }, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const json = JSON.parse(data);
              const names: string[] = (json.models ?? []).map((m: { name: string }) => m.name).sort();
              resolve(names);
            } catch {
              reject(new Error('Invalid JSON from /api/tags'));
            }
            return;
          }
          loadOpenAiModels();
        });
      });
      req.on('error', () => {
        loadOpenAiModels();
      });
      req.setTimeout(8000, () => { req.destroy(new Error('ETIMEDOUT')); });
      req.end();
    } catch (e) { reject(e); }
  });
}

function ollamaCheckConnection(baseUrl: string): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolve) => {
    try {
      const url = new URL('/api/tags', baseUrl);
      const openAiUrl = new URL('/v1/models', baseUrl);
      const protocol = url.protocol === 'https:' ? https : http;
      const options: http.RequestOptions = {
        hostname: url.hostname,
        port: url.port ? parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 11434),
        path: url.pathname,
        method: 'GET',
      };
      let settled = false;

      const probeOpenAi = () => {
        if (settled) { return; }
        const p = openAiUrl.protocol === 'https:' ? https : http;
        const req2 = p.request({
          hostname: openAiUrl.hostname,
          port: openAiUrl.port ? parseInt(openAiUrl.port, 10) : (openAiUrl.protocol === 'https:' ? 443 : 80),
          path: openAiUrl.pathname,
          method: 'GET',
        }, (res2) => {
          res2.resume();
          if (!settled) {
            settled = true;
            resolve({ ok: res2.statusCode === 200, message: res2.statusCode === 200 ? 'OpenAI-compatible OK' : 'HTTP ' + res2.statusCode });
          }
        });
        req2.on('error', (e: NodeJS.ErrnoException) => {
          if (!settled) { settled = true; resolve({ ok: false, message: ollamaConnectError(openAiUrl.hostname, e).message }); }
        });
        req2.setTimeout(8000, () => {
          if (!settled) { settled = true; req2.destroy(); resolve({ ok: false, message: '連線逾時 (8s)，請確認主機 ' + openAiUrl.hostname + ' 可達' }); }
        });
        req2.end();
      };

      const req = protocol.request(options, (res) => {
        res.resume();
        if (!settled) {
          if (res.statusCode === 200) {
            settled = true;
            resolve({ ok: true, message: 'OK' });
          } else {
            probeOpenAi();
          }
        }
      });
      req.on('error', (e: NodeJS.ErrnoException) => {
        if (!settled) { probeOpenAi(); }
      });
      req.setTimeout(8000, () => {
        if (!settled) { req.destroy(); probeOpenAi(); }
      });
      req.end();
    } catch (e) { resolve({ ok: false, message: e instanceof Error ? e.message : String(e) }); }
  });
}

/** 刪除 Ollama 本機模型 */
function ollamaDeleteModel(baseUrl: string, modelName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const url = new URL('/api/delete', baseUrl);
      const protocol = url.protocol === 'https:' ? https : http;
      const body = JSON.stringify({ model: modelName });
      const options: http.RequestOptions = {
        hostname: url.hostname,
        port: url.port ? parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 11434),
        path: url.pathname,
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      };
      const req = protocol.request(options, (res) => {
        res.resume();
        if (res.statusCode === 200) { resolve(); }
        else { reject(new Error('HTTP ' + res.statusCode)); }
      });
      req.on('error', (e: NodeJS.ErrnoException) => reject(ollamaConnectError(url.hostname, e)));
      req.setTimeout(15000, () => { req.destroy(new Error('ETIMEDOUT')); });
      req.write(body);
      req.end();
    } catch (e) { reject(e); }
  });
}

/** 拉取 Ollama 模型，透過 onProgress 回報進度字串。返回 Promise，完成或失敗時 resolve/reject。 */
function ollamaPullModel(
  baseUrl: string,
  modelName: string,
  onProgress: (status: string, percent: number | null) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const url = new URL('/api/pull', baseUrl);
      const protocol = url.protocol === 'https:' ? https : http;
      const body = JSON.stringify({ model: modelName, stream: true });
      const options: http.RequestOptions = {
        hostname: url.hostname,
        port: url.port ? parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 11434),
        path: url.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      };
      const req = protocol.request(options, (res) => {
        if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode)); return; }
        let buf = '';
        res.on('data', (chunk: Buffer) => {
          buf += chunk.toString();
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.trim()) { continue; }
            try {
              const obj = JSON.parse(line) as { status?: string; completed?: number; total?: number; error?: string };
              if (obj.error) { reject(new Error(obj.error)); return; }
              const pct = (obj.total && obj.total > 0) ? Math.round((obj.completed ?? 0) / obj.total * 100) : null;
              onProgress(obj.status ?? '', pct);
            } catch { /* skip malformed JSON lines */ }
          }
        });
        res.on('end', () => resolve());
        res.on('error', (e: Error) => reject(e));
      });
      req.on('error', (e: NodeJS.ErrnoException) => reject(ollamaConnectError(url.hostname, e)));
      req.write(body);
      req.end();
    } catch (e) { reject(e); }
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
