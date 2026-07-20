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
import { assessBranchRefreshCandidate } from './actions/refresh-rebase';
import type { AssessBranchRefreshDepsV1 } from './actions/refresh-rebase';
import { assessLifecycleCandidate } from './actions/lifecycle';
import type { LifecycleTargetBindingV1 } from './actions/lifecycle';
import type {
  GitHubClientDeps,
  OverseerRunRecord,
  OverseerRunStoreDeps,
  OverseerWorkflowEvent,
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
 * WO-HARNESS-OVERSEER-SLICE8-LIVE-WIRING-01: call the shipped S4-S7 assessors
 * on the live watch path. If any returns a dispatchable (mutating) disposition,
 * route the run to the matching new action so handleRecord can dispatch it to a
 * per-capability executor (or deny when none is wired). Otherwise return null and
 * let the caller fall through to the existing escalation path unchanged.
 *
 * HONEST DEFAULT-OFF WIRING (verified live 2026-07-20): assessRun's only inputs
 * are the run record, PR evidence, run events, and error class
 * (OverseerRunStoreDeps + GitHubClientDeps). It has NO salvage/lease/attempt,
 * worktree/run-authority, or lifecycle target/verifier/fusion evidence -- the
 * fields each assessor needs beyond its capability gate flag. So every such field
 * is set to a real "no evidence" value: repair_refire evidence_complete=false,
 * refresh_rebase pr_snapshot=null, lifecycle action_kind='READ_ONLY'. Each value
 * drives the assessor down its own leading short-circuit (repair-refire.ts:193,
 * refresh-rebase.ts:168, lifecycle.ts:226), so it can only ever return an inert
 * disposition (reconcile_only / report_only / read_only). The capability flags
 * are read for real (default-off), so this wiring makes the modules REACHABLE and
 * keeps every capability default-off; it does NOT and cannot auto-handle any run
 * yet. Real classification requires a follow-on per-capability evidence-assembly
 * WO (analogous to merge-coordinator.ts). The placeholder fields below are
 * provably dead on every current call path: the gate/evidence field that would
 * unlock a dispatchable disposition is false at call time given no evidence
 * assembly is wired.
 */
function assessSlice8Candidate(
  run: OverseerRunRecord
): { action: Slice8Action; reason: string } | null {
  const policy = readOverseerActionPolicyFromEnv();
  const repository = `${run.owner}/${run.repo}`;

  // --- repair_refire (M-42 Slice 4) ---
  const repair = assessRepairRefireCandidate({
    action_gate_enabled: policy.capability_flags.repair,
    evidence_complete: false, // no salvage/attempt/lease evidence on the watch path
    has_exact_target: false,
    has_active_owner_or_run: false,
    has_indeterminate_prior_effect: false,
    salvage_complete: false,
    automatic_attempt_count: 0,
    scope_changed: false,
    semantic_dispute: false,
    fusion_available: false,
    repairable_in_place: false,
  });
  if (
    repair.disposition === 'repair' ||
    repair.disposition === 'refire_first' ||
    repair.disposition === 'refire_later'
  ) {
    return { action: 'repair_refire', reason: `repair_refire:${repair.disposition}` };
  }

  // --- refresh_rebase (M-42 Slice 5) ---
  const branchDeps: AssessBranchRefreshDepsV1 = {
    // Never reached: assessBranchRefreshCandidate returns report_only before any
    // policy evaluation when the gate is off or pr_snapshot is null (both hold here).
    policy: {
      evaluateActionPolicy: () => ({ eligible: false, reason: 'evidence_unavailable_in_watch' }),
    },
  };
  const branch = assessBranchRefreshCandidate(
    {
      repository,
      branch: run.headBranch ?? '',
      worktree_path: '', // no live worktree observation on the watch path
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
      pr_snapshot: null, // no live head/base PR snapshot on the watch path
      worktree: {
        clean: false,
        current_branch: run.headBranch ?? '',
        head_sha: '',
        factory_owned: false,
      },
      unique_commits: 0,
      rebase_probe: null,
    },
    branchDeps
  );
  if (branch.disposition === 'refresh' || branch.disposition === 'rebase') {
    return { action: 'refresh_rebase', reason: `refresh_rebase:${branch.disposition}` };
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
  const lifecycle = assessLifecycleCandidate({
    lifecycle_gate_enabled: policy.capability_flags.lifecycle,
    evidence_complete: false,
    target: lifecycleTarget,
    action_kind: 'READ_ONLY', // no lifecycle action target/verifier evidence on the watch path
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
  });
  if (lifecycle.disposition === 'eligible') {
    return { action: 'lifecycle', reason: `lifecycle:${lifecycle.action_kind}` };
  }

  return null;
}

async function assessRun(
  run: OverseerRunRecord,
  deps: OverseerRunStoreDeps & GitHubClientDeps
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

  // WO-HARNESS-OVERSEER-SLICE8-LIVE-WIRING-01: consult the shipped S4-S7 assessors
  // before the unconditional escalate fall-through. A dispatchable disposition
  // routes to a new action; otherwise (the only outcome reachable today, since the
  // watch path carries no salvage/worktree/lifecycle evidence) escalation is
  // unchanged.
  const slice8 = assessSlice8Candidate(run);
  if (slice8) {
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
  };
}

export async function watchOnce(
  deps: OverseerRunStoreDeps & GitHubClientDeps
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
  deps: OverseerRunStoreDeps & GitHubClientDeps,
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
