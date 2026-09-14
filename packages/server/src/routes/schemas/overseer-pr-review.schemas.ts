import { z } from '@hono/zod-openapi';

const nonempty = z.string().trim().min(1);
const headShaSchema = z.string().regex(/^[0-9a-fA-F]{40}$/, 'headSha must be a full 40-hex SHA');

export const prReviewStatusQuerySchema = z
  .object({
    owner: nonempty,
    repo: nonempty,
    prNumber: z.coerce.number().int().positive(),
  })
  .strict();

export const prReviewRequestBodySchema = z
  .object({
    owner: nonempty,
    repo: nonempty,
    prNumber: z.number().int().positive(),
    headSha: headShaSchema,
    reason: nonempty,
  })
  .strict()
  .openapi('PrReviewRequestBody');

export const prReviewRequestResponseSchema = z
  .object({
    ok: z.literal(true),
    messageId: z.string(),
    alreadyExisted: z.boolean(),
    correlationId: z.string(),
  })
  .openapi('PrReviewRequestResponse');

export const prReviewRequestHeadNotCurrentSchema = z
  .object({
    ok: z.literal(false),
    error: z.literal('head_not_current'),
    currentHead: z.string(),
  })
  .openapi('PrReviewRequestHeadNotCurrent');

export const prReviewRequestHeadLookupFailedSchema = z
  .object({
    ok: z.literal(false),
    error: z.literal('head_lookup_failed'),
  })
  .openapi('PrReviewRequestHeadLookupFailed');

const prReviewLastReviewSchema = z.object({
  messageId: z.string(),
  headSha: z.string(),
  verdict: z.enum(['approved', 'changes_requested', 'other']).nullable(),
  verdictId: z.string().nullable(),
});

const prReviewLatestIngestSchema = z.object({
  disposition: z.string(),
  reason: z.string().nullable(),
  headSha: z.string().nullable(),
});

export const prReviewStatusResponseSchema = z
  .object({
    owner: z.string(),
    repo: z.string(),
    prNumber: z.number().int().positive(),
    current_head: z.string().nullable(),
    last_review: prReviewLastReviewSchema.nullable(),
    last_judged_head: z.string().nullable(),
    head_moved: z.boolean(),
    consecutive_auto_rereviews: z.number().int().nonnegative(),
    max_consecutive_auto_rereviews: z.number().int().positive(),
    total_auto_rereviews: z.number().int().nonnegative(),
    max_total_auto_rereviews: z.number().int().positive(),
    latest_ingest: prReviewLatestIngestSchema.nullable(),
    why_no_review: z.string(),
  })
  .openapi('PrReviewStatusResponse');

export const prReviewQueueQuerySchema = z
  .object({
    status: z.enum(['queued', 'claimed', 'failed']).optional(),
  })
  .strict();

const prReviewQueueItemSchema = z.object({
  id: z.string(),
  status: z.enum(['queued', 'claimed', 'done', 'failed', 'cancelled']),
  age_seconds: z.number().int().nonnegative(),
  owner: z.string().nullable(),
  repo: z.string().nullable(),
  prNumber: z.number().int().positive().nullable(),
  headSha: z.string().nullable(),
  repeat_reason: z.string().nullable(),
  correlation_id: z.string(),
});

const prReviewOrphanedSchema = z.object({
  recipient: z.string(),
  count: z.number().int().nonnegative(),
  oldest_age_seconds: z.number().int().nonnegative(),
});

export const prReviewQueueResponseSchema = z
  .object({
    items: z.array(prReviewQueueItemSchema),
    orphaned: z.array(prReviewOrphanedSchema),
  })
  .openapi('PrReviewQueueResponse');

export type PrReviewStatusQuery = z.infer<typeof prReviewStatusQuerySchema>;
export type PrReviewRequestBody = z.infer<typeof prReviewRequestBodySchema>;
export type PrReviewQueueQuery = z.infer<typeof prReviewQueueQuerySchema>;
