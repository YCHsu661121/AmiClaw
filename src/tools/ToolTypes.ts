// Copyright (c) 2026 YCHsu. All rights reserved.
// Licensed under the MIT License.
import * as vscode from 'vscode';

export interface ToolExecutorCallbacks {
  postToWebview: (msg: object) => void;
  getExtensionContext: () => vscode.ExtensionContext;
  isWaAgentMode: () => boolean;
  log: (msg: string) => void;
  getActiveSessionId: () => string;
  handleWhatsAppTool: (name: string, args: Record<string, unknown>) => Promise<string>;
  /** AutoPilot LLM 分類器服務（未注入時略過 AutoPilot 判斷）*/
  getAutoPilotServices?: () => import('./ToolPolicies').AutoPilotClassifierServicesShim;
  /** 最近的 agent transcript（供 AutoPilot classifier 判斷 user intent）*/
  getRecentTranscript?: () => Array<{ role: 'user' | 'assistant' | 'tool'; content: string }>;
  /** 取得 SandboxManager 實例（供外部元件審核影子變更）*/
  getSandboxManager?: () => import('./SandboxManager').SandboxManager;
}
