# Blue Devil Dispatch Worker

Operator-run watcher for `WO-HARNESS-DISPATCH-DROPBOX-V1-01`.

## Setup

1. Copy `scripts/dispatch-worker/config.example.json` to `scripts/dispatch-worker/config.local.json`.
2. Point `operator_token_file` at the existing operator-token file, or set the env var named by
   `operator_token_env`. The env var wins. Tokens are never placed in task arguments or git.
3. Headless CLI forms -- LIVE-VERIFIED on the operator desktop 2026-07-10
   (closes the plan's Dependency #1 / WO Stop Condition #4 CLI-shape check):
   - Claude Code: `claude --permission-mode plan -p <prompt>`.
   - Codex/Sol: `codex exec --skip-git-repo-check --sandbox read-only --ephemeral
     --ignore-user-config -c windows.sandbox="unelevated" <prompt>` -- the
     `--skip-git-repo-check` flag is REQUIRED: without it codex exec refuses
     to run in any untrusted/non-git working directory ("Not inside a trusted
     directory"), and dispatch tasks run in arbitrary workdirs. The
     `-c windows.sandbox="unelevated"` pair is REQUIRED TOO (#795): on Windows,
     `--ignore-user-config` drops the `[windows] sandbox` key from
     `~/.codex/config.toml`, this codex build cannot construct a Windows sandbox
     without an explicit mode, and every command -- including a plain file read --
     then fails with a misleading `Rejected(... "blocked by policy")`. It is inert
     on Linux and macOS, so the default carries it unconditionally. The example
     config ships both.
   - Grok: `grok --permission-mode plan --no-subagents -p <prompt>`.
   - Cursor: `cursor-agent --print --mode ask --trust <prompt>`.
   - Fusion accepts only a structured `run_review` JSON body containing `wo`, `diff`, `tests`,
     and `manifest`; it runs the advisory-only Fusion review CLI.
4. Run:

```bash
bun run scripts/dispatch-worker/index.ts --config scripts/dispatch-worker/config.local.json
```

On Windows, validate the launcher and then register the logon task after this change is merged into
the canonical checkout:

```powershell
.\scripts\dispatch-worker\start-windows.ps1 -ValidateOnly
.\scripts\dispatch-worker\install-windows.ps1
```

The launcher maintains an SSH local forward to the Archon API. The scheduled task runs only in the
interactive operator session and ignores duplicate starts.

`config.local.json` and `scripts/dispatch-worker/transcripts/` are intentionally gitignored.

### Prompt delivery contract (no argv template)

The dispatch body is delivered to an agent CLI on stdin by default, or written to
a temp file substituted for the `__DISPATCH_PROMPT_FILE__` placeholder for
`promptDelivery: 'prompt-file'` seats (grok). It is NEVER passed as an argv
template. A `config.local.json` must NOT carry the literal `{{prompt}}` token in
any `agents.*.args` -- the token is not substituted and an agent that receives it
answers the literal template instead of the real task (issue #1042). As a
safety net, `buildAgentInvocation` drops any argv element that is exactly the
token and throws `dispatch_agent_args_prompt_template_embedded` when the token is
embedded inside a larger argument, but the correct fix is to re-copy
`config.local.json` from the current `config.example.json`.

## Per-agent working directory and environment (`cwd`, `env`)

Every agent in `agents` accepts two optional fields:

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `cwd` | absolute path string | unset -> a fresh `mkdtemp` scratch directory per dispatch | Directory the agent process runs in. |
| `env` | object of string -> string | unset -> the worker's own environment only | Extra environment variables merged over the worker environment for this agent's child process. |

Both apply to all three transports (the `prompt` CLI path, `acp`, and `mcp`).

### Why `cwd` exists

John's directive 2026-09-08: board seats must get context. Without `cwd` every
exec-transport agent runs in an empty temp directory, so a seat answering a
board ballot has no repo, no wiki, and no skills, and reports "Oracle
unavailable / skill read blocked" every round. Pointing a seat at a real
checkout gives it the context the board packet already assumes it has.

```json
{
  "agents": {
    "codex": {
      "command": "codex",
      "args": ["exec", "--skip-git-repo-check", "--sandbox", "read-only", "--ephemeral", "--ignore-user-config", "-c", "windows.sandbox=\"unelevated\""],
      "cwd": "C:/Users/pcmed/projects/BDC_XO/.worktrees/xo-main",
      "env": { "ORACLE_URL": "https://oracle.bluedevilcollectibles.com" }
    }
  }
}
```

Rules the worker enforces:

- The worker never creates, writes into, or deletes a configured `cwd`. The
  prompt file used by `promptDelivery: 'prompt-file'` seats still goes to a
  per-run temp directory, so nothing untracked lands in a real checkout.
- A `cwd` that is missing, is not a directory, or is not absolute falls back to
  the `mkdtemp` scratch directory and logs a WARNING. A moved worktree degrades
  to today's behaviour instead of taking a seat offline.
- The effective directory is logged once per run:
  `<transport> leg for <recipient> (<id>) cwd=<path> source=configured|temp`.
- `cwd` changes where an agent runs; it changes no permission or sandbox flag.
  The codex seat keeps `--sandbox read-only` regardless.

### `env`

`env` is merged over `process.env` for the child only. Use it for
non-secret pointers a seat needs (an Oracle URL, a feature flag) or for a
read-only token that is issued to one seat. Real secrets belong in the
worker's own environment or a token file -- `config.local.json` is gitignored,
but `config.example.json` is not.

## ACP conformance and promotion

The dark `claude-acp` seat runs the BDC-owned adapter in `claude-acp/main.ts`.
It implements M-126 T1's rejection of the unaudited third-party wrapper and
executes prompts in-process through the official Claude Agent SDK. Adapter tests
can select the minimal fake executor seam with `BDC_CLAUDE_ACP_TEST_EXECUTOR`;
the variable is test-only and its absence always selects the real SDK path.
Promotion requires the same operator-host four-test matrix used by `grok-acp`
and `codex-mcp`; this registration does not advertise the seat live.

The worker also owns a native MCP client leg for Codex. The `codex-mcp` seat runs
`codex mcp-server` over stdio, discovers the live `codex` tool schema, and keeps prompts out of
process arguments. It is registered dark: no shipped provider configuration advertises it live.
Promotion follows the same operator-host four-test matrix and config-only rollback discipline as
`grok-acp`; real Codex authentication and binary verification are intentionally operator steps.

Run the reusable evidence-contract matrix against an ACP seat before advertising it:

```bash
bun run scripts/dispatch-worker/run-acp-conformance.ts --seat grok-acp --failure-command definitely-not-a-real-binary-bdc
```

The command prints a recordable JSON report and exits non-zero unless all four tests are green:
the 60KB payload round-trip, bounded cancellation and descendant cleanup, honest forced failure,
and receipt audit. Run it on the Windows operator host with the real binary and credentials. The
optional `--timeout-ms`, `--cancel-after-ms`, and `--cwd` arguments tune the controlled probes.

Only after all four verdicts are green should the seat be added to `capabilities.providers` in
`config.local.json`. Promotion is not performed by this repository change. Rollback is config-only:
remove the seat from `capabilities.providers`; its CLI fallback remains configured.

## Scope

The worker only claims messages addressed to configured local agents.
It passes the dispatch body as prompt content in an argv array, never through a shell string.
Each spawn runs in a fresh temp directory and writes a local transcript before posting the result.

`agent_message`, `run_review`, `draft_spec`, and `run_report` are supported. The API rejects
arbitrary shell task types and repo-mutating free-form content before a worker can claim it.

`GET /api/dispatch/status` expires stale worker rows before returning them and exposes queue counts,
operator reports, and approved execution-handoff records for the XO Command Center. Execution
handoffs use `POST /api/dispatch/execution-handoffs`; the schema accepts only approved `local` or
`staging` targets and records the packet for Overseer/Cauldron pickup. It does not fire workflows or
permit production activity.

`board_motion` delivery is optional and disabled unless `board_delivery.enabled` is true.
When enabled, `credential_id` must match an active or retiring server-side
`board_delivery_worker` record in `DISPATCH_WORKER_CREDENTIALS_JSON`, and `token_env` names the
environment variable containing that raw worker token. `allowed_principals` must be covered by both
the server credential and local `agents`; the worker still polls only concrete principals and never
uses a `board` agent entry.

Credential rotation is overlap-based: add the new active credential beside the retiring one, update
the worker config to the new `credential_id` and token env value, verify an authenticated queued-list
probe, then claim and complete a staging-only fixture before disabling the old credential.

On clean shutdown, the worker stops heartbeats and lets any in-flight leases lapse; v1 has no
release endpoint.

## Reboot-recovery hardening (M-51 AMEND-9)

The worker enforces single-instance-per-worker-id via a local PID lockfile at
`~/.config/bdc/dispatch-worker-<worker_id>.lock` (see `instance-lock.ts` for the design rationale
-- a local PID check rather than a check against the drop-box server's own registration/heartbeat
state, because the server heartbeat row can look "fresh" for up to `heartbeat_interval_ms` after a
worker has actually crashed). On startup, if the lock is held by another live PID the worker
refuses to start and exits non-zero rather than risk double-claiming dispatch messages. A lock left
by a dead PID is automatically reclaimed by the next start -- no manual cleanup required.

Diagnostics are written to a size-rotating log file at
`~/.config/bdc/logs/dispatch-worker-<worker_id>.log` (see `worker-log.ts`), 5 MB per file, 5
rotated files retained. Before this change the Scheduled Task ran with a hidden window and no
output redirection, so a crash left no trail at all.

The Scheduled Task registered by `install-windows.ps1` restarts on failure up to 5 times, 1 minute
apart (bounded, not an infinite tight loop), and force-terminates a hung instance after 1 day
(`ExecutionTimeLimit`) so a wedged process cannot occupy the single-instance slot indefinitely.

`verify-reboot-recovery.ts` simulates the failure modes closest to an unclean worker death without
touching the real Scheduled Task, the real drop-box server, or rebooting the host: it proves (a) a
second concurrently-running instance is refused, and (b) a fresh instance can reclaim the lock
after the lock-holding process is killed. It does **not** and cannot prove that a real Windows
reboot fires `\BlueDevil-Dispatch-Worker` cleanly, that Task Scheduler's restart-on-failure setting
actually engages against the real task, or that the SSH tunnel in `start-windows.ps1`
re-establishes after a cold boot -- those require a live pass from the operator desktop. Run with:

```bash
bun run scripts/dispatch-worker/verify-reboot-recovery.ts
```

## Worker death alarm + watchdog (WO-HARNESS-DISPATCH-WORKER-DEATH-ALARM-01)

Issue #1041 recorded three silent worker deaths where the worker was gone but
nothing paged John, and Task Scheduler still reported the task "Ready" (last
result `0xFFFFFFFF`) with no live process. Two independent mechanisms close that
gap. They are complementary: the alarm makes a death LOUD (pages + journals),
the watchdog makes it SELF-HEALING (restarts).

### 1. Page + journal (server side)

The server runs a dedicated timer (default 60s, `DISPATCH_WORKER_ALARM_INTERVAL_MS`,
minimum 5000) separate from the 15-minute Duty Officer tick, so a dead worker is
paged within ~1 minute. A worker whose last heartbeat is older than the page
threshold (default 5 minutes, `DISPATCH_WORKER_ALARM_PAGE_STALE_MINUTES`) pages
John over Telegram. Every page attempt is journaled ROW-FIRST in `tm_journal`
(`action_type=escalate_p0`, `thread_ref=dispatch-worker:<worker_id>`) before the
send, then flipped to `sent`/`failed`, so a page survives a crash mid-send and is
retried without duplicating a `sent` row. The page path runs even with no GitHub
token -- it does not depend on the GitHub DOWN/UP comment path (which keeps its
own 10-minute comment threshold, unchanged).

A worker that is restarted by the watchdog BEFORE its heartbeat ages past five
minutes would otherwise erase all evidence (the heartbeat clock restarts fresh).
To prevent that, `acquireInstanceLock` appends one JSON line
`{previous_pid, previous_started_at, reclaimed_at}` to an append-only death log at
`~/.config/bdc/dispatch-worker-<worker_id>.deaths.jsonl` whenever it reclaims a
dead-PID lock, BEFORE the lock is overwritten. Each registration carries the
retained log (entries newer than 24h, at most 20) as
`capabilities.restart_evidence`. The alarm journals and pages each death entry
independent of heartbeat freshness, keyed by
`dispatch-worker-death:<worker_id>:<previous_pid>:<previous_started_at>` (never the
clock), so a watchdog-restarted worker still gets paged.

### 2. Watchdog scheduled task (desktop side)

`install-windows.ps1` registers a SECOND scheduled task,
`BlueDevil-Dispatch-Worker-Watchdog`, with a repeating trigger every 5 minutes
indefinitely (NOT logon-only), running `watchdog-windows.ps1` ->
`watchdog.ts`. The watchdog reads the worker PID lockfile: a missing lock or a
dead PID means "no live process", so it runs the worker task
(`schtasks /Run /TN BlueDevil-Dispatch-Worker`). A start failure exits nonzero and
logs `dispatch_worker_watchdog_start_failed`.

### Operator verification (run on the desktop, post-merge)

```powershell
# Register both tasks (worker + watchdog)
powershell -ExecutionPolicy Bypass -File scripts\dispatch-worker\install-windows.ps1

# Confirm the watchdog task exists with a repeating trigger
Get-ScheduledTask -TaskName 'BlueDevil-Dispatch-Worker-Watchdog'
(Get-ScheduledTask -TaskName 'BlueDevil-Dispatch-Worker-Watchdog').Triggers

# Induced-kill run 1 -- page while DOWN: disable the watchdog so the worker
# stays dead, kill it, and confirm a Telegram page arrives within 6 minutes.
Disable-ScheduledTask -TaskName 'BlueDevil-Dispatch-Worker-Watchdog'
Stop-ScheduledTask   -TaskName 'BlueDevil-Dispatch-Worker'
Get-Process | Where-Object { $_.Path -like '*bun*' }   # confirm gone

# Induced-kill run 2 -- page even when the watchdog restarts it in under 5
# minutes (heartbeat never goes stale; the death-evidence page still fires).
Enable-ScheduledTask -TaskName 'BlueDevil-Dispatch-Worker-Watchdog'
Stop-ScheduledTask   -TaskName 'BlueDevil-Dispatch-Worker'

# Confirm the journaled page row on the host (action_type escalate_p0)
sqlite3 "$env:USERPROFILE\.archon\archon.db" ^
  "SELECT created_at, thread_ref, action_type, outcome, idempotency_key FROM tm_journal WHERE action_type='escalate_p0' AND thread_ref LIKE 'dispatch-worker:%' ORDER BY created_at DESC LIMIT 5;"
```

### Root-cause investigation for the 2026-09-28T21:38Z death (issue #1041 item 3)

This is an operator investigation, not code. Pull the Windows event window around
the death to find why the process exited:

```powershell
$start = [datetime]'2026-09-28T21:30:00Z'
$end   = [datetime]'2026-09-28T21:45:00Z'
# Task Scheduler operational log for the worker task
Get-WinEvent -FilterHashtable @{ LogName='Microsoft-Windows-TaskScheduler/Operational'; StartTime=$start; EndTime=$end } |
  Where-Object { $_.Message -like '*BlueDevil-Dispatch-Worker*' } | Format-List TimeCreated, Id, Message
# System log for unexpected shutdown / sleep / power events in the same window
Get-WinEvent -FilterHashtable @{ LogName='System'; StartTime=$start; EndTime=$end } |
  Format-List TimeCreated, Id, ProviderName, Message
# Worker's own rotating diagnostics log
Get-Content "$env:USERPROFILE\.config\bdc\logs\dispatch-worker-$env:COMPUTERNAME.log" -Tail 200
```

# Phase 1 honest messaging

Workers may place `DISPATCH_OUTCOME: blocked` or `DISPATCH_OUTCOME: failed` on
the final output line. The worker strips that line; a nonzero process exit
always wins and is recorded as failed. Empty exit-zero output remains an
unknown outcome, never a successful one.

`DISPATCH_PHASE1_ACTIVATED_AT` is an ISO timestamp boundary. When absent or
invalid, outcome notices and escalation reconciliation are disabled so legacy
mail cannot create a storm. Failed, blocked, and unknown post-boundary results
receive a bounded, idempotent blocker notice.

Cancellation reaches every transport controller. CLI cancellation enumerates,
kills, and verifies the process tree; a cancelled run cannot post success.
Transcripts contain hashes, UTF-8 byte counts, bounded previews, structural
update metadata, transport state, duration, and kill evidence. They never
contain complete prompts, output, request headers, or tokens.

The escalation chain is seat blocker -> internal XO handoff -> John-facing
Telegram at 4h and SMS at 24h. Both external legs default off and remain off
unless `DISPATCH_SENDER_AUTH_MODE=enforce` and the matching enable flag is
explicit. Credentials are read only through configured files below
`/run/bdc-secrets/`; secret values are never environment variables.

Run focused proof with:

```sh
bun test ./scripts/dispatch-worker/stdin-prompt.test.ts ./scripts/dispatch-worker/acp/kill-tree.test.ts ./scripts/dispatch-worker/acp/session.test.ts ./scripts/dispatch-worker/mcp/session.test.ts ./scripts/dispatch-worker/outcome-transcript.test.ts
```

## Phase 1.5 sender authentication (capability shipped dark)

Phase 1.5 binds every newly created Dispatch message to an authenticated or
code-fixed sender principal. Runtime enablement is a later deploy motion.

### Registry: `DISPATCH_PRINCIPALS_JSON`

JSON array of credential records:

- `credential_id` (unique)
- `principal_id` (canonical; not `system:` or `board:` reserved namespaces)
- `token_sha256` (64 lowercase hex SHA-256 of the raw token)
- `status`: `active` | `retiring` | `disabled`
- `send_as`: unique lowercase stable addresses the principal may select
- `receive_as`: empty or unique lowercase stable addresses (validated; not
  enforced for claim path in Phase 1.5)
- `roles`: includes `send` for creation

Multiple credentials may share one `principal_id` so active and retiring digests
can overlap during rotation. All records for one principal must carry identical
`send_as`, `receive_as`, and `roles`.

Raw tokens are never stored. Callers present:

- header `x-dispatch-principal-id`
- header `x-dispatch-principal-token`

Tokens must be loaded from token files inside the client process only. Never put
raw tokens in argv, logs, receipts, or fixtures.

### Mode: `DISPATCH_SENDER_AUTH_MODE`

Accepts only `off`, `warn`, or `enforce`. Unset means `off` (dark shipping). An
invalid value is a configuration error.

Recommended activation sequence (deploy motion; not this WO):

`off -> warn -> enforce`

- `off`: missing principal headers admit legacy rows with null
  `sender_principal_id` silently.
- `warn`: missing headers admit legacy rows and emit one sanitized structured
  warning (no body/token material). Observable warn criteria: one warning per
  uncredentialed create, zero 401 for total absence, zero forged-sender accepts
  when headers are present but invalid.
- `enforce`: missing headers return 401 before idempotency lookup or insert.

Partial, malformed, disabled, missing-send-role, or unauthorized `send_as`
requests fail closed in every mode and never downgrade to legacy.

Rollback: set `DISPATCH_SENDER_AUTH_MODE=off` (or unset). Do not reverse
migration 043 in production without a separate owner-approved plan.

### Runtime / deploy separation

This repository change ships capability and proof only. It does not:

- enable warn/enforce in any runtime
- provision real tokens
- apply migration 043 to a live database
- enable Telegram/SMS or `decision_needed`

# M-131 server seats (Phase A/B)

- **Identity + concurrency one**: `seat.seat_id` names the seat (e.g.
  `bdc-seat-grok`). `seat.model_family` selects `grok`, `codex`, or `claude`
  (omitting it preserves the Phase A Grok behavior). A seat has exactly one
  provider in `seat.provider_allowlist`, and that provider must match its family.
  The agent registry is restricted to that allowlist and advertised
  capabilities list only those providers plus `seat_id` and `build_sha`.
- **Preflight gates advertisement**: before registering, polling, or
  claiming, the worker runs `seat-preflight.ts` (provider command available,
  secret-ingress file present, vendor-profile and state directories present
  and distinct, build SHA visible). On failure the worker logs a typed,
  sanitized error (code + field name only -- never a path value, file
  contents, or credential) and exits non-zero without advertising.
- **Credential-file placeholder**: `seat.secret_ingress_file` points at the
  read-only #1327 secret-ingress file (e.g.
  `/run/m131/secret-ingress/grok-credential.json`). Preflight checks
  presence only; credential bytes never enter Dispatch payloads, logs,
  health output, manifests, argv, or git. Placing a real credential there is
  a separately gated, John-authorized action -- never part of a source PR.
- **Non-secret state**: `seat.vendor_profile_dir` is the seat-private
  writable vendor profile (exactly one active refresh writer -- the
  provider process in this seat). `seat.state_dir` is separate non-secret
  state. The two must be distinct and are never shared across seats.
- **Health / build SHA instrument**: `bun run
  scripts/dispatch-worker/seat-preflight.ts --config <config.json>` exits 0
  and prints `seat_preflight_ok seat=<id> build_sha=<sha>` when the seat is
  healthy; the m131-seat container healthcheck uses it.
- **BUILD_SHA is REQUIRED, not defaulted**: build with
  `docker compose build --build-arg BUILD_SHA=$(git rev-parse HEAD)` (or set
  `BUILD_SHA` in the environment for compose). The image build fails without
  it, and preflight additionally rejects placeholder values (`unknown`,
  `none`, `latest`, `dev`, or anything shorter than an abbreviated SHA). A
  seat that cannot name its exact commit must not advertise at all.
- **Profile/state isolation is checked on CANONICAL paths**: the vendor
  profile and state directories are compared after symlink resolution and
  normalization, and nesting counts as non-isolated. Two differently-spelled
  paths that resolve to the same directory are refused.

The packaged seats and their required read-only credential ingress are:

- `bdc-seat-grok`: Grok adapter; `/run/m131/secret-ingress/grok-credential.json`.
- `bdc-seat-codex`: CLI `codex` adapter; `/run/m131/secret-ingress/codex-credential.json`.
- `bdc-seat-claude`: CLI `claude` adapter; `/run/m131/secret-ingress/claude-credential.json`.

Each seat runs the same preflight command: `bun run
scripts/dispatch-worker/seat-preflight.ts --config /app/config/seat.json`.
Codex MCP and Claude ACP remain dark and subject to the separate conformance
promotion gate above; Phase B packages only the plain CLI adapters. The host
source paths supplying these credential ingress files must be verified during
the separately gated deployment and are not established by these examples.

**Rollback**: a seat is rollback-safe by construction -- stop the seat
container (or set `"seat": null` and restart for a non-container worker) and
Dispatch simply stops seeing the seat advertise; queued messages stay queued
or lease-expire for a new fenced attempt. No schema, server, or router
change ships with a seat, so rollback never touches the drop-box server.

# Mailbox principals (`astra`, `xo`, `operator`)

Not every recipient is a worker. Some principals are `delivery_mode:
drain_on_start` **mailboxes**: no dispatch worker ever claims their mail. The
owning automation reads the queued rows on its own heartbeat, acts, and then
acks/addresses them as that principal. `claimMessage()` structurally refuses a
non-`worker_poll` principal, and the worker's poll loop only iterates the
concrete local agents in its `agents` config -- so a mailbox principal is never
even queried, let alone claimed.

Recipients that are mailboxes:

- `xo` -- XO command seat.
- `operator` -- operator drop-box.
- `astra` -- the Astra Codex desktop Board/XO seat (Arc D owner). Registered by
  migration `056_dispatch_astra_mailbox.sql`
  (WO-HARNESS-DISPATCH-ASTRA-MAILBOX-01). Send to it with `recipient: "astra"`
  on `POST /api/dispatch/messages`. The Astra desktop automation
  (`monitor-claude-astra-mailbox`) reads its inbox with:

  ```sql
  SELECT * FROM agent_dispatch_messages
  WHERE recipient = 'astra' AND acknowledged_at IS NULL;
  ```

  then acts in its own thread and acks/addresses the row as `astra`. Because
  `astra` is `drain_on_start`, the desktop dispatch worker's generic `codex`
  leg can never claim it -- the message reaches only the Astra seat.
