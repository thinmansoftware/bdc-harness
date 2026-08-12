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
  claimOverseerVerdict,
  countRunsPendingOverseerJudgment,
  finalizeOverseerVerdict,
  getOverseerActionsForRun,
  getOverseerLastActionAt,
  getOverseerLastVerdictAt,
  getOverseerVerdictsForRun,
  hasReconcileActionForPr,
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
        targetRepo: 'thinmansoftware/bdc-harness',
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

  test('reads latest action/verdict effect timestamps and pending judgment count', async () => {
    await seedRun('run-effect-old');
    await seedRun('run-effect-new');
    await db.query(
      `INSERT INTO overseer_actions (id, run_id, wo_id, class, action, result, created_at)
       VALUES ('action-old', 'run-effect-old', 'WO-TEST-OVERSEER-01', 'test', 'observe', 'ok', $1),
              ('action-new', 'run-effect-new', 'WO-TEST-OVERSEER-01', 'test', 'observe', 'ok', $2)`,
      ['2026-08-07T10:00:00.000Z', '2026-08-07T11:00:00.000Z']
    );
    await db.query(
      `INSERT INTO overseer_verdicts (id, run_id, wo_id, head_sha, created_at)
       VALUES ('verdict-old', 'run-effect-old', 'WO-TEST-OVERSEER-01', 'old', $1),
              ('verdict-new', 'run-effect-new', 'WO-TEST-OVERSEER-01', 'new', $2)`,
      ['2026-08-07T10:30:00.000Z', '2026-08-07T11:30:00.000Z']
    );
    await seedRun('run-pending');

    expect(await getOverseerLastActionAt()).toBe('2026-08-07T11:00:00.000Z');
    expect(await getOverseerLastVerdictAt()).toBe('2026-08-07T11:30:00.000Z');
    expect(await countRunsPendingOverseerJudgment()).toBe(1);
  });

  test('empty effect tables return null timestamps and zero pending judgments', async () => {
    expect(await getOverseerLastActionAt()).toBeNull();
    expect(await getOverseerLastVerdictAt()).toBeNull();
    expect(await countRunsPendingOverseerJudgment()).toBe(0);
  });

  test('effect and backlog read failures propagate', async () => {
    await db.query('DROP TABLE overseer_actions');
    await db.query('DROP TABLE overseer_verdicts');
    await db.query('DROP TABLE remote_agent_workflow_runs');

    await expect(getOverseerLastActionAt()).rejects.toThrow();
    await expect(getOverseerLastVerdictAt()).rejects.toThrow();
    await expect(countRunsPendingOverseerJudgment()).rejects.toThrow();
  });

  // Regression (2026-07-30, PRODUCTION OUTAGE): finalizeOverseerVerdict used
  // `UPDATE ... RETURNING *`. Postgres supports it; the SQLite adapter rejects it,
  // and production runs SQLite. The throw escaped watchLoop and runOverseerService
  // aborted every task -- the watcher died 12 seconds after the judge-first flip and
  // stayed dead 28 hours while runs went terminal unseen. The judge-first unit tests
  // injected a fake verdict store, so 540 green tests never executed this SQL. These
  // tests run the REAL query against the REAL adapter.
  test('claims and finalizes a verdict against the real SQLite adapter', async () => {
    await seedRun('run-verdict', 'completed');

    const claim = await claimOverseerVerdict({
      runId: 'run-verdict',
      woId: 'WO-TEST-OVERSEER-01',
      headSha: 'abc123',
      hintAction: 'ignore',
    });
    expect(claim.claimed).toBe(true);
    expect(claim.verdictId).toBeTruthy();

    const finalized = await finalizeOverseerVerdict({
      verdictId: claim.verdictId!,
      status: 'verdict',
      verdict: 'healthy',
      confidence: 0.75,
      model: 'grok',
      modelRung: 0,
      proposedAction: 'none',
      proposedTier: 0,
      requiredTier: 0,
      effectiveTier: 0,
      reason: 'run completed cleanly',
      evidenceDigest: 'digest-1',
    });
    expect(finalized.status).toBe('verdict');
    expect(finalized.verdict).toBe('healthy');
    expect(finalized.confidence).toBe(0.75);

    const rows = await getOverseerVerdictsForRun('run-verdict');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('verdict');
  });

  test('claim is idempotent per (run_id, head_sha) -- replay never wins a second claim', async () => {
    await seedRun('run-idem', 'completed');
    const first = await claimOverseerVerdict({
      runId: 'run-idem',
      woId: 'WO-TEST-OVERSEER-01',
      headSha: 'sha-1',
    });
    const second = await claimOverseerVerdict({
      runId: 'run-idem',
      woId: 'WO-TEST-OVERSEER-01',
      headSha: 'sha-1',
    });
    expect(first.claimed).toBe(true);
    expect(second.claimed).toBe(false);
    expect(await getOverseerVerdictsForRun('run-idem')).toHaveLength(1);
  });

  // The retry path had the SAME RETURNING defect and would have killed the watcher
  // the first time a health-alarm row was re-claimed.
  test('re-claims a health-alarm row up to the retry cap, then refuses', async () => {
    await seedRun('run-retry', 'failed');
    const first = await claimOverseerVerdict({
      runId: 'run-retry',
      woId: 'WO-TEST-OVERSEER-01',
      headSha: '',
    });
    await finalizeOverseerVerdict({
      verdictId: first.verdictId!,
      status: 'judge_unavailable',
      reason: 'ladder dead',
    });

    const retry = await claimOverseerVerdict({
      runId: 'run-retry',
      woId: 'WO-TEST-OVERSEER-01',
      headSha: '',
      maxRetries: 1,
    });
    expect(retry.claimed).toBe(true);
    expect(retry.retryCount).toBe(1);

    await finalizeOverseerVerdict({
      verdictId: retry.verdictId!,
      status: 'judge_unavailable',
      reason: 'ladder dead again',
    });
    const exhausted = await claimOverseerVerdict({
      runId: 'run-retry',
      woId: 'WO-TEST-OVERSEER-01',
      headSha: '',
      maxRetries: 1,
    });
    expect(exhausted.claimed).toBe(false);
  });

  // Regression (Arc B break (c), 2026-07-28): every seeded run in this suite carried
  // woId + targetRepo + headBranch, but ZERO of 563 real terminal runs in the live event
  // store carry any of them -- the engine writes only cost/token telemetry into run
  // metadata. parseRepo silently defaulted the repo to thinmansoftware/bdc-harness,
  // so a run against any other repo was looked up in the WRONG repo and the resulting
  // "no PR" was indistinguishable from a real one. Absent identity must be absent, not
  // invented.
  test('does not invent a repo when run metadata carries no repo identity', async () => {
    await db.query(
      `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id, title)
       VALUES ($1, 'test', $1, 'Test')`,
      ['conv-run-no-identity']
    );
    await db.query(
      `INSERT INTO remote_agent_workflow_runs
       (id, conversation_id, workflow_name, user_message, status, metadata)
       VALUES ($1, $2, 'bdc-feature-development', $3, 'completed', $4)`,
      [
        'run-no-identity',
        'conv-run-no-identity',
        'do some work',
        // Shape taken from a real production run: telemetry only, no git identity.
        JSON.stringify({ total_cost_usd: 5.69, node_counts: { completed: 40, failed: 0 } }),
      ]
    );

    const runs = await listRunsForOverseerWatch();
    const run = runs.find(r => r.id === 'run-no-identity');
    expect(run).toBeDefined();
    expect(run?.headBranch).toBeUndefined();
    expect(run?.repo).toBeUndefined();
    expect(run?.owner).toBeUndefined();
  });

  test('insertReconcileAction succeeds for a merged PR with no corresponding run row (regression: overseer_actions.run_id NOT NULL FK crash)', async () => {
    // No seedRun() call here -- this is the exact live-incident condition:
    // a merged PR (shopops-comic-theme#89) reconciling a tracker with no
    // remote_agent_workflow_runs row. Routing this through insertOverseerAction's
    // run_id NOT NULL FK threw SQLITE_CONSTRAINT_FOREIGNKEY and degraded the
    // whole watcher (overseer_runtime.watcher_exception_degraded).
    const action = await insertReconcileAction({
      prRef: 'thinmansoftware/shopops-comic-theme#89',
      woId: 'WO-COMICTHEME-WORDMARK-MASTER-PACK-COMPLETION-01',
      class: 'tracker_reconcile',
      action: 'reconcile_close',
      result: 'https://github.com/thinmansoftware/shopops-comic-theme/pull/89:2a28cc9',
    });

    expect(action.pr_ref).toBe('thinmansoftware/shopops-comic-theme#89');
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

  test('hasReconcileActionForPr finds only the matching PR, WO, and action', async () => {
    await insertReconcileAction({
      prRef: 'thinmansoftware/bdc-harness#404',
      woId: 'WO-HARNESS-OVERSEER-V1B-TRACKER-RECONCILE-01',
      class: 'tracker_reconcile',
      action: 'reconcile_skip_noted',
      result: 'https://github.com/thinmansoftware/bdc-harness/pull/404:abc123merge',
    });

    expect(
      await hasReconcileActionForPr({
        prRef: 'thinmansoftware/bdc-harness#404',
        woId: 'WO-HARNESS-OVERSEER-V1B-TRACKER-RECONCILE-01',
        action: 'reconcile_skip_noted',
      })
    ).toBe(true);
    expect(
      await hasReconcileActionForPr({
        prRef: 'thinmansoftware/bdc-harness#404',
        woId: 'WO-HARNESS-OVERSEER-V1B-TRACKER-RECONCILE-01',
        action: 'reconcile_close',
      })
    ).toBe(false);
    expect(
      await hasReconcileActionForPr({
        prRef: 'thinmansoftware/bdc-harness#405',
        woId: 'WO-HARNESS-OVERSEER-V1B-TRACKER-RECONCILE-01',
        action: 'reconcile_skip_noted',
      })
    ).toBe(false);
  });
});
