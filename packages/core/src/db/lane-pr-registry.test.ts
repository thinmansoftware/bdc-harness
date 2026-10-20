/**
 * lane-pr-registry.test.ts -- WO-HARNESS-PR-REPAIR-OWNER-AND-DEDUPE-01.
 *
 * Test 7: lane_pr_registry_attributes_by_run_window. Also exercises
 * listWosWithMultipleLanePrs (supports Tests 4, 5, 12, 13 in the owner suite).
 *
 * No network, no real GitHub, no production DB: an in-memory bun:sqlite holds
 * the two event-store tables and the GitHub fetcher is a fake.
 */
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  listLanePrsForWo,
  listWosWithMultipleLanePrs,
  type LanePrRegistryDb,
  type LanePrGithubInfo,
} from './lane-pr-registry';

const WO_DIGEST = 'WO-XO-CE-HEALTH-DIGEST-01';
const WO_TRIAL = 'WO-SHOPOPS-OWNER-ALERT-TRIAL-STATE-01';

test('registry propagates an attributed PR lookup failure', async () => {
  const { db, sqlite } = makeDb();
  seedE1E2(sqlite);
  try {
    let failure: unknown;
    try {
      await listLanePrsForWo(WO_DIGEST, {
        db,
        fetchPr: async () => {
          throw new Error('github_unavailable');
        },
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('github_unavailable');
  } finally {
    sqlite.close();
  }
});

/** Wrap an in-memory bun:sqlite as the read-only LanePrRegistryDb surface. */
function makeDb(): { db: LanePrRegistryDb; sqlite: Database } {
  const sqlite = new Database(':memory:');
  sqlite.run(
    `CREATE TABLE remote_agent_workflow_runs (
       id TEXT PRIMARY KEY,
       workflow_name TEXT,
       status TEXT,
       started_at TEXT,
       completed_at TEXT,
       user_message TEXT
     )`
  );
  sqlite.run(
    `CREATE TABLE remote_agent_workflow_events (
       id TEXT PRIMARY KEY,
       workflow_run_id TEXT,
       event_type TEXT,
       step_index INTEGER,
       step_name TEXT,
       data TEXT,
       created_at TEXT
     )`
  );
  const db: LanePrRegistryDb = {
    async query<T>(sql: string, params: unknown[] = []): Promise<{ rows: T[]; rowCount: number }> {
      const translated = sql.replace(/\$\d+/g, '?');
      const rows = sqlite.query(translated).all(...(params as never[])) as T[];
      return { rows, rowCount: rows.length };
    },
  };
  return { db, sqlite };
}

let eventSeq = 0;
function seedRun(
  sqlite: Database,
  run: { id: string; workflow: string; woId: string; startedAt: string; completedAt: string | null }
): void {
  sqlite.run(
    `INSERT INTO remote_agent_workflow_runs (id, workflow_name, status, started_at, completed_at, user_message)
     VALUES (?, ?, 'completed', ?, ?, ?)`,
    [
      run.id,
      run.workflow,
      run.startedAt,
      run.completedAt,
      `WO_ID=${run.woId} --project ${run.woId.includes('SHOPOPS') ? 'shopops' : 'bdc-xo'}\nwork`,
    ]
  );
}
function seedEvent(
  sqlite: Database,
  runId: string,
  stepName: string,
  prUrl: string,
  eventType = 'node_completed'
): void {
  eventSeq += 1;
  sqlite.run(
    `INSERT INTO remote_agent_workflow_events (id, workflow_run_id, event_type, step_index, step_name, data, created_at)
     VALUES (?, ?, ?, 0, ?, ?, '2026-10-14T00:00:00Z')`,
    [`evt-${eventSeq}`, runId, eventType, stepName, JSON.stringify({ output: `opened ${prUrl}` })]
  );
}

/** Fake GitHub PR info table keyed by owner/repo#N. */
function makeFetcher(table: Record<string, LanePrGithubInfo>) {
  return async (owner: string, repo: string, prNumber: number): Promise<LanePrGithubInfo | null> =>
    table[`${owner}/${repo}#${prNumber}`] ?? null;
}

function bdcXoPr(
  n: number,
  headRefName: string,
  createdAt: string,
  extra?: Partial<LanePrGithubInfo>
): LanePrGithubInfo {
  return {
    number: n,
    state: 'OPEN',
    reviewDecision: 'CHANGES_REQUESTED',
    createdAt,
    headRefName,
    headSha: `sha-${n}`,
    headRepoFullName: 'thinmansoftware/bdc-xo',
    baseRepoFullName: 'thinmansoftware/bdc-xo',
    title: `Implement ${WO_DIGEST}`,
    body: `Closes work order ${WO_DIGEST}.`,
    ...extra,
  };
}

function shopopsPr(n: number, headRefName: string, createdAt: string): LanePrGithubInfo {
  return {
    number: n,
    state: 'OPEN',
    reviewDecision: 'CHANGES_REQUESTED',
    createdAt,
    headRefName,
    headSha: `sha-${n}`,
    headRepoFullName: 'thinmansoftware/shopops',
    baseRepoFullName: 'thinmansoftware/shopops',
    title: `Implement ${WO_TRIAL}`,
    body: `Addresses ${WO_TRIAL}.`,
  };
}

function seedE1E2(sqlite: Database): void {
  // E1: two bdc-xo runs for the digest WO.
  seedRun(sqlite, {
    id: 'a59f9ba5',
    workflow: 'bdc-feature-development-codex',
    woId: WO_DIGEST,
    startedAt: '2026-10-14T01:41:00Z',
    completedAt: '2026-10-14T01:59:08Z',
  });
  seedEvent(sqlite, 'a59f9ba5', 'implement', 'https://github.com/thinmansoftware/bdc-xo/pull/3170');
  seedEvent(
    sqlite,
    'a59f9ba5',
    'open-pr-if-needed',
    'https://github.com/thinmansoftware/bdc-xo/pull/3171'
  );
  // Decoy longer number and an older PR citation on the same run.
  seedEvent(
    sqlite,
    'a59f9ba5',
    'implement',
    'https://github.com/thinmansoftware/bdc-xo/pull/31700'
  );
  seedEvent(sqlite, 'a59f9ba5', 'implement', 'https://github.com/thinmansoftware/bdc-xo/pull/999');

  seedRun(sqlite, {
    id: '66d6413f',
    workflow: 'bdc-feature-development',
    woId: WO_DIGEST,
    startedAt: '2026-10-14T01:59:37Z',
    completedAt: '2026-10-14T02:27:42Z',
  });
  seedEvent(
    sqlite,
    '66d6413f',
    'open-pr-if-needed',
    'https://github.com/thinmansoftware/bdc-xo/pull/3172'
  );

  // E2: shopops codex run with two citations.
  seedRun(sqlite, {
    id: 'fd480676',
    workflow: 'bdc-feature-development-codex',
    woId: WO_TRIAL,
    startedAt: '2026-10-14T10:39:08Z',
    completedAt: '2026-10-14T10:49:42Z',
  });
  seedEvent(sqlite, 'fd480676', 'implement', 'https://github.com/thinmansoftware/shopops/pull/870');
  seedEvent(
    sqlite,
    'fd480676',
    'open-pr-if-needed',
    'https://github.com/thinmansoftware/shopops/pull/871'
  );
}

function digestFetcher() {
  return makeFetcher({
    'thinmansoftware/bdc-xo#3170': bdcXoPr(
      3170,
      'archon/task-web-worker-1791942058899-p0vevc',
      '2026-10-14T01:50:02Z'
    ),
    'thinmansoftware/bdc-xo#3171': bdcXoPr(
      3171,
      'feat/wo-xo-ce-health-digest-01-thread-f7a2e0ec',
      '2026-10-14T01:59:02Z'
    ),
    'thinmansoftware/bdc-xo#3172': bdcXoPr(
      3172,
      'feat/wo-xo-ce-health-digest-01-thread-1b945ae4',
      '2026-10-14T02:27:34Z'
    ),
    // Older PR: created far outside any run window -> rule (b) fails.
    'thinmansoftware/bdc-xo#999': bdcXoPr(
      999,
      'feat/wo-xo-ce-health-digest-01-older',
      '2026-01-01T00:00:00Z'
    ),
    // 31700 intentionally absent: the fetcher returns null for it.
    'thinmansoftware/shopops#870': shopopsPr(
      870,
      'archon/task-web-worker-1791974346514-rdwhxp',
      '2026-10-14T10:44:52Z'
    ),
    'thinmansoftware/shopops#871': shopopsPr(
      871,
      'feat/wo-shopops-owner-alert-trial-state-01-thread-4c737340',
      '2026-10-14T10:49:30Z'
    ),
  });
}

describe('lane-pr-registry', () => {
  test('Test 7: lane_pr_registry_attributes_by_run_window', async () => {
    const { db, sqlite } = makeDb();
    seedE1E2(sqlite);
    const fetchPr = digestFetcher();
    const now = (): number => Date.parse('2026-10-14T12:00:00Z');

    const digest = await listLanePrsForWo(WO_DIGEST, { db, fetchPr, now });
    expect(digest.map(p => p.prNumber).sort((a, b) => a - b)).toEqual([3170, 3171, 3172]);

    const trial = await listLanePrsForWo(WO_TRIAL, { db, fetchPr, now });
    expect(trial.map(p => p.prNumber).sort((a, b) => a - b)).toEqual([870, 871]);

    // Exclusions: the decoy 31700 and the older PR never appear.
    expect(digest.some(p => p.prNumber === 31700)).toBe(false);
    expect(digest.some(p => p.prNumber === 999)).toBe(false);

    // Attribution carries the run id and workflow name that proved it.
    const pr3171 = digest.find(p => p.prNumber === 3171);
    expect(pr3171?.runId).toBe('a59f9ba5');
    expect(pr3171?.workflowName).toBe('bdc-feature-development-codex');
    expect(pr3171?.headRef).toBe('feat/wo-xo-ce-health-digest-01-thread-f7a2e0ec');
  });

  test('a cross-repo (fork) head is not lane-created', async () => {
    const { db, sqlite } = makeDb();
    seedRun(sqlite, {
      id: 'run-fork',
      workflow: 'bdc-feature-development-codex',
      woId: WO_DIGEST,
      startedAt: '2026-10-14T01:41:00Z',
      completedAt: '2026-10-14T01:59:08Z',
    });
    seedEvent(
      sqlite,
      'run-fork',
      'implement',
      'https://github.com/thinmansoftware/bdc-xo/pull/5000'
    );
    const fetchPr = makeFetcher({
      'thinmansoftware/bdc-xo#5000': bdcXoPr(
        5000,
        'feat/wo-xo-ce-health-digest-01-fork',
        '2026-10-14T01:50:00Z',
        { headRepoFullName: 'someforker/bdc-xo' }
      ),
    });
    const result = await listLanePrsForWo(WO_DIGEST, {
      db,
      fetchPr,
      now: () => Date.parse('2026-10-14T12:00:00Z'),
    });
    expect(result).toHaveLength(0);
  });

  test('a null head-repo (unprovable same-repo) is not lane-created', async () => {
    const { db, sqlite } = makeDb();
    seedRun(sqlite, {
      id: 'run-nullhead',
      workflow: 'bdc-feature-development-codex',
      woId: WO_DIGEST,
      startedAt: '2026-10-14T01:41:00Z',
      completedAt: '2026-10-14T01:59:08Z',
    });
    seedEvent(
      sqlite,
      'run-nullhead',
      'implement',
      'https://github.com/thinmansoftware/bdc-xo/pull/5100'
    );
    const fetchPr = makeFetcher({
      'thinmansoftware/bdc-xo#5100': bdcXoPr(
        5100,
        'feat/wo-xo-ce-health-digest-01-nullhead',
        '2026-10-14T01:50:00Z',
        { headRepoFullName: null }
      ),
    });
    const result = await listLanePrsForWo(WO_DIGEST, {
      db,
      fetchPr,
      now: () => Date.parse('2026-10-14T12:00:00Z'),
    });
    expect(result).toHaveLength(0);
  });

  test('a case-variant same-repo head is still lane-created', async () => {
    const { db, sqlite } = makeDb();
    seedRun(sqlite, {
      id: 'run-casehead',
      workflow: 'bdc-feature-development-codex',
      woId: WO_DIGEST,
      startedAt: '2026-10-14T01:41:00Z',
      completedAt: '2026-10-14T01:59:08Z',
    });
    seedEvent(
      sqlite,
      'run-casehead',
      'implement',
      'https://github.com/thinmansoftware/bdc-xo/pull/5200'
    );
    const fetchPr = makeFetcher({
      'thinmansoftware/bdc-xo#5200': bdcXoPr(
        5200,
        'feat/wo-xo-ce-health-digest-01-case',
        '2026-10-14T01:50:00Z',
        { headRepoFullName: 'ThinmanSoftware/BDC-XO' }
      ),
    });
    const result = await listLanePrsForWo(WO_DIGEST, {
      db,
      fetchPr,
      now: () => Date.parse('2026-10-14T12:00:00Z'),
    });
    expect(result).toHaveLength(1);
  });

  test('a wo/ spec-branch head is never lane-created', async () => {
    const { db, sqlite } = makeDb();
    seedRun(sqlite, {
      id: 'run-spec',
      workflow: 'bdc-feature-development-codex',
      woId: WO_DIGEST,
      startedAt: '2026-10-14T01:41:00Z',
      completedAt: '2026-10-14T01:59:08Z',
    });
    seedEvent(
      sqlite,
      'run-spec',
      'implement',
      'https://github.com/thinmansoftware/bdc-xo/pull/6000'
    );
    const fetchPr = makeFetcher({
      'thinmansoftware/bdc-xo#6000': bdcXoPr(
        6000,
        'wo/wo-xo-ce-health-digest-01',
        '2026-10-14T01:50:00Z'
      ),
    });
    const result = await listLanePrsForWo(WO_DIGEST, {
      db,
      fetchPr,
      now: () => Date.parse('2026-10-14T12:00:00Z'),
    });
    expect(result).toHaveLength(0);
  });

  test('listWosWithMultipleLanePrs returns only WOs with 2+ lane PRs', async () => {
    const { db, sqlite } = makeDb();
    seedE1E2(sqlite);
    const fetchPr = digestFetcher();
    const wos = (
      await listWosWithMultipleLanePrs({
        db,
        fetchPr,
        now: () => Date.parse('2026-10-14T12:00:00Z'),
        withinHours: 168,
      })
    ).groups;
    const digest = wos.find(w => w.woId === WO_DIGEST);
    const trial = wos.find(w => w.woId === WO_TRIAL);
    expect(digest?.prs.map(p => p.prNumber).sort((a, b) => a - b)).toEqual([3170, 3171, 3172]);
    expect(trial?.prs.map(p => p.prNumber).sort((a, b) => a - b)).toEqual([870, 871]);
  });

  test('fetch_failure_isolated_per_wo_group', async () => {
    const woA = 'WO-HARNESS-FETCH-FAIL-A-01';
    const woB = 'WO-HARNESS-FETCH-FAIL-B-01';
    const { db, sqlite } = makeDb();
    const now = (): number => Date.parse('2026-10-14T12:00:00Z');
    // The resolvable sibling is inserted first so a partial result would leak
    // if the failed group were not dropped after the later throw.
    seedRun(sqlite, {
      id: 'run-a',
      workflow: 'bdc-feature-development',
      woId: woA,
      startedAt: '2026-10-14T01:00:00Z',
      completedAt: '2026-10-14T02:00:00Z',
    });
    seedEvent(sqlite, 'run-a', 'implement', 'https://github.com/thinmansoftware/bdc-xo/pull/102');
    seedEvent(
      sqlite,
      'run-a',
      'open-pr-if-needed',
      'https://github.com/thinmansoftware/bdc-xo/pull/101'
    );
    seedRun(sqlite, {
      id: 'run-b',
      workflow: 'bdc-feature-development',
      woId: woB,
      startedAt: '2026-10-14T01:00:00Z',
      completedAt: '2026-10-14T02:00:00Z',
    });
    seedEvent(sqlite, 'run-b', 'implement', 'https://github.com/thinmansoftware/shopops/pull/201');
    seedEvent(
      sqlite,
      'run-b',
      'open-pr-if-needed',
      'https://github.com/thinmansoftware/shopops/pull/202'
    );

    const info = (
      owner: string,
      repo: string,
      n: number,
      woId: string,
      headRefName: string
    ): LanePrGithubInfo => ({
      number: n,
      state: 'OPEN',
      reviewDecision: 'CHANGES_REQUESTED',
      createdAt: '2026-10-14T01:20:00Z',
      headRefName,
      headSha: `sha-${n}`,
      headRepoFullName: `${owner}/${repo}`,
      baseRepoFullName: `${owner}/${repo}`,
      title: `Implement ${woId}`,
      body: `Closes ${woId}.`,
    });
    const table: Record<string, LanePrGithubInfo> = {
      'thinmansoftware/bdc-xo#102': info(
        'thinmansoftware',
        'bdc-xo',
        102,
        woA,
        'feat/wo-harness-fetch-fail-a-01-thread-102'
      ),
      'thinmansoftware/bdc-xo#101': info(
        'thinmansoftware',
        'bdc-xo',
        101,
        woA,
        'feat/wo-harness-fetch-fail-a-01-thread-101'
      ),
      'thinmansoftware/shopops#201': info(
        'thinmansoftware',
        'shopops',
        201,
        woB,
        'feat/wo-harness-fetch-fail-b-01-thread-201'
      ),
      'thinmansoftware/shopops#202': info(
        'thinmansoftware',
        'shopops',
        202,
        woB,
        'feat/wo-harness-fetch-fail-b-01-thread-202'
      ),
    };

    try {
      const result = await listWosWithMultipleLanePrs({
        db,
        now,
        withinHours: 168,
        fetchPr: async (owner, repo, prNumber) => {
          if (owner === 'thinmansoftware' && repo === 'bdc-xo' && prNumber === 101) {
            throw new Error('github_transient_failure');
          }
          return table[`${owner}/${repo}#${prNumber}`] ?? null;
        },
      });
      const woBGroup = result.groups.find(group => group.woId === woB);
      expect(woBGroup?.prs.map(pr => pr.prNumber).sort((a, b) => a - b)).toEqual([201, 202]);
      expect(result.groups.some(group => group.woId === woA)).toBe(false);
      expect(
        result.groups.some(group =>
          group.prs.some(pr => pr.prNumber === 101 || pr.prNumber === 102)
        )
      ).toBe(false);
      expect(result.unresolved).toEqual([
        {
          woId: woA,
          owner: 'thinmansoftware',
          repo: 'bdc-xo',
          prNumber: 101,
          error: 'github_transient_failure',
        },
      ]);
    } finally {
      sqlite.close();
    }
  });
});
