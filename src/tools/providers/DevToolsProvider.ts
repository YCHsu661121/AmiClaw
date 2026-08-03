// Copyright (c) 2026 YCHsu. All rights reserved.
// Licensed under the MIT License.

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import type { IToolProvider, ToolExecutionContext } from './IToolProvider';

const TOOLS = new Set(['lint_fix','run_tests','generate_docs','refactor_suggest','organize_photos','db_query','agent_run_tool']);

export class DevToolsProvider implements IToolProvider {
  readonly tools: ReadonlySet<string> = TOOLS;

  execute(name: string, args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
    switch (name) {
      case 'lint_fix':       return this._lintFix(args, ctx);
      case 'run_tests':      return this._runTests(args, ctx);
      case 'generate_docs':  return this._generateDocs(args, ctx);
      case 'refactor_suggest': return this._refactorSuggest(args, ctx);
      case 'organize_photos':  return this._organizePhotos(args, ctx);
      case 'db_query':         return this._dbQuery(args, ctx);
      case 'agent_run_tool':   return this._agentRunTool(args, ctx);
      default: return Promise.resolve(`DevToolsProvider: unknown tool "${name}"`);
    }
  }

  // ── lint_fix ──────────────────────────────────────────────────────────────────
  private async _lintFix(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
    const fixPath = ctx.resolvePath((args.path as string) || '.');
    const tool = (args.tool as string) || 'both';
    if (!await ctx.requestPermission('run', `程式碼格式化: ${fixPath} (${tool})`, 'lint_fix')) return '使用者已拒絕程式碼格式化操作';
    const cwd = ctx.folders[0]?.uri.fsPath ?? process.cwd();
    const run = (cmd: string) => new Promise<string>(res => {
      (require('child_process') as typeof import('child_process')).exec(cmd, { cwd, timeout: 30000 }, (_e, o, e) => res(((o||'')+(e?'\n[stderr]\n'+e:'')).trim()||'(無輸出)'));
    });
    const results: string[] = [];
    if (tool === 'eslint' || tool === 'both')   results.push('[ESLint] '   + await run(`npx eslint --fix "${fixPath}"`));
    if (tool === 'prettier' || tool === 'both') results.push('[Prettier] ' + await run(`npx prettier --write "${fixPath}"`));
    return results.join('\n\n') || '(無輸出)';
  }

  // ── run_tests ─────────────────────────────────────────────────────────────────
  private async _runTests(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
    const filter = (args.filter as string) || '';
    const dir = (args.path as string) ? ctx.resolvePath(args.path as string) : (ctx.folders[0]?.uri.fsPath ?? process.cwd());
    if (!await ctx.requestPermission('run', `執行測試${filter?': '+filter:''}`, 'run_tests')) return '使用者已拒絕執行測試';
    let runner = 'npx jest --passWithNoTests';
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(ctx.folders[0]?.uri.fsPath ?? process.cwd(), 'package.json'), 'utf-8')) as { dependencies?: Record<string,string>; devDependencies?: Record<string,string>; scripts?: Record<string,string> };
      const deps = { ...pkg.dependencies, ...pkg.devDependencies }; const scripts = pkg.scripts ?? {};
      if (deps['vitest'] || Object.values(scripts).some(s => s.includes('vitest'))) runner = 'npx vitest run';
      else if (deps['mocha']) runner = 'npx mocha';
      else if (deps['pytest'] || deps['py.test']) runner = 'python -m pytest -v';
    } catch { /* use default */ }
    const filterFlag = filter ? (runner.includes('vitest')||runner.includes('jest') ? ` -t "${filter}"` : runner.includes('pytest') ? ` -k "${filter}"` : '') : '';
    return new Promise<string>(res => {
      (require('child_process') as typeof import('child_process')).exec((runner+filterFlag).trim(), { cwd: dir, timeout: 60000 }, (_e, o, e) => res(((o||'')+(e?'\n[stderr]\n'+e:'')).trim().slice(0,10000)||'(無輸出)'));
    });
  }

  // ── generate_docs ─────────────────────────────────────────────────────────────
  private async _generateDocs(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
    const docPath = (args.path as string) ? ctx.resolvePath(args.path as string) : (ctx.folders[0]?.uri.fsPath ?? process.cwd());
    const tool = (args.tool as string) || 'auto'; const output = (args.output as string) || 'docs';
    const cwd = ctx.folders[0]?.uri.fsPath ?? process.cwd();
    if (!await ctx.requestPermission('run', `產生 API 文件: ${docPath} (${tool})`, 'generate_docs')) return '使用者已拒絕文件產生操作';
    let actualTool = tool;
    if (actualTool === 'auto') {
      try { const pkg = JSON.parse(fs.readFileSync(path.join(cwd,'package.json'),'utf-8')) as { dependencies?: Record<string,string>; devDependencies?: Record<string,string> }; const deps={...pkg.dependencies,...pkg.devDependencies}; actualTool = deps['typedoc']?'typedoc':deps['jsdoc']?'jsdoc':(fs.existsSync(path.join(cwd,'typedoc.json'))||fs.existsSync(path.join(cwd,'typedoc.config.js')))?'typedoc':(fs.existsSync(path.join(cwd,'.jsdocrc'))||fs.existsSync(path.join(cwd,'.jsdocrc.js')))?'jsdoc':'typedoc'; }
      catch { actualTool = 'typedoc'; }
    }
    const cmd = actualTool==='jsdoc' ? `npx jsdoc -d "${output}" -r "${docPath}"` : `npx typedoc --out "${output}" "${docPath}"`;
    return new Promise<string>(res => {
      (require('child_process') as typeof import('child_process')).exec(cmd, { cwd, timeout: 60000 }, (_e, o, e) => {
        const out = ((o||'')+(e?'\n[stderr]\n'+e:'')).trim();
        const outDir = path.join(cwd, output);
        res((out.slice(0,8000)||'(無輸出)') + (fs.existsSync(outDir)?`\n\n✅ 文件已產生至: ${outDir}`:''));
      });
    });
  }

  // ── refactor_suggest ──────────────────────────────────────────────────────────
  private async _refactorSuggest(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
    const filePath = ctx.resolvePath(args.path as string);
    const focus = (args.focus as string) || 'all';
    if (!await ctx.requestPermission('read', `讀取並分析: ${filePath}`, 'refactor_suggest')) return '使用者已拒絕程式碼分析';
    let content: string;
    try { const s = fs.statSync(filePath); if (s.size > 500*1024) return '檔案超過 500KB，無法一次分析'; content = fs.readFileSync(filePath,'utf-8'); }
    catch(e) { return `讀取檔案失敗: ${e instanceof Error?e.message:String(e)}`; }
    const cwd = ctx.folders[0]?.uri.fsPath ?? process.cwd();
    const tmpCfg = path.join(os.tmpdir(), `ami_eslint_rs_${Date.now()}.json`);
    fs.writeFileSync(tmpCfg, JSON.stringify({ env:{browser:true,es2020:true,node:true}, rules:{complexity:['warn',10],'max-lines-per-function':['warn',60],'max-depth':['warn',4],'max-params':['warn',5]} }), 'utf-8');
    let eslintOut = '(跳過 ESLint 分析)';
    try {
      eslintOut = await new Promise<string>(res => {
        (require('child_process') as typeof import('child_process')).exec(`npx eslint --no-eslintrc -c "${tmpCfg}" --format compact "${filePath}"`, { cwd, timeout: 20000 }, (_e, o, e) => res(((o||'')+(e&&!o?'\n'+e:'')).trim().slice(0,3000)||'✅ 無複雜度警告'));
      });
    } finally { try { fs.unlinkSync(tmpCfg); } catch { /* ignore */ } }
    const lines = content.split('\n');
    return [`=== 重構分析: ${filePath} ===`, `行數: ${lines.length} | 字元數: ${content.length}${focus!=='all'?`\n分析重點: ${focus}`:''}`, '', '--- ESLint 複雜度/品質警告 ---', eslintOut, '', '--- 原始碼（含行號，供 AI 標記問題位置）---', lines.slice(0,500).map((l,i)=>`${String(i+1).padStart(4)}: ${l}`).join('\n'), lines.length>500?`\n...[省略 ${lines.length-500} 行，請用 read_file 取得剩餘內容]`:'' ].join('\n').slice(0,20000);
  }

  // ── db_query ──────────────────────────────────────────────────────────────────
  private async _dbQuery(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
    const dbPath = ctx.resolvePath(args.db_path as string);
    const query = (args.query as string || '').trim(); if (!query) return '請提供 query 參數';
    const params = args.params ? JSON.stringify(args.params) : '[]';
    if (/^\s*(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|ATTACH|DETACH)/i.test(query)) {
      if (!await ctx.requestPermission('run', `SQLite 寫入: ${query.slice(0,80)}`, 'db_query')) return '使用者已拒絕資料庫寫入操作';
    }
    const pyCode = `import sqlite3, json, sys\ndb_path = ${JSON.stringify(dbPath)}\nquery = ${JSON.stringify(query)}\nparams = json.loads(${JSON.stringify(params)})\ntry:\n    conn = sqlite3.connect(db_path)\n    conn.row_factory = sqlite3.Row\n    cur = conn.cursor()\n    cur.execute(query, params)\n    if cur.description:\n        cols = [d[0] for d in cur.description]\n        rows = [list(r) for r in cur.fetchmany(200)]\n        col_widths = [max(len(str(c)), max((len(str(r[i])) for r in rows), default=0)) for i, c in enumerate(cols)]\n        sep = '+' + '+'.join('-'*(w+2) for w in col_widths) + '+'\n        header = '|' + '|'.join(f' {c:<{w}} ' for c, w in zip(cols, col_widths)) + '|'\n        print(sep); print(header); print(sep)\n        for row in rows: print('|' + '|'.join(f' {str(v):<{w}} ' for v, w in zip(row, col_widths)) + '|')\n        print(sep)\n        print(f'({len(rows)} rows)')\n    else:\n        conn.commit()\n        print(f'OK, affected rows: {cur.rowcount}')\n    conn.close()\nexcept Exception as e:\n    print(f'Error: {e}', file=sys.stderr)\n`;
    const tmp = path.join(os.tmpdir(), `ami_db_${Date.now()}.py`);
    try {
      fs.writeFileSync(tmp, pyCode, 'utf-8');
      return await new Promise<string>(res => {
        const cmds = process.platform==='win32' ? ['py','python','python3'] : ['python3','python'];
        let tried = 0;
        const tryNext = () => {
          if (tried >= cmds.length) { res('錯誤：找不到 Python，無法執行 SQLite 查詢'); return; }
          const c = cmds[tried++];
          (require('child_process') as typeof import('child_process')).exec(`${c} "${tmp}"`, { cwd: ctx.wsRoot||process.cwd(), timeout: 30000 }, (_e, o, e) => {
            if (_e && (_e as NodeJS.ErrnoException).code==='ENOENT') { tryNext(); return; }
            res(((o||'')+(e?(o?'\n[stderr]\n':'[stderr]\n')+e:'')).trim().slice(0,8000)||'（無輸出）');
          });
        };
        tryNext();
      });
    } finally { try { fs.unlinkSync(tmp); } catch { /* ignore */ } }
  }

  // ── organize_photos ───────────────────────────────────────────────────────────
  private async _organizePhotos(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
    const srcDirRaw = (args.source_dir as string||'').trim(); if (!srcDirRaw) return '請提供 source_dir（要掃描的照片目錄）';
    const srcDir = ctx.resolvePath(srcDirRaw);
    try { if (!fs.statSync(srcDir).isDirectory()) return `錯誤：source_dir 不是目錄：${srcDir}`; } catch { return `錯誤：找不到照片目錄 ${srcDir}`; }
    const refRaw = (args.reference_image as string||'').trim();
    let refB64 = '', personName = '';
    if (refRaw) {
      const refPath = await ctx.resolvePathSmart(refRaw);
      if (!fs.existsSync(refPath)) return `錯誤：找不到參考照片 ${refPath}`;
      try { refB64 = fs.readFileSync(refPath).toString('base64'); } catch(e) { return `錯誤：無法讀取參考照片：${e instanceof Error?e.message:String(e)}`; }
      personName = DevToolsProvider._sanitizeSeg((args.person_name as string) || path.basename(refPath, path.extname(refPath)), '指定人物');
    }
    const cfg = vscode.workspace.getConfiguration('amiAiClaw');
    const visionModel = ((args.vision_model as string)||cfg.get<string>('visionModel')||'').trim();
    if (!visionModel) return '請提供 vision_model 參數，或在設定 amiAiClaw.visionModel 指定 Ollama 視覺模型。';
    const ollamaUrl = DevToolsProvider._getOllamaUrls()[0];
    const outRaw = (args.output_dir as string||'').trim();
    const outDir = outRaw ? ctx.resolvePath(outRaw) : path.join(srcDir, '_organized');
    const behaviors = Array.isArray(args.behaviors) ? (args.behaviors as unknown[]).map(String).map(s=>s.trim()).filter(Boolean) : [];
    const moveMode = (args.mode as string)==='move';
    const minConf = typeof args.min_confidence==='number' ? args.min_confidence as number : 60;
    const maxImages = Math.min(typeof args.max_images==='number' ? args.max_images as number : 200, 1000);
    const outNorm = path.resolve(outDir).toLowerCase();
    const images = DevToolsProvider._collectImages(srcDir, maxImages+100).filter(p => !path.resolve(p).toLowerCase().startsWith(outNorm)).slice(0, maxImages);
    if (images.length === 0) return `在 ${srcDir} 找不到任何影像檔`;
    if (!await ctx.requestPermission('write', `整理照片：${images.length} 張 ${moveMode?'移動':'複製'} 至 ${outDir}${refRaw?`（比對人物：${personName}）`:'（依行為分類）'}`, 'organize_photos')) return '使用者已拒絕整理照片';
    fs.mkdirSync(outDir, { recursive: true });
    const behaviorInst = behaviors.length > 0 ? `行為標籤請務必從以下選項擇一（皆不符合時用「其他」）：${behaviors.join('、')}。` : '行為標籤用 2~6 個字的簡短中文描述（例如：用餐、戶外、運動、工作、合照、自拍、室內）。';
    let scanned=0, matched=0, errors=0;
    const perBehavior = new Map<string,number>(); const failSamples: string[] = [];
    for (const imgPath of images) {
      scanned++;
      let candB64: string; try { candB64 = fs.readFileSync(imgPath).toString('base64'); } catch { errors++; continue; }
      const prompt = refB64
        ? `你是照片辨識助手。第一張圖是「參考人物」的臉部照片，第二張圖是一張待辨識的照片。請完成兩件事，並「只」回傳 JSON（不要任何多餘文字或 markdown）：1. 判斷第二張照片中是否出現與第一張相同的人物（同一個人）。2. 若有出現，判斷該人物在照片中的行為或場景。${behaviorInst}\n回傳格式：{"match": true 或 false, "confidence": 0到100的整數, "behavior": "標籤", "reason": "一句話原因"}`
        : `你是照片辨識助手。請判斷這張照片的主要行為或場景，並「只」回傳 JSON（不要任何多餘文字或 markdown）。${behaviorInst}\n回傳格式：{"match": true, "confidence": 100, "behavior": "標籤", "reason": "一句話原因"}`;
      let resp: string;
      try { resp = await DevToolsProvider._visionChat(ollamaUrl, visionModel, prompt, refB64 ? [refB64, candB64] : [candB64], 90000); }
      catch(e) { errors++; const em = e instanceof Error?e.message:String(e); if (failSamples.length<3) failSamples.push(`${path.basename(imgPath)}: ${em}`); ctx.callbacks.log(`organize_photos: ${path.basename(imgPath)} 推論失敗 — ${em}`); if (scanned===1 && /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|逾時|URL 無效/.test(em)) return `無法連線 Ollama 視覺模型（${ollamaUrl}，模型 ${visionModel}）：${em}\n請確認 Ollama 正在執行，且已 ollama pull 該視覺模型。`; continue; }
      const parsed = DevToolsProvider._extractJson(resp);
      if (!parsed) { errors++; ctx.callbacks.log(`organize_photos: ${path.basename(imgPath)} 回應非 JSON：${resp.slice(0,120)}`); continue; }
      const isMatch = parsed.match===true||parsed.match===1||/^(true|yes|y|是|有|same)$/i.test(String(parsed.match??'').trim());
      let conf = typeof parsed.confidence==='number' ? parsed.confidence : parseInt(String(parsed.confidence??''),10);
      if (!Number.isFinite(conf)) conf = isMatch?80:0;
      if (refB64 && (!isMatch||conf<minConf)) { ctx.callbacks.log(`organize_photos: ${path.basename(imgPath)} 不符合（match=${isMatch} conf=${conf}）`); continue; }
      const behavior = DevToolsProvider._sanitizeSeg(String(parsed.behavior??'未分類'),'未分類');
      const destDir = refB64 ? path.join(outDir,personName,behavior) : path.join(outDir,behavior);
      fs.mkdirSync(destDir,{recursive:true});
      let destPath = path.join(destDir,path.basename(imgPath));
      if (fs.existsSync(destPath)) { const ext=path.extname(imgPath); destPath=path.join(destDir,`${path.basename(imgPath,ext)}_${Date.now().toString(36)}${ext}`); }
      try {
        if (moveMode) { try { fs.renameSync(imgPath,destPath); } catch { fs.copyFileSync(imgPath,destPath); fs.unlinkSync(imgPath); } }
        else fs.copyFileSync(imgPath,destPath);
        matched++; perBehavior.set(behavior,(perBehavior.get(behavior)??0)+1);
        ctx.callbacks.log(`organize_photos: ✓ ${path.basename(imgPath)} → ${path.relative(outDir,destPath)} (conf=${conf})`);
      } catch(e) { errors++; if (failSamples.length<3) failSamples.push(`${path.basename(imgPath)}: ${e instanceof Error?e.message:String(e)}`); }
    }
    const behaviorSummary = [...perBehavior.entries()].sort((a,b)=>b[1]-a[1]).map(([b,n])=>`  • ${b}: ${n} 張`).join('\n');
    return [`✅ 照片整理完成 (${moveMode?'移動':'複製'} 模式)`, `掃描: ${scanned} 張  |  符合: ${matched} 張  |  錯誤: ${errors} 張`, `輸出目錄: ${outDir}`, behaviorSummary ? `\n行為分類：\n${behaviorSummary}` : '', failSamples.length ? `\n部分錯誤：\n${failSamples.map(s=>'  - '+s).join('\n')}` : ''].filter(Boolean).join('\n');
  }

  // ── agent_run_tool ────────────────────────────────────────────────────────────
  private _agentRunTool(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
    const target = (args.name ?? args.tool_name ?? args.target) as string | undefined;
    if (!target) return Promise.resolve('請提供 name 參數。正確格式：{"name":"<工具名稱>","args":{...工具參數...}}');
    if (target === 'agent_run_tool' || target === 'agent:run_tool') return Promise.resolve('錯誤：agent_run_tool 不能遞迴呼叫自身');
    const rawArgs = (typeof args.args==='object'&&args.args!==null?args.args : typeof args.tool_args==='object'&&args.tool_args!==null?args.tool_args : typeof args.parameters==='object'&&args.parameters!==null?args.parameters : typeof args.input==='object'&&args.input!==null?args.input : {}) as Record<string,unknown>;
    return ctx.executeTool(target, rawArgs);
  }

  // ── static helpers ────────────────────────────────────────────────────────────
  private static _getOllamaUrls(): string[] {
    const cfg = vscode.workspace.getConfiguration('amiAiClaw');
    const arr = (cfg.get<string[]>('urls') ?? []).filter(u => u.trim());
    if (arr.length > 0) { const cnt = new Map<string,number>(); for (const u of arr) cnt.set(u,(cnt.get(u)??0)+1); const en = arr.filter(u=>cnt.get(u)===1); if (en.length>0) return en; }
    return [cfg.get<string>('url') ?? 'http://localhost:11434'];
  }

  private static _collectImages(rootDir: string, limit: number): string[] {
    const exts = new Set(['.jpg','.jpeg','.png','.webp','.bmp','.gif']); const out: string[] = [];
    const walk = (dir: string) => { if (out.length>=limit) return; let entries: import('fs').Dirent[]; try { entries=fs.readdirSync(dir,{withFileTypes:true}); } catch { return; } for (const e of entries) { if (out.length>=limit) return; const full=path.join(dir,e.name); if (e.isDirectory()) { if (e.name.startsWith('.')||e.name==='node_modules') continue; walk(full); } else if (exts.has(path.extname(e.name).toLowerCase())) out.push(full); } };
    walk(rootDir); return out;
  }

  private static _sanitizeSeg(name: string, fallback: string): string {
    return (name||'').replace(/[\\/:*?"<>|\r\n\t]/g,'').replace(/\s+/g,' ').trim().slice(0,40) || fallback;
  }

  private static _visionChat(baseUrl: string, model: string, prompt: string, imagesB64: string[], timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      let url: URL; try { url = new URL('/api/chat', baseUrl); } catch { reject(new Error(`Ollama URL 無效: ${baseUrl}`)); return; }
      const proto = url.protocol==='https:' ? https : http;
      const buf = Buffer.from(JSON.stringify({ model, messages:[{role:'user',content:prompt,images:imagesB64}], stream:false, options:{temperature:0} }), 'utf8');
      const opts = { hostname:url.hostname, port:url.port?parseInt(url.port,10):(url.protocol==='https:'?443:11434), path:url.pathname, method:'POST', headers:{'Content-Type':'application/json','Content-Length':buf.length} };
      const req = proto.request(opts, res => {
        let data=''; res.setEncoding('utf8');
        res.on('data',(d:string)=>{data+=d;});
        res.on('end',()=>{ try { const j=JSON.parse(data) as {message?:{content?:string};error?:string}; if (j.error) reject(new Error(j.error)); else resolve((j.message?.content??'').trim()); } catch { reject(new Error(`回應解析失敗: ${data.slice(0,200)}`)); } });
      });
      req.on('error',(e:Error)=>reject(e));
      req.setTimeout(timeoutMs,()=>{ req.destroy(); reject(new Error(`Ollama 視覺推論逾時 (${timeoutMs}ms)`)); });
      req.write(buf); req.end();
    });
  }

  private static _extractJson(text: string): Record<string,unknown>|null {
    if (!text) return null;
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1] : text;
    const m = candidate.match(/\{[\s\S]*\}/);
    if (!m) return null; try { return JSON.parse(m[0]) as Record<string,unknown>; } catch { return null; }
  }
}
