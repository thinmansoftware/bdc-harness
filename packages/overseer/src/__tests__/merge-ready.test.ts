import { describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  assessQualifiedMerge,
  classifyMergeExclusion,
  executeQualifiedMerge,
  handleMergeReady,
  isInternalMergeAllowed,
  type ExecuteQualifiedMergeDeps,
  type QualifiedMergeEvidence,
} from '../actions/merge-ready.ts';
import { loadOverseerActionPolicyRegistry } from '../policy-registry';
import type {
  M31ActionPermitV2,
  M31ActionTargetV2,
  M31ExecutionReceiptEventV2,
} from '@archon/core/db/m31-target-v2';
import type { ActionPolicyV2AuthorizationResult } from '../action-policy-v2';
import type { AuthorizeOverseerActionInput } from '../action-policy';
import type { FakeGitHubReceipt } from '../adapters/fake-github';
import type { PullRequestEvidence, WatchedRunRecord } from '../types.ts';

const HEAD = 'c'.repeat(40);
const BASE = 'd'.repeat(40);

const REGISTRY = loadOverseerActionPolicyRegistry({
  text: readFileSync(
    new URL('./fixtures/overseer-action-policy.synthetic.json', import.meta.url),
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
    },
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
  target_key: 'pull_request:bluedevilcollectibles/bdc-harness:42',
  target_digest: 'e'.repeat(64),
  snapshot_id: 'snapshot-1',
  action_kind: 'MERGE',
  capability: 'overseer.m31.merge',
  issued_at: '2026-07-15T11:59:00.000Z',
  valid_until: '2026-07-15T12:01:00.000Z',
};

function receiptEvent(): M31ExecutionReceiptEventV2 {
  return {
    receipt_event_id: 'receipt-1',
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
    adapter_name: 'fake-github',
    provider_operation: 'merge',
    external_effect_reference: null,
    reason: 'effect_reserved',
    evidence: {},
    previous_event_digest: null,
    event_digest: 'f'.repeat(64),
    created_at: '2026-07-15T12:00:00.000Z',
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
    policy_digest: 'a'.repeat(64),
    verifier_registry_digest: 'b'.repeat(64),
    audit_recorded: true,
  };
}

function fakeMergeReceipt(accepted: boolean): FakeGitHubReceipt {
  return {
    adapter: 'fake-github',
    accepted,
    reason: accepted ? 'fake_accepted' : 'action_identity_mismatch',
    authorization_reason: null,
    authorization_audit_recorded: true,
    audit_recorded: true,
    permit_id: 'permit-1',
    repository: 'bluedevilcollectibles/bdc-harness',
    pr_number: 42,
    head_sha: HEAD,
    base_branch: 'dev',
    base_sha: BASE,
    snapshot_id: 'snapshot-1',
    proposal_id: 'proposal-1',
    execution_id: 'execution-1',
    action_kind: 'MERGE',
    mutation_sent: false,
  };
}

const FAKE_AUTHORIZATION: AuthorizeOverseerActionInput = {
  requested_capability: 'merge',
  permit: {
    permit_id: 'permit-1',
    proposal_id: 'proposal-1',
    execution_id: 'execution-1',
    repository: 'bluedevilcollectibles/bdc-harness',
    pr_number: 42,
    head_sha: HEAD,
    base_branch: 'dev',
    base_sha: BASE,
    snapshot_id: 'snapshot-1',
    action_kind: 'MERGE',
    capability: 'overseer.m31.merge',
    issued_at: '2026-07-15T11:59:00.000Z',
    valid_until: '2026-07-15T12:01:00.000Z',
  },
  actor: 'overseer',
  correlation_id: 'corr-1',
};

interface Harness {
  deps: ExecuteQualifiedMergeDeps;
  calls: string[];
  mergeAccepted: boolean;
}

function harness(
  overrides: Partial<ExecuteQualifiedMergeDeps> = {},
  options: { mergeAccepted?: boolean } = {}
): Harness {
  const calls: string[] = [];
  const mergeAccepted = options.mergeAccepted ?? true;
  const deps: ExecuteQualifiedMergeDeps = {
    insertOverseerAction: mock(async () => {
      calls.push('insertOverseerAction');
    }),
    preparePermit: mock(async () => {
      calls.push('preparePermit');
      return { ok: true as const, permit: PERMIT, receipt: receiptEvent() };
    }),
    authorize: mock(async () => {
      calls.push('authorize');
      return allowedAuthorization();
    }),
    reserveEffect: mock(async () => {
      calls.push('reserveEffect');
      return { ok: true as const, value: receiptEvent() };
    }),
    attemptFakeMerge: mock(async () => {
      calls.push('attemptFakeMerge');
      return fakeMergeReceipt(mergeAccepted);
    }),
    fakeMergeAuthorization: FAKE_AUTHORIZATION,
    recordOutcome: mock(async () => {
      calls.push('recordOutcome');
      return { ok: true as const, value: receiptEvent() };
    }),
    reconcile: mock(async () => {
      calls.push('reconcile');
    }),
    ...overrides,
  };
  return { deps, calls, mergeAccepted };
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
  test('exact qualified fake merge produces reserved, succeeded, and reconciliation evidence', async () => {
    const h = harness();
    const result = await executeQualifiedMerge(validEvidence(), h.deps);

    expect(result.action).toBe('merged');
    expect(result.merged).toBe(true);
    expect(result.adapterCalled).toBe(true);
    expect(result.receipts).toEqual(['effect_reserved', 'effect_succeeded']);
    expect(h.deps.attemptFakeMerge).toHaveBeenCalledTimes(1);
    expect(h.deps.reconcile).toHaveBeenCalledTimes(1);
    expect(h.calls.filter(c => c === 'attemptFakeMerge')).toHaveLength(1);
    expect(h.calls).toContain('reserveEffect');
    expect(h.calls).toContain('recordOutcome');
  });

  // Stop 3 named test -- exact substring "prepare authorize reserve precede merge adapter"
  test('prepare authorize reserve precede merge adapter in the qualified path', async () => {
    const h = harness();
    await executeQualifiedMerge(validEvidence(), h.deps);

    const prepareIdx = h.calls.indexOf('preparePermit');
    const authorizeIdx = h.calls.indexOf('authorize');
    const reserveIdx = h.calls.indexOf('reserveEffect');
    const adapterIdx = h.calls.indexOf('attemptFakeMerge');

    expect(prepareIdx).toBeGreaterThanOrEqual(0);
    expect(prepareIdx).toBeLessThan(authorizeIdx);
    expect(authorizeIdx).toBeLessThan(reserveIdx);
    expect(reserveIdx).toBeLessThan(adapterIdx);
  });

  // Test 2
  test('zero required checks is not green and denies before the permit or adapter', async () => {
    // (a) zero checks in PR evidence -> not green at gate 1.
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
    expect(noChecks.deps.attemptFakeMerge).not.toHaveBeenCalled();

    // (b) green PR but zero required-check records -> denies at required_checks gate.
    const noRequired = harness();
    const result = await executeQualifiedMerge(
      validEvidence({ required_checks: [] }),
      noRequired.deps
    );
    expect(result.action).toBe('denied');
    expect(result.reason).toBe('zero_required_checks');
    expect(noRequired.deps.preparePermit).not.toHaveBeenCalled();
    expect(noRequired.deps.attemptFakeMerge).not.toHaveBeenCalled();
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
    expect(productionH.deps.attemptFakeMerge).not.toHaveBeenCalled();

    const unknownH = harness();
    const unknown = await executeQualifiedMerge(
      validEvidence({ resulting_deployment_effect: 'unknown' }),
      unknownH.deps
    );
    expect(unknown.action).toBe('circuit_open');
    expect(unknownH.deps.attemptFakeMerge).not.toHaveBeenCalled();

    for (const path of [
      'docs/board/motions/M-1.md',
      'migrations/041_x.sql',
      'app/.env',
      'secrets/credentials.json',
    ]) {
      const h = harness();
      const result = await executeQualifiedMerge(validEvidence({ changed_files: [path] }), h.deps);
      expect(result.action).toBe('denied');
      expect(h.deps.attemptFakeMerge).not.toHaveBeenCalled();
    }
  });

  // Test 4
  test('exact-state drift stops before the adapter', async () => {
    // Drift detected by the pure final-compare gate.
    const driftH = harness();
    const drift = await executeQualifiedMerge(
      validEvidence({ final_state_consistent: false }),
      driftH.deps
    );
    expect(drift.reason).toBe('exact_state_drift');
    expect(driftH.deps.preparePermit).not.toHaveBeenCalled();
    expect(driftH.deps.attemptFakeMerge).not.toHaveBeenCalled();

    // Drift detected by the v2 permit chain (compare-and-consume failure).
    const permitDriftH = harness({
      preparePermit: mock(async () => ({
        ok: false as const,
        failure: 'live_state_mismatch' as const,
      })),
    });
    const permitDrift = await executeQualifiedMerge(validEvidence(), permitDriftH.deps);
    expect(permitDrift.action).toBe('permit_denied');
    expect(permitDrift.adapterCalled).toBe(false);
    expect(permitDriftH.deps.attemptFakeMerge).not.toHaveBeenCalled();
  });

  // Finding 1: non-internal repository denial proven at the executor, not just
  // via the isInternalMergeAllowed() predicate. No permit or adapter is reached.
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
    expect(h.deps.attemptFakeMerge).not.toHaveBeenCalled();
  });

  // Finding 2: a denied authorization (allowed: false) fails closed after the
  // permit but before reservation and the adapter.
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
    expect(h.deps.attemptFakeMerge).not.toHaveBeenCalled();
    expect(h.deps.recordOutcome).not.toHaveBeenCalled();
  });

  // Finding 3: a failed effect reservation (ok: false) fails closed after
  // authorization but before the adapter is ever reached.
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
    expect(h.deps.attemptFakeMerge).not.toHaveBeenCalled();
    expect(h.deps.recordOutcome).not.toHaveBeenCalled();
  });

  // Test 5
  test('missing or correlated Fusion/verifier stops with no adapter call', async () => {
    const cases: Partial<QualifiedMergeEvidence>[] = [
      { fusion: null },
      {
        fusion: {
          present: true,
          components: ['only-one'],
          raw_dissent_recorded: false,
          cost_recorded: true,
          verifier_correlated: false,
          hidden_model_substitution: false,
        },
      },
      {
        fusion: {
          present: true,
          components: ['a', 'b'],
          raw_dissent_recorded: true,
          cost_recorded: true,
          verifier_correlated: true,
          hidden_model_substitution: false,
        },
      },
      {
        fusion: {
          present: true,
          components: ['a', 'b'],
          raw_dissent_recorded: true,
          cost_recorded: true,
          verifier_correlated: false,
          hidden_model_substitution: true,
        },
      },
    ];
    for (const override of cases) {
      const h = harness();
      const result = await executeQualifiedMerge(validEvidence(override), h.deps);
      expect(result.action).toBe('denied');
      expect(result.adapterCalled).toBe(false);
      expect(h.deps.attemptFakeMerge).not.toHaveBeenCalled();
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
    expect(h.deps.attemptFakeMerge).not.toHaveBeenCalled();
  });

  test('a rejected fake merge is recorded and not reported as merged', async () => {
    const h = harness({}, { mergeAccepted: false });
    const result = await executeQualifiedMerge(validEvidence(), h.deps);
    expect(result.action).toBe('merge_failed');
    expect(result.merged).toBe(false);
    expect(result.adapterCalled).toBe(true);
    expect(h.deps.recordOutcome).not.toHaveBeenCalled();
  });

  test('handleMergeReady delegates to the gated executor', async () => {
    const h = harness();
    const result = await handleMergeReady(validEvidence(), h.deps);
    expect(result.merged).toBe(true);
    expect(h.deps.attemptFakeMerge).toHaveBeenCalledTimes(1);
  });
});
