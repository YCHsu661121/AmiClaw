// Copyright (c) 2026 YCHsu. All rights reserved.
// Licensed under the MIT License.

import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { URL } from 'url';
import { runDockerPython } from './DockerHelpers';
import type { IToolProvider, ToolExecutionContext } from './IToolProvider';

const TOOLS = new Set(['fetch_url','open_browser','http_request','browser_navigate','browser_screenshot','browser_script']);

export class NetworkProvider implements IToolProvider {
  readonly tools: ReadonlySet<string> = TOOLS;

  execute(name: string, args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
    switch (name) {
      case 'fetch_url':         return this._fetchUrl(args);
      case 'open_browser':      return this._openBrowser(args);
      case 'http_request':      return this._httpRequest(args, ctx);
      case 'browser_navigate':  return this._browserNavigate(args, ctx);
      case 'browser_screenshot':return this._browserScreenshot(args, ctx);
      case 'browser_script':    return this._browserScript(args, ctx);
      default: return Promise.resolve(`NetworkProvider: unknown tool "${name}"`);
    }
  }

  private _fetchUrl(args: Record<string, unknown>): Promise<string> {
    const rawUrl = (args.url as string || '').trim();
    if (!rawUrl) return Promise.resolve('請提供 url 參數');
    try { new URL(rawUrl); } catch { return Promise.resolve(`無效的 URL: ${rawUrl}`); }
    return new Promise<string>(resolve => {
      const protocol = rawUrl.startsWith('https') ? https : http;
      let buf = '';
      const req = protocol.get(rawUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (AmiClaw-Agent)' } }, res => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { resolve(`重導到: ${res.headers.location} (請再呼叫 fetch_url)`); return; }
        res.setEncoding('utf8');
        res.on('data', (d: string) => { buf += d; if (buf.length > 300000) res.destroy(); });
        res.on('end', () => resolve(buf.replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<style[\s\S]*?<\/style>/gi,'').replace(/<[^>]+>/g,' ').replace(/[ \t]{2,}/g,' ').replace(/\n{3,}/g,'\n\n').trim().slice(0, 12000)));
        res.on('error', (e: Error) => resolve(`網路錯誤: ${e.message}`));
      });
      req.on('error', (e: Error) => resolve(`網路錯誤: ${e.message}`));
      req.setTimeout(15000, () => { req.destroy(); resolve('超時 (15s)'); });
    });
  }

  private async _openBrowser(args: Record<string, unknown>): Promise<string> {
    const url = args.url as string;
    try { await vscode.commands.executeCommand('simpleBrowser.api.open', url); return `已在 VS Code 簡易瀏覽器開啟: ${url}`; }
    catch { await vscode.env.openExternal(vscode.Uri.parse(url)); return `已在系統瀏覽器開啟: ${url}`; }
  }

  private async _httpRequest(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
    const method = ((args.method as string) || 'GET').toUpperCase();
    const reqUrl = (args.url as string || '').trim(); if (!reqUrl) return '請提供 url 參數';
    const reqHeaders = (args.headers as Record<string,string>) || {};
    const reqBody = args.body ? String(args.body) : undefined;
    const reqTimeout = Number(args.timeout || 15000);
    if (method !== 'GET' && method !== 'HEAD') {
      if (!await ctx.requestPermission('run', `HTTP ${method}: ${reqUrl}`, 'http_request')) return '使用者已拒絕 HTTP 請求';
    }
    return new Promise<string>(resolve => {
      let parsedUrl: URL; try { parsedUrl = new URL(reqUrl); } catch { resolve('無效的 URL'); return; }
      const protocol = parsedUrl.protocol === 'https:' ? https : http;
      const bodyBuf = reqBody ? Buffer.from(reqBody, 'utf8') : undefined;
      const options = {
        hostname: parsedUrl.hostname, port: parsedUrl.port || (parsedUrl.protocol==='https:'?443:80),
        path: parsedUrl.pathname + parsedUrl.search, method,
        headers: { 'User-Agent':'AMI-AiClaw-Agent/1.0', 'Accept':'application/json, text/plain, */*', ...(bodyBuf?{'Content-Type':'application/json','Content-Length':bodyBuf.length}:{}), ...reqHeaders },
      };
      let buf = '';
      const req = protocol.request(options, res => {
        res.setEncoding('utf8');
        res.on('data', (d: string) => { buf += d; if (buf.length > 100000) res.destroy(); });
        res.on('end', () => { const hdrs = Object.entries(res.headers).slice(0,8).map(([k,v])=>`${k}: ${v}`).join('\n'); resolve(`HTTP ${res.statusCode} ${res.statusMessage}\n${hdrs}\n\n${buf.trim().slice(0,8000)}`); });
        res.on('error', (e: Error) => resolve(`回應錯誤: ${e.message}`));
      });
      req.on('error', (e: Error) => resolve(`網路錯誤: ${e.message}`));
      req.setTimeout(reqTimeout, () => { req.destroy(); resolve(`超時 (${reqTimeout}ms)`); });
      if (bodyBuf) req.write(bodyBuf);
      req.end();
    });
  }

  private async _browserNavigate(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
    const url = (args.url as string || '').trim(); if (!url) return '請提供 url 參數';
    const waitFor = (args.wait_for as string) || 'networkidle';
    const selector = (args.selector as string) || '';
    const timeout = Math.min(Number(args.timeout_ms || 20000), 60000);
    if (!await ctx.requestPermission('run', `瀏覽器訪問: ${url}`, 'browser_navigate')) return '使用者已拒絕瀏覽器操作';
    const cfg = vscode.workspace.getConfiguration('amiAiClaw');
    const useDocker = cfg.get<boolean>('browserUseDocker', false);
    const dockerImage = cfg.get<string>('browserDockerImage', 'mcr.microsoft.com/playwright/python:v1.49.0-jammy');
    const pyCore = [
      'import asyncio, json, sys',
      ...(useDocker ? ['from playwright.async_api import async_playwright'] : ['try:','    from playwright.async_api import async_playwright','except ImportError:','    print(json.dumps({"error": "找不到 playwright，請執行: pip install playwright && playwright install chromium"}))','    sys.exit(0)']),
      'async def main():', '    async with async_playwright() as p:', '        browser = await p.chromium.launch(headless=True)', '        page = await browser.new_page()', `        page.set_default_timeout(${timeout})`, '        try:',
      `            await page.goto(${JSON.stringify(url)}, wait_until=${JSON.stringify(waitFor)}, timeout=${timeout})`,
      ...(selector ? [`            await page.wait_for_selector(${JSON.stringify(selector)}, timeout=10000)`] : []),
      '            title = await page.title()', '            current_url = page.url',
      '            try:', '                text = await page.inner_text("body")', '            except Exception:', '                text = await page.content()',
      `            links = await page.eval_on_selector_all("a[href]", "els => els.slice(0,20).map(e => ({text: e.innerText.trim(), href: e.href}))")`,
      '            print(json.dumps({"title": title, "url": current_url, "text": text[:8000], "links": links}, ensure_ascii=False))',
      '        except Exception as e:', '            print(json.dumps({"error": str(e)}))',
      '        finally:', '            await browser.close()',
      'asyncio.run(main())',
    ].join('\n');
    const parse = (raw: string): string => {
      try {
        const j = JSON.parse(raw) as { error?:string; title?:string; url?:string; text?:string; links?:Array<{text:string;href:string}> };
        if (j.error) return `瀏覽器錯誤: ${j.error}`;
        const linksStr = j.links&&j.links.length>0 ? '\n\n=== 連結 ===\n'+j.links.map(l=>`[${l.text||'(no text)'}] ${l.href}`).join('\n') : '';
        return `標題: ${j.title}\n網址: ${j.url}\n\n=== 頁面文字 ===\n${j.text}${linksStr}`;
      } catch { return raw.slice(0,8000)||'(無輸出)'; }
    };
    if (useDocker) return parse(await runDockerPython(pyCore, dockerImage, timeout+15000));
    return this._runPyScript(pyCore, ctx.wsRoot, timeout+10000, parse);
  }

  private async _browserScreenshot(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
    const url = (args.url as string || '').trim(); if (!url) return '請提供 url 參數';
    const outRaw = (args.path as string || `screenshot_${Date.now()}.png`);
    const outPath = path.isAbsolute(outRaw) ? outRaw : path.join(ctx.wsRoot, outRaw);
    const selector = (args.selector as string) || '';
    if (!await ctx.requestPermission('write', `瀏覽器截圖: ${url} → ${outPath}`, 'browser_screenshot')) return '使用者已拒絕截圖操作';
    const cfg = vscode.workspace.getConfiguration('amiAiClaw');
    const useDocker = cfg.get<boolean>('browserUseDocker', false);
    const dockerImage = cfg.get<string>('browserDockerImage', 'mcr.microsoft.com/playwright/python:v1.49.0-jammy');
    if (useDocker) {
      const py = ['import asyncio, json, base64', 'from playwright.async_api import async_playwright', 'async def main():', '    async with async_playwright() as p:', '        browser = await p.chromium.launch(headless=True)', '        page = await browser.new_page(viewport={"width": 1280, "height": 800})', '        try:', `            await page.goto(${JSON.stringify(url)}, wait_until="networkidle", timeout=25000)`, ...(selector?[`            await page.wait_for_selector(${JSON.stringify(selector)}, timeout=10000)`]:[]), `            target = page if not ${JSON.stringify(selector)} else await page.query_selector(${JSON.stringify(selector||'body')})`, '            data = await target.screenshot(full_page=True)', '            print(json.dumps({"ok": True, "b64": base64.b64encode(data).decode()}))', '        except Exception as e:', '            print(json.dumps({"error": str(e)}))', '        finally:', '            await browser.close()', 'asyncio.run(main())'].join('\n');
      const raw = await runDockerPython(py, dockerImage, 40000);
      try { const j=JSON.parse(raw) as {ok?:boolean;b64?:string;error?:string}; if (j.error) return `截圖錯誤: ${j.error}`; if (j.b64) { fs.writeFileSync(outPath, Buffer.from(j.b64,'base64')); return `截圖已儲存: ${outPath}`; } } catch { return raw||'(無輸出)'; }
    }
    const py = ['import asyncio, json, sys', 'try:', '    from playwright.async_api import async_playwright', 'except ImportError:', '    print(json.dumps({"error": "找不到 playwright"}))', '    sys.exit(0)', 'async def main():', '    async with async_playwright() as p:', '        browser = await p.chromium.launch(headless=True)', '        page = await browser.new_page(viewport={"width": 1280, "height": 800})', '        try:', `            await page.goto(${JSON.stringify(url)}, wait_until="networkidle", timeout=20000)`, ...(selector?[`            await page.wait_for_selector(${JSON.stringify(selector)}, timeout=10000)`]:[]), `            target = page if not ${JSON.stringify(selector)} else await page.query_selector(${JSON.stringify(selector||'body')})`, `            out_path = ${JSON.stringify(outPath)}`, '            await target.screenshot(path=out_path, full_page=True)', '            print(json.dumps({"ok": True, "path": out_path}))', '        except Exception as e:', '            print(json.dumps({"error": str(e)}))', '        finally:', '            await browser.close()', 'asyncio.run(main())'].join('\n');
    return this._runPyScript(py, ctx.wsRoot, 35000, raw => { try { const j=JSON.parse(raw) as {ok?:boolean;path?:string;error?:string}; if (j.error) return `截圖錯誤: ${j.error}`; return `截圖已儲存: ${j.path}`; } catch { return raw||'(無輸出)'; } });
  }

  private async _browserScript(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
    const code = (args.script as string || '').trim(); if (!code) return '請提供 script 參數';
    if (!await ctx.requestPermission('run', `瀏覽器腳本: ${(args.description as string||code.split('\n')[0]).slice(0,120)}`, 'browser_script')) return '使用者已拒絕瀏覽器腳本執行';
    const cfg = vscode.workspace.getConfiguration('amiAiClaw');
    const useDocker = cfg.get<boolean>('browserUseDocker', false);
    const dockerImage = cfg.get<string>('browserDockerImage', 'mcr.microsoft.com/playwright/python:v1.49.0-jammy');
    const full = code.includes('playwright') ? code : 'from playwright.sync_api import sync_playwright\n' + code;
    if (useDocker) return runDockerPython(full, dockerImage, 130000);
    return this._runPyScript(full, ctx.wsRoot, 120000, raw => raw.slice(0,10000)||'(無輸出)');
  }

  private _runPyScript(code: string, cwd: string, timeout: number, transform: (raw:string)=>string): Promise<string> {
    const tmp = path.join(os.tmpdir(), `ami_net_py_${Date.now()}.py`);
    try {
      fs.writeFileSync(tmp, code, 'utf-8');
      return new Promise<string>(resolve => {
        const cmds = process.platform==='win32' ? ['py','python','python3'] : ['python3','python'];
        let tried = 0;
        const tryNext = () => {
          if (tried >= cmds.length) { resolve('錯誤：找不到 Python'); return; }
          const c = cmds[tried++];
          (require('child_process') as typeof import('child_process')).exec(`${c} "${tmp}"`, { cwd: cwd||process.cwd(), timeout }, (_e, o, e) => {
            if (_e && (_e as NodeJS.ErrnoException).code==='ENOENT') { tryNext(); return; }
            resolve(transform((o||e||'').trim()));
          });
        };
        tryNext();
      });
    } finally { try { fs.unlinkSync(tmp); } catch { /* ignore */ } }
  }
}
