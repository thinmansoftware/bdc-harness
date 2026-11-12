// WO-HARNESS-SIBLING-WO-PR-HOLD-AFTER-MERGE-01 (bdc-xo#5654).
// Provisioner PR 103 (a salvage fallback PR from a redundant second rung) stayed open, approved and
// mergeable after PR 102 of the same work order merged, because the reconcile supersede pass could
// only see siblings that name the work order in their body or branch. These cases cover the matcher
// that asks the originating run, its guards, and the merge gate's sibling check. The merge-bridge
// gate cases are in __tests__/merge-execution-bridge.test.ts (they need that file's harness).
import { describe, expect, test } from 'bun:test';
import {
  RECONCILE_SUPERSEDE_ACTION,
  runReconcileOnce,
  type ReconcileDeps,
  type ReconcileRepoOpenPullRequest,
} from './reconcile';
import { fakeDeps, mergedPr } from './__tests__/reconcile.test';
import {
  findOriginatingRunsForPullRequest,
  salvageWorktreeFromBranch,
  type OriginatingRunCandidate,
} from './originating-run-lookup';
import {
  createMergedSiblingFinder,
  createOriginatingWoResolver,
  type OriginatingWoResolution,
  type SiblingMergeContext,
} from './sibling-wo-id';

const WO = 'WO-CSOS-PROVISIONER-STORE-ACTIVATION-01';
const SALVAGE_BRANCH = 'salvage/opus-repair-task-web-worker-1794491823473-n2cbqh-326259';
const FALLBACK_BODY =
  'FALLBACK PATH: a BLOCKED build was auto-repaired by opus-repair, but the non-interactive run could not reach a human approval gate.';

function openPr(
  number: number,
  body: string,
  headRefName: string,
  overrides: Partial<ReconcileRepoOpenPullRequest> = {}
): ReconcileRepoOpenPullRequest {
  return {
    number,
    body,
    headRefName,
    isDraft: false,
    headRepository: { owner: 'thinmansoftware', repo: 'bdc-harness' },
    createdAt: '2026-07-17T11:00:00Z',
    ...overrides,
  };
}

type Resolve = NonNullable<ReconcileDeps['resolveOriginatingWoId']>;

function siblingDeps(input: {
  opens: ReconcileRepoOpenPullRequest[];
  resolve?: Resolve;
  mergedFiles?: string[];
}) {
  const deps = fakeDeps({
    prs: [mergedPr({ number: 102, body: `WO: ${WO}\n`, baseRef: 'dev' })],
  });
  const pullCloses: Array<{ number: number; comment: string }> = [];
  const resolveCalls: number[] = [];
  deps.listOpenPullRequestsInRepo = async () => input.opens;
  deps.closePullRequest = async close => {
    pullCloses.push({ number: close.number, comment: close.comment });
  };
  deps.hasSupersedeBeenRecorded = async ({ prRef, woId }) =>
    deps.actions.some(
      action =>
        action.action === RECONCILE_SUPERSEDE_ACTION &&
        action.prRef === prRef &&
        action.woId === woId
    );
  if (input.mergedFiles) {
    const files = input.mergedFiles;
    deps.listPullRequestFiles = async () => files;
  }
  if (input.resolve) {
    const resolve = input.resolve;
    deps.resolveOriginatingWoId = async request => {
      resolveCalls.push(request.number);
      return resolve(request);
    };
  }
  return Object.assign(deps, { pullCloses, resolveCalls });
}

const one: Resolve = async () => ({ kind: 'one', woId: WO });

describe('reconcile supersede: a sibling that does not name the work order', () => {
  test('Test 1: it is closed through its originating run, once, with the kept-branch comment', async () => {
    const deps = siblingDeps({
      opens: [openPr(103, FALLBACK_BODY, SALVAGE_BRANCH)],
      resolve: one,
    });

    await runReconcileOnce({ deps });

    expect(deps.pullCloses).toEqual([
      {
        number: 103,
        comment:
          `Superseded by #102: the same work order (${WO}) merged there. ` +
          `This PR's branch ${SALVAGE_BRANCH} is kept; reopen the PR if it is still wanted.`,
      },
    ]);
    expect(deps.actions.filter(action => action.action === RECONCILE_SUPERSEDE_ACTION)).toEqual([
      {
        prRef: 'thinmansoftware/bdc-harness#103',
        woId: WO,
        class: 'supersede',
        action: RECONCILE_SUPERSEDE_ACTION,
        result: '#102',
      },
    ]);

    await runReconcileOnce({ deps });
    expect(deps.pullCloses).toHaveLength(1);
    expect(
      deps.actions.filter(action => action.action === RECONCILE_SUPERSEDE_ACTION)
    ).toHaveLength(1);
  });

  test('Test 2: any doubt in the lookup leaves the PR open and says why', async () => {
    const cases: Array<{
      name: string;
      resolve: Resolve;
      level: 'warnings' | 'infos';
    }> = [
      {
        name: 'throws',
        resolve: async () => {
          throw new Error('event store unavailable');
        },
        level: 'warnings',
      },
      { name: 'none', resolve: async () => ({ kind: 'none' }), level: 'infos' },
      {
        name: 'ambiguous',
        resolve: async () => ({ kind: 'ambiguous', woIds: [WO, 'WO-OTHER-THING-09'] }),
        level: 'warnings',
      },
      {
        name: 'another work order',
        resolve: async () => ({ kind: 'one', woId: 'WO-OTHER-THING-09' }),
        level: 'infos',
      },
    ];
    for (const doubt of cases) {
      const deps = siblingDeps({
        opens: [openPr(103, FALLBACK_BODY, SALVAGE_BRANCH)],
        resolve: doubt.resolve,
      });
      await runReconcileOnce({ deps });
      expect(deps.pullCloses, doubt.name).toEqual([]);
      expect(
        deps.actions.filter(action => action.action === RECONCILE_SUPERSEDE_ACTION),
        doubt.name
      ).toEqual([]);
      expect(deps[doubt.level], doubt.name).toContain(
        'overseer.reconcile.supersede_lookup_unmatched'
      );
    }
  });

  test('Test 3: siblings matched by body or branch behave as before and never call the lookup', async () => {
    const deps = siblingDeps({
      opens: [
        openPr(104, `WO: ${WO}\n`, 'archon/task-web-worker-1-abc'),
        openPr(105, 'no declaration', `fix/${WO.toLowerCase()}-thread-ghi`),
      ],
      resolve: one,
    });

    await runReconcileOnce({ deps });

    expect(deps.pullCloses.map(close => close.number).sort()).toEqual([104, 105]);
    expect(deps.pullCloses.every(close => close.comment === 'Superseded by #102')).toBe(true);
    expect(deps.resolveCalls).toEqual([]);
  });

  test('Test 5: the existing guards still apply to the new path', async () => {
    const blocked: Array<{ name: string; open: ReconcileRepoOpenPullRequest; files?: string[] }> = [
      {
        name: 'draft',
        open: openPr(103, FALLBACK_BODY, SALVAGE_BRANCH, { isDraft: true }),
      },
      {
        name: 'created after the merge',
        open: openPr(103, FALLBACK_BODY, SALVAGE_BRANCH, { createdAt: '2026-07-17T13:00:00Z' }),
      },
      {
        name: 'fork',
        open: openPr(103, FALLBACK_BODY, SALVAGE_BRANCH, {
          headRepository: { owner: 'someone', repo: 'bdc-harness' },
        }),
      },
      {
        name: 'spec-only merge',
        open: openPr(103, FALLBACK_BODY, SALVAGE_BRANCH),
        files: ['docs/work-orders/WO-X-01.md'],
      },
    ];
    for (const guard of blocked) {
      const deps = siblingDeps({
        opens: [guard.open],
        resolve: one,
        ...(guard.files ? { mergedFiles: guard.files } : {}),
      });
      await runReconcileOnce({ deps });
      expect(deps.pullCloses, guard.name).toEqual([]);
    }
  });

  test('Test 6: another work order and an unrelated PR are untouched', async () => {
    const deps = siblingDeps({
      opens: [
        openPr(106, FALLBACK_BODY, 'salvage/opus-repair-task-web-worker-1-aaa-1'),
        openPr(107, 'a human PR', 'someone/fix-typo'),
      ],
      resolve: async request =>
        request.number === 106 ? { kind: 'one', woId: 'WO-OTHER-THING-09' } : { kind: 'none' },
    });

    await runReconcileOnce({ deps });

    expect(deps.pullCloses).toEqual([]);
    expect(deps.resolveCalls.sort()).toEqual([106, 107]);
  });
});

describe('originating run lookup for a salvage fallback PR', () => {
  const worktree = 'task-web-worker-1794491823473-n2cbqh';
  const candidate = (
    id: string,
    path: string,
    codebase = 'thinmansoftware/comicstoreos-provisioner'
  ): OriginatingRunCandidate => ({
    id,
    status: 'failed',
    started_at: '2026-11-12 13:57:04',
    working_path: path,
    codebase_name: codebase,
    codebase_url: null,
    event_data: null,
  });

  test('reads the worktree basename out of the salvage branch name', () => {
    expect(salvageWorktreeFromBranch(SALVAGE_BRANCH)).toBe(worktree);
    expect(salvageWorktreeFromBranch('feat/wo-csos-thing-01-thread-91c1ecb7')).toBeNull();
    expect(salvageWorktreeFromBranch(undefined)).toBeNull();
  });

  test('finds the run whose worktree the salvage branch was pushed from, in the right repo only', async () => {
    let asked: Record<string, unknown> | undefined;
    const runs = await findOriginatingRunsForPullRequest(
      {
        owner: 'thinmansoftware',
        repo: 'comicstoreos-provisioner',
        number: 103,
        headRef: SALVAGE_BRANCH,
      },
      async input => {
        asked = { ...input };
        return [
          candidate(
            'run-293ab733',
            `/.archon/workspaces/thinmansoftware/comicstoreos-provisioner/worktrees/archon/${worktree}`
          ),
          candidate(
            'run-other-repo',
            `/.archon/workspaces/thinmansoftware/shopops/worktrees/archon/${worktree}`,
            'thinmansoftware/shopops'
          ),
          candidate(
            'run-unrelated',
            '/.archon/workspaces/x/y/worktrees/archon/task-web-worker-9-zzz'
          ),
        ];
      }
    );
    expect(asked?.salvageWorktree).toBe(worktree);
    expect(runs).toEqual([{ runId: 'run-293ab733', status: 'failed' }]);
  });
});

describe('originating work order resolver', () => {
  const packet =
    '=== ESCALATION PACKET (from prior lower-tier attempt) ===\nprior_run_id=abc\n\nA prior lower-tier attempt was rejected.\n';
  const list = (ids: string[]) => async () =>
    ids.map(
      (id): OriginatingRunCandidate => ({
        id,
        status: 'completed',
        started_at: '2026-11-12 13:57:04',
        working_path: `/.archon/workspaces/o/r/worktrees/archon/${id}`,
        codebase_name: 'o/r',
        codebase_url: null,
        event_data: `https://github.com/o/r/pull/5 ${id}`,
      })
    );
  const resolver = (ids: string[], messages: Record<string, string | null>) =>
    createOriginatingWoResolver({
      list: list(ids),
      readUserMessage: async runId => messages[runId] ?? null,
    });
  const input = { owner: 'o', repo: 'r', number: 5, headRefName: 'feat/x' };

  test('one WO id across every matched run (the WO_ID line may follow an escalation packet)', async () => {
    const result = await resolver(['run-a'], {
      'run-a': `${packet}WO_ID=${WO} --project r\nmore text`,
    })(input);
    expect(result).toEqual({ kind: 'one', woId: WO });
  });

  test('no run, or no WO id on any run, is none', async () => {
    expect(await resolver([], {})(input)).toEqual({ kind: 'none' });
    expect(await resolver(['run-a'], { 'run-a': 'no id here' })(input)).toEqual({ kind: 'none' });
  });

  test('two WO ids, or one run without an id beside one with an id, is ambiguous', async () => {
    const two = await resolver(['run-a', 'run-b'], {
      'run-a': `WO_ID=${WO}`,
      'run-b': 'WO_ID=WO-OTHER-THING-09',
    })(input);
    expect(two.kind).toBe('ambiguous');
    const mixed = await resolver(['run-a', 'run-b'], { 'run-a': `WO_ID=${WO}`, 'run-b': 'x' })(
      input
    );
    expect(mixed.kind).toBe('ambiguous');
  });

  test('a failing read propagates (the caller fails closed)', async () => {
    const failing = createOriginatingWoResolver({
      list: list(['run-a']),
      readUserMessage: async () => {
        throw new Error('db down');
      },
    });
    await expect(failing(input)).rejects.toThrow('db down');
  });
});

describe('merged sibling finder (the merge gate)', () => {
  const context = (overrides: Partial<SiblingMergeContext> = {}): SiblingMergeContext => ({
    headRefName: SALVAGE_BRANCH,
    createdAt: '2026-11-12T14:07:12Z',
    recentMerged: [
      {
        number: 102,
        url: 'https://github.com/o/r/pull/102',
        mergedAt: '2026-11-12T14:14:22Z',
        body: `WO: ${WO}\n`,
      },
    ],
    ...overrides,
  });
  const finder = (
    ctx: SiblingMergeContext,
    resolution: OriginatingWoResolution,
    files: readonly string[] | null = ['src/a.ts']
  ) =>
    createMergedSiblingFinder({
      readContext: async () => ctx,
      resolve: async () => resolution,
      listMergedFiles: async () => files,
    });
  const ref = { owner: 'o', repo: 'r', number: 103 };

  test('finds a same-work-order PR merged after this one was created', async () => {
    expect(await finder(context(), { kind: 'one', woId: WO })(ref)).toEqual({
      number: 102,
      url: 'https://github.com/o/r/pull/102',
      woId: WO,
    });
  });

  test('ignores a merge before this PR existed, a spec-only merge, another work order, itself and any doubt', async () => {
    const before = context({ createdAt: '2026-11-12T15:00:00Z' });
    expect(await finder(before, { kind: 'one', woId: WO })(ref)).toBeNull();
    expect(
      await finder(context(), { kind: 'one', woId: WO }, ['docs/work-orders/X.md'])(ref)
    ).toBeNull();
    expect(await finder(context(), { kind: 'one', woId: WO }, null)(ref)).toBeNull();
    expect(await finder(context(), { kind: 'one', woId: 'WO-OTHER-THING-09' })(ref)).toBeNull();
    expect(await finder(context(), { kind: 'one', woId: WO })({ ...ref, number: 102 })).toBeNull();
    expect(await finder(context(), { kind: 'none' })(ref)).toBeNull();
    expect(
      await finder(context(), { kind: 'ambiguous', woIds: [WO, 'WO-OTHER-THING-09'] })(ref)
    ).toBeNull();
    expect(
      await finder(context({ createdAt: 'not a date' }), { kind: 'one', woId: WO })(ref)
    ).toBeNull();
  });
});
