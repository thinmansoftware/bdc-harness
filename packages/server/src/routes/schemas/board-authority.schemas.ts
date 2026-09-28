import { z } from '@hono/zod-openapi';

export const boardSeatSchema = z.enum(['john', 'general', 'xo']);

export const xoLeaseSchema = z
  .object({
    lease_id: z.string(),
    principal_id: z.string(),
    seat_id: boardSeatSchema,
    holder_id: z.string(),
    fencing_token: z.number(),
    acquired_at: z.string(),
    renewed_at: z.string().nullable(),
    expires_at: z.string(),
    released_at: z.string().nullable(),
  })
  .openapi('XoLease');

export const xoLeaseAcquireBodySchema = z
  .object({
    principal_token: z.string().min(1).optional(),
    holder_id: z.string().min(1),
    holder_token: z.string().min(1),
    lease_duration_ms: z.number().int().positive().max(3_600_000).optional(),
  })
  .strict()
  .openapi('XoLeaseAcquireBody');

export const xoLeaseRenewBodySchema = z
  .object({
    principal_token: z.string().min(1).optional(),
    holder_id: z.string().min(1),
    holder_token: z.string().min(1),
    fencing_token: z.number().int().positive(),
    lease_duration_ms: z.number().int().positive().max(3_600_000).optional(),
  })
  .strict()
  .openapi('XoLeaseRenewBody');

export const xoLeaseReleaseBodySchema = z
  .object({
    principal_token: z.string().min(1).optional(),
    holder_id: z.string().min(1),
    holder_token: z.string().min(1),
    fencing_token: z.number().int().positive(),
  })
  .strict()
  .openapi('XoLeaseReleaseBody');

export const boardRecipientResponseSchema = z
  .object({
    ok: z.boolean(),
    reason: z.string().optional(),
    principal_id: z.string().optional(),
    seat_id: boardSeatSchema.optional(),
    lease_id: z.string().optional(),
    fencing_token: z.number().optional(),
  })
  .openapi('BoardRecipientResponse');

export const scopeApprovalRecordBodySchema = z
  .object({
    principal_token: z.string().min(1).optional(),
    holder_id: z.string().min(1),
    holder_token: z.string().min(1),
    fencing_token: z.number().int().positive(),
    repo: z.string().min(1),
    pr_number: z.number().int().positive(),
    head_sha: z.string().regex(/^[0-9a-f]{40}$/),
    conditions: z
      .string()
      .min(1)
      .max(4000)
      .refine(value => value.trim().length > 0),
    evidence_url: z
      .string()
      .url()
      .refine(value => value.startsWith('https://')),
  })
  .strict()
  .openapi('ScopeApprovalRecordBody');

export const scopeApprovalRevokeParamsSchema = z.object({ approval_id: z.string().uuid() });
export const scopeApprovalRevokeBodySchema = z
  .object({
    principal_token: z.string().min(1).optional(),
    holder_id: z.string().min(1),
    holder_token: z.string().min(1),
    fencing_token: z.number().int().positive(),
    reason: z
      .string()
      .min(1)
      .refine(value => value.trim().length > 0),
  })
  .strict()
  .openapi('ScopeApprovalRevokeBody');

export const scopeApprovalPublicQuerySchema = z
  .object({
    repo: z.string().min(1),
    pr_number: z.coerce.number().int().positive(),
    head_sha: z.string().regex(/^[0-9a-f]{40}$/),
    base_sha: z.string().regex(/^[0-9a-f]{40}$/),
  })
  .strict();

export const scopeApprovalResponseSchema = z
  .object({
    approval_id: z.string().uuid(),
    repo: z.string(),
    pr_number: z.number().int(),
    target_branch: z.string(),
    head_sha: z.string(),
    base_sha: z.string(),
    authority: z.literal('john'),
    recorded_by_principal_id: z.string(),
    recorded_by_seat: boardSeatSchema,
    xo_lease_id: z.string(),
    xo_fencing_token: z.number(),
    conditions: z.string(),
    evidence_url: z.string(),
    recorded_at: z.string(),
  })
  .openapi('ScopeApproval');

export const scopeApprovalDecisionSchema = z
  .object({
    decision: z.enum(['allow', 'deny']),
    approval: scopeApprovalResponseSchema.optional(),
    reason: z.string().optional(),
  })
  .openapi('ScopeApprovalDecision');
