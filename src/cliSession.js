// Node port of VSClaude.Core ClaudeCliSession: hosts one Claude Code CLI child
// process speaking the stream-JSON + control protocol (see the VSClaude repo's
// docs/protocol.md for the wire contract this was validated against).
"use strict";

const { spawn } = require("child_process");
const readline = require("readline");
const fs = require("fs");
const path = require("path");
const os = require("os");

class ClaudeControlError extends Error {}

function resolveExecutable(configured) {
  if (configured && fs.existsSync(configured)) return configured;
  const home = os.homedir();
  const exeNames = process.platform === "win32" ? ["claude.exe", "claude.cmd"] : ["claude"];
  const candidates = [
    path.join(home, ".local", "bin", exeNames[0]),
    process.platform === "win32"
      ? path.join(process.env.APPDATA || "", "npm", "claude.cmd")
      : path.join(home, ".npm-global", "bin", "claude"),
  ];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    for (const name of exeNames) {
      try {
        const p = path.join(dir.trim(), name);
        if (fs.existsSync(p)) return p;
      } catch { /* malformed PATH entry */ }
    }
  }
  return exeNames[0];
}

function buildArguments(options) {
  const args = [
    "--print",
    "--output-format", "stream-json",
    "--input-format", "stream-json",
    "--verbose",
    "--permission-prompt-tool", "stdio",
  ];
  if (options.includePartialMessages !== false) args.push("--include-partial-messages");
  const thinking = options.thinkingDisplay === undefined ? "summarized" : options.thinkingDisplay;
  if (thinking) args.push("--thinking-display", thinking);
  if (options.model) args.push("--model", options.model);
  if (options.permissionMode) args.push("--permission-mode", options.permissionMode);
  if (options.effort) args.push("--effort", options.effort);
  if (options.resumeSessionId) args.push("--resume", options.resumeSessionId);
  else if (options.continueMostRecent) args.push("--continue");
  if (options.forkSession) args.push("--fork-session");
  if (options.sessionId) args.push("--session-id", options.sessionId);
  for (const dir of options.additionalDirectories || []) args.push("--add-dir", dir);
  if (options.registerSdkIdeServer)
    args.push("--mcp-config", '{"mcpServers":{"ide":{"type":"sdk","name":"ide"}}}');
  if (options.promptSuggestions) args.push("--prompt-suggestions");
  args.push(...(options.extraArguments || []));
  return args;
}

class ClaudeCliSession {
  constructor(options) {
    this.options = options;
    this.onMessage = null;        // (rawObj) => void
    this.onStderr = null;         // (line) => void
    this.onExited = null;         // (code) => void
    this.permissionHandler = null; // async (requestId, request, signal) => decision JObject
    this.mcpMessageHandler = null; // async (serverName, jsonrpc) => jsonrpc response
    this.lastSessionId = null;
    this._proc = null;
    this._requestCounter = 0;
    this._pendingControl = new Map();     // requestId -> {resolve, reject, timer}
    this._pendingPermissions = new Map(); // requestId -> AbortController
    this._disposed = false;
  }

  get isRunning() {
    return !!this._proc && this._proc.exitCode === null && !this._disposed;
  }

  start() {
    if (this._proc) throw new Error("Session already started.");
    const exe = resolveExecutable(this.options.executablePath);
    this.effectiveExePath = exe;
    const env = { ...process.env, ...(this.options.environment || {}) };
    // Never inherit a stale IDE port from a parent process.
    delete env.CLAUDE_CODE_SSE_PORT;
    if (this.options.ideServerPort) {
      env.ENABLE_IDE_INTEGRATION = "true";
      env.CLAUDE_CODE_SSE_PORT = String(this.options.ideServerPort);
    }
    // .cmd shims need a shell on Windows; real exes don't.
    const useShell = process.platform === "win32" && /\.cmd$/i.test(exe);
    const proc = spawn(exe, buildArguments(this.options), {
      cwd: this.options.workingDirectory || undefined,
      env,
      shell: useShell,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this._proc = proc;

    proc.on("exit", (code) => {
      this._failAllPending("Claude process exited (code " + code + ")");
      if (this.onExited) this.onExited(code === null ? -1 : code);
    });
    proc.on("error", (err) => {
      this._failAllPending("Claude process failed: " + err.message);
      if (this.onExited) this.onExited(-1);
    });

    readline.createInterface({ input: proc.stdout }).on("line", (line) => {
      if (!line) return;
      let msg;
      try { msg = JSON.parse(line); } catch { return; } // unparsed diagnostics line
      try { this._dispatch(msg); } catch (e) { /* consumer error must not kill the pump */ }
    });
    readline.createInterface({ input: proc.stderr }).on("line", (line) => {
      if (this.onStderr) this.onStderr(line);
    });
  }

  _dispatch(msg) {
    if (msg.session_id) this.lastSessionId = msg.session_id;

    if (msg.type === "control_response") {
      const resp = msg.response || {};
      const pending = this._pendingControl.get(resp.request_id);
      if (pending) {
        this._pendingControl.delete(resp.request_id);
        clearTimeout(pending.timer);
        if (resp.subtype === "error") pending.reject(new ClaudeControlError(resp.error || "control error"));
        else pending.resolve(resp.response || {});
      }
      return;
    }

    if (msg.type === "control_cancel_request") {
      const ac = this._pendingPermissions.get(msg.request_id);
      if (ac) { this._pendingPermissions.delete(msg.request_id); ac.abort(); }
      return;
    }

    if (msg.type === "control_request") {
      const requestId = msg.request_id || "";
      const request = msg.request || {};
      this._handleIncomingControl(requestId, request.subtype || "", request);
      return;
    }

    if (this.onMessage) this.onMessage(msg);
  }

  async _handleIncomingControl(requestId, subtype, request) {
    try {
      switch (subtype) {
        case "can_use_tool": {
          let decision;
          if (!this.permissionHandler) {
            decision = { behavior: "deny", message: "No permission handler attached to this session." };
          } else {
            const ac = new AbortController();
            this._pendingPermissions.set(requestId, ac);
            try {
              decision = await this.permissionHandler(requestId, request, ac.signal);
            } finally {
              this._pendingPermissions.delete(requestId);
            }
          }
          await this._sendControlResponse(requestId, decision);
          break;
        }
        case "mcp_message": {
          const serverName = request.server_name || "";
          const message = request.message || {};
          if (!this.mcpMessageHandler) {
            await this._sendControlError(requestId, "No SDK MCP handler for server: " + serverName);
            break;
          }
          // Requests (with id) get a real JSON-RPC response; notifications a generic ack.
          const isRequest = message.method !== undefined && message.id !== undefined && message.id !== null;
          let mcpResponse;
          if (isRequest) {
            mcpResponse = await this.mcpMessageHandler(serverName, message);
          } else {
            Promise.resolve(this.mcpMessageHandler(serverName, message)).catch(() => {});
            mcpResponse = { jsonrpc: "2.0", result: {}, id: 0 };
          }
          await this._sendControlResponse(requestId, { mcp_response: mcpResponse });
          break;
        }
        default:
          await this._sendControlError(requestId, "Unsupported control request: " + subtype);
          break;
      }
    } catch (e) {
      try { await this._sendControlError(requestId, e.message || String(e)); } catch { }
    }
  }

  _writeLine(json) {
    return new Promise((resolve, reject) => {
      if (!this._proc || !this._proc.stdin.writable) return reject(new Error("Session not started."));
      this._proc.stdin.write(json + "\n", (err) => err ? reject(err) : resolve());
    });
  }

  sendUserMessage(contentBlocks) {
    return this._writeLine(JSON.stringify({
      type: "user",
      message: { role: "user", content: contentBlocks },
      parent_tool_use_id: null,
    }));
  }

  _sendControlResponse(requestId, response) {
    return this._writeLine(JSON.stringify({
      type: "control_response",
      response: { subtype: "success", request_id: requestId, response },
    }));
  }

  _sendControlError(requestId, error) {
    return this._writeLine(JSON.stringify({
      type: "control_response",
      response: { subtype: "error", request_id: requestId, error },
    }));
  }

  sendControlRequest(subtype, payload, timeoutMs = 30000) {
    const requestId = "vsclaudecode_" + (++this._requestCounter);
    const request = { ...(payload || {}), subtype };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this._pendingControl.delete(requestId))
          reject(new Error("Control request '" + subtype + "' timed out."));
      }, timeoutMs);
      this._pendingControl.set(requestId, { resolve, reject, timer });
      this._writeLine(JSON.stringify({ type: "control_request", request_id: requestId, request }))
        .catch((err) => {
          if (this._pendingControl.delete(requestId)) { clearTimeout(timer); reject(err); }
        });
    });
  }

  initialize(payload, timeoutMs = 60000) { return this.sendControlRequest("initialize", payload, timeoutMs); }
  interrupt() { return this.sendControlRequest("interrupt"); }
  setPermissionMode(mode) { return this.sendControlRequest("set_permission_mode", { mode }); }
  setModel(model) { return this.sendControlRequest("set_model", { model: model === undefined ? null : model }); }
  renameSession(title) { return this.sendControlRequest("rename_session", { title }); }
  applyFlagSettings(settings) { return this.sendControlRequest("apply_flag_settings", { settings }); }
  getContextUsage() { return this.sendControlRequest("get_context_usage"); }
  getUsage() { return this.sendControlRequest("get_usage"); }
  listModels() { return this.sendControlRequest("list_models"); }
  fileSuggestions(query, timeoutMs = 10000) { return this.sendControlRequest("file_suggestions", { query }, timeoutMs); }

  _failAllPending(reason) {
    for (const [id, pending] of this._pendingControl) {
      clearTimeout(pending.timer);
      pending.reject(new ClaudeControlError(reason));
    }
    this._pendingControl.clear();
    for (const [id, ac] of this._pendingPermissions) ac.abort();
    this._pendingPermissions.clear();
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    const proc = this._proc;
    this._proc = null;
    if (!proc) return;
    try { proc.stdin.end(); } catch { }
    const pid = proc.pid;
    setTimeout(() => {
      if (proc.exitCode !== null) return;
      if (process.platform === "win32") {
        try { spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }); } catch { }
      } else {
        try { proc.kill("SIGKILL"); } catch { }
      }
    }, 3000);
  }
}

module.exports = { ClaudeCliSession, ClaudeControlError, resolveExecutable, buildArguments };
