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
  claimVerdictForMergeExecution,
  countRunsPendingOverseerJudgment,
  ensureDiscoveryRunRow,
  finalizeOverseerVerdict,
  getOverseerActionsForRun,
  getOverseerLastActionAt,
  getOverseerLastVerdictAt,
  getOverseerVerdictsForRun,
  getOverseerWatchRunById,
  getVerdictByRunHead,
  hasReconcileActionForPr,
  insertOverseerAction,
  insertReconcileAction,
  listRunEventsForOverseer,
  listRunsForOverseerWatch,
  listUnactionedFlagMergeReadyVerdicts,
  promoteObserveOrHealthyVerdict,
  promoteObserveOrHealthyVerdictWithReceipt,
  recordVerdictMergeOutcome,
  releaseOverseerMergeSlot,
  releaseVerdictClaimForMergeExecution,
  reserveOverseerMergeSlot,
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

async function mergeSlotRow(
  verdictId: string
): Promise<{ id: string; reserved_at: string; released_at: string | null } | undefined> {
  const result = await db.query<{
    id: string;
    reserved_at: string;
    released_at: string | null;
  }>(
    `SELECT id, reserved_at, released_at FROM overseer_merge_slot_reservations
     WHERE verdict_id = $1`,
    [verdictId]
  );
  return result.rows[0];
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

    // A PROVISIONAL action (e.g. a verdict written before CI/review finished)
    // must NOT exclude the run forever -- it should still show up so a later
    // heartbeat can re-evaluate it once state changes. Anchor: 2026-08-25 E2E
    // merge canary (bdc-harness PR #705) sat eligible:0 for 30+ minutes after
    // going green+approved because a pre-CI verdict_write row had already
    // permanently excluded it under the old NOT EXISTS(any row) predicate.
    await insertOverseerAction({
      runId: 'run-overseer',
      woId: 'WO-TEST-OVERSEER-01',
      class: 'tail_node_false_fail',
      action: 'verdict_write',
      result: 'merge_candidate:confidence:0.85',
    });
    const actions = await getOverseerActionsForRun('run-overseer');
    expect(actions).toHaveLength(1);
    expect(actions[0].action).toBe('verdict_write');
    expect(await listRunsForOverseerWatch()).toHaveLength(1);

    // Terminal actions permanently exclude the run: the merge-manager success
    // write ('merged'), a resolved-judgment close ('watch_closed'), and the
    // once-and-done escalation family.
    await insertOverseerAction({
      runId: 'run-overseer',
      woId: 'WO-TEST-OVERSEER-01',
      class: 'none',
      action: 'merged',
      result: JSON.stringify({ mutation_sent: true, merged_sha: 'deadbeef' }),
    });
    expect(await listRunsForOverseerWatch()).toHaveLength(0);
  });

  test('watch_closed is terminal; provisional merge_denied is not (window drain, 5th canary defect)', async () => {
    await seedRun('run-drain-a');
    await seedRun('run-drain-b');
    // Provisional: a precondition-miss denial must NOT exclude -- state can change.
    await insertOverseerAction({
      runId: 'run-drain-a',
      woId: 'WO-TEST-OVERSEER-01',
      class: 'none',
      action: 'merge_denied',
      result: 'no_review_gate_approval',
    });
    // Terminal: judged with a resolved lookup, nothing actionable.
    await insertOverseerAction({
      runId: 'run-drain-b',
      woId: 'WO-TEST-OVERSEER-01',
      class: 'none',
      action: 'watch_closed',
      result: 'completed run; PR not merge-ready (merged)',
    });
    const runs = await listRunsForOverseerWatch();
    const ids = runs.map(r => r.id);
    expect(ids).toContain('run-drain-a');
    expect(ids).not.toContain('run-drain-b');
  });

  test('resolves repo identity from the engine-written codebase FK when metadata has none', async () => {
    // REAL-WORLD metadata shape: telemetry only, no repo key. Per parseRepo's own
    // note, zero of 563 live terminal runs carried one. Every other test in this
    // file seeds targetRepo into metadata -- a shape production never produces --
    // which is why this defect survived: the tests validated fiction.
    // Anchor: 2026-08-25 E2E merge canary (bdc-harness PR #705).
    await db.query(
      `INSERT INTO remote_agent_codebases (id, name, default_cwd)
       VALUES ('cb-real', 'thinmansoftware/bdc-harness', '/tmp/cb-real')`
    );
    await db.query(
      `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id, title)
       VALUES ('conv-fk', 'test', 'conv-fk', 'Test')`
    );
    await db.query(
      `INSERT INTO remote_agent_workflow_runs
       (id, conversation_id, codebase_id, workflow_name, user_message, status, metadata)
       VALUES ('run-fk', 'conv-fk', 'cb-real', 'bdc-feature-development', $1, 'completed', $2)`,
      [
        'WO_ID=WO-HARNESS-E2E-MERGE-CANARY-01 --project bdc-harness',
        JSON.stringify({ node_counts: { completed: 39 }, total_cost_usd: 7.63 }),
      ]
    );

    const runs = await listRunsForOverseerWatch();
    const run = runs.find(candidate => candidate.id === 'run-fk');
    expect(run).toBeDefined();
    // Without the FK join these are undefined, and judgePullRequest returns
    // unresolvableEvidence -- the PR lookup never runs and nothing is merge_ready.
    expect(run?.owner).toBe('thinmansoftware');
    expect(run?.repo).toBe('bdc-harness');
    expect(run?.woId).toBe('WO-HARNESS-E2E-MERGE-CANARY-01');
  });

  test('getOverseerWatchRunById resolves repo identity from the codebase FK (bdc-harness #846)', async () => {
    // The merge-execution bridge resolves a verdict's run through THIS query.
    // Without the join it returns owner/repo undefined for every real run and
    // the bridge records run_context_unresolvable.
    await db.query(
      `INSERT INTO remote_agent_codebases (id, name, default_cwd)
       VALUES ('cb-by-id', 'thinmansoftware/bdc-harness', '/tmp/cb-by-id')`
    );
    await db.query(
      `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id, title)
       VALUES ('conv-by-id', 'test', 'conv-by-id', 'Test')`
    );
    await db.query(
      `INSERT INTO remote_agent_workflow_runs
       (id, conversation_id, codebase_id, workflow_name, user_message, status, metadata)
       VALUES ('run-by-id', 'conv-by-id', 'cb-by-id', 'bdc-feature-development', $1, 'completed', $2)`,
      [
        'WO_ID=WO-HARNESS-846 --project bdc-harness',
        JSON.stringify({ node_counts: { completed: 3 } }),
      ]
    );

    const run = await getOverseerWatchRunById('run-by-id');
    expect(run?.owner).toBe('thinmansoftware');
    expect(run?.repo).toBe('bdc-harness');
    expect(run?.woId).toBe('WO-HARNESS-846');
    expect(await getOverseerWatchRunById('run-absent')).toBeNull();
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

  test('promotes an observe or healthy verdict once, and never a needs_human row', async () => {
    await seedRun('run-promote-observe', 'completed');
    const observe = await claimOverseerVerdict({
      runId: 'run-promote-observe',
      woId: 'WO-TEST-OVERSEER-01',
      headSha: 'H',
    });
    await finalizeOverseerVerdict({
      verdictId: observe.verdictId!,
      status: 'verdict',
      verdict: 'observe',
      proposedAction: 'comment_findings',
    });
    const before = await getVerdictByRunHead({ runId: 'run-promote-observe', headSha: 'H' });
    expect(before?.id).toBe(observe.verdictId);
    expect(before?.verdict).toBe('observe');
    expect(before?.proposedAction).toBe('comment_findings');
    expect(before?.actionedAt).toBeNull();

    expect(await promoteObserveOrHealthyVerdict(observe.verdictId!)).toBe(true);
    const promoted = await getOverseerVerdictsForRun('run-promote-observe');
    expect(promoted[0]?.proposed_action).toBe('flag_merge_ready');
    expect(await promoteObserveOrHealthyVerdict(observe.verdictId!)).toBe(false);

    await seedRun('run-promote-healthy', 'completed');
    const healthy = await claimOverseerVerdict({
      runId: 'run-promote-healthy',
      woId: 'WO-TEST-OVERSEER-01',
      headSha: 'H',
    });
    await finalizeOverseerVerdict({
      verdictId: healthy.verdictId!,
      status: 'verdict',
      verdict: 'healthy',
      proposedAction: 'none',
    });
    expect(await promoteObserveOrHealthyVerdict(healthy.verdictId!)).toBe(true);
    const healthyRows = await getOverseerVerdictsForRun('run-promote-healthy');
    expect(healthyRows[0]?.proposed_action).toBe('flag_merge_ready');

    await seedRun('run-promote-human', 'completed');
    const human = await claimOverseerVerdict({
      runId: 'run-promote-human',
      woId: 'WO-TEST-OVERSEER-01',
      headSha: 'H',
    });
    await finalizeOverseerVerdict({
      verdictId: human.verdictId!,
      status: 'verdict',
      verdict: 'needs_human',
      proposedAction: 'escalate_with_evidence',
    });
    expect(await promoteObserveOrHealthyVerdict(human.verdictId!)).toBe(false);
    const humanRows = await getOverseerVerdictsForRun('run-promote-human');
    expect(humanRows[0]?.proposed_action).toBe('escalate_with_evidence');
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

  // WO-HARNESS-DISCOVERY-VERDICT-RECORD-01 / bdc-xo#2208: discovery-sourced PRs
  // (runId `pr-discovery:<owner>/<repo>#<n>`) have no workflow run, so the verdict
  // insert's NOT NULL FK to remote_agent_workflow_runs threw SQLITE_CONSTRAINT_FOREIGNKEY
  // and zero discovery verdicts were ever recorded. claimOverseerVerdict now mints a
  // synthetic terminal parent (conversation + run) first.
  async function countRows(sql: string, params: unknown[] = []): Promise<number> {
    const result = await db.query<{ n: number | string }>(sql, params);
    return Number(result.rows[0]?.n ?? 0);
  }

  test('records a discovery-PR verdict by minting a synthetic terminal run row (no pre-existing run)', async () => {
    const runId = 'pr-discovery:thinmansoftware/bdc-xo#1';
    // NOTE: no seedRun() -- the whole point is that a discovery PR has no workflow run.
    const claim = await claimOverseerVerdict({
      runId,
      woId: 'WO-DISCOVERY-1',
      headSha: 'headsha-1',
    });
    expect(claim.claimed).toBe(true);

    // The verdict row exists and is bound to the discovery runId.
    const verdicts = await getOverseerVerdictsForRun(runId);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].run_id).toBe(runId);

    // A synthetic conversation + a TERMINAL synthetic run row were created for it.
    expect(
      await countRows('SELECT COUNT(*) AS n FROM remote_agent_conversations WHERE id = $1', [runId])
    ).toBe(1);
    const run = await db.query<{ workflow_name: string; status: string }>(
      'SELECT workflow_name, status FROM remote_agent_workflow_runs WHERE id = $1',
      [runId]
    );
    expect(run.rows[0]?.workflow_name).toBe('pr-discovery');
    expect(run.rows[0]?.status).toBe('completed');
  });

  test('claiming a discovery verdict twice at the same head is idempotent (one run row, one verdict)', async () => {
    const runId = 'pr-discovery:thinmansoftware/bdc-xo#2';
    const first = await claimOverseerVerdict({ runId, woId: 'WO-DISCOVERY-2', headSha: 'h2' });
    const second = await claimOverseerVerdict({ runId, woId: 'WO-DISCOVERY-2', headSha: 'h2' });
    expect(first.claimed).toBe(true);
    expect(second.claimed).toBe(false);
    expect(await getOverseerVerdictsForRun(runId)).toHaveLength(1);
    // Exactly one synthetic run row and one synthetic conversation survive the replay.
    expect(
      await countRows('SELECT COUNT(*) AS n FROM remote_agent_workflow_runs WHERE id = $1', [runId])
    ).toBe(1);
    expect(
      await countRows('SELECT COUNT(*) AS n FROM remote_agent_conversations WHERE id = $1', [runId])
    ).toBe(1);
  });

  test('an APPROVED discovery verdict surfaces to the merge bridge via listUnactionedFlagMergeReadyVerdicts', async () => {
    const runId = 'pr-discovery:thinmansoftware/bdc-harness#3';
    const claim = await claimOverseerVerdict({ runId, woId: 'WO-DISCOVERY-3', headSha: 'h3' });
    await finalizeOverseerVerdict({
      verdictId: claim.verdictId!,
      status: 'verdict',
      verdict: 'merge_candidate',
      proposedAction: 'flag_merge_ready',
      prUrl: 'https://github.com/thinmansoftware/bdc-harness/pull/3',
    });
    const ready = await listUnactionedFlagMergeReadyVerdicts();
    expect(ready).toHaveLength(1);
    expect(ready[0].run_id).toBe(runId);
    expect(ready[0].proposed_action).toBe('flag_merge_ready');
    expect(ready[0].verdict).toBe('merge_candidate');
    expect(ready[0].head_sha).toBe('h3');
    expect(ready[0].pr_url).toBe('https://github.com/thinmansoftware/bdc-harness/pull/3');
  });

  test('the synthetic discovery run is terminal and excluded from the watch loop, pending count, and inflight count', async () => {
    // A real terminal run coexists so we prove the discovery row is excluded, not that
    // the queries are simply empty.
    await seedRun('run-real', 'completed');
    await claimOverseerVerdict({
      runId: 'pr-discovery:thinmansoftware/bdc-harness#4',
      woId: 'WO-DISCOVERY-4',
      headSha: 'h4',
    });

    const watched = await listRunsForOverseerWatch();
    expect(watched.map(r => r.id)).toContain('run-real');
    expect(watched.some(r => r.id.startsWith('pr-discovery:'))).toBe(false);

    // Pending-judgment backlog counts the real run but not the synthetic discovery row.
    expect(await countRunsPendingOverseerJudgment()).toBe(1);

    // Terminal status means the rebuild inflight guard never sees it as live work.
    expect(
      await countRows(
        `SELECT COUNT(*) AS n FROM remote_agent_workflow_runs
         WHERE workflow_name = 'pr-discovery' AND status IN ('pending', 'running')`
      )
    ).toBe(0);
  });

  test('a Cauldron-sourced verdict (real run id) is unchanged -- no synthetic row is minted', async () => {
    await seedRun('run-cauldron', 'completed');
    const claim = await claimOverseerVerdict({
      runId: 'run-cauldron',
      woId: 'WO-TEST-OVERSEER-01',
      headSha: 'cauldron-head',
    });
    expect(claim.claimed).toBe(true);
    expect(await getOverseerVerdictsForRun('run-cauldron')).toHaveLength(1);
    // No pr-discovery synthetic run was created for a real Cauldron run id.
    expect(
      await countRows(
        "SELECT COUNT(*) AS n FROM remote_agent_workflow_runs WHERE workflow_name = 'pr-discovery'"
      )
    ).toBe(0);
    // The real run still participates in the watch loop.
    expect((await listRunsForOverseerWatch()).map(r => r.id)).toContain('run-cauldron');
  });

  test('ensureDiscoveryRunRow is directly idempotent', async () => {
    const runId = 'pr-discovery:thinmansoftware/bdc-xo#9';
    await ensureDiscoveryRunRow(runId);
    await ensureDiscoveryRunRow(runId);
    expect(
      await countRows('SELECT COUNT(*) AS n FROM remote_agent_workflow_runs WHERE id = $1', [runId])
    ).toBe(1);
    expect(
      await countRows('SELECT COUNT(*) AS n FROM remote_agent_conversations WHERE id = $1', [runId])
    ).toBe(1);
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

  test('reserves a merge slot under the ceiling and rejects the next at the limit', async () => {
    const since = '2026-09-14T00:00:00.000Z';
    expect(await reserveOverseerMergeSlot('verdict-a', since, 1)).toBe(true);
    expect(await reserveOverseerMergeSlot('verdict-b', since, 1)).toBe(false);
    await releaseOverseerMergeSlot('verdict-a');
    expect(await reserveOverseerMergeSlot('verdict-b', since, 1)).toBe(true);
  });

  test('revives a released merge slot for the same verdict', async () => {
    const since = '2026-09-14T00:00:00.000Z';
    expect(await reserveOverseerMergeSlot('verdict-revive', since, 1)).toBe(true);
    const first = await mergeSlotRow('verdict-revive');
    expect(first).toBeDefined();
    await releaseOverseerMergeSlot('verdict-revive');
    const released = await mergeSlotRow('verdict-revive');
    expect(released?.id).toBe(first?.id);
    expect(released?.released_at).toBeTruthy();
    expect(await reserveOverseerMergeSlot('verdict-revive', since, 1)).toBe(true);
    const revived = await mergeSlotRow('verdict-revive');
    expect(revived?.id).toBe(first?.id);
    expect(revived?.released_at).toBeNull();
    expect(revived?.reserved_at).toBeTruthy();
    const count = await db.query<{ n: number | string }>(
      'SELECT COUNT(*) AS n FROM overseer_merge_slot_reservations WHERE verdict_id = $1',
      ['verdict-revive']
    );
    expect(Number(count.rows[0]?.n)).toBe(1);
  });

  test('refuses a second reserve of an active merge slot', async () => {
    const since = '2026-09-14T00:00:00.000Z';
    expect(await reserveOverseerMergeSlot('verdict-active', since, 2)).toBe(true);
    const first = await mergeSlotRow('verdict-active');
    expect(await reserveOverseerMergeSlot('verdict-active', since, 2)).toBe(false);
    expect(await mergeSlotRow('verdict-active')).toEqual(first);
  });

  test('counts a revived reservation toward occupancy again', async () => {
    const since = '2026-09-14T00:00:00.000Z';
    expect(await reserveOverseerMergeSlot('verdict-a', since, 1)).toBe(true);
    await releaseOverseerMergeSlot('verdict-a');
    expect(await reserveOverseerMergeSlot('verdict-a', since, 1)).toBe(true);
    expect(await reserveOverseerMergeSlot('verdict-b', since, 1)).toBe(false);
  });

  test('releaseOverseerMergeSlot is a no-op on a released row', async () => {
    const since = '2026-09-14T00:00:00.000Z';
    expect(await reserveOverseerMergeSlot('verdict-noop', since, 1)).toBe(true);
    await releaseOverseerMergeSlot('verdict-noop');
    const first = await mergeSlotRow('verdict-noop');
    expect(first?.released_at).toBeTruthy();
    await releaseOverseerMergeSlot('verdict-noop');
    expect(await mergeSlotRow('verdict-noop')).toEqual(first);
  });

  test('releaseVerdictClaimForMergeExecution restores a processing claim for a later cycle', async () => {
    await seedRun('run-claim-release');
    await db.query(
      `INSERT INTO overseer_verdicts (id, run_id, wo_id, head_sha, proposed_action)
       VALUES ('verdict-release', 'run-claim-release', 'WO-TEST-OVERSEER-01', 'sha', 'flag_merge_ready')`
    );
    expect(await listUnactionedFlagMergeReadyVerdicts()).toHaveLength(1);
    expect(await claimVerdictForMergeExecution('verdict-release')).toBe(true);
    expect(await listUnactionedFlagMergeReadyVerdicts()).toHaveLength(0);
    expect(await releaseVerdictClaimForMergeExecution('verdict-release', 'db unavailable')).toBe(
      true
    );
    const listed = await listUnactionedFlagMergeReadyVerdicts();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe('verdict-release');
    expect(listed[0]?.actioned_at).toBeNull();
    expect(listed[0]?.action_reason).toBeNull();
    expect(await claimVerdictForMergeExecution('verdict-release')).toBe(true);
  });

  test('releaseVerdictClaimForMergeExecution never un-finalizes a recorded outcome', async () => {
    await seedRun('run-claim-final');
    await db.query(
      `INSERT INTO overseer_verdicts (id, run_id, wo_id, head_sha, proposed_action)
       VALUES ('verdict-final', 'run-claim-final', 'WO-TEST-OVERSEER-01', 'sha', 'flag_merge_ready')`
    );
    expect(await claimVerdictForMergeExecution('verdict-final')).toBe(true);
    await recordVerdictMergeOutcome({
      verdictId: 'verdict-final',
      mutationSent: true,
      reason: 'merge_executed',
      mergeSha: 'abc',
    });
    expect(await releaseVerdictClaimForMergeExecution('verdict-final', 'should-not-clear')).toBe(
      false
    );
    const merged = await getOverseerVerdictsForRun('run-claim-final');
    expect(merged[0]?.action_reason).toBe('merge_executed');
    expect(merged[0]?.actioned_at).toBeTruthy();
    expect(await listUnactionedFlagMergeReadyVerdicts()).toHaveLength(0);

    await seedRun('run-claim-skip');
    await db.query(
      `INSERT INTO overseer_verdicts (id, run_id, wo_id, head_sha, proposed_action)
       VALUES ('verdict-skip', 'run-claim-skip', 'WO-TEST-OVERSEER-01', 'sha', 'flag_merge_ready')`
    );
    expect(await claimVerdictForMergeExecution('verdict-skip')).toBe(true);
    await recordVerdictMergeOutcome({
      verdictId: 'verdict-skip',
      mutationSent: false,
      reason: 'repo_not_allowed',
    });
    expect(await releaseVerdictClaimForMergeExecution('verdict-skip', 'should-not-clear')).toBe(
      false
    );
    const skipped = await getOverseerVerdictsForRun('run-claim-skip');
    expect(skipped[0]?.action_reason).toBe('repo_not_allowed');
    expect(skipped[0]?.actioned_at).toBeTruthy();
  });

  test('recordVerdictMergeOutcome throws when action_reason is not processing', async () => {
    await seedRun('run-outcome-mismatch');
    await db.query(
      `INSERT INTO overseer_verdicts (id, run_id, wo_id, head_sha, proposed_action)
       VALUES ('verdict-mismatch', 'run-outcome-mismatch', 'WO-TEST-OVERSEER-01', 'sha', 'flag_merge_ready')`
    );
    expect(await claimVerdictForMergeExecution('verdict-mismatch')).toBe(true);
    await recordVerdictMergeOutcome({
      verdictId: 'verdict-mismatch',
      mutationSent: false,
      reason: 'repo_not_allowed',
    });
    await expect(
      recordVerdictMergeOutcome({
        verdictId: 'verdict-mismatch',
        mutationSent: true,
        reason: 'merge_executed',
        mergeSha: 'should-not-write',
      })
    ).rejects.toThrow('overseer_verdict_outcome_not_recorded');
    const rows = await getOverseerVerdictsForRun('run-outcome-mismatch');
    expect(rows[0]?.action_reason).toBe('repo_not_allowed');
    expect(rows[0]?.merge_sha).toBeNull();
    expect(rows[0]?.mutation_sent === false || rows[0]?.mutation_sent === 0).toBe(true);
    expect(await listUnactionedFlagMergeReadyVerdicts()).toHaveLength(0);
  });

  async function seedSafeVerdict(
    runId: string,
    verdict: 'observe' | 'healthy',
    proposedAction: string | null
  ): Promise<string> {
    await seedRun(runId, 'completed');
    const claim = await claimOverseerVerdict({
      runId,
      woId: 'WO-TEST-OVERSEER-01',
      headSha: 'H',
    });
    await finalizeOverseerVerdict({
      verdictId: claim.verdictId!,
      status: 'verdict',
      verdict,
      ...(proposedAction === null ? {} : { proposedAction }),
    });
    return claim.verdictId!;
  }

  test('promote allows only unactioned none, verdict_write, and comment_findings', async () => {
    const safe = [
      ['run-sql-observe-none', 'observe', 'none'],
      ['run-sql-observe-write', 'observe', 'verdict_write'],
      ['run-sql-observe-comment', 'observe', 'comment_findings'],
      ['run-sql-healthy-none', 'healthy', 'none'],
      ['run-sql-healthy-write', 'healthy', 'verdict_write'],
      ['run-sql-healthy-comment', 'healthy', 'comment_findings'],
    ] as const;
    for (const [runId, verdict, action] of safe) {
      const verdictId = await seedSafeVerdict(runId, verdict, action);
      expect(await promoteObserveOrHealthyVerdict(verdictId)).toBe(true);
      expect(await promoteObserveOrHealthyVerdict(verdictId)).toBe(false);
      const row = await getVerdictByRunHead({ runId, headSha: 'H' });
      expect(row?.proposedAction).toBe('flag_merge_ready');
    }

    const blocked = [
      ['run-sql-esc-observe', 'observe', 'escalate_with_evidence'],
      ['run-sql-esc-healthy', 'healthy', 'escalate_with_evidence'],
      ['run-sql-null-observe', 'observe', null],
      ['run-sql-null-healthy', 'healthy', null],
      ['run-sql-unknown-observe', 'observe', 'not_a_real_action'],
      ['run-sql-unknown-healthy', 'healthy', 'not_a_real_action'],
      ['run-sql-ready-observe', 'observe', 'flag_merge_ready'],
      ['run-sql-ready-healthy', 'healthy', 'flag_merge_ready'],
    ] as const;
    for (const [runId, verdict, action] of blocked) {
      const verdictId = await seedSafeVerdict(runId, verdict, action);
      expect(await promoteObserveOrHealthyVerdict(verdictId)).toBe(false);
      const row = await getVerdictByRunHead({ runId, headSha: 'H' });
      expect(row?.proposedAction).toBe(action);
    }

    const actionedId = await seedSafeVerdict('run-sql-actioned', 'observe', 'comment_findings');
    await db.query(`UPDATE overseer_verdicts SET actioned_at = $2 WHERE id = $1`, [
      actionedId,
      '2026-10-29T00:00:00.000Z',
    ]);
    expect(await promoteObserveOrHealthyVerdict(actionedId)).toBe(false);
    expect(
      (await getVerdictByRunHead({ runId: 'run-sql-actioned', headSha: 'H' }))?.proposedAction
    ).toBe('comment_findings');
  });

  test('conditional promote refuses an escalation written after the safe read', async () => {
    const verdictId = await seedSafeVerdict('run-sql-race', 'healthy', 'none');
    const before = await getVerdictByRunHead({ runId: 'run-sql-race', headSha: 'H' });
    expect(before?.proposedAction).toBe('none');
    await db.query(
      `UPDATE overseer_verdicts SET proposed_action = 'escalate_with_evidence' WHERE id = $1`,
      [verdictId]
    );
    expect(await promoteObserveOrHealthyVerdict(verdictId)).toBe(false);
    expect(
      (await getVerdictByRunHead({ runId: 'run-sql-race', headSha: 'H' }))?.proposedAction
    ).toBe('escalate_with_evidence');
  });

  test('promote with receipt commits the verdict and the receipt together', async () => {
    const verdictId = await seedSafeVerdict('run-atomic-ok', 'healthy', 'none');
    const result = `steward_handoff:replay_green:verdict:${verdictId}`;
    const receipt = {
      verdictId,
      runId: 'run-atomic-ok',
      woId: 'WO-TEST-OVERSEER-01',
      class: 'none',
      result,
    };
    expect(await promoteObserveOrHealthyVerdictWithReceipt(receipt)).toBe(true);
    expect(
      (await getVerdictByRunHead({ runId: 'run-atomic-ok', headSha: 'H' }))?.proposedAction
    ).toBe('flag_merge_ready');
    expect(
      (await getOverseerActionsForRun('run-atomic-ok')).filter(
        action => action.action === 'flag_merge_ready' && action.result === result
      )
    ).toHaveLength(1);
    expect(await promoteObserveOrHealthyVerdictWithReceipt(receipt)).toBe(false);
    expect(
      (await getOverseerActionsForRun('run-atomic-ok')).filter(
        action => action.action === 'flag_merge_ready'
      )
    ).toHaveLength(1);
    expect((await listUnactionedFlagMergeReadyVerdicts()).some(row => row.id === verdictId)).toBe(
      true
    );

    const blockedId = await seedSafeVerdict(
      'run-atomic-unsafe',
      'observe',
      'escalate_with_evidence'
    );
    expect(
      await promoteObserveOrHealthyVerdictWithReceipt({
        verdictId: blockedId,
        runId: 'run-atomic-unsafe',
        woId: 'WO-TEST-OVERSEER-01',
        class: 'none',
        result: `steward_handoff:replay_green:verdict:${blockedId}`,
      })
    ).toBe(false);
    expect(
      (await getVerdictByRunHead({ runId: 'run-atomic-unsafe', headSha: 'H' }))?.proposedAction
    ).toBe('escalate_with_evidence');
    expect(
      (await getOverseerActionsForRun('run-atomic-unsafe')).filter(
        action => action.action === 'flag_merge_ready'
      )
    ).toHaveLength(0);
  });

  test('receipt insert failure does not leave flag_merge_ready when revert would fail', async () => {
    const verdictId = await seedSafeVerdict('run-atomic-rollback', 'observe', 'comment_findings');
    const result = `steward_handoff:replay_green:verdict:${verdictId}`;
    await db.query(
      `CREATE TRIGGER reject_replay_green_receipt BEFORE INSERT ON overseer_actions
       WHEN NEW.action = 'flag_merge_ready'
       BEGIN SELECT RAISE(ABORT, 'receipt_insert_failed'); END`
    );
    await db.query(
      `CREATE TRIGGER reject_replay_green_revert BEFORE UPDATE ON overseer_verdicts
       WHEN OLD.proposed_action = 'flag_merge_ready' AND NEW.proposed_action != 'flag_merge_ready'
       BEGIN SELECT RAISE(ABORT, 'revert_failed'); END`
    );
    try {
      await expect(
        promoteObserveOrHealthyVerdictWithReceipt({
          verdictId,
          runId: 'run-atomic-rollback',
          woId: 'WO-TEST-OVERSEER-01',
          class: 'none',
          result,
        })
      ).rejects.toThrow('receipt_insert_failed');
    } finally {
      await db.query('DROP TRIGGER IF EXISTS reject_replay_green_receipt');
      await db.query('DROP TRIGGER IF EXISTS reject_replay_green_revert');
    }
    expect(
      (await getVerdictByRunHead({ runId: 'run-atomic-rollback', headSha: 'H' }))?.proposedAction
    ).toBe('comment_findings');
    expect(
      (await getOverseerActionsForRun('run-atomic-rollback')).filter(
        action => action.action === 'flag_merge_ready'
      )
    ).toHaveLength(0);
    expect((await listUnactionedFlagMergeReadyVerdicts()).some(row => row.id === verdictId)).toBe(
      false
    );
  });

  test('concurrent promote calls change one observe row', async () => {
    const verdictId = await seedSafeVerdict('run-sql-concurrent', 'observe', 'verdict_write');
    const results = await Promise.all([
      promoteObserveOrHealthyVerdict(verdictId),
      promoteObserveOrHealthyVerdict(verdictId),
    ]);
    expect(results.filter(won => won)).toHaveLength(1);
    expect(
      (await getVerdictByRunHead({ runId: 'run-sql-concurrent', headSha: 'H' }))?.proposedAction
    ).toBe('flag_merge_ready');
  });

  test('comment_findings keeps a safe unactioned verdict selectable and drops it after promotion', async () => {
    const observeId = await seedSafeVerdict('run-watch-comment', 'observe', 'comment_findings');
    await insertOverseerAction({
      runId: 'run-watch-comment',
      woId: 'WO-TEST-OVERSEER-01',
      class: 'none',
      action: 'verdict_write',
      result: 'initial',
    });
    await insertOverseerAction({
      runId: 'run-watch-comment',
      woId: 'WO-TEST-OVERSEER-01',
      class: 'none',
      action: 'comment_findings',
      result: 'initial comment',
    });
    expect((await listRunsForOverseerWatch()).map(run => run.id)).toContain('run-watch-comment');
    expect(await promoteObserveOrHealthyVerdict(observeId)).toBe(true);
    expect((await listRunsForOverseerWatch()).map(run => run.id)).not.toContain(
      'run-watch-comment'
    );

    await seedSafeVerdict('run-watch-healthy', 'healthy', 'none');
    await insertOverseerAction({
      runId: 'run-watch-healthy',
      woId: 'WO-TEST-OVERSEER-01',
      class: 'none',
      action: 'comment_findings',
      result: 'initial comment',
    });
    expect((await listRunsForOverseerWatch()).map(run => run.id)).toContain('run-watch-healthy');

    const retired = [
      ['run-watch-human', 'needs_human', 'escalate_with_evidence', 'comment_findings'],
      ['run-watch-genuine', 'failed_genuine', 'escalate_with_evidence', 'comment_findings'],
      ['run-watch-dup', 'duplicate_work', 'comment_findings', 'comment_findings'],
      ['run-watch-merged', 'observe', 'none', 'merged'],
      ['run-watch-closed', 'healthy', 'verdict_write', 'watch_closed'],
      ['run-watch-tier', 'observe', 'comment_findings', 'tier_refused'],
      ['run-watch-denied', 'healthy', 'none', 'escalation_denied'],
      ['run-watch-escalated', 'observe', 'comment_findings', 'escalate_with_evidence'],
    ] as const;
    for (const [runId, verdict, proposedAction, terminalAction] of retired) {
      await seedSafeVerdict(runId, verdict === 'healthy' ? 'healthy' : 'observe', proposedAction);
      if (verdict !== 'observe' && verdict !== 'healthy') {
        await db.query(`UPDATE overseer_verdicts SET verdict = $2 WHERE run_id = $1`, [
          runId,
          verdict,
        ]);
      }
      await insertOverseerAction({
        runId,
        woId: 'WO-TEST-OVERSEER-01',
        class: 'none',
        action: terminalAction,
        result: 'terminal',
      });
      expect((await listRunsForOverseerWatch()).map(run => run.id)).not.toContain(runId);
    }
  });
});
