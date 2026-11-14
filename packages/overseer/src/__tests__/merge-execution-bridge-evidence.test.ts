import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { OverseerVerdictRow, OverseerWatchRun } from '@archon/core/db/overseer';
import {
  runMergeExecutionBridgeOnce,
  type MergeExecutionBridgeOptions,
} from '../merge-execution-bridge';
import type { OverseerWorkflowEvent, PullRequestEvidence } from '../types';

const HEAD = 'a'.repeat(40);
const OLD_HEAD = 'b'.repeat(40);
const ERROR = `EVIDENCE_ERROR: tests_status=no_command_declared ${'x'.repeat(350)}`;
const savedEnv = new Map(
  [
    'MERGE_MANAGER_EVIDENCE_ADJUDICATORS',
    'MERGE_MANAGER_REPO_POLICY',
    'OVERSEER_MERGE_REPO_CONFIG',
    'MERGE_MANAGER_REVIEW_GATE_LOGIN',
  ].map(key => [key, process.env[key]])
);
afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function fixture() {
  delete process.env.MERGE_MANAGER_REPO_POLICY;
  delete process.env.OVERSEER_MERGE_REPO_CONFIG;
  delete process.env.MERGE_MANAGER_EVIDENCE_ADJUDICATORS;
  const verdict = {
    id: 'verdict-evidence',
    run_id: 'run-evidence',
    wo_id: 'WO-EVIDENCE',
    head_sha: HEAD,
    proposed_action: 'flag_merge_ready',
    merge_attempts: 0,
  } as OverseerVerdictRow;
  const run: OverseerWatchRun = {
    id: 'run-evidence',
    woId: 'WO-EVIDENCE',
    owner: 'thinmansoftware',
    repo: 'bdc-harness',
    // WO-HARNESS-MERGE-GATES-01: a run recorded failed at any node is held; the fixture is a passed run.
    status: 'completed',
    metadata: {},
    headBranch: 'archon/evidence',
  };
  const pr: PullRequestEvidence = {
    exists: true,
    state: 'open',
    checks: { total: 1, passed: 1, failed: 0, pending: 0 },
    mergeable: true,
    mergeableState: 'clean',
    changedFilePaths: ['src/code.ts'],
    baseBranch: 'dev',
    headSha: HEAD,
    htmlUrl: 'https://github.test/pull/42',
    pr: { owner: 'thinmansoftware', repo: 'bdc-harness', number: 42, author: 'builder-login' },
  };
  const comments: { body: string; authorLogin: string }[] = [];
  let finalized = false;
  const recordOutcome = mock(async () => {
    finalized = true;
  });
  const releaseVerdictClaim = mock(async () => true);
  const releaseMergeSlot = mock(async () => undefined);
  const reserveMergeSlot = mock(async () => true);
  const approvePullRequest = mock(async () => ({ approved: true }));
  const mergePullRequest = mock(async () => ({ merged: true, sha: 'c'.repeat(40) }));
  const commentOnPullRequest = mock(async ({ body }: { body: string }) => {
    comments.push({ body, authorLogin: 'thinman-overseer' });
    return { commented: true };
  });
  const addPullRequestLabels = mock(async () => undefined);
  const getRunById = mock(async () => run);
  const readRunEvents = mock(
    async (): Promise<OverseerWorkflowEvent[]> => [
      {
        id: 'failed-event',
        workflow_run_id: 'run-evidence',
        event_type: 'node_failed',
        step_name: 'manifest-evidence-check',
        data: { error: ERROR },
      },
    ]
  );
  const options: MergeExecutionBridgeOptions = {
    store: {
      listUnactionedVerdicts: async () => (finalized ? [] : [verdict]),
      claimVerdict: async () => true,
      releaseVerdictClaim,
      recordOutcome,
      getRunById,
      reserveMergeSlot,
      releaseMergeSlot,
      getEarliestMergeSlotReservation: async () => null,
    },
    github: {
      findPullRequest: async () => pr,
      mergePullRequest,
      approvePullRequest,
      commentAuthorLogin: 'thinman-overseer',
      listPullRequestComments: async () => comments,
      commentOnPullRequest,
      addPullRequestLabels,
    },
    readRunEvents,
    hasQualifiedReview: async () => true,
    reviewConflictAtHead: async () => null,
    readPolicy: () => ({
      service_enabled: true,
      emergency_stop: false,
      legacy_dry_run: false,
      capability_flags: {
        merge: true,
        escalation: false,
        repair: false,
        branch: false,
        lifecycle: false,
      },
    }),
    repoConfig: { 'thinmansoftware/bdc-harness': { baseBranch: 'dev' } },
  };
  return {
    options,
    verdict,
    run,
    pr,
    comments,
    readRunEvents,
    mergePullRequest,
    releaseMergeSlot,
    reserveMergeSlot,
    approvePullRequest,
    releaseVerdictClaim,
    recordOutcome,
    commentOnPullRequest,
    addPullRequestLabels,
    getRunById,
  };
}

describe('verdict-driven originating-run evidence gate', () => {
  test('bridge evidence (a): failed node holds before merge, releases slot and keeps verdict retryable', async () => {
    const f = fixture();
    await runMergeExecutionBridgeOnce(f.options);
    expect(f.mergePullRequest).not.toHaveBeenCalled();
    // #5358: a held verdict takes no merge slot and posts no approval
    expect(f.reserveMergeSlot).not.toHaveBeenCalled();
    expect(f.releaseMergeSlot).not.toHaveBeenCalled();
    expect(f.approvePullRequest).not.toHaveBeenCalled();
    expect(f.releaseVerdictClaim).toHaveBeenCalledWith(
      'verdict-evidence',
      'originating_run_failed_evidence_gate'
    );
    expect(f.recordOutcome).not.toHaveBeenCalled();
    expect(f.readRunEvents).toHaveBeenCalledWith('run-evidence');
    expect(f.comments).toHaveLength(1);
    expect(f.comments[0]?.body.split('\n')).toContain(
      'Merge held: originating run run-evidence failed manifest-evidence-check'
    );
    expect(f.comments[0]?.body).toContain(ERROR.slice(0, 300));
    expect(f.comments[0]?.body).not.toContain(ERROR.slice(0, 301));
    expect(f.addPullRequestLabels).toHaveBeenCalledWith({
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      number: 42,
      labels: ['merge:held-evidence'],
    });
    await runMergeExecutionBridgeOnce(f.options);
    expect(f.commentOnPullRequest).toHaveBeenCalledTimes(1);
    expect(f.mergePullRequest).not.toHaveBeenCalled();
  });

  test('bridge evidence (b): passing node merges through the existing exact-head path', async () => {
    const f = fixture();
    f.readRunEvents.mockImplementation(async () => [
      {
        id: 'pass',
        workflow_run_id: 'run-evidence',
        event_type: 'node_completed',
        step_name: 'manifest-evidence-check',
        data: {},
      },
    ]);
    await runMergeExecutionBridgeOnce(f.options);
    expect(f.mergePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ expectedHeadSha: HEAD, mergeMethod: 'squash' })
    );
    expect(f.recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ mutationSent: true, reason: 'merge_executed' })
    );
    expect(f.commentOnPullRequest).toHaveBeenCalledTimes(1);
    expect(f.comments[0]?.body).not.toContain('Merge held:');
    expect(f.addPullRequestLabels).not.toHaveBeenCalled();
  });

  test('bridge evidence (c): throwing or missing events reader is unreadable, never merged', async () => {
    for (const absent of [false, true]) {
      const f = fixture();
      f.options.readRunEvents = absent
        ? undefined
        : async () => {
            throw new Error('events unavailable');
          };
      await runMergeExecutionBridgeOnce(f.options);
      expect(f.mergePullRequest).not.toHaveBeenCalled();
      expect(f.releaseVerdictClaim).toHaveBeenCalledWith(
        'verdict-evidence',
        'originating_run_unreadable'
      );
      expect(f.reserveMergeSlot).not.toHaveBeenCalled();
      expect(f.approvePullRequest).not.toHaveBeenCalled();
      expect(f.comments[0]?.body).toContain('Merge held: originating run run-evidence unreadable');
    }
  });

  test('Test 1 (#5358): five passes over a held verdict post no approval, take no slot, comment once', async () => {
    const f = fixture();
    f.options.store.listUnactionedVerdicts = async () => [f.verdict];
    for (let pass = 0; pass < 5; pass += 1) await runMergeExecutionBridgeOnce(f.options);
    expect(f.approvePullRequest).not.toHaveBeenCalled();
    expect(f.reserveMergeSlot).not.toHaveBeenCalled();
    expect(f.mergePullRequest).not.toHaveBeenCalled();
    expect(f.comments).toHaveLength(1);
    expect(f.readRunEvents.mock.calls.length).toBeGreaterThanOrEqual(5);
  });

  test('Test 3 (#5358): an unchanged head collects at most one approval across passes that stop before the merge', async () => {
    const f = fixture();
    f.readRunEvents.mockImplementation(async () => [
      {
        id: 'pass',
        workflow_run_id: 'run-evidence',
        event_type: 'node_completed',
        step_name: 'manifest-evidence-check',
        data: {},
      },
    ]);
    f.options.reviewConflictAtHead = async () => 'review_in_flight';
    f.options.store.listUnactionedVerdicts = async () => [f.verdict];
    for (let pass = 0; pass < 3; pass += 1) await runMergeExecutionBridgeOnce(f.options);
    expect(f.mergePullRequest).not.toHaveBeenCalled();
    expect(f.approvePullRequest).toHaveBeenCalledTimes(1);
    // a different head is a different approval
    f.verdict.head_sha = 'f'.repeat(40);
    f.pr.headSha = 'f'.repeat(40);
    await runMergeExecutionBridgeOnce(f.options);
    expect(f.approvePullRequest).toHaveBeenCalledTimes(2);
  });

  test('bridge evidence (d): runless verdicts merge without reading run rows or events', async () => {
    const f = fixture();
    f.verdict.run_id = 'pr-discovery:thinmansoftware/bdc-harness#42';
    await runMergeExecutionBridgeOnce(f.options);
    expect(f.mergePullRequest).toHaveBeenCalledTimes(1);
    expect(f.getRunById).not.toHaveBeenCalled();
    expect(f.readRunEvents).not.toHaveBeenCalled();
  });

  test('bridge evidence (e): current-head human adjudication lifts hold on the next tick; old head and bots cannot', async () => {
    const f = fixture();
    process.env.MERGE_MANAGER_EVIDENCE_ADJUDICATORS =
      'john-login, builder-login, review-gate, thinman-overseer, agent[bot]';
    for (const author of [
      'john-login',
      'builder-login',
      'review-gate',
      'thinman-overseer',
      'agent[bot]',
    ]) {
      f.comments.push({
        authorLogin: author,
        body: `Evidence-Adjudication: docs canary ${author === 'john-login' ? OLD_HEAD : HEAD}`,
      });
    }
    process.env.MERGE_MANAGER_REVIEW_GATE_LOGIN = 'review-gate';
    try {
      await runMergeExecutionBridgeOnce(f.options);
      expect(f.mergePullRequest).not.toHaveBeenCalled();
      f.comments.push({
        authorLogin: 'john-login',
        body: `Evidence-Adjudication: docs canary ${HEAD}`,
      });
      await runMergeExecutionBridgeOnce(f.options);
      expect(f.mergePullRequest).toHaveBeenCalledTimes(1);
      expect(f.recordOutcome).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'merge_executed' })
      );
    } finally {
      delete process.env.MERGE_MANAGER_REVIEW_GATE_LOGIN;
    }
  });

  test('bridge evidence: disabled policy makes no evidence visibility writes', async () => {
    const f = fixture();
    f.options.readPolicy = () => ({
      service_enabled: true,
      emergency_stop: false,
      legacy_dry_run: true,
      capability_flags: {
        merge: true,
        escalation: false,
        repair: false,
        branch: false,
        lifecycle: false,
      },
    });
    await runMergeExecutionBridgeOnce(f.options);
    expect(f.readRunEvents).not.toHaveBeenCalled();
    expect(f.mergePullRequest).not.toHaveBeenCalled();
    expect(f.commentOnPullRequest).not.toHaveBeenCalled();
    expect(f.addPullRequestLabels).not.toHaveBeenCalled();
  });
});
