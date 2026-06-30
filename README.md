# AMI-AiClaw — VS Code Extension

[English](#english) | [繁體中文](#繁體中文)

---

<a name="english"></a>
## English

An AI chat panel inside VS Code that connects directly to your local [Ollama](https://ollama.com/) server — no cloud subscription required. Supports streaming conversation, code generation, Agent automation (70+ built-in tools), multi-model Team collaboration (Task / Discussion / Agent / Clone Agent / Manager modes), dual-model true cross-debate, and board-game battles. GitHub Copilot models can also be mixed in alongside Ollama.

### Installation

1. Download the latest `ami-ai-claw-x.x.x.vsix` from [Releases](https://github.com/YCHsu661121/AMI-AiClaw/releases), or build it yourself
2. VS Code → Extensions (`Ctrl+Shift+X`) → `…` (top-right) → **Install from VSIX…**
3. Select the `.vsix` file and reload the window

### Open the Chat Panel

`Ctrl+Shift+P` → type **AMI-AiClaw** → Enter.

### Modes at a Glance

| Button | Mode | Description |
|--------|------|-------------|
| 💬 | **Ask** | Streaming chat with conversation history; insert code at cursor |
| 🤖 | **Agent** | AI reads files, writes files, and runs commands to complete complex tasks |
| 👥 | **Team** | Multi-model collaboration; five sub-modes |
| ⚔️ | **Debate / Game** | Two AIs truly debate each other (cross-feeding responses), or play board games turn-by-turn |
| ⏹ | **Stop** | Abort any running task |

---

### 🤖 Agent Mode

The AI autonomously reads, writes, and searches your workspace to complete any task.

**Built-in tools (70+):**
- **Files** — read / smart-read (paged, grep, head/tail) / batch-read / write / replace / replace-all / insert / rename / copy / delete; diff, file info, outline, glob
- **Search** — keyword, regex, and semantic (agentic) workspace search; read the whole workspace
- **Shell & code** — run commands (with / without output capture), run Python, lint-fix, run tests, generate docs, refactor analysis
- **Git** — status / diff / log / commit
- **Web & browser** — fetch URL, HTTP request, Playwright navigate / screenshot / script (optional Docker sandbox)
- **Atlassian** — Jira search / fetch / create / transition / log time / attachment download, Bitbucket PR, Rovo Dev
- **Jenkins** — trigger build / rebuild and query status (HTTP API or VisualeBios VS Code command)
- **WhatsApp** — connect (QR or Business API), send messages / templates, status
- **Photos** — batch-organise a folder of images: recognise a reference face and behaviour/scene with an Ollama vision model, then sort into person / behaviour folders (`organize_photos`)
- **Data & memory** — SQLite queries, persistent MEMORY.md read / write, TODO management

Auto-trims (or AI-summarises) old tool-call records and retries when the token limit is reached.

---

### 👥 Team Mode — Five Sub-Modes

Click 👥 to open the team member picker. Select up to 5 models, choose a sub-mode, set rounds, and click Send.

| Sub-Mode | Best For |
|----------|----------|
| 🧩 Task Decomposition | Parallelisable coding tasks — orchestrator splits, workers execute |
| 💬 Discussion | Design decisions, code reviews, open-ended questions |
| 🤖 Agent (Team) | Multiple AIs independently attempt the same task |
| 🪄 Clone Agent | Single model pipeline — one LLM plays 5 roles sequentially |
| 🏗️ Manager | Complex features requiring coordinated implementation |

#### 🧩 Task Decomposition (default)

Best for **coding tasks that can be parallelised**.

| Phase | What happens |
|-------|--------------|
| 0 | Orchestrator (Copilot model if selected, otherwise the smartest Ollama model) splits the task into granular sub-tasks (📋 Todos panel shows progress) |
| 1 | Workers claim sub-tasks, iterate up to 100 rounds; orchestrator reviews each result |
| 2 | Orchestrator synthesises all worker outputs |
| 3 | Agent executes necessary code / file operations |

#### 💬 Discussion Mode

Best for **design decisions, code reviews, and open-ended technical questions**.

1. **Workspace scan** — all source files (up to 300 files / 120 KB total) and `teamscontext.md` are read and injected into every AI's context before the discussion begins.
2. **Cross-feeding** — after each round, every AI receives the other members' actual responses and can rebut or extend them.
3. **Synthesis** — the most capable model (preferring a reasoning/thinking model) produces a final integrated conclusion.
4. **Persistence** — the conclusion is automatically appended to `teamscontext.md` in your workspace root with a timestamp, so future discussions build on prior knowledge.

> **Tip:** Keep `teamscontext.md` in your project root. Both Discussion and Manager modes read it on startup so AIs always know what was previously decided.

#### 🤖 Agent Mode (Team)

Each selected model runs as a **fully independent Agent** (with all tools) on the same task simultaneously. Useful when you want multiple AIs to independently attempt the same coding task and compare results.

#### 🪄 Clone Agent Mode

Best for **sequential pipeline tasks where one model wears multiple hats**.

A single LLM is assigned **5 distinct professional roles** in sequence, each receiving the output of the previous stage as context — creating a one-model "assembly line":

| Stage | Role | Emoji | Responsibility |
|-------|------|-------|----------------|
| 1 | **Planner** | 🗺️ | Analyse requirements, design architecture, produce implementation plan |
| 2 | **Developer** | 💻 | Write code following the plan; full Agent tool access (read/write files, run commands) |
| 3 | **Reviewer** | 🔍 | Code review — find bugs, security issues, style violations |
| 4 | **Tester** | 🧪 | Design and run tests, verify correctness |
| 5 | **Writer** | 📝 | Write documentation, explain technical concepts clearly |

**How it works:**
1. Select **1 model** in the Team picker, choose **🪄 Clone Agent** mode, then send your task.
2. The model first runs as Planner with full Agent capabilities.
3. Each subsequent role receives the **original task + previous stage output** in its prompt, with a role-specific system note that shapes its persona.
4. All 5 stages share the same model but maintain **independent Agent message histories** — each role starts fresh with only the pipeline context.
5. Progress is tracked in the 📋 Todos panel (same as Task Decomposition mode).

> **Tip:** Clone Agent is ideal when you only have one powerful model available but want the quality benefits of multi-perspective review. It's also useful for ensuring documentation is always produced as the final step.

#### 🏗️ Manager Mode

Best for **complex features requiring coordinated implementation**. Modelled on a real engineering team.

| Phase | Who | What |
|-------|-----|------|
| Scan | — | Workspace is scanned; `teamscontext.md` is loaded |
| 0a | **All members** | Every AI (director + engineers) individually reads the entire workspace and reports its understanding — no one starts coding without fully reading the code first |
| 0b | **Director** | Integrates everyone's understanding and produces an architecture plan with specific file paths and function names |
| 1–2 | **Engineers ⇔ Director** | Engineers submit proposals (must cite actual file paths and code); Director reviews and rejects until `[APPROVED]` is output |
| 3 | **Agent** | Executes the approved plan |
| 4 | **All members** | Independent review of the execution result; saved to `teamscontext.md` |

**Director persona:** _Engineering Director_ — never assigns work without first understanding the codebase; requires proposals to reference actual files and functions.

**Engineer persona:** Must read related code before proposing; proposals must include file paths, function/class names, and actual code diffs.

---

### ⚔️ Debate / Game Mode

Click ⚔️ to open the debate picker. Select 2 models (optionally add a 3rd as judge), set rounds.

#### True Cross-Model Debate

AIs **actually read each other's responses** before replying:

- **Round 1:** A presents its position → B receives A's full argument and responds
- **Round 2+:** each reply is fed to the other AI as the next prompt, creating a genuine back-and-forth rebuttal chain
- **Judge (optional):** summarises and evaluates both sides after all rounds

#### Board-Game Auto-Detection

When the prompt contains any of these keywords, the session automatically switches to turn-based game mode (A moves, B responds with the full move log, then judge analysis):

> `五子棋` `圍棋` `象棋` `將棋` `西洋棋` `chess` `go` `gomoku` `shogi` `tic-tac-toe` `黑白棋` `othello` `跳棋` `橋牌`

The ASCII board state is passed between AIs each turn so both models always see the current board.

---

### 📝 teamscontext.md

A plain-text Markdown file in your **workspace root** that acts as persistent team memory.

| Mode | Read on start | Written on finish |
|------|--------------|-------------------|
| Discussion | ✅ | ✅ Synthesis conclusion appended |
| Manager | ✅ | ✅ Plan + Review appended |

Format of each appended entry:
```markdown
## 討論紀錄 2026-03-22 14:30:00

**議題:** <topic>

<synthesis or review content>
```

Delete or edit `teamscontext.md` freely — it is just a text file.

---

### Thinking Window

Displays collapsible reasoning from DeepSeek-R1, Qwen QwQ, and other chain-of-thought models (`🧠 Thinking…`).

---

### Memory

| Type | Description |
|------|-------------|
| **Long-Term Memory (LTM)** | Persists across sessions; auto-injected into every Agent system prompt |
| **System Prompt** | Custom role instructions applied to every conversation (configurable in VS Code settings) |
| **Short-Term History** | Manually clearable per session |
| **teamscontext.md** | Cross-session team knowledge, read/written by Discussion and Manager modes |

---

### 🔌 Integrations

The Agent reaches beyond the editor through built-in tool integrations — no extra extensions required (except where noted).

| Integration | Capabilities |
|-------------|--------------|
| **Atlassian (Jira / Bitbucket / Rovo)** | Search Jira by JQL, fetch full issue details, download attachments (auto-unzips), log work time, create / transition issues, open Bitbucket PRs, ask Rovo Dev. Auto-detects credentials from the Atlassian extension; falls back to `jiraBaseUrl` / `jiraEmail` / `jiraPat`. |
| **Jenkins / VisualeBios** | Trigger build or rebuild and query build status. Defaults to the VisualeBios VS Code command (avoids intranet DNS issues); set `jenkinsUseVscodeCommand: false` to use the Jenkins HTTP API. |
| **WhatsApp** | Connect a personal account via QR (WhatsApp Web) or the Meta Business Cloud API. Send messages / approved templates, and optionally trigger the Agent from a whitelisted phone number (`waAgentAllowedSenders`). |
| **OpenAI-compatible endpoints** | The Codex proxy (`scripts/ollama-codex-proxy.js`) accepts an Ollama upstream or any OpenAI-compatible upstream (vLLM, DeepSeek, etc.). The WhatsApp Agent model also supports `openai::http://host:port||model`. |
| **Docker sandbox** | Optionally route browser tools and `run_terminal` / `run_command` / `run_python` through Docker (`browserUseDocker`, `sandboxUseDocker`) for isolation. |

---

### 🧠 Smart Context (Ask & Agent)

Both Ask and Agent modes can automatically feed relevant code into the model before it answers:

- **Active file** — the file you're editing is attached implicitly (like Copilot). Toggle with `autoIncludeActiveFile`; cap with `autoIncludeActiveMaxKb`.
- **File mentions** — `#file:path`, `@path`, or an inline-code path in your message are expanded to file contents (`expandFileMentions`).
- **Context depth** — `contextDepth` controls how much the model sees up front: `file` (active file only), `outline` (workspace structure summary), or `full` (entire codebase, capped by `deepAnalysisMaxKb`).
- **Read-only Ask tools** — `askModeTools` lets Ask mode call read-only tools (read / list / search / git) to pull in context without entering Agent mode.
- **AutoPilot** — `autoPilotEnabled` uses a small classifier to auto-approve safe tool calls; read-only tools pass through, risky actions are evaluated, and repeated denials fall back to manual confirmation.
- **Sensitive filtering** — `filterSensitiveInfo` masks API keys, JWTs, and passwords in tool output before the model sees them.
- **History compaction** — `autoSummarizeHistory` summarises old turns when the token budget is exceeded (instead of dropping them).

---

### Supported Models

| Type | Notes |
|------|-------|
| **Local Ollama** | Any model Ollama supports — llama, mistral, deepseek-r1, qwq, llava, etc. |
| **GitHub Copilot** | If Copilot is installed and signed in, GPT-4o, Claude, Gemini and others appear in the model dropdown and can be mixed with Ollama in Team / Debate modes |

### Configuration

Search `amiAiClaw` in VS Code `settings.json`. Key settings (defaults shown):

**Core**

| Key | Default | Description |
|-----|---------|-------------|
| `amiAiClaw.urls` | `["http://localhost:11434"]` | Ollama server URL list (duplicates are treated as disabled) |
| `amiAiClaw.model` | `llama3` | Default model |
| `amiAiClaw.models` | `["llama3", …]` | Model options shown in the chat UI |
| `amiAiClaw.systemPrompt` | _(senior-engineer prompt)_ | Role instructions applied to every conversation |
| `amiAiClaw.sendKey` | `Enter` | Send key (`Enter` or `Ctrl+Enter`) |
| `amiAiClaw.thinkingLevel` | `medium` | Reasoning level for thinking models (`off` / `low` / `medium` / `high`) |
| `amiAiClaw.enableDebugLog` | `false` | Verbose logging to the "AMI-AiClaw" output channel |

**Context & memory**

| Key | Default | Description |
|-----|---------|-------------|
| `amiAiClaw.autoIncludeActiveFile` | `true` | Attach the active editor file to the prompt |
| `amiAiClaw.autoIncludeActiveMaxKb` | `16` | Max KB of the active file to attach |
| `amiAiClaw.contextDepth` | `file` | `file` / `outline` / `full` workspace context |
| `amiAiClaw.outlineMaxKb` | `24` | Cap for the `outline` structure summary |
| `amiAiClaw.deepAnalysisMaxKb` | `64` | Cap for `full` whole-workspace injection |
| `amiAiClaw.expandFileMentions` | `true` | Expand `#file:` / `@path` / inline-code path mentions |
| `amiAiClaw.askModeTools` | `true` | Allow read-only tools in Ask mode |
| `amiAiClaw.autoMemoryEnabled` | `true` | File-based long-term memory |
| `amiAiClaw.memoryDir` | `""` | Override the memory folder path |
| `amiAiClaw.autoSummarizeHistory` | `true` | Summarise old history when over budget |
| `amiAiClaw.autoSummarizeThreshold` | `8000` | Token threshold that triggers summarisation |

**Permissions & safety**

| Key | Default | Description |
|-----|---------|-------------|
| `amiAiClaw.agentAutoApproveWrite` | `false` | Auto-approve file writes (delete / secrets still confirm) |
| `amiAiClaw.autoPilotEnabled` | `false` | Classifier-based semi-auto tool approval |
| `amiAiClaw.filterSensitiveInfo` | `true` | Mask API keys / tokens / passwords in tool output |
| `amiAiClaw.toolAlwaysAllow` | `[]` | Tool names / categories to always allow |
| `amiAiClaw.toolAlwaysConfirm` | `[]` | Tool names to always confirm |

**Integrations** (Jira, Jenkins, WhatsApp, Docker, team roles) — see the settings UI for `jira*`, `jenkins*`, `wa*`, `browserUseDocker`, `sandboxUseDocker`, and `teamRoles`.

```jsonc
{
  "amiAiClaw.urls": ["http://localhost:11434"],
  "amiAiClaw.model": "deepseek-r1:7b",
  "amiAiClaw.contextDepth": "outline",
  "amiAiClaw.systemPrompt": "You are a senior engineer proficient in TypeScript and BIOS firmware. Reply in Traditional Chinese."
}
```

### Troubleshooting

**AMI-AiClaw command not found** → Confirm the extension is enabled in the Extensions panel, then `Ctrl+Shift+P` → Reload Window

**Cannot connect to Ollama** → Verify Ollama is running and `http://localhost:11434` responds

**Slow model responses** → Try a smaller model, or check that no other process is consuming VRAM / RAM

**Agent: Message exceeds token limit** → History is trimmed and retried automatically; if it persists, clear conversation history and restart

**Team / Debate model list empty** → Click 🔄 to refresh, or restart VS Code

**Copilot model refuses to respond** → Debate mode uses independent cross-feeding contexts; if it persists, switch to a different Copilot model

**Discussion / Manager scans too many files** → By default up to 300 files / 120 KB total are included, single file capped at 30 KB; very large repos may hit the limit — the scan log shows how many files were loaded

---

<a name="繁體中文"></a>
## 繁體中文

在 VS Code 側邊欄開啟 AI 聊天面板，直接連結本機 [Ollama](https://ollama.com/) 伺服器，不需要任何雲端訂閱。支援串流對話、程式碼生成、Agent 自動執行（70+ 內建工具）、多模型 Team 協作（任務分解 / 討論 / Agent / 分身 / 主管 五種子模式）、雙模型真正跨模型辯論，以及棋類遊戲對戰。亦可混搭 GitHub Copilot 模型。

### 安裝

1. 從 [Releases](https://github.com/YCHsu661121/AMI-AiClaw/releases) 下載最新的 `ami-ai-claw-x.x.x.vsix`，或自行打包
2. VS Code → Extensions（`Ctrl+Shift+X`）→ 右上角 `…` → **Install from VSIX…**
3. 選擇 `.vsix` 檔案，重新載入視窗即完成

### 開啟聊天視窗

`Ctrl+Shift+P` → 搜尋 **AMI-AiClaw** → Enter。

---

### 模式總覽

| 按鈕 | 模式 | 說明 |
|------|------|------|
| 💬 | **Ask** | 串流對話，保留歷史紀錄，可將回應程式碼插入游標處 |
| 🤖 | **Agent** | AI 自動讀寫檔案、執行指令完成複雜任務 |
| 👥 | **Team** | 多模型協作，五種子模式 |
| ⚔️ | **辯論 / 遊戲** | 兩個 AI 真正互讀對方回應並反駁；偵測到棋類關鍵字時切換回合制遊戲 |
| ⏹ | **停止** | 中止目前進行中的任何任務 |

---

### 🤖 Agent 模式

AI 自主讀取、寫入、搜尋工作區，完成複雜任務。

**內建工具（70+）：**
- **檔案** — 讀取 / 智慧讀取（分頁、grep、頭尾）/ 批次讀取 / 寫入 / 替換 / 全部替換 / 插入 / 重新命名 / 複製 / 刪除；diff、檔案資訊、outline、glob
- **搜尋** — 關鍵字、正規表達式、語意（agentic）工作區搜尋；讀取整個工作區
- **Shell 與程式碼** — 執行命令（捕獲 / 不捕獲輸出）、執行 Python、lint 修正、執行測試、產生文件、重構分析
- **Git** — status / diff / log / commit
- **網路與瀏覽器** — fetch URL、HTTP 請求、Playwright 訪問 / 截圖 / 腳本（可選 Docker 沙箱）
- **Atlassian** — Jira 搜尋 / 取得 / 建立 / 轉換 / 工時 / 附件下載、Bitbucket PR、Rovo Dev
- **Jenkins** — 觸發 build / rebuild、查詢狀態（HTTP API 或 VisualeBios VS Code 指令）
- **WhatsApp** — 連線（QR 或 Business API）、發送訊息 / 樣板、查詢狀態
- **照片整理** — 批次整理資料夾照片：用 Ollama 視覺模型辨識參考人臉與行為 / 場景，依「人物 / 行為」分類資料夾（`organize_photos`）
- **資料與記憶** — SQLite 查詢、持久化 MEMORY.md 讀 / 寫、TODO 管理

達到 token 上限時自動裁剪（或由 AI 摘要）舊的工具呼叫記錄並重試。

---

### 👥 Team 模式 — 五種子模式

點擊 👥 開啟成員選擇面板，最多選 5 個模型，選擇子模式，設定回合數，送出即開始。

| 子模式 | 最適合 |
|--------|--------|
| 🧩 任務分解 | 可平行拆分的開發任務 — 協調員拆分，工人執行 |
| 💬 討論模式 | 設計決策、程式碼審查、開放式技術問題 |
| 🤖 Agent 模式 | 多個 AI 各自獨立嘗試同一任務 |
| 🪄 分身 Agent | 單一模型流水線 — 一個 LLM 依序扮演 5 種角色 |
| 🏗️ 主管模式 | 需要協調實作的複雜功能 |

#### 🧩 任務分解（預設）

最適合**可拆分平行執行的開發任務**。

| Phase | 說明 |
|-------|------|
| 0 | 協調員（選了 Copilot 則優先使用，否則選最具思考能力的 Ollama 模型）拆分任務為細緻子任務（📋 Todos 面板顯示進度） |
| 1 | 工作模型從佇列認領子任務各自執行，最多 100 輪迭代；協調員審查各結果 |
| 2 | 協調員綜合所有工作結果 |
| 3 | Agent 執行必要的程式碼或檔案操作 |

#### 💬 討論模式

最適合**設計決策、程式碼審查、開放式技術問題**。

1. **工作區掃描** — 開始前自動掃描工作區所有原始碼（最多 300 檔 / 120 KB 總量）與 `teamscontext.md`，注入每個 AI 的初始脈絡。
2. **真正交叉討論** — 每輪結束後，每個 AI 都會收到其他成員的實際回應，並在下一輪提出反駁或延伸論點。
3. **合成結論** — 最具思考能力的模型產生最終整合結論。
4. **持久化** — 結論自動附加（append）至工作區根目錄的 `teamscontext.md`，含時間戳，下次討論自動引用歷史脈絡。

> **提示：** 在專案根目錄建立 `teamscontext.md`，討論模式與主管模式啟動時都會讀取它，讓 AI 知道過去已決定的事情。

#### 🤖 Agent 模式（Team）

每個選定的模型都以**完整 Agent 身份（含所有工具）** 各自獨立執行同一個任務。適合讓多個 AI 各自嘗試同一個程式碼任務，比較結果。

#### 🪄 分身 Agent 模式

最適合**只有一個強力模型但想獲得多視角審查品質**的場景。

同一個 LLM 依序被指派 **5 種專業角色**，每個角色接收前一階段的輸出作為上下文，形成「一人分飾五角」的流水線：

| 階段 | 角色 | Emoji | 職責 |
|------|------|-------|------|
| 1 | **規劃者** | 🗺️ | 分析需求、設計架構、產出實作計劃 |
| 2 | **開發者** | 💻 | 依照計劃撰寫程式碼；擁有完整 Agent 工具權限（讀寫檔案、執行命令） |
| 3 | **評審員** | 🔍 | Code Review — 找出 bug、安全問題、風格問題 |
| 4 | **測試員** | 🧪 | 設計並執行測試，驗證正確性 |
| 5 | **撰寫者** | 📝 | 撰寫文件、清晰解釋技術概念 |

**運作方式：**
1. 在 Team 選單中選擇 **1 個模型**，子模式選 **🪄 分身 Agent**，送出任務。
2. 模型先以「規劃者」身份執行，擁有完整 Agent 工具。
3. 每個後續角色收到 **原始任務 + 上一階段輸出**，並附帶角色專屬的系統提示詞塑造人格。
4. 5 個階段共用同一個模型，但各自擁有**獨立的 Agent 訊息歷史** — 每個角色從乾淨狀態開始，只帶入流水線上下文。
5. 進度追蹤顯示在 📋 Todos 面板（與任務分解模式相同）。

> **提示：** 當你只有一個強力模型可用，但希望獲得多角度審查的品質時，分身 Agent 特別適合。它也確保文件撰寫永遠作為最後步驟產出。

#### 🏗️ 主管模式

最適合**需要協調實作的複雜功能**。仿照真實工程團隊的工作流程。

| Phase | 執行者 | 說明 |
|-------|--------|------|
| 掃描 | — | 掃描工作區原始碼；讀取 `teamscontext.md` |
| 0a | **全體成員** | 每個 AI（主任 + 工程師）逐一閱讀整個工作區並輸出理解摘要 — **不允許在沒有充分閱讀原始碼的情況下分配工作** |
| 0b | **主任** | 整合所有人的理解，提出含具體檔案路徑與函式名的架構計劃 |
| 1–2 | **工程師 ⇔ 主任** | 工程師提交提案（必須引用實際檔案路徑與程式碼）；主任審核，不符合標準則退回修改，直到輸出 `[APPROVED]` |
| 3 | **Agent** | 執行核准的方案 |
| 4 | **全體成員** | 各自獨立對執行結果進行 Review；結果儲存至 `teamscontext.md` |

**主任人格：** _Engineering Director（工程主任）_ — 先充分理解原始碼再動手；要求提案必須引用具體檔案與函式名，不接受空談。

**工程師人格：** 先閱讀相關程式碼再提案；提案必須含檔案路徑、函式 / 類別名稱、實際程式碼片段。

---

### ⚔️ 辯論 / 遊戲模式

點擊 ⚔️ 開啟成員選擇面板，選 2 個模型（可加第 3 個裁判），設定回合數。

#### 真正跨模型辯論

AI **真的讀到對方的回應**再開口：

- **第 1 輪：** A 提出立場 → B 收到 A 的完整論點後回應
- **第 2 輪起：** 每次回覆都作為下一輪的輸入，形成真正的你來我往反駁鏈
- **裁判（選用）：** 所有回合結束後，由裁判總結評判雙方

#### 棋類遊戲自動偵測

訊息中包含以下關鍵字時，自動切換為回合制遊戲模式（A 先手，B 接收完整棋譜後回應，再由裁判分析整局）：

> `五子棋` `圍棋` `象棋` `將棋` `西洋棋` `chess` `go` `gomoku` `shogi` `tic-tac-toe` `黑白棋` `othello` `跳棋` `橋牌`

每回合 ASCII 棋盤狀態都會傳遞給下一位 AI，確保雙方始終看到當前棋盤。

---

### 📝 teamscontext.md

放在**工作區根目錄**的純文字 Markdown 檔，作為跨次討論的持久化團隊記憶。

| 模式 | 啟動時讀取 | 完成時寫入 |
|------|-----------|----------|
| 討論模式 | ✅ | ✅ 合成結論附加寫入 |
| 主管模式 | ✅ | ✅ 架構計劃 + 全員 Review 附加寫入 |

每次附加的格式：
```markdown
## 討論紀錄 2026-03-22 14:30:00

**議題：** <topic>

<synthesis or review content>
```

可以自由刪除或編輯 `teamscontext.md`，它只是一個純文字檔。

---

### 思考視窗

支援 DeepSeek-R1、Qwen QwQ 等思考型模型，回應旁顯示可折疊的推理過程（`🧠 思考中…`）。

---

### 記憶管理

| 類型 | 說明 |
|------|------|
| **長期記憶（LTM）** | 跨對話持續保存，自動注入每次 Agent 的系統提示 |
| **角色設定（System Prompt）** | VS Code 設定中自訂每次對話的角色指令 |
| **對話歷史** | 可手動清除目前工作階段的短期記憶 |
| **teamscontext.md** | 跨階段的團隊知識，由討論模式與主管模式讀取 / 寫入 |

---

### 🔌 整合功能

Agent 透過內建工具整合延伸到編輯器之外 — 除特別註明外，無需額外安裝外掛。

| 整合 | 能力 |
|------|------|
| **Atlassian（Jira / Bitbucket / Rovo）** | JQL 搜尋 Jira、取得 Issue 完整詳情、下載附件（自動解壓）、記錄工時、建立 / 轉換 Issue、開立 Bitbucket PR、詢問 Rovo Dev。自動從 Atlassian 外掛取得憑證；無外掛時退回 `jiraBaseUrl` / `jiraEmail` / `jiraPat`。 |
| **Jenkins / VisualeBios** | 觸發 build 或 rebuild、查詢建置狀態。預設走 VisualeBios VS Code 指令（避免內網 DNS 問題）；設 `jenkinsUseVscodeCommand: false` 改走 Jenkins HTTP API。 |
| **WhatsApp** | 以 QR Code（WhatsApp Web）綁定個人帳號，或使用 Meta Business Cloud API。發送訊息 / 已審核樣板，並可從白名單號碼（`waAgentAllowedSenders`）觸發 Agent。 |
| **OpenAI 相容端點** | Codex proxy（`scripts/ollama-codex-proxy.js`）可接 Ollama 上游或任何 OpenAI 相容上游（vLLM、DeepSeek 等）。WhatsApp Agent 模型亦支援 `openai::http://host:port||model`。 |
| **Docker 沙箱** | 可選擇將瀏覽器工具與 `run_terminal` / `run_command` / `run_python` 導入 Docker 執行（`browserUseDocker`、`sandboxUseDocker`）以隔離。 |

---

### 🧠 智慧上下文（Ask 與 Agent）

Ask 與 Agent 模式都能在回答前自動把相關程式碼餵給模型：

- **作用中檔案** — 目前編輯的檔案會隱含附帶（類似 Copilot）。以 `autoIncludeActiveFile` 開關，`autoIncludeActiveMaxKb` 設上限。
- **檔案提及** — 訊息中的 `#file:path`、`@path` 或反引號包住的路徑會展開為檔案內容（`expandFileMentions`）。
- **上下文深度** — `contextDepth` 控制模型一開始看到多少：`file`（僅作用中檔案）、`outline`（工作區結構摘要）、`full`（整個程式庫，受 `deepAnalysisMaxKb` 上限保護）。
- **Ask 唯讀工具** — `askModeTools` 讓 Ask 模式可呼叫唯讀工具（讀取 / 列出 / 搜尋 / git）自行補上上下文，無需切到 Agent。
- **AutoPilot** — `autoPilotEnabled` 用小型分類器自動放行安全的工具呼叫；唯讀工具直接通過，有風險的動作交給分類器評估，連續被拒則回退人工確認。
- **敏感資訊過濾** — `filterSensitiveInfo` 在模型看到前遮蔽工具輸出中的 API key、JWT、密碼。
- **歷史壓縮** — `autoSummarizeHistory` 在超過 token 預算時摘要舊訊息（而非直接丟棄）。

---

### 支援的模型

| 類型 | 說明 |
|------|------|
| **Ollama 本機模型** | 任何 Ollama 支援的模型，包括 llama、mistral、deepseek-r1、qwq、llava 等 |
| **GitHub Copilot** | 已安裝並登入 Copilot 後，可在下拉選單選用 GPT-4o、Claude、Gemini 等；Team / 辯論模式可混搭 Copilot 與 Ollama |

### 設定

在 VS Code `settings.json` 搜尋 `amiAiClaw`。主要設定（顯示預設值）：

**核心**

| 設定鍵 | 預設值 | 說明 |
|--------|--------|------|
| `amiAiClaw.urls` | `["http://localhost:11434"]` | Ollama 伺服器 URL 列表（重複視為停用） |
| `amiAiClaw.model` | `llama3` | 預設模型 |
| `amiAiClaw.models` | `["llama3", …]` | 聊天 UI 顯示的模型選項 |
| `amiAiClaw.systemPrompt` | _（資深工程師提示）_ | 每次對話自動套用的角色設定 |
| `amiAiClaw.sendKey` | `Enter` | 送出鍵（`Enter` 或 `Ctrl+Enter`） |
| `amiAiClaw.thinkingLevel` | `medium` | 思考模型推理等級（`off` / `low` / `medium` / `high`） |
| `amiAiClaw.enableDebugLog` | `false` | 輸出詳細日誌到「AMI-AiClaw」輸出頻道 |

**上下文與記憶**

| 設定鍵 | 預設值 | 說明 |
|--------|--------|------|
| `amiAiClaw.autoIncludeActiveFile` | `true` | 附帶作用中編輯器檔案到 prompt |
| `amiAiClaw.autoIncludeActiveMaxKb` | `16` | 附帶作用中檔案的最大 KB |
| `amiAiClaw.contextDepth` | `file` | `file` / `outline` / `full` 工作區上下文 |
| `amiAiClaw.outlineMaxKb` | `24` | `outline` 結構摘要容量上限 |
| `amiAiClaw.deepAnalysisMaxKb` | `64` | `full` 全工作區注入容量上限 |
| `amiAiClaw.expandFileMentions` | `true` | 展開 `#file:` / `@path` / 反引號路徑 提及 |
| `amiAiClaw.askModeTools` | `true` | 允許 Ask 模式使用唯讀工具 |
| `amiAiClaw.autoMemoryEnabled` | `true` | 檔案型長期記憶 |
| `amiAiClaw.memoryDir` | `""` | 覆寫記憶資料夾路徑 |
| `amiAiClaw.autoSummarizeHistory` | `true` | 超過預算時摘要舊歷史 |
| `amiAiClaw.autoSummarizeThreshold` | `8000` | 觸發摘要的 token 閾值 |

**權限與安全**

| 設定鍵 | 預設值 | 說明 |
|--------|--------|------|
| `amiAiClaw.agentAutoApproveWrite` | `false` | 自動允許檔案寫入（刪除 / 機密仍需確認） |
| `amiAiClaw.autoPilotEnabled` | `false` | 分類器式半自動工具核准 |
| `amiAiClaw.filterSensitiveInfo` | `true` | 遮蔽工具輸出中的 API key / token / 密碼 |
| `amiAiClaw.toolAlwaysAllow` | `[]` | 永遠允許的工具名稱／類別 |
| `amiAiClaw.toolAlwaysConfirm` | `[]` | 永遠要求確認的工具名稱 |

**整合**（Jira、Jenkins、WhatsApp、Docker、團隊角色）— 在設定 UI 搜尋 `jira*`、`jenkins*`、`wa*`、`browserUseDocker`、`sandboxUseDocker`、`teamRoles`。

```jsonc
{
  "amiAiClaw.urls": ["http://localhost:11434"],
  "amiAiClaw.model": "deepseek-r1:7b",
  "amiAiClaw.contextDepth": "outline",
  "amiAiClaw.systemPrompt": "你是一位熟悉 TypeScript 與 BIOS 韌體開發的資深工程師，請用繁體中文回答。"
}
```

### 疑難排解

**找不到 AMI-AiClaw 命令** → Extensions 頁面確認已啟用，再 `Ctrl+Shift+P` → Reload Window

**無法連線到 Ollama** → 確認 Ollama 正在執行（`http://localhost:11434` 可正常回應）

**模型回應緩慢** → 嘗試更小的模型，或確認沒有其他程式佔用 VRAM / 記憶體

**Agent 錯誤：Message exceeds token limit** → 已自動裁剪對話歷史並重試；若仍發生，請手動清除對話歷史

**Team / 辯論模式模型清單空白** → 點擊 🔄 重新整理，或重啟 VS Code

**Copilot 模型拒絕回應** → 辯論模式每個 AI 使用交叉注入的獨立上下文；若仍發生請切換其他 Copilot 模型

**討論 / 主管模式掃描太多檔案** → 預設最多 300 檔 / 120 KB 總量，單檔上限 30 KB；掃描完成後會顯示實際載入的檔案數與大小

---

*Author: Y.C. Hsu · License: MIT*
