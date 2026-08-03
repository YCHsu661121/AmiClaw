// Copyright (c) 2026 YCHsu. All rights reserved.
// Licensed under the MIT License.

import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import type { IToolProvider, ToolExecutionContext } from './IToolProvider';

const TOOLS = new Set(['jenkins_build', 'jenkins_status']);

type HttpResult = { status: number; body: string; location?: string };

export class JenkinsProvider implements IToolProvider {
  readonly tools: ReadonlySet<string> = TOOLS;

  execute(name: string, args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
    switch (name) {
      case 'jenkins_build':  return this._build(args, ctx);
      case 'jenkins_status': return this._status(args, ctx);
      default: return Promise.resolve(`JenkinsProvider: unknown tool "${name}"`);
    }
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private _http(urlStr: string, method: string, auth: string, postBody?: string, extraHdrs: Record<string, string> = {}): Promise<HttpResult> {
    return new Promise(res => {
      let pu: URL;
      try { pu = new URL(urlStr); } catch { res({ status: 0, body: '無效 URL: ' + urlStr }); return; }
      const isHttps = pu.protocol === 'https:';
      const proto = isHttps ? https : http;
      const bodyBuf = postBody ? Buffer.from(postBody, 'utf8') : undefined;
      const opts = {
        hostname: pu.hostname, port: pu.port || (isHttps ? 443 : 80),
        path: pu.pathname + pu.search, method,
        headers: {
          'Accept': 'application/json',
          ...(auth ? { 'Authorization': auth } : {}),
          ...(bodyBuf ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': bodyBuf.length } : {}),
          ...extraHdrs,
        },
      };
      let rb = '';
      const req = proto.request(opts, r => {
        r.setEncoding('utf8');
        r.on('data', (d: string) => { rb += d; });
        r.on('end', () => res({ status: r.statusCode ?? 0, body: rb, location: r.headers.location as string | undefined }));
      });
      req.on('error', (e: Error) => res({ status: 0, body: '網路錯誤: ' + e.message }));
      req.setTimeout(15000, () => { req.destroy(); res({ status: 0, body: '超時 (15s)' }); });
      if (bodyBuf) { req.write(bodyBuf); }
      req.end();
    });
  }

  private _getCrumb(jbUrl: string, auth: string): Promise<{ field: string; value: string } | null> {
    return new Promise(res => {
      const cu = new URL('/crumbIssuer/api/json', jbUrl);
      const isHttps = cu.protocol === 'https:';
      const proto = isHttps ? https : http;
      const opts = { hostname: cu.hostname, port: cu.port || (isHttps ? 443 : 80), path: cu.pathname, method: 'GET', headers: { 'Accept': 'application/json', ...(auth ? { 'Authorization': auth } : {}) } };
      let cb = '';
      const req = proto.request(opts, r => {
        r.setEncoding('utf8');
        r.on('data', (d: string) => { cb += d; });
        r.on('end', () => { try { const j = JSON.parse(cb) as Record<string, string>; res({ field: j.crumbRequestField, value: j.crumb }); } catch { res(null); } });
      });
      req.on('error', () => res(null));
      req.setTimeout(5000, () => { req.destroy(); res(null); });
      req.end();
    });
  }

  // ── jenkins_build ──────────────────────────────────────────────────────────

  private async _build(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
    const cfg = vscode.workspace.getConfiguration('amiAiClaw');
    if (cfg.get<boolean>('jenkinsUseVscodeCommand', true)) {
      return this._buildVscode(args, cfg, ctx);
    }
    return this._buildHttp(args, cfg, ctx);
  }

  private async _buildVscode(args: Record<string, unknown>, cfg: vscode.WorkspaceConfiguration, ctx: ToolExecutionContext): Promise<string> {
    const mode   = (args.mode as string) || 'build';
    const cmdId  = mode === 'rebuild' ? cfg.get<string>('jenkinsRebuildCommand', 'visualebios.jenkins.rebuild') : cfg.get<string>('jenkinsBuildCommand', 'visualebios.jenkins.build');
    const rawDir = (args.tools_dir as string | undefined)?.trim();
    const rawVer = args.tools_version;
    let resolvedDir = rawDir ?? (rawVer != null && String(rawVer).trim() !== ''
      ? (/[\\/:]/.test(String(rawVer).trim()) ? String(rawVer).trim() : `C:\\AmiTools\\VebTools\\Tools${String(rawVer).trim()}`)
      : '');
    const allowed = await ctx.requestPermission('run', `透過 VS Code 外掛執行: ${cmdId}${resolvedDir ? `\n[ToolsDir → ${resolvedDir}]` : ''}`, 'jenkins_build');
    if (!allowed) return '使用者已拒絕 Jenkins Build';
    try {
      const all = await vscode.commands.getCommands(true);
      if (!all.includes(cmdId!)) return `❌ 找不到 VS Code 指令 "${cmdId}"。請確認 VisualeBios 外掛已安裝。`;
      let toolsNote = '';
      if (resolvedDir) {
        const vebCfg = vscode.workspace.getConfiguration('visualebios');
        const scope  = (args.tools_scope as string || 'workspace') === 'global' ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace;
        const prev   = vebCfg.get<string>('toolsDir', '');
        if (prev !== resolvedDir) {
          try { await vebCfg.update('toolsDir', resolvedDir, scope); toolsNote = `\n🛠️ ToolsDir 已更新: ${prev || '(空)'} → ${resolvedDir}`; }
          catch (e) { toolsNote = `\n⚠️ ToolsDir 更新失敗: ${e instanceof Error ? e.message : String(e)}`; }
        } else { toolsNote = `\n🛠️ ToolsDir 已是 ${resolvedDir}（未變更）`; }
      }
      const ret = await vscode.commands.executeCommand(cmdId!);
      return `✅ 已透過 VS Code 外掛觸發 Jenkins ${mode}: ${cmdId}${toolsNote}${ret !== undefined ? `\n回傳: ${typeof ret === 'string' ? ret : JSON.stringify(ret).slice(0, 300)}` : ''}`;
    } catch (e) { return `❌ 執行 VS Code 指令 "${cmdId}" 失敗: ${e instanceof Error ? e.message : String(e)}`; }
  }

  private async _buildHttp(args: Record<string, unknown>, cfg: vscode.WorkspaceConfiguration, ctx: ToolExecutionContext): Promise<string> {
    const base = cfg.get<string>('jenkinsUrl', 'http://localdev.visualebios').replace(/\/+$/, '');
    const user = cfg.get<string>('jenkinsUser', '').trim();
    const tok  = cfg.get<string>('jenkinsToken', '').trim();
    const job  = ((args.job as string) || cfg.get<string>('jenkinsDefaultJob', 'SeamlessBuild')).trim();
    const auth = (user && tok) ? 'Basic ' + Buffer.from(`${user}:${tok}`).toString('base64') : '';
    const allowed = await ctx.requestPermission('run', `觸發 Jenkins: ${base}/job/${job}`, 'jenkins_build');
    if (!allowed) return '使用者已拒絕 Jenkins Build';
    const crumb   = await this._getCrumb(base, auth);
    const crumbHdr: Record<string, string> = crumb ? { [crumb.field]: crumb.value } : {};
    const jbParams = args.params as Record<string, string> | undefined;
    const hasParams = jbParams && Object.keys(jbParams).length > 0;
    const triggerPath = hasParams ? `${base}/job/${encodeURIComponent(job)}/buildWithParameters` : `${base}/job/${encodeURIComponent(job)}/build`;
    const postBody    = hasParams ? Object.entries(jbParams!).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&') : undefined;
    const tr = await this._http(triggerPath, 'POST', auth, postBody, crumbHdr);
    if (tr.status === 0)    return `無法連線 Jenkins: ${tr.body}`;
    if (tr.status >= 400)   return `Jenkins Build 觸發失敗 HTTP ${tr.status}: ${tr.body.slice(0, 300)}`;
    const queueUrl = tr.location;
    let buildNumber: number | null = null;
    let queueMsg = queueUrl ? `\n排隊位置: ${queueUrl}` : '';
    if (args.wait !== false && queueUrl) {
      ctx.callbacks.postToWebview({ type: 'agentStep', icon: '⏳', title: `等待 Jenkins [${job}] Job 開始…`, fullPath: '' });
      for (let i = 0; i < 12 && !buildNumber; i++) {
        await new Promise(r => setTimeout(r, 5000));
        const qr = await this._http(queueUrl.replace(/\/?$/, '/api/json'), 'GET', auth);
        if (qr.status === 200) {
          try { const ex = (JSON.parse(qr.body) as Record<string, unknown>).executable as Record<string, unknown> | undefined; if (ex?.number) { buildNumber = ex.number as number; } } catch { /* continue */ }
        }
      }
      if (buildNumber) {
        const sr = await this._http(`${base}/job/${encodeURIComponent(job)}/${buildNumber}/api/json`, 'GET', auth);
        if (sr.status === 200) {
          try { const sj = JSON.parse(sr.body) as Record<string, unknown>; queueMsg += `\n編號: #${buildNumber} | 狀態: ${(sj.result as string | null) ?? '進行中'}${sj.duration ? ` | 耗時: ${Math.round(Number(sj.duration) / 1000)}s` : ''}`; } catch { /* ignore */ }
        }
      }
    }
    return `✅ Jenkins Build 已觸發: ${base}/job/${job}${queueMsg}${buildNumber ? `\n建置詳情: ${base}/job/${encodeURIComponent(job)}/${buildNumber}` : '\n提示: 可用 jenkins_status 查詢結果'}`;
  }

  // ── jenkins_status ─────────────────────────────────────────────────────────

  private async _status(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
    const cfg = vscode.workspace.getConfiguration('amiAiClaw');
    if (cfg.get<boolean>('jenkinsUseVscodeCommand', true)) {
      const cmdId  = cfg.get<string>('jenkinsHistoryCommand', 'visualebios.jenkins.showBuildHistory');
      const allowed = await ctx.requestPermission('read', `透過 VS Code 外掛查詢 Jenkins 狀態: ${cmdId}`, 'jenkins_status');
      if (!allowed) return '使用者已拒絕 Jenkins Status';
      try {
        const all = await vscode.commands.getCommands(true);
        if (!all.includes(cmdId!)) return `❌ 找不到 VS Code 指令 "${cmdId}"。請確認 VisualeBios 外掛已安裝。`;
        const ret = await vscode.commands.executeCommand(cmdId!);
        return `✅ 已透過 VS Code 外掛查詢 Jenkins 狀態: ${cmdId}${ret !== undefined ? `\n回傳: ${typeof ret === 'string' ? ret : JSON.stringify(ret).slice(0, 500)}` : '\n（建置歷史已開啟在 VS Code 視窗中）'}`;
      } catch (e) { return `❌ 執行 VS Code 指令 "${cmdId}" 失敗: ${e instanceof Error ? e.message : String(e)}`; }
    }
    const base    = cfg.get<string>('jenkinsUrl', 'http://localdev.visualebios').replace(/\/+$/, '');
    const user    = cfg.get<string>('jenkinsUser', '').trim();
    const tok     = cfg.get<string>('jenkinsToken', '').trim();
    const job     = ((args.job as string) || cfg.get<string>('jenkinsDefaultJob', 'SeamlessBuild')).trim();
    const bNum    = args.build_number ? String(args.build_number) : 'lastBuild';
    const inclLog = args.include_log !== false;
    const logLines = Math.min(Number(args.log_lines || 100), 500);
    const auth    = (user && tok) ? 'Basic ' + Buffer.from(`${user}:${tok}`).toString('base64') : '';
    const jr      = await this._http(`${base}/job/${encodeURIComponent(job)}/${bNum}/api/json`, 'GET', auth);
    if (jr.status === 0)    return `無法連線 Jenkins: ${jr.body}`;
    if (jr.status === 404)  return `找不到 Jenkins Job "${job}" 或 Build #${bNum}`;
    if (jr.status >= 400)   return `Jenkins 查詢失敗 HTTP ${jr.status}: ${jr.body.slice(0, 300)}`;
    let info = jr.body.slice(0, 2000);
    try {
      const j = JSON.parse(jr.body) as Record<string, unknown>;
      info = [`Job: ${job} #${j.number ?? bNum}`, `狀態: ${(j.result as string | null) ?? '進行中'}`, `時間: ${j.timestamp ? new Date(j.timestamp as number).toLocaleString() : 'N/A'}`, j.duration ? `耗時: ${Math.round(Number(j.duration) / 1000)}s` : '', `URL: ${j.url ?? ''}`].filter(Boolean).join('\n');
    } catch { /* use raw */ }
    if (!inclLog) return info;
    const lr = await this._http(`${base}/job/${encodeURIComponent(job)}/${bNum}/logText/progressiveText?start=0`, 'GET', auth);
    const log = lr.status === 200 ? lr.body.split('\n').slice(-logLines).join('\n').slice(0, 8000) : '(無法取得 log)';
    return `${info}\n\n=== Console Log (後 ${logLines} 行) ===\n${log}`;
  }
}
