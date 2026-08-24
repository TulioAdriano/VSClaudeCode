// Node port of VSClaude.Core SessionStore: reads Claude Code session history
// from ~/.claude/projects (or CLAUDE_CONFIG_DIR). All shapes and precedence
// rules match the C# original (custom-title tail-scan, sanitization variants).
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

// cwd -> project directory reported by the CLI itself (memory_paths.auto in system/init).
const registeredDirs = new Map();

function getConfigDirectory() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

function registerProjectDirectory(cwd, projectDirectory) {
  try {
    if (cwd && fs.existsSync(projectDirectory)) registeredDirs.set(cwd.toLowerCase(), projectDirectory);
  } catch { }
}

/** Current CLI rule: every char outside [A-Za-z0-9] becomes '-', dots included. */
function sanitizeProjectPath(cwd) {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/** Older CLI versions kept dots. */
function sanitizeProjectPathLegacy(cwd) {
  return cwd.replace(/[^A-Za-z0-9.]/g, "-");
}

function getProjectDirectoryCandidates(cwd) {
  const result = [];
  const add = (dir) => {
    try {
      if (fs.existsSync(dir) && !result.some((r) => r.toLowerCase() === dir.toLowerCase()))
        result.push(dir);
    } catch { }
  };
  const registered = registeredDirs.get((cwd || "").toLowerCase());
  if (registered) add(registered);

  const root = path.join(getConfigDirectory(), "projects");
  const names = [...new Set([sanitizeProjectPath(cwd), sanitizeProjectPathLegacy(cwd)])];
  for (const name of names) add(path.join(root, name));

  if (result.length === 0 && fs.existsSync(root)) {
    try {
      for (const entry of fs.readdirSync(root)) {
        if (names.some((n) => n.toLowerCase() === entry.toLowerCase()))
          add(path.join(root, entry));
      }
    } catch { }
  }
  return result;
}

function readLines(file) {
  return fs.readFileSync(file, "utf8").split("\n");
}

/** Renames append {"type":"custom-title"} lines at the END of the file; last wins. */
function readCustomTitleFromTail(file) {
  const TAIL = 128 * 1024;
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - TAIL);
    const fd = fs.openSync(file, "r");
    let text;
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
    const lines = text.split("\n");
    if (start > 0) lines.shift(); // discard a partial first line
    let found = null;
    for (const line of lines) {
      if (!line.includes('"custom-title"')) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === "custom-title" && obj.customTitle && obj.customTitle.trim())
          found = obj.customTitle.trim();
      } catch { }
    }
    return found;
  } catch {
    return null;
  }
}

function truncate(s, max) {
  s = s.replace(/[\r\n]/g, " ");
  return s.length <= max ? s : s.slice(0, max) + "…";
}

function readSessionInfo(file, stat) {
  const info = {
    sessionId: path.basename(file, ".jsonl"),
    lastModifiedUtc: stat.mtime,
    fileSizeBytes: stat.size,
    customTitle: null,
    title: null,
    firstPrompt: null,
    gitBranch: null,
  };
  // Scan up to the first 100 lines for the first real user prompt and metadata.
  let lines;
  try { lines = readLines(file); } catch { return null; }
  let scanned = 0;
  for (const line of lines) {
    if (scanned++ >= 100) break;
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }

    if (info.gitBranch == null && obj.gitBranch) info.gitBranch = obj.gitBranch;
    if (obj.type === "summary" && info.title == null) info.title = obj.summary || null;

    if (info.firstPrompt == null && obj.type === "user") {
      const content = obj.message && obj.message.content;
      let text = null;
      if (typeof content === "string") text = content;
      else if (Array.isArray(content)) {
        const block = content.find((b) => b && b.type === "text" && b.text && b.text.trim());
        text = block ? block.text : null;
      }
      if (text && text.trim() && !text.startsWith("<") && !text.startsWith("Caveat:"))
        info.firstPrompt = truncate(text.trim(), 120);
    }

    if (info.firstPrompt && info.title && info.gitBranch) break;
  }
  info.customTitle = readCustomTitleFromTail(file);
  info.displayTitle = info.customTitle || info.title || info.firstPrompt || info.sessionId;
  return info;
}

function listSessions(cwd, maxSessions = 50) {
  // Merge across candidate directories; on duplicate session ids keep the newest file.
  const byId = new Map();
  for (const dir of getProjectDirectoryCandidates(cwd)) {
    let files;
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
    for (const f of files) {
      const full = path.join(dir, f);
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      const id = path.basename(f, ".jsonl");
      const existing = byId.get(id);
      if (!existing || stat.mtimeMs > existing.stat.mtimeMs) byId.set(id, { full, stat });
    }
  }
  const sorted = [...byId.values()].sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs).slice(0, maxSessions);
  const sessions = [];
  for (const { full, stat } of sorted) {
    try {
      const info = readSessionInfo(full, stat);
      if (info) sessions.push(info);
    } catch { /* unreadable session file */ }
  }
  return sessions;
}

/** Custom title (file tail) first, else the CLI's generated summary near the head. */
function getStoredSessionTitle(cwd, sessionId) {
  for (const dir of getProjectDirectoryCandidates(cwd)) {
    const file = path.join(dir, sessionId + ".jsonl");
    if (!fs.existsSync(file)) continue;

    const custom = readCustomTitleFromTail(file);
    if (custom) return custom;

    try {
      const lines = readLines(file);
      let scanned = 0;
      for (const line of lines) {
        if (scanned++ >= 400) break;
        if (!line.slice(0, 80).includes('"type":"summary"')) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.type === "summary" && obj.summary && obj.summary.trim()) return obj.summary.trim();
        } catch { }
      }
    } catch { }
  }
  return null;
}

/** Full renderable transcript (user/assistant entries), oldest first, uncapped. */
function readTranscriptAll(cwd, sessionId) {
  let file = null;
  for (const dir of getProjectDirectoryCandidates(cwd)) {
    const candidate = path.join(dir, sessionId + ".jsonl");
    if (fs.existsSync(candidate)) { file = candidate; break; }
  }
  if (!file) return [];

  const entries = [];
  let lines;
  try { lines = readLines(file); } catch { return []; }
  for (const line of lines) {
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.type !== "user" && obj.type !== "assistant") continue;
    if (obj.isMeta === true || obj.isSidechain === true) continue;
    if (!obj.message || typeof obj.message !== "object") continue;
    entries.push({
      type: obj.type,
      message: obj.message,
      parent_tool_use_id: obj.parentToolUseID !== undefined ? obj.parentToolUseID
        : (obj.parent_tool_use_id !== undefined ? obj.parent_tool_use_id : null),
      uuid: obj.uuid,
    });
  }
  return entries;
}

module.exports = {
  getConfigDirectory,
  registerProjectDirectory,
  sanitizeProjectPath,
  sanitizeProjectPathLegacy,
  getProjectDirectoryCandidates,
  listSessions,
  getStoredSessionTitle,
  readTranscriptAll,
};
