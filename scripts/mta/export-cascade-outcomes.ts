'use strict';
/**
 * One-shot MTA cascade-outcome export (WO-HARNESS-CASCADE-OUTCOME-EXPORT-01).
 *
 * Reads remote_agent_workflow_runs and emits versioned JSONL for the
 * model-tier-advisor. SELECT only. Zero writes to the event store.
 *
 * Usage:
 *   bun scripts/mta/export-cascade-outcomes.ts
 *     dry-run: print matching row count, write nothing
 *   bun scripts/mta/export-cascade-outcomes.ts --write --out /tmp/mta.jsonl
 *     emit JSONL (overwrite --out idempotently; stdout if --out omitted)
 *   bun scripts/mta/export-cascade-outcomes.ts --since 2026-01-01T00:00:00Z
 *
 * DB resolution (existing connection layer only):
 *   DATABASE_URL set -> Postgres
 *   else SQLite at join(getArchonHome(), 'archon.db')
 *   getArchonHome() honors ARCHON_HOME, else Docker /.archon, else ~/.archon
 */
import { writeFileSync } from 'node:fs';
import { closeDatabase, getDatabase } from '../../packages/core/src/db/connection';
import {
  runRowToOutcomeRecord,
  timestampMs,
  type CascadeOutcomeRecord,
  type WorkflowRunExportRow,
} from './lib/extract-cascade-outcome';

export interface CliOptions {
  since: string | null;
  out: string | null;
  write: boolean;
}

export type WorkflowRunRowLoader = () => Promise<WorkflowRunExportRow[]>;

export interface ExportDeps {
  loadRows?: WorkflowRunRowLoader;
}

const ISO_SINCE_RE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?)?$/;

function calendarDateIsReal(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const utc = new Date(Date.UTC(year, month - 1, day));
  return (
    utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day
  );
}

export function validateSinceTimestamp(sinceIso: string): string {
  const trimmed = sinceIso.trim();
  const parts = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed);
  const calendarOk =
    parts !== null && calendarDateIsReal(Number(parts[1]), Number(parts[2]), Number(parts[3]));
  if (!trimmed || !ISO_SINCE_RE.test(trimmed) || !calendarOk || timestampMs(trimmed) === null) {
    throw new Error(
      `Invalid --since timestamp: ${sinceIso}. Expected ISO-8601 (example: 2026-01-01T00:00:00Z).`
    );
  }
  return trimmed;
}

function requireFlagValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.length === 0 || value.startsWith('--')) {
    throw new Error(`Missing value for ${flag}.`);
  }
  return value;
}

export function parseCliArgs(argv: string[]): CliOptions {
  let since: string | null = null;
  let out: string | null = null;
  let write = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined || arg === '') {
      throw new Error('Empty command-line argument.');
    }
    if (arg === '--write') {
      write = true;
      continue;
    }
    if (arg === '--since') {
      since = requireFlagValue(argv, i, '--since');
      i += 1;
      continue;
    }
    if (arg.startsWith('--since=')) {
      since = arg.slice('--since='.length);
      if (!since) throw new Error('Missing value for --since.');
      continue;
    }
    if (arg === '--out') {
      out = requireFlagValue(argv, i, '--out');
      i += 1;
      continue;
    }
    if (arg.startsWith('--out=')) {
      out = arg.slice('--out='.length);
      if (!out) throw new Error('Missing value for --out.');
      continue;
    }
    throw new Error(
      `Unknown argument: ${arg}. Accepted flags: --write, --since <iso>, --out <path>.`
    );
  }

  if (since !== null) {
    since = validateSinceTimestamp(since);
  }

  return { since, out, write };
}

function describeDatabaseError(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  if (/ENOENT|no such file|SQLITE_CANTOPEN|unable to open/i.test(detail)) {
    return `Database file is not reachable via ARCHON_HOME/archon.db. ${detail}`;
  }
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|timeout|authentication|password|SASL/i.test(detail)) {
    return `Database connection failed. Check DATABASE_URL. ${detail}`;
  }
  return `Failed to read remote_agent_workflow_runs (SELECT only). Check DATABASE_URL or ARCHON_HOME/archon.db. ${detail}`;
}

export async function loadWorkflowRunRows(): Promise<WorkflowRunExportRow[]> {
  try {
    const db = getDatabase();
    const result = await db.query<WorkflowRunExportRow>(
      `SELECT id, workflow_name, user_message, status, metadata, started_at, completed_at
         FROM remote_agent_workflow_runs
        ORDER BY started_at ASC, id ASC`
    );
    return [...result.rows];
  } catch (error: unknown) {
    throw new Error(describeDatabaseError(error));
  }
}

export function filterRowsSince(
  rows: WorkflowRunExportRow[],
  sinceIso: string | null
): WorkflowRunExportRow[] {
  if (!sinceIso) return rows;
  const sinceMs = timestampMs(validateSinceTimestamp(sinceIso));
  if (sinceMs === null) {
    throw new Error(`Invalid --since timestamp: ${sinceIso}`);
  }
  return rows.filter(row => {
    const started = timestampMs(row.started_at);
    return started !== null && started >= sinceMs;
  });
}

export async function collectOutcomeRecords(
  sinceIso: string | null,
  loadRows: WorkflowRunRowLoader = loadWorkflowRunRows
): Promise<CascadeOutcomeRecord[]> {
  const rows = filterRowsSince(await loadRows(), sinceIso);
  return rows.map(runRowToOutcomeRecord);
}

export function recordsToJsonl(records: CascadeOutcomeRecord[]): string {
  if (records.length === 0) return '';
  return records.map(record => JSON.stringify(record)).join('\n') + '\n';
}

export async function runExport(
  options: CliOptions,
  deps: ExportDeps = {}
): Promise<{ count: number; wrote: boolean }> {
  const records = await collectOutcomeRecords(options.since, deps.loadRows ?? loadWorkflowRunRows);
  const count = records.length;

  if (!options.write) {
    console.log(
      `[dry-run] ${String(count)} cascade outcome row(s) match. Re-run with --write to emit JSONL.`
    );
    return { count, wrote: false };
  }

  const jsonl = recordsToJsonl(records);
  if (options.out) {
    writeFileSync(options.out, jsonl, 'utf8');
  } else {
    process.stdout.write(jsonl);
  }
  return { count, wrote: true };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  try {
    const options = parseCliArgs(argv);
    await runExport(options);
    return 0;
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`export-cascade-outcomes failed: ${detail}`);
    return 1;
  } finally {
    await closeDatabase();
  }
}

const isDirectRun = typeof Bun !== 'undefined' && Bun.main === import.meta.path;

if (isDirectRun) {
  main()
    .then(code => {
      if (code !== 0) process.exitCode = code;
    })
    .catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`export-cascade-outcomes failed: ${detail}`);
      process.exitCode = 1;
    });
}
