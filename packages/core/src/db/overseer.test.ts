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
});
