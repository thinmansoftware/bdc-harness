import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { getDatabase } from '@archon/core/db/connection';
import { getCodebase } from '@archon/core/db/codebases';
import { createAuthenticatedMessage, listMessagesByCorrelationId } from '@archon/core/db/dispatch';
import {
  getRecoveryExecutionClaim,
  completeRecoveryExecutionClaim,
} from '@archon/core/db/execution-claims';
import type {
  ExecutionClaimResponse,
  RecoveryClaimIdentity,
} from '@archon/core/db/execution-claims';
import {
  appendM31ExecutionOutcomeV2,
  appendM31ExecutionReconciliationV2,
  createM31ActionProposalV2,
  getM31ActionProposalV2,
  getM31ChainAssessmentV2,
  getM31RecoveryAttemptWindow,
  getM31SnapshotV2,
  listM31ExecutionReceiptEventsV2,
  registerM31SnapshotV2,
  reserveM31ExecutionEffectV2,
  targetDigestV2,
  targetKeyV2,
} from '@archon/core/db/m31-target-v2';
import type {
  M31ActionPermitV2,
  M31ActionProposalV2,
  M31WorkflowRunTargetV2,
} from '@archon/core/db/m31-target-v2';
import {
  getOverseerRecoveryStages,
  insertOverseerAction,
  listRunEventsForOverseer,
  recordOverseerRecoveryStage,
} from '@archon/core/db/overseer';
import { getOverseerCapabilityState } from '@archon/core/db/overseer-capabilities';
import {
  getCauldronDrainState,
  getRunAuthority,
  getRunOutcome,
  getWorkflowRun,
  listWorkflowRunsByWorkingPath,
  resumeOverseerWorkflowRun,
} from '@archon/core/db/workflows';
import type { OverseerResumeBinding } from '@archon/core/db/workflows';
import { findConversationByPlatformId } from '@archon/core/db/conversations';
import { getRunArtifactsPath } from '@archon/paths';
import type { OverseerRunRecord, OverseerWorkflowEvent, WatchedRunRecord } from '@archon/overseer';
import { readOverseerActionPolicyFromEnv } from '@archon/overseer/action-policy';
import { authorizeOverseerActionV2 } from '@archon/overseer/action-policy-v2';
import {
  assessRepairRefireCandidate,
  canonicalStringify,
  captureRepairSalvage,
  MAX_AUTOMATIC_RECOVERY_ATTEMPTS,
  executeRepairRefire,
} from '@archon/overseer/actions/repair-refire';
import type {
  FirstRefireOnRampResultV1,
  OverseerSalvageReceiptV1,
  RepairRefireDisposition,
} from '@archon/overseer/actions/repair-refire';
import { createRepairRefireAdapter } from '@archon/overseer/adapters/repair-refire';
import { runEscalation } from '@archon/overseer/escalate';
import {
  createFailClosedM31CapabilityGateV2,
  prepareM31ActionPermitV2,
} from '@archon/overseer/m31-target-v2';
import { resolveWorkOwner } from '@archon/overseer/owner-resolution';
import { selectFailureEvent, type WatchRecovery } from '@archon/overseer/watch';
import { discoverWorkflowsWithConfig } from '@archon/workflows/workflow-discovery';
import { parseDeclaredBaseBranch } from '@archon/workflows/reliability/run-authority';
import { hashWorkflowDefinition } from '@archon/workflows/reliability/runtime-revisions';
import { DEFAULT_STALL_BUDGET_MS, resolveStallBudget } from '@archon/smart-cauldron/poll';
import { extractNodeTimeoutsMs } from '@archon/smart-cauldron/node-timeouts';
import { buildFireMessage } from '@archon/smart-cauldron/fire';
import { readCascadeRecord, runCascade } from '@archon/smart-cauldron/cascade';
import { loadLadder, loadPremiumTiers, loadRefusedTiers } from '@archon/smart-cauldron/ladder';
import { listOpenWoPullRequests, findWoClaim } from '@archon/smart-cauldron/already-satisfied';
import { loadConfig } from '@archon/core';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { WorkflowDefinition } from '@archon/workflows/schemas/workflow';
import { dispatchGuardedWoRun, findLiveRunsForWo } from './routes/wo-fire-guard';
import { fireCascadeUntilRunDiscovered } from './dispatch/cauldron-fire-consumer';
import { conductorSeatUsage } from './services/conductor-seat-usage';
import { checkFireEligibility, normalizeRepo } from './taskmaster/fire-eligibility';

const ACTOR = 'overseer-service';
const ADAPTER = 'server-overseer-recovery';
const SHA = /^[0-9a-f]{40}$/;
const exec = promisify(execFile);
const digest = (value: unknown): string =>
  createHash('sha256').update(canonicalStringify(value)).digest('hex');
const orderEvents = (events: OverseerWorkflowEvent[]): OverseerWorkflowEvent[] =>
  [...events].sort(
    (a, b) =>
      (a.created_at ?? '').localeCompare(b.created_at ?? '') ||
      (a.id ?? '').localeCompare(b.id ?? '')
  );

function activityTime(value: string | Date): number {
  if (value instanceof Date) return value.getTime();
  return Date.parse(/^\d{4}-\d{2}-\d{2} /.test(value) ? value.replace(' ', 'T') + 'Z' : value);
}

type RecoveryAction = Extract<RepairRefireDisposition, 'repair' | 'refire_first' | 'refire_later'>;
type RunAuthority = NonNullable<Awaited<ReturnType<typeof getRunAuthority>>>;

interface Candidate {
  run: WorkflowRun;
  authority: RunAuthority;
  workflow: WorkflowDefinition;
  target: M31WorkflowRunTargetV2;
  eventId: string;
  eventTipId: string;
  scopeDigest: string;
  head: string;
  canResume: boolean;
  project: string;
}

interface RecoveryCase {
  id: string;
  event: Pick<OverseerWorkflowEvent, 'id' | 'event_type' | 'step_name' | 'created_at'>;
  repository: string;
  woId: string;
  targetDigest: string | null;
  scopeDigest: string | null;
  action: RecoveryAction | null;
  blocker: string | null;
}

export interface RecoveryFireBinding {
  readonly runId: string;
  readonly codebaseId: string;
  readonly workflowName: string;
  readonly workflowRevision: string;
  readonly baseSha: string;
  readonly platformId: string;
  readonly message: string;
  readonly woId: string;
  readonly revalidate: () => Promise<boolean>;
}

export interface RecoveryGitHubReads {
  readonly listOpenPullRequests: typeof listOpenWoPullRequests;
  readonly findClaim: typeof findWoClaim;
  readonly fireEligibility: typeof checkFireEligibility;
  readonly resolveOwner: typeof resolveWorkOwner;
  readonly readSeatUsage: typeof conductorSeatUsage;
  readRemoteHead(worktree: string, branch: string): Promise<string | null>;
}

const githubReads: RecoveryGitHubReads = {
  listOpenPullRequests: listOpenWoPullRequests,
  findClaim: findWoClaim,
  fireEligibility: checkFireEligibility,
  resolveOwner: resolveWorkOwner,
  readSeatUsage: conductorSeatUsage,
  async readRemoteHead(worktree, branch) {
    const ref = `refs/heads/${branch}`;
    const output = await git(worktree, 'ls-remote', 'origin', ref);
    if (!output) return null;
    const [head, actualRef] = output.split('	');
    if (!head || !SHA.test(head) || actualRef !== ref) throw new Error('remote_ref_unverified');
    return head;
  },
};

export interface OverseerRecoveryTransport {
  /** Standard workflow preflight and guarded background dispatch, supplied by the server. */
  fire(binding: RecoveryFireBinding): Promise<string | null>;
  /** Existing workflow executor with its exact-run activation seam. */
  resume(
    run: WorkflowRun,
    workflow: WorkflowDefinition,
    activate: () => Promise<WorkflowRun>
  ): Promise<void>;
}

async function clock(): Promise<string> {
  const db = getDatabase();
  const now = db.dialect === 'postgres' ? db.sql.now() : "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
  const { rows } = await db.query<{ now: string | Date }>(`SELECT ${now} AS now`);
  const [row] = rows;
  if (!row) throw new Error('recovery_db_clock_unavailable');
  return new Date(row.now).toISOString();
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec('git', args, { cwd, timeout: 15_000, windowsHide: true })).stdout.trim();
}

function findReturnEvent(
  events: OverseerWorkflowEvent[],
  runId: string
): OverseerWorkflowEvent | undefined {
  return events.find(
    event =>
      event.event_type === 'run_outcome' &&
      event.data.outcome === 'returned_to_author' &&
      event.data.run_id === runId
  );
}

async function laneOwns(runId: string): Promise<boolean> {
  const { rows } = await getDatabase().query<{ run_id: string }>(
    `SELECT run_id FROM remote_agent_run_leases WHERE run_id = $1 AND released_at IS NULL
     UNION ALL
     SELECT i.run_id FROM remote_agent_supervisor_incidents i
     JOIN remote_agent_supervisor_repair_leases l ON l.incident_id = i.incident_id
     WHERE i.run_id = $1 AND l.released_at IS NULL`,
    [runId]
  );
  return rows.length > 0;
}

async function explicitlyReleased(runId: string): Promise<boolean> {
  const { rows } = await getDatabase().query<{ run_id: string }>(
    'SELECT run_id FROM remote_agent_run_leases WHERE run_id = $1 AND released_at IS NOT NULL',
    [runId]
  );
  return rows.length === 1;
}

async function readExactWorkflow(run: WorkflowRun): Promise<WorkflowDefinition | undefined> {
  if (!run.working_path) return undefined;
  const discovery = await discoverWorkflowsWithConfig(run.working_path, loadConfig);
  return discovery.workflows.find(item => item.workflow.name === run.workflow_name)?.workflow;
}

async function selectEvent(
  record: OverseerRunRecord,
  events: OverseerWorkflowEvent[]
): Promise<OverseerWorkflowEvent | undefined> {
  const returned = findReturnEvent(events, record.id);
  if (returned) return returned;
  const failure = events.find(event =>
    ['node_failed', 'workflow_failed', 'workflow_stalled'].includes(event.event_type)
  );
  if (
    record.status === 'failed' ||
    (failure && ['escalated', 'cancelled'].includes(record.status))
  ) {
    return selectFailureEvent(events);
  }
  if (record.status === 'cancelled') {
    return events.find(
      event =>
        event.event_type === 'workflow_cancelled' &&
        typeof event.data.reason === 'string' &&
        event.data.reason.startsWith('smart-cauldron stall:') &&
        event.data.reason.includes(' stalled: no new events')
    );
  }
  if (record.status !== 'running' && record.status !== 'interrupted') return undefined;
  const [run, outcome] = await Promise.all([getWorkflowRun(record.id), getRunOutcome(record.id)]);
  if (
    run?.status !== record.status ||
    outcome?.executionState === 'waiting_provider' ||
    outcome?.executionState === 'paused_human' ||
    !events.some(event => event.event_type === 'node_started')
  )
    return undefined;
  const tip = orderEvents(events).at(-1);
  if (!tip?.id || !tip.created_at) return undefined;
  const activity = Math.max(
    activityTime(tip.created_at),
    run.last_activity_at ? activityTime(run.last_activity_at) : 0
  );
  const silentFor = Date.parse(await clock()) - activity;
  if (silentFor < DEFAULT_STALL_BUDGET_MS) return undefined;
  const workflow = await readExactWorkflow(run);
  const { budget } = resolveStallBudget(
    events.map(event => ({
      ...event,
      step_name: event.step_name ?? null,
    })),
    extractNodeTimeoutsMs(workflow, 3_600_000)
  );
  return silentFor >= budget ? tip : undefined;
}

function hasHardStop(events: OverseerWorkflowEvent[]): boolean {
  return events.some(event =>
    [
      event.data.error,
      event.data.message,
      event.data.stderr,
      event.data.node_output,
      event.data.output,
      event.data.reason,
    ].some(
      value =>
        typeof value === 'string' &&
        /(?:CLOSED_LIST=(?:production settings|secrets|another product contract)|repair_target_(?:branch_)?(?:held|unreclaimable)|teardown_unconfirmed)/i.test(
          value
        )
    )
  );
}

async function readCandidate(record: WatchedRunRecord, eventId: string): Promise<Candidate | null> {
  const run = await getWorkflowRun(record.runId);
  if (
    !run?.codebase_id ||
    !run.working_path ||
    !['failed', 'running', 'interrupted', 'escalated', 'cancelled'].includes(run.status) ||
    Object.hasOwn(run.metadata ?? {}, 'codex_only_dispatch')
  )
    return null;
  const [authority, codebase, events, workflow, matches] = await Promise.all([
    getRunAuthority(run.id),
    getCodebase(run.codebase_id),
    listRunEventsForOverseer(run.id),
    readExactWorkflow(run),
    listWorkflowRunsByWorkingPath(run.working_path),
  ]);
  if (
    (run.status === 'running' || run.status === 'interrupted') &&
    (
      await selectEvent(
        { id: run.id, status: run.status, woId: record.woId, metadata: run.metadata },
        events
      )
    )?.id !== eventId
  ) {
    return null;
  }
  if (
    !authority ||
    !codebase?.repository_url ||
    !workflow?.run_authority?.required ||
    workflow.worktree?.enabled === false ||
    hashWorkflowDefinition(workflow) !== authority.workflowRevision ||
    run.workflow_name === 'bdc-feature-development-codex-only' ||
    authority.woId !== record.woId ||
    !/^WO-[A-Z0-9-]+$/.test(record.woId) ||
    authority.workflowName !== run.workflow_name ||
    authority.codebaseId !== run.codebase_id ||
    authority.worktreePath !== run.working_path ||
    !['dev', 'staging'].includes(authority.baseBranch) ||
    !SHA.test(authority.baseSha) ||
    !SHA.test(authority.runScopeSha) ||
    !/^sha256:[0-9a-f]{64}$/.test(authority.specHash) ||
    !/^(archon\/|run\/|wip\/|repair\/|feat\/)/.test(authority.headBranch) ||
    matches.length !== 1 ||
    matches[0]?.id !== run.id ||
    findReturnEvent(events, run.id) ||
    hasHardStop(events) ||
    !events.some(event => event.id === eventId) ||
    record.prEvidence.exists ||
    record.prEvidence.lookupFailed
  )
    return null;

  const repo = normalizeRepo(authority.canonicalRemote);
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repo) || normalizeRepo(codebase.repository_url) !== repo)
    return null;
  const [owner, project] = repo.split('/');
  if (!owner || !project) return null;
  const authorityDir = join(getRunArtifactsPath(owner, project, run.id), 'authority');
  const [frozenSpec, frozenManifest] = await Promise.all([
    readFile(join(authorityDir, 'work-order.md')),
    readFile(join(authorityDir, 'run-authority.json'), 'utf8'),
  ]);
  const base = parseDeclaredBaseBranch(frozenSpec);
  if (
    `sha256:${createHash('sha256').update(frozenSpec).digest('hex')}` !== authority.specHash ||
    canonicalStringify(JSON.parse(frozenManifest)) !== canonicalStringify(authority) ||
    (base && base !== authority.baseBranch)
  )
    return null;
  const eventTip = orderEvents(events).at(-1);
  if (!eventTip?.id) return null;
  const [head, branch, remote, clean] = await Promise.all([
    git(run.working_path, 'rev-parse', '--verify', 'HEAD^{commit}'),
    git(run.working_path, 'symbolic-ref', '--short', 'HEAD'),
    git(run.working_path, 'remote', 'get-url', 'origin'),
    git(run.working_path, 'status', '--porcelain=v1'),
  ]);
  if (
    !SHA.test(head) ||
    head === authority.runScopeSha ||
    clean ||
    branch !== authority.headBranch ||
    normalizeRepo(remote) !== repo
  )
    return null;
  await git(run.working_path, 'merge-base', '--is-ancestor', authority.runScopeSha, head);
  // Reuse the lane's frozen scope and publication gates. Reject salvage that
  // already includes settings, credential paths, or contract files.
  const paths = (
    await git(
      run.working_path,
      'diff',
      '--name-only',
      '--no-renames',
      authority.runScopeSha,
      head,
      '--'
    )
  ).split('\n');
  if (
    paths.some(path =>
      /(^|\/)(\.env[^/]*|secrets?|credentials?|contracts?|supabase|migrations|\.github|infra|deploy|prod(?:uction)?|settings)(\/|\.|$)/i.test(
        path
      )
    )
  )
    return null;

  const target: M31WorkflowRunTargetV2 = {
    target_kind: 'workflow_run',
    repository: repo,
    run_id: run.id,
    wo_id: record.woId,
    workflow_name: run.workflow_name,
    codebase_id: run.codebase_id,
    status: run.status,
    event_tip: digest(eventTip),
    head_sha: head,
    base_sha: authority.baseSha,
  };
  return {
    run,
    workflow,
    authority,
    target,
    eventId,
    eventTipId: eventTip.id,
    head,
    project: codebase.name,
    scopeDigest: digest(authority),
    canResume:
      ['running', 'interrupted'].includes(run.status) ||
      events.some(
        event => event.event_type === 'node_completed' && event.step_name === 'capture-run-scope'
      ),
  };
}

function result(
  status: FirstRefireOnRampResultV1['status'],
  reference: string | null,
  successor: string | null,
  reason: string,
  evidence: unknown = null
): FirstRefireOnRampResultV1 {
  return {
    schema_version: 'overseer-first-refire-on-ramp-result-v1',
    status,
    successor_run_id: successor,
    external_effect_reference: reference,
    evidence_digest: digest(evidence),
    reason,
  };
}

export function recoveryPlatformId(executionId: string): string {
  return `overseer-recovery-${executionId}`;
}

async function readSuccessor(proposal: M31ActionProposalV2): Promise<WorkflowRun | null> {
  const parent = await findConversationByPlatformId(recoveryPlatformId(proposal.execution_id));
  if (parent?.platform_type !== 'web') return null;
  const { rows } = await getDatabase().query<{ id: string }>(
    'SELECT id FROM remote_agent_workflow_runs WHERE parent_conversation_id = $1',
    [parent.id]
  );
  const [row] = rows;
  return rows.length === 1 && row ? getWorkflowRun(row.id) : null;
}

async function readResult(
  proposal: M31ActionProposalV2,
  claim: ExecutionClaimResponse,
  source: RunAuthority
): Promise<{ pending: boolean; result: FirstRefireOnRampResultV1 | null }> {
  if (proposal.target.target_kind !== 'workflow_run') return { pending: false, result: null };
  const repair = proposal.action_kind === 'REPAIR';
  const run = repair ? await getWorkflowRun(source.runId) : await readSuccessor(proposal);
  if (run?.codebase_id !== source.codebaseId || run.workflow_name !== source.workflowName) {
    return { pending: false, result: null };
  }
  const events = await listRunEventsForOverseer(run.id);
  if (
    repair &&
    !events.some(
      event =>
        event.data.execution_id === proposal.execution_id &&
        event.event_type === 'overseer_recovery_resumed' &&
        event.data.claim_id === claim.claim_id
    )
  ) {
    return { pending: false, result: null };
  }
  if (['pending', 'running', 'waiting_provider', 'paused'].includes(run.status)) {
    return { pending: true, result: null };
  }
  const [authority, outcome] = await Promise.all([getRunAuthority(run.id), getRunOutcome(run.id)]);
  const completed = orderEvents(events)
    .filter(
      event =>
        event.event_type === 'workflow_completed' &&
        event.created_at &&
        Date.parse(event.created_at) >= Date.parse(claim.effect_armed_at ?? '')
    )
    .at(-1);
  if (
    !authority ||
    !outcome ||
    !completed ||
    run.status !== 'completed' ||
    outcome.executionState !== 'completed' ||
    outcome.validationState !== 'passed' ||
    outcome.deliverableState !== 'pr_ready' ||
    authority.woId !== source.woId ||
    authority.specHash !== source.specHash ||
    authority.specRevision !== source.specRevision ||
    authority.specSource !== source.specSource ||
    authority.canonicalRemote !== source.canonicalRemote ||
    authority.baseBranch !== source.baseBranch ||
    authority.baseSha !== source.baseSha ||
    authority.workflowRevision !== source.workflowRevision ||
    !run.working_path ||
    (repair ? run.working_path !== source.worktreePath : run.id === source.runId)
  ) {
    return { pending: false, result: null };
  }
  const head = await git(run.working_path, 'rev-parse', '--verify', 'HEAD^{commit}').catch(
    () => ''
  );
  if (!SHA.test(head) || !proposal.target.head_sha) return { pending: false, result: null };
  // For an in-place continuation the saved commit must still be in the resulting history.
  if (repair) {
    const preserved = await git(
      run.working_path,
      'merge-base',
      '--is-ancestor',
      proposal.target.head_sha,
      head
    ).then(
      () => true,
      () => false
    );
    if (!preserved) return { pending: false, result: null };
  }
  return {
    pending: false,
    result: result(
      'succeeded',
      `workflow-run:${run.id}`,
      repair ? null : run.id,
      'verified_workflow_result',
      { head, outcome, completed: completed.id }
    ),
  };
}

function claimIdentity(
  proposal: M31ActionProposalV2,
  recovery: RecoveryCase
): RecoveryClaimIdentity {
  return {
    repository: recovery.repository,
    wo_id: recovery.woId,
    execution_id: proposal.execution_id,
    target_digest: proposal.target_digest,
  };
}

async function closeCase(
  runId: string,
  recovery: RecoveryCase,
  disposition: string
): Promise<void> {
  await recordOverseerRecoveryStage(
    runId,
    recovery.woId,
    'closed',
    JSON.stringify({ caseId: recovery.id, disposition })
  );
}

async function handoff(
  runId: string,
  recovery: RecoveryCase,
  reason: string,
  github: RecoveryGitHubReads
): Promise<void> {
  const event = recovery.event;
  if (!event.id || !event.created_at) return;
  const { recovery_handoff: prior } = await getOverseerRecoveryStages(runId);
  let handoff: { cardId: string; actor: string };
  if (prior) {
    handoff = JSON.parse(prior) as typeof handoff;
  } else {
    const owner = await github.resolveOwner({
      woId: recovery.woId,
      repository: recovery.repository,
    });
    const actor = owner.kind === 'owned' ? owner.owner : 'unowned';
    const card = await runEscalation(
      runId,
      { decision: 'escalate', reason },
      {
        woId: recovery.woId,
        repository: recovery.repository,
        errorClass: 'unknown',
        responsibleActor: actor,
        nextPermittedAction: 'Review the recovery evidence and record a disposition.',
        recoveryAttempted: { case_id: recovery.id, blocker: reason },
      },
      {
        sourceEventId: event.id,
        eventType: event.event_type,
        stepName: event.step_name ?? 'unknown',
        eventCreatedAt: event.created_at,
      }
    );
    handoff = JSON.parse(
      await recordOverseerRecoveryStage(
        runId,
        recovery.woId,
        'handoff',
        JSON.stringify({ cardId: card.card_id, actor })
      )
    ) as typeof handoff;
  }
  if (handoff.actor === 'unowned') return;
  const key = `overseer-recovery:${recovery.id}:${handoff.cardId}`;
  const message = await createAuthenticatedMessage(
    { kind: 'system', sender: 'overseer' },
    {
      correlation_id: recovery.id,
      idempotency_key: key,
      recipient: handoff.actor,
      task_type: 'agent_message',
      body: JSON.stringify({
        card_id: handoff.cardId,
        case_id: recovery.id,
        run_id: runId,
        wo_id: recovery.woId,
        blocker: reason,
        next_action: 'Review and address this recovery case.',
      }),
    }
  );
  const messages = await listMessagesByCorrelationId({ correlationId: recovery.id });
  const accepted = messages.find(
    row =>
      row.id === message.id &&
      row.idempotency_key === key &&
      row.recipient === handoff.actor &&
      row.acknowledged_by === handoff.actor &&
      row.addressed_by === handoff.actor &&
      row.acknowledged_at &&
      row.addressed_at
  );
  if (accepted) await closeCase(runId, recovery, 'owner_accepted');
}

async function reconcileCase(
  proposal: M31ActionProposalV2,
  recovery: RecoveryCase,
  claim: ExecutionClaimResponse
): Promise<'pending' | 'recovered' | 'unverified'> {
  const runId = proposal.target.target_kind === 'workflow_run' ? proposal.target.run_id : null;
  if (!runId) return 'unverified';
  const source = await getRunAuthority(runId);
  if (!source || recovery.scopeDigest !== digest(source)) return 'unverified';
  const bound = await readResult(proposal, claim, source);
  let receipts = await listM31ExecutionReceiptEventsV2(proposal.execution_id);
  let positive = receipts.find(
    row => row.event_type === 'effect_succeeded' || row.event_type === 'effect_reconciled_succeeded'
  );
  if (claim.effect_attempt_state === 'armed' && !claim.completed_at) {
    if (!receipts.some(row => row.event_sequence === 3)) {
      await appendM31ExecutionOutcomeV2({
        execution_id: proposal.execution_id,
        outcome: 'effect_indeterminate',
        reason: 'armed_recovery_requires_readback',
        evidence: { claim_id: claim.claim_id },
      });
    }
    if (bound.pending) return 'pending';
    if (bound.result && claim.effect_attempt_id && bound.result.external_effect_reference) {
      if (!positive) {
        await appendM31ExecutionReconciliationV2({
          execution_id: proposal.execution_id,
          outcome: 'effect_reconciled_succeeded',
          reason: bound.result.reason,
          evidence: bound.result,
          external_effect_reference: bound.result.external_effect_reference,
        });
        receipts = await listM31ExecutionReceiptEventsV2(proposal.execution_id);
        positive = receipts.find(row => row.event_type === 'effect_reconciled_succeeded');
      }
      if (
        positive?.target_digest === proposal.target_digest &&
        positive.external_effect_reference === bound.result.external_effect_reference
      ) {
        const completion = await completeRecoveryExecutionClaim({
          claim_id: claim.claim_id,
          execution_fencing_token: claim.execution_fencing_token,
          effect_attempt_id: claim.effect_attempt_id,
          actor_principal: ACTOR,
          external_effect_reference: bound.result.external_effect_reference,
          evidence: { ...bound.result, target_digest: proposal.target_digest },
        });
        if (completion.ok) claim = completion.claim;
      }
    }
  }
  if (
    positive &&
    bound.result &&
    claim.status === 'completed' &&
    claim.completion_evidence?.status === 'succeeded' &&
    claim.completion_evidence.target_digest === proposal.target_digest &&
    claim.completion_evidence.evidence_digest === bound.result.evidence_digest &&
    claim.external_effect_reference === bound.result.external_effect_reference &&
    positive.target_digest === proposal.target_digest &&
    positive.external_effect_reference === bound.result.external_effect_reference
  ) {
    await closeCase(runId, recovery, 'recovered');
    return 'recovered';
  }
  return 'unverified';
}

async function getOrCreateProposal(
  candidate: Candidate,
  recovery: RecoveryCase
): Promise<M31ActionProposalV2 | null> {
  const existing = await getM31ActionProposalV2(recovery.id);
  if (existing) return existing;
  const state = await getOverseerCapabilityState('repair');
  const policy = readOverseerActionPolicyFromEnv();
  if (
    !state?.action_enabled ||
    state.circuit_state !== 'closed' ||
    !state.policy_digest ||
    !state.verifier_registry_digest ||
    !policy.service_enabled ||
    policy.emergency_stop ||
    policy.legacy_dry_run ||
    !policy.capability_flags.repair
  )
    return null;
  const [owner, repo] = recovery.repository.split('/') as [string, string];
  const snapshotId = recovery.id.replace('m31v2-proposal-', 'm31v2-snapshot-');
  const path = join(
    getRunArtifactsPath(owner, repo, candidate.run.id),
    'overseer',
    `${recovery.id}.json`
  );
  // The receipt itself is immutable. A concurrent writer compares the frozen bytes.
  await captureRepairSalvage(
    {
      repository: recovery.repository,
      wo_id: recovery.woId,
      source_target_kind: 'workflow_run',
      source_target_key: targetKeyV2(candidate.target),
      source_target_digest: targetDigestV2(candidate.target),
      source_run_id: candidate.run.id,
      worktree_path: candidate.authority.worktreePath,
      artifact_kind: 'git_object',
      git_object_format: 'sha1',
      git_object_id: candidate.head,
      patch_path: null,
      patch_sha256: null,
      scope_digest: candidate.scopeDigest,
    },
    {
      now: clock,
      verifySalvage: async () => {
        await git(candidate.authority.worktreePath, 'cat-file', '-e', `${candidate.head}^{commit}`);
        return { verified_at: await clock() };
      },
      persistSalvageReceipt: async receipt => {
        await mkdir(dirname(path), { recursive: true });
        const temp = `${path}.${randomUUID()}.tmp`;
        await writeFile(temp, canonicalStringify({ recovery, target: candidate.target, receipt }), {
          flag: 'wx',
        });
        try {
          await link(temp, path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        } finally {
          await unlink(temp);
        }
      },
    }
  );
  const bytes = await readFile(path, 'utf8');
  const artifact = JSON.parse(bytes) as {
    recovery: RecoveryCase;
    target: M31WorkflowRunTargetV2;
    receipt: OverseerSalvageReceiptV1;
  };
  if (
    canonicalStringify(artifact.recovery) !== canonicalStringify(recovery) ||
    targetDigestV2(artifact.target) !== recovery.targetDigest ||
    artifact.receipt.git_object_id !== candidate.head ||
    artifact.receipt.scope_digest !== recovery.scopeDigest
  )
    return null;
  const blob = await git(candidate.authority.worktreePath, 'hash-object', '-w', '--', path);
  if (!SHA.test(blob)) return null;
  const member = {
    target: candidate.target,
    evidence_artifact_path: path,
    git_object_format: 'sha1' as const,
    evidence_git_blob: blob,
    observed_at: artifact.receipt.verified_at,
  };
  if (!(await getM31SnapshotV2(snapshotId))) {
    const chain = await getM31ChainAssessmentV2(recovery.repository);
    const predecessor = chain.tip_snapshot_id
      ? await getM31SnapshotV2(chain.tip_snapshot_id)
      : null;
    try {
      await registerM31SnapshotV2({
        snapshot_id: snapshotId,
        repository: recovery.repository,
        capture_started_at: artifact.receipt.captured_at,
        capture_completed_at: artifact.receipt.verified_at,
        operator_actor: ACTOR,
        operator_model: 'deterministic',
        read_only_query_method: 'workflow-store-and-git',
        predecessor_snapshot_id: predecessor?.snapshot_id,
        predecessor_evidence_git_blob: predecessor?.evidence_git_blob,
        targets: [member],
        evidence_artifact_path: path,
        git_object_format: 'sha1',
        evidence_git_blob: blob,
      });
    } catch (error) {
      if (!(await getM31SnapshotV2(snapshotId))) throw error;
    }
  }
  try {
    const created = await createM31ActionProposalV2({
      proposal_id: recovery.id,
      repository: recovery.repository,
      target: candidate.target,
      snapshot_id: snapshotId,
      evidence_path: path,
      action_kind: recovery.action === 'repair' ? 'REPAIR' : 'REFIRE',
      action_parameters: { scope_digest: candidate.scopeDigest, action: recovery.action },
      actor: ACTOR,
      policy_digest: state.policy_digest,
      verifier_registry_digest: state.verifier_registry_digest,
    });
    return created.ok ? created.value : await getM31ActionProposalV2(recovery.id);
  } catch (error) {
    const raced = await getM31ActionProposalV2(recovery.id);
    if (raced) return raced;
    throw error;
  }
}

function matchesProposal(proposal: M31ActionProposalV2, recovery: RecoveryCase): boolean {
  return (
    proposal.proposal_id === recovery.id &&
    proposal.repository === recovery.repository &&
    proposal.target_digest === recovery.targetDigest &&
    proposal.actor === ACTOR &&
    proposal.action_kind === (recovery.action === 'repair' ? 'REPAIR' : 'REFIRE') &&
    canonicalStringify(proposal.action_parameters) ===
      canonicalStringify({
        scope_digest: recovery.scopeDigest,
        action: recovery.action,
      })
  );
}

async function executeCase(
  record: WatchedRunRecord,
  candidate: Candidate,
  recovery: RecoveryCase,
  proposal: M31ActionProposalV2,
  transport: OverseerRecoveryTransport,
  github: RecoveryGitHubReads
): Promise<string> {
  const action = recovery.action;
  if (!action) return 'recovery_action_missing';
  const authority = candidate.authority;
  let permit: M31ActionPermitV2 | undefined;
  let armedClaim: ExecutionClaimResponse | undefined;
  let resumeBinding: OverseerResumeBinding | undefined;

  const revalidate = async (): Promise<boolean> => {
    const current = await readCandidate(record, candidate.eventId);
    const state = await getOverseerCapabilityState('repair');
    const policy = readOverseerActionPolicyFromEnv();
    return Boolean(
      current &&
      targetDigestV2(current.target) === recovery.targetDigest &&
      current.scopeDigest === recovery.scopeDigest &&
      !(await laneOwns(candidate.run.id)) &&
      state?.action_enabled &&
      state.circuit_state === 'closed' &&
      state.policy_digest === proposal.policy_digest &&
      state.verifier_registry_digest === proposal.verifier_registry_digest &&
      policy.service_enabled &&
      !policy.emergency_stop &&
      !policy.legacy_dry_run &&
      (await getCauldronDrainState()).mode !== 'draining' &&
      policy.capability_flags.repair &&
      permit &&
      Date.parse(await clock()) < Date.parse(permit.valid_until) &&
      !(await getOverseerRecoveryStages(candidate.run.id)).recovery_handoff &&
      (
        await github.listOpenPullRequests({
          woId: recovery.woId,
          project: candidate.project,
          headBranches: [authority.headBranch],
          failOnError: true,
          includeDrafts: true,
        })
      ).length === 0 &&
      (await github.readRemoteHead(authority.worktreePath, authority.baseBranch)) ===
        authority.baseSha &&
      [null, candidate.head].includes(
        await github.readRemoteHead(authority.worktreePath, authority.headBranch)
      )
    );
  };

  const readDispatchResult = async (): Promise<FirstRefireOnRampResultV1> => {
    if (!armedClaim) throw new Error('armed_claim_missing');
    const readback = await readResult(proposal, armedClaim, authority);
    return (
      readback.result ??
      (readback.pending
        ? result(
            'indeterminate',
            `workflow-admission:${proposal.execution_id}`,
            null,
            'await_exact_workflow_result'
          )
        : result('indeterminate', null, null, 'workflow_result_unverified'))
    );
  };

  const fire = async (): Promise<string | null> => {
    const tier = loadLadder().find(item => item.workflowName === authority.workflowName);
    if (!tier || loadPremiumTiers().includes(tier.name) || loadRefusedTiers().includes(tier.name))
      return null;
    if (!(await revalidate())) return null;
    const spec = {
      specSource: authority.specSource,
      specRevision: authority.specRevision,
      specHash: authority.specHash,
    };
    const eligible = await github.fireEligibility(recovery.woId);
    if (
      !eligible.eligible ||
      !eligible.evidence ||
      normalizeRepo(eligible.evidence.targetRepo) !== recovery.repository ||
      eligible.evidence.project !== candidate.project.split('/').at(-1) ||
      canonicalStringify(eligible.evidence.expectedSpec) !== canonicalStringify(spec)
    )
      return null;
    const dispatched = await dispatchGuardedWoRun({
      woId: recovery.woId,
      excludeRunId: candidate.run.id,
      revalidate,
      dispatch: () =>
        transport.fire({
          runId: candidate.run.id,
          codebaseId: authority.codebaseId,
          workflowName: authority.workflowName,
          workflowRevision: authority.workflowRevision,
          baseSha: authority.baseSha,
          platformId: recoveryPlatformId(proposal.execution_id),
          woId: recovery.woId,
          message: buildFireMessage(recovery.woId, candidate.project, undefined, spec),
          revalidate,
        }),
    });
    return dispatched.ok ? dispatched.result : null;
  };

  const adapter = createRepairRefireAdapter({
    inPlaceRepair: {
      async startInPlaceRepair() {
        const binding = resumeBinding;
        if (!binding) throw new Error('resume_binding_missing');
        const admitted = await dispatchGuardedWoRun({
          woId: recovery.woId,
          excludeRunId: candidate.run.id,
          revalidate,
          dispatch: () =>
            transport.resume(candidate.run, candidate.workflow, async () => {
              if (!(await revalidate())) throw new Error('resume_target_changed');
              return resumeOverseerWorkflowRun(binding);
            }),
        });
        return admitted.ok ? readDispatchResult() : result('failed', null, null, admitted.error);
      },
    },
    onRamp: {
      async startFirstRefire() {
        await fire();
        return readDispatchResult();
      },
    },
    conductor: {
      pickEntryTier: () => authority.workflowName,
      async runCascade() {
        const tier = loadLadder().find(tier => tier.workflowName === authority.workflowName);
        if (!tier) return result('failed', null, null, 'admitted_workflow_missing_from_ladder');
        const outDir = join(dirname(proposal.evidence_path), 'cascade');
        await fireCascadeUntilRunDiscovered(runCascade, id => readCascadeRecord(id, outDir), {
          outDir,
          woId: recovery.woId,
          project: candidate.project,
          entryOverride: tier.name,
          dispatchId: proposal.execution_id,
          admitOnly: true,
          deps: {
            seatUsage: github.readSeatUsage,
            findWoClaim: (woId, project) => github.findClaim({ woId, project }),
            preflight: async entry => {
              if (entry.workflowName !== authority.workflowName || !(await revalidate())) {
                throw new Error('cascade_target_changed');
              }
            },
            fire: async input => {
              if (input.workflowName !== authority.workflowName)
                throw new Error('cascade_target_changed');
              const runId = await fire();
              return {
                ok: runId !== null,
                runId,
                conversationId: null,
                infraError: runId ? null : 'guarded_recovery_dispatch_refused',
              };
            },
          },
        });
        return readDispatchResult();
      },
    },
  });

  const artifact = JSON.parse(await readFile(proposal.evidence_path, 'utf8')) as {
    receipt: Parameters<typeof executeRepairRefire>[0]['salvage_receipt'];
  };
  if (
    (await git(authority.worktreePath, 'hash-object', '--', proposal.evidence_path)) !==
      proposal.evidence_git_blob ||
    artifact.receipt?.source_target_digest !== recovery.targetDigest ||
    artifact.receipt?.scope_digest !== recovery.scopeDigest
  )
    return 'salvage_evidence_changed';

  const executed = await executeRepairRefire(
    {
      assessment: {
        disposition: action,
        escalation_reason: null,
        requires_circuit_open: false,
        no_mutation: false,
      },
      proposal_id: proposal.proposal_id,
      execution_id: proposal.execution_id,
      idempotency_key: recovery.id,
      repository: recovery.repository,
      wo_id: recovery.woId,
      workflow_name: authority.workflowName,
      target_digest: proposal.target_digest,
      scope_digest: candidate.scopeDigest,
      failure_digest: digest(recovery.event),
      source_run_id: candidate.run.id,
      salvage_receipt: artifact.receipt,
      actor: ACTOR,
      correlation_id: recovery.id,
    },
    {
      adapter,
      adapterName: ADAPTER,
      sha256hex: input => createHash('sha256').update(input).digest('hex'),
      beforeDispatch: async (claim, effectAttemptId) => {
        if (!(await revalidate())) throw new Error('recovery_target_changed');
        armedClaim =
          (await getRecoveryExecutionClaim(claimIdentity(proposal, recovery))) ?? undefined;
        if (armedClaim?.effect_attempt_id !== effectAttemptId)
          throw new Error('recovery_claim_changed');
        resumeBinding = {
          run: candidate.run,
          eventId: candidate.eventId,
          eventTipId: candidate.eventTipId,
          claimId: claim.claim_id,
          effectAttemptId,
          fence: claim.execution_fencing_token,
          executionId: proposal.execution_id,
        };
      },
      gate: {
        async preparePermit() {
          const receipts = await listM31ExecutionReceiptEventsV2(proposal.execution_id);
          const issued = receipts[0];
          if (
            issued?.valid_until &&
            receipts.length < 3 &&
            Date.parse(issued.valid_until) > Date.parse(await clock())
          ) {
            permit = {
              permit_id: issued.receipt_event_id,
              proposal_id: proposal.proposal_id,
              execution_id: proposal.execution_id,
              repository: proposal.repository,
              target: proposal.target,
              target_digest: proposal.target_digest,
              target_key: proposal.target_key,
              snapshot_id: proposal.snapshot_id,
              action_kind: proposal.action_kind,
              capability: proposal.capability,
              issued_at: issued.created_at,
              valid_until: issued.valid_until,
            };
            return { ok: true, reason: 'persisted_permit_reused' };
          }
          const prepared = await prepareM31ActionPermitV2(
            { proposal_id: proposal.proposal_id },
            {
              capabilityGate: createFailClosedM31CapabilityGateV2(),
              liveStateReader: {
                async readBoundState() {
                  const current = await readCandidate(record, candidate.eventId);
                  const state = await getOverseerCapabilityState('repair');
                  return {
                    known:
                      !!current &&
                      current.scopeDigest === candidate.scopeDigest &&
                      !(await laneOwns(candidate.run.id)),
                    target: current?.target ?? candidate.target,
                    policy_digest: state?.policy_digest ?? '',
                    verifier_registry_digest: state?.verifier_registry_digest ?? '',
                    observed_at: await clock(),
                  };
                },
              },
            }
          );
          if (prepared.ok) permit = prepared.permit;
          return {
            ok: prepared.ok,
            reason: prepared.ok
              ? 'permit_issued'
              : 'failure' in prepared
                ? prepared.failure
                : 'recovery_permit_refused',
          };
        },
        async authorizeAction() {
          if (!permit) return { allowed: false, reason: 'recovery_permit_missing' };
          return authorizeOverseerActionV2(
            {
              requested_capability: 'repair',
              permit,
              actor: ACTOR,
              correlation_id: recovery.id,
            },
            {
              getPolicy: async () => readOverseerActionPolicyFromEnv(),
              getCapabilityState: getOverseerCapabilityState,
              getProposal: getM31ActionProposalV2,
              getCurrentTime: clock,
              recordDecision: async ({ decision }) => {
                await insertOverseerAction({
                  runId: candidate.run.id,
                  woId: recovery.woId,
                  class: 'recovery',
                  action: 'recovery_authorization',
                  result: JSON.stringify({ case_id: recovery.id, reason: decision.reason }),
                });
              },
            }
          );
        },
        async reserveEffect() {
          if (!permit) return { ok: false, reason: 'recovery_permit_missing' };
          if (!(await revalidate())) return { ok: false, reason: 'recovery_target_changed' };
          const receipts = await listM31ExecutionReceiptEventsV2(proposal.execution_id);
          if (
            receipts.length === 2 &&
            receipts[1]?.event_type === 'effect_reserved' &&
            receipts[1].adapter_name === ADAPTER &&
            receipts[1].target_digest === proposal.target_digest
          ) {
            // The scoped claim permits only the original fence or safe unarmed takeover.
            return { ok: true, reason: 'existing_reservation' };
          }
          const reserved = await reserveM31ExecutionEffectV2({
            permit,
            adapter_name: ADAPTER,
            provider_operation: action,
            reason: 'bounded_exact_run_recovery',
            evidence: { case_id: recovery.id },
            recovery_attempt_limit: MAX_AUTOMATIC_RECOVERY_ATTEMPTS,
          });
          return { ok: reserved.ok, reason: reserved.ok ? 'reserved' : reserved.failure };
        },
        appendOutcome: input =>
          appendM31ExecutionOutcomeV2({
            ...input,
            evidence: { case_id: recovery.id, scope_digest: recovery.scopeDigest },
          }),
      },
      idempotency: {
        async begin(key, requestDigest) {
          if (key !== recovery.id) return { status: 'conflict' };
          const stored = await recordOverseerRecoveryStage(
            candidate.run.id,
            recovery.woId,
            'request',
            requestDigest
          );
          return { status: stored === requestDigest ? 'fresh' : 'conflict' };
        },
        async commit(_key, result) {
          await recordOverseerRecoveryStage(
            candidate.run.id,
            recovery.woId,
            'result',
            canonicalStringify(result)
          );
        },
      },
      circuit: {
        openRepairCircuit: async () => {
          throw new Error('recovery_reconciliation_required');
        },
      },
      recorder: {
        async recordDisposition(disposition) {
          await insertOverseerAction({
            runId: candidate.run.id,
            woId: recovery.woId,
            class: 'recovery',
            action: 'repair_refire',
            result: canonicalStringify(disposition),
          });
        },
      },
    }
  );
  return executed.reason;
}

export function createOverseerWatchRecovery(
  transport: OverseerRecoveryTransport,
  github: RecoveryGitHubReads = githubReads
): WatchRecovery {
  return {
    selectEvent,
    async handle(record): Promise<boolean> {
      const {
        recovery_case: existing,
        recovery_closed: closed,
        recovery_handoff: pendingHandoff,
      } = await getOverseerRecoveryStages(record.runId);
      if (closed) return record.action !== 'merge_ready';
      if (!existing && (!record.recoveryEvent?.id || record.action !== 'escalate')) {
        return record.status === 'running' || record.status === 'interrupted';
      }
      const run = await getWorkflowRun(record.runId);
      if (run?.parent_conversation_id) {
        const { rows } = await getDatabase().query<{ platform_conversation_id: string }>(
          'SELECT platform_conversation_id FROM remote_agent_conversations WHERE id = $1',
          [run.parent_conversation_id]
        );
        if (rows[0]?.platform_conversation_id.startsWith('overseer-recovery-')) return false;
      }
      const source = existing ? (JSON.parse(existing) as RecoveryCase).event : record.recoveryEvent;
      const events = await listRunEventsForOverseer(record.runId);
      const event = findReturnEvent(events, record.runId) ?? source;
      if (!event?.id) return true;
      const returned = event.event_type === 'run_outcome';
      const active = record.status === 'running' || record.status === 'interrupted';
      if (
        !existing &&
        !returned &&
        ((await laneOwns(record.runId)) || (active && !(await explicitlyReleased(record.runId))))
      ) {
        if (active) {
          await recordOverseerRecoveryStage(
            record.runId,
            record.woId,
            'observed',
            JSON.stringify({
              eventId: event.id,
              eventAt: event.created_at,
              reason: 'waiting_for_safe_lane_release',
            })
          );
        }
        return true;
      }

      const candidate = !returned ? await readCandidate(record, event.id).catch(() => null) : null;
      const repo =
        candidate?.target.repository ??
        (record.owner && record.repo ? `${record.owner}/${record.repo}`.toLowerCase() : 'unknown');
      const scopeDigest = candidate?.scopeDigest ?? null;
      const targetDigest = candidate ? targetDigestV2(candidate.target) : null;
      let recovery: RecoveryCase;
      if (existing) {
        recovery = JSON.parse(existing) as RecoveryCase;
      } else {
        const window = await getM31RecoveryAttemptWindow(repo, record.woId);
        const assessment = assessRepairRefireCandidate({
          action_gate_enabled: true,
          evidence_complete: !!candidate,
          has_exact_target: !!candidate,
          has_active_owner_or_run:
            !!candidate &&
            (await findLiveRunsForWo(record.woId)).some(run => run.id !== record.runId),
          has_indeterminate_prior_effect: window.unresolved,
          salvage_complete: !!candidate,
          automatic_attempt_count: window.count,
          scope_changed: false,
          semantic_dispute: false,
          fusion_available: false,
          repairable_in_place: candidate?.canResume === true,
        });
        const action = assessment.no_mutation ? null : (assessment.disposition as RecoveryAction);
        const blocker = returned
          ? 'returned_to_author'
          : (assessment.escalation_reason ??
            (action ? null : 'exact_target_or_salvage_unverified'));
        const identity = {
          runId: record.runId,
          eventId: event.id,
          repository: repo,
          woId: record.woId,
          targetDigest,
          action,
        };
        const hash = digest(identity);
        const id = `m31v2-proposal-${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
        recovery = JSON.parse(
          await recordOverseerRecoveryStage(
            record.runId,
            record.woId,
            'case',
            JSON.stringify({
              ...identity,
              id,
              scopeDigest,
              blocker,
              event: {
                id: event.id,
                event_type: event.event_type,
                step_name: event.step_name,
                created_at: event.created_at,
              },
            })
          )
        ) as RecoveryCase;
      }
      let reason = recovery.blocker ?? 'recovery_target_changed';
      try {
        if (recovery.action) {
          let proposal = await getM31ActionProposalV2(recovery.id);
          if (
            !proposal &&
            !pendingHandoff &&
            !returned &&
            candidate &&
            targetDigest === recovery.targetDigest
          ) {
            proposal = await getOrCreateProposal(candidate, recovery);
          }
          if (proposal && matchesProposal(proposal, recovery)) {
            let claim = await getRecoveryExecutionClaim(claimIdentity(proposal, recovery));
            if (claim && (claim.effect_attempt_state === 'armed' || claim.status === 'completed')) {
              const reconciled = await reconcileCase(proposal, recovery, claim);
              if (reconciled !== 'unverified') return true;
              reason = 'recovery_requires_reconciliation';
            } else if (
              !pendingHandoff &&
              !returned &&
              candidate &&
              targetDigest === recovery.targetDigest &&
              scopeDigest === recovery.scopeDigest &&
              !(await laneOwns(record.runId)) &&
              Date.parse(proposal.expires_at) > Date.parse(await clock())
            ) {
              reason = await executeCase(record, candidate, recovery, proposal, transport, github);
              claim = await getRecoveryExecutionClaim(claimIdentity(proposal, recovery));
              if (
                claim?.effect_attempt_state === 'none' &&
                claim.status === 'active' &&
                Date.parse(claim.expires_at) > Date.parse(await clock())
              )
                return true;
              if (claim && (await reconcileCase(proposal, recovery, claim)) !== 'unverified')
                return true;
            }
          } else if (!proposal) {
            reason = 'recovery_admission_or_authority_unavailable';
          }
        }
      } catch {
        reason = 'recovery_evidence_or_effect_unavailable';
      }
      await handoff(record.runId, recovery, returned ? 'returned_to_author' : reason, github);
      return true;
    },
  };
}
