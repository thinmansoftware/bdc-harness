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
     --ignore-user-config <prompt>` -- the
     `--skip-git-repo-check` flag is REQUIRED: without it codex exec refuses
     to run in any untrusted/non-git working directory ("Not inside a trusted
     directory"), and dispatch tasks run in arbitrary workdirs. The example
     config ships this flag.
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

# M-131 server seats (Phase A: bdc-seat-grok)

A "seat" is an isolated, single-provider server instance of this worker
(M-131 board compute plane). Setting `"seat"` in the worker config (default
`"seat": null` = not a seat) turns on the seat contract:

- **Identity + concurrency one**: `seat.seat_id` names the seat (e.g.
  `bdc-seat-grok`). A seat has exactly one provider in
  `seat.provider_allowlist` (Phase A: a Grok adapter, `grok-acp` preferred).
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

Packaging lives in `deploy/m131-seat/` (Dockerfile, compose example, seat
config example, container-contract test).

**Rollback**: a seat is rollback-safe by construction -- stop the seat
container (or set `"seat": null` and restart for a non-container worker) and
Dispatch simply stops seeing the seat advertise; queued messages stay queued
or lease-expire for a new fenced attempt. No schema, server, or router
change ships with a seat, so rollback never touches the drop-box server.
