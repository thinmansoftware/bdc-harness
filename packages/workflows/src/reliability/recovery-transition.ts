// M-26 dual-truth run recovery orchestration.
//
// transitionRunRecovery() is the SOLE entry point for operator-driven recovery
// transitions (start | complete | abandon | reopen). It loads immutable run
// authority, the terminal outcome, and the terminal Git evidence; verifies the
// transition's evidence and fence FAIL-CLOSED before any mutation; then delegates
// the atomic apply to finalizeSupervisorRecoveryTransition() in the DB layer.
//
// It NEVER changes execution truth. execution_state remains failed/cancelled;
// only validation/recovery/deliverable/evidence move.
//
// Design note (WO Ambiguity 3): this module does NOT reuse
// coordinateSupervisorRecovery(). That coordinator is built for the automatic
// dual-supervisor observe-then-repair flow and carries incident side effects
// (open->repairing on reserve, recovered on finalize) that do not fit the
// exhaustive 4-way manual state machine. Instead it reuses the shared fencing
// primitives (createSupervisorIncident, claimSupervisorRepairLease,
// releaseSupervisorRepairLease) and the single atomic
// finalizeSupervisorRecoveryTransition() finalizer. supervisor.ts is left
// untouched; its tests passing unmodified are the non-interference proof.

import type { IWorkflowStore } from '../store';
import type { PullRequestEvidence } from './evidence-collector';
import type {
  RecoveryActionType,
  RecoveryState,
  RunOutcome,
  SupervisorActionReservation,
} from './types';

/** Recovery from-state sets per action type (M-26 Section 6). */
const RECOVERY_FROM: Record<RecoveryActionType, readonly RecoveryState[]> = {
  start: ['recoverable'],
  complete: ['recoverable', 'recovering'],
  abandon: ['recoverable', 'recovering'],
  reopen: ['abandoned_by_operator'],
};

const RECOVERY_TO: Record<RecoveryActionType, RecoveryState> = {
  start: 'recovering',
  complete: 'recovered',
  abandon: 'abandoned_by_operator',
  reopen: 'recoverable',
};

export interface RecoveryTransitionRequest {
  readonly runId: string;
  readonly actionType: RecoveryActionType;
  readonly attemptId: string;
  /** Authenticated operator principal, derived server-side (never caller-authoritative). */
  readonly ownerId: string;
  /** Required for `complete`. */
  readonly pullRequestNumber?: number;
  /** Required for `abandon`. */
  readonly reason?: string;
  /** Repair-lease duration in ms. */
  readonly leaseDurationMs: number;
}

export interface RecoveryTransitionDeps {
  readonly store: IWorkflowStore;
  /** Fetch live PR evidence by number from the canonical remote. Null if not found. */
  fetchPullRequest(pullRequestNumber: number): Promise<PullRequestEvidence | null>;
  /** Injected clock (ISO-8601). */
  now(): string;
  /** Injected id generator. */
  newId(): string;
}

export type RecoveryTransitionResult =
  | {
      readonly status: 'applied' | 'unchanged';
      readonly recoveryState: RecoveryState;
      readonly evidenceRefs: readonly string[];
    }
  | { readonly status: 'conflict'; readonly reason: string }
  | { readonly status: 'rejected'; readonly reason: string };

type RequiredRecoveryStore = Required<
  Pick<
    IWorkflowStore,
    | 'getRunAuthority'
    | 'getRunOutcome'
    | 'createSupervisorIncident'
    | 'claimSupervisorRepairLease'
    | 'releaseSupervisorRepairLease'
    | 'finalizeSupervisorRecoveryTransition'
  >
>;

function requireRecoveryStore(store: IWorkflowStore): RequiredRecoveryStore {
  const methods: readonly (keyof RequiredRecoveryStore)[] = [
    'getRunAuthority',
    'getRunOutcome',
    'createSupervisorIncident',
    'claimSupervisorRepairLease',
    'releaseSupervisorRepairLease',
    'finalizeSupervisorRecoveryTransition',
  ];
  for (const method of methods) {
    if (typeof store[method] !== 'function') {
      throw new Error(`recovery_store_unavailable: ${method}`);
    }
  }
  return store as RequiredRecoveryStore;
}

/** Parse the terminal head SHA from a `git:<base>...<head>` evidence ref. */
function terminalGitRefOf(outcome: RunOutcome): string | null {
  return outcome.evidenceRefs.find(ref => /^git:[0-9a-fA-F]+\.\.\.[0-9a-fA-F]+$/.test(ref)) ?? null;
}

function terminalHeadOf(gitRef: string): string {
  const match = /^git:[0-9a-fA-F]+\.\.\.([0-9a-fA-F]+)$/.exec(gitRef);
  return match?.[1] ?? '';
}

function sanitizeEvidenceValue(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 300);
}

/**
 * Orchestrate one operator-driven recovery transition. Fails closed BEFORE any
 * reservation on: missing authority, missing terminal Git evidence, non-terminal
 * execution, wrong PR head/base, non-passed stop conditions, or absent merge
 * proof. Returns applied | unchanged | conflict | rejected.
 */
export async function transitionRunRecovery(
  deps: RecoveryTransitionDeps,
  request: RecoveryTransitionRequest
): Promise<RecoveryTransitionResult> {
  const store = requireRecoveryStore(deps.store);
  const { actionType, runId, ownerId, attemptId } = request;

  const authority = await store.getRunAuthority(runId);
  if (!authority) return { status: 'rejected', reason: 'scope_authority_missing' };

  const outcome = await store.getRunOutcome(runId);
  if (!outcome) return { status: 'rejected', reason: 'outcome_missing' };

  if (outcome.executionState !== 'failed' && outcome.executionState !== 'cancelled') {
    return { status: 'rejected', reason: 'execution_not_terminal' };
  }

  const terminalGitRef = terminalGitRefOf(outcome);
  if (!terminalGitRef) return { status: 'rejected', reason: 'terminal_git_evidence_missing' };
  const terminalHead = terminalHeadOf(terminalGitRef);

  if (!RECOVERY_FROM[actionType].includes(outcome.recoveryState)) {
    return { status: 'rejected', reason: `recovery_from_state_invalid:${outcome.recoveryState}` };
  }

  // Per-action evidence gate (fail-closed before reservation).
  let structured: {
    pullRequestNumber?: number;
    recoveredHeadSha?: string;
    targetBase?: string;
    mergeSha?: string;
  } = {};
  const evidenceRefs: string[] = [];

  if (actionType === 'complete') {
    if (typeof request.pullRequestNumber !== 'number' || request.pullRequestNumber <= 0) {
      return { status: 'rejected', reason: 'pull_request_number_required' };
    }
    if (outcome.validationState !== 'passed') {
      return { status: 'rejected', reason: 'stop_conditions_not_passed' };
    }
    const pr = await deps.fetchPullRequest(request.pullRequestNumber);
    if (!pr) return { status: 'rejected', reason: 'pr_evidence_unavailable' };
    if (pr.number !== request.pullRequestNumber) {
      return { status: 'rejected', reason: 'pr_number_mismatch' };
    }
    if (pr.state !== 'MERGED') return { status: 'rejected', reason: 'pr_not_merged' };
    if (!pr.mergeSha) return { status: 'rejected', reason: 'merge_sha_missing' };
    // Terminal-head equality: v1 requires a new run when terminal-head equality is
    // lost (no rebased/cherry-picked lineage). A deleted head branch is accepted
    // only through this live merged-PR headRefOid match.
    if (!pr.headSha || pr.headSha !== terminalHead) {
      return { status: 'rejected', reason: 'pr_head_mismatch' };
    }
    if (pr.baseRef !== authority.baseBranch) {
      return { status: 'rejected', reason: 'pr_base_mismatch' };
    }
    structured = {
      pullRequestNumber: pr.number,
      recoveredHeadSha: pr.headSha,
      targetBase: pr.baseRef,
      mergeSha: pr.mergeSha,
    };
    evidenceRefs.push(
      `recovery:complete:by:${sanitizeEvidenceValue(ownerId)}`,
      `pr:${String(pr.number)}`,
      `recovered-head:${pr.headSha}`,
      `target-base:${pr.baseRef}`,
      `merge:${pr.mergeSha}`
    );
  } else if (actionType === 'abandon') {
    if (!request.reason || request.reason.trim() === '') {
      return { status: 'rejected', reason: 'abandon_reason_required' };
    }
    evidenceRefs.push(
      `recovery:abandon:by:${sanitizeEvidenceValue(ownerId)}`,
      `recovery:reason:${sanitizeEvidenceValue(request.reason)}`
    );
  } else if (actionType === 'start') {
    evidenceRefs.push(`recovery:start:by:${sanitizeEvidenceValue(ownerId)}`);
  } else {
    // reopen
    evidenceRefs.push(`recovery:reopen:by:${sanitizeEvidenceValue(ownerId)}`);
  }

  const now = deps.now();

  // Ensure the run's recovery incident exists (idempotent by incident_key). Use
  // the RETURNED incident id -- an existing (possibly abandoned) incident is
  // reused rather than duplicated.
  const incident = await store.createSupervisorIncident({
    incidentId: deps.newId(),
    incidentKey: `recovery:${runId}`,
    runId,
    woId: authority.woId,
    status: 'open',
    createdAt: now,
    updatedAt: now,
  });

  // Fence the transition on the incident's repair lease.
  const lease = await store.claimSupervisorRepairLease({
    incidentId: incident.incidentId,
    ownerId,
    leaseDurationMs: request.leaseDurationMs,
  });
  if (!lease) return { status: 'conflict', reason: 'repair_lease_unavailable' };

  try {
    const reservation: SupervisorActionReservation =
      await store.finalizeSupervisorRecoveryTransition({
        runId,
        incidentId: incident.incidentId,
        ownerId,
        fencingToken: lease.fencingToken,
        actionId: deps.newId(),
        attemptId,
        actionType,
        now,
        expectedTerminalGitRef: terminalGitRef,
        evidenceRefs,
        pullRequestNumber: structured.pullRequestNumber ?? null,
        recoveredHeadSha: structured.recoveredHeadSha ?? null,
        targetBase: structured.targetBase ?? null,
        mergeSha: structured.mergeSha ?? null,
      });
    if (reservation === 'conflict') {
      return { status: 'conflict', reason: 'recovery_transition_conflict' };
    }
    return { status: reservation, recoveryState: RECOVERY_TO[actionType], evidenceRefs };
  } finally {
    await store
      .releaseSupervisorRepairLease({
        incidentId: incident.incidentId,
        ownerId,
        fencingToken: lease.fencingToken,
        releasedAt: deps.now(),
      })
      .catch(() => false);
  }
}
