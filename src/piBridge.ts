/**
 * pi-agent-canvas — pi bridge (extension-host side).
 *
 * Talks to a plain-Node shim process (scripts/pi-host.mjs) that owns an
 * in-process pi AgentSession. Rationale: the VS Code extension host patches
 * fetch/http for proxy support, and SSE streaming through that patch stalls
 * (requests never reach the network). The shim is a normal Node process, so
 * pi's HTTP works exactly as on the CLI.
 *
 * Protocol: strict JSONL on stdio — in: {type:'prompt'|'abort'},
 * out: SDK events + {type:'shim_ready'|'shim_settled'|'shim_error'}.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

export type PiEvent = Record<string, unknown> & { type?: string };

export class PiBridge {
  private child: ChildProcess | null = null;
  private starting: Promise<void> | null = null;
  private buffer = '';
  private chain: Promise<void> = Promise.resolve();
  private listeners: ((event: PiEvent) => void)[] = [];
  private settleWaiters: ((event: PiEvent) => void)[] = [];

  constructor(
    private readonly extensionDir: string,
    private readonly log: (line: string) => void = () => {},
  ) {}

  onEvent(listener: (event: PiEvent) => void): void {
    this.listeners.push(listener);
  }

  private emit(event: PiEvent): void {
    this.log(`event ${String(event.type ?? '?')} ${JSON.stringify(event).slice(0, 200)}`);
    for (const l of this.listeners) l(event);
    for (const w of this.settleWaiters) w(event);
  }

  /** Serialized: prompts run one at a time, in submission order. */
  prompt(message: string): void {
    this.chain = this.chain
      .then(() => this.ensureShim())
      .then(
        () =>
          new Promise<void>((resolve) => {
            this.emit({ type: 'pi_start' });
            const onSettled = (event: PiEvent) => {
              if (event.type === 'shim_settled' || event.type === 'shim_error') {
                this.settleWaiters = this.settleWaiters.filter((w) => w !== onSettled);
                resolve();
              }
            };
            this.settleWaiters.push(onSettled);
            this.write({ type: 'prompt', message });
          }),
      )
      .catch((err) => {
        this.log(`bridge error: ${err}`);
        this.emit({ type: 'pi_error', error: String(err) });
      });
  }

  abort(): void {
    this.write({ type: 'abort' });
  }

  dispose(): void {
    this.child?.kill('SIGTERM');
    this.child = null;
  }

  private write(msg: unknown): void {
    this.child?.stdin?.write(JSON.stringify(msg) + '\n');
  }

  private ensureShim(): Promise<void> {
    if (this.child) return Promise.resolve();
    this.starting ??= new Promise<void>((resolve, reject) => {
      this.log('spawning pi-host shim…');
      // Use a REAL node binary, not Electron-as-node: Electron's Node runtime
      // (even with ELECTRON_RUN_AS_NODE=1) stalls undici SSE streams. `node`
      // resolves from PATH; PATH in this context always has node (vscode runs
      // on it).
      const nodeBin = process.env.PI_CANVAS_NODE ?? 'node';
      this.log(`shim cmd: ${nodeBin} (PATH entries: ${(process.env.PATH ?? '').split(':').length})`);
      const child = spawn(nodeBin, [join(this.extensionDir, 'scripts', 'pi-host.mjs')], {
        cwd: this.extensionDir,
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.log(`shim pid=${child.pid}`);
      this.child = child;
      child.stderr!.on('data', (c: Buffer) => this.log(`shim stderr: ${c.toString('utf8').slice(0, 200)}`));
      child.stdout!.on('data', (chunk: Buffer) => {
        this.buffer += chunk.toString('utf8');
        for (;;) {
          const idx = this.buffer.indexOf('\n');
          if (idx === -1) break;
          const line = this.buffer.slice(0, idx).replace(/\r$/, '');
          this.buffer = this.buffer.slice(idx + 1);
          if (!line) continue;
          try {
            this.emit(JSON.parse(line) as PiEvent);
          } catch (err) {
            this.log(`bad JSONL from shim: ${err}`);
          }
        }
      });
      child.on('exit', (code, signal) => {
        this.log(`shim exit code=${code} signal=${signal}`);
        this.child = null;
        this.starting = null;
        this.emit({ type: 'pi_settled' });
      });
      child.on('error', (err) => {
        this.log(`shim spawn error: ${err}`);
        this.child = null;
        this.starting = null;
        reject(err);
      });
      const onReady = (event: PiEvent) => {
        if (event.type === 'shim_ready') {
          this.log('shim ready');
          this.settleWaiters = this.settleWaiters.filter((w) => w !== onReady);
          resolve();
        }
      };
      this.settleWaiters.push(onReady);
    });
    return this.starting;
  }
}

/** Diagnostics helper — remove when the bridge is proven stable. */
export function bridgeLog(line: string): void {
  try {
    appendFileSync('/tmp/canvas-bridge.log', `${new Date().toISOString()} ${line}\n`);
  } catch { /* diagnostics only */ }
}
