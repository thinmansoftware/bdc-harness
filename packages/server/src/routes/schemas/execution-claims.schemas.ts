import { z } from '@hono/zod-openapi';

// M-27B strict execution-claim API schemas. Every request body is `.strict()`
// so unknown fields are rejected. Action identity uses closed literals; the XO
// holder token is supplied only via the X-XO-Holder-Token header, never a body
// field.

const targetShaSchema = z.string().regex(/^[0-9a-f]{40}$/);
const actionKindSchema = z.literal('production_deploy');
const environmentSchema = z.literal('production');
const positiveInt = z.number().int().positive();
const leaseDurationSchema = z.number().int().positive().max(3_600_000);

export const executionClaimStatusSchema = z.enum(['active', 'released', 'completed']);
export const executionReconciliationStatusSchema = z.enum([
  'clear',
  'required',
  'resolved_retryable',
  'resolved_completed',
]);
export const executionEffectAttemptStateSchema = z.enum([
  'none',
  'armed',
  'completed',
  'reconciled',
]);
export const observedStateSchema = z.enum(['not_started', 'completed', 'partial', 'unknown']);

export const completionEvidenceSchema = z
  .object({
    verified_target_sha: targetShaSchema,
    active_work_count: z.number().int().min(0),
    backup_ready: z.boolean(),
    rollback_ready: z.boolean(),
    deployment_health: z.string().min(1),
    post_deploy_evidence: z.string().min(1),
  })
  .strict()
  .openapi('ExecutionCompletionEvidence');

export const reconciliationEvidenceSchema = z
  .object({
    observed_at: z.string().min(1),
    checked_by: z.string().min(1),
    command_or_source: z.string().min(1),
    observed_state: observedStateSchema,
    evidence_reference: z.string().min(1),
  })
  .strict()
  .openapi('ExecutionReconciliationEvidence');

export const executionClaimSchema = z
  .object({
    claim_id: z.string(),
    motion_id: z.string(),
    action_kind: z.string(),
    environment: z.string(),
    target_sha: z.string(),
    action_key: z.string(),
    motion_file_path: z.string(),
    motion_revision_sha: z.string(),
    claimant_principal: z.string(),
    claimant_xo_holder_id: z.string(),
    claimant_xo_lease_id: z.string(),
    claimant_xo_fencing_token: z.number(),
    execution_fencing_token: z.number(),
    status: executionClaimStatusSchema,
    reconciliation_status: executionReconciliationStatusSchema,
    effect_attempt_id: z.string().nullable(),
    effect_attempt_state: executionEffectAttemptStateSchema,
    effect_armed_at: z.string().nullable(),
    acquired_at: z.string(),
    renewed_at: z.string().nullable(),
    expires_at: z.string(),
    released_at: z.string().nullable(),
    completed_at: z.string().nullable(),
    external_effect_reference: z.string().nullable(),
    completion_evidence: z.record(z.unknown()).nullable(),
    reconciliation_evidence: z.record(z.unknown()).nullable(),
  })
  .openapi('ExecutionClaim');

// --- Request bodies -------------------------------------------------------

export const acquireExecutionClaimBodySchema = z
  .object({
    motion_id: z.string().min(1),
    action_kind: actionKindSchema,
    environment: environmentSchema,
    target_sha: targetShaSchema,
    motion_file_path: z.string().min(1),
    xo_holder_id: z.string().min(1),
    xo_lease_id: z.string().min(1),
    xo_fencing_token: positiveInt,
    lease_duration_ms: leaseDurationSchema.optional(),
  })
  .strict()
  .openapi('AcquireExecutionClaimBody');

export const renewExecutionClaimBodySchema = z
  .object({
    execution_fencing_token: positiveInt,
    xo_holder_id: z.string().min(1),
    xo_lease_id: z.string().min(1),
    xo_fencing_token: positiveInt,
    lease_duration_ms: leaseDurationSchema.optional(),
  })
  .strict()
  .openapi('RenewExecutionClaimBody');

export const executionFenceBodySchema = z
  .object({
    execution_fencing_token: positiveInt,
    xo_holder_id: z.string().min(1),
    xo_lease_id: z.string().min(1),
    xo_fencing_token: positiveInt,
  })
  .strict()
  .openapi('ExecutionFenceBody');

export const reconciliationRequiredBodySchema = z
  .object({
    execution_fencing_token: positiveInt,
    xo_holder_id: z.string().min(1),
    xo_lease_id: z.string().min(1),
    xo_fencing_token: positiveInt,
    effect_attempt_id: z.string().min(1),
    uncertainty: z
      .object({
        reported_at: z.string().min(1),
        summary: z.string().min(1),
      })
      .strict(),
  })
  .strict()
  .openapi('ExecutionReconciliationRequiredBody');

export const reconcileExecutionClaimBodySchema = z
  .object({
    execution_fencing_token: positiveInt,
    xo_holder_id: z.string().min(1),
    xo_lease_id: z.string().min(1),
    xo_fencing_token: positiveInt,
    effect_attempt_id: z.string().min(1),
    resolution: z.enum(['retryable', 'completed']),
    evidence: reconciliationEvidenceSchema,
    external_effect_reference: z.string().min(1).nullable().optional(),
  })
  .strict()
  .openapi('ReconcileExecutionClaimBody');

export const completeExecutionClaimBodySchema = z
  .object({
    execution_fencing_token: positiveInt,
    xo_holder_id: z.string().min(1),
    xo_lease_id: z.string().min(1),
    xo_fencing_token: positiveInt,
    effect_attempt_id: z.string().min(1),
    external_effect_reference: z.string().min(1),
    evidence: completionEvidenceSchema,
  })
  .strict()
  .openapi('CompleteExecutionClaimBody');

export const executionClaimIdParamsSchema = z.object({ claim_id: z.string().min(1) });

export const getExecutionClaimQuerySchema = z.object({
  motion_id: z.string().min(1),
  action_kind: actionKindSchema,
  environment: environmentSchema,
  target_sha: targetShaSchema,
});

// --- Responses ------------------------------------------------------------

export const acquireExecutionClaimResponseSchema = z
  .object({
    claim: executionClaimSchema,
    created: z.boolean(),
    outcome: z.enum([
      'acquired',
      'taken_over',
      'reactivated',
      'existing_active',
      'existing_completed',
    ]),
  })
  .openapi('AcquireExecutionClaimResponse');

export const renewExecutionClaimResponseSchema = z
  .object({ claim: executionClaimSchema, renewed: z.literal(true) })
  .openapi('RenewExecutionClaimResponse');

export const preEffectResponseSchema = z
  .object({
    claim_id: z.string(),
    permitted: z.literal(true),
    effect_attempt_id: z.string(),
    execution_fencing_token: z.number(),
    motion_revision_sha: z.string(),
  })
  .openapi('ExecutionPreEffectResponse');

export const reconciliationRequiredResponseSchema = z
  .object({ claim: executionClaimSchema, reconciliation_required: z.literal(true) })
  .openapi('ExecutionReconciliationRequiredResponse');

export const reconcileExecutionClaimResponseSchema = z
  .object({ claim: executionClaimSchema, resolution: z.enum(['retryable', 'completed']) })
  .openapi('ReconcileExecutionClaimResponse');

export const releaseExecutionClaimResponseSchema = z
  .object({ claim: executionClaimSchema, released: z.literal(true) })
  .openapi('ReleaseExecutionClaimResponse');

export const completeExecutionClaimResponseSchema = z
  .object({ claim: executionClaimSchema, completed: z.literal(true) })
  .openapi('CompleteExecutionClaimResponse');

export const getExecutionClaimResponseSchema = z
  .object({ claim: executionClaimSchema })
  .openapi('GetExecutionClaimResponse');

export const executionClaimErrorSchema = z
  .object({
    error: z
      .object({
        code: z.enum([
          'validation_failed',
          'authority_rejected',
          'claim_conflict',
          'stale_fence',
          'reconciliation_required',
          'effect_attempt_mismatch',
          'not_found',
        ]),
        message: z.string(),
      })
      .strict(),
  })
  .openapi('ExecutionClaimError');
