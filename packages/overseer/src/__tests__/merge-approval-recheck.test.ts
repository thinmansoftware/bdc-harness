import { describe, expect, test } from 'bun:test';
import { SqliteAdapter } from '@archon/core/db/adapters/sqlite';
import {
  claimVerdictForMergeExecution,
  deferVerdictClaimForMergeExecution,
  getEarliestOverseerMergeSlotReservation,
  getOverseerWatchRunById,
  listUnactionedFlagMergeReadyVerdicts,
  recordVerdictMergeOutcome,
  releaseOverseerMergeSlot,
  releaseVerdictClaimForMergeExecution,
  reserveOverseerMergeSlot,
} from '@archon/core/db/overseer';
import {
  createRealSubmitDeps,
  maybeRecordReviewApprovalVerdict,
  recordReviewApprovalVerdict,
} from '../pr-review-wiring';
import type { RealGitHubOctokitLike } from '../adapters/github-real-deps';
import { runMergeExecutionBridgeOnce } from '../merge-execution-bridge';
import { runWithBoundDatabase } from './isolated-database';

const HEAD = 'a'.repeat(40);
const approval = {
  disposition: 'approved',
  owner: 'thinmansoftware',
  repo: 'bdc-harness',
  prNumber: 42,
  headSha: HEAD,
  githubReview: {
    id: 123,
    state: 'APPROVED',
    commitSha: HEAD,
    url: 'https://github.test/review/123',
  },
};
const enabled = { OVERSEER_MERGE_RECHECK_ON_APPROVAL: 'true' };

describe('approval-triggered merge recheck', () => {
  test('a live exact-head approval uses the GitHub review id for a new evaluation', async () => {
    const recorded: Parameters<typeof recordReviewApprovalVerdict>[0][] = [];
    await maybeRecordReviewApprovalVerdict(approval, {
      env: enabled,
      currentHeadSha: async input => {
        expect(input).toMatchObject({ owner: approval.owner, repo: approval.repo, prNumber: 42 });
        return HEAD;
      },
      record: async input => {
        recorded.push(input);
      },
    });
    expect(recorded).toEqual([expect.objectContaining({ headSha: HEAD, approvalReviewId: 123 })]);
  });

  test.each([undefined, 'false', '1'])(
    'flag %s preserves the existing per-head handoff',
    async flag => {
      let reads = 0;
      const recorded: Parameters<typeof recordReviewApprovalVerdict>[0][] = [];
      await maybeRecordReviewApprovalVerdict(approval, {
        env: { OVERSEER_MERGE_RECHECK_ON_APPROVAL: flag },
        currentHeadSha: async () => {
          reads++;
          return HEAD;
        },
        record: async input => {
          recorded.push(input);
        },
      });
      expect(reads).toBe(0);
      expect(recorded).toEqual([approval]);
    }
  );

  test.each([
    ['stale live head', approval, async () => 'b'.repeat(40)],
    [
      'unavailable live head',
      approval,
      async () => {
        throw new Error('lookup failed');
      },
    ],
    ['missing live head reader', approval, undefined],
    [
      'stale review response',
      { ...approval, githubReview: { ...approval.githubReview, commitSha: 'b'.repeat(40) } },
      async () => HEAD,
    ],
    [
      'non-approval response',
      { ...approval, githubReview: { ...approval.githubReview, state: 'COMMENTED' } },
      async () => HEAD,
    ],
    ['missing response', { ...approval, githubReview: undefined }, async () => HEAD],
    [
      'invalid review id',
      { ...approval, githubReview: { ...approval.githubReview, id: 0 } },
      async () => HEAD,
    ],
    ['changes requested', { ...approval, disposition: 'changes_requested' }, async () => HEAD],
  ])('%s queues no merge evaluation', async (_name, input, currentHeadSha) => {
    let recorded = 0;
    await maybeRecordReviewApprovalVerdict(input, {
      env: enabled,
      currentHeadSha,
      record: async () => {
        recorded++;
      },
    });
    expect(recorded).toBe(0);
  });

  test('the existing verdict kill switch still blocks approval rechecks', async () => {
    let recorded = 0;
    await maybeRecordReviewApprovalVerdict(approval, {
      env: { ...enabled, OVERSEER_REVIEW_RECORDS_VERDICT: 'false' },
      currentHeadSha: async () => HEAD,
      record: async () => {
        recorded++;
      },
    });
    expect(recorded).toBe(0);
  });

  test('receipt wiring records the approval before queuing a review-scoped recheck', async () => {
    const previous = process.env.OVERSEER_MERGE_RECHECK_ON_APPROVAL;
    process.env.OVERSEER_MERGE_RECHECK_ON_APPROVAL = 'true';
    const order: string[] = [];
    try {
      const deps = createRealSubmitDeps('thinman-overseer[bot]', {
        octokit: {
          pulls: {
            get: async () => {
              order.push('head');
              return { data: { head: { sha: HEAD } } };
            },
          },
        } as unknown as RealGitHubOctokitLike,
        patOctokit: null,
        createReceiptMessage: async () => {
          order.push('receipt');
          return {} as never;
        },
        recordApprovalVerdict: async input => {
          expect(input.approvalReviewId).toBe(123);
          order.push('recheck');
        },
      });
      await deps.recordReceipt({ ...approval, correlationId: 'c', messageId: 'm' });
      expect(order).toEqual(['receipt', 'head', 'recheck']);
    } finally {
      if (previous === undefined) delete process.env.OVERSEER_MERGE_RECHECK_ON_APPROVAL;
      else process.env.OVERSEER_MERGE_RECHECK_ON_APPROVAL = previous;
    }
  });

  test('a failed durable approval receipt queues no recheck', async () => {
    let recorded = 0;
    const deps = createRealSubmitDeps('thinman-overseer[bot]', {
      octokit: {} as RealGitHubOctokitLike,
      patOctokit: null,
      createReceiptMessage: async () => {
        throw new Error('receipt unavailable');
      },
      recordApprovalVerdict: async () => {
        recorded++;
      },
    });
    await expect(
      deps.recordReceipt({
        ...approval,
        correlationId: 'c',
        messageId: 'm',
      })
    ).rejects.toThrow('receipt unavailable');
    expect(recorded).toBe(0);
  });

  test('a consumed head gets one bridge evaluation per approval id, including concurrent duplicates', async () => {
    const db = new SqliteAdapter(':memory:');
    try {
      await runWithBoundDatabase(db, async () => {
        await recordReviewApprovalVerdict(approval);
        const [prior] = await listUnactionedFlagMergeReadyVerdicts();
        if (!prior) throw new Error('missing prior verdict');
        expect(await claimVerdictForMergeExecution(prior.id)).toBe(true);
        await recordVerdictMergeOutcome({
          verdictId: prior.id,
          mutationSent: false,
          reason: 'review_execution_unqualified',
        });
        await maybeRecordReviewApprovalVerdict(approval, { env: {} });
        expect(await listUnactionedFlagMergeReadyVerdicts()).toHaveLength(0);
        const deliver = (id = 123) =>
          maybeRecordReviewApprovalVerdict(
            { ...approval, githubReview: { ...approval.githubReview, id } },
            { env: enabled, currentHeadSha: async () => HEAD }
          );
        await Promise.all([deliver(), deliver()]);
        const pending = await listUnactionedFlagMergeReadyVerdicts();
        expect(pending).toHaveLength(1);
        expect(pending[0]?.id).not.toBe(prior.id);
        expect(pending[0]?.head_sha).toBe(HEAD);
        let evaluations = 0;
        let merges = 0;
        const runBridge = () =>
          runMergeExecutionBridgeOnce({
            store: {
              listUnactionedVerdicts: listUnactionedFlagMergeReadyVerdicts,
              claimVerdict: claimVerdictForMergeExecution,
              releaseVerdictClaim: releaseVerdictClaimForMergeExecution,
              deferVerdictClaim: deferVerdictClaimForMergeExecution,
              getRunById: getOverseerWatchRunById,
              reserveMergeSlot: reserveOverseerMergeSlot,
              getEarliestMergeSlotReservation: getEarliestOverseerMergeSlotReservation,
              releaseMergeSlot: releaseOverseerMergeSlot,
              recordOutcome: recordVerdictMergeOutcome,
            },
            github: {
              findPullRequest: async input => {
                evaluations++;
                expect(input.prNumber).toBe(42);
                return {
                  exists: true,
                  state: 'open',
                  headSha: HEAD,
                  baseBranch: 'dev',
                  mergeable: true,
                  mergeableState: 'clean',
                  changedFilePaths: ['packages/overseer/src/code.ts'],
                  checks: { total: 1, passed: 1, failed: 0, pending: 0 },
                  pr: { owner: approval.owner, repo: approval.repo, number: 42 },
                };
              },
              mergePullRequest: async input => {
                expect(input.expectedHeadSha).toBe(HEAD);
                merges++;
                return { merged: true, mergeSha: 'merge-sha' };
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
            hasQualifiedReview: async () => true,
            reviewConflictAtHead: async () => null,
          });
        await runBridge();
        await deliver();
        await runBridge();
        expect(evaluations).toBe(1);
        expect(merges).toBe(1);
        expect(await listUnactionedFlagMergeReadyVerdicts()).toHaveLength(0);
        const priorOutcome = await db.query<{ action_reason: string }>(
          'SELECT action_reason FROM overseer_verdicts WHERE id = $1',
          [prior.id]
        );
        expect(priorOutcome.rows[0]?.action_reason).toBe('review_execution_unqualified');
        // A distinct approval review is a distinct authorized evaluation.
        await deliver(124);
        expect(await listUnactionedFlagMergeReadyVerdicts()).toHaveLength(1);
      });
    } finally {
      await db.close();
    }
  });
});
