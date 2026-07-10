# Blue Devil Dispatch Worker

Operator-run watcher for `WO-HARNESS-DISPATCH-DROPBOX-V1-01`.

## Setup

1. Copy `scripts/dispatch-worker/config.example.json` to `scripts/dispatch-worker/config.local.json`.
2. Set the operator token in the env var named by `operator_token_env` (default `ARCHON_OPERATOR_TOKEN`).
3. Headless CLI forms -- LIVE-VERIFIED on the operator desktop 2026-07-10
   (closes the plan's Dependency #1 / WO Stop Condition #4 CLI-shape check):
   - Claude Code: `claude -p <prompt>` -- verified working as-is.
   - Codex/Sol: `codex exec --skip-git-repo-check <prompt>` -- the
     `--skip-git-repo-check` flag is REQUIRED: without it codex exec refuses
     to run in any untrusted/non-git working directory ("Not inside a trusted
     directory"), and dispatch tasks run in arbitrary workdirs. The example
     config ships this flag.
   A full end-to-end dispatch transcript on the desktop remains the final
   Stop Condition #4 evidence once the worker is activated (M-10 gate).
4. Run:

```bash
bun run scripts/dispatch-worker/index.ts --config scripts/dispatch-worker/config.local.json
```

`config.local.json` and `scripts/dispatch-worker/transcripts/` are intentionally gitignored.

## Scope

The worker only claims messages addressed to configured local agents (`claude`, `codex` in v1).
It passes the dispatch body as prompt content in an argv array, never through a shell string.
Each spawn runs in a fresh temp directory and writes a local transcript before posting the result.

`agent_message`, `run_review`, `draft_spec`, and `run_report` are supported. The API rejects
arbitrary shell task types and repo-mutating `agent_message` content before a worker can claim it.

On clean shutdown, the worker stops heartbeats and lets any in-flight leases lapse; v1 has no
release endpoint.
