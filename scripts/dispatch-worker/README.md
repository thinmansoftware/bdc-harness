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

## ACP evidence-contract conformance (M-126 T5)

Before an ACP seat is advertised live, it must pass the ratified four-test acceptance matrix
(M-126 disposition T3/T4/T5, RATIFIED 3-0 2026-08-04):

1. **Large payload round-trip** -- a >= 60KB dispatch reaches the agent IN FULL and is receipted.
   Proof is a run-unique token placed at the *tail* of the payload coming back in the receipt: the
   agent can only echo it if the whole payload arrived, and the token is unique per run so the
   receipt cannot be a cached or replayed transcript. Payload size alone is not accepted.
2. **Cancel mid-generation** -- cancellation stops work with no orphan descendants
   (`treeBeforeKill` non-empty, `treeAfterKill` empty), and the receipt says cancelled. The
   non-empty `treeBeforeKill` is load-bearing: without it, a run where no process tree was ever
   observed would score an empty `treeAfterKill` as clean cleanup of nothing.
3. **Forced failure** -- the seat's OWN declared failure leg (expired auth, or an agent that dies
   or hangs mid-run) is marked failed with a reason, attributably classified as either a fast fail
   or a bounded idle/wall timeout, and returns inside a budget derived from its configured
   timeouts. Never stuck queued, never `ok`.
4. **Receipt audit** -- every run above has a durable receipt matching what actually happened.

The matrix is implemented once, seat-parameterized, in `acp/conformance.ts` (`runConformanceMatrix`
against a `SeatUnderTest`). It is not grok-specific: any ACP seat -- a stub, `grok-acp`, or a future
codex/claude leg -- runs through the same harness. `acp/conformance.test.ts` proves the harness
itself against stub seats in CI, including Gate B (an expired `cached_token` rejecting the
`authenticate` RPC must fail loud rather than leave a dispatch stuck queued).

Run the real-binary matrix against a configured seat on the operator host. `--failure` is
**required**: the harness will not invent a failure leg for you, because substituting a
guaranteed-missing binary would only prove that the runtime reports a spawn error -- never that
*this* seat fails honestly when its auth expires or its agent dies mid-run.

```bash
# Gate B on the real leg: invalidate/expire the seat's cached credential FIRST, out of band.
bun run scripts/dispatch-worker/run-acp-conformance.ts grok-acp --failure=auth

# Or: same binary, replacement args chosen so the real agent dies or hangs mid-run.
bun run scripts/dispatch-worker/run-acp-conformance.ts grok-acp --failure=args:agent-bogus-subcommand

# Or: use another configured ACP seat as the failure leg.
bun run scripts/dispatch-worker/run-acp-conformance.ts grok-acp --failure=seat:claude-acp
```

The script prints a recordable PASS/FAIL line per test plus an overall `allGreen`, and exits 0 only
when all four are green. It exits 2 with usage if `--failure` is missing or unrecognized. This
CANNOT run in CI or the Cauldron container (no grok binary, no cached credential); it is the
operator's promotion step.

**Promotion is config-only and gated on green.** All four tests must be green against the real binary
before a seat id is added to `capabilities.providers` in `config.local.json`. Only after a green,
recorded run does the operator add the seat to that list. **Rollback is removing the seat id from
`capabilities.providers`** -- no code change, no redeploy. Until then the seat stays registered but
dark: nothing advertises it.
