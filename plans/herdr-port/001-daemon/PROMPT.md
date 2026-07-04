# Ralph Contract — herdr-port/001-daemon

## Orchestrator model — check FIRST, before anything else

This contract is authored for an orchestrator running as **`sonnet`** (chosen at planning; also recorded in STATE.md). Before reading tasks or spawning anything, confirm your own model matches.

Look at your model identity in system context. If it does **not** match `sonnet`, STOP immediately and output exactly this, then end the turn:

> ⛔ Wrong orchestrator model. This ralph contract requires **`sonnet`**, but you are running a different model. Switch with `/model` → Sonnet, then `/clear` (or a fresh session) and restart the loop with the same start command. This guard exists because it is easy to forget to set the model, and running the loop on the wrong one silently over-spends or under-performs.

This is an authorized early exit (like the abort protocol) — it is **not** a false finish, so do **not** emit the completion promise. Only proceed past this check when your model matches `sonnet`.

You are the **`sonnet` orchestrator** for this slice. You drive the work but you do **not** do heavy implementation yourself — you delegate to subagents and keep the ledger. Re-read this contract and `STATE.md` at the start of every iteration and act on whatever is incomplete.

**Caveman output (default).** Operate caveman-compressed: drop articles/filler/pleasantries/hedging, fragments OK, keep all technical substance — narration is the cheapest thing to cut. Tell every subagent you spawn to report caveman too. Stay normal for: code, commit messages, `STATE.md` content, the `<promise>` tag, and anything security-related.

## Completion promise (how this loop exits)

Output `<promise>RALPH SLICE FINISHED</promise>` **only** when one of these is unequivocally true:

- **Success:** every task below is `done` and reviewed, the integration branch is green (`npm run verify` passes), everything is committed, and the merge-handoff summary is written to STATE.md.
- **Abort:** an Opus circuit-breaker decision (see below) returned `ABORT`, and you have recorded the reason in STATE.md.

Both are genuine terminal states, so emitting the promise is honest in both. Never emit it to escape a hard iteration — if you're stuck but not terminal, keep working or trigger the circuit-breaker.

**Echo guard.** The literal tag `<promise>RALPH SLICE FINISHED</promise>` ends the loop the instant it appears in your output — the stop hook scans your last message for it. So **never type that tag** except as the final line of a true terminal state. Everywhere else (notes, plans, STATE.md, talking about it) call it "the promise"; do not write the tag itself. Accidentally echoing it = false finish.

## Pre-flight sanity check (first iteration only; re-verify cheaply after)

Before any task work, confirm the ground is solid. If any check fails and you cannot fix it quickly, record it in STATE.md and treat it as an abort condition.

- [ ] Repo is `/home/homeserver/projects/herdr-claude-retry`, base branch `main` checked out and clean. If `main` has no commits yet, make the initial commit (plans/ + any existing files) first.
- [ ] Required tooling present: `node --version` >= 20, `npm`, `git`, `herdr` >= 0.7 on PATH (`herdr --version`). `herdr agent list` returns JSON (server reachable).
- [ ] Reference repo readable at `/home/homeserver/projects/claude-retry` (READ-ONLY source for ported modules — never modify it).
- [ ] Integration branch `ralph/001-daemon` exists (create from `main` if not).
- [ ] **Baseline exception (greenfield):** `npm run verify` does not exist until task T1 lands. Before T1 is merged, "baseline green" means the repo is clean; from the moment T1 is merged onward, `npm run verify` on the integration branch is the truth signal and must be green after every merge.
- [ ] Assumptions still hold: herdr socket API reachable; spec at `plans/herdr-port/SPEC.mdx` present (authoritative — consult it whenever a task's intent is unclear).

## Implementation strategy

Port `claude-retry` (zellij polling watcher) to a herdr-native, event-driven daemon per `plans/herdr-port/SPEC.mdx` (authoritative spec — read it on iteration 1). Detection tiers: herdr events trigger → usage API (`https://api.anthropic.com/api/oauth/usage`) is truth for `resets_at` → on-screen text parse is fallback → inject `continue` only when the canonical banner sits in the bottom screen region. The spike (T0) gates the socket-dependent tasks: its findings doc is REQUIRED input to T4/T5/T6 prompts. Pure modules (T2/T3) are near-verbatim copies from `/home/homeserver/projects/claude-retry/src/` with their tests. Out of scope — do NOT touch: the `claude-retry` repo, zellij support, OTel export, herdr plugin packaging, actual `npm publish` (human step; only prepare package + CI). Tests and the spike may create their own herdr workspaces (name prefix `hcr-test-`) but MUST NEVER send input to any pane they did not create.

## State protocol (resume-safe)

`STATE.md` is the source of truth for progress. On every iteration: read it, find the first incomplete batch, and continue. After **each** task reaches a terminal status, update STATE.md and **commit it inside the integration branch** so a crash/power-loss/stop can resume exactly here. Never redo a task already marked `done`.

**Resume reconciliation.** A crash can leave a worktree with uncommitted WIP that STATE.md doesn't know about. On every iteration start, before trusting the ledger: `git status` each live worktree. Uncommitted changes → inspect, then commit as WIP or stash, and reconcile the task's real status with STATE.md. Don't restart a task that's actually half-done on disk.

**Heartbeat.** Each iteration, append one line to STATE.md's progress log: `iteration N · <what advanced>`. Lets a human `tail` progress and powers no-progress detection below.

## No-progress guard (stuck = stop, don't burn tokens)

Track `last-progress-iteration` in STATE.md — the last iteration a task reached `done`. If the current iteration exceeds it by **3** with no task advancing, you're spinning: trigger the Opus circuit-breaker (below) on the blocking task instead of looping further. Cheaper to ask once than spin ten times.

## Worktree model

- Integration branch for this slice: `ralph/001-daemon` (off `main`).
- **Parallel batch:** run each task in its own worktree, e.g. `git worktree add ../herdr-claude-retry-001-<task-id> ralph/001-daemon`. After review passes, merge that worktree into `ralph/001-daemon`, resolve conflicts, then `git worktree remove` it.
- **Sequential/single task:** work directly on `ralph/001-daemon`; no extra worktree needed.

Pass the **absolute worktree path** to every subagent and tell it to `cd` there first — subagents do not inherit your working directory.

**Concurrency cap: 4.** Never run more than **4** worktrees/implementers at once.

**Worktree is not a full env.** `git worktree add` skips gitignored files — no `node_modules`. After creating each worktree, before any implementer touches it, run the install command there: `npm install` (no-op before T1 lands a package.json — skip when absent). No `.env`/direnv in this project.

**Parallel isolation.** No ports or DBs in this project. The only shared resource is the live herdr server: tasks touching it (T0, T8) create their own workspaces named `hcr-test-<task-id>` and clean them up; all other tasks are pure unit-test work with no herdr contact. B2 tasks write disjoint files (see Touches) — flag any overlap instead of merging blind.

## Tasks (batches run in order; tasks within a batch run in parallel)

### Batch B1
- **T0 — spike-socket-api** · tier `M` · reviewer `sonnet` · worktree `yes`
  - Do: Hands-on verification of the herdr socket API against the live herdr 0.7.1 server. Answer, with REAL captured payloads (not docs quotes): (1) socket path + how to discover it; (2) NDJSON request/response framing and `id` correlation; (3) `events.subscribe` — event types available, exact payloads for `pane.output_matched` (can the caller register custom regexes? what syntax?), `pane.agent_status_changed`, `pane.created`/`pane.closed`; (4) `pane.read` — sources (`visible`/`recent`/`recent-unwrapped`/`detection`), ANSI handling, line limits; (5) `pane.process_info` — exact fields (PIDs); (6) `pane.send_keys` encoding for Ctrl+C and `pane run` semantics (text+Enter atomic?); (7) `agent.list`/`agent.get` schema incl. `agent_session.value` (Claude session UUID); (8) how a client identifies its own pane (env vars herdr sets). Write findings to `docs/spike-socket-api.md`; save raw captured JSON into `test/fixtures/socket/*.json`. Safety: read-only against existing panes; input-sending experiments ONLY in a self-created `hcr-test-t0` workspace with a dumb `cat`/`bash` pane; remove the workspace when done.
  - Done when: `docs/spike-socket-api.md` exists and answers all 8 questions with captured payloads; every claim is backed by a fixture file; open gaps (features that don't exist) are listed explicitly with implications + chosen workaround. No code required.
  - Touches: `docs/spike-socket-api.md`, `test/fixtures/socket/`
- **T1 — scaffold** · tier `S` · reviewer `sonnet` · worktree `yes`
  - Do: Project scaffold: `package.json` (name `@tigorhutasuhut/herdr-claude-retry`, `engines.node >= 20`, scripts `typecheck`/`test`/`build`/`verify` mirroring `/home/homeserver/projects/claude-retry/package.json`), `tsconfig.json` (copy from claude-retry), `.gitignore` (node_modules, dist), `LICENSE` (MIT, copy), `src/index.ts` stub, one placeholder test so `node --test` runs. `npm run verify` = typecheck + test + build.
  - Done when: `npm install && npm run verify` passes from a clean checkout.
  - Touches: `package.json`, `tsconfig.json`, `.gitignore`, `LICENSE`, `src/index.ts`, `test/placeholder.test.ts`

### Batch B2 (depends on B1)
- **T2 — pure-modules** · tier `S` · reviewer `sonnet` · worktree `yes`
  - Do: Port from `/home/homeserver/projects/claude-retry/src/`: `patterns.ts`, `time-parser.ts`, `format.ts` and their tests (`test/patterns.test.ts`, `test/time-parser.test.ts`, `test/format.test.ts`). Near-verbatim; keep API identical; adjust imports only.
  - Done when: `npm run verify` green with the three ported test files passing.
  - Touches: `src/patterns.ts`, `src/time-parser.ts`, `src/format.ts`, `test/{patterns,time-parser,format}.test.ts`
- **T3 — usage-api** · tier `S` · reviewer `sonnet` · worktree `yes`
  - Do: Port `usage.ts` (+ `test/usage.test.ts`): OAuth token read from `<CLAUDE_CONFIG_DIR>/.credentials.json`, `fetchUsage` against `https://api.anthropic.com/api/oauth/usage`, window keys `five_hour`/`seven_day`/`seven_day_opus`/`seven_day_sonnet`, threshold env `CLAUDE_RETRY_LIMIT_THRESHOLD` (default 90). Security invariant: the access token must never appear in any log or error message.
  - Done when: ported usage tests pass under `npm run verify`.
  - Touches: `src/usage.ts`, `test/usage.test.ts`
- **T4 — socket-client** · tier `M` · reviewer `sonnet` · worktree `yes`
  - Do: `src/herdr.ts` — herdr socket API client per T0's `docs/spike-socket-api.md` (REQUIRED reading; pass its content in the prompt): connect to the socket, NDJSON framing, request/response correlation by `id`, long-lived `events.subscribe` stream exposed as an async iterator, auto-reconnect with exponential backoff (1s→60s cap) and an `onReconnect` hook, typed wrappers for `pane.read`, `pane.send_keys`, `pane run`(-equivalent), `pane.process_info`, `agent.list`, `events.subscribe`. All I/O dependency-injected. Unit tests against an in-process fake socket server replaying `test/fixtures/socket/` captures.
  - Done when: unit tests cover request/response, subscription events, and reconnect-after-drop; `npm run verify` green.
  - Touches: `src/herdr.ts`, `test/herdr.test.ts`
- **T5 — account-resolution** · tier `M` · reviewer `sonnet` · worktree `yes`
  - Do: `src/accounts.ts` — adapt from claude-retry. Discovery of account dirs unchanged (`/proc` cmdline+environ scan, Linux-only, default `~/.claude`). Pane→account resolution NEW primary path: pane's Claude session UUID (from `agent.list` `agent_session.value`) → scan each discovered `<config_dir>/projects/*/<uuid>.jsonl` for existence → owning account. Fallback: `pane.process_info` PID → `/proc/<pid>/environ` → `CLAUDE_CONFIG_DIR`. Preserve tier order: sole account → sole limited account → bridge → null. All fs/proc access DI'd; tests with fakes (port `test/accounts.test.ts` where applicable).
  - Done when: unit tests cover UUID-scan hit, fallback path, and tier order; `npm run verify` green.
  - Touches: `src/accounts.ts`, `test/accounts.test.ts`

### Batch B3 (depends on B2)
- **T6 — core-daemon-logic** · tier `L` · reviewer `opus` · worktree `no`
  - Do: `src/monitor.ts` — port the claude-retry state machine (`stepState`, `MonitorState`, miss counter MAX_MISSES=3, API-error retry: 10s backoff, cap 5) with deps re-addressed to herdr pane ids, PLUS the new drive layer `src/daemon.ts`: (a) event loop consuming T4's subscription — `pane.output_matched`/`pane.agent_status_changed(blocked)` triggers a check of that pane; (b) reconcile sweep every 5 min AND immediately on every (re)connect — `agent.list` + screen check per Claude pane, feeding the same state machine; (c) usage API called at most once per check-round and only when ≥1 pane triggered/waiting; (d) wait scheduling at `resets_at`+margin (default 60s), live-refreshed while waiting. HARD INVARIANTS (Opus reviews against these): inject only when `isBlockedAtBanner` (canonical banner in bottom 15 non-empty lines) is true at inject time; abandon wait when banner gone; past reset time never rolls to tomorrow; API-error retries hard-capped; daemon never sends input to a pane not currently showing a qualifying banner; token never logged. Port `test/monitor.test.ts` + add tests for event trigger, sweep pickup of a pre-existing blocked pane, and reconnect-sweep.
  - Done when: all monitor + daemon tests pass under `npm run verify`; each hard invariant has at least one test asserting it.
  - Touches: `src/monitor.ts`, `src/daemon.ts`, `test/monitor.test.ts`, `test/daemon.test.ts`

### Batch B4 (depends on B3)
- **T7 — cli-logging** · tier `M` · reviewer `sonnet` · worktree `no`
  - Do: `src/cli.ts` (`herdr-claude-retry start`, flags: `--margin-seconds`, `--sweep-interval`, `--threshold`, `--debug-screens`) wiring daemon + real deps, plus `src/log.ts`: structured JSON lines to stderr `{ts, level, event, pane?, account_dir?, ...}` implementing EXACTLY the event table in `plans/herdr-port/SPEC.mdx` § Telemetry (read it): daemon.start/stop, socket.connected/disconnected/reconnecting, pane.discovered/dropped, limit.detected/confirmed, wait.scheduled/abandoned, inject.sent/failed, api_error.detected/gave_up, usage_api.error, sweep.done. Redaction contract: token never logged (Tier A); config-dir paths + pane ids visible (Tier B); screen content logged ONLY behind `--debug-screens`, banner/reset line text allowed at info (Tier D decision).
  - Done when: `npm run verify` green; a log unit test asserts event shape + that a fake token string never reaches the log sink; `bin` entry works (`node dist/cli.js --help`).
  - Touches: `src/cli.ts`, `src/log.ts`, `src/index.ts`, `test/log.test.ts`, `package.json` (bin)
### Batch B5 (depends on B4)
- **T8 — acceptance-packaging** · tier `M` · reviewer `sonnet` · worktree `no`
  - Do: (a) e2e acceptance script `test/e2e/blocked-pane.e2e.ts` (runnable via `npm run e2e`, NOT part of `verify` — needs live herdr): create workspace `hcr-test-t8`, start a pane running a small script that prints a canonical limit banner with an already-past reset time and then `cat`s stdin; run the daemon pointed at it (text-fallback path, no usage API dependency); assert the daemon logs `limit.detected` → `inject.sent` and the pane received `continue`; tear the workspace down even on failure. (b) `README.md` (install, usage, how-it-works, requirements — mirror claude-retry's README structure, herdr edition). (c) `.github/workflows/publish.yml` trusted-publishing workflow copied/adapted from claude-retry. Do NOT run `npm publish`.
  - Done when: `npm run e2e` passes against live herdr on this machine (capture output as evidence); `npm run verify` still green; README + workflow exist.
  - Touches: `test/e2e/`, `README.md`, `.github/workflows/publish.yml`, `package.json` (e2e script)

## Opus economy (call it rarely, call it complete)

Every Opus spawn — L-task review and the circuit-breaker — pays an expensive cold-context startup, and any follow-up round-trip pays it again. So:

- **Batch.** Only T6 is L-tier; review it in **one** Opus spawn when it's ready.
- **Front-load.** Put everything Opus needs in the spawn prompt — full diff, the hard-invariant list from T6's task entry, acceptance criteria, actual `npm run verify` output, and `docs/spike-socket-api.md` — so it answers in a single shot.
- **The reviewer scouts and verifies itself (nested subagents).** `ralph-reviewer` has the `Agent` tool: when an L review needs context beyond the diff it spawns `ralph-scout` (`model: haiku`) itself, and it spawns `ralph-verifier` to adversarially refute a finding before rejecting on it. That subtree never reaches you — only the verdict does. Do not pre-scout for reviews.

## Per-task execution loop

For each task in the current batch:

1. **Implement.** Spawn `ralph-implementer` with `model: sonnet`. Give it: the task, its acceptance criteria, the worktree path (if any), and the instruction to work test-first and to run `npm run verify` (or the task-scoped subset) before reporting back. For T4/T5/T6: include `docs/spike-socket-api.md` content. If resuming a handed-over task, pass the saved handover doc too (step 2).
2. **Read the implementer's `RESULT`:**
   - **`HANDOVER`** — not a failure, does **not** increment `attempts`. Save the handover block to `plans/herdr-port/001-daemon/handovers/<task-id>-<seq>.md`, then spawn a **fresh** `ralph-implementer` (`model: sonnet`) for the same task with that doc as starting context. Repeat until `PASS` or `FAIL`.
   - **`PASS` / `FAIL`** — proceed to step 3.
3. **Verify.** Run the check yourself — self-reports are not evidence. If it fails, re-run once before counting it; two consistent fails = real fail.
4. **Review.** S/M tasks: spawn `ralph-reviewer` with `model: sonnet`, give it the diff + acceptance criteria. T6 (L): single `model: opus` `ralph-reviewer` spawn per "Opus economy". Verdict per task (`PASS`/`REJECT` + reasons).
5. **Outcome.**
   - **Pass** (verification green AND reviewer `PASS`): merge the worktree into `ralph/001-daemon` (if parallel), mark the task `done`, commit, update STATE.md.
   - **Fail** (verification red OR reviewer `REJECT`): increment the task's `attempts`. `attempts < 2` → loop back to step 1 with the failure feedback. `attempts == 2` → circuit-breaker.

Handovers are about context, not correctness: a task may cycle through several implementers and still be on its **first** attempt. Only verification-red or reviewer-`REJECT` counts toward the circuit-breaker.

## Two-failure circuit-breaker (Opus decides continue vs abort)

When a task fails twice, do not keep grinding. Spawn `ralph-reviewer` with `model: opus` as a **decision-maker** in a single complete call (see "Opus economy"), giving it: the task, both failure attempts and their errors, the acceptance criteria, and the relevant diffs. Require exactly this shape:

```
DECISION: CONTINUE | ABORT
REASON: <one paragraph>
GUIDANCE: <if CONTINUE: concrete next approach. if ABORT: why this slice can't safely proceed.>
```

- **CONTINUE:** reset the task's attempts, record the guidance in STATE.md, retry with it.
- **ABORT:** record decision + reason in STATE.md, write the abort into the summary, clean up worktrees (keep `ralph/001-daemon` for inspection), then emit the promise as the final line to exit cleanly.

**Destructive-action gate:** you (Sonnet) never execute an irreversible/destructive action solo (force-push, deleting non-`hcr-test-*` herdr workspaces, rm outside the repo/worktrees) — route it through an Opus decision first. Removing `hcr-test-*` workspaces and task worktrees is routine cleanup, not destructive.

## Finishing the slice

When all batches are `done`:

1. Run `npm run verify` once more on the integration branch; it must pass.
2. Ensure everything is committed and STATE.md is up to date.
3. **Clean up worktrees.** Merge remaining reviewed child worktrees, `git worktree remove` all of them. Keep only `ralph/001-daemon`. (Same cleanup on abort.) Also confirm no `hcr-test-*` herdr workspaces remain.
4. **Cost note.** Append a one-line tally to STATE.md: iterations used, Opus calls made, tasks done.
5. Write the **merge-handoff summary** into STATE.md: what changed, how verified, follow-ups (incl. "npm publish bootstrap is manual — see claude-retry README §Publishing"), and the exact merge commands:
   `git checkout main && git merge --no-ff ralph/001-daemon`.
   Do **not** merge to `main` yourself — that is the human approval gate.
6. **Push + offer PR (offer, never auto-create).** If a remote `origin` exists, push: `git push -u origin "$(git branch --show-current)"` (never force, never push `main`). No remote configured (likely — fresh repo) → skip, note it in the summary.
7. Emit the promise as the final line: `<promise>RALPH SLICE FINISHED</promise>`.
