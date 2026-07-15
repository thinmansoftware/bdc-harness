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
