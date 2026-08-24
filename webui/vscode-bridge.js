/* VS Code adapter for the shared VSClaude web UI.
   app.js talks to its host through window.chrome.webview (the WebView2 bridge
   in the VS 2026 extension). Inside a VS Code webview we fabricate the same
   interface over acquireVsCodeApi(), so app.js runs byte-identical here.
   Load this BEFORE app.js. Harmless outside VS Code (no acquireVsCodeApi). */
"use strict";

(function () {
  if (typeof acquireVsCodeApi !== "function") return;
  var vscode = acquireVsCodeApi();
  var listeners = [];
  window.addEventListener("message", function (e) {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i]({ data: e.data }); } catch (err) { console.error(err); }
    }
  });
  window.chrome = window.chrome || {};
  window.chrome.webview = {
    postMessage: function (obj) { vscode.postMessage(obj); },
    addEventListener: function (type, fn) { if (type === "message") listeners.push(fn); },
  };

  /* Theme: VS Code injects --vscode-* CSS variables and toggles body classes
     (vscode-dark / vscode-light / vscode-high-contrast). vscode-theme.css maps
     them onto the webui's own tokens; here we keep the highlight.js palette
     (documentElement data-hl) in sync with the theme kind. */
  function syncHl() {
    var dark = !document.body.classList.contains("vscode-light");
    document.documentElement.dataset.hl = dark ? "dark" : "light";
  }
  if (document.body) syncHl(); else window.addEventListener("DOMContentLoaded", syncHl);
  new MutationObserver(syncHl).observe(document.documentElement, {
    attributes: true, subtree: true, attributeFilter: ["class"],
  });
})();
