/**
 * WO-HARNESS-MERGE-GATES-01, Tests 6, 8 (coordinator half) and 10.
 * Test 6: coordinator_never_approves_or_merges_a_held_pr.
 * Test 8: clean_and_human_prs_still_merge.
 * Test 10: draft_refusal_is_never_final_and_a_ready_pr_merges_on_the_next_tick.
 */
import { describe, expect, test } from 'bun:test';
import type { OverseerVerdictRow, OverseerWatchRun } from '@archon/core/db/overseer';
import {
  runMergeExecutionBridgeOnce as runMergeExecutionBridgeOnceProduction,
  type MergeExecutionBridgeOptions,
  type MergeExecutionBridgeStore,
} from './merge-execution-bridge.ts';
import { classifyMergeSkip } from './merge-skip-classification.ts';
import type { GitHubClientDeps, PullRequestEvidence } from './types.ts';

const HEAD = 'judged-sha';

const runCoordinator = (options: MergeExecutionBridgeOptions): Promise<void> =>
  runMergeExecutionBridgeOnceProduction({
    readRunEvents: async () => [],
    hasQualifiedReview: async () => true,
    reviewConflictAtHead: async () => null,
    ...options,
  });

const policy = {
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
} as const;

const verdict = (id: string, runless = false): OverseerVerdictRow =>
  ({
    id,
    run_id: runless ? `pr-discovery:thinmansoftware/bdc-harness#${id}` : `run-${id}`,
    wo_id: runless ? `gh:thinmansoftware/bdc-harness#${id}` : 'WO-TEST',
    head_sha: HEAD,
    proposed_action: 'flag_merge_ready',
    merge_attempts: 0,
  }) as unknown as OverseerVerdictRow;

function evidence(overrides: Partial<PullRequestEvidence> = {}): PullRequestEvidence {
  return {
    exists: true,
    state: 'open',
    checks: { total: 2, passed: 2, failed: 0, pending: 0 },
    mergeable: true,
    mergeableState: 'clean',
    changedFilePaths: ['packages/overseer/src/code.ts'],
    baseBranch: 'dev',
    headSha: HEAD,
    htmlUrl: 'https://github.test/pr/1',
    pr: { owner: 'thinmansoftware', repo: 'bdc-harness', number: 1 },
    prTitle: 'Ordinary change',
    labels: [],
    draft: false,
    ...overrides,
  };
}

/** A discovered PR's evidence must carry the PR number its verdict is keyed on. */
const prRef = (number: number, runless: boolean) => ({
  owner: 'thinmansoftware',
  repo: 'bdc-harness',
  number: runless ? number : 1,
});

interface HarnessOptions {
  rows: OverseerVerdictRow[];
  /** Evidence served on each findPullRequest call, in order; the last one repeats. */
  evidenceSequence: PullRequestEvidence[];
  /** What mergePullRequest answers, in order; the last one repeats. */
  mergeAnswers?: { merged: boolean; message?: string; mergeSha?: string }[];
}

function harness(options: HarnessOptions) {
  const pending = [...options.rows];
  const processing = new Set<string>();
  const claimReleases: { verdictId: string; reason: string }[] = [];
  const deferrals: { verdictId: string; reason: string }[] = [];
  const outcomes: { verdictId: string; mutationSent: boolean; reason: string }[] = [];
  let approvals = 0;
  let merges = 0;
  let evidenceCalls = 0;
  let occupied = 0;
  const slots = new Map<string, { released: boolean }>();
  const store: MergeExecutionBridgeStore = {
    listUnactionedVerdicts: async () => [...pending],
    claimVerdict: async id => {
      if (!pending.some(row => row.id === id)) return false;
      processing.add(id);
      return true;
    },
    releaseVerdictClaim: async (id, reason) => {
      if (!processing.has(id)) return false;
      processing.delete(id);
      claimReleases.push({ verdictId: id, reason });
      return true;
    },
    deferVerdictClaim: async (id, reason) => {
      if (!processing.has(id)) return false;
      processing.delete(id);
      deferrals.push({ verdictId: id, reason });
      return true;
    },
    getRunById: async runId =>
      ({
        id: runId,
        woId: 'WO-TEST',
        owner: 'thinmansoftware',
        repo: 'bdc-harness',
        status: 'completed',
        headBranch: `branch-${runId}`,
        metadata: {},
      }) as OverseerWatchRun,
    getEarliestMergeSlotReservation: async () =>
      new Date(Date.now() - 50 * 60 * 1000).toISOString(),
    reserveMergeSlot: async (id, _since, limit) => {
      const existing = slots.get(id);
      if (existing && !existing.released) return false;
      if (occupied >= limit) return false;
      occupied += 1;
      slots.set(id, { released: false });
      return true;
    },
    releaseMergeSlot: async id => {
      const existing = slots.get(id);
      if (!existing || existing.released) return;
      existing.released = true;
      occupied -= 1;
    },
    recordOutcome: async input => {
      outcomes.push(input);
      processing.delete(input.verdictId);
      const index = pending.findIndex(row => row.id === input.verdictId);
      if (index >= 0) pending.splice(index, 1);
    },
  };
  const answers = options.mergeAnswers ?? [{ merged: true, mergeSha: 'merge-sha' }];
  const github: GitHubClientDeps = {
    findPullRequest: async () => {
      const index = Math.min(evidenceCalls, options.evidenceSequence.length - 1);
      evidenceCalls += 1;
      return options.evidenceSequence[index] as PullRequestEvidence;
    },
    approvePullRequest: async () => {
      approvals += 1;
      return { approved: true };
    },
    mergePullRequest: async () => {
      const answer = answers[Math.min(merges, answers.length - 1)] as {
        merged: boolean;
        message?: string;
        mergeSha?: string;
      };
      merges += 1;
      return answer;
    },
    listPullRequestComments: async () => [],
    commentOnPullRequest: async () => ({ commented: true }),
  };
  const tick = (): Promise<void> => runCoordinator({ store, github, readPolicy: () => policy });
  return {
    tick,
    claimReleases,
    deferrals,
    outcomes,
    pending,
    get approvals() {
      return approvals;
    },
    get merges() {
      return merges;
    },
  };
}

describe('Test 6: coordinator_never_approves_or_merges_a_held_pr', () => {
  const held: [string, Partial<PullRequestEvidence>, string][] = [
    ['a draft', { draft: true }, 'pr_is_draft'],
    ['merge-hold', { labels: ['merge-hold'] }, 'merge_hold_label'],
    ['a differently spelled merge-hold', { labels: ['Merge-Hold'] }, 'merge_hold_label'],
    [
      'a FALLBACK title',
      { prTitle: 'FALLBACK: opus-repaired build needs human review' },
      'fallback_pr_title',
    ],
    ['run:blocked', { labels: ['run:blocked'] }, 'run_blocked_label'],
    ['owner:reworking', { labels: ['owner:reworking'] }, 'owner_reworking_label'],
  ];

  for (const [name, overrides, reason] of held) {
    for (const runless of [false, true]) {
      test(`${name}${runless ? ' (discovered PR)' : ' (run-backed)'}: no approval, no merge, claim released as ${reason}`, async () => {
        const h = harness({
          rows: [verdict('7', runless)],
          evidenceSequence: [evidence({ ...overrides, pr: prRef(7, runless) })],
        });
        await h.tick();
        expect(h.approvals).toBe(0);
        expect(h.merges).toBe(0);
        expect(h.outcomes).toEqual([]);
        expect(h.deferrals).toEqual([]);
        expect(h.claimReleases).toEqual([{ verdictId: '7', reason }]);
        // The verdict stays unactioned, so lifting the hold needs no requeue.
        expect(h.pending.map(row => row.id)).toEqual(['7']);
      });
    }
  }

  test('a clean PR runs the existing approve-then-merge sequence unchanged (Test 8, coordinator half)', async () => {
    for (const runless of [false, true]) {
      const h = harness({
        rows: [verdict('8', runless)],
        evidenceSequence: [evidence({ pr: prRef(8, runless) })],
      });
      await h.tick();
      expect(h.approvals).toBe(1);
      expect(h.merges).toBe(1);
      expect(h.claimReleases).toEqual([]);
      expect(h.outcomes.map(o => o.reason)).toEqual(['merge_executed']);
    }
  });
});

describe('Test 10: draft_refusal_is_never_final_and_a_ready_pr_merges_on_the_next_tick', () => {
  const draft405 =
    'Pull Request is still a draft - https://docs.github.com/rest/pulls/pulls#merge-a-pull-request';

  test('first line of defence: a draft is released before any merge call, and merges after it is marked ready', async () => {
    const h = harness({
      rows: [verdict('10')],
      evidenceSequence: [evidence({ draft: true }), evidence({ draft: false })],
      mergeAnswers: [{ merged: true, mergeSha: 'merge-sha' }],
    });
    await h.tick();
    // After tick 1 (draft): nothing finalized, nothing attempted, nothing approved.
    expect(h.outcomes).toEqual([]);
    expect(h.merges).toBe(0);
    expect(h.approvals).toBe(0);
    expect(h.pending.map(row => row.id)).toEqual(['10']);
    expect(h.claimReleases).toEqual([{ verdictId: '10', reason: 'pr_is_draft' }]);
    // Tick 2 (ready, same head, no requeue): exactly one merge, finalized as merge_executed.
    await h.tick();
    expect(h.merges).toBe(1);
    expect(h.outcomes.map(o => o.reason)).toEqual(['merge_executed']);
  });

  test('second line of defence: with the coordinator draft check unable to see the draft, the 405 text is deferred, never finalized', async () => {
    // The evidence omits the draft field (so the first line cannot fire); the merge function answers with
    // GitHub's 405 text, exactly as it did live on 2026-11-13.
    const unseen = evidence();
    delete (unseen as { draft?: boolean }).draft;
    const h = harness({
      rows: [verdict('11')],
      evidenceSequence: [unseen],
      mergeAnswers: [
        { merged: false, message: draft405 },
        { merged: true, mergeSha: 'merge-sha' },
      ],
    });
    await h.tick();
    expect(h.outcomes).toEqual([]);
    expect(h.deferrals).toEqual([{ verdictId: '11', reason: draft405 }]);
    expect(h.pending.map(row => row.id)).toEqual(['11']);
    // The PR is marked ready; the next tick merges it with no manual requeue.
    await h.tick();
    expect(h.merges).toBe(2);
    expect(h.outcomes.map(o => o.reason)).toEqual(['merge_executed']);
  });

  test('both texts are classified transient', () => {
    expect(classifyMergeSkip(draft405)).toBe('transient');
    expect(classifyMergeSkip(`merge_failed:${draft405}`)).toBe('transient');
  });
});
