/**
 * cli.ts — CLI entry point for herdr-claude-retry daemon.
 *
 * Usage:
 *   herdr-claude-retry start [options]
 *     --socket-path <path>    override HERDR_SOCKET_PATH env
 *     --margin-seconds <n>    default 60
 *     --sweep-interval <n>    default 300 (seconds)
 *     --log-level <level>     debug|info|warn|error; default info
 *     --debug-screens         include screen content in limit.detected (unsafe)
 *     --help                  print usage and exit 0
 */

import { parseArgs } from 'node:util';
import { HerdrClient } from './herdr.ts';
import { runDaemon } from './daemon.ts';
import { makeLogger } from './log.ts';
import { VERSION } from './index.ts';

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

const HELP = `
herdr-claude-retry v${VERSION}

Usage:
  herdr-claude-retry start [options]

Options:
  --socket-path <path>    Unix socket path (default: HERDR_SOCKET_PATH env or
                          $HOME/.config/herdr/herdr.sock)
  --margin-seconds <n>    Extra seconds after rate-limit resets before injecting
                          (default: 60)
  --sweep-interval <n>    Reconcile sweep interval in seconds (default: 300)
  --log-level <level>     Minimum log level: debug|info|warn|error (default: info)
  --debug-screens         Include pane screen content in limit.detected log events.
                          WARNING: may log user conversation content. Do not use
                          in production or shared environments.
  --help                  Print this help and exit

Environment:
  HERDR_SOCKET_PATH       Default socket path if --socket-path not given
`.trim();

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Strip argv[0] (node) and argv[1] (script); grab subcommand if present
  const rawArgs = process.argv.slice(2);

  // Handle top-level --help before parseArgs (so it works without a subcommand)
  if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
    process.stdout.write(HELP + '\n');
    process.exit(0);
  }

  // Require 'start' subcommand
  const [subcommand, ...rest] = rawArgs;
  if (subcommand !== 'start') {
    process.stderr.write(`error: unknown command '${subcommand ?? ''}'. Use 'start'.\n\n${HELP}\n`);
    process.exit(1);
  }

  // Parse options
  const { values } = parseArgs({
    args: rest,
    options: {
      'socket-path': { type: 'string' },
      'margin-seconds': { type: 'string' },
      'sweep-interval': { type: 'string' },
      'log-level': { type: 'string' },
      'debug-screens': { type: 'boolean' },
      'help': { type: 'boolean' },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values['help']) {
    process.stdout.write(HELP + '\n');
    process.exit(0);
  }

  // Resolve log level
  const rawLevel = values['log-level'] ?? 'info';
  const validLevels = ['debug', 'info', 'warn', 'error'] as const;
  type Level = typeof validLevels[number];
  if (!validLevels.includes(rawLevel as Level)) {
    process.stderr.write(`error: invalid --log-level '${rawLevel}'. Must be one of: ${validLevels.join(', ')}\n`);
    process.exit(1);
  }
  const logLevel = rawLevel as Level;
  const debugScreens = values['debug-screens'] ?? false;

  // Construct logger
  const logFn = makeLogger({ level: logLevel, debugScreens });

  // Resolve socket path
  const socketPath =
    values['socket-path'] ??
    process.env['HERDR_SOCKET_PATH'] ??
    `${process.env['HOME']}/.config/herdr/herdr.sock`;

  // Parse numeric options
  const marginSeconds = values['margin-seconds'] !== undefined
    ? parseInt(values['margin-seconds'], 10)
    : 60;
  const sweepIntervalSeconds = values['sweep-interval'] !== undefined
    ? parseInt(values['sweep-interval'], 10)
    : 300;

  if (isNaN(marginSeconds) || marginSeconds < 0) {
    process.stderr.write(`error: invalid --margin-seconds '${values['margin-seconds']}'\n`);
    process.exit(1);
  }
  if (isNaN(sweepIntervalSeconds) || sweepIntervalSeconds < 1) {
    process.stderr.write(`error: invalid --sweep-interval '${values['sweep-interval']}'\n`);
    process.exit(1);
  }

  // Signal handling
  const ac = new AbortController();
  process.on('SIGINT', () => ac.abort());
  process.on('SIGTERM', () => ac.abort());

  // Construct clients (separate sockets: one for RPC, one for event subscription)
  const client = new HerdrClient({ socketPath });
  const subscribeClient = new HerdrClient({ socketPath });

  // Wire reconnect log events
  client.onReconnect = () => {
    logFn({ event: 'socket.connected' });
  };
  subscribeClient.onReconnect = () => {
    logFn({ event: 'socket.connected', role: 'subscribe' });
  };

  // Connect
  logFn({ event: 'daemon.start', version: VERSION, socket_path: socketPath });

  try {
    await client.connect();
    logFn({ event: 'socket.connected' });
  } catch (err) {
    logFn({ level: 'error', event: 'socket.dead' });
    process.stderr.write(`fatal: could not connect to ${socketPath}: ${err}\n`);
    process.exit(1);
  }

  try {
    await subscribeClient.connect();
    logFn({ event: 'socket.connected', role: 'subscribe' });
  } catch (err) {
    logFn({ level: 'error', event: 'socket.dead', role: 'subscribe' });
    client.destroy();
    process.stderr.write(`fatal: could not connect subscribe socket to ${socketPath}: ${err}\n`);
    process.exit(1);
  }

  // Run daemon — map daemon's string logger to structured events
  try {
    await runDaemon({
      client,
      subscribeClient,
      marginSeconds,
      sweepIntervalMs: sweepIntervalSeconds * 1000,
      signal: ac.signal,
      log: (msg: string) => logFn({ event: 'daemon.internal', msg }),
    });
  } finally {
    client.destroy();
    subscribeClient.destroy();
    logFn({ event: 'daemon.stop', reason: ac.signal.aborted ? 'signal' : 'exit' });
  }
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err}\n`);
  process.exit(1);
});
