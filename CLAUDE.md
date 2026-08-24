# VSClaudeCode — working notes for Claude

VS Code port of VSClaude (`C:\Users\tulio\source\repos\VSClaude` — read its CLAUDE.md,
`docs/protocol.md`, `docs/architecture.md` first; all protocol/CLI knowledge lives there).

## Invariants

- **`webui/app.js`, `app.css`, `vendor/` are verbatim copies from VSClaude.** Fix bugs
  THERE, smoke them there, then re-copy here. Only `index.html` (3 marked lines),
  `vscode-bridge.js`, and `vscode-theme.css` may differ.
- Extension host is **plain CommonJS JS, buildless, zero runtime deps** — keep it that way.
- The webview message contract (kinds/cmds) must stay identical to VSClaude's
  ChatController; the shared webui depends on it.
- Permission decisions: `{behavior:"allow", updatedInput, updatedPermissions?}` /
  `{behavior:"deny", message, interrupt?}` — same wire shape as VSClaude.Core.

## Build & test

No build. Package: `npm run package`. Sideload: `code --install-extension *.vsix`.

Smoke (mirrors VSClaude's): launch an isolated dev instance with MockClaude and drive
the webview over CDP:

```powershell
$smoke = "$env:LOCALAPPDATA\Temp\vsclaude-smoke"   # reuses VSClaude's fixtures
$env:VSCLAUDE_CLI_PATH = "C:\Users\tulio\source\repos\VSClaude\tools\MockClaude\bin\Release\net10.0\MockClaude.exe"
$env:CLAUDE_CONFIG_DIR = "$smoke\cfg"
$env:VSCLAUDE_MOCK_LAZY_INIT = "1"
$env:VSCLAUDE_AUTO_OPEN = "1"
code --extensionDevelopmentPath=C:\Users\tulio\source\repos\VSClaudeCode `
     --user-data-dir="$smoke\vscode-udd" --new-window `
     --remote-debugging-port=9444 "$smoke\ScratchSln"
```

Then `node tests/smoke-webview.mjs 9444` drives the panel over CDP, and
`node tests/harness.mjs` tests the protocol layer with no VS Code at all.

Hard-won launch/CDP facts (2026-08-23, VS Code 1.134):
- Always use the isolated `--user-data-dir` — without it the CLI hands off to any
  running VS Code instance (his real one) and the dev extension never loads.
- Launch via `cmd /c code ... > log 2>&1` (Start-Process on the shim swallowed args
  once); a stuck VS Code UPDATER (CodeSetup*.exe waiting for windows to close, inno
  mutex `vscode-updating`) blocks ALL new instances — check for it when launches die
  with an empty CDP target list.
- Webview content is NESTED: the `vscode-webview://` iframe target's top frame is a
  wrapper; the extension's HTML runs in a child execution context of the SAME target.
  Attach flattened, collect `Runtime.executionContextCreated` events, probe each
  contextId — the top context never has our DOM.
- The exthost "webview without a content security policy" warning is a FALSE alarm:
  the injected CSP meta is verifiably in the live DOM. Don't chase it.
- Webview `localStorage` persists across full VS Code restarts (stable per-extension
  origins) — prefs need no host-persistence shim.
