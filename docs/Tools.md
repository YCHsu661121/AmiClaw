# AmiClaw Tools Architecture

> 更新：2026-09-02

## 概覽

AmiClaw 工具系統由三層構成：

```
LLM Tool Call
      ↓
ToolExecutor.executeTool()
  ├─ TOOL_ALIASES  正規化別名
  ├─ Sandbox 路由 (shadow write)
  ├─ _dispatchWithHooks()   ← lifecycle hooks
  │     ├─ beforeTool (可修改 args / 阻擋)
  │     ├─ Provider.execute()
  │     ├─ afterTool (可修改 result)
  │     └─ onToolFailure (可提供 fallback)
  └─ "❌ 未知工具" fallback
```

---

## Provider Registry

13 個 Domain Provider 在 constructor 一次性註冊，所有 dispatch 為 O(1) Map 查找：

| Provider | 涵蓋工具 |
|---|---|
| `FileSystemProvider` | read/write/replace/glob/outline/todo/memory/diff... (23) |
| `GitProvider` | git_status, git_diff, git_log, git_commit |
| `ProcessProvider` | run_command, run_terminal, run_python |
| `SearchProvider` | search_workspace, search_regex, agentic_file_search |
| `NetworkProvider` | fetch_url, http_request, browser_* (6) |
| `AtlassianProvider` | jira_*, bb_create_pr, rovo_ask (9) |
| `JenkinsProvider` | jenkins_build, jenkins_status |
| `DevToolsProvider` | lint_fix, run_tests, generate_docs, organize_photos, db_query, agent_run_tool |
| `LspProvider` | lsp_goto_definition, lsp_find_references, lsp_hover, lsp_diagnostics, lsp_rename_symbol, lsp_document_symbols |
| `BackgroundProvider` | run_in_background, bg_task_status, bg_task_read, bg_task_kill, bg_task_wait |
| `ComputerUseProvider` | computer_screenshot, computer_type, computer_key, computer_click, computer_scroll, computer_clipboard_* |
| `VscodeProvider` | vscode_action, manage_todo |
| `IntegrationProvider` | whatsapp_* (7) |

### 新增 Provider

```typescript
// 1. 實作 IToolProvider
export class MyProvider implements IToolProvider {
  readonly tools = new Set(['my_tool']);
  execute(name: string, args: Record<string, unknown>, ctx: ToolExecutionContext) {
    return this._myTool(args, ctx);
  }
}

// 2. 在 ToolExecutor constructor 的 provider 陣列中加入
for (const provider of [
  ...
  new MyProvider(),
] as IToolProvider[]) { ... }
```

---

## Tool Lifecycle Hooks

移植自 claude-code `PreToolUse / PostToolUse / PostToolUseFailure`。

### 介面

```typescript
interface ToolHook {
  hookName?: string;

  // 回傳 null → 阻擋執行；回傳修改後的 args → 繼續
  beforeTool?(toolName, args, ctx): Promise<Record<string,unknown> | null>;

  // 回傳 string → 覆蓋 result；回傳 undefined → 原樣通過
  afterTool?(toolName, args, result, durationMs, ctx): Promise<string | undefined>;

  // 回傳 string → 吞掉錯誤；回傳 undefined → 重新拋出
  onToolFailure?(toolName, args, error, ctx): Promise<string | undefined>;
}
```

### 內建 Hooks（自動啟動）

| Hook | 行為 |
|---|---|
| `audit` | 每次工具完成/失敗後寫入 `ToolAuditLog` |
| `telemetry` | 累計 calls / errors / totalMs / slowCount；廣播 `toolTelemetry` 訊息到 webview |
| `slow-tool-warning` | 超過 10 s 的工具呼叫寫入 log |

### 自訂 Hook

```typescript
const unregister = executor.registerHook({
  hookName: 'my-hook',
  async beforeTool(name, args) {
    if (name === 'delete_file' && args.path === '/critical') {
      return null; // block
    }
    return args; // proceed
  },
  async afterTool(name, _args, result, durationMs) {
    console.log(`${name} took ${durationMs}ms`);
    return undefined; // pass through
  },
});

// 移除
unregister();
```

### Telemetry 讀取

```typescript
const stats = executor.getToolTelemetry();
// Map<toolName, { calls, errors, totalMs, slowCount, lastCallMs }>
```

---

## Webview 訊息

| 類型 | 內容 | 用途 |
|---|---|---|
| `toolTelemetry` | `{ stats: Record<toolName, ToolCallStats> }` | 工具呼叫熱力圖 |
| `toolStats` | _(同上，舊名)_ | 相容 |

---

## 工具 Schema

工具定義集中在 `src/tools/ToolRegistry.ts`：
- `CORE_TOOLS` (27) — LLM 每次都能看到
- `EXTRA_TOOLS` (40+) — 透過 `search_tools` TF-IDF 動態解鎖
- `ALL_TOOLS` — dispatch 用完整集合

### 新增工具描述

```typescript
// ToolRegistry.ts AGENT_TOOLS 陣列中加入：
{ type: 'function', function: {
  name: 'my_tool',
  description: '...指令式描述...',
  parameters: { type: 'object', properties: { ... }, required: [...] }
}}
```
