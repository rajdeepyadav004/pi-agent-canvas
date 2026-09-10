/**
 * pi-agent-canvas — webview UI (Cycle 2).
 * assistant-ui thread backed by the real pi bridge: messages flow
 * webview → extension host → `pi --mode json` → streamed events back.
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
} from '@assistant-ui/react';

// ---------------------------------------------------------------------------
// pi transport: direct WebSocket to pi-canvas-server (plain node process on
// localhost). Webview WebSockets are plain Chromium — VS Code's extension-host
// fetch patching (which stalls SSE) never touches this path.
// ---------------------------------------------------------------------------
type PiEvent = { type?: string; assistantMessageEvent?: { type?: string; delta?: string }; error?: unknown };

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

    let text = '';
    let settled = false;
    let error: string | undefined;
    const waiters: (() => void)[] = [];
    const notify = () => waiters.splice(0).forEach((w) => w());

    const listener = (event: PiEvent) => {
      switch (event.type) {
        case 'message_update': {
          if (event.assistantMessageEvent?.type === 'text_delta' && typeof event.assistantMessageEvent.delta === 'string') {
            text += event.assistantMessageEvent.delta;
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
        yield { content: [{ type: 'text', text }] };
      }
      yield { content: [{ type: 'text', text }], status: { type: 'complete', reason: 'stop' } };
    } finally {
      piEventListeners.delete(listener);
      abortSignal.removeEventListener('abort', onAbort);
    }
  },
};

// ---------------------------------------------------------------------------
// UI — primitives + inline styles (surface keeps its own aesthetic).
// ---------------------------------------------------------------------------
const styles: Record<string, React.CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', height: '100vh', color: '#d4d4d8' },
  viewport: { flex: 1, overflowY: 'auto', padding: '24px 32px', display: 'flex', flexDirection: 'column', gap: 12 },
  empty: { margin: 'auto', textAlign: 'center', color: '#71717a', fontSize: 13 },
  message: { maxWidth: 720, padding: '10px 14px', borderRadius: 10, lineHeight: 1.5, whiteSpace: 'pre-wrap' },
  user: { alignSelf: 'flex-end', background: '#27272a', color: '#fafafa' },
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
          <div style={styles.empty}>pi dev canvas — say something; the echo bridge replies.</div>
        </ThreadPrimitive.Empty>
        <ThreadPrimitive.Messages<{ UserMessage: React.ComponentType; AssistantMessage: React.ComponentType }>
          components={{ UserMessage, AssistantMessage }}
        />
      </ThreadPrimitive.Viewport>
      {/* ComposerPrimitive.Root renders the <form> — Enter submits via it. */}
      <ComposerPrimitive.Root style={styles.composer}>
        {/* Enter sends (assistant-ui default); Shift+Enter inserts a newline.
            No Send button, no placeholder — the box is self-evident. */}
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
    <MessagePrimitive.Parts />
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
