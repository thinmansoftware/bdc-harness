import { z } from '@hono/zod-openapi';

// M-31 Overseer merge-steward substrate API schemas (M-42 Slice 2). Every request
// body is `.strict()` so unknown fields are rejected. Action identity uses the
// closed M-31 action-kind vocabulary; digests are 64-hex content addresses and
// git blobs are 40- or 64-hex object ids.

const gitBlobSchema = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/);
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const gitObjectFormatSchema = z.enum(['sha1', 'sha256']);
const prNumberSchema = z.number().int().positive();

export const m31ActionKindSchema = z.enum([
  'MERGE',
  'CLOSE',
  'REOPEN',
  'REFRESH',
  'REBASE',
  'PUSH',
  'RETARGET',
  'REPAIR',
  'REFIRE',
  'COMMENT',
  'LABEL',
  'ASSIGN',
  'REVIEW',
  'STAGING_MUTATION',
  'PRODUCTION_MUTATION',
  'DEPLOY',
]);

export const m31TypedFailureSchema = z.enum([
  'snapshot_invalid',
  'snapshot_not_chain_tip',
  'snapshot_forked',
  'predecessor_missing',
  'predecessor_digest_mismatch',
  'discrepancy_unresolved',
  'evidence_missing',
  'evidence_conflicting',
  'evidence_stale',
  'proposal_expired',
  'proposal_replayed',
  'execution_id_conflict',
  'live_state_unknown',
  'live_state_mismatch',
  'observation_stale',
  'policy_digest_mismatch',
  'verifier_registry_mismatch',
]);

// ---------------------------------------------------------------------------
// Snapshot registration
// ---------------------------------------------------------------------------

export const m31SnapshotMemberSchema = z
  .object({
    pr_number: prNumberSchema,
    head_sha: gitBlobSchema,
    base_branch: z.string().min(1),
    base_sha: gitBlobSchema,
    state: z.string().min(1),
    checks: z.unknown(),
    check_source_sha: gitBlobSchema,
    checks_observed_at: z.string().min(1),
    review_state: z.string().min(1),
    mergeability: z.string().min(1),
    merge_state_status: z.string().min(1),
    linked_work_evidence: z.unknown(),
    evidence_artifact_path: z.string().min(1),
    git_object_format: gitObjectFormatSchema,
    evidence_git_blob: gitBlobSchema,
    observed_at: z.string().min(1),
  })
  .strict()
  .openapi('M31SnapshotMemberInput');

export const registerM31SnapshotBodySchema = z
  .object({
    snapshot_id: z.string().min(1).optional(),
    repository: z.string().min(1),
    capture_started_at: z.string().min(1),
    capture_completed_at: z.string().min(1),
    operator_actor: z.string().min(1),
    operator_model: z.string().min(1),
    read_only_query_method: z.string().min(1),
    base_branch: z.string().min(1),
    base_sha: gitBlobSchema,
    predecessor_snapshot_id: z.string().min(1).nullable().optional(),
    predecessor_evidence_git_blob: gitBlobSchema.nullable().optional(),
    artifact_path: z.string().min(1),
    git_object_format: gitObjectFormatSchema,
    evidence_git_blob: gitBlobSchema,
    mutation_attempted: z.boolean().optional(),
    fusion_calls_attempted: z.number().int().min(0).optional(),
    members: z.array(m31SnapshotMemberSchema).min(1),
  })
  .strict()
  .openapi('RegisterM31SnapshotBody');

export const m31SnapshotResponseMemberSchema = z
  .object({
    snapshot_id: z.string(),
    ordinal: z.number().int().min(0),
    pr_number: prNumberSchema,
    head_sha: z.string(),
    base_branch: z.string(),
    base_sha: z.string(),
    state: z.string(),
    checks: z.unknown(),
    check_source_sha: z.string(),
    checks_observed_at: z.string(),
    review_state: z.string(),
    mergeability: z.string(),
    merge_state_status: z.string(),
    linked_work_evidence: z.unknown(),
    evidence_artifact_path: z.string(),
    git_object_format: z.string(),
    evidence_git_blob: z.string(),
    observed_at: z.string(),
  })
  .openapi('M31SnapshotMember');

export const m31SnapshotSchema = z
  .object({
    snapshot_id: z.string(),
    schema_version: z.string(),
    repository: z.string(),
    capture_started_at: z.string(),
    capture_completed_at: z.string(),
    operator_actor: z.string(),
    operator_model: z.string(),
    read_only_query_method: z.string(),
    base_branch: z.string(),
    base_sha: z.string(),
    predecessor_snapshot_id: z.string().nullable(),
    predecessor_evidence_git_blob: z.string().nullable(),
    artifact_path: z.string(),
    git_object_format: z.string(),
    evidence_git_blob: z.string(),
    mutation_attempted: z.boolean(),
    mutation_succeeded: z.boolean(),
    fusion_calls_attempted: z.number().int().min(0),
    fusion_calls_succeeded: z.number().int().min(0),
    created_at: z.string(),
    members: z.array(m31SnapshotResponseMemberSchema),
  })
  .openapi('M31Snapshot');

export const m31SnapshotResponseSchema = z.object({ snapshot: m31SnapshotSchema });

export const m31SnapshotIdParamsSchema = z.object({
  snapshot_id: z
    .string()
    .min(1)
    .openapi({ param: { name: 'snapshot_id', in: 'path' } }),
});

// ---------------------------------------------------------------------------
// Discrepancies
// ---------------------------------------------------------------------------

export const appendM31DiscrepancyBodySchema = z
  .object({
    evidence_git_blob: gitBlobSchema,
    affected_rows: z.unknown(),
    observed_conflict: z.string().min(1),
    recorder: z.string().min(1),
    resolution: z.string().min(1).nullable().optional(),
    predecessor_discrepancy_id: z.string().min(1).nullable().optional(),
  })
  .strict()
  .openapi('AppendM31DiscrepancyBody');

export const m31DiscrepancySchema = z
  .object({
    discrepancy_id: z.string(),
    snapshot_id: z.string(),
    evidence_git_blob: z.string(),
    affected_rows: z.unknown(),
    observed_conflict: z.string(),
    recorder: z.string(),
    recorded_at: z.string(),
    resolution: z.string().nullable(),
    predecessor_discrepancy_id: z.string().nullable(),
  })
  .openapi('M31Discrepancy');

export const m31DiscrepancyResponseSchema = z.object({ discrepancy: m31DiscrepancySchema });

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

export const createM31ProposalBodySchema = z
  .object({
    proposal_id: z.string().min(1).optional(),
    repository: z.string().min(1),
    pr_number: prNumberSchema,
    head_sha: gitBlobSchema,
    base_branch: z.string().min(1),
    base_sha: gitBlobSchema,
    snapshot_id: z.string().min(1),
    evidence_path: z.string().min(1),
    action_kind: m31ActionKindSchema,
    action_parameters: z.unknown(),
    actor: z.string().min(1),
    policy_digest: digestSchema,
    verifier_registry_digest: digestSchema,
    ttl_ms: z
      .number()
      .int()
      .positive()
      .max(24 * 60 * 60 * 1000)
      .optional(),
    max_evidence_age_ms: z.number().int().positive().optional(),
  })
  .strict()
  .openapi('CreateM31ProposalBody');

export const m31ProposalSchema = z
  .object({
    proposal_id: z.string(),
    repository: z.string(),
    pr_number: prNumberSchema,
    head_sha: z.string(),
    base_branch: z.string(),
    base_sha: z.string(),
    snapshot_id: z.string(),
    evidence_path: z.string(),
    evidence_git_blob: z.string(),
    action_kind: m31ActionKindSchema,
    action_parameters: z.unknown(),
    actor: z.string(),
    created_at: z.string(),
    expires_at: z.string(),
    execution_id: z.string(),
    capability: z.string(),
    policy_digest: z.string(),
    verifier_registry_digest: z.string(),
  })
  .openapi('M31ActionProposal');

export const m31ProposalResponseSchema = z.object({ proposal: m31ProposalSchema });

export const m31ProposalIdParamsSchema = z.object({
  proposal_id: z
    .string()
    .min(1)
    .openapi({ param: { name: 'proposal_id', in: 'path' } }),
});

// ---------------------------------------------------------------------------
// Compare and consume (permit issuance)
// ---------------------------------------------------------------------------

export const m31LiveObservationSchema = z
  .object({
    known: z.boolean(),
    repository: z.string().min(1),
    pr_number: prNumberSchema,
    head_sha: gitBlobSchema,
    base_branch: z.string().min(1),
    base_sha: gitBlobSchema,
    policy_digest: digestSchema,
    verifier_registry_digest: digestSchema,
    observed_at: z.string().min(1),
  })
  .strict()
  .openapi('M31LiveObservation');

export const compareAndConsumeM31BodySchema = z
  .object({
    observation: m31LiveObservationSchema,
    validity_window_ms: z.number().int().positive().max(3_600_000).optional(),
  })
  .strict()
  .openapi('CompareAndConsumeM31Body');

export const m31PermitSchema = z
  .object({
    permit_id: z.string(),
    proposal_id: z.string(),
    execution_id: z.string(),
    repository: z.string(),
    pr_number: prNumberSchema,
    head_sha: z.string(),
    base_branch: z.string(),
    base_sha: z.string(),
    snapshot_id: z.string(),
    action_kind: m31ActionKindSchema,
    capability: z.string(),
    issued_at: z.string(),
    valid_until: z.string(),
  })
  .openapi('M31ActionPermit');

export const m31ReceiptSchema = z
  .object({
    receipt_id: z.string(),
    proposal_id: z.string(),
    execution_id: z.string(),
    snapshot_id: z.string(),
    live_observation: z.unknown(),
    live_observation_digest: z.string(),
    revalidated_at: z.string(),
    valid_until: z.string(),
    compare_result: z.literal('permit_issued'),
    provider_atomic_operation: z.null(),
    created_at: z.string(),
  })
  .openapi('M31ExecutionReceipt');

export const m31PermitResponseSchema = z.object({
  permit: m31PermitSchema,
  receipt: m31ReceiptSchema,
});

export const m31FailureResponseSchema = z.object({
  error: z.object({ failure: m31TypedFailureSchema, message: z.string() }),
});

export const m31GateDenialResponseSchema = z.object({
  error: z.object({
    reason: z.literal('gate_denied'),
    capability: z.string(),
    message: z.string(),
  }),
});
