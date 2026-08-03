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
import { ToolCache } from './ToolCache';
import { AuditEntry, ToolAuditLog, summarizeToolArgsForAudit } from './ToolAuditLog';
import { ToolPermissionDiff, ToolPolicies } from './ToolPolicies';
import type { ToolExecutorCallbacks } from './ToolTypes';
import type { IToolProvider, ToolExecutionContext } from './providers/IToolProvider';
import { GitProvider } from './providers/GitProvider';
import { JenkinsProvider } from './providers/JenkinsProvider';
import { SearchProvider } from './providers/SearchProvider';
import { ProcessProvider } from './providers/ProcessProvider';
import { VscodeProvider } from './providers/VscodeProvider';
import { FileSystemProvider } from './providers/FileSystemProvider';
import { AtlassianProvider } from './providers/AtlassianProvider';
import { NetworkProvider } from './providers/NetworkProvider';
import { IntegrationProvider } from './providers/IntegrationProvider';
import { DevToolsProvider } from './providers/DevToolsProvider';

// 對外保留型別重新匯出，避免改動 consumer
export type { AuditEntry } from './ToolAuditLog';
export type { ToolPermissionDiff } from './ToolPolicies';
export type { ToolExecutorCallbacks } from './ToolTypes';

// ─── Unified Diff helper ──────────────────────────────────────────────────────
function computeUnifiedDiff(
  aLines: string[], bLines: string[],
  fileA: string, fileB: string,
  contextLines: number
): string {
  // 簡易 LCS-based unified diff
  const m = aLines.length, n = bLines.length;
  // DP LCS table (只存長度，用回溯)
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (aLines[i - 1] === bLines[j - 1]) { dp[i][j] = dp[i-1][j-1] + 1; }
      else { dp[i][j] = Math.max(dp[i-1][j], dp[i][j-1]); }
    }
  }
  // Backtrack to get edit script
  type Edit = { op: ' ' | '-' | '+'; line: string; ai: number; bi: number };
  const edits: Edit[] = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && aLines[i-1] === bLines[j-1]) {
      edits.push({ op: ' ', line: aLines[i-1], ai: i, bi: j }); i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) {
      edits.push({ op: '+', line: bLines[j-1], ai: i, bi: j }); j--;
    } else {
      edits.push({ op: '-', line: aLines[i-1], ai: i, bi: j }); i--;
    }
  }
  edits.reverse();
  // Build hunks
  const changed = new Set(edits.map((e, idx) => e.op !== ' ' ? idx : -1).filter(x => x >= 0));
  if (changed.size === 0) { return ''; }
  const inHunk = new Set<number>();
  for (const c of changed) {
    for (let k = Math.max(0, c - contextLines); k <= Math.min(edits.length - 1, c + contextLines); k++) {
      inHunk.add(k);
    }
  }
  const lines: string[] = [`--- ${fileA}`, `+++ ${fileB}`];
  let inBlock = false, aStart = 0, bStart = 0, aCount = 0, bCount = 0;
  const hunkLines: string[] = [];
  const flushHunk = () => {
    if (hunkLines.length) {
      lines.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
      lines.push(...hunkLines);
      hunkLines.length = 0; inBlock = false;
    }
  };
  let aIdx = 1, bIdx = 1;
  for (let k = 0; k < edits.length; k++) {
    const e = edits[k];
    if (inHunk.has(k)) {
      if (!inBlock) {
        flushHunk();
        aStart = e.op === '+' ? aIdx : aIdx;
        bStart = e.op === '-' ? bIdx : bIdx;
        aCount = 0; bCount = 0; inBlock = true;
      }
      hunkLines.push(e.op + e.line);
      if (e.op !== '+') { aCount++; aIdx++; }
      if (e.op !== '-') { bCount++; bIdx++; }
    } else {
      if (inBlock) { flushHunk(); }
      if (e.op !== '+') { aIdx++; }
      if (e.op !== '-') { bIdx++; }
    }
  }
  flushHunk();
  return lines.join('\n');
}

export class ToolExecutor {
  private _cache = new ToolCache(30_000);
  private _audit: ToolAuditLog;
  private _policy: ToolPolicies;
  /** @deprecated 狀態已移至 VscodeProvider，保留此字段僅為空列表供舊代碼對比 */
  private _agentTodos: { id: number; text: string; done: boolean }[] = [];
  private _atlasJiraCred: { baseApiUrl: string; accessToken: string; expiry: number } | null = null;
  private _rovoDevCache: { url: string; token: string; expiry: number } | undefined = undefined;
  private _rovoDevNullUntil = 0;

  // Provider registry: 各 domain 工具逐步遷入， dispatch map 由工具名對映 provider
  private _providerMap = new Map<string, IToolProvider>();
  private _vscodeProvider = new VscodeProvider();

  public constructor(private readonly _callbacks: ToolExecutorCallbacks) {
    this._audit = new ToolAuditLog(this._callbacks.getExtensionContext());
    this._policy = new ToolPolicies({
      postToWebview: this._callbacks.postToWebview,
      isWaAgentMode: this._callbacks.isWaAgentMode,
      log: this._callbacks.log,
      getAutoPilotServices: this._callbacks.getAutoPilotServices,
      getRecentTranscript: this._callbacks.getRecentTranscript,
    });
    // 將已提取的 Provider 註冊到 dispatch map
    for (const provider of [
      new GitProvider(),
      new JenkinsProvider(),
      new SearchProvider(),
      new ProcessProvider(),
      this._vscodeProvider,
      new FileSystemProvider(),
      new AtlassianProvider(),
      new NetworkProvider(),
      new IntegrationProvider(),
      new DevToolsProvider(),
    ] as IToolProvider[]) {
      for (const tool of provider.tools) {
        this._providerMap.set(tool, provider);
      }
    }
  }

  public requestPermission(category: string, description: string, toolName = '', diff?: ToolPermissionDiff): Promise<boolean> {
    return this._policy.requestPermission(category, description, toolName, diff);
  }

  public hasPendingPermission(): boolean {
    return this._policy.hasPending();
  }

  public resolvePendingPermission(allow: boolean): boolean {
    return this._policy.resolvePending(allow);
  }

  public getAlwaysAllow(): ReadonlySet<string> {
    return this._policy.getAlwaysAllow();
  }

  public addAlwaysAllow(category: string): void {
    this._policy.addAlwaysAllow(category);
  }

  public clearAgentTodos(): void {
    this._vscodeProvider.clearTodos();
  }

  /** 供影子督促人格取得未結案待辦項目 */
  public getAgentTodos(): { id: number; text: string; done: boolean }[] {
    return this._vscodeProvider.getTodos();
  }

  public getAuditLog(): AuditEntry[] {
    return this._audit.getAll();
  }

  public recordAuditEntry(tool: string, args: Record<string, unknown>, error: boolean): void {
    this._audit.push({
      ts: Date.now(),
      session: this._callbacks.getActiveSessionId(),
      tool,
      argsSnippet: summarizeToolArgsForAudit(args),
      error,
    });
  }

  // ── organize_photos：照片整理（Ollama 視覺辨識）helpers ─────────────────────

  /** 讀取設定的 Ollama 伺服器 URL 清單（amiAiClaw.urls），去除重複（停用）項。 */
  private static getOrganizeOllamaUrls(): string[] {
    const cfg = vscode.workspace.getConfiguration('amiAiClaw');
    const arr = (cfg.get<string[]>('urls') ?? []).filter((u) => u.trim());
    if (arr.length > 0) {
      const count = new Map<string, number>();
      for (const u of arr) { count.set(u, (count.get(u) ?? 0) + 1); }
      const enabled = arr.filter((u) => count.get(u) === 1);
      if (enabled.length > 0) { return enabled; }
    }
    return [cfg.get<string>('url') ?? 'http://localhost:11434'];
  }

  /** 遞迴收集目錄下的影像檔（jpg/jpeg/png/webp/bmp/gif），回傳絕對路徑陣列（達 limit 即停止）。 */
  private static collectImageFiles(rootDir: string, limit: number): string[] {
    const exts = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif']);
    const out: string[] = [];
    const walk = (dir: string) => {
      if (out.length >= limit) { return; }
      let entries: import('fs').Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (out.length >= limit) { return; }
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name.startsWith('.') || e.name === 'node_modules') { continue; }
          walk(full);
        } else if (exts.has(path.extname(e.name).toLowerCase())) {
          out.push(full);
        }
      }
    };
    walk(rootDir);
    return out;
  }

  /** 清理檔名/資料夾名中的非法字元，空字串時回傳 fallback。 */
  private static sanitizePathSegment(name: string, fallback: string): string {
    const cleaned = (name || '')
      .replace(/[\\/:*?"<>|\r\n\t]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 40);
    return cleaned || fallback;
  }

  /** 呼叫 Ollama 視覺模型 /api/chat（非串流），傳入多張 base64 影像，回傳 message.content 文字。 */
  private static ollamaVisionChat(
    baseUrl: string, model: string, prompt: string, imagesB64: string[], timeoutMs: number,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      let url: URL;
      try { url = new URL('/api/chat', baseUrl); } catch { reject(new Error(`Ollama URL 無效: ${baseUrl}`)); return; }
      const protocol = url.protocol === 'https:' ? https : http;
      const buf = Buffer.from(JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt, images: imagesB64 }],
        stream: false,
        options: { temperature: 0 },
      }), 'utf8');
      const options: http.RequestOptions = {
        hostname: url.hostname,
        port: url.port ? parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 11434),
        path: url.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': buf.length },
      };
      const req = protocol.request(options, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (d: string) => { data += d; });
        res.on('end', () => {
          try {
            const j = JSON.parse(data) as { message?: { content?: string }; error?: string };
            if (j.error) { reject(new Error(j.error)); return; }
            resolve((j.message?.content ?? '').trim());
          } catch { reject(new Error(`回應解析失敗: ${data.slice(0, 200)}`)); }
        });
      });
      req.on('error', (e: Error) => reject(e));
      req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error(`Ollama 視覺推論逾時 (${timeoutMs}ms)`)); });
      req.write(buf);
      req.end();
    });
  }

  /** 從模型回應中擷取第一個 JSON 物件並解析（容忍 markdown code fence 與前後雜訊）。 */
  private static extractFirstJson(text: string): Record<string, unknown> | null {
    if (!text) { return null; }
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1] : text;
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start < 0 || end <= start) { return null; }
    try { return JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>; } catch { return null; }
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
  /** 常見替代工具名稱 → 正式工具名稱映射表（供各家 LLM 使用不同名稱時自動對齊） */
  private static readonly TOOL_ALIASES: Record<string, string> = {
    // shell / 終端
    'run_shell_command':  'run_command',
    'shell':              'run_command',
    'execute_command':    'run_command',
    'bash':               'run_command',
    'terminal':           'run_terminal',
    'run_bash':           'run_command',
    'exec':               'run_command',
    // Python
    'python_interpreter': 'run_python',
    'python':             'run_python',
    'execute_python':     'run_python',
    'run_code':           'run_python',
    // 瀏覽器
    'browser':            'browser_navigate',
    'navigate':           'browser_navigate',
    'open_url':           'open_browser',
    'visit_url':          'browser_navigate',
    'web_browse':         'browser_navigate',
    // 檔案讀取
    'read_file_content':  'read_file',
    'get_file':           'read_file',
    'file_read':          'read_file',
    // 網路請求
    'http_get':           'http_request',
    'http_post':          'http_request',
    'request':            'http_request',
    'curl':               'fetch_url',
    'wget':               'fetch_url',
    // 搜尋
    'search':             'search_workspace',
    'grep':               'search_regex',
    'find':               'search_workspace',
    // meta 派發器別名
    'agent:run_tool':     'agent_run_tool',
    'run_tool':           'agent_run_tool',   // LLM 常誤用 run_tool 作為 meta-dispatcher
    'tool_call':          'agent_run_tool',
    'call_tool':          'agent_run_tool',
    'invoke_tool':        'agent_run_tool',
    // 檔案讀取備用名
    'view_file':          'read_file',
    'cat':                'read_file',
    'open_file':          'read_file',
    'show_file':          'read_file',
    // 分區讀取別名
    'grep_file':          'grep_file',   // 直接指向新工具
    'grep_log':           'grep_file',
    'read_log':           'grep_file',
    'tail_file':          'read_file_smart',
    'head_file':          'read_file_smart',
    'search_file':        'read_file_smart',
    'filter_file':        'read_file_smart',
  };

  public async executeTool(name: string, args: Record<string, unknown>): Promise<string> {
    // 工具名稱正規化：將常見替代名稱映射至正式名稱
    const resolved = ToolExecutor.TOOL_ALIASES[name] ?? name;
    if (resolved !== name) {
      this._callbacks.log(`executeTool: alias "${name}" → "${resolved}"`);
      return this.executeTool(resolved, args);
    }
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

    /**
     * 三層優先順序路徑解析：
     *  1. 絕對路徑 / 相對路徑（存在於磁碟）→ 直接使用
     *  2. 找不到 → 查 VS Code 已開啟的 openTextDocuments（basename 或 相對路徑 suffix 比對）
     *  3. 還找不到 → workspace.findFiles 在整個工作區搜尋
     */
    const resolvePathWithPriority = async (raw: string): Promise<string> => {
      if (!raw) { return wsRoot; }
      // ① 絕對路徑直接用
      if (path.isAbsolute(raw)) {
        try { require('fs').accessSync(raw); return raw; } catch { /* fall through */ }
      }
      // ① 相對路徑：先嘗試 workspace folder 解析
      const candidate = resolvePath(raw);
      try { require('fs').accessSync(candidate); return candidate; } catch { /* not on disk */ }

      // ② 已開啟的 editor documents（不須在磁碟，可能是 untitled 或虛擬 FS）
      const rawBase = path.basename(raw).toLowerCase();
      const rawNorm = raw.replace(/\\/g, '/').toLowerCase();
      for (const doc of vscode.workspace.textDocuments) {
        const docPath = doc.uri.fsPath;
        const docNorm = docPath.replace(/\\/g, '/').toLowerCase();
        if (docNorm.endsWith(rawNorm) || path.basename(docPath).toLowerCase() === rawBase) {
          return docPath;
        }
      }

      // ③ workspace.findFiles 搜全工作區
      try {
        // 先嘗試精確 glob（保留原始路徑結構）
        const exactGlob = `**/${raw.replace(/\\/g, '/')}`;
        const found = await vscode.workspace.findFiles(exactGlob, '**/node_modules/**', 5);
        if (found.length > 0) {
          // 若多個結果，優先選最短路徑（最靠近根目錄）
          found.sort((a, b) => a.fsPath.length - b.fsPath.length);
          return found[0].fsPath;
        }
        // basename glob fallback
        const baseGlob = `**/${rawBase}`;
        const found2 = await vscode.workspace.findFiles(baseGlob, '**/node_modules/**', 5);
        if (found2.length > 0) {
          found2.sort((a, b) => a.fsPath.length - b.fsPath.length);
          return found2[0].fsPath;
        }
      } catch { /* ignore findFiles error */ }

      // fallback：回傳原始 resolvePath 結果（讓呼叫端的 stat 報「找不到」）
      return candidate;
    };

    // Provider dispatch：已遷移的工具走 provider 路徑，其餘繼續走原始 switch
    const _provider = this._providerMap.get(name);
    if (_provider) {
      const _ctx: ToolExecutionContext = {
        callbacks: this._callbacks,
        cache: this._cache,
        audit: this._audit,
        wsRoot,
        folders,
        requestPermission: (cat, desc, tool, diff) => this.requestPermission(cat, desc, tool ?? '', diff),
        resolvePath,
        resolvePathSmart: resolvePathWithPriority,
        executeTool: (n, a) => this.executeTool(n, a),
        handleWhatsApp: (n, a) => this._callbacks.handleWhatsAppTool(n, a),
      };
      return _provider.execute(name, args, _ctx);
    }

    switch (name) {
      case 'get_active_file': {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { return '沒有開啟的檔案'; }
        return `檔案: ${editor.document.uri.fsPath}\n\n${editor.document.getText()}`;
      }
      case 'read_file': {
        const fpath = await resolvePathWithPriority(args.path as string);
        const rfKey = `rf:${fpath}`;
        const rfCached = this._cache.get(rfKey);
        if (rfCached !== undefined) { return rfCached; }
        // 先檢查檔案大小，避免大型二進位/文字檔案讓 webview 凍結
        let fileStat: vscode.FileStat;
        try { fileStat = await vscode.workspace.fs.stat(vscode.Uri.file(fpath)); }
        catch { return `錯誤：找不到檔案 ${fpath}`; }
        const MAX_BYTES = 5 * 1024 * 1024; // 5 MB
        const LOG_SMART_THRESHOLD = 64 * 1024; // 64 KB：超過此大小的 log 改走 error-first 策略
        const ext = fpath.split('.').pop()?.toLowerCase() ?? '';
        const isLog = ['log', 'txt', 'out', 'err', 'bld', 'build', 'trace'].includes(ext);
        // 各式錯誤/警告關鍵字 pattern（涵蓋 EDKII build、GCC、Python、Node.js、一般系統 log）
        const LOG_ERROR_PATTERN =
          'error:|Error:|ERROR|warning:|Warning:|WARNING|fatal:|Fatal:|FATAL|' +
          'fail:|FAIL|FAILED|BUILD FAILURE|BUILD ERROR|' +
          'assert|Assert|ASSERT|exception|Exception|EXCEPTION|' +
          'undefined reference|cannot find|unresolved|Unresolved|' +
          'ld returned|undefined symbol|' +
          'Traceback|SyntaxError|TypeError|ReferenceError|ImportError|ModuleNotFoundError|' +
          'abort|Abort|ABORT|crash|Crash|panic|Panic|PANIC|' +
          'segfault|Segmentation fault|signal [0-9]|' +
          'No such file|Permission denied|Access denied|not found';

        if (fileStat.size > MAX_BYTES) {
          // 超大檔（> 5 MB）：直接用 read_file_smart 分兩段回傳
          const sizeMb = (fileStat.size / 1024 / 1024).toFixed(1);
          if (isLog) {
            const tailResult  = await this.executeTool('read_file_smart', { path: args.path, tail: 300, max_kb: 96 });
            const errorResult = await this.executeTool('read_file_smart', {
              path: args.path,
              pattern: LOG_ERROR_PATTERN,
              context_lines: 5,
              max_kb: 128,
            });
            return `⚠️ 檔案過大（${sizeMb} MB），自動分兩段回傳——\n\n` +
              `【全檔錯誤/警告點（含前後 5 行 context）】\n${errorResult}\n\n` +
              `【尾端 300 行（最終執行結果）】\n${tailResult}`;
          } else {
            const headResult = await this.executeTool('read_file_smart', { path: args.path, head: 300, max_kb: 64 });
            return `⚠️ 檔案過大（${sizeMb} MB），自動回傳前 300 行：\n${headResult}`;
          }
        }

        // 中型 log（64 KB ~ 5 MB）：先掃描錯誤點再補尾端，避免截斷遺漏關鍵訊息
        if (isLog && fileStat.size > LOG_SMART_THRESHOLD) {
          const sizeKb = (fileStat.size / 1024).toFixed(0);
          const errorResult = await this.executeTool('read_file_smart', {
            path: args.path,
            pattern: LOG_ERROR_PATTERN,
            context_lines: 5,
            max_kb: 128,
          });
          const tailResult = await this.executeTool('read_file_smart', { path: args.path, tail: 100, max_kb: 64 });
          return `📋 Log 分析模式（${sizeKb} KB）——先掃描各式錯誤點，再補尾端執行結果\n\n` +
            `【錯誤 / 警告點（含前後 5 行 context）】\n${errorResult}\n\n` +
            `【尾端 100 行（執行結果）】\n${tailResult}`;
        }

        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(fpath));
        const text = Buffer.from(bytes).toString('utf8');
        const rfResult = text.length > 50000 ? text.slice(0, 50000) + '\n…（已截斷至 50KB）' : text;
        if (text.length <= 10000) { this._cache.set(rfKey, rfResult); }
        return rfResult;
      }
      case 'read_file_smart': {
        // 分區讀取大型檔案：支援行範圍、grep 過濾、head/tail，不會把整個檔案載入記憶體
        const rfsFpath = await resolvePathWithPriority(args.path as string);
        const rfsPattern   = args.pattern   ? String(args.pattern)          : null;
        const rfsStartLine = args.start_line ? Math.max(1, Number(args.start_line)) : null;
        const rfsEndLine   = args.end_line   ? Math.max(1, Number(args.end_line))   : null;
        const rfsHead      = args.head       ? Math.max(1, Number(args.head))       : null;
        const rfsTail      = args.tail       ? Math.max(1, Number(args.tail))       : null;
        const rfsCtx       = args.context_lines ? Math.max(0, Number(args.context_lines)) : 0;
        const rfsMaxKb     = args.max_kb     ? Math.max(1, Math.min(512, Number(args.max_kb))) : 128;

        try {
          const nodefs    = require('fs') as typeof import('fs');
          const readline  = require('readline') as typeof import('readline');

          // 取得檔案資訊
          let stat: import('fs').Stats;
          try { stat = nodefs.statSync(rfsFpath); }
          catch { return `錯誤：找不到檔案 ${rfsFpath}`; }
          const fileSizeMb = (stat.size / 1024 / 1024).toFixed(1);

          const rfsRegex = rfsPattern ? new RegExp(rfsPattern, 'i') : null;
          const maxOutputBytes = rfsMaxKb * 1024;

          // 收集匹配行（含 context 支援）
          const matchedLines: Array<{ lineNo: number; text: string; isContext?: boolean }> = [];
          const ringBuffer: string[] = [];                // 用於 context_lines 的前置緩衝
          const pendingCtxLineNos = new Set<number>();    // 標記需要輸出的後置 context 行號
          let totalFileLines = 0;                         // 全檔案行數（用於計算百分比）

          await new Promise<void>((resolve, reject) => {
            const rl = readline.createInterface({
              input: nodefs.createReadStream(rfsFpath, { encoding: 'utf8' }),
              crlfDelay: Infinity,
            });
            let lineNo = 0;
            let outputBytes = 0;
            let collecting = true;    // 停止收集但繼續計行以取得全檔行數
            let tailLines: string[] = rfsTail ? [] : [];

            rl.on('line', (line: string) => {
              lineNo++;

              if (!collecting) { return; } // 繼續計行但不收集

              // tail 模式：保留最後 N 行
              if (rfsTail) {
                tailLines.push(line);
                if (tailLines.length > rfsTail) tailLines.shift();
                return;
              }

              // head 模式
              if (rfsHead && lineNo > rfsHead) { collecting = false; return; }

              // 行範圍過濾
              if (rfsStartLine && lineNo < rfsStartLine) {
                if (rfsCtx > 0) { ringBuffer.push(line); if (ringBuffer.length > rfsCtx) ringBuffer.shift(); }
                return;
              }
              if (rfsEndLine && lineNo > rfsEndLine) { collecting = false; return; }

              const isMatch = rfsRegex ? rfsRegex.test(line) : true;

              if (isMatch) {
                // 先補前置 context
                if (rfsCtx > 0 && rfsRegex) {
                  for (let i = 0; i < ringBuffer.length; i++) {
                    const ctxNo = lineNo - ringBuffer.length + i;
                    if (!matchedLines.find(m => m.lineNo === ctxNo)) {
                      matchedLines.push({ lineNo: ctxNo, text: ringBuffer[i], isContext: true });
                    }
                  }
                  ringBuffer.length = 0;
                  // 標記後置 context
                  for (let j = 1; j <= rfsCtx; j++) pendingCtxLineNos.add(lineNo + j);
                }
                matchedLines.push({ lineNo, text: line });
                outputBytes += line.length + 1;
                if (outputBytes > maxOutputBytes) { collecting = false; return; }
              } else {
                // 後置 context
                if (pendingCtxLineNos.has(lineNo)) {
                  pendingCtxLineNos.delete(lineNo);
                  matchedLines.push({ lineNo, text: line, isContext: true });
                  outputBytes += line.length + 1;
                }
                if (rfsCtx > 0 && rfsRegex) {
                  ringBuffer.push(line);
                  if (ringBuffer.length > rfsCtx) ringBuffer.shift();
                }
              }
            });
            rl.on('close', () => {
              totalFileLines = lineNo;
              // 處理 tail 模式結果
              if (rfsTail && tailLines.length > 0) {
                const tailStart = lineNo - tailLines.length + 1;
                tailLines.forEach((tl, i) => {
                  matchedLines.push({ lineNo: tailStart + i, text: tl });
                });
              }
              resolve();
            });
            rl.on('error', reject);
          });

          const header = `📄 ${rfsFpath}  (${fileSizeMb} MB, ${totalFileLines.toLocaleString()} 行)` +
            (rfsPattern  ? `  pattern="${rfsPattern}"` : '') +
            (rfsStartLine ? `  lines=${rfsStartLine}-${rfsEndLine ?? '∞'}` : '') +
            (rfsHead     ? `  head=${rfsHead}` : '') +
            (rfsTail     ? `  tail=${rfsTail}` : '') +
            `  matched=${matchedLines.length} 行\n`;

          if (matchedLines.length === 0) {
            return header + '（無匹配行）';
          }

          let totalOut = 0;
          const lines = matchedLines.map(m => {
            totalOut += m.text.length + 1;
            const pct = totalFileLines > 0 ? ` (${(m.lineNo * 100 / totalFileLines).toFixed(1)}%)` : '';
            return `${m.isContext ? '  ' : ''}${String(m.lineNo).padStart(6)}${pct}: ${m.text}`;
          });

          const truncated = totalOut > maxOutputBytes;
          const body = lines.join('\n') + (truncated ? `\n…（已達 ${rfsMaxKb}KB 輸出上限，請縮小範圍或增大 max_kb）` : '');
          return header + body;
        } catch (e) {
          return `read_file_smart 錯誤：${e instanceof Error ? e.message : String(e)}`;
        }
      }
      case 'grep_file': {
        // 多關鍵字搜尋超大型檔案，逐行 streaming，不把整個檔案載入 buffer。
        // 每個 keyword 獨立分組回傳，重疊 context 自動合併去重，達上限截斷各組。
        const gfPath    = await resolvePathWithPriority(args.path as string);
        const gfKws     = Array.isArray(args.keywords)
          ? (args.keywords as unknown[]).map(String).filter(Boolean)
          : [];
        if (gfKws.length === 0) { return '錯誤：keywords 為空'; }
        const gfCtx     = args.context_lines     ? Math.max(0, Number(args.context_lines))     : 3;
        const gfMaxPerKw= args.max_matches_per_kw ? Math.max(1, Number(args.max_matches_per_kw)) : 30;
        const gfMaxKb   = args.max_kb            ? Math.max(1, Math.min(512, Number(args.max_kb))) : 128;
        const gfCaseSens= args.case_sensitive === true;
        const gfMaxBytes= gfMaxKb * 1024;

        try {
          const nodefs   = require('fs') as typeof import('fs');
          const readline = require('readline') as typeof import('readline');

          let stat: import('fs').Stats;
          try { stat = nodefs.statSync(gfPath); }
          catch { return `錯誤：找不到檔案 ${gfPath}`; }
          const fileSizeMb = (stat.size / 1024 / 1024).toFixed(1);

          // 每個關鍵字建立獨立 regex 與匹配記錄
          const gfFlag = gfCaseSens ? '' : 'i';
          type KwGroup = {
            kw: string;
            re: RegExp;
            matches: Array<{ lineNo: number; text: string; isCtx?: boolean }>;
            totalHits: number;
            capped: boolean;
          };
          const groups: KwGroup[] = gfKws.map(kw => ({
            kw,
            re: new RegExp(kw, gfFlag),
            matches: [],
            totalHits: 0,
            capped: false,
          }));

          // ring buffer（前置 context）與後置 context 追蹤
          const ring: string[] = [];
          // pendingCtx[kwIdx] = Set of future line numbers to capture as context
          const pendingCtx: Set<number>[] = groups.map(() => new Set<number>());
          let totalFileLines = 0;

          await new Promise<void>((resolve, reject) => {
            const rl = readline.createInterface({
              input: nodefs.createReadStream(gfPath, { encoding: 'utf8' }),
              crlfDelay: Infinity,
            });
            let lineNo = 0;

            rl.on('line', (line: string) => {
              lineNo++;

              for (let gi = 0; gi < groups.length; gi++) {
                const g = groups[gi];

                // 後置 context
                if (pendingCtx[gi].has(lineNo)) {
                  pendingCtx[gi].delete(lineNo);
                  // 若此行也是 match，不重複加；等下面 match 邏輯加
                  if (!g.re.test(line)) {
                    if (!g.matches.find(m => m.lineNo === lineNo)) {
                      g.matches.push({ lineNo, text: line, isCtx: true });
                    }
                  }
                }

                // 命中檢查
                if (g.re.test(line)) {
                  g.totalHits++;
                  if (!g.capped) {
                    if (g.totalHits <= gfMaxPerKw) {
                      // 前置 context：從 ring buffer 補
                      if (gfCtx > 0) {
                        const ringStart = Math.max(0, ring.length - gfCtx);
                        for (let ri = ringStart; ri < ring.length; ri++) {
                          const ctxNo = lineNo - (ring.length - ri);
                          if (ctxNo >= 1 && !g.matches.find(m => m.lineNo === ctxNo)) {
                            g.matches.push({ lineNo: ctxNo, text: ring[ri], isCtx: true });
                          }
                        }
                      }
                      // 本行 match（先移除若已由後置 context 加過）
                      const existing = g.matches.findIndex(m => m.lineNo === lineNo);
                      if (existing !== -1) { g.matches.splice(existing, 1); }
                      g.matches.push({ lineNo, text: line, isCtx: false });
                      // 後置 context
                      for (let j = 1; j <= gfCtx; j++) pendingCtx[gi].add(lineNo + j);
                    } else {
                      g.capped = true;
                    }
                  }
                }
              }

              // 維護 ring buffer
              ring.push(line);
              if (ring.length > gfCtx + 1) ring.shift();
            });

            rl.on('close', () => { totalFileLines = lineNo; resolve(); });
            rl.on('error', reject);
          });

          // 組裝輸出
          const allHits = groups.reduce((s, g) => s + g.totalHits, 0);
          const hdr = `📄 ${gfPath}  (${fileSizeMb} MB, ${totalFileLines.toLocaleString()} 行)\n` +
            `🔍 Keywords: ${gfKws.map(k => `"${k}"`).join(', ')}  |  context=${gfCtx}  |  total hits: ${allHits}\n`;

          const sections: string[] = [];
          let outputBytes = hdr.length;

          for (const g of groups) {
            if (outputBytes >= gfMaxBytes) { sections.push(`…（已達 ${gfMaxKb}KB 上限）`); break; }

            // 排序並去重（多個 keywords 可能標記同一行為 context）
            const sorted = g.matches.sort((a, b) => a.lineNo - b.lineNo);
            const deduped: typeof sorted = [];
            for (const m of sorted) {
              if (!deduped.length || deduped[deduped.length - 1].lineNo !== m.lineNo) {
                deduped.push(m);
              } else if (!m.isCtx) {
                // 若已有同行 context，升格為 match
                deduped[deduped.length - 1].isCtx = false;
              }
            }

            const capNote = g.capped ? ` (顯示前 ${gfMaxPerKw}，共 ${g.totalHits} 處)` : ` (${g.totalHits} 處)`;
            let section = `\n━━━ "${g.kw}" ${g.totalHits === 0 ? '— 無匹配' : capNote} ━━━\n`;

            if (deduped.length === 0) {
              section += '（無匹配行）\n';
            } else {
              // 分布摘要：列出 match 的 % 位置
              const matchNos = deduped.filter(m => !m.isCtx).map(m => m.lineNo);
              const distrib = matchNos.map(n => `${(n * 100 / totalFileLines).toFixed(1)}%`).join(', ');
              if (matchNos.length > 0) { section += `   📍 分布位置：${distrib}\n`; }

              let prevLineNo = -999;
              for (const m of deduped) {
                if (m.lineNo > prevLineNo + 1 && prevLineNo !== -999) {
                  section += '   ——\n';
                }
                const pct = totalFileLines > 0 ? ` (${(m.lineNo * 100 / totalFileLines).toFixed(1)}%)` : '';
                section += `${m.isCtx ? '  ' : '▶ '}${String(m.lineNo).padStart(6)}${pct}: ${m.text}\n`;
                prevLineNo = m.lineNo;
              }
            }

            if (outputBytes + section.length > gfMaxBytes) {
              section = section.slice(0, gfMaxBytes - outputBytes) + '\n…（截斷）\n';
            }
            sections.push(section);
            outputBytes += section.length;
          }

          return hdr + sections.join('');
        } catch (e) {
          return `grep_file 錯誤：${e instanceof Error ? e.message : String(e)}`;
        }
      }
      case 'read_files': {
        const rawPaths = Array.isArray(args.paths) ? (args.paths as unknown[]).map(String).filter(Boolean) : [];
        if (rawPaths.length === 0) { return '錯誤：paths 為空陣列'; }
        const MAX_FILES = 30;
        const truncatedPaths = rawPaths.slice(0, MAX_FILES);
        const overflowFiles = rawPaths.length > MAX_FILES ? rawPaths.length - MAX_FILES : 0;
        const maxPerFileKb = Math.max(1, Math.min(512, Number(args.max_per_file_kb) || 64));
        const maxTotalKb = Math.max(maxPerFileKb, Math.min(2048, Number(args.max_total_kb) || 256));
        const maxPerBytes = maxPerFileKb * 1024;
        const maxTotalBytes = maxTotalKb * 1024;
        const FILE_HARD_MAX = 5 * 1024 * 1024;
        const parts: string[] = [];
        let totalBytes = 0;
        let stoppedAt = -1;
        for (let i = 0; i < truncatedPaths.length; i++) {
          if (totalBytes >= maxTotalBytes) { stoppedAt = i; break; }
          const p = truncatedPaths[i];
          const fpath = resolvePath(p);
          let header = `=== ${p} ===\n`;
          let body = '';
          try {
            const stat = await vscode.workspace.fs.stat(vscode.Uri.file(fpath));
            if (stat.size > FILE_HARD_MAX) {
              body = `（檔案過大 ${(stat.size / 1024 / 1024).toFixed(1)} MB > 5 MB，跳過）\n`;
            } else {
              const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(fpath));
              let text = Buffer.from(bytes).toString('utf8');
              if (text.length > maxPerBytes) {
                text = text.slice(0, maxPerBytes) + `\n…（已截斷至 ${maxPerFileKb}KB，原始 ${Math.round(text.length / 1024)}KB）\n`;
              }
              const remaining = maxTotalBytes - totalBytes - header.length;
              if (text.length > remaining) {
                text = text.slice(0, Math.max(0, remaining)) + `\n…（達總量上限 ${maxTotalKb}KB，本檔截斷）\n`;
              }
              body = text + (text.endsWith('\n') ? '' : '\n');
            }
          } catch {
            body = `（找不到檔案：${fpath}）\n`;
          }
          parts.push(header + body);
          totalBytes += header.length + body.length;
        }
        const summary: string[] = [];
        const readCount = stoppedAt === -1 ? truncatedPaths.length : stoppedAt;
        summary.push(`📚 read_files: 已讀取 ${readCount}/${rawPaths.length} 個檔案，總 ${(totalBytes / 1024).toFixed(1)}KB`);
        if (stoppedAt !== -1) {
          const skipped = truncatedPaths.slice(stoppedAt).concat(rawPaths.slice(MAX_FILES));
          summary.push(`⚠️ 達總量上限（${maxTotalKb}KB），未讀取：${skipped.slice(0, 10).join(', ')}${skipped.length > 10 ? ` …(+${skipped.length - 10})` : ''}`);
          summary.push(`💡 請對剩餘檔案再次呼叫 read_files 並調整 max_total_kb，或改用 search_regex 縮小範圍。`);
        } else if (overflowFiles > 0) {
          summary.push(`⚠️ paths 數量超過上限 ${MAX_FILES}，未處理 ${overflowFiles} 個檔案。`);
        }
        return summary.join('\n') + '\n\n' + parts.join('\n');
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
        this._cache.delete(`rf:${fpath}`);
        this._callbacks.postToWebview({ type: 'fileModified', filePath: fpath, op: 'write', ts: Date.now() });
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
        this._cache.delete(`rf:${fpath}`);
        this._callbacks.postToWebview({ type: 'fileModified', filePath: fpath, op: 'replace', ts: Date.now() });
        return `已更新 ${fpath}`;
      }
      case 'insert_in_file': {
        // 在指定行號後插入內容（1-based；line=0 表示在最前面插入）
        const fpath = resolvePath(args.path as string);
        const lineNum = Math.max(0, Number(args.line) || 0);
        const insertContent = (args.content as string) ?? '';
        let original: string;
        try {
          const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(fpath));
          original = Buffer.from(bytes).toString('utf8');
        } catch {
          return `錯誤：找不到檔案 ${fpath}`;
        }
        // 保留原始行尾（CRLF 或 LF）
        const hasCrlf = original.includes('\r\n');
        const lineEnding = hasCrlf ? '\r\n' : '\n';
        const lines = original.split(/\r?\n/);
        if (lineNum > lines.length) {
          return `錯誤：行號 ${lineNum} 超過檔案總行數 ${lines.length}`;
        }
        const insertLines = insertContent.split(/\r?\n/);
        lines.splice(lineNum, 0, ...insertLines);
        const newContent = lines.join(lineEnding);
        const ifDiff: ToolPermissionDiff = { filePath: fpath, before: original, after: newContent, mode: 'replace', oldStr: '', newStr: insertContent };
        const ifAllowed = await this.requestPermission('write', `插入檔案: ${path.basename(fpath)} 第 ${lineNum} 行後（${insertLines.length} 行）`, 'insert_in_file', ifDiff);
        if (!ifAllowed) { return '使用者已拒絕插入操作'; }
        await vscode.workspace.fs.writeFile(vscode.Uri.file(fpath), Buffer.from(newContent, 'utf8'));
        this._cache.delete(`rf:${fpath}`);
        this._callbacks.postToWebview({ type: 'fileModified', filePath: fpath, op: 'insert', ts: Date.now() });
        return `已在 ${fpath} 第 ${lineNum} 行後插入 ${insertLines.length} 行`;
      }
      case 'glob': {
        // 列出符合 glob 樣式的檔案（類似 OpenHarness GlobTool）
        const globPattern = (args.pattern as string) || '**/*';
        const globRoot = (args.root as string) ? resolvePath(args.root as string) : wsRoot;
        const globLimit = Math.min(Math.max(Number(args.limit) || 200, 1), 5000);
        const globExclude = '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**,**/build/**,**/__pycache__/**}';
        try {
          // 若 pattern 含絕對路徑，只取樣式部分
          const relPattern = path.isAbsolute(globPattern) ? path.relative(globRoot, globPattern) : globPattern;
          const globUris = await vscode.workspace.findFiles(
            new vscode.RelativePattern(globRoot, relPattern),
            globExclude, globLimit
          );
          if (globUris.length === 0) { return '(no matches)'; }
          const sorted = globUris
            .map(u => path.relative(globRoot, u.fsPath).replace(/\\/g, '/'))
            .sort();
          return sorted.join('\n') + `\n\n共 ${sorted.length} 個檔案`;
        } catch (e) { return `glob 錯誤: ${e}`; }
      }
      case 'outline_file': {
        // 快速抽取函式/類別/typedef/protocol 宣告（不讀完整檔案內容）
        const ofPath = resolvePath(args.path as string);
        let ofBytes: Uint8Array;
        try { ofBytes = await vscode.workspace.fs.readFile(vscode.Uri.file(ofPath)); }
        catch { return `錯誤：找不到檔案 ${ofPath}`; }
        const ofText = Buffer.from(ofBytes).toString('utf8').slice(0, 200_000);
        const ofLines = ofText.split('\n');
        const ofExt = path.extname(ofPath).toLowerCase();
        // 宣告正規式：根據副檔名選擇策略
        const isCLike = ['.c','.h','.cpp','.cc','.cxx'].includes(ofExt);
        const isUefi  = ['.inf','.dec','.dsc','.fdf'].includes(ofExt);
        const ofResults: string[] = [];
        if (isUefi) {
          // INF/DEC/DSC: 擷取 [Section] 標題
          for (let i = 0; i < ofLines.length; i++) {
            const m = /^\[([A-Za-z][\w.]+)\]/.exec(ofLines[i]);
            if (m) ofResults.push(`L${i+1}  [${m[1]}]`);
          }
        } else if (isCLike) {
          // C/C++：函式定義（回傳型別 + EFIAPI/OPTIONAL + 函式名稱(）、typedef、struct、enum
          const cDeclRe = /^(?:[A-Z_a-z][\w*]+\s+)+(?:EFIAPI\s+)?(\w+)\s*\(|^typedef\s+.*?(\w+)\s*;|^(?:typedef\s+)?(?:struct|union|enum)\s+(\w+)|^#define\s+(\w+)/;
          for (let i = 0; i < ofLines.length; i++) {
            const m = cDeclRe.exec(ofLines[i]);
            if (m) {
              const name = m[1] || m[2] || m[3] || m[4];
              if (name) ofResults.push(`L${i+1}  ${ofLines[i].trim().slice(0, 80)}`);
            }
          }
        } else {
          // 通用：TS/JS/Python
          const genRe = /^\s*(?:export\s+)?(?:(?:async\s+)?function\*?\s+([\w$]+)|class\s+([\w$]+)|interface\s+([\w$]+)|type\s+([\w$]+)\s*(?:<[^>]*>)?\s*=|(?:const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>|def\s+([\w_]+)|func\s+([\w_]+)\s*\(|public\s+(?:static\s+)?\S+\s+([\w_]+)\s*\()/;
          for (let i = 0; i < ofLines.length; i++) {
            const m = genRe.exec(ofLines[i]);
            if (m) { const name = m.slice(1).find(Boolean); if (name) ofResults.push(`L${i+1}  ${name}`); }
          }
        }
        if (ofResults.length === 0) { return `${ofPath}\n(未偵測到宣告)`; }
        return `=== ${path.basename(ofPath)} 宣告摘要 (${ofResults.length} 項) ===\n${ofResults.join('\n')}`;
      }
      case 'todo_write': {
        // 新增或更新 TODO.md 中的項目（inspired by OpenHarness TodoWriteTool）
        const twItem = (args.item as string || '').trim();
        if (!twItem) { return '請提供 item 參數'; }
        const twChecked = !!(args.checked as boolean);
        const twRelPath = (args.path as string) || 'TODO.md';
        const twFpath = resolvePath(twRelPath);
        let twText = '';
        try { twText = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(twFpath))).toString('utf8'); }
        catch { twText = '# TODO\n'; }
        const unchecked = `- [ ] ${twItem}`;
        const checked   = `- [x] ${twItem}`;
        const target    = twChecked ? checked : unchecked;
        let updated = twText;
        if (twText.includes(unchecked) && twChecked) {
          updated = twText.replace(unchecked, checked);
        } else if (!twText.includes(target)) {
          updated = twText.trimEnd() + `\n${target}\n`;
        } else {
          return `無需更改 ${twFpath}`;
        }
        await vscode.workspace.fs.writeFile(vscode.Uri.file(twFpath), Buffer.from(updated, 'utf8'));
        this._cache.delete(`rf:${twFpath}`);
        this._callbacks.postToWebview({ type: 'fileModified', filePath: twFpath, op: 'write', ts: Date.now() });
        return `已更新 ${twFpath}: ${target}`;
      }
      case 'memory_read': {
        // 讀取工作區 MEMORY.md（或指定路徑）
        const mrRelPath = (args.path as string) || 'MEMORY.md';
        const mrFpath = resolvePath(mrRelPath);
        try {
          const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(mrFpath));
          return Buffer.from(bytes).toString('utf8');
        } catch {
          return `(MEMORY.md 不存在於 ${mrFpath})`;
        }
      }
      case 'memory_write': {
        // 寫入或追加記憶條目到 MEMORY.md（inspired by OpenHarness MemoryManager）
        const mwTitle   = (args.title   as string || '').trim();
        const mwContent = (args.content as string || '').trim();
        const mwAction  = (args.action  as string || 'append'); // append | replace | delete
        const mwRelPath = (args.path    as string) || 'MEMORY.md';
        if (!mwTitle && mwAction !== 'replace') { return '請提供 title 參數'; }
        const mwFpath = resolvePath(mwRelPath);
        let mwText = '';
        try { mwText = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(mwFpath))).toString('utf8'); }
        catch { mwText = '# Memory\n'; }
        let mwUpdated = mwText;
        const ts = new Date().toISOString().slice(0, 10);
        if (mwAction === 'delete') {
          // 刪除含 title 的段落（## title 開始到下個 ## 之間）
          const delRe = new RegExp(`## ${mwTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?(?=\n## |$)`, 'g');
          mwUpdated = mwText.replace(delRe, '').replace(/\n{3,}/g, '\n\n');
        } else if (mwAction === 'replace') {
          mwUpdated = `# Memory\n${mwContent}\n`;
        } else {
          // append: 新增段落
          const entry = `\n## ${mwTitle}\n> ${ts}\n\n${mwContent}\n`;
          if (!mwText.includes(`## ${mwTitle}`)) {
            mwUpdated = mwText.trimEnd() + entry;
          } else {
            // 更新現有段落
            const updRe = new RegExp(`(## ${mwTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})[\\s\\S]*?(?=\n## |$)`);
            mwUpdated = mwText.replace(updRe, `$1\n> ${ts}\n\n${mwContent}\n`);
          }
        }
        await vscode.workspace.fs.writeFile(vscode.Uri.file(mwFpath), Buffer.from(mwUpdated, 'utf8'));
        this._cache.delete(`rf:${mwFpath}`);
        this._callbacks.postToWebview({ type: 'fileModified', filePath: mwFpath, op: 'write', ts: Date.now() });
        return `已更新記憶：${mwFpath}（${mwAction}）`;
      }
      case 'rename_file': {
        // 重新命名或移動檔案/目錄
        const rfSrc = resolvePath(args.src as string || args.path as string || '');
        const rfDst = resolvePath(args.dest as string || args.new_path as string || '');
        if (!rfSrc || !rfDst) { return '請提供 src 與 dest 參數'; }
        const allowed = await this.requestPermission('write', `重新命名: ${rfSrc} → ${rfDst}`, 'rename_file');
        if (!allowed) { return '使用者已拒絕操作'; }
        try {
          const overwrite = !!(args.overwrite as boolean);
          await vscode.workspace.fs.rename(vscode.Uri.file(rfSrc), vscode.Uri.file(rfDst), { overwrite });
          this._cache.delete(`rf:${rfSrc}`);
          this._cache.delete(`rf:${rfDst}`);
          this._callbacks.postToWebview({ type: 'fileModified', filePath: rfDst, op: 'rename', ts: Date.now() });
          return `已重新命名: ${rfSrc} → ${rfDst}`;
        } catch (e) { return `rename_file 錯誤: ${e}`; }
      }
      case 'copy_file': {
        // 複製檔案到新位置
        const cfSrc = resolvePath(args.src as string || args.path as string || '');
        const cfDst = resolvePath(args.dest as string || args.new_path as string || '');
        if (!cfSrc || !cfDst) { return '請提供 src 與 dest 參數'; }
        const cfAllowed = await this.requestPermission('write', `複製: ${cfSrc} → ${cfDst}`, 'copy_file');
        if (!cfAllowed) { return '使用者已拒絕操作'; }
        try {
          const overwrite = !!(args.overwrite as boolean);
          await vscode.workspace.fs.copy(vscode.Uri.file(cfSrc), vscode.Uri.file(cfDst), { overwrite });
          this._cache.delete(`rf:${cfDst}`);
          this._callbacks.postToWebview({ type: 'fileModified', filePath: cfDst, op: 'write', ts: Date.now() });
          return `已複製: ${cfSrc} → ${cfDst}`;
        } catch (e) { return `copy_file 錯誤: ${e}`; }
      }
      case 'diff_files': {
        // 比較兩個檔案，回傳 unified diff
        const dfA = resolvePath(args.a as string || args.path_a as string || '');
        const dfB = resolvePath(args.b as string || args.path_b as string || '');
        if (!dfA || !dfB) { return '請提供 a 與 b 參數'; }
        try {
          const [bytesA, bytesB] = await Promise.all([
            vscode.workspace.fs.readFile(vscode.Uri.file(dfA)),
            vscode.workspace.fs.readFile(vscode.Uri.file(dfB)),
          ]);
          const linesA = Buffer.from(bytesA).toString('utf8').split('\n');
          const linesB = Buffer.from(bytesB).toString('utf8').split('\n');
          // 簡易 unified diff (Myers LCS)
          const maxContext = Number(args.context) || 3;
          const diff = computeUnifiedDiff(linesA, linesB, path.relative(wsRoot, dfA), path.relative(wsRoot, dfB), maxContext);
          return diff || '（兩個檔案完全相同）';
        } catch (e) { return `diff_files 錯誤: ${e}`; }
      }
      case 'replace_all_in_file': {
        // 取代檔案中所有符合的字串（replace_in_file 只換第一個）
        const raPath = resolvePath(args.path as string || '');
        const raOld  = args.old_str as string;
        const raNew  = args.new_str as string;
        if (!raPath || raOld === undefined) { return '請提供 path、old_str、new_str 參數'; }
        const raAllowed = await this.requestPermission('write', `全部取代 in ${raPath}: "${raOld.slice(0, 40)}"`, 'replace_all_in_file');
        if (!raAllowed) { return '使用者已拒絕操作'; }
        try {
          const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(raPath));
          const original = Buffer.from(bytes).toString('utf8');
          if (!original.includes(raOld)) { return `找不到字串: "${raOld.slice(0, 60)}" 於 ${raPath}`; }
          const count = original.split(raOld).length - 1;
          const updated = original.split(raOld).join(raNew);
          await vscode.workspace.fs.writeFile(vscode.Uri.file(raPath), Buffer.from(updated, 'utf8'));
          this._cache.delete(`rf:${raPath}`);
          this._callbacks.postToWebview({ type: 'fileModified', filePath: raPath, op: 'replace', ts: Date.now() });
          return `已取代 ${count} 處於 ${raPath}`;
        } catch (e) { return `replace_all_in_file 錯誤: ${e}`; }
      }
      case 'batch_replace': {
        // 跨多個檔案批次搜尋取代（正規表達式，glob 篩選）
        const brPattern  = args.pattern as string;
        const brReplace  = args.replace as string;
        const brGlob     = (args.include as string) || '**/*';
        const brFlags    = ((args.flags as string) || 'g').includes('g') ? (args.flags as string || 'g') : (args.flags as string || 'g') + 'g';
        if (!brPattern || brReplace === undefined) { return '請提供 pattern 與 replace 參數'; }
        const brAllowed = await this.requestPermission('write', `批次取代: /${brPattern}/ → "${brReplace.slice(0, 40)}" (${brGlob})`, 'batch_replace');
        if (!brAllowed) { return '使用者已拒絕操作'; }
        let brRe: RegExp;
        try { brRe = new RegExp(brPattern, brFlags); } catch (e) { return `正規表達式錯誤: ${e}`; }
        const brUris = await vscode.workspace.findFiles(
          new vscode.RelativePattern(wsRoot, brGlob),
          '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**}', 2000
        );
        const brResults: string[] = [];
        let brTotalFiles = 0;
        for (const uri of brUris) {
          try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            const original = Buffer.from(bytes).toString('utf8');
            const updated = original.replace(brRe, brReplace);
            if (updated !== original) {
              await vscode.workspace.fs.writeFile(uri, Buffer.from(updated, 'utf8'));
              this._cache.delete(`rf:${uri.fsPath}`);
              this._callbacks.postToWebview({ type: 'fileModified', filePath: uri.fsPath, op: 'replace', ts: Date.now() });
              const count = (original.match(new RegExp(brPattern, brFlags)) || []).length;
              brResults.push(`  ${path.relative(wsRoot, uri.fsPath).replace(/\\/g,'/')}  (${count} 處)`);
              brTotalFiles++;
            }
          } catch { /* skip binary / unreadable */ }
        }
        if (brTotalFiles === 0) { return `找不到符合的內容 (/${brPattern}/ in ${brGlob})`; }
        return `批次取代完成，共修改 ${brTotalFiles} 個檔案:\n${brResults.join('\n')}`;
      }
      case 'file_info': {
        // 取得檔案資訊（大小、行數、BOM/編碼、最後修改時間）
        const fiPath = resolvePath(args.path as string || '');
        if (!fiPath) { return '請提供 path 參數'; }
        try {
          const [stat, bytes] = await Promise.all([
            vscode.workspace.fs.stat(vscode.Uri.file(fiPath)),
            vscode.workspace.fs.readFile(vscode.Uri.file(fiPath)),
          ]);
          const buf = Buffer.from(bytes);
          const sizeKb = (stat.size / 1024).toFixed(1);
          // 偵測 BOM
          let encoding = 'UTF-8';
          if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) { encoding = 'UTF-8 BOM'; }
          else if (buf[0] === 0xFF && buf[1] === 0xFE) { encoding = 'UTF-16 LE BOM'; }
          else if (buf[0] === 0xFE && buf[1] === 0xFF) { encoding = 'UTF-16 BE BOM'; }
          const text = buf.toString('utf8');
          const lineCount = text.split('\n').length;
          const crlf = (text.match(/\r\n/g) || []).length;
          const lf   = (text.match(/(?<!\r)\n/g) || []).length;
          const eol  = crlf > lf ? 'CRLF' : 'LF';
          const mtime = new Date(stat.mtime).toISOString().replace('T',' ').slice(0,19);
          const isDir = (stat.type & vscode.FileType.Directory) !== 0;
          return [
            `路徑: ${fiPath}`,
            `類型: ${isDir ? '目錄' : '檔案'}`,
            `大小: ${stat.size} bytes (${sizeKb} KB)`,
            `行數: ${lineCount}`,
            `行尾: ${eol} (CRLF:${crlf} / LF:${lf})`,
            `編碼: ${encoding}`,
            `修改時間: ${mtime} UTC`,
          ].join('\n');
        } catch (e) { return `file_info 錯誤: ${e}`; }
      }
      case 'list_dir': {
        const dirArg = (args.path as string) || '';
        const ldKey = `ld:${dirArg}`;
        const ldCached = this._cache.get(ldKey);
        if (ldCached !== undefined) { return ldCached; }
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
        this._cache.set(ldKey, ldResult);
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
        this._cache.delete(`rf:${fpath}`);
        this._cache.delete(`ld:${path.dirname(fpath)}`);
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
          // On Windows, auto-detect Unix-style commands and run under PowerShell
          const unixCmdPattern = /^(find|grep|ls|cat|wc|head|tail|awk|sed|chmod|which|touch|mkdir|rm|cp|mv|echo|sort|uniq|xargs|cut|tr|diff|tar|curl|wget)\s/;
          const shellOpt: string | boolean = (process.platform === 'win32' && unixCmdPattern.test(cmd.trim()))
            ? 'powershell.exe'
            : true;
          exec(cmd, { cwd, timeout: 30000, shell: shellOpt as unknown as string }, (_err, stdout, stderr) => {
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
          this._callbacks.postToWebview({ type: 'agentTodoUpdate', todos: [...this._agentTodos] });
          return `已新增 Todo #${this._agentTodos.length}: ${text}`;
        } else if (action === 'done') {
          const id = Number(args.id);
          const item = this._agentTodos.find(t => t.id === id);
          if (!item) { return `找不到 Todo #${id}`; }
          item.done = true;
          this._callbacks.postToWebview({ type: 'agentTodoUpdate', todos: [...this._agentTodos] });
          return `✅ Todo #${id} 已完成: ${item.text}`;
        } else if (action === 'clear') {
          this._agentTodos = [];
          this._callbacks.postToWebview({ type: 'agentTodoUpdate', todos: [] });
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
      case 'organize_photos': {
        const srcDirRaw = (args.source_dir as string || '').trim();
        if (!srcDirRaw) { return '請提供 source_dir（要掃描的照片目錄）'; }
        const srcDir = resolvePath(srcDirRaw);
        try {
          if (!fs.statSync(srcDir).isDirectory()) { return `錯誤：source_dir 不是目錄：${srcDir}`; }
        } catch { return `錯誤：找不到照片目錄 ${srcDir}`; }

        // 參考人臉（可選）：有提供 → 人物 + 行為兩層；未提供 → 只依行為分類
        const refRaw = (args.reference_image as string || '').trim();
        let refB64 = '';
        let personName = '';
        if (refRaw) {
          const refPath = await resolvePathWithPriority(refRaw);
          if (!fs.existsSync(refPath)) { return `錯誤：找不到參考照片 ${refPath}`; }
          try { refB64 = fs.readFileSync(refPath).toString('base64'); }
          catch (e) { return `錯誤：無法讀取參考照片：${e instanceof Error ? e.message : String(e)}`; }
          personName = ToolExecutor.sanitizePathSegment(
            (args.person_name as string) || path.basename(refPath, path.extname(refPath)), '指定人物');
        }

        // 視覺模型（args 優先，其次設定）
        const opCfg = vscode.workspace.getConfiguration('amiAiClaw');
        const visionModel = ((args.vision_model as string) || opCfg.get<string>('visionModel') || '').trim();
        if (!visionModel) {
          return '請提供 vision_model 參數，或在設定 amiAiClaw.visionModel 指定 Ollama 視覺模型（例如 llava、llama3.2-vision、qwen2.5vl，需先 ollama pull）。';
        }
        const ollamaUrl = ToolExecutor.getOrganizeOllamaUrls()[0];

        // 輸出目錄、行為清單、模式、信心、上限
        const outRaw = (args.output_dir as string || '').trim();
        const outDir = outRaw ? resolvePath(outRaw) : path.join(srcDir, '_organized');
        const behaviorList = Array.isArray(args.behaviors)
          ? (args.behaviors as unknown[]).map(String).map((s) => s.trim()).filter(Boolean) : [];
        const moveMode = (args.mode as string) === 'move';
        const minConf = typeof args.min_confidence === 'number' ? args.min_confidence as number : 60;
        const maxImages = Math.min(typeof args.max_images === 'number' ? args.max_images as number : 200, 1000);

        // 收集影像（排除輸出目錄底下的檔案，避免重複處理 / 重跑時把已整理的再吃進來）
        const outNorm = path.resolve(outDir).toLowerCase();
        let images = ToolExecutor.collectImageFiles(srcDir, maxImages + 100)
          .filter((p) => !path.resolve(p).toLowerCase().startsWith(outNorm))
          .slice(0, maxImages);
        if (images.length === 0) { return `在 ${srcDir} 找不到任何影像檔（.jpg/.jpeg/.png/.webp/.bmp/.gif）`; }

        // 權限：會建立資料夾並複製/移動檔案
        const permDesc = `整理照片：${images.length} 張 ${moveMode ? '移動' : '複製'} 至 ${outDir}`
          + (refRaw ? `（比對人物：${personName}）` : '（依行為分類）');
        const allowed = await this.requestPermission('write', permDesc, 'organize_photos');
        if (!allowed) { return '使用者已拒絕整理照片'; }
        fs.mkdirSync(outDir, { recursive: true });

        const behaviorInstruction = behaviorList.length > 0
          ? `行為標籤請務必從以下選項擇一（皆不符合時用「其他」）：${behaviorList.join('、')}。`
          : '行為標籤用 2~6 個字的簡短中文描述（例如：用餐、戶外、運動、工作、合照、自拍、室內）。';

        let scanned = 0, matched = 0, errors = 0;
        const perBehavior = new Map<string, number>();
        const failSamples: string[] = [];

        for (const imgPath of images) {
          scanned++;
          let candB64: string;
          try { candB64 = fs.readFileSync(imgPath).toString('base64'); }
          catch { errors++; continue; }

          let prompt: string;
          let imagesArg: string[];
          if (refB64) {
            prompt = [
              '你是照片辨識助手。第一張圖是「參考人物」的臉部照片，第二張圖是一張待辨識的照片。',
              '請完成兩件事，並「只」回傳 JSON（不要任何多餘文字或 markdown）：',
              '1. 判斷第二張照片中是否出現與第一張相同的人物（同一個人）。',
              `2. 若有出現，判斷該人物在照片中的行為或場景。${behaviorInstruction}`,
              '回傳格式：{"match": true 或 false, "confidence": 0到100的整數, "behavior": "標籤", "reason": "一句話原因"}',
            ].join('\n');
            imagesArg = [refB64, candB64];
          } else {
            prompt = [
              '你是照片辨識助手。請判斷這張照片的主要行為或場景，並「只」回傳 JSON（不要任何多餘文字或 markdown）。',
              behaviorInstruction,
              '回傳格式：{"match": true, "confidence": 100, "behavior": "標籤", "reason": "一句話原因"}',
            ].join('\n');
            imagesArg = [candB64];
          }

          let resp: string;
          try {
            resp = await ToolExecutor.ollamaVisionChat(ollamaUrl, visionModel, prompt, imagesArg, 90000);
          } catch (e) {
            errors++;
            const em = e instanceof Error ? e.message : String(e);
            if (failSamples.length < 3) { failSamples.push(`${path.basename(imgPath)}: ${em}`); }
            this._callbacks.log(`organize_photos: ${path.basename(imgPath)} 推論失敗 — ${em}`);
            // 第一張就連線層級失敗 → 提早中止，避免空轉整個目錄
            if (scanned === 1 && /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|逾時|URL 無效/.test(em)) {
              return `無法連線 Ollama 視覺模型（${ollamaUrl}，模型 ${visionModel}）：${em}\n`
                + '請確認 Ollama 正在執行，且已 ollama pull 該視覺模型。';
            }
            continue;
          }

          const parsed = ToolExecutor.extractFirstJson(resp);
          if (!parsed) {
            errors++;
            this._callbacks.log(`organize_photos: ${path.basename(imgPath)} 回應非 JSON：${resp.slice(0, 120)}`);
            continue;
          }
          const isMatch = parsed.match === true || parsed.match === 1
            || /^(true|yes|y|是|有|same)$/i.test(String(parsed.match ?? '').trim());
          let conf = typeof parsed.confidence === 'number'
            ? parsed.confidence : parseInt(String(parsed.confidence ?? ''), 10);
          if (!Number.isFinite(conf)) { conf = isMatch ? 80 : 0; }
          if (refB64 && (!isMatch || conf < minConf)) {
            this._callbacks.log(`organize_photos: ${path.basename(imgPath)} 不符合（match=${isMatch} conf=${conf}）`);
            continue;
          }
          const behavior = ToolExecutor.sanitizePathSegment(String(parsed.behavior ?? '未分類'), '未分類');

          // 目標：<out>/<person>/<behavior>/  或  <out>/<behavior>/
          const destDir = refB64 ? path.join(outDir, personName, behavior) : path.join(outDir, behavior);
          fs.mkdirSync(destDir, { recursive: true });
          let destPath = path.join(destDir, path.basename(imgPath));
          if (fs.existsSync(destPath)) {
            const ext = path.extname(imgPath);
            destPath = path.join(destDir, `${path.basename(imgPath, ext)}_${Date.now().toString(36)}${ext}`);
          }
          try {
            if (moveMode) {
              try { fs.renameSync(imgPath, destPath); }
              catch { fs.copyFileSync(imgPath, destPath); fs.unlinkSync(imgPath); } // 跨磁碟 fallback
            } else {
              fs.copyFileSync(imgPath, destPath);
            }
            matched++;
            perBehavior.set(behavior, (perBehavior.get(behavior) ?? 0) + 1);
            this._callbacks.log(`organize_photos: ✓ ${path.basename(imgPath)} → ${path.relative(outDir, destPath)} (conf=${conf})`);
          } catch (e) {
            errors++;
            const em = e instanceof Error ? e.message : String(e);
            if (failSamples.length < 3) { failSamples.push(`${path.basename(imgPath)}: ${em}`); }
          }
        }

        const behaviorSummary = [...perBehavior.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([b, n]) => `  • ${b}: ${n} 張`).join('\n');
        return [
          '📷 照片整理完成',
          `來源：${srcDir}`,
          `輸出：${outDir}`,
          `模型：${visionModel}（${ollamaUrl}）`,
          refRaw ? `比對人物：${personName}（最低信心 ${minConf}）` : '模式：依行為/場景分類',
          `掃描 ${scanned} 張，${moveMode ? '移動' : '複製'} ${matched} 張${refRaw ? '（符合人物）' : ''}，失敗/略過 ${errors} 張`,
          behaviorSummary ? `行為分佈：\n${behaviorSummary}` : '',
          failSamples.length ? `部分錯誤：\n${failSamples.map((s) => '  - ' + s).join('\n')}` : '',
        ].filter(Boolean).join('\n');
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
        const afInclude = (args.include as string) || '**/*.{ts,js,tsx,jsx,py,cs,java,go,rs,cpp,c,h,inf,dec,dsc,fdf,uni,nasm,asm,asl,vue,svelte}';
        const afTopK = Math.min(Math.max(Number(args.top_k) || 10, 1), 30);
        // 從 query 中抽取關鍵字（切 camelCase/snake_case，小寫，去掉停用詞）
        const afStopWords = new Set(['的','在','裡','中','使用','處理','負責','找出','哪個','檔案','函式','類別','實作','實現','相關','所有','一個','如何','為何','what','which','file','for','the','and','or','that','with','from','this','how','where','when']);
        const afKeywords = afQuery
          .replace(/([a-z])([A-Z])/g, '$1 $2') // camelCase
          .replace(/[_\-./]/g, ' ')
          .toLowerCase().split(/\s+/)
          .filter(w => w.length >= 2 && !afStopWords.has(w));
        const SKIP_BINARY = new Set(['.png','.jpg','.jpeg','.gif','.ico','.svg','.woff','.woff2','.ttf','.eot','.vsix','.zip','.tar','.gz','.exe','.dll','.pdf','.db','.sqlite','.lock','.wasm']);
        // 宣告抽取：函式/類別/介面/const/export，含 C/UEFI EFIAPI 函式與 INF section
        const afDeclReLines = /^\s*(?:export\s+)?(?:(?:async\s+)?function\*?\s+([\w$]+)|class\s+([\w$]+)|interface\s+([\w$]+)|type\s+([\w$]+)\s*(?:<[^>]*>)?\s*=|(?:const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>|def\s+([\w_]+)|func\s+([\w_]+)\s*\(|public\s+(?:static\s+)?\S+\s+([\w_]+)\s*\(|EFIAPI\s+([\w_]+)\s*\(|^\[([A-Za-z][\w.]+)\])/;
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
        const jbUseVscode = jbCfg.get<boolean>('jenkinsUseVscodeCommand', true);
        // 優先：透過 VS Code 外掛指令（VisualeBios）觸發，不走 HTTP，避免 DNS/網域問題
        if (jbUseVscode) {
          const jbMode = (args.mode as string) || 'build'; // build | rebuild
          const jbCmdId = jbMode === 'rebuild'
            ? jbCfg.get<string>('jenkinsRebuildCommand', 'visualebios.jenkins.rebuild')
            : jbCfg.get<string>('jenkinsBuildCommand', 'visualebios.jenkins.build');
          // 解析 Tools Dir 控制：tools_dir 直接指定，或 tools_version=59 自動組成 C:\AmiTools\VebTools\Tools59
          const jbToolsDir = (args.tools_dir as string | undefined)?.trim();
          const jbToolsVer = args.tools_version;
          let jbResolvedToolsDir = '';
          if (jbToolsDir) {
            jbResolvedToolsDir = jbToolsDir;
          } else if (jbToolsVer !== undefined && jbToolsVer !== null && String(jbToolsVer).trim() !== '') {
            const verStr = String(jbToolsVer).trim();
            jbResolvedToolsDir = /[\\/:]/.test(verStr) ? verStr : `C:\\AmiTools\\VebTools\\Tools${verStr}`;
          }
          const jbToolsScope = ((args.tools_scope as string) || 'workspace').toLowerCase();
          const jbAllowedCmd = await this.requestPermission('run', `透過 VS Code 外掛執行: ${jbCmdId}${jbResolvedToolsDir ? `\n[ToolsDir → ${jbResolvedToolsDir}]` : ''}`, 'jenkins_build');
          if (!jbAllowedCmd) return '使用者已拒絕 Jenkins Build';
          try {
            const all = await vscode.commands.getCommands(true);
            if (!all.includes(jbCmdId)) {
              return `❌ 找不到 VS Code 指令 "${jbCmdId}"。請確認 VisualeBios 外掛已安裝，或在設定 amiAiClaw.jenkinsBuildCommand 中改成正確的 command id。`;
            }
            // 套用 Tools Dir（呼叫 visualebios 指令前更新其設定）
            let jbToolsNote = '';
            if (jbResolvedToolsDir) {
              const vebCfg = vscode.workspace.getConfiguration('visualebios');
              const target = jbToolsScope === 'global'
                ? vscode.ConfigurationTarget.Global
                : vscode.ConfigurationTarget.Workspace;
              const prev = vebCfg.get<string>('toolsDir', '');
              if (prev !== jbResolvedToolsDir) {
                try {
                  await vebCfg.update('toolsDir', jbResolvedToolsDir, target);
                  jbToolsNote = `\n🛠️ ToolsDir 已更新 (${jbToolsScope}): ${prev || '(空)'} → ${jbResolvedToolsDir}`;
                } catch (e) {
                  jbToolsNote = `\n⚠️ ToolsDir 更新失敗: ${e instanceof Error ? e.message : String(e)}（仍會嘗試觸發 Build）`;
                }
              } else {
                jbToolsNote = `\n🛠️ ToolsDir 已是 ${jbResolvedToolsDir}（未變更）`;
              }
            }
            const ret = await vscode.commands.executeCommand(jbCmdId);
            return `✅ 已透過 VS Code 外掛指令觸發 Jenkins ${jbMode}: ${jbCmdId}${jbToolsNote}${ret !== undefined ? `\n回傳: ${typeof ret === 'string' ? ret : JSON.stringify(ret).slice(0, 300)}` : ''}`;
          } catch (e) {
            return `❌ 執行 VS Code 指令 "${jbCmdId}" 失敗: ${e instanceof Error ? e.message : String(e)}`;
          }
        }
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
        const rwInclude = (args.include as string) || '**/*.{ts,js,tsx,jsx,py,cs,java,go,rs,cpp,c,h,inf,dec,dsc,fdf,uni,nasm,asm,asl,md,json,yaml,yml,txt}';
        const rwExtraExclude = ((args.exclude as string) || '').split(',').map(s => s.trim()).filter(Boolean);
        const rwDefaultExclude = ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/out/**', '**/build/**', '**/.next/**', '**/__pycache__/**', '**/*.min.js', '**/*.map'];
        const rwExcludeGlob = '{' + [...rwDefaultExclude, ...rwExtraExclude].join(',') + '}';
        const rwMaxFileBytes = Math.max(1, (args.max_file_kb as number) || 128) * 1024;
        const rwMaxTotalBytes = Math.max(1, (args.max_total_kb as number) || 512) * 1024;
        const rwOffset = Math.max(0, Number(args.offset) || 0);
        const rwUris = await vscode.workspace.findFiles(rwInclude, rwExcludeGlob, 2000);
        const rwBinaryExts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.bmp', '.vsix', '.zip', '.tar', '.gz', '.exe', '.dll', '.so', '.dylib', '.wasm', '.pdf', '.db', '.sqlite']);
        const rwCandidates = rwUris.filter((u) => !rwBinaryExts.has(path.extname(u.fsPath).toLowerCase()));
        const rwSliced = rwCandidates.slice(rwOffset);
        const rwParts: string[] = [];
        let rwTotalBytes = 0;
        let rwTruncated = false;
        let rwProcessed = 0;
        const rwTotal = rwSliced.length;
        for (const uri of rwSliced) {
          rwProcessed++;
          if (rwProcessed % 10 === 0) {
            this._callbacks.postToWebview({
              type: 'agentStepProgress',
              text: `📂 read_workspace 進度 ${rwProcessed}/${rwTotal} (≈${Math.round(rwTotalBytes / 1024)}KB)`,
            });
          }
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
          if (rwTotalBytes + Buffer.byteLength(entry, 'utf8') > rwMaxTotalBytes) { rwTruncated = true; rwProcessed--; break; }
          rwTotalBytes += Buffer.byteLength(entry, 'utf8');
          rwParts.push(entry);
        }
        if (rwParts.length === 0 && rwOffset === 0) { return `找不到符合 "${rwInclude}" 的檔案`; }
        const nextOffset = rwOffset + rwProcessed;
        const remaining = Math.max(0, rwCandidates.length - nextOffset);
        const rwHeader = `工作區共 ${rwCandidates.length} 個檔案，本批讀取 ${rwParts.length} 個（offset=${rwOffset}→${nextOffset}，合計 ≈${Math.round(rwTotalBytes / 1024)} KB）${rwTruncated ? '，已達容量上限提早停止' : ''}`;
        const hint = remaining > 0
          ? `\n💡 剩餘 ${remaining} 個檔案未讀取，如需繼續請再次呼叫 read_workspace 並使用 offset=${nextOffset}。`
          : `\n✅ 所有符合條件的檔案已讀取完畢。`;
        return rwHeader + hint + '\n\n' + rwParts.join('\n\n');
      }
      case 'jenkins_status': {
        const jsCfg = vscode.workspace.getConfiguration('amiAiClaw');
        const jsUseVscode = jsCfg.get<boolean>('jenkinsUseVscodeCommand', true);
        if (jsUseVscode) {
          const jsCmdId = jsCfg.get<string>('jenkinsHistoryCommand', 'visualebios.jenkins.showBuildHistory');
          const jsAllowedCmd = await this.requestPermission('read', `透過 VS Code 外掛查詢 Jenkins 狀態: ${jsCmdId}`, 'jenkins_status');
          if (!jsAllowedCmd) return '使用者已拒絕 Jenkins Status';
          try {
            const all = await vscode.commands.getCommands(true);
            if (!all.includes(jsCmdId)) {
              return `❌ 找不到 VS Code 指令 "${jsCmdId}"。請確認 VisualeBios 外掛已安裝，或在設定 amiAiClaw.jenkinsHistoryCommand 中改成正確的 command id。`;
            }
            const ret = await vscode.commands.executeCommand(jsCmdId);
            return `✅ 已透過 VS Code 外掛指令查詢 Jenkins 狀態: ${jsCmdId}${ret !== undefined ? `\n回傳: ${typeof ret === 'string' ? ret : JSON.stringify(ret).slice(0, 500)}` : '\n（建置歷史已開啟在 VS Code 視窗中）'}`;
          } catch (e) {
            return `❌ 執行 VS Code 指令 "${jsCmdId}" 失敗: ${e instanceof Error ? e.message : String(e)}`;
          }
        }
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
      case 'agent_run_tool': {
        const targetName = (args.name ?? args.tool_name ?? args.target) as string | undefined;
        if (!targetName) {
          return '請提供 name 參數（要執行的目標工具名稱）。正確格式：{"name":"<工具名稱>","args":{...工具參數...}}。支援的工具範例：read_file、run_command、list_dir、search_workspace';
        }
        // 防止循環呼叫自身
        if (targetName === 'agent_run_tool' || targetName === 'agent:run_tool') {
          return '錯誤：agent_run_tool 不能遞迴呼叫自身';
        }
        // 支援 args / tool_args / parameters / input 作為目標工具參數的 key
        const rawTargetArgs =
          (typeof args.args === 'object' && args.args !== null) ? args.args :
          (typeof args.tool_args === 'object' && args.tool_args !== null) ? args.tool_args :
          (typeof args.parameters === 'object' && args.parameters !== null) ? args.parameters :
          (typeof args.input === 'object' && args.input !== null) ? args.input : {};
        return this.executeTool(targetName, rawTargetArgs as Record<string, unknown>);
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

