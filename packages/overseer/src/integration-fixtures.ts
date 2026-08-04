/**
 * M-42 Slice 8 deterministic fixtures and injected fake seams for S4-S7
 * integration scenarios. Fake adapters and in-memory stores only.
 * Does not rewrite child action internals.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { M31ActionPermitV2, M31ExecutionReceiptEventV2 } from '@archon/core/db/m31-target-v2';
import { canonicalJsonV2 } from '@archon/core/db/m31-target-v2';
import {
  createRepairRefireAdapter,
  type RepairRefireConductorDeps,
  type RepairRefireInPlaceRepairDeps,
} from './adapters/repair-refire';
import { createLifecycleMutationAdapter } from './adapters/lifecycle';
import {
  assessRepairRefireCandidate,
  executeRepairRefire,
  type FirstRefireOnRampDepsV1,
  type FirstRefireOnRampResultV1,
  type OverseerSalvageReceiptV1,
  type RepairRefireExecutionDeps,
  type RepairRefireExecutionInput,
  type RepairRefireExecutionClaimDeps,
  type RepairRefireIdempotencyState,
} from './actions/repair-refire';
import type {
  AcquireRecoveryExecutionClaimResult,
  ClaimMutationResult,
  PreEffectResult,
} from '@archon/core/db/execution-claims';
import {
  executeRefreshRebase,
  type ExecuteRefreshRebaseDepsV1,
  type ExecuteRefreshRebaseInputV1,
  type InjectedActionPolicyDepsV1 as BranchPolicyDeps,
} from './actions/refresh-rebase';
import {
  executeLifecycleAction,
  type ExecuteLifecycleActionDepsV1,
  type ExecuteLifecycleActionInputV1,
  type InjectedActionPolicyDepsV1 as LifecyclePolicyDeps,
  type LifecycleCandidateInputV1,
} from './actions/lifecycle';
import {
  executeQualifiedMerge,
  type ExecuteQualifiedMergeDeps,
  type QualifiedMergeAdapterResultV2,
  type QualifiedMergeEvidence,
} from './actions/merge-ready';
import { loadOverseerActionPolicyRegistry } from './policy-registry';
import type { ActionPolicyV2AuthorizationResult } from './action-policy-v2';
import type { PullRequestEvidence, WatchedRunRecord } from './types';
import {
  buildOperatorCard,
  type ActionableEventIdentity,
  type OperatorCard,
  type OperatorCardPayload,
} from './operator-card';
import {
  deliverOperatorCard,
  type DeliveryStore,
  type OperatorCardChannel,
} from './escalation-delivery';
import type {
  DeliveryJobRecord,
  DeliveryReceiptRecord,
  OperatorCardView,
} from '@archon/core/db/overseer-briefing';

export function sha256hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function createCallLog(): {
  readonly log: string[];
  push(step: string): void;
  snapshot(): readonly string[];
} {
  const log: string[] = [];
  return {
    log,
    push(step: string): void {
      log.push(step);
    },
    snapshot(): readonly string[] {
      return [...log];
    },
  };
}

export interface RealCallTracker {
  recordRealCall(reason: string): void;
  getRealCallCount(): number;
  readonly reasons: readonly string[];
}

export function createRealCallTracker(): RealCallTracker {
  let count = 0;
  const reasons: string[] = [];
  return {
    get reasons(): readonly string[] {
      return reasons;
    },
    recordRealCall(reason: string): void {
      count += 1;
      reasons.push(reason);
    },
    getRealCallCount(): number {
      return count;
    },
  };
}

// ---------------------------------------------------------------------------
// Shared digests / identity
// ---------------------------------------------------------------------------

export const HEAD_SHA = 'c'.repeat(40);
export const BASE_SHA = 'd'.repeat(40);
export const POLICY_DIGEST = sha256hex('policy');
export const REGISTRY_DIGEST = sha256hex('registry');
export const PARAMS_DIGEST = sha256hex('params');
export const TARGET_DIGEST = sha256hex('target-a');
export const PERMIT_EVENT_DIGEST = 'a1'.repeat(32);
export const RESERVATION_EVENT_DIGEST = 'b2'.repeat(32);
export const OUTCOME_EVENT_DIGEST = 'd5'.repeat(32);
export const FUSION_RECEIPT_DIGEST = 'a7'.repeat(32);
export const FUSION_EVIDENCE_DIGEST = 'b8'.repeat(32);

function loadMergeRegistry(): ReturnType<typeof loadOverseerActionPolicyRegistry> {
  const path = fileURLToPath(
    new URL('./__tests__/fixtures/overseer-action-policy.synthetic.json', import.meta.url)
  );
  return loadOverseerActionPolicyRegistry({ text: readFileSync(path, 'utf8') });
}

// ---------------------------------------------------------------------------
// Operator card (Slice 3 path)
// ---------------------------------------------------------------------------

export function buildIndeterminateOperatorCard(input: {
  readonly run_id: string;
  readonly wo_id: string;
  readonly capability: string;
}): OperatorCard {
  const identity: ActionableEventIdentity = {
    identity_version: 'overseer-actionable-event-v1',
    source_event_id: `indeterminate:${input.run_id}`,
    run_id: input.run_id,
    wo_id: input.wo_id,
    event_type: 'effect_indeterminate',
    step_name: 'reconciliation',
    event_created_at: '2026-07-16T00:00:00.000Z',
    error_class: 'indeterminate_prior_effect',
  };
  const payload: OperatorCardPayload = {
    repository: 'bluedevilcollectibles/bdc-harness',
    branch: null,
    pr_url: null,
    pr_number: null,
    head_sha: null,
    base_branch: null,
    base_sha: null,
    checks: {},
    mergeability: 'unknown',
    blocker: `indeterminate_prior_effect:${input.capability}`,
    mechanical_evidence: { capability: input.capability },
    recovery_attempted: { retry: false },
    proposed_remediation: { action: 'operator_ruling' },
    next_permitted_action: 'none',
    responsible_actor: 'operator',
    actionable_event_at: '2026-07-16T00:00:00.000Z',
    required_ruling: 'resolve_indeterminate_effect',
    evidence_links: {},
    lifecycle_classification: 'indeterminate',
    governance_classification: 'operator_card',
  };
  return buildOperatorCard(identity, payload);
}

export interface OperatorCardReconciliationResult {
  readonly card_id: string;
  readonly deliver_calls: number;
  readonly reconcile_calls: number;
  readonly terminal_outcome: string;
}

/**
 * Exercise the real Slice 3 delivery reconciliation path with an in-memory
 * store and fake channel. The unfinished STARTED receipt forces reconcile(),
 * never deliver(), so a restart cannot blindly repeat an external effect.
 */
export async function runIndeterminateOperatorCardReconciliation(input: {
  readonly run_id: string;
  readonly wo_id: string;
  readonly capability: string;
}): Promise<OperatorCardReconciliationResult> {
  const built = buildIndeterminateOperatorCard(input);
  const now = '2026-07-16T00:00:02.000Z';
  const makeJob = (
    channel: DeliveryJobRecord['channel'],
    state: DeliveryJobRecord['state']
  ): DeliveryJobRecord => ({
    card_id: built.card_id,
    channel,
    state,
    attempts_started: channel === 'dispatch' ? 1 : 0,
    next_attempt_at: '2026-07-16T00:00:00.000Z',
    lease_owner: channel === 'dispatch' ? 'slice8-recovery-runner' : null,
    lease_expires_at: channel === 'dispatch' ? '2026-07-16T00:00:01.000Z' : null,
    fencing_token: channel === 'dispatch' ? 1 : 0,
    updated_at: '2026-07-16T00:00:00.000Z',
  });
  let dispatchJob = makeJob('dispatch', 'leased');
  const builderJob = makeJob('builder_monitor', 'pending');
  const notionJob = makeJob('notion', 'pending');
  const receipts: DeliveryReceiptRecord[] = [
    {
      receipt_id: 'receipt-started-indeterminate-1',
      card_id: built.card_id,
      channel: 'dispatch',
      attempt_number: 1,
      phase: 'started',
      started_at: '2026-07-16T00:00:00.000Z',
      completed_at: null,
      outcome: null,
      sanitized_status: null,
      error_class: null,
      next_attempt_at: null,
      provider_receipt_id: null,
      fencing_token: 1,
      created_at: '2026-07-16T00:00:00.000Z',
    },
  ];
  const cardRecord: OperatorCardView['card'] = {
    ...built,
    ...built.payload,
    canonical_event_identity: built.canonical_event_identity as unknown as Record<string, unknown>,
    payload: built.payload as unknown as Record<string, unknown>,
    run_id: input.run_id,
    wo_id: input.wo_id,
    created_at: '2026-07-16T00:00:00.000Z',
  };
  const view = (): OperatorCardView => ({
    card: cardRecord,
    jobs: [dispatchJob, builderJob, notionJob],
    receipts: [...receipts],
    delivery_summary: {
      dispatch: dispatchJob,
      builder_monitor: builderJob,
      notion: notionJob,
    },
  });
  const store: DeliveryStore = {
    claimDueDeliveryJob: async () => null,
    getOperatorCard: async cardId => (cardId === built.card_id ? view() : null),
    appendDeliveryReceipt: async receipt => {
      const recorded: DeliveryReceiptRecord = {
        receipt_id: receipt.receipt_id ?? `receipt-${receipt.phase}-indeterminate-1`,
        card_id: receipt.card_id,
        channel: receipt.channel,
        attempt_number: receipt.attempt_number,
        phase: receipt.phase,
        started_at: receipt.started_at,
        completed_at: receipt.completed_at ?? null,
        outcome: receipt.outcome ?? null,
        sanitized_status: receipt.sanitized_status ?? null,
        error_class: receipt.error_class ?? null,
        next_attempt_at: receipt.next_attempt_at ?? null,
        provider_receipt_id: receipt.provider_receipt_id ?? null,
        fencing_token: receipt.fencing_token,
        created_at: receipt.created_at ?? receipt.completed_at ?? receipt.started_at,
      };
      receipts.push(recorded);
      return recorded;
    },
    completeDeliveryJob: async completion => {
      dispatchJob = {
        ...dispatchJob,
        state: completion.outcome === 'indeterminate' ? 'indeterminate' : 'exhausted',
        lease_owner: null,
        lease_expires_at: null,
        updated_at: completion.now ?? now,
      };
      return dispatchJob;
    },
  };
  let deliverCalls = 0;
  let reconcileCalls = 0;
  const channel: OperatorCardChannel = {
    channel: 'dispatch',
    deliver: async () => {
      deliverCalls += 1;
      return { outcome: 'succeeded', sanitized_status: 'unexpected_blind_delivery' };
    },
    reconcile: async () => {
      reconcileCalls += 1;
      return {
        outcome: 'indeterminate',
        sanitized_status: 'reconciliation_failed_unknown_provider_state',
        error_class: 'reconciliation_failed',
      };
    },
  };

  const completed = await deliverOperatorCard({
    job: dispatchJob,
    channel,
    owner: 'slice8-recovery-runner',
    now,
    store,
  });
  const terminal = receipts.find(receipt => receipt.phase === 'terminal');
  if (
    deliverCalls !== 0 ||
    reconcileCalls !== 1 ||
    completed.state !== 'indeterminate' ||
    terminal?.outcome !== 'indeterminate'
  ) {
    throw new Error('operator_card_reconciliation_contract_failed');
  }
  return {
    card_id: built.card_id,
    deliver_calls: deliverCalls,
    reconcile_calls: reconcileCalls,
    terminal_outcome: terminal.outcome,
  };
}

// ---------------------------------------------------------------------------
// S4 repair/refire
// ---------------------------------------------------------------------------

function sampleSalvage(): OverseerSalvageReceiptV1 {
  return {
    schema_version: 'overseer-salvage-receipt-v1',
    repository: 'bluedevilcollectibles/bdc-harness',
    wo_id: 'WO-M42-S8-INTEGRATION',
    source_target_kind: 'workflow_run',
    source_target_key: 'run-pred-1',
    source_target_digest: sha256hex('target'),
    source_run_id: 'run-pred-1',
    worktree_path: '/tmp/worktrees/run-pred-1',
    artifact_kind: 'git_object',
    git_object_format: 'sha256',
    git_object_id: sha256hex('commit'),
    patch_path: null,
    patch_sha256: null,
    scope_digest: sha256hex('scope'),
    captured_at: '2026-07-16T00:00:00.000Z',
    verified_at: '2026-07-16T00:00:01.000Z',
  };
}

function succeededOnRamp(suffix: string): FirstRefireOnRampResultV1 {
  return {
    schema_version: 'overseer-first-refire-on-ramp-result-v1',
    status: 'succeeded',
    successor_run_id: `run-succ-${suffix}`,
    external_effect_reference: `fake://effect/run-succ-${suffix}`,
    evidence_digest: sha256hex(`evidence-${suffix}`),
    reason: 'fake replacement run started',
  };
}

function fakeRepairClaimDeps(
  callLog: ReturnType<typeof createCallLog>
): RepairRefireExecutionClaimDeps {
  return {
    async acquire(input): Promise<AcquireRecoveryExecutionClaimResult> {
      callLog.push('repair:claim_acquire');
      return {
        ok: true,
        created: true,
        outcome: 'acquired',
        claim: {
          claim_id: `claim-${input.execution_id}`,
          motion_id: `overseer:${input.repository}:${input.wo_id}:${input.execution_id}`,
          action_kind: 'overseer_repair_refire',
          environment: 'recovery',
          target_sha: input.target_digest,
          action_key: sha256hex(input.execution_id),
          motion_file_path: 'overseer://integration',
          motion_revision_sha: '0'.repeat(40),
          claimant_principal: input.actor_principal,
          claimant_xo_holder_id: 'recovery',
          claimant_xo_lease_id: 'recovery',
          claimant_xo_fencing_token: 1,
          execution_fencing_token: 1,
          status: 'active',
          reconciliation_status: 'clear',
          effect_attempt_id: null,
          effect_attempt_state: 'none',
          effect_armed_at: null,
          acquired_at: '2026-07-16T00:00:00.000Z',
          renewed_at: null,
          expires_at: '2999-01-01T00:00:00.000Z',
          released_at: null,
          completed_at: null,
          external_effect_reference: null,
          completion_evidence: null,
          reconciliation_evidence: null,
        },
      };
    },
    async validate(input): Promise<PreEffectResult> {
      callLog.push('repair:claim_validate');
      return {
        ok: true,
        claim_id: input.claim_id,
        permitted: true,
        effect_attempt_id: `effect-${input.claim_id}`,
        execution_fencing_token: input.execution_fencing_token,
        motion_revision_sha: '0'.repeat(40),
      };
    },
    async complete(): Promise<ClaimMutationResult> {
      callLog.push('repair:claim_complete');
      return { ok: true, claim: null as never };
    },
    async release(): Promise<ClaimMutationResult> {
      callLog.push('repair:claim_release');
      return { ok: true, claim: null as never };
    },
  };
}

export interface RepairHarness {
  readonly deps: RepairRefireExecutionDeps;
  readonly callLog: ReturnType<typeof createCallLog>;
  readonly circuitOpened: { value: boolean };
}

export function makeRepairHarness(
  opts: {
    readonly onRampStatus?: 'succeeded' | 'failed' | 'indeterminate';
    readonly permitOk?: boolean;
    readonly authAllowed?: boolean;
    readonly reserveOk?: boolean;
    readonly conflictIdempotency?: boolean;
    readonly preseedIdempotency?: {
      readonly key: string;
      readonly digest: string;
      readonly result: FirstRefireOnRampResultV1;
    };
  } = {}
): RepairHarness {
  const callLog = createCallLog();
  const circuitOpened = { value: false };
  const idemMap = new Map<string, { digest: string; result?: FirstRefireOnRampResultV1 }>();
  if (opts.preseedIdempotency) {
    idemMap.set(opts.preseedIdempotency.key, {
      digest: opts.preseedIdempotency.digest,
      result: opts.preseedIdempotency.result,
    });
  }

  const onRamp: FirstRefireOnRampDepsV1 = {
    async startFirstRefire() {
      callLog.push('repair:adapter');
      if (opts.onRampStatus === 'failed') {
        return {
          schema_version: 'overseer-first-refire-on-ramp-result-v1',
          status: 'failed',
          successor_run_id: null,
          external_effect_reference: null,
          evidence_digest: sha256hex('fail'),
          reason: 'provider_outage',
        };
      }
      if (opts.onRampStatus === 'indeterminate') {
        return {
          schema_version: 'overseer-first-refire-on-ramp-result-v1',
          status: 'indeterminate',
          successor_run_id: null,
          external_effect_reference: null,
          evidence_digest: sha256hex('indet'),
          reason: 'provider_indeterminate',
        };
      }
      return succeededOnRamp('1');
    },
  };
  const conductor: RepairRefireConductorDeps = {
    pickEntryTier: () => 'tier-fast',
    async runCascade() {
      callLog.push('repair:adapter');
      return succeededOnRamp('later');
    },
  };
  const inPlaceRepair: RepairRefireInPlaceRepairDeps = {
    async startInPlaceRepair() {
      callLog.push('repair:adapter');
      return succeededOnRamp('repair');
    },
  };

  const deps: RepairRefireExecutionDeps = {
    gate: {
      async preparePermit() {
        callLog.push('repair:prepare');
        return {
          ok: opts.permitOk ?? true,
          reason: opts.permitOk === false ? 'permit_denied' : 'ok',
        };
      },
      async authorizeAction() {
        callLog.push('repair:authorize');
        return {
          allowed: opts.authAllowed ?? true,
          reason: opts.authAllowed === false ? 'denied' : 'allowed',
        };
      },
      async reserveEffect() {
        callLog.push('repair:reserve');
        return {
          ok: opts.reserveOk ?? true,
          reason: opts.reserveOk === false ? 'reserve_failed' : 'ok',
        };
      },
      async appendOutcome(input) {
        callLog.push(`repair:outcome:${input.outcome}`);
        return { ok: true };
      },
    },
    adapter: createRepairRefireAdapter({
      onRamp,
      conductor,
      inPlaceRepair,
      woClass: 'CODE',
      tags: ['overseer-integration'],
    }),
    idempotency: {
      async begin(key, digest): Promise<RepairRefireIdempotencyState> {
        callLog.push('repair:idempotency_begin');
        if (opts.conflictIdempotency) {
          const existing = idemMap.get(key);
          if (existing && existing.digest !== digest) return { status: 'conflict' };
        }
        const existing = idemMap.get(key);
        if (!existing) {
          idemMap.set(key, { digest });
          return { status: 'fresh' };
        }
        if (existing.digest !== digest) return { status: 'conflict' };
        if (existing.result) return { status: 'replay', result: existing.result };
        return { status: 'fresh' };
      },
      async commit(key, result) {
        callLog.push('repair:idempotency_commit');
        const existing = idemMap.get(key);
        if (existing) existing.result = result;
      },
    },
    circuit: {
      async openRepairCircuit() {
        callLog.push('repair:circuit_open');
        circuitOpened.value = true;
      },
    },
    recorder: {
      async recordDisposition() {
        callLog.push('repair:record');
      },
    },
    executionClaim: fakeRepairClaimDeps(callLog),
    sha256hex,
  };

  return { deps, callLog, circuitOpened };
}

export function repairExecInput(
  assessment: ReturnType<typeof assessRepairRefireCandidate>,
  overrides: Partial<RepairRefireExecutionInput> = {}
): RepairRefireExecutionInput {
  return {
    assessment,
    proposal_id: 'm31v2-proposal-repair-1',
    execution_id: 'm31v2-exec-repair-1',
    idempotency_key: 'idem-repair-1',
    repository: 'bluedevilcollectibles/bdc-harness',
    wo_id: 'WO-M42-S8-INTEGRATION',
    workflow_name: 'implement',
    target_digest: sha256hex('target'),
    scope_digest: sha256hex('scope'),
    failure_digest: sha256hex('failure'),
    source_run_id: 'run-pred-1',
    salvage_receipt: sampleSalvage(),
    actor: 'overseer-integration',
    correlation_id: 'corr-repair-1',
    ...overrides,
  };
}

export async function runRepairSuccess(harness: RepairHarness): Promise<{
  readonly result: Awaited<ReturnType<typeof executeRepairRefire>>;
  readonly assessment: ReturnType<typeof assessRepairRefireCandidate>;
  readonly ordered: readonly string[];
}> {
  const assessment = assessRepairRefireCandidate({
    action_gate_enabled: true,
    evidence_complete: true,
    has_exact_target: true,
    has_active_owner_or_run: false,
    has_indeterminate_prior_effect: false,
    salvage_complete: true,
    automatic_attempt_count: 0,
    scope_changed: false,
    semantic_dispute: false,
    fusion_available: false,
    repairable_in_place: false,
  });
  const result = await executeRepairRefire(repairExecInput(assessment), harness.deps);
  return { result, assessment, ordered: harness.callLog.snapshot() };
}

// ---------------------------------------------------------------------------
// S5 refresh/rebase (observer + adapter injected; no real git)
// ---------------------------------------------------------------------------

function makeBranchReceipt(
  eventType: M31ExecutionReceiptEventV2['event_type'],
  sequence: number,
  previous: string | null
): M31ExecutionReceiptEventV2 {
  const event = {
    receipt_event_id: `branch-receipt-${eventType}-${sequence}`,
    proposal_id: 'm31v2-proposal-branch-1',
    execution_id: 'm31v2-exec-branch-1',
    event_sequence: sequence,
    event_type: eventType,
    target_kind: 'pull_request' as const,
    target_key: 'pr:42',
    target_digest: TARGET_DIGEST,
    live_observation: null,
    live_observation_digest: null,
    revalidated_at: null,
    valid_until: null,
    adapter_name: eventType === 'effect_reserved' ? 'fake-branch-mutation' : null,
    provider_operation: eventType === 'effect_reserved' ? 'REFRESH' : null,
    external_effect_reference: null,
    reason: eventType,
    evidence: {},
    previous_event_digest: previous,
    created_at: '2026-07-16T00:00:00.000Z',
  };
  return { ...event, event_digest: sha256hex(JSON.stringify(event)) };
}

export interface BranchHarness {
  readonly deps: ExecuteRefreshRebaseDepsV1;
  readonly callLog: ReturnType<typeof createCallLog>;
  setLiveHead(sha: string): void;
}

export function makeBranchHarness(
  opts: {
    readonly liveHeadDrift?: boolean;
    readonly dirty?: boolean;
    readonly policyEligible?: boolean;
  } = {}
): BranchHarness {
  const callLog = createCallLog();
  const head = HEAD_SHA;
  const base = BASE_SHA;
  let liveHead = opts.liveHeadDrift ? 'e'.repeat(40) : head;
  let observeCount = 0;

  const permit: M31ActionPermitV2 = {
    permit_id: 'permit-branch-1',
    proposal_id: 'm31v2-proposal-branch-1',
    execution_id: 'm31v2-exec-branch-1',
    repository: 'bluedevilcollectibles/bdc-harness',
    target: {
      target_kind: 'pull_request',
      repository: 'bluedevilcollectibles/bdc-harness',
      pr_number: 42,
      provider_node_id: 'PR_node',
      head_sha: head,
      base_branch: 'dev',
      base_sha: base,
      state: 'open',
      updated_at: '2026-07-16T00:00:00.000Z',
    },
    target_key: 'pr:42',
    target_digest: TARGET_DIGEST,
    snapshot_id: 'snapshot-branch-1',
    action_kind: 'REFRESH',
    capability: 'overseer.m31.refresh',
    issued_at: '2026-07-16T00:00:00.000Z',
    valid_until: '2026-07-16T00:10:00.000Z',
  };

  const policy: BranchPolicyDeps = {
    evaluateActionPolicy() {
      if (opts.policyEligible === false) {
        return { eligible: false, reason: 'policy_ineligible:wrong_repository' };
      }
      return { eligible: true, base_eligible: true, effect_allowed: true };
    },
  };

  const deps: ExecuteRefreshRebaseDepsV1 = {
    policy,
    observer: {
      async observeWorktree() {
        callLog.push('branch:observe');
        observeCount += 1;
        // After reserve, second observe may inject live drift.
        const useDrift = opts.liveHeadDrift && observeCount > 1;
        return {
          clean: !(opts.dirty ?? false),
          current_branch: 'wo/fixture-branch',
          head_sha: useDrift ? liveHead : head,
          factory_owned: true,
        };
      },
      async countUniqueCommits() {
        callLog.push('branch:count_unique');
        return 0;
      },
      async probeRebase() {
        callLog.push('branch:probe');
        return { conflicted: false, conflict_paths: [], conflict_signal: 'none' as const };
      },
      // Mutation primitives are unused by executeRefreshRebase (adapter owns rewrite).
      async applyRefresh() {
        throw new Error('observer.applyRefresh_forbidden');
      },
      async applyRebase() {
        throw new Error('observer.applyRebase_forbidden');
      },
      async readTreeSha() {
        throw new Error('observer.readTreeSha_forbidden');
      },
    },
    adapter: {
      async perform(request) {
        callLog.push('branch:adapter');
        return {
          adapter: 'fake-branch-mutation' as const,
          status: 'rewritten' as const,
          mode: request.mode,
          old_head_sha: request.old_head_sha,
          new_head_sha: base,
          new_tree_sha: sha256hex('tree'),
          pushed: false as const,
          permit_id: request.permit_id,
          execution_id: request.execution_id,
        };
      },
    },
    gate: {
      async preparePermit() {
        callLog.push('branch:prepare');
        return {
          ok: true as const,
          permit,
          receipt: makeBranchReceipt('permit_issued', 1, null),
        };
      },
      async authorizeBranchAction() {
        callLog.push('branch:authorize');
        return { allowed: true as const };
      },
      async reserveEffect() {
        callLog.push('branch:reserve');
        const prev = makeBranchReceipt('permit_issued', 1, null).event_digest;
        return {
          ok: true as const,
          receipt: makeBranchReceipt('effect_reserved', 2, prev),
        };
      },
      async recordOutcome({ outcome }) {
        callLog.push(`branch:outcome:${outcome}`);
        const prev = makeBranchReceipt('effect_reserved', 2, PERMIT_EVENT_DIGEST).event_digest;
        return {
          ok: true as const,
          receipt: makeBranchReceipt(outcome, 3, prev),
        };
      },
    },
    async fetchPostRewriteEvidence({ new_head_sha }) {
      callLog.push('branch:post_rewrite');
      return {
        ci: { head_sha: new_head_sha, green: true },
        review: { reviewed_head_sha: new_head_sha, verdict: 'APPROVE' as const, independent: true },
      };
    },
  };

  return {
    deps,
    callLog,
    setLiveHead(sha: string): void {
      liveHead = sha;
    },
  };
}

export function branchExecInput(
  overrides: Partial<ExecuteRefreshRebaseInputV1['candidate']> = {}
): ExecuteRefreshRebaseInputV1 {
  return {
    candidate: {
      repository: 'bluedevilcollectibles/bdc-harness',
      branch: 'wo/fixture-branch',
      worktree_path: '/fixture/worktree',
      branch_gate_enabled: true,
      policy_digest: POLICY_DIGEST,
      verifier_registry_digest: REGISTRY_DIGEST,
      run_authority: {
        run_id: 'run-branch-1',
        head_sha: HEAD_SHA,
        base_branch: 'dev',
        base_sha: BASE_SHA,
        factory_created: true,
      },
      pr_snapshot: {
        pr_number: 42,
        head_sha: HEAD_SHA,
        base_branch: 'dev',
        base_sha: BASE_SHA,
      },
      ...overrides,
    },
    proposal_id: 'm31v2-proposal-branch-1',
    actor: 'overseer-integration',
    correlation_id: 'corr-branch-1',
  };
}

export async function runBranchSuccess(harness: BranchHarness): Promise<{
  readonly result: Awaited<ReturnType<typeof executeRefreshRebase>>;
  readonly ordered: readonly string[];
}> {
  const result = await executeRefreshRebase(branchExecInput(), harness.deps);
  return { result, ordered: harness.callLog.snapshot() };
}

// ---------------------------------------------------------------------------
// S6 lifecycle
// ---------------------------------------------------------------------------

function lifecyclePermit(actionKind: 'COMMENT' | 'CLOSE' | 'REOPEN'): M31ActionPermitV2 {
  return {
    permit_id: `permit-lifecycle-${actionKind.toLowerCase()}`,
    proposal_id: `m31v2-proposal-lifecycle-${actionKind.toLowerCase()}`,
    execution_id: `m31v2-exec-lifecycle-${actionKind.toLowerCase()}`,
    repository: 'bluedevilcollectibles/bdc-harness',
    target: {
      target_kind: 'pull_request',
      repository: 'bluedevilcollectibles/bdc-harness',
      pr_number: 101,
      provider_node_id: 'PR_node_101',
      head_sha: HEAD_SHA,
      base_branch: 'dev',
      base_sha: BASE_SHA,
      state: 'open',
      updated_at: '2026-07-16T00:00:00.000Z',
    },
    target_key: 'pr:101',
    target_digest: TARGET_DIGEST,
    snapshot_id: 'snapshot-lifecycle-1',
    action_kind: actionKind,
    capability: `overseer.m31.${actionKind.toLowerCase()}`,
    issued_at: '2026-07-16T00:00:00.000Z',
    valid_until: '2026-07-16T00:10:00.000Z',
  };
}

function lifecycleReceipt(
  eventType: M31ExecutionReceiptEventV2['event_type'],
  sequence: number,
  boundPermit: M31ActionPermitV2,
  previous: string | null,
  overrides: Partial<M31ExecutionReceiptEventV2> = {}
): M31ExecutionReceiptEventV2 {
  const event = {
    receipt_event_id:
      eventType === 'permit_issued' ? boundPermit.permit_id : `lifecycle-${eventType}-${sequence}`,
    proposal_id: boundPermit.proposal_id,
    execution_id: boundPermit.execution_id,
    event_sequence: sequence,
    event_type: eventType,
    target_kind: boundPermit.target.target_kind,
    target_key: boundPermit.target_key,
    target_digest: boundPermit.target_digest,
    live_observation: null,
    live_observation_digest: null,
    revalidated_at: null,
    valid_until: null,
    adapter_name: eventType === 'effect_reserved' ? 'fake-lifecycle' : null,
    provider_operation: eventType === 'effect_reserved' ? boundPermit.action_kind : null,
    external_effect_reference: null,
    reason: eventType,
    evidence:
      eventType === 'effect_reserved'
        ? {
            target_key: boundPermit.target_key,
            target_digest: boundPermit.target_digest,
            action_parameters_digest: PARAMS_DIGEST,
          }
        : null,
    previous_event_digest: previous,
    created_at: '2026-07-16T00:00:00.000Z',
    ...overrides,
  };
  // Digest is over the event body WITHOUT event_digest (sha256Canonical).
  return {
    ...event,
    event_digest: createHash('sha256').update(canonicalJsonV2(event)).digest('hex'),
  };
}

export interface LifecycleHarness {
  readonly deps: ExecuteLifecycleActionDepsV1;
  readonly callLog: ReturnType<typeof createCallLog>;
}

export function makeLifecycleHarness(): LifecycleHarness {
  const callLog = createCallLog();
  const actionKind = 'COMMENT' as const;
  const boundPermit = lifecyclePermit(actionKind);
  // Align proposal_id with lifecycleExecInput.
  const permit: M31ActionPermitV2 = {
    ...boundPermit,
    proposal_id: 'm31v2-proposal-lifecycle-comment',
    execution_id: 'm31v2-exec-lifecycle-comment',
    permit_id: 'permit-lifecycle-comment',
  };

  let lastPermitReceipt: M31ExecutionReceiptEventV2 | null = null;
  let lastReservationReceipt: M31ExecutionReceiptEventV2 | null = null;

  const policy: LifecyclePolicyDeps = {
    async evaluateActionPolicy(input) {
      callLog.push('lifecycle:policy');
      return {
        schema_version: 'overseer-injected-action-policy-decision-v1',
        request_digest: sha256hex(canonicalJsonV2(input)),
        policy_digest: POLICY_DIGEST,
        allowed: true,
        denial_reason: null,
      };
    },
  };

  const deps: ExecuteLifecycleActionDepsV1 = {
    policy,
    salvage: {
      async artifactExists() {
        callLog.push('lifecycle:salvage');
        return true;
      },
      async digestPatch() {
        return null;
      },
    },
    async observeLiveTarget() {
      callLog.push('lifecycle:observe');
      return {
        target_digest: TARGET_DIGEST,
        state: 'open',
        policy_digest: POLICY_DIGEST,
        verifier_registry_digest: REGISTRY_DIGEST,
      };
    },
    gate: {
      async preparePermit() {
        callLog.push('lifecycle:prepare');
        lastPermitReceipt = lifecycleReceipt('permit_issued', 1, permit, null);
        return {
          ok: true,
          permit,
          receipt: lastPermitReceipt,
        };
      },
      async authorizeLifecycleAction() {
        callLog.push('lifecycle:authorize');
        return { allowed: true };
      },
      async reserveEffect({ permit: reservedPermit }) {
        callLog.push('lifecycle:reserve');
        const previous = lastPermitReceipt?.event_digest ?? null;
        lastReservationReceipt = lifecycleReceipt('effect_reserved', 2, reservedPermit, previous);
        return {
          ok: true,
          receipt: lastReservationReceipt,
        };
      },
      async recordOutcome({ outcome, evidence, external_effect_reference }) {
        callLog.push(`lifecycle:outcome:${outcome}`);
        const previous =
          lastReservationReceipt?.event_digest ?? lastPermitReceipt?.event_digest ?? null;
        return {
          ok: true as const,
          receipt: lifecycleReceipt(outcome, 3, permit, previous, {
            external_effect_reference: external_effect_reference ?? null,
            evidence: (evidence ?? null) as M31ExecutionReceiptEventV2['evidence'],
            reason: outcome,
            adapter_name: 'fake-lifecycle',
            provider_operation: permit.action_kind,
          }),
        };
      },
    },
    adapter: createLifecycleMutationAdapter({
      allowed_repositories: ['bluedevilcollectibles/bdc-harness'],
      allowed_actions: ['COMMENT'],
      async consume_execution() {
        callLog.push('lifecycle:adapter');
        return true;
      },
    }),
  };

  return { deps, callLog };
}

export function lifecycleExecInput(): ExecuteLifecycleActionInputV1 {
  const candidate: LifecycleCandidateInputV1 = {
    lifecycle_gate_enabled: true,
    evidence_complete: true,
    target: {
      repository: 'bluedevilcollectibles/bdc-harness',
      target_kind: 'pull_request',
      target_key: 'pr:101',
      target_digest: TARGET_DIGEST,
      snapshot_id: 'snapshot-lifecycle-1',
      target: {
        target_kind: 'pull_request',
        repository: 'bluedevilcollectibles/bdc-harness',
        pr_number: 101,
        provider_node_id: 'PR_node_101',
        head_sha: HEAD_SHA,
        base_branch: 'dev',
        base_sha: BASE_SHA,
        state: 'open',
        updated_at: '2026-07-16T00:00:00.000Z',
      },
    },
    action_kind: 'COMMENT',
    action_parameters_digest: PARAMS_DIGEST,
    policy_digest: POLICY_DIGEST,
    verifier_registry_digest: REGISTRY_DIGEST,
    salvage_receipt: null,
    lineage: null,
    reopen_evidence: null,
    verifier: {
      verifier_identity: 'reviewer',
      verifier_provider: 'provider-b',
      verifier_model_family: 'family-b',
      operator_identity: 'builder',
      operator_provider: 'provider-a',
      operator_model_family: 'family-a',
      verdict: 'APPROVE',
      reviewed_target_digest: TARGET_DIGEST,
      reviewed_action_kind: 'COMMENT',
      raw_dissent_recorded: true,
    },
    fusion: null,
    protected_boundaries: [],
    customer_contact: false,
    governance_filing: false,
    resulting_deployment_effect: 'none',
    credential_principal: 'overseer-fixture',
  };
  return {
    candidate,
    proposal_id: 'm31v2-proposal-lifecycle-comment',
    actor: 'overseer-integration',
    correlation_id: 'corr-lifecycle-1',
  };
}

export async function runLifecycleSuccess(harness: LifecycleHarness): Promise<{
  readonly result: Awaited<ReturnType<typeof executeLifecycleAction>>;
  readonly ordered: readonly string[];
}> {
  const result = await executeLifecycleAction(lifecycleExecInput(), harness.deps);
  return { result, ordered: harness.callLog.snapshot() };
}

// ---------------------------------------------------------------------------
// S7 qualified merge
// ---------------------------------------------------------------------------

function prEvidence(overrides: Partial<PullRequestEvidence> = {}): PullRequestEvidence {
  return {
    exists: true,
    state: 'open',
    checks: { total: 2, passed: 2, failed: 0, pending: 0 },
    mergeable: true,
    pr: { owner: 'bluedevilcollectibles', repo: 'bdc-harness', number: 42 },
    prTitle: 'Add feature',
    filesChangedCount: 1,
    diffStat: '+10 -1',
    ...overrides,
  };
}

function record(overrides: Partial<WatchedRunRecord> = {}): WatchedRunRecord {
  return {
    runId: 'run-merge-1',
    woId: 'WO-M42-S8-INTEGRATION',
    owner: 'bluedevilcollectibles',
    repo: 'bdc-harness',
    status: 'failed',
    errorClass: 'tail_node_false_fail',
    action: 'merge_ready',
    reason: 'failed run has green mergeable PR evidence',
    prEvidence: prEvidence(),
    ...overrides,
  };
}

export function mergeEvidence(
  overrides: Partial<QualifiedMergeEvidence> = {}
): QualifiedMergeEvidence {
  const registry = loadMergeRegistry();
  const base: QualifiedMergeEvidence = {
    record: record(),
    registry,
    owner: 'bluedevilcollectibles',
    repository: 'bdc-harness',
    base_branch: 'dev',
    resulting_deployment_effect: 'none',
    credential_principal: 'overseer-fake-merge-principal',
    action_kind: 'MERGE',
    changed_files: ['packages/app/src/index.ts'],
    pr_number: 42,
    head_sha: HEAD_SHA,
    base_sha: BASE_SHA,
    required_checks: [
      { name: 'ci', conclusion: 'success', head_sha: HEAD_SHA },
      { name: 'lint', conclusion: 'success', head_sha: HEAD_SHA },
    ],
    reviews: [{ resolved: true }],
    independent_review: {
      present: true,
      reviewed_head_sha: HEAD_SHA,
      reviewer_identity: 'reviewer-model',
      builder_identity: 'builder-model',
      reviewer_provider: 'openai',
      builder_provider: 'anthropic',
      reviewer_model_family: 'gpt',
      builder_model_family: 'claude',
    },
    operator: {
      identity: 'grok-overseer',
      provider: 'xai',
      model_family: 'grok',
    },
    manifest: { valid: true },
    proposal_id: 'm31v2-proposal-merge-1',
    proposal_present: true,
    fusion: {
      present: true,
      components: ['primary', 'independent'],
      raw_dissent_recorded: true,
      cost_recorded: true,
      verifier_correlated: false,
      hidden_model_substitution: false,
      receipt_digest: FUSION_RECEIPT_DIGEST,
      evidence_digest: FUSION_EVIDENCE_DIGEST,
    },
    expected_verifier_registry_digest: REGISTRY_DIGEST,
    final_state_consistent: true,
  };
  return { ...base, ...overrides, registry: overrides.registry ?? registry };
}

export interface MergeHarness {
  readonly deps: ExecuteQualifiedMergeDeps;
  readonly callLog: ReturnType<typeof createCallLog>;
}

export function makeMergeHarness(
  opts: {
    readonly adapterStatus?: QualifiedMergeAdapterResultV2['status'];
  } = {}
): MergeHarness {
  const callLog = createCallLog();
  const target: M31ActionPermitV2['target'] = {
    target_kind: 'pull_request',
    repository: 'bluedevilcollectibles/bdc-harness',
    pr_number: 42,
    provider_node_id: 'PR_node',
    head_sha: HEAD_SHA,
    base_branch: 'dev',
    base_sha: BASE_SHA,
    state: 'open',
    updated_at: '2026-07-16T12:00:00.000Z',
  };
  const permit: M31ActionPermitV2 = {
    permit_id: 'permit-merge-1',
    proposal_id: 'm31v2-proposal-merge-1',
    execution_id: 'm31v2-exec-merge-1',
    repository: 'bluedevilcollectibles/bdc-harness',
    target,
    target_key: 'bluedevilcollectibles/bdc-harness#pull_request:42',
    target_digest: TARGET_DIGEST,
    snapshot_id: 'snapshot-merge-1',
    action_kind: 'MERGE',
    capability: 'overseer.m31.merge',
    issued_at: '2026-07-16T11:59:00.000Z',
    valid_until: '2026-07-16T12:01:00.000Z',
  };

  const permitReceipt: M31ExecutionReceiptEventV2 = {
    receipt_event_id: 'receipt-permit-merge-1',
    proposal_id: permit.proposal_id,
    execution_id: permit.execution_id,
    event_sequence: 1,
    event_type: 'permit_issued',
    target_kind: 'pull_request',
    target_key: permit.target_key,
    target_digest: permit.target_digest,
    live_observation: null,
    live_observation_digest: null,
    revalidated_at: null,
    valid_until: permit.valid_until,
    adapter_name: null,
    provider_operation: null,
    external_effect_reference: null,
    reason: 'permit_issued',
    evidence: {},
    previous_event_digest: null,
    event_digest: PERMIT_EVENT_DIGEST,
    created_at: '2026-07-16T11:59:00.000Z',
  };

  const reservationReceipt: M31ExecutionReceiptEventV2 = {
    receipt_event_id: 'receipt-reserve-merge-1',
    proposal_id: permit.proposal_id,
    execution_id: permit.execution_id,
    event_sequence: 2,
    event_type: 'effect_reserved',
    target_kind: 'pull_request',
    target_key: permit.target_key,
    target_digest: permit.target_digest,
    live_observation: null,
    live_observation_digest: null,
    revalidated_at: null,
    valid_until: permit.valid_until,
    adapter_name: 'qualified-merge-adapter-v2',
    provider_operation: 'merge',
    external_effect_reference: null,
    reason: 'effect_reserved',
    evidence: {},
    previous_event_digest: PERMIT_EVENT_DIGEST,
    event_digest: RESERVATION_EVENT_DIGEST,
    created_at: '2026-07-16T12:00:00.000Z',
  };

  const authorization: ActionPolicyV2AuthorizationResult = {
    allowed: true,
    reason: 'allowed',
    capability: 'merge',
    repository: 'bluedevilcollectibles/bdc-harness',
    target_kind: 'pull_request',
    target_key: permit.target_key,
    target_digest: permit.target_digest,
    snapshot_id: 'snapshot-merge-1',
    proposal_id: permit.proposal_id,
    execution_id: permit.execution_id,
    action_kind: 'MERGE',
    valid_until: permit.valid_until,
    policy_digest:
      loadMergeRegistry().entries[0]?.policy_digest ??
      'f95589a365b31349ccd499cdc9753f78ab43df74c1e0ab31518528748f496b4e',
    verifier_registry_digest: REGISTRY_DIGEST,
    audit_recorded: true,
  };

  const adapterStatus = opts.adapterStatus ?? 'succeeded';

  const deps: ExecuteQualifiedMergeDeps = {
    async insertOverseerAction() {
      callLog.push('merge:record_action');
    },
    async preparePermit() {
      callLog.push('merge:prepare');
      return { ok: true as const, permit, receipt: permitReceipt };
    },
    async authorize() {
      callLog.push('merge:authorize');
      return authorization;
    },
    async reserveEffect() {
      callLog.push('merge:reserve');
      return { ok: true as const, value: reservationReceipt };
    },
    // Injected Grok judge stub: always approves so the qualified success path
    // reaches the adapter without a live grok CLI call (zero real calls). Assessment
    // -level failure scenarios deny before this gate and never invoke it. Not
    // logged so pre-existing ordered_calls assertions are unchanged.
    async judgeSecondOpinion(judgeEvidence) {
      return {
        schemaVersion: 'overseer-grok-merge-disposition-v1' as const,
        disposition: 'approve' as const,
        reason: 'judge_approve' as const,
        woId: judgeEvidence.woId,
        prNumber: judgeEvidence.prNumber,
        headSha: judgeEvidence.headSha,
        baseSha: judgeEvidence.baseSha,
        evidenceDigest: judgeEvidence.evidenceDigest,
        operator: judgeEvidence.operator,
      };
    },
    mergeAdapter: {
      async attemptMerge() {
        callLog.push('merge:adapter');
        return {
          schema_version: 'overseer-qualified-merge-adapter-result-v2',
          status: adapterStatus,
          reason: adapterStatus === 'succeeded' ? 'simulated_accepted_no_mutation' : adapterStatus,
          external_effect_reference: adapterStatus === 'succeeded' ? 'fake-merge-ref-1' : null,
          evidence_digest: adapterStatus === 'succeeded' ? 'f6'.repeat(32) : null,
        };
      },
    },
    async recordOutcome(input) {
      callLog.push(`merge:outcome:${input.outcome}`);
      return {
        ok: true as const,
        value: {
          receipt_event_id: `receipt-${input.outcome}`,
          proposal_id: permit.proposal_id,
          execution_id: permit.execution_id,
          event_sequence: 3,
          event_type: input.outcome,
          target_kind: 'pull_request' as const,
          target_key: permit.target_key,
          target_digest: permit.target_digest,
          live_observation: null,
          live_observation_digest: null,
          revalidated_at: null,
          valid_until: null,
          adapter_name: 'qualified-merge-adapter-v2',
          provider_operation: 'merge',
          external_effect_reference: null,
          reason: input.reason,
          evidence: {},
          previous_event_digest: RESERVATION_EVENT_DIGEST,
          event_digest: OUTCOME_EVENT_DIGEST,
          created_at: '2026-07-16T12:00:01.000Z',
        },
      };
    },
    async reconcile() {
      callLog.push('merge:reconcile');
    },
  };

  return { deps, callLog };
}

export async function runMergeSuccess(harness: MergeHarness): Promise<{
  readonly result: Awaited<ReturnType<typeof executeQualifiedMerge>>;
  readonly ordered: readonly string[];
  readonly evidence: QualifiedMergeEvidence;
}> {
  const evidence = mergeEvidence();
  const result = await executeQualifiedMerge(evidence, harness.deps);
  return { result, ordered: harness.callLog.snapshot(), evidence };
}

// Re-export executors for scenario module clarity
export {
  assessRepairRefireCandidate,
  executeRepairRefire,
  executeRefreshRebase,
  executeLifecycleAction,
  executeQualifiedMerge,
};
