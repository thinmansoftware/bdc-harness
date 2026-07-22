import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { unlinkSync } from 'fs';
import { join } from 'path';
import { SqliteAdapter } from './adapters/sqlite';

let db: SqliteAdapter;
let currentDbPath = '';

mock.module('./connection', () => ({
  getDatabase: () => db,
}));

import {
  getOverseerActionsForRun,
  insertOverseerAction,
  insertReconcileAction,
  listRunEventsForOverseer,
  listRunsForOverseerWatch,
} from './overseer';

function cleanupDb(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(path + suffix);
    } catch {
      /* file may not exist */
    }
  }
}

async function seedRun(id: string, status = 'failed'): Promise<void> {
  await db.query(
    `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id, title)
     VALUES ($1, 'test', $1, 'Test')`,
    [`conv-${id}`]
  );
  await db.query(
    `INSERT INTO remote_agent_workflow_runs
     (id, conversation_id, workflow_name, user_message, status, metadata)
     VALUES ($1, $2, 'bdc-feature-development', $3, $4, $5)`,
    [
      id,
      `conv-${id}`,
      'Implement WO-TEST-OVERSEER-01',
      status,
      JSON.stringify({
        woId: 'WO-TEST-OVERSEER-01',
        targetRepo: 'bluedevilcollectibles/bdc-harness',
        headBranch: 'wo/test',
      }),
    ]
  );
}

describe('overseer db', () => {
  beforeEach(() => {
    currentDbPath = join(
      import.meta.dir,
      `.test-overseer-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    );
    db = new SqliteAdapter(currentDbPath);
  });

  afterEach(async () => {
    await db.close();
    cleanupDb(currentDbPath);
  });

  test('lists terminal runs, events, and records overseer_actions rows', async () => {
    await seedRun('run-overseer');
    await db.query(
      `INSERT INTO remote_agent_workflow_events (workflow_run_id, event_type, step_name, data)
       VALUES ($1, 'node_failed', 'commit-and-push', $2)`,
      ['run-overseer', JSON.stringify({ error: 'exit 1' })]
    );

    const runs = await listRunsForOverseerWatch();
    expect(runs).toHaveLength(1);
    expect(runs[0].woId).toBe('WO-TEST-OVERSEER-01');
    expect(runs[0].repo).toBe('bdc-harness');

    const events = await listRunEventsForOverseer('run-overseer');
    expect(events[0].step_name).toBe('commit-and-push');
    expect(events[0].data.error).toBe('exit 1');

    await insertOverseerAction({
      runId: 'run-overseer',
      woId: 'WO-TEST-OVERSEER-01',
      class: 'tail_node_false_fail',
      action: 'merge_ready',
      result: 'merged',
    });
    const actions = await getOverseerActionsForRun('run-overseer');
    expect(actions).toHaveLength(1);
    expect(actions[0].action).toBe('merge_ready');
    expect(await listRunsForOverseerWatch()).toHaveLength(0);
  });

  test('insertReconcileAction succeeds for a merged PR with no corresponding run row (regression: overseer_actions.run_id NOT NULL FK crash)', async () => {
    // No seedRun() call here -- this is the exact live-incident condition:
    // a merged PR (shopops-comic-theme#89) reconciling a tracker with no
    // remote_agent_workflow_runs row. Routing this through insertOverseerAction's
    // run_id NOT NULL FK threw SQLITE_CONSTRAINT_FOREIGNKEY and degraded the
    // whole watcher (overseer_runtime.watcher_exception_degraded).
    const action = await insertReconcileAction({
      prRef: 'bluedevilcollectibles/shopops-comic-theme#89',
      woId: 'WO-COMICTHEME-WORDMARK-MASTER-PACK-COMPLETION-01',
      class: 'tracker_reconcile',
      action: 'reconcile_close',
      result: 'https://github.com/bluedevilcollectibles/shopops-comic-theme/pull/89:2a28cc9',
    });

    expect(action.pr_ref).toBe('bluedevilcollectibles/shopops-comic-theme#89');
    expect(action.action).toBe('reconcile_close');

    const rows = await db.query<{ pr_ref: string }>(
      'SELECT pr_ref FROM overseer_reconcile_actions WHERE id = $1',
      [action.id]
    );
    expect(rows.rows).toHaveLength(1);

    // overseer_actions (the run-scoped table) must remain untouched by reconcile.
    const runScoped = await db.query<{ count: number }>(
      'SELECT COUNT(*) as count FROM overseer_actions'
    );
    expect(Number(runScoped.rows[0]?.count)).toBe(0);
  });
});
