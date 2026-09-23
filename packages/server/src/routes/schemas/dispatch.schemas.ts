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

export const dispatchMessagePrioritySchema = z.enum(['blocker', 'normal', 'heartbeat']);
export const dispatchTaskOutcomeSchema = z.enum(['succeeded', 'failed', 'blocked']);
export const dispatchRouteDispositionSchema = z.enum(['unroutable', 'superseded']);

export const dispatchMessageSchema = z
  .object({
    id: z.string(),
    correlation_id: z.string(),
    idempotency_key: z.string(),
    task_type: dispatchTaskTypeSchema,
    sender: z.string(),
    sender_principal_id: z.string().nullable(),
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
    priority: dispatchMessagePrioritySchema,
    task_outcome: dispatchTaskOutcomeSchema.nullable(),
    acknowledged_at: z.string().nullable(),
    acknowledged_by: z.string().nullable(),
    addressed_at: z.string().nullable(),
    addressed_by: z.string().nullable(),
    escalated_tg_at: z.string().nullable(),
    escalated_sms_at: z.string().nullable(),
    subject_key: z.string().nullable(),
    route_disposition: dispatchRouteDispositionSchema.nullable(),
    supersedes_id: z.string().nullable(),
    repeat_reason: z.string().nullable(),
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
    priority: dispatchMessagePrioritySchema.optional(),
    subject_key: z.string().min(1).nullable().optional(),
    repeat_reason: z.string().min(1).nullable().optional(),
  })
  .strict()
  .openapi('CreateDispatchMessageBody');

export const dispatchMessageIdParamsSchema = z.object({ id: z.string().min(1) });
export const dispatchSenderBodySchema = z.object({ sender: z.string().min(1) }).strict();
export const supersedeDispatchMessageBodySchema = z
  .object({
    sender: z.string().min(1),
    replacement: createDispatchMessageBodySchema.omit({ sender: true }),
  })
  .strict()
  .openapi('SupersedeDispatchMessageBody');

export const dispatchMailboxPrincipalBodySchema = z
  .object({
    // WO-HARNESS-DISPATCH-ACK-ACTOR-BINDING-01 (M-187a item 2): the body no
    // longer supplies the actor -- the actor is the authenticated caller. The
    // field is retained for ONE release as an optional cross-check only (a
    // follow-on WO removes it). If present and not equal to the resolved actor
    // the route returns 409 actor_mismatch.
    principal_id: z.string().trim().toLowerCase().min(1).optional(),
  })
  .strict()
  .openapi('DispatchMailboxPrincipalBody');

export const listDispatchMessagesQuerySchema = z.object({
  recipient: z.string().optional(),
  status: dispatchMessageStatusSchema.optional(),
  limit: z.string().optional(),
  subject_key: z.string().optional(),
  // WO-HARNESS-DISPATCH-ACK-ACTOR-BINDING-01: forward-compatible pass-through
  // for the sibling's listMessages route_disposition filter. Kept as a loose
  // string (not the enum) so this WO does not take a hard dependency on the
  // sibling's widened disposition set when it merges first.
  route_disposition: z.string().optional(),
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
    task_outcome: dispatchTaskOutcomeSchema.nullable().optional(),
  })
  .strict()
  .openapi('PostDispatchResultBody');

/**
 * WO-HARNESS-ACP-DISPATCH-SLICE-01: lease renewal for long-running ACP legs.
 * Same fencing discipline as the result body -- the caller proves it is the
 * current lease owner holding the current token.
 */
export const renewDispatchLeaseBodySchema = z
  .object({
    worker_id: z.string().min(1),
    fencing_token: z.number().int().nonnegative(),
    lease_duration_ms: z.number().int().positive().max(3_600_000).optional(),
  })
  .strict()
  .openapi('RenewDispatchLeaseBody');

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

export const mailboxDepthSchema = z
  .object({
    unread: z.number(),
    legacy_unverified: z.number(),
    acked_open: z.number(),
    addressed_by_mind: z.number(),
    disposed_by_machine: z.number(),
    surfaced_unacked: z.number(),
    surfaced_acked: z.number(),
  })
  .openapi('MailboxDepth');

export const dispatchStatusResponseSchema = z
  .object({
    generated_at: z.string(),
    worker_stale_after_ms: z.number(),
    workers: z.array(dispatchWorkerSchema),
    // WO-HARNESS-DISPATCH-ACK-ACTOR-BINDING-01 (M-187a item 5): the worker
    // lifecycle status counts, renamed from `queue`. `queue` is retained as an
    // alias for one release.
    worker_lifecycle: z.record(z.number()),
    queue: z.record(z.number()),
    // Mailbox depth in seven cutover-split buckets, keyed by principal id.
    mailbox: z.record(mailboxDepthSchema),
    // The receipt cutover instant (dispatch_receipt_cutover.applied_at), or null
    // when the sibling's cutover table has not been applied yet.
    cutover_at: z.string().nullable(),
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
