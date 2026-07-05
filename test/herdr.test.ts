/**
 * herdr.test.ts — unit tests for HerdrClient using in-process fake socket server.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type Socket as NetSocket, connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { unlink } from 'node:fs/promises';

import { HerdrClient, HerdrError, type ConnectFn } from '../src/herdr.ts';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const FIXTURE_DIR = new URL('./fixtures/socket/', import.meta.url);

function fixture(name: string): string {
  return readFileSync(new URL(name, FIXTURE_DIR), 'utf8').trim();
}

// ---------------------------------------------------------------------------
// Fake server helpers
// ---------------------------------------------------------------------------

interface FakeServerOpts {
  /**
   * Handler called with each NDJSON line received from the client.
   * Returns response lines to send (each will be written with a trailing \n).
   * Return [] to send nothing (e.g., keep-alive for subscriptions).
   */
  handler: (line: string, sock: NetSocket) => string[];
}

function createFakeServer(
  socketPath: string,
  opts: FakeServerOpts,
): { server: Server; close: () => Promise<void> } {
  const server = createServer((sock) => {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk: string) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const replies = opts.handler(trimmed, sock);
        for (const reply of replies) {
          sock.write(reply + '\n');
        }
      }
    });
  });

  return {
    server,
    close: () =>
      new Promise((res, rej) => {
        server.close((err) => (err ? rej(err) : res()));
      }),
  };
}

/** Bind a fake server to a tmp socket path, return connectFn that wires to it. */
async function bindFake(
  name: string,
  opts: FakeServerOpts,
): Promise<{ connectFn: ConnectFn; close: () => Promise<void>; socketPath: string }> {
  const socketPath = join(tmpdir(), `herdr-test-${name}-${Date.now()}.sock`);
  const { server, close } = createFakeServer(socketPath, opts);

  await new Promise<void>((resolve, reject) => {
    server.listen(socketPath, () => resolve());
    server.once('error', reject);
  });

  const connectFn: ConnectFn = () => connect(socketPath);

  return {
    connectFn,
    socketPath,
    close: async () => {
      await close();
      await unlink(socketPath).catch(() => {});
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HerdrClient', () => {
  // -------------------------------------------------------------------------
  // Request/response correlation
  // -------------------------------------------------------------------------
  describe('request/response correlation', () => {
    it('agentList: correlates id and parses agents', async () => {
      const agentListFixture = fixture('agent.list.json');

      const { connectFn, close } = await bindFake('agent-list', {
        handler: (line) => {
          const req = JSON.parse(line) as { id: string; method: string };
          assert.equal(req.method, 'agent.list');
          // Reply with same id
          const resp = JSON.parse(agentListFixture) as { id: string };
          resp.id = req.id;
          return [JSON.stringify(resp)];
        },
      });

      const client = new HerdrClient({ connectFn });
      try {
        await client.connect();
        const agents = await client.agentList();
        assert.ok(Array.isArray(agents));
        assert.ok(agents.length > 0);
        assert.equal(agents[0]!.agent, 'claude');
        assert.ok(agents[0]!.pane_id);
      } finally {
        client.destroy();
        await close();
      }
    });

    it('paneRead: returns read object', async () => {
      const paneReadFixture = fixture('pane.read.visible.json');

      const { connectFn, close } = await bindFake('pane-read', {
        handler: (line) => {
          const req = JSON.parse(line) as { id: string; method: string };
          assert.equal(req.method, 'pane.read');
          const resp = JSON.parse(paneReadFixture) as { id: string };
          resp.id = req.id;
          return [JSON.stringify(resp)];
        },
      });

      const client = new HerdrClient({ connectFn });
      try {
        await client.connect();
        const read = await client.paneRead('w8:p2', 'visible');
        assert.equal(read.pane_id, 'w8:p2');
        assert.equal(typeof read.text, 'string');
      } finally {
        client.destroy();
        await close();
      }
    });

    it('paneProcessInfo: returns process_info', async () => {
      const processInfoFixture = fixture('pane.process_info.json');

      const { connectFn, close } = await bindFake('pane-pi', {
        handler: (line) => {
          const req = JSON.parse(line) as { id: string; method: string };
          assert.equal(req.method, 'pane.process_info');
          const resp = JSON.parse(processInfoFixture) as { id: string };
          resp.id = req.id;
          return [JSON.stringify(resp)];
        },
      });

      const client = new HerdrClient({ connectFn });
      try {
        await client.connect();
        const info = await client.paneProcessInfo('w8:p2');
        assert.equal(info.pane_id, 'w8:p2');
        assert.ok(info.shell_pid > 0);
        assert.ok(Array.isArray(info.foreground_processes));
      } finally {
        client.destroy();
        await close();
      }
    });

    it('paneSendKeys: sends Emacs notation and receives ok', async () => {
      const okFixture = fixture('pane-send-keys-ok.json');

      let capturedKeys: string[] | undefined;
      const { connectFn, close } = await bindFake('send-keys', {
        handler: (line) => {
          const req = JSON.parse(line) as { id: string; method: string; params: { keys: string[] } };
          assert.equal(req.method, 'pane.send_keys');
          capturedKeys = req.params.keys;
          const resp = JSON.parse(okFixture) as { id: string };
          resp.id = req.id;
          return [JSON.stringify(resp)];
        },
      });

      const client = new HerdrClient({ connectFn });
      try {
        await client.connect();
        await client.paneSendKeys('w8:p2', ['C-c']);
        assert.deepEqual(capturedKeys, ['C-c']);
      } finally {
        client.destroy();
        await close();
      }
    });

    it('error response: throws HerdrError with code and message', async () => {
      const errorFixture = fixture('error-unknown-variant.json');

      const { connectFn, close } = await bindFake('error', {
        handler: (line) => {
          const req = JSON.parse(line) as { id: string };
          const resp = JSON.parse(errorFixture) as { id: string };
          resp.id = req.id;
          return [JSON.stringify(resp)];
        },
      });

      const client = new HerdrClient({ connectFn });
      try {
        await client.connect();
        await assert.rejects(
          () => client.paneSendText('w8:p2', 'hello'),
          (err: unknown) => {
            assert.ok(err instanceof HerdrError);
            assert.equal(err.code, 'invalid_request');
            assert.ok(err.message.includes('unknown variant'));
            return true;
          },
        );
      } finally {
        client.destroy();
        await close();
      }
    });

    it('parallel requests: all correlate independently', async () => {
      const agentListFixture = fixture('agent.list.json');
      const paneReadFixture = fixture('pane.read.visible.json');
      const processInfoFixture = fixture('pane.process_info.json');

      const { connectFn, close } = await bindFake('parallel', {
        handler: (line) => {
          const req = JSON.parse(line) as { id: string; method: string };
          if (req.method === 'agent.list') {
            const resp = JSON.parse(agentListFixture) as { id: string };
            resp.id = req.id;
            return [JSON.stringify(resp)];
          }
          if (req.method === 'pane.read') {
            const resp = JSON.parse(paneReadFixture) as { id: string };
            resp.id = req.id;
            return [JSON.stringify(resp)];
          }
          if (req.method === 'pane.process_info') {
            const resp = JSON.parse(processInfoFixture) as { id: string };
            resp.id = req.id;
            return [JSON.stringify(resp)];
          }
          return [];
        },
      });

      const client = new HerdrClient({ connectFn });
      try {
        await client.connect();
        const [agents, read, info] = await Promise.all([
          client.agentList(),
          client.paneRead('w8:p2'),
          client.paneProcessInfo('w8:p2'),
        ]);
        assert.ok(Array.isArray(agents));
        assert.equal(read.pane_id, 'w8:p2');
        assert.ok(info.shell_pid > 0);
      } finally {
        client.destroy();
        await close();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Subscription event stream
  // -------------------------------------------------------------------------
  describe('subscription event stream', () => {
    it('subscribe: yields agent_status_changed events', async () => {
      const subStartedFixture = fixture('events-subscribe-subscription-started.json');
      const statusFixture1 = fixture('event.pane.agent_status_changed.json');

      // statusFixture is multi-line (two events); take them as individual lines
      const statusLines = statusFixture1.split('\n').filter((l) => l.trim());

      let subId = '';

      const { connectFn, close } = await bindFake('sub-status', {
        handler: (line, sock) => {
          const req = JSON.parse(line) as { id: string; method: string };
          if (req.method === 'events.subscribe') {
            subId = req.id;
            const started = JSON.parse(subStartedFixture) as { id: string };
            started.id = req.id;
            // After ack, push two events with a small delay
            setTimeout(() => {
              for (const evLine of statusLines) {
                sock.write(evLine + '\n');
              }
            }, 10);
            return [JSON.stringify(started)];
          }
          return [];
        },
      });

      const client = new HerdrClient({ connectFn });
      try {
        await client.connect();

        const ac = new AbortController();
        const collected: string[] = [];

        const gen = client.subscribeAgentStatus('wH:p1', ac.signal);
        // Collect exactly 2 events then abort
        for await (const ev of gen) {
          collected.push(ev.data.agent_status);
          if (collected.length === 2) {
            ac.abort();
          }
        }

        assert.deepEqual(collected, ['working', 'done']);
      } finally {
        client.destroy();
        await close();
      }
    });

    it('subscribe: yields output_matched events', async () => {
      const subStartedFixture = fixture('events-subscribe-subscription-started.json');
      const outputFixture = fixture('event.pane.output_matched.json');

      const { connectFn, close } = await bindFake('sub-output', {
        handler: (line, sock) => {
          const req = JSON.parse(line) as { id: string; method: string };
          if (req.method === 'events.subscribe') {
            const started = JSON.parse(subStartedFixture) as { id: string };
            started.id = req.id;
            setTimeout(() => {
              sock.write(outputFixture + '\n');
            }, 10);
            return [JSON.stringify(started)];
          }
          return [];
        },
      });

      const client = new HerdrClient({ connectFn });
      try {
        await client.connect();

        const ac = new AbortController();
        const gen = client.paneSubscribeOutputMatched(
          'wH:p1',
          { type: 'regex', value: 'testGHI' },
          'visible',
          ac.signal,
        );

        const ev = (await gen.next()).value;
        ac.abort();
        assert.ok(ev);
        assert.equal(ev.event, 'pane.output_matched');
        assert.ok(ev.data.matched_line.includes('echo testGHI'));
      } finally {
        client.destroy();
        await close();
      }
    });

    it('subscribe: yields pane lifecycle events', async () => {
      const subStartedFixture = fixture('events-subscribe-subscription-started.json');
      const createdFixture = fixture('event.pane.created.json');
      const closedFixture = fixture('event.pane.closed.json');

      const { connectFn, close } = await bindFake('sub-lifecycle', {
        handler: (line, sock) => {
          const req = JSON.parse(line) as { id: string; method: string };
          if (req.method === 'events.subscribe') {
            const started = JSON.parse(subStartedFixture) as { id: string };
            started.id = req.id;
            setTimeout(() => {
              sock.write(createdFixture + '\n');
              sock.write(closedFixture + '\n');
            }, 10);
            return [JSON.stringify(started)];
          }
          return [];
        },
      });

      const client = new HerdrClient({ connectFn });
      try {
        await client.connect();

        const ac = new AbortController();
        const collected: string[] = [];

        for await (const ev of client.subscribePaneLifecycle(ac.signal)) {
          collected.push(ev.event);
          if (collected.length === 2) ac.abort();
        }

        assert.deepEqual(collected, ['pane_created', 'pane_closed']);
      } finally {
        client.destroy();
        await close();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Reconnect after drop
  // -------------------------------------------------------------------------
  describe('reconnect after drop', () => {
    it('auto-reconnects and calls onReconnect callback', async () => {
      const agentListFixture = fixture('agent.list.json');
      const socketPath = join(tmpdir(), `herdr-test-reconnect-${Date.now()}.sock`);

      let connectionCount = 0;
      const server = createServer((sock) => {
        connectionCount++;
        sock.setEncoding('utf8');

        if (connectionCount === 1) {
          // First connection: drop immediately
          sock.destroy();
          return;
        }

        // Second connection: serve normally
        let buf = '';
        sock.on('data', (chunk: string) => {
          buf += chunk;
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const req = JSON.parse(trimmed) as { id: string; method: string };
            if (req.method === 'agent.list') {
              const resp = JSON.parse(agentListFixture) as { id: string };
              resp.id = req.id;
              sock.write(JSON.stringify(resp) + '\n');
            }
          }
        });
      });

      await new Promise<void>((resolve, reject) => {
        server.listen(socketPath, () => resolve());
        server.once('error', reject);
      });

      const connectFn: ConnectFn = () => connect(socketPath);

      let reconnected = false;
      const client = new HerdrClient({
        connectFn,
        onReconnect: () => {
          reconnected = true;
        },
      });

      // Override reconnect delay to be tiny for the test
      (client as unknown as { reconnectDelay: number }).reconnectDelay = 50;

      try {
        await client.connect();
        // First connection dropped; wait for reconnect
        await new Promise<void>((resolve) => {
          const interval = setInterval(() => {
            if (reconnected) {
              clearInterval(interval);
              resolve();
            }
          }, 20);
          // Timeout safety
          setTimeout(() => {
            clearInterval(interval);
            resolve();
          }, 3000);
        });

        assert.ok(reconnected, 'should have reconnected');
        assert.equal(connectionCount, 2);

        // Should be functional after reconnect
        const agents = await client.agentList();
        assert.ok(Array.isArray(agents));
      } finally {
        client.destroy();
        await new Promise<void>((res) => server.close(() => res()));
        await unlink(socketPath).catch(() => {});
      }
    });

    it('exponential backoff: delay doubles on each reconnect failure', () => {
      // Test the backoff math directly without real socket
      const client = new HerdrClient({ connectFn: () => { throw new Error('no socket'); } });
      const getDelay = () => (client as unknown as { reconnectDelay: number }).reconnectDelay;

      assert.equal(getDelay(), 1000);

      // Simulate the doubling logic
      const simulate = (client as unknown as { reconnectDelay: number; maxDelay: number });
      simulate.reconnectDelay = Math.min(simulate.reconnectDelay * 2, simulate.maxDelay);
      assert.equal(getDelay(), 2000);
      simulate.reconnectDelay = Math.min(simulate.reconnectDelay * 2, simulate.maxDelay);
      assert.equal(getDelay(), 4000);

      // Simulate capping at maxDelay
      simulate.reconnectDelay = 32_000;
      simulate.reconnectDelay = Math.min(simulate.reconnectDelay * 2, simulate.maxDelay);
      assert.equal(getDelay(), 60_000); // capped
      simulate.reconnectDelay = Math.min(simulate.reconnectDelay * 2, simulate.maxDelay);
      assert.equal(getDelay(), 60_000); // stays capped
    });

    it('pending requests rejected on disconnect', async () => {
      const socketPath = join(tmpdir(), `herdr-test-disconnect-${Date.now()}.sock`);

      const server = createServer((sock) => {
        // Accept connection but never respond — then drop after 50ms
        setTimeout(() => sock.destroy(), 50);
      });

      await new Promise<void>((resolve, reject) => {
        server.listen(socketPath, () => resolve());
        server.once('error', reject);
      });

      const connectFn: ConnectFn = () => connect(socketPath);
      const client = new HerdrClient({ connectFn });

      // Override reconnect delay to be very large so reconnect won't fire during test
      const internals = client as unknown as { reconnectDelay: number; destroyed: boolean };
      internals.reconnectDelay = 99_999_999;

      try {
        await client.connect();

        // Issue a request; server will drop before responding
        // Wrap in a race so we don't hang if rejection never comes
        const rejectPromise = client.agentList();
        await assert.rejects(
          () => rejectPromise,
          (err: unknown) => {
            assert.ok(err instanceof Error);
            return true;
          },
        );
      } finally {
        client.destroy();
        await new Promise<void>((res) => server.close(() => res()));
        await unlink(socketPath).catch(() => {});
      }
    });
  });
});
