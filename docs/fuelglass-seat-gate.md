# Fuelglass seat gate

The harness reports each subscription seat's measured usage and refuses to start a workflow run when a bound seat is at or above the cutoff. The check runs once, before the run's first node. A reading of UNKNOWN never refuses a run. The default cutoff is 100 (hard exhaustion).

Operator routes require the operator token (`x-archon-operator-token`), same as other `/api/*` routes.

## Read seats

```bash
curl -s localhost:3090/api/fuelglass/seats \
  -H "x-archon-operator-token: $ARCHON_OPERATOR_TOKEN"
```

Response shape:

```json
{
  "success": true,
  "generated_at": "2026-09-24T00:00:00.000Z",
  "cutoff": { "percent": 100, "source": "default" },
  "gate_enabled": true,
  "seats": { "claude": {}, "codex": {}, "cursor": {} }
}
```

`seats.claude.seven_day` and `seats.codex.seven_day` are a window object or `"UNKNOWN"`. `seats.cursor.seven_day` is `"NOT_APPLICABLE"` (Cursor's gate window is `monthly`).

## Set or clear the cutoff

Percent must be a number from 1 to 100. `null` clears the in-memory operator override.

```bash
curl -s -X POST localhost:3090/api/fuelglass/cutoff \
  -H "content-type: application/json" \
  -H "x-archon-operator-token: $ARCHON_OPERATOR_TOKEN" \
  -d '{"percent": 90}'

curl -s -X POST localhost:3090/api/fuelglass/cutoff \
  -H "content-type: application/json" \
  -H "x-archon-operator-token: $ARCHON_OPERATOR_TOKEN" \
  -d '{"percent": null}'
```

Any other body returns HTTP 400. The override is process-local and is lost on restart.

## Environment

| Variable | Effect |
| --- | --- |
| `FUELGLASS_SEAT_CUTOFF_PERCENT` | Cutoff used when no operator override is set. Must be a number from 1 to 100. Invalid values fall back to 100 and log `fuelglass.seat_cutoff_env_invalid` once. |
| `FUELGLASS_SEAT_GATE` | Set to `off` to skip the executor gate. `GET /api/fuelglass/seats` still reports. |
| `FUELGLASS_CURSOR_SESSION_TOKEN` | Cursor session credential. Absent: the cursor seat is UNKNOWN and no request is made. |
| `FUELGLASS_CLAUDE_CREDENTIALS_FILE` | Claude credentials JSON path. Default `$HOME/.claude/.credentials.json`. |
| `FUELGLASS_CODEX_AUTH_FILE` | Codex auth JSON path. Default `$HOME/.codex/auth.json`. |

## Logs and events

Refusal log: `workflow.seat_usage_refused` with `seat`, `window`, `usedPercent`, `cutoffPercent`.

Unknown log: `workflow.seat_usage_unknown` with `seat` and `note`. The run continues.

Workflow event: `dag_workflow_failed` with `data.reason` `seat_usage_refused` and `data.detail` `seat_usage_refused:<seat>:<window>:<usedPercent>:<cutoffPercent>`.
