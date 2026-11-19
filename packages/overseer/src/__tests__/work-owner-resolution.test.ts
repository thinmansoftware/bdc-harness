import { describe, expect, test } from 'bun:test';
import {
  parseProvenanceComment,
  readOwnerRoutingMode,
  resolveWorkOwner,
  titleHasExactWoToken,
  WORK_OWNER_LOOKUP_TIMEOUT_MS,
  type WorkOwnerComment,
  type WorkOwnerOctokitLike,
  type WorkOwnerResolution,
  type WorkOwnerSearchItem,
} from '../owner-resolution';

// WO-HARNESS-OVERSEER-OWNER-ROUTING-01 Tests 1-3: resolveWorkOwner against a
// fake GitHub client (no network).

interface FakeIssue {
  number: number;
  title: string;
  state?: 'open' | 'closed';
  labels?: string[];
  pull_request?: boolean;
  comments?: WorkOwnerComment[];
}

function fakeClient(
  issues: FakeIssue[],
  behavior: 'answer' | 'throw' | 'hang' = 'answer'
): WorkOwnerOctokitLike & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    search: {
      issuesAndPullRequests: async input => {
        queries.push(input.q);
        if (behavior === 'throw') throw new Error('github unavailable');
        if (behavior === 'hang') return new Promise(() => undefined);
        const items: WorkOwnerSearchItem[] = issues.map(issue => ({
          number: issue.number,
          title: issue.title,
          state: issue.state ?? 'open',
          labels: (issue.labels ?? []).map(name => ({ name })),
          ...(issue.pull_request ? { pull_request: { url: 'x' } } : {}),
        }));
        return { data: { items } };
      },
    },
    issues: {
      listComments: async input => {
        const issue = issues.find(candidate => candidate.number === input.issue_number);
        const all = issue?.comments ?? [];
        const page = input.page ?? 1;
        const size = input.per_page ?? 100;
        return { data: all.slice((page - 1) * size, page * size) };
      },
    },
  };
}

function provenance(fields: { handle?: string; by?: string; at?: string; quote?: string }): string {
  return [
    fields.handle === undefined ? null : `Owner assigned: ${fields.handle}`,
    fields.by === undefined ? null : `Assigned by: ${fields.by}`,
    fields.at === undefined ? null : `Assigned at: ${fields.at}`,
    fields.quote === undefined ? null : `Quote: ${fields.quote}`,
  ]
    .filter(line => line !== null)
    .join('\n');
}

const COMPLETE = provenance({
  handle: 'codex',
  by: 'John Ranson',
  at: '2026-11-08',
  quote: 'codex owns this',
});

function expectNoXo(result: WorkOwnerResolution): void {
  const text = JSON.stringify(result).toLowerCase();
  expect(text).not.toContain('acting-xo');
  expect(text).not.toContain('"operator"');
  if (result.kind === 'owned') expect(result.owner.toLowerCase()).not.toBe('xo');
}

describe('Test 1: exact title token', () => {
  test('WO-X-01 never selects WO-X-01-REPAIR-01', async () => {
    const client = fakeClient([
      { number: 11, title: 'WO-X-01-REPAIR-01', labels: ['owner:cursor'] },
      {
        number: 12,
        title: 'WO-X-01: summary',
        labels: ['owner:codex'],
        comments: [{ body: COMPLETE, created_at: '2026-11-08T10:00:00Z' }],
      },
    ]);
    const result = await resolveWorkOwner({ woId: 'WO-X-01' }, { client });
    expect(result).toEqual({
      kind: 'owned',
      owner: 'codex',
      assigned_by: 'John Ranson',
      assigned_at: '2026-11-08',
      quote: 'codex owns this',
      source_issue: 'thinmansoftware/bdc-xo#12',
    });
    expect(client.queries[0]).toContain('repo:thinmansoftware/bdc-xo');
    expect(client.queries[0]).toContain('is:issue');
  });

  test('a bare WO-X-01 title matches; the REPAIR title alone is no_issue', async () => {
    expect(titleHasExactWoToken('WO-X-01', 'WO-X-01')).toBe(true);
    expect(titleHasExactWoToken('WO-X-01: summary', 'WO-X-01')).toBe(true);
    expect(titleHasExactWoToken('WO-X-01-REPAIR-01', 'WO-X-01')).toBe(false);
    const result = await resolveWorkOwner(
      { woId: 'WO-X-01' },
      { client: fakeClient([{ number: 11, title: 'WO-X-01-REPAIR-01' }]) }
    );
    expect(result).toEqual({ kind: 'unowned', reason: 'no_issue', source_issue: null });
  });

  test('pull requests are not WO issues; open wins over closed', async () => {
    const result = await resolveWorkOwner(
      { woId: 'WO-X-01' },
      {
        client: fakeClient([
          { number: 20, title: 'WO-X-01 build', pull_request: true, labels: ['owner:grok'] },
          { number: 21, title: 'WO-X-01 old', state: 'closed', labels: ['owner:grok'] },
          { number: 22, title: 'WO-X-01', labels: [] },
        ]),
      }
    );
    expect(result).toEqual({
      kind: 'unowned',
      reason: 'no_owner_label',
      source_issue: 'thinmansoftware/bdc-xo#22',
    });
  });
});

describe('Test 2: failure paths never default to XO', () => {
  test('(a) no matching issue -> no_issue', async () => {
    const result = await resolveWorkOwner({ woId: 'WO-X-01' }, { client: fakeClient([]) });
    expect(result).toEqual({ kind: 'unowned', reason: 'no_issue', source_issue: null });
    expectNoXo(result);
  });

  test('(b) two open matching issues -> multiple_issues', async () => {
    const result = await resolveWorkOwner(
      { woId: 'WO-X-01' },
      {
        client: fakeClient([
          { number: 1, title: 'WO-X-01', labels: ['owner:codex'] },
          { number: 2, title: 'WO-X-01 duplicate', labels: ['owner:codex'] },
        ]),
      }
    );
    expect(result).toEqual({ kind: 'unowned', reason: 'multiple_issues', source_issue: null });
    expectNoXo(result);
  });

  test('(c) no owner label -> no_owner_label', async () => {
    const result = await resolveWorkOwner(
      { woId: 'WO-X-01' },
      { client: fakeClient([{ number: 3, title: 'WO-X-01', labels: ['wo', 'P1'] }]) }
    );
    expect(result).toEqual({
      kind: 'unowned',
      reason: 'no_owner_label',
      source_issue: 'thinmansoftware/bdc-xo#3',
    });
    expectNoXo(result);
  });

  test('(d) two owner labels -> multiple_owner_labels', async () => {
    const result = await resolveWorkOwner(
      { woId: 'WO-X-01' },
      {
        client: fakeClient([
          {
            number: 4,
            title: 'WO-X-01',
            labels: ['owner:codex', 'owner:cursor'],
            comments: [{ body: COMPLETE, created_at: '2026-11-08T10:00:00Z' }],
          },
        ]),
      }
    );
    expect(result).toEqual({
      kind: 'unowned',
      reason: 'multiple_owner_labels',
      source_issue: 'thinmansoftware/bdc-xo#4',
    });
    expectNoXo(result);
  });

  test('(e) a client that throws -> lookup_failed', async () => {
    const result = await resolveWorkOwner({ woId: 'WO-X-01' }, { client: fakeClient([], 'throw') });
    expect(result).toEqual({ kind: 'unowned', reason: 'lookup_failed', source_issue: null });
    expectNoXo(result);
  });

  test('(f) a client that never answers -> lookup_failed within the 5-second bound', async () => {
    expect(WORK_OWNER_LOOKUP_TIMEOUT_MS).toBe(5_000);
    const started = Date.now();
    const result = await resolveWorkOwner({ woId: 'WO-X-01' }, { client: fakeClient([], 'hang') });
    const elapsed = Date.now() - started;
    expect(result).toEqual({ kind: 'unowned', reason: 'lookup_failed', source_issue: null });
    expect(elapsed).toBeLessThan(WORK_OWNER_LOOKUP_TIMEOUT_MS + 1_000);
    expectNoXo(result);
  }, 15_000);

  test('an owner:xo label is only an owner with provenance (M-93 clause 3)', async () => {
    const without = await resolveWorkOwner(
      { woId: 'WO-X-01' },
      { client: fakeClient([{ number: 5, title: 'WO-X-01', labels: ['owner:xo'] }]) }
    );
    expect(without).toEqual({
      kind: 'unowned',
      reason: 'owner_label_without_provenance',
      source_issue: 'thinmansoftware/bdc-xo#5',
    });
    const withRecord = await resolveWorkOwner(
      { woId: 'WO-X-01' },
      {
        client: fakeClient([
          {
            number: 5,
            title: 'WO-X-01',
            labels: ['owner:xo'],
            comments: [
              {
                body: provenance({
                  handle: 'xo',
                  by: 'John Ranson',
                  at: '2026-11-08',
                  quote: 'XO owns it',
                }),
                created_at: '2026-11-08T10:00:00Z',
              },
            ],
          },
        ]),
      }
    );
    expect(withRecord.kind).toBe('owned');
    if (withRecord.kind === 'owned') expect(withRecord.owner).toBe('xo');
  });
});

describe('Test 3: provenance strictness', () => {
  function issueWith(comments: WorkOwnerComment[]): WorkOwnerOctokitLike {
    return fakeClient([{ number: 4321, title: 'WO-X-01', labels: ['owner:codex'], comments }]);
  }

  test('(a) no comment -> owner_label_without_provenance', async () => {
    expect(await resolveWorkOwner({ woId: 'WO-X-01' }, { client: issueWith([]) })).toEqual({
      kind: 'unowned',
      reason: 'owner_label_without_provenance',
      source_issue: 'thinmansoftware/bdc-xo#4321',
    });
  });

  test('(b) a comment missing the Quote line does not count', async () => {
    const result = await resolveWorkOwner(
      { woId: 'WO-X-01' },
      {
        client: issueWith([
          {
            body: provenance({ handle: 'codex', by: 'John Ranson', at: '2026-11-08' }),
            created_at: '2026-11-08T10:00:00Z',
          },
        ]),
      }
    );
    expect(result).toEqual({
      kind: 'unowned',
      reason: 'owner_label_without_provenance',
      source_issue: 'thinmansoftware/bdc-xo#4321',
    });
  });

  test('(c) a complete comment -> owned with its fields', async () => {
    const result = await resolveWorkOwner(
      { woId: 'WO-X-01' },
      { client: issueWith([{ body: COMPLETE, created_at: '2026-11-08T10:00:00Z' }]) }
    );
    expect(result).toEqual({
      kind: 'owned',
      owner: 'codex',
      assigned_by: 'John Ranson',
      assigned_at: '2026-11-08',
      quote: 'codex owns this',
      source_issue: 'thinmansoftware/bdc-xo#4321',
    });
  });

  test('(c)+(d) the newer complete comment wins', async () => {
    const newer = provenance({
      handle: 'Codex',
      by: 'T3 Board thread for John Ranson',
      at: '2026-11-08T15:30:00Z',
      quote: 'reassigned to codex',
    });
    const result = await resolveWorkOwner(
      { woId: 'WO-X-01' },
      {
        client: issueWith([
          { body: COMPLETE, created_at: '2026-11-08T10:00:00Z' },
          { body: newer, created_at: '2026-11-08T15:30:00Z' },
          // A newer but INCOMPLETE record does not displace a complete one.
          {
            body: provenance({ handle: 'codex', by: 'someone' }),
            created_at: '2026-11-08T16:00:00Z',
          },
          // A complete record for a different handle is ignored.
          {
            body: provenance({ handle: 'cursor', by: 'x', at: '2026-11-09', quote: 'y' }),
            created_at: '2026-11-09T00:00:00Z',
          },
        ]),
      }
    );
    expect(result).toEqual({
      kind: 'owned',
      owner: 'codex',
      assigned_by: 'T3 Board thread for John Ranson',
      assigned_at: '2026-11-08T15:30:00Z',
      quote: 'reassigned to codex',
      source_issue: 'thinmansoftware/bdc-xo#4321',
    });
  });

  test('the newest record is found past the first comment page', async () => {
    const filler: WorkOwnerComment[] = Array.from({ length: 150 }, (_, index) => ({
      body: `note ${index}`,
      created_at: `2026-11-0${index < 100 ? 1 : 2}T00:00:00Z`,
    }));
    const result = await resolveWorkOwner(
      { woId: 'WO-X-01' },
      { client: issueWith([...filler, { body: COMPLETE, created_at: '2026-11-08T10:00:00Z' }]) }
    );
    expect(result.kind).toBe('owned');
  });

  test('parseProvenanceComment rejects a bad date', () => {
    expect(
      parseProvenanceComment(
        provenance({ handle: 'codex', by: 'John', at: 'yesterday', quote: 'q' })
      )
    ).toBeNull();
    expect(
      parseProvenanceComment(
        provenance({ handle: 'codex', by: 'John', at: '2026-11-08', quote: 'q' })
      )
    ).toEqual({ handle: 'codex', assigned_by: 'John', assigned_at: '2026-11-08', quote: 'q' });
  });
});

describe('readOwnerRoutingMode', () => {
  test('only the exact strings shadow and on are recognized', () => {
    expect(readOwnerRoutingMode(undefined)).toBe('off');
    expect(readOwnerRoutingMode('ON ')).toBe('off');
    expect(readOwnerRoutingMode('On')).toBe('off');
    expect(readOwnerRoutingMode('off')).toBe('off');
    expect(readOwnerRoutingMode('shadow')).toBe('shadow');
    expect(readOwnerRoutingMode('on')).toBe('on');
  });
});
