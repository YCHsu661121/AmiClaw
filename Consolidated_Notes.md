# AmiClaw vs. claude-code — 深度對比與重構優先路徑
> 更新：2026-09-01 | AmiClaw commit `2d3800e+` (190+ commits) vs. claude-code packages/builtin-tools

---

## 一、 演進時間軸 (Evolution Timeline)

| 階段 | AmiClaw commits | 里程碑 |
|---|---|---|
| 基礎建設 | 1–3 0 | ollama-chat.ts 9740 行 God Class，WebviewRenderer 抽出 |
| 架構分解 | 31–80 | Provider Pattern Phase 1+2，65 工具提取，ToolRegistry 建立 |
| 能力擴展 | 81–130 | Shadow Supervisor、Team modes (5 種)、AutoPilot 模組、UEFI Code Review |
| 智慧壓縮 | 131–160 | HistoryCompactor L2/L3/L4、Context budget、MicroCompactor |
| 新架構 | 161–190 | **Coordinator+Worker、Workflow Engine、TF-IDF、AutoPilot 接線、AmiClaw 更名** |

---

## 二、 功能對比矩陣 (Feature Comparison Matrix)

### 2.1 核心執行架構
| 功能 | AmiClaw | claude-code | 差距 |
|---|---|---|---|
| 主要執行模式 | Coordinator+Worker（預設）+ Ask + Team + Debate | Coordinator+Worker（唯一主流） | ✅ 已移植 |
| Worker 工具集 | CORE_TOOLS(27) + search_tools 動態解鎖 | CORE_TOOLS 38 + TF-IDF | ✅ 已擴充到 27 |
| Subagent 隨離 | Worker 有獨立 message history | ForkedAgent + cache-safe params | ⚠️ 無 cache sharing |
| Task 狀態機 | TaskStore： created/claimed/blocked/completed + webint broadcast | TaskType 7種 + 完整狀態轉移 | ✅ 已完成 |
| Proactive 自主模式 | startAuto tick loop 最多 12 輪 | SleepTool + 無限 tick | ✅ 已移植 |
| Workflow Engine | JSON 工作流存 .amiclaw/workflows/ + RunID resume/cancel | YAML + persist/resume/cancel | ✅ 已完成 |
| Cancel/Interrupt | AbortController + _agentCancel | AbortController + TaskStop tool | ⚠️ 缺 TaskStop |

### 2.2 工具系統
| 功能 | AmiClaw | claude-code | 差距 |
|---|---|---|---|
| 工具總數 | 60+ | 59 builtin + MCP 擴充 | ≈ 相當 |
| 工具層分 | CORE(27) / EXTRA(40+) / ALL_TOOLS | CORE(38) + deferred | ✅ 已擴充 |
| TF-IDF 搜尋 | 完整 TF-IDF + 餘弦相似度 | 完整 TF-IDF + 餘弦相似度 | ✅ 已升級 |
| 工具 lifecycle hooks | 無 | beforeTool/afterTool/onFailure | ❌ 完全缺失 |
| 檔案衝突偵測 | ✅ _fileReadTimes mtime 比對 | ✅ readTimestamp | ✅ 已移植 |
| 危險命令阻擋 | ✅ 6 種模式 | ✅ 24 個安全檢查 | ⚠️ 覆蓋率較低 |
| replace_in_file 唯一性 | ✅ 多匹配偵測 + fuzzy hint | ✅ 完整錯誤碼系統 | ✅ 已移植 |
| LSP 整合 | ✅ 6 種操作（goto/refs/hover/diag/rename/symbols） | ✅ 9 種操作 | ✅ 已實作 |
| 背景執行 | ✅ run_in_background + bg_task_wait + bg_task_kill | ✅ run_in_background + backgroundTaskId | ✅ 已移植 |
| 超大輸出持久化 | ✅ 持久化到 .amiclaw/outputs/ + byte-offset delta 讀取 | 持久化到磁碟 + 流式讀取 | ✅ 已移植 |
| Computer Use MCP | ❌ 無 | ✅ 截圖/鍵鼠/剪貼板 | ❌ 缺失 |

### 2.3 Context 管理
| 功能 | AmiClaw | claude-code | 差距 |
|---|---|---|---|
| Context 壓縮 | 3層：Microcompact→L2/L3→LLM Summary | /compact → LLM 變量壓縮 | ✅ AmiClaw 更複雜 |
| 壓縮視覺化 | ✅ compactUpdate bar + 進度條 | 文字提示 | ✅ AmiClaw 更好 |
| Context 溢出偵測 | ✅ 45% threshold（本次修正） | 動態 token budget | ✅ 已修正 |
| keepTail 截斷 | ✅ 8000 chars 截斷防溢出 | ✅ 內建 | ✅ 已修正 |
| Session Memory | ✅ LLM 背景摘要（移植自 claude-code） | ✅ ForkedAgent 週期更新 | ✅ 已移植 |
| Path-scoped 規則 | ✅ .amiclaw/RULES.md workspace-scoped | ✅ 目錄 scoped CLAUDE.md | ✅ 已完成 |
| 記憶分層 | ✅ Layer1 RULES.md（必常）+ Layer2 MEMORY.md（惰性）+ Layer3 session-notes | ✅ 規則層 + 記憶層 + 延遲讀取 | ✅ 已完成 |

### 2.4 安全與權限
| 功能 | AmiClaw | claude-code | 差距 |
|---|---|---|---|
| AutoPilot 接線 | ✅ 已接入 ToolPolicies gateway（本次修正） | ✅ 完整 | ✅ 已完成 |
| Denial tracking | ✅ recordAutoPilotDenint/Success（本次修正） | ✅ 完整斷路器 | ✅ 已修正 |
| Safe allowlist | ✅ 26 個唯讀工具 | ✅ 26 個 | ✅ 相當 |
| Permission modes | ✅ 手動/AutoPilot/全自動 + effect-based rule DSL | ✅ ask/allow/deny rule 系統 | ✅ 已完成 |
| 工具 args 傳入 AutoPilot | ✅ 完整 toolArgs（path/old_str/command/url） | ✅ 完整 toolArgs | ✅ 已完成 |
| Shadow Staging | ✅ Sandbox + diff panel（AmiClaw 獨有） | ❌ 無 | ✅ AmiClaw 獨有 |

### 2.5 多代理協作
| 功能 | AmiClaw | claude-code | 差距 |
|---|---|---|---|
| Coordinator+Worker | ✅ handleCoordinator + _runWorker | ✅ 完整實作 | ✅ 已移植 |
| Worker 角色硬隔離 | ❌ Worker 有全部工具 | ✅ 可設定工具範圍 | ❌ 缺失 |
| Task protocol 狀態 | ✅ TaskStore: created/claimed/blocked/completed + create_task/list_tasks | ✅ created/claimed/blocked/completed | ✅ 已完成 |
| Worker 結果摘要 | ✅ report_result 協議：僅傳摘要回 Coordinator | ✅ 只傳摘要回主 thread | ✅ 已完成 |
| Team modes | ✅ 5 種（AmiClaw 獨有豐富性） | 只有 Coordinator→Worker | ✅ AmiClaw 更豐富 |

---

## 三、 已達成里程碑 (Key Achievements)

### 🚀 核心架構與穩定性 (Stability & Architecture)
- [x] **Context 溢出防護**：優化 `ollamaGetContextLength` 並實作 `keepTail` 8000 chars 截斷機制。
- [x] **任務狀態機完備化**：實現 `TaskStore` 完整狀態轉移與 `report_result` 摘要協議。
- [x] **自動化與監控**：實現 `AutoPilot` 拒絕/成功追蹤、`HeartbeatService` 狀態追蹤與 `WA` 定期進度回報。
- [x] **資源管理**：優化 `Shadow Supervisor` 重試機制與 `Webview` 訊息隊列 (Ready Race Condition) 修復。

### 🛠️ 工具系統與效能 (Tooling & Performance)
- [x] **工具能力擴展**：擴充 `CORE_TOOLS` 至 27+，實作 `LSP` (6種操作) 與 `TF-IDF` 餘弦相似度搜尋。
- [x] **安全性增強**：實作 `_checkDangerousCommand` (6種模式) 與 `ToolPolicies` 基於 Effect 的 Rule DSL。
- [x] **高效能處理**：實作超大輸出磁碟持久化 (Byte-offset delta) 與背景執行 (`run_in_background`)。
- [x] **編輯精準度**：提升 `replace_in_file` 的模糊提示與多匹配偵測能力。

### 🎨 使用者體驗與互動 (UX & Interaction)
- [x] **視覺化增強**：開發 `Thinking` 軌道動畫、`Compact` 進度條以及 `USD` 成本視覺化面板。
- [x] **智慧交互**：支援 `isChoiceConfirmation` 自動授權與 `JSON` 工具調用錯誤重試機制。
- [x] **記憶管理**：完成 `Memory` 系統修復（LTM 緩存、分數公式優化、雙重注入防護）。

---

## 四、 統一開發戰略路線圖 (Unified Strategic Roadmap)

### 🟢 Phase 1: 結構完整性與功能對等 (Foundation & Parity)
*目標：消除與 claude-code 的功能差距，強化基礎工具鏈。*
- [ ] **Worker 角色硬隔離**：實作 `explorer-read-only` 與 `implementer-write` 權限分離。
- [ ] **Workflow 持久化**：實現 `Workflow resume/cancel` 功能。
- [ ] **工具生命週期**：實作 `Tool lifecycle hooks` (retry/summary/telemetry)。
- [ ] **Artifacts Engine**：開發 Webview 渲染器，支援 Markdown, Mermaid 與程式碼高亮。
- [ ] **增強型 Markdown 上傳**：支援 Provider 資源的直接渲染。

### 🟡 Phase 2: 標準化與規模化 (Standardization & Scalability)
*目標：建立標準通訊協議，提升系統的可擴展性與開發效率。*
- [ ] **Ami-ACP (Agent Communication Protocol)**：建立 Coordinator 與 Worker 的版本化通訊標準。
- [ ] **Workflow Schema 驗證**：為 Workflow Engine 實作嚴格的 JSON/YAML 驗Schema。
- [ ] **記憶分層架構**：正式落地 `Layer1 (Rules) + Layer2 (Memory) + Layer3 (Session)`。
- [ ] **ToolExecutor 模組化**：重構 Giant Switch，實現 `ToolHandler` 介面化。
- [ ] **UDS (Unified Data Service)**：實現多 AmiClaw 實例間的點對點通訊協作。

### 🔵 Phase 3: 智慧生態與邊界擴展 (Intelligence & Ecosystem)
*目標：引入多模態能力與跨平台環境整合，邁向全自動化。*
- [ ] **Computer Use (MCP Integration)**：整合截圖、鍵鼠控制與剪貼板操作。
- [ ] **提示詞優化**：實作 LLM Provider 的「黏性」提示詞快取與路由優化。
- [ ] **跨平台 Shell 抽象化**：增強 Windows/Git Bash 環境的自動相容模式。
- [ ] **進階分析與影子模式**：擴展 `Usage Analysis` (Token/Cost) 與 `Shadow Mode` 測試引擎。

---

## 五、 核心技術挑戰 (Technical Debt & Refactoring)

### ✅ 5.1 模組化重構 (The God Class Problem) — 第一階段完成
`ollama-chat.ts` 3061→1674 行（-45%），Provider/API 層已抽離：
- `src/types/chat-types.ts` — ChatMessage, ThinkingLevel 共用型別
- `src/providers/OllamaApiClient.ts` — 所有 Ollama HTTP API 函式
- `src/providers/OpenAICompatClient.ts` — OpenAI compat + Copilot LM API
- `src/providers/ProviderUtils.ts` — utilities (filterSensitiveInfo, estimateTokens, codec...)
- `src/providers/index.ts` — barrel re-export

**下一步（第二階段）**：從 constructor 萃取 WebviewMessageRouter，拆 SessionManager、MemoryCoordinator。

### ⚠️ 5.2 執行器重構 (The Giant Switch Problem)
`ToolExecutor` 的 1800+ 行 `switch` 需轉向 `ToolHandler` 介面化設計，包含 `validate`, `classify`, `execute`, `summarize`, `audit` 等標準化方法。

### ⚠️ 5.3 檢索精度升級
將現有的 TF-IDF 搜尋進一步升級為完整的向量化餘弦相似度檢索，並在擴充插件啟動時自動建立索引。

---

## 六、 AmiClaw 獨有競爭優勢 (Unique Advantages)

| 功能 | 說明 |
|---|---|
| **Shadow Staging Panel** | 基於 VS Code diff toolbar 的 Sandbox commit/rollback 機制。 |
| **多模型並排比較** | `Compare mode`：支援 A/B/C 多模型針對同一問題的並行解答。 |
| **Team Discussion modes** | 提供 5 種豐富的代理協作模式。 |
| **Debate Engine** | 雙模型辯論 + 自動裁判機制。 |
| **WhatsApp 整合** | 支援透過 WhatsApp 遠端控制 Agent 進度與指令。 |
| **DevOps 全鏈路工具**| 深度整合 Jira, Bitbucket, Jenkins 等企業級工具。 |
| **UEFI Code Review Skill**| 內建專門針對 AMI 固件審查的知識注入。 |
| **進階視覺化**| 包含 `Thinking` 燈動畫、`Compact` 進度條與 `Cost` 圖表。 |

---

*由 GitHub Copilot (Claude Sonnet 4.6) 基於 AmiClaw 190 commits git history + claude-code 深度分析生成。*