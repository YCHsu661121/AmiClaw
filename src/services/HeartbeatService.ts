// Copyright (c) 2026 YCHsu. All rights rights reserved.
// Licensed under the MIT License.
import * as vscode from 'vscode';

/** Represents a simple interface for a panel that can receive webview messages. */
export interface IWebviewPanel {
  webview: vscode.Webview;
}

/** Agent 執行中的即時狀態，隨心跳廣播給 webview 並供 WA 回報使用。 */
export interface AgentHeartbeatInfo {
  running: boolean;
  step: number;
  model: string;
  shadowRunning: boolean;
  shadowCount: number;
  lastActivity: string;
  startedAt: number; // ms epoch
}

const DEFAULT_AGENT_INFO: AgentHeartbeatInfo = {
  running: false, step: 0, model: '', shadowRunning: false,
  shadowCount: 0, lastActivity: '', startedAt: 0,
};

/**
 * HeartbeatService: A singleton service that provides a periodic pulse (5s).
 * It allows modules to subscribe to tick events and broadcasts the heartbeat to the Webview UI.
 */
export class HeartbeatService implements vscode.Disposable {
  private static _instance: HeartbeatService | undefined;
  private _intervalId: NodeJS.Timeout | undefined;
  private _subscribers: Set<() => void> = new Set();
  private _disposables: vscode.Disposable[] = [];
  private _agentInfo: AgentHeartbeatInfo = { ...DEFAULT_AGENT_INFO };

  private constructor() {}

  /** Returns the singleton instance of HeartbeatService. */
  public static getInstance(): HeartbeatService {
    if (!HeartbeatService._instance) {
      HeartbeatService._instance = new HeartbeatService();
    }
    return HeartbeatService._instance;
  }

  /** Update agent execution status; called by AgentExecutor at key points. */
  public setAgentInfo(info: Partial<AgentHeartbeatInfo>): void {
    this._agentInfo = { ...this._agentInfo, ...info };
  }

  public getAgentInfo(): Readonly<AgentHeartbeatInfo> { return this._agentInfo; }

  /**
   * Starts the heartbeat timer if it's not already running.
   * Period: 5000ms (5 seconds).
   */
  public start(): void {
    if (this._intervalId) return;

    this._intervalId = setInterval(() => {
      this._subscribers.forEach((callback) => {
        try {
          callback();
        } catch (err) {
          console.error('[HeartbeatService] Subscriber error:', err);
        }
      });
    }, 5000);
  }

  /** Stops the heartbeat timer. */
  public stop(): void {
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = undefined;
    }
  }

  /**
   * Registers a callback to be executed on every heartbeat tick.
   * @param callback The function to run.
   * @returns A disposable that, when disposed, removes the subscription.
   */
  public onTick(callback: () => void): vscode.Disposable {
    this._subscribers.add(callback);
    const disposable = { dispose: () => { this._subscribers.delete(callback); } };
    this._disposables.push(disposable);
    return disposable;
  }

  /** Broadcasts a heartbeat signal (including agent status) to the provided Webview panel. */
  public broadcastToWebview(panel: IWebviewPanel): void {
    const info = this._agentInfo;
    panel.webview.postMessage({
      type: 'heartbeat-tick',
      agentRunning: info.running,
      agentStep: info.step,
      agentModel: info.model,
      shadowRunning: info.shadowRunning,
      shadowCount: info.shadowCount,
      lastActivity: info.lastActivity,
      elapsedMs: info.running && info.startedAt ? Date.now() - info.startedAt : 0,
    });
  }

  /** Cleans up subscriptions but keeps the interval running (singleton, never truly stopped). */
  public dispose(): void {
    this._agentInfo = { ...DEFAULT_AGENT_INFO };
    this._disposables.forEach((d) => d.dispose());
    this._subscribers.clear();
    this._disposables = [];
  }
}
