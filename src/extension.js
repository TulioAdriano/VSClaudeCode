"use strict";

const vscode = require("vscode");
const { ChatViewProvider } = require("./chatViewProvider");

function activate(context) {
  const output = vscode.window.createOutputChannel("VSClaudeCode");
  const provider = new ChatViewProvider(context, output);

  context.subscriptions.push(
    output,
    provider,
    vscode.window.registerWebviewViewProvider("vsclaudecode.chat", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("vsclaudecode.open", () =>
      vscode.commands.executeCommand("vsclaudecode.chat.focus")),
    vscode.commands.registerCommand("vsclaudecode.newConversation", async () => {
      await vscode.commands.executeCommand("vsclaudecode.chat.focus");
      provider.requestNewSession();
    }),
    vscode.commands.registerCommand("vsclaudecode.insertSelection", async () => {
      await vscode.commands.executeCommand("vsclaudecode.chat.focus");
      provider.insertSelectionMention();
    })
  );

  // Test hook: auto-open the panel when driven by the smoke harness.
  if (process.env.VSCLAUDE_AUTO_OPEN === "1")
    vscode.commands.executeCommand("vsclaudecode.chat.focus");
}

function deactivate() { }

module.exports = { activate, deactivate };
