import { createHash } from 'node:crypto';
import { z } from '@hono/zod-openapi';
import { resolveModelForNode } from '../model-override';
import { dagNodeSchema, deriveNodeExecutionRequirements } from '../schemas/dag-node';
import type {
  ExecutionCapability,
  OutcomeReasonCode,
  ProviderAttemptRecord,
  RunAuthorityRecord,
} from './types';

export const DYNAMIC_LANE_SCHEMA_VERSION = 'dynamic-lane-snapshot/v3' as const;
export const DYNAMIC_LANE_POLICY_VERSION = 'offline-jev-admission/v3' as const;
const QUESTION_VERSION = 'jev-choice/v1';
const PROFILE_VERSION = 'candidate-profile/v1';
const PACKET_VERSION = 'decision-evidence/v1';
const asciiCompare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const finiteNonnegative = z.number().finite().nonnegative();
const nonblank = z.string().trim().min(1);
const timestamp = z.string().datetime({ offset: true });

const authoritySchema: z.ZodType<RunAuthorityRecord> = z.object({
  runId: nonblank,
  dispatchId: nonblank,
  woId: nonblank,
  specSource: nonblank,
  specRevision: nonblank,
  specHash: nonblank,
  workflowName: nonblank,
  codebaseId: nonblank,
  canonicalRemote: nonblank,
  baseBranch: nonblank,
  baseSha: nonblank,
  runScopeSha: nonblank,
  headBranch: nonblank,
  worktreePath: nonblank,
  workflowRevision: nonblank,
  bundleRevision: nonblank,
  engineRevision: nonblank,
  runtimeImageRevision: z.string().nullable(),
  createdAt: timestamp,
});

const attemptSchema: z.ZodType<ProviderAttemptRecord> = z.object({
  attemptId: nonblank,
  runId: nonblank,
  nodeId: nonblank,
  attemptNumber: z.number().int().positive(),
  provider: nonblank,
  model: nonblank,
  declaredProvider: nonblank,
  declaredModel: nonblank,
  requiredCapabilities: z.array(
    z.enum(['text_generation', 'repo_read', 'repo_write', 'shell', 'network', 'browser'])
  ),
  startedAt: timestamp,
  completedAt: timestamp.nullable(),
  servedModelId: z.string().nullable(),
  outcomeClass: z
    .enum(['success', 'availability', 'quality', 'progress', 'quota', 'contradiction', 'cancelled'])
    .nullable(),
  reasonCode: z.string().nullable() as z.ZodType<OutcomeReasonCode | null>,
  resumeAt: timestamp.nullable(),
  supersedesAttemptId: z.string().nullable(),
});

const evidenceItemSchema = z.object({
  evidenceId: nonblank,
  sourceRef: nonblank,
  contentHash: nonblank,
  observedAt: timestamp,
  availableAt: timestamp,
  content: nonblank,
  kind: z.enum(['decision_time', 'later_outcome']).default('decision_time'),
});

const semanticTextSchema = z.object({
  version: nonblank,
  text: z.string(),
  sourceRef: nonblank,
  availableAt: timestamp,
});

const roleObjectiveSchema = semanticTextSchema.extend({
  role: nonblank,
  acceptanceCriteria: z.array(z.string()),
});

const candidateSchema = z.object({
  candidateId: nonblank,
  provider: nonblank,
  model: nonblank,
  routerAccountId: nonblank,
  workerAccountId: nonblank,
  registered: z.boolean(),
  capabilities: z.array(z.enum(['text', 'repositoryRead', 'repositoryWrite', 'shell'])),
  nextStepCost: finiteNonnegative.nullable(),
  family: z.string().nullable(),
});

const accountSchema = z.object({
  accountId: nonblank,
  limit: finiteNonnegative,
  spend: finiteNonnegative,
  commitments: finiteNonnegative,
  verificationAllowance: finiteNonnegative,
  capacity: z.enum(['healthy', 'exhausted', 'unknown', 'unavailable']),
  observedAt: timestamp.nullable(),
  expiresAt: timestamp.nullable(),
  resetAt: timestamp.nullable().optional(),
});

const profileSchema = z.object({
  candidateId: nonblank,
  profileVersion: nonblank,
  applicableRoles: z.array(nonblank),
  observations: z.array(
    z.object({ scope: nonblank, provenance: nonblank, availableAt: timestamp })
  ),
  sourceRefs: z.array(nonblank),
  availableAt: timestamp,
  limitations: z.array(nonblank),
});

const jevExchangeSchema = z.object({
  version: nonblank,
  origin: z.enum(['synthetic_jev', 'recorded_jev']),
  snapshotHash: nonblank,
  requestHash: nonblank,
  requestedModel: nonblank,
  returnedModel: nonblank,
  rubricVersion: nonblank,
  decidedAt: timestamp,
  choice: z.string().nullable(),
  abstain: z.boolean(),
  tied: z.boolean(),
  vendorConfidence: finiteNonnegative,
  distribution: z.record(finiteNonnegative),
  usage: z.record(z.unknown()).nullable(),
  latencyMs: finiteNonnegative.nullable(),
});

const dynamicLaneSnapshotStructuralSchema = z.object({
  schemaVersion: z.literal(DYNAMIC_LANE_SCHEMA_VERSION),
  evaluationTime: timestamp,
  runId: nonblank,
  nodeId: nonblank,
  scopeId: nonblank,
  aiRole: z.enum(['understand', 'plan', 'build', 'independent_review', 'verify', 'evidence_return']),
  node: dagNodeSchema,
  authority: authoritySchema.nullable(),
  expectedAuthority: z.object({ runScopeSha: nonblank, headBranch: nonblank }),
  custody: z.object({ known: z.boolean(), held: z.boolean() }),
  ready: z.boolean(),
  dependenciesComplete: z.boolean(),
  cancelled: z.boolean(),
  paused: z.boolean(),
  activeWriter: z.boolean(),
  cancellationAcknowledged: z.boolean(),
  candidates: z.array(candidateSchema),
  modelResolution: z.object({
    workflowProvider: nonblank,
    workflowModel: z.string().optional(),
    nodeProvider: z.string().optional(),
    nodeModel: z.string().optional(),
    personaModel: z.string().optional(),
    assistantModels: z.record(z.string()).optional(),
    operatorBinding: z.object({ provider: nonblank, model: nonblank }).nullable(),
  }),
  accounts: z.array(accountSchema),
  budget: z.object({
    limit: finiteNonnegative,
    spend: finiteNonnegative,
    commitments: finiteNonnegative,
    verificationAllowance: finiteNonnegative,
    routerCallAllowance: finiteNonnegative.nullable(),
  }),
  providerAttempts: z.array(attemptSchema),
  providerAttemptCeiling: z.number().int().nonnegative(),
  contributingFamilies: z.array(z.object({ family: z.string().nullable(), evidenceRef: nonblank })),
  currentArtifactHash: z.string().nullable(),
  reviewTargetHash: z.string().nullable(),
  taskBrief: semanticTextSchema.nullable(),
  roleObjective: roleObjectiveSchema.nullable(),
  decisionEvidence: z
    .object({
      version: nonblank,
      availability: z.enum(['supplied', 'no_prior_artifact']),
      items: z.array(evidenceItemSchema),
      noPriorArtifactReason: z.string().nullable(),
    })
    .nullable(),
  candidateProfiles: z.array(profileSchema).nullable(),
  policy: z.object({
    maxCapacityAgeMs: finiteNonnegative,
    maxJevAgeMs: finiteNonnegative,
    minimumWinningProbability: finiteNonnegative,
    minimumVendorConfidence: finiteNonnegative,
    requestedJevModel: nonblank,
    rubricVersion: nonblank,
  }),
  // The exchange is policy evidence, not part of the required structural envelope.
  // Its shape is evaluated into an abstention rather than turning a replay into a CLI error.
  jevExchange: z.unknown().nullable().optional(),
});

type JevExchange = z.infer<typeof jevExchangeSchema>;
export type DynamicLaneSnapshot = Omit<
  z.infer<typeof dynamicLaneSnapshotStructuralSchema>,
  'jevExchange'
> & { jevExchange?: JevExchange | null };
export const dynamicLaneSnapshotSchema = dynamicLaneSnapshotStructuralSchema as unknown as z.ZodType<DynamicLaneSnapshot>;
export type DynamicLaneDecision = 'propose' | 'wait' | 'abstain';
export interface DynamicLaneReceipt {
  schemaVersion: 'dynamic-lane-receipt/v3';
  policyVersion: typeof DYNAMIC_LANE_POLICY_VERSION;
  snapshotHash: string;
  requestHash: string | null;
  eligibleCandidateIds: string[];
  decision: DynamicLaneDecision;
  proposedBinding: { candidateId: string; provider: string; model: string } | null;
  decisionOrigin: 'none' | 'synthetic_jev' | 'recorded_jev';
  jevDisposition: string;
  candidateRejections: Record<string, string[]>;
  evidenceReferences: string[];
  requestedJevModel: string;
  returnedJevModel: string | null;
  questionVersion: typeof QUESTION_VERSION;
  distribution: Record<string, number> | null;
  usage: Record<string, unknown> | null;
  latencyMs: number | null;
  postExecutionReview: 'unissued';
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => asciiCompare(a, b))
        .map(([key, item]) => [key, canonical(item)])
    );
  }
  return value;
}

export function canonicalDynamicLaneJson(value: unknown): string {
  return `${JSON.stringify(canonical(value))}\n`;
}

function hash(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`;
}

function atOrBefore(value: string, evaluationTime: string): boolean {
  return Date.parse(value) <= Date.parse(evaluationTime);
}

function receiptBase(snapshot: DynamicLaneSnapshot, snapshotHash: string): DynamicLaneReceipt {
  return {
    schemaVersion: 'dynamic-lane-receipt/v3',
    policyVersion: DYNAMIC_LANE_POLICY_VERSION,
    snapshotHash,
    requestHash: null,
    eligibleCandidateIds: [],
    decision: 'abstain',
    proposedBinding: null,
    decisionOrigin: 'none',
    jevDisposition: 'not_evaluated',
    candidateRejections: {},
    evidenceReferences: [],
    requestedJevModel: snapshot.policy.requestedJevModel,
    returnedJevModel: null,
    questionVersion: QUESTION_VERSION,
    distribution: null,
    usage: null,
    latencyMs: null,
    postExecutionReview: 'unissued',
  };
}

export function evaluateDynamicLane(snapshot: DynamicLaneSnapshot): DynamicLaneReceipt {
  const decisionInputs = { ...snapshot, jevExchange: undefined };
  const snapshotHash = hash(decisionInputs);
  const out = receiptBase(snapshot, snapshotHash);
  const globalReasons: string[] = [];
  const semantic = snapshot.taskBrief;
  const objective = snapshot.roleObjective;
  const evidence = snapshot.decisionEvidence;

  if (snapshot.cancelled) globalReasons.push('cancelled');
  if (snapshot.paused) globalReasons.push('paused_for_human');
  if (!snapshot.ready) globalReasons.push('step_not_ready');
  if (!snapshot.dependenciesComplete) globalReasons.push('dependencies_incomplete');
  if (!snapshot.custody.known || !snapshot.custody.held) globalReasons.push('custody_missing');
  if (snapshot.activeWriter) globalReasons.push('active_writer');
  if (!snapshot.cancellationAcknowledged) globalReasons.push('cancellation_unacknowledged');
  if (!snapshot.authority) globalReasons.push('authority_missing');
  else {
    if (snapshot.authority.runId !== snapshot.runId) globalReasons.push('authority_run_mismatch');
    if (snapshot.authority.runScopeSha !== snapshot.expectedAuthority.runScopeSha)
      globalReasons.push('authority_scope_mismatch');
    if (snapshot.authority.headBranch !== snapshot.expectedAuthority.headBranch)
      globalReasons.push('authority_branch_mismatch');
  }
  if (!semantic?.text.trim()) globalReasons.push('task_brief_missing');
  if (!objective?.text.trim()) globalReasons.push('role_objective_missing');
  if (!objective?.acceptanceCriteria.some(item => item.trim()))
    globalReasons.push('acceptance_criteria_missing');
  if (objective && objective.role !== snapshot.aiRole) globalReasons.push('role_objective_mismatch');
  if (!evidence) globalReasons.push('decision_evidence_missing');
  else if (evidence.version !== PACKET_VERSION) globalReasons.push('unsupported_evidence_version');
  else if (
    evidence.availability === 'no_prior_artifact' &&
    (snapshot.aiRole !== 'understand' || !evidence.noPriorArtifactReason?.trim())
  )
    globalReasons.push('invalid_no_prior_artifact');
  else if (evidence.availability === 'supplied' && evidence.items.length === 0)
    globalReasons.push('decision_evidence_missing');

  const timedValues = [semantic?.availableAt, objective?.availableAt].filter(Boolean) as string[];
  if (timedValues.some(value => !atOrBefore(value, snapshot.evaluationTime)))
    globalReasons.push('future_evidence');
  for (const item of evidence?.items ?? []) {
    if (item.kind === 'later_outcome') globalReasons.push('later_outcome_evidence');
    if (!atOrBefore(item.availableAt, snapshot.evaluationTime) || !atOrBefore(item.observedAt, snapshot.evaluationTime))
      globalReasons.push('future_evidence');
    out.evidenceReferences.push(item.evidenceId);
  }

  const resolved = resolveModelForNode({
    nodeId: snapshot.nodeId,
    workflowProvider: snapshot.modelResolution.workflowProvider,
    workflowModel: snapshot.modelResolution.workflowModel,
    nodeProvider: snapshot.modelResolution.nodeProvider,
    nodeModel: snapshot.modelResolution.nodeModel,
    personaModel: snapshot.modelResolution.personaModel,
    assistantModels: snapshot.modelResolution.assistantModels,
  });
  const required = deriveNodeExecutionRequirements(snapshot.node);
  const accounts = new Map(snapshot.accounts.map(account => [account.accountId, account]));
  const profiles = new Map((snapshot.candidateProfiles ?? []).map(profile => [profile.candidateId, profile]));
  const attempts = snapshot.providerAttempts.filter(
    attempt => attempt.runId === snapshot.runId && attempt.nodeId === snapshot.nodeId
  );

  for (const candidate of [...snapshot.candidates].sort((a, b) => asciiCompare(a.candidateId, b.candidateId))) {
    const reasons = [...globalReasons];
    const profile = profiles.get(candidate.candidateId);
    if (!candidate.registered) reasons.push('provider_unregistered');
    if (required.some(capability => !candidate.capabilities.includes(capability)))
      reasons.push('capability_mismatch');
    const binding = snapshot.modelResolution.operatorBinding;
    if (binding && (candidate.provider !== binding.provider || candidate.model !== binding.model))
      reasons.push('operator_binding_mismatch');
    if (!binding && snapshot.modelResolution.nodeProvider && candidate.provider !== resolved.provider)
      reasons.push('resolved_provider_mismatch');
    if (!binding && snapshot.modelResolution.nodeModel && candidate.model !== resolved.model)
      reasons.push('resolved_model_mismatch');
    if (!profile) reasons.push('candidate_profile_missing');
    else {
      if (profile.profileVersion !== PROFILE_VERSION) reasons.push('unsupported_profile_version');
      if (!profile.applicableRoles.includes(snapshot.aiRole)) reasons.push('profile_role_mismatch');
      if (!atOrBefore(profile.availableAt, snapshot.evaluationTime)) reasons.push('future_profile');
      if (profile.observations.some(item => !atOrBefore(item.availableAt, snapshot.evaluationTime)))
        reasons.push('future_profile_observation');
    }
    if (candidate.nextStepCost === null || snapshot.budget.routerCallAllowance === null)
      reasons.push('cost_unknown');
    else {
      const total = candidate.nextStepCost + snapshot.budget.routerCallAllowance;
      if (
        snapshot.budget.spend + snapshot.budget.commitments +
          snapshot.budget.verificationAllowance + total > snapshot.budget.limit
      ) reasons.push('run_budget_exhausted');
      const charges = new Map<string, number>();
      charges.set(candidate.routerAccountId, snapshot.budget.routerCallAllowance);
      charges.set(candidate.workerAccountId, (charges.get(candidate.workerAccountId) ?? 0) + candidate.nextStepCost);
      for (const [accountId, charge] of charges) {
        const account = accounts.get(accountId);
        if (!account) { reasons.push(`account_missing:${accountId}`); continue; }
        if (account.capacity !== 'healthy') reasons.push(`capacity_${account.capacity}:${accountId}`);
        if (!account.observedAt || !account.expiresAt) reasons.push(`capacity_unknown:${accountId}`);
        else if (!atOrBefore(account.observedAt, snapshot.evaluationTime)) reasons.push(`capacity_future:${accountId}`);
        else if (Date.parse(snapshot.evaluationTime) >= Date.parse(account.expiresAt) ||
          Date.parse(snapshot.evaluationTime) - Date.parse(account.observedAt) > snapshot.policy.maxCapacityAgeMs)
          reasons.push(`capacity_stale:${accountId}`);
        if (account.spend + account.commitments + account.verificationAllowance + charge > account.limit)
          reasons.push(`account_budget_exhausted:${accountId}`);
      }
    }
    if (attempts.length >= snapshot.providerAttemptCeiling) reasons.push('provider_attempt_ceiling');
    if (snapshot.aiRole === 'independent_review') {
      if (!snapshot.currentArtifactHash || snapshot.currentArtifactHash !== snapshot.reviewTargetHash)
        reasons.push('review_artifact_mismatch');
      if (!candidate.family) reasons.push('reviewer_family_unknown');
      if (snapshot.contributingFamilies.some(item => !item.family)) reasons.push('contributor_family_unknown');
      if (candidate.family && snapshot.contributingFamilies.some(item => item.family === candidate.family))
        reasons.push('review_family_overlap');
    }
    out.candidateRejections[candidate.candidateId] = [...new Set(reasons)].sort();
  }

  out.eligibleCandidateIds = Object.entries(out.candidateRejections)
    .filter(([, reasons]) => reasons.length === 0)
    .map(([id]) => id)
    .sort();
  if (out.eligibleCandidateIds.length === 0) {
    out.decision = 'wait';
    out.jevDisposition = 'no_eligible_candidates';
    return out;
  }

  const request = {
    questionVersion: QUESTION_VERSION,
    snapshotHash,
    requestedModel: snapshot.policy.requestedJevModel,
    options: [...out.eligibleCandidateIds, 'abstain'],
    taskBrief: semantic,
    roleObjective: objective,
    decisionEvidence: evidence,
    profiles: out.eligibleCandidateIds.map(id => profiles.get(id)),
  };
  out.requestHash = hash(request);
  const rawExchange: unknown = snapshot.jevExchange;
  if (!rawExchange) { out.jevDisposition = 'missing_exchange'; return out; }
  const parsedExchange = jevExchangeSchema.safeParse(rawExchange);
  if (!parsedExchange.success) { out.jevDisposition = 'malformed_exchange'; return out; }
  const exchange = parsedExchange.data;
  out.decisionOrigin = exchange.origin;
  out.returnedJevModel = exchange.returnedModel;
  out.distribution = Object.fromEntries(Object.entries(exchange.distribution).sort());
  out.usage = exchange.usage;
  out.latencyMs = exchange.latencyMs;
  const invalid: string[] = [];
  if (exchange.version !== QUESTION_VERSION) invalid.push('wrong_exchange_version');
  if (exchange.snapshotHash !== snapshotHash) invalid.push('wrong_snapshot');
  if (exchange.requestHash !== out.requestHash) invalid.push('wrong_request');
  if (exchange.requestedModel !== snapshot.policy.requestedJevModel || exchange.returnedModel !== snapshot.policy.requestedJevModel)
    invalid.push('wrong_jev_model');
  if (exchange.rubricVersion !== snapshot.policy.rubricVersion) invalid.push('wrong_rubric');
  if (Date.parse(snapshot.evaluationTime) - Date.parse(exchange.decidedAt) > snapshot.policy.maxJevAgeMs || !atOrBefore(exchange.decidedAt, snapshot.evaluationTime))
    invalid.push('stale_or_future_exchange');
  if (exchange.tied) invalid.push('tied');
  if (exchange.vendorConfidence < snapshot.policy.minimumVendorConfidence) invalid.push('low_vendor_confidence');
  if (exchange.abstain || exchange.choice === null) invalid.push('jev_abstained');
  if (exchange.choice && !out.eligibleCandidateIds.includes(exchange.choice)) invalid.push('choice_not_eligible');
  const probability = exchange.choice ? exchange.distribution[exchange.choice] : undefined;
  if (probability === undefined || probability < snapshot.policy.minimumWinningProbability)
    invalid.push('low_winning_probability');
  const distributionKeys = Object.keys(exchange.distribution).sort();
  if (distributionKeys.join('|') !== [...out.eligibleCandidateIds, 'abstain'].sort().join('|'))
    invalid.push('distribution_options_mismatch');
  const sum = Object.values(exchange.distribution).reduce((total, value) => total + value, 0);
  if (Math.abs(sum - 1) > 0.000001) invalid.push('invalid_distribution');
  const selected = snapshot.candidates.find(item => item.candidateId === exchange.choice);
  if (invalid.length || !selected) {
    out.jevDisposition = [...new Set(invalid.length ? invalid : ['choice_not_found'])].sort().join(',');
    return out;
  }
  out.decision = 'propose';
  out.proposedBinding = { candidateId: selected.candidateId, provider: selected.provider, model: selected.model };
  out.jevDisposition = 'accepted';
  return out;
}

export type { ExecutionCapability, OutcomeReasonCode, ProviderAttemptRecord, RunAuthorityRecord };
