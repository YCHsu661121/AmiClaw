import * as vscode from 'vscode';

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
  trackUsage: (model: string, tokens: number, multiplier?: string, toolCall?: boolean) => void;
  trackLatency: (model: string, ms: number) => void;
  switchChatSession: (sessionId?: string) => void;
}

export interface QueryEngineServices {
  getOllamaUrls: (cfg: vscode.WorkspaceConfiguration) => string[];
  decodeOllamaModel: (modelId: string, fallbackUrls: string[]) => { url: string; model: string };
  encodeOllamaModelId: (url: string, model: string, allUrls: string[]) => string;
  ollamaDisplayLabel: (url: string, model: string, allUrls: string[]) => string;
  ollamaListModels: (url: string) => Promise<string[]>;
  ollamaWarmupModel: (url: string, model: string) => void;
  ollamaUnloadModel: (url: string, model: string) => Promise<void>;
  ollamaListRunningModels: (url: string) => Promise<string[]>;
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
  getCopilotMultiplier: (model: vscode.LanguageModelChat) => string;
  getCopilotMultiplierById: (id: string) => string;
  copilotStreamText: (
    modelId: string,
    messages: vscode.LanguageModelChatMessage[],
    onChunk: (chunk: string) => void,
    token: vscode.CancellationToken
  ) => Promise<string>;
  estimateTokens: (text: string) => number;
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

  public constructor(
    private readonly _callbacks: QueryEngineCallbacks,
    private readonly _services: QueryEngineServices
  ) {}

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

  private buildProviderInfo(modelId: string, models?: WebviewModelOption[]): ProviderInfo {
    const normalizedModelId = this.normalizeConfiguredModelId(modelId);
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
    const { url: baseUrl, model } = normalizedModel.startsWith('copilot::')
      ? { url: urls[0], model: normalizedModel }
      : this._services.decodeOllamaModel(normalizedModel, urls);

    this._callbacks.postToWebview({
      type: 'providerInfo',
      providerInfo: this.buildProviderInfo(normalizedModel),
    });

    await this.ensureModelReady(baseUrl, model);

    const systemContent = this.buildSystemContent(false);
    const chatHistory = this._callbacks.getChatHistory();
    const recent = chatHistory.slice(-20);

    let fullPrompt = '';
    if (systemContent.trim()) {
      fullPrompt += `System: ${systemContent}\n\n`;
    }
    for (const message of recent) {
      const role = message.role === 'user' ? 'User' : 'Assistant';
      fullPrompt += `${role}: ${message.content ?? ''}\n\n`;
    }
    fullPrompt += `User: ${prompt}`;

    chatHistory.push({ role: 'user', content: prompt });
    this._callbacks.postToWebview({
      type: 'historyCount',
      count: chatHistory.length,
      sessionId: this._callbacks.getActiveSessionId(),
    });

    this._callbacks.postToWebview({ type: 'streamStart' });
    let fullResponse = '';
    const sendStart = Date.now();

    if (this._pendingSendCts) {
      this._pendingSendCts.cancel();
      this._pendingSendCts.dispose();
      this._pendingSendCts = null;
    }

    try {
      if (model.startsWith('copilot::')) {
        const copilotId = model.slice('copilot::'.length);
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
          copilotMessages.push(vscode.LanguageModelChatMessage.User(prompt));
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

  public buildSystemContent(includeAtlassian = true): string {
    const cfg = vscode.workspace.getConfiguration('amiAiClaw');
    const persona = cfg.get<string>('systemPrompt') ?? '';
    const ltm = this._callbacks.getLongTermMemory();
    let content = persona.trim();

    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    const workspaceRoot = workspaceFolders.length > 0 ? workspaceFolders.map((folder) => folder.uri.fsPath).join(', ') : process.cwd();
    const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath ?? '';
    const openFiles = vscode.window.tabGroups?.activeTabGroup?.tabs
      .map((tab) => (tab.input as { uri?: vscode.Uri })?.uri?.fsPath ?? '')
      .filter(Boolean) ?? [];

    let workspaceInfo = `\n\n## 工作區資訊\n【工作區路徑】${workspaceRoot}`;
    if (activeFile) {
      workspaceInfo += `\n【作用中檔案】${activeFile}`;
    }
    if (openFiles.length > 0) {
      workspaceInfo += `\n【開啟的檔案】\n${openFiles.map((file) => `  - ${file}`).join('\n')}`;
    }
    content += workspaceInfo;

    if (ltm.trim()) {
      content += `\n\n## 長期記憶（關於使用者的重要資訊）\n${ltm.trim()}`;
    }
    if (includeAtlassian) {
      content += '\n\n## Atlassian 整合（atlassian.atlascode）\n'
        + '【強制規則—不得違反】\n'
        + '1. 訊息中出現 [A-Z][A-Z0-9]*-\\d+（例 UOEM2-3476、BIOS-123）→ Jira Issue Key。\n'
        + '2. 種類判斷與動作：\n'
        + '   - 「幫我分析 / RCA / 查看內容」任何分析請求 → 第一步必須立即呼叫 `jira_fetch`，取得內容後才可分析回答。\n'
        + '   - 「開啟 / 查看 / 顯示」 → 呼叫 `jira_open`（純 UI，不回傳內容）。\n'
        + '   - 建立 Issue → jira_create | 轉換狀態 → jira_transition | 開 PR → bb_create_pr | 問 Rovo Dev（AI 分析）→ rovo_ask（回傳回覆）\n'
        + '3. 【絕對禁止】不得說「我將查詢」「我會去取得」等宣告意圖的語句而不實際呼叫工具。看到 Jira Key 就直接呼叫工具，立即執行，不囉嗦。';
    }
    return content;
  }

  public async summarizeText(text: string, modelOverride?: string): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('amiAiClaw');
    const baseUrl = cfg.get<string>('url') ?? 'http://localhost:11434';
    const model = modelOverride ?? cfg.get<string>('model') ?? '';
    const prompt = `請以繁體中文，將下面內容濃縮成三條要點（每條 1 行），簡潔扼要：\n\n${text}`;

    try {
      const result = await this._services.ollamaGenerate(baseUrl, model, prompt);
      this._callbacks.postToWebview({ type: 'assistant', text: `（摘要）\n${result.response}` });
    } catch (error: unknown) {
      this._callbacks.postToWebview({ type: 'error', text: error instanceof Error ? error.message : String(error) });
    }
  }

  public async fetchModelsFromServer(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('amiAiClaw');
    const ollamaUrls = this._services.getOllamaUrls(cfg);
    this._callbacks.log(`fetchModelsFromServer: ${ollamaUrls.join(', ')}`);

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
    if (currentModel && !currentModel.startsWith('copilot::')) {
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
    const baseUrl = cfg.get<string>('url') ?? 'http://localhost:11434';
    const result = await this._services.ollamaCheckConnection(baseUrl);
    this._callbacks.postToWebview({ type: 'connectionStatus', ok: result.ok, url: baseUrl, message: result.message });
  }

  public async ensureModelReady(baseUrl: string, model: string): Promise<void> {
    if (model.startsWith('copilot::')) {
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

    this._callbacks.log(`Model switch: ${previousModel} -> ${model}，正在卸載舊模型並等待 VRAM 釋放`);
    await this._services.ollamaUnloadModel(baseUrl, previousModel);

    for (let seconds = 90; seconds > 0; seconds--) {
      this._callbacks.postToWebview({
        type: 'assistant',
        text: `⏳ 模型切換（${previousModel.split('/').pop()} → ${model.split('/').pop()}），等待 VRAM 釋放… ${seconds}s`,
      });
      const runningModels = await this._services.ollamaListRunningModels(baseUrl);
      const stillLoaded = runningModels.some((name) => name === previousModel || name.startsWith(previousModel.split(':')[0]));
      if (!stillLoaded) {
        this._callbacks.log(`VRAM 已釋放，等待結束（剩 ${seconds}s）`);
        this._callbacks.postToWebview({ type: 'assistant', text: `✅ VRAM 釋放完成，正在載入 ${model.split('/').pop()}…` });
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}
