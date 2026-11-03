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
// A spurious same-title open+closed PAIR (a history/containment copy sitting
// next to the live tracker) must not abort a reconcile pass -- findTrackerIssueByStem
// now prefers the single open match. GENUINE ambiguity (two or more open matches,
// or a zero-open set with more than one closed copy) and malformed-snapshot errors
// remain FAIL CLOSED: they propagate out of runReconcileOnce and no tracker is
// mutated (the existing contract enforced in reconcile-github-auth.test.ts). These
// tests cover both the open-vs-closed preference and that fail-closed boundary.

const STEM_A = 'WO-X-AMBIG-01';

// PR A: on its project base (bdc-harness -> dev), declares STEM_A on a manifest
// WO: line and carries NO closing keyword. This drives the declared-stem lookup
// through findTrackerIssueByStem.
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

// Deps whose findTrackerIssueByStem resolves against a real tracker snapshot via
// the production findTrackerIssueByStem, so the integration tests exercise the
// open-vs-closed preference and the fail-closed ambiguity propagation end to end.
function reconcileDeps(input: {
  prs: ReconcileMergedPullRequest[];
  snapshot: TrackerIssueSnapshot;
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
    findTrackerIssueByNumber: mock(async () => null),
    findTrackerIssueByStem: mock(async (candidate: string) =>
      findTrackerIssueByStem(input.snapshot, candidate)
    ),
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

// Build a tracker snapshot row for the findTrackerIssueByStem tests.
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

describe('findTrackerIssueByStem open-vs-closed preference (WO-HARNESS-RECONCILE-PER-PR-ERROR-ISOLATION-01)', () => {
  test('one_open_one_closed_prefers_open -- returns the open issue, no throw', () => {
    const snap = snapshot([
      snapshotRow({ number: 4114, title: 'WO-X-01', state: 'open' }),
      snapshotRow({ number: 3743, title: 'WO-X-01', state: 'closed' }),
    ]);

    const result = findTrackerIssueByStem(snap, 'WO-X-01');

    expect(result).not.toBeNull();
    expect(result?.number).toBe(4114);
    expect(result?.state).toBe('open');
  });

  test('two_open_still_ambiguous -- throws when two matches are open', () => {
    const snap = snapshot([
      snapshotRow({ number: 4114, title: 'WO-X-01', state: 'open' }),
      snapshotRow({ number: 4200, title: 'WO-X-01', state: 'open' }),
    ]);

    expect(() => findTrackerIssueByStem(snap, 'WO-X-01')).toThrow(
      'tracker issue title is ambiguous: WO-X-01'
    );
  });

  test('zero_open_multiple_closed_still_ambiguous -- never picks an arbitrary closed issue', () => {
    // No live tracker to prefer: two same-title CLOSED copies with zero open
    // matches are genuinely ambiguous. The single-open preference must not
    // degrade into silently returning matches[0].
    const snap = snapshot([
      snapshotRow({ number: 3743, title: 'WO-X-01', state: 'closed' }),
      snapshotRow({ number: 3744, title: 'WO-X-01', state: 'closed' }),
    ]);

    expect(() => findTrackerIssueByStem(snap, 'WO-X-01')).toThrow(
      'tracker issue title is ambiguous: WO-X-01'
    );
  });

  test('single_closed_match_returns -- one closed copy with no open twin is unambiguous', () => {
    const snap = snapshot([snapshotRow({ number: 3743, title: 'WO-X-01', state: 'closed' })]);

    const result = findTrackerIssueByStem(snap, 'WO-X-01');

    expect(result).not.toBeNull();
    expect(result?.number).toBe(3743);
    expect(result?.state).toBe('closed');
  });

  test('no_match_returns_null', () => {
    const snap = snapshot([snapshotRow({ number: 3743, title: 'WO-OTHER-01', state: 'open' })]);
    expect(findTrackerIssueByStem(snap, 'WO-X-01')).toBeNull();
  });
});

describe('runReconcileOnce fail-closed boundary (WO-HARNESS-RECONCILE-PER-PR-ERROR-ISOLATION-01)', () => {
  test('open_plus_closed_pair_does_not_abort -- resolves to the open tracker and completes the pass', async () => {
    // Anchor bdc-xo #4114 open + #3743 closed: before the fix this same-title
    // pair threw "ambiguous" and aborted the entire pass, so the declared WO was
    // never noted. Now it resolves to the open tracker and the pass finishes.
    const snap = snapshot([
      snapshotRow({ number: 4114, title: STEM_A, state: 'open' }),
      snapshotRow({ number: 3743, title: STEM_A, state: 'closed' }),
    ]);
    const deps = reconcileDeps({ prs: [prA()], snapshot: snap });

    const result = await runReconcileOnce({ deps });

    expect(result.skipped).toBe(false);
    // The declared-but-not-closed WO was noted against the OPEN tracker.
    expect(deps.actions.some(a => a.action === 'reconcile_keyword_missing_noted')).toBe(true);
    expect(deps.infos).toContain('overseer.reconcile.keyword_missing_tracker_left_open');
  });

  test('two_open_duplicate_aborts_pass -- genuine ambiguity fails closed with no tracker effect', async () => {
    // Two OPEN same-title trackers are genuinely ambiguous. The pass must abort
    // (propagate) rather than guess, and nothing may be written.
    const snap = snapshot([
      snapshotRow({ number: 4114, title: STEM_A, state: 'open' }),
      snapshotRow({ number: 4200, title: STEM_A, state: 'open' }),
    ]);
    const deps = reconcileDeps({ prs: [prA()], snapshot: snap });

    await expect(runReconcileOnce({ deps })).rejects.toThrow(
      `tracker issue title is ambiguous: ${STEM_A}`
    );
    expect(deps.actions).toEqual([]);
    expect(deps.labels).toEqual([]);
    expect(deps.comments).toEqual([]);
  });

  test('all_closed_duplicate_aborts_pass -- zero-open duplicate set fails closed', async () => {
    const snap = snapshot([
      snapshotRow({ number: 3743, title: STEM_A, state: 'closed' }),
      snapshotRow({ number: 3744, title: STEM_A, state: 'closed' }),
    ]);
    const deps = reconcileDeps({ prs: [prA()], snapshot: snap });

    await expect(runReconcileOnce({ deps })).rejects.toThrow(
      `tracker issue title is ambiguous: ${STEM_A}`
    );
    expect(deps.actions).toEqual([]);
    expect(deps.labels).toEqual([]);
    expect(deps.comments).toEqual([]);
  });
});
