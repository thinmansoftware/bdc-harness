/**
 * WO-HARNESS-MERGE-OWNER-REWORKING-GUARD-01, rule (d), supporting tests.
 * Test 7 itself (one alert per PR and stray sha) lives in merge-owner-reworking.test.ts.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { removeTempDirWithRetry } from '@archon/core/test/temp-dir';
import { join } from 'path';
import { closeDatabase, getDatabase, getOperatorCard, resetDatabase } from '@archon/core/db';
import { UNOWNED_RESPONSIBLE_ACTOR } from '@archon/core/db/dispatch-routing';
import { rootLogger } from '@archon/paths';
import type { WorkOwnerResolution } from '../owner-resolution';
import {
  createGitHubMergedSource,
  createStrayBranchReader,
  extractWoId,
  parsePullRequestUrl,
  POST_MERGE_SWEEP_MAX_PAGES,
  runPostMergeStraySweepOnce,
  type BranchState,
  type GitHubMergedListOctokitLike,
  type MergedVerdictForSweep,
  type StrayBranchOctokitLike,
} from '../post-merge-stray-sweep';
import { runEscalation } from '../escalate';
import { postMergeSweepRepos, runOverseerService } from '../service.ts';

const PR = 'https://github.com/thinmansoftware/bdc-harness/pull/9';

function verdict(overrides: Partial<MergedVerdictForSweep> = {}): MergedVerdictForSweep {
  return {
    id: 'v-9',
    run_id: 'run-9',
    wo_id: 'WO-SWEEP-09',
    pr_url: PR,
    head_sha: 'aaaa1111',
    updated_at: '2026-11-08T10:00:00.000Z',
    ...overrides,
  };
}

function captureRootLogLines(): { lines: string[]; restore: () => void } {
  const streamSymbol = Object.getOwnPropertySymbols(rootLogger).find(
    symbol => symbol.description === 'pino.stream'
  );
  if (!streamSymbol) throw new Error('pino.stream symbol missing on rootLogger');
  const stream = (rootLogger as unknown as Record<symbol, { write: (line: string) => void }>)[
    streamSymbol
  ];
  const lines: string[] = [];
  const write = spyOn(stream, 'write').mockImplementation(line => {
    lines.push(String(line));
  });
  return { lines, restore: () => write.mockRestore() };
}

const neverEscalate = ((): never => {
  throw new Error('escalate must not be called');
}) as unknown as typeof runEscalation;

describe('stray branch reader', () => {
  function octokit(overrides: {
    getRef?: StrayBranchOctokitLike['git']['getRef'];
    get?: StrayBranchOctokitLike['pulls']['get'];
  }): StrayBranchOctokitLike {
    return {
      pulls: {
        get:
          overrides.get ??
          (async () => ({
            data: { head: { ref: 'fix/x', repo: { name: 'r', owner: { login: 'o' } } } },
          })),
      },
      git: {
        getRef: overrides.getRef ?? (async () => ({ data: { object: { sha: 'abc123' } } })),
      },
    };
  }

  test('reads the branch sha with the heads/ ref, and maps 404 to gone and other errors to unknown', async () => {
    const seen: Record<string, unknown>[] = [];
    const ok = createStrayBranchReader(
      octokit({
        getRef: async input => {
          seen.push(input);
          return { data: { object: { sha: 'abc123' } } };
        },
      })
    );
    expect(await ok.readBranch({ owner: 'o', repo: 'r', branch: 'wo/some-branch' })).toEqual({
      state: 'exists',
      sha: 'abc123',
    });
    expect(seen).toEqual([{ owner: 'o', repo: 'r', ref: 'heads/wo/some-branch' }]);

    const gone = createStrayBranchReader(
      octokit({
        getRef: async () => {
          throw Object.assign(new Error('Not Found'), { status: 404 });
        },
      })
    );
    expect(await gone.readBranch({ owner: 'o', repo: 'r', branch: 'b' })).toEqual({
      state: 'gone',
    });

    const rateLimited = createStrayBranchReader(
      octokit({
        getRef: async () => {
          throw Object.assign(new Error('rate limited'), { status: 403 });
        },
      })
    );
    expect(await rateLimited.readBranch({ owner: 'o', repo: 'r', branch: 'b' })).toEqual({
      state: 'unknown',
    });
  });

  test('a failed pull request lookup yields no head ref', async () => {
    const reader = createStrayBranchReader(
      octokit({
        get: async () => {
          throw new Error('boom');
        },
      })
    );
    expect(await reader.readPullRequestHead({ owner: 'o', repo: 'r', number: 1 })).toBeUndefined();
  });

  test('the head repository comes from the pull request, not the base repository (fork PR)', async () => {
    const seen: Record<string, unknown>[] = [];
    const reader = createStrayBranchReader(
      octokit({
        get: async () => ({
          data: {
            head: {
              ref: 'feature',
              repo: { name: 'bdc-harness-fork', owner: { login: 'someone' } },
            },
          },
        }),
        getRef: async input => {
          seen.push(input);
          return { data: { object: { sha: 'abc123' } } };
        },
      })
    );
    const head = await reader.readPullRequestHead({
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      number: 7,
    });
    expect(head).toEqual({ branch: 'feature', owner: 'someone', repo: 'bdc-harness-fork' });
    await reader.readBranch({ owner: head!.owner, repo: head!.repo, branch: head!.branch });
    expect(seen).toEqual([{ owner: 'someone', repo: 'bdc-harness-fork', ref: 'heads/feature' }]);
  });

  test('a deleted head repository (null head.repo) is unreadable, never a guess at the base repository', async () => {
    const reader = createStrayBranchReader(
      octokit({ get: async () => ({ data: { head: { ref: 'feature', repo: null } } }) })
    );
    expect(await reader.readPullRequestHead({ owner: 'o', repo: 'r', number: 1 })).toBeUndefined();
  });
});

describe('parsePullRequestUrl', () => {
  test('parses a github pull request url and rejects anything else', () => {
    expect(parsePullRequestUrl(PR)).toEqual({
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      number: 9,
    });
    expect(parsePullRequestUrl('https://github.com/o/r/issues/9')).toBeNull();
    expect(parsePullRequestUrl('not a url')).toBeNull();
  });
});

describe('sweep never alerts on anything it cannot read', () => {
  const stateCases: [string, BranchState | 'no-head-ref'][] = [
    ['an unknown branch state (lookup failed)', { state: 'unknown' }],
    ['a pull request whose head ref cannot be read', 'no-head-ref'],
  ];
  for (const [label, state] of stateCases) {
    test(`${label} raises no alert and is counted unreadable`, async () => {
      const result = await runPostMergeStraySweepOnce({
        listMerged: async () => [verdict()],
        reader: {
          readPullRequestHead: async () =>
            state === 'no-head-ref'
              ? undefined
              : { branch: 'fix/x', owner: 'thinmansoftware', repo: 'bdc-harness' },
          readBranch: async () => (state === 'no-head-ref' ? { state: 'gone' } : state),
        },
        escalate: neverEscalate,
        lookupCard: async () => null,
      });
      expect(result.alerted).toHaveLength(0);
      expect(result.unreadable).toBe(1);
    });
  }

  test('a verdict without a parseable pull request url or head sha is counted unreadable', async () => {
    const result = await runPostMergeStraySweepOnce({
      listMerged: async () => [verdict({ pr_url: null }), verdict({ head_sha: '' })],
      reader: {
        readPullRequestHead: async () => ({
          branch: 'fix/x',
          owner: 'thinmansoftware',
          repo: 'bdc-harness',
        }),
        readBranch: async () => ({ state: 'exists', sha: 'zzzz' }),
      },
      escalate: neverEscalate,
      lookupCard: async () => null,
    });
    expect(result.alerted).toHaveLength(0);
    expect(result.unreadable).toBe(2);
  });
});

describe.serial('fork pull requests', () => {
  let home = '';
  const originalHome = process.env.ARCHON_HOME;
  const originalUrl = process.env.DATABASE_URL;

  beforeEach(async () => {
    await closeDatabase();
    resetDatabase();
    home = join(import.meta.dir, `.archon-sweep-fork-${Date.now()}-${Math.random()}`);
    process.env.ARCHON_HOME = home;
    delete process.env.DATABASE_URL;
  });

  afterEach(async () => {
    await closeDatabase();
    resetDatabase();
    if (originalHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = originalHome;
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
    removeTempDirWithRetry(home);
  });

  const forkHead = { branch: 'feature', owner: 'someone', repo: 'bdc-harness-fork' };

  test('a push to the FORK branch after the merge alerts, naming the fork repository', async () => {
    const reads: string[] = [];
    const result = await runPostMergeStraySweepOnce({
      listMerged: async () => [verdict()],
      reader: {
        readPullRequestHead: async () => forkHead,
        readBranch: async ({ owner, repo, branch }) => {
          reads.push(`${owner}/${repo}:${branch}`);
          return owner === 'someone'
            ? { state: 'exists', sha: 'bbbb2222' }
            : { state: 'exists', sha: 'upstream-unrelated' };
        },
      },
    });
    expect(reads).toEqual(['someone/bdc-harness-fork:feature']);
    expect(result.alerted).toHaveLength(1);
    expect(result.alerted[0]).toMatchObject({
      branch: 'someone/bdc-harness-fork:feature',
      straySha: 'bbbb2222',
    });
    const view = await getOperatorCard(result.alerted[0]!.cardId);
    expect(view?.card.branch).toBe('someone/bdc-harness-fork:feature');
    expect(view?.card.repository).toBe('thinmansoftware/bdc-harness');
  });

  test('an unrelated UPSTREAM branch with the same name never raises an alert for a fork PR', async () => {
    const result = await runPostMergeStraySweepOnce({
      listMerged: async () => [verdict()],
      reader: {
        readPullRequestHead: async () => forkHead,
        // the fork branch is gone; an upstream branch of the same name exists elsewhere
        readBranch: async ({ owner }) =>
          owner === 'someone' ? { state: 'gone' } : { state: 'exists', sha: 'upstream-unrelated' },
      },
      escalate: neverEscalate,
      lookupCard: async () => null,
    });
    expect(result.alerted).toHaveLength(0);
    expect(result.noStray).toBe(1);
  });
});

describe.serial('sweep alert reaches the work owner through owner routing', () => {
  let home = '';
  const originalHome = process.env.ARCHON_HOME;
  const originalUrl = process.env.DATABASE_URL;
  const originalMode = process.env.OVERSEER_OWNER_ROUTING;

  beforeEach(async () => {
    await closeDatabase();
    resetDatabase();
    home = join(import.meta.dir, `.archon-sweep-owner-${Date.now()}-${Math.random()}`);
    process.env.ARCHON_HOME = home;
    delete process.env.DATABASE_URL;
    process.env.OVERSEER_OWNER_ROUTING = 'on';
  });

  afterEach(async () => {
    await closeDatabase();
    resetDatabase();
    if (originalHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = originalHome;
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
    if (originalMode === undefined) delete process.env.OVERSEER_OWNER_ROUTING;
    else process.env.OVERSEER_OWNER_ROUTING = originalMode;
    removeTempDirWithRetry(home);
  });

  test('with owner routing on, the card is addressed to the resolved owner', async () => {
    const owned: WorkOwnerResolution = {
      kind: 'owned',
      owner: 'alice',
      assigned_by: 'acting-xo',
      assigned_at: '2026-11-08T00:00:00.000Z',
      quote: 'alice owns it',
      source_issue: 'thinmansoftware/bdc-xo#1',
    };
    const lookups: { woId: string; repository?: string | null; prNumber?: number | null }[] = [];
    const result = await runPostMergeStraySweepOnce({
      listMerged: async () => [verdict()],
      reader: {
        readPullRequestHead: async () => ({
          branch: 'fix/x',
          owner: 'thinmansoftware',
          repo: 'bdc-harness',
        }),
        readBranch: async () => ({ state: 'exists', sha: 'bbbb2222' }),
      },
      escalationDeps: {
        resolveOwner: async input => {
          lookups.push(input);
          return owned;
        },
      },
    });
    expect(result.alerted).toHaveLength(1);
    expect(lookups).toEqual([
      { woId: 'WO-SWEEP-09', repository: 'thinmansoftware/bdc-harness', prNumber: 9 },
    ]);
    const view = await getOperatorCard(result.alerted[0]!.cardId);
    expect(view?.card.responsible_actor).toBe('alice');
    expect(view?.card.next_permitted_action).toContain('alice');
  });
});

describe('sweep scheduler wiring in runOverseerService', () => {
  const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
  const deps = {
    listRunsForWatch: async () => [],
    listRunEvents: async () => [],
    findPullRequest: async () => ({ exists: false as const }),
    mergePullRequest: async () => undefined,
    insertOverseerAction: async () => undefined,
  };
  const originalFlag = process.env.OVERSEER_POST_MERGE_SWEEP;

  afterEach(() => {
    if (originalFlag === undefined) delete process.env.OVERSEER_POST_MERGE_SWEEP;
    else process.env.OVERSEER_POST_MERGE_SWEEP = originalFlag;
  });

  async function runFor(ms: number, extra: Record<string, unknown>): Promise<{ sweeps: number }> {
    const controller = new AbortController();
    let sweeps = 0;
    const service = runOverseerService({
      enabled: true,
      adapterKind: 'fake',
      deps,
      signal: controller.signal,
      intervalMs: 5,
      reconcileIntervalMs: 5,
      reconcileRun: async () => undefined,
      postMergeSweepIntervalMs: 5,
      postMergeSweepRun: async () => {
        sweeps += 1;
      },
      ...extra,
    } as Parameters<typeof runOverseerService>[0]);
    await sleep(ms);
    controller.abort();
    await service;
    return { sweeps };
  }

  test('runs repeatedly when enabled by option', async () => {
    delete process.env.OVERSEER_POST_MERGE_SWEEP;
    const { sweeps } = await runFor(120, { postMergeSweepEnabled: true });
    expect(sweeps).toBeGreaterThanOrEqual(2);
  });

  test('runs when enabled by OVERSEER_POST_MERGE_SWEEP', async () => {
    process.env.OVERSEER_POST_MERGE_SWEEP = '1';
    const { sweeps } = await runFor(120, {});
    expect(sweeps).toBeGreaterThanOrEqual(2);
  });

  test('does not run by default', async () => {
    delete process.env.OVERSEER_POST_MERGE_SWEEP;
    const { sweeps } = await runFor(60, {});
    expect(sweeps).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// WO-HARNESS-POST-MERGE-SWEEP-COVERAGE-01 Tests 1-8: candidates come from GitHub's merged
// list, so a merge no event-store row records is covered like any other.
// ---------------------------------------------------------------------------
describe.serial('GitHub-derived candidates (merges by any path)', () => {
  let home = '';
  const originalHome = process.env.ARCHON_HOME;
  const originalUrl = process.env.DATABASE_URL;
  const originalMode = process.env.OVERSEER_OWNER_ROUTING;
  const NOW = new Date('2026-11-09T12:00:00.000Z');
  const SINCE = '2026-11-02T12:00:00.000Z';

  beforeEach(async () => {
    await closeDatabase();
    resetDatabase();
    home = join(import.meta.dir, `.archon-sweep-github-${Date.now()}-${Math.random()}`);
    process.env.ARCHON_HOME = home;
    delete process.env.DATABASE_URL;
    delete process.env.OVERSEER_OWNER_ROUTING;
  });

  afterEach(async () => {
    await closeDatabase();
    resetDatabase();
    if (originalHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = originalHome;
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
    if (originalMode === undefined) delete process.env.OVERSEER_OWNER_ROUTING;
    else process.env.OVERSEER_OWNER_ROUTING = originalMode;
    removeTempDirWithRetry(home);
  });

  type Listed = {
    number: number;
    title?: string;
    merged_at?: string | null;
    updated_at?: string;
    head: {
      ref?: string;
      sha?: string;
      repo?: { name?: string; owner?: { login?: string } | null } | null;
    };
  };

  const pr = (
    owner: string,
    repo: string,
    number: number,
    branch: string,
    sha: string,
    extra: Partial<Listed> = {}
  ): Listed => ({
    number,
    title: `change ${number}`,
    merged_at: '2026-11-08T10:00:00.000Z',
    updated_at: '2026-11-08T10:00:00.000Z',
    head: { ref: branch, sha, repo: { name: repo, owner: { login: owner } } },
    ...extra,
  });

  /** pages[repoKey][pageIndex]; refs[owner/repo:branch] is a sha, 404 (gone) or 500 (error). */
  function fakeGitHub(
    pages: Record<string, Listed[][]>,
    refs: Record<string, string | 404 | 500> = {}
  ): {
    octokit: GitHubMergedListOctokitLike & StrayBranchOctokitLike;
    listCalls: { repo: string; page: number }[];
  } {
    const listCalls: { repo: string; page: number }[] = [];
    const octokit = {
      pulls: {
        list: async (input: Record<string, unknown>): Promise<{ data: Listed[] }> => {
          const key = `${String(input.owner)}/${String(input.repo)}`;
          const page = Number(input.page);
          listCalls.push({ repo: key, page });
          const configured = pages[key];
          if (!configured) throw Object.assign(new Error('Not Found'), { status: 404 });
          return { data: configured[page - 1] ?? [] };
        },
        get: async (): Promise<never> => {
          throw new Error('pulls.get must not be needed for GitHub-derived candidates');
        },
      },
      git: {
        getRef: async (
          input: Record<string, unknown>
        ): Promise<{ data: { object: { sha: string } } }> => {
          const key = `${String(input.owner)}/${String(input.repo)}:${String(input.ref).replace(/^heads\//, '')}`;
          const value = refs[key];
          if (typeof value === 'string') return { data: { object: { sha: value } } };
          throw Object.assign(new Error(value === 500 ? 'boom' : 'Not Found'), {
            status: value === 500 ? 500 : 404,
          });
        },
      },
    } as unknown as GitHubMergedListOctokitLike & StrayBranchOctokitLike;
    return { octokit, listCalls };
  }

  const sweep = (
    gh: ReturnType<typeof fakeGitHub>,
    repos: { owner: string; repo: string }[],
    extra: Partial<Parameters<typeof runPostMergeStraySweepOnce>[0]> = {}
  ): ReturnType<typeof runPostMergeStraySweepOnce> =>
    runPostMergeStraySweepOnce({
      listCandidates: createGitHubMergedSource(gh.octokit, repos),
      reader: createStrayBranchReader(gh.octokit),
      now: NOW,
      ...extra,
    });

  test('Test 1: a merged PR with a moved branch raises one alert whichever path merged it', async () => {
    const gh = fakeGitHub(
      {
        'thinmansoftware/bdc-xo': [
          [
            pr('thinmansoftware', 'bdc-xo', 5021, 'inventory/billing-parity', 'merged111', {
              title: 'WO: WO-X-01',
            }),
          ],
        ],
      },
      { 'thinmansoftware/bdc-xo:inventory/billing-parity': 'stray2222' }
    );
    const result = await sweep(gh, [{ owner: 'thinmansoftware', repo: 'bdc-xo' }]);
    expect(result.alerted).toHaveLength(1);
    expect(result.alerted[0]).toMatchObject({
      prUrl: 'https://github.com/thinmansoftware/bdc-xo/pull/5021',
      branch: 'inventory/billing-parity',
      straySha: 'stray2222',
    });
    const view = await getOperatorCard(result.alerted[0]!.cardId);
    expect(view?.card.run_id).toBe('post-merge-sweep:thinmansoftware/bdc-xo#5021');
    expect(view?.card.wo_id).toBe('WO-X-01');
    expect(view?.card.actionable_event_at).toBe('2026-11-08T10:00:00.000Z');
    expect(view?.card.blocker).toContain('stray2222');
  });

  test('Test 2: a branch that is gone, and one still at the merged head, raise nothing', async () => {
    const gh = fakeGitHub(
      {
        'thinmansoftware/bdc-xo': [
          [
            pr('thinmansoftware', 'bdc-xo', 1, 'gone-branch', 'aaa'),
            pr('thinmansoftware', 'bdc-xo', 2, 'same-branch', 'bbb'),
          ],
        ],
      },
      { 'thinmansoftware/bdc-xo:same-branch': 'bbb' }
    );
    const result = await sweep(gh, [{ owner: 'thinmansoftware', repo: 'bdc-xo' }], {
      escalate: neverEscalate,
      lookupCard: async () => null,
    });
    expect(result.alerted).toHaveLength(0);
    expect(result.noStray).toBe(2);
  });

  test('Test 3: unreadable GitHub state never alerts', async () => {
    const gh = fakeGitHub(
      {
        'thinmansoftware/bdc-xo': [
          [
            pr('thinmansoftware', 'bdc-xo', 1, 'rate-limited', 'aaa'),
            pr('thinmansoftware', 'bdc-xo', 2, 'fork-gone', 'bbb', {
              head: { ref: 'fork-gone', sha: 'bbb', repo: null },
            }),
          ],
        ],
      },
      { 'thinmansoftware/bdc-xo:rate-limited': 500 }
    );
    const result = await sweep(gh, [{ owner: 'thinmansoftware', repo: 'bdc-xo' }], {
      escalate: neverEscalate,
      lookupCard: async () => null,
    });
    expect(result.alerted).toHaveLength(0);
    expect(result.unreadable).toBe(2);
  });

  test('Test 4: once per stray sha, a new push alerts again, and a PR with no WO token still gets a card', async () => {
    process.env.OVERSEER_OWNER_ROUTING = 'on';
    const refs: Record<string, string | 404 | 500> = {
      'thinmansoftware/bdc-xo:feature/one': 'stray1',
      'thinmansoftware/bdc-xo:docs/no-wo': 'strayDocs',
    };
    const gh = fakeGitHub(
      {
        'thinmansoftware/bdc-xo': [
          [
            pr('thinmansoftware', 'bdc-xo', 10, 'feature/one', 'm1', {
              title: 'WO-AA-BB-01: thing',
            }),
            pr('thinmansoftware', 'bdc-xo', 11, 'docs/no-wo', 'm2', { title: 'docs: a page' }),
          ],
        ],
      },
      refs
    );
    const owner = async (input: { woId: string }): Promise<WorkOwnerResolution> =>
      input.woId.startsWith('PR-')
        ? { kind: 'unowned', reason: 'no_issue', source_issue: null }
        : {
            kind: 'owned',
            owner: 'alice',
            assigned_by: 'acting-xo',
            assigned_at: '2026-11-08',
            quote: 'q',
            source_issue: 'thinmansoftware/bdc-xo#1',
          };
    let escalations = 0;
    const escalate = ((...args: Parameters<typeof runEscalation>) => {
      escalations += 1;
      return runEscalation(...args);
    }) as typeof runEscalation;
    const repos = [{ owner: 'thinmansoftware', repo: 'bdc-xo' }];
    const options = { escalate, escalationDeps: { resolveOwner: owner } };

    const first = await sweep(gh, repos, options);
    const second = await sweep(gh, repos, options);
    refs['thinmansoftware/bdc-xo:feature/one'] = 'stray1-pushed-again';
    const third = await sweep(gh, repos, options);

    expect(first.alerted).toHaveLength(2);
    expect(second.alerted).toHaveLength(0);
    expect(second.alreadyAlerted).toBe(2);
    expect(third.alerted).toHaveLength(1);
    expect(third.alerted[0]?.straySha).toBe('stray1-pushed-again');
    expect(escalations).toBe(3);
    const lane = first.alerted.find(a => a.prUrl.endsWith('/10'))!;
    const noWo = first.alerted.find(a => a.prUrl.endsWith('/11'))!;
    const laneCard = await getOperatorCard(lane.cardId);
    const noWoCard = await getOperatorCard(noWo.cardId);
    expect(laneCard?.card.responsible_actor).toBe('alice');
    expect(noWoCard?.card.wo_id).toBe('PR-thinmansoftware/bdc-xo#11');
    expect(noWoCard?.card.responsible_actor).toBe(UNOWNED_RESPONSIBLE_ACTOR);
  });

  test('Test 5: only PRs merged inside the 7-day window are candidates and paging is bounded', async () => {
    const filler = Array.from({ length: 100 }, (_, i) =>
      pr('thinmansoftware', 'a', 1000 + i, `f${i}`, `s${i}`, {
        merged_at: null,
        updated_at: '2026-11-08T00:00:00.000Z',
      })
    );
    const gh = fakeGitHub({
      'thinmansoftware/a': [
        filler,
        [
          pr('thinmansoftware', 'a', 1, 'six-days', 'x1', {
            merged_at: '2026-11-03T12:00:00.000Z',
            updated_at: '2026-11-03T12:00:00.000Z',
          }),
          pr('thinmansoftware', 'a', 2, 'eight-days', 'x2', {
            merged_at: '2026-11-01T12:00:00.000Z',
            updated_at: '2026-11-01T12:30:00.000Z',
          }),
          pr('thinmansoftware', 'a', 3, 'unmerged', 'x3', {
            merged_at: null,
            updated_at: '2026-10-20T00:00:00.000Z',
          }),
        ],
        [pr('thinmansoftware', 'a', 4, 'never-requested', 'x4')],
      ],
    });
    const candidates = await createGitHubMergedSource(gh.octokit, [
      { owner: 'thinmansoftware', repo: 'a' },
    ])(SINCE);
    expect(candidates.map(c => c.pr.number)).toEqual([1]);
    // page 2 is wholly older than the window at its last item, so page 3 is never requested
    expect(gh.listCalls.map(c => c.page)).toEqual([1, 2]);

    // a FULL page wholly older than the window stops paging by date, not by page length
    const oldFull = Array.from({ length: 100 }, (_, i) =>
      pr('thinmansoftware', 'c', 2000 + i, `o${i}`, `t${i}`, {
        merged_at: null,
        updated_at: '2026-10-01T00:00:00.000Z',
      })
    );
    const dated = fakeGitHub({ 'thinmansoftware/c': [filler, oldFull, filler, filler] });
    await createGitHubMergedSource(dated.octokit, [{ owner: 'thinmansoftware', repo: 'c' }])(SINCE);
    expect(dated.listCalls.map(c => c.page)).toEqual([1, 2]);

    // a repository whose every page stays inside the window stops at the cap and logs it
    const endless = Array.from({ length: 12 }, () => filler);
    const capped = fakeGitHub({ 'thinmansoftware/b': endless });
    const log = captureRootLogLines();
    try {
      const out = await createGitHubMergedSource(capped.octokit, [
        { owner: 'thinmansoftware', repo: 'b' },
      ])(SINCE);
      expect(out).toEqual([]);
    } finally {
      log.restore();
    }
    expect(capped.listCalls).toHaveLength(POST_MERGE_SWEEP_MAX_PAGES);
    expect(capped.listCalls.map(c => c.page)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(log.lines.some(l => l.includes('overseer.post_merge_sweep.page_cap_reached'))).toBe(
      true
    );
  });

  test('Test 6: the repository list is the merge policy plus the discovery env, each once', () => {
    const saved = process.env.MERGE_MANAGER_REPO_POLICY;
    delete process.env.MERGE_MANAGER_REPO_POLICY;
    try {
      const repos = postMergeSweepRepos('Acme/Extra, thinmansoftware/BDC-Harness, bad, a/b/c');
      const names = repos.map(r => `${r.owner}/${r.repo}`.toLowerCase());
      expect(new Set(names).size).toBe(names.length);
      expect(names.sort()).toEqual(
        [
          'acme/extra',
          'thinmansoftware/bdc-harness',
          'thinmansoftware/bdc-xo',
          'thinmansoftware/lspro-react',
          'thinmansoftware/shopops',
          'thinmansoftware/shopops-storefront',
        ].sort()
      );
      expect(postMergeSweepRepos(undefined).map(r => `${r.owner}/${r.repo}`)).not.toContain(
        'Acme/Extra'
      );
    } finally {
      if (saved !== undefined) process.env.MERGE_MANAGER_REPO_POLICY = saved;
    }
  });

  test('Test 7: the default sweep reads GitHub once per repository and never the verdict store', async () => {
    const saved = process.env.MERGE_MANAGER_REPO_POLICY;
    delete process.env.MERGE_MANAGER_REPO_POLICY;
    const expectedRepos = postMergeSweepRepos().map(r => `${r.owner}/${r.repo}`);
    const pages = Object.fromEntries(expectedRepos.map(r => [r, [[]] as Listed[][]]));
    const gh = fakeGitHub(pages);
    const log = captureRootLogLines();
    const controller = new AbortController();
    try {
      const service = runOverseerService({
        enabled: true,
        adapterKind: 'fake',
        deps: {
          listRunsForWatch: async () => [],
          listRunEvents: async () => [],
          findPullRequest: async () => ({ exists: false as const }),
          mergePullRequest: async () => undefined,
          insertOverseerAction: async () => undefined,
        },
        signal: controller.signal,
        intervalMs: 5,
        reconcileIntervalMs: 5,
        reconcileRun: async () => undefined,
        postMergeSweepEnabled: true,
        postMergeSweepIntervalMs: 5,
        postMergeSweepOctokit: gh.octokit,
      } as Parameters<typeof runOverseerService>[0]);
      const deadline = Date.now() + 4000;
      while (new Set(gh.listCalls.map(c => c.repo)).size < expectedRepos.length) {
        if (Date.now() > deadline) throw new Error('sweep did not list every repository');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      controller.abort();
      await service;
    } finally {
      log.restore();
      if (saved !== undefined) process.env.MERGE_MANAGER_REPO_POLICY = saved;
    }
    expect([...new Set(gh.listCalls.map(c => c.repo))].sort()).toEqual([...expectedRepos].sort());
    // the verdict store has no database here: a read of it would have failed this tick
    expect(log.lines.some(l => l.includes('overseer.post_merge_sweep.tick'))).toBe(true);
    expect(log.lines.some(l => l.includes('iteration_failed_isolated'))).toBe(false);
  });

  test('Test 8: every merging path is covered with no event-store row', async () => {
    const gh = fakeGitHub(
      {
        'thinmansoftware/bdc-xo': [
          [
            pr('thinmansoftware', 'bdc-xo', 201, 'wo/wo-x-01', 'lane111', { title: 'WO: WO-X-01' }),
            pr('thinmansoftware', 'bdc-xo', 202, 'docs/x', 'docs111', { title: 'docs: x' }),
          ],
        ],
        'thinmansoftware/bdc-harness': [
          [
            pr('thinmansoftware', 'bdc-harness', 301, 'feat/harness-thing', 'hn111', {
              title: 'WO-HARNESS-THING-01: thing',
            }),
          ],
        ],
        'thinmansoftware/shopops': [
          [pr('thinmansoftware', 'shopops', 401, 'feat/stage', 'st111', { title: 'stage change' })],
        ],
      },
      {
        'thinmansoftware/bdc-xo:wo/wo-x-01': 'moved1',
        'thinmansoftware/bdc-xo:docs/x': 'moved2',
        'thinmansoftware/bdc-harness:feat/harness-thing': 'moved3',
        'thinmansoftware/shopops:feat/stage': 'moved4',
      }
    );
    const repos = [
      { owner: 'thinmansoftware', repo: 'bdc-xo' },
      { owner: 'thinmansoftware', repo: 'bdc-harness' },
      { owner: 'thinmansoftware', repo: 'shopops' },
    ];
    const first = await sweep(gh, repos);
    const second = await sweep(gh, repos);
    expect(first.alerted).toHaveLength(4);
    expect(second.alerted).toHaveLength(0);
    const woIds: string[] = [];
    for (const alert of first.alerted) {
      const view = await getOperatorCard(alert.cardId);
      woIds.push(view?.card.wo_id ?? '');
    }
    expect(woIds.sort()).toEqual(
      [
        'PR-thinmansoftware/bdc-xo#202',
        'PR-thinmansoftware/shopops#401',
        'WO-HARNESS-THING-01',
        'WO-X-01',
      ].sort()
    );
    const cards = await getDatabase().query<{ n: number | string }>(
      'SELECT COUNT(*) AS n FROM overseer_operator_cards'
    );
    expect(Number(cards.rows[0]?.n)).toBe(4);
  });

  test('extractWoId takes the first WO token, titles before branches, and stops at the counter', () => {
    expect(extractWoId('WO: WO-HARNESS-X-01', 'wo/other-02')).toBe('WO-HARNESS-X-01');
    expect(extractWoId('plain title', 'feat/wo-harness-e2e-merge-canary-10-thread-12345678')).toBe(
      'WO-HARNESS-E2E-MERGE-CANARY-10'
    );
    expect(extractWoId('plain', 'docs/a-page')).toBeNull();
  });
});
