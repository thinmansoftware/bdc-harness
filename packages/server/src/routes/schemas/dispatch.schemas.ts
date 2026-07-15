import { z } from '@hono/zod-openapi';

export const dispatchTaskTypeSchema = z.enum([
  'agent_message',
  'run_review',
  'draft_spec',
  'run_report',
  'board_motion',
]);

export const dispatchMessageStatusSchema = z.enum([
  'queued',
  'claimed',
  'done',
  'failed',
  'cancelled',
]);

export const dispatchMessageSchema = z
  .object({
    id: z.string(),
    correlation_id: z.string(),
    idempotency_key: z.string(),
    task_type: dispatchTaskTypeSchema,
    sender: z.string(),
    recipient: z.string(),
    body: z.string(),
    status: dispatchMessageStatusSchema,
    result_body: z.string().nullable(),
    created_at: z.string(),
    claimed_at: z.string().nullable(),
    completed_at: z.string().nullable(),
    not_before: z.string().nullable(),
    lease_owner: z.string().nullable(),
    lease_expires_at: z.string().nullable(),
    fencing_token: z.number(),
    recipient_alias: z.literal('board').nullable().optional(),
    motion_id: z.string().nullable().optional(),
    motion_revision_sha: z.string().nullable().optional(),
    resolved_recipient: z.string().nullable().optional(),
    resolved_xo_lease_id: z.string().nullable().optional(),
    resolved_xo_fencing_token: z.number().nullable().optional(),
    resolved_at: z.string().nullable().optional(),
  })
  .openapi('DispatchMessage');

export const createDispatchMessageBodySchema = z
  .object({
    correlation_id: z.string().min(1),
    idempotency_key: z.string().min(1),
    task_type: dispatchTaskTypeSchema,
    sender: z.string().min(1),
    recipient: z.string().min(1),
    body: z.string().min(1),
    not_before: z.string().optional(),
  })
  .strict()
  .openapi('CreateDispatchMessageBody');

export const dispatchMessageIdParamsSchema = z.object({ id: z.string().min(1) });

export const listDispatchMessagesQuerySchema = z.object({
  recipient: z.string().optional(),
  status: dispatchMessageStatusSchema.optional(),
  limit: z.string().optional(),
});

export const claimDispatchMessageBodySchema = z
  .object({
    worker_id: z.string().min(1),
    delivery_principal: z.string().min(1).optional(),
    lease_duration_ms: z.number().int().positive().max(3_600_000).optional(),
  })
  .strict()
  .openapi('ClaimDispatchMessageBody');

export const postDispatchResultBodySchema = z
  .object({
    worker_id: z.string().min(1),
    fencing_token: z.number().int().nonnegative(),
    result_body: z.string(),
    status: z.enum(['done', 'failed']).optional(),
  })
  .strict()
  .openapi('PostDispatchResultBody');

export const dispatchWorkerStatusSchema = z.enum(['available', 'unavailable']);

export const dispatchWorkerSchema = z
  .object({
    worker_id: z.string(),
    host: z.string(),
    capabilities: z.record(z.unknown()),
    max_concurrency: z.number(),
    status: dispatchWorkerStatusSchema,
    registered_at: z.string(),
    last_heartbeat_at: z.string(),
  })
  .openapi('DispatchWorker');

export const registerDispatchWorkerBodySchema = z
  .object({
    worker_id: z.string().min(1),
    host: z.string().min(1),
    capabilities: z.record(z.unknown()).default({}),
    max_concurrency: z.number().int().positive().max(100).default(1),
  })
  .strict()
  .openapi('RegisterDispatchWorkerBody');

export const heartbeatDispatchWorkerBodySchema = z
  .object({
    worker_id: z.string().min(1),
    status: dispatchWorkerStatusSchema.optional(),
  })
  .strict()
  .openapi('HeartbeatDispatchWorkerBody');

export const dispatchMessageListResponseSchema = z
  .array(dispatchMessageSchema)
  .openapi('DispatchMessageListResponse');

export const dispatchStatusQuerySchema = z.object({
  worker_stale_after_ms: z.coerce.number().int().positive().max(86_400_000).optional(),
});

const dispatchStatusItemSchema = z.object({
  id: z.string(),
  sender: z.string(),
  recipient: z.string(),
  status: dispatchMessageStatusSchema,
  created_at: z.string(),
  body_preview: z.string(),
  result_preview: z.string().nullable(),
});

export const dispatchStatusResponseSchema = z
  .object({
    generated_at: z.string(),
    worker_stale_after_ms: z.number(),
    workers: z.array(dispatchWorkerSchema),
    queue: z.record(z.number()),
    operator_reports: z.array(dispatchStatusItemSchema),
    execution_handoffs: z.array(dispatchStatusItemSchema),
  })
  .openapi('DispatchStatusResponse');

export const executionHandoffBodySchema = z
  .object({
    correlation_id: z.string().min(1).max(200),
    idempotency_key: z.string().min(1).max(200),
    target: z.enum(['overseer', 'cauldron']),
    work_order_id: z.string().regex(/^WO-[A-Z0-9-]+$/),
    environment: z.enum(['local', 'staging']),
    target_repo: z.string().min(1).max(300),
    target_ref: z.string().regex(/^[0-9a-f]{40}$/i),
    approved: z.literal(true),
    approved_by: z.string().min(1).max(200),
    approval_ref: z.string().min(1).max(200),
    objective: z.string().min(1).max(4_000),
    constraints: z.array(z.string().min(1).max(1_000)).max(50),
  })
  .strict()
  .openapi('ExecutionHandoffBody');
