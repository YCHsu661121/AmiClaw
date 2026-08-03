// Copyright (c) 2026 YCHsu. All rights reserved.
// Licensed under the MIT License.

import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import { URL } from 'url';
import type { IToolProvider, ToolExecutionContext } from './IToolProvider';

const TOOLS = new Set(['jira_search','jira_fetch','jira_attachment_download','jira_open','jira_log_time','jira_create','jira_transition','bb_create_pr','rovo_ask']);

export class AtlassianProvider implements IToolProvider {
  readonly tools: ReadonlySet<string> = TOOLS;
  private _jiraCred: { baseApiUrl: string; accessToken: string; expiry: number } | null = null;
  private _rovoCache: { url: string; token: string; expiry: number } | undefined = undefined;
  private _rovoNullUntil = 0;

  execute(name: string, args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
    switch (name) {
      case 'jira_search':             return this._jiraSearch(args, ctx);
      case 'jira_fetch':              return this._jiraFetch(args, ctx);
      case 'jira_attachment_download':return this._jiraAttachment(args, ctx);
      case 'jira_open':               return this._jiraOpen(args);
      case 'jira_log_time':           return this._jiraLogTime(args, ctx);
      case 'jira_create':             return this._jiraCreate(args);
      case 'jira_transition':         return this._jiraTransition(args);
      case 'bb_create_pr':            return this._bbCreatePr();
      case 'rovo_ask':                return this._rovoAsk(args, ctx);
      default: return Promise.resolve(`AtlassianProvider: unknown tool "${name}"`);
    }
  }

  // ── Auth helpers ─────────────────────────────────────────────────────────────

  private async _getJiraAuth(): Promise<{ baseApiUrl: string; accessToken: string } | null> {
    if (this._jiraCred && this._jiraCred.expiry > Date.now() + 300_000) return this._jiraCred;
    try {
      const appData = process.env['APPDATA']; if (!appData) return null;
      const localState = path.join(appData, 'Code', 'Local State');
      if (!fs.existsSync(localState)) return null;
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
      const tmpPy = path.join(appData, 'ami-atlas-auth-tmp.py');
      fs.writeFileSync(tmpPy, pyScript, 'utf-8');
      let raw = ''; let lastErr: unknown;
      const cmds = process.platform === 'win32' ? ['py','python'] : ['python3','python'];
      try { for (const cmd of cmds) { try { raw = execSync(`${cmd} "${tmpPy}"`, { encoding:'utf-8', timeout:12_000 }).trim(); lastErr = undefined; break; } catch(e) { lastErr = e; } } if (lastErr) throw lastErr; }
      finally { try { fs.unlinkSync(tmpPy); } catch { /* ignore */ } }
      const parsed = JSON.parse(raw) as { error?:string; mk?:number[]; buf?:number[]; baseApiUrl?:string };
      if (parsed.error || !parsed.mk || !parsed.buf || !parsed.baseApiUrl) return null;
      const mk = Buffer.from(parsed.mk); const buf = Buffer.from(parsed.buf);
      const decipher = crypto.createDecipheriv('aes-256-gcm', mk, buf.slice(3,15)); decipher.setAuthTag(buf.slice(buf.length-16));
      const plain = Buffer.concat([decipher.update(buf.slice(15,buf.length-16)), decipher.final()]);
      const cred = JSON.parse(plain.toString('utf-8')) as { access?:string };
      if (!cred.access) return null;
      let expiry = Date.now() + 3_600_000;
      try { const p = JSON.parse(Buffer.from(cred.access.split('.')[1],'base64').toString('utf-8')); if (p.exp) expiry = p.exp * 1000; } catch { /* ignore */ }
      this._jiraCred = { baseApiUrl: parsed.baseApiUrl, accessToken: cred.access, expiry };
      return this._jiraCred;
    } catch { return null; }
  }

  private _getManualAuth(): { base: string; header: string } | null {
    const cfg = vscode.workspace.getConfiguration('amiAiClaw');
    const base = (cfg.get<string>('jiraBaseUrl') ?? '').replace(/\/$/, '');
    const email = cfg.get<string>('jiraEmail') ?? '';
    const pat = cfg.get<string>('jiraPat') ?? '';
    if (!base || !pat) return null;
    return { base, header: email ? 'Basic ' + Buffer.from(`${email}:${pat}`).toString('base64') : 'Bearer ' + pat };
  }

  private async _resolveAuth(versionedBase = false): Promise<{ apiBase: string; header: string } | string> {
    const atlas = await this._getJiraAuth();
    if (atlas) return { apiBase: atlas.baseApiUrl, header: `Bearer ${atlas.accessToken}` };
    const manual = this._getManualAuth();
    if (!manual) return '❌ Jira 認證失敗：找不到 atlassian.atlascode 登入資訊，也未設定 amiAiClaw.jiraBaseUrl + amiAiClaw.jiraPat。';
    return { apiBase: versionedBase ? manual.base + '/rest' : manual.base + '/rest/api/3', header: manual.header };
  }

  private _jiraRequest(url: string, method: string, header: string, body?: string): Promise<{status:number;data:string}> {
    return new Promise(resolve => {
      try {
        const u = new URL(url); const isHttps = u.protocol === 'https:'; const proto = isHttps ? https : http;
        const buf = body ? Buffer.from(body, 'utf8') : undefined;
        const req = proto.request({
          hostname: u.hostname, port: u.port ? parseInt(u.port) : (isHttps?443:80), path: u.pathname+u.search, method,
          headers: { 'Authorization': header, 'Accept': 'application/json', 'Content-Type': 'application/json', ...(buf?{'Content-Length':buf.length}:{}) },
        }, res => {
          let data = '';
          res.on('data', (c: Buffer) => { data += c; });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, data }));
        });
        req.on('error', (e: Error) => resolve({ status: 0, data: e.message }));
        req.setTimeout(15000, () => { req.destroy(); resolve({ status: 0, data: '逾時 (15s)' }); });
        if (buf) req.write(buf);
        req.end();
      } catch(e) { resolve({ status: 0, data: String(e) }); }
    });
  }

  // ── jira_search ───────────────────────────────────────────────────────────────
  private async _jiraSearch(args: Record<string, unknown>, _ctx: ToolExecutionContext): Promise<string> {
    let jql = (args.jql as string || '').trim();
    if (!jql) {
      const parts: string[] = [];
      if (args.assignee) parts.push(`assignee = "${args.assignee}"`);
      if (args.reporter) parts.push(`reporter = "${args.reporter}"`);
      if (args.project)  parts.push(`project = "${args.project}"`);
      if (args.status)   parts.push(`status = "${args.status}"`);
      if (args.text)     parts.push(`text ~ "${args.text}"`);
      if (parts.length === 0) return '請提供 jql 或至少一個過濾條件';
      jql = parts.join(' AND ') + ' ORDER BY updated DESC';
    }
    const auth = await this._resolveAuth(); if (typeof auth === 'string') return auth;
    const maxResults = Math.min(Number(args.max_results ?? 20), 50);
    const { apiBase, header } = auth;
    const isAtlas = apiBase.includes('/api/3') || !apiBase.includes('/rest');
    const searchUrl = isAtlas ? `${apiBase}/search/jql` : `${apiBase}/api/3/search/jql`;
    const body = JSON.stringify({ jql, maxResults, fields: ['summary','status','assignee','reporter','priority','issuetype','updated','labels'] });
    const { status, data } = await this._jiraRequest(searchUrl, 'POST', header, body);
    if (status === 401 || status === 403) { this._jiraCred = null; return `❌ Jira 認證失敗 (HTTP ${status})。請重新登入 atlassian.atlascode 或更新 amiAiClaw.jiraPat。`; }
    if (status !== 200) return `❌ Jira Search 失敗 HTTP ${status}：${data.slice(0,200)}`;
    try {
      const j = JSON.parse(data); const issues = j.issues ?? [] as Array<Record<string,unknown>>;
      if (issues.length === 0) return `JQL: ${jql}\n\n查無符合的 Issue。`;
      const lines = issues.map((iss: Record<string,unknown>) => {
        const f = iss.fields as Record<string,unknown>;
        return `[${iss.key}] [${(f.issuetype as Record<string,unknown>)?.name??''}] [${(f.status as Record<string,unknown>)?.name??''}] [${(f.priority as Record<string,unknown>)?.name??''}] ${f.summary}  (Assignee: ${(f.assignee as Record<string,unknown>)?.displayName??'未指派'}, Updated: ${String(f.updated??'').slice(0,10)})`;
      });
      return `JQL: ${jql}\n共 ${j.total} 筆（顯示前 ${issues.length} 筆）:\n\n${lines.join('\n')}`;
    } catch { return `無法解析 Jira Search 回應: ${data.slice(0,300)}`; }
  }

  // ── jira_fetch ────────────────────────────────────────────────────────────────
  private async _jiraFetch(args: Record<string, unknown>, _ctx: ToolExecutionContext): Promise<string> {
    const key = (args.issue_key as string || '').trim().toUpperCase(); if (!key) return '請提供 issue_key';
    const auth = await this._resolveAuth(); if (typeof auth === 'string') return auth;
    const { apiBase, header } = auth;
    const fields = 'summary,description,status,assignee,reporter,priority,issuetype,labels,comment,attachment,created,updated';
    const isAtlas = apiBase.includes('/api/3') || !apiBase.includes('/rest');
    const url = isAtlas ? `${apiBase}/issue/${key}?fields=${fields}` : `${apiBase}/api/3/issue/${key}?fields=${fields}`;
    const { status, data } = await this._jiraRequest(url, 'GET', header);
    if (status===401||status===403) { this._jiraCred=null; return `Jira 認證失敗 (HTTP ${status})，請確認 atlassian.atlascode 已登入，或設定 amiAiClaw.jiraPat。`; }
    if (status===404) return `找不到 Issue ${key}，請確認 Key 正確或使用者有權限。`;
    if (status!==200) return `Jira API 回傳 HTTP ${status}: ${data.slice(0,200)}`;
    try {
      const j = JSON.parse(data); const f = j.fields || {};
      const comments = (f.comment?.comments??[]).slice(-3).map((c: Record<string,unknown>) => `  [${(c.author as Record<string,unknown>)?.displayName}] ${String(c.body??'').slice(0,300)}`).join('\n');
      const attachments = (f.attachment??[]) as Array<{filename:string;size:number;mimeType:string;content:string}>;
      const attLines = attachments.length > 0 ? `\nAttachments (${attachments.length}):\n` + attachments.map(a=>`  [${a.filename}] ${(a.size/1024).toFixed(1)}KB  ${a.mimeType}  url=${a.content}`).join('\n') : '';
      return [`Issue: ${key}  (${f.issuetype?.name??''})`,`Status: ${f.status?.name??''}`,`Priority: ${f.priority?.name??''}`,`Reporter: ${f.reporter?.displayName??''}`,`Assignee: ${f.assignee?.displayName??'未指派'}`,`Labels: ${(f.labels??[]).join(', ')||'(none)'}`,`Summary: ${f.summary??''}`,`Description:\n${String(f.description??'(empty)').slice(0,2000)}`,comments?`\nLatest Comments:\n${comments}`:'',attLines].filter(Boolean).join('\n');
    } catch { return `無法解析 Jira API 回應: ${data.slice(0,300)}`; }
  }

  // ── jira_attachment_download ──────────────────────────────────────────────────
  private async _jiraAttachment(args: Record<string, unknown>, _ctx: ToolExecutionContext): Promise<string> {
    const attachUrl = (args.url as string || '').trim(); if (!attachUrl) return '請提供 url 參數';
    let rawFn = (args.filename as string || '').trim();
    if (!rawFn) { try { rawFn = decodeURIComponent(path.basename(new URL(attachUrl).pathname)); } catch { rawFn = 'attachment'; } }
    const safeFilename = rawFn.replace(/[/\\:*?"<>|]/g, '_').replace(/^\.+/, '_');
    const auth = await this._resolveAuth(); if (typeof auth === 'string') return auth;
    const outFile = path.join(os.tmpdir(), safeFilename);
    const dlResult = await new Promise<{ok:boolean;err?:string}>(resolve => {
      try {
        const u = new URL(attachUrl); const isHttps = u.protocol==='https:'; const proto = isHttps ? https : http;
        const req = proto.request({ hostname:u.hostname, port:u.port?parseInt(u.port):(isHttps?443:80), path:u.pathname+u.search, method:'GET', headers:{'Authorization':auth.header} }, res => {
          if (res.statusCode!==200) { res.resume(); resolve({ok:false,err:`HTTP ${res.statusCode}`}); return; }
          const chunks: Buffer[] = [];
          res.on('data',(c:Buffer)=>chunks.push(c));
          res.on('end',()=>{ try{fs.writeFileSync(outFile,Buffer.concat(chunks));resolve({ok:true});}catch(e){resolve({ok:false,err:String(e)});} });
          res.on('error',(e:Error)=>resolve({ok:false,err:e.message}));
        });
        req.on('error',(e:Error)=>resolve({ok:false,err:e.message}));
        req.setTimeout(60000,()=>{req.destroy();resolve({ok:false,err:'下載逾時 (60s)'});});
        req.end();
      } catch(e){resolve({ok:false,err:String(e)});}
    });
    if (!dlResult.ok) return `附件下載失敗: ${dlResult.err}`;
    if (path.extname(safeFilename).toLowerCase()==='.zip') {
      const extractDir = outFile + '_extracted';
      try {
        if (fs.existsSync(extractDir)) execSync(`rmdir /s /q "${extractDir}"`,{shell:'cmd.exe',timeout:10000,windowsHide:true});
        execSync(`powershell -NoProfile -Command "Expand-Archive -LiteralPath '${outFile}' -DestinationPath '${extractDir}' -Force"`,{timeout:30000,windowsHide:true});
        const listFiles = (dir:string,base=''):string[] => { const r:string[]=[]; try { for (const n of fs.readdirSync(dir)) { const rel=base?`${base}/${n}`:n; const full=path.join(dir,n); if (fs.statSync(full).isDirectory()) r.push(...listFiles(full,rel)); else r.push(rel); } } catch{} return r; };
        const files = listFiles(extractDir);
        const lines = [`📦 ${safeFilename} 解壓縮完成，共 ${files.length} 個檔案:\n`, ...files.slice(0,80).map(f=>`  ${f}`), files.length>80?`  … (共 ${files.length} 個)`:'' ];
        const textExts = new Set(['.txt','.log','.md','.json','.xml','.csv','.ini','.cfg','.py','.ts','.js','.sh','.bat','.diff','.patch']);
        let shown = 0;
        for (const rel of files) { if (shown>=5) break; if (!textExts.has(path.extname(rel).toLowerCase())) continue; const full=path.join(extractDir,rel); try { const s=fs.statSync(full); if(s.size>60000) continue; const c=fs.readFileSync(full,'utf-8'); lines.push(`\n--- ${rel} ---\n${c.slice(0,4000)}${c.length>4000?'\n…（已截斷）':''}`); shown++; } catch{} }
        return lines.join('\n') + `\n解壓縮目錄: ${extractDir}`;
      } catch(e) { return `ZIP 解壓縮失敗: ${e instanceof Error?e.message:String(e)}\n檔案已存至: ${outFile}`; }
    }
    try { const c=fs.readFileSync(outFile,'utf-8'); return `📄 ${safeFilename}\n\n${c.slice(0,6000)}${c.length>6000?'\n…（已截斷）':''}`; }
    catch { return `✅ ${safeFilename} 已下載至 ${outFile}（二進位檔案）`; }
  }

  // ── jira_open / jira_create / jira_transition / bb_create_pr ─────────────────
  private async _jiraOpen(args: Record<string, unknown>): Promise<string> {
    const key = (args.issue_key as string||'').trim().toUpperCase(); if (!key) return '請提供 issue_key';
    try { await vscode.commands.executeCommand('atlascode.jira.showIssueForKey', key); return `已開啟 Jira Issue: ${key}`; }
    catch(e) { return `無法開啟 Jira Issue: ${e instanceof Error?e.message:String(e)}`; }
  }

  private async _jiraCreate(args: Record<string, unknown>): Promise<string> {
    try { await vscode.commands.executeCommand('atlascode.jira.createIssue', args.summary ? {summary:args.summary,description:args.description} : undefined); return '已開啟 Jira 建立 Issue 面板'; }
    catch(e) { return `開啟失敗: ${e instanceof Error?e.message:String(e)}`; }
  }

  private async _jiraTransition(args: Record<string, unknown>): Promise<string> {
    const key = (args.issue_key as string||'').trim().toUpperCase(); if (!key) return '請提供 issue_key';
    try { await vscode.commands.executeCommand('atlascode.jira.transitionIssue',{key}); return `已開啟 ${key} 狀態轉換面板`; }
    catch(e) { return `失敗: ${e instanceof Error?e.message:String(e)}`; }
  }

  private async _bbCreatePr(): Promise<string> {
    try { await vscode.commands.executeCommand('atlascode.bb.createPullRequest'); return '已開啟 Bitbucket 建立 Pull Request 面板'; }
    catch(e) { return `失敗: ${e instanceof Error?e.message:String(e)}`; }
  }

  // ── jira_log_time ─────────────────────────────────────────────────────────────
  private async _jiraLogTime(args: Record<string, unknown>, _ctx: ToolExecutionContext): Promise<string> {
    const key = (args.issue_key as string||'').trim().toUpperCase(); if (!key) return '請提供 issue_key';
    const timeStr = (args.time_spent as string||'').trim(); if (!timeStr) return '請提供 time_spent，例如 "16h"、"2h 30m"、"1d"';
    let secs = 0;
    const dm=timeStr.match(/(\d+(?:\.\d+)?)\s*d/i); const hm=timeStr.match(/(\d+(?:\.\d+)?)\s*h/i);
    const mm=timeStr.match(/(\d+(?:\.\d+)?)\s*m(?!s)/i); const sm=timeStr.match(/(\d+(?:\.\d+)?)\s*s(?!\w)/i);
    if (dm) secs += parseFloat(dm[1])*8*3600; if (hm) secs += parseFloat(hm[1])*3600;
    if (mm) secs += parseFloat(mm[1])*60; if (sm) secs += parseFloat(sm[1]);
    if (!dm&&!hm&&!mm&&!sm) { const b=parseFloat(timeStr); if (!isNaN(b)) secs=b; else return `無法解析時間格式: "${timeStr}"`; }
    if (secs <= 0) return '時間必須大於 0';
    const dateStr = (args.date as string||'today').trim().toLowerCase();
    let d = new Date(); if (dateStr==='yesterday') d.setDate(d.getDate()-1); else if (dateStr!=='today'&&dateStr) d = new Date(dateStr);
    if (isNaN(d.getTime())) return `無法解析日期: "${dateStr}"`;
    const pad=(n:number)=>String(n).padStart(2,'0');
    const started = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T09:00:00.000+0000`;
    const auth = await this._resolveAuth(true); if (typeof auth === 'string') return auth;
    const { apiBase, header } = auth;
    const isAtlas = apiBase.includes('/api/3') || !apiBase.includes('/rest');
    const url = isAtlas ? `${apiBase}/issue/${key}/worklog` : `${apiBase}/api/3/issue/${key}/worklog`;
    const body = JSON.stringify({ timeSpentSeconds: Math.round(secs), started, ...(args.comment?{comment:args.comment}:{}) });
    const { status, data } = await this._jiraRequest(url, 'POST', header, body);
    if (status===401||status===403) { this._jiraCred=null; return `Jira 認證失敗 (HTTP ${status})`; }
    if (status===404) return `找不到 Issue ${key}`;
    if (status!==201) return `Jira Log Time 失敗 HTTP ${status}: ${data.slice(0,200)}`;
    try { const j=JSON.parse(data); const hrs=(secs/3600).toFixed(1); return `✅ 已記錄 ${key} 工時 ${hrs}h，日期: ${dateStr==='today'?'今天':dateStr}${args.comment?`，備註: ${args.comment}`:''}，worklog ID: ${j.id}`; }
    catch { return `Jira Log Time 完成但無法解析回應: ${data.slice(0,200)}`; }
  }

  // ── rovo_ask ──────────────────────────────────────────────────────────────────
  private async _rovoAsk(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
    const q = (args.question as string||'').trim(); if (!q) return '請提供 question 參數';
    try { const r = await this._callRovoApi(q); if (r) return `[Rovo Dev 回覆]\n${r}`; } catch { /* fall through */ }
    try { await vscode.commands.executeCommand('atlascode.rovodev.askInteractive', q); return '已在 Rovo Dev 面板提問（無法直接取回回覆），請查看 Rovo Dev 面板。'; }
    catch(e) { return `失敗: ${e instanceof Error?e.message:String(e)}`; }
  }

  private async _discoverRovo(): Promise<{url:string;token:string}|null> {
    if (this._rovoCache && Date.now() < this._rovoCache.expiry) return { url:this._rovoCache.url, token:this._rovoCache.token };
    if (!this._rovoCache && Date.now() < this._rovoNullUntil) return null;
    const envToken = process.env['ROVODEV_SERVE_SESSION_TOKEN'] ?? '';
    const tryUrl = (url: string): Promise<boolean> => new Promise(resolve => {
      try {
        const u = new URL('/healthcheck', url);
        const req = http.request({ hostname:u.hostname, port:parseInt(u.port||'80'), path:u.pathname, method:'GET', headers:envToken?{'Authorization':`Bearer ${envToken}`}:{} }, res => { res.resume(); resolve(res.statusCode===200); });
        req.on('error',()=>resolve(false)); req.setTimeout(2000,()=>{req.destroy();resolve(false);}); req.end();
      } catch { resolve(false); }
    });
    const envPort = process.env['ROVODEV_PORT'];
    if (envPort && /^\d+$/.test(envPort)) { const url=`http://127.0.0.1:${envPort}`; if (await tryUrl(url)) { this._rovoCache={url,token:envToken,expiry:Date.now()+5*60_000}; return {url,token:envToken}; } }
    if (process.platform === 'win32') {
      try {
        const taskOut = execSync('tasklist /FI "IMAGENAME eq atlassian_cli_rovodev.exe" /FO CSV /NH 2>nul',{shell:'cmd.exe',timeout:3000,windowsHide:true}).toString();
        const pidM = taskOut.match(/"atlassian_cli_rovodev\.exe","(\d+)"/); if (!pidM) throw new Error('not found');
        const netOut = execSync('netstat -ano 2>nul | findstr " LISTENING"',{shell:'cmd.exe',timeout:5000,windowsHide:true}).toString();
        for (const line of netOut.split('\n')) { if (!line.trimEnd().endsWith(pidM[1])) continue; const m=line.match(/127\.0\.0\.1:(\d+)/); if (!m) continue; const p=parseInt(m[1]); if (p>=40000&&p<=41000) { const url=`http://127.0.0.1:${p}`; if (await tryUrl(url)) { this._rovoCache={url,token:envToken,expiry:Date.now()+5*60_000}; return {url,token:envToken}; } } }
      } catch { /* not found */ }
    }
    this._rovoCache = undefined; this._rovoNullUntil = Date.now() + 30_000; return null;
  }

  private async _callRovoApi(question: string): Promise<string|null> {
    const target = await this._discoverRovo(); if (!target) return null;
    const { url, token } = target;
    const hdrs: Record<string,string> = { 'Content-Type':'application/json', 'accept':'text/event-stream', ...(token?{'Authorization':`Bearer ${token}`}:{}) };
    const body = JSON.stringify({ message: question, context: [] });
    const step1 = await new Promise<boolean>(resolve => {
      try {
        const u = new URL('/v3/set_chat_message', url);
        const req = http.request({ hostname:u.hostname, port:parseInt(u.port||'80'), path:u.pathname, method:'POST', headers:{...hdrs,'Content-Length':Buffer.byteLength(body)} }, res => { res.resume(); resolve((res.statusCode??0)<400); });
        req.on('error',()=>resolve(false)); req.setTimeout(10000,()=>{req.destroy();resolve(false);}); req.write(body); req.end();
      } catch { resolve(false); }
    });
    if (!step1) { this._rovoCache=undefined; this._rovoNullUntil=0; return null; }
    return new Promise<string|null>(resolve => {
      try {
        const u = new URL('/v3/stream_chat?pause_on_call_tools_start=false&enable_deferred_tools=true', url);
        const req = http.request({ hostname:u.hostname, port:parseInt(u.port||'80'), path:u.pathname+u.search, method:'GET', headers:hdrs }, res => {
          if (res.statusCode!==200) { res.resume(); resolve(null); return; }
          let buf=''; const parts: string[] = [];
          res.on('data',(c:Buffer)=>{ buf+=c.toString('utf8'); const blocks=buf.split(/\r?\n\r?\n/g); buf=blocks.pop()??''; for (const b of blocks) { if (b.startsWith(': ping')) continue; const m=b.match(/^event: ([^\r\n]+)\r?\ndata: ([\s\S]*)$/); if (!m) continue; const kind=m[1].trim(); let data: Record<string,unknown>={}; try{data=JSON.parse(m[2]);}catch{continue;} if (kind==='text') { const c=(data['content']??data['content_delta']??'') as string; if (c) parts.push(c); } else if (kind==='part_start') { const p=(data['part']??{}) as Record<string,unknown>; if (p['part_kind']==='text'&&p['content']) parts.push(p['content'] as string); } else if (kind==='part_delta') { const d=(data['delta']??{}) as Record<string,unknown>; if (d['part_delta_kind']==='text'&&d['content_delta']) parts.push(d['content_delta'] as string); } } });
          res.on('end',()=>resolve(parts.join('').trim()||null));
          res.on('error',()=>resolve(null));
        });
        req.on('error',()=>resolve(null)); req.setTimeout(60000,()=>{req.destroy();resolve(null);}); req.end();
      } catch { resolve(null); }
    });
  }
}
