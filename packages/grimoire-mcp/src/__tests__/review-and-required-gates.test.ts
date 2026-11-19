// Overseer #1294 repair findings: a non-approving exact-head Overseer review and
// incomplete required-context evidence must never yield merge_ready. Every case
// runs through the real callers (readGitHub + buildBlockedPrCard), not injected verdicts.
import { beforeEach, describe, expect, test } from 'bun:test';
import {
  resetRequiredContextsAttemptCounters,
  resetRequiredContextsCache,
} from '@archon/overseer/adapters/required-contexts';
import { buildBlockedPrCard } from '../build-card';
import { readGitHub } from '../sources/github';
import fixture from './fixtures/base.json';

const ref = 'thinmansoftware/bdc-harness#1';
const review = (state: string): Record<string, unknown> => ({
  user: { login: 'thinman-overseer[bot]' },
  state,
  commit_id: fixture.head_sha,
  submitted_at: '2026-01-01T00:00:02Z',
  body: '',
});

interface FakeOptions {
  reviews?: Record<string, unknown>[];
  reviewPages?: number;
  checkRuns?: { name: string; status: string; conclusion: string | null }[];
  required?: string[] | Error;
}
function fakeClient(options: FakeOptions = {}): { client: unknown; calls: string[] } {
  const calls: string[] = [];
  const get = <T>(path: string, data: T): Promise<{ data: T }> => {
    calls.push(`GET ${path}`);
    return Promise.resolve({ data });
  };
  const reviews = options.reviews ?? [review('APPROVED')];
  const client = {
    pulls: {
      get: () =>
        get('pull', {
          ...fixture,
          html_url: fixture.url,
          // No WO token, so the required-context lookup is the last GitHub request.
          title: 'example without a work order',
          body: '',
          head: { sha: fixture.head_sha, ref: fixture.head_ref },
          base: { ref: 'dev' },
          user: { login: 'author' },
          mergeable: true,
        }),
      listReviews: ({ page }: { page: number }) =>
        get(
          'reviews',
          page < (options.reviewPages ?? 1)
            ? Array.from({ length: 100 }, () => review('COMMENTED'))
            : reviews
        ),
    },
    checks: {
      listForRef: () =>
        get('check-runs', {
          check_runs: options.checkRuns ?? [
            { name: 'test', status: 'completed', conclusion: 'success' },
          ],
        }),
    },
    repos: {
      listCommitStatusesForRef: () => get('statuses', []),
      getAllStatusCheckContexts: () => {
        calls.push('GET required-contexts');
        const required = options.required ?? ['test'];
        return required instanceof Error
          ? Promise.reject(required)
          : Promise.resolve({ data: required });
      },
    },
    search: { issuesAndPullRequests: () => get('search', { items: [] }) },
    issues: { get: () => get('issue', {}) },
  };
  return { client, calls };
}
async function card(options: FakeOptions = {}) {
  const fake = fakeClient(options);
  const built = await buildBlockedPrCard(ref, {
    github: (owner, repo, number) => readGitHub(owner, repo, number, fake.client),
    eventStore: async () => ({ runs: [], status: 'ok' }),
    taskmaster: async () => ({ recipient: null, status: 'ok' }),
    now: () => new Date('2026-01-01T00:00:00Z'),
  });
  return { card: built, calls: fake.calls };
}

beforeEach(() => {
  resetRequiredContextsCache();
  resetRequiredContextsAttemptCounters();
});

describe('exact-head Overseer review must approve before merge_ready', () => {
  for (const state of ['COMMENTED', 'DISMISSED']) {
    test(`${state} exact-head review with green checks is a review blocker`, async () => {
      const { card: built } = await card({ reviews: [review(state)] });
      expect(built.review.verdict).toBe(`latest Overseer review is ${state}`);
      expect(built.checks_verdict).toBe('OK');
      expect(built.blocker_class).toBe('no_review');
      expect(built.next_permitted_action.action).toBe('await-review');
      expect(built.next_permitted_action.text).toContain(state);
    });
  }
});

describe('required contexts gate merge readiness', () => {
  test('complete exact-head evidence with every required context green is merge_ready', async () => {
    const { card: built, calls } = await card();
    expect(built.sources.github).toBe('ok');
    expect(built.checks).toEqual([{ name: 'test', kind: 'run', state: 'success', required: true }]);
    expect(built.blocker_class).toBe('merge_ready');
    expect(built.next_permitted_action.action).toBe('merge');
    expect(calls.length).toBeLessThanOrEqual(10);
  });

  test('a required context that never reported blocks even when another check is green', async () => {
    const { card: built } = await card({ required: ['test', 'required-ci'] });
    expect(built.sources.github).toBe('ok');
    expect(built.checks_verdict).toBe('required checks not reported: required-ci');
    expect(built.checks).toContainEqual({
      name: 'required-ci',
      kind: 'run',
      state: 'missing',
      required: true,
    });
    expect(built.blocker_class).toBe('checks_pending');
    expect(built.next_permitted_action.action).toBe('wait-checks');
  });

  test('a red check still wins over a missing required context', async () => {
    const { card: built } = await card({
      required: ['test', 'required-ci'],
      checkRuns: [{ name: 'test', status: 'completed', conclusion: 'failure' }],
    });
    expect(built.checks_verdict).toBe(
      'checks not green: test=failure; required checks not reported: required-ci'
    );
    expect(built.blocker_class).toBe('checks_red');
  });

  test('a required-context lookup failure marks GitHub unavailable and never merge_ready', async () => {
    const failure = Object.assign(new Error('Server Error'), { status: 500 });
    const { card: built } = await card({ required: failure });
    expect(built.sources.github).toStartWith('unavailable: required contexts');
    expect(built.blocker_class).not.toBe('merge_ready');
    expect(built.next_permitted_action.action).not.toBe('merge');
  });

  test('request-cap exhaustion during the required-context lookup is unavailable, not ok', async () => {
    // pull + 7 review pages + check-runs + statuses = 10 requests; the lookup is the 11th.
    const { card: built, calls } = await card({ reviewPages: 7 });
    expect(calls).toHaveLength(10);
    expect(calls).not.toContain('GET required-contexts');
    expect(built.sources.github).toContain('request cap exceeded');
    expect(built.blocker_class).not.toBe('merge_ready');
    expect(built.next_permitted_action.action).not.toBe('merge');
  });
});
