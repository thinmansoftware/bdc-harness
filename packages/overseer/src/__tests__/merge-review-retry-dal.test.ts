import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import * as realConnection from '@archon/core/db/connection';
import type { MergeExecutionBridgeOptions } from '../merge-execution-bridge';
import type { OverseerVerdictRow } from '@archon/core/db/overseer';

let db: import('@archon/core/db/adapters/sqlite').SqliteAdapter;
let path = '';
mock.module('@archon/core/db/connection', () => ({ ...realConnection, getDatabase: () => db }));
const { SqliteAdapter } = await import('@archon/core/db/adapters/sqlite');
const dal = await import('@archon/core/db/overseer');
const { runMergeExecutionBridgeOnce } = await import('../merge-execution-bridge');
const { classifyMergeSkip } = await import('../merge-skip-classification');
afterAll(() => mock.restore());
beforeEach(async () => {
  path = join(import.meta.dir, `.test-review-retry-${crypto.randomUUID()}.db`);
  db = new SqliteAdapter(path);
  await db.query(`INSERT INTO remote_agent_conversations
    (id, platform_type, platform_conversation_id) VALUES ('conv', 'test', 'conv')`);
  await db.query(`INSERT INTO remote_agent_workflow_runs
    (id, conversation_id, workflow_name, user_message, status, metadata)
    VALUES ('pr-discovery:thinmansoftware/bdc-harness#1', 'conv', 'test', 'test', 'completed', '{}')`);
  await db.query(`INSERT INTO overseer_verdicts
    (id, run_id, wo_id, head_sha, proposed_action, status, verdict, pr_url)
    VALUES ('verdict', 'pr-discovery:thinmansoftware/bdc-harness#1',
      'gh:thinmansoftware/bdc-harness#1', 'head', 'flag_merge_ready', 'verdict',
      'merge_candidate', 'https://github.com/thinmansoftware/bdc-harness/pull/1')`);
});
afterEach(async () => {
  await db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(path + suffix);
    } catch {
      /* Owned fixture may not exist. */
    }
  }
});

function harness() {
  const calls = { reservations: 0, approvals: 0, merges: 0 };
  const options: MergeExecutionBridgeOptions = {
    reviewGateLogin: 'gate',
    store: {
      listUnactionedVerdicts: dal.listUnactionedFlagMergeReadyVerdicts,
      claimVerdict: dal.claimVerdictForMergeExecution,
      releaseVerdictClaim: dal.releaseVerdictClaimForMergeExecution,
      deferVerdictClaim: dal.deferVerdictClaimForMergeExecution,
      getRunById: async () => null,
      reserveMergeSlot: async (...args) => {
        calls.reservations += 1;
        return dal.reserveOverseerMergeSlot(...args);
      },
      releaseMergeSlot: dal.releaseOverseerMergeSlot,
      recordOutcome: dal.recordVerdictMergeOutcome,
    },
    github: {
      findPullRequest: async () => ({
        exists: true,
        state: 'open',
        checks: { total: 1, passed: 1, failed: 0, pending: 0 },
        mergeable: true,
        mergeableState: 'clean',
        changedFilePaths: ['src/code.ts'],
        baseBranch: 'dev',
        headSha: 'head',
        htmlUrl: 'https://github.test/pull/1',
        pr: { owner: 'thinmansoftware', repo: 'bdc-harness', number: 1 },
      }),
      approvePullRequest: async () => {
        calls.approvals += 1;
        return { approved: true };
      },
      mergePullRequest: async () => {
        calls.merges += 1;
        return { merged: true, mergeSha: 'merged' };
      },
    },
    readPolicy: () => ({
      service_enabled: true,
      emergency_stop: false,
      legacy_dry_run: false,
      capability_flags: {
        escalation: false,
        repair: false,
        branch: false,
        lifecycle: false,
        merge: true,
      },
    }),
    repoConfig: { 'thinmansoftware/bdc-harness': { baseBranch: 'dev' } },
  };
  return { options, calls };
}

async function makeDue(): Promise<void> {
  await db.query(`UPDATE overseer_verdicts SET merge_not_before = '2000-01-01T00:00:00.000Z'
    WHERE id = 'verdict' AND actioned_at IS NULL`);
}

for (const reason of [
  'review_gate_reviews_unavailable',
  'review_gate_reviews_lookup_failed',
  'review_gate_approval_missing_for_head',
]) {
  test(`real DAL recovers ${reason} on the same head within the existing retry budget`, async () => {
    const h = harness();
    if (reason === 'review_gate_reviews_lookup_failed') {
      h.options.github.listPullRequestReviews = async () => {
        throw new Error('lookup failed');
      };
    } else if (reason === 'review_gate_approval_missing_for_head') {
      h.options.github.listPullRequestReviews = async () => [
        { login: 'gate', state: 'CHANGES_REQUESTED', commitId: 'head' },
      ];
    }
    await runMergeExecutionBridgeOnce(h.options);
    const row = (
      await db.query<OverseerVerdictRow>(`SELECT * FROM overseer_verdicts WHERE id = 'verdict'`)
    ).rows[0];
    expect(row?.actioned_at).toBeNull();
    expect(row?.merge_attempts).toBe(1);
    expect(row?.merge_last_transient_reason).toBe(reason);
    expect(Date.parse(row?.merge_not_before ?? '')).toBeGreaterThan(Date.now());
    expect(h.calls).toEqual({ reservations: 0, approvals: 0, merges: 0 });
    h.options.github.listPullRequestReviews = async () => [
      { login: 'gate', state: 'APPROVED', commitId: 'head' },
    ];
    await runMergeExecutionBridgeOnce(h.options);
    expect(h.calls.merges).toBe(0);
    await makeDue();
    await runMergeExecutionBridgeOnce(h.options);
    await runMergeExecutionBridgeOnce(h.options);
    expect(h.calls).toEqual({ reservations: 1, approvals: 1, merges: 1 });
  });
}

test('continuing rejection blocks every retry and exhaustion stays terminal', async () => {
  const h = harness();
  h.options.retryMaxAttempts = 2;
  h.options.github.listPullRequestReviews = async () => [
    { login: 'gate', state: 'CHANGES_REQUESTED', commitId: 'head' },
  ];
  await runMergeExecutionBridgeOnce(h.options);
  await makeDue();
  await runMergeExecutionBridgeOnce(h.options);
  h.options.github.listPullRequestReviews = async () => [
    { login: 'gate', state: 'APPROVED', commitId: 'head' },
  ];
  await runMergeExecutionBridgeOnce(h.options);
  expect(h.calls).toEqual({ reservations: 0, approvals: 0, merges: 0 });
  const row = (
    await db.query<{ action_reason: string }>(
      `SELECT action_reason FROM overseer_verdicts WHERE id = 'verdict'`
    )
  ).rows[0];
  expect(row?.action_reason).toBe('transient_exhausted:review_gate_approval_missing_for_head');
  expect(classifyMergeSkip('execution_evidence_unavailable')).toBe('terminal');
});
