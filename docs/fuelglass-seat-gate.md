# Fuelglass seat gate

The harness reports each subscription seat's measured usage. It refuses to start a workflow run when a bound seat is at or above the cutoff. The check runs once, before the run's first node.

- **Always on.** The gate has no off switch (John Ranson, 2026-09-24). Every run that binds a claude, codex or cursor seat is checked. Per-token providers (codex-opr, opr, opr-zero, glm, grok, pi) are not seats and are never checked.
- **Default cutoff 90.** With no operator override and no `FUELGLASS_SEAT_CUTOFF_PERCENT`, the cutoff is 90 percent of the seat's gate window. The gate windows are claude `five_hour` and `seven_day`, codex `primary` and `secondary` (the 7-day window is `primary` today), and cursor `monthly`. Codex `limit_reached: true` also refuses.
- **Allowed range 1 to 95.** A cutoff above 95 would switch the gate off in effect, so the operator route and the env var both refuse it.
- **UNKNOWN proceeds and alerts.** If a bound seat cannot be measured, the run proceeds (a broken probe must not stop all work). The harness logs `workflow.seat_usage_unknown` and sends an operator alert through Dispatch, at most once per seat per hour.

This supersedes the M-171 rules "default cutoff 100" and "UNKNOWN never refuses and only logs" for this gate.

Operator routes require the operator token (`x-archon-operator-token`), the same as other `/api/*` routes.

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
  "cutoff": { "percent": 90, "source": "default" },
  "gate_enabled": true,
  "seats": { "claude": {}, "codex": {}, "cursor": {} }
}
```

`gate_enabled` is always `true`. `seats.claude.seven_day` and `seats.codex.seven_day` are a window object or `"UNKNOWN"`. `seats.cursor.seven_day` is `"NOT_APPLICABLE"`, because Cursor's gate window is `monthly`.

## Set or clear the cutoff

Percent must be a number from 1 to 95. `null` clears the in-memory operator override, which returns the cutoff to the env value or the default 90.

```bash
curl -s -X POST localhost:3090/api/fuelglass/cutoff \
  -H "content-type: application/json" \
  -H "x-archon-operator-token: $ARCHON_OPERATOR_TOKEN" \
  -d '{"percent": 85}'

curl -s -X POST localhost:3090/api/fuelglass/cutoff \
  -H "content-type: application/json" \
  -H "x-archon-operator-token: $ARCHON_OPERATOR_TOKEN" \
  -d '{"percent": null}'
```

A percent below 1 or above 95 (for example 96 or 100) returns HTTP 400 with an error naming `seat_cutoff_out_of_range`. A non-number returns HTTP 400. The override is process-local and is lost on restart.

## Environment

| Variable | Effect |
| --- | --- |
| `FUELGLASS_SEAT_CUTOFF_PERCENT` | Cutoff used when no operator override is set. Must be a number from 1 to 95. An invalid or out-of-range value falls back to 90 and logs `fuelglass.seat_cutoff_env_invalid` once. |
| `FUELGLASS_CURSOR_SESSION_TOKEN` | Cursor session credential. If it is absent, the cursor seat is UNKNOWN (and alerts) and no request is made. |
| `FUELGLASS_CLAUDE_CREDENTIALS_FILE` | Claude credentials JSON path. Default `$HOME/.claude/.credentials.json`. |
| `FUELGLASS_CODEX_AUTH_FILE` | Codex auth JSON path. Default `$HOME/.codex/auth.json`. |

No environment variable turns the gate off.

## Unknown-seat operator alert

When a bound seat reads UNKNOWN at the gate, the run continues and one Dispatch message is enqueued:

| Field | Value |
| --- | --- |
| sender | system `dispatch` |
| recipient | `operator` |
| task_type | `agent_message` |
| idempotency_key / correlation_id | `fuelglass-seat-unknown:<seat>:<UTC hour, e.g. 2026-09-24T10>` |
| body, first line | `Fuelglass seat gate could not measure seat <seat>` |
| body, rest | that the gate could not measure the seat, the probe note, the hour, and the first affected run |

Deduplication: an in-memory marker allows one alert per seat per UTC hour. The idempotency key is derived from the seat and the hour, so a restart in the same hour returns the existing message instead of creating a second one. If the enqueue fails, `fuelglass.seat_unknown_alert_failed` is logged and the next unmeasured run retries.

Read the alerts from the operator inbox:

```bash
ssh hetzner-prod "TOKEN=\$(docker exec archon-app-1 printenv ARCHON_OPERATOR_TOKEN); curl -s 'http://localhost:3090/api/dispatch/messages?recipient=operator&status=queued' -H \"x-archon-operator-token: \$TOKEN\""
```

## Logs and events

Refusal log: `workflow.seat_usage_refused` with `seat`, `window`, `usedPercent` and `cutoffPercent`.

Unknown log: `workflow.seat_usage_unknown` with `seat` and `note`. The run continues and the operator alert above is sent.

Workflow event: `dag_workflow_failed` with `data.reason` `seat_usage_refused` and `data.detail` `seat_usage_refused:<seat>:<window>:<usedPercent>:<cutoffPercent>`.
