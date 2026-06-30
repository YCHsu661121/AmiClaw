# AmiClaw vs. Claude-code: Deep Architectural Analysis & Roadmap

## 1. 底層架構深度對比 (Architectural DNA)

### A. AmiClaw: 「分層狀態機與角色驅動」模式 (Tiered State Machine & Persona-Centric)
透過分析 `src/autopilot/AutoPilotState.ts` 與系統流程圖，AmiClaw 的核心本質是一個**具備明確分層架構、複雜狀態管理與多模態整合能力的 Agent Orchestrator**。

* **核心架構 (Tiered Architecture):**
    * **UI Layer (`OllamaChatPanel`):** 負責 Webview 與 Extension 的橋樑，處理使用者互動與指令發送。
    * **Orchestration Layer (`QE`, `AE`, `TE`):** 
        * `QueryEngine` (QE): 處理單純問答與唯讀工具執行。
        * `AgentExecutor` (AE): 管理 Agent 的思考循環（Plan $\to$ Tool Call $\to$ Observe）。
        * `ToolExecutor` (TE): 負責具體動作的執行與權限稽核。
    * **Provider/System Layer:** 抽象化模型供應商 (Ollama, Copilot) 與外部系統整合 (WhatsApp, Jira, Rovo)。
* **能力注入：** 透過 `ToolRegistry` 提供結構化工具，並利用 `Proxy` 技術實現聊天歷史的自動監控與持久化。
* **數據驅動：** 內建高度精細的 **Telemetry (遙測) 機制**，包含 Token 使用量統計 (`trackUsage`) 與請求延遲追蹤 (`trackLatency`)。

### B. Claude-code: 「協議驅動與插件化」模式 (Protocol-driven & MCP-centric)
透過分析 `claude-code/package.json`，Claude-code 的核心本質是一個 **MCP (Model Context Protocol) Client**。

* **核心邏輯：** 採用 **Modular Plugin Architecture**。依賴大量 `@ant/computer-use-*` 與 `napi` 模組。
* **能力注入：** 透過 **MCP Protocol** 解耦。核心 CLI 不需要知道工具的具體實現，只需遵循標準與外部 Server 通訊。
* **擴充性：** 使用 Bun 運行並透過 `workspaces` 管理多個 package，其強項在於 **"Tool Extensibility & Ecosystem"**。

---

## 2. 技術維度對比表 (Technical Dimension)

| 維度 | AmiClaw (The Brain/Orchestrator) | Claude-code (The Limbs/Sensor) |
| :--- | :--- | :--- |
| **抽象層級** | **High-level Orchestration**: 關注於「如何思考、決態與管理分層邏輯」。 | **Low-level Interaction**: 關注於「如何感知環境與執行動作」。 |
| **上下文處理** | 依賴 `teamscontext.md` 與自定義 Prompt 注入。 | 以 ListNode/MCP 資源作為 Context 來源。 |
| **工具邊界** | 工具類別 (Types) 定定義在單一專案內，具備強大的權限控制能力。 | 工具由外部 MCP Server 提供，透過協議發現。 |
| **狀態管理** | 強大的多階段任務追蹤、Proxy-based 歷史持久化與 Telemetry 統計。 | 較輕量化的指令流與 REPL 交互。 |

---

## 3. Recent Achievements (近期開發成果)
*Update: 2026-XX-XX*
- [x] **Tool Registry Decoupling**: 已初步建立 `src/tools/ToolRegistry.ts` 與 `ToolTypes.ts`，開始脫離 `ollama-chat.ts` 的硬編碼模式。
- [x] **System Architecture Mapping**: 完成了系統流程的高階架構圖 (Mermaid) 與組件職責定義（QE/AE/TE 角色化）。
- [x] **Advanced Workspace Analysis**: 新增 `runTodoFile` 指令，實現由 AI 驅動的任務自動執行能力。
- [x] **Enhanced Monitoring**: 引入了檔案數量統計 (`showFileCount`) 與 Shell 輔助分析工具。

---

## 4. 重構藍圖：AmiClaw 升級路徑 (The "To-Do" Roadmap)

### Phase 1: 協議化工具層 & 核心拆分 (Decoupling & Modularization)
> **Status: IN PROGRESS**
> *此階段旨在將 `ollama-chat.ts` 的 God Class 拆解，並導入 MCP 發現機制。*

- [ ] **Engineering Execution**:
    - [x] `WebviewRenderer.ts` (已從核心邏輯分離)
    - [ ] `WhatsAppManager.ts` (進行中...)
    - [ ] `ToolExecutor.ts` (正從 switch/case 轉向 Registry 模式，強化權限模型與 Audit 流程)
    - [ ] `QueryEngine.ts` & `AgentExecutor.ts` (核心 Loop 的高度抽象化，實現與 UI 分離)
- [ ] **MCP Client Integration**: 引入 `@modelcontextprotocol/sdk`，使 AmiClaw 能直接調用 Claude-code 已有的 `@ant/*` 系列工具。
- [ ] **Goal**: 讓 AmiClaw 的 Agent 具備「看圖 (Image Processor)」與「處理網頁 (URL Handler)」的能力。

### Phase 2: 強化感知邊界 (Expanding Sensory Input)
- [ ] **集成 NAPI 模組**: 參考 Claude-code，將 `image-processor-napi` 等高效能的原生模組引入 AmiClaw 的開發環境。
- [ ] **實現 Web/Browser Tooling**: 利用 Playwright 驅動的瀏覽器工具，補足目前 Agent 只能讀取文字檔案的弱點。

### Phase 3: 統一協作標準 (Standardizing Multi-Agent Workflow)
- [ ] **MCP-compatible Prompts**: 重新設計 `AutoPilotPrompt.ts`，使其輸出符合 MCP 工具調用的結構化參數（JSON Schema）。
- [ ] **成果**: 達成「使用 AmiClaw 的多模型決策邏輯 (Manager Mode) $\to$ 驅動 Claude-code 的強大工具鏈 (MCP Tools)」之終極形態。

---
**結論分析完成。**
**核心價值發現：AmiClaw 需要 Claude-code 的「感官 (Sensors/MCP)」，而 Claude-code 需要 AmiClaw 的「理性 (Reasoning/Orchestration)」。**

---

## 5. 向 Claude 取經：未來改善藍圖 (GPT-5.4 深度分析)
> *協作者：GPT-5.4 ｜ 分析範圍：src/chat、src/tools、src/autopilot、src/context、src/memdir、src/team*

### 核心判斷
AmiClaw 目前最大的問題，不是能力不夠，而是**很多能力已經存在，卻還沒有被做成穩定、可組態、可隔離、可觀測的系統 primitive**。從 `AgentExecutor`、`QueryEngine`、`ToolRegistry`、`AutoPilot`、`TeamManager` 可以看出，AmiClaw 已經長出很多類 Claude 的器官；真正缺的是把這些器官整合成一套**產品級 control plane（神經系統）**。

短期方向不應是再加更多模式，而應先完成三件事：
1. 把已存在但未真正接線的能力接進主流程。
2. 把集中在 God class 與 giant switch 的邏輯抽成可宣告的協議。
3. 把探索、規劃、執行、驗證、權限、記憶分成彼此可觀測的階段。

### 5.1 Agentic Loop 設計
- **現況**：Ask（`QueryEngine`）與 Agent（`AgentExecutor`）兩條主路徑，仍偏向「一個大型 executor 靠 prompt 規範自己」，而非明確分層的研究/規劃/執行/驗證狀態機。
- **Claude 取經**：把探索與規劃外包給**隔離 context 的 Explore / Plan subagent**，主執行緒只保留必要摘要；每階段的權限、工具範圍、模型成本、停止條件都明確。
- **改善任務**：
    - [ ] 把 Agent loop 正式拆成 **Explore → Plan → Act → Verify** 四階段。
    - [ ] 引入結構化 `plan` 物件（目標 / 影響檔案 / 預期工具 / 驗證步驟 / 風險）。
    - [ ] 第一次寫檔或高風險工具後，強制進入 **Verify gate**（先跑最便宜的局部驗證）。
    - [ ] 統一 Ask 與 Agent 的工具 loop，共享 turn budget / tool batch / failure recovery / compaction。
    - [ ] 把拒答修正、重試、工具摘要做成**顯式狀態轉移**，而非長函式內的特殊分支。

### 5.2 工具系統 (Tool System)
- **現況**：工具定義已抽到 `ToolRegistry`，但執行仍集中在超大型 `ToolExecutor`（giant switch），權限只有 `ToolPolicies` 的粗粒度分類；`ToolAuditLog` 偏結果記錄，非完整 lifecycle observability。
- **Claude 取經**：工具有固定 lifecycle（PreToolUse / PermissionRequest / PostToolUse / PostToolBatch / Failure / PermissionDenied），安全、驗證、摘要、重試、紅線規則都插在標準節點上。
- **改善任務**：
    - [ ] 把 `ToolExecutor` 拆成 **handler registry**（每個工具實作 validate / classify / execute / summarize / audit 五介面）。
    - [ ] `ToolPolicies` 從 category 升級成 **rule-based policy**（讀/寫/刪/shell/network/secret/git/path pattern）。
    - [ ] 加入標準化 **lifecycle hook points**（beforeTool / afterTool / afterBatch / onFailure / onPermissionDenied）。
    - [ ] 工具回傳同時產出**模型摘要視圖**與 **結構化原始視圖**（給 UI/audit/telemetry）。
    - [ ] 內建 / 整合 / 未來 MCP 工具統一放在同一**協議層**（如何被宣告、發現、授權、追蹤）。

### 5.3 Context 管理
- **現況**：已有 `SystemPromptBuilder`、`WorkspaceDigest`、`TokenBudgetManager`、`HistoryCompactor`、`MicroCompactor`，但主流程只部分採用；記憶召回停留在 `findRelevantMemories` 的關鍵字匹配。
- **Claude 取經**：把**長期規則（CLAUDE.md）與長期記憶（auto memory）分開**；都不是硬塞全量，而是 index + lazy load + path-scoped rules + compaction 後重載；非必要研究結果不回流主 thread。
- **改善任務**：
    - [ ] 將 Ask / Agent / Team 的 compaction 統一成**單一服務**，移除重複的歷史摘要實作。
    - [ ] memory 分成**規則層**（repo-scoped instruction files）與**記憶層**（`extractMemories` 輸出轉成可檢索 metadata：type/tags/paths/recency/confidence）。
    - [ ] MEMORY index 保持極短，詳細內容分 topic files **延遲讀取**。
    - [ ] Team / Manager mode 改成 **digest-first，targeted-read second**，停止全量灌 workspace。
    - [ ] 導入 **path-scoped 規則**機制（不同目錄不同規則），取代持續擴張的全域 system prompt。

### 5.4 安全與權限 (最優先補強)
- **現況**：AutoPilot 模組（`AutoPilotPolicy` / `AutoPilotClassifier`）已存在，但 `autopilot/index.ts` 明寫**尚未接線**，主要只接了 UI toggle；真正 permission path 仍走 `ToolPolicies` 粗粒度判斷。
- **Claude 取經**：安全不是單一開關，而是**多層 permission system**（模式切換 + deny/ask/allow rules + auto classifier + tool hooks + PermissionDenied feedback + sandbox）。
- **改善任務**：
    - [ ] **P0**：把 AutoPilot 接到**唯一的 permission gateway**，所有工具呼叫先過 `requestPermission` → classifier 給 allow/ask/deny。
    - [ ] `ToolPolicies` 升級成 **effect-based policy**（read/write/replace/delete/shell/network/credential/git/external/outside-workspace）。
    - [ ] 為 shell command 補**參數級風險分析**（command pattern + path boundary）。
    - [ ] 敏感資訊保護從「輸出 redaction」提升到「**來源阻擋**」（讀 .env/secrets/workspace 外路徑先 deny/ask）。
    - [ ] 增加**決策可觀測性**（allow/ask/deny 原因、匹配規則、classifier 分數、使用者覆寫進 UI + telemetry）。

### 5.5 多代理協作 (Multi-Agent)
- **現況**：已有 team orchestration、manager mode、debate、todo panel、usage/latency 視覺化，但多半停留在 **prompt-chaining**，非正式 subagent runtime。
- **Claude 取經**：每個 subagent 是有明確 definition 的**可治理執行個體**（自己的 tools / model / memory / permission / hooks，且 context 與主 thread 隔離）。
- **改善任務**：
    - [ ] Team member 從 UI 選項升級成正式 **agent definition**（description / model / tools / maxTurns / memoryScope / permissionMode / isolation）。
    - [ ] orchestrator / worker prompt 流程轉成 **task protocol**（created/claimed/blocked/needs-review/completed 顯式狀態）。
    - [ ] 角色能力**硬性隔離**（explorer 只 read/search、implementer 才能 write、reviewer 只看 diff/test）。
    - [ ] worker 結果**預設只回摘要**，不回完整 transcript。
    - [ ] 中長期加入**隔離工作樹 / 工作目錄**，避免多個可寫 agent 互相踩檔案。

### 5.6 開發者體驗與工程可維護性
- **現況**：核心 wiring 大量集中在 `ollama-chat.ts`（UI/session/tool/memory/team/debate/telemetry 全包）；測試幾乎只有 `WebviewRenderer.test.js`，最危險的行為型邏輯缺自動驗證。
- **Claude 取經**：可組態化與可診斷性（settings scopes / memory files / subagent files / hooks / MCP config / status / doctor / memory introspection）。
- **改善任務**：
    - [ ] 拆解 `ollama-chat.ts` God class（UI session controller / agent runtime coordinator / memory coordinator / tool gateway / team orchestrator adapter）。
    - [ ] prompt / persona / policy / tool metadata 從 TS 硬編碼**外移到可版本化定義檔**。
    - [ ] 補核心測試（優先：`ToolPolicies`、`AutoPilotPolicy`、`AgentExecutor` 狀態轉移、compaction、memory retrieval、TeamManager task protocol）。
    - [ ] 增加診斷命令/視圖（生效權限規則 / 已載入記憶與規則 / context budget 分配 / 哪些 capability 已接線）。
    - [ ] usage/latency 視覺化延伸成完整 **runtime observability**（permission decisions / tool failure taxonomy / compaction triggers / memory recall hits）。

### 5.7 建議優先順序
- **P0｜先把已存在但未落地的能力接起來**
    - [ ] AutoPilot 真正接進 permission path。
    - [ ] `ToolExecutor` 拆成 handler registry，消除 giant switch。
    - [ ] 統一 Ask / Agent / Team 的 compaction 與 token budgeting。
    - [ ] `TeamManager` 全量 workspace 注入改成 digest-first / targeted-read。
- **P1｜把 AmiClaw 變成平台，而非一組模式集合**
    - [ ] 正式定義 agent / teammate spec。
    - [ ] 正式定義 tool lifecycle hooks 與 policy DSL。
    - [ ] memory 升級成「規則層 + 記憶層」雙軌。
    - [ ] 拆開 `ollama-chat.ts` 的 orchestration 與 UI wiring。
- **P2｜追上 Claude Code 差異化的產品級能力**
    - [ ] 背景 subagent 與 resumable worker。
    - [ ] 寫入 agent 的隔離工作樹。
    - [ ] repo-scoped instructions / agent files / hooks / memory files 完整檔案化。
    - [ ] status / memory / hooks / doctor 等 introspection surfaces。

### 最後結論 (GPT-5.4)
> AmiClaw 不是還沒變成 Claude Code，而是**已經長出很多類 Claude 的器官，卻還缺一套把它們整合成產品級運作系統的神經系統**。最該學的不是新增功能，而是學 Claude 如何把探索、規劃、工具、權限、記憶、多代理與設定治理做成一套**可宣告、可隔離、可觀測、可逐步演進的 control plane**。
>
> 濃縮成一句 roadmap：**先完成接線，再完成協議化，最後再追求更強的 agent 體驗。**
