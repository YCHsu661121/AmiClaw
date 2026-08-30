// Copyright (c) 2026 YCHsu. All rights reserved.
// Licensed under the MIT License.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { exec } from 'child_process';
import type { IToolProvider, ToolExecutionContext } from './IToolProvider';

const TOOLS = new Set([
  'computer_screenshot',
  'computer_type',
  'computer_key',
  'computer_click',
  'computer_scroll',
  'computer_clipboard_read',
  'computer_clipboard_write',
]);

export class ComputerUseProvider implements IToolProvider {
  readonly tools: ReadonlySet<string> = TOOLS;

  execute(name: string, args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
    switch (name) {
      case 'computer_screenshot':      return this._screenshot(args);
      case 'computer_type':            return this._type(args, ctx);
      case 'computer_key':             return this._key(args, ctx);
      case 'computer_click':           return this._click(args, ctx);
      case 'computer_scroll':          return this._scroll(args, ctx);
      case 'computer_clipboard_read':  return this._clipRead();
      case 'computer_clipboard_write': return this._clipWrite(args, ctx);
      default: return Promise.resolve(`ComputerUseProvider: unknown "${name}"`);
    }
  }

  // ── pyautogui helper: writes code to tmp file, runs Python ──────────────

  private _pyauto(code: string): Promise<string> {
    const tmpFile = path.join(os.tmpdir(), `ami_computer_${Date.now()}.py`);
    try {
      fs.writeFileSync(tmpFile, code, 'utf8');
    } catch (e) {
      return Promise.resolve(`錯誤：無法建立暫存檔案 — ${e}`);
    }
    return new Promise(resolve => {
      const cmds = process.platform === 'win32'
        ? ['py', 'python', 'python3']
        : ['python3', 'python'];
      let tried = 0;
      const tryNext = () => {
        if (tried >= cmds.length) {
          _cleanup(tmpFile);
          resolve('錯誤：找不到 Python（pip install pyautogui pillow mss）');
          return;
        }
        const c = cmds[tried++];
        exec(`${c} "${tmpFile}"`, { timeout: 20_000 }, (err, stdout, stderr) => {
          if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') { tryNext(); return; }
          _cleanup(tmpFile);
          const out = (stdout || '').trim();
          const err2 = (stderr || '').trim();
          resolve(out || (err2 ? `[stderr] ${err2}` : '✅ 完成'));
        });
      };
      tryNext();
    });
  }

  // ── computer_screenshot ──────────────────────────────────────────────────

  private async _screenshot(args: Record<string, unknown>): Promise<string> {
    const wsRoot = (vscode.workspace.workspaceFolders ?? [])[0]?.uri.fsPath ?? process.cwd();
    const rawPath = args.save_path as string
      || path.join(wsRoot, '.amiclaw', 'outputs', `screenshot_${Date.now()}.png`);
    const savePath = rawPath.replace(/\\/g, '/');  // Python accepts forward slashes on Windows

    const outputDir = path.dirname(rawPath);
    try { fs.mkdirSync(outputDir, { recursive: true }); } catch { /* ignore */ }

    // Optional region: [left, top, width, height]
    const region = args.region as number[] | undefined;
    const regionArg = region && region.length === 4
      ? `region=(${region[0]},${region[1]},${region[2]},${region[3]})`
      : '';

    const code = [
      'import pyautogui',
      `img = pyautogui.screenshot(${regionArg})`,
      `img.save('${savePath}')`,
      `print(f"Saved: ${savePath} ({img.width}x{img.height})")`,
    ].join('\n');

    const result = await this._pyauto(code);
    return result.startsWith('錯誤') ? result : `📸 ${result}`;
  }

  // ── computer_type ────────────────────────────────────────────────────────

  private async _type(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
    const text = String(args.text ?? '');
    if (!text) return 'text 為必填';
    const allowed = await ctx.requestPermission('any', `電腦輸入文字（${text.slice(0, 40)}）`, 'computer_type');
    if (!allowed) return '使用者已拒絕';
    const interval = Number(args.interval ?? 0.02);

    // Use clipboard paste for unicode compatibility
    const code = [
      'import pyperclip, pyautogui',
      `pyperclip.copy(${JSON.stringify(text)})`,
      'pyautogui.hotkey("ctrl", "v")',
      'print("done")',
    ].join('\n');
    // Fallback to typewrite if pyperclip unavailable
    const fallback = [
      'import pyautogui',
      `pyautogui.write(${JSON.stringify(text)}, interval=${interval})`,
      'print("done")',
    ].join('\n');
    const result = await this._pyauto(code);
    if (result.includes('ModuleNotFoundError') || result.includes('No module')) {
      return this._pyauto(fallback);
    }
    return result;
  }

  // ── computer_key ─────────────────────────────────────────────────────────

  private async _key(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
    const key = String(args.key ?? '').trim();
    if (!key) return 'key 為必填（例如 "enter", "ctrl+s", "alt+f4"）';
    const allowed = await ctx.requestPermission('any', `按鍵: ${key}`, 'computer_key');
    if (!allowed) return '使用者已拒絕';

    let code: string;
    if (key.includes('+')) {
      const parts = key.split('+').map(k => JSON.stringify(k.trim())).join(', ');
      code = `import pyautogui\npyautogui.hotkey(${parts})\nprint("done")`;
    } else {
      code = `import pyautogui\npyautogui.press(${JSON.stringify(key)})\nprint("done")`;
    }
    return this._pyauto(code);
  }

  // ── computer_click ───────────────────────────────────────────────────────

  private async _click(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
    const x = Number(args.x ?? 0);
    const y = Number(args.y ?? 0);
    const button = String(args.button ?? 'left');
    const clicks = Number(args.clicks ?? 1);
    const allowed = await ctx.requestPermission('any', `滑鼠點擊 (${x}, ${y}) ${button}`, 'computer_click');
    if (!allowed) return '使用者已拒絕';

    const code = [
      'import pyautogui',
      `pyautogui.click(${x}, ${y}, button=${JSON.stringify(button)}, clicks=${clicks})`,
      'print("done")',
    ].join('\n');
    return this._pyauto(code);
  }

  // ── computer_scroll ──────────────────────────────────────────────────────

  private async _scroll(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
    const x = Number(args.x ?? 0);
    const y = Number(args.y ?? 0);
    const clicks = Number(args.clicks ?? 3);
    const direction = String(args.direction ?? 'down');
    const amount = direction === 'up' ? Math.abs(clicks) : -Math.abs(clicks);
    const allowed = await ctx.requestPermission('any', `滑鼠滾動 (${x},${y}) ${direction} ${clicks}`, 'computer_scroll');
    if (!allowed) return '使用者已拒絕';

    const code = [
      'import pyautogui',
      `pyautogui.scroll(${amount}, x=${x}, y=${y})`,
      'print("done")',
    ].join('\n');
    return this._pyauto(code);
  }

  // ── clipboard ────────────────────────────────────────────────────────────

  private async _clipRead(): Promise<string> {
    const text = await vscode.env.clipboard.readText();
    if (!text) return '（剪貼板為空）';
    return text.length > 4000
      ? text.slice(0, 4000) + `\n…（已截斷，共 ${text.length} 字元）`
      : text;
  }

  private async _clipWrite(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
    const text = String(args.text ?? '');
    const allowed = await ctx.requestPermission('any', `寫入剪貼板（${text.slice(0, 40)}）`, 'computer_clipboard_write');
    if (!allowed) return '使用者已拒絕';
    await vscode.env.clipboard.writeText(text);
    return `✅ 已寫入剪貼板（${text.length} 字元）`;
  }
}

function _cleanup(f: string) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
