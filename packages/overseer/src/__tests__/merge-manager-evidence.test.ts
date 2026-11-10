import { afterEach, describe, expect, mock, test } from 'bun:test';
import { createMergeManager, type MergeManagerDeps } from '../merge-manager';
import type { QualifiedMergeEvidence } from '../actions/merge-ready';
import type { OverseerWorkflowEvent, WatchedRunRecord } from '../types';

const HEAD = 'a'.repeat(40);
const NEXT_HEAD = 'b'.repeat(40);
const ERROR = `EVIDENCE_ERROR: no executable tests ${'x'.repeat(350)}`;
const oldAdjudicators = process.env.MERGE_MANAGER_EVIDENCE_ADJUDICATORS;
afterEach(() => {
  if (oldAdjudicators === undefined) delete process.env.MERGE_MANAGER_EVIDENCE_ADJUDICATORS;
  else process.env.MERGE_MANAGER_EVIDENCE_ADJUDICATORS = oldAdjudicators;
});

function event(event_type = 'node_failed'): OverseerWorkflowEvent {
  return {
    id: 'event-1',
    workflow_run_id: 'run-evidence',
    event_type,
    step_name: 'manifest-evidence-check',
    data: { error: ERROR },
  };
}

function fixture(overrides: Partial<MergeManagerDeps> = {}) {
  const record: WatchedRunRecord = {
    runId: 'run-evidence',
    woId: 'WO-EVIDENCE',
    owner: 'thinmansoftware',
    repo: 'bdc-harness',
    status: 'failed',
    action: 'merge_ready',
    reason: 'green PR',
    workingPath: '/worktree/run-evidence',
    prEvidence: {
      exists: true,
      state: 'open',
      checks: { total: 1, passed: 1, failed: 0, pending: 0 },
      mergeable: true,
      headSha: HEAD,
      pr: { owner: 'thinmansoftware', repo: 'bdc-harness', number: 42, author: 'builder-login' },
    },
  };
  const comments: { body: string; authorLogin: string }[] = [];
  const commentOnPullRequest = mock(async ({ body }: { body: string }) => {
    comments.push({ body, authorLogin: 'thinman-overseer' });
    return { commented: true };
  });
  const addPullRequestLabels = mock(async () => undefined);
  const mergePullRequest = mock(async () => ({ merged: true, sha: 'c'.repeat(40) }));
  const insertOverseerAction = mock(async () => undefined);
  const readRunEvents = mock(async () => [event()]);
  const manager = createMergeManager({
    mode: 'execute',
    mutationsEnabled: true,
    allowedBases: ['dev'],
    reviewGateLogin: 'review-gate',
    commentAuthorLogin: 'thinman-overseer',
    readWorktreeHeadSha: async () => record.prEvidence.headSha ?? null,
    readRunEvents,
    listPullRequestReviews: async () => [
      { login: 'review-gate', state: 'APPROVED', commitId: record.prEvidence.headSha ?? '' },
    ],
    assembleEvidence: async () => ({
      evidenceDigest: 'd'.repeat(64),
      evidence: {
        record,
        registry: { schema_version: 'overseer-action-policy-v1', entries: [] },
        owner: 'thinmansoftware',
        repository: 'bdc-harness',
        pr_number: 42,
        base_branch: 'dev',
        resulting_deployment_effect: 'none',
        credential_principal: 'overseer-merge-manager-v1',
        action_kind: 'MERGE',
        changed_files: ['src/index.ts'],
        head_sha: record.prEvidence.headSha ?? '',
        base_sha: 'e'.repeat(40),
        required_checks: [
          { name: 'ci', conclusion: 'success', head_sha: record.prEvidence.headSha ?? '' },
        ],
        reviews: [{ resolved: true }],
        independent_review: null,
        operator: {
          identity: 'overseer-merge-manager-v1',
          provider: 'overseer',
          model_family: 'merge-manager',
        },
        manifest: null,
        proposal_id: null,
        proposal_present: false,
        fusion: null,
        expected_verifier_registry_digest: '',
        final_state_consistent: true,
      } satisfies QualifiedMergeEvidence,
    }),
    judge: async input => ({
      schemaVersion: 'overseer-grok-merge-disposition-v1',
      disposition: 'approve',
      reason: 'judge_approve',
      woId: input.woId,
      prNumber: input.prNumber,
      headSha: input.headSha,
      baseSha: input.baseSha,
      evidenceDigest: input.evidenceDigest,
      operator: input.operator,
    }),
    findPullRequest: async () => record.prEvidence,
    mergePullRequest,
    insertOverseerAction,
    listPullRequestComments: async () => comments,
    commentOnPullRequest,
    addPullRequestLabels,
    ...overrides,
  });
  return {
    manager,
    record,
    comments,
    commentOnPullRequest,
    addPullRequestLabels,
    mergePullRequest,
    insertOverseerAction,
    readRunEvents,
  };
}

describe('originating run evidence gate', () => {
  test('Test 1: failed evidence gate holds with a receipt, comment and label, never merging', async () => {
    const f = fixture();
    const result = await f.manager(f.record);
    expect(result).toMatchObject({
      status: 'held',
      reason: 'originating_run_failed_evidence_gate',
      execution: null,
    });
    expect(result.receipt).toMatchObject({
      disposition: 'hold',
      reason: 'originating_run_failed_evidence_gate',
    });
    expect(f.mergePullRequest).not.toHaveBeenCalled();
    expect(f.readRunEvents).toHaveBeenCalledWith('run-evidence');
    expect(f.commentOnPullRequest).toHaveBeenCalledTimes(1);
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
    expect(f.insertOverseerAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'merge_denied',
        result: 'originating_run_failed_evidence_gate',
      })
    );
  });

  test('Test 2: passing evidence gate follows the existing merge path', async () => {
    const f = fixture({ readRunEvents: async () => [event('node_completed')] });
    expect((await f.manager(f.record)).status).toBe('executed');
    expect(f.mergePullRequest).toHaveBeenCalledTimes(1);
    expect(f.mergePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ expectedHeadSha: HEAD })
    );
    expect(f.commentOnPullRequest).not.toHaveBeenCalled();
    expect(f.addPullRequestLabels).not.toHaveBeenCalled();
  });

  test('Test 3: one trusted comment per head, including across manager instances', async () => {
    const f = fixture();
    await f.manager(f.record);
    await f.manager(f.record);
    await f.manager(f.record);
    expect(f.comments).toHaveLength(1);
    const restarted = fixture({ listPullRequestComments: async () => f.comments });
    await restarted.manager(restarted.record);
    expect(restarted.commentOnPullRequest).not.toHaveBeenCalled();
    f.record.prEvidence.headSha = NEXT_HEAD;
    await f.manager(f.record);
    expect(f.comments).toHaveLength(2);
    expect(f.comments[1]?.body).toContain(NEXT_HEAD);
    expect(f.mergePullRequest).not.toHaveBeenCalled();
  });

  test('Test 4: only an allowlisted non-bot adjudicator naming the current full SHA lifts failure', async () => {
    process.env.MERGE_MANAGER_EVIDENCE_ADJUDICATORS =
      'john-login, builder-login, builder[bot], review-gate, thinman-overseer, overseer-merge-manager-v1';
    const cases = [
      { login: 'john-login', body: `Evidence-Adjudication: docs canary ${HEAD}`, merges: true },
      { login: 'outsider', body: `Evidence-Adjudication: docs canary ${HEAD}`, merges: false },
      { login: 'builder[bot]', body: `Evidence-Adjudication: docs canary ${HEAD}`, merges: false },
      { login: 'builder-login', body: `Evidence-Adjudication: docs canary ${HEAD}`, merges: false },
      { login: 'review-gate', body: `Evidence-Adjudication: docs canary ${HEAD}`, merges: false },
      {
        login: 'thinman-overseer',
        body: `Evidence-Adjudication: docs canary ${HEAD}`,
        merges: false,
      },
      {
        login: 'overseer-merge-manager-v1',
        body: `Evidence-Adjudication: docs canary ${HEAD}`,
        merges: false,
      },
      {
        login: 'john-login',
        body: `Evidence-Adjudication: docs canary ${NEXT_HEAD}`,
        merges: false,
      },
      {
        login: 'john-login',
        body: `Evidence-Adjudication: docs canary ${HEAD.slice(0, 8)}`,
        merges: false,
      },
      {
        login: 'john-login',
        body: `Evidence-Adjudication: docs canary\nOld quote: ${HEAD}`,
        merges: false,
      },
    ];
    for (const c of cases) {
      const f = fixture();
      f.comments.push({ authorLogin: c.login, body: c.body });
      const result = await f.manager(f.record);
      expect(result.status).toBe(c.merges ? 'executed' : 'held');
      expect(f.mergePullRequest).toHaveBeenCalledTimes(c.merges ? 1 : 0);
      if (!c.merges)
        expect(result).toMatchObject({ reason: 'originating_run_failed_evidence_gate' });
    }
    for (const value of [undefined, '']) {
      if (value === undefined) delete process.env.MERGE_MANAGER_EVIDENCE_ADJUDICATORS;
      else process.env.MERGE_MANAGER_EVIDENCE_ADJUDICATORS = value;
      const f = fixture();
      f.comments.push({
        authorLogin: 'john-login',
        body: `Evidence-Adjudication: docs canary ${HEAD}`,
      });
      expect(await f.manager(f.record)).toMatchObject({
        reason: 'originating_run_failed_evidence_gate',
      });
      expect(f.mergePullRequest).not.toHaveBeenCalled();
    }
  });

  test('Test 5: unreadable events fail closed with a visible hold and no merge', async () => {
    const f = fixture({
      readRunEvents: async () => {
        throw new Error('run lookup unavailable');
      },
    });
    expect(await f.manager(f.record)).toMatchObject({
      status: 'held',
      reason: 'originating_run_unreadable',
      receipt: { reason: 'originating_run_unreadable' },
    });
    expect(f.mergePullRequest).not.toHaveBeenCalled();
    expect(f.comments).toHaveLength(1);
    expect(f.comments[0]?.body).toContain('Merge held: originating run run-evidence unreadable');
    expect(f.comments[0]?.body).toContain('run lookup unavailable');
    expect(f.addPullRequestLabels).toHaveBeenCalledTimes(1);
  });

  test('Test 6: no_run human PRs skip the events reader and merge as before', async () => {
    const f = fixture();
    f.record.runId = 'pr-discovery:thinmansoftware/bdc-harness#42';
    f.record.metadata = { discovery_source: 'pr_first_sweep' };
    delete f.record.workingPath;
    expect((await f.manager(f.record)).status).toBe('executed');
    expect(f.readRunEvents).not.toHaveBeenCalled();
    expect(f.mergePullRequest).toHaveBeenCalledTimes(1);
  });

  test('failed run naming the evidence node holds even without its node_failed event', async () => {
    const f = fixture({ readRunEvents: async () => [] });
    f.record.reason = 'workflow failed: manifest-evidence-check';
    expect(await f.manager(f.record)).toMatchObject({
      reason: 'originating_run_failed_evidence_gate',
    });
    expect(f.mergePullRequest).not.toHaveBeenCalled();
  });

  test('missing events reader is unreadable rather than a bypass', async () => {
    const f = fixture({ readRunEvents: undefined });
    expect(await f.manager(f.record)).toMatchObject({ reason: 'originating_run_unreadable' });
    expect(f.mergePullRequest).not.toHaveBeenCalled();
  });

  test('hold visibility respects mode and mutation gates', async () => {
    for (const options of [
      { mode: 'hold-canary', mutationsEnabled: true, comments: 0 },
      { mode: 'execute', mutationsEnabled: false, comments: 0 },
      { mode: 'comment_findings', mutationsEnabled: false, comments: 1 },
    ]) {
      const f = fixture(options);
      expect(await f.manager(f.record)).toMatchObject({
        reason: 'originating_run_failed_evidence_gate',
      });
      expect(f.commentOnPullRequest).toHaveBeenCalledTimes(options.comments);
      expect(f.addPullRequestLabels).not.toHaveBeenCalled();
      expect(f.mergePullRequest).not.toHaveBeenCalled();
    }
  });
});
