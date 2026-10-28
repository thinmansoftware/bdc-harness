# Fuelglass seat gate

The harness reports each subscription seat's measured usage. It refuses to start a workflow run when a bound seat is at or above the cutoff. The check runs once, before the run's first node.

- **Always on.** The gate has no off switch (John Ranson, 2026-09-24). Every run that binds a claude, codex or cursor seat is checked. Per-token providers (codex-opr, opr, opr-zero, glm, grok, pi) are not seats and are never checked.
- **Default cutoff 90.** With no operator override and no `FUELGLASS_SEAT_CUTOFF_PERCENT`, the cutoff is 90 percent of the seat's gate window. The gate windows are claude `five_hour` and `seven_day`, codex `primary` and `secondary` (the 7-day window is `primary` today), and cursor `monthly`. Codex `limit_reached: true` also refuses.
- **Allowed range 1 to 95.** A cutoff above 95 would switch the gate off in effect, so the operator route and the env var both refuse it.
- **UNKNOWN proceeds and alerts.** If a bound seat cannot be measured, the run proceeds (a broken probe must not stop all work). The harness logs `workflow.seat_usage_unknown` and sends an operator alert through Dispatch, at most once per seat per hour.

- **The lane's own seat decides (WO-HARNESS-SEAT-GATE-HONORS-FIRED-LANE-TIER-01).** The lane seat is the seat of the workflow-level provider the run was fired on. If the lane seat is at or above the cutoff the run is refused with `role=lane`. A seat bound only by individual nodes (for example a `codex-native-strict` reviewer node in a claude lane) does not refuse the run when every node on that seat declares an eligible failover target (`failover_provider`, checked with `selectQuotaExhaustionRoute`) whose seat is not measured at or above the cutoff. The run then proceeds and logs `workflow.seat_usage_node_degraded`. Otherwise it is refused with `role=node`, so a run is never dispatched into a certain mid-run quota failure.

- **Codex purchased credits count as headroom (John Ranson, 2026-10-27).** The Codex reading carries the usage endpoint's top-level `credits` object (`has_credits`, `unlimited`, `overage_limit_reached`, `balance`). When `has_credits` is true, `overage_limit_reached` is not true and the request is still `allowed`, Codex keeps billing credits past the window, so the gate does not refuse on the codex seat even at or above the cutoff. It logs `workflow.seat_usage_on_credits` with detail `codex:on_credits`, and the decision carries `onCredits: ["codex:on_credits"]`. With `has_credits` false the gate refuses as before.
- **Reviewer failover on the claude and fable lanes.** The `codex-native-strict` reviewer nodes (`diff-review`, `diff-review-final`, `opus-rereview`, `apply-diff-review-final`) declare `failover_provider: openrouter`, `failover_model: moonshotai/kimi-k3.1-pro`, `failover_agent: opr-adversarial-reviewer` (John Ranson 2026-10-27). They never fail over to Claude (ruling D0, M-20261021c). `openrouter` is not a gated seat, so with Codex over the cutoff and no credits these lanes proceed in degraded mode.

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

Percent must be a number from 1 to 95. `null` clears the operator override and returns the cutoff to the env value or the default 90. The override persists until cleared. It is stored in the `operator_settings` table (`setting_key` `fuelglass.seat_cutoff_percent`).

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

A percent below 1 or above 95 (for example 96 or 100) returns HTTP 400 with an error naming `seat_cutoff_out_of_range`. A non-number returns HTTP 400. When `cutoff.source` is `operator`, GET `/api/fuelglass/seats` adds `set_at` (ISO timestamp) and `set_by` (the string `operator-token`). Those fields are absent when the source is `env` or `default`.

## Environment

| Variable | Effect |
| --- | --- |
| `FUELGLASS_SEAT_CUTOFF_PERCENT` | Cutoff used when no operator override is set. Must be a number from 1 to 95. An invalid or out-of-range value falls back to 90 and logs `fuelglass.seat_cutoff_env_invalid` once. |
| `FUELGLASS_CURSOR_SESSION_TOKEN` | Cursor session credential. The Cursor session credential is never set on the server. Desktop pushes measure the cursor seat. When no pushed reading has arrived, or the latest push is stale, the existing direct probe runs and the cursor seat stays UNKNOWN because this variable is absent. |
| `FUELGLASS_PUSHED_READING_MAX_AGE_MINUTES` | How long a pushed cursor reading stays fresh. Default 30. Accepted integers are 1 to 1440. An invalid value falls back to 30 and logs `fuelglass.pushed_reading_max_age_env_invalid` once. |
| `FUELGLASS_CLAUDE_CREDENTIALS_FILE` | Claude credentials JSON path. Default `$HOME/.claude/.credentials.json`. |
| `FUELGLASS_CODEX_AUTH_FILE` | Codex auth JSON path. Default `$HOME/.codex/auth.json`. |

No environment variable turns the gate off.

## Pushed readings

Fuelglass on the operator desktop pushes the cursor seat. The harness stores the latest reading only and never stores a Cursor session credential.

The payload is exactly these six fields:

```json
{
  "seat": "cursor",
  "used_percent": 35.28,
  "remaining_percent": 64.72,
  "resets_at": "2026-11-13T16:33:08.000Z",
  "observed_at": "2026-10-27T13:05:11.000Z",
  "source": "desktop-fuelglass"
}
```

`POST /api/fuelglass/readings` accepts that payload and returns HTTP 200:

```json
{ "success": true, "reading": { "seat": "cursor", "received_at": "2026-10-27T13:05:12.000Z" } }
```

The stored reading adds `received_at`. Rejected bodies are HTTP 400. They are not logged and not echoed.

| Code | When |
| --- | --- |
| `credential_field_rejected` | Any key at any depth whose name contains cookie, token, session, secret, credential, password, authorization, jwt, or bearer |
| `credential_value_rejected` | Any string value contains `WorkosCursorSessionToken` or is a JWT-shaped value longer than 100 characters |
| `unknown_field` | Any key other than the six |
| `seat_not_pushable` | `seat` is not `cursor` |
| `percent_out_of_range` | A percent is not a finite number from 0 to 100 |
| `percent_mismatch` | `remaining_percent` is not `100 - used_percent` within 0.01 |
| `timestamp_unparseable` | `resets_at` or `observed_at` is not a parseable time |
| `observed_at_in_future` | `observed_at` is more than 5 minutes ahead. Exactly 5 minutes ahead is accepted |

A pushed reading is fresh when `now - observed_at` is less than or equal to `FUELGLASS_PUSHED_READING_MAX_AGE_MINUTES`. A fresh cursor reading is measured on the `monthly` window with `reading_source` `pushed` and wins over the direct probe. A reading that is present but stale is UNKNOWN. Its note begins with `reading_stale` and names `observed_at` and the age in minutes. The existing once-per-hour operator Dispatch notice still fires. If no reading has been pushed, the direct probe runs unchanged.

`GET /api/fuelglass/readings/cursor` returns:

```json
{
  "success": true,
  "reading": null,
  "fresh": false,
  "age_seconds": null,
  "max_age_minutes": 30
}
```

`reading` is the stored row or `null`. `fresh` uses the same maximum age as the gate. `age_seconds` is `null` when no row is stored.

The Cursor session credential is never set on the server.

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

Refusal log: `workflow.seat_usage_refused` with `seat`, `window`, `usedPercent`, `cutoffPercent`, `lane` (the workflow name) and `role` (`lane` or `node`).

Degraded log: `workflow.seat_usage_node_degraded` with `lane`, `seat`, `window`, `usedPercent`, `cutoffPercent`, `nodeIds` and `failoverProviders`. The run continues.

Unknown log: `workflow.seat_usage_unknown` with `seat` and `note`. The run continues and the operator alert above is sent.

Workflow event: `dag_workflow_failed` with `data.reason` `seat_usage_refused`, `data.lane`, `data.role` and `data.detail` `seat_usage_refused:<seat>:<window>:<usedPercent>:<cutoffPercent>:lane=<workflow name>:role=<lane|node>`. The prefix up to `cutoffPercent` is unchanged, so prefix matchers keep working. Example: `seat_usage_refused:codex:primary:96:90:lane=bdc-feature-development:role=node`.

## Conductor climb rule

The Smart Cauldron conductor (`packages/smart-cauldron/src/cascade.ts`) reads the same seats route, including `cutoff.percent`. A rung whose own seat (`seatForTier`) is measured at or above that cutoff is skipped during entry and during a climb, with a log line `Skipping tier "<tier>" during <entry|climb>: seat_over_cutoff:<seat>:<used>:<cutoff>`. An UNKNOWN seat, or an unknown cutoff, is never skipped on this basis. A pinned entry (`--entry`) is not skipped; the run-start gate decides it. A fired rung that the run-start gate refuses (run error `seat_usage_refused:...`) is recorded as `seat_refusal: <detail>` and climbs to the next rung with headroom. It is not a quality failure (no informed-climb context, no SPEC-REPAIR) and not a gate misfire.
