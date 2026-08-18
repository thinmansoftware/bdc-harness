/**
 * Zod schemas for Smart Cauldron cascade operator endpoints.
 *
 * WO-HARNESS-FRONTIER-CLIMB-APPROVAL-GATE-01. An automatic climb into a premium
 * tier pauses as 'pending-frontier-approval'; these endpoints let an operator
 * approve (resume + fire the premium tier exactly once) or reject (terminate as
 * needs-human, no fire). Auth is covered by the global /api/* operator-token
 * middleware -- no per-route auth schema is required.
 */
import { z } from '@hono/zod-openapi';

/** POST /api/cascades/{cascadeId}/reject-frontier request body (reason optional). */
export const rejectFrontierBodySchema = z
  .object({
    reason: z.string().trim().max(1000).optional(),
  })
  .openapi('CascadeRejectFrontierBody');

/**
 * Shared response for approve-frontier / reject-frontier.
 * `alreadyResolved` is true on an idempotent no-op (the pause was already
 * approved or rejected); `resumeCascadeId` is present only when an approve
 * launched a resumed cascade.
 */
export const cascadeFrontierApprovalResponseSchema = z
  .object({
    success: z.boolean(),
    message: z.string(),
    cascadeId: z.string(),
    resolution: z.enum(['approved', 'rejected']),
    status: z.string(),
    resumeCascadeId: z.string().optional(),
    alreadyResolved: z.boolean().optional(),
  })
  .openapi('CascadeFrontierApprovalResponse');

export type RejectFrontierBody = z.infer<typeof rejectFrontierBodySchema>;
export type CascadeFrontierApprovalResponse = z.infer<typeof cascadeFrontierApprovalResponseSchema>;
