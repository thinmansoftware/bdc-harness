// M-26 dual-truth run recovery -- orchestration tests for transitionRunRecovery().
//
// These exercise the ORCHESTRATOR's fail-closed evidence and fence gates that
// run BEFORE any reservation. The atomic DB apply
// (finalizeSupervisorRecoveryTransition) is mocked here and tested against a
// real SQLite database in packages/core/src/db/workflows.test.ts. Together they
// cover WO Section 11 Tests 1-5 and 9.
//
// Invariant under test: transitionRunRecovery NEVER touches execution truth and
// NEVER reaches the finalizer when any evidence/fence gate fails closed.

import { describe, test, expect } from 'bun:test';
import { transitionRunRecovery } from './recovery-transition';
import type { RecoveryTransitionDeps, RecoveryTransitionRequest } from './recovery-transition';
import type { GateEvidence, PullRequestEvidence } from './evidence-collector';
import type { IWorkflowStore } from '../store';
import type {
  RunAuthorityRecord,
  RunOutcome,
  SupervisorActionReservation,
  SupervisorIncidentRecord,
  SupervisorRepairLeaseRecord,
} from './types';

const RUN_ID = 'run-26';
const OWNER = 'xo:john';
const BASE = 'dev';
const TERMINAL_HEAD = 'ffeeddccbbaa00112233445566778899aabbccdd';
const TERMINAL_BASE = '00112233445566778899aabbccddeeff00112233';
const TERMINAL_GIT_REF = `git:${TERMINAL_BASE}...${TERMINAL_HEAD}`;
const MERGE_SHA = 'aabbccdd00112233445566778899aabbccddeeff';

function authority(overrides: Partial<RunAuthorityRecord> = {}): RunAuthorityRecord {
  return {
    runId: RUN_ID,
    dispatchId: 'dispatch-1',
    woId: 'WO-HARNESS-RUN-RECOVERY-DUAL-TRUTH-01',
    specSource: 'github:bluedevilcollectibles/bdc-xo',
    specRevision: 'rev1',
    specHash: 'sha256:abc',
    workflowName: 'implement',
    codebaseId: 'cb-1',
    canonicalRemote: 'https://github.com/bluedevilcollectibles/bdc-harness.git',
    baseBranch: BASE,
    baseSha: TERMINAL_BASE,
    runScopeSha: TERMINAL_BASE,
    headBranch: 'feature/wo',
    worktreePath: '/tmp/wt',
    workflowRevision: 'wf1',
    bundleRevision: 'b1',
    engineRevision: 'e1',
    runtimeImageRevision: null,
    createdAt: '2026-07-12T00:00:00.000Z',
    ...overrides,
  };
}

function outcome(overrides: Partial<RunOutcome> = {}): RunOutcome {
  return {
    executionState: 'failed',
    deliverableState: 'pr_ready',
    validationState: 'passed',
    recoveryState: 'recoverable',
    routeState: 'current',
    primaryReason: 'execution_failed_pr_ready',
    reasonCodes: ['execution_failed_pr_ready'],
    evidenceRefs: [TERMINAL_GIT_REF, 'gate:validate:passed'],
    ...overrides,
  };
}

function mergedPr(overrides: Partial<PullRequestEvidence> = {}): PullRequestEvidence {
  return {
    url: 'https://github.com/bluedevilcollectibles/bdc-harness/pull/394',
    number: 394,
    state: 'MERGED',
    draft: false,
    baseRef: BASE,
    headRef: 'feature/wo',
    headSha: TERMINAL_HEAD,
    mergeSha: MERGE_SHA,
    files: ['packages/x.ts'],
    requiredChecks: [{ name: 'validate', state: 'passed' }],
    ...overrides,
  };
}

interface FakeStoreConfig {
  authority?: RunAuthorityRecord | null;
  outcome?: RunOutcome | null;
  lease?: SupervisorRepairLeaseRecord | null;
  finalize?: SupervisorActionReservation;
  recoveryActions?: Awaited<
    ReturnType<NonNullable<IWorkflowStore['getRunRecoveryDetails']>>
  >['actions'];
  gates?: readonly GateEvidence[];
}

interface Harness {
  deps: RecoveryTransitionDeps;
  finalizeCalls: Parameters<
    NonNullable<IWorkflowStore['finalizeSupervisorRecoveryTransition']>
  >[0][];
  releaseCalls: number;
  reserveCalls: number;
  fetchCalls: number;
  gateCalls: number;
}

function makeHarness(
  config: FakeStoreConfig = {},
  prByNumber?: PullRequestEvidence | null
): Harness {
  const finalizeCalls: Harness['finalizeCalls'] = [];
  const state = { releaseCalls: 0, reserveCalls: 0, fetchCalls: 0, gateCalls: 0 };
  let idCounter = 0;

  const incident: SupervisorIncidentRecord = {
    incidentId: 'inc-1',
    incidentKey: `recovery:${RUN_ID}`,
    runId: RUN_ID,
    woId: authority().woId,
    status: 'open',
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
  };
  const lease: SupervisorRepairLeaseRecord = config.lease ?? {
    incidentId: 'inc-1',
    ownerId: OWNER,
    fencingToken: 1,
    acquiredAt: '2026-07-12T00:00:01.000Z',
    lastHeartbeatAt: '2026-07-12T00:00:01.000Z',
    expiresAt: '2026-07-12T00:01:01.000Z',
    releasedAt: null,
  };

  const store: Partial<IWorkflowStore> = {
    getRunAuthority: async () => (config.authority === undefined ? authority() : config.authority),
    getRunOutcome: async () => (config.outcome === undefined ? outcome() : config.outcome),
    createSupervisorIncident: async () => incident,
    claimSupervisorRepairLease: async () => (config.lease === undefined ? lease : config.lease),
    releaseSupervisorRepairLease: async () => {
      state.releaseCalls += 1;
      return true;
    },
    getRunRecoveryDetails: async () => ({
      outcome: config.outcome === undefined ? outcome() : config.outcome,
      actions: config.recoveryActions ?? [],
    }),
    finalizeSupervisorRecoveryTransition: async data => {
      state.reserveCalls += 1;
      finalizeCalls.push(data);
      return config.finalize ?? 'applied';
    },
  };

  const deps: RecoveryTransitionDeps = {
    store: store as IWorkflowStore,
    fetchPullRequest: async () => {
      state.fetchCalls += 1;
      return prByNumber === undefined ? mergedPr() : prByNumber;
    },
    loadRequiredGateEvidence: async () => {
      state.gateCalls += 1;
      return config.gates ?? [{ id: 'validate', required: true, state: 'passed' }];
    },
    now: () => '2026-07-12T00:00:05.000Z',
    newId: () => `id-${String(++idCounter)}`,
  };

  return {
    deps,
    finalizeCalls,
    get releaseCalls() {
      return state.releaseCalls;
    },
    get reserveCalls() {
      return state.reserveCalls;
    },
    get fetchCalls() {
      return state.fetchCalls;
    },
    get gateCalls() {
      return state.gateCalls;
    },
  };
}

function request(overrides: Partial<RecoveryTransitionRequest> = {}): RecoveryTransitionRequest {
  return {
    runId: RUN_ID,
    actionType: 'complete',
    attemptId: '11111111-1111-4111-8111-111111111111',
    ownerId: OWNER,
    pullRequestNumber: 394,
    leaseDurationMs: 60_000,
    ...overrides,
  };
}

describe('M-26 transitionRunRecovery orchestration', () => {
  // Test 1 -- successful recovered transition delegates the exact structured
  // payload and preserves execution truth (execution never mutated here).
  test('Test 1: complete succeeds and forwards structured merged-PR evidence', async () => {
    const h = makeHarness();
    const result = await transitionRunRecovery(h.deps, request());
    expect(result.status).toBe('applied');
    if (result.status !== 'applied') throw new Error('unreachable');
    expect(result.recoveryState).toBe('recovered');
    expect(h.finalizeCalls).toHaveLength(1);
    const call = h.finalizeCalls[0];
    expect(call.actionType).toBe('complete');
    expect(call.expectedTerminalGitRef).toBe(TERMINAL_GIT_REF);
    expect(call.pullRequestNumber).toBe(394);
    expect(call.recoveredHeadSha).toBe(TERMINAL_HEAD);
    expect(call.targetBase).toBe(BASE);
    expect(call.mergeSha).toBe(MERGE_SHA);
    // Evidence appended, terminal ref never in the appended set (it stays in outcome).
    expect(call.evidenceRefs).toContain(`merge:${MERGE_SHA}`);
    expect(call.evidenceRefs).toContain(`pr:394`);
    // Lease released even on the happy path.
    expect(h.releaseCalls).toBe(1);
  });

  // Test 2 -- validated but unmerged: green + pr_ready but PR not merged stays
  // recoverable and NEVER reaches the finalizer (never becomes recovered).
  test('Test 2: validated-but-unmerged PR is rejected, outcome untouched', async () => {
    const h = makeHarness({}, mergedPr({ state: 'OPEN', mergeSha: null }));
    const result = await transitionRunRecovery(h.deps, request());
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('unreachable');
    expect(result.reason).toBe('pr_not_merged');
    expect(h.reserveCalls).toBe(0);
    expect(h.finalizeCalls).toHaveLength(0);
  });

  // Test 3 -- lineage/validation rejection matrix; every case fails closed with
  // zero finalizer mutation and a specific reason.
  test('Test 3: rejection matrix fails closed with zero mutation', async () => {
    const cases: {
      name: string;
      run: () => Promise<{ status: string; reason?: string }>;
      reason: string;
    }[] = [
      {
        name: 'missing terminal git evidence',
        run: () => {
          const h = makeHarness({ outcome: outcome({ evidenceRefs: ['gate:validate:passed'] }) });
          return transitionRunRecovery(h.deps, request()).then(r => ({
            ...(r as { status: string; reason?: string }),
            _h: h,
          }));
        },
        reason: 'terminal_git_evidence_missing',
      },
      {
        name: 'mismatched PR head',
        run: () => {
          const h = makeHarness(
            {},
            mergedPr({ headSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' })
          );
          return transitionRunRecovery(h.deps, request()).then(
            r => r as { status: string; reason?: string }
          );
        },
        reason: 'pr_head_mismatch',
      },
      {
        name: 'wrong base',
        run: () => {
          const h = makeHarness({}, mergedPr({ baseRef: 'main' }));
          return transitionRunRecovery(h.deps, request()).then(
            r => r as { status: string; reason?: string }
          );
        },
        reason: 'pr_base_mismatch',
      },
      {
        name: 'indeterminate stop conditions',
        run: () => {
          const h = makeHarness({ outcome: outcome({ validationState: 'indeterminate' }) });
          return transitionRunRecovery(h.deps, request()).then(
            r => r as { status: string; reason?: string }
          );
        },
        reason: 'stop_conditions_not_passed',
      },
      {
        name: 'missing merge SHA',
        run: () => {
          const h = makeHarness({}, mergedPr({ mergeSha: null }));
          return transitionRunRecovery(h.deps, request()).then(
            r => r as { status: string; reason?: string }
          );
        },
        reason: 'merge_sha_missing',
      },
      {
        name: 'completed execution',
        run: () => {
          const h = makeHarness({ outcome: outcome({ executionState: 'completed' }) });
          return transitionRunRecovery(h.deps, request()).then(
            r => r as { status: string; reason?: string }
          );
        },
        reason: 'execution_not_terminal',
      },
    ];
    for (const c of cases) {
      const r = await c.run();
      expect(r.status).toBe('rejected');
      expect(r.reason).toBe(c.reason);
    }
  });

  // Test 3 (cont) -- an invalid fence (no repair lease) is a conflict BEFORE the
  // finalizer runs.
  test('Test 3: unavailable repair lease is conflict with zero mutation', async () => {
    const h = makeHarness({ lease: null });
    const result = await transitionRunRecovery(h.deps, request());
    expect(result.status).toBe('conflict');
    if (result.status !== 'conflict') throw new Error('unreachable');
    expect(result.reason).toBe('repair_lease_unavailable');
    expect(h.finalizeCalls).toHaveLength(0);
  });

  test('Test 3: complete rejects missing/failed immutable gates and required PR checks', async () => {
    const missingGate = makeHarness({ gates: [] });
    await expect(transitionRunRecovery(missingGate.deps, request())).resolves.toEqual({
      status: 'rejected',
      reason: 'required_gate_evidence_missing',
    });
    expect(missingGate.finalizeCalls).toHaveLength(0);

    const failedGate = makeHarness({
      gates: [{ id: 'validate', required: true, state: 'failed' }],
    });
    await expect(transitionRunRecovery(failedGate.deps, request())).resolves.toEqual({
      status: 'rejected',
      reason: 'stop_conditions_not_passed',
    });

    const failedCheck = makeHarness(
      {},
      mergedPr({ requiredChecks: [{ name: 'test', state: 'failed' }] })
    );
    await expect(transitionRunRecovery(failedCheck.deps, request())).resolves.toEqual({
      status: 'rejected',
      reason: 'required_pr_checks_not_passed',
    });
  });

  // Test 3 (cont) -- missing authority fails closed before any incident/lease.
  test('Test 3: missing authority is rejected before reservation', async () => {
    const h = makeHarness({ authority: null });
    const result = await transitionRunRecovery(h.deps, request());
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('unreachable');
    expect(result.reason).toBe('scope_authority_missing');
    expect(h.finalizeCalls).toHaveLength(0);
  });

  // Test 4 -- idempotency: the finalizer's unchanged/conflict verdicts are
  // propagated verbatim by the orchestrator.
  test('Test 4: finalizer unchanged and conflict verdicts propagate', async () => {
    const unchanged = makeHarness({ finalize: 'unchanged' });
    const r1 = await transitionRunRecovery(unchanged.deps, request());
    expect(r1.status).toBe('unchanged');

    const conflict = makeHarness({ finalize: 'conflict' });
    const r2 = await transitionRunRecovery(conflict.deps, request());
    expect(r2.status).toBe('conflict');
    // Even on conflict the lease is released (finally).
    expect(conflict.releaseCalls).toBe(1);
  });

  test('Test 4: identical completed retry is unchanged before target-state rejection or lease claim', async () => {
    const attemptId = '11111111-1111-4111-8111-111111111111';
    const h = makeHarness({
      outcome: outcome({ recoveryState: 'recovered' }),
      lease: null,
      recoveryActions: [
        {
          actionId: 'action-complete',
          attemptId,
          incidentId: 'inc-1',
          ownerId: OWNER,
          fencingToken: 1,
          actionType: 'complete',
          outcome: 'complete',
          evidenceRefs: [
            `recovery:complete:by:${OWNER}`,
            'pr:394',
            `recovered-head:${TERMINAL_HEAD}`,
            `target-base:${BASE}`,
            `merge:${MERGE_SHA}`,
          ],
          createdAt: '2026-07-12T00:00:05.000Z',
          status: 'completed',
          completedAt: '2026-07-12T00:00:05.000Z',
          pullRequestNumber: 394,
          recoveredHeadSha: TERMINAL_HEAD,
          targetBase: BASE,
          mergeSha: MERGE_SHA,
        },
      ],
    });
    const result = await transitionRunRecovery(h.deps, request({ attemptId }));
    expect(result.status).toBe('unchanged');
    expect(h.finalizeCalls).toHaveLength(0);
  });

  test('Test 4: identical completed retry stays unchanged when GitHub is unavailable', async () => {
    const attemptId = '11111111-1111-4111-8111-111111111111';
    const h = makeHarness(
      {
        outcome: outcome({ recoveryState: 'recovered' }),
        recoveryActions: [
          {
            actionId: 'action-complete',
            attemptId,
            incidentId: 'inc-1',
            ownerId: OWNER,
            fencingToken: 1,
            actionType: 'complete',
            outcome: 'complete',
            evidenceRefs: ['immutable-completed-evidence'],
            createdAt: '2026-07-12T00:00:05.000Z',
            status: 'completed',
            completedAt: '2026-07-12T00:00:05.000Z',
            pullRequestNumber: 394,
            recoveredHeadSha: TERMINAL_HEAD,
            targetBase: BASE,
            mergeSha: MERGE_SHA,
          },
        ],
      },
      null
    );

    await expect(transitionRunRecovery(h.deps, request({ attemptId }))).resolves.toEqual({
      status: 'unchanged',
      recoveryState: 'recovered',
      evidenceRefs: ['immutable-completed-evidence'],
    });
    expect(h.gateCalls).toBe(0);
    expect(h.fetchCalls).toBe(0);
  });

  test('Test 4: identical completed retry ignores a later required-check rerun failure', async () => {
    const attemptId = '11111111-1111-4111-8111-111111111111';
    const h = makeHarness(
      {
        outcome: outcome({ recoveryState: 'recovered' }),
        recoveryActions: [
          {
            actionId: 'action-complete',
            attemptId,
            incidentId: 'inc-1',
            ownerId: OWNER,
            fencingToken: 1,
            actionType: 'complete',
            outcome: 'complete',
            evidenceRefs: ['immutable-completed-evidence'],
            createdAt: '2026-07-12T00:00:05.000Z',
            status: 'completed',
            completedAt: '2026-07-12T00:00:05.000Z',
            pullRequestNumber: 394,
            recoveredHeadSha: TERMINAL_HEAD,
            targetBase: BASE,
            mergeSha: MERGE_SHA,
          },
        ],
      },
      mergedPr({ requiredChecks: [{ name: 'validate', state: 'failed' }] })
    );

    expect((await transitionRunRecovery(h.deps, request({ attemptId }))).status).toBe('unchanged');
    expect(h.gateCalls).toBe(0);
    expect(h.fetchCalls).toBe(0);
  });

  test('Test 4: mismatched completed-attempt tuple revalidates instead of returning unchanged', async () => {
    const attemptId = '11111111-1111-4111-8111-111111111111';
    const h = makeHarness(
      {
        recoveryActions: [
          {
            actionId: 'action-complete',
            attemptId,
            incidentId: 'inc-1',
            ownerId: OWNER,
            fencingToken: 1,
            actionType: 'complete',
            outcome: 'complete',
            evidenceRefs: ['immutable-completed-evidence'],
            createdAt: '2026-07-12T00:00:05.000Z',
            status: 'completed',
            completedAt: '2026-07-12T00:00:05.000Z',
            pullRequestNumber: 394,
            recoveredHeadSha: TERMINAL_HEAD,
            targetBase: BASE,
            mergeSha: MERGE_SHA,
          },
        ],
      },
      null
    );

    await expect(
      transitionRunRecovery(h.deps, request({ attemptId, pullRequestNumber: 395 }))
    ).resolves.toEqual({ status: 'rejected', reason: 'pr_evidence_unavailable' });
    expect(h.gateCalls).toBe(1);
    expect(h.fetchCalls).toBe(1);
  });

  test('Test 4: same abandon tuple with changed reason conflicts', async () => {
    const attemptId = '44444444-4444-4444-8444-444444444444';
    const h = makeHarness({
      outcome: outcome({ recoveryState: 'abandoned_by_operator' }),
      recoveryActions: [
        {
          actionId: 'action-abandon',
          attemptId,
          incidentId: 'inc-1',
          ownerId: OWNER,
          fencingToken: 1,
          actionType: 'abandon',
          outcome: 'abandon',
          evidenceRefs: [`recovery:abandon:by:${OWNER}`, 'recovery:reason:original reason'],
          createdAt: '2026-07-12T00:00:05.000Z',
          status: 'completed',
          completedAt: '2026-07-12T00:00:05.000Z',
        },
      ],
    });
    const result = await transitionRunRecovery(
      h.deps,
      request({ actionType: 'abandon', attemptId, reason: 'changed reason' })
    );
    expect(result.status).toBe('conflict');
    expect(h.finalizeCalls).toHaveLength(0);
  });

  // Test 5 -- abandon and reopen fencing/gating.
  test('Test 5: abandon requires a reason and preserves execution', async () => {
    const missing = makeHarness();
    const rMissing = await transitionRunRecovery(missing.deps, request({ actionType: 'abandon' }));
    expect(rMissing.status).toBe('rejected');
    if (rMissing.status !== 'rejected') throw new Error('unreachable');
    expect(rMissing.reason).toBe('abandon_reason_required');
    expect(missing.finalizeCalls).toHaveLength(0);

    const ok = makeHarness();
    const rOk = await transitionRunRecovery(
      ok.deps,
      request({ actionType: 'abandon', reason: 'superseded by fresh run' })
    );
    expect(rOk.status).toBe('applied');
    if (rOk.status !== 'applied') throw new Error('unreachable');
    expect(rOk.recoveryState).toBe('abandoned_by_operator');
    expect(ok.finalizeCalls[0].actionType).toBe('abandon');
  });

  test('Test 5: reopen only from abandoned_by_operator', async () => {
    // Wrong from-state: recovery is still recoverable.
    const wrong = makeHarness();
    const rWrong = await transitionRunRecovery(wrong.deps, request({ actionType: 'reopen' }));
    expect(rWrong.status).toBe('rejected');
    if (rWrong.status !== 'rejected') throw new Error('unreachable');
    expect(rWrong.reason).toContain('recovery_from_state_invalid');
    expect(wrong.finalizeCalls).toHaveLength(0);

    // Correct from-state.
    const ok = makeHarness({ outcome: outcome({ recoveryState: 'abandoned_by_operator' }) });
    const rOk = await transitionRunRecovery(ok.deps, request({ actionType: 'reopen' }));
    expect(rOk.status).toBe('applied');
    if (rOk.status !== 'applied') throw new Error('unreachable');
    expect(rOk.recoveryState).toBe('recoverable');
  });

  // Test 9 -- concurrent completion atomicity: exactly one finalizer wins; the
  // loser returns conflict. The orchestrator relays the DB verdict faithfully.
  test('Test 9: racing completers -- exactly one applied, the other conflict', async () => {
    const winner = makeHarness({ finalize: 'applied' });
    const loser = makeHarness({ finalize: 'conflict' });
    const [rWin, rLose] = await Promise.all([
      transitionRunRecovery(
        winner.deps,
        request({ attemptId: '22222222-2222-4222-8222-222222222222' })
      ),
      transitionRunRecovery(
        loser.deps,
        request({ attemptId: '33333333-3333-4333-8333-333333333333' })
      ),
    ]);
    const statuses = [rWin.status, rLose.status].sort();
    expect(statuses).toEqual(['applied', 'conflict']);
  });
});
