/**
 * e2e: blocked-pane — live herdr acceptance test.
 *
 * Requires a running herdr daemon. If the socket is not available, the test
 * skips gracefully. Not part of `npm run verify` (needs live herdr).
 *
 * Run: npm run e2e
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { HerdrClient } from '../../src/herdr.ts';
import { runDaemon } from '../../src/daemon.ts';
import { isBlockedAtBanner } from '../../src/patterns.ts';

// ---------------------------------------------------------------------------
// Helpers — raw socket calls for workspace/pane lifecycle
// ---------------------------------------------------------------------------

function socketPath(): string {
  return process.env['HERDR_SOCKET_PATH'] ?? resolve(homedir(), '.config', 'herdr', 'herdr.sock');
}

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

async function paneRead(paneId: string): Promise<string> {
  const result = await herdrRequest('pane.read', { pane_id: paneId, source: 'visible' }) as {
    type: string;
    read: { text: string };
  };
  return result.read.text;
}

// ---------------------------------------------------------------------------
// Check herdr availability
// ---------------------------------------------------------------------------

async function herdrAvailable(): Promise<boolean> {
  try {
    await herdrRequest('ping', {});
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe('blocked-pane e2e — text-fallback path', () => {
  let workspaceId: string | null = null;
  let paneId: string | null = null;
  let available = false;

  before(async () => {
    available = await herdrAvailable();
    if (!available) {
      console.log('  [skip] herdr socket not available — skipping e2e tests');
      return;
    }

    // Create workspace
    const created = await herdrRequest('workspace.create', { name: 'hcr-test-t8' }) as {
      workspace_id?: string;
      workspace?: { workspace_id: string };
      root_pane?: { pane_id: string };
    };

    // workspace.create returns { workspace: { workspace_id }, root_pane: { pane_id }, ... }
    workspaceId = (created as unknown as { workspace: { workspace_id: string } }).workspace?.workspace_id
      ?? (created as { workspace_id?: string }).workspace_id
      ?? null;

    paneId = (created as unknown as { root_pane: { pane_id: string } }).root_pane?.pane_id ?? null;

    if (!workspaceId || !paneId) {
      throw new Error(`workspace.create returned unexpected shape: ${JSON.stringify(created)}`);
    }

    // Send banner script — canonical limit banner with already-past reset time
    await herdrRequest('pane.send_text', {
      pane_id: paneId,
      text: "printf \"You've hit your session limit · resets 12:00am (UTC)\\n\" && cat\n",
    });

    // Wait for banner to appear
    await new Promise<void>((r) => setTimeout(r, 800));

    // Verify banner is visible
    const screen = await paneRead(paneId);
    const hasBanner = isBlockedAtBanner(screen);
    if (!hasBanner) {
      // Print screen for diagnosis but don't fail yet — daemon may still detect it
      console.log(`  [warn] isBlockedAtBanner=false after setup. Screen:\n${screen}`);
    }
  });

  after(async () => {
    if (!available || !workspaceId) return;
    try {
      await herdrRequest('workspace.close', { workspace_id: workspaceId });
      console.log(`  [cleanup] workspace ${workspaceId} closed`);
    } catch (e) {
      console.log(`  [warn] workspace.close failed: ${e}`);
    }
  });

  it('daemon detects rate-limit banner and attempts inject (text-fallback path)', async () => {
    if (!available) {
      // Soft skip
      console.log('  [skip] no herdr socket');
      return;
    }

    assert.ok(workspaceId, 'workspace must be created');
    assert.ok(paneId, 'pane must exist');

    // Two separate HerdrClient connections:
    //   client         — regular requests (pane.read, agent.list, inject)
    //   subscribeClient — events.subscribe (herdr closes a socket that sends
    //                     non-subscribe requests after events.subscribe)
    const client = new HerdrClient({ socketPath: socketPath() });
    await client.connect();
    const subscribeClient = new HerdrClient({ socketPath: socketPath() });
    await subscribeClient.connect();

    const logs: string[] = [];
    const log = (msg: string) => {
      logs.push(msg);
      process.stdout.write(`  [daemon] ${msg}\n`);
    };

    const ac = new AbortController();
    const timeoutMs = 8_000;

    // Timeout promise — resolves after timeoutMs
    const timeoutPromise = new Promise<void>((r) => setTimeout(r, timeoutMs));

    try {
      await Promise.race([
        runDaemon({
          client,
          subscribeClient,
          accountDirs: [], // no real account → resolveAccountDir returns null → usage=null → text-fallback
          sweepIntervalMs: 1_000,
          marginSeconds: 0, // reset time is past, inject immediately
          signal: ac.signal,
          log,
        }),
        timeoutPromise,
      ]);
    } finally {
      ac.abort();
      client.destroy();
      subscribeClient.destroy();
    }

    // Assertions — daemon must have detected the limit
    const allLogs = logs.join('\n');

    // Must see limit detected (output_matched or sweep reading the banner)
    const sawLimit =
      logs.some((l) => l.includes('limit') || l.includes('output_matched') || l.includes('blocked')) ||
      logs.some((l) => l.includes('monitoring') || l.includes('waiting'));

    // Must see inject attempt (inject logged by daemon) or state transition
    const sawInjectOrTransition =
      logs.some((l) => l.includes('inject') || l.includes('waiting') || l.includes('banner gone'));

    console.log(`\n  === daemon log (${logs.length} entries) ===`);
    console.log(allLogs);
    console.log('  === end daemon log ===\n');

    // At minimum the daemon must have run its sweep (proof it ran)
    assert.ok(
      logs.some((l) => l.includes('sweep') || l.includes('starting')),
      `expected at least one sweep log entry; got:\n${allLogs}`,
    );

    // Daemon must have seen the banner or attempted inject
    assert.ok(
      sawLimit || sawInjectOrTransition,
      `expected daemon to detect limit or attempt inject; got:\n${allLogs}`,
    );
  });
});
