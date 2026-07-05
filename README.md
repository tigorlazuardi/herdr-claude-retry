# herdr-claude-retry

Watches Claude CLI panes running inside [herdr](https://herdr.dev/). When a pane hits Anthropic's
usage/session limit, it detects the on-screen rate-limit banner, cross-checks against Anthropic's
usage API to get the exact reset time, and injects `continue` automatically once the limit clears.
Zero polling — event-driven via herdr's socket API.

## Requirements

- Node.js >= 20
- herdr >= 0.7 (provides the UNIX socket API and `HERDR_SOCKET_PATH` env var)
- Claude Code running inside a herdr-managed pane
- A logged-in Claude Code installation with `<CLAUDE_CONFIG_DIR>/.credentials.json` (for usage-API
  detection; without it the daemon degrades gracefully to on-screen text parsing)

## Install

```bash
npm install -g @tigorhutasuhut/herdr-claude-retry
```

The installed command is `herdr`.

## Usage

Run as a foreground daemon in its own herdr pane (the daemon excludes its own pane from monitoring):

```bash
herdr start
```

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `--socket <path>` | `$HERDR_SOCKET_PATH` or `~/.config/herdr/herdr.sock` | herdr socket path |
| `--margin-seconds <n>` | `60` | Extra seconds to wait after reset time before injecting |
| `--sweep-interval-ms <n>` | `300000` | Reconcile sweep interval (ms) |

### What it watches

Every pane herdr knows about — current and future. New panes are picked up automatically via
herdr's `pane.created` event subscription. The daemon skips its own pane.

## How it works

The daemon runs two concurrent loops:

1. **Event loop** — subscribes to `pane.output_matched` (regex: rate-limit phrases) and
   `pane.agent_status_changed` on all known panes. When herdr fires a match, the pane is
   immediately checked.

2. **Reconcile sweep** — runs on startup and every `--sweep-interval-ms`. Walks all live panes
   via `agent.list`, prunes gone panes, checks any not already in an active state. Catches panes
   the event loop might miss (reconnects, races).

**Per-pane state machine:**

- **MONITORING** — no banner, idle. On banner detected:
  - Account **LIMITED** via usage API → enter WAITING until `resets_at`.
  - Account **CLEARED** or **UNKNOWN** (API down) → parse reset from on-screen text:
    - Future reset → enter WAITING.
    - Already-past reset + canonical banner at screen bottom → inject `continue` immediately
      (text-fallback path).
- **WAITING** — banner gone (pane exited/user resumed) → drop back to MONITORING. Account
  cleared or timer elapsed → inject `continue`.

**Inject sequence:** `Ctrl+C` (clears partial input) → `continue` + Enter via `pane.send_text`.

**Account resolution (Linux):** reads `CLAUDE_CONFIG_DIR` from the Claude process's `/proc`
environment, falls back to session UUID → config dir scan, then default `~/.claude`. On non-Linux
or when resolution fails, usage=null → text-fallback path.

## Development

```bash
npm install
npm run typecheck      # tsc --noEmit
npm test               # node --test (unit tests, no live herdr needed)
npm run build          # tsc -> dist/
npm run verify         # typecheck + test + build (publish gate)
npm run e2e            # acceptance test — needs live herdr
```

The e2e test (`test/e2e/blocked-pane.e2e.ts`) verifies live connectivity to the herdr socket:
connects, lists agents, reads all live panes (the core one-shot protocol fix), and runs a daemon
reconcile sweep asserting zero paneRead failures. Skips gracefully if no herdr socket is found.

## Publishing

Releases are published to npm by GitHub Actions
([.github/workflows/publish.yml](.github/workflows/publish.yml)) on `push` to a `v*` tag.
Auth uses npm [Trusted Publishing](https://docs.npmjs.com/trusted-publishers) (OIDC) — no
`NPM_TOKEN` secret — and [provenance](https://docs.npmjs.com/generating-provenance-statements)
is attached automatically.

> `npm publish` is a manual human step — the workflow runs on a tagged release you create.

### One-time setup

1. **Bootstrap the package** (trusted publishing can only be configured on an existing package).
   Publish `0.1.0` once from your machine:
   ```bash
   npm login
   npm run verify
   npm publish --provenance=false
   ```
   `--provenance=false` is required for local bootstrap: provenance requires OIDC from CI.
2. **Configure trusted publisher** on npmjs.com: package → **Settings → Trusted Publisher →
   GitHub Actions**:
   - Organization or user: `tigorhutasuhut`
   - Repository: `herdr-claude-retry`
   - Workflow filename: `publish.yml`

### Cutting a release

```bash
npm version patch        # bump version + create git tag
git push --follow-tags
# workflow triggers on the v* tag push
```

The workflow runs `npm ci` → `npm run verify` → `npm publish --provenance`. `prepublishOnly`
gates the publish on a clean typecheck, test, and build.
