/**
 * herdr.ts — NDJSON socket client for the herdr daemon.
 *
 * Protocol reality (herdr 0.7.1): every connection is one-shot — the server
 * closes after ONE request-response. Subscribe connections stay open for the
 * event stream but must NOT send a second request (kills the connection).
 *
 * Design:
 *   request()   — opens a fresh socket per call, reads one response, destroys.
 *   subscribe() — opens a dedicated socket per call, sends events.subscribe,
 *                 awaits subscription_started, then yields events until the
 *                 socket closes or the abort signal fires.
 *   connect()   — connectivity check (open + close a socket).
 *   destroy()   — aborts all live subscribe streams; prevents further use.
 */

import { createConnection, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

export interface AgentEntry {
  terminal_id: string;
  name?: string;
  agent: string;
  agent_status: AgentStatus;
  agent_session: {
    source: string;
    agent: string;
    kind: string;
    value: string;
  };
  workspace_id: string;
  tab_id: string;
  pane_id: string;
  focused: boolean;
  cwd: string;
  foreground_cwd: string;
  revision: number;
}

export interface PaneRead {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  source: string;
  format: string;
  text: string;
  revision: number;
  truncated?: boolean;
}

export interface ProcessInfo {
  pane_id: string;
  shell_pid: number;
  foreground_process_group_id: number;
  foreground_processes: Array<{
    pid: number;
    name: string;
    argv: string[];
    cmdline: string;
    cwd: string;
  }>;
}

// Event types
export interface AgentStatusChangedEvent {
  event: 'pane.agent_status_changed';
  data: {
    agent: string;
    agent_status: AgentStatus;
    pane_id: string;
    workspace_id: string;
  };
}

export interface OutputMatchedEvent {
  event: 'pane.output_matched';
  data: {
    matched_line: string;
    pane_id: string;
    read: PaneRead & { workspace_id?: string };
  };
}

export interface PaneCreatedEvent {
  event: 'pane_created';
  data: {
    pane: AgentEntry;
    type: 'pane_created';
  };
}

export interface PaneClosedEvent {
  event: 'pane_closed';
  data: {
    pane_id: string;
    type: 'pane_closed';
    workspace_id: string;
  };
}

export type HerdrEvent =
  | AgentStatusChangedEvent
  | OutputMatchedEvent
  | PaneCreatedEvent
  | PaneClosedEvent;

// Subscription params
export interface SubscriptionSpec {
  type: string;
  pane_id?: string;
  source?: string;
  match?: { type: string; value: string };
}

// Internal response/error shapes
interface HerdrResponse {
  id: string;
  result?: unknown;
  error?: { code: string; message: string };
}

// Connect factory type (dependency-injected for testing)
export type ConnectFn = (path: string) => Socket;

// ---------------------------------------------------------------------------
// Default socket path
// ---------------------------------------------------------------------------

function defaultSocketPath(): string {
  const env = process.env['HERDR_SOCKET_PATH'];
  if (env) return env;
  return resolve(homedir(), '.config', 'herdr', 'herdr.sock');
}

// ---------------------------------------------------------------------------
// HerdrClient
// ---------------------------------------------------------------------------

/** Default per-request timeout in milliseconds. */
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export class HerdrClient {
  private readonly socketPath: string;
  private readonly connectFn: ConnectFn;
  private destroyed = false;
  /** AbortControllers for active subscribe streams — destroy() aborts all. */
  private readonly subscribeAborts = new Set<AbortController>();

  constructor(opts?: {
    socketPath?: string;
    connectFn?: ConnectFn;
  }) {
    this.socketPath = opts?.socketPath ?? defaultSocketPath();
    this.connectFn = opts?.connectFn ?? ((p: string) => createConnection(p));
  }

  // -------------------------------------------------------------------------
  // Connectivity check
  // -------------------------------------------------------------------------

  /**
   * Open a connection and immediately close it. Rejects if the socket is
   * unreachable. Used by cli.ts startup validation.
   */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.destroyed) {
        reject(new Error('Client destroyed'));
        return;
      }
      const sock = this.connectFn(this.socketPath);
      sock.setEncoding('utf8');
      sock.once('connect', () => {
        sock.destroy();
        resolve();
      });
      sock.once('error', (err) => {
        reject(err);
      });
    });
  }

  destroy(): void {
    this.destroyed = true;
    for (const ac of this.subscribeAborts) {
      ac.abort();
    }
    this.subscribeAborts.clear();
  }

  // -------------------------------------------------------------------------
  // Raw request — one fresh socket per call
  // -------------------------------------------------------------------------

  private request<T>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      if (this.destroyed) {
        reject(new Error('Client destroyed'));
        return;
      }

      const sock = this.connectFn(this.socketPath);
      sock.setEncoding('utf8');

      let settled = false;
      let buffer = '';
      const id = randomUUID();

      const done = (err: Error | null, value?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sock.destroy();
        if (err) {
          reject(err);
        } else {
          resolve(value as T);
        }
      };

      const timer = setTimeout(() => {
        done(new Error(`Request timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      sock.once('error', (err) => done(err));

      sock.on('close', () => {
        done(new Error('Socket closed before response'));
      });

      sock.on('data', (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(trimmed) as Record<string, unknown>;
          } catch {
            continue;
          }
          if ('id' in msg && msg['id'] === id) {
            const resp = msg as unknown as HerdrResponse;
            if (resp.error) {
              done(new HerdrError(resp.error.code, resp.error.message));
            } else {
              done(null, resp.result as T);
            }
          }
        }
      });

      sock.once('connect', () => {
        const line = JSON.stringify({ id, method, params }) + '\n';
        sock.write(line, (err) => {
          if (err) done(err);
        });
      });
    });
  }

  // -------------------------------------------------------------------------
  // Typed wrappers
  // -------------------------------------------------------------------------

  async paneRead(
    pane_id: string,
    source: 'visible' | 'recent' | 'recent_unwrapped' | 'detection' = 'visible',
    lines?: number,
  ): Promise<PaneRead> {
    const params: Record<string, unknown> = { pane_id, source };
    if (lines !== undefined) params['lines'] = lines;
    const result = await this.request<{ type: string; read: PaneRead }>('pane.read', params);
    return result.read;
  }

  async paneSendKeys(pane_id: string, keys: string[]): Promise<void> {
    await this.request<unknown>('pane.send_keys', { pane_id, keys });
  }

  async paneSendText(pane_id: string, text: string): Promise<void> {
    await this.request<unknown>('pane.send_text', { pane_id, text });
  }

  async paneProcessInfo(pane_id: string): Promise<ProcessInfo> {
    const result = await this.request<{ type: string; process_info: ProcessInfo }>(
      'pane.process_info',
      { pane_id },
    );
    return result.process_info;
  }

  async agentList(): Promise<AgentEntry[]> {
    const result = await this.request<{ type: string; agents: AgentEntry[] }>('agent.list', {});
    return result.agents;
  }

  async paneCurrent(): Promise<AgentEntry> {
    const result = await this.request<{ type: string; pane: AgentEntry }>('pane.current', {});
    return result.pane;
  }

  /**
   * Inject: Ctrl+C then send "continue\n"
   */
  async inject(pane_id: string): Promise<void> {
    await this.paneSendKeys(pane_id, ['C-c']);
    await this.paneSendText(pane_id, 'continue\n');
  }

  // -------------------------------------------------------------------------
  // Subscription streaming — dedicated fresh socket per call
  // -------------------------------------------------------------------------

  /**
   * Subscribe to a set of event types and return an async iterator of typed events.
   *
   * Opens a dedicated socket, sends events.subscribe, awaits subscription_started,
   * then yields events. The generator ends when:
   *   - the socket closes (server side)
   *   - `signal` is aborted
   *   - destroy() is called on this client
   */
  async *subscribe(
    subscriptions: SubscriptionSpec[],
    signal?: AbortSignal,
  ): AsyncGenerator<HerdrEvent> {
    if (this.destroyed) {
      throw new Error('Client destroyed');
    }

    const internalAc = new AbortController();
    this.subscribeAborts.add(internalAc);

    const effectiveSignal = signal
      ? AbortSignal.any([signal, internalAc.signal])
      : internalAc.signal;

    try {
      yield* this._subscribeOnSocket(subscriptions, effectiveSignal);
    } finally {
      this.subscribeAborts.delete(internalAc);
    }
  }

  private async *_subscribeOnSocket(
    subscriptions: SubscriptionSpec[],
    signal: AbortSignal,
  ): AsyncGenerator<HerdrEvent> {
    if (signal.aborted) return;

    const sock = this.connectFn(this.socketPath);
    sock.setEncoding('utf8');

    // Wait for socket connect
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        sock.destroy();
        reject(new Error('Aborted before connect'));
        return;
      }
      sock.once('connect', resolve);
      sock.once('error', reject);
    });

    if (signal.aborted) {
      sock.destroy();
      return;
    }

    // Send subscribe request and wait for subscription_started
    const id = randomUUID();
    const reqLine = JSON.stringify({ id, method: 'events.subscribe', params: { subscriptions } }) + '\n';

    await new Promise<void>((resolve, reject) => {
      let startedBuffer = '';

      const onData = (chunk: string) => {
        startedBuffer += chunk;
        const lines = startedBuffer.split('\n');
        startedBuffer = lines.pop() ?? '';
        for (const l of lines) {
          const trimmed = l.trim();
          if (!trimmed) continue;
          let msg: Record<string, unknown>;
          try { msg = JSON.parse(trimmed) as Record<string, unknown>; } catch { continue; }
          if ('id' in msg && msg['id'] === id) {
            sock.removeListener('data', onData);
            const resp = msg as unknown as HerdrResponse;
            if (resp.error) {
              reject(new HerdrError(resp.error.code, resp.error.message));
            } else {
              resolve();
            }
          }
        }
      };

      sock.on('data', onData);
      sock.once('error', reject);
      sock.write(reqLine);
    });

    if (signal.aborted) {
      sock.destroy();
      return;
    }

    // Yield events until socket closes or signal aborts
    const queue: HerdrEvent[] = [];
    let notify: (() => void) | null = null;
    let done = false;
    let streamBuf = '';

    const onStreamData = (chunk: string) => {
      streamBuf += chunk;
      const lines = streamBuf.split('\n');
      streamBuf = lines.pop() ?? '';
      for (const l of lines) {
        const trimmed = l.trim();
        if (!trimmed) continue;
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(trimmed) as Record<string, unknown>; } catch { continue; }
        if ('event' in msg) {
          queue.push(msg as unknown as HerdrEvent);
          notify?.();
        }
      }
    };

    const cleanup = () => {
      if (done) return;
      done = true;
      sock.removeListener('data', onStreamData);
      notify?.();
    };

    sock.on('data', onStreamData);
    sock.once('close', cleanup);
    sock.once('error', cleanup);
    signal.addEventListener('abort', cleanup, { once: true });

    try {
      while (!done) {
        while (queue.length > 0) {
          yield queue.shift()!;
        }
        if (done) break;
        await new Promise<void>((res) => {
          notify = res;
          if (queue.length > 0 || done) res();
        });
        notify = null;
      }
    } finally {
      cleanup();
      sock.destroy();
      signal.removeEventListener('abort', cleanup);
    }
  }

  /**
   * Subscribe to `pane.output_matched` events for a specific pane.
   */
  async *paneSubscribeOutputMatched(
    pane_id: string,
    match: { type: 'regex' | 'exact'; value: string },
    source: 'visible' | 'recent' | 'recent_unwrapped' = 'visible',
    signal?: AbortSignal,
  ): AsyncGenerator<OutputMatchedEvent> {
    const gen = this.subscribe(
      [{ type: 'pane.output_matched', pane_id, source, match }],
      signal,
    );
    for await (const ev of gen) {
      if (ev.event === 'pane.output_matched') {
        yield ev as OutputMatchedEvent;
      }
    }
  }

  /**
   * Subscribe to `pane.agent_status_changed` for a specific pane.
   */
  async *subscribeAgentStatus(
    pane_id: string,
    signal?: AbortSignal,
  ): AsyncGenerator<AgentStatusChangedEvent> {
    const gen = this.subscribe(
      [{ type: 'pane.agent_status_changed', pane_id }],
      signal,
    );
    for await (const ev of gen) {
      if (ev.event === 'pane.agent_status_changed') {
        yield ev as AgentStatusChangedEvent;
      }
    }
  }

  /**
   * Subscribe to pane lifecycle events (created + closed).
   */
  async *subscribePaneLifecycle(
    signal?: AbortSignal,
  ): AsyncGenerator<PaneCreatedEvent | PaneClosedEvent> {
    const gen = this.subscribe(
      [{ type: 'pane.created' }, { type: 'pane.closed' }],
      signal,
    );
    for await (const ev of gen) {
      if (ev.event === 'pane_created' || ev.event === 'pane_closed') {
        yield ev as PaneCreatedEvent | PaneClosedEvent;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class HerdrError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'HerdrError';
    this.code = code;
  }
}
