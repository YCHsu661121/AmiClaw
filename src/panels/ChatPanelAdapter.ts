// Copyright (c) 2026 YCHsu. All rights reserved.
// Licensed under the MIT License.
import * as vscode from 'vscode';

/**
 * Webview Panel 與 WebviewView 的共同介面，讓 OllamaChatPanel 可以同時運作於
 *  - 浮動 Panel（vscode.window.createWebviewPanel）
 *  - 固定側邊欄 View（registerWebviewViewProvider）
 */
export interface PanelLike {
  readonly webview: vscode.Webview;
  readonly onDidDispose: vscode.Event<void>;
  dispose(): void;
  reveal?(col?: vscode.ViewColumn, preserveFocus?: boolean): void;
}

/** WebviewView（固定側邊欄）→ PanelLike 轉接器 */
export class WebviewViewAdapter implements PanelLike {
  public readonly webview: vscode.Webview;
  public readonly onDidDispose: vscode.Event<void>;

  public constructor(private readonly _view: vscode.WebviewView) {
    this.webview = _view.webview;
    this.onDidDispose = _view.onDidDispose;
  }

  public dispose(): void {
    /* WebviewView 不可被程式碼 dispose */
  }

  public reveal(_col?: vscode.ViewColumn, preserveFocus?: boolean): void {
    this._view.show(!preserveFocus);
  }
}
