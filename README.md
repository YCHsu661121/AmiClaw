# AMI-AiClaw — VS Code Extension

[English](#english) | [繁體中文](#繁體中文)

---

<a name="english"></a>
## English

An AI chat panel inside VS Code that connects directly to your local [Ollama](https://ollama.com/) server — no cloud subscription required. Supports streaming conversation, code generation, Agent automation, multi-model Team collaboration, dual-model Debate, and board-game battles. GitHub Copilot models can also be mixed in alongside Ollama.

### Installation

1. Download the latest `ami-ai-claw-x.x.x.vsix` from [Releases](https://github.com/YCHsu661121/AMI-AiClaw/releases), or build it yourself
2. VS Code → Extensions (`Ctrl+Shift+X`) → `…` (top-right) → **Install from VSIX…**
3. Select the `.vsix` file and reload the window

### Open the Chat Panel

`Ctrl+Shift+P` → type **AMI-AiClaw** → Enter.

### Modes

| Button | Mode | Description |
|--------|------|-------------|
| 💬 | **Ask** | Streaming chat with conversation history; insert code at cursor |
| 🤖 | **Agent** | AI reads files, writes files, and runs commands to complete complex tasks; auto-trims history when token limit is hit |
| 👥 | **Team** | Multi-model parallel execution; orchestrator splits task into sub-tasks, workers iterate, supervisor reviews |
| ⚔️ | **Debate** | Two AIs independently analyze the same topic; auto-detects board-game keywords and switches to turn-based game mode |
| ⏹ | **Stop** | Abort any running Agent / Team / Debate task |

#### Agent Tools

- Read / write / list / search workspace files
- Execute shell commands and capture output
- Query, create, and transition Jira Issues (requires Atlassian for VS Code)
- Open Bitbucket Pull Requests

Auto-trims old tool call records and retries when the token limit is reached.

#### Team Workflow

| Phase | Action |
|-------|--------|
| 0 | Orchestrator (most capable model or Copilot) splits the task into granular sub-tasks (📋 Todos panel shows progress) |
| 1 | Workers claim sub-tasks from the queue; orchestrator reviews each result (up to 100 iteration rounds, minimum 3) |
| 2 | Orchestrator synthesizes all worker outputs |
| 3 | Agent executes any necessary code or file operations |

#### Debate / Game Mode

Pick 2 models (optionally add a 3rd as judge). Each AI analyzes independently — no cross-contamination, avoiding safety filter false positives. After 4 rounds the judge summarizes.

**Board-game auto-detection**: when the message contains one of the following keywords, the session switches to turn-based game mode (A moves first, B responds, up to 6 rounds, then judge analysis):

> `五子棋` `圍棋` `象棋` `將棋` `西洋棋` `chess` `go` `gomoku` `shogi` `tic-tac-toe` `遊戲` `下棋`

#### Thinking Window

Displays collapsible reasoning from DeepSeek-R1, Qwen QwQ, and other chain-of-thought models (`🧠 Thinking…`).

#### Memory

| Type | Description |
|------|-------------|
| **Long-Term Memory (LTM)** | Persists across sessions; auto-injected into every Agent system prompt |
| **System Prompt** | Custom role instructions applied to every conversation (configurable in VS Code settings) |
| **Short-Term History** | Manually clearable per session |

### Supported Models

| Type | Notes |
|------|-------|
| **Local Ollama** | Any model Ollama supports — llama, mistral, deepseek-r1, qwq, llava, etc. |
| **GitHub Copilot** | If Copilot is installed and signed in, GPT-4o, Claude, Gemini and others appear in the model dropdown and can be mixed with Ollama in Team / Debate modes |

### Configuration

Search `amiAiClaw` in VS Code `settings.json`:

| Key | Default | Description |
|-----|---------|-------------|
| `amiAiClaw.urls` | `["http://localhost:11434"]` | Ollama server URL list (duplicate entries treated as disabled) |
| `amiAiClaw.model` | `llama3` | Default model |
| `amiAiClaw.systemPrompt` | `""` | Role instructions applied to every conversation |

```jsonc
{
  "amiAiClaw.urls": ["http://localhost:11434"],
  "amiAiClaw.model": "deepseek-r1:7b",
  "amiAiClaw.systemPrompt": "You are a senior engineer proficient in TypeScript and BIOS firmware. Reply in Traditional Chinese."
}
```

### Troubleshooting

**AMI-AiClaw command not found** → Confirm the extension is enabled in the Extensions panel, then `Ctrl+Shift+P` → Reload Window

**Cannot connect to Ollama** → Verify Ollama is running and `http://localhost:11434` responds

**Slow model responses** → Try a smaller model, or check that no other process is consuming VRAM / RAM

**Agent: Message exceeds token limit** → History is trimmed and retried automatically; if it persists, clear conversation history and restart

**Team / Debate model list empty** → Click 🔄 to refresh, or restart VS Code

**Copilot model refuses to respond** → Debate mode uses completely independent contexts per model; if it still occurs, switch to a different Copilot model

---

<a name="繁體中文"></a>
## 繁體中文

在 VS Code 側邊欄開啟 AI 聊天面板，直接連結本機 [Ollama](https://ollama.com/) 伺服器，不需要任何雲端訂閱。支援串流對話、程式碼生成、Agent 自動執行、多模型 Team 協作、雙模型辯論，以及棋類遊戲對戰。亦可混搭 GitHub Copilot 模型。

### 安裝

1. 從 [Releases](https://github.com/YCHsu661121/AMI-AiClaw/releases) 下載最新的 `ami-ai-claw-x.x.x.vsix`，或自行打包
2. VS Code → Extensions（`Ctrl+Shift+X`）→ 右上角 `…` → **Install from VSIX…**
3. 選擇 `.vsix` 檔案，重新載入視窗即完成

### 開啟聊天視窗

`Ctrl+Shift+P` → 搜尋 **AMI-AiClaw** → Enter。

### 模式說明

| 按鈕 | 模式 | 說明 |
|------|------|------|
| 💬 | **Ask** | 串流對話，保留歷史紀錄，可將回應程式碼插入游標處 |
| 🤖 | **Agent** | AI 自動讀寫檔案、執行指令完成複雜任務；達到 token 上限時自動裁剪並重試 |
| 👥 | **Team** | 多模型並行，協調員拆分任務，工作模型各自迭代，督導模型審查 |
| ⚔️ | **對話 / 遊戲** | 兩個 AI 獨立分析同一議題；偵測到棋類關鍵字時自動切換回合制遊戲模式 |
| ⏹ | **停止** | 中止進行中的 Agent / Team / 對話任務 |

#### Agent 工具

- 讀取 / 寫入 / 列出 / 搜尋工作區檔案
- 執行 shell 指令並捕獲輸出
- 查詢、建立、轉換 Jira Issue 狀態（需安裝 Atlassian for VS Code）
- 開立 Bitbucket Pull Request

達到 token 上限時自動裁剪舊的工具呼叫記錄並重試。

#### Team 模式流程

| Phase | 說明 |
|-------|------|
| 0 | 協調員（最具思考能力的模型或 Copilot）將任務拆成細緻子任務（📋 Todos 面板顯示進度） |
| 1 | 工作模型從佇列認領子任務各自執行；協調員審查，最多 100 輪迭代（至少 3 輪） |
| 2 | 協調員綜合所有工作結果 |
| 3 | Agent 執行必要的程式碼或檔案操作 |

#### 對話 / 遊戲模式

選擇 2 個模型（可加第 3 個裁判），輸入任何議題，兩個 AI 各自獨立分析，互不參考對方的回答，避免安全過濾器誤觸發。4 輪後由裁判綜合觀點。

**棋類遊戲自動偵測**：訊息中包含以下關鍵字時，自動切換為回合制遊戲模式，A 先手、B 接招，互傳棋步記錄，最多 6 回合後由第 3 個模型（裁判）分析整局：

> `五子棋` `圍棋` `象棋` `將棋` `西洋棋` `chess` `go` `gomoku` `shogi` `tic-tac-toe` `遊戲` `下棋`

#### 思考視窗

支援 DeepSeek-R1、Qwen QwQ 等思考型模型，回應旁顯示可折疊的推理過程（`🧠 思考中…`）。

#### 記憶管理

| 類型 | 說明 |
|------|------|
| **長期記憶（LTM）** | 跨對話持續保存，自動注入每次 Agent 的系統提示 |
| **角色設定（System Prompt）** | VS Code 設定中自訂每次對話的角色指令 |
| **對話歷史** | 可手動清除目前工作階段的短期記憶 |

### 支援的模型

| 類型 | 說明 |
|------|------|
| **Ollama 本機模型** | 任何 Ollama 支援的模型，包括 llama、mistral、deepseek-r1、qwq、llava 等 |
| **GitHub Copilot** | 已安裝並登入 Copilot 後，可在下拉選單選用 GPT-4o、Claude、Gemini 等；Team / 對話模式可混搭 Copilot 與 Ollama |

### 設定

在 VS Code `settings.json` 搜尋 `amiAiClaw`：

| 設定鍵 | 預設值 | 說明 |
|--------|--------|------|
| `amiAiClaw.urls` | `["http://localhost:11434"]` | Ollama 伺服器 URL 列表（重複出現視為停用） |
| `amiAiClaw.model` | `llama3` | 預設模型 |
| `amiAiClaw.systemPrompt` | `""` | 每次對話自動套用的角色設定 |

```jsonc
{
  "amiAiClaw.urls": ["http://localhost:11434"],
  "amiAiClaw.model": "deepseek-r1:7b",
  "amiAiClaw.systemPrompt": "你是一位熟悉 TypeScript 與 BIOS 韌體開發的資深工程師，請用繁體中文回答。"
}
```

### 疑難排解

**找不到 AMI-AiClaw 命令** → Extensions 頁面確認已啟用，再 `Ctrl+Shift+P` → Reload Window

**無法連線到 Ollama** → 確認 Ollama 正在執行（`http://localhost:11434` 可正常回應）

**模型回應緩慢** → 嘗試更小的模型，或確認沒有其他程式佔用 VRAM / 記憶體

**Agent 錯誤：Message exceeds token limit** → 已自動裁剪對話歷史並重試；若仍發生，請手動清除對話歷史

**Team / 對話模式模型清單空白** → 點擊 🔄 重新整理，或重啟 VS Code

**Copilot 模型拒絕回應** → 對話模式每個 AI 使用完全獨立的上下文；若仍發生請切換其他 Copilot 模型

---

*Author: Y.C. Hsu · License: MIT*
