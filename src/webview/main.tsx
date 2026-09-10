/**
 * pi-agent-canvas — webview UI (Cycle 2).
 *
 * assistant-ui thread backed by pi-canvas-server: the webview opens a plain
 * Chromium WebSocket to a local node process that owns the pi AgentSession.
 * Direct WebSocket on purpose — VS Code's extension host patches fetch/http
 * and stalls SSE; a webview WebSocket never touches that path.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import {
  AssistantRuntimeProvider,
  useLocalRuntime,
  ThreadPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  type ChatModelAdapter,
  type ThreadMessage,
  type ReasoningMessagePartComponent,
  type ToolCallMessagePartProps,
  type ThreadMessageLike,
  useAui,
  useAuiState,
} from '@assistant-ui/react';
import { MarkdownTextPrimitive, type CodeHeaderProps } from '@assistant-ui/react-markdown';
import remarkGfm from 'remark-gfm';
import { DiffView, DiffModeEnum } from '@git-diff-view/react';
import diffusionCss from '@git-diff-view/react/styles/diff-view.css';

// ---------------------------------------------------------------------------
// pi transport: direct WebSocket to pi-canvas-server.
//   out: {type:'prompt',message} | {type:'abort'}
//   in:  SDK session events (agent_start, message_update {text_delta |
//        thinking_delta}, tool_execution_start/update/end, …) + settled | error
// ---------------------------------------------------------------------------
type PiEvent = {
  type?: string;
  assistantMessageEvent?: { type?: string; delta?: string };
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  partialResult?: unknown;
  result?: unknown;
  isError?: boolean;
  error?: unknown;
  messages?: WireMessage[];
  aborted?: boolean;
  sessionFile?: string | null;
  sessionId?: string;
  history?: WireMessage[];
};

// Injected by the extension (media/index.html) — one server per window, one
// conversation per panel. An empty session means this panel owns a new one.
declare global {
  interface Window {
    __PI_CANVAS_WS__?: string;
    __PI_CANVAS_SESSION__?: string;
    __PI_CANVAS_MODE__?: 'new' | 'continue';
  }
}
const WS_URL = window.__PI_CANVAS_WS__ ?? 'ws://127.0.0.1:47811';
const SESSION_ID = window.__PI_CANVAS_SESSION__ || undefined;
const SESSION_MODE = window.__PI_CANVAS_MODE__ ?? 'continue';
const piEventListeners = new Set<(event: PiEvent) => void>();

let socket: WebSocket | null = null;

/**
 * The conversation this canvas is showing. Asked for on every connect: the
 * server is a session host, so a canvas tab owns one session and a second tab
 * can own another (or rejoin this one by id).
 */
let activeSessionId: string | undefined;

function connect() {
  socket = new WebSocket(WS_URL);
  socket.onopen = () => {
    // This panel either owns a session already, or asks the host's chosen mode:
    // 'continue' resumes the workspace's most recent conversation (no new tab
    // silently forks the thread), 'new' starts a fresh one.
    sendToPi(
      SESSION_ID
        ? { type: 'open_session', sessionId: SESSION_ID }
        : { type: 'open_session', mode: SESSION_MODE },
    );
  };
  socket.onmessage = (ev) => {
    try {
      const event = JSON.parse(ev.data as string) as PiEvent;
      if (event.type === 'session_opened') {
        activeSessionId = event.sessionId;
        // Let the host name the tab after this conversation and re-key its
        // panel registry, so "open session" later reveals this tab.
        vsapi().postMessage({ type: 'sessionOpened', sessionId: event.sessionId });
      }
      for (const l of piEventListeners) l(event);
    } catch { /* ignore malformed lines */ }
  };
  socket.onclose = () => {
    socket = null;
    setTimeout(connect, 2000); // reconnect; server may start later
  };
  socket.onerror = () => socket?.close();
}
connect();

/** Returns false when the server socket isn't open (caller surfaces that). */
function sendToPi(msg: unknown): boolean {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(msg));
  return true;
}

// ---------------------------------------------------------------------------
// Stored-session history → assistant-ui messages.
//
// The server replays the pi session's own messages on connect, so a reloaded
// webview shows the thread the agent still has in context (and the next prompt
// continues it). Tool results arrive as separate messages and are folded back
// into the tool-call part they belong to rather than rendered on their own.
// ---------------------------------------------------------------------------
type WireContent = {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, any>;
};
type WireMessage = {
  role?: string;
  content?: string | WireContent[];
  toolCallId?: string;
  details?: unknown;
  isError?: boolean;
};

function contentToText(content: string | WireContent[] | undefined): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c) => (c.type === 'text' ? c.text ?? '' : '')).join('');
}

function historyToThreadMessages(messages: WireMessage[]): ThreadMessageLike[] {
  const out: ThreadMessageLike[] = [];
  // toolCallId -> the part awaiting its result, so results fold in place.
  const pending = new Map<string, Extract<Part, { type: 'tool-call' }>>();

  for (const m of messages) {
    if (m.role === 'user') {
      const text = contentToText(m.content);
      if (text.trim()) out.push({ role: 'user', content: [{ type: 'text', text }] });
      continue;
    }
    if (m.role === 'assistant') {
      const content: any[] = [];
      for (const c of Array.isArray(m.content) ? m.content : []) {
        if (c.type === 'text' && c.text) content.push({ type: 'text', text: c.text });
        else if (c.type === 'thinking' && c.thinking) content.push({ type: 'reasoning', text: c.thinking });
        else if (c.type === 'toolCall' && c.id) {
          const part: Extract<Part, { type: 'tool-call' }> = {
            type: 'tool-call',
            toolCallId: c.id,
            toolName: c.name ?? 'tool',
            args: c.arguments ?? {},
            argsText: '',
            isError: false,
          };
          pending.set(c.id, part);
          content.push(part);
        }
      }
      if (content.length) {
        out.push({ role: 'assistant', content, status: { type: 'complete', reason: 'stop' } });
      }
      continue;
    }
    if (m.role === 'toolResult' && m.toolCallId) {
      const part = pending.get(m.toolCallId);
      if (part) {
        // Same shape the live tool_execution_end path produces, so ToolCard and
        // EditCard (result.details.patch) render history and live turns alike.
        part.result = { content: m.content, details: m.details };
        part.isError = Boolean(m.isError);
      }
    }
  }
  return out;
}

// Adapter — accumulates a part stream for the running turn.
// ---------------------------------------------------------------------------
type TextPart = { type: 'text'; text: string };
type ReasoningPart = { type: 'reasoning'; text: string };
type ToolPart = {
  type: 'tool-call';
  toolCallId: string;
  toolName: string;
  args: Record<string, any>;
  argsText: string;
  result?: unknown;
  isError?: boolean;
};
type Part = TextPart | ReasoningPart | ToolPart;

function textOf(msg: ThreadMessage): string {
  return (msg.content ?? [])
    .filter((p): p is Extract<ThreadMessage['content'][number], { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join(' ');
}

function extractLastUserText(messages: readonly ThreadMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user') return textOf(m);
  }
  return '';
}

const PiAdapter: ChatModelAdapter = {
  async *run({ messages, abortSignal }) {
    const prompt = extractLastUserText(messages);

    const parts: Part[] = [];
    let settled = false;
    let error: string | undefined;
    const waiters: (() => void)[] = [];
    const notify = () => waiters.splice(0).forEach((w) => w());

    /** Last part of a given kind, so consecutive deltas extend one part. */
    const tail = <T extends Part['type']>(type: T) => {
      const last = parts[parts.length - 1];
      return last && last.type === type ? (last as Extract<Part, { type: T }>) : undefined;
    };

    const listener = (event: PiEvent) => {
      // The socket carries every live session; only ours belongs here.
      if (event.sessionId && activeSessionId && event.sessionId !== activeSessionId) return;
      switch (event.type) {
        case 'message_update': {
          const ev = event.assistantMessageEvent;
          if (ev?.type === 'text_delta' && typeof ev.delta === 'string') {
            // Text after a tool call starts a new bubble segment.
            const p = (tail('text') ?? (parts.push({ type: 'text', text: '' }), tail('text')))!;
            p.text += ev.delta;
            notify();
          } else if (ev?.type === 'thinking_delta' && typeof ev.delta === 'string') {
            const p = (tail('reasoning') ?? (parts.push({ type: 'reasoning', text: '' }), tail('reasoning')))!;
            p.text += ev.delta;
            notify();
          }
          break;
        }
        case 'tool_execution_start':
          parts.push({
            type: 'tool-call',
            toolCallId: String(event.toolCallId ?? ''),
            toolName: String(event.toolName ?? 'tool'),
            args: (event.args ?? {}) as Record<string, any>,
            argsText: '',
          });
          notify();
          break;
        case 'tool_execution_update': {
          const p = parts.find((x) => x.type === 'tool-call' && x.toolCallId === event.toolCallId);
          if (p?.type === 'tool-call') { p.result = event.partialResult; notify(); }
          break;
        }
        case 'tool_execution_end': {
          const p = parts.find((x) => x.type === 'tool-call' && x.toolCallId === event.toolCallId);
          if (p?.type === 'tool-call') {
            p.result = event.result;
            p.isError = Boolean(event.isError);
            notify();
          }
          break;
        }
        case 'settled':
          settled = true;
          notify();
          break;
        case 'server_error':
          error = String(event.error ?? 'pi server error');
          settled = true;
          notify();
          break;
      }
    };
    piEventListeners.add(listener);

    // Waking the parked loop is what makes cancellation take effect: the run
    // loop in assistant-ui aborts the signal but never finishes the generator
    // for us, so without notify() this await would hold the turn open until
    // some unrelated event arrived.
    const onAbort = () => {
      sendToPi({ type: 'abort', sessionId: activeSessionId });
      notify();
    };
    abortSignal.addEventListener('abort', onAbort);

    try {
      if (!sendToPi({ type: 'prompt', message: prompt, sessionId: activeSessionId })) {
        throw new Error('pi-canvas-server is not connected — is the canvas window still starting?');
      }

      while (!settled) {
        await new Promise<void>((resolve) => waiters.push(resolve));
        if (abortSignal.aborted) return;
        if (error) throw new Error(error);
        yield { content: parts.map((p) => ({ ...p })) };
      }
      yield { content: parts.map((p) => ({ ...p })), status: { type: 'complete', reason: 'stop' } };
    } finally {
      piEventListeners.delete(listener);
      abortSignal.removeEventListener('abort', onAbort);
    }
  },
};

// ---------------------------------------------------------------------------
// File tiles
//
// The agent's file references render as chips. Clicking one opens that file in
// the editor area (reusing its tab) — the reason this canvas lives in VS Code
// rather than in a terminal: the conversation and the code it touches are in
// the same place.
// ---------------------------------------------------------------------------
/** Ask the extension host to reveal a path in the editor. */
function openInEditor(path: string, line?: number): void {
  vsapi().postMessage({ type: 'openFile', path, line });
}

/** File paths in tool args live under a few names. */
function fileOf(args: unknown): string | undefined {
  return pathOf(args);
}

const FileChip = ({ path, line }: { path: string; line?: number }) => {
  const [hover, setHover] = React.useState(false);
  return (
    <button
      type="button"
      className="canvas-file"
      title={`Open ${path} in the editor`}
      onClick={() => openInEditor(path, line)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        background: 'none',
        border: 0,
        borderRadius: 3,
        padding: '0 3px',
        margin: '0 -3px',
        font: 'inherit',
        cursor: 'pointer',
        color: hover ? '#93c5fd' : '#a1a1aa',
        textDecoration: hover ? 'underline' : 'none',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        minWidth: 0,
        textAlign: 'left',
      }}
    >
      {path}
    </button>
  );
};

// ---------------------------------------------------------------------------
// Part renderers
// ---------------------------------------------------------------------------
const Mono = 'ui-monospace, SFMono-Regular, Menlo, monospace';

// Composer chrome lives in CSS because ComposerPrimitive.Input's `style` prop
// is typed for autosize height and rejects a plain CSSProperties object.
const uiCss = `
.canvas-input {
  width: 100%; background: #18181b; border: 1px solid #3f3f46; border-radius: 8px;
  color: #fafafa; padding: 8px 12px; font: inherit; resize: none; outline: none;
}
.canvas-input:focus { border-color: #52525b; }
.canvas-stop {
  display: flex; align-items: center; justify-content: center; flex: none;
  width: 34px; height: 34px;
  background: #27272a; border: 1px solid #3f3f46; border-radius: 8px; cursor: pointer;
}
.canvas-stop:hover { background: #3f3f46; }
.canvas-stop-glyph { width: 8px; height: 8px; background: #f87171; border-radius: 2px; }
`;

// Markdown styling for assistant text. Scoped to .canvas-md so it can't leak
// into the tool cards / composer chrome.
const markdownCss = `
.canvas-md { max-width: 900px; }
.canvas-md > *:first-child { margin-top: 0; }
.canvas-md > *:last-child { margin-bottom: 0; }
.canvas-md p { margin: 0 0 10px; }
.canvas-md h1, .canvas-md h2, .canvas-md h3, .canvas-md h4 {
  margin: 16px 0 8px; font-weight: 600; line-height: 1.3; color: #fafafa;
}
.canvas-md h1 { font-size: 1.35em; }
.canvas-md h2 { font-size: 1.2em; }
.canvas-md h3 { font-size: 1.05em; }
.canvas-md ul, .canvas-md ol { margin: 0 0 10px; padding-left: 22px; }
.canvas-md li { margin: 3px 0; }
.canvas-md li > p { margin: 0; }
.canvas-md a { color: #7dd3fc; text-decoration: none; }
.canvas-md a:hover { text-decoration: underline; }
.canvas-md strong { color: #fafafa; font-weight: 600; }
.canvas-md em { color: #e4e4e7; }
.canvas-md hr { border: 0; border-top: 1px solid #2a2a30; margin: 14px 0; }
.canvas-md blockquote {
  margin: 0 0 10px; padding: 2px 0 2px 12px;
  border-left: 2px solid #3f3f46; color: #a1a1aa;
}
.canvas-md :not(pre) > code {
  background: #26262b; border-radius: 4px; padding: 1px 5px;
  font-family: ${Mono}; font-size: 0.88em; color: #e4e4e7;
}
.canvas-md pre {
  margin: 0; padding: 10px 12px; background: #101013;
  overflow-x: auto; font-family: ${Mono}; font-size: 12px; line-height: 1.5;
}
.canvas-md pre code { font-family: inherit; }
.canvas-md table {
  border-collapse: collapse; margin: 0 0 10px; font-size: 0.92em; display: block; overflow-x: auto;
}
.canvas-md th, .canvas-md td { border: 1px solid #2a2a30; padding: 5px 9px; text-align: left; }
.canvas-md th { background: #1e1e22; font-weight: 600; color: #fafafa; }
.canvas-md input[type='checkbox'] { margin-right: 6px; }
`;

/** Fenced code: language label + copy button above a styled block. */
const CodeHeader = ({ language, code }: CodeHeaderProps) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', background: '#16161a', borderBottom: '1px solid #2a2a30', fontFamily: Mono, fontSize: 11, color: '#8b8b94' }}>
    <span>{language || 'text'}</span>
    <button
      type="button"
      onClick={() => void navigator.clipboard?.writeText(code)}
      style={{ marginLeft: 'auto', background: 'none', border: 0, color: '#8b8b94', cursor: 'pointer', font: 'inherit', padding: 0 }}
    >
      copy
    </button>
  </div>
);

const TextPartView = () => (
  <MarkdownTextPrimitive
    remarkPlugins={[remarkGfm]}
    className="canvas-md"
    components={{ CodeHeader }}
  />
);

const ReasoningPartView: ReasoningMessagePartComponent = ({ text, status }) => {
  const streaming = status?.type === 'running';
  return (
    <details open={streaming} style={{ margin: '2px 0 8px', color: '#8b8b94' }}>
      <summary style={{ cursor: 'pointer', fontSize: 12, color: streaming ? '#a1a1aa' : '#71717a' }}>
        {streaming ? 'Thinking…' : 'Thought'}
      </summary>
      <div style={{ marginTop: 4, fontSize: 12, whiteSpace: 'pre-wrap', borderLeft: '2px solid #2f2f35', paddingLeft: 10 }}>
        {text}
      </div>
    </details>
  );
};

/** One-line argument preview: the field a human would look for. */
function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const a = args as Record<string, unknown>;
  for (const k of ['command', 'path', 'file_path', 'filePath', 'pattern', 'query', 'url', 'description']) {
    if (typeof a[k] === 'string') return a[k] as string;
  }
  const first = Object.values(a).find((v) => typeof v === 'string');
  return typeof first === 'string' ? first : '';
}

function ResultBody({ result }: { result: unknown }): React.ReactElement | null {
  if (result === undefined || result === null) return null;
  const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  const clipped = text.length > 4000 ? `${text.slice(0, 4000)}\n… (${text.length - 4000} more chars)` : text;
  return (
    <pre style={{ margin: '6px 0 0', padding: 8, background: '#101013', borderRadius: 6, overflowX: 'auto', fontFamily: Mono, fontSize: 11.5, lineHeight: 1.45, whiteSpace: 'pre-wrap' }}>
      {clipped}
    </pre>
  );
}

const ToolCard = ({ toolName, args, result, isError, status }: ToolCallMessagePartProps) => {
  const running = status?.type === 'running';
  const dot = isError ? '#f87171' : running ? '#eab308' : '#4ade80';
  const file = fileOf(args);
  const detail = file ? undefined : summarizeArgs(args) || summarizeArgs(result);
  return (
    <div style={{ margin: '6px 0', background: '#151518', border: '1px solid #2a2a30', borderRadius: 8, overflow: 'hidden', minWidth: 0, maxWidth: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', fontFamily: Mono, fontSize: 12, minWidth: 0 }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: dot, flexShrink: 0 }} />
        <span style={{ color: '#e4e4e7', flexShrink: 0 }}>{toolName}</span>
        {file && <FileChip path={file} />}
        {detail && (
          /* minWidth:0 lets the nowrap line actually shrink + ellipsise instead
             of forcing the whole thread to scroll sideways. */
          <span style={{ color: '#8b8b94', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
            {detail.length > 120 ? `${detail.slice(0, 120)}…` : detail}
          </span>
        )}
        {running && <span style={{ marginLeft: 'auto', color: '#8b8b94', flexShrink: 0 }}>running…</span>}
      </div>
      {(result !== undefined || isError) && (
        <div style={{ padding: '0 10px 8px' }}>
          <details>
            <summary style={{ cursor: 'pointer', fontSize: 11.5, color: '#71717a' }}>{isError ? 'Error output' : 'Output'}</summary>
            <ResultBody result={result} />
          </details>
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Edit card — pi's edit tool returns a unified patch in result.details.patch.
// It renders through @git-diff-view/react (MIT): a purpose-built git-diff
// renderer with real split/unified modes, syntax highlighting and line numbers
// taken from the hunk headers. Its CSS uses no absolute positioning and no
// global resets, so it composes with the thread instead of fighting it.
// ---------------------------------------------------------------------------
function patchOf(result: unknown): string | undefined {
  if (result && typeof result === 'object') {
    const details = (result as { details?: { patch?: unknown } }).details;
    if (details && typeof details.patch === 'string') return details.patch;
  }
  return undefined;
}

function pathOf(args: unknown): string | undefined {
  if (args && typeof args === 'object') {
    const a = args as Record<string, unknown>;
    for (const k of ['path', 'file_path', 'filePath']) {
      if (typeof a[k] === 'string') return a[k] as string;
    }
  }
  return undefined;
}

function patchStats(patch: string): { added: number; removed: number; lines: number } {
  let added = 0;
  let removed = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  return { added, removed, lines: patch.split('\n').length };
}

/**
 * Pull the file names out of a unified patch. The patch itself is handed to
 * @git-diff-view as a single `hunks` entry: each entry there is parsed as a
 * COMPLETE unified diff (header included), so passing only the `@@` body
 * yields an empty diff.
 */
function parsePatch(patch: string): { oldName?: string; newName?: string } {
  let oldName: string | undefined;
  let newName: string | undefined;
  for (const l of patch.split('\n')) {
    if (l.startsWith('--- ')) oldName = l.slice(4).trim();
    else if (l.startsWith('+++ ')) newName = l.slice(4).trim();
    else if (l.startsWith('@@')) break;
  }
  return { oldName, newName };
}

const LANG_BY_EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', json: 'json',
  md: 'markdown', css: 'css', html: 'xml', py: 'python', rs: 'rust', go: 'go',
  java: 'java', rb: 'ruby', sh: 'bash', bash: 'bash', yml: 'yaml', yaml: 'yaml',
  toml: 'ini', sql: 'sql', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp',
};

function langOf(file?: string): string {
  const ext = file?.split('.').pop()?.toLowerCase();
  return (ext && LANG_BY_EXT[ext]) || 'plaintext';
}

const segButton = (active: boolean): React.CSSProperties => ({
  background: active ? '#2f2f35' : 'none',
  border: '1px solid ' + (active ? '#3f3f46' : 'transparent'),
  borderRadius: 4,
  color: active ? '#e4e4e7' : '#8b8b94',
  cursor: 'pointer',
  font: 'inherit',
  fontSize: 11,
  padding: '2px 7px',
});

const EditCard = ({ args, result, isError, status }: ToolCallMessagePartProps) => {
  const running = status?.type === 'running';
  const patch = patchOf(result);
  const file = pathOf(args) ?? 'edit';
  const stats = patch ? patchStats(patch) : undefined;
  // Long diffs start collapsed so they don't flood the thread; short ones are
  // the point of the card, so they open. Always toggleable.
  const [expanded, setExpanded] = React.useState((stats?.lines ?? 0) <= 40);
  const [sideBySide, setSideBySide] = React.useState(false);

  const parsed = React.useMemo(() => (patch ? parsePatch(patch) : undefined), [patch]);

  const data = React.useMemo(() => {
    if (!parsed || !patch) return undefined;
    const name = parsed.newName ?? parsed.oldName;
    return {
      oldFile: { fileName: parsed.oldName, fileLang: langOf(parsed.oldName) },
      newFile: { fileName: parsed.newName ?? name, fileLang: langOf(parsed.newName ?? name) },
      hunks: [patch],
    };
  }, [parsed]);

  const dot = isError ? '#f87171' : running ? '#eab308' : '#4ade80';

  return (
    <div style={{ margin: '6px 0', background: '#151518', border: '1px solid #2a2a30', borderRadius: 8, overflow: 'hidden', minWidth: 0, maxWidth: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', fontFamily: Mono, fontSize: 12, minWidth: 0 }}>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          title={expanded ? 'Collapse' : 'Expand'}
          style={{ background: 'none', border: 0, color: '#8b8b94', cursor: 'pointer', font: 'inherit', padding: 0, width: 10, flexShrink: 0 }}
        >
          {expanded ? '▾' : '▸'}
        </button>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: dot, flexShrink: 0 }} />
        <span style={{ color: '#e4e4e7', flexShrink: 0 }}>edit</span>
        <FileChip path={file} />
        {stats && (
          <span style={{ flexShrink: 0 }}>
            <span style={{ color: '#4ade80' }}>+{stats.added}</span>{' '}
            <span style={{ color: '#f87171' }}>−{stats.removed}</span>
          </span>
        )}
        {running && <span style={{ color: '#8b8b94', flexShrink: 0 }}>running…</span>}
        {data && expanded && (
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 3, flexShrink: 0 }}>
            <button type="button" style={segButton(!sideBySide)} onClick={() => setSideBySide(false)}>unified</button>
            <button type="button" style={segButton(sideBySide)} onClick={() => setSideBySide(true)}>split</button>
          </span>
        )}
      </div>
      {expanded && data && (
        // One scroll surface: the diff flows in the thread, never in a nested
        // scroller, and `minWidth: 0` keeps it from widening the thread.
        <div style={{ borderTop: '1px solid #2a2a30', minWidth: 0, overflow: 'hidden' }}>
          <DiffView
            data={data}
            diffViewMode={sideBySide ? DiffModeEnum.Split : DiffModeEnum.Unified}
            diffViewTheme="dark"
            diffViewHighlight
            diffViewFontSize={11.5}
            diffViewWrap={!sideBySide}
          />
        </div>
      )}
      {expanded && !data && (result !== undefined || isError) && (
        <div style={{ padding: '0 10px 8px' }}>
          <ResultBody result={result} />
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------
const styles: Record<string, React.CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', height: '100vh', color: '#d4d4d8' },
  viewport: { flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '24px 32px', display: 'flex', flexDirection: 'column', gap: 12 },
  empty: { margin: 'auto', textAlign: 'center', color: '#71717a', fontSize: 13 },
  // maxWidth uses min(): a fixed px cap alone overflows narrow windows.
  message: { maxWidth: 'min(720px, 100%)', minWidth: 0, padding: '10px 14px', borderRadius: 10, lineHeight: 1.5 },
  user: { alignSelf: 'flex-end', background: '#27272a', color: '#fafafa', whiteSpace: 'pre-wrap' },
  // Overrides the base message cap: the assistant column spans the thread so
  // diffs (especially split view) get the full width; prose is capped in .canvas-md.
  assistant: { alignSelf: 'stretch', background: '#18181b', border: '1px solid #27272a', whiteSpace: 'normal', minWidth: 0, maxWidth: '100%' },
  composer: { padding: '12px 32px 16px', borderTop: '1px solid #27272a', display: 'flex', alignItems: 'center', gap: 8 },
  connecting: { color: '#8b8b94', fontFamily: Mono, fontSize: 12, padding: 24 },
};

function CanvasThread() {
  return (
    <ThreadPrimitive.Root style={styles.root}>
      <ThreadPrimitive.Viewport style={styles.viewport} autoScroll>
        <ThreadPrimitive.Empty>
          <div style={styles.empty}>pi dev canvas — ask, and watch it work.</div>
        </ThreadPrimitive.Empty>
        <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
      </ThreadPrimitive.Viewport>
      {/* ComposerPrimitive.Root renders the <form> — Enter submits via it. */}
      <ComposerPrimitive.Root style={styles.composer}>
        <ComposerPrimitive.Input className="canvas-input" rows={1} autoFocus />
        <StopButton />
      </ComposerPrimitive.Root>
    </ThreadPrimitive.Root>
  );
}

const UserMessage = () => (
  <MessagePrimitive.Root style={{ ...styles.message, ...styles.user }}>
    <MessagePrimitive.Parts />
  </MessagePrimitive.Root>
);

const AssistantMessage = () => (
  <MessagePrimitive.Root style={{ ...styles.message, ...styles.assistant }}>
    <MessagePrimitive.Parts
      components={{
        Text: TextPartView,
        Reasoning: ReasoningPartView,
        tools: { by_name: { edit: EditCard }, Fallback: ToolCard },
      }}
    />
    <div style={{ color: '#f87171', marginTop: 6 }}>
      <MessagePrimitive.Error />
    </div>
  </MessagePrimitive.Root>
);

// Cancelling the run aborts the signal; the adapter turns that into an
// {"type":"abort"} command for pi-canvas-server, which stops the agent.
function StopButton() {
  const aui = useAui();
  const running = useAuiState((s) => s.thread.isRunning);
  if (!running) return null;
  return (
    <button
      type="button"
      className="canvas-stop"
      title="Stop"
      aria-label="Stop"
      onClick={() => aui.thread.cancelRun()}
    >
      <span className="canvas-stop-glyph" />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Bootstrap
//
// The runtime is created once the session history arrives, so a reloaded
// webview starts with the stored conversation already in the thread. The `key`
// remounts it if the server restarts and replays a (possibly different)
// session.
// ---------------------------------------------------------------------------
function CanvasRuntime({ initialMessages }: { initialMessages: readonly ThreadMessageLike[] }) {
  const runtime = useLocalRuntime(PiAdapter, { initialMessages });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <CanvasThread />
    </AssistantRuntimeProvider>
  );
}

function App() {
  const [initial, setInitial] = React.useState<ThreadMessageLike[] | null>(null);

  React.useEffect(() => {
    const listener = (event: PiEvent) => {
      if (event.type !== 'session_opened') return;
      // Hydrate once, from the first replay. Later replays (a reconnect) must
      // not rebuild the runtime: remounting throws away the thread and any
      // run already in flight. The agent's context lives server-side anyway.
      setInitial((prev) => prev ?? historyToThreadMessages(event.history ?? []));
    };
    piEventListeners.add(listener);
    return () => { piEventListeners.delete(listener); };
  }, []);

  // No agent without the server, so waiting for the first replay is honest —
  // and it means every prompt is typed into the runtime that owns the history.
  if (initial === null) return <div style={styles.connecting}>Connecting to pi…</div>;
  return <CanvasRuntime initialMessages={initial} />;
}

// Acquire the VS Code API exactly once (a second acquire throws).
// Outside VS Code (plain browser) this stays null.
let vsapiHandle: { postMessage(msg: unknown): void } | null = null;
function vsapi() {
  if (!vsapiHandle) {
    try {
      vsapiHandle = acquireVsCodeApi();
    } catch {
      vsapiHandle = { postMessage: () => {} };
    }
  }
  return vsapiHandle;
}

const container = document.getElementById('root');
if (container) {
  // Markdown styles live in a <style> tag — cheaper than per-node inline styles.
  const styleTag = document.createElement('style');
  styleTag.textContent = uiCss + markdownCss + diffusionCss;
  document.head.append(styleTag);
  createRoot(container).render(<App />);
}

// Keep the host bridge alive + surface webview crashes in the launch log.
{
  const vscode = vsapi();
  vscode.postMessage({ type: 'ready' });
  window.addEventListener('error', (e) =>
    vscode.postMessage({ type: 'webview-error', payload: String(e.error ?? e.message) }),
  );
  window.addEventListener('unhandledrejection', (e) =>
    vscode.postMessage({ type: 'webview-error', payload: String(e.reason) }),
  );
}
