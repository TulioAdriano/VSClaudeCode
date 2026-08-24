# Changelog

All notable changes to VSClaudeCode. Format loosely follows [Keep a Changelog](https://keepachangelog.com); versions are extension versions.

## [0.1.1] — 2026-08-24

### Added
- **IDE integration is live (green dot).** The SDK `ide` MCP server is now ported: the CLI reaches it over the control channel, giving Claude the same tool surface as VSClaude — `getDiagnostics` (your Problems panel), `getCurrentSelection`/`getLatestSelection`, `getOpenEditors`, `getWorkspaceFolders`, `openFile`, diff preview, tab management, `checkDocumentDirty`/`saveDocument` — all implemented over the VS Code API. Validated against the real CLI (MCP handshake completes, dot goes green, no errors).

### Changed
- **Renamed to "VSClaude Code"** everywhere user-visible (activity bar, sidebar header, welcome screen, command palette, extensions view) to avoid confusion with Anthropic's official Claude Code extension. The shared webui now takes its product name from the page title, so the VS 2026 extension keeps its own branding from the same file.

## [0.1.0] — 2026-08-23

Initial port of [VSClaude](https://github.com/TulioAdriano/VSClaude) to VS Code: byte-shared chat webui over a `window.chrome.webview` bridge shim, buildless plain-JS extension host (stream-JSON + control protocol, sessions/resume/titles, permissions with line hints, model picker + usage meter, image previews, auth recovery with integrated-terminal sign-in, CLI auto-update, selection context). Protocol harness + CDP webview smoke.
