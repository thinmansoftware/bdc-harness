import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createBranchMutationAdapter,
  type BranchMutationAdapterV1,
  type BranchMutationDepsV1,
  type BranchRewriteResultV1,
  type RebaseConflictProbeV1,
  type WorktreeObservationV1,
} from '../adapters/branch-mutation';
import {
  assessBranchRefreshCandidate,
  classifyRebaseConflict,
  executeRefreshRebase,
  requirePostRewriteEvidence,
  type BranchCandidateInputV1,
  type ExecuteRefreshRebaseDepsV1,
  type ExecuteRefreshRebaseInputV1,
  type InjectedActionPolicyDepsV1,
  type RefreshRebaseGateDepsV1,
} from '../actions/refresh-rebase';

// ---------------------------------------------------------------------------
// Real local-Git fixture helpers. These live in the (unlinted, un-type-checked)
// test file only; the two source files never shell out or import a Git package.
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.com',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.com',
    },
  }).trim();
}

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function initRepo(): string {
  const dir = makeTempDir('rr-repo-');
  git(dir, ['init', '--initial-branch', 'main']);
  git(dir, ['config', 'user.email', 'fixture@example.com']);
  git(dir, ['config', 'user.name', 'Fixture']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  return dir;
}

function writeAndCommit(repo: string, file: string, content: string, message: string): string {
  const abs = join(repo, file);
  const parts = file.split('/');
  if (parts.length > 1) {
    mkdirSync(join(repo, parts.slice(0, -1).join('/')), { recursive: true });
  }
  writeFileSync(abs, content);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-m', message]);
  return git(repo, ['rev-parse', 'HEAD']);
}

function detectConflict(repo: string, baseSha: string): RebaseConflictProbeV1 {
  const head = git(repo, ['rev-parse', 'HEAD']);
  const scratch = makeTempDir('rr-probe-');
  rmSync(scratch, { recursive: true, force: true });
  git(repo, ['worktree', 'add', '--detach', scratch, head]);
  try {
    try {
      git(scratch, ['rebase', baseSha]);
      return { conflicted: false, conflict_paths: [], conflict_signal: 'none' };
    } catch {
      const paths = git(scratch, ['diff', '--name-only', '--diff-filter=U'])
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0);
      try {
        git(scratch, ['rebase', '--abort']);
      } catch {
        // already aborted
      }
      let signal: RebaseConflictProbeV1['conflict_signal'] = 'logic';
      try {
        git(scratch, ['rebase', '-X', 'ignore-all-space', baseSha]);
        signal = 'whitespace';
        try {
          git(scratch, ['rebase', '--abort']);
        } catch {
          // clean rebase left nothing to abort
        }
      } catch {
        signal = 'logic';
        try {
          git(scratch, ['rebase', '--abort']);
        } catch {
          // already aborted
        }
      }
      return { conflicted: true, conflict_paths: paths, conflict_signal: signal };
    }
  } finally {
    try {
      git(repo, ['worktree', 'remove', '--force', scratch]);
    } catch {
      // best-effort cleanup
    }
  }
}

/** Real-Git-backed injected primitives for a repo whose branch is checked out. */
function makeGitMutationDeps(repo: string): BranchMutationDepsV1 {
  return {
    async observeWorktree({ branch }): Promise<WorktreeObservationV1> {
      const status = git(repo, ['status', '--porcelain']);
      return {
        clean: status.length === 0,
        current_branch: git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']),
        head_sha: git(repo, ['rev-parse', 'HEAD']),
        factory_owned: branch.startsWith('wo/'),
      };
    },
    async countUniqueCommits({ base_sha, head_sha }): Promise<number> {
      return Number(git(repo, ['rev-list', '--count', `${base_sha}..${head_sha}`]));
    },
    async probeRebase({ base_sha }): Promise<RebaseConflictProbeV1> {
      return detectConflict(repo, base_sha);
    },
    async applyRefresh({ base_sha }): Promise<BranchRewriteResultV1> {
      git(repo, ['reset', '--hard', base_sha]);
      return {
        status: 'rewritten',
        new_head_sha: git(repo, ['rev-parse', 'HEAD']),
        new_tree_sha: git(repo, ['rev-parse', 'HEAD^{tree}']),
      };
    },
    async applyRebase({ base_sha }): Promise<BranchRewriteResultV1> {
      try {
        git(repo, ['rebase', base_sha]);
        return {
          status: 'rewritten',
          new_head_sha: git(repo, ['rev-parse', 'HEAD']),
          new_tree_sha: git(repo, ['rev-parse', 'HEAD^{tree}']),
        };
      } catch {
        const paths = git(repo, ['diff', '--name-only', '--diff-filter=U'])
          .split('\n')
          .map(line => line.trim())
          .filter(line => line.length > 0);
        try {
          git(repo, ['rebase', '--abort']);
        } catch {
          // already aborted
        }
        return {
          status: 'conflict',
          probe: { conflicted: true, conflict_paths: paths, conflict_signal: 'logic' },
        };
      }
    },
    async readTreeSha({ ref }): Promise<string> {
      return git(repo, ['rev-parse', `${ref}^{tree}`]);
    },
  };
}

// ---------------------------------------------------------------------------
// Fake M-31 gate + policy seams.
// ---------------------------------------------------------------------------

interface ReceiptStub {
  receipt_event_id: string;
  event_type: string;
  event_sequence: number;
}

function makeReceipt(eventType: string, sequence: number): ReceiptStub {
  return {
    receipt_event_id: `r-${eventType}-${sequence}`,
    event_type: eventType,
    event_sequence: sequence,
  };
}

interface PermitStub {
  permit_id: string;
  proposal_id: string;
  execution_id: string;
  capability: string;
}

function makePermit(proposalId: string): PermitStub {
  return {
    permit_id: `permit-${proposalId}`,
    proposal_id: proposalId,
    execution_id: `exec-${proposalId}`,
    capability: 'overseer.m31.rebase',
  };
}

interface GateOpts {
  prepareDenied?: string;
  authDenied?: string;
  reserveFailure?: string;
  recordOutcomeFailure?: string;
}

function makeGate(
  order: string[],
  opts: GateOpts = {}
): RefreshRebaseGateDepsV1 & { order: string[] } {
  return {
    order,
    async preparePermit({ proposal_id }) {
      order.push('prepare');
      if (opts.prepareDenied) return { ok: false, denied: opts.prepareDenied };
      return {
        ok: true,
        permit: makePermit(proposal_id) as never,
        receipt: makeReceipt('permit_issued', 1) as never,
      };
    },
    async authorizeBranchAction() {
      order.push('authorize');
      if (opts.authDenied) return { allowed: false, reason: opts.authDenied };
      return { allowed: true };
    },
    async reserveEffect() {
      order.push('reserve');
      if (opts.reserveFailure) return { ok: false, failure: opts.reserveFailure as never };
      return { ok: true, receipt: makeReceipt('effect_reserved', 2) as never };
    },
    async recordOutcome({ outcome }) {
      order.push(`outcome:${outcome}`);
      if (opts.recordOutcomeFailure) {
        return { ok: false, failure: opts.recordOutcomeFailure as never };
      }
      return { ok: true, receipt: makeReceipt(outcome, 3) as never };
    },
  };
}

function eligiblePolicy(): InjectedActionPolicyDepsV1 {
  return {
    evaluateActionPolicy() {
      return { eligible: true, base_eligible: true, effect_allowed: true };
    },
  };
}

function greenEvidence(newHead: string): ExecuteRefreshRebaseDepsV1['fetchPostRewriteEvidence'] {
  return async () => ({
    ci: { head_sha: newHead, green: true },
    review: { reviewed_head_sha: newHead, verdict: 'APPROVE', independent: true },
  });
}

function baseCandidate(
  over: Partial<BranchCandidateInputV1>
): ExecuteRefreshRebaseInputV1['candidate'] {
  return {
    repository: 'bluedevilcollectibles/bdc-harness',
    branch: 'wo/harness-overseer-refresh-rebase-01',
    worktree_path: '/fixture',
    branch_gate_enabled: true,
    policy_digest: 'a'.repeat(64),
    verifier_registry_digest: 'b'.repeat(64),
    run_authority: {
      run_id: 'run-1',
      head_sha: 'head',
      base_branch: 'main',
      base_sha: 'base',
      factory_created: true,
      ...(over.run_authority ?? {}),
    },
    pr_snapshot: over.pr_snapshot ?? {
      pr_number: 42,
      head_sha: 'head',
      base_branch: 'main',
      base_sha: 'base',
    },
    ...over,
  } as ExecuteRefreshRebaseInputV1['candidate'];
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

// ---------------------------------------------------------------------------
// Test 1 -- clean refresh
// ---------------------------------------------------------------------------

describe('refresh-rebase Test 1 clean refresh', () => {
  test('authorized REFRESH resets branch to advanced base and records reserved+succeeded', async () => {
    const repo = initRepo();
    writeAndCommit(repo, 'a.txt', 'a\n', 'A');
    git(repo, ['checkout', '-b', 'wo/refresh']);
    const branchHead = git(repo, ['rev-parse', 'HEAD']);
    git(repo, ['checkout', 'main']);
    writeAndCommit(repo, 'b.txt', 'b\n', 'B');
    const baseHead = writeAndCommit(repo, 'c.txt', 'c\n', 'C');
    git(repo, ['checkout', 'wo/refresh']);

    const observer = makeGitMutationDeps(repo);
    const performSpy = mock(async (req: Parameters<BranchMutationAdapterV1['perform']>[0]) =>
      createBranchMutationAdapter(observer).perform(req)
    );
    const order: string[] = [];
    const gate = makeGate(order);

    const input: ExecuteRefreshRebaseInputV1 = {
      candidate: baseCandidate({
        branch: 'wo/refresh',
        worktree_path: repo,
        run_authority: {
          run_id: 'run-1',
          head_sha: branchHead,
          base_branch: 'main',
          base_sha: baseHead,
          factory_created: true,
        },
        pr_snapshot: {
          pr_number: 1,
          head_sha: branchHead,
          base_branch: 'main',
          base_sha: baseHead,
        },
      }),
      proposal_id: 'p-refresh',
      actor: 'overseer',
      correlation_id: 'corr-1',
    };

    const result = await executeRefreshRebase(input, {
      policy: eligiblePolicy(),
      observer,
      adapter: { perform: performSpy },
      gate,
      fetchPostRewriteEvidence: greenEvidence(baseHead),
    });

    expect(result.outcome).toBe('succeeded');
    expect(result.mode).toBe('REFRESH');
    // Fixture head now equals base head.
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(baseHead);
    expect(result.new_head_sha).toBe(baseHead);
    expect(performSpy).toHaveBeenCalledTimes(1);
    expect(result.receipt_types).toEqual(['permit_issued', 'effect_reserved', 'effect_succeeded']);
    expect(result.receipt_types.filter(t => t === 'effect_reserved')).toHaveLength(1);
    expect(result.receipt_types.filter(t => t === 'effect_succeeded')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Test 2 -- conflict-free rebase
// ---------------------------------------------------------------------------

describe('refresh-rebase Test 2 conflict-free rebase', () => {
  test('unique non-conflicting commit is replayed onto new base with tree preserved', async () => {
    const repo = initRepo();
    writeAndCommit(repo, 'a.txt', 'a\n', 'A');
    git(repo, ['checkout', '-b', 'wo/rebase']);
    const branchHead = writeAndCommit(repo, 'feature.txt', 'feature\n', 'U feature');
    const uniqueBlob = git(repo, ['rev-parse', 'HEAD:feature.txt']);
    git(repo, ['checkout', 'main']);
    const baseHead = writeAndCommit(repo, 'other.txt', 'other\n', 'B other');
    git(repo, ['checkout', 'wo/rebase']);

    const observer = makeGitMutationDeps(repo);
    const performSpy = mock(async (req: Parameters<BranchMutationAdapterV1['perform']>[0]) =>
      createBranchMutationAdapter(observer).perform(req)
    );
    const order: string[] = [];

    const result = await executeRefreshRebase(
      {
        candidate: baseCandidate({
          branch: 'wo/rebase',
          worktree_path: repo,
          run_authority: {
            run_id: 'run-2',
            head_sha: branchHead,
            base_branch: 'main',
            base_sha: baseHead,
            factory_created: true,
          },
          pr_snapshot: {
            pr_number: 2,
            head_sha: branchHead,
            base_branch: 'main',
            base_sha: baseHead,
          },
        }),
        proposal_id: 'p-rebase',
        actor: 'overseer',
        correlation_id: 'corr-2',
      },
      {
        policy: eligiblePolicy(),
        observer,
        adapter: { perform: performSpy },
        gate: makeGate(order),
        fetchPostRewriteEvidence: async ({ new_head_sha }) => ({
          ci: { head_sha: new_head_sha, green: true },
          review: { reviewed_head_sha: new_head_sha, verdict: 'APPROVE', independent: true },
        }),
      }
    );

    expect(result.outcome).toBe('succeeded');
    expect(result.mode).toBe('REBASE');
    // The unique tree is preserved on the new base: same blob, parent is the base.
    expect(git(repo, ['rev-parse', 'HEAD:feature.txt'])).toBe(uniqueBlob);
    expect(git(repo, ['rev-parse', 'HEAD~1'])).toBe(baseHead);
    expect(performSpy).toHaveBeenCalledTimes(1);

    // Old CI/review evidence (bound to the pre-rewrite head) is rejected.
    const stale = requirePostRewriteEvidence({
      new_head_sha: result.new_head_sha as string,
      ci: { head_sha: branchHead, green: true },
      review: { reviewed_head_sha: branchHead, verdict: 'APPROVE', independent: true },
    });
    expect(stale.satisfied).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 3 -- every conflict fails closed
// ---------------------------------------------------------------------------

describe('refresh-rebase Test 3 every conflict fails closed', () => {
  const cases: { name: string; probe: RebaseConflictProbeV1; expected: string }[] = [
    { name: 'ownership', probe: probe(['CODEOWNERS'], 'logic'), expected: 'ownership' },
    {
      name: 'security',
      probe: probe(['packages/server/src/auth.ts'], 'logic'),
      expected: 'security',
    },
    {
      name: 'migration',
      probe: probe(['migrations/034_overseer.sql'], 'logic'),
      expected: 'migration',
    },
    {
      name: 'schema',
      probe: probe(['packages/core/src/db/schema.ts'], 'logic'),
      expected: 'schema',
    },
    {
      name: 'release_contract',
      probe: probe(['CHANGELOG.md'], 'logic'),
      expected: 'release_contract',
    },
    {
      name: 'generated',
      probe: probe(['packages/web/src/lib/api.generated.ts'], 'logic'),
      expected: 'generated',
    },
    { name: 'mechanical', probe: probe(['notes.txt'], 'whitespace'), expected: 'mechanical' },
    {
      name: 'semantic',
      probe: probe(['packages/overseer/src/logic.ts'], 'logic'),
      expected: 'semantic',
    },
    { name: 'unknown', probe: probe([], 'none'), expected: 'unknown' },
  ];

  function probe(
    paths: string[],
    signal: RebaseConflictProbeV1['conflict_signal']
  ): RebaseConflictProbeV1 {
    return { conflicted: true, conflict_paths: paths, conflict_signal: signal };
  }

  for (const c of cases) {
    test(`classifyRebaseConflict records exact disposition for ${c.name}`, () => {
      expect(classifyRebaseConflict(c.probe)).toBe(c.expected);
    });

    test(`assessment escalates and never touches the adapter for ${c.name}`, () => {
      const assessment = assessBranchRefreshCandidate(
        {
          ...(baseCandidate({}) as BranchCandidateInputV1),
          worktree: {
            clean: true,
            current_branch: 'wo/harness-overseer-refresh-rebase-01',
            head_sha: 'head',
            factory_owned: true,
          },
          unique_commits: 1,
          rebase_probe: c.probe,
        },
        { policy: eligiblePolicy() }
      );
      if (c.name === 'unknown') {
        // Empty-path conflict still escalates as unknown.
        expect(assessment.disposition).toBe('escalate');
      } else {
        expect(assessment.disposition).toBe('escalate');
      }
      expect(assessment.disposition === 'escalate' && assessment.conflict_class).toBe(c.expected);
    });
  }

  test('real Git conflict drives executeRefreshRebase to escalate with zero adapter calls', async () => {
    const repo = initRepo();
    writeAndCommit(repo, 'src/logic.ts', 'export const v = 1;\n', 'A');
    git(repo, ['checkout', '-b', 'wo/conflict']);
    const branchHead = writeAndCommit(
      repo,
      'src/logic.ts',
      'export const v = 2;\n',
      'branch change'
    );
    git(repo, ['checkout', 'main']);
    const baseHead = writeAndCommit(repo, 'src/logic.ts', 'export const v = 3;\n', 'base change');
    git(repo, ['checkout', 'wo/conflict']);

    const observer = makeGitMutationDeps(repo);
    const performSpy = mock(async (req: Parameters<BranchMutationAdapterV1['perform']>[0]) =>
      createBranchMutationAdapter(observer).perform(req)
    );
    const order: string[] = [];

    const result = await executeRefreshRebase(
      {
        candidate: baseCandidate({
          branch: 'wo/conflict',
          worktree_path: repo,
          run_authority: {
            run_id: 'run-3',
            head_sha: branchHead,
            base_branch: 'main',
            base_sha: baseHead,
            factory_created: true,
          },
          pr_snapshot: {
            pr_number: 3,
            head_sha: branchHead,
            base_branch: 'main',
            base_sha: baseHead,
          },
        }),
        proposal_id: 'p-conflict',
        actor: 'overseer',
        correlation_id: 'corr-3',
      },
      {
        policy: eligiblePolicy(),
        observer,
        adapter: { perform: performSpy },
        gate: makeGate(order),
        fetchPostRewriteEvidence: greenEvidence('unused'),
      }
    );

    expect(result.outcome).toBe('escalate');
    expect(result.conflict_class).toBe('semantic');
    expect(performSpy).toHaveBeenCalledTimes(0);
    expect(order).toEqual([]);
    // Branch head unchanged -- no rewrite occurred.
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(branchHead);
  });
});

// ---------------------------------------------------------------------------
// Test 4 -- unowned or dirty branch fails closed before permit
// ---------------------------------------------------------------------------

describe('refresh-rebase Test 4 unowned or dirty branch', () => {
  test('dirty worktree fails closed before any permit or adapter call', async () => {
    const repo = initRepo();
    writeAndCommit(repo, 'a.txt', 'a\n', 'A');
    git(repo, ['checkout', '-b', 'wo/dirty']);
    const branchHead = git(repo, ['rev-parse', 'HEAD']);
    git(repo, ['checkout', 'main']);
    const baseHead = writeAndCommit(repo, 'b.txt', 'b\n', 'B');
    git(repo, ['checkout', 'wo/dirty']);
    writeFileSync(join(repo, 'a.txt'), 'dirty\n'); // uncommitted change

    const observer = makeGitMutationDeps(repo);
    const performSpy = mock(async (req: Parameters<BranchMutationAdapterV1['perform']>[0]) =>
      createBranchMutationAdapter(observer).perform(req)
    );
    const order: string[] = [];

    const result = await executeRefreshRebase(
      {
        candidate: baseCandidate({
          branch: 'wo/dirty',
          worktree_path: repo,
          run_authority: {
            run_id: 'run-4',
            head_sha: branchHead,
            base_branch: 'main',
            base_sha: baseHead,
            factory_created: true,
          },
          pr_snapshot: {
            pr_number: 4,
            head_sha: branchHead,
            base_branch: 'main',
            base_sha: baseHead,
          },
        }),
        proposal_id: 'p-dirty',
        actor: 'overseer',
        correlation_id: 'corr-4',
      },
      {
        policy: eligiblePolicy(),
        observer,
        adapter: { perform: performSpy },
        gate: makeGate(order),
        fetchPostRewriteEvidence: greenEvidence('unused'),
      }
    );

    expect(result.outcome).toBe('ineligible');
    expect(result.reason).toBe('dirty_worktree');
    expect(performSpy).toHaveBeenCalledTimes(0);
    expect(order).toEqual([]);
    expect(result.receipts).toHaveLength(0);
  });

  test('unowned branch (not factory-created) fails closed before any permit', async () => {
    const repo = initRepo();
    writeAndCommit(repo, 'a.txt', 'a\n', 'A');
    git(repo, ['checkout', '-b', 'hotfix/manual']);
    const branchHead = git(repo, ['rev-parse', 'HEAD']);
    git(repo, ['checkout', 'main']);
    const baseHead = writeAndCommit(repo, 'b.txt', 'b\n', 'B');
    git(repo, ['checkout', 'hotfix/manual']);

    const observer = makeGitMutationDeps(repo);
    const performSpy = mock(async (req: Parameters<BranchMutationAdapterV1['perform']>[0]) =>
      createBranchMutationAdapter(observer).perform(req)
    );
    const order: string[] = [];

    const result = await executeRefreshRebase(
      {
        candidate: baseCandidate({
          branch: 'hotfix/manual',
          worktree_path: repo,
          run_authority: {
            run_id: 'run-4b',
            head_sha: branchHead,
            base_branch: 'main',
            base_sha: baseHead,
            factory_created: false,
          },
          pr_snapshot: {
            pr_number: 5,
            head_sha: branchHead,
            base_branch: 'main',
            base_sha: baseHead,
          },
        }),
        proposal_id: 'p-unowned',
        actor: 'overseer',
        correlation_id: 'corr-4b',
      },
      {
        policy: eligiblePolicy(),
        observer,
        adapter: { perform: performSpy },
        gate: makeGate(order),
        fetchPostRewriteEvidence: greenEvidence('unused'),
      }
    );

    expect(result.outcome).toBe('ineligible');
    expect(result.reason).toBe('unowned_branch');
    expect(performSpy).toHaveBeenCalledTimes(0);
    expect(order).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Test 5 -- concurrent head or policy change
// ---------------------------------------------------------------------------

describe('refresh-rebase Test 5 concurrent head or policy change', () => {
  function stubObserver(
    heads: string[],
    probeResult: RebaseConflictProbeV1 | null
  ): BranchMutationDepsV1 {
    let call = 0;
    return {
      async observeWorktree({ branch }) {
        const head = heads[Math.min(call, heads.length - 1)];
        call += 1;
        return { clean: true, current_branch: branch, head_sha: head, factory_owned: true };
      },
      async countUniqueCommits() {
        return probeResult ? 1 : 0;
      },
      async probeRebase() {
        return probeResult ?? { conflicted: false, conflict_paths: [], conflict_signal: 'none' };
      },
      async applyRefresh() {
        throw new Error('adapter must not run on live_state_mismatch');
      },
      async applyRebase() {
        throw new Error('adapter must not run on live_state_mismatch');
      },
      async readTreeSha() {
        return 'tree';
      },
    };
  }

  test('head drift after proposal returns live_state_mismatch with no Git operation', async () => {
    const observer = stubObserver(['head-A', 'head-B'], null); // observe A first, drift to B
    const performSpy = mock(async (req: Parameters<BranchMutationAdapterV1['perform']>[0]) =>
      createBranchMutationAdapter(observer).perform(req)
    );
    const order: string[] = [];

    const result = await executeRefreshRebase(
      {
        candidate: baseCandidate({
          worktree_path: '/fixture',
          run_authority: {
            run_id: 'run-5',
            head_sha: 'head-A',
            base_branch: 'main',
            base_sha: 'base',
            factory_created: true,
          },
          pr_snapshot: { pr_number: 6, head_sha: 'head-A', base_branch: 'main', base_sha: 'base' },
        }),
        proposal_id: 'p-drift',
        actor: 'overseer',
        correlation_id: 'corr-5',
      },
      {
        policy: eligiblePolicy(),
        observer,
        adapter: { perform: performSpy },
        gate: makeGate(order),
        fetchPostRewriteEvidence: greenEvidence('unused'),
      }
    );

    expect(result.outcome).toBe('live_state_mismatch');
    expect(performSpy).toHaveBeenCalledTimes(0);
    expect(order).toContain('outcome:effect_failed');
  });

  test('policy decision change after proposal returns live_state_mismatch', async () => {
    const observer = stubObserver(['head-A', 'head-A'], null);
    const performSpy = mock(async (req: Parameters<BranchMutationAdapterV1['perform']>[0]) =>
      createBranchMutationAdapter(observer).perform(req)
    );
    let policyCall = 0;
    const policy: InjectedActionPolicyDepsV1 = {
      evaluateActionPolicy() {
        policyCall += 1;
        return policyCall === 1
          ? { eligible: true, base_eligible: true, effect_allowed: true }
          : { eligible: false, reason: 'base_revoked' };
      },
    };
    const order: string[] = [];

    const result = await executeRefreshRebase(
      {
        candidate: baseCandidate({
          worktree_path: '/fixture',
          run_authority: {
            run_id: 'run-5b',
            head_sha: 'head-A',
            base_branch: 'main',
            base_sha: 'base',
            factory_created: true,
          },
          pr_snapshot: { pr_number: 7, head_sha: 'head-A', base_branch: 'main', base_sha: 'base' },
        }),
        proposal_id: 'p-policy',
        actor: 'overseer',
        correlation_id: 'corr-5b',
      },
      {
        policy,
        observer,
        adapter: { perform: performSpy },
        gate: makeGate(order),
        fetchPostRewriteEvidence: greenEvidence('unused'),
      }
    );

    expect(result.outcome).toBe('live_state_mismatch');
    expect(performSpy).toHaveBeenCalledTimes(0);
  });

  test('branch drift after proposal (same head, different checked-out branch) fails closed', async () => {
    // Live checkout is at the bound head but a DIFFERENT branch is checked out.
    // The exact controlled-branch binding must still be enforced at compare-and-act,
    // so the mutating adapter is never reached.
    let call = 0;
    const observer: BranchMutationDepsV1 = {
      async observeWorktree() {
        // First observation: correct branch. Second (final compare-and-act):
        // same head but a different branch is now checked out.
        const current_branch = call === 0 ? 'wo/harness-overseer-refresh-rebase-01' : 'wo/other';
        call += 1;
        return {
          clean: true,
          current_branch,
          head_sha: 'head-A',
          factory_owned: true,
        };
      },
      async countUniqueCommits() {
        return 0;
      },
      async probeRebase() {
        return { conflicted: false, conflict_paths: [], conflict_signal: 'none' };
      },
      async applyRefresh() {
        throw new Error('adapter must not run on branch drift');
      },
      async applyRebase() {
        throw new Error('adapter must not run on branch drift');
      },
      async readTreeSha() {
        return 'tree';
      },
    };
    const performSpy = mock(async (req: Parameters<BranchMutationAdapterV1['perform']>[0]) =>
      createBranchMutationAdapter(observer).perform(req)
    );
    const order: string[] = [];

    const result = await executeRefreshRebase(
      {
        candidate: baseCandidate({
          worktree_path: '/fixture',
          run_authority: {
            run_id: 'run-5c',
            head_sha: 'head-A',
            base_branch: 'main',
            base_sha: 'base',
            factory_created: true,
          },
          pr_snapshot: { pr_number: 11, head_sha: 'head-A', base_branch: 'main', base_sha: 'base' },
        }),
        proposal_id: 'p-branch-drift',
        actor: 'overseer',
        correlation_id: 'corr-5c',
      },
      {
        policy: eligiblePolicy(),
        observer,
        adapter: { perform: performSpy },
        gate: makeGate(order),
        fetchPostRewriteEvidence: greenEvidence('unused'),
      }
    );

    expect(result.outcome).toBe('live_state_mismatch');
    expect(performSpy).toHaveBeenCalledTimes(0);
    expect(order).toContain('outcome:effect_failed');
  });

  test('failure to write the v2 outcome receipt on a terminal stop surfaces outcome_record_failed', async () => {
    // Head drift drives live_state_mismatch; the outcome-receipt write then fails.
    // The action MUST detect that failure rather than silently returning the stop.
    const observer = stubObserver(['head-A', 'head-B'], null);
    const performSpy = mock(async (req: Parameters<BranchMutationAdapterV1['perform']>[0]) =>
      createBranchMutationAdapter(observer).perform(req)
    );
    const order: string[] = [];

    const result = await executeRefreshRebase(
      {
        candidate: baseCandidate({
          worktree_path: '/fixture',
          run_authority: {
            run_id: 'run-5d',
            head_sha: 'head-A',
            base_branch: 'main',
            base_sha: 'base',
            factory_created: true,
          },
          pr_snapshot: { pr_number: 12, head_sha: 'head-A', base_branch: 'main', base_sha: 'base' },
        }),
        proposal_id: 'p-receipt-fail',
        actor: 'overseer',
        correlation_id: 'corr-5d',
      },
      {
        policy: eligiblePolicy(),
        observer,
        adapter: { perform: performSpy },
        gate: makeGate(order, { recordOutcomeFailure: 'receipt_write_conflict' }),
        fetchPostRewriteEvidence: greenEvidence('unused'),
      }
    );

    expect(result.outcome).toBe('outcome_record_failed');
    expect(result.reason).toContain('live_state_mismatch');
    expect(result.reason).toContain('outcome_record_failed:receipt_write_conflict');
    expect(performSpy).toHaveBeenCalledTimes(0);
    // The failed receipt write is NOT appended (only successful receipts are).
    expect(result.receipt_types).not.toContain('effect_failed');
  });
});

// ---------------------------------------------------------------------------
// Stop 2 -- exact gate and receipt order
// ---------------------------------------------------------------------------

describe('refresh-rebase gate order', () => {
  test('prepare authorize reserve precede adapter (allow order and denial zero adapter calls)', async () => {
    // Allow path: gate order is prepare -> authorize -> reserve -> adapter.
    const repo = initRepo();
    writeAndCommit(repo, 'a.txt', 'a\n', 'A');
    git(repo, ['checkout', '-b', 'wo/order']);
    const branchHead = git(repo, ['rev-parse', 'HEAD']);
    git(repo, ['checkout', 'main']);
    const baseHead = writeAndCommit(repo, 'b.txt', 'b\n', 'B');
    git(repo, ['checkout', 'wo/order']);

    const observer = makeGitMutationDeps(repo);
    const order: string[] = [];
    const performSpy = mock(async (req: Parameters<BranchMutationAdapterV1['perform']>[0]) => {
      order.push('adapter');
      return createBranchMutationAdapter(observer).perform(req);
    });

    const allow = await executeRefreshRebase(
      {
        candidate: baseCandidate({
          branch: 'wo/order',
          worktree_path: repo,
          run_authority: {
            run_id: 'run-order',
            head_sha: branchHead,
            base_branch: 'main',
            base_sha: baseHead,
            factory_created: true,
          },
          pr_snapshot: {
            pr_number: 8,
            head_sha: branchHead,
            base_branch: 'main',
            base_sha: baseHead,
          },
        }),
        proposal_id: 'p-order',
        actor: 'overseer',
        correlation_id: 'corr-order',
      },
      {
        policy: eligiblePolicy(),
        observer,
        adapter: { perform: performSpy },
        gate: makeGate(order),
        fetchPostRewriteEvidence: greenEvidence(baseHead),
      }
    );

    expect(allow.outcome).toBe('succeeded');
    expect(order.slice(0, 4)).toEqual(['prepare', 'authorize', 'reserve', 'adapter']);

    // Denied case: authorization denial makes zero adapter calls, reserve never runs.
    const denyRepo = initRepo();
    writeAndCommit(denyRepo, 'a.txt', 'a\n', 'A');
    git(denyRepo, ['checkout', '-b', 'wo/order-deny']);
    const denyBranchHead = git(denyRepo, ['rev-parse', 'HEAD']);
    git(denyRepo, ['checkout', 'main']);
    const denyBaseHead = writeAndCommit(denyRepo, 'b.txt', 'b\n', 'B');
    git(denyRepo, ['checkout', 'wo/order-deny']);

    const denyObserver = makeGitMutationDeps(denyRepo);
    const denyOrder: string[] = [];
    const denyPerformSpy = mock(async (req: Parameters<BranchMutationAdapterV1['perform']>[0]) =>
      createBranchMutationAdapter(denyObserver).perform(req)
    );

    const denied = await executeRefreshRebase(
      {
        candidate: baseCandidate({
          branch: 'wo/order-deny',
          worktree_path: denyRepo,
          run_authority: {
            run_id: 'run-deny',
            head_sha: denyBranchHead,
            base_branch: 'main',
            base_sha: denyBaseHead,
            factory_created: true,
          },
          pr_snapshot: {
            pr_number: 9,
            head_sha: denyBranchHead,
            base_branch: 'main',
            base_sha: denyBaseHead,
          },
        }),
        proposal_id: 'p-deny',
        actor: 'overseer',
        correlation_id: 'corr-deny',
      },
      {
        policy: eligiblePolicy(),
        observer: denyObserver,
        adapter: { perform: denyPerformSpy },
        gate: makeGate(denyOrder, { authDenied: 'capability_state_disabled' }),
        fetchPostRewriteEvidence: greenEvidence('unused'),
      }
    );

    expect(denied.outcome).toBe('denied');
    expect(denyPerformSpy).toHaveBeenCalledTimes(0);
    expect(denyOrder).toEqual(['prepare', 'authorize']);
  });
});

// ---------------------------------------------------------------------------
// Stop 3 -- post-rewrite evidence rejects old head
// ---------------------------------------------------------------------------

describe('refresh-rebase post-rewrite evidence', () => {
  test('post rewrite evidence rejects old head and requires new-head green CI plus independent review', async () => {
    // Unit-level: old-head CI and review are rejected.
    const oldHead = 'old-head-sha';
    const newHead = 'new-head-sha';
    expect(
      requirePostRewriteEvidence({
        new_head_sha: newHead,
        ci: { head_sha: oldHead, green: true },
        review: { reviewed_head_sha: newHead, verdict: 'APPROVE', independent: true },
      })
    ).toEqual({ satisfied: false, reason: 'ci_stale_head' });

    expect(
      requirePostRewriteEvidence({
        new_head_sha: newHead,
        ci: { head_sha: newHead, green: true },
        review: { reviewed_head_sha: oldHead, verdict: 'APPROVE', independent: true },
      })
    ).toEqual({ satisfied: false, reason: 'review_stale_head' });

    expect(
      requirePostRewriteEvidence({
        new_head_sha: newHead,
        ci: { head_sha: newHead, green: true },
        review: { reviewed_head_sha: newHead, verdict: 'APPROVE', independent: false },
      })
    ).toEqual({ satisfied: false, reason: 'review_not_independent' });

    // Only new-head green CI plus independent APPROVE review satisfies.
    expect(
      requirePostRewriteEvidence({
        new_head_sha: newHead,
        ci: { head_sha: newHead, green: true },
        review: { reviewed_head_sha: newHead, verdict: 'APPROVE', independent: true },
      })
    ).toEqual({ satisfied: true });

    // End-to-end: a real rewrite whose evidence is bound to the OLD head is rejected.
    const repo = initRepo();
    writeAndCommit(repo, 'a.txt', 'a\n', 'A');
    git(repo, ['checkout', '-b', 'wo/evidence']);
    const branchHead = git(repo, ['rev-parse', 'HEAD']);
    git(repo, ['checkout', 'main']);
    const baseHead = writeAndCommit(repo, 'b.txt', 'b\n', 'B');
    git(repo, ['checkout', 'wo/evidence']);

    const observer = makeGitMutationDeps(repo);
    const performSpy = mock(async (req: Parameters<BranchMutationAdapterV1['perform']>[0]) =>
      createBranchMutationAdapter(observer).perform(req)
    );

    const candidate = baseCandidate({
      branch: 'wo/evidence',
      worktree_path: repo,
      run_authority: {
        run_id: 'run-ev',
        head_sha: branchHead,
        base_branch: 'main',
        base_sha: baseHead,
        factory_created: true,
      },
      pr_snapshot: { pr_number: 10, head_sha: branchHead, base_branch: 'main', base_sha: baseHead },
    });

    const staleResult = await executeRefreshRebase(
      { candidate, proposal_id: 'p-ev', actor: 'overseer', correlation_id: 'corr-ev' },
      {
        policy: eligiblePolicy(),
        observer,
        adapter: { perform: performSpy },
        gate: makeGate([]),
        // Evidence bound to the OLD (pre-rewrite) head must be rejected.
        fetchPostRewriteEvidence: async () => ({
          ci: { head_sha: branchHead, green: true },
          review: { reviewed_head_sha: branchHead, verdict: 'APPROVE', independent: true },
        }),
      }
    );
    expect(staleResult.outcome).toBe('evidence_required');
    expect(staleResult.reason).toBe('post_rewrite_evidence:ci_stale_head');

    // Reset the fixture and re-run with new-head-bound evidence -> satisfied.
    git(repo, ['checkout', 'main']);
    git(repo, ['branch', '-D', 'wo/evidence']);
    git(repo, ['checkout', '-b', 'wo/evidence']);
    git(repo, ['reset', '--hard', branchHead]);

    const freshObserver = makeGitMutationDeps(repo);
    const okResult = await executeRefreshRebase(
      { candidate, proposal_id: 'p-ev2', actor: 'overseer', correlation_id: 'corr-ev2' },
      {
        policy: eligiblePolicy(),
        observer: freshObserver,
        adapter: {
          perform: async (req: Parameters<BranchMutationAdapterV1['perform']>[0]) =>
            createBranchMutationAdapter(freshObserver).perform(req),
        },
        gate: makeGate([]),
        fetchPostRewriteEvidence: async ({ new_head_sha }) => ({
          ci: { head_sha: new_head_sha, green: true },
          review: { reviewed_head_sha: new_head_sha, verdict: 'APPROVE', independent: true },
        }),
      }
    );
    expect(okResult.outcome).toBe('succeeded');
  });
});
