/**
 * WO-HARNESS-MERGE-OWNER-REWORKING-GUARD-01, rule (d), supporting tests.
 * Test 7 itself (one alert per PR and stray sha) lives in merge-owner-reworking.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { removeTempDirWithRetry } from '@archon/core/test/temp-dir';
import { join } from 'path';
import { closeDatabase, getOperatorCard, resetDatabase } from '@archon/core/db';
import type { WorkOwnerResolution } from '../owner-resolution';
import {
  createStrayBranchReader,
  parsePullRequestUrl,
  runPostMergeStraySweepOnce,
  type BranchState,
  type MergedVerdictForSweep,
  type StrayBranchOctokitLike,
} from '../post-merge-stray-sweep';
import type { runEscalation } from '../escalate';
import { runOverseerService } from '../service.ts';

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
