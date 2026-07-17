import { describe, expect, mock, test } from 'bun:test';
import {
  ReconcileRateLimitError,
  runReconcileDuty,
  type ReconcileDeps,
  type ReconcileMergedPullRequest,
  type ReconcileTrackerIssue,
} from '../reconcile';

function mergedPr(input: Partial<ReconcileMergedPullRequest> = {}): ReconcileMergedPullRequest {
  return {
    owner: 'bluedevilcollectibles',
    repo: 'bdc-harness',
    number: 507,
    title: 'BDC feature Work Order implementation',
    body: 'Implements WO-HARNESS-OVERSEER-V1B-TRACKER-RECONCILE-01.',
    htmlUrl: 'https://github.com/bluedevilcollectibles/bdc-harness/pull/507',
    mergeCommitSha: 'abc123merge',
    mergedAt: '2026-07-17T10:00:00.000Z',
    ...input,
  };
}

function tracker(input: Partial<ReconcileTrackerIssue> = {}): ReconcileTrackerIssue {
  return {
    number: 876,
    title: 'WO-HARNESS-OVERSEER-V1B-TRACKER-RECONCILE-01',
    state: 'OPEN',
    ...input,
  };
}

function deps(input: {
  prs?: ReconcileMergedPullRequest[];
  trackerIssue?: ReconcileTrackerIssue | null;
  runId?: string | null;
  searchError?: Error;
} = {}): ReconcileDeps & {
  calls: {
    comments: string[];
    labels: number[];
    closes: number[];
    records: Array<{ stem: string; prUrl: string; mergeSha: string }>;
  };
} {
  const calls = {
    comments: [] as string[],
    labels: [] as number[],
    closes: [] as number[],
    records: [] as Array<{ stem: string; prUrl: string; mergeSha: string }>,
  };
  return {
    calls,
    searchMergedPullRequests: mock(async () => {
      if (input.searchError) throw input.searchError;
      return input.prs ?? [mergedPr()];
    }),
    getTrackerIssue: mock(async () =>
      input.trackerIssue === undefined ? tracker() : input.trackerIssue
    ),
    postEvidenceComment: mock(async (_issueNumber, body) => {
      calls.comments.push(body);
    }),
    addDoneLabel: mock(async issueNumber => {
      calls.labels.push(issueNumber);
    }),
    closeTrackerIssue: mock(async issueNumber => {
      calls.closes.push(issueNumber);
    }),
    getLastReconcileClosedAt: mock(async () => null),
    resolveRunId: mock(async () => (input.runId === undefined ? 'run-1' : input.runId)),
    recordReconcileClose: mock(async record => {
      calls.records.push({
        stem: record.stem,
        prUrl: record.prUrl,
        mergeSha: record.mergeSha,
      });
    }),
  };
}

describe('reconcile duty', () => {
  test('merged fixture PR with stem in body closes open tracker with evidence and records action', async () => {
    const fake = deps();

    await runReconcileDuty(fake, { now: new Date('2026-07-17T12:00:00.000Z') });

    expect(fake.calls.comments).toHaveLength(1);
    expect(fake.calls.comments[0]).toContain(
      'https://github.com/bluedevilcollectibles/bdc-harness/pull/507'
    );
    expect(fake.calls.comments[0]).toContain('abc123merge');
    expect(fake.calls.comments[0]).toContain('bluedevilcollectibles/bdc-harness');
    expect(fake.calls.labels).toEqual([876]);
    expect(fake.calls.closes).toEqual([876]);
    expect(fake.calls.records).toEqual([
      {
        stem: 'WO-HARNESS-OVERSEER-V1B-TRACKER-RECONCILE-01',
        prUrl: 'https://github.com/bluedevilcollectibles/bdc-harness/pull/507',
        mergeSha: 'abc123merge',
      },
    ]);
  });

  test('merged fixture PR still closes tracker without recording action when no run matches', async () => {
    const fake = deps({ runId: null });

    await runReconcileDuty(fake, { now: new Date('2026-07-17T12:00:00.000Z') });

    expect(fake.resolveRunId).toHaveBeenCalledWith('WO-HARNESS-OVERSEER-V1B-TRACKER-RECONCILE-01');
    expect(fake.calls.comments).toHaveLength(1);
    expect(fake.calls.labels).toEqual([876]);
    expect(fake.calls.closes).toEqual([876]);
    expect(fake.calls.records).toHaveLength(0);
  });

  test('same input second run no-ops once tracker is already closed', async () => {
    const fake = deps({ trackerIssue: tracker({ state: 'CLOSED' }) });

    await runReconcileDuty(fake);

    expect(fake.calls.comments).toHaveLength(0);
    expect(fake.calls.labels).toHaveLength(0);
    expect(fake.calls.closes).toHaveLength(0);
    expect(fake.calls.records).toHaveLength(0);
  });

  test('merged PR with no stem is ignored', async () => {
    const fake = deps({ prs: [mergedPr({ body: 'No work order stem here.' })] });

    await runReconcileDuty(fake);

    expect(fake.calls.comments).toHaveLength(0);
    expect(fake.calls.closes).toHaveLength(0);
    expect(fake.calls.records).toHaveLength(0);
  });

  test('OPEN unmerged PR with stem is ignored by merged search results', async () => {
    const fake = deps({ prs: [] });

    await runReconcileDuty(fake);

    expect(fake.calls.comments).toHaveLength(0);
    expect(fake.calls.closes).toHaveLength(0);
    expect(fake.calls.records).toHaveLength(0);
  });

  test('rate-limit response from search API skips cycle with no tracker action', async () => {
    const fake = deps({ searchError: new ReconcileRateLimitError() });

    await runReconcileDuty(fake);

    expect(fake.getTrackerIssue).not.toHaveBeenCalled();
    expect(fake.calls.comments).toHaveLength(0);
    expect(fake.calls.closes).toHaveLength(0);
    expect(fake.calls.records).toHaveLength(0);
  });

  test('tracker already closed no-ops without duplicate comment', async () => {
    const fake = deps({ trackerIssue: tracker({ state: 'closed' }) });

    await runReconcileDuty(fake);

    expect(fake.calls.comments).toHaveLength(0);
    expect(fake.calls.labels).toHaveLength(0);
    expect(fake.calls.closes).toHaveLength(0);
  });
});
