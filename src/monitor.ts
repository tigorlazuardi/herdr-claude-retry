import { match, isBlockedAtBanner, isApiErrorAtBottom } from './patterns.ts';
import { parseResetTime, calculateWaitMs } from './time-parser.ts';
import { formatLocalDateTime } from './format.ts';
import type { AccountUsage } from './usage.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MonitorStatus = 'monitoring' | 'rate-limited' | 'retried' | 'api-retried' | 'exited';

export interface MonitorState {
  status: 'monitoring' | 'waiting';
  waitUntil: number;
  missCount: number;
  /** When > 0, the time at which to (re-)inject 'continue' for a parked API error. */
  apiNextActionAt: number;
  /** Count of consecutive auto-retries fired for a persisting API error. */
  apiRetries: number;
  /** Set once we stop retrying a persisting API error, to log the give-up only once. */
  apiGaveUp: boolean;
}

export type PaneStates = Map<string, MonitorState>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_MISSES = 3;

// API-error recovery: short backoff before injecting 'continue' (gives a flaky
// network a moment), and a cap on consecutive retries so a truly-dead
// connection isn't hammered forever.
const API_RETRY_DELAY_MS = 10_000;
export const MAX_API_RETRIES = 5;

// ---------------------------------------------------------------------------
// State factory
// ---------------------------------------------------------------------------

export function createState(): MonitorState {
  return {
    status: 'monitoring',
    waitUntil: 0,
    missCount: 0,
    apiNextActionAt: 0,
    apiRetries: 0,
    apiGaveUp: false,
  };
}

// ---------------------------------------------------------------------------
// Logger type
// ---------------------------------------------------------------------------

export type Logger = (msg: string) => void;

// ---------------------------------------------------------------------------
// Core state transition
// ---------------------------------------------------------------------------

/**
 * Core state transition for one pane, given its current screen text.
 * `injectContinue` is called only when a wait period has elapsed and the
 * canonical banner is confirmed at the bottom.
 *
 * When `usage` is provided, applies account-aware limit resolution.
 * Without it, falls back to text-based time parsing.
 */
export async function stepState(
  state: MonitorState,
  paneId: string,
  screenText: string,
  now: number,
  injectContinue: (reason: 'rate-limit' | 'api-error') => Promise<void>,
  opts?: {
    marginSeconds?: number;
    fallbackHours?: number;
    usage?: AccountUsage;
    log?: Logger;
  },
): Promise<MonitorStatus> {
  const log = opts?.log ?? (() => {});
  const label = paneId;
  const marginMs = (opts?.marginSeconds ?? 60) * 1000;
  const usage = opts?.usage;

  if (state.status === 'waiting') {
    const limited = match(screenText).limited;

    // Banner gone → user already continued / pane reused → abandon wait.
    if (!limited) {
      state.status = 'monitoring';
      state.waitUntil = 0;
      log(`${label} wait abandoned (banner gone)`);
      return 'monitoring';
    }

    // Account still limited with known reset → keep waitUntil aligned.
    if (usage !== undefined && usage.limited && usage.resetsAtMs !== null) {
      state.waitUntil = usage.resetsAtMs + marginMs;
    }

    // Limit is over when account cleared (early/real reset) OR timer elapsed.
    const accountCleared = usage !== undefined && !usage.limited;
    const timerElapsed = now >= state.waitUntil;

    if (accountCleared || timerElapsed) {
      if (!isBlockedAtBanner(screenText)) {
        state.status = 'monitoring';
        state.waitUntil = 0;
        log(`${label} wait abandoned (no canonical banner at bottom)`);
        return 'monitoring';
      }
      await injectContinue('rate-limit');
      state.status = 'monitoring';
      state.waitUntil = 0;
      log(`${label} — reset reached, sent 'continue'`);
      return 'retried';
    }

    // Still limited, before reset → keep waiting.
    return 'rate-limited';
  }

  // state.status === 'monitoring'
  const result = match(screenText);
  if (result.limited) {
    // Account-aware path when usage is available
    if (usage !== undefined) {
      if (!usage.limited) {
        // Account not limited — stale or incidental banner
        if (isBlockedAtBanner(screenText)) {
          await injectContinue('rate-limit');
          log(`${label} cleared-limit banner at bottom — sent 'continue'`);
          return 'retried';
        }
        log(`${label} stale banner ignored (account not limited)`);
        return 'monitoring';
      }
      // Account confirmed limited
      if (usage.resetsAtMs !== null) {
        state.waitUntil = usage.resetsAtMs + marginMs;
        state.status = 'waiting';
        log(`${label} account limited, 'continue' at ${formatLocalDateTime(state.waitUntil)}`);
        return 'rate-limited';
      }
      // resetsAtMs null — fall through to text parse
    }

    // Text fallback
    const resetLine = result.resetLine ?? '';
    const parsed = parseResetTime(resetLine);
    const waitMs = calculateWaitMs(parsed, opts?.marginSeconds, opts?.fallbackHours, new Date(now));
    if (waitMs <= 0) {
      // Reset time already passed — no roll-to-tomorrow.
      if (isBlockedAtBanner(screenText)) {
        await injectContinue('rate-limit');
        log(`${label} reset already passed — sent 'continue'`);
        return 'retried';
      }
      log(`${label} stale banner ignored (reset already passed)`);
      return 'monitoring';
    }
    if (!isBlockedAtBanner(screenText)) {
      log(`${label} loose limit text but no canonical banner — ignored`);
      return 'monitoring';
    }
    state.waitUntil = now + waitMs;
    state.status = 'waiting';
    return 'rate-limited';
  }

  // Not rate-limited. Check for transient API error parked at bottom.
  if (isApiErrorAtBottom(screenText)) {
    if (state.apiRetries >= MAX_API_RETRIES) {
      if (!state.apiGaveUp) {
        state.apiGaveUp = true;
        log(`${label} — API error persists after ${MAX_API_RETRIES} retries, giving up`);
      }
      return 'monitoring';
    }
    if (state.apiNextActionAt === 0) {
      state.apiNextActionAt = now + API_RETRY_DELAY_MS;
      log(`${label} — API error, will retry 'continue' at ${formatLocalDateTime(state.apiNextActionAt)}`);
      return 'monitoring';
    }
    if (now >= state.apiNextActionAt) {
      await injectContinue('api-error');
      state.apiRetries++;
      state.apiNextActionAt = now + API_RETRY_DELAY_MS;
      return 'api-retried';
    }
    return 'monitoring';
  }

  // No API error → recovered (or never errored); clear retry state.
  if (state.apiRetries !== 0 || state.apiNextActionAt !== 0 || state.apiGaveUp) {
    state.apiRetries = 0;
    state.apiNextActionAt = 0;
    state.apiGaveUp = false;
  }

  return 'monitoring';
}
