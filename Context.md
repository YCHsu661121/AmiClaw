# Ollama Chat — VS Code Extension · Context.md

> 最後更新：2026-03-18

---

## 目的

在 VS Code 側邊欄提供類 GitHub Copilot Chat 的本機 AI 助理，連結本機 Ollama 伺服器（不需要任何雲端訂閱）。  
支援：普通對話、串流回應、思考過程顯示、程式碼插入、Agent 工具呼叫、自動持續執行。

---

## 環境現況

| 項目 | 值 |
|------|-----|
| Extension ID | `localdev.ollama-chat` v0.0.1 |
| VSIX 路徑 | `D:\Tools\Ollama\dist\ollama-chat.vsix` |
| Ollama 容器 | `ollama-server`（Up，port 11434） |
| 已安裝模型 | `llama3.2:3b` |
| VS Code 設定 | `ollamaChat.url=http://localhost:11434`, `ollamaChat.model=llama3.2:3b` |

---

## 專案結構

```
D:\Tools\Ollama\
├── src/
│   ├── extension.ts          # activate / deactivate；只註冊 ollama.chat 命令
│   └── ollama-chat.ts        # 全部核心邏輯：Webview HTML/CSS/JS + Ollama HTTP 客戶端
├── dist/
│   └── ollama-chat.vsix      # 打包成品（build 產生）
├── .dockerignore             # 排除 node_modules/out/dist/.git/.vscode 等
├── build.bat                 # 建置腳本（local/docker/clean/ollama 子命令）
├── docker-compose.yml        # ollama server + builder profile
├── Dockerfile                # 多階段 build：node:20-slim → scratch export
├── package.json              # Extension manifest + npm scripts
├── tsconfig.json             # TypeScript 設定（target ES2020, module commonjs）
├── README.md                 # 使用者文件
└── Context.md                # 本文件
```

---

## Review 需求

| 檔案 | 行數 | 問題 |
|------|------|------|
| `src/ollama-chat.ts` | **9,740** | God class：UI / Agent / WhatsApp / Jira / 工具全混一檔，需拆分並 AI 深度審查 |
| `src/extension.ts` | ~150 | `createSilent` 在啟動時背景初始化（WhatsApp 自動連線）— 留意副作用 |

---

## 拆分計畫（ollama-chat.ts → 14 個模組）

> 目標：主類別縮減至 ~500 行薄 facade，各模組各司其職

```
src/
├── panels/
│   └── OllamaChatPanel.ts      (~500)  lifecycle + message dispatch
├── chat/
│   ├── QueryEngine.ts          (~1200) handleSend / buildSystemContent / LTM / permission
│   └── AgentExecutor.ts        (~300)  handleAgent / agentic loop / auto-summarize
├── auto/
│   └── AutoIterator.ts         (~100)  startAuto / _autoCancel 迭代包裝
├── team/
│   └── TeamManager.ts          (~1600) handleTeamSend / discussion / compare / orchestrator
├── debate/
│   └── DebateEngine.ts         (~300)  handleDebateSend / A-B-Judge 結構辯論
├── integrations/
│   ├── JiraManager.ts          (~300)  getAtlascodeJiraAuth + jira_* tool cases
│   ├── WhatsAppManager.ts      (~700)  WA socket / reconnect / incoming / module commands
│   └── RovoDevManager.ts       (~200)  discoverRovoDevUrl / ensureModelReady / callRovoDevApi
├── tools/
│   └── ToolExecutor.ts         (~1900) executeTool switch（60+ tools）+ 30s TTL cache
├── webview/
│   └── WebviewRenderer.ts      (~2700) getHtmlForWebview（HTML / CSS / JS 全部 UI）
├── session/
│   └── SessionManager.ts       (~100)  switchChatSession / resolveSessionId / fork / export
├── models/
│   └── ModelFetcher.ts         (~150)  fetchModelsFromServer / testConnectionStatus
└── state/
    └── PanelState.ts           (~300)  trackUsage / trackLatency / auditLog / alwaysAllow
```

### 拆分優先序

| 優先 | 模組 | 理由 |
|------|------|------|
| 1 | `WebviewRenderer` | 2700 行純 HTML/CSS/JS，完全無副作用，零風險 |
| 2 | `WhatsAppManager` | 700 行自治狀態機，依賴最少 |
| 3 | `ToolExecutor` | 1900 行工具 switch，可獨立外包 |
| 4 | `TeamManager` + `DebateEngine` | 互相不依賴，直接搬移 |
| 5 | `QueryEngine` + `AgentExecutor` | 核心邏輯，需仔細梳理共享狀態 |
| 6 | `OllamaChatPanel` 薄化 | 最後才做，完成後主類別剩 ~500 行 |



---

## 核心類別：`OllamaChatPanel`（src/ollama-chat.ts）

### 類別欄位

```typescript
static currentPanel: OllamaChatPanel | undefined
private _panel: vscode.WebviewPanel
private _streamMode: boolean                // 串流 vs 非串流
private _agentRunning / _agentCancel       // Agent 執行狀態
private _agentMessages: ChatMessage[]       // 跨回合對話歷史（/api/chat 用）
private _autoRunning / _autoCancel          // 舊式自動執行狀態
```

### 後端 Message Handler（switch cases）

| type | 動作 |
|------|------|
| `send` | `handleSend()` — 普通對話（stream 或 non-stream） |
| `agentSend` | `handleAgent()` — Agent 模式，自動呼叫工具 |
| `agentStop` | `_agentCancel = true` |
| `toggleStream` | 切換串流模式 |
| `summarize` | `summarizeText()` |
| `insert` | `handleInsert()` — 插入游標處 |
| `applyToFile` | `handleApplyToFile()` — 替換整個檔案內容 |
| `pickFile` | `handlePickFile()` — 選檔案附加到對話 |
| `fetchModels` | `fetchModelsFromServer()` — GET /api/tags |
| `testConnection` | `testConnectionStatus()` — 連線檢查 |
| `webviewReady` | webview 初始化完成握手 → 觸發 fetchModelsFromServer |
| `startAuto` | `startAuto()` — 舊式自動持續執行 |
| `stopAuto` | `_autoCancel = true` |
| `clearHistory` | 清除 `_agentMessages` |

### 啟動流程（連線檢查 timing 修正）

```
new OllamaChatPanel()
  → panel.webview.html = getHtmlForWebview()     // 渲染 webview
  → setTimeout(2000, fetchModelsFromServer)       // 2 秒保險 fallback

webview JS 執行完畢
  → vscode.postMessage({ type: 'webviewReady' }) // JS 端主動握手
  → 後端收到 → fetchModelsFromServer()
  → postMessage({ type:'modelList', ... })
  → postMessage({ type:'connectionStatus', ok:true, ... })
  → 前端 updateConnStatus() 更新 #connStatus 顯示
```

**重要**：`window.addEventListener('message', ...)` 已移到 `<script>` **第一行**，避免後續程式碼拋例外導致 listener 未掛上。

---

## Agent 工具（AGENT_TOOLS）

使用 Ollama `/api/chat` 的 function calling（`tools` 參數）：

| 工具名稱 | 圖示 | 功能 |
|----------|------|------|
| `get_active_file` | 📝 | 讀取目前 VS Code 編輯器開啟的檔案 |
| `read_file` | 📄 | 讀取工作區內任意檔案（最多 50KB） |
| `write_file` | 💾 | 建立或覆寫檔案 |
| `replace_in_file` | ✏️ | 精準替換檔案內特定字串 |
| `list_dir` | 📁 | 列出目錄內容 |
| `run_terminal` | ⚡ | 在 VS Code 終端機執行命令 |

Agent 執行迴圈最多 20 步，工具步驟以可折疊的 `▶ details.tool-step` 顯示進度。

---

## Ollama HTTP API 用法

### `/api/generate`（非串流 / 串流）

```json
POST /api/generate
{ "model": "llama3.2:3b", "prompt": "...", "stream": false, "think": true }
```
- 回應：`{ response: string, thinking?: string }`
- 若 `thinking` 為空，嘗試從 `<think>...</think>` tag 提取

### `/api/chat`（Agent 模式）

```json
POST /api/chat
{ "model": "...", "messages": [...], "tools": [...], "stream": false }
```
- 回應：`{ message: { role, content, tool_calls? } }`

### `/api/tags`（連線檢查 + 模型清單）

```
GET /api/tags
→ { models: [{ name, model, size, details }] }
```

---

## Webview HTML 結構

```
<body>
  <div id="chat">            ← 對話氣泡區（flex column，user右/assistant左）
  <div id="bottomBar">
    <div id="topBar">        ← modelSelect + icon buttons + #connStatus
    <div id="attachedFiles"> ← 附加檔案 chip
    <div id="inputRow">      ← #prompt textarea + #sendBtn
    <div id="statusBar">     ← 狀態文字（三個點動畫、Agent 狀態等）
```

### 工具列按鈕

| 按鈕 | id | 功能 |
|------|----|------|
| 🔄 | `refreshModels` | 重新檢查連線 + 更新模型清單 |
| 📎 | `pickFile` | 附加檔案 |
| ⚡ | `toggleStream` | 切換串流模式 |
| 🤖 | `agentMode` | 切換 Agent 模式（toggle） |
| ⏹ | `stopAgent` | 停止 Agent |
| 🗑 | `clear` | 清除對話 + 清除 Agent 歷史 |

---

## 程式碼區塊按鈕（Copilot 風格）

每個 ` ``` ` 程式碼區塊下方自動出現：
- **📋 套用到檔案** — `applyToFile`：替換活躍編輯器全文（> 50 行先確認）
- **⬇ 插入游標** — `insert`：在游標處插入
- **複製** — navigator.clipboard，1.5 秒後恢復文字

---

## CSS 關鍵 class

| class | 說明 |
|-------|------|
| `.msg.user` | 右對齊藍色氣泡 |
| `.msg.assistant` | 左對齊灰色氣泡 |
| `.loading-dots` | 三點 blink 動畫（等待 Ollama 回應） |
| `details.think` | 可折疊思考過程（藍色左邊線） |
| `details.tool-step` | Agent 工具步驟（橘色左邊線，data-s=running/done/error） |
| `.code-block-wrap` | 程式碼區塊容器 |
| `.code-actions` | 套用/插入/複製按鈕列 |
| `.file-chip` | 附加檔案標籤 |

---

## 頂層函式（TypeScript）

| 函式 | 說明 |
|------|------|
| `ollamaChatCall(url, model, messages, tools)` | POST /api/chat，用於 Agent |
| `ollamaGenerate(url, model, prompt)` | POST /api/generate（non-stream） |
| `ollamaGenerateStream(url, model, prompt, onChunk, onThink)` | POST /api/generate（stream） |
| `ollamaListModels(url)` | GET /api/tags → string[] |
| `ollamaCheckConnection(url)` | GET /api/tags，只檢查可達性 |
| `ollamaConnectError(hostname, e)` | 將 ENOTFOUND/ECONNREFUSED/ETIMEDOUT 轉為中文訊息 |
| `getNonce()` | 產生 CSP nonce |

---

## 建置 & 安裝

```bat
:: 建置（Docker 模式）
build.bat docker

:: 安裝到 VS Code
code --install-extension dist\ollama-chat.vsix --force

:: Ollama 伺服器管理
build.bat ollama start          :: 啟動 docker compose ollama service
build.bat ollama pull llama3.2:3b
build.bat ollama stop
```

---

## 設定（VS Code settings.json）

```json
"ollamaChat.url": "http://localhost:11434",
"ollamaChat.model": "llama3.2:3b",
"ollamaChat.models": ["llama3.2:3b"]
```

---

## 人格設定（Assistant persona）

- **語言**：繁體中文（台灣）
- **風格**：精準、專業、友善、簡短
- **回覆原則**：優先提供可執行程式碼或明確步驟；核心說明限制 2–4 行；不確定資訊標註「不確定」並建議檢查方法

---

## 已知問題 / 歷史修正

| 問題 | 原因 | 修法 |
|------|------|------|
| 連線一直「檢查中…」 | `window.addEventListener('message',...)` 在腳本中段，上方程式碼拋例外時 listener 不掛上；`setTimeout(300ms)` 又早於 webview JS 初始化 | listener 移到 script 第一行；改用 `webviewReady` 握手；2 秒 fallback；6 秒 JS 端自動重試 |
| README.md 未打包進 VSIX | `.dockerignore` 有 `README.md` 一行 | 從 `.dockerignore` 移除 |
| `autoStatus` handler 崩潰 | `document.getElementById('startAuto')` 返回 null（按鈕已改名） | 移除該行 |
| 非串流模式產生兩個 assistant 氣泡 | 先送 `{text:'正在呼叫…'}` 再送實際回應 | 改用 `appendLoadingBubble()` loading 動畫；回應到達時清除 pending bubble |
| TS1487 octal escape 錯誤 | CSS `content:'\25B6'` 在 TS template literal 被視為 octal | 改用 Unicode 字元直接嵌入（▶▼✓✗） |

| `build.bat`                  | 自動選擇 local npm / Docker build |
| `build.bat docker`           | 強制 Docker build                 |
| `build.bat local`            | 強制 local npm build              |
| `build.bat clean`            | 清除 node_modules / out / dist    |
| `build.bat ollama start`     | 啟動 Ollama Docker 服務           |
| `build.bat ollama stop`      | 停止 Ollama Docker 服務           |
| `build.bat ollama pull <m>`  | 從 Ollama 拉取指定模型            |

檔案結構
```
d:\Tools\Ollama\
  src/
    extension.ts      # activate/deactivate
    ollama-chat.ts    # Webview + Ollama HTTP client
  Dockerfile          # single-stage builder image
  docker-compose.yml  # ollama server + builder services
  build.bat           # Windows build + Ollama management script
  package.json        # VS Code extension manifest
  tsconfig.json       # TypeScript config
  Context.md          # 本文件
  dist/               # 產生的 .vsix（build 後才存在）
```

更新時間：2026-03-18
