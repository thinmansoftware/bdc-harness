import type { WorkflowRunStatus } from '@archon/workflows/schemas/workflow-run';
import { TERMINAL_WORKFLOW_STATUSES } from '@archon/workflows/schemas/workflow-run';
import { classifyError } from './classify';
import { decide } from './decide';
import { isPrMergeReady, isPrGreen, judgePullRequest } from './judge-pr';
// WO-HARNESS-OVERSEER-SLICE8-LIVE-WIRING-01: wire the shipped M-42 Slice 4-7
// assessors into the live watch/decide path so their dispatchable dispositions
// become reachable actions instead of unconditional escalation. Capability gate
// flags come from the existing per-capability env convention (default-off).
import { readOverseerActionPolicyFromEnv } from './action-policy';
import { assessRepairRefireCandidate } from './actions/repair-refire';
import type { RepairRefireAssessment, RepairRefireAssessmentInput } from './actions/repair-refire';
import { assessBranchRefreshCandidate } from './actions/refresh-rebase';
import type {
  AssessBranchRefreshDepsV1,
  BranchAssessmentResultV1,
  BranchCandidateInputV1,
} from './actions/refresh-rebase';
import { assessLifecycleCandidate } from './actions/lifecycle';
import type {
  LifecycleAssessmentResultV1,
  LifecycleCandidateInputV1,
  LifecycleTargetBindingV1,
} from './actions/lifecycle';
import type {
  GitHubClientDeps,
  OverseerRunRecord,
  OverseerRunStoreDeps,
  OverseerWorkflowEvent,
  PullRequestEvidence,
  Slice8Disposition,
  Slice8EvidenceDeps,
  WatchedRunRecord,
} from './types.ts';

export const DEFAULT_WATCH_INTERVAL_MS = 60_000;

/**
 * M-42 Slice 8 integration marker: single-watcher ownership for the
 * integrated candidate. Runtime still starts at most one watcher task.
 */
export const SLICE8_WATCHER_OWNERSHIP = 'single_watcher_fail_closed' as const;

function isTerminalStatus(status: string): status is WorkflowRunStatus {
  return (TERMINAL_WORKFLOW_STATUSES as readonly string[]).includes(status);
}

function newestEvent(events: OverseerWorkflowEvent[]): OverseerWorkflowEvent | undefined {
  return [...events].sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? '')).at(-1);
}

function failedNodeIds(event: OverseerWorkflowEvent | undefined): string[] {
  const failedNodes = event?.data.failed_nodes;
  return Array.isArray(failedNodes)
    ? failedNodes.filter((nodeId): nodeId is string => typeof nodeId === 'string')
    : [];
}

export function selectFailureEvent(
  events: OverseerWorkflowEvent[]
): OverseerWorkflowEvent | undefined {
  const nodeFailedEvents = events.filter(event => event.event_type === 'node_failed');
  const workflowFailedEvent = newestEvent(
    events.filter(event => event.event_type === 'workflow_failed')
  );

  if (nodeFailedEvents.length > 0) {
    const [authoritativeFailedNode] = failedNodeIds(workflowFailedEvent);
    if (authoritativeFailedNode) {
      const matchingEvent = nodeFailedEvents.find(
        event => event.step_name === authoritativeFailedNode
      );
      if (matchingEvent) return matchingEvent;
    }
    return newestEvent(nodeFailedEvents);
  }

  if (workflowFailedEvent) return workflowFailedEvent;

  return newestEvent(events);
}

function eventMessage(event: OverseerWorkflowEvent | undefined): string {
  if (!event) return '';
  const data = event.data;
  const candidates = [data.error, data.message, data.stderr, data.output, data.reason];
  const found = candidates.find(value => typeof value === 'string');
  return typeof found === 'string' ? found : JSON.stringify(data);
}

/** Action values produced by the Slice 4-7 dispatch wiring. */
type Slice8Action = 'repair_refire' | 'refresh_rebase' | 'lifecycle';

/**
 * WO-HARNESS-OVERSEER-SLICE8-LIVE-WIRING-01 (revised 2026-07-20 after Codex
 * final review): call the shipped S4-S7 assessors on the live watch path,
 * threading real evidence when a `Slice8EvidenceDeps` assembler is wired. If
 * any assessor returns a dispatchable (mutating) disposition, route the run to
 * the matching new action so handleRecord can dispatch it to a per-capability
 * executor (or deny when none is wired). Regardless of outcome, the typed
 * assessor result is returned so it can be attached to the WatchedRunRecord
 * for observability and reliable typed dispatch downstream -- no reason-string
 * parsing required.
 *
 * REACHABILITY: assessRun's own inputs (run record, PR evidence, run events)
 * do not include salvage/attempt/lease evidence, live worktree observations,
 * or lifecycle target/verifier/fusion evidence. Rather than hard-coding those
 * gaps to null (previous "provably dead" wiring), the assessors read them
 * through the injected `Slice8EvidenceDeps` seam. Each capability's assembler
 * is optional and independent; when absent, the watch path passes explicit
 * no-evidence values and the assessor short-circuits to an inert disposition
 * (reconcile_only / report_only / read_only). When an assembler IS wired --
 * as a follow-on per-capability WO ships -- real evidence flows into the
 * assessor and a dispatchable disposition can emerge. This is the honest
 * mirror of the merge-ready coordinator pattern: gate + seam here, wire the
 * seam later, and the classify path is genuinely reachable through injection.
 */
async function assessSlice8Candidate(
  run: OverseerRunRecord,
  prEvidence: PullRequestEvidence,
  evidenceDeps?: Slice8EvidenceDeps
): Promise<{
  action: Slice8Action | null;
  reason: string | null;
  slice8: Slice8Disposition;
}> {
  const policy = readOverseerActionPolicyFromEnv();
  const repository = `${run.owner}/${run.repo}`;

  // --- repair_refire (M-42 Slice 4) ---
  const repairEvidence =
    (await evidenceDeps?.assembleRepairRefireEvidence?.(run, prEvidence)) ?? null;
  const repairInput: RepairRefireAssessmentInput = {
    action_gate_enabled: policy.capability_flags.repair,
    // Defaults are the explicit "no evidence" values; a wired assembler
    // overrides any subset via spread. Absent assembler -> reconcile_only.
    evidence_complete: false,
    has_exact_target: false,
    has_active_owner_or_run: false,
    has_indeterminate_prior_effect: false,
    salvage_complete: false,
    automatic_attempt_count: 0,
    scope_changed: false,
    semantic_dispute: false,
    fusion_available: false,
    repairable_in_place: false,
    ...(repairEvidence ?? {}),
  };
  const repair: RepairRefireAssessment = assessRepairRefireCandidate(repairInput);
  const repairDisposition: Slice8Disposition = { kind: 'repair_refire', assessment: repair };
  if (
    repair.disposition === 'repair' ||
    repair.disposition === 'refire_first' ||
    repair.disposition === 'refire_later'
  ) {
    return {
      action: 'repair_refire',
      reason: `repair_refire:${repair.disposition}`,
      slice8: repairDisposition,
    };
  }

  // --- refresh_rebase (M-42 Slice 5) ---
  const branchEvidence =
    (await evidenceDeps?.assembleBranchRefreshEvidence?.(run, prEvidence)) ?? null;
  const branchDeps: AssessBranchRefreshDepsV1 = {
    // Default no-op policy evaluator matches the previous inert behavior; a
    // wired assembler can override via the same deps merge if needed by
    // returning its own `policy` field on the partial evidence object (the
    // assembler returns Partial<BranchCandidateInputV1> which does not include
    // deps -- deps remain caller-owned, so this evaluator only runs when the
    // input somehow reaches the policy check with a non-null pr_snapshot).
    policy: {
      evaluateActionPolicy: () => ({ eligible: false, reason: 'evidence_unavailable_in_watch' }),
    },
  };
  const branchInput: BranchCandidateInputV1 = {
    repository,
    branch: run.headBranch ?? '',
    worktree_path: '',
    branch_gate_enabled: policy.capability_flags.branch,
    policy_digest: '',
    verifier_registry_digest: '',
    run_authority: {
      run_id: run.id,
      head_sha: '',
      base_branch: '',
      base_sha: '',
      factory_created: false,
    },
    pr_snapshot: null,
    worktree: {
      clean: false,
      current_branch: run.headBranch ?? '',
      head_sha: '',
      factory_owned: false,
    },
    unique_commits: 0,
    rebase_probe: null,
    ...(branchEvidence ?? {}),
  };
  const branch: BranchAssessmentResultV1 = assessBranchRefreshCandidate(branchInput, branchDeps);
  const branchDisposition: Slice8Disposition = { kind: 'refresh_rebase', assessment: branch };
  if (branch.disposition === 'refresh' || branch.disposition === 'rebase') {
    return {
      action: 'refresh_rebase',
      reason: `refresh_rebase:${branch.disposition}`,
      slice8: branchDisposition,
    };
  }

  // --- lifecycle (M-42 Slice 6) ---
  const lifecycleTarget: LifecycleTargetBindingV1 = {
    repository,
    target_kind: 'issue',
    target_key: '',
    target_digest: '',
    snapshot_id: '',
    target: {
      target_kind: 'issue',
      repository,
      issue_number: 0,
      provider_node_id: '',
      state: '',
      updated_at: '',
      is_pull_request: false,
    },
  };
  const lifecycleEvidence =
    (await evidenceDeps?.assembleLifecycleEvidence?.(run, prEvidence)) ?? null;
  const lifecycleInput: LifecycleCandidateInputV1 = {
    lifecycle_gate_enabled: policy.capability_flags.lifecycle,
    evidence_complete: false,
    target: lifecycleTarget,
    action_kind: 'READ_ONLY',
    action_parameters_digest: null,
    policy_digest: '',
    verifier_registry_digest: '',
    salvage_receipt: null,
    lineage: null,
    reopen_evidence: null,
    verifier: null,
    fusion: null,
    protected_boundaries: [],
    customer_contact: false,
    governance_filing: false,
    resulting_deployment_effect: 'unknown',
    credential_principal: '',
    ...(lifecycleEvidence ?? {}),
  };
  const lifecycle: LifecycleAssessmentResultV1 = assessLifecycleCandidate(lifecycleInput);
  const lifecycleDisposition: Slice8Disposition = { kind: 'lifecycle', assessment: lifecycle };
  if (lifecycle.disposition === 'eligible') {
    return {
      action: 'lifecycle',
      reason: `lifecycle:${lifecycle.action_kind}`,
      slice8: lifecycleDisposition,
    };
  }

  // No dispatchable disposition. Return the last inert assessment (lifecycle,
  // which the assessRun caller attaches to the record for observability).
  return { action: null, reason: null, slice8: lifecycleDisposition };
}

async function assessRun(
  run: OverseerRunRecord,
  deps: OverseerRunStoreDeps & GitHubClientDeps & Slice8EvidenceDeps
): Promise<WatchedRunRecord> {
  const prEvidence = await judgePullRequest(run, deps);

  if (prEvidence.state === 'merged') {
    return {
      runId: run.id,
      woId: run.woId,
      repo: run.repo,
      owner: run.owner,
      status: run.status,
      headBranch: run.headBranch,
      metadata: run.metadata,
      action: 'success',
      reason: 'PR is already merged; judging run successful by PR evidence',
      prEvidence,
    };
  }

  if (run.status !== 'failed') {
    return {
      runId: run.id,
      woId: run.woId,
      repo: run.repo,
      owner: run.owner,
      status: run.status,
      headBranch: run.headBranch,
      metadata: run.metadata,
      action: run.status === 'completed' && isPrGreen(prEvidence) ? 'success' : 'ignore',
      reason: `terminal status ${run.status} does not require failure handling`,
      prEvidence,
    };
  }

  if (isPrMergeReady(prEvidence)) {
    return {
      runId: run.id,
      woId: run.woId,
      repo: run.repo,
      owner: run.owner,
      status: run.status,
      headBranch: run.headBranch,
      metadata: run.metadata,
      errorClass: 'tail_node_false_fail',
      action: 'merge_ready',
      reason: 'failed run has green, mergeable PR evidence',
      prEvidence,
      decision: { decision: 'merge_ready', reason: 'failed run has green, mergeable PR evidence' },
    };
  }

  const events = await deps.listRunEvents(run.id);
  const lastEvent = selectFailureEvent(events);
  const errorClass = classifyError({
    message: eventMessage(lastEvent),
    nodeId: lastEvent?.step_name ?? undefined,
    exitCode: typeof lastEvent?.data.exitCode === 'number' ? lastEvent.data.exitCode : undefined,
  });
  const decision = decide({
    errorClass,
    attempt: 1,
    nodeId: lastEvent?.step_name ?? undefined,
    woId: run.woId,
  });

  // WO-HARNESS-OVERSEER-SLICE8-LIVE-WIRING-01 (revised 2026-07-20): consult the
  // shipped S4-S7 assessors before the unconditional escalate fall-through.
  // Evidence flows through the injected Slice8EvidenceDeps seam on `deps`; when
  // absent, every assessor short-circuits to an inert disposition and the run
  // still escalates. The typed slice8 disposition is attached to the record in
  // both cases so downstream coordinators dispatch on the fully-typed
  // assessment payload rather than parsing reason strings.
  const slice8 = await assessSlice8Candidate(run, prEvidence, deps);
  if (slice8.action && slice8.reason) {
    return {
      runId: run.id,
      woId: run.woId,
      repo: run.repo,
      owner: run.owner,
      status: run.status,
      headBranch: run.headBranch,
      metadata: run.metadata,
      errorClass,
      action: slice8.action,
      reason: slice8.reason,
      prEvidence,
      decision,
      lastEvent,
      slice8: slice8.slice8,
    };
  }

  return {
    runId: run.id,
    woId: run.woId,
    repo: run.repo,
    owner: run.owner,
    status: run.status,
    headBranch: run.headBranch,
    metadata: run.metadata,
    errorClass,
    action: 'escalate',
    reason: decision.reason,
    prEvidence,
    decision,
    lastEvent,
    slice8: slice8.slice8,
  };
}

export async function watchOnce(
  deps: OverseerRunStoreDeps & GitHubClientDeps & Slice8EvidenceDeps
): Promise<WatchedRunRecord[]> {
  const runs = await deps.listRunsForWatch();
  const terminalRuns = runs.filter(run => isTerminalStatus(run.status));
  const outcomes: WatchedRunRecord[] = [];
  for (const run of terminalRuns) {
    outcomes.push(await assessRun(run, deps));
  }
  return outcomes;
}

export async function watchLoop(
  deps: OverseerRunStoreDeps & GitHubClientDeps & Slice8EvidenceDeps,
  onRecord: (record: WatchedRunRecord) => Promise<void>,
  options: { intervalMs?: number; once?: boolean; signal?: AbortSignal } = {}
): Promise<void> {
  const intervalMs = options.intervalMs ?? DEFAULT_WATCH_INTERVAL_MS;
  for (;;) {
    if (options.signal?.aborted) return;
    const records = await watchOnce(deps);
    for (const record of records) {
      if (options.signal?.aborted) return;
      await onRecord(record);
    }
    if (options.once) return;
    await new Promise<void>(resolve => {
      const signal = options.signal;
      let settled = false;
      const timer = { id: undefined as ReturnType<typeof setTimeout> | undefined };
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer.id);
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = (): void => {
        finish();
      };
      timer.id = setTimeout(finish, intervalMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      // Close the narrow race where the signal aborts between the loop's
      // pre-check and listener registration.
      if (signal?.aborted) onAbort();
    });
    if (options.signal?.aborted) return;
  }
}
