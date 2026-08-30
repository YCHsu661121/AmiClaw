import * as vscode from 'vscode';
import { DEFAULT_COMPACTABLE_TOOLS } from '../context/MicroCompactor';
import { estimateTokensRough } from '../context/TokenBudgetManager';
import { formatCompactSummary } from '../context/HistoryCompactor';
import { buildWorkspaceDigest, getCurrentContextDepth, fmtSize } from '../context/WorkspaceDigest';
import { buildAgentSystemPrompt, buildShadowSupervisorPrompt } from '../context/SystemPromptBuilder';
import { AgentCarryover } from './AgentCarryover';
import { isRefusalResponse, isChoiceConfirmation } from './RefusalDetector';
import { TaskStore } from './TaskStore';
import { HeartbeatService } from '../services/HeartbeatService';
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
  /** 取得目前未結案的 manage_todo 項目，供影子審查用途 */
  getAgentTodos?: () => Array<{id: number; text: string; done: boolean}>;
  /** Session Notes — Agent 執行中每 N 次工具呼叫後自動呼叫，持久化筆記 */
  onSessionNotesUpdate: (notes: string) => Promise<void>;
  /** 專案規則層（RULES.md）——必常注入，優先級高於記憶 */
  getProjectRules?: () => string;
  /** WA 觸發完成後自動回傳精簡結果（取代模型手動呼叫 whatsapp_send） */
  notifyWaOwner?: (text: string) => void;
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
    onStats?: (tokens: number, tps: number) => void,
    onThinkChunk?: (chunk: string) => void
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
  /** 最少工具呼叫數才值得觸發 LLM 背景記憶更新 */
  private static readonly LLM_MEMORY_MIN_CALLS = 3;

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

  // ── Coordinator + Worker 架構（claude-code 模式） ────────────────────────

  /**
   * Coordinator 模式：模型只持有 spawn_worker / coordinator_done 兩個工具，
   * 負責規劃和拆解任務。每次呼叫 spawn_worker 時，在隔離 context 內啟動一個
   * 擁有完整工具集的 Worker agent 並等待其完成，再把結果回傳給 Coordinator。
   */
  public async handleCoordinator(userPrompt: string, modelOverride?: string): Promise<void> {
    if (this._agentRunning) {
      this._callbacks.postToWebview({ type: 'error', text: 'Agent 已在執行中，請等候完成' });
      return;
    }
    this._agentRunning = true;
    this._agentCancel = false;
    this._abortController = new AbortController();
    this._callbacks.postToWebview({ type: 'agentStatus', running: true });

    const cfg = vscode.workspace.getConfiguration('amiAiClaw');
    const urls = this._services.getOllamaUrls(cfg);
    const rawModel = modelOverride ?? cfg.get<string>('model') ?? 'llama3';
    const normalizedModel = rawModel.startsWith('copilot/') ? `copilot::${rawModel.slice('copilot/'.length)}` : rawModel;
    const { url: baseUrl, model } = normalizedModel.startsWith('copilot::')
      ? { url: urls[0], model: normalizedModel }
      : this._services.decodeOllamaModel(normalizedModel, urls);

    await this._callbacks.ensureModelReady(baseUrl, model);

    // Coordinator 4 tools: task lifecycle + worker spawn
    const coordinatorTools = [
      {
        type: 'function',
        function: {
          name: 'create_task',
          description: 'Create a tracked task before spawning a worker. Builds a visible task plan. Returns the task_id to pass to spawn_worker.',
          parameters: {
            type: 'object',
            properties: {
              id:          { type: 'string',  description: 'Short stable identifier, e.g. "explore-auth", "implement-login" (auto-generated if omitted)' },
              description: { type: 'string',  description: 'What the worker should accomplish' },
              context:     { type: 'string',  description: 'Background info / constraints for the worker (optional)' },
            },
            required: ['description'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'list_tasks',
          description: 'Show all tasks and their current status (created/claimed/completed/failed/blocked). Call after spawning workers to review progress.',
          parameters: { type: 'object', properties: {} },
        },
      },
      {
        type: 'function',
        function: {
          name: 'spawn_worker',
          description: 'Spawn a Worker agent to execute a subtask. If you created a task with create_task, pass its id via task_id to link them.',
          parameters: {
            type: 'object',
            properties: {
              task:    { type: 'string', description: 'Clear description of the specific subtask for the worker' },
              context: { type: 'string', description: 'Optional background context or constraints for the worker' },
              task_id: { type: 'string', description: 'Optional: ID of a task created with create_task (transitions it created→claimed)' },
            },
            required: ['task'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'coordinator_done',
          description: 'Signal that all subtasks are complete. Provide a summary of what was accomplished.',
          parameters: {
            type: 'object',
            properties: {
              summary: { type: 'string', description: 'Summary of all completed work' },
            },
            required: ['summary'],
          },
        },
      },
    ];

    const systemPrompt = [
      '你是任務協調員（Coordinator）。你的職責是：',
      '1. 分析使用者的任務，先呼叫 create_task 建立計劃（可選，但建議）',
      '2. 使用 spawn_worker 將具體工作委派給 Worker agent（Worker 有完整工具存取）',
      '3. 收到 Worker 回傳結果後，可用 list_tasks 查看全局進度，再決定下一步',
      '4. 全部完成後呼叫 coordinator_done',
      '',
      '規則：',
      '- 你自己不執行任何工具操作，只做規劃和協調',
      '- 每個 spawn_worker 的 task 描述要清晰具體',
      '- 複雜任務可以拆成多個連續的 spawn_worker 呼叫',
      `- 工作區路徑：${vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()}`,
    ].join('\n');

    const coordinatorMessages: AgentExecutorChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt },
    ];

    let workerCount = 0;
    const taskStore = new TaskStore();
    const MAX_STEPS = 20;

    try {
      for (let step = 0; step < MAX_STEPS && !this._agentCancel; step++) {
        this._callbacks.postToWebview({ type: 'streamStart', thinking: true });

        let response: AgentExecutorChatMessage;
        try {
          if (model.startsWith('copilot::')) {
            response = await this._services.copilotChatCallWithCts(model.slice('copilot::'.length), coordinatorMessages, coordinatorTools);
          } else if (model.startsWith('openai::')) {
            response = await this._services.openaiCompatChatCallStream(
              baseUrl, model.slice('openai::'.length), coordinatorMessages, coordinatorTools,
              (c) => this._callbacks.postToWebview({ type: 'assistantChunk', chunk: c }),
            );
          } else {
            response = await this._services.ollamaChatCallStream(
              baseUrl, model, coordinatorMessages, coordinatorTools,
              undefined,
              (c) => this._callbacks.postToWebview({ type: 'assistantChunk', chunk: c }),
            );
          }
        } catch (err) {
          this._callbacks.postToWebview({ type: 'streamAbort' });
          throw err;
        }

        this._callbacks.postToWebview({ type: 'streamEnd' });
        coordinatorMessages.push({ role: 'assistant', content: response.content ?? null, tool_calls: response.tool_calls });

        if (!response.tool_calls?.length) {
          // Coordinator finished without calling coordinator_done — still done
          break;
        }

        let allDone = false;
        for (const toolCall of response.tool_calls) {
          const fn = toolCall.function;
          const args = (typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : fn.arguments) as Record<string, unknown>;

          if (fn.name === 'coordinator_done') {
            const summary = String(args.summary ?? '');
            this._callbacks.postToWebview({ type: 'agentStep', icon: '✅', title: `協調完成：${summary.slice(0, 80)}`, fullPath: '' });
            this._callbacks.postToWebview({ type: 'taskUpdate', tasks: taskStore.getAll() });
            coordinatorMessages.push({ role: 'tool', content: 'done', tool_call_id: toolCall.id ?? fn.name });
            allDone = true;
            break;
          }

          if (fn.name === 'create_task') {
            const t = taskStore.create(
              String(args.description ?? ''),
              String(args.context ?? '') || undefined,
              String(args.id ?? '') || undefined,
            );
            this._callbacks.postToWebview({ type: 'taskUpdate', tasks: taskStore.getAll() });
            coordinatorMessages.push({ role: 'tool', content: `任務 [${t.id}] 已建立：${t.description}`, tool_call_id: toolCall.id ?? fn.name });
            continue;
          }

          if (fn.name === 'list_tasks') {
            coordinatorMessages.push({ role: 'tool', content: taskStore.format(), tool_call_id: toolCall.id ?? fn.name });
            continue;
          }

          if (fn.name === 'spawn_worker') {
            workerCount++;
            const task    = String(args.task    ?? '');
            const context = String(args.context ?? '');
            const taskId  = String(args.task_id ?? '').trim();

            // Ensure task is tracked: link to existing or auto-create
            const trackId = taskId && taskStore.get(taskId)
              ? taskId
              : taskStore.create(task, context || undefined, taskId || undefined).id;
            taskStore.claim(trackId, workerCount);
            this._callbacks.postToWebview({ type: 'taskUpdate', tasks: taskStore.getAll() });
            this._callbacks.postToWebview({ type: 'agentStep', icon: '🔧', title: `Worker #${workerCount} [${trackId}]：${task.slice(0, 70)}`, fullPath: '' });

            const result = await this._runWorker(task, context, model, baseUrl, workerCount);

            const resolveStatus = result.status === 'error' ? 'failed' : result.status as 'completed' | 'failed' | 'blocked';
            taskStore.resolve(trackId, resolveStatus, result.text);
            this._callbacks.postToWebview({ type: 'taskUpdate', tasks: taskStore.getAll() });

            const preview = result.text.length > 300 ? result.text.slice(0, 300) + '…' : result.text;
            this._callbacks.postToWebview({ type: 'agentStepDone', result: preview, isError: result.status !== 'completed' });
            coordinatorMessages.push({ role: 'tool', content: result.text, tool_call_id: toolCall.id ?? fn.name });
          }
        }

        if (allDone) break;
      }
    } catch (error) {
      this._callbacks.postToWebview({ type: 'error', text: 'Coordinator 錯誤：' + (error instanceof Error ? error.message : String(error)) });
    } finally {
      this._agentRunning = false;
      this._agentCancel = false;
      this._callbacks.postToWebview({ type: 'agentStatus', running: false });
    }
  }

  /** Worker agent：以 CORE_TOOLS 啟動，model 可呼叫 search_tools 動態解鎖 EXTRA_TOOLS */
  private async _runWorker(
    task: string,
    context: string,
    model: string,
    baseUrl: string,
    workerIdx: number,
  ): Promise<{ text: string; status: 'completed' | 'failed' | 'blocked' | 'error' }> {
    const { LLM_TOOLS, REPORT_RESULT_TOOL, searchExtraTools } = await import('../tools/ToolRegistry');
    const { loadWorkflow, listWorkflows, buildWorkflowCoordinatorPrompt } = await import('../services/WorkflowEngine');

    const workerSystemPrompt = [
      `你是 Worker Agent #${workerIdx}。你有 CORE 工具集；如需其他工具，呼叫 search_tools(query) 找到後即可使用。`,
      '你的職責：使用工具完成協調員委派的子任務，最後**必須**呼叫 report_result 回報。',
      '規則：',
      '1. 直接用工具完成任務，勿過多解說',
      '2. 完成後呼叫 report_result(status, summary, files_changed?)，summary 限 500 字',
      '3. 協調員只看 report_result 的摘要，不看工具輸出詳情',
      `工作區：${vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()}`,
    ].join('\n');

    const workerMessages: AgentExecutorChatMessage[] = [
      { role: 'system', content: workerSystemPrompt },
      { role: 'user', content: context ? `任務：${task}\n\n背景：${context}` : `任務：${task}` },
    ];

    // Dynamically extended tool set — starts with LLM_TOOLS + report_result
    let activeLlmTools: unknown[] = [...LLM_TOOLS, REPORT_RESULT_TOOL];
    const MAX_WORKER_STEPS = 30;
    let finalText = '';
    let finalStatus: 'completed' | 'failed' | 'blocked' | 'error' = 'completed';
    let workerDone = false;

    for (let step = 0; step < MAX_WORKER_STEPS && !this._agentCancel && !workerDone; step++) {
      let response: AgentExecutorChatMessage;
      try {
        if (model.startsWith('copilot::')) {
          response = await this._services.copilotChatCallWithCts(model.slice('copilot::'.length), workerMessages, activeLlmTools);
        } else if (model.startsWith('openai::')) {
          response = await this._services.openaiCompatChatCallStream(
            baseUrl, model.slice('openai::'.length), workerMessages, activeLlmTools,
            (c) => this._callbacks.postToWebview({ type: 'assistantChunk', chunk: c }),
          );
        } else {
          response = await this._services.ollamaChatCallStream(
            baseUrl, model, workerMessages, activeLlmTools,
            undefined, (c) => this._callbacks.postToWebview({ type: 'assistantChunk', chunk: c }),
          );
        }
      } catch (err) {
        return { text: `Worker 錯誤：${err instanceof Error ? err.message : String(err)}`, status: 'error' };
      }

      workerMessages.push({ role: 'assistant', content: response.content ?? null, tool_calls: response.tool_calls });

      if (!response.tool_calls?.length) { finalText = response.content ?? ''; break; }

      for (const toolCall of response.tool_calls) {
        const fn = toolCall.function;
        const args = (typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : fn.arguments) as Record<string, unknown>;

        // ── report_result: Worker summary → Coordinator (only visible output) ──
        if (fn.name === 'report_result') {
          const status       = String(args.status ?? 'completed');
          const summary      = String(args.summary ?? '').slice(0, 500);
          const filesChanged = Array.isArray(args.files_changed) ? (args.files_changed as string[]) : [];
          const errors       = String(args.errors ?? '');
          const icon         = status === 'completed' ? '✅' : status === 'failed' ? '❌' : '⚠️';

          const parts = [`[Worker #${workerIdx} ${icon} ${status}]`, `摘要：${summary}`];
          if (filesChanged.length) parts.push(`修改檔案：${filesChanged.join(', ')}`);
          if (errors) parts.push(`錯誤：${errors}`);
          finalText = parts.join('\n');
          finalStatus = status as 'completed' | 'failed' | 'blocked';

          this._callbacks.postToWebview({ type: 'agentStepDone', result: summary.slice(0, 200), isError: status !== 'completed' });
          workerMessages.push({ role: 'tool', content: 'done', tool_call_id: toolCall.id ?? fn.name });
          workerDone = true;
          break; // exits inner for-loop; outer loop exits via !workerDone
        }

        // ── search_tools: TF-IDF deferred tool discovery ─────────────────────
        if (fn.name === 'search_tools') {
          const query = String(args.query ?? '');
          const topK = Number(args.top_k ?? 5);
          const found = searchExtraTools(query, topK);
          // Add found tools to activeLlmTools (dedup by name)
          const existing = new Set(activeLlmTools.map((t: any) => t.function?.name));
          for (const t of found) { if (!existing.has(t.function.name)) activeLlmTools.push(t); }
          const names = found.map((t: any) => t.function.name).join(', ');
          const msg = found.length > 0
            ? `找到 ${found.length} 個工具已解鎖：${names}`
            : `找不到與「${query}」相關的工具`;
          this._callbacks.postToWebview({ type: 'agentStep', icon: '🔭', title: `search_tools: ${query}`, fullPath: '' });
          this._callbacks.postToWebview({ type: 'agentStepDone', result: msg, isError: false });
          workerMessages.push({ role: 'tool', content: msg, tool_call_id: toolCall.id ?? fn.name });
          continue;
        }

        // ── workflow_list ─────────────────────────────────────────────────────
        if (fn.name === 'workflow_list') {
          const workflows = await listWorkflows();
          const result = workflows.length === 0
            ? '（尚無已儲存的工作流程）'
            : workflows.map(w => `• ${w.name}（${w.steps.length} 步）: ${w.description}`).join('\n');
          workerMessages.push({ role: 'tool', content: result, tool_call_id: toolCall.id ?? fn.name });
          continue;
        }

        // ── workflow_run: load and return coordinator prompt ──────────────────
        if (fn.name === 'workflow_run') {
          const wfName = String(args.name ?? '');
          const wf = await loadWorkflow(wfName);
          if (!wf) {
            workerMessages.push({ role: 'tool', content: `找不到工作流程「${wfName}」，請先用 workflow_list 確認名稱`, tool_call_id: toolCall.id ?? fn.name });
          } else {
            const prompt = buildWorkflowCoordinatorPrompt(wf);
            workerMessages.push({ role: 'tool', content: `工作流程已載入（${wf.steps.length} 步）：\n${prompt}`, tool_call_id: toolCall.id ?? fn.name });
          }
          continue;
        }

        // ── Normal tool execution ─────────────────────────────────────────────
        this._callbacks.postToWebview({
          type: 'agentStep',
          icon: this._services.getToolIcon(fn.name),
          title: `  ↳ ${this._services.formatToolTitle(fn.name, args)}`,
          fullPath: (args.path as string) || '',
        });

        let result: string;
        try {
          result = await this._callbacks.executeTool(fn.name, args, this._abortController.signal);
        } catch (e) {
          result = '工具錯誤：' + (e instanceof Error ? e.message : String(e));
        }

        this._callbacks.recordAuditEntry(fn.name, args, false);
        this._callbacks.postToWebview({ type: 'agentStepDone', result: result.slice(0, 300), isError: false });
        workerMessages.push({ role: 'tool', content: result, tool_call_id: toolCall.id ?? fn.name });

        if (workerMessages[workerMessages.length - 1]?.role === 'tool') {
          workerMessages.push({ role: 'user', content: '工具已完成，請繼續執行任務。' });
        }
      }
    }

    return { text: finalText || '（Worker 完成但無文字輸出）', status: finalStatus };
  }

  public switchSession(sessionId: string): void {
    if (!this._agentMessagesBySession[sessionId]) {
      this._agentMessagesBySession[sessionId] = [];
    }
    this._agentMessages = this._agentMessagesBySession[sessionId];
  }

  public setAgentMessagesForSession(sessionId: string, messages: AgentExecutorChatMessage[]): void {
    this._agentMessagesBySession[sessionId] = messages;
    if (this._callbacks.getActiveSessionId() === sessionId) {
      this._agentMessages = messages;
    }
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
    HeartbeatService.getInstance().setAgentInfo({
      running: true, step: 0, model: '', shadowRunning: false,
      shadowCount: 0, lastActivity: '初始化', startedAt: agentStart,
    });

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

    // 查詢 context window；若尚未快取且非 Copilot，提前取一次，以便決定是否削減 system prompt
    if (this._modelContextLength === 0 && !model.startsWith('copilot::')) {
      const ctxLen = await this._services.ollamaGetContextLength(baseUrl, model);
      if (ctxLen > 0) {
        this._modelContextLength = ctxLen;
        this._callbacks.log(`handleAgent: context_length=${ctxLen}`);
      }
    }
    // 小 context（≤16384）時跳過大型注入以避免 token 超限
    const _smallCtx = this._modelContextLength > 0 && this._modelContextLength <= 16384;

    if (this._agentMessages.length === 0) {
      const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
      const folderList = workspaceFolders.map((folder) => folder.uri.fsPath).join(', ') || process.cwd();
      const activeEditor = vscode.window.activeTextEditor;
      const activeFile = activeEditor?.document.uri.fsPath ?? '';
      const openFiles = vscode.workspace.textDocuments
        .filter((document) => !document.isUntitled && document.uri.scheme === 'file')
        .map((document) => document.uri.fsPath);

      // 自動附帶作用中檔案內容（可由設定關閉；小 context 時跳過）
      const cfgAuto = vscode.workspace.getConfiguration('amiAiClaw');
      const autoInclude = cfgAuto.get<boolean>('autoIncludeActiveFile', true);
      const maxBytes = Math.max(1024, Math.min(64 * 1024, (cfgAuto.get<number>('autoIncludeActiveMaxKb', 16) || 16) * 1024));
      let activeFileBlock = '';
      if (!_smallCtx && autoInclude && activeEditor && !activeEditor.document.isUntitled && activeEditor.document.uri.scheme === 'file') {
        const raw = activeEditor.document.getText();
        const lang = activeEditor.document.languageId || '';
        const text = raw.length > maxBytes
          ? raw.slice(0, maxBytes) + `\n…（內容已截斷至 ${Math.floor(maxBytes / 1024)}KB，原始 ${Math.round(raw.length / 1024)}KB；如需完整內容請呼叫 read_file）`
          : raw;
        activeFileBlock = `\n\n## 作用中檔案內容（自動附帶）\n\`\`\`${lang}\n${text}\n\`\`\``;
      } else if (_smallCtx && autoInclude) {
        this._callbacks.log(`handleAgent: smallCtx(${this._modelContextLength}), skip activeFileBlock`);
      }

      // 深度解析：當 contextDepth 為 outline / full 時（小 context 時強制跳過）
      let workspaceDigestBlock = '';
      try {
        const depth = getCurrentContextDepth();
        if (!_smallCtx && depth !== 'file') {
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
      const projectRules = this._callbacks.getProjectRules?.() ?? '';
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
          projectRules: projectRules || undefined,
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

    let _waLastFinalText = ''; // tracks last agent answer for auto WA reply
    try {
      this._shadowInterventions = 0;
        this._shadowJustInjected = false;
      let _jsonToolErrRetries = 0; // retry counter for malformed tool-call JSON from Ollama
      for (let step = 0; step < 1000000000 && !this._agentCancel; step++) {
        let response: AgentExecutorChatMessage | undefined;
        const isOllama = !model.startsWith('copilot::') && !isOpenAICompat;
        this._callbacks.log(`[Agent step=${step}] model="${model}" isOpenAI=${isOpenAICompat} isOllama=${isOllama} msgs=${this._agentMessages.length}`);
        HeartbeatService.getInstance().setAgentInfo({ step, model, lastActivity: `step ${step} 請求中` });
        await this.autoSummarizeHistory(model, baseUrl);
        this._postContextPercent();

        if (isOllama || isOpenAICompat) {
          this._callbacks.postToWebview({ type: 'streamStart', thinking: true });
        }
        let _thinkStartTs = 0;
        let _thinkHasText = false;
        let _thinkTimerId: ReturnType<typeof setInterval> | undefined;
        const THINK_NUDGE_MS = 90_000;

        const onThinkChunk = (isOllama || isOpenAICompat)
          ? (chunk: string) => {
              if (!_thinkStartTs) {
                _thinkStartTs = Date.now();
                this._callbacks.log(`[Agent onThinkChunk] first chunk len=${chunk.length} model=${model}`);
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
          this._callbacks.log(`[Agent step=${step}] calling ${isOpenAICompat ? 'openaiCompat' : isOllama ? 'ollama' : 'copilot'} url=${baseUrl}`);
          response = model.startsWith('copilot::')
            ? await this._services.copilotChatCallWithCts(model.slice('copilot::'.length), this._agentMessages, this._services.agentTools)
            : isOpenAICompat
              ? await this._services.openaiCompatChatCallStream(baseUrl, openAiModel, this._agentMessages, this._services.agentTools, onTextChunk, onStats, onThinkChunk)
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
              text: `模型 ${model} 不支援工具呼叫（tools API）。\nAgent 模式需要支援 tools 的模型，例如：qwen2.5:7b、llama3.1:8b、mistral-nemo。\n請在 AmiClaw 設定中更換模型。`,
            });
            break;
          }
          if (/token|limit|context|exceed/i.test(message) && this._agentMessages.length > 4) {
            await this.autoSummarizeHistory(model, baseUrl);
            if (isOllama || isOpenAICompat) {
              this._callbacks.postToWebview({ type: 'streamStart', thinking: true });
            }
            response = model.startsWith('copilot::')
              ? await this._services.copilotChatCallWithCts(model.slice('copilot::'.length), this._agentMessages, this._services.agentTools)
              : isOpenAICompat
                ? await this._services.openaiCompatChatCallStream(baseUrl, openAiModel, this._agentMessages, this._services.agentTools, onTextChunk, onStats, onThinkChunk)
                : await this._services.ollamaChatCallStream(baseUrl, model, this._agentMessages, this._services.agentTools, onThinkChunk, onTextChunk, onStats);
          } else if (/invalid tool call|unexpected end of json|malformed.*tool|tool.*json|json.*parse/i.test(message) && _jsonToolErrRetries < 5) {
            _jsonToolErrRetries++;
            this._callbacks.log(`[Agent] Ollama tool-call JSON 錯誤，第 ${_jsonToolErrRetries}/5 次重試，等待 100s… (${message.slice(0, 120)})`);
            this._callbacks.postToWebview({ type: 'agentStepProgress', text: `⚠️ 模型 tool-call JSON 格式錯誤，100s 後重試 (${_jsonToolErrRetries}/5)…` });
            await new Promise(r => setTimeout(r, 100_000));
            if (this._agentCancel) break;
            if (isOllama || isOpenAICompat) {
              this._callbacks.postToWebview({ type: 'streamStart', thinking: true });
            }
            // continue loop — step 不遞增，不 throw
            continue;
          } else if (/no user query found/i.test(message)) {
            // Qwen3/Llama4 Jinja template requires a user message; inject one and retry
            this._callbacks.log(`[Agent] Jinja 模板缺少 user 訊息，注入繼續指令重試`);
            this._callbacks.postToWebview({ type: 'agentStepProgress', text: '⚠️ 模型要求 user 訊息，注入繼續指令重試…' });
            const lastUser = [...this._agentMessages].reverse().find(m => m.role === 'user');
            const task = typeof lastUser?.content === 'string' ? lastUser.content.slice(0, 200) : '';
            this._agentMessages.push({ role: 'user', content: `請根據工具結果繼續執行任務：${task || '根據上下文繼續'}` });
            if (isOllama || isOpenAICompat) {
              this._callbacks.postToWebview({ type: 'streamStart', thinking: true });
            }
            response = model.startsWith('copilot::')
              ? await this._services.copilotChatCallWithCts(model.slice('copilot::'.length), this._agentMessages, this._services.agentTools)
              : isOpenAICompat
                ? await this._services.openaiCompatChatCallStream(baseUrl, openAiModel, this._agentMessages, this._services.agentTools, onTextChunk, onStats, onThinkChunk)
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

            const _toolStartTs = Date.now();
            let _stallTimerId: ReturnType<typeof setTimeout> | undefined;
            if (AgentExecutor.STALL_MONITORED_TOOLS.has(fn.name)) {
              _stallTimerId = setTimeout(() => {
                const sec = Math.round((Date.now() - _toolStartTs) / 1000);
                this._callbacks.postToWebview({ type: 'agentStepProgress', text: `⏳ ${fn.name} 執行中 (${sec}s)…` });
              }, AgentExecutor.TOOL_STALL_MS);
            }
            let result: string;
            let isError = false;
            try {
              result = await this._callbacks.executeTool(fn.name, args, this._abortController.signal);
            } catch (error) {
              result = '錯誤：' + (error instanceof Error ? error.message : String(error));
              isError = true;
            } finally {
              if (_stallTimerId !== undefined) { clearTimeout(_stallTimerId); _stallTimerId = undefined; }
            }
            const _toolElapsedMs = Date.now() - _toolStartTs;

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
            // 工具停頓督促：完成後耗時超過門檻，注入催促訊息防止 agent 停滯
            if (AgentExecutor.STALL_MONITORED_TOOLS.has(fn.name) && _toolElapsedMs > AgentExecutor.TOOL_STALL_MS && !isError) {
              const stallSec = Math.round(_toolElapsedMs / 1000);
              this._callbacks.log(`[StallMonitor] ${fn.name} 耗時 ${stallSec}s，注入催促`);
              this._agentMessages.push({
                role: 'user',
                content: `上一個工具 ${fn.name} 花了 ${stallSec} 秒才完成。結果已就緒，請立即繼續執行任務，禁止重複呼叫相同工具讀取已取得的資料。`,
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
          // Qwen3/Llama4 Jinja templates require a user message; inject one if last is 'tool'
          if (this._agentMessages[this._agentMessages.length - 1]?.role === 'tool') {
            const _lastUser = [...this._agentMessages].reverse().find(m => m.role === 'user');
            const _task = typeof _lastUser?.content === 'string' ? _lastUser.content.slice(0, 200) : '';
            this._agentMessages.push({ role: 'user', content: `工具已完成，請繼續執行任務：${_task || '根據上下文繼續'}` });
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
            ? '你剛才的回答像是在 Ask（問答）模式：給使用者建議、列出步驟，或說「你可以執行…」。這是錯誤的。'
              + '\n\n你現在在 **Agent 模式**，必須自己呼叫工具執行任務，不得指示使用者去操作。'
              + '\n\n**可直接呼叫的工具（無需任何額外設定）：**\n'
              + '- run_command(command) — 執行任意 shell/PowerShell 指令\n'
              + '- read_file(path) — 讀取任意檔案\n'
              + '- list_dir(path) — 列出目錄\n'
              + '- search_workspace(query) — 搜尋工作區\n'
              + '- run_python(code) — 執行 Python\n'
              + '\n**禁止事項：** 禁止說「我的權限」「請切換至 Agent 模式」「Read-only 模式」「你需要執行…」「建議執行…」「以下步驟…」等語句。'
              + '\n\n請立即呼叫工具完成使用者的任務。'
            : '再次提醒：你是 AmiClaw Agent，直接呼叫工具即可，不得再給使用者「建議步驟」或「說明如何操作」。立即執行。';
          this._agentMessages.push({ role: 'user', content: toolReminder });
          continue;
        }

        // ── 選項確認偵測：模型知道怎麼做但在等授權，自動選最佳選項繼續 ──
        if (isChoiceConfirmation(text) && step < 5) {
          this._callbacks.log(`AgentExecutor: 偵測到選項確認（step=${step}），自動授權繼續`);
          this._agentMessages.pop();
          this._agentMessages.push({ role: 'user', content: '已授權。請自行選擇你認為最合適的選項，立即開始執行，不需再次詢問確認。' });
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

        if (isOllama || isOpenAICompat) {
          // chunks already streamed; just close the stream bubble
          this._callbacks.postToWebview({ type: 'streamEnd' });
        } else {
          // Copilot: no streaming, post full message
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
          HeartbeatService.getInstance().setAgentInfo({
            shadowRunning: true,
            lastActivity: `影子督促第${this._shadowInterventions + 1}次審查中`,
          });
          // null = 超時或失敗，等 100s 重試，最多 3 次
          let verdict = await this._runShadowSupervisor(expandedPrompt, finalText, shadowModel, shadowBaseUrl, shadowIsOpenAICompat, _pendingTodos);
          for (let _shadowRetry = 1; verdict === null && _shadowRetry < 3; _shadowRetry++) {
            this._callbacks.log(`[ShadowSupervisor] 第 ${_shadowRetry} 次重試，等待 100s…`);
            this._callbacks.postToWebview({ type: 'agentStepProgress', text: `🕵️ 影子督促無回應，100s 後重試 (${_shadowRetry}/3)…` });
            await new Promise(r => setTimeout(r, 100000));
            if (this._agentCancel) break;
            verdict = await this._runShadowSupervisor(expandedPrompt, finalText, shadowModel, shadowBaseUrl, shadowIsOpenAICompat, _pendingTodos);
          }
          HeartbeatService.getInstance().setAgentInfo({ shadowRunning: false });
          if (verdict && !verdict.complete) {
            this._shadowInterventions++;
            this._callbacks.log(`[ShadowSupervisor] 第 ${this._shadowInterventions} 次督促 — 缺口：${verdict.missing}`);
            // 改用永久可見的 agentStep，避免用戶錯過督促訊息
            this._callbacks.postToWebview({
              type: 'agentStep',
              icon: '🔍',
              title: `影子督促 ${this._shadowInterventions}/${AgentExecutor.SHADOW_MAX}：${(verdict.missing || '分析未完整').slice(0, 60)}`,
              fullPath: '',
              isShadow: true,
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
        // Hard guard: never stop while manage_todo items are still uncompleted
        if (_pendingTodos.length > 0 && !this._agentCancel) {
          const undoneTasks = _pendingTodos.map(t => `  #${t.id}: ${t.text}`).join('\n');
          this._callbacks.postToWebview({
            type: 'agentStepProgress',
            text: `⚠️ 尚有 ${_pendingTodos.length} 個任務清單項目未完成，強制繼續…`,
          });
          this._agentMessages.push({
            role: 'user',
            content: `【強制繼續】以下任務清單項目尚未標記完成，你必須逐一呼叫 manage_todo(action="done", id=N) 結案，不得停止：\n${undoneTasks}\n\n禁止給純文字說明，立即呼叫工具。`,
          });
          continue;
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
      // 背景 LLM 記憶更新（fire-and-forget，不阻塞使用者下一次輸入）
      if (this._sessionToolCallCount >= AgentExecutor.LLM_MEMORY_MIN_CALLS && !this._agentCancel) {
        this._enqueueNotes(() => this._updateSessionMemoryWithLLM(model, baseUrl));
      }
      this._agentRunning = false;
      this._agentCancel = false;
      this._callbacks.setWaAgentMode(false);
      // Auto-send concise result back to WA without relying on model to call whatsapp_send
      if (waTriggered && _waLastFinalText) {
        this._callbacks.notifyWaOwner?.(AgentExecutor._condenseForWa(_waLastFinalText));
      }
      this._callbacks.postToWebview({ type: 'agentStatus', running: false });
      HeartbeatService.getInstance().setAgentInfo({ running: false, shadowRunning: false, lastActivity: '已完成' });
    }
  }

  /**
   * 移植自 claude-code SessionMemory：使用 LLM 從近期訊息中抽取結構化記憶。
   * 透過 _enqueueNotes 以 fire-and-forget 方式執行，不阻塞主流程。
   */
  private async _updateSessionMemoryWithLLM(model: string, baseUrl: string): Promise<void> {
    if (this._sessionToolCallCount < AgentExecutor.LLM_MEMORY_MIN_CALLS) { return; }

    // 集近期訊息，跳過 system，截斷大型 tool 結果
    const recentMsgs = this._agentMessages
      .filter(m => m.role !== 'system')
      .slice(-28)
      .map(m => {
        const c = typeof m.content === 'string' ? m.content : '';
        const label = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'AI' : 'Tool';
        return `[${label}] ${c.slice(0, m.role === 'tool' ? 280 : 420)}`;
      });
    if (recentMsgs.length < 2) { return; }

    const msgContext = recentMsgs.join('\n\n').slice(0, 5500);
    const prevSummary = this._sessionNotesCache
      ? `\n\n## 既有筆記（請更新而非重複）\n${this._sessionNotesCache.slice(0, 800)}`
      : '';

    const prompt = [
      '你是對話摘要助手。從以下對話中提取關鍵資訊，輸出精簡的繁體中文 markdown 筆記。直接輸出筆記，不要任何前言。',
      '',
      '格式（空白節可省略）：',
      '## 任務目標與進展',
      '## 重要技術決策',
      '## 關鍵檔案',
      '## 問題與解法',
      '## 下一步',
      prevSummary,
      '',
      '---對話---',
      msgContext,
    ].join('\n');

    let raw = '';
    try {
      if (model.startsWith('copilot::')) {
        const res = await this._services.copilotChatCallWithCts(
          model.slice('copilot::'.length), [{ role: 'user', content: prompt }], []
        );
        raw = res.content ?? '';
      } else if (model.startsWith('openai::')) {
        const res = await this._services.openaiCompatChatCallStream(
          baseUrl, model.slice('openai::'.length), [{ role: 'user', content: prompt }], []
        );
        raw = res.content ?? '';
      } else {
        const res = await this._services.ollamaGenerate(baseUrl, model, prompt);
        raw = res.response ?? '';
      }
    } catch { return; }

    if (!raw.trim()) { return; }

    const ts = new Date().toISOString().replace('T', ' ').slice(0, 16);
    const enriched = `# Session Memory\n_🤖 LLM 背景摘要 · ${ts} · ${this._sessionToolCallCount} 次工具呼叫_\n\n${raw.trim()}`;
    this._sessionNotesCache = enriched;
    await this._callbacks.onSessionNotesUpdate(enriched);
  }

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
  /** 工具停頓門檻（ms）：思考/讀取/搜索超過此時間視為停頓，顯示進度並於完成後催促。 */
  private static readonly TOOL_STALL_MS = 30_000;
  private static readonly STALL_MONITORED_TOOLS = new Set([
    'read_file', 'read_file_smart', 'read_files', 'read_workspace',
    'search_workspace', 'grep_file', 'search_regex',
  ]);

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
    const defaultTriggers = ['分析', '審查', 'review', 'analyze', '讀取', '檢查', 'debug', 'refactor', '重構', '架構', '程式', 'code', '找', '問題', '修正', '實作'];
    const TASK_TRIGGERS: string[] = vscode.workspace.getConfiguration('amiAiClaw').get<string[]>('shadowTriggerKeywords', defaultTriggers);
    const CODE_SIGNALS = ['```', '函式', '函數', 'function', 'class ', 'interface ', '.ts', '.js', '.py', 'import ', '模組', 'module', '路徑', '檔案', '行號'];
    return TASK_TRIGGERS.some(k => task.toLowerCase().includes(k.toLowerCase()))
        || CODE_SIGNALS.some(k => response.includes(k));
  }

  /** Condense text for WhatsApp: strip code blocks, keep head+tail paragraphs, max 3000 chars. */
  private static _condenseForWa(text: string, maxLen = 3000): string {
    // Strip markdown code blocks — unreadable in WhatsApp
    let t = text.replace(/```[\s\S]*?```/g, '[程式碼區塊]');
    // Strip markdown headings and excess blank lines
    t = t.replace(/^#{1,6}\s+/gm, '').replace(/\n{3,}/g, '\n\n').trim();

    if (t.length <= maxLen) return t;

    // Preserve first 2/3 (context + answer) and last 1/3 (conclusion)
    const headLen = Math.floor(maxLen * 2 / 3);
    const tailLen = maxLen - headLen;
    const head = t.slice(0, headLen);
    const tail = t.slice(-tailLen);
    // Snap to paragraph boundary so sentences aren't cut mid-way
    const snapHead = head.lastIndexOf('\n\n') > headLen / 2 ? head.slice(0, head.lastIndexOf('\n\n')) : head;
    return `${snapHead}\n\n…[內容已精簡]\n\n${tail}`;
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
    // OpenAI 相容模型：用輕量 heuristic，不再呼叫 LLM（避免 context overflow + 超時）
    if (isOpenAICompat) {
      const hasPending = pendingTodos.length > 0;
      const tooShort = finalAnswer.trim().length < 120;
      const truncated = /\.{3,}$|（已截斷|…$/.test(finalAnswer.trim());
      if (!hasPending && !tooShort && !truncated) {
        this._callbacks.log('[ShadowSupervisor] heuristic: complete');
        return { complete: true, missing: '', nextInstruction: '' };
      }
      const missing = hasPending ? '待辦事項尚未完成' : tooShort ? '回覆過短' : '回覆被截斷';
      this._callbacks.log(`[ShadowSupervisor] heuristic: incomplete (${missing})`);
      return { complete: false, missing, nextInstruction: '請繼續完成剩餘工作。' };
    }

    const TIMEOUT_MS = 300000;
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

    // 300s timeout 防止 Ollama/Copilot 長時間阻塞；Promise.race 後必須 clearTimeout 避免殭屍 log
    let _timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<null>(resolve => {
      _timeoutHandle = setTimeout(() => {
        this._callbacks.log('[ShadowSupervisor] 超時 (>300s)，降級單人格');
        resolve(null);
      }, TIMEOUT_MS);
    });
    const result = await Promise.race([doCall(), timeoutPromise]);
    clearTimeout(_timeoutHandle);
    return result;
  }

  public async startAuto(initialPrompt: string, modelOverride?: string): Promise<void> {
    if (this._autoRunning) {
      vscode.window.showInformationMessage('自主連續模式已在執行中');
      return;
    }

    this._autoRunning = true;
    this._autoCancel = false;
    this._callbacks.postToWebview({ type: 'autoStatus', running: true, tick: 0 });

    const MAX_TICKS = 12;
    const TICK_INTERVAL_MS = 2500;
    let completedNormally = false;

    try {
      // 第一輪：執行初始任務（完整初始化 system prompt）
      await this.handleAgent(initialPrompt, modelOverride, true, false);
      if (this._autoCancel) return;

      for (let tick = 1; tick <= MAX_TICKS && !this._autoCancel; tick++) {
        // re-lock UI（handleAgent finally 會短暫送出 agentStatus:false）
        this._callbacks.postToWebview({ type: 'autoStatus', running: true, tick });

        if (this._checkProactiveDone()) { completedNormally = true; break; }

        await new Promise<void>(r => setTimeout(r, TICK_INTERVAL_MS));
        if (this._autoCancel) break;

        this._callbacks.postToWebview({ type: 'autoStatus', running: true, tick });
        const tickPrompt = `[⚙️ 自主 Tick ${tick}/${MAX_TICKS}] 請評估目前狀態：若任務尚未完成，立即呼叫工具繼續執行；若已完成，直接說明完成狀況即可。`;
        await this.handleAgent(tickPrompt, modelOverride, false, false);
      }

      if (!this._autoCancel && !completedNormally) {
        completedNormally = this._checkProactiveDone();
      }
    } finally {
      const wasCancelled = this._autoCancel;
      this._autoRunning = false;
      this._autoCancel = false;
      this._callbacks.postToWebview({ type: 'autoStatus', running: false });
      if (!wasCancelled) {
        vscode.window.showInformationMessage(completedNormally ? '✅ 自主模式：任務完成' : '⏹️ 自主模式結束（已達最大輪次）');
      }
    }
  }

  /** 檢查最後一則有內容的 assistant 訊息是否包含完成訊號 */
  private _checkProactiveDone(): boolean {
    for (let i = this._agentMessages.length - 1; i >= 0; i--) {
      const m = this._agentMessages[i];
      if (m.role === 'user') break; // 上一個使用者訊息之後的回應才算
      if (m.role === 'assistant' && m.content && !m.tool_calls?.length) {
        const txt = typeof m.content === 'string' ? m.content : '';
        return /任務.{0,4}完成|DONE\b|all done|finished\b|已完成|完成了|大功告成/i.test(txt);
      }
    }
    return false;
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

    // 觸發摘要的門檻：60% 不夠，需預留 tool defs (~7K tokens) + 程式碼密度差異 (3 vs 4 chars/token)
    const threshold = this._modelContextLength > 0
      ? Math.floor(this._modelContextLength * 0.45)
      : cfgThreshold;

    const systemMessage = this._agentMessages[0];
    const remainingMessages = this._agentMessages.slice(1);
    const totalTokens = this._services.estimateTokens((systemMessage?.content ?? '') + remainingMessages.map((message) => message.content ?? '').join(''));

    if (totalTokens < threshold) { return; }

    // Helper: post structured compact progress (replaces scattered agentStep calls)
    const postCompact = (phase: string, extra: Record<string, unknown> = {}) =>
      this._callbacks.postToWebview({ type: 'compactUpdate', phase, tokensBefore: totalTokens, threshold, ...extra });

    const stages: string[] = [];

    // ① Microcompact（零 LLM）
    const freed = this._microcompact(5);
    if (freed > 0) {
      const newTokens = this._services.estimateTokens((systemMessage?.content ?? '') + this._agentMessages.slice(1).map(m => m.content ?? '').join(''));
      stages.push('microcompact');
      postCompact('microcompact', { freed, tokensNow: newTokens });
      if (newTokens < threshold) {
        postCompact('done', { tokensAfter: newTokens, stages, messagesBefore: remainingMessages.length, messagesAfter: this._agentMessages.length - 1 });
        return;
      }
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
        stages.push('l2l3');
        postCompact('l2l3', { freed: l23Saved, tokensNow: nowTokens });
        if (nowTokens < threshold) {
          postCompact('done', { tokensAfter: nowTokens, stages, messagesBefore: remainingMessages.length, messagesAfter: this._agentMessages.length - 1 });
          return;
        }
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
      // If still over threshold with ≤2 messages, truncate large tool results
      if (this._services.estimateTokens((systemMessage?.content ?? '') + trimmed.map(m => m.content ?? '').join('')) >= threshold) {
        for (const msg of trimmed) {
          if (msg.role === 'tool' && (msg.content?.length ?? 0) > 4000) {
            msg.content = msg.content!.slice(0, 4000) + '\n…（截斷）';
          }
        }
      }
      // 部分模型（Qwen3、Llama4 等）的 Jinja 模板要求至少一則 user 訊息
      if (!trimmed.some(m => m.role === 'user')) {
        trimmed = [{ role: 'user', content: '[上下文已壓縮，請繼續執行任務]' }, ...trimmed];
      }
      this._agentMessages = [systemMessage, ...trimmed];
      this._agentMessagesBySession[this._callbacks.getActiveSessionId()] = this._agentMessages;
    };

    if (!enabled) { dropFallback(remainingMessages);
      postCompact('done', { tokensAfter: this._services.estimateTokens(this._agentMessages.map(m => m.content ?? '').join('')), stages: ['drop'], messagesBefore: remainingMessages.length, messagesAfter: this._agentMessages.length - 1 });
      return;
    }

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
    if (toSummarize.length < 2) {
      // Too few old messages to summarize; truncate oversized tool results to free context
      for (const msg of this._agentMessages) {
        if (msg.role === 'tool' && msg.content !== MC_CLEARED && (msg.content?.length ?? 0) > 8000) {
          msg.content = msg.content!.slice(0, 8000) + '\n…（工具結果已截斷以釋放 context）';
        }
      }
      const afterTokens = this._services.estimateTokens(
        (systemMessage?.content ?? '') + this._agentMessages.slice(1).map(m => m.content ?? '').join('')
      );
      if (afterTokens >= threshold) { dropFallback(this._agentMessages.slice(1)); }
      return;
    }

    this._callbacks.postToWebview({ type: 'compactUpdate', phase: 'llm-running', tokensBefore: totalTokens, threshold, messagesBefore: toSummarize.length });

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
      postCompact('done', { tokensAfter: this._services.estimateTokens(this._agentMessages.map(m => m.content ?? '').join('')), stages: [...stages, 'drop'], messagesBefore: remainingMessages.length, messagesAfter: this._agentMessages.length - 1, error: true });
      return;
    }

    // 加入 carry-over attachments（task focus、read files、work log）
    const carryoverText = this._carryover.buildAttachments();

    // Fix 3: rebase——將摘要非同步進行期間並行 push 的訊息重播到新歷史末尾
    const _rebase = this._agentMessages.slice(snapshotLen);
    // Truncate large tool results in keepTail before reinserting to prevent overflow
    for (const msg of keepTail) {
      if (msg.role === 'tool' && msg.content !== MC_CLEARED && (msg.content?.length ?? 0) > 8000) {
        msg.content = msg.content!.slice(0, 8000) + '\n…（keepTail 工具結果已截斷以釋放 context）';
      }
    }
    this._agentMessages = [
      systemMessage,
      { role: 'user', content: `[自動摘要 — 先前 ${toSummarize.length} 則對話重點]\n${summary}${carryoverText}` },
      { role: 'assistant', content: '已了解先前對話的進度與重要資訊，繼續執行任務。' },
      ...keepTail,
      ..._rebase,
    ];
    this._agentMessagesBySession[this._callbacks.getActiveSessionId()] = this._agentMessages;
    const newTokens = this._services.estimateTokens(this._agentMessages.map(m => m.content ?? '').join(''));
    postCompact('done', {
      tokensAfter: newTokens,
      stages: [...stages, 'llm'],
      messagesBefore: toSummarize.length,
      messagesAfter: 1,
      summaryPreview: summary.slice(0, 300),
    });
  }
}
