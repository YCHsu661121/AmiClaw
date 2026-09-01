// Copyright (c) 2026 YCHsu. All rights reserved.
// Licensed under the MIT License.
import * as vscode from 'vscode';
import * as path from 'path';
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
import { LspProvider } from './providers/LspProvider';
import { BackgroundProvider } from './providers/BackgroundProvider';
import { ComputerUseProvider } from './providers/ComputerUseProvider';
import { SandboxManager, SHADOW_WRITE_TOOLS } from './SandboxManager';

// 對外保留型別重新匯出，避免改動 consumer
export type { AuditEntry } from './ToolAuditLog';
export type { ToolPermissionDiff } from './ToolPolicies';
export type { ToolExecutorCallbacks } from './ToolTypes';

export class ToolExecutor {
  private _cache = new ToolCache(30_000);
  private _audit: ToolAuditLog;
  private _policy: ToolPolicies;
  // Tracks mtime at last read — used to detect external modifications before write
  private _fileReadTimes = new Map<string, number>();

  // Provider registry: 各 domain 工具逐步遷入， dispatch map 由工具名對映 provider
  private _providerMap = new Map<string, IToolProvider>();
  private _vscodeProvider = new VscodeProvider();
  private _sandbox: SandboxManager;

  public constructor(private readonly _callbacks: ToolExecutorCallbacks) {
    this._audit = new ToolAuditLog(this._callbacks.getExtensionContext());
    this._sandbox = new SandboxManager(this._callbacks.postToWebview, this._callbacks.log);
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
      new LspProvider(),
      new BackgroundProvider(),
      new ComputerUseProvider(),
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

  /** 影子工作區管理器（永遠只有一個實例，由 ToolExecutor 持有） */
  public getSandboxManager(): SandboxManager {
    return this._sandbox;
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

    // Shadow 路由分流：若 args.mode==='shadow' 或影子模式已啟動，將寫入類工具導入暗存區
    const _isShadowCall = (args as Record<string,unknown>)['mode'] === 'shadow';
    const _isSandboxActive = this._sandbox.isActive();
    if ((_isShadowCall || _isSandboxActive) && SHADOW_WRITE_TOOLS.has(name)) {
      if (!this._sandbox.isActive()) {
        this._sandbox.initShadow(Date.now().toString(36));
      }
      const shadowArgs = this._sandbox.remapArgs(name, args);
      const provider = this._providerMap.get(name);
      if (provider) {
        const ctx: ToolExecutionContext = {
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
        return provider.execute(name, shadowArgs, ctx);
      }
    }
    // 影子號令： sandbox_init / sandbox_verify / sandbox_commit / sandbox_rollback
    if (name === 'sandbox_init') { this._sandbox.initShadow(args.session_id as string || Date.now().toString(36)); return '✅ 影子工作區已初始化，後續寫入類操作將進入暫存區等待審核'; }
    if (name === 'sandbox_verify') { const r = await this._sandbox.verify(); return r.output || (r.passed ? '✅ 驗證通過' : '❌ 驗證失敗'); }
    if (name === 'sandbox_commit') { const files = await this._sandbox.commit(); return `✅ 已提交 ${files.length} 個檔案至實際工作區\n${files.join('\n')}`; }
    if (name === 'sandbox_rollback') { this._sandbox.rollback(); return '🗑️ 已回滚影子工作區，真實工作區未改動。'; }
    if (name === 'sandbox_status') { const s = this._sandbox.getState(); return JSON.stringify({ status: s.status, files: s.files.length, shadowDir: s.shadowDir, verifyPassed: s.verifyPassed }, null, 2); }

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


    // All tools dispatch via _providerMap; this path means no provider registered for the tool.
    return `\u274c \u672a\u77e5\u5de5\u5177\u300c${name}\u300d\uff0c\u8acb\u8a8d\u8b49\u5de5\u5177\u540d\u7a31\u6216\u5148\u547c\u53eb search_tools \u67e5\u8a62\u53ef\u7528\u5de5\u5177\u3002`;
  }
}
