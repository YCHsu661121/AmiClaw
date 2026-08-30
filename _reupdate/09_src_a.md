# Chunk 09: src/autopilot + src/chat + src/context + src/debate
## autopilot/AutoPilotClassifier.ts

| Line | Code | Analysis |
| --- | --- | --- |
| 1 | // Copyright (c) 2026 YCHsu. All rights reserved. | Copyright header (c) 2026 YCHsu. |
| 2 | // Licensed under the MIT License. | License line: MIT License. |
| 3 | (blank) | (blank) |
| 4 | /** | JSDoc block start describing the module. |
| 5 |  * AutoPilot 分類器：呼叫 LLM 判斷某個 tool call 是否安全。 | Doc: AutoPilot classifier - calls LLM to judge whether a tool call is safe. |
| 6 |  * 對應 claude-code `yoloClassifier.ts` 的 fast-stage（單呼叫 XML 版）。 | Doc: corresponds to claude-code yoloClassifier.ts fast-stage (single-call XML version). |
| 7 |  * | (blank) |
| 8 |  * 為了不綁住 AmiClaw 既有的 Ollama / Copilot / OpenAI 多 provider 機制， | Doc: avoids binding AmiClaw to existing Ollama/Copilot/OpenAI multi-provider mechanism. |
| 9 |  * 這裡只接受抽象的 `callModel` callback。wire-in 端再從外面注入適配器。 | Doc: accepts only an abstract callModel callback; wire-in side injects adapter. |
| 10 |  */ | End JSDoc block. |
| 11 | (blank) | (blank) |
| 12 | import { buildAutoPilotSystemPrompt, formatActionForClassifier, type AutoPilotPromptRules } from './AutoPilotPrompt'; | Imports prompt builder, action formatter, and prompt rules type from AutoPilotPrompt. |
| 13 | (blank) | (blank) |
| 14 | export interface AutoPilotTranscriptMessage { | Exported interface: one transcript message. |
| 15 |   role: 'user' \| 'assistant' \| 'tool'; | Role union: user/assistant/tool. |
| 16 |   content: string; | Message content string. |
| 17 | } | End interface. |
| 18 | (blank) | (blank) |
| 19 | export interface AutoPilotCallModelOptions { | Exported interface: model call options. |
| 20 |   system: string; | System prompt string. |
| 21 |   user: string; | User prompt string. |
| 22 |   maxTokens?: number; | Optional maxTokens cap. |
| 23 |   stopSequences?: string[]; | Optional stop sequences (declared for future use). |
| 24 |   signal?: AbortSignal; | Optional AbortSignal for cancellation. |
| 25 | } | End interface. |
| 26 | (blank) | (blank) |
| 27 | export interface AutoPilotCallModelResult { | Exported interface: model call result. |
| 28 |   text: string; | Raw text result. |
| 29 |   usage?: { inputTokens: number; outputTokens: number }; | Optional token usage (input/output). |
| 30 |   durationMs?: number; | Optional duration in ms. |
| 31 | } | End interface. |
| 32 | (blank) | (blank) |
| 33 | export interface AutoPilotClassifierServices { | Exported interface: injected services (dependency injection seam). |
| 34 |   /** 呼叫一次小型 LLM，回傳純文字。由 wire-in 層適配 Ollama / Copilot / OpenAI 等 provider。 */ | Doc: callModel calls one small LLM, returns plain text; wire-in layer adapts providers. |
| 35 |   callModel: (opts: AutoPilotCallModelOptions) => Promise<AutoPilotCallModelResult>; | Required callModel function: options -> Promise of result. |
| 36 |   log?: (msg: string) => void; | Optional log callback. |
| 37 | } | End interface. |
| 38 | (blank) | (blank) |
| 39 | export interface AutoPilotClassifyArgs { | Exported interface: arguments to classifyAutoPilotAction. |
| 40 |   toolName: string; | Name of the tool call under review. |
| 41 |   toolArgs: Record<string, unknown>; | Tool call arguments map. |
| 42 |   /** 最近的對話片段（已截短），用來判斷 user intent。建議保留最後 6~10 則訊息。 */ | Doc: recent (truncated) transcript to judge user intent; suggests keeping last 6-10 messages. |
| 43 |   recentTranscript: AutoPilotTranscriptMessage[]; | Recent transcript message array. |
| 44 |   rules?: AutoPilotPromptRules; | Optional custom prompt rules. |
| 45 |   signal?: AbortSignal; | Optional AbortSignal. |
| 46 |   services: AutoPilotClassifierServices; | Injected services. |
| 47 | } | End interface. |
| 48 | (blank) | (blank) |
| 49 | export type AutoPilotClassifierVerdict = 'allow' \| 'block' \| 'unavailable'; | Verdict union type: allow | block | unavailable. |
| 50 | (blank) | (blank) |
| 51 | export interface AutoPilotClassifierResult { | Exported interface: classifier result. |
| 52 |   verdict: AutoPilotClassifierVerdict; | Verdict field. |
| 53 |   reason: string; | Human-readable reason. |
| 54 |   rawText?: string; | Optional raw model text (for audit). |
| 55 |   durationMs?: number; | Optional duration ms. |
| 56 |   usage?: { inputTokens: number; outputTokens: number }; | Optional token usage. |
| 57 | } | End interface. |
| 58 | (blank) | (blank) |
| 59 | const MAX_TRANSCRIPT_CHARS = 12_000; | Module constant: transcript rendering capped at 12000 chars. |
| 60 | (blank) | (blank) |
| 61 | function renderTranscript(msgs: AutoPilotTranscriptMessage[]): string { | Private function: render transcript messages as XML-like text. |
| 62 |   const lines: string[] = ['<transcript>']; | Initialize lines with opening <transcript> tag. |
| 63 |   let total = 0; | Running character counter. |
| 64 |   for (const m of msgs) { | Iterate over messages. |
| 65 |     const piece = `  <${m.role}>${m.content}</${m.role}>`; | Format one message as indented <role>content</role> element. |
| 66 |     if (total + piece.length > MAX_TRANSCRIPT_CHARS) { | If adding this piece would exceed the char cap... |
| 67 |       lines.push('  <truncated/>'); | ...push a <truncated/> marker... |
| 68 |       break; | ...and stop adding further messages. |
| 69 |     } | End if. |
| 70 |     lines.push(piece); | Append the message line. |
| 71 |     total += piece.length; | Accumulate character count. |
| 72 |   } | End loop. |
| 73 |   lines.push('</transcript>'); | Close </transcript> tag. |
| 74 |   return lines.join('\n'); | Join lines with newlines and return. |
| 75 | } | End function. |
| 76 | (blank) | (blank) |
| 77 | /** | JSDoc start for the output parser. |
| 78 |  * 解析 `<block>yes/no</block><reason>...</reason>`，容錯： | Doc: parses <block>yes/no</block><reason>...</reason>, fault-tolerant: |
| 79 |  * - 大小寫不敏感 | Doc: case-insensitive. |
| 80 |  * - 允許前後空白 / 換行 | Doc: allows surrounding whitespace/newlines. |
| 81 |  * - 找不到 <block> 時，視為 unavailable（safe default = block 由上層處理） | Doc: missing <block> => unavailable (safe default handled by upper layer). |
| 82 |  */ | End JSDoc. |
| 83 | function parseClassifierOutput(text: string): { verdict: AutoPilotClassifierVerdict; reason: string } { | Private function: parse raw classifier text into verdict + reason. |
| 84 |   const blockMatch = /<block>\s*(yes\|no)\s*<\/block>/i.exec(text); | Case-insensitive regex capturing <block>yes|no</block>. |
| 85 |   if (!blockMatch) { | If no <block> tag found... |
| 86 |     return { verdict: 'unavailable', reason: 'classifier returned malformed output' }; | ...return 'unavailable' with malformed-output reason. |
| 87 |   } | End if. |
| 88 |   const reasonMatch = /<reason>([\s\S]*?)<\/reason>/i.exec(text); | Lazy multiline regex capturing optional <reason>...</reason>. |
| 89 |   const reason = reasonMatch ? reasonMatch[1].trim().replace(/\s+/g, ' ') : '(no reason)'; | Reason: trimmed and whitespace-collapsed; '(no reason)' fallback. |
| 90 |   return blockMatch[1].toLowerCase() === 'yes' | Ternary: block=yes => 'block' verdict... |
| 91 |     ? { verdict: 'block', reason } | ...with the parsed reason... |
| 92 |     : { verdict: 'allow', reason }; | ...otherwise 'allow' verdict. |
| 93 | } | End function. |
| 94 | (blank) | (blank) |
| 95 | /** | JSDoc start for main classify entry point. |
| 96 |  * 呼叫分類器並回傳結果。任何 callModel 例外都會轉成 `unavailable`， | Doc: any callModel exception is converted to 'unavailable'... |
| 97 |  * 上層 policy 會自動 fallback 到人工確認，不會拋。 | Doc: upper policy auto-falls back to manual confirm; never throws. |
| 98 |  */ | End JSDoc. |
| 99 | export async function classifyAutoPilotAction(args: AutoPilotClassifyArgs): Promise<AutoPilotClassifierResult> { | Main exported async function: classify one tool action. |
| 100 |   const { toolName, toolArgs, recentTranscript, rules, signal, services } = args; | Destructure args for readability. |
| 101 |   const system = buildAutoPilotSystemPrompt(rules); | Build full system prompt from optional rules. |
| 102 |   const user = `${renderTranscript(recentTranscript)}\n\n## New action to classify\n${formatActionForClassifier(toolN... | Build user prompt: transcript + header + formatted action. |
| 103 |   const t0 = Date.now(); | Record start timestamp for duration fallback. |
| 104 |   try { | Begin try block so exceptions never propagate. |
| 105 |     const res = await services.callModel({ | Await injected model call with options... |
| 106 |       system, user, | ...system + user prompts... |
| 107 |       maxTokens: 256, | ...capped at 256 output tokens... |
| 108 |       signal, | ...forwarding the abort signal. |
| 109 |     }); | End callModel options/call. |
| 110 |     const parsed = parseClassifierOutput(res.text); | Parse raw model text into verdict + reason. |
| 111 |     return { | Return result object... |
| 112 |       verdict: parsed.verdict, | ...parsed verdict... |
| 113 |       reason: parsed.reason, | ...parsed reason... |
| 114 |       rawText: res.text, | ...raw text for audit... |
| 115 |       durationMs: res.durationMs ?? (Date.now() - t0), | ...duration: model-reported if available, else measured... |
| 116 |       usage: res.usage, | ...and token usage. |
| 117 |     }; | End return object. |
| 118 |   } catch (err) { | Catch any error from callModel. |
| 119 |     services.log?.(`[AutoPilot] classifier callModel failed: ${(err as Error)?.message ?? err}`); | Log failure via optional services.log with safe message extraction. |
| 120 |     return { | Return 'unavailable' result... |
| 121 |       verdict: 'unavailable', | ...unavailable verdict... |
| 122 |       reason: `classifier error: ${(err as Error)?.message ?? 'unknown'}`, | ...error-based reason... |
| 123 |       durationMs: Date.now() - t0, | ...and measured duration. |
| 124 |     }; | End return object. |
| 125 |   } | End catch block. |
| 126 | } | End function. |
## autopilot/AutoPilotDenials.ts

| Line | Code | Analysis |
| --- | --- | --- |
| 1 | // Copyright (c) 2026 YCHsu. All rights reserved. | Copyright header (c) 2026 YCHsu. |
| 2 | // Licensed under the MIT License. | License line: MIT License. |
| 3 | (blank) | (blank) |
| 4 | /** | JSDoc block start for the module. |
| 5 |  * AutoPilot 拒絕追蹤：當 classifier 連續拒絕太多次（或一輪總拒絕太多次） | Doc: AutoPilot denial tracking - fallback to manual confirm when the classifier denies too often... |
| 6 |  * 就 fallback 到人工確認，避免 agent 陷入「auto-deny 死循環」。 | Doc: ...to avoid an agent 'auto-deny dead-loop'. |
| 7 |  * | (blank) |
| 8 |  * 對應 claude-code `autoModeDenials.ts` + `denialTracking.ts`。 | Doc: corresponds to claude-code autoModeDenials.ts + denialTracking.ts. |
| 9 |  * 採用模組層級狀態（單一 chat session 共用），對齊 AutoPilotState.ts。 | Doc: uses module-level state (shared by one chat session), consistent with AutoPilotState.ts. |
| 10 |  */ | End JSDoc block. |
| 11 | (blank) | (blank) |
| 12 | export interface AutoPilotDenial { | Exported interface: a single denial record. |
| 13 |   toolName: string; | Tool name that was denied. |
| 14 |   display: string;       // 人類可讀描述（例如 "rm -rf /data"） | display: human-readable description (e.g. 'rm -rf /data'). |
| 15 |   reason: string;        // classifier 給的拒絕原因 | reason: classifier's denial reason. |
| 16 |   timestamp: number;     // Date.now() | timestamp: Date.now() value. |
| 17 | } | End interface. |
| 18 | (blank) | (blank) |
| 19 | const RING_MAX = 20; | Module constant: ring buffer max size (20 denials kept). |
| 20 | const _denials: AutoPilotDenial[] = []; | Module-level ring buffer of denials. |
| 21 | (blank) | (blank) |
| 22 | let _consecutiveDenials = 0; | Module-level counter: consecutive denials since last success. |
| 23 | let _totalDenials = 0; | Module-level counter: total denials this session. |
| 24 | (blank) | (blank) |
| 25 | export const AUTOPILOT_DENIAL_LIMITS = { | Exported constant object of denial thresholds (frozen via as const). |
| 26 |   /** 連續拒絕達到此數時，回退到人工確認模式（不再走 classifier）。 */ | Doc: consecutive denials reaching this => fallback to manual confirm. |
| 27 |   CONSECUTIVE_THRESHOLD: 3, | CONSECUTIVE_THRESHOLD = 3. |
| 28 |   /** 整個 session 累積拒絕達到此數時，建議 UI 提示使用者檢視規則。 */ | Doc: session-total denials reaching this => suggest UI hint to review rules. |
| 29 |   TOTAL_THRESHOLD: 10, | TOTAL_THRESHOLD = 10. |
| 30 | } as const; | as const to freeze the object. |
| 31 | (blank) | (blank) |
| 32 | export function recordAutoPilotDenial(denial: AutoPilotDenial): void { | Exported function: record one denial. |
| 33 |   _denials.push(denial); | Push denial onto the ring buffer. |
| 34 |   if (_denials.length > RING_MAX) { _denials.shift(); } | Evict oldest entry when buffer exceeds RING_MAX. |
| 35 |   _consecutiveDenials += 1; | Increment consecutive counter. |
| 36 |   _totalDenials += 1; | Increment total counter. |
| 37 | } | End function. |
| 38 | (blank) | (blank) |
| 39 | /** 任何成功通過 classifier 或人工允許的 tool 執行後呼叫，重置連續拒絕計數。 */ | Doc: call after any tool execution that passes classifier or manual allow, to reset consecutive count. |
| 40 | export function recordAutoPilotSuccess(): void { | Exported function: reset consecutive denial counter. |
| 41 |   _consecutiveDenials = 0; | Reset to zero. |
| 42 | } | End function. |
| 43 | (blank) | (blank) |
| 44 | export function getAutoPilotDenials(): ReadonlyArray<AutoPilotDenial> { | Exported function: read-only access to the denial ring buffer. |
| 45 |   return _denials; | Return the denials array (read-only view). |
| 46 | } | End function. |
| 47 | (blank) | (blank) |
| 48 | export function getAutoPilotConsecutiveDenials(): number { | Exported function: get current consecutive denial count. |
| 49 |   return _consecutiveDenials; | Return the counter. |
| 50 | } | End function. |
| 51 | (blank) | (blank) |
| 52 | export function getAutoPilotTotalDenials(): number { | Exported function: get session-total denial count. |
| 53 |   return _totalDenials; | Return the counter. |
| 54 | } | End function. |
| 55 | (blank) | (blank) |
| 56 | /** 連續拒絕已達上限：呼叫端應退回人工確認流程，而不是繼續 auto-deny。 */ | Doc: consecutive denials hit the limit; caller should revert to manual confirm instead of continuing auto-deny. |
| 57 | export function shouldAutoPilotFallbackToAsk(): boolean { | Exported function: should AutoPilot fall back to asking? |
| 58 |   return _consecutiveDenials >= AUTOPILOT_DENIAL_LIMITS.CONSECUTIVE_THRESHOLD; | Return true when consecutive denials >= threshold. |
| 59 | } | End function. |
| 60 | (blank) | (blank) |
| 61 | /** 整個 session 拒絕次數已多，建議 UI 顯示「請檢視自動允許規則」提示。 */ | Doc: session denials numerous; suggest UI show 'please review auto-allow rules' hint. |
| 62 | export function shouldSuggestAutoPilotRulesReview(): boolean { | Exported function: should suggest a rules review? |
| 63 |   return _totalDenials >= AUTOPILOT_DENIAL_LIMITS.TOTAL_THRESHOLD; | Return true when total denials >= threshold. |
| 64 | } | End function. |
| 65 | (blank) | (blank) |
| 66 | export function _resetAutoPilotDenialsForTesting(): void { | Exported test helper: clear all module-level state. |
| 67 |   _denials.length = 0; | Empty the denial ring buffer. |
| 68 |   _consecutiveDenials = 0; | Reset consecutive counter. |
| 69 |   _totalDenials = 0; | Reset total counter. |
| 70 | } | End function. |
## autopilot/AutoPilotPolicy.ts

| Line | Code | Analysis |
| --- | --- | --- |
| 1 | // Copyright (c) 2026 YCHsu. All rights reserved. | Copyright header (c) 2026 YCHsu. |
| 2 | // Licensed under the MIT License. | License line: MIT License. |
| 3 | (blank) | (blank) |
| 4 | /** | JSDoc block start for the module. |
| 5 |  * AutoPilot 決策樞紐：對單一 tool call 做出 allow / deny / fallback 的最終判斷。 | Doc: AutoPilot decision hub - makes the final allow/deny/fallback judgment for one tool call. |
| 6 |  * | (blank) |
| 7 |  * 呼叫順序（短路求值）： | Doc: invocation order (short-circuit evaluation): |
| 8 |  *   1. 未啟用 → pass-through，交回原始確認流程 | Doc: 1. not enabled -> pass-through to original confirm flow. |
| 9 |  *   2. circuit broken → fallback-ask | Doc: 2. circuit broken -> fallback-ask. |
| 10 |  *   3. 連續拒絕已達上限 → fallback-ask（避免 auto-deny 卡住 agent） | Doc: 3. consecutive denials hit limit -> fallback-ask (avoid agent stuck). |
| 11 |  *   4. 在 safe allowlist → allow（不浪費 LLM 呼叫） | Doc: 4. in safe allowlist -> allow (no LLM call wasted). |
| 12 |  *   5. 呼叫 classifier | Doc: 5. call classifier. |
| 13 |  *      - unavailable → fallback-ask | Doc:    - unavailable -> fallback-ask. |
| 14 |  *      - allow → 記 success、回 allow | Doc:    - allow -> record success, return allow. |
| 15 |  *      - block → 記 denial、回 deny | Doc:    - block -> record denial, return deny. |
| 16 |  * | (blank) |
| 17 |  * 本檔案不直接寫檔、不彈視窗。所有 IO（UI 提示、規則持久化）由呼叫端處理。 | Doc: this file does no file writes or UI popups; all IO handled by callers. |
| 18 |  */ | End JSDoc block. |
| 19 | (blank) | (blank) |
| 20 | import { | Import block start from AutoPilotState. |
| 21 |   isAutoPilotActive, isAutoPilotCircuitBroken, | Import active/circuit-broken state getters. |
| 22 | } from './AutoPilotState'; | End import statement. |
| 23 | import { isSafeAutoPilotTool } from './safeAllowlist'; | Import safe-allowlist checker. |
| 24 | import { | Import block start from AutoPilotDenials. |
| 25 |   recordAutoPilotDenial, recordAutoPilotSuccess, shouldAutoPilotFallbackToAsk, | Import denial recording + fallback predicate. |
| 26 | } from './AutoPilotDenials'; | End import statement. |
| 27 | import { | Import block start from AutoPilotClassifier. |
| 28 |   classifyAutoPilotAction, | Import classify function. |
| 29 |   type AutoPilotClassifierResult, | Import classifier result type. |
| 30 |   type AutoPilotClassifierServices, | Import classifier services type. |
| 31 |   type AutoPilotTranscriptMessage, | Import transcript message type. |
| 32 | } from './AutoPilotClassifier'; | End import statement. |
| 33 | import type { AutoPilotPromptRules } from './AutoPilotPrompt'; | Import prompt rules type from AutoPilotPrompt. |
| 34 | import * as path from 'path'; | Import Node path module. |
| 35 | (blank) | (blank) |
| 36 | // 會寫入檔案的工具集合 | Comment: set of tools that write files. |
| 37 | const WRITE_TOOLS = new Set([ | WRITE_TOOLS: Set of tool names that perform file writes... |
| 38 |   'write_file', 'replace_in_file', 'insert_in_file', 'replace_all_in_file', | ...write/replace/insert/batch tools... |
| 39 |   'batch_replace', 'rename_file', 'copy_file', 'todo_write', 'memory_write', 'delete_file', | ...rename/copy/todo/memory/delete operations. |
| 40 | ]); | End Set literal. |
| 41 | (blank) | (blank) |
| 42 | // 高風險指令 pattern（run_command 用） | Comment: high-risk command patterns (for run_command). |
| 43 | const HIGH_RISK_CMD = [ | HIGH_RISK_CMD: list of dangerous command regexes. |
| 44 |   /rm\s+-[rRf]+[rRf]+/i,       // rm -rf | rm -rf (recursive+force), case-insensitive. |
| 45 |   /Remove-Item.*-Recurse.*-Force/i, | PowerShell Remove-Item -Recurse -Force. |
| 46 |   /\\|\s*bash/i,                 // curl\|bash | curl|bash pipe-to-bash pattern. |
| 47 |   /iwr[^\|]*\\|\s*iex/i,          // iwr \| iex | iwr | iex (Invoke-WebRequest piped to Invoke-Expression). |
| 48 |   /\bsudo\b/, /\brunas\b/, | sudo / runas privilege escalation. |
| 49 |   /\bnpx\s+--yes\b/i, | npx --yes auto-accept installs. |
| 50 |   /\bgit\s+push.*--force\b/i, | git push with --force. |
| 51 | ]; | End array. |
| 52 | (blank) | (blank) |
| 53 | // 高風險路徑 (shell RC / 排程) | Comment: high-risk paths (shell RC files / scheduling). |
| 54 | const HIGH_RISK_PATHS = [ | HIGH_RISK_PATHS: list of sensitive path fragments. |
| 55 |   '.bashrc', '.zshrc', '.profile', 'Profile.ps1', '.bash_profile', | bashrc/zshrc/profile/bash_profile shell RC files. |
| 56 |   'crontab', '.crontab', 'systemd', 'launchd', 'authorized_keys', | crontab/.crontab/systemd/launchd scheduling + authorized_keys. |
| 57 | ]; | End array. |
| 58 | (blank) | (blank) |
| 59 | /** | JSDoc start for shadowRuleCheck. |
| 60 |  * 影子規則檢查：不呼叫 LLM，純規則判斷是否自動放行。 | Doc: shadow rule check - no LLM call, pure rule-based auto-allow. |
| 61 |  * only ask when: 會寫 workspace 外 OR 高風險操作 | Doc: only ask when: writes outside workspace OR high-risk operation. |
| 62 |  */ | End JSDoc. |
| 63 | export function shadowRuleCheck( | Exported function: shadow rule check (returns allow/ask). |
| 64 |   toolName: string, | Parameter: tool name. |
| 65 |   toolArgs: Record<string, unknown>, | Parameter: tool arguments. |
| 66 |   workspaceFolders: string[], | Parameter: workspace folder roots. |
| 67 | ): 'allow' \| 'ask' { | End parameter list. |
| 68 |   // 純讀工具直接放行 | Comment: pure-read tools are allowed directly. |
| 69 |   if (isSafeAutoPilotTool(toolName)) return 'allow'; | If tool is in the safe allowlist, allow it. |
| 70 | (blank) | (blank) |
| 71 |   // run_command: 檢查高風險 pattern | Comment: run_command - check high-risk patterns. |
| 72 |   if (toolName === 'run_command' \|\| toolName === 'run_terminal') { | If tool is run_command or run_terminal. |
| 73 |     const cmd = String(toolArgs.command ?? ''); | Extract the command string (default empty). |
| 74 |     if (HIGH_RISK_CMD.some(re => re.test(cmd))) return 'ask'; | If any high-risk pattern matches, ask. |
| 75 |     return 'allow'; | Otherwise allow. |
| 76 |   } | End if-block. |
| 77 | (blank) | (blank) |
| 78 |   // 寫入模型工具：檢查路徑 | Comment: write-capable tools - check path. |
| 79 |   if (WRITE_TOOLS.has(toolName)) { | If tool is a file-writing tool. |
| 80 |     const filePath = String(toolArgs.path ?? toolArgs.file ?? ''); | Extract target path from args (path or file), default empty. |
| 81 |     if (filePath) { | If a path was provided. |
| 82 |       // 高風險路徑（shell RC 等） | Comment: high-risk paths (shell RC etc). |
| 83 |       const base = path.basename(filePath); | Get basename of the file path. |
| 84 |       if (HIGH_RISK_PATHS.some(h => base === h \|\| filePath.includes(h))) return 'ask'; | If basename matches or path contains a high-risk fragment, ask. |
| 85 |       // workspace 外寫入 | Comment: write outside workspace. |
| 86 |       if (workspaceFolders.length > 0) { | If workspace folders were provided. |
| 87 |         const normalised = path.resolve(filePath).replace(/\\/g, '/'); | Normalize the file path to an absolute, slash-separated form. |
| 88 |         const inside = workspaceFolders.some(ws => normalised.startsWith(path.resolve(ws).replace(/\\/g, '/'))); | Check whether the normalized path is inside any workspace folder. |
| 89 |         if (!inside) return 'ask'; | If outside all workspaces, ask. |
| 90 |       } | End workspace check. |
| 91 |     } | End if-block. |
| 92 |     return 'allow'; | End if-block. |
| 93 |   } | Return allow for write tools with acceptable paths. |
| 94 | (blank) | (blank) |
| 95 |   // 其他工具（包含 run_python, git_commit, lint_fix, manage_todo 等）一律放行 | Comment: other tools (run_python, git_commit, lint_fix, manage_todo, etc.) all pass through. |
| 96 |   return 'allow'; | Default: allow. |
| 97 | } | End function. |
| 98 | (blank) | (blank) |
| 99 | export type AutoPilotDecision = | Exported decision union type. |
| 100 |   \| { kind: 'pass-through' } | Variant: pass-through (no AutoPilot involvement). |
| 101 |   \| { kind: 'allow'; reason: string; source: 'safe-allowlist' \| 'classifier'; classifier?: AutoPilotClassifierResult } | Variant: allow, with reason, source, and optional classifier result. |
| 102 |   \| { kind: 'deny'; reason: string; classifier?: AutoPilotClassifierResult } | Variant: deny, with reason and optional classifier result. |
| 103 |   \| { kind: 'fallback-ask'; reason: string }; | Variant: fallback-ask, with reason. |
| 104 | (blank) | (blank) |
| 105 | export interface AutoPilotDecideArgs { | Exported interface: arguments to decideAutoPilotAction. |
| 106 |   toolName: string; | Tool name. |
| 107 |   toolArgs: Record<string, unknown>; | Tool arguments map. |
| 108 |   /** 人類可讀的 tool call 摘要（如 "rm -rf D:\\old"），記錄到 denial log 用。 */ | Doc: human-readable summary of the tool call, for the denial log. |
| 109 |   toolDisplay: string; | Human-readable display string. |
| 110 |   recentTranscript: AutoPilotTranscriptMessage[]; | Recent transcript for classifier. |
| 111 |   rules?: AutoPilotPromptRules; | Optional custom rules. |
| 112 |   workspaceFolders?: string[]; | Optional workspace folders. |
| 113 |   services: AutoPilotClassifierServices; | Injected services. |
| 114 |   signal?: AbortSignal; | Optional AbortSignal. |
| 115 | } | End interface. |
| 116 | (blank) | (blank) |
| 117 | export async function decideAutoPilotAction(args: AutoPilotDecideArgs): Promise<AutoPilotDecision> { | Main exported async function: decide AutoPilot action. |
| 118 |   // 1. 未啟用：把決策權還給原本的 ToolPolicies.requestPermission | Comment: 1. Not enabled - return decision authority to ToolPolicies.requestPermission. |
| 119 |   if (!isAutoPilotActive()) { | If AutoPilot is not active... |
| 120 |     return { kind: 'pass-through' }; | ...return pass-through decision. |
| 121 |   } | End if. |
| 122 | (blank) | (blank) |
| 123 |   // 2. circuit broken：例如分類器連續多次拋例外被熔斷，後續一律 fallback | Comment: 2. Circuit broken - e.g. classifier threw repeatedly and was tripped; always fallback. |
| 124 |   if (isAutoPilotCircuitBroken()) { | If circuit breaker is open... |
| 125 |     return { kind: 'fallback-ask', reason: 'AutoPilot circuit breaker is open' }; | ...return fallback-ask with circuit-breaker reason. |
| 126 |   } | End if. |
| 127 | (blank) | (blank) |
| 128 |   // 3. 連續拒絕太多次：可能規則設定有問題或 LLM 過度保守，回到人工流程 | Comment: 3. Too many consecutive denials - rules may be wrong or LLM overly conservative; back to manual. |
| 129 |   if (shouldAutoPilotFallbackToAsk()) { | If fallback-to-ask threshold reached... |
| 130 |     return { kind: 'fallback-ask', reason: 'AutoPilot has denied too many consecutive actions; falling back to manual... | ...return fallback-ask with explanatory reason. |
| 131 |   } | End if. |
| 132 | (blank) | (blank) |
| 133 |   // 4. safe allowlist：純讀類 tool 直接放行，省一次 LLM 呼叫 | Comment: 4. Safe allowlist - pure-read tools pass through, saving an LLM call. |
| 134 |   if (isSafeAutoPilotTool(args.toolName)) { | If tool is in safe allowlist... |
| 135 |     recordAutoPilotSuccess(); | ...record success (reset consecutive counter)... |
| 136 |     return { kind: 'allow', reason: 'safe-tool allowlist', source: 'safe-allowlist' }; | ...and return allow from safe-allowlist. |
| 137 |   } | End if. |
| 138 | (blank) | (blank) |
| 139 |   // 5. 影子規則檢查（不呼叫 LLM，繪過大多數情況） | Comment: 5. Shadow rule check (no LLM call; covers most cases). |
| 140 |   const shadowVerdict = shadowRuleCheck(args.toolName, args.toolArgs, args.workspaceFolders ?? []); | Run shadowRuleCheck with tool + args + workspace folders. |
| 141 |   if (shadowVerdict === 'allow') { | If shadow verdict is allow... |
| 142 |     recordAutoPilotSuccess(); | ...record success... |
| 143 |     return { kind: 'allow', reason: 'shadow-rules: within workspace, non-high-risk', source: 'safe-allowlist' }; | ...and return allow tagged safe-allowlist. |
| 144 |   } | End if. |
| 145 |   if (shadowVerdict === 'ask') { | If shadow verdict is ask... |
| 146 |     return { kind: 'fallback-ask', reason: 'shadow-rules: high-risk action or write outside workspace' }; | ...return fallback-ask for high-risk / outside-workspace writes. |
| 147 |   } | End if. |
| 148 | (blank) | (blank) |
| 149 |   // 6. 剩餘邊界情況才和叫 LLM classifier | Comment: 6. Remaining edge cases: call the LLM classifier. |
| 150 |   const classifier = await classifyAutoPilotAction({ | Await classifier result... |
| 151 |     toolName: args.toolName, | ...with tool name... |
| 152 |     toolArgs: args.toolArgs, | ...and tool args... |
| 153 |     recentTranscript: args.recentTranscript, | ...plus recent transcript... |
| 154 |     rules: args.rules, | ...plus rules... |
| 155 |     signal: args.signal, | ...plus signal... |
| 156 |     services: args.services, | ...plus services. |
| 157 |   }); | End call. |
| 158 | (blank) | (blank) |
| 159 |   switch (classifier.verdict) { | Switch on classifier verdict. |
| 160 |     case 'unavailable': | Case unavailable: |
| 161 |       return { kind: 'fallback-ask', reason: classifier.reason }; | Return fallback-ask with classifier reason. |
| 162 | (blank) | (blank) |
| 163 |     case 'allow': | Case allow: |
| 164 |       recordAutoPilotSuccess(); | Record success. |
| 165 |       return { kind: 'allow', reason: classifier.reason, source: 'classifier', classifier }; | Return allow from classifier. |
| 166 | (blank) | (blank) |
| 167 |     case 'block': | Case block: |
| 168 |       recordAutoPilotDenial({ | Record the denial... |
| 169 |         toolName: args.toolName, | ...with tool name... |
| 170 |         display: args.toolDisplay, | ...display string... |
| 171 |         reason: classifier.reason, | ...reason... |
| 172 |         timestamp: Date.now(), | ...and current timestamp. |
| 173 |       }); | End record. |
| 174 |       return { kind: 'deny', reason: classifier.reason, classifier }; | Return deny decision. |
| 175 |   } | End switch. |
| 176 | } | End function. |
