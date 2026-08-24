// Port of VSClaude.Core's SdkIdeMcpServer + IdeToolExecutor + IdeTools: the
// in-process "ide" MCP server the CLI reaches via control_request mcp_message
// (declared with --mcp-config type:"sdk", activated by initialize
// sdkMcpServers:["ide"]). Tool names/schemas/result shapes match the C#.
// The IDE host is injected so tests can drive the server without VS Code.
"use strict";

const path = require("path");
const { pathToFileURL } = require("url");

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

function selectionJson(sel) {
  return {
    success: true,
    text: sel.text || "",
    filePath: sel.filePath || null,
    fileUrl: sel.filePath ? pathToFileURL(sel.filePath).href : null,
    selection: {
      start: { line: sel.startLine, character: sel.startCharacter },
      end: { line: sel.endLine, character: sel.endCharacter },
      isEmpty: sel.isEmpty,
    },
  };
}

function describeTools() {
  const tool = (name, description, properties, required = []) => ({
    name, description,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
  });
  const str = (d) => ({ type: "string", description: d });
  const bool = (d) => ({ type: "boolean", description: d });
  const int = (d) => ({ type: "integer", description: d });
  return [
    tool("openDiff", "Open a diff view comparing a file with proposed new contents.",
      { old_file_path: str("Path to the original file"), new_file_path: str("Path the new contents would be written to"), new_file_contents: str("Proposed new file contents"), tab_name: str("Title for the diff tab") },
      ["old_file_path", "new_file_path", "new_file_contents", "tab_name"]),
    tool("openFile", "Open a file in the editor.",
      { filePath: str("Path of the file to open"), startLine: int("Optional 1-based line to select from"), endLine: int("Optional 1-based line to select to"), makeFrontmost: bool("Focus the opened document (default true)") },
      ["filePath"]),
    tool("getCurrentSelection", "Get the current text selection in the active editor.", {}),
    tool("getLatestSelection", "Get the most recent text selection, even if the editor lost focus.", {}),
    tool("getOpenEditors", "List open editor tabs.", {}),
    tool("getWorkspaceFolders", "List workspace root folders.", {}),
    tool("getDiagnostics", "Get language diagnostics (errors and warnings) from the IDE.",
      { uri: str("Optional file URI to scope diagnostics to") }),
    tool("checkDocumentDirty", "Check whether a document has unsaved changes.",
      { filePath: str("Path of the document") }, ["filePath"]),
    tool("saveDocument", "Save a document.",
      { filePath: str("Path of the document") }, ["filePath"]),
    tool("close_tab", "Close an editor tab by name.",
      { tab_name: str("Title of the tab to close") }, ["tab_name"]),
    tool("closeAllDiffTabs", "Close all diff tabs opened by Claude.", {}),
  ];
}

async function callTool(host, log, name, args) {
  log("IDE tool call: " + name);
  switch (name) {
    case "getCurrentSelection":
      return textResult(JSON.stringify(selectionJson(await host.getCurrentSelection())));
    case "getLatestSelection": {
      const sel = host.getLatestSelection();
      if (!sel) return textResult(JSON.stringify({ success: false, message: "No selection available" }));
      return textResult(JSON.stringify(selectionJson(sel)));
    }
    case "getOpenEditors": {
      const editors = await host.getOpenEditors();
      return textResult(JSON.stringify({
        tabs: editors.map((e) => ({
          uri: pathToFileURL(e.filePath).href,
          path: e.filePath,
          label: path.basename(e.filePath),
          isActive: e.isActive,
          isDirty: e.isDirty,
        })),
      }));
    }
    case "getWorkspaceFolders": {
      const folders = host.getWorkspaceFolders();
      return textResult(JSON.stringify({ success: true, folders, rootPath: folders[0] || null }));
    }
    case "getDiagnostics": {
      let filePath = null;
      if (args.uri) {
        try { filePath = new URL(args.uri).pathname ? decodeURIComponent(new URL(args.uri).pathname.replace(/^\/([A-Za-z]:)/, "$1")) : args.uri; }
        catch { filePath = args.uri; }
      }
      const diagnostics = await host.getDiagnostics(filePath);
      const byFile = new Map();
      for (const d of diagnostics) {
        const key = d.filePath.toLowerCase();
        if (!byFile.has(key)) byFile.set(key, { filePath: d.filePath, items: [] });
        byFile.get(key).items.push({
          message: d.message,
          severity: d.severity,
          source: d.source || null,
          code: d.code == null ? null : String(d.code),
          range: {
            start: { line: d.line, character: d.character },
            end: { line: d.line, character: d.character },
          },
        });
      }
      return textResult(JSON.stringify([...byFile.values()].map((g) => ({
        uri: pathToFileURL(g.filePath).href,
        diagnostics: g.items,
      }))));
    }
    case "openFile": {
      if (!args.filePath) throw new Error("filePath required");
      await host.openFile(args.filePath, args.startLine ?? null, args.endLine ?? null, args.makeFrontmost !== false);
      return textResult(JSON.stringify({ success: true, message: "Opened " + args.filePath }));
    }
    case "openDiff": {
      // The panel's permission cards are the accept/reject surface; the diff here is a
      // passive preview, reported as TAB_CLOSED (= "no decision made in the diff view").
      await host.openDiff(args.old_file_path || "", args.new_file_path || args.old_file_path || "",
        args.new_file_contents || "", args.tab_name || ("Claude diff: " + path.basename(args.new_file_path || "")));
      return textResult("TAB_CLOSED");
    }
    case "close_tab":
      return textResult((await host.closeTab(args.tab_name || "")) ? "TAB_CLOSED" : "TAB_NOT_FOUND");
    case "closeAllDiffTabs":
      return textResult("CLOSED_" + (await host.closeAllDiffTabs()) + "_DIFF_TABS");
    case "checkDocumentDirty":
      return textResult(JSON.stringify({ success: true, isDirty: await host.checkDocumentDirty(args.filePath || "") }));
    case "saveDocument":
      return textResult(JSON.stringify({ success: await host.saveDocument(args.filePath || "") }));
    default:
      return { content: [{ type: "text", text: "Unknown tool: " + name }], isError: true };
  }
}

class IdeMcpServer {
  constructor(host, log) {
    this._host = host;
    this._log = log || (() => { });
  }

  /** Handles one JSON-RPC message; returns the response (requests) or an ack (notifications). */
  async handle(message) {
    const method = message.method || "";
    const id = message.id;
    if (id === undefined || id === null)
      return { jsonrpc: "2.0", result: {}, id: 0 };

    try {
      let result;
      switch (method) {
        case "initialize":
          result = {
            protocolVersion: (message.params && message.params.protocolVersion) || "2025-06-18",
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: "ide", title: "Visual Studio Code", version: "0.1.0" },
          };
          break;
        case "ping":
          result = {};
          break;
        case "tools/list":
          result = { tools: describeTools() };
          break;
        case "tools/call":
          result = await callTool(this._host, this._log,
            (message.params && message.params.name) || "",
            (message.params && message.params.arguments) || {});
          break;
        default:
          return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found: " + method } };
      }
      return { jsonrpc: "2.0", id, result };
    } catch (e) {
      return { jsonrpc: "2.0", id, error: { code: -32603, message: e.message || String(e) } };
    }
  }
}

/** The real IDE host over the vscode API. Kept separate so tests can inject a fake. */
function createVsCodeIdeHost(getCwd) {
  const vscode = require("vscode");
  let latestSelection = null;

  const readSelection = (editor) => {
    if (!editor || editor.document.uri.scheme !== "file") return null;
    const sel = editor.selection;
    return {
      text: sel.isEmpty ? "" : editor.document.getText(sel),
      filePath: editor.document.uri.fsPath,
      startLine: sel.start.line,
      startCharacter: sel.start.character,
      endLine: sel.end.line,
      endCharacter: sel.end.character,
      isEmpty: sel.isEmpty,
    };
  };

  const selectionListener = vscode.window.onDidChangeTextEditorSelection((e) => {
    const s = readSelection(e.textEditor);
    if (s) latestSelection = s;
  });

  const severityName = (s) =>
    s === vscode.DiagnosticSeverity.Error ? "Error"
    : s === vscode.DiagnosticSeverity.Warning ? "Warning"
    : s === vscode.DiagnosticSeverity.Information ? "Information" : "Hint";

  const diffScheme = "vsclaudecode-diff";
  const diffContents = new Map(); // uri path -> proposed contents
  const diffProvider = vscode.workspace.registerTextDocumentContentProvider(diffScheme, {
    provideTextDocumentContent: (uri) => diffContents.get(uri.path) || "",
  });

  const allTabs = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs);

  return {
    getCurrentSelection: async () =>
      readSelection(vscode.window.activeTextEditor) ||
      { text: "", filePath: null, startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 0, isEmpty: true },
    getLatestSelection: () => latestSelection,
    getOpenEditors: async () => {
      const active = vscode.window.activeTextEditor;
      return allTabs()
        .filter((t) => t.input && t.input.uri && t.input.uri.scheme === "file")
        .map((t) => ({
          filePath: t.input.uri.fsPath,
          isActive: !!active && active.document.uri.fsPath === t.input.uri.fsPath,
          isDirty: t.isDirty,
        }));
    },
    getWorkspaceFolders: () => {
      const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
      return folders.length ? folders : [getCwd()];
    },
    getDiagnostics: async (filePath) => {
      const out = [];
      const collect = (uri, diags) => {
        if (uri.scheme !== "file") return;
        for (const d of diags) {
          out.push({
            filePath: uri.fsPath,
            message: d.message,
            severity: severityName(d.severity),
            source: d.source,
            code: typeof d.code === "object" && d.code !== null ? d.code.value : d.code,
            line: d.range.start.line,
            character: d.range.start.character,
          });
        }
      };
      if (filePath) {
        const uri = vscode.Uri.file(filePath);
        collect(uri, vscode.languages.getDiagnostics(uri));
      } else {
        for (const [uri, diags] of vscode.languages.getDiagnostics()) collect(uri, diags);
      }
      return out;
    },
    openFile: async (filePath, startLine, endLine, makeFrontmost) => {
      const doc = await vscode.workspace.openTextDocument(filePath);
      const editor = await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: !makeFrontmost });
      if (startLine) {
        const start = new vscode.Position(Math.max(0, startLine - 1), 0);
        const end = new vscode.Position(Math.max(0, (endLine || startLine) - 1), 0);
        editor.selection = new vscode.Selection(start, end);
        editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenter);
      }
    },
    openDiff: async (oldPath, newPath, contents, tabName) => {
      const key = "/" + Date.now() + "/" + path.basename(newPath || oldPath || "file");
      diffContents.set(key, contents);
      const proposed = vscode.Uri.from({ scheme: diffScheme, path: key });
      await vscode.commands.executeCommand("vscode.diff", vscode.Uri.file(oldPath), proposed, tabName, { preview: true });
    },
    closeTab: async (tabName) => {
      const tab = allTabs().find((t) => t.label === tabName);
      if (!tab) return false;
      await vscode.window.tabGroups.close(tab);
      return true;
    },
    closeAllDiffTabs: async () => {
      const tabs = allTabs().filter((t) => t.label.startsWith("Claude diff:") || t.label.startsWith("Claude: "));
      if (tabs.length) await vscode.window.tabGroups.close(tabs);
      return tabs.length;
    },
    checkDocumentDirty: async (filePath) => {
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath.toLowerCase() === filePath.toLowerCase());
      return !!doc && doc.isDirty;
    },
    saveDocument: async (filePath) => {
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath.toLowerCase() === filePath.toLowerCase());
      return doc ? doc.save() : false;
    },
    dispose: () => { selectionListener.dispose(); diffProvider.dispose(); },
  };
}

module.exports = { IdeMcpServer, createVsCodeIdeHost, describeTools };
