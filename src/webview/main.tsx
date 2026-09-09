/**
 * pi-agent-canvas — webview UI (Cycle 2 starts here).
 * assistant-ui on top of the canvas surface: a thread view driven by a
 * ChatModelAdapter. The echo adapter is a placeholder; the real pi bridge
 * will replace `EchoAdapter.run` with the extension-host transport.
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
// pi bridge (placeholder): streams an echo reply. Replace with postMessage
// round-trips to the extension host, which forwards to pi.
// ---------------------------------------------------------------------------
const extractText = (msg: ThreadMessage | undefined): string =>
  (msg?.content ?? [])
    .filter((p): p is Extract<ThreadMessage['content'][number], { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join(' ');

const EchoAdapter: ChatModelAdapter = {
  async *run({ messages, abortSignal }) {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const prompt = extractText(lastUser);
    const reply = `pi dev canvas (assistant-ui scaffold) — echo: ${prompt || '(empty)'}`;

    let sent = '';
    for (let i = 0; i < reply.length; i += 6) {
      if (abortSignal.aborted) return;
      sent = reply.slice(0, i + 6);
      yield { content: [{ type: 'text', text: sent }] };
      await new Promise((r) => setTimeout(r, 15));
    }
    yield { content: [{ type: 'text', text: reply }], status: { reason: 'stop' } };
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
  composer: { display: 'flex', gap: 8, padding: '12px 32px 16px', borderTop: '1px solid #27272a' },
  input: {
    flex: 1,
    background: '#18181b',
    border: '1px solid #3f3f46',
    borderRadius: 8,
    color: '#fafafa',
    padding: '8px 12px',
    font: 'inherit',
    resize: 'none',
  },
  button: {
    background: '#3b82f6',
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    padding: '8px 16px',
    font: 'inherit',
    cursor: 'pointer',
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
      <div style={styles.composer}>
        <ComposerPrimitive.Input style={styles.input} rows={1} autoFocus placeholder="Message…" />
        <ComposerPrimitive.Send style={styles.button}>Send</ComposerPrimitive.Send>
      </div>
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
  </MessagePrimitive.Root>
);

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
function App() {
  const runtime = useLocalRuntime(EchoAdapter);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <CanvasThread />
    </AssistantRuntimeProvider>
  );
}

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(<App />);
}

// Keep the host bridge alive.
try {
  const vscode = acquireVsCodeApi();
  vscode.postMessage({ type: 'ready' });
} catch {
  /* running outside VS Code (e.g. plain browser) — fine */
}
