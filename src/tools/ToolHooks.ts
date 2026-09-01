// Copyright (c) 2026 YCHsu. All rights reserved.
// Licensed under the MIT License.
// Tool lifecycle hooks — mirrors claude-code PreToolUse/PostToolUse/PostToolUseFailure pattern.
//
// Usage:
//   executor.registerHook(createTelemetryHook(postToWebview));
//   const unregister = executor.registerHook(myHook);
//   unregister(); // remove hook

import type { ToolExecutionContext } from './providers/IToolProvider';
import type { ToolAuditLog } from './ToolAuditLog';
import { summarizeToolArgsForAudit } from './ToolAuditLog';

// ── Core interface ────────────────────────────────────────────────────────────

/**
 * Lifecycle hooks injected around every tool dispatch.
 * All methods are optional; implement only what you need.
 */
export interface ToolHook {
  /** Human-readable name shown in diagnostics. */
  readonly hookName?: string;

  /**
   * Called BEFORE the tool executes.
   * - Return the (possibly modified) args object to proceed.
   * - Return `null` to block execution and surface a ⛔ message to the model.
   */
  beforeTool?(
    toolName: string,
    args: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): Promise<Record<string, unknown> | null> | Record<string, unknown> | null;

  /**
   * Called AFTER the tool succeeds.
   * - Return a modified result string, or `undefined` to pass through unchanged.
   * @param durationMs wall-clock time the tool took
   */
  afterTool?(
    toolName: string,
    args: Record<string, unknown>,
    result: string,
    durationMs: number,
    ctx: ToolExecutionContext,
  ): Promise<string | undefined> | string | undefined;

  /**
   * Called when the tool throws an error.
   * - Return a fallback result string to swallow the error and continue.
   * - Return `undefined` (or throw) to re-throw the original error.
   */
  onToolFailure?(
    toolName: string,
    args: Record<string, unknown>,
    error: Error,
    ctx: ToolExecutionContext,
  ): Promise<string | undefined> | string | undefined;
}

// ── Built-in hook factories ───────────────────────────────────────────────────

/**
 * Writes every tool call into ToolAuditLog.
 * Replaces the manual `recordAuditEntry` calls scattered in AgentExecutor.
 */
export function createAuditHook(
  audit: ToolAuditLog,
  getSession: () => string,
): ToolHook {
  return {
    hookName: 'audit',
    afterTool(toolName, args) {
      audit.push({ ts: Date.now(), session: getSession(), tool: toolName, argsSnippet: summarizeToolArgsForAudit(args), error: false });
      return undefined;
    },
    onToolFailure(toolName, args) {
      audit.push({ ts: Date.now(), session: getSession(), tool: toolName, argsSnippet: summarizeToolArgsForAudit(args), error: true });
      return undefined;
    },
  };
}

/** Per-tool call statistics accumulated in memory for the current session. */
export interface ToolCallStats {
  calls: number;
  errors: number;
  /** Total wall-clock ms across all successful calls. */
  totalMs: number;
  /** Count of calls that took > 5 seconds. */
  slowCount: number;
  lastCallMs: number;
}

/**
 * Accumulates per-tool call metrics and broadcasts `toolTelemetry` to the webview after
 * each call. The webview can render a heat-map or table of call frequency / latency.
 */
export function createTelemetryHook(
  postToWebview: (msg: object) => void,
): ToolHook & { getStats(): Readonly<Map<string, ToolCallStats>>; reset(): void } {
  const _stats = new Map<string, ToolCallStats>();

  const _get = (name: string): ToolCallStats =>
    _stats.get(name) ?? { calls: 0, errors: 0, totalMs: 0, slowCount: 0, lastCallMs: 0 };

  const _broadcast = () =>
    postToWebview({ type: 'toolTelemetry', stats: Object.fromEntries(_stats) });

  return {
    hookName: 'telemetry',

    afterTool(toolName, _args, _result, durationMs) {
      const s = _get(toolName);
      s.calls++;
      s.totalMs += durationMs;
      s.lastCallMs = durationMs;
      if (durationMs > 5000) { s.slowCount++; }
      _stats.set(toolName, s);
      _broadcast();
      return undefined;
    },

    onToolFailure(toolName) {
      const s = _get(toolName);
      s.errors++;
      _stats.set(toolName, s);
      _broadcast();
      return undefined;
    },

    getStats: () => _stats as Readonly<Map<string, ToolCallStats>>,
    reset: () => { _stats.clear(); _broadcast(); },
  };
}

/**
 * Logs a warning for any tool call that exceeds `thresholdMs` (default 10 s).
 * Useful for detecting hung tools or unexpectedly slow network operations.
 */
export function createSlowToolWarningHook(
  log: (msg: string) => void,
  thresholdMs = 10_000,
): ToolHook {
  return {
    hookName: 'slow-tool-warning',
    afterTool(toolName, _args, _result, durationMs) {
      if (durationMs >= thresholdMs) {
        log(`[ToolHook] ⚠️ 工具 "${toolName}" 執行耗時 ${durationMs}ms（超過 ${thresholdMs}ms 閾值）`);
      }
      return undefined;
    },
  };
}
