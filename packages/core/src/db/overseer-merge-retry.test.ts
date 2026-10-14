import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { unlinkSync } from 'fs';
import { join } from 'path';
import { SqliteAdapter } from './adapters/sqlite';

let db: SqliteAdapter;
let path = '';
mock.module('./connection', () => ({ getDatabase: () => db }));

import {
  claimVerdictForMergeExecution,
  deferVerdictClaimForMergeExecution,
  listUnactionedFlagMergeReadyVerdicts,
  requeueTransientMergeSkips,
} from './overseer';

const classify = (reason: string): 'transient' | 'terminal' =>
  reason === 'mergeable_state_not_clean' || /rate limit/i.test(reason) ? 'transient' : 'terminal';

function cleanup(file: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(file + suffix);
    } catch {
      // File may not exist.
    }
  }
}

async function seedRun(id: string): Promise<void> {
  await db.query(
    `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id)
     VALUES ($1, 'test', $1)`,
    [`conv-${id}`]
  );
  await db.query(
    `INSERT INTO remote_agent_workflow_runs
       (id, conversation_id, workflow_name, user_message, status, metadata)
     VALUES ($1, $2, 'test', 'test', 'completed', '{}')`,
    [`run-${id}`, `conv-${id}`]
  );
}

async function seedVerdict(
  id: string,
  actionReason: string,
  mutationSent: boolean,
  actionedAt = '2026-10-14T00:00:00.000Z'
): Promise<void> {
  await seedRun(id);
  await db.query(
    `INSERT INTO overseer_verdicts
       (id, run_id, wo_id, head_sha, proposed_action, actioned_at, mutation_sent, action_reason)
     VALUES ($1, $2, $3, $4, 'flag_merge_ready', $5, $6, $7)`,
    [id, `run-${id}`, `WO-${id}`, `head-${id}`, actionedAt, mutationSent, actionReason]
  );
}

beforeEach(() => {
  path = join(import.meta.dir, `.test-merge-retry-${Date.now()}-${Math.random()}.db`);
  db = new SqliteAdapter(path);
});

afterEach(async () => {
  await db.close();
  cleanup(path);
});

describe('overseer merge retry store', () => {
  test('requeueTransientMergeSkips clears only transient unmerged rows and is idempotent', async () => {
    await seedVerdict('a', 'mergeable_state_not_clean', false);
    await seedVerdict('b', 'merge_failed:API rate limit exceeded', false);
    await seedVerdict('c', 'spec_only', false);
    await seedVerdict('d', 'head_moved', false);
    await seedVerdict('e', 'merge_executed', true);
    await seedVerdict('f', 'processing', false);
    await seedVerdict('g', 'transient_exhausted:mergeable_state_not_clean', false);
    const dry = await requeueTransientMergeSkips({ dryRun: true, classify });
    expect(dry.matched).toBe(2);
    expect(dry.requeued).toBe(0);
    const applied = await requeueTransientMergeSkips({ dryRun: false, classify });
    expect(applied.requeued).toBe(2);
    const rows = await db.query<{
      id: string;
      actioned_at: string | null;
      action_reason: string | null;
      merge_attempts: number;
      merge_not_before: string | null;
      merge_last_transient_reason: string | null;
    }>(`SELECT id, actioned_at, action_reason, merge_attempts, merge_not_before,
              merge_last_transient_reason FROM overseer_verdicts ORDER BY id`);
    expect(rows.rows.filter(row => row.actioned_at === null).map(row => row.id)).toEqual(['a', 'b']);
    expect(rows.rows[0]?.merge_last_transient_reason).toBe('mergeable_state_not_clean');
    expect((await requeueTransientMergeSkips({ dryRun: false, classify }))).toEqual({
      matched: 0,
      requeued: 0,
      rows: [],
    });
  });

  test('listUnactionedFlagMergeReadyVerdicts hides deferred rows until merge_not_before passes', async () => {
    await seedVerdict('deferred', 'waiting', false);
    await db.query(
      `UPDATE overseer_verdicts SET action_reason = 'processing' WHERE id = 'deferred'`
    );
    const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    expect(await deferVerdictClaimForMergeExecution('deferred', 'mergeable_state_not_clean', future)).toBe(true);
    expect((await listUnactionedFlagMergeReadyVerdicts()).map(row => row.id)).not.toContain('deferred');
    await db.query(`UPDATE overseer_verdicts SET merge_not_before = '2000-01-01T00:00:00.000Z' WHERE id = 'deferred'`);
    const listed = await listUnactionedFlagMergeReadyVerdicts();
    expect(listed.find(row => row.id === 'deferred')?.merge_attempts).toBe(1);
    expect(await deferVerdictClaimForMergeExecution('deferred', 'again', future)).toBe(false);
    expect(await claimVerdictForMergeExecution('deferred')).toBe(true);
  });

  test('sqlite upgrade adds merge retry columns to an existing database', async () => {
    await db.close();
    cleanup(path);
    const raw = new Database(path);
    raw.run(`CREATE TABLE overseer_verdicts (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, wo_id TEXT NOT NULL, head_sha TEXT NOT NULL DEFAULT '',
      evidence_digest TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'claimed', verdict TEXT,
      confidence REAL, model TEXT, model_rung INTEGER, proposed_action TEXT, proposed_tier INTEGER,
      required_tier INTEGER, effective_tier INTEGER, hint_action TEXT, hint_error_class TEXT, reason TEXT,
      evidence TEXT, retry_count INTEGER NOT NULL DEFAULT 0, actioned_at TEXT, mutation_sent INTEGER,
      action_reason TEXT, merge_sha TEXT, pr_url TEXT,
      created_at TEXT NOT NULL DEFAULT 'now', updated_at TEXT NOT NULL DEFAULT 'now')`);
    raw.run(`INSERT INTO overseer_verdicts (id, run_id, wo_id) VALUES ('old', 'run', 'WO-OLD')`);
    raw.close();
    db = new SqliteAdapter(path);
    const columns = await db.query<{ name: string }>("PRAGMA table_info('overseer_verdicts')");
    const names = columns.rows.map(row => row.name);
    expect(names).toContain('merge_attempts');
    expect(names).toContain('merge_not_before');
    expect(names).toContain('merge_last_transient_reason');
    expect((await db.query<{ merge_attempts: number }>(`SELECT merge_attempts FROM overseer_verdicts WHERE id = 'old'`)).rows[0]?.merge_attempts).toBe(0);
    await db.close();
    db = new SqliteAdapter(path);
  });
});
