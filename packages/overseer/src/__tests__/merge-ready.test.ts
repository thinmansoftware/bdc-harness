import { describe, expect, mock, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  assessQualifiedMerge,
  classifyMergeExclusion,
  executeQualifiedMerge,
  handleMergeReady,
  isInternalMergeAllowed,
  type ExecuteQualifiedMergeDeps,
  type QualifiedMergeAdapterRequestV2,
  type QualifiedMergeAdapterResultV2,
  type QualifiedMergeAdapterV2,
  type QualifiedMergeEvidence,
} from '../actions/merge-ready.ts';
import { loadOverseerActionPolicyRegistry } from '../policy-registry';
import type {
  M31ActionPermitV2,
  M31ActionTargetV2,
  M31ExecutionReceiptEventV2,
} from '@archon/core/db/m31-target-v2';
import type { ActionPolicyV2AuthorizationResult } from '../action-policy-v2';
import type { PullRequestEvidence, WatchedRunRecord } from '../types.ts';

const HEAD = 'c'.repeat(40);
const BASE = 'd'.repeat(40);
const PERMIT_EVENT_DIGEST = 'a1'.repeat(32);
const RESERVATION_EVENT_DIGEST = 'b2'.repeat(32);
const POLICY_DIGEST =
  loadOverseerActionPolicyRegistry({
    text: readFileSync(
      fileURLToPath(new URL('./fixtures/overseer-action-policy.synthetic.json', import.meta.url)),
      'utf8'
    ),
  }).entries[0]?.policy_digest ?? '';
const VERIFIER_DIGEST = 'c3'.repeat(32);
const TARGET_DIGEST = 'e4'.repeat(32);
const FUSION_RECEIPT_DIGEST = 'a7'.repeat(32);
const FUSION_EVIDENCE_DIGEST = 'b8'.repeat(32);
const OUTCOME_EVENT_DIGEST = 'd5'.repeat(32);

const REGISTRY = loadOverseerActionPolicyRegistry({
  text: readFileSync(
    fileURLToPath(new URL('./fixtures/overseer-action-policy.synthetic.json', import.meta.url)),
    'utf8'
  ),
});

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
    runId: 'run-1',
    woId: 'WO-TEST-01',
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

function validEvidence(overrides: Partial<QualifiedMergeEvidence> = {}): QualifiedMergeEvidence {
  return {
    record: record(),
    registry: REGISTRY,
    owner: 'bluedevilcollectibles',
    repository: 'bdc-harness',
    base_branch: 'dev',
    resulting_deployment_effect: 'none',
    credential_principal: 'overseer-fake-merge-principal',
    action_kind: 'MERGE',
    changed_files: ['packages/app/src/index.ts'],
    pr_number: 42,
    head_sha: HEAD,
    base_sha: BASE,
    required_checks: [
      { name: 'ci', conclusion: 'success', head_sha: HEAD },
      { name: 'lint', conclusion: 'success', head_sha: HEAD },
    ],
    reviews: [{ resolved: true }],
    independent_review: {
      present: true,
      reviewed_head_sha: HEAD,
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
    proposal_id: 'proposal-1',
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
    expected_verifier_registry_digest: VERIFIER_DIGEST,
    final_state_consistent: true,
    ...overrides,
  };
}

const TARGET: M31ActionTargetV2 = {
  target_kind: 'pull_request',
  repository: 'bluedevilcollectibles/bdc-harness',
  pr_number: 42,
  provider_node_id: 'PR_node',
  head_sha: HEAD,
  base_branch: 'dev',
  base_sha: BASE,
  state: 'open',
  updated_at: '2026-07-15T12:00:00.000Z',
};

const PERMIT: M31ActionPermitV2 = {
  permit_id: 'permit-1',
  proposal_id: 'proposal-1',
  execution_id: 'execution-1',
  repository: 'bluedevilcollectibles/bdc-harness',
  target: TARGET,
  target_key: 'bluedevilcollectibles/bdc-harness#pull_request:42',
  target_digest: TARGET_DIGEST,
  snapshot_id: 'snapshot-1',
  action_kind: 'MERGE',
  capability: 'overseer.m31.merge',
  issued_at: '2026-07-15T11:59:00.000Z',
  valid_until: '2026-07-15T12:01:00.000Z',
};

function permitReceiptEvent(): M31ExecutionReceiptEventV2 {
  return {
    receipt_event_id: 'receipt-permit-1',
    proposal_id: 'proposal-1',
    execution_id: 'execution-1',
    event_sequence: 1,
    event_type: 'permit_issued',
    target_kind: 'pull_request',
    target_key: PERMIT.target_key,
    target_digest: PERMIT.target_digest,
    live_observation: null,
    live_observation_digest: null,
    revalidated_at: null,
    valid_until: PERMIT.valid_until,
    adapter_name: null,
    provider_operation: null,
    external_effect_reference: null,
    reason: 'permit_issued',
    evidence: {},
    previous_event_digest: null,
    event_digest: PERMIT_EVENT_DIGEST,
    created_at: '2026-07-15T11:59:00.000Z',
  };
}

function reservationReceiptEvent(
  previous: string = PERMIT_EVENT_DIGEST
): M31ExecutionReceiptEventV2 {
  return {
    receipt_event_id: 'receipt-reserve-1',
    proposal_id: 'proposal-1',
    execution_id: 'execution-1',
    event_sequence: 2,
    event_type: 'effect_reserved',
    target_kind: 'pull_request',
    target_key: PERMIT.target_key,
    target_digest: PERMIT.target_digest,
    live_observation: null,
    live_observation_digest: null,
    revalidated_at: null,
    valid_until: PERMIT.valid_until,
    adapter_name: 'qualified-merge-adapter-v2',
    provider_operation: 'merge',
    external_effect_reference: null,
    reason: 'effect_reserved',
    evidence: {},
    previous_event_digest: previous,
    event_digest: RESERVATION_EVENT_DIGEST,
    created_at: '2026-07-15T12:00:00.000Z',
  };
}

function outcomeReceiptEvent(
  type: 'effect_succeeded' | 'effect_failed' | 'effect_indeterminate'
): M31ExecutionReceiptEventV2 {
  return {
    receipt_event_id: `receipt-${type}`,
    proposal_id: 'proposal-1',
    execution_id: 'execution-1',
    event_sequence: 3,
    event_type: type,
    target_kind: 'pull_request',
    target_key: PERMIT.target_key,
    target_digest: PERMIT.target_digest,
    live_observation: null,
    live_observation_digest: null,
    revalidated_at: null,
    valid_until: null,
    adapter_name: 'qualified-merge-adapter-v2',
    provider_operation: 'merge',
    external_effect_reference: null,
    reason: type,
    evidence: {},
    previous_event_digest: RESERVATION_EVENT_DIGEST,
    event_digest: OUTCOME_EVENT_DIGEST,
    created_at: '2026-07-15T12:00:01.000Z',
  };
}

function allowedAuthorization(): ActionPolicyV2AuthorizationResult {
  return {
    allowed: true,
    reason: 'allowed',
    capability: 'merge',
    repository: 'bluedevilcollectibles/bdc-harness',
    target_kind: 'pull_request',
    target_key: PERMIT.target_key,
    target_digest: PERMIT.target_digest,
    snapshot_id: 'snapshot-1',
    proposal_id: 'proposal-1',
    execution_id: 'execution-1',
    action_kind: 'MERGE',
    valid_until: PERMIT.valid_until,
    policy_digest: POLICY_DIGEST,
    verifier_registry_digest: VERIFIER_DIGEST,
    audit_recorded: true,
  };
}

function adapterResult(
  status: QualifiedMergeAdapterResultV2['status'],
  reason = status
): QualifiedMergeAdapterResultV2 {
  return {
    schema_version: 'overseer-qualified-merge-adapter-result-v2',
    status,
    reason,
    external_effect_reference: status === 'succeeded' ? 'fake-merge-ref-1' : null,
    evidence_digest: status === 'succeeded' ? 'f6'.repeat(32) : null,
  };
}

interface Harness {
  deps: ExecuteQualifiedMergeDeps;
  calls: string[];
  adapterRequests: QualifiedMergeAdapterRequestV2[];
  outcomeCalls: Array<{ outcome: string; reason: string }>;
}

function harness(
  overrides: Partial<ExecuteQualifiedMergeDeps> = {},
  options: {
    adapterStatus?: QualifiedMergeAdapterResultV2['status'];
    adapterImpl?: QualifiedMergeAdapterV2;
  } = {}
): Harness {
  const calls: string[] = [];
  const adapterRequests: QualifiedMergeAdapterRequestV2[] = [];
  const outcomeCalls: Array<{ outcome: string; reason: string }> = [];
  const adapterStatus = options.adapterStatus ?? 'succeeded';

  const defaultAdapter: QualifiedMergeAdapterV2 = {
    attemptMerge: async (request: QualifiedMergeAdapterRequestV2) => {
      calls.push('mergeAdapter');
      adapterRequests.push(request);
      return adapterResult(
        adapterStatus,
        adapterStatus === 'succeeded' ? 'fake_accepted' : 'rejected'
      );
    },
  };

  const deps: ExecuteQualifiedMergeDeps = {
    insertOverseerAction: mock(async () => {
      calls.push('insertOverseerAction');
    }),
    preparePermit: mock(async () => {
      calls.push('preparePermit');
      return { ok: true as const, permit: PERMIT, receipt: permitReceiptEvent() };
    }),
    authorize: mock(async () => {
      calls.push('authorize');
      return allowedAuthorization();
    }),
    reserveEffect: mock(async () => {
      calls.push('reserveEffect');
      return { ok: true as const, value: reservationReceiptEvent() };
    }),
    mergeAdapter: options.adapterImpl ?? defaultAdapter,
    recordOutcome: mock(async input => {
      calls.push('recordOutcome');
      outcomeCalls.push({ outcome: input.outcome, reason: input.reason });
      return {
        ok: true as const,
        value: outcomeReceiptEvent(input.outcome),
      };
    }),
    reconcile: mock(async () => {
      calls.push('reconcile');
    }),
    ...overrides,
  };
  return { deps, calls, adapterRequests, outcomeCalls };
}

describe('classifyMergeExclusion', () => {
  test('production and unknown effects are excluded deterministically', () => {
    expect(
      classifyMergeExclusion({
        resulting_deployment_effect: 'production',
        base_branch: 'dev',
        changed_files: [],
      })
    ).toEqual({ excluded: true, reason: 'production_effect', disposition: 'operator_card' });
    expect(
      classifyMergeExclusion({
        resulting_deployment_effect: 'unknown',
        base_branch: 'dev',
        changed_files: [],
      })
    ).toEqual({ excluded: true, reason: 'unknown_effect', disposition: 'circuit_open' });
  });

  test('release branches and excluded file scopes fail closed', () => {
    expect(
      classifyMergeExclusion({
        resulting_deployment_effect: 'none',
        base_branch: 'main',
        changed_files: [],
      }).excluded
    ).toBe(true);
    for (const path of [
      'docs/board/motions/M-1.md',
      'migrations/040_x.sql',
      'services/.env',
      'config/api-credentials.json',
      'data/customers/list.csv',
      'src/billing/charge.ts',
      'x.pem',
    ]) {
      const result = classifyMergeExclusion({
        resulting_deployment_effect: 'none',
        base_branch: 'dev',
        changed_files: [path],
      });
      expect(result.excluded).toBe(true);
    }
  });

  test('an ordinary source change on a feature base is not excluded', () => {
    expect(
      classifyMergeExclusion({
        resulting_deployment_effect: 'none',
        base_branch: 'dev',
        changed_files: ['packages/app/src/index.ts'],
      })
    ).toEqual({ excluded: false });
  });
});

describe('assessQualifiedMerge', () => {
  test('a fully qualified target is eligible', () => {
    const assessment = assessQualifiedMerge(validEvidence());
    expect(assessment.eligible).toBe(true);
  });

  test('internal allowlist is enforced', () => {
    expect(isInternalMergeAllowed('bdc-harness')).toBe(true);
    expect(isInternalMergeAllowed('shopops-storefront')).toBe(false);
  });
});

describe('executeQualifiedMerge -- Section 11', () => {
  // Test 1
  test('exact qualified fake merge produces reserved and succeeded primary outcome evidence', async () => {
    const h = harness();
    const result = await executeQualifiedMerge(validEvidence(), h.deps);

    expect(result.action).toBe('merged');
    expect(result.merged).toBe(true);
    expect(result.adapterCalled).toBe(true);
    expect(result.receipts).toEqual(['effect_reserved', 'effect_succeeded']);
    expect(result.primaryOutcome).toBe('effect_succeeded');
    expect(result.permitEventDigest).toBe(PERMIT_EVENT_DIGEST);
    expect(result.reservationEventDigest).toBe(RESERVATION_EVENT_DIGEST);
    expect(h.calls.filter(c => c === 'mergeAdapter')).toHaveLength(1);
    // target-v2: reconciliation is only after effect_indeterminate; success is terminal.
    expect(h.deps.reconcile).not.toHaveBeenCalled();
    expect(h.calls).not.toContain('reconcile');
    expect(h.calls).toContain('reserveEffect');
    expect(h.calls).toContain('recordOutcome');
    expect(h.outcomeCalls).toEqual([
      { outcome: 'effect_succeeded', reason: 'adapter_accepted:fake_accepted' },
    ]);
  });

  // Stop 3 named test -- exact substring "prepare authorize reserve precede merge adapter"
  test('prepare authorize reserve precede merge adapter in the qualified path', async () => {
    const h = harness();
    await executeQualifiedMerge(validEvidence(), h.deps);

    const prepareIdx = h.calls.indexOf('preparePermit');
    const authorizeIdx = h.calls.indexOf('authorize');
    const reserveIdx = h.calls.indexOf('reserveEffect');
    const adapterIdx = h.calls.indexOf('mergeAdapter');
    const outcomeIdx = h.calls.indexOf('recordOutcome');

    expect(prepareIdx).toBeGreaterThanOrEqual(0);
    expect(prepareIdx).toBeLessThan(authorizeIdx);
    expect(authorizeIdx).toBeLessThan(reserveIdx);
    expect(reserveIdx).toBeLessThan(adapterIdx);
    expect(adapterIdx).toBeLessThan(outcomeIdx);
  });

  // Test 2
  test('zero required checks is not green and denies before the permit or adapter', async () => {
    const noChecks = harness();
    const zeroCheckEvidence = validEvidence({
      record: record({
        prEvidence: prEvidence({ checks: { total: 0, passed: 0, failed: 0, pending: 0 } }),
      }),
    });
    const zeroCheckResult = await executeQualifiedMerge(zeroCheckEvidence, noChecks.deps);
    expect(zeroCheckResult.action).toBe('denied');
    expect(zeroCheckResult.adapterCalled).toBe(false);
    expect(noChecks.deps.preparePermit).not.toHaveBeenCalled();
    expect(noChecks.calls).not.toContain('mergeAdapter');

    const noRequired = harness();
    const result = await executeQualifiedMerge(
      validEvidence({ required_checks: [] }),
      noRequired.deps
    );
    expect(result.action).toBe('denied');
    expect(result.reason).toBe('zero_required_checks');
    expect(noRequired.deps.preparePermit).not.toHaveBeenCalled();
    expect(noRequired.calls).not.toContain('mergeAdapter');
  });

  // Test 3
  test('excluded effects and files fail closed with no adapter call', async () => {
    const productionH = harness();
    const production = await executeQualifiedMerge(
      validEvidence({ resulting_deployment_effect: 'production' }),
      productionH.deps
    );
    expect(production.action).toBe('operator_card');
    expect(production.adapterCalled).toBe(false);
    expect(productionH.calls).not.toContain('mergeAdapter');

    const unknownH = harness();
    const unknown = await executeQualifiedMerge(
      validEvidence({ resulting_deployment_effect: 'unknown' }),
      unknownH.deps
    );
    expect(unknown.action).toBe('circuit_open');
    expect(unknownH.calls).not.toContain('mergeAdapter');

    for (const path of [
      'docs/board/motions/M-1.md',
      'migrations/041_x.sql',
      'app/.env',
      'secrets/credentials.json',
    ]) {
      const h = harness();
      const result = await executeQualifiedMerge(validEvidence({ changed_files: [path] }), h.deps);
      expect(result.action).toBe('denied');
      expect(h.calls).not.toContain('mergeAdapter');
    }
  });

  // Test 4
  test('exact-state drift stops before the adapter', async () => {
    const driftH = harness();
    const drift = await executeQualifiedMerge(
      validEvidence({ final_state_consistent: false }),
      driftH.deps
    );
    expect(drift.reason).toBe('exact_state_drift');
    expect(driftH.deps.preparePermit).not.toHaveBeenCalled();
    expect(driftH.calls).not.toContain('mergeAdapter');

    const permitDriftH = harness({
      preparePermit: mock(async () => ({
        ok: false as const,
        failure: 'live_state_mismatch' as const,
      })),
    });
    const permitDrift = await executeQualifiedMerge(validEvidence(), permitDriftH.deps);
    expect(permitDrift.action).toBe('permit_denied');
    expect(permitDrift.adapterCalled).toBe(false);
    expect(permitDriftH.calls).not.toContain('mergeAdapter');
  });

  test('a non-internal repository denies before any permit or adapter call', async () => {
    const h = harness();
    const result = await executeQualifiedMerge(
      validEvidence({ repository: 'shopops-storefront' }),
      h.deps
    );
    expect(result.action).toBe('denied');
    expect(result.reason).toBe('repository_not_internal');
    expect(result.merged).toBe(false);
    expect(result.adapterCalled).toBe(false);
    expect(result.receipts).toEqual([]);
    expect(h.deps.preparePermit).not.toHaveBeenCalled();
    expect(h.deps.authorize).not.toHaveBeenCalled();
    expect(h.deps.reserveEffect).not.toHaveBeenCalled();
    expect(h.calls).not.toContain('mergeAdapter');
  });

  test('a denied authorization stops before reservation and the adapter', async () => {
    const h = harness({
      authorize: mock(async () => ({
        allowed: false as const,
        reason: 'capability_flag_disabled' as const,
        capability: 'merge' as const,
        audit_recorded: true,
      })),
    });
    const result = await executeQualifiedMerge(validEvidence(), h.deps);
    expect(result.action).toBe('permit_denied');
    expect(result.reason).toBe('authorization_denied:capability_flag_disabled');
    expect(result.merged).toBe(false);
    expect(result.adapterCalled).toBe(false);
    expect(result.receipts).toEqual([]);
    expect(h.deps.preparePermit).toHaveBeenCalledTimes(1);
    expect(h.deps.authorize).toHaveBeenCalledTimes(1);
    expect(h.deps.reserveEffect).not.toHaveBeenCalled();
    expect(h.calls).not.toContain('mergeAdapter');
    expect(h.deps.recordOutcome).not.toHaveBeenCalled();
  });

  test('a failed effect reservation stops before the adapter', async () => {
    const h = harness({
      reserveEffect: mock(async () => ({
        ok: false as const,
        failure: 'reservation_conflict',
      })),
    });
    const result = await executeQualifiedMerge(validEvidence(), h.deps);
    expect(result.action).toBe('reservation_failed');
    expect(result.reason).toBe('effect_not_reserved:reservation_conflict');
    expect(result.merged).toBe(false);
    expect(result.adapterCalled).toBe(false);
    expect(result.receipts).toEqual([]);
    expect(h.deps.authorize).toHaveBeenCalledTimes(1);
    expect(h.deps.reserveEffect).toHaveBeenCalledTimes(1);
    expect(h.calls).not.toContain('mergeAdapter');
    expect(h.deps.recordOutcome).not.toHaveBeenCalled();
  });

  // Test 5
  test('missing or correlated Fusion/verifier stops with no adapter call', async () => {
    const baseFusion = {
      present: true,
      components: ['a', 'b'] as readonly string[],
      raw_dissent_recorded: true,
      cost_recorded: true,
      verifier_correlated: false,
      hidden_model_substitution: false,
      receipt_digest: FUSION_RECEIPT_DIGEST,
      evidence_digest: FUSION_EVIDENCE_DIGEST,
    };
    const cases: Partial<QualifiedMergeEvidence>[] = [
      { fusion: null },
      {
        fusion: {
          ...baseFusion,
          components: ['only-one'],
          raw_dissent_recorded: false,
        },
      },
      {
        fusion: {
          ...baseFusion,
          verifier_correlated: true,
        },
      },
      {
        fusion: {
          ...baseFusion,
          hidden_model_substitution: true,
        },
      },
      {
        fusion: {
          ...baseFusion,
          receipt_digest: 'NOT_A_DIGEST',
        },
      },
      {
        fusion: {
          ...baseFusion,
          // Upper-case fails the lower-case 64-hex requirement.
          evidence_digest: 'A'.repeat(64),
        },
      },
      {
        expected_verifier_registry_digest: 'NOT_HEX',
      },
    ];
    for (const override of cases) {
      const h = harness();
      const result = await executeQualifiedMerge(validEvidence(override), h.deps);
      expect(result.action).toBe('denied');
      expect(result.merged).toBe(false);
      expect(result.adapterCalled).toBe(false);
      expect(h.calls).not.toContain('mergeAdapter');
    }
  });

  test('correlated independent review denies before the adapter', async () => {
    const h = harness();
    const result = await executeQualifiedMerge(
      validEvidence({
        independent_review: {
          present: true,
          reviewed_head_sha: HEAD,
          reviewer_identity: 'same',
          builder_identity: 'same',
          reviewer_provider: 'anthropic',
          builder_provider: 'anthropic',
          reviewer_model_family: 'claude',
          builder_model_family: 'claude',
        },
      }),
      h.deps
    );
    expect(result.action).toBe('denied');
    expect(h.calls).not.toContain('mergeAdapter');
  });

  test('operator recuses when identity, provider, or model family matches the builder', async () => {
    const cases = [
      { identity: 'builder-model', provider: 'xai', model_family: 'grok' },
      { identity: 'grok-overseer', provider: 'anthropic', model_family: 'grok' },
      { identity: 'grok-overseer', provider: 'xai', model_family: 'claude' },
    ];
    for (const operator of cases) {
      const h = harness();
      const result = await executeQualifiedMerge(validEvidence({ operator }), h.deps);
      expect(result.action).toBe('denied');
      expect(result.reason).toBe('operator_builder_correlated');
      expect(h.deps.preparePermit).not.toHaveBeenCalled();
      expect(h.calls).not.toContain('mergeAdapter');
    }
  });

  test('a rejected adapter records effect_failed and never reports merged', async () => {
    const h = harness({}, { adapterStatus: 'failed' });
    const result = await executeQualifiedMerge(validEvidence(), h.deps);
    expect(result.action).toBe('merge_failed');
    expect(result.merged).toBe(false);
    expect(result.adapterCalled).toBe(true);
    expect(result.primaryOutcome).toBe('effect_failed');
    expect(result.receipts).toEqual(['effect_reserved', 'effect_failed']);
    expect(h.outcomeCalls).toEqual([
      { outcome: 'effect_failed', reason: 'adapter_rejected:rejected' },
    ]);
    expect(h.deps.reconcile).not.toHaveBeenCalled();
  });

  test('handleMergeReady delegates to the gated executor', async () => {
    const h = harness();
    const result = await handleMergeReady(validEvidence(), h.deps);
    expect(result.merged).toBe(true);
    expect(h.calls.filter(c => c === 'mergeAdapter')).toHaveLength(1);
  });
});

describe('adversarial regressions -- Slice 7 repair', () => {
  test('v1 merge-steward and fake-github paths are unreachable from merge-ready source', async () => {
    const sourcePath = fileURLToPath(new URL('../actions/merge-ready.ts', import.meta.url));
    const source = readFileSync(sourcePath, 'utf8');
    // Only import/require edges count as a direct v1 dependency.
    expect(source).not.toMatch(/from\s+['"][^'"]*(merge-steward|fake-github)[^'"]*['"]/);
    expect(source).not.toMatch(
      /import\s*\(\s*['"][^'"]*(merge-steward|fake-github)[^'"]*['"]\s*\)/
    );
    expect(source).not.toMatch(
      /require\s*\(\s*['"][^'"]*(merge-steward|fake-github)[^'"]*['"]\s*\)/
    );
    expect(source).toMatch(/QualifiedMergeAdapterV2/);
    expect(source).toMatch(/mergeAdapter/);
    // Test file also must not import the forbidden modules.
    const testSource = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(testSource).not.toMatch(/from\s+['"][^'"]*(merge-steward|fake-github)[^'"]*['"]/);
  });

  test('missing mergeAdapter DI fails closed before permit or adapter', async () => {
    const h = harness({ mergeAdapter: null });
    const result = await executeQualifiedMerge(validEvidence(), h.deps);
    expect(result.merged).toBe(false);
    expect(result.action).toBe('denied');
    expect(result.reason).toBe('merge_adapter_missing');
    expect(result.adapterCalled).toBe(false);
    expect(h.deps.preparePermit).not.toHaveBeenCalled();
    expect(h.deps.reserveEffect).not.toHaveBeenCalled();
    expect(h.deps.recordOutcome).not.toHaveBeenCalled();
  });

  test('hash-chain binds permit event digest to reservation previous digest', async () => {
    const h = harness();
    const result = await executeQualifiedMerge(validEvidence(), h.deps);
    expect(result.merged).toBe(true);
    expect(result.permitEventDigest).toBe(PERMIT_EVENT_DIGEST);
    expect(result.reservationEventDigest).toBe(RESERVATION_EVENT_DIGEST);
    expect(h.adapterRequests).toHaveLength(1);
    const request = h.adapterRequests[0];
    expect(request?.permit_event_digest).toBe(PERMIT_EVENT_DIGEST);
    expect(request?.reservation_event_digest).toBe(RESERVATION_EVENT_DIGEST);
    expect(request?.policy_digest).toBe(POLICY_DIGEST);
    expect(request?.verifier_registry_digest).toBe(VERIFIER_DIGEST);
    expect(request?.fusion_receipt_digest).toBe(FUSION_RECEIPT_DIGEST);
    expect(request?.fusion_evidence_digest).toBe(FUSION_EVIDENCE_DIGEST);
    expect(request?.head_sha).toBe(HEAD);
    expect(request?.base_sha).toBe(BASE);
    expect(request?.pr_number).toBe(42);
    expect(request?.execution_id).toBe(PERMIT.execution_id);
    expect(request?.proposal_id).toBe(PERMIT.proposal_id);
    expect(request?.target_digest).toBe(TARGET_DIGEST);
  });

  test('reservation previous digest mismatch fails closed without adapter and records indeterminate', async () => {
    const h = harness({
      reserveEffect: mock(async () => ({
        ok: true as const,
        value: reservationReceiptEvent('0'.repeat(64)),
      })),
    });
    const result = await executeQualifiedMerge(validEvidence(), h.deps);
    expect(result.merged).toBe(false);
    expect(result.action).toBe('indeterminate');
    expect(result.reason).toBe('reservation_chain_invalid:reservation_previous_digest_mismatch');
    expect(result.adapterCalled).toBe(false);
    expect(h.calls).not.toContain('mergeAdapter');
    expect(result.receipts).toContain('effect_reserved');
    expect(result.primaryOutcome).toBe('effect_indeterminate');
    expect(h.outcomeCalls.some(c => c.outcome === 'effect_indeterminate')).toBe(true);
  });

  test('identity recheck on head drift fails before reservation and adapter', async () => {
    const driftedPermit: M31ActionPermitV2 = {
      ...PERMIT,
      target: { ...TARGET, head_sha: 'f'.repeat(40) },
    };
    const h = harness({
      preparePermit: mock(async () => ({
        ok: true as const,
        permit: driftedPermit,
        receipt: { ...permitReceiptEvent(), target_digest: TARGET_DIGEST },
      })),
    });
    const result = await executeQualifiedMerge(validEvidence(), h.deps);
    expect(result.merged).toBe(false);
    expect(result.action).toBe('permit_denied');
    expect(result.reason).toBe('identity_recheck_failed:permit_head_sha_mismatch');
    expect(h.deps.reserveEffect).not.toHaveBeenCalled();
    expect(h.calls).not.toContain('mergeAdapter');
  });

  test('adapter rejection cannot report merged and must record effect_failed', async () => {
    const h = harness({}, { adapterStatus: 'failed' });
    const result = await executeQualifiedMerge(validEvidence(), h.deps);
    expect(result.merged).toBe(false);
    expect(result.action).toBe('merge_failed');
    expect(result.primaryOutcome).toBe('effect_failed');
    expect(result.receipts).toEqual(['effect_reserved', 'effect_failed']);
    expect(h.outcomeCalls).toHaveLength(1);
    expect(h.outcomeCalls[0]?.outcome).toBe('effect_failed');
  });

  test('outcome-write failure after adapter success cannot report merged', async () => {
    let outcomeAttempts = 0;
    const h = harness({
      recordOutcome: mock(async input => {
        outcomeAttempts += 1;
        // First attempt (effect_succeeded) fails; second (indeterminate) succeeds.
        if (input.outcome === 'effect_succeeded') {
          return { ok: false as const, failure: 'outcome_append_failed' };
        }
        return { ok: true as const, value: outcomeReceiptEvent(input.outcome) };
      }),
    });
    const result = await executeQualifiedMerge(validEvidence(), h.deps);
    expect(result.merged).toBe(false);
    expect(result.action).toBe('indeterminate');
    expect(result.reason).toBe('outcome_write_failed_after_adapter_success');
    expect(result.primaryOutcome).toBe('effect_indeterminate');
    expect(outcomeAttempts).toBe(2);
    // No third attempt / no replay of adapter.
    expect(h.calls.filter(c => c === 'mergeAdapter')).toHaveLength(1);
  });

  test('adapter indeterminate cannot report merged and records effect_indeterminate once', async () => {
    const h = harness({}, { adapterStatus: 'indeterminate' });
    const result = await executeQualifiedMerge(validEvidence(), h.deps);
    expect(result.merged).toBe(false);
    expect(result.action).toBe('indeterminate');
    expect(result.primaryOutcome).toBe('effect_indeterminate');
    expect(result.receipts).toEqual(['effect_reserved', 'effect_indeterminate']);
    expect(h.outcomeCalls).toHaveLength(1);
    expect(h.deps.reconcile).not.toHaveBeenCalled();
  });

  test('policy digest identity must match the assessed policy entry', async () => {
    const h = harness({
      authorize: mock(async () => ({
        ...allowedAuthorization(),
        policy_digest: '0'.repeat(64),
      })),
    });
    const result = await executeQualifiedMerge(validEvidence(), h.deps);
    expect(result.merged).toBe(false);
    expect(result.action).toBe('permit_denied');
    expect(result.reason).toBe('identity_recheck_failed:auth_policy_digest_mismatch');
    expect(h.deps.reserveEffect).not.toHaveBeenCalled();
    expect(h.calls).not.toContain('mergeAdapter');
  });

  test('Windows path construction for fixtures has no /C: pathname bug', () => {
    const synthetic = fileURLToPath(
      new URL('./fixtures/overseer-action-policy.synthetic.json', import.meta.url)
    );
    const shipped = fileURLToPath(
      new URL('../../../../.archon/policies/overseer-action-policy.json', import.meta.url)
    );
    // fileURLToPath never yields the broken "/C:/..." form on Windows.
    expect(synthetic.includes('/C:')).toBe(false);
    expect(shipped.includes('/C:')).toBe(false);
    expect(existsSync(synthetic)).toBe(true);
    expect(existsSync(shipped)).toBe(true);
    const syntheticText = readFileSync(synthetic, 'utf8');
    const shippedText = readFileSync(shipped, 'utf8');
    expect(loadOverseerActionPolicyRegistry({ text: syntheticText }).entries).toHaveLength(1);
    expect(loadOverseerActionPolicyRegistry({ text: shippedText }).entries).toHaveLength(0);
  });

  test('adapter throw records effect_indeterminate once and never reports merged', async () => {
    let adapterAttempts = 0;
    const h = harness(
      {},
      {
        adapterImpl: {
          attemptMerge: async () => {
            adapterAttempts += 1;
            throw new Error('provider_timeout');
          },
        },
      }
    );
    const result = await executeQualifiedMerge(validEvidence(), h.deps);
    expect(result.merged).toBe(false);
    expect(result.action).toBe('indeterminate');
    expect(result.reason).toBe('adapter_threw:provider_timeout');
    expect(result.adapterCalled).toBe(true);
    expect(result.primaryOutcome).toBe('effect_indeterminate');
    expect(result.receipts).toEqual(['effect_reserved', 'effect_indeterminate']);
    expect(h.outcomeCalls).toHaveLength(1);
    expect(h.outcomeCalls[0]?.outcome).toBe('effect_indeterminate');
    expect(h.deps.reconcile).not.toHaveBeenCalled();
    expect(adapterAttempts).toBe(1);
    expect(h.outcomeCalls.filter(c => c.outcome === 'effect_succeeded')).toHaveLength(0);
  });

  test('invalid adapter response records effect_indeterminate and never reports merged', async () => {
    let adapterAttempts = 0;
    const tracked: QualifiedMergeAdapterV2 = {
      attemptMerge: async () => {
        adapterAttempts += 1;
        return {
          schema_version: 'not-a-valid-result-v2',
          status: 'succeeded',
          reason: 'spoofed',
          external_effect_reference: 'x',
          evidence_digest: 'f6'.repeat(32),
        } as unknown as QualifiedMergeAdapterResultV2;
      },
    };
    const h = harness({}, { adapterImpl: tracked });
    const result = await executeQualifiedMerge(validEvidence(), h.deps);
    expect(result.merged).toBe(false);
    expect(result.action).toBe('indeterminate');
    expect(result.reason).toBe('adapter_result_invalid');
    expect(result.adapterCalled).toBe(true);
    expect(result.primaryOutcome).toBe('effect_indeterminate');
    expect(result.receipts).toEqual(['effect_reserved', 'effect_indeterminate']);
    expect(h.outcomeCalls).toEqual([
      { outcome: 'effect_indeterminate', reason: 'adapter_result_invalid' },
    ]);
    expect(h.deps.reconcile).not.toHaveBeenCalled();
    expect(adapterAttempts).toBe(1);
  });

  test('mismatched primary outcome receipt fails closed and never reports merged', async () => {
    let attempts = 0;
    const h = harness({
      recordOutcome: mock(async input => {
        attempts += 1;
        // Adversarial: claim ok with wrong event type / identity.
        return {
          ok: true as const,
          value: {
            ...outcomeReceiptEvent('effect_failed'),
            event_type: 'effect_failed' as const,
            proposal_id: 'wrong-proposal',
            execution_id: 'wrong-execution',
            target_key: 'wrong-target',
            target_digest: '0'.repeat(64),
            previous_event_digest: '1'.repeat(64),
            event_sequence: 99,
          },
        };
      }),
    });
    const result = await executeQualifiedMerge(validEvidence(), h.deps);
    expect(result.merged).toBe(false);
    expect(result.action).toBe('indeterminate');
    expect(result.reason).toBe('outcome_write_failed_after_adapter_success');
    // First success attempt rejected by identity bind; second indeterminate also
    // rejected by the same adversarial mock -- still never merged.
    expect(result.primaryOutcome).toBe('effect_indeterminate');
    expect(result.receipts).toEqual(['effect_reserved']);
    expect(attempts).toBe(2);
    expect(h.deps.reconcile).not.toHaveBeenCalled();
    expect(h.calls.filter(c => c === 'mergeAdapter')).toHaveLength(1);
  });

  test('mismatched previous_event_digest on primary outcome fails closed', async () => {
    let attempts = 0;
    const h = harness({
      recordOutcome: mock(async input => {
        attempts += 1;
        h.calls.push('recordOutcome');
        h.outcomeCalls.push({ outcome: input.outcome, reason: input.reason });
        if (input.outcome === 'effect_succeeded') {
          return {
            ok: true as const,
            value: {
              ...outcomeReceiptEvent('effect_succeeded'),
              previous_event_digest: '9'.repeat(64),
            },
          };
        }
        return { ok: true as const, value: outcomeReceiptEvent(input.outcome) };
      }),
    });
    const result = await executeQualifiedMerge(validEvidence(), h.deps);
    expect(result.merged).toBe(false);
    expect(result.action).toBe('indeterminate');
    expect(result.reason).toBe('outcome_write_failed_after_adapter_success');
    expect(result.primaryOutcome).toBe('effect_indeterminate');
    expect(result.receipts).toEqual(['effect_reserved', 'effect_indeterminate']);
    expect(attempts).toBe(2);
    expect(h.deps.reconcile).not.toHaveBeenCalled();
  });

  test('successful effect_succeeded never calls reconcile (no sequence-4 after success)', async () => {
    const h = harness();
    const result = await executeQualifiedMerge(validEvidence(), h.deps);
    expect(result.merged).toBe(true);
    expect(result.primaryOutcome).toBe('effect_succeeded');
    expect(h.deps.reconcile).not.toHaveBeenCalled();
    expect(h.calls).not.toContain('reconcile');
    // Source must not invoke effect_reconciled_succeeded on the success path.
    const source = readFileSync(
      fileURLToPath(new URL('../actions/merge-ready.ts', import.meta.url)),
      'utf8'
    );
    // Direct success path no longer contains a reconcile invocation after succeeded.
    expect(source).not.toMatch(/outcome:\s*'effect_succeeded'[\s\S]{0,800}deps\.reconcile\(/);
  });

  test('expected verifier registry digest mismatch fails before reservation', async () => {
    const h = harness();
    const result = await executeQualifiedMerge(
      validEvidence({ expected_verifier_registry_digest: 'f'.repeat(64) }),
      h.deps
    );
    expect(result.merged).toBe(false);
    expect(result.action).toBe('permit_denied');
    expect(result.reason).toBe('identity_recheck_failed:auth_verifier_registry_digest_mismatch');
    expect(h.deps.reserveEffect).not.toHaveBeenCalled();
    expect(h.calls).not.toContain('mergeAdapter');
    expect(h.deps.reconcile).not.toHaveBeenCalled();
  });

  test('malformed expected verifier digest denies at assessment', async () => {
    const h = harness();
    const result = await executeQualifiedMerge(
      validEvidence({ expected_verifier_registry_digest: 'ZZ' }),
      h.deps
    );
    expect(result.merged).toBe(false);
    expect(result.action).toBe('denied');
    expect(result.reason).toBe('expected_verifier_registry_digest_malformed');
    expect(h.deps.preparePermit).not.toHaveBeenCalled();
    expect(h.calls).not.toContain('mergeAdapter');
  });
});
