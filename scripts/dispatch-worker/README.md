# Blue Devil Dispatch Worker

Operator-run watcher for `WO-HARNESS-DISPATCH-DROPBOX-V1-01`.

## Setup

1. Copy `scripts/dispatch-worker/config.example.json` to `scripts/dispatch-worker/config.local.json`.
2. Set the operator token in the env var named by `operator_token_env` (default `ARCHON_OPERATOR_TOKEN`).
3. Verify the local headless CLI forms on the laptop before first use:
   - Claude Code: `claude -p <prompt>`
   - Codex/Sol: `codex exec <prompt>`
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
