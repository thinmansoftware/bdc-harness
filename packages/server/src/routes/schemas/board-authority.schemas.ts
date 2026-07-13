import { z } from '@hono/zod-openapi';

export const boardSeatSchema = z.enum(['john', 'general', 'xo']);

export const boardPrincipalProofSchema = z
  .object({
    principal_token: z.string().min(1).optional(),
    holder_id: z.string().min(1),
    holder_token: z.string().min(1),
  })
  .strict()
  .openapi('BoardPrincipalProof');

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
