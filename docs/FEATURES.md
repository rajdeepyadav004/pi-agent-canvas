# Features — the behaviour contract

pi-agent-canvas is an agent cockpit for VS Code: conversations as editor tiles,
the files an agent touches opening in the editor, and many sessions at once.
This document is the **contract**: every capability we claim, where it lives,
and what proves it still works after a refactor.

When a change touches the canvas, the rule is: the feature matrix below stays
green. Anything not in the matrix is either in [Not supported yet](#not-supported-yet)
or is a bug.

- Implementation map: `src/extension.ts` (host), `src/canvasPanel.ts` (panels),
  `src/sessionsView.ts` (sidebar), `scripts/pi-server.mjs` (session host),
  `src/webview/main.tsx` (UI), `src/shared/protocol.ts` (wire contract).
- Verification: `npm run test:isolated` (25), `npm run test:shared` (15), and the
  Playwright end-to-end runs in `scripts/e2e.mjs` (feature flags below).

## How each feature is verified

| # | Feature | Verified by |
|---|---------|-------------|
| 1 | Streaming replies | e2e `replySeen` |
| 2 | Markdown rendering | e2e `E2E_EXPECT_SELECTOR='.canvas-md table\|\|.canvas-md pre code'` → `selectorsAllSeen`, `markdownSeen.copyButton` |
| 3 | Thinking / reasoning | e2e `thinkingSeen` |
| 4 | Tool cards | e2e `toolCardSeen` + `result.details.patch` rendering |
| 5 | Diffs — unified, split, collapsed | e2e `diffSeen`, `splitToggleSeen`, `diffSplitRendered.tables === 2` |
| 6 | File tiles → editor tab, tab reuse | e2e `fileChipSeen`, `fileTabOpened`, `fileTabReused`, `filePaneCount` |
| 7 | Shell commands from the composer (`!` / `!!`) | e2e `E2E_BASH`, `bashRan`, `bashCommandEchoed` |
| 8 | Stop / abort a running turn | e2e `E2E_ABORT`, `stopButtonSeen`, `stopButtonGone`, `afterAbortReplySeen` |
| 9 | Session persistence & history replay | e2e `E2E_RELOAD`, `reloadHistorySeen` |
| 10 | Multiple sessions, one host process | `test:isolated` (panels, session rows), e2e session tabs |
| 11 | Agent button + Sessions view in the activity bar | `test:isolated` (`sessionsView.test.js`), e2e `activityButtonSeen`, `sidebarTitleSeen` |
| 12 | Extension UI (an extension asking the user) | e2e `E2E_EXPECT_UI_DIALOG`, `uiDialogSeen`, `uiNoticeSeen`; `protocol.test.js` |
| 13 | Agent launch as configured (`agentCwd`, `agentCommand`) | `test:isolated` (launch settings, swapped settings) |
| 14 | Failure is named, not silent | `test:isolated` (log piping, stale session), e2e `E2E_EXPECT_ERROR` |
| 15 | Chrome is never touched; AI features opt-in | `test:shared` (`AI_FEATURES_UNTOUCHED`), `chromeSafety.js` |
| 16 | Wire protocol conformance | `test:isolated` + `test:shared` (`protocol.test.js`, 9 checks) |

## Conversation

| Feature | Behaviour |
|---|---|
| Streaming | Assistant text streams token by token; a message that resumes after a tool call starts a new bubble segment. |
| Thinking | `thinking_delta` renders as a collapsible **Thought** block, open while streaming. |
| Tool calls | Each call is a card: status dot (running / ok / error), tool name, a file chip when the args name a file, the most human argument as a summary, and the output folded into a collapsible body. Consecutive calls stay in one bubble. |
| Edits | pi's `edit` tool returns a unified patch in `result.details.patch`; the card renders it with `@git-diff-view/react` (MIT) — syntax highlighted, `+n −n` stats, unified ⇄ split toggle, auto-collapsed above 40 lines. |
| Markdown | `@assistant-ui/react-markdown` + `remark-gfm`: headings, lists, tables, blockquotes, links, inline code, fenced code with a language label and a copy button. Prose is capped at 900px; the card column spans the thread so diffs get the width. |
| No nested scrollers | Exactly one scroll surface. The thread must never overflow horizontally (`horizontalOverflow === false` in every e2e run). |

## Editor integration

| Feature | Behaviour |
|---|---|
| File chips | A file named in tool args renders as a chip; clicking it opens that file in the editor area. |
| Pane policy | Focus if the file is already visible, else open it as a **preview** in the active pane. Clicking twice never splits or stacks panes. |
| Path handling | Absolute paths, `file://` URIs and workspace-relative paths all resolve. |

## Sessions

| Feature | Behaviour |
|---|---|
| One conversation per editor tab | Each canvas panel binds to one pi session id (the same id `pi --continue` uses). |
| Many at once | One host process serves many live sessions, one prompt queue each, so two conversations run concurrently. |
| Sidebar | The activity-bar **Pi Agent** container shows a **Sessions** list — label, relative time, message count, short id — with a live icon for open sessions, a `+` to start one, and refresh. |
| Save/restore | Sessions live in pi's own session directory, so the canvas and the CLI share conversations. |
| Replay | On connect the host replays stored messages; tool results are folded back into their call, and bash executions become bash cards, so history renders exactly like live turns. |

## Shell (`!command`)

| Feature | Behaviour |
|---|---|
| `!cmd` | Runs in the session's context: pi records it, so the agent can see it afterwards. |
| `!!cmd` | Same, but marked **no context** — the output is kept out of the model's context. |
| Rendering | A bash card: command, streamed output, exit code, cancellation, truncation notice with the full-output path, collapsible. |

## Extension UI

An extension calling `ctx.ui.confirm()` / `select()` / `input()` / `editor()`
gets a dialog in the canvas and **blocks until it is answered**; `ctx.ui.notify()`
becomes a toast. Binding is deliberately **not awaited** during session start: a
`session_start` dialog must not hold back `session_opened`, or the UI would sit
on its connecting screen with no dialog rendered while the extension waits —
each side waiting on the other. A cancelled turn answers every outstanding
dialog with `cancelled`.

## Diagnostics

| Feature | Behaviour |
|---|---|
| Output channel | **Pi Agent Canvas** carries the host's stdout/stderr (node version and path, resolved pi SDK, cwd, port, PATH, proxy vars, providers visible, per-session model and auth status). |
| Errors on screen | `explainError()` turns a raw failure into a named one; the red banner above the composer offers **show logs** and **dismiss**. |
| Diagnostics command | *Pi Agent Canvas: Run Diagnostics* spawns the host on a random port, sends a prompt, and prints a verdict with the environment. |
| Protocol mismatch | A webview whose protocol version differs from the host's says so instead of rendering an agent that never answers. |

## Safety

- **No chrome is ever written.** No menu, search, activity bar, status bar or
  window setting is modified — asserted before *and* after opening the canvas.
- **The built-in AI kill switch is opt-in** (`piCanvas.disableBuiltInAi`,
  default `false`) and reversible: we only restore what we set, tracked in
  `globalState`. A default install writes nothing.
- **Perfect guest**: the extension never auto-opens anything in a normal window.

## The wire protocol

`src/shared/protocol.ts` is the declared contract: command and event names taken
from pi's own RPC vocabulary (`docs/rpc.md`) so that a future `pi --mode rpc` or
Agent Client Protocol adapter is a rename, not a rewrite. The host is plain
JavaScript (it ships as a script), so the contract is enforced by
`test/suite/protocol.test.js`, which reads the sources as text and fails when
they drift — that is how `scripts/diagnose.mjs` was caught still waiting for the
pre-rename `settled` event, and how the non-awaited `bindExtensions` above is
kept from regressing.

**Adding a command** is a four-step checklist:

1. Add the name to `COMMANDS` (or `EVENTS`) in `src/shared/protocol.ts`.
2. Implement it in the host's command switch (`scripts/pi-server.mjs`) — most
   map 1:1 onto an `AgentSession` method.
3. Send it from `src/webview/main.tsx`.
4. `npm run test:isolated` — the conformance suite fails until all three agree.

Two deliberate deviations from pi's RPC mode:

- **`sessionId` rides on every command and event.** pi's RPC mode is one session
  per process; a canvas hosts many in one process (the shape ACP describes:
  "each connection can support several concurrent sessions").
- **`open_session` / `new_session` / `switch_session` / `close_session` /
  `list_sessions` / `server_ready`** are host lifecycle messages, not
  conversation messages; pi's `new_session`/`switch_session` names are honoured
  as aliases.

## Not supported yet

Tracked as work, not as silent gaps:

| Missing | Note |
|---|---|
| Model picker, thinking level, queue modes | The host implements `set_model`, `cycle_model`, `set_thinking_level`, `compact`, `steer`, `follow_up` and `get_state`/`get_session_stats`; the UI for them is not built yet. |
| Fork / clone / session tree | pi exposes them; the canvas shows a flat list. |
| Rename / delete a session | `set_session_name` is implemented host-side. |
| Slash commands, `export_html` | pi's `get_commands` / `export_html` are not wired up. |
| Tool-call approval prompts | pi extensions can block a tool call via a dialog (works today); there is no canvas-native approval UI. |
| Panel restore across a window reload | `registerWebviewPanelSerializer` is not implemented. |
| Reveal a diff as an editor tile | Diffs render in conversation; opening a file's diff in the editor is not wired. |
