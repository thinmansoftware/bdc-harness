import { z } from '@hono/zod-openapi';

export const createDispatchTaskTypeSchema = z.enum([
  'agent_message',
  'run_review',
  'draft_spec',
  'run_report',
  'board_motion',
]);

export const dispatchTaskTypeSchema = z.enum([
  'agent_message',
  'run_review',
  'draft_spec',
  'run_report',
  'board_motion',
  'run_work',
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
    task_type: createDispatchTaskTypeSchema,
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

const gitShaSchema = z.string().regex(/^[0-9a-f]{40}$/i);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/i);
const safeRelativeArtifactPathSchema = z
  .string()
  .min(1)
  .max(240)
  .refine(path => {
    if (path.includes('\\') || path.startsWith('/') || /^[A-Za-z]:/.test(path)) return false;
    const segments = path.split('/');
    return segments.every(segment => segment.length > 0 && segment !== '.' && segment !== '..');
  }, 'artifact path must be a safe relative POSIX path');

const transferredArtifactSchema = z
  .object({
    path: safeRelativeArtifactPathSchema,
    sha256: sha256Schema,
    content_base64: z.string().min(1),
    size_bytes: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((artifact, ctx) => {
    let decoded: Buffer;
    try {
      decoded = Buffer.from(artifact.content_base64, 'base64');
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid base64 payload' });
      return;
    }
    if (
      decoded.toString('base64') !== artifact.content_base64 ||
      decoded.length !== artifact.size_bytes
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'artifact size or base64 mismatch' });
    }
  });

export const runWorkRequestBodySchema = z
  .object({
    version: z.literal('v1'),
    correlation_id: z.string().min(1).max(200),
    idempotency_key: z.string().min(1).max(300),
    workflow_run_id: z.string().min(1).max(200),
    node_id: z.string().min(1).max(200),
    provider_attempt_id: z.string().min(1).max(200),
    provider_attempt_number: z.number().int().positive(),
    execution_mode: z.enum(['read_only', 'repository_write']),
    repository: z
      .object({
        remote_url: z.string().url().max(1_000),
        branch: z.string().min(1).max(240),
        requested_sha: gitShaSchema,
      })
      .strict(),
    model: z.literal('cursor-grok-4.5-high'),
    prompt: z.string().min(1).max(2_000_000),
    artifacts: z
      .object({
        source_root: z.string().min(1).max(1_000),
        inputs: z.array(transferredArtifactSchema).max(64),
        outputs: z.array(safeRelativeArtifactPathSchema).max(64),
        max_file_bytes: z.number().int().positive().max(16_777_216),
        max_total_bytes: z.number().int().positive().max(67_108_864),
      })
      .strict(),
  })
  .strict()
  .superRefine((request, ctx) => {
    const totalBytes = request.artifacts.inputs.reduce((sum, item) => sum + item.size_bytes, 0);
    if (totalBytes > request.artifacts.max_total_bytes) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'artifact total exceeds limit' });
    }
    if (request.artifacts.inputs.some(item => item.size_bytes > request.artifacts.max_file_bytes)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'artifact file exceeds limit' });
    }
  })
  .openapi('RunWorkRequestBody');

export const runWorkResultBodySchema = z
  .object({
    version: z.literal('v1'),
    worker_id: z.string().min(1).max(200),
    fencing_token: z.number().int().nonnegative(),
    outcome: z.enum(['succeeded', 'failed', 'timed_out', 'blocked']),
    requested_sha: gitShaSchema,
    resulting_sha: gitShaSchema.nullable(),
    output: z.string().max(2_000_000),
    model: z.literal('cursor-grok-4.5-high'),
    artifacts: z.object({ outputs: z.array(transferredArtifactSchema).max(64) }).strict(),
  })
  .strict()
  .openapi('RunWorkResultBody');

export type RunWorkRequestBody = z.infer<typeof runWorkRequestBodySchema>;
export type RunWorkResultBody = z.infer<typeof runWorkResultBodySchema>;

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
    principal_id: z.string().trim().toLowerCase().min(1),
  })
  .strict()
  .openapi('DispatchMailboxPrincipalBody');

export const listDispatchMessagesQuerySchema = z.object({
  recipient: z.string().optional(),
  status: dispatchMessageStatusSchema.optional(),
  limit: z.string().optional(),
  subject_key: z.string().optional(),
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
