# Node liveness

A prompt or command node is alive when its provider keeps yielding chunks.
The event store records that stream, and a cancel does not wait for the next chunk.

## Environment knobs

All three are read at call time inside `executeNodeInternal`
(`packages/workflows/src/dag-executor.ts`). Unset or non-positive values fall
back to the defaults below.

| Variable | Default | What it does | Where it is read |
| --- | --- | --- | --- |
| `ARCHON_STEP_IDLE_MS` | `1800000` (30 min, `STEP_IDLE_TIMEOUT_MS`) | Idle timeout for a prompt/command node when the node has no positive `idle_timeout`. Resolved by `resolveStepIdleTimeoutMs` in `packages/workflows/src/utils/idle-timeout.ts`. Node override wins over this env var. | `resolveStepIdleTimeoutMs` |
| `ARCHON_NODE_PROGRESS_EVENT_MS` | `60000` | Minimum gap between `node_progress` events after the first provider chunk. | `executeNodeInternal` |
| `ARCHON_NODE_CANCEL_POLL_MS` | `10000` (`CANCEL_CHECK_INTERVAL_MS`) | How often the executor reads run status and aborts the node stream when the run is no longer continuable. | `executeNodeInternal` |

## Failure reasons

When the idle timer fires, `node_failed` keeps `reason_code` `progress_timeout`
and adds `reason`:

- `provider_never_started` -- zero provider chunks arrived before the idle timer.
- `provider_silent` -- at least one chunk arrived, then the stream went quiet for the idle window.

The error string is `Node '<id>' <reason>: no provider output for <ms>ms`.

## Reading the event store

`node_progress` and `node_failed` are rows in `remote_agent_workflow_events`.
`node_progress.data` includes `provider`, `chunks_seen`, `last_chunk_type`,
and `since_node_start_ms`. `node_failed.data.reason` is the silence reason.

```bash
sqlite3 ~/.archon/archon.db "
SELECT event_type, step_name, json_extract(data, '$.reason') AS reason,
       json_extract(data, '$.chunks_seen') AS chunks_seen, created_at
FROM remote_agent_workflow_events
WHERE workflow_run_id = '<run-id>'
  AND event_type IN ('node_progress', 'node_failed')
ORDER BY created_at;
"
```
