# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
