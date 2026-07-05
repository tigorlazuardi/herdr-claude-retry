/**
 * herdr.ts — NDJSON socket client for the herdr daemon.
 *
 * Connects to the herdr UNIX socket, sends JSON-RPC-style requests,
 * and exposes subscription streams as async iterators.
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

interface HerdrRawEvent {
  event: string;
  data: unknown;
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

export class HerdrClient {
  private readonly socketPath: string;
  private readonly connectFn: ConnectFn;
  private socket: Socket | null = null;
  private buffer = '';
  private pendingRequests = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private eventListeners: Array<(ev: HerdrRawEvent) => void> = [];
  private reconnectDelay = 1000;
  private readonly maxDelay = 60_000;
  private destroyed = false;

  onReconnect?: () => void;

  constructor(opts?: {
    socketPath?: string;
    connectFn?: ConnectFn;
    onReconnect?: () => void;
  }) {
    this.socketPath = opts?.socketPath ?? defaultSocketPath();
    this.connectFn = opts?.connectFn ?? ((p: string) => createConnection(p));
    if (opts?.onReconnect) this.onReconnect = opts.onReconnect;
  }

  // -------------------------------------------------------------------------
  // Connection management
  // -------------------------------------------------------------------------

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = this.connectFn(this.socketPath);
      this.socket = sock;
      this.buffer = '';

      sock.setEncoding('utf8');

      sock.once('connect', () => {
        this.reconnectDelay = 1000;
        resolve();
      });

      sock.once('error', (err) => {
        reject(err);
      });

      sock.on('data', (chunk: string) => {
        this.buffer += chunk;
        this.processBuffer();
      });

      sock.on('close', () => {
        if (!this.destroyed) {
          this.scheduleReconnect();
        }
      });
    });
  }

  private processBuffer(): void {
    const lines = this.buffer.split('\n');
    // Last element may be incomplete — keep in buffer
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed) as Record<string, unknown>;
        this.handleMessage(msg);
      } catch {
        // Malformed line — skip
      }
    }
  }

  private handleMessage(msg: Record<string, unknown>): void {
    if ('event' in msg) {
      // Push to all event listeners
      const ev = msg as unknown as HerdrRawEvent;
      for (const listener of this.eventListeners) {
        listener(ev);
      }
      return;
    }

    if ('id' in msg) {
      const resp = msg as unknown as HerdrResponse;
      const pending = this.pendingRequests.get(resp.id);
      if (!pending) return;
      this.pendingRequests.delete(resp.id);
      if (resp.error) {
        pending.reject(
          new HerdrError(resp.error.code, resp.error.message),
        );
      } else {
        pending.resolve(resp.result);
      }
    }
  }

  private scheduleReconnect(): void {
    // Reject all pending requests on disconnect
    for (const [, { reject }] of this.pendingRequests) {
      reject(new Error('Socket disconnected'));
    }
    this.pendingRequests.clear();

    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxDelay);

    setTimeout(() => {
      if (this.destroyed) return;
      this.connect()
        .then(() => {
          this.onReconnect?.();
        })
        .catch(() => {
          // scheduleReconnect will be triggered again by close event
        });
    }, delay);
  }

  destroy(): void {
    this.destroyed = true;
    this.socket?.destroy();
    this.socket = null;
    for (const [, { reject }] of this.pendingRequests) {
      reject(new Error('Client destroyed'));
    }
    this.pendingRequests.clear();
  }

  // -------------------------------------------------------------------------
  // Raw request
  // -------------------------------------------------------------------------

  private request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) {
        reject(new Error('Not connected'));
        return;
      }

      const id = randomUUID();
      const line = JSON.stringify({ id, method, params }) + '\n';

      this.pendingRequests.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
      });

      this.socket.write(line, (err) => {
        if (err) {
          this.pendingRequests.delete(id);
          reject(err);
        }
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
  // Subscription streaming
  // -------------------------------------------------------------------------

  /**
   * Subscribe to a set of event types and return an async iterator of typed events.
   * The iterator ends when `signal` is aborted or the client is destroyed.
   */
  async *subscribe(
    subscriptions: SubscriptionSpec[],
    signal?: AbortSignal,
  ): AsyncGenerator<HerdrEvent> {
    if (!this.socket || this.socket.destroyed) {
      throw new Error('Not connected');
    }

    const id = randomUUID();
    const line = JSON.stringify({ id, method: 'events.subscribe', params: { subscriptions } }) + '\n';

    // Wait for subscription_started
    const started = new Promise<void>((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve: () => resolve(),
        reject,
      });
    });

    this.socket.write(line);
    await started;

    // Now yield events until aborted
    const queue: HerdrEvent[] = [];
    let notify: (() => void) | null = null;
    let done = false;

    const listener = (ev: HerdrRawEvent) => {
      queue.push(ev as unknown as HerdrEvent);
      notify?.();
    };

    this.eventListeners.push(listener);

    const cleanup = () => {
      done = true;
      this.eventListeners = this.eventListeners.filter((l) => l !== listener);
      notify?.();
    };

    signal?.addEventListener('abort', cleanup, { once: true });

    // Capture the socket active at subscribe time. If it closes (reconnect),
    // terminate this generator so the caller can resubscribe on the new socket.
    const subscribedSocket = this.socket;
    subscribedSocket?.once('close', cleanup);

    try {
      while (!done) {
        while (queue.length > 0) {
          yield queue.shift()!;
        }
        if (done) break;
        await new Promise<void>((res) => {
          notify = res;
          // If items arrived while we were setting notify, flush immediately
          if (queue.length > 0 || done) res();
        });
        notify = null;
      }
    } finally {
      cleanup();
      subscribedSocket?.removeListener('close', cleanup);
      signal?.removeEventListener('abort', cleanup);
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
