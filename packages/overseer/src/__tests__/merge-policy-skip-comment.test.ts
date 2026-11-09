import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { OverseerVerdictRow, OverseerWatchRun } from '@archon/core/db/overseer';
import { rootLogger } from '@archon/paths';
import {
  postPolicySkipComment,
  runMergeExecutionBridgeOnce as runMergeExecutionBridgeOnceProduction,
  type MergeExecutionBridgeOptions,
  type MergeExecutionBridgeStore,
} from '../merge-execution-bridge';
import type { GitHubClientDeps, PullRequestEvidence } from '../types.ts';

// WO-HARNESS-MERGE-POLICY-SKIP-VISIBLE-01: a terminal policy skip gets ONE comment saying why.

const MARKER = '<!-- merge-policy-skip:v1 -->';
const BOT = 'thinman-overseer[bot]';

const runOnce = (options: MergeExecutionBridgeOptions): Promise<void> =>
  runMergeExecutionBridgeOnceProduction({
    hasQualifiedReview: async () => true,
    reviewConflictAtHead: async () => null,
    ...options,
  });

const verdict = (id: string, overrides: Partial<OverseerVerdictRow> = {}): OverseerVerdictRow =>
  ({
    id,
    run_id: `run-${id}`,
    wo_id: 'WO-TEST',
    head_sha: 'judged-sha',
    proposed_action: 'flag_merge_ready',
    ...overrides,
  }) as OverseerVerdictRow;

const run = (id: string): OverseerWatchRun => ({
  id: `run-${id}`,
  woId: 'WO-TEST',
  owner: 'thinmansoftware',
  repo: 'bdc-harness',
  status: 'completed',
  headBranch: `branch-${id}`,
  metadata: {},
});

const greenPr = (overrides: Partial<PullRequestEvidence> = {}): PullRequestEvidence => ({
  exists: true,
  state: 'open',
  checks: { total: 2, passed: 2, failed: 0, pending: 0 },
  mergeable: true,
  mergeableState: 'clean',
  changedFilePaths: ['packages/overseer/src/code.ts'],
  baseBranch: 'dev',
  headSha: 'judged-sha',
  htmlUrl: 'https://github.test/pr/1',
  pr: { owner: 'thinmansoftware', repo: 'bdc-harness', number: 1 },
  ...overrides,
});

const policy = {
  service_enabled: true,
  emergency_stop: false,
  legacy_dry_run: false,
  capability_flags: {
    escalation: false,
    repair: false,
    branch: false,
    lifecycle: false,
    merge: true,
  },
} as const;

interface PostedComment {
  body: string;
}

function harness(
  rows: OverseerVerdictRow[],
  evidence: PullRequestEvidence,
  githubExtras: Partial<GitHubClientDeps> = {}
) {
  const pending = [...rows];
  const outcomes: { verdictId: string; mutationSent: boolean; reason: string }[] = [];
  const posted: PostedComment[] = [];
  let merges = 0;
  const processing = new Set<string>();
  const store: MergeExecutionBridgeStore = {
    listUnactionedVerdicts: async () => [...pending],
    claimVerdict: async verdictId => {
      if (!pending.some(row => row.id === verdictId)) return false;
      processing.add(verdictId);
      return true;
    },
    releaseVerdictClaim: async verdictId => processing.delete(verdictId),
    getRunById: async runId => run(runId.replace('run-', '')),
    getEarliestMergeSlotReservation: async () =>
      new Date(Date.now() - 50 * 60 * 1000).toISOString(),
    reserveMergeSlot: async () => true,
    releaseMergeSlot: async () => undefined,
    recordOutcome: async input => {
      outcomes.push(input);
      processing.delete(input.verdictId);
      const index = pending.findIndex(row => row.id === input.verdictId);
      if (index >= 0) pending.splice(index, 1);
    },
  };
  const github: GitHubClientDeps = {
    findPullRequest: async () => evidence,
    approvePullRequest: async () => ({ approved: true }),
    mergePullRequest: async () => {
      merges += 1;
      return { merged: true, mergeSha: 'merge-sha' };
    },
    commentAuthorLogin: BOT,
    listPullRequestComments: async () =>
      posted.map(c => ({ authorLogin: BOT, body: c.body, createdAt: '2026-11-09T00:00:00Z' })),
    commentOnPullRequest: async input => {
      posted.push({ body: input.body });
      return { commented: true };
    },
    ...githubExtras,
  };
  return {
    store,
    github,
    outcomes,
    posted,
    get merges() {
      return merges;
    },
  };
}

const policyComments = (posted: PostedComment[]): PostedComment[] =>
  posted.filter(c => c.body.includes('merge-policy-skip'));

function captureLogs(): { lines: string[]; restore: () => void } {
  const symbol = Object.getOwnPropertySymbols(rootLogger).find(
    s => s.description === 'pino.stream'
  );
  if (!symbol) throw new Error('pino.stream symbol missing on rootLogger');
  const stream = (rootLogger as unknown as Record<symbol, { write: (line: string) => void }>)[
    symbol
  ];
  const lines: string[] = [];
  const write = spyOn(stream, 'write').mockImplementation(line => {
    lines.push(String(line));
  });
  return { lines, restore: () => write.mockRestore() };
}

afterEach(() => {
  delete process.env.MERGE_MANAGER_REPO_POLICY;
  delete process.env.OVERSEER_MERGE_REPO_CONFIG;
});

const docsPr = (): PullRequestEvidence => greenPr({ changedFilePaths: ['docs/canary/x.txt'] });

describe('merge policy skip comment', () => {
  test('Test 1: a docs-only PR into a docsOnly-skip base gets exactly one explanatory comment and no merge', async () => {
    const h = harness([verdict('docs-skip')], docsPr());
    await runOnce({ store: h.store, github: h.github, readPolicy: () => policy });

    expect(h.merges).toBe(0);
    expect(h.outcomes[0]).toEqual(
      expect.objectContaining({ mutationSent: false, reason: 'spec_only' })
    );
    const comments = policyComments(h.posted);
    expect(comments).toHaveLength(1);
    const lines = comments[0]!.body.split('\n');
    expect(lines[0]).toBe(MARKER);
    expect(lines[1]).toBe('<!-- merge-policy-skip-key:docs-skip:spec_only -->');
    expect(lines[2]).toContain('documentation-only pull requests into dev');
    expect(lines[2]).toContain('a person merges it when ready');
    expect(lines[2]).not.toMatch(/will merge/);
  });

  test('Test 2: each policy reason has its own wording and repo_not_allowed posts nothing', async () => {
    const specOnly = harness([verdict('r-spec')], docsPr());
    await runOnce({ store: specOnly.store, github: specOnly.github, readPolicy: () => policy });

    const wrongBase = harness([verdict('r-base')], greenPr({ baseBranch: 'main' }));
    await runOnce({ store: wrongBase.store, github: wrongBase.github, readPolicy: () => policy });

    const notAllowlisted = harness(
      [
        verdict('r-allow', {
          run_id: 'pr-discovery:thinmansoftware/shopops#1',
          wo_id: 'gh:thinmansoftware/shopops#1',
        }),
      ],
      greenPr({
        baseBranch: 'master',
        pr: { owner: 'thinmansoftware', repo: 'shopops', number: 1 },
      })
    );
    await runOnce({
      store: notAllowlisted.store,
      github: notAllowlisted.github,
      readPolicy: () => policy,
    });

    expect(specOnly.outcomes[0]?.reason).toBe('spec_only');
    expect(wrongBase.outcomes[0]?.reason).toBe('integration_base_mismatch');
    expect(notAllowlisted.outcomes[0]?.reason).toBe('base_not_allowlisted');

    const bodies = [specOnly, wrongBase, notAllowlisted].map(h => {
      const c = policyComments(h.posted);
      expect(c).toHaveLength(1);
      return c[0]!.body.split('\n')[2]!;
    });
    expect(new Set(bodies).size).toBe(3);
    expect(bodies[1]).toContain('main is not a base the merge manager merges unattended');
    expect(bodies[2]).toContain('master is not on the merge manager');

    // repo_not_allowed: no pull request in hand, nothing is posted, nothing throws
    const noRepo = harness(
      [
        verdict('r-repo', {
          run_id: 'pr-discovery:someone/else#7',
          wo_id: 'gh:someone/else#7',
        }),
      ],
      greenPr()
    );
    await expect(
      runOnce({ store: noRepo.store, github: noRepo.github, readPolicy: () => policy })
    ).resolves.toBeUndefined();
    expect(noRepo.outcomes[0]?.reason).toBe('repo_not_allowed');
    expect(noRepo.posted).toEqual([]);
  });

  test('Test 3: the comment is idempotent and a failure never changes the skip', async () => {
    // first evaluation posts; the same verdict evaluated again finds its key line and posts nothing
    const first = harness([verdict('idem')], docsPr());
    await runOnce({ store: first.store, github: first.github, readPolicy: () => policy });
    expect(policyComments(first.posted)).toHaveLength(1);

    const again = harness([verdict('idem')], docsPr(), {
      listPullRequestComments: async () =>
        first.posted.map(c => ({
          authorLogin: BOT,
          body: c.body,
          createdAt: '2026-11-09T00:00:00Z',
        })),
    });
    await runOnce({ store: again.store, github: again.github, readPolicy: () => policy });
    expect(again.outcomes[0]?.reason).toBe('spec_only');
    expect(again.posted).toEqual([]);

    // a key line written by another author does not suppress it
    const forged = harness([verdict('idem')], docsPr(), {
      listPullRequestComments: async () =>
        first.posted.map(c => ({
          authorLogin: 'someone-else',
          body: c.body,
          createdAt: '2026-11-09T00:00:00Z',
        })),
    });
    await runOnce({ store: forged.store, github: forged.github, readPolicy: () => policy });
    expect(policyComments(forged.posted)).toHaveLength(1);

    // a comment API failure is logged and the recorded skip is unchanged
    const captured = captureLogs();
    try {
      const failing = harness([verdict('boom'), verdict('after-boom')], docsPr(), {
        commentOnPullRequest: async () => {
          throw new Error('comment rejected');
        },
      });
      await expect(
        runOnce({ store: failing.store, github: failing.github, readPolicy: () => policy })
      ).resolves.toBeUndefined();
      // the failing comment must not stop the cycle: the next verdict is still processed
      expect(failing.outcomes).toEqual([
        expect.objectContaining({ verdictId: 'boom', mutationSent: false, reason: 'spec_only' }),
        expect.objectContaining({
          verdictId: 'after-boom',
          mutationSent: false,
          reason: 'spec_only',
        }),
      ]);
      expect(
        captured.lines.some(l => l.includes('merge-coordinator.policy_skip_comment_failed'))
      ).toBe(true);
    } finally {
      captured.restore();
    }
  });

  test('Test 3b: the helper itself never throws when the comment API or the listing fails', async () => {
    const captured = captureLogs();
    try {
      const h = harness([], docsPr());
      const base = { store: h.store, github: h.github, readPolicy: () => policy };
      await expect(
        postPolicySkipComment(
          {
            ...base,
            github: {
              ...h.github,
              commentOnPullRequest: async () => {
                throw new Error('comment rejected');
              },
            },
          },
          verdict('direct'),
          docsPr(),
          'spec_only'
        )
      ).resolves.toBeUndefined();
      await expect(
        postPolicySkipComment(
          {
            ...base,
            github: {
              ...h.github,
              listPullRequestComments: async () => {
                throw new Error('listing rejected');
              },
            },
          },
          verdict('direct2'),
          docsPr(),
          'spec_only'
        )
      ).resolves.toBeUndefined();
      expect(
        captured.lines.filter(l => l.includes('merge-coordinator.policy_skip_comment_failed'))
      ).toHaveLength(2);
    } finally {
      captured.restore();
    }
  });

  test('Test 4: a normal merge gets no policy-skip comment', async () => {
    // the default policy first (code PR into bdc-harness dev), then an env policy for bdc-xo main
    const code = harness([verdict('code-pr')], greenPr());
    await runOnce({ store: code.store, github: code.github, readPolicy: () => policy });

    process.env.MERGE_MANAGER_REPO_POLICY = JSON.stringify({
      'thinmansoftware/bdc-xo': { main: { unattended: true, docs_only: 'merge' } },
    });
    const xoDocs = harness(
      [verdict('xo-docs')],
      greenPr({
        baseBranch: 'main',
        changedFilePaths: ['docs/work-orders/WO.md', 'README.md'],
        pr: { owner: 'thinmansoftware', repo: 'bdc-xo', number: 2175 },
      })
    );
    xoDocs.store.getRunById = async () => ({ ...run('xo-docs'), repo: 'bdc-xo' });
    await runOnce({ store: xoDocs.store, github: xoDocs.github, readPolicy: () => policy });

    for (const h of [xoDocs, code]) {
      expect(h.merges).toBe(1);
      expect(h.outcomes[0]).toEqual(
        expect.objectContaining({ mutationSent: true, reason: 'merge_executed' })
      );
      expect(policyComments(h.posted)).toEqual([]);
      expect(h.posted.some(c => c.body.includes('<!-- merge-manager-receipt -->'))).toBe(true);
    }
  });
});
