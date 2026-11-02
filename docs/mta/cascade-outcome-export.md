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

Read-only SELECT from `remote_agent_workflow_runs`. No join to
`remote_agent_run_outcomes` (required JSONL fields do not need it). Archived
and non-archived rows are both exported.

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
| `status` | string | no | `status` |
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
  "attribution_complete": true
}
```
