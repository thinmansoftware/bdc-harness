/**
 * WO-HARNESS-MERGE-OWNER-REWORKING-GUARD-01
 *
 * A PR labelled owner:reworking must not merge while its owner redoes the design. The label is
 * set and cleared only by the owner; it is NOT HOLD (John's). A red NON-required check with no
 * owner signal must still merge (WO-HARNESS-MERGE-MANAGER-REQUIRED-CHECKS-ONLY-01 stays true).
 *
 * The bridge harness below is a deliberate copy of the private helpers in
 * merge-execution-bridge.test.ts, so that 2,281-line file stays untouched.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { removeTempDirWithRetry } from '@archon/core/test/temp-dir';
import { join } from 'path';
import { closeDatabase, getDatabase, getOperatorCard, resetDatabase } from '@archon/core/db';
import type { OverseerVerdictRow, OverseerWatchRun } from '@archon/core/db/overseer';
import { listOwnerLabels, parseOwnerLabel } from '@archon/core/github/owner-label';
import { rootLogger } from '@archon/paths';
import {
  REQUIRED_CONTEXTS_MAX_ATTEMPTS_ENV,
  REQUIRED_CONTEXTS_OVERRIDE_ENV,
  resetRequiredContextsAttemptCounters,
  resetRequiredContextsCache,
} from '../adapters/required-contexts.ts';
import {
  classifyDiscoveredPullRequest,
  discoverMergeCandidates,
  OWNER_REWORKING_LABEL,
} from '../merge-candidate-discovery.ts';
import {
  runMergeExecutionBridgeOnce as runMergeExecutionBridgeOnceProduction,
  type MergeExecutionBridgeOptions,
  type MergeExecutionBridgeStore,
} from '../merge-execution-bridge';
import { runEscalation } from '../escalate';
import {
  runPostMergeStraySweepOnce,
  type BranchState,
  type StrayBranchReader,
} from '../post-merge-stray-sweep';
import type { RecheckCheckRun } from '../pr-review-check-ingest.ts';
import type {
  DiscoveredPullRequest,
  GitHubClientDeps,
  MergeCandidateDiscoveryDeps,
  PullRequestEvidence,
} from '../types.ts';

const runMergeExecutionBridgeOnce = (options: MergeExecutionBridgeOptions): Promise<void> =>
  runMergeExecutionBridgeOnceProduction({
    readRunEvents: async () => [],
    hasQualifiedReview: async () => true,
    reviewConflictAtHead: async () => null,
    ...options,
  });

const verdict = (id: string, head = 'judged-sha'): OverseerVerdictRow =>
  ({
    id,
    run_id: `run-${id}`,
    wo_id: 'WO-TEST',
    head_sha: head,
    proposed_action: 'flag_merge_ready',
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

function policy(merge = true) {
  return {
    service_enabled: true,
    emergency_stop: false,
    legacy_dry_run: false,
    capability_flags: {
      escalation: false,
      repair: false,
      branch: false,
      lifecycle: false,
      merge,
    },
  } as const;
}

function harness(
  rows: OverseerVerdictRow[],
  evidence = greenPr(),
  githubExtras: Partial<GitHubClientDeps> = {}
) {
  const pending = [...rows];
  const outcomes: { verdictId: string; mutationSent: boolean; reason: string }[] = [];
  const claimReleases: { verdictId: string; reason: string }[] = [];
  const processing = new Set<string>();
  let merges = 0;
  let approvals = 0;
  let occupied = 0;
  const slots = new Map<string, { released: boolean }>();
  const store: MergeExecutionBridgeStore = {
    listUnactionedVerdicts: async () => [...pending],
    claimVerdict: async verdictId => {
      if (!pending.some(row => row.id === verdictId)) return false;
      processing.add(verdictId);
      return true;
    },
    releaseVerdictClaim: async (verdictId, reason) => {
      if (!processing.has(verdictId)) return false;
      processing.delete(verdictId);
      claimReleases.push({ verdictId, reason });
      return true;
    },
    getRunById: async runId => run(runId.replace('run-', '')),
    getEarliestMergeSlotReservation: async () =>
      new Date(Date.now() - 50 * 60 * 1000).toISOString(),
    reserveMergeSlot: async (verdictId, _since, limit) => {
      const existing = slots.get(verdictId);
      if (existing && !existing.released) return false;
      if (occupied >= limit) return false;
      occupied += 1;
      slots.set(verdictId, { released: false });
      return true;
    },
    releaseMergeSlot: async verdictId => {
      const existing = slots.get(verdictId);
      if (!existing || existing.released) return;
      existing.released = true;
      occupied -= 1;
    },
    recordOutcome: async input => {
      outcomes.push(input);
      processing.delete(input.verdictId);
      const index = pending.findIndex(row => row.id === input.verdictId);
      if (index >= 0) pending.splice(index, 1);
    },
  };
  const github: GitHubClientDeps = {
    findPullRequest: async () => evidence,
    approvePullRequest: async input => {
      expect(input.expectedHeadSha).toBe('judged-sha');
      approvals += 1;
      return { approved: true };
    },
    mergePullRequest: async input => {
      expect(input.mergeMethod).toBe('squash');
      expect(input.expectedHeadSha).toBe('judged-sha');
      merges += 1;
      return { merged: true, mergeSha: 'merge-sha' };
    },
    listPullRequestComments: async () => [],
    commentOnPullRequest: async () => ({ commented: true }),
    ...githubExtras,
  };
  return {
    store,
    github,
    outcomes,
    claimReleases,
    get merges() {
      return merges;
    },
    get approvals() {
      return approvals;
    },
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

const evaluate = (h: ReturnType<typeof harness>): Promise<void> =>
  runMergeExecutionBridgeOnce({ store: h.store, github: h.github, readPolicy: () => policy() });

function checkRun(
  id: number,
  name: string,
  status: string,
  conclusion: string | null
): RecheckCheckRun {
  return { id, name, status, conclusion, completed_at: `2026-11-0${id}T00:00:00.000Z` };
}

const requiredContexts = ['docker-build', 'test (ubuntu-latest)'] as const;
const contextsLookup = (
  contexts: readonly string[]
): NonNullable<GitHubClientDeps['requiredContextsLookups']> => ({
  fetchWithAppClient: async () => ({ data: [...contexts] }),
});

beforeEach(() => {
  resetRequiredContextsCache();
  resetRequiredContextsAttemptCounters();
  delete process.env[REQUIRED_CONTEXTS_OVERRIDE_ENV];
  delete process.env[REQUIRED_CONTEXTS_MAX_ATTEMPTS_ENV];
});

afterEach(() => {
  resetRequiredContextsCache();
  resetRequiredContextsAttemptCounters();
  delete process.env[REQUIRED_CONTEXTS_OVERRIDE_ENV];
  delete process.env[REQUIRED_CONTEXTS_MAX_ATTEMPTS_ENV];
  delete process.env.OVERSEER_MAX_MERGES_PER_HOUR;
  delete process.env.OVERSEER_MERGE_REPO_CONFIG;
  delete process.env.MERGE_MANAGER_REPO_POLICY;
});

describe('owner:reworking merge guard', () => {
  test('Test 1: an approved, green PR labelled owner:reworking is not merged and its claim is released', async () => {
    const shapes: { name: string; row: OverseerVerdictRow; number: number }[] = [
      { name: 'originating-run verdict', row: verdict('reworking-run'), number: 1 },
      {
        name: 'discovered PR',
        row: {
          ...verdict('reworking-disc'),
          run_id: 'pr-discovery:thinmansoftware/bdc-harness#7',
          wo_id: 'gh:thinmansoftware/bdc-harness#7',
        },
        number: 7,
      },
    ];
    for (const shape of shapes) {
      const capture = captureRootLogLines();
      try {
        const h = harness(
          [shape.row],
          greenPr({
            labels: [OWNER_REWORKING_LABEL],
            pr: { owner: 'thinmansoftware', repo: 'bdc-harness', number: shape.number },
          })
        );
        await evaluate(h);
        expect(h.merges).toBe(0);
        expect(h.approvals).toBe(0);
        expect(h.outcomes).toEqual([]);
        expect(h.claimReleases).toEqual([
          { verdictId: String(shape.row.id), reason: 'owner_reworking_label' },
        ]);
        expect(
          capture.lines.some(line => line.includes('merge-coordinator.owner_reworking_label'))
        ).toBe(true);
      } finally {
        capture.restore();
      }
    }
  });

  test('Test 2: discovery excludes the same PR with the named exclusion', async () => {
    const OWNER = 'thinmansoftware';
    const REPO = 'bdc-harness';
    const labelled: DiscoveredPullRequest = {
      owner: OWNER,
      repo: REPO,
      prNumber: 920,
      title: 'pull request 920',
      state: 'open',
      draft: false,
      baseRef: 'dev',
      headRef: 'feat/pr-920',
      headSha: 'sha-920',
      reviewDecision: 'APPROVED',
      labels: [OWNER_REWORKING_LABEL],
    };
    const clean: DiscoveredPullRequest = {
      ...labelled,
      prNumber: 921,
      title: 'pull request 921',
      headRef: 'feat/pr-921',
      headSha: 'sha-921',
      labels: [],
    };
    expect(classifyDiscoveredPullRequest(labelled, ['dev', 'staging'])).toBe(
      'owner_reworking_label'
    );
    expect(classifyDiscoveredPullRequest(clean, ['dev', 'staging'])).toBeNull();

    const evidenceFor = (n: number): PullRequestEvidence => ({
      exists: true,
      state: 'open',
      checks: { total: 4, passed: 4, failed: 0, pending: 0 },
      mergeable: true,
      pr: { owner: OWNER, repo: REPO, number: n },
      prTitle: `pull request ${n}`,
      headSha: `sha-${n}`,
      lookupFailed: false,
    });
    const deps: MergeCandidateDiscoveryDeps = {
      listOpenPullRequests: async () => [labelled, clean],
      hasQualifiedReview: async () => true,
      findPullRequest: async input => {
        const match = [labelled, clean].find(candidate => candidate.headRef === input.headBranch);
        if (!match) throw new Error(`no fixture evidence for ${String(input.headBranch)}`);
        return evidenceFor(match.prNumber);
      },
    };
    const result = await discoverMergeCandidates(deps, {
      watchedBases: ['dev', 'staging'],
      repos: [{ owner: OWNER, repo: REPO }],
    });
    expect(result.candidates.map(c => c.prEvidence.pr?.number)).toEqual([921]);
    const excluded = result.exclusions.find(e => e.prNumber === 920);
    expect(excluded?.reason).toBe('owner_reworking_label');
    expect(excluded?.detail).toContain('owner:reworking');
  });

  test('Test 3: clearing the label frees the PR and it merges once', async () => {
    let current = greenPr({ labels: [OWNER_REWORKING_LABEL] });
    const h = harness([verdict('reworking-cleared')], current, {
      findPullRequest: async () => current,
    });
    await evaluate(h);
    expect(h.merges).toBe(0);
    expect(h.claimReleases).toEqual([
      { verdictId: 'reworking-cleared', reason: 'owner_reworking_label' },
    ]);

    current = greenPr({ labels: [] });
    await evaluate(h);
    expect(h.merges).toBe(1);
    expect(h.outcomes).toEqual([
      expect.objectContaining({ verdictId: 'reworking-cleared', reason: 'merge_executed' }),
    ]);
    await evaluate(h);
    expect(h.merges).toBe(1);
  });

  test('Test 4: owner:reworking is a state, not a login', () => {
    expect(parseOwnerLabel(JSON.stringify([OWNER_REWORKING_LABEL]))).toBeNull();
    expect(parseOwnerLabel(JSON.stringify(['owner:Reworking']))).toBeNull();
    expect(parseOwnerLabel(JSON.stringify(['owner:REWORKING']))).toBeNull();
    expect(listOwnerLabels([OWNER_REWORKING_LABEL, 'owner:Reworking'])).toEqual([]);
    // real owner labels are unaffected, including next to the state label
    expect(parseOwnerLabel(JSON.stringify(['owner:alice']))).toBe('alice');
    expect(parseOwnerLabel(JSON.stringify([OWNER_REWORKING_LABEL, 'owner:alice']))).toBe('alice');
    expect(listOwnerLabels(['owner:alice', OWNER_REWORKING_LABEL, 'owner:bob'])).toEqual([
      'alice',
      'bob',
    ]);
    // a login that merely contains the word is still a login
    expect(parseOwnerLabel(JSON.stringify(['owner:reworking-bot']))).toBe('reworking-bot');
  });

  test('Test 5: a red NON-required check with no owner signal still merges; with the label it does not', async () => {
    const evidence = (labels: string[]): PullRequestEvidence =>
      greenPr({
        mergeableState: 'unstable',
        checks: { total: 3, passed: 2, failed: 1, pending: 0 },
        labels,
        checkRuns: [
          checkRun(1, 'docker-build', 'completed', 'success'),
          checkRun(2, 'test (ubuntu-latest)', 'completed', 'success'),
          checkRun(3, 'channel-vocabulary-postgres', 'completed', 'failure'),
        ],
      });

    const free = harness([verdict('red-nonrequired')], evidence([]), {
      requiredContextsLookups: contextsLookup(requiredContexts),
    });
    await evaluate(free);
    expect(free.merges).toBe(1);
    expect(free.outcomes[0]).toEqual(
      expect.objectContaining({ mutationSent: true, reason: 'merge_executed' })
    );

    const held = harness([verdict('red-nonrequired-held')], evidence([OWNER_REWORKING_LABEL]), {
      requiredContextsLookups: contextsLookup(requiredContexts),
    });
    await evaluate(held);
    expect(held.merges).toBe(0);
    expect(held.claimReleases).toEqual([
      { verdictId: 'red-nonrequired-held', reason: 'owner_reworking_label' },
    ]);
  });

  test('Test 6: a moved head is never merged (stale verdict, and a head that moves after the claim)', async () => {
    // (a) the verdict approved judged-sha but the live head is already moved-sha
    const stale = harness([verdict('stale')], greenPr({ headSha: 'moved-sha' }));
    await evaluate(stale);
    expect(stale.merges).toBe(0);
    expect(stale.outcomes).toEqual([
      expect.objectContaining({ verdictId: 'stale', reason: 'verdict_stale_head' }),
    ]);

    // (b) the head moves between the claim and the merge call: the merge call is pinned to the
    // APPROVED head, so GitHub refuses it, and the bridge never records a merge.
    const pinned: (string | undefined)[] = [];
    const moved = harness([verdict('moved-after-claim')], greenPr(), {
      mergePullRequest: async input => {
        pinned.push(input.expectedHeadSha);
        return { merged: false, message: 'head_moved' };
      },
    });
    await evaluate(moved);
    expect(pinned).toEqual(['judged-sha']);
    expect(moved.merges).toBe(0);
    expect(moved.outcomes.some(o => o.reason === 'merge_executed')).toBe(false);
  });
});

// Rule (d): a push after the squash merge raises ONE alert per PR and stray sha.
describe.serial('post-merge stray-push sweep', () => {
  let home = '';
  const originalHome = process.env.ARCHON_HOME;
  const originalUrl = process.env.DATABASE_URL;
  const originalMode = process.env.OVERSEER_OWNER_ROUTING;

  beforeEach(async () => {
    await closeDatabase();
    resetDatabase();
    home = join(import.meta.dir, `.archon-merge-sweep-${Date.now()}-${Math.random()}`);
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

  test('Test 7: a push after the squash merge raises one alert, and a second sweep raises none', async () => {
    const mergedHead = 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111';
    const strayHead = 'bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222';
    const base = {
      run_id: 'run-stray',
      wo_id: 'WO-STRAY-01',
      updated_at: '2026-11-08T10:00:00.000Z',
    };
    const rows = [
      {
        ...base,
        id: 'v1',
        pr_url: 'https://github.com/thinmansoftware/bdc-xo/pull/101',
        head_sha: mergedHead,
      },
      {
        ...base,
        id: 'v2',
        pr_url: 'https://github.com/thinmansoftware/bdc-xo/pull/102',
        head_sha: 'cccc3333',
      },
      {
        ...base,
        id: 'v3',
        pr_url: 'https://github.com/thinmansoftware/bdc-xo/pull/103',
        head_sha: 'dddd4444',
      },
    ];
    const headRefs: Record<number, string> = {
      101: 'fix/stray-one',
      102: 'fix/gone-two',
      103: 'fix/same-three',
    };
    const branches: Record<string, BranchState> = {
      'fix/stray-one': { state: 'exists', sha: strayHead },
      'fix/gone-two': { state: 'gone' },
      'fix/same-three': { state: 'exists', sha: 'dddd4444' },
    };
    const reader: StrayBranchReader = {
      readPullRequestHead: async ({ number, owner, repo }) => {
        const branch = headRefs[number];
        return branch === undefined ? undefined : { branch, owner, repo };
      },
      readBranch: async ({ branch }) => branches[branch] ?? { state: 'unknown' },
    };
    const sinces: string[] = [];
    let escalations = 0;
    const options = {
      listMerged: async (sinceIso: string) => {
        sinces.push(sinceIso);
        return rows;
      },
      reader,
      now: new Date('2026-11-09T12:00:00.000Z'),
      escalate: ((...args: Parameters<typeof runEscalation>) => {
        escalations += 1;
        return runEscalation(...args);
      }) as typeof runEscalation,
    };

    const first = await runPostMergeStraySweepOnce(options);
    const second = await runPostMergeStraySweepOnce(options);

    // only the merged-in-the-last-7-days window is asked for
    expect(sinces).toEqual(['2026-11-02T12:00:00.000Z', '2026-11-02T12:00:00.000Z']);
    // exactly one alert, for the first PR and the stray sha, naming PR, branch and sha
    expect(first.examined).toBe(3);
    expect(first.alerted).toHaveLength(1);
    expect(first.alerted[0]).toMatchObject({
      prUrl: 'https://github.com/thinmansoftware/bdc-xo/pull/101',
      branch: 'fix/stray-one',
      straySha: strayHead,
    });
    expect(first.noStray).toBe(2);
    // the second sweep raises nothing and never re-enters the escalation path
    expect(second.alerted).toHaveLength(0);
    expect(second.alreadyAlerted).toBe(1);
    expect(escalations).toBe(1);

    const cards = await getDatabase().query<{ n: number | string }>(
      'SELECT COUNT(*) AS n FROM overseer_operator_cards'
    );
    expect(Number(cards.rows[0]?.n)).toBe(1);
    const view = await getOperatorCard(first.alerted[0]!.cardId);
    expect(view?.jobs).toHaveLength(2);
    expect(view?.card.pr_url).toBe('https://github.com/thinmansoftware/bdc-xo/pull/101');
    expect(view?.card.branch).toBe('fix/stray-one');
    expect(view?.card.head_sha).toBe(strayHead);
    expect(view?.card.blocker).toContain('fix/stray-one');
    expect(view?.card.blocker).toContain(strayHead);
    expect(view?.card.blocker).toContain('pull/101');
  });
});
