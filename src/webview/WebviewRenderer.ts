// Copyright (c) 2026 YCHsu. All rights reserved.
// Licensed under the MIT License.
// WebviewRenderer — extracted from OllamaChatPanel.getHtmlForWebview
// Sonnet refactor: Priority-1 split (pure HTML/CSS/JS, no side-effects)
import * as vscode from 'vscode';

function getNonce(): string { return Math.random().toString(36).substring(2, 15); }

export function getHtmlForWebview(_webview: vscode.Webview): string {
    const nonce = getNonce();
    const cfg = vscode.workspace.getConfiguration('amiAiClaw');
    const defaultModel = cfg.get<string>('model') ?? '';
    const models = cfg.get<string[]>('models') ?? (defaultModel ? [defaultModel] : []);
    const optionsHtml = models.map(m => `<option value="${m}" ${m === defaultModel ? 'selected' : ''}>${m}</option>`).join('');
    const sendKey = cfg.get<string>('sendKey') ?? 'Enter';

    return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data: https:;">    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>AMI-AiClaw</title>
    <style>
      *{box-sizing:border-box}
      body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial;margin:0;padding:0;height:100vh;display:flex;flex-direction:column;background:var(--vscode-editor-background);color:var(--vscode-editor-foreground)}
      #chat{flex:1;overflow-y:auto;padding:12px 14px;display:flex;flex-direction:column;gap:10px}
      .msg{max-width:100%;word-break:break-word}
      .msg.user .bubble{background:var(--vscode-button-background,#0e639c);color:var(--vscode-button-foreground,#fff);border-radius:14px 14px 4px 14px;padding:7px 12px;display:inline-block;max-width:88%}
      .msg.user{display:flex;justify-content:flex-end}
      .msg.assistant .bubble{background:var(--vscode-editorWidget-background,rgba(128,128,128,0.12));border-radius:4px 14px 14px 14px;padding:7px 12px;display:inline-block;max-width:96%}
      .msg.assistant{display:flex;justify-content:flex-start}
      pre{background:rgba(0,0,0,0.08);padding:8px;border-radius:4px;white-space:pre-wrap;margin:4px 0;font-size:0.88em}
      .bubble button{font-size:11px;padding:2px 7px;margin:3px 3px 0 0;cursor:pointer;border-radius:4px;background:rgba(128,128,128,0.15);border:1px solid rgba(128,128,128,0.25);color:inherit}
      #bottomBar{border-top:1px solid rgba(128,128,128,0.15);background:var(--vscode-editor-background);padding:6px 8px;display:flex;flex-direction:column;gap:4px}
      #topBar{display:flex;flex-direction:column;gap:0;padding:0}
      #topBarPrimary{display:flex;align-items:center;gap:5px;padding:0 2px 3px;flex-wrap:nowrap}
      #topBarAdvanced{display:none;flex-wrap:wrap;gap:4px;padding:4px 2px 2px;border-top:1px solid rgba(128,128,128,0.12)}
      #topBarAdvanced.open{display:flex}
      #topBarToggle{font-size:11px;padding:2px 6px;border-radius:3px;background:rgba(128,128,128,0.1);border:1px solid rgba(128,128,128,0.2);cursor:pointer;color:inherit;opacity:0.65;flex-shrink:0;line-height:1.5;white-space:nowrap}
      #topBarToggle:hover,#topBarToggle.open{opacity:1;background:rgba(128,128,128,0.2)}
      #shadowKeywordsInput{font-size:11px;padding:2px 6px;border-radius:4px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,rgba(128,128,128,0.4));min-width:110px;max-width:200px;outline:none;flex:1}
      #shadowKeywordsInput:focus{border-color:var(--vscode-focusBorder,#007fd4)}
      .toolbar-group{display:flex;align-items:center;gap:4px;flex-wrap:wrap;padding:2px 6px;border:1px solid rgba(128,128,128,0.16);border-radius:8px;background:rgba(128,128,128,0.05)}
      .toolbar-spacer{flex:1 1 auto}
      #chatSessionSelect{max-width:170px;font-size:12px;padding:3px 6px;background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);border:1px solid var(--vscode-dropdown-border,rgba(128,128,128,0.4));border-radius:4px}
      #chatSearchBar{display:none;align-items:center;gap:4px;padding:2px 0}
      #chatSearchInput{flex:1;font-size:12px;padding:3px 8px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,rgba(128,128,128,0.4));border-radius:4px;outline:none}
      #chatSearchInput:focus{border-color:var(--vscode-focusBorder,#007fd4)}
      #chatSearchResults{font-size:11px;padding:4px 6px;background:var(--vscode-editor-background);border:1px solid rgba(128,128,128,0.2);border-radius:4px;max-height:160px;overflow-y:auto;display:none}
      .search-hit{padding:3px 6px;cursor:pointer;border-radius:3px}
      .search-hit:hover{background:rgba(128,128,128,0.15)}
      .search-hit-title{font-weight:600;font-size:11px}
      .search-hit-snippet{opacity:0.65;font-size:11px;white-space:pre-wrap;word-break:break-all}
      .session-tag{font-size:10px;padding:1px 5px;border-radius:9px;background:rgba(79,193,255,0.18);color:var(--vscode-editorInfo-foreground,#4fc1ff);margin-left:3px;vertical-align:middle}
      #modelSelect{flex:1;min-width:180px;max-width:260px;font-size:12px;padding:3px 6px;background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);border:1px solid var(--vscode-dropdown-border,rgba(128,128,128,0.4));border-radius:4px}
      .icon-btn{background:none;border:none;cursor:pointer;padding:3px 6px;border-radius:4px;font-size:15px;color:var(--vscode-editor-foreground);opacity:0.7;line-height:1}
      .icon-btn:hover{opacity:1;background:rgba(128,128,128,0.15)}
      .icon-btn.active{color:var(--vscode-button-background,#0e639c);opacity:1}
      #fileModPanel{display:none;flex-direction:column;border:1px solid rgba(128,128,128,0.2);border-radius:6px;background:var(--vscode-editorWidget-background,rgba(0,0,0,0.1));margin:4px 0;overflow:hidden}
      #fileModPanel.visible{display:flex}
      .filemod-header{display:flex;align-items:center;gap:6px;padding:3px 8px;font-size:11px;font-weight:700;border-bottom:1px solid rgba(128,128,128,0.15);background:rgba(128,128,128,0.06)}
      .filemod-list{overflow-y:auto;max-height:160px;padding:2px 0}
      .filemod-item{display:flex;align-items:center;gap:6px;padding:3px 8px;cursor:pointer;font-size:11px;border-radius:3px;margin:1px 4px}
      .filemod-item:hover{background:rgba(128,128,128,0.15)}
      .filemod-item.selected{background:rgba(var(--vscode-button-background-rgb,14,99,156),0.18)!important;outline:1px solid rgba(var(--vscode-button-background-rgb,14,99,156),0.4)}
      .filemod-cb{width:12px;height:12px;flex-shrink:0;cursor:pointer;accent-color:var(--vscode-button-background,#0e639c)}
      .filemod-batch-bar{display:none;align-items:center;gap:6px;padding:3px 8px;background:rgba(14,99,156,0.12);border-top:1px solid rgba(128,128,128,0.15);font-size:11px}
      .filemod-batch-bar.visible{display:flex}
      .filemod-op{font-size:10px;padding:1px 5px;border-radius:3px;flex-shrink:0;font-weight:600}
      .filemod-op.write{background:rgba(137,209,133,0.2);color:#89d185}
      .filemod-op.replace{background:rgba(247,204,101,0.2);color:#f7cc65}
      .filemod-op.insert{background:rgba(206,145,120,0.2);color:#ce9178}
      .filemod-op.delete{background:rgba(241,76,76,0.2);color:#f14c4c}
      .filemod-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:0.9}
      .filemod-stat{font-size:10px;font-family:monospace;flex-shrink:0;white-space:nowrap}
      .filemod-stat .st-add{color:#4ec994}
      .filemod-stat .st-del{color:#f14c4c}
      .filemod-time{font-size:10px;opacity:0.5;flex-shrink:0}
      .filemod-empty{padding:8px;font-size:11px;opacity:0.5;text-align:center}
      .filemod-diff-wrap{display:none;padding:0 4px 4px}
      .filemod-diff-wrap.open{display:block}
      .filemod-diff-pre{margin:0;padding:4px 6px;font-size:10px;font-family:monospace;background:rgba(0,0,0,0.18);border-radius:3px;overflow-x:auto;max-height:220px;overflow-y:auto;white-space:pre}
      .diff-add{color:#4ec994}
      .diff-del{color:#f14c4c}
      .diff-hunk{color:#4fc1ff;opacity:0.8}
      .provider-badge{display:inline-flex;align-items:center;gap:4px;min-height:22px;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;border:1px solid rgba(128,128,128,0.25);background:rgba(128,128,128,0.1);white-space:nowrap}
      [data-provider="ollama"] .provider-badge,[data-provider="ollama"].provider-badge,.provider-label[data-provider="ollama"]{color:#4fc1ff}
      [data-provider="copilot"] .provider-badge,[data-provider="copilot"].provider-badge,.provider-label[data-provider="copilot"]{color:#f7cc65}
      [data-provider="openai"] .provider-badge,[data-provider="openai"].provider-badge,.provider-label[data-provider="openai"]{color:#89d185}
      #inputRow{display:flex;align-items:flex-end;gap:6px}
      #prompt{flex:1;min-height:36px;max-height:160px;resize:none;padding:7px 10px;font-size:13px;font-family:inherit;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,rgba(128,128,128,0.4));border-radius:8px;outline:none;overflow-y:auto;line-height:1.4}
      #prompt:focus{border-color:var(--vscode-focusBorder,#007fd4)}
      #sendBtn{background:var(--vscode-button-background,#0e639c);color:var(--vscode-button-foreground,#fff);border:none;border-radius:8px;padding:7px 13px;cursor:pointer;font-size:16px;line-height:1;align-self:flex-end;flex-shrink:0}
      #sendBtn:disabled{opacity:0.4;cursor:default}
/* TEST_MODIFICATION: Added active scale effect */
#sendBtn:active{transform:scale(0.95);transition:transform 0.1s}
      #breathLight{position:relative;width:18px;height:18px;align-self:center;flex-shrink:0}
      #breathLight .bl-ring{position:absolute;inset:1px;border:1px solid var(--vscode-button-background,#0e639c);border-radius:50%;transform:rotate(-28deg) scaleY(0.55);opacity:0.3;transition:opacity 0.5s,border-color 0.5s}
      #breathLight .bl-core{position:absolute;left:50%;top:50%;width:5px;height:5px;margin:-2.5px 0 0 -2.5px;border-radius:50%;background:var(--vscode-button-background,#0e639c);animation:blCoreIdle 3s ease-in-out infinite;transition:background 0.5s}
      #breathLight .bl-ewrap{position:absolute;inset:1px;transform:rotate(-28deg) scaleY(0.55)}
      #breathLight .bl-e{position:absolute;left:50%;top:50%;width:3px;height:3px;margin:-1.5px 0 0 -1.5px;border-radius:50%;background:var(--vscode-button-background,#0e639c);animation:blSpin 3s linear infinite;transition:background 0.5s,box-shadow 0.5s}
      @keyframes blSpin{from{transform:rotate(0deg) translateX(7px)}to{transform:rotate(360deg) translateX(7px)}}
      @keyframes blCoreIdle{0%,100%{transform:scale(0.85);opacity:0.45}50%{transform:scale(1.2);opacity:0.75}}
      #breathLight.thinking .bl-ring{opacity:0.95;border-color:var(--vscode-progressBar-background,var(--vscode-button-background,#0e639c))}
      #breathLight.thinking .bl-core{background:var(--vscode-progressBar-background,var(--vscode-button-background,#0e639c));animation:blCoreActive 1.1s ease-in-out infinite}
      #breathLight.thinking .bl-e{background:var(--vscode-progressBar-background,var(--vscode-button-background,#0e639c));animation-duration:0.85s;box-shadow:0 0 4px var(--vscode-progressBar-background,var(--vscode-button-background,#0e639c))}
      @keyframes blCoreActive{0%,100%{transform:scale(1);opacity:0.9}50%{transform:scale(1.55);opacity:1;box-shadow:0 0 6px var(--vscode-progressBar-background,var(--vscode-button-background,#0e639c))}}
      #statusBar{font-size:11px;opacity:0.75;padding:1px 4px;text-align:center;min-height:14px}
      #contextBar{display:flex;align-items:center;gap:5px;padding:1px 4px;font-size:10px;opacity:0.6;height:12px}
      #contextBar .ctx-label{white-space:nowrap;letter-spacing:0.03em}
      #contextBar .ctx-track{flex:1;height:3px;background:rgba(128,128,128,0.2);border-radius:2px;overflow:hidden}
      #contextBar .ctx-fill{height:100%;border-radius:2px;transition:width 0.4s,background 0.4s}
      #contextBar .ctx-pct{white-space:nowrap;font-variant-numeric:tabular-nums}
      #attachedFiles{padding:2px 8px;display:flex;flex-wrap:wrap;gap:4px;min-height:0}
      .file-chip{display:inline-flex;align-items:center;gap:3px;background:rgba(0,120,215,0.14);border:1px solid rgba(0,120,215,0.3);border-radius:999px;padding:1px 8px;font-size:11px}
      .file-chip .rm{padding:0 2px;font-size:11px;background:none;border:none;cursor:pointer;opacity:0.6;color:inherit;line-height:1}
      details.think { border:1px solid rgba(79,193,255,0.5); margin:8px 0 4px; padding:0; background:rgba(79,193,255,0.06); border-radius:6px; overflow:hidden; width:100% }
      details.think summary { background:rgba(79,193,255,0.2); padding:5px 10px; cursor:pointer; color:var(--vscode-editorInfo-foreground,#4fc1ff); font-size:0.83em; font-weight:600; user-select:none; list-style:none; display:flex; align-items:center; gap:6px }
      details.think summary .think-icon { display:inline-block; width:8px; height:8px; border-radius:50%; background:var(--vscode-editorInfo-foreground,#4fc1ff); flex-shrink:0 }
      details.think summary .think-icon.pulse { animation: pulse 1.2s ease-in-out infinite }
      @keyframes pulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:0.3;transform:scale(0.6)} }
      details.think summary::before { content:none }
      details.think[open] summary::before { content:none }
      details.think pre { margin:0; padding:6px 10px; white-space:pre-wrap; color:var(--vscode-editor-foreground); opacity:0.85; font-size:0.82em; max-height:96px; overflow-y:auto; background:transparent }
      .img-chip{display:inline-flex;align-items:center;gap:4px;background:rgba(180,100,215,0.12);border:1px solid rgba(180,100,215,0.35);border-radius:4px;padding:2px 4px 2px 2px;font-size:11px;margin:2px}
      .img-chip img{width:36px;height:36px;object-fit:cover;border-radius:3px;display:block}
      .img-chip .rm{padding:0 2px;font-size:11px;background:none;border:none;cursor:pointer;opacity:0.6;color:inherit;line-height:1}
      @keyframes blink{0%,80%,100%{opacity:.25}40%{opacity:1}}
      .loading-dots{display:inline-flex;align-items:center;gap:4px;padding:4px 2px}
      .loading-dots span{animation:blink 1.4s infinite both;display:inline-block;width:7px;height:7px;border-radius:50%;background:currentColor}
      .loading-dots span:nth-child(2){animation-delay:.16s}
      .loading-dots span:nth-child(3){animation-delay:.32s}
      .tool-step{border-left:3px solid var(--vscode-debugConsole-warningForeground,#cca700);margin:3px 0;padding:2px 8px;background:rgba(128,128,128,0.05);border-radius:2px;font-size:0.85em}
      .tool-step summary{cursor:pointer;color:var(--vscode-descriptionForeground,#999);list-style:none;padding:2px 0;user-select:none;display:flex;align-items:center;gap:4px}
      .tool-step summary::before{content:'▶  ';font-size:0.7em;flex-shrink:0}
      .tool-step[open] summary::before{content:'▼  ';font-size:0.7em}
      .tool-step[data-s=running] .step-status::after{content:' ⏳'}
      .tool-step[data-s=done] .step-status{color:var(--vscode-terminal-ansiGreen,#4ec94e)}
      .tool-step[data-s=done] .step-status::after{content:' ✓'}
      .tool-step[data-s=error] .step-status{color:var(--vscode-errorForeground,red)}
      .tool-step[data-s=error] .step-status::after{content:' ✗'}
      .tool-step pre{margin:3px 0;white-space:pre-wrap;font-size:0.82em;max-height:140px;overflow:auto;color:var(--vscode-descriptionForeground,#999);background:transparent}
      .code-block-wrap{margin:4px 0}
      .code-actions{display:flex;gap:4px;margin:2px 0 1px;flex-wrap:wrap}
      /* 團隊討論模式 */
      .team-member-node { width:100% }
      .team-member-node .bubble { border-left:3px solid; padding-left:10px; width:100% }
      .team-header { display:flex; align-items:center; gap:6px; padding:0 0 5px; border-bottom:1px solid rgba(128,128,128,0.12); margin-bottom:6px }
      .team-badge { border-radius:3px; padding:1px 8px; font-size:0.75em; font-weight:700; border:1px solid }
      .team-status-text { font-size:0.75em; opacity:0.65 }
      .team-synth-node .bubble { border-left:3px solid #f0c040; background:rgba(240,192,64,0.06); padding:8px 10px; width:100%; border-radius:6px }
      .team-synth-header { font-size:0.8em; font-weight:700; color:#f0c040; padding:0 0 5px; margin-bottom:6px; border-bottom:1px solid rgba(240,192,64,0.25) }
      .team-agent-header { text-align:center; color:#f7cc65; font-size:0.82em; font-weight:700; margin:14px 0 6px; padding:5px 0; border-top:1px dashed rgba(247,204,101,0.4); border-bottom:1px dashed rgba(247,204,101,0.4); letter-spacing:0.03em }
      .team-orchestrator-node .bubble { border-left:3px solid #f7cc65; background:rgba(247,204,101,0.05); padding:8px 10px; width:100%; border-radius:6px }
      .team-orchestrator-header { font-size:0.78em; font-weight:700; color:#f7cc65; display:flex; align-items:center; gap:6px; padding:0 0 5px; margin-bottom:5px; border-bottom:1px solid rgba(247,204,101,0.25) }
      .team-orchestrator-body { white-space:pre-wrap; font-size:0.85em; max-height:12em; overflow-y:auto; background:rgba(0,0,0,0.14); border-radius:4px; padding:4px 8px; margin-top:3px; }
      .team-task-label { font-size:0.78em; opacity:0.72; margin:3px 0 5px; font-style:italic; line-height:1.4; padding:2px 0 }
      .team-round-sep { font-size:0.73em; opacity:0.55; text-align:center; margin:7px 0 3px; border-top:1px solid rgba(128,128,128,0.18); padding-top:5px; letter-spacing:0.04em }
      .team-review-section { margin:5px 0 2px; padding:4px 8px; background:rgba(247,204,101,0.07); border-left:2px solid rgba(247,204,101,0.45); border-radius:3px; font-size:0.8em; line-height:1.5 }
      .team-review-label { font-weight:700; color:#f7cc65; margin-right:4px }
      .team-review-body { white-space:pre-wrap; opacity:0.9 }
      .team-round-approved { color:var(--vscode-terminal-ansiGreen,#4ec94e); font-weight:700; margin-left:4px }
      .team-round-iterate { color:#f7cc65; margin-left:4px }
      .response-body-collapsed { max-height:14em; overflow:hidden; position:relative }
      .response-body-collapsed::after { content:''; position:absolute; bottom:0; left:0; right:0; height:2.5em; background:linear-gradient(transparent, var(--vscode-editorWidget-background,rgba(30,30,30,0.95))) }
      /* Markdown 渲染 */
      .md-table{border-collapse:collapse;margin:6px 0;max-width:100%;font-size:0.88em;display:block;overflow-x:auto}
      .md-table th,.md-table td{border:1px solid rgba(128,128,128,0.3);padding:4px 9px;text-align:left;vertical-align:top;white-space:nowrap}
      .md-table th{background:rgba(128,128,128,0.12);font-weight:600}
      .md-table tbody tr:hover td{background:rgba(128,128,128,0.06)}
      .task-item{display:flex;align-items:baseline;gap:5px;padding:1px 0;line-height:1.5}
      .math-inline{font-family:Georgia,serif;color:var(--vscode-editorInfo-foreground,#4fc1ff);font-style:italic;background:rgba(79,193,255,0.08);padding:1px 4px;border-radius:3px;white-space:nowrap}
      .math-block{font-family:Georgia,serif;color:var(--vscode-editorInfo-foreground,#4fc1ff);font-style:italic;background:rgba(79,193,255,0.07);padding:6px 12px;border-radius:4px;display:block;margin:6px 0;white-space:pre-wrap;overflow-x:auto}
      .response-expand-btn { display:block; font-size:11px; padding:2px 10px; margin:4px 0 0; cursor:pointer; border-radius:4px; background:rgba(128,128,128,0.15); border:1px solid rgba(128,128,128,0.3); color:inherit; width:100%; text-align:center }
      .team-todos-panel { background:rgba(128,128,128,0.06); border:1px solid rgba(128,128,128,0.2); border-radius:6px; padding:6px 10px; margin:8px 0; width:100%; box-sizing:border-box }
      .team-todos-header { font-size:0.78em; font-weight:700; color:#f7cc65; margin-bottom:5px; display:flex; align-items:center; gap:5px }
      .team-todo-item { display:flex; align-items:flex-start; gap:5px; padding:2px 0; font-size:0.78em; line-height:1.5 }
      .team-todo-status { width:14px; text-align:center; flex-shrink:0; padding-top:1px }
      .team-todo-task { opacity:0.85; line-height:1.4; word-break:break-word }
      .team-todo-item.t-done .team-todo-task { text-decoration:line-through; opacity:0.42 }
      .team-todo-item.t-running .team-todo-task { color:#4fc1ff }
      .team-todo-worker { font-size:0.72em; opacity:0.5; margin-left:3px; font-style:italic; white-space:nowrap }
      .agent-todos-panel{background:rgba(128,128,128,0.06);border:1px solid rgba(247,204,101,0.3);border-radius:0;padding:8px 14px;width:100%;box-sizing:border-box;border-left:none;border-right:none;border-top:1px solid rgba(247,204,101,0.3);border-bottom:1px solid rgba(128,128,128,0.15);max-height:180px;overflow-y:auto}
      .agent-todos-header{font-size:0.8em;font-weight:700;color:#f7cc65;margin-bottom:6px;display:flex;align-items:center;gap:8px}
      .agent-todos-progress-track{flex:1;height:3px;background:rgba(128,128,128,0.2);border-radius:2px;min-width:40px}
      .agent-todos-progress-fill{height:100%;background:#f7cc65;border-radius:2px;transition:width 0.4s}
      .agent-todo-item{display:flex;align-items:flex-start;gap:7px;padding:3px 0;font-size:0.82em;line-height:1.5}
      .agent-todo-icon{width:16px;text-align:center;flex-shrink:0}
      .agent-todo-text{flex:1;opacity:0.88;line-height:1.4;word-break:break-word}
      .agent-todo-item.at-done .agent-todo-text{text-decoration:line-through;opacity:0.32}
      .agent-todo-item.at-active .agent-todo-text{color:#4fc1ff;font-weight:600}
      /* Shadow Staging Panel — VS Code diff toolbar 风格 */
      #shadowPanel{display:none;border-top:1px solid rgba(128,128,128,0.2);background:var(--vscode-editor-background);box-sizing:border-box;width:100%;user-select:none}
      .shadow-bar{display:flex;align-items:center;gap:0;padding:0 8px;height:28px;font-size:12px;cursor:pointer;border-bottom:1px solid transparent;transition:background 0.1s}
      .shadow-bar:hover{background:rgba(128,128,128,0.08)}
      .shadow-expand-arrow{font-size:10px;color:rgba(128,128,128,0.7);margin-right:4px;transition:transform 0.15s;flex-shrink:0}
      .shadow-expand-arrow.open{transform:rotate(90deg)}
      .shadow-bar-label{color:rgba(128,128,128,0.9);margin-right:8px;flex-shrink:0}
      .shadow-diff-stat{font-weight:600;margin-right:2px;flex-shrink:0}
      .shadow-diff-stat.add{color:#89d185}
      .shadow-diff-stat.del{color:#f14c4c}
      .shadow-bar-spacer{flex:1}
      .shadow-bar-btn{font-size:11px;padding:2px 10px;border-radius:3px;border:1px solid rgba(128,128,128,0.35);cursor:pointer;font-weight:600;background:none;color:inherit;margin-left:4px;line-height:1.6;flex-shrink:0}
      .shadow-bar-btn:hover{background:rgba(128,128,128,0.15)}
      .shadow-bar-btn.keep{color:#89d185;border-color:rgba(137,209,133,0.5)}.shadow-bar-btn.keep:hover{background:rgba(137,209,133,0.15)}
      .shadow-bar-btn.discard{color:#f14c4c;border-color:rgba(241,76,76,0.4);padding:2px 7px}.shadow-bar-btn.discard:hover{background:rgba(241,76,76,0.12)}
      .shadow-bar-btn.verify{color:#4fc1ff;border-color:rgba(79,193,255,0.4)}.shadow-bar-btn.verify:hover{background:rgba(79,193,255,0.1)}
      .shadow-detail{display:none;border-top:1px solid rgba(128,128,128,0.15)}
      .shadow-detail.open{display:block}
      .shadow-file-list{padding:4px 0;max-height:140px;overflow-y:auto}
      .shadow-file-row{display:flex;align-items:center;gap:6px;padding:2px 12px;font-size:11px;font-family:monospace;cursor:pointer}
      .shadow-file-row:hover{background:rgba(128,128,128,0.08)}
      .shadow-op-badge{font-size:10px;padding:1px 4px;border-radius:2px;font-weight:700;flex-shrink:0;letter-spacing:0.02em}
      .shadow-op-badge.write{background:rgba(137,209,133,0.2);color:#89d185}
      .shadow-op-badge.replace{background:rgba(247,204,101,0.2);color:#f7cc65}
      .shadow-op-badge.insert{background:rgba(79,193,255,0.2);color:#4fc1ff}
      .shadow-op-badge.delete{background:rgba(241,76,76,0.2);color:#f14c4c}
      .shadow-op-badge.rename{background:rgba(206,145,120,0.2);color:#ce9178}
      .shadow-filepath{flex:1;opacity:0.85;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .shadow-filepath:hover{opacity:1;text-decoration:underline}
      .shadow-file-acts{display:none;gap:3px;margin-left:4px;flex-shrink:0}
      .shadow-file-row:hover .shadow-file-acts{display:flex}
      .shadow-file-btn{font-size:10px;padding:1px 6px;border-radius:3px;background:rgba(128,128,128,0.12);border:1px solid rgba(128,128,128,0.25);cursor:pointer;color:inherit;opacity:0.8;line-height:1.5;white-space:nowrap}
      .shadow-file-btn:hover{opacity:1;background:rgba(128,128,128,0.22)}
      .shadow-verify-out{font-size:11px;font-family:monospace;background:rgba(0,0,0,0.12);padding:4px 12px;max-height:80px;overflow-y:auto;white-space:pre-wrap;word-break:break-all;display:none;border-top:1px solid rgba(128,128,128,0.1)}
      /* 對話模式 */
      .debate-turn { margin:6px 0; border-radius:6px; overflow:hidden }
      .debate-turn-header { font-size:0.78em; font-weight:700; padding:3px 10px; display:flex; align-items:center; gap:5px }
      .debate-turn-body { padding:6px 10px; white-space:pre-wrap; font-size:0.87em; line-height:1.55 }
      .debate-consensus { text-align:center; font-size:0.82em; font-weight:700; color:var(--vscode-terminal-ansiGreen,#4ec94e); margin:8px 0; padding:5px 0; border-top:1px dashed rgba(128,128,128,0.3); border-bottom:1px dashed rgba(128,128,128,0.3) }
      .debate-ended { text-align:center; font-size:0.82em; opacity:0.6; margin:6px 0 }
      #debatePicker{display:none;padding:4px 8px 6px;border:1px solid rgba(128,128,128,0.25);border-radius:6px;margin:2px 0;background:rgba(128,128,128,0.05);max-height:130px;overflow-y:auto}
      #debatePicker.visible{display:block}
      #teamPicker{display:none;padding:4px 8px 6px;border:1px solid rgba(128,128,128,0.25);border-radius:6px;margin:2px 0;background:rgba(128,128,128,0.05);max-height:130px;overflow-y:auto}
      #teamPicker.visible{display:block}
      #comparePicker{display:none;padding:4px 8px 6px;border:1px solid rgba(128,128,128,0.25);border-radius:6px;margin:2px 0;background:rgba(128,128,128,0.05);max-height:120px;overflow-y:auto}
      #comparePicker.visible{display:block}
      #teamPickerBar,#debatePickerBar,#comparePickerBar{display:flex;align-items:center;gap:6px;margin-bottom:4px;flex-wrap:wrap}
      .team-pick-row{display:flex;align-items:center;gap:5px;padding:1px 2px}
      .team-pick-row label{font-size:12px;cursor:pointer;user-select:none}
      .role-badge{font-size:10px;font-weight:700;padding:1px 5px;border-radius:10px;margin-left:5px;vertical-align:middle;white-space:nowrap}
      .role-badge-manager{background:#f7cc65;color:#1e1e1e}.role-badge-member{background:#4fc1ff;color:#1e1e1e}.role-badge-coordinator{background:#4ec9b0;color:#1e1e1e}.role-badge-discussor{background:#c586c0;color:#fff}.role-badge-agent{background:#ce9178;color:#1e1e1e}
      .role-badge-planner{background:#f7a534;color:#1e1e1e}.role-badge-developer{background:#4fc1ff;color:#1e1e1e}.role-badge-reviewer{background:#c586c0;color:#fff}.role-badge-tester{background:#4ec9b0;color:#1e1e1e}.role-badge-writer{background:#89d185;color:#1e1e1e}
      .team-pick-role{font-size:10px;padding:1px 4px;border-radius:3px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,rgba(128,128,128,0.3));display:none;cursor:pointer}
      .team-pick-mini-btn{font-size:11px;padding:1px 7px;border-radius:3px;background:rgba(128,128,128,0.15);border:1px solid rgba(128,128,128,0.3);color:inherit;cursor:pointer}
      .team-pick-stepper{display:inline-flex;align-items:center;gap:2px;margin-left:4px}
      .team-pick-step-btn{font-size:11px;width:18px;height:16px;line-height:1;padding:0;border-radius:3px;background:rgba(128,128,128,0.2);border:1px solid rgba(128,128,128,0.3);color:inherit;cursor:pointer}
      .team-pick-step-btn:disabled{opacity:0.35;cursor:default}
      .team-pick-step-count{min-width:14px;text-align:center;font-size:11px;font-weight:700}
      #teamPickerCount{font-size:11px;opacity:0.7}
      /* 記憶管理 Modal */
      #memModal{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:200;align-items:flex-start;justify-content:center;padding-top:40px}
      #memModal.open{display:flex}
      #memBox{background:var(--vscode-editor-background);border:1px solid rgba(128,128,128,0.35);border-radius:10px;padding:18px;width:min(540px,95vw);max-height:80vh;overflow-y:auto;display:flex;flex-direction:column;gap:12px;box-shadow:0 8px 32px rgba(0,0,0,0.4)}
      #memBox h3{margin:0;font-size:14px;font-weight:700;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid rgba(128,128,128,0.2);padding-bottom:10px}
      #memBox h3 .mem-close-btn{background:none;border:none;cursor:pointer;font-size:18px;opacity:0.6;color:inherit;padding:0 4px;line-height:1}
      #memBox h3 .mem-close-btn:hover{opacity:1}
      .mem-section{border:1px solid rgba(128,128,128,0.2);border-radius:6px;padding:10px 12px;display:flex;flex-direction:column;gap:6px}
      .mem-section-title{font-size:12px;font-weight:700;opacity:0.9;margin:0}
      .mem-section-desc{font-size:11px;opacity:0.6;margin:0;line-height:1.4}
      .mem-section textarea{width:100%;min-height:72px;max-height:200px;resize:vertical;font-size:12px;font-family:inherit;padding:6px 8px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,rgba(128,128,128,0.4));border-radius:5px;outline:none;line-height:1.5}
      .mem-section textarea:focus{border-color:var(--vscode-focusBorder,#007fd4)}
      .mem-section textarea[readonly]{opacity:0.75;cursor:default}
      .mem-row{display:flex;gap:6px;flex-wrap:wrap}
      .mem-btn{font-size:11px;padding:4px 10px;cursor:pointer;border-radius:4px;background:rgba(128,128,128,0.15);border:1px solid rgba(128,128,128,0.3);color:inherit}
      .mem-btn:hover{background:rgba(128,128,128,0.25)}
      .mem-btn.primary{background:var(--vscode-button-background,#0e639c);color:var(--vscode-button-foreground,#fff);border-color:transparent}
      .mem-btn.primary:hover{opacity:0.88}
      /* 使用量統計表格 */
      .usage-table{width:100%;border-collapse:collapse;font-size:11px;margin:2px 0}
      .usage-table th{opacity:0.6;font-weight:600;text-align:left;padding:2px 6px;border-bottom:1px solid rgba(128,128,128,0.25)}
      .usage-table td{padding:2px 6px;border-bottom:1px solid rgba(128,128,128,0.1);word-break:break-all}
      .usage-copilot td{color:var(--vscode-editorInfo-foreground,#4fc1ff)}
      /* 統計面板 Modal */
      #statsModal{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:200;align-items:flex-start;justify-content:center;padding-top:40px}
      #statsModal.open{display:flex}
      #statsBox{background:var(--vscode-editor-background);border:1px solid rgba(128,128,128,0.35);border-radius:10px;padding:18px;width:min(640px,95vw);max-height:85vh;overflow-y:auto;display:flex;flex-direction:column;gap:12px;box-shadow:0 8px 32px rgba(0,0,0,0.4)}
      #statsBox h3{margin:0;font-size:14px;font-weight:700;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid rgba(128,128,128,0.2);padding-bottom:10px}
      .stats-section{border:1px solid rgba(128,128,128,0.2);border-radius:6px;padding:10px 12px;display:flex;flex-direction:column;gap:6px}
      .stats-section-title{font-size:12px;font-weight:700;opacity:0.9;margin:0 0 4px}
      /* 模型管理 Modal */
      #modelMgmtModal{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:200;align-items:flex-start;justify-content:center;padding-top:40px}
      #modelMgmtModal.open{display:flex}
      #modelMgmtBox{background:var(--vscode-editor-background);border:1px solid rgba(128,128,128,0.35);border-radius:10px;padding:18px;width:min(520px,95vw);max-height:82vh;overflow-y:auto;display:flex;flex-direction:column;gap:12px;box-shadow:0 8px 32px rgba(0,0,0,0.4)}
      #modelMgmtBox h3{margin:0;font-size:14px;font-weight:700;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid rgba(128,128,128,0.2);padding-bottom:10px}
      #modelMgmtBox h3 .mem-close-btn{background:none;border:none;cursor:pointer;font-size:18px;opacity:0.6;color:inherit;padding:0 4px;line-height:1}
      #modelMgmtBox h3 .mem-close-btn:hover{opacity:1}
      .mgmt-section{border:1px solid rgba(128,128,128,0.2);border-radius:6px;padding:10px 12px;display:flex;flex-direction:column;gap:6px}
      .mgmt-section-title{font-size:12px;font-weight:700;opacity:0.9;margin:0}
      .mgmt-model-list{display:flex;flex-direction:column;gap:3px;max-height:220px;overflow-y:auto}
      .mgmt-model-row{display:flex;align-items:center;justify-content:space-between;padding:4px 6px;border-radius:4px;font-size:12px;background:rgba(128,128,128,0.06)}
      .mgmt-model-row:hover{background:rgba(128,128,128,0.12)}
      .mgmt-model-name{flex:1;word-break:break-all;opacity:0.9}
      .mgmt-delete-btn{font-size:11px;padding:2px 8px;cursor:pointer;border-radius:3px;background:rgba(220,80,80,0.15);border:1px solid rgba(220,80,80,0.4);color:var(--vscode-errorForeground,#f48771);flex-shrink:0;margin-left:6px}
      .mgmt-delete-btn:hover{background:rgba(220,80,80,0.3)}
      .mgmt-pull-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
      #mgmtPullInput{flex:1;min-width:140px;font-size:12px;padding:4px 8px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,rgba(128,128,128,0.4));border-radius:4px;outline:none}
      #mgmtPullInput:focus{border-color:var(--vscode-focusBorder,#007fd4)}
      #mgmtServerSelect{font-size:11px;padding:3px 6px;background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);border:1px solid var(--vscode-dropdown-border,rgba(128,128,128,0.4));border-radius:4px}
      #mgmtPullBtn{font-size:11px;padding:4px 12px;cursor:pointer;border-radius:4px;background:var(--vscode-button-background,#0e639c);color:var(--vscode-button-foreground,#fff);border:none;flex-shrink:0}
      #mgmtPullBtn:hover{opacity:0.88}
      #mgmtPullBtn:disabled{opacity:0.4;cursor:default}
      #mgmtPullProgress{font-size:11px;opacity:0.75;margin:0;word-break:break-all;min-height:16px}
      .latency-bar-row{display:flex;align-items:center;gap:6px;font-size:11px;margin:1px 0}
      .latency-bar-label{width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:0.8;text-align:right;flex-shrink:0}
      .latency-bar-track{flex:1;background:rgba(128,128,128,0.15);border-radius:3px;height:12px;overflow:hidden}
      .latency-bar-fill{height:100%;border-radius:3px;background:#4fc1ff;transition:width 0.3s}
      .latency-bar-val{width:54px;flex-shrink:0;opacity:0.7}
      body[data-provider="copilot"] #statusBar{color:#f7cc65}
      body[data-provider="ollama"] #statusBar{color:#4fc1ff}
      body[data-provider="openai"] #statusBar{color:#89d185}
      /* 棋盤視覺化 */
      .debate-board{background:var(--vscode-editor-background,#1e1e1e);border:1px solid rgba(128,128,128,0.25);border-radius:4px;padding:6px 10px;font-family:Consolas,'Courier New',monospace;font-size:12px;line-height:1.4;white-space:pre;overflow-x:auto;margin:4px 0;color:var(--vscode-editor-foreground,#d4d4d4)}
      #debateSwapBar{padding:6px 8px;border-top:1px solid rgba(128,128,128,0.2);display:flex;flex-wrap:wrap;align-items:center;gap:4px}
      #debateSwapBar select{font-size:11px;padding:2px 4px;border-radius:3px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,rgba(128,128,128,0.4));max-width:130px}
      /* LTM 條目編輯器 */
      .ltm-tabs{display:flex;gap:2px;margin-bottom:0}
      .ltm-tab-btn{font-size:11px;padding:3px 12px;border-radius:4px 4px 0 0;background:rgba(128,128,128,0.1);border:1px solid rgba(128,128,128,0.25);cursor:pointer;color:inherit;opacity:0.65}
      .ltm-tab-btn.active{background:var(--vscode-editor-background);border-bottom:1px solid var(--vscode-editor-background);opacity:1;font-weight:700}
      .ltm-tag-filter{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:4px;min-height:20px}
      .ltm-tag-chip{font-size:10px;padding:1px 7px;border-radius:10px;background:rgba(79,193,255,0.12);border:1px solid rgba(79,193,255,0.3);cursor:pointer;color:#4fc1ff;white-space:nowrap;opacity:0.75}
      .ltm-tag-chip.all{background:rgba(128,128,128,0.12);border-color:rgba(128,128,128,0.3);color:inherit}
      .ltm-tag-chip.active{opacity:1;font-weight:700}
      .ltm-entry-list{display:flex;flex-direction:column;gap:2px;max-height:160px;overflow-y:auto;margin-bottom:4px;border:1px solid rgba(128,128,128,0.15);border-radius:4px;padding:3px 4px}
      .ltm-entry{display:flex;align-items:flex-start;gap:5px;padding:2px 3px;border-radius:3px}
      .ltm-entry:hover{background:rgba(128,128,128,0.08)}
      .ltm-entry-tag{font-size:10px;padding:1px 6px;border-radius:8px;background:rgba(79,193,255,0.18);color:#4fc1ff;white-space:nowrap;cursor:pointer;flex-shrink:0;border:none;font-family:inherit;line-height:1.6}
      .ltm-entry-tag.no-tag{background:rgba(128,128,128,0.15);color:inherit;cursor:default}
      .ltm-entry-text{flex:1;font-size:12px;line-height:1.45;word-break:break-word;cursor:pointer}
      .ltm-entry-text:hover{text-decoration:underline;text-decoration-style:dotted}
      .ltm-entry-del{background:none;border:none;cursor:pointer;color:inherit;opacity:0.35;padding:0 2px;font-size:13px;line-height:1;flex-shrink:0}
      .ltm-entry-del:hover{opacity:1;color:#f87070}
      .ltm-add-row{display:flex;gap:4px;align-items:center;margin-top:3px}
      .ltm-add-tag{width:80px;font-size:11px;padding:3px 6px;border-radius:4px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,rgba(128,128,128,0.4));outline:none}
      .ltm-add-text{flex:1;font-size:11px;padding:3px 6px;border-radius:4px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,rgba(128,128,128,0.4));outline:none}
      /* Permission dialog */
      #permissionBar{display:none;padding:8px 10px;background:rgba(247,150,50,0.12);border:1px solid rgba(247,150,50,0.5);border-radius:6px;margin:4px 0;gap:8px;flex-direction:column}
      #permissionBar.visible{display:flex}
      #permDiffPanel{display:none;border:1px solid rgba(255,255,255,0.12);border-radius:4px;overflow:hidden;max-height:260px;flex-direction:column}
      #permDiffPanel.has-diff{display:flex}
      .diff-tab-bar{display:flex;gap:0;background:rgba(0,0,0,0.3);flex-shrink:0}
      .diff-tab{padding:3px 10px;font-size:11px;cursor:pointer;border-bottom:2px solid transparent;color:var(--vscode-foreground);opacity:0.6}
      .diff-tab.active{opacity:1;border-bottom-color:#4fc1ff}
      .diff-pane{display:none;overflow:auto;max-height:220px;background:rgba(0,0,0,0.25)}
      .diff-pane.active{display:block}
      .diff-pane pre{margin:0;padding:4px 6px;font-family:var(--vscode-editor-font-family,monospace);font-size:11px;white-space:pre-wrap;word-break:break-all;line-height:1.5}
      .diff-line-add{background:rgba(78,201,176,0.18);color:#4ec9b0}
      .diff-line-del{background:rgba(244,71,71,0.18);color:#f44747}
      .diff-line-ctx{color:rgba(255,255,255,0.5)}
      #permissionDesc{font-size:12px;line-height:1.5;word-break:break-all}
      #permissionBtns{display:flex;gap:6px;flex-wrap:wrap}
      .perm-btn{font-size:12px;padding:4px 12px;border-radius:4px;border:1px solid;cursor:pointer;font-weight:600}
      .perm-btn-allow{background:rgba(0,180,0,0.18);border-color:rgba(0,200,0,0.5);color:var(--vscode-terminal-ansiGreen,#4ec94e)}
      .perm-btn-allow:hover{background:rgba(0,180,0,0.32)}
      .perm-btn-session{background:rgba(0,120,255,0.18);border-color:rgba(0,140,255,0.5);color:var(--vscode-terminal-ansiBlue,#4e9ff5)}
      .perm-btn-session:hover{background:rgba(0,120,255,0.32)}
      .perm-btn-always{background:rgba(0,122,204,0.2);border-color:rgba(0,140,240,0.5);color:#4fc1ff}
      .perm-btn-always:hover{background:rgba(0,122,204,0.32)}
      .perm-btn-deny{background:rgba(220,30,30,0.18);border-color:rgba(220,50,50,0.5);color:var(--vscode-terminal-ansiRed,#f87070)}
      .perm-btn-deny:hover{background:rgba(220,30,30,0.32)}
      /* WhatsApp QR 綁定 */
      #waQrModal{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:5000;align-items:center;justify-content:center}
      #waQrModal.visible{display:flex}
      #waQrBox{background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border,rgba(128,128,128,0.3));border-radius:12px;padding:24px 28px;text-align:center;max-width:300px;width:100%}
      #waQrBox h3{margin:0 0 6px;font-size:14px}
      #waQrMsg{font-size:12px;color:var(--vscode-descriptionForeground);margin:4px 0 10px;line-height:1.4}
      #waQrImg{width:220px;height:220px;object-fit:contain;border-radius:6px;background:#fff;padding:6px;margin:0 auto;display:none}
      #waQrHint{font-size:11px;color:var(--vscode-descriptionForeground);margin:8px 0 10px;opacity:0.8}
      #waQrCancelBtn{font-size:11px;padding:4px 14px;border-radius:4px;background:rgba(220,50,50,0.15);border:1px solid rgba(220,50,50,0.4);color:var(--vscode-terminal-ansiRed,#f87070);cursor:pointer}
      #waQrCancelBtn:hover{background:rgba(220,50,50,0.28)}
      /* WhatsApp 連線狀態 bar */
      #waStatusBar{display:none;margin:3px 0;padding:4px 10px;background:rgba(37,211,102,0.1);border:1px solid rgba(37,211,102,0.35);border-radius:6px;font-size:12px;align-items:center;justify-content:space-between}
      #waStatusBar.visible{display:flex}
      #waDiscBtn{font-size:11px;padding:2px 8px;border-radius:4px;background:rgba(220,50,50,0.12);border:1px solid rgba(220,50,50,0.4);color:var(--vscode-terminal-ansiRed,#f87070);cursor:pointer}
      /* 程式碼語法高亮 token（深色主题） */
      .hl-kw{color:#569cd6;font-weight:500}.hl-str{color:#ce9178}.hl-cmt{color:#6a9955;font-style:italic}.hl-num{color:#b5cea8}.hl-fn{color:#dcdcaa}.hl-type{color:#4ec9b0}
      /* 淺色主题覆寫 */
      body.vscode-light .hl-kw{color:#0000ff}body.vscode-light .hl-str{color:#a31515}body.vscode-light .hl-cmt{color:#008000}body.vscode-light .hl-num{color:#098658}body.vscode-light .hl-fn{color:#795e26}body.vscode-light .hl-type{color:#267f99}
      /* 程式碼塊標頭 */
      .code-block-header{display:flex;align-items:center;justify-content:space-between;padding:3px 10px;background:rgba(0,0,0,0.18);border-radius:4px 4px 0 0;font-size:11px;font-family:Consolas,'Courier New',monospace;opacity:0.75;user-select:none}
      body.vscode-light .code-block-header{background:rgba(0,0,0,0.07)}
      .code-block-wrap pre{border-radius:0 0 4px 4px;margin:0;overflow-x:auto}
      /* 訊息動作按鈕（編輯 / 分支） */
      .msg-actions{display:none;gap:3px;margin-top:3px;flex-wrap:wrap}
      .msg:hover .msg-actions,.msg.editing .msg-actions{display:flex}
      .msg-action-btn{font-size:10px;padding:1px 6px;border-radius:3px;background:rgba(128,128,128,0.12);border:1px solid rgba(128,128,128,0.25);cursor:pointer;color:inherit;opacity:0.65;line-height:1.5}
      .msg-action-btn:hover{opacity:1;background:rgba(128,128,128,0.22)}
      /* 內嵌編輯覆蓋層 */
      .user-edit-overlay{display:flex;flex-direction:column;gap:4px;width:100%}
      .user-edit-textarea{min-height:48px;max-height:200px;resize:vertical;padding:6px 8px;font-size:13px;font-family:inherit;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-focusBorder,#007fd4);border-radius:6px;outline:none;width:100%;box-sizing:border-box}
      .user-edit-actions{display:flex;gap:5px}
      /* ── Slash Command 快速選單 ─────────────────────────────────────────────── */
      #inputRow{position:relative}
      #slashPopup{position:absolute;bottom:100%;left:0;right:0;margin-bottom:4px;background:var(--vscode-input-background,#1e1e1e);border:1px solid var(--vscode-input-border,#454545);border-radius:6px;z-index:200;max-height:224px;overflow-y:auto;display:none;box-shadow:0 -4px 14px rgba(0,0,0,0.45)}
      .slash-item{padding:6px 12px;cursor:pointer;display:flex;align-items:center;gap:10px;font-size:12px;border-left:3px solid transparent}
      .slash-item:hover,.slash-item.slash-active{background:var(--vscode-list-activeSelectionBackground,#094771);color:var(--vscode-list-activeSelectionForeground,#fff);border-left-color:var(--vscode-focusBorder,#007fd4)}
      .slash-cmd{font-weight:600;min-width:128px;font-family:var(--vscode-editor-font-family,monospace);color:var(--vscode-symbolIcon-stringForeground,#ce9178)}
      .slash-desc{opacity:0.75;font-size:11px}
    </style>
  </head>
  <body data-provider="ollama">
    <div id="chat"></div>
    <div id="agentTodosPanel" style="display:none">
      <div class="agent-todos-panel">
        <div class="agent-todos-header"><span id="agTodosTitle"></span><div class="agent-todos-progress-track"><div class="agent-todos-progress-fill" id="agTodosFill" style="width:0%"></div></div></div>
        <div id="agTodosList"></div>
      </div>
    </div>
    <div id="shadowPanel">
      <div class="shadow-bar" id="shadowBar">
        <span class="shadow-expand-arrow" id="shadowArrow">&#x25BA;</span>
        <span class="shadow-bar-label" id="shadowBarLabel">已變更 0 個檔案</span>
        <span class="shadow-diff-stat add" id="shadowAddStat"></span>
        <span class="shadow-diff-stat del" id="shadowDelStat"></span>
        <span class="shadow-bar-spacer"></span>
        <button class="shadow-bar-btn verify" id="shadowVerifyBtn">驗證</button>
        <button class="shadow-bar-btn keep" id="shadowApproveBtn">保留</button>
        <button class="shadow-bar-btn discard" id="shadowRejectBtn">&#x2715;</button>
      </div>
      <div class="shadow-detail" id="shadowDetail">
        <div class="shadow-file-list" id="shadowFileList"></div>
        <div class="shadow-verify-out" id="shadowVerifyOut"></div>
      </div>
    </div>
    <div id="bottomBar">
      <div id="topBar">
        <div id="topBarPrimary">
          <select id="chatSessionSelect" aria-label="選擇聊天" style="max-width:130px;font-size:12px;padding:3px 6px;background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);border:1px solid var(--vscode-dropdown-border,rgba(128,128,128,0.4));border-radius:4px"></select>
          <button class="icon-btn" id="newChat" title="新增聊天" aria-label="新增聊天">➕</button>
          <button id="topBarToggle" title="進階選項（聊天管理、思考等級、工具面板）">⚙ ▾</button>
          <select id="modelSelect" aria-label="選擇模型" style="flex:1;min-width:80px;max-width:220px;font-size:12px;padding:3px 6px;background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);border:1px solid var(--vscode-dropdown-border,rgba(128,128,128,0.4));border-radius:4px">${optionsHtml}</select>
          <select id="modeSelect" aria-label="互動模式" title="互動模式" style="font-size:12px;padding:3px 6px;border-radius:4px">
            <option value="ask">💬 Ask</option>
            <option value="agent" selected>🤖 Agent</option>
            <option value="team">👥 Team</option>
            <option value="compare">🆚 Compare</option>
            <option value="debate">⚔️ Debate</option>
          </select>
          <button class="icon-btn" id="stopAgent" title="停止目前執行中的 Agent / Team / Debate" aria-label="停止執行">⏹</button>
          <button class="icon-btn" id="clear" title="清除對話" aria-label="清除對話">🗑</button>
          <span class="toolbar-spacer"></span>
          <span id="connStatus" style="font-size:11px;opacity:0.8;flex-shrink:0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">\u9023\u7dda\uff1a\u6aa2\u67e5\u4e2d\u2026</span>
        </div>
        <div id="topBarAdvanced">
          <div class="toolbar-group" aria-label="聊天管理">
            <button class="icon-btn" id="renameChat" title="設定聊天標題" aria-label="設定聊天標題">&#x1F3F7;&#xFE0F;</button>
            <button class="icon-btn" id="deleteChat" title="刪除此聊天" aria-label="刪除聊天">&#x1F5D1;&#xFE0F;</button>
            <button class="icon-btn" id="exportChat" title="匯出對話" aria-label="匯出對話">&#x1F4E4;</button>
            <button class="icon-btn" id="importChat" title="匯入對話" aria-label="匯入對話">&#x1F4E5;</button>
            <button class="icon-btn" id="searchChatBtn" title="搜尋所有對話" aria-label="搜尋所有對話">&#x1F50D;</button>
          </div>
          <div class="toolbar-group" aria-label="模型與供應商">
            <span id="providerBadge" class="provider-badge" data-provider="ollama" title="目前供應商">Ollama</span>
            <span id="modelMultiplier" style="font-size:11px;opacity:0.65;padding:0 3px;white-space:nowrap"></span>
            <button class="icon-btn" id="refreshModels" title="重整模型 / 測試連線" aria-label="重整模型 / 測試連線">🔄</button>
            <button class="icon-btn" id="manageModels" title="管理 Ollama 模型（新增 / 刪除）" aria-label="管理 Ollama 模型">⚙️</button>
          </div>
          <div class="toolbar-group" aria-label="附加與思考">
            <button class="icon-btn" id="pickFile" title="附加檔案" aria-label="附加檔案">📎</button>
            <button class="icon-btn" id="toggleStream" title="切換串流模式" aria-label="切換串流模式">⚡</button>
            <select id="thinkLevelSelect" aria-label="思考等級" title="思考等級：off 強制關閉、low/medium/high/max 傳對應等級給 Ollama（thinking 模型生效）" style="font-size:12px;padding:3px 6px;border-radius:4px">
              <option value="off">🚫 不思考</option>
              <option value="low">💭 低</option>
              <option value="medium" selected>🧠 中</option>
              <option value="high">🌌 高</option>
              <option value="max">🔥 最大</option>
            </select>
            <select id="contextDepthSelect" aria-label="深度解析" title="深度解析（注入到 system prompt）：file = 只附帶作用中檔案；outline = 加上工作區結構摘要（檔案樹 + 重要檔 outline）；full = 把整個工作區原始碼倒進 context（受 deepAnalysisMaxKb 容量上限保護）" style="font-size:12px;padding:3px 6px;border-radius:4px">
              <option value="file" selected>📄 一般</option>
              <option value="outline">🗂️ 摘要</option>
              <option value="full">🔬 全讀</option>
            </select>
            <select id="shadowModelSelect" aria-label="影子督促模型" title="影子督促人格使用的模型（留空 = 同主人格）" style="font-size:12px;padding:3px 6px;border-radius:4px;max-width:140px">
              <option value="">🕵️ 同主人格</option>
            </select>
            <input type="text" id="shadowKeywordsInput" placeholder="督促觸發詞，逗號分隔" title="影子督促觸發詞：prompt 含任一詞時啟動審查（逗號分隔，留空還原預設）" aria-label="影子督促觸發詞">
          </div>
          <div class="toolbar-group" aria-label="工具與面板">
            <button class="icon-btn" id="memBtn" title="記憶管理" aria-label="記憶管理">🧠</button>
            <button class="icon-btn" id="statsBtn" title="使用統計 / 效能分析" aria-label="使用統計 / 效能分析">📊</button>
            <select id="permModeSelect" aria-label="權限模式" title="工具呼叫的批准模式：手動 / AutoPilot 自動判斷 / 全自動批准" style="font-size:12px;padding:3px 6px;border-radius:4px">
              <option value="manual" selected>✋ 手動確認</option>
              <option value="autopilot">🛡️ AutoPilot</option>
              <option value="yolo">🚀 全自動</option>
            </select>
            <button class="icon-btn" id="fileModBtn" title="顯示/隱藏修改記錄清單" aria-label="修改記錄">📋</button>
            <button class="icon-btn" id="organizePhotosBtn" title="整理照片（辨識人物 / 行為並分類）" aria-label="整理照片">🖼️</button>
            <button class="icon-btn" id="debugBtn" title="Debug Console" aria-label="Debug Console" style="font-size:12px;">🐛</button>
          </div>
        </div>
      </div>
      <div id="attachedFiles"></div>
      <div id="chatSearchBar">
        <input id="chatSearchInput" type="text" placeholder="&#x641C;&#x5C0B;&#x6240;&#x6709;&#x5C0D;&#x8A71;&#x2026;">
        <button class="team-pick-mini-btn" id="chatSearchGo">&#x641C;&#x5C0B;</button>
        <button class="team-pick-mini-btn" id="chatSearchClose">&#x2715;</button>
      </div>
      <div id="chatSearchResults"></div>
      <div id="teamPicker">
        <div id="teamPickerBar">
          <span style="font-size:11px;font-weight:700">&#x1F465; 選擇團隊成員（最多 5 個）</span>
            <button class="team-pick-mini-btn" id="teamPickerRefresh" title="重新整理團隊模型">&#x1F504;</button>
            <label style="font-size:11px;margin-left:8px">模式：</label>
            <select id="teamModeSelect" style="font-size:11px;padding:3px 6px;border-radius:4px">
              <option value="parallel" selected>&#x26A1; 平行協作 Agent</option>
              <option value="manager">&#x1F3E2; 主管模式（含 Agent 能力）</option>
            </select>
            <label style="font-size:11px;margin-left:6px">回合：</label>
            <select id="teamRoundsSelect" style="font-size:11px;padding:3px 6px;border-radius:4px">
              <option value="10">10</option>
              <option value="20" selected>20</option>
              <option value="30">30</option>
              <option value="150">150</option>
              <option value="infinite">無限</option>
            </select>
            <label style="font-size:11px;margin-left:6px" title="同時執行的子任務上限">並行：</label>
            <select id="teamMaxParallelSelect" style="font-size:11px;padding:3px 6px;border-radius:4px" title="同時執行的子任務上限（1=完全序列）">
              <option value="1">1</option>
              <option value="2">2</option>
              <option value="3" selected>3</option>
              <option value="5">5</option>
            </select>
            <span style="flex:1"></span>
            <button class="team-pick-mini-btn" id="teamQuickSetupBtn" title="快速配置：主管 + 3 工程師 + 測試員">&#x26A1; 5-slot</button>
            <span id="teamPickerCount">0/5 已選</span>
        </div>
        <div id="teamPickerList"><span style="font-size:11px;opacity:0.6">載入中…</span></div>
      </div>
      <div id="comparePicker">
        <div id="comparePickerBar">
          <span style="font-size:11px;font-weight:700">&#x1F19A; 模型比較（選 2-5 個，同一問題各自作答）</span>
           <button class="team-pick-mini-btn" id="comparePickerRefresh" title="重新整理比較模型">&#x1F504;</button>
          <span style="flex:1"></span>
          <span id="comparePickerCount">0/5 已選</span>
        </div>
        <div id="comparePickerList"><span style="font-size:11px;opacity:0.6">載入中…</span></div>
      </div>
      <div id="debatePicker">
        <div id="debatePickerBar">
          <span style="font-size:11px;font-weight:700">&#x2694;&#xFE0F; 對話成員（2 個應戰，可加第 3 個裁判）</span>
            <button class="team-pick-mini-btn" id="debatePickerRefresh" title="重新整理對話模型">&#x1F504;</button>
            <label style="font-size:11px;margin-left:8px">回合：</label>
            <select id="debateRoundsSelect" style="font-size:11px;padding:3px 6px;border-radius:4px">
              <option value="10">10</option>
              <option value="20" selected>20</option>
              <option value="30">30</option>
              <option value="150">150</option>
              <option value="infinite">無限</option>
              <option value="custom">自訂…</option>
            </select>
            <input type="number" id="debateRoundsCustomInput" min="1" max="9999" style="display:none;font-size:11px;width:56px;padding:2px 4px;border-radius:4px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,rgba(128,128,128,0.4))" placeholder="輪數">
            <span style="flex:1"></span>
            <span id="debatePickerCount">0/3 已選</span>
        </div>
        <div id="debatePickerList"><span style="font-size:11px;opacity:0.6">載入中…</span></div>
        <div id="debateSwapBar" style="display:none">
          <span style="font-size:11px;opacity:0.7">&#x2699;&#xFE0F; 即時換模型：</span>
          <label style="font-size:11px">A:</label><select id="debateSwapA"><option value="">─ 保持 ─</option></select>
          <label style="font-size:11px">B:</label><select id="debateSwapB"><option value="">─ 保持 ─</option></select>
          <label style="font-size:11px">J:</label><select id="debateSwapJ"><option value="">─ 保持 ─</option></select>
        </div>
      </div>
      <div id="inputRow">
        <div id="slashPopup"></div>
        <textarea id="prompt" rows="1" placeholder="輸入訊息… (Enter 送出 / Ctrl+Enter 換行)"></textarea>
        <div id="breathLight" title="AI 思考狀態" aria-label="AI 思考狀態"><div class="bl-ring"></div><div class="bl-core"></div><div class="bl-ewrap"><div class="bl-e"></div></div></div>
        <button id="sendBtn" title="送出">&#9658;</button>
      </div>
      <div id="permissionBar">
        <div id="permissionDesc"></div>
        <div id="permDiffPanel">
          <div class="diff-tab-bar">
            <span class="diff-tab active" data-pane="unified">統一 Diff</span>
            <span class="diff-tab" data-pane="before">改前</span>
            <span class="diff-tab" data-pane="after">改後</span>
          </div>
          <div class="diff-pane active" id="diffPaneUnified"><pre></pre></div>
          <div class="diff-pane" id="diffPaneBefore"><pre></pre></div>
          <div class="diff-pane" id="diffPaneAfter"><pre></pre></div>
        </div>
        <div id="permissionBtns">
          <button class="perm-btn perm-btn-allow" id="permAllow">✅ 允許（此次）</button>
          <button class="perm-btn perm-btn-always" id="permAlways">♾️ 永遠允許此類</button>
          <button class="perm-btn perm-btn-session" id="permSession">🚀 本次全允許</button>
          <button class="perm-btn perm-btn-deny" id="permDeny">❌ 拒絕</button>
        </div>
      </div>
      <div id="waStatusBar">
        <span>💚 WhatsApp Web 已連線 <span id="waPhoneNum" style="font-weight:600;margin-left:4px"></span></span>
        <button id="waDiscBtn">斷線</button>
      </div>
      <div id="fileModPanel">
        <div class="filemod-header">
          <input type="checkbox" id="fileModSelectAll" class="filemod-cb" title="全選/取消全選">
          <span>📋 修改記錄（本次 Session）</span>
          <span id="fileModCount" style="opacity:0.6">0 項</span>
          <span style="flex:1"></span>
          <button class="icon-btn" id="fileModClear" style="font-size:11px;padding:1px 6px" title="清除記錄">清除</button>
        </div>
        <div class="filemod-list" id="fileModList"><div class="filemod-empty">尚無修改記錄</div></div>
        <div class="filemod-batch-bar" id="fileModBatchBar">
          <span id="fileModSelCount" style="opacity:0.7">已選 0</span>
          <span style="flex:1"></span>
          <button class="icon-btn" id="fileModBatchOpen" style="font-size:11px;padding:1px 6px" title="批次在編輯器開啟">📂 開啟全部</button>
          <button class="icon-btn" id="fileModBatchDiff" style="font-size:11px;padding:1px 6px" title="依序在 diff 分頁開啟">🔀 Diff</button>
          <button class="icon-btn" id="fileModBatchClear" style="font-size:11px;padding:1px 6px;color:#e05252" title="從記錄中移除已選項目">🗑 移除</button>
        </div>
      </div>
      <div id="contextBar"><span class="ctx-label">Context</span><div class="ctx-track"><div class="ctx-fill" style="width:0%;background:#4ec9b0"></div></div><span class="ctx-pct">—</span></div>
      <div id="statusBar"></div>
    </div>
    <div id="waQrModal">
      <div id="waQrBox">
        <h3>&#x1F4F1; 掃描 QR Code 綁定 WhatsApp</h3>
        <p id="waQrMsg">生成 QR Code 中，請稍候&#x2026;</p>
        <img id="waQrImg" alt="QR Code" />
        <p id="waQrHint">用 WhatsApp 手機 → 已連結的裝置 → 連結裝置 → 掃描</p>
        <button id="waQrCancelBtn">&#x274C; 取消連線</button>
      </div>
    </div>
    <div id="memModal">
      <div id="memBox">
        <h3>&#x1F9E0; 記憶管理 <button class="mem-close-btn" id="memClose">✕</button></h3>
        <div class="mem-section">
          <p class="mem-section-title">&#x1F4CB; 角色設定（System Prompt）</p>
          <p class="mem-section-desc">每次對話都自動套用，在 VS Code 設定中編輯</p>
          <textarea id="personaPreview" readonly rows="3" placeholder="（讀取中...）"></textarea>
          <div class="mem-row"><button class="mem-btn" id="editPersonaBtn">&#x2699;&#xFE0F; 在設定中編輯角色</button></div>
        </div>
        <div class="mem-section">
          <p class="mem-section-title">&#x1F5C2; 長期記憶（跨對話持續保存）</p>
          <p class="mem-section-desc">每次對話都會套用此記憶為背景知識。可寫入專案偏好、環境、重要事實等。</p>
          <div class="ltm-tabs">
            <button class="ltm-tab-btn active" id="ltmTabEntry">&#x1F4CB; 條目</button>
            <button class="ltm-tab-btn" id="ltmTabRaw">&#x1F4C4; 原始文字</button>
          </div>
          <div id="ltmEntryView">
            <div id="ltmTagFilter" class="ltm-tag-filter"></div>
            <div id="ltmEntryList" class="ltm-entry-list"><span style="font-size:11px;opacity:0.5">載入中…</span></div>
            <div class="ltm-add-row">
              <input type="text" class="ltm-add-tag" id="ltmAddTag" placeholder="#標籤（選填）" maxlength="24">
              <input type="text" class="ltm-add-text" id="ltmAddText" placeholder="新增記憶條目…（Enter 送出）">
              <button class="mem-btn primary" id="ltmAddBtn">&#xFF0B;</button>
            </div>
          </div>
          <div id="ltmRawView" style="display:none">
            <input id="ltmSearch" type="text" placeholder="&#x1F50D; 搜尋關鍵字…" style="width:100%;box-sizing:border-box;font-size:11px;padding:3px 8px;margin-bottom:4px;border-radius:4px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,rgba(128,128,128,0.4));outline:none">
            <textarea id="ltmArea" rows="7" placeholder="#標籤 條目內容&#10;例如：&#10;#環境 用 Windows 11 + WSL2&#10;#專案 此專案用 TypeScript strict mode&#10;- 無標籤的一般備忘（- 開頭）"></textarea>
          </div>
          <div class="mem-row">
            <button class="mem-btn primary" id="saveLtmBtn">&#x1F4BE; 儲存長期記憶</button>
            <button class="mem-btn" id="clearLtmBtn">&#x1F5D1; 清除</button>
            <button class="mem-btn" id="exportLtmBtn">&#x1F4E4; 匯出</button>
            <input type="file" id="importLtmInput" accept=".json" style="display:none">
            <button class="mem-btn" id="importLtmBtn">&#x1F4E5; 匯入</button>
          </div>
        </div>
        <div class="mem-section">
          <p class="mem-section-title">&#x1F4AC; 短期記憶（本次對話歷史）</p>
          <p class="mem-section-desc">關閉 Panel 後消失。AI 會記得本次對話中所有問答內容。</p>
          <p id="historyInfo" style="font-size:12px;margin:2px 0;">對話歷史：0 條訊息</p>
          <textarea id="historyPreview" readonly rows="5" placeholder="（開啟此面板時載入最近 10 條）" style="font-size:11px;opacity:0.85;background:var(--vscode-input-background,#1e1e1e);color:var(--vscode-input-foreground,#ccc);border:1px solid var(--vscode-input-border,#555);border-radius:4px;width:100%;box-sizing:border-box;padding:4px 6px;resize:vertical;margin:4px 0"></textarea>
          <div class="mem-row" style="gap:6px;flex-wrap:wrap">
            <button class="mem-btn primary" id="consolidateLtmBtn">&#x1F9E0; AI 整理為長期記憶</button>
            <button class="mem-btn" id="clearHistoryBtn2">&#x1F5D1; 清除對話歷史</button>
          </div>
          <p id="consolidateStatus" style="font-size:11px;opacity:0.7;margin:2px 0;display:none"></p>
        </div>
        <!-- 使用量統計 -->
        <div class="mem-section">
          <p class="mem-section-title">&#x1F4CA; API 使用量統計</p>
          <div id="usageTableWrap"><p style="font-size:11px;opacity:0.55;margin:2px 0">尚無資料</p></div>
          <div class="mem-row">
            <button class="mem-btn" id="resetUsageBtn">&#x1F5D1; 重置統計</button>
          </div>
        </div>
      </div>
    </div>
    <div id="modelMgmtModal">
      <div id="modelMgmtBox">
        <h3>&#x2699;&#xFE0F; Ollama 模型管理 <button class="mem-close-btn" id="modelMgmtClose">&#x2715;</button></h3>
        <div class="mgmt-section">
          <p class="mgmt-section-title">&#x1F4E5; 拉取新模型</p>
          <div class="mgmt-pull-row">
            <select id="mgmtServerSelect" aria-label="選擇 Ollama 伺服器"></select>
            <input id="mgmtPullInput" type="text" placeholder="模型名稱，例如 llama3.2:latest" autocomplete="off" spellcheck="false">
            <button id="mgmtPullBtn">&#x25B6; 拉取</button>
          </div>
          <p id="mgmtPullProgress"></p>
        </div>
        <div class="mgmt-section">
          <p class="mgmt-section-title">&#x1F5D1;&#xFE0F; 已安裝的模型</p>
          <div id="mgmtModelList" class="mgmt-model-list"><span style="font-size:11px;opacity:0.5">載入中…</span></div>
        </div>
      </div>
    </div>
    <div id="statsModal">
      <div id="statsBox">
        <h3>&#x1F4CA; 使用統計 &amp; 效能分析 <button class="mem-close-btn" id="statsClose">&#x2715;</button></h3>
        <div class="stats-section">
          <p class="stats-section-title">&#x1F4CB; Token &amp; 工具呼叫統計</p>
          <div id="statsUsageWrap"><p style="font-size:11px;opacity:0.55;margin:2px 0">尚無資料</p></div>
          <div class="mem-row"><button class="mem-btn" id="statsResetBtn">&#x1F5D1; 重置統計</button></div>
        </div>
        <div class="stats-section">
          <p class="stats-section-title">&#x23F1; 請求延遲（最近 50 筆，ms）</p>
          <div id="statsLatencyWrap"><p style="font-size:11px;opacity:0.55;margin:2px 0">尚無資料</p></div>
        </div>
      </div>
    </div>
    <script nonce="${nonce}">
      // Pre-create debugPanel so errors from the main script are visible
      (function(){
        var dp = document.createElement('pre');
        dp.id = 'debugPanel';
        dp.style.cssText = 'display:none;position:fixed;top:0;left:0;right:0;z-index:9999;background:rgba(0,0,0,0.9);color:#f44;font-size:11px;padding:6px 10px;white-space:pre-wrap;font-family:Consolas,monospace;max-height:200px;overflow:auto;border-bottom:2px solid #f44;';
        dp.textContent = '';
        document.body.appendChild(dp);
        window._debugLog = [];
        window.onerror = function(msg, src, line, col, err) {
          dp.style.display = 'block';
          dp.textContent += '\\nERR:' + msg + ' L' + line + ':' + col + (err && err.stack ? '\\n' + err.stack : '');
        };
      })();
    </script>
    <script nonce="${nonce}">
      // ── AmiClaw main script ──────────────────────────────────────────────────
      const vscode = acquireVsCodeApi();
      var cfgSendKey = ${JSON.stringify(sendKey)};

      // ── Debug Console ──────
      window._debugLog = window._debugLog || [];
      function dbg(msg) { var t = new Date().toISOString().slice(11,23); window._debugLog.push(t + ' ' + msg); var dp = document.getElementById('debugPanel'); if (dp && dp.style.display !== 'none') { dp.textContent = window._debugLog.slice(-10).join('\\n'); } }
      dbg('webview init start');
      var debugPanel = document.getElementById('debugPanel');
      window.onerror = function(msg, src, line, col) { dbg('ERROR: ' + msg + ' at line ' + line + ':' + col); return false; };

      // ── 使用者訊息計數 / 歷史長度追蹤 ────
      var _userMsgCount = 0;   // 已加入的 user message 數（用於 editMessage / forkSession）
      var _lastTokenInfo = ''; // streamEnd 設定的 token 資訊文字（供 agentStatus restore 用）
      var _providerInfo = { id: 'ollama', label: 'Ollama', modelId: '', displayName: '' };

      function getProviderAppearance(providerId) {
        return {
          ollama:  { icon: '\\uD83E\\uDD99', label: 'Ollama' },
          copilot: { icon: '\\uD83E\\uDDE0', label: 'Copilot' },
          openai:  { icon: '\\u2728',         label: 'OpenAI Compatible' }
        }[providerId] || { icon: '\\uD83E\\uDD16', label: providerId || 'Provider' };
      }

      function inferProviderFromModelId(modelId) {
        if (!modelId) return 'ollama';
        if (modelId.indexOf('copilot::') === 0 || modelId.indexOf('copilot/') === 0) return 'copilot';
        if (modelId.indexOf('openai::') === 0) return 'openai';
        return 'ollama';
      }

      // 判斷模型是否支援 thinking（與 ollama-chat.ts 的 supportsThinking 邏輯保持同步）
      // 注意：本檔位於 TS template literal 內，regex 中的反斜線需用 \\ 雙跳脫
      function modelSupportsThinking(modelId, label) {
        function check(s) {
          if (!s) return false;
          var raw = String(s).toLowerCase();
          // strip provider prefixes and ollama multi-server encoding
          raw = raw.replace(/^copilot::/, '');
          if (raw.indexOf('openai::') === 0) { var pp = raw.indexOf('||'); raw = pp !== -1 ? raw.slice(pp + 2) : raw.slice(8); }
          var sp = raw.indexOf('||'); if (sp !== -1) raw = raw.slice(sp + 2);
          if (raw.charAt(0) === '[') { var rb = raw.indexOf(']'); if (rb !== -1) raw = raw.slice(rb + 1).replace(/^\\s+/, ''); }
          // check for reasoning models (o1/o3/o4 series and thinking/reasoning keywords)
          if (raw.indexOf('thinking') !== -1 || raw.indexOf('reasoning') !== -1) return true;
          var _rm = raw.replace(/^[a-z0-9]+[/:._-]/, ''); // strip prefix for shortname check
          if (_rm.indexOf('o1') === 0 || _rm.indexOf('o3') === 0 || _rm.indexOf('o4') === 0) return true;
          if (raw.indexOf('/o1') !== -1 || raw.indexOf('/o3') !== -1 || raw.indexOf('/o4') !== -1) return true;
          if (raw.indexOf(':o1') !== -1 || raw.indexOf(':o3') !== -1 || raw.indexOf(':o4') !== -1) return true;
          // strip hf.co/<user>/ prefix and any path prefix for shortname check
          var m = raw;
          if (raw.indexOf('hf.co/') !== -1) { var hfSlash = raw.lastIndexOf('/'); m = hfSlash !== -1 ? raw.slice(hfSlash + 1) : raw; }
          else { var lastSlash = raw.lastIndexOf('/'); if (lastSlash !== -1) m = raw.slice(lastSlash + 1); }
          if (m.indexOf('coder') !== -1 || m.indexOf('-instruct') !== -1 || m.indexOf(':instruct') !== -1) return false;
          return m.indexOf('deepseek-r1') === 0 || m.indexOf('deepseek-r2') === 0 ||
            m.indexOf('qwq') === 0 ||
            (m.indexOf('qwen3') === 0 && m.indexOf('coder') === -1) ||
            m.indexOf(':thinking') !== -1 || m.indexOf('-thinking') !== -1 ||
            m.indexOf('think') !== -1 || m.indexOf('-r1') !== -1 || m.indexOf(':r1') !== -1 ||
            m.indexOf('r1-') !== -1 || /^r1[:.-]/.test(m);
        }
        return check(modelId) || check(label);
      }

      function applyProviderInfo(providerInfo) {
        if (!providerInfo) return;
        _providerInfo = {
          id: providerInfo.id || inferProviderFromModelId(providerInfo.modelId),
          label: providerInfo.label || '',
          modelId: providerInfo.modelId || '',
          displayName: providerInfo.displayName || ''
        };
        document.body.dataset.provider = _providerInfo.id || 'ollama';
        var badge = document.getElementById('providerBadge');
        if (badge) {
          var meta = getProviderAppearance(_providerInfo.id);
          badge.dataset.provider = _providerInfo.id;
          badge.textContent = meta.icon + ' ' + (_providerInfo.label || meta.label);
          badge.title = (_providerInfo.displayName ? _providerInfo.displayName + ' · ' : '') + (_providerInfo.label || meta.label);
        }
      }

      function normalizeModelItems(msg) {
        if (msg.models && msg.models.length && typeof msg.models[0] === 'object' && msg.models[0].provider) {
          return msg.models.map(function(m) {
            return {
              id: m.id,
              label: m.label,
              provider: m.provider,
              providerLabel: m.providerLabel || getProviderAppearance(m.provider).label,
              multiplier: m.multiplier || ''
            };
          });
        }
        var normalized = [];
        (msg.models || []).forEach(function(m) {
          normalized.push({
            id: typeof m === 'string' ? m : m.id,
            label: typeof m === 'string' ? m : m.label,
            provider: 'ollama',
            providerLabel: 'Ollama',
            multiplier: ''
          });
        });
        (msg.copilotModels || []).forEach(function(cm) {
          normalized.push({
            id: 'copilot::' + cm.id,
            label: cm.name,
            provider: 'copilot',
            providerLabel: 'Copilot',
            multiplier: cm.multiplier || ''
          });
        });
        return normalized;
      }

      function decorateProviderLabel(model, includeMultiplier) {
        var meta = getProviderAppearance(model.provider);
        return meta.icon + ' ' + model.label + (includeMultiplier && model.multiplier ? '  ' + model.multiplier : '');
      }

      function setInteractionMode(mode, shouldFetchModels) {
        agentMode = mode === 'agent';
        teamMode = mode === 'team';
        compareMode = mode === 'compare';
        debateMode = mode === 'debate';
        var modeSelect = document.getElementById('modeSelect');
        if (modeSelect && modeSelect.value !== mode) { modeSelect.value = mode; }
        var teamPicker = document.getElementById('teamPicker');
        var comparePicker = document.getElementById('comparePicker');
        var debatePicker = document.getElementById('debatePicker');
        if (teamPicker) teamPicker.classList.toggle('visible', teamMode);
        if (comparePicker) comparePicker.classList.toggle('visible', compareMode);
        if (debatePicker) debatePicker.classList.toggle('visible', debateMode);
        var sendHint = cfgSendKey === 'Ctrl+Enter' ? 'Ctrl+Enter 送出' : 'Enter 送出';
        if (prompt) {
          prompt.placeholder = agentMode
            ? '輸入任務… Agent 會自動使用工具 (' + sendHint + ')'
            : teamMode
              ? '輸入問題… 所選 AI 會同時回答 (' + sendHint + ')'
              : compareMode
                ? '輸入問題… 多個 AI 並排回答 (' + sendHint + ')'
                : debateMode
                  ? '輸入議題或任務… (' + sendHint + ')'
                  : '輸入訊息… (' + sendHint + (cfgSendKey === 'Ctrl+Enter' ? ' / Enter 換行' : ' / Ctrl+Enter 換行') + ')';
        }
        if (sendBtn) {
          sendBtn.title = agentMode
            ? '送出任務給 Agent (' + sendHint + ')'
            : '送出訊息 (' + sendHint + ')';
        }
        if (statusBar) {
          statusBar.textContent = agentMode
            ? '🤖 Agent 模式 — AI 可自動讀寫檔案、執行命令'
            : teamMode
              ? '👥 選擇團隊成員後輸入問題'
              : compareMode
                ? '🆚 選擇比較模型後輸入問題'
                : debateMode
                  ? '⚔️ 對話模式：選 2 個 AI 辩論，可加第 3 個裁判'
                  : '💬 Ask 模式 — 直接對話，不使用工具';
        }
        if (shouldFetchModels && (teamMode || compareMode || debateMode)) {
          vscode.postMessage({ type: 'fetchTeamModels' });
        }
      }

      // ── 訊息處理 (最先掛上，避免後續程式碼拋例外導致 listener 遺失) ──────
      window.addEventListener('message', function(event) {
        try {
          const msg = event.data;
          dbg('MSG: ' + msg.type + (msg.ok !== undefined ? ' ok=' + msg.ok : '') + (msg.url ? ' url=' + msg.url : '') + (msg.message ? ' msg=' + msg.message : ''));
          if (debugPanel && debugPanel.style.display === 'block') { debugPanel.textContent = window._debugLog.join('\\n'); debugPanel.scrollTop = debugPanel.scrollHeight; }
          if (msg.type === 'assistant')          { clearPendingBubble(); _agentStepNode = null; _streamNode = null; setSendEnabled(true); appendMessage('assistant', msg.text, msg.thinking, msg.tokens); if (statusBar && msg.tokens) { var _aML = agentMode ? '\uD83E\uDD16 Agent \u6A21\u5F0F' : (teamMode ? '\uD83D\uDC65 Team \u6A21\u5F0F' : '\uD83D\uDCAC Ask \u6A21\u5F0F'); statusBar.textContent = _aML + '\u2003\u2014\u2003~' + msg.tokens + ' tokens'; } }
          else if (msg.type === 'streamStart')   { setBreathState(true); if (msg.thinking !== false) { startStreamThinkingPlaceholder(); } else { clearPendingBubble(); getOrCreateStreamNode(); } }
          else if (msg.type === 'thinkChunk')    { clearStreamThinkingPlaceholder(); appendThinkChunk(msg.chunk, msg.model); }
          else if (msg.type === 'assistantChunk'){ clearStreamThinkingPlaceholder(); appendChunk(msg.chunk); }
          else if (msg.type === 'streamAbort')   { setBreathState(false); clearStreamThinkingPlaceholder(); if (_streamNode && chat.contains(_streamNode)) { _streamNode.remove(); } _streamNode = null; }
          else if (msg.type === 'streamEnd')     { setBreathState(false); clearStreamThinkingPlaceholder(); _agentStepNode = null; setSendEnabled(true);
            var _sbE = _streamNode && chat.contains(_streamNode) ? _streamNode.querySelector('.bubble') : null;
            if (_sbE) {
              var _tb = _sbE.querySelector('.stream-token-badge');
              if (!_tb) { _tb = document.createElement('span'); _tb.className = 'stream-token-badge'; _tb.style.cssText = 'font-size:10px;opacity:0.5;margin-top:3px;display:block'; _sbE.appendChild(_tb); }
              if (_lastStreamTokens) {
                _tb.textContent = '~' + _lastStreamTokens + ' tokens  ' + _lastStreamTps.toFixed(1) + ' t/s';
              } else {
                // eval_count 未回傳時，依字元類型估算（CJK ≈ 1 token, ASCII ≈ 4 chars/token）
                var _rb = _sbE.querySelector('.response-body');
                var _est = 0;
                if (_rb) { var _t = _rb.textContent || ''; for (var _ci = 0; _ci < _t.length; _ci++) { _est += _t.codePointAt(_ci) > 0x2E7F ? 1 : 0.25; } _est = Math.max(1, Math.ceil(_est)); }
                if (!_est) { var _thinkPre = _sbE.querySelector('details.think pre.think-stream'); if (_thinkPre) { var _tt = _thinkPre.textContent || ''; for (var _tk = 0; _tk < _tt.length; _tk++) { _est += _tt.codePointAt(_tk) > 0x2E7F ? 1 : 0.25; } _est = Math.max(1, Math.ceil(_est)); } }
                if (_est) _tb.textContent = '\u2248' + _est + ' tokens (\u4f30\u7b97)';
              }
            }
            // 串流結束後重新渲染 response-body 為 Markdown
            if (_sbE) { rerenderBubbleMd(_sbE); }
            // 更新 statusBar 顯示 token 資訊
            if (statusBar) {
              var _modeLabel = agentMode ? '\uD83E\uDD16 Agent \u6A21\u5F0F' : (teamMode ? '\uD83D\uDC65 Team \u6A21\u5F0F' : '\uD83D\uDCAC Ask \u6A21\u5F0F');
              var _tokText = '';
              if (_lastStreamTokens) {
                _tokText = '~' + _lastStreamTokens + ' tokens  ' + _lastStreamTps.toFixed(1) + ' t/s';
              } else if (_sbE) {
                var _rbStat = _sbE.querySelector('.response-body');
                var _estStat = 0;
                if (_rbStat) { var _ts = _rbStat.textContent || ''; for (var _cj = 0; _cj < _ts.length; _cj++) { _estStat += _ts.codePointAt(_cj) > 0x2E7F ? 1 : 0.25; } _estStat = Math.max(1, Math.ceil(_estStat)); }
                if (!_estStat) { var _thinkPre2 = _sbE.querySelector('details.think pre.think-stream'); if (_thinkPre2) { var _tt2 = _thinkPre2.textContent || ''; for (var _tk2 = 0; _tk2 < _tt2.length; _tk2++) { _estStat += _tt2.codePointAt(_tk2) > 0x2E7F ? 1 : 0.25; } _estStat = Math.max(1, Math.ceil(_estStat)); } }
                if (_estStat) _tokText = '\u2248' + _estStat + ' tokens (\u4f30\u7b97)';
              }
              if (_tokText) {
                _lastTokenInfo = _modeLabel + '\u2003\u2014\u2003' + _tokText;
                statusBar.textContent = _lastTokenInfo;
              }
            }
            _streamNode = null; _lastStreamTokens = 0; _lastStreamTps = 0;
          }
          else if (msg.type === 'streamStats')   {
            _lastStreamTokens = msg.tokens; _lastStreamTps = msg.tps;
            var _sb = _streamNode && chat.contains(_streamNode) ? _streamNode.querySelector('.bubble') : null;
            if (_sb) {
              var _det = _sb.querySelector('details.think');
              if (_det) { var _lbl = _det.querySelector('.think-label'); var _secs = _det._thinkEnd ? Math.round((_det._thinkEnd - (_det._thinkStart||_det._thinkEnd)) / 1000) : 0; if (_lbl) _lbl.textContent = '\\uD83E\\uDDE0 \u601d\u8003\u904e\u7a0b (' + msg.tokens + ' tokens, \u8017\u6642 ' + _secs + 's, ' + msg.tps.toFixed(1) + ' t/s)'; }
              var _tb2 = _sb.querySelector('.stream-token-badge'); if (!_tb2) { _tb2 = document.createElement('span'); _tb2.className = 'stream-token-badge'; _tb2.style.cssText = 'font-size:10px;opacity:0.5;margin-top:3px;display:block'; _sb.appendChild(_tb2); } _tb2.textContent = '~' + msg.tokens + ' tokens  ' + msg.tps.toFixed(1) + ' t/s';
            }
          }
          else if (msg.type === 'error')         { clearPendingBubble(); _agentStepNode = null; _streamNode = null; setSendEnabled(true); appendMessage('assistant', '\u932f\u8aa4\uff1a' + msg.text); }
          else if (msg.type === 'organizePhotosPicked') { appendMessage('user', msg.label); vscode.postMessage({ type: 'agentSend', prompt: msg.prompt, model: modelSelect ? modelSelect.value : undefined, sessionId: _activeChatSessionId }); setSendEnabled(false); appendLoadingBubble(); }
          else if (msg.type === 'teamMemberStart') { createTeamMember(msg.id, msg.model, msg.color, msg.task); }
          else if (msg.type === 'teamThinkChunk')  { appendTeamThinkChunk(msg.id, msg.color, msg.chunk); }
          else if (msg.type === 'teamResponseChunk'){ appendTeamResponseChunk(msg.id, msg.chunk); }
          else if (msg.type === 'teamMemberEnd')   { finalizeTeamMember(msg.id); }
          else if (msg.type === 'teamOrchestratorStart') { createOrchestratorBubble(msg.model); }
          else if (msg.type === 'teamOrchestratorThinkChunk') { appendOrchestratorThinkChunk(msg.chunk); }
          else if (msg.type === 'teamOrchestratorChunk') { appendOrchestratorChunk(msg.chunk); }
          else if (msg.type === 'teamOrchestratorEnd')   { finalizeOrchestratorBubble(); }
          else if (msg.type === 'teamRoundStart')        { startTeamRound(msg.id, msg.round); }
          else if (msg.type === 'teamRoundReviewStart')  { startTeamReview(msg.id); }
          else if (msg.type === 'teamRoundReviewChunk')  { appendTeamReviewChunk(msg.id, msg.chunk); }
          else if (msg.type === 'teamRoundDone')         { finalizeTeamRound(msg.id, msg.approved); }
          else if (msg.type === 'teamTodoListStart') { createTeamTodoListBubble(); }
          else if (msg.type === 'teamTodoListChunk')  { appendTeamTodoListChunk(msg.chunk); }
          else if (msg.type === 'teamTodoListEnd')    { /* bubble stays */ }
          else if (msg.type === 'teamSynthStart')  { createTeamSynthBubble(); }
          else if (msg.type === 'teamSynthChunk')  { appendTeamSynthChunk(msg.chunk); }
          else if (msg.type === 'teamEnd')         { if (!msg.agentFollows) { setSendEnabled(true); if (statusBar) statusBar.textContent = '\u5718隊討論完成'; } else { if (statusBar) statusBar.textContent = '\u5718隊討論完成，交棒給 Agent\u2026'; } }
          else if (msg.type === 'teamAgentStart')  { var tah = document.createElement('div'); tah.className = 'team-agent-header'; tah.textContent = '\uD83E\uDD16 Agent \u63A5\u529B\u57F7\u884C\u8A08\u5283\uFF08' + (msg.model||'') + '\uFF09'; chat.appendChild(tah); chat.scrollTop = chat.scrollHeight; }
          else if (msg.type === 'teamModelList')   { populateTeamPicker(msg.models); populateDebatePicker(msg.models); populateComparePicker(msg.models); }
          else if (msg.type === 'teamRolesConfig') { if (msg.roles && msg.roles.length) _teamRolesConfig = msg.roles; }
          else if (msg.type === 'teamTodoList')  { createTodoPanel(msg.tasks); }
          else if (msg.type === 'teamTodoStart') { updateTodo(msg.idx, 'running', msg.worker); }
          else if (msg.type === 'teamTodoDone')  { updateTodo(msg.idx, 'done'); }
          else if (msg.type === 'debateStart')   { _debateRunning = true; var _dsBar = document.getElementById('debateSwapBar'); if (_dsBar) _dsBar.style.display = 'flex'; createDebateHeader(msg.labelA, msg.labelB, msg.labelJ, msg.colorA, msg.colorB, msg.colorJ, msg.gameType, msg.speakerLabels, msg.speakerColors); }
          else if (msg.type === 'debateTurnStart') { startDebateTurn(msg.speaker, msg.round, msg.label, msg.color); }
          else if (msg.type === 'debateChunk')   { appendDebateChunk(msg.speaker, msg.chunk); }
          else if (msg.type === 'debateThinkChunk') { appendDebateThinkChunk(msg.speaker, msg.chunk); }
          else if (msg.type === 'debateTurnEnd') { finalizeDebateTurn(msg.speaker, msg.tokens, msg.tps); }
          else if (msg.type === 'debateEnd')     { _debateRunning = false; var _dsBar2 = document.getElementById('debateSwapBar'); if (_dsBar2) _dsBar2.style.display = 'none'; finalizeDebate(msg.consensus); setSendEnabled(true); if (statusBar) statusBar.textContent = '\u2694\ufe0f \u5c0d\u8a71\u7d50\u675f'; }
          else if (msg.type === 'agentStatus')   {
            if (msg.running) {
              setBreathState(true);
              if (statusBar) statusBar.textContent = '\u2699\ufe0f Agent \u57f7\u884c\u4e2d\u2026';
              _lastTokenInfo = '';
            } else {
              setBreathState(false);
              if (statusBar) statusBar.textContent = _lastTokenInfo || (agentMode ? '\ud83e\udd16 Agent \u6a21\u5f0f' : '');
            }
            setSendEnabled(!msg.running);
          }
          else if (msg.type === 'agentStep')     { appendAgentStep(msg.icon, msg.title, msg.fullPath); }
          else if (msg.type === 'agentStepDone') { finalizeAgentStep(msg.result, msg.isError); }
          else if (msg.type === 'agentStepProgress') {
            // 輕量級進度訊息：直接更新狀態列，不建立新氣泡
            if (statusBar && typeof msg.text === 'string') { statusBar.textContent = msg.text; }
          }
          else if (msg.type === 'agentTodoUpdate') { renderAgentTodos(msg.todos); }
          else if (msg.type === 'shadowStateUpdate') {
            _shadowSessionActive = (msg.state && msg.state.status !== 'idle' && msg.state.status !== 'committed' && msg.state.status !== 'rolled_back');
            renderShadowPanel(msg.state);
          }
          else if (msg.type === 'permissionRequest') { showPermissionBar(msg.category, msg.description, msg.forceConfirm, msg.diff); }
          else if (msg.type === 'fileModified') {
            _fileMods.unshift({ filePath: msg.filePath, op: msg.op, ts: msg.ts || Date.now(), linesAdded: msg.linesAdded, linesRemoved: msg.linesRemoved, patch: msg.patch || '' });
            if (_fileMods.length > 100) { _fileMods.pop(); }
            renderFileMods();
            if (fileModBtn && !fileModPanel.classList.contains('visible')) {
              fileModBtn.classList.add('active');
            }
            // 無 shadow session 時，用普通寫檔檔案更新 compact bar 並自動展開 fileModPanel
            if (!_shadowSessionActive) {
              renderShadowPanel({
                status: 'staging',
                shadowDir: '',
                files: _fileMods.map(function(m) {
                  return { original: m.filePath, shadow: m.shadow || m.filePath, op: m.op || 'write', verified: true, linesAdded: m.linesAdded||0, linesRemoved: m.linesRemoved||0 };
                })
              });
              // 自動彈出 fileModPanel
              if (fileModPanel && !fileModPanel.classList.contains('visible')) {
                fileModPanel.classList.add('visible');
                if (fileModBtn) fileModBtn.classList.add('active');
              }
            }
          }
          else if (msg.type === 'waQrCode') {
            var _wqm = document.getElementById('waQrModal');
            var _wqi = document.getElementById('waQrImg');
            var _wqmsg = document.getElementById('waQrMsg');
            if (_wqm) _wqm.classList.add('visible');
            if (_wqi) {
              if (msg.imgDataUrl) { _wqi.src = msg.imgDataUrl; _wqi.style.display = 'block'; }
              else { _wqi.style.display = 'none'; }
            }
            if (_wqmsg) _wqmsg.textContent = msg.statusMsg ||
              (msg.imgDataUrl ? '✅ QR Code 已生成，請用 WhatsApp 手機掃描（60 秒內有效）' : '⏳ 生成 QR Code 中，請稍候…');
          }
          else if (msg.type === 'waConnected') {
            var _wqm2 = document.getElementById('waQrModal');
            if (_wqm2) _wqm2.classList.remove('visible');
            var _wsb = document.getElementById('waStatusBar');
            if (_wsb) _wsb.classList.add('visible');
            var _wpn = document.getElementById('waPhoneNum');
            if (_wpn && msg.phone) _wpn.textContent = msg.phone;
          }
          else if (msg.type === 'waDisconnected') {
            var _wqm3 = document.getElementById('waQrModal');
            if (_wqm3) _wqm3.classList.remove('visible');
            var _wsb2 = document.getElementById('waStatusBar');
            if (_wsb2) _wsb2.classList.remove('visible');
          }
          else if (msg.type === 'waIncoming') {
            appendMessage('assistant', '\uD83D\uDCF2 WhatsApp \u4f86\u81ea \u300c' + (msg.sender||'') + '\u300d\uff1a ' + (msg.text||''));
          }
          else if (msg.type === 'autoStatus')    { if (statusBar) statusBar.textContent = msg.running ? '\u23f3 \u81ea\u52d5\u57f7\u884c\u4e2d\u2026' : ''; setSendEnabled(!msg.running); }
          else if (msg.type === 'autoPaused')    { appendMessage('assistant', '\u5df2\u6682\u505c\uff0c\u9700\u5b58\u53d6 ' + (msg.path || '\u672a\u77e5\u8def\u5f91')); if (statusBar) statusBar.textContent = '\u23f8 \u6682\u505c'; }
          else if (msg.type === 'streamMode')    { const t = document.getElementById('toggleStream'); streamMode = !!msg.enabled; if (t) t.classList.toggle('active', streamMode); }
          else if (msg.type === 'autoPilotState'){ if (permModeSelect) { applyPermModeFromFlags(!!msg.enabled, permModeSelect.value === 'yolo'); } }
          else if (msg.type === 'thinkLevelState'){ setThinkLevelUi(msg.level); }
          else if (msg.type === 'contextDepthState'){ setContextDepthUi(msg.depth); }
          // ── 外部觸發（extension → webview）：顯示使用者訊息泡泡並轉發給 extension 執行 ──
          else if (msg.type === 'externalAgentSend') {
            var _extPrompt = String(msg.prompt || '');
            if (!_extPrompt) { return; }
            appendMessage('user', _extPrompt);
            setInteractionMode('agent', false);
            var _extModel = modelSelect ? modelSelect.value : undefined;
            vscode.postMessage({ type: 'agentSend', prompt: _extPrompt, model: _extModel, sessionId: _activeChatSessionId });
          }
          else if (msg.type === 'modelList')     {
            var normalizedModels = normalizeModelItems(msg);
            dbg('modelList received: ' + normalizedModels.length + ' models');
            updateModelSelect(normalizedModels, msg.current);
            applyProviderInfo(msg.providerInfo || { modelId: msg.current, id: inferProviderFromModelId(msg.current) });
            if (normalizedModels.length) { populateTeamPicker(normalizedModels); populateDebatePicker(normalizedModels); populateComparePicker(normalizedModels); }
          }
          else if (msg.type === 'initialState')  { if (msg.providerInfo) applyProviderInfo(msg.providerInfo); if (msg.streamMode) { streamMode = true; var ts = document.getElementById('toggleStream'); if (ts) ts.classList.add('active'); } applyPermModeFromFlags(!!msg.autoPilotEnabled, !!msg.autoApproveWrite); if (msg.thinkLevel) setThinkLevelUi(msg.thinkLevel); if (msg.contextDepth) setContextDepthUi(msg.contextDepth); if (Array.isArray(msg.shadowTriggerKeywords)) { var skEl = document.getElementById('shadowKeywordsInput'); if (skEl) skEl.value = msg.shadowTriggerKeywords.join(', '); } }
          else if (msg.type === 'providerInfo')  { applyProviderInfo(msg.providerInfo); }
          else if (msg.type === 'connectionStatus') { dbg('connectionStatus received ok=' + msg.ok + ' url=' + msg.url); updateConnStatus(msg.ok, msg.url, msg.message); }
          else if (msg.type === 'fileAttached')  { addFileChip(msg.name, msg.content); }
          else if (msg.type === 'memoryLoaded')  { onMemoryLoaded(msg); }
          else if (msg.type === 'memorySaved')   { var slb = document.getElementById('saveLtmBtn'); if (slb) { slb.textContent = '\u2713 \u5df2\u5132\u5b58'; setTimeout(function() { slb.textContent = '\uD83D\uDCBE \u5132\u5b58\u9577\u671f\u8a18\u61b6'; }, 1500); } }
          else if (msg.type === 'contextPercent') {
            var _cb = document.getElementById('contextBar');
            if (_cb) {
              var _pct = Math.min(msg.pct || 0, 100);
              var _fillColor = _pct < 50 ? '#4ec9b0' : _pct < 75 ? '#dcdcaa' : _pct < 90 ? '#ce9178' : '#f44747';
              var _fill = _cb.querySelector('.ctx-fill');
              var _pctEl = _cb.querySelector('.ctx-pct');
              if (_fill) { _fill.style.width = _pct + '%'; _fill.style.background = _fillColor; }
              if (_pctEl) {
                // 格式化 token 數為 K/M 可讀格式
                function fmtTok(n) {
                  if (n < 1000) return String(n);
                  if (n < 1000000) return (n < 10000 ? (n/1000).toFixed(1) : Math.round(n/1000)) + 'K';
                  return (n < 10000000 ? (n/1000000).toFixed(1) : Math.round(n/1000000)) + 'M';
                }
                _pctEl.textContent = Math.round(_pct) + '% (~' + fmtTok(msg.tokens || 0) + '/' + fmtTok(msg.threshold || 8000) + ' tok)';
              }
            }
          }
          else if (msg.type === 'historyCount')  { if (!msg.sessionId || msg.sessionId === _activeChatSessionId) { var hii = document.getElementById('historyInfo'); if (hii) hii.textContent = '\u5c0d\u8a71\u6b77\u53f2\uff1a' + (msg.count || 0) + ' \u689d\u8a0a\u606f'; } }
          else if (msg.type === 'consolidateStart') { var cs = document.getElementById('consolidateStatus'); if (cs) { cs.style.display = ''; cs.textContent = '\u2699\ufe0f AI \u6574\u7406\u4e2d\u2026'; } var clb = document.getElementById('consolidateLtmBtn'); if (clb) clb.disabled = true; }
          else if (msg.type === 'consolidateChunk') { var cs2 = document.getElementById('consolidateStatus'); if (cs2) cs2.textContent = '\u2699\ufe0f AI \u6574\u7406\u4e2d\u2026 ' + (msg.chunk || '').slice(0, 40); }
          else if (msg.type === 'usageUpdate') { renderUsageTable(msg.stats); renderStatsUsageTable(msg.stats); }
          else if (msg.type === 'latencyUpdate') { renderLatencyChart(msg.log); }
          else if (msg.type === 'consolidateDone') {
            var clb2 = document.getElementById('consolidateLtmBtn'); if (clb2) clb2.disabled = false;
            var cs3 = document.getElementById('consolidateStatus');
            if (msg.error) { if (cs3) { cs3.style.display = ''; cs3.textContent = '\u274c \u6574\u7406\u5931\u6557\uff1a' + msg.error; } }
            else if (msg.skipped) { if (cs3) { cs3.style.display = ''; cs3.textContent = '\u26a0\ufe0f \u5c0d\u8a71\u6b77\u53f2\u70ba\u7a7a\uff0c\u7121\u9700\u6574\u7406'; } }
            else { if (cs3) { cs3.style.display = ''; cs3.textContent = '\u2713 \u5df2\u6574\u7406\u4e26\u5132\u5b58\u5230\u9577\u671f\u8a18\u61b6'; } var a2 = document.getElementById('ltmArea'); if (a2) a2.value = msg.ltm || ''; renderLtmEntries(); chat.innerHTML = ''; _streamNode = null; _agentStepNode = null; _pendingBubble = null; saveActiveSessionSnapshot(); var hp2 = document.getElementById('historyPreview'); if (hp2) hp2.value = '（已整理並清除）'; var hii2 = document.getElementById('historyInfo'); if (hii2) hii2.textContent = '對話歷史：0 條訊息'; }
          }
          // --- Messages FROM extension host (sidebar commands) ---
          else if (msg.type === 'newChatSession') { createNewSession(); }
          else if (msg.type === 'switchChatSessionFromHost') { if (msg.sessionId) switchChatSession(msg.sessionId); }
          else if (msg.type === 'renameChatSessionFromHost') {
            var rnSess = null;
            for (var ri2 = 0; ri2 < _chatSessions.length; ri2++) { if (_chatSessions[ri2].id === msg.sessionId) { rnSess = _chatSessions[ri2]; break; } }
            if (rnSess && msg.title) { rnSess.title = msg.title; rnSess.manualTitle = true; renderChatSessionSelect(); persistSessionState(); }
          }
          else if (msg.type === 'deleteChatSessionFromHost') {
            var delHostId = msg.sessionId;
            if (!delHostId) return;
            if (_chatSessions.length <= 1) {
              chat.innerHTML = ''; _streamNode = null; _agentStepNode = null; _pendingBubble = null;
              vscode.postMessage({ type: 'clearHistory', sessionId: delHostId });
              _chatSessions = [];
              _activeChatSessionId = null;
              createNewSession();
            } else {
              _chatSessions = _chatSessions.filter(function(s) { return s.id !== delHostId; });
              vscode.postMessage({ type: 'deleteSession', sessionId: delHostId });
              if (_activeChatSessionId === delHostId) {
                _activeChatSessionId = _chatSessions[_chatSessions.length - 1].id;
                var delNext = getActiveSession();
                resetTransientNodes();
                chat.innerHTML = (delNext && delNext.html) || '';
                clearFiles();
                vscode.postMessage({ type: 'switchChatSession', sessionId: _activeChatSessionId });
              }
              renderChatSessionSelect();
              persistSessionState();
            }
          }
          else if (msg.type === 'exportDone')   { if (statusBar) statusBar.textContent = '\u2705 \u5df2\u532f\u51fa: ' + (msg.path || ''); setTimeout(function() { if (statusBar && statusBar.textContent.startsWith('\u2705 \u5df2\u532f\u51fa')) statusBar.textContent = ''; }, 3000); }
          else if (msg.type === 'importDone')   {
            _chatSeq += 1;
            var iSess = { id: msg.sessionId, title: msg.title || '\u532f\u5165\u5c0d\u8a71', html: '', manualTitle: true };
            _chatSessions.push(iSess);
            switchChatSession(msg.sessionId);
            if (statusBar) statusBar.textContent = '\u2705 \u5df2\u532f\u5165: ' + iSess.title;
            setTimeout(function() { if (statusBar && statusBar.textContent.startsWith('\u2705 \u5df2\u532f\u5165')) statusBar.textContent = ''; }, 3000);
          }
          else if (msg.type === 'searchResults') {
            if (!chatSearchResults) return;
            chatSearchResults.innerHTML = '';
            if (!msg.results || !msg.results.length) {
              chatSearchResults.style.display = '';
              chatSearchResults.innerHTML = '<div style="padding:4px 8px;opacity:0.6;font-size:11px">\u7121\u7b26\u5408\u7d50\u679c</div>';
              return;
            }
            chatSearchResults.style.display = '';
            msg.results.forEach(function(r) {
              // \u5c0d\u6620 session title
              var titleLabel = r.title;
              for (var si = 0; si < _chatSessions.length; si++) { if (_chatSessions[si].id === r.sessionId) { titleLabel = _chatSessions[si].title || r.sessionId; break; } }
              var row = document.createElement('div'); row.className = 'search-hit';
              row.innerHTML = '<div class="search-hit-title">' + titleLabel + '</div><div class="search-hit-snippet">' + r.snippet.replace(/</g,'&lt;') + '</div>';
              row.addEventListener('click', function() {
                switchChatSession(r.sessionId);
                if (chatSearchBar) chatSearchBar.style.display = 'none';
                if (chatSearchResults) chatSearchResults.style.display = 'none';
              });
              chatSearchResults.appendChild(row);
            });
          }
          // \u5c0d\u8a71\u5206\u652f\u5b8c\u6210 \u2014 \u5728\u524d\u7aef\u5efa\u7acb\u65b0\u5c0d\u8a71\u5206\u652f
          else if (msg.type === 'forkSessionDone') {
            saveActiveSessionSnapshot();
            _chatSeq += 1;
            var forkId = msg.sessionId;
            var forkSess = { id: forkId, title: '\uD83C\uDF3F \u5206\u652f ' + _chatSeq, html: msg.forkHtml || '', manualTitle: false };
            _chatSessions.push(forkSess);
            _activeChatSessionId = forkId;
            resetTransientNodes();
            chat.innerHTML = forkSess.html || '';
            _userMsgCount = chat.querySelectorAll('.msg.user').length;
            clearFiles();
            renderChatSessionSelect();
            vscode.postMessage({ type: 'switchChatSession', sessionId: forkId });
            persistSessionState();
            if (statusBar) statusBar.textContent = '\uD83C\uDF3F \u5df2\u5efa\u7acb\u5206\u652f\u5c0d\u8a71';
            setTimeout(function() { if (statusBar && statusBar.textContent.startsWith('\uD83C\uDF3F')) statusBar.textContent = ''; }, 3000);
          }
          // \u5c1a\u7126\u8f38\u5165\u6846\uff08\u5feb\u6377\u9375 Ctrl+L\uff09
          else if (msg.type === 'focusInput') { var pEl = document.getElementById('prompt'); if (pEl) pEl.focus(); }
          // 模型管理
          else if (msg.type === 'ollamaModelsForManage') { if (window._onOllamaModelsForManage) window._onOllamaModelsForManage(msg.servers); }
          else if (msg.type === 'ollamaModelDeleted')    { if (window._onOllamaModelDeleted) window._onOllamaModelDeleted(msg.model); }
          else if (msg.type === 'ollamaModelDeleteError'){ if (window._onOllamaModelDeleteError) window._onOllamaModelDeleteError(msg.model, msg.error); }
          else if (msg.type === 'ollamaModelPullProgress'){ if (window._onOllamaModelPullProgress) window._onOllamaModelPullProgress(msg.model, msg.status, msg.pct); }
          else if (msg.type === 'ollamaModelPulled')     { if (window._onOllamaModelPulled) window._onOllamaModelPulled(msg.model); }
          else if (msg.type === 'ollamaModelPullError')  { if (window._onOllamaModelPullError) window._onOllamaModelPullError(msg.model, msg.error); }
        } catch(e) { dbg('CATCH: ' + (e && e.message ? e.message : String(e))); }
      });

      const chat = document.getElementById('chat');
      const prompt = document.getElementById('prompt');
      const modelSelect = document.getElementById('modelSelect');
      let streamMode = false;
      let attachedFiles = [];
      let attachedImages = []; // [{dataUrl}] pasted images
      let _streamNode = null;
      let _lastStreamTokens = 0;
      let _lastStreamTps = 0;
      let _pendingBubble = null;
      let agentMode = true;
      let teamMode = false;
      let compareMode = false;
      let debateMode = false;
      let _debateRunning = false;
      let _agentStepNode = null;
      const _teamNodes = {}; // id -> { node, bubble, thinkNode, responseNode, charCount, thinkStart, thinkTimer }
      var _todosPanel = null;
      var _todoChecked = 0;
      var _agentTodosPanel = null;
      let _synthNode = null;
      let _orchestratorNode = null;
      let _orchestratorModel = '';
      let _teamAvailModels = []; // [{id, label, vendor}]
      var _teamRolesConfig = [
        { key: 'planner',   label: '規劃者', emoji: '🗺', color: '#f7a534', systemPrompt: '你的職責是「規劃者」：分析需求、制定解題架構、將任務拆分為有序步驟、確保整體方向正確。' },
        { key: 'developer', label: '開發者', emoji: '💻', color: '#4fc1ff', systemPrompt: '你的職責是「開發者」：撰寫程式碼、實作功能、提供具體技術解決方案、確保程式邏輯正確。' },
        { key: 'reviewer',  label: '評審員', emoji: '🔍', color: '#c586c0', systemPrompt: '你的職責是「評審員」：審查方案與程式碼品質、找出潛在問題與改進空間、以批判視角提高整體品質。' },
        { key: 'tester',    label: '測試員', emoji: '🧪', color: '#4ec9b0', systemPrompt: '你的職責是「測試員」：思考邊界情況、撰寫測試案例、找出可能的錯誤與漏洞、確保功能穩定性。' },
        { key: 'writer',    label: '撰寫者', emoji: '📝', color: '#89d185', systemPrompt: '你的職責是「撰寫者」：清晰解釋技術概念、撰寫說明文件、確保溝通明確易懂。' }
      ];
      const _debateNodes = {}; // speaker -> { node, body, thinkNode, thinkChars, thinkStart, thinkTimer }
      let _debateLabelA = '', _debateLabelB = '', _debateLabelJ = '';
      let _debateColorA = '#4fc1ff', _debateColorB = '#ce9178', _debateColorJ = '#89d185';
      let _speakerLabels = {}; // speaker key -> display label (supports N-model discussion)
      let _speakerColors = {}; // speaker key -> color

      const sendBtn = document.getElementById('sendBtn');
      const statusBar = document.getElementById('statusBar');
      const breathLight = document.getElementById('breathLight');
      function setBreathState(thinking) {
        if (!breathLight) return;
        if (thinking) breathLight.classList.add('thinking');
        else breathLight.classList.remove('thinking');
      }
      const chatSessionSelect = document.getElementById('chatSessionSelect');
      const newChatBtn = document.getElementById('newChat');
      const renameChatBtn = document.getElementById('renameChat');

      function defaultSessionState() {
        return { sessions: [{ id: 'default', title: '聊天 1', html: '', manualTitle: false }], activeId: 'default', seq: 1 };
      }

      const savedState = vscode.getState && vscode.getState();
      let _chatSessions = (savedState && Array.isArray(savedState.sessions) && savedState.sessions.length) ? savedState.sessions : defaultSessionState().sessions;
      let _activeChatSessionId = (savedState && savedState.activeId) ? savedState.activeId : 'default';
      let _chatSeq = (savedState && typeof savedState.seq === 'number') ? savedState.seq : 1;

      function getActiveSession() {
        for (var i = 0; i < _chatSessions.length; i++) {
          if (_chatSessions[i].id === _activeChatSessionId) return _chatSessions[i];
        }
        return null;
      }

      function persistSessionState() {
        if (!vscode.setState) return;
        vscode.setState({ sessions: _chatSessions, activeId: _activeChatSessionId, seq: _chatSeq });
        // Notify extension host (sidebar) of the current session list
        vscode.postMessage({
          type: 'notifySessionsChanged',
          sessions: _chatSessions.map(function(s) { return { id: s.id, title: s.title }; }),
          activeId: _activeChatSessionId
        });
      }

      function saveActiveSessionSnapshot() {
        var s = getActiveSession();
        if (!s) return;
        s.html = chat.innerHTML;
        persistSessionState();
      }

      function resetTransientNodes() {
        _streamNode = null; _agentStepNode = null; _pendingBubble = null; _agentTodosPanel = null;
        _synthNode = null; _orchestratorNode = null; _orchestratorModel = '';
        Object.keys(_teamNodes).forEach(function(k){ delete _teamNodes[k]; });
        Object.keys(_debateNodes).forEach(function(k){ delete _debateNodes[k]; });
      }

      function renderChatSessionSelect() {
        if (!chatSessionSelect) return;
        chatSessionSelect.innerHTML = '';
        _chatSessions.forEach(function(s) {
          var opt = document.createElement('option');
          var tags = (s.tags && s.tags.length) ? ' [' + s.tags.join(', ') + ']' : '';
          opt.value = s.id; opt.textContent = (s.title || s.id) + tags;
          if (s.id === _activeChatSessionId) opt.selected = true;
          chatSessionSelect.appendChild(opt);
        });
      }

      function switchChatSession(sessionId) {
        if (!sessionId) return;
        saveActiveSessionSnapshot();
        _activeChatSessionId = sessionId;
        var s = getActiveSession();
        if (!s) {
          _chatSeq += 1;
          s = { id: sessionId, title: '聊天 ' + _chatSeq, html: '', manualTitle: false };
          _chatSessions.push(s);
        }
        resetTransientNodes();
        chat.innerHTML = s.html || '';
        clearFiles();
        // 恢復該 session 的模型選擇
        if (s.model && modelSelect) {
          var found = false;
          for (var oi = 0; oi < modelSelect.options.length; oi++) {
            if (modelSelect.options[oi].value === s.model) { modelSelect.value = s.model; found = true; break; }
          }
          if (!found) { /* 模型已不存在，保留目前選擇 */ }
        }
        renderChatSessionSelect();
        vscode.postMessage({ type: 'switchChatSession', sessionId: _activeChatSessionId });
        persistSessionState();
      }

      function autoTitleFromPrompt(text) {
        var s = getActiveSession();
        if (!s || s.manualTitle) return;
        if (!s.title || /^聊天\s*\d+$/.test(s.title)) {
          var t = (text || '').replace(/\s+/g, ' ').trim();
          if (!t) return;
          s.title = t.length > 18 ? t.slice(0, 18) + '…' : t;
          renderChatSessionSelect();
          persistSessionState();
        }
      }

      function createNewSession() {
        saveActiveSessionSnapshot();
        _chatSeq += 1;
        var id = 'chat-' + Date.now() + '-' + _chatSeq;
        var s = { id: id, title: '聊天 ' + _chatSeq, html: '', manualTitle: false };
        _chatSessions.push(s);
        _activeChatSessionId = id;
        resetTransientNodes();
        chat.innerHTML = '';
        clearFiles();
        renderChatSessionSelect();
        vscode.postMessage({ type: 'switchChatSession', sessionId: _activeChatSessionId });
        persistSessionState();
      }

      function deleteActiveSession() {
        if (!window.confirm('確定刪除此聊天？')) return;
        var deletedId = _activeChatSessionId;
        console.log('[DEBUG] deleteActiveSession called. confirm passed, deletedId:', deletedId, 'Total sessions:', _chatSessions.length);

          console.log('[DEBUG] Last session branch triggered. Clearing all.');
        if (_chatSessions.length <= 1) {
          // 最後一個 session：全部清除，自動建立新空白 session
          chat.innerHTML = ''; _streamNode = null; _agentStepNode = null; _pendingBubble = null;
          vscode.postMessage({ type: 'clearHistory', sessionId: deletedId });
          _chatSessions = [];
          _activeChatSessionId = null;
          _chatSeq = 0;
          createNewSession();
          return;
        }

        console.log('[DEBUG] Normal deletion branch triggered. Filtering array...');
        _chatSessions = _chatSessions.filter(function(s) { return s.id !== deletedId; });
        console.log('[DEBUG] Filter complete. New length:', _chatSessions.length, 'Target ID was:', deletedId);
        vscode.postMessage({ type: 'deleteSession', sessionId: deletedId });
        _activeChatSessionId = _chatSessions[_chatSessions.length - 1].id;
        var next = getActiveSession();
        resetTransientNodes();
        chat.innerHTML = (next && next.html) || '';
        clearFiles();
        renderChatSessionSelect();
        vscode.postMessage({ type: 'switchChatSession', sessionId: _activeChatSessionId });
        persistSessionState();
      }

      function renameActiveSession() {
        var s = getActiveSession();
        if (!s) return;
        var title = window.prompt('請輸入聊天標題：', s.title || '');
        if (title === null) return;
        var t = title.trim();
        if (!t) return;
        s.title = t;
        s.manualTitle = true;
        // 標籤機能：詢問是否水設定標籤
        var tagInput = window.prompt('設定分類標籤（多個用逗號隔開，留空不變）：', (s.tags || []).join(', '));
        if (tagInput !== null) {
          var tags = tagInput.split(',').map(function(tg) { return tg.trim(); }).filter(function(tg) { return tg.length > 0; });
          s.tags = tags;
        }
        renderChatSessionSelect();
        persistSessionState();
      }

      renderChatSessionSelect();
      switchChatSession(_activeChatSessionId);
      if (chatSessionSelect) chatSessionSelect.addEventListener('change', function() { switchChatSession(chatSessionSelect.value); });
      if (newChatBtn) newChatBtn.addEventListener('click', function() { createNewSession(); });
      if (renameChatBtn) renameChatBtn.addEventListener('click', function() { renameActiveSession(); });
      var deleteChatBtn = document.getElementById('deleteChat');
      if (deleteChatBtn) deleteChatBtn.addEventListener('click', function() { deleteActiveSession(); });

      // 進階選項列展開/折疊
      var topBarToggle = document.getElementById('topBarToggle');
      var topBarAdvanced = document.getElementById('topBarAdvanced');
      if (topBarToggle && topBarAdvanced) {
        try { if (localStorage.getItem('amiClaw_topBarOpen') === '1') { topBarAdvanced.classList.add('open'); topBarToggle.classList.add('open'); topBarToggle.textContent = '⚙ ▴'; } } catch(e) {}
        topBarToggle.addEventListener('click', function() {
          var open = topBarAdvanced.classList.toggle('open');
          topBarToggle.classList.toggle('open', open);
          topBarToggle.textContent = open ? '⚙ ▴' : '⚙ ▾';
          try { localStorage.setItem('amiClaw_topBarOpen', open ? '1' : '0'); } catch(e) {}
        });
      }

      // \u532f\u51fa\u5c0d\u8a71
      var exportChatBtn = document.getElementById('exportChat');
      if (exportChatBtn) exportChatBtn.addEventListener('click', function() {
        var s = getActiveSession();
        var fmt = window.confirm('\u9078\u64c7\u532f\u51fa\u683c\u5f0f\uff1a\u78ba\u5b9a = JSON\uff0c\u53d6\u6d88 = Markdown') ? 'json' : 'markdown';
        vscode.postMessage({ type: 'exportChat', sessionId: _activeChatSessionId, title: s ? s.title : '\u5c0d\u8a71', format: fmt });
      });
      // \u532f\u5165\u5c0d\u8a71
      var importChatBtn = document.getElementById('importChat');
      if (importChatBtn) importChatBtn.addEventListener('click', function() {
        vscode.postMessage({ type: 'importChat' });
      });
      // \u641c\u5c0b\u5c0d\u8a71
      var searchChatBtnEl = document.getElementById('searchChatBtn');
      var chatSearchBar = document.getElementById('chatSearchBar');
      var chatSearchInput = document.getElementById('chatSearchInput');
      var chatSearchResults = document.getElementById('chatSearchResults');
      var chatSearchGo = document.getElementById('chatSearchGo');
      var chatSearchClose = document.getElementById('chatSearchClose');
      if (searchChatBtnEl) searchChatBtnEl.addEventListener('click', function() {
        if (chatSearchBar) chatSearchBar.style.display = chatSearchBar.style.display === 'flex' ? 'none' : 'flex';
        if (chatSearchResults) chatSearchResults.style.display = 'none';
        if (chatSearchInput) { chatSearchInput.value = ''; chatSearchInput.focus(); }
      });
      if (chatSearchClose) chatSearchClose.addEventListener('click', function() {
        if (chatSearchBar) chatSearchBar.style.display = 'none';
        if (chatSearchResults) chatSearchResults.style.display = 'none';
      });
      function doSearchConversations() {
        var q = chatSearchInput ? chatSearchInput.value.trim() : '';
        if (!q) return;
        vscode.postMessage({ type: 'searchConversations', query: q, sessions: _chatSessions.map(function(s) { return { id: s.id, title: s.title }; }) });
      }
      if (chatSearchGo) chatSearchGo.addEventListener('click', doSearchConversations);
      if (chatSearchInput) chatSearchInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') doSearchConversations(); });

      // auto-grow textarea
      function resizePrompt() {
        prompt.style.height = 'auto';
        prompt.style.height = Math.min(prompt.scrollHeight, 160) + 'px';
      }
      prompt.addEventListener('input', resizePrompt);
      // Slash command 自動完成
      prompt.addEventListener('input', function() {
        var v = prompt.value;
        if (v.startsWith('/') && v.indexOf('\\n') === -1) { showSlashPopup(v); } else { hideSlashPopup(); }
      });

      // ── 貼上影像 ──────────────────────────────────────────────────────────
      prompt.addEventListener('paste', function(e) {
        var items = e.clipboardData && e.clipboardData.items;
        if (!items) return;
        for (var i = 0; i < items.length; i++) {
          if (items[i].type.indexOf('image') !== -1) {
            e.preventDefault();
            var file = items[i].getAsFile();
            if (!file) continue;
            var reader = new FileReader();
            (function(f) {
              reader.onload = function(evt) { addImageChip(evt.target.result); setSendEnabled(true); };
            })(file);
            reader.readAsDataURL(file);
          }
        }
      });

      // ── Jira key auto-detect ──────────────────────────────────────────────
      var _jiraChips = document.createElement('div');
      _jiraChips.id = 'jiraChips';
      _jiraChips.style.cssText = 'display:none;padding:2px 6px 4px;display:flex;flex-wrap:wrap;gap:4px;';
      prompt.parentNode.insertBefore(_jiraChips, prompt);
      var _jiraKeyRe = /\b([A-Z][A-Z0-9]*-\d+)\b/g;
      prompt.addEventListener('input', function() {
        _jiraChips.innerHTML = '';
        var text = prompt.value;
        var keys = [];
        var m2;
        _jiraKeyRe.lastIndex = 0;
        while ((m2 = _jiraKeyRe.exec(text)) !== null) {
          if (keys.indexOf(m2[1]) === -1) keys.push(m2[1]);
        }
        if (keys.length === 0) { _jiraChips.style.display = 'none'; return; }
        _jiraChips.style.display = 'flex';
        keys.forEach(function(key) {
          var chip = document.createElement('button');
          chip.textContent = '\uD83C\uDFAB ' + key;
          chip.title = '\u958b\u555f Jira Issue: ' + key;
          chip.style.cssText = 'font-size:11px;padding:2px 8px;border-radius:10px;background:rgba(0,122,204,0.25);border:1px solid rgba(0,122,204,0.5);color:inherit;cursor:pointer;';
          chip.addEventListener('click', function() {
            vscode.postMessage({ type: 'agentSend', prompt: '\u5f9e Jira \u67e5\u770b Issue ' + key, model: modelSelect ? modelSelect.value : undefined });
          });
          _jiraChips.appendChild(chip);
        });
      });

      // ── 送出 helper ──────────────────────────────────────────────────────
      function appendLoadingBubble() {
        if (_pendingBubble) { _pendingBubble.remove(); _pendingBubble = null; }
        const node = document.createElement('div'); node.className = 'msg assistant';
        const bub = document.createElement('div'); bub.className = 'bubble';
        // 更積極地回報忙線：顯示明確的提示文字
        const statusText = document.createElement('span');
        statusText.style.display = 'block';
        statusText.style.fontSize = '13px';
        statusText.style.color = '#555';
        statusText.textContent = '\u601d\u8003\u4e2d...';
        bub.appendChild(statusText);

        const dots = document.createElement('span'); dots.className = 'loading-dots';
        dots.innerHTML = '<span></span><span></span><span></span>';
        bub.appendChild(dots); node.appendChild(bub);
        chat.appendChild(node); chat.scrollTop = chat.scrollHeight;
        _pendingBubble = node;
      }
      function clearPendingBubble() {
        if (_pendingBubble) { _pendingBubble.remove(); _pendingBubble = null; }
      }

      function doSend() {
        const text = prompt.value.trim(); if (!text) return;
        // Slash command 攔截：以 / 開頭且完整符合指令時直接執行
        if (tryHandleSlash(text)) return;
        const m = modelSelect ? modelSelect.value : undefined;
        const label = text.length > 60 ? text.slice(0, 60) + '\u2026' : text;
        autoTitleFromPrompt(text);
        appendMessage('user', label + (attachedFiles.length ? ' (\uD83D\uDCCE ' + attachedFiles.length + ')' : '') + (attachedImages.length ? ' (\uD83D\uDDBC\uFE0F ' + attachedImages.length + ')' : ''), undefined, undefined, text);
        if (attachedImages.length) {
          var _imgSnap = attachedImages.slice();
          var _lastUsr = chat.querySelector('.msg.user:last-child');
          if (_lastUsr) {
            var _thumbRow = document.createElement('div');
            _thumbRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-top:4px';
            _imgSnap.forEach(function(d) {
              var _t = document.createElement('img');
              _t.src = d;
              _t.style.cssText = 'width:72px;height:72px;object-fit:cover;border-radius:4px;border:1px solid rgba(128,128,128,0.3)';
              _thumbRow.appendChild(_t);
            });
            _lastUsr.querySelector('.bubble').appendChild(_thumbRow);
          }
        }
        if (teamMode) {
            var selModels = getSelectedTeamModels();
            var roundsEl = document.getElementById('teamRoundsSelect');
            var roundsVal = roundsEl ? roundsEl.value : '20';
            var teamModeEl = document.getElementById('teamModeSelect');
            var teamExecMode = teamModeEl ? teamModeEl.value : 'task';
            var maxParEl = document.getElementById('teamMaxParallelSelect');
            var maxParVal = maxParEl ? parseInt(maxParEl.value) : 3;
            var tModeLabel = teamExecMode === 'manager' ? '\\uD83C\\uDFE2 \u4e3b\u7ba1\u6a21\u5f0f\u57f7\u884c\u4e2d\u2026' : '\u26A1 \u5e73\u884c\u5354\u4f5c\u4e2d\u2026';
            vscode.postMessage({ type: 'teamSend', prompt: buildPromptWithFiles(text), models: selModels, roles: getTeamModelRoles(), rounds: roundsVal, teamExecMode: teamExecMode, maxParallel: maxParVal, sessionId: _activeChatSessionId });
            prompt.value = ''; resizePrompt(); clearFiles(); setSendEnabled(false);
            if (statusBar) statusBar.textContent = tModeLabel;
            return;
        }
        if (compareMode) {
            var cmpSel = getSelectedCompareModels();
            vscode.postMessage({ type: 'teamSend', prompt: buildPromptWithFiles(text), models: cmpSel, teamExecMode: 'compare', sessionId: _activeChatSessionId });
            prompt.value = ''; resizePrompt(); clearFiles(); setSendEnabled(false);
            if (statusBar) statusBar.textContent = '\uD83C\uDD9A \u6bd4\u8f03\u4e2d\u2026';
            return;
        }
        if (debateMode) {
            var debSel = getSelectedDebateModels();
            var roundsElD = document.getElementById('debateRoundsSelect');
            var roundsValD = roundsElD ? roundsElD.value : '20';
            if (roundsValD === 'custom') {
              var customRoundsEl = document.getElementById('debateRoundsCustomInput');
              roundsValD = (customRoundsEl && customRoundsEl.value) ? customRoundsEl.value : '20';
            }
            vscode.postMessage({ type: 'debateSend', prompt: buildPromptWithFiles(text), models: debSel, rounds: roundsValD, sessionId: _activeChatSessionId });
            prompt.value = ''; resizePrompt(); clearFiles(); setSendEnabled(false);
            if (statusBar) statusBar.textContent = '\u2694\ufe0f \u5c0d\u8a71\u4e2d\u2026';
            return;
        }
        var _imgs = attachedImages.map(function(d){ return d.replace(/^data:[^;]+;base64,/, ''); });
        var _shadowMSel = document.getElementById('shadowModelSelect');
        var _shadowM = _shadowMSel ? _shadowMSel.value : '';
        // 儲存此 session 使用的模型，切換 tab 時可以恢復
        var _curSess = getActiveSession(); if (_curSess && m) { _curSess.model = m; persistSessionState(); }
        var _msgType = agentMode ? 'agentSend' : 'send';
        var _modeSelEl = document.getElementById('modeSelect');
        var _modeSelVal = _modeSelEl ? _modeSelEl.value : 'unknown';
        dbg('[Send] type=' + _msgType + ' agentMode=' + agentMode + ' modeSelect=' + _modeSelVal + ' model=' + m + ' teamMode=' + teamMode);
        vscode.postMessage({ type: _msgType, prompt: buildPromptWithFiles(text), model: m, sessionId: _activeChatSessionId, shadowModel: _shadowM || undefined, images: _imgs.length ? _imgs : undefined, _dbgModeSelect: _modeSelVal, _dbgAgentMode: agentMode });
        prompt.value = ''; resizePrompt(); clearFiles();
        setSendEnabled(false);
        appendLoadingBubble();
      }

      function setSendEnabled(on) {
        if (sendBtn) sendBtn.disabled = !on;
      }
      prompt.addEventListener('input', function() { setSendEnabled(prompt.value.trim().length > 0); });
      setSendEnabled(true);

      // ── Slash Command 系統 ─────────────────────────────────────────────────
      // 注意：icon 使用 HTML entity 字串（不用 emoji literal），避免 Variation Selector
      // 在 inline script 中造成 "unexpected token" 的 HTML 解析錯誤。
      var _slashCmds = [
        { cmd: '/doctor',         icon: '&#x1FA7A;', desc: '\u8a3a\u65b7 AmiClaw \u74b0\u5883\uff08\u9023\u7dda / \u6a21\u578b / \u5de5\u5177\uff09' },
        { cmd: '/models',         icon: '&#x1F916;', desc: '\u5217\u51fa\u53ef\u7528\u6a21\u578b\u4e26\u91cd\u65b0\u6574\u7406' },
        { cmd: '/memory',         icon: '&#x1F9E0;', desc: '\u958b\u555f\u9577\u671f\u8a18\u61b6\u9762\u677f' },
        { cmd: '/history',        icon: '&#x1F4DC;', desc: '\u986f\u793a\u76ee\u524d Session \u5c0d\u8a71\u7d71\u8a08' },
        { cmd: '/session export', icon: '&#x1F4BE;', desc: '\u5c07\u76ee\u524d\u5c0d\u8a71\u532f\u51fa\u70ba Markdown' },
        { cmd: '/tools',          icon: '&#x1F527;', desc: '\u986f\u793a\u5de5\u5177\u7a3d\u6838\u65e5\u8a8c' },
        { cmd: '/jira',           icon: '&#x1F3AB;', desc: '\u5217\u51fa Jira Issues\uff08\u547c\u53eb jira_list\uff09' },
        { cmd: '/wa',             icon: '&#x1F4F1;', desc: '\u986f\u793a WhatsApp \u9023\u7dda\u72c0\u614b' },
        { cmd: '/jenkins',        icon: '&#x1F6E0;', desc: '\u67e5\u8a62 Jenkins \u5efa\u7f6e\u72c0\u614b' },
        { cmd: '/compact',        icon: '&#x1F5DC;', desc: '\u58d3\u7e2e\u5c0d\u8a71\u6b77\u53f2\uff08\u91cb\u653e context \u7a7a\u9593\uff09' },
        { cmd: '/audit',          icon: '&#x1F4CB;', desc: '\u986f\u793a\u5de5\u5177\u7a3d\u6838\u65e5\u8a8c' },
        { cmd: '/photos',         icon: '&#x1F5BC;&#xFE0F;', desc: '整理照片：辨識人物 / 行為並分類到資料夾' },
      ];
      var _slashPopup   = document.getElementById('slashPopup');
      var _slashActive  = -1;   // 目前選中的 item index

      function _slashItems() { return _slashPopup ? _slashPopup.querySelectorAll('.slash-item') : []; }

      function showSlashPopup(filter) {
        if (!_slashPopup) return;
        var f = filter.toLowerCase();
        var matched = _slashCmds.filter(function(c) { return c.cmd.indexOf(f) === 0; });
        if (!matched.length) { hideSlashPopup(); return; }
        _slashPopup.innerHTML = matched.map(function(c) {
          return '<div class="slash-item" data-cmd="' + c.cmd + '">'
            + '<span>' + c.icon + '</span>'
            + '<span class="slash-cmd">' + c.cmd + '</span>'
            + '<span class="slash-desc">' + c.desc + '</span>'
            + '</div>';
        }).join('');
        _slashPopup.querySelectorAll('.slash-item').forEach(function(el) {
          el.addEventListener('mousedown', function(e) {
            e.preventDefault();
            execSlashCommand(el.getAttribute('data-cmd'));
          });
        });
        _slashActive = -1;
        _slashPopup.style.display = 'block';
      }

      function hideSlashPopup() {
        if (_slashPopup) { _slashPopup.style.display = 'none'; _slashPopup.innerHTML = ''; }
        _slashActive = -1;
      }

      function _slashMoveActive(dir) {
        var items = _slashItems();
        if (!items.length) return;
        items[Math.max(0, _slashActive)]?.classList?.remove('slash-active');
        _slashActive = Math.max(0, Math.min(items.length - 1, _slashActive + dir));
        items[_slashActive].classList.add('slash-active');
        items[_slashActive].scrollIntoView({ block: 'nearest' });
      }

      function execSlashCommand(cmd) {
        hideSlashPopup();
        prompt.value = ''; resizePrompt();
        if (cmd === '/memory') { var mb = document.getElementById('memBtn'); if (mb) mb.click(); return; }
        if (cmd === '/history') {
          var hi = document.getElementById('historyInfo');
          appendMessage('assistant', '\\uD83D\\uDCDC **\u5c0d\u8a71\u7d71\u8a08**\\n' + (hi ? hi.textContent : '\u7121\u8cc7\u6599'));
          return;
        }
        if (cmd === '/models') { vscode.postMessage({ type: 'fetchModels' }); appendMessage('assistant', '\\uD83E\\uDD16 \u6b63\u5728\u91cd\u65b0\u6574\u7406\u6a21\u578b\u6e05\u55ae\u2026'); return; }
        if (cmd === '/session export') {
          vscode.postMessage({ type: 'exportChat', format: 'markdown', sessionId: _activeChatSessionId, title: '對話-' + new Date().toISOString().slice(0,10) });
          return;
        }
        if (cmd === '/jira') { appendMessage('user', '/jira'); vscode.postMessage({ type: 'agentSend', prompt: '請立即呼叫 jira_list 顯示我目前指派的 Issues 清單，並以清晰格式輸出。', model: modelSelect ? modelSelect.value : undefined, sessionId: _activeChatSessionId }); setSendEnabled(false); appendLoadingBubble(); return; }
        if (cmd === '/jenkins') { appendMessage('user', '/jenkins'); vscode.postMessage({ type: 'agentSend', prompt: '請立即呼叫 jenkins_status 查詢 Jenkins 最近建置狀態並回報結果。', model: modelSelect ? modelSelect.value : undefined, sessionId: _activeChatSessionId }); setSendEnabled(false); appendLoadingBubble(); return; }
        if (cmd === '/photos') { var _pb = document.getElementById('organizePhotosBtn'); if (_pb) _pb.click(); return; }
        if (cmd === '/wa') { appendMessage('user', '/wa'); vscode.postMessage({ type: 'slashCommand', cmd: 'wa' }); return; }
        // 其餘由 extension host 處理
        vscode.postMessage({ type: 'slashCommand', cmd: cmd.replace(/^\\//, ''), sessionId: _activeChatSessionId });
      }

      /** 在 doSend 最前面攔截 slash command */
      function tryHandleSlash(text) {
        if (!text.startsWith('/')) return false;
        var matched = _slashCmds.find(function(c) { return c.cmd === text.trim() || text.trim().indexOf(c.cmd) === 0; });
        if (matched) { execSlashCommand(matched.cmd); return true; }
        return false;
      }

      sendBtn.addEventListener('click', doSend);

      // Enter/Ctrl+Enter 送出設定由 cfgSendKey 控制
      prompt.addEventListener('keydown', function(e) {
        // Slash popup 鍵盤導覽
        if (_slashPopup && _slashPopup.style.display !== 'none') {
          if (e.key === 'ArrowDown') { e.preventDefault(); _slashMoveActive(1); return; }
          if (e.key === 'ArrowUp')   { e.preventDefault(); _slashMoveActive(-1); return; }
          if (e.key === 'Escape')    { e.preventDefault(); hideSlashPopup(); return; }
          if (e.key === 'Enter' || e.key === 'Tab') {
            var items = _slashItems();
            var idx = _slashActive >= 0 ? _slashActive : 0;
            if (items.length) { e.preventDefault(); execSlashCommand(items[idx].getAttribute('data-cmd')); return; }
          }
        }
        if (cfgSendKey === 'Ctrl+Enter') {
          if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); doSend(); }
        } else {
          if (e.key === 'Enter' && !e.ctrlKey && !e.shiftKey && !e.altKey) { e.preventDefault(); doSend(); }
        }
      });

      document.getElementById('clear').addEventListener('click', function() {
        chat.innerHTML = ''; _streamNode = null; _agentStepNode = null; _pendingBubble = null; _agentTodosPanel = null;
        Object.keys(_teamNodes).forEach(function(k){ delete _teamNodes[k]; }); _synthNode = null; _orchestratorNode = null; _orchestratorModel = '';
        saveActiveSessionSnapshot();
        vscode.postMessage({ type: 'clearHistory', sessionId: _activeChatSessionId });
      });

      // 模式切換：單一 dropdown，取代原本 4 個 toggle 按鈕
      var modeSelectEl = document.getElementById('modeSelect');
      if (modeSelectEl) {
        modeSelectEl.addEventListener('change', function() {
          var m = modeSelectEl.value;
          // 切到 team / compare / debate 時順便拉一次模型列表，沿用既有行為
          var fetchModels = (m === 'team' || m === 'compare' || m === 'debate');
          setInteractionMode(m, fetchModels);
        });
      }

      var tpr = document.getElementById('teamPickerRefresh');
      if (tpr) tpr.addEventListener('click', function() { vscode.postMessage({ type: 'fetchTeamModels' }); });

      // ⚡ 快速 5-slot 配置：依模型廠商自動指派角色
      // Claude → 工程師角色 (architect / developer / integrator)
      // OpenAI (gpt/o1/o3) 或其他 → 主管 / 測試員
      var tqs = document.getElementById('teamQuickSetupBtn');
      if (tqs) tqs.addEventListener('click', function() {
        var rows = document.querySelectorAll('#teamPickerList .team-pick-row');
        if (rows.length < 1) return;

        // 分類模型
        var _claudeRows = [], _openRows = [];
        rows.forEach(function(row) {
          var cb = row.querySelector('input[type=checkbox]');
          if (!cb) return;
          var id = (cb.value || '').toLowerCase();
          var isClaude = id.indexOf('claude') !== -1;
          if (isClaude) _claudeRows.push(row); else _openRows.push(row);
        });

        // 角色分配：OpenAI 先拿 manager，剩餘 OpenAI 拿 tester；Claude 依序拿工程師角色
        var _engRoles = ['architect', 'developer', 'integrator'];
        var _managerRow = _openRows[0] || null;
        var _testerRows = _openRows.slice(1);          // 額外 OpenAI → tester
        var _engRows = _claudeRows.slice(0, 3);        // 最多 3 個 Claude → 工程師
        var _extraRows = _claudeRows.slice(3).concat(_testerRows.slice(1)); // 超出的全部勾掉

        // 先全部取消勾選
        rows.forEach(function(row) {
          var cb = row.querySelector('input[type=checkbox]');
          var cs = row.querySelector('.team-pick-step-count');
          var stepper = row.querySelector('.team-pick-stepper');
          var cloneCount = row.querySelector('.team-pick-clone-count');
          if (cb) cb.checked = false;
          if (stepper) stepper.style.display = 'none';
          if (cs) cs.textContent = '1';
          if (cloneCount) cloneCount.style.display = 'none';
        });

        function _assignRole(row, roleKey) {
          var cb = row.querySelector('input[type=checkbox]');
          var stepper = row.querySelector('.team-pick-stepper');
          var roleSelect = row.querySelector('select.team-pick-role');
          if (!cb) return;
          cb.checked = true;
          if (stepper) stepper.style.display = 'inline-flex';
          if (roleSelect) {
            var found = false;
            Array.from(roleSelect.options).forEach(function(opt) { if (opt.value === roleKey) { roleSelect.value = roleKey; found = true; } });
            if (!found && roleSelect.options.length > 0) roleSelect.value = roleSelect.options[0].value;
          }
        }

        if (_managerRow) _assignRole(_managerRow, 'manager');
        _engRows.forEach(function(row, i) { _assignRole(row, _engRoles[i] || 'developer'); });
        // 若有第二個 OpenAI → tester
        if (_testerRows.length > 0) _assignRole(_testerRows[0], 'tester');

        updateTeamPickerCount();
        updateTeamRoleLabels();
      });

      var tmodeEl = document.getElementById('teamModeSelect');
      if (tmodeEl) tmodeEl.addEventListener('change', function() { updateTeamRoleLabels(); });

      var cpr = document.getElementById('comparePickerRefresh');
      if (cpr) cpr.addEventListener('click', function() { vscode.postMessage({ type: 'fetchTeamModels' }); });

      var dpr = document.getElementById('debatePickerRefresh');
      if (dpr) dpr.addEventListener('click', function() { vscode.postMessage({ type: 'fetchTeamModels' }); });
      var debateRoundsSelEl = document.getElementById('debateRoundsSelect');
      if (debateRoundsSelEl) debateRoundsSelEl.addEventListener('change', function() {
        var ci = document.getElementById('debateRoundsCustomInput');
        if (ci) ci.style.display = this.value === 'custom' ? '' : 'none';
      });
      ['A', 'B', 'J'].forEach(function(sp) {
        var swapSel = document.getElementById('debateSwap' + sp);
        if (swapSel) swapSel.addEventListener('change', function() {
          if (this.value) vscode.postMessage({ type: 'debateSwapModel', speaker: sp, modelId: this.value });
        });
      });

      document.getElementById('stopAgent').addEventListener('click', function() { vscode.postMessage({ type: 'agentStop' }); vscode.postMessage({ type: 'teamStop' }); });

      document.getElementById('toggleStream').addEventListener('click', function() {
        streamMode = !streamMode;
        vscode.postMessage({ type: 'toggleStream', enabled: streamMode });
        document.getElementById('toggleStream').classList.toggle('active', streamMode);
        if (statusBar) statusBar.textContent = streamMode ? '\u26a1 \u4e32\u6d41\u6a21\u5f0f\u958b\u555f' : '';
      });

      document.getElementById('pickFile').addEventListener('click', function() {
        vscode.postMessage({ type: 'pickFile' });
      });

      document.getElementById('organizePhotosBtn').addEventListener('click', function() {
        vscode.postMessage({ type: 'organizePhotosPick', sessionId: _activeChatSessionId });
      });

      if (modelSelect) {
        modelSelect.addEventListener('change', function() {
          if (statusBar) statusBar.textContent = '\u6a21\u578b\uff1a' + modelSelect.value;
          var selOpt = modelSelect.options[modelSelect.selectedIndex];
          var multEl = document.getElementById('modelMultiplier');
          if (multEl) multEl.textContent = selOpt && selOpt.dataset.multiplier ? selOpt.dataset.multiplier : '';
          applyProviderInfo({
            id: selOpt && selOpt.dataset.provider ? selOpt.dataset.provider : inferProviderFromModelId(modelSelect.value),
            label: selOpt && selOpt.dataset.providerLabel ? selOpt.dataset.providerLabel : '',
            modelId: modelSelect.value,
            displayName: selOpt ? selOpt.textContent : modelSelect.value
          });
          vscode.postMessage({ type: 'saveModel', model: modelSelect.value });
        });
      }
      applyProviderInfo({ modelId: modelSelect ? modelSelect.value : '', id: inferProviderFromModelId(modelSelect ? modelSelect.value : '') });
      setInteractionMode('agent');

      // ── 附加檔案 ─────────────────────────────────────────────────────────
      function buildPromptWithFiles(text) {
        if (!attachedFiles.length) return text;
        return attachedFiles.map(function(f) {
          return '--- \u9644\u52a0\u6a94\u6848: ' + f.name + ' ---\\n' + f.content;
        }).join('\\n\\n') + '\\n\\n' + text;
      }

      function addFileChip(name, content) {
        attachedFiles.push({ name: name, content: content });
        const af = document.getElementById('attachedFiles');
        const chip = document.createElement('span'); chip.className = 'file-chip';
        chip.appendChild(document.createTextNode('\uD83D\uDCCE ' + name + ' '));
        const rm = document.createElement('button'); rm.className = 'rm'; rm.textContent = '\u00D7'; rm.title = '\u79fb\u9664';
        rm.addEventListener('click', function() {
          attachedFiles = attachedFiles.filter(function(f) { return f.name !== name; });
          chip.remove();
        });
        chip.appendChild(rm); af.appendChild(chip);
      }

      function addImageChip(dataUrl) {
        var idx = attachedImages.length;
        attachedImages.push(dataUrl);
        const af = document.getElementById('attachedFiles');
        const chip = document.createElement('span'); chip.className = 'img-chip';
        const thumb = document.createElement('img'); thumb.src = dataUrl; thumb.alt = '\uD83D\uDDBC\uFE0F';
        const rm = document.createElement('button'); rm.className = 'rm'; rm.textContent = '\u00D7'; rm.title = '\u79fb\u9664';
        rm.addEventListener('click', function() {
          attachedImages.splice(attachedImages.indexOf(dataUrl), 1);
          chip.remove();
        });
        chip.appendChild(thumb); chip.appendChild(rm); af.appendChild(chip);
      }

      function clearFiles() {
        attachedFiles = [];
        attachedImages = [];
        const af = document.getElementById('attachedFiles'); if (af) af.innerHTML = '';
      }

      // ── 思考過程 ─────────────────────────────────────────────────────────
      function makeThinkBlock(text, open) {
        const d = document.createElement('details'); d.className = 'think'; if (open) d.setAttribute('open', '');
        const s = document.createElement('summary');
        const icon = document.createElement('span'); icon.className = 'think-icon';
        const label = document.createElement('span'); label.className = 'think-label'; label.textContent = '\u601d\u8003\u904e\u7a0b';
        s.appendChild(icon); s.appendChild(label);
        const p = document.createElement('pre'); p.textContent = text;
        d.appendChild(s); d.appendChild(p); return d;
      }

      // ── 訊息 ─────────────────────────────────────────────────────────────
      // -- Markdown 渲染工具函式 -------------------------------------------
      function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
      function renderInline(txt) {
        // 先跳脫 HTML，再套用 inline 語法
        txt = escHtml(txt);
        // $$...$$ → 行內數學（保護，避免後面 $...$ 匹配）
        var PH = '\x02';
        txt = txt.replace(/\\$\\$([^$\\n]+?)\\$\\$/g, function(_,m){ return '<code class="math-inline">'+m+'</code>'; });
        // $...$ → 行內數學
        txt = txt.replace(/\\$([^$\\n]{1,80}?)\\$/g, function(_,m){ return '<code class="math-inline">'+m+'</code>'; });
        // **bold**
        txt = txt.replace(/\\*\\*([^*\\n]+?)\\*\\*/g, '<strong>$1</strong>');
        txt = txt.replace(/__([^_\\n]+?)__/g, '<strong>$1</strong>');
        // *italic*  (skip *** and **)
        txt = txt.replace(/(?<!\\*)\\*([^*\\n]+?)\\*(?!\\*)/g, '<em>$1</em>');
        // inline code (backtick)
        var BTCK = String.fromCharCode(96);
        var btRe = new RegExp(BTCK + '([^' + BTCK + '\\n]+?)' + BTCK, 'g');
        txt = txt.replace(btRe, function(_,c){ return '<code>'+c+'</code>'; });
        return txt;
      }
      function renderMdTable(tblLines) {
        var spl = function(r){ var c=r.split('|'); if(!c[0].trim())c.shift(); if(c.length&&!c[c.length-1].trim())c.pop(); return c; };
        var h='<table class="md-table"><thead><tr>';
        spl(tblLines[0]).forEach(function(c){ h+='<th>'+renderInline(c.trim())+'</th>'; });
        h+='</tr></thead><tbody>';
        for(var r=2;r<tblLines.length;r++){ if(!tblLines[r].trim())continue; h+='<tr>'; spl(tblLines[r]).forEach(function(c){ h+='<td>'+renderInline(c.trim())+'</td>'; }); h+='</tr>'; }
        return h+'</tbody></table>';
      }
      function renderTextBlock(raw) {
        var lines=raw.split('\\n'), html='', i=0, mathBuf='', inMath=false;
        while(i<lines.length){
          var ln=lines[i];
          // $$ 區塊
          if(ln.trim()==='$$'){ if(!inMath){inMath=true;mathBuf='';i++;continue;}else{inMath=false;html+='<code class="math-block">'+escHtml(mathBuf.trim())+'</code>';mathBuf='';i++;continue;} }
          if(inMath){mathBuf+=ln+'\\n';i++;continue;}
          // 表格
          if(ln.includes('|')&&i+1<lines.length&&/^\\|?[\\s:|-]+\\|/.test(lines[i+1])){
            var tl=[ln],j=i+1; while(j<lines.length&&lines[j].includes('|')){tl.push(lines[j]);j++;}
            html+=renderMdTable(tl); i=j; continue;
          }
          // 任務清單
          var tm=ln.match(/^(\\s*)-\\s+\\[([ xX])\\]\\s*(.*)/);
          if(tm){ var ck=tm[2].toLowerCase()==='x'; html+='<div class="task-item"><span style="font-family:monospace;color:'+(ck?'#4ec94e':'rgba(128,128,128,0.55)')+'">'+(ck?'[x]':'[ ]')+'</span> <span style="'+(ck?'text-decoration:line-through;opacity:0.55':'')+'">'+renderInline(tm[3])+'</span></div>'; i++;continue; }
          // 無序清單
          var um=ln.match(/^(\\s*)[-*+] (.*)/);
          if(um){ html+='<div style="padding-left:'+(um[1].length*8+14)+'px;margin:1px 0">&bull; '+renderInline(um[2])+'</div>'; i++;continue; }
          // 有序清單
          var om=ln.match(/^(\\s*)(\\d+)\\. (.*)/);
          if(om){ html+='<div style="padding-left:'+(om[1].length*8+16)+'px;margin:1px 0">'+om[2]+'. '+renderInline(om[3])+'</div>'; i++;continue; }
          // 標題
          var hm=ln.match(/^(#{1,4})\\s+(.*)/);
          if(hm){ var lv=hm[1].length,fs=['1.2em','1.1em','1em','0.95em'][lv-1]; html+='<div style="font-weight:700;font-size:'+fs+';margin:6px 0 2px;'+(lv<=2?'border-bottom:1px solid rgba(128,128,128,0.2)':'')+'">'+renderInline(hm[2])+'</div>'; i++;continue; }
          // 空行
          if(!ln.trim()){html+='<div style="height:5px"></div>';i++;continue;}
          // 一般行
          html+='<div style="line-height:1.55;white-space:pre-wrap">'+renderInline(ln)+'</div>';
          i++;
        }
        if(inMath&&mathBuf) html+='<code class="math-block">'+escHtml(mathBuf.trim())+'</code>';
        return html;
      }
      function rerenderBubbleMd(bubble) {
        var rb = bubble && bubble.querySelector('.response-body');
        if (!rb) return;
        var rawText = rb.textContent || '';
        if (!rawText.trim()) return;
        rb.innerHTML = ''; rb.style.whiteSpace = '';
        parseBlocks(rawText).forEach(function(p) {
          if (p.t === 'code') { rb.appendChild(makeCodeBlock(p.v, p.lang)); }
          else if (p.v.trim()) { var d = document.createElement('div'); d.innerHTML = renderTextBlock(p.v); rb.appendChild(d); }
        });
      }
      // -- parseBlocks + makeCodeBlock + highlightCode --------------------------
      function parseBlocks(text) {
        var TICK = String.fromCharCode(96, 96, 96);
        var parts = []; var rest = text;
        while (true) {
          var s = rest.indexOf(TICK);
          if (s === -1) { if (rest) parts.push({ t: 'text', v: rest }); break; }
          if (s > 0) parts.push({ t: 'text', v: rest.slice(0, s) });
          rest = rest.slice(s + 3);
          var nl = rest.indexOf('\\n');
          var lang = nl !== -1 ? rest.slice(0, nl).trim() : '';
          if (nl !== -1) rest = rest.slice(nl + 1);
          var e = rest.indexOf(TICK);
          var code = e !== -1 ? rest.slice(0, e) : rest;
          parts.push({ t: 'code', lang: lang, v: code });
          rest = e !== -1 ? rest.slice(e + 3) : '';
        }
        return parts.length ? parts : [{ t: 'text', v: text }];
      }

      // -- 語法高亮（輕量內嵌 tokenizer，支援 JS/TS/Python/Shell/CSS/JSON）------
      function highlightCode(code, lang) {
        var L = (lang || '').toLowerCase().replace(/[^a-z0-9#+]/g, '');
        var isJS  = /^(js|ts|jsx|tsx|javascript|typescript|mjs|cjs|node)$/.test(L);
        var isPy  = /^(py|python|python3)$/.test(L);
        var isSh  = /^(sh|bash|shell|zsh|fish|ps|ps1|powershell|cmd|bat)$/.test(L);
        var isCss = /^(css|scss|less|sass|styl)$/.test(L);
        var isJson= /^(json|jsonc)$/.test(L);
        if (!isJS && !isPy && !isSh && !isCss && !isJson) {
          return code.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        }
        var KW_JS = 'break,case,catch,class,const,continue,debugger,default,delete,do,else,export,extends,finally,for,function,if,import,in,instanceof,let,new,null,of,return,static,super,switch,throw,try,typeof,undefined,var,void,while,yield,async,await,from,as,type,interface,enum,implements,namespace,declare,abstract,readonly,override,public,private,protected,true,false,this,constructor,get,set,keyof,infer,never,any,unknown,string,number,boolean,object,symbol,bigint'.split(',');
        var KW_PY = 'and,as,assert,async,await,break,class,continue,def,del,elif,else,except,False,finally,for,from,global,if,import,in,is,lambda,None,nonlocal,not,or,pass,raise,return,True,try,while,with,yield,self,cls,print,super,range,len,list,dict,set,tuple,str,int,float,bool,isinstance,hasattr,property,staticmethod,classmethod'.split(',');
        var KW_SH = 'if,then,else,elif,fi,for,while,do,done,case,esac,in,function,return,export,local,declare,readonly,echo,printf,exit,break,continue,set,unset,read,true,false'.split(',');
        var kwMap = {}; (isJS||isJson ? KW_JS : isPy ? KW_PY : isSh ? KW_SH : []).forEach(function(k){kwMap[k]=1;});
        var isPyOrSh = isPy || isSh;
        var TK = String.fromCharCode(96);
        var html='', i=0, n=code.length;
        function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
        function sp(cls,s){return '<span class="'+cls+'">'+esc(s)+'</span>';}
        while(i<n){
          var c=code[i];
          // Python/Shell # comment
          if(c==='#'&&isPyOrSh){ var e1=code.indexOf('\\n',i); if(e1===-1)e1=n; html+=sp('hl-cmt',code.slice(i,e1)); i=e1; continue; }
          // // comment
          if(c==='/'&&code[i+1]==='/'&&!isPy){ var e2=code.indexOf('\\n',i); if(e2===-1)e2=n; html+=sp('hl-cmt',code.slice(i,e2)); i=e2; continue; }
          // /* ... */
          if(c==='/'&&code[i+1]==='*'){ var e3=code.indexOf('*/',i+2); var ce=e3!==-1?e3+2:n; html+=sp('hl-cmt',code.slice(i,ce)); i=ce; continue; }
          // Python triple-quote
          if(isPy&&(code.slice(i,i+3)==='"""'||code.slice(i,i+3)==="'''")){var q3=code.slice(i,i+3),e4=code.indexOf(q3,i+3);var se=e4!==-1?e4+3:n;html+=sp('hl-str',code.slice(i,se));i=se;continue;}
          // string " or '
          if(c==='"'||c==="'"){var q=c,ss=q,si=i+1;while(si<n){var sc=code[si];if(sc==='\\\\'){ss+=sc+(code[si+1]||'');si+=2;continue;}ss+=sc;si++;if(sc===q)break;}html+=sp('hl-str',ss);i=si;continue;}
          // template literal (backtick)
          if(c===TK&&isJS){var ss2=TK,si2=i+1;while(si2<n){var sc2=code[si2];if(sc2==='\\\\'){ss2+=sc2+(code[si2+1]||'');si2+=2;continue;}ss2+=sc2;si2++;if(sc2===TK)break;}html+=sp('hl-str',ss2);i=si2;continue;}
          // number
          if(c>='0'&&c<='9'){var ns='',ni=i;while(ni<n&&/[0-9._xXa-fA-FbBoOpP]/.test(code[ni])){ns+=code[ni];ni++;}html+=sp('hl-num',ns);i=ni;continue;}
          // identifier → keyword / Type / function()
          if(/[a-zA-Z_$]/.test(c)){var id='',ii=i;while(ii<n&&/[\\w$]/.test(code[ii])){id+=code[ii];ii++;}
            if(kwMap[id]){html+=sp('hl-kw',id);}
            else if(/^[A-Z]/.test(id)&&id.length>1&&!/^[A-Z_]+$/.test(id)){html+=sp('hl-type',id);}
            else{var ni2=ii;while(ni2<n&&(code[ni2]===' '||code[ni2]==='\\t'))ni2++;html+=(code[ni2]==='('?sp('hl-fn',id):id);}
            i=ii;continue;}
          if(c==='<'){html+='&lt;';i++;continue;}
          if(c==='>'){html+='&gt;';i++;continue;}
          if(c==='&'){html+='&amp;';i++;continue;}
          html+=c;i++;
        }
        return html;
      }

      function makeCodeBlock(code, lang) {
        var L = (lang || '').trim();
        var wrap = document.createElement('div'); wrap.className = 'code-block-wrap';
        // 語言標頭列
        var hdr = document.createElement('div'); hdr.className = 'code-block-header';
        hdr.textContent = L || 'text';
        wrap.appendChild(hdr);
        var pre = document.createElement('pre');
        if (L) { pre.innerHTML = highlightCode(code, L); } else { pre.textContent = code; }
        wrap.appendChild(pre);
        var acts = document.createElement('div'); acts.className = 'code-actions';
        var applyBtn = document.createElement('button'); applyBtn.textContent = '\uD83D\uDCCB \u5957\u7528\u5230\u6a94\u6848';
        applyBtn.addEventListener('click', function() { vscode.postMessage({ type: 'applyToFile', code: code }); });
        var insertBtn = document.createElement('button'); insertBtn.textContent = '\u2B07 \u63d2\u5165\u6e38\u6a19';
        insertBtn.addEventListener('click', function() { vscode.postMessage({ type: 'insert', code: code }); });
        var copyBtn = document.createElement('button'); copyBtn.textContent = '\u8907\u88fd';
        copyBtn.addEventListener('click', function() {
          if (navigator.clipboard) {
            navigator.clipboard.writeText(code).then(function() {
              copyBtn.textContent = '\u2713 \u5df2\u8907\u88fd'; setTimeout(function() { copyBtn.textContent = '\u8907\u88fd'; }, 1500);
            }).catch(function() { copyBtn.textContent = '\u5931\u6557'; });
          }
        });
        acts.appendChild(applyBtn); acts.appendChild(insertBtn); acts.appendChild(copyBtn);
        wrap.appendChild(acts); return wrap;
      }

      // -- appendMessage (fullText = 5th param, user messages only) ------------
      function appendMessage(who, text, thinkingText, tokens, fullText) {
        var node = document.createElement('div'); node.className = 'msg ' + who;
        var bubble = document.createElement('div'); bubble.className = 'bubble';
        if (who === 'assistant' && thinkingText) bubble.appendChild(makeThinkBlock(thinkingText, false));
        if (who === 'assistant') {
          var _curUserCount = _userMsgCount; // 捕捉此時的 user count，供 fork 使用
          node.dataset.userCount = String(_curUserCount);
          parseBlocks(text).forEach(function(p) {
            if (p.t === 'code') {
              bubble.appendChild(makeCodeBlock(p.v, p.lang));
            } else if (p.v.trim()) {
              var d = document.createElement('div'); d.innerHTML = renderTextBlock(p.v); bubble.appendChild(d);
            }
          });
          var statRow = document.createElement('div'); statRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-top:4px';
          var sumBtn = document.createElement('button'); sumBtn.textContent = '\u6458\u8981';
          sumBtn.addEventListener('click', function() { vscode.postMessage({ type: 'summarize', text: text, model: modelSelect ? modelSelect.value : undefined }); });
          statRow.appendChild(sumBtn);
          if (tokens) { var tokSpan = document.createElement('span'); tokSpan.style.cssText = 'font-size:10px;opacity:0.5'; tokSpan.textContent = '~' + tokens + ' tokens'; statRow.appendChild(tokSpan); }
          bubble.appendChild(statRow);
          // ── Fork (分支) 按鈕
          var acts2 = document.createElement('div'); acts2.className = 'msg-actions';
          var forkBtn = document.createElement('button'); forkBtn.className = 'msg-action-btn'; forkBtn.textContent = '\uD83C\uDF3F \u5EFA\u7ACB\u5206\u652F';
          forkBtn.title = '\u5F9E\u6B64\u8655\u5EFA\u7ACB\u65B0\u7684\u5C0D\u8A71\u5206\u652F';
          forkBtn.addEventListener('click', function() {
            var allMsgs = Array.from(chat.querySelectorAll('.msg'));
            var nodeIdx = allMsgs.indexOf(node);
            var uc = 0;
            for (var _fi = 0; _fi <= nodeIdx; _fi++) { if (allMsgs[_fi].classList.contains('user')) uc++; }
            var forkHtml = allMsgs.slice(0, nodeIdx + 1).map(function(n2) { return n2.outerHTML; }).join('');
            vscode.postMessage({ type: 'forkSession', userCount: uc, forkHtml: forkHtml, sessionId: _activeChatSessionId });
          });
          acts2.appendChild(forkBtn); bubble.appendChild(acts2);
        } else {
          // ── 使用者訊息 — 記錄索引 + edit 按鈕
          var _myUserIdx = _userMsgCount;
          node.dataset.userIdx = String(_myUserIdx);
          node.dataset.fullText = fullText || text;
          _userMsgCount++;
          var body = document.createElement('div'); body.textContent = text; bubble.appendChild(body);
          // Edit 按鈕區
          var editActs = document.createElement('div'); editActs.className = 'msg-actions';
          var editBtn = document.createElement('button'); editBtn.className = 'msg-action-btn'; editBtn.textContent = '\u270F\uFE0F \u7DE8\u8F2F';
          editBtn.title = '\u4FEE\u6539\u6B64\u8A0A\u606F\u4E26\u91CD\u65B0\u7522\u751F\u56DE\u61C9';
          (function(capturedNode, capturedBody, capturedIdx) {
            editBtn.addEventListener('click', function() { startEditMessage(capturedNode, capturedBody, capturedIdx); });
          })(node, body, _myUserIdx);
          editActs.appendChild(editBtn); bubble.appendChild(editActs);
        }
        node.appendChild(bubble);
        chat.appendChild(node); chat.scrollTop = chat.scrollHeight;
      }

      // ── 訊息編輯 ─────────────────────────────────────────────────────────
      function startEditMessage(node, bodyEl, userIdx) {
        if (node.classList.contains('editing')) return;
        node.classList.add('editing');
        var origText = node.dataset.fullText || (bodyEl ? bodyEl.textContent : '');
        var overlay = document.createElement('div'); overlay.className = 'user-edit-overlay';
        var ta = document.createElement('textarea'); ta.className = 'user-edit-textarea'; ta.value = origText;
        var actRow = document.createElement('div'); actRow.className = 'user-edit-actions';
        var confirmBtn = document.createElement('button'); confirmBtn.className = 'msg-action-btn'; confirmBtn.style.cssText = 'background:rgba(0,180,0,0.2);border-color:rgba(0,200,0,0.4)'; confirmBtn.textContent = '\u2713 \u78BA\u8A8D\u537B\u66F4\u65B0';
        var cancelBtn  = document.createElement('button'); cancelBtn.className = 'msg-action-btn'; cancelBtn.textContent = '\u2715 \u53D6\u6D88';
        actRow.appendChild(confirmBtn); actRow.appendChild(cancelBtn); overlay.appendChild(ta); overlay.appendChild(actRow);
        if (bodyEl) bodyEl.style.display = 'none';
        node.querySelector('.msg-actions') && (node.querySelector('.msg-actions').style.display = 'none');
        var bubble = node.querySelector('.bubble'); if (bubble) bubble.appendChild(overlay);
        ta.focus(); ta.select();
        function doCancel() {
          overlay.remove();
          if (bodyEl) bodyEl.style.display = '';
          node.querySelector('.msg-actions') && (node.querySelector('.msg-actions').style.display = '');
          node.classList.remove('editing');
        }
        cancelBtn.addEventListener('click', doCancel);
        confirmBtn.addEventListener('click', function() {
          var newText = ta.value.trim();
          if (!newText) { doCancel(); return; }
          // \u66F4\u65B0 DOM \u986F\u793A\u6587\u5B57
          var label = newText.length > 60 ? newText.slice(0, 60) + '\u2026' : newText;
          if (bodyEl) { bodyEl.textContent = label; bodyEl.style.display = ''; }
          node.dataset.fullText = newText;
          overlay.remove();
          node.querySelector('.msg-actions') && (node.querySelector('.msg-actions').style.display = '');
          node.classList.remove('editing');
          // \u522A\u9664\u6B64\u8A0A\u606F\u4E4B\u5F8C\u7684\u6240\u6709 DOM \u8A0A\u606F
          var allMsgs = Array.from(chat.querySelectorAll('.msg'));
          var nodeIdx = allMsgs.indexOf(node);
          for (var _di = allMsgs.length - 1; _di > nodeIdx; _di--) { allMsgs[_di].remove(); }
          _userMsgCount = userIdx + 1;
          appendLoadingBubble();
          vscode.postMessage({ type: 'editMessage', userIdx: userIdx, newText: newText, model: modelSelect ? modelSelect.value : undefined, sessionId: _activeChatSessionId });
        });
      }

      // ── 串流 ─────────────────────────────────────────────────────────────
      function getOrCreateStreamNode() {
        if (_streamNode && chat.contains(_streamNode)) return _streamNode;
        const node = document.createElement('div'); node.className = 'msg assistant';
        const bubble = document.createElement('div'); bubble.className = 'bubble';
        node.appendChild(bubble); chat.appendChild(node); _streamNode = node; return node;
      }

      function getStreamBubble() {
        const n = getOrCreateStreamNode();
        let b = n.querySelector('.bubble');
        if (!b) { b = document.createElement('div'); b.className = 'bubble'; n.appendChild(b); }
        return b;
      }

      // 串流啟動時的「思考中」佔位指示器（含 elapsed timer）
      function startStreamThinkingPlaceholder() {
        clearPendingBubble();
        // 若已有 stream node（前一輪 tool call 後的延續），先清除舊 placeholder
        clearStreamThinkingPlaceholder();
        const bubble = getStreamBubble();
        // 若 bubble 內已有實際回應內容（response-body），就不再顯示 placeholder
        if (bubble.querySelector('.response-body')) {
          return;
        }
        // 若已有 think 區塊（thinking 模型），不重複建立
        if (bubble.querySelector('details.think')) {
          return;
        }
        // 依當前選定模型判斷是「思考中」還是「等待回應」
        var _curOpt = modelSelect ? modelSelect.options[modelSelect.selectedIndex] : null;
        var _isThinking = !!(_curOpt && _curOpt.dataset && _curOpt.dataset.thinking);
        var _waitText = _isThinking ? '\\uD83E\\uDD14 \u601d\u8003\u4e2d\u2026' : '\u23F3 \u7B49\u5F85\u56DE\u61C9\u2026';
        // 建立與 appendThinkChunk 相同樣式的 details.think 框，
        // 但標示為 placeholder（無實際內容），收到第一個 chunk 時清除。
        const d = document.createElement('details');
        d.className = 'think stream-thinking-placeholder';
        d.setAttribute('open', '');
        const s = document.createElement('summary');
        const icon = document.createElement('span'); icon.className = 'think-icon pulse';
        const label = document.createElement('span'); label.className = 'think-label';
        label.textContent = _waitText + ' (0s)';
        s.appendChild(icon); s.appendChild(label);
        const p = document.createElement('pre'); p.className = 'think-stream';
        p.textContent = '';
        p.style.opacity = '0.55';
        p.style.fontStyle = 'italic';
        d.appendChild(s); d.appendChild(p);
        if (bubble.firstChild) { bubble.insertBefore(d, bubble.firstChild); } else { bubble.appendChild(d); }
        d._startTs = Date.now();
        d._timer = setInterval(function() {
          if (!document.body.contains(d)) { clearInterval(d._timer); return; }
          const secs = Math.round((Date.now() - d._startTs) / 1000);
          label.textContent = _waitText + ' (' + secs + 's)';
        }, 500);
        chat.scrollTop = chat.scrollHeight;
      }

      function clearStreamThinkingPlaceholder() {
        if (!_streamNode || !chat.contains(_streamNode)) return;
        const ph = _streamNode.querySelector('details.think.stream-thinking-placeholder');
        if (ph) {
          if (ph._timer) { clearInterval(ph._timer); ph._timer = null; }
          ph.remove();
        }
      }

      function appendThinkChunk(chunk, modelName) {
        clearPendingBubble();
        const bubble = getStreamBubble();
        let d = bubble.querySelector('details.think');
        const _thinkLabel = modelName ? '\\uD83E\\uDDE0 ' + modelName + ' \u601d\u8003\u4e2d\u2026' : '\\uD83E\\uDDE0 \u601d\u8003\u4e2d\u2026';
        if (!d) {
          d = document.createElement('details'); d.className = 'think'; d.setAttribute('open', '');
          const s = document.createElement('summary');
          const icon = document.createElement('span'); icon.className = 'think-icon pulse';
          const label = document.createElement('span'); label.className = 'think-label'; label.textContent = _thinkLabel;
          s.appendChild(icon); s.appendChild(label);
          const p = document.createElement('pre'); p.className = 'think-stream';
          d.appendChild(s); d.appendChild(p); 
          // 插入到 bubble 最前面，讓思考區塊出現在回應內容之前
          if (bubble.firstChild) { bubble.insertBefore(d, bubble.firstChild); } else { bubble.appendChild(d); }
          d._charCount = 0;
          d._thinkStart = Date.now();
          d._thinkModelName = modelName || '';
          d._thinkTimer = setInterval(function() {
            if (!d.hasAttribute('open')) { clearInterval(d._thinkTimer); return; }
            const secs = Math.round((Date.now() - d._thinkStart) / 1000);
            const approxTok2 = Math.round((d._charCount || 0) / 4);
            const lbl2 = d.querySelector('.think-label');
            const _lbl2 = d._thinkModelName ? '\\uD83E\\uDDE0 ' + d._thinkModelName + ' \u601d\u8003\u4e2d\u2026' : '\\uD83E\\uDDE0 \u601d\u8003\u4e2d\u2026';
            if (lbl2) lbl2.textContent = _lbl2 + ' (~' + approxTok2 + ' tokens, ' + secs + 's)';
          }, 1000);
        }
        d._charCount = (d._charCount || 0) + chunk.length;
        const approxTok = Math.round(d._charCount / 4);
        const secs = Math.round((Date.now() - (d._thinkStart || Date.now())) / 1000);
        const lbl = d.querySelector('.think-label');
        if (lbl) lbl.textContent = _thinkLabel + ' (~' + approxTok + ' tokens, ' + secs + 's)';
        const p = d.querySelector('pre.think-stream');
        if (p) { p.textContent = (p.textContent || '') + chunk; p.scrollTop = p.scrollHeight; }
        chat.scrollTop = chat.scrollHeight;
      }

      function appendChunk(chunk) {
        clearPendingBubble(); // remove loading dots before creating stream node
        const bubble = getStreamBubble();
        const d = bubble.querySelector('details.think');
        if (d && d.hasAttribute('open')) {
          d.removeAttribute('open');
          d._thinkEnd = Date.now();
          if (d._thinkTimer) { clearInterval(d._thinkTimer); d._thinkTimer = null; }
          const icon = d.querySelector('.think-icon'); if (icon) icon.classList.remove('pulse');
          const lbl = d.querySelector('.think-label');
          const approxTok = Math.round((d._charCount || 0) / 4);
          const totalSecs = Math.round((Date.now() - (d._thinkStart || Date.now())) / 1000);
          const _doneLabel = d._thinkModelName ? '\\uD83E\\uDDE0 ' + d._thinkModelName + ' \u601d\u8003\u904e\u7a0b' : '\\uD83E\\uDDE0 \u601d\u8003\u904e\u7a0b';
          if (lbl) lbl.textContent = _doneLabel + ' (~' + approxTok + ' tokens, \u8017\u6642 ' + totalSecs + 's)';
        }
        let body = bubble.querySelector('.response-body');
        if (!body) { body = document.createElement('div'); body.className = 'response-body'; body.style.whiteSpace = 'pre-wrap'; bubble.appendChild(body); }
        body.textContent = (body.textContent || '') + chunk;
        chat.scrollTop = chat.scrollHeight;
      }

      // ── Agent 工具步驟 ───────────────────────────────────────────────────────────
      function ensureLastAssistantBubble() {
        clearPendingBubble();
        var last = chat.lastElementChild;
        if (last && last.classList.contains('msg') && last.classList.contains('assistant')) {
          return last.querySelector('.bubble');
        }
        var node = document.createElement('div'); node.className = 'msg assistant';
        var bub = document.createElement('div'); bub.className = 'bubble';
        node.appendChild(bub); chat.appendChild(node); return bub;
      }

      function appendAgentStep(icon, title, fullPath) {
        var bub = ensureLastAssistantBubble();
        var d = document.createElement('details'); d.className = 'tool-step'; d.dataset.s = 'running';
        var s = document.createElement('summary');
        var span = document.createElement('span'); span.textContent = (icon || '\uD83D\uDD27') + '\u00A0' + title;
        if (fullPath) { span.title = fullPath; }
        var status = document.createElement('span'); status.className = 'step-status';
        s.appendChild(span); s.appendChild(status);
        d.appendChild(s); bub.appendChild(d); _agentStepNode = d;
        chat.scrollTop = chat.scrollHeight;
      }

      function finalizeAgentStep(result, isError) {
        if (!_agentStepNode) return;
        _agentStepNode.dataset.s = isError ? 'error' : 'done';
        if (result) { var pre = document.createElement('pre'); pre.textContent = result; _agentStepNode.appendChild(pre); }
        _agentStepNode = null; chat.scrollTop = chat.scrollHeight;
      }

      // ── 團隊模式 ──────────────────────────────────────────────────────────
      var TEAM_COLORS = ['#4fc1ff','#89d185','#ce9178','#c586c0','#dcdcaa','#f7cc65'];

      function createTeamMember(id, model, color, task) {
        clearPendingBubble();
        var node = document.createElement('div'); node.className = 'msg assistant team-member-node';
        var bub = document.createElement('div'); bub.className = 'bubble'; bub.style.borderLeftColor = color;
        var hdr = document.createElement('div'); hdr.className = 'team-header';
        var badge = document.createElement('span'); badge.className = 'team-badge';
        badge.textContent = model; badge.style.color = color; badge.style.borderColor = color; badge.style.background = color + '22';
        var st = document.createElement('span'); st.className = 'team-status-text'; st.textContent = '\u601d\u8003\u4e2d\u2026';
        hdr.appendChild(badge); hdr.appendChild(st); bub.appendChild(hdr);
        if (task) { var tl = document.createElement('div'); tl.className = 'team-task-label'; tl.textContent = '\uD83D\uDCCC ' + task; bub.appendChild(tl); }
        node.appendChild(bub);
        chat.appendChild(node); chat.scrollTop = chat.scrollHeight;
        _teamNodes[id] = { node: node, bubble: bub, status: st, thinkNode: null, responseNode: null, reviewNode: null, charCount: 0, thinkStart: null, thinkTimer: null, modelName: model };
      }

      function appendTeamThinkChunk(id, color, chunk) {
        var m = _teamNodes[id]; if (!m) return;
        var _tmLabel = m.modelName ? '\\uD83E\\uDDE0 ' + m.modelName + ' \u601d\u8003\u4e2d\u2026' : '\\uD83E\\uDDE0 \u601d\u8003\u4e2d\u2026';
        var _tmDone  = m.modelName ? '\\uD83E\\uDDE0 ' + m.modelName + ' \u601d\u8003\u904e\u7a0b' : '\\uD83E\\uDDE0 \u601d\u8003\u904e\u7a0b';
        if (!m.thinkNode) {
          var d = document.createElement('details'); d.className = 'think'; d.setAttribute('open', '');
          var s = document.createElement('summary');
          var icon = document.createElement('span'); icon.className = 'think-icon pulse'; icon.style.background = color;
          var lbl = document.createElement('span'); lbl.className = 'think-label'; lbl.textContent = _tmLabel;
          s.appendChild(icon); s.appendChild(lbl);
          var p = document.createElement('pre'); p.className = 'think-stream';
          d.appendChild(s); d.appendChild(p); m.bubble.appendChild(d);
          m.thinkNode = d; m.thinkStart = Date.now(); m.charCount = 0;
          m.thinkTimer = setInterval(function() {
            if (!d.hasAttribute('open')) { clearInterval(m.thinkTimer); return; }
            var secs = Math.round((Date.now() - m.thinkStart) / 1000);
            var tok = Math.round((m.charCount || 0) / 4);
            var l2 = d.querySelector('.think-label'); if (l2) l2.textContent = _tmLabel + ' (~' + tok + ' tokens, ' + secs + 's)';
          }, 1000);
        }
        m.charCount = (m.charCount || 0) + chunk.length;
        var tok = Math.round(m.charCount / 4);
        var secs = Math.round((Date.now() - (m.thinkStart || Date.now())) / 1000);
        var ll = m.thinkNode.querySelector('.think-label'); if (ll) ll.textContent = _tmLabel + ' (~' + tok + ' tokens, ' + secs + 's)';  
        var pre = m.thinkNode.querySelector('pre.think-stream'); if (pre) { pre.textContent += chunk; pre.scrollTop = pre.scrollHeight; }
        chat.scrollTop = chat.scrollHeight;
      }

      function appendTeamResponseChunk(id, chunk) {
        var m = _teamNodes[id]; if (!m) return;
        if (m.thinkNode && m.thinkNode.hasAttribute('open')) {
          m.thinkNode.removeAttribute('open');
          if (m.thinkTimer) { clearInterval(m.thinkTimer); m.thinkTimer = null; }
          var icon2 = m.thinkNode.querySelector('.think-icon'); if (icon2) icon2.classList.remove('pulse');
          var lbl2 = m.thinkNode.querySelector('.think-label');
          var tok2 = Math.round((m.charCount || 0) / 4);
          var secs2 = Math.round((Date.now() - (m.thinkStart || Date.now())) / 1000);
          var _tmDone2 = m.modelName ? '\\uD83E\\uDDE0 ' + m.modelName + ' \u601d\u8003\u904e\u7a0b' : '\\uD83E\\uDDE0 \u601d\u8003\u904e\u7a0b';
          if (lbl2) lbl2.textContent = _tmDone2 + ' (~' + tok2 + ' tokens, \u8017\u6642 ' + secs2 + 's)';
        }
        if (m.status) m.status.textContent = '\u56de\u7b54\u4e2d\u2026';
        if (!m.responseNode) {
          var rb = document.createElement('div'); rb.className = 'response-body'; rb.style.whiteSpace = 'pre-wrap';
          m.bubble.appendChild(rb); m.responseNode = rb;
        }
        m.responseNode.textContent += chunk;
        chat.scrollTop = chat.scrollHeight;
      }

      function finalizeTeamMember(id) {
        var m = _teamNodes[id]; if (!m) return;
        if (m.status) m.status.textContent = '\u2713 \u5b8c\u6210';
        if (m.thinkTimer) { clearInterval(m.thinkTimer); m.thinkTimer = null; }
        if (m.thinkNode && m.thinkNode.hasAttribute('open')) { m.thinkNode.removeAttribute('open'); }
        if (m.responseNode) {
          var lineCount = (m.responseNode.textContent || '').split('\\n').length;
          if (lineCount > 10) {
            m.responseNode.classList.add('response-body-collapsed');
            var xBtn = document.createElement('button'); xBtn.className = 'response-expand-btn';
            xBtn.textContent = '\u25bc \u5c55\u958b\u5168\u6587 (' + lineCount + ' \u884c)';
            xBtn.onclick = function() { m.responseNode.classList.remove('response-body-collapsed'); xBtn.remove(); };
            m.bubble.appendChild(xBtn);
          }
        }
      }

      var _todoListNode = null;
      function createTeamTodoListBubble() {
        var node = document.createElement('div'); node.className = 'msg assistant team-todolist-node';
        var bub = document.createElement('div'); bub.className = 'bubble';
        var hdr = document.createElement('div'); hdr.className = 'team-todolist-header';
        hdr.textContent = '\u2705 \u57f7\u884c\u8a08\u756b\uff08ToDo List\uff09';
        var body = document.createElement('div'); body.className = 'response-body'; body.style.whiteSpace = 'pre-wrap';
        bub.appendChild(hdr); bub.appendChild(body); node.appendChild(bub);
        chat.appendChild(node); chat.scrollTop = chat.scrollHeight;
        _todoListNode = { node: node, body: body };
      }
      function appendTeamTodoListChunk(chunk) {
        if (!_todoListNode) return;
        _todoListNode.body.textContent += chunk;
        chat.scrollTop = chat.scrollHeight;
      }

      function createTeamSynthBubble() {
        var node = document.createElement('div'); node.className = 'msg assistant team-synth-node';
        var bub = document.createElement('div'); bub.className = 'bubble';
        var hdr = document.createElement('div'); hdr.className = 'team-synth-header'; hdr.textContent = '\u2728 \u5718\u968a\u7d9c\u5408\u5efa\u8b70';
        var body = document.createElement('div'); body.className = 'response-body'; body.style.whiteSpace = 'pre-wrap';
        bub.appendChild(hdr); bub.appendChild(body); node.appendChild(bub);
        chat.appendChild(node); chat.scrollTop = chat.scrollHeight;
        _synthNode = { node: node, bubble: bub, body: body };
      }

      function appendTeamSynthChunk(chunk) {
        if (!_synthNode) return;
        _synthNode.body.textContent += chunk;
        chat.scrollTop = chat.scrollHeight;
      }

      function createOrchestratorBubble(model) {
        clearPendingBubble();
        _orchestratorModel = model || '\uD83D\uDC19 \u5354\u8abf\u54e1';
        var node = document.createElement('div'); node.className = 'msg assistant team-orchestrator-node';
        var bub = document.createElement('div'); bub.className = 'bubble';
        var hdr = document.createElement('div'); hdr.className = 'team-orchestrator-header';
        hdr.textContent = _orchestratorModel + ' \u2014 \u5206\u914D\u5DE5\u4F5C\u4E2D\u2026';
        var body = document.createElement('div'); body.className = 'team-orchestrator-body';
        bub.appendChild(hdr); bub.appendChild(body); node.appendChild(bub);
        chat.appendChild(node); chat.scrollTop = chat.scrollHeight;
        _orchestratorNode = { node: node, bubble: bub, body: body, hdr: hdr };
      }

      function appendOrchestratorThinkChunk(chunk) {
        if (!_orchestratorNode) return;
        var _orcName = _orchestratorModel || '';
        var _orcLabel = _orcName ? '\\uD83E\\uDDE0 ' + _orcName + ' \u601d\u8003\u4e2d\u2026' : '\\uD83E\\uDDE0 \u601d\u8003\u4e2d\u2026';
        if (!_orchestratorNode.thinkNode) {
          var d = document.createElement('details'); d.className = 'think'; d.setAttribute('open', '');
          var s = document.createElement('summary');
          var icon = document.createElement('span'); icon.className = 'think-icon pulse'; icon.style.background = '#f7cc65';
          var lbl = document.createElement('span'); lbl.className = 'think-label'; lbl.textContent = _orcLabel;
          s.appendChild(icon); s.appendChild(lbl);
          var p = document.createElement('pre'); p.className = 'think-stream';
          d.appendChild(s); d.appendChild(p);
          _orchestratorNode.bubble.insertBefore(d, _orchestratorNode.body);
          _orchestratorNode.thinkNode = d; _orchestratorNode.thinkStart = Date.now(); _orchestratorNode.thinkChars = 0;
          _orchestratorNode.thinkTimer = setInterval(function() {
            if (!d.hasAttribute('open')) { clearInterval(_orchestratorNode.thinkTimer); return; }
            var secs = Math.round((Date.now() - _orchestratorNode.thinkStart) / 1000);
            var tok = Math.round((_orchestratorNode.thinkChars || 0) / 4);
            var l2 = d.querySelector('.think-label'); if (l2) l2.textContent = _orcLabel + ' (~' + tok + ' tokens, ' + secs + 's)';
          }, 1000);
        }
        _orchestratorNode.thinkChars = (_orchestratorNode.thinkChars || 0) + chunk.length;
        var orcPre = _orchestratorNode.thinkNode.querySelector('pre.think-stream'); if (orcPre) { orcPre.textContent += chunk; orcPre.scrollTop = orcPre.scrollHeight; }
        chat.scrollTop = chat.scrollHeight;
      }

      function appendOrchestratorChunk(chunk) {
        if (!_orchestratorNode) return;
        if (_orchestratorNode.thinkNode && _orchestratorNode.thinkNode.hasAttribute('open')) {
          _orchestratorNode.thinkNode.removeAttribute('open');
          if (_orchestratorNode.thinkTimer) { clearInterval(_orchestratorNode.thinkTimer); _orchestratorNode.thinkTimer = null; }
          var orcIcon = _orchestratorNode.thinkNode.querySelector('.think-icon'); if (orcIcon) orcIcon.classList.remove('pulse');
          var orcLbl = _orchestratorNode.thinkNode.querySelector('.think-label');
          var orcTok = Math.round((_orchestratorNode.thinkChars || 0) / 4);
          var orcSecs = Math.round((Date.now() - (_orchestratorNode.thinkStart || Date.now())) / 1000);
          var _orcName2 = _orchestratorModel || '';
          var _orcDone = _orcName2 ? '\\uD83E\\uDDE0 ' + _orcName2 + ' \u601d\u8003\u904e\u7a0b' : '\\uD83E\\uDDE0 \u601d\u8003\u904e\u7a0b';
          if (orcLbl) orcLbl.textContent = _orcDone + ' (~' + orcTok + ' tokens, \u8017\u6642 ' + orcSecs + 's)';
        }
        _orchestratorNode.body.textContent += chunk;
        chat.scrollTop = chat.scrollHeight;
      }

      function finalizeOrchestratorBubble() {
        if (!_orchestratorNode) return;
        if (_orchestratorNode.thinkTimer) { clearInterval(_orchestratorNode.thinkTimer); _orchestratorNode.thinkTimer = null; }
        if (_orchestratorNode.thinkNode && _orchestratorNode.thinkNode.hasAttribute('open')) {
          _orchestratorNode.thinkNode.removeAttribute('open');
          var lbl = _orchestratorNode.thinkNode.querySelector('.think-label');
          var tok = Math.round((_orchestratorNode.thinkChars || 0) / 4);
          if (lbl) lbl.textContent = '\\uD83E\\uDDE0 \u601d\u8003\u5b8c\u6210 (~' + tok + ' tokens)';
          var icon = _orchestratorNode.thinkNode.querySelector('.think-icon'); if (icon) icon.classList.remove('pulse');
        }
        if (_orchestratorNode.hdr) _orchestratorNode.hdr.textContent = _orchestratorNode.hdr.textContent.replace('\u5206\u914D\u5DE5\u4F5C\u4E2D\u2026', '\u2713 \u5DE5\u4F5C\u5206\u914D\u5B8C\u6210');
      }

      function createTodoPanel(tasks) {
        var wrap = document.createElement('div'); wrap.className = 'msg';
        var bub = document.createElement('div'); bub.className = 'team-todos-panel';
        var hdr = document.createElement('div'); hdr.className = 'team-todos-header';
        var ttl = document.createElement('span'); ttl.id = 'todosTitle'; ttl.textContent = '\u4efb\u52d9\u6e05\u55ae (0/' + tasks.length + ')';
        hdr.appendChild(document.createTextNode('\uD83D\uDCCB ')); hdr.appendChild(ttl);
        bub.appendChild(hdr);
        for (var i = 0; i < tasks.length; i++) {
          var row = document.createElement('div'); row.className = 'team-todo-item'; row.id = 'todo_item_' + i;
          var st = document.createElement('span'); st.className = 'team-todo-status'; st.textContent = '\u23f3';
          var tk = document.createElement('span'); tk.className = 'team-todo-task'; tk.textContent = tasks[i];
          var wk = document.createElement('span'); wk.className = 'team-todo-worker'; wk.id = 'todo_worker_' + i;
          row.appendChild(st); row.appendChild(tk); row.appendChild(wk); bub.appendChild(row);
        }
        wrap.appendChild(bub); chat.appendChild(wrap); chat.scrollTop = chat.scrollHeight;
        _todosPanel = bub; _todoChecked = 0;
      }
      function updateTodo(idx, status, worker) {
        var row = document.getElementById('todo_item_' + idx); if (!row) return;
        row.className = 'team-todo-item' + (status === 'done' ? ' t-done' : status === 'running' ? ' t-running' : '');
        var st = row.querySelector('.team-todo-status'); if (st) st.textContent = status === 'done' ? '\u2705' : status === 'running' ? '\uD83D\uDD04' : '\u23f3';
        var wk = document.getElementById('todo_worker_' + idx); if (wk && worker) wk.textContent = '\u2190 ' + worker;
        if (status === 'done') {
          _todoChecked++;
          var total = _todosPanel ? _todosPanel.querySelectorAll('.team-todo-item').length : 0;
          var ttl2 = document.getElementById('todosTitle'); if (ttl2) ttl2.textContent = '\u4efb\u52d9\u6e05\u55ae (' + _todoChecked + '/' + total + ')';
        }
      }

      function renderAgentTodos(todos) {
        var panel = document.getElementById('agentTodosPanel');
        if (!panel) return;
        if (!todos || todos.length === 0) { panel.style.display = 'none'; return; }
        panel.style.display = '';
        var done = todos.filter(function(t) { return t.done; }).length;
        var ttl2 = document.getElementById('agTodosTitle');
        if (ttl2) ttl2.textContent = '\uD83D\uDCCB \u4efb\u52d9\u6e05\u55ae (' + done + '/' + todos.length + ')';
        var fill2 = document.getElementById('agTodosFill');
        if (fill2) fill2.style.width = (todos.length > 0 ? Math.round(done / todos.length * 100) : 0) + '%';
        var list2 = document.getElementById('agTodosList'); if (!list2) return;
        list2.innerHTML = '';
        var firstPendingFound = false;
        todos.forEach(function(t) {
          var row = document.createElement('div');
          var isRunning = !t.done && !firstPendingFound;
          if (!t.done) firstPendingFound = true;
          row.className = 'agent-todo-item' + (t.done ? ' at-done' : isRunning ? ' at-active' : '');
          var icon = document.createElement('span'); icon.className = 'agent-todo-icon';
          icon.textContent = t.done ? '\u2705' : isRunning ? '\u23f3' : '\uD83D\uDCCB';
          var text = document.createElement('span'); text.className = 'agent-todo-text';
          text.textContent = t.text;
          row.appendChild(icon); row.appendChild(text); list2.appendChild(row);
        });
      }

      // ── Shadow Staging Panel ─────────────────────────────────────────────────
      var _shadowExpanded = false;
      function renderShadowPanel(state) {
        var panel = document.getElementById('shadowPanel'); if (!panel) return;
        if (!state || state.status === 'idle') { panel.style.display = 'none'; return; }
        panel.style.display = '';
        var files = state.files || [];
        var totalAdd = files.reduce(function(s,f){return s+(f.linesAdded||0);},0);
        var totalDel = files.reduce(function(s,f){return s+(f.linesRemoved||0);},0);
        var label = document.getElementById('shadowBarLabel');
        if (label) label.textContent = '已變更 ' + files.length + ' 個檔案';
        var addStat = document.getElementById('shadowAddStat');
        var delStat = document.getElementById('shadowDelStat');
        if (addStat) addStat.textContent = totalAdd > 0 ? '+'+totalAdd : '';
        if (delStat) delStat.textContent = totalDel > 0 ? '-'+totalDel : '';
        var list = document.getElementById('shadowFileList'); if (!list) return;
        list.innerHTML = '';
        files.forEach(function(f) {
          var row = document.createElement('div'); row.className = 'shadow-file-row';
          var opBadge = document.createElement('span');
          opBadge.className = 'shadow-op-badge ' + (f.op || 'write');
          opBadge.textContent = f.op || 'write';
          var fp = document.createElement('span'); fp.className = 'shadow-filepath';
          var basename = f.original ? f.original.split('/').pop().split('\\\\').pop() : f.original;
          fp.textContent = basename; fp.title = f.original;
          fp.addEventListener('click', function(e) {
            e.stopPropagation();
            vscode.postMessage({ type: 'shadowInspectFile', original: f.original, shadow: f.shadow });
          });
          // 套用到檔案 / 複製 按鈕（同 code block 風格）
          var acts = document.createElement('div'); acts.className = 'shadow-file-acts';
          var applyBtn = document.createElement('button'); applyBtn.className = 'shadow-file-btn'; applyBtn.textContent = '\uD83D\uDCCB \u5957\u7528\u5230\u6a94\u6848';
          applyBtn.title = '\u5c07\u6b64\u5f71\u5b50\u8b8a\u66f4\u5beb\u5165\u771f\u5be6\u6a94\u6848';
          applyBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            vscode.postMessage({ type: 'shadowApplyFile', original: f.original, shadow: f.shadow });
          });
          var diffBtn = document.createElement('button'); diffBtn.className = 'shadow-file-btn'; diffBtn.textContent = '\uD83D\uDD0D \u6BD4\u5C0D';
          diffBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            vscode.postMessage({ type: 'shadowInspectFile', original: f.original, shadow: f.shadow });
          });
          acts.appendChild(applyBtn); acts.appendChild(diffBtn);
          row.appendChild(opBadge); row.appendChild(fp); row.appendChild(acts);
          list.appendChild(row);
        });
        var verifyOut = document.getElementById('shadowVerifyOut');
        if (verifyOut) {
          if (state.verifyOutput) { verifyOut.style.display = ''; verifyOut.textContent = state.verifyOutput; }
          else { verifyOut.style.display = 'none'; }
        }
        var approveBtn = document.getElementById('shadowApproveBtn');
        var verifyBtn = document.getElementById('shadowVerifyBtn');
        if (approveBtn) approveBtn.disabled = (state.status !== 'ready_to_commit' && state.status !== 'staging');
        if (verifyBtn) verifyBtn.disabled = state.status === 'verifying' || files.length === 0;
      }

      // Shadow bar 展開/收合 → 改為開關 fileModPanel
      (function() {
        var bar = document.getElementById('shadowBar');
        if (bar) bar.addEventListener('click', function(e) {
          if (e.target.closest && e.target.closest('button')) return;
          // 點擊收合列即開關 fileModPanel
          if (!fileModPanel) return;
          var vis = fileModPanel.classList.toggle('visible');
          if (fileModBtn) fileModBtn.classList.toggle('active', vis);
          // 影子区展開/收合不再用內嵌 detail
          var detail = document.getElementById('shadowDetail');
          var arrow  = document.getElementById('shadowArrow');
          if (detail) detail.style.display = 'none';
          if (arrow)  arrow.className = 'shadow-expand-arrow' + (vis ? ' open' : '');
        });
        // 按鈕事件：shadow session 時發送 sandbox 指令；普通 fileModified 通知時只清除 bar
        function _shadowBtn(id, shadowMsgType, regularAction) {
          var el = document.getElementById(id);
          if (!el) return;
          el.addEventListener('click', function(e) {
            e.stopPropagation();
            if (_shadowSessionActive) {
              vscode.postMessage({ type: shadowMsgType });
            } else if (regularAction === 'clear') {
              _fileMods = [];
              renderFileMods();
              var panel = document.getElementById('shadowPanel');
              if (panel) panel.style.display = 'none';
              if (fileModBtn) fileModBtn.classList.remove('active');
              if (fileModPanel) fileModPanel.classList.remove('visible');
            }
          });
        }
        _shadowBtn('shadowVerifyBtn',  'shadowVerify',  '');
        _shadowBtn('shadowApproveBtn', 'shadowApprove', 'clear');
        _shadowBtn('shadowRejectBtn',  'shadowReject',  'clear');
      })();

      function startTeamRound(id, round) {
        var m = _teamNodes[id]; if (!m) return;
        if (round > 0) {
          if (m.thinkNode && m.thinkNode.hasAttribute('open')) {
            m.thinkNode.removeAttribute('open');
            if (m.thinkTimer) { clearInterval(m.thinkTimer); m.thinkTimer = null; }
          }
          m.thinkNode = null; m.responseNode = null; m.reviewNode = null;
          var sep = document.createElement('div'); sep.className = 'team-round-sep';
          sep.textContent = '\u2500\u2500 \u7b2c ' + (round + 1) + ' \u8f2a \u2500\u2500';
          m.bubble.appendChild(sep);
        }
        if (m.status) m.status.textContent = (round > 0 ? '\u8fed\u4ee3\u4e2d\u2026' : '\u601d\u8003\u4e2d\u2026');
      }

      function startTeamReview(id) {
        var m = _teamNodes[id]; if (!m) return;
        var rv = document.createElement('div'); rv.className = 'team-review-section';
        var rvh = document.createElement('span'); rvh.className = 'team-review-label'; rvh.textContent = (_orchestratorModel || '\uD83D\uDC19 \u5354\u8abf\u54e1') + '\uff1a';
        var rvb = document.createElement('span'); rvb.className = 'team-review-body';
        rv.appendChild(rvh); rv.appendChild(rvb); m.bubble.appendChild(rv);
        m.reviewNode = rvb; chat.scrollTop = chat.scrollHeight;
      }

      function appendTeamReviewChunk(id, chunk) {
        var m = _teamNodes[id]; if (!m || !m.reviewNode) return;
        m.reviewNode.textContent += chunk; chat.scrollTop = chat.scrollHeight;
      }

      function finalizeTeamRound(id, approved) {
        var m = _teamNodes[id]; if (!m) return;
        if (m.reviewNode && m.reviewNode.parentNode) {
          var badge = document.createElement('span');
          badge.className = approved ? 'team-round-approved' : 'team-round-iterate';
          badge.textContent = approved ? ' \u2713' : ' \u21bb \u6539\u9032\u4e2d';
          m.reviewNode.parentNode.appendChild(badge);
        }
        m.reviewNode = null;
      }

      // ── 團隊模式 — 成員選擇面板 ──────────────────────────────────────
      function populateTeamPicker(models) {
        _teamAvailModels = models || [];
        var list = document.getElementById('teamPickerList'); if (!list) return;
        list.innerHTML = '';
        if (!_teamAvailModels.length) {
          list.innerHTML = '<span style="font-size:11px;opacity:0.6">\u7121\u53ef\u7528\u6a21\u578b\uff08Ollama \u672a\u5b89\u88dd\u6a21\u578b / Copilot \u672a\u767b\u5165\uff09</span>';
          return;
        }
        _teamAvailModels.forEach(function(m, i) {
          var row = document.createElement('div'); row.className = 'team-pick-row';
          row.dataset.provider = m.provider || inferProviderFromModelId(m.id);
          var cb = document.createElement('input'); cb.type = 'checkbox'; cb.id = 'tp' + i; cb.value = m.id;
          var lbl = document.createElement('label'); lbl.htmlFor = 'tp' + i;
          lbl.className = 'provider-label';
          lbl.dataset.provider = m.provider || inferProviderFromModelId(m.id);
          lbl.textContent = decorateProviderLabel(m, true);
          // \u00d7N clone count span (sibling, not inside label)
          var cloneCount = document.createElement('span'); cloneCount.className = 'team-pick-clone-count';
          cloneCount.style.cssText = 'display:none;font-size:10px;font-weight:700;color:var(--vscode-charts-orange,#f7a534);margin-left:2px;vertical-align:middle';
          // count stepper
          var stepper = document.createElement('span'); stepper.className = 'team-pick-stepper'; stepper.style.cssText = 'display:none;align-items:center;gap:2px;margin-left:4px';
          var btnMinus = document.createElement('button'); btnMinus.type = 'button'; btnMinus.textContent = '\u2212'; btnMinus.className = 'team-pick-step-btn';
          var countSpan = document.createElement('span'); countSpan.textContent = '1'; countSpan.className = 'team-pick-step-count'; countSpan.style.cssText = 'min-width:14px;text-align:center;font-size:11px;font-weight:700';
          var btnPlus = document.createElement('button'); btnPlus.type = 'button'; btnPlus.textContent = '+'; btnPlus.className = 'team-pick-step-btn';
          btnMinus.addEventListener('click', function(e) { e.preventDefault(); e.stopPropagation(); var n = parseInt(countSpan.textContent)||1; if (n > 1) { countSpan.textContent = String(n-1); cloneCount.textContent = '\u00D7' + (n-1); cloneCount.style.display = n-1 > 1 ? 'inline' : 'none'; } else { cb.checked = false; stepper.style.display = 'none'; countSpan.textContent = '1'; cloneCount.style.display = 'none'; } updateTeamPickerCount(); });
          btnPlus.addEventListener('click', function(e) { e.preventDefault(); e.stopPropagation(); var total = getTeamTotalCount(); if (total >= 5) return; var n = parseInt(countSpan.textContent)||1; if (n < 5) { countSpan.textContent = String(n+1); cloneCount.textContent = '\u00D7' + (n+1); cloneCount.style.display = 'inline'; } updateTeamPickerCount(); });
          stepper.appendChild(btnMinus); stepper.appendChild(countSpan); stepper.appendChild(btnPlus);
          cb.addEventListener('change', function() { if (cb.checked) { stepper.style.display = 'inline-flex'; countSpan.textContent = '1'; cloneCount.style.display = 'none'; } else { stepper.style.display = 'none'; countSpan.textContent = '1'; cloneCount.style.display = 'none'; } updateTeamPickerCount(); });
          var roleSelect = document.createElement('select');
          roleSelect.className = 'team-pick-role'; roleSelect.dataset.modelId = m.id;
          _teamRolesConfig.forEach(function(r) {
            var o = document.createElement('option'); o.value = r.key; o.textContent = r.emoji + ' ' + r.label; roleSelect.appendChild(o);
          });
          // auto-assign default role by slot index
          if (_teamRolesConfig.length) roleSelect.value = _teamRolesConfig[i % _teamRolesConfig.length].key;
          roleSelect.addEventListener('change', updateTeamRoleLabels);
          row.appendChild(cb); row.appendChild(lbl); row.appendChild(cloneCount); row.appendChild(stepper); row.appendChild(roleSelect); list.appendChild(row);
        });
        updateTeamPickerCount();
      }
      function getTeamTotalCount() {
        var total = 0;
        document.querySelectorAll('#teamPickerList .team-pick-row').forEach(function(row) {
          var cb = row.querySelector('input[type=checkbox]');
          var cs = row.querySelector('.team-pick-step-count');
          if (cb && cb.checked) total += cs ? (parseInt(cs.textContent)||1) : 1;
        });
        return total;
      }
      function updateTeamPickerCount() {
        var total = getTeamTotalCount();
        var el = document.getElementById('teamPickerCount'); if (el) el.textContent = total + '/5 \u5df2\u9078';
        document.querySelectorAll('#teamPickerList .team-pick-row').forEach(function(row) {
          var cb = row.querySelector('input[type=checkbox]');
          var btnPlus = row.querySelector('.team-pick-step-btn:last-child');
          if (cb && !cb.checked) cb.disabled = total >= 5;
          if (btnPlus) btnPlus.disabled = total >= 5;
        });
        updateTeamRoleLabels();
      }
      function updateTeamRoleLabels() {
        var _rc = {}; var _rcolor = {};
        _teamRolesConfig.forEach(function(r) { _rc[r.key] = r.emoji + ' ' + r.label; _rcolor[r.key] = r.color || '#4fc1ff'; });
        document.querySelectorAll('#teamPickerList .team-pick-row').forEach(function(row) {
          var cb = row.querySelector('input[type=checkbox]');
          var lbl = row.querySelector('label');
          var roleSel = row.querySelector('select.team-pick-role');
          var cs = row.querySelector('.team-pick-step-count');
          if (!cb || !lbl) return;
          if (roleSel) roleSel.style.display = cb.checked ? '' : 'none';
          var badge = lbl.querySelector('.role-badge');
          if (!badge) { badge = document.createElement('span'); badge.className = 'role-badge'; lbl.appendChild(badge); }
          if (cb.checked && roleSel) {
            var baseKey = roleSel.value || (_teamRolesConfig[0] && _teamRolesConfig[0].key) || 'developer';
            var n = cs ? (parseInt(cs.textContent)||1) : 1;
            var baseIdx = _teamRolesConfig.findIndex(function(r) { return r.key === baseKey; });
            if (n <= 1 || _teamRolesConfig.length === 0) {
              // 單個：只顯示 base role
              badge.textContent = _rc[baseKey] || baseKey;
              badge.style.cssText = 'display:inline-block;font-size:10px;font-weight:700;padding:1px 5px;border-radius:10px;margin-left:5px;vertical-align:middle;white-space:nowrap;background:' + (_rcolor[baseKey]||'#4fc1ff') + ';color:#1e1e1e';
            } else {
              // ×N：顯示所有循環角色序列
              var parts = [];
              for (var k = 0; k < n; k++) {
                var ri = baseIdx >= 0 ? (baseIdx + k) % _teamRolesConfig.length : -1;
                var rk = ri >= 0 ? _teamRolesConfig[ri].key : baseKey;
                parts.push(_teamRolesConfig[ri >= 0 ? ri : 0].emoji + ' ' + _teamRolesConfig[ri >= 0 ? ri : 0].label);
              }
              badge.textContent = parts.join(' → ');
              badge.style.cssText = 'display:inline-block;font-size:10px;font-weight:700;padding:1px 5px;border-radius:10px;margin-left:5px;vertical-align:middle;white-space:nowrap;background:linear-gradient(90deg,#f7a534,#4fc1ff);color:#1e1e1e';
            }
          } else {
            badge.style.display = 'none';
          }
        });
      }
      function getSelectedTeamModels() {
        var r = [];
        document.querySelectorAll('#teamPickerList .team-pick-row').forEach(function(row) {
          var cb = row.querySelector('input[type=checkbox]');
          var cs = row.querySelector('.team-pick-step-count');
          if (cb && cb.checked) { var n = cs ? (parseInt(cs.textContent)||1) : 1; for (var k = 0; k < n; k++) r.push(cb.value); }
        });
        return r;
      }
      function getTeamModelRoles() {
        var arr = [];
        document.querySelectorAll('#teamPickerList .team-pick-row').forEach(function(row) {
          var cb = row.querySelector('input[type=checkbox]');
          var cs = row.querySelector('.team-pick-step-count');
          var roleSel = row.querySelector('select.team-pick-role');
          if (cb && cb.checked && roleSel) {
            var n = cs ? (parseInt(cs.textContent)||1) : 1;
            var baseRole = roleSel.value || (_teamRolesConfig[0] && _teamRolesConfig[0].key) || 'developer';
            var baseIdx = _teamRolesConfig.findIndex(function(r) { return r.key === baseRole; });
            for (var k = 0; k < n; k++) {
              var ri = baseIdx >= 0 ? (baseIdx + k) % _teamRolesConfig.length : -1;
              arr.push(ri >= 0 ? _teamRolesConfig[ri].key : baseRole);
            }
          }
        });
        return arr;
      }

      function populateComparePicker(models) {
        var _cmpModels = models || [];
        var list = document.getElementById('comparePickerList'); if (!list) return;
        list.innerHTML = '';
        if (!_cmpModels.length) { list.innerHTML = '<span style="font-size:11px;opacity:0.6">\u7121\u53ef\u7528\u6a21\u578b</span>'; return; }
        _cmpModels.forEach(function(m, i) {
          var row = document.createElement('div'); row.className = 'team-pick-row';
          row.dataset.provider = m.provider || inferProviderFromModelId(m.id);
          var cb = document.createElement('input'); cb.type = 'checkbox'; cb.id = 'cmp' + i; cb.value = m.id;
          cb.addEventListener('change', function() {
            var cbs = document.querySelectorAll('#comparePickerList input[type=checkbox]');
            var n = 0; cbs.forEach(function(c) { if (c.checked) n++; });
            var el = document.getElementById('comparePickerCount'); if (el) el.textContent = n + '/5 \u5df2\u9078';
            cbs.forEach(function(c) { if (!c.checked) c.disabled = n >= 5; });
          });
          var lbl = document.createElement('label'); lbl.htmlFor = 'cmp' + i;
          lbl.className = 'provider-label';
          lbl.dataset.provider = m.provider || inferProviderFromModelId(m.id);
          lbl.textContent = decorateProviderLabel(m, true);
          row.appendChild(cb); row.appendChild(lbl); list.appendChild(row);
        });
      }
      function getSelectedCompareModels() {
        var r = [];
        document.querySelectorAll('#comparePickerList input[type=checkbox]:checked').forEach(function(c) { r.push(c.value); });
        return r;
      }

      function populateDebatePicker(models) {
        _teamAvailModels = models || [];
        var list = document.getElementById('debatePickerList'); if (!list) return;
        list.innerHTML = '';
        if (!_teamAvailModels.length) {
          list.innerHTML = '<span style="font-size:11px;opacity:0.6">\u7121\u53ef\u7528\u6a21\u578b</span>';
          return;
        }
        _teamAvailModels.forEach(function(m, i) {
          var row = document.createElement('div'); row.className = 'team-pick-row';
          row.dataset.provider = m.provider || inferProviderFromModelId(m.id);
          var cb = document.createElement('input'); cb.type = 'checkbox'; cb.id = 'dp' + i; cb.value = m.id;
          cb.addEventListener('change', updateDebatePickerCount);
          var lbl = document.createElement('label'); lbl.htmlFor = 'dp' + i;
          lbl.className = 'provider-label';
          lbl.dataset.provider = m.provider || inferProviderFromModelId(m.id);
          lbl.textContent = decorateProviderLabel(m, true);
          row.appendChild(cb); row.appendChild(lbl); list.appendChild(row);
        });
        updateDebatePickerCount();
        // 更新即時換模型下拉選單
        var _optBase = '<option value="">\u2500 \u4fdd持 \u2500</option>';
        ['A', 'B', 'J'].forEach(function(sp) {
          var ss = document.getElementById('debateSwap' + sp); if (!ss) return;
          var curVal = ss.value;
          ss.innerHTML = _optBase;
          _teamAvailModels.forEach(function(m) {
            var opt = document.createElement('option'); opt.value = m.id;
            opt.dataset.provider = m.provider || inferProviderFromModelId(m.id);
            opt.textContent = decorateProviderLabel(m, false);
            ss.appendChild(opt);
          });
          if (curVal) ss.value = curVal;
        });
        // 預設選揇現在對話模型
        var curSel = getSelectedDebateModels();
        ['A', 'B', 'J'].forEach(function(sp, i) {
          var ss = document.getElementById('debateSwap' + sp);
          if (ss && curSel[i]) ss.value = curSel[i];
        });
      }
      function updateDebatePickerCount() {
        var cbs = document.querySelectorAll('#debatePickerList input[type=checkbox]');
        var n = 0; cbs.forEach(function(c) { if (c.checked) n++; });
        var el = document.getElementById('debatePickerCount'); if (el) el.textContent = n + '/3 \u5df2\u9078';
        cbs.forEach(function(c) { if (!c.checked) c.disabled = n >= 3; });
      }
      function getSelectedDebateModels() {
        var r = [];
        document.querySelectorAll('#debatePickerList input[type=checkbox]:checked').forEach(function(c) { r.push(c.value); });
        return r;
      }

      // ── Debate bubble functions ──────────────────────────────────────────
      function createDebateHeader(labelA, labelB, labelJ, colorA, colorB, colorJ, gameType, speakerLabels, speakerColors) {
        _debateLabelA = labelA; _debateLabelB = labelB; _debateLabelJ = labelJ || '';
        _debateColorA = colorA; _debateColorB = colorB; _debateColorJ = colorJ;
        _speakerLabels = speakerLabels || {};
        _speakerColors = speakerColors || {};
        Object.keys(_debateNodes).forEach(function(k) { delete _debateNodes[k]; });
        var hdr = document.createElement('div');
        hdr.style.cssText = 'text-align:center;font-size:0.82em;font-weight:700;margin:10px 0 4px;padding:5px 0;border-top:1px dashed rgba(128,128,128,0.3);border-bottom:1px dashed rgba(128,128,128,0.3)';
        if (gameType === 'team-discussion') {
          // N-model discussion: show all members as a list
          var memberTags = Object.keys(_speakerLabels).sort(function(a,b){return Number(a)-Number(b);}).map(function(k) {
            return '<span style="color:' + (_speakerColors[k] || colorA) + '">' + _speakerLabels[k] + '</span>';
          });
          hdr.innerHTML = '\uD83D\uDCAC \u8a0e\u8ad6\u6a21\u5f0f\uff1a' + memberTags.join(' \u00B7 ');
        } else {
          var tagA = '<span style="color:' + colorA + '">' + labelA + '</span>';
          var tagB = '<span style="color:' + colorB + '">' + labelB + '</span>';
          var tagJ = labelJ ? ' &#x00B7; <span style="color:' + colorJ + '">[' + labelJ + ' \u88c1\u5244]</span>' : '';
          var gameTag = (gameType && gameType !== 'discussion' && gameType !== 'generic') ? ' <span style="opacity:0.55;font-size:0.9em">[' + gameType + ']</span>' : '';
          hdr.innerHTML = '\u2694\ufe0f \u5c0d\u8a71\u6a21\u5f0f\uff1a' + tagA + ' vs ' + tagB + tagJ + gameTag;
        }
        chat.appendChild(hdr); chat.scrollTop = chat.scrollHeight;
      }
      function startDebateTurn(speaker, round, overrideLabel, overrideColor) {
        var _ICONS = ['\uD83D\uDFE6','\uD83D\uDFE7','\uD83D\uDFE9','\uD83D\uDFE8','\uD83D\uDFEA','\uD83D\uDFEB'];
        var label = overrideLabel || _speakerLabels[speaker] || (speaker === 'A' ? _debateLabelA : speaker === 'B' ? _debateLabelB : (_debateLabelJ || '') + ' (\u88c1\u5224)');
        var color = overrideColor || _speakerColors[speaker] || (speaker === 'A' ? _debateColorA : speaker === 'B' ? _debateColorB : _debateColorJ);
        var _idx = isNaN(Number(speaker)) ? (speaker === 'A' ? 0 : speaker === 'B' ? 1 : 2) : Number(speaker);
        var roleIcon = (speaker === 'J') ? '\u2696\ufe0f' : (_ICONS[_idx] || '\uD83D\uDFE6');
        var node = document.createElement('div'); node.className = 'msg assistant';
        var bub = document.createElement('div'); bub.className = 'bubble debate-turn';
        bub.style.borderLeft = '3px solid ' + color;
        var h = document.createElement('div'); h.className = 'debate-turn-header';
        h.style.color = color;
        h.innerHTML = roleIcon + ' <strong>' + label + '</strong>' + (round >= 0 ? ' <span style="opacity:0.5;font-weight:normal">\u7b2c ' + (round + 1) + ' \u8f2a</span>' : '');
        var boardNode = document.createElement('pre'); boardNode.className = 'debate-board'; boardNode.style.display = 'none';
        var body = document.createElement('div'); body.className = 'debate-turn-body';
        bub.appendChild(h); bub.appendChild(boardNode); bub.appendChild(body); node.appendChild(bub);
        chat.appendChild(node); chat.scrollTop = chat.scrollHeight;
        _debateNodes[speaker] = { node: node, bub: bub, body: body, boardNode: boardNode, rawBuf: '', thinkNode: null, thinkChars: 0, thinkStart: 0, thinkTimer: null };
      }
      function appendDebateThinkChunk(speaker, chunk) {
        var d = _debateNodes[speaker]; if (!d) return;
        if (!d.thinkNode) {
          var det = document.createElement('details'); det.className = 'think'; det.setAttribute('open', '');
          var s = document.createElement('summary');
          var color = _speakerColors[speaker] || (speaker === 'A' ? _debateColorA : speaker === 'B' ? _debateColorB : _debateColorJ);
          var icon = document.createElement('span'); icon.className = 'think-icon pulse'; icon.style.background = color;
          var lbl = document.createElement('span'); lbl.className = 'think-label'; lbl.textContent = '\uD83E\uDDE0 \u601d\u8003\u4e2d\u2026';
          s.appendChild(icon); s.appendChild(lbl);
          var p = document.createElement('pre'); p.className = 'think-stream';
          det.appendChild(s); det.appendChild(p);
          d.bub.insertBefore(det, d.body);
          d.thinkNode = det; d.thinkStart = Date.now(); d.thinkChars = 0;
          d.thinkTimer = setInterval(function() {
            if (!det.hasAttribute('open')) { clearInterval(d.thinkTimer); return; }
            var secs = Math.round((Date.now() - d.thinkStart) / 1000);
            var tok = Math.round((d.thinkChars || 0) / 4);
            var ll = det.querySelector('.think-label'); if (ll) ll.textContent = '\uD83E\uDDE0 \u601d\u8003\u4e2d\u2026 (~' + tok + ' tokens, ' + secs + 's)';
          }, 1000);
        }
        d.thinkChars = (d.thinkChars || 0) + chunk.length;
        var pre = d.thinkNode.querySelector('pre.think-stream'); if (pre) { pre.textContent += chunk; pre.scrollTop = pre.scrollHeight; }
        chat.scrollTop = chat.scrollHeight;
      }
      function appendDebateChunk(speaker, chunk) {
        var d = _debateNodes[speaker]; if (!d) return;
        if (d.thinkNode && d.thinkNode.hasAttribute('open')) {
          d.thinkNode.removeAttribute('open');
          d.thinkEnd = Date.now();
          if (d.thinkTimer) { clearInterval(d.thinkTimer); d.thinkTimer = null; }
          var icon = d.thinkNode.querySelector('.think-icon'); if (icon) icon.classList.remove('pulse');
          var lbl = d.thinkNode.querySelector('.think-label');
          var tok = Math.round((d.thinkChars || 0) / 4); var secs = Math.round((Date.now() - d.thinkStart) / 1000);
          if (lbl) lbl.textContent = '\uD83E\uDDE0 \u601d\u8003\u904e\u7a0b (~' + tok + ' tokens, \u8017\u6642 ' + secs + 's)';
        }
        d.rawBuf = (d.rawBuf || '') + chunk;
        var boardMatch = d.rawBuf.match(/\\[BOARD\\]([\\s\\S]*?)\\[\\/BOARD\\]/);
        if (boardMatch && d.boardNode) {
          d.boardNode.textContent = boardMatch[1].replace(/^\\n/, '').replace(/\\n$/, '');
          d.boardNode.style.display = '';
        }
        d.body.textContent = d.rawBuf.replace(/\\[BOARD\\][\\s\\S]*?\\[\\/BOARD\\]/g, '').replace(/\\[BOARD\\][\\s\\S]*$/, '').trim();
        chat.scrollTop = chat.scrollHeight;
      }
      function finalizeDebateTurn(speaker, tokens, tps) {
        var d = _debateNodes[speaker]; if (!d) return;
        if (d.thinkTimer) { clearInterval(d.thinkTimer); d.thinkTimer = null; }
        if (d.thinkNode && d.thinkNode.hasAttribute('open')) {
          d.thinkNode.removeAttribute('open');
          d.thinkEnd = Date.now();
          var icon = d.thinkNode.querySelector('.think-icon'); if (icon) icon.classList.remove('pulse');
        }
        if (d.thinkNode && tokens !== undefined && tps !== undefined) {
          var lbl = d.thinkNode.querySelector('.think-label');
          var secs = d.thinkEnd ? Math.round((d.thinkEnd - d.thinkStart) / 1000) : 0;
          if (lbl) lbl.textContent = '\uD83E\uDDE0 \u601d\u8003\u904e\u7a0b (' + tokens + ' tokens, \u8017\u6642 ' + secs + 's, ' + tps.toFixed(1) + ' t/s)';
        }
      }
      function finalizeDebate(consensus) {
        var div = document.createElement('div');
        div.className = consensus ? 'debate-consensus' : 'debate-ended';
        div.textContent = consensus ? '\u2705 \u96d9\u65b9\u5df2\u9054\u6210\u5171\u8b58' : '\u2694\ufe0f \u5c0d\u8a71\u7d50\u675f';
        chat.appendChild(div); chat.scrollTop = chat.scrollHeight;
      }

      function updateModelSelect(models, current) {
        if (!modelSelect) return;
        // 優先保留使用者目前在 UI 已選的值，避免 fetchModels race condition 覆蓋選擇
        var prevUiValue = modelSelect.value;
        modelSelect.innerHTML = '';
        var hasAny = false;
        var providerGroups = {};
        var providerOrder = [];
        var allIds = [];
        (models || []).forEach(function(model) {
          var provider = model.provider || inferProviderFromModelId(model.id);
          var groupKey = model.providerLabel || getProviderAppearance(provider).label;
          if (!providerGroups[groupKey]) { providerGroups[groupKey] = []; providerOrder.push(groupKey); }
          providerGroups[groupKey].push(model);
          allIds.push(model.id);
        });
        // 決定目標選擇：UI 原選擇 → msg.current → 第一個
        var targetValue = (prevUiValue && allIds.indexOf(prevUiValue) !== -1) ? prevUiValue : current;
        providerOrder.forEach(function(groupKey) {
          var grp = document.createElement('optgroup');
          grp.label = groupKey;
          providerGroups[groupKey].forEach(function(model) {
            var opt = document.createElement('option');
            opt.value = model.id;
            var thinkMark = modelSupportsThinking(model.id, model.label) ? ' \uD83D\uDCAD' : '';
            opt.textContent = model.label + thinkMark + (model.multiplier ? '  ' + model.multiplier : '');
            opt.dataset.provider = model.provider || inferProviderFromModelId(model.id);
            opt.dataset.providerLabel = model.providerLabel || getProviderAppearance(opt.dataset.provider).label;
            if (model.multiplier) opt.dataset.multiplier = model.multiplier;
            if (thinkMark) opt.dataset.thinking = '1';
            if (model.id === targetValue || model.label === targetValue) opt.selected = true;
            grp.appendChild(opt);
            hasAny = true;
          });
          modelSelect.appendChild(grp);
        });
        if (!modelSelect.value && hasAny) { var firstOpt = modelSelect.querySelector('option'); if (firstOpt) modelSelect.value = firstOpt.value; }
        // 同步影子督促模型選單（保留目前選擇）
        var shadowModelSelect = document.getElementById('shadowModelSelect');
        if (shadowModelSelect) {
          var prevShadow = shadowModelSelect.value;
          shadowModelSelect.innerHTML = '<option value="">\uD83D\uDD75\uFE0F \u540c\u4e3b\u4eba\u683c</option>';
          providerOrder.forEach(function(groupKey) {
            var sGrp = document.createElement('optgroup'); sGrp.label = groupKey;
            providerGroups[groupKey].forEach(function(model) {
              var sOpt = document.createElement('option'); sOpt.value = model.id;
              sOpt.textContent = model.label + (model.multiplier ? '  ' + model.multiplier : '');
              if (model.id === prevShadow) sOpt.selected = true;
              sGrp.appendChild(sOpt);
            });
            shadowModelSelect.appendChild(sGrp);
          });
          if (prevShadow && shadowModelSelect.value !== prevShadow) shadowModelSelect.value = '';
        }
        // 更新倍數標籤
        (function() {
          var selOpt = modelSelect.options[modelSelect.selectedIndex];
          var multEl = document.getElementById('modelMultiplier');
          if (multEl) multEl.textContent = selOpt && selOpt.dataset.multiplier ? selOpt.dataset.multiplier : '';
          applyProviderInfo({
            id: selOpt && selOpt.dataset.provider ? selOpt.dataset.provider : inferProviderFromModelId(modelSelect.value),
            label: selOpt && selOpt.dataset.providerLabel ? selOpt.dataset.providerLabel : '',
            modelId: modelSelect.value,
            displayName: selOpt ? selOpt.textContent : modelSelect.value
          });
        })();
        // 只有當選擇被迫 fallback（原 UI 選擇不在新清單中）才寫回設定，避免 race condition 覆蓋使用者選擇
        if (modelSelect.value && modelSelect.value !== prevUiValue) { vscode.postMessage({ type: 'saveModel', model: modelSelect.value }); }
      }

      function updateConnStatus(ok, url, message) {
        const el = document.getElementById('connStatus'); if (!el) return;
        el.style.color = ok ? 'var(--vscode-terminal-ansiGreen,green)' : 'var(--vscode-errorForeground,red)';
        el.textContent = (ok ? '\u2705 ' : '\u274c ') + url + (message && message !== 'OK' ? '  \u2014  ' + message : '');
      }

      const refreshBtn = document.getElementById('refreshModels');
      if (refreshBtn) refreshBtn.addEventListener('click', function() {
        const el = document.getElementById('connStatus');
        if (el) { el.style.color = ''; el.textContent = '\u23f3 \u9023\u7dda\uff1a\u6aa2\u67e5\u4e2d\u2026'; }
        vscode.postMessage({ type: 'fetchModels' });
      });

      // Tell backend the webview is ready; delay to ensure VS Code message bridge is initialized
      setTimeout(function() { dbg('posting webviewReady'); vscode.postMessage({ type: 'webviewReady' }); dbg('webviewReady posted'); }, 0);
      window.addEventListener('beforeunload', function() { saveActiveSessionSnapshot(); });

      // ── \u8a18\u61b6\u7ba1\u7406 Modal ──────────────────────────────────────────────────────
      function onMemoryLoaded(msg) {
        if (msg.sessionId && msg.sessionId !== _activeChatSessionId) return;
        var area = document.getElementById('ltmArea');
        if (area) area.value = msg.ltm || '';
        renderLtmEntries();
        var pp = document.getElementById('personaPreview');
        if (pp) pp.value = msg.persona || '(\u672a\u8a2d\u5b9a)';
        var hii = document.getElementById('historyInfo');
        if (hii) hii.textContent = '\u5c0d\u8a71\u6b77\u53f2\uff1a' + (msg.historyCount || 0) + ' \u689d\u8a0a\u606f';
        var hp = document.getElementById('historyPreview');
        if (hp) hp.value = msg.historyPreview || (msg.historyCount ? '（歷史存在但無預覽）' : '（目前沒有對話歷史）');
        if (msg.usageStats) { renderUsageTable(msg.usageStats); }
      }

      function renderUsageTable(stats) {
        var wrap = document.getElementById('usageTableWrap');
        if (!wrap) return;
        var keys = stats ? Object.keys(stats) : [];
        if (keys.length === 0) { wrap.innerHTML = '<p style="font-size:11px;opacity:0.55;margin:2px 0">尚無資料</p>'; return; }
        var html = '<table class="usage-table"><thead><tr><th>模型</th><th>Tokens</th><th>費率</th></tr></thead><tbody>';
        var totalTokens = 0;
        keys.forEach(function(k) {
          var v = stats[k];
          var mult = v.multiplier || (v.isCopilot ? '1x' : '-');
          var dispTokens = v.tokens.toLocaleString();
          totalTokens += v.tokens;
          var cls = v.isCopilot ? ' class="usage-copilot"' : '';
          html += '<tr' + cls + '><td>' + k + '</td><td>' + dispTokens + '</td><td>' + mult + '</td></tr>';
        });
        if (keys.length > 1) { html += '<tr style="font-weight:600;border-top:1px solid rgba(128,128,128,0.3)"><td>合計</td><td>' + totalTokens.toLocaleString() + '</td><td></td></tr>'; }
        html += '</tbody></table>';
        wrap.innerHTML = html;
      }

      var _latencyLog = [];
      function renderStatsUsageTable(stats) {
        var wrap = document.getElementById('statsUsageWrap');
        if (!wrap) return;
        var keys = stats ? Object.keys(stats) : [];
        if (keys.length === 0) { wrap.innerHTML = '<p style="font-size:11px;opacity:0.55;margin:2px 0">尚無資料</p>'; return; }
        var html = '<table class="usage-table"><thead><tr><th>\u6a21\u578b</th><th>Tokens</th><th>\u547c\u53eb\u6b21\u6578</th><th>\u5de5\u5177\u547c\u53eb</th><th>\u8cbb\u7387</th></tr></thead><tbody>';
        var totalTokens = 0; var totalCalls = 0; var totalTools = 0;
        keys.sort(function(a,b){ return (stats[b].tokens||0)-(stats[a].tokens||0); }).forEach(function(k) {
          var v = stats[k];
          var mult = v.multiplier || (v.isCopilot ? '1x' : '-');
          var cls = v.isCopilot ? ' class="usage-copilot"' : '';
          totalTokens += v.tokens||0; totalCalls += v.calls||0; totalTools += v.toolCalls||0;
          html += '<tr' + cls + '><td>' + k + '</td><td>' + (v.tokens||0).toLocaleString() + '</td><td>' + (v.calls||0) + '</td><td>' + (v.toolCalls||0) + '</td><td>' + mult + '</td></tr>';
        });
        if (keys.length > 1) {
          html += '<tr style="font-weight:600;border-top:1px solid rgba(128,128,128,0.3)"><td>\u5408\u8a08</td><td>' + totalTokens.toLocaleString() + '</td><td>' + totalCalls + '</td><td>' + totalTools + '</td><td></td></tr>';
        }
        html += '</tbody></table>';
        wrap.innerHTML = html;
      }
      function renderLatencyChart(log) {
        _latencyLog = log || [];
        var wrap = document.getElementById('statsLatencyWrap');
        if (!wrap) return;
        if (!_latencyLog.length) { wrap.innerHTML = '<p style="font-size:11px;opacity:0.55;margin:2px 0">\u5c1a\u7121\u8cc7\u6599</p>'; return; }
        // Aggregate by model: avg + min + max
        var byModel = {};
        _latencyLog.forEach(function(e) {
          if (!byModel[e.model]) byModel[e.model] = { sum:0, count:0, min:Infinity, max:0 };
          var m = byModel[e.model];
          m.sum += e.ms; m.count++; m.min = Math.min(m.min,e.ms); m.max = Math.max(m.max,e.ms);
        });
        var maxAvg = 0;
        Object.keys(byModel).forEach(function(k) { var avg = byModel[k].sum/byModel[k].count; if(avg>maxAvg) maxAvg=avg; });
        var html = '';
        Object.keys(byModel).sort(function(a,b){ return byModel[a].sum/byModel[a].count - byModel[b].sum/byModel[b].count; }).forEach(function(k) {
          var m = byModel[k]; var avg = Math.round(m.sum/m.count); var pct = maxAvg > 0 ? Math.round(avg/maxAvg*100) : 0;
          var color = avg < 3000 ? '#89d185' : avg < 10000 ? '#f7cc65' : '#f87070';
          html += '<div class="latency-bar-row"><div class="latency-bar-label" title="' + k + '">' + k + '</div>' +
            '<div class="latency-bar-track"><div class="latency-bar-fill" style="width:' + pct + '%;background:' + color + '"></div></div>' +
            '<div class="latency-bar-val">' + (avg >= 1000 ? (avg/1000).toFixed(1)+'s' : avg+'ms') + '</div>' +
            '<div style="font-size:10px;opacity:0.5;flex-shrink:0">\xd7' + m.count + '</div>' +
            '</div>';
        });
        // Recent 20 requests timeline
        var recent = _latencyLog.slice(-20);
        html += '<div style="margin-top:8px;font-size:10px;opacity:0.6">\u6700\u8fd1 ' + recent.length + ' \u7b46\uff1a</div>';
        html += '<div style="display:flex;gap:2px;align-items:flex-end;height:32px;margin-top:2px">';
        var rMax = 0; recent.forEach(function(e){ if(e.ms>rMax) rMax=e.ms; });
        recent.forEach(function(e) {
          var h = rMax > 0 ? Math.max(2, Math.round(e.ms/rMax*32)) : 2;
          var c = e.ms < 3000 ? '#89d185' : e.ms < 10000 ? '#f7cc65' : '#f87070';
          html += '<div title="' + e.model + ' ' + (e.ms >= 1000 ? (e.ms/1000).toFixed(1)+'s' : e.ms+'ms') + '" style="flex:1;height:' + h + 'px;background:' + c + ';border-radius:1px;min-width:2px;cursor:default"></div>';
        });
        html += '</div>';
        wrap.innerHTML = html;
      }

      var statsModal = document.getElementById('statsModal');
      var statsBtn = document.getElementById('statsBtn');
      if (statsBtn) statsBtn.addEventListener('click', function() {
        if (statsModal) statsModal.classList.add('open');
        vscode.postMessage({ type: 'statsOpen' });
      });
      var statsClose = document.getElementById('statsClose');
      if (statsClose) statsClose.addEventListener('click', function() { if (statsModal) statsModal.classList.remove('open'); });
      if (statsModal) statsModal.addEventListener('click', function(e) { if (e.target === statsModal) statsModal.classList.remove('open'); });
      var statsResetBtn = document.getElementById('statsResetBtn');
      if (statsResetBtn) statsResetBtn.addEventListener('click', function() { vscode.postMessage({ type: 'resetUsage' }); });

      // ── 模型管理 Modal ──────────────────────────────────────────────────────
      var modelMgmtModal = document.getElementById('modelMgmtModal');
      var manageModelsBtn = document.getElementById('manageModels');
      var modelMgmtClose = document.getElementById('modelMgmtClose');
      var mgmtServerSelect = document.getElementById('mgmtServerSelect');
      var mgmtPullInput = document.getElementById('mgmtPullInput');
      var mgmtPullBtn = document.getElementById('mgmtPullBtn');
      var mgmtPullProgress = document.getElementById('mgmtPullProgress');
      var mgmtModelList = document.getElementById('mgmtModelList');
      var _mgmtPulling = false;
      var _mgmtServers = []; // [{url, models:[]}]

      function renderMgmtModelList() {
        if (!mgmtModelList) return;
        var html = '';
        _mgmtServers.forEach(function(srv) {
          if (_mgmtServers.length > 1) {
            html += '<div style="font-size:10px;opacity:0.55;padding:2px 4px;margin-top:4px">' + srv.url + '</div>';
          }
          if (!srv.models || srv.models.length === 0) {
            html += '<div style="font-size:11px;opacity:0.45;padding:3px 6px">（無模型）</div>';
          } else {
            srv.models.forEach(function(m) {
              html += '<div class="mgmt-model-row">' +
                '<span class="mgmt-model-name">' + m.replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</span>' +
                '<button class="mgmt-delete-btn" data-url="' + srv.url.replace(/"/g,'&quot;') + '" data-model="' + m.replace(/"/g,'&quot;') + '">&#x1F5D1; 刪除</button>' +
                '</div>';
            });
          }
        });
        mgmtModelList.innerHTML = html || '<span style="font-size:11px;opacity:0.5">尚無資料</span>';
        mgmtModelList.querySelectorAll('.mgmt-delete-btn').forEach(function(btn) {
          btn.addEventListener('click', function() {
            var url = btn.getAttribute('data-url');
            var model = btn.getAttribute('data-model');
            if (!url || !model) return;
            // VS Code webview 不支援 confirm()，改用 row 內嵌確認
            var row = btn.closest('.mgmt-model-row');
            if (!row) return;
            // 若已有確認列，移除（取消）
            var existing = row.querySelector('.mgmt-confirm-row');
            if (existing) { existing.remove(); return; }
            var confirmDiv = document.createElement('div');
            confirmDiv.className = 'mgmt-confirm-row';
            confirmDiv.style.cssText = 'display:flex;align-items:center;gap:6px;margin-top:4px;font-size:11px;color:var(--vscode-errorForeground,#f48771)';
            confirmDiv.innerHTML = '<span>確定刪除？</span>' +
              '<button class="mgmt-delete-btn" style="background:rgba(220,80,80,0.35)">✔ 確認</button>' +
              '<button class="mem-btn" style="font-size:11px;padding:2px 8px">✕ 取消</button>';
            row.appendChild(confirmDiv);
            confirmDiv.querySelector('.mgmt-delete-btn').addEventListener('click', function() {
              confirmDiv.remove();
              btn.disabled = true;
              btn.textContent = '刪除中…';
              vscode.postMessage({ type: 'deleteOllamaModel', url: url, model: model });
            });
            confirmDiv.querySelector('.mem-btn').addEventListener('click', function() {
              confirmDiv.remove();
            });
          });
        });
      }

      function populateMgmtServerSelect() {
        if (!mgmtServerSelect) return;
        mgmtServerSelect.innerHTML = '';
        _mgmtServers.forEach(function(srv) {
          var opt = document.createElement('option');
          opt.value = srv.url;
          opt.textContent = srv.url;
          mgmtServerSelect.appendChild(opt);
        });
      }

      if (manageModelsBtn) {
        manageModelsBtn.addEventListener('click', function() {
          if (modelMgmtModal) modelMgmtModal.classList.add('open');
          if (mgmtModelList) mgmtModelList.innerHTML = '<span style="font-size:11px;opacity:0.5">載入中…</span>';
          if (mgmtPullProgress) mgmtPullProgress.textContent = '';
          vscode.postMessage({ type: 'listOllamaModelsForManage' });
        });
      }
      if (modelMgmtClose) modelMgmtClose.addEventListener('click', function() { if (modelMgmtModal) modelMgmtModal.classList.remove('open'); });
      if (modelMgmtModal) modelMgmtModal.addEventListener('click', function(e) { if (e.target === modelMgmtModal) modelMgmtModal.classList.remove('open'); });

      if (mgmtPullBtn) {
        mgmtPullBtn.addEventListener('click', function() {
          if (_mgmtPulling) return;
          var modelName = mgmtPullInput ? mgmtPullInput.value.trim() : '';
          var serverUrl = mgmtServerSelect ? mgmtServerSelect.value : '';
          if (!modelName) { if (mgmtPullProgress) mgmtPullProgress.textContent = '⚠️ 請輸入模型名稱'; return; }
          if (!serverUrl) { if (mgmtPullProgress) mgmtPullProgress.textContent = '⚠️ 無可用伺服器'; return; }
          _mgmtPulling = true;
          mgmtPullBtn.disabled = true;
          if (mgmtPullProgress) mgmtPullProgress.textContent = '⏳ 拉取中…';
          vscode.postMessage({ type: 'pullOllamaModel', url: serverUrl, model: modelName });
        });
      }
      if (mgmtPullInput) {
        mgmtPullInput.addEventListener('keydown', function(e) {
          if (e.key === 'Enter') { if (mgmtPullBtn) mgmtPullBtn.click(); }
        });
      }

      // 訊息處理：模型管理相關
      // 在 window.addEventListener('message') 的 catch block 之外無法直接插入，
      // 改由訊息分發處已在上方 msg handler 中以 else if 補充，
      // 這裡提供一個 helper 以便被那段 code 呼叫。
      window._onOllamaModelsForManage = function(servers) {
        _mgmtServers = servers || [];
        populateMgmtServerSelect();
        renderMgmtModelList();
      };
      window._onOllamaModelDeleted = function(model) {
        if (mgmtPullProgress) mgmtPullProgress.textContent = '✅ 已刪除：' + model;
        vscode.postMessage({ type: 'listOllamaModelsForManage' });
      };
      window._onOllamaModelDeleteError = function(model, err) {
        if (mgmtPullProgress) mgmtPullProgress.textContent = '❌ 刪除失敗：' + err;
        vscode.postMessage({ type: 'listOllamaModelsForManage' });
      };
      window._onOllamaModelPullProgress = function(model, status, pct) {
        if (mgmtPullProgress) {
          mgmtPullProgress.textContent = '⏳ ' + status + (pct !== null && pct !== undefined ? '  ' + pct + '%' : '');
        }
      };
      window._onOllamaModelPulled = function(model) {
        _mgmtPulling = false;
        if (mgmtPullBtn) mgmtPullBtn.disabled = false;
        if (mgmtPullProgress) mgmtPullProgress.textContent = '✅ 已完成：' + model;
        if (mgmtPullInput) mgmtPullInput.value = '';
        vscode.postMessage({ type: 'listOllamaModelsForManage' });
      };
      window._onOllamaModelPullError = function(model, err) {
        _mgmtPulling = false;
        if (mgmtPullBtn) mgmtPullBtn.disabled = false;
        if (mgmtPullProgress) mgmtPullProgress.textContent = '❌ 拉取失敗：' + err;
      };

      var memModal = document.getElementById('memModal');
      var memBtn = document.getElementById('memBtn');
      if (memBtn) {
        memBtn.addEventListener('click', function() {
          if (memModal) memModal.classList.add('open');
          vscode.postMessage({ type: 'memoryGet', sessionId: _activeChatSessionId });
        });
      }
      var memClose = document.getElementById('memClose');
      if (memClose) memClose.addEventListener('click', function() { if (memModal) memModal.classList.remove('open'); });
      if (memModal) memModal.addEventListener('click', function(e) { if (e.target === memModal) memModal.classList.remove('open'); });

      var saveLtmBtn = document.getElementById('saveLtmBtn');
      if (saveLtmBtn) saveLtmBtn.addEventListener('click', function() {
        var area = document.getElementById('ltmArea');
        vscode.postMessage({ type: 'memorySave', ltm: area ? area.value : '' });
      });
      var clearLtmBtn = document.getElementById('clearLtmBtn');
      if (clearLtmBtn) clearLtmBtn.addEventListener('click', function() {
        var area = document.getElementById('ltmArea');
        if (area) area.value = '';
        renderLtmEntries();
        vscode.postMessage({ type: 'memorySave', ltm: '' });
      });
      var resetUsageBtn = document.getElementById('resetUsageBtn');
      if (resetUsageBtn) resetUsageBtn.addEventListener('click', function() {
        vscode.postMessage({ type: 'resetUsage' });
      });
      var ltmSearch = document.getElementById('ltmSearch');
      if (ltmSearch) ltmSearch.addEventListener('input', function() {
        var q = ltmSearch.value.trim().toLowerCase();
        if (!q) { ltmSearch.style.color = ''; ltmSearch.title = ''; return; }
        var area = document.getElementById('ltmArea');
        var lines = area ? area.value.split('\\n') : [];
        var matched = lines.filter(function(l) { return l.toLowerCase().indexOf(q) >= 0; });
        ltmSearch.style.color = matched.length > 0 ? '' : 'var(--vscode-inputValidation-errorBorder,#f48771)';
        ltmSearch.title = matched.length > 0 ? matched.length + ' \u884c\u7b26\u5408' : '\u7121\u7b26\u5408\u7d50\u679c';
      });
      var exportLtmBtn = document.getElementById('exportLtmBtn');
      if (exportLtmBtn) exportLtmBtn.addEventListener('click', function() {
        var area = document.getElementById('ltmArea');
        var content = area ? area.value : '';
        var d = new Date();
        var ds = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
        var data = JSON.stringify({ version: 1, exportedAt: d.toISOString(), ltm: content }, null, 2);
        var blob = new Blob([data], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a'); a.href = url; a.download = 'ltm-backup-' + ds + '.json'; a.click(); URL.revokeObjectURL(url);
      });
      var importLtmBtn = document.getElementById('importLtmBtn');
      var importLtmInput = document.getElementById('importLtmInput');
      if (importLtmBtn && importLtmInput) {
        importLtmBtn.addEventListener('click', function() { importLtmInput.click(); });
        importLtmInput.addEventListener('change', function() {
          var file = importLtmInput.files && importLtmInput.files[0];
          if (!file) return;
          var reader = new FileReader();
          reader.onload = function(e) {
            try {
              var obj = JSON.parse(e.target.result);
              var ltmText = typeof obj.ltm === 'string' ? obj.ltm : JSON.stringify(obj, null, 2);
              var area = document.getElementById('ltmArea');
              if (area) area.value = ltmText;
              renderLtmEntries();
              importLtmBtn.textContent = '\u2713 \u5df2\u532f\u5165';
              setTimeout(function() { importLtmBtn.textContent = '\uD83D\uDCE5 \u532f\u5165 JSON'; }, 2000);
            } catch(ex) {
              importLtmBtn.textContent = '\u274C \u683c\u5f0f\u932f\u8aa4';
              setTimeout(function() { importLtmBtn.textContent = '\uD83D\uDCE5 \u532f\u5165 JSON'; }, 2000);
            }
          };
          reader.readAsText(file); importLtmInput.value = '';
        });
      }
      // ── LTM 條目編輯器 與 分類標籤 ──────────────────────────────────────────
      var _ltmFilterTag = '';
      function parseLtmToEntries(text) {
        var lines = (text || '').split('\\n'), entries = [];
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i].trim(); if (!line) continue;
          var m = line.match(/^#(\S+)\s+([\s\S]*)$/);
          if (m) { entries.push({ tag: m[1], text: m[2] }); }
          else { entries.push({ tag: '', text: line }); }
        }
        return entries;
      }
      function entriesToLtm(entries) {
        return entries.map(function(e) { return e.tag ? '#' + e.tag + ' ' + e.text : e.text; }).join('\\n');
      }
      function renderLtmEntries() {
        var area = document.getElementById('ltmArea');
        var entries = parseLtmToEntries(area ? area.value : '');
        var tagCounts = {};
        entries.forEach(function(e) { if (e.tag) tagCounts[e.tag] = (tagCounts[e.tag] || 0) + 1; });
        var filterDiv = document.getElementById('ltmTagFilter');
        if (filterDiv) {
          filterDiv.innerHTML = '';
          var allChip = document.createElement('span'); allChip.className = 'ltm-tag-chip all' + (_ltmFilterTag === '' ? ' active' : '');
          allChip.textContent = '\u5168\u90e8 (' + entries.length + ')';
          allChip.addEventListener('click', function() { _ltmFilterTag = ''; renderLtmEntries(); }); filterDiv.appendChild(allChip);
          Object.keys(tagCounts).sort().forEach(function(tag) {
            var chip = document.createElement('span'); chip.className = 'ltm-tag-chip' + (_ltmFilterTag === tag ? ' active' : '');
            chip.textContent = '#' + tag + ' (' + tagCounts[tag] + ')';
            (function(t) { chip.addEventListener('click', function() { _ltmFilterTag = t; renderLtmEntries(); }); })(tag);
            filterDiv.appendChild(chip);
          });
        }
        var list = document.getElementById('ltmEntryList'); if (!list) return;
        var filtered = _ltmFilterTag ? entries.filter(function(e) { return e.tag === _ltmFilterTag; }) : entries;
        list.innerHTML = '';
        if (!filtered.length) { list.innerHTML = '<span style="font-size:11px;opacity:0.5;padding:4px">' + (entries.length ? '\u7121\u7b26\u5408\u6a19\u7c64\u7684\u689d\u76ee' : '\u5c1a\u7121\u8a18\u61b6\u689d\u76ee') + '</span>'; return; }
        filtered.forEach(function(entry) {
          var actualIdx = entries.indexOf(entry);
          var row = document.createElement('div'); row.className = 'ltm-entry';
          var tagEl = document.createElement('button'); tagEl.className = 'ltm-entry-tag' + (entry.tag ? '' : ' no-tag');
          tagEl.textContent = entry.tag ? '#' + entry.tag : '\u2014';
          if (entry.tag) { (function(t) { tagEl.title = '\u7be9\u9078 #' + t; tagEl.addEventListener('click', function() { _ltmFilterTag = t; renderLtmEntries(); }); })(entry.tag); }
          var textEl = document.createElement('span'); textEl.className = 'ltm-entry-text'; textEl.textContent = entry.text; textEl.title = '\u9ede\u64ca\u7de8\u8f2f';
          (function(idx, e) { textEl.addEventListener('click', function() {
            var inp = prompt('\u7de8\u8f2f\u689d\u76ee\uff1a', e.text);
            if (inp !== null && inp.trim() !== '') {
              var all = parseLtmToEntries(document.getElementById('ltmArea') ? document.getElementById('ltmArea').value : '');
              all[idx].text = inp.trim();
              var ar = document.getElementById('ltmArea'); if (ar) ar.value = entriesToLtm(all);
              renderLtmEntries();
            }
          }); })(actualIdx, entry);
          var del = document.createElement('button'); del.className = 'ltm-entry-del'; del.textContent = '\u2715'; del.title = '\u522a\u9664';
          (function(idx) { del.addEventListener('click', function() {
            var all = parseLtmToEntries(document.getElementById('ltmArea') ? document.getElementById('ltmArea').value : '');
            all.splice(idx, 1);
            var ar = document.getElementById('ltmArea'); if (ar) ar.value = entriesToLtm(all);
            renderLtmEntries();
          }); })(actualIdx);
          row.appendChild(tagEl); row.appendChild(textEl); row.appendChild(del); list.appendChild(row);
        });
      }
      function switchLtmTab(mode) {
        var ev = document.getElementById('ltmEntryView'); var rv = document.getElementById('ltmRawView');
        var te = document.getElementById('ltmTabEntry'); var tr = document.getElementById('ltmTabRaw');
        if (mode === 'entry') {
          if (ev) ev.style.display = ''; if (rv) rv.style.display = 'none';
          if (te) te.classList.add('active'); if (tr) tr.classList.remove('active');
          renderLtmEntries();
        } else {
          if (ev) ev.style.display = 'none'; if (rv) rv.style.display = '';
          if (te) te.classList.remove('active'); if (tr) tr.classList.add('active');
        }
      }
      var ltmTabEntryBtn = document.getElementById('ltmTabEntry');
      if (ltmTabEntryBtn) ltmTabEntryBtn.addEventListener('click', function() { switchLtmTab('entry'); });
      var ltmTabRawBtn = document.getElementById('ltmTabRaw');
      if (ltmTabRawBtn) ltmTabRawBtn.addEventListener('click', function() { switchLtmTab('raw'); });
      var ltmAddBtn = document.getElementById('ltmAddBtn');
      if (ltmAddBtn) ltmAddBtn.addEventListener('click', function() {
        var tagInp = document.getElementById('ltmAddTag'); var textInp = document.getElementById('ltmAddText');
        var tag = tagInp ? tagInp.value.trim().replace(/^#+/, '').replace(/\s+/g, '_') : '';
        var text = textInp ? textInp.value.trim() : '';
        if (!text) { if (textInp) textInp.focus(); return; }
        var area = document.getElementById('ltmArea');
        var all = parseLtmToEntries(area ? area.value : '');
        all.push({ tag: tag, text: text });
        if (area) area.value = entriesToLtm(all);
        if (tagInp) tagInp.value = ''; if (textInp) textInp.value = '';
        renderLtmEntries();
      });
      var ltmAddTextEl = document.getElementById('ltmAddText');
      if (ltmAddTextEl) ltmAddTextEl.addEventListener('keydown', function(e) { if (e.key === 'Enter') { var b = document.getElementById('ltmAddBtn'); if (b) b.click(); } });
      var clearHistoryBtn2 = document.getElementById('clearHistoryBtn2');
      if (clearHistoryBtn2) clearHistoryBtn2.addEventListener('click', function() {
        chat.innerHTML = ''; _streamNode = null; _agentStepNode = null; _pendingBubble = null;
        var hp = document.getElementById('historyPreview'); if (hp) hp.value = '（已清除）';
        var hii = document.getElementById('historyInfo'); if (hii) hii.textContent = '對話歷史：0 條訊息';
        saveActiveSessionSnapshot();
        vscode.postMessage({ type: 'clearHistory', sessionId: _activeChatSessionId });
      });
      var consolidateLtmBtn = document.getElementById('consolidateLtmBtn');
      if (consolidateLtmBtn) consolidateLtmBtn.addEventListener('click', function() {
        vscode.postMessage({ type: 'memoryConsolidate', sessionId: _activeChatSessionId });
      });
      var editPersonaBtn = document.getElementById('editPersonaBtn');
      if (editPersonaBtn) editPersonaBtn.addEventListener('click', function() {
        vscode.postMessage({ type: 'openSettings' });
      });

      // JS-side safety net: if connectionStatus never arrives in 5s, ask again
      // ── Permission dialog ───────────────────────────────────────────────
      var _currentPermCategory = '';
      function buildUnifiedDiff(before, after) {
        var NO_BEFORE = !before && after;
        var bLines = NO_BEFORE ? [] : (before || '').split('\\n');
        var aLines = (after  || '').split('\\n');
        var result = [];
        var LIMIT = 300;
        var bi = 0, ai = 0;
        while (bi < bLines.length || ai < aLines.length) {
          if (result.length >= LIMIT) { result.push({ t: '~', s: '... (' + (bLines.length + aLines.length - bi - ai) + ' more lines)' }); break; }
          var bl = bi < bLines.length ? bLines[bi] : null;
          var al = ai < aLines.length ? aLines[ai] : null;
          if (bl === null) { result.push({ t: '+', s: al }); ai++; }
          else if (al === null) { result.push({ t: '-', s: bl }); bi++; }
          else if (bl === al) { result.push({ t: ' ', s: bl }); bi++; ai++; }
          else { result.push({ t: '-', s: bl }); result.push({ t: '+', s: al }); bi++; ai++; }
        }
        // Trim context: only keep lines near changes (+/-)
        var CTX = 3;
        var keep = {};
        for (var ri = 0; ri < result.length; ri++) {
          if (result[ri].t !== ' ') {
            for (var d = -CTX; d <= CTX; d++) { if (ri + d >= 0 && ri + d < result.length) keep[ri + d] = true; }
          }
        }
        var trimmed = [], lastKept = -1;
        for (var ri = 0; ri < result.length; ri++) {
          if (keep[ri]) {
            if (lastKept >= 0 && ri > lastKept + 1) trimmed.push({ t: '~', s: '' });
            trimmed.push(result[ri]);
            lastKept = ri;
          }
        }
        return trimmed.length > 0 ? trimmed : [{ t: ' ', s: '(no changes)' }];
      }

      function showDiffPanel(diff) {
        var panel = document.getElementById('permDiffPanel');
        if (!panel) return;
        if (!diff) { panel.classList.remove('has-diff'); return; }
        panel.classList.add('has-diff');
        var before = diff.before || '';
        var after  = diff.after  || '';
        // Unified pane
        var unifiedPre = document.querySelector('#diffPaneUnified pre');
        if (unifiedPre) {
          unifiedPre.innerHTML = '';
          var lines = buildUnifiedDiff(before, after);
          for (var li = 0; li < lines.length; li++) {
            var item = lines[li];
            var span = document.createElement('span');
            var prefix = item.t === '+' ? '+  ' : item.t === '-' ? '-  ' : item.t === '~' ? '   ' : '   ';
            span.className = item.t === '+' ? 'diff-line-add' : item.t === '-' ? 'diff-line-del' : 'diff-line-ctx';
            span.textContent = prefix + (item.s || '') + '\\n';
            unifiedPre.appendChild(span);
          }
        }
        // Before pane
        var beforePre = document.querySelector('#diffPaneBefore pre');
        if (beforePre) { beforePre.textContent = before || '(new file)'; }
        // After pane
        var afterPre = document.querySelector('#diffPaneAfter pre');
        if (afterPre) { afterPre.textContent = after; }
      }

      // Diff tab switching
      document.querySelectorAll('.diff-tab').forEach(function(tab) {
        tab.addEventListener('click', function() {
          var pane = this.dataset.pane;
          document.querySelectorAll('.diff-tab').forEach(function(t) { t.classList.remove('active'); });
          this.classList.add('active');
          document.querySelectorAll('.diff-pane').forEach(function(p) { p.classList.remove('active'); });
          var target = document.getElementById('diffPane' + pane.charAt(0).toUpperCase() + pane.slice(1));
          if (target) target.classList.add('active');
        });
      });

      function showPermissionBar(category, description, forceConfirm, diff) {
        _currentPermCategory = category || '';
        var bar = document.getElementById('permissionBar');
        var desc = document.getElementById('permissionDesc');
        if (!bar || !desc) return;
        var catLabel = { write: '\uD83D\uDCBE \u5beb\u5165\u6a94\u6848', delete: '\uD83D\uDDD1 \u522a\u9664\u6a94\u6848', run: '\u25B6\uFE0F \u57f7\u884c\u6307\u4ee4' }[category] || '\u26A0\uFE0F \u654f\u611f\u64cd\u4f5c';
        desc.textContent = catLabel + '\uff1a' + description;
        bar.classList.add('visible');
        var permAlwaysEl = document.getElementById('permAlways');
        if (permAlwaysEl) { permAlwaysEl.style.display = forceConfirm ? 'none' : ''; }
        showDiffPanel(diff || null);
      }
      function hidePermissionBar() {
        var bar = document.getElementById('permissionBar');
        if (bar) bar.classList.remove('visible');
        var panel = document.getElementById('permDiffPanel');
        if (panel) panel.classList.remove('has-diff');
        _currentPermCategory = '';
      }
      var permAllow = document.getElementById('permAllow');
      var permAlways = document.getElementById('permAlways');
      var permDeny = document.getElementById('permDeny');
      if (permAllow) permAllow.addEventListener('click', function() {
        var cat = _currentPermCategory;
        hidePermissionBar();
        vscode.postMessage({ type: 'permissionResponse', allow: true, always: false, category: cat });
      });
      if (permAlways) permAlways.addEventListener('click', function() {
        var cat = _currentPermCategory;
        hidePermissionBar();
        vscode.postMessage({ type: 'permissionResponse', allow: true, always: true, category: cat });
      });
      var permSession = document.getElementById('permSession');
      if (permSession) permSession.addEventListener('click', function() {
        hidePermissionBar();
        vscode.postMessage({ type: 'permissionResponse', allow: true, always: false, alwaysSession: true, category: 'all' });
      });
      if (permDeny) permDeny.addEventListener('click', function() {
        var cat = _currentPermCategory;
        hidePermissionBar();
        vscode.postMessage({ type: 'permissionResponse', allow: false, always: false, category: cat });
      });

      // ── 權限模式 dropdown：手動 / AutoPilot / 全自動（三檔互斥） ─────────────────
      var permModeSelect = document.getElementById('permModeSelect');
      function setPermModeUi(mode) {
        if (!permModeSelect) return;
        if (permModeSelect.value !== mode) { permModeSelect.value = mode; }
      }
      // host 推送：以 autoApprove 為優先（YOLO 蓋過 AutoPilot）
      function applyPermModeFromFlags(autoPilotEnabled, autoApproveEnabled) {
        if (autoApproveEnabled) { setPermModeUi('yolo'); }
        else if (autoPilotEnabled) { setPermModeUi('autopilot'); }
        else { setPermModeUi('manual'); }
      }
      if (permModeSelect) {
        permModeSelect.addEventListener('change', function() {
          var v = permModeSelect.value;
          // 三檔互斥：切換時兩個 flag 都明確設定，避免殘留舊狀態
          var wantAutoPilot = (v === 'autopilot');
          var wantAutoApprove = (v === 'yolo');
          vscode.postMessage({ type: 'autoPilot', enabled: wantAutoPilot });
          vscode.postMessage({ type: 'autoApproveWrite', enabled: wantAutoApprove });
        });
      }

      // ── 思考等級 dropdown：off / low / medium / high ────────────────────────────
      var thinkLevelSelect = document.getElementById('thinkLevelSelect');
      function setThinkLevelUi(level) {
        if (!thinkLevelSelect) return;
        var v = (level === 'off' || level === 'low' || level === 'medium' || level === 'high') ? level : 'medium';
        if (thinkLevelSelect.value !== v) { thinkLevelSelect.value = v; }
      }
      if (thinkLevelSelect) {
        thinkLevelSelect.addEventListener('change', function() {
          vscode.postMessage({ type: 'thinkLevel', level: thinkLevelSelect.value });
        });
      }

      // ── 深度解析 dropdown：file / outline / full ─────────────────────────────────
      var contextDepthSelect = document.getElementById('contextDepthSelect');
      function setContextDepthUi(depth) {
        if (!contextDepthSelect) return;
        var v = (depth === 'outline' || depth === 'full') ? depth : 'file';
        if (contextDepthSelect.value !== v) { contextDepthSelect.value = v; }
      }
      if (contextDepthSelect) {
        contextDepthSelect.addEventListener('change', function() {
          vscode.postMessage({ type: 'contextDepth', depth: contextDepthSelect.value });
        });
      }

      // ── 影子督促觸發詞 ───────────────────────────────────────────────────────────
      var shadowKeywordsInput = document.getElementById('shadowKeywordsInput');
      function _commitShadowKeywords() {
        if (!shadowKeywordsInput) return;
        var kws = shadowKeywordsInput.value.split(',').map(function(s) { return s.trim(); }).filter(function(s) { return s.length > 0; });
        vscode.postMessage({ type: 'updateShadowKeywords', keywords: kws });
      }
      if (shadowKeywordsInput) {
        shadowKeywordsInput.addEventListener('blur', _commitShadowKeywords);
        shadowKeywordsInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') { e.preventDefault(); _commitShadowKeywords(); shadowKeywordsInput.blur(); } });
      }

      // ── 修改記錄 Listbox ─────────────────────────────────────────────────────────
      var _fileMods = [];
      var _shadowSessionActive = false; // true 表示有真實的 SandboxManager session 在作業
      var fileModPanel = document.getElementById('fileModPanel');
      var fileModBtn = document.getElementById('fileModBtn');
      if (fileModBtn) {
        fileModBtn.addEventListener('click', function() {
          if (!fileModPanel) return;
          var vis = fileModPanel.classList.toggle('visible');
          fileModBtn.classList.toggle('active', vis);
        });
      }
      var fileModClear = document.getElementById('fileModClear');
      if (fileModClear) {
        fileModClear.addEventListener('click', function() {
          _fileMods = [];
          renderFileMods();
        });
      }
      var _fileModSelected = new Set();
      function updateBatchBar() {
        var bar = document.getElementById('fileModBatchBar');
        var selCountEl = document.getElementById('fileModSelCount');
        var saEl = document.getElementById('fileModSelectAll');
        if (bar) bar.classList.toggle('visible', _fileModSelected.size > 0);
        if (selCountEl) selCountEl.textContent = '已選 ' + _fileModSelected.size;
        if (saEl) saEl.indeterminate = _fileModSelected.size > 0 && _fileModSelected.size < _fileMods.length;
        if (saEl) saEl.checked = _fileMods.length > 0 && _fileModSelected.size === _fileMods.length;
        // 同步 DOM 選中狀態
        var list = document.getElementById('fileModList');
        if (list) list.querySelectorAll('.filemod-item').forEach(function(el) {
          var idx = parseInt(el.getAttribute('data-idx') || '0');
          el.classList.toggle('selected', _fileModSelected.has(idx));
          var cb = el.querySelector('.filemod-cb');
          if (cb) cb.checked = _fileModSelected.has(idx);
        });
      }
      function renderFileMods() {
        var list = document.getElementById('fileModList');
        var countEl = document.getElementById('fileModCount');
        if (!list) return;
        if (countEl) countEl.textContent = _fileMods.length + ' \u9805';
        if (_fileMods.length === 0) {
          list.innerHTML = '<div class="filemod-empty">\u5c1a\u7121\u4fee\u6539\u8a18\u9304</div>';
          _fileModSelected.clear();
          updateBatchBar();
          return;
        }
        for (var _si of Array.from(_fileModSelected)) { if (_si >= _fileMods.length) _fileModSelected.delete(_si); }
        list.innerHTML = '';
        function escHtmlFM(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
        _fileMods.forEach(function(m, i) {
          var fname = (m.filePath || '?').replace(/\\\\/g, '/').split('/').pop();
          var t = new Date(m.ts || Date.now()).toLocaleTimeString('zh-TW', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
          var opLabel = { write: '\u5beb\u5165', replace: '\u66ff\u63db', insert: '\u63d2\u5165', delete: '\u522a\u9664', rename: '\u6539\u540d' }[m.op] || (m.op || '?');
          var isSel = _fileModSelected.has(i);
          // 外層包裝（row + diff wrap）
          var wrap = document.createElement('div');
          wrap.dataset.wrapIdx = String(i);
          var el = document.createElement('div');
          el.className = 'filemod-item' + (isSel ? ' selected' : '');
          el.dataset.idx = String(i); el.title = m.filePath || '';
          var cb = document.createElement('input'); cb.type = 'checkbox'; cb.className = 'filemod-cb';
          cb.setAttribute('data-idx', String(i)); if (isSel) cb.checked = true; cb.title = '\u9078\u53d6';
          cb.addEventListener('click', function(e) { e.stopPropagation(); });
          cb.addEventListener('change', function(e) {
            e.stopPropagation();
            var idx = parseInt(cb.getAttribute('data-idx') || '0');
            if (cb.checked) { _fileModSelected.add(idx); } else { _fileModSelected.delete(idx); }
            updateBatchBar();
          });
          var opSpan = document.createElement('span'); opSpan.className = 'filemod-op ' + (m.op || ''); opSpan.textContent = opLabel;
          var nameSpan = document.createElement('span'); nameSpan.className = 'filemod-name'; nameSpan.textContent = fname;
          // +N / -M stat
          var hasStat = (m.linesAdded > 0 || m.linesRemoved > 0);
          var statSpan = document.createElement('span'); statSpan.className = 'filemod-stat';
          if (hasStat) {
            if (m.linesAdded > 0) { var a = document.createElement('span'); a.className = 'st-add'; a.textContent = '+' + m.linesAdded; statSpan.appendChild(a); }
            if (m.linesAdded > 0 && m.linesRemoved > 0) { statSpan.appendChild(document.createTextNode('\\u2009/\\u2009')); }
            if (m.linesRemoved > 0) { var d = document.createElement('span'); d.className = 'st-del'; d.textContent = '-' + m.linesRemoved; statSpan.appendChild(d); }
          }
          var timeSpan = document.createElement('span'); timeSpan.className = 'filemod-time'; timeSpan.textContent = t;
          // 動作按鈕
          var acts = document.createElement('div'); acts.className = 'shadow-file-acts';
          if (m.shadow && m.shadow !== m.filePath) {
            var applyBtn = document.createElement('button'); applyBtn.className = 'shadow-file-btn'; applyBtn.textContent = '\uD83D\uDCCB \u5957\u7528\u5230\u6a94\u6848';
            applyBtn.addEventListener('click', function(e) { e.stopPropagation(); vscode.postMessage({ type: 'shadowApplyFile', original: m.filePath, shadow: m.shadow }); });
            acts.appendChild(applyBtn);
          }
          var diffBtn = document.createElement('button'); diffBtn.className = 'shadow-file-btn'; diffBtn.textContent = '\uD83D\uDD0D \u6BD4\u5C0D';
          diffBtn.title = '\u8207 git HEAD \u6BD4\u5C0D';
          diffBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            if (m.shadow && m.shadow !== m.filePath) {
              vscode.postMessage({ type: 'shadowInspectFile', original: m.filePath, shadow: m.shadow });
            } else {
              vscode.postMessage({ type: 'diffWithGit', filePath: m.filePath });
            }
          });
          acts.appendChild(diffBtn);
          el.appendChild(cb); el.appendChild(opSpan); el.appendChild(nameSpan); el.appendChild(statSpan); el.appendChild(timeSpan); el.appendChild(acts);
          // inline diff 展開區
          var diffWrap = document.createElement('div'); diffWrap.className = 'filemod-diff-wrap';
          if (m.patch) {
            var pre = document.createElement('pre'); pre.className = 'filemod-diff-pre';
            pre.innerHTML = m.patch.split('\\n').map(function(line) {
              if (line.startsWith('+') && !line.startsWith('+++')) return '<span class="diff-add">' + escHtmlFM(line) + '</span>';
              if (line.startsWith('-') && !line.startsWith('---')) return '<span class="diff-del">' + escHtmlFM(line) + '</span>';
              if (line.startsWith('@@')) return '<span class="diff-hunk">' + escHtmlFM(line) + '</span>';
              return escHtmlFM(line);
            }).join('\\n');
            diffWrap.appendChild(pre);
          }
          el.addEventListener('click', function(e) {
            if (e.target === cb || e.target.closest && e.target.closest('.shadow-file-acts')) return;
            var idx = parseInt(el.dataset.idx || '0');
            if (e.shiftKey && _fileModSelected.size > 0) {
              var last = Math.max.apply(null, Array.from(_fileModSelected));
              var lo = Math.min(idx, last), hi = Math.max(idx, last);
              for (var _ri = lo; _ri <= hi; _ri++) _fileModSelected.add(_ri);
              updateBatchBar(); return;
            }
            var mod = _fileMods[idx];
            if (mod && mod.patch) {
              diffWrap.classList.toggle('open');
            } else if (mod && mod.filePath) {
              vscode.postMessage({ type: 'openFile', filePath: mod.filePath });
            }
          });
          wrap.appendChild(el); wrap.appendChild(diffWrap);
          list.appendChild(wrap);
        });
        updateBatchBar();
      }
      // 全選 checkbox
      var fileModSelectAll = document.getElementById('fileModSelectAll');
      if (fileModSelectAll) {
        fileModSelectAll.addEventListener('change', function() {
          if (fileModSelectAll.checked) { _fileMods.forEach(function(_, i) { _fileModSelected.add(i); }); }
          else { _fileModSelected.clear(); }
          renderFileMods();
        });
      }
      // 批次操作按鈕
      var fileModBatchOpen = document.getElementById('fileModBatchOpen');
      if (fileModBatchOpen) fileModBatchOpen.addEventListener('click', function() {
        Array.from(_fileModSelected).forEach(function(i) {
          var m = _fileMods[i]; if (m && m.filePath) vscode.postMessage({ type: 'openFile', filePath: m.filePath });
        });
      });
      var fileModBatchDiff = document.getElementById('fileModBatchDiff');
      if (fileModBatchDiff) fileModBatchDiff.addEventListener('click', function() {
        var sel = Array.from(_fileModSelected).sort(function(a,b){return a-b;});
        if (sel.length < 2) {
          var m = _fileMods[sel[0]]; if (m && m.filePath) vscode.postMessage({ type: 'openFile', filePath: m.filePath });
          return;
        }
        for (var _di2 = 0; _di2 < sel.length - 1; _di2++) {
          var ma = _fileMods[sel[_di2]], mb = _fileMods[sel[_di2+1]];
          if (ma && mb && ma.filePath && mb.filePath) {
            vscode.postMessage({ type: 'diffFiles', pathA: ma.filePath, pathB: mb.filePath });
          }
        }
      });
      var fileModBatchClear = document.getElementById('fileModBatchClear');
      if (fileModBatchClear) fileModBatchClear.addEventListener('click', function() {
        var indices = Array.from(_fileModSelected).sort(function(a,b){return b-a;});
        indices.forEach(function(i) { _fileMods.splice(i, 1); });
        _fileModSelected.clear();
        renderFileMods();
      });

      var waQrCancelBtn = document.getElementById('waQrCancelBtn');
      if (waQrCancelBtn) waQrCancelBtn.addEventListener('click', function() {
        var _wqm = document.getElementById('waQrModal'); if (_wqm) _wqm.classList.remove('visible');
        vscode.postMessage({ type: 'waDisconnect' });
      });
      var waDiscBtn = document.getElementById('waDiscBtn');
      if (waDiscBtn) waDiscBtn.addEventListener('click', function() {
        vscode.postMessage({ type: 'waDisconnect' });
      });

      var debugBtnEl = document.getElementById('debugBtn');
      dbg('debugBtn found: ' + !!debugBtnEl);
      if (debugBtnEl) {
        debugBtnEl.addEventListener('click', function() {
          var dp = document.getElementById('debugPanel');
          if (!dp) return;
          if (dp.style.display === 'none') {
            dp.style.display = 'block';
            dp.textContent = (window._debugLog || ['(no logs)']).join('\\n');
            dp.scrollTop = dp.scrollHeight;
          } else {
            dp.style.display = 'none';
          }
        });
      }
      dbg('connStatus initial: ' + (document.getElementById('connStatus') || {}).textContent);
      dbg('script completed OK, all functions defined');

      setTimeout(function() {
        dbg('safety-net timer fired, connStatus=' + ((document.getElementById('connStatus') || {}).textContent || '?'));
        var el = document.getElementById('connStatus');
        if (el && el.textContent.indexOf('\u6aa2\u67e5\u4e2d') !== -1) {
          vscode.postMessage({ type: 'fetchModels' });
        }
      }, 5000);
    </script>
  </body>
</html>`;
}
