import * as path from 'path';
import * as vscode from 'vscode';
import { URL } from 'url';
import { TEAM_COLORS, TEAM_COLORS_MANAGER, isOllamaModel, getWorkerDisplay, type TeamHistoryEntry, type TeamManagerChatMessage } from './TeamShared';
import { scanWorkspaceForTeam, buildBatchedInitHistory, buildCopilotBatchCtx } from './TeamWorkspaceScanner';
import { teamContextTimestamp, appendTeamContext } from './TeamContextStore';
import { teamCallModel, type TeamCallModelDeps } from './TeamCallModel';

interface TeamToolDefinition {
  function: { name: string };
}

export interface TeamManagerCallbacks {
  getWebview: () => vscode.Webview;
  getChatHistory: () => TeamManagerChatMessage[];
  setChatHistory: (history: TeamManagerChatMessage[]) => void;
  getChatHistories: () => Record<string, TeamManagerChatMessage[]>;
  getActiveSessionId: () => string;
  getAgentMessages: () => TeamManagerChatMessage[];
  setAgentMessages: (messages: TeamManagerChatMessage[]) => void;
  getAgentMessagesBySession: () => Record<string, TeamManagerChatMessage[]>;
  executeAgent: (prompt: string, model: string, recordToShortTerm?: boolean, waTriggered?: boolean) => Promise<void>;
  executeTool: (name: string, args: Record<string, unknown>) => Promise<string>;
  getSystemContent: (includeAtlassian?: boolean) => string;
  trackUsage: (model: string, tokens: number, multiplier?: string, toolCall?: boolean) => void;
  trackLatency: (model: string, ms: number) => void;
  getAgentTools: () => TeamToolDefinition[];
}

export interface TeamManagerServices {
  getOllamaUrls: (cfg: vscode.WorkspaceConfiguration) => string[];
  decodeOllamaModel: (modelId: string, fallbackUrls: string[]) => { url: string; model: string };
  ollamaGenerateStreamWithRetry: (
    baseUrl: string,
    model: string,
    prompt: string,
    onResponseChunk: (chunk: string) => void,
    onThinkChunk?: (chunk: string) => void,
    onRetry?: (attempt: number, waitSec: number, err: string) => void
  ) => Promise<string>;
  ollamaGenerateStream: (
    baseUrl: string,
    model: string,
    prompt: string,
    onResponseChunk: (chunk: string) => void,
    onThinkChunk?: (chunk: string) => void
  ) => Promise<string>;
  ollamaChatStream: (
    baseUrl: string,
    model: string,
    messages: TeamManagerChatMessage[],
    onResponseChunk: (chunk: string) => void,
    onThinkChunk?: (chunk: string) => void,
    onStats?: (tokens: number, tps: number) => void
  ) => Promise<string>;
  ollamaChatCallStream: (
    baseUrl: string,
    model: string,
    messages: TeamManagerChatMessage[],
    tools: unknown[],
    onThinkChunk?: (chunk: string) => void,
    onTextChunk?: (chunk: string) => void,
    onStats?: (tokens: number, tps: number) => void
  ) => Promise<TeamManagerChatMessage>;
  copilotStreamText: (
    modelId: string,
    messages: vscode.LanguageModelChatMessage[],
    onChunk: (chunk: string) => void,
    token: vscode.CancellationToken
  ) => Promise<string>;
  estimateTokens: (text: string) => number;
  getCopilotMultiplierById: (id: string) => string;
}

export class TeamManager {
  private _teamCancel = false;

  constructor(
    private readonly _callbacks: TeamManagerCallbacks,
    private readonly _services: TeamManagerServices
  ) {}

  public cancel(): void {
    this._teamCancel = true;
  }

  private get _panel(): { webview: vscode.Webview } {
    return { webview: this._callbacks.getWebview() };
  }

  private get _chatHistory(): TeamManagerChatMessage[] {
    return this._callbacks.getChatHistory();
  }

  private set _chatHistory(history: TeamManagerChatMessage[]) {
    this._callbacks.setChatHistory(history);
  }

  private get _chatHistories(): Record<string, TeamManagerChatMessage[]> {
    return this._callbacks.getChatHistories();
  }

  private get _activeSessionId(): string {
    return this._callbacks.getActiveSessionId();
  }

  private get _agentMessages(): TeamManagerChatMessage[] {
    return this._callbacks.getAgentMessages();
  }

  private set _agentMessages(messages: TeamManagerChatMessage[]) {
    this._callbacks.setAgentMessages(messages);
  }

  private get _agentMessagesBySession(): Record<string, TeamManagerChatMessage[]> {
    return this._callbacks.getAgentMessagesBySession();
  }

  public async handleTeamSend(prompt: string, selectedModels?: string[], rounds?: string | number, teamExecMode?: string, maxParallel?: number, roles?: string[]): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('amiAiClaw');
    const configuredModel = cfg.get<string>('model') ?? '';
    const primaryOllamaModel = (selectedModels && selectedModels.length > 0)
      ? selectedModels.find(m => isOllamaModel(m)) ?? selectedModels[0]
      : configuredModel;
    const allModels = (selectedModels && selectedModels.length > 0) ? selectedModels.slice(0, 5) : (primaryOllamaModel ? [primaryOllamaModel] : []);

    this._teamCancel = false;
    const roundsSelected = rounds ?? '20';
    const roundsNum = String(roundsSelected) === 'infinite' ? Infinity : Number(roundsSelected) || 20;
    this._chatHistory.push({ role: 'user', content: prompt });
    this._chatHistories[this._activeSessionId] = this._chatHistory;
    this._panel.webview.postMessage({ type: 'historyCount', count: this._chatHistory.length, sessionId: this._activeSessionId });

    if (teamExecMode === 'discussion') {
      return this._handleTeamDiscussion(prompt, allModels, roundsNum, roles);
    }
    if (teamExecMode === 'task' || teamExecMode === 'parallel') {
      return this._handleTeamAgent(prompt, allModels, roles);
    }
    if (teamExecMode === 'agent' || teamExecMode === 'manager') {
      return this._handleTeamManager(prompt, allModels, roundsNum, roles);
    }
    if (teamExecMode === 'compare') {
      return this._handleTeamCompare(prompt, allModels);
    }
    if (teamExecMode === 'clone') {
      return this._handleTeamClone(prompt, allModels[0] ?? '');
    }
    return this._handleTeamDefault(prompt, allModels, primaryOllamaModel, roundsNum, maxParallel, roles);
  }

  /**
   * Default 模式（無 teamExecMode）：orchestrator 規劃 → 平行 worker → 綜合 → agent 收尾。
   * 從 handleTeamSend 本體抽出（ClaudeToDo.md §19.5 異味 1）。
   */
  private async _handleTeamDefault(prompt: string, allModels: string[], primaryOllamaModel: string, roundsNum: number, maxParallel?: number, roles?: string[]): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('amiAiClaw');
    const urls = this._services.getOllamaUrls(cfg);
    const defaultBaseUrl = urls[0];
    const getWorkerUrl = (m: string) => isOllamaModel(m) ? this._services.decodeOllamaModel(m, urls).url : defaultBaseUrl;
    const getWorkerModel = (m: string) => isOllamaModel(m) ? this._services.decodeOllamaModel(m, urls).model : m;
    const _tsRolesCfg = cfg.get<Array<{key:string;label:string;emoji:string}>>('teamRoles', []);
    const _tsRolePrefix = (idx: number) => { const k = roles?.[idx]; const r = k ? _tsRolesCfg.find(c => c.key === k) : undefined; return r ? `${r.emoji} ${r.label} ` : ''; };
    const COLORS = TEAM_COLORS;

    const systemContent = this._callbacks.getSystemContent();
    const wsFolders = vscode.workspace.workspaceFolders ?? [];
    const wsRoot = wsFolders.map(f => f.uri.fsPath).join(', ') || process.cwd();
    const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath ?? '';
    const openFiles = vscode.workspace.textDocuments.filter(d => !d.isUntitled && d.uri.scheme === 'file').map(d => d.uri.fsPath);
    const wsContext = `【工作區】${wsRoot}${activeFile ? '\n【作用中檔案】' + activeFile : ''}${openFiles.length ? '\n【開啟的檔案】\n' + openFiles.join('\n') : ''}`;
    const normalizeForAgent = (m: string) => {
      if (m.startsWith('copilot/')) return 'copilot::' + m.slice('copilot/'.length);
      if (m.startsWith('openai::')) return m;
      if (m.includes('||') && !m.startsWith('openai::')) return getWorkerModel(m);
      return m;
    };
    const getDisplay = (m: string) => {
      if (m.startsWith('copilot/')) return '🐙 ' + m.slice('copilot/'.length);
      if (m.startsWith('copilot::')) return '🐙 ' + m.slice('copilot::'.length);
      if (m.includes('||')) { const { url, model } = this._services.decodeOllamaModel(m, urls); try { const u = new URL(url); return `[${u.hostname}:${u.port||'11434'}] ${model}`; } catch { return model; } }
      return m;
    };

    const copilotIdx = allModels.findIndex(m => m.startsWith('copilot/') || m.startsWith('copilot::'));
    const hasOrchestrator = copilotIdx >= 0;
    const orchestratorFamily = hasOrchestrator ? (allModels[copilotIdx].startsWith('copilot::') ? allModels[copilotIdx].slice('copilot::'.length) : allModels[copilotIdx].slice('copilot/'.length)) : '';
    const workerModels = hasOrchestrator
      ? [...allModels.slice(0, copilotIdx), ...allModels.slice(copilotIdx + 1)]
      : allModels;
    const effectiveWorkers = (hasOrchestrator && workerModels.length === 0) ? [primaryOllamaModel] : workerModels;

    const results: { model: string; response: string }[] = [];

    if (hasOrchestrator) {
      const orchestratorDisplay = '🐙 ' + orchestratorFamily;

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
            this._panel.webview.postMessage({ type: 'teamResponseChunk', id, chunk: `🔄 第 ${taskItem._retries} 次重試，改用 ${displayName}...\n` });
          }
          try {
            const response = await this.runWorkerDiscussion(getWorkerModel(model), copilotReviewFn, getWorkerUrl(model), taskItem.task, id, color, roundsNum);
            taskItem._done = true;
            results.push({ model: displayName, response });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            this._panel.webview.postMessage({ type: 'teamResponseChunk', id, chunk: `[錯誤] ${msg}` });
            taskItem._retries++;
            if (taskItem._retries < 2) {
              taskItem._taken = false;
              this._panel.webview.postMessage({ type: 'teamOrchestratorChunk', chunk: `\n⚠️ 任務#${taskItem.index} 失敗，排入第 ${taskItem._retries} 次重試...\n` });
            } else {
              taskItem._done = true;
              results.push({ model: displayName, response: `錯誤: ${msg}` });
              this._panel.webview.postMessage({ type: 'teamOrchestratorChunk', chunk: `\n❌ 任務#${taskItem.index} 已達重試上限，跳過。\n` });
            }
          }
          this._panel.webview.postMessage({ type: 'teamMemberEnd', id });
          if (taskItem._done) {
            this._panel.webview.postMessage({ type: 'teamTodoDone', idx: taskItem.index });
          }
        }
      }));

      if (this._teamCancel) { this._panel.webview.postMessage({ type: 'teamEnd' }); return; }

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
        if (synthResult && synthResult.trim()) {
          this._chatHistory.push({ role: 'assistant', content: synthResult });
          this._chatHistories[this._activeSessionId] = this._chatHistory;
          this._panel.webview.postMessage({ type: 'historyCount', count: this._chatHistory.length, sessionId: this._activeSessionId });
        }
      }

      const agentModel = normalizeForAgent(effectiveWorkers.find(m => !m.startsWith('copilot/') && !m.startsWith('copilot::')) ?? primaryOllamaModel ?? effectiveWorkers[0] ?? '');
      const willRunAgent = !this._teamCancel && synthResult.trim().length > 0 && !!agentModel;
      this._panel.webview.postMessage({ type: 'teamEnd', agentFollows: willRunAgent });
      if (willRunAgent) {
        this._panel.webview.postMessage({ type: 'teamAgentStart', model: agentModel });
        this._agentMessages = [];
        this._agentMessagesBySession[this._activeSessionId] = this._agentMessages;
        await this._callbacks.executeAgent(`根據以下團隊討論結論，立即執行必要操作來完成使用者的任務。\n\n${wsContext}\n\n【原始任務】\n${prompt}\n\n【團隊綜合結論】\n${synthResult}\n\n【強制規則】\n- 訊息中出現 Jira Key（如 UOEM2-3476）→ 立即呼叫 jira_fetch，禁止說「我將查詢」。\n- 需要理解工作區代碼 → 立即呼叫 read_file / search_workspace，禁止假設內容。\n- 看到任務就執行工具，不得宣告意圖後停止。\n\n請逐步執行。`, agentModel, false);
      }

    } else {
      const thinkModel = TeamManager.pickThinkingModel(effectiveWorkers);

      const postStatus = (msg: string) => { this._panel.webview.postMessage({ type: 'teamOrchestratorChunk', chunk: msg }); };
      const ollamaCall = (model: string, prompt2: string,
        onResp: (c: string) => void, onThink?: (c: string) => void) => {
        const { url: mUrl, model: mName } = this._services.decodeOllamaModel(model, urls);
        return this._services.ollamaGenerateStreamWithRetry(
          mUrl, mName, prompt2, onResp, onThink,
          (attempt, waitSec, err) => {
            postStatus(`\n⚠️ [${mName}] 連線失敗 (${err})，第 ${attempt} 次重試，等待 ${waitSec}s...\n`);
          }
        );
      };

      if (effectiveWorkers.length === 1) {
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
        this._panel.webview.postMessage({ type: 'teamOrchestratorStart', model: '🐙 ' + thinkModel });
        const numOllamaTasks = Math.max(effectiveWorkers.length * 2, 4);
        const tAvailWorkerNames = effectiveWorkers.map(m => getDisplay(m)).join(', ');
        const tPlanPrompt = `你是 AI 工作協調員。請分析下面的任務，拆分成 ${numOllamaTasks} 個細緻子任務。\n可用助手（依名稱指派）：${tAvailWorkerNames}\n\n${wsContext}\n\n【任務】\n${prompt}\n\n只回傳 JSON（不含說明文字），格式範例：\n{"assignments":[\n  {"index":0,"task":"子任務描述","preferred_model":"助手名稱片段(可省略)","deps":[]},\n  {"index":1,"task":"子任務描述","deps":[0]}\n]}\ndeps: 依賴的前置任務索引陣列（空=立即可執行）。preferred_model: 適合的助手名稱片段（可省略）。`;
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

        const ollamaReviewFn = async (p: string, onChunk: (c: string) => void) =>
          ollamaCall(thinkModel, p, onChunk);

        const getNextPending = () => tTasks.find(t =>
          t.status === 'pending' &&
          t.deps.every(dep => tTasks.find(d => d.index === dep)?.status === 'done')
        ) ?? null;
        const workerCycle = [...effectiveWorkers];
        let workerIdx = 0;

        while (!this._teamCancel) {
          const activeItem = getNextPending();
          if (!activeItem) break;

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
          this._panel.webview.postMessage({ type: 'teamTodoStart', idx: activeItem.index, worker: _tsRolePrefix(workerIdx - 1) + getDisplay(model) });
          this._panel.webview.postMessage({ type: 'teamMemberStart', id, model: _tsRolePrefix(workerIdx - 1) + getDisplay(model), color, task: activeItem.task });
          if (activeItem.retries > 0) {
            this._panel.webview.postMessage({ type: 'teamResponseChunk', id, chunk: `🔄 第 ${activeItem.retries} 次重試，改用 ${getDisplay(model)}...\n` });
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
            this._panel.webview.postMessage({ type: 'teamResponseChunk', id, chunk: `[錯誤] ${msg}` });
            activeItem.retries++;
            if (activeItem.retries < 2) {
              activeItem.status = 'pending';
              this._panel.webview.postMessage({ type: 'teamOrchestratorChunk', chunk: `\n⚠️ 任務#${activeItem.index} 失敗，排入第 ${activeItem.retries} 次重試...\n` });
            } else {
              activeItem.status = 'failed';
              results.push({ model, response: `錯誤: ${msg}` });
              this._panel.webview.postMessage({ type: 'teamOrchestratorChunk', chunk: `\n❌ 任務#${activeItem.index} 已達重試上限，跳過。\n` });
            }
          }
          this._panel.webview.postMessage({ type: 'teamMemberEnd', id });
          if (activeItem.status === 'done' || activeItem.status === 'failed') {
            this._panel.webview.postMessage({ type: 'teamTodoDone', idx: activeItem.index });
          }
        }

        for (const t of tTasks.filter(t => t.status === 'pending')) {
          t.status = 'failed';
          results.push({ model: thinkModel, response: `[任務#${t.index} 因依賴任務未完成而跳過]` });
          this._panel.webview.postMessage({ type: 'teamTodoDone', idx: t.index });
          this._panel.webview.postMessage({ type: 'teamOrchestratorChunk', chunk: `\n⛔ 任務#${t.index}（${t.task.slice(0, 30)}）因前置任務未完成而跳過。\n` });
        }

        if (this._teamCancel) { this._panel.webview.postMessage({ type: 'teamEnd' }); return; }

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

        const tAgentModel = normalizeForAgent(thinkModel);
        const tWillRunAgent = !this._teamCancel && tSynthResult.trim().length > 0;
        this._panel.webview.postMessage({ type: 'teamEnd', agentFollows: tWillRunAgent });
        if (tWillRunAgent) {
          this._panel.webview.postMessage({ type: 'teamAgentStart', model: tAgentModel });
          this._agentMessages = [];
          this._agentMessagesBySession[this._activeSessionId] = this._agentMessages;
          await this._callbacks.executeAgent(`根據以下團隊討論結論，立即執行必要操作來完成使用者的任務。\n\n${wsContext}\n\n【原始任務】\n${prompt}\n\n【團隊綜合結論】\n${tSynthResult}\n\n【強制規則】\n- 訊息中出現 Jira Key（如 UOEM2-3476）→ 立即呼叫 jira_fetch，禁止說「我將查詢」。\n- 需要理解工作區代碼 → 立即呼叫 read_file / search_workspace，禁止假設內容。\n- 看到任務就執行工具，不得宣告意圖後停止。\n\n請逐步執行。`, tAgentModel, false);
        }
      }
    }
  }

  public static pickThinkingModel(models: string[]): string {
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

  public static buildRoleSystemNote(role: string): string {
    const configured = vscode.workspace.getConfiguration('amiAiClaw').get<Array<{key:string;systemPrompt:string}>>('teamRoles', []);
    const found = configured.find(r => r.key === role);
    if (found?.systemPrompt) return found.systemPrompt;
    switch (role) {
      case 'planner':   return '你的職責是【規劃者】：分析需求、制定解題架構、將任務拆分為有序步驟、確保整體方向正確。';
      case 'developer': return '你的職責是【開發者】：撰寫程式碼、實作功能、提供具體技術解決方案、確保程式邏輯正確。';
      case 'reviewer':  return '你的職責是【評審員】：審查方案與程式碼品質、找出潛在問題與改進空間、以批判視角提高整體品質。';
      case 'tester':    return '你的職責是【測試員】：思考邊界情況、撰寫測試案例、找出可能的錯誤與漏洞、確保功能穩定性。';
      case 'writer':    return '你的職責是【撰寫者】：清晰解釋技術概念、撰寫說明文件、確保溝通明確易懂。';
      default:          return '';
    }
  }

  private async _handleTeamDiscussion(prompt: string, allModels: string[], maxRounds: number, roles?: string[]): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('amiAiClaw');
    const urls = this._services.getOllamaUrls(cfg);
    const COLORS = TEAM_COLORS;
    const getDisplay = (m: string) => getWorkerDisplay(m, urls, (id, u) => this._services.decodeOllamaModel(id, u));

    this._panel.webview.postMessage({ type: 'debateStart',
      labelA: getDisplay(allModels[0]), labelB: getDisplay(allModels[1] ?? allModels[0]),
      labelJ: allModels[2] ? getDisplay(allModels[2]) : null,
      colorA: COLORS[0], colorB: COLORS[1], colorJ: COLORS[2],
      gameType: 'team-discussion',
      speakerLabels: Object.fromEntries(allModels.map((m,i) => [String(i), getDisplay(m)])),
      speakerColors: Object.fromEntries(allModels.map((m,i) => [String(i), COLORS[i % COLORS.length]])) });
    this._panel.webview.postMessage({ type: 'teamSynthChunk', chunk: '🔍 正在掃描工作區原始碼與 teamscontext.md…\n' });
    const _scan = await scanWorkspaceForTeam();
    const _teamsCtxPath = _scan.teamsCtxPath;
    const _teamsCtxContent = _scan.teamsCtxContent;
    this._panel.webview.postMessage({ type: 'teamSynthChunk', chunk: `✅ 掃描完成：找到 ${_scan.allRelPaths.length} 個檔案，分 ${_scan.batches.length} 批讀取 ${_scan.readCount} 個內容（${Math.round(_scan.totalBytes/1024)}KB）\n` });

    const _batchedInitHist: TeamHistoryEntry[] = buildBatchedInitHistory(_scan, '請提出問題。', '已閱讀工作區資訊。請提出問題。');
    _batchedInitHist.push({ role: 'user', content: prompt });
    const _copilotBatchCtx = buildCopilotBatchCtx(_scan);
    const _promptWithCtx = _copilotBatchCtx ? `${_copilotBatchCtx}\n\n---\n\n${prompt}` : prompt;

    const roundsLimit = isFinite(maxRounds) ? maxRounds : 4;
    const summaryLines: string[] = [];

    const histories: Map<string, TeamHistoryEntry[]> = new Map();
    for (const m of allModels) { histories.set(m, [..._batchedInitHist]); }

    for (let round = 0; round < roundsLimit && !this._teamCancel; round++) {
      const roundResponses: { mi: number; display: string; response: string }[] = [];
      for (let mi = 0; mi < allModels.length && !this._teamCancel; mi++) {
        const model = allModels[mi];
        const color = COLORS[mi % COLORS.length];
        const display = getDisplay(model);
        const speakerKey = String(mi);
        const _discRolePrefix = (() => { const k = roles?.[mi]; const r = k ? cfg.get<Array<{key:string;label:string;emoji:string}>>('teamRoles', []).find(c => c.key === k) : undefined; return r ? `${r.emoji} ${r.label} ` : ''; })();
        this._panel.webview.postMessage({ type: 'debateTurnStart', speaker: speakerKey, round, label: _discRolePrefix + display, color });

        const hist = histories.get(model)!;
        let response = '';
        try {
          if (model.startsWith('copilot::')) {
            const family = model.slice('copilot::'.length);
            response = await this.copilotStream(family, _promptWithCtx,
              (c) => { if (!this._teamCancel) this._panel.webview.postMessage({ type: 'debateChunk', speaker: speakerKey, chunk: c }); });
          } else {
            const { url, model: mName } = this._services.decodeOllamaModel(model, urls);
            const _roleNote = roles?.[mi] ? TeamManager.buildRoleSystemNote(roles[mi]) + ' ' : '';
            const messages: TeamManagerChatMessage[] = [
              { role: 'system', content: `你是 ${display}，正在和其他 AI 討論以下問題。${_roleNote}你可以參考工作區檔案內容進行分析。每次回答請根據前幾輪的對話內容延伸，不要重複，請提出新觀點或補充說明。` },
              ...hist.map(h => ({ role: h.role as 'user'|'assistant', content: h.content }))
            ];
            if (messages[messages.length - 1].role !== 'user') messages.push({ role: 'user', content: '請繼續。' });
            response = await this._services.ollamaChatStream(url, mName, messages,
              (c) => { if (!this._teamCancel) this._panel.webview.postMessage({ type: 'debateChunk', speaker: speakerKey, chunk: c }); },
              undefined,
              (tokens) => { this._callbacks.trackUsage(mName, tokens); });
          }
        } catch (e) {
          response = '[錯誤: ' + (e instanceof Error ? e.message : String(e)) + ']';
          this._panel.webview.postMessage({ type: 'debateChunk', speaker: speakerKey, chunk: response });
        }
        this._panel.webview.postMessage({ type: 'debateTurnEnd', speaker: speakerKey });
        hist.push({ role: 'assistant', content: response });
        roundResponses.push({ mi, display, response });
        summaryLines.push(`【${display} 第${round+1}輪】\n${response}`);
      }
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

    if (!this._teamCancel && summaryLines.length > 0) {
      const synthModel = TeamManager.pickThinkingModel(allModels.filter(m => isOllamaModel(m))) || allModels[0];
      const synthPrompt = `【原始問題】\n${prompt}\n\n【各成員觀點】\n${summaryLines.join('\n\n---\n\n')}\n\n請整合所有觀點，給出完整的綜合結論：`;
      this._panel.webview.postMessage({ type: 'teamSynthStart' });
      let synthResult = '';
      try {
        if (synthModel.startsWith('copilot::')) {
          synthResult = await this.copilotStream(synthModel.slice('copilot::'.length), synthPrompt,
            (c) => { if (!this._teamCancel) this._panel.webview.postMessage({ type: 'teamSynthChunk', chunk: c }); });
        } else {
          const { url, model: mName } = this._services.decodeOllamaModel(synthModel, urls);
          synthResult = await this._services.ollamaGenerateStream(url, mName, synthPrompt,
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
      const _discFinal = synthResult || summaryLines.join('\n\n---\n\n');
      if (_discFinal.trim()) {
        try {
          const _newEntry = `## 討論紀錄 ${teamContextTimestamp()}\n\n**議題：** ${prompt.slice(0, 200)}${prompt.length > 200 ? '…' : ''}\n\n${_discFinal}`;
          await appendTeamContext(_teamsCtxPath, _newEntry, _teamsCtxContent);
          this._panel.webview.postMessage({ type: 'teamSynthChunk', chunk: `\n\n---\n📝 討論結果已儲存至 teamscontext.md` });
        } catch (e) {
          this._panel.webview.postMessage({ type: 'teamSynthChunk', chunk: `\n\n⚠️ 無法儲存 teamscontext.md: ${e instanceof Error ? e.message : String(e)}` });
        }
      }
    }
    this._panel.webview.postMessage({ type: 'debateEnd', consensus: false });
    this._panel.webview.postMessage({ type: 'teamEnd', agentFollows: false });
  }

  private async _handleTeamAgent(prompt: string, allModels: string[], roles?: string[]): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('amiAiClaw');
    const urls = this._services.getOllamaUrls(cfg);
    const COLORS = TEAM_COLORS;
    const getDisplay = (m: string) => getWorkerDisplay(m, urls, (id, u) => this._services.decodeOllamaModel(id, u));
    const _agentRolesCfg = cfg.get<Array<{key:string;label:string;emoji:string;systemPrompt:string}>>('teamRoles', []);
    const _roleCfg  = (idx: number) => { const k = roles?.[idx]; return k ? _agentRolesCfg.find(c => c.key === k) : undefined; };
    const _rolePrefix = (idx: number) => { const r = _roleCfg(idx); return r ? `${r.emoji} ${r.label} ` : '💬 '; };
    const _roleNote   = (idx: number) => { const r = _roleCfg(idx); return r?.systemPrompt ? r.systemPrompt + '\n\n' : (roles?.[idx] ? TeamManager.buildRoleSystemNote(roles[idx]) + '\n\n' : ''); };

    const ROUNDS = 2;
    const tasks: string[] = [];
    for (let r = 0; r < ROUNDS; r++) {
      for (let mi = 0; mi < allModels.length; mi++) {
        tasks.push(`💬 第${r + 1}輪 ${_rolePrefix(mi)}${getDisplay(allModels[mi])}`);
      }
    }
    tasks.push('📋 生成 ToDo List');
    for (let mi = 0; mi < allModels.length; mi++) {
      tasks.push(`⚡ 執行 ${_rolePrefix(mi)}${getDisplay(allModels[mi])}`);
    }
    this._panel.webview.postMessage({ type: 'teamTodoList', tasks });

    const memberHistory: TeamManagerChatMessage[][] = allModels.map(() => []);
    const discussionLog: { roleLabel: string; text: string }[] = [];

    let todoIdx = 0;
    for (let round = 0; round < ROUNDS && !this._teamCancel; round++) {
      for (let mi = 0; mi < allModels.length && !this._teamCancel; mi++) {
        const model = allModels[mi];
        const color = COLORS[mi % COLORS.length];
        const roleLabel = _rolePrefix(mi) + getDisplay(model);
        const id = `tdisc_r${round}_m${mi}`;

        this._panel.webview.postMessage({ type: 'teamTodoStart', idx: todoIdx++, worker: `💬 第${round + 1}輪 ${roleLabel}` });
        this._panel.webview.postMessage({ type: 'teamMemberStart', id, model: `第${round + 1}輪 ${roleLabel}`, color, task: `第 ${round + 1} 輪討論` });

        const prevContext = discussionLog.length > 0
          ? '\n\n【目前討論紀錄】\n' + discussionLog.map(e => `**${e.roleLabel}**：${e.text}`).join('\n\n---\n\n')
          : '';

        let userMsg: string;
        if (round === 0) {
          userMsg = `${_roleNote(mi)}你是「${roleLabel}」，正在和團隊一起討論以下主題。\n請從你的職責與觀點出發，提出你的看法、疑問或建議。\n\n【討論主題】\n${prompt}${prevContext}`;
        } else {
          userMsg = `你是「${roleLabel}」，請根據以上討論，進一步回應、補充或挑戰前面成員的觀點，深化討論。`;
        }

        memberHistory[mi].push({ role: 'user', content: userMsg });

        let reply = '';
        try {
          const messages = memberHistory[mi];
          if (model.startsWith('copilot::')) {
            reply = await this.copilotStream(model.slice('copilot::'.length), userMsg,
              (c) => { if (!this._teamCancel) this._panel.webview.postMessage({ type: 'teamResponseChunk', id, chunk: c }); });
          } else {
            const { url, model: mName } = this._services.decodeOllamaModel(model, urls);
            reply = await this._services.ollamaChatStream(url, mName, messages,
              (c) => { if (!this._teamCancel) this._panel.webview.postMessage({ type: 'teamResponseChunk', id, chunk: c }); });
          }
        } catch { /* continue */ }

        if (reply) { memberHistory[mi].push({ role: 'assistant', content: reply }); }
        discussionLog.push({ roleLabel, text: reply || '（無回應）' });

        this._panel.webview.postMessage({ type: 'teamMemberEnd', id });
        this._panel.webview.postMessage({ type: 'teamTodoDone', idx: todoIdx - 1 });
      }
    }
    if (this._teamCancel) { this._panel.webview.postMessage({ type: 'teamEnd', agentFollows: false }); return; }

    const fullDiscussionLog = discussionLog.map(e => `【${e.roleLabel}】\n${e.text}`).join('\n\n---\n\n');

    let todoListText = '';
    const todoTaskIdx = ROUNDS * allModels.length;
    this._panel.webview.postMessage({ type: 'teamTodoStart', idx: todoTaskIdx, worker: '📋 生成 ToDo List' });
    {
      const todoModel = allModels.find(m => !m.startsWith('copilot/') && !m.startsWith('copilot::')) ?? allModels[0];
      const todoPrompt = `【討論主題】\n${prompt}\n\n【完整討論紀錄】\n${fullDiscussionLog}\n\n根據以上討論，整理出一份具體可執行的 ToDo List，每一項以 "- [ ] " 開頭，按優先順序排列，標註負責角色。只輸出 ToDo List，不需要其他說明。`;
      this._panel.webview.postMessage({ type: 'teamTodoListStart' });
      try {
        if (todoModel.startsWith('copilot::')) {
          todoListText = await this.copilotStream(todoModel.slice('copilot::'.length), todoPrompt,
            (c) => { if (!this._teamCancel) this._panel.webview.postMessage({ type: 'teamTodoListChunk', chunk: c }); });
        } else {
          const { url, model: mName } = this._services.decodeOllamaModel(todoModel, urls);
          todoListText = await this._services.ollamaGenerateStream(url, mName, todoPrompt,
            (c) => { if (!this._teamCancel) this._panel.webview.postMessage({ type: 'teamTodoListChunk', chunk: c }); });
        }
      } catch { /* continue */ }
      this._panel.webview.postMessage({ type: 'teamTodoListEnd' });
    }
    this._panel.webview.postMessage({ type: 'teamTodoDone', idx: todoTaskIdx });
    if (this._teamCancel) { this._panel.webview.postMessage({ type: 'teamEnd', agentFollows: false }); return; }

    const execOutputs: { label: string; output: string }[] = [];
    for (let mi = 0; mi < allModels.length && !this._teamCancel; mi++) {
      const model = allModels[mi];
      const color = COLORS[mi % COLORS.length];
      const roleLabel = _rolePrefix(mi) + getDisplay(model);
      const id = `tagent_ex_${mi}`;
      const execTaskIdx = todoTaskIdx + 1 + mi;
      this._panel.webview.postMessage({ type: 'teamTodoStart', idx: execTaskIdx, worker: `⚡ 執行 ${roleLabel}` });
      this._panel.webview.postMessage({ type: 'teamMemberStart', id, model: `⚡ ${roleLabel}`, color, task: '執行' });

      const origPost = this._panel.webview.postMessage.bind(this._panel.webview);
      let captured = '';
      const patchedPost = (msg: object & { type?: string }): Thenable<boolean> => {
        const t = (msg as { type?: string }).type;
        if (t === 'assistant') { const c = (msg as { text?: string }).text ?? ''; captured += c; origPost({ type: 'teamResponseChunk', id, chunk: c }); return Promise.resolve(true); }
        if (t === 'assistantChunk') { const c = (msg as { chunk?: string }).chunk ?? ''; captured += c; origPost({ type: 'teamResponseChunk', id, chunk: c }); return Promise.resolve(true); }
        if (t === 'agentStep' || t === 'agentStepDone' || t === 'agentStatus') { return origPost(msg); }
        return origPost(msg);
      };
      (this._panel.webview as { postMessage: (msg: object) => Thenable<boolean> }).postMessage = patchedPost;
      this._agentMessages = [];
      this._agentMessagesBySession[this._activeSessionId] = this._agentMessages;

      const execPrompt = `${_roleNote(mi)}【討論主題】\n${prompt}\n\n【團隊討論紀錄】\n${fullDiscussionLog}${todoListText ? `\n\n【執行 ToDo List】\n${todoListText}` : ''}\n\n請根據以上討論與 ToDo List，從你的職責角度執行你負責的項目。使用工具完成實際操作。`;
      try { await this._callbacks.executeAgent(execPrompt, model, false); } catch { /* continue */ }

      (this._panel.webview as { postMessage: (msg: object) => Thenable<boolean> }).postMessage = origPost;
      execOutputs.push({ label: roleLabel, output: captured });
      this._panel.webview.postMessage({ type: 'teamMemberEnd', id });
      this._panel.webview.postMessage({ type: 'teamTodoDone', idx: execTaskIdx });
    }

    if (!this._teamCancel) {
      const synthModel = allModels.find(m => !m.startsWith('copilot/') && !m.startsWith('copilot::')) ?? allModels[0];
      const execSummary = execOutputs.length > 0 ? '\n\n【各成員執行結果】\n' + execOutputs.map(o => `【${o.label}】\n${o.output}`).join('\n\n---\n\n') : '';
      const synthPrompt = `【討論主題】\n${prompt}\n\n【完整討論紀錄】\n${fullDiscussionLog}${execSummary}\n\n請整合以上討論與執行結果，提出共識結論與具體行動建議：`;
      this._panel.webview.postMessage({ type: 'teamSynthStart' });
      let synthResult = '';
      try {
        if (synthModel.startsWith('copilot::')) {
          synthResult = await this.copilotStream(synthModel.slice('copilot::'.length), synthPrompt,
            (c) => { if (!this._teamCancel) this._panel.webview.postMessage({ type: 'teamSynthChunk', chunk: c }); });
        } else {
          const { url, model: mName } = this._services.decodeOllamaModel(synthModel, urls);
          synthResult = await this._services.ollamaGenerateStream(url, mName, synthPrompt,
            (c) => { if (!this._teamCancel) this._panel.webview.postMessage({ type: 'teamSynthChunk', chunk: c }); });
        }
      } catch { /* ignore */ }
      if (synthResult) {
        this._chatHistory.push({ role: 'assistant', content: synthResult });
        this._chatHistories[this._activeSessionId] = this._chatHistory;
        this._panel.webview.postMessage({ type: 'historyCount', count: this._chatHistory.length, sessionId: this._activeSessionId });
      }
      const _final = synthResult || fullDiscussionLog;
      if (_final.trim()) {
        const _wsRoot = (vscode.workspace.workspaceFolders ?? [])[0]?.uri.fsPath ?? process.cwd();
        const _ctxPath = path.join(_wsRoot, 'teamscontext.md');
        try {
          const _entry = `## 討論紀錄 ${teamContextTimestamp()}\n\n**主題：** ${prompt.slice(0, 200)}${prompt.length > 200 ? '…' : ''}\n\n${_final}`;
          await appendTeamContext(_ctxPath, _entry);
          this._panel.webview.postMessage({ type: 'teamSynthChunk', chunk: `\n\n---\n📝 討論結果已儲存至 teamscontext.md` });
        } catch (e) {
          this._panel.webview.postMessage({ type: 'teamSynthChunk', chunk: `\n\n⚠️ 無法儲存 teamscontext.md: ${e instanceof Error ? e.message : String(e)}` });
        }
      }
    }

    this._panel.webview.postMessage({ type: 'teamEnd', agentFollows: false });
    this._panel.webview.postMessage({ type: 'agentStatus', running: false });
  }

  private async _handleTeamCompare(prompt: string, allModels: string[]): Promise<void> {
    if (allModels.length === 0) {
      this._panel.webview.postMessage({ type: 'error', text: '模型比較至少需選 1 個模型' });
      return;
    }
    const cfg = vscode.workspace.getConfiguration('amiAiClaw');
    const urls = this._services.getOllamaUrls(cfg);
    const COLORS = TEAM_COLORS;
    const getDisplay = (m: string) => getWorkerDisplay(m, urls, (id, u) => this._services.decodeOllamaModel(id, u));

    this._teamCancel = false;
    this._panel.webview.postMessage({ type: 'teamTodoList', tasks: allModels.map(m => getDisplay(m)) });

    const _cmpStart = Date.now();
    await Promise.all(allModels.map(async (model, mi) => {
      const color = COLORS[mi % COLORS.length];
      const display = getDisplay(model);
      const id = `tcmp_${mi}`;

      this._panel.webview.postMessage({ type: 'teamTodoStart', idx: mi, worker: display });
      this._panel.webview.postMessage({ type: 'teamMemberStart', id, model: `🆚 ${display}`, color, task: prompt });

      const systemContent = this._callbacks.getSystemContent(false);
      const t0 = Date.now();
      try {
        if (model.startsWith('copilot::')) {
          const family = model.slice('copilot::'.length);
          const msgs: vscode.LanguageModelChatMessage[] = [];
          if (systemContent.trim()) msgs.push(vscode.LanguageModelChatMessage.User(`[系統]\n${systemContent}`));
          msgs.push(vscode.LanguageModelChatMessage.User(prompt));
          const cts = new vscode.CancellationTokenSource();
          const response = await this._services.copilotStreamText(family, msgs,
            (chunk) => { if (!this._teamCancel) this._panel.webview.postMessage({ type: 'teamResponseChunk', id, chunk }); },
            cts.token);
          cts.dispose();
          const tokenEst = Math.ceil(this._services.estimateTokens(response));
          this._callbacks.trackUsage(family, tokenEst, this._services.getCopilotMultiplierById(family));
          this._callbacks.trackLatency(family, Date.now() - t0);
        } else {
          const { url, model: mName } = this._services.decodeOllamaModel(model, urls);
          const messages: TeamManagerChatMessage[] = [];
          if (systemContent.trim()) messages.push({ role: 'system', content: systemContent });
          messages.push({ role: 'user', content: prompt });
          const response = await this._services.ollamaChatStream(url, mName, messages,
            (chunk) => { if (!this._teamCancel) this._panel.webview.postMessage({ type: 'teamResponseChunk', id, chunk }); },
            undefined,
            (tokens) => { this._callbacks.trackUsage(mName, tokens); });
          this._callbacks.trackLatency(mName, Date.now() - t0);
          void response;
        }
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        this._panel.webview.postMessage({ type: 'teamResponseChunk', id, chunk: `\n[錯誤] ${errMsg}` });
      }

      this._panel.webview.postMessage({ type: 'teamMemberEnd', id });
      this._panel.webview.postMessage({ type: 'teamTodoDone', idx: mi });
    }));

    this._callbacks.trackLatency('compare-total', Date.now() - _cmpStart);
    this._panel.webview.postMessage({ type: 'teamEnd', agentFollows: false });
  }

  private async _handleTeamClone(prompt: string, model: string): Promise<void> {
    if (!model) {
      this._panel.webview.postMessage({ type: 'error', text: '分身 Agent 模式需至少選擇 1 個模型' });
      return;
    }
    const cfg = vscode.workspace.getConfiguration('amiAiClaw');
    const urls = this._services.getOllamaUrls(cfg);
    const getDisplay = (m: string) => getWorkerDisplay(m, urls, (id, u) => this._services.decodeOllamaModel(id, u));
    const CLONE_ROLES: { role: string; emoji: string; label: string; color: string }[] = [
      { role: 'planner',   emoji: '🗺️', label: '規劃者', color: '#f7a534' },
      { role: 'developer', emoji: '💻', label: '開發者', color: '#4fc1ff' },
      { role: 'reviewer',  emoji: '🔍', label: '評審員', color: '#c586c0' },
      { role: 'tester',    emoji: '🧪', label: '測試員', color: '#4ec9b0' },
      { role: 'writer',    emoji: '📝', label: '撰寫者', color: '#89d185' },
    ];
    const displayBase = getDisplay(model);

    this._teamCancel = false;
    this._panel.webview.postMessage({ type: 'teamTodoList', tasks: CLONE_ROLES.map(r => `${r.emoji} ${r.label}`) });

    const origPost = this._panel.webview.postMessage.bind(this._panel.webview);
    let prevOutput = '';

    for (let ri = 0; ri < CLONE_ROLES.length && !this._teamCancel; ri++) {
      const cr = CLONE_ROLES[ri];
      const id = `tclone_${ri}`;
      const roleNote = TeamManager.buildRoleSystemNote(cr.role);
      const roleDisplay = `${cr.emoji} ${displayBase} [${cr.label}]`;

      this._panel.webview.postMessage({ type: 'teamTodoStart', idx: ri, worker: roleDisplay });
      this._panel.webview.postMessage({ type: 'teamMemberStart', id, model: roleDisplay, color: cr.color,
        task: ri === 0 ? prompt : `承接上一階段（${CLONE_ROLES[ri-1].label}）的輸出繼續處理。` });

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
        if (t === 'agentStep' || t === 'agentStepDone' || t === 'agentStatus') { return origPost(msg); }
        return origPost(msg);
      };
      (this._panel.webview as { postMessage: (msg: object) => Thenable<boolean> }).postMessage = patchedPost;

      this._agentMessages = [];
      this._agentMessagesBySession[this._activeSessionId] = this._agentMessages;

      const stagePrompt = ri === 0
        ? `${roleNote}\n\n${prompt}`
        : `${roleNote}\n\n【原始任務】\n${prompt}\n\n【上一階段（${CLONE_ROLES[ri-1].label}）輸出】\n${prevOutput}\n\n請根據以上內容，從你的職責角度繼續處理。`;

      let stageOutput = '';
      try {
        const capturePost = (msg: object & { type?: string }): Thenable<boolean> => {
          if ((msg as { type?: string }).type === 'teamResponseChunk') {
            stageOutput += (msg as { chunk?: string }).chunk ?? '';
          }
          return origPost(msg);
        };
        (this._panel.webview as { postMessage: (msg: object) => Thenable<boolean> }).postMessage = capturePost;
        await this._callbacks.executeAgent(stagePrompt, model, false);
      } catch { /* continue with next stage */ }

      (this._panel.webview as { postMessage: (msg: object) => Thenable<boolean> }).postMessage = origPost;

      if (!isOllamaModel(model)) {
        // For copilot, stageOutput was collected via the capture patch above
      }
      prevOutput = stageOutput || prevOutput;

      this._panel.webview.postMessage({ type: 'teamMemberEnd', id });
      this._panel.webview.postMessage({ type: 'teamTodoDone', idx: ri });
    }

    this._agentMessages = [];
    this._agentMessagesBySession[this._activeSessionId] = this._agentMessages;
    this._panel.webview.postMessage({ type: 'teamEnd', agentFollows: false });
    this._panel.webview.postMessage({ type: 'agentStatus', running: false });
  }

  private async _handleTeamManager(prompt: string, allModels: string[], maxRounds: number, roles?: string[]): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('amiAiClaw');
    const urls = this._services.getOllamaUrls(cfg);
    const COLORS = TEAM_COLORS_MANAGER;
    const getDisplay = (m: string) => getWorkerDisplay(m, urls, (id, u) => this._services.decodeOllamaModel(id, u));
    if (allModels.length < 1) {
      this._panel.webview.postMessage({ type: 'error', text: '主管模式至少需要 1 個 AI 模型（第一個為主管）' });
      return;
    }

    this._panel.webview.postMessage({ type: 'teamOrchestratorStart', model: '🔍 掃描工作區' });
    this._panel.webview.postMessage({ type: 'teamOrchestratorChunk', chunk: '🔍 正在掃描工作區原始碼與 teamscontext.md…\n' });
    const _scan = await scanWorkspaceForTeam();
    const _mgrTeamsCtxPath = _scan.teamsCtxPath;
    const _mgrTeamsCtxContent = _scan.teamsCtxContent;
    const _mgrAllRelPaths = _scan.allRelPaths;
    const _mgrBaseCtx = _scan.baseCtx;
    this._panel.webview.postMessage({ type: 'teamOrchestratorChunk', chunk: `✅ 掃描完成：找到 ${_scan.allRelPaths.length} 個檔案，分 ${_scan.batches.length} 批讀取 ${_scan.readCount} 個內容（${Math.round(_scan.totalBytes/1024)}KB）\n` });
    this._panel.webview.postMessage({ type: 'teamOrchestratorEnd' });
    const _mgrBatchedInitHist: TeamHistoryEntry[] = buildBatchedInitHistory(_scan, '請提出任務。');
    const _mgrWsContext = _mgrBaseCtx;

    const _mgrLightHist: TeamHistoryEntry[] = [
      { role: 'user', content: `${_mgrBaseCtx}

以上是工作區所有檔案的路徑清單（共 ${_mgrAllRelPaths.length} 個），請記住此專案結構。` },
      { role: 'assistant', content: `已記住工作區結構，共 ${_mgrAllRelPaths.length} 個檔案。請提出任務或問題。` }
    ];

    const managerModel   = allModels[0];
    const memberModels   = allModels.slice(1);
    const _mgrRolesCfg = cfg.get<Array<{key:string;label:string;emoji:string;color:string;systemPrompt:string}>>('teamRoles', []);
    const _getMemberRoleInfo = (idx: number) => {
      const roleKey = roles?.[idx + 1];
      const roleCfg = roleKey ? _mgrRolesCfg.find(r => r.key === roleKey) : undefined;
      return {
        display: roleCfg ? `${roleCfg.emoji} ${roleCfg.label}` : `👨‍💻 工程師 #${idx + 1}`,
        systemNote: roleCfg?.systemPrompt ?? TeamManager.buildRoleSystemNote(roleKey ?? ''),
        label: roleCfg?.label ?? `工程師 #${idx + 1}`,
      };
    };
    const managerDisplay = `🏢 主管 (${getDisplay(managerModel)})`;
    const memberDisplays = memberModels.map((m, i) => `${_getMemberRoleInfo(i).display} (${getDisplay(m)})`);

    const _wsBlock = _mgrWsContext ? `\n\n你可以參考以下工作區資訊進行分析：\n${_mgrWsContext}` : '';
    const managerPersona =
      `你是【🏢 技術主管】，整個開發團隊的決策者與品質守門人。\n` +
      `你在此次任務中負責三個階段：\n` +
      `  【A - 架構計劃】：分析需求，制定整體架構方向，明確將任務分配給各工程師。\n` +
      `  【B - 審核討論計劃】：閱讀工程師的技術討論，確認方案可行後於回覆末尾輸出 [APPROVED]；\n` +
      `    否則給出具體調整意見（不輸出 [APPROVED]）。\n` +
      `  【C - Code Review】：工程師實作完成後，使用 read_file 工具逐一閱讀修改的檔案，\n` +
      `    檢查程式碼品質、命名規範、邏輯正確性、錯誤處理，給出具體 Review 意見與評分。\n` +
      `你只負責審核與決策，不自行寫程式碼。風格：嚴謹直接，繁體中文。${_wsBlock}`;

    const _isTester = (mi: number) => (roles?.[mi + 1] ?? '') === 'tester';
    const _engSpecializations = [
      '你負責架構設計與模組拆分，主導整體結構決策，確保元件邊界清晰、依賴關係合理。',
      '你負責核心邏輯與功能實作，專注演算法正確性、資料流與商業邏輯的實現。',
      '你負責整合層與 API 邊界，確保各模組協作順暢，並妥善處理錯誤情境與邊界條件。',
    ];
    const memberPersona = (mi: number) => {
      const info = _getMemberRoleInfo(mi);
      if (_isTester(mi)) {
        return (
          `你是【🧪 ${info.label}】（測試員）。工程師實作完成後，你負責撰寫完整的自動化測試工具。\n` +
          `工作流程：\n` +
          `  1. 使用 read_file 工具閱讀工程師實作的每個重要模組，理解程式結構\n` +
          `  2. 針對每個功能模組撰寫測試案例（unit test / integration test）\n` +
          `  3. 使用 write_file 工具建立測試檔案（如 test_xxx.py、xxx.test.ts、xxx.spec.ts）\n` +
          `  4. 測試案例必須覆蓋：正常情境、邊界條件、錯誤處理、異常輸入\n` +
          `重要：不得修改非測試檔案；所有測試直接用工具寫入，不可只描述計劃。繁體中文。${_wsBlock}`
        );
      }
      const engIdx = Math.min(mi, _engSpecializations.length - 1);
      const roleNote = info.systemNote ? `\n${info.systemNote}` : '';
      return (
        `你是【💻 ${info.label}】（工程師 #${mi + 1}）。${_engSpecializations[engIdx]}${roleNote}\n` +
        `工作分兩階段：\n` +
        `  【討論階段】與其他工程師共同討論實作方案，提出技術觀點，明確說明你打算修改哪些檔案與函式。\n` +
        `  【實作階段】主管核准後，使用 write_file / replace_in_file 工具直接修改程式碼——不要只說計劃，立即行動。\n` +
        `重要：你只看得到自己的對話歷史，不知道其他成員內容。繁體中文。${_wsBlock}`
      );
    };

    const managerHist: TeamHistoryEntry[] = [..._mgrBatchedInitHist];
    const memberHists: TeamHistoryEntry[][] = memberModels.map(() => [..._mgrBatchedInitHist]);

    const AGENT_TOOLS = this._callbacks.getAgentTools();
    const MGR_MEMBER_TOOLS = AGENT_TOOLS;
    const _MGR_WRITE_DENY = new Set(['write_file','replace_in_file','delete_file','create_dir','run_terminal','run_command','run_python','git_commit','lint_fix','jenkins_build','whatsapp_connect','whatsapp_disconnect','whatsapp_save_credentials','whatsapp_send','whatsapp_send_template','browser_script','jira_create','jira_transition','bb_create_pr']);
    const MGR_MANAGER_TOOLS = AGENT_TOOLS.filter(t => !_MGR_WRITE_DENY.has(t.function.name));

    const callModelDeps: TeamCallModelDeps = {
      urls,
      isCancelled: () => this._teamCancel,
      decodeOllamaModel: (id, u) => this._services.decodeOllamaModel(id, u),
      ollamaChatStream: (b, m, msgs, onR, onT, onS) => this._services.ollamaChatStream(b, m, msgs, onR, onT, onS),
      ollamaChatCallStream: (b, m, msgs, t, onT, onTx, onS) => this._services.ollamaChatCallStream(b, m, msgs, t, onT, onTx, onS),
      trackUsage: (m, t) => this._callbacks.trackUsage(m, t),
      executeTool: (n, a) => this._callbacks.executeTool(n, a),
    };
    const callModel = (
      model: string,
      persona: string,
      hist: TeamHistoryEntry[],
      userMsg: string,
      onChunk: (c: string) => void,
      onThink?: (c: string) => void,
      tools: unknown[] = []
    ): Promise<string> => teamCallModel(callModelDeps, model, persona, hist, userMsg, onChunk, onThink, tools);

    this._teamCancel = false;

    const _readUnderstandMsg =
      `請仔細閱讀以上工作區所有原始碼，然後簡要說明：\n` +
      `1. 你理解了哪些主要模組？（列出檔案路徑）\n` +
      `2. 現有程式碼的架構為何？\n` +
      `3. 針對以下需求，你認為最相關的檔案與入口點為何？\n\n需求：${prompt}`;

    const understandings: string[] = [];
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
    managerHist.push({ role: 'user', content: _readUnderstandMsg });
    managerHist.push({ role: 'assistant', content: managerUnderstanding });
    understandings.push(`【${managerDisplay}】\n${managerUnderstanding}`);
    this._panel.webview.postMessage({ type: 'teamOrchestratorEnd' });
    if (this._teamCancel) { this._panel.webview.postMessage({ type: 'teamEnd' }); return; }

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

    const _engineerIdxs = memberModels.map((_, i) => i).filter(mi => !_isTester(mi));
    const _testerIdxs   = memberModels.map((_, i) => i).filter(mi =>  _isTester(mi));

    let _approvedDiscPlan = '';
    if (_engineerIdxs.length > 0 && !this._teamCancel) {
      const _discLog: { label: string; text: string }[] = [];
      for (const mi of _engineerIdxs) {
        if (this._teamCancel) break;
        const prevCtx = _discLog.length > 0
          ? `\n\n【目前討論紀錄】\n${_discLog.map(e => `**${e.label}**：\n${e.text}`).join('\n\n---\n\n')}`
          : '';
        const discMsg =
          `【主管架構計劃與任務分配】\n${managerAnalysis}\n\n` +
          `請從你的職責角度提出討論：你準備如何實作你負責的部分？打算修改哪些具體檔案與函式？有哪些技術風險或依賴？${prevCtx}`;
        const id = `mgr_disc_${mi}`;
        const color = COLORS[(mi + 1) % COLORS.length];
        this._panel.webview.postMessage({ type: 'teamMemberStart', id, model: `💬 討論 ${memberDisplays[mi]}`, color, task: '討論實作計劃' });
        let discReply = '';
        try {
          discReply = await callModel(memberModels[mi], memberPersona(mi), memberHists[mi], discMsg,
            (c) => { if (!this._teamCancel) this._panel.webview.postMessage({ type: 'teamResponseChunk', id, chunk: c }); },
            (t) => { if (!this._teamCancel) this._panel.webview.postMessage({ type: 'teamThinkChunk', id, color, chunk: t }); });
        } catch (e) { discReply = '[討論失敗: ' + (e instanceof Error ? e.message : String(e)) + ']'; }
        _discLog.push({ label: memberDisplays[mi], text: discReply });
        memberHists[mi].push({ role: 'user', content: discMsg });
        memberHists[mi].push({ role: 'assistant', content: discReply });
        this._panel.webview.postMessage({ type: 'teamMemberEnd', id });
      }
      if (!this._teamCancel && _discLog.length > 0) {
        const _discSummary = _discLog.map(e => `【${e.label}】\n${e.text}`).join('\n\n---\n\n');
        const _planReviewMsg =
          `【工程師討論計劃】\n${_discSummary}\n\n` +
          `請審核工程師的討論計劃：\n` +
          `- 若方案合理可行，回覆末尾輸出 [APPROVED] 以開始實作\n` +
          `- 若有問題，指出需要調整的地方（不輸出 [APPROVED]）`;
        this._panel.webview.postMessage({ type: 'teamOrchestratorStart', model: `${managerDisplay} — 審核討論計劃` });
        let _planReviewResp = '';
        try {
          _planReviewResp = await callModel(managerModel, managerPersona, managerHist, _planReviewMsg,
            (c) => { if (!this._teamCancel) this._panel.webview.postMessage({ type: 'teamOrchestratorChunk', chunk: c }); },
            (t) => { if (!this._teamCancel) this._panel.webview.postMessage({ type: 'teamOrchestratorThinkChunk', chunk: t }); },
            MGR_MANAGER_TOOLS);
        } catch (e) { _planReviewResp = '[計劃審核失敗]'; }
        managerHist.push({ role: 'user', content: _planReviewMsg });
        managerHist.push({ role: 'assistant', content: _planReviewResp });
        this._panel.webview.postMessage({ type: 'teamOrchestratorEnd' });
        _approvedDiscPlan = _planReviewResp.includes('[APPROVED]')
          ? `【已核准的實作計劃】\n${_discSummary}`
          : `【討論計劃（主管要求修改）】\n${_planReviewResp}\n\n【原始討論】\n${_discSummary}`;
      }
    }
    if (this._teamCancel) { this._panel.webview.postMessage({ type: 'teamEnd' }); return; }

    const roundsLimit = isFinite(maxRounds) ? Math.min(maxRounds, 10) : 5;
    let approved = false;
    let managerFeedback = '';
    let memberProposals: string[] = [];

    for (let round = 0; round < roundsLimit && !this._teamCancel && !approved; round++) {
      memberProposals = [];
      for (let mi = 0; mi < memberModels.length && !this._teamCancel; mi++) {
        const id = `mgr_r${round}_m${mi}`;
        const color = COLORS[(mi + 1) % COLORS.length];
        const taskMsg = round === 0
          ? `【主管架構計劃】\n${managerAnalysis}${_approvedDiscPlan ? `\n\n${_approvedDiscPlan}` : ''}\n\n依據以上計劃，請立即使用工具（先 read_file 閱讀，再 write_file / replace_in_file 修改）完成你的實作任務：`
          : `【主管第 ${round} 輪 Code Review 意見】\n${managerFeedback}\n\n請根據主管意見，直接用工具更新對應檔案：`;
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
        await this._callbacks.executeAgent(execPrompt, agentModel, false);
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

    if (_testerIdxs.length > 0 && !this._teamCancel) {
      for (const mi of _testerIdxs) {
        if (this._teamCancel) break;
        const testMsg =
          `【原始任務】\n${prompt}\n\n【實作狀態】\n${execResult}\n\n` +
          `工程師已完成所有實作。請立即執行以下步驟：\n` +
          `  1. 用 read_file 工具閱讀主要實作檔案，了解程式結構與介面\n` +
          `  2. 用 write_file 工具建立測試檔案，覆蓋所有重要功能\n` +
          `  3. 確保測試包含：正常情境、邊界條件、錯誤處理、異常輸入\n` +
          `不要只描述計劃，直接用工具完成測試撰寫。`;
        const id = `mgr_test_${mi}`;
        const color = COLORS[(mi + 1) % COLORS.length];
        this._panel.webview.postMessage({ type: 'teamMemberStart', id, model: `🧪 ${memberDisplays[mi]} — 撰寫測試`, color, task: '撰寫自動化測試' });
        let testReply = '';
        try {
          testReply = await callModel(memberModels[mi], memberPersona(mi), memberHists[mi], testMsg,
            (c) => { if (!this._teamCancel) this._panel.webview.postMessage({ type: 'teamResponseChunk', id, chunk: c }); },
            (t) => { if (!this._teamCancel) this._panel.webview.postMessage({ type: 'teamThinkChunk', id, color, chunk: t }); },
            MGR_MEMBER_TOOLS);
        } catch (e) { testReply = '[測試撰寫失敗: ' + (e instanceof Error ? e.message : String(e)) + ']'; }
        memberHists[mi].push({ role: 'user', content: testMsg });
        memberHists[mi].push({ role: 'assistant', content: testReply });
        this._panel.webview.postMessage({ type: 'teamMemberEnd', id });
      }
    }
    if (this._teamCancel) { this._panel.webview.postMessage({ type: 'teamEnd' }); return; }

    const rvHdrId = 'mgr_rv_hdr';
    this._panel.webview.postMessage({ type: 'teamMemberStart', id: rvHdrId, model: '🔍 Code Review & 全員審查', color: '#aaaaaa', task: '主管 Code Review，各成員獨立審查' });
    this._panel.webview.postMessage({ type: 'teamResponseChunk', id: rvHdrId, chunk: '主管進行 Code Review（使用工具讀取檔案），工程師/測試員各自獨立審查（記憶分離）...' });
    this._panel.webview.postMessage({ type: 'teamMemberEnd', id: rvHdrId });

    const _mgrCodeReviewPrompt =
      `【原始任務】\n${prompt}\n\n【執行狀態】\n${execResult}\n\n` +
      `請進行 Code Review：\n` +
      `  1. 使用 read_file 工具逐一閱讀工程師修改過的每個重要檔案\n` +
      `  2. 檢查：命名規範、邏輯正確性、錯誤處理、程式碼可維護性\n` +
      `  3. 列出具體問題（附檔案名稱與修改建議）\n` +
      `  4. 給出整體評價（通過 / 需小修 / 需大改）`;
    const rvPrompt =
      `【原始任務】\n${prompt}\n\n【執行狀態】\n${execResult}\n\n` +
      `請以你的專業角色對執行結果進行 Review：\n` +
      `1. 是否符合需求？\n2. 有哪些潛在問題或風險？\n3. 建議的改進方向？`;

    const rvPersonas = [managerPersona, ...memberModels.map((_, i) => memberPersona(i))];
    const rvHists: TeamHistoryEntry[][] = [managerHist, ...memberHists];
    const reviewResults: string[] = [];

    for (let ri = 0; ri < allModels.length && !this._teamCancel; ri++) {
      const rvId = `mgr_rv_${ri}`;
      const color = COLORS[ri % COLORS.length];
      const display = ri === 0 ? managerDisplay : memberDisplays[ri - 1];
      this._panel.webview.postMessage({ type: 'teamMemberStart', id: rvId, model: `🔍 ${display}`, color, task: 'Review' });
      let rvResp = '';
      try {
        const _rvPrompt = ri === 0 ? _mgrCodeReviewPrompt : rvPrompt;
        const _rvTools  = ri === 0 ? MGR_MANAGER_TOOLS : [];
        rvResp = await callModel(allModels[ri], rvPersonas[ri], rvHists[ri], _rvPrompt,
          (c) => { if (!this._teamCancel) { this._panel.webview.postMessage({ type: 'teamResponseChunk', id: rvId, chunk: c }); } },
          (t) => { if (!this._teamCancel) { this._panel.webview.postMessage({ type: 'teamThinkChunk', id: rvId, color, chunk: t }); } },
          _rvTools);
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
      try {
        const _mgrEntry =
          `## 主管模式紀錄 ${teamContextTimestamp()}\n\n` +
          `**議題：** ${prompt.slice(0, 200)}${prompt.length > 200 ? '…' : ''}\n\n` +
          `**執行狀態：** ${execResult}\n\n` +
          `**全員 Review：**\n${finalSummary}`;
        await appendTeamContext(_mgrTeamsCtxPath, _mgrEntry, _mgrTeamsCtxContent);
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
    const callOllama = ollamaCall ?? this._services.ollamaGenerateStream.bind(null, baseUrl);
    let currentPrompt = assignedTask;
    let lastResponse = '';

    for (let round = 0; round < maxRounds && !this._teamCancel; round++) {
      this._panel.webview.postMessage({ type: 'teamRoundStart', id, round });

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
}
