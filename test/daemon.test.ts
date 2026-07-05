/**
 * daemon.test.ts — tests for the event-driven daemon and reconcile sweep.
 *
 * Hard invariants tested:
 * 1. Inject only when canonical banner at bottom (pre-inject gate)
 * 2. Abandon wait when banner gone before resets_at
 * 3. Past reset time never rolled to tomorrow
 * 4. API-error retries hard-capped (via monitor.ts, validated through daemon)
 * 5. Never send input to pane not showing qualifying banner
 * 6. Token never logged
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runDaemon } from '../src/daemon.ts';
import type { DaemonOpts } from '../src/daemon.ts';
import type { HerdrClient, AgentEntry, PaneRead, HerdrEvent, SubscriptionSpec } from '../src/herdr.ts';
import type { AccountUsage } from '../src/usage.ts';

// ---------------------------------------------------------------------------
// Mock HerdrClient factory
// ---------------------------------------------------------------------------

type EventEmitter = (ev: HerdrEvent) => void;

interface MockClientOpts {
  agents?: AgentEntry[];
  paneTexts?: Record<string, string>; // paneId → visible text
  onInject?: (paneId: string) => void;
  onSendKeys?: (paneId: string, keys: string[]) => void;
  onSendText?: (paneId: string, text: string) => void;
}

function makeMockClient(opts: MockClientOpts = {}): {
  client: HerdrClient;
  emitEvent: EventEmitter;
  injectedPanes: string[];
  keysSent: Array<[string, string[]]>;
  textSent: Array<[string, string]>;
} {
  const injectedPanes: string[] = [];
  const keysSent: Array<[string, string[]]> = [];
  const textSent: Array<[string, string]> = [];
  let emitter: EventEmitter | null = null;

  const client = {
    onReconnect: undefined as (() => void) | undefined,

    async agentList(): Promise<AgentEntry[]> {
      return opts.agents ?? [];
    },

    async paneRead(pane_id: string, _source: string): Promise<PaneRead> {
      const text = opts.paneTexts?.[pane_id] ?? '';
      return {
        pane_id,
        workspace_id: 'ws1',
        tab_id: 'tab1',
        source: 'visible',
        format: 'plain',
        text,
        revision: 1,
      };
    },

    async paneSendKeys(pane_id: string, keys: string[]): Promise<void> {
      keysSent.push([pane_id, keys]);
      opts.onSendKeys?.(pane_id, keys);
    },

    async paneSendText(pane_id: string, text: string): Promise<void> {
      textSent.push([pane_id, text]);
      opts.onSendText?.(pane_id, text);
    },

    async inject(pane_id: string): Promise<void> {
      injectedPanes.push(pane_id);
      opts.onInject?.(pane_id);
    },

    async paneProcessInfo(pane_id: string) {
      return {
        pane_id,
        shell_pid: 1234,
        foreground_process_group_id: 1234,
        foreground_processes: [],
      };
    },

    async paneCurrent(): Promise<AgentEntry> {
      return opts.agents?.[0] ?? ({} as AgentEntry);
    },

    async *subscribe(
      _subscriptions: SubscriptionSpec[],
      signal?: AbortSignal,
    ): AsyncGenerator<HerdrEvent> {
      // Yield nothing by default; tests emit via emitEvent
      await new Promise<void>((resolve) => {
        const queue: HerdrEvent[] = [];
        let notify: (() => void) | null = null;
        let done = false;

        emitter = (ev: HerdrEvent) => {
          queue.push(ev);
          notify?.();
        };

        signal?.addEventListener('abort', () => {
          done = true;
          resolve();
          notify?.();
        });

        (async () => {
          while (!done) {
            while (queue.length > 0) {
              // We can't yield from inside a callback, so we use a generator trick
              // by storing the resolve and notifying
              break;
            }
            await new Promise<void>((res) => { notify = res; if (queue.length > 0 || done) res(); });
            notify = null;
          }
          resolve();
        })();
      });
    },
  } as unknown as HerdrClient;

  // Override subscribe to actually yield events
  (client as unknown as { subscribe: (s: SubscriptionSpec[], sig?: AbortSignal) => AsyncGenerator<HerdrEvent> }).subscribe =
    async function* (
      _subscriptions: SubscriptionSpec[],
      signal?: AbortSignal,
    ): AsyncGenerator<HerdrEvent> {
      const queue: HerdrEvent[] = [];
      let notify: (() => void) | null = null;
      let done = false;

      emitter = (ev: HerdrEvent) => {
        queue.push(ev);
        notify?.();
      };

      const cleanup = () => {
        done = true;
        notify?.();
      };

      signal?.addEventListener('abort', cleanup, { once: true });

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
        signal?.removeEventListener('abort', cleanup);
      }
    };

  const emitEvent: EventEmitter = (ev) => {
    if (emitter) emitter(ev);
  };

  return { client, emitEvent, injectedPanes, keysSent, textSent };
}

// ---------------------------------------------------------------------------
// Daemon opts builder
// ---------------------------------------------------------------------------

function makeDaemonOpts(
  clientOpts: MockClientOpts,
  extra: Partial<DaemonOpts> = {},
): {
  opts: DaemonOpts;
  injectedPanes: string[];
  emitEvent: EventEmitter;
  abort: () => void;
  signal: AbortSignal;
} {
  const ac = new AbortController();
  const { client, emitEvent, injectedPanes } = makeMockClient(clientOpts);

  const logs: string[] = [];

  const opts: DaemonOpts = {
    client,
    accountDirs: ['/home/test/.claude'],
    marginSeconds: 60,
    sweepIntervalMs: 100, // fast sweep for tests
    signal: ac.signal,
    log: (msg) => logs.push(msg),
    now: () => new Date('2024-01-15T10:00:00Z').getTime(),
    sleep: async (ms) => {
      // In tests, sleep resolves quickly to allow sweep to run
      await new Promise<void>((r) => setTimeout(r, Math.min(ms, 10)));
    },
    // DI stubs — no real token/fetch
    readTokenFn: async () => ({ token: 'test-token', expiresAtMs: null }),
    fetchUsageFn: async () => null,
    discoverDirsFn: async () => ['/home/test/.claude'],
    resolveAccountDirFn: async () => '/home/test/.claude',
    ...extra,
  };

  return {
    opts,
    injectedPanes,
    emitEvent,
    abort: () => ac.abort(),
    signal: ac.signal,
  };
}

// ---------------------------------------------------------------------------
// Helper: run daemon for a short time then abort
// ---------------------------------------------------------------------------

async function runDaemonBriefly(opts: DaemonOpts, ms: number): Promise<void> {
  const timedOut = new Promise<void>((r) => setTimeout(r, ms));
  await Promise.race([runDaemon(opts), timedOut]);
}

// ---------------------------------------------------------------------------
// Test: event trigger → checkPane called
// ---------------------------------------------------------------------------

describe('daemon — event-driven trigger', () => {
  it('pane.output_matched event → checkPane triggered → state machine runs', async () => {
    const FIXED_NOW = new Date('2024-01-15T10:00:00Z').getTime();
    const checkPaneCalls: string[] = [];

    // Pane shows limit banner
    const limitScreen = '5-hour limit reached\nresets 3pm (UTC)';
    const { opts, injectedPanes, emitEvent, abort } = makeDaemonOpts(
      {
        paneTexts: { 'pane-1': limitScreen },
        agents: [],
      },
      {
        now: () => FIXED_NOW,
        sleep: async (ms) => await new Promise<void>((r) => setTimeout(r, Math.min(ms, 5))),
        log: (msg) => { if (msg.includes('pane-1')) checkPaneCalls.push(msg); },
      },
    );

    const daemonPromise = runDaemon(opts);

    // Give daemon time to start subscribe
    await new Promise<void>((r) => setTimeout(r, 20));

    // Emit output_matched event
    emitEvent({
      event: 'pane.output_matched',
      data: {
        matched_line: 'limit',
        pane_id: 'pane-1',
        read: {
          pane_id: 'pane-1',
          workspace_id: 'ws1',
          tab_id: 't1',
          source: 'visible',
          format: 'plain',
          text: limitScreen,
          revision: 1,
        },
      },
    });

    await new Promise<void>((r) => setTimeout(r, 30));
    abort();
    await daemonPromise.catch(() => {});

    // checkPane was triggered for pane-1
    assert.ok(
      checkPaneCalls.some((m) => m.includes('pane-1')),
      `expected pane-1 log entry, got: ${JSON.stringify(checkPaneCalls)}`,
    );
  });

  it('pane.agent_status_changed blocked → checkPane triggered', async () => {
    const FIXED_NOW = new Date('2024-01-15T10:00:00Z').getTime();
    const logMsgs: string[] = [];
    const limitScreen = '5-hour limit reached\nresets 3pm (UTC)';

    const { opts, emitEvent, abort } = makeDaemonOpts(
      { paneTexts: { 'pane-2': limitScreen }, agents: [] },
      {
        now: () => FIXED_NOW,
        sleep: async (ms) => await new Promise<void>((r) => setTimeout(r, Math.min(ms, 5))),
        log: (msg) => logMsgs.push(msg),
      },
    );

    const daemonPromise = runDaemon(opts);
    await new Promise<void>((r) => setTimeout(r, 20));

    emitEvent({
      event: 'pane.agent_status_changed',
      data: {
        agent: 'claude',
        agent_status: 'blocked',
        pane_id: 'pane-2',
        workspace_id: 'ws1',
      },
    });

    await new Promise<void>((r) => setTimeout(r, 30));
    abort();
    await daemonPromise.catch(() => {});

    assert.ok(
      logMsgs.some((m) => m.includes('pane-2') && m.includes('blocked')),
      `expected blocked log for pane-2, got: ${JSON.stringify(logMsgs)}`,
    );
  });

  it('pane.agent_status_changed with non-blocked status → no checkPane trigger', async () => {
    const FIXED_NOW = new Date('2024-01-15T10:00:00Z').getTime();
    const logMsgs: string[] = [];

    const { opts, emitEvent, abort } = makeDaemonOpts(
      { paneTexts: { 'pane-3': 'Claude is working...' }, agents: [] },
      {
        now: () => FIXED_NOW,
        sleep: async (ms) => await new Promise<void>((r) => setTimeout(r, Math.min(ms, 5))),
        log: (msg) => logMsgs.push(msg),
      },
    );

    const daemonPromise = runDaemon(opts);
    await new Promise<void>((r) => setTimeout(r, 20));

    emitEvent({
      event: 'pane.agent_status_changed',
      data: {
        agent: 'claude',
        agent_status: 'working',
        pane_id: 'pane-3',
        workspace_id: 'ws1',
      },
    });

    await new Promise<void>((r) => setTimeout(r, 30));
    abort();
    await daemonPromise.catch(() => {});

    // Should NOT have triggered a check for pane-3 due to 'working' status
    assert.ok(
      !logMsgs.some((m) => m.includes('pane-3') && m.includes('blocked')),
      'non-blocked event must not trigger blocked-path log',
    );
  });
});

// ---------------------------------------------------------------------------
// Test: reconcile sweep picks up pre-existing blocked pane
// ---------------------------------------------------------------------------

describe('daemon — reconcile sweep', () => {
  it('pre-existing blocked pane discovered on first sweep', async () => {
    const FIXED_NOW = new Date('2024-01-15T10:00:00Z').getTime();
    const limitScreen = '5-hour limit reached\nresets 3pm (UTC)';
    const logMsgs: string[] = [];

    const { opts, abort } = makeDaemonOpts(
      {
        agents: [
          {
            pane_id: 'pane-blocked',
            agent: 'claude',
            agent_status: 'blocked',
            agent_session: { source: 'claude', agent: 'claude', kind: 'uuid', value: 'uuid-1' },
            workspace_id: 'ws1',
            tab_id: 'tab1',
            terminal_id: 't1',
            focused: false,
            cwd: '/tmp',
            foreground_cwd: '/tmp',
            revision: 1,
          } as AgentEntry,
        ],
        paneTexts: { 'pane-blocked': limitScreen },
      },
      {
        now: () => FIXED_NOW,
        sweepIntervalMs: 10000, // only first sweep matters
        sleep: async (ms) => await new Promise<void>((r) => setTimeout(r, Math.min(ms, 5))),
        log: (msg) => logMsgs.push(msg),
      },
    );

    // Run long enough for initial sweep
    await runDaemonBriefly(opts, 100);
    abort();

    assert.ok(
      logMsgs.some((m) => m.includes('reconcile sweep')),
      'sweep must run at start',
    );
    // The pane was found and checked
    assert.ok(
      logMsgs.some((m) => m.includes('pane-blocked') || m.includes('1 pane')),
      `expected pane-blocked to be checked, logs: ${JSON.stringify(logMsgs)}`,
    );
  });

  it('reconnect triggers immediate reconcile sweep', async () => {
    const FIXED_NOW = new Date('2024-01-15T10:00:00Z').getTime();
    const logMsgs: string[] = [];

    const { opts, abort, signal } = makeDaemonOpts(
      { agents: [], paneTexts: {} },
      {
        now: () => FIXED_NOW,
        sweepIntervalMs: 60000, // very long, so only reconnect-triggered sweep counts
        sleep: async (ms) => await new Promise<void>((r) => setTimeout(r, Math.min(ms, 5))),
        log: (msg) => logMsgs.push(msg),
      },
    );

    const daemonPromise = runDaemon(opts);
    await new Promise<void>((r) => setTimeout(r, 30));

    // Simulate reconnect
    opts.client.onReconnect?.();

    await new Promise<void>((r) => setTimeout(r, 30));
    abort();
    await daemonPromise.catch(() => {});

    const sweepMsgs = logMsgs.filter((m) => m.includes('reconcile'));
    // Should have at least 2 sweeps: initial + reconnect-triggered
    assert.ok(sweepMsgs.length >= 2, `expected ≥2 reconcile sweeps, got ${sweepMsgs.length}: ${JSON.stringify(sweepMsgs)}`);
  });
});

// ---------------------------------------------------------------------------
// Hard invariant tests
// ---------------------------------------------------------------------------

describe('daemon — hard invariants', () => {
  // INVARIANT 1: inject only when canonical banner at bottom (pre-inject re-check)
  it('INVARIANT 1: no inject when pre-inject re-check shows banner gone', async () => {
    const FIXED_NOW = new Date('2024-01-15T10:00:00Z').getTime();
    // First read shows banner, second read (pre-inject) shows it gone
    let readCount = 0;
    const { opts, injectedPanes, abort } = makeDaemonOpts(
      { agents: [], paneTexts: {} },
      {
        now: () => FIXED_NOW + 10 * 3600 * 1000, // way past "resets 3pm UTC"
        sleep: async (ms) => await new Promise<void>((r) => setTimeout(r, Math.min(ms, 5))),
        log: () => {},
      },
    );

    // Override paneRead to return banner first, then nothing
    (opts.client as unknown as { paneRead: (id: string, src: string) => Promise<PaneRead> }).paneRead =
      async (pane_id: string, _source: string): Promise<PaneRead> => {
        readCount++;
        // First read: banner present (triggers state machine)
        // Second read: banner gone (pre-inject check)
        const text = readCount === 1
          ? '5-hour limit reached\nresets 3pm (UTC)'
          : 'Claude is ready.';
        return { pane_id, workspace_id: 'ws1', tab_id: 't1', source: 'visible', format: 'plain', text, revision: readCount };
      };

    // Set up an agent so sweep finds it
    (opts.client as unknown as { agentList: () => Promise<AgentEntry[]> }).agentList =
      async () => [{
        pane_id: 'pane-inv1',
        agent: 'claude',
        agent_status: 'blocked',
        agent_session: { source: 'claude', agent: 'claude', kind: 'uuid', value: 'uuid-inv1' },
        workspace_id: 'ws1',
        tab_id: 'tab1',
        terminal_id: 't1',
        focused: false,
        cwd: '/tmp',
        foreground_cwd: '/tmp',
        revision: 1,
      } as AgentEntry];

    await runDaemonBriefly(opts, 100);
    abort();

    assert.equal(injectedPanes.length, 0, 'must NOT inject when banner gone at pre-inject check');
  });

  // INVARIANT 2: abandon wait when banner gone before resets_at
  it('INVARIANT 2: abandon wait when banner gone before resets_at', async () => {
    // Tested via monitor.ts stepState (reused in daemon) — banner-gone check fires first
    // in waiting branch before timer check.
    // Direct test via stepState (already in monitor.test.ts), daemon integrates same logic.
    const { createState, stepState } = await import('../src/monitor.ts');
    const state = createState();
    state.status = 'waiting';
    state.waitUntil = new Date('2024-01-15T10:00:00Z').getTime() + 3600000;
    let calls = 0;
    const status = await stepState(
      state, 'p1', 'Claude is ready.', // banner gone
      new Date('2024-01-15T10:00:00Z').getTime(),
      async (_reason: 'rate-limit' | 'api-error') => { calls++; },
    );
    assert.equal(status, 'monitoring');
    assert.equal(calls, 0, 'must NOT inject when banner gone — wait abandoned');
    assert.equal(state.waitUntil, 0);
  });

  // INVARIANT 3: past reset time never rolled to tomorrow
  it('INVARIANT 3: past reset time → inject immediately, not rolled to tomorrow', async () => {
    // FIXED_NOW=10:00 UTC. "resets 3am UTC" → 03:00 already past → waitMs<=0
    // stepState must inject, not add 24h
    const { createState, stepState } = await import('../src/monitor.ts');
    const state = createState();
    const FIXED_NOW = new Date('2024-01-15T10:00:00Z').getTime();
    let calls = 0;
    const pastResetScreen = 'Some output\n' +
      "You've hit your session limit · resets 3am (UTC)";
    const status = await stepState(
      state, 'p1', pastResetScreen, FIXED_NOW,
      async (_reason: 'rate-limit' | 'api-error') => { calls++; },
    );
    // Should inject (reset already passed) not wait 24h
    assert.equal(status, 'retried');
    assert.equal(calls, 1, 'must inject when reset already passed');
    assert.equal(state.status, 'monitoring');
    // waitUntil should be 0 (cleared), not 24h from now
    assert.equal(state.waitUntil, 0);
  });

  // INVARIANT 4: API-error retries hard-capped
  it('INVARIANT 4: API-error retries hard-capped at MAX_API_RETRIES', async () => {
    const { createState, stepState, MAX_API_RETRIES } = await import('../src/monitor.ts');
    const state = createState();
    let calls = 0;
    let now = new Date('2024-01-15T10:00:00Z').getTime();
    const apiScreen =
      'Some output\n' +
      'API Error: Connection closed mid-response. The response above may be incomplete.\n' +
      '> ';

    await stepState(state, 'p1', apiScreen, now, async (_r: 'rate-limit' | 'api-error') => { calls++; }); // arm

    for (let i = 0; i < MAX_API_RETRIES + 2; i++) {
      now += 10_000;
      await stepState(state, 'p1', apiScreen, now, async (_r: 'rate-limit' | 'api-error') => { calls++; });
    }

    assert.equal(calls, MAX_API_RETRIES, `must not exceed ${MAX_API_RETRIES} retries, got ${calls}`);
    assert.equal(state.apiGaveUp, true);
  });

  // INVARIANT 5: never send input to pane not showing qualifying banner
  it('INVARIANT 5: no inject when pane not at canonical banner (mid-screen)', async () => {
    const { createState, stepState } = await import('../src/monitor.ts');
    const state = createState();
    let calls = 0;
    const bannerMidScreen =
      "You've hit your session limit · resets 12:50am (Asia/Jakarta)\n" +
      Array.from({ length: 20 }, (_, i) => `output line ${i + 1}`).join('\n');
    const status = await stepState(
      state, 'p1', bannerMidScreen,
      new Date('2024-01-15T10:00:00Z').getTime(),
      async (_reason: 'rate-limit' | 'api-error') => { calls++; },
    );
    assert.equal(calls, 0, 'must NOT inject when banner not at bottom');
    assert.equal(status, 'monitoring');
  });

  // INVARIANT 6: token never logged
  it('INVARIANT 6: token never appears in log output', async () => {
    const SECRET_TOKEN = 'sk-ant-secret-token-12345';
    const logMsgs: string[] = [];

    const { opts, abort } = makeDaemonOpts(
      {
        agents: [],
        paneTexts: { 'pane-tok': '5-hour limit reached\nresets 3pm (UTC)' },
      },
      {
        now: () => new Date('2024-01-15T10:00:00Z').getTime(),
        sweepIntervalMs: 10000,
        sleep: async (ms) => await new Promise<void>((r) => setTimeout(r, Math.min(ms, 5))),
        log: (msg) => logMsgs.push(msg),
        readTokenFn: async () => ({ token: SECRET_TOKEN, expiresAtMs: null }),
        fetchUsageFn: async (token: string) => {
          // The token is used here — just return a mock usage
          void token; // accessed but not logged
          return { limited: true, resetsAtMs: new Date('2024-01-15T15:00:00Z').getTime() } as AccountUsage;
        },
      },
    );

    await runDaemonBriefly(opts, 100);
    abort();

    for (const msg of logMsgs) {
      assert.ok(
        !msg.includes(SECRET_TOKEN),
        `token must never appear in logs — found in: "${msg}"`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Test: pane_closed event drops state
// ---------------------------------------------------------------------------

describe('daemon — pane lifecycle', () => {
  it('pane_closed event → state dropped', async () => {
    const FIXED_NOW = new Date('2024-01-15T10:00:00Z').getTime();
    const logMsgs: string[] = [];
    const limitScreen = '5-hour limit reached\nresets 3pm (UTC)';

    const { opts, emitEvent, abort } = makeDaemonOpts(
      {
        agents: [
          {
            pane_id: 'pane-lifecycle',
            agent: 'claude',
            agent_status: 'blocked',
            agent_session: { source: 'claude', agent: 'claude', kind: 'uuid', value: 'uuid-lc' },
            workspace_id: 'ws1',
            tab_id: 'tab1',
            terminal_id: 't1',
            focused: false,
            cwd: '/tmp',
            foreground_cwd: '/tmp',
            revision: 1,
          } as AgentEntry,
        ],
        paneTexts: { 'pane-lifecycle': limitScreen },
      },
      {
        now: () => FIXED_NOW,
        sweepIntervalMs: 10000,
        sleep: async (ms) => await new Promise<void>((r) => setTimeout(r, Math.min(ms, 5))),
        log: (msg) => logMsgs.push(msg),
      },
    );

    const daemonPromise = runDaemon(opts);
    // Let initial sweep run
    await new Promise<void>((r) => setTimeout(r, 50));

    // Emit pane closed
    emitEvent({
      event: 'pane_closed',
      data: {
        pane_id: 'pane-lifecycle',
        type: 'pane_closed',
        workspace_id: 'ws1',
      },
    });

    await new Promise<void>((r) => setTimeout(r, 20));
    abort();
    await daemonPromise.catch(() => {});

    assert.ok(
      logMsgs.some((m) => m.includes('pane-lifecycle') && m.includes('closed')),
      `expected closed log, got: ${JSON.stringify(logMsgs)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Test: api-error inject fires after backoff
// ---------------------------------------------------------------------------

describe('daemon — api-error inject', () => {
  it('api-error screen → inject fires after backoff', async () => {
    // API_RETRY_DELAY_MS = 10_000 in monitor.ts; we fake time to jump past it
    const BASE_NOW = new Date('2024-01-15T10:00:00Z').getTime();
    const API_RETRY_DELAY_MS = 10_000;
    let nowMs = BASE_NOW;

    // Pane shows "API Error: connection closed" at bottom (matches isApiErrorAtBottom)
    const apiErrorScreen =
      'Some output above.\n' +
      'API Error: connection closed\n' +
      '> ';

    const { opts, injectedPanes, abort } = makeDaemonOpts(
      {
        agents: [
          {
            pane_id: 'pane-apierr',
            agent: 'claude',
            agent_status: 'blocked',
            agent_session: { source: 'claude', agent: 'claude', kind: 'uuid', value: 'uuid-apierr' },
            workspace_id: 'ws1',
            tab_id: 'tab1',
            terminal_id: 't1',
            focused: false,
            cwd: '/tmp',
            foreground_cwd: '/tmp',
            revision: 1,
          } as AgentEntry,
        ],
        paneTexts: { 'pane-apierr': apiErrorScreen },
      },
      {
        now: () => nowMs,
        sweepIntervalMs: 50, // fast sweep
        sleep: async (ms) => {
          // Advance fake clock on sleep so timer-based checks fire
          nowMs += Math.max(ms, API_RETRY_DELAY_MS + 1000);
          await new Promise<void>((r) => setTimeout(r, Math.min(ms, 10)));
        },
        log: () => {},
      },
    );

    // Run long enough for: initial sweep (arms timer) + one more sweep (injects)
    await runDaemonBriefly(opts, 200);
    abort();

    assert.ok(
      injectedPanes.includes('pane-apierr'),
      `expected pane-apierr to be injected after api-error backoff, got: ${JSON.stringify(injectedPanes)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Test: per-pane subscriptions built correctly
// ---------------------------------------------------------------------------

describe('daemon — per-pane subscriptions', () => {
  it('subscribe called with per-pane output_matched and agent_status subs', async () => {
    const FIXED_NOW = new Date('2024-01-15T10:00:00Z').getTime();
    const capturedSubs: SubscriptionSpec[][] = [];

    const agents: AgentEntry[] = [
      {
        pane_id: 'pane-sub-a',
        agent: 'claude',
        agent_status: 'idle',
        agent_session: { source: 'claude', agent: 'claude', kind: 'uuid', value: 'uuid-a' },
        workspace_id: 'ws1',
        tab_id: 'tab1',
        terminal_id: 't1',
        focused: false,
        cwd: '/tmp',
        foreground_cwd: '/tmp',
        revision: 1,
      } as AgentEntry,
      {
        pane_id: 'pane-sub-b',
        agent: 'claude',
        agent_status: 'idle',
        agent_session: { source: 'claude', agent: 'claude', kind: 'uuid', value: 'uuid-b' },
        workspace_id: 'ws1',
        tab_id: 'tab2',
        terminal_id: 't2',
        focused: false,
        cwd: '/tmp',
        foreground_cwd: '/tmp',
        revision: 1,
      } as AgentEntry,
    ];

    const { opts, abort } = makeDaemonOpts(
      { agents, paneTexts: {} },
      {
        now: () => FIXED_NOW,
        sweepIntervalMs: 60000,
        sleep: async (ms) => await new Promise<void>((r) => setTimeout(r, Math.min(ms, 5))),
        log: () => {},
      },
    );

    // Intercept subscribe to capture subscription specs
    const origSubscribe = opts.client.subscribe.bind(opts.client);
    (opts.client as unknown as { subscribe: typeof opts.client.subscribe }).subscribe =
      async function* (subs: SubscriptionSpec[], signal?: AbortSignal): AsyncGenerator<HerdrEvent> {
        capturedSubs.push(subs);
        yield* origSubscribe(subs, signal);
      };

    const daemonPromise = runDaemon(opts);
    await new Promise<void>((r) => setTimeout(r, 50));
    abort();
    await daemonPromise.catch(() => {});

    assert.ok(capturedSubs.length >= 1, 'subscribe must have been called at least once');
    const firstSubs = capturedSubs[0];

    // Should have per-pane output_matched for each agent pane
    const outputMatchedForA = firstSubs.some(
      (s) => s.type === 'pane.output_matched' && s.pane_id === 'pane-sub-a',
    );
    const outputMatchedForB = firstSubs.some(
      (s) => s.type === 'pane.output_matched' && s.pane_id === 'pane-sub-b',
    );
    const agentStatusForA = firstSubs.some(
      (s) => s.type === 'pane.agent_status_changed' && s.pane_id === 'pane-sub-a',
    );
    const agentStatusForB = firstSubs.some(
      (s) => s.type === 'pane.agent_status_changed' && s.pane_id === 'pane-sub-b',
    );

    assert.ok(outputMatchedForA, 'must include pane.output_matched for pane-sub-a');
    assert.ok(outputMatchedForB, 'must include pane.output_matched for pane-sub-b');
    assert.ok(agentStatusForA, 'must include pane.agent_status_changed for pane-sub-a');
    assert.ok(agentStatusForB, 'must include pane.agent_status_changed for pane-sub-b');
  });
});
