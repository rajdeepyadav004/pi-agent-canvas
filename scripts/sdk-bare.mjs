// Bare-node reproduction of the in-process SDK bridge.
import { createAgentSession, ModelRuntime, SessionManager } from '@earendil-works/pi-coding-agent';

const modelRuntime = await ModelRuntime.create();
const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  modelRuntime,
});
session.subscribe((e) => console.log('event', e.type, e.assistantMessageEvent?.type ?? ''));
console.log('prompting…');
const t0 = Date.now();
await session.prompt('Reply with exactly: SDK-BARE-OK');
console.log('done in', Date.now() - t0, 'ms');
process.exit(0);
