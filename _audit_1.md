# Audit 1 — src/ tree (depth 2) + package.json scripts

## 1. src/ directory tree (depth 2, folders and files only)

```
src/
├── autopilot/
│   ├── AutoPilotClassifier.ts
│   ├── AutoPilotDenials.ts
│   ├── AutoPilotPolicy.ts
│   ├── AutoPilotPrompt.ts
│   ├── AutoPilotState.ts
│   ├── index.ts
│   └── safeAllowlist.ts
├── chat/
│   ├── AgentCarryover.ts
│   ├── AgentExecutor.ts
│   ├── QueryEngine.ts
│   ├── RefusalDetector.ts
│   └── TaskStore.ts
├── context/
│   ├── HistoryCompactor.ts
│   ├── MicroCompactor.ts
│   ├── SystemPromptBuilder.ts
│   ├── TokenBudgetManager.ts
│   └── WorkspaceDigest.ts
├── debate/
│   └── DebateEngine.ts
├── extension.ts
├── integrations/
│   └── WhatsAppManager.ts
├── memdir/
│   ├── findRelevantMemories.ts
│   ├── memdir.ts
│   ├── memoryScan.ts
│   ├── memoryTypes.ts
│   └── paths.ts
├── ollama-chat.ts
├── panels/
│   └── ChatPanelAdapter.ts
├── providers/
│   └── ProviderRegistry.ts
├── services/
│   ├── HeartbeatService.ts
│   ├── SessionNotes.ts
│   ├── WorkflowEngine.ts
│   └── extractMemories/          (folder; contents beyond depth 2)
├── team/
│   ├── TeamCallModel.ts
│   ├── TeamContextStore.ts
│   ├── TeamManager.ts
│   ├── TeamShared.ts
│   └── TeamWorkspaceScanner.ts
├── tools/
│   ├── AmiClaw.code-workspace
│   ├── SandboxManager.ts
│   ├── SandboxTypes.ts
│   ├── ToolAuditLog.ts
│   ├── ToolCache.ts
│   ├── ToolExecutor.ts
│   ├── ToolPolicies.ts
│   ├── ToolRegistry.ts
│   ├── ToolTypes.ts
│   └── providers/                (folder; contents beyond depth 2)
├── webview/
│   ├── WebviewRenderer.test.js
│   └── WebviewRenderer.ts
├── chat-AgentExecutor.txt
└── chat-QueryEngine.txt
```

## 2. package.json — "scripts" section

```json
{
  "vscode:prepublish": "npm run compile",
  "compile": "tsc -p .",
  "watch": "tsc -p . -w",
  "package": "node -e \"require('fs').mkdirSync('./dist',{recursive:true})\" && npx vsce package --out ./dist/amiclaw.vsix",
  "check:unused": "knip",
  "health": "node scripts/health-check.js",
  "test": "npm run compile && node --test src/webview/WebviewRenderer.test.js",
  "test:webview": "npm run compile && node --test src/webview/WebviewRenderer.test.js"
}
```
