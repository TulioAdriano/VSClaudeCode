// Remote Control for VSClaude Code — same design as VSClaude's bridge sidecar,
// but in-process (this host IS Node): the Agent SDK's /bridge export registers
// the session on claude.ai and mirrors it both ways. Auth is the user's own CLI
// sign-in (~/.claude/.credentials.json), used only against Anthropic's API.
// VSCLAUDE_MOCK_BRIDGE=1 substitutes a loopback fake for tests.
// The /bridge surface is ALPHA — SDK pinned; bump deliberately.

"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");
const { pathToFileURL } = require("url");

const SDK_PIN = "0.3.252";
const API_BASE = process.env.VSCLAUDE_BRIDGE_API_BASE || "https://api.anthropic.com";

function sdkDir() {
  return process.env.VSCLAUDE_SDK_DIR ||
    path.join(process.env.LOCALAPPDATA || os.homedir(), "VSClaude", "sdk");
}

function credentialsPath() {
  return process.env.VSCLAUDE_CREDENTIALS_PATH ||
    path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), ".credentials.json");
}

function readAccessToken() {
  const raw = JSON.parse(fs.readFileSync(credentialsPath(), "utf8"));
  const oauth = raw.claudeAiOauth;
  if (!oauth || !oauth.accessToken) throw new Error("no claudeAiOauth.accessToken in credentials file");
  if (oauth.expiresAt && Date.now() > oauth.expiresAt) {
    const e = new Error("access token expired on disk"); e.expired = true; throw e;
  }
  return oauth.accessToken;
}

async function loadBridgeModule(status) {
  const entry = path.join(sdkDir(), "node_modules", "@anthropic-ai", "claude-agent-sdk", "bridge.mjs");
  if (!fs.existsSync(entry)) {
    status("installing Agent SDK (one-time)…");
    fs.mkdirSync(sdkDir(), { recursive: true });
    execSync(`npm install "@anthropic-ai/claude-agent-sdk@${SDK_PIN}" --no-audit --no-fund`, { cwd: sdkDir(), stdio: "ignore" });
  }
  return await import(pathToFileURL(entry).href);
}

/**
 * Starts a remote bridge for one conversation.
 * handlers: {status, registered(cseId), inbound(msg), permissionResponse(res),
 *            interrupt(), setModel(model)->Promise<{ok,error?}>, setPermissionMode(mode),
 *            renameSession(title), closed(code), error(stage, message, reason?)}
 * Returns a handle: {write(msg), sendResult(), reportState(s), reportMetadata(d),
 *                    sendControlRequest(req), sendControlCancelRequest(id), stop()}
 */
async function startRemoteBridge(opts, handlers) {
  if (process.env.VSCLAUDE_MOCK_BRIDGE === "1") return startMock(opts, handlers);

  let bridge;
  try { bridge = await loadBridgeModule(handlers.status); }
  catch (e) { handlers.error("sdk", "Agent SDK unavailable: " + e.message); return null; }

  let token;
  try { token = readAccessToken(); }
  catch (e) { handlers.error("auth", e.message, e.expired ? "token_expired" : "no_credentials"); return null; }

  handlers.status("registering session with claude.ai…");
  const created = await bridge.createCodeSession(
    API_BASE, token, opts.title || "VS Code session", 30000, ["vsclaude-code"], undefined, opts.cwd, opts.model);
  if (typeof created !== "string") {
    if (created && created.reason === "oauth_rejected")
      handlers.error("create", "Anthropic rejected the sign-in token — send any message to refresh it, then retry.", created.reason);
    else handlers.error("create", "session create failed" + (created && created.reason ? " (" + created.reason + ")" : ""));
    return null;
  }
  const cseId = created;

  handlers.status("fetching worker credentials…");
  const creds = await bridge.fetchRemoteCredentials(cseId, API_BASE, token, 30000);
  if (!creds || creds.terminal || creds.reason === "oauth_rejected") {
    const reason = creds && creds.reason;
    handlers.error("credentials",
      reason === "untrusted_device"
        ? "This device isn't trusted for Remote Control yet. Run `claude` in a terminal and use /remote-control once to enroll it."
        : "worker credential mint failed" + (reason ? " (" + reason + ")" : ""), reason);
    return null;
  }

  handlers.status("attaching bridge…");
  let handle = null;
  const attach = async (c, seq) => await bridge.attachBridgeSession({
    sessionId: cseId,
    ingressToken: c.worker_jwt,
    apiBaseUrl: c.api_base_url,
    epoch: c.worker_epoch,
    initialSequenceNum: seq,
    onInboundMessage: (msg) => handlers.inbound(msg),
    onPermissionResponse: (res) => { handlers.permissionResponse(res); },
    onInterrupt: () => handlers.interrupt(),
    onSetModel: async (model) => {
      const v = await handlers.setModel(model);
      return v && v.ok ? { ok: true } : { ok: false, error: (v && v.error) || "rejected" };
    },
    onSetPermissionMode: (mode) => { handlers.setPermissionMode(mode); return { ok: true }; },
    onRenameSession: (title) => { handlers.renameSession(title); return { ok: true }; },
    onClose: async (code) => {
      if (code === 401 || code === 4094) {
        try {
          const t2 = readAccessToken();
          const seq2 = handle ? handle.getSequenceNum() : 0;
          const c2 = await bridge.fetchRemoteCredentials(cseId, API_BASE, t2, 30000);
          if (c2 && !c2.terminal && c2.worker_jwt) {
            handle = await attach(c2, seq2);
            handlers.status("bridge re-attached after credential refresh");
            return;
          }
        } catch { /* fall through */ }
      }
      handlers.closed(code);
    },
  });

  handle = await attach(creds, 0);
  handle.reportMetadata({ dir: opts.cwd, branch: opts.gitBranch });
  handle.reportState("idle");
  handlers.registered(cseId);

  return {
    write: (msg) => { try { handle.write(msg); } catch { } },
    sendResult: () => { try { handle.sendResult(); } catch { } },
    reportState: (s) => { try { handle.reportState(s); } catch { } },
    reportMetadata: (d) => { try { handle.reportMetadata(d); } catch { } },
    sendControlRequest: (req) => { try { handle.sendControlRequest(req); } catch { } },
    sendControlCancelRequest: (id) => { try { handle.sendControlCancelRequest(id); } catch { } },
    stop: async () => { try { await handle.flush(); handle.close(); } catch { } },
  };
}

/* Loopback fake: write ops land in mock-bridge-log.jsonl; a scripted inbound
   message arrives shortly after registration (mirrors VSClaude's sidecar mock). */
function startMock(opts, handlers) {
  const logPath = path.join(process.env.CLAUDE_CONFIG_DIR || os.tmpdir(), "mock-bridge-log.jsonl");
  fs.writeFileSync(logPath, JSON.stringify({ op: "start", title: opts.title }) + "\n");
  const log = (o) => { try { fs.appendFileSync(logPath, JSON.stringify(o) + "\n"); } catch { } };
  handlers.registered("cse_mock_0001");
  const timer = setTimeout(() => {
    handlers.inbound({ type: "user", message: { role: "user", content: [{ type: "text", text: "Message from your phone (mock) — reply briefly." }] } });
  }, 2500);
  return {
    write: (msg) => log({ op: "write", type: msg.type }),
    sendResult: () => log({ op: "result" }),
    reportState: (s) => log({ op: "state", state: s }),
    reportMetadata: () => { },
    sendControlRequest: (req) => log({ op: "controlRequest", subtype: req.request && req.request.subtype }),
    sendControlCancelRequest: (id) => log({ op: "controlCancel", id }),
    stop: async () => clearTimeout(timer),
  };
}

module.exports = { startRemoteBridge };
