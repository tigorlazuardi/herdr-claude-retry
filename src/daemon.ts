/**
 * daemon.ts — Event-driven daemon with reconcile sweep.
 *
 * Consumes HerdrClient event subscriptions and a periodic reconcile sweep
 * to detect rate-limited Claude panes and inject 'continue' when limits reset.
 */

import type { HerdrClient, AgentEntry } from './herdr.ts';
import { discoverAccountDirs, resolveAccountDir } from './accounts.ts';
import { readAccessToken, fetchUsage } from './usage.ts';
import type { AccountUsage } from './usage.ts';
import { isBlockedAtBanner, isApiErrorAtBottom, match } from './patterns.ts';
import { createState, stepState, MAX_MISSES } from './monitor.ts';
import type { MonitorState, PaneStates, Logger } from './monitor.ts';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface DaemonOpts {
  client: HerdrClient;
  /** Override account dir discovery. */
  accountDirs?: string[];
  /** Extra seconds after resetsAt before injecting. Default 60. */
  marginSeconds?: number;
  /** Reconcile sweep interval in ms. Default 5 * 60 * 1000. */
  sweepIntervalMs?: number;
  /** Abort the daemon loop. */
  signal?: AbortSignal;
  /** Injectable logger. Defaults to stderr. */
  log?: Logger;
  /** Injectable clock. Defaults to Date.now. */
  now?: () => number;
  /** Injectable sleep. Defaults to setTimeout promise. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable fetchUsage for DI in tests. */
  fetchUsageFn?: typeof fetchUsage;
  /** Injectable readAccessToken for DI in tests. */
  readTokenFn?: typeof readAccessToken;
  /** Injectable discoverAccountDirs for DI in tests. */
  discoverDirsFn?: typeof discoverAccountDirs;
  /** Injectable resolveAccountDir for DI in tests. */
  resolveAccountDirFn?: typeof resolveAccountDir;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve account dir for a given pane, returning { accountDir, usage }.
 * Returns null for usage when resolution fails or API unavailable.
 */
async function resolveUsage(
  paneId: string,
  client: HerdrClient,
  accountDirs: string[],
  opts: {
    now: () => number;
    log: Logger;
    fetchUsageFn: typeof fetchUsage;
    readTokenFn: typeof readAccessToken;
    resolveAccountDirFn: typeof resolveAccountDir;
  },
): Promise<{ accountDir: string | null; usage: AccountUsage | null }> {
  // Get session UUID and shell PID from agent info
  let sessionUuid: string | null = null;
  let shellPid: number | null = null;

  try {
    const agents = await client.agentList();
    const agent = agents.find((a: AgentEntry) => a.pane_id === paneId);
    if (agent) {
      sessionUuid = agent.agent_session?.value ?? null;
    }
  } catch {
    // Ignore — proceed with null uuid
  }

  try {
    const info = await client.paneProcessInfo(paneId);
    shellPid = info.shell_pid;
  } catch {
    // Ignore — proceed with null pid
  }

  const accountDir = await opts.resolveAccountDirFn(sessionUuid, shellPid, accountDirs).catch(() => null);

  if (accountDir === null) {
    return { accountDir: null, usage: null };
  }

  const tokenInfo = await opts.readTokenFn(accountDir).catch(() => null);
  if (tokenInfo === null) {
    return { accountDir, usage: null };
  }

  // INVARIANT: never log the token
  const usage = await opts.fetchUsageFn(
    tokenInfo.token,
    undefined,
    undefined,
    (status, reason) => opts.log(`usage fetch failed: ${reason} (status ${status})`),
  ).catch(() => null);
  return { accountDir, usage };
}

// ---------------------------------------------------------------------------
// Main daemon
// ---------------------------------------------------------------------------

export async function runDaemon(opts: DaemonOpts): Promise<void> {
  const {
    client,
    marginSeconds = 60,
    sweepIntervalMs = 5 * 60 * 1000,
    signal,
    log = (msg: string) => process.stderr.write(`[herdr] ${msg}\n`),
    now = () => Date.now(),
    // unref: a pending sweep timer must not keep the process alive after the
    // event loop side of the Promise.race resolves on shutdown.
    sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref()),
    fetchUsageFn = fetchUsage,
    readTokenFn = readAccessToken,
    discoverDirsFn = discoverAccountDirs,
    resolveAccountDirFn = resolveAccountDir,
  } = opts;

  // Discover account dirs (or use override)
  const accountDirs: string[] = opts.accountDirs ?? await discoverDirsFn().catch(() => []);
  log(`daemon starting — ${accountDirs.length} account dir(s)`);

  // Per-pane state
  const paneStates: PaneStates = new Map();
  // Tracks panes actively being checked (deduplicate concurrent triggers)
  const inProgress = new Set<string>();

  // -------------------------------------------------------------------------
  // checkPane — run one state-machine step for a single pane
  // -------------------------------------------------------------------------

  async function checkPane(paneId: string): Promise<void> {
    if (inProgress.has(paneId)) return;
    inProgress.add(paneId);

    try {
      let state = paneStates.get(paneId);
      if (!state) {
        state = createState();
        paneStates.set(paneId, state);
      }

      // Read visible pane content
      let screenText: string;
      try {
        const read = await client.paneRead(paneId, 'visible');
        screenText = read.text;
      } catch {
        log(`${paneId} — paneRead failed, skipping`);
        return;
      }

      // Lazy usage fetch: only when pane shows a banner or is already waiting
      let usage: AccountUsage | undefined;
      const hasBanner = match(screenText).limited || state.status === 'waiting';
      if (hasBanner) {
        const resolved = await resolveUsage(paneId, client, accountDirs, {
          now,
          log,
          fetchUsageFn,
          readTokenFn,
          resolveAccountDirFn,
        });
        usage = resolved.usage ?? undefined;
      }

      const before = state.status;
      const status = await stepState(
        state,
        paneId,
        screenText,
        now(),
        async (reason: 'rate-limit' | 'api-error') => {
          // INVARIANT: check canonical banner immediately before inject
          const preInjectRead = await client.paneRead(paneId, 'visible');
          const text = preInjectRead.text;
          if (reason === 'rate-limit' && !isBlockedAtBanner(text)) {
            log(`${paneId} — banner gone just before inject, skipping`);
            return;
          }
          if (reason === 'api-error' && !isApiErrorAtBottom(text)) {
            log(`${paneId} — api-error gone just before inject, skipping`);
            return;
          }
          await client.inject(paneId);
        },
        { marginSeconds, usage },
      );

      if (status !== before && status !== 'monitoring') {
        log(`${paneId} — ${before} → ${status}`);
      }
    } finally {
      inProgress.delete(paneId);
    }
  }

  // -------------------------------------------------------------------------
  // Reconcile sweep — discover all panes and check each
  // -------------------------------------------------------------------------

  async function reconcileSweep(): Promise<void> {
    log('reconcile sweep starting');
    let agents: AgentEntry[];
    try {
      agents = await client.agentList();
    } catch {
      log('reconcile sweep: agentList failed, skipping');
      return;
    }

    // Prune states for panes that no longer exist
    const livePanes = new Set(agents.map((a) => a.pane_id));
    for (const [paneId, state] of paneStates) {
      if (!livePanes.has(paneId)) {
        state.missCount++;
        if (state.missCount >= MAX_MISSES) {
          paneStates.delete(paneId);
          log(`${paneId} gone — dropped after ${MAX_MISSES} misses`);
        }
      }
    }

    // Reset miss counter for live panes and check idle ones
    const checks: Promise<void>[] = [];
    for (const agent of agents) {
      const paneId = agent.pane_id;
      const state = paneStates.get(paneId);
      if (state) {
        state.missCount = 0;
      }

      // Only sweep-check panes not already triggered/waiting (event-driven handles those)
      const isActive = state?.status === 'waiting';
      if (!isActive && !inProgress.has(paneId)) {
        checks.push(checkPane(paneId));
      }
    }

    await Promise.allSettled(checks);
    log(`reconcile sweep done — ${agents.length} pane(s) checked`);
  }

  // -------------------------------------------------------------------------
  // Event subscription loop (restart-capable, with per-pane subscriptions)
  // -------------------------------------------------------------------------

  let currentPaneIds: string[] = [];
  // Tracks every pane id ever seen via pane_created — persists across resubscribes.
  // Used to detect historical replays: first sighting of a pane id may trigger a
  // resubscribe (new pane joined), subsequent sightings are always replays → ignored.
  const knownCreatedPaneIds = new Set<string>();

  async function buildSubscriptions(): Promise<import('./herdr.ts').SubscriptionSpec[]> {
    let agents: AgentEntry[] = [];
    try { agents = await client.agentList(); } catch { /* sweep will catch it */ }
    currentPaneIds = agents.map((a) => a.pane_id);
    // Seed knownCreatedPaneIds from live panes so initial replays are ignored.
    for (const id of currentPaneIds) knownCreatedPaneIds.add(id);
    const subs: import('./herdr.ts').SubscriptionSpec[] = [
      ...currentPaneIds.map((paneId) => ({
        type: 'pane.output_matched' as const,
        pane_id: paneId,
        source: 'visible' as const,
        match: { type: 'regex' as const, value: 'limit|rate.?limit|session limit|usage limit' },
      })),
      ...currentPaneIds.map((paneId) => ({
        type: 'pane.agent_status_changed' as const,
        pane_id: paneId,
      })),
      { type: 'pane.created' as const },
      { type: 'pane.closed' as const },
    ];
    return subs;
  }

  async function runEventLoopWithRestart(): Promise<void> {
    while (!signal?.aborted) {
      const innerAc = new AbortController();
      const innerSignal = signal
        ? AbortSignal.any([signal, innerAc.signal])
        : innerAc.signal;

      const subs = await buildSubscriptions();
      log(`subscribing to events for ${currentPaneIds.length} pane(s)`);

      // shouldStop: set only on intentional daemon shutdown (signal aborted).
      // Any other generator exit (socket close, pane.created) → restart.
      let shouldStop = false;
      try {
        const events = client.subscribe(subs, innerSignal);
        for await (const ev of events) {
          if (signal?.aborted) { shouldStop = true; break; }

          if (ev.event === 'pane.output_matched') {
            const paneId = ev.data.pane_id;
            log(`${paneId} — output_matched, triggering check`);
            checkPane(paneId).catch((e) => log(`${paneId} checkPane error: ${e}`));
          } else if (ev.event === 'pane.agent_status_changed') {
            if (ev.data.agent_status === 'blocked') {
              const paneId = ev.data.pane_id;
              log(`${paneId} — agent blocked, triggering check`);
              checkPane(paneId).catch((e) => log(`${paneId} checkPane error: ${e}`));
            }
          } else if (ev.event === 'pane_created') {
            const paneId = ev.data.pane?.pane_id;
            if (paneId && knownCreatedPaneIds.has(paneId)) {
              // Already seen this pane_created — historical replay, ignore.
              // No log to avoid spam from long history backlogs.
            } else {
              // First time seeing this pane_created. Check if pane is actually live
              // before resubscribing — historical replays for long-dead panes would
              // otherwise trigger N resubscribes on startup.
              if (paneId) knownCreatedPaneIds.add(paneId);
              let isLive = false;
              try {
                const live = await client.agentList();
                isLive = live.some((a) => a.pane_id === paneId);
                // Also seed known set from current live panes to prevent future replays.
                for (const a of live) knownCreatedPaneIds.add(a.pane_id);
              } catch { /* treat as not live */ }
              if (isLive) {
                log(`${paneId} — pane created, resubscribing`);
                innerAc.abort();
                break;
              } else {
                log(`${paneId ?? 'unknown'} — pane_created for dead/historical pane, ignoring`);
              }
            }
          } else if (ev.event === 'pane_closed') {
            const paneId = ev.data.pane_id;
            log(`${paneId} — pane closed, dropping state`);
            paneStates.delete(paneId);
            inProgress.delete(paneId);
          }
        }
      } catch (err) {
        if (!signal?.aborted && !innerAc.signal.aborted) {
          log(`event loop error: ${err}`);
        }
      }

      // Generator ended: stop only on signal; otherwise rebuild subscriptions.
      if (shouldStop || signal?.aborted) break;
      log('event stream ended — resubscribing');
      // Brief pause before resubscribing (avoids tight loop on rapid reconnect)
      await sleep(500);
    }
  }

  // -------------------------------------------------------------------------
  // Periodic sweep timer
  // -------------------------------------------------------------------------

  async function runSweepLoop(): Promise<void> {
    // Immediate sweep on start
    await reconcileSweep().catch((e) => log(`initial sweep error: ${e}`));

    while (!signal?.aborted) {
      await sleep(sweepIntervalMs);
      if (signal?.aborted) break;
      await reconcileSweep().catch((e) => log(`sweep error: ${e}`));
    }
  }

  // Run both loops concurrently — they share paneStates and checkPane
  await Promise.race([
    runEventLoopWithRestart(),
    runSweepLoop(),
  ]);
}
