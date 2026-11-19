import { beforeEach, describe, expect, test } from 'bun:test';
import type { OverseerVerdictRow, OverseerWatchRun } from '@archon/core/db/overseer';
import {
  QUEUE_NOTE_MAX_PER_SWEEP,
  QUEUE_NOTE_RECHECK_MS,
  resetMergeQueueNotesForTests,
  runMergeExecutionBridgeOnce as runBridge,
  type MergeExecutionBridgeOptions,
  type MergeExecutionBridgeStore,
} from '../merge-execution-bridge';
import type { GitHubClientDeps, PullRequestEvidence } from '../types.ts';

// WO-HARNESS-MERGE-QUEUE-NOTE-ALL-QUEUED-01 (bdc-xo#5697): on a full ceiling every queued pull request,
// not only the head, gets the merge-queued label and one position comment; nothing but the head is claimed.

const MARKER = '<!-- overseer:merge-ceiling-queued -->';
const NOW = new Date('2026-11-12T20:00:00.000Z');

const run = (options: MergeExecutionBridgeOptions): Promise<void> =>
  runBridge({
    readRunEvents: async () => [],
    hasQualifiedReview: async () => true,
    reviewConflictAtHead: async () => null,
    ...options,
  });

const policy = () =>
  ({
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
  }) as const;

interface Queue {
  store: MergeExecutionBridgeStore;
  github: GitHubClientDeps;
  claims: string[];
  reserves: string[];
  releases: { verdictId: string; reason: string }[];
  comments: Map<number, string[]>;
  labelAdds: number[];
  labels: Map<number, string[]>;
  reads: Map<number, number>;
  merges: number[];
  evidence: Map<number, Partial<PullRequestEvidence>>;
  sweep: (at?: Date) => Promise<void>;
}

// Verdict i has head `head-i`, run branch `branch-i` and pull request number 100 + i.
function queue(count: number, ceilingUsed = 2, ceiling = 2): Queue {
  const rows: OverseerVerdictRow[] = Array.from({ length: count }, (_unused, index) => {
    const id = `v${String(index + 1)}`;
    return {
      id,
      run_id: `run-${id}`,
      wo_id: 'WO-TEST',
      head_sha: `head-${id}`,
      proposed_action: 'flag_merge_ready',
    } as OverseerVerdictRow;
  });
  const claims: string[] = [];
  const reserves: string[] = [];
  const releases: { verdictId: string; reason: string }[] = [];
  const comments = new Map<number, string[]>();
  const labels = new Map<number, string[]>();
  const labelAdds: number[] = [];
  const reads = new Map<number, number>();
  const merges: number[] = [];
  const evidence = new Map<number, Partial<PullRequestEvidence>>();
  const processing = new Set<string>();
  const store: MergeExecutionBridgeStore = {
    listUnactionedVerdicts: async () => [...rows],
    claimVerdict: async id => {
      claims.push(id);
      processing.add(id);
      return true;
    },
    releaseVerdictClaim: async (id, reason) => {
      if (!processing.delete(id)) return false;
      releases.push({ verdictId: id, reason });
      return true;
    },
    getRunById: async runId =>
      ({
        id: runId,
        woId: 'WO-TEST',
        owner: 'thinmansoftware',
        repo: 'bdc-harness',
        status: 'completed',
        headBranch: `branch-${runId.replace('run-v', '')}`,
        metadata: {},
      }) as OverseerWatchRun,
    getEarliestMergeSlotReservation: async () =>
      new Date(NOW.getTime() - 50 * 60 * 1000).toISOString(),
    reserveMergeSlot: async id => {
      reserves.push(id);
      return ceilingUsed < ceiling;
    },
    releaseMergeSlot: async () => undefined,
    recordOutcome: async () => undefined,
  };
  const github: GitHubClientDeps = {
    findPullRequest: async input => {
      const index = Number(String(input.headBranch).replace('branch-', ''));
      const number = 100 + index;
      reads.set(number, (reads.get(number) ?? 0) + 1);
      return {
        exists: true,
        state: 'open',
        checks: { total: 2, passed: 2, failed: 0, pending: 0 },
        mergeable: true,
        mergeableState: 'clean',
        changedFilePaths: ['packages/overseer/src/code.ts'],
        baseBranch: 'dev',
        headSha: `head-v${String(index)}`,
        htmlUrl: `https://github.test/pr/${String(number)}`,
        pr: { owner: 'thinmansoftware', repo: 'bdc-harness', number },
        labels: labels.get(number) ?? [],
        ...(evidence.get(number) ?? {}),
      } as PullRequestEvidence;
    },
    approvePullRequest: async () => ({ approved: true }),
    mergePullRequest: async input => {
      merges.push(input.number);
      return { merged: true, mergeSha: 'merge-sha' };
    },
    listPullRequestComments: async ref =>
      (comments.get(ref.number) ?? []).map(body => ({ body, authorLogin: 'bot' })),
    commentOnPullRequest: async input => {
      comments.set(input.number, [...(comments.get(input.number) ?? []), input.body]);
      return { commented: true };
    },
    addPullRequestLabels: async input => {
      labelAdds.push(input.number);
      labels.set(input.number, [...(labels.get(input.number) ?? []), ...input.labels]);
    },
  };
  return {
    store,
    github,
    claims,
    reserves,
    releases,
    comments,
    labelAdds,
    labels,
    reads,
    merges,
    evidence,
    sweep: (at = NOW) =>
      run({
        store,
        github,
        now: () => at,
        maxMergesPerHour: ceiling,
        readPolicy: () => policy(),
      }),
  };
}

// Verdicts are noted once per process, so every test starts from an empty memo.
beforeEach(() => {
  resetMergeQueueNotesForTests();
});

describe('merge queue notes: every queued pull request is labelled and commented', () => {
  test('Test 1: the head and the two behind it each get one comment and the label; only the head is claimed', async () => {
    const q = queue(3);
    await q.sweep();

    for (const number of [101, 102, 103]) {
      const posted = q.comments.get(number) ?? [];
      expect(posted, `PR ${String(number)} comments`).toHaveLength(1);
      expect(posted[0]).toContain(MARKER);
      expect(posted[0]).toContain(`Head: \`head-v${String(number - 100)}\``);
      expect(posted[0]).toContain(`position ${String(number - 100)}`);
      expect(q.labels.get(number), `PR ${String(number)} labels`).toEqual(['merge-queued']);
    }
    expect(q.claims).toEqual(['v1']);
    expect(q.reserves).toEqual(['v1']);
    expect(q.releases).toEqual([{ verdictId: 'v1', reason: 'rate_ceiling_deferred' }]);
    expect(q.merges).toEqual([]);
  });

  test('Test 2: a second sweep adds nothing for the verdicts behind the head and does not read them', async () => {
    const q = queue(3);
    await q.sweep();
    const readsAfterFirst = new Map(q.reads);
    const commentsAfterFirst = [101, 102, 103].map(n => (q.comments.get(n) ?? []).length);
    const labelAddsAfterFirst = q.labelAdds.length;

    await q.sweep();

    expect(q.reads.get(102)).toBe(readsAfterFirst.get(102));
    expect(q.reads.get(103)).toBe(readsAfterFirst.get(103));
    expect([101, 102, 103].map(n => (q.comments.get(n) ?? []).length)).toEqual(commentsAfterFirst);
    expect(q.labelAdds.length).toBe(labelAddsAfterFirst);
    expect(q.merges).toEqual([]);
  });

  test('Test 3: held, blocked, stale, failing, conflicting and policy-skipped pull requests get no note', async () => {
    const q = queue(9);
    q.evidence.set(102, { labels: ['merge-hold'] });
    q.evidence.set(103, { labels: ['owner:reworking'] });
    q.evidence.set(104, { headSha: 'a-newer-head' });
    q.evidence.set(105, { checks: { total: 2, passed: 1, failed: 1, pending: 0 } });
    q.evidence.set(106, { mergeable: false, mergeableState: 'dirty' });
    q.evidence.set(107, { baseBranch: 'main' });
    q.evidence.set(108, { changedFilePaths: ['docs/operations/note.md'] });

    await q.sweep();

    // 102 to 108 are not eligible; 109 is, and still gets its note (the head 101 has its own).
    expect([...q.comments.keys()].sort()).toEqual([101, 109]);
    expect(q.labelAdds.sort()).toEqual([101, 109]);
    expect(q.claims).toEqual(['v1']);
    expect(q.merges).toEqual([]);
  });

  test('Test 4: a GitHub rate-limit stop still stops the sweep', async () => {
    const q = queue(3, 0, 2);
    q.store.deferVerdictClaim = async () => true;
    q.github.mergePullRequest = async () => {
      throw new Error('API rate limit exceeded');
    };

    await q.sweep();

    expect(q.claims).toEqual(['v1']);
    expect(q.reads.get(102)).toBeUndefined();
    expect(q.reads.get(103)).toBeUndefined();
    expect(q.comments.size).toBe(0);
  });

  test('Test 5: the head keeps the notice it has always had', async () => {
    const q = queue(1);
    await q.sweep();

    const [body] = q.comments.get(101) ?? [];
    expect(body).toBe(
      [
        MARKER,
        'Head: `head-v1`',
        'Queued for merge: position 1, hourly ceiling 2. Earliest next merge slot: 2026-11-12T20:10:00.000Z.',
      ].join('\n')
    );
    expect(q.releases).toEqual([{ verdictId: 'v1', reason: 'rate_ceiling_deferred' }]);
    expect(q.labels.get(101)).toEqual(['merge-queued']);
  });

  test('Test 6: at most QUEUE_NOTE_MAX_PER_SWEEP notes behind the head per sweep, the rest on the next sweep, none twice', async () => {
    expect(QUEUE_NOTE_MAX_PER_SWEEP).toBe(10);
    const q = queue(14);

    await q.sweep();
    const first = [...q.comments.keys()].sort((a, b) => a - b);
    // the head plus ten notes (positions 2 to 11)
    expect(first).toEqual([101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111]);
    expect(q.comments.get(111)?.[0]).toContain('position 11');
    expect(q.comments.get(112)).toBeUndefined();

    await q.sweep();
    const second = [...q.comments.keys()].sort((a, b) => a - b);
    expect(second).toEqual([101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114]);
    for (const number of second) {
      expect(q.comments.get(number), `PR ${String(number)} commented once`).toHaveLength(1);
    }
    expect(q.claims).toEqual(['v1', 'v1']);
    expect(q.merges).toEqual([]);
  });

  test('Test 7: ineligible pull requests do not starve the eligible ones behind them (Overseer review of PR 1590)', async () => {
    // head, ten held pull requests (102 to 111), then an eligible one (112)
    const q = queue(12);
    for (let number = 102; number <= 111; number += 1)
      q.evidence.set(number, { labels: ['merge-hold'] });

    await q.sweep();
    // the first sweep spends its ten reads on the held ones and notes nothing behind the head
    expect(q.comments.get(112)).toBeUndefined();
    for (let number = 102; number <= 111; number += 1) expect(q.reads.get(number)).toBe(1);

    await q.sweep();
    // the second sweep skips the held ones without reading them and reaches the eligible one
    for (let number = 102; number <= 111; number += 1) expect(q.reads.get(number)).toBe(1);
    expect(q.comments.get(112)).toHaveLength(1);
    expect(q.labels.get(112)).toEqual(['merge-queued']);
  });

  test('Test 8: a held pull request is re-read after the recheck window and noted once the hold is lifted', async () => {
    const q = queue(3);
    q.evidence.set(102, { labels: ['merge-hold'] });

    await q.sweep();
    expect(q.comments.get(102)).toBeUndefined();
    expect(q.reads.get(102)).toBe(1);

    // hold lifted; inside the window nothing is read, after it the pull request is noted
    q.evidence.delete(102);
    await q.sweep(new Date(NOW.getTime() + QUEUE_NOTE_RECHECK_MS - 1000));
    expect(q.reads.get(102)).toBe(1);
    await q.sweep(new Date(NOW.getTime() + QUEUE_NOTE_RECHECK_MS + 1000));
    expect(q.reads.get(102)).toBe(2);
    expect(q.comments.get(102)).toHaveLength(1);
  });

  test('Test 9: a label that failed to land is retried after the recheck window, without a second comment', async () => {
    const q = queue(3);
    let labelFailures = 1;
    const add = q.github.addPullRequestLabels!;
    q.github.addPullRequestLabels = async input => {
      if (input.number === 102 && labelFailures > 0) {
        labelFailures -= 1;
        throw new Error('label api down');
      }
      return add(input);
    };

    let at = NOW;
    // the earliest reservation moves with the clock, so the head's own notice keeps posting on later sweeps
    q.store.getEarliestMergeSlotReservation = async () =>
      new Date(at.getTime() - 50 * 60 * 1000).toISOString();
    const sweepAt = (when: Date): Promise<void> => {
      at = when;
      return q.sweep(when);
    };

    await sweepAt(NOW);
    // the comment landed, the label did not
    expect(q.comments.get(102)).toHaveLength(1);
    expect(q.labels.get(102)).toBeUndefined();
    expect(q.reads.get(102)).toBe(1);

    // inside the window nothing is re-read
    await sweepAt(new Date(NOW.getTime() + QUEUE_NOTE_RECHECK_MS - 1000));
    expect(q.reads.get(102)).toBe(1);

    // after the window the label is retried and the comment is not repeated
    await sweepAt(new Date(NOW.getTime() + QUEUE_NOTE_RECHECK_MS + 1000));
    expect(q.reads.get(102)).toBe(2);
    expect(q.labels.get(102)).toEqual(['merge-queued']);
    expect(q.comments.get(102)).toHaveLength(1);

    // and now it is final: no further read
    await sweepAt(new Date(NOW.getTime() + 3 * QUEUE_NOTE_RECHECK_MS));
    expect(q.reads.get(102)).toBe(2);
  });
});
