// Hosts the shared VSClaude web UI in a VS Code webview view and bridges it to
// the ChatController. The webui folder is byte-compatible with the VS 2026
// extension's — vscode-bridge.js adapts the transport, CSS vars adapt the theme.
"use strict";

const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
const { ChatController } = require("./chatController");

class ChatViewProvider {
  constructor(context, output) {
    this._context = context;
    this._output = output;
    this._view = null;
    this._controller = null;
  }

  resolveWebviewView(view) {
    this._view = view;
    const webuiRoot = vscode.Uri.file(path.join(this._context.extensionPath, "webui"));

    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [webuiRoot],
    };
    view.webview.html = this._buildHtml(view.webview, webuiRoot);

    if (this._controller) this._controller.dispose();
    this._controller = new ChatController((obj) => {
      // postMessage silently drops when the view is disposed; that's fine.
      try { view.webview.postMessage(obj); } catch { }
    }, this._output);

    view.webview.onDidReceiveMessage((msg) => {
      this._controller.handleWebMessage(msg);
    });
    view.onDidDispose(() => {
      if (this._controller) { this._controller.dispose(); this._controller = null; }
      this._view = null;
    });
  }

  _buildHtml(webview, webuiRoot) {
    const htmlPath = path.join(webuiRoot.fsPath, "index.html");
    let html = fs.readFileSync(htmlPath, "utf8");
    const baseUri = webview.asWebviewUri(webuiRoot).toString();
    const csp =
      "default-src 'none'; " +
      `img-src ${webview.cspSource} data:; ` +
      `style-src ${webview.cspSource} 'unsafe-inline'; ` +
      `script-src ${webview.cspSource}; ` +
      `font-src ${webview.cspSource};`;
    // <base> makes the webui's relative asset paths resolve inside the webview,
    // so index.html stays byte-shareable with the VS 2026 extension.
    html = html.replace(
      "<head>",
      `<head>\n<meta http-equiv="Content-Security-Policy" content="${csp}" />\n<base href="${baseUri}/" />`
    );
    return html;
  }

  requestNewSession() {
    if (this._controller) this._controller.startSession(null, null);
  }

  insertSelectionMention() {
    if (this._controller) this._controller.insertActiveSelectionMention();
  }

  dispose() {
    if (this._controller) { this._controller.dispose(); this._controller = null; }
  }
}

module.exports = { ChatViewProvider };
