import { describe, expect, test } from 'bun:test';
import { buildBlockedPrCard } from '../build-card';
import type { GitHubSnapshot } from '../sources/github';
import { readGitHub } from '../sources/github';
import fixture from './fixtures/base.json';

const approved = {
  user: { login: 'thinman-overseer[bot]' },
  state: 'APPROVED',
  commit_id: fixture.head_sha,
  submitted_at: '2',
  body: '',
};
function deps(overrides: Partial<GitHubSnapshot> = {}, event: any = { runs: [], status: 'ok' }) {
  const github: GitHubSnapshot = {
    pr: { ...fixture },
    reviews: [approved],
    checkRuns: [{ name: 'test', status: 'completed', conclusion: 'success' }],
    statuses: [],
    checks: [{ name: 'test', kind: 'run', state: 'success', required: true }],
    woId: 'WO-XO-EXAMPLE-01',
    issue: 3258,
    issueAssignee: 'codex-seat',
    status: 'ok',
    ...overrides,
  };
  return {
    github: async () => github,
    eventStore: async () => event,
    taskmaster: async () => ({ recipient: null, status: 'ok' as const }),
    now: () => new Date('2026-01-01T00:00:00Z'),
  };
}
describe('card composition', () => {
  test('4 failed cauldron run overrides no review', async () => {
    const run = {
      id: '123456789',
      workflow: 'w',
      status: 'failed',
      started_at: 'x',
      failing_node: 'checkout-repair-target',
      error_line: 'Bash node failed',
    };
    const card = await buildBlockedPrCard(
      'thinmansoftware/bdc-harness#1',
      deps({ reviews: [] }, { runs: [run], status: 'ok' })
    );
    expect(card.blocker_class).toBe('cauldron_run_failed');
    expect(card.next_permitted_action.text).toContain('checkout-repair-target');
  });
  test('5 merge ready resolves issue owner', async () => {
    const card = await buildBlockedPrCard('thinmansoftware/bdc-harness#1', deps());
    expect(card.blocker_class).toBe('merge_ready');
    expect(card.owner).toEqual({ who: 'codex-seat', source: 'issue_assignee' });
    expect(card.wo.issue).toBe(3258);
  });
  test('findings use first ten list lines', async () => {
    const review = { ...approved, state: 'CHANGES_REQUESTED', body: '- one\ntext\n2. two' };
    const card = await buildBlockedPrCard(
      'thinmansoftware/bdc-harness#1',
      deps({ reviews: [review] })
    );
    expect(card.findings).toEqual(['- one', '2. two']);
  });
  test('11 event store unavailable degrades', async () => {
    const card = await buildBlockedPrCard(
      'thinmansoftware/bdc-harness#1',
      deps({}, { runs: [], status: 'unavailable: SQLITE_CANTOPEN' })
    );
    expect(card.sources.event_store).toContain('unavailable:');
    expect(card.blocker_class).toBe('merge_ready');
  });
  test('bad ref rejects', () =>
    expect(buildBlockedPrCard('bad', deps())).rejects.toThrow('owner/repo#N'));
  test('9 request cap degrades without an eleventh request', async () => {
    let calls = 0;
    const client: any = {
      pulls: {
        get: async () => {
          calls += 1;
          return {
            data: {
              ...fixture,
              html_url: fixture.url,
              head: { sha: fixture.head_sha, ref: fixture.head_ref },
              base: { ref: 'dev' },
              user: { login: 'author' },
            },
          };
        },
        listReviews: async () => {
          calls += 1;
          return { data: Array.from({ length: 100 }, () => approved) };
        },
      },
    };
    const result = await readGitHub('thinmansoftware', 'bdc-harness', 1, client);
    expect(calls).toBe(10);
    expect(result.status).toContain('request cap exceeded');
  });
});
