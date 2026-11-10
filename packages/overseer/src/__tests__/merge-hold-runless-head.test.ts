import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { OverseerVerdictRow, OverseerWatchRun } from '@archon/core/db/overseer';
import { createMergeManager, type MergeManagerDeps } from '../merge-manager';
import {
  runMergeExecutionBridgeOnce,
  type MergeExecutionBridgeOptions,
} from '../merge-execution-bridge';
import {
  findOriginatingRunForPullRequest,
  startedAtEpoch,
  type OriginatingRun,
  type OriginatingRunCandidate,
} from '../originating-run-lookup';
import type { QualifiedMergeEvidence } from '../actions/merge-ready';
import type { OverseerWorkflowEvent, PullRequestEvidence, WatchedRunRecord } from '../types';

const HEAD = 'a'.repeat(40);
const OLD_HEAD = 'b'.repeat(40);
const RUN_ID = 'run-origin';
const BRANCH = 'archon/task-web-worker-123-abc';
const ERROR = 'EVIDENCE_ERROR: Tests: N/A (CODE spec declares no executable test command)';
const PR_URL = 'https://github.com/thinmansoftware/bdc-harness/pull/42';

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

function candidate(overrides: Partial<OriginatingRunCandidate>): OriginatingRunCandidate {
  return {
    id: 'run-x',
    status: 'completed',
    started_at: '2026-11-10 10:00:00',
    working_path: null,
    codebase_name: null,
    codebase_url: null,
    event_data: null,
    ...overrides,
  };
}

function failedEvent(): OverseerWorkflowEvent {
  return {
    id: 'event-failed',
    workflow_run_id: RUN_ID,
    event_type: 'node_failed',
    step_name: 'manifest-evidence-check',
    data: { error: ERROR },
  };
}

function passedEvent(): OverseerWorkflowEvent {
  return {
    id: 'event-passed',
    workflow_run_id: RUN_ID,
    event_type: 'node_completed',
    step_name: 'manifest-evidence-check',
    data: {},
  };
}

describe('findOriginatingRunForPullRequest', () => {
  const input = { owner: 'thinmansoftware', repo: 'bdc-harness', number: 42, headRef: BRANCH };

  test('Test 1: finds the run by PR URL in its open-pr output and by worktree branch, most recent wins', async () => {
    const byUrl = await findOriginatingRunForPullRequest(input, async () => [
      candidate({
        id: 'older',
        started_at: '2026-11-10 09:00:00',
        event_data: `{"o":"${PR_URL}"}`,
      }),
      candidate({
        id: 'newer',
        started_at: '2026-11-10 11:00:00',
        event_data: `{"o":"${PR_URL}"}`,
      }),
    ]);
    expect(byUrl?.runId).toBe('newer');
    const byBranch = await findOriginatingRunForPullRequest(input, async () => [
      candidate({
        id: 'worktree-run',
        codebase_name: 'thinmansoftware/bdc-harness',
        working_path: `/ws/worktrees/${BRANCH}`,
        status: 'running',
      }),
    ]);
    expect(byBranch).toEqual({ runId: 'worktree-run', status: 'running' });
  });

  test('Test 2: returns null for a human PR and never matches a longer PR number or a branch suffix', async () => {
    expect(await findOriginatingRunForPullRequest(input, async () => [])).toBeNull();
    const lookalike = await findOriginatingRunForPullRequest(input, async () => [
      candidate({ id: 'pr-420', event_data: `{"o":"${PR_URL}0"}` }),
      candidate({
        id: 'other-repo',
        event_data: '{"o":"https://github.com/thinmansoftware/shopops/pull/42"}',
      }),
      candidate({ id: 'longer-branch', working_path: `/ws/worktrees/${BRANCH}-2` }),
    ]);
    expect(lookalike).toBeNull();
  });

  test('bare codebase names (existing registrations) and repository_url bind the repository', async () => {
    const path = '/.archon/workspaces/thinmansoftware/bdc-harness/worktrees/' + BRANCH;
    // bare name equal to the repo, with an explicit owner/repo worktree path: matches
    const bare = await findOriginatingRunForPullRequest(input, async () => [
      candidate({
        id: 'bare',
        status: 'running',
        working_path: path,
        codebase_name: 'bdc-harness',
      }),
    ]);
    expect(bare).toEqual({ runId: 'bare', status: 'running' });
    // bare name of a DIFFERENT repo never matches, even with the same branch name
    expect(
      await findOriginatingRunForPullRequest(input, async () => [
        candidate({ id: 'other', working_path: path, codebase_name: 'shopops' }),
      ])
    ).toBeNull();
    // repository_url is authoritative: the https and ssh forms of the target repo match ...
    for (const url of [
      'https://github.com/thinmansoftware/bdc-harness.git',
      'https://github.com/thinmansoftware/bdc-harness',
      'git@github.com:thinmansoftware/bdc-harness.git',
    ]) {
      const hit = await findOriginatingRunForPullRequest(input, async () => [
        candidate({ id: 'url', status: 'running', working_path: path, codebase_url: url }),
      ]);
      expect(hit?.runId, url).toBe('url');
    }
    // ... and a url of another repo wins over a matching bare name
    expect(
      await findOriginatingRunForPullRequest(input, async () => [
        candidate({
          id: 'url-other',
          working_path: path,
          codebase_name: 'bdc-harness',
          codebase_url: 'https://github.com/thinmansoftware/shopops.git',
        }),
      ])
    ).toBeNull();
  });

  test('a Windows backslash worktree path still matches by branch and repository', async () => {
    const bs = String.fromCharCode(92);
    const winPath = [
      'C:',
      'ws',
      'thinmansoftware',
      'bdc-harness',
      'worktrees',
      ...BRANCH.split('/'),
    ].join(bs);
    const found = await findOriginatingRunForPullRequest(input, async () => [
      candidate({ id: 'win-run', status: 'running', working_path: winPath }),
    ]);
    expect(found).toEqual({ runId: 'win-run', status: 'running' });
  });

  test('a worktree branch only matches a run of the SAME repository', async () => {
    const path = '/ws/worktrees/' + BRANCH;
    // newer completed run of ANOTHER repo with the same branch name must not supersede
    const bound = await findOriginatingRunForPullRequest(input, async () => [
      candidate({
        id: 'target-failed',
        status: 'failed',
        started_at: '2026-11-10 09:00:00',
        working_path: path,
        codebase_name: 'thinmansoftware/bdc-harness',
      }),
      candidate({
        id: 'other-repo-newer',
        status: 'completed',
        started_at: '2026-11-10 11:00:00',
        working_path: path,
        codebase_name: 'thinmansoftware/shopops',
      }),
    ]);
    expect(bound).toEqual({ runId: 'target-failed', status: 'failed' });
    // no codebase link: fall back to the owner/repo segment of the worktree path
    const byPath = await findOriginatingRunForPullRequest(input, async () => [
      candidate({
        id: 'shopops-path',
        started_at: '2026-11-10 11:00:00',
        working_path: '/.archon/workspaces/thinmansoftware/shopops/worktrees/' + BRANCH,
      }),
      candidate({
        id: 'harness-path',
        started_at: '2026-11-10 09:00:00',
        working_path: '/.archon/workspaces/thinmansoftware/bdc-harness/worktrees/' + BRANCH,
      }),
    ]);
    expect(byPath?.runId).toBe('harness-path');
    // another repo only: no match at all
    expect(
      await findOriginatingRunForPullRequest(input, async () => [
        candidate({ id: 'x', working_path: path, codebase_name: 'thinmansoftware/shopops' }),
      ])
    ).toBeNull();
  });

  test('most recent run wins for Date values (PostgreSQL), ISO strings and SQLite strings, mixed', async () => {
    const asDate = await findOriginatingRunForPullRequest(input, async () => [
      candidate({ id: 'older', started_at: new Date('2026-11-10T09:00:00Z'), event_data: PR_URL }),
      candidate({ id: 'newer', started_at: new Date('2026-11-10T11:00:00Z'), event_data: PR_URL }),
    ]);
    expect(asDate?.runId).toBe('newer');
    const mixed = await findOriginatingRunForPullRequest(input, async () => [
      candidate({ id: 'sqlite-old', started_at: '2026-11-10 09:00:00', event_data: PR_URL }),
      candidate({ id: 'iso-mid', started_at: '2026-11-10T10:00:00.000Z', event_data: PR_URL }),
      candidate({
        id: 'date-new',
        started_at: new Date('2026-11-10T12:00:00Z'),
        event_data: PR_URL,
      }),
      candidate({ id: 'null-start', started_at: null, event_data: PR_URL }),
    ]);
    expect(mixed?.runId).toBe('date-new');
    // a SQLite string has no zone and is UTC, so it compares equal to the same instant as a Date
    expect(startedAtEpoch('2026-11-10 12:00:00')).toBe(new Date('2026-11-10T12:00:00Z').getTime());
    expect(startedAtEpoch(new Date('invalid'))).toBe(0);
    expect(startedAtEpoch('not a date')).toBe(0);
    expect(startedAtEpoch(null)).toBe(0);
  });

  test('a rejecting list propagates so callers can fail closed', async () => {
    await expect(
      findOriginatingRunForPullRequest(input, async () => {
        throw new Error('db down');
      })
    ).rejects.toThrow('db down');
  });
});

function managerFixture(overrides: Partial<MergeManagerDeps> = {}) {
  const record: WatchedRunRecord = {
    runId: 'pr-discovery:thinmansoftware/bdc-harness#42',
    woId: 'gh:thinmansoftware/bdc-harness#42',
    owner: 'thinmansoftware',
    repo: 'bdc-harness',
    status: 'pr_discovered',
    headBranch: BRANCH,
    metadata: { discovery_source: 'pr_first_sweep', head_sha: HEAD, pr_number: '42' },
    action: 'merge_ready',
    reason: 'green PR',
    prEvidence: {
      exists: true,
      state: 'open',
      checks: { total: 1, passed: 1, failed: 0, pending: 0 },
      mergeable: true,
      headSha: HEAD,
      pr: {
        owner: 'thinmansoftware',
        repo: 'bdc-harness',
        number: 42,
        headRef: BRANCH,
        author: 'builder-login',
      },
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
  const findOriginatingRun = mock(
    async (): Promise<OriginatingRun | null> => ({ runId: RUN_ID, status: 'failed' })
  );
  const readRunEvents = mock(async () => [failedEvent()]);
  const manager = createMergeManager({
    mode: 'execute',
    mutationsEnabled: true,
    allowedBases: ['dev'],
    reviewGateLogin: 'review-gate',
    commentAuthorLogin: 'thinman-overseer',
    readRunEvents,
    findOriginatingRun,
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
    findOriginatingRun,
    readRunEvents,
  };
}

describe('merge manager: run-less candidate traced to its originating run', () => {
  test('Test 3: failed-evidence run, run-less candidate on a moved head, is held with label and one comment', async () => {
    const f = managerFixture();
    const result = await f.manager(f.record);
    expect(result).toMatchObject({
      status: 'held',
      reason: 'originating_run_failed_evidence_gate',
      execution: null,
    });
    expect(f.mergePullRequest).not.toHaveBeenCalled();
    expect(f.findOriginatingRun).toHaveBeenCalledWith({
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      number: 42,
      headRef: BRANCH,
    });
    expect(f.readRunEvents).toHaveBeenCalledWith(RUN_ID);
    expect(f.comments).toHaveLength(1);
    expect(f.comments[0]?.body.split('\n')).toContain(
      `Merge held: originating run ${RUN_ID} failed manifest-evidence-check`
    );
    expect(f.addPullRequestLabels).toHaveBeenCalledWith({
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      number: 42,
      labels: ['merge:held-evidence'],
    });
    await f.manager(f.record);
    expect(f.comments).toHaveLength(1);
  });

  test('Test 4: only an adjudication naming the NEW head lifts it; one naming the old head does not', async () => {
    process.env.MERGE_MANAGER_EVIDENCE_ADJUDICATORS = 'john-login';
    const stale = managerFixture();
    stale.comments.push({
      authorLogin: 'john-login',
      body: `Evidence-Adjudication: canary ${OLD_HEAD}`,
    });
    expect((await stale.manager(stale.record)).status).toBe('held');
    expect(stale.mergePullRequest).not.toHaveBeenCalled();

    const current = managerFixture();
    current.comments.push({
      authorLogin: 'john-login',
      body: `Evidence-Adjudication: canary ${HEAD}`,
    });
    expect((await current.manager(current.record)).status).toBe('executed');
    expect(current.mergePullRequest).toHaveBeenCalledTimes(1);
  });

  test('Test 6: a human PR (no originating run) and a passing gate both proceed as before', async () => {
    const human = managerFixture({ findOriginatingRun: mock(async () => null) });
    expect((await human.manager(human.record)).status).toBe('executed');
    expect(human.mergePullRequest).toHaveBeenCalledTimes(1);
    expect(human.comments).toHaveLength(0);

    const passing = managerFixture({ readRunEvents: mock(async () => [passedEvent()]) });
    expect((await passing.manager(passing.record)).status).toBe('executed');
    expect(passing.mergePullRequest).toHaveBeenCalledTimes(1);
  });

  test('with no lookup wired the run-less path is unchanged', async () => {
    const f = managerFixture({ findOriginatingRun: undefined });
    expect((await f.manager(f.record)).status).toBe('executed');
  });

  test('Test 7: a rejecting lookup fails closed as originating_run_unreadable', async () => {
    const f = managerFixture({
      findOriginatingRun: mock(async () => {
        throw new Error('run store unavailable');
      }),
    });
    const result = await f.manager(f.record);
    expect(result).toMatchObject({ status: 'held', reason: 'originating_run_unreadable' });
    expect(f.mergePullRequest).not.toHaveBeenCalled();
    expect(f.comments).toHaveLength(1);
    expect(f.comments[0]?.body).toContain('run store unavailable');
  });

  test('Test 8: a run still running holds as originating_run_in_progress, with no label, one comment per head', async () => {
    for (const status of ['running', 'pending']) {
      const f = managerFixture({
        findOriginatingRun: mock(async () => ({ runId: RUN_ID, status })),
        readRunEvents: mock(async () => []),
      });
      const result = await f.manager(f.record);
      expect(result).toMatchObject({ status: 'held', reason: 'originating_run_in_progress' });
      expect(f.mergePullRequest).not.toHaveBeenCalled();
      expect(f.addPullRequestLabels).not.toHaveBeenCalled();
      expect(f.comments).toHaveLength(1);
      expect(f.comments[0]?.body.split('\n')).toContain(
        `Merge held: originating run ${RUN_ID} has not finished`
      );
      await f.manager(f.record);
      expect(f.comments).toHaveLength(1);
    }
  });

  test('Test 9: released when the run ends; a failed gate then holds with the evidence reason', async () => {
    let status = 'running';
    let events: OverseerWorkflowEvent[] = [];
    const f = managerFixture({
      findOriginatingRun: mock(async () => ({ runId: RUN_ID, status })),
      readRunEvents: mock(async () => events),
    });
    expect((await f.manager(f.record)).reason).toBe('originating_run_in_progress');
    status = 'failed';
    events = [failedEvent()];
    const failed = await f.manager(f.record);
    expect(failed).toMatchObject({
      status: 'held',
      reason: 'originating_run_failed_evidence_gate',
    });
    expect(f.comments).toHaveLength(2);
    expect(f.addPullRequestLabels).toHaveBeenCalledTimes(1);
    expect(f.mergePullRequest).not.toHaveBeenCalled();

    const ok = managerFixture({
      findOriginatingRun: mock(async () => ({ runId: RUN_ID, status: 'completed' })),
      readRunEvents: mock(async () => [passedEvent()]),
    });
    expect((await ok.manager(ok.record)).status).toBe('executed');
  });
});

function bridgeFixture(runless: { originating: OriginatingRun | null | 'throw' }) {
  delete process.env.MERGE_MANAGER_REPO_POLICY;
  delete process.env.OVERSEER_MERGE_REPO_CONFIG;
  delete process.env.MERGE_MANAGER_EVIDENCE_ADJUDICATORS;
  const verdict = {
    id: 'verdict-runless',
    run_id: 'pr-discovery:thinmansoftware/bdc-harness#42',
    wo_id: 'gh:thinmansoftware/bdc-harness#42',
    head_sha: HEAD,
    proposed_action: 'flag_merge_ready',
    merge_attempts: 0,
  } as OverseerVerdictRow;
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
    pr: {
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      number: 42,
      headRef: BRANCH,
      author: 'builder-login',
    },
  };
  const comments: { body: string; authorLogin: string }[] = [];
  let finalized = false;
  const recordOutcome = mock(async () => {
    finalized = true;
  });
  const releaseVerdictClaim = mock(async () => true);
  const releaseMergeSlot = mock(async () => undefined);
  const mergePullRequest = mock(async () => ({ merged: true, sha: 'c'.repeat(40) }));
  const commentOnPullRequest = mock(async ({ body }: { body: string }) => {
    comments.push({ body, authorLogin: 'thinman-overseer' });
    return { commented: true };
  });
  const addPullRequestLabels = mock(async () => undefined);
  const findOriginatingRun = mock(async (): Promise<OriginatingRun | null> => {
    if (runless.originating === 'throw') throw new Error('run store unavailable');
    return runless.originating;
  });
  const readRunEvents = mock(async (): Promise<OverseerWorkflowEvent[]> => [failedEvent()]);
  const options: MergeExecutionBridgeOptions = {
    store: {
      listUnactionedVerdicts: async () => (finalized ? [] : [verdict]),
      claimVerdict: async () => true,
      releaseVerdictClaim,
      recordOutcome,
      getRunById: async (): Promise<OverseerWatchRun | null> => null,
      reserveMergeSlot: async () => true,
      releaseMergeSlot,
      getEarliestMergeSlotReservation: async () => null,
    },
    github: {
      findPullRequest: async () => pr,
      mergePullRequest,
      commentAuthorLogin: 'thinman-overseer',
      listPullRequestComments: async () => comments,
      commentOnPullRequest,
      addPullRequestLabels,
    },
    readRunEvents,
    findOriginatingRun,
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
    comments,
    mergePullRequest,
    releaseMergeSlot,
    releaseVerdictClaim,
    recordOutcome,
    addPullRequestLabels,
    findOriginatingRun,
  };
}

describe('merge bridge: run-less verdict traced to its originating run', () => {
  test('Test 5: failed-evidence run behind a pr-discovery verdict is skipped, slot released, nothing merged', async () => {
    const f = bridgeFixture({ originating: { runId: RUN_ID, status: 'failed' } });
    await runMergeExecutionBridgeOnce(f.options);
    expect(f.mergePullRequest).not.toHaveBeenCalled();
    expect(f.releaseMergeSlot).toHaveBeenCalledWith('verdict-runless');
    expect(f.releaseVerdictClaim).toHaveBeenCalledWith(
      'verdict-runless',
      'originating_run_failed_evidence_gate'
    );
    expect(f.recordOutcome).not.toHaveBeenCalled();
    expect(f.comments[0]?.body.split('\n')).toContain(
      `Merge held: originating run ${RUN_ID} failed manifest-evidence-check`
    );
    expect(f.addPullRequestLabels).toHaveBeenCalledTimes(1);
  });

  test('Test 6 (bridge): no originating run proceeds to merge as before', async () => {
    const f = bridgeFixture({ originating: null });
    await runMergeExecutionBridgeOnce(f.options);
    expect(f.mergePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ expectedHeadSha: HEAD, mergeMethod: 'squash' })
    );
    expect(f.addPullRequestLabels).not.toHaveBeenCalled();
  });

  test('Test 7 (bridge): a rejecting lookup holds as originating_run_unreadable', async () => {
    const f = bridgeFixture({ originating: 'throw' });
    await runMergeExecutionBridgeOnce(f.options);
    expect(f.mergePullRequest).not.toHaveBeenCalled();
    expect(f.releaseVerdictClaim).toHaveBeenCalledWith(
      'verdict-runless',
      'originating_run_unreadable'
    );
  });

  test('Test 8 (bridge): a run still running holds as originating_run_in_progress with no label', async () => {
    const f = bridgeFixture({ originating: { runId: RUN_ID, status: 'running' } });
    await runMergeExecutionBridgeOnce(f.options);
    expect(f.mergePullRequest).not.toHaveBeenCalled();
    expect(f.releaseVerdictClaim).toHaveBeenCalledWith(
      'verdict-runless',
      'originating_run_in_progress'
    );
    expect(f.addPullRequestLabels).not.toHaveBeenCalled();
    expect(f.comments[0]?.body.split('\n')).toContain(
      `Merge held: originating run ${RUN_ID} has not finished`
    );
  });
});
