import * as vscode from 'vscode';
import { OllamaChatPanel } from './ollama-chat';

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('amiClaw.chat', () => {
      OllamaChatPanel.createOrShow(context);
    })
  );

  // Right-click on file/folder in Explorer or Editor → send to chat
  context.subscriptions.push(
    vscode.commands.registerCommand('amiClaw.sendToChat', async (uri: vscode.Uri, allUris?: vscode.Uri[]) => {
      OllamaChatPanel.createOrShow(context);
      const uris = allUris && allUris.length > 0 ? allUris : (uri ? [uri] : []);
      if (uris.length > 0) {
        await OllamaChatPanel.sendUrisToChat(uris);
      }
    })
  );
}

export function deactivate() {}
