/**
 * WO-HARNESS-MERGE-GATES-01, Tests 2, 5 and 8 (manager half).
 * Test 2: manager_precondition_refuses_a_merge_hold_pr.
 * Test 5: failed_originating_run_at_any_node_holds_and_adjudication_clears.
 * Test 8: clean_and_human_prs_still_merge.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { QualifiedMergeEvidence } from './actions/merge-ready.ts';
import { createMergeManager, type MergeManagerDeps } from './merge-manager.ts';
import type { OriginatingRun } from './originating-run-lookup.ts';
import type { OverseerWorkflowEvent, WatchedRunRecord } from './types.ts';

const HEAD = 'a'.repeat(40);
const RUN_ID = 'run-holds';
const oldAdjudicators = process.env.MERGE_MANAGER_EVIDENCE_ADJUDICATORS;
afterEach(() => {
  if (oldAdjudicators === undefined) delete process.env.MERGE_MANAGER_EVIDENCE_ADJUDICATORS;
  else process.env.MERGE_MANAGER_EVIDENCE_ADJUDICATORS = oldAdjudicators;
});

function nodeEvent(type: string, step: string): OverseerWorkflowEvent {
  return {
    id: `event-${step}`,
    workflow_run_id: RUN_ID,
    event_type: type,
    step_name: step,
    data: { error: `${step} failed` },
  } as unknown as OverseerWorkflowEvent;
}

interface FixtureOptions {
  status?: string;
  labels?: string[];
  title?: string;
  draft?: boolean;
  events?: OverseerWorkflowEvent[];
  runless?: boolean;
  deps?: Partial<MergeManagerDeps>;
}

function fixture(options: FixtureOptions = {}) {
  const record: WatchedRunRecord = {
    runId: options.runless ? 'pr-discovery:thinmansoftware/bdc-harness#42' : RUN_ID,
    woId: options.runless ? 'gh:thinmansoftware/bdc-harness#42' : 'WO-HOLDS',
    owner: 'thinmansoftware',
    repo: 'bdc-harness',
    status: options.status ?? 'completed',
    action: 'merge_ready',
    reason: 'green PR',
    ...(options.runless
      ? { metadata: { discovery_source: 'pr_first_sweep', head_sha: HEAD } }
      : {}),
    workingPath: options.runless ? undefined : `/worktree/${RUN_ID}`,
    prEvidence: {
      exists: true,
      state: 'open',
      checks: { total: 1, passed: 1, failed: 0, pending: 0 },
      mergeable: true,
      headSha: HEAD,
      pr: { owner: 'thinmansoftware', repo: 'bdc-harness', number: 42, author: 'builder-login' },
      prTitle: options.title ?? 'Ordinary change',
      labels: options.labels ?? [],
      ...(options.draft === undefined ? {} : { draft: options.draft }),
    },
  } as WatchedRunRecord;
  const comments: { body: string; authorLogin: string }[] = [];
  const mergePullRequest = mock(async () => ({ merged: true, sha: 'c'.repeat(40) }));
  const insertOverseerAction = mock(
    async (_input: { action: string; result: string }) => undefined
  );
  const manager = createMergeManager({
    mode: 'execute',
    mutationsEnabled: true,
    allowedBases: ['dev'],
    reviewGateLogin: 'review-gate',
    commentAuthorLogin: 'thinman-overseer',
    readWorktreeHeadSha: async () => HEAD,
    readRunEvents: async () => options.events ?? [],
    ...(options.runless
      ? { findOriginatingRun: async (): Promise<OriginatingRun | null> => null }
      : {}),
    listPullRequestReviews: async () => [
      { login: 'review-gate', state: 'APPROVED', commitId: HEAD },
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
        head_sha: HEAD,
        base_sha: 'e'.repeat(40),
        required_checks: [{ name: 'ci', conclusion: 'success', head_sha: HEAD }],
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
    commentOnPullRequest: async ({ body }: { body: string }) => {
      comments.push({ body, authorLogin: 'thinman-overseer' });
      return { commented: true };
    },
    addPullRequestLabels: async () => undefined,
    ...options.deps,
  });
  return { manager, record, comments, mergePullRequest, insertOverseerAction };
}

const missRecorded = (f: ReturnType<typeof fixture>, reason: string): boolean =>
  f.insertOverseerAction.mock.calls.some(call => {
    const row = call[0] as { action: string; result: string };
    return (
      row.action === 'merge_denied' && row.result.includes(`"precondition_miss_reason":"${reason}"`)
    );
  });

describe('Test 2: manager_precondition_refuses_a_merge_hold_pr', () => {
  test('merge-hold holds with merge_hold_label and the merge function is never called', async () => {
    const f = fixture({ labels: ['merge-hold'] });
    const result = await f.manager(f.record);
    expect(result).toMatchObject({ status: 'held', reason: 'merge_hold_label' });
    expect(f.mergePullRequest).not.toHaveBeenCalled();
    expect(missRecorded(f, 'merge_hold_label')).toBe(true);
  });

  test('a differently spelled merge-hold also holds', async () => {
    const f = fixture({ labels: ['Merge-Hold'] });
    expect(await f.manager(f.record)).toMatchObject({ status: 'held', reason: 'merge_hold_label' });
    expect(f.mergePullRequest).not.toHaveBeenCalled();
  });

  test('run:blocked, owner:reworking, a draft and a FALLBACK title each hold with their own reason', async () => {
    const cases: [FixtureOptions, string][] = [
      [{ labels: ['run:blocked'] }, 'run_blocked_label'],
      [{ labels: ['owner:reworking'] }, 'owner_reworking_label'],
      [{ labels: [], draft: true }, 'pr_is_draft'],
      [{ title: 'FALLBACK: opus-repaired build needs human review' }, 'fallback_pr_title'],
    ];
    for (const [options, reason] of cases) {
      const f = fixture(options);
      expect(await f.manager(f.record)).toMatchObject({ status: 'held', reason });
      expect(f.mergePullRequest).not.toHaveBeenCalled();
    }
  });

  test('with no label the same PR merges once', async () => {
    const f = fixture({ labels: [] });
    expect((await f.manager(f.record)).status).toBe('executed');
    expect(f.mergePullRequest).toHaveBeenCalledTimes(1);
  });
});

describe('Test 5: failed_originating_run_at_any_node_holds_and_adjudication_clears', () => {
  test('failed at manifest-evidence-check keeps the evidence reason', async () => {
    const f = fixture({
      status: 'failed',
      events: [nodeEvent('node_failed', 'manifest-evidence-check')],
    });
    expect(await f.manager(f.record)).toMatchObject({
      status: 'held',
      reason: 'originating_run_failed_evidence_gate',
    });
    expect(f.mergePullRequest).not.toHaveBeenCalled();
  });

  test('failed at ANY other node holds with originating_run_failed and posts one comment', async () => {
    const f = fixture({ status: 'failed', events: [nodeEvent('node_failed', 'test-repair')] });
    const first = await f.manager(f.record);
    expect(first).toMatchObject({ status: 'held', reason: 'originating_run_failed' });
    await f.manager(f.record);
    expect(f.mergePullRequest).not.toHaveBeenCalled();
    expect(f.comments).toHaveLength(1);
    expect(f.comments[0]?.body.split('\n')).toContain(
      `Merge held: originating run ${RUN_ID} failed`
    );
    expect(f.comments[0]?.body).toContain('reason=originating_run_failed');
    expect(
      f.insertOverseerAction.mock.calls.some(call => {
        const row = call[0] as { action: string; result: string };
        return row.action === 'merge_denied' && row.result === 'originating_run_failed';
      })
    ).toBe(true);
  });

  test('a failed run with no failed-node event is still held (status failed is enough)', async () => {
    const f = fixture({ status: 'failed', events: [] });
    expect(await f.manager(f.record)).toMatchObject({
      status: 'held',
      reason: 'originating_run_failed',
    });
  });

  test('an allowlisted adjudicator naming the current full head sha lifts the hold', async () => {
    process.env.MERGE_MANAGER_EVIDENCE_ADJUDICATORS = 'human-adjudicator';
    const f = fixture({ status: 'failed', events: [nodeEvent('node_failed', 'test-repair')] });
    f.comments.push({
      authorLogin: 'human-adjudicator',
      body: `Evidence-Adjudication: reviewed the failed test-repair node, head ${HEAD}`,
    });
    const result = await f.manager(f.record);
    expect(result.status).toBe('executed');
    expect(f.mergePullRequest).toHaveBeenCalledTimes(1);
  });

  test('an adjudication comment for an OLD head does not lift it', async () => {
    process.env.MERGE_MANAGER_EVIDENCE_ADJUDICATORS = 'human-adjudicator';
    const f = fixture({ status: 'failed', events: [nodeEvent('node_failed', 'test-repair')] });
    f.comments.push({
      authorLogin: 'human-adjudicator',
      body: `Evidence-Adjudication: reviewed head ${'f'.repeat(40)}`,
    });
    expect(await f.manager(f.record)).toMatchObject({
      status: 'held',
      reason: 'originating_run_failed',
    });
  });

  test('a passed run is not held, and an unreadable run still fails closed', async () => {
    const passed = fixture({
      status: 'completed',
      events: [nodeEvent('node_completed', 'implement')],
    });
    expect((await passed.manager(passed.record)).status).toBe('executed');
    const unreadable = fixture({
      status: 'failed',
      deps: {
        readRunEvents: async () => {
          throw new Error('event store down');
        },
      },
    });
    expect(await unreadable.manager(unreadable.record)).toMatchObject({
      status: 'held',
      reason: 'originating_run_unreadable',
    });
  });
});

describe('Test 8: clean_and_human_prs_still_merge (manager half)', () => {
  test('a clean run-backed PR of a passed run merges once, with no merge_denied row', async () => {
    const f = fixture({ status: 'completed', events: [nodeEvent('node_completed', 'implement')] });
    expect((await f.manager(f.record)).status).toBe('executed');
    expect(f.mergePullRequest).toHaveBeenCalledTimes(1);
    expect(
      f.insertOverseerAction.mock.calls.some(
        call => (call[0] as { action: string }).action === 'merge_denied'
      )
    ).toBe(false);
  });

  test('a run-less human PR with a normal title and no traceable run proceeds on green', async () => {
    const f = fixture({ runless: true, status: 'pr_discovered' });
    expect((await f.manager(f.record)).status).toBe('executed');
    expect(f.mergePullRequest).toHaveBeenCalledTimes(1);
  });

  test('a run-less PR with a FALLBACK title and no traceable run is held by the title rule', async () => {
    const f = fixture({
      runless: true,
      status: 'pr_discovered',
      title: 'FALLBACK: opus-repaired build needs human review',
    });
    expect(await f.manager(f.record)).toMatchObject({
      status: 'held',
      reason: 'fallback_pr_title',
    });
    expect(f.mergePullRequest).not.toHaveBeenCalled();
  });
});
