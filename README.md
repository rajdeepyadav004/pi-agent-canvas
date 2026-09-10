# Pi Agent Canvas

A dedicated cockpit for the [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
coding agent, inside VS Code.

The idea: a coding agent should live where your code lives. Conversations are
**tiles** in the editor — open several, split them, arrange them like files —
and the files the agent touches open in the editor beside the conversation that
produced them.

## What you get

- **Conversations as editor tiles.** Each session is its own panel, named after
  its first message. Open as many as you like, split them, drag them around.
- **Files open where you work.** File references in tool cards are chips;
  clicking one reveals the file in the editor, reusing its tab.
- **The agent button.** An activity-bar view listing every stored session for
  the workspace, with a live "open" marker, a new-session button and refresh.
  Focus the list and press <kbd>Ctrl</kbd>+<kbd>F</kbd> to filter it.
- **Real agent output, rendered.** Streaming markdown, syntax-highlighted code
  with copy buttons, collapsible tool cards, and edit diffs with a
  unified ⇄ split toggle.
- **Thinking, visible.** Provider reasoning streams into a collapsible
  "Thinking…" block that settles into "Thought".
- **Stop and go.** A stop control that actually interrupts the agent mid-turn,
  and a session that stays usable afterwards.
- **Sessions persist.** Conversations are stored by pi itself, so a reload (or
  `pi --continue` in a terminal) picks up exactly where you left off.

## Requirements

- **VS Code 1.85 or newer.**
- Optional: **`piCanvas.disableBuiltInAi`** (off by default) to have the canvas
  disable VS Code's built-in AI/chat, which it replaces.
- **Node.js on `PATH`.** The agent runs as a plain Node process beside VS Code
  (see *How it works* below).
- **pi credentials.** The canvas uses pi's own configuration and login, so if
  `pi` works in your terminal, the canvas works too.

## Install

From a `.vsix`:

```bash
code --install-extension pi-agent-canvas-0.1.0.vsix
```

Then click the robot face in the activity bar, or press
<kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>C</kbd> (<kbd>Cmd</kbd>+<kbd>Alt</kbd>+<kbd>C</kbd>
on macOS) to open a canvas.

> By default the extension writes **nothing** to your settings. If you want it
> to switch off VS Code's built-in AI/chat and the Copilot extensions (the
> official `chat.disableAIFeatures` switch, since this canvas replaces them),
> turn on **`piCanvas.disableBuiltInAi`**. Turn it back off and the setting is
> restored if the extension was the one that changed it.

## How it works

```
┌───────────────────────────────┐        ┌──────────────────────────────┐
│ VS Code window                │        │ pi-canvas-server (plain node)│
│                               │  WS    │                              │
│  extension host ── spawns ────┼───────►│  session registry            │
│      │  (a dumb shell)        │        │   ├─ AgentSession  (pi SDK)  │
│      │                        │        │   └─ AgentSession            │
│  canvas webview ──────────────┼───────►│  SessionManager (on disk)    │
│   (assistant-ui thread)       │        │                              │
└───────────────────────────────┘        └──────────────────────────────┘
```

Two decisions shape everything:

1. **The agent runs outside the extension host.** VS Code patches `fetch`/`http`
   inside the extension host for proxy support, and streaming through that patch
   stalls. A plain Node process talking to the model directly has no such
   problem, and the webview's WebSocket never touches that path either.
2. **The extension host is a shell.** It owns windows, the sidebar and opening
   files; it does no model work and never loads the pi SDK (which is ESM-only
   and takes ~0.8s to import). Sessions are listed over the server's HTTP
   endpoint, and the webview says which conversation it owns.

Sessions are stored by pi in its own session directory
(`~/.pi/agent/sessions/…`), so the canvas and `pi --continue` share history.
Set `PI_CANVAS_SESSION_DIR` to isolate them, or `PI_CANVAS_NEW_SESSION=1` to
start fresh.

## Commands and keys

| Command | Key | What it does |
| --- | --- | --- |
| `pi-agent-canvas: Open Canvas Window` | <kbd>Ctrl/Cmd</kbd>+<kbd>Alt</kbd>+<kbd>C</kbd> | Reveal your canvas, resuming the most recent conversation |
| `pi-agent-canvas: New Session` | — | Start a fresh conversation in a new tile |
| `pi-agent-canvas: Open Session` | — | Open a stored conversation (from the Sessions list) |
| `pi-agent-canvas: Refresh Sessions` | — | Re-read the session list |

## Development

```bash
npm install
npm run build          # dist/extension.js + dist/webview.js
npm run watch          # rebuild on change
npm run canvas         # isolated dev window (throwaway profile)
npm test               # chrome-safety + session-tile suites (isolated + shared)
npm run notices        # regenerate THIRD-PARTY-NOTICES.md from the real bundle
npm run package        # build + notices + .vsix
```

`npm run canvas` launches a **throwaway** VS Code profile
(`.vscode/.devdata`), so your real settings are never touched. `scripts/e2e.mjs`
drives the same window with Playwright for end-to-end checks (prompt → streamed
reply, diffs, abort, session replay, file chips).

### Layout

```
├── src/
│   ├── extension.ts       # activation, server spawn, session-list HTTP client
│   ├── canvasPanel.ts     # one editor panel per session (+ file opening policy)
│   ├── sessionsView.ts    # the activity-bar Sessions tree
│   └── webview/main.tsx   # assistant-ui thread: parts, tools, diffs, markdown
├── scripts/
│   ├── pi-server.mjs      # the agent host (session registry, JSON over WS)
│   ├── e2e.mjs            # Playwright end-to-end harness
│   └── licenses.mjs       # generates THIRD-PARTY-NOTICES.md
├── media/                 # index.html, robot.svg, icon.png
└── test/suite/            # chrome-safety + integration suites
```

## Configuration

Two settings, both about **how the agent is launched**. Neither is needed unless
your machine needs it.

### `piCanvas.agentCwd` — where the agent runs

Empty by default, which means the first workspace folder. pi finds its project
context (`AGENTS.md`), its extensions and its session store relative to the
working directory, so if the agent only behaves correctly in one repository,
point this at it:

```json
{ "piCanvas.agentCwd": "/Users/me/work/agent-sandbox" }
```

`~` is expanded, and relative paths resolve against the workspace folder. The
Sessions view follows: it lists the conversations belonging to this directory.

### `piCanvas.agentCommand` — how the agent is started

Empty by default, which means `node <extension>/scripts/pi-server.mjs`. Set it
when the agent needs a particular environment — a login shell, a specific
Node.js, or a wrapper that exports credentials:

```json
{ "piCanvas.agentCommand": "bash -lc 'exec node \"$PI_CANVAS_SERVER\"'" }
```

The command runs through your shell from `piCanvas.agentCwd`, with these already
in its environment:

| Variable | Meaning |
| --- | --- |
| `PI_CANVAS_SERVER` | absolute path to the bundled server, so a wrapper can exec it |
| `PI_CANVAS_EXTENSION` | the extension's install directory |
| `PI_CANVAS_CWD` | the agent's working directory |
| `PI_CANVAS_PORT` | the port the server must listen on |

Changing either setting restarts the agent server on the same port; open
canvases reconnect themselves.

## Troubleshooting: the agent isn't replying

Two things to check, in order.

**1. Run the diagnostics command.** *Pi Agent Canvas: Run Diagnostics (agent not
replying?)* opens a terminal and starts the same agent server the canvas starts,
sends a prompt, and prints a verdict — replied, failed with the reason, or hung
with the last event it saw. It also prints the details that differ between
machines: the Node.js version and path, the platform, proxy variables and where
pi keeps its config. Because it drives the server directly, it works even when
the canvas shows nothing at all.

**2. Read the log.** *View → Output → Pi Agent Canvas* carries the agent
server's own stdout/stderr, webview crashes, the resolved pi SDK path, the
working directory, the port and `PATH`.

The most common causes:

| Symptom | Cause |
| --- | --- |
| Diagnostics says *"No API key found for the selected model"* | That machine has never logged into pi. Run `pi` in a terminal and use `/login`. The canvas shares pi's credentials. |
| Diagnostics cannot start the server, or the log shows `spawn node ENOENT` | VS Code cannot find `node`. On macOS, a VS Code launched from the Dock does not inherit your shell's `PATH`, so nvm/Homebrew-installed Node is invisible. Launch it from a terminal, or fix `PATH` for GUI apps. |
| The agent replies in one folder but not another | pi keys project context, extensions and sessions off its working directory. Set `piCanvas.agentCwd` to the folder where it behaves. |
| `node` is missing/old, or credentials come from a wrapper | Set `piCanvas.agentCommand` to a login shell or your own wrapper (`PI_CANVAS_SERVER` is provided in its environment). |
| Diagnostics says *HUNG* with no reply | The model request never completed — a network, VPN or proxy problem. A child process inherits VS Code's proxy environment; compare the proxy variables the diagnostics print. |

The canvas needs **no** machine-specific configuration: everything is relative to
the extension or passed in explicitly.

## Licence

MIT — see [LICENSE](LICENSE). Bundled and vendored third-party packages are
listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
