# MTA cascade-outcome export -- Operator Runbook

WO: WO-HARNESS-CASCADE-OUTCOME-EXPORT-01

CLI: `bun scripts/mta/export-cascade-outcomes.ts`

One-shot, read-only export of historical Cauldron cascade outcomes from
`remote_agent_workflow_runs` as versioned JSONL. The model-tier-advisor
ingestion WO consumes this format after it is frozen.

Format contract: `docs/mta/cascade-outcome-export.md` (`format_version: "1.0"`).

## Required CLI invocation examples

```bash
bun scripts/mta/export-cascade-outcomes.ts
bun scripts/mta/export-cascade-outcomes.ts --write --out /tmp/mta.jsonl
bun scripts/mta/export-cascade-outcomes.ts --since 2026-01-01T00:00:00Z --write --out /tmp/mta.jsonl
```

## Invocation

Required operator commands:

```bash
bun scripts/mta/export-cascade-outcomes.ts
bun scripts/mta/export-cascade-outcomes.ts --write --out /tmp/mta.jsonl
bun scripts/mta/export-cascade-outcomes.ts --since 2026-01-01T00:00:00Z --write --out /tmp/mta.jsonl
```

Dry-run (default). Prints a matching row count. Writes nothing.

```bash
bun scripts/mta/export-cascade-outcomes.ts
```

Write JSONL (overwrites `--out` idempotently):

```bash
bun scripts/mta/export-cascade-outcomes.ts --write --out /tmp/mta.jsonl
```

Optional since-filter (ISO timestamp; filtered in JS, not by raw SQL compare):

```bash
bun scripts/mta/export-cascade-outcomes.ts --since 2026-01-01T00:00:00Z --write --out /tmp/mta.jsonl
```

There is no `--dry-run` flag. Absence of `--write` is dry-run.

## Database resolution

Existing connection layer only. Do not invent `ARCHON_DB_PATH`.

- `DATABASE_URL` set -> Postgres
- else SQLite at `join(getArchonHome(), 'archon.db')`
- `getArchonHome()` honors `ARCHON_HOME`, else Docker `/.archon`, else `~/.archon`

Inside the app container the live file is `/.archon/archon.db`.
On the host, `/opt/bdc/archon-data/archon.db` is the compose `ARCHON_DATA`
mount of that same file -- it is not a process env var.

Operator live export either:

1. runs inside the container (default home is `/.archon`), or
2. sets `ARCHON_HOME` to the live data directory on the host.

SELECT only. Zero writes to the event store.

## Stop-3 live evidence (operator)

```bash
bun scripts/mta/export-cascade-outcomes.ts --write --out /tmp/mta.jsonl
wc -l /tmp/mta.jsonl
head -n 1 /tmp/mta.jsonl
```

Expect row count > 100 and a sample row that matches the schema doc.
Redact the sample before posting it in a manifest.
