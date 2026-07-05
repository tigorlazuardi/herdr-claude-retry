/**
 * e2e: live herdr acceptance test.
 *
 * Requires a running herdr daemon. If the socket is not available, the test
 * skips gracefully. Not part of `npm run verify` (needs live herdr).
 *
 * Run: npm run e2e
 *
 * Protocol reality (herdr 0.7.1): every connection is one-shot. This test
 * verifies that HerdrClient correctly opens fresh sockets per request and that
 * the daemon can complete a reconcile sweep (paneRead for all live panes)
 * without connection errors.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { HerdrClient } from '../../src/herdr.ts';
import { runDaemon } from '../../src/daemon.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function socketPath(): string {
  return process.env['HERDR_SOCKET_PATH'] ?? resolve(homedir(), '.config', 'herdr', 'herdr.sock');
}

/** One-shot raw request — mirrors how HerdrClient works internally. */
async function herdrRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(socketPath());
    let buf = '';
    const id = `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    sock.setEncoding('utf8');
    sock.once('error', reject);

    sock.on('data', (chunk: string) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed) as Record<string, unknown>;
          if (msg['id'] === id) {
            sock.destroy();
            if (msg['error']) {
              reject(new Error(JSON.stringify(msg['error'])));
            } else {
              resolve(msg['result']);
            }
          }
        } catch { /* skip malformed */ }
      }
    });

    sock.once('connect', () => {
      sock.write(JSON.stringify({ id, method, params }) + '\n');
    });
  });
}

async function herdrAvailable(): Promise<boolean> {
  try {
    await herdrRequest('agent.list', {});
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('herdr e2e — one-shot protocol smoke tests', () => {
  let available = false;

  before(async () => {
    available = await herdrAvailable();
    if (!available) {
      console.log('  [skip] herdr socket not available — skipping e2e tests');
    }
  });

  it('HerdrClient.connect(): connectivity check passes', async () => {
    if (!available) {
      console.log('  [skip] no herdr socket');
      return;
    }

    const client = new HerdrClient({ socketPath: socketPath() });
    try {
      await client.connect();
      // No error = connectivity check passed
    } finally {
      client.destroy();
    }
  });

  it('HerdrClient.agentList(): returns live agent list', async () => {
    if (!available) {
      console.log('  [skip] no herdr socket');
      return;
    }

    const client = new HerdrClient({ socketPath: socketPath() });
    try {
      const agents = await client.agentList();
      assert.ok(Array.isArray(agents), 'agentList must return array');
      console.log(`  [info] ${agents.length} live agent pane(s): ${agents.map((a) => a.pane_id).join(', ')}`);
    } finally {
      client.destroy();
    }
  });

  it('HerdrClient.paneRead(): succeeds for all live panes (core one-shot fix)', async () => {
    if (!available) {
      console.log('  [skip] no herdr socket');
      return;
    }

    const client = new HerdrClient({ socketPath: socketPath() });
    try {
      const agents = await client.agentList();

      if (agents.length === 0) {
        console.log('  [skip] no live agent panes to read');
        return;
      }

      // Read each pane — each opens a fresh socket. All must succeed.
      const results = await Promise.allSettled(
        agents.map((a) => client.paneRead(a.pane_id, 'visible')),
      );

      const failures = results
        .map((r, i) => ({ r, paneId: agents[i]!.pane_id }))
        .filter(({ r }) => r.status === 'rejected');

      if (failures.length > 0) {
        const reasons = failures
          .map(({ paneId, r }) => `${paneId}: ${(r as PromiseRejectedResult).reason}`)
          .join(', ');
        assert.fail(`paneRead failed for ${failures.length} pane(s): ${reasons}`);
      }

      const successes = results.filter((r) => r.status === 'fulfilled').length;
      console.log(`  [info] paneRead succeeded for all ${successes} pane(s)`);
    } finally {
      client.destroy();
    }
  });

  it('parallel paneRead + agentList: concurrent one-shot requests all succeed', async () => {
    if (!available) {
      console.log('  [skip] no herdr socket');
      return;
    }

    const client = new HerdrClient({ socketPath: socketPath() });
    try {
      const agents = await client.agentList();

      if (agents.length === 0) {
        console.log('  [skip] no live agent panes');
        return;
      }

      // Fire agentList + all paneReads concurrently
      const [secondAgentList, ...reads] = await Promise.all([
        client.agentList(),
        ...agents.map((a) => client.paneRead(a.pane_id, 'visible')),
      ]);

      assert.ok(Array.isArray(secondAgentList), 'concurrent agentList must succeed');
      assert.equal(reads.length, agents.length, 'all paneReads must resolve');
      console.log(`  [info] ${reads.length} concurrent paneRead(s) + agentList all succeeded`);
    } finally {
      client.destroy();
    }
  });

  it('daemon reconcile sweep: completes without paneRead failures for live panes', async () => {
    if (!available) {
      console.log('  [skip] no herdr socket');
      return;
    }

    const client = new HerdrClient({ socketPath: socketPath() });
    const logs: string[] = [];
    const patchedLog = (msg: string) => {
      logs.push(msg);
      process.stdout.write(`  [daemon] ${msg}\n`);
    };

    const ac = new AbortController();
    const timeoutMs = 8_000;
    const timeoutPromise = new Promise<void>((r) => setTimeout(r, timeoutMs));

    try {
      await Promise.race([
        runDaemon({
          client,
          accountDirs: [],
          sweepIntervalMs: 60_000, // only initial sweep runs
          marginSeconds: 60,
          signal: ac.signal,
          log: patchedLog,
        }),
        timeoutPromise,
      ]);
    } finally {
      ac.abort();
      client.destroy();
    }

    console.log(`\n  === daemon log (${logs.length} entries) ===`);
    console.log(logs.join('\n'));
    console.log('  === end daemon log ===\n');

    // Must have run at least one sweep
    assert.ok(
      logs.some((l) => l.includes('reconcile sweep')),
      `expected at least one reconcile sweep log; got:\n${logs.join('\n')}`,
    );

    // paneRead must NOT have failed for live panes — this is the core fix
    const paneReadFailures = logs.filter((l) => l.includes('paneRead failed'));
    assert.equal(
      paneReadFailures.length,
      0,
      `paneRead must not fail on live panes — failed: ${paneReadFailures.join(', ')}`,
    );
  });
});
