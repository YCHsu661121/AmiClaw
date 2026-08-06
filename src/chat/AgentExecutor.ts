import * as vscode from 'vscode';
import { DEFAULT_COMPACTABLE_TOOLS } from '../context/MicroCompactor';
import { estimateTokensRough } from '../context/TokenBudgetManager';
import { formatCompactSummary } from '../context/HistoryCompactor';
import { buildWorkspaceDigest, getCurrentContextDepth, fmtSize } from '../context/WorkspaceDigest';
import { buildAgentSystemPrompt, buildShadowSupervisorPrompt } from '../context/SystemPromptBuilder';
import { AgentCarryover } from './AgentCarryover';
import { isRefusalResponse } from './RefusalDetector';
import {
  buildSessionNotes,
  loadSessionNotes,
  saveSessionNotes,
  shouldUpdateNotes,
} from '../services/SessionNotes';

export interface AgentExecutorChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  thinking?: string;
  tool_calls?: Array<{ id?: string; function: { name: string; arguments: Record<string, unknown> | string } }>;
  tool_call_id?: string;
  images?: string[];
  truncated?: boolean;
}

export interface AgentExecutorCallbacks {
  postToWebview: (msg: object) => void;
  log: (msg: string) => void;
  getChatHistory: () => AgentExecutorChatMessage[];
  setChatHistory?: (history: AgentExecutorChatMessage[]) => void;
  getChatHistories?: () => Record<string, AgentExecutorChatMessage[]>;
  getActiveSessionId: () => string;
  getLongTermMemory: () => string;
  trackUsage: (model: string, tokens: number, multiplier?: string, toolCall?: boolean) => void;
  trackLatency: (model: string, ms: number) => void;
  ensureModelReady: (baseUrl: string, model: string) => Promise<void>;
  executeTool: (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<string>;
  handleInsert: (code: string) => Promise<void>;
  setWaAgentMode: (value: boolean) => void;
  clearAgentTodos: () => void;
  recordAuditEntry: (tool: string, args: Record<string, unknown>, error: boolean) => void;
  expandFileMentions?: (prompt: string) => Promise<string>;
  /** Session Notes — 啟動時載入上次筆記（可空字串） */
  getSessionNotes: () => Promise<string>;
  /** 取得目前未結案的 manage_todo 項目，供影子審查勗用 */
  getAgentTodos?: () => Array<{id: number; text: string; done: boolean}>;
  /** Session Notes — Agent 執行中每 N 次工具呼叫後自動呼叫，持久化筆記 */
  onSessionNotesUpdate: (notes: string) => Promise<void>;
}

export interface AgentExecutorServices {
  getOllamaUrls: (cfg: vscode.WorkspaceConfiguration) => string[];
  decodeOllamaModel: (modelId: string, fallbackUrls: string[]) => { url: string; model: string };
  ollamaChatCallStream: (
    baseUrl: string,
    model: string,
    messages: AgentExecutorChatMessage[],
    tools: unknown[],
    onThinkChunk?: (chunk: string) => void,
    onTextChunk?: (chunk: string) => void,
    onStats?: (tokens: number, tps: number) => void
  ) => Promise<AgentExecutorChatMessage>;
  openaiCompatChatCallStream: (
    baseUrl: string,
    model: string,
    messages: AgentExecutorChatMessage[],
    tools: unknown[],
    onTextChunk?: (chunk: string) => void,
    onStats?: (tokens: number, tps: number) => void
  ) => Promise<AgentExecutorChatMessage>;
  copilotChatCallWithCts: (
    modelId: string,
    messages: AgentExecutorChatMessage[],
    tools: unknown[]
  ) => Promise<AgentExecutorChatMessage>;
  ollamaGetContextLength: (url: string, model: string) => Promise<number>;
  ollamaGenerate: (url: string, model: string, prompt: string) => Promise<{ response: string; thinking?: string }>;
  estimateTokens: (text: string) => number;
  getCopilotMultiplierById: (id: string) => string;
  filterSensitiveInfo: (text: string) => string;
  getToolIcon: (name: string) => string;
  formatToolTitle: (name: string, args: Record<string, unknown>) => string;
  agentTools: unknown[];
}

// ── Carry-over 追蹤狀態（搬到 ./AgentCarryover） ──────────────────────────

const COMPACTABLE_TOOL_RESULT_CHARS = 4000;
// 在地工具名稱 + context/MicroCompactor 預設清單 union，確保跨模組通用
const COMPACTABLE_TOOLS = new Set<string>([
  'read_file','read_file_smart','read_files','read_workspace','search_workspace','search_regex','agentic_file_search','run_command','run_python','batch_replace','replace_all_in_file',
  ...DEFAULT_COMPACTABLE_TOOLS,
]);
const MC_CLEARED = '[舊工具結果已清除]';

export class AgentExecutor {
  private _agentMessagesBySession: Record<string, AgentExecutorChatMessage[]> = { default: [] };
  private _agentMessages: AgentExecutorChatMessage[] = this._agentMessagesBySession.default;
  private _modelContextLength = 0;   // 從 Ollama /api/show 取得的實際 context window（0 = 未知）
  private _agentRunning = false;
  private _agentCancel = false;
  private _autoRunning = false;
  private _autoCancel = false;
  private _autoMaxIterations = 50;
  private _carryover = new AgentCarryover();
  // Session Notes 追蹤
  private _sessionToolCallCount = 0;
  private _sessionTaskDescription = '';
  private _sessionRecentErrors: string[] = [];
  private _sessionNotesCache = '';  // 最後一次儲存的筆記（避免重複 I/O）
  // 影子督促人格（Monitor）：本次執行已介入的次數（斷路器上限見 SHADOW_MAX）
  private _shadowInterventions = 0;
  private _shadowJustInjected = false; // 督促注入後跳過下一輪的確認語審查
  private _abortController = new AbortController();
  // 有界筆記佇列：容量上限 + Error Boundary（Fix 2）
  private _notesQueue: Array<() => Promise<void>> = [];
  private _notesQueueRunning = false;
  private static readonly NOTES_QUEUE_CAP = 5;
  private static readonly HOT_STEPS = 2;    // L1: 最新 N 個 assistant turn 保留全文
  private static readonly L2_MIN_LEN = 500; // L2: 工具輸出超過此長度才去噪

  public constructor(
    private readonly _callbacks: AgentExecutorCallbacks,
    private readonly _services: AgentExecutorServices
  ) {}

  public getAgentMessages(): AgentExecutorChatMessage[] {
    return this._agentMessages;
  }

  public setAgentMessages(messages: AgentExecutorChatMessage[]): void {
    this._agentMessages = messages;
    this._agentMessagesBySession[this._callbacks.getActiveSessionId()] = messages;
  }

  public getAgentMessagesBySession(): Record<string, AgentExecutorChatMessage[]> {
    return this._agentMessagesBySession;
  }

  public isAgentRunning(): boolean {
    return this._agentRunning;
  }

  public cancelAgent(): void {
    this._agentCancel = true;
    this._abortController.abort();
  }

  public cancelAuto(): void {
    this._autoCancel = true;
  }

  public switchSession(sessionId: string): void {
    if (!this._agentMessagesBySession[sessionId]) {
      this._agentMessagesBySession[sessionId] = [];
    }
    this._agentMessages = this._agentMessagesBySession[sessionId];
  }

  public clearSessionMessages(sessionId: string): void {
    const cleared: AgentExecutorChatMessage[] = [];
    this._agentMessagesBySession[sessionId] = cleared;
    if (this._callbacks.getActiveSessionId() === sessionId) {
      this._agentMessages = cleared;
    }
    // 清除會話時重置 Session Notes 狀態
    this._sessionToolCallCount = 0;
    this._sessionTaskDescription = '';
    this._sessionRecentErrors = [];
    this._sessionNotesCache = '';
    this._notesQueue = []; // 清除未執行的筆記更新，避免寫入已清除 session 的舊資料
    this._carryover.reset();
  }

  public initSessionMessages(sessionId: string): void {
    this._agentMessagesBySession[sessionId] = [];
  }

  public async handleAgent(
    userPrompt: string,
    modelOverride?: string,
    recordToShortTerm = true,
    waTriggered = false,
    shadowModelOverride?: string,
  ): Promise<void> {
    if (this._agentRunning) {
      vscode.window.showInformationMessage('Agent 已在執行中');
      return;
    }

    this._agentRunning = true;
    this._agentCancel = false;
    this._abortController = new AbortController(); // 每次 Agent 執行取得新的 AbortController
    this._callbacks.setWaAgentMode(waTriggered);
    this._callbacks.postToWebview({ type: 'agentStatus', running: true });
    const agentStart = Date.now();

    const cfg = vscode.workspace.getConfiguration('amiAiClaw');
    const urls = this._services.getOllamaUrls(cfg);
    const rawModel = modelOverride || cfg.get<string>('model') || 'llama3';
    this._callbacks.log(`handleAgent: rawModel="${rawModel}"`);
    const normalizedModel = rawModel.startsWith('copilot/') ? `copilot::${rawModel.slice('copilot/'.length)}` : rawModel;
    const { url: baseUrl, model } = normalizedModel.startsWith('copilot::')
      ? { url: urls[0], model: normalizedModel }
      : this._services.decodeOllamaModel(normalizedModel, urls);
    const isOpenAICompat = model.startsWith('openai::');

    // 影子督促人格模型（未指定時沿用主人格）
    let shadowModel = model, shadowBaseUrl = baseUrl, shadowIsOpenAICompat = isOpenAICompat;
    if (shadowModelOverride) {
      const rawS = shadowModelOverride.startsWith('copilot/') ? `copilot::${shadowModelOverride.slice('copilot/'.length)}` : shadowModelOverride;
      const resolvedS = rawS.startsWith('copilot::') ? { url: urls[0], model: rawS } : this._services.decodeOllamaModel(rawS, urls);
      shadowModel = resolvedS.model;
      shadowBaseUrl = resolvedS.url;
      shadowIsOpenAICompat = shadowModel.startsWith('openai::');
      this._callbacks.log(`handleAgent: shadowModel="${shadowModel}" url="${shadowBaseUrl}"`);
    }

    if (!model) {
      this._callbacks.postToWebview({
        type: 'agentChunk',
        text: '\n**錯誤：Agent 模型未設定，請在 VS Code 設定中指定 amiAiClaw.model**\n',
      });
      this._agentRunning = false;
      this._callbacks.postToWebview({ type: 'agentStatus', running: false });
      return;
    }

    this._callbacks.log(`handleAgent: decoded model="${model}" url="${baseUrl}"`);
    await this._callbacks.ensureModelReady(baseUrl, model);

    if (this._agentMessages.length === 0) {
      const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
      const folderList = workspaceFolders.map((folder) => folder.uri.fsPath).join(', ') || process.cwd();
      const activeEditor = vscode.window.activeTextEditor;
      const activeFile = activeEditor?.document.uri.fsPath ?? '';
      const openFiles = vscode.workspace.textDocuments
        .filter((document) => !document.isUntitled && document.uri.scheme === 'file')
        .map((document) => document.uri.fsPath);

      // 自動附帶作用中檔案內容（可由設定關閉）
      const cfgAuto = vscode.workspace.getConfiguration('amiAiClaw');
      const autoInclude = cfgAuto.get<boolean>('autoIncludeActiveFile', true);
      const maxBytes = Math.max(1024, Math.min(64 * 1024, (cfgAuto.get<number>('autoIncludeActiveMaxKb', 16) || 16) * 1024));
      let activeFileBlock = '';
      if (autoInclude && activeEditor && !activeEditor.document.isUntitled && activeEditor.document.uri.scheme === 'file') {
        const raw = activeEditor.document.getText();
        const lang = activeEditor.document.languageId || '';
        const text = raw.length > maxBytes
          ? raw.slice(0, maxBytes) + `\n…（內容已截斷至 ${Math.floor(maxBytes / 1024)}KB，原始 ${Math.round(raw.length / 1024)}KB；如需完整內容請呼叫 read_file）`
          : raw;
        activeFileBlock = `\n\n## 作用中檔案內容（自動附帶）\n\`\`\`${lang}\n${text}\n\`\`\``;
      }

      // 深度解析：當 contextDepth 為 outline / full 時，附加整個工作區摘要或完整原始碼
      let workspaceDigestBlock = '';
      try {
        const depth = getCurrentContextDepth();
        if (depth !== 'file') {
          const digest = await buildWorkspaceDigest({
            depth,
            maxTotalKb: Math.max(8, cfgAuto.get<number>('outlineMaxKb', 24)),
            modelContextLength: this._modelContextLength,
            onProgress: (msg) => this._callbacks.postToWebview({ type: 'agentStepProgress', text: msg }),
          });
          if (digest.text) {
            workspaceDigestBlock = `\n\n${digest.text}`;
            this._callbacks.postToWebview({
              type: 'agentStepProgress',
              text: `🔬 深度解析（${depth}）：注入 ${digest.fileCount} 檔 / ${fmtSize(digest.bytes)} / ${digest.durationMs}ms${digest.truncated ? '（已截斷）' : ''}`,
            });
          }
        }
      } catch (e: unknown) {
        this._callbacks.log(`buildWorkspaceDigest failed: ${(e as Error)?.message ?? e}`);
      }

      this._callbacks.clearAgentTodos();
      const ltm = this._callbacks.getLongTermMemory();
      // Session Notes：載入上次筆記（若有），注入 system prompt 讓模型知道上次進度
      const sessionNotes = await this._callbacks.getSessionNotes();
      if (sessionNotes) {
        this._sessionNotesCache = sessionNotes;
        this._callbacks.log(`[SessionNotes] 注入上次筆記（${sessionNotes.length} bytes）`);
      }
      // 記錄本次任務描述（第一條 user 訊息，用於筆記 Task 區段）
      this._sessionTaskDescription = userPrompt.slice(0, 400);
      this._agentMessages.push({
        role: 'system',
        content: buildAgentSystemPrompt({
          folderList,
          activeFile,
          openFiles,
          activeFileBlock,
          workspaceDigestBlock,
          longTermMemory: ltm,
          sessionNotes: sessionNotes || undefined,
        }),
      });
    }

    const expandedPrompt = this._callbacks.expandFileMentions
      ? await this._callbacks.expandFileMentions(userPrompt)
      : userPrompt;
    this._agentMessages.push({ role: 'user', content: expandedPrompt });
    if (recordToShortTerm) {
      const chatHistory = this._callbacks.getChatHistory();
      chatHistory.push({ role: 'user', content: userPrompt });
      this._callbacks.postToWebview({
        type: 'historyCount',
        count: chatHistory.length,
        sessionId: this._callbacks.getActiveSessionId(),
      });
    }

    try {
      this._shadowInterventions = 0;
        this._shadowJustInjected = false;
      for (let step = 0; step < 20 && !this._agentCancel; step++) {
        let response: AgentExecutorChatMessage | undefined;
        const isOllama = !model.startsWith('copilot::') && !isOpenAICompat;
        await this.autoSummarizeHistory(model, baseUrl);
        this._postContextPercent();

        if (isOllama || isOpenAICompat) {
          this._callbacks.postToWebview({ type: 'streamStart' });
        }
        // 思考監控：追蹤 Ollama reasoning 模型的思考時長，每 15s 報告一次進度
        let _thinkStartTs = 0;
        let _thinkHasText = false;
        let _thinkTimerId: ReturnType<typeof setInterval> | undefined;
        const THINK_NUDGE_MS = 90_000;

        const onThinkChunk = isOllama
          ? (chunk: string) => {
              if (!_thinkStartTs) {
                _thinkStartTs = Date.now();
                _thinkTimerId = setInterval(() => {
                  if (!_thinkHasText) {
                    const sec = Math.round((Date.now() - _thinkStartTs) / 1000);
                    this._callbacks.postToWebview({ type: 'agentStepProgress', text: `\uD83E\uDD14 LLM 思考中\u2026 (${sec} 秒)` });
                  }
                }, 15_000);
              }
              this._callbacks.postToWebview({ type: 'thinkChunk', chunk, model });
            }
          : undefined;
        const onTextChunk = (isOllama || isOpenAICompat)
          ? (chunk: string) => {
              if (!_thinkHasText) {
                _thinkHasText = true;
                if (_thinkTimerId) { clearInterval(_thinkTimerId); _thinkTimerId = undefined; }
              }
              this._callbacks.postToWebview({ type: 'assistantChunk', chunk });
            }
          : undefined;
        const onStats = (isOllama || isOpenAICompat)
          ? (tokens: number, tps: number) => {
              this._callbacks.postToWebview({ type: 'streamStats', tokens, tps });
              this._callbacks.trackUsage(model, tokens);
            }
          : undefined;
        const openAiModel = isOpenAICompat ? model.slice('openai::'.length) : model;

        try {
          response = model.startsWith('copilot::')
            ? await this._services.copilotChatCallWithCts(model.slice('copilot::'.length), this._agentMessages, this._services.agentTools)
            : isOpenAICompat
              ? await this._services.openaiCompatChatCallStream(baseUrl, openAiModel, this._agentMessages, this._services.agentTools, onTextChunk, onStats)
              : await this._services.ollamaChatCallStream(baseUrl, model, this._agentMessages, this._services.agentTools, onThinkChunk, onTextChunk, onStats);

          if (response && !isOllama && !isOpenAICompat) {
            this._callbacks.trackUsage(
              model,
              Math.ceil(this._services.estimateTokens(response.content ?? '')),
              this._services.getCopilotMultiplierById(model.slice('copilot::'.length))
            );
          }
        } catch (error) {
          if (isOllama || isOpenAICompat) {
            this._callbacks.postToWebview({ type: 'streamAbort' });
          }
          const message = error instanceof Error ? error.message : String(error);
          if (/does not support tools/i.test(message)) {
            this._callbacks.postToWebview({
              type: 'error',
              text: `模型 ${model} 不支援工具呼叫（tools API）。\nAgent 模式需要支援 tools 的模型，例如：qwen2.5:7b、llama3.1:8b、mistral-nemo。\n請在 AMI-AiClaw 設定中更換模型。`,
            });
            break;
          }
          if (/token|limit|context|exceed/i.test(message) && this._agentMessages.length > 4) {
            await this.autoSummarizeHistory(model, baseUrl);
            if (isOllama || isOpenAICompat) {
              this._callbacks.postToWebview({ type: 'streamStart' });
            }
            response = model.startsWith('copilot::')
              ? await this._services.copilotChatCallWithCts(model.slice('copilot::'.length), this._agentMessages, this._services.agentTools)
              : isOpenAICompat
                ? await this._services.openaiCompatChatCallStream(baseUrl, openAiModel, this._agentMessages, this._services.agentTools, onTextChunk, onStats)
                : await this._services.ollamaChatCallStream(baseUrl, model, this._agentMessages, this._services.agentTools, onThinkChunk, onTextChunk, onStats);
          } else {
            throw error;
          }
        }

        // 清除思考計時器（正常輸出或錯誤均清除）
        if (_thinkTimerId) { clearInterval(_thinkTimerId); _thinkTimerId = undefined; }

        if (!response) {
          if (isOllama) {
            this._callbacks.postToWebview({ type: 'streamAbort' });
          }
          break;
        }

        if (response.tool_calls && response.tool_calls.length > 0) {
          if (isOllama) {
            this._callbacks.postToWebview({ type: 'streamAbort' });
          }
          this._agentMessages.push({ role: 'assistant', content: response.content ?? null, tool_calls: response.tool_calls });

          for (const toolCall of response.tool_calls) {
            const fn = toolCall.function;
            const args = (typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : fn.arguments) as Record<string, unknown>;
            this._callbacks.postToWebview({
              type: 'agentStep',
              icon: this._services.getToolIcon(fn.name),
              title: this._services.formatToolTitle(fn.name, args),
              fullPath: (args.path as string) || (args.command as string) || '',
            });

            let result: string;
            let isError = false;
            try {
              result = await this._callbacks.executeTool(fn.name, args, this._abortController.signal);
            } catch (error) {
              result = '錯誤：' + (error instanceof Error ? error.message : String(error));
              isError = true;
            }

            if (vscode.workspace.getConfiguration('amiAiClaw').get<boolean>('filterSensitiveInfo', true)) {
              result = this._services.filterSensitiveInfo(result);
            }

            this._callbacks.recordAuditEntry(fn.name, args, isError);
            this._callbacks.trackUsage(model, 0, '', true);

            // ── Carry-over 追蹤（仿 OpenHarness _record_tool_carryover）──
            this._carryover.track(fn.name, args, result, isError);

            // ── Session Notes：記錄錯誤 + 每 N 次工具呼叫自動儲存筆記 ──
            this._sessionToolCallCount++;
            if (isError) {
              this._sessionRecentErrors.push(`[${fn.name}] ${result.slice(0, 160)}`);
              if (this._sessionRecentErrors.length > 10) this._sessionRecentErrors.shift();
            }
            if (shouldUpdateNotes(this._sessionToolCallCount)) {
              const notes = buildSessionNotes(
                {
                  carryover: this._carryover.getState(),
                  taskDescription: this._sessionTaskDescription,
                  toolCallCount: this._sessionToolCallCount,
                  recentErrors: this._sessionRecentErrors,
                },
                this._sessionNotesCache,
              );
              this._sessionNotesCache = notes;
              this._enqueueNotes(() => this._callbacks.onSessionNotesUpdate(notes));
            }

            const preview = result.length > 400 ? `${result.slice(0, 400)}\n…（已截斷）` : result;
            this._callbacks.postToWebview({ type: 'agentStepDone', result: preview, isError });
            this._agentMessages.push({ role: 'tool', content: result, tool_call_id: toolCall.id ?? fn.name });

            // 大型檔案讀取後注入分析指令，避免 LLM 拿到大量資料後放棄不分析
            const isReadTool = ['read_file', 'read_file_smart', 'read_files', 'read_workspace'].includes(fn.name);
            if (isReadTool && result.length > 2000) {
              const originalQ = this._agentMessages.find(m => m.role === 'user')?.content ?? '';
              this._agentMessages.push({
                role: 'user',
                content: `以上是工具回傳的檔案內容。請立即根據內容完成任務：${typeof originalQ === 'string' ? originalQ.slice(0, 200) : ''}\n\n**不要描述你能做什麼，直接分析並給出結論。**`,
              });
            }

            if (recordToShortTerm) {
              const chatHistory = this._callbacks.getChatHistory();
              chatHistory.push({ role: 'assistant', content: preview });
              this._callbacks.postToWebview({
                type: 'historyCount',
                count: chatHistory.length,
                sessionId: this._callbacks.getActiveSessionId(),
              });
            }
          }
          continue;
        }

        const rawText = response.content ?? '';
        const thinkContent = response.thinking ?? (() => {
          const match = rawText.match(/^<think>([\s\S]*?)<\/think>\s*/);
          return match ? match[1].trim() : '';
        })();
        const text = thinkContent ? rawText.replace(/^<think>[\s\S]*?<\/think>\s*/, '') : rawText;

        // 思考完成但無文字輸出：督促 LLM 根據思考結果直接給出結論
        if (isOllama && !text.trim() && thinkContent.trim()) {
          this._callbacks.postToWebview({ type: 'streamEnd' });
          this._callbacks.postToWebview({ type: 'agentStepProgress', text: '\uD83E\uDD14 思考完成但無文字輸出，督促 LLM 給出結論…' });
          this._agentMessages.push({
            role: 'user',
            content: `你的推理過程（${thinkContent.length} 字）尚未產生任何回答。請根據你的推理立即給出完整結論，不要重新思考。`,
          });
          continue;
        }
        // 思考時間過長（有文字但思考超連 THINK_NUDGE_MS）：下一輪加速指示
        if (isOllama && _thinkStartTs && !_thinkHasText && Date.now() - _thinkStartTs > THINK_NUDGE_MS) {
          const thinkSec = Math.round((Date.now() - _thinkStartTs) / 1000);
          this._callbacks.log(`[ThinkMonitor] 思考耗時 ${thinkSec} 秒，下輪注入決斷提示`);
          this._agentMessages.push({
            role: 'user',
            content: `上一輪你思考了 ${thinkSec} 秒才給出回答。請更快作出決斷，總筐引用了足夠資訊即可立即輸出結論。`,
          });
        }

        // ── 截斷偵測：finish_reason/done_reason=length，自動續寫 ──
        if (response.truncated && text.trim() && step < 8) {
          this._callbacks.log(`AgentExecutor: 偵測到截斷回覆（step=${step}），注入續寫指令`);
          this._callbacks.postToWebview({ type: 'agentStepProgress', text: '✂️ 回覆被截斷，自動續寫…' });
          this._agentMessages.push({ role: 'user', content: '你的回覆被 token 上限截斷了，請從剛才的中斷處繼續輸出，不要重複已說過的內容。' });
          continue;
        }

        // ── 拒絕/謙遜偵測：模型說「無法執行」但應直接呼叫工具時，自動注入強制指令重試 ──
        if (isRefusalResponse(text) && step < 3) {
          this._callbacks.log(`AgentExecutor: 偵測到拒絕回覆（step=${step}），注入強制工具指令`);
          // 移除剛剛加入的錯誤 assistant 訊息（避免帶入歷史）
          this._agentMessages.pop();
          const toolReminder = step === 0
            ? '你剛才說無法執行，但這是錯誤的。你現在就在 AmiClaw Agent 模式中，擁有完整工具存取權限。'
              + '\n\n**可直接呼叫的工具（無需任何額外設定）：**\n'
              + '- run_command(command) — 執行任意 shell/PowerShell 指令\n'
              + '- read_file(path) — 讀取任意檔案\n'
              + '- list_dir(path) — 列出目錄\n'
              + '- search_workspace(query) — 搜尋工作區\n'
              + '- run_python(code) — 執行 Python\n'
              + '\n**禁止事項：** 禁止說「我的權限」「請切換至 Agent 模式」「Read-only 模式」等語句——你現在就是 Agent，直接呼叫工具即可。'
              + '\n\n請立即呼叫工具完成使用者的任務。'
            : '再次提醒：你是 AmiClaw Agent，直接呼叫 run_command 或 read_file 等工具即可，不得再解釋或建議使用者自行操作。立即執行。';
          this._agentMessages.push({ role: 'user', content: toolReminder });
          continue;
        }

        const tokenEstimate = Math.ceil(this._services.estimateTokens(rawText));
        this._agentMessages.push({ role: 'assistant', content: rawText });

        if (recordToShortTerm) {
          const chatHistory = this._callbacks.getChatHistory();
          chatHistory.push({ role: 'assistant', content: text || rawText });
          this._callbacks.postToWebview({
            type: 'historyCount',
            count: chatHistory.length,
            sessionId: this._callbacks.getActiveSessionId(),
          });
        }

        if (isOllama) {
          this._callbacks.postToWebview({ type: 'streamEnd' });
        } else {
          this._callbacks.postToWebview({
            type: 'assistant',
            text: text || rawText,
            thinking: thinkContent || undefined,
            tokens: tokenEstimate,
          });
        }

        // ── 影子督促人格（Monitor）：事件驅動，僅在主人格產出最終答案時喚醒 ──
        const finalText = (text || rawText).trim();
        const shadowEnabled = vscode.workspace.getConfiguration('amiAiClaw').get<boolean>('agentShadowSupervisor', true);
        // Ollama 免費不考慮成本，想審就審；收費模型才用 cost gate
        // Root Cause Fix: 有未結案待辦就強制審查，不管回覆長短
        const _pendingTodos = (this._callbacks.getAgentTodos?.() ?? []).filter(t => !t.done);
        // 督促剛注入時跳過第一輪確認語，避免超時導致無聲停止
        const _skipThisRound = this._shadowJustInjected;
        this._shadowJustInjected = false;
        const shadowWorthy = !_skipThisRound && ((isOllama ? finalText.length > 50 : AgentExecutor._isShadowWorthy(expandedPrompt, finalText))
          || _pendingTodos.length > 0);
        if (shadowEnabled && shadowWorthy && this._shadowInterventions < AgentExecutor.SHADOW_MAX && !this._agentCancel) {
          this._callbacks.postToWebview({ type: 'agentStepProgress', text: '🕵️ 影子督促：檢查分析完整性…' });
          const verdict = await this._runShadowSupervisor(expandedPrompt, finalText, shadowModel, shadowBaseUrl, shadowIsOpenAICompat, _pendingTodos);
          if (verdict && !verdict.complete) {
            this._shadowInterventions++;
            this._callbacks.log(`[ShadowSupervisor] 第 ${this._shadowInterventions} 次督促 — 缺口：${verdict.missing}`);
            // 改用永久可見的 agentStep，避免用戶錯過督促訊息
            this._callbacks.postToWebview({
              type: 'agentStep',
              icon: '🔍',
              title: `影子督促 ${this._shadowInterventions}/${AgentExecutor.SHADOW_MAX}：${(verdict.missing || '分析未完整').slice(0, 60)}`,
              fullPath: '',
            });
            this._callbacks.postToWebview({
              type: 'agentStepDone',
              result: (verdict.nextInstruction || '要求補完六階段分析').slice(0, 200),
              isError: false,
            });
            // 在注入新指示前將舊的影子指令壓縮為摘要，防止歷史堆疊
            for (const _m of this._agentMessages) {
              if (_m.role === 'user' && typeof _m.content === 'string' && _m.content.startsWith('【影子督促人格指示】')) {
                _m.content = `[影子督促第${this._shadowInterventions}次前舊指示（已壓縮）]`;
              }
            }
            this._agentMessages.push({
              role: 'user',
              content: `【影子督促人格指示】你的分析尚未完成。缺少：${verdict.missing || '（見下）'}\n\n${verdict.nextInstruction || '請依六階段分析法補完剩餘步驟。'}\n\n**【強制要求】立即呼叫工具（search_workspace、read_file 等）執行上述步驟，禁止給純文字說明或描述計劃。**`,
            });
            this._shadowJustInjected = true; // 下一輪確認語跳過 shadow 審查
            this._callbacks.postToWebview({ type: 'agentStepProgress', text: `▶️ 主人格繼續執行（第 ${this._shadowInterventions} 次督促後）…` });
            continue;
          }
          if (verdict) {
            this._callbacks.log('[ShadowSupervisor] 分析完整，放行。');
            if (this._shadowInterventions > 0) {
              this._callbacks.postToWebview({ type: 'agentStepProgress', text: `✅ 影子督促確認完整（共督促 ${this._shadowInterventions} 次）` });
            }
          } else {
            // verdict === null：督促呼叫失敗或超時，降級單人格但不中止 agent
            this._callbacks.log('[ShadowSupervisor] 呼叫失敗/超時，停用影子督促，主人格繼續執行。');
            this._callbacks.postToWebview({ type: 'agentStepProgress', text: '⚠️ 影子督促降級（超時），主人格繼續…' });
            // 將計數推到 SHADOW_MAX，後續步驟不再觸發 shadow
            this._shadowInterventions = AgentExecutor.SHADOW_MAX;
          }
        }
        break;
      }
    } catch (error) {
      this._callbacks.postToWebview({ type: 'error', text: 'Agent 錯誤：' + (error instanceof Error ? error.message : String(error)) });
    } finally {
      this._callbacks.trackLatency(model, Date.now() - agentStart);
      // Session Notes：任務完成時強制儲存一次（確保最終狀態持久化）
      if (this._sessionToolCallCount > 0) {
        const notes = buildSessionNotes(
          {
            carryover: this._carryover.getState(),
            taskDescription: this._sessionTaskDescription,
            toolCallCount: this._sessionToolCallCount,
            recentErrors: this._sessionRecentErrors,
          },
          this._sessionNotesCache,
        );
        this._sessionNotesCache = notes;
        this._enqueueNotes(() => this._callbacks.onSessionNotesUpdate(notes));
      }
      this._agentRunning = false;
      this._agentCancel = false;
      this._callbacks.setWaAgentMode(false);
      this._callbacks.postToWebview({ type: 'agentStatus', running: false });
    }
  }

  // Fix 2: 有界筆記佇列——超過 CAP 時捨棄最舊的 pending，保留最新狀態
  private _enqueueNotes(updater: () => Promise<void>): void {
    if (this._notesQueue.length >= AgentExecutor.NOTES_QUEUE_CAP) {
      this._notesQueue.shift(); // 最新 notes 永遠包含舊資訊，捨棄中間版本安全
    }
    this._notesQueue.push(updater);
    if (!this._notesQueueRunning) { void this._drainNotesQueue(); }
  }

  private async _drainNotesQueue(): Promise<void> {
    this._notesQueueRunning = true;
    while (this._notesQueue.length > 0) {
      const task = this._notesQueue.shift()!;
      try { await task(); } catch { /* error boundary: 筆記失敗不影響主流程 */ }
    }
    this._notesQueueRunning = false;
  }

  /** 影子督促人格單次執行的最大介入次數（斷路器），防止無限追問。 */
  private static readonly SHADOW_MAX = 10;

  /** L2: regex 去噪——ANSI、行尾空白、重复空行、大型 block comment */
  private static _denoiseContent(text: string): string {
    return text
      .replace(/\x1b\[[0-9;]*[mGKHFJABCDsuhl]/g, '')  // ANSI escape
      .replace(/[ \t]+$/gm, '')                          // trailing whitespace
      .replace(/\n{3,}/g, '\n\n')                       // squeeze blank lines
      .replace(/\/\*[\s\S]{300,}?\*\//g, '/* ... */')  // large block comments
      .trim();
  }

  /** L3: 導出結構簽名（函式、類別、import），丟棄實作內容 */
  private static _outlineContent(text: string): string {
    const kept: string[] = [];
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t || t.length > 160) continue;
      if (/^(export\s+)?(default\s+)?(async\s+)?(function|class|interface|type|enum)\b/.test(t)
       || /^(public|private|protected|static|async|readonly|abstract|override)\b/.test(t)
       || /^(import|from|#include|using|require)\b/.test(t)
       || /^(def |class |module |struct |fn |pub )/.test(t)) {
        kept.push(line);
      }
    }
    if (kept.length === 0) return '[outline: no signatures]';
    return `[Outline ${kept.length} sig]\n${kept.slice(0, 60).join('\n')}`;
  }

  private static _isShadowWorthy(task: string, response: string): boolean {
    if (response.length < 200) return false;
    const TASK_TRIGGERS = ['分析', '審查', 'review', 'analyze', '讀取', '檢查', 'debug', 'refactor', '重構', '架構', '程式', 'code', '找', '問題', '修正', '實作'];
    const CODE_SIGNALS = ['```', '函式', '函數', 'function', 'class ', 'interface ', '.ts', '.js', '.py', 'import ', '模組', 'module', '路徑', '檔案', '行號'];
    return TASK_TRIGGERS.some(k => task.toLowerCase().includes(k.toLowerCase()))
        || CODE_SIGNALS.some(k => response.includes(k));
  }
  /**
   * 影子督促人格（Monitor）：以同一模型單次審查主人格是否真正完成分析。
   * 思考結果只寫入 log（影子緩衝區），不串流至 webview；解析/呼叫失敗或超時回傳 null（斷路器降級）。
   */
  private async _runShadowSupervisor(
    task: string,
    finalAnswer: string,
    model: string,
    baseUrl: string,
    isOpenAICompat: boolean,
    pendingTodos: Array<{id: number; text: string}> = [],
  ): Promise<{ complete: boolean; missing: string; nextInstruction: string } | null> {
    const TIMEOUT_MS = 20000;
    const prompt = buildShadowSupervisorPrompt(task.slice(0, 1200), finalAnswer.slice(0, 4000), pendingTodos);

    const doCall = async (): Promise<{ complete: boolean; missing: string; nextInstruction: string } | null> => {
      let raw = '';
      try {
        if (model.startsWith('copilot::')) {
          const res = await this._services.copilotChatCallWithCts(
            model.slice('copilot::'.length),
            [{ role: 'user', content: prompt }],
            [],
          );
          raw = res.content ?? '';
        } else if (isOpenAICompat) {
          const res = await this._services.openaiCompatChatCallStream(
            baseUrl,
            model.slice('openai::'.length),
            [{ role: 'user', content: prompt }],
            [],
          );
          raw = res.content ?? '';
        } else {
          const res = await this._services.ollamaGenerate(baseUrl, model, prompt);
          raw = res.response ?? '';
        }
      } catch (e) {
        this._callbacks.log(`[ShadowSupervisor] 呼叫失敗，降級為單人格：${(e as Error)?.message ?? e}`);
        return null;
      }
      try {
        const m = raw.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [null, null];
        const jsonStr = (m[1] ?? raw).trim();
        const parsed = JSON.parse(jsonStr) as { complete?: boolean; missing?: string; nextInstruction?: string };
        return {
          complete: parsed.complete !== false,  // 僅在明確 false 時判定未完成
          missing: String(parsed.missing ?? ''),
          nextInstruction: String(parsed.nextInstruction ?? ''),
        };
      } catch {
        this._callbacks.log(`[ShadowSupervisor] 無法解析回覆，降級：${raw.slice(0, 200)}`);
        return null;
      }
    };

    // 20s timeout 防止 Ollama/Copilot 長時間阻塞
    const timeoutPromise = new Promise<null>(resolve =>
      setTimeout(() => {
        this._callbacks.log('[ShadowSupervisor] 超時 (>20s)，降級單人格');
        resolve(null);
      }, TIMEOUT_MS)
    );
    return Promise.race([doCall(), timeoutPromise]);
  }

  public async startAuto(initialPrompt: string, modelOverride?: string): Promise<void> {
    if (this._autoRunning) {
      vscode.window.showInformationMessage('自動執行已在進行中');
      return;
    }

    this._autoRunning = true;
    this._autoCancel = false;
    this._callbacks.postToWebview({ type: 'autoStatus', running: true });

    const cfg = vscode.workspace.getConfiguration('amiAiClaw');
    const urls = this._services.getOllamaUrls(cfg);
    const rawModel = modelOverride ?? cfg.get<string>('model') ?? '';
    const { url: baseUrl, model } = this._services.decodeOllamaModel(rawModel, urls);

    await this._callbacks.ensureModelReady(baseUrl, model);

    let currentPrompt = `${initialPrompt}\n\n請開始並持續改進直到完成；若需要存取工作目錄外的檔案，請回傳 'NEEDS_ACCESS: <path>'；完成時回傳 'DONE'.`;

    for (let i = 0; i < this._autoMaxIterations && !this._autoCancel; i++) {
      try {
        this._callbacks.postToWebview({ type: 'assistant', text: `（自動輪次 ${i + 1}）執行中…` });
        const result = await this._services.ollamaGenerate(baseUrl, model, currentPrompt);

        const accessMatch = /NEEDS_ACCESS:\s*([^\n\r]+)/i.exec(result.response) || /need access to\s*([^\n\r]+)/i.exec(result.response);
        if (accessMatch) {
          const requestedPath = (accessMatch[1] || '').trim();
          this._callbacks.postToWebview({ type: 'assistant', text: result.response, thinking: result.thinking });
          this._callbacks.postToWebview({ type: 'autoPaused', path: requestedPath });
          this._autoRunning = false;

          const grant = await vscode.window.showWarningMessage(`Assistant requests access to: ${requestedPath}`, 'Grant Access', 'Cancel');
          if (grant === 'Grant Access') {
            const uris = await vscode.window.showOpenDialog({
              canSelectFolders: true,
              canSelectMany: false,
              openLabel: 'Grant Access',
            });
            if (!uris || uris.length === 0) {
              vscode.window.showInformationMessage('未授權存取，已停止自動執行。');
              break;
            }
            const grantedPath = uris[0].fsPath;
            this._callbacks.postToWebview({ type: 'assistant', text: `User granted access to ${grantedPath}. Resuming...` });
            currentPrompt = `User granted access to ${grantedPath}. Continue your previous work. If you need specific files, ask the user. If finished, reply 'DONE'.`;
            this._autoRunning = true;
            continue;
          }

          this._callbacks.postToWebview({ type: 'assistant', text: 'User denied access. Stopping auto-run.' });
          break;
        }

        if (/\bDONE\b/i.test(result.response) || /已完成|完成了/i.test(result.response)) {
          this._callbacks.postToWebview({ type: 'assistant', text: result.response, thinking: result.thinking });
          this._callbacks.postToWebview({ type: 'autoStatus', running: false });
          this._autoRunning = false;
          break;
        }

        this._callbacks.postToWebview({ type: 'assistant', text: result.response, thinking: result.thinking });
        const codeMatch = /\`\`\`([\s\S]*?)\`\`\`/.exec(result.response);
        if (codeMatch) {
          try {
            await this._callbacks.handleInsert(codeMatch[1]);
          } catch {
            // ignore insertion errors
          }
        }

        currentPrompt = `基於你剛才的回應：\n${result.response}\n\n請繼續改進或完成。若需要存取工作目錄外的檔案，請回傳 'NEEDS_ACCESS: <path>'；若已完成請回傳 'DONE'。只回覆必要內容與程式碼區塊。`;
        await new Promise((resolve) => setTimeout(resolve, 600));
      } catch (error) {
        this._callbacks.postToWebview({ type: 'error', text: `Auto-run error: ${error instanceof Error ? error.message : String(error)}` });
        break;
      }
    }

    const wasCancelled = this._autoCancel;
    this._autoRunning = false;
    this._autoCancel = false;
    this._callbacks.postToWebview({ type: 'autoStatus', running: false });
    vscode.window.showInformationMessage(wasCancelled ? '自動執行已被中止。' : '自動執行已結束。');
  }

  /**
   * 拒絕語偵測搬到 ./RefusalDetector。
   * Context 百分比 + Carry-over 追蹤搬到 ./AgentCarryover。
   */

  // ─────────────────────────────────────────────────────────────────────────
  // Context 百分比（通知 webview 更新進度條）
  // ─────────────────────────────────────────────────────────────────────────
  private _postContextPercent(): void {
    const cfg = vscode.workspace.getConfiguration('amiAiClaw');
    const cfgThreshold = cfg.get<number>('autoSummarizeThreshold', 8000);
    const threshold = this._modelContextLength > 0 ? this._modelContextLength : cfgThreshold;
    const tokens = Math.ceil(this._services.estimateTokens(this._agentMessages.map(m => m.content ?? '').join('')));
    const pct = Math.round(tokens / threshold * 100);
    this._callbacks.postToWebview({ type: 'contextPercent', tokens, pct, threshold });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Microcompact：清除舊工具結果（零 LLM，最便宜）
  // 仿 OpenHarness microcompact_messages()
  // ─────────────────────────────────────────────────────────────────────────
  private _microcompact(keepRecent = 5): number {
    // 收集所有可壓縮工具結果的 tool_call_id（依工具名稱或內容大小判斷）
    const toolNameById = new Map<string, string>();
    const resultContentById = new Map<string, string>();
    const orderedIds: string[] = [];

    for (const msg of this._agentMessages) {
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          const id = tc.id ?? tc.function.name;
          orderedIds.push(id);
          toolNameById.set(id, tc.function.name);
        }
      }
      if (msg.role === 'tool' && msg.tool_call_id) {
        resultContentById.set(msg.tool_call_id, msg.content ?? '');
      }
    }

    const compactableIds = orderedIds.filter(id => {
      const name = toolNameById.get(id) ?? '';
      const content = resultContentById.get(id) ?? '';
      return COMPACTABLE_TOOLS.has(name) || content.length >= COMPACTABLE_TOOL_RESULT_CHARS;
    });

    if (compactableIds.length <= keepRecent) { return 0; }

    const clearSet = new Set(compactableIds.slice(0, compactableIds.length - keepRecent));
    let tokensSaved = 0;
    for (const msg of this._agentMessages) {
      if (msg.role === 'tool' && msg.tool_call_id && clearSet.has(msg.tool_call_id) && msg.content !== MC_CLEARED) {
        tokensSaved += estimateTokensRough(msg.content ?? '');
        msg.content = MC_CLEARED;
      }
    }
    return tokensSaved;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 自動摘要（3 層瀑布：Microcompact → LLM Summary → Fallback Drop）
  // ─────────────────────────────────────────────────────────────────────────
  private async autoSummarizeHistory(model: string, baseUrl: string): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('amiAiClaw');
    const enabled = cfg.get<boolean>('autoSummarizeHistory', true);
    const cfgThreshold = cfg.get<number>('autoSummarizeThreshold', 8000);

    // 向 Ollama/vLLM 查詢實際 context window；Copilot 模型回傳 0
    if (!model.startsWith('copilot::')) {
      const ctxLen = await this._services.ollamaGetContextLength(baseUrl, model);
      if (ctxLen > 0) { this._modelContextLength = ctxLen; }
    } else {
      this._modelContextLength = 0;
    }

    // 觸發摘要的門檻：若已知 context window 則取其 75%，否則沿用設定值
    const threshold = this._modelContextLength > 0
      ? Math.floor(this._modelContextLength * 0.75)
      : cfgThreshold;

    const systemMessage = this._agentMessages[0];
    const remainingMessages = this._agentMessages.slice(1);
    const totalTokens = this._services.estimateTokens((systemMessage?.content ?? '') + remainingMessages.map((message) => message.content ?? '').join(''));

    if (totalTokens < threshold) { return; }

    // ① Microcompact（零 LLM）
    const freed = this._microcompact(5);
    if (freed > 0) {
      const newTokens = this._services.estimateTokens((systemMessage?.content ?? '') + this._agentMessages.slice(1).map(m => m.content ?? '').join(''));
      this._callbacks.postToWebview({ type: 'agentStep', icon: '\uD83D\uDDDC\uFE0F', title: `Microcompact\uFF1A\u6E05\u9664\u820A\u5DE5\u5177\u7D50\u679C\uFF0C\u91CB\u51FA\u2248${freed} tokens\uFF08\u5269 \u2248${newTokens}\uFF09`, fullPath: '' });
      if (newTokens < threshold) { return; }
    }

    // ② L2: 去噪——regex 清理工具輸出（零 LLM，提高 Token 密度）
    // ③ L3: 結構層——冷區大型檔案讀取轉 Outline（零 LLM）
    // Ollama 免費不壓縮——保留全文以取得最佳分析品質
    const _isOllamaModel = !model.startsWith('copilot::') && !model.startsWith('openai::');
    if (!_isOllamaModel) {
      let l23Saved = 0;
      for (const msg of this._agentMessages) {
        if (msg.role === 'tool' && msg.content !== MC_CLEARED && (msg.content?.length ?? 0) > AgentExecutor.L2_MIN_LEN) {
          const before = msg.content!.length;
          msg.content = AgentExecutor._denoiseContent(msg.content!);
          l23Saved += before - msg.content.length;
        }
      }
      let hotBoundary = this._agentMessages.length;
      let aCount = 0;
      for (let i = this._agentMessages.length - 1; i >= 0; i--) {
        if (this._agentMessages[i].role === 'assistant' && ++aCount >= AgentExecutor.HOT_STEPS) { hotBoundary = i; break; }
      }
      for (let i = 1; i < hotBoundary; i++) {
        const msg = this._agentMessages[i];
        if (msg.role === 'tool' && msg.content !== MC_CLEARED && (msg.content?.length ?? 0) > 2000) {
          const outlined = AgentExecutor._outlineContent(msg.content!);
          if (outlined.length < msg.content!.length * 0.7) { l23Saved += msg.content!.length - outlined.length; msg.content = outlined; }
        }
      }
      if (l23Saved > 0) {
        const nowTokens = this._services.estimateTokens((systemMessage?.content ?? '') + this._agentMessages.slice(1).map(m => m.content ?? '').join(''));
        this._callbacks.postToWebview({ type: 'agentStep', icon: '🧹', title: `L2/L3：去噪+Outline 釋出 ≈${l23Saved} chars（剩 ≈${nowTokens} tokens）`, fullPath: '' });
        if (nowTokens < threshold) { return; }
      }
    } // end !_isOllamaModel

    const dropFallback = (messages: AgentExecutorChatMessage[]) => {
      let trimmed = messages;
      while (trimmed.length > 2 && this._services.estimateTokens((systemMessage?.content ?? '') + trimmed.map((message) => message.content ?? '').join('')) >= threshold) {
        let dropCount = 1;
        while (dropCount < trimmed.length && trimmed[dropCount].role === 'tool') { dropCount++; }
        trimmed = trimmed.slice(dropCount);
        while (trimmed.length > 0 && trimmed[0].role === 'tool') { trimmed = trimmed.slice(1); }
      }
      this._agentMessages = [systemMessage, ...trimmed];
      this._agentMessagesBySession[this._callbacks.getActiveSessionId()] = this._agentMessages;
    };

    if (!enabled) { dropFallback(remainingMessages); return; }

    // 保留最新 4 則，對前面的進行 LLM 摘要
    let splitAt = Math.max(remainingMessages.length - 4, 0);
    while (splitAt > 0 && remainingMessages[splitAt].role === 'tool') { splitAt--; }
    const keepTail = remainingMessages.slice(splitAt);
    // Fix 3: 排除無意義佔位符，避免浪費 LLM 摘要額度
    const toSummarize = remainingMessages.slice(0, splitAt).filter(m => {
      const c = m.content ?? '';
      return c !== MC_CLEARED
          && !String(c).startsWith('[影子督促')
          && !String(c).startsWith('[自動摘要');  // 保護摘要錨點（Fix 5）
    });
    if (toSummarize.length < 2) { return; }

    this._callbacks.postToWebview({ type: 'agentStep', icon: '📝', title: `對話歷史過長（≈${totalTokens} tokens），自動摘要舊訊息中…`, fullPath: '' });

    // ② 結構化 9-段摘要 Prompt（仿 OpenHarness BASE_COMPACT_PROMPT）
    const compactPrompt = `**重要：只能輸出純文字，禁止呼叫任何工具。**

你的任務是對以下對話記錄產生一份詳細的繁體中文摘要，此摘要將取代舊訊息，因此必須捕捉所有重要資訊。

請先在 <分析> 標籤內草擬你的分析，按時間順序整理：
- 每個使用者請求的完整意圖
- 採用的技術方法與決策
- 討論到的具體程式碼、檔案路徑（含行號）
- 遇到的錯誤以及修復方式
- 使用者的反饋或更正

然後在 <摘要> 標籤內產生結構化摘要，包含以下 9 個段落：

1. **主要請求與意圖**：所有使用者請求的完整細節（含隱含需求與限制條件）
2. **關鍵技術概念**：討論過的技術、框架、設計模式與慣例
3. **檔案與程式碼段落**：每個檢查或修改過的檔案（含具體程式碼片段與行號）
4. **錯誤與修復**：每個遇到的錯誤、原因及解決方式
5. **問題解決過程**：已解決的問題、有效與無效的方法
6. **所有使用者訊息**：保留原文以維持上下文
7. **待完成任務**：明確要求但尚未完成的工作
8. **目前工作**：壓縮前正在進行的最後任務的詳細描述
9. **建議的下一步**：與最近使用者請求直接對應的最合邏輯的下一步

**再次提醒：禁止呼叫工具，只輸出 <分析>...</分析> 和 <摘要>...</摘要>。**`;

    const summaryMessages: AgentExecutorChatMessage[] = [
      { role: 'system', content: '你是對話摘要助手，只輸出繁體中文純文字，禁止呼叫工具。' },
      {
        role: 'user',
        content: compactPrompt + '\n\n以下是要摘要的對話記錄：\n\n'
          // Fix 4: tool 結果保留更大視窗（3000），其他訊息維持 600，避免截斷關鍵程式碼
          + toSummarize.map(m => `[${m.role}]: ${(m.content ?? '').slice(0, m.role === 'tool' ? 3000 : 600)}`).join('\n\n').slice(0, 12000),
      },
    ];

    // Fix 3: 記錄快照長度，用於摘要完成後 rebase 期間並行新增的訊息
    const snapshotLen = this._agentMessages.length;
    let summary = '';
    try {
      const response = model.startsWith('copilot::')
        ? await this._services.copilotChatCallWithCts(model.slice('copilot::'.length), summaryMessages, [])
        : model.startsWith('openai::')
          ? await this._services.openaiCompatChatCallStream(baseUrl, model.slice('openai::'.length), summaryMessages, [])
          : await this._services.ollamaChatCallStream(baseUrl, model, summaryMessages, []);
      // 擷取摘要段落（同時相容 <summary>/<摘要> 標籤）
      summary = formatCompactSummary((response?.content ?? '').trim());
    } catch {
      // fallback below
    }

    if (!summary) {
      dropFallback(remainingMessages);
      this._callbacks.postToWebview({ type: 'agentStep', icon: '⚠️', title: '摘要失敗，改用裁剪模式', fullPath: '' });
      return;
    }

    // 加入 carry-over attachments（task focus、read files、work log）
    const carryoverText = this._carryover.buildAttachments();

    // Fix 3: rebase——將摘要非同步進行期間並行 push 的訊息重播到新歷史末尾
    const _rebase = this._agentMessages.slice(snapshotLen);
    this._agentMessages = [
      systemMessage,
      { role: 'user', content: `[自動摘要 — 先前 ${toSummarize.length} 則對話重點]\n${summary}${carryoverText}` },
      { role: 'assistant', content: '已了解先前對話的進度與重要資訊，繼續執行任務。' },
      ...keepTail,
      ..._rebase,
    ];
    this._agentMessagesBySession[this._callbacks.getActiveSessionId()] = this._agentMessages;
    const newTokens = this._services.estimateTokens(this._agentMessages.map(m => m.content ?? '').join(''));
    this._callbacks.postToWebview({
      type: 'agentStep',
      icon: '✅',
      title: `摘要完成：${toSummarize.length} 則壓縮為 1 則摘要，釋出≈${totalTokens - newTokens} tokens`,
      fullPath: '',
    });
  }
}
