# 🐛 Bug Report - AmiClaw Agent System

This document tracks identified defects and potential risks found during the structural analysis of the AmiClaw codebase.

## 🔴 Critical Issues

### [BUG-001] Agent Execution Deadlock on Cancellation
- **Location:** `src/chat/AgentExecutor.ts` -> `handleAgent()`
- **Description:** When a user cancels an ongoing agent task (via `cancelAgent()`), the loop terminates via `break`, but the class property `this._agentRunning` is never reset to `false`.
- **Impact:** The Agent becomes permanently locked in "Running" state. Users will see "Agent is already running" and won't be able to start any new tasks until VS Code is reloaded.
- **Reproduction Path:** 
  1. Start an agent task (e.g., a long `search_workspace`).
  2. Click "Cancel" in the UI.
  3. Attempt to start a new task $\to$ Fails with information message.
- **Suggested Fix:** Wrap the entire logic of `handleAgent` in a `try...finally` block and ensure `this._agent ⋯ running = false;` is called in `finally`.

---

## 🟠 Major Issues

### [BUG-002] Session Notes Persistence Gap
- **Location:** `src/chat/AgentExecutor.ts` & `src/services/SessionNotes.ts`
- **Description:** Session notes are updated periodically (every $N$ tool calls). If the agent is interrupted or crashes, the most recent successful operations (e.g., a file being created) are not persisted to the session note before the function exits.
- **Impact:** Loss of "Short-term memory" across sessions. Upon restarting, the Agent will not know that the last command actually succeeded.
- **Suggested Fix:** Implement an explicit `flushNotes()` call in the `finally` block of `handleAgent`.

### [BUG-004] Context Fragmentation during Auto-Summarization
- **Location:** `src/chat/AgentExecutor.ts` -> `handleAgent()` loop
- **Description:** The `autoSummarizeHistory` is called at the *start* of a new iteration. If a tool output in the *previous* iteration was extremely large and marked as `[OLD RESULT CLEARED]`, but the summary hasn't processed it yet, the model might receive a context that is semantically incomplete.
- **Impact:** Model hallucinations or "forgetting" recent tool results.

---

## 🟡 Minor Issues

### [BUG-003] Unsafe Error Type Casting
- **Location:** `src/chat/AgentExecutor.ts`
- **Description:** Usage of `(e as Error)?.message ?? e` in error handling blocks.
- **Impact:** Difficulties in deep debugging when non-standard error objects are thrown by external services or tool executors.

## 📊 Summary Table
| Severity | Count | Status |
| :--- | :--- | :--- |
| 🔴 Critical | 1 | Open |
| 🟠 Major | 2 | Open |
| 🟡 Minor | 1 | Open |
