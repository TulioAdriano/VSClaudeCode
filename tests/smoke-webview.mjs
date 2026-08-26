// In-VS Code webview smoke: attaches to a dev-instance over CDP, finds the
// vsclaudecode webview's execution context, and drives the shared webui for
// real — ready round-trip, streamed turn, theme mapping, storage, pixels.
// Usage: node tests/smoke-webview.mjs [port]   (default 9444)
// Prereq: launch per CLAUDE.md (isolated --user-data-dir, MockClaude env,
// VSCLAUDE_AUTO_OPEN=1, --remote-debugging-port).
import fs from "node:fs";
import path from "node:path";

const port = process.argv[2] || "9444";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shotsDir = path.join(process.env.LOCALAPPDATA || "", "Temp", "vsclaude-smoke", "shots");
fs.mkdirSync(shotsDir, { recursive: true });

// ---- browser-level CDP connection ------------------------------------------
let version = null;
for (let i = 0; i < 60; i++) {
  try {
    version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    break;
  } catch { await sleep(1000); }
}
if (!version) { console.error("CDP endpoint never came up on " + port); process.exit(1); }
console.log("[ok] CDP up:", version.Browser);

const ws = new WebSocket(version.webSocketDebuggerUrl);
let msgId = 0;
const pending = new Map();
const sessions = new Map(); // sessionId -> tag
let webviewSession = null;
const events = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else events.push(m);
};
const send = (method, params = {}, sessionId = undefined) =>
  new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, (m) => m.error ? reject(new Error(method + ": " + m.error.message)) : resolve(m.result));
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
await new Promise((r) => { ws.onopen = r; });

// Auto-attach through the target tree so OOPIF webview frames become sessions.
await send("Target.setDiscoverTargets", { discover: true });

// VS Code nests webview content: the vscode-webview:// target's top frame is a
// wrapper; the extension's HTML runs in an inner "active-frame" iframe, which is
// a separate EXECUTION CONTEXT within the same target. Probe every context.
let webviewContextId = null;
async function findWebviewContext(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { targetInfos } = await send("Target.getTargets");
    for (const t of targetInfos) {
      if (!t.url.startsWith("vscode-webview://")) continue;
      let sessionId = null;
      try {
        sessionId = (await send("Target.attachToTarget", { targetId: t.targetId, flatten: true })).sessionId;
        events.length = 0;
        await send("Runtime.enable", {}, sessionId);
        await sleep(500); // executionContextCreated events land here
        const contexts = events
          .filter((m) => m.method === "Runtime.executionContextCreated" && m.sessionId === sessionId)
          .map((m) => m.params.context.id);
        for (const ctxId of contexts.length ? contexts : [undefined]) {
          try {
            const probe = await send("Runtime.evaluate", {
              expression: "typeof state === 'object' && !!document.getElementById('input')",
              returnByValue: true,
              ...(ctxId !== undefined ? { contextId: ctxId } : {}),
            }, sessionId);
            if (probe.result && probe.result.value === true) {
              webviewContextId = ctxId;
              return sessionId;
            }
          } catch { }
        }
      } catch { }
      if (sessionId) { try { await send("Target.detachFromTarget", { sessionId }); } catch { } }
    }
    await sleep(1000);
  }
  return null;
}

webviewSession = await findWebviewContext(90000);
if (!webviewSession) {
  console.error("FAIL: no vscode-webview context running the vsclaudecode UI was found");
  const { targetInfos } = await send("Target.getTargets");
  for (const t of targetInfos) console.error("  target:", t.type, t.url.slice(0, 100));
  process.exit(2);
}
console.log("[ok] attached to the vsclaudecode webview (contextId " + webviewContextId + ")");

const evaluate = async (expr) => {
  const r = await send("Runtime.evaluate", {
    expression: expr, returnByValue: true, awaitPromise: true,
    ...(webviewContextId !== undefined && webviewContextId !== null ? { contextId: webviewContextId } : {}),
  }, webviewSession);
  if (r.exceptionDetails) throw new Error("evaluate: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result ? r.result.value : undefined;
};
const waitFor = async (expr, timeoutMs, what) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expr)) { console.log("[ok] " + what); return; }
    await sleep(250);
  }
  throw new Error("timeout waiting for: " + what);
};

// ---- 1. bridge + host round-trip -------------------------------------------
await waitFor("state.mock === true", 30000, "ready round-trip completed (MOCK badge state arrived over the bridge)");
await waitFor("!document.getElementById('loading-overlay') || document.getElementById('loading-overlay').classList.contains('hidden')", 30000, "session started (loading overlay hidden on initialize response)");

// ---- 2. theme mapping -------------------------------------------------------
const theme = await evaluate(`JSON.stringify((function(){
  const cs = getComputedStyle(document.documentElement);
  return {
    bg: cs.getPropertyValue('--bg').trim(),
    vsBg: cs.getPropertyValue('--vscode-sideBar-background').trim(),
    hl: document.documentElement.dataset.hl,
    bodyBg: getComputedStyle(document.body).backgroundColor,
  };
})())`);
const th = JSON.parse(theme);
console.log("[ok] theme:", theme);
if (!th.vsBg) throw new Error("VS Code theme variables not present in webview");
if (!th.bg || th.bg !== th.vsBg) throw new Error("--bg not mapped to VS Code sideBar background: " + theme);

// ---- 2.5 branding + IDE dot -------------------------------------------------
const brand = await evaluate(`JSON.stringify({
  docTitle: document.title,
  header: document.getElementById('session-title').textContent,
  dotOn: document.getElementById('ide-dot').className.includes('on'),
  dotTitle: document.getElementById('ide-dot').title,
})`);
const br = JSON.parse(brand);
console.log("[ok] branding/dot:", brand);
if (br.docTitle !== "VSClaude Code" || br.header !== "VSClaude Code")
  throw new Error("branding not applied: " + brand);
if (!br.dotOn) throw new Error("IDE dot is not green (sdkIde inactive): " + brand);

// ---- 3. storage -------------------------------------------------------------
const storage = await evaluate(`(function(){
  try { localStorage.setItem('vsclaudecode.smoke', 'x'); return localStorage.getItem('vsclaudecode.smoke') === 'x'; }
  catch (e) { return 'ERR: ' + e.message; }
})()`);
console.log("[ok] localStorage usable in webview:", storage);
if (storage !== true) console.log("[warn] localStorage unavailable — prefs need a host-persistence shim");

// ---- 4. a real streamed turn ------------------------------------------------
await evaluate(`(function(){const i=document.getElementById('input');i.value='hello from the VS Code smoke';i.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('btn-send').click();return true;})()`);
await waitFor("document.querySelectorAll('.msg.user').length >= 1", 10000, "user bubble rendered");
await waitFor("document.querySelectorAll('.msg.assistant').length >= 1", 20000, "assistant reply streaming");
await waitFor("!state.working && document.querySelectorAll('.turn-footer').length >= 1", 30000, "turn completed with footer");
const footer = await evaluate("Array.from(document.querySelectorAll('.turn-footer')).pop().textContent");
console.log("[ok] turn footer:", footer);
if (!/(Opus|Fable|Sonnet|Haiku) [\d.]+/.test(footer)) throw new Error("model attribution missing from footer: " + footer);

// ---- 5. sessions list from fixtures ----------------------------------------
await evaluate(`(function(){document.getElementById('btn-sessions').click();return true;})()`);
await waitFor("document.querySelectorAll('#sessions-list .session-item, #sessions-list .item, #sessions-list > *').length >= 1", 15000, "sessions panel lists fixture sessions");
await evaluate(`(function(){document.getElementById('btn-sessions-close').click();return true;})()`);

// ---- 5.5 @-file/folder suggestions + #-symbol references --------------------
// The host scans the workspace itself (the real CLI's file_suggestions is empty
// in print mode). ScratchSln has an App/ folder with App.csproj + Program.cs.
const triggerSuggest = (text) => evaluate(`(function(){
  const i = document.getElementById('input');
  i.value = ${JSON.stringify(text)};
  i.selectionStart = i.selectionEnd = i.value.length;
  i.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await triggerSuggest("@app");
await waitFor(`(function(){
  const p = document.getElementById('suggest-pop');
  if (p.classList.contains('hidden')) return false;
  const descs = Array.from(p.querySelectorAll('.suggest-item .desc')).map(d => d.textContent);
  return descs.some(d => d.startsWith('folder · ')) && descs.some(d => /App\\.csproj|Program\\.cs/.test(d));
})()`, 15000, "@ popup lists folders AND files");
await evaluate(`(function(){
  const items = Array.from(document.querySelectorAll('#suggest-pop .suggest-item'));
  items.find(it => it.querySelector('.desc').textContent.startsWith('folder · ')).click();
  return true;
})()`);
const atInserted = await evaluate(`document.getElementById('input').value`);
if (!/^@[\w./-]+\/ $/.test(atInserted)) throw new Error("folder accept produced: " + JSON.stringify(atInserted));
console.log("[ok] folder mention inserted:", JSON.stringify(atInserted.trim()));

// Symbols need a JS file (built-in tsserver provides workspace symbols with no
// extra extensions). Drop one, open it via the host to activate the provider.
const symFile = path.join(process.env.LOCALAPPDATA || "", "Temp", "vsclaude-smoke", "ScratchSln", "smoke-symbols.js");
fs.writeFileSync(symFile, "function smokeSymbolTarget(a, b) {\n  return a + b;\n}\nmodule.exports = { smokeSymbolTarget };\n");
await evaluate(`(function(){ post({ cmd: "openFile", path: "smoke-symbols.js" }); return true; })()`);
await sleep(4000); // tsserver warm-up after the file opens
let symbolShown = false;
for (let attempt = 0; attempt < 10 && !symbolShown; attempt++) {
  await triggerSuggest("#smokeSymbol");
  await sleep(1500);
  symbolShown = await evaluate(`(function(){
    const p = document.getElementById('suggest-pop');
    if (p.classList.contains('hidden')) return false;
    return Array.from(p.querySelectorAll('.suggest-item .label')).some(l => l.textContent.includes('smokeSymbolTarget'));
  })()`);
}
if (!symbolShown) throw new Error("# symbol popup never listed smokeSymbolTarget");
console.log("[ok] # popup lists workspace symbols");
await evaluate(`(function(){
  const items = Array.from(document.querySelectorAll('#suggest-pop .suggest-item'));
  items.find(it => it.querySelector('.label').textContent.includes('smokeSymbolTarget')).click();
  return true;
})()`);
const symInserted = await evaluate(`document.getElementById('input').value`);
if (!/^@smoke-symbols\.js#L\d+(-\d+)? $/.test(symInserted))
  throw new Error("symbol accept produced: " + JSON.stringify(symInserted));
console.log("[ok] symbol mention inserted:", JSON.stringify(symInserted.trim()));
await evaluate(`(function(){ const i = document.getElementById('input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);

// ---- 6. pixels --------------------------------------------------------------
const shot = await send("Page.captureScreenshot", { format: "png" }, webviewSession).catch(() => null);
if (shot && shot.data) {
  const file = path.join(shotsDir, "shot-vscode-smoke.png");
  fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
  console.log("[shot] " + file);
}

console.log("VSCODE WEBVIEW SMOKE PASSED");
process.exit(0);
