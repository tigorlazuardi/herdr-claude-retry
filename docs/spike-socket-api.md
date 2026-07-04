# herdr Socket API Spike — Findings

Verified against herdr 0.7.1 on 2026-07-05. All claims backed by captured fixtures in `test/fixtures/socket/`.

## 1. Socket path + discovery

**Path:** `/home/homeserver/.config/herdr/herdr.sock` (UNIX domain socket).

**Discovery (preferred):** herdr injects `HERDR_SOCKET_PATH` into every managed pane's environment. Read it at startup:

```typescript
const socketPath = process.env.HERDR_SOCKET_PATH;
// fallback: `${process.env.HOME}/.config/herdr/herdr.sock`
```

**Other env vars herdr injects:**
- `HERDR_PANE_ID` — this pane's ID (answers Q8)
- `HERDR_TAB_ID` — this pane's tab
- `HERDR_WORKSPACE_ID` — this pane's workspace
- `HERDR_ENV=1` — sentinel: running inside herdr
- `HERDR_SOCKET_PATH` — socket path (authoritative)

Fixture: `agent-list.json` (sent via `socat - UNIX-CONNECT:$HERDR_SOCKET_PATH`).

## 2. NDJSON request/response framing + `id` correlation

**Request:** one JSON object per line, newline-terminated.
```json
{"id": "req-1", "method": "agent.list", "params": {}}
```

**Response:** one JSON object per line.
```json
{"id": "req-1", "result": {"type": "agent_list", "agents": [...]}}
```

**Error response:** `id` is `""` (empty string, not the request id) when the request is malformed before id is parsed; otherwise echoes the request id.
```json
{"id": "", "error": {"code": "invalid_request", "message": "..."}}
```

**Event stream:** after `events.subscribe`, events arrive as additional NDJSON lines on the same connection, also with `id: ""`:
```json
{"id": "", "result": {"type": "pane_agent_status_changed", ...}}
```

Connection is long-lived for subscriptions. For one-shot requests, the connection can be closed after the response.

Fixture: `agent-list.json`, `agent-get.json`.

## 3. `events.subscribe` — event types, payloads, custom regexes

**Request format:**
```json
{
  "id": "sub-1",
  "method": "events.subscribe",
  "params": {
    "subscriptions": [
      {"type": "pane.agent_status_changed", "pane_id": "wF:p2"},
      {"type": "pane.created"},
      {"type": "pane.closed"}
    ]
  }
}
```

**Response:** `{"id": "sub-1", "result": {"type": "subscription_started"}}`

**All available event types** (from error payload enumeration):
`workspace.created`, `workspace.updated`, `workspace.renamed`, `workspace.closed`, `workspace.focused`,
`worktree.created`, `worktree.opened`, `worktree.removed`,
`tab.created`, `tab.closed`, `tab.focused`, `tab.renamed`,
`pane.created`, `pane.closed`, `pane.focused`, `pane.moved`, `pane.exited`,
`pane.agent_detected`, **`pane.output_matched`**, **`pane.agent_status_changed`**

**`pane.output_matched` subscription — custom regexes ARE supported:**
```json
{
  "type": "pane.output_matched",
  "pane_id": "wE:p2",
  "source": "visible",
  "match": {
    "type": "regex",
    "value": "Usage limit reached"
  }
}
```
Required fields: `pane_id`, `source` (`visible`/`recent`/`recent_unwrapped`/`detection`), `match.type` (`regex`), `match.value` (the pattern string). **Each subscription is per-pane** — no wildcard pane_id observed. Register one subscription per monitored pane.

`pane.created`/`pane.closed` do **not** require `pane_id` (subscribe globally).
`pane.agent_status_changed` requires `pane_id`.

**Expected event payload shape** (not captured live; inferred from type name + agent_list fields):
```json
{"id": "", "result": {"type": "pane_agent_status_changed", "pane_id": "wE:p2", "agent_status": "blocked", ...}}
```
**GAP:** Live `pane.agent_status_changed` and `pane.output_matched` event payloads not captured (no status change occurred during spike window). Implication: client must be tolerant of unknown fields. Workaround: subscribe and log first real event; unit tests use fixtures replaying the shape above.

Fixture: `events-subscribe-subscription-started.json`.

## 4. `pane.read` — sources, ANSI handling, line limits

**Request:**
```json
{"id": "r1", "method": "pane.read", "params": {"pane_id": "wF:p2", "source": "visible", "lines": 10}}
```

**Sources (correct spelling — underscore, not dash):**
| source | description |
|---|---|
| `visible` | current viewport, as rendered text |
| `recent` | recent scrollback (wrapped lines) |
| `recent_unwrapped` | recent scrollback with line-wrap joined |
| `detection` | same as `visible` in practice; intended for banner detection |

**ANSI handling:** default `format: "text"` strips ANSI escape codes. Pass `"format": "ansi"` or `"ansi": true` to retain them.

**`lines`:** optional integer, limits line count returned. Omit for full content.

**Response:**
```json
{"id": "r1", "result": {"type": "pane_read", "read": {
  "pane_id": "wF:p2", "workspace_id": "wF", "tab_id": "wF:t1",
  "source": "visible", "format": "text",
  "text": "<content>",
  "revision": 0,
  "truncated": true
}}}
```

`truncated: true` appears when `lines` limit was hit.

Fixture: `pane-read-visible.json`, `pane-read-recent-unwrapped.json`.

## 5. `pane.process_info` — exact fields

**Request:**
```json
{"id": "p1", "method": "pane.process_info", "params": {"pane_id": "wF:p2"}}
```

**Response:**
```json
{"id": "p1", "result": {"type": "pane_process_info", "process_info": {
  "pane_id": "wF:p2",
  "shell_pid": 154327,
  "foreground_process_group_id": 154327,
  "foreground_processes": [
    {
      "pid": 154327,
      "name": "claude-hr",
      "argv": ["/bin/bash", "/path/to/claude-hr", "Claude Retry Development"],
      "cmdline": "/bin/bash /path/to/claude-hr Claude Retry Development",
      "cwd": "/home/homeserver/projects/claude-retry"
    },
    {
      "pid": 154334,
      "name": ".claude-wrapped",
      "argv": ["claude", "--continue", "--remote-control", "Claude Retry Development"],
      "cmdline": "claude --continue --remote-control Claude Retry Development",
      "cwd": "/home/homeserver/projects/claude-retry"
    }
  ]
}}}
```

`foreground_processes` lists all processes in the foreground process group. Walk this list to find the `claude` process and its PID for `/proc/<pid>/environ` lookup.

Fixture: `pane-process-info.json`.

## 6. `pane.send_keys` (Ctrl+C) and text injection semantics

**`pane.send_keys` — for special keys:**
```json
{"id": "k1", "method": "pane.send_keys", "params": {"pane_id": "wK:p1", "keys": ["ctrl+c"]}}
```
Response: `{"id": "k1", "result": {"type": "ok"}}`

Key encoding: string array of key names. `ctrl+c` confirmed working. Other modifiers follow same pattern (`ctrl+<key>`).

**`pane.send_text` — for literal text (including `\n` for Enter):**
```json
{"id": "t1", "method": "pane.send_text", "params": {"pane_id": "wK:p1", "text": "continue\n"}}
```
Sending `text\n` is atomic (the text plus Enter arrives as one unit). Verified: `echo hello\n` executed correctly.

**`pane.run` does NOT exist as a socket method.** The CLI `herdr pane run <pane_id> <cmd>` is implemented client-side as `pane.send_text` with `\n`. Use `pane.send_text` with a trailing `\n` for the same effect.

**Inject sequence for daemon:**
1. `pane.send_keys` with `["ctrl+c"]` — clears partial input
2. `pane.send_text` with `"continue\n"` — submits continue

**GAP:** `agent.send` also sends text (confirmed `{"type":"ok"}` response) but it's unclear if it appends Enter automatically. From CLI docs: "agent send writes literal text; use pane run when you want command text plus Enter." So `agent.send` = literal text (no Enter); `pane.send_text` with `\n` = text + Enter. Use `pane.send_text` for injection.

Fixture: `pane-send-keys-ok.json`.

## 7. `agent.list` / `agent.get` schema

**`agent.list`:**
```json
{"id": "1", "method": "agent.list", "params": {}}
```
Returns `{"type": "agent_list", "agents": [...]}` where each agent has:
```typescript
{
  terminal_id: string,       // "term_655cb26045e6f1"
  name?: string,             // workspace name (may be absent for unnamed panes)
  agent: string,             // "claude"
  agent_status: "idle" | "working" | "blocked" | "unknown",
  agent_session: {
    source: string,          // "herdr:claude"
    agent: string,           // "claude"
    kind: "id",
    value: string            // Claude session UUID ← key field for account resolution
  },
  workspace_id: string,      // "w8"
  tab_id: string,            // "w8:t1"
  pane_id: string,           // "w8:p2"
  focused: boolean,
  cwd: string,               // current working directory
  foreground_cwd: string,    // foreground process cwd
  revision: number
}
```

**`agent_session.value`** is the Claude Code session UUID. Use this to scan `<config_dir>/projects/*/<uuid>.jsonl` for account resolution (primary path per T5).

**Panes without an agent** (non-Claude terminals) appear without `agent_session` and with `agent_status: "unknown"`. Example: the workspace root pane `wK:p1` created during spike.

**`agent.get`:** same shape as one element of `agent.list`, wrapped in `{"type": "agent_info", "agent": {...}}`. Target accepts `pane_id`, `terminal_id`, or agent name.

Fixture: `agent-list.json`, `agent-get.json`.

## 8. How a client identifies its own pane

**Primary (always available inside herdr):**
```typescript
const myPaneId = process.env.HERDR_PANE_ID;       // "wE:p2"
const myTabId = process.env.HERDR_TAB_ID;         // "wE:t1"
const myWorkspaceId = process.env.HERDR_WORKSPACE_ID; // "wE"
const socketPath = process.env.HERDR_SOCKET_PATH;  // "/home/homeserver/.config/herdr/herdr.sock"
```

The daemon MUST exclude its own pane from monitoring (never watch `HERDR_PANE_ID`).

**Fallback (if running outside herdr, e.g. nohup):** `HERDR_ENV` is unset; use the config-dir default socket path `~/.config/herdr/herdr.sock`. No `HERDR_PANE_ID` available — daemon has no pane to exclude.

## Open gaps and workarounds

| Gap | Implication | Workaround |
|---|---|---|
| Live `pane.agent_status_changed` payload not captured | Exact field names for `agent_status` value in event unknown | Assume same as `agent_status` in `agent.list`; make client tolerant of unknown fields |
| Live `pane.output_matched` event payload not captured | Matched text / line number fields unknown | Subscribe with broad pattern first iteration; log and assert shape in unit tests against replayed fixture |
| `pane.output_matched` per-pane only | Must register one subscription per Claude pane; no wildcard | On `pane.created` event, add subscription for new pane; on `pane.closed`, remove |
| `pane.agent_status_changed` `blocked` status meaning | Unknown if `blocked` = rate-limited or any block | Treat `blocked` as a trigger to run `pane.read` + `isBlockedAtBanner` check; don't assume rate-limit |
| `events.subscribe` reconnect behavior | Unclear if server re-sends missed events on reconnect | Reconcile sweep on every (re)connect is the designed mitigation |
