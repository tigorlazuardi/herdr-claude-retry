# Ralph State — herdr-port/001-daemon

- **status:** `planning`
- **orchestrator_model:** `sonnet`
- **base-branch:** `main`
- **integration-branch:** `ralph/001-daemon`
- **verify-command:** `npm run verify` (typecheck + node --test + build; exists after T1 — see PROMPT pre-flight baseline exception)
- **install-cmd:** `npm install`
- **parallel-cap:** `4`
- **last-updated:** `2026-07-04T00:00:00Z` (iteration `0`)
- **last-progress-iteration:** `0` (no-progress guard: +3 → circuit-breaker)

## Task ledger

| task-id | batch | tier | reviewer | worktree | status | attempts | notes |
|---------|-------|------|----------|----------|--------|----------|-------|
| T0 spike-socket-api | B1 | M | sonnet | ../herdr-claude-retry-001-T0 | todo | 0 | gates T4/T5/T6 prompts |
| T1 scaffold | B1 | S | sonnet | ../herdr-claude-retry-001-T1 | todo | 0 | establishes verify baseline |
| T2 pure-modules | B2 | S | sonnet | ../herdr-claude-retry-001-T2 | todo | 0 | verbatim port |
| T3 usage-api | B2 | S | sonnet | ../herdr-claude-retry-001-T3 | todo | 0 | token never logged |
| T4 socket-client | B2 | M | sonnet | ../herdr-claude-retry-001-T4 | todo | 0 | needs T0 findings |
| T5 account-resolution | B2 | M | sonnet | ../herdr-claude-retry-001-T5 | todo | 0 | UUID→jsonl primary |
| T6 core-daemon-logic | B3 | L | opus | — | todo | 0 | hard invariants in PROMPT |
| T7 cli-logging | B4 | M | sonnet | — | todo | 0 | telemetry table in SPEC.mdx |
| T8 acceptance-packaging | B5 | M | sonnet | — | todo | 0 | e2e vs live herdr; no npm publish |

`status` ∈ `todo | doing | done | failed`.

## Progress log (heartbeat — one line per iteration)

- `iteration 0` · contract authored (FASE 2), loop not started

## Decision log (circuit-breaker)

<!-- Append one entry each time the Opus circuit-breaker is invoked. -->

## Merge-handoff summary (filled at the end)

- **Outcome:** —
- **Cost tally:** —
- **What changed:** —
- **How verified:** —
- **Follow-ups / known gaps:** —
- **To merge (human runs this):**
  ```
  git checkout main
  git merge --no-ff ralph/001-daemon
  ```
