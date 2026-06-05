import * as vscode from "vscode";
import { ChatViewProvider } from "./chatViewProvider";

export function activate(context: vscode.ExtensionContext): void {
  void vscode.commands.executeCommand("setContext", "cursorAgent.running", false);

  const provider = new ChatViewProvider(context.extensionUri, context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("cursorAgent.chat", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorAgent.newChat", () => provider.newChat())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorAgent.focus", () => provider.focus())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorAgent.stop", () => provider.stop())
  );
}

export function deactivate(): void {}
