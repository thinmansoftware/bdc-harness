# Cascade Outcome Export -- Format 1.0

Document version: 1.0
Implementation version: 1.0
JSONL field: `"format_version": "1.0"`
format_version: 1.0

Frozen contract for `WO-HARNESS-CASCADE-OUTCOME-EXPORT-01`.
The model-tier-advisor history ingestion WO consumes this document.
This document version number is the same string stored in every JSONL row
as `format_version` (`"1.0"`), matching `CASCADE_OUTCOME_FORMAT_VERSION`
in `scripts/mta/lib/extract-cascade-outcome.ts`.

Producer: `scripts/mta/export-cascade-outcomes.ts`
Extractor: `scripts/mta/lib/extract-cascade-outcome.ts`

Every JSONL row carries `format_version: "1.0"`. Changing field names, types,
or parse tokens requires a new format version.

## Invocation

Dry-run (default -- prints a row count, writes nothing):

```bash
bun scripts/mta/export-cascade-outcomes.ts
```

Write JSONL (overwrite `--out` idempotently; omit `--out` to emit on stdout):

```bash
bun scripts/mta/export-cascade-outcomes.ts --write --out /tmp/mta.jsonl
```

Optional `--since <iso>` filters in process after a full SELECT. Do not compare
raw SQLite `started_at` (`YYYY-MM-DD HH:MM:SS`) lexically against an ISO
string that contains `T`.

## Database

Read-only SELECT from `remote_agent_workflow_runs` LEFT JOINed to
`remote_agent_run_outcomes` on `run_id`
(WO-HARNESS-RUN-OUTCOME-SCORECARD-01). The join supplies the honest scorecard
columns that now DERIVE the `status` field (see "Honest status source" below).
Runs with no scored outcome row yield null scorecard columns and map to
`status: "failed"`. Archived and non-archived rows are both exported.

Connection resolution is existing behavior only:

- `DATABASE_URL` set -> Postgres
- else SQLite at `join(getArchonHome(), 'archon.db')`
- `getArchonHome()` honors `ARCHON_HOME`, else Docker `/.archon`, else `~/.archon`

Host path `/opt/bdc/archon-data/archon.db` is the compose `ARCHON_DATA` mount.
Inside the app container that file is `/.archon/archon.db`. There is no
`ARCHON_DB_PATH`.

SQL is engine-portable: `TRIM` not `BTRIM`; `$1` placeholders (the SQLite
adapter rewrites them). Metadata JSON is parsed in process (`JSON.parse` if
string; already-object if Postgres). No engine-specific JSON operators.

## user_message parse tokens

Locked tokens. Do not invent a narrative preamble.

| Field | Accepted forms | Missing value |
| --- | --- | --- |
| `wo_id` | `WO_ID=<id>` (assignment, preferred) or first `WO-[A-Z0-9-]+` token | `null` |
| `project` | `--project <name>` or `--project=<name>` | `null` |
| `prior_tier` | `prior_tier=<value>` or `prior-tier <value>` | `null` |

Unparseable `wo_id` / `project` stay null. The row is still emitted.

No in-repo fire/cascade constructor emits a prior-tier narrative string.
Escalation packets (`=== ESCALATION PACKET (from prior lower-tier attempt) ===`)
are context for the successor prompt, not a `prior_tier` token. Only the two
tokens above populate `prior_tier`.

## Row schema (`format_version: "1.0"`)

| Field | Type | Null | Source |
| --- | --- | --- | --- |
| `format_version` | string | no | always `"1.0"` |
| `run_id` | string | no | `remote_agent_workflow_runs.id` |
| `wo_id` | string | yes | parsed from `user_message` |
| `project` | string | yes | parsed from `user_message` |
| `workflow_name` | string | no | `workflow_name` (this is the entry lane) |
| `prior_tier` | string | yes | parsed from `user_message`; omit-as-null when absent |
| `status` | string | no | DERIVED from the scorecard (see "Honest status source") -- NEVER `runs.status` |
| `node_counts` | object | yes | `metadata.node_counts` when present |
| `models_served` | string[] | no | served models from `metadata.node_model_summary` only |
| `model_mismatches` | number | no | count of mismatch flags in `node_model_summary` (0 if none) |
| `cost_usd` | number | yes | `metadata.total_cost_usd` |
| `tokens` | number | yes | `metadata.total_tokens` |
| `started_at` | string | yes | ISO-8601 from `started_at` |
| `completed_at` | string | yes | ISO-8601 from `completed_at` |
| `duration_s` | number | yes | whole seconds between timestamps; null if either missing |
| `attribution_complete` | boolean | no | see known gap |

Do not emit `class`, `tags`, or `entry_lane`. `workflow_name` already covers lane.

## Honest status source (WO-HARNESS-RUN-OUTCOME-SCORECARD-01)

`format_version` stays `1.0`. What changed is the SOURCE of the existing
`status` field. It is NO LONGER a copy of `remote_agent_workflow_runs.status`
(that column lies: `completed` does not mean the deliverable landed). It is now
derived from the honest scorecard columns on `remote_agent_run_outcomes`:

- `completed` iff `landing_ok = 1` (a landing node -- `commit-and-push` or
  `open-pr-if-needed` -- actually completed)
- `skipped` iff `landing_skipped = 1` and `landing_ok != 1` (build correctly
  short-circuited as already-satisfied)
- `cancelled` iff `terminal_event = workflow_cancelled` (and not completed/skipped)
- `failed` otherwise (includes `runs.status = completed` with no landing and no
  skip, and any run with no scored outcome row yet)

MTA `cascade_reader` counts only `status in {completed, success, succeeded}` as
success, so a `skipped` run is correctly NOT counted as a build success, and a
lying `completed` run is now honestly `failed`.

### Optional extra keys

These OPTIONAL keys are appended to every row. MTA `cascade_reader` IGNORES
unknown keys, so they do not affect the frozen `1.0` contract. All are null when
the run has no scored outcome row.

| Field | Type | Source |
| --- | --- | --- |
| `landing_ok` | number\|null | 1 iff a landing node `node_completed` exists |
| `landing_skipped` | number\|null | 1 iff `landing_ok=0` and an already-satisfied skip signal exists |
| `pipeline_axis` | string\|null | success\|skip\|spec\|build\|landing\|review\|deploy\|unknown |
| `module_axis` | string\|null | loop\|tools\|observation\|context\|stop\|unknown\|none |
| `last_failed_step` | string\|null | step_name of the latest `node_failed` |
| `honest_success` | number\|null | 1 iff `landing_ok=1` or `landing_skipped=1` |
| `score_partial` | number\|null | 1 when the score is incomplete (no terminal event, tie, no gh join, or non-feature-dev lane) |
| `score_version` | string\|null | scorecard rubric version (`1.0`) |
| `gh_pr_url` | string\|null | PR url from an optional `--gh` join (never flips landing/honest_success) |
| `gh_join_complete` | number\|null | 1 iff a gh lookup ran or was not applicable |
| `status_column` | string\|null | copy of `runs.status` at score time (contrast only) |

The scorecard columns are written by the forward path (workflow terminal
persist) and by `scripts/mta/backfill-run-scorecard.ts`. Neither the export nor
the scorer ever writes `remote_agent_workflow_events` or
`remote_agent_workflow_runs.status`.

### Test gate (Stop 2)

`bunfig.toml` sets `[test] root = "./packages"`. Bare args to `bun test` are
filters inside that root, so `scripts/mta/__tests__/*.test.ts` are never
discovered and bun still exits 0. Use explicit `./` paths (same pattern as
`test:dispatch-migration-smoke`):

```bash
bun run test:run-scorecard
```

That is:

```bash
bun test ./packages/core/src/run-scorecard.test.ts ./scripts/mta/__tests__/export-cascade-outcomes.test.ts ./scripts/mta/__tests__/backfill-run-scorecard.test.ts
```

Expected: 30 pass / 0 fail / 3 files. Do not treat a 12/12 on 1 file as this gate.

## Known gap -- failure attribution

Live schema audit 2026-08-24: model attribution exists on `node_completed`
and is missing on `node_failed`. This export does not backfill that gap.

A row sets `attribution_complete: false` when any of:

- `metadata.node_model_summary` is missing or empty
- any summary entry lacks a served model
- `metadata.node_counts.failed > 0` (failed nodes lack attribution)

`models_served` is taken only from present `node_model_summary` entries.
Never invent served models.

## Edge cases

- Missing WO_ID / project: both fields are `null`; row still emits.
- Missing `completed_at`: `completed_at` and `duration_s` are `null`.
- Empty `node_model_summary`: `models_served` is `[]`, `model_mismatches` is `0`,
  `attribution_complete` is `false`.
- `--since` invalid ISO: CLI exits non-zero; no file is written.
- Dry-run (no `--write`): prints a count; does not create `--out`.
- `--write --out <path>`: overwrites that path idempotently.

## Sample row

```json
{
  "format_version": "1.0",
  "run_id": "11111111-1111-4111-8111-111111111111",
  "wo_id": "WO-HARNESS-CASCADE-OUTCOME-EXPORT-01",
  "project": "bdc-harness",
  "workflow_name": "bdc-feature-development",
  "prior_tier": null,
  "status": "completed",
  "node_counts": { "completed": 3, "failed": 0, "skipped": 0, "total": 3 },
  "models_served": ["claude-sonnet-4-5"],
  "model_mismatches": 0,
  "cost_usd": 1.25,
  "tokens": 4000,
  "started_at": "2026-08-01T10:00:00.000Z",
  "completed_at": "2026-08-01T10:10:00.000Z",
  "duration_s": 600,
  "attribution_complete": true,
  "landing_ok": 1,
  "landing_skipped": 0,
  "pipeline_axis": "success",
  "module_axis": "none",
  "last_failed_step": null,
  "honest_success": 1,
  "score_partial": 1,
  "score_version": "1.0",
  "gh_pr_url": null,
  "gh_join_complete": 0,
  "status_column": "completed"
}
```

The `status` above is `completed` because `landing_ok = 1`, NOT because
`status_column` (runs.status) was `completed`.
