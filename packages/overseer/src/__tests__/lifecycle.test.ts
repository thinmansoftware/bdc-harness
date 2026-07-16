import { describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import type { M31ActionPermitV2 } from '@archon/core/db/m31-target-v2';
import {
  assessLifecycleCandidate,
  buildReopenRecipe,
  executeLifecycleAction,
  verifySalvageArtifact,
  type InjectedActionPolicyDecisionV1,
  type InjectedActionPolicyDepsV1,
  type InjectedActionPolicyRequestV1,
  type LifecycleActionKind,
  type LifecycleAssessmentInput,
  type LifecycleExecutionDeps,
  type LifecycleExecutionInput,
  type LifecycleMutationAdapter,
  type LifecycleMutationReceipt,
  type LifecycleMutationRequest,
  type OverseerReopenRecipeV1,
  type OverseerSalvageReceiptV1,
  type ReconcileLifecycleInput,
  type SalvageVerificationDeps,
} from '../actions/lifecycle';
import { createLifecycleMutationAdapter, reconcileLifecycleResult } from '../adapters/lifecycle';

const H = (value: string): string => createHash('sha256').update(value).digest('hex');

const REPO = 'org/repo';
const TARGET_KEY = 'issue:org/repo#42';
const TARGET_DIGEST = H('issue-42');
const POLICY_DIGEST = H('policy');
const EXPECTED_REQ_DIGEST = H('request');
const ACTION_PARAMS_DIGEST = H('action-params');

const issueTarget = {
  target_kind: 'issue' as const,
  repository: REPO,
  issue_number: 42,
  provider_node_id: 'I_kwDO1',
  state: 'open',
  updated_at: '2026-07-16T12:00:00.000Z',
  is_pull_request: false as const,
};

function permitFor(action_kind: LifecycleActionKind): M31ActionPermitV2 {
  return {
    permit_id: 'permit-1',
    proposal_id: 'proposal-1',
    execution_id: 'exec-1',
    repository: REPO,
    target: issueTarget,
    target_key: TARGET_KEY,
    target_digest: TARGET_DIGEST,
    snapshot_id: 'snap-1',
    action_kind,
    capability: `overseer.m31.${action_kind.toLowerCase()}`,
    issued_at: '2026-07-16T12:00:00.000Z',
    valid_until: '2026-07-16T12:05:00.000Z',
  };
}

function mutationRequestFor(action_kind: LifecycleActionKind): LifecycleMutationRequest {
  return {
    permit_id: 'permit-1',
    repository: REPO,
    action_kind,
    target_kind: 'issue',
    target_key: TARGET_KEY,
    target_digest: TARGET_DIGEST,
    snapshot_id: 'snap-1',
    proposal_id: 'proposal-1',
    execution_id: 'exec-1',
    action_parameters_digest: ACTION_PARAMS_DIGEST,
  };
}

function policyRequestFor(
  action_kind: InjectedActionPolicyRequestV1['action_kind'],
  effect: InjectedActionPolicyRequestV1['resulting_deployment_effect'] = 'none'
): InjectedActionPolicyRequestV1 {
  return {
    schema_version: 'overseer-injected-action-policy-request-v1',
    proposal_id: 'proposal-1',
    execution_id: 'exec-1',
    repository: REPO,
    target_kind: 'issue',
    target_key: TARGET_KEY,
    target_digest: TARGET_DIGEST,
    action_kind,
    capability: 'lifecycle',
    action_parameters_digest: ACTION_PARAMS_DIGEST,
    resulting_deployment_effect: effect,
    credential_principal: 'overseer-bot',
  };
}

function policyDeps(
  over: Partial<InjectedActionPolicyDecisionV1> = {}
): InjectedActionPolicyDepsV1 {
  return {
    async evaluateActionPolicy(): Promise<InjectedActionPolicyDecisionV1> {
      return {
        schema_version: 'overseer-injected-action-policy-decision-v1',
        request_digest: over.request_digest ?? EXPECTED_REQ_DIGEST,
        policy_digest: over.policy_digest ?? POLICY_DIGEST,
        allowed: over.allowed ?? true,
        denial_reason: over.denial_reason ?? null,
      };
    },
  };
}

const salvageGitObject: OverseerSalvageReceiptV1 = {
  schema_version: 'overseer-salvage-receipt-v1',
  repository: REPO,
  wo_id: 'WO-1',
  source_target_kind: 'work_order',
  source_target_key: 'wo:WO-1',
  source_target_digest: H('source-target'),
  source_run_id: null,
  worktree_path: '/wt/thread-x',
  artifact_kind: 'git_object',
  git_object_format: 'sha1',
  git_object_id: 'a'.repeat(40),
  patch_path: null,
  patch_sha256: null,
  scope_digest: H('scope'),
  captured_at: '2026-07-16T12:00:00.000Z',
  verified_at: '2026-07-16T12:00:01.000Z',
};

const reopenRecipe: OverseerReopenRecipeV1 = buildReopenRecipe({
  repository: REPO,
  target: {
    target_kind: 'issue',
    repository: REPO,
    target_key: TARGET_KEY,
    target_digest: TARGET_DIGEST,
  },
  prior_close_proposal_id: 'close-proposal-1',
  required_observation_digest: H('observation'),
});

const salvageOk: SalvageVerificationDeps = {
  async gitObjectExists(): Promise<boolean> {
    return true;
  },
  async readPatchSha256(): Promise<string | null> {
    return null;
  },
};

const verifyOwned = async (): Promise<{ owned: true }> => ({ owned: true });

function dummyReceipt(action_kind: LifecycleActionKind): LifecycleMutationReceipt {
  return {
    adapter: 'fake-lifecycle',
    accepted: true,
    reason: 'fake_accepted',
    audit_recorded: true,
    mutation_sent: false,
    permit_id: 'permit-1',
    repository: REPO,
    action_kind,
    target_key: TARGET_KEY,
    target_digest: TARGET_DIGEST,
    snapshot_id: 'snap-1',
    proposal_id: 'proposal-1',
    execution_id: 'exec-1',
    action_parameters_digest: ACTION_PARAMS_DIGEST,
  };
}

function reconcileInputFor(action_kind: LifecycleActionKind): ReconcileLifecycleInput {
  return {
    repository: REPO,
    snapshot_id: 'snap-1',
    retained_member_target_key: TARGET_KEY,
    result_receipt: dummyReceipt(action_kind),
    predecessor_evidence: [
      {
        relation: 'predecessor',
        target_key: 'issue:org/repo#41',
        target_digest: H('pred'),
        evidence_digest: H('pe'),
      },
    ],
    successor_evidence: [
      {
        relation: 'successor',
        target_key: 'issue:org/repo#43',
        target_digest: H('succ'),
        evidence_digest: H('se'),
      },
    ],
    card: {
      kind: 'operator_card',
      governance: false,
      customer_visible: false,
      action_kind,
      summary: 'lifecycle result',
    },
  };
}

function goodAssessment(action_kind: LifecycleActionKind): LifecycleAssessmentInput {
  return {
    action_kind,
    lifecycle_gate_enabled: true,
    target_snapshot_present: true,
    target_state_current: true,
    duplicate_or_supersedence_proven: true,
    age_only_rationale: false,
    salvage_verified: true,
    reopen_recipe_present: true,
    fusion_record_present: true,
    independent_verification_present: true,
    verifier_correlated_with_operator: false,
    prior_close_proposal_proven_false: action_kind === 'REOPEN',
    approved_content_digest_present: true,
    allowed_label_transition: true,
    allowlisted_actor: true,
    policy_drift: false,
    crosses_production_boundary: false,
    crosses_governance_boundary: false,
    crosses_customer_boundary: false,
  };
}

function countingAdapter(inner: LifecycleMutationAdapter): {
  adapter: LifecycleMutationAdapter;
  calls: () => number;
} {
  let calls = 0;
  return {
    calls: () => calls,
    adapter: {
      async attemptMutation(request, permit): Promise<LifecycleMutationReceipt> {
        calls += 1;
        return inner.attemptMutation(request, permit);
      },
    },
  };
}

function acceptingAdapter(): LifecycleMutationAdapter {
  return createLifecycleMutationAdapter({
    allowed_repositories: [REPO],
    consume_execution: async () => true,
    record_attempt: async () => ({}),
  });
}

interface DepsOptions {
  readonly adapter: LifecycleMutationAdapter;
  readonly permit?: M31ActionPermitV2;
  readonly permitCounter?: () => void;
  readonly policy?: InjectedActionPolicyDepsV1;
  readonly salvage?: SalvageVerificationDeps;
}

function makeDeps(action_kind: LifecycleActionKind, opts: DepsOptions): LifecycleExecutionDeps {
  const permit = opts.permit ?? permitFor(action_kind);
  return {
    verifyWorktree: verifyOwned,
    salvage: opts.salvage ?? salvageOk,
    policy: opts.policy ?? policyDeps(),
    preparePermit: async () => {
      opts.permitCounter?.();
      return { ok: true, permit };
    },
    authorize: async () => ({ allowed: true }),
    reserveEffect: async () => ({ ok: true }),
    adapter: opts.adapter,
    appendOutcome: async () => ({ ok: true }),
    reconcile: async input => reconcileLifecycleResult(input),
  };
}

function makeInput(
  action_kind: LifecycleActionKind,
  overrides: Partial<LifecycleExecutionInput> = {}
): LifecycleExecutionInput {
  return {
    action_kind,
    repository: REPO,
    proposal_id: 'proposal-1',
    correlation_id: 'corr-1',
    actor: 'overseer-bot',
    summary: `lifecycle ${action_kind}`,
    assessment: goodAssessment(action_kind),
    worktree: { worktree_path: '/wt/thread-x', repository: REPO, expected_branch: 'wo/branch' },
    salvage_receipt: action_kind === 'CLOSE' ? salvageGitObject : null,
    reopen_recipe: action_kind === 'CLOSE' || action_kind === 'REOPEN' ? reopenRecipe : null,
    policy_request: policyRequestFor(action_kind),
    expected_request_digest: EXPECTED_REQ_DIGEST,
    expected_action_parameters_digest: ACTION_PARAMS_DIGEST,
    mutation_request: mutationRequestFor(action_kind),
    reconcile: reconcileInputFor(action_kind),
    ...overrides,
  };
}

describe('overseer lifecycle actions', () => {
  test('Test 1 - verified duplicate close executes exactly one fake action', async () => {
    const spy = countingAdapter(acceptingAdapter());
    const result = await executeLifecycleAction(
      makeInput('CLOSE'),
      makeDeps('CLOSE', { adapter: spy.adapter })
    );

    expect(result.status).toBe('executed');
    if (result.status !== 'executed') throw new Error('expected executed');
    expect(spy.calls()).toBe(1);
    expect(result.receipt.accepted).toBe(true);
    expect(result.receipt.mutation_sent).toBe(false);
    expect(result.receipt.reason).toBe('fake_accepted');
    // Membership is retained; lineage is supporting evidence only.
    expect(result.reconciliation.membership_retained).toBe(true);
    expect(result.reconciliation.membership_collapsed).toBe(false);
    expect(result.reconciliation.retained_member_target_key).toBe(TARGET_KEY);
    expect(result.reconciliation.lineage_appended).toHaveLength(2);
  });

  test('Test 2 - age-only close is denied before any permit or adapter call', async () => {
    const spy = countingAdapter(acceptingAdapter());
    let permitCalls = 0;
    const input = makeInput('CLOSE', {
      assessment: { ...goodAssessment('CLOSE'), age_only_rationale: true },
    });
    const result = await executeLifecycleAction(
      input,
      makeDeps('CLOSE', { adapter: spy.adapter, permitCounter: () => (permitCalls += 1) })
    );

    expect(result.status).toBe('denied');
    if (result.status !== 'denied') throw new Error('expected denied');
    expect(result.stage).toBe('assessment');
    expect(result.reason).toBe('age_only_rationale');
    expect(result.adapter_invoked).toBe(false);
    expect(spy.calls()).toBe(0);
    expect(permitCalls).toBe(0);
  });

  test('Test 3 - mistaken close reopens the same target with corrective lineage', async () => {
    const spy = countingAdapter(acceptingAdapter());
    const input = makeInput('REOPEN');
    const result = await executeLifecycleAction(
      input,
      makeDeps('REOPEN', { adapter: spy.adapter })
    );

    expect(result.status).toBe('executed');
    if (result.status !== 'executed') throw new Error('expected executed');
    expect(spy.calls()).toBe(1);
    expect(result.receipt.action_kind).toBe('REOPEN');
    expect(result.receipt.target_key).toBe(TARGET_KEY);
    // Corrective evidence links the prior close and no earlier evidence is dropped.
    expect(result.reconciliation.membership_collapsed).toBe(false);
    const predecessors = result.reconciliation.lineage_appended.filter(
      e => e.relation === 'predecessor'
    );
    expect(predecessors.length).toBeGreaterThanOrEqual(1);
    expect(input.reopen_recipe?.prior_close_proposal_id).toBe('close-proposal-1');
  });

  test('Test 4 - self review, stale evidence, and policy drift all fail closed', async () => {
    // Self review (correlated verifier).
    const spySelf = countingAdapter(acceptingAdapter());
    const selfReview = await executeLifecycleAction(
      makeInput('CLOSE', {
        assessment: { ...goodAssessment('CLOSE'), verifier_correlated_with_operator: true },
      }),
      makeDeps('CLOSE', { adapter: spySelf.adapter })
    );
    expect(selfReview.status).toBe('denied');
    if (selfReview.status === 'denied') expect(selfReview.reason).toBe('verifier_self_review');
    expect(spySelf.calls()).toBe(0);

    // Stale target state.
    const spyStale = countingAdapter(acceptingAdapter());
    const stale = await executeLifecycleAction(
      makeInput('CLOSE', {
        assessment: { ...goodAssessment('CLOSE'), target_state_current: false },
      }),
      makeDeps('CLOSE', { adapter: spyStale.adapter })
    );
    expect(stale.status).toBe('denied');
    if (stale.status === 'denied') expect(stale.reason).toBe('target_state_stale');
    expect(spyStale.calls()).toBe(0);

    // Mismatched (stale) injected policy decision.
    const spyDrift = countingAdapter(acceptingAdapter());
    const drift = await executeLifecycleAction(
      makeInput('CLOSE'),
      makeDeps('CLOSE', {
        adapter: spyDrift.adapter,
        policy: policyDeps({ request_digest: H('other-request') }),
      })
    );
    expect(drift.status).toBe('denied');
    if (drift.status === 'denied') {
      expect(drift.stage).toBe('policy');
      expect(drift.reason).toBe('policy_decision_stale');
    }
    expect(spyDrift.calls()).toBe(0);
  });

  test('Test 5 - customer or governance content is denied with a non-governance card', async () => {
    const spyCustomer = countingAdapter(acceptingAdapter());
    const customer = await executeLifecycleAction(
      makeInput('COMMENT', {
        assessment: { ...goodAssessment('COMMENT'), crosses_customer_boundary: true },
      }),
      makeDeps('COMMENT', { adapter: spyCustomer.adapter })
    );
    expect(customer.status).toBe('denied');
    if (customer.status === 'denied') expect(customer.reason).toBe('customer_boundary');
    expect(customer.operator_card.governance).toBe(false);
    expect(customer.operator_card.customer_visible).toBe(false);
    expect(spyCustomer.calls()).toBe(0);

    const spyGov = countingAdapter(acceptingAdapter());
    const governance = await executeLifecycleAction(
      makeInput('COMMENT', {
        assessment: { ...goodAssessment('COMMENT'), crosses_governance_boundary: true },
      }),
      makeDeps('COMMENT', { adapter: spyGov.adapter })
    );
    expect(governance.status).toBe('denied');
    if (governance.status === 'denied') expect(governance.reason).toBe('governance_boundary');
    expect(governance.operator_card.governance).toBe(false);
    expect(spyGov.calls()).toBe(0);

    // A pure assessment also classifies customer content as ineligible.
    const assessment = assessLifecycleCandidate({
      ...goodAssessment('COMMENT'),
      crosses_customer_boundary: true,
    });
    expect(assessment.eligible).toBe(false);
    if (!assessment.eligible) expect(assessment.denial_reason).toBe('customer_boundary');
  });

  test('COMMENT, LABEL, and ASSIGN happy paths perform exactly one allowlisted fake action', async () => {
    for (const kind of ['COMMENT', 'LABEL', 'ASSIGN'] as const) {
      const spy = countingAdapter(acceptingAdapter());
      const result = await executeLifecycleAction(
        makeInput(kind, { policy_request: policyRequestFor(kind) }),
        makeDeps(kind, { adapter: spy.adapter })
      );
      expect(result.status).toBe('executed');
      expect(spy.calls()).toBe(1);
    }
  });

  test('LABEL and ASSIGN denials fail closed before the adapter', async () => {
    const spyLabel = countingAdapter(acceptingAdapter());
    const label = await executeLifecycleAction(
      makeInput('LABEL', {
        assessment: { ...goodAssessment('LABEL'), allowed_label_transition: false },
      }),
      makeDeps('LABEL', { adapter: spyLabel.adapter })
    );
    expect(label.status).toBe('denied');
    if (label.status === 'denied') expect(label.reason).toBe('label_transition_not_allowed');
    expect(spyLabel.calls()).toBe(0);

    const spyAssign = countingAdapter(acceptingAdapter());
    const assign = await executeLifecycleAction(
      makeInput('ASSIGN', {
        assessment: { ...goodAssessment('ASSIGN'), allowlisted_actor: false },
      }),
      makeDeps('ASSIGN', { adapter: spyAssign.adapter })
    );
    expect(assign.status).toBe('denied');
    if (assign.status === 'denied') expect(assign.reason).toBe('actor_not_allowlisted');
    expect(spyAssign.calls()).toBe(0);
  });

  test('read-only mode denies every mutation when the lifecycle gate is disabled', async () => {
    const spy = countingAdapter(acceptingAdapter());
    const result = await executeLifecycleAction(
      makeInput('CLOSE', {
        assessment: { ...goodAssessment('CLOSE'), lifecycle_gate_enabled: false },
      }),
      makeDeps('CLOSE', { adapter: spy.adapter })
    );
    expect(result.status).toBe('denied');
    if (result.status === 'denied') expect(result.reason).toBe('lifecycle_gate_disabled');
    expect(spy.calls()).toBe(0);
  });

  test('salvage and lineage remain append only', async () => {
    // Only a matching durable git object permits close.
    const validGit = await verifySalvageArtifact(salvageGitObject, {
      async gitObjectExists() {
        return true;
      },
      async readPatchSha256() {
        return null;
      },
    });
    expect(validGit.verified).toBe(true);

    const missingGit = await verifySalvageArtifact(salvageGitObject, {
      async gitObjectExists() {
        return false;
      },
      async readPatchSha256() {
        return null;
      },
    });
    expect(missingGit.verified).toBe(false);
    if (!missingGit.verified) expect(missingGit.reason).toBe('git_object_missing');

    const patchReceipt: OverseerSalvageReceiptV1 = {
      ...salvageGitObject,
      artifact_kind: 'patch',
      git_object_format: null,
      git_object_id: null,
      patch_path: 'artifacts/salvage/wo-1.patch',
      patch_sha256: H('patch-bytes'),
    };
    const validPatch = await verifySalvageArtifact(patchReceipt, {
      async gitObjectExists() {
        return true;
      },
      async readPatchSha256() {
        return H('patch-bytes');
      },
    });
    expect(validPatch.verified).toBe(true);

    const corruptPatch = await verifySalvageArtifact(patchReceipt, {
      async gitObjectExists() {
        return true;
      },
      async readPatchSha256() {
        return H('tampered');
      },
    });
    expect(corruptPatch.verified).toBe(false);
    if (!corruptPatch.verified) expect(corruptPatch.reason).toBe('patch_hash_mismatch');

    const missingPatch = await verifySalvageArtifact(patchReceipt, {
      async gitObjectExists() {
        return true;
      },
      async readPatchSha256() {
        return null;
      },
    });
    expect(missingPatch.verified).toBe(false);
    if (!missingPatch.verified) expect(missingPatch.reason).toBe('patch_missing');

    // A close whose salvage cannot be verified is denied at the salvage gate.
    const spy = countingAdapter(acceptingAdapter());
    const deniedClose = await executeLifecycleAction(
      makeInput('CLOSE'),
      makeDeps('CLOSE', {
        adapter: spy.adapter,
        salvage: {
          async gitObjectExists() {
            return false;
          },
          async readPatchSha256() {
            return null;
          },
        },
      })
    );
    expect(deniedClose.status).toBe('denied');
    if (deniedClose.status === 'denied') expect(deniedClose.stage).toBe('salvage');
    expect(spy.calls()).toBe(0);

    // Reconciliation retains the original member and only appends lineage.
    const reconciliation = reconcileLifecycleResult(reconcileInputFor('CLOSE'));
    expect(reconciliation.retained_member_target_key).toBe(TARGET_KEY);
    expect(reconciliation.membership_collapsed).toBe(false);
    expect(reconciliation.lineage_appended.map(e => e.relation)).toEqual([
      'predecessor',
      'successor',
    ]);
  });

  test('Fusion and verifier floors fail closed', async () => {
    const cases: ReadonlyArray<{
      label: string;
      assessment: LifecycleAssessmentInput;
      reason: string;
    }> = [
      {
        label: 'missing fusion record',
        assessment: { ...goodAssessment('CLOSE'), fusion_record_present: false },
        reason: 'fusion_record_missing',
      },
      {
        label: 'missing independent verification',
        assessment: { ...goodAssessment('CLOSE'), independent_verification_present: false },
        reason: 'independent_verification_missing',
      },
      {
        label: 'self review substitution',
        assessment: { ...goodAssessment('CLOSE'), verifier_correlated_with_operator: true },
        reason: 'verifier_self_review',
      },
      {
        label: 'stale reviewed head',
        assessment: { ...goodAssessment('CLOSE'), target_state_current: false },
        reason: 'target_state_stale',
      },
      {
        label: 'unproven duplicate',
        assessment: { ...goodAssessment('CLOSE'), duplicate_or_supersedence_proven: false },
        reason: 'duplicate_not_proven',
      },
    ];

    for (const scenario of cases) {
      const spy = countingAdapter(acceptingAdapter());
      const result = await executeLifecycleAction(
        makeInput('CLOSE', { assessment: scenario.assessment }),
        makeDeps('CLOSE', { adapter: spy.adapter })
      );
      expect(result.status).toBe('denied');
      if (result.status === 'denied') {
        expect(result.reason).toBe(scenario.reason);
        expect(result.adapter_invoked).toBe(false);
      }
      expect(spy.calls()).toBe(0);
    }
  });
});
