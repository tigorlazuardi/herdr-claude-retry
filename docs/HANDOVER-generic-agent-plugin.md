# Handover — Generalizing herdr-claude-retry into a herdr plugin for all agents

**Date:** 2026-07-09
**From:** herdr-claude-retry (this repo, v0.1.8, npm `@tigorhutasuhut/herdr-claude-retry`)
**To:** **herdr-sheepdog** (repo `tigorlazuardi/herdr-sheepdog`) — a herdr *plugin* (not a
standalone npm daemon) that auto-resumes **any** herdr-supported agent after a rate limit /
transient failure, not just Claude Code. Tagline: "the sheepdog that keeps your herd moving."
(Name rationale: watchdog only guards + alarms and is overloaded by kernel/systemd/hardware
watchdogs; a sheepdog actively drives strays back to the herd — which is what the inject does.
`herdr-` prefix keeps project scope and target audience visible.)

---

## 1. Why a new project

Scope changes on two axes at once:

1. **Distribution model** — standalone socket-client daemon → herdr plugin
   (`herdr-plugin.toml` manifest, installed via `herdr plugin install`, lifecycle owned by herdr).
2. **Agent coverage** — Claude Code only → all agents herdr detects: Pi, OMP, GitHub Copilot CLI,
   Devin CLI, Kimi Code CLI, Hermes Agent, Qoder CLI, Droid, OpenCode, Kilo Code CLI, MastraCode,
   Claude Code, Codex, Cursor Agent CLI, Amp, Grok CLI, Antigravity CLI, Kiro CLI
   (+ Gemini CLI and Cline, detected but less tested).

The current codebase (~2,000 LOC TypeScript, Node ≥20) is the reference implementation and test
bed. Do not fork it wholesale — extract the agent-agnostic core, rewrite the Claude-specific
parts as the first *adapter*.

## 2. What exists today (module map)

| Module | LOC | Generic? | Notes |
|---|---|---|---|
| `src/herdr.ts` | 555 | ✅ yes | NDJSON socket client, subscribe stream, inject sequence. Reusable nearly as-is. |
| `src/daemon.ts` | 383 | ✅ mostly | Event loop + reconcile sweep + pane lifecycle. Agent-agnostic except it assumes one detection strategy. |
| `src/monitor.ts` | 215 | ✅ mostly | Per-pane state machine (MONITORING → WAITING → inject). The *transitions* are generic; the *predicates* (banner detected? reset time?) are Claude-specific inputs. |
| `src/patterns.ts` | 125 | ❌ Claude | Rate-limit banner regexes, strict/canonical banner match, bottom-region ("parked at input box") heuristic, `API Error:` transient match. |
| `src/time-parser.ts` | 183 | ❌ Claude | Parses reset time out of Claude's banner text ("resets at 3am", "try again at…"). |
| `src/usage.ts` | 122 | ❌ Anthropic | Anthropic usage API — exact `resets_at`. Other providers have no equivalent; treat as an *optional adapter capability*. |
| `src/accounts.ts` | 208 | ❌ Claude+Linux | Resolves `CLAUDE_CONFIG_DIR` via `/proc/<pid>/environ`, session-UUID → config-dir scan, `~/.claude` fallback. Linux-only. |
| `src/cli.ts`, `log.ts`, `format.ts`, `index.ts` | ~370 | ✅ yes | CLI flags, JSON-lines logger, version-from-package.json. |

**Architecture (keep it):** two concurrent loops —
- **Event loop**: subscribe `pane.output_matched` (regex pushed to herdr) + `pane.agent_status_changed`
  on every known pane; `pane.created` picks up new panes.
- **Reconcile sweep**: on startup + every 5 min, `agent.list` → prune dead panes, check **all**
  live panes (including WAITING ones — see pain point #4).

**Inject sequence (v0.1.8, hard-won):** `Ctrl+C` → 150ms pause → `pane.send_text("continue")`
(NO trailing newline) → 150ms pause → `pane.send_keys(["Enter"])`.

## 3. herdr facts you need (verified against herdr 0.7.1)

Full spike findings with captured fixtures: `docs/spike-socket-api.md` + `test/fixtures/socket/`.

- **Socket**: UNIX socket at `$HERDR_SOCKET_PATH` (injected into every managed pane), fallback
  `~/.config/herdr/herdr.sock`. NDJSON request/response, `id` correlation.
- **RPC connections are one-shot** — herdr closes the connection after a response. Use
  ephemeral-per-call sockets for RPC and ONE dedicated long-lived connection for
  `events.subscribe`. (This was a breaking discovery mid-project; the client was refactored
  around it.)
- **Event envelope ≠ response envelope**: events are `{"event": "...", "data": {...}}` — no
  `id`/`result` wrapper. Malformed requests get `id: ""` in the error response.
- **Env injected into panes**: `HERDR_PANE_ID`, `HERDR_TAB_ID`, `HERDR_WORKSPACE_ID`,
  `HERDR_ENV=1`, `HERDR_SOCKET_PATH`. The daemon must exclude its own pane (`HERDR_PANE_ID`).
- **Agent detection is herdr's job**: `pane.agent_status_changed` carries
  `{agent: "claude", agent_status: "working" | "idle" | "blocked", pane_id, workspace_id}`.
  The `agent` field is the natural adapter-routing key — the plugin does NOT need to detect
  which agent is running.
- **Agent statuses**: idle / working / blocked. `blocked` = needs user input — but it does NOT
  distinguish "rate-limited" from "waiting for permission approval". Screen-text analysis is
  still required to tell those apart. Status rolls up to tab/workspace level.
- **Plugin system** (https://herdr.dev/docs/plugins/): manifest `herdr-plugin.toml` (metadata,
  platforms, build commands, entrypoints); any language; install = GitHub clone + build +
  register; `herdr plugin link` for local dev. Plugin gets `HERDR_PLUGIN_CONFIG_DIR` (user
  config) and `HERDR_PLUGIN_STATE_DIR` (runtime state) — **no storage API**, plugin owns file
  formats. API surface: actions (keybinding-invokable), event hooks, pane placement
  (overlay/split/tab/zoomed), link handlers. No runtime registration, no native UI in v1.
  Entire herdr CLI is available to plugins.

## 4. Pain points & lessons learned (the expensive ones)

Every item below cost a debugging session or a production incident. Bake them into the new
design from day one.

1. **One-shot RPC sockets** (v0.1.2, commit `e44d75b`). First client assumed one persistent
   connection for everything; herdr closes after each response. Symptom: works once, then
   silent death. Fix: ephemeral socket per RPC call, dedicated socket for the subscribe stream.

2. **`pane.created` replays on (re)subscribe** — herdr replays creation events; the daemon
   double-subscribed and reacted to panes that no longer existed. Fix: dedup + verify the pane
   is live via `agent.list` before subscribing to it.

3. **Rate-limited panes are silent** (v0.1.6 — the "missing 03:30 AM continue" incident). A
   pane parked at the limit banner produces NO output → no `output_matched` events → a purely
   event-driven design never re-checks it. The original sweep also *skipped* WAITING panes as
   "already handled", so the wait timer elapsed with nobody watching. **Rule: the reconcile
   sweep must re-check every live pane every cycle**; dedup with an `inProgress` flag, and
   re-verify the banner immediately before injecting (prevents double-inject).

4. **`send_text` with `\n` does not submit in TUI agents** (v0.1.8). Bracketed paste turns the
   trailing newline into a literal character in the input buffer — text lands in the prompt,
   never submits. Must send a real key event: `pane.send_keys(["Enter"])` (that exact string
   encoding, verified live), with ~150ms pauses between steps so the TUI processes each one.
   **Expect this to differ per agent TUI** — submit mechanics belong in the adapter.

5. **Timer hygiene both ways** (v0.1.5 + v0.1.8). `.unref()` the sweep interval or SIGINT
   hangs until the next tick. But do NOT unref the mid-inject pause timers — with no other live
   handle the process exits *between inject steps*.

6. **Version constants drift** (v0.1.7). Hardcoded `VERSION` string stayed at 0.1.0 across
   four releases. Read the version from `package.json` at runtime (`import.meta.url` to locate
   it). Plugin equivalent: single source of truth in `herdr-plugin.toml`.

7. **npm packaging gotchas** (v0.1.1–v0.1.4): shebang `#!/usr/bin/env node` required on the
   built entry (esbuild/tsc won't add it); `bin` name must match docs; `repository` field
   required for npm provenance; OIDC trusted publishing needs npm ≥11.5.1 in CI; registry
   propagation lags GitHub Actions success by minutes — poll before `npm i -g` in deploy
   scripts. *Mostly moot for a plugin (GitHub clone + build), but keep if npm distribution
   stays as a secondary channel.*

8. **False-positive control on banner detection.** Loose patterns (`rate limit`, `usage limit`)
   fire on ordinary conversation text in scrollback. Two-tier defense that worked: (a) strict
   canonical banner phrasings, (b) `bottomRegion()` check — banner must sit in the last ~15
   non-empty lines, i.e. the agent is *parked* at it above its input box, not merely discussing
   limits. Both tiers are per-agent adapter data.

9. **Usage-API is a luxury, not a foundation.** Anthropic's usage API gives exact `resets_at`;
   no other provider is guaranteed to have one. The design already degrades: API LIMITED →
   exact wait; API unknown/down → parse reset time from banner text; unparseable → margin-based
   retry. Generalize this as an optional adapter capability (`getUsage?()`), with text-parse
   fallback as the universal baseline.

10. **Credential/config resolution is OS- and agent-specific** (`accounts.ts`): reading
    `/proc/<pid>/environ` is Linux-only; multi-account setups (`CLAUDE_CONFIG_DIR` per shell)
    break naive `~/.claude` assumptions. Keep this entire concern inside the Claude adapter;
    do not let it leak into core.

11. **Transient API errors deserve the same machinery.** Claude prints `API Error: <msg>` and
    parks; a bare `continue` resumes. Matching required the colon to stay off prose. Other
    agents will have their own transient-failure banners — model "resumable failure" as a
    first-class adapter-detected condition, not a Claude special case.

12. **Known refactoring debt in this repo** (obs #2542): some duplication / multiple
    sources-of-truth between daemon and monitor state. The port is the chance to fix it — one
    owner for per-pane state.

## 5. Proposed shape for the new project

Core (agent-agnostic):
- herdr socket client (lift from `herdr.ts`)
- pane registry + event loop + reconcile sweep (lift from `daemon.ts`, fix debt #12)
- per-pane state machine MONITORING/WAITING/INJECTING (lift transitions from `monitor.ts`)
- logger, config, plugin manifest plumbing

Adapter interface (per agent, routed by the `agent` field herdr already provides):

```ts
interface AgentAdapter {
  id: string;                                  // matches herdr's agent identifier, e.g. "claude"
  looseMatch(screen: string): MatchResult;     // cheap candidate detection (also feeds output_matched regexes)
  isParkedAtBanner(screen: string): boolean;   // strict + bottom-region check
  parseResetTime(bannerText: string, now: Date): Date | null;
  detectResumableError?(screen: string): boolean;   // e.g. Claude's "API Error:"
  getUsage?(paneCtx: PaneContext): Promise<UsageInfo | null>;  // optional exact reset (Anthropic-style)
  resumeSequence(pane: PaneHandle): Promise<void>;   // Ctrl+C / text / submit-key mechanics per TUI
}
```

Plugin packaging:
- `herdr-plugin.toml` with entrypoint = the daemon; runs in a herdr-managed pane (self-excluded).
- Config → `HERDR_PLUGIN_CONFIG_DIR` (margin seconds, sweep interval, per-agent enable/disable,
  log level). Runtime state → `HERDR_PLUGIN_STATE_DIR` (own format; nothing provided).
- Optional actions/keybindings: "check now", "pause/resume watching", status pane.

Suggested first milestones:
1. Spike: plugin manifest + `herdr plugin link` dev loop; daemon boots inside plugin lifecycle.
2. Port core + Claude adapter; parity with v0.1.8 (existing 168-test suite + fixtures as the bar).
3. Second adapter (pick one the user actually runs — Codex or OpenCode) to pressure-test the
   interface before adding the rest.
4. Adapters for remaining agents, driven by captured screen fixtures per agent.

## 6. Open questions for planning

- Does herdr's plugin **event hook** system replace the raw `events.subscribe` socket stream,
  or does the plugin still hold its own subscribe connection? (Docs suggest hooks exist;
  capability unverified — re-spike against current herdr version.)
- Is `agent_status = blocked` reliable enough to *trigger* checks (cheaper than regex
  subscriptions), with screen analysis only for classification?
- Rate-limit banner texts for non-Claude agents — need captured fixtures per agent before
  writing patterns. Which agents does the user actually run?
- Language: staying TypeScript/Node is the path of least resistance (all code reusable);
  plugin system is language-agnostic if there's a reason to switch.

## 7. Reference material in this repo

- `docs/spike-socket-api.md` — verified socket API behavior + fixture pointers
- `test/fixtures/socket/` — captured NDJSON exchanges
- `test/` — 168 tests; the daemon/monitor tests encode the sweep/waiting/inject semantics
- `plans/herdr-port/001-daemon/` + `SPEC.mdx` — original design docs for this daemon
- git log v0.1.1 → v0.1.8 — each fix commit message documents one pain point in detail
