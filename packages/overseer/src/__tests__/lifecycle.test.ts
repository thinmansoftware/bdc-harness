import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, mock, test } from 'bun:test';
import {
  canonicalJsonV2,
  type M31ActionPermitV2,
  type M31ExecutionReceiptEventV2,
} from '@archon/core/db/m31-target-v2';
import {
  createLifecycleMutationAdapter,
  reconcileLifecycleResult,
  type LifecycleMutationAdapterV1,
} from '../adapters/lifecycle';
import {
  assessLifecycleCandidate,
  buildReopenRecipe,
  executeLifecycleAction,
  verifySalvageArtifact,
  type ExecuteLifecycleActionDepsV1,
  type ExecuteLifecycleActionInputV1,
  type InjectedActionPolicyDepsV1,
  type LifecycleActionKindV1,
  type LifecycleCandidateInputV1,
  type LifecycleGateDepsV1,
  type LifecycleLineageEvidenceV1,
  type LifecycleTargetBindingV1,
  type OverseerSalvageReceiptV1,
  type SalvageArtifactDepsV1,
} from '../actions/lifecycle';

// ---------------------------------------------------------------------------
// Real local-Git fixture helpers. These live in the (unlinted, un-type-checked)
// test file only; the two source files never shell out or import a Git package.
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.com',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.com',
    },
  }).trim();
}

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function sha256hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function initRepoWithCommit(): { repo: string; commit: string } {
  const repo = makeTempDir('lifecycle-repo-');
  git(repo, ['init', '--initial-branch', 'main']);
  git(repo, ['config', 'user.email', 'fixture@example.com']);
  git(repo, ['config', 'user.name', 'Fixture']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  writeFileSync(join(repo, 'file.txt'), 'salvage\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-m', 'salvage']);
  return { repo, commit: git(repo, ['rev-parse', 'HEAD']) };
}

function gitSalvageDeps(): SalvageArtifactDepsV1 {
  return {
    async artifactExists({ worktree_path, artifact_kind, git_object_id, patch_path }) {
      if (artifact_kind === 'git_object') {
        try {
          execFileSync('git', ['cat-file', '-e', `${git_object_id}^{object}`], {
            cwd: worktree_path,
            stdio: 'ignore',
          });
          return true;
        } catch {
          return false;
        }
      }
      if (!patch_path) return false;
      return existsSync(join(worktree_path, patch_path));
    },
    async digestPatch({ worktree_path, patch_path }) {
      try {
        const content = readFileSync(join(worktree_path, patch_path));
        return createHash('sha256').update(content).digest('hex');
      } catch {
        return null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Shared lifecycle fixtures.
// ---------------------------------------------------------------------------

const DIGEST_A = sha256hex('target-a');
const DIGEST_B = sha256hex('target-b');
const POLICY_DIGEST = sha256hex('policy');
const REGISTRY_DIGEST = sha256hex('registry');
const PARAMS_DIGEST = sha256hex('params');

function targetBinding(
  overrides: Partial<LifecycleTargetBindingV1> = {}
): LifecycleTargetBindingV1 {
  return {
    repository: 'thinmansoftware/bdc-harness',
    target_kind: 'pull_request',
    target_key: 'pr:101',
    target_digest: DIGEST_A,
    snapshot_id: 'snapshot-1',
    target: {
      target_kind: 'pull_request',
      repository: 'thinmansoftware/bdc-harness',
      pr_number: 101,
      provider_node_id: 'PR_node_101',
      head_sha: 'a'.repeat(40),
      base_branch: 'dev',
      base_sha: 'b'.repeat(40),
      state: 'open',
      updated_at: '2026-07-16T00:00:00.000Z',
    },
    ...overrides,
  };
}

function lineage(overrides: Partial<LifecycleLineageEvidenceV1> = {}): LifecycleLineageEvidenceV1 {
  return {
    kind: 'duplicate',
    predecessor_target_key: 'pr:100',
    successor_target_key: 'pr:101',
    predecessor_digest: DIGEST_B,
    successor_digest: DIGEST_A,
    exact_match: true,
    uncertain: false,
    ...overrides,
  };
}

function salvage(overrides: Partial<OverseerSalvageReceiptV1> = {}): OverseerSalvageReceiptV1 {
  return {
    schema_version: 'overseer-salvage-receipt-v1',
    repository: 'thinmansoftware/bdc-harness',
    wo_id: 'WO-TEST-LIFECYCLE',
    source_target_kind: 'pull_request',
    source_target_key: 'pr:100',
    source_target_digest: DIGEST_B,
    source_run_id: null,
    worktree_path: '/tmp/lifecycle',
    artifact_kind: 'git_object',
    git_object_format: 'sha1',
    git_object_id: 'a'.repeat(40),
    patch_path: null,
    patch_sha256: null,
    scope_digest: sha256hex('scope'),
    captured_at: '2026-07-16T00:00:00.000Z',
    verified_at: '2026-07-16T00:00:01.000Z',
    ...overrides,
  };
}

function candidate(
  action_kind: LifecycleCandidateInputV1['action_kind'],
  overrides: Partial<LifecycleCandidateInputV1> = {}
): LifecycleCandidateInputV1 {
  return {
    lifecycle_gate_enabled: true,
    evidence_complete: true,
    target: targetBinding(),
    action_kind,
    action_parameters_digest: PARAMS_DIGEST,
    policy_digest: POLICY_DIGEST,
    verifier_registry_digest: REGISTRY_DIGEST,
    salvage_receipt: action_kind === 'CLOSE' ? salvage() : null,
    lineage: action_kind === 'CLOSE' ? lineage() : null,
    reopen_evidence:
      action_kind === 'REOPEN'
        ? {
            close_proposal_id: 'proposal-close-1',
            close_execution_id: 'exec-close-1',
            false_observation_digest: sha256hex('false-close'),
            proven_false: true,
            protected_boundary_clear: true,
          }
        : null,
    verifier: {
      verifier_identity: 'reviewer',
      verifier_provider: 'provider-b',
      verifier_model_family: 'family-b',
      operator_identity: 'builder',
      operator_provider: 'provider-a',
      operator_model_family: 'family-a',
      verdict: 'APPROVE',
      reviewed_target_digest: DIGEST_A,
      reviewed_action_kind: action_kind === 'READ_ONLY' ? 'COMMENT' : action_kind,
      raw_dissent_recorded: true,
    },
    fusion: { required: true, present: true, receipt_digest: sha256hex('fusion') },
    protected_boundaries: [],
    customer_contact: false,
    governance_filing: false,
    resulting_deployment_effect: 'none',
    credential_principal: 'overseer-fixture',
    ...overrides,
  };
}

function eligiblePolicy(): InjectedActionPolicyDepsV1 {
  return {
    async evaluateActionPolicy(input) {
      return {
        schema_version: 'overseer-injected-action-policy-decision-v1',
        request_digest: sha256hex(canonicalJsonV2(input)),
        policy_digest: POLICY_DIGEST,
        allowed: true,
        denial_reason: null,
      };
    },
  };
}

function permit(
  actionKind: LifecycleActionKindV1,
  proposalId = `proposal-${actionKind.toLowerCase()}`
): M31ActionPermitV2 {
  return {
    permit_id: `permit-${proposalId}`,
    proposal_id: proposalId,
    execution_id: `exec-${proposalId}`,
    repository: 'thinmansoftware/bdc-harness',
    target: targetBinding().target,
    target_key: 'pr:101',
    target_digest: DIGEST_A,
    snapshot_id: 'snapshot-1',
    action_kind: actionKind,
    capability: `overseer.m31.${actionKind.toLowerCase()}`,
    issued_at: '2026-07-16T00:00:00.000Z',
    valid_until: '2026-07-16T00:10:00.000Z',
  };
}

function receipt(
  eventType: M31ExecutionReceiptEventV2['event_type'],
  sequence: number,
  boundPermit: M31ActionPermitV2,
  previousEventDigest: string | null,
  overrides: Partial<M31ExecutionReceiptEventV2> = {}
): M31ExecutionReceiptEventV2 {
  const event = {
    receipt_event_id:
      eventType === 'permit_issued' ? boundPermit.permit_id : `receipt-${eventType}-${sequence}`,
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
    previous_event_digest: previousEventDigest,
    created_at: '2026-07-16T00:00:00.000Z',
    ...overrides,
  };
  return { ...event, event_digest: sha256hex(canonicalJsonV2(event)) };
}

function makeGate(
  order: string[],
  opts: {
    prepareDenied?: string;
    authDenied?: string;
    reserveFailure?: string;
    recordFailure?: string;
    permitAction?: LifecycleActionKindV1;
  } = {}
): LifecycleGateDepsV1 {
  return {
    async preparePermit({ proposal_id }) {
      order.push('prepare');
      if (opts.prepareDenied) return { ok: false, denied: opts.prepareDenied };
      const boundPermit = permit(opts.permitAction ?? 'CLOSE', proposal_id);
      return {
        ok: true,
        permit: boundPermit,
        receipt: receipt('permit_issued', 1, boundPermit, null),
      };
    },
    async authorizeLifecycleAction() {
      order.push('authorize');
      if (opts.authDenied) return { allowed: false, reason: opts.authDenied };
      return { allowed: true };
    },
    async reserveEffect({ permit: boundPermit }) {
      order.push('reserve');
      if (opts.reserveFailure) return { ok: false, failure: opts.reserveFailure as never };
      const permitReceipt = receipt('permit_issued', 1, boundPermit, null);
      return {
        ok: true,
        receipt: receipt('effect_reserved', 2, boundPermit, permitReceipt.event_digest),
      };
    },
    async recordOutcome({ execution_id, outcome, evidence, external_effect_reference }) {
      order.push(`outcome:${outcome}`);
      if (opts.recordFailure) return { ok: false, failure: opts.recordFailure as never };
      const actionKind = opts.permitAction ?? 'CLOSE';
      const boundPermit = permit(actionKind, execution_id.replace(/^exec-/, ''));
      const permitReceipt = receipt('permit_issued', 1, boundPermit, null);
      const reservationReceipt = receipt(
        'effect_reserved',
        2,
        boundPermit,
        permitReceipt.event_digest
      );
      return {
        ok: true,
        receipt: receipt(outcome, 3, boundPermit, reservationReceipt.event_digest, {
          external_effect_reference: external_effect_reference ?? null,
          evidence,
        }),
      };
    },
  };
}

function makeDeps(
  adapter: LifecycleMutationAdapterV1,
  order: string[],
  opts: {
    liveDigest?: string;
    policy?: InjectedActionPolicyDepsV1;
    gate?: LifecycleGateDepsV1;
    permitAction?: LifecycleActionKindV1;
    observeError?: Error;
  } = {}
): ExecuteLifecycleActionDepsV1 {
  return {
    policy: opts.policy ?? eligiblePolicy(),
    salvage: {
      async artifactExists() {
        order.push('salvage');
        return true;
      },
      async digestPatch() {
        return null;
      },
    },
    async observeLiveTarget() {
      order.push('observe');
      if (opts.observeError) throw opts.observeError;
      return {
        target_digest: opts.liveDigest ?? DIGEST_A,
        state: 'open',
        policy_digest: POLICY_DIGEST,
        verifier_registry_digest: REGISTRY_DIGEST,
      };
    },
    gate: opts.gate ?? makeGate(order, { permitAction: opts.permitAction }),
    adapter,
  };
}

function execInput(action_kind: LifecycleActionKindV1): ExecuteLifecycleActionInputV1 {
  return {
    candidate: candidate(action_kind),
    proposal_id: `proposal-${action_kind.toLowerCase()}`,
    actor: 'overseer',
    correlation_id: `corr-${action_kind.toLowerCase()}`,
  };
}

describe('lifecycle assessment', () => {
  test('age-only close denied before permit and adapter', async () => {
    const order: string[] = [];
    const adapter = { perform: mock(async () => undefined as never) };
    const result = await executeLifecycleAction(
      {
        ...execInput('CLOSE'),
        candidate: candidate('CLOSE', { lineage: null }),
      },
      makeDeps(adapter, order)
    );
    expect(result.outcome).toBe('denied');
    expect(result.reason).toBe('exact_lineage_required');
    expect(order).toEqual([]);
    expect(adapter.perform).toHaveBeenCalledTimes(0);
  });

  test('customer and governance content denied at assessment', () => {
    expect(
      assessLifecycleCandidate(candidate('COMMENT', { customer_contact: true }))
    ).toMatchObject({ disposition: 'denied', reason: 'protected_boundary' });
    expect(
      assessLifecycleCandidate(candidate('COMMENT', { governance_filing: true }))
    ).toMatchObject({ disposition: 'denied', reason: 'protected_boundary' });
  });
});

describe('lifecycle execution', () => {
  test('permit action mismatch cannot execute a different lifecycle action', async () => {
    const order: string[] = [];
    const adapter = { perform: mock(async () => undefined as never) };
    const result = await executeLifecycleAction(
      execInput('COMMENT'),
      makeDeps(adapter, order, { permitAction: 'CLOSE' })
    );

    expect(result).toMatchObject({ outcome: 'denied', reason: 'permit_action_mismatch' });
    expect(order).toEqual(['prepare']);
    expect(adapter.perform).toHaveBeenCalledTimes(0);
  });

  test('policy request digest is derived from exact permit and action parameters', async () => {
    const order: string[] = [];
    const requests: unknown[] = [];
    const adapter = createLifecycleMutationAdapter({
      allowed_repositories: ['thinmansoftware/bdc-harness'],
      allowed_actions: ['COMMENT'],
      async consume_execution() {
        return true;
      },
    });
    const policy: InjectedActionPolicyDepsV1 = {
      async evaluateActionPolicy(request) {
        requests.push(request);
        return {
          schema_version: 'overseer-injected-action-policy-decision-v1',
          request_digest: sha256hex(canonicalJsonV2(request)),
          policy_digest: POLICY_DIGEST,
          allowed: true,
          denial_reason: null,
        };
      },
    };

    const result = await executeLifecycleAction(
      execInput('COMMENT'),
      makeDeps(adapter, order, { permitAction: 'COMMENT', policy })
    );

    expect(result.outcome).toBe('succeeded');
    expect(requests).toEqual([
      {
        schema_version: 'overseer-injected-action-policy-request-v1',
        proposal_id: 'proposal-comment',
        execution_id: 'exec-proposal-comment',
        repository: 'thinmansoftware/bdc-harness',
        target_kind: 'pull_request',
        target_key: 'pr:101',
        target_digest: DIGEST_A,
        action_kind: 'COMMENT',
        capability: 'lifecycle',
        action_parameters_digest: PARAMS_DIGEST,
        resulting_deployment_effect: 'none',
        credential_principal: 'overseer-fixture',
      },
    ]);
    expect(order).toEqual([
      'prepare',
      'authorize',
      'reserve',
      'observe',
      'outcome:effect_succeeded',
    ]);
    expect(result.receipts[1]).toMatchObject({
      target_key: 'pr:101',
      target_digest: DIGEST_A,
      provider_operation: 'COMMENT',
    });
    expect(result.receipts[2]?.evidence).toMatchObject({
      action_kind: 'COMMENT',
      action_parameters_digest: PARAMS_DIGEST,
    });
  });

  test('verified duplicate close preserves membership evidence and emits one result receipt', async () => {
    const order: string[] = [];
    const adapter = createLifecycleMutationAdapter({
      allowed_repositories: ['thinmansoftware/bdc-harness'],
      allowed_actions: ['CLOSE'],
      async consume_execution() {
        order.push('adapter');
        return true;
      },
    });
    const result = await executeLifecycleAction(execInput('CLOSE'), makeDeps(adapter, order));
    expect(result.outcome).toBe('succeeded');
    expect(result.receipt_types).toEqual(['permit_issued', 'effect_reserved', 'effect_succeeded']);
    expect(order).toEqual([
      'salvage',
      'prepare',
      'authorize',
      'reserve',
      'observe',
      'adapter',
      'outcome:effect_succeeded',
    ]);

    const boundPermit = permit('CLOSE');
    const permitReceipt = receipt('permit_issued', 1, boundPermit, null);
    const reservationReceipt = receipt(
      'effect_reserved',
      2,
      boundPermit,
      permitReceipt.event_digest
    );
    const reconciliationMutation = {
      adapter: 'fake-lifecycle',
      accepted: true,
      reason: 'simulated_accepted_no_mutation',
      mutation_sent: false,
      external_effect_reference: result.external_effect_reference,
      permit_id: boundPermit.permit_id,
      execution_id: boundPermit.execution_id,
      repository: 'thinmansoftware/bdc-harness',
      target_kind: 'pull_request',
      target_key: 'pr:101',
      target_digest: DIGEST_A,
      action_kind: 'CLOSE',
      action_parameters_digest: PARAMS_DIGEST,
    } as const;
    const outcomeReceipt = receipt(
      'effect_succeeded',
      3,
      boundPermit,
      reservationReceipt.event_digest,
      {
        external_effect_reference: result.external_effect_reference,
        evidence: reconciliationMutation,
      }
    );
    const reconciled = reconcileLifecycleResult({
      snapshot_id: 'snapshot-1',
      original_member_target_key: 'pr:100',
      wo_id: 'WO-TEST-LIFECYCLE',
      issue_or_pr_key: 'pr:101',
      run_id: 'run-1',
      card_id: 'card-1',
      permit: boundPermit,
      permit_receipt: permitReceipt,
      reservation_receipt: reservationReceipt,
      outcome_receipt: outcomeReceipt,
      mutation: reconciliationMutation,
      existing_lineage: [
        {
          predecessor_target_key: 'pr:100',
          successor_target_key: 'pr:101',
          evidence_digest: sha256hex('existing'),
        },
      ],
      new_lineage: [
        {
          predecessor_target_key: 'pr:100',
          successor_target_key: 'pr:101',
          evidence_digest: sha256hex('new'),
        },
      ],
    });
    expect(reconciled.preserved_member_target_key).toBe('pr:100');
    expect(reconciled.membership_collapsed).toBe(false);
    expect(reconciled.lineage).toHaveLength(2);
  });

  test('mistaken close reopens same fake target and links corrective evidence', async () => {
    const order: string[] = [];
    const adapter = createLifecycleMutationAdapter({
      allowed_repositories: ['thinmansoftware/bdc-harness'],
      allowed_actions: ['REOPEN'],
      async consume_execution() {
        order.push('adapter');
        return true;
      },
    });
    const result = await executeLifecycleAction(
      execInput('REOPEN'),
      makeDeps(adapter, order, { permitAction: 'REOPEN' })
    );
    expect(result.outcome).toBe('succeeded');
    expect(result.action_kind).toBe('REOPEN');
    expect(candidate('REOPEN').reopen_evidence).toMatchObject({
      close_proposal_id: 'proposal-close-1',
      proven_false: true,
    });
  });

  test('comment label and assign execute through one allowlisted fake mutation each', async () => {
    for (const action of ['COMMENT', 'LABEL', 'ASSIGN'] as const) {
      const adapter = createLifecycleMutationAdapter({
        allowed_repositories: ['thinmansoftware/bdc-harness'],
        allowed_actions: [action],
        async consume_execution() {
          return true;
        },
      });
      const order: string[] = [];
      const result = await executeLifecycleAction(
        execInput(action),
        makeDeps(adapter, order, { permitAction: action })
      );
      expect(result.outcome).toBe('succeeded');
      expect(result.action_kind).toBe(action);
    }
  });

  test('self-review stale evidence and policy drift fail closed before adapter invocation', async () => {
    const adapter = { perform: mock(async () => undefined as never) };
    const selfReview = await executeLifecycleAction(
      {
        ...execInput('COMMENT'),
        candidate: candidate('COMMENT', {
          verifier: {
            ...candidate('COMMENT').verifier!,
            verifier_identity: 'builder',
          },
        }),
      },
      makeDeps(adapter, [])
    );
    expect(selfReview.outcome).toBe('denied');

    const driftOrder: string[] = [];
    const liveDrift = await executeLifecycleAction(
      execInput('COMMENT'),
      makeDeps(adapter, driftOrder, { liveDigest: DIGEST_B, permitAction: 'COMMENT' })
    );
    expect(liveDrift.outcome).toBe('live_state_mismatch');
    expect(adapter.perform).toHaveBeenCalledTimes(0);

    const policyDrift = await executeLifecycleAction(
      execInput('COMMENT'),
      makeDeps(adapter, [], {
        permitAction: 'COMMENT',
        policy: {
          async evaluateActionPolicy(request) {
            return {
              schema_version: 'overseer-injected-action-policy-decision-v1',
              request_digest: sha256hex(canonicalJsonV2(request)),
              policy_digest: sha256hex('stale'),
              allowed: true,
              denial_reason: null,
            };
          },
        },
      })
    );
    expect(policyDrift.outcome).toBe('denied');
    expect(adapter.perform).toHaveBeenCalledTimes(0);
  });

  test('reconciliation rejects receipts or mutation not bound to the execution chain', () => {
    const boundPermit = permit('COMMENT');
    const permitReceipt = receipt('permit_issued', 1, boundPermit, null);
    const reservationReceipt = receipt(
      'effect_reserved',
      2,
      boundPermit,
      permitReceipt.event_digest
    );
    const externalReference = 'fake://comment';
    const mutation = {
      adapter: 'fake-lifecycle' as const,
      accepted: true,
      reason: 'simulated_accepted_no_mutation' as const,
      mutation_sent: false as const,
      external_effect_reference: externalReference,
      permit_id: boundPermit.permit_id,
      execution_id: boundPermit.execution_id,
      repository: boundPermit.repository,
      target_kind: boundPermit.target.target_kind as 'pull_request',
      target_key: boundPermit.target_key,
      target_digest: boundPermit.target_digest,
      action_kind: 'COMMENT' as const,
      action_parameters_digest: PARAMS_DIGEST,
    };
    const outcomeReceipt = receipt(
      'effect_succeeded',
      3,
      boundPermit,
      reservationReceipt.event_digest,
      { external_effect_reference: externalReference, evidence: mutation }
    );
    const base = {
      snapshot_id: boundPermit.snapshot_id,
      original_member_target_key: 'pr:100',
      wo_id: 'WO-TEST-LIFECYCLE',
      issue_or_pr_key: boundPermit.target_key,
      run_id: 'run-1',
      card_id: 'card-1',
      permit: boundPermit,
      permit_receipt: permitReceipt,
      reservation_receipt: reservationReceipt,
      outcome_receipt: outcomeReceipt,
      mutation,
      existing_lineage: [] as const,
      new_lineage: [] as const,
    };

    expect(() =>
      reconcileLifecycleResult({
        ...base,
        mutation: { ...base.mutation, action_kind: 'LABEL' },
      })
    ).toThrow('lifecycle_reconciliation_action_mismatch');
    expect(() =>
      reconcileLifecycleResult({
        ...base,
        outcome_receipt: receipt('effect_succeeded', 3, boundPermit, DIGEST_B, {
          external_effect_reference: externalReference,
          evidence: mutation,
        }),
      })
    ).toThrow('lifecycle_reconciliation_receipt_chain_mismatch');
  });

  test('post reservation rejection throw and invalid response record terminal outcomes', async () => {
    const scenarios: readonly {
      readonly name: string;
      readonly adapter: LifecycleMutationAdapterV1;
      readonly expectedReceipt: 'effect_failed' | 'effect_indeterminate';
      readonly observeError?: Error;
    }[] = [
      {
        name: 'rejection',
        adapter: {
          async perform(request) {
            return {
              ...request,
              adapter: 'fake-lifecycle',
              accepted: false,
              reason: 'execution_replayed',
              mutation_sent: false,
              external_effect_reference: null,
            };
          },
        },
        expectedReceipt: 'effect_failed',
      },
      {
        name: 'throw',
        adapter: {
          async perform() {
            throw new Error('adapter exploded');
          },
        },
        expectedReceipt: 'effect_indeterminate',
      },
      {
        name: 'invalid response',
        adapter: {
          async perform(request) {
            return { ...request, action_kind: 'CLOSE', accepted: true } as never;
          },
        },
        expectedReceipt: 'effect_indeterminate',
      },
      {
        name: 'live observation exception',
        adapter: { perform: mock(async () => undefined as never) },
        observeError: new Error('observation exploded'),
        expectedReceipt: 'effect_indeterminate',
      },
    ];

    for (const scenario of scenarios) {
      const order: string[] = [];
      const result = await executeLifecycleAction(
        execInput('COMMENT'),
        makeDeps(scenario.adapter, order, {
          permitAction: 'COMMENT',
          observeError: scenario.observeError,
        })
      );
      expect(result.outcome, scenario.name).not.toBe('succeeded');
      expect(
        order.filter(item => item.startsWith('outcome:')),
        scenario.name
      ).toEqual([`outcome:${scenario.expectedReceipt}`]);
      expect(result.receipt_types.at(-1), scenario.name).toBe(scenario.expectedReceipt);
    }

    const persistenceOrder: string[] = [];
    const acceptedAdapter = createLifecycleMutationAdapter({
      allowed_repositories: ['thinmansoftware/bdc-harness'],
      allowed_actions: ['COMMENT'],
      async consume_execution() {
        return true;
      },
    });
    const persistenceFailure = await executeLifecycleAction(
      execInput('COMMENT'),
      makeDeps(acceptedAdapter, persistenceOrder, {
        permitAction: 'COMMENT',
        gate: makeGate(persistenceOrder, {
          permitAction: 'COMMENT',
          recordFailure: 'evidence_conflicting',
        }),
      })
    );
    expect(persistenceFailure.outcome).toBe('outcome_record_failed');
    expect(persistenceFailure.receipt_types).not.toContain('effect_succeeded');
  });

  test('terminal success receipt must bind exact mutation evidence and reference', async () => {
    const order: string[] = [];
    const baseGate = makeGate(order, { permitAction: 'COMMENT' });
    const gate: LifecycleGateDepsV1 = {
      ...baseGate,
      async recordOutcome(request) {
        order.push(`outcome:${request.outcome}`);
        const boundPermit = permit('COMMENT');
        const permitReceipt = receipt('permit_issued', 1, boundPermit, null);
        const reservationReceipt = receipt(
          'effect_reserved',
          2,
          boundPermit,
          permitReceipt.event_digest
        );
        return {
          ok: true,
          receipt: receipt(request.outcome, 3, boundPermit, reservationReceipt.event_digest, {
            evidence: { forged: true },
            external_effect_reference: 'fake-lifecycle://forged',
          }),
        };
      },
    };
    const adapter = createLifecycleMutationAdapter({
      allowed_repositories: ['thinmansoftware/bdc-harness'],
      allowed_actions: ['COMMENT'],
      async consume_execution() {
        return true;
      },
    });

    const result = await executeLifecycleAction(
      execInput('COMMENT'),
      makeDeps(adapter, order, { permitAction: 'COMMENT', gate })
    );

    expect(result.outcome).toBe('outcome_record_failed');
    expect(result.receipt_types).not.toContain('effect_succeeded');
    expect(result.external_effect_reference).toBeNull();
  });

  test('invalid reservation uncertainty receipt must bind returned reservation digest', async () => {
    const order: string[] = [];
    const boundPermit = permit('COMMENT');
    const permitReceipt = receipt('permit_issued', 1, boundPermit, null);
    const invalidReservationReceipt = receipt(
      'effect_reserved',
      2,
      boundPermit,
      permitReceipt.event_digest,
      { provider_operation: 'CLOSE' }
    );
    const gate: LifecycleGateDepsV1 = {
      ...makeGate(order, { permitAction: 'COMMENT' }),
      async reserveEffect() {
        order.push('reserve');
        return { receipt: invalidReservationReceipt } as never;
      },
      async recordOutcome(request) {
        order.push(`outcome:${request.outcome}`);
        return {
          ok: true,
          receipt: receipt('effect_indeterminate', 3, boundPermit, DIGEST_B, {
            evidence: request.evidence,
            external_effect_reference: null,
          }),
        };
      },
    };

    const result = await executeLifecycleAction(
      execInput('COMMENT'),
      makeDeps({ perform: mock(async () => undefined as never) }, order, {
        permitAction: 'COMMENT',
        gate,
      })
    );

    expect(order.filter(item => item.startsWith('outcome:'))).toEqual([
      'outcome:effect_indeterminate',
    ]);
    expect(result.outcome).toBe('outcome_record_failed');
    expect(result.receipt_types).not.toContain('effect_indeterminate');
  });
});

describe('salvage verification and floors', () => {
  test('salvage and lineage remain append only', async () => {
    const { repo, commit } = initRepoWithCommit();
    const validGit = salvage({ worktree_path: repo, git_object_id: commit });
    expect(await verifySalvageArtifact(validGit, gitSalvageDeps())).toMatchObject({ ok: true });

    const missingGit = salvage({ worktree_path: repo, git_object_id: 'f'.repeat(40) });
    expect(await verifySalvageArtifact(missingGit, gitSalvageDeps())).toMatchObject({
      ok: false,
      reason: 'git_object_missing',
    });

    writeFileSync(join(repo, 'salvage.patch'), 'patch-content\n');
    const validPatch = salvage({
      worktree_path: repo,
      artifact_kind: 'patch',
      git_object_format: null,
      git_object_id: null,
      patch_path: 'salvage.patch',
      patch_sha256: sha256hex('patch-content\n'),
    });
    expect(await verifySalvageArtifact(validPatch, gitSalvageDeps())).toMatchObject({ ok: true });
    expect(
      await verifySalvageArtifact(
        { ...validPatch, patch_sha256: sha256hex('corrupt') },
        gitSalvageDeps()
      )
    ).toMatchObject({ ok: false, reason: 'patch_digest_mismatch' });

    const recipe = buildReopenRecipe({
      target: targetBinding(),
      close_proposal_id: 'proposal-close-1',
      close_execution_id: 'exec-close-1',
      required_observation_digest: DIGEST_A,
      action_parameters_digest: PARAMS_DIGEST,
    });
    expect(recipe.inverse_provider_action).toBe('REOPEN');
    const boundPermit = permit('CLOSE');
    const permitReceipt = receipt('permit_issued', 1, boundPermit, null);
    const reservationReceipt = receipt(
      'effect_reserved',
      2,
      boundPermit,
      permitReceipt.event_digest
    );
    const reconciliationMutation = {
      adapter: 'fake-lifecycle',
      accepted: true,
      reason: 'simulated_accepted_no_mutation',
      mutation_sent: false,
      external_effect_reference: 'fake://close',
      permit_id: boundPermit.permit_id,
      execution_id: boundPermit.execution_id,
      repository: 'thinmansoftware/bdc-harness',
      target_kind: 'pull_request',
      target_key: 'pr:101',
      target_digest: DIGEST_A,
      action_kind: 'CLOSE',
      action_parameters_digest: PARAMS_DIGEST,
    } as const;
    const outcomeReceipt = receipt(
      'effect_succeeded',
      3,
      boundPermit,
      reservationReceipt.event_digest,
      { external_effect_reference: 'fake://close', evidence: reconciliationMutation }
    );
    const reconciled = reconcileLifecycleResult({
      snapshot_id: 'snapshot-1',
      original_member_target_key: 'pr:100',
      wo_id: 'WO-TEST-LIFECYCLE',
      issue_or_pr_key: 'pr:101',
      run_id: 'run-1',
      card_id: 'card-1',
      permit: boundPermit,
      permit_receipt: permitReceipt,
      reservation_receipt: reservationReceipt,
      outcome_receipt: outcomeReceipt,
      mutation: reconciliationMutation,
      existing_lineage: [
        {
          predecessor_target_key: 'pr:100',
          successor_target_key: 'pr:101',
          evidence_digest: sha256hex('predecessor'),
        },
      ],
      new_lineage: [
        {
          predecessor_target_key: 'pr:100',
          successor_target_key: 'pr:101',
          evidence_digest: sha256hex('successor'),
        },
      ],
    });
    expect(reconciled.lineage.map(item => item.evidence_digest)).toEqual([
      sha256hex('predecessor'),
      sha256hex('successor'),
    ]);

    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test('Fusion and verifier floors fail closed', async () => {
    const deniedCases: LifecycleCandidateInputV1[] = [
      candidate('CLOSE', { fusion: { required: true, present: false, receipt_digest: null } }),
      candidate('CLOSE', {
        verifier: {
          ...candidate('CLOSE').verifier!,
          verifier_provider: 'provider-a',
        },
      }),
      candidate('CLOSE', {
        verifier: {
          ...candidate('CLOSE').verifier!,
          raw_dissent_recorded: false,
        },
      }),
      candidate('REOPEN', {
        reopen_evidence: {
          close_proposal_id: 'proposal-close-1',
          close_execution_id: 'exec-close-1',
          false_observation_digest: sha256hex('false-close'),
          proven_false: false,
          protected_boundary_clear: true,
        },
      }),
    ];

    for (const denied of deniedCases) {
      const adapter = { perform: mock(async () => undefined as never) };
      const result = await executeLifecycleAction(
        {
          candidate: denied,
          proposal_id: 'proposal-denied',
          actor: 'overseer',
          correlation_id: 'corr-denied',
        },
        makeDeps(adapter, [])
      );
      expect(result.outcome).toBe('denied');
      expect(adapter.perform).toHaveBeenCalledTimes(0);
    }
  });
});
