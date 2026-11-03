import { describe, expect, mock, test } from 'bun:test';
import {
  findTrackerIssueByStem,
  runReconcileOnce,
  type ReconcileActionRecord,
  type ReconcileDeps,
  type ReconcileMergedPullRequest,
  type ReconcileTrackerIssue,
  type TrackerIssueSnapshot,
  type TrackerSnapshotRow,
} from '../reconcile';

// WO-HARNESS-RECONCILE-PER-PR-ERROR-ISOLATION-01
//
// One bad or duplicate-titled tracker must never abort a reconcile pass. These
// tests cover the per-stem and per-PR error isolation in runReconcileOnce and
// the open-vs-closed dedup in findTrackerIssueByStem.

const STEM_A = 'WO-X-AMBIG-01';
const TRACKER_B = 2044;

// PR A: on its project base (bdc-harness -> dev), declares STEM_A on a manifest
// WO: line, carries NO closing keyword. This drives the declared-stem lookup.
function prA(overrides: Partial<ReconcileMergedPullRequest> = {}): ReconcileMergedPullRequest {
  return {
    owner: 'thinmansoftware',
    repo: 'bdc-harness',
    number: 501,
    title: 'PR A declares a WO stem',
    body: `WO: ${STEM_A}\n\nImplementation notes for ${STEM_A}.`,
    htmlUrl: 'https://github.com/thinmansoftware/bdc-harness/pull/501',
    state: 'closed',
    merged: true,
    mergeCommitSha: 'shaA',
    mergedAt: '2026-11-03T12:00:00Z',
    baseRef: 'dev',
    ...overrides,
  };
}

// PR B: on its project base, carries a closing keyword for an open tracker.
function prB(overrides: Partial<ReconcileMergedPullRequest> = {}): ReconcileMergedPullRequest {
  return {
    owner: 'thinmansoftware',
    repo: 'bdc-harness',
    number: 502,
    title: 'PR B closes a valid tracker',
    body: `Closes thinmansoftware/bdc-xo#${TRACKER_B}`,
    htmlUrl: 'https://github.com/thinmansoftware/bdc-harness/pull/502',
    state: 'closed',
    merged: true,
    mergeCommitSha: 'shaB',
    mergedAt: '2026-11-03T12:05:00Z',
    baseRef: 'dev',
    ...overrides,
  };
}

function trackerB(state: 'open' | 'closed' = 'open'): ReconcileTrackerIssue {
  return {
    owner: 'thinmansoftware',
    repo: 'bdc-xo',
    number: TRACKER_B,
    title: 'WO-B-VALID-01',
    state,
  };
}

// Bespoke deps: findTrackerIssueByStem / findTrackerIssueByNumber can be made to
// fail only for PR A while succeeding for PR B, which the shared reconcile.test
// helpers (single hardcoded number + single global error) cannot express.
function isolationDeps(input: {
  prs: ReconcileMergedPullRequest[];
  stemError?: unknown;
  numberError?: unknown;
}): ReconcileDeps & {
  labels: string[];
  comments: string[];
  actions: ReconcileActionRecord[];
  warnings: string[];
  infos: string[];
} {
  const labels: string[] = [];
  const comments: string[] = [];
  const actions: ReconcileActionRecord[] = [];
  const warnings: string[] = [];
  const infos: string[] = [];
  return {
    labels,
    comments,
    actions,
    warnings,
    infos,
    readCursor: mock(async () => null),
    now: () => new Date('2026-11-03T12:10:00Z'),
    searchMergedPullRequests: mock(async () => input.prs),
    findTrackerIssueByNumber: mock(async (number: number) => {
      if (input.numberError) throw input.numberError;
      if (number === TRACKER_B) return trackerB();
      return null;
    }),
    findTrackerIssueByStem: mock(async (candidate: string) => {
      if (candidate === STEM_A && input.stemError) throw input.stemError;
      // PR B declares nothing, so this is only reached for STEM_A.
      return null;
    }),
    addTrackerEvidenceComment: mock(async request => {
      comments.push(request.body);
    }),
    addTrackerLabel: mock(async request => {
      labels.push(request.label);
    }),
    removeTrackerLabel: mock(async () => {}),
    closeTrackerIssue: mock(async () => {}),
    hasSkipBeenNoted: mock(async () => false),
    hasCloseBeenRecorded: mock(async () => false),
    hasMergedBeenNoted: mock(async () => false),
    hasKeywordMissingBeenNoted: mock(async () => false),
    insertAction: mock(async record => {
      actions.push(record);
    }),
    log: {
      warn: (_fields, message) => {
        warnings.push(message);
      },
      info: (_fields, message) => {
        infos.push(message);
      },
    },
  };
}

// Build a tracker snapshot row for the direct findTrackerIssueByStem unit tests.
function snapshotRow(
  overrides: Partial<TrackerSnapshotRow> & { number: number }
): TrackerSnapshotRow {
  return {
    number: overrides.number,
    title: overrides.title ?? 'WO-X-01',
    state: overrides.state ?? 'open',
    htmlUrl:
      overrides.htmlUrl ?? `https://github.com/thinmansoftware/bdc-xo/issues/${overrides.number}`,
    pullRequest: overrides.pullRequest ?? false,
    createdAt: overrides.createdAt ?? '2026-11-01T00:00:00Z',
  };
}

function snapshot(rows: TrackerSnapshotRow[]): TrackerIssueSnapshot {
  return new Map(rows.map(row => [row.number, row]));
}

describe('reconcile error isolation (WO-HARNESS-RECONCILE-PER-PR-ERROR-ISOLATION-01)', () => {
  test('Test 1: stem_ambiguous_does_not_abort -- ambiguous stem on PR A is logged and skipped, PR B still marked', async () => {
    const deps = isolationDeps({
      prs: [prA(), prB()],
      stemError: new Error('tracker issue title is ambiguous: WO-X-AMBIG-01'),
    });

    const result = await runReconcileOnce({ deps });

    expect(result.skipped).toBe(false);
    // PR B's tracker was marked merged (one status:merged label + evidence comment).
    expect(deps.labels).toContain('status:merged');
    expect(deps.actions.some(a => a.action === 'reconcile_merged_noted')).toBe(true);
    // Exactly one stem_lookup_error was emitted (for PR A).
    expect(deps.warnings.filter(w => w === 'overseer.reconcile.stem_lookup_error')).toHaveLength(1);
  });

  test('Test 2: generic_per_pr_error_isolated -- generic number-lookup error on PR A is logged, PR B processed', async () => {
    const deps = isolationDeps({
      prs: [prA({ body: `Closes thinmansoftware/bdc-xo#9999` }), prB()],
    });

    // Scope a generic (non-rate-limit, non-auth) error to PR A's referenced
    // tracker number only; PR B's tracker still resolves and is marked.
    deps.findTrackerIssueByNumber = mock(async (number: number) => {
      if (number === 9999) throw new Error('boom: GitHub returned an unexpected shape');
      if (number === TRACKER_B) return trackerB();
      return null;
    });

    const result = await runReconcileOnce({ deps });

    expect(result.skipped).toBe(false);
    // pr_error logged for PR A.
    expect(deps.warnings.filter(w => w === 'overseer.reconcile.pr_error')).toHaveLength(1);
    // PR B still processed and marked.
    expect(deps.labels).toContain('status:merged');
    expect(deps.actions.some(a => a.action === 'reconcile_merged_noted')).toBe(true);
  });

  test('Test 3: rate_limit_still_early_returns -- rate-limit on PR A skips the whole pass', async () => {
    const rateLimit = Object.assign(new Error('API rate limit exceeded'), { status: 403 });
    const deps = isolationDeps({
      prs: [prA({ body: `Closes thinmansoftware/bdc-xo#9999` }), prB()],
    });
    deps.findTrackerIssueByNumber = mock(async (number: number) => {
      if (number === 9999) throw rateLimit;
      if (number === TRACKER_B) return trackerB();
      return null;
    });

    const result = await runReconcileOnce({ deps });

    expect(result.skipped).toBe(true);
    // PR B was never processed (no label marked).
    expect(deps.labels).not.toContain('status:merged');
    expect(deps.warnings.filter(w => w === 'overseer.reconcile.pr_error')).toHaveLength(0);
  });

  test('Test 4: one_open_one_closed_prefers_open -- returns the open issue, no throw', () => {
    const snap = snapshot([
      snapshotRow({ number: 4114, title: 'WO-X-01', state: 'open' }),
      snapshotRow({ number: 3743, title: 'WO-X-01', state: 'closed' }),
    ]);

    const result = findTrackerIssueByStem(snap, 'WO-X-01');

    expect(result).not.toBeNull();
    expect(result?.number).toBe(4114);
    expect(result?.state).toBe('open');
  });

  test('Test 5: two_open_still_ambiguous -- throws when two matches are open', () => {
    const snap = snapshot([
      snapshotRow({ number: 4114, title: 'WO-X-01', state: 'open' }),
      snapshotRow({ number: 4200, title: 'WO-X-01', state: 'open' }),
    ]);

    expect(() => findTrackerIssueByStem(snap, 'WO-X-01')).toThrow(
      'tracker issue title is ambiguous: WO-X-01'
    );
  });
});
