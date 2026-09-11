/**
 * The canvas wire protocol — a typed copy of the subset of pi's RPC vocabulary
 * (pi's `docs/rpc.md`) that the session host and the webview exchange.
 *
 * Why mirror pi's names instead of inventing our own: the host is a pi session
 * host, and pi already documents a protocol for exactly that ("headless
 * operation ... for embedding the agent in other applications, IDEs, or custom
 * UIs"). Naming our commands `prompt`/`abort`/`set_model`/`compact` and our
 * events `agent_settled`/`message_update`/`tool_execution_*` means a future
 * `pi --mode rpc` or ACP adapter is a rename, and it means anyone reading pi's
 * docs can read our logs.
 *
 * Two deliberate deviations, both documented in scripts/pi-server.mjs:
 *   1. `sessionId` is a field on every command and event. pi's RPC mode is one
 *      session per process; a canvas hosts many conversations in one process
 *      (the shape ACP specifies: "each connection can support several
 *      concurrent sessions").
 *   2. `open_session` / `close_session` / `list_sessions` / `server_ready` are
 *      ours: they are about the host's lifecycle, not about one conversation.
 *
 * The host is plain JavaScript (it ships in the .vsix as a script, with no
 * build step), so this module is the *contract*, not the implementation.
 * test/suite/protocol.test.js asserts that both sides still agree with it.
 */

/**
 * Bumped when a command/event changes shape in a way an older client would
 * misread. Sent in `server_ready` so a stale webview can say so instead of
 * silently rendering nothing.
 */
export const PROTOCOL_VERSION = 1;

/** Commands the webview (or a test client) may send to the host. */
export const COMMANDS = [
  // turns
  'prompt',
  'steer',
  'follow_up',
  'abort',
  'abort_bash',
  'bash',
  // sessions
  'open_session',
  'new_session',
  'switch_session',
  'close_session',
  'list_sessions',
  'get_state',
  'get_session_stats',
  'set_session_name',
  // model / context
  'set_model',
  'cycle_model',
  'set_thinking_level',
  'compact',
  // extension UI (the reply half of extension_ui_request)
  'extension_ui_response',
] as const;

export type Command = (typeof COMMANDS)[number];

/** Events the host may push to the webview. */
export const EVENTS = [
  // host lifecycle
  'server_ready',
  'response',
  'session_opened',
  'sessions',
  'server_error',
  // turns
  'agent_start',
  'agent_end',
  'agent_settled',
  'turn_start',
  'turn_end',
  'message_start',
  'message_end',
  'message_update',
  'bash_start',
  'bash_execution_update',
  'bash_end',
  'tool_execution_start',
  'tool_execution_update',
  'tool_execution_end',
  'queue_update',
  'compaction_start',
  'compaction_end',
  'auto_retry_start',
  'auto_retry_end',
  'extension_error',
  // extension UI
  'extension_ui_request',
] as const;

export type EventName = (typeof EVENTS)[number];

/**
 * Extension UI sub-protocol methods (pi's rpc.md § Extension UI Protocol).
 * Dialog methods block the extension until the client answers; the
 * fire-and-forget ones are advisory and must never be waited on.
 */
export const EXTENSION_UI_DIALOG_METHODS = ['select', 'confirm', 'input', 'editor'] as const;
export const EXTENSION_UI_NOTICE_METHODS = ['notify', 'setStatus', 'setTitle', 'setWidget', 'set_editor_text'] as const;
export const EXTENSION_UI_METHODS = [...EXTENSION_UI_DIALOG_METHODS, ...EXTENSION_UI_NOTICE_METHODS] as const;

export type ExtensionUiMethod = (typeof EXTENSION_UI_METHODS)[number];

/** A question or notification an extension raised through `ctx.ui.*`. */
export type ExtensionUiRequest = {
  type: 'extension_ui_request';
  sessionId?: string;
  id: string;
  method: ExtensionUiMethod;
  title?: string;
  options?: string[];
  message?: string;
  placeholder?: string;
  prefill?: string;
  timeout?: number;
  notifyType?: 'info' | 'warning' | 'error';
  statusKey?: string;
  statusText?: string;
  widgetKey?: string;
  widgetLines?: string[];
  text?: string;
};

/** The webview's answer. `cancelled` is required when the turn is cancelled. */
export type ExtensionUiResponse = {
  type: 'extension_ui_response';
  sessionId?: string;
  id: string;
  value?: string;
  confirmed?: boolean;
  cancelled?: boolean;
};

/** A command that wants a correlated reply carries an `id`. */
export type ResponseEnvelope = {
  type: 'response';
  id: string | number;
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
};
