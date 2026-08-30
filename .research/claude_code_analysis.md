# Claude Code (Anthropic) — Structured Technical Analysis

> Purpose: feed a deep comparison of **AmiClaw** (local project) vs **Claude Code**, and inform a refactor priority roadmap.
> Scope: architecture, tools, permissions, context, subagents, extensibility, CLI/UX, integration surface, strengths/weaknesses.

## 0. Evidence Base & Method (read this first)

**How this was produced.** Claude Code is **installed locally** on this machine. The primary evidence is the on-disk state under `~/.claude` (`C:\Users\YCHsu\.claude`), not just public docs.

**Verified locally (directly observed):**

| Artifact | What it tells us |
|---|---|
| `~/.claude/cache/changelog.md` | Full version history, **294 version entries**, from `0.2.21` up to **`2.1.148`** (installed/last-fetched). This is a *primary* source for feature introductions and fixes. |
| `~/.claude/settings.json` | Active config: `defaultMode: bypassPermissions`, `model: claude-opus-4-7`, `effort: max`, `theme: dark`, `language: chinese`, `desktopNotificationsEnabled: true`. |
| `~/.claude/backups/.claude.json.backup.*` | Global config schema: `numStartups`, `customApiKeyResponses`, `tipsHistory`, `migrationVersion`, `userID`, `hasCompletedOnboarding`, per-project `projects{allowedTools, mcpServers, hasTrustDialogAccepted, hasClaudeMdExternalIncludesApproved}`, `githubRepoPaths`, `officialMarketplaceAutoInstall*`. |
| `~/.claude/cc-haha/providers.json` + `settings.json` | Provider abstraction config: `apiFormat: anthropic`, `runtimeKind: anthropic_compatible`, `models{main,haiku,sonnet,opus}`, `ANTHROPIC_BASE_URL` / `ANTHROPIC_MODEL` / `ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS}_MODEL`. (Local instance is pointed at Ollama / custom endpoints.) |
| `~/.claude/plugins/marketplaces/claude-plugins-official` | Official marketplace repo **checked out locally**: `anthropics/claude-plugins-official`, `marketplace.json` lists **203 plugins**, plus `external_plugins/` (github, gitlab, playwright, asana, linear, context7, etc.). |
| `~/.claude/{projects,sessions,file-history,history.jsonl,adapters.json}` | Session persistence model, per-project dirs, file-history snapshots, prompt history, IDE/desktop pairing (`adapters.json` pairing code). |
| `~/.claude/.runtime/` | Bundled runtime: `requirements.txt` + `venv` + `win_helper.py` (Windows helper). |

**Version note.** Installed/last-fetched version is **`2.1.148`**. This is far beyond most public documentation and well beyond typical training cutoffs. Feature descriptions below are grounded in the changelog where possible; where I rely on general knowledge of the public docs / `anthropics/claude-code` repo, I mark it **[memory]**. Where a detail is version-dependent I note the version.

**Not observed locally** (no binary on PATH at time of check; `claude` command not resolvable via `where`): the actual JS runtime/binary and exact system-prompt text. System-prompt construction is therefore described from public docs + behavior inference, marked **[memory/inferred]**.

---

## 1. Architecture Overview

### 1.1 Core agent loop
Claude Code is a **terminal-native agentic coding tool** built around a single core **agent loop** (a.k.a. the "agentic harness"):

```
user prompt
   → build context (system prompt + CLAUDE.md + tools + conversation)
   → LLM call (Anthropic Messages API, streaming)
   → parse assistant response (text + tool_use blocks)
   → for each tool_use: permission check → execute tool → append tool_result
   → loop until model emits a final text turn with no pending tool_use
   → render to TTY (streaming)
```

Key characteristics:
- **Tool-use driven**: the model emits structured `tool_use` blocks; the client executes them locally and feeds `tool_result` back. The loop is a standard *ReAct*-style plan→act→observe cycle, but with rich local tooling and a permission gate on every mutating action.
- **Streaming-first**: responses stream token-by-token to the terminal; tool calls are surfaced as they arrive.
- **Stateless per-call, stateful session**: the model itself is stateless; session state (conversation, todos, file edits, checkpoints) lives client-side and is persisted to `~/.claude/projects/<project>/` and `file-history/`.
- **Sub-loop / subagent isolation**: the `Task` tool (and agent teams) spawn child agent loops that run in their own context window and return a single summarized result to the parent (see §4).

### 1.2 LLM provider usage
- **Primary provider**: Anthropic **Messages API** (`api.anthropic.com`), via Claude models. Model tiers map to the roles `main` / `sonnet` / `opus` / `haiku` (fast/cheap model used for background classification, summarization, compaction, and the small-model "haiku" path; larger `sonnet`/`opus` for the main reasoning path).
- **Model selection**: interactive `/model` picker; default per plan. Changelog shows `/model` changing the current session vs. default (`d` to set default). A `CLAUDE_CODE_SUBAGENT_MODEL` env var lets subagents use a different (often cheaper) model.
- **Provider abstraction** (verified locally): `providers.json` supports `apiFormat: anthropic` and `runtimeKind: anthropic_compatible`, and the env-var surface (`ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS}_MODEL`) means **any Anthropic-compatible endpoint** can be used — including Ollama / self-hosted / LiteLLM-style gateways. The local instance points `ANTHROPIC_BASE_URL` at `http://ai:11434` (Ollama) with `gemma4`/`qwen3.6` models.
- **Cloud providers** (changelog `[memory]`-corroborated): Bedrock, Vertex, and "Foundry" (Azure) are supported and propagate API-provider env vars to spawned processes (agent teams / tmux).
- **1M context** variants exist (changelog: `1M` appears across many versions, e.g. `sonnet1m45MigrationComplete`, `opus1mMergeNoticeSeenCount` in local config) — long-context model variants are first-class.

### 1.3 System prompt construction **[memory/inferred]**
The effective system prompt is assembled at session start from layered sources:
1. **Base system prompt** — Anthropic-maintained harness prompt describing the agent loop, tool usage, output conventions, safety/permissions behavior, and "Claude Code" persona.
2. **Output style** (if set) — overrides tone/format instructions (see §5.4).
3. **CLAUDE.md memory hierarchy** (see §3.3) — injected as project/personal/enterprise instructions.
4. **Tool definitions** — the JSON schemas for the active tool set (Bash, Read, Write, Edit, Grep, Glob, TodoWrite, WebFetch, WebSearch, Task, NotebookEdit, etc.).
5. **Environment context** — current directory, OS, platform, git status awareness, etc.
6. **Session resume / compaction summaries** — when resuming or after auto-compaction, a summary replaces earlier turns.

The exact text is proprietary and not shipped as a plain file in `~/.claude` (no `*.prompt` artifact was observed locally); the above is reconstructed from public docs and observed behavior.

---

## 2. Tool System

### 2.1 Built-in tool inventory

Tools are the model's "hands". Each is a JSON-schema tool definition the harness executes locally. Inventory (core set + notable additions):

| Tool | Purpose | Notes |
|---|---|---|
| **Bash** | Run shell commands | Persistent shell session; supports `!` prefix for user-forced runs; shell snapshot captures user aliases/functions (changelog: fixed snapshot dropping `_`-prefixed user functions). Exit codes returned to model. On Windows runs PowerShell (changelog 2.1.147: "PowerShell tool" fixes — output formatter, `pwsh` via winget/Store). |
| **Read** | Read file contents | Returns **truncated first page with a "PARTIAL view" notice** when a whole-file read exceeds the token limit (added 2.1.145). Supports PDFs/images (multimodal). Offset/limit for paging. |
| **Write** | Create/overwrite files | Goes through permission gate. |
| **Edit** | Targeted string replacement in files | Requires exact-match old string; auto-fallback to create-if-missing in some versions. Changelog 2.1.147: "Improved diff rendering performance for large file edits". |
| **Grep** | Regex search (Ripgrep-backed) | Flags for context lines, file types, exclude patterns. |
| **Glob** | Filename pattern search | Fast file discovery. |
| **LS / list** | Directory listing | (Historically a dedicated tool; newer versions fold listing into Glob/Bash in some builds.) |
| **NotebookEdit** | Edit Jupyter notebook cells | Cell-level JSON edits. |
| **TodoWrite** | Manage task list | In-context task list for multi-step work; changelog 2.1.145: "Fixed task lists rendering in random order when several tasks are created at once". Backed by `TaskCreate/TaskUpdate` in newer agent-teams builds. |
| **WebFetch** | Fetch URL → markdown | Preflight fetch (can be skipped via `skipWebFetchPreflight`, seen in local `cc-haha/settings.json`); renders page to text for the model. |
| **WebSearch** | Web search | Provider-backed search returning snippets. |
| **Task** | Spawn subagent | Runs a sub-agent loop with its own context window; returns a summary. (See §4.) |
| **Agent / agent teams** | Multi-agent orchestration | See §4. |
| **AskUserQuestion** | Structured user question | Changelog 2.1.147: "auto mode suppressing AskUserQuestion when the user or a skill explicitly relies on it" — confirms a first-class ask-user tool. |
| **KillShell / background Bash** | Manage long-running processes | Background jobs, `Ctrl+T` pinned background sessions. |
| **MCP tools** | Any `mcp__server__tool` | Dynamically discovered from connected MCP servers (§5.2). |
| **Skill tools / `Skill`** | Invoke agent skills | Skills are prompt+script bundles; changelog 2.1.147: "a skill using `context: fork` could repeatedly re-invoke itself" — confirms Skill tool with context-fork semantics. |
| **LSP tools** | Language-server queries | Via LSP plugins (clangd-lsp, gopls-lsp, csharp-lsp, jdtls-lsp, kotlin-lsp, lua-lsp all in official marketplace). |

The tool set is **configurable**: `allowedTools`/`disallowedTools` per project (verified in local `.claude.json`: `"allowedTools": []`), permission rules can scope tools, and MCP tools are namespaced.

### 2.2 Permission system

This is Claude Code's most distinctive design surface.

**Permission modes** (selectable via `Shift+Tab` cycling or `/permissions`; persisted per project/user):
- **default** — safe reads auto-approved; mutating tools (Write, Edit, Bash side-effects) prompt.
- **acceptEdits** — auto-approve file edits; other prompts remain.
- **plan** (plan mode) — read-only exploration; model plans, user approves before execution. Changelog: "plan-mode-for-complex-tasks" tip (verified in local `tipsHistory`).
- **bypassPermissions** (a.k.a. `--dangerously-skip-permissions`) — skip prompts; local config has `defaultMode: bypassPermissions`.
- **auto mode** (newer) — an LLM classifier auto-approves/denies prompts; changelog 2.1.141: "Auto mode permission dialog now explains when a `permissions.ask` rule caused the prompt"; 2.1.147: auto-mode classifier sees user answers as intent signal.
- **sandbox** mode — Bash sandboxing (below) can be combined with modes.

**Allow/deny/ask rules** — rule-based lists evaluated per tool invocation:
- Syntax: `Tool`, `Tool(specifier)`, e.g. `Bash(git push*)`, `Edit(src/**)`, `WebFetch(domain:example.com)`, `PowerShell(git push*)` (changelog 2.1.147: hook `if` conditions like `PowerShell(git push*)` now match).
- Three rule tiers: **allow**, **ask**, **deny**. Precedence: deny > ask > allow (roughly; deny wins).
- Stored at multiple scopes: user (`~/.claude/settings.json`), project (`.claude/settings.json`), local project (`.claude/settings.local.json`), enterprise/managed settings (changelog: `forceLoginOrgUUID` / `forceLoginMethod` managed-settings; enterprise login restrictions).
- **"Yes, and don't ask again"** writes a persistent rule (changelog 2.1.147: Windows PowerShell script rule fix).
- Security hardening: changelog 2.1.145: "Fixed a permission-prompt bypass where bare variable assignments to non-allowlisted environment variables in Bash commands were auto-approved" — shows prompt-injection-aware rule matching.

**Sandboxing**:
- Bash sandbox released 2.0.24 for Linux & macOS (bubblewrap/Firejail-style network+FS isolation); `/sandbox` menu (changelog 2.1.147: layout fixes to `/sandbox` menu). Windows sandboxing arrived later via different mechanics (version-dependent).
- Sandboxing is orthogonal to permission modes: sandbox constrains what Bash can touch even when auto-approved.

**Hooks for permission prompts**:
- Hooks (see §5.1) can intercept **PreToolUse** (can deny/modify before execution), **PostToolUse**, **PermissionRequest** (hook-driven permission prompts), **Stop**, **SubagentStop**, **SessionStart**, **UserPromptSubmit**, etc.
- Changelog 2.1.145: "Stop and SubagentStop hook input now includes `background_tasks` and `session_crons` fields" — hook inputs are JSON-rich and evolving.
- Hook `if` conditions (e.g. `PowerShell(git push*)`) filter when hooks fire (2.1.147).
- Prompt- and agent-type hooks allowed on most events, but `SessionStart`/`Setup`/`SubagentStart` require command-type hooks (2.1.142-era fix).

**Trust dialog**: per-project trust on first run (verified locally: `hasTrustDialogAccepted: true` in `.claude.json` for `D:/Tools/AmiClaw`) — gates loading project-level settings/hooks.

**File-history / checkpoints**: every file mutation is snapshotted under `~/.claude/file-history/` (verified: 11 session dirs locally). Rewind capability: changelog 2.1.141 "Rewind menu: added 'Summarize up to here' to compress earlier context while keeping recent turns intact" — rewind both code state and conversation.

---

## 3. Context Management

### 3.1 Context window limits
- Standard Claude models: **200K token** context window (Sonnet/Opus); **1M context** variants for Sonnet (and merged Opus 1M per local `opus1mMergeNoticeSeenCount`) — changelog `1M` mentions span `2.0.58`→`2.1.144`, with `sonnet1m45MigrationComplete` in local config.
- Effective usable context is smaller: system prompt + tool schemas + CLAUDE.md + conversation + tool results must all fit. Tool results are individually capped (Read truncation with "PARTIAL view" notice, 2.1.145; large Bash outputs are truncated/summarized).
- The context bar in the UI shows remaining context percentage; near-limit triggers compaction prompts.

### 3.2 Auto-compaction
- Introduced early: changelog `0.2.47` — "**Automatic conversation compaction for infinite conversation length** (toggle with /config)".
- When context nears the limit, Claude Code summarizes the earlier conversation into a compact summary, keeping recent turns verbatim. Multiple compaction passes possible for very long sessions.
- Improvements across versions: 2.1.0 "Improved compaction reliability"; 2.1.142-era: "the first summarize attempt now seeds from the original request's overflow size, avoiding a wasted near-full-context retry" (avoids retrying at near-full context).
- **Manual compaction**: `/compact` (with optional focus instruction).
- **Rewind + summarize**: "Summarize up to here" (2.1.141) — compress earlier context while keeping recent turns, i.e. on-demand partial compaction tied to the rewind menu.
- **Micro-compaction**: older tool results are pruned/summarized before full compaction (version-dependent, from public docs **[memory]**).
- `context: fork` in skills: a skill can fork its own context to avoid polluting the main context (2.1.147 infinite-loop fix confirms the feature).

### 3.3 CLAUDE.md memory hierarchy
Claude Code loads `CLAUDE.md` files from multiple scopes, **aggregated at session start** (most specific wins on conflicts by convention):

| Scope | Location | Purpose |
|---|---|---|
| **Enterprise** | `/etc/claude-code/managed-settings.json` (macOS: `/Library/Application Support/ClaudeCode/`), managed policy settings | Org-wide policy; can enforce login methods, permission rules, disable features (changelog: `forceLoginOrgUUID`, `forceLoginMethod`). |
| **Project (shared)** | `<repo>/CLAUDE.md`, `<repo>/.claude/CLAUDE.md` | Team-shared instructions; committed to repo. |
| **Project (local)** | `<repo>/CLAUDE.local.md` (convention; not in official docs) / `.claude/settings.local.json` for settings | Personal project notes. |
| **Personal** | `~/.claude/CLAUDE.md` | Cross-project user preferences. |
| **Subdirectory** | `subdir/CLAUDE.md` | Scoped to that subtree; loaded on demand when working there. |

Features (verified via changelog):
- **Imports**: `CLAUDE.md` files can import other files via `@path/to/file.md` (added `0.2.107`).
- **External include approval**: `hasClaudeMdExternalIncludesApproved` / `hasClaudeMdExternalIncludesWarningShown` (verified in local `.claude.json`) — @-imports outside the project root are gated by a warning/approval (prompt-injection defense).
- **`/init`** generates a starter CLAUDE.md for the repo **[memory]**.
- Changelog 2.1.90/2.1.89/2.1.86: ongoing CLAUDE.md behavior fixes.
- **Memory tool** (newer versions): an explicit `Memory` tool writes to a persistent memory store for long-term recall beyond CLAUDE.md (changelog `memory` mentions across 48 versions; `2.1.117`+ adds memory management features **[memory]** — version-dependent).

### 3.4 Context editing
- **`/rewind`**: restore code state and/or conversation to earlier checkpoints (file-history snapshots). Changelog 2.1.141 added "Summarize up to here" to the rewind menu.
- **`/clear`**: reset conversation (keeps CLAUDE.md + tools).
- **Context trimming**: tool results are the largest context consumers; Claude Code truncates old tool outputs (micro-compaction) and keeps file reads re-fetchable (the model can re-Read files rather than holding them).
- **`/code-review`** (renamed from `/simplify`, 2.1.147): correctness review at chosen effort level; `--comment` posts inline GitHub PR comments — runs in forked context.
- **Paste/upload**: large pasted text is handled (2.1.147 fixed `[Pasted text #N]` placeholder bug); `uploads/` dir in `~/.claude` (verified locally) stores attached files.
- **Images/media**: multimodal inputs supported; 2.1.147: "Fixed stripped images prompting the model to repeatedly re-read media that was no longer present" — context-editing of media references.

---

## 4. Subagents and Parallelism

### 4.1 Task tool (subagents)
- **`Task`** spawns a sub-agent with its **own context window** and its own tool loop; the parent receives a single summary result. This isolates noisy exploration (e.g. "search this 50k-line codebase") from the main context.
- Default subagent types: **Explore** (read-only, cheap/fast model, for searching), **Plan** (planning), and general-purpose.
- **`CLAUDE_CODE_SUBAGENT_MODEL`** env var sets the model for subagents (changelog 2.1.147: now applies to teammate processes spawned by agent teams).
- Subagent completion notifications include elapsed duration (2.1.144: "Agent completed — 3h 2m 5s").
- **Background subagents**: subagents can run in the background (pinned via `Ctrl+T` in `claude agents`, 2.1.147: pinned sessions stay alive when idle, restarted in place for updates, shed only under memory pressure).
- **SubagentStop hook** fires on subagent completion (input includes `background_tasks` and `session_crons`, 2.1.145).
- **OTEL tracing**: `claude_code.tool` spans carry `agent_id` / `parent_agent_id`; background subagent spans nest under the dispatching Agent tool span (2.1.145) — observability is first-class.

### 4.2 Custom subagent definitions
- Defined as **Markdown files with YAML frontmatter**: `~/.claude/agents/*.md` (user) or `.claude/agents/*.md` (project).
- Frontmatter fields: `name`, `description` (when-to-use, model-driven selection), `tools` (allowlist), `model` (haiku/sonnet/opus/inherit), plus the markdown body = the subagent's system prompt.
- Plugins can ship agents (changelog 2.1.147: "plugin agents that declare multiple `Agent(...)` types in `tools:` frontmatter" — confirms `tools:` frontmatter syntax).
- Invoked explicitly ("Use the test-runner agent...") or **automatically** when the model delegates matching work; `@agent-name` mentions also work.

### 4.3 Agent teams (multi-agent collaboration)
- **Introduced `2.1.32`**: "Added research preview agent teams feature for multi-agent collaboration (token-intensive feature, requires setting `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`)".
- A **team lead** spawns **teammates** (each a full Claude Code session, run in tmux panes on Unix); teammates communicate via message passing, share a task list, and report back to the lead.
- Evolved through 2.1.x: tmux message send/receive (2.1.33), plan availability fixes (2.1.33), Bedrock/Vertex/Foundry provider env propagation (2.1.45), memory-leak fix for completed teammate tasks (2.1.50), permission-mode inheritance with `--dangerously-skip-permissions` (2.1.98), permission-dialog crash fix (2.1.114), non-ASCII teammate name fix (2.1.145).
- `CLAUDE_CODE_SUBAGENT_MODEL` now applies to teammates (2.1.147).
- This is the most experimental surface: token-intensive, tmux-dependent, Windows support maturing (2.1.144 "macOS background sessions crashing... exit 1 before init when the project..." — platform-specific session management).

### 4.4 Parallelism model
- **Intra-session**: the agent loop is sequential; parallelism comes from (a) background Bash jobs, (b) subagents/teams running concurrently, (c) user running multiple `claude` instances (multi-window / `claude agents` background sessions).
- **`claude agents`**: a session manager/agent view — lists live sessions (`claude agents --json`, 2.1.145), background sessions (`claude --bg`, `/bg`, `/background`), tab titles show awaiting-input count, cross-project resume hints.
- **Background sessions**: `claude --bg` starts detached sessions; `/resume` lists them (marked `bg`, 2.1.144); background-job worktrees (git worktrees per job, Windows NTFS-junction-safe, 2.1.147).

---

## 5. Extensibility

Claude Code has a deep extensibility stack. From lightest to heaviest:

### 5.1 Hooks
**Hooks** are user-defined shell commands (or prompt/agent-type handlers) that run at lifecycle points, with JSON input/output. They are the primary mechanism for custom permission logic, automation, and guardrails.

- **Event points** (from public docs + changelog corroboration):
  - `PreToolUse` — can **deny** or **modify** a tool invocation before it runs (return `{decision: "block"}` or edit the input).
  - `PostToolUse` — react to results (e.g. auto-format after Edit).
  - `PermissionRequest` — custom permission prompts; hooks can auto-approve/deny (this is how teams implement policy beyond the rule lists).
  - `UserPromptSubmit` — validate/transform incoming prompts.
  - `Stop` / `SubagentStop` — on turn/subagent completion (input includes `background_tasks`, `session_crons` since 2.1.145).
  - `SessionStart` / `Setup` / `SubagentStart` — must be **command-type** hooks (2.1.142 fix).
  - `Notification` — on desktop notifications.
- **Configuration**: `hooks` key in settings (user/project/local) or plugin-provided. Hook `if` conditions (e.g. `PowerShell(git push*)`) filter when they fire (2.1.147).
- **Output contract**: JSON with `decision`, `reason`, `updatedInput`, and (since 2.1.141) `terminalSequence` for emitting notifications/window titles/bells without a controlling terminal.
- **Official `hookify` plugin** (in marketplace): "Easily create hooks to prevent unwanted behaviors by analyzing conversation patterns."
- Hooks are **cross-platform** (run via the configured shell; Windows via PowerShell/win_helper, verified locally).

### 5.2 MCP servers (Model Context Protocol)
- **First-class integration** (changelog: MCP mentioned in 106 versions, back to `0.2.36`).
- **Add servers**: `claude mcp add <name> <command>`, `claude mcp add-json <n> <json>`, `claude mcp add-from-claude-desktop` (import from Claude Desktop, 0.2.36).
- **Scopes**: local (project), project (committed `.mcp.json`), user, enterprise. `.mcp.json` enables team-shared server configs.
- **Transport**: stdio (default), plus HTTP/SSE for remote servers.
- **Tool naming**: `mcp__<server>__<tool>`; servers expose **tools, resources, prompts, and templates** (changelog 2.1.147: "Fixed paginating MCP servers dropping resources, templates, and prompts past page 1").
- **MCP prompts** surface as slash commands (2.1.145: "MCP prompt slash commands showing raw server validation errors... the error now names the missing argument").
- **LSP integration** via MCP (clangd-lsp, gopls-lsp, csharp-lsp, jdtls-lsp, kotlin-lsp, lua-lsp in official marketplace).
- **`/mcp`** menu for listing/connecting/disconnecting servers at runtime.
- **Context URIs**: `mcpContextUris` per project (verified in local `.claude.json`) — servers can inject context.
- **External integrations** shipped as plugins: github, gitlab, playwright, asana, linear, context7, chrome-devtools-mcp, etc. (verified in `external_plugins/`).

### 5.3 Slash commands
- **Built-in**: `/help`, `/init`, `/compact`, `/clear`, `/model`, `/resume`, `/continue`, `/permissions`, `/sandbox`, `/plugin`, `/status`, `/statusline`, `/feedback`, `/theme`, `/code-review`, `/review`, `/usage-credits`, `/bg`, `/background`, `/effort`, `/memory`, etc. (many confirmed via changelog).
- **Custom**: Markdown files in `.claude/commands/*.md` (project) or `~/.claude/commands/*.md` (user). Frontmatter can declare `description`, `argument-hint`, `allowed-tools`, `model`, `context` (e.g. `context: fork`), and `$ARGUMENTS`/`$1..$n` templating.
- **Namespaced**: subdirectories create namespaces (`/commands/git/commit.md` → `/git:commit`).
- **Dynamic arguments**: `!`command`` shell interpolation inside command bodies; `$ARGUMENTS` for positional args.
- **MCP prompts** also appear as slash commands (see §5.2).
- Unknown slash commands error in headless/SDK mode (2.1.147).
- Plugins can ship slash commands (see §5.6).

### 5.4 Output styles
- **Introduced `1.0.81`**: "Released output styles, including new built-in educational output styles 'Explanatory' and 'Learning'."
- An output style **replaces the system prompt's output-formatting section** with custom instructions (e.g. terse, verbose, educational).
- Built-ins: `Explanatory`, `Learning`, `Proactive`, `Terse` (plus `default`); custom via `.claude/output-styles/*.md` with `name`, `description`, `model` frontmatter.
- `1.0.84`/`2.0.32`/`2.0.37`/`2.0.41`: iterative improvements; 2.1.94/2.1.141: further refinements.
- Official `explanatory-output-style` and `learning-output-style` plugins in marketplace.

### 5.5 Skills
- **Agent Skills**: folders with a `SKILL.md` (YAML frontmatter: `name`, `description`, optional `allowed-tools`, `context`) + supporting scripts/resources. Invoked by the `Skill` tool; can run in `context: fork` (isolated context) or inline.
- Skills are the newer, richer extension primitive over slash commands: they bundle instructions + executable scripts + assets, and are auto-selected by the model based on description.
- Official marketplace ships many skill-based plugins (e.g. `aws-dev-toolkit`: "34 skills, 11 agents, and 3 MCP servers").

### 5.6 Plugins & marketplaces
- **Introduced `2.0.12`**: "**Plugin System Released**: Extend Claude Code with custom commands, agents, hooks, and MCP servers from marketplaces."
- **A plugin =** a bundle that can include: slash commands, agents (subagents), hooks, skills, MCP servers, LSP servers, output styles, and theme files — all declared in `.claude-plugin/plugin.json` + `marketplace.json`.
- **Marketplaces**: git repos (or GitHub) that list plugins; official one is `anthropics/claude-plugins-official` (verified locally: **203 plugins** + `external_plugins/`).
- **Management**: `/plugin install`, `/plugin enable/disable`, `/plugin marketplace`, `/plugin discover`, `/plugin browse`, `claude plugin details`, `claude plugin validate`, `claude plugin list` (changelog 2.1.145: Discover/Browse show commands, agents, skills, hooks, MCP/LSP servers pre-install; 2.1.144: show last-updated date).
- **Repo-level config**: `extraKnownMarketplaces` for team collaboration (2.0.12); git-based plugins support branch/tag fragments `owner/repo#branch` (2.0.28).
- **`CLAUDE_CODE_PLUGIN_PREFER_HTTPS`** (2.1.141): clone plugin sources over HTTPS instead of SSH for environments without a GitHub SSH key.
- **Auto-install**: `officialMarketplaceAutoInstallAttempted` / `officialMarketplaceAutoInstalled` (verified in local `.claude.json`) — the official marketplace is auto-installed on first run.
- **Validation**: `claude plugin validate` flags structural issues (e.g. `skills:` entries pointing at a file instead of a directory, 2.1.145).
- **External plugins** (verified locally): `asana`, `context7`, `discord`, `firebase`, `github`, `gitlab`, `greptile`, `imessage`, `laravel-boost`, `linear`, `playwright`, `serena`, `telegram`, `terraform`, `fakechat`.

### 5.7 Claude Code SDK (Agent SDK)
- **Claude Code SDK** (formerly "Claude Code SDK", now **Claude Agent SDK**) — programmatic access to the same agent harness:
  - **Python** (`claude-code-sdk`) and **TypeScript** (`@anthropic-ai/claude-code` / `@anthropic-ai/claude-agent-sdk`) packages.
  - Spawn Claude Code as a subprocess or import the loop; stream messages; inject custom tools; set permission callbacks; use subagents, hooks, MCP.
  - **Headless/SDK mode** is a distinct runtime (changelog 2.1.147: "Fixed unknown slash commands silently doing nothing in headless/SDK mode"; "an uncaught exception at the end of streaming sessions when running via the Agent SDK").
  - **Official `agent-sdk-dev` plugin** in marketplace: "Development kit for working with the Claude Agent SDK."
- The SDK is the basis for building custom agents on top of Claude Code's harness (tool execution, permissions, compaction) without the TTY.

### 5.8 Themes, statusline, and other UX extensions
- **Themes**: `/theme` with built-in + custom themes (2.1.147: "New custom theme" and color editor dialogs; Esc handling fixed).
- **Statusline**: `/statusline` custom command (see §6.6).
- **Voice**: push-to-talk voice input (2.1.145: "Fixed voice push-to-talk not working in the agent view's reply pane").
- **Desktop/mobile**: `/mobile`, IDE/desktop pairing via `adapters.json` (verified locally: pairing code + expiry), `desktopNotificationsEnabled` in settings.

---

## 6. CLI / UX Design

### 6.1 REPL and interactive mode
- `claude` launches an **interactive TTY REPL** (Ink/React-based terminal UI, full-screen mode supported).
- **Streaming** output token-by-token; tool calls rendered inline with collapsible output; **diff rendering** for file edits (unified diff, syntax-aware; 2.1.147: "Improved diff rendering performance for large file edits").
- **Keybindings**: `Esc` interrupts; `Esc+Esc` / `/rewind` for checkpoints; `Shift+Tab` cycles permission modes; `Ctrl+T` pins background sessions; arrow-up prompt history (deduplicated, 2.1.147); `@` file mentions; `#` memory shorthand; `!` shell passthrough; `Shift+O`/`Shift+R` open file diffs in IDE (restored in 2.1.141: "view diff in your IDE").
- **Prompt history**: persisted per project (`~/.claude/history.jsonl`, verified locally); consecutive duplicates not re-recorded (2.1.147).
- **Full-screen mode**: mouse hover/click on suggestion lists (2.1.145); fixed Windows Terminal strobing (2.1.147); garbled-output self-heal after missed resize (2.1.144).
- **Footer/status bar**: PR badge updates after `gh pr create` (2.1.145); GitHub repo/PR info in statusline JSON (2.1.145).

### 6.2 Headless / print mode
- `claude -p "prompt"` (**print mode**): single-turn, non-interactive; `--output-format json|stream-json|text` for machine-readable output; `--input-format stream-json` for streaming input.
- **`--dangerously-skip-permissions`**: bypass permission prompts (requires trusted env).
- **CI usage**: `claude -p` with `--max-turns`, `--allowedTools`, `--resume`, `--continue`; env vars `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` / telemetry flags for deterministic CI runs **[memory]**.
- **Session continuation flags**:
  - `--continue` (`-c`): resume the **most recent** session in the current project.
  - `--resume` (`-r`): pick a session (interactive list) or `--resume <session-id>`; 2.1.144 added background sessions to `/resume` (marked `bg`); cross-project resume hints (2.1.145: Windows `;` separator fix).
- **Unknown slash commands** in headless/SDK mode now error instead of silently no-op (2.1.147).
- **`&` in `!` command output** fixed for headless machines (copy-pasting URLs from `gcloud auth login`) (2.1.147).
- **Startup robustness**: 2.1.144 — startup hangs up to 75s when `api.anthropic.com` unreachable (captive portal/firewall/VPN); side-channel calls now time out after 15s.

### 6.3 Statusline
- **`/statusline`** (added `1.0.71`): user provides a shell command; Claude Code pipes session JSON (model, cost, context %, git info, workspace) into it, stdout = the status line.
- 2.1.145: statusline JSON now includes **GitHub repo and PR information** when detected.
- 2.1.111/2.1.86/2.1.80: iterative statusline improvements (multiple versions).

### 6.4 Agent view / multi-session UI
- **`claude agents`**: session manager listing live sessions; `--json` for scripting (tmux-resurrect, status bars, session pickers, 2.1.145); `--cwd <path>` scoping (2.1.141); tab title shows awaiting-input count (2.1.145); voice push-to-talk in reply pane (2.1.145).
- **Background sessions**: `claude --bg`, `/bg`, `/background`; pinned sessions stay alive idle, restarted in place on update, memory-pressure shedding order (2.1.147).
- **Background jobs**: git worktree per job; Windows NTFS-junction-safe removal (2.1.147).

### 6.5 Configuration surface (UX-relevant)
- **Settings cascade**: enterprise managed settings > CLI args > `.claude/settings.local.json` > `.claude/settings.json` > `~/.claude/settings.json` > defaults.
- **Env vars** (large surface): `ANTHROPIC_*` (provider), `CLAUDE_CODE_SUBAGENT_MODEL`, `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`, `CLAUDE_CODE_PLUGIN_PREFER_HTTPS`, `ANTHROPIC_WORKSPACE_ID` (2.1.141), etc.
- **`/config`** interactive config; `/status` shows active config; `/permissions` manages rules; `/usage-credits` (renamed from "extra usage", 2.1.144).
- **`/effort`** effort-level slider (2.1.147: opens at current level) — effort/max thinking control (local config: `"effort": "max"`).
- **Language**: `language: chinese` setting (verified locally) — Claude Code responds in the configured language.
- **Windows support**: PowerShell tool, `.runtime/win_helper.py` (verified locally), Windows Terminal rendering fixes — Windows is a supported first-class platform in recent versions.

---

## 7. Integration Surface

### 7.1 Git awareness
- **Repo detection**: `githubRepoPaths` maps GitHub remotes to local paths (verified in local `.claude.json`: `ychsu661121/amiclaw → D:\Tools\AmiClaw`).
- **PR badge** in footer: updates after `gh pr create` and other PR-state-changing commands (2.1.145).
- **Statusline JSON** includes repo + PR info (2.1.145).
- **`/review`**: PR review workflow (fixed 2.1.145: deprecated `projectCards` GraphQL query that errored on repos with Classic Projects — shows deep GitHub GraphQL integration).
- **`/code-review`** (2.1.147): correctness review at effort level; `--comment` posts inline GitHub PR comments.
- **Commit helpers**: `commit-commands` plugin in official marketplace; `git push` hook-condition matching (2.1.147).
- **Worktrees**: background jobs get their own git worktree (2.1.147).
- Git operations are performed via **Bash** (`git ...`), not a dedicated Git tool; awareness comes from repo metadata + model behavior.

### 7.2 CI usage
- Headless `claude -p` is the CI entry point; combined with `--output-format stream-json` for structured results.
- **Anthropic's own usage**: Claude Code powers Claude Code on web (claude.ai/code), GitHub Actions integrations, and the Agent SDK; official plugins for Buildkite, GitHub, GitLab (verified in marketplace).
- **Telemetry/OTEL**: `claude_code.tool` spans with `agent_id`/`parent_agent_id` (2.1.145) — OpenTelemetry instrumentation for enterprise observability.
- **Enterprise**: managed settings, workload identity federation via `ANTHROPIC_WORKSPACE_ID` (2.1.141), Bedrock/Vertex/Foundry providers, org login enforcement.

### 7.3 SDK/API
- **Claude Agent SDK** (Python/TypeScript) — see §5.7; exposes the same harness: tools, hooks, subagents, permissions callbacks, MCP.
- **Messages API** is the wire protocol; any Anthropic-compatible endpoint works (verified locally via `apiFormat: anthropic` / `runtimeKind: anthropic_compatible` providers pointed at Ollama).
- **MCP** is the bidirectional integration standard: Claude Code is both an MCP **client** (connects to servers) and can expose its capabilities to MCP **clients** via the SDK.
- **Desktop/IDE adapters**: `adapters.json` pairing (verified locally) links Claude Code sessions to Claude Desktop / IDE extensions; `desktopNotificationsEnabled`.

---

## 8. Known Strengths and Weaknesses

### 8.1 Strengths
1. **Best-in-class tool harness**: precise file tools (Read/Write/Edit/Grep/Glob) beat generic "run code" approaches for correctness; Edit's exact-match semantics reduce corruption.
2. **Permission system is the differentiator**: modes + allow/ask/deny rules + sandbox + hooks give a graduated trust model unmatched by most CLI agents. Prompt-injection-aware (env-var assignment bypass fixed, external CLAUDE.md include approval).
3. **Context engineering maturity**: auto-compaction since v0.2.47, rewind + "summarize up to here", micro-compaction, 1M context variants, CLAUDE.md hierarchy with @-imports and security gating.
4. **Deep extensibility ladder**: hooks → slash commands → skills → subagents → output styles → plugins/marketplaces → MCP → SDK. The official marketplace (203 plugins, verified) shows ecosystem scale.
5. **Session persistence & resume**: `--continue`/`--resume`, background sessions, `claude agents` multi-session manager, per-project history — agentic workflows survive restarts.
6. **Provider flexibility**: Anthropic API + Bedrock/Vertex/Foundry + any Anthropic-compatible endpoint (Ollama etc.) via env vars — no vendor lock-in at the transport layer.
7. **Headless-first design**: `-p` print mode, stream-json I/O, effort/model flags make it a programmable engine, not just a REPL.
8. **Observability**: OTEL spans with agent parenting, statusline JSON, usage tracking — enterprise-ready instrumentation.

### 8.2 Weaknesses / user complaints
1. **Token cost & context burn**: subagents/agent teams are "token-intensive" (2.1.32 changelog's own words); compaction quality is imperfect; long sessions degrade. Agent teams remain research-preview.
2. **Version churn**: 294 releases to 2.1.148 (verified changelog) — fast-moving target; changelog is dominated by fixes (rendering glitches, Windows Terminal issues, edge-case regressions like 2.1.147's exit-code-127 regression). Feature behavior shifts frequently (e.g. `/simplify` → `/code-review` rename, "extra usage" → "usage credits").
3. **Platform gaps on Windows**: sandboxing arrived on Linux/macOS first (2.0.24); many changelog entries are Windows-specific rendering/PowerShell fixes — Windows is supported but second-tier.
4. **Terminal rendering fragility**: recurring fixes for garbled output, resize events, CJK wide characters, VS Code split panes, GNOME paste (2.1.144–2.1.147) — TTY rendering is a moving target.
5. **Prompt-injection surface**: WebFetch/WebSearch + auto-approval modes + hooks create attack surface; mitigations (permission rules, trust dialog, include approval) exist but users report injection incidents **[community reports, memory]**.
6. **Permission complexity**: the rule grammar (Tool(specifier), three tiers, four scopes) is powerful but confusing; enterprise admins report configuration sprawl **[community reports, memory]**.
7. **Anthropic-model coupling**: while endpoints are swappable, behavior is tuned for Claude models; third-party models (e.g. local Ollama, per this machine's config) degrade tool-use reliability, compaction, and classifier quality **[inferred; consistent with local setup using gemma4/qwen3.6]**.
8. **Opaque internals**: system prompt is not inspectable; compaction/summarization is a black box — hard to debug context failures.
9. **Experimental surfaces**: agent teams (tmux-dependent, env-flag gated), effort levels, auto-mode classifier — all in flux; APIs/behaviors change between minor versions.
10. **Security of hooks/plugins**: hooks run arbitrary shell with full user privileges; marketplace plugins are third-party code — supply-chain risk despite `claude plugin validate`.

### 8.3 Implications for AmiClaw comparison (short)
- **Match**: tool inventory, permission rules, CLAUDE.md-style memory, subagents, hooks, MCP client, headless mode.
- **Differentiators Claude Code has**: plugin/marketplace ecosystem, agent teams, checkpoint/rewind, OTEL, managed enterprise settings, output styles, skills.
- **AmiClaw angles to check**: local-model quality under the same harness (Claude Code proves the harness works with Anthropic-compatible endpoints), permission granularity vs. complexity, session persistence model, Windows support parity.

---

## Appendix A — Verified Local Evidence Index

| Path | Evidence |
|---|---|
| `~/.claude/cache/changelog.md` (322,699 bytes) | 294 versions: `0.2.21` → `2.1.148`. Feature intro dates cited throughout. |
| `~/.claude/settings.json` | `defaultMode: bypassPermissions`, `model: claude-opus-4-7`, `effort: max`, `language: chinese`. |
| `~/.claude/backups/.claude.json.backup.1787818464723` | Global config schema incl. `projects{allowedTools, mcpServers, hasTrustDialogAccepted, hasClaudeMdExternalIncludesApproved}`, `githubRepoPaths`, `officialMarketplaceAutoInstalled`. |
| `~/.claude/cc-haha/providers.json` | `apiFormat: anthropic`, `runtimeKind: anthropic_compatible`, model tiers `main/haiku/sonnet/opus`, Ollama endpoints. |
| `~/.claude/cc-haha/settings.json` | `ANTHROPIC_BASE_URL/ANTHROPIC_MODEL/ANTHROPIC_DEFAULT_*_MODEL`, `skipWebFetchPreflight`. |
| `~/.claude/plugins/marketplaces/claude-plugins-official` | Official marketplace checkout; `marketplace.json` = 203 plugins; `external_plugins/` = 14 vendor integrations. |
| `~/.claude/{projects,sessions,file-history,history.jsonl,adapters.json}` | Session persistence, prompt history, IDE pairing (pairing code + expiry), per-session file snapshots. |
| `~/.claude/.runtime/` | Bundled Python venv + `win_helper.py` (Windows runtime support). |

## Appendix B — Method & Caveats
- **Changelog as primary source**: version numbers and feature names are quoted from the local changelog cache (installed build `2.1.148`); changelog text was sampled, not read exhaustively — some feature details in older versions are from **[memory]** of public docs and marked as such.
- **Not verified**: exact system-prompt text, internal loop implementation (JS bundle not inspected), current public pricing/quota details, and post-`2.1.148` releases.
- **Version sensitivity**: permission-mode names, effort levels, auto-mode classifier, agent teams, and skills are recent (2.1.x) and evolving; the tool inventory is stable but the MCP/skills/plugins surface changes frequently.

*Generated by Worker Agent #7 — evidence collected from local installation at `C:\Users\YCHsu\.claude`.*
