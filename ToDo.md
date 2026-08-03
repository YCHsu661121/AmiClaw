# 🚀 Global Codebase Analysis Project
*Goal: Identify potential bugs, risks, and architectural defects across the entire AmiClaw codebase.*

## 📋 Project Roadmap

### 🟢 Completed Phases
- [x] **Phase 0: Structural Mapping** (Identify modules, boundaries, and dependencies)
- [x] **Phase 1: Core Execution Engine Analysis** (`src/chat/*`)
  - *Focus: AgentExecutor loop, cancellation handling, state persistence.*

### 🟡 In-Progress Phases
- [ ] **Phase 2: Context & Prompt Engineering Analysis** (`src/context/*`)
  - *Focus: Token budgeting, history compaction, system prompt construction, workspace digest logic.*

### ⚪ Pending Phases
- [ ] **Phase 3: Tooling & Side-effects Analysis** (`src/tools/*`, `src/services/*`)
  - *Focus: File I/O safety, command execution boundaries, error handling in tool calls.*
- [ ] **Phase 4: Multi-Agent Coordination Analysis** (`src/team/*`)
  - *Focus: TeamManager state management, cross-agent context contamination, race conditions.*
- [ ] **Phase 5: Integration & Webview Analysis** (`src/webview/*`, `src/extensions.ts`)
  - *Focus: Data passing between extension and webview, UI responsiveness during long tasks.*

### 🏁 Final Deliverable
- [ ] **Final Bug Report Compilation** (Consolidating all findings into a structured `bug.md` with severity levels)
