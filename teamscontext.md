## 主管模式紀錄 2026-03-24 08:18:15

**議題：** 把工作區塊的 code 提出改進計畫

**執行狀態：** 已執行完畢，請查看上方 Agent 執行記錄。

**全員 Review：**
【🏢 主管 (🐙 claude-opus-4.6) Review】
# 執行結果 Review

## 1. 是否符合需求

**部分符合，但有重要落差。**

原始需求是「把工作區塊的 code 提出改進計畫」，團隊產出了一份以模組拆分為核心的重構方案。方案本身在技術細節上經過 3 輪迭代，品質不錯，但存在以下需求覆蓋缺口：

| 面向 | 已涵蓋 | 未涵蓋 |
|------|--------|--------|
| 架構重構（模組拆分） | ✅ 完整 | — |
| 程式碼品質（lint、命名、duplication） | ❌ | 未提及 ESLint 設定、程式碼風格統一 |
| 安全性改進 | 部分（Sanitizer） | 未審查 `execSync` 的指令注入風險、Webview CSP 設定 |
| 測試策略 | ❌ 口頭提及「建議補測試」 | 無具體測試檔案、無 test framework 設定 |
| 效能改進 | 部分（快取、防抖） | 未分析 Webview 巨型 HTML 模板的載入效能 |
| CI/CD 與建置流程 | ❌ | `build.bat` 未審查、無 GitHub Actions 建議 |
| 文件與可維護性 | ❌ | 無 JSDoc、無 README 更新計畫 |

---

## 2. 潛在問題與風險

### 高風險

**風險 1：整份 `ollama-chat.ts` 未被實際審查**

該檔案被截斷，團隊基於截斷後的片段做推測。巨型檔中可能存在：
- 未被識別的安全漏洞（`eval`、未過濾的 shell 指令拼接）
- 記憶體洩漏（未清理的 event listener、WhatsApp socket）
- 競態條件（多個 `_pending*` Promise 同時存在時的行為）

**風險 2：重構計畫無回歸驗證機制**

目前零測試。提案中每新增一個模組都聲稱「建議補上單元測試」，但沒有任何一份提案包含實際測試程式碼。在無測試的情況下拆分巨型檔，回歸風險極高。

**風險 3：`extension.ts` 的改動表面上「保留原有程式碼」，實際上新增了 3 個未使用的物件**

```typescript
const chatHistory = new ChatHistoryManager(context.globalState);
const usageTracker = new UsageTracker(context.globalState);
const auditLog = new AuditLog();
```

這三行建立了實例但完全沒有傳入 `OllamaChatPanel`，也沒有被任何命令使用。Phase 1 結束時，這些物件就只是佔記憶體的死程式碼。需要明確定義「何時、如何將這些模組注入 `OllamaChatPanel`」的銜接計畫。

### 中風險

**風險 4：`OllamaClient.generate` 的 failover 只重試一次**

`rotateUrl` 在失敗後只嘗試下一個 URL。如果陣列有 3 個 URL，第 2 個也失敗就直接拋錯。原始碼的行為可能不同。

**風險 5：`PermissionManager` 的 `pendingResolve` 沒有超時機制**

如果使用者關閉 Webview 而不回應權限請求，Promise 永遠不會 resolve，Agent 迴圈會永久掛起。

**風險 6：`Sanitizer` 只處理工具輸出，未處理工具輸入**

原始碼的 `filterSensitiveInfo` 設定描述是「偵測並遮蔽工具回傳中的敏感內容」，但使用者也可能在 prompt 中包含敏感資訊。Sanitizer 應該是雙向的。

---

## 3. 建議的改進方向

### 立即補充（在開始實作前）

**3.1 先寫測試，再拆模組**

為 `ollama-chat.ts` 中即將被抽出的邏輯先寫特徵測試（characterization test），捕捉現有行為：

```
src/
├── __tests__/
│   ├── ollama-client.test.ts    ← mock HTTP，驗證 generate/stream/listModels
│   ├── chat-history.test.ts     ← 驗證 session 切換、持久化、防抖
│   ├── usage-tracker.test.ts    ← 驗證 token 累計與持久化
│   ├── permission.test.ts       ← 驗證 alwaysAllow/alwaysConfirm 優先序
│   └── file-tools.test.ts       ← 驗證快取 TTL、寫入失效
```

在 `package.json` 中加入：
```json
{
  "devDependencies": {
    "vitest": "^3.x",
    "@types/node": "^20.x"
  },
  "scripts": {
    "test": "vitest run"
  }
}
```

**3.2 定義模組注入的銜接點**

明確 `OllamaChatPanel` 的 constructor 改動：

```typescript
// Phase 1 結束時，OllamaChatPanel constructor 應改為：
private constructor(
  panel: vscode.WebviewPanel,
  context: vscode.ExtensionContext,
  private ollamaClient: OllamaClient,      // 新增
  private chatHistory: ChatHistoryManager,  // 新增
  private usageTracker: UsageTracker,       // 新增
  private auditLog: AuditLog               // 新增
) { ... }
```

**3.3 補充安全性審查項目**

| 項目 | 審查內容 |
|------|----------|
| Shell injection | `run_command` 的 `args.command` 是否有字元過濾 |
| Path traversal | `file-tools.ts` 的 `path.resolve` 是否能存取工作區外的檔案 |
| Webview CSP | `getHtmlForWebview` 的 Content-Security-Policy header |
| WhatsApp session | `_waSock` 的生命週期管理與斷線處理 |

### 中期改善

**3.4 建置與 CI 改進**

- 將 `build.bat` 轉為跨平台 npm script
- 加入 ESLint + Prettier（`package.json` 目前完全沒有 lint 設定）
- GitHub Actions 至少做 `tsc --noEmit` + `vitest run`

**3.5 Webview HTML 模板管理**

巨型模板字串是可維護性最大的敵人。建議：
- 將 CSS 抽到 `media/styles.css`
- 將前端 JavaScript 抽到 `media/main.js`
- 透過 `webview.asWebviewUri` 載入

**3.6 文件補充**

- 新模組需附 JSDoc
- `README.md` 的架構圖需更新以反映新目錄結構
- 每個 `src/` 子目錄加一份 `README.md` 說明模組職責

---

## 總結評分

| 評分項目 | 分數 | 說明 |
|----------|------|------|
| 需求覆蓋度 | 6/10 | 只涵蓋架構重構，測試、安全、CI 未涉及 |
| 技術正確性 | 8/10 | 經 3 輪迭代已消除主要技術錯誤 |
| 可執行性 | 5/10 | 缺少銜接計畫（注入點）與測試基礎 |
| 完整性 | 6/10 | `ollama-chat.ts` 未完整審查，Webview 前端未涉及 |

**建議下一步**：先實作 3.1（測試基礎）和 3.2（注入銜接點），再開始執行 Phase 1 的模組拆分。

---

【👨‍💻 工程師 #1 (🐙 gpt-4o) Review】
### **Review 報告**

---

### **1. 是否符合需求？**

#### **需求回顧**
需求是「把工作區塊的 code 提出改進計畫」，並且執行了以下步驟：
1. 分析工作區的主要模組與架構。
2. 提出改進計畫，將巨型檔案（如 `src/ollama-chat.ts`）拆分為模組化結構。
3. 根據主管的多輪審核意見，逐步修正問題，並完成模組化的實作。

#### **執行結果**
- **符合需求**：執行結果成功將巨型檔案拆分為多個模組，並針對核心功能（如 API 客戶端、聊天歷史管理、工具執行引擎）進行了模組化重構。
- **多輪審核修正**：根據主管的審核意見，修正了多處問題（如 HTTP/HTTPS 協議選擇、API 路徑錯誤、命令註冊保留等），並補充了防抖保存、取消機制、多伺服器支援等功能。

---

### **2. 有哪些潛在問題或風險？**

#### **問題與風險**
1. **整合測試不足**
   - 雖然模組化拆分完成，但缺乏整合測試來驗證新模組與原有功能的兼容性。
   - 例如，`OllamaChatPanel` 是否正確使用了新模組，尚未有測試覆蓋。

2. **多伺服器支援的邏輯簡化**
   - `OllamaClient` 的多伺服器支援僅實現了簡單的輪詢（`rotateUrl`），但未考慮伺服器健康檢查或優先級。
   - 如果某伺服器長期不可用，可能導致性能下降。

3. **防抖保存的延遲影響**
   - `ChatHistoryManager` 的防抖保存機制（500ms 延遲）可能導致聊天歷史在高頻交互場景下出現短暫的不同步。
   - 例如，使用者快速切換聊天 session 時，可能會遇到歷史未及時保存的情況。

4. **權限管理的邏輯複雜性**
   - `PermissionManager` 的 `alwaysConfirm` 和 `alwaysAllow` 邏輯雖然已補充，但仍然依賴 Webview 的回應，可能在高頻工具執行場景下導致延遲。
   - 如果 Webview 通訊中斷，可能導致工具執行卡住。

5. **快取失效策略不完善**
   - `file-tools.ts` 的快取機制僅基於時間（30 秒 TTL），未考慮檔案內容的變更。
   - 如果檔案在快取期間被外部修改，可能導致工具返回過期的內容。

6. **模組間依賴管理**
   - 雖然模組化拆分完成，但部分模組（如 `ChatHistoryManager` 和 `UsageTracker`）仍然通過全域狀態（`globalState`）進行交互，耦合度較高。
   - 如果未來需要進一步拆分或測試，可能會增加維護成本。

---

### **3. 建議的改進方向**

#### **短期改進**
1. **補充整合測試**
   - 為 `OllamaChatPanel` 和新模組（如 `OllamaClient`、`ChatHistoryManager`）補充整合測試，驗證功能是否與原有行為一致。
   - 測試場景包括：
     - 聊天歷史的切換、保存、導入/導出。
     - API 客戶端的多伺服器切換與串流取消。
     - 工具執行的權限確認與快取行為。

2. **優化多伺服器支援**
   - 在 `OllamaClient` 中加入伺服器健康檢查邏輯，避免輪詢到不可用的伺服器。
   - 例如，使用 `HEAD` 請求檢查伺服器狀態，並將不可用伺服器暫時移出輪詢列表。

3. **改進快取失效策略**
   - 在 `file-tools.ts` 中加入檔案內容的哈希值檢查，確保快取內容與實際檔案一致。
   - 例如，使用 `fs.stat` 獲取檔案的修改時間，並與快取中的時間戳進行比對。

4. **簡化權限管理邏輯**
   - 為高頻工具執行場景（如 `read_file`）提供批量確認選項，減少 Webview 通訊的頻率。
   - 例如，允許使用者一次性授權多個工具執行，而非逐一確認。

#### **中期改進**
1. **解耦模組間依賴**
   - 將 `ChatHistoryManager` 和 `UsageTracker` 的狀態管理從 `globalState