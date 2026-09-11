# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] — 2026-09-11

### Fixed

- **A swap between the two launch settings is named instead of producing
  `spawn /bin/sh ENOENT`.** Reported from a real machine: `piCanvas.agentCwd`
  held the command and `piCanvas.agentCommand` held the directory. The bad
  directory was passed to the spawned process, so the failure surfaced as an
  error about `/bin/sh` with the cause buried a line above. Values are now
  classified (directory / file / command) before use, each setting says which
  of the two it is in its description, and the log records the launch decision.
- A launch setting that cannot work no longer leaves the canvas without an
  agent: the built-in launch is used, and both the log and a notification say
  why.

## [0.2.0] — 2026-09-10

### Added

- **Shell commands from the composer.** Type `!command` to run it instead of
  prompting the agent, and `!!command` to run it while keeping the output out of
  the model's context. It uses pi's own bash execution, so commands inherit pi's
  shell settings, output truncation and session record; output streams into a
  card with the exit code, and the card replays from history after a reload. The
  stop control cancels a running command.
- **`piCanvas.agentCwd`** — the directory the agent runs in, defaulting to the
  first workspace folder. pi keys its project context, extensions and session
  store off the working directory, so this is the fix when the agent only
  behaves in one repository.
- **`piCanvas.agentCommand`** — how the agent server is launched, for machines
  that need a login shell, a specific Node.js, or a wrapper that exports
  credentials. `PI_CANVAS_SERVER`, `PI_CANVAS_EXTENSION`, `PI_CANVAS_CWD` and
  `PI_CANVAS_PORT` are provided in its environment. Changing either launch
  setting restarts the server on the same port.

## [0.1.2] — 2026-09-10

### Added

- **Run Diagnostics (agent not replying?)** — a command that starts the same
  agent server the canvas uses, in a terminal, sends a prompt and prints a
  verdict: replied / failed with the reason / hung with the last event it saw.
  It also prints the environment that matters (node version and path, platform,
  proxy variables, pi config location), so a machine that cannot reach the model
  says so without the UI being involved at all.
- The server now logs which Node.js binary is running it. A VS Code launched
  from the macOS Dock often cannot see nvm or Homebrew paths, and this makes
  that visible in the log instead of silently using a different runtime.

## [0.1.1] — 2026-09-10

Fixes the reason "the agent isn't replying" gave you nothing to go on.

### Added

- **A "Pi Agent Canvas" output channel** carrying the agent server's own
  stdout/stderr, webview crashes, the resolved pi SDK path, the working
  directory, the port and `PATH`. The server used to run with output discarded,
  so every server-side failure was invisible.
- **A failure banner above the composer** with a plain-language cause and a
  *show logs* link: missing pi credentials, an unreachable model provider, a
  missing Node.js, a damaged install. It renders while a session is still
  loading, so even a failure that early is visible.

### Fixed

- A spawn failure (common on macOS, where a Dock-launched VS Code cannot see
  nvm or Homebrew paths, so `node` does not exist) was swallowed silently; it
  now raises a notification with a *Show Log* action.
- The credential error no longer points at documentation paths inside the
  vendored SDK that we do not ship; it names the actual fix.
- A session row whose session file is gone opened a panel that could never load
  and sat on "Connecting to pi…" forever. It now warns and refreshes the list.
- The agent server no longer dies if it writes to its output after the window
  that piped it has gone away.

[0.1.1]: https://github.com/rajdeepyadav004/pi-agent-canvas/releases/tag/v0.1.1
[0.1.2]: https://github.com/rajdeepyadav004/pi-agent-canvas/releases/tag/v0.1.2
[0.2.0]: https://github.com/rajdeepyadav004/pi-agent-canvas/releases/tag/v0.2.0
[0.2.1]: https://github.com/rajdeepyadav004/pi-agent-canvas/releases/tag/v0.2.1

## [0.1.0] — 2026-09-10

First packaged release.

### Added

- **Canvas window** — a dedicated pi agent cockpit in the editor area: a
  streaming thread with markdown, syntax-highlighted code blocks (with copy
  buttons), collapsible tool cards, and provider thinking rendered as a
  collapsible block.
- **Conversations as editor tiles** — one panel per session, named after its
  conversation. Opening a session that is already open reveals its tab instead
  of duplicating it; empty sessions are distinguished by their short id.
  Sessions can be split, dragged and arranged like any file.
- **Files open where you work** — file references in tool cards are chips.
  Clicking one reveals the file in the editor, focusing the group where it is
  already visible and otherwise opening it as a preview tab in the active group,
  so editor panes never multiply on their own.
- **Agent button** — an activity-bar view listing every stored session for the
  workspace, with a live marker for sessions that are open, a new-session
  button, refresh, and the built-in filter (focus the list, press `Ctrl+F`).
- **Edit diffs** — unified ⇄ split toggle with line numbers and syntax
  highlighting, collapsible, long diffs starting collapsed.
- **Abort control** — a stop control that interrupts the agent mid-turn; the
  session stays usable afterwards.
- **Session persistence** — conversations are stored by pi itself, so a reload
  or `pi --continue` in a terminal picks up the same history.
- **Multiple concurrent sessions** — the agent host serves many conversations at
  once, one live session per id, each with its own prompt queue.

### Notes

- The extension writes **no setting** by default. Opt in with
  `piCanvas.disableBuiltInAi` to have it disable VS Code's built-in AI/chat and
  the Copilot extensions (`chat.disableAIFeatures`), which this canvas replaces;
  turning the option off restores the setting if the extension set it.
- The agent runs as a plain Node process beside VS Code, because the extension
  host's `fetch`/`http` patching stalls streaming. Node.js is therefore
  required on `PATH`.

[0.1.0]: https://github.com/rajdeepyadav004/pi-agent-canvas/releases/tag/v0.1.0
