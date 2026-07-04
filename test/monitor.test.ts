import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createState,
  stepState,
  MAX_API_RETRIES,
  type MonitorState,
} from '../src/monitor.ts';

const FIXED_NOW = new Date('2024-01-15T10:00:00Z').getTime();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInjectFn(): { inject: () => Promise<void>; calls: number } {
  const state = { calls: 0 };
  return {
    inject: async () => { state.calls++; },
    calls: state.calls,
  };
}

type InjectTracker = { calls: number; inject: () => Promise<void> };

function tracker(): InjectTracker {
  const t = { calls: 0, inject: async () => { t.calls++; } };
  return t;
}

// ---------------------------------------------------------------------------
// Basic monitoring transitions
// ---------------------------------------------------------------------------

describe('stepState — monitoring', () => {
  it('returns monitoring when screen is not rate-limited', async () => {
    const state = createState();
    const t = tracker();
    const status = await stepState(state, 'p1', 'Claude is ready to help.', FIXED_NOW, t.inject);
    assert.equal(status, 'monitoring');
    assert.equal(state.status, 'monitoring');
    assert.equal(state.waitUntil, 0);
    assert.equal(t.calls, 0);
  });

  it('returns rate-limited and sets waiting state when limit detected', async () => {
    const state = createState();
    const t = tracker();
    const status = await stepState(
      state, 'p1',
      '5-hour limit reached\nresets 3pm (UTC)',
      FIXED_NOW, t.inject,
    );
    assert.equal(status, 'rate-limited');
    assert.equal(state.status, 'waiting');
    assert.ok(state.waitUntil > FIXED_NOW, 'waitUntil should be in the future');
    assert.ok(state.waitUntil >= FIXED_NOW + 5 * 3600000, 'waitUntil should be at least 5h out');
    assert.equal(t.calls, 0);
  });

  it('loose limit text but no canonical banner → ignored, stays monitoring', async () => {
    const state = createState();
    const t = tracker();
    const proseText = 'discussing the rate-limit banner and when it resets';
    const status = await stepState(state, 'p1', proseText, FIXED_NOW, t.inject);
    assert.equal(status, 'monitoring');
    assert.equal(state.status, 'monitoring');
    assert.equal(state.waitUntil, 0);
    assert.equal(t.calls, 0);
  });
});

// ---------------------------------------------------------------------------
// Waiting branch
// ---------------------------------------------------------------------------

describe('stepState — waiting branch', () => {
  it('rate-limited without inject when banner present and timer not elapsed', async () => {
    const state = createState();
    state.status = 'waiting';
    state.waitUntil = FIXED_NOW + 3600000;
    const t = tracker();
    const status = await stepState(
      state, 'p1',
      '5-hour limit reached\nresets 3pm (UTC)',
      FIXED_NOW, t.inject,
    );
    assert.equal(status, 'rate-limited');
    assert.equal(t.calls, 0);
    assert.equal(state.status, 'waiting');
  });

  it('injects continue and resets state when wait period elapsed + banner present', async () => {
    const state = createState();
    state.status = 'waiting';
    state.waitUntil = FIXED_NOW - 1;
    const t = tracker();
    const status = await stepState(
      state, 'p1',
      '5-hour limit reached\nresets 3pm (UTC)',
      FIXED_NOW, t.inject,
    );
    assert.equal(status, 'retried');
    assert.equal(t.calls, 1);
    assert.equal(state.status, 'monitoring');
    assert.equal(state.waitUntil, 0);
  });

  it('banner GONE (pre-reset) → wait abandoned, no inject, status→monitoring', async () => {
    const state = createState();
    state.status = 'waiting';
    state.waitUntil = FIXED_NOW + 3600000;
    const t = tracker();
    const status = await stepState(state, 'p1', 'Claude is ready.', FIXED_NOW, t.inject);
    assert.equal(status, 'monitoring');
    assert.equal(state.status, 'monitoring');
    assert.equal(state.waitUntil, 0);
    assert.equal(t.calls, 0);
  });

  it('waiting + elapsed + banner GONE → no inject (abandon, not retried)', async () => {
    // INVARIANT: abandon wait when banner gone
    const state = createState();
    state.status = 'waiting';
    state.waitUntil = FIXED_NOW - 1;
    const t = tracker();
    // Pane now shows shell prompt — banner gone
    const status = await stepState(state, 'p1', 'user@host:~$ ', FIXED_NOW, t.inject);
    assert.equal(status, 'monitoring');
    assert.equal(t.calls, 0, 'must NOT inject when banner is gone');
    assert.equal(state.status, 'monitoring');
    assert.equal(state.waitUntil, 0);
  });

  it('account cleared (usage.limited=false) + banner present → inject', async () => {
    // INVARIANT: inject when account cleared + canonical banner at bottom
    const state = createState();
    state.status = 'waiting';
    state.waitUntil = FIXED_NOW + 3600000; // still in future
    const t = tracker();
    const status = await stepState(
      state, 'p1',
      "You've hit your session limit · resets 12:50am (Asia/Jakarta)",
      FIXED_NOW, t.inject,
      { usage: { limited: false, resetsAtMs: null } },
    );
    assert.equal(status, 'retried');
    assert.equal(t.calls, 1, 'must inject when account cleared + banner at bottom');
    assert.equal(state.status, 'monitoring');
  });

  it('account still limited with future resetsAtMs → waitUntil refreshed, stays waiting', async () => {
    const state = createState();
    state.status = 'waiting';
    state.waitUntil = FIXED_NOW - 1; // elapsed, but account refresh pulls it forward
    const futureReset = FIXED_NOW + 2 * 3600000;
    const t = tracker();
    const marginSeconds = 60;
    const status = await stepState(
      state, 'p1',
      '5-hour limit reached\nresets 3pm (UTC)',
      FIXED_NOW, t.inject,
      { marginSeconds, usage: { limited: true, resetsAtMs: futureReset } },
    );
    assert.equal(status, 'rate-limited');
    assert.equal(state.status, 'waiting');
    assert.equal(state.waitUntil, futureReset + marginSeconds * 1000, 'waitUntil refreshed');
    assert.equal(t.calls, 0, 'must NOT inject when waitUntil refreshed to future');
  });

  it('past reset time → inject (no roll-to-tomorrow)', async () => {
    // INVARIANT: past reset time never rolled to tomorrow
    const state = createState();
    // FIXED_NOW = 10:00 UTC, "resets 3am (UTC)" → 03:00 already past
    const pastResetScreen = 'Some prior output\n' +
      "You've hit your session limit · resets 3am (UTC)";
    const t = tracker();
    const status = await stepState(state, 'p1', pastResetScreen, FIXED_NOW, t.inject);
    assert.equal(status, 'retried');
    assert.equal(t.calls, 1, 'must inject when reset already passed and canonical banner at bottom');
    assert.equal(state.status, 'monitoring');
  });
});

// ---------------------------------------------------------------------------
// API-error recovery
// ---------------------------------------------------------------------------

const API_ERR_SCREEN =
  'Some prior output\n' +
  'API Error: Connection closed mid-response. The response above may be incomplete.\n' +
  '> ';

describe('stepState — API-error recovery', () => {
  it('first sighting arms backoff, does NOT inject immediately', async () => {
    const state = createState();
    const t = tracker();
    const status = await stepState(state, 'p1', API_ERR_SCREEN, FIXED_NOW, t.inject);
    assert.equal(status, 'monitoring');
    assert.equal(t.calls, 0, 'must not inject on first sighting');
    assert.equal(state.apiNextActionAt, FIXED_NOW + 10_000);
    assert.equal(state.apiRetries, 0);
  });

  it('injects continue once backoff elapses', async () => {
    const state = createState();
    const t = tracker();
    let now = FIXED_NOW;

    await stepState(state, 'p1', API_ERR_SCREEN, now, t.inject); // arm
    assert.equal(t.calls, 0);

    now = FIXED_NOW + 5_000; // before backoff
    await stepState(state, 'p1', API_ERR_SCREEN, now, t.inject);
    assert.equal(t.calls, 0, 'must not inject before backoff elapses');

    now = FIXED_NOW + 10_000; // backoff elapsed
    const status = await stepState(state, 'p1', API_ERR_SCREEN, now, t.inject);
    assert.equal(status, 'api-retried');
    assert.equal(t.calls, 1);
    assert.equal(state.apiRetries, 1);
    assert.equal(state.apiNextActionAt, now + 10_000, 're-armed for next retry');
  });

  it('caps consecutive retries at MAX_API_RETRIES (5) then gives up', async () => {
    // INVARIANT: API-error retries hard-capped
    const state = createState();
    const t = tracker();
    let now = FIXED_NOW;

    await stepState(state, 'p1', API_ERR_SCREEN, now, t.inject); // first sighting arms backoff

    for (let i = 0; i < 5; i++) {
      now += 10_000;
      const s = await stepState(state, 'p1', API_ERR_SCREEN, now, t.inject);
      assert.equal(s, 'api-retried', `retry ${i + 1} should inject`);
    }
    assert.equal(t.calls, 5);
    assert.equal(state.apiRetries, 5);

    // 6th window: cap reached → no further inject
    now += 10_000;
    const s = await stepState(state, 'p1', API_ERR_SCREEN, now, t.inject);
    assert.equal(s, 'monitoring');
    assert.equal(t.calls, 5, 'must not exceed MAX_API_RETRIES');
    assert.equal(state.apiGaveUp, true);
    assert.equal(state.apiRetries, MAX_API_RETRIES);
  });

  it('resets retry state once the error clears', async () => {
    const state = createState();
    const t = tracker();
    let now = FIXED_NOW;

    await stepState(state, 'p1', API_ERR_SCREEN, now, t.inject); // arm
    now = FIXED_NOW + 10_000;
    await stepState(state, 'p1', API_ERR_SCREEN, now, t.inject); // inject
    assert.equal(state.apiRetries, 1);

    // Error gone — claude resumed
    const status = await stepState(state, 'p1', 'Claude is responding normally.', now, t.inject);
    assert.equal(status, 'monitoring');
    assert.equal(state.apiRetries, 0);
    assert.equal(state.apiNextActionAt, 0);
    assert.equal(state.apiGaveUp, false);
  });

  it('error not at bottom (in scrollback) → no inject', async () => {
    const state = createState();
    const t = tracker();
    const midScreen =
      'API Error: Connection closed mid-response.\n' +
      Array.from({ length: 20 }, (_, i) => `output line ${i + 1}`).join('\n');
    const status = await stepState(state, 'p1', midScreen, FIXED_NOW, t.inject);
    assert.equal(status, 'monitoring');
    assert.equal(t.calls, 0);
    assert.equal(state.apiNextActionAt, 0, 'must not arm when error not parked at bottom');
  });
});

// ---------------------------------------------------------------------------
// Account-aware limit resolution
// ---------------------------------------------------------------------------

describe('stepState — account-aware resolution', () => {
  const LIMITED_SCREEN = '5-hour limit reached\nresets 3pm (UTC)';
  const ACCOUNT_DIR = '/home/user/.claude';
  const RESET_MS = new Date('2024-01-15T15:00:00Z').getTime();

  it('account NOT limited + canonical banner at bottom → inject (cleared-limit path)', async () => {
    // LIMITED_SCREEN passes isBlockedAtBanner in this repo → aggressive inject fires.
    // Stale-banner ignoring only applies when banner is NOT at bottom (isBlockedAtBanner=false).
    const state = createState();
    const t = tracker();
    const status = await stepState(
      state, 'p1', LIMITED_SCREEN, FIXED_NOW, t.inject,
      { usage: { limited: false, resetsAtMs: null } },
    );
    assert.equal(status, 'retried', 'cleared-limit + canonical banner at bottom → inject');
    assert.equal(state.status, 'monitoring');
    assert.equal(t.calls, 1);
  });

  it('account NOT limited + banner NOT at bottom → stale banner ignored, stays monitoring', async () => {
    const state = createState();
    const t = tracker();
    // Banner mid-screen — isBlockedAtBanner returns false → staleness gate fires
    const bannerMidScreen =
      "You've hit your session limit · resets 12:50am (Asia/Jakarta)\n" +
      Array.from({ length: 20 }, (_, i) => `output line ${i + 1}`).join('\n');
    const status = await stepState(
      state, 'p1', bannerMidScreen, FIXED_NOW, t.inject,
      { usage: { limited: false, resetsAtMs: null } },
    );
    assert.equal(status, 'monitoring', 'stale banner not at bottom should not trigger inject');
    assert.equal(state.waitUntil, 0);
    assert.equal(t.calls, 0);
  });

  it('account limited with resetsAtMs → waitUntil = resetsAtMs + margin', async () => {
    const state = createState();
    const t = tracker();
    const marginSeconds = 60;
    const status = await stepState(
      state, 'p1', LIMITED_SCREEN, FIXED_NOW, t.inject,
      { marginSeconds, usage: { limited: true, resetsAtMs: RESET_MS } },
    );
    assert.equal(status, 'rate-limited');
    assert.equal(state.status, 'waiting');
    assert.equal(state.waitUntil, RESET_MS + marginSeconds * 1000);
    assert.equal(t.calls, 0);
  });

  it('no usage provided → text fallback path works', async () => {
    const state = createState();
    const t = tracker();
    const status = await stepState(state, 'p1', LIMITED_SCREEN, FIXED_NOW, t.inject);
    assert.equal(status, 'rate-limited');
    assert.equal(state.status, 'waiting');
    assert.ok(state.waitUntil > FIXED_NOW, 'text fallback should set future waitUntil');
    assert.equal(t.calls, 0);
  });

  it('REGRESSION: waiting + account cleared (early reset) + banner present → inject, not abandoned', async () => {
    const state = createState();
    state.status = 'waiting';
    state.waitUntil = FIXED_NOW + 3600000; // 1h in future
    const t = tracker();
    const realBannerText = "You've hit your session limit · resets 12:50am (Asia/Jakarta)";
    const status = await stepState(
      state, 'p1', realBannerText, FIXED_NOW, t.inject,
      { usage: { limited: false, resetsAtMs: FIXED_NOW - 60000 } },
    );
    assert.equal(t.calls, 1, 'MUST inject continue on early reset — not abandon');
    assert.equal(status, 'retried');
    assert.equal(state.status, 'monitoring');
    assert.equal(state.waitUntil, 0);
  });
});

// ---------------------------------------------------------------------------
// Full retry cycle
// ---------------------------------------------------------------------------

describe('stepState — full retry cycle', () => {
  it('detect → wait → inject → monitor', async () => {
    const state = createState();
    let currentTime = FIXED_NOW;
    const t = tracker();
    const screen = '5-hour limit reached\nresets 3pm (UTC)';

    // Step 1: detect limit
    const s1 = await stepState(state, 'p1', screen, currentTime, t.inject);
    assert.equal(s1, 'rate-limited');
    assert.equal(state.status, 'waiting');
    const savedWaitUntil = state.waitUntil;

    // Step 2: tick before wait expires
    currentTime = savedWaitUntil - 1000;
    const s2 = await stepState(state, 'p1', screen, currentTime, t.inject);
    assert.equal(s2, 'rate-limited');
    assert.equal(t.calls, 0);

    // Step 3: tick after wait expires
    currentTime = savedWaitUntil + 1;
    const s3 = await stepState(state, 'p1', screen, currentTime, t.inject);
    assert.equal(s3, 'retried');
    assert.equal(t.calls, 1);
    assert.equal(state.status, 'monitoring');

    // Step 4: normal screen
    const s4 = await stepState(state, 'p1', 'Claude is ready to help.', currentTime, t.inject);
    assert.equal(s4, 'monitoring');
    assert.equal(t.calls, 1, 'no extra inject on clean screen');
  });
});

// ---------------------------------------------------------------------------
// Prose-mention guard
// ---------------------------------------------------------------------------

describe('prose-mention guard', () => {
  it('T1: monitoring + loose-match prose (no canonical banner) → stays monitoring', async () => {
    const state = createState();
    const t = tracker();
    const proseText = 'discussing the rate-limit banner and when it resets';
    const status = await stepState(state, 'p1', proseText, FIXED_NOW, t.inject);
    assert.equal(status, 'monitoring', 'prose must NOT park pane into waiting');
    assert.equal(state.waitUntil, 0);
    assert.equal(t.calls, 0);
  });

  it('T2: waiting + elapsed + loose-match prose → no inject, transitions to monitoring', async () => {
    const state = createState();
    state.status = 'waiting';
    state.waitUntil = FIXED_NOW - 1;
    const t = tracker();
    const proseText = 'discussing the rate-limit banner and when it resets';
    const status = await stepState(state, 'p1', proseText, FIXED_NOW, t.inject);
    assert.equal(t.calls, 0, 'must NOT inject when no canonical banner at bottom');
    assert.equal(status, 'monitoring', 'must abandon wait when banner absent');
    assert.equal(state.waitUntil, 0);
  });
});

// ---------------------------------------------------------------------------
// Hard invariant: never send input to pane not showing qualifying banner
// ---------------------------------------------------------------------------

describe('hard invariant — never inject without canonical banner', () => {
  it('banner mid-screen (not at bottom) → no inject even when account cleared', async () => {
    const state = createState();
    const t = tracker();
    const bannerMidScreen =
      "You've hit your session limit · resets 12:50am (Asia/Jakarta)\n" +
      Array.from({ length: 20 }, (_, i) => `output line ${i + 1}`).join('\n');
    const status = await stepState(
      state, 'p1', bannerMidScreen, FIXED_NOW, t.inject,
      { usage: { limited: false, resetsAtMs: null } },
    );
    assert.equal(t.calls, 0, 'must NOT inject when banner not at bottom');
    assert.equal(status, 'monitoring');
  });

  it('waiting + elapsed + banner NOT at bottom → no inject, abandon wait', async () => {
    const state: MonitorState = createState();
    state.status = 'waiting';
    state.waitUntil = FIXED_NOW - 1;
    const t = tracker();
    const bannerMidScreen =
      "You've hit your session limit · resets 12:50am (Asia/Jakarta)\n" +
      Array.from({ length: 20 }, (_, i) => `output line ${i + 1}`).join('\n');
    // match() returns limited=true but isBlockedAtBanner=false → abandon
    const status = await stepState(state, 'p1', bannerMidScreen, FIXED_NOW, t.inject);
    assert.equal(t.calls, 0, 'must NOT inject when banner not at bottom');
    assert.equal(status, 'monitoring');
    assert.equal(state.status, 'monitoring');
  });
});
