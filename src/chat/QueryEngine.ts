import * as vscode from 'vscode';
import { findRelevantMemories } from '../memdir/findRelevantMemories';
import { buildSystemPrompt, truncateMemoryIndex } from '../context/SystemPromptBuilder';
import { formatCompactSummary } from '../context/HistoryCompactor';
import { buildWorkspaceDigest, getCurrentContextDepth, fmtSize } from '../context/WorkspaceDigest';
import {
  addProviderPrefix,
  getProviderKind,
  getProviderLabel,
  isCopilotModel,
  isOpenAIModel,
  isOllamaModel,
  normalizeProviderModelId,
  stripProviderPrefix,
} from '../providers/ProviderRegistry';

export interface QueryEngineChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  thinking?: string;
  tool_calls?: Array<{ id?: string; function: { name: string; arguments: Record<string, unknown> | string } }>;
  tool_call_id?: string;
  images?: string[];
}

export interface QueryEngineCallbacks {
  postToWebview: (msg: object) => void;
  log: (msg: string) => void;
  getChatHistory: () => QueryEngineChatMessage[];
  setChatHistory?: (history: QueryEngineChatMessage[]) => void;
  getChatHistories?: () => Record<string, QueryEngineChatMessage[]>;
  getActiveSessionId: () => string;
  getLongTermMemory: () => string;
  trackUsage: (model: string, tokens: number, multiplier?: string, toolCall?: boolean, inputTokens?: number, outputTokens?: number) => void;
  trackLatency: (model: string, ms: number) => void;
  switchChatSession: (sessionId?: string) => void;
}

export interface QueryEngineServices {
  getOllamaUrls: (cfg: vscode.WorkspaceConfiguration) => string[];
  decodeOllamaModel: (modelId: string, fallbackUrls: string[]) => { url: string; model: string };
  encodeOllamaModelId: (url: string, model: string, allUrls: string[]) => string;
  ollamaDisplayLabel: (url: string, model: string, allUrls: string[]) => string;
  ollamaListModels: (url: string) => Promise<string[]>;
  fetchOpenAiCompatModels: (url: string, apiKey: string) => Promise<string[]>;
  ollamaGetContextLength: (url: string, model: string) => Promise<number>;
  ollamaWarmupModel: (url: string, model: string) => void;
  ollamaUnloadModel: (url: string, model: string) => Promise<void>;
  ollamaListRunningModels: (url: string) => Promise<string[]>;
  ollamaGetRunningModels: (url: string) => Promise<{ name: string; size_vram: number }[]>;
  ollamaCheckConnection: (url: string) => Promise<{ ok: boolean; message: string }>;
  ollamaGenerate: (url: string, model: string, prompt: string) => Promise<{ response: string; thinking?: string }>;
  ollamaGenerateStream: (
    url: string,
    model: string,
    prompt: string,
    onResponseChunk: (chunk: string) => void,
    onThinkChunk?: (chunk: string) => void,
    onStats?: (tokens: number, tps: number) => void,
    images?: string[]
  ) => Promise<string>;
  openaiCompatChatCallStream: (
    url: string,
    model: string,
    messages: QueryEngineChatMessage[],
    tools: unknown[],
    onTextChunk?: (chunk: string) => void,
    onStats?: (tokens: number, tps: number) => void,
    onThinkChunk?: (chunk: string) => void
  ) => Promise<QueryEngineChatMessage>;
  getCopilotMultiplier: (model: vscode.LanguageModelChat) => string;
  getCopilotMultiplierById: (id: string) => string;
  copilotStreamText: (
    modelId: string,
    messages: vscode.LanguageModelChatMessage[],
    onChunk: (chunk: string) => void,
    token: vscode.CancellationToken
  ) => Promise<string>;
  copilotChatCallWithCts?: (
    modelId: string,
    messages: QueryEngineChatMessage[],
    tools: unknown[]
  ) => Promise<QueryEngineChatMessage>;
  estimateTokens: (text: string) => number;
  // Ask 模式工具支援（選用，未注入時 fallback 到純 generate）
  ollamaChatCallStream?: (
    baseUrl: string,
    model: string,
    messages: QueryEngineChatMessage[],
    tools: unknown[],
    onThinkChunk?: (chunk: string) => void,
    onTextChunk?: (chunk: string) => void,
    onStats?: (tokens: number, tps: number) => void
  ) => Promise<QueryEngineChatMessage>;
  executeTool?: (name: string, args: Record<string, unknown>) => Promise<string>;
  getToolIcon?: (name: string) => string;
  formatToolTitle?: (name: string, args: Record<string, unknown>) => string;
  filterSensitiveInfo?: (text: string) => string;
  agentTools?: unknown[];
  clearModelCtxCache?: () => void;
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

export class QueryEngine {
  private _pendingSendCts: vscode.CancellationTokenSource | null = null;
  private _lastOllamaUrl = '';
  private _lastOllamaModel = '';
  private _modelContextLength = 0;   // 從 Ollama /api/show 取得的實際 context window（0 = 未知）

  public constructor(
    private readonly _callbacks: QueryEngineCallbacks,
    private readonly _services: QueryEngineServices
  ) {}

  public cancelSend(): void {
    if (this._pendingSendCts) {
      this._pendingSendCts.cancel();
      this._pendingSendCts.dispose();
      this._pendingSendCts = null;
    }
  }

  private normalizeConfiguredModelId(modelId: string): string {
    return normalizeProviderModelId(modelId);
  }

  private getProviderId(modelId: string): string {
    return getProviderKind(modelId);
  }

  private getProviderLabel(providerId: string): string {
    return getProviderLabel(providerId as ReturnType<typeof getProviderKind>);
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
        id: addProviderPrefix('copilot', model.id),
        label: model.name,
        provider: 'copilot',
        providerLabel: 'Copilot',
        multiplier: model.multiplier,
      })),
    ];
  }

  private buildProviderInfo(modelId: string, models?: WebviewModelOption[]): ProviderInfo {
    const normalizedModelId = this.normalizeConfiguredModelId(modelId);
    const providerId = this.getProviderId(normalizedModelId);
    const displayName = models?.find((model) => model.id === normalizedModelId)?.label
      ?? stripProviderPrefix(normalizedModelId);

    return {
      id: providerId,
      label: this.getProviderLabel(providerId),
      modelId: normalizedModelId,
      displayName,
    };
  }

  /**
   * 解析 prompt 中的檔案提及，自動讀取內容並回傳擴充後的 prompt。
   * 支援格式：
   *   - #file:src/foo.ts
   *   - #path:src/foo.ts
   *   - @src/foo.ts （需以 / 或 \ 含路徑）
   *   - `src/foo.ts` （反引號包住，需以已知副檔名結尾）
   * 自動限制總量避免 token 爆量。
   */
  public async expandFileMentions(prompt: string): Promise<string> {
    const cfg = vscode.workspace.getConfiguration('amiAiClaw');
    if (!cfg.get<boolean>('expandFileMentions', true)) { return prompt; }

    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) { return prompt; }
    const wsRoot = folders[0].uri.fsPath;

    // 收集候選路徑（去重保序）
    const seen = new Set<string>();
    const mentions: string[] = [];
    const push = (p: string) => {
      const t = p.trim().replace(/^[\s,;。：:、]+|[\s,;。：:、]+$/g, '');
      if (t && !seen.has(t)) { seen.add(t); mentions.push(t); }
    };
    // #file:path 或 #path:path
    const fileRe = /#(?:file|path):([^\s`'"，,；;]+)/gi;
    let m: RegExpExecArray | null;
    while ((m = fileRe.exec(prompt)) !== null) { push(m[1]); }
    // @path （需含 / 或 \）
    const atRe = /@([^\s`'"，,；;]*[\\/][^\s`'"，,；;]+)/g;
    while ((m = atRe.exec(prompt)) !== null) { push(m[1]); }
    // 反引號路徑
    const bqRe = /`([^`\n]+\.(?:ts|tsx|js|jsx|py|cs|java|go|rs|cpp|cc|c|h|hpp|md|json|yaml|yml|txt|sh|bat|ps1|html|css|scss|sql|vue|svelte))`/gi;
    while ((m = bqRe.exec(prompt)) !== null) { push(m[1]); }

    if (mentions.length === 0) { return prompt; }

    const MAX_MENTIONS = 10;
    const MAX_PER_FILE = 32 * 1024; // 32KB
    const MAX_TOTAL = 96 * 1024; // 96KB
    const blocks: string[] = [];
    const skipped: string[] = [];
    let totalBytes = 0;

    for (const rel of mentions.slice(0, MAX_MENTIONS)) {
      // ── 三層優先順序路徑解析 ──────────────────────────────────────────────
      // 1. 直接存在於磁碟（絕對路徑 or workspace join）
      // 2. VS Code 已開啟的 textDocuments（basename / suffix 比對）
      // 3. workspace.findFiles 搜尋整個工作區
      let fpath = require('path').isAbsolute(rel) ? rel : require('path').join(wsRoot, rel);
      const relNorm = rel.replace(/\\/g, '/').toLowerCase();
      const relBase = require('path').basename(rel).toLowerCase();
      try { await vscode.workspace.fs.stat(vscode.Uri.file(fpath)); }
      catch {
        // ② 查已開啟的 documents
        let resolved = '';
        for (const doc of vscode.workspace.textDocuments) {
          const dNorm = doc.uri.fsPath.replace(/\\/g, '/').toLowerCase();
          if (dNorm.endsWith(relNorm) || require('path').basename(doc.uri.fsPath).toLowerCase() === relBase) {
            resolved = doc.uri.fsPath; break;
          }
        }
        if (!resolved) {
          // ③ findFiles 搜尋工作區
          try {
            const hits = await vscode.workspace.findFiles(`**/${rel.replace(/\\/g, '/')}`, '**/node_modules/**', 5);
            if (!hits.length) {
              const hits2 = await vscode.workspace.findFiles(`**/${relBase}`, '**/node_modules/**', 5);
              hits.push(...hits2);
            }
            if (hits.length) {
              hits.sort((a, b) => a.fsPath.length - b.fsPath.length);
              resolved = hits[0].fsPath;
            }
          } catch { /* ignore */ }
        }
        if (resolved) { fpath = resolved; }
      }
      try {
        const stat = await vscode.workspace.fs.stat(vscode.Uri.file(fpath));
        if (stat.type === vscode.FileType.Directory) {
          // 目錄：列出檔案清單
          const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(fpath));
          const lines = entries.slice(0, 50).map(([name, t]) => `  - ${name}${t === vscode.FileType.Directory ? '/' : ''}`);
          const block = `=== ${rel} (目錄) ===\n${lines.join('\n')}${entries.length > 50 ? `\n  …(+${entries.length - 50})` : ''}\n`;
          if (totalBytes + block.length > MAX_TOTAL) { skipped.push(rel); continue; }
          blocks.push(block);
          totalBytes += block.length;
          continue;
        }
        if (stat.size > 5 * 1024 * 1024) { skipped.push(`${rel} (>5MB)`); continue; }
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(fpath));
        let text = Buffer.from(bytes).toString('utf8');
        if (text.length > MAX_PER_FILE) {
          text = text.slice(0, MAX_PER_FILE) + `\n…（已截斷至 ${MAX_PER_FILE / 1024}KB，原始 ${Math.round(text.length / 1024)}KB）`;
        }
        const remaining = MAX_TOTAL - totalBytes;
        if (text.length > remaining) {
          text = text.slice(0, Math.max(0, remaining)) + `\n…（達總量上限）`;
        }
        const block = `=== ${rel} ===\n${text}\n`;
        blocks.push(block);
        totalBytes += block.length;
        if (totalBytes >= MAX_TOTAL) { break; }
      } catch {
        skipped.push(`${rel} (找不到)`);
      }
    }

    if (mentions.length > MAX_MENTIONS) {
      skipped.push(`…(超過上限 ${MAX_MENTIONS}，未處理 ${mentions.length - MAX_MENTIONS} 個)`);
    }

    if (blocks.length === 0) { return prompt; }
    const header = `\n\n## 使用者提及的檔案/目錄（自動讀取）\n${skipped.length > 0 ? `⚠️ 略過：${skipped.join(', ')}\n` : ''}`;
    return prompt + header + blocks.join('\n');
  }

  public async handleSend(
    prompt: string,
    modelOverride?: string,
    sessionId?: string,
    images?: string[]
  ): Promise<void> {
    this._callbacks.switchChatSession(sessionId);
    const cfg = vscode.workspace.getConfiguration('amiAiClaw');
    const urls = this._services.getOllamaUrls(cfg);
    const rawModel = modelOverride ?? cfg.get<string>('model') ?? '';
    const normalizedModel = this.normalizeConfiguredModelId(rawModel);
    const { url: baseUrl, model } = isCopilotModel(normalizedModel)
      ? { url: urls[0], model: normalizedModel }
      : this._services.decodeOllamaModel(normalizedModel, urls);

    this._callbacks.postToWebview({
      type: 'providerInfo',
      providerInfo: this.buildProviderInfo(normalizedModel),
    });

    await this.ensureModelReady(baseUrl, model);

    // 自動展開 #file/@path 提及
    const expandedPrompt = await this.expandFileMentions(prompt);

    let systemContent = this.buildSystemContent(false);
    // 深度解析：當 contextDepth 為 outline / full 時，附加整個工作區摘要或完整原始碼到 system prompt
    try {
      const depth = getCurrentContextDepth();
      if (depth !== 'file') {
        const cfgDepth = vscode.workspace.getConfiguration('amiAiClaw');
        const digest = await buildWorkspaceDigest({
          depth,
          maxTotalKb: Math.max(8, cfgDepth.get<number>('outlineMaxKb', 24)),
          modelContextLength: this._modelContextLength,
          onProgress: (msg) => this._callbacks.postToWebview({ type: 'agentStepProgress', text: msg }),
        });
        if (digest.text) {
          systemContent += `\n\n${digest.text}`;
          this._callbacks.postToWebview({
            type: 'agentStepProgress',
            text: `🔬 深度解析（${depth}）：注入 ${digest.fileCount} 檔 / ${fmtSize(digest.bytes)} / ${digest.durationMs}ms${digest.truncated ? '（已截斷）' : ''}`,
          });
        }
      }
    } catch (e: unknown) {
      this._callbacks.log(`buildWorkspaceDigest failed: ${(e as Error)?.message ?? e}`);
    }
    const chatHistory = this._callbacks.getChatHistory();
    await this.autoSummarizeHistory(chatHistory, model, baseUrl);
    // 通知 webview 更新 context 百分比
    try {
      const cfg = vscode.workspace.getConfiguration('amiAiClaw');
      const cfgThreshold = cfg.get<number>('autoSummarizeThreshold', 8000);
      const threshold = this._modelContextLength > 0 ? this._modelContextLength : cfgThreshold;
      const { estimateTokens } = this._services;
      const tokens = Math.ceil(estimateTokens(chatHistory.map(m => m.content ?? '').join('')));
      const pct = Math.round(tokens / threshold * 100);
      this._callbacks.postToWebview({ type: 'contextPercent', tokens, pct, threshold });
    } catch { /* 非關鍵 */ }
    const recent = chatHistory.slice(-40);

    // 注入與本次 prompt 相關的記憶檔案（排除 MEMORY.md，其內容已在 LTM 區塊）
    try {
      const relevant = await findRelevantMemories(expandedPrompt, 5);
      if (relevant && relevant.length > 0) {
        const filtered = relevant.filter(m => !m.path.endsWith('MEMORY.md'));
        if (filtered.length > 0) {
          const memLines = filtered.map(m => `- ${m.path}\n${m.excerpt.slice(0, 800)}\n`).join('\n');
          systemContent += `\n\n## 注入的相關記憶檔案\n${memLines}`;
        }
      }
    } catch (e) { /* ignore */ }

    let fullPrompt = '';
    if (systemContent.trim()) {
      fullPrompt += `System: ${systemContent}\n\n`;
    }
    for (const message of recent) {
      const role = message.role === 'user' ? 'User' : 'Assistant';
      fullPrompt += `${role}: ${message.content ?? ''}\n\n`;
    }
    fullPrompt += `User: ${expandedPrompt}`;

    chatHistory.push({ role: 'user', content: prompt });
    this._callbacks.postToWebview({
      type: 'historyCount',
      count: chatHistory.length,
      sessionId: this._callbacks.getActiveSessionId(),
    });

    this._callbacks.postToWebview({ type: 'streamStart', thinking: true });
    let fullResponse = '';
    const sendStart = Date.now();

    if (this._pendingSendCts) {
      this._pendingSendCts.cancel();
      this._pendingSendCts.dispose();
      this._pendingSendCts = null;
    }

    try {
      if (isCopilotModel(model)) {
        const copilotId = stripProviderPrefix(model);
        const cts = new vscode.CancellationTokenSource();
        this._pendingSendCts = cts;
        try {
          const copilotMessages: vscode.LanguageModelChatMessage[] = [];
          if (systemContent.trim()) {
            copilotMessages.push(vscode.LanguageModelChatMessage.User(`[系統]\n${systemContent}`));
          }
          for (const message of recent) {
            copilotMessages.push(
              message.role === 'user'
                ? vscode.LanguageModelChatMessage.User(message.content ?? '')
                : vscode.LanguageModelChatMessage.Assistant(message.content ?? '')
            );
          }
          copilotMessages.push(vscode.LanguageModelChatMessage.User(expandedPrompt));
          fullResponse = await this._services.copilotStreamText(
            copilotId,
            copilotMessages,
            (chunk) => this._callbacks.postToWebview({ type: 'assistantChunk', chunk }),
            cts.token
          );
          this._callbacks.trackUsage(
            copilotId,
            Math.ceil(this._services.estimateTokens(fullResponse)),
            this._services.getCopilotMultiplierById(copilotId)
          );
        } finally {
          this._pendingSendCts = null;
          cts.dispose();
        }
      } else {
        // ── Ask 模式唯讀工具：當設定啟用且 services 已注入時，走 chat API + tools 迴圈 ──
        const askToolsEnabled = cfg.get<boolean>('askModeTools', true);
        const canUseTools = askToolsEnabled
          && this._services.ollamaChatCallStream
          && this._services.executeTool
          && this._services.agentTools;
        const askReason = [
          !askToolsEnabled && 'askModeTools=false',
          !this._services.ollamaChatCallStream && 'ollamaChatCallStream未注入',
          !this._services.executeTool && 'executeTool未注入',
          !this._services.agentTools && 'agentTools未注入',
        ].filter(Boolean).join(', ');
        this._callbacks.log(`[Ask] model=${model} canUseTools=${!!canUseTools}${askReason ? ` reason=(${askReason})` : ''}`);
        if (canUseTools) {
          fullResponse = await this.handleAskWithTools(
            baseUrl,
            model,
            systemContent,
            recent,
            expandedPrompt,
            false // handleSend 為 Ask 模式
          );
        } else if (isOpenAIModel(model)) {
          const response = await this._services.openaiCompatChatCallStream(
            baseUrl,
            stripProviderPrefix(model),
            [
              ...(systemContent.trim() ? [{ role: 'system' as const, content: systemContent }] : []),
              ...recent,
              { role: 'user' as const, content: expandedPrompt },
            ],
            [],
            (chunk) => this._callbacks.postToWebview({ type: 'assistantChunk', chunk }),
            (tokens, tps) => {
              this._callbacks.postToWebview({ type: 'streamStats', tokens, tps });
              this._callbacks.trackUsage(model, tokens);
            },
            (chunk) => this._callbacks.postToWebview({ type: 'thinkChunk', chunk, model })
          );
          fullResponse = response.content ?? '';
        } else {
          fullResponse = await this._services.ollamaGenerateStream(
            baseUrl,
            model,
            fullPrompt,
            (chunk) => this._callbacks.postToWebview({ type: 'assistantChunk', chunk }),
            (chunk) => this._callbacks.postToWebview({ type: 'thinkChunk', chunk }),
            (tokens, tps) => {
              this._callbacks.postToWebview({ type: 'streamStats', tokens, tps });
              this._callbacks.trackUsage(model, tokens);
            },
            images
          );
        }
      }

      this._callbacks.trackLatency(model, Date.now() - sendStart);
      chatHistory.push({ role: 'assistant', content: fullResponse });
      this._callbacks.postToWebview({ type: 'streamEnd' });
      this._callbacks.postToWebview({
        type: 'historyCount',
        count: chatHistory.length,
        sessionId: this._callbacks.getActiveSessionId(),
      });
    } catch (error: unknown) {
      chatHistory.pop();
      this._callbacks.postToWebview({ type: 'error', text: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * Ask 模式工具迴圈：使用唯讀工具子集，模型可呼叫 read_file/list_dir/search 等工具自動取得上下文。
   * 寫入類工具（write_file/replace_in_file/delete_file/run_command 等）一律過濾掉。
   * 失敗時拋出，由 handleSend 回退處理。
   */
  private async handleAskWithTools(
    baseUrl: string,
    model: string,
    systemContent: string,
    recent: QueryEngineChatMessage[],
    userPrompt: string,
    isAgentMode = false
  ): Promise<string> {
    const READONLY_TOOL_NAMES = new Set([
      'get_active_file', 'read_file', 'read_files', 'list_dir',
      'search_workspace', 'search_regex', 'agentic_file_search',
      'git_status', 'git_diff', 'git_log',
    ]);
    const allTools = (this._services.agentTools as Array<{ function?: { name?: string } }>) ?? [];
    // Agent 模式使用完整工具集；Ask 模式僅保留唯讀子集
    const tools = isAgentMode
      ? allTools
      : allTools.filter((t) => t.function?.name && READONLY_TOOL_NAMES.has(t.function.name));
    const messages: QueryEngineChatMessage[] = [];
    if (systemContent.trim()) {
      const askOnlyGuide = isAgentMode ? '' : '\n\n## 工具使用守則（Ask 模式）\n你現在處於 ASK 模式（唯讀問答模式）：只能回答問題與分析，不能修改檔案或執行命令。\n- 你有唯讀工具：read_file、read_files、list_dir、search_workspace、search_regex、git_status、git_diff、git_log。\n- 任何修改檔案/執行命令的請求請拒絕並提示使用者切換到 🤖 Agent 模式。\n- 需要查看多個檔案時優先用 read_files 一次取得，避免連續 read_file。';
      messages.push({ role: 'system', content: systemContent + askOnlyGuide });
    }
    for (const m of recent) {
      messages.push({ role: m.role, content: m.content, tool_calls: m.tool_calls, tool_call_id: m.tool_call_id });
    }
    messages.push({ role: 'user', content: userPrompt });

    const onThinkChunk = (chunk: string) => this._callbacks.postToWebview({ type: 'thinkChunk', chunk, model });
    const onTextChunk = (chunk: string) => this._callbacks.postToWebview({ type: 'assistantChunk', chunk });
    const onStats = (tokens: number, tps: number, usage?: { input: number; output: number }) => {
      this._callbacks.postToWebview({ type: 'streamStats', tokens, tps });
      this._callbacks.trackUsage(model, tokens, '', false, usage?.input, usage?.output);
    };

    const MAX_STEPS = 6;
    let finalText = '';
    this._callbacks.log(`[Ask tools] 開始 model=${model} isAgentMode=${isAgentMode} tools=${tools.length}/${allTools.length} steps=${MAX_STEPS}`);
    for (let step = 0; step < MAX_STEPS; step++) {
      let response: QueryEngineChatMessage;
      try {
        if (isCopilotModel(model)) {
          // Copilot 路徑：透過 VS Code Language Model API
          const copilotId = stripProviderPrefix(model);
          if (!this._services.copilotChatCallWithCts) {
            throw new Error('copilotChatCallWithCts service not injected');
          }
          this._callbacks.log(`[Ask tools] step=${step} → Copilot model=${copilotId}`);
          const copilotMsg = await this._services.copilotChatCallWithCts(copilotId, messages, tools);
          response = { role: 'assistant', content: copilotMsg?.content ?? '', tool_calls: copilotMsg?.tool_calls };
        } else if (isOpenAIModel(model)) {
          this._callbacks.log(`[Ask tools] step=${step} → OpenAI-compat model=${stripProviderPrefix(model)} url=${baseUrl}`);
          response = await this._services.openaiCompatChatCallStream(
            baseUrl,
            stripProviderPrefix(model),
            messages,
            tools,
            onTextChunk,
            onStats,
            onThinkChunk
          );
        } else {
          this._callbacks.log(`[Ask tools] step=${step} → Ollama model=${model} url=${baseUrl}`);
          response = await this._services.ollamaChatCallStream!(baseUrl, model, messages, tools, onThinkChunk, onTextChunk, onStats);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/does not support tools/i.test(message)) {
          // 模型不支援工具：退回非工具模式
          this._callbacks.postToWebview({ type: 'streamAbort' });
          this._callbacks.log(`Ask tools: model ${model} 不支援工具，退回 generate 模式`);
          let fullPrompt = systemContent.trim() ? `System: ${systemContent}\n\n` : '';
          for (const m of recent) {
            fullPrompt += `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content ?? ''}\n\n`;
          }
          fullPrompt += `User: ${userPrompt}`;
          if (isOpenAIModel(model)) {
            const fallbackResponse = await this._services.openaiCompatChatCallStream(
              baseUrl,
              stripProviderPrefix(model),
              [{ role: 'user', content: fullPrompt }],
              [],
              onTextChunk,
              onStats,
              onThinkChunk
            );
            return fallbackResponse.content ?? '';
          }
          return await this._services.ollamaGenerateStream(
            baseUrl, model, fullPrompt,
            (c) => this._callbacks.postToWebview({ type: 'assistantChunk', chunk: c }),
            (c) => this._callbacks.postToWebview({ type: 'thinkChunk', chunk: c }),
            onStats
          );
        }
        if (/no user query found/i.test(message) && step < MAX_STEPS - 1) {
          // Qwen3/Llama4 Jinja template requires a user message after tool results
          this._callbacks.log(`[Ask tools] Jinja 模板缺少 user 訊息，注入繼續指令重試 (step=${step})`);
          messages.push({ role: 'user', content: `請根據工具結果繼續：${userPrompt.slice(0, 200)}` });
          if (isOllamaModel(model)) { this._callbacks.postToWebview({ type: 'streamStart', thinking: true }); }
          continue;
        }
        throw error;
      }

      if (response.tool_calls && response.tool_calls.length > 0) {
        this._callbacks.postToWebview({ type: 'streamAbort' });
        messages.push({ role: 'assistant', content: response.content ?? null, tool_calls: response.tool_calls });
        for (const tc of response.tool_calls) {
          const fn = tc.function;
          const args = (typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : fn.arguments) as Record<string, unknown>;
          if (!isAgentMode && !READONLY_TOOL_NAMES.has(fn.name)) {
            const denyMsg = `❌ Ask 模式不允許 ${fn.name}（寫入/執行類）。請切換到 🤖 Agent 模式。`;
            this._callbacks.postToWebview({ type: 'agentStep', icon: '🚫', title: denyMsg, fullPath: '' });
            this._callbacks.postToWebview({ type: 'agentStepDone', result: denyMsg, isError: true });
            messages.push({ role: 'tool', content: denyMsg, tool_call_id: tc.id ?? fn.name });
            continue;
          }
          const icon = this._services.getToolIcon ? this._services.getToolIcon(fn.name) : '🔧';
          const title = this._services.formatToolTitle ? this._services.formatToolTitle(fn.name, args) : fn.name;
          this._callbacks.postToWebview({ type: 'agentStep', icon, title, fullPath: (args.path as string) || '' });
          let result: string;
          let isError = false;
          try {
            result = await this._services.executeTool!(fn.name, args);
          } catch (error) {
            result = '錯誤：' + (error instanceof Error ? error.message : String(error));
            isError = true;
          }
          if (this._services.filterSensitiveInfo) { result = this._services.filterSensitiveInfo(result); }
          const preview = result.length > 400 ? `${result.slice(0, 400)}\n…（已截斷）` : result;
          this._callbacks.postToWebview({ type: 'agentStepDone', result: preview, isError });
          messages.push({ role: 'tool', content: result, tool_call_id: tc.id ?? fn.name });
        }
        // 進入下一輪，模型決定是否再呼叫工具或產出最終回答
        this._callbacks.postToWebview({ type: 'streamStart', thinking: isOllamaModel(model) });
        continue;
      }

      finalText = response.content ?? '';
      break;
    }
    return finalText;
  }

  public buildSystemContent(includeAtlassian = true): string {
    const cfg = vscode.workspace.getConfiguration('amiAiClaw');
    const persona = (cfg.get<string>('systemPrompt') ?? '').trim();
    const ltm = this._callbacks.getLongTermMemory();

    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    const workspaceRoot = workspaceFolders.length > 0 ? workspaceFolders.map((folder) => folder.uri.fsPath).join(', ') : process.cwd();
    const activeEditor = vscode.window.activeTextEditor;
    const activeFile = activeEditor?.document.uri.fsPath ?? '';
    const openFiles = vscode.window.tabGroups?.activeTabGroup?.tabs
      .map((tab) => (tab.input as { uri?: vscode.Uri })?.uri?.fsPath ?? '')
      .filter(Boolean) ?? [];

    let workspaceBody = `【工作區路徑】${workspaceRoot}`;
    if (activeFile) {
      workspaceBody += `\n【作用中檔案】${activeFile}`;
    }
    if (openFiles.length > 0) {
      workspaceBody += `\n【開啟的檔案】\n${openFiles.map((file) => `  - ${file}`).join('\n')}`;
    }

    // 自動附帶作用中檔案內容（Copilot-like）：可由設定關閉，限制大小避免 token 爆量
    const autoIncludeActive = cfg.get<boolean>('autoIncludeActiveFile', true);
    const maxActiveBytes = Math.max(1024, Math.min(64 * 1024, (cfg.get<number>('autoIncludeActiveMaxKb', 16) || 16) * 1024));
    let activeFileBody = '';
    if (autoIncludeActive && activeEditor && !activeEditor.document.isUntitled && activeEditor.document.uri.scheme === 'file') {
      const text = activeEditor.document.getText();
      const fileName = activeEditor.document.uri.fsPath;
      const lang = activeEditor.document.languageId || '';
      const truncated = text.length > maxActiveBytes
        ? text.slice(0, maxActiveBytes) + `\n…（內容已截斷至 ${Math.floor(maxActiveBytes / 1024)}KB，原始 ${Math.round(text.length / 1024)}KB；如需完整內容請呼叫 read_file）`
        : text;
      activeFileBody = `【路徑】${fileName}\n\`\`\`${lang}\n${truncated}\n\`\`\``;
    }

    const memoryIndex = truncateMemoryIndex(ltm.trim(), 200);

    const atlassianRules = includeAtlassian
      ? '【強制規則—不得違反】\n'
        + '1. 訊息中出現 [A-Z][A-Z0-9]*-\\d+（例 UOEM2-3476、BIOS-123）→ Jira Issue Key。\n'
        + '2. 種類判斷與動作：\n'
        + '   - 「幫我分析 / RCA / 查看內容」任何分析請求 → 第一步必須立即呼叫 `jira_fetch`，取得內容後才可分析回答。\n'
        + '   - 「開啟 / 查看 / 顯示」 → 呼叫 `jira_open`（純 UI，不回傳內容）。\n'
        + '   - 建立 Issue → jira_create | 轉換狀態 → jira_transition | 開 PR → bb_create_pr | 問 Rovo Dev（AI 分析）→ rovo_ask（回傳回覆）\n'
        + '3. 【絕對禁止】不得說「我將查詢」「我會去取得」等宣告意圖的語句而不實際呼叫工具。看到 Jira Key 就直接呼叫工具，立即執行，不囉嗦。'
      : '';

    return buildSystemPrompt({
      persona,
      extraSections: [
        { title: '工作區資訊', content: workspaceBody },
        { title: '作用中檔案內容（自動附帶）', content: activeFileBody },
        { title: '長期記憶（關於使用者的重要資訊）', content: memoryIndex },
        { title: 'Atlassian 整合（atlassian.atlascode）', content: atlassianRules },
      ],
    });
  }

  public async generateChatTitle(sessionId: string, userMsg: string, assistantMsg: string): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('amiAiClaw');
    const urls = this._services.getOllamaUrls(cfg);
    const rawModel = cfg.get<string>('model') ?? '';
    const { url: baseUrl, model } = this._services.decodeOllamaModel(rawModel, urls);
    const prompt = `根據以下對話，用繁體中文生成一個15字以內的簡潔標題，只輸出標題本身，不要加引號或解釋：\n用戶：${userMsg}\n助理：${assistantMsg}`;
    try {
      const raw = isOpenAIModel(model)
        ? (await this._services.openaiCompatChatCallStream(baseUrl, stripProviderPrefix(model), [{ role: 'user', content: prompt }], [])).content ?? ''
        : (await this._services.ollamaGenerate(baseUrl, model, prompt)).response;
      const title = raw.trim().replace(/^["「『【〔]|["」』】〕]$/g, '').replace(/\n[\s\S]*/g, '').slice(0, 20);
      if (title) this._callbacks.postToWebview({ type: 'chatTitleGenerated', sessionId, title });
    } catch { /* 靜默失敗，保留現有標題 */ }
  }

  public async summarizeText(text: string, modelOverride?: string): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('amiAiClaw');
    const urls = this._services.getOllamaUrls(cfg);
    const rawModel = modelOverride ?? cfg.get<string>('model') ?? '';
    const { url: baseUrl, model } = this._services.decodeOllamaModel(rawModel, urls);
    const prompt = `請以繁體中文，將下面內容濃縮成三條要點（每條 1 行），簡潔扼要：\n\n${text}`;

    try {
      const text = isOpenAIModel(model)
        ? (await this._services.openaiCompatChatCallStream(baseUrl, stripProviderPrefix(model), [{ role: 'user', content: prompt }], [])).content ?? ''
        : (await this._services.ollamaGenerate(baseUrl, model, prompt)).response;
      this._callbacks.postToWebview({ type: 'assistant', text: `（摘要）\n${text}` });
    } catch (error: unknown) {
      this._callbacks.postToWebview({ type: 'error', text: error instanceof Error ? error.message : String(error) });
    }
  }

  public async fetchModelsFromServer(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('amiAiClaw');
    const ollamaUrls = this._services.getOllamaUrls(cfg);
    this._callbacks.log(`fetchModelsFromServer: ${ollamaUrls.join(', ')}`);
    // 清除 context length 快取，讓 LM Studio 等 context 設定變更立即生效
    if (this._services.clearModelCtxCache) { this._services.clearModelCtxCache(); }

    const liveModels: { id: string; label: string }[] = [];
    let copilotModels: { id: string; name: string; multiplier: string }[] = [];
    let connectionOk = false;
    let connectionMessage = '連線失敗';
    let connectionUrl = ollamaUrls[0];

    for (const url of ollamaUrls) {
      try {
        const models = await this._services.ollamaListModels(url);
        for (const model of models) {
          liveModels.push({
            id: this._services.encodeOllamaModelId(url, model, ollamaUrls),
            label: this._services.ollamaDisplayLabel(url, model, ollamaUrls),
          });
        }
        if (!connectionOk) {
          connectionOk = true;
          connectionMessage = ollamaUrls.length > 1 ? `${ollamaUrls.length} 台伺服器已連線` : 'OK';
          connectionUrl = url;
        }
        this._callbacks.log(`fetchModelsFromServer OK from ${url}`);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (!connectionOk) {
          connectionMessage = message;
          connectionUrl = url;
        }
        this._callbacks.log(`fetchModelsFromServer error from ${url}: ${message}`);
      }
    }

    const openaiUrls = cfg.get<string[]>('openaiUrls') ?? [];
    const openaiApiKey = cfg.get<string>('openaiCompatApiKey', '');
    for (const url of openaiUrls) {
      try {
        const models = await this._services.fetchOpenAiCompatModels(url, openaiApiKey);
        for (const model of models) {
          const sep = model.indexOf('||');
          const cleanLabel = sep !== -1 ? model.slice(sep + 2) : model.replace(/^openai::/, '');
          liveModels.push({ id: model, label: cleanLabel });
        }
        if (!connectionOk) {
          connectionOk = true;
          connectionMessage = 'OpenAI-compatible OK';
          connectionUrl = url;
        }
        this._callbacks.log(`fetchModelsFromServer OpenAI-compatible OK from ${url}`);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (!connectionOk) {
          connectionMessage = message;
          connectionUrl = url;
        }
        this._callbacks.log(`fetchModelsFromServer OpenAI-compatible error from ${url}: ${message}`);
      }
    }

    try {
      const chatModels = await vscode.lm.selectChatModels({ vendor: 'copilot' });
      const seen = new Set<string>();
      for (const model of chatModels) {
        if (!seen.has(model.id)) {
          seen.add(model.id);
          const name = (model.name || model.family).replace(/\s+\d+x\b|\s+x\d+\b/gi, '').trim();
          copilotModels.push({ id: model.id, name, multiplier: this._services.getCopilotMultiplier(model) });
        }
      }
    } catch {
      // Copilot not available
    }

    const currentModel = this.normalizeConfiguredModelId(cfg.get<string>('model') ?? liveModels[0]?.id ?? '');
    if (currentModel && isOllamaModel(currentModel)) {
      const { url, model } = this._services.decodeOllamaModel(currentModel, ollamaUrls);
      this._services.ollamaWarmupModel(url, model);
      this._callbacks.log(`Model warmup: ${model} @ ${url}`);
    }

    const models = this.normalizeModelOptions(liveModels, copilotModels);
    this._callbacks.postToWebview({
      type: 'modelList',
      models,
      current: currentModel,
      providerInfo: this.buildProviderInfo(currentModel, models),
    });
    this._callbacks.postToWebview({ type: 'connectionStatus', ok: connectionOk, url: connectionUrl, message: connectionMessage });
    this._callbacks.log('fetchModelsFromServer postMessage done');
  }

  public async testConnectionStatus(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('amiAiClaw');
    const urls = this._services.getOllamaUrls(cfg);
    const firstUrl = urls[0] ?? 'http://localhost:11434';
    const result = await this._services.ollamaCheckConnection(firstUrl);
    this._callbacks.postToWebview({ type: 'connectionStatus', ok: result.ok, url: firstUrl, message: result.message });
  }

  public async ensureModelReady(baseUrl: string, model: string): Promise<void> {
    if (!isOllamaModel(model)) {
      return;
    }

    const previousUrl = this._lastOllamaUrl;
    const previousModel = this._lastOllamaModel;
    this._lastOllamaUrl = baseUrl;
    this._lastOllamaModel = model;

    if (!previousModel || previousModel === model) {
      return;
    }
    if (previousUrl && previousUrl !== baseUrl) {
      this._callbacks.log(`Model switch: ${previousModel}@${previousUrl} -> ${model}@${baseUrl}，不同 server，跳過 VRAM 釋放`);
      return;
    }

    const fromShort = previousModel.split('/').pop();
    const toShort = model.split('/').pop();

    // 先查目前執行中的模型 VRAM 用量，決定是否需要強制卸載
    const runningInfo = await this._services.ollamaGetRunningModels(baseUrl);
    const prevFamily = previousModel.split(':')[0];
    const newFamily  = model.split(':')[0];
    const oldModelInfo = runningInfo.find(m => m.name === previousModel || m.name.startsWith(prevFamily));
    const newAlreadyLoaded = runningInfo.some(m => m.name === model || m.name.startsWith(newFamily));

    if (newAlreadyLoaded) {
      this._callbacks.log(`Model switch: ${previousModel} -> ${model}，新模型已載入，跳過卸載`);
      return;
    }
    if (!oldModelInfo || oldModelInfo.size_vram === 0) {
      this._callbacks.log(`Model switch: ${previousModel} -> ${model}，舊模型不佔 VRAM（CPU 模式），跳過卸載`);
      return;
    }

    this._callbacks.log(`Model switch: ${previousModel} -> ${model}，舊模型佔用 VRAM ${(oldModelInfo.size_vram / 1024 ** 3).toFixed(1)} GB，正在卸載`);
    await this._services.ollamaUnloadModel(baseUrl, previousModel);
    this._callbacks.postToWebview({
      type: 'assistant',
      text: `⏳ 模型切換 ${fromShort} → ${toShort}，等待 VRAM 釋放…`,
    });

    for (let seconds = 90; seconds > 0; seconds--) {
      const runningModels = await this._services.ollamaListRunningModels(baseUrl);
      const stillLoaded = runningModels.some((name) => name === previousModel || name.startsWith(prevFamily));
      if (!stillLoaded) {
        const waited = 90 - seconds;
        this._callbacks.log(`VRAM 已釋放，等待結束（用時 ${waited}s）`);
        this._callbacks.postToWebview({ type: 'assistant', text: `✅ VRAM 釋放完成（${waited}s），載入 ${toShort}…` });
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  /**
   * Ask 模式對話歷史自動摘要壓縮。
   * 超過 threshold tokens 時，將較舊的訊息壓縮為一則摘要。
   * 直接 mutate chatHistory 陣列（splice），不需要 setChatHistory。
   */
  private async autoSummarizeHistory(
    chatHistory: QueryEngineChatMessage[],
    model: string,
    baseUrl: string
  ): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('amiAiClaw');
    const enabled = cfg.get<boolean>('autoSummarizeHistory', true);
    const cfgThreshold = cfg.get<number>('autoSummarizeThreshold', 8000);

    // 向 Ollama/vLLM 查詢實際 context window；Copilot 模型回傳 0
    if (!isCopilotModel(model)) {
      const ctxLen = await this._services.ollamaGetContextLength(baseUrl, model);
      if (ctxLen > 0) { this._modelContextLength = ctxLen; }
    } else {
      this._modelContextLength = 0;
    }

    // 觸發摘要的門檻：60% 不夠，需預留 tool defs (~7K tokens) + 程式碼密度差異 (3 vs 4 chars/token)
    const threshold = this._modelContextLength > 0
      ? Math.floor(this._modelContextLength * 0.45)
      : cfgThreshold;

    if (chatHistory.length < 4) { return; }

    const totalTokens = this._services.estimateTokens(chatHistory.map(m => m.content ?? '').join(''));
    if (totalTokens < threshold) { return; }

    // 保留最新 4 則，對前面的摘要
    const keepTail = chatHistory.slice(-4);
    const toSummarize = chatHistory.slice(0, chatHistory.length - 4);
    if (toSummarize.length < 2) {
      // Too few old messages to summarize; truncate the longest recent messages to free context
      for (const msg of chatHistory) {
        if ((msg.content?.length ?? 0) > 8000) {
          msg.content = (msg.content ?? '').slice(0, 8000) + '\n…（截斷以釋放 context）';
        }
      }
      return;
    }

    this._callbacks.postToWebview({
      type: 'agentStep',
      icon: '📝',
      title: `對話歷史過長（≈${totalTokens} tokens），自動摘要舊訊息中…`,
      fullPath: '',
    });

    const summaryMessages: QueryEngineChatMessage[] = [
      {
        role: 'system',
        content: '你是對話摘要助手，只輸出繁體中文純文字，禁止呼叫工具。',
      },
      {
        role: 'user',
        content: `**重要：只能輸出純文字，禁止呼叫任何工具。**

你的任務是對以下對話記錄產生一份詳細的繁體中文摘要，此摘要將取代舊訊息，因此必須捕捉所有重要資訊。

請先在 <分析> 標籤內草擬你的分析，然後在 <摘要> 標籤內產生結構化摘要，包含以下 9 個段落：

1. **主要請求與意圖**：所有使用者請求的完整細節（含隱含需求與限制條件）
2. **關鍵技術概念**：討論過的技術、框架、設計模式與慣例
3. **檔案與程式碼段落**：每個檢查或修改過的檔案（含具體程式碼片段與行號）
4. **錯誤與修復**：每個遇到的錯誤、原因及解決方式
5. **問題解決過程**：已解決的問題、有效與無效的方法
6. **所有使用者訊息**：保留原文以維持上下文
7. **待完成任務**：明確要求但尚未完成的工作
8. **目前工作**：壓縮前正在進行的最後任務的詳細描述
9. **建議的下一步**：與最近使用者請求直接對應的最合邏輯的下一步

**再次提醒：禁止呼叫工具，只輸出 <分析>...</分析> 和 <摘要>...</摘要>。**

以下是要摘要的對話記錄：

` + toSummarize.map(m => `[${m.role}]: ${(m.content ?? '').slice(0, 800)}`).join('\n\n').slice(0, 12000),
      },
    ];

    let summary = '';
    try {
      if (isOpenAIModel(model)) {
        const resp = await this._services.openaiCompatChatCallStream(baseUrl, stripProviderPrefix(model), summaryMessages, []);
        summary = formatCompactSummary((resp?.content ?? '').trim());
      } else if (this._services.ollamaChatCallStream && !isCopilotModel(model)) {
        const resp = await this._services.ollamaChatCallStream(baseUrl, model, summaryMessages, []);
        summary = formatCompactSummary((resp?.content ?? '').trim());
      }
      if (!summary) {
        const resp = await this._services.ollamaGenerate(baseUrl, model,
          summaryMessages[0].content + '\n\n' + summaryMessages[1].content);
        summary = formatCompactSummary((resp.response ?? '').trim());
      }
    } catch { /* fall through to trim fallback */ }

    if (!summary) {
      // fallback：直接裁除舊訊息
      const trimmed = chatHistory.slice(-Math.floor(chatHistory.length / 2));
      chatHistory.splice(0, chatHistory.length, ...trimmed);
      this._callbacks.postToWebview({ type: 'agentStep', icon: '⚠️', title: '摘要失敗，改用裁剪模式', fullPath: '' });
      return;
    }

    const compressed: QueryEngineChatMessage[] = [
      { role: 'user', content: `[自動摘要—先前 ${toSummarize.length} 則對話重點]\n${summary}` },
      { role: 'assistant', content: '已了解先前對話的進度與重要資訊，繼續回答。' },
      ...keepTail,
    ];
    chatHistory.splice(0, chatHistory.length, ...compressed);

    this._callbacks.postToWebview({
      type: 'agentStep',
      icon: '✅',
      title: `Ask 模式歷史摘要完成：${toSummarize.length} 則壓縮為 1 則摘要`,
      fullPath: '',
    });
  }
}
