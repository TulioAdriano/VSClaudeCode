// Node-level test of the ported protocol/session/title modules against MockClaude —
// no VS Code needed. Usage: node tests/harness.mjs [path-to-MockClaude.exe]
// Env: CLAUDE_CONFIG_DIR should point at a config dir (fixtures optional).
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { ClaudeCliSession } = require(path.join(repo, "src", "cliSession.js"));
const sessionStore = require(path.join(repo, "src", "sessionStore.js"));
const titleGenerator = require(path.join(repo, "src", "titleGenerator.js"));

const mockExe = process.argv[2] ||
  "C:\\Users\\tulio\\source\\repos\\VSClaude\\tools\\MockClaude\\bin\\Release\\net10.0\\MockClaude.exe";

let failures = 0;
const ok = (name, cond, detail) => {
  if (cond) console.log("[ok] " + name + (detail ? ": " + detail : ""));
  else { failures++; console.error("[FAIL] " + name + (detail ? ": " + detail : "")); }
};

// ---- 1. session spawn + initialize + streamed turn -------------------------
const session = new ClaudeCliSession({
  executablePath: mockExe,
  workingDirectory: process.cwd(),
  environment: { VSCLAUDE_MOCK_LAZY_INIT: "1" },
});
const received = [];
session.onMessage = (m) => received.push(m);
session.onStderr = () => { };
session.start();

const init = await session.initialize(null);
ok("initialize control response", !!init && Array.isArray(init.models) && init.models.length > 0,
  (init.models || []).length + " models in catalog");

await session.sendUserMessage([{ type: "text", text: "hello from the VS Code port harness" }]);
await new Promise((resolve) => {
  const t = setTimeout(resolve, 15000);
  const iv = setInterval(() => {
    if (received.some((m) => m.type === "result")) { clearTimeout(t); clearInterval(iv); resolve(); }
  }, 100);
});
ok("system/init arrived at first turn (lazy)", received.some((m) => m.type === "system" && m.subtype === "init"));
ok("streamed deltas arrived", received.some((m) => m.type === "stream_event"));
ok("assistant message arrived", received.some((m) => m.type === "assistant"));
const result = received.find((m) => m.type === "result");
ok("turn result ok", !!result && result.is_error === false);
ok("session id adopted", !!session.lastSessionId, session.lastSessionId);

// ---- 2. control requests ----------------------------------------------------
const models = await session.listModels();
ok("list_models round-trip", Array.isArray(models.models) && models.models.length > 0);
const usage = await session.getUsage();
ok("get_usage has model_scoped", !!usage && !!usage.rate_limits, JSON.stringify(usage.rate_limits || {}).slice(0, 80) + "…");
try {
  await session.setModel("not-a-real-model-id");
  ok("set_model rejects malformed id", false, "no error thrown");
} catch (e) {
  ok("set_model rejects malformed id", true, e.message.slice(0, 60));
}
await session.renameSession("Harness Renamed Title");
ok("rename_session accepted", true);

// ---- 3. permission flow -----------------------------------------------------
const permSeen = { requestId: null };
session.permissionHandler = async (requestId, request) => {
  permSeen.requestId = requestId;
  permSeen.tool = request.tool_name;
  return { behavior: "deny", message: "harness denies everything" };
};
received.length = 0;
await session.sendUserMessage([{ type: "text", text: "please edit something" }]);
await new Promise((resolve) => {
  const t = setTimeout(resolve, 15000);
  const iv = setInterval(() => {
    if (received.some((m) => m.type === "result")) { clearTimeout(t); clearInterval(iv); resolve(); }
  }, 100);
});
ok("can_use_tool reached handler", !!permSeen.requestId, "tool=" + permSeen.tool);
ok("denied turn still completed", received.some((m) => m.type === "result"));

session.dispose();

// ---- 4. session store against fixtures -------------------------------------
const smokeRoot = path.join(process.env.LOCALAPPDATA || "", "Temp", "vsclaude-smoke");
process.env.CLAUDE_CONFIG_DIR = path.join(smokeRoot, "cfg");
const slnDir = path.join(smokeRoot, "ScratchSln");
const sessions = sessionStore.listSessions(slnDir, 40);
ok("session store lists fixture sessions", sessions.length >= 2, sessions.length + " sessions");
const renamed = sessions.find((s) => s.customTitle);
ok("custom-title tail-scan works", !!renamed, renamed && renamed.customTitle);
const withTranscript = sessions[0] && sessionStore.readTranscriptAll(slnDir, sessions[0].sessionId);
ok("transcript reads", Array.isArray(withTranscript) && withTranscript.length > 0,
  withTranscript && withTranscript.length + " entries");

// ---- 5. title generator -----------------------------------------------------
const title = await titleGenerator.generate(mockExe, "Fix the flaky USB driver init bug");
ok("title generator one-shot", title === "Mock Generated Title", title);

console.log(failures === 0 ? "ALL HARNESS CHECKS PASSED" : failures + " FAILURES");
process.exit(failures === 0 ? 0 : 1);
