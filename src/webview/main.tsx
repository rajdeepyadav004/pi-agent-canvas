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
  type TextMessagePartComponent,
  type ReasoningMessagePartComponent,
  type ToolCallMessagePartProps,
} from '@assistant-ui/react';

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
  args: unknown;
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
            args: event.args,
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

const TextPartView: TextMessagePartComponent = ({ text }) => <>{text}</>;

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

function ResultBody(result: unknown): React.ReactElement | null {
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
// UI
// ---------------------------------------------------------------------------
const styles: Record<string, React.CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', height: '100vh', color: '#d4d4d8' },
  viewport: { flex: 1, overflowY: 'auto', padding: '24px 32px', display: 'flex', flexDirection: 'column', gap: 12 },
  empty: { margin: 'auto', textAlign: 'center', color: '#71717a', fontSize: 13 },
  message: { maxWidth: 720, padding: '10px 14px', borderRadius: 10, lineHeight: 1.5 },
  user: { alignSelf: 'flex-end', background: '#27272a', color: '#fafafa', whiteSpace: 'pre-wrap' },
  assistant: { alignSelf: 'flex-start', background: '#18181b', border: '1px solid #27272a' },
  composer: { padding: '12px 32px 16px', borderTop: '1px solid #27272a' },
  input: {
    width: '100%',
    background: '#18181b',
    border: '1px solid #3f3f46',
    borderRadius: 8,
    color: '#fafafa',
    padding: '8px 12px',
    font: 'inherit',
    resize: 'none',
  },
};

function CanvasThread() {
  return (
    <ThreadPrimitive.Root style={styles.root}>
      <ThreadPrimitive.Viewport style={styles.viewport} autoScroll>
        <ThreadPrimitive.Empty>
          <div style={styles.empty}>pi dev canvas — ask, and watch it work.</div>
        </ThreadPrimitive.Empty>
        <ThreadPrimitive.Messages<{ UserMessage: React.ComponentType; AssistantMessage: React.ComponentType }>
          components={{ UserMessage, AssistantMessage }}
        />
      </ThreadPrimitive.Viewport>
      {/* ComposerPrimitive.Root renders the <form> — Enter submits via it. */}
      <ComposerPrimitive.Root style={styles.composer}>
        <ComposerPrimitive.Input style={styles.input} rows={1} autoFocus />
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
        tools: { Fallback: ToolCard },
      }}
    />
    <MessagePrimitive.Error style={{ color: '#f87171', marginTop: 6 }} />
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
