/**
 * IWorkflowStore - trait interface for workflow database operations.
 *
 * Mirrors the IIsolationStore pattern from @archon/isolation.
 * Implementations live in @archon/core (backed by the real DB);
 * the workflow engine depends only on this narrow interface.
 */
import type { WorkflowRun, WorkflowRunStatus, ApprovalContext } from './schemas';
import type {
  ProviderAttemptRecord,
  ExpiredRunLeaseRecord,
  RunAuthorityRecord,
  RunLeaseRecord,
  RunOutcome,
  ScheduledProviderWaitRecord,
  SupervisorActionRecord,
  SupervisorIncidentRecord,
  SupervisorObservationRecord,
  SupervisorRepairLeaseRecord,
  TerminalWorkflowPersistence,
} from './reliability/types';

export const WORKFLOW_EVENT_TYPES = [
  'workflow_started',
  'workflow_completed',
  'workflow_failed',
  'dag_workflow_failed',
  'node_started',
  'node_completed',
  'run_token_totals',
  // WO-170: emitted when a node exited 0 but stdout contained STATUS=*_failed.
  // Mission Control renders this yellow (between green completed and red failed).
  'node_completed_with_warning',
  'node_failed',
  'node_skipped',
  'node_skipped_prior_success',
  'loop_iteration_started',
  'loop_iteration_completed',
  'loop_iteration_failed',
  'resource_exhausted_retry',
  'tool_called',
  'tool_completed',
  'ralph_story_started',
  'ralph_story_completed',
  'approval_requested',
  'approval_received',
  'workflow_cancelled',
  'workflow_interrupted',
  'workflow_orphaned',
  'status_persist_failed',
  'workflow_artifact',
  // Layer 1 cascade-step event (WO-HARNESS-LAYER1-CLIMB-AND-GATE-EVENTS-01).
  // Emitted when a job escalates from one cost tier to another. Distinct from
  // node_failed / overseer_decision=escalate (the salvage path). No callers in
  // Phase 3; Phase 5 cascade engine (WO-HARNESS-V1-PERRUN-CASCADE-01) wires it.
  'cascade_step',
  // Node-level AVAILABILITY failover (WO-HARNESS-NODE-PROVIDER-FAILOVER-01).
  // Emitted when a prompt/loop node's primary provider fails with an
  // availability-class error and the node is re-dispatched SIDEWAYS exactly once
  // on a declared failover provider. Distinct from cascade_step (cost-tier CLIMB).
  'node_failover',
  // WO-HARNESS-IMPLEMENT-WALL-TIMEOUT-HONEST-01: emitted for each loop
  // iteration wall breach before the retry/final failure decision.
  'node_wall_breach',
] as const;

export type WorkflowEventType = (typeof WORKFLOW_EVENT_TYPES)[number];

export interface WorkflowEventRecord {
  id: string;
  workflow_run_id: string;
  event_type: string;
  step_index: number | null;
  step_name: string | null;
  data: Record<string, unknown>;
  created_at: string;
}

export interface IWorkflowStore {
  // Run lifecycle
  createWorkflowRun(data: {
    workflow_name: string;
    conversation_id: string;
    codebase_id?: string;
    user_message: string;
    metadata?: Record<string, unknown>;
    working_path?: string;
    parent_conversation_id?: string;
  }): Promise<WorkflowRun>;
  getWorkflowRun(id: string): Promise<WorkflowRun | null>;
  /**
   * Find the workflow run currently holding the lock on `workingPath`.
   *
   * Pass `self` from the calling dispatch so:
   *   1. Self is never returned (excluded by `id != self.id`).
   *   2. Two near-simultaneous dispatches deterministically agree on which
   *      is "first" via the `(started_at, id)` tiebreaker -- newer aborts.
   *
   * `id` and `startedAt` must travel together -- the tiebreaker requires
   * both. Bundling them as a single optional struct makes the
   * paired-or-nothing invariant structural rather than a doc-only contract.
   *
   * Stale `pending` rows (older than ~5 minutes) are treated as orphaned
   * and ignored, so leaks from crashed dispatches don't permanently block
   * a path.
   */
  getActiveWorkflowRunByPath(
    workingPath: string,
    self?: { id: string; startedAt: Date }
  ): Promise<WorkflowRun | null>;
  findResumableRun(workflowName: string, workingPath: string): Promise<WorkflowRun | null>;
  failOrphanedRuns(): Promise<{ count: number }>;
  listPendingWorkflowRunsBefore(cutoff: string): Promise<WorkflowRun[]>;
  orphanPendingWorkflowRun(data: {
    runId: string;
    reason: string;
    orphanedAt: string;
  }): Promise<boolean>;
  resumeWorkflowRun(id: string): Promise<WorkflowRun>;
  updateWorkflowRun(
    id: string,
    updates: Partial<Pick<WorkflowRun, 'status' | 'metadata'>>
  ): Promise<void>;
  updateWorkflowActivity(id: string): Promise<void>;
  getWorkflowRunStatus(id: string): Promise<WorkflowRunStatus | null>;
  completeWorkflowRun(
    id: string,
    metadata?: Record<string, unknown>,
    terminal?: TerminalWorkflowPersistence
  ): Promise<void>;
  failWorkflowRun(id: string, error: string, terminal?: TerminalWorkflowPersistence): Promise<void>;
  pauseWorkflowRun(id: string, approvalContext: ApprovalContext): Promise<void>;
  cancelWorkflowRun(id: string, terminal?: TerminalWorkflowPersistence): Promise<void>;

  // Smart Cauldron reliability state
  createRunAuthority(authority: RunAuthorityRecord): Promise<'created' | 'unchanged'>;
  getRunAuthority(runId: string): Promise<RunAuthorityRecord | null>;
  claimRunLease(lease: RunLeaseRecord): Promise<RunLeaseRecord | null>;
  heartbeatRunLease(data: {
    runId: string;
    ownerId: string;
    leaseToken: string;
    heartbeatAt: string;
    expiresAt: string;
  }): Promise<boolean>;
  releaseRunLease(data: {
    runId: string;
    ownerId: string;
    leaseToken: string;
    releasedAt: string;
  }): Promise<boolean>;
  listExpiredRunLeases(expiredAt: string): Promise<ExpiredRunLeaseRecord[]>;
  interruptExpiredRunLease(data: {
    runId: string;
    leaseToken: string;
    expiredAt: string;
    interruptedAt: string;
  }): Promise<boolean>;
  createProviderAttempt(attempt: ProviderAttemptRecord): Promise<boolean>;
  completeProviderAttempt(data: {
    attemptId: string;
    completedAt: string;
    servedModelId: string | null;
    outcomeClass: ProviderAttemptRecord['outcomeClass'];
    reasonCode: ProviderAttemptRecord['reasonCode'];
    resumeAt: string | null;
  }): Promise<boolean>;
  listProviderAttempts(runId: string, nodeId?: string): Promise<ProviderAttemptRecord[]>;
  upsertRunOutcome(runId: string, outcome: RunOutcome, updatedAt: string): Promise<boolean>;
  getRunOutcome(runId: string): Promise<RunOutcome | null>;
  scheduleProviderWait(wait: ScheduledProviderWaitRecord): Promise<boolean>;
  listDueProviderWaits(dueAt: string, limit: number): Promise<ScheduledProviderWaitRecord[]>;
  claimProviderWait(data: {
    waitId: string;
    ownerId: string;
    claimToken: string;
    claimedAt: string;
  }): Promise<boolean>;
  releaseProviderWaitClaim?(data: {
    waitId: string;
    claimToken: string;
    resumeAt: string;
  }): Promise<boolean>;
  cancelProviderWaits(runId: string, cancelledAt: string): Promise<number>;
  completeProviderWait(data: {
    waitId: string;
    claimToken: string;
    completedAt: string;
  }): Promise<boolean>;
  createSupervisorIncident?(incident: SupervisorIncidentRecord): Promise<SupervisorIncidentRecord>;
  appendSupervisorObservation?(observation: SupervisorObservationRecord): Promise<boolean>;
  listSupervisorObservations?(incidentId: string): Promise<SupervisorObservationRecord[]>;
  claimSupervisorRepairLease?(data: {
    incidentId: string;
    ownerId: string;
    leaseDurationMs: number;
  }): Promise<SupervisorRepairLeaseRecord | null>;
  heartbeatSupervisorRepairLease?(data: {
    incidentId: string;
    ownerId: string;
    fencingToken: number;
    leaseDurationMs: number;
  }): Promise<boolean>;
  authorizeSupervisorMutation?(data: {
    incidentId: string;
    ownerId: string;
    fencingToken: number;
  }): Promise<boolean>;
  reserveSupervisorAction?(action: SupervisorActionRecord): Promise<boolean>;
  finalizeSupervisorAction?(data: {
    actionId: string;
    incidentId: string;
    ownerId: string;
    fencingToken: number;
    status: 'completed' | 'failed';
    outcome: string;
    evidenceRefs: readonly string[];
    completedAt: string;
  }): Promise<boolean>;
  appendSupervisorAction?(action: SupervisorActionRecord): Promise<boolean>;
  releaseSupervisorRepairLease?(data: {
    incidentId: string;
    ownerId: string;
    fencingToken: number;
    releasedAt: string;
  }): Promise<boolean>;

  /**
   * Create a workflow event. Implementations MUST NOT throw -- catch all errors
   * internally and log them. Callers treat this as observable-only: workflow
   * execution continues regardless of whether event persistence succeeds.
   */
  createWorkflowEvent(data: {
    workflow_run_id: string;
    event_type: WorkflowEventType;
    step_index?: number;
    step_name?: string;
    data?: Record<string, unknown>;
  }): Promise<void>;
  createDurableWorkflowEvent?(data: {
    workflow_run_id: string;
    event_type: WorkflowEventType;
    step_index?: number;
    step_name?: string;
    data?: Record<string, unknown>;
  }): Promise<WorkflowEventRecord>;
  listWorkflowEvents(workflowRunId: string): Promise<WorkflowEventRecord[]>;

  /**
   * Return a map of nodeId -> output for all node_completed events
   * from a prior DAG workflow run. Used for DAG resume: the executor
   * pre-populates nodeOutputs so completed nodes are skipped on re-run.
   *
   * Returns an empty map when no completed nodes exist.
   * Throws on DB error -- caller (executor.ts) owns the degradation policy.
   */
  getCompletedDagNodeOutputs(workflowRunId: string): Promise<Map<string, string>>;

  // Per-codebase env vars for workflow node injection
  getCodebaseEnvVars(codebaseId: string): Promise<Record<string, string>>;

  // Codebase lookup (for path resolution)
  getCodebase(id: string): Promise<{
    id: string;
    name: string;
    repository_url: string | null;
    default_cwd: string;
  } | null>;
}
