// Node port of VSClaude.Core TitleGenerator: one-shot `claude -p` (haiku,
// --no-session-persistence) title from the first user prompt. Print-mode
// sessions never get the CLI's own AI summaries, so the panel generates its
// own and persists it through rename_session.
"use strict";

const { spawn } = require("child_process");
const os = require("os");

function generate(executablePath, firstPrompt) {
  return new Promise((resolve) => {
    if (!firstPrompt || !firstPrompt.trim()) return resolve(null);
    let snippet = firstPrompt.replace(/[\r\n]/g, " ").trim();
    if (snippet.length > 500) snippet = snippet.slice(0, 500);

    const useShell = process.platform === "win32" && /\.cmd$/i.test(executablePath);
    let proc;
    try {
      proc = spawn(executablePath, [
        "-p",
        "Write a title for a coding chat session that begins with the user message below. " +
        "3 to 6 words, plain text, no quotes, no trailing punctuation. Reply with ONLY the title.\n\n" +
        "User message: " + snippet,
        "--model", "haiku",
        "--output-format", "text",
        "--no-session-persistence",
      ], {
        cwd: os.tmpdir(), // don't load project CLAUDE.md context for a title call
        shell: useShell,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      return resolve(null);
    }

    let stdout = "";
    proc.stdout.on("data", (d) => { stdout += d; });
    proc.stderr.on("data", () => { });

    const timer = setTimeout(() => {
      try {
        if (process.platform === "win32") spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { windowsHide: true });
        else proc.kill("SIGKILL");
      } catch { }
      resolve(null);
    }, 45000);

    proc.on("error", () => { clearTimeout(timer); resolve(null); });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? sanitize(stdout) : null);
    });
  });
}

/** First non-empty line, unquoted, no trailing punctuation, capped at 60 chars. */
function sanitize(raw) {
  if (!raw || !raw.trim()) return null;
  let line = null;
  for (const l of raw.split("\n")) {
    const t = l.trim();
    if (t) { line = t; break; }
  }
  if (!line) return null;
  line = line.replace(/^["'`“”]+|["'`“”]+$/g, "").trim();
  while (line.length > 0 && (line.endsWith(".") || line.endsWith(":")))
    line = line.slice(0, -1).trimEnd();
  if (!line) return null;
  if (line.length > 60) line = line.slice(0, 60).trimEnd() + "…";
  return line;
}

module.exports = { generate, sanitize };
