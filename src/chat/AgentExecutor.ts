import * as vscode from 'vscode';

export interface AgentExecutorChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  thinking?: string;
  tool_calls?: Array<{ id?: string; function: { name: string; arguments: Record<string, unknown> | string } }>;
  tool_call_id?: string;
  images?: string[];
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
  executeTool: (name: string, args: Record<string, unknown>) => Promise<string>;
  handleInsert: (code: string) => Promise<void>;
  setWaAgentMode: (value: boolean) => void;
  clearAgentTodos: () => void;
  recordAuditEntry: (tool: string, args: Record<string, unknown>, error: boolean) => void;
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
  ollamaGenerate: (url: string, model: string, prompt: string) => Promise<{ response: string; thinking?: string }>;
  estimateTokens: (text: string) => number;
  getCopilotMultiplierById: (id: string) => string;
  filterSensitiveInfo: (text: string) => string;
  getToolIcon: (name: string) => string;
  formatToolTitle: (name: string, args: Record<string, unknown>) => string;
  agentTools: unknown[];
}

export class AgentExecutor {
  private _agentMessagesBySession: Record<string, AgentExecutorChatMessage[]> = { default: [] };
  private _agentMessages: AgentExecutorChatMessage[] = this._agentMessagesBySession.default;
  private _agentRunning = false;
  private _agentCancel = false;
  private _autoRunning = false;
  private _autoCancel = false;
  private _autoMaxIterations = 50;

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
  }

  public initSessionMessages(sessionId: string): void {
    this._agentMessagesBySession[sessionId] = [];
  }

  public async handleAgent(
    userPrompt: string,
    modelOverride?: string,
    recordToShortTerm = true,
    waTriggered = false
  ): Promise<void> {
    if (this._agentRunning) {
      vscode.window.showInformationMessage('Agent 已在執行中');
      return;
    }

    this._agentRunning = true;
    this._agentCancel = false;
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
      const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath ?? '';
      const openFiles = vscode.workspace.textDocuments
        .filter((document) => !document.isUntitled && document.uri.scheme === 'file')
        .map((document) => document.uri.fsPath);
      const openFilesText = openFiles.length > 0 ? `\n目前編輯器中開啟的檔案:\n${openFiles.join('\n')}` : '';
      const activeFileText = activeFile ? `\n目前作用中的檔案: ${activeFile}` : '';

      this._callbacks.clearAgentTodos();
      const ltm = this._callbacks.getLongTermMemory();
      this._agentMessages.push({
        role: 'system',
        content: `你是 VS Code 程式開發助手 Agent，可存取的工作區資料夾: ${folderList}。${activeFileText}${openFilesText}

## 執行鐵律
- 不得說「我將」「我會」等宣告意圖而不實際呼叫工具。看到需求就直接呼叫對應工具，立即執行。
- 不確定時優先查閱本地程式碼，而非假設或憑空生成。
- 複雜任務先用 manage_todo 建立清單，逐步完成。

## 可用工具總覽

### 📁 檔案操作
- get_active_file：取得目前編輯器開啟的檔案路徑與內容
- read_file(path)：讀取工作區內的檔案內容
- write_file(path, content)：建立或覆寫檔案
- replace_in_file(path, old_str, new_str)：替換檔案中的特定字串（優先用此取代 write_file 做局部修改）
- delete_file(path[, recursive])：刪除檔案或目錄
- create_dir(path)：建立目錄（含中間目錄）
- list_dir([path])：列出目錄內容，空白表示根目錄
- read_workspace([include][, exclude][, max_file_kb][, max_total_kb])：遞迴讀取整個工作區所有原始碼，適合全域理解或跨檔案重構；大型 repo 請縮小 include 範圍

### 🔍 搜尋
- search_workspace(query)：以關鍵字搜尋檔案名稱與程式碼內容，處理任何問題前優先呼叫
- search_regex(pattern[, include][, flags])：正規表達式搜尋工作區
- agentic_file_search(query[, include][, top_k])：自然語言語意搜尋，找最相關的原始碼檔案

### ⚡ 執行指令
- run_terminal(command)：在 VS Code 終端機執行命令（無輸出捕獲，適合背景啟動）
- run_command(command[, cwd])：執行指令並回傳 stdout+stderr（需要看結果時用此）
- run_python(code[, description])：執行 Python 程式碼片段，print() 輸出結果

### 🌐 網路 / 瀏覽器
- fetch_url(url)：下載網頁內容（自動去除 HTML，適合靜態文件）
- open_browser(url)：在 VS Code 簡易瀏覽器開啟網址
- http_request(url[, method][, headers][, body][, timeout])：發送 HTTP 請求（GET/POST/PUT/DELETE/PATCH），非 GET 需確認
- browser_navigate(url[, selector][, wait_for])：Playwright 無頭瀏覽器訪問 SPA 或動態頁面
- browser_screenshot(url[, path][, selector])：無頭瀏覽器截圖存為 PNG
- browser_script(script[, description])：執行 Playwright Python 自動化腳本

### 🗃️ 資料庫
- db_query(db_path, query[, params])：對 SQLite 執行 SQL（寫入需確認；用 ? 佔位符防注入）

### 📊 Git
- git_status([path])：取得工作區 Git 狀態
- git_diff([file][, staged])：取得 Git diff
- git_log([count][, file])：取得 commit 歷史
- git_commit(message[, add_all])：建立 Git commit（預設 git add -A，需確認）

### 🏗️ 程式碼品質
- lint_fix([path][, tool])：ESLint --fix / Prettier --write
- run_tests([path][, filter])：執行測試套件（jest/vitest/mocha/pytest）
- refactor_suggest(path[, focus])：原始碼複雜度分析並提供重構建議
- generate_docs([path][, tool][, output])：自動產生 API 文件（TypeDoc/JSDoc）

### 🎫 Jira / Atlassian
- jira_search(jql?, assignee?, reporter?, project?, status?, text?, max_results?)：搜尋 Jira Issues。常用 JQL 範例：
  - 列出我的待辦：jql="assignee=currentUser() AND status!=Done ORDER BY updated DESC"
  - 列出待 review：jql="status IN ('In Review','Code Review','PR Review') ORDER BY updated DESC"
  - 列出某人的：assignee="displayName"
- jira_log_time(issue_key, time_spent[, date][, comment])：記錄工時。例：time_spent="16h", date="today"
- jira_fetch(issue_key)：【強制】直接呼叫 Jira REST API 取得完整 Issue 詳情，看到 Jira Key 就立即呼叫
- jira_attachment_download(url[, filename])：下載 Jira 附件（ZIP 自動解壓縮）
- jira_open(issue_key)：在 VS Code 開啟 Jira Issue UI 面板（純介面，不回傳內容）
- jira_create([summary][, description])：開啟建立 Issue 面板
- jira_transition(issue_key)：開啟 Issue 狀態轉換面板
- bb_create_pr()：開啟 Bitbucket 建立 PR 面板
- rovo_ask(question)：向 Atlassian Rovo Dev AI 提問並回傳回覆

### 💬 WhatsApp
- whatsapp_connect([force])：連接個人 WhatsApp（QR Code 或已儲存 session）
- whatsapp_disconnect()：登出 WhatsApp Web
- whatsapp_status()：查詢 WhatsApp 連線狀態
- whatsapp_save_credentials(access_token, phone_number_id)：儲存 Meta WhatsApp Business API 憑證
- whatsapp_send(to, message)：發送 WhatsApp 文字訊息
- whatsapp_send_template(to, template_name[, language_code][, body_params])：發送樣板訊息

### 🛠️ Jenkins
- jenkins_build([job][, params][, wait])：觸發 Jenkins 建置
- jenkins_status([job][, build_number][, include_log][, log_lines])：查詢 Build 狀態與 Console 輸出

### 🎨 其他
- vscode_action(action[, path][, line][, message][, command])：VS Code 操作（開檔、顯示通知、執行內建指令）
- manage_todo(action[, text][, id])：Agent 內部任務清單（add/done/list/clear）

## Atlassian 整合【強制規則】
訊息中出現 [A-Z][A-Z0-9]*-\\d+（例 UOEM2-3476、BIOS-123）→ Jira Issue Key，必須立即呼叫 jira_fetch，禁止說「我將查詢」。
- 分析 / RCA / 查看內容 → jira_fetch
- 開啟 VS Code 面板 → jira_open
- 建立 Issue → jira_create；轉換狀態 → jira_transition；開 PR → bb_create_pr；詢問 AI → rovo_ask
${ltm.trim() ? `\n## 長期記憶\n${ltm.trim()}` : ''}

請使用繁體中文回答，完成後告知使用者結果。`,
      });
    }

    this._agentMessages.push({ role: 'user', content: userPrompt });
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
      for (let step = 0; step < 20 && !this._agentCancel; step++) {
        let response: AgentExecutorChatMessage | undefined;
        const isOllama = !model.startsWith('copilot::') && !isOpenAICompat;
        await this.autoSummarizeHistory(model, baseUrl);

        if (isOllama || isOpenAICompat) {
          this._callbacks.postToWebview({ type: 'streamStart' });
        }
        const onThinkChunk = isOllama
          ? (chunk: string) => this._callbacks.postToWebview({ type: 'thinkChunk', chunk, model })
          : undefined;
        const onTextChunk = (isOllama || isOpenAICompat)
          ? (chunk: string) => this._callbacks.postToWebview({ type: 'assistantChunk', chunk })
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
              result = await this._callbacks.executeTool(fn.name, args);
            } catch (error) {
              result = '錯誤：' + (error instanceof Error ? error.message : String(error));
              isError = true;
            }

            if (vscode.workspace.getConfiguration('amiAiClaw').get<boolean>('filterSensitiveInfo', true)) {
              result = this._services.filterSensitiveInfo(result);
            }

            this._callbacks.recordAuditEntry(fn.name, args, isError);
            this._callbacks.trackUsage(model, 0, '', true);

            const preview = result.length > 400 ? `${result.slice(0, 400)}\n…（已截斷）` : result;
            this._callbacks.postToWebview({ type: 'agentStepDone', result: preview, isError });
            this._agentMessages.push({ role: 'tool', content: result, tool_call_id: toolCall.id ?? fn.name });

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
        break;
      }
    } catch (error) {
      this._callbacks.postToWebview({ type: 'error', text: 'Agent 錯誤：' + (error instanceof Error ? error.message : String(error)) });
    } finally {
      this._callbacks.trackLatency(model, Date.now() - agentStart);
      this._agentRunning = false;
      this._agentCancel = false;
      this._callbacks.setWaAgentMode(false);
      this._callbacks.postToWebview({ type: 'agentStatus', running: false });
    }
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
    const baseUrl = cfg.get<string>('url') ?? 'http://localhost:11434';
    const model = modelOverride ?? cfg.get<string>('model') ?? '';

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

  private async autoSummarizeHistory(model: string, baseUrl: string): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('amiAiClaw');
    const enabled = cfg.get<boolean>('autoSummarizeHistory', true);
    const threshold = cfg.get<number>('autoSummarizeThreshold', 8000);
    const systemMessage = this._agentMessages[0];
    const remainingMessages = this._agentMessages.slice(1);
    const totalTokens = this._services.estimateTokens((systemMessage?.content ?? '') + remainingMessages.map((message) => message.content ?? '').join(''));

    if (totalTokens < threshold) {
      return;
    }

    const dropFallback = (messages: AgentExecutorChatMessage[]) => {
      let trimmed = messages;
      while (trimmed.length > 2 && this._services.estimateTokens((systemMessage?.content ?? '') + trimmed.map((message) => message.content ?? '').join('')) >= threshold) {
        let dropCount = 1;
        while (dropCount < trimmed.length && trimmed[dropCount].role === 'tool') {
          dropCount++;
        }
        trimmed = trimmed.slice(dropCount);
        while (trimmed.length > 0 && trimmed[0].role === 'tool') {
          trimmed = trimmed.slice(1);
        }
      }
      this._agentMessages = [systemMessage, ...trimmed];
      this._agentMessagesBySession[this._callbacks.getActiveSessionId()] = this._agentMessages;
    };

    if (!enabled) {
      dropFallback(remainingMessages);
      return;
    }

    let splitAt = Math.max(remainingMessages.length - 4, 0);
    while (splitAt > 0 && remainingMessages[splitAt].role === 'tool') {
      splitAt--;
    }
    const keepTail = remainingMessages.slice(splitAt);
    const toSummarize = remainingMessages.slice(0, splitAt);
    if (toSummarize.length < 2) {
      return;
    }

    this._callbacks.postToWebview({
      type: 'agentStep',
      icon: '📝',
      title: `對話歷史過長（≈${totalTokens} tokens），自動摘要舊訊息中…`,
      fullPath: '',
    });

    const summaryMessages: AgentExecutorChatMessage[] = [
      {
        role: 'system',
        content: '你是對話摘要助手。請將以下對話記錄濃縮成一段繁體中文摘要，保留重要的決策、已完成的操作、重要的程式碼路徑或資訊，省略冗餘問答。摘要長度不超過 600 字，直接輸出摘要內容不需要前言。',
      },
      {
        role: 'user',
        content: '請摘要以下對話記錄：\n\n'
          + toSummarize.map((message) => `[${message.role}]: ${(message.content ?? '').slice(0, 800)}`).join('\n\n').slice(0, 12000),
      },
    ];

    let summary = '';
    try {
      const response = model.startsWith('copilot::')
        ? await this._services.copilotChatCallWithCts(model.slice('copilot::'.length), summaryMessages, [])
        : model.startsWith('openai::')
          ? await this._services.openaiCompatChatCallStream(baseUrl, model.slice('openai::'.length), summaryMessages, [])
          : await this._services.ollamaChatCallStream(baseUrl, model, summaryMessages, []);
      summary = (response?.content ?? '').trim();
    } catch {
      // fallback below
    }

    if (!summary) {
      dropFallback(remainingMessages);
      this._callbacks.postToWebview({ type: 'agentStep', icon: '⚠️', title: '摘要失敗，改用裁剪模式', fullPath: '' });
      return;
    }

    this._agentMessages = [
      systemMessage,
      { role: 'user', content: `[自動摘要 — 先前 ${toSummarize.length} 則對話重點]\n${summary}` },
      { role: 'assistant', content: '已了解先前對話的進度與重要資訊，繼續執行任務。' },
      ...keepTail,
    ];
    this._agentMessagesBySession[this._callbacks.getActiveSessionId()] = this._agentMessages;
    this._callbacks.postToWebview({
      type: 'agentStep',
      icon: '✅',
      title: `摘要完成：${toSummarize.length} 則壓縮為 1 則摘要，釋出≈${totalTokens - this._services.estimateTokens(summary)} tokens`,
      fullPath: '',
    });
  }
}
