import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempDirWithRetry } from '../../../packages/core/src/test/temp-dir';
import {
  closeDatabase,
  getDatabase,
  resetDatabase,
} from '../../../packages/core/src/db/connection';
import type { IDatabase } from '../../../packages/core/src/db/adapters/types';
import { upsertRunOutcome } from '../../../packages/core/src/db/workflows';
import type { RunOutcome } from '../../../packages/workflows/src/reliability/types';
import { parseCliArgs, runBackfill } from '../backfill-run-scorecard';

let savedArchonHome: string | undefined;
let savedDatabaseUrl: string | undefined;
let testHome: string;

function isolateHome(): void {
  savedArchonHome = process.env.ARCHON_HOME;
  savedDatabaseUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  testHome = mkdtempSync(join(tmpdir(), 'mta-backfill-scorecard-'));
  process.env.ARCHON_HOME = testHome;
  resetDatabase();
}

async function restoreHome(): Promise<void> {
  await closeDatabase();
  resetDatabase();
  if (savedArchonHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = savedArchonHome;
  if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedDatabaseUrl;
  try {
    removeTempDirWithRetry(testHome);
  } catch {
    // Best-effort temp cleanup.
  }
}

const OUTCOME: RunOutcome = {
  executionState: 'completed',
  deliverableState: 'none',
  validationState: 'not_run',
  recoveryState: 'not_needed',
  routeState: 'current',
  primaryReason: 'execution_completed',
  reasonCodes: ['execution_completed'],
  evidenceRefs: [],
};

async function seedConversation(db: IDatabase, id = 'conv-backfill-1'): Promise<string> {
  await db.query(
    `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id)
     VALUES ($1, $2, $3)`,
    [id, 'test', `plat-${id}`]
  );
  return id;
}

async function seedRun(
  db: IDatabase,
  opts: {
    id: string;
    conversationId: string;
    userMessage: string;
    status: string;
    startedAt: string;
  }
): Promise<void> {
  await db.query(
    `INSERT INTO remote_agent_workflow_runs
       (id, conversation_id, workflow_name, user_message, status, metadata, started_at, completed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      opts.id,
      opts.conversationId,
      'bdc-feature-development',
      opts.userMessage,
      opts.status,
      '{}',
      opts.startedAt,
      opts.startedAt,
    ]
  );
}

async function seedEvent(
  db: IDatabase,
  opts: {
    id: string;
    runId: string;
    eventType: string;
    stepName: string | null;
    data: Record<string, unknown>;
    createdAt: string;
  }
): Promise<void> {
  await db.query(
    `INSERT INTO remote_agent_workflow_events
       (id, workflow_run_id, event_type, step_index, step_name, data, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      opts.id,
      opts.runId,
      opts.eventType,
      null,
      opts.stepName,
      JSON.stringify(opts.data),
      opts.createdAt,
    ]
  );
}

interface EventSnapshotRow {
  workflow_run_id: string;
  event_type: string;
  step_name: string | null;
  data: string | null;
  created_at: string;
}

async function snapshotEvents(db: IDatabase): Promise<string> {
  const result = await db.query<EventSnapshotRow>(
    `SELECT workflow_run_id, event_type, step_name, data, created_at
       FROM remote_agent_workflow_events
      ORDER BY workflow_run_id ASC, created_at ASC, event_type ASC`
  );
  return JSON.stringify([...result.rows]);
}

interface ScoreRow {
  run_id: string;
  score_version: string | null;
  honest_success: number | null;
  landing_ok: number | null;
  landing_skipped: number | null;
  pipeline_axis: string | null;
  last_failed_step: string | null;
  status_column: string | null;
}

async function scoreRows(db: IDatabase): Promise<Map<string, ScoreRow>> {
  const result = await db.query<ScoreRow>(
    `SELECT run_id, score_version, honest_success, landing_ok, landing_skipped,
            pipeline_axis, last_failed_step, status_column
       FROM remote_agent_run_outcomes
      ORDER BY run_id ASC`
  );
  return new Map(result.rows.map(r => [r.run_id, r]));
}

async function seedThreeRuns(db: IDatabase): Promise<void> {
  const conv = await seedConversation(db);

  // Run A: landing node completed (honest success). Has an outcome row.
  await seedRun(db, {
    id: 'run-a',
    conversationId: conv,
    userMessage: 'WO_ID=WO-HARNESS-A-01 --project bdc-harness',
    status: 'completed',
    startedAt: '2026-08-01 10:00:00',
  });
  await seedEvent(db, {
    id: 'ev-a1',
    runId: 'run-a',
    eventType: 'node_completed',
    stepName: 'commit-and-push',
    data: {},
    createdAt: '2026-08-01 10:03:00',
  });
  await seedEvent(db, {
    id: 'ev-a2',
    runId: 'run-a',
    eventType: 'workflow_completed',
    stepName: null,
    data: {},
    createdAt: '2026-08-01 10:05:00',
  });
  await upsertRunOutcome('run-a', OUTCOME, '2026-08-01T09:00:00.000Z');

  // Run B: no landing, plan-review failure (honest failure). Has an outcome row.
  await seedRun(db, {
    id: 'run-b',
    conversationId: conv,
    userMessage: 'WO_ID=WO-HARNESS-B-01 --project bdc-harness',
    status: 'completed',
    startedAt: '2026-08-01 11:00:00',
  });
  await seedEvent(db, {
    id: 'ev-b1',
    runId: 'run-b',
    eventType: 'node_failed',
    stepName: 'plan-review',
    data: {},
    createdAt: '2026-08-01 11:03:00',
  });
  await seedEvent(db, {
    id: 'ev-b2',
    runId: 'run-b',
    eventType: 'workflow_completed',
    stepName: null,
    data: {},
    createdAt: '2026-08-01 11:05:00',
  });
  await upsertRunOutcome('run-b', OUTCOME, '2026-08-01T09:00:00.000Z');

  // Run C: NO pre-existing outcome row -> must be skipped-and-counted (UPDATE-only writer).
  await seedRun(db, {
    id: 'run-c',
    conversationId: conv,
    userMessage: 'WO_ID=WO-HARNESS-C-01 --project bdc-harness',
    status: 'failed',
    startedAt: '2026-08-01 12:00:00',
  });
  await seedEvent(db, {
    id: 'ev-c1',
    runId: 'run-c',
    eventType: 'node_failed',
    stepName: 'implement',
    data: {},
    createdAt: '2026-08-01 12:03:00',
  });
  await seedEvent(db, {
    id: 'ev-c2',
    runId: 'run-c',
    eventType: 'workflow_failed',
    stepName: null,
    data: {},
    createdAt: '2026-08-01 12:05:00',
  });
}

describe('backfill-run-scorecard CLI args', () => {
  test('parses --db, --write, --gh, --since', () => {
    expect(
      parseCliArgs(['--db', '/x/archon.db', '--write', '--gh', '--since', '2026-01-01T00:00:00Z'])
    ).toEqual({ db: '/x/archon.db', write: true, gh: true, since: '2026-01-01T00:00:00Z' });
    expect(parseCliArgs([])).toEqual({ db: null, write: false, gh: false, since: null });
    expect(parseCliArgs(['--db=/y/archon.db'])).toEqual({
      db: '/y/archon.db',
      write: false,
      gh: false,
      since: null,
    });
  });

  test('rejects unknown args and missing values', () => {
    expect(() => parseCliArgs(['--bogus'])).toThrow(/Unknown argument/);
    expect(() => parseCliArgs(['--db'])).toThrow(/Missing value for --db/);
    expect(() => parseCliArgs(['--since'])).toThrow(/Missing value for --since/);
  });

  test('runBackfill rejects a --db path whose basename is not archon.db', async () => {
    await expect(
      runBackfill({ db: '/tmp/not-the-db.sqlite', write: false, gh: false, since: null })
    ).rejects.toThrow(/must point at a file named archon.db/);
  });
});

describe('backfill-run-scorecard', () => {
  beforeEach(() => {
    isolateHome();
  });

  afterEach(async () => {
    await restoreHome();
  });

  // Test 4 (WO Section 7): idempotent, event-immutable, skip-and-count for no-outcome rows.
  test('idempotent --write; never mutates events or runs.status; skips runs with no outcome row', async () => {
    const db = getDatabase();
    await seedThreeRuns(db);

    const eventsBefore = await snapshotEvents(db);
    const statusesBefore = await db.query<{ id: string; status: string }>(
      'SELECT id, status FROM remote_agent_workflow_runs ORDER BY id ASC'
    );

    // Dry-run changes nothing.
    const dry = await runBackfill({ db: null, write: false, gh: false, since: null }, { db });
    expect(dry.total).toBe(3);
    expect(dry.wrote).toBe(false);
    const afterDry = await scoreRows(db);
    expect(afterDry.get('run-a')?.score_version).toBeNull();
    expect(afterDry.get('run-b')?.score_version).toBeNull();
    expect(afterDry.has('run-c')).toBe(false); // no outcome row at all

    // First --write.
    const first = await runBackfill({ db: null, write: true, gh: false, since: null }, { db });
    expect(first.total).toBe(3);
    expect(first.scored).toBe(2); // run-a, run-b
    expect(first.skippedNoOutcome).toBe(1); // run-c has no outcome row

    const scores1 = await scoreRows(db);
    expect(scores1.get('run-a')?.score_version).toBe('1.0');
    expect(scores1.get('run-a')?.honest_success).toBe(1);
    expect(scores1.get('run-a')?.landing_ok).toBe(1);
    expect(scores1.get('run-a')?.pipeline_axis).toBe('success');
    expect(scores1.get('run-a')?.status_column).toBe('completed');

    expect(scores1.get('run-b')?.honest_success).toBe(0);
    expect(scores1.get('run-b')?.landing_ok).toBe(0);
    expect(scores1.get('run-b')?.last_failed_step).toBe('plan-review');
    expect(scores1.get('run-b')?.pipeline_axis).toBe('spec');
    // run-c never got an outcome row, so it is absent.
    expect(scores1.has('run-c')).toBe(false);

    // Events are untouched by the write.
    expect(await snapshotEvents(db)).toBe(eventsBefore);

    // Second --write is idempotent: identical score columns, still skips run-c.
    const second = await runBackfill({ db: null, write: true, gh: false, since: null }, { db });
    expect(second.scored).toBe(2);
    expect(second.skippedNoOutcome).toBe(1);
    const scores2 = await scoreRows(db);
    expect(scores2.get('run-a')).toEqual(scores1.get('run-a')!);
    expect(scores2.get('run-b')).toEqual(scores1.get('run-b')!);

    // Events STILL untouched after re-run.
    expect(await snapshotEvents(db)).toBe(eventsBefore);

    // runs.status column never written by the backfill.
    const statusesAfter = await db.query<{ id: string; status: string }>(
      'SELECT id, status FROM remote_agent_workflow_runs ORDER BY id ASC'
    );
    expect(statusesAfter.rows).toEqual(statusesBefore.rows);
  });

  test('--gh uses the injected lookup (no gh spawn) and never flips honest_success', async () => {
    const db = getDatabase();
    await seedThreeRuns(db);
    const ghCalls: string[] = [];
    const summary = await runBackfill(
      { db: null, write: true, gh: true, since: null },
      {
        db,
        ghLookup: async (woId: string) => {
          ghCalls.push(woId);
          return `https://github.com/thinmansoftware/bdc-harness/pull/1`;
        },
      }
    );
    expect(summary.scored).toBe(2);
    // Lookup was attempted for each run that has a wo_id (all 3 do).
    expect(ghCalls).toContain('WO-HARNESS-A-01');
    expect(ghCalls).toContain('WO-HARNESS-B-01');
    const scores = await scoreRows(db);
    // gh hit does not flip run-b (a genuine failure) into a success.
    expect(scores.get('run-b')?.honest_success).toBe(0);
  });

  test('--since filters out older runs', async () => {
    const db = getDatabase();
    await seedThreeRuns(db);
    const summary = await runBackfill(
      { db: null, write: true, gh: false, since: '2026-08-01T11:30:00Z' },
      { db }
    );
    // Only run-b (11:00) and run-c (12:00) start at/after the cutoff? run-b is
    // 11:00 which is BEFORE 11:30, so only run-c (12:00) survives.
    expect(summary.total).toBe(1);
    expect(summary.skippedNoOutcome).toBe(1); // run-c has no outcome row
    expect(summary.scored).toBe(0);
  });
});
