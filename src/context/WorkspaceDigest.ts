// Copyright (c) 2026 YCHsu. All rights reserved.
// Licensed under the MIT License.

import * as path from 'path';
import * as vscode from 'vscode';

/** 工作區深度解析的層級。 */
export type ContextDepth = 'file' | 'outline' | 'full';

/** 工作區摘要 / dump 結果。 */
export interface WorkspaceDigestResult {
  /** 已格式化為 markdown，可直接附加到 system prompt。 */
  text: string;
  /** 實際納入的檔案數量。 */
  fileCount: number;
  /** UTF-8 byte 數。 */
  bytes: number;
  /** 是否因容量上限而提早截斷。 */
  truncated: boolean;
  /** 建構耗時 (ms)，用於除錯。 */
  durationMs: number;
}

/** outline / full 共用的 glob 預設值。 */
const DEFAULT_INCLUDE_GLOB =
  '**/*.{ts,tsx,js,jsx,mjs,cjs,py,cs,java,kt,go,rs,cpp,cc,cxx,c,h,hpp,inf,dec,dsc,fdf,uni,nasm,asm,asl,md,json,yaml,yml,toml,vue,svelte}';

const DEFAULT_EXCLUDE_GLOB =
  '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/.next/**,**/.turbo/**,**/.parcel-cache/**,**/__pycache__/**,**/coverage/**,**/*.min.js,**/*.min.css,**/*.map,**/*.lock,**/package-lock.json,**/yarn.lock,**/pnpm-lock.yaml,**/.vscode-test/**,**/Build/**,**/Conf/**}';

/** 視為二進位、即使副檔名匹配也跳過的檔案。 */
const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.bmp', '.svg', '.zip',
  '.tar', '.gz', '.7z', '.rar', '.exe', '.dll', '.so', '.dylib', '.wasm',
  '.pdf', '.db', '.sqlite', '.bin', '.lib', '.obj', '.pyc',
]);

/** 簡單的記憶體快取，避免每次對話都重建整個工作區摘要。 */
interface CacheEntry {
  key: string;
  result: WorkspaceDigestResult;
  ts: number;
}
let _cache: CacheEntry | null = null;
const DEFAULT_TTL_MS = 60_000; // 60 秒 TTL；外部可呼叫 invalidate() 強制重建

/** 清掉快取（例如使用者顯式重設或檢測到大量檔案變更）。 */
export function invalidateWorkspaceDigestCache(): void {
  _cache = null;
}

function makeCacheKey(opts: BuildOpts): string {
  return JSON.stringify({
    depth: opts.depth,
    inc: opts.include ?? DEFAULT_INCLUDE_GLOB,
    exc: opts.exclude ?? DEFAULT_EXCLUDE_GLOB,
    mTotal: opts.maxTotalKb ?? 0,
    topN: opts.topN ?? 0,
    lpf: opts.linesPerFile ?? 0,
  });
}

/** 並行讀檔的批次大小。 */
const READ_BATCH = 20;

/** 將 byte 數格式化為可讀字串：123 B / 45K / 1.2M / 10M */
export function fmtSize(bytes: number): string {
  if (bytes < 1024) { return `${bytes} B`; }
  const kb = bytes / 1024;
  if (kb < 1024) { return kb < 10 ? `${kb.toFixed(1)}K` : `${Math.round(kb)}K`; }
  const mb = kb / 1024;
  return mb < 10 ? `${mb.toFixed(1)}M` : `${Math.round(mb)}M`;
}

/** 將 VS Code Thenable 轉為標準 Promise，使 `.catch` 可用。 */
function asPromise<T>(t: Thenable<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => { t.then(resolve, reject); });
}

/** 安全讀取單一檔案，回傳 Buffer 或 null（二進位 / 讀取失敗均回 null）。 */
function safeRead(uri: vscode.Uri, maxBytes: number): Promise<{ rel: string; buf: Buffer } | null> {
  return asPromise(vscode.workspace.fs.readFile(uri))
    .then((raw) => {
      const b = Buffer.from(raw);
      if (b.includes(0)) { return null; }
      return { rel: vscode.workspace.asRelativePath(uri), buf: b.length > maxBytes ? b.slice(0, maxBytes) : b };
    })
    .catch(() => null);
}

/** 建構 workspace digest 的選項。 */
export interface BuildOpts {
  depth: ContextDepth;
  /** outline 模式的總容量上限 (KB)。若未指定，會依據 modelContextLength 自動計算。 */
  maxTotalKb?: number;
  /** 模型的 context window 大小（tokens）。由 QueryEngine/AgentExecutor 傳入，0 = 未知。
   *  當此値 > 0 時，會自動將 outline 限制在 context 的 25% 以內以避免溢出。 */
  modelContextLength?: number;
  /** outline 模式：列入 outline 的檔案數量上限。 */
  topN?: number;
  /** outline 模式：每個檔案擷取的前 N 行。 */
  linesPerFile?: number;
  /** include / exclude glob 覆寫。 */
  include?: string;
  exclude?: string;
  /** 是否強制跳過快取重建。 */
  bypassCache?: boolean;
  /** 進度回呼（outline 批次完成後呼叫），可用於更新 UI。 */
  onProgress?: (msg: string) => void;
}

/**
 * 建立工作區深度摘要（outline 或 full 兩種粒度）。
 * - outline：檔案樹 + 副檔名分佈 + 最大 N 個檔案的前 K 行 outline
 * - full：盡可能把所有原始碼倒進 system prompt（受容量上限保護）
 *
 * file 層級不會呼叫此函式（保留 active editor 既有行為）。
 */
export async function buildWorkspaceDigest(opts: BuildOpts): Promise<WorkspaceDigestResult> {
  const started = Date.now();
  if (opts.depth === 'file') {
    return { text: '', fileCount: 0, bytes: 0, truncated: false, durationMs: 0 };
  }

  const cacheKey = makeCacheKey(opts);
  if (!opts.bypassCache && _cache && _cache.key === cacheKey && Date.now() - _cache.ts < DEFAULT_TTL_MS) {
    return _cache.result;
  }

  const include = opts.include ?? DEFAULT_INCLUDE_GLOB;
  const exclude = opts.exclude ?? DEFAULT_EXCLUDE_GLOB;
  const uris = await vscode.workspace.findFiles(include, exclude, 4000);
  const candidates = uris.filter((u) => !BINARY_EXTS.has(path.extname(u.fsPath).toLowerCase()));
  candidates.sort((a, b) => a.fsPath.localeCompare(b.fsPath));

  const result = opts.depth === 'full'
    ? buildFullInstruction(candidates)   // 同步：不讀檔，只回傳指令
    : await buildOutline(candidates, opts);

  result.durationMs = Date.now() - started;
  _cache = { key: cacheKey, result, ts: Date.now() };
  return result;
}

/**
 * 全讀模式：不再把代碼倒進 system prompt（會溢出 context window）。
 * 改為回傳一段強制指令，讓 Agent 在第一輪就呼叫 read_workspace 工具。
 * 這是在 Ollama 有限 context window 下真正能完整讀取整個 workspace 的唯一可靠方式。
 */
function buildFullInstruction(candidates: vscode.Uri[]): WorkspaceDigestResult {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const roots = folders.map((f) => f.uri.fsPath).join(', ') || '（工作區）';
  // 列出前 100 個路徑讓模型知道有哪些檔案
  const preview = candidates.slice(0, 100)
    .map((u) => `- ${vscode.workspace.asRelativePath(u)}`).join('\n');
  const more = candidates.length > 100 ? `\n  …共 ${candidates.length} 個檔案` : '';

  const text = [
    `## 【全讀模式 (Full Analysis) 已啟用】`,
    `工作區路徑：${roots}`,
    `原始碼檔案共 **${candidates.length}** 個（符合副檔名篩選）。`,
    ``,
    `**【強制規則】** 你必須在第一輪立即呼叫 \`read_workspace\` 工具讀取整個工作區所有原始碼，`,
    `再進行任何分析、總結或回答。呼叫時可傳入 max_total_kb 與 include 參數控制範圍。`,
    `讀取完成後，根據完整內容回答使用者的問題。`,
    ``,
    `### 工作區檔案預覽（前 ${Math.min(candidates.length, 100)} 個）`,
    preview + more,
  ].join('\n');

  return { text, fileCount: candidates.length, bytes: Buffer.byteLength(text, 'utf8'), truncated: false, durationMs: 0 };
}

async function buildOutline(candidates: vscode.Uri[], opts: BuildOpts): Promise<WorkspaceDigestResult> {
  // 如果傳入 modelContextLength，自動將 outline 大小限制在 context 25% 以內
  // 估算：1 token ≈ 3~4 bytes。取保守值 3 bytes/token
  const ctxKb = (opts.modelContextLength ?? 0) > 0
    ? Math.floor((opts.modelContextLength! * 0.25 * 3) / 1024)
    : 0;
  const maxTotal = Math.max(2, opts.maxTotalKb ?? (ctxKb > 0 ? Math.min(ctxKb, 64) : 24)) * 1024;
  const topN = Math.max(1, opts.topN ?? 40);
  const linesPerFile = Math.max(5, opts.linesPerFile ?? 40);

  opts.onProgress?.(`🗂️ Outline 剖析（context=${opts.modelContextLength ? `${(opts.modelContextLength / 1024).toFixed(0)}K tokens` : '未知'}，上限 ${fmtSize(maxTotal)}）…`);

  // 計算副檔名分佈
  const extCount = new Map<string, number>();
  const rels: string[] = [];
  for (const u of candidates) {
    const rel = vscode.workspace.asRelativePath(u);
    rels.push(rel);
    const ext = path.extname(rel).toLowerCase() || '(無)';
    extCount.set(ext, (extCount.get(ext) ?? 0) + 1);
  }
  const langTable = Array.from(extCount.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([ext, n]) => `\`${ext}\`: ${n}`)
    .join(', ');

  // 平行取得 stat（抓大小用於排序）
  const statRaw = await Promise.all(
    candidates.map((u) =>
      asPromise(vscode.workspace.fs.stat(u))
        .then((s) => ({ uri: u, size: s.size }))
        .catch((): { uri: vscode.Uri; size: number } | null => null)
    )
  );
  const withSizes = statRaw.filter((x): x is { uri: vscode.Uri; size: number } => x !== null);
  withSizes.sort((a, b) => b.size - a.size);
  const top = withSizes.slice(0, topN);

  // 平行讀取 top-N 檔案的 outline
  const maxOutlineBytes = 4 * 1024;   // 單檔 outline 最多 4 KB（前 N 行）
  const readRaw = await Promise.all(top.map((item) => safeRead(item.uri, maxOutlineBytes)));

  const outlines: string[] = [];
  let outlineBytes = 0;
  for (let i = 0; i < readRaw.length; i++) {
    const r = readRaw[i];
    if (!r) { continue; }
    const { rel, buf } = r;
    const lines = buf.toString('utf8').split(/\r?\n/).slice(0, linesPerFile);
    const size = top[i].size;
    const lang = path.extname(rel).slice(1).toLowerCase();
    const entry = `### ${rel} (${fmtSize(size)}, 前 ${lines.length} 行)\n\`\`\`${lang}\n${lines.join('\n')}\n\`\`\``;
    const eb = Buffer.byteLength(entry, 'utf8');
    if (outlineBytes + eb > maxTotal) { break; }
    outlineBytes += eb;
    outlines.push(entry);
  }

  // 檔案樹（最多 250 筆，避免太長）
  const treeLimit = 250;
  const tree = rels.slice(0, treeLimit).map((r) => `- ${r}`).join('\n');
  const treeMore = rels.length > treeLimit ? `\n  …（共 ${rels.length} 個檔案，僅列出前 ${treeLimit}）` : '';

  const digest = [
    `## 工作區結構摘要 (Outline Deep Analysis)`,
    `共 ${rels.length} 個原始碼檔案。副檔名分佈：${langTable}`,
    '',
    `### 檔案清單`,
    tree + treeMore,
    '',
    `### 重要檔案 outline（依大小排序，前 ${outlines.length} 個，每檔前 ${linesPerFile} 行）`,
    outlines.join('\n\n'),
    '',
    `💡 如需完整內容請呼叫 read_file / read_files / read_workspace 工具。`,
  ].join('\n');

  return {
    text: digest,
    fileCount: rels.length,
    bytes: Buffer.byteLength(digest, 'utf8'),
    truncated: false,
    durationMs: 0,
  };
}

/** 從 VS Code 設定讀目前的深度層級。 */
export function getCurrentContextDepth(): ContextDepth {
  const v = vscode.workspace.getConfiguration('amiAiClaw').get<string>('contextDepth', 'file');
  return v === 'outline' || v === 'full' ? v : 'file';
}
