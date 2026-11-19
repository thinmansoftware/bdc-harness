/**
 * WO-HARNESS-STAGING-CLOSES-LINK-01 -- a name-mention never closes a tracker.
 *
 * Test 4: a merged PR that merely NAMES a WO (prose, no closing keyword, no `WO:`
 * manifest line) must not close that WO's tracker. Anchor: bdc-xo PR 4326 named
 * WO-XO-T3-DESKTOP-STOCK-INSTALL-01 ("tracker issue 4108") and the Overseer
 * closed #4108 at 20:22:37Z; a human reopened it.
 *
 * Test 7: a merged PR on its project base that declares a WO on a manifest `WO:`
 * line but carries no closing keyword leaves the tracker open and records exactly
 * one reconcile_keyword_missing_noted row.
 */

import { expect, test } from 'bun:test';
import {
  RECONCILE_ACTION,
  RECONCILE_KEYWORD_MISSING_ACTION,
  runReconcileOnce,
  type ReconcileActionRecord,
  type ReconcileDeps,
  type ReconcileMergedPullRequest,
  type ReconcileTrackerIssue,
} from '../reconcile';

const ORG = 'thinmansoftware';

interface HarnessState {
  deps: ReconcileDeps;
  comments: string[];
  closes: number[];
  actions: ReconcileActionRecord[];
  infos: string[];
  keywordMissingNoted: Set<string>;
}

function harness(options: {
  prs: ReconcileMergedPullRequest[];
  trackersByNumber?: Record<number, ReconcileTrackerIssue>;
  trackersByStem?: Record<string, ReconcileTrackerIssue>;
}): HarnessState {
  const comments: string[] = [];
  const closes: number[] = [];
  const actions: ReconcileActionRecord[] = [];
  const infos: string[] = [];
  const byNumber = options.trackersByNumber ?? {};
  const byStem = options.trackersByStem ?? {};
  // Durable keyword-missing dedup: a row persists across runs within the test.
  const keywordMissingNoted = new Set<string>();
  const deps: ReconcileDeps = {
    readCursor: async () => null,
    now: () => new Date('2026-11-02T22:00:00Z'),
    searchMergedPullRequests: async () => options.prs,
    findTrackerIssueByNumber: async (number: number) => byNumber[number] ?? null,
    findTrackerIssueByStem: async (stem: string) => byStem[stem] ?? null,
    listPullRequestFiles: async () => ['src/real-code.ts'],
    listOpenPullRequestsReferencingTracker: async () => [],
    addTrackerEvidenceComment: async request => {
      comments.push(request.body);
    },
    addTrackerLabel: async () => undefined,
    closeTrackerIssue: async request => {
      closes.push(request.issue.number);
    },
    hasSkipBeenNoted: async () => false,
    hasCloseBeenRecorded: async () => false,
    hasHoldBeenNoted: async () => false,
    hasKeywordMissingBeenNoted: async ({ prRef, woId }) =>
      keywordMissingNoted.has(`${prRef}|${woId}`),
    insertAction: async record => {
      actions.push(record);
      if (record.action === RECONCILE_KEYWORD_MISSING_ACTION) {
        keywordMissingNoted.add(`${record.prRef}|${record.woId}`);
      }
    },
    log: {
      warn: () => undefined,
      info: (_fields, message) => infos.push(message),
    },
  };
  return { deps, comments, closes, actions, infos, keywordMissingNoted };
}

test('Test 4: a bdc-xo PR naming a WO and its tracker number in prose closes nothing', async () => {
  const NAMED_WO = 'WO-XO-T3-DESKTOP-STOCK-INSTALL-01';
  const state = harness({
    prs: [
      {
        owner: ORG,
        repo: 'bdc-xo',
        number: 4326,
        title: 'desktop stock install follow-up',
        body: `Follow-up for ${NAMED_WO} (tracker issue 4108). No closing keyword here.`,
        htmlUrl: `https://github.com/${ORG}/bdc-xo/pull/4326`,
        state: 'closed',
        merged: true,
        mergeCommitSha: 'cafef00d',
        baseRef: 'main',
      },
    ],
    trackersByNumber: {
      4108: { owner: ORG, repo: 'bdc-xo', number: 4108, title: NAMED_WO, state: 'open' },
    },
    trackersByStem: {
      [NAMED_WO]: { owner: ORG, repo: 'bdc-xo', number: 4108, title: NAMED_WO, state: 'open' },
    },
  });

  const result = await runReconcileOnce({ deps: state.deps });

  expect(result.closed).toBe(0);
  expect(state.closes).toEqual([]);
  expect(state.actions.filter(a => a.action === RECONCILE_ACTION)).toEqual([]);
  // No WO: declaration, so no keyword-missing note either.
  expect(state.actions).toEqual([]);
  // At most an incidental-mention log line.
  expect(state.infos).toContain('overseer.reconcile.incidental_mention_not_evidence');
});

test('Test 7: a declared WO with no closing keyword leaves the tracker open and notes it exactly once', async () => {
  const WO_X = 'WO-X-TRACKER-NO-KEYWORD-01';
  const prRef = `${ORG}/bdc-harness#700`;
  const pr: ReconcileMergedPullRequest = {
    owner: ORG,
    repo: 'bdc-harness',
    number: 700,
    title: 'implements the work',
    body: `Implements the work.\n\nWO: ${WO_X}`,
    htmlUrl: `https://github.com/${ORG}/bdc-harness/pull/700`,
    state: 'closed',
    merged: true,
    mergeCommitSha: 'f00dfeed',
    baseRef: 'dev',
  };
  const trackerX: ReconcileTrackerIssue = {
    owner: ORG,
    repo: 'bdc-xo',
    number: 5200,
    title: WO_X,
    state: 'open',
  };
  const state = harness({
    prs: [pr],
    trackersByStem: { [WO_X]: trackerX },
    trackersByNumber: { 5200: trackerX },
  });

  // Two runs: the second rescan must not add a second note (dedup via DB guard).
  await runReconcileOnce({ deps: state.deps });
  await runReconcileOnce({ deps: state.deps });

  expect(state.closes).toEqual([]);
  const notes = state.actions.filter(a => a.action === RECONCILE_KEYWORD_MISSING_ACTION);
  expect(notes).toHaveLength(1);
  expect(notes[0]).toMatchObject({ prRef, woId: WO_X, class: 'tracker_reconcile' });
  // No comment is posted for a keyword-missing note.
  expect(state.comments).toEqual([]);
});
