const CSI_REGEX = /\x1b\[[\x20-\x3f]*[\x40-\x7e]/g;
const OSC_REGEX = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;
const DCS_REGEX = /\x1bP[\s\S]*?(?:\x07|\x1b\\)/g;
const OTHER_ESC_REGEX = /\x1b[_X^][\s\S]*?(?:\x07|\x1b\\)/g;

export function stripAnsi(text: string): string {
  return text
    .replace(CSI_REGEX, '')
    .replace(OSC_REGEX, '')
    .replace(DCS_REGEX, '')
    .replace(OTHER_ESC_REGEX, '');
}

const LIMIT_PATTERNS: RegExp[] = [
  /claude\.ai\/settings/i,
  /usage limit/i,
  /session limit/i,
  /rate.?limit/i,
  /\blimit\b.*\breached\b/i,
  /\breached\b.*\blimit\b/i,
  /\bhit\b.*\blimit\b/i,
  /\blimit\b.*\bexceeded\b/i,
];

const RESET_PATTERNS: RegExp[] = [
  /reset/i,
  /try again/i,
  /available/i,
];

const WINDOW = 6;

export interface MatchResult {
  limited: boolean;
  resetLine: string | null;
}

export function match(text: string): MatchResult {
  const stripped = stripAnsi(text);
  const lines = stripped.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isLimitLine = LIMIT_PATTERNS.some((p) => p.test(line));
    if (!isLimitLine) continue;

    // Search nearby lines (within WINDOW) for a reset line
    const start = Math.max(0, i - WINDOW);
    const end = Math.min(lines.length - 1, i + WINDOW);
    for (let j = start; j <= end; j++) {
      const nearby = lines[j];
      if (RESET_PATTERNS.some((p) => p.test(nearby))) {
        return { limited: true, resetLine: nearby.trim() };
      }
    }

    // No reset line found nearby — return the limit line itself
    return { limited: true, resetLine: line.trim() };
  }

  return { limited: false, resetLine: null };
}

// Canonical Claude rate-limit banner phrasings — specific enough not to fire on
// normal code/output. Used for high-confidence detection.
const STRICT_PATTERNS: RegExp[] = [
  /you(?:'ve|'ve|'ve|\s+have)\s+hit\s+your\s+(?:usage|session)\s+limit/i,
  /\d+-hour\s+limit\s+reached/i,
  /usage\s+limit\s+reached/i,
  /session\s+limit\b.*\bresets/i,
  /upgrade\s+to\s+increase\s+your\s+usage\s+limit/i,
];

export function strictMatch(text: string): boolean {
  const stripped = stripAnsi(text);
  return STRICT_PATTERNS.some((p) => p.test(stripped));
}

// Join the last `bottomLines` non-empty lines of the screen — the region where
// claude parks a banner right above its input box. Trailing blank lines ignored.
function bottomRegion(text: string, bottomLines: number): string {
  const stripped = stripAnsi(text);
  const lines = stripped.split('\n');

  let end = lines.length - 1;
  while (end >= 0 && lines[end].trim() === '') {
    end--;
  }

  const nonEmpty: string[] = [];
  for (let i = end; i >= 0 && nonEmpty.length < bottomLines; i--) {
    if (lines[i].trim() !== '') {
      nonEmpty.unshift(lines[i]);
    }
  }

  return nonEmpty.join('\n');
}

// True when a canonical banner sits in the bottom region of the screen — i.e.
// claude is parked at the limit message right above its input box, not merely
// displaying banner text somewhere in scrollback/discussion.
export function isBlockedAtBanner(text: string, bottomLines = 15): boolean {
  return strictMatch(bottomRegion(text, bottomLines));
}

// Transient API errors claude prints when a response is interrupted (connection
// dropped, timeout, overload, etc). Claude Code renders these as "API Error: <msg>".
// A bare 'continue' resumes the interrupted turn. Matching the colon keeps this
// off normal prose that merely says "api error".
const API_ERROR_PATTERNS: RegExp[] = [
  /\bAPI Error:/i,
];

export function apiErrorMatch(text: string): boolean {
  const stripped = stripAnsi(text);
  return API_ERROR_PATTERNS.some((p) => p.test(stripped));
}

// True when an "API Error:" banner sits in the bottom region — claude has
// stopped mid-response and is parked at the input box, not merely showing the
// phrase somewhere in scrollback.
export function isApiErrorAtBottom(text: string, bottomLines = 15): boolean {
  return apiErrorMatch(bottomRegion(text, bottomLines));
}
