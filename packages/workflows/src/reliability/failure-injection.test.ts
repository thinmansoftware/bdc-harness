import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  clearRegistry,
  registerBuiltinProviders,
  registerCommunityProviders,
} from '@archon/providers';
import {
  assertProviderCanExecuteNode,
  isAvailabilityError,
  selectQuotaExhaustionRoute,
} from '../node-failover';
import type { DagNode } from '../schemas/dag-node';
import type { IWorkflowStore } from '../store';
import { collectMechanicalEvidence, type MechanicalEvidenceInput } from './evidence-collector';
import { reduceMultiStageLifecycle } from './multi-stage-lifecycle';
import { projectRunOutcome, reduceRunOutcome } from './outcome-reducer';
import { processDueProviderWaits } from './wait-scheduler';
import type { ScheduledProviderWaitRecord } from './types';

const tempDirs: string[] = [];

beforeAll(() => {
  clearRegistry();
  registerBuiltinProviders();
  registerCommunityProviders();
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function durable<T>(caseName: string, value: T): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'cauldron-failure-'));
  tempDirs.push(dir);
  const path = join(dir, `${caseName}.json`);
  await writeFile(path, JSON.stringify(value), 'utf8');
  const subprocess = Bun.spawn(
    [
      process.execPath,
      '-e',
      'const p=process.argv[1]; const v=await Bun.file(p).json(); process.stdout.write(JSON.stringify(v));',
      path,
    ],
    { stdout: 'pipe', stderr: 'pipe' }
  );
  const output = await new Response(subprocess.stdout).text();
  const stderr = await new Response(subprocess.stderr).text();
  expect(await subprocess.exited, stderr).toBe(0);
  return JSON.parse(output) as T;
}

function outcome(
  overrides: Partial<Parameters<typeof reduceRunOutcome>[0]> = {}
): Parameters<typeof reduceRunOutcome>[0] {
  return {
    executionState: 'running',
    deliverable: {},
    validation: { required: true, state: 'not_run' },
    recoveryState: 'not_needed',
    routeState: 'current',
    requirements: { deliverable: 'pr_ready' },
    evidenceRefs: ['fixture://failure-injection'],
    ...overrides,
  };
}

function evidence(overrides: Partial<MechanicalEvidenceInput> = {}): MechanicalEvidenceInput {
  const authority = {
    runId: 'run-fixture',
    dispatchId: 'dispatch-fixture',
    woId: 'WO-FAILURE-INJECTION',
    specSource: 'github:owner/repo:spec.md',
    specRevision: '1'.repeat(40),
    specHash: `sha256:${'2'.repeat(64)}`,
    workflowName: 'bdc-feature-development',
    codebaseId: 'codebase-1',
    canonicalRemote: 'https://github.com/owner/repo.git',
    baseBranch: 'main',
    baseSha: '3'.repeat(40),
    runScopeSha: '3'.repeat(40),
    headBranch: 'archon/failure-fixture',
    worktreePath: '/fixture/worktree',
    workflowRevision: `sha256:${'4'.repeat(64)}`,
    bundleRevision: `sha256:${'5'.repeat(64)}`,
    engineRevision: `sha256:${'6'.repeat(64)}`,
    runtimeImageRevision: null,
    createdAt: '2026-07-09T12:00:00.000Z',
  };
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
      changes: [{ status: 'M', path: 'src/changed.ts' }],
    },
    pullRequest: {
      url: 'https://github.com/owner/repo/pull/42',
      number: 42,
      state: 'OPEN',
      draft: false,
      baseRef: 'main',
      headRef: authority.headBranch,
      headSha,
      files: ['src/changed.ts'],
      requiredChecks: [{ name: 'ci', state: 'passed' }],
    },
    gates: [{ id: 'evidence', required: true, state: 'passed' }],
    ...overrides,
  };
}

function scheduledWait(provider: string): ScheduledProviderWaitRecord {
  return {
    waitId: `wait-${provider}`,
    runId: 'run-fixture',
    attemptId: `attempt-${provider}`,
    provider,
    reasonCode: 'provider_quota_wait',
    resumeAt: '2026-07-09T13:00:00.000Z',
    state: 'scheduled',
    claimOwnerId: null,
    claimToken: null,
    createdAt: '2026-07-09T12:00:00.000Z',
    claimedAt: null,
    cancelledAt: null,
    completedAt: null,
  };
}

describe('Smart Cauldron controlled failure injection', () => {
  test('Claude exhausted routes sideways to capable Codex', async () => {
    const node = {
      id: 'implement',
      prompt: 'Implement.',
      failover_provider: 'codex',
      failover_model: 'sol',
    } as DagNode;
    expect(selectQuotaExhaustionRoute('claude', node, {})).toEqual({
      kind: 'failover',
      provider: 'codex',
      model: 'sol',
    });
  });

  test('Codex exhausted routes sideways to capable Claude', async () => {
    const node = {
      id: 'implement',
      prompt: 'Implement.',
      failover_provider: 'claude',
      failover_model: 'fable',
    } as DagNode;
    expect(selectQuotaExhaustionRoute('codex', node, {})).toEqual({
      kind: 'failover',
      provider: 'claude',
      model: 'fable',
    });
  });

  test('quota exhaustion waits when the declared failover lacks execution capability', () => {
    const node = {
      id: 'apply-patch',
      prompt: 'Fix it.',
      failover_provider: 'opr-zero',
    } as DagNode;
    expect(selectQuotaExhaustionRoute('claude', node, {})).toEqual({ kind: 'wait' });
  });

  test('all capable providers exhausted remains a durable provider wait after restart', async () => {
    const wait = await durable('all-exhausted', scheduledWait('all-capable'));
    const reduced = reduceRunOutcome(
      outcome({
        executionState: 'waiting_provider',
        recoveryState: 'recoverable',
        reasonCodes: ['all_capable_providers_exhausted'],
      })
    );
    expect(wait.state).toBe('scheduled');
    expect(projectRunOutcome(reduced, outcome({ executionState: 'waiting_provider' }))).toBe(
      'waiting_provider'
    );
  });

  test('zero-token contradiction is not rewritten as quota exhaustion', async () => {
    const persisted = await durable(
      'zero-token-contradiction',
      reduceRunOutcome(outcome({ reasonCodes: ['sdk_contradiction'] }))
    );
    expect(persisted.primaryReason).toBe('sdk_contradiction');
    expect(persisted.reasonCodes).not.toContain('provider_quota_exhausted');
  });

  test('chat-only fallback is rejected before repository dispatch', async () => {
    const node = {
      id: 'implement',
      persona: 'major-build',
      loop: { prompt: 'Implement.', until: 'COMPLETE', max_iterations: 2 },
    } as DagNode;
    let error = '';
    try {
      assertProviderCanExecuteNode('opr-zero', node);
    } catch (caught) {
      error = (caught as Error).message;
    }
    const persisted = await durable('chat-only-rejected', { error, providerCallCount: 0 });
    expect(persisted.error).toContain('provider_execution_capability_mismatch');
    expect(persisted.providerCallCount).toBe(0);
  });

  test('worker kill during implementation preserves recoverable worktree changes', async () => {
    const persisted = await durable(
      'worker-kill-implementation',
      reduceRunOutcome(
        outcome({
          executionState: 'interrupted',
          recoveryState: 'recoverable',
          deliverable: { worktreeChanges: true },
          reasonCodes: ['worker_lease_expired'],
        })
      )
    );
    expect(persisted.executionState).toBe('interrupted');
    expect(persisted.deliverableState).toBe('worktree_changes');
  });

  test('worker kill during provider wait leaves a resumable scheduled wait', async () => {
    const persisted = await durable('worker-kill-wait', {
      wait: scheduledWait('claude'),
      outcome: reduceRunOutcome(
        outcome({ executionState: 'waiting_provider', recoveryState: 'recoverable' })
      ),
    });
    expect(persisted.wait.state).toBe('scheduled');
    expect(persisted.outcome.executionState).toBe('waiting_provider');
  });

  test('cancellation racing a due-wait claim cannot resume the run', async () => {
    let reads = 0;
    const resume = mock(async () => undefined);
    const store = {
      listDueProviderWaits: mock(async () => [scheduledWait('claude')]),
      getWorkflowRunStatus: mock(async () => (reads++ === 0 ? 'waiting_provider' : 'cancelled')),
      claimProviderWait: mock(async () => true),
      completeProviderWait: mock(async () => true),
      cancelProviderWaits: mock(async () => 1),
      releaseProviderWaitClaim: mock(async () => true),
    } as unknown as IWorkflowStore;
    const result = await processDueProviderWaits(store, resume, {
      ownerId: 'scheduler-fixture',
      now: () => new Date('2026-07-09T14:00:00.000Z'),
    });
    const persisted = await durable('cancel-race', result);
    expect(persisted.cancelled).toBe(1);
    expect(resume).not.toHaveBeenCalled();
  });

  test('provider-internal failback is availability-only for loop and non-loop nodes', async () => {
    const persisted = await durable('internal-failback', {
      loop: isAvailabilityError('service unavailable', 503),
      prompt: isAvailabilityError('connection reset'),
      quality: isAvailabilityError('validator says needs revision'),
    });
    expect(persisted).toEqual({ loop: true, prompt: true, quality: false });
  });

  test('terminal persistence failure remains interrupted and recoverable', async () => {
    const persisted = await durable(
      'terminal-persist-failure',
      reduceRunOutcome(
        outcome({
          executionState: 'interrupted',
          recoveryState: 'recoverable',
          reasonCodes: ['status_persist_failed'],
        })
      )
    );
    expect(persisted.executionState).toBe('interrupted');
    expect(persisted.primaryReason).toBe('status_persist_failed');
  });

  test('wrong base fails while unrelated legacy ASCII debt stays outside the run diff', async () => {
    const original = evidence();
    const collected = collectMechanicalEvidence(
      evidence({ git: { ...original.git, mergeBaseSha: '9'.repeat(40) } })
    );
    const persisted = await durable('wrong-base-legacy-ascii', collected);
    expect(persisted.scopeValid).toBe(false);
    expect(persisted.git.changes.map(change => change.path)).toEqual(['src/changed.ts']);
  });

  test('fabricated PR URL is rejected even when refs and files look plausible', async () => {
    const original = evidence();
    const collected = collectMechanicalEvidence(
      evidence({
        pullRequest: {
          ...original.pullRequest!,
          url: 'https://github.com/other/repo/pull/376',
          number: 376,
        },
      })
    );
    const persisted = await durable('fabricated-pr-url', collected);
    expect(persisted.scopeValid).toBe(false);
    expect(persisted.pullRequestReady).toBe(false);
  });

  test('multi-stage predecessor block cannot execute or promote its successor', async () => {
    const first = {
      stageId: 'backend',
      branchName: 'archon/WO-FIXTURE/backend',
      repo: 'owner/repo',
      targetBranch: 'main',
      baseSha: 'a'.repeat(40),
    };
    const second = { ...first, stageId: 'ui', branchName: 'archon/WO-FIXTURE/ui' };
    const blocked = {
      stageId: first.stageId,
      status: 'BLOCKED' as const,
      authority: first,
      attempts: [
        {
          attemptNumber: 1,
          startedAt: '2026-07-09T12:00:00.000Z',
          completedAt: '2026-07-09T12:05:00.000Z',
          result: 'blocked' as const,
        },
      ],
      evidence: {
        prUrl: null,
        exactFiles: ['src/backend.ts'],
        verifyResult: 'failed',
        reviewResult: 'not run',
      },
      blockingReason: 'verify_failed',
    };
    const manifest = await durable(
      'blocked-predecessor',
      reduceMultiStageLifecycle([first, second], [blocked])
    );
    expect(manifest.parentProjection).toBe('failed');
    expect(manifest.stages[1]?.status).toBe('NOT_RUN');
  });
});
