/**
 * WO-HARNESS-MERGE-GATES-01 Amendment 1, Test 12: approval_given_while_draft_is_void_at_the_merge_function.
 *
 * createRealMergePullRequest reads the draft/ready timeline and the Overseer's reviews through EVERY
 * page and refuses when the Overseer's latest APPROVED review at the head was submitted while the PR
 * was a draft. A failed or partial read refuses (pr_approval_state_unknown). Tie rule: an approval at
 * exactly an event's time counts as given while a draft.
 */
import { describe, expect, mock, test } from 'bun:test';
import {
  createRealMergePullRequest,
  type RealGitHubOctokitLike,
} from './adapters/github-real-deps.ts';
import { MERGE_HOLD_REASONS } from './merge-holds.ts';
import { classifyMergeSkip } from './merge-skip-classification.ts';

const HEAD = 'c'.repeat(40);
const OVERSEER = 'thinman-overseer[bot]';
const T0 = '2026-11-13T19:18:00Z';
const T1 = '2026-11-13T19:19:22Z';
const T2 = '2026-11-13T19:21:40Z';
const T3 = '2026-11-13T19:40:00Z';
const T4 = '2026-11-13T19:55:00Z';

type TimelineEvent = { event: string; created_at: string };
type Review = {
  user: { login: string };
  state: string;
  commit_id: string;
  submitted_at: string;
};

const approval = (at: string, login = OVERSEER): Review => ({
  user: { login },
  state: 'APPROVED',
  commit_id: HEAD,
  submitted_at: at,
});

function fakeOctokit(opts: {
  events: TimelineEvent[];
  reviews: Review[];
  throwEventsOnPage?: number;
}) {
  const merge = mock(async () => ({ data: { merged: true, sha: 'f'.repeat(40) } }));
  const pagesRead = { events: [] as number[], reviews: [] as number[] };
  const pageOf = <T>(items: T[], page: number, perPage: number) =>
    items.slice((page - 1) * perPage, page * perPage);
  const octokit = {
    pulls: {
      get: async () => ({
        data: {
          number: 112,
          title: 'Provision store',
          state: 'open',
          html_url: 'https://github.test/pull/112',
          head: { sha: HEAD },
          labels: [],
          draft: false,
        },
      }),
      merge,
      listReviews: async (input: { per_page: number; page?: number }) => {
        const page = input.page ?? 1;
        pagesRead.reviews.push(page);
        return { data: pageOf(opts.reviews, page, input.per_page) };
      },
    },
    issues: {
      listEventsForTimeline: async (input: { per_page: number; page: number }) => {
        pagesRead.events.push(input.page);
        if (opts.throwEventsOnPage === input.page) throw new Error('502 bad gateway');
        return { data: pageOf(opts.events, input.page, input.per_page) };
      },
    },
  } as unknown as RealGitHubOctokitLike;
  return { octokit, merge, pagesRead };
}

async function mergeWith(opts: Parameters<typeof fakeOctokit>[0]) {
  const fake = fakeOctokit(opts);
  const result = await createRealMergePullRequest(fake.octokit)({
    owner: 'thinmansoftware',
    repo: 'comicstoreos-provisioner',
    number: 112,
    expectedHeadSha: HEAD,
  });
  return { result, ...fake };
}

describe('Test 12: approval_given_while_draft_is_void_at_the_merge_function', () => {
  test('(a) an approval given between convert_to_draft and ready_for_review is refused', async () => {
    const { result, merge } = await mergeWith({
      events: [
        { event: 'convert_to_draft', created_at: T1 },
        { event: 'ready_for_review', created_at: T3 },
      ],
      reviews: [approval(T2)],
    });
    expect(result).toEqual({ merged: false, message: 'approval_given_while_draft' });
    expect(merge).toHaveBeenCalledTimes(0);
  });

  test('(b) a fresh approval after ready_for_review merges once', async () => {
    const { result, merge } = await mergeWith({
      events: [
        { event: 'convert_to_draft', created_at: T1 },
        { event: 'ready_for_review', created_at: T3 },
      ],
      reviews: [approval(T2), approval(T4)],
    });
    expect(result.merged).toBe(true);
    expect(merge).toHaveBeenCalledTimes(1);
  });

  test('(c) an approval that predates the draft stays valid and merges once', async () => {
    const { result, merge } = await mergeWith({
      events: [
        { event: 'convert_to_draft', created_at: T1 },
        { event: 'ready_for_review', created_at: T3 },
      ],
      reviews: [approval(T0)],
    });
    expect(result.merged).toBe(true);
    expect(merge).toHaveBeenCalledTimes(1);
  });

  test('(d) a PR opened as a draft: an approval before the first ready_for_review is refused', async () => {
    const { result, merge } = await mergeWith({
      events: [{ event: 'ready_for_review', created_at: T3 }],
      reviews: [approval(T2)],
    });
    expect(result).toEqual({ merged: false, message: 'approval_given_while_draft' });
    expect(merge).toHaveBeenCalledTimes(0);
  });

  test('(e) a failed events read is refused with pr_approval_state_unknown', async () => {
    const { result, merge } = await mergeWith({
      events: [],
      reviews: [approval(T2)],
      throwEventsOnPage: 1,
    });
    expect(result).toEqual({ merged: false, message: 'pr_approval_state_unknown' });
    expect(merge).toHaveBeenCalledTimes(0);
  });

  test('(f) more than 100 items: the key event and the approval on page 2 are read and refuse the merge', async () => {
    const filler: TimelineEvent[] = Array.from({ length: 103 }, (_, i) => ({
      event: 'commented',
      created_at: new Date(Date.parse(T0) - (200 - i) * 1000).toISOString(),
    }));
    const events = [
      ...filler,
      { event: 'convert_to_draft', created_at: T1 },
      { event: 'ready_for_review', created_at: T3 },
    ];
    const otherReviews: Review[] = Array.from({ length: 101 }, (_, i) => ({
      user: { login: `human-${i}` },
      state: 'COMMENTED',
      commit_id: HEAD,
      submitted_at: new Date(Date.parse(T0) - (200 - i) * 1000).toISOString(),
    }));
    const reviews = [...otherReviews, approval(T2)];
    expect(events.length).toBe(105);
    expect(reviews.length).toBe(102);

    const { result, merge, pagesRead } = await mergeWith({ events, reviews });
    expect(result).toEqual({ merged: false, message: 'approval_given_while_draft' });
    expect(merge).toHaveBeenCalledTimes(0);
    expect(pagesRead.events).toEqual([1, 2]);
    expect(pagesRead.reviews).toEqual([1, 2]);

    // The same PR with page 2 of the timeline failing: a partial read is never clean.
    const partial = await mergeWith({ events, reviews, throwEventsOnPage: 2 });
    expect(partial.result).toEqual({ merged: false, message: 'pr_approval_state_unknown' });
    expect(partial.merge).toHaveBeenCalledTimes(0);
  });

  test('(g) tie: an approval at exactly the convert_to_draft time counts as draft and is refused', async () => {
    const { result, merge } = await mergeWith({
      events: [
        { event: 'convert_to_draft', created_at: T1 },
        { event: 'ready_for_review', created_at: T3 },
      ],
      reviews: [approval(T1)],
    });
    expect(result).toEqual({ merged: false, message: 'approval_given_while_draft' });
    expect(merge).toHaveBeenCalledTimes(0);
  });

  test('both new reasons are holds: in MERGE_HOLD_REASONS and classified transient', () => {
    for (const reason of ['approval_given_while_draft', 'pr_approval_state_unknown']) {
      expect(MERGE_HOLD_REASONS.has(reason)).toBe(true);
      expect(classifyMergeSkip(reason)).toBe('transient');
    }
  });
});
