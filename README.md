# AmiClaw — VS Code Extension

在 VS Code 側邊開啟 AI 聊天面板，直接連結本機 [Ollama](https://ollama.com/)，支援對話、寫程式碼、Agent 自動執行、多模型團隊討論。  
所有資料留在本機，不需要訂閱任何雲端服務。

---

## 安裝

1. 從 [Releases](https://github.com/YCHsu661121/AmiClaw/releases) 下載最新的 `ami-claw-x.x.x.vsix`（或自行打包）
2. VS Code → Extensions（`Ctrl+Shift+X`）→ 右上角 `…` → **Install from VSIX…**
3. 選擇下載的 `.vsix` 檔案，重新載入視窗即完成

---

## 開啟聊天視窗

按 `Ctrl+Shift+P`，搜尋 **AmiClaw**，按 Enter。

---

## 功能

| 功能 | 說明 |
|------|------|
| **對話模式** | 串流回應、歷史紀錄、程式碼插入到游標 |
| **Agent 模式** | AI 自動讀檔、寫檔、執行指令，完成複雜任務 |
| **自動模式** | 連續呼叫直到 AI 回覆 DONE，最多 100 輪 |
| **Team 模式** | 多模型並行，協調員拆分任務，各自迭代討論、互相審查 |
| **思考視窗** | 支援 DeepSeek-R1、Qwen QwQ 等思考型模型，顯示推理過程 |
| **記憶管理** | 長期記憶（LTM）持久保存對話摘要 |
| **GitHub Copilot** | 若已安裝 Copilot，可選其模型擔任 Team 協調員 |

### Team 模式流程

1. **Phase 0**：協調員（最具思考能力的模型或 Copilot）分析任務，自動拆成多個細緻子任務（📋 Todos 面板顯示進度）
2. **Phase 1**：所有工作模型從 Todos 佇列認領子任務，各自執行，協調員審查並給予最多 100 輪迭代建議（至少 3 輪）
3. **Phase 2**：協調員綜合所有工作結果
4. **Phase 3**：Agent 執行必要的程式碼或檔案操作

---

## 設定

在 VS Code `settings.json` 搜尋 `amiClaw`：

| 設定鍵 | 預設值 | 說明 |
|--------|--------|------|
| `amiClaw.url` | `http://localhost:11434` | Ollama 伺服器位址 |
| `amiClaw.model` | `llama3` | 預設模型 |

### 範例

```jsonc
{
  "amiClaw.url": "http://localhost:11434",
  "amiClaw.model": "deepseek-r1:7b"
}
```

---

## 疑難排解

**找不到 AmiClaw 命令** → Extensions 頁面確認已啟用，再 `Ctrl+Shift+P` → Reload Window

**無法連線到 Ollama** → 確認 Ollama 正在執行（`http://localhost:11434` 可以回應）

**模型回應緩慢** → 嘗試更小的模型，或確認沒有其他程式佔用記憶體
