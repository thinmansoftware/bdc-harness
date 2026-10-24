import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import fixtureJson from './fixtures/dynamic-lane/eligible-synthetic.json';
import haikuFixture from './fixtures/dynamic-lane/eligible-haiku-synthetic.json';
import {
  canonicalDynamicLaneJson,
  dynamicLaneSnapshotSchema,
  evaluateDynamicLane,
  type DynamicLaneSnapshot,
  type DynamicLaneV4Snapshot,
} from './dynamic-lane-admission';

const clone = (): DynamicLaneSnapshot =>
  dynamicLaneSnapshotSchema.parse(structuredClone(fixtureJson)) as DynamicLaneSnapshot;

const v4 = (): DynamicLaneV4Snapshot =>
  dynamicLaneSnapshotSchema.parse(structuredClone(haikuFixture)) as DynamicLaneV4Snapshot;

function withHaikuDecision(input: DynamicLaneV4Snapshot, routeIndex = 0): DynamicLaneV4Snapshot {
  const first = evaluateDynamicLane(input);
  if (!first.requestHash) return input;
  input.decisionExchanges = input.routingResourcePlan
    .slice(0, routeIndex + 1)
    .map((route, index) => ({
      decisionId: input.decisionId,
      snapshotHash: first.snapshotHash,
      requestHash: first.requestHash,
      routeId: route.routeId,
      engineId: route.engineId,
      adapterId: route.adapterId,
      transport: route.transport,
      accountId: route.accountId,
      origin: 'synthetic',
      requestedModel: route.requestedModel,
      servedModel: route.requestedModel,
      attemptId: `attempt-${index}`,
      startedAt: `2026-10-17T11:59:0${index * 2}.000Z`,
      completedAt: `2026-10-17T11:59:0${index * 2 + 1}.000Z`,
      usage: { inputTokens: 20, outputTokens: 8 },
      latencyMs: 10,
      cashCost: null,
      outcome: index === routeIndex ? 'success' : 'availability',
      response:
        index === routeIndex
          ? {
              schemaVersion: 'dynamic-lane-response/v1',
              decisionId: input.decisionId,
              snapshotHash: first.snapshotHash,
              requestHash: first.requestHash,
              choice: 'select',
              candidateId: 'codex-plan',
              rationale: 'Use eligible worker.',
              evidenceReferences: ['evidence-001'],
            }
          : null,
    }));
  return input;
}

describe('model-neutral Haiku offline v4', () => {
  test.each(['v3', 'v4'] as const)('%s enforces the applicable assistant model pin', version => {
    const input = version === 'v3' ? clone() : v4();
    input.modelResolution.workflowProvider = 'claude';
    input.modelResolution.nodeProvider = 'codex';
    input.modelResolution.assistantModels = { codex: 'gpt-alternate' };
    input.candidates.push({
      ...input.candidates[0]!,
      candidateId: 'codex-alternate',
      model: 'gpt-alternate',
    });
    input.candidateProfiles!.push({
      ...input.candidateProfiles![0]!,
      candidateId: 'codex-alternate',
    });
    input.candidateAllowlist.push('codex-alternate');
    const wrongInput =
      input.schemaVersion === 'dynamic-lane-snapshot/v4'
        ? withHaikuDecision(input)
        : withAcceptedExchange(input);
    if (wrongInput.schemaVersion === 'dynamic-lane-snapshot/v3')
      wrongInput.jevExchange!.distribution = {
        'codex-plan': 0.8,
        'codex-alternate': 0.15,
        abstain: 0.05,
      };
    const wrongChoice = evaluateDynamicLane(wrongInput);
    expect(wrongChoice.eligibleCandidateIds).toEqual(['codex-alternate']);
    expect(wrongChoice.proposedBinding).toBeNull();
    expect(wrongChoice.candidateRejections['codex-plan']).toContain('resolved_model_mismatch');
    input.modelResolution.assistantModels.codex = 'gpt-synthetic';
    const acceptedInput =
      input.schemaVersion === 'dynamic-lane-snapshot/v4'
        ? withHaikuDecision(input)
        : withAcceptedExchange(input);
    if (acceptedInput.schemaVersion === 'dynamic-lane-snapshot/v3')
      acceptedInput.jevExchange!.distribution = { 'codex-plan': 0.95, abstain: 0.05 };
    const accepted = evaluateDynamicLane(acceptedInput);
    expect(accepted.decision).toBe('propose');
    expect(accepted.proposedBinding?.candidateId).toBe('codex-plan');
    expect(accepted.eligibleCandidateIds).toEqual(['codex-plan']);
    input.modelResolution.assistantModels.codex = 'unqualified-model';
    expect(evaluateDynamicLane(input).eligibleCandidateIds).toEqual([]);
  });

  test.each(['v3', 'v4'] as const)('%s assistant pins follow resolver precedence', version => {
    const input = version === 'v3' ? clone() : v4();
    input.modelResolution.assistantModels = { codex: 'unused-model', claude: 'unused-model' };
    // The workflow model takes precedence for the workflow's provider.
    expect(evaluateDynamicLane(input).eligibleCandidateIds).toEqual(['claude-plan', 'codex-plan']);
    input.modelResolution.workflowProvider = 'claude';
    input.modelResolution.nodeProvider = 'codex';
    input.modelResolution.nodeModel = 'gpt-synthetic';
    expect(evaluateDynamicLane(input).eligibleCandidateIds).toEqual(['codex-plan']);
    input.modelResolution.nodeModel = 'different-node-model';
    input.modelResolution.personaModel = 'gpt-synthetic';
    expect(evaluateDynamicLane(input).eligibleCandidateIds).toEqual(['codex-plan']);
    input.modelResolution.operatorBinding = { provider: 'claude', model: 'claude-synthetic' };
    expect(evaluateDynamicLane(input).eligibleCandidateIds).toEqual(['claude-plan']);
    input.modelResolution.operatorBinding = null;
    delete input.modelResolution.nodeModel;
    delete input.modelResolution.personaModel;
    input.modelResolution.assistantModels = { claude: 'unrelated-provider-model' };
    expect(evaluateDynamicLane(input).eligibleCandidateIds).toEqual(['codex-plan']);
  });

  test.each(['__proto__', 'constructor'])(
    'assistant maps preserve a literal provider key %s without inherited bindings',
    provider => {
      for (const input of [clone(), v4()]) {
        input.modelResolution.workflowProvider = 'claude';
        input.modelResolution.nodeProvider = provider;
        input.modelResolution.assistantModels = Object.fromEntries([[provider, 'gpt-synthetic']]);
        input.candidates.forEach(candidate => (candidate.provider = provider));
        const parsed = dynamicLaneSnapshotSchema.parse(input);
        expect(evaluateDynamicLane(parsed).eligibleCandidateIds).toEqual(['codex-plan']);
        parsed.modelResolution.assistantModels = {};
        expect(evaluateDynamicLane(parsed).eligibleCandidateIds).toEqual([
          'claude-plan',
          'codex-plan',
        ]);
      }
    }
  );

  test.each(['__proto__', 'constructor', 'toString'])(
    'candidate %s preserves eligibility, distribution and rejection evidence',
    candidateId => {
      for (const input of [clone(), v4()]) {
        input.candidateAllowlist = [candidateId];
        input.candidates[0]!.candidateId = candidateId;
        input.candidateProfiles![0]!.candidateId = candidateId;
        const distribution = Object.fromEntries([
          [candidateId, 0.95],
          ['abstain', 0.05],
        ]);
        if (input.schemaVersion === 'dynamic-lane-snapshot/v4') {
          withHaikuDecision(input);
          const attempt = input.decisionExchanges[0] as Record<string, unknown>;
          (attempt.response as Record<string, unknown>).candidateId = candidateId;
          attempt.distribution = distribution;
        } else {
          input.jevExchange = withAcceptedExchange(input, candidateId).jevExchange;
          input.jevExchange!.distribution = distribution;
        }
        const out = evaluateDynamicLane(input);
        expect(out.decision).toBe('propose');
        expect(out.proposedBinding?.candidateId).toBe(candidateId);
        expect(out.eligibleCandidateIds).toEqual([candidateId]);
        expect(Object.hasOwn(out.candidateRejections, candidateId)).toBe(true);
        expect(out.candidateRejections[candidateId]).toEqual([]);
        const serialized = JSON.parse(canonicalDynamicLaneJson(out));
        expect(Object.hasOwn(serialized.distribution, candidateId)).toBe(true);
        expect(serialized.distribution[candidateId]).toBe(0.95);
        if (input.schemaVersion === 'dynamic-lane-snapshot/v4') {
          input.priorDecisions!.entries.push({
            decisionId: input.decisionId,
            snapshotHash: out.snapshotHash,
            receipt: serialized,
            exchanges: structuredClone(input.decisionExchanges),
          });
          expect(evaluateDynamicLane(input).decision).toBe('propose');
          input.priorDecisions!.entries = [];
        }
        input.candidateProfiles = [];
        const refused = evaluateDynamicLane(input);
        expect(refused.proposedBinding).toBeNull();
        expect(Object.hasOwn(refused.candidateRejections, candidateId)).toBe(true);
        expect(refused.candidateRejections[candidateId]).toContain('candidate_profile_missing');
        expect(
          JSON.parse(canonicalDynamicLaneJson(refused)).candidateRejections[candidateId]
        ).toContain('candidate_profile_missing');
      }
    }
  );

  test.each(['__proto__', 'constructor', 'toString'])(
    'actual charges remain numeric own properties for account %s',
    accountId => {
      for (const routeIndex of [0, 1, 2]) {
        for (const cashCost of [null, 0.25]) {
          const input = v4();
          const route = input.routingResourcePlan[routeIndex]!;
          input.accounts.find(account => account.accountId === route.accountId)!.accountId =
            accountId;
          route.accountId = accountId;
          withHaikuDecision(input, routeIndex);
          (input.decisionExchanges[routeIndex] as Record<string, unknown>).cashCost = cashCost;
          input.decisionExchanges.push(structuredClone(input.decisionExchanges[routeIndex]));
          const out = evaluateDynamicLane(input);
          expect(out.decision).toBe('propose');
          expect(Object.hasOwn(out.charges, accountId)).toBe(true);
          expect(out.charges[accountId]).toBe(cashCost ?? route.estimatedCost!);
          expect(Number.isFinite(out.charges[accountId])).toBe(true);
          expect(out.routerCallsConsumed).toBe(routeIndex + 1);
          const serialized = JSON.parse(canonicalDynamicLaneJson(out));
          expect(Object.hasOwn(serialized.charges, accountId)).toBe(true);
          expect(serialized.charges[accountId]).toBe(cashCost ?? route.estimatedCost!);
          input.priorDecisions!.entries.push({
            decisionId: input.decisionId,
            snapshotHash: out.snapshotHash,
            receipt: serialized,
            exchanges: structuredClone(input.decisionExchanges),
          });
          const replayed = evaluateDynamicLane(input);
          expect(replayed.decision).toBe('propose');
          expect(replayed.charges[accountId]).toBe(out.charges[accountId]);
          const invalidPrior = structuredClone(input);
          const invalidReceipt = invalidPrior.priorDecisions!.entries[0]!.receipt as {
            charges: Record<string, unknown>;
          };
          invalidReceipt.charges[accountId] = -1;
          expect(evaluateDynamicLane(invalidPrior).disposition).toBe('invalid_prior_receipt');
          (input.decisionExchanges[routeIndex] as Record<string, unknown>).requestHash = 'wrong';
          const refused = evaluateDynamicLane(input);
          expect(refused.proposedBinding).toBeNull();
          expect(refused.charges[accountId]).toBe(out.charges[accountId]);
        }
      }
    }
  );

  test.each([
    ['availability', 1, 0],
    ['quota', 1, 0],
    ['availability', 2, 0],
    ['quota', 2, 0],
    ['availability', 2, 1],
    ['quota', 2, 1],
  ] as const)(
    'a transplanted %s failure cannot authorize route %i (attempt %i)',
    (outcome, routeIndex, failedIndex) => {
      const source = v4();
      source.decisionId = 'decision-source';
      withHaikuDecision(source, routeIndex);
      const target = v4();
      target.decisionId = 'decision-target';
      withHaikuDecision(target, routeIndex);
      target.decisionExchanges[failedIndex] = {
        ...(source.decisionExchanges[failedIndex] as object),
        outcome,
        origin: 'recorded',
      };
      const out = evaluateDynamicLane(target);
      expect(out.proposedBinding).toBeNull();
      expect(out.disposition).toBe('exchange_hash_or_decision_mismatch');
      expect(out.routerCallsConsumed).toBe(routeIndex + 1);
      expect(out.attemptHistory).toHaveLength(routeIndex + 1);
    }
  );

  test.each(['decisionId', 'snapshotHash', 'requestHash'] as const)(
    'every actual outcome requires its own matching %s',
    field => {
      for (const outcome of ['success', 'availability', 'quota', 'refused', 'cancelled'] as const) {
        const input = withHaikuDecision(v4(), outcome === 'success' ? 0 : 1);
        const attempt = input.decisionExchanges[0] as Record<string, unknown>;
        attempt.outcome = outcome;
        if (outcome !== 'success') attempt.response = null;
        attempt[field] = 'wrong-correlation';
        const mismatch = evaluateDynamicLane(input);
        expect(mismatch.proposedBinding).toBeNull();
        expect(mismatch.disposition).toBe('exchange_hash_or_decision_mismatch');
        expect(mismatch.routerCallsConsumed).toBe(input.decisionExchanges.length);
        expect(mismatch.charges['haiku-sub']).toBe(1);
        delete attempt[field];
        const missing = evaluateDynamicLane(input);
        expect(missing.proposedBinding).toBeNull();
        expect(missing.disposition).toBe('malformed_exchange');
      }
    }
  );

  test('an actual call retains consumption and charges even when served identity is rejected', () => {
    for (const servedModel of [null, 'wrong-model']) {
      const input = withHaikuDecision(v4());
      Object.assign(input.decisionExchanges[0] as object, { servedModel, cashCost: 1 });
      const out = evaluateDynamicLane(input);
      expect(out.proposedBinding).toBeNull();
      expect(out.routerCallsConsumed).toBe(1);
      expect(out.charges['haiku-sub']).toBe(1);
      expect(out.attemptHistory).toHaveLength(1);
    }
  });

  test('API billing evidence must exist before the API call starts', () => {
    const input = v4();
    input.routingResourcePlan[2]!.apiBillingEvidence!.availableAt = '2026-10-17T11:59:59.000Z';
    const out = evaluateDynamicLane(withHaikuDecision(input, 2));
    expect(out.proposedBinding).toBeNull();
    expect(out.routerCallsConsumed).toBe(3);
  });

  test('completed receipt mismatch is checked for abstentions and failed calls too', () => {
    const input = withHaikuDecision(v4());
    const accepted = evaluateDynamicLane(input);
    input.priorDecisions!.entries.push({
      decisionId: input.decisionId,
      snapshotHash: accepted.snapshotHash,
      receipt: accepted,
      exchanges: structuredClone(input.decisionExchanges),
    });
    const response = (input.decisionExchanges[0] as { response: Record<string, unknown> }).response;
    response.choice = 'abstain';
    response.candidateId = null;
    expect(evaluateDynamicLane(input).disposition).toBe('prior_receipt_mismatch');
    Object.assign(input.decisionExchanges[0] as object, { outcome: 'refused', response: null });
    expect(evaluateDynamicLane(input).disposition).toBe('prior_receipt_mismatch');
  });
  test('independent review refuses an empty contributor provenance list', () => {
    for (const input of [v4(), clone()]) {
      input.aiRole = 'independent_review';
      input.roleObjective!.role = input.aiRole;
      input.candidateProfiles!.forEach(p => p.applicableRoles.push(input.aiRole));
      input.currentArtifactHash = input.reviewTargetHash = 'sha256:artifact';
      input.contributingFamilies = [];
      const out = evaluateDynamicLane(input);
      expect(out.eligibleCandidateIds).toEqual([]);
      expect(out.candidateRejections['codex-plan']).toContain('contributor_provenance_missing');
    }
  });

  test('normalized worker facts do not retain the legacy single-router account field', () => {
    const out = evaluateDynamicLane(v4());
    expect(out.normalizedRequest!.eligibleCandidates[0]).not.toHaveProperty('routerAccountId');
  });

  test('persona pin takes precedence over the node model when filtering workers', () => {
    for (const input of [v4(), clone()]) {
      input.modelResolution.nodeModel = 'claude-synthetic';
      input.modelResolution.personaModel = 'gpt-synthetic';
      expect(evaluateDynamicLane(input).eligibleCandidateIds).toEqual(['codex-plan']);
      input.modelResolution.personaModel = 'unqualified-persona-model';
      expect(evaluateDynamicLane(input).eligibleCandidateIds).toEqual([]);
    }
  });

  test('actual node pins cannot be omitted or contradicted by resolution facts', () => {
    for (const input of [v4(), clone()]) {
      input.node = { ...input.node, provider: 'codex', model: 'gpt-synthetic' };
      expect(evaluateDynamicLane(input).eligibleCandidateIds).toEqual(['codex-plan']);
      input.modelResolution.nodeModel = 'different-node-model';
      expect(evaluateDynamicLane(input).eligibleCandidateIds).toEqual([]);
    }
  });

  test('quota failures retain charges and permit the next qualified route', () => {
    const input = withHaikuDecision(v4(), 1);
    Object.assign(input.decisionExchanges[0] as object, { outcome: 'quota', cashCost: 0.5 });
    const out = evaluateDynamicLane(input);
    expect(out.decision).toBe('propose');
    expect(out.engineId).toBe('luna');
    expect(out.routerCallsConsumed).toBe(2);
    expect(out.charges['haiku-sub']).toBe(0.5);
  });

  test('v4 optional distributions require the selected unique maximum', () => {
    for (const distribution of [
      { 'codex-plan': 0.5, 'claude-plan': 0.5, abstain: 0 },
      { 'codex-plan': 0.4, 'claude-plan': 0.6, abstain: 0 },
      { 'codex-plan': 0.4, 'claude-plan': 0.1, abstain: 0.5 },
    ]) {
      const input = withHaikuDecision(v4());
      Object.assign(input.decisionExchanges[0] as object, { distribution });
      expect(evaluateDynamicLane(input).proposedBinding).toBeNull();
    }
    const valid = withHaikuDecision(v4());
    Object.assign(valid.decisionExchanges[0] as object, {
      distribution: { 'codex-plan': 0.8, 'claude-plan': 0.15, abstain: 0.05 },
    });
    expect(evaluateDynamicLane(valid).decision).toBe('propose');
  });

  test.each([
    'understand',
    'plan',
    'build',
    'independent_review',
    'verify',
    'evidence_return',
  ] as const)('Haiku can select a qualified worker for %s', role => {
    const input = v4();
    input.aiRole = role;
    input.roleObjective!.role = role;
    input.candidateProfiles!.forEach(p => p.applicableRoles.push(role));
    if (role === 'independent_review') {
      input.currentArtifactHash = input.reviewTargetHash = 'sha256:artifact';
      input.contributingFamilies = [
        {
          family: 'google',
          evidenceRef: 'fixture:prior-builder',
          availableAt: '2026-10-17T11:00:00.000Z',
        },
      ];
    }
    expect(evaluateDynamicLane(withHaikuDecision(input)).decision).toBe('propose');
  });
  test('completed prior receipt is recomputed and replayed without double charging', () => {
    const input = withHaikuDecision(v4());
    const first = evaluateDynamicLane(input);
    input.priorDecisions!.entries.push({
      decisionId: input.decisionId,
      snapshotHash: first.snapshotHash,
      receipt: first,
      exchanges: input.decisionExchanges,
    });
    input.decisionExchanges = [];
    const replay = evaluateDynamicLane(input);
    expect(replay.decision).toBe('propose');
    expect(replay.routerCallsConsumed).toBe(first.routerCallsConsumed);
    expect(replay.charges).toEqual(first.charges);
    (
      input.priorDecisions!.entries[0]!.receipt as { proposedBinding: { model: string } }
    ).proposedBinding.model = 'forged';
    expect(evaluateDynamicLane(input).proposedBinding).toBeNull();
  });

  test.each([
    'capacity',
    'context',
    'router-expiry',
    'binding',
    'billing',
    'profile',
    'node',
    'reference',
    'later-outcome',
  ])('rejects missing or invalid %s evidence', change => {
    const input = v4();
    let index = 0;
    if (change === 'capacity') input.accounts[1]!.capacity = 'unknown';
    if (change === 'context') input.candidates[0]!.contextCompatible = null;
    if (change === 'router-expiry') input.accounts[0]!.expiresAt = input.evaluationTime;
    if (change === 'binding') input.routingResourcePlan[0]!.bindingEvidence = null;
    if (change === 'billing') {
      index = 2;
      input.routingResourcePlan[2]!.apiBillingEvidence = null;
    }
    if (change === 'profile') input.candidateProfiles![0]!.sourceRefs = [];
    if (change === 'node') input.nodeId = 'wrong';
    if (change === 'later-outcome') input.decisionEvidence!.items[0]!.kind = 'later_outcome';
    withHaikuDecision(input, index);
    if (change === 'reference')
      (
        input.decisionExchanges[0] as { response: { evidenceReferences: string[] } }
      ).response.evidenceReferences = ['unknown'];
    expect(evaluateDynamicLane(input).proposedBinding).toBeNull();
  });

  test('v3 missing new safety facts abstains while retaining legacy provenance', () => {
    for (const key of [
      'routerCallsConsumed',
      'routerCallCeiling',
      'monthlyBudgetPolicy',
      'priorDecisions',
      'legacyRoutingEvidence',
    ] as const) {
      const input = clone();
      delete input[key];
      const result = evaluateDynamicLane(input);
      expect(result.schemaVersion).toBe('dynamic-lane-receipt/v3');
      expect(result.request).toBeNull();
    }
  });
  test('Haiku is the first decision route and needs no invented confidence', () => {
    const out = evaluateDynamicLane(withHaikuDecision(v4()));
    expect(out.schemaVersion).toBe('dynamic-lane-receipt/v4');
    expect(out.engineId).toBe('haiku');
    expect(out.servedModel).toBe('claude-haiku-5-5');
    expect(out.decision).toBe('propose');
    expect(out.proposedBinding?.candidateId).toBe('codex-plan');
    expect(out.normalizedRequest?.allowedChoices).toEqual(['claude-plan', 'codex-plan', 'abstain']);
    expect(out.distribution).toBeNull();
    expect(out.postExecutionReview).toBe('unissued');
  });

  test.each([1, 2])(
    'availability failures permit route %i without resetting consumed calls',
    index => {
      const input = withHaikuDecision(v4(), index);
      const out = evaluateDynamicLane(input);
      expect(out.decision).toBe('propose');
      expect(out.engineId).toBe(index === 1 ? 'luna' : 'haiku');
      expect(out.transport).toBe(index === 1 ? 'subscription' : 'api');
      expect(out.routerCallsConsumed).toBe(index + 1);
    }
  );

  test('last permitted successful call is accepted; a later fallback cannot pass the ceiling', () => {
    const input = v4();
    input.routerCallsConsumed = 2;
    expect(evaluateDynamicLane(withHaikuDecision(input)).decision).toBe('propose');
    const exhausted = v4();
    exhausted.routerCallsConsumed = 3;
    expect(evaluateDynamicLane(exhausted).normalizedRequest).toBeNull();
    const tooMany = v4();
    tooMany.routerCallsConsumed = 2;
    expect(evaluateDynamicLane(withHaikuDecision(tooMany, 1)).proposedBinding).toBeNull();
  });

  test('a skipped known unavailable route consumes no call', () => {
    const input = v4();
    input.accounts[0]!.capacity = 'exhausted';
    withHaikuDecision(input, 1);
    input.decisionExchanges = input.decisionExchanges.slice(1);
    const out = evaluateDynamicLane(input);
    expect(out.decision).toBe('propose');
    expect(out.engineId).toBe('luna');
    expect(out.routerCallsConsumed).toBe(1);
  });

  test('distinct fallback accounts and failed-call charges retain the original candidate set', () => {
    const input = v4();
    input.accounts.find(a => a.accountId === 'luna-sub')!.limit = 2;
    const out = evaluateDynamicLane(withHaikuDecision(input, 1));
    expect(out.proposedBinding).toBeNull();
    expect(out.disposition).toContain('budget');
    const shared = v4();
    shared.routingResourcePlan[1]!.accountId = 'haiku-sub';
    shared.accounts[0]!.limit = 3.5;
    expect(evaluateDynamicLane(withHaikuDecision(shared, 1)).proposedBinding).toBeNull();
  });

  test.each([
    'refused',
    'malformed',
    'abstain',
    'unknown-served',
    'wrong-transport',
    'extra-response',
  ])('%s cannot trigger fallback or selection', change => {
    const input = withHaikuDecision(v4(), 1);
    const first = input.decisionExchanges[0] as Record<string, unknown>;
    const final = input.decisionExchanges[1] as Record<string, unknown>;
    if (change === 'refused') first.outcome = 'refused';
    if (change === 'malformed') {
      first.outcome = 'success';
      first.response = { choice: 7 };
    }
    if (change === 'abstain') {
      first.outcome = 'success';
      first.response = { ...(final.response as object), choice: 'abstain', candidateId: null };
    }
    if (change === 'unknown-served') first.servedModel = null;
    if (change === 'wrong-transport') final.transport = 'api';
    if (change === 'extra-response') (final.response as Record<string, unknown>).dispatch = true;
    expect(evaluateDynamicLane(input).proposedBinding).toBeNull();
  });

  test('identical delivered attempts are counted once; conflicting attempts and prior hashes reject', () => {
    const input = withHaikuDecision(v4());
    input.decisionExchanges.push(structuredClone(input.decisionExchanges[0]));
    const out = evaluateDynamicLane(input);
    expect(out.decision).toBe('propose');
    expect(out.routerCallsConsumed).toBe(1);
    (input.decisionExchanges[1] as Record<string, unknown>).servedModel = 'wrong';
    expect(evaluateDynamicLane(input).proposedBinding).toBeNull();
    const conflict = v4();
    conflict.priorDecisions!.entries.push({
      decisionId: conflict.decisionId,
      snapshotHash: 'sha256:wrong',
      receipt: null,
      exchanges: [],
    });
    expect(evaluateDynamicLane(conflict).normalizedRequest).toBeNull();
  });

  test('monthly uncapped policy never removes run/account limits, cost evidence or expiry', () => {
    const input = v4();
    input.budget.limit = 0;
    expect(evaluateDynamicLane(withHaikuDecision(input)).proposedBinding).toBeNull();
    const expired = v4();
    expired.monthlyBudgetPolicy!.effectiveUntil = '2026-10-16T00:00:00.000Z';
    expect(evaluateDynamicLane(expired).normalizedRequest).toBeNull();
    const unknown = v4();
    unknown.monthlyBudgetPolicy = null;
    expect(evaluateDynamicLane(unknown).normalizedRequest).toBeNull();
    const unknownCost = v4();
    unknownCost.routingResourcePlan[0]!.estimatedCost = null;
    expect(evaluateDynamicLane(unknownCost).proposedBinding).toBeNull();
  });

  test('Haiku and unqualified reviewer candidates cannot satisfy review', () => {
    for (const change of ['haiku', 'weak', 'missing', 'wrong-family', 'artifact']) {
      const input = v4();
      input.aiRole = 'independent_review';
      input.roleObjective!.role = input.aiRole;
      input.currentArtifactHash = input.reviewTargetHash = 'sha256:artifact';
      input.candidateProfiles!.forEach(p => p.applicableRoles.push(input.aiRole));
      input.contributingFamilies = [
        {
          family: 'anthropic',
          evidenceRef: 'fixture:contributor',
          availableAt: '2026-10-17T11:00:00.000Z',
        },
      ];
      if (change === 'haiku') input.candidates[0]!.model = 'claude-haiku-5-5';
      if (change === 'weak') input.candidates[0]!.reviewerQualification!.strength = 'weak';
      if (change === 'missing') input.candidates[0]!.reviewerQualification = null;
      if (change === 'wrong-family') input.candidates[0]!.family = 'anthropic';
      if (change === 'artifact') input.reviewTargetHash = 'wrong';
      const rejected = evaluateDynamicLane(withHaikuDecision(input));
      expect(rejected.proposedBinding).toBeNull();
      expect(rejected.normalizedRequest).toBeNull();
      expect(rejected.disposition).toBe('no_eligible_candidates');
    }
    const valid = v4();
    valid.aiRole = 'independent_review';
    valid.roleObjective!.role = valid.aiRole;
    valid.currentArtifactHash = valid.reviewTargetHash = 'sha256:artifact';
    valid.contributingFamilies = [
      {
        family: 'google',
        evidenceRef: 'fixture:prior-builder',
        availableAt: '2026-10-17T11:00:00.000Z',
      },
    ];
    valid.candidateProfiles!.forEach(p => p.applicableRoles.push(valid.aiRole));
    expect(evaluateDynamicLane(withHaikuDecision(valid)).decision).toBe('propose');
  });

  test.each(['cancelled', 'activeWriter', 'paused'])('v4 preserves %s hard gate', field => {
    const input = v4();
    Object.assign(input, { [field]: true });
    expect(evaluateDynamicLane(input).normalizedRequest).toBeNull();
  });
});

function withAcceptedExchange(
  input: DynamicLaneSnapshot,
  choice = 'codex-plan'
): DynamicLaneSnapshot {
  const first = evaluateDynamicLane(input);
  return {
    ...input,
    jevExchange: {
      version: 'jev-choice/v1',
      origin: 'synthetic_jev',
      snapshotHash: first.snapshotHash,
      requestHash: first.requestHash!,
      requestedModel: 'typesafe/jev-1.13',
      returnedModel: 'typesafe/jev-1.13',
      rubricVersion: 'rubric/v1',
      decidedAt: '2026-09-26T11:59:30.000Z',
      choice,
      abstain: false,
      tied: false,
      vendorConfidence: 0.9,
      distribution: {
        abstain: 0.05,
        'claude-plan': choice === 'claude-plan' ? 0.8 : 0.15,
        'codex-plan': choice === 'codex-plan' ? 0.8 : 0.15,
      },
      usage: null,
      latencyMs: null,
    },
  };
}

describe('dynamic lane offline admission scenarios', () => {
  test.each([
    ['excluded', 1000],
    ['excluded', null],
    ['allowlisted', 1000],
    ['allowlisted', null],
  ] as const)(
    'legacy monthly affordability ignores an %s alternative with cost %s',
    (authorization, alternativeCost) => {
      for (const reverse of [false, true]) {
        const input = clone();
        input.candidates[1]!.nextStepCost = alternativeCost;
        if (authorization === 'excluded') input.candidateAllowlist = ['codex-plan'];
        if (reverse) input.candidates.reverse();
        input.budget.limit = 2000;
        input.accounts.forEach(account => (account.limit = 2000));
        if (input.monthlyBudgetPolicy?.mode !== 'limited')
          throw new Error('Expected limited fixture');
        Object.assign(input.monthlyBudgetPolicy, { limit: 8, spend: 2, commitments: 1 });
        const ready = withAcceptedExchange(input);
        ready.jevExchange!.distribution = { 'codex-plan': 0.95, abstain: 0.05 };
        const out = evaluateDynamicLane(ready);
        expect(out.decision).toBe('propose');
        expect(out.proposedBinding?.candidateId).toBe('codex-plan');
        expect(out.eligibleCandidateIds).toEqual(['codex-plan']);
        expect(out.candidateRejections['codex-plan']).toEqual([]);
        expect(out.candidateRejections['claude-plan']).toContain(
          alternativeCost === null ? 'cost_unknown' : 'monthly_budget_exhausted'
        );
        if (authorization === 'excluded')
          expect(out.candidateRejections['claude-plan']).toContain('candidate_not_authorized');
        expect(out.request?.question.options.map(option => option.optionId)).toEqual([
          'codex-plan',
          'abstain',
        ]);
      }
    }
  );

  test.each([7, 8])('legacy monthly limit %i includes spend, commitments and allowances', limit => {
    const input = clone();
    if (input.monthlyBudgetPolicy?.mode !== 'limited') throw new Error('Expected limited fixture');
    Object.assign(input.monthlyBudgetPolicy, { limit, spend: 2, commitments: 1 });
    const out = evaluateDynamicLane(withAcceptedExchange(input));
    if (limit === 8) expect(out.decision).toBe('propose');
    else {
      expect(out.proposedBinding).toBeNull();
      expect(out.request).toBeNull();
      for (const candidate of input.candidates)
        expect(out.candidateRejections[candidate.candidateId]).toContain(
          'monthly_budget_exhausted'
        );
    }
  });

  test('legacy router evidence binds the candidate account', () => {
    const input = clone();
    input.legacyRoutingEvidence!.accountId = 'codex';
    const out = evaluateDynamicLane(withAcceptedExchange(input));
    expect(out.proposedBinding).toBeNull();
    expect(out.candidateRejections['codex-plan']).toContain('routing_account_mismatch');
  });

  test.each(['run', 'account', 'monthly'] as const)(
    'legacy evidenced router estimate cannot understate the %s budget',
    ledger => {
      const input = clone();
      input.legacyRoutingEvidence!.callEstimate = 100;
      input.budget.routerCallAllowance = 1;
      input.budget.limit = ledger === 'run' ? 10 : 1000;
      input.accounts[0]!.limit = ledger === 'account' ? 10 : 1000;
      if (ledger === 'monthly' && input.monthlyBudgetPolicy?.mode === 'limited')
        input.monthlyBudgetPolicy.limit = 10;
      const out = evaluateDynamicLane(withAcceptedExchange(input));
      expect(out.proposedBinding).toBeNull();
      expect(out.candidateRejections['codex-plan']).toContain(
        ledger === 'account' ? 'account_budget_exhausted:jev' : `${ledger}_budget_exhausted`
      );
    }
  );

  test.each([
    [1, 3, 3],
    [3, 1, 3],
  ])(
    'legacy request uses the conservative allowance %i / estimate %i',
    (allowance, estimate, cost) => {
      const input = clone();
      input.budget.routerCallAllowance = allowance;
      input.legacyRoutingEvidence!.callEstimate = estimate;
      const out = evaluateDynamicLane(withAcceptedExchange(input));
      expect(out.decision).toBe('propose');
      expect(out.request!.question.options[0]).toMatchObject({
        facts: { routerCallAllowance: cost, runBudget: { routerCallAllowance: cost } },
      });
    }
  );

  test('legacy evidenced router cost combines with a shared worker account exactly once', () => {
    const input = clone();
    input.legacyRoutingEvidence!.callEstimate = 3;
    input.candidates[0]!.workerAccountId = 'jev';
    input.accounts[0]!.limit = 7; // spend1 + verification1 + router3 + worker2
    expect(evaluateDynamicLane(withAcceptedExchange(input)).decision).toBe('propose');
    input.accounts[0]!.limit = 6;
    const out = evaluateDynamicLane(withAcceptedExchange(input));
    expect(out.proposedBinding).toBeNull();
    expect(out.candidateRejections['codex-plan']).toContain('account_budget_exhausted:jev');
  });

  test('review regression: distribution determines the unique winner', () => {
    for (const distribution of [
      { 'codex-plan': 0.5, 'claude-plan': 0.5, abstain: 0 },
      { 'codex-plan': 0.4, 'claude-plan': 0.6, abstain: 0 },
      { 'codex-plan': 0.4, 'claude-plan': 0.1, abstain: 0.5 },
    ]) {
      const input = clone();
      input.policy.minimumWinningProbability = 0.4;
      const ready = withAcceptedExchange(input);
      ready.jevExchange!.distribution = distribution;
      expect(evaluateDynamicLane(ready).proposedBinding).toBeNull();
    }
  });

  test('review regression: omitted and empty semantic evidence evaluates to abstention', () => {
    for (const key of ['taskBrief', 'roleObjective', 'decisionEvidence', 'candidateProfiles']) {
      for (const value of [undefined, null, {}]) {
        const input = { ...fixtureJson, [key]: value };
        const parsed = dynamicLaneSnapshotSchema.safeParse(input);
        expect(parsed.success).toBe(true);
        if (parsed.success) expect(evaluateDynamicLane(parsed.data).request).toBeNull();
      }
    }
  });

  test('review regression: decision calls have a separate ceiling', () => {
    const input = dynamicLaneSnapshotSchema.parse({
      ...fixtureJson,
      routerCallsConsumed: 3,
      routerCallCeiling: 3,
    });
    expect(evaluateDynamicLane(input).request).toBeNull();
  });
  test('explicit authorization admits only allowlisted candidates', () => {
    const input = clone();
    input.candidateAllowlist = ['codex-plan'];
    const out = evaluateDynamicLane(input);
    expect(out.eligibleCandidateIds).toEqual(['codex-plan']);
    expect(out.candidateRejections['claude-plan']).toContain('candidate_not_authorized');
    expect(out.request?.question.options.map(option => option.optionId)).toEqual([
      'codex-plan',
      'abstain',
    ]);

    input.candidateAllowlist = [];
    const empty = evaluateDynamicLane(input);
    expect(empty.eligibleCandidateIds).toEqual([]);
    expect(empty.request).toBeNull();
    expect(empty.requestHash).toBeNull();
  });

  test('authorization omission and duplicate authorization fail structural validation', () => {
    const missing = structuredClone(fixtureJson) as Record<string, unknown>;
    delete missing.candidateAllowlist;
    expect(dynamicLaneSnapshotSchema.safeParse(missing).success).toBe(false);
    const duplicate = structuredClone(fixtureJson);
    duplicate.candidateAllowlist.push(duplicate.candidateAllowlist[0]!);
    expect(dynamicLaneSnapshotSchema.safeParse(duplicate).success).toBe(false);
  });

  test('duplicate account and profile identities fail in both record orders', () => {
    for (const reverse of [false, true]) {
      const accounts = structuredClone(fixtureJson);
      const conflictingAccount = { ...accounts.accounts[0]!, capacity: 'exhausted' as const };
      accounts.accounts = reverse
        ? [conflictingAccount, ...accounts.accounts]
        : [...accounts.accounts, conflictingAccount];
      expect(dynamicLaneSnapshotSchema.safeParse(accounts).success).toBe(false);

      const profiles = structuredClone(fixtureJson);
      const conflictingProfile = {
        ...profiles.candidateProfiles[0]!,
        applicableRoles: ['build'],
      };
      profiles.candidateProfiles = reverse
        ? [conflictingProfile, ...profiles.candidateProfiles]
        : [...profiles.candidateProfiles, conflictingProfile];
      expect(dynamicLaneSnapshotSchema.safeParse(profiles).success).toBe(false);
    }
  });

  test('node identity and semantic packet versions fail before request construction', () => {
    const mismatch = clone();
    mismatch.nodeId = 'different-node';
    const mismatchOut = evaluateDynamicLane(mismatch);
    expect(mismatchOut.candidateRejections['codex-plan']).toEqual(['node_identity_mismatch']);
    expect(mismatchOut.request).toBeNull();

    const task = clone();
    task.taskBrief!.version = 'task-brief/v999';
    expect(evaluateDynamicLane(task).candidateRejections['codex-plan']).toContain(
      'unsupported_task_brief_version'
    );
    expect(evaluateDynamicLane(task).request).toBeNull();
    const role = clone();
    role.roleObjective!.version = 'role-objective/v999';
    expect(evaluateDynamicLane(role).candidateRejections['codex-plan']).toContain(
      'unsupported_role_objective_version'
    );
    expect(evaluateDynamicLane(role).request).toBeNull();
  });

  test('profiles require observations, sources, and limitations', () => {
    for (const [field, reason] of [
      ['observations', 'profile_observations_missing'],
      ['sourceRefs', 'profile_sources_missing'],
      ['limitations', 'profile_limitations_missing'],
    ] as const) {
      const input = clone();
      input.candidateProfiles![0]![field] = [];
      expect(evaluateDynamicLane(input).candidateRejections['codex-plan']).toContain(reason);
    }
    expect(evaluateDynamicLane(clone()).candidateRejections['codex-plan']).toEqual([]);
  });

  test('exposed offline Choice request is deterministic, sanitized, and hashes exactly', () => {
    const first = evaluateDynamicLane(clone());
    const second = evaluateDynamicLane(clone());
    expect(first.request).toEqual(second.request);
    expect(first.requestHash).toBe(second.requestHash);
    expect(first.request?.question.type).toBe('Choice');
    const requestBytes = canonicalDynamicLaneJson(first.request).trimEnd();
    expect(first.requestHash).toBe(
      `sha256:${createHash('sha256').update(requestBytes).digest('hex')}`
    );
    expect(first.request?.question.options.map(option => option.optionId)).toEqual([
      'claude-plan',
      'codex-plan',
      'abstain',
    ]);
    const codex = first.request?.question.options.find(option => option.optionId === 'codex-plan');
    expect(codex?.binding).toEqual({
      provider: 'codex',
      model: 'gpt-synthetic',
      routerAccountId: 'jev',
      workerAccountId: 'codex',
    });
    expect(codex?.facts).toMatchObject({
      nextStepCost: 2,
      routerCallAllowance: 1,
      runBudget: { verificationAllowance: 2 },
      routerAccount: { accountId: 'jev', capacity: 'healthy' },
      workerAccount: { accountId: 'codex', capacity: 'healthy' },
    });
    const rebound = withAcceptedExchange(clone());
    rebound.jevExchange!.requestHash = 'wrong';
    expect(evaluateDynamicLane(rebound).jevDisposition).toContain('wrong_request');
    const wrongRequested = withAcceptedExchange(clone());
    wrongRequested.jevExchange!.requestedModel = 'wrong';
    expect(evaluateDynamicLane(wrongRequested).jevDisposition).toContain('wrong_jev_model');
    const wrongReturned = withAcceptedExchange(clone());
    wrongReturned.jevExchange!.returnedModel = 'wrong';
    expect(evaluateDynamicLane(wrongReturned).jevDisposition).toContain('wrong_jev_model');
  });

  test('verification allowance and FuelGlass freshness remain hard gates', () => {
    const verification = clone();
    verification.budget.limit = 5;
    expect(evaluateDynamicLane(verification).candidateRejections['codex-plan']).toContain(
      'run_budget_exhausted'
    );
    for (const resetAt of ['2026-09-26T11:00:00.000Z', '2026-09-26T13:00:00.000Z']) {
      const stale = clone();
      stale.accounts[1]!.capacity = 'exhausted';
      stale.accounts[1]!.resetAt = resetAt;
      expect(evaluateDynamicLane(stale).eligibleCandidateIds).not.toContain('codex-plan');
    }
    const healthy = clone();
    healthy.accounts[1]!.capacity = 'healthy';
    healthy.accounts[1]!.observedAt = '2026-09-26T11:59:30.000Z';
    healthy.accounts[1]!.expiresAt = '2026-09-26T12:10:00.000Z';
    expect(evaluateDynamicLane(healthy).eligibleCandidateIds).toContain('codex-plan');
  });

  test('independent review rejects unknown contributor identity and keeps verdict unissued', () => {
    const input = clone();
    input.aiRole = 'independent_review';
    input.roleObjective!.role = 'independent_review';
    input.candidateProfiles!.forEach(profile => profile.applicableRoles.push('independent_review'));
    input.currentArtifactHash = input.reviewTargetHash = 'sha256:artifact';
    input.contributingFamilies = [
      {
        family: null,
        evidenceRef: 'fixture:unknown-served-identity',
        availableAt: '2026-09-26T11:00:00.000Z',
      },
    ];
    const out = evaluateDynamicLane(input);
    expect(out.candidateRejections['codex-plan']).toContain('contributor_family_unknown');
    expect(out.postExecutionReview).toBe('unissued');
  });

  test('router and worker account budgets are evaluated separately', () => {
    const router = clone();
    router.accounts[0]!.limit = 2;
    expect(evaluateDynamicLane(router).candidateRejections['codex-plan']).toContain(
      'account_budget_exhausted:jev'
    );
    const worker = clone();
    worker.accounts[1]!.limit = 3;
    expect(evaluateDynamicLane(worker).candidateRejections['codex-plan']).toContain(
      'account_budget_exhausted:codex'
    );
  });

  test('1: every AI role deterministically accepts an eligible Jev choice', () => {
    for (const role of [
      'understand',
      'plan',
      'build',
      'independent_review',
      'verify',
      'evidence_return',
    ] as const) {
      const input = clone();
      input.aiRole = role;
      input.roleObjective!.role = role;
      input.candidateProfiles!.forEach(profile => profile.applicableRoles.push(role));
      if (role === 'independent_review') {
        input.currentArtifactHash = input.reviewTargetHash = 'sha256:artifact';
        input.contributingFamilies = [
          {
            family: 'google',
            evidenceRef: 'fixture:prior-builder',
            availableAt: '2026-09-26T11:00:00.000Z',
          },
        ];
      }
      const ready = withAcceptedExchange(input);
      const a = canonicalDynamicLaneJson(evaluateDynamicLane(ready));
      const b = canonicalDynamicLaneJson(evaluateDynamicLane(ready));
      expect(a).toBe(b);
      expect(JSON.parse(a).decision).toBe('propose');
      expect(JSON.parse(a).postExecutionReview).toBe('unissued');
    }
  });

  test.each([
    ['cancelled', true],
    ['paused', true],
    ['dependenciesComplete', false],
  ] as const)('2: %s prevents a proposal', (field, value) => {
    const input = clone();
    Object.assign(input, { [field]: value });
    expect(evaluateDynamicLane(withAcceptedExchange(input)).proposedBinding).toBeNull();
  });

  test('3: authority and capacity evidence fail closed', () => {
    const missing = clone();
    missing.authority = null;
    expect(evaluateDynamicLane(missing).candidateRejections['codex-plan']).toContain(
      'authority_missing'
    );
    const stale = clone();
    stale.accounts[0]!.observedAt = '2026-09-26T10:00:00.000Z';
    expect(evaluateDynamicLane(stale).eligibleCandidateIds).toEqual([]);
  });

  test('4: run, shared-account, router, worker, and Jev budgets are charged correctly', () => {
    const input = clone();
    input.budget.limit = 3;
    expect(evaluateDynamicLane(input).eligibleCandidateIds).toEqual([]);
    const shared = clone();
    shared.candidates[0]!.workerAccountId = 'jev';
    shared.accounts[0]!.limit = 4;
    expect(evaluateDynamicLane(shared).candidateRejections['codex-plan']).toContain(
      'account_budget_exhausted:jev'
    );
    const exhaustedJev = clone();
    exhaustedJev.accounts[0]!.capacity = 'exhausted';
    expect(evaluateDynamicLane(exhaustedJev).eligibleCandidateIds).toEqual([]);
    const invalid = structuredClone(fixtureJson) as Record<string, unknown>;
    (invalid.budget as Record<string, unknown>).limit = -1;
    expect(dynamicLaneSnapshotSchema.safeParse(invalid).success).toBe(false);
    (invalid.budget as Record<string, unknown>).limit = Number.NaN;
    expect(dynamicLaneSnapshotSchema.safeParse(invalid).success).toBe(false);
  });

  test('5: total provider attempt ceiling is neither reset nor incremented', () => {
    const input = clone();
    const before = canonicalDynamicLaneJson(input.providerAttempts);
    input.providerAttemptCeiling = 0;
    expect(evaluateDynamicLane(input).eligibleCandidateIds).toEqual([]);
    expect(canonicalDynamicLaneJson(input.providerAttempts)).toBe(before);
  });

  test('6: writer and cancellation acknowledgement gates fail closed', () => {
    const input = clone();
    input.activeWriter = true;
    input.cancellationAcknowledged = false;
    const reasons = evaluateDynamicLane(input).candidateRejections['codex-plan']!;
    expect(reasons).toContain('active_writer');
    expect(reasons).toContain('cancellation_unacknowledged');
  });

  test('7: independent review enforces identity, family, and artifact constraints', () => {
    const input = clone();
    input.aiRole = 'independent_review';
    input.roleObjective!.role = 'independent_review';
    input.candidateProfiles!.forEach(p => p.applicableRoles.push('independent_review'));
    input.contributingFamilies = [
      {
        family: 'openai',
        evidenceRef: 'fixture:served',
        availableAt: '2026-09-26T11:00:00.000Z',
      },
    ];
    input.currentArtifactHash = 'sha256:a';
    input.reviewTargetHash = 'sha256:b';
    const out = evaluateDynamicLane(input);
    expect(out.candidateRejections['codex-plan']).toContain('review_family_overlap');
    expect(out.candidateRejections['codex-plan']).toContain('review_artifact_mismatch');
    expect(out.postExecutionReview).toBe('unissued');
  });

  test('7a: duplicate candidate IDs fail structural validation', () => {
    const input = structuredClone(fixtureJson);
    input.candidates.push(structuredClone(input.candidates[0]!));
    expect(dynamicLaneSnapshotSchema.safeParse(input).success).toBe(false);
  });

  test('7b: independent review requires candidate-to-family mapping evidence', () => {
    const input = clone();
    input.aiRole = 'independent_review';
    input.roleObjective!.role = 'independent_review';
    input.candidateProfiles!.forEach(profile => profile.applicableRoles.push('independent_review'));
    input.currentArtifactHash = input.reviewTargetHash = 'sha256:artifact';
    input.candidates[0]!.familyMappingEvidence = null;

    const out = evaluateDynamicLane(input);
    expect(out.candidateRejections['codex-plan']).toContain(
      'reviewer_family_mapping_evidence_missing'
    );
    expect(out.eligibleCandidateIds).not.toContain('codex-plan');
  });

  test('7c: independent review rejects future contributing-family evidence', () => {
    const input = clone();
    input.aiRole = 'independent_review';
    input.roleObjective!.role = 'independent_review';
    input.candidateProfiles!.forEach(profile => profile.applicableRoles.push('independent_review'));
    input.currentArtifactHash = input.reviewTargetHash = 'sha256:artifact';
    input.contributingFamilies = [
      {
        family: 'anthropic',
        evidenceRef: 'fixture:future-served-identity',
        availableAt: '2026-09-26T13:00:00.000Z',
      },
    ];

    const out = evaluateDynamicLane(input);
    expect(out.candidateRejections['codex-plan']).toContain('future_contributor_family_mapping');
    expect(out.eligibleCandidateIds).not.toContain('codex-plan');
  });

  test('8: operator binding and capability requirements override advice', () => {
    const input = clone();
    input.modelResolution.operatorBinding = { provider: 'claude', model: 'claude-synthetic' };
    input.candidates[1]!.capabilities = [];
    const out = evaluateDynamicLane(input);
    expect(out.candidateRejections['codex-plan']).toContain('operator_binding_mismatch');
    expect(out.candidateRejections['claude-plan']).toContain('capability_mismatch');
  });

  test('9: missing, mismatched, stale, tied, low-confidence, excluded, and abstaining Jev output waits', () => {
    expect(evaluateDynamicLane(clone()).jevDisposition).toBe('missing_exchange');
    const malformed = clone();
    (malformed as unknown as { jevExchange: unknown }).jevExchange = { choice: 7 };
    expect(evaluateDynamicLane(malformed).jevDisposition).toBe('malformed_exchange');
    for (const mutate of [
      (x: DynamicLaneSnapshot) => {
        x.jevExchange!.snapshotHash = 'wrong';
      },
      (x: DynamicLaneSnapshot) => {
        x.jevExchange!.decidedAt = '2026-09-26T10:00:00.000Z';
      },
      (x: DynamicLaneSnapshot) => {
        x.jevExchange!.tied = true;
      },
      (x: DynamicLaneSnapshot) => {
        x.jevExchange!.vendorConfidence = 0;
      },
      (x: DynamicLaneSnapshot) => {
        x.jevExchange!.choice = 'excluded';
      },
      (x: DynamicLaneSnapshot) => {
        x.jevExchange!.abstain = true;
      },
    ]) {
      const input = withAcceptedExchange(clone());
      mutate(input);
      expect(evaluateDynamicLane(input).proposedBinding).toBeNull();
    }
  });

  test('10: availability failure and elapsed reset require fresh capacity and never retry', () => {
    const input = clone();
    input.accounts[1]!.capacity = 'unavailable';
    input.accounts[1]!.resetAt = '2026-09-26T11:00:00.000Z';
    const out = evaluateDynamicLane(input);
    expect(out.candidateRejections['codex-plan']).toContain('capacity_unavailable:codex');
    expect(out.candidateRejections['codex-plan'].join(',')).not.toContain('coding');
    expect(input.providerAttempts).toEqual([]);
  });

  test('11: unknown/future/expired evidence abstains while malformed envelopes fail validation', () => {
    const future = clone();
    future.decisionEvidence!.items[0]!.availableAt = '2026-09-26T13:00:00.000Z';
    expect(evaluateDynamicLane(future).requestHash).toBeNull();
    const expired = clone();
    expired.accounts[0]!.expiresAt = expired.evaluationTime;
    expect(evaluateDynamicLane(expired).eligibleCandidateIds).toEqual([]);
    expect(dynamicLaneSnapshotSchema.safeParse({ schemaVersion: 'bad' }).success).toBe(false);
  });

  test('12: semantic evidence and profile omissions abstain before request construction', () => {
    for (const mutate of [
      (x: DynamicLaneSnapshot) => {
        x.taskBrief = null;
      },
      (x: DynamicLaneSnapshot) => {
        x.roleObjective!.text = ' ';
      },
      (x: DynamicLaneSnapshot) => {
        x.roleObjective!.acceptanceCriteria = [];
      },
      (x: DynamicLaneSnapshot) => {
        x.decisionEvidence = null;
      },
      (x: DynamicLaneSnapshot) => {
        x.candidateProfiles = [];
      },
      (x: DynamicLaneSnapshot) => {
        x.decisionEvidence!.items[0]!.kind = 'later_outcome';
      },
    ]) {
      const input = clone();
      mutate(input);
      expect(evaluateDynamicLane(input).requestHash).toBeNull();
    }
    const intake = clone();
    intake.aiRole = 'understand';
    intake.roleObjective!.role = 'understand';
    intake.candidateProfiles!.forEach(p => p.applicableRoles.push('understand'));
    intake.decisionEvidence = {
      version: 'decision-evidence/v1',
      availability: 'no_prior_artifact',
      items: [],
      noPriorArtifactReason: 'Initial intake.',
    };
    expect(evaluateDynamicLane(intake).eligibleCandidateIds.length).toBeGreaterThan(0);
  });
});
