import { describe, expect, test } from 'bun:test';
import { buildBlockedPrCard } from '../build-card';
import type { GitHubSnapshot } from '../sources/github';
import { readGitHub } from '../sources/github';
import { readEventStore } from '../sources/event-store';
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
  test('findings are empty when a later exact-head review approves', async () => {
    const requested = {
      ...approved,
      state: 'CHANGES_REQUESTED',
      submitted_at: '1',
      body: '- stale finding',
    };
    const card = await buildBlockedPrCard(
      'thinmansoftware/bdc-harness#1',
      deps({ reviews: [requested, approved] })
    );
    expect(card.blocker_class).toBe('merge_ready');
    expect(card.findings).toEqual([]);
  });
  test('pending commit status is checks pending', async () => {
    const card = await buildBlockedPrCard(
      'thinmansoftware/bdc-harness#1',
      deps({ checkRuns: [], statuses: [{ context: 'deploy', state: 'pending' }] })
    );
    expect(card.blocker_class).toBe('checks_pending');
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
  test('check runs and commit statuses are paginated', async () => {
    const client: any = {
      pulls: {
        get: async () => ({
          data: {
            ...fixture,
            body: 'closes #1',
            html_url: fixture.url,
            head: { sha: fixture.head_sha, ref: fixture.head_ref },
            base: { ref: 'dev' },
            user: { login: 'author' },
          },
        }),
        listReviews: async () => ({ data: [] }),
      },
      checks: {
        listForRef: async ({ page }: { page: number }) => ({
          data: {
            check_runs:
              page === 1
                ? Array.from({ length: 100 }, (_, index) => ({
                    name: `check-${index}`,
                    status: 'completed',
                    conclusion: 'success',
                  }))
                : [{ name: 'late-failure', status: 'completed', conclusion: 'failure' }],
          },
        }),
      },
      repos: {
        listCommitStatusesForRef: async ({ page }: { page: number }) => ({
          data:
            page === 1
              ? Array.from({ length: 100 }, (_, index) => ({
                  context: `status-${index}`,
                  state: 'success',
                }))
              : [{ context: 'late-pending', state: 'pending' }],
        }),
        getAllStatusCheckContexts: async () => ({ data: [] }),
      },
      issues: { get: async () => ({ data: {} }) },
    };
    const result = await readGitHub('thinmansoftware', 'bdc-harness', 1, client);
    expect(result.status).toBe('ok');
    expect(result.checkRuns.some(check => check.name === 'late-failure')).toBe(true);
    expect(result.statuses.some(status => status.context === 'late-pending')).toBe(true);
  });
  test('9 request cap degrades without an eleventh request', async () => {
    const calls: string[] = [];
    const client: any = {
      pulls: {
        get: async () => {
          calls.push('GET pull');
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
          calls.push('GET reviews');
          return { data: Array.from({ length: 100 }, () => approved) };
        },
      },
    };
    const result = await readGitHub('thinmansoftware', 'bdc-harness', 1, client);
    expect(calls).toHaveLength(10);
    expect(calls.every(call => call.startsWith('GET '))).toBe(true);
    expect(result.status).toContain('request cap exceeded');

    const statements: string[] = [];
    const database: any = {
      query: async (sql: string) => {
        statements.push(sql.trim());
        if (!sql.trimStart().toUpperCase().startsWith('SELECT'))
          throw new Error('database fake permits SELECT only');
        return { rows: [] };
      },
    };
    const events = await readEventStore(
      { owner: 'thinmansoftware', repo: 'bdc-harness', number: 1, headRef: 'repair/ref' },
      database
    );
    expect(events).toEqual({ runs: [], status: 'ok' });
    expect(statements).toHaveLength(1);
    expect(statements[0]?.toUpperCase().startsWith('SELECT')).toBe(true);
  });
});
