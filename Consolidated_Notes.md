# AmiClaw vs. claude-code — 深度對比與重構優先路徑
> 更新：2026-09-01 | AmiClaw commit `2d3800e+` (190+ commits) vs. claude-code packages/builtin-tools

---

## 一、演進時間軸（Git History 摘要）

| 階段 | AmiClaw commits | 里程碑 |
|---|---|---|
| 基礎建設 | 1–30 | ollama-chat.ts 9740 行 God Class，WebviewRenderer 抽出 |
| 架構分解 | 31–80 | Provider Pattern Phase 1+2，65 工具提取，ToolRegistry 建立 |
| 能力擴展 | 81–130 | Shadow Supervisor、Team modes (5 種)、AutoPilot 模組、UEFI Code Review |
| 智慧壓縮 | 131–160 | HistoryCompactor L2/L3/L4、Context budget、MicroCompactor |
| 新架構 | 161–190 | **Coordinator+Worker、Workflow Engine、TF-IDF、AutoPilot 接線、AmiClaw 更名** |

---

## 二、功能對比矩陣

### 2.1 核心執行架構

| 功能 | AmiClaw | claude-code | 差距 |
|---|---|---|---|
| 主要執行模式 | Coordinator+Worker（預設）+ Ask + Team + Debate | Coordinator+Worker（唯一主流） | ✅ 已移植 |
| Worker 工具集 | CORE_TOOLS(27) + search_tools 動態解鎖 | CORE_TOOLS 38 + TF-IDF | ✅ 已擴充到 27 |
| Subagent 隨離 | Worker 有獨立 message history | ForkedAgent + cache-safe params | ⚠️ 無 cache sharing |
| Task 狀態機 | TaskStore： created/claimed/blocked/completed + webview broadcast | TaskType 7種 + 完整狀態轉移 | ✅ 已完成 |
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
| 檔案袅突偵測 | ✅ _fileReadTimes mtime 比對 | ✅ readTimestamp | ✅ 已移植 |
| 危險命令阻擋 | ✅ 6 種模式 | ✅ 24 個安全檢查 | ⚠️ 覆蓋率較低 |
| replace_in_file 唯一性 | ✅ 多匹配偵測 + fuzzy hint | ✅ 完整錯誤碼系統 | ✅ 已移植 |
| LSP 整合 | ✅ 6 種操作（goto/refs/hover/diag/rename/symbols） | ✅ 9 種操作 | ✅ 已實作 |
| 背景執行 | ✅ run_in_background + bg_task_wait + bg_task_kill | ✅ run_in_background + backgroundTaskId | ✅ 已移植 |
| 超大輸出持久化 | ✅ 持久化到 .amiclaw/outputs/ + byte-offset delta 讀取 | 持久化到磁碟 + 流式讀取 | ✅ 已移植 |
| Computer Use MCP | ❌ 無 | ✅ 截圖/鍵鼠/剪貼板 | ❌ 缺失 |

### 2.3 Context 管理

| 功能 | AmiClaw | claude-code | 差距 |
|---|---|---|---|
| Context 壓縮 | 3層：Microcompact→L2/L3→LLM Summary | /compact → LLM 壓縮 | ✅ AmiClaw 更複雜 |
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
| Denial tracking | ✅ recordAutoPilotDenial/Success（本次修正） | ✅ 完整斷路器 | ✅ 已修正 |
| Safe allowlist | ✅ 26 個唯讀工具 | ✅ 26 個 | ✅ 相當 |
| Permission modes | ✅ 手動/AutoPilot/全自動 + effect-based rule DSL（write/shell/network/delete） | ✅ ask/allow/deny rule 系統 | ✅ 已完成 |
| 工具 args 傳入 AutoPilot | ✅ 完整 toolArgs（path/old_str/command/url） | ✅ 完整 toolArgs | ✅ 已完成 |
| Shadow Staging | ✅ Sandbox + diff panel（AmiClaw 獨有） | ❌ 無 | ✅ AmiClaw 獨有 |

### 2.5 多代理協作

| 功能 | AmiClaw | claude-code | 差距 |
|---|---|---|---|
| Coordinator+Worker | ✅ handleCoordinator + _runWorker | ✅ 完整實作 | ✅ 已移植 |
| Worker 角色硬隔離 | ❌ Worker 有全部工具 | ✅ 可設定工具範圍 | ❌ 缺失 |
| Task protocol 狀態 | ✅ TaskStore: created/claimed/blocked/completed + create_task/list_tasks 工具 | ✅ created/claimed/blocked/completed | ✅ 已完成 |
| Worker 結果摘要 | ✅ report_result 協議：僅傳摘要回 Coordinator | ✅ 只傳摘要回主 thread | ✅ 已完成 |
| Team modes | ✅ 5 種（AmiClaw 獨有豐富性） | 只有 Coordinator→Worker | ✅ AmiClaw 更豐富 |

### 2.6 UI / 使用體驗

| 功能 | AmiClaw | claude-code | 差距 |
|---|---|---|---|
| Thinking 燈 | ✅ 軌道動畫 + low/medium/high/max | TUI spinner | ✅ AmiClaw 更好 |
| Compact 視覺化 | ✅ compact-bar + token diff | 文字提示 | ✅ AmiClaw 更好 |
| Agent 模式切換 | ✅ Ask/Agent/Team/Compare/Debate | REPL only | ✅ AmiClaw 更豐富 |
| Shadow 差異面板 | ✅ VS Code diff toolbar | ❌ 無 | ✅ AmiClaw 獨有 |
| START/STOP 狀態 | ✅ _agentStatusRunning 解耦（本次修正） | ✅ 完整 | ✅ 已修正 |
| Cost 視覺化 | ✅ token + latency 圖表 + USD 成本顏示 | ✅ USD 成本 + 緩存效率 | ✅ 已移植 |

---

## 三、重構優先順序

### P0 — 本次已完成 ✅

| 項目 | 影響 |
|---|---|
| Context 溢出：ollamaGetContextLength 優先讀 num_ctx | 每次 session 溢出 |
| keepTail/dropFallback 8000 chars 截斷防溢出 | 長 session 崩潰 |
| AutoPilot recordAutoPilotDenial/Success 接線 | 斷路器失效 |
| _agentStatusRunning 解耦 streamEnd | Coordinator 按鈕錯亂 |
| breathLight HTML 補回 + CSS breatheIdle/breatheActive 雙狀態動畫 | 視覺回饋消失；心跳永不停止 |
| replace_in_file fuzzy hint + 多匹配偵測 | LLM 編輯失敗率高 |
| _checkDangerousCommand 6 種安全阻擋 | 安全漏洞 |
| Tool 描述重寫（claude-code 指令式風格） | 模型使用工具錯誤率 |
| **handleAskWithTools isAgentMode 參數**：Ask 模式 system prompt 及唯讀工具篩選動態化 | Agent 模式被誤加唯讀限制 |
| **updateModelSelect race condition 修復**：prevUiValue 優先保留使用者選擇 | 模型頻繁被重置 |
| **Shadow Supervisor clearTimeout 修復**：Promise.race 後正確清除計時器 | 300s 後誤報超時 log |
| **Shadow Supervisor retry**：null 結果等待 100s 重試最多 3 次 | 影子督促單次失敗即放棄 |
| **Memory 系統修復**：_ltmCache eager-load、findRelevantMemories 分數公式修正（舊→新）、MEMORY.md 雙重注入防止 | 記憶遺忘 / 注入空內容 |
| **HeartbeatService 升級**：AgentHeartbeatInfo 狀態追蹤、AgentExecutor 連動、dispose() 不停止 interval | 心跳停頓 / 無狀態廣播 |
| **WA 定期回報**：notifyOwner + _lastActiveSendJid + 每 60s 推送 Agent 進度 | WhatsApp 無法感知 Agent 狀態 |
| **Webview ready race condition 修復**：Promise-based _readyPromise + _messageQueue flush | 訊息在 webviewReady 前丟失 |
| **isChoiceConfirmation**：偵測「選項 A/B 請確認」類型並自動授權繼續 | Agent 卡在等待使用者確認 |
| **JSON tool-call error retry**：偵測 invalid tool call JSON 錯誤等待 100s 重試最多 5 次 | Ollama JSON 格式錯誤導致 Agent 終止 |
| **Ask mode 路由 debug log**：send 訊息夾帶 _dbgModeSelect/_dbgAgentMode | 無法診斷 Ask/Agent 切換原因 |

### P1 — 本週（架構完整性）

| 優先 | 項目 | 工時 | 理由 |
|---|---|---|---|
| ~~1~~ | ~~擴充 CORE_TOOLS 到 25+~~ | ~~2h~~ | ✅ 已完成（到 27） |
| ~~2~~ | ~~TF-IDF 升級~~（cos similarity 取代關鍵字匹配） | ~~3h~~ | ✅ 已完成 |
| 3 | **Worker 角色硬隨離**（explorer-read-only / implementer-write） | 4h | 安全性 + claude-code 等價 |
| 4 | **Workflow resume/cancel** 持久化 | 3h | 長工作流中斷後無法恢復 |
| ~~5~~ | ~~**USD 成本顯示**~~ | ~~2h~~ | ✅ 已完成（ModelPricing + input/output split 追蹤）|
| ~~6~~ | ~~ToolPolicies effect-based rule DSL~~ | ~~5h~~ | ✅ 已完成 |
| 7 | **工具 lifecycle hooks** | 6h | retry/summary/telemetry 插入點 |

### P2 — 本月（產品差距）

| 優先 | 項目 | 工時 |
|---|---|---|
| ~~1~~ | ~~**背景執行支援**~~（run_in_background） | ~~4h~~ | ✅ 已完成（bg_task_wait + auto-background + win kill）|
| ~~2~~ | ~~**超大輸出持久化**~~（磁碟 + 分批讀取） | ~~5h~~ | ✅ 已完成（byte-offset delta + _persistIfLarge）|
| ~~3~~ | ~~Worker 結果只回摘要~~ | ~~3h~~ | ✅ 已完成（report_result） |
| ~~4~~ | ~~LSP 工具~~（goToDefinition/findReferences/hover） | ~~8h~~ | ✅ 已完成（6 種） |
| ~~5~~ | ~~Path-scoped 規則~~（.amiclaw/instructions/） | ~~4h~~ | ✅ 已完成（.amiclaw/RULES.md） |
| ~~6~~ | ~~AutoPilot toolArgs 完整傳入~~ | ~~2h~~ | ✅ 已完成 |
| ~~7~~ | ~~Task protocol~~（created/running/blocked/done） | ~~6h~~ | ✅ 已完成（TaskStore） |

### P3 — 下月（差異化）

| 項目 | 說明 |
|---|---|
| UDS 點對點通訊 | 多 AmiClaw 實例協作 |
| 記憶分層（規則層 + 記憶層 + 延遲讀取） | 取代全量 MEMORY.md 注入 |
| 隔離工作樹（多 Worker 不踩同一檔） | 可寫 Agent 安全保障 |
| ToolExecutor 完全 handler registry 化 | 消滅 1800+ 行 giant switch |
| Computer Use（截圖/鍵鼠） | 缺原生圖形界面操作 |
| ollama-chat.ts 繼續拆解 | UI/session/tool/memory 仍混雜 |

---

## 四、AmiClaw 獨有優勢

| 功能 | 說明 |
|---|---|
| Shadow Staging Panel | VS Code diff toolbar，Sandbox commit/rollback |
| 多模型並排比較 | Compare mode：A/B/C 同問題並排 |
| Team Discussion modes | 5 種協作模式 |
| Debate Engine | 兩模型辯論 + 裁判 |
| WhatsApp 整合 | Agent 可透過 WA 控制 |
| Jira/Bitbucket/Jenkins 工具 | 完整 DevOps 整合 |
| UEFI Code Review Skill | AMI 固件審查知識注入 |
| Compact 視覺化 bar | Before→After token 進度條 |
| Thinking 燈動畫 | 軌道動畫 + 4 種等級 |

---

## 五、技術債摘要

### 5.1 ollama-chat.ts 仍是 God Class
```
建議拆分 →
  OllamaChatPanel.ts (UI only)
  ChatSessionManager.ts (session state)
  AgentRuntimeCoordinator.ts (routing + wiring)
  MemoryCoordinator.ts (LTM + session notes)
```

### 5.2 ToolExecutor giant switch（1800+ 行）
```typescript
// 目標：每個工具實作 ToolHandler 介面
interface ToolHandler {
  validate(args): string | null;
  classify(): ToolEffect;
  execute(args, ctx): Promise<string>;
  summarize(result): string;
  audit(args, result): AuditEntry;
}
```

### 5.3 TF-IDF 精準度
```typescript
// 需升級為真正的餘弦相似度
const idf = buildIDF(EXTRA_TOOLS);  // 在 extension 啟動時建立索引
function searchTools(query: string): Tool[] {
  const queryVec = tfidf(query, idf);
  return cosineRank(EXTRA_TOOLS, queryVec).slice(0, topK);
}
```

---

## 七、戰略路線圖 (Strategic Roadmap)

### 第一階段：視覺與互動豐富度 (解決 "Artifacts" 差距)
- [ ] **實作 AmiClaw Artifacts Engine**：開發一個 Webview 用戶介面渲染器，能夠顯示 Markdown、Mermaid 圖表與語法高亮的程式碼區塊。
- [ ] **增強型 Markdown 上傳**：支援透過 Providers 上傳的文檔資產的直接渲染。

### 第二階段：協定標準化與安全性 (解決 "可靠性" 差距)
- [ ] **Ami-ACP (Agent Communication Protocol)**：為 Coordinator 與 Worker 的互動建立版本化的通訊標準。
- [ ] **工作流 Schema 驗證**：為 Workflow Engine 實作嚴格的 JSON/YAML schema 驗證。
- [ ] **標準化工具調用生命週期**：實作一套統一的方法，用以追蹤、記錄並重試所有 Providers 中的工具調用失敗。

### 第三階段：優化與環境穩健性 (解決 "效能" 差距)
- [ ] **提示詞快取與路由優化**：為支援的 LLM 提供者實作「黏性」提示詞快取鍵。
- [ ] **跨平台 Shell 抽象化**：增強 `FileSystem` 與 `DevTools` providers，包含 Windows 與 Git Bash 環境的自動相容模式。
- [ ] **會話邊界管理**：對訊息快取限制實施更嚴格的邊界，防止上下文導致的效能下降。

### 第四階段：可觀察性與智能化 (解決 "進階" 差距)
- [ ] **進階使用量分析**：擴展現有的使用量統計面板，包含每個 Provider 的 Token 成本追蹤。
- [ ] **影子模式擴展 (Shadow Mode Expansion)**：擴展 "Shadow Mode" 功能，允許在不影響即時編排引擎的情況下測試新的 Provider 邏輯。

---

*由 GitHub Copilot (Claude Sonnet 4.6) 基於 AmiClaw 190 commits git history + claude-code 深度分析生成。最後更新：2026-08-29（本次 session 顯著完成 P1 x5 + P2 x5 項）*