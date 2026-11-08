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
// Two behaviours, and the line between them.
//
// 1. ERROR ISOLATION (the WO's core ask). A GENERIC lookup failure -- a transport
//    blip, one unreadable tracker -- is contained. A per-PR keyword lookup logs
//    `overseer.reconcile.pr_error` and moves to the next PR; a declared-stem
//    lookup logs `overseer.reconcile.stem_lookup_error` and skips that stem. The
//    pass completes and later PRs are still reconciled.
//
// 2. FAIL CLOSED (the pre-existing safety contract, preserved). An error saying
//    the tracker DATA is untrustworthy is NOT isolated: a malformed/conflicting/
//    over-budget REST snapshot (we do not know the tracker state) and a genuinely
//    ambiguous exact title (we do not know WHICH tracker) still propagate out of
//    runReconcileOnce with no tracker mutated. Tracker MUTATION failures are also
//    untouched: isolation wraps only the lookup call, never the comment/label/
//    close effects, so a failed mark still aborts.
//
// A spurious same-title open+closed PAIR (a history/containment copy beside the
// live tracker) is not genuine ambiguity -- findTrackerIssueByStem prefers the
// single open match. The end-to-end fail-closed cases against the real REST
// snapshot code live in reconcile-github-auth.test.ts.

const STEM_A = 'WO-X-AMBIG-01';
const STEM_B = 'WO-X-OTHER-02';

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
  findTrackerIssueByStem?: (stem: string) => Promise<ReconcileTrackerIssue | null>;
  findTrackerIssueByNumber?: (number: number) => Promise<ReconcileTrackerIssue | null>;
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
    findTrackerIssueByNumber: mock(
      async (number: number) => (await input.findTrackerIssueByNumber?.(number)) ?? null
    ),
    findTrackerIssueByStem: mock(async (candidate: string) =>
      input.findTrackerIssueByStem
        ? await input.findTrackerIssueByStem(candidate)
        : findTrackerIssueByStem(input.snapshot, candidate)
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

// PR B: declares a DIFFERENT stem, also with no closing keyword. Used to prove a
// later PR/stem is still reconciled after an earlier one failed.
function prB(overrides: Partial<ReconcileMergedPullRequest> = {}): ReconcileMergedPullRequest {
  return {
    ...prA(),
    number: 502,
    title: 'PR B declares another WO stem',
    body: `WO: ${STEM_B}\n\nImplementation notes for ${STEM_B}.`,
    htmlUrl: 'https://github.com/thinmansoftware/bdc-harness/pull/502',
    mergeCommitSha: 'shaB',
    ...overrides,
  };
}

// PR K: carries a closing keyword naming tracker #4114, which drives the per-PR
// findTrackerIssueByNumber path. The cross-repo form is required: a bare `#n`
// resolves to the PR's own repo and is not a tracker ref.
function prK(overrides: Partial<ReconcileMergedPullRequest> = {}): ReconcileMergedPullRequest {
  return {
    ...prA(),
    number: 601,
    title: 'PR K closes a tracker by keyword',
    body: 'Closes thinmansoftware/bdc-xo#4114',
    htmlUrl: 'https://github.com/thinmansoftware/bdc-harness/pull/601',
    mergeCommitSha: 'shaK',
    ...overrides,
  };
}

describe('runReconcileOnce generic error isolation (WO-HARNESS-RECONCILE-PER-PR-ERROR-ISOLATION-01)', () => {
  test('generic_stem_lookup_error_is_isolated -- logs stem_lookup_error and finishes the pass', async () => {
    // STEM_A's lookup fails generically; STEM_B on a later PR must still be noted.
    const snap = snapshot([snapshotRow({ number: 4200, title: STEM_B, state: 'open' })]);
    const deps = reconcileDeps({
      prs: [prA(), prB()],
      snapshot: snap,
      findTrackerIssueByStem: async stem => {
        if (stem === STEM_A) throw new Error('transient stem lookup blip');
        return findTrackerIssueByStem(snap, stem);
      },
    });

    const result = await runReconcileOnce({ deps });

    expect(result.skipped).toBe(false);
    expect(deps.warnings).toContain('overseer.reconcile.stem_lookup_error');
    // The later stem was still reconciled -- the failure did not abort the pass.
    expect(deps.actions.map(a => a.woId)).toContain(STEM_B);
    expect(deps.actions.map(a => a.woId)).not.toContain(STEM_A);
  });

  test('generic_pr_lookup_error_is_isolated -- logs pr_error and proceeds to later PRs', async () => {
    // PR K's keyword lookup fails generically. PR B, processed after it, must
    // still be reconciled.
    const snap = snapshot([snapshotRow({ number: 4200, title: STEM_B, state: 'open' })]);
    const deps = reconcileDeps({
      prs: [prK(), prB()],
      snapshot: snap,
      findTrackerIssueByNumber: async () => {
        throw new Error('transient tracker lookup blip');
      },
    });

    const result = await runReconcileOnce({ deps });

    expect(result.skipped).toBe(false);
    expect(deps.warnings).toContain('overseer.reconcile.pr_error');
    // The later PR was still reconciled.
    expect(deps.actions.map(a => a.woId)).toContain(STEM_B);
    // The failing PR produced no tracker effect of its own.
    expect(deps.comments).toEqual([]);
    expect(deps.labels).toEqual([]);
  });

  test('rate_limit_at_pr_lookup_still_skips -- isolation did not swallow the RL skip', async () => {
    const snap = snapshot([snapshotRow({ number: 4200, title: STEM_B, state: 'open' })]);
    const deps = reconcileDeps({
      prs: [prK(), prB()],
      snapshot: snap,
      findTrackerIssueByNumber: async () => {
        throw Object.assign(new Error('API rate limit exceeded'), { status: 403 });
      },
    });

    const result = await runReconcileOnce({ deps });

    expect(result.skipped).toBe(true);
    expect(deps.warnings).toContain('overseer.reconcile.rate_limit_skip');
    expect(deps.warnings).not.toContain('overseer.reconcile.pr_error');
    expect(deps.actions).toEqual([]);
  });

  test('malformed_snapshot_at_pr_lookup_aborts -- integrity errors are never isolated', async () => {
    // A malformed REST snapshot means the tracker state is unknown. Isolating it
    // would let reconcile act on later PRs against untrustworthy data.
    const snap = snapshot([snapshotRow({ number: 4200, title: STEM_B, state: 'open' })]);
    const deps = reconcileDeps({
      prs: [prK(), prB()],
      snapshot: snap,
      findTrackerIssueByNumber: async () => {
        throw new Error('tracker issue REST listing returned a malformed page');
      },
    });

    await expect(runReconcileOnce({ deps })).rejects.toThrow('tracker issue REST listing');
    expect(deps.actions).toEqual([]);
    expect(deps.comments).toEqual([]);
    expect(deps.labels).toEqual([]);
  });

  test('malformed_snapshot_at_stem_lookup_aborts -- integrity errors are never isolated', async () => {
    const snap = snapshot([snapshotRow({ number: 4200, title: STEM_B, state: 'open' })]);
    const deps = reconcileDeps({
      prs: [prA(), prB()],
      snapshot: snap,
      findTrackerIssueByStem: async () => {
        throw new Error('tracker issue REST listing exceeded its complete-page budget');
      },
    });

    await expect(runReconcileOnce({ deps })).rejects.toThrow('complete-page budget');
    expect(deps.actions).toEqual([]);
  });

  test('tracker_mutation_failure_still_aborts -- isolation wraps the lookup, not the effects', async () => {
    // The comment/label/close effects sit OUTSIDE the isolated lookup, so a failed
    // mark still aborts the pass and is never recorded as a success.
    const snap = snapshot([snapshotRow({ number: 4114, title: STEM_A, state: 'open' })]);
    const deps = reconcileDeps({
      prs: [prA()],
      snapshot: snap,
    });
    deps.insertAction = async () => {
      throw new Error('fixture action insert failed');
    };

    await expect(runReconcileOnce({ deps })).rejects.toThrow('fixture action insert failed');
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
