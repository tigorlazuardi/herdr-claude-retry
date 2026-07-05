/**
 * log.ts — structured JSON-lines logger.
 *
 * Emits one JSON object per line to process.stderr.
 * Sensitive-data rules:
 *   Tier A: tokens NEVER logged (enforced by callers — this module has no token access).
 *   Tier B: account_dir, pane/workspace/session ids — visible by default.
 *   Tier C: pane screen content — NOT logged.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LogRecord {
  ts: string;           // ISO 8601 UTC
  level: 'debug' | 'info' | 'warn' | 'error';
  event: string;        // dot-separated slug
  pane?: string;        // pane_id when relevant
  account_dir?: string; // CLAUDE_CONFIG_DIR path — Tier B (visible)
  [key: string]: unknown;
}

export type LogFn = (
  record: Omit<LogRecord, 'ts' | 'level'> & { level?: LogRecord['level'] },
) => void;

// ---------------------------------------------------------------------------
// Level ordering
// ---------------------------------------------------------------------------

const LEVELS: Record<LogRecord['level'], number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// ---------------------------------------------------------------------------
// makeLogger
// ---------------------------------------------------------------------------

export function makeLogger(opts?: {
  /** Minimum level to emit. Default 'info'. */
  level?: LogRecord['level'];
}): LogFn {
  const minLevel = opts?.level ?? 'info';
  const minLevelNum = LEVELS[minLevel];

  return function logFn(record) {
    const level: LogRecord['level'] = record.level ?? 'info';
    if (LEVELS[level] < minLevelNum) return;

    const entry = {
      ts: new Date().toISOString(),
      ...record,
      level,
    } as LogRecord;

    process.stderr.write(JSON.stringify(entry) + '\n');
  };
}
