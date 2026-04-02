import * as vscode from 'vscode';
import { URL } from 'url';

interface DebateChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  thinking?: string;
  tool_calls?: Array<{ id?: string; function: { name: string; arguments: Record<string, unknown> | string } }>;
  tool_call_id?: string;
  images?: string[];
}

type DebateHistoryEntry = { role: 'user' | 'assistant'; content: string };

export interface DebateEngineCallbacks {
  getWebview: () => vscode.Webview;
  getChatHistory: () => DebateChatMessage[];
  setChatHistory: (history: DebateChatMessage[]) => void;
  getChatHistories: () => Record<string, DebateChatMessage[]>;
  getActiveSessionId: () => string;
  ensureModelReady: (baseUrl: string, model: string) => Promise<void>;
}

export interface DebateEngineServices {
  getOllamaUrls: (cfg: vscode.WorkspaceConfiguration) => string[];
  decodeOllamaModel: (modelId: string, fallbackUrls: string[]) => { url: string; model: string };
  ollamaChatStream: (
    baseUrl: string,
    model: string,
    messages: DebateChatMessage[],
    onResponseChunk: (chunk: string) => void,
    onThinkChunk?: (chunk: string) => void,
    onStats?: (tokens: number, tps: number) => void
  ) => Promise<string>;
}

export class DebateEngine {
  private _teamCancel = false;
  private _debateSwap: { A?: string; B?: string; J?: string } = {};

  constructor(
    private readonly _callbacks: DebateEngineCallbacks,
    private readonly _services: DebateEngineServices
  ) {}

  public cancel(): void {
    this._teamCancel = true;
  }

  public swapModel(speaker: 'A' | 'B' | 'J', modelId: string): void {
    this._debateSwap[speaker] = modelId;
  }

  private get _panel(): { webview: vscode.Webview } {
    return { webview: this._callbacks.getWebview() };
  }

  private get _chatHistory(): DebateChatMessage[] {
    return this._callbacks.getChatHistory();
  }

  private set _chatHistory(history: DebateChatMessage[]) {
    this._callbacks.setChatHistory(history);
  }

  private get _chatHistories(): Record<string, DebateChatMessage[]> {
    return this._callbacks.getChatHistories();
  }

  private get _activeSessionId(): string {
    return this._callbacks.getActiveSessionId();
  }

  public async handleDebateSend(prompt: string, selectedModels?: string[], rounds?: string | number): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('amiAiClaw');
    const urls = this._services.getOllamaUrls(cfg);
    const allModels = (selectedModels && selectedModels.length >= 2) ? selectedModels.slice(0, 3) : [];
    if (allModels.length < 2) {
      this._panel.webview.postMessage({ type: 'error', text: '對話模式需要選擇至少 2 個 AI 模型' });
      return;
    }
    const COLORS = ['#4fc1ff', '#ce9178', '#89d185'];
    this._teamCancel = false;
    this._debateSwap = {};
    const roundsSelected = rounds ?? '20';
    const maxRounds = String(roundsSelected) === 'infinite' ? Infinity : Number(roundsSelected) || 20;
    this._chatHistory.push({ role: 'user', content: prompt });
    this._chatHistories[this._activeSessionId] = this._chatHistory;
    this._panel.webview.postMessage({ type: 'historyCount', count: this._chatHistory.length, sessionId: this._activeSessionId });

    const getLabel = (m: string) => {
      if (m.startsWith('copilot/')) return m.slice('copilot/'.length);
      if (m.startsWith('copilot::')) return m.slice('copilot::'.length);
      if (m.includes('||')) { const { url, model } = this._services.decodeOllamaModel(m, urls); try { const u = new URL(url); return `[${u.hostname}:${u.port||'11434'}] ${model}`; } catch { return model; } }
      return m;
    };

    const modelA = allModels[0];
    const modelB = allModels[1];
    const judgeModel = allModels[2] ?? null;

    const labelA = getLabel(modelA);
    const labelB = getLabel(modelB);
    const labelJ = judgeModel ? getLabel(judgeModel) : null;

    const callModel = async (
      model: string,
      systemPrompt: string,
      history: DebateHistoryEntry[],
      onChunk: (c: string) => void,
      onThink?: (c: string) => void
    ): Promise<{ text: string; tokens?: number; tps?: number }> => {
      if (model.startsWith('copilot/') || model.startsWith('copilot::')) {
        const family = model.startsWith('copilot/') ? model.slice('copilot/'.length) : model.slice('copilot::'.length);
        const [lm] = await vscode.lm.selectChatModels({ vendor: 'copilot', family });
        if (!lm) { throw new Error(`Copilot 模型 "${family}" 不可用`); }
        const cts = new vscode.CancellationTokenSource();
        const cancelInterval = setInterval(() => { if (this._teamCancel) cts.cancel(); }, 200);
        const vmMsgs: vscode.LanguageModelChatMessage[] = [
          vscode.LanguageModelChatMessage.User(systemPrompt),
          ...history.map(h => h.role === 'user'
            ? vscode.LanguageModelChatMessage.User(h.content)
            : vscode.LanguageModelChatMessage.Assistant(h.content))
        ];
        try {
          const resp = await lm.sendRequest(vmMsgs, {}, cts.token);
          let full = '';
          for await (const part of resp.stream) {
            if (this._teamCancel) break;
            if (part instanceof vscode.LanguageModelTextPart) { full += part.value; onChunk(part.value); }
          }
          return { text: full };
        } finally { clearInterval(cancelInterval); cts.dispose(); }
      } else {
        await this._callbacks.ensureModelReady(...((): [string, string] => { const d = this._services.decodeOllamaModel(model, urls); return [d.url, d.model]; })());
        const { url: ollamaUrl, model: ollamaModel } = this._services.decodeOllamaModel(model, urls);
        const messages: DebateChatMessage[] = [
          { role: 'system', content: systemPrompt },
          ...history.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))
        ];
        if (messages[messages.length - 1].role !== 'user') {
          messages.push({ role: 'user', content: '請繼續。' });
        }
        let statsTokens: number | undefined;
        let statsTps: number | undefined;
        const text = await this._services.ollamaChatStream(ollamaUrl, ollamaModel, messages, onChunk, onThink,
          (tokens, tps) => { statsTokens = tokens; statsTps = tps; });
        return { text, tokens: statsTokens, tps: statsTps };
      }
    };

    const isGame = /五子棋|圍棋|象棋|將棋|西洋棋|chess|go\b|tic.tac|gomoku|shogi|遊戲|下棋|黑白棋|othello|reversi|跳棋|checkers|draughts|橋牌/i.test(prompt);
    const gameType = /黑白棋|othello|reversi/i.test(prompt) ? 'othello'
      : /跳棋|checkers|draughts/i.test(prompt) ? 'checkers'
      : /橋牌/i.test(prompt) ? 'bridge'
      : /五子棋|gomoku/i.test(prompt) ? 'gomoku'
      : /圍棋/i.test(prompt) ? 'go'
      : /象棋|xiangqi/i.test(prompt) ? 'xiangqi'
      : /將棋|shogi/i.test(prompt) ? 'shogi'
      : /西洋棋/i.test(prompt) ? 'chess'
      : 'generic';

    if (isGame) {
      this._panel.webview.postMessage({ type: 'debateStart', labelA, labelB, labelJ, colorA: COLORS[0], colorB: COLORS[1], colorJ: COLORS[2], gameType });
      const _boardInstr = gameType !== 'bridge' ? ` 每次落子後，請在回應末尾用 [BOARD] 和 [/BOARD] 標記輸出完整 ASCII 棋盤，格式：[BOARD]\n棋盤內容\n[/BOARD]。` : '';
      const _gA: Record<string, string> = { gomoku: '五子棋棋手（●黑方）', othello: '黑白棋棋手（●黑方），8x8棋盤，指定落子座標如 d3', checkers: '跳棋棋手（紅方），指定移動如 c3→d4', bridge: `橋牌玩家（${labelA}）`, go: '圍棋棋手（●黑方），指定落子座標', xiangqi: '象棋紅方，用標準記譜法如：馬2進3', chess: '西洋棋白方，用代數記法如：e2-e4', shogi: '将棋先手番、標準記法使用' };
      const _gB: Record<string, string> = { gomoku: '五子棋棋手（○白方）', othello: '黑白棋棋手（○白方），8x8棋盤，指定落子座標如 d3', checkers: '跳棋棋手（黑方），指定移動如 c3→d4', bridge: `橋牌玩家（${labelB}）`, go: '圍棋棋手（○白方），指定落子座標', xiangqi: '象棋黑方，用標準記譜法', chess: '西洋棋黑方，用代數記法如：e7-e5', shogi: '将棋後手番、標準記法使用' };
      const gameSystemA = `你是${_gA[gameType] ?? '棋手，正在進行棋局'}。每次只說明你這一步的落子位置和簡短理由，不要發表其他評論。${_boardInstr}`;
      const gameSystemB = `你是${_gB[gameType] ?? '棋手，正在進行棋局'}。根據對手的上一步，回應你的落子位置和簡短理由，不要發表其他評論。${_boardInstr}`;
      const initPrompt = prompt;
      const historyA: DebateHistoryEntry[] = [{ role: 'user', content: initPrompt + '\n\n請下第一手。' }];
      const gameMoves: string[] = [];
      const MAX_GAME_ROUNDS = maxRounds;
      let finalDebateSummary = '';

      for (let round = 0; round < MAX_GAME_ROUNDS && !this._teamCancel; round++) {
        this._panel.webview.postMessage({ type: 'debateTurnStart', speaker: 'A', round });
        let moveA = '';
        let statsA: { tokens?: number; tps?: number } = {};
        try {
          const rA = await callModel(this._debateSwap.A ?? modelA, gameSystemA, historyA,
            (c) => { if (!this._teamCancel) this._panel.webview.postMessage({ type: 'debateChunk', speaker: 'A', chunk: c }); },
            (t) => { if (!this._teamCancel) this._panel.webview.postMessage({ type: 'debateThinkChunk', speaker: 'A', chunk: t }); });
          moveA = rA.text; statsA = { tokens: rA.tokens, tps: rA.tps };
        } catch (e) {
          moveA = '[錯誤: ' + (e instanceof Error ? e.message : String(e)) + ']';
          if (!this._teamCancel) this._panel.webview.postMessage({ type: 'debateChunk', speaker: 'A', chunk: moveA });
        }
        this._panel.webview.postMessage({ type: 'debateTurnEnd', speaker: 'A', tokens: statsA.tokens, tps: statsA.tps });
        if (this._teamCancel) break;
        historyA.push({ role: 'assistant', content: moveA });
        gameMoves.push(`第 ${round + 1} 手（${labelA}）：${moveA}`);

        this._panel.webview.postMessage({ type: 'debateTurnStart', speaker: 'B', round });
        let moveB = '';
        let statsB: { tokens?: number; tps?: number } = {};
        const boardState = initPrompt + '\n\n目前棋譜：\n' + gameMoves.join('\n') + '\n\n請回應你的下一手。';
        try {
          const rB = await callModel(this._debateSwap.B ?? modelB, gameSystemB, [{ role: 'user', content: boardState }],
            (c) => { if (!this._teamCancel) this._panel.webview.postMessage({ type: 'debateChunk', speaker: 'B', chunk: c }); },
            (t) => { if (!this._teamCancel) this._panel.webview.postMessage({ type: 'debateThinkChunk', speaker: 'B', chunk: t }); });
          moveB = rB.text; statsB = { tokens: rB.tokens, tps: rB.tps };
        } catch (e) {
          moveB = '[錯誤: ' + (e instanceof Error ? e.message : String(e)) + ']';
          if (!this._teamCancel) this._panel.webview.postMessage({ type: 'debateChunk', speaker: 'B', chunk: moveB });
        }
        this._panel.webview.postMessage({ type: 'debateTurnEnd', speaker: 'B', tokens: statsB.tokens, tps: statsB.tps });
        if (this._teamCancel) break;
        gameMoves.push(`第 ${round + 1} 手（${labelB}）：${moveB}`);
        historyA.push({ role: 'user', content: `對手（${labelB}）下了：${moveB}\n請回應你的下一手。` });
      }

      const _effectiveJudgeGame = this._debateSwap.J ?? judgeModel;
      if (_effectiveJudgeGame && !this._teamCancel) {
        this._panel.webview.postMessage({ type: 'debateTurnStart', speaker: 'J', round: -1 });
        const gameSummary = initPrompt + '\n\n完整棋譜：\n' + gameMoves.join('\n') + '\n\n請分析這場對局，說明雙方的策略與得失。';
        let statsJ: { tokens?: number; tps?: number } = {};
        try {
          const rJ = await callModel(_effectiveJudgeGame, '你是棋局分析師，請客觀分析以下對局。', [{ role: 'user', content: gameSummary }],
            (c) => { if (!this._teamCancel) this._panel.webview.postMessage({ type: 'debateChunk', speaker: 'J', chunk: c }); });
          statsJ = { tokens: rJ.tokens, tps: rJ.tps };
          finalDebateSummary = rJ.text || '';
        } catch (e) {
          const errJ = '[錯誤: ' + (e instanceof Error ? e.message : String(e)) + ']';
          if (!this._teamCancel) this._panel.webview.postMessage({ type: 'debateChunk', speaker: 'J', chunk: errJ });
        }
        this._panel.webview.postMessage({ type: 'debateTurnEnd', speaker: 'J', tokens: statsJ.tokens, tps: statsJ.tps });
      }

      if (finalDebateSummary && finalDebateSummary.trim()) {
        this._chatHistory.push({ role: 'assistant', content: finalDebateSummary });
      } else if (gameMoves.length) {
        this._chatHistory.push({ role: 'assistant', content: gameMoves.join('\n') });
      }
      this._chatHistories[this._activeSessionId] = this._chatHistory;
      this._panel.webview.postMessage({ type: 'historyCount', count: this._chatHistory.length, sessionId: this._activeSessionId });

      this._panel.webview.postMessage({ type: 'debateEnd', consensus: false });
      this._panel.webview.postMessage({ type: 'agentStatus', running: false });
      return;
    }

    const roleADesc = '請針對以下議題提出你的分析與見解：\n\n' + prompt;
    const roleBDesc = '請針對以下議題提出你的分析與見解：\n\n' + prompt;
    const roleJDesc = '請整合以下多份針對同一議題的分析，做出客觀的綜合總結：';

    this._panel.webview.postMessage({ type: 'debateStart', labelA, labelB, labelJ, colorA: COLORS[0], colorB: COLORS[1], colorJ: COLORS[2], gameType: 'discussion' });

    const historyA: DebateHistoryEntry[] = [];
    const historyB: DebateHistoryEntry[] = [];
    const summaryLines: string[] = [];
    const MAX_ROUNDS = maxRounds;

    for (let round = 0; round < MAX_ROUNDS && !this._teamCancel; round++) {
      if (round === 0) { historyA.push({ role: 'user', content: prompt }); }

      this._panel.webview.postMessage({ type: 'debateTurnStart', speaker: 'A', round });
      let responseA = '';
      let statsDA: { tokens?: number; tps?: number } = {};
      try {
        const rA = await callModel(
          this._debateSwap.A ?? modelA, roleADesc, historyA,
          (c) => { if (!this._teamCancel) this._panel.webview.postMessage({ type: 'debateChunk', speaker: 'A', chunk: c }); },
          (t) => { if (!this._teamCancel) this._panel.webview.postMessage({ type: 'debateThinkChunk', speaker: 'A', chunk: t }); }
        );
        responseA = rA.text; statsDA = { tokens: rA.tokens, tps: rA.tps };
      } catch (e) {
        responseA = '[錯誤: ' + (e instanceof Error ? e.message : String(e)) + ']';
        if (!this._teamCancel) this._panel.webview.postMessage({ type: 'debateChunk', speaker: 'A', chunk: responseA });
      }
      this._panel.webview.postMessage({ type: 'debateTurnEnd', speaker: 'A', tokens: statsDA.tokens, tps: statsDA.tps });
      if (this._teamCancel) break;
      historyA.push({ role: 'assistant', content: responseA });
      summaryLines.push(`【${labelA}】\n${responseA}`);

      if (round === 0) {
        historyB.push({ role: 'user', content: `議題：${prompt}\n\n【${labelA}】的論點：\n${responseA}\n\n請提出你的立場，如有不同意見請明確指出。` });
      } else {
        historyB.push({ role: 'user', content: `【${labelA}】反駁道：\n${responseA}\n\n請回應上述論點，維護你的立場或提出新論據。` });
      }

      this._panel.webview.postMessage({ type: 'debateTurnStart', speaker: 'B', round });
      let responseB = '';
      let statsDB: { tokens?: number; tps?: number } = {};
      try {
        const rB = await callModel(
          this._debateSwap.B ?? modelB, roleBDesc, historyB,
          (c) => { if (!this._teamCancel) this._panel.webview.postMessage({ type: 'debateChunk', speaker: 'B', chunk: c }); },
          (t) => { if (!this._teamCancel) this._panel.webview.postMessage({ type: 'debateThinkChunk', speaker: 'B', chunk: t }); }
        );
        responseB = rB.text; statsDB = { tokens: rB.tokens, tps: rB.tps };
      } catch (e) {
        responseB = '[錯誤: ' + (e instanceof Error ? e.message : String(e)) + ']';
        if (!this._teamCancel) this._panel.webview.postMessage({ type: 'debateChunk', speaker: 'B', chunk: responseB });
      }
      this._panel.webview.postMessage({ type: 'debateTurnEnd', speaker: 'B', tokens: statsDB.tokens, tps: statsDB.tps });
      if (this._teamCancel) break;
      historyB.push({ role: 'assistant', content: responseB });
      summaryLines.push(`【${labelB}】\n${responseB}`);

      historyA.push({ role: 'user', content: `【${labelB}】反駁道：\n${responseB}\n\n請回應上述論點，維護你的立場或提出新論據。` });
    }

    const _effectiveJudge = this._debateSwap.J ?? judgeModel;
    if (_effectiveJudge && !this._teamCancel) {
      const judgeMsgs: DebateHistoryEntry[] = [
        { role: 'user', content: summaryLines.join('\n\n---\n\n') + '\n\n請做出綜合總結。' }
      ];
      this._panel.webview.postMessage({ type: 'debateTurnStart', speaker: 'J', round: -1 });
      let statsDJ: { tokens?: number; tps?: number } = {};
      let judgeSummary = '';
      try {
        const rJ = await callModel(
          _effectiveJudge, roleJDesc, judgeMsgs,
          (c) => { if (!this._teamCancel) this._panel.webview.postMessage({ type: 'debateChunk', speaker: 'J', chunk: c }); }
        );
        statsDJ = { tokens: rJ.tokens, tps: rJ.tps };
        judgeSummary = rJ.text || '';
      } catch (e) {
        const errJ = '[錯誤: ' + (e instanceof Error ? e.message : String(e)) + ']';
        if (!this._teamCancel) this._panel.webview.postMessage({ type: 'debateChunk', speaker: 'J', chunk: errJ });
      }
      this._panel.webview.postMessage({ type: 'debateTurnEnd', speaker: 'J', tokens: statsDJ.tokens, tps: statsDJ.tps });

      if (!this._teamCancel) {
        if (judgeSummary && judgeSummary.trim()) {
          this._chatHistory.push({ role: 'assistant', content: judgeSummary });
        } else if (summaryLines.length) {
          this._chatHistory.push({ role: 'assistant', content: summaryLines.join('\n\n---\n\n') });
        }
        this._chatHistories[this._activeSessionId] = this._chatHistory;
        this._panel.webview.postMessage({ type: 'historyCount', count: this._chatHistory.length, sessionId: this._activeSessionId });
      }
    }

    if (!judgeModel && !this._teamCancel && summaryLines.length > 0) {
      this._chatHistory.push({ role: 'assistant', content: summaryLines.join('\n\n---\n\n') });
      this._chatHistories[this._activeSessionId] = this._chatHistory;
      this._panel.webview.postMessage({ type: 'historyCount', count: this._chatHistory.length, sessionId: this._activeSessionId });
    }

    this._panel.webview.postMessage({ type: 'debateEnd', consensus: false });
    this._panel.webview.postMessage({ type: 'agentStatus', running: false });
  }
}
