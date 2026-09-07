# pi-agent-canvas

A minimal, clutter-free **agent canvas workspace**: one dedicated Webview
"window" with zero standard IDE chrome around it. Currently the shell only —
a bare layout to strip down and rearrange before the real agent stream lands.

## Status (v0.0.1)

- [x] Extension scaffold (TypeScript, esbuild, strict tsconfig)
- [x] `pi-agent-canvas: Open Canvas Window` command → single reused Webview panel
- [x] Webview shell: **left rail** (machine/session tree placeholder) +
      **right workspace** (agent stream placeholder + composer)
- [x] Host ⇄ webview bridge (ping/pong proves round-trip), strict CSP + nonces
- [ ] Live agent stream (markdown / images / mermaid)
- [ ] Tool / Bash cards with token-optimized tails + expandable terminal
- [ ] Multi-machine session tree sync over RPC/WebSockets

## Layout of the code

```
pi-agent-canvas/
├── src/
│   ├── extension.ts      # activation + command registration
│   └── canvasPanel.ts    # webview panel lifecycle + message bridge
├── media/
│   ├── index.html        # THE layout — strip & rearrange here
│   └── index.js          # webview-side logic (vanilla JS for now)
├── esbuild.mjs           # bundles src/ → dist/extension.js
└── .vscode/launch.json   # two dev-window configurations (see below)
```

## Run it (isolated dev window)

1. `npm install`
2. `npm run build` (or press **Ctrl/Cmd+Shift+B** → watch)
3. Open **Run and Debug** → choose **Run Extension (ISOLATED window)**.
   That config disables all other extensions and points `--user-data-dir` /
   `--extensions-dir` at `.vscode/.devdata` + `.vscode/.devext`, so you get a
   clean, throwaway VS Code with only this extension loaded.
4. Press `Ctrl/Cmd+Alt+C` (or run *pi-agent-canvas: Open Canvas Window* from
   the command palette) to open the canvas "window".

The canvas auto-opens on an empty launch too.

## Notes

- **No React/Svelte yet — on purpose.** `media/` is static HTML/CSS/JS so the
  layout can be rearranged live with no bundler in the way. A frontend
  toolchain gets bolted on when the real UI work starts.
- The webview HTML is served through a strict CSP (nonce-based scripts,
  `unsafe-inline` styles only). Edit `inject()` in `src/canvasPanel.ts` when
  you need to widen it (e.g. `https:` images, remote mermaid).
- `media/index.html` can be opened in a plain browser for layout preview; the
  webview JS degrades gracefully when the VS Code API is absent.
