// Copyright (c) 2026 YCHsu. All rights reserved.
// Licensed under the MIT License.

/**
 * Carry-over 追蹤狀態（仿 OpenHarness tool_metadata），於對話被自動摘要時
 * 注入到摘要訊息結尾，避免關鍵上下文遺失。
 */
export interface CarryoverState {
  recentReadFiles: Array<{ path: string; span: string; preview: string }>;  // max 6
  recentWorkLog:   string[];  // max 10
  taskGoal:        string;
  recentGoals:     string[];  // max 5
  activeArtifacts: string[];  // max 8
  verifiedWork:    string[];  // max 10
  invokedTools:    string[];  // max 12
}

function cappedPush<T>(arr: T[], val: T, max: number): void {
  const idx = arr.indexOf(val);
  if (idx !== -1) { arr.splice(idx, 1); }
  arr.push(val);
  if (arr.length > max) { arr.shift(); }
}

export class AgentCarryover {
  private _state: CarryoverState = {
    recentReadFiles: [],
    recentWorkLog: [],
    taskGoal: '',
    recentGoals: [],
    activeArtifacts: [],
    verifiedWork: [],
    invokedTools: [],
  };

  public reset(): void {
    this._state = {
      recentReadFiles: [], recentWorkLog: [], taskGoal: '', recentGoals: [],
      activeArtifacts: [], verifiedWork: [], invokedTools: [],
    };
  }

  public setTaskGoal(goal: string): void {
    if (goal && goal !== this._state.taskGoal) {
      if (this._state.taskGoal) { cappedPush(this._state.recentGoals, this._state.taskGoal, 5); }
      this._state.taskGoal = goal;
    }
  }

  public track(toolName: string, args: Record<string, unknown>, output: string, isError: boolean): void {
    if (isError) { return; }
    const path = (args.path ?? args.src ?? args.command ?? '') as string;
    if (path) { cappedPush(this._state.activeArtifacts, path.slice(0, 240), 8); }
    cappedPush(this._state.invokedTools, toolName, 12);

    if (toolName === 'read_file' || toolName === 'read_file_smart') {
      const preview = output.split('\n').slice(0, 4).map(l => l.trim()).filter(Boolean).join(' | ').slice(0, 200);
      const span = args.start_line ? `L${args.start_line}-${args.end_line ?? '∞'}` : (args.head ? `head:${args.head}` : '');
      cappedPush(this._state.recentReadFiles, { path: String(path), span, preview }, 6);
      cappedPush(this._state.verifiedWork, `讀取 ${path}${span ? ' (' + span + ')' : ''}`, 10);
      cappedPush(this._state.recentWorkLog, `read_file: ${path}`, 10);
    } else if (toolName === 'run_command' || toolName === 'run_terminal') {
      const cmd = (args.command as string || '').slice(0, 160);
      const out = output.split('\n')[0].trim().slice(0, 100);
      cappedPush(this._state.verifiedWork, `執行指令: ${cmd} [${out}]`, 10);
      cappedPush(this._state.recentWorkLog, `run: ${cmd}`, 10);
    } else if (toolName === 'run_python') {
      const desc = (args.description as string || '').slice(0, 120);
      cappedPush(this._state.recentWorkLog, `python: ${desc}`, 10);
    } else if (['write_file', 'replace_in_file', 'replace_all_in_file', 'insert_in_file', 'batch_replace'].includes(toolName)) {
      cappedPush(this._state.verifiedWork, `修改檔案: ${path}`, 10);
      cappedPush(this._state.recentWorkLog, `edit: ${path}`, 10);
    } else if (toolName === 'search_workspace' || toolName === 'search_regex') {
      const q = (args.query ?? args.pattern ?? '') as string;
      cappedPush(this._state.recentWorkLog, `search: ${String(q).slice(0, 120)}`, 10);
    } else if (toolName === 'glob') {
      cappedPush(this._state.recentWorkLog, `glob: ${(args.pattern as string || '').slice(0, 120)}`, 10);
    }
  }

  public buildAttachments(): string {
    const c = this._state;
    const sections: string[] = [];
    if (c.taskGoal) { sections.push(`**當前目標：** ${c.taskGoal}`); }
    if (c.recentGoals.length) { sections.push(`**最近目標：**\n${c.recentGoals.slice(-3).map(g => `- ${g}`).join('\n')}`); }
    if (c.recentReadFiles.length) {
      sections.push(`**最近讀取的檔案：**\n${c.recentReadFiles.map(f => `- ${f.path}${f.span ? ' (' + f.span + ')' : ''}${f.preview ? '\n  Preview: ' + f.preview : ''}`).join('\n')}`);
    }
    if (c.verifiedWork.length) { sections.push(`**已驗證的操作：**\n${c.verifiedWork.slice(-6).map(w => `- ${w}`).join('\n')}`); }
    if (c.recentWorkLog.length) { sections.push(`**最近執行記錄：**\n${c.recentWorkLog.slice(-8).map(w => `- ${w}`).join('\n')}`); }
    if (c.activeArtifacts.length) { sections.push(`**活躍 artifacts：**\n${c.activeArtifacts.slice(-5).map(a => `- ${a}`).join('\n')}`); }
    return sections.length ? `\n\n[壓縮前狀態快照]\n${sections.join('\n\n')}` : '';
  }
}
