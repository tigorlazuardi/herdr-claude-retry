/**
 * herdr-claude-retry — daemon that monitors Claude CLI sessions
 * and auto-retries on rate-limit and errors.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Resolved from package.json at runtime so `npm version` bumps can never
// drift from what the daemon reports. Works from both src/ and dist/
// (package.json sits one level up from either).
const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');

export const VERSION: string = (
  JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }
).version;
