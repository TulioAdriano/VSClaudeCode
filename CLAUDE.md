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

Always use the isolated `--user-data-dir` — without it the CLI hands off to any running
VS Code instance (his real one) and the dev extension never loads. The webview is an
iframe inside the workbench page — CDP-attach to the page target, then drive the
`vscode-webview://` iframe's execution context.
