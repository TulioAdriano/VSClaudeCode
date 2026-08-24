/* VSClaude chat UI — vanilla JS + vendored highlight.js.
   Bridge: window.chrome.webview (VS extension). Without it: browser demo mode. */
"use strict";

const $ = (id) => document.getElementById(id);
const messagesEl = $("messages"), inputEl = $("input"), bannersEl = $("banners");
const suggestEl = $("suggest-pop"), sessionsPanel = $("sessions-panel"), sessionsList = $("sessions-list");
const welcomeEl = $("welcome");

const bridge = window.chrome && window.chrome.webview ? window.chrome.webview : null;
// Product name comes from the page title so each host (VS panel, VS Code port)
// brands the header/welcome without diverging this shared file.
const APP_TITLE = document.title || "Claude Code";
const state = {
  running: false, working: false, mode: "default", model: "",
  sessionId: null, cwd: "", ideConnections: 0, mock: false,
  attachments: [], commands: [], models: [], toolCards: new Map(),
  liveMessage: null, liveBlocks: [], suggestToken: 0, suggestItems: [], suggestActive: 0,
  suggestKind: null, suggestAnchor: 0, autoScroll: true, initData: null,
  runningModel: null, lastModelsRefresh: 0, pendingModels: null, showPreviousModels: true,
  turnModel: null, historyModel: null,
  pendingCustomModel: null, pendingCustomRevert: null, pendingCustomTimer: 0, cliUpdateNoticeShown: false,
  lastStreamContainer: null, replayingHistory: false,
  workingSince: 0, workingTimer: null, caret: null, sessions: [], account: null,
  signinRequired: false, hasContent: false,
  sessionTitle: null, pendingResumeTitle: null, manualTitle: false,
  usage: { five: null, seven: null, models: [], extraPct: null, dismissedLevel: 0 },
  renderTarget: null,
};

/* ---------- remembered session preferences (model / effort / mode) ---------- */
function lsGet(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}
function currentPrefs() {
  let model = $("model-select").value;
  // Never persist transient values: the "Custom model ID…" entry itself, or a typed id
  // the CLI hasn't accepted yet (a rejected id must not poison the next session's spawn).
  if (!model || model === "__custom__") model = "default";
  else if (state.pendingCustomModel && model === state.pendingCustomModel)
    model = state.pendingCustomRevert || "default";
  return {
    model,
    effort: $("effort-select").value || "high",
    mode: $("mode-select").value || "default",
  };
}
/* Last conversation's settings — seeds every new chat. */
function saveLastPrefs() { lsSet("vsclaude.lastPrefs", currentPrefs()); }
/* Per-session settings — restored when that session is resumed. */
function saveSessionPrefs() {
  if (!state.sessionId) return;
  const all = lsGet("vsclaude.sessionPrefs", {});
  all[state.sessionId] = { ...currentPrefs(), ts: Date.now() };
  const ids = Object.keys(all);
  if (ids.length > 60) {
    ids.sort((a, b) => (all[a].ts || 0) - (all[b].ts || 0));
    for (const id of ids.slice(0, ids.length - 60)) delete all[id];
  }
  lsSet("vsclaude.sessionPrefs", all);
}
function sessionPrefsFor(sessionId) {
  const p = lsGet("vsclaude.sessionPrefs", {})[sessionId];
  return p ? { model: p.model, effort: p.effort, mode: p.mode } : null;
}

let _loadingTimer = null;
function showLoading(label) {
  $("loading-label").textContent = label;
  $("loading-overlay").classList.remove("hidden");
  // Safety net: the overlay must never get stuck if a "ready" signal is missed.
  clearTimeout(_loadingTimer);
  _loadingTimer = setTimeout(hideLoading, 20000);
}
function hideLoading() {
  clearTimeout(_loadingTimer);
  $("loading-overlay").classList.add("hidden");
}

function post(obj) {
  if (bridge) bridge.postMessage(obj);
  else demoHandleCommand(obj);
}

/* ---------- icons ---------- */
const ICONS = {
  file: '<svg viewBox="0 0 16 16" width="13" height="13"><path fill="currentColor" d="M9.5 1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V4.5zm0 1.7L11.3 4.5H9.5zM4 14V2h4.5v3H12v9z"/></svg>',
  edit: '<svg viewBox="0 0 16 16" width="13" height="13"><path fill="currentColor" d="M12.9 1.7a1.5 1.5 0 0 1 2.1 2.1l-.9.9-2.1-2.1zM10.9 3.7l2.1 2.1-7.4 7.4-2.7.6.6-2.7z"/></svg>',
  term: '<svg viewBox="0 0 16 16" width="13" height="13"><path fill="currentColor" d="M2 3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1zm1.5.5v9h9v-9zM4.7 6.2l1.06-1.06L8.2 7.6 5.76 10.1 4.7 9.04 6.14 7.6zM8.5 9.5h3V11h-3z"/></svg>',
  search: '<svg viewBox="0 0 16 16" width="13" height="13"><path fill="currentColor" d="M10.4 9.34a5 5 0 1 0-1.06 1.06l3.13 3.13 1.06-1.06zM3.5 6.5a3.5 3.5 0 1 1 7 0 3.5 3.5 0 0 1-7 0z"/></svg>',
  globe: '<svg viewBox="0 0 16 16" width="13" height="13"><path fill="currentColor" d="M8 1.5A6.5 6.5 0 1 0 14.5 8 6.5 6.5 0 0 0 8 1.5zM13 7.25h-2.27a10.5 10.5 0 0 0-.87-3.83A5 5 0 0 1 13 7.25zM8 13a9.6 9.6 0 0 1-1.2-4.25h2.4A9.6 9.6 0 0 1 8 13zM6.8 7.25A9.6 9.6 0 0 1 8 3a9.6 9.6 0 0 1 1.2 4.25zM6.14 3.42a10.5 10.5 0 0 0-.87 3.83H3a5 5 0 0 1 3.14-3.83zM3 8.75h2.27a10.5 10.5 0 0 0 .87 3.83A5 5 0 0 1 3 8.75zm6.86 3.83a10.5 10.5 0 0 0 .87-3.83H13a5 5 0 0 1-3.14 3.83z"/></svg>',
  list: '<svg viewBox="0 0 16 16" width="13" height="13"><path fill="currentColor" d="M2.5 4a1 1 0 1 1 2 0 1 1 0 0 1-2 0zm0 4a1 1 0 1 1 2 0 1 1 0 0 1-2 0zm1 5a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM6 3.25h7.5v1.5H6zm0 4h7.5v1.5H6zm0 4h7.5v1.5H6z"/></svg>',
  bot: '<svg viewBox="0 0 16 16" width="13" height="13"><path fill="currentColor" d="M8 1a1 1 0 0 1 1 1v1h2.5A1.5 1.5 0 0 1 13 4.5V6h1v4h-1v1.5a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 11.5V10H2V6h1V4.5A1.5 1.5 0 0 1 4.5 3H7V2a1 1 0 0 1 1-1zM4.5 4.5v7h7v-7zM6 7a1 1 0 1 1 0 2 1 1 0 0 1 0-2zm4 0a1 1 0 1 1 0 2 1 1 0 0 1 0-2z"/></svg>',
  gear: '<svg viewBox="0 0 16 16" width="13" height="13"><path fill="currentColor" d="M9.3 1.5l.34 1.7a5 5 0 0 1 1.13.65l1.64-.56 1.3 2.25-1.3 1.15a5 5 0 0 1 0 1.3l1.3 1.15-1.3 2.25-1.64-.56a5 5 0 0 1-1.13.66L9.3 14.5H6.7l-.34-1.7a5 5 0 0 1-1.13-.66l-1.64.56-1.3-2.25 1.3-1.15a5 5 0 0 1 0-1.3l-1.3-1.15 1.3-2.25 1.64.56a5 5 0 0 1 1.13-.65l.34-1.7zM8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/></svg>',
  shield: '<svg viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M8 1l5.5 2v4.1c0 3.4-2.3 6.4-5.5 7.9C4.8 13.5 2.5 10.5 2.5 7.1V3zM8 2.6L4 4.1v3c0 2.7 1.7 5.1 4 6.4 2.3-1.3 4-3.7 4-6.4v-3z"/></svg>',
  planDoc: '<svg viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M4 1h8a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1zm.5 1.5v11h7v-11zM6 5h4v1.2H6zm0 2.5h4v1.2H6zm0 2.5h2.5v1.2H6z"/></svg>',
};
function toolIcon(name) {
  if (name === "Bash" || name === "PowerShell") return ICONS.term;
  if (name === "Edit" || name === "Write" || name === "MultiEdit" || name === "NotebookEdit") return ICONS.edit;
  if (name === "Read") return ICONS.file;
  if (name === "Glob" || name === "Grep") return ICONS.search;
  if (name === "WebFetch" || name === "WebSearch") return ICONS.globe;
  if (name === "TodoWrite") return ICONS.list;
  if (name === "Task" || name === "Agent") return ICONS.bot;
  if (name.startsWith("mcp__")) return ICONS.gear;
  return ICONS.gear;
}

/* ---------- markdown ---------- */
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function mdInline(s) {
  // Extract code spans first so emphasis/strikethrough never touch their contents
  // (protects snake_case identifiers, globs, etc. inside backticks).
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (m, c) => {
    codes.push(c);
    return "\u0000" + (codes.length - 1) + "\u0000";
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
  // GFM-style underscore emphasis: only at word boundaries, so bare_snake_case survives.
  s = s.replace(/(^|[^\w_])__([^_](?:[^_]*[^_\s])?)__(?=[^\w_]|$)/g, "$1<strong>$2</strong>");
  s = s.replace(/(^|[^\w_])_([^_\s](?:[^_]*[^_\s])?)_(?=[^\w_]|$)/g, "$1<em>$2</em>");
  s = s.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  s = s.replace(/\u0000(\d+)\u0000/g, (m, i) => "<code>" + codes[+i] + "</code>");
  return s;
}
const LANG_ALIASES = { "c#": "csharp", "f#": "fsharp", "c++": "cpp", "objective-c": "objectivec", ".net": "csharp", "cs": "csharp", "sh": "bash", "ps1": "powershell", "yml": "yaml" };
function hlLangClass(lang) {
  const norm = LANG_ALIASES[(lang || "").toLowerCase()] || lang || "plaintext";
  return norm.replace(/[^\w+-]/g, "") || "plaintext";
}
function renderMarkdown(src) {
  const lines = src.split("\n");
  let html = "", i = 0, para = [];
  const flushPara = () => {
    if (para.length) { html += "<p>" + mdInline(para.join("<br>")) + "</p>"; para = []; }
  };
  while (i < lines.length) {
    let line = lines[i];
    // GFM-style fences: up to 3 leading spaces, 3+ backticks; the closing fence may also
    // be indented and must be at least as long as the opener (so ````-blocks can contain ```).
    const fence = line.match(/^ {0,3}(`{3,})([^\s`]*)\s*$/);
    if (fence) {
      flushPara();
      const lang = fence[2] || "";
      const closeRe = new RegExp("^ {0,3}`{" + fence[1].length + ",}\\s*$");
      let code = [];
      i++;
      while (i < lines.length && !closeRe.test(lines[i])) { code.push(lines[i]); i++; }
      i++;
      html += '<pre><div class="code-head"><span>' + escapeHtml(lang || "text") +
              '</span><button class="copy-btn">copy</button></div>' +
              '<code class="language-' + hlLangClass(lang) + '">' +
              escapeHtml(code.join("\n")) + "</code></pre>";
      continue;
    }
    const esc = escapeHtml(line);
    const h = esc.match(/^(#{1,4})\s+(.*)$/);
    if (h) { flushPara(); html += `<h${h[1].length}>${mdInline(h[2])}</h${h[1].length}>`; i++; continue; }
    if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(esc)) { flushPara(); html += "<hr>"; i++; continue; }
    if (/^\s*&gt;\s?/.test(esc)) {
      flushPara();
      let quote = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { quote.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
      html += "<blockquote>" + renderMarkdown(quote.join("\n")) + "</blockquote>";
      continue;
    }
    const listMatch = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (listMatch) {
      flushPara();
      const ordered = /\d/.test(listMatch[2]);
      html += ordered ? "<ol>" : "<ul>";
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (!m) break;
        html += "<li>" + mdInline(escapeHtml(m[3])) + "</li>";
        i++;
      }
      html += ordered ? "</ol>" : "</ul>";
      continue;
    }
    if (/^\s*\|.+\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      flushPara();
      const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map(c => mdInline(escapeHtml(c.trim())));
      html += "<table><tr>" + cells(line).map(c => `<th>${c}</th>`).join("") + "</tr>";
      i += 2;
      while (i < lines.length && /^\s*\|.+\|\s*$/.test(lines[i])) {
        html += "<tr>" + cells(lines[i]).map(c => `<td>${c}</td>`).join("") + "</tr>";
        i++;
      }
      html += "</table>";
      continue;
    }
    if (line.trim() === "") { flushPara(); i++; continue; }
    para.push(esc);
    i++;
  }
  flushPara();
  return html;
}
function highlightIn(root) {
  if (!window.hljs || !root) return;
  root.querySelectorAll("pre code:not(.hl-done)").forEach((el) => {
    try { hljs.highlightElement(el); } catch {}
    el.classList.add("hl-done");
  });
}
document.addEventListener("click", (e) => {
  const btn = e.target.closest && e.target.closest(".copy-btn");
  if (btn) {
    const code = btn.closest("pre").querySelector("code");
    navigator.clipboard.writeText(code.innerText).then(() => {
      btn.textContent = "copied ✓";
      setTimeout(() => (btn.textContent = "copy"), 1200);
    });
    return;
  }
  const fileLink = e.target.closest && e.target.closest(".file-link");
  if (fileLink && fileLink.dataset.path) {
    e.stopPropagation();
    const line = fileLink.dataset.line ? parseInt(fileLink.dataset.line, 10) : null;
    post({ cmd: "openFile", path: fileLink.dataset.path, line });
  }
}, true);

/* ---------- welcome ---------- */
function updateWelcome() {
  if (state.renderTarget) return;
  state.hasContent = messagesEl.children.length > 0;
  welcomeEl.classList.toggle("hidden", state.hasContent);
  $("welcome-signin").classList.toggle("hidden", !state.signinRequired);
  $("welcome-tips").classList.toggle("hidden", state.signinRequired);
}
$("btn-signin").addEventListener("click", () => {
  post({ cmd: "login" });
  $("signin-waiting").classList.remove("hidden");
});

/* ---------- scroll ---------- */
function nearBottom() {
  return messagesEl.scrollTop + messagesEl.clientHeight >= messagesEl.scrollHeight - 80;
}
function scrollBottom(force) {
  if (state.renderTarget) return; // prepend rendering must not move the viewport
  if (force || state.autoScroll) messagesEl.scrollTop = messagesEl.scrollHeight;
}
messagesEl.addEventListener("scroll", () => {
  state.autoScroll = nearBottom();
  $("jump-pill").classList.toggle("hidden", state.autoScroll);
});
$("jump-pill").addEventListener("click", () => {
  state.autoScroll = true;
  scrollBottom(true);
  $("jump-pill").classList.add("hidden");
});

/* ---------- messages ---------- */
function addUserMessage(text, attachments) {
  const div = document.createElement("div");
  div.className = "msg user";
  const md = document.createElement("div");
  md.className = "md";
  md.innerHTML = renderMarkdown(text || "");
  div.appendChild(md);
  highlightIn(md);
  for (const a of attachments || []) {
    ensureImageType(a); // older sessions stored media_type:"" (WebView2 typeless paste)
    if (a.data && a.mediaType && a.mediaType.startsWith("image/")) {
      const img = document.createElement("img");
      img.className = "img-thumb";
      img.src = "data:" + a.mediaType + ";base64," + a.data;
      div.appendChild(img);
    }
  }
  (state.renderTarget || messagesEl).appendChild(div);
  updateWelcome();
  scrollBottom(true);
}

function ensureAssistantContainer(parentToolUseId) {
  if (parentToolUseId) {
    const card = state.toolCards.get(parentToolUseId);
    if (card) {
      let sub = card.querySelector(".tool-sub");
      if (!sub) {
        sub = document.createElement("div");
        sub.className = "tool-sub tool-body";
        card.appendChild(sub);
      }
      return sub;
    }
  }
  let container = state.liveMessage;
  if (!container) {
    container = document.createElement("div");
    container.className = "msg assistant";
    (state.renderTarget || messagesEl).appendChild(container);
    state.liveMessage = container;
    state.lastStreamContainer = container;
    updateWelcome();
  }
  return container;
}
function finishLiveMessage() {
  removeCaret();
  // Thinking blocks can end implicitly (no content_block_stop reaches us, e.g.
  // signature-only or interleaved turns) — finish them so empty pills get removed.
  for (const b of state.liveBlocks)
    if (b && b.kind === "thinking" && b.el && b.el.isConnected) finishThinking(b.el);
  state.liveMessage = null;
  state.liveBlocks = [];
}

/* streaming caret */
function placeCaret(el) {
  removeCaret();
  const caret = document.createElement("span");
  caret.className = "stream-caret";
  el.appendChild(caret);
  state.caret = caret;
}
function removeCaret() {
  if (state.caret) { state.caret.remove(); state.caret = null; }
}

/* working indicator */
const WORK_VERBS = ["Working", "Thinking", "Reasoning", "Tinkering", "Considering"];
function setWorking(on) {
  if (on === state.working) { if (on) messagesEl.querySelector("#working") && messagesEl.appendChild($("working")); return; }
  state.working = on;
  let w = $("working");
  if (on) {
    state.workingSince = Date.now();
    if (!w) {
      w = document.createElement("div");
      w.id = "working";
      w.innerHTML = '<span class="spinner"></span><span class="label">Working…</span><span class="hint">Esc to interrupt</span>';
    }
    messagesEl.appendChild(w);
    const verb = WORK_VERBS[Math.floor(Math.random() * WORK_VERBS.length)];
    const label = w.querySelector(".label");
    label.textContent = verb + "…";
    clearInterval(state.workingTimer);
    state.workingTimer = setInterval(() => {
      const secs = Math.floor((Date.now() - state.workingSince) / 1000);
      if (secs >= 3) label.textContent = verb + "… " + secs + "s";
    }, 1000);
  } else {
    clearInterval(state.workingTimer);
    if (w) w.remove();
    removeCaret();
  }
  $("btn-stop").classList.toggle("hidden", !on);
  $("btn-send").classList.toggle("hidden", on);
  updateWelcome();
  scrollBottom();
}

/* ---------- blocks ---------- */
function newTextBlock(container) {
  const el = document.createElement("div");
  el.className = "text-block md";
  el.dataset.src = "";
  container.appendChild(el);
  return el;
}
function appendTextDelta(el, delta) {
  el.dataset.src += delta;
  el.innerHTML = renderMarkdown(el.dataset.src);
  placeCaret(el.lastElementChild && el.lastElementChild.tagName === "P" ? el.lastElementChild : el);
  scrollBottom();
}
function finalizeTextBlock(el) {
  el.innerHTML = renderMarkdown(el.dataset.src);
  highlightIn(el);
}
function newThinkingBlock(container) {
  const details = document.createElement("details");
  details.className = "thinking";
  details.open = true;
  details.innerHTML = "<summary>Thinking…</summary><div class='think-text'></div>";
  const text = details.querySelector(".think-text");
  // Sticky auto-scroll, same contract as the main chat: follow the tail unless the
  // user scrolls up; resume following when they return to the bottom.
  text.dataset.stick = "1";
  text.addEventListener("scroll", () => {
    text.dataset.stick = text.scrollTop + text.clientHeight >= text.scrollHeight - 24 ? "1" : "0";
  });
  container.appendChild(details);
  return details;
}
function appendThinkingDelta(el, delta) {
  const text = el.querySelector(".think-text");
  text.textContent += delta;
  if (text.dataset.stick === "1") text.scrollTop = text.scrollHeight;
  scrollBottom();
}
function finishThinking(el) {
  // Signature-only / summarized thinking arrives with no visible text — drop the empty pill.
  const text = el.querySelector(".think-text").textContent.trim();
  if (!text) { el.remove(); return; }
  const preview = text.replace(/\s+/g, " ").slice(0, 70);
  el.querySelector("summary").textContent = "Thought — " + preview + (text.length > 70 ? "…" : "");
  el.open = false;
}

function toolSummary(name, input) {
  try {
    if (!input) return "";
    const short = (p) => (p || "").replace(/\\/g, "/").split("/").slice(-2).join("/");
    if (name === "Bash" || name === "PowerShell") return input.command || "";
    if (name === "Read") return short(input.file_path);
    if (name === "Write" || name === "Edit" || name === "MultiEdit" || name === "NotebookEdit") return short(input.file_path);
    if (name === "Glob" || name === "Grep") return input.pattern || "";
    if (name === "WebFetch") return input.url || "";
    if (name === "WebSearch") return input.query || "";
    if (name === "Task") return input.description || "";
    if (name === "Skill") return "/" + (input.skill || "");
    if (name === "TodoWrite") return "";
    const first = Object.values(input).find(v => typeof v === "string");
    return first || "";
  } catch { return ""; }
}
function editDiffStat(name, input) {
  try {
    const count = (s) => (s ? s.split("\n").length : 0);
    let plus = 0, minus = 0;
    if (name === "Edit") { minus = count(input.old_string); plus = count(input.new_string); }
    else if (name === "Write") { plus = count(input.content); }
    else if (name === "MultiEdit" && Array.isArray(input.edits)) {
      for (const e of input.edits) { minus += count(e.old_string); plus += count(e.new_string); }
    } else return "";
    return `<span class="plus">+${plus}</span> <span class="minus">−${minus}</span>`;
  } catch { return ""; }
}

function renderTodoCard(input) {
  const ul = document.createElement("ul");
  ul.className = "todo-list";
  (input.todos || []).forEach(t => {
    const li = document.createElement("li");
    const box = document.createElement("span");
    box.className = "box";
    box.textContent = t.status === "completed" ? "✔" : t.status === "in_progress" ? "▸" : "○";
    const label = document.createElement("span");
    label.textContent = t.status === "in_progress" ? (t.activeForm || t.content) : t.content;
    li.className = t.status === "completed" ? "done" : t.status === "in_progress" ? "doing" : "";
    li.appendChild(box); li.appendChild(label);
    ul.appendChild(li);
  });
  return ul;
}

function newToolCard(container, toolUseId, name, input) {
  const card = document.createElement("div");
  card.className = "tool-card";
  card.dataset.tool = name;
  const head = document.createElement("div");
  head.className = "tool-head";
  const stat = editDiffStat(name, input);
  const filePath = input && input.file_path;
  head.innerHTML =
    '<span class="tool-icon">' + toolIcon(name) + "</span>" +
    '<span class="tool-name">' + escapeHtml(displayToolName(name)) + "</span>" +
    '<span class="tool-summary' + (filePath ? " file-link" : "") + '"' +
    (filePath ? ' data-path="' + escapeHtml(filePath) + '" title="Open in editor"' : "") + ">" +
    escapeHtml(toolSummary(name, input)) + "</span>" +
    (stat ? '<span class="diffstat">' + stat + "</span>" : "") +
    '<span class="tool-status running">●</span>';
  card.appendChild(head);

  const body = document.createElement("div");
  body.className = "tool-body hidden";
  const editDiff = editInputDiffHtml(name, input || {}, null);
  if (name === "TodoWrite") {
    body.classList.remove("hidden");
    body.appendChild(renderTodoCard(input || {}));
  } else if (editDiff != null) {
    const diff = document.createElement("div");
    diff.className = "card-diff";
    diff.innerHTML = editDiff;
    body.appendChild(diff);
  } else if (input && Object.keys(input).length) {
    const pre = document.createElement("pre");
    pre.textContent = JSON.stringify(input, null, 2);
    body.appendChild(pre);
  }
  card.appendChild(body);
  head.addEventListener("click", () => body.classList.toggle("hidden"));

  container.appendChild(card);
  if (toolUseId) state.toolCards.set(toolUseId, card);
  updateWelcome();
  scrollBottom();
  return card;
}
function displayToolName(name) {
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    return parts.length >= 3 ? parts[1] + ": " + parts.slice(2).join("_") : name;
  }
  return name;
}

function attachToolResult(toolUseId, content, isError, toolUseResult) {
  const card = state.toolCards.get(toolUseId);
  if (!card) return;
  const status = card.querySelector(".tool-status");
  status.className = "tool-status " + (isError ? "err" : "ok");
  status.textContent = isError ? "✕" : "✓";
  if (card.dataset.tool === "TodoWrite") return;
  const body = card.querySelector(".tool-body");

  // Edit-like tools: swap the preliminary diff for the CLI's structuredPatch,
  // which carries real line numbers and context lines.
  const patch = toolUseResult && Array.isArray(toolUseResult.structuredPatch) && toolUseResult.structuredPatch.length
    ? toolUseResult.structuredPatch : null;
  if (patch && !isError) {
    body.innerHTML = "";
    const diff = document.createElement("div");
    diff.className = "card-diff";
    diff.innerHTML = patchHtml(patch);
    body.appendChild(diff);
    const line = firstPatchLine(patch);
    const link = card.querySelector(".file-link");
    if (link && line != null) link.dataset.line = line;
    return;
  }

  const label = document.createElement("div");
  label.className = "tool-result-label";
  label.textContent = isError ? "error" : "result";
  const pre = document.createElement("pre");
  let text = "";
  if (typeof content === "string") text = content;
  else if (Array.isArray(content))
    text = content.map(b => (b && b.type === "text" ? b.text : "")).join("\n");
  pre.textContent = text.length > 6000 ? text.slice(0, 6000) + "\n… (truncated)" : text;
  body.appendChild(label);
  body.appendChild(pre);
}

/* ---------- stream handling ---------- */
function handleStreamEvent(ev, parentToolUseId) {
  const container = ensureAssistantContainer(parentToolUseId);
  switch (ev.type) {
    case "message_start":
      break;
    case "content_block_start": {
      const cb = ev.content_block || {};
      let block = null;
      if (cb.type === "text") block = { kind: "text", el: newTextBlock(container) };
      else if (cb.type === "thinking") block = { kind: "thinking", el: newThinkingBlock(container) };
      else if (cb.type === "tool_use")
        block = { kind: "tool", id: cb.id, name: cb.name, json: "", el: null };
      state.liveBlocks[ev.index] = block;
      break;
    }
    case "content_block_delta": {
      const block = state.liveBlocks[ev.index];
      if (!block) break;
      const d = ev.delta || {};
      if (d.type === "text_delta" && block.kind === "text") appendTextDelta(block.el, d.text || "");
      else if (d.type === "thinking_delta" && block.kind === "thinking") appendThinkingDelta(block.el, d.thinking || "");
      else if (d.type === "input_json_delta" && block.kind === "tool") block.json += d.partial_json || "";
      break;
    }
    case "content_block_stop": {
      const block = state.liveBlocks[ev.index];
      if (!block) break;
      if (block.kind === "text") { removeCaret(); finalizeTextBlock(block.el); }
      if (block.kind === "thinking") finishThinking(block.el);
      if (block.kind === "tool" && !block.el) {
        let input = {};
        try { input = JSON.parse(block.json || "{}"); } catch {}
        block.el = newToolCard(container, block.id, block.name, input);
      }
      break;
    }
    case "message_stop":
      finishLiveMessage();
      break;
  }
}

/* "claude-opus-4-8[1m]" → "Opus 4.8", "claude-haiku-4-5-20251001" → "Haiku 4.5".
   Unknown shapes fall back to the raw id. */
function friendlyModelName(id) {
  if (!id) return "";
  let s = String(id).replace(/\[1m\]$/, "").replace(/^claude-/, "").replace(/-\d{8}$/, "");
  const m = s.match(/^([a-z]+)-(\d+(?:-\d+)*)$/);
  if (m) return m[1][0].toUpperCase() + m[1].slice(1) + " " + m[2].replace(/-/g, ".");
  return String(id);
}

/* History replay: one model label per contiguous assistant run (i.e. per turn). */
function flushHistoryModelFooter() {
  if (!state.historyModel) return;
  const el = document.createElement("div");
  el.className = "turn-footer model-footer";
  el.textContent = friendlyModelName(state.historyModel);
  el.title = "Model: " + state.historyModel;
  (state.renderTarget || messagesEl).appendChild(el);
  state.historyModel = null;
}

function handleAssistantMessage(m) {
  const model = m.message && m.message.model;
  // "<synthetic>" is the CLI's placeholder on API-errored turns — not a real model.
  if (model && model.charAt(0) !== "<") {
    if (state.replayingHistory) state.historyModel = model;
    else state.turnModel = model;
  }
  const container = (!m.parent_tool_use_id && state.lastStreamContainer)
    ? state.lastStreamContainer
    : ensureAssistantContainer(m.parent_tool_use_id);
  const content = (m.message && m.message.content) || [];
  for (const block of content) {
    if (block.type === "text") {
      if (!container.querySelector(".text-block") || m.parent_tool_use_id) {
        const el = newTextBlock(container);
        el.dataset.src = block.text || "";
        finalizeTextBlock(el);
      } else {
        const els = container.querySelectorAll(".text-block");
        const last = els[els.length - 1];
        if (last && last.dataset.src.trim() !== (block.text || "").trim()) {
          last.dataset.src = block.text || "";
          last.classList.remove("hl-done");
          finalizeTextBlock(last);
        }
      }
    } else if (block.type === "tool_use") {
      if (!state.toolCards.has(block.id))
        newToolCard(container, block.id, block.name, block.input || {});
      else {
        const card = state.toolCards.get(block.id);
        if (card.dataset.tool === "TodoWrite") {
          const body = card.querySelector(".tool-body");
          body.innerHTML = "";
          body.appendChild(renderTodoCard(block.input || {}));
        }
      }
    } else if (block.type === "thinking" && !container.querySelector(".thinking")) {
      const el = newThinkingBlock(container);
      el.querySelector(".think-text").textContent = block.thinking || "";
      finishThinking(el);
    }
  }
  finishLiveMessage();
  if (!m.parent_tool_use_id) state.lastStreamContainer = null;
  highlightIn(container);
  updateWelcome();
  scrollBottom();
}

function handleUserMessage(m) {
  const content = (m.message && m.message.content) || [];
  let hadToolResult = false;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === "tool_result") {
        hadToolResult = true;
        attachToolResult(block.tool_use_id, block.content, !!block.is_error, m.tool_use_result);
      }
    }
  }
  if (!hadToolResult && state.replayingHistory) {
    let text = "";
    const images = [];
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
      text = content.filter(b => b.type === "text").map(b => b.text || "").join("\n");
      for (const b of content)
        if (b.type === "image" && b.source && b.source.type === "base64")
          images.push({ mediaType: b.source.media_type, data: b.source.data });
    }
    text = (text || "").trim();
    if ((text && !text.startsWith("<") && !text.startsWith("Caveat:")) || images.length) {
      flushHistoryModelFooter(); // close the previous turn's assistant run
      addUserMessage(text, images);
    }
  }
}

function handleResult(m) {
  setWorking(false);
  finishLiveMessage();
  const footer = document.createElement("div");
  footer.className = "turn-footer";
  const cost = typeof m.total_cost_usd === "number" && m.total_cost_usd > 0 ? "$" + m.total_cost_usd.toFixed(4) : "";
  const secs = m.duration_ms ? (m.duration_ms / 1000).toFixed(1) + "s" : "";
  const tokens = m.usage ? ((m.usage.output_tokens || 0) + "↑ " + (m.usage.input_tokens || 0) + "↓") : "";
  const modelLabel = state.turnModel ? friendlyModelName(state.turnModel) : "";
  footer.textContent = [secs, tokens, cost, modelLabel].filter(Boolean).join(" · ");
  if (state.turnModel) footer.title = "Model: " + state.turnModel;
  state.turnModel = null;
  messagesEl.appendChild(footer);
  $("turn-stats").textContent = footer.textContent;

  if (m.is_error && typeof m.result === "string") {
    if (isAuthError(m.result)) {
      if (m.result.includes("Not logged in") && !state.sessionId) {
        // Cold start with no conversation yet — the welcome screen's sign-in flow.
        state.signinRequired = true;
        messagesEl.innerHTML = "";
        state.toolCards.clear();
        updateWelcome();
      } else {
        // Auth died mid-conversation (e.g. "OAuth session expired and could not be
        // refreshed") — keep the transcript and offer sign-in + retry.
        showAuthRecovery(m.result);
      }
    } else {
      banner("error", m.result);
    }
  } else {
    state.authBroken = false; // a successful turn proves auth works again
  }
  scrollBottom();
}

/* ---------- auth recovery (sign-in expired mid-conversation) ---------- */
function isAuthError(text) {
  return /not logged in|failed to authenticate|oauth[^.]*?(expired|revoked|invalid)|invalid (api key|bearer)|please run \/login|unauthorized|\b401\b/i.test(text || "");
}

function clearAuthBanner() {
  const old = bannersEl.querySelector(".banner.auth-broken");
  if (old) old.remove();
}

function showAuthRecovery(text) {
  state.authBroken = true;
  clearAuthBanner(); // one recovery banner, however many turns fail
  const div = banner("error", "Claude needs to sign in again — " + text, [
    ["Sign in…", () => {
      post({ cmd: "login" });
      banner("info", "A sign-in window opened. Finish signing in there — your message will be retried automatically.");
    }],
    ["Retry", retryLastSend],
  ]);
  if (div) div.classList.add("auth-broken");
}

function retryLastSend() {
  clearAuthBanner();
  if (!state.lastSend) {
    banner("info", "Nothing to retry — type your message again.");
    return;
  }
  state.pendingRetrySend = state.lastSend;
  if (state.sessionId) {
    // Respawn the CLI with fresh credentials and resume this conversation; the
    // queued prompt re-sends once the new process answers initialize (kind:"init").
    state.pendingResumeTitle = state.sessionTitle;
    post({ cmd: "resume", sessionId: state.sessionId, prefs: currentPrefs() });
  } else {
    post({ cmd: "newSession", prefs: currentPrefs() });
  }
}

function flushPendingRetry() {
  // Fires from both kind:"init" (session ready) and history-replay completion;
  // send only once both have happened so the resend lands after the transcript.
  const p = state.pendingRetrySend;
  if (!p || !state.initReceived || state.replayingHistory) return;
  state.pendingRetrySend = null;
  addUserMessage(p.text || "(image)", p.attachments || []);
  post({ cmd: "send", text: p.text, blocks: p.blocks });
  setWorking(true);
}

/* ---------- diff rendering (shared by permission cards and tool cards) ---------- */
function diffLineHtml(cls, num, sign, text) {
  return '<span class="diff-line ' + cls + '">' +
    '<span class="ln">' + (num != null ? num : "") + "</span>" +
    '<span class="sign">' + sign + "</span>" + escapeHtml(text) + "</span>";
}
function blockDiffHtml(oldStr, newStr, startLine) {
  let html = "";
  if (oldStr)
    oldStr.split("\n").forEach((l, i) => html += diffLineHtml("del", startLine != null ? startLine + i : null, "−", l));
  if (newStr)
    newStr.split("\n").forEach((l, i) => html += diffLineHtml("add", startLine != null ? startLine + i : null, "+", l));
  return html;
}
function editInputDiffHtml(name, input, hints) {
  if (name === "Edit")
    return blockDiffHtml(input.old_string, input.new_string, hints && hints[0] != null ? hints[0] : null);
  if (name === "MultiEdit" && Array.isArray(input.edits)) {
    let html = "";
    input.edits.forEach((e, i) => {
      if (i) html += '<span class="diff-line ctx"><span class="ln"></span><span class="sign"></span>···</span>';
      html += blockDiffHtml(e.old_string, e.new_string, hints && hints[i] != null ? hints[i] : null);
    });
    return html;
  }
  if (name === "Write")
    return blockDiffHtml(null, (input.content || "").slice(0, 12000), hints && hints[0] != null ? hints[0] : 1);
  return null;
}
/* structuredPatch from the CLI's tool result: hunks with real line numbers + context */
function patchHtml(patch) {
  let html = "";
  patch.forEach((hunk, hi) => {
    if (hi) html += '<span class="diff-line ctx"><span class="ln"></span><span class="sign"></span>···</span>';
    let oldLine = hunk.oldStart || 1, newLine = hunk.newStart || 1;
    for (const raw of hunk.lines || []) {
      const sign = raw[0], text = raw.slice(1);
      if (sign === "+") html += diffLineHtml("add", newLine++, "+", text);
      else if (sign === "-") html += diffLineHtml("del", oldLine++, "−", text);
      else { html += diffLineHtml("ctx", newLine, " ", text); oldLine++; newLine++; }
    }
  });
  return html;
}
function firstPatchLine(patch) {
  try { return patch[0].newStart || patch[0].oldStart || null; } catch { return null; }
}

/* ---------- permission cards ---------- */
const permCards = new Map();
function permPreviewHtml(name, input, hints) {
  const editDiff = editInputDiffHtml(name, input, hints);
  if (editDiff != null) return '<div class="perm-preview">' + editDiff + "</div>";
  if (name === "Bash" || name === "PowerShell")
    return '<div class="perm-preview plain">' + escapeHtml(input.command || "") + "</div>";
  return '<div class="perm-preview plain">' + escapeHtml(JSON.stringify(input, null, 2).slice(0, 3000)) + "</div>";
}
function showPermission(requestId, request) {
  if (request.tool_name === "AskUserQuestion" &&
      request.input && Array.isArray(request.input.questions) && request.input.questions.length) {
    showQuestionCard(requestId, request);
    return;
  }
  setWorking(false);
  const card = document.createElement("div");
  const suggestions = request.permission_suggestions || [];
  const isPlan = request.tool_name === "ExitPlanMode";
  card.className = "perm-card" + (isPlan ? " plan" : "");
  const title = isPlan
    ? "Claude has finished planning"
    : request.title || ("Allow " + displayToolName(request.tool_name) + "?");
  const hints = request._vsclaude_line_hints;
  const preview = isPlan
    ? '<div class="perm-preview md-plan md">' + renderMarkdown((request.input || {}).plan || "") + "</div>"
    : permPreviewHtml(request.tool_name, request.input || {}, hints);
  const allowLabel = isPlan ? "Approve plan" : "Allow";
  const denyLabel = isPlan ? "Keep planning" : "Deny";
  const filePath = (request.input || {}).file_path;
  const fileRow = filePath
    ? '<div class="perm-sub file-link" data-path="' + escapeHtml(filePath) + '" data-line="' +
      (hints && hints[0] != null ? hints[0] : "") + '" title="Open in editor">' + escapeHtml(filePath) + "</div>"
    : (request.description ? '<div class="perm-sub">' + escapeHtml(request.description) + "</div>" : "");
  card.innerHTML =
    '<div class="perm-head"><span class="tool-icon">' + (isPlan ? ICONS.planDoc : ICONS.shield) + "</span>" +
    escapeHtml(title) + "</div>" +
    fileRow +
    preview +
    (request.decision_reason ? '<div class="perm-note">' + escapeHtml(request.decision_reason) + "</div>" : "") +
    '<div class="perm-actions">' +
    '<button class="allow">' + allowLabel + "</button>" +
    (!isPlan && suggestions.length && !request.suppress_always_allow_rule ? '<button class="always">Always allow</button>' : "") +
    '<button class="deny">' + denyLabel + "</button>" +
    '<span class="hint">Alt+Y / Alt+N</span>' +
    "</div>";
  messagesEl.appendChild(card);
  permCards.set(requestId, card);
  highlightIn(card);

  const answer = (allow, always) => {
    post({
      cmd: "permission", requestId, allow, always: !!always,
      input: request.input || {}, suggestions,
      message: allow ? undefined
        : isPlan ? "The user wants to keep planning. Continue refining the plan based on their feedback."
        : "The user denied this tool use.",
    });
    resolvePermCard(requestId, allow ? (always ? "Always allowed ✓" : isPlan ? "Plan approved ✓" : "Allowed ✓") : (isPlan ? "Continuing to plan" : "Denied ✕"));
    setWorking(true);
  };
  card.querySelector(".allow").addEventListener("click", () => answer(true, false));
  const alwaysBtn = card.querySelector(".always");
  if (alwaysBtn) alwaysBtn.addEventListener("click", () => answer(true, true));
  card.querySelector(".deny").addEventListener("click", () => answer(false, false));
  card._answer = answer;
  updateWelcome();
  scrollBottom(true);
}
/* Claude's multiple-choice questions (AskUserQuestion) — a real answer UI,
   not a permission prompt. Answers travel back as updatedInput.answers. */
function showQuestionCard(requestId, request) {
  setWorking(false);
  const questions = request.input.questions;
  const card = document.createElement("div");
  card.className = "perm-card question";
  card.dataset.kind = "question";

  const selections = questions.map(() => new Set());
  const otherInputs = [];
  const singleShot = questions.length === 1 && !questions[0].multiSelect;

  const head = document.createElement("div");
  head.className = "perm-head";
  head.innerHTML = '<span class="tool-icon">' + ICONS.bot + "</span>" +
    (questions.length > 1 ? "Claude has questions" : "Claude has a question");
  card.appendChild(head);

  questions.forEach((q, qi) => {
    const wrap = document.createElement("div");
    wrap.className = "q-block";
    wrap.innerHTML =
      (q.header ? '<span class="q-chip">' + escapeHtml(q.header) + "</span>" : "") +
      '<div class="q-text">' + escapeHtml(q.question || "") + "</div>";
    const list = document.createElement("div");
    list.className = "q-options";
    (q.options || []).forEach((opt) => {
      const label = typeof opt === "string" ? opt : opt.label || "";
      const description = typeof opt === "string" ? "" : opt.description || "";
      const btn = document.createElement("button");
      btn.className = "q-option";
      btn.innerHTML = '<span class="q-label">' + escapeHtml(label) + "</span>" +
        (description ? '<span class="q-desc">' + escapeHtml(description) + "</span>" : "");
      btn.addEventListener("click", () => {
        if (q.multiSelect) {
          if (selections[qi].has(label)) selections[qi].delete(label);
          else selections[qi].add(label);
          btn.classList.toggle("selected");
          refreshSubmit();
        } else {
          selections[qi].clear();
          selections[qi].add(label);
          list.querySelectorAll(".q-option").forEach(b => b.classList.remove("selected"));
          btn.classList.add("selected");
          if (singleShot) submit();
          else refreshSubmit();
        }
      });
      list.appendChild(btn);
    });
    wrap.appendChild(list);
    const other = document.createElement("input");
    other.type = "text";
    other.className = "q-other";
    other.placeholder = "Other…";
    other.addEventListener("input", refreshSubmit);
    other.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && canSubmit()) { e.preventDefault(); submit(); }
      e.stopPropagation();
    });
    otherInputs[qi] = other;
    wrap.appendChild(other);
    card.appendChild(wrap);
  });

  const actions = document.createElement("div");
  actions.className = "perm-actions";
  const submitBtn = document.createElement("button");
  submitBtn.className = "allow";
  submitBtn.textContent = "Answer";
  submitBtn.disabled = true;
  submitBtn.addEventListener("click", () => { if (canSubmit()) submit(); });
  const skipBtn = document.createElement("button");
  skipBtn.className = "deny";
  skipBtn.textContent = "Skip";
  skipBtn.addEventListener("click", () => {
    post({ cmd: "permission", requestId, allow: false, always: false,
           input: request.input, suggestions: [],
           message: "The user chose not to answer the question. Continue without this information." });
    resolvePermCard(requestId, "Skipped");
    setWorking(true);
  });
  actions.appendChild(submitBtn);
  actions.appendChild(skipBtn);
  card.appendChild(actions);
  if (singleShot) actions.style.display = "none";

  function answered(qi) {
    return selections[qi].size > 0 || (otherInputs[qi] && otherInputs[qi].value.trim());
  }
  function canSubmit() { return questions.every((_, qi) => answered(qi)); }
  function refreshSubmit() { submitBtn.disabled = !canSubmit(); }
  function submit() {
    const answers = {};
    questions.forEach((q, qi) => {
      const labels = Array.from(selections[qi]);
      const other = otherInputs[qi] ? otherInputs[qi].value.trim() : "";
      if (other) labels.push(other);
      answers[q.question] = q.multiSelect ? labels : (labels[0] || "");
    });
    const input = Object.assign({}, request.input, { answers });
    post({ cmd: "permission", requestId, allow: true, always: false, input, suggestions: [] });
    const summary = Object.values(answers).map(v => Array.isArray(v) ? v.join(", ") : v).join(" · ");
    resolvePermCard(requestId, "Answered: " + summary);
    setWorking(true);
  }

  messagesEl.appendChild(card);
  permCards.set(requestId, card);
  updateWelcome();
  scrollBottom(true);
}

function resolvePermCard(requestId, label) {
  const card = permCards.get(requestId);
  if (!card) return;
  permCards.delete(requestId);
  const actions = card.querySelector(".perm-actions");
  if (actions) actions.innerHTML = '<span class="perm-resolved">' + escapeHtml(label) + "</span>";
  card.style.opacity = "0.8";
}
document.addEventListener("keydown", (e) => {
  if (!e.altKey || permCards.size === 0) return;
  const last = Array.from(permCards.values()).pop();
  if (!last || !last._answer) return;
  if (e.key.toLowerCase() === "y") { e.preventDefault(); last._answer(true, false); }
  if (e.key.toLowerCase() === "n") { e.preventDefault(); last._answer(false, false); }
});

/* ---------- banners ---------- */
function banner(level, text, actions) {
  const div = document.createElement("div");
  div.className = "banner " + level;
  const span = document.createElement("span");
  span.textContent = text;
  div.appendChild(span);
  const btns = document.createElement("span");
  btns.style.display = "flex"; btns.style.gap = "6px";
  (actions || []).forEach(([label, fn]) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.addEventListener("click", () => { fn(); div.remove(); });
    btns.appendChild(b);
  });
  const close = document.createElement("button");
  close.textContent = "✕";
  close.className = "icon-btn";
  close.addEventListener("click", () => div.remove());
  btns.appendChild(close);
  div.appendChild(btns);
  bannersEl.appendChild(div);
  while (bannersEl.children.length > 3) bannersEl.firstChild.remove();
  if (level === "info" && !actions) setTimeout(() => div.remove(), 7000);
  return div;
}

/* ---------- host messages ---------- */
function handleHostMessage(data) {
  switch (data.kind) {
    case "claude": handleClaude(data.msg); break;
    case "state": applyState(data.state); break;
    case "init": applyInit(data.data); state.initReceived = true; flushPendingRetry(); break;
    case "models": applyModelsPush(data.models); break;
    case "modelSet": acceptPendingCustomModel(data.model); break;
    case "modelRejected": rejectPendingCustomModel(data.model); break;
    case "permission": showPermission(data.requestId, data.request); break;
    case "permissionCancel": resolvePermCard(data.requestId, "Handled elsewhere"); break;
    case "sessions": state.sessions = data.list || []; renderSessions(); break;
    case "suggestions": applySuggestions(data); break;
    case "theme": applyTheme(data); break;
    case "insertMention": insertAtCursor(data.text); inputEl.focus(); break;
    case "ideSelection": applyIdeSelection(data); break;
    case "context": applyContextUsage(data.data); break;
    case "banner": banner(data.level || "info", data.text || ""); break;
    case "stderr": console.warn("[claude stderr]", data.line); break;
    case "authState":
      if (data.loggedIn) {
        $("signin-waiting").classList.add("hidden");
        if (state.authBroken) {
          // Sign-in restored mid-conversation: resume it and resend the failed prompt.
          state.authBroken = false;
          banner("info", "Signed in — retrying your last message.");
          retryLastSend();
        } else if (state.signinRequired) {
          state.signinRequired = false;
          banner("info", "Signed in — starting your session.");
          post({ cmd: "newSession", prefs: lsGet("vsclaude.lastPrefs", null) });
        }
        updateWelcome();
      }
      break;
    case "sessionStarting":
      messagesEl.innerHTML = "";
      state.toolCards.clear(); permCards.clear(); finishLiveMessage();
      state.lastStreamContainer = null;
      state.initReceived = false;
      state.sessionTitle = data.resume ? (state.pendingResumeTitle || null) : null;
      state.manualTitle = false;
      state.turnModel = null; state.historyModel = null;
      $("session-title").textContent = state.sessionTitle || APP_TITLE;
      state.pendingResumeTitle = null;
      showLoading(data.resume ? "Loading conversation…" : "Starting Claude…");
      updateWelcome();
      break;
    case "history":
      renderHistoryChunked(data.messages || [], data.remaining || 0, data.total || (data.messages || []).length);
      break;
    case "historyPrepend":
      renderHistoryPrepend(data.messages || [], data.remaining || 0);
      break;
    case "usage":
      applyUsage(data.data);
      break;
    case "workspaceChanged":
      // The solution changed under us (opened late at startup, or switched). Re-home the
      // chat: silently when nothing was said yet, with a note when a conversation existed
      // (it stays resumable from the previous workspace's history).
      if (data.hadConversation)
        banner("info", "Solution changed — started a new conversation in this workspace. The previous chat remains in the old workspace's history.");
      post({ cmd: "newSession", prefs: lsGet("vsclaude.lastPrefs", null) });
      break;
    case "sessionTitle":
      // The CLI's AI-generated summary replaces the first-words placeholder;
      // a manual rename always wins.
      if (!state.manualTitle && data.title) {
        state.sessionTitle = data.title.slice(0, 60);
        $("session-title").textContent = state.sessionTitle;
      }
      break;
    case "exited":
      setWorking(false);
      hideLoading();
      if (!state.signinRequired)
        banner("warning", "The Claude process exited (code " + data.code + ").", [["Restart", () => post({ cmd: "newSession" })]]);
      break;
  }
}

/* Big transcripts render in chunks so the overlay paints and the UI stays responsive. */
async function renderHistoryChunked(msgs, remaining, total) {
  showLoading("Loading conversation…");
  state.replayingHistory = true;
  const CHUNK = 40;
  try {
    for (let i = 0; i < msgs.length; i += CHUNK) {
      const end = Math.min(i + CHUNK, msgs.length);
      for (let j = i; j < end; j++) {
        try { handleClaude(msgs[j]); } catch {}
      }
      if (msgs.length > CHUNK)
        $("loading-label").textContent = "Loading conversation… " + end + " / " + msgs.length;
      await new Promise(r => setTimeout(r, 0));
    }
  } finally {
    flushHistoryModelFooter(); // label the final assistant run
    state.replayingHistory = false;
    state.lastStreamContainer = null;
    finishLiveMessage();
  }
  const divider = document.createElement("div");
  divider.className = "turn-footer";
  divider.textContent = "resumed · " + (total || msgs.length) + " entries" +
    (remaining > 0 ? " (" + remaining + " earlier not shown yet)" : "");
  messagesEl.appendChild(divider);
  updateEarlierButton(remaining);
  setWorking(false);
  highlightIn(messagesEl);
  updateWelcome();
  hideLoading();
  scrollBottom(true);
  flushPendingRetry(); // an auth-recovery resend waits until the replay is on screen
}

/* Older pages render into a detached fragment, then insert at the top with the
   viewport anchored so what you were reading doesn't move. */
async function renderHistoryPrepend(msgs, remaining) {
  const btn = document.getElementById("load-earlier");
  if (btn) { btn.disabled = true; btn.textContent = "Loading…"; }
  const frag = document.createElement("div");
  const savedLive = state.liveMessage, savedStream = state.lastStreamContainer, savedBlocks = state.liveBlocks;
  state.liveMessage = null; state.liveBlocks = []; state.lastStreamContainer = null;
  state.replayingHistory = true;
  state.renderTarget = frag;
  try {
    const CHUNK = 40;
    for (let i = 0; i < msgs.length; i += CHUNK) {
      for (let j = i; j < Math.min(i + CHUNK, msgs.length); j++) {
        try { handleClaude(msgs[j]); } catch {}
      }
      await new Promise(r => setTimeout(r, 0));
    }
  } finally {
    flushHistoryModelFooter(); // still targeting the fragment
    state.replayingHistory = false;
    state.renderTarget = null;
    state.liveMessage = savedLive; state.lastStreamContainer = savedStream; state.liveBlocks = savedBlocks;
  }
  highlightIn(frag);
  const prevHeight = messagesEl.scrollHeight;
  const prevTop = messagesEl.scrollTop;
  const anchor = btn ? btn.nextSibling : messagesEl.firstChild;
  while (frag.firstChild) messagesEl.insertBefore(frag.firstChild, anchor);
  messagesEl.scrollTop = prevTop + (messagesEl.scrollHeight - prevHeight);
  updateEarlierButton(remaining);
}

function updateEarlierButton(remaining) {
  let btn = document.getElementById("load-earlier");
  if (remaining > 0) {
    if (!btn) {
      btn = document.createElement("button");
      btn.id = "load-earlier";
      btn.addEventListener("click", () => post({ cmd: "loadEarlier" }));
      messagesEl.insertBefore(btn, messagesEl.firstChild);
    }
    btn.disabled = false;
    btn.textContent = "↑ Load earlier messages (" + remaining + " more)";
  } else if (btn) {
    btn.remove();
  }
}

/* ---------- usage meter (plan limits) ---------- */
const USAGE_THRESHOLDS = [75, 85, 95];
function thresholdLevel(pct) {
  let level = 0;
  for (const t of USAGE_THRESHOLDS) if (pct >= t) level = t;
  return level;
}
function fmtReset(iso) {
  if (!iso) return "later";
  const d = new Date(iso);
  if (isNaN(d)) return "later";
  const now = new Date();
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
}
function applyUsage(data) {
  const rl = (data && data.rate_limits) || {};
  const mk = (w) => w && typeof w.utilization === "number"
    ? { pct: Math.round(w.utilization), resets: w.resets_at || null } : null;
  if (mk(rl.five_hour)) state.usage.five = mk(rl.five_hour);
  if (mk(rl.seven_day)) state.usage.seven = mk(rl.seven_day);
  // Per-model weekly caps (e.g. Fable) — the CLI reports them in model_scoped.
  if (Array.isArray(rl.model_scoped))
    state.usage.models = rl.model_scoped
      .filter(m => m && m.display_name && typeof m.utilization === "number")
      .map(m => ({ label: m.display_name, pct: Math.round(m.utilization), resets: m.resets_at || null }));
  const ex = rl.extra_usage;
  state.usage.extraPct = ex && ex.is_enabled && typeof ex.utilization === "number"
    ? Math.round(ex.utilization) : state.usage.extraPct;
  renderUsage();
}
function renderUsage() {
  const chip = $("usage-chip");
  const f = state.usage.five, s = state.usage.seven, models = state.usage.models || [];
  if (!f && !s) { chip.classList.add("hidden"); return; }
  chip.classList.remove("hidden");
  chip.textContent = [f ? "5h " + f.pct + "%" : null, s ? "7d " + s.pct + "%" : null].filter(Boolean).join(" · ");
  const worst = Math.max(f ? f.pct : 0, s ? s.pct : 0, ...models.map(m => m.pct));
  chip.classList.toggle("warn", worst >= 75 && worst < 90);
  chip.classList.toggle("err", worst >= 90);
  chip.title = [
    f ? "5-hour window: " + f.pct + "% used — resets " + fmtReset(f.resets) : null,
    s ? "7-day window: " + s.pct + "% used — resets " + fmtReset(s.resets) : null,
    ...models.map(m => m.label + " weekly: " + m.pct + "% used — resets " + fmtReset(m.resets)),
    state.usage.extraPct != null ? "Extra usage credits: " + state.usage.extraPct + "% of monthly budget used" : null,
    "Click to refresh",
  ].filter(Boolean).join("\n");
  updateUsageBanner();
}
function updateUsageBanner() {
  const f = state.usage.five, s = state.usage.seven, models = state.usage.models || [];
  const worst = [
    f && { ...f, label: "5-hour" },
    s && { ...s, label: "7-day" },
    ...models.map(m => ({ ...m, label: m.label + " weekly" })),
  ].filter(Boolean).sort((a, b) => b.pct - a.pct)[0];
  let el = document.getElementById("usage-banner");
  if (!worst) { if (el) el.remove(); return; }
  const level = thresholdLevel(worst.pct);
  if (level === 0) { state.usage.dismissedLevel = 0; if (el) el.remove(); return; }
  if (level <= state.usage.dismissedLevel) { if (el) el.remove(); return; }
  const text = "Usage at " + worst.pct + "% of your " + worst.label + " limit — resets " + fmtReset(worst.resets) + ".";
  if (el) { el.querySelector(".u-text").textContent = text; return; }
  el = document.createElement("div");
  el.id = "usage-banner";
  el.className = "banner " + (worst.pct >= 95 ? "error" : "warning");
  const span = document.createElement("span");
  span.className = "u-text";
  span.textContent = text;
  el.appendChild(span);
  const close = document.createElement("button");
  close.textContent = "✕";
  close.className = "icon-btn";
  close.addEventListener("click", () => {
    state.usage.dismissedLevel = thresholdLevel(Math.max(f ? f.pct : 0, s ? s.pct : 0, ...models.map(m => m.pct)));
    el.remove();
  });
  el.appendChild(close);
  $("usage-banner-slot").appendChild(el);
}
$("usage-chip").addEventListener("click", () => post({ cmd: "refreshUsage" }));

function handleClaude(m) {
  switch (m.type) {
    case "system":
      if (m.subtype === "init") {
        state.sessionId = m.session_id;
        if (!state.replayingHistory) hideLoading();
        if (m.permissionMode) { state.mode = m.permissionMode; $("mode-select").value = m.permissionMode; }
        if (m.model) {
          // The authoritative "what is actually serving this session" signal — on resume
          // the CLI restores the session's model; reflect it in the picker + tooltip.
          state.runningModel = m.model;
          const sel = $("model-select");
          // Several catalog rows can share a resolvedModel (default + the tier alias),
          // so leave the selection alone whenever it's already consistent.
          const current = state.models.find(x => x.value === sel.value);
          const consistent = sel.value === m.model || (current && current.resolvedModel === m.model);
          if (!consistent && document.activeElement !== sel) {
            const match = state.models.find(x => x.value === m.model || x.resolvedModel === m.model);
            const target = match ? match.value : (Array.from(sel.options).some(o => o.value === m.model) ? m.model : null);
            if (target) sel.value = target;
          }
          updateEffortDial();
          updateModelTooltip();
        }
        break;
      }
      if (m.subtype === "status") { if (m.status) setWorking(true); if (m.permissionMode) { state.mode = m.permissionMode; $("mode-select").value = m.permissionMode; } break; }
      if (m.subtype === "session_state_changed") { if (m.state === "idle") setWorking(false); else if (m.state === "running") setWorking(true); break; }
      if (m.subtype === "permission_denied") {
        banner("warning", "Auto-denied " + m.tool_name + (m.decision_reason ? " — " + m.decision_reason : ""));
        break;
      }
      break;
    case "stream_event": handleStreamEvent(m.event || {}, m.parent_tool_use_id); if (!state.replayingHistory) setWorking(true); break;
    case "assistant": handleAssistantMessage(m); break;
    case "user": handleUserMessage(m); break;
    case "result": handleResult(m); break;
    case "rate_limit_event": {
      const info = m.rate_limit_info || {};
      // Live-update the meter; resetsAt arrives as unix seconds here.
      if (typeof info.utilization === "number" && info.rateLimitType) {
        const entry = {
          pct: Math.round(info.utilization),
          resets: info.resetsAt ? new Date(info.resetsAt * 1000).toISOString() : null,
        };
        if (info.rateLimitType === "five_hour") state.usage.five = entry;
        else if (info.rateLimitType.startsWith("seven_day")) state.usage.seven = entry;
        renderUsage();
      }
      if (info.status === "rejected")
        banner("error", "Rate limit reached — requests are being rejected until the window resets.");
      break;
    }
  }
}

function applyState(s) {
  state.running = s.running; state.cwd = s.cwd || "";
  if (s.showPreviousModels !== undefined && s.showPreviousModels !== state.showPreviousModels) {
    state.showPreviousModels = s.showPreviousModels;
    if (state.models.length) rebuildModelPicker(state.models, {});
  }
  if (s.mode) { state.mode = s.mode; $("mode-select").value = s.mode; }
  state.sessionId = s.sessionId || state.sessionId;
  state.ideConnections = s.ideConnections || 0;
  state.mock = !!s.mock;
  if (s.effort) $("effort-select").value = s.effort;
  if (s.model) {
    const sel = $("model-select");
    if (Array.from(sel.options).some(o => o.value === s.model)) sel.value = s.model;
  }
  $("mock-badge").classList.toggle("hidden", !state.mock);
  const dot = $("ide-dot");
  const ideOn = s.sdkIde || state.ideConnections > 0;
  dot.className = "dot " + (ideOn ? "on" : "off");
  dot.title = ideOn
    ? "IDE integration active — Claude can see your selection, open files and diagnostics" +
      (state.ideConnections > 0 ? " (+" + state.ideConnections + " terminal session)" : "")
    : "IDE integration off";
  const cwdEl = $("cwd");
  cwdEl.textContent = shortPath(state.cwd);
  cwdEl.title = state.cwd + (s.exePath ? "\nCLI: " + s.exePath : "");
}
function shortPath(p) {
  const parts = (p || "").replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.length > 2 ? parts.slice(-2).join("/") : p;
}

function applyInit(data) {
  // The initialize control response is the reliable "session ready" signal: the real CLI
  // sends it at spawn, whereas the system/init stream message is deferred until the first
  // turn. Hide the loading overlay here so first load doesn't sit on "Starting Claude…".
  if (!state.replayingHistory) hideLoading();
  state.initData = data;
  state.commands = data.commands || [];
  state.account = data.account || null;
  rebuildModelPicker(data.models || [], { toastDiff: true });
  if (state.account && state.account.email) {
    const plan = state.account.subscriptionType ? " · " + cap(state.account.subscriptionType) + " plan" : "";
    $("session-title").title = "Signed in as " + state.account.email + plan + "\nDouble-click to rename this session";
    $("account-chip").textContent = state.account.email + plan;
    state.signinRequired = false;
    updateWelcome();
  }
}
function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

/* ---------- model picker ---------- */

/* Previous-generation models, mirroring the desktop app's "More models" list.
   These are stable API aliases (no date suffixes), all verified accepted by
   set_model. Entries already served by the current catalog are hidden at render. */
const PREVIOUS_MODELS = [
  { id: "claude-opus-4-8", label: "Opus 4.8" },
  { id: "claude-opus-4-7", label: "Opus 4.7" },
  { id: "claude-opus-4-6", label: "Opus 4.6" },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
];

/* "Opus" alone doesn't say WHICH Opus. The CLI catalog's description leads with the
   resolved version ("Opus 4.8 with 1M context · Best for…"), so use that segment as
   the visible label; the tail and the concrete model id go into the tooltip. */
function modelOptionLabel(m) {
  const dn = (m.displayName || m.value || "").trim();
  let seg = (m.description || "").split(/\s+[·•‧∙–—|]\s+/)[0].trim();
  if (seg.length > 44) seg = seg.slice(0, 44).trimEnd() + "…";
  if (!seg) return dn;
  if (/^default/i.test(dn)) return "Default: " + seg;
  return seg;
}

function modelOptionTitle(m) {
  const lines = [];
  if (m.description) lines.push(m.description);
  if (m.resolvedModel) lines.push("Model id: " + m.resolvedModel);
  return lines.join("\n");
}

/* The CLI appends a hint row for the session's active model when it's outdated or
   nonstandard (captured live: {value: "claude-opus-4.7", displayName: "Opus 4",
   description: "Newer version available · select Opus for Opus 5"}). It isn't part of
   the lineup — filter it (and never learn it), surfacing the CLI's advice as a notice.
   The structural clause catches any rowless-shape sentinel defensively. */
function isCatalogSentinel(m) {
  const text = ((m.displayName || "") + " " + (m.description || "") + " " + (m.value || "")).toLowerCase();
  if (text.indexOf("newer version available") >= 0) return true;
  return !m.resolvedModel && !m.description;
}

function rebuildModelPicker(models, opts) {
  const sel = $("model-select");
  const previous = sel.value;
  const raw = models || [];
  const hintRow = raw.find(isCatalogSentinel);
  if (hintRow && !state.cliUpdateNoticeShown) {
    state.cliUpdateNoticeShown = true;
    const what = hintRow.value ? hintRow.value + ": " : "";
    banner("info", what + (hintRow.description || "a newer option is available for this model."));
  }
  state.models = raw.filter(m => !isCatalogSentinel(m));
  const baseId = v => (v || "").toLowerCase().replace(/\[1m\]$/, "");

  // Surface catalog changes (the CLI updates itself; new sessions pick up new models).
  if (opts && opts.toastDiff) {
    const known = lsGet("vsclaude.modelCatalog", null);
    const now = state.models.map(m => ({
      v: m.value, l: modelOptionLabel(m), r: baseId(m.resolvedModel), d: m.displayName || m.value,
    }));
    if (Array.isArray(known)) {
      const fresh = now.filter(n => !known.some(k => k.v === n.v)).map(n => n.l);
      if (fresh.length) banner("info", "New model" + (fresh.length > 1 ? "s" : "") + " available: " + fresh.join(", "));
      // Alias promotions: same picker entry, new underlying model ("Opus" → Opus 5).
      const promoted = [];
      for (const n of now) {
        const k = known.find(x => x.v === n.v);
        if (k && k.r && n.r && k.r !== n.r) {
          const msg = n.d + " is now " + friendlyModelName(n.r);
          if (!promoted.includes(msg)) promoted.push(msg);
        }
      }
      if (promoted.length) banner("info", "Model update: " + promoted.join(" · "));
    }
    lsSet("vsclaude.modelCatalog", now);

    // Learn the concrete ids serving the current lineup — when one stops being
    // current (a new generation ships), it automatically becomes a "previous model".
    // The timestamp is when the id was last seen current, so demotions rank by recency.
    const seen = lsGet("vsclaude.seenCurrentModels", {});
    for (const m of state.models) {
      for (const cand of [m.resolvedModel, m.value]) {
        const b = baseId(cand);
        if (b && b.indexOf("claude-") === 0) seen[b] = { l: friendlyModelName(cand), t: Date.now() };
      }
    }
    lsSet("vsclaude.seenCurrentModels", seen);
  }

  sel.innerHTML = "";
  // The CLI's catalog usually contains its own "default" row — only synthesize one if absent.
  const seen = new Set();
  if (!state.models.some(m => (m.value || "").toLowerCase() === "default")) {
    sel.innerHTML = '<option value="default">Default model</option>';
    seen.add("default");
  }
  for (const m of state.models) {
    const value = (m.value || "").toLowerCase();
    if (seen.has(value)) continue;
    seen.add(value);
    const opt = document.createElement("option");
    opt.value = m.value;
    opt.textContent = modelOptionLabel(m);
    opt.title = modelOptionTitle(m);
    if (m.supportsEffort) opt.dataset.effort = (m.supportedEffortLevels || []).join(",");
    sel.appendChild(opt);
  }

  // The catalog only lists the current lineup; older generations still work — the CLI
  // accepts any model id via set_model (verified live: claude-opus-4-7, dated snapshots).
  // Enumerate them like the desktop app's "More models", hiding any that IS current
  // here (e.g. while this CLI's "opus" still resolves to Opus 4.8, don't list 4.8 twice —
  // when the catalog moves on, it appears down here automatically).
  const group = document.createElement("optgroup");
  group.label = "Other models";
  const currentIds = new Set();
  for (const m of state.models) {
    currentIds.add(baseId(m.value));
    currentIds.add(baseId(m.resolvedModel));
  }
  if (state.showPreviousModels !== false) {
    // Seed list + the most recent demotions this machine has witnessed (capped so the
    // group can't grow unbounded — anything older is still reachable via Custom model ID).
    const pool = PREVIOUS_MODELS.slice();
    const learned = lsGet("vsclaude.seenCurrentModels", {});
    const demoted = Object.keys(learned)
      .filter(id => !currentIds.has(id) && !pool.some(p => p.id === id))
      .map(id => {
        const e = learned[id];
        return typeof e === "string" ? { id, label: e, t: 0 } : { id, label: e.l, t: e.t || 0 };
      })
      // A label that is just the raw id means the mapper couldn't prettify it — junk
      // learned before hint rows were filtered (e.g. "claude-opus-4.7"). Drop it.
      .filter(d => d.label && String(d.label).indexOf("claude-") !== 0)
      .sort((a, b) => b.t - a.t)
      .slice(0, 2);
    for (const d of demoted) pool.push({ id: d.id, label: d.label });
    // Family A→Z, then version high→low ("Opus 5" above "Opus 4.8", Opus before Sonnet).
    const sortKey = p => {
      const label = String(p.label || "");
      const m = label.match(/^([A-Za-z]+)\s+([\d.]+)$/);
      return m ? { fam: m[1], ver: parseFloat(m[2]) } : { fam: label, ver: -1 };
    };
    pool.sort((a, b) => {
      const ka = sortKey(a), kb = sortKey(b);
      return ka.fam === kb.fam ? kb.ver - ka.ver : (ka.fam < kb.fam ? -1 : 1);
    });
    for (const p of pool) {
      if (currentIds.has(p.id) || seen.has(p.id)) continue;
      seen.add(p.id);
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.label;
      opt.title = "Previous generation\nModel id: " + p.id;
      group.appendChild(opt);
    }
  }
  for (const id of lsGet("vsclaude.customModels", [])) {
    if (seen.has((id || "").toLowerCase())) continue;
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = id;
    opt.title = "Custom model id (passed to the CLI as-is)";
    group.appendChild(opt);
  }
  const custom = document.createElement("option");
  custom.value = "__custom__";
  custom.textContent = "Custom model ID…";
  group.appendChild(custom);
  sel.appendChild(group);

  if (previous && previous !== "__custom__" && Array.from(sel.options).some(o => o.value === previous))
    sel.value = previous;
  updateEffortDial();
  updateModelTooltip();
  state.lastModelsRefresh = Date.now();
}

/* Tooltip on the closed select: what's selected + what is actually serving the turns. */
function updateModelTooltip() {
  const sel = $("model-select");
  const opt = sel.options[sel.selectedIndex];
  const m = state.models.find(x => x.value === (opt ? opt.value : ""));
  const lines = [];
  if (m) { const t = modelOptionTitle(m); if (t) lines.push(t); }
  else if (opt && opt.value && opt.value !== "__custom__") lines.push("Custom model id: " + opt.value);
  if (state.runningModel) lines.push("Running now: " + state.runningModel);
  lines.push("Catalog from your Claude CLI — refreshes when you open this list or start a chat.");
  sel.title = lines.join("\n");
}

/* Fresh catalog pushed mid-session (list_models). Applying while the dropdown popup is
   open would close it under the mouse — defer until the picker loses focus. */
function applyModelsPush(models) {
  if (!Array.isArray(models) || !models.length) return;
  if (JSON.stringify(models) === JSON.stringify(state.models)) { state.lastModelsRefresh = Date.now(); return; }
  const sel = $("model-select");
  if (document.activeElement === sel) {
    state.pendingModels = models;
    const apply = () => {
      if (state.pendingModels) { rebuildModelPicker(state.pendingModels, { toastDiff: true }); state.pendingModels = null; }
      sel.removeEventListener("blur", apply);
      sel.removeEventListener("change", apply);
    };
    sel.addEventListener("blur", apply);
    sel.addEventListener("change", apply);
  } else {
    rebuildModelPicker(models, { toastDiff: true });
  }
}

/* Inline prompt for "Custom model ID…" (WebView2 has no window.prompt).
   An entered id is applied optimistically but only PERSISTED once the CLI accepts it
   (kind:"modelSet") — rejected ids never enter the saved list. */
function showCustomModelInput(previousValue) {
  let pop = $("custom-model-pop");
  if (!pop) {
    pop = document.createElement("div");
    pop.id = "custom-model-pop";
    document.body.appendChild(pop);
  }
  const customs = lsGet("vsclaude.customModels", []);
  pop.innerHTML =
    '<div class="cm-label">Model ID (e.g. claude-sonnet-4-5-20250929)</div>' +
    '<input id="custom-model-input" type="text" spellcheck="false" placeholder="claude-…">' +
    '<div class="cm-actions">' +
      (customs.length ? '<button id="custom-model-clear" class="cm-clear">Clear saved (' + customs.length + ')</button>' : '') +
      '<button id="custom-model-ok">Use model</button><button id="custom-model-cancel">Cancel</button></div>';
  pop.classList.remove("hidden");
  const input = $("custom-model-input");
  const close = () => pop.classList.add("hidden");
  const cancel = () => { close(); $("model-select").value = previousValue; updateEffortDial(); updateModelTooltip(); };
  const confirm = () => {
    const id = input.value.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9.\-_:\[\]]{2,80}$/.test(id)) { input.classList.add("invalid"); return; }
    close();
    // Optimistic display; persistence waits for the CLI's verdict.
    const sel = $("model-select");
    if (!Array.from(sel.options).some(o => o.value === id)) {
      const temp = document.createElement("option");
      temp.value = id;
      temp.textContent = id;
      temp.dataset.tempCustom = "1";
      sel.querySelector('optgroup[label="Other models"]').appendChild(temp);
    }
    sel.value = id;
    state.pendingCustomModel = id;
    state.pendingCustomRevert = previousValue;
    clearTimeout(state.pendingCustomTimer);
    state.pendingCustomTimer = setTimeout(() => rejectPendingCustomModel(id), 12000);
    post({ cmd: "setModel", model: id });
    updateEffortDial();
    updateModelTooltip();
  };
  const clearBtn = $("custom-model-clear");
  if (clearBtn) clearBtn.onclick = () => {
    lsSet("vsclaude.customModels", []);
    // Also forget learned demotions — the current lineup re-learns on the next catalog
    // application, so this only resets the auto-grown part of "Other models".
    lsSet("vsclaude.seenCurrentModels", {});
    close();
    rebuildModelPicker(state.models, {});
    $("model-select").value = previousValue;
    banner("info", "Saved custom model ids cleared.");
  };
  $("custom-model-ok").onclick = confirm;
  $("custom-model-cancel").onclick = cancel;
  input.onkeydown = (e) => {
    if (e.key === "Enter") { e.preventDefault(); confirm(); }
    if (e.key === "Escape") { e.preventDefault(); cancel(); }
  };
  input.oninput = () => input.classList.remove("invalid");
  setTimeout(() => input.focus(), 30);
}

/* CLI accepted the model — safe to remember a pending custom id. */
function acceptPendingCustomModel(model) {
  if (!state.pendingCustomModel || model !== state.pendingCustomModel) return;
  clearTimeout(state.pendingCustomTimer);
  const id = state.pendingCustomModel;
  state.pendingCustomModel = null;
  const customs = lsGet("vsclaude.customModels", []).filter(x => x !== id);
  customs.unshift(id);
  lsSet("vsclaude.customModels", customs.slice(0, 8));
  rebuildModelPicker(state.models, {});
  $("model-select").value = id;
  updateEffortDial();
  updateModelTooltip();
  saveSessionPrefs();
}

/* CLI rejected it (or no verdict arrived) — drop the temp entry and revert. */
function rejectPendingCustomModel(model) {
  if (!state.pendingCustomModel || (model && model !== state.pendingCustomModel)) return;
  clearTimeout(state.pendingCustomTimer);
  const revert = state.pendingCustomRevert || "default";
  state.pendingCustomModel = null;
  const sel = $("model-select");
  Array.from(sel.querySelectorAll("option[data-temp-custom]")).forEach(o => o.remove());
  if (Array.from(sel.options).some(o => o.value === revert)) sel.value = revert;
  updateEffortDial();
  updateModelTooltip();
}

function applyTheme(data) {
  const c = data.colors || {};
  const map = {
    background: "--bg", foreground: "--fg", border: "--border",
    inputBackground: "--input-bg", accent: "--accent",
    accentForeground: "--accent-fg", link: "--link",
  };
  for (const k in map) if (c[k]) document.documentElement.style.setProperty(map[k], c[k]);
  document.documentElement.dataset.hl = data.dark === false ? "light" : "dark";
}

function applyIdeSelection(data) {
  const chip = $("context-chip");
  if (!data.filePath || data.isEmpty) { chip.classList.add("hidden"); return; }
  const name = data.filePath.split(/[\\/]/).pop();
  chip.textContent = "⌖ " + name + ":" + data.startLine + (data.endLine !== data.startLine ? "–" + data.endLine : "") + " in context";
  chip.title = data.preview || "";
  chip.classList.remove("hidden");
}

function applyContextUsage(data) {
  const used = data.totalTokens || data.used_tokens || data.usedTokens || data.tokens_used;
  const max = data.maxTokens || data.max_tokens || data.context_window;
  const bar = $("context-bar"), fill = $("context-fill");
  if (!used || !max) { bar.style.display = "none"; return; }
  const pct = Math.min(100, Math.round((used / max) * 100));
  bar.style.display = "inline-block";
  fill.style.width = pct + "%";
  fill.style.background = pct > 85 ? "var(--err)" : pct > 65 ? "var(--warn)" : "var(--ok)";
  bar.title = "Context window: " + pct + "% used (" + used.toLocaleString() + " / " + max.toLocaleString() + " tokens)";
}

/* ---------- sessions panel ---------- */
function relTime(iso) {
  const t = new Date(iso).getTime();
  if (!t) return "";
  const mins = Math.floor((Date.now() - t) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + "m ago";
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + "h ago";
  const days = Math.floor(hours / 24);
  if (days < 7) return days + "d ago";
  return new Date(iso).toLocaleDateString();
}
function renderSessions() {
  const q = ($("sessions-search").value || "").toLowerCase();
  const list = state.sessions.filter(s => !q || (s.title || "").toLowerCase().includes(q));
  sessionsList.innerHTML = "";
  if (!list.length) {
    const empty = document.createElement("div");
    empty.className = "session-item";
    empty.textContent = q ? "No matches." : "No previous conversations in this workspace.";
    sessionsList.appendChild(empty);
  }
  for (const s of list) {
    const item = document.createElement("div");
    item.className = "session-item";
    item.innerHTML = '<div class="title">' + escapeHtml(s.title || s.sessionId) + "</div>" +
      '<div class="meta"><span>' + escapeHtml(relTime(s.lastModified)) + "</span>" +
      (s.gitBranch ? '<span class="branch">⎇ ' + escapeHtml(s.gitBranch) + "</span>" : "") + "</div>";
    item.addEventListener("click", () => {
      sessionsPanel.classList.add("hidden");
      state.pendingResumeTitle = s.title && s.title !== s.sessionId ? s.title.slice(0, 48) : null;
      post({ cmd: "resume", sessionId: s.sessionId, prefs: sessionPrefsFor(s.sessionId) });
    });
    sessionsList.appendChild(item);
  }
}
$("sessions-search").addEventListener("input", renderSessions);

/* ---------- composer ---------- */
function insertAtCursor(text) {
  const start = inputEl.selectionStart, end = inputEl.selectionEnd;
  inputEl.value = inputEl.value.slice(0, start) + text + inputEl.value.slice(end);
  inputEl.selectionStart = inputEl.selectionEnd = start + text.length;
  autoGrow();
}
function autoGrow() {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, window.innerHeight * 0.38) + "px";
}
inputEl.addEventListener("input", () => { autoGrow(); maybeSuggest(); });

function send() {
  const text = inputEl.value.trim();
  if (!text && !state.attachments.length) return;
  hideSuggest();
  const blocks = [];
  for (const a of state.attachments) {
    ensureImageType(a); // never send media_type:"" — the API needs a real mime
    blocks.push({ type: "image", source: { type: "base64", media_type: a.mediaType, data: a.data } });
  }
  if (text) blocks.push({ type: "text", text });
  addUserMessage(text || "(image)", state.attachments);
  if (!state.sessionTitle && text) {
    // Placeholder until the CLI's AI-generated summary arrives (kind:"sessionTitle").
    state.sessionTitle = text.replace(/\s+/g, " ").trim().slice(0, 48);
    $("session-title").textContent = state.sessionTitle;
  }
  saveLastPrefs();
  saveSessionPrefs();
  // Kept for the auth-recovery retry: if this turn fails with an expired sign-in,
  // the exact payload (mime-healed blocks included) can be re-sent after login.
  state.lastSend = { text, blocks, attachments: state.attachments.slice() };
  post({ cmd: "send", text, blocks });
  inputEl.value = "";
  state.attachments = [];
  renderAttachments();
  autoGrow();
  setWorking(true);
}
$("btn-send").addEventListener("click", send);
$("btn-stop").addEventListener("click", () => post({ cmd: "interrupt" }));

inputEl.addEventListener("keydown", (e) => {
  if (!suggestEl.classList.contains("hidden")) {
    if (e.key === "ArrowDown") { e.preventDefault(); moveSuggest(1); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); moveSuggest(-1); return; }
    if (e.key === "Tab" || e.key === "Enter") { e.preventDefault(); acceptSuggest(); return; }
    if (e.key === "Escape") { e.preventDefault(); hideSuggest(); return; }
  }
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  else if (e.key === "Escape" && state.working) { post({ cmd: "interrupt" }); }
});

/* WebView2's clipboard reports bitmaps with an EMPTY item.type (found live: a real
   Ctrl+V produced {mediaType: "", data: <valid PNG>} and every image affordance
   silently no-op'd). The data itself is unambiguous — sniff the magic bytes. */
function sniffImageMime(b64) {
  if (!b64) return null;
  if (b64.startsWith("iVBORw0KGgo")) return "image/png";
  if (b64.startsWith("/9j/")) return "image/jpeg";
  if (b64.startsWith("R0lGOD")) return "image/gif";
  if (b64.startsWith("UklGR")) return "image/webp";
  if (b64.startsWith("Qk")) return "image/bmp";
  return null;
}

/* Heal an attachment whose source didn't provide a usable media type. */
function ensureImageType(a) {
  if (!a || (a.mediaType && a.mediaType.startsWith("image/"))) return a;
  const sniffed = sniffImageMime(a.data);
  if (sniffed) a.mediaType = sniffed;
  return a;
}

document.addEventListener("paste", (e) => {
  const items = (e.clipboardData || {}).items || [];
  for (const item of items) {
    const isImageType = item.type && item.type.startsWith("image/");
    const isTypelessFile = item.kind === "file" && !item.type;
    if (!isImageType && !isTypelessFile) continue;
    const file = item.getAsFile();
    if (!file) continue;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      const comma = dataUrl.indexOf(",");
      const b64 = dataUrl.slice(comma + 1);
      const headerType = dataUrl.slice(5, comma).split(";")[0]; // mime from the data URL itself
      const mediaType = item.type || file.type || headerType || sniffImageMime(b64);
      if (!mediaType || !mediaType.startsWith("image/")) return; // typeless non-image file — skip
      state.attachments.push({ name: "pasted image", mediaType, data: b64 });
      renderAttachments();
    };
    reader.readAsDataURL(file);
    e.preventDefault();
  }
});
function renderAttachments() {
  // The chip under the cursor may be about to vanish (✕ click, send) — a removed
  // element never fires mouseout, which stranded the hover preview permanently.
  hideImageHover();
  const wrap = $("attachments");
  wrap.innerHTML = "";
  state.attachments.forEach((a, idx) => {
    ensureImageType(a);
    const chip = document.createElement("span");
    chip.className = "attachment";
    chip.textContent = "🖼 " + a.name;
    if (a.data && a.mediaType && a.mediaType.startsWith("image/")) {
      chip.dataset.imgSrc = "data:" + a.mediaType + ";base64," + a.data;
      chip.title = "Hover to preview · click to enlarge";
    }
    const x = document.createElement("button");
    x.textContent = "✕";
    x.addEventListener("click", (e) => { e.stopPropagation(); state.attachments.splice(idx, 1); renderAttachments(); });
    chip.appendChild(x);
    wrap.appendChild(chip);
  });
}

/* ---------- image previews (composer chips + sent thumbnails) ---------- */

function imageSourceFor(el) {
  const host = el.closest("[data-img-src]");
  if (host) return host.dataset.imgSrc;
  if (el.tagName === "IMG" && el.classList.contains("img-thumb")) return el.src;
  return null;
}

function showImageHover(src, anchor) {
  let pop = $("img-hover-pop");
  if (!pop) {
    pop = document.createElement("div");
    pop.id = "img-hover-pop";
    pop.innerHTML = "<img>";
    document.body.appendChild(pop);
  }
  pop.querySelector("img").src = src;
  pop.classList.remove("hidden");
  const r = anchor.getBoundingClientRect();
  // Prefer above the anchor (composer chips sit at the bottom); clamp to viewport.
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 296)) + "px";
  pop.style.bottom = "";
  pop.style.top = "";
  if (r.top > window.innerHeight / 2) pop.style.bottom = (window.innerHeight - r.top + 8) + "px";
  else pop.style.top = (r.bottom + 8) + "px";
}

function hideImageHover() {
  const pop = $("img-hover-pop");
  if (pop) pop.classList.add("hidden");
}

function showImageLightbox(src) {
  let box = $("img-lightbox");
  if (!box) {
    box = document.createElement("div");
    box.id = "img-lightbox";
    box.innerHTML = "<img>";
    box.addEventListener("click", () => box.classList.add("hidden"));
    document.body.appendChild(box);
  }
  box.querySelector("img").src = src;
  box.classList.remove("hidden");
  hideImageHover();
}

document.addEventListener("mouseover", (e) => {
  const src = e.target && e.target.closest ? imageSourceFor(e.target) : null;
  if (src) showImageHover(src, e.target.closest("[data-img-src]") || e.target);
  else hideImageHover(); // self-heal: keeps "pop visible ⇔ pointer over an image" even if the source element was removed mid-hover
});
document.addEventListener("mouseout", (e) => {
  if (e.target && e.target.closest && imageSourceFor(e.target)) hideImageHover();
});
document.addEventListener("click", (e) => {
  if (!e.target || !e.target.closest) return;
  if (e.target.tagName === "BUTTON") return; // chip ✕ etc.
  const src = imageSourceFor(e.target);
  if (src) showImageLightbox(src);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    hideImageHover();
    const box = $("img-lightbox");
    if (box && !box.classList.contains("hidden")) { box.classList.add("hidden"); e.stopPropagation(); }
  }
}, true);

/* ---------- suggestions ---------- */
function maybeSuggest() {
  const pos = inputEl.selectionStart;
  const text = inputEl.value.slice(0, pos);
  const slash = text.match(/^\/(\w*)$/);
  const at = text.match(/(^|\s)@([\w./\\-]*)$/);
  if (slash) {
    state.suggestKind = "command";
    state.suggestAnchor = 0;
    const q = slash[1].toLowerCase();
    const items = state.commands
      .filter(c => c.name.toLowerCase().includes(q))
      .slice(0, 20)
      .map(c => ({ label: "/" + c.name, insert: "/" + c.name + " ", desc: (c.description || "") + (c.argumentHint ? " " + c.argumentHint : "") }));
    showSuggest(items);
  } else if (at) {
    state.suggestKind = "file";
    state.suggestAnchor = pos - at[2].length;
    const token = ++state.suggestToken;
    post({ cmd: "suggest", token: String(token), query: at[2] });
  } else {
    hideSuggest();
  }
}
function applySuggestions(data) {
  if (state.suggestKind !== "file") return;
  if (data.token !== String(state.suggestToken)) return;
  const raw = (data.data && (data.data.suggestions || data.data.files || data.data.results)) || [];
  const items = raw.slice(0, 20).map(entry => {
    const path = typeof entry === "string" ? entry : entry.path || entry.display || "";
    return { label: path.split(/[\\/]/).pop(), insert: path.replace(/\\/g, "/") + " ", desc: path };
  }).filter(i => i.desc);
  showSuggest(items);
}
function showSuggest(items) {
  state.suggestItems = items;
  state.suggestActive = 0;
  if (!items.length) { hideSuggest(); return; }
  suggestEl.innerHTML = "";
  items.forEach((item, i) => {
    const div = document.createElement("div");
    div.className = "suggest-item" + (i === 0 ? " active" : "");
    div.innerHTML = '<span class="label">' + escapeHtml(item.label) + '</span><span class="desc">' + escapeHtml(item.desc || "") + "</span>";
    div.addEventListener("click", () => { state.suggestActive = i; acceptSuggest(); });
    suggestEl.appendChild(div);
  });
  suggestEl.classList.remove("hidden");
}
function hideSuggest() { suggestEl.classList.add("hidden"); state.suggestKind = null; }
function moveSuggest(d) {
  const items = suggestEl.querySelectorAll(".suggest-item");
  if (!items.length) return;
  state.suggestActive = (state.suggestActive + d + items.length) % items.length;
  items.forEach((el, i) => el.classList.toggle("active", i === state.suggestActive));
  items[state.suggestActive].scrollIntoView({ block: "nearest" });
}
function acceptSuggest() {
  const item = state.suggestItems[state.suggestActive];
  if (!item) return;
  const pos = inputEl.selectionStart;
  if (state.suggestKind === "command") {
    inputEl.value = item.insert + inputEl.value.slice(pos);
    inputEl.selectionStart = inputEl.selectionEnd = item.insert.length;
  } else {
    inputEl.value = inputEl.value.slice(0, state.suggestAnchor) + item.insert + inputEl.value.slice(pos);
    inputEl.selectionStart = inputEl.selectionEnd = state.suggestAnchor + item.insert.length;
  }
  hideSuggest();
  inputEl.focus();
  autoGrow();
}

/* ---------- top bar ---------- */
$("btn-new").addEventListener("click", () =>
  post({ cmd: "newSession", prefs: lsGet("vsclaude.lastPrefs", null) }));
$("btn-sessions").addEventListener("click", () => {
  sessionsPanel.classList.toggle("hidden");
  if (!sessionsPanel.classList.contains("hidden")) {
    post({ cmd: "listSessions" });
    $("sessions-search").value = "";
    setTimeout(() => $("sessions-search").focus(), 50);
  }
});
$("btn-sessions-close").addEventListener("click", () => sessionsPanel.classList.add("hidden"));
$("mode-select").addEventListener("change", (e) => {
  post({ cmd: "setMode", mode: e.target.value });
  saveSessionPrefs();
});
let lastModelBeforeCustom = "default";
$("model-select").addEventListener("mousedown", () => {
  // Refresh the catalog as the list opens; applied when the popup closes if it changed.
  if (Date.now() - (state.lastModelsRefresh || 0) > 5000) post({ cmd: "refreshModels" });
});
$("model-select").addEventListener("change", (e) => {
  if (e.target.value === "__custom__") {
    showCustomModelInput(lastModelBeforeCustom);
    return;
  }
  lastModelBeforeCustom = e.target.value;
  post({ cmd: "setModel", model: e.target.value === "default" ? "" : e.target.value });
  updateEffortDial();
  updateModelTooltip();
  saveSessionPrefs();
});
$("effort-select").addEventListener("change", (e) => {
  post({ cmd: "setEffort", effort: e.target.value });
  saveSessionPrefs();
});

/* Grey the dial when the selected model declares no effort support. The real catalog
   OMITS supportsEffort for such models (haiku) rather than setting it false, so absence
   on a known model means unsupported; unknown/custom models keep the dial enabled
   (the CLI still decides authoritatively). */
function updateEffortDial() {
  const sel = $("model-select");
  const opt = sel.options[sel.selectedIndex];
  const effortSel = $("effort-select");
  const model = state.models.find(m => m.value === (opt ? opt.value : ""));
  const unsupported = model && model.supportsEffort !== true;
  effortSel.disabled = !!unsupported;
  effortSel.title = unsupported ? "The selected model does not support effort levels" : "Reasoning effort";
}

const titleEl = $("session-title");
let titleBeforeEdit = null;
titleEl.addEventListener("dblclick", () => {
  titleBeforeEdit = titleEl.textContent;
  titleEl.contentEditable = "true";
  titleEl.focus();
  document.getSelection().selectAllChildren(titleEl);
});
titleEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); titleEl.blur(); }
  if (e.key === "Escape") { titleEl.textContent = titleBeforeEdit || APP_TITLE; titleEl.blur(); }
});
titleEl.addEventListener("blur", () => {
  if (titleEl.contentEditable !== "true") return;
  titleEl.contentEditable = "false";
  const title = titleEl.textContent.trim();
  if (title && title !== APP_TITLE && title !== titleBeforeEdit) {
    state.sessionTitle = title;
    state.manualTitle = true;
    post({ cmd: "rename", title });
  } else {
    // Cancelled, cleared, or unchanged — restore what was there.
    titleEl.textContent = state.sessionTitle || APP_TITLE;
  }
});

/* ---------- bridge ---------- */
if (bridge) {
  bridge.addEventListener("message", (e) => {
    try { handleHostMessage(typeof e.data === "string" ? JSON.parse(e.data) : e.data); }
    catch (err) { console.error(err); }
  });
  post({ cmd: "ready", prefs: lsGet("vsclaude.lastPrefs", null) });
} else {
  demoStart();
}
updateWelcome();

/* ---------- standalone demo (browser preview) ---------- */
function demoHandleCommand(obj) {
  if (obj.cmd === "send") demoRespond(obj.text || "");
  if (obj.cmd === "interrupt") { setWorking(false); banner("info", "Demo: interrupted."); }
  if (obj.cmd === "login") setTimeout(() => handleHostMessage({ kind: "authState", loggedIn: true }), 1500);
  if (obj.cmd === "listSessions")
    handleHostMessage({ kind: "sessions", list: [
      { sessionId: "demo-1", title: "Fix the USB driver init bug", lastModified: new Date(Date.now() - 3600e3).toISOString(), gitBranch: "main" },
      { sessionId: "demo-2", title: "Add unit tests for the parser", lastModified: new Date(Date.now() - 86400e3).toISOString(), gitBranch: "feature/parser" },
    ]});
}
function demoStart() {
  const light = location.search.includes("light");
  if (light) applyTheme({ dark: false, colors: { background: "#f5f5f5", foreground: "#1e1e1e", border: "#d0d0d0", inputBackground: "#ffffff", accent: "#7c5cd6", accentForeground: "#ffffff", link: "#0066bf" } });
  applyState({ running: true, cwd: "C:\\demo\\repo", mode: "default", mock: true, ideConnections: 1, idePort: 12345 });
  applyInit({
    commands: [
      { name: "compact", description: "Compact the conversation", argumentHint: "" },
      { name: "usage", description: "Show plan usage", argumentHint: "" },
    ],
    models: [{ value: "fable", displayName: "Fable 5" }, { value: "opus", displayName: "Opus 4.8" }],
    account: { email: "demo@vsclaude", subscriptionType: "max" },
  });
}
async function demoRespond(prompt) {
  setWorking(true);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  await sleep(400);
  const lower = prompt.toLowerCase();
  if (lower.includes("signin")) {
    state.signinRequired = true; messagesEl.innerHTML = ""; state.toolCards.clear(); setWorking(false); updateWelcome(); return;
  }
  if (lower.includes("edit")) {
    handleHostMessage({ kind: "permission", requestId: "demo-perm", request: {
      tool_name: "Edit", title: "Claude wants to edit Program.cs",
      input: { file_path: "C:\\demo\\Program.cs", old_string: "var x = 1;\nConsole.Write(x);", new_string: "var x = 42; // the answer\nConsole.WriteLine(x);" },
      permission_suggestions: [{ type: "addRules" }],
    }});
    return;
  }
  if (lower.includes("plan")) {
    handleHostMessage({ kind: "permission", requestId: "demo-plan", request: {
      tool_name: "ExitPlanMode",
      input: { plan: "## Proposed plan\n\n1. **Inspect** the widget subsystem\n2. Add `Frobnicate()` calls\n3. Run the tests" },
    }});
    return;
  }
  if (lower.includes("tool")) {
    handleClaude({ type: "assistant", message: { id: "d1", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "git status --short" } }] }, parent_tool_use_id: null });
    await sleep(700);
    handleClaude({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: " M src/app.js\n?? notes.txt", is_error: false }] }, parent_tool_use_id: null });
    await sleep(300);
  }
  const text = "**Here's a polished demo reply.**\n\n```csharp\npublic async Task<Result> FrobnicateAsync(Widget widget)\n{\n    // The answer is 42\n    var session = new ClaudeCliSession(options);\n    session.Start();\n    return await session.CompleteAsync(widget.Id, 42);\n}\n```\n\n| Feature | Status |\n|---|---|\n| Streaming | ✅ |\n| Highlighting | ✅ |\n\n- try `edit`, `plan`, `tool`, or `think`\n- links work: [claude.com](https://claude.com)";
  handleClaude({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, parent_tool_use_id: null });
  if (lower.includes("think")) {
    handleClaude({ type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "" } }, parent_tool_use_id: null });
    for (const c of ["Let me think ", "about this request ", "carefully…"]) {
      handleClaude({ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: c } }, parent_tool_use_id: null });
      await sleep(180);
    }
    handleClaude({ type: "stream_event", event: { type: "content_block_stop", index: 1 }, parent_tool_use_id: null });
  }
  for (let i = 0; i < text.length; i += 14) {
    handleClaude({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text.slice(i, i + 14) } }, parent_tool_use_id: null });
    await sleep(18);
  }
  handleClaude({ type: "stream_event", event: { type: "content_block_stop", index: 0 }, parent_tool_use_id: null });
  handleClaude({ type: "stream_event", event: { type: "message_stop" }, parent_tool_use_id: null });
  handleClaude({ type: "result", subtype: "success", is_error: false, duration_ms: 1830, total_cost_usd: 0.0042, usage: { input_tokens: 1200, output_tokens: 160 } });
}

autoGrow();
inputEl.focus();
