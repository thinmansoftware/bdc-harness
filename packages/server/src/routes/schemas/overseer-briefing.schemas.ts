import { z } from '@hono/zod-openapi';

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const channelSchema = z.enum(['dispatch', 'builder_monitor', 'notion']);

export const operatorCardParamsSchema = z.object({
  card_id: digestSchema.openapi({ param: { name: 'card_id', in: 'path' } }),
});

export const operatorCardListQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const deliveryJobSchema = z.object({
  card_id: digestSchema,
  channel: channelSchema,
  state: z.enum(['pending', 'leased', 'succeeded', 'exhausted', 'indeterminate']),
  attempts_started: z.number().int().min(0).max(3),
  next_attempt_at: z.string(),
  lease_owner: z.string().nullable(),
  lease_expires_at: z.string().nullable(),
  fencing_token: z.number().int().nonnegative(),
  updated_at: z.string(),
});

const operatorCardSchema = z.object({
  card_id: digestSchema,
  identity_version: z.literal('overseer-actionable-event-v1'),
  canonical_event_identity: z.record(z.unknown()),
  payload_digest: digestSchema,
  payload: z.record(z.unknown()),
  run_id: z.string(),
  wo_id: z.string(),
  repository: z.string(),
  branch: z.string().nullable(),
  pr_url: z.string().nullable(),
  pr_number: z.number().int().positive().nullable(),
  head_sha: z.string().nullable(),
  base_branch: z.string().nullable(),
  base_sha: z.string().nullable(),
  checks: z.record(z.unknown()),
  mergeability: z.string(),
  blocker: z.string(),
  mechanical_evidence: z.record(z.unknown()),
  recovery_attempted: z.record(z.unknown()),
  proposed_remediation: z.record(z.unknown()),
  next_permitted_action: z.string(),
  responsible_actor: z.string(),
  actionable_event_at: z.string(),
  required_ruling: z.string().nullable(),
  evidence_links: z.record(z.unknown()),
  lifecycle_classification: z.string(),
  governance_classification: z.string(),
  created_at: z.string(),
});

const receiptSchema = z.object({
  receipt_id: z.string(),
  card_id: digestSchema,
  channel: channelSchema,
  attempt_number: z.number().int().min(1).max(3),
  phase: z.enum(['started', 'terminal']),
  started_at: z.string(),
  completed_at: z.string().nullable(),
  outcome: z
    .enum(['succeeded', 'transient_failure', 'permanent_failure', 'indeterminate'])
    .nullable(),
  sanitized_status: z.string().nullable(),
  error_class: z.string().nullable(),
  next_attempt_at: z.string().nullable(),
  provider_receipt_id: z.string().nullable(),
  fencing_token: z.number().int().nonnegative(),
  created_at: z.string(),
});

export const operatorCardViewSchema = z.object({
  card: operatorCardSchema,
  jobs: z.array(deliveryJobSchema),
  receipts: z.array(receiptSchema),
  delivery_summary: z.record(channelSchema, deliveryJobSchema),
});

export const operatorCardListResponseSchema = z.object({
  items: z.array(operatorCardViewSchema),
  next_cursor: z.string().nullable(),
});

export const operatorCardResponseSchema = operatorCardViewSchema;
