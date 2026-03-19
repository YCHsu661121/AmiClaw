# AmiClaw — VS Code Extension

在 VS Code 側邊開啟 AI 聊天面板，直接連結本機 [Ollama](https://ollama.com/)，支援對話、寫程式碼、Agent 自動執行、多模型團隊討論、雙模型對話辯論，以及棋類遊戲對戰。  
所有資料留在本機，不需要訂閱任何雲端服務。亦支援 GitHub Copilot 模型一起混搭使用。

---

## 最近更新

- 新增：在模型選擇旁顯示 Copilot 模型的「倍數」標籤（例如 `1x`、`3x`、`0x`、`10% off`），該標籤也會顯示於 Team / 對話的模型清單，方便快速辨識模型的相對成本或效能。
- 修正：切換模型時僅在「相同 Ollama server」上會執行舊模型的 VRAM 卸載並等待釋放；若新模型位於不同 server，將跳過 VRAM 卸載與等待，避免不必要的延遲。

## 安裝

1. 從 [Releases](https://github.com/YCHsu661121/AmiClaw/releases) 下載最新的 `ami-claw-x.x.x.vsix`（或自行打包）
2. VS Code → Extensions（`Ctrl+Shift+X`）→ 右上角 `…` → **Install from VSIX…**
3. 選擇下載的 `.vsix` 檔案，重新載入視窗即完成

---

## 開啟聊天視窗

按 `Ctrl+Shift+P`，搜尋 **AmiClaw**，按 Enter。

---

## 功能

| 按鈕 | 功能 | 說明 |
|------|------|------|
| 💬 | **Ask 模式** | 直接對話，串流回應，歷史紀錄，程式碼插入到游標 |
| 🤖 | **Agent 模式** | AI 自動讀檔、寫檔、執行指令，完成複雜任務；對話歷史過長時自動裁剪並重試 |
| 👥 | **Team 模式** | 多模型並行，協調員拆分任務，各自迭代討論、互相審查 |
| ⚔️ | **對話模式** | 兩個 AI 就同一議題各自獨立分析辯論；輸入棋類關鍵字自動切換為遊戲對戰模式 |
| ⏹ | **停止** | 中止 Agent / Team / 對話 的進行中任務 |

### Agent 模式

AI 可使用以下工具自動完成任務：

- 讀取/寫入/列出/搜尋工作區檔案
- 執行 shell 指令
- 查詢 Jira Issue（需安裝 Atlassian for VS Code）
- 建立 Jira Issue、轉換狀態、開 Bitbucket PR

遇到 token 上限時自動裁剪舊的工具呼叫記錄並重試。

### Team 模式流程

1. **Phase 0**：協調員（最具思考能力的模型或 Copilot）分析任務，自動拆成多個細緻子任務（📋 Todos 面板顯示進度）
2. **Phase 1**：所有工作模型從 Todos 佇列認領子任務，各自執行，協調員審查並給予最多 100 輪迭代建議（至少 3 輪）
3. **Phase 2**：協調員綜合所有工作結果
4. **Phase 3**：Agent 執行必要的程式碼或檔案操作

### ⚔️ 對話模式

選擇 2 個模型（可加第 3 個裁判），輸入任何議題，兩個 AI 會各自獨立分析，互不參考對方的回答，避免安全過濾器誤觸發。進行 4 輪後由裁判綜合觀點。

**棋類遊戲自動偵測**：訊息中包含以下關鍵字時，自動切換為回合制遊戲模式，A 先手、B 接招，互傳棋步記錄，最多 6 回合後由第 3 個模型（裁判）分析整局：

> `五子棋`、`圍棋`、`象棋`、`將棋`、`西洋棋`、`chess`、`go`、`gomoku`、`shogi`、`tic-tac-toe`、`遊戲`、`下棋`

### 思考視窗

支援 DeepSeek-R1、Qwen QwQ 等思考型模型，回應旁顯示可折疊的推理過程（`🧠 思考中…`）。

### 記憶管理

- **長期記憶（LTM）**：跨對話持續保存，自動注入每次 Agent 的系統提示
- **角色設定（System Prompt）**：VS Code 設定中自訂每次對話的角色指令
- **對話歷史**：可手動清除目前的短期記憶

---

## 支援的模型

| 類型 | 說明 |
|------|------|
| **Ollama 本機模型** | 任何 Ollama 支援的模型，包括 llama、mistral、deepseek-r1、qwq 等 |
| **GitHub Copilot** | 若已安裝 GitHub Copilot 擴充功能並登入，可在下拉選單任意選用 GPT-4o、Claude、Gemini 等模型；Team / 對話模式也可混搭 Copilot 與 Ollama |

---

## 設定

在 VS Code `settings.json` 搜尋 `amiClaw`：

| 設定鍵 | 預設值 | 說明 |
|--------|--------|------|
| `amiClaw.url` | `http://localhost:11434` | Ollama 伺服器位址 |
| `amiClaw.model` | `llama3` | 預設模型 |
| `amiClaw.systemPrompt` | `""` | 每次對話自動套用的角色設定 |

### 範例

```jsonc
{
  "amiClaw.url": "http://localhost:11434",
  "amiClaw.model": "deepseek-r1:7b",
  "amiClaw.systemPrompt": "你是一位熟悉 TypeScript 與 BIOS 韌體開發的資深工程師，請用繁體中文回答。"
}
```

---

## 疑難排解

**找不到 AmiClaw 命令** → Extensions 頁面確認已啟用，再 `Ctrl+Shift+P` → Reload Window

**無法連線到 Ollama** → 確認 Ollama 正在執行（`http://localhost:11434` 可以回應）

**模型回應緩慢** → 嘗試更小的模型，或確認沒有其他程式佔用記憶體

**Agent 錯誤：Message exceeds token limit** → 已自動裁剪對話歷史並重試；若仍發生，請手動清除對話歷史後重新開始

**Team / 對話模式模型清單空白** → 點擊 🔄 重新整理；或重啟 VS Code 讓模型清單重新載入

**Copilot 模型拒絕回應（「抱歉，我無法協助」）** → 對話模式使用完全獨立的上下文，不會傳遞對方的回答，應可正常運作；若仍發生請嘗試切換其他 Copilot 模型
