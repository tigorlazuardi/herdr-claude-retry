/**
 * herdr.test.ts — unit tests for HerdrClient using in-process fake socket server.
 *
 * Protocol: every connection is one-shot. The fake server accepts each connection,
 * handles one request-response, and the client destroys the socket. Subscribe
 * connections stay open until the server closes them or signal aborts.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type Socket as NetSocket, connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { unlink } from 'node:fs/promises';

import { HerdrClient, HerdrError, type ConnectFn, type OutputMatchedEvent } from '../src/herdr.ts';

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
  // connect() — connectivity check
  // -------------------------------------------------------------------------
  describe('connect()', () => {
    it('connect: resolves when socket is reachable', async () => {
      const { connectFn, close } = await bindFake('connect-ok', {
        handler: () => [],
      });
      const client = new HerdrClient({ connectFn });
      try {
        await client.connect();
        // No error = success
      } finally {
        client.destroy();
        await close();
      }
    });

    it('connect: rejects when socket is unreachable', async () => {
      const badPath = join(tmpdir(), `herdr-test-no-socket-${Date.now()}.sock`);
      const connectFn: ConnectFn = () => connect(badPath);
      const client = new HerdrClient({ connectFn });
      try {
        await assert.rejects(() => client.connect(), (err: unknown) => {
          assert.ok(err instanceof Error);
          return true;
        });
      } finally {
        client.destroy();
      }
    });
  });

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
          const resp = JSON.parse(agentListFixture) as { id: string };
          resp.id = req.id;
          return [JSON.stringify(resp)];
        },
      });

      const client = new HerdrClient({ connectFn });
      try {
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

    it('parallel requests: each opens its own socket, all correlate independently', async () => {
      const agentListFixture = fixture('agent.list.json');
      const paneReadFixture = fixture('pane.read.visible.json');
      const processInfoFixture = fixture('pane.process_info.json');

      // Each connection is one-shot; server handles each independently
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

    it('request timeout: rejects when server never responds', async () => {
      const socketPath = join(tmpdir(), `herdr-test-timeout-${Date.now()}.sock`);
      const server = createServer((sock) => {
        // Accept connection but never send a response
        sock.setEncoding('utf8');
        sock.on('data', () => { /* silently ignore */ });
      });

      await new Promise<void>((resolve, reject) => {
        server.listen(socketPath, () => resolve());
        server.once('error', reject);
      });

      const connectFn: ConnectFn = () => connect(socketPath);
      // Use a short timeout for the test
      const client = new HerdrClient({ connectFn });

      try {
        // Patch the private method's timeout via the request call directly
        // We can't easily inject timeout, so we test via a subclassed approach —
        // instead, just verify the client rejects when the socket is closed under it
        const closePromise = new Promise<void>((r) => setTimeout(r, 80))
          .then(() => { server.close(); });
        void closePromise;

        await assert.rejects(
          () => (client as unknown as {
            request: (m: string, p: Record<string, unknown>, t: number) => Promise<unknown>
          }).request('agent.list', {}, 60),
          (err: unknown) => {
            assert.ok(err instanceof Error);
            return true;
          },
        );
      } finally {
        client.destroy();
        await new Promise<void>((res) => server.close(() => res())).catch(() => {});
        await unlink(socketPath).catch(() => {});
      }
    });

    it('connect failure: request rejects when socket unreachable', async () => {
      const badPath = join(tmpdir(), `herdr-test-no-socket-${Date.now()}.sock`);
      const connectFn: ConnectFn = () => connect(badPath);
      const client = new HerdrClient({ connectFn });
      try {
        await assert.rejects(
          () => client.agentList(),
          (err: unknown) => {
            assert.ok(err instanceof Error);
            return true;
          },
        );
      } finally {
        client.destroy();
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

      const statusLines = statusFixture1.split('\n').filter((l) => l.trim());

      const { connectFn, close } = await bindFake('sub-status', {
        handler: (line, sock) => {
          const req = JSON.parse(line) as { id: string; method: string };
          if (req.method === 'events.subscribe') {
            const started = JSON.parse(subStartedFixture) as { id: string };
            started.id = req.id;
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
        const ac = new AbortController();
        const collected: string[] = [];

        const gen = client.subscribeAgentStatus('wH:p1', ac.signal);
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
        const ac = new AbortController();
        const eventsReceived: OutputMatchedEvent[] = [];

        for await (const ev of client.paneSubscribeOutputMatched(
          'wH:p1',
          { type: 'regex', value: 'testGHI' },
          'visible',
          ac.signal,
        )) {
          eventsReceived.push(ev);
          ac.abort();
        }

        assert.equal(eventsReceived.length, 1);
        assert.equal(eventsReceived[0]!.event, 'pane.output_matched');
        assert.ok(eventsReceived[0]!.data.matched_line.includes('echo testGHI'));
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

    it('subscribe stream ends when underlying socket closes mid-stream', async () => {
      const subStartedFixture = fixture('events-subscribe-subscription-started.json');
      const socketPath = join(tmpdir(), `herdr-test-sub-close-${Date.now()}.sock`);

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
            const req = JSON.parse(trimmed) as { id: string; method: string };
            if (req.method === 'events.subscribe') {
              const started = JSON.parse(subStartedFixture) as { id: string };
              started.id = req.id;
              sock.write(JSON.stringify(started) + '\n');
              // Close socket after ack — simulates server-side close
              setTimeout(() => sock.destroy(), 30);
            }
          }
        });
      });

      await new Promise<void>((resolve, reject) => {
        server.listen(socketPath, () => resolve());
        server.once('error', reject);
      });

      const connectFn: ConnectFn = () => connect(socketPath);
      const client = new HerdrClient({ connectFn });

      const ac = new AbortController();
      try {
        const raceResult = await Promise.race([
          (async () => {
            for await (const _ev of client.subscribe([{ type: 'pane.agent_status_changed' }], ac.signal)) {
              // no events expected before close
            }
            return 'ended';
          })(),
          new Promise<string>((r) => setTimeout(() => r('timeout'), 500)),
        ]);

        assert.equal(raceResult, 'ended', 'subscribe generator must end when socket closes, not hang');
      } finally {
        ac.abort();
        client.destroy();
        await new Promise<void>((res) => server.close(() => res()));
        await unlink(socketPath).catch(() => {});
      }
    });

    it('subscribe + concurrent RPC: each uses independent socket, no conflict', async () => {
      const subStartedFixture = fixture('events-subscribe-subscription-started.json');
      const agentListFixture = fixture('agent.list.json');
      const statusFixture = fixture('event.pane.agent_status_changed.json');
      const statusLines = statusFixture.split('\n').filter((l) => l.trim());

      const { connectFn, close } = await bindFake('sub-rpc-concurrent', {
        handler: (line, sock) => {
          const req = JSON.parse(line) as { id: string; method: string };
          if (req.method === 'events.subscribe') {
            const started = JSON.parse(subStartedFixture) as { id: string };
            started.id = req.id;
            // Push events after short delay
            setTimeout(() => {
              for (const evLine of statusLines) {
                sock.write(evLine + '\n');
              }
            }, 20);
            return [JSON.stringify(started)];
          }
          if (req.method === 'agent.list') {
            const resp = JSON.parse(agentListFixture) as { id: string };
            resp.id = req.id;
            return [JSON.stringify(resp)];
          }
          return [];
        },
      });

      const client = new HerdrClient({ connectFn });
      try {
        const ac = new AbortController();
        const collected: string[] = [];

        // Start subscribe stream
        const genPromise = (async () => {
          for await (const ev of client.subscribeAgentStatus('wH:p1', ac.signal)) {
            collected.push(ev.data.agent_status);
            if (collected.length === 2) ac.abort();
          }
        })();

        // Concurrently fire an RPC while subscribe is running
        const agents = await client.agentList();
        assert.ok(Array.isArray(agents), 'RPC must succeed while subscribe is running');

        await genPromise;
        assert.deepEqual(collected, ['working', 'done']);
      } finally {
        client.destroy();
        await close();
      }
    });

    it('destroy: aborts active subscribe streams', async () => {
      const subStartedFixture = fixture('events-subscribe-subscription-started.json');

      const { connectFn, close } = await bindFake('sub-destroy', {
        handler: (line) => {
          const req = JSON.parse(line) as { id: string; method: string };
          if (req.method === 'events.subscribe') {
            const started = JSON.parse(subStartedFixture) as { id: string };
            started.id = req.id;
            return [JSON.stringify(started)];
            // Never push events — stream stays open until destroyed
          }
          return [];
        },
      });

      const client = new HerdrClient({ connectFn });
      try {
        const raceResult = await Promise.race([
          (async () => {
            for await (const _ev of client.subscribe([{ type: 'pane.agent_status_changed' }])) {
              // no events expected
            }
            return 'ended';
          })(),
          new Promise<void>((r) => setTimeout(r, 30)).then(() => {
            client.destroy();
            return new Promise<string>((r) => setTimeout(() => r('timeout'), 300));
          }),
        ]);

        assert.equal(raceResult, 'ended', 'subscribe must end after destroy()');
      } finally {
        await close();
      }
    });
  });
});
