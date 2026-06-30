/**
 * TeamCallModel — Team 主管模式的 provider-agnostic 模型呼叫。
 *
 * 抽出動機（見 ClaudeToDo.md §19.5 異味 7）：
 *   _handleTeamManager 內有一個 ~90 行的 callModel local closure，內嵌
 *   copilot / ollama(無工具) / ollama(有工具) 三條呼叫路徑，是 provider 抽象的內聯版本。
 *
 * 本模組以依賴注入（TeamCallModelDeps）解除對 this / _services / _callbacks / _teamCancel 的耦合，
 * 行為與原 closure **完全一致**（含 200ms cancel 計時器、80ms think buffer、12 輪 tool loop）。
 *
 * 註：偵測仍用 `model.startsWith('copilot::')`（與原行為相同），未改用 ProviderRegistry，
 *     以避免把 openai:: 等其他前綴的路由語意一併改變。
 */
import * as vscode from 'vscode';
import { TeamHistoryEntry, TeamManagerChatMessage } from './TeamShared';

/** teamCallModel 的注入依賴（由 TeamManager 以 this / _services / _callbacks 組裝）。 */
export interface TeamCallModelDeps {
  /** Ollama base URL 候選清單。 */
  urls: string[];
  /** 是否已取消（讀 this._teamCancel）。 */
  isCancelled: () => boolean;
  decodeOllamaModel: (modelId: string, fallbackUrls: string[]) => { url: string; model: string };
  ollamaChatStream: (
    baseUrl: string,
    model: string,
    messages: TeamManagerChatMessage[],
    onResponseChunk: (chunk: string) => void,
    onThinkChunk?: (chunk: string) => void,
    onStats?: (tokens: number, tps: number) => void
  ) => Promise<string>;
  ollamaChatCallStream: (
    baseUrl: string,
    model: string,
    messages: TeamManagerChatMessage[],
    tools: unknown[],
    onThinkChunk?: (chunk: string) => void,
    onTextChunk?: (chunk: string) => void,
    onStats?: (tokens: number, tps: number) => void
  ) => Promise<TeamManagerChatMessage>;
  trackUsage: (model: string, tokens: number) => void;
  executeTool: (name: string, args: Record<string, unknown>) => Promise<string>;
}

/**
 * 呼叫單一模型並串流回覆，回傳完整文字。
 *   - `copilot::family` → vscode.lm（含 cancel 計時器）
 *   - ollama 無工具 → ollamaChatStream（think buffer 80ms flush）
 *   - ollama 有工具 → ollamaChatCallStream 最多 12 輪 tool loop（executeTool）
 */
export async function teamCallModel(
  deps: TeamCallModelDeps,
  model: string,
  persona: string,
  hist: TeamHistoryEntry[],
  userMsg: string,
  onChunk: (c: string) => void,
  onThink?: (c: string) => void,
  tools: unknown[] = []
): Promise<string> {
  if (model.startsWith('copilot::')) {
    const family = model.slice('copilot::'.length);
    const messages: vscode.LanguageModelChatMessage[] = [
      vscode.LanguageModelChatMessage.User(persona),
      ...hist.map(h => h.role === 'user'
        ? vscode.LanguageModelChatMessage.User(h.content)
        : vscode.LanguageModelChatMessage.Assistant(h.content)),
      vscode.LanguageModelChatMessage.User(userMsg)
    ];
    const cts = new vscode.CancellationTokenSource();
    const cancelTimer = setInterval(() => { if (deps.isCancelled()) { cts.cancel(); } }, 200);
    try {
      const [lm] = await vscode.lm.selectChatModels({ vendor: 'copilot', family });
      if (!lm) { throw new Error(`Copilot 模型 "${family}" 不可用`); }
      const resp = await lm.sendRequest(messages, {}, cts.token);
      let full = '';
      for await (const part of resp.stream) {
        if (deps.isCancelled()) { break; }
        if (part instanceof vscode.LanguageModelTextPart) { full += part.value; onChunk(part.value); }
      }
      return full;
    } finally { clearInterval(cancelTimer); cts.dispose(); }
  } else {
    const { url, model: mName } = deps.decodeOllamaModel(model, deps.urls);
    if (tools.length === 0) {
      let thinkBuf = '';
      let thinkTimer: ReturnType<typeof setTimeout> | null = null;
      const flushThink = () => { if (thinkBuf && onThink) { onThink(thinkBuf); thinkBuf = ''; } thinkTimer = null; };
      const messages: TeamManagerChatMessage[] = [
        { role: 'system', content: persona },
        ...hist.map(h => ({ role: h.role as 'user' | 'assistant', content: h.content })),
        { role: 'user', content: userMsg }
      ];
      const text = await deps.ollamaChatStream(url, mName, messages, onChunk,
        (tc) => { thinkBuf += tc; if (!thinkTimer) { thinkTimer = setTimeout(flushThink, 80); } },
        (tokens) => { deps.trackUsage(mName, tokens); });
      if (thinkTimer) { clearTimeout(thinkTimer); } flushThink();
      return text;
    } else {
      const messages: TeamManagerChatMessage[] = [
        { role: 'system', content: persona },
        ...hist.map(h => ({ role: h.role as 'user' | 'assistant', content: h.content })),
        { role: 'user', content: userMsg }
      ];
      let finalText = '';
      for (let _tLoop = 0; _tLoop < 12 && !deps.isCancelled(); _tLoop++) {
        const assistantMsg = await deps.ollamaChatCallStream(url, mName, messages, tools,
          (tc) => { if (onThink && !deps.isCancelled()) onThink(tc); },
          (tc) => { if (!deps.isCancelled()) { onChunk(tc); finalText += tc; } },
          (tokens) => { deps.trackUsage(mName, tokens); });
        messages.push(assistantMsg as TeamManagerChatMessage);
        if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) { break; }
        for (const tc of assistantMsg.tool_calls) {
          const fn = tc.function;
          const args = typeof fn.arguments === 'string' ? (() => { try { return JSON.parse(fn.arguments as string); } catch { return {}; } })() : fn.arguments as Record<string, unknown>;
          onChunk(`\n🔧 ${fn.name}(${JSON.stringify(args).slice(0, 80)})\n`);
          let toolResult: string;
          try { toolResult = await deps.executeTool(fn.name, args); }
          catch (e) { toolResult = `工具錯誤: ${e instanceof Error ? e.message : String(e)}`; }
          onChunk(`→ ${toolResult.slice(0, 200)}${toolResult.length > 200 ? '…' : ''}\n`);
          messages.push({ role: 'tool', content: toolResult, tool_call_id: tc.id ?? fn.name });
        }
      }
      return finalText;
    }
  }
}
