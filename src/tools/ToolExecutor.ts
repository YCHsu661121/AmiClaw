// Copyright (c) 2026 YCHsu. All rights reserved.
// Licensed under the MIT License.
import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as os from 'os';
import { execSync } from 'child_process';
import { URL } from 'url';

export type AuditEntry = { ts: number; session: string; tool: string; argsSnippet: string; error: boolean };

export interface ToolPermissionDiff {
  filePath: string;
  before: string;
  after: string;
  mode?: 'replace' | 'write';
  oldStr?: string;
  newStr?: string;
}

export interface ToolExecutorCallbacks {
  postToWebview: (msg: object) => void;
  getExtensionContext: () => vscode.ExtensionContext;
  isWaAgentMode: () => boolean;
  log: (msg: string) => void;
  getActiveSessionId: () => string;
  handleWhatsAppTool: (name: string, args: Record<string, unknown>) => Promise<string>;
}

export class ToolExecutor {
  private _toolCache = new Map<string, { value: string; ts: number }>();
  private static readonly TOOL_CACHE_TTL = 30_000;
  private _alwaysAllow = new Set<string>();
  private _auditLog: AuditEntry[] = [];
  private _pendingPermission: ((allow: boolean) => void) | null = null;
  private _agentTodos: { id: number; text: string; done: boolean }[] = [];
  private _atlasJiraCred: { baseApiUrl: string; accessToken: string; expiry: number } | null = null;
  private _rovoDevCache: { url: string; token: string; expiry: number } | undefined = undefined;
  private _rovoDevNullUntil = 0;

  public constructor(private readonly _callbacks: ToolExecutorCallbacks) {
    this._auditLog = this._callbacks.getExtensionContext().globalState.get<AuditEntry[]>('amiAiClaw.auditLog') ?? [];
  }

  public requestPermission(category: string, description: string, toolName = '', diff?: ToolPermissionDiff): Promise<boolean> {
    const pcfg = vscode.workspace.getConfiguration('amiAiClaw');
    const alwaysAllowList = pcfg.get<string[]>('toolAlwaysAllow') ?? [];
    const alwaysConfirmList = pcfg.get<string[]>('toolAlwaysConfirm') ?? [];
    const forceConfirm = toolName ? alwaysConfirmList.includes(toolName) : false;
    if (this._callbacks.isWaAgentMode() && !forceConfirm && category !== 'delete') {
      this._callbacks.log(`WA agent: auto-allow tool category=${category} tool=${toolName || '(none)'}`);
      return Promise.resolve(true);
    }
    if (pcfg.get<boolean>('agentAutoApproveWrite', false) && (category === 'write' || toolName === 'write_file' || toolName === 'replace_in_file')) {
      return Promise.resolve(true);
    }
    if ((toolName && alwaysAllowList.includes(toolName)) || alwaysAllowList.includes(category)) {
      return Promise.resolve(true);
    }
    if (!forceConfirm && this._alwaysAllow.has(category)) { return Promise.resolve(true); }
    return new Promise<boolean>((resolve) => {
      this._pendingPermission = resolve;
      this._callbacks.postToWebview({ type: 'permissionRequest', category, description, forceConfirm, diff });
    });
  }

  public hasPendingPermission(): boolean {
    return this._pendingPermission !== null;
  }

  public resolvePendingPermission(allow: boolean): boolean {
    if (!this._pendingPermission) { return false; }
    const resolve = this._pendingPermission;
    this._pendingPermission = null;
    resolve(allow);
    return true;
  }

  public getAlwaysAllow(): ReadonlySet<string> {
    return this._alwaysAllow;
  }

  public addAlwaysAllow(category: string): void {
    this._alwaysAllow.add(category);
  }

  public clearAgentTodos(): void {
    this._agentTodos = [];
  }

  public getAuditLog(): AuditEntry[] {
    const entries = this._callbacks.getExtensionContext().globalState.get<AuditEntry[]>('amiAiClaw.auditLog') ?? this._auditLog;
    this._auditLog = entries.slice(-200);
    return entries;
  }

  public recordAuditEntry(tool: string, args: Record<string, unknown>, error: boolean): void {
    const entry: AuditEntry = {
      ts: Date.now(),
      session: this._callbacks.getActiveSessionId(),
      tool,
      argsSnippet: this.summarizeToolArgsForAudit(tool, args),
      error,
    };
    this._auditLog.push(entry);
    if (this._auditLog.length > 200) { this._auditLog.shift(); }
    const context = this._callbacks.getExtensionContext();
    const saved = context.globalState.get<AuditEntry[]>('amiAiClaw.auditLog') ?? [];
    saved.push(entry);
    if (saved.length > 500) { saved.splice(0, saved.length - 500); }
    void context.globalState.update('amiAiClaw.auditLog', saved);
  }

  private summarizeToolArgsForAudit(_name: string, args: Record<string, unknown>): string {
    return JSON.stringify(args).slice(0, 120);
  }

  /** 從 atlassian.atlascode 擷取 Jira auth (bearer token + baseApiUrl)。
   *  只支援 Windows，使用 Python (內建模組) + Node.js crypto 解密。
   *  cache：到期前 5 分鐘更新。
   */
  private async getAtlascodeJiraAuth(): Promise<{ baseApiUrl: string; accessToken: string } | null> {
    if (this._atlasJiraCred && this._atlasJiraCred.expiry > Date.now() + 300_000) {
      return this._atlasJiraCred;
    }
    try {
      const appData = process.env['APPDATA'];
      if (!appData) { return null; }
      const localStatePath = path.join(appData, 'Code', 'Local State');
      if (!fs.existsSync(localStatePath)) { return null; }

      // Python 腳本：使用內建模組讀 SQLite + DPAPI 解密 master key，輸出 JSON
      // 路徑用 JSON.stringify 嵌入：Python 解析 "C:\\Users\\..." = C:\Users\... (正確)
      const pyScript = [
        'import sqlite3,json,ctypes,base64,os,sys',
        `app=${JSON.stringify(appData)}`,
        `db=os.path.join(app,'Code','User','globalStorage','state.vscdb')`,
        `ls_path=os.path.join(app,'Code','Local State')`,
        'with open(ls_path,encoding="utf-8") as f: ls=json.load(f)',
        'enc=base64.b64decode(ls["os_crypt"]["encrypted_key"])[5:]',
        'class B(ctypes.Structure): _fields_=[("n",ctypes.c_ulong),("p",ctypes.POINTER(ctypes.c_char))]',
        'i=(ctypes.c_char*len(enc))(*enc); ib=B(len(enc),i); ob=B()',
        'ok=ctypes.windll.crypt32.CryptUnprotectData(ctypes.byref(ib),None,None,None,None,0,ctypes.byref(ob))',
        'if not ok: print(json.dumps({"error":"dpapi"})); sys.exit(1)',
        'mk=list(ctypes.string_at(ob.p,ob.n)); ctypes.windll.kernel32.LocalFree(ob.p)',
        'c=sqlite3.connect(db)',
        // 嘗試多個 key 名稱，相容舊版 (v2.x) 與新版 (v3+) atlascode
        'def find_sites(c):',
        '    for k in ["atlassian.atlascode","atlassian.atlascode.v2","atlascode"]:', 
        '        r=c.execute("SELECT value FROM ItemTable WHERE key=?",[k]).fetchone()',
        '        if not r: continue',
        '        d=json.loads(r[0])',
        '        if isinstance(d,list) and d and isinstance(d[0],dict) and "baseApiUrl" in d[0]: return d',
        '        if isinstance(d,dict):', 
        '            for fld in ["jiraSites","jiraCloudSites","sites"]:',
        '                lst=d.get(fld)',
        '                if lst and isinstance(lst,list): return lst',
        '    # 廣播搜尋包含 atlascode 的所有 key',
        '    rows=c.execute("SELECT key,value FROM ItemTable WHERE key LIKE ?",["atlassian%"]).fetchall()',
        '    for _,v in rows:',
        '        try:',
        '            d=json.loads(v)',
        '            for fld in ["jiraSites","jiraCloudSites","sites"]:',
        '                lst=d.get(fld,[]) if isinstance(d,dict) else []',
        '                if lst and isinstance(lst[0],dict) and "baseApiUrl" in lst[0]: return lst',
        '        except: pass',
        '    return []',
        'sites=find_sites(c)',
        'if not sites: print(json.dumps({"error":"no_sites"})); sys.exit(1)',
        's=sites[0]',
        'cred_id=s.get("credentialId","")',
        'if not cred_id: print(json.dumps({"error":"no_cred_id"})); sys.exit(1)',
        'ck=\'secret://{"extensionId":"atlassian.atlascode","key":"jira-\'+cred_id+\'"}\'',
        'er=c.execute("SELECT value FROM ItemTable WHERE key=?",[ck]).fetchone(); c.close()',
        'if not er: print(json.dumps({"error":"no_cred"})); sys.exit(1)',
        'ed=json.loads(er[0])',
        'print(json.dumps({"mk":mk,"buf":ed["data"],"baseApiUrl":s["baseApiUrl"],"host":s.get("host","")}))',
      ].join('\n');

      // 寫入 temp file 執行，避免 Windows stdin pipe hang 問題
      // 嘗試 py (Windows Launcher) → python → python3
      const tmpPy = path.join(appData, 'ami-atlas-auth-tmp.py');
      fs.writeFileSync(tmpPy, pyScript, 'utf-8');
      let raw = '';
      let lastErr: unknown;
      const pythonCmds = process.platform === 'win32' ? ['py', 'python'] : ['python3', 'python'];
      try {
        for (const cmd of pythonCmds) {
          try {
            raw = execSync(`${cmd} "${tmpPy}"`, { encoding: 'utf-8', timeout: 12_000 }).trim();
            lastErr = undefined;
            break;
          } catch (e) { lastErr = e; }
        }
        if (lastErr) { throw lastErr; }
      } finally {
        try { fs.unlinkSync(tmpPy); } catch { /* ignore */ }
      }
      const parsed = JSON.parse(raw) as {
        error?: string; mk?: number[]; buf?: number[];
        baseApiUrl?: string; host?: string;
      };
      if (parsed.error || !parsed.mk || !parsed.buf || !parsed.baseApiUrl) {
        this._callbacks.log(`atlascode auth: ${parsed.error ?? 'missing fields'}`);
        return null;
      }

      // AES-256-GCM 解密：v10(3) + nonce(12) + ciphertext + tag(16)
      const masterKey = Buffer.from(parsed.mk);
      const buf = Buffer.from(parsed.buf);
      const nonce = buf.slice(3, 15);
      const ciphertext = buf.slice(15, buf.length - 16);
      const tag = buf.slice(buf.length - 16);
      const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, nonce);
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      const cred = JSON.parse(plain.toString('utf-8')) as { access?: string; refresh?: string };
      if (!cred.access) { return null; }

      // 解析 JWT expiry
      let expiry = Date.now() + 3_600_000; // 預設 1h
      try {
        const payload = JSON.parse(Buffer.from(cred.access.split('.')[1], 'base64').toString('utf-8'));
        if (payload.exp) { expiry = payload.exp * 1000; }
      } catch { /* ignore */ }

      this._atlasJiraCred = { baseApiUrl: parsed.baseApiUrl, accessToken: cred.access, expiry };
      return this._atlasJiraCred;
    } catch (e) {
      this._callbacks.log(`getAtlascodeJiraAuth error: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }
  /** 探索 Rovo Dev 本地 HTTP server (127.0.0.1:{port})，優先讀 env var，否則掃描 Windows 程序表。
   *  正向結果快取 5 分鐘；負向結果快取 30 秒。*/
  private async discoverRovoDevUrl(): Promise<{ url: string; token: string } | null> {
    if (this._rovoDevCache && Date.now() < this._rovoDevCache.expiry) {
      return { url: this._rovoDevCache.url, token: this._rovoDevCache.token };
    }
    if (!this._rovoDevCache && Date.now() < this._rovoDevNullUntil) { return null; }

    const envToken = process.env['ROVODEV_SERVE_SESSION_TOKEN'] ?? '';

    const tryUrl = async (url: string): Promise<boolean> => {
      return new Promise(resolve => {
        try {
          const u = new URL('/healthcheck', url);
          const headers: Record<string, string> = envToken ? { 'Authorization': `Bearer ${envToken}` } : {};
          const req = http.request({ hostname: u.hostname, port: parseInt(u.port || '80'), path: u.pathname, method: 'GET', headers }, res => {
            res.resume(); resolve(res.statusCode === 200);
          });
          req.on('error', () => resolve(false));
          req.setTimeout(2000, () => { req.destroy(); resolve(false); });
          req.end();
        } catch { resolve(false); }
      });
    };

    // 1. Env var (Boysenberry mode)
    const envPort = process.env['ROVODEV_PORT'];
    if (envPort && /^\d+$/.test(envPort)) {
      const url = `http://127.0.0.1:${envPort}`;
      if (await tryUrl(url)) {
        this._rovoDevCache = { url, token: envToken, expiry: Date.now() + 5 * 60_000 };
        return { url, token: envToken };
      }
    }

    // 2. Windows: find atlassian_cli_rovodev.exe port via tasklist + netstat
    if (process.platform === 'win32') {
      const port = this.findRovoDevPortWindows();
      if (port) {
        const url = `http://127.0.0.1:${port}`;
        if (await tryUrl(url)) {
          this._rovoDevCache = { url, token: envToken, expiry: Date.now() + 5 * 60_000 };
          return { url, token: envToken };
        }
      }
    }

    this._rovoDevCache = undefined;
    this._rovoDevNullUntil = Date.now() + 30_000;
    return null;
  }
  /** 用 tasklist + netstat 同步取得 Rovo Dev 監聽 port (Windows)。*/
  private findRovoDevPortWindows(): string | null {
    try {
      const taskOut = execSync('tasklist /FI "IMAGENAME eq atlassian_cli_rovodev.exe" /FO CSV /NH 2>nul',
        { shell: 'cmd.exe', timeout: 3000, windowsHide: true }).toString();
      const pidMatch = taskOut.match(/"atlassian_cli_rovodev\.exe","(\d+)"/);
      if (!pidMatch) return null;
      const pid = pidMatch[1];
      const netOut = execSync('netstat -ano 2>nul | findstr " LISTENING"',
        { shell: 'cmd.exe', timeout: 5000, windowsHide: true }).toString();
      for (const line of netOut.split('\n')) {
        if (!line.trimEnd().endsWith(pid)) { continue; }
        const m = line.match(/127\.0\.0\.1:(\d+)/);
        if (!m) { continue; }
        const p = parseInt(m[1]);
        if (p >= 40000 && p <= 41000) { return String(p); }
      }
      return null;
    } catch { return null; }
  }
  /** 向 Rovo Dev 本地 HTTP server 提問並以 SSE stream 收集文字回覆。
   *  回傳 AI 回覆文字，若無法連線則回傳 null。*/
  private async callRovoDevApi(question: string): Promise<string | null> {
    const target = await this.discoverRovoDevUrl();
    if (!target) { return null; }
    const { url, token } = target;
    const reqHeaders: Record<string, string> = { 'Content-Type': 'application/json', 'accept': 'text/event-stream' };
    if (token) { reqHeaders['Authorization'] = `Bearer ${token}`; }

    // Step 1: POST /v3/set_chat_message
    const body = JSON.stringify({ message: question, context: [] });
    const step1Ok = await new Promise<boolean>(resolve => {
      try {
        const u = new URL('/v3/set_chat_message', url);
        const req = http.request({
          hostname: u.hostname, port: parseInt(u.port || '80'),
          path: u.pathname, method: 'POST',
          headers: { ...reqHeaders, 'Content-Length': Buffer.byteLength(body) },
        }, res => { res.resume(); resolve(res.statusCode !== undefined && res.statusCode < 400); });
        req.on('error', () => resolve(false));
        req.setTimeout(10000, () => { req.destroy(); resolve(false); });
        req.write(body); req.end();
      } catch { resolve(false); }
    });
    if (!step1Ok) {
      // Auth || connection failed – invalidate cache so we re-discover next time
      this._rovoDevCache = undefined; this._rovoDevNullUntil = 0;
      return null;
    }

    // Step 2: GET /v3/stream_chat (SSE) and collect text parts
    return new Promise<string | null>(resolve => {
      try {
        const u = new URL('/v3/stream_chat?pause_on_call_tools_start=false&enable_deferred_tools=true', url);
        const req = http.request({
          hostname: u.hostname, port: parseInt(u.port || '80'),
          path: u.pathname + u.search, method: 'GET',
          headers: reqHeaders,
        }, res => {
          if (res.statusCode !== 200) { res.resume(); resolve(null); return; }
          let sseBuffer = '';
          const parts: string[] = [];
          res.on('data', (chunk: Buffer) => {
            sseBuffer += chunk.toString('utf8');
            const blocks = sseBuffer.split(/\r?\n\r?\n/g);
            sseBuffer = blocks.pop() ?? '';
            for (const block of blocks) {
              if (block.startsWith(': ping')) { continue; }
              const m = block.match(/^event: ([^\r\n]+)\r?\ndata: ([\s\S]*)$/);
              if (!m) { continue; }
              const kind = m[1].trim();
              let data: Record<string, unknown> = {};
              try { data = JSON.parse(m[2]); } catch { continue; }
              if (kind === 'text') {
                const c = (data['content'] ?? data['content_delta'] ?? '') as string;
                if (c) { parts.push(c); }
              } else if (kind === 'part_start') {
                const part = (data['part'] ?? {}) as Record<string, unknown>;
                if (part['part_kind'] === 'text' && part['content']) { parts.push(part['content'] as string); }
              } else if (kind === 'part_delta') {
                const delta = (data['delta'] ?? {}) as Record<string, unknown>;
                if (delta['part_delta_kind'] === 'text' && delta['content_delta']) { parts.push(delta['content_delta'] as string); }
              }
            }
          });
          res.on('end', () => { resolve(parts.join('').trim() || null); });
          res.on('error', () => resolve(null));
        });
        req.on('error', () => resolve(null));
        req.setTimeout(60000, () => { req.destroy(); resolve(null); });
        req.end();
      } catch { resolve(null); }
    });
  }
  public async executeTool(name: string, args: Record<string, unknown>): Promise<string> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const wsRoot = folders[0]?.uri.fsPath ?? '';
    const resolvePath = (p: string) => {
      if (!p) { return wsRoot; }
      if (path.isAbsolute(p)) { return p; }
      // Check if the relative path exists under any workspace folder
      for (const f of folders) {
        const candidate = path.join(f.uri.fsPath, p);
        // Return first folder that contains the relative prefix
        const rel = p.split(/[\\/]/)[0];
        if (rel) {
          try { require('fs').accessSync(path.join(f.uri.fsPath, rel)); return candidate; } catch { /* try next */ }
        }
      }
      return path.join(wsRoot, p);
    };
    switch (name) {
      case 'get_active_file': {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { return '沒有開啟的檔案'; }
        return `檔案: ${editor.document.uri.fsPath}\n\n${editor.document.getText()}`;
      }
      case 'read_file': {
        const fpath = resolvePath(args.path as string);
        const rfKey = `rf:${fpath}`;
        const rfCached = this._toolCache.get(rfKey);
        if (rfCached && Date.now() - rfCached.ts < ToolExecutor.TOOL_CACHE_TTL) { return rfCached.value; }
        // 先檢查檔案大小，避免大型二進位/文字檔案讓 webview 凍結
        let fileStat: vscode.FileStat;
        try { fileStat = await vscode.workspace.fs.stat(vscode.Uri.file(fpath)); }
        catch { return `錯誤：找不到檔案 ${fpath}`; }
        const MAX_BYTES = 5 * 1024 * 1024; // 5 MB
        if (fileStat.size > MAX_BYTES) {
          return `檔案過大（${(fileStat.size / 1024 / 1024).toFixed(1)} MB > 5 MB），拒絕讀取以防止凍結。請改用 search_regex 或指定行範圍。`;
        }
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(fpath));
        const text = Buffer.from(bytes).toString('utf8');
        const rfResult = text.length > 50000 ? text.slice(0, 50000) + '\n…（已截斷至 50KB）' : text;
        if (text.length <= 10000) { this._toolCache.set(rfKey, { value: rfResult, ts: Date.now() }); }
        return rfResult;
      }
      case 'write_file': {
        const fpath = resolvePath(args.path as string);
        const content = (args.content as string) ?? '';
        let wfBefore = '';
        try { wfBefore = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(fpath))).toString('utf8'); } catch { /* new file */ }
        const wfDiff = { filePath: fpath, before: wfBefore, after: content, mode: 'write' as const };
        const allowed = await this.requestPermission('write', `寫入檔案: ${path.basename(fpath)}（${content.length} 字元）`, 'write_file', wfDiff);
        if (!allowed) { return '使用者已拒絕寫入操作'; }
        await vscode.workspace.fs.writeFile(vscode.Uri.file(fpath), Buffer.from(content, 'utf8'));
        this._toolCache.delete(`rf:${fpath}`);
        return `已寫入 ${fpath}（${content.length} 字元）`;
      }
      case 'replace_in_file': {
        const fpath = resolvePath(args.path as string);
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(fpath));
        const original = Buffer.from(bytes).toString('utf8');
        const oldStr = args.old_str as string;
        const newStr = (args.new_str as string) ?? '';
        if (!original.includes(oldStr)) { return `錯誤：在 ${fpath} 中找不到指定的字串`; }
        const rifDiff = { filePath: fpath, before: original, after: original.replace(oldStr, newStr), mode: 'replace' as const, oldStr, newStr };
        const allowed = await this.requestPermission('write', `編輯檔案: ${path.basename(fpath)}`, 'replace_in_file', rifDiff);
        if (!allowed) { return '使用者已拒絕編輯操作'; }
        await vscode.workspace.fs.writeFile(vscode.Uri.file(fpath), Buffer.from(original.replace(oldStr, newStr), 'utf8'));
        this._toolCache.delete(`rf:${fpath}`);
        return `已更新 ${fpath}`;
      }
      case 'list_dir': {
        const dirArg = (args.path as string) || '';
        const ldKey = `ld:${dirArg}`;
        const ldCached = this._toolCache.get(ldKey);
        if (ldCached && Date.now() - ldCached.ts < ToolExecutor.TOOL_CACHE_TTL) { return ldCached.value; }
        let ldResult: string;
        if (!dirArg && folders.length > 1) {
          // List all workspace folders
          const results: string[] = [];
          for (const f of folders) {
            const entries = await vscode.workspace.fs.readDirectory(f.uri);
            const listing = entries.map(([n, t]) => t === vscode.FileType.Directory ? n + '/' : n).sort().join('\n');
            results.push(`=== ${f.uri.fsPath} ===\n${listing}`);
          }
          ldResult = results.join('\n\n');
        } else {
          const dpath = resolvePath(dirArg);
          const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dpath));
          ldResult = entries.map(([n, t]) => t === vscode.FileType.Directory ? n + '/' : n).sort().join('\n');
        }
        this._toolCache.set(ldKey, { value: ldResult, ts: Date.now() });
        return ldResult;
      }
      case 'run_terminal': {
        const cmd = args.command as string;
        const cwd = (args.cwd as string) ? resolvePath(args.cwd as string) : (folders[0]?.uri.fsPath ?? process.cwd());
        const allowed = await this.requestPermission('run', `終端機執行: ${cmd}`, 'run_terminal');
        if (!allowed) { return '使用者已拒絕執行操作'; }
        const rtCfg = vscode.workspace.getConfiguration('amiAiClaw');
        if (rtCfg.get<boolean>('sandboxUseDocker', false)) {
          const rtImg = rtCfg.get<string>('sandboxDockerImage', 'ubuntu:24.04');
          return await runDockerShell(cmd, rtImg, 125000);
        }
        // Show in VS Code terminal for user visibility
        const terminals = vscode.window.terminals;
        const terminal = terminals.length > 0 ? terminals[terminals.length - 1] : vscode.window.createTerminal('Agent');
        terminal.show(true);
        terminal.sendText(cmd);
        // Also capture output via exec with 120s timeout
        return new Promise<string>((resolve) => {
          const { exec } = require('child_process') as typeof import('child_process');
          exec(cmd, { cwd, timeout: 120_000, shell: true as unknown as string, maxBuffer: 4 * 1024 * 1024 }, (_err, stdout, stderr) => {
            const out = (stdout || '') + (stderr ? `\n[stderr]\n${stderr}` : '');
            const trimmed = out.trim();
            resolve(trimmed.length > 10000 ? trimmed.slice(0, 10000) + '\n…（已截斷至 10KB）' : trimmed || '(無輸出)');
          });
        });
      }
      case 'search_workspace': {
        const query = ((args.query as string) ?? '').toLowerCase();
        if (!query) { return '請提供搜尋關鍵字'; }
        const allUris = await vscode.workspace.findFiles('**/*', '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**}', 200);
        const fileMatches = allUris.map(u => u.fsPath).filter(p => path.basename(p).toLowerCase().includes(query));
        const contentMatches: string[] = [];
        for (const uri of allUris) {
          if (contentMatches.length >= 40) { break; }
          try {
            const ext = path.extname(uri.fsPath).toLowerCase();
            if (['.png','.jpg','.ico','.vsix','.zip','.exe','.dll','.pdf'].includes(ext)) { continue; }
            const bytes = await vscode.workspace.fs.readFile(uri);
            const text = Buffer.from(bytes).toString('utf8');
            const lines = text.split('\n');
            for (let li = 0; li < lines.length && contentMatches.length < 40; li++) {
              if (lines[li].toLowerCase().includes(query)) {
                contentMatches.push(`${uri.fsPath}:${li + 1}: ${lines[li].trim().slice(0, 120)}`);
              }
            }
          } catch { /* skip binary */ }
        }
        const parts: string[] = [];
        if (fileMatches.length > 0) { parts.push(`=== 檔案名稱匹配 (${fileMatches.length}) ===\n${fileMatches.slice(0, 30).join('\n')}`); }
        if (contentMatches.length > 0) { parts.push(`=== 程式碼內容匹配 (${contentMatches.length}) ===\n${contentMatches.join('\n')}`); }
        return parts.length > 0 ? parts.join('\n\n') : `找不到符合 "${args.query}" 的結果`;
      }
      case 'delete_file': {
        const fpath = resolvePath(args.path as string);
        const allowed = await this.requestPermission('delete', `刪除: ${fpath}`, 'delete_file');
        if (!allowed) { return '使用者已拒絕刪除操作'; }
        await vscode.workspace.fs.delete(vscode.Uri.file(fpath), { recursive: (args.recursive as boolean) ?? false });
        this._toolCache.delete(`rf:${fpath}`);
        this._toolCache.delete(`ld:${path.dirname(fpath)}`);
        return `已刪除 ${fpath}`;
      }
      case 'create_dir': {
        const dpath = resolvePath(args.path as string);
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(dpath));
        return `已建立目錄 ${dpath}`;
      }
      case 'run_command': {
        const cmd = args.command as string;
        const cwd = (args.cwd as string) ? resolvePath(args.cwd as string) : (folders[0]?.uri.fsPath ?? process.cwd());
        const allowed = await this.requestPermission('run', `執行指令: ${cmd}`, 'run_command');
        if (!allowed) { return '使用者已拒絕執行操作'; }
        const rcCfg = vscode.workspace.getConfiguration('amiAiClaw');
        if (rcCfg.get<boolean>('sandboxUseDocker', false)) {
          const rcImg = rcCfg.get<string>('sandboxDockerImage', 'ubuntu:24.04');
          return await runDockerShell(cmd, rcImg, 35000);
        }
        return new Promise<string>((resolve) => {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { exec } = require('child_process') as typeof import('child_process');
          exec(cmd, { cwd, timeout: 30000, shell: true as unknown as string }, (_err, stdout, stderr) => {
            const out = (stdout || '') + (stderr ? `\n[stderr]\n${stderr}` : '');
            resolve(out.trim().slice(0, 8000) || '(無輸出)');
          });
        });
      }
      case 'fetch_url': {
        const rawUrl = (args.url as string || '').trim();
        if (!rawUrl) return '請提供 url 參數';
        try { new URL(rawUrl); } catch { return `無效的 URL: ${rawUrl}`; }
        return new Promise<string>((resolve) => {
          const protocol = rawUrl.startsWith('https') ? https : http;
          let buf = '';
          const req = protocol.get(rawUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (AmiClaw-Agent)' } }, (res) => {
            if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
              resolve(`重導到: ${res.headers.location} (請再呼叫 fetch_url)`);
              return;
            }
            res.setEncoding('utf8');
            res.on('data', (d: string) => { buf += d; if (buf.length > 300000) { res.destroy(); } });
            res.on('end', () => {
              const stripped = buf
                .replace(/<script[\s\S]*?<\/script>/gi, '')
                .replace(/<style[\s\S]*?<\/style>/gi, '')
                .replace(/<[^>]+>/g, ' ')
                .replace(/[ \t]{2,}/g, ' ')
                .replace(/\n{3,}/g, '\n\n')
                .trim();
              resolve(stripped.slice(0, 12000));
            });
            res.on('error', (e: Error) => resolve(`網路錯誤: ${e.message}`));
          });
          req.on('error', (e: Error) => resolve(`網路錯誤: ${e.message}`));
          req.setTimeout(15000, () => { req.destroy(); resolve('超時 (15s)'); });
        });
      }
      case 'open_browser': {
        const url = args.url as string;
        try {
          await vscode.commands.executeCommand('simpleBrowser.api.open', url);
          return `已在 VS Code 簡易瀏覽器開啟: ${url}`;
        } catch {
          await vscode.env.openExternal(vscode.Uri.parse(url));
          return `已在系統瀏覽器開啟: ${url}`;
        }
      }
      case 'manage_todo': {
        const action = (args.action as string) || 'list';
        if (action === 'add') {
          const text = args.text as string;
          if (!text) { return '請提供 todo 內容 (text 參數)'; }
          this._agentTodos.push({ id: this._agentTodos.length + 1, text, done: false });
          return `已新增 Todo #${this._agentTodos.length}: ${text}`;
        } else if (action === 'done') {
          const id = Number(args.id);
          const item = this._agentTodos.find(t => t.id === id);
          if (!item) { return `找不到 Todo #${id}`; }
          item.done = true;
          return `✅ Todo #${id} 已完成: ${item.text}`;
        } else if (action === 'clear') {
          this._agentTodos = [];
          return 'Todo 清單已清空';
        } else {
          if (this._agentTodos.length === 0) { return 'Todo 清單是空的，請先用 add 新增任務'; }
          return this._agentTodos.map(t => `${t.done ? '✅' : '⏳'} #${t.id}: ${t.text}`).join('\n');
        }
      }
      case 'vscode_action': {
        const action = (args.action as string) || '';
        if (action === 'open_file') {
          const fpath = resolvePath(args.path as string);
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fpath));
          const editor = await vscode.window.showTextDocument(doc, { preview: true });
          if (args.line) {
            const pos = new vscode.Position(Math.max(0, Number(args.line) - 1), 0);
            editor.selection = new vscode.Selection(pos, pos);
            editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
          }
          return `已開啟 ${fpath}${args.line ? ` 第 ${args.line} 行` : ''}`;
        } else if (action === 'get_workspace_info') {
          const wsFolders = vscode.workspace.workspaceFolders ?? [];
          const openDocs = vscode.workspace.textDocuments.filter(d => !d.isUntitled && d.uri.scheme === 'file');
          return `工作區: ${wsFolders.map(f => f.uri.fsPath).join(', ') || '(none)'}\n開啟中檔案:\n${openDocs.map(d => d.uri.fsPath).join('\n') || '(none)'}`;
        } else if (action === 'show_notification') {
          vscode.window.showInformationMessage(String(args.message ?? ''));
          return '已顯示通知';
        } else if (action === 'run_command') {
          await vscode.commands.executeCommand(args.command as string, ...(Array.isArray(args.args) ? args.args : []));
          return `已執行 VS Code 指令: ${args.command}`;
        }
        return `未知 vscode_action: ${action}`;
      }
      case 'jira_search': {
        // 支援兩種呼叫：直接給 jql，或給 assignee/reporter/project/status 組合
        let jql = (args.jql as string || '').trim();
        if (!jql) {
          const parts: string[] = [];
          const assignee = (args.assignee as string || '').trim();
          const reporter = (args.reporter as string || '').trim();
          const project  = (args.project  as string || '').trim();
          const status   = (args.status   as string || '').trim();
          const text     = (args.text     as string || '').trim();
          if (assignee) parts.push(`assignee = "${assignee}"`);
          if (reporter) parts.push(`reporter = "${reporter}"`);
          if (project)  parts.push(`project = "${project}"`);
          if (status)   parts.push(`status = "${status}"`);
          if (text)     parts.push(`text ~ "${text}"`);
          if (parts.length === 0) return '請提供 jql 或至少一個過濾條件（assignee/reporter/project/status/text）';
          jql = parts.join(' AND ') + ' ORDER BY updated DESC';
        }
        const maxResults2 = Math.min(Number(args.max_results ?? 20), 50);

        let searchApiUrl: string;
        let authHeader2: string;
        const atlasAuth2 = await this.getAtlascodeJiraAuth();
        if (atlasAuth2) {
          searchApiUrl = `${atlasAuth2.baseApiUrl}/api/3/search/jql`;  // v3 search/jql API
          authHeader2 = `Bearer ${atlasAuth2.accessToken}`;
        } else {
          const jiraCfg2 = vscode.workspace.getConfiguration('amiAiClaw');
          const jiraBase2 = (jiraCfg2.get<string>('jiraBaseUrl') ?? '').replace(/\/$/, '');
          const jiraEmail2 = jiraCfg2.get<string>('jiraEmail') ?? '';
          const jiraPat2   = jiraCfg2.get<string>('jiraPat') ?? '';
          if (!jiraBase2) return [
            '❌ Jira 認證失敗：找不到 atlassian.atlascode 登入資訊，也未設定手動認證。',
            '請在 VS Code 設定中（Ctrl+, 搜尋 amiAiClaw）設定：',
            '  amiAiClaw.jiraBaseUrl = "https://yourcompany.atlassian.net"',
            '  amiAiClaw.jiraEmail   = "your@email.com"',
            '  amiAiClaw.jiraPat     = "你的 Jira API Token（從 id.atlassian.com/manage-profile/security/api-tokens 產生）"',
          ].join('\n');
          if (!jiraPat2)  return '❌ Jira 認證失敗：amiAiClaw.jiraPat 未設定。請到 id.atlassian.com/manage-profile/security/api-tokens 產生 API Token 後填入.';
          searchApiUrl = `${jiraBase2}/rest/api/3/search/jql`;  // v3 search/jql API
          authHeader2 = jiraEmail2
            ? 'Basic ' + Buffer.from(`${jiraEmail2}:${jiraPat2}`).toString('base64')
            : 'Bearer ' + jiraPat2;
        }

        const postBody2 = JSON.stringify({
          jql,
          maxResults: maxResults2,
          fields: ['summary', 'status', 'assignee', 'reporter', 'priority', 'issuetype', 'updated', 'labels']
        });

        return new Promise<string>((resolve) => {
          try {
            const u2 = new URL(searchApiUrl);
            const proto2 = u2.protocol === 'https:' ? https : http;
            const req2 = proto2.request({
              hostname: u2.hostname, port: u2.port ? parseInt(u2.port) : (u2.protocol === 'https:' ? 443 : 80),
              path: u2.pathname + u2.search, method: 'POST',
              headers: { 'Authorization': authHeader2, 'Accept': 'application/json', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postBody2) }
            }, (res2) => {
              let data2 = '';
              res2.on('data', (c: Buffer) => { data2 += c; });
              res2.on('end', () => {
                if (res2.statusCode === 400) { resolve(`JQL 語法錯誤: ${data2.substring(0, 300)}`); return; }
                if (res2.statusCode === 401 || res2.statusCode === 403) {
                  this._atlasJiraCred = null;
                  resolve(`❌ Jira 認證失敗 (HTTP ${res2.statusCode})。\n可能原因：(1) atlassian.atlascode 登入 token 已過期，請重新登入擴充功能；(2) API Token 無效，請至 id.atlassian.com/manage-profile/security/api-tokens 重新產生並更新 amiAiClaw.jiraPat。`);
                  return;
                }
                if (res2.statusCode === 410 || (res2.statusCode === 404 && data2.includes('removed'))) {
                  resolve(`❌ Jira Search API 端點已移除 (HTTP ${res2.statusCode})。請聯繫開發者更新擴充功能。`);
                  return;
                }
                if (res2.statusCode !== 200) { resolve(`❌ Jira Search 失敗 HTTP ${res2.statusCode}：${data2.substring(0, 200)}\n（jiraBaseUrl=${searchApiUrl.split('/rest/')[0]}）`); return; }
                try {
                  const j2 = JSON.parse(data2);
                  const issues2: Array<Record<string, unknown>> = j2.issues ?? [];
                  if (issues2.length === 0) { resolve(`JQL: ${jql}\n\n查無符合的 Issue。`); return; }
                  const lines2 = issues2.map((iss) => {
                    const f2 = iss.fields as Record<string, unknown>;
                    const st2  = (f2.status   as Record<string,unknown>)?.name ?? '';
                    const as2  = (f2.assignee as Record<string,unknown>)?.displayName ?? '未指派';
                    const pr2  = (f2.priority as Record<string,unknown>)?.name ?? '';
                    const ty2  = (f2.issuetype as Record<string,unknown>)?.name ?? '';
                    const upd2 = String(f2.updated ?? '').slice(0, 10);
                    return `[${iss.key}] [${ty2}] [${st2}] [${pr2}] ${f2.summary}  (Assignee: ${as2}, Updated: ${upd2})`;
                  });
                  resolve(`JQL: ${jql}\n共 ${j2.total} 筆（顯示前 ${issues2.length} 筆）:\n\n${lines2.join('\n')}`);
                } catch { resolve(`無法解析 Jira Search 回應: ${data2.substring(0, 300)}`); }
              });
            });
            req2.on('error', (e2: Error) => resolve(`Jira search 錯誤: ${e2.message}`));
            req2.setTimeout(15000, () => { req2.destroy(); resolve('Jira search 逾時 (15s)'); });
            req2.write(postBody2);
            req2.end();
          } catch (e2) { resolve(`jira_search 錯誤: ${e2 instanceof Error ? e2.message : String(e2)}`); }
        });
      }
      case 'jira_fetch': {
        const fetchKey = (args.issue_key as string || '').trim().toUpperCase();
        if (!fetchKey) return '請提供 issue_key，例如 BIOS-123';

        // 決定 auth：優先嘗試 atlascode 已登入憑證，fallback 到手動設定
        let issueApiUrl: string;
        let authHeader: string;
        const atlasAuth = await this.getAtlascodeJiraAuth();
        if (atlasAuth) {
          const fieldsParam = 'summary,description,status,assignee,reporter,priority,issuetype,labels,comment,attachment,created,updated';
          issueApiUrl = `${atlasAuth.baseApiUrl}/api/3/issue/${fetchKey}?fields=${fieldsParam}`;
          authHeader = `Bearer ${atlasAuth.accessToken}`;
        } else {
          const jiraCfg = vscode.workspace.getConfiguration('amiAiClaw');
          const jiraBase = (jiraCfg.get<string>('jiraBaseUrl') ?? '').replace(/\/$/, '');
          const jiraEmail = jiraCfg.get<string>('jiraEmail') ?? '';
          const jiraPat = jiraCfg.get<string>('jiraPat') ?? '';
          if (!jiraBase) return '❌ Jira 認證失敗：找不到 atlassian.atlascode 登入資訊。請設定 amiAiClaw.jiraBaseUrl（例如 https://yourcompany.atlassian.net）及 amiAiClaw.jiraPat（Jira API Token）。';
          if (!jiraPat)  return '❌ Jira 認證失敗：amiAiClaw.jiraPat 未設定。請至 id.atlassian.com/manage-profile/security/api-tokens 產生並設定。';
          const fieldsParam = 'summary,description,status,assignee,reporter,priority,issuetype,labels,comment,attachment,created,updated';
          issueApiUrl = `${jiraBase}/rest/api/3/issue/${fetchKey}?fields=${fieldsParam}`;
          authHeader = jiraEmail
            ? 'Basic ' + Buffer.from(`${jiraEmail}:${jiraPat}`).toString('base64')
            : 'Bearer ' + jiraPat;
        }

        return new Promise<string>((resolve) => {
          try {
            const u = new URL(issueApiUrl);
            const proto = u.protocol === 'https:' ? https : http;
            const req = proto.request({
              hostname: u.hostname, port: u.port ? parseInt(u.port) : (u.protocol === 'https:' ? 443 : 80),
              path: u.pathname + u.search, method: 'GET',
              headers: { 'Authorization': authHeader, 'Accept': 'application/json', 'Content-Type': 'application/json' }
            }, (res) => {
              let data = '';
              res.on('data', (c: Buffer) => { data += c; });
              res.on('end', () => {
                if (res.statusCode === 401 || res.statusCode === 403) {
                  // token 可能過期，清除 cache 下次重新取得
                  this._atlasJiraCred = null;
                  resolve(`Jira 認證失敗 (HTTP ${res.statusCode})，請確認 atlassian.atlascode 已登入，或在設定中填寫 amiAiClaw.jiraPat。`);
                  return;
                }
                if (res.statusCode === 404) { resolve(`找不到 Issue ${fetchKey}，請確認 Key 正確或使用者有權限。`); return; }
                if (res.statusCode !== 200) { resolve(`Jira API 回傳 HTTP ${res.statusCode}: ${data.substring(0, 200)}`); return; }
                try {
                  const j = JSON.parse(data);
                  const f = j.fields || {};
                  const comments = (f.comment?.comments ?? []).slice(-3).map((c: Record<string, unknown>) => `  [${c.author && (c.author as Record<string,unknown>).displayName}] ${String(c.body ?? '').substring(0, 300)}`).join('\n');
                  const attachments = (f.attachment ?? []) as Array<{ filename: string; size: number; mimeType: string; content: string }>;
                  const attachLines = attachments.length > 0
                    ? `\nAttachments (${attachments.length}):\n` + attachments.map(a => `  [${a.filename}] ${(a.size / 1024).toFixed(1)}KB  ${a.mimeType}  url=${a.content}`).join('\n')
                    : '';
                  resolve([
                    `Issue: ${fetchKey}  (${f.issuetype?.name ?? ''})`,
                    `Status: ${f.status?.name ?? ''}`,
                    `Priority: ${f.priority?.name ?? ''}`,
                    `Reporter: ${f.reporter?.displayName ?? ''}`,
                    `Assignee: ${f.assignee?.displayName ?? '未指派'}`,
                    `Labels: ${(f.labels ?? []).join(', ') || '(none)'}`,
                    `Summary: ${f.summary ?? ''}`,
                    `Description:\n${String(f.description ?? '(empty)').substring(0, 2000)}`,
                    comments ? `\nLatest Comments:\n${comments}` : '',
                    attachLines
                  ].filter(Boolean).join('\n'));
                } catch { resolve(`無法解析 Jira API 回應: ${data.substring(0, 300)}`); }
              });
            });
            req.on('error', (e: Error) => resolve(`Jira fetch 錯誤: ${e.message}`));
            req.setTimeout(15000, () => { req.destroy(); resolve('Jira fetch 逾時 (15s)'); });
            req.end();
          } catch (e) { resolve(`jira_fetch 錯誤: ${e instanceof Error ? e.message : String(e)}`); }
        });
      }
      case 'jira_attachment_download': {
        const attachUrl = (args.url as string || '').trim();
        if (!attachUrl) return '請提供 url 參數（來自 jira_fetch 附件清單的 url= 欄位）';
        let rawFilename = (args.filename as string || '').trim();
        if (!rawFilename) {
          try { rawFilename = decodeURIComponent(path.basename(new URL(attachUrl).pathname)); } catch { rawFilename = 'attachment'; }
        }
        // Sanitize filename to prevent path traversal
        const safeFilename = rawFilename.replace(/[/\\:*?"<>|]/g, '_').replace(/^\.+/, '_');

        let dlAuthHeader: string;
        const atlasAuth3 = await this.getAtlascodeJiraAuth();
        if (atlasAuth3) {
          dlAuthHeader = `Bearer ${atlasAuth3.accessToken}`;
        } else {
          const jiraCfg3 = vscode.workspace.getConfiguration('amiAiClaw');
          const jiraEmail3 = jiraCfg3.get<string>('jiraEmail') ?? '';
          const jiraPat3 = jiraCfg3.get<string>('jiraPat') ?? '';
          if (!jiraPat3) return '找不到 Jira 認證，請確認 atlassian.atlascode 已登入';
          dlAuthHeader = jiraEmail3 ? 'Basic ' + Buffer.from(`${jiraEmail3}:${jiraPat3}`).toString('base64') : 'Bearer ' + jiraPat3;
        }

        const tmpDir = os.tmpdir();
        const outFile = path.join(tmpDir, safeFilename);

        const dlResult = await new Promise<{ ok: boolean; err?: string }>((resolve) => {
          try {
            const u = new URL(attachUrl);
            const proto = u.protocol === 'https:' ? https : http;
            const req = proto.request({
              hostname: u.hostname,
              port: u.port ? parseInt(u.port) : (u.protocol === 'https:' ? 443 : 80),
              path: u.pathname + u.search, method: 'GET',
              headers: { 'Authorization': dlAuthHeader },
            }, (res) => {
              if (res.statusCode !== 200) { res.resume(); resolve({ ok: false, err: `HTTP ${res.statusCode}` }); return; }
              const chunks: Buffer[] = [];
              res.on('data', (c: Buffer) => chunks.push(c));
              res.on('end', () => { try { fs.writeFileSync(outFile, Buffer.concat(chunks)); resolve({ ok: true }); } catch(e) { resolve({ ok: false, err: e instanceof Error ? e.message : String(e) }); } });
              res.on('error', (e: Error) => resolve({ ok: false, err: e.message }));
            });
            req.on('error', (e: Error) => resolve({ ok: false, err: e.message }));
            req.setTimeout(60000, () => { req.destroy(); resolve({ ok: false, err: '下載逾時 (60s)' }); });
            req.end();
          } catch (e) { resolve({ ok: false, err: e instanceof Error ? e.message : String(e) }); }
        });

        if (!dlResult.ok) return `附件下載失敗: ${dlResult.err}`;

        const ext = path.extname(safeFilename).toLowerCase();
        if (ext === '.zip') {
          const extractDir = outFile + '_extracted';
          try {
            if (fs.existsSync(extractDir)) { execSync(`rmdir /s /q "${extractDir}"`, { shell: 'cmd.exe', timeout: 10000, windowsHide: true }); }
            execSync(`powershell -NoProfile -Command "Expand-Archive -LiteralPath '${outFile}' -DestinationPath '${extractDir}' -Force"`, { timeout: 30000, windowsHide: true });
            const listFiles = (dir: string, base = ''): string[] => {
              const entries: string[] = [];
              try {
                for (const name of fs.readdirSync(dir)) {
                  const rel = base ? `${base}/${name}` : name;
                  const full = path.join(dir, name);
                  if (fs.statSync(full).isDirectory()) entries.push(...listFiles(full, rel));
                  else entries.push(rel);
                }
              } catch { /* ignore permission errors */ }
              return entries;
            };
            const files = listFiles(extractDir);
            const lines: string[] = [`📦 ${safeFilename} 解壓縮完成，共 ${files.length} 個檔案:\n`];
            lines.push(...files.slice(0, 80).map(f => `  ${f}`));
            if (files.length > 80) lines.push(`  … (共 ${files.length} 個)`);
            // Show contents of small text files
            const textExts = new Set(['.txt', '.log', '.md', '.json', '.xml', '.csv', '.ini', '.cfg', '.py', '.ts', '.js', '.sh', '.bat', '.diff', '.patch']);
            let shown = 0;
            for (const rel of files) {
              if (shown >= 5) break;
              if (!textExts.has(path.extname(rel).toLowerCase())) continue;
              const full = path.join(extractDir, rel);
              try {
                const stat = fs.statSync(full);
                if (stat.size > 60000) continue;
                const content = fs.readFileSync(full, 'utf-8');
                lines.push(`\n--- ${rel} ---\n${content.substring(0, 4000)}${content.length > 4000 ? '\n…（已截斷）' : ''}`);
                shown++;
              } catch { /* ignore */ }
            }
            lines.push(`\n解壓縮目錄: ${extractDir}`);
            return lines.join('\n');
          } catch (e) {
            return `ZIP 解壓縮失敗: ${e instanceof Error ? e.message : String(e)}\n檔案已存至: ${outFile}`;
          }
        } else {
          // Try reading as UTF-8 text
          try {
            const content = fs.readFileSync(outFile, 'utf-8');
            return `📄 ${safeFilename}\n\n${content.substring(0, 6000)}${content.length > 6000 ? '\n…（已截斷）' : ''}`;
          } catch {
            return `✅ ${safeFilename} 已下載至 ${outFile}（二進位檔案）`;
          }
        }
      }
      case 'jira_open': {
        const key = (args.issue_key as string || '').trim().toUpperCase();
        if (!key) return '請提供 issue_key，例如 BIOS-123';
        try {
          await vscode.commands.executeCommand('atlascode.jira.showIssueForKey', key);
          return `已開啟 Jira Issue: ${key}`;
        } catch (e) { return `無法開啟 Jira Issue: ${e instanceof Error ? e.message : String(e)}`; }
      }
      case 'jira_log_time': {
        const ltKey = (args.issue_key as string || '').trim().toUpperCase();
        if (!ltKey) return '請提供 issue_key，例如 BIOS-123';
        // 解析時間：支援 "16h"、"2h 30m"、"1d"、"90m"、純秒數
        const timeStr = (args.time_spent as string || '').trim();
        if (!timeStr) return '請提供 time_spent，例如 "16h"、"2h 30m"、"1d"';
        let totalSeconds = 0;
        const dMatch = timeStr.match(/(\d+(?:\.\d+)?)\s*d/i);
        const hMatch = timeStr.match(/(\d+(?:\.\d+)?)\s*h/i);
        const mMatch = timeStr.match(/(\d+(?:\.\d+)?)\s*m(?!s)/i);
        const sMatch = timeStr.match(/(\d+(?:\.\d+)?)\s*s(?!\w)/i);
        if (dMatch) totalSeconds += parseFloat(dMatch[1]) * 8 * 3600;  // 1d = 8h
        if (hMatch) totalSeconds += parseFloat(hMatch[1]) * 3600;
        if (mMatch) totalSeconds += parseFloat(mMatch[1]) * 60;
        if (sMatch) totalSeconds += parseFloat(sMatch[1]);
        if (!dMatch && !hMatch && !mMatch && !sMatch) {
          const bare = parseFloat(timeStr);
          if (!isNaN(bare)) totalSeconds = bare;  // 裸數字視為秒
          else return `無法解析時間格式: "${timeStr}"，請使用如 "16h"、"2h 30m"、"1d" 格式`;
        }
        if (totalSeconds <= 0) return '時間必須大於 0';

        // 日期：支援 "today"、"yesterday"、"YYYY-MM-DD"，預設今天
        const dateStr = (args.date as string || 'today').trim().toLowerCase();
        let logDate: Date;
        if (dateStr === 'today' || !dateStr) {
          logDate = new Date();
        } else if (dateStr === 'yesterday') {
          logDate = new Date(); logDate.setDate(logDate.getDate() - 1);
        } else {
          logDate = new Date(dateStr);
          if (isNaN(logDate.getTime())) return `無法解析日期: "${dateStr}"，請用 YYYY-MM-DD 格式`;
        }
        // Jira worklog 需要 ISO 8601 格式並帶時區
        const pad = (n: number) => String(n).padStart(2, '0');
        const started = `${logDate.getFullYear()}-${pad(logDate.getMonth()+1)}-${pad(logDate.getDate())}T09:00:00.000+0000`;
        const comment = (args.comment as string || '').trim();

        let ltApiBase: string;
        let ltAuth: string;
        const atlasAuth4 = await this.getAtlascodeJiraAuth();
        if (atlasAuth4) {
          ltApiBase = atlasAuth4.baseApiUrl;
          ltAuth = `Bearer ${atlasAuth4.accessToken}`;
        } else {
          const ltCfg = vscode.workspace.getConfiguration('amiAiClaw');
          const ltBase = (ltCfg.get<string>('jiraBaseUrl') ?? '').replace(/\/$/, '');
          const ltEmail = ltCfg.get<string>('jiraEmail') ?? '';
          const ltPat = ltCfg.get<string>('jiraPat') ?? '';
          if (!ltBase) return '❌ Jira 認證失敗：找不到 atlassian.atlascode 登入資訊。請設定 amiAiClaw.jiraBaseUrl 及 amiAiClaw.jiraPat（Jira API Token）。';
          if (!ltPat)  return '❌ Jira 認證失敗：amiAiClaw.jiraPat 未設定。請至 id.atlassian.com/manage-profile/security/api-tokens 產生並設定。';
          ltApiBase = ltBase + '/rest';
          ltAuth = ltEmail
            ? 'Basic ' + Buffer.from(`${ltEmail}:${ltPat}`).toString('base64')
            : 'Bearer ' + ltPat;
        }

        const worklogUrl = `${ltApiBase}/api/3/issue/${ltKey}/worklog`;  // v3 worklog API
        const worklogBody = JSON.stringify({
          timeSpentSeconds: Math.round(totalSeconds),
          started,
          ...(comment ? { comment } : {})
        });

        return new Promise<string>((resolve) => {
          try {
            const wu = new URL(worklogUrl);
            const wproto = wu.protocol === 'https:' ? https : http;
            const wreq = wproto.request({
              hostname: wu.hostname, port: wu.port ? parseInt(wu.port) : (wu.protocol === 'https:' ? 443 : 80),
              path: wu.pathname + wu.search, method: 'POST',
              headers: { 'Authorization': ltAuth, 'Accept': 'application/json', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(worklogBody) }
            }, (wres) => {
              let wdata = '';
              wres.on('data', (c: Buffer) => { wdata += c; });
              wres.on('end', () => {
                if (wres.statusCode === 401 || wres.statusCode === 403) {
                  this._atlasJiraCred = null;
                  resolve(`Jira 認證失敗 (HTTP ${wres.statusCode})`);
                  return;
                }
                if (wres.statusCode === 404) { resolve(`找不到 Issue ${ltKey}，請確認 Key 正確或使用者有權限。`); return; }
                if (wres.statusCode !== 201) { resolve(`Jira Log Time 失敗 HTTP ${wres.statusCode}: ${wdata.substring(0, 200)}`); return; }
                try {
                  const wj = JSON.parse(wdata);
                  const hrs = (totalSeconds / 3600).toFixed(1);
                  resolve(`✅ 已記錄 ${ltKey} 工時 ${hrs}h（${Math.round(totalSeconds)}s），日期: ${dateStr === 'today' ? '今天' : dateStr}${comment ? `，備註: ${comment}` : ''}，worklog ID: ${wj.id}`);
                } catch { resolve(`Jira Log Time 完成但無法解析回應: ${wdata.substring(0, 200)}`); }
              });
            });
            wreq.on('error', (we: Error) => resolve(`Jira log_time 錯誤: ${we.message}`));
            wreq.setTimeout(15000, () => { wreq.destroy(); resolve('Jira log_time 逾時 (15s)'); });
            wreq.write(worklogBody);
            wreq.end();
          } catch (we2) { resolve(`jira_log_time 錯誤: ${we2 instanceof Error ? we2.message : String(we2)}`); }
        });
      }
      case 'jira_create': {
        try {
          await vscode.commands.executeCommand('atlascode.jira.createIssue', args.summary ? { summary: args.summary, description: args.description } : undefined);
          return '已開啟 Jira 建立 Issue 面板';
        } catch (e) { return `開啟失敗: ${e instanceof Error ? e.message : String(e)}`; }
      }
      case 'jira_transition': {
        const key = (args.issue_key as string || '').trim().toUpperCase();
        if (!key) return '請提供 issue_key';
        try {
          await vscode.commands.executeCommand('atlascode.jira.transitionIssue', { key });
          return `已開啟 ${key} 狀態轉換面板`;
        } catch (e) { return `失敗: ${e instanceof Error ? e.message : String(e)}`; }
      }
      case 'bb_create_pr': {
        try {
          await vscode.commands.executeCommand('atlascode.bb.createPullRequest');
          return '已開啟 Bitbucket 建立 Pull Request 面板';
        } catch (e) { return `失敗: ${e instanceof Error ? e.message : String(e)}`; }
      }
      case 'rovo_ask': {
        const question = (args.question as string || '').trim();
        if (!question) return '請提供 question 參數';
        // Try Rovo Dev local HTTP server first (returns actual AI response)
        try {
          const rovoResp = await this.callRovoDevApi(question);
          if (rovoResp) { return `[Rovo Dev 回覆]\n${rovoResp}`; }
        } catch { /* fall through */ }
        // Fallback: open interactive panel (no return value)
        try {
          await vscode.commands.executeCommand('atlascode.rovodev.askInteractive', question);
          return `已在 Rovo Dev 面板提問（無法直接取回回覆），請查看 Rovo Dev 面板。`;
        } catch (e) { return `失敗: ${e instanceof Error ? e.message : String(e)}`; }
      }
      case 'run_python': {
        const pyCode = (args.code as string || '').trim();
        if (!pyCode) return '請提供 code 參數';
        // Detect destructive operations to ask permission
        const isDestructive = /os\.remove|os\.rmdir|shutil\.rmtree|shutil\.move|open\s*\(.*['"]w['"]|open\s*\(.*['"]a['"]|Path.*\.unlink|Path.*\.rmdir|copyfile|shutil\.copy/i.test(pyCode);
        const rpCfg = vscode.workspace.getConfiguration('amiAiClaw');
        const rpSandbox = rpCfg.get<boolean>('sandboxUseDocker', false);
        if (isDestructive && !rpSandbox) {
          const descLine = (args.description as string || pyCode.split('\n')[0]).slice(0, 120);
          const allowed = await this.requestPermission('run', `Python（含檔案操作）: ${descLine}`, 'run_python');
          if (!allowed) return '使用者已拒絕執行操作';
        }
        if (rpSandbox) {
          const rpImg = rpCfg.get<string>('sandboxDockerImage', 'ubuntu:24.04');
          // 沙箱 Python 影像：少必 ubuntu:24.04 內建 python3，也可用 python:3.12-slim
          const rpPyImg = rpImg.includes('python') ? rpImg : 'python:3.12-slim';
          return await runDockerPython(pyCode, rpPyImg, 35000);
        }
        const tmpDir = os.tmpdir();
        const tmpFile = path.join(tmpDir, `ami_ai_claw_py_${Date.now()}.py`);
        try {
          fs.writeFileSync(tmpFile, pyCode, 'utf-8');
          return await new Promise<string>((resolve) => {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { exec } = require('child_process') as typeof import('child_process');
            const pythonCmds = process.platform === 'win32' ? ['py', 'python', 'python3'] : ['python3', 'python'];
            let tried = 0;
            const tryNext = () => {
              if (tried >= pythonCmds.length) { resolve('錯誤：找不到 Python 執行環境，請確認已安裝 Python 3'); return; }
              const cmd = pythonCmds[tried++];
              exec(`${cmd} "${tmpFile}"`, { cwd: wsRoot || process.cwd(), timeout: 30000 }, (_err, stdout, stderr) => {
                // Exit code non-zero is ok if there's output; only retry on ENOENT
                if (_err && (_err as NodeJS.ErrnoException).code === 'ENOENT') { tryNext(); return; }
                const out = (stdout || '') + (stderr ? (stdout ? '\n[stderr]\n' : '[stderr]\n') + stderr : '');
                resolve((out.trim() || '（無輸出）').slice(0, 8000));
              });
            };
            tryNext();
          });
        } finally {
          try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
        }
      }
      case 'git_status': {
        const gitRoot = (args.path as string) ? resolvePath(args.path as string) : (wsRoot || process.cwd());
        return await new Promise<string>((resolve) => {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { exec } = require('child_process') as typeof import('child_process');
          exec('git status', { cwd: gitRoot, timeout: 10000 }, (_err, stdout, stderr) => {
            resolve((stdout || stderr || '（無輸出）').trim().slice(0, 8000));
          });
        });
      }
      case 'git_diff': {
        const gitRoot2 = wsRoot || process.cwd();
        const diffFile = (args.file as string) || '';
        const diffStaged = (args.staged as boolean) ? '--cached ' : '';
        const diffCmd = ('git diff ' + diffStaged + diffFile).trim();
        return await new Promise<string>((resolve) => {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { exec } = require('child_process') as typeof import('child_process');
          exec(diffCmd, { cwd: gitRoot2, timeout: 15000 }, (_err, stdout, stderr) => {
            const out = (stdout || stderr || '').trim();
            resolve((out || '（無變更）').slice(0, 16000));
          });
        });
      }
      case 'git_log': {
        const gitRoot3 = wsRoot || process.cwd();
        const logCount = Math.min(Number(args.count || 20), 100);
        const logFile = (args.file as string) ? ('-- ' + args.file) : '';
        const logCmd = ('git log --oneline -' + logCount + ' ' + logFile).trim();
        return await new Promise<string>((resolve) => {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { exec } = require('child_process') as typeof import('child_process');
          exec(logCmd, { cwd: gitRoot3, timeout: 10000 }, (_err, stdout, stderr) => {
            resolve((stdout || stderr || '（無歷史）').trim().slice(0, 8000));
          });
        });
      }
      case 'git_commit': {
        const gitRoot4 = wsRoot || process.cwd();
        const commitMsg = ((args.message as string) || '').trim();
        if (!commitMsg) return '請提供 commit message';
        const addAll = (args.add_all as boolean) !== false;
        const allowed = await this.requestPermission('run', `Git Commit: ${commitMsg}`, 'git_commit');
        if (!allowed) return '使用者已拒絕 git commit 操作';
        const safeMsg = commitMsg.replace(/"/g, '\\"');
        const commitCmd = addAll ? `git add -A && git commit -m "${safeMsg}"` : `git commit -m "${safeMsg}"`;
        return await new Promise<string>((resolve) => {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { exec } = require('child_process') as typeof import('child_process');
          exec(commitCmd, { cwd: gitRoot4, timeout: 30000, shell: true as unknown as string }, (_err, stdout, stderr) => {
            const out = (stdout || '') + (stderr ? (stdout ? '\n[stderr]\n' : '[stderr]\n') + stderr : '');
            resolve((out.trim() || '（無輸出）').slice(0, 4000));
          });
        });
      }
      case 'http_request': {
        const reqMethod = ((args.method as string) || 'GET').toUpperCase();
        const reqUrl = (args.url as string || '').trim();
        if (!reqUrl) return '請提供 url 參數';
        const reqHeaders = (args.headers as Record<string, string>) || {};
        const reqBody = args.body ? String(args.body) : undefined;
        const reqTimeout = Number(args.timeout || 15000);
        if (reqMethod !== 'GET' && reqMethod !== 'HEAD') {
          const allowed = await this.requestPermission('run', `HTTP ${reqMethod}: ${reqUrl}`, 'http_request');
          if (!allowed) return '使用者已拒絕 HTTP 請求';
        }
        return new Promise<string>((resolve) => {
          let parsedUrl: URL;
          try { parsedUrl = new URL(reqUrl); } catch { resolve('無效的 URL'); return; }
          const protocol = parsedUrl.protocol === 'https:' ? https : http;
          const bodyBuf = reqBody ? Buffer.from(reqBody, 'utf8') : undefined;
          const options = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: reqMethod,
            headers: {
              'User-Agent': 'AMI-AiClaw-Agent/1.0',
              'Accept': 'application/json, text/plain, */*',
              ...(bodyBuf ? { 'Content-Type': 'application/json', 'Content-Length': bodyBuf.length } : {}),
              ...reqHeaders,
            },
          };
          let buf = '';
          const req = protocol.request(options, (res) => {
            res.setEncoding('utf8');
            res.on('data', (d: string) => { buf += d; if (buf.length > 100000) { res.destroy(); } });
            res.on('end', () => {
              const statusLine = `HTTP ${res.statusCode} ${res.statusMessage}`;
              const hdrs = Object.entries(res.headers).slice(0, 8).map(([k, v]) => `${k}: ${v}`).join('\n');
              resolve(`${statusLine}\n${hdrs}\n\n${buf.trim().slice(0, 8000)}`);
            });
            res.on('error', (e: Error) => resolve(`回應錯誤: ${e.message}`));
          });
          req.on('error', (e: Error) => resolve(`網路錯誤: ${e.message}`));
          req.setTimeout(reqTimeout, () => { req.destroy(); resolve(`超時 (${reqTimeout}ms)`); });
          if (bodyBuf) { req.write(bodyBuf); }
          req.end();
        });
      }
      case 'db_query': {
        const dbPath = resolvePath(args.db_path as string);
        const sqlQuery = (args.query as string || '').trim();
        if (!sqlQuery) return '請提供 query 參數';
        const sqlParams = args.params ? JSON.stringify(args.params) : '[]';
        const isWriteOp = /^\s*(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|ATTACH|DETACH)/i.test(sqlQuery);
        if (isWriteOp) {
          const allowed = await this.requestPermission('run', `SQLite 寫入: ${sqlQuery.slice(0, 80)}`, 'db_query');
          if (!allowed) return '使用者已拒絕資料庫寫入操作';
        }
        const pyCode = `import sqlite3, json, sys
db_path = ${JSON.stringify(dbPath)}
query = ${JSON.stringify(sqlQuery)}
params = json.loads(${JSON.stringify(sqlParams)})
try:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute(query, params)
    if cur.description:
        cols = [d[0] for d in cur.description]
        rows = [list(r) for r in cur.fetchmany(200)]
        col_widths = [max(len(str(c)), max((len(str(r[i])) for r in rows), default=0)) for i, c in enumerate(cols)]
        sep = '+' + '+'.join('-'*(w+2) for w in col_widths) + '+'
        header = '|' + '|'.join(f' {c:<{w}} ' for c, w in zip(cols, col_widths)) + '|'
        print(sep); print(header); print(sep)
        for row in rows: print('|' + '|'.join(f' {str(v):<{w}} ' for v, w in zip(row, col_widths)) + '|')
        print(sep)
        print(f'({len(rows)} rows)')
    else:
        conn.commit()
        print(f'OK, affected rows: {cur.rowcount}')
    conn.close()
except Exception as e:
    print(f'Error: {e}', file=sys.stderr)
`;
        const dbTmpFile = path.join(os.tmpdir(), `ami_ai_claw_py_${Date.now()}.py`);
        try {
          fs.writeFileSync(dbTmpFile, pyCode, 'utf-8');
          return await new Promise<string>((resolve) => {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { exec } = require('child_process') as typeof import('child_process');
            const pythonCmds = process.platform === 'win32' ? ['py', 'python', 'python3'] : ['python3', 'python'];
            let tried = 0;
            const tryNext = () => {
              if (tried >= pythonCmds.length) { resolve('錯誤：找不到 Python，無法執行 SQLite 查詢'); return; }
              const pcmd = pythonCmds[tried++];
              exec(`${pcmd} "${dbTmpFile}"`, { cwd: wsRoot || process.cwd(), timeout: 30000 }, (_err, stdout, stderr) => {
                if (_err && (_err as NodeJS.ErrnoException).code === 'ENOENT') { tryNext(); return; }
                const out = (stdout || '') + (stderr ? (stdout ? '\n[stderr]\n' : '[stderr]\n') + stderr : '');
                resolve((out.trim() || '（無輸出）').slice(0, 8000));
              });
            };
            tryNext();
          });
        } finally { try { fs.unlinkSync(dbTmpFile); } catch { /* ignore */ } }
      }
      case 'agentic_file_search': {
        const afQuery = ((args.query as string) ?? '').trim();
        if (!afQuery) return '請提供 query 參數';
        const afInclude = (args.include as string) || '**/*.{ts,js,tsx,jsx,py,cs,java,go,rs,cpp,c,h,vue,svelte}';
        const afTopK = Math.min(Math.max(Number(args.top_k) || 10, 1), 30);
        // 從 query 中抽取關鍵字（切 camelCase/snake_case，小寫，去掉停用詞）
        const afStopWords = new Set(['的','在','裡','中','使用','處理','負責','找出','哪個','檔案','函式','類別','實作','實現','相關','所有','一個','如何','為何','what','which','file','for','the','and','or','that','with','from','this','how','where','when']);
        const afKeywords = afQuery
          .replace(/([a-z])([A-Z])/g, '$1 $2') // camelCase
          .replace(/[_\-./]/g, ' ')
          .toLowerCase().split(/\s+/)
          .filter(w => w.length >= 2 && !afStopWords.has(w));
        const SKIP_BINARY = new Set(['.png','.jpg','.jpeg','.gif','.ico','.svg','.woff','.woff2','.ttf','.eot','.vsix','.zip','.tar','.gz','.exe','.dll','.pdf','.db','.sqlite','.lock','.wasm']);
        // 宣告抽取：函式/類別/介面/const/export
        const afDeclReLines = /^\s*(?:export\s+)?(?:(?:async\s+)?function\*?\s+([\w$]+)|class\s+([\w$]+)|interface\s+([\w$]+)|type\s+([\w$]+)\s*(?:<[^>]*>)?\s*=|(?:const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>|def\s+([\w_]+)|func\s+([\w_]+)\s*\(|public\s+(?:static\s+)?\S+\s+([\w_]+)\s*\()/;
        const afAllUris = await vscode.workspace.findFiles(afInclude, '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**,**/build/**}', 1000);
        const afScores: { rel: string; score: number; decls: string[] }[] = [];
        for (const uri of afAllUris) {
          const ext = path.extname(uri.fsPath).toLowerCase();
          if (SKIP_BINARY.has(ext)) continue;
          const rel = path.relative(wsRoot, uri.fsPath).replace(/\\/g, '/');
          // filename match
          const relLower = rel.toLowerCase();
          let score = afKeywords.reduce((s, kw) => s + (relLower.includes(kw) ? 3 : 0), 0);
          let decls: string[] = [];
          try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            const text = Buffer.from(bytes).toString('utf8').slice(0, 60000);
            const lines = text.split('\n');
            for (let li = 0; li < lines.length; li++) {
              const m2 = afDeclReLines.exec(lines[li]);
              if (m2) {
                const declName = m2.slice(1).find(Boolean) ?? '';
                if (declName) decls.push(`L${li+1} ${declName}`);
              }
            }
            // content keyword score
            const contentLower = text.toLowerCase();
            score += afKeywords.reduce((s, kw) => {
              const occurrences = (contentLower.match(new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
              return s + Math.min(occurrences, 5);
            }, 0);
            // bonus: declaration name matches keyword
            score += decls.reduce((s, d) => s + afKeywords.reduce((ss, kw) => ss + (d.toLowerCase().includes(kw) ? 4 : 0), 0), 0);
          } catch { /* skip binary */ }
          if (score > 0 || decls.length > 0) afScores.push({ rel, score, decls });
        }
        afScores.sort((a, b) => b.score - a.score);
        const afTop = afScores.slice(0, afTopK);
        if (afTop.length === 0) return `找不到與「${afQuery}」相關的檔案`;
        const afOut = afTop.map((f, i) => {
          const declStr = f.decls.length > 0
            ? `\n  宣告: ${f.decls.slice(0, 20).join(', ')}${f.decls.length > 20 ? ` …(+${f.decls.length-20})` : ''}`
            : '';
          return `${i+1}. ${f.rel} (相關度:${f.score})${declStr}`;
        }).join('\n');
        return `=== 語意搜尋「${afQuery}」結果 (前 ${afTop.length}/${afScores.length} 個相關檔案) ===\n${afOut}`;
      }
      case 'search_regex': {
        const pattern = (args.pattern as string || '').trim();
        if (!pattern) return '請提供 pattern 參數';
        // 移除 g flag：逐行搜尋時 g flag 會保留 lastIndex 造成交替漏比對，改用無狀態的 flags
        const reFlags = ((args.flags as string) || 'i').replace(/[^imu]/g, '');
        let regex: RegExp;
        try { regex = new RegExp(pattern, reFlags); } catch (e) { return `無效的正規表達式: ${e}`; }
        const includeGlob = (args.include as string) || '**/*';
        const allUris = await vscode.workspace.findFiles(includeGlob, '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**}', 500);
        const reMatches: string[] = [];
        for (const uri of allUris) {
          if (reMatches.length >= 100) break;
          try {
            const ext = path.extname(uri.fsPath).toLowerCase();
            if (['.png','.jpg','.jpeg','.ico','.vsix','.zip','.exe','.dll','.pdf','.wasm'].includes(ext)) continue;
            const bytes = await vscode.workspace.fs.readFile(uri);
            const text = Buffer.from(bytes).toString('utf8');
            const lines = text.split('\n');
            for (let li = 0; li < lines.length && reMatches.length < 100; li++) {
              if (regex.exec(lines[li]) !== null) { reMatches.push(`${uri.fsPath}:${li + 1}: ${lines[li].trim().slice(0, 120)}`); }
            }
          } catch { /* skip binary */ }
        }
        return reMatches.length > 0
          ? `=== RegExp /${pattern}/${reFlags} 匹配 (${reMatches.length}) ===\n${reMatches.join('\n')}`
          : `找不到符合 /${pattern}/${reFlags} 的結果`;
      }
      case 'lint_fix': {
        const fixPath = resolvePath((args.path as string) || '.');
        const fixTool = (args.tool as string) || 'both';
        const lfAllowed = await this.requestPermission('run', `程式碼格式化: ${fixPath} (${fixTool})`, 'lint_fix');
        if (!lfAllowed) { return '使用者已拒絕程式碼格式化操作'; }
        const lfCwd = folders[0]?.uri.fsPath ?? process.cwd();
        const runFmt = (cmd: string) => new Promise<string>(res => {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { exec } = require('child_process') as typeof import('child_process');
          exec(cmd, { cwd: lfCwd, timeout: 30000 }, (_e, o, e) => res(((o || '') + (e ? '\n[stderr]\n' + e : '')).trim() || '(無輸出)'));
        });
        const lfResults: string[] = [];
        if (fixTool === 'eslint' || fixTool === 'both') { lfResults.push('[ESLint] ' + await runFmt(`npx eslint --fix "${fixPath}"`)); }
        if (fixTool === 'prettier' || fixTool === 'both') { lfResults.push('[Prettier] ' + await runFmt(`npx prettier --write "${fixPath}"`)); }
        return lfResults.join('\n\n') || '(無輸出)';
      }
      case 'run_tests': {
        const rtFilter = (args.filter as string) || '';
        const rtDir = (args.path as string) ? resolvePath(args.path as string) : (folders[0]?.uri.fsPath ?? process.cwd());
        const rtAllowed = await this.requestPermission('run', `執行測試${rtFilter ? ': ' + rtFilter : ''}`, 'run_tests');
        if (!rtAllowed) { return '使用者已拒絕執行測試'; }
        let rtRunner = 'npx jest --passWithNoTests';
        try {
          const rtPkgTxt = fs.readFileSync(path.join(folders[0]?.uri.fsPath ?? process.cwd(), 'package.json'), 'utf-8');
          const rtPkg = JSON.parse(rtPkgTxt) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string> };
          const rtDeps = { ...rtPkg.dependencies, ...rtPkg.devDependencies };
          const rtScripts = rtPkg.scripts ?? {};
          if (rtDeps['vitest'] || Object.values(rtScripts).some(s => s.includes('vitest'))) { rtRunner = 'npx vitest run'; }
          else if (rtDeps['mocha']) { rtRunner = 'npx mocha'; }
          else if (rtDeps['pytest'] || rtDeps['py.test']) { rtRunner = 'python -m pytest -v'; }
        } catch { /* use default */ }
        const rtFilterFlag = rtFilter
          ? (rtRunner.includes('vitest') || rtRunner.includes('jest') ? ` -t "${rtFilter}"` : rtRunner.includes('pytest') ? ` -k "${rtFilter}"` : '')
          : '';
        const rtCmd = `${rtRunner}${rtFilterFlag}`.trim();
        return await new Promise<string>(res => {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { exec } = require('child_process') as typeof import('child_process');
          exec(rtCmd, { cwd: rtDir, timeout: 60000 }, (_e, o, e) => {
            const out = ((o || '') + (e ? '\n[stderr]\n' + e : '')).trim();
            res(out.slice(0, 10000) || '(無輸出)');
          });
        });
      }
      case 'browser_navigate': {
        const bnUrl = (args.url as string || '').trim();
        if (!bnUrl) return '請提供 url 參數';
        const bnWaitFor = (args.wait_for as string) || 'networkidle';
        const bnSelector = (args.selector as string) || '';
        const bnTimeout = Math.min(Number(args.timeout_ms || 20000), 60000);
        const bnAllowed = await this.requestPermission('run', `瀏覽器訪問: ${bnUrl}`, 'browser_navigate');
        if (!bnAllowed) return '使用者已拒絕瀏覽器操作';
        const bnCfg = vscode.workspace.getConfiguration('amiAiClaw');
        const bnUseDocker = bnCfg.get<boolean>('browserUseDocker', false);
        const bnDockerImage = bnCfg.get<string>('browserDockerImage', 'mcr.microsoft.com/playwright/python:v1.49.0-jammy');
        const bnPyCore = [
          'import asyncio, json, sys',
          ...(bnUseDocker
            ? ['from playwright.async_api import async_playwright']
            : ['try:', '    from playwright.async_api import async_playwright',
               'except ImportError:',
               '    print(json.dumps({"error": "找不到 playwright，請執行: pip install playwright && playwright install chromium"}))',
               '    sys.exit(0)']),
          'async def main():',
          '    async with async_playwright() as p:',
          '        browser = await p.chromium.launch(headless=True)',
          '        page = await browser.new_page()',
          '        page.set_default_timeout(' + bnTimeout + ')',
          '        try:',
          '            await page.goto(' + JSON.stringify(bnUrl) + ', wait_until=' + JSON.stringify(bnWaitFor) + ', timeout=' + bnTimeout + ')',
          ...(bnSelector ? ['            await page.wait_for_selector(' + JSON.stringify(bnSelector) + ', timeout=10000)'] : []),
          '            title = await page.title()',
          '            current_url = page.url',
          '            try:',
          '                text = await page.inner_text("body")',
          '            except Exception:',
          '                text = await page.content()',
          '            links = await page.eval_on_selector_all("a[href]", "els => els.slice(0,20).map(e => ({text: e.innerText.trim(), href: e.href}))")',
          '            print(json.dumps({"title": title, "url": current_url, "text": text[:8000], "links": links}, ensure_ascii=False))',
          '        except Exception as e:',
          '            print(json.dumps({"error": str(e)}))',
          '        finally:',
          '            await browser.close()',
          'asyncio.run(main())',
        ].join('\n');
        const parseBnResult = (raw: string): string => {
          try {
            const j = JSON.parse(raw) as { error?: string; title?: string; url?: string; text?: string; links?: Array<{ text: string; href: string }> };
            if (j.error) return `瀏覽器錯誤: ${j.error}`;
            const linksStr = j.links && j.links.length > 0 ? '\n\n=== 連結 ===\n' + j.links.map(l => `[${l.text || '(no text)'}] ${l.href}`).join('\n') : '';
            return `標題: ${j.title}\n網址: ${j.url}\n\n=== 頁面文字 ===\n${j.text}${linksStr}`;
          } catch { return raw.slice(0, 8000) || '(無輸出)'; }
        };
        if (bnUseDocker) { return parseBnResult(await runDockerPython(bnPyCore, bnDockerImage, bnTimeout + 15000)); }
        const bnTmp = path.join(os.tmpdir(), `ami_browser_nav_${Date.now()}.py`);
        try {
          fs.writeFileSync(bnTmp, bnPyCore, 'utf-8');
          return await new Promise<string>(res => {
            const { exec } = require('child_process') as typeof import('child_process');
            const cmds = process.platform === 'win32' ? ['py', 'python', 'python3'] : ['python3', 'python'];
            let tried = 0;
            const tryNext = () => {
              if (tried >= cmds.length) { res('錯誤：找不到 Python'); return; }
              const pc = cmds[tried++];
              exec(`${pc} "${bnTmp}"`, { cwd: wsRoot || process.cwd(), timeout: bnTimeout + 10000 }, (_e, o, e) => {
                if (_e && (_e as NodeJS.ErrnoException).code === 'ENOENT') { tryNext(); return; }
                res(parseBnResult((o || e || '').trim()));
              });
            };
            tryNext();
          });
        } finally { try { fs.unlinkSync(bnTmp); } catch { /* ignore */ } }
      }
      case 'browser_screenshot': {
        const bsUrl = (args.url as string || '').trim();
        if (!bsUrl) return '請提供 url 參數';
        const bsOutRaw = (args.path as string || `screenshot_${Date.now()}.png`);
        const bsOut = path.isAbsolute(bsOutRaw) ? bsOutRaw : path.join(folders[0]?.uri.fsPath ?? process.cwd(), bsOutRaw);
        const bsSelector = (args.selector as string) || '';
        const bsAllowed = await this.requestPermission('write', `瀏覽器截圖: ${bsUrl} → ${bsOut}`, 'browser_screenshot');
        if (!bsAllowed) return '使用者已拒絕截圖操作';
        const bsCfg = vscode.workspace.getConfiguration('amiAiClaw');
        const bsUseDocker = bsCfg.get<boolean>('browserUseDocker', false);
        const bsDockerImage = bsCfg.get<string>('browserDockerImage', 'mcr.microsoft.com/playwright/python:v1.49.0-jammy');
        // Docker 模式：Python 輸出 base64 JSON（避免改容器路徑挂載問題）
        if (bsUseDocker) {
          const bsPyDocker = [
            'import asyncio, json, base64',
            'from playwright.async_api import async_playwright',
            'async def main():',
            '    async with async_playwright() as p:',
            '        browser = await p.chromium.launch(headless=True)',
            '        page = await browser.new_page(viewport={"width": 1280, "height": 800})',
            '        try:',
            '            await page.goto(' + JSON.stringify(bsUrl) + ', wait_until="networkidle", timeout=25000)',
            ...(bsSelector ? ['            await page.wait_for_selector(' + JSON.stringify(bsSelector) + ', timeout=10000)'] : []),
            '            target = page if not ' + JSON.stringify(bsSelector) + ' else await page.query_selector(' + JSON.stringify(bsSelector || 'body') + ')',
            '            data = await target.screenshot(full_page=True)',
            '            print(json.dumps({"ok": True, "b64": base64.b64encode(data).decode()}))',
            '        except Exception as e:',
            '            print(json.dumps({"error": str(e)}))',
            '        finally:',
            '            await browser.close()',
            'asyncio.run(main())',
          ].join('\n');
          const rawBs = await runDockerPython(bsPyDocker, bsDockerImage, 40000);
          try {
            const j = JSON.parse(rawBs) as { ok?: boolean; b64?: string; error?: string };
            if (j.error) return `截圖錯誤: ${j.error}`;
            if (j.b64) { fs.writeFileSync(bsOut, Buffer.from(j.b64, 'base64')); return `截圖已儲存: ${bsOut}`; }
          } catch { return rawBs || '(無輸出)'; }
        }
        // 本機模式：直接儲存檔案
        const bsPyLocal = [
          'import asyncio, json, sys',
          'try:',
          '    from playwright.async_api import async_playwright',
          'except ImportError:',
          '    print(json.dumps({"error": "找不到 playwright，請執行: pip install playwright && playwright install chromium"}))',
          '    sys.exit(0)',
          'async def main():',
          '    async with async_playwright() as p:',
          '        browser = await p.chromium.launch(headless=True)',
          '        page = await browser.new_page(viewport={"width": 1280, "height": 800})',
          '        try:',
          '            await page.goto(' + JSON.stringify(bsUrl) + ', wait_until="networkidle", timeout=20000)',
          ...(bsSelector ? ['            await page.wait_for_selector(' + JSON.stringify(bsSelector) + ', timeout=10000)'] : []),
          '            target = page if not ' + JSON.stringify(bsSelector) + ' else await page.query_selector(' + JSON.stringify(bsSelector || 'body') + ')',
          '            out_path = ' + JSON.stringify(bsOut),
          '            await target.screenshot(path=out_path, full_page=True)',
          '            print(json.dumps({"ok": True, "path": out_path}))',
          '        except Exception as e:',
          '            print(json.dumps({"error": str(e)}))',
          '        finally:',
          '            await browser.close()',
          'asyncio.run(main())',
        ].join('\n');
        const bsTmp = path.join(os.tmpdir(), `ami_browser_ss_${Date.now()}.py`);
        try {
          fs.writeFileSync(bsTmp, bsPyLocal, 'utf-8');
          return await new Promise<string>(res => {
            const { exec } = require('child_process') as typeof import('child_process');
            const cmds = process.platform === 'win32' ? ['py', 'python', 'python3'] : ['python3', 'python'];
            let tried = 0;
            const tryNext = () => {
              if (tried >= cmds.length) { res('錯誤：找不到 Python'); return; }
              const pc = cmds[tried++];
              exec(`${pc} "${bsTmp}"`, { cwd: wsRoot || process.cwd(), timeout: 35000 }, (_e, o, e) => {
                if (_e && (_e as NodeJS.ErrnoException).code === 'ENOENT') { tryNext(); return; }
                const raw = (o || e || '').trim();
                try {
                  const j = JSON.parse(raw) as { ok?: boolean; path?: string; error?: string };
                  if (j.error) { res(`截圖錯誤: ${j.error}`); return; }
                  res(`截圖已儲存: ${j.path}`);
                } catch { res(raw || '(無輸出)'); }
              });
            };
            tryNext();
          });
        } finally { try { fs.unlinkSync(bsTmp); } catch { /* ignore */ } }
      }
      case 'browser_script': {
        const bscCode = (args.script as string || '').trim();
        if (!bscCode) return '請提供 script 參數（Python playwright 程式碼）';
        const bscDesc = (args.description as string || bscCode.split('\n')[0]).slice(0, 120);
        const bscAllowed = await this.requestPermission('run', `瀏覽器腳本: ${bscDesc}`, 'browser_script');
        if (!bscAllowed) return '使用者已拒絕瀏覽器腳本執行';
        const bscCfg = vscode.workspace.getConfiguration('amiAiClaw');
        const bscUseDocker = bscCfg.get<boolean>('browserUseDocker', false);
        const bscDockerImage = bscCfg.get<string>('browserDockerImage', 'mcr.microsoft.com/playwright/python:v1.49.0-jammy');
        const bscFull = bscCode.includes('playwright') ? bscCode
          : 'from playwright.sync_api import sync_playwright\n' + bscCode;
        if (bscUseDocker) { return await runDockerPython(bscFull, bscDockerImage, 130000); }
        const bscTmp = path.join(os.tmpdir(), `ami_browser_script_${Date.now()}.py`);
        try {
          fs.writeFileSync(bscTmp, bscFull, 'utf-8');
          return await new Promise<string>(res => {
            const { exec } = require('child_process') as typeof import('child_process');
            const cmds = process.platform === 'win32' ? ['py', 'python', 'python3'] : ['python3', 'python'];
            let tried = 0;
            const tryNext = () => {
              if (tried >= cmds.length) { res('錯誤：找不到 Python'); return; }
              const pc = cmds[tried++];
              exec(`${pc} "${bscTmp}"`, { cwd: wsRoot || process.cwd(), timeout: 120000 }, (_e, o, e) => {
                if (_e && (_e as NodeJS.ErrnoException).code === 'ENOENT') { tryNext(); return; }
                const out = ((o || '') + (e ? '\n[stderr]\n' + e : '')).trim();
                res(out.slice(0, 10000) || '(無輸出)');
              });
            };
            tryNext();
          });
        } finally { try { fs.unlinkSync(bscTmp); } catch { /* ignore */ } }
      }
      case 'generate_docs': {
        const gdDocPath = (args.path as string) ? resolvePath(args.path as string) : (folders[0]?.uri.fsPath ?? process.cwd());
        const gdTool = (args.tool as string) || 'auto';
        const gdOutput = (args.output as string) || 'docs';
        const gdCwd = folders[0]?.uri.fsPath ?? process.cwd();
        const gdAllowed = await this.requestPermission('run', `產生 API 文件: ${gdDocPath} (${gdTool})`, 'generate_docs');
        if (!gdAllowed) { return '使用者已拒絕文件產生操作'; }
        let actualDocTool = gdTool;
        if (actualDocTool === 'auto') {
          try {
            const gdPkgTxt = fs.readFileSync(path.join(gdCwd, 'package.json'), 'utf-8');
            const gdPkg = JSON.parse(gdPkgTxt) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
            const gdDeps = { ...gdPkg.dependencies, ...gdPkg.devDependencies };
            if (gdDeps['typedoc']) { actualDocTool = 'typedoc'; }
            else if (gdDeps['jsdoc']) { actualDocTool = 'jsdoc'; }
            else if (fs.existsSync(path.join(gdCwd, 'typedoc.json')) || fs.existsSync(path.join(gdCwd, 'typedoc.config.js'))) { actualDocTool = 'typedoc'; }
            else if (fs.existsSync(path.join(gdCwd, '.jsdocrc')) || fs.existsSync(path.join(gdCwd, '.jsdocrc.js'))) { actualDocTool = 'jsdoc'; }
            else { actualDocTool = 'typedoc'; }
          } catch { actualDocTool = 'typedoc'; }
        }
        const gdCmd = actualDocTool === 'jsdoc'
          ? `npx jsdoc -d "${gdOutput}" -r "${gdDocPath}"`
          : `npx typedoc --out "${gdOutput}" "${gdDocPath}"`;
        return await new Promise<string>(res => {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { exec } = require('child_process') as typeof import('child_process');
          exec(gdCmd, { cwd: gdCwd, timeout: 60000 }, (_e, o, e) => {
            const out = ((o || '') + (e ? '\n[stderr]\n' + e : '')).trim();
            const outDir = path.join(gdCwd, gdOutput);
            const existsMsg = fs.existsSync(outDir) ? `\n\n✅ 文件已產生至: ${outDir}` : '';
            res((out.slice(0, 8000) || '(無輸出)') + existsMsg);
          });
        });
      }
      case 'refactor_suggest': {
        const rsFilePath = resolvePath(args.path as string);
        const rsFocus = (args.focus as string) || 'all';
        const rsAllowed = await this.requestPermission('read', `讀取並分析: ${rsFilePath}`, 'refactor_suggest');
        if (!rsAllowed) { return '使用者已拒絕程式碼分析'; }
        let rsContent: string;
        try {
          const rsStats = fs.statSync(rsFilePath);
          if (rsStats.size > 500 * 1024) { return '檔案超過 500KB，無法一次分析，請指定較小的檔案或特定函式'; }
          rsContent = fs.readFileSync(rsFilePath, 'utf-8');
        } catch (e) { return `讀取檔案失敗: ${e instanceof Error ? e.message : String(e)}`; }
        const rsCwd = folders[0]?.uri.fsPath ?? process.cwd();
        const rsTmpCfg = path.join(os.tmpdir(), `ami_eslint_rs_${Date.now()}.json`);
        const rsEslintCfg = { env: { browser: true, es2020: true, node: true }, rules: { complexity: ['warn', 10], 'max-lines-per-function': ['warn', 60], 'max-depth': ['warn', 4], 'max-params': ['warn', 5] } };
        fs.writeFileSync(rsTmpCfg, JSON.stringify(rsEslintCfg), 'utf-8');
        let rsEslintOut = '(跳過 ESLint 分析)';
        try {
          rsEslintOut = await new Promise<string>(res => {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { exec } = require('child_process') as typeof import('child_process');
            exec(`npx eslint --no-eslintrc -c "${rsTmpCfg}" --format compact "${rsFilePath}"`, { cwd: rsCwd, timeout: 20000 }, (_e, o, e) => {
              res(((o || '') + (e && !o ? '\n' + e : '')).trim().slice(0, 3000) || '✅ 無複雜度警告');
            });
          });
        } finally { try { fs.unlinkSync(rsTmpCfg); } catch { /* ignore */ } }
        const rsLines = rsContent.split('\n');
        const rsFocusNote = rsFocus !== 'all' ? `\n分析重點: ${rsFocus}` : '';
        const rsNumbered = rsLines.slice(0, 500).map((l, i) => `${String(i + 1).padStart(4)}: ${l}`).join('\n');
        const rsReport = [
          `=== 重構分析: ${rsFilePath} ===`,
          `行數: ${rsLines.length} | 字元數: ${rsContent.length}${rsFocusNote}`,
          '',
          '--- ESLint 複雜度/品質警告 ---',
          rsEslintOut,
          '',
          '--- 原始碼（含行號，供 AI 標記問題位置）---',
          rsNumbered,
          rsLines.length > 500 ? `\n...[省略 ${rsLines.length - 500} 行，請用 read_file 取得剩餘內容]` : ''
        ].join('\n');
        return rsReport.slice(0, 20000);
      }
      case 'whatsapp_connect':
      case 'whatsapp_status':
      case 'whatsapp_disconnect':
      case 'whatsapp_save_credentials':
      case 'whatsapp_send':
      case 'whatsapp_send_template':
        return this._callbacks.handleWhatsAppTool(name, args);
      case 'jenkins_build': {
        const jbCfg = vscode.workspace.getConfiguration('amiAiClaw');
        const jbUrl = jbCfg.get<string>('jenkinsUrl', 'http://localdev.visualebios').replace(/\/+$/, '');
        const jbUser = jbCfg.get<string>('jenkinsUser', '').trim();
        const jbToken = jbCfg.get<string>('jenkinsToken', '').trim();
        const jbDefaultJob = jbCfg.get<string>('jenkinsDefaultJob', 'SeamlessBuild').trim();
        const jbJob = ((args.job as string) || jbDefaultJob).trim();
        const jbParams = args.params as Record<string, string> | undefined;
        const jbWait = args.wait !== false; // 預設等待 30s 驗收結果
        const jbAllowed = await this.requestPermission('run', `觸發 Jenkins 樣式: ${jbUrl}/job/${jbJob}${jbParams ? ' (' + JSON.stringify(jbParams).slice(0, 80) + ')' : ''}`, 'jenkins_build');
        if (!jbAllowed) return '使用者已拒絕 Jenkins Build';
        const jbAuth = (jbUser && jbToken) ? 'Basic ' + Buffer.from(`${jbUser}:${jbToken}`).toString('base64') : '';
        // 取得 CSRF Crumb
        const jbGetCrumb = (): Promise<{ field: string; value: string } | null> => new Promise(res => {
          const cu = new URL('/crumbIssuer/api/json', jbUrl);
          const isHttps = cu.protocol === 'https:';
          const proto = isHttps ? https : http;
          const crumbOpts = {
            hostname: cu.hostname, port: cu.port || (isHttps ? 443 : 80),
            path: cu.pathname, method: 'GET',
            headers: { 'Accept': 'application/json', ...(jbAuth ? { 'Authorization': jbAuth } : {}) }
          };
          let cb = ''; const cReq = proto.request(crumbOpts, r => {
            r.setEncoding('utf8'); r.on('data', (d: string) => { cb += d; });
            r.on('end', () => {
              try { const j = JSON.parse(cb) as Record<string, string>; res({ field: j.crumbRequestField, value: j.crumb }); }
              catch { res(null); }
            });
          });
          cReq.on('error', () => res(null)); cReq.setTimeout(5000, () => { cReq.destroy(); res(null); }); cReq.end();
        });
        // 發送 HTTP 請求的通用函數
        const jbHttp = (urlStr: string, method: string, postBody?: string, extraHdrs: Record<string, string> = {}): Promise<{ status: number; body: string; location?: string }> =>
          new Promise(res => {
            let pu: URL; try { pu = new URL(urlStr); } catch { res({ status: 0, body: '無效 URL: ' + urlStr }); return; }
            const isHttps = pu.protocol === 'https:';
            const proto = isHttps ? https : http;
            const bodyBuf = postBody ? Buffer.from(postBody, 'utf8') : undefined;
            const opts = {
              hostname: pu.hostname, port: pu.port || (isHttps ? 443 : 80),
              path: pu.pathname + pu.search, method,
              headers: {
                'Accept': 'application/json',
                ...(jbAuth ? { 'Authorization': jbAuth } : {}),
                ...(bodyBuf ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': bodyBuf.length } : {}),
                ...extraHdrs
              }
            };
            let rb = '';
            const req = proto.request(opts, r => {
              r.setEncoding('utf8'); r.on('data', (d: string) => { rb += d; });
              r.on('end', () => res({ status: r.statusCode ?? 0, body: rb, location: r.headers.location as string | undefined }));
            });
            req.on('error', (e: Error) => res({ status: 0, body: '網路錯誤: ' + e.message }));
            req.setTimeout(15000, () => { req.destroy(); res({ status: 0, body: '超時 (15s)' }); });
            if (bodyBuf) { req.write(bodyBuf); }
            req.end();
          });
        const crumb = await jbGetCrumb();
        const crumbHdr: Record<string, string> = crumb ? { [crumb.field]: crumb.value } : {};
        // 建立對應的觸發端點
        let jbTriggerPath: string;
        let jbPostBody: string | undefined;
        if (jbParams && Object.keys(jbParams).length > 0) {
          jbTriggerPath = `${jbUrl}/job/${encodeURIComponent(jbJob)}/buildWithParameters`;
          jbPostBody = Object.entries(jbParams).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
        } else {
          jbTriggerPath = `${jbUrl}/job/${encodeURIComponent(jbJob)}/build`;
        }
        const triggerResp = await jbHttp(jbTriggerPath, 'POST', jbPostBody, crumbHdr);
        if (triggerResp.status === 0) return `無法連線 Jenkins: ${triggerResp.body}`;
        if (triggerResp.status >= 400) return `Jenkins Build 觸發失敗 HTTP ${triggerResp.status}: ${triggerResp.body.slice(0, 300)}`;
        const queueUrl = triggerResp.location;
        let queueMsg = queueUrl ? `\n排隊位置: ${queueUrl}` : '';
        let buildNumber: number | null = null;
        // 如果要求等待，輪詢 queue item
        if (jbWait && queueUrl) {
          const jbPoll = async (): Promise<number | null> => {
            for (let i = 0; i < 12; i++) {
              await new Promise(r => setTimeout(r, 5000));
              const qa = queueUrl.replace(/\/?$/, '/api/json');
              const qr = await jbHttp(qa, 'GET');
              if (qr.status === 200) {
                try {
                  const qj = JSON.parse(qr.body) as Record<string, unknown>;
                  const ex = qj.executable as Record<string, unknown> | undefined;
                  if (ex?.number) { return ex.number as number; }
                } catch { /* continue polling */ }
              }
            }
            return null;
          };
          this._callbacks.postToWebview({ type: 'agentStep', icon: '⏳', title: `等待 Jenkins [${jbJob}] 第 one 次輪詢 Job 開始…`, fullPath: '' });
          buildNumber = await jbPoll();
          if (buildNumber) {
            const statusResp = await jbHttp(`${jbUrl}/job/${encodeURIComponent(jbJob)}/${buildNumber}/api/json`, 'GET');
            if (statusResp.status === 200) {
              try {
                const sj = JSON.parse(statusResp.body) as Record<string, unknown>;
                const result = (sj.result as string | null) ?? '進行中';
                const dur = sj.duration ? ` | 耗時: ${Math.round(Number(sj.duration) / 1000)}s` : '';
                queueMsg += `\n編號: #${buildNumber} | 狀態: ${result}${dur}`;
              } catch { /* ignore */ }
            }
          }
        }
        return `✅ Jenkins Build 已觸發: ${jbUrl}/job/${jbJob}${queueMsg}${buildNumber ? `\n建置詳情: ${jbUrl}/job/${encodeURIComponent(jbJob)}/${buildNumber}` : '\n提示: 可用 jenkins_status 工具查詢建置結果'}`;
      }
      case 'read_workspace': {
        const rwInclude = (args.include as string) || '**/*.{ts,js,tsx,jsx,py,cs,java,go,rs,cpp,c,h,md,json,yaml,yml,txt}';
        const rwExtraExclude = ((args.exclude as string) || '').split(',').map(s => s.trim()).filter(Boolean);
        const rwDefaultExclude = ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/out/**', '**/build/**', '**/.next/**', '**/__pycache__/**', '**/*.min.js', '**/*.map'];
        const rwExcludeGlob = '{' + [...rwDefaultExclude, ...rwExtraExclude].join(',') + '}';
        const rwMaxFileBytes = Math.max(1, (args.max_file_kb as number) || 128) * 1024;
        const rwMaxTotalBytes = Math.max(1, (args.max_total_kb as number) || 512) * 1024;
        const rwUris = await vscode.workspace.findFiles(rwInclude, rwExcludeGlob, 2000);
        const rwBinaryExts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.bmp', '.vsix', '.zip', '.tar', '.gz', '.exe', '.dll', '.so', '.dylib', '.wasm', '.pdf', '.db', '.sqlite']);
        const rwParts: string[] = [];
        let rwTotalBytes = 0;
        let rwTruncated = false;
        for (const uri of rwUris) {
          if (rwBinaryExts.has(path.extname(uri.fsPath).toLowerCase())) { continue; }
          let content: string;
          try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            const raw = Buffer.from(bytes);
            if (raw.length > rwMaxFileBytes) {
              content = raw.toString('utf8', 0, rwMaxFileBytes) + `\n…（已截斷，原始檔案 ${Math.round(raw.length / 1024)} KB）`;
            } else {
              content = raw.toString('utf8');
            }
          } catch { continue; }
          const relPath = vscode.workspace.asRelativePath(uri);
          const entry = `### ${relPath}\n\`\`\`\n${content}\n\`\`\``;
          rwTotalBytes += Buffer.byteLength(entry, 'utf8');
          if (rwTotalBytes > rwMaxTotalBytes) { rwTruncated = true; break; }
          rwParts.push(entry);
        }
        if (rwParts.length === 0) { return `找不到符合 "${rwInclude}" 的檔案`; }
        const rwHeader = `工作區共讀取 ${rwParts.length} 個檔案（合計 ≈${Math.round(rwTotalBytes / 1024)} KB）${rwTruncated ? '，已達上限提早停止' : ''}`;
        return rwHeader + '\n\n' + rwParts.join('\n\n');
      }
      case 'jenkins_status': {
        const jsCfg = vscode.workspace.getConfiguration('amiAiClaw');
        const jsUrl = jsCfg.get<string>('jenkinsUrl', 'http://localdev.visualebios').replace(/\/+$/, '');
        const jsUser = jsCfg.get<string>('jenkinsUser', '').trim();
        const jsToken = jsCfg.get<string>('jenkinsToken', '').trim();
        const jsDefaultJob = jsCfg.get<string>('jenkinsDefaultJob', 'SeamlessBuild').trim();
        const jsJob = ((args.job as string) || jsDefaultJob).trim();
        const jsBuildNum = args.build_number ? String(args.build_number) : 'lastBuild';
        const jsIncludeLog = args.include_log !== false;
        const jsLogLines = Math.min(Number(args.log_lines || 100), 500);
        const jsAuth = (jsUser && jsToken) ? 'Basic ' + Buffer.from(`${jsUser}:${jsToken}`).toString('base64') : '';
        const jsHttp = (urlStr: string): Promise<{ status: number; body: string }> =>
          new Promise(res => {
            let pu: URL; try { pu = new URL(urlStr); } catch { res({ status: 0, body: '無效 URL' }); return; }
            const isHttps = pu.protocol === 'https:';
            const proto = isHttps ? https : http;
            let rb = '';
            const req = proto.request({
              hostname: pu.hostname, port: pu.port || (isHttps ? 443 : 80),
              path: pu.pathname + pu.search, method: 'GET',
              headers: { 'Accept': 'application/json, text/plain, */*', ...(jsAuth ? { 'Authorization': jsAuth } : {}) }
            }, r => {
              r.setEncoding('utf8'); r.on('data', (d: string) => { rb += d; if (rb.length > 200000) r.destroy(); });
              r.on('end', () => res({ status: r.statusCode ?? 0, body: rb }));
            });
            req.on('error', (e: Error) => res({ status: 0, body: '網路錯誤: ' + e.message }));
            req.setTimeout(15000, () => { req.destroy(); res({ status: 0, body: '超時' }); });
            req.end();
          });
        const infoResp = await jsHttp(`${jsUrl}/job/${encodeURIComponent(jsJob)}/${jsBuildNum}/api/json`);
        if (infoResp.status === 0) return `無法連線 Jenkins: ${infoResp.body}`;
        if (infoResp.status === 404) return `建置不存在: ${jsUrl}/job/${jsJob}/${jsBuildNum}`;
        if (infoResp.status >= 400) return `Jenkins API 錯誤 HTTP ${infoResp.status}: ${infoResp.body.slice(0, 200)}`;
        let statusOut = '';
        try {
          const bj = JSON.parse(infoResp.body) as Record<string, unknown>;
          const result = (bj.result as string | null) ?? '進行中';
          const building = bj.building as boolean | undefined;
          const dur = bj.duration ? Math.round(Number(bj.duration) / 1000) + 's' : (bj.estimatedDuration ? '預估 ' + Math.round(Number(bj.estimatedDuration) / 1000) + 's' : 'N/A');
          const ts = bj.timestamp ? new Date(Number(bj.timestamp)).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }) : 'N/A';
          const causes = ((bj.actions as Array<Record<string, unknown>>) ?? []).flatMap(a => (a.causes as Array<Record<string, string>>) ?? []).map(c => c.shortDescription ?? c.userName ?? '').filter(Boolean).join(', ');
          statusOut = [
            `=== Jenkins Build: ${jsUrl}/job/${jsJob}/${bj.number ?? jsBuildNum} ===`,
            `狀態: ${building ? '⚙️ 建置中' : (result === 'SUCCESS' ? '✅ ' : result === 'FAILURE' ? '❌ ' : result === 'ABORTED' ? '⛔ ' : '⏳ ') + result}`,
            `起始時間: ${ts}  | 耗時: ${dur}`,
            causes ? `觸發原因: ${causes}` : '',
            `建置編號: #${bj.number ?? jsBuildNum}  | URL: ${bj.url ?? ''}`,
          ].filter(Boolean).join('\n');
        } catch {
          statusOut = `HTTP ${infoResp.status}: ${infoResp.body.slice(0, 500)}`;
        }
        let consoleOut = '';
        if (jsIncludeLog) {
          const logResp = await jsHttp(`${jsUrl}/job/${encodeURIComponent(jsJob)}/${jsBuildNum}/consoleText`);
          if (logResp.status === 200) {
            const lines = logResp.body.split('\n');
            const tail = lines.slice(-jsLogLines);
            consoleOut = '\n\n--- Console 輸出 (最後 ' + tail.length + ' 行) ---\n' + tail.join('\n').slice(0, 15000);
          } else {
            consoleOut = `\n(Console 輸出無法檢索 HTTP ${logResp.status})`;
          }
        }
        return statusOut + consoleOut;
      }
      default:
        return `未知工具: ${name}`;
    }
  }

}

function runDockerPython(pyCode: string, dockerImage: string, timeoutMs: number): Promise<string> {
  return new Promise(res => {
    try {
      const { spawn } = require('child_process') as typeof import('child_process');
      const proc = spawn('docker', ['run', '--rm', '-i', '--network=host', dockerImage, 'python', '-']);
      let out = '', err = '';
      proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
      proc.stderr.on('data', (d: Buffer) => { err += d.toString(); });
      proc.on('close', () => {
        const combined = (out + (err ? '\n[stderr]\n' + err : '')).trim();
        res(combined.slice(0, 10000) || '(無輸出)');
      });
      proc.on('error', (e: Error) => res(`Docker 錯誤: ${e.message} — 請確認 Docker Desktop 正在執行`));
      const timer = setTimeout(() => { try { proc.kill(); } catch { /* noop */ } res('逾時 (' + timeoutMs + 'ms)'); }, timeoutMs);
      proc.on('close', () => clearTimeout(timer));
      proc.stdin.write(pyCode, 'utf-8');
      proc.stdin.end();
    } catch (e) {
      res(`Docker 執行失敗: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
}

/** 沙箱 Shell 執行助手：透過 `docker run --rm -i <image> sh -c "<cmd>"` 執行 shell 指令。
 *  容器沒有工作區檔案（純命令執行隔離）。
 */
function runDockerShell(cmd: string, dockerImage: string, timeoutMs: number): Promise<string> {
  return new Promise(res => {
    try {
      const { spawn } = require('child_process') as typeof import('child_process');
      const proc = spawn('docker', ['run', '--rm', '--network=host', dockerImage, 'sh', '-c', cmd]);
      let out = '', err = '';
      proc.stdout.on('data', (d: Buffer) => { out += d.toString(); if ((out + err).length > 512000) { try { proc.kill(); } catch { /* noop */ } } });
      proc.stderr.on('data', (d: Buffer) => { err += d.toString(); });
      proc.on('close', () => {
        const combined = (out + (err ? '\n[stderr]\n' + err : '')).trim();
        const r = combined.length > 10000 ? combined.slice(0, 10000) + '\n…（已截斷）' : combined || '(無輸出)';
        res(r);
      });
      proc.on('error', (e: Error) => res(`Docker 錯誤: ${e.message} — 請確認 Docker Desktop 正在執行且已拉取影像`));
      const timer = setTimeout(() => { try { proc.kill(); } catch { /* noop */ } res(`逾時 (${timeoutMs}ms)`); }, timeoutMs);
      proc.on('close', () => clearTimeout(timer));
    } catch (e) {
      res(`Docker 執行失敗: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
}

