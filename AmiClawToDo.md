# AmiClaw 戰略路線圖：演進比較與開發優先事項

本文件比較了 **AmiClaw** 與 **claude-code** 的演進軌跡，並概述了 AmiClaw 為了彌補功能差距並在代理編排 (agent orchestration) 領域建立市場領導地位所需的必要步驟。

## 1. 功能比較 (Feature Comparison)

| 功能類別 | AmiClaw (編排器/Orchestrator) | claude-code (介面/Interface) |
| :--- | :--- | :--- |
| **架構 (Architecture)** | **以提供者為中心且模組化 (Provider-Centric & Modular)**：高度專注於 "Provider Pattern" (提供者模式，如 FileSystem, Atlassian 等) 以及協調者/工作者 (Coordinator/Worker) 代理模型。 | **以協定為中心且整合化 (Protocol-進Centric & Integrated)**：專注於 "Agent Communication Protocol (ACP)" (代理通訊協定) 與標準化的工具調用生命週期。 |
| **能力 (Capabilities)** | **領域特定擴展 (Domain-Specific Expansion)**：強調專用代理 (如 UEFI, WhatsApp) 與基礎設施自動化 (Docker/Sandbox)。 | **豐富的開發者體驗 (Rich Developer Experience, DX)**：專注於 "Artifacts" (產出物，如 Mermaid, 語法高亮) 以及進階的終端/Shell 整合。 |
| **上下文管理 (Context Management)** | **基於檢索 (RAG) 的重點**：使用 TF-IDF 延遲工具與 `HistoryComproll` 來管理長期記憶與溢出。 | **效率與邊界重點**：使用 `/compact` 演進與對 `getSessionMessages` 的嚴格邊界限制，以維持 Token 穩定性。 |

## 2. 功能差異 (Functional Differences)

### AmiClaw: 「生態系統構建者」(The "Ecosystem Builder")
AmiClaw 的發展歷程展現了對 **擴展性與垂直整合** 的專注。其演進是由能夠接入新的 "Providers" 與 "Specialized Agents" 的能力所驅動。其設計旨在成為複雜、多領域工作流 (例如從 WhatsApp 到 Firmware 審查) 的骨幹。

### claude-code: 「高保真度介面」(The "High-Fidelity Interface")
claude-code 的發展歷程展現了對 **互動品質與環境穩健性** 的專注。其演進是由 "Artifacts" 革命 (程式碼/圖表視覺化) 以及讓代理感覺像是開發者終端 (Windows/PowerShell/Git Bash 優化) 的原生化驅動。

## 3. AmiClaw 優先事項清單 (戰略待辦事項)

為了達到或超越 `claude-code` 的功能，AmiClaw 必須從「強大的引擎」演進為「高保真度的開發者體驗」。

### 第一階段：視覺與互動豐富度 (解決 "Artifacts" 差距)
- [ ] **實作 AmiClaw Artifacts Engine**：開發一個 Webview 用戶介面渲染器，能夠顯示 Markdown、Mermaid 圖表與語法高亮的程式碼區塊。
- [ ] **增強型 Markdown 上傳**：支援透過 Providers 上傳的文檔資產的直接渲染。

### 第二階段：協定標準化與安全性 (解決 "可靠性" 差距)
- [ ] **Ami-ACP (Agent Communication Protocol)**：為 Coordinator 與 Worker 的互動建立版本化的通訊標準，以防止在複雜工作流中的破壞性變更。
- [ ] **工作流 Schema 驗證**：為 Workflow Engine 實作嚴格的 JSON/YAML schema 驗證，以確保 `AutoPilot` 序列在執行前結構正確。
- [ ] **標準化工具調用生命週期**：實作一套統一的方法，用以追蹤、記錄並重試所有 Providers 中的工具調用失敗。

### 第三階段：優化與環境穩健性 (解決 "效能" 差距)
- [ ] **提示詞快取與路由優化**：為支援的 LLM 提供者實作「黏性」提示詞快取鍵 (sticky prompt cache keys)，以降低延遲與成本 (模擬 OpenAI 整合)。
- [ ] **跨平台 Shell 抽象化**：增強 `FileSystem` 與 `DevTools` providers，包含 Windows (Powerstream) 與 Git Bash 環境的「自動相容模式」。
- [ ] **會話邊界管理**：對訊息快取限制實施更嚴格的邊界，以防止長期間會話中因上下文導致的效能下降。

### 第四階段：可觀察性與智能化 (解決 "進階" 差距)
- [ ] **進階使用量分析**：擴展現有的使用量統計面板，包含每個 Provider 的 Token 成本追蹤。
- [ ] **影子模式擴展 (Shadow Mode Expansion)**：擴展 "Shadow Mode" 功能，允許在不影響即時編排引擎的情況下測試新的 Provider 邏輯。
