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
} from '@assistant-ui/react';
import { MarkdownTextPrimitive, type CodeHeaderProps } from '@assistant-ui/react-markdown';
import remarkGfm from 'remark-gfm';
import { html as renderDiff } from 'diff2html';
import diff2htmlCss from 'diff2html/bundles/css/diff2html.min.css';

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
};

const WS_URL = 'ws://127.0.0.1:47811';
const piEventListeners = new Set<(event: PiEvent) => void>();

let socket: WebSocket | null = null;
function connect() {
  socket = new WebSocket(WS_URL);
  socket.onmessage = (ev) => {
    try {
      const event = JSON.parse(ev.data as string) as PiEvent;
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

function sendToPi(msg: unknown): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

// ---------------------------------------------------------------------------
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

    const onAbort = () => sendToPi({ type: 'abort' });
    abortSignal.addEventListener('abort', onAbort);

    try {
      sendToPi({ type: 'prompt', message: prompt });

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
`;

// diff2html ships its own stylesheet; we render its dark palette and hide the
// file header it draws (the card supplies its own header).
//
// NB: diff2html positions its line numbers `position: absolute` but never sets
// a positioned ancestor, so they would anchor to #root (position: fixed) and
// stay glued to the viewport while the diff scrolls. Each line therefore gets
// `position: relative` to anchor its own number.
const diffCss = `
${diff2htmlCss}
.canvas-diff .d2h-file-header { display: none; }
.canvas-diff .d2h-file-wrapper { border: 0; margin: 0; }
.canvas-diff .d2h-file-diff { overflow: visible; }
.canvas-diff .d2h-code-line,
.canvas-diff .d2h-code-side-line,
.canvas-diff .d2h-code-linenumber,
.canvas-diff .d2h-code-side-linenumber { position: relative; }
.canvas-diff .d2h-code-linenumber,
.canvas-diff .d2h-code-side-linenumber { left: 0; }
.canvas-diff .d2h-code-side-linenumber,
.canvas-diff .d2h-code-linenumber { font-size: 10.5px; }
.canvas-diff .d2h-code-line, .canvas-diff .d2h-code-side-line { font-family: ${Mono}; font-size: 11.5px; }
.canvas-diff table.d2h-diff-table { font-size: 11.5px; table-layout: fixed; }
.canvas-diff .d2h-del { background: #3a1d1d; }
.canvas-diff .d2h-ins { background: #12301c; }
.canvas-diff .d2h-info { background: #1b1b20; color: #8b8b94; }
.canvas-diff .d2h-file-side-diff { vertical-align: top; }
`;

// Markdown styling for assistant text. Scoped to .canvas-md so it can't leak
// into the tool cards / composer chrome.
const markdownCss = `
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
  const detail = summarizeArgs(args) || summarizeArgs(result);
  return (
    <div style={{ margin: '6px 0', background: '#151518', border: '1px solid #2a2a30', borderRadius: 8, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', fontFamily: Mono, fontSize: 12 }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: dot, flexShrink: 0 }} />
        <span style={{ color: '#e4e4e7' }}>{toolName}</span>
        {detail && (
          <span style={{ color: '#8b8b94', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {detail.length > 120 ? `${detail.slice(0, 120)}…` : detail}
          </span>
        )}
        {running && <span style={{ marginLeft: 'auto', color: '#8b8b94' }}>running…</span>}
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
// Edit card — pi's edit tool returns a unified patch in result.details.patch,
// so the diff renders from the patch itself (line-by-line or side-by-side).
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

function patchStats(patch: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  return { added, removed };
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
  const lines = patch ? patch.split('\n').length : 0;
  const [expanded, setExpanded] = React.useState(lines <= 40);
  const [sideBySide, setSideBySide] = React.useState(false);

  const diffMarkup = React.useMemo(() => {
    if (!patch) return '';
    try {
      return renderDiff(patch, {
        outputFormat: sideBySide ? 'side-by-side' : 'line-by-line',
        drawFileList: false,
        matching: 'lines',
        renderNothingWhenEmpty: false,
      });
    } catch {
      return '';
    }
  }, [patch, sideBySide]);

  const dot = isError ? '#f87171' : running ? '#eab308' : '#4ade80';

  return (
    <div style={{ margin: '6px 0', background: '#151518', border: '1px solid #2a2a30', borderRadius: 8, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', fontFamily: Mono, fontSize: 12 }}>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          title={expanded ? 'Collapse' : 'Expand'}
          style={{ background: 'none', border: 0, color: '#8b8b94', cursor: 'pointer', font: 'inherit', padding: 0, width: 10 }}
        >
          {expanded ? '▾' : '▸'}
        </button>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: dot, flexShrink: 0 }} />
        <span style={{ color: '#e4e4e7' }}>edit</span>
        <span style={{ color: '#8b8b94', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file}</span>
        {stats && (
          <span style={{ flexShrink: 0 }}>
            <span style={{ color: '#4ade80' }}>+{stats.added}</span>{' '}
            <span style={{ color: '#f87171' }}>−{stats.removed}</span>
          </span>
        )}
        {running && <span style={{ color: '#8b8b94' }}>running…</span>}
        {patch && expanded && (
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 3 }}>
            <button type="button" style={segButton(!sideBySide)} onClick={() => setSideBySide(false)}>unified</button>
            <button type="button" style={segButton(sideBySide)} onClick={() => setSideBySide(true)}>split</button>
          </span>
        )}
      </div>
      {expanded && diffMarkup && (
        // No inner max-height/overflow: the thread is the single scroll surface,
        // so nothing is trapped in a nested scroller.
        <div
          className="d2h-dark-color-scheme canvas-diff"
          style={{ borderTop: '1px solid #2a2a30' }}
          dangerouslySetInnerHTML={{ __html: diffMarkup }}
        />
      )}
      {expanded && !diffMarkup && (result !== undefined || isError) && (
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
  viewport: { flex: 1, overflowY: 'auto', padding: '24px 32px', display: 'flex', flexDirection: 'column', gap: 12 },
  empty: { margin: 'auto', textAlign: 'center', color: '#71717a', fontSize: 13 },
  message: { maxWidth: 720, padding: '10px 14px', borderRadius: 10, lineHeight: 1.5 },
  user: { alignSelf: 'flex-end', background: '#27272a', color: '#fafafa', whiteSpace: 'pre-wrap' },
  assistant: { alignSelf: 'flex-start', background: '#18181b', border: '1px solid #27272a', whiteSpace: 'normal', maxWidth: 900 },
  composer: { padding: '12px 32px 16px', borderTop: '1px solid #27272a' },
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

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
function App() {
  const runtime = useLocalRuntime(PiAdapter);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <CanvasThread />
    </AssistantRuntimeProvider>
  );
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
  styleTag.textContent = uiCss + markdownCss + diffCss;
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
