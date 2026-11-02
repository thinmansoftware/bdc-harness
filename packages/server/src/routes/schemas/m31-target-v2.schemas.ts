import { z } from '@hono/zod-openapi';

const shaSchema = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/);
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const timestampSchema = z.string().datetime();

export const m31ActionKindV2Schema = z.enum([
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

export const m31ActionTargetV2Schema = z.discriminatedUnion('target_kind', [
  z
    .object({
      target_kind: z.literal('workflow_run'),
      repository: z.string().min(1),
      run_id: z.string().uuid(),
      wo_id: z.string().min(1),
      workflow_name: z.string().min(1),
      codebase_id: z.string().nullable(),
      status: z.string().min(1),
      event_tip: z.string().min(1),
      head_sha: shaSchema.nullable(),
      base_sha: shaSchema.nullable(),
    })
    .strict(),
  z
    .object({
      target_kind: z.literal('issue'),
      repository: z.string().min(1),
      issue_number: z.number().int().positive(),
      provider_node_id: z.string().min(1),
      state: z.string().min(1),
      updated_at: timestampSchema,
      is_pull_request: z.literal(false),
    })
    .strict(),
  z
    .object({
      target_kind: z.literal('work_order'),
      repository: z.string().min(1),
      wo_id: z.string().min(1),
      spec_path: z.string().min(1),
      spec_revision: z.string().min(1),
      spec_hash: digestSchema,
      tracker_issue_number: z.number().int().positive(),
      tracker_provider_node_id: z.string().min(1),
      tracker_state: z.string().min(1),
      tracker_updated_at: timestampSchema,
      tracker_is_pull_request: z.literal(false),
    })
    .strict(),
  z
    .object({
      target_kind: z.literal('pull_request'),
      repository: z.string().min(1),
      pr_number: z.number().int().positive(),
      provider_node_id: z.string().min(1),
      head_sha: shaSchema,
      base_branch: z.string().min(1),
      base_sha: shaSchema,
      state: z.string().min(1),
      updated_at: timestampSchema,
    })
    .strict(),
]);

export const m31SnapshotV2RequestSchema = z
  .object({
    repository: z.string().min(1),
    capture_started_at: timestampSchema,
    capture_completed_at: timestampSchema,
    operator_actor: z.string().min(1),
    operator_model: z.string().min(1),
    read_only_query_method: z.string().min(1),
    evidence_artifact_path: z.string().min(1),
    git_object_format: z.enum(['sha1', 'sha256']),
    evidence_git_blob: shaSchema,
    predecessor_snapshot_id: z.string().nullable().optional(),
    predecessor_evidence_git_blob: shaSchema.nullable().optional(),
    targets: z
      .array(
        z.object({
          target: m31ActionTargetV2Schema,
          evidence_artifact_path: z.string().min(1),
          git_object_format: z.enum(['sha1', 'sha256']),
          evidence_git_blob: shaSchema,
          observed_at: timestampSchema,
        })
      )
      .min(1),
  })
  .strict();

export const m31DiscrepancyV2RequestSchema = z
  .object({
    evidence_git_blob: shaSchema,
    affected_targets: z.array(z.string().min(1)).min(1),
    conflict: z.unknown(),
    recorded_by: z.string().min(1),
    predecessor_discrepancy_id: z.string().nullable(),
    resolution: z
      .object({
        resolves_discrepancy_id: z.string().min(1),
        resolution_code: z.string().min(1),
        evidence_digest: digestSchema,
      })
      .strict()
      .optional(),
    resolved_by: z.string().min(1).optional(),
  })
  .strict();

export const m31ProposalV2RequestSchema = z
  .object({
    repository: z.string().min(1),
    target: m31ActionTargetV2Schema,
    snapshot_id: z.string().min(1),
    evidence_path: z.string().min(1),
    action_kind: m31ActionKindV2Schema,
    action_parameters: z.unknown(),
    actor: z.string().min(1),
    policy_digest: digestSchema,
    verifier_registry_digest: digestSchema,
    ttl_ms: z.number().int().positive().optional(),
    max_evidence_age_ms: z.number().int().nonnegative().optional(),
  })
  .strict();

export const m31CompareV2RequestSchema = z
  .object({
    observation: z
      .object({
        known: z.boolean(),
        target: m31ActionTargetV2Schema,
        policy_digest: digestSchema,
        verifier_registry_digest: digestSchema,
        observed_at: timestampSchema,
      })
      .strict(),
    validity_window_ms: z.number().int().positive().max(60_000).optional(),
  })
  .strict();

export const m31IdParamsSchema = z.object({ id: z.string().min(1) });
export const m31SnapshotDiscrepancyParamsSchema = z.object({ snapshot_id: z.string().min(1) });
export const m31V2ResponseSchema = z.record(z.unknown());
