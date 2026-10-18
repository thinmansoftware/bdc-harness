import { describe, expect, it } from 'bun:test';

import type { RunAuthorityRecord } from './types';
import {
  collectMechanicalEvidence,
  collectRuntimeEvidence,
  renderManifestV2,
  type EvidenceCommandRunner,
  type MechanicalEvidenceInput,
  type RuntimeEvidenceRequest,
} from './evidence-collector';

const EXAMPLE_HEAD = '7'.repeat(40);
const EXAMPLE_FILES = ['src/example.ts'] as const;
const EXAMPLE_PR_URL = 'https://github.com/bluedevilcollectibles/example/pull/77';
const SHOPOPS_REMOTE = 'https://github.com/thinmansoftware/shopops.git';
const SHOPOPS_REPO = 'thinmansoftware/shopops';
const REQUIRED_GATE_IDS = ['plan-review', 'block-reclassify', 'open-pr-if-needed'] as const;

function authorityRecord(overrides: Partial<RunAuthorityRecord> = {}): RunAuthorityRecord {
  return {
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
    ...overrides,
  };
}

function corroboratingDrift(): MechanicalEvidenceInput {
  const authority = authorityRecord();
  return {
    authority,
    executionState: 'running',
    recoveryState: 'not_needed',
    routeState: 'current',
    git: {
      headSha: EXAMPLE_HEAD,
      headBranch: 'fix/wo-example-01',
      originRemote: authority.canonicalRemote,
      mergeBaseSha: authority.baseSha,
      behindBy: 0,
      changes: EXAMPLE_FILES.map(path => ({ status: 'M' as const, path })),
    },
    pullRequest: {
      url: EXAMPLE_PR_URL,
      number: 77,
      state: 'OPEN',
      draft: false,
      baseRef: authority.baseBranch,
      headRef: 'feat/wo-example-01-thread-7777777',
      headSha: EXAMPLE_HEAD,
      files: [...EXAMPLE_FILES],
      requiredChecks: [{ name: 'ci', state: 'passed' }],
    },
    gates: REQUIRED_GATE_IDS.map(id => ({ id, required: true as const, state: 'passed' as const })),
  };
}

function prViewJson(input: {
  url: string;
  number: number;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  files: readonly string[];
}): string {
  return JSON.stringify({
    url: input.url,
    number: input.number,
    state: 'OPEN',
    isDraft: false,
    baseRefName: input.baseRefName,
    headRefName: input.headRefName,
    headRefOid: input.headRefOid,
    files: input.files.map(path => ({ path })),
    statusCheckRollup: [],
  });
}

interface HeadPull {
  readonly number: number;
  readonly sha: string;
  readonly ref: string;
  readonly base: string;
}

function runtimeRequest(
  authority: RunAuthorityRecord,
  executionState: RuntimeEvidenceRequest['executionState']
): RuntimeEvidenceRequest {
  return {
    runId: authority.runId,
    cwd: authority.worktreePath,
    executionState,
    recoveryState: 'not_needed',
    routeState: 'current',
    requiredGateIds: [...REQUIRED_GATE_IDS],
  };
}

function evidenceStore(authority: RunAuthorityRecord): {
  getRunAuthority: (runId: string) => Promise<RunAuthorityRecord | null>;
  listWorkflowEvents: (runId: string) => Promise<
    {
      id: string;
      workflow_run_id: string;
      event_type: string;
      step_index: number;
      step_name: string;
      data: Record<string, unknown>;
      created_at: string;
    }[]
  >;
} {
  return {
    getRunAuthority: async () => authority,
    listWorkflowEvents: async () =>
      REQUIRED_GATE_IDS.map((stepName, stepIndex) => ({
        id: `event-${stepName}`,
        workflow_run_id: authority.runId,
        event_type: 'node_completed',
        step_index: stepIndex,
        step_name: stepName,
        data: { node_output: 'OK', gate_result: { passed: true } },
        created_at: '2026-09-29T00:00:00.000Z',
      })),
  };
}

function runtimeRunner(options: {
  headSha: string;
  headBranch: string;
  originRemote: string;
  baseSha: string;
  diffPaths: readonly string[];
  onGh: (args: readonly string[]) => Promise<{ stdout: string }>;
}): EvidenceCommandRunner {
  return async (command, args) => {
    if (command === 'gh') return options.onGh(args);
    if (command !== 'git' || args[0] !== '-C') {
      throw new Error(`unexpected command ${command}`);
    }
    switch (args[2]) {
      case 'rev-parse':
        return { stdout: `${options.headSha}\n` };
      case 'symbolic-ref':
        return { stdout: `${options.headBranch}\n` };
      case 'remote':
        return { stdout: `${options.originRemote}\n` };
      case 'merge-base':
        if (args[3] !== options.baseSha) {
          throw new Error(`unexpected merge-base operand ${String(args[3])}`);
        }
        return { stdout: `${options.baseSha}\n` };
      case 'rev-list':
        return { stdout: '0\n' };
      case 'diff':
        return { stdout: `${options.diffPaths.map(path => `M\t${path}`).join('\n')}\n` };
      default:
        throw new Error(`unexpected git subcommand: ${String(args[2])}`);
    }
  };
}

function headShaLookupGh(options: {
  authorityBranch: string;
  repository: string;
  headSha: string;
  list: readonly HeadPull[] | 'throw';
  viewByNumber: (number: number) => string;
}): (args: readonly string[]) => Promise<{ stdout: string }> {
  return async args => {
    if (args[0] === 'api') {
      if (options.list === 'throw') throw new Error('gh api failed');
      const expected = `repos/${options.repository}/commits/${options.headSha}/pulls`;
      if (args[1] !== expected) throw new Error(`unexpected api path ${String(args[1])}`);
      return {
        stdout: JSON.stringify(
          options.list.map(entry => ({
            number: entry.number,
            state: 'open',
            head: { sha: entry.sha, ref: entry.ref },
            base: { ref: entry.base },
          }))
        ),
      };
    }
    if (args[0] === 'pr' && args[1] === 'view') {
      if (args[2] === options.authorityBranch) throw new Error('no pr for authority branch');
      return { stdout: options.viewByNumber(Number(args[2])) };
    }
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
}

interface ReplayFacts {
  readonly runId: string;
  readonly woId: string;
  readonly authorityBranch: string;
  readonly worktreeBranch: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly prNumber: number;
  readonly prUrl: string;
  readonly headRef: string;
  readonly files: readonly string[];
}

const REPLAY_6EBC: ReplayFacts = {
  runId: '6ebc4988b5db5bcc7e267f3ceab264d2',
  woId: 'WO-SHOPOPS-STAGING-POSTCHECK-CGC-ENABLED-01',
  authorityBranch: 'archon/task-web-worker-1790671408755-x3qlro',
  worktreeBranch: 'fix/wo-shopops-staging-postcheck-cgc-enabled-01',
  baseSha: '2fb5f53f6872e966e8c2f789a037fb680af94635',
  headSha: 'ba023dca82a7f41274a68a98bb05967531eac1a8',
  prNumber: 770,
  prUrl: 'https://github.com/thinmansoftware/shopops/pull/770',
  headRef: 'feat/wo-shopops-staging-postcheck-cgc-enabled-01-thread-ba023dca',
  files: [
    'shopops-api/scripts/apply-ci-staging-migrations.js',
    'shopops-api/tests/run_all.js',
    'shopops-api/tests/test_ci_staging_postcheck_providers.js',
  ],
};

const REPLAY_EA46: ReplayFacts = {
  runId: 'ea46da630ba066a9ff73cbe12dbcdf38',
  woId: 'WO-SHOPOPS-STRIPE-WEBHOOK-ACK-AFTER-COMMIT-01',
  authorityBranch: 'archon/task-web-worker-1790610385097-8q5n3h',
  worktreeBranch: 'fix/stripe-webhook-ack-after-commit',
  baseSha: '16738f33c27d6a7b5060de91ee2b0a2a2e6c6183',
  headSha: '8d8b70e176702de252333ada04175b1f03bdc02a',
  prNumber: 758,
  prUrl: 'https://github.com/thinmansoftware/shopops/pull/758',
  headRef: 'feat/wo-shopops-stripe-webhook-ack-after-commit-01-thread-8d8b70e1',
  files: [
    'shopops-api/migrations/20260928_stripe_webhook_events_ledger.sql',
    'shopops-api/migrations/ci-staging-migrations.txt',
    'shopops-api/migrations/prod-pending-migrations.txt',
    'shopops-api/routes/webhooks.js',
    'shopops-api/services/chargeOnShip.js',
    'shopops-api/tests/run_all.js',
    'shopops-api/tests/test_stripe_webhook_ack_after_commit.js',
  ],
};

async function collectReplay(facts: ReplayFacts) {
  const authority = authorityRecord({
    runId: facts.runId,
    woId: facts.woId,
    canonicalRemote: SHOPOPS_REMOTE,
    baseBranch: 'staging',
    baseSha: facts.baseSha,
    runScopeSha: facts.baseSha,
    headBranch: facts.authorityBranch,
    worktreePath: `/worktrees/${facts.runId}`,
  });
  const run = runtimeRunner({
    headSha: facts.headSha,
    headBranch: facts.worktreeBranch,
    originRemote: SHOPOPS_REMOTE,
    baseSha: facts.baseSha,
    diffPaths: facts.files,
    onGh: headShaLookupGh({
      authorityBranch: facts.authorityBranch,
      repository: SHOPOPS_REPO,
      headSha: facts.headSha,
      list: [
        {
          number: facts.prNumber,
          sha: facts.headSha,
          ref: facts.headRef,
          base: 'staging',
        },
      ],
      viewByNumber: number =>
        prViewJson({
          url: facts.prUrl,
          number,
          baseRefName: 'staging',
          headRefName: facts.headRef,
          headRefOid: facts.headSha,
          files: facts.files,
        }),
    }),
  });
  return collectRuntimeEvidence(
    evidenceStore(authority),
    run,
    runtimeRequest(authority, 'running')
  );
}

describe('manifest branch scope stamp', () => {
  it('accepts branch drift when a corroborating PR is at the exact HEAD', () => {
    const evidence = collectMechanicalEvidence(corroboratingDrift());
    const manifest = renderManifestV2(evidence);

    expect(evidence.scopeValid).toBe(true);
    expect(evidence.outcome.validationState).toBe('passed');
    expect(evidence.outcome.primaryReason).not.toBe('gate_scope_mismatch');
    expect(manifest).toContain('VALIDATION: PASS');
    expect(manifest).toContain(EXAMPLE_PR_URL);
  });

  it('fails closed on a completed run when branch drift has no corroborating PR', () => {
    const drifted = corroboratingDrift();
    const evidence = collectMechanicalEvidence({
      ...drifted,
      executionState: 'completed',
      pullRequest: null,
    });

    expect(evidence.scopeValid).toBe(false);
    expect(evidence.outcome.validationState).toBe('failed');
    expect(evidence.outcome.primaryReason).toBe('gate_scope_mismatch');
  });

  it('fails closed when the corroborating PR head, base, or files do not match', () => {
    const drifted = corroboratingDrift();
    const pr = drifted.pullRequest;
    if (pr === null) throw new Error('fixture PR missing');
    const wrongSha = collectMechanicalEvidence({
      ...drifted,
      executionState: 'completed',
      pullRequest: { ...pr, headSha: 'a'.repeat(40) },
    });
    const wrongBase = collectMechanicalEvidence({
      ...drifted,
      executionState: 'completed',
      pullRequest: { ...pr, baseRef: 'release/ce' },
    });
    const wrongFiles = collectMechanicalEvidence({
      ...drifted,
      executionState: 'completed',
      pullRequest: { ...pr, files: ['src/unrelated.ts'] },
    });

    expect(wrongSha.scopeValid).toBe(false);
    expect(wrongBase.scopeValid).toBe(false);
    expect(wrongFiles.scopeValid).toBe(false);
  });

  it('stamps an unexplained scope mismatch as indeterminate while running', () => {
    const base = corroboratingDrift();
    const mismatched: MechanicalEvidenceInput = {
      ...base,
      pullRequest: null,
      git: {
        ...base.git,
        headBranch: base.authority.headBranch,
        mergeBaseSha: '9'.repeat(40),
      },
    };
    const running = collectMechanicalEvidence({ ...mismatched, executionState: 'running' });
    const completed = collectMechanicalEvidence({ ...mismatched, executionState: 'completed' });
    const runningManifest = renderManifestV2(running);
    const completedManifest = renderManifestV2(completed);

    expect(running.outcome.validationState).toBe('indeterminate');
    expect(running.outcome.primaryReason).toBe('gate_scope_mismatch');
    expect(runningManifest).toContain('VALIDATION: INDETERMINATE');
    expect(runningManifest).toContain('validation=indeterminate');
    expect(runningManifest).not.toContain('VALIDATION: FAIL');
    expect(completed.outcome.validationState).toBe('failed');
    expect(completedManifest).toContain('VALIDATION: FAIL');
  });

  it('finds the PR by HEAD sha when the authority branch has no PR', async () => {
    const authority = authorityRecord();
    const run = runtimeRunner({
      headSha: EXAMPLE_HEAD,
      headBranch: 'fix/wo-example-01',
      originRemote: authority.canonicalRemote,
      baseSha: authority.baseSha,
      diffPaths: EXAMPLE_FILES,
      onGh: headShaLookupGh({
        authorityBranch: authority.headBranch,
        repository: 'bluedevilcollectibles/example',
        headSha: EXAMPLE_HEAD,
        list: [
          {
            number: 77,
            sha: EXAMPLE_HEAD,
            ref: 'feat/wo-example-01-thread-7777777',
            base: authority.baseBranch,
          },
        ],
        viewByNumber: number =>
          prViewJson({
            url: EXAMPLE_PR_URL,
            number,
            baseRefName: authority.baseBranch,
            headRefName: 'feat/wo-example-01-thread-7777777',
            headRefOid: EXAMPLE_HEAD,
            files: EXAMPLE_FILES,
          }),
      }),
    });

    const evidence = await collectRuntimeEvidence(
      evidenceStore(authority),
      run,
      runtimeRequest(authority, 'running')
    );

    expect(evidence.pullRequest?.number).toBe(77);
    expect(evidence.scopeValid).toBe(true);
  });

  it('returns no PR when the HEAD sha lookup is ambiguous or fails', async () => {
    const authority = authorityRecord();
    const collect = async (list: readonly HeadPull[] | 'throw') => {
      const run = runtimeRunner({
        headSha: EXAMPLE_HEAD,
        headBranch: 'fix/wo-example-01',
        originRemote: authority.canonicalRemote,
        baseSha: authority.baseSha,
        diffPaths: EXAMPLE_FILES,
        onGh: headShaLookupGh({
          authorityBranch: authority.headBranch,
          repository: 'bluedevilcollectibles/example',
          headSha: EXAMPLE_HEAD,
          list,
          viewByNumber: number =>
            prViewJson({
              url: `https://github.com/bluedevilcollectibles/example/pull/${String(number)}`,
              number,
              baseRefName: authority.baseBranch,
              headRefName: 'feat/ambiguous',
              headRefOid: EXAMPLE_HEAD,
              files: EXAMPLE_FILES,
            }),
        }),
      });
      return collectRuntimeEvidence(
        evidenceStore(authority),
        run,
        runtimeRequest(authority, 'completed')
      );
    };

    const ambiguous = await collect([
      { number: 77, sha: EXAMPLE_HEAD, ref: 'feat/a', base: authority.baseBranch },
      { number: 78, sha: EXAMPLE_HEAD, ref: 'feat/b', base: authority.baseBranch },
    ]);
    const failed = await collect('throw');

    expect(ambiguous.pullRequest).toBeNull();
    expect(ambiguous.scopeValid).toBe(false);
    expect(ambiguous.outcome.validationState).toBe('failed');
    expect(ambiguous.outcome.primaryReason).toBe('gate_scope_mismatch');
    expect(failed.pullRequest).toBeNull();
    expect(failed.scopeValid).toBe(false);
    expect(failed.outcome.validationState).toBe('failed');
    expect(failed.outcome.primaryReason).toBe('gate_scope_mismatch');
  });

  it('replays run 6ebc4988 as validation passed with PR 770', async () => {
    const evidence = await collectReplay(REPLAY_6EBC);

    expect(evidence.outcome.validationState).toBe('passed');
    expect(evidence.outcome.reasonCodes).not.toContain('gate_scope_mismatch');
    expect(evidence.pullRequest?.number).toBe(770);
  });

  it('replays run ea46da63 as validation passed with PR 758', async () => {
    const evidence = await collectReplay(REPLAY_EA46);

    expect(evidence.outcome.validationState).toBe('passed');
    expect(evidence.pullRequest?.number).toBe(758);
    expect(evidence.outcome.reasonCodes).not.toContain('gate_scope_mismatch');
  });

  it('renders VALIDATION PASS and the PR url for the replayed 6ebc4988 evidence', async () => {
    const evidence = await collectReplay(REPLAY_6EBC);
    const manifest = renderManifestV2(evidence);
    const outcomeLine = manifest.split('\n').find(line => line.startsWith('OUTCOME:'));

    expect(manifest).toContain('VALIDATION: PASS');
    expect(manifest).toContain('PRs: https://github.com/thinmansoftware/shopops/pull/770');
    expect(manifest).not.toContain('gate_scope_mismatch');
    expect(outcomeLine).toContain('validation=passed');
  });

  it('keeps the by-branch PR and does not call the HEAD sha lookup', async () => {
    const authority = authorityRecord();
    const apiCalls: string[][] = [];
    const viewJson = prViewJson({
      url: 'https://github.com/bluedevilcollectibles/example/pull/42',
      number: 42,
      baseRefName: authority.baseBranch,
      headRefName: authority.headBranch,
      headRefOid: EXAMPLE_HEAD,
      files: EXAMPLE_FILES,
    });
    const inner = runtimeRunner({
      headSha: EXAMPLE_HEAD,
      headBranch: authority.headBranch,
      originRemote: authority.canonicalRemote,
      baseSha: authority.baseSha,
      diffPaths: EXAMPLE_FILES,
      onGh: async args => {
        if (args[0] === 'api') throw new Error('gh api must not run');
        if (args[0] === 'pr' && args[1] === 'view' && args[2] === authority.headBranch) {
          return { stdout: viewJson };
        }
        throw new Error(`unexpected gh ${args.join(' ')}`);
      },
    });
    const run: EvidenceCommandRunner = async (command, args, cwd) => {
      if (command === 'gh' && args[0] === 'api') apiCalls.push([...args]);
      return inner(command, args, cwd);
    };

    const evidence = await collectRuntimeEvidence(
      evidenceStore(authority),
      run,
      runtimeRequest(authority, 'running')
    );

    expect(evidence.pullRequest?.number).toBe(42);
    expect(evidence.pullRequest?.url).toBe(
      'https://github.com/bluedevilcollectibles/example/pull/42'
    );
    expect(apiCalls).toHaveLength(0);
  });
});
