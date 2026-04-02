# ClaudeDoTo.md

> 目的：提供給 LLM / Agent 閱讀的移植分析文件。  
> 範圍：比較 `d:\Tools\claude-code` 與 `d:\Tools\Ollama`，整理 Claude Code 的功能方塊圖、與 Ollama 現況落差、以及適合移植的功能清單。  
> 注意：本文件以**架構參考、模組職責、功能設計**為主，不建議逐字搬運來源程式碼。

---

## 1. 專案定位摘要

### 1.1 claude-code

來源觀察：
- `package.json`
- `src/entrypoints/cli.tsx`
- `src/main.tsx`
- `src/tools.ts`
- `docs/introduction/architecture-overview.mdx`
- `README.md`
- `TODO.md`
- `build.ts`
- `packages/*`

定位：
- 一個 **Bun workspaces monorepo**。
- 主要產品是 **終端型 AI coding assistant CLI**。
- 核心強項不是單一 UI，而是完整的：
  - CLI 入口與模式切換
  - 對話編排 / Agent loop
  - 多 provider API 通訊
  - 大量工具系統
  - 權限與政策控制
  - MCP 生態整合
  - session / transcript / memory / compact / hooks / plugins
- 設計重點是：**可長時間運作的工程化 AI runtime**。

### 1.2 Ollama

來源觀察：
- `package.json`
- `Context.md`
- `src/extension.ts`
- `src/ollama-chat.ts`
- `src/webview/WebviewRenderer.test.js`
- `scripts/health-check.js`
- `docker-compose.yml`
- `knip.json`

定位：
- 一個 **VS Code Extension**。
- 主要產品是 **本機 Ollama 聊天側邊欄 + Agent 工具呼叫 + 多角色協作**。
- 已有不少實用整合：
  - Webview chat UI
  - Agent tool calling
  - Team / debate / manager 模式
  - WhatsApp / Jira / Jenkins / browser / file / git / tests 等工具
- 目前最大問題不是功能太少，而是：
  - `src/ollama-chat.ts` 過大
  - UI / orchestration / tool executor / integrations / session state 高度耦合
  - 缺乏像 Claude Code 那樣清楚的層次化 runtime 邊界

---

## 2. claude-code 功能方塊圖

以下方塊圖是依據已閱讀檔案與文件整理出的**高層架構**。

## 2.1 五層核心架構

```text
[ User / Terminal ]
        |
        v
+-------------------------+
|  Interaction Layer      |
|  REPL / screens / Ink   |
|  slash commands         |
+-------------------------+
        |
        v
+-------------------------+
|  Orchestration Layer    |
|  QueryEngine            |
|  session / transcript   |
|  cost tracking          |
|  resume / file history  |
+-------------------------+
        |
        v
+-------------------------+
|  Agentic Loop Layer     |
|  query.ts               |
|  model call loop        |
|  tool-use loop          |
|  compaction / retry     |
+-------------------------+
        |
        v
+-------------------------+
|  Tool Capability Layer  |
|  tools.ts / Tool.ts     |
|  file/bash/web/search   |
|  agent/task/mcp/etc     |
+-------------------------+
        |
        v
+-------------------------+
|  Provider / Infra Layer |
|  services/api/*         |
|  Anthropic/Bedrock      |
|  Vertex/Azure/OAuth     |
|  MCP / plugins / policy |
+-------------------------+
```

## 2.2 claude-code 模組責任圖

```text
src/entrypoints/cli.tsx
  -> 啟動入口
  -> feature/MACRO polyfill
  -> fast-path dispatch
  -> 動態載入 main.tsx

src/main.tsx
  -> CLI 命令註冊
  -> 啟動初始化
  -> auth / config / migrations / policy / telemetry
  -> 啟動 REPL 或其他子命令

src/QueryEngine.ts
  -> 會話狀態編排
  -> transcript / usage / file history
  -> query() 呼叫封裝

src/query.ts
  -> 單回合 agentic loop
  -> 上下文預處理
  -> 呼叫模型
  -> 收集 tool use
  -> 執行工具
  -> 判斷是否繼續下一輪

src/tools.ts + src/Tool.ts
  -> 工具註冊中心
  -> feature flag / 權限過濾
  -> built-in tools + MCP tools 合併

src/services/api/*
  -> 多 provider 通訊層
  -> stream / request assembly / model handling

src/services/mcp/*
  -> MCP server/client/config/resource/tool 整合

src/services/compact/*
src/services/SessionMemory/*
src/services/extractMemories/*
  -> 上下文壓縮與記憶

packages/*
  -> 原生或平台相關能力
  -> 音訊、圖片、macOS computer use、URL handler 等
```

## 2.3 claude-code 擅長的核心能力

### A. Runtime orchestration 能力
- 清楚分成入口、編排、迴圈、工具、通訊層。
- 適合長回合 Agent 任務。
- 能在大上下文與多工具間維持狀態一致性。

### B. Tool platform 能力
- `src/tools.ts` 是清楚的工具總表。
- 工具啟用條件、deny rules、環境開關、MCP 合併都有明確機制。
- 工具不是零散功能，而是被當成**平台能力**管理。

### C. Context / memory / compact 能力
- 有完整 system prompt 建構、上下文組裝、壓縮、session memory、extract memories。
- 這是 Claude Code 能處理長對話與大型任務的重要原因。

### D. Provider abstraction 能力
- 通訊層可支援多家 provider。
- API 差異被收斂到 `services/api/*`。

### E. MCP / plugin / slash command 生態
- 支援 MCP、plugin、skills、commands。
- 代表它比較像 AI 開發 runtime，而非單一聊天 UI。

---

## 3. Ollama 現況功能方塊圖

## 3.1 目前高層結構

```text
[ VS Code Extension Host ]
        |
        v
+-----------------------------+
| extension.ts                |
| - activate                  |
| - commands                  |
| - sessions tree view        |
+-----------------------------+
        |
        v
+-----------------------------+
| OllamaChatPanel             |
| src/ollama-chat.ts          |
| - panel lifecycle           |
| - message router            |
| - chat/agent/team/debate    |
| - tool execution            |
| - session/history/state     |
| - integrations              |
+-----------------------------+
        |
        +--------------------+--------------------+-------------------+
        |                    |                    |                   |
        v                    v                    v                   v
+---------------+   +----------------+   +----------------+  +----------------+
| Webview UI    |   | Ollama/Copilot |   | VS Code tools  |  | External integ |
| Renderer      |   | model calls    |   | files/git/test |  | Jira/WA/Jenkins|
+---------------+   +----------------+   +----------------+  +----------------+
```

## 3.2 實際狀況

`Context.md` 已明確指出：
- `src/ollama-chat.ts` 約 9740 行，原本是 God class。
- 已開始拆分，但目前核心仍偏集中。
- 已規劃拆成：
  - `panels/OllamaChatPanel.ts`
  - `chat/QueryEngine.ts`
  - `chat/AgentExecutor.ts`
  - `team/TeamManager.ts`
  - `debate/DebateEngine.ts`
  - `integrations/JiraManager.ts`
  - `integrations/WhatsAppManager.ts`
  - `tools/ToolExecutor.ts`
  - `webview/WebviewRenderer.ts`
  - `session/SessionManager.ts`
  - `models/ModelFetcher.ts`
  - `state/PanelState.ts`

這個拆分方向，**本質上已經很接近 Claude Code 的層次化設計**。

---

## 4. claude-code vs Ollama 對照

## 4.1 一句話差異

- **claude-code**：成熟的 CLI 型 AI runtime / agent platform。
- **Ollama**：偏向 VS Code 內嵌 chat product，功能很多，但 orchestration 與 capability platform 還在整理中。

## 4.2 功能矩陣

| 面向 | claude-code | Ollama | 評語 |
|---|---|---|---|
| 產品形態 | CLI / terminal-first | VS Code extension / webview-first | 介面形態不同，但 backend runtime 可借鏡 |
| 架構分層 | 很清楚 | 正在拆分中 | Claude Code 明顯更成熟 |
| 會話編排 | 強 | 中到強 | Ollama 有 session，但抽象度較低 |
| Agent loop | 強 | 中到強 | Ollama 已有 agent/tool loop，但較集中在單檔 |
| 工具平台化 | 強 | 中 | Ollama 工具很多，但治理規則較鬆散 |
| Provider abstraction | 強 | 中 | Ollama 目前主軸是 Ollama + Copilot |
| MCP 整合 | 強 | 較弱 | Claude Code 明顯更完整 |
| Context 壓縮/記憶 | 強 | 中 | Ollama 有 auto summarize，但體系較簡化 |
| 權限模型 | 強 | 中 | Claude Code 的 permission boundary 更成熟 |
| 插件/技能系統 | 強 | 弱 | Ollama 目前偏內建工具集合 |
| 平台原生能力 | 有 packages | 少量 | Claude Code monorepo packages 可提供靈感 |
| VS Code 整合 | 弱 | 強 | 這是 Ollama 優勢 |
| 多角色/辯論 | 有 swarm 類能力 | 強 | Ollama 在 team/debate 很積極 |
| 外部整合 | 一般 | 強 | Ollama 已有 Jira/WhatsApp/Jenkins |

---

## 5. 建議移植的不是「UI」，而是「能力骨架」

對 Ollama 最有價值的，不是照搬 Claude Code 的 terminal UI，而是移植以下骨架：

1. **清楚的 runtime 分層**
2. **工具平台治理**
3. **context / memory / compact 管線**
4. **provider abstraction**
5. **MCP / plugin / skill 擴展點**
6. **session transcript / resume / audit / cost 統計體系**

---

## 6. 可移植功能清單（依價值排序）

以下清單是為了讓使用者從中選擇功能移植。

### P0 = 高價值、低到中風險、應優先做
### P1 = 中高價值、需要較大重構
### P2 = 高成本或平台差異大，延後

---

## 6.1 P0-1：建立 Claude-like 分層 Query Runtime

### 目標
把 Ollama 現有 `ollama-chat.ts` 中混合的邏輯，重構為類似 Claude Code 的：
- Entry / Panel lifecycle
- Query orchestration
- Agent loop
- Tool registry / executor
- Provider client
- Context builder
- Session state

### 參考來源
- `src/entrypoints/cli.tsx`
- `src/main.tsx`
- `src/QueryEngine.ts`
- `src/query.ts`
- `src/tools.ts`

### 對 Ollama 的對應拆分

```text
extension.ts
  -> 只保留 VS Code 啟動/命令/樹狀檢視

panels/OllamaChatPanel.ts
  -> webview lifecycle + host-message dispatch

chat/QueryEngine.ts
  -> build prompt / chat history / context assembly / usage

chat/AgentExecutor.ts
  -> tool loop / iteration / stop / compact trigger

tools/ToolRegistry.ts
  -> AGENT_TOOLS 宣告與啟用條件

tools/ToolExecutor.ts
  -> executeTool() + permission + cache + audit

providers/OllamaProvider.ts
providers/CopilotProvider.ts
  -> model call abstraction

context/ContextBuilder.ts
  -> active file / open files / workspace / long-term memory / prompt parts

session/SessionStore.ts
  -> sessions / import / export / fork / rename / delete
```

### 收益
- 降低 God class 複雜度。
- 讓後續功能移植成本下降。
- 讓 team / debate / agent 共用同一套核心能力。

### 風險
- 需要大規模移動現有方法與 state。
- 需要先定義跨模組 state contract。

### 建議
- **強烈建議先做**。
- 這是後面所有移植工作的基礎。

---

## 6.2 P0-2：移植 Claude Code 的 Tool Platform 思維

### 目標
把 Ollama 目前「很多工具 case」提升為「工具平台」。

### Claude Code 可借鏡點
- 工具集中註冊 `tools.ts`
- 權限過濾 `filterToolsByDenyRules()`
- built-in 與 MCP tools 合併 `assembleToolPool()`
- tool enable / feature gate / mode-based filtering

### Ollama 建議設計

```text
tools/
  ToolTypes.ts
  ToolRegistry.ts
  ToolPolicies.ts
  ToolExecutor.ts
  ToolCache.ts
  ToolAudit.ts
```

每個工具至少要有：
- `name`
- `description`
- `inputSchema`
- `category`
- `requiresConfirm`
- `isEnabled(context)`
- `execute(args, runtime)`

### 收益
- 工具新增成本下降。
- Jira / Jenkins / WhatsApp / Browser / Git / DB / Tests 都能統一治理。
- 更容易做 allow/deny、always allow、policy、審計。

### 建議功能
- 依工具類別分類：`read` `write` `run` `delete` `network` `jira` `browser`。
- 統一審批規則：
  - category policy
  - per-tool policy
  - session always allow
  - global always confirm
- 對 tool result 做快取與失效。

### 建議
- **非常值得移植**。
- 這是 Claude Code 對 Ollama 最有價值的骨架之一。

---

## 6.3 P0-3：移植 Context Builder + Memory Pipeline

### 目標
把 Ollama 現有 prompt 拼接與 history 管理，升級成固定管線。

### Claude Code 可借鏡點
- system prompt 由多段組成
- context 不是只有聊天紀錄，還包含：
  - git 狀態
  - 工作區資訊
  - memory
  - tool state
  - 其他系統提示
- 在 token 超限前，做 compact / summarize / trim

### Ollama 建議模組

```text
context/
  SystemPromptBuilder.ts
  WorkspaceContextBuilder.ts
  MemoryStore.ts
  HistoryCompactor.ts
  TokenBudgetManager.ts
```

### 最小可移植版本
- 統一 `buildSystemContent()` 的來源：
  - persona
  - long-term memory
  - workspace summary
  - active file summary
  - tool rules
  - Atlassian hard rules
- 增加 history budget 邏輯：
  - 超過閾值時先 summarize 舊訊息
  - summarize 後保留最近 N 輪原文
- 增加 per-session condensed memory

### 收益
- 提升長對話穩定度。
- 降低 Agent 忘記規則或上下文漂移。
- 對 team / debate / agent 都有直接收益。

### 建議
- **優先度很高**。

---

## 6.4 P0-4：移植 Session Transcript / Resume / Audit 思維

### 目標
把 Ollama session 提升為可追蹤、可恢復、可審計的 runtime session。

### Claude Code 可借鏡點
- transcript 持久化
- resume conversation
- usage tracking
- file history / snapshots

### Ollama 可直接增強的項目
- session metadata：
  - createdAt
  - lastActiveAt
  - selectedModel
  - mode(chat/agent/team/debate)
  - token estimate
  - summary
- 持久化 transcript：
  - user / assistant / tool call / tool result / approvals / errors
- restore session：
  - 開啟 VS Code 後恢復未完成 agent 狀態
- audit log 結構化：
  - tool name
  - args hash/snippet
  - result status
  - duration
  - source(UI/WA/Jira command)

### 收益
- 更適合真實開發工作流。
- 有助於除錯、回溯、合規。

### 建議
- **值得做，且與現有功能相容性高**。

---

## 6.5 P1-1：建立 Provider Abstraction Layer

### 目標
把現在 Ollama / Copilot / OpenAI-compatible 的呼叫方式抽象化。

### Claude Code 可借鏡點
- 通訊層與 orchestration 分離
- provider-specific 細節不污染上層 query flow

### 建議介面

```text
providers/
  types.ts
  OllamaProvider.ts
  CopilotProvider.ts
  OpenAICompatibleProvider.ts
  ProviderRegistry.ts
```

統一介面：
- `listModels()`
- `generate()`
- `chat()`
- `supportsTools()`
- `supportsThinking()`
- `supportsImages()`
- `normalizeToolCalls()`
- `estimateTokenUsage()`

### 收益
- 新增模型來源更容易。
- team / debate / agent 不再依賴 provider 特判。

### 建議
- 若未來 Ollama 要走多模型平台，這個必做。

---

## 6.6 P1-2：導入 MCP-first 擴充架構

### 目標
讓 Ollama 的工具不只內建，還能外接 MCP。

### Claude Code 可借鏡點
- `services/mcp/*`
- built-in 與 MCP tool pool 合併
- resource / command / server config 管理

### Ollama 的實際意義
目前已有很多內建工具，但如果導入 MCP：
- 可把一部分自製工具改為外部伺服器能力
- 可直接串接第三方 MCP 生態
- 可減少 extension 本體膨脹

### 最小落地方案
- 先支援 MCP server config
- 能列出 tools/resources
- 能把 MCP tools 注入 agent tool registry
- 先不做完整 plugin marketplace

### 收益
- 擴展能力大幅上升。
- 讓 Ollama 從單體 extension 變成 AI platform host。

### 成本
- 中高。
- 需要 tool schema / transport / error handling / approval 流程。

---

## 6.7 P1-3：移植 Slash Command / Skill 架構

### 目標
把常用高階操作收斂成指令層，而不是只靠自然語言 prompt。

### Claude Code 可借鏡點
- `/doctor`
- `/resume`
- `/memory`
- `/compact`
- `/model`
- `/permissions`
- `/review`
- `/tasks`

### Ollama 建議版本
在 webview 內支援命令輸入：
- `/doctor`
- `/models`
- `/memory`
- `/history`
- `/session export`
- `/tools`
- `/jira`
- `/wa`
- `/jenkins`
- `/compact`
- `/audit`

### 收益
- 操作一致性更高。
- LLM 與使用者都更容易觸發固定工作流。

### 建議
- 可在 P0 完成後加入。

---

## 6.8 P1-4：移植 Permission Boundary 設計

### 目標
讓 Ollama 的工具批准機制更像 Claude Code，而不是只靠 scattered confirm logic。

### Claude Code 可借鏡點
- permission mode
- deny rules
- 路徑規則
- plan mode / auto mode 差異

### Ollama 可實作
- session policy
- workspace policy
- tool category policy
- path scope policy
- network policy
- integration policy（Jira/WA/Jenkins/browser）

### 收益
- Agent 更安全可控。
- 可支援企業化使用情境。

### 建議
- 與 Tool Platform 一起做效果最好。

---

## 6.9 P2-1：移植 Plugin 架構

### 價值
高，但不是短期最划算。

### 原因
- Claude Code 的 plugin 基礎設施很完整，但 Ollama 目前更需要先穩定核心 runtime。
- 若過早做 plugin，會把不穩定的內部 API 外部化。

### 建議
- 等 P0/P1 穩定後再做。

---

## 6.10 P2-2：移植 Computer Use / Native packages

### 參考來源
- `packages/@ant/computer-use-swift`
- `packages/@ant/computer-use-input`
- `packages/audio-capture-napi`
- `packages/image-processor-napi`

### 觀察
- 有些 package 已完整，有些是 stub 或平台限定。
- 很多偏 macOS / 本機原生能力。

### 對 Ollama 的意義
- 若你要做桌面操作 agent，可參考設計。
- 但目前 Ollama 已是 VS Code extension，短期更需要的是 runtime 重構，不是桌面自動化。

### 建議
- 延後。

---

## 7. 建議移植順序

## 7.1 最推薦路線

```text
Phase 1: Runtime 骨架重構
  1. Panel / QueryEngine / AgentExecutor / ToolExecutor / SessionStore 拆出
  2. ToolRegistry + ToolPolicy + ToolAudit 統一
  3. ContextBuilder + HistoryCompactor + MemoryStore 建立

Phase 2: 能力升級
  4. Provider abstraction
  5. Transcript / Resume / richer audit / stats
  6. Slash commands

Phase 3: 生態擴展
  7. MCP integration
  8. Skill / plugin system
  9. Native/computer-use capabilities
```

## 7.2 若只能選 3 個功能移植

### 選項 A：最實用
1. Query runtime 分層
2. Tool platform + permission policy
3. Context / memory / compact pipeline

### 選項 B：想做平台化
1. Tool platform
2. Provider abstraction
3. MCP integration

### 選項 C：想提升產品可用性
1. Session transcript / resume / audit
2. Slash commands
3. Context compact / memory

---

## 8. 給 LLM 的移植決策建議

### 若目標是「先讓 Ollama 更穩定」
優先做：
- `P0-1 Runtime 分層`
- `P0-2 Tool Platform`
- `P0-3 Context + Memory`

### 若目標是「讓 Ollama 更像 Claude Code」
優先做：
- `P0-1 Runtime 分層`
- `P1-1 Provider abstraction`
- `P1-2 MCP integration`
- `P1-3 Slash command`

### 若目標是「企業內部工作流助理」
優先做：
- `P0-2 Tool Platform`
- `P1-4 Permission Boundary`
- `P0-4 Transcript / Audit / Resume`

---

## 9. 直接對應表：Claude Code 概念 -> Ollama 應落在哪裡

| Claude Code 概念 | Claude 來源 | Ollama 建議位置 |
|---|---|---|
| CLI entry / bootstrap | `src/entrypoints/cli.tsx` | `extension.ts` + `panels/OllamaChatPanel.ts` |
| 主程式初始化 | `src/main.tsx` | `extension.ts` / `bootstrap/*` |
| QueryEngine | `src/QueryEngine.ts` | `chat/QueryEngine.ts` |
| Agentic loop | `src/query.ts` | `chat/AgentExecutor.ts` |
| Tool registry | `src/tools.ts` | `tools/ToolRegistry.ts` |
| Tool interface | `src/Tool.ts` | `tools/ToolTypes.ts` |
| Provider API layer | `src/services/api/*` | `providers/*` |
| MCP subsystem | `src/services/mcp/*` | `integrations/mcp/*` |
| Memory / compact | `services/compact/*`, `SessionMemory/*` | `context/*`, `memory/*` |
| transcript / resume | session/transcript 相關 | `session/*` |
| command system | `commands/*` | webview slash command / host commands |

---

## 10. 最終結論

### 結論一句話
**claude-code 最值得移植到 Ollama 的，不是 CLI 介面，而是它背後的 AI runtime 架構。**

### 最有價值的移植標的
1. **Query runtime 分層**
2. **Tool platform + permission boundary**
3. **Context / memory / compact pipeline**
4. **Provider abstraction**
5. **MCP 擴展點**

### 不建議一開始就移植
- terminal UI / Ink REPL
- platform-specific native packages
- 完整 plugin marketplace
- 低優先 feature flags 世界

---

## 11. 建議下一步（可供使用者選擇）

### Option 1：先做架構重構
- 產出 `Ollama Runtime Refactor Plan`
- 目標：把 `ollama-chat.ts` 拆成 8~12 個模組

### Option 2：先做工具平台
- 產出 `ToolRegistry.ts` / `ToolPolicies.ts` / `ToolExecutor.ts` 設計稿
- 目標：把現有工具正式平台化

### Option 3：先做記憶與壓縮
- 產出 `MemoryStore.ts` / `HistoryCompactor.ts` / `TokenBudgetManager.ts` 設計稿
- 目標：提升長對話與 Agent 穩定度

### Option 4：先做 MCP
- 產出 `MCP integration MVP` 設計稿
- 目標：讓 Ollama 成為可擴展平台

---

## 12. LLM 可直接使用的決策摘要

```text
若只選一件事：選「Runtime 分層重構」。
若選兩件事：加上「Tool Platform」。
若選三件事：再加上「Context/Memory/Compact」。
若要平台化：之後做 Provider abstraction 與 MCP。
```

---

## 13. 進度紀錄（2026-04-02）

### 13.1 本次 session 完成事項

- ✅ **建立 `ToDm.md`**（位置：`C:\Users\YCHsu\.vscode\extensions\localdev.ami-ai-claw-0.0.1\ToDm.md`）
  - 完整比較 Ollama 與 claude-code / Copilot 的 11 個差異面向
  - 涵蓋：執行模式、模型生態、Agent 工具呼叫、多伺服器容錯、推理模式、Token 計費、WhatsApp 整合
  - 列出短/中/長期行動項目，包含 `ollama-chat.ts` 拆分目標模組清單

- ✅ **確認 Ollama 與 Copilot 的核心分工**
  - Ollama = 主力（本地、免費、完整 Agent tools）
  - Copilot = 補充（雲端、計費、快速、推理模型）
  - 兩者共用同一套 UI，但底層 transport 與 function calling 能力差異顯著

### 13.2 `ollama-chat.ts` 拆分目標（確認版）

依 `ToDm.md` 與本文件 `P0-1` 對照，確認拆分模組清單：

```text
src/
  panels/
    OllamaChatPanel.ts          ← panel lifecycle + message dispatch
  chat/
    QueryEngine.ts              ← build prompt / context / usage
    AgentExecutor.ts            ← tool loop / iteration / stop / compact
  tools/
    ToolTypes.ts
    ToolRegistry.ts             ← AGENT_TOOLS 宣告與啟用條件
    ToolPolicies.ts             ← allow / deny / confirm 規則
    ToolExecutor.ts             ← executeTool() + permission + cache + audit
    ToolCache.ts                ← 30s TTL, write-invalidate
    ToolAudit.ts                ← 200 條結構化審計記錄
  providers/
    OllamaProvider.ts           ← HTTP /api/generate + /api/chat + /api/tags
    CopilotProvider.ts          ← vscode.lm API wrapper
    ProviderRegistry.ts         ← listModels() + normalizeToolCalls()
  context/
    ContextBuilder.ts           ← system prompt 組裝管線
    HistoryCompactor.ts         ← token 超限前 summarize 舊訊息
    MemoryStore.ts              ← 長期記憶 (globalState per-workspace)
  session/
    SessionStore.ts             ← 多 session 歷史 / import / export
    TranscriptLog.ts            ← 完整對話紀錄 + tool call 紀錄
  integrations/
    WhatsAppManager.ts          ← Baileys socket 獨立管理
    JiraManager.ts
    JenkinsManager.ts
  webview/
    WebviewRenderer.ts          ← HTML/CSS/JS 生成（已部分分離）
  state/
    PanelState.ts               ← _agentRunning / _streamMode / _alwaysAllow
```

### 13.3 Ollama vs Copilot 工具呼叫差距（關鍵議題）

| 面向 | Ollama | Copilot |
|------|--------|---------|
| Function calling | ✅ 原生 `/api/chat` `tools` 參數 | ❌ 需手動文字解析 |
| 結構化 tool_calls | ✅ 回傳 `message.tool_calls[]` | ❌ 無保證格式 |
| Agent loop | ✅ 完整 20 步循環 | ⚠️ 部分支援 |

**待解決：** 讓 Copilot 也能參與 Agent loop，需在 `AgentExecutor.ts` 加入 response-parsing fallback，透過 `ProviderRegistry.normalizeToolCalls()` 統一介面。

### 13.4 UsageStats 持久化問題

- 目前 `_usageStats` 僅存於 session 記憶體，關閉 VS Code 分頁即清除
- 需改用 `vscode.globalState.update('usageStats', ...)` 並按 workspace 分區
- 與 `TranscriptLog.ts` 一併處理（同屬 session 資料遺失問題）

### 13.5 下一步決策

```text
已確認方向：Runtime 分層重構（P0-1）為最高優先。

建議執行順序：
  Step 1：提取 ProviderRegistry（解除 Ollama/Copilot 特判散落問題）
  Step 2：提取 ToolRegistry + ToolExecutor（統一工具治理）
  Step 3：提取 AgentExecutor（agent loop 獨立，不再耦合 panel）
  Step 4：提取 ContextBuilder + HistoryCompactor（context pipeline）
  Step 5：提取 SessionStore + TranscriptLog（持久化）
  Step 6：提取 WhatsAppManager（減少 OllamaChatPanel 體積）

每個 Step 都需搭配 GPT-5 / Claude Opus review 後再合併。
```
