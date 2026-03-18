import * as vscode from 'vscode';
import { OllamaChatPanel } from './ollama-chat';

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('ollama.chat', () => {
      OllamaChatPanel.createOrShow(context);
    })
  );
}

export function deactivate() {}
