export const EXECUTION_STATES = [
  'queued',
  'running',
  'waiting_provider',
  'paused_human',
  'interrupted',
  'completed',
  'failed',
  'cancelled',
] as const;

export type ExecutionState = (typeof EXECUTION_STATES)[number];

export const DELIVERABLE_STATES = [
  'none',
  'worktree_changes',
  'committed',
  'pushed',
  'pr_open',
  'pr_ready',
] as const;

export type DeliverableState = (typeof DELIVERABLE_STATES)[number];

export const VALIDATION_STATES = ['not_run', 'passed', 'failed', 'indeterminate'] as const;

export type ValidationState = (typeof VALIDATION_STATES)[number];

export const RECOVERY_STATES = [
  'not_needed',
  'recoverable',
  'recovering',
  'recovered',
  'abandoned_by_operator',
] as const;

export type RecoveryState = (typeof RECOVERY_STATES)[number];

export const ROUTE_STATES = [
  'current',
  'failed_over',
  'escalated',
  'spec_repair',
  'exhausted',
] as const;

export type RouteState = (typeof ROUTE_STATES)[number];

export const EXECUTION_CAPABILITIES = [
  'text_generation',
  'repo_read',
  'repo_write',
  'shell',
  'network',
  'browser',
] as const;

export type ExecutionCapability = (typeof EXECUTION_CAPABILITIES)[number];

export const OUTCOME_REASON_CODES = [
  'dry_run_planned',
  'required_stage_failed',
  'required_stage_indeterminate',
  'gate_scope_mismatch',
  'gate_failed',
  'gate_indeterminate',
  'gate_not_run',
  'provider_quota_wait',
  'provider_quota_exhausted',
  'provider_unavailable',
  'provider_timeout',
  'provider_rate_limited',
  'provider_auth_failed',
  'provider_config_invalid',
  'sdk_contradiction',
  'progress_timeout',
  'attempt_cancelled',
  'served_model_mismatch',
  'capability_mismatch',
  'all_capable_providers_exhausted',
  'worker_lease_expired',
  'recovery_started',
  'recovery_completed',
  'abandoned_by_operator',
  'gate_rejection_with_successor',
  'provider_failed_over',
  'spec_repair_required',
  'execution_failed_pr_ready',
  'execution_failed',
  'pr_ready',
  'pr_not_ready',
  'verified_noop',
  'execution_completed',
  'cancelled_by_operator',
  'paused_for_human',
  'run_queued',
  'run_running',
  'scope_authority_missing',
  'status_persist_failed',
  'authority_conflict',
] as const;

export type OutcomeReasonCode = (typeof OUTCOME_REASON_CODES)[number];

export interface RunAuthorityRecord {
  readonly runId: string;
  readonly dispatchId: string;
  readonly woId: string;
  readonly specSource: string;
  readonly specRevision: string;
  readonly specHash: string;
  readonly workflowName: string;
  readonly codebaseId: string;
  readonly canonicalRemote: string;
  readonly baseBranch: string;
  readonly baseSha: string;
  readonly runScopeSha: string;
  readonly headBranch: string;
  readonly worktreePath: string;
  readonly workflowRevision: string;
  readonly bundleRevision: string;
  readonly engineRevision: string;
  readonly runtimeImageRevision: string | null;
  readonly createdAt: string;
}

export type ProviderAttemptOutcomeClass =
  | 'success'
  | 'availability'
  | 'quality'
  | 'progress'
  | 'quota'
  | 'contradiction'
  | 'cancelled';

export interface ProviderAttemptRecord {
  readonly attemptId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly attemptNumber: number;
  readonly provider: string;
  readonly model: string;
  readonly declaredProvider: string;
  readonly declaredModel: string;
  readonly requiredCapabilities: readonly ExecutionCapability[];
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly servedModelId: string | null;
  readonly outcomeClass: ProviderAttemptOutcomeClass | null;
  readonly reasonCode: OutcomeReasonCode | null;
  readonly resumeAt: string | null;
  readonly supersedesAttemptId: string | null;
}

export interface RunLeaseRecord {
  readonly runId: string;
  readonly ownerId: string;
  readonly leaseToken: string;
  readonly acquiredAt: string;
  readonly lastHeartbeatAt: string;
  readonly expiresAt: string;
  readonly releasedAt: string | null;
}

// M-26 run-recovery dual-truth: 'abandoned' is a reopen-capable terminal-ish
// incident status. A fenced abandon parks the incident; a fenced reopen returns
// it to 'open'. It NEVER changes the run's execution truth.
export type SupervisorIncidentStatus =
  | 'open'
  | 'repairing'
  | 'recovered'
  | 'escalated'
  | 'abandoned';

// Exhaustive operator-driven recovery transition action set (M-26 Section 6).
export const RECOVERY_ACTION_TYPES = ['start', 'complete', 'abandon', 'reopen'] as const;

export type RecoveryActionType = (typeof RECOVERY_ACTION_TYPES)[number];

/**
 * Result of reserving a supervisor action against the attempt-scoped unique
 * index (incident_id, attempt_id, action_type):
 * - 'applied'   -> a new fenced reservation was inserted
 * - 'unchanged' -> the identical tuple + immutable payload already existed
 * - 'conflict'  -> the tuple exists with a conflicting immutable payload, or
 *                  the caller could not be fenced; nothing was mutated
 */
export type SupervisorActionReservation = 'applied' | 'unchanged' | 'conflict';

export interface SupervisorIncidentRecord {
  readonly incidentId: string;
  readonly incidentKey: string;
  readonly runId: string;
  readonly woId: string;
  readonly status: SupervisorIncidentStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SupervisorObservationRecord {
  readonly observationId: string;
  readonly incidentId: string;
  readonly supervisorId: string;
  readonly assessment: string;
  readonly evidenceRefs: readonly string[];
  readonly createdAt: string;
}

export interface SupervisorRepairLeaseRecord {
  readonly incidentId: string;
  readonly ownerId: string;
  readonly fencingToken: number;
  readonly acquiredAt: string;
  readonly lastHeartbeatAt: string;
  readonly expiresAt: string;
  readonly releasedAt: string | null;
}

export interface SupervisorActionRecord {
  readonly actionId: string;
  // Immutable per-attempt identity. Deduplication is enforced by
  // UNIQUE (incident_id, attempt_id, action_type); incident_id is already bound
  // to exactly one run_id, so this is the persisted equivalent of M-26's
  // run_id + attempt_id + action_type. Backfilled from action_id for pre-M-26
  // rows so it is always present.
  readonly attemptId: string;
  readonly incidentId: string;
  readonly ownerId: string;
  readonly fencingToken: number;
  readonly actionType: string;
  readonly outcome: string;
  readonly evidenceRefs: readonly string[];
  readonly createdAt: string;
  // Structured completion evidence. Populated only by a successful `complete`
  // recovery transition; null for reservations, non-complete actions, and
  // historical rows. Final recovery dedup compares run_id + recoveredHeadSha +
  // mergeSha, so these are the canonical merged-PR anchors.
  readonly pullRequestNumber?: number | null;
  readonly recoveredHeadSha?: string | null;
  readonly targetBase?: string | null;
  readonly mergeSha?: string | null;
  // Reservation/finalization lifecycle. Absent on the reserve input path.
  readonly status?: 'reserved' | 'completed' | 'failed';
  readonly completedAt?: string | null;
}

/**
 * Recovery detail surface for a single run: the canonical outcome plus the
 * ordered supervisor action audit trail (actor, action type, evidence, and
 * structured merged-PR anchors). Returned by getRunRecoveryDetails() and
 * exposed on the run-detail API only.
 */
export interface RunRecoveryDetails {
  readonly outcome: RunOutcome | null;
  readonly actions: readonly SupervisorActionRecord[];
}

export interface ExpiredRunLeaseRecord {
  readonly runId: string;
  readonly workflowName: string;
  readonly workingPath: string | null;
  readonly ownerId: string;
  readonly leaseToken: string;
  readonly expiresAt: string;
}

export const SCHEDULED_WAIT_STATES = ['scheduled', 'claimed', 'cancelled', 'completed'] as const;

export type ScheduledWaitState = (typeof SCHEDULED_WAIT_STATES)[number];

export interface ScheduledProviderWaitRecord {
  readonly waitId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly provider: string;
  readonly reasonCode: OutcomeReasonCode;
  readonly resumeAt: string;
  readonly state: ScheduledWaitState;
  readonly claimOwnerId: string | null;
  readonly claimToken: string | null;
  readonly createdAt: string;
  readonly claimedAt: string | null;
  readonly cancelledAt: string | null;
  readonly completedAt: string | null;
}

export interface DeliverableEvidence {
  readonly worktreeChanges?: boolean;
  readonly commitSha?: string;
  readonly pushed?: boolean;
  readonly pullRequest?: {
    readonly open: boolean;
    readonly ready: boolean;
  };
}

export interface ValidationEvidence {
  readonly required: boolean;
  readonly state: ValidationState;
  readonly reasonCode?: OutcomeReasonCode;
}

export interface RequiredStageEvidence {
  readonly stageId: string;
  readonly required: boolean;
  readonly executionState: ExecutionState;
  readonly validationState: ValidationState;
  readonly deliverableState: DeliverableState;
}

export interface RunOutcomeEvidence {
  readonly executionState: ExecutionState;
  readonly deliverable: DeliverableEvidence;
  readonly validation: ValidationEvidence;
  readonly recoveryState: RecoveryState;
  readonly routeState: RouteState;
  readonly requirements: {
    readonly deliverable: 'none' | 'pr_ready';
  };
  readonly requiredStages?: readonly RequiredStageEvidence[];
  readonly verifiedNoop?: boolean;
  readonly dryRun?: boolean;
  readonly reasonCodes?: readonly OutcomeReasonCode[];
  readonly evidenceRefs: readonly string[];
}

export interface RunOutcome {
  readonly executionState: ExecutionState;
  readonly deliverableState: DeliverableState;
  readonly validationState: ValidationState;
  readonly recoveryState: RecoveryState;
  readonly routeState: RouteState;
  readonly primaryReason: OutcomeReasonCode;
  readonly reasonCodes: readonly OutcomeReasonCode[];
  readonly evidenceRefs: readonly string[];
}

export interface TerminalWorkflowPersistence {
  readonly outcome: RunOutcome;
  readonly eventData: Readonly<Record<string, unknown>>;
  readonly updatedAt: string;
  readonly stepName?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type RunOutcomeProjection =
  | 'pending'
  | 'running'
  | 'waiting_provider'
  | 'interrupted'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'escalated'
  | 'cancelled'
  | 'planned';
