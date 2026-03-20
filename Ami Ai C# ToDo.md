# Ami Ai C# ToDo.md — AMI-AiClaw Feature Roadmap

> 最後更新：2025-01-XX

---

## 🎯 高優先級（High Priority）

### 1. 多語言支援（i18n）
- [ ] 實作 `vscode.l10n` 或獨立 i18n 模組
- [ ] 支援英文、繁體中文、簡體中文、日文介面切換
- [ ] 翻譯所有 UI 字串、錯誤訊息、提示文字

### 2. 長期記憶（LTM）增強
- [x] 提供 LTM 編輯 UI（條目卡片列表、點擊編輯、將除、快速新增）
- [x] 支援匯入/匯出 LTM 為 JSON 檔案
- [x] LTM 搜尋功能（關鍵字過濾）
- [x] LTM 分類標籤系統（#標籤 格式，可總覽 / 點擊篩選）

### 3. Agent 工具擴充
- [x] **檔案搜尋工具**：支援正規表達式、全工作區搜尋
- [x] **Git 整合**：commit、branch、merge、diff 操作
- [x] **資料庫查詢工具**（選配）：支援 SQLite（`db_query` 工具，透過 Python sqlite3）
- [x] **網路請求工具**：GET/POST HTTP API 呼叫（需使用者授權）
- [x] **正規表達式搜尋**：`search_regex` 工具，支援 glob 檔案樣式、flags
- [ ] **瀏覽器自動化**（選配）：Playwright/Puppeteer 整合

### 4. Team 模式優化
- [x] **動態角色分配**：協調員依任務類型加入可用助手名稱，自動指派 `preferred_model`
- [x] **子任務依賴關係**：協調員計劃 `deps` 子任務依賴陣列，今後任務待前置完成再指派
- [x] **平行執行限制**：新增並行數 select（1/2/3/5，預設 3），限制 Copilot 模式同時執行的子任務數
- [x] **失敗重試機制**：子任務失敗最多重試 2 次改用其他模型，超限則跳過並繼續

### 5. Debate 模式增強
- [x] **多回合延長**：允許使用者設定超過 4 輪的辯論
- [x] **即時切換模型**：辯論中途更換 A/B/裁判模型
- [x] **棋類遊戲擴充**：支援更多棋類（黑白棋、跳棋、橋牌）
- [x] **遊戲視覺化**：為棋盤類遊戲提供 ASCII 或 SVG 棋盤渲染

---

## 🚀 中優先級（Medium Priority）

### 6. 效能優化
- [x] **Token 計數優化**：使用更精確的 tokenizer（tiktoken）
- [x] **快取機制**：快取常用工具回應（如 list_dir）
- [x] **並行請求**：Agent 多工具同時執行（需模型支援）
- [x] **模型預熱**：啟動時預載入常用模型（Ollama keep_alive）

### 7. UI/UX 改進
- [x] **Markdown 渲染增強**：支援表格、任務清單、LaTeX 數學公式 → 新增 `renderTextBlock`/`renderInline`/`renderMdTable` 函式；串流結束後自動重新渲染 `response-body`；支援 `$$...$$`、`$...$`、`- [ ]`/`- [x]`、`|表格|`、`**粗體**`、`*斜體*`、`# 標題`、有序/無序清單 `commit 0b34950`
- [x] **程式碼高亮主題**：支援更多 Prism.js 主題 → 內嵌輕量 tokenizer (`highlightCode`)，支援 JS/TS/Python/Shell/CSS/JSON；語言標頭標籤；VS Code 主題感知顏色（`.hl-kw/.hl-str/.hl-cmt/.hl-num/.hl-fn/.hl-type`）`commit 4abe1f1`
- [x] **訊息編輯功能**：允許使用者修改已送出的訊息並重新產生 → hover 顯示 ✏️ 按鈕；內嵌 textarea 編輯覆蓋層；後端截斷歷史並重新送出 `commit 4abe1f1`
- [x] **對話分支**：在歷史訊息中建立分支對話（類似 ChatGPT）→ 助手訊息上加 🌿 Fork 按鈕；後端複製歷史切片建立新 session；前端 `forkSessionDone` 處理器 `commit 4abe1f1`
- [x] **快捷鍵自訂**：允許使用者自訂開啟面板、送出訊息等快捷鍵 → `Ctrl+Shift+I` 開啟面板；`Ctrl+L` 聚焦輸入框；`amiAiClaw.sendKey` 設定（Enter / Ctrl+Enter）`commit 4abe1f1`

### 8. 整合開發工具
- [ ] **ESLint/Prettier 整合**：Agent 自動修正程式碼風格
- [ ] **單元測試生成**：為選取的函式自動產生 Jest/Mocha 測試
- [ ] **文件生成**：為專案自動產生 API 文件（JSDoc、TypeDoc）
- [ ] **重構建議**：分析程式碼並提供重構方案

### 9. 雲端模型支援（選配）
- [ ] **OpenAI API 整合**：支援 GPT-4、GPT-3.5
- [ ] **Anthropic Claude 整合**
- [ ] **Gemini API 整合**（目前已透過 Copilot，可考慮直接支援）
- [x] **模型費用追蹤**：記錄 API 使用量和預估費用

### 10. 安全性增強
- [ ] **敏感資訊過濾**：自動偵測並遮蔽 API key、密碼等
- [ ] **工具權限管理**：允許使用者設定哪些工具需要確認才執行
- [ ] **沙箱執行環境**（選配）：在容器中執行 `run_terminal` 命令
- [ ] **稽核日誌**：記錄所有工具呼叫和檔案變更

---

## 💡 低優先級（Nice-to-Have）

### 11. 對話管理
- [x] **對話存檔**：將對話歷史儲存為 JSON/Markdown
- [x] **對話匯入**：載入先前存檔的對話繼續執行
- [x] **對話搜尋**：跨所有歷史對話搜尋關鍵字
- [x] **對話標籤**：為對話命名並分類（專案 A、學習筆記等）

### 12. 協作功能
- [ ] **分享對話連結**：產生唯讀連結讓其他人檢視對話
- [ ] **團隊設定同步**：透過 VS Code Settings Sync 共享模型與提示詞設定
- [ ] **多使用者協作**（選配）：多人同時使用同一個 Ollama 伺服器

### 13. 學習與統計
- [ ] **使用統計面板**：顯示最常用的模型、工具呼叫次數、token 消耗
- [ ] **效能分析**：記錄每個請求的延遲時間並視覺化
- [ ] **模型比較**：針對同一問題產生多個模型回應並比較

### 14. 擴充性
- [ ] **外掛系統**：允許第三方開發者新增自訂工具
- [ ] **腳本執行**：支援執行 Python/Node.js 腳本作為工具
- [ ] **Webhook 整合**：工具執行完成時觸發外部 webhook

### 15. 行動裝置支援（選配）
- [ ] **VS Code Web 相容性測試**
- [ ] **觸控優化 UI**（針對平板裝置）

---

## 🐛 已知問題修正

- [x] **無法連線 Ollama**：`/^\n/` 與 `/\n$/` regex 寫在 template literal 內造成 JS SyntaxError，webview 卡在「檢查中…」→ 已改用跳脫字元 `commit 8c8e5f9`
- [x] **Agent 模式 HTTP 400「不支援工具呼叫」**：deepseek-r1 等模型呼叫 tools API 回傳 400 → 已偵測錯誤並顯示友善提示，建議改用支援 tools 的模型 `commit 4a6bddd`
- [x] **Agent 模式使用錯誤模型**：`handleAgent` 回退到 `cfg.get('model')` 讀到舊的 `'llama3'` → 已在切換模型時同步寫入 `cfg.update()` `commit 560b90b`
- [x] **Thinking 視窗不顯示**：`supportsThinking` 未涵蓋 `hf.co/` 模型；串流 thinkChunk 有 80ms 延遲導致 think block 在回應後才出現 → 已改為即時發送、think block 插入 bubble 最前面、擴充模型偵測模式 `commit 3efc77d`
- [x] **Ask 模式沒有 token 數字**：`streamEnd` 備份路徑因 `_lastStreamTokens=0` 的 falsy 判斷失敗 → 已改為必定建立 badge，無 eval_count 時從文字長度估算；同時更新至 statusBar `commit ca88419`
- [x] **Copilot 模型切換延遲**：快速切換模型時偶爾出現舊模型回應 → 新增 `_pendingSendCts`，新請求送出時先 cancel 前一個 Copilot CTS `commit eff0945`
- [x] **大型檔案讀取崩潰**：`read_file` 讀取 >10MB 檔案時 webview 凍結 → 加入 5 MB 上限，超過直接拒絕並回傳提示訊息 `commit eff0945`
- [x] **終端機輸出截斷**：`run_terminal` 執行超過 5 秒的命令輸出可能不完整 → 改以 `exec()` 執行（120s timeout）實際回傳 stdout/stderr，同時保留 terminal UI 可見性 `commit eff0945`
- [x] **中文字數計算錯誤**：Token limit 計算未考慮中文字元實際佔用 → webview 估算邏輯改為 CJK > 0x2E7F 算 1 token、ASCII 算 0.25 token，與後端 `estimateTokens` 一致 `commit eff0945`
- [x] **Agent/Ask 模式完成後 token 資訊消失**：`agentStatus{running:false}` 緊接在 `streamEnd` 之後，把 statusBar 覆寫成「🤖 Agent 模式」清掉 token 數字；Ask 模式因備份路徑未儲存 `_lastTokenInfo` 亦未顯示 → 新增 `_lastTokenInfo` 變數於 `streamEnd` 儲存 token 文字，`agentStatus{running:false}` 時恢復該文字；純思考型模型（無 `.response-body`）fallback 改抓 `details.think pre.think-stream` 文字估算 `commit 188321d`
- [x] **Markdown 新增後 webview 卡在「連線：檢查中…」（regression）**：`0b34950` Markdown rendering commit 在 TS template literal 裡的 regex 及字串使用單反斜線跳脫（`\n`/`\*`/`\$`/`\s`/`\d`/`\|`），TS template literal evaluation 把 `\n` 變成真正換行字元、`\*\*` 變成非法 quantifier 等，導致 webview `<script>` 整體 SyntaxError，`webviewReady` 永遠不送出 → 全部加倍為 `\\n`/`\\*` 等 `commit ec182ba`；`split('\n')` / `mathBuf+=ln+'\n'` 兩處字串字面值同樣加倍 `commit e364265`

---

## 📝 文件與測試

- [ ] **完整 API 文件**：為所有工具函式撰寫 JSDoc
- [ ] **單元測試**：覆蓋 Agent 工具核心邏輯（目標 >80%）
- [ ] **整合測試**：自動化測試 Webview 與後端通訊
- [ ] **使用者教學影片**：錄製各模式操作示範
- [ ] **最佳實踐指南**：撰寫不同使用情境的範例（Web 開發、資料分析等）

---

## 🎨 未來構想（Brainstorming）

- **語音輸入/輸出**：整合 Whisper 和 TTS
- **影像理解**：支援 LLaVA 等多模態模型（貼上圖片後自動分析）
- **即時協作白板**：在 Debate 模式中提供繪圖工具
- **遊戲 AI 訓練**：對戰結果儲存為訓練資料，微調專屬棋類模型
- **程式碼審查自動化**：整合 PR 工作流程，自動產生 review 建議
