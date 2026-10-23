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
const TASK_BRIEF_VERSION = 'task-brief/v1';
const ROLE_OBJECTIVE_VERSION = 'role-objective/v1';
const asciiCompare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const finiteNonnegative = z.number().finite().nonnegative();
const nonblank = z.string().trim().min(1);
const timestamp = z.string().datetime({ offset: true });
// z.record's parsed output drops own __proto__ keys; identifiers must survive validation.
const identifierRecord = <T extends z.ZodTypeAny>(
  valueSchema: T
): z.ZodType<Record<string, z.infer<T>>> =>
  z.custom<Record<string, z.infer<T>>>(value => z.record(valueSchema).safeParse(value).success);

const monthlyBudgetPolicySchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('uncapped'),
    effectiveFrom: timestamp,
    effectiveUntil: timestamp,
    authorizationRef: nonblank,
  }),
  z.object({
    mode: z.literal('limited'),
    effectiveFrom: timestamp,
    effectiveUntil: timestamp,
    authorizationRef: nonblank,
    limit: finiteNonnegative,
    spend: finiteNonnegative,
    commitments: finiteNonnegative,
  }),
]);
const qualificationSchema = z.object({
  strength: z.enum(['strong', 'weak']),
  version: nonblank,
  sourceRef: nonblank,
  availableAt: timestamp,
});
const priorDecisionsSchema = z.object({
  availableAt: timestamp,
  sourceRef: nonblank,
  entries: z.array(
    z.object({
      decisionId: nonblank,
      snapshotHash: nonblank,
      receipt: z.unknown().nullable(),
      exchanges: z.array(z.unknown()),
    })
  ),
});
const semanticUnknown = (value: unknown): unknown =>
  value === undefined ||
  value === null ||
  (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0)
    ? null
    : value;
const semanticSlot = <T extends z.ZodTypeAny>(
  schema: T
): z.ZodEffects<z.ZodNullable<T>, z.output<T> | null, unknown> =>
  z.preprocess(semanticUnknown, schema.nullable());

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
  family: nonblank.nullable(),
  transport: z.enum(['subscription', 'api']).nullable().optional(),
  contextCompatible: z.boolean().nullable().optional(),
  reviewerQualification: qualificationSchema.nullable().optional(),
  familyMappingEvidence: z
    .object({ family: nonblank, sourceRef: nonblank, availableAt: timestamp })
    .nullable(),
});

const accountSchema = z.object({
  accountId: nonblank,
  seat: nonblank.optional(),
  window: nonblank.optional(),
  sourceRef: nonblank.optional(),
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
  distribution: identifierRecord(finiteNonnegative),
  usage: z.record(z.unknown()).nullable(),
  latencyMs: finiteNonnegative.nullable(),
});

const candidateAllowlistSchema = z.array(nonblank).superRefine((values, ctx) => {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `duplicate candidateId: ${value}`,
        path: [index],
      });
    }
    seen.add(value);
  });
});

const dynamicLaneSnapshotStructuralSchema = z.object({
  schemaVersion: z.literal(DYNAMIC_LANE_SCHEMA_VERSION),
  evaluationTime: timestamp,
  runId: nonblank,
  nodeId: nonblank,
  scopeId: nonblank,
  aiRole: z.enum([
    'understand',
    'plan',
    'build',
    'independent_review',
    'verify',
    'evidence_return',
  ]),
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
  candidateAllowlist: candidateAllowlistSchema,
  candidates: z.array(candidateSchema).superRefine((candidates, ctx) => {
    const seen = new Set<string>();
    candidates.forEach((candidate, index) => {
      if (seen.has(candidate.candidateId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate candidateId: ${candidate.candidateId}`,
          path: [index, 'candidateId'],
        });
      }
      seen.add(candidate.candidateId);
    });
  }),
  modelResolution: z.object({
    workflowProvider: nonblank,
    workflowModel: z.string().optional(),
    nodeProvider: z.string().optional(),
    nodeModel: z.string().optional(),
    personaModel: z.string().optional(),
    assistantModels: identifierRecord(z.string()).optional(),
    operatorBinding: z.object({ provider: nonblank, model: nonblank }).nullable(),
  }),
  accounts: z.array(accountSchema).superRefine((accounts, ctx) => {
    const seen = new Set<string>();
    accounts.forEach((account, index) => {
      if (seen.has(account.accountId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate accountId: ${account.accountId}`,
          path: [index, 'accountId'],
        });
      }
      seen.add(account.accountId);
    });
  }),
  budget: z.object({
    limit: finiteNonnegative,
    spend: finiteNonnegative,
    commitments: finiteNonnegative,
    verificationAllowance: finiteNonnegative,
    routerCallAllowance: finiteNonnegative.nullable(),
  }),
  providerAttempts: z.array(attemptSchema),
  providerAttemptCeiling: z.number().int().nonnegative(),
  contributingFamilies: z.array(
    z.object({ family: z.string().nullable(), evidenceRef: nonblank, availableAt: timestamp })
  ),
  currentArtifactHash: z.string().nullable(),
  reviewTargetHash: z.string().nullable(),
  taskBrief: semanticSlot(semanticTextSchema),
  roleObjective: semanticSlot(roleObjectiveSchema),
  decisionEvidence: semanticSlot(
    z.object({
      version: nonblank,
      availability: z.enum(['supplied', 'no_prior_artifact']),
      items: z.array(evidenceItemSchema),
      noPriorArtifactReason: z.string().nullable(),
    })
  ),
  candidateProfiles: semanticSlot(
    z.array(profileSchema).superRefine((profiles, ctx) => {
      const seen = new Set<string>();
      profiles.forEach((profile, index) => {
        if (seen.has(profile.candidateId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `duplicate candidateId: ${profile.candidateId}`,
            path: [index, 'candidateId'],
          });
        }
        seen.add(profile.candidateId);
      });
    })
  ),
  routerCallsConsumed: z.number().int().nonnegative().optional(),
  routerCallCeiling: z.number().int().nonnegative().optional(),
  monthlyBudgetPolicy: monthlyBudgetPolicySchema.nullable().optional(),
  priorDecisions: priorDecisionsSchema.nullable().optional(),
  legacyRoutingEvidence: z
    .object({
      accountId: nonblank,
      callEstimate: finiteNonnegative,
      sourceRef: nonblank,
      availableAt: timestamp,
    })
    .nullable()
    .optional(),
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
export type DynamicLaneDecision = 'propose' | 'wait' | 'abstain';
type CandidateProfile = NonNullable<DynamicLaneSnapshot['candidateProfiles']>[number];
export interface JevChoiceRequest {
  questionVersion: typeof QUESTION_VERSION;
  requestedModel: string;
  snapshotHash: string;
  instructions: string[];
  state: {
    runId: string;
    nodeId: string;
    scopeId: string;
    aiRole: DynamicLaneSnapshot['aiRole'];
    evaluationTime: string;
  };
  question: {
    type: 'Choice';
    prompt: string;
    options: {
      optionId: string;
      candidateId: string | null;
      criteria: string[];
      binding: {
        provider: string;
        model: string;
        routerAccountId: string;
        workerAccountId: string;
      } | null;
      facts: Record<string, unknown> | null;
      profile: CandidateProfile | null;
    }[];
  };
  taskBrief: NonNullable<DynamicLaneSnapshot['taskBrief']>;
  roleObjective: NonNullable<DynamicLaneSnapshot['roleObjective']>;
  decisionEvidence: NonNullable<DynamicLaneSnapshot['decisionEvidence']>;
}
export interface DynamicLaneReceipt {
  schemaVersion: 'dynamic-lane-receipt/v3';
  policyVersion: typeof DYNAMIC_LANE_POLICY_VERSION;
  snapshotHash: string;
  requestHash: string | null;
  request: JevChoiceRequest | null;
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
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')}`;
}

function requiredValue<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) {
    throw new Error(`invariant violated: eligible request missing ${label}`);
  }
  return value;
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
    request: null,
    eligibleCandidateIds: [],
    decision: 'abstain',
    proposedBinding: null,
    decisionOrigin: 'none',
    jevDisposition: 'not_evaluated',
    candidateRejections: Object.create(null) as Record<string, string[]>,
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

function evaluateLegacyDynamicLane(
  snapshot: DynamicLaneSnapshot,
  gatesOnly = false
): DynamicLaneReceipt {
  const decisionInputs = { ...snapshot, jevExchange: undefined };
  const snapshotHash = hash(decisionInputs);
  const out = receiptBase(snapshot, snapshotHash);
  const globalReasons: string[] = [];
  const semantic = snapshot.taskBrief;
  const objective = snapshot.roleObjective;
  const evidence = snapshot.decisionEvidence;
  const monthly = snapshot.monthlyBudgetPolicy;
  // Legacy allowance and evidenced estimate must never lower one another's reservation.
  // The v4 gates-only caller accounts for its separate decision routes after worker admission.
  const routerCallAllowance =
    snapshot.budget.routerCallAllowance === null
      ? null
      : gatesOnly
        ? snapshot.budget.routerCallAllowance
        : snapshot.legacyRoutingEvidence
          ? Math.max(
              snapshot.budget.routerCallAllowance,
              snapshot.legacyRoutingEvidence.callEstimate
            )
          : null;

  if (snapshot.nodeId !== snapshot.node.id) {
    for (const candidate of snapshot.candidates) {
      out.candidateRejections[candidate.candidateId] = ['node_identity_mismatch'];
    }
    out.decision = 'wait';
    out.jevDisposition = 'no_eligible_candidates';
    return out;
  }

  if (!gatesOnly) {
    if (snapshot.routerCallsConsumed === undefined || snapshot.routerCallCeiling === undefined)
      globalReasons.push('router_limit_evidence_missing');
    else if (snapshot.routerCallsConsumed >= snapshot.routerCallCeiling)
      globalReasons.push('router_call_ceiling');
    if (
      !snapshot.legacyRoutingEvidence ||
      !atOrBefore(snapshot.legacyRoutingEvidence.availableAt, snapshot.evaluationTime)
    )
      globalReasons.push('routing_resource_evidence_missing');
    if (
      !snapshot.priorDecisions ||
      !atOrBefore(snapshot.priorDecisions.availableAt, snapshot.evaluationTime)
    )
      globalReasons.push('prior_decision_ledger_missing');
    if (
      !monthly ||
      !atOrBefore(monthly.effectiveFrom, snapshot.evaluationTime) ||
      atOrBefore(monthly.effectiveUntil, snapshot.evaluationTime)
    )
      globalReasons.push('monthly_budget_policy_missing_or_expired');
  }
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
  else if (semantic.version !== TASK_BRIEF_VERSION)
    globalReasons.push('unsupported_task_brief_version');
  if (!objective?.text.trim()) globalReasons.push('role_objective_missing');
  else if (objective.version !== ROLE_OBJECTIVE_VERSION)
    globalReasons.push('unsupported_role_objective_version');
  if (!objective?.acceptanceCriteria.some(item => item.trim()))
    globalReasons.push('acceptance_criteria_missing');
  if (objective && objective.role !== snapshot.aiRole)
    globalReasons.push('role_objective_mismatch');
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
    if (
      !atOrBefore(item.availableAt, snapshot.evaluationTime) ||
      !atOrBefore(item.observedAt, snapshot.evaluationTime)
    )
      globalReasons.push('future_evidence');
    out.evidenceReferences.push(item.evidenceId);
  }

  const actualNodeProvider = 'provider' in snapshot.node ? snapshot.node.provider : undefined;
  const actualNodeModel = 'model' in snapshot.node ? snapshot.node.model : undefined;
  const nodeProvider = snapshot.modelResolution.nodeProvider ?? actualNodeProvider;
  const nodeModel = snapshot.modelResolution.nodeModel ?? actualNodeModel;
  if (
    (actualNodeProvider &&
      snapshot.modelResolution.nodeProvider &&
      actualNodeProvider !== nodeProvider) ||
    (actualNodeModel && snapshot.modelResolution.nodeModel && actualNodeModel !== nodeModel)
  )
    globalReasons.push('node_resolution_facts_mismatch');
  const assistantModels: Record<string, string> = Object.assign(
    Object.create(null),
    snapshot.modelResolution.assistantModels
  );
  const resolved = resolveModelForNode({
    nodeId: snapshot.nodeId,
    workflowProvider: snapshot.modelResolution.workflowProvider,
    workflowModel: snapshot.modelResolution.workflowModel,
    nodeProvider,
    nodeModel,
    personaModel: snapshot.modelResolution.personaModel,
    assistantModels,
  });
  const assistantModel =
    resolved.provider !== snapshot.modelResolution.workflowProvider
      ? assistantModels[resolved.provider]
      : undefined;
  const required = deriveNodeExecutionRequirements(snapshot.node);
  const accounts = new Map(snapshot.accounts.map(account => [account.accountId, account]));
  const profiles = new Map(
    (snapshot.candidateProfiles ?? []).map(profile => [profile.candidateId, profile])
  );
  const attempts = snapshot.providerAttempts.filter(
    attempt => attempt.runId === snapshot.runId && attempt.nodeId === snapshot.nodeId
  );

  for (const candidate of [...snapshot.candidates].sort((a, b) =>
    asciiCompare(a.candidateId, b.candidateId)
  )) {
    const reasons = [...globalReasons];
    const profile = profiles.get(candidate.candidateId);
    if (!snapshot.candidateAllowlist.includes(candidate.candidateId))
      reasons.push('candidate_not_authorized');
    if (!candidate.registered) reasons.push('provider_unregistered');
    if (required.some(capability => !candidate.capabilities.includes(capability)))
      reasons.push('capability_mismatch');
    const binding = snapshot.modelResolution.operatorBinding;
    if (binding && (candidate.provider !== binding.provider || candidate.model !== binding.model))
      reasons.push('operator_binding_mismatch');
    if (!binding && nodeProvider && candidate.provider !== resolved.provider)
      reasons.push('resolved_provider_mismatch');
    if (
      !binding &&
      (snapshot.modelResolution.personaModel !== undefined ||
        nodeModel !== undefined ||
        assistantModel !== undefined) &&
      candidate.model !== resolved.model
    )
      reasons.push('resolved_model_mismatch');
    if (!profile) reasons.push('candidate_profile_missing');
    else {
      if (profile.profileVersion !== PROFILE_VERSION) reasons.push('unsupported_profile_version');
      if (profile.observations.length === 0) reasons.push('profile_observations_missing');
      if (profile.sourceRefs.length === 0) reasons.push('profile_sources_missing');
      if (profile.limitations.length === 0) reasons.push('profile_limitations_missing');
      if (!profile.applicableRoles.includes(snapshot.aiRole)) reasons.push('profile_role_mismatch');
      if (!atOrBefore(profile.availableAt, snapshot.evaluationTime)) reasons.push('future_profile');
      if (profile.observations.some(item => !atOrBefore(item.availableAt, snapshot.evaluationTime)))
        reasons.push('future_profile_observation');
    }
    if (!gatesOnly && snapshot.legacyRoutingEvidence?.accountId !== candidate.routerAccountId)
      reasons.push('routing_account_mismatch');
    if (candidate.nextStepCost === null || routerCallAllowance === null)
      reasons.push('cost_unknown');
    else {
      const total = candidate.nextStepCost + routerCallAllowance;
      if (
        !gatesOnly &&
        monthly?.mode === 'limited' &&
        monthly.spend + monthly.commitments + snapshot.budget.verificationAllowance + total >
          monthly.limit
      )
        reasons.push('monthly_budget_exhausted');
      if (
        snapshot.budget.spend +
          snapshot.budget.commitments +
          snapshot.budget.verificationAllowance +
          total >
        snapshot.budget.limit
      )
        reasons.push('run_budget_exhausted');
      const charges = new Map<string, number>();
      charges.set(candidate.routerAccountId, routerCallAllowance);
      charges.set(
        candidate.workerAccountId,
        (charges.get(candidate.workerAccountId) ?? 0) + candidate.nextStepCost
      );
      for (const [accountId, charge] of charges) {
        const account = accounts.get(accountId);
        if (!account) {
          reasons.push(`account_missing:${accountId}`);
          continue;
        }
        if (account.capacity !== 'healthy')
          reasons.push(`capacity_${account.capacity}:${accountId}`);
        if (!account.observedAt || !account.expiresAt)
          reasons.push(`capacity_unknown:${accountId}`);
        else if (!atOrBefore(account.observedAt, snapshot.evaluationTime))
          reasons.push(`capacity_future:${accountId}`);
        else if (
          Date.parse(snapshot.evaluationTime) >= Date.parse(account.expiresAt) ||
          Date.parse(snapshot.evaluationTime) - Date.parse(account.observedAt) >
            snapshot.policy.maxCapacityAgeMs
        )
          reasons.push(`capacity_stale:${accountId}`);
        if (
          account.spend + account.commitments + account.verificationAllowance + charge >
          account.limit
        )
          reasons.push(`account_budget_exhausted:${accountId}`);
      }
    }
    if (attempts.length >= snapshot.providerAttemptCeiling)
      reasons.push('provider_attempt_ceiling');
    if (snapshot.aiRole === 'independent_review') {
      if (
        /haiku/i.test(candidate.model) ||
        candidate.reviewerQualification?.strength !== 'strong' ||
        candidate.reviewerQualification.version !== 'reviewer-qualification/v1' ||
        !atOrBefore(candidate.reviewerQualification.availableAt, snapshot.evaluationTime)
      )
        reasons.push('strong_reviewer_qualification_missing');
      if (
        !snapshot.currentArtifactHash ||
        snapshot.currentArtifactHash !== snapshot.reviewTargetHash
      )
        reasons.push('review_artifact_mismatch');
      if (!candidate.family) reasons.push('reviewer_family_unknown');
      if (!candidate.familyMappingEvidence)
        reasons.push('reviewer_family_mapping_evidence_missing');
      else {
        if (candidate.familyMappingEvidence.family !== candidate.family)
          reasons.push('reviewer_family_mapping_mismatch');
        if (!atOrBefore(candidate.familyMappingEvidence.availableAt, snapshot.evaluationTime))
          reasons.push('future_reviewer_family_mapping');
      }
      if (snapshot.contributingFamilies.length === 0)
        reasons.push('contributor_provenance_missing');
      if (snapshot.contributingFamilies.some(item => !item.family))
        reasons.push('contributor_family_unknown');
      if (
        snapshot.contributingFamilies.some(
          item => !atOrBefore(item.availableAt, snapshot.evaluationTime)
        )
      )
        reasons.push('future_contributor_family_mapping');
      if (
        candidate.family &&
        snapshot.contributingFamilies.some(item => item.family === candidate.family)
      )
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

  if (gatesOnly) return out;
  const request: JevChoiceRequest = {
    questionVersion: QUESTION_VERSION,
    requestedModel: snapshot.policy.requestedJevModel,
    snapshotHash,
    instructions: [
      'Choose exactly one eligible candidate or abstain.',
      'Do not relax authorization, capability, capacity, budget, or binding constraints.',
    ],
    state: {
      runId: snapshot.runId,
      nodeId: snapshot.nodeId,
      scopeId: snapshot.scopeId,
      aiRole: snapshot.aiRole,
      evaluationTime: snapshot.evaluationTime,
    },
    question: {
      type: 'Choice',
      prompt: 'Which eligible provider/model binding should execute this AI lane step?',
      options: [
        ...out.eligibleCandidateIds.map(candidateId => {
          const candidate = requiredValue(
            snapshot.candidates.find(item => item.candidateId === candidateId),
            'candidate'
          );
          const router = requiredValue(accounts.get(candidate.routerAccountId), 'router account');
          const worker = requiredValue(accounts.get(candidate.workerAccountId), 'worker account');
          return {
            optionId: candidateId,
            candidateId,
            criteria: ['eligible', 'authorized', 'capable', 'within_budget', 'fresh_capacity'],
            binding: {
              provider: candidate.provider,
              model: candidate.model,
              routerAccountId: candidate.routerAccountId,
              workerAccountId: candidate.workerAccountId,
            },
            facts: {
              nextStepCost: candidate.nextStepCost,
              routerCallAllowance,
              runHeadroomBeforeStep:
                snapshot.budget.limit -
                snapshot.budget.spend -
                snapshot.budget.commitments -
                snapshot.budget.verificationAllowance,
              runBudget: { ...snapshot.budget, routerCallAllowance },
              routerAccount: {
                accountId: router.accountId,
                capacity: router.capacity,
                observedAt: router.observedAt,
                expiresAt: router.expiresAt,
                limit: router.limit,
                spend: router.spend,
                commitments: router.commitments,
                verificationAllowance: router.verificationAllowance,
                headroomBeforeStep:
                  router.limit - router.spend - router.commitments - router.verificationAllowance,
                fresh: true,
              },
              workerAccount: {
                accountId: worker.accountId,
                capacity: worker.capacity,
                observedAt: worker.observedAt,
                expiresAt: worker.expiresAt,
                limit: worker.limit,
                spend: worker.spend,
                commitments: worker.commitments,
                verificationAllowance: worker.verificationAllowance,
                headroomBeforeStep:
                  worker.limit - worker.spend - worker.commitments - worker.verificationAllowance,
                fresh: true,
              },
            },
            profile: requiredValue(profiles.get(candidateId), 'candidate profile'),
          };
        }),
        {
          optionId: 'abstain',
          candidateId: null,
          criteria: ['insufficient_confidence_or_evidence'],
          binding: null,
          facts: null,
          profile: null,
        },
      ],
    },
    taskBrief: requiredValue(semantic, 'task brief'),
    roleObjective: requiredValue(objective, 'role objective'),
    decisionEvidence: requiredValue(evidence, 'decision evidence'),
  };
  out.request = request;
  out.requestHash = hash(request);
  const rawExchange: unknown = snapshot.jevExchange;
  if (!rawExchange) {
    out.jevDisposition = 'missing_exchange';
    return out;
  }
  const parsedExchange = jevExchangeSchema.safeParse(rawExchange);
  if (!parsedExchange.success) {
    out.jevDisposition = 'malformed_exchange';
    return out;
  }
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
  if (
    exchange.requestedModel !== snapshot.policy.requestedJevModel ||
    exchange.returnedModel !== snapshot.policy.requestedJevModel
  )
    invalid.push('wrong_jev_model');
  if (exchange.rubricVersion !== snapshot.policy.rubricVersion) invalid.push('wrong_rubric');
  if (
    Date.parse(snapshot.evaluationTime) - Date.parse(exchange.decidedAt) >
      snapshot.policy.maxJevAgeMs ||
    !atOrBefore(exchange.decidedAt, snapshot.evaluationTime)
  )
    invalid.push('stale_or_future_exchange');
  if (exchange.tied) invalid.push('tied');
  if (exchange.vendorConfidence < snapshot.policy.minimumVendorConfidence)
    invalid.push('low_vendor_confidence');
  if (exchange.abstain || exchange.choice === null) invalid.push('jev_abstained');
  if (exchange.choice && !out.eligibleCandidateIds.includes(exchange.choice))
    invalid.push('choice_not_eligible');
  const probability = exchange.choice ? exchange.distribution[exchange.choice] : undefined;
  if (probability === undefined || probability < snapshot.policy.minimumWinningProbability)
    invalid.push('low_winning_probability');
  const distributionKeys = Object.keys(exchange.distribution).sort();
  if (distributionKeys.join('|') !== [...out.eligibleCandidateIds, 'abstain'].sort().join('|'))
    invalid.push('distribution_options_mismatch');
  const ranked = Object.entries(exchange.distribution).sort((a, b) => b[1] - a[1]);
  if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) invalid.push('derived_tie');
  if (ranked[0]?.[0] !== exchange.choice || ranked[0]?.[0] === 'abstain')
    invalid.push('not_unique_winner');
  const sum = Object.values(exchange.distribution).reduce((total, value) => total + value, 0);
  if (Math.abs(sum - 1) > 0.000001) invalid.push('invalid_distribution');
  const selected = snapshot.candidates.find(item => item.candidateId === exchange.choice);
  if (invalid.length || !selected) {
    out.jevDisposition = [...new Set(invalid.length ? invalid : ['choice_not_found'])]
      .sort()
      .join(',');
    return out;
  }
  out.decision = 'propose';
  out.proposedBinding = {
    candidateId: selected.candidateId,
    provider: selected.provider,
    model: selected.model,
  };
  out.jevDisposition = 'accepted';
  return out;
}

const routeSchema = z.object({
  routeId: nonblank,
  engineId: nonblank,
  adapterId: nonblank,
  requestedModel: nonblank,
  transport: z.enum(['subscription', 'api']),
  accountId: nonblank,
  estimatedCost: finiteNonnegative.nullable(),
  authorized: z.boolean(),
  bindingEvidence: z.object({ sourceRef: nonblank, availableAt: timestamp }).nullable(),
  apiBillingEvidence: z
    .object({
      sourceRef: nonblank,
      availableAt: timestamp,
      expiresAt: timestamp,
      status: z.enum(['available', 'exhausted', 'unknown']),
    })
    .nullable(),
});
const v4CandidateSchema = candidateSchema.omit({ routerAccountId: true });
const v4SnapshotSchema = dynamicLaneSnapshotStructuralSchema
  .omit({ jevExchange: true, legacyRoutingEvidence: true })
  .extend({
    schemaVersion: z.literal('dynamic-lane-snapshot/v4'),
    decisionId: nonblank,
    promptVersion: nonblank,
    routerCallsConsumed: z.number().int().nonnegative(),
    routerCallCeiling: z.number().int().nonnegative(),
    monthlyBudgetPolicy: monthlyBudgetPolicySchema.nullable().default(null),
    priorDecisions: priorDecisionsSchema.nullable().default(null),
    candidates: z.array(v4CandidateSchema).superRefine((candidates, ctx) => {
      if (new Set(candidates.map(c => c.candidateId)).size !== candidates.length)
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'duplicate candidateId' });
    }),
    budget: dynamicLaneSnapshotStructuralSchema.shape.budget.omit({ routerCallAllowance: true }),
    policy: z.object({ maxCapacityAgeMs: finiteNonnegative, maxDecisionAgeMs: finiteNonnegative }),
    routingResourcePlan: z
      .array(routeSchema)
      .length(3)
      .superRefine((routes, ctx) => {
        if (new Set(routes.map(r => r.routeId)).size !== routes.length)
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'duplicate routeId' });
      }),
    decisionExchanges: z.array(z.unknown()).default([]),
  });
export type DynamicLaneV4Snapshot = z.infer<typeof v4SnapshotSchema>;
export const dynamicLaneSnapshotSchema = z.discriminatedUnion('schemaVersion', [
  dynamicLaneSnapshotStructuralSchema,
  v4SnapshotSchema,
]) as unknown as z.ZodType<DynamicLaneSnapshot | DynamicLaneV4Snapshot>;

const normalizedResponseSchema = z
  .object({
    schemaVersion: z.literal('dynamic-lane-response/v1'),
    decisionId: nonblank,
    requestHash: nonblank,
    snapshotHash: nonblank,
    choice: z.enum(['select', 'abstain']),
    candidateId: nonblank.nullable(),
    rationale: z.string().max(2000),
    evidenceReferences: z.array(nonblank),
  })
  .strict();
const exchangeSchema = z
  .object({
    decisionId: nonblank,
    snapshotHash: nonblank,
    requestHash: nonblank,
    routeId: nonblank,
    engineId: nonblank,
    adapterId: nonblank,
    accountId: nonblank,
    transport: z.enum(['subscription', 'api']),
    origin: z.enum(['synthetic', 'recorded']),
    requestedModel: nonblank,
    servedModel: nonblank.nullable(),
    attemptId: nonblank,
    startedAt: timestamp,
    completedAt: timestamp,
    usage: z.record(finiteNonnegative).nullable(),
    latencyMs: finiteNonnegative.nullable(),
    cashCost: finiteNonnegative.nullable(),
    outcome: z.enum(['success', 'availability', 'quota', 'refused', 'cancelled']),
    response: z.unknown().nullable(),
    distribution: identifierRecord(finiteNonnegative).optional(),
  })
  .strict();
const normalizedRequestSchema = z.object({
  schemaVersion: z.literal('dynamic-lane-request/v1'),
  decisionId: nonblank,
  policyVersion: nonblank,
  promptVersion: nonblank,
  snapshotHash: nonblank,
  runId: nonblank,
  nodeId: nonblank,
  role: nonblank,
  taskBrief: semanticTextSchema,
  roleObjective: roleObjectiveSchema,
  decisionEvidence: dynamicLaneSnapshotStructuralSchema.shape.decisionEvidence,
  eligibleCandidates: z.array(
    v4CandidateSchema.extend({
      profile: profileSchema,
      workerAccount: accountSchema,
      runHeadroom: finiteNonnegative,
    })
  ),
  allowedChoices: z.array(nonblank),
  routingResourcePlan: z.array(routeSchema),
});
const v4ReceiptSchema = z.object({
  schemaVersion: z.literal('dynamic-lane-receipt/v4'),
  policyVersion: z.literal('offline-admission/v4'),
  promptVersion: nonblank,
  decisionId: nonblank,
  snapshotHash: nonblank,
  priorLedgerHash: nonblank.nullable(),
  requestHash: nonblank.nullable(),
  normalizedRequest: normalizedRequestSchema.nullable(),
  eligibleCandidateIds: z.array(nonblank),
  candidateRejections: identifierRecord(z.array(nonblank)),
  decision: z.enum(['propose', 'wait', 'abstain']),
  proposedBinding: candidateSchema
    .pick({
      candidateId: true,
      provider: true,
      model: true,
      workerAccountId: true,
      transport: true,
    })
    .nullable(),
  decisionOrigin: z.enum(['none', 'synthetic', 'recorded']),
  disposition: nonblank,
  engineId: nonblank.nullable(),
  adapterId: nonblank.nullable(),
  transport: z.enum(['subscription', 'api']).nullable(),
  accountId: nonblank.nullable(),
  requestedModel: nonblank.nullable(),
  servedModel: nonblank.nullable(),
  routerCallsConsumed: z.number().int().nonnegative(),
  routerCallsRemaining: z.number().int().nonnegative(),
  attemptHistory: z.array(exchangeSchema),
  charges: identifierRecord(finiteNonnegative),
  evidenceReferences: z.array(nonblank),
  usage: z.record(finiteNonnegative).nullable(),
  cashCost: finiteNonnegative.nullable(),
  latencyMs: finiteNonnegative.nullable(),
  distribution: identifierRecord(finiteNonnegative).nullable(),
  postExecutionReview: z.literal('unissued'),
});
export type DynamicLaneV4Receipt = z.infer<typeof v4ReceiptSchema>;

const decisionRoutes = [
  ['haiku-subscription', 'haiku', 'claude-haiku-5-5', 'subscription'],
  ['luna-subscription', 'luna', 'gpt-6-luna', 'subscription'],
  ['haiku-api', 'haiku', 'claude-haiku-5-5', 'api'],
] as const;

function evaluateV4Core(snapshot: DynamicLaneV4Snapshot): DynamicLaneV4Receipt {
  const { decisionExchanges, priorDecisions, ...inputs } = snapshot;
  const snapshotHash = hash(inputs);
  const out: DynamicLaneV4Receipt = {
    schemaVersion: 'dynamic-lane-receipt/v4',
    policyVersion: 'offline-admission/v4',
    promptVersion: snapshot.promptVersion,
    decisionId: snapshot.decisionId,
    snapshotHash,
    priorLedgerHash: priorDecisions ? hash(priorDecisions) : null,
    requestHash: null,
    normalizedRequest: null,
    eligibleCandidateIds: [],
    candidateRejections: Object.create(null) as Record<string, string[]>,
    decision: 'wait',
    proposedBinding: null,
    decisionOrigin: 'none',
    disposition: 'not_evaluated',
    engineId: null,
    adapterId: null,
    transport: null,
    accountId: null,
    requestedModel: null,
    servedModel: null,
    routerCallsConsumed: snapshot.routerCallsConsumed,
    routerCallsRemaining: Math.max(0, snapshot.routerCallCeiling - snapshot.routerCallsConsumed),
    attemptHistory: [],
    charges: Object.create(null) as Record<string, number>,
    evidenceReferences: [],
    usage: null,
    cashCost: null,
    latencyMs: null,
    distribution: null,
    postExecutionReview: 'unissued',
  };
  const stop = (reason: string): DynamicLaneV4Receipt => {
    out.disposition = reason;
    out.proposedBinding = null;
    out.decision = 'wait';
    return out;
  };
  const now = Date.parse(snapshot.evaluationTime);
  const validAt = (observed: string, expires?: string): boolean =>
    Date.parse(observed) <= now && (!expires || now < Date.parse(expires));
  const matchingPrior = priorDecisions?.entries.find(
    p => p.decisionId === snapshot.decisionId && p.snapshotHash === snapshotHash
  );
  const rawHistory = decisionExchanges.length
    ? decisionExchanges
    : (matchingPrior?.exchanges ?? []);
  const history: z.infer<typeof exchangeSchema>[] = [];
  const delivered = new Map<string, string>();
  let unknownReservation = false;
  // Supplied actual calls remain consumed even when admission or response validation refuses them.
  // The running budget below separately checks whether each call was affordable before it began.
  for (const raw of rawHistory) {
    const parsed = exchangeSchema.safeParse(raw);
    if (!parsed.success) return stop('malformed_exchange');
    const item = parsed.data;
    const bytes = canonicalDynamicLaneJson(item);
    if (delivered.has(item.attemptId)) {
      if (delivered.get(item.attemptId) !== bytes) return stop('conflicting_attempt_delivery');
      continue;
    }
    delivered.set(item.attemptId, bytes);
    history.push(item);
    out.attemptHistory.push(item);
    out.routerCallsConsumed++;
    out.routerCallsRemaining = Math.max(0, snapshot.routerCallCeiling - out.routerCallsConsumed);
    const recordedRoute = snapshot.routingResourcePlan.find(
      r => r.routeId === item.routeId && r.accountId === item.accountId
    );
    const charge = item.cashCost ?? recordedRoute?.estimatedCost;
    if (charge === undefined || charge === null) unknownReservation = true;
    else out.charges[item.accountId] = (out.charges[item.accountId] ?? 0) + charge;
  }
  if (unknownReservation) return stop('actual_call_reservation_unknown');
  const monthly = snapshot.monthlyBudgetPolicy;
  if (!monthly || !validAt(monthly.effectiveFrom, monthly.effectiveUntil))
    return stop('monthly_policy_missing_or_expired');
  if (!priorDecisions || !validAt(priorDecisions.availableAt))
    return stop('prior_ledger_missing_or_future');
  const priors = priorDecisions.entries.filter(p => p.decisionId === snapshot.decisionId);
  if (priors.some(p => p.snapshotHash !== snapshotHash)) return stop('decision_id_conflict');
  if (priors.length > 1) return stop('duplicate_prior_decision');
  // A stored receipt is never authority: recompute all gates and the supplied exchange evidence below.
  if (snapshot.routerCallsConsumed >= snapshot.routerCallCeiling)
    return stop('router_call_ceiling');
  if (
    snapshot.routingResourcePlan.some((route, i) => {
      const expected = decisionRoutes[i];
      return (
        route.routeId !== expected[0] ||
        route.engineId !== expected[1] ||
        route.requestedModel !== expected[2] ||
        route.transport !== expected[3]
      );
    })
  )
    return stop('invalid_decision_route_order_or_binding');

  // Reuse the existing deterministic worker admission logic, without constructing a Jev request.
  // Router accounting is performed per actual route below, rather than charged to a worker account.
  const admission = evaluateLegacyDynamicLane(
    {
      ...snapshot,
      schemaVersion: 'dynamic-lane-snapshot/v3',
      candidates: snapshot.candidates.map(c => ({ ...c, routerAccountId: c.workerAccountId })),
      budget: { ...snapshot.budget, routerCallAllowance: 0 },
      policy: {
        ...snapshot.policy,
        maxJevAgeMs: snapshot.policy.maxDecisionAgeMs,
        minimumWinningProbability: 0,
        minimumVendorConfidence: 0,
        requestedJevModel: 'not-called',
        rubricVersion: 'not-called',
      },
    },
    true
  );
  out.candidateRejections = admission.candidateRejections;
  out.evidenceReferences = admission.evidenceReferences;
  const accounts = new Map(snapshot.accounts.map(a => [a.accountId, a]));
  let eligible = snapshot.candidates.filter(c =>
    admission.eligibleCandidateIds.includes(c.candidateId)
  );
  for (const c of eligible) {
    const account = accounts.get(c.workerAccountId);
    const reasons = out.candidateRejections[c.candidateId] ?? [];
    if (!c.transport || c.contextCompatible !== true)
      reasons.push('worker_transport_or_context_unknown');
    if (!account?.seat || !account.window || !account.sourceRef)
      reasons.push('account_identity_evidence_missing');
    out.candidateRejections[c.candidateId] = reasons;
  }
  eligible = eligible
    .filter(c => !out.candidateRejections[c.candidateId]?.length)
    .sort((a, b) => asciiCompare(a.candidateId, b.candidateId));
  if (!eligible.length) return stop('no_eligible_candidates');

  const charges = new Map<string, number>();
  const totalCharges = (): number => [...charges.values()].reduce((a, b) => a + b, 0);
  const canFund = (
    candidate: (typeof eligible)[number],
    route: z.infer<typeof routeSchema>,
    callCost: number
  ): boolean => {
    if (candidate.nextStepCost === null) return false;
    const workerCost = candidate.nextStepCost;
    const newTotal = totalCharges() + callCost + workerCost + snapshot.budget.verificationAllowance;
    if (snapshot.budget.spend + snapshot.budget.commitments + newTotal > snapshot.budget.limit)
      return false;
    if (
      monthly.mode === 'limited' &&
      monthly.spend + monthly.commitments + newTotal > monthly.limit
    )
      return false;
    const perAccount = new Map(charges);
    perAccount.set(route.accountId, (perAccount.get(route.accountId) ?? 0) + callCost);
    perAccount.set(
      candidate.workerAccountId,
      (perAccount.get(candidate.workerAccountId) ?? 0) + workerCost
    );
    return [...perAccount].every(([id, charge]) => {
      const a = accounts.get(id);
      return !!a && a.spend + a.commitments + a.verificationAllowance + charge <= a.limit;
    });
  };
  let position = 0;
  let previousTime = -Infinity;
  for (const route of snapshot.routingResourcePlan) {
    const account = accounts.get(route.accountId);
    if (
      !account?.seat ||
      !account.window ||
      !account.sourceRef ||
      !account.observedAt ||
      !account.expiresAt ||
      !validAt(account.observedAt, account.expiresAt) ||
      now - Date.parse(account.observedAt) > snapshot.policy.maxCapacityAgeMs
    )
      return stop('decision_account_unknown_or_stale');
    if (!route.authorized || !route.bindingEvidence || !validAt(route.bindingEvidence.availableAt))
      return stop('decision_binding_unqualified');
    if (
      route.transport === 'api' &&
      (route.apiBillingEvidence?.status !== 'available' ||
        !validAt(route.apiBillingEvidence.availableAt, route.apiBillingEvidence.expiresAt))
    )
      return stop('api_billing_unqualified');
    if (account.capacity === 'unknown') return stop('decision_capacity_unknown');
    if (account.capacity === 'exhausted' || account.capacity === 'unavailable') {
      if (history[position]?.routeId === route.routeId) return stop('call_on_skipped_route');
      continue;
    }
    if (route.estimatedCost === null) return stop('decision_cost_unknown');
    const estimatedCost = route.estimatedCost;
    if (!out.normalizedRequest) {
      for (const c of eligible)
        if (!canFund(c, route, route.estimatedCost))
          out.candidateRejections[c.candidateId].push('initial_route_budget_exhausted');
      eligible = eligible.filter(c => !out.candidateRejections[c.candidateId]?.length);
      if (!eligible.length) return stop('initial_route_budget_exhausted');
      out.eligibleCandidateIds = eligible.map(c => c.candidateId);
      out.normalizedRequest = {
        schemaVersion: 'dynamic-lane-request/v1',
        decisionId: snapshot.decisionId,
        policyVersion: out.policyVersion,
        promptVersion: snapshot.promptVersion,
        snapshotHash,
        runId: snapshot.runId,
        nodeId: snapshot.nodeId,
        role: snapshot.aiRole,
        taskBrief: requiredValue(snapshot.taskBrief, 'task brief'),
        roleObjective: requiredValue(snapshot.roleObjective, 'role objective'),
        decisionEvidence: snapshot.decisionEvidence,
        eligibleCandidates: eligible.map(c => ({
          ...c,
          profile: requiredValue(
            snapshot.candidateProfiles?.find(p => p.candidateId === c.candidateId),
            'profile'
          ),
          workerAccount: requiredValue(accounts.get(c.workerAccountId), 'worker account'),
          runHeadroom:
            snapshot.budget.limit -
            snapshot.budget.spend -
            snapshot.budget.commitments -
            snapshot.budget.verificationAllowance,
        })),
        allowedChoices: [...out.eligibleCandidateIds, 'abstain'],
        routingResourcePlan: snapshot.routingResourcePlan,
      };
      out.requestHash = hash(out.normalizedRequest);
    }
    if (!eligible.every(c => canFund(c, route, estimatedCost)))
      return stop('fallback_budget_exhausted');
    if (snapshot.routerCallsConsumed + position >= snapshot.routerCallCeiling || position >= 3)
      return stop('router_call_ceiling');
    const attempt = history[position];
    if (!attempt) return stop('missing_exchange');
    if (
      attempt.decisionId !== snapshot.decisionId ||
      attempt.snapshotHash !== snapshotHash ||
      attempt.requestHash !== out.requestHash
    )
      return stop('exchange_hash_or_decision_mismatch');
    if (
      attempt.routeId !== route.routeId ||
      attempt.engineId !== route.engineId ||
      attempt.adapterId !== route.adapterId ||
      attempt.accountId !== route.accountId ||
      attempt.transport !== route.transport ||
      attempt.requestedModel !== route.requestedModel ||
      attempt.servedModel !== route.requestedModel
    )
      return stop('exchange_binding_or_served_identity_mismatch');
    if (
      !validAt(attempt.completedAt) ||
      Date.parse(attempt.startedAt) > Date.parse(attempt.completedAt) ||
      Date.parse(attempt.startedAt) < previousTime ||
      now - Date.parse(attempt.completedAt) > snapshot.policy.maxDecisionAgeMs ||
      Date.parse(account.observedAt) > Date.parse(attempt.startedAt) ||
      Date.parse(route.bindingEvidence.availableAt) > Date.parse(attempt.startedAt) ||
      (route.transport === 'api' &&
        route.apiBillingEvidence &&
        Date.parse(route.apiBillingEvidence.availableAt) > Date.parse(attempt.startedAt))
    )
      return stop('stale_future_or_out_of_order_exchange');
    previousTime = Date.parse(attempt.completedAt);
    position++;
    const charge = attempt.cashCost ?? route.estimatedCost;
    charges.set(route.accountId, (charges.get(route.accountId) ?? 0) + charge);
    if (!eligible.every(c => canFund(c, route, 0))) return stop('observed_cost_budget_exhausted');
    if (attempt.outcome === 'availability' || attempt.outcome === 'quota') {
      if (attempt.response !== null) return stop('response_on_failed_attempt');
      continue;
    }
    if (attempt.outcome !== 'success') return stop(`decision_${attempt.outcome}`);
    const parsed = normalizedResponseSchema.safeParse(attempt.response);
    if (!parsed.success) return stop('malformed_response');
    const response = parsed.data;
    if (
      response.decisionId !== snapshot.decisionId ||
      response.snapshotHash !== snapshotHash ||
      response.requestHash !== out.requestHash
    )
      return stop('response_hash_or_decision_mismatch');
    if (response.evidenceReferences.some(ref => !out.evidenceReferences.includes(ref)))
      return stop('unknown_response_evidence');
    if (position !== history.length) return stop('attempt_after_terminal_outcome');
    if (response.choice === 'abstain')
      return stop(
        response.candidateId === null ? 'decision_abstained' : 'invalid_abstain_candidate'
      );
    const selected = eligible.find(c => c.candidateId === response.candidateId);
    if (!selected) return stop('choice_not_eligible');
    if (attempt.distribution) {
      const entries = Object.entries(attempt.distribution).sort((a, b) => b[1] - a[1]);
      const keys = Object.keys(attempt.distribution).sort();
      if (
        keys.join('|') !== [...out.eligibleCandidateIds, 'abstain'].sort().join('|') ||
        Math.abs(entries.reduce((sum, e) => sum + e[1], 0) - 1) > 0.000001 ||
        entries[0]?.[0] !== selected.candidateId ||
        (entries.length > 1 && entries[0][1] === entries[1][1])
      )
        return stop('invalid_distribution_winner');
      out.distribution = attempt.distribution;
    }
    // Selection is rechecked against the same admitted worker facts, never a model-supplied binding.
    out.proposedBinding = {
      candidateId: selected.candidateId,
      provider: selected.provider,
      model: selected.model,
      workerAccountId: selected.workerAccountId,
      transport: selected.transport,
    };
    out.decision = 'propose';
    out.disposition = 'accepted';
    out.decisionOrigin = attempt.origin;
    out.engineId = route.engineId;
    out.adapterId = route.adapterId;
    out.transport = route.transport;
    out.accountId = route.accountId;
    out.requestedModel = attempt.requestedModel;
    out.servedModel = attempt.servedModel;
    out.usage = attempt.usage;
    out.cashCost = attempt.cashCost;
    out.latencyMs = attempt.latencyMs;
    return out;
  }
  return stop(
    position < history.length ? 'unexpected_attempt_history' : 'all_decision_routes_unavailable'
  );
}

function evaluateV4(snapshot: DynamicLaneV4Snapshot): DynamicLaneV4Receipt {
  const out = evaluateV4Core(snapshot);
  const prior = snapshot.priorDecisions?.entries.find(
    p => p.decisionId === snapshot.decisionId && p.snapshotHash === out.snapshotHash
  );
  if (prior?.receipt !== undefined && prior.receipt !== null) {
    const stored = v4ReceiptSchema.safeParse(prior.receipt);
    const reason = !stored.success
      ? 'invalid_prior_receipt'
      : canonicalDynamicLaneJson({ ...stored.data, priorLedgerHash: null }) !==
          canonicalDynamicLaneJson({ ...out, priorLedgerHash: null })
        ? 'prior_receipt_mismatch'
        : null;
    if (reason) return { ...out, disposition: reason, decision: 'wait', proposedBinding: null };
  }
  return out;
}

export function evaluateDynamicLane(snapshot: DynamicLaneSnapshot): DynamicLaneReceipt;
export function evaluateDynamicLane(snapshot: DynamicLaneV4Snapshot): DynamicLaneV4Receipt;
export function evaluateDynamicLane(
  snapshot: DynamicLaneSnapshot | DynamicLaneV4Snapshot
): DynamicLaneReceipt | DynamicLaneV4Receipt;
export function evaluateDynamicLane(
  snapshot: DynamicLaneSnapshot | DynamicLaneV4Snapshot
): DynamicLaneReceipt | DynamicLaneV4Receipt {
  return snapshot.schemaVersion === 'dynamic-lane-snapshot/v4'
    ? evaluateV4(snapshot)
    : evaluateLegacyDynamicLane(snapshot);
}

export type { ExecutionCapability, OutcomeReasonCode, ProviderAttemptRecord, RunAuthorityRecord };
