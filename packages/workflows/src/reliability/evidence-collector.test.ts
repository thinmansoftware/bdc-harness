import { describe, expect, it } from 'bun:test';

import type { RunAuthorityRecord } from './types';
import {
  collectMechanicalEvidence,
  collectRuntimeEvidence,
  renderManifestV2,
  type EvidenceCommandResult,
  type MechanicalEvidenceInput,
  type RuntimeEvidenceRequest,
} from './evidence-collector';

const authority: RunAuthorityRecord = {
  runId: 'run-1',
  dispatchId: 'dispatch-1',
  woId: 'WO-TEST-01',
  specSource: 'github:thinmansoftware/bdc-xo:docs/work-orders/WO-TEST-01.md',
  specRevision: '1'.repeat(40),
  specHash: `sha256:${'2'.repeat(64)}`,
  workflowName: 'bdc-feature-development',
  codebaseId: 'codebase-1',
  canonicalRemote: 'https://github.com/bluedevilcollectibles/example.git',
  baseBranch: 'main',
  baseSha: '3'.repeat(40),
  runScopeSha: '3'.repeat(40),
  headBranch: 'archon/thread-test',
  worktreePath: '/worktrees/thread-test',
  workflowRevision: `sha256:${'4'.repeat(64)}`,
  bundleRevision: `sha256:${'5'.repeat(64)}`,
  engineRevision: `sha256:${'6'.repeat(64)}`,
  runtimeImageRevision: null,
  createdAt: '2026-07-09T12:00:00.000Z',
};

function input(overrides: Partial<MechanicalEvidenceInput> = {}): MechanicalEvidenceInput {
  const headSha = '7'.repeat(40);
  return {
    authority,
    executionState: 'completed',
    recoveryState: 'not_needed',
    routeState: 'current',
    git: {
      headSha,
      headBranch: authority.headBranch,
      originRemote: authority.canonicalRemote,
      mergeBaseSha: authority.baseSha,
      behindBy: 0,
      changes: [
        { status: 'A', path: 'src/new.ts' },
        { status: 'M', path: 'src/existing.ts' },
      ],
    },
    pullRequest: {
      url: 'https://github.com/bluedevilcollectibles/example/pull/42',
      number: 42,
      state: 'OPEN',
      draft: false,
      baseRef: authority.baseBranch,
      headRef: authority.headBranch,
      headSha,
      files: ['src/existing.ts', 'src/new.ts'],
      requiredChecks: [{ name: 'ci', state: 'passed' }],
    },
    gates: [
      { id: 'plan-review', required: true, state: 'passed' },
      { id: 'diff-review-final', required: true, state: 'passed' },
    ],
    ...overrides,
  };
}

describe('collectMechanicalEvidence', () => {
  it('keeps failed execution separate from a ready PR', () => {
    const result = collectMechanicalEvidence(input({ executionState: 'failed' }));

    expect(result.outcome.executionState).toBe('failed');
    expect(result.outcome.deliverableState).toBe('pr_ready');
    expect(result.outcome.validationState).toBe('passed');
    expect(result.outcome.primaryReason).toBe('execution_failed_pr_ready');
  });

  it('fails validation when PR scope differs from immutable authority', () => {
    const original = input();
    const result = collectMechanicalEvidence(
      input({ pullRequest: { ...original.pullRequest!, baseRef: 'release/ce' } })
    );

    expect(result.outcome.validationState).toBe('failed');
    expect(result.outcome.deliverableState).toBe('pr_open');
    expect(result.outcome.primaryReason).toBe('gate_scope_mismatch');
  });

  it('treats a missing or indeterminate required gate as indeterminate', () => {
    const result = collectMechanicalEvidence(
      input({ gates: [{ id: 'ascii-gate', required: true, state: 'indeterminate' }] })
    );

    expect(result.outcome.validationState).toBe('indeterminate');
    expect(result.outcome.primaryReason).toBe('gate_indeterminate');
  });

  it('does not accept PR readiness when the mechanical file list differs from the run diff', () => {
    const original = input();
    const result = collectMechanicalEvidence(
      input({ pullRequest: { ...original.pullRequest!, files: ['src/unrelated.ts'] } })
    );

    expect(result.outcome.deliverableState).toBe('pr_open');
    expect(result.outcome.validationState).toBe('failed');
  });

  it('fails closed when HEAD no longer descends from the frozen base', () => {
    const original = input();
    const result = collectMechanicalEvidence(
      input({ git: { ...original.git, mergeBaseSha: '9'.repeat(40) } })
    );

    expect(result.scopeValid).toBe(false);
    expect(result.outcome.validationState).toBe('failed');
    expect(result.outcome.primaryReason).toBe('gate_scope_mismatch');
  });

  it('fails closed when the worktree branch or origin remote drifts', () => {
    const original = input();
    const wrongBranch = collectMechanicalEvidence(
      input({ git: { ...original.git, headBranch: 'archon/other-run' } })
    );
    const wrongRemote = collectMechanicalEvidence(
      input({ git: { ...original.git, originRemote: 'https://github.com/other/repo.git' } })
    );

    expect(wrongBranch.scopeValid).toBe(false);
    expect(wrongRemote.scopeValid).toBe(false);
  });
});

// WO-HARNESS-BASE-LANE-AUTHORITY-01 -- Test 2 (squash-unreachable recovery).
// When the pinned authority.baseSha is unreachable (base branch squash-merged and
// gc-pruned -- a ROUTINE event), the merge-base against baseSha fails. The runtime
// collector must NOT die; it falls back to merge-base(origin/<baseBranch>, HEAD).
describe('collectRuntimeEvidence merge-base squash fallback', () => {
  const headSha = '7'.repeat(40);
  const baseShaMergeBase = 'b'.repeat(40);
  const originMergeBase = 'a'.repeat(40);

  function makeRunner(opts: { baseShaReachable: boolean }): {
    run: (command: string, args: readonly string[], cwd: string) => Promise<EvidenceCommandResult>;
    mergeBaseCalls: string[];
  } {
    const mergeBaseCalls: string[] = [];
    const run = async (
      command: string,
      args: readonly string[]
    ): Promise<EvidenceCommandResult> => {
      if (command === 'gh') throw new Error('no pr view'); // pullRequest -> null
      const sub = args[2];
      switch (sub) {
        case 'rev-parse':
          return { stdout: `${headSha}\n` };
        case 'symbolic-ref':
          return { stdout: `${authority.headBranch}\n` };
        case 'remote':
          return { stdout: `${authority.canonicalRemote}\n` };
        case 'merge-base': {
          const operand = args[3];
          mergeBaseCalls.push(operand);
          if (operand === authority.baseSha) {
            if (!opts.baseShaReachable) {
              throw new Error('fatal: Not a valid object name');
            }
            return { stdout: `${baseShaMergeBase}\n` };
          }
          // Fallback: merge-base(refs/remotes/origin/<baseBranch>, HEAD)
          return { stdout: `${originMergeBase}\n` };
        }
        case 'rev-list':
          return { stdout: '0\n' };
        case 'diff':
          return { stdout: '' };
        default:
          throw new Error(`unexpected git subcommand: ${String(sub)}`);
      }
    };
    return { run, mergeBaseCalls };
  }

  const store = {
    getRunAuthority: async () => authority,
    listWorkflowEvents: async () => [],
  };
  const request: RuntimeEvidenceRequest = {
    runId: authority.runId,
    cwd: authority.worktreePath,
    executionState: 'running',
    recoveryState: 'not_needed',
    routeState: 'current',
    requiredGateIds: [],
  };

  it('falls back to origin/<baseBranch> when baseSha is unreachable (squash-pruned)', async () => {
    const { run, mergeBaseCalls } = makeRunner({ baseShaReachable: false });

    const evidence = await collectRuntimeEvidence(store, run, request);

    // It did NOT throw, and the fallback merge-base was invoked with the origin ref.
    expect(mergeBaseCalls[0]).toBe(authority.baseSha);
    expect(mergeBaseCalls[1]).toBe(`refs/remotes/origin/${authority.baseBranch}`);
    expect(evidence.git.mergeBaseSha).toBe(originMergeBase);
  });

  it('uses the pinned baseSha merge-base directly when it is reachable', async () => {
    const { run, mergeBaseCalls } = makeRunner({ baseShaReachable: true });

    const evidence = await collectRuntimeEvidence(store, run, request);

    expect(mergeBaseCalls).toEqual([authority.baseSha]);
    expect(evidence.git.mergeBaseSha).toBe(baseShaMergeBase);
  });
});

describe('renderManifestV2', () => {
  it('renders parser-stable labels only from collected facts', () => {
    const evidence = collectMechanicalEvidence(input());
    const manifest = renderManifestV2(evidence);

    expect(manifest).toContain('WO: WO-TEST-01');
    expect(manifest).toContain('Files created: src/new.ts');
    expect(manifest).toContain('Files modified: src/existing.ts');
    expect(manifest).toContain('PRs: https://github.com/bluedevilcollectibles/example/pull/42');
    expect(manifest).toContain(`Merge ancestors: ${authority.baseSha}...${'7'.repeat(40)}`);
    expect(manifest).toContain('Tests: N/A (required gates are reported separately)');
    expect(manifest).toContain('VALIDATION: PASS');
    expect(manifest).not.toContain('src/unrelated.ts');
  });

  it('keeps runtime evidence on one parser-stable line', () => {
    const evidence = collectMechanicalEvidence(
      input({
        gates: [
          {
            id: 'plan-review',
            required: true,
            state: 'passed',
            evidence: 'APPROVED\nextra detail',
          },
        ],
      })
    );

    const manifest = renderManifestV2(evidence);
    expect(manifest).toContain('Runtime verification: plan-review=APPROVED extra detail');
    expect(manifest.split('\n').filter(line => line === 'extra detail')).toEqual([]);
  });
});
