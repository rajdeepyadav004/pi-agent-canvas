# pi-agent-canvas (Plane: **pi vantage** / VNTG)

## Project state — tracked in Plane cycles

Project state is managed as high-level **cycles** in the Plane project
**pi vantage** (identifier `VNTG`, connected via the `plane` MCP server).
Check/update the current cycle there before planning or reporting status.

### Cycle map
| Cycle | Name | Window | Status |
|---|---|---|---|
| Cycle 1 | Blank canvas window | 2026-09-09 → 2026-09-12 | **~50% done** — extension, chat removal, tests committed (`0470d6b`); remaining: GitHub push + packaging (publisher, icon, vsce) |
| Cycle 2 | UI interface for pi dev | 2026-09-13 → 2026-09-26 | **complete** — canvas is a live pi cockpit: assistant-ui thread ⇄ pi-canvas-server (per-window WebSocket, SDK session outside VS Code because ext-host fetch patching stalls SSE), markdown + code + tool cards, edit diffs (unified/split), thinking cue, abort control, on-disk sessions replayed on connect. Remaining (backlog): start-a-new-conversation UI; Cycle 1 leftovers: .vsix packaging |
| Cycle 3 | Session tiles & editor integration | 2026-09-27 → 2026-10-10 | **in progress** — the agent button landed: an activity-bar robot face opening a native **Sessions** tree (list + Ctrl+F filter + `+` new session + refresh) that reads the session index from the server's `/sessions`. Sessions open as editor tiles: one panel per conversation, reveal-instead-of-duplicate, tabs named after their conversation (empty ones use their short id). File tiles open in the editor, reusing the tab (focus-if-visible, else preview in the active pane — panes never grow on their own). Next: session switcher niceties (rename/delete), panel restore across reloads (needs a WebviewPanelSerializer). |
| Cycle 4 | Architecture realignment | 2026-10-11 → 2026-10-24 | **in progress** — hubris corrected: the host now bootstraps through pi's own `createAgentSessionServices`/`createAgentSessionFromServices` (the missing piece behind "sessions load but nothing replies" on a real Mac: `ModelRuntime.create()` with no options silently dropped `auth.json`/`models.json` and extension-declared providers), and speaks pi's RPC vocabulary declared in `src/shared/protocol.ts` (commands `prompt`/`abort`/`compact`/`set_model`/…, events `agent_settled`/`message_update`/…, `response` envelopes, extension UI sub-protocol so `ctx.ui.confirm()` reaches the canvas, `docs/FEATURES.md` as the behaviour contract, `protocol.test.js` conformance). Verified: 25 isolated + 15 shared tests, e2e matrix green (markdown, thinking, diff unified+split, tool cards, file tiles + tab reuse, `!` bash card, abort, reload history, extension dialog answered). Next: UI for model/thinking/queue/compaction, session rename/delete, panel restore. |

### Working rules
- **Incremental build only.** This tool is created incrementally; every
  addition (dependency, feature, abstraction, setting) must be thoughtful and
  **earn its place**. No speculative scaffolding, no "might need later" code.
  When in doubt, leave it out — it can always be added when it proves needed.
- **Deliberate reversal (2026-09-10):** the original rule was "no activity-bar
  icon / contribute no views". The user asked for an agent button, so the
  extension now contributes exactly ONE activity-bar container + ONE view
  (Sessions). Everything else stays as strict as before: no other views, and no
  chrome/window setting is ever written (still covered by `test/suite/chromeSafety.js`).
- **Publishing changes the AI kill switch (2026-09-10):** writing
  `chat.disableAIFeatures` for everyone who installs is not acceptable in a
  public extension, so it became the opt-in `piCanvas.disableBuiltInAi`
  setting. `test:shared` asserts a default install writes nothing at all.
- **Trust pi's bootstrap (2026-09-11):** never hand-assemble a `ModelRuntime`.
  Build the runtime and session with `createAgentSessionServices` +
  `createAgentSessionFromServices` (what `InteractiveMode`/`runRpcMode` use).
  `ModelRuntime.create()` with no options silently ignores `auth.json`,
  `models.json` and extension-declared providers, which made a working machine
  look like a broken provider.
- **The wire vocabulary is pi's, not ours (2026-09-11):** commands and events
  come from pi's `docs/rpc.md` and are declared in `src/shared/protocol.ts`.
  The host is plain JS, so `test/suite/protocol.test.js` enforces the agreement
  between host, webview, diagnostics and contract by reading the sources.
  Add a command in all three places or the suite fails.
- **`docs/FEATURES.md` is the behaviour contract.** A change that touches the
  canvas keeps that matrix green; a feature that is claimed but unverified
  belongs in "Not supported yet" instead.
- **Always anchor status to the active cycle** in Plane: when a milestone lands,
  update the cycle's description / add a work item; when starting work, confirm
  which cycle it belongs to (create a new cycle via `plane_cycle create` if none fits).
- Repo: `/home/rajdeep-yadav/projects/pi-agent-canvas` (git `main`).
- Plane project id: `b06463f6-360f-4320-83ed-a01add5695b8`.
- Owner/member id for `owned_by`: `e82f68ff-922c-4794-b772-bf8aad4cf93e`.
