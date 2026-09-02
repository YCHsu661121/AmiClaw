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
import {
  ollamaChatCallStream, ollamaChatCall, ollamaGenerateStream, ollamaGenerateStreamWithRetry,
  ollamaChatStream, ollamaGenerate, ollamaGetContextLength, ollamaWarmupModel, ollamaUnloadModel,
  ollamaGetRunningModels, ollamaListRunningModels, ollamaListModels, ollamaCheckConnection,
  ollamaDeleteModel, ollamaPullModel, supportsThinking, getCurrentThinkingLevel, getOllamaThinkParam,
} from './providers/OllamaApiClient';
import {
  openaiCompatChatCallStream, fetchOpenAiCompatModels,
  getCopilotMultiplier, getCopilotMultiplierById, copilotStreamText, copilotChatCallWithCts,
  setOpenAICompatLogger,
} from './providers/OpenAICompatClient';
import {
  filterSensitiveInfo, estimateTokens, clearModelCtxCache,
  getOllamaUrls, decodeOllamaModel, encodeOllamaModelId, ollamaDisplayLabel, parseExtractMemoriesJson,
} from './providers/ProviderUtils';
import type { ChatMessage, ThinkingLevel } from './types/chat-types';

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
    // Inject logger so OpenAICompatClient can route debug messages to the output channel
    setOpenAICompatLogger((msg) => OllamaChatPanel.log(msg));
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
        getProjectRules: () => this._rulesCache,
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this._usageStats = context.globalState.get<any>('amiAiClaw.usageStats') ?? {};
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

// ── Provider re-exports (functions extracted to src/providers/) ────────────────
export type { ChatMessage, ThinkingLevel } from './types/chat-types';
export { filterSensitiveInfo, estimateTokens, clearModelCtxCache } from './providers/ProviderUtils';
export { getOllamaUrls, decodeOllamaModel, encodeOllamaModelId, ollamaDisplayLabel } from './providers/ProviderUtils';
export { ollamaChatCallStream, ollamaChatCall, ollamaGenerateStream, ollamaGenerateStreamWithRetry } from './providers/OllamaApiClient';
export { ollamaChatStream, ollamaGenerate, ollamaListModels, ollamaCheckConnection } from './providers/OllamaApiClient';
export { ollamaDeleteModel, ollamaPullModel, ollamaGetContextLength, ollamaWarmupModel } from './providers/OllamaApiClient';
export { ollamaUnloadModel, ollamaGetRunningModels, ollamaListRunningModels } from './providers/OllamaApiClient';
export { supportsThinking, getCurrentThinkingLevel, getOllamaThinkParam } from './providers/OllamaApiClient';
export { openaiCompatChatCallStream, fetchOpenAiCompatModels } from './providers/OpenAICompatClient';
export { getCopilotMultiplier, getCopilotMultiplierById, copilotStreamText, copilotChatCallWithCts } from './providers/OpenAICompatClient';
