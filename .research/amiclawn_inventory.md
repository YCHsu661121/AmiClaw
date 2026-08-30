# AmiClaw Project Inventory

> Generated: coordination inventory step (auto-generated)

## 1. File Tree (top 2 levels, build artifacts omitted)

```
d:\Tools\AmiClaw\
├── .amiclaw/                    # Runtime state (agent memory)
│   └── memory/                  # MEMORY.md, session-notes.md
├── .github/                     # copilot-instructions.md, UEFI Code review.agent.md,
│                                #   uefi-code-review-skills.instructions.md, instructions/, skills/
├── .research/                   # (created by this step)
├── .vscode/                     # settings.json
├── docs/
│   └── HEARTBEAT_DESIGN.md      # HeartbeatService design doc
├── media/
│   └── ami-ai-claw-activity.svg # Activity bar icon
├── scripts/                     # Health checks, Ollama/Codex proxy, WA manager (standalone),
│                                #   cleanup/status Python helpers (Dockerfile.tailscale)
├── tools/                       # Ad-hoc JS/Python debug & check scripts
├── src/                         # All application source (TypeScript, ~61 files)
│   ├── extension.ts             # VS Code extension activation (593 lines)
│   ├── ollama-chat.ts           # Main chat panel + agent wiring (3047 lines, "God Class")
│   ├── autopilot/               # AutoPilotClassifier/Policy/Denials/State/Prompt, safeAllowlist
│   ├── chat/                    # AgentExecutor (1592 L), QueryEngine (1032 L),
│   │                            #   AgentCarryover, RefusalDetector (+ .txt backups)
│   ├── context/                 # HistoryCompactor, MicroCompactor, SystemPromptBuilder,
│   │                            #   TokenBudgetManager, WorkspaceDigest
│   ├── debate/                  # DebateEngine (two-model debate + judge)
│   ├── integrations/            # WhatsAppManager (Baileys)
│   ├── memdir/                  # Memory dir: memdir, memoryScan, findRelevantMemories, paths
│   ├── panels/                  # ChatPanelAdapter
│   ├── providers/               # ProviderRegistry (model provider abstraction)
│   ├── services/                # HeartbeatService, SessionNotes, WorkflowEngine,
│   │                            #   extractMemories/
│   ├── team/                    # TeamManager (1619 L), TeamCallModel, TeamContextStore,
│   │                            #   TeamShared, TeamWorkspaceScanner
│   ├── tools/                   # ToolExecutor (3327 L), ToolRegistry, ToolPolicies,
│   │   └── providers/           #   ToolCache, ToolAuditLog, SandboxManager/Types +
│   │                            #   FileSystem/Process/Search/Git/Network/DevTools/
│   │                            #   Vscode/Jenkins/Atlassian/Integration providers
│   └── webview/                 # WebviewRenderer (4127 L) + test.js
├── dist/                        # Packaged .vsix output
├── logs/                        # Runtime logs
├── out/                         # tsc build output (main: out/extension.js)
├── node_modules/
├── AmiClawToDo.md               # Strategic roadmap vs claude-code (en)
├── Consolidated_Notes.md        # Deep comparison & refactor priorities (zh-TW, 2026-08-10)
├── Dockerfile                   # Docker packaging
├── docker-compose.yml
├── build.bat / build.log        # Build script + last build log
├── agent-training.jsonl         # Training data (JSONL)
├── package.json                 # VS Code extension manifest (ami-ai-claw v1.0.1)
├── tsconfig.json
├── knip.json                    # Unused-code checker config
└── LICENSE (MIT)
```

## 2. Tech Stack Summary

- **Language:** TypeScript (~57 .ts files in src/, compiled with `tsc -p .`); a few ad-hoc JS/Python helper scripts.
- **Framework / platform:** VS Code extension (`@types/vscode` ^1.90, packaged with `vsce`), webview-based UI.
- **Runtime deps:** `@whiskeysockets/baileys` (WhatsApp integration), `qrcode`.
- **AI backend:** Ollama (primary, `ollama-chat.ts`), OpenAI-compatible endpoints (LM Studio/vLLM), GitHub Copilot routing (`copilot::`), model registry in `src/providers/`.
- **Agent infra:** tool registry with Provider Pattern (10+ tool providers), AutoPilot safety classifier, Docker sandboxing (Playwright image for browser tools, ubuntu/python images for command sandbox), workflow engine, multi-agent Team/Debate modes, WhatsApp-triggered agent (voice via Whisper).
- **Tooling:** knip (dead-code), `node --test` (WebviewRenderer.test.js), Docker (Dockerfile + compose, incl. Tailscale variant).

## 3. Entry Points

| Entry | Path | Role |
|---|---|---|
| Extension activation | `src/extension.ts` → `out/extension.js` (package.json `main`) | VS Code extension lifecycle; registers views/commands (chat, Jira, UEFI review, memory, file-count commands) |
| Chat/agent panel | `src/ollama-chat.ts` | Main chat UI + agent orchestration wiring (God Class, ~3000 L) |
| Webview UI | `src/webview/WebviewRenderer.ts` | Renderer for chat webview (~4100 L) |
| Agent execution | `src/chat/AgentExecutor.ts`, `src/chat/QueryEngine.ts` | Coordinator/Worker agent runtime |
| Tool execution | `src/tools/ToolExecutor.ts` | Giant tool dispatch switch (~3300 L) |
| Dev scripts | `scripts/health-check.js`, `scripts/ollama-codex-proxy.js` | Health checks, proxy server |

## 4. Project Overview

AmiClaw (`ami-ai-claw` v1.0.1, MIT, author Y.C. Hsu) is a **local AI assistant VS Code extension** built around Ollama and OpenAI-compatible endpoints, focused on code generation, agent automation, and multi-model collaboration. It provides Ask/Agent/Team/Debate/Compare chat modes with a tool-calling agent runtime (file/git/search/process/network/Jenkins/Atlassian/browser tools), an AutoPilot safety classifier with Docker sandboxing, layered context compression (MicroCompactor/HistoryCompactor/token budgets), file-based memory (`MEMORY.md`, session notes), a Workflow Engine, and integrations for WhatsApp (Baileys), Jira, Jenkins, and UEFI/BIOS firmware code review. Root docs `AmiClawToDo.md` and `Consolidated_Notes.md` are strategic roadmaps comparing AmiClaw against Claude Code (claude-code) and defining refactor priorities (CORE_TOOLS expansion, TF-IDF tool search upgrade, worker role isolation, workflow resume, LSP tools, USD cost display). The `ollama-chat.ts` God Class and the `ToolExecutor.ts` giant switch are the acknowledged primary technical debt.
