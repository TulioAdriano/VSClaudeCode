# VSClaudeCode

Unofficial Claude Code chat panel for **VS Code** — the port of [VSClaude](https://github.com/TulioAdriano/VSClaude)
(the unofficial Visual Studio 2026 extension), bringing its UX to VS Code on top of your installed
Claude Code CLI and your own subscription.

Why, when an official extension exists: VSClaude grew features the official panel doesn't have —
per-message model attribution, versioned model picker with self-learning previous models and
custom ids, model-scoped usage limits (Fable weekly) with threshold warnings, AI-generated session
titles for print-mode sessions, and a real recovery path for expired sign-ins. This port keeps that
feature set in one shared UI.

## Architecture

- `webui/` — the chat UI, **byte-shared** with VSClaude's (dependency-free vanilla JS, buildless).
  `vscode-bridge.js` fabricates the `window.chrome.webview` transport over `acquireVsCodeApi()`;
  `vscode-theme.css` maps VS Code's theme variables onto the UI's tokens. `app.js`/`app.css` are
  verbatim copies — port fixes by re-copying from VSClaude and re-applying nothing.
- `src/` — plain-JS extension host (no build step, no runtime dependencies):
  - `cliSession.js` — the stream-JSON + control protocol host (port of `ClaudeCliSession.cs`;
    wire contract in VSClaude's `docs/protocol.md`).
  - `chatController.js` — session lifecycle, permissions, usage, titles, auth recovery
    (port of `ChatController.cs`).
  - `sessionStore.js`, `titleGenerator.js` — session history + one-shot title generation.
  - `chatViewProvider.js`, `extension.js` — webview view plumbing.

## Run / develop

```
code --extensionDevelopmentPath=<this repo> <some workspace>
```

Package a VSIX: `npm run package` (needs no install; uses npx @vscode/vsce).

Sideload: `code --install-extension vsclaudecode-<version>.vsix`.

## Status

Early port (0.1.x): core chat (streaming, markdown, tool cards, permissions), sessions
list/resume/rename/titles, model picker + usage meter + attribution, image previews,
auth recovery, selection context, CLI auto-update. Not yet ported: SDK `ide` MCP server
(diagnostics/executeCode tools), native diff preview, terminal `/ide` attach server.
