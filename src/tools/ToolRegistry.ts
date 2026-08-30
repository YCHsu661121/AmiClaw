// Copyright (c) 2026 YCHsu. All rights reserved.
// Licensed under the MIT License.
//
// Tool registry：對外暴露 LLM 可用的 function-calling 工具清單，
// 以及顯示用的 icon / title 格式化函式。純資料模組，無副作用、無 vscode 依賴。
import * as path from 'path';

// ── Core tool names — always sent to LLM on every request ────────────────────
// 27 tools: matches claude-code CORE scope (read/write/search/git/memory/lsp/meta)
const CORE_TOOL_NAMES = new Set([
  // file I/O (primary)
  'get_active_file','read_file','read_files','read_file_smart','write_file',
  'replace_in_file','insert_in_file',
  // navigation & search
  'list_dir','outline_file','search_workspace','search_regex','agentic_file_search',
  // execution
  'run_command','run_python',
  // git
  'git_status','git_diff','git_log','git_commit',
  // project management
  'manage_todo','memory_read','memory_write',
  'jira_fetch','jira_search','jira_open',
  // LSP (diagnostics always-on; definition/references on demand via search_tools)
  'lsp_diagnostics',
  // meta-tools
  'search_tools','workflow_run',
]);

// ── search_tools — lets the model discover and unlock extra tools ─────────────
const SEARCH_TOOLS_TOOL = { type: 'function', function: { name: 'search_tools', description: 'Search for additional tools by capability keyword. Returns matching tool definitions that will be available for this turn.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'What capability you need, e.g. "browser automation", "git commit", "jira transition", "diff files"' }, top_k: { type: 'number', description: 'Max tools to return (default 5)' } }, required: ['query'] } } };

// ── workflow_run — execute a saved workflow ───────────────────────────────────
const WORKFLOW_RUN_TOOL = { type: 'function', function: { name: 'workflow_run', description: 'Execute a saved named workflow (sequence of agent tasks). Use workflow_list first to see available workflows.', parameters: { type: 'object', properties: { name: { type: 'string', description: 'Workflow name to run' } }, required: ['name'] } } };
const WORKFLOW_LIST_TOOL = { type: 'function', function: { name: 'workflow_list', description: 'List all saved workflows with their descriptions and step counts.', parameters: { type: 'object', properties: {} } } };

/** Worker completion report — sent back to Coordinator as the only visible output. */
export const REPORT_RESULT_TOOL = {
  type: 'function',
  function: {
    name: 'report_result',
    description: 'Report task completion to the Coordinator. **Call this ONCE when all work is done.** The Coordinator sees ONLY this summary — not your raw tool outputs. Keep summary ≤500 chars.',
    parameters: {
      type: 'object',
      properties: {
        status:        { type: 'string', enum: ['completed', 'failed', 'blocked'], description: 'Task outcome: completed=done; failed=could not finish; blocked=needs more info' },
        summary:       { type: 'string', description: '任務完成摘要（≤500 字）：做了什麼、結果如何、關鍵發現' },
        files_changed: { type: 'array', items: { type: 'string' }, description: '已修改或建立的檔案路徑清單（可選）' },
        errors:        { type: 'string', description: '遭遇的錯誤描述（status=failed/blocked 時填寫，可選）' },
      },
      required: ['status', 'summary'],
    },
  },
};

export const AGENT_TOOLS = [
  { type: 'function', function: { name: 'get_active_file', description: '取得目前 VS Code 編輯器作用中的檔案路徑與完整內容。適合快速存取正在編輯的程式碼。', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'read_file', description: '讀取工作區檔案完整內容。**小型檔案首選（< 30 KB）**；超過 30 KB 請改用 outline_file 了解結構後再用 read_file_smart 分段讀取。Log/trace 檔案自動切換為錯誤優先策略（顯示錯誤點 + 尾端）。', parameters: { type: 'object', properties: { path: { type: 'string', description: '相對或絕對路徑' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'read_files', description: '批次讀取多個檔案。**需同時參考數個相關檔案時優先用此工具**，比多次 read_file 省時。每個檔案以 `=== <path> ===` 分隔。最多 30 個檔案。', parameters: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' }, description: '檔案路徑陣列，最多 30 個' }, max_per_file_kb: { type: 'number', description: '單檔上限 KB（預設 64）' }, max_total_kb: { type: 'number', description: '合計上限 KB（預設 256）' } }, required: ['paths'] } } },
  { type: 'function', function: { name: 'write_file', description: '建立或完全覆寫檔案。**會寫入整個 content，請確保 content 是完整的檔案內容**。局部修改請用 replace_in_file，它更安全且省 token。寫入前系統會偵測外部修改衝突。', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string', description: '完整的新檔案內容（非差異，是全文）' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'replace_in_file', description: '以 old_str → new_str 精準替換檔案中的一段文字。**這是修改現有檔案的首選方法**。重要規則：① old_str 必須在檔案中唯一——如有多處相符會被拒絕，請加入更多前後 context；② 使用前必須先 read_file 確認確切內容（系統會偵測衝突）；③ old_str 找不到時回傳含行號提示。', parameters: { type: 'object', properties: { path: { type: 'string' }, old_str: { type: 'string', description: '要替換的原始字串（必須在檔案中唯一，包含足夠前後 context）' }, new_str: { type: 'string', description: '替換後的字串（空字串 = 刪除）' } }, required: ['path', 'old_str', 'new_str'] } } },
  { type: 'function', function: { name: 'insert_in_file', description: '在指定行號後插入多行內容。適合插入新函式、新段落，或在任何精確位置新增程式碼。自動保留原始行尾（CRLF/LF）。', parameters: { type: 'object', properties: { path: { type: 'string', description: '檔案路徑' }, line: { type: 'number', description: '在此行號後插入（1-based；0 = 最前面）' }, content: { type: 'string', description: '要插入的內容（支援 \\n 多行）' } }, required: ['path', 'line', 'content'] } } },
  { type: 'function', function: { name: 'list_dir', description: '列出目錄內容（子目錄和檔案）。探索不熟悉的工作區結構時首選。', parameters: { type: 'object', properties: { path: { type: 'string', description: '目錄路徑，空白 = 工作區根目錄' } }, required: [] } } },
  { type: 'function', function: { name: 'run_terminal', description: '在 VS Code 整合終端機中執行命令（**不捕獲輸出**）。適合長時間執行的背景程序。需要看輸出結果請改用 run_command。', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'search_workspace', description: '在工作區搜尋符號、檔案名稱或程式碼關鍵字。**開始任何程式碼任務前請先呼叫此工具確認現有程式碼位置**。比 search_regex 快，適合關鍵字定位；需要正規表達式時改用 search_regex。', parameters: { type: 'object', properties: { query: { type: 'string', description: '關鍵字（檔案名稱、函式名稱、類別名稱、變數名稱）' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'delete_file', description: '永久刪除檔案或目錄。此操作**不可逆**，執行前系統會要求確認。', parameters: { type: 'object', properties: { path: { type: 'string' }, recursive: { type: 'boolean', description: '遞迴刪除目錄（預設 false）' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'create_dir', description: '建立目錄及所有中間目錄（等同 mkdir -p）。', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'run_command', description: '執行 shell 命令並**同步回傳 stdout+stderr**（最多等 30 秒）。適合需要看執行結果的場合（編譯、測試、git 操作等）。系統會自動阻擋危險命令（rm -rf /、curl|bash 等）。長時間命令請用 run_terminal。', parameters: { type: 'object', properties: { command: { type: 'string', description: '要執行的命令' }, cwd: { type: 'string', description: '執行目錄（可選，預設工作區根目錄）' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'fetch_url', description: '下載網頁並**自動去除 HTML 標籤**回傳純文字。適合讀取文件、API 規格、搜尋結果。需要 JavaScript 渲染的 SPA 頁面請改用 browser_navigate。', parameters: { type: 'object', properties: { url: { type: 'string', description: '完整 HTTP/HTTPS URL' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'open_browser', description: '在 VS Code 內建簡易瀏覽器開啟 URL（供人工檢視，不回傳內容）。', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'manage_todo', description: '管理 Agent 的任務清單。**收到複雜任務時請先用 add 建立清單，每完成一步用 done 標記**，讓使用者可以看到進度。', parameters: { type: 'object', properties: { action: { type: 'string', enum: ['add','done','list','clear'], description: 'add=新增, done=完成, list=查看, clear=清空' }, text: { type: 'string', description: '任務內容（action=add 時必填）' }, id: { type: 'number', description: '任務 ID（action=done 時必填）' } }, required: ['action'] } } },
  { type: 'function', function: { name: 'vscode_action', description: 'VS Code IDE 操作：開啟檔案到指定行、查詢工作區資訊、顯示通知訊息、執行 VS Code 內建指令。', parameters: { type: 'object', properties: { action: { type: 'string', enum: ['open_file','get_workspace_info','show_notification','run_command'] }, path: { type: 'string', description: 'open_file 用的路徑' }, line: { type: 'number', description: '行號（open_file）' }, message: { type: 'string', description: 'show_notification 的訊息' }, command: { type: 'string', description: 'VS Code 內建指令 ID（run_command）' }, args: { type: 'array', items: { type: 'string' }, description: '指令參數' } }, required: ['action'] } } },
  { type: 'function', function: { name: 'jira_search', description: 'JQL 搜尋 Jira Issues。適合列出待辦清單、按專案/狀態篩選。例：`assignee = currentUser() AND status != Done ORDER BY updated DESC`。', parameters: { type: 'object', properties: { jql: { type: 'string', description: 'JQL 語句（優先使用）' }, assignee: { type: 'string', description: '指派人（可選，自動組 JQL）' }, reporter: { type: 'string', description: '建立人（可選）' }, project: { type: 'string', description: '專案 Key，例如 BIOS、UOEM2（可選）' }, status: { type: 'string', description: '狀態篩選（可選）' }, text: { type: 'string', description: '全文關鍵字（可選）' }, max_results: { type: 'number', description: '最多筆數（預設 20）' } }, required: [] } } },
  { type: 'function', function: { name: 'jira_fetch', description: '**【看到 Jira Key 立刻呼叫，禁止說「我將查詢」】** 直接取得 Issue 完整詳情：Summary、Description、Status、Assignee、Priority、最近留言、附件清單。', parameters: { type: 'object', properties: { issue_key: { type: 'string', description: 'Jira Issue Key，例如 UOEM2-3476' } }, required: ['issue_key'] } } },
  { type: 'function', function: { name: 'jira_attachment_download', description: '下載 Jira 附件（URL 來自 jira_fetch 結果）。ZIP 自動解壓並列出內容；文字/patch/log 直接顯示。', parameters: { type: 'object', properties: { url: { type: 'string', description: '附件下載 URL（來自 jira_fetch 附件清單）' }, filename: { type: 'string', description: '儲存檔名（可選）' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'jira_open', description: '在 VS Code 中開啟 Jira Issue UI 面板（不回傳內容，純介面操作）。需要 Issue 內容供分析時請用 jira_fetch 而非此工具。', parameters: { type: 'object', properties: { issue_key: { type: 'string', description: 'Jira Issue Key，例如 BIOS-123 或 PROJ-456' } }, required: ['issue_key'] } } },
  { type: 'function', function: { name: 'jira_log_time', description: '記錄 Jira Issue 工時（Worklog）。支援 "16h"、"2h 30m"、"1d" 等格式，可指定日期（today/yesterday/YYYY-MM-DD），預設今天。', parameters: { type: 'object', properties: { issue_key: { type: 'string', description: 'Jira Issue Key，例如 BIOS-123' }, time_spent: { type: 'string', description: '工時，例如 "16h"、"2h 30m"、"1d"、"90m"' }, date: { type: 'string', description: '日期（可選）："today"（預設）、"yesterday"、或 "YYYY-MM-DD"' }, comment: { type: 'string', description: '備註（可選）' } }, required: ['issue_key', 'time_spent'] } } },
  { type: 'function', function: { name: 'jira_create', description: '開啟 Jira 建立 Issue 面板（需要安裝 Atlassian 插件）', parameters: { type: 'object', properties: { summary: { type: 'string', description: 'Issue 標題（可選，預填）' }, description: { type: 'string', description: 'Issue 詳細描述（可選，預填）' } } } } },
  { type: 'function', function: { name: 'jira_transition', description: '開啟 Jira Issue 狀態轉換面板（如 TODO → IN PROGRESS → DONE）', parameters: { type: 'object', properties: { issue_key: { type: 'string', description: 'Jira Issue Key' } }, required: ['issue_key'] } } },
  { type: 'function', function: { name: 'bb_create_pr', description: '開啟 Bitbucket 建立 Pull Request 面板（需要安裝 Atlassian 插件）', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'rovo_ask', description: '向 Atlassian Rovo Dev AI 提問並回傳回覆（需要 Rovo Dev 本地 server 正在執行）。可查詢 Jira/Confluence 知識庫、RCA 分析等。若 Rovo Dev 未執行則退化為開啟面板。', parameters: { type: 'object', properties: { question: { type: 'string', description: '要問 Rovo Dev 的問題' } }, required: ['question'] } } },
  { type: 'function', function: { name: 'run_python', description: '執行一段 Python 程式碼並回傳 stdout+stderr。支援所有 Python 標準模組（os、shutil、pathlib、re 等），可進行資料處理、數學計算、檔案操作等。程式碼中使用 print() 輸出結果。若需要寫入或刪除檔案，會先向使用者確認。【資料過濾器】當需要從大型檔案中抽取特定資訊（解析欄位、過濾 log 行、統計 symbol 出現次數、提取 #define 值等）時，優先用此工具寫針對性過濾腳本，只 print 所需精簡結果，避免把大型檔案內容全部放入 context。', parameters: { type: 'object', properties: { code: { type: 'string', description: '要執行的 Python 程式碼（多行字串，支援 import）' }, description: { type: 'string', description: '一行說明這段程式碼的用途（顯示在步驟列）' } }, required: ['code'] } } },
  { type: 'function', function: { name: 'git_status', description: '取得工作區 Git 狀態（modified/staged/untracked 檔案列表）', parameters: { type: 'object', properties: { path: { type: 'string', description: '工作區路徑（可選，預設工作區根目錄）' } }, required: [] } } },
  { type: 'function', function: { name: 'git_diff', description: '取得 Git diff（工作區變更或 staged 變更）', parameters: { type: 'object', properties: { file: { type: 'string', description: '指定檔案路徑（可選，空白表示全部）' }, staged: { type: 'boolean', description: '是否顯示 staged diff（預設 false）' } }, required: [] } } },
  { type: 'function', function: { name: 'git_log', description: '取得 Git commit 歷史（oneline 格式）', parameters: { type: 'object', properties: { count: { type: 'number', description: '回傳筆數（預設 20，最多 100）' }, file: { type: 'string', description: '指定檔案的 commit 歷史（可選）' } }, required: [] } } },
  { type: 'function', function: { name: 'git_commit', description: '建立 Git commit（預設 git add -A 後 commit，需使用者確認）', parameters: { type: 'object', properties: { message: { type: 'string', description: 'Commit 訊息' }, add_all: { type: 'boolean', description: '是否 git add -A（預設 true）' } }, required: ['message'] } } },
  { type: 'function', function: { name: 'http_request', description: '發送 HTTP 請求（GET/POST/PUT/DELETE/PATCH）並回傳回應內容。適合呼叫 REST API、切換 Webhook、測試端點。非 GET 請求需使用者確認。', parameters: { type: 'object', properties: { method: { type: 'string', enum: ['GET','POST','PUT','DELETE','PATCH','HEAD'], description: 'HTTP 方法（預設 GET）' }, url: { type: 'string', description: '完整 HTTP/HTTPS URL' }, headers: { type: 'object', description: '自訂請求標頭（可選）', additionalProperties: { type: 'string' } }, body: { type: 'string', description: '請求本文（POST/PUT 用，JSON 字串或純文字）' }, timeout: { type: 'number', description: '超時毫秒（預設 15000）' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'db_query', description: '對 SQLite 資料庫執行 SQL 查詢（SELECT/INSERT/UPDATE/DELETE）並回傳結果表格。寫入操作需使用者確認。', parameters: { type: 'object', properties: { db_path: { type: 'string', description: 'SQLite 資料庫檔案路徑（.db 檔）' }, query: { type: 'string', description: '要執行的 SQL 語句' }, params: { type: 'array', items: {}, description: 'SQL 參數（防止 SQL injection，? 佔位符對應）' } }, required: ['db_path', 'query'] } } },
  { type: 'function', function: { name: 'search_regex', description: '使用正規表達式在工作區搜尋檔案內容。支援 glob 檔案樣式、大小寫、multiline 等 flag。', parameters: { type: 'object', properties: { pattern: { type: 'string', description: 'JavaScript 正規表達式字串（不包括 //）' }, include: { type: 'string', description: 'glob 檔案樣式（預設 **/*），如 **/*.ts' }, flags: { type: 'string', description: 'regex flags（預設 i，可用 g/i/m）' } }, required: ['pattern'] } } },
  { type: 'function', function: { name: 'agentic_file_search', description: '智慧語意搜尋：根據自然語言描述找出最相關的原始碼檔案，並回傳每個檔案的函式/類別/介面/匯出宣告摘要。適合「找處理 authentication 的檔案」、「哪個檔案負責 WebSocket 連線」等情況，比 search_workspace 更能理解功能意圖。支援 UEFI 原始碼（.c .h .inf .dec .dsc .fdf .uni .nasm .asm .asl）。', parameters: { type: 'object', properties: { query: { type: 'string', description: '用自然語言描述你要找的功能或責任，例如「處理使用者登入的邏輯」或「UEFI HII protocol 初始化」' }, include: { type: 'string', description: 'glob 檔案樣式（預設 **/*.{ts,js,tsx,jsx,py,cs,java,go,rs,cpp,c,h,inf,dec,dsc,fdf,uni,nasm,asm,asl}）' }, top_k: { type: 'number', description: '回傳最相關的前 N 個檔案（預設 10，最多 30）' } }, required: ['query'] } } },
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
  { type: 'function', function: { name: 'jenkins_build', description: '觸發 Jenkins 建置。預設透過 VS Code 外掛指令（VisualeBios，避免 DNS/網域問題）；若關閉 amiAiClaw.jenkinsUseVscodeCommand 則改走 Jenkins HTTP API（依設定自動取得 CSRF Crumb）。可透過 tools_dir / tools_version 切換 VisualeBios 的 Tools 目錄。', parameters: { type: 'object', properties: { mode: { type: 'string', enum: ['build', 'rebuild'], description: '使用 VS Code 外掛指令時選擇 build 或 rebuild（預設 build）' }, tools_dir: { type: 'string', description: '（VS Code 模式）指定 VisualeBios 的 Tools 目錄絕對路徑，例如 C:\\\\AmiTools\\\\VebTools\\\\Tools60。觸發 Build 前會先寫入 visualebios.toolsDir 設定。' }, tools_version: { type: 'string', description: '（VS Code 模式）只給 Tools 版本號（如 "59"、"60"），自動組成 C:\\\\AmiTools\\\\VebTools\\\\Tools<N>。tools_dir 已指定時會被忽略。' }, tools_scope: { type: 'string', enum: ['workspace', 'global'], description: '（VS Code 模式）寫入 visualebios.toolsDir 的範圍，預設 workspace（只影響當前工作區）。' }, job: { type: 'string', description: '（HTTP 模式）Jenkins Job 名稱（預設使用 amiAiClaw.jenkinsDefaultJob，未設定則 SeamlessBuild）' }, params: { type: 'object', description: '（HTTP 模式）Build 參數（key-value，可選），有參數自動使用 buildWithParameters 端點', additionalProperties: { type: 'string' } }, wait: { type: 'boolean', description: '（HTTP 模式）是否等待 Job 開始建置並回傳編號/狀態（預設 true，最多等待 60s）' } }, required: [] } } },
  { type: 'function', function: { name: 'jenkins_status', description: '查詢 Jenkins 狀態。預設透過 VS Code 外掛指令（VisualeBios 顯示建置歷史）；若關閉 amiAiClaw.jenkinsUseVscodeCommand 則改走 Jenkins HTTP API。', parameters: { type: 'object', properties: { job: { type: 'string', description: 'Jenkins Job 名稱（預設使用 amiAiClaw.jenkinsDefaultJob）' }, build_number: { type: 'number', description: 'Build 編號（可選，預設 lastBuild）' }, include_log: { type: 'boolean', description: '是否包含 Console 輸出（預設 true）' }, log_lines: { type: 'number', description: 'Console 輸出最後幾行（預設 100，最大 500）' } }, required: [] } } },
  { type: 'function', function: { name: 'read_file_smart', description: '分區讀取大型檔案（不限大小）。支援：grep 過濾（pattern）、行範圍（start_line/end_line）、頭 N 行（head）、尾 N 行（tail）、前後 context（context_lines）。適合分析 Build.log、大型 log 檔案、尋找特定錯誤行。', parameters: { type: 'object', properties: { path: { type: 'string', description: '檔案路徑（絕對或相對工作區根目錄）' }, pattern: { type: 'string', description: 'JavaScript regex，只回傳匹配行（不填回傳全部）。例："error|failed|warning"' }, start_line: { type: 'number', description: '從第幾行開始讀（1-based，選用）' }, end_line: { type: 'number', description: '讀到第幾行（選用）' }, head: { type: 'number', description: '只回傳前 N 行（選用）' }, tail: { type: 'number', description: '只回傳最後 N 行（選用）' }, context_lines: { type: 'number', description: '每個匹配行附帶前後 N 行的 context（預設 0）' }, max_kb: { type: 'number', description: '輸出上限 KB（預設 128，最大 512）' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'grep_file', description: '在超大型單一檔案中同時搜尋多個關鍵字，不把整個檔案載入 buffer。每個關鍵字各自分組回傳（match 數量、行號、檔案位置百分比、前後 context）；重疊的 context 自動合併去重；達到輸出上限時截斷各組而非整體截斷。適合 log、Build.log、tracefile 等超大檔案的多關鍵字診斷。', parameters: { type: 'object', properties: { path: { type: 'string', description: '檔案路徑（絕對或相對工作區根目錄）' }, keywords: { type: 'array', items: { type: 'string' }, description: '關鍵字陣列（字串或 JS regex 字串），每個都會獨立搜尋並分組顯示。例：["error","fatal","undefined reference"]' }, context_lines: { type: 'number', description: '每個匹配行前後附帶幾行 context（預設 3）' }, max_matches_per_kw: { type: 'number', description: '每個關鍵字最多顯示幾處匹配（預設 30）' }, max_kb: { type: 'number', description: '整體輸出上限 KB（預設 128，最大 512）' }, case_sensitive: { type: 'boolean', description: '區分大小寫（預設 false）' } }, required: ['path', 'keywords'] } } },
  { type: 'function', function: { name: 'read_workspace', description: '遞迴讀取整個工作區所有原始碼檔案內容，回傳每個檔案路徑與完整內容。適合需要全域理解程式庫結構、跨檔案重構、全域搜尋替換等任務。大型工作區請透過 include/exclude 縮小範圍以避免超出 token 上限。支援分批：以 offset 參數續讀剩餘檔案。預設包含 UEFI 原始碼（.c .h .inf .dec .dsc .fdf .uni .nasm .asm .asl）。', parameters: { type: 'object', properties: { include: { type: 'string', description: 'glob 檔案樣式（預設 **/*.{ts,js,tsx,jsx,py,cs,java,go,rs,cpp,c,h,inf,dec,dsc,fdf,uni,nasm,asm,asl,md,json,yaml,yml,txt}）' }, exclude: { type: 'string', description: '額外排除的 glob 樣式（逗號分隔，預設已排除 node_modules/.git/dist/out/build）' }, max_file_kb: { type: 'number', description: '單檔最大讀取 KB（預設 128，超過截斷）' }, max_total_kb: { type: 'number', description: '所有檔案合計最大 KB（預設 512，超過停止並回報剩餘檔案）' }, offset: { type: 'number', description: '從第幾個檔案開始讀取（用於續批，預設 0；上一批回傳的「offset=N→M」中的 M 即為下一批的 offset）' } }, required: [] } } },
  { type: 'function', function: { name: 'glob', description: '列出符合 glob 樣式的檔案（不讀內容）。支援 **/*.{c,h}、src/** 等樣式，艷不收發對外 .gitignore 排除。比 search_workspace 更快純列檔案。適合 UEFI 專案找 .inf .dec .h 等檔案。', parameters: { type: 'object', properties: { pattern: { type: 'string', description: 'Glob 樣式，例如 **/*.h、src/**/*.c、*.inf' }, root: { type: 'string', description: '搜尋根目錄（預設工作區根目錄）' }, limit: { type: 'number', description: '最多回傳檔案數（預設 200，最多 5000）' } }, required: ['pattern'] } } },
  { type: 'function', function: { name: 'outline_file', description: '快速抽取檔案函式/類別/typedef/段落摘要，不讀完整內容。.c/.h 檢測 EFIAPI 函式、typedef struct、#define；.inf/.dec/.dsc 檢測 [Section] 標題；.ts/.py 檢測 function/class/interface。適合在 read_file 前詞小了解檔案結構。', parameters: { type: 'object', properties: { path: { type: 'string', description: '檔案路徑（絕對或相對工作區）' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'todo_write', description: '在工作區 TODO.md 新增或完成 TODO 項目。高度相似 OpenHarness TodoWriteTool。checked=true 表示標記為已完成（[ ]→[x]）。', parameters: { type: 'object', properties: { item: { type: 'string', description: 'TODO 項目內容' }, checked: { type: 'boolean', description: '標記為已完成（預設 false）' }, path: { type: 'string', description: 'TODO 檔案路徑（預設 TODO.md）' } }, required: ['item'] } } },
  { type: 'function', function: { name: 'memory_read', description: '讀取工作區的 MEMORY.md 持久記憶檔案。假如對常需要記住的專案個人化設定、之前的討論結論、重要發現等，請先呼叫此工具。', parameters: { type: 'object', properties: { path: { type: 'string', description: '記憶檔案路徑（預設 MEMORY.md）' } }, required: [] } } },
  { type: 'function', function: { name: 'memory_write', description: '寫入或更新工作區的 MEMORY.md 持久記憶。支援 append（新增段落）、replace（全文替換）、delete（刪除段落）三種 action。高度相似 OpenHarness MemoryManager。', parameters: { type: 'object', properties: { title: { type: 'string', description: '記憶條目標題（## section 名稱）' }, content: { type: 'string', description: '記憶內容（Markdown）' }, action: { type: 'string', enum: ['append', 'replace', 'delete'], description: '操作類型（預設 append）' }, path: { type: 'string', description: '記憶檔案路徑（預設 MEMORY.md）' } }, required: ['title', 'content'] } } },
  { type: 'function', function: { name: 'rename_file', description: '重新命名或移動檔案/目錄。src→dest，可跨目錄。需要使用者確認。', parameters: { type: 'object', properties: { src: { type: 'string', description: '原始路徑（相對或絕對）' }, dest: { type: 'string', description: '目標路徑（相對或絕對）' }, overwrite: { type: 'boolean', description: '若目標已存在是否覆蓋（預設 false）' } }, required: ['src', 'dest'] } } },
  { type: 'function', function: { name: 'copy_file', description: '複製檔案到新位置。src→dest，不移除原始檔案。需要使用者確認。', parameters: { type: 'object', properties: { src: { type: 'string', description: '原始路徑（相對或絕對）' }, dest: { type: 'string', description: '目標路徑（相對或絕對）' }, overwrite: { type: 'boolean', description: '若目標已存在是否覆蓋（預設 false）' } }, required: ['src', 'dest'] } } },
  { type: 'function', function: { name: 'diff_files', description: '比較兩個檔案並回傳 unified diff。適合確認修改前後差異、比對兩個版本。', parameters: { type: 'object', properties: { a: { type: 'string', description: '第一個檔案路徑（原始）' }, b: { type: 'string', description: '第二個檔案路徑（修改後）' }, context: { type: 'number', description: '前後 context 行數（預設 3）' } }, required: ['a', 'b'] } } },
  { type: 'function', function: { name: 'replace_all_in_file', description: '取代檔案中所有符合的字串（replace_in_file 只換第一個）。適合批次修正同一個函式名稱/變數名稱。', parameters: { type: 'object', properties: { path: { type: 'string', description: '檔案路徑' }, old_str: { type: 'string', description: '要取代的原始字串' }, new_str: { type: 'string', description: '取代後的字串' } }, required: ['path', 'old_str', 'new_str'] } } },
  { type: 'function', function: { name: 'batch_replace', description: '使用正規表達式跨多個檔案批次搜尋取代，回傳修改的檔案清單與替換次數。適合全域重新命名 symbol 或修正 typo。', parameters: { type: 'object', properties: { pattern: { type: 'string', description: 'JavaScript 正規表達式字串（不含 //）' }, replace: { type: 'string', description: '取代字串（可用 $1 $2 back-reference）' }, include: { type: 'string', description: 'glob 篩選檔案（預設 **/*），例如 **/*.{c,h}' }, flags: { type: 'string', description: 'regex flags（預設 gi）' } }, required: ['pattern', 'replace'] } } },
  { type: 'function', function: { name: 'file_info', description: '取得檔案/目錄詳細資訊：大小、行數、行尾格式（CRLF/LF）、BOM/編碼偵測、最後修改時間。', parameters: { type: 'object', properties: { path: { type: 'string', description: '檔案路徑（相對或絕對）' } }, required: [] } } },
  { type: 'function', function: { name: 'organize_photos', description: '批次辨識並整理照片：給「一個照片目錄」（可遞迴含子目錄），用 Ollama 視覺模型逐張辨識。若提供「一張參考人臉照片」，會逐張判斷是否為同一個人，再辨識其行為/場景，將符合者依「人物/行為」兩層資料夾複製（或移動）到輸出目錄；未提供參考人臉時改為只依「行為/場景」分類。需要 Ollama 視覺模型（如 llava、llama3.2-vision、qwen2.5vl，需先 ollama pull）。', parameters: { type: 'object', properties: { source_dir: { type: 'string', description: '要掃描的照片來源目錄（遞迴含子目錄）' }, reference_image: { type: 'string', description: '參考人臉照片路徑（可選）。提供時依「人物/行為」兩層整理；未提供時只依行為/場景分類' }, output_dir: { type: 'string', description: '整理後輸出目錄（可選，預設為來源目錄下的 _organized）' }, person_name: { type: 'string', description: '人物資料夾名稱（可選，預設取參考照片檔名）' }, behaviors: { type: 'array', items: { type: 'string' }, description: '行為/場景分類選項（可選），例如 ["用餐","戶外","運動","工作"]；提供時模型只能從中擇一，未提供則由模型自由命名簡短標籤' }, vision_model: { type: 'string', description: 'Ollama 視覺模型名稱（可選，預設讀設定 amiAiClaw.visionModel）' }, mode: { type: 'string', enum: ['copy','move'], description: 'copy=複製並保留原檔（預設）、move=移動原檔' }, min_confidence: { type: 'number', description: '人物比對最低信心 0~100（預設 60，僅在有 reference_image 時生效）' }, max_images: { type: 'number', description: '最多處理張數（預設 200，最多 1000）' } }, required: ['source_dir'] } } },
  // ── Background execution tools ─────────────────────────────────────────
  { type: 'function', function: { name: 'run_in_background', description: '在背景執行 shell 命令（非同步，不等待完成）。立刻回傳 taskId 和輸出檔案路徑。**適合長時間執行的命令**（建置、測試、伺服器啟動等）；需要查看輸出時用 bg_task_status 或 bg_task_read。', parameters: { type: 'object', properties: { command: { type: 'string', description: '要執行的 shell 命令' }, cwd: { type: 'string', description: '執行目錄（可選，預設工作區根目錄）' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'bg_task_status', description: '查詢背景任務狀態與輸出預覽（最後 80 行）。不傳 task_id 則列出所有任務。', parameters: { type: 'object', properties: { task_id: { type: 'string', description: '任務 ID（來自 run_in_background 回傳；省略則列出全部）' } }, required: [] } } },
  { type: 'function', function: { name: 'bg_task_read', description: '讀取背景任務的完整輸出（持久化到磁碟的日誌檔）。支援行範圍讀取，適合分析大型輸出。', parameters: { type: 'object', properties: { task_id: { type: 'string', description: '任務 ID' }, start_line: { type: 'number', description: '起始行（1-based，可選）' }, end_line: { type: 'number', description: '結束行（可選）' }, tail: { type: 'number', description: '只取最後 N 行（優先於 start/end_line）' } }, required: ['task_id'] } } },
  { type: 'function', function: { name: 'bg_task_kill', description: '終止指定的背景任務（發送 SIGTERM）。', parameters: { type: 'object', properties: { task_id: { type: 'string', description: '要終止的任務 ID' } }, required: ['task_id'] } } },
  // ── Computer Use tools ─────────────────────────────────────────────────
  { type: 'function', function: { name: 'computer_screenshot', description: '截取螢幕截圖並儲存為 PNG。需要 Python pyautogui（pip install pyautogui pillow）。截圖後可用 organize_photos 或 browser_screenshot 分析圖片內容。', parameters: { type: 'object', properties: { save_path: { type: 'string', description: '儲存路徑（可選，預設 .amiclaw/outputs/screenshot_<ts>.png）' }, region: { type: 'array', items: { type: 'number' }, description: '截取區域 [left, top, width, height]（可選，預設全螢幕）' } }, required: [] } } },
  { type: 'function', function: { name: 'computer_type', description: '在目前焦點位置輸入文字。優先使用剪貼板貼上（支援 Unicode）。需要 Python pyautogui（pip install pyautogui）。', parameters: { type: 'object', properties: { text: { type: 'string', description: '要輸入的文字' }, interval: { type: 'number', description: '每個字元間隔秒數（預設 0.02）' } }, required: ['text'] } } },
  { type: 'function', function: { name: 'computer_key', description: '按下按鍵或組合鍵。支援單鍵（"enter","esc","tab"）和組合鍵（"ctrl+s","alt+f4","ctrl+shift+t"）。需要 Python pyautogui。', parameters: { type: 'object', properties: { key: { type: 'string', description: '按鍵名稱，組合鍵用 + 連接，例如 "ctrl+s"、"enter"、"alt+tab"' } }, required: ['key'] } } },
  { type: 'function', function: { name: 'computer_click', description: '在指定螢幕坐標點擊滑鼠。需要 Python pyautogui。', parameters: { type: 'object', properties: { x: { type: 'number', description: '螢幕 X 坐標（像素）' }, y: { type: 'number', description: '螢幕 Y 坐標（像素）' }, button: { type: 'string', enum: ['left', 'right', 'middle'], description: '滑鼠按鍵（預設 left）' }, clicks: { type: 'number', description: '點擊次數（預設 1，雙擊傳 2）' } }, required: ['x', 'y'] } } },
  { type: 'function', function: { name: 'computer_scroll', description: '在指定坐標滾動滑鼠滾輪。需要 Python pyautogui。', parameters: { type: 'object', properties: { x: { type: 'number', description: '螢幕 X 坐標' }, y: { type: 'number', description: '螢幕 Y 坐標' }, direction: { type: 'string', enum: ['up', 'down'], description: '滾動方向（預設 down）' }, clicks: { type: 'number', description: '滾動格數（預設 3）' } }, required: ['x', 'y'] } } },
  { type: 'function', function: { name: 'computer_clipboard_read', description: '讀取系統剪貼板的文字內容。', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'computer_clipboard_write', description: '將文字寫入系統剪貼板。配合 computer_type 可快速貼入任何應用程式。', parameters: { type: 'object', properties: { text: { type: 'string', description: '要寫入剪貼板的文字' } }, required: ['text'] } } },
  // ── LSP tools ─────────────────────────────────────────────────────────────
  { type: 'function', function: { name: 'lsp_goto_definition', description: '跳至 symbol 定義位置（使用語言伺服器）。回傳定義所在的 file:line:col。適合追蹤函式/變數/型別宣告位置。需要目標語言的 VS Code 語言擴充（TypeScript/C/Python 等）已啟動。', parameters: { type: 'object', properties: { path: { type: 'string', description: '包含 symbol 的檔案路徑' }, line: { type: 'number', description: 'Symbol 所在行號（1-based）' }, col: { type: 'number', description: 'Symbol 所在欄號（1-based，預設 1）' } }, required: ['path', 'line'] } } },
  { type: 'function', function: { name: 'lsp_find_references', description: '找出 symbol 在整個工作區的所有參考位置（使用語言伺服器）。回傳 file:line:col 清單。適合重構前確認影響範圍，或找出哪些地方呼叫了此函式。', parameters: { type: 'object', properties: { path: { type: 'string', description: '包含 symbol 的檔案路徑' }, line: { type: 'number', description: 'Symbol 所在行號（1-based）' }, col: { type: 'number', description: 'Symbol 所在欄號（1-based，預設 1）' }, include_declaration: { type: 'boolean', description: '是否包含宣告位置（預設 true）' } }, required: ['path', 'line'] } } },
  { type: 'function', function: { name: 'lsp_hover', description: '取得 symbol 的 hover 資訊（型別簽名、JSDoc/Doxygen 文件、參數說明）。使用語言伺服器，等同於在 VS Code 中把滑鼠移到 symbol 上。適合快速確認函式簽名或型別定義。', parameters: { type: 'object', properties: { path: { type: 'string', description: '包含 symbol 的檔案路徑' }, line: { type: 'number', description: 'Symbol 所在行號（1-based）' }, col: { type: 'number', description: 'Symbol 所在欄號（1-based，預設 1）' } }, required: ['path', 'line'] } } },
  { type: 'function', function: { name: 'lsp_diagnostics', description: '取得語言伺服器的診斷資訊（錯誤/警告/提示）。**不指定 path 時回傳整個工作區所有診斷問題**；指定 path 時只回傳該檔案。適合確認編譯錯誤、型別錯誤、未使用 import 等問題。優先在 write_file/replace_in_file 之後呼叫此工具確認無錯誤。', parameters: { type: 'object', properties: { path: { type: 'string', description: '檔案路徑（可選，空白 = 全工作區）' }, severity: { type: 'string', enum: ['error', 'warning', 'all'], description: '過濾嚴重度（預設 all）' } }, required: [] } } },
  { type: 'function', function: { name: 'lsp_rename_symbol', description: '透過語言伺服器跨工作區重新命名 symbol（等同 VS Code F2 Rename）。會更新所有參考檔案，回傳修改的檔案清單。**比 batch_replace 更精準**（只改真正的 symbol 參考，不改字串常數或注解中的同名文字）。操作前需使用者確認。', parameters: { type: 'object', properties: { path: { type: 'string', description: '包含 symbol 的檔案路徑' }, line: { type: 'number', description: 'Symbol 所在行號（1-based）' }, col: { type: 'number', description: 'Symbol 所在欄號（1-based，預設 1）' }, new_name: { type: 'string', description: '新名稱' } }, required: ['path', 'line', 'new_name'] } } },
  { type: 'function', function: { name: 'lsp_document_symbols', description: '列出檔案中所有 symbol（函式、類別、介面、變數、enum 等）及其行號與層次結構。使用語言伺服器，比 outline_file 更精準（使用真正的語法分析）。適合快速了解大型檔案的 API surface 或確認類別成員。', parameters: { type: 'object', properties: { path: { type: 'string', description: '檔案路徑' } }, required: ['path'] } } },
];

// ── Derived exports ───────────────────────────────────────────────────────────
/** Tools always loaded in every agent request. */
export const CORE_TOOLS = (AGENT_TOOLS as { type: string; function: { name: string } }[])
  .filter(t => CORE_TOOL_NAMES.has(t.function.name));

/** Tools loaded on-demand via search_tools. */
export const EXTRA_TOOLS = (AGENT_TOOLS as { type: string; function: { name: string; description: string } }[])
  .filter(t => !CORE_TOOL_NAMES.has(t.function.name));

/** Full set including meta-tools (for execution dispatch). */
export const ALL_TOOLS = [...AGENT_TOOLS, SEARCH_TOOLS_TOOL, WORKFLOW_RUN_TOOL, WORKFLOW_LIST_TOOL];

/** LLM-facing toolset: core tools + meta-tools. */
export const LLM_TOOLS = [...CORE_TOOLS, SEARCH_TOOLS_TOOL, WORKFLOW_RUN_TOOL, WORKFLOW_LIST_TOOL];

// ── TF-IDF tool search ──────────────────────────────────────────────────────

function _tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(t => t.length > 1);
}

/** Smoothed IDF: log((N+1)/(df+1)) + 1, computed once at module load. */
const _idf: ReadonlyMap<string, number> = (() => {
  const N = EXTRA_TOOLS.length;
  const df = new Map<string, number>();
  for (const tool of EXTRA_TOOLS) {
    const terms = new Set(_tokenize(`${tool.function.name} ${tool.function.description}`));
    for (const t of terms) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const idf = new Map<string, number>();
  for (const [term, count] of df) idf.set(term, Math.log((N + 1) / (count + 1)) + 1);
  return idf;
})();

function _tfidfVec(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  const vec = new Map<string, number>();
  const len = tokens.length || 1;
  // unseen terms get IDF = log((N+1)/1)+1 ≈ high weight for novel query terms
  const unseenIdf = Math.log(EXTRA_TOOLS.length + 2) + 1;
  for (const [t, count] of tf) vec.set(t, (count / len) * (_idf.get(t) ?? unseenIdf));
  return vec;
}

function _cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0, normA = 0, normB = 0;
  for (const [t, v] of a) { dot += v * (b.get(t) ?? 0); normA += v * v; }
  for (const v of b.values()) normB += v * v;
  return normA === 0 || normB === 0 ? 0 : dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Pre-computed TF-IDF vectors for all EXTRA_TOOLS (avoids recompute per query). */
const _toolVecs: ReadonlyMap<string, Map<string, number>> = (() => {
  const m = new Map<string, Map<string, number>>();
  for (const tool of EXTRA_TOOLS) {
    m.set(tool.function.name, _tfidfVec(_tokenize(`${tool.function.name} ${tool.function.description}`)));
  }
  return m;
})();

/**
 * TF-IDF + cosine similarity search over EXTRA_TOOLS.
 * Returns up to topK tool definitions ranked by semantic relevance.
 */
export function searchExtraTools(query: string, topK = 5): typeof EXTRA_TOOLS {
  const queryTokens = _tokenize(query);
  if (queryTokens.length === 0) return EXTRA_TOOLS.slice(0, topK);
  const queryVec = _tfidfVec(queryTokens);
  const scored = EXTRA_TOOLS.map(tool => ({
    tool,
    score: _cosine(queryVec, _toolVecs.get(tool.function.name)!),
  }));
  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(s => s.tool);
}

export function getToolIcon(name: string): string {
  const m: Record<string, string> = { get_active_file: '📝', read_file: '📄', read_files: '📚', write_file: '💾', replace_in_file: '✏️', insert_in_file: '📌', glob: '📂', outline_file: '📑', todo_write: '✅', memory_read: '🧠', memory_write: '📝', list_dir: '📁', run_terminal: '⚡', search_workspace: '🔍', delete_file: '🗑️', create_dir: '📂', run_command: '▶️', fetch_url: '🌐', open_browser: '💻', manage_todo: '📝', vscode_action: '🎨', jira_search: '🔍', jira_fetch: '📋', jira_open: '🎫', jira_create: '🎫', jira_transition: '🔄', jira_log_time: '⏱️', jira_attachment_download: '📎', bb_create_pr: '🔀', rovo_ask: '🤖', run_python: '🐍', git_status: '📊', git_diff: '🔀', git_log: '📜', git_commit: '✅', http_request: '📡', db_query: '🗃️', search_regex: '🔎', agentic_file_search: '🧠', lint_fix: '🧹', run_tests: '🧪', browser_navigate: '🧭', browser_screenshot: '📸', browser_script: '🎭', generate_docs: '📚', refactor_suggest: '🔬', whatsapp_connect: '📱', whatsapp_disconnect: '📵', whatsapp_status: '📶', whatsapp_save_credentials: '🔐', whatsapp_send: '💬', whatsapp_send_template: '📣', jenkins_build: '🛠️', jenkins_status: '📊', read_workspace: '🗂️', agent_run_tool: '🔁', 'agent:run_tool': '🔁', read_file_smart: '🔬', rename_file: '✂️', copy_file: '📋', diff_files: '🔀', replace_all_in_file: '✏️', batch_replace: '🔁', file_info: 'ℹ️', organize_photos: '🖼️', search_tools: '🔭', workflow_run: '⚙️', workflow_list: '📋',
    lsp_goto_definition: '🔗', lsp_find_references: '🔎', lsp_hover: '💡', lsp_diagnostics: '🩺', lsp_rename_symbol: '✏️', lsp_document_symbols: '🗂️',
    run_in_background: '⏳', bg_task_status: '📊', bg_task_read: '📖', bg_task_kill: '⏹️',
    computer_screenshot: '📸', computer_type: '⌨️', computer_key: '⌨️', computer_click: '🖱️', computer_scroll: '🖥️', computer_clipboard_read: '📋', computer_clipboard_write: '📋' };
  return m[name] ?? '🔧';
}

export function formatToolTitle(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'get_active_file': return '取得目前檔案';
    case 'read_file': return `讀取檔案: ${args.path}`;
    case 'read_files': {
      const arr = Array.isArray(args.paths) ? args.paths as string[] : [];
      const preview = arr.slice(0, 3).join(', ') + (arr.length > 3 ? ` …(+${arr.length - 3})` : '');
      return `批次讀取 ${arr.length} 個檔案: ${preview}`;
    }
    case 'write_file': return `寫入檔案: ${args.path}`;
    case 'replace_in_file': return `編輯檔案: ${args.path}`;
    case 'insert_in_file': return `插入檔案: ${args.path} 第 ${args.line} 行後`;
    case 'glob': return `列檔: ${args.pattern}${args.root ? ' @ ' + args.root : ''}`;
    case 'outline_file': return `摘要: ${args.path}`;
    case 'todo_write': return `TODO ${args.checked ? '完成' : '新增'}: ${args.item}`;
    case 'memory_read': return `讀取記憶: ${args.path || 'MEMORY.md'}`;
    case 'memory_write': return `寫入記憶: ${args.title} (${args.action || 'append'})`;
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
    case 'read_file_smart': {
      const p = args.pattern ? `  pattern="${args.pattern}"` : '';
      const range = args.start_line ? `  L${args.start_line}-${args.end_line ?? '∞'}` : '';
      const mode = args.tail ? `  tail=${args.tail}` : args.head ? `  head=${args.head}` : '';
      return `🔬 分區讀取 ${args.path ?? ''}${p}${range}${mode}`;
    }
    case 'rename_file': return `重新命名: ${args.src} → ${args.dest}`;
    case 'copy_file': return `複製: ${args.src} → ${args.dest}`;
    case 'diff_files': return `比較: ${args.a} ↔ ${args.b}`;
    case 'replace_all_in_file': return `全部取代 in ${args.path}: "${(args.old_str as string || '').slice(0, 40)}"`;
    case 'batch_replace': return `批次取代: /${args.pattern}/ → "${(args.replace as string || '').slice(0, 40)}" (${args.include || '**/*'})`;
    case 'file_info': return `檔案資訊: ${args.path}`;
    case 'organize_photos': return `整理照片: ${args.source_dir}${args.reference_image ? ' (比對 ' + path.basename(String(args.reference_image)) + ')' : ' (依行為)'}`;
    case 'lsp_goto_definition':    return `LSP 跳至定義: ${args.path}:${args.line}`;
    case 'lsp_find_references':    return `LSP 找參考: ${args.path}:${args.line}`;
    case 'lsp_hover':              return `LSP Hover: ${args.path}:${args.line}`;
    case 'lsp_diagnostics':        return args.path ? `LSP 診斷: ${args.path}` : 'LSP 診斷: 全工作區';
    case 'lsp_rename_symbol':      return `LSP 重新命名: ${args.path}:${args.line} → "${args.new_name}"`;
    case 'lsp_document_symbols':   return `LSP Symbol 清單: ${args.path}`;
    case 'run_in_background': return `背景執行: ${args.command}`;
    case 'bg_task_status':    return `背景任務狀態${args.task_id ? ': ' + args.task_id : ' (全部)'}` ;
    case 'bg_task_read':      return `背景任務讀取: ${args.task_id}${args.tail ? ' (tail=' + args.tail + ')' : ''}`;
    case 'bg_task_kill':      return `終止背景任務: ${args.task_id}`;
    case 'computer_screenshot':      return `截圖${args.save_path ? '儲存: ' + args.save_path : ''}`;
    case 'computer_type':            return `輸入文字: ${String(args.text || '').slice(0, 60)}`;
    case 'computer_key':             return `按鈕: ${args.key}`;
    case 'computer_click':           return `滑鼠點擊 (${args.x}, ${args.y})${args.button && args.button !== 'left' ? ' ' + args.button : ''}`;
    case 'computer_scroll':          return `滑鼠滚動 (${args.x}, ${args.y}) ${args.direction ?? 'down'} ${args.clicks ?? 3}`;
    case 'computer_clipboard_read':  return '讀取剪貼板';
    case 'computer_clipboard_write': return `寫入剪貼板: ${String(args.text || '').slice(0, 60)}`;
    case 'agent_run_tool':
    case 'agent:run_tool': {
      const targetN = (args.name ?? args.tool_name ?? args.target ?? '(未知)') as string;
      const targetA = args.args ?? args.tool_args ?? args.parameters ?? args.input;
      return `Meta 派發 → ${targetN}${targetA ? ': ' + JSON.stringify(targetA).slice(0, 60) : ''}`;
    }
    default: return name;
  }
}
