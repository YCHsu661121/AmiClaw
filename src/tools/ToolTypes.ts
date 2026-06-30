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
}
