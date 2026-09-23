'use strict';
/**
 * Backfill the honest run-outcome scorecard (WO-HARNESS-RUN-OUTCOME-SCORECARD-01).
 *
 * Scores historical runs from their events and writes the scorecard columns onto
 * the EXISTING remote_agent_run_outcomes row. It NEVER writes
 * remote_agent_workflow_events or remote_agent_workflow_runs.status, and it
 * NEVER creates an outcome row -- runs with no pre-existing outcome row are
 * skipped and counted (WO ambiguity resolution: option 1, UPDATE-only).
 *
 * Usage:
 *   bun scripts/mta/backfill-run-scorecard.ts --db /path/to/archon.db
 *     dry-run: print counts, write nothing
 *   bun scripts/mta/backfill-run-scorecard.ts --db /path/to/archon.db --write
 *     apply score columns (idempotent: re-score overwrites score columns only)
 *   bun scripts/mta/backfill-run-scorecard.ts --db ... --write --gh
 *     also resolve gh_pr_url via `gh` PR search (never in unit tests)
 *   bun scripts/mta/backfill-run-scorecard.ts --db ... --since 2026-01-01T00:00:00Z
 *
 * --db points at a SQLite archon.db (basename must be archon.db; the connection
 * layer resolves SQLite as ARCHON_HOME/archon.db). Prod apply against the live
 * host db is an operator step, OUT of scope for CI. Without --db the standard
 * connection layer (DATABASE_URL or ARCHON_HOME) is used.
 *
 * Engine-portable SQL: $N placeholders (SQLite adapter rewrites them); no BTRIM.
 */
import { basename, dirname } from 'node:path';
import type { IDatabase } from '../../packages/core/src/db/adapters/types';
import { closeDatabase, getDatabase, resetDatabase } from '../../packages/core/src/db/connection';
import { upsertRunScorecard } from '../../packages/core/src/db/workflows';
import {
  scoreRunFromEvents,
  type GhLookupResult,
  type ScorecardEventInput,
} from '../../packages/core/src/run-scorecard';
import { parseWoId, timestampMs } from './lib/extract-cascade-outcome';

export interface BackfillOptions {
  db: string | null;
  since: string | null;
  write: boolean;
  gh: boolean;
}

/** Injectable gh PR lookup: given a wo_id, resolve a PR url or null. */
export type GhPrLookup = (woId: string) => Promise<string | null>;

export interface BackfillDeps {
  /** Pre-resolved database handle (tests). When omitted, resolved from options.db / env. */
  db?: IDatabase;
  /** gh lookup used only with --gh. Defaults to the real (gh-spawning) lookup. */
  ghLookup?: GhPrLookup;
}

export interface BackfillSummary {
  total: number;
  scored: number;
  skippedNoOutcome: number;
  wrote: boolean;
}

interface BackfillRunRow {
  id: string;
  workflow_name: string;
  user_message: string | null;
  status: string;
  started_at: string | null;
  has_outcome: string | null;
}

interface RawEventRow {
  event_type: string;
  step_name: string | null;
  data: unknown;
  created_at: string;
}

function requireFlagValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.length === 0 || value.startsWith('--')) {
    throw new Error(`Missing value for ${flag}.`);
  }
  return value;
}

export function parseCliArgs(argv: string[]): BackfillOptions {
  let db: string | null = null;
  let since: string | null = null;
  let write = false;
  let gh = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined || arg === '') {
      throw new Error('Empty command-line argument.');
    }
    if (arg === '--write') {
      write = true;
      continue;
    }
    if (arg === '--gh') {
      gh = true;
      continue;
    }
    if (arg === '--db') {
      db = requireFlagValue(argv, i, '--db');
      i += 1;
      continue;
    }
    if (arg.startsWith('--db=')) {
      db = arg.slice('--db='.length);
      if (!db) throw new Error('Missing value for --db.');
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
    throw new Error(
      `Unknown argument: ${arg}. Accepted flags: --db <path>, --write, --gh, --since <iso>.`
    );
  }

  return { db, since, write, gh };
}

/**
 * Point the connection layer at an explicit SQLite archon.db. The layer only
 * opens ARCHON_HOME/archon.db, so the path's basename must be archon.db.
 */
function resolveDatabase(options: BackfillOptions): IDatabase {
  if (!options.db) return getDatabase();
  if (basename(options.db) !== 'archon.db') {
    throw new Error(
      `--db must point at a file named archon.db (got: ${options.db}). The connection layer resolves SQLite as ARCHON_HOME/archon.db.`
    );
  }
  delete process.env.DATABASE_URL;
  process.env.ARCHON_HOME = dirname(options.db);
  resetDatabase();
  return getDatabase();
}

/** Default gh PR lookup: search PRs whose title/body contains the wo_id. Spawns gh. */
async function defaultGhLookup(woId: string): Promise<string | null> {
  const proc = Bun.spawn({
    cmd: ['gh', 'pr', 'list', '--search', woId, '--state', 'all', '--limit', '1', '--json', 'url'],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (exitCode !== 0) return null;
  try {
    const parsed: unknown = JSON.parse(stdout.trim() || '[]');
    if (Array.isArray(parsed) && parsed.length > 0) {
      const first = parsed[0] as { url?: unknown };
      return typeof first.url === 'string' ? first.url : null;
    }
  } catch {
    return null;
  }
  return null;
}

async function loadRuns(db: IDatabase, since: string | null): Promise<BackfillRunRow[]> {
  const result = await db.query<BackfillRunRow>(
    `SELECT r.id, r.workflow_name, r.user_message, r.status, r.started_at,
            o.run_id AS has_outcome
       FROM remote_agent_workflow_runs r
       LEFT JOIN remote_agent_run_outcomes o ON o.run_id = r.id
      ORDER BY r.started_at ASC, r.id ASC`
  );
  const rows = [...result.rows];
  if (!since) return rows;
  const sinceMs = timestampMs(since);
  if (sinceMs === null) {
    throw new Error(`Invalid --since timestamp: ${since}. Expected ISO-8601.`);
  }
  return rows.filter(row => {
    const started = timestampMs(row.started_at);
    return started !== null && started >= sinceMs;
  });
}

async function loadEvents(db: IDatabase, runId: string): Promise<ScorecardEventInput[]> {
  const result = await db.query<RawEventRow>(
    `SELECT event_type, step_name, data, created_at
       FROM remote_agent_workflow_events
      WHERE workflow_run_id = $1
      ORDER BY created_at ASC`,
    [runId]
  );
  return result.rows.map(row => ({
    event_type: row.event_type,
    step_name: row.step_name,
    data: coerceEventData(row.data),
    created_at: row.created_at,
  }));
}

function coerceEventData(raw: unknown): Record<string, unknown> | null {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : { value: parsed };
    } catch {
      // Non-JSON string payload -- keep it searchable for skip-signal detection.
      return { raw: trimmed };
    }
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  return { value: raw };
}

async function resolveGh(woId: string | null, ghLookup: GhPrLookup): Promise<GhLookupResult> {
  // wo_id null => lookup not applicable; join is complete, no PR url.
  if (woId === null) return { prUrl: null, joinComplete: true };
  const prUrl = await ghLookup(woId);
  // A miss after lookup is still a complete join (just no PR); it never flips
  // landing_ok / honest_success (the scorer enforces this).
  return { prUrl, joinComplete: true };
}

export async function runBackfill(
  options: BackfillOptions,
  deps: BackfillDeps = {}
): Promise<BackfillSummary> {
  const db = deps.db ?? resolveDatabase(options);
  const ghLookup = deps.ghLookup ?? defaultGhLookup;
  const scoredAt = new Date().toISOString();

  const runs = await loadRuns(db, options.since);
  let scored = 0;
  let skippedNoOutcome = 0;

  for (const run of runs) {
    const events = await loadEvents(db, run.id);
    const woId = parseWoId(run.user_message);
    const gh = options.gh ? await resolveGh(woId, ghLookup) : undefined;
    const scorecard = scoreRunFromEvents({
      status: run.status,
      userMessage: run.user_message,
      workflowName: run.workflow_name,
      events,
      gh,
    });

    if (run.has_outcome == null) {
      // UPDATE-only writer: no outcome row to update. Skip and count.
      skippedNoOutcome += 1;
      continue;
    }

    if (options.write) {
      const updated = await upsertRunScorecard(run.id, scorecard, scoredAt);
      if (updated) scored += 1;
      else skippedNoOutcome += 1;
    } else {
      // Dry-run: this run WOULD be scored.
      scored += 1;
    }
  }

  return { total: runs.length, scored, skippedNoOutcome, wrote: options.write };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  try {
    const options = parseCliArgs(argv);
    const summary = await runBackfill(options);
    if (options.write) {
      console.log(
        `[backfill] wrote scorecard to ${String(summary.scored)} run(s); ` +
          `${String(summary.skippedNoOutcome)} skipped (no outcome row); ` +
          `${String(summary.total)} run(s) examined.`
      );
    } else {
      console.log(
        `[dry-run] ${String(summary.scored)} run(s) would be scored; ` +
          `${String(summary.skippedNoOutcome)} would be skipped (no outcome row); ` +
          `${String(summary.total)} run(s) examined. Re-run with --write to apply.`
      );
    }
    return 0;
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`backfill-run-scorecard failed: ${detail}`);
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
      console.error(`backfill-run-scorecard failed: ${detail}`);
      process.exitCode = 1;
    });
}
