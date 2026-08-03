/**
 * SystemPromptBuilder
 *
 * 移植自 claude-code `context.ts` 的 system prompt 組裝管線。
 * 把分散的 system 內容（persona / memory / workspace / tool rules）統一為固定管線。
 *
 * 設計原則：
 *   - 每個 section 都是純函式 → 易測試、易選擇性啟用
 *   - 區塊間用清楚的分隔線，方便 model 解析
 *   - 順序固定：persona → policy → memory index → workspace → active file → custom rules
 */

export interface SystemPromptSection {
  /** Section 標題（會用 `## {title}` 包起來） */
  title: string;
  /** Section 內文；空字串會被略過 */
  content: string;
}

export interface BuildSystemPromptInput {
  /** Persona / role definition（最先） */
  persona?: string;
  /** Hard policy rules（如 Atlassian / 不要修改某些檔案） */
  policy?: string;
  /** MEMORY.md index 內容（短期 + 長期記憶索引） */
  memoryIndex?: string;
  /** Workspace 概況（git status, project root, open files 計數等） */
  workspaceSummary?: string;
  /** 當前 active file 摘要 */
  activeFileSummary?: string;
  /** 啟用中的工具規則摘要 */
  toolRules?: string;
  /** 額外自訂 sections（會接在最後） */
  extraSections?: SystemPromptSection[];
}

const SEP = '\n\n---\n\n';

/**
 * 組裝 system prompt：依固定順序拼接，空 section 略過。
 */
export function buildSystemPrompt(input: BuildSystemPromptInput): string {
  const parts: string[] = [];

  if (input.persona?.trim()) {
    parts.push(input.persona.trim());
  }

  if (input.policy?.trim()) {
    parts.push(`## Policy\n\n${input.policy.trim()}`);
  }

  if (input.memoryIndex?.trim()) {
    parts.push(`## Long-term memory index\n\n${input.memoryIndex.trim()}`);
  }

  if (input.workspaceSummary?.trim()) {
    parts.push(`## Workspace\n\n${input.workspaceSummary.trim()}`);
  }

  if (input.activeFileSummary?.trim()) {
    parts.push(`## Active file\n\n${input.activeFileSummary.trim()}`);
  }

  if (input.toolRules?.trim()) {
    parts.push(`## Tool rules\n\n${input.toolRules.trim()}`);
  }

  for (const sec of input.extraSections ?? []) {
    if (sec.content?.trim()) {
      parts.push(`## ${sec.title}\n\n${sec.content.trim()}`);
    }
  }

  return parts.join(SEP);
}

/**
 * 依 token 預算裁切 memoryIndex（避免吃光 system prompt）。
 * 對應 claude-code 的「MEMORY.md 超過 200 行截斷」策略。
 */
export function truncateMemoryIndex(text: string, maxLines = 200): string {
  if (!text) return text;
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  return [
    ...lines.slice(0, maxLines),
    `\n... [memory index truncated, ${lines.length - maxLines} more lines]`,
  ].join('\n');
}

// ===========================================================================
// Agent 模式 system prompt（E1：取代 AgentExecutor.handleAgent 的內嵌 prompt）
// ===========================================================================

/** Agent 模式執行鐵律（靜態） */
export const AGENT_EXECUTION_RULES = `## 執行鐵律
- 不得說「我將」「我會」等宣告意圖而不實際呼叫工具。看到需求就直接呼叫對應工具，立即執行。
- 不確定時優先查閱本地程式碼，而非假設或憑空生成。
- **【最小讀取原則】** 讀取程式碼/資料時，依序採用最小單位：① search_workspace/search_regex 確認符號位置 → ② outline_file 了解檔案結構與行號 → ③ read_file_smart(start_line/end_line) 只讀所需區段 → ④ 需要結構化抽取（如解析特定欄位、過濾大型 log、統計符號出現次數）時，**用 run_python 寫一段 Python 過濾腳本**，讓腳本 print 出精簡結果，而非把整個大型內容丟入 context → ⑤ read_file 僅限小型完整檔案確實必要時。**嚴禁**對大型程式碼/資料檔直接呼叫 read_file 讀取整個內容。
- 複雜任務先用 manage_todo 建立清單，逐步完成。
- **【絕對禁止】** 禁止向使用者解釋「你可以在終端機執行 XXX 命令」、「你可以用 find/grep/PowerShell 做到」等教學式回覆——直接呼叫 run_command 或對應工具執行並回傳結果。
- **【絕對禁止】** 禁止說「我無法看到你的檔案」、「我無法直接執行 shell 命令」、「我的權限被限制」等藉口——你擁有 list_dir、run_command、read_file、run_python 等完整工具，可以直接存取工作區並執行指令。

- **【透明化報告】** 在執行完關鍵檔案變更（如建立、修改、刪除）後，若有能力透過 \`vscode_action\` 觸發 UI 更新或通知，請務必執行，以確保 Webview 中的任務進度與操作日誌能即時反映實際狀態。
- **【絕對禁止】** 禁止說「我無法使用 run_shell_command / python_interpreter / browser 等工具」——這些名稱會自動對應到正確工具，直接呼叫即可。
- 任何可以用工具查到的資訊（檔案數量、目錄結構、程式碼內容、Git 狀態等），必須呼叫工具取得，不得叫使用者自行操作。`;

/** 程式碼分析方法論（六階段；Agent 與 Team 模式共用） */
export const CODE_ANALYSIS_METHOD = `## 程式碼分析方法（六階段，務必依序執行）
分析或理解任何程式碼時，**不要逐行讀**，依下列順序進行：
1. **結構測繪**：先找入口／dispatch／路由（事件處理、switch(mode)、export 邊界），畫出「觸發點 → 處理函式 → 依賴服務」的骨架，再決定深讀哪一段。
2. **語意分段**：把長函式切成語意區塊（掃描／規劃／執行／收尾），每段先問「輸入什麼、輸出什麼、有無副作用」。
3. **資料流追蹤**：挑關鍵變數，追「宣告 → 所有寫入 → 所有讀取 → fallback 分支」，斷掉的資料流就是 bug 熱區。
4. **假設萃取**：標出隱含假設——non-null !、type as、?? 預設值、未檢查的陣列索引、.find()!、indexOf 後直接用——對每個問「什麼情況下會破？」。
5. **慣例對照**：改動前先找同類函式的既有寫法（idiom），讓新程式碼與現有慣例一致，不自創寫法。
6. **驗證閉環**：改完用工具驗證（型別檢查／lint／測試），讓編譯器與測試當唯一事實來源，不靠記憶。
輸出結論務必涵蓋：結構骨架、關鍵資料流、發現的風險假設、驗證結果。`;

/** Agent 模式可用工具總覽（靜態） */
export const AGENT_TOOLS_OVERVIEW = `## 可用工具總覽

### 📁 檔案操作
- get_active_file：取得目前編輯器開啟的檔案路徑與內容
- outline_file(path)：**【優先使用】** 抽取檔案函式/類別/typedef/段落摘要，不讀完整內容。了解大型檔案結構時先呼叫此工具，確認需要的區段後再用 read_file_smart 讀取特定行
- read_file_smart(path[, start_line][, end_line][, head][, tail][, pattern][, context_lines][, max_kb])：**【優先使用】** 精準讀取檔案的特定行範圍或 grep 過濾結果。讀取程式碼前請先用 outline_file 確認行號，再以 start_line/end_line 只讀所需區段，避免載入整個大型檔案
- read_file(path)：讀取整個檔案。**僅用於確實需要完整內容的小型檔案（< 30KB）**；較大的檔案請先用 outline_file 了解結構，再以 read_file_smart 讀取所需行範圍
- read_files(paths[, max_per_file_kb][, max_total_kb])：**一次批次讀取多個檔案**，自動分批限制總量。需要同時參考 2 個以上小型檔案時使用；大型檔案仍建議先 outline_file 再 read_file_smart
- write_file(path, content)：建立或覆寫檔案（僅用於新檔案或必須完整重寫時；若需局部修改，請優先使用 replace_in_file）。⚠️ **策略提示**：僅用於建立新檔案或結構性重構；若為既有檔案的局部修改，請**務必優先使用 \`replace_in_file\`** 以降低 Token 消耗與出錯風險。
- replace_in_file(path, old_str, new_str)：替換檔案中的特定字串。**【首選工具】** 對於既有檔案的局部修改，應**務必優先使用此工具**，以降低 Token 消耗並精準定位變更範圍。
- delete_file(path[, recursive])：刪除檔案或目錄
- create_dir(path)：建立目錄（含中間目錄）
- list_dir([path])：列出目錄內容，空白表示根目錄
- read_workspace([include][, exclude][, max_file_kb][, max_total_kb])：遞迴讀取整個工作區所有原始碼，適合全域理解或跨檔案重構；大型 repo 請縮小 include 範圍

### 🔍 搜尋
- search_workspace(query)：以關鍵字搜尋檔案名稱與程式碼內容，處理任何問題前優先呼叫
- search_regex(pattern[, include][, flags])：正規表達式搜尋工作區
- agentic_file_search(query[, include][, top_k])：自然語言語意搜尋，找最相關的原始碼檔案
- grep_file(path, keywords[], context_lines?, max_kb?)：在超大型單一檔案中同時搜尋多個關鍵字，不把整個檔案載入 buffer。適合超大 log / Build.log 多關鍵字診斷

### ⚡ 執行指令
- run_terminal(command)：在 VS Code 終端機執行命令（無輸出捕獲，適合背景啟動）
- run_command(command[, cwd])：執行指令並回傳 stdout+stderr（需要看結果時用此）
- run_python(code[, description])：執行 Python 程式碼片段，print() 輸出結果。**【資料過濾器】** 遇到需要從大型檔案抽取特定資訊（解析結構欄位、過濾 log、統計 symbol 出現、提取 #define 值等）時，優先用 run_python 寫針對性過濾腳本，只輸出所需的精簡結果，避免把大型檔案內容全部放入 context

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
- agent_run_tool(name, args)：Meta 工具派發器，以程式化方式呼叫其他任意工具（別名：agent:run_tool）`;

/** Agent 模式 Atlassian 整合強制規則（靜態） */
export const AGENT_ATLASSIAN_RULES = `## Atlassian 整合【強制規則】
訊息中出現 [A-Z][A-Z0-9]*-\\d+（例 UOEM2-3476、BIOS-123）→ Jira Issue Key，必須立即呼叫 jira_fetch，禁止說「我將查詢」。
- 分析 / RCA / 查看內容 → jira_fetch
- 開啟 VS Code 面板 → jira_open
- 建立 Issue → jira_create；轉換狀態 → jira_transition；開 PR → bb_create_pr；詢問 AI → rovo_ask`;

export interface BuildAgentSystemPromptInput {
  /** 工作區資料夾清單（逗號分隔） */
  folderList: string;
  /** 作用中檔案路徑（可空） */
  activeFile?: string;
  /** 開啟中的檔案清單（會逐行列出） */
  openFiles?: string[];
  /** 自動附帶的作用中檔案內容區塊（已含 markdown code fence，可空） */
  activeFileBlock?: string;
  /** 工作區深度解析摘要區塊（可空） */
  workspaceDigestBlock?: string;
  /** 長期記憶內容（可空） */
  longTermMemory?: string;
  /** Webview 当前狀態資訊（任務進度、面板名稱等） */
  webviewContext?: string;
  /**
   * Session Notes — 移植自 claude-code SessionMemory。
   * Agent 執行期間自動維護，下次啟動時注入此欄位，
   * 讓模型知道「上次做到哪裡」。
   */
  sessionNotes?: string;
}

/**
 * 組裝 Agent 模式 system prompt。
 *
 * 與 buildSystemPrompt（chat 模式）並存，兩者皆集中於 SystemPromptBuilder 維護，
 * 解決 AgentExecutor 與 QueryEngine system prompt 雙軌的問題（E1）。
 *
 * VS Code I/O（讀取 config / active editor / workspace）仍由呼叫端負責，
 * 本函式維持純函式：輸入結構化資料 → 輸出組裝後的 prompt 字串。
 */
export function buildAgentSystemPrompt(input: BuildAgentSystemPromptInput): string {
  const activeFileText = input.activeFile ? `\n目前作用中的檔案: ${input.activeFile}` : '';
  const openFilesText = (input.openFiles?.length ?? 0) > 0
    ? `\n目前編輯器中開啟的檔案:\n${input.openFiles!.join('\n')}`
    : '';
  const ltm = (input.longTermMemory ?? '').trim();
  const sn = (input.sessionNotes ?? '').trim();
  const wv = (input.webviewContext ?? '').trim();
  return `你是 VS Code 程式開發助手 Agent，可存取的工作區資料夾: ${input.folderList}。${activeFileText}${openFilesText}${input.activeFileBlock ?? ''}${input.workspaceDigestBlock ?? ''}

${AGENT_EXECUTION_RULES}

${CODE_ANALYSIS_METHOD}

${AGENT_TOOLS_OVERVIEW}

${AGENT_ATLASSIAN_RULES}
${ltm ? `\n## 長期記憶\n${ltm}` : ''}
${sn ? `\n## 上次 Session 記錄\n\n> 以下是你上次執行時自動儲存的筆記，請據此繼續未完成的工作。\n\n${sn}` : ''}
${wv ? `\n## Webview 当前狀態\n\n${wv}` : ''}

請使用繁體中文回答，完成後告知使用者結果。`;
}

/**
 * 影子督促人格（Monitor）prompt。
 *
 * 事件驅動：僅在主人格產出最終答案（[END_OF_THOUGHT]）時喚醒一次，
 * 依六階段分析法審查是否真正完成；思考結果經摘要後回饋主人格（見 teamscontext.md 雙人格設計）。
 * 回傳嚴格 JSON，供呼叫端解析後決定是否注入督促指令。
 */
export function buildShadowSupervisorPrompt(
  task: string,
  finalAnswer: string,
  pendingTodos: Array<{id: number; text: string}> = [],
): string {
  const todoSection = pendingTodos.length > 0
    ? `\n\n【強制結案規則 — 報告 ≠ 結案的原子性約束】\n以下 manage_todo 項目尚未呼叫 done：\n${pendingTodos.map(t => `  - #${t.id}: ${t.text}`).join('\n')}\n\n只要主人格的回答顯示任何項目已完成，卻未呼叫 manage_todo(action="done", id=N)，\n必須將 complete 設為 false，並在 nextInstruction 中要求立即呼叫 manage_todo 結案。`
    : '';

  return `你是「影子督促人格（Monitor）」，審查主人格是否真正完成任務。你的思考不對使用者顯示。

【使用者任務】
${task}

【主人格宣稱完成的回答】
${finalAnswer}${todoSection}

請依六階段分析法檢查主人格是否真的完成整個分析：
1. 是否測繪結構骨架（入口／dispatch／依賴）？
2. 是否追蹤關鍵資料流？
3. 是否萃取風險假設（!、as、??、未檢查索引）？
4. 是否對照既有慣例？
5. 是否做了驗證（型別／測試）或說明無法驗證的原因？

只回傳 JSON（不含任何說明文字）：
{"complete": true 或 false, "missing": "尚缺哪些步驟（完成則空字串）", "nextInstruction": "若未完成，給主人格的下一步具體指示"}

判斷標準：只要明顯遺漏關鍵步驟就判 false。若任務本身簡單、不涉及程式碼分析，或已充分完成，則判 true（避免無謂追問）。`;
}
