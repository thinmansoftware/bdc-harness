/**
 * Zod schemas for admin API endpoints.
 *
 * Currently scoped to operator-only admin controls such as provider throttle,
 * Cauldron drain mode, and Overseer capability circuit reset.
 */
import { z } from '@hono/zod-openapi';

/** POST /api/admin/throttle request body. */
export const throttleBodySchema = z.object({ paused: z.boolean() }).openapi('AdminThrottleBody');

/**
 * POST /api/admin/throttle response.
 * `paused` echoes the resulting gate state so the caller can confirm without
 * a follow-up GET.
 */
export const throttleResponseSchema = z
  .object({
    success: z.boolean(),
    paused: z.boolean(),
    message: z.string(),
    engagedBy: z.enum(['operator', 'auto']).optional(),
  })
  .openapi('AdminThrottleResponse');

export const drainBodySchema = z
  .object({
    draining: z.boolean(),
    reason: z.string().trim().max(500).optional(),
  })
  .openapi('AdminDrainBody');

export const drainResponseSchema = z
  .object({
    success: z.boolean(),
    changed: z.boolean().optional(),
    mode: z.enum(['normal', 'draining']),
    drained: z.boolean(),
    activeLeaseCount: z.number().int().nonnegative(),
    activeRunCount: z.number().int().nonnegative(),
    activeRunIds: z.array(z.string()),
    updatedAt: z.string().nullable(),
  })
  .openapi('AdminDrainResponse');

const overseerCapabilitySchema = z.enum(['escalation', 'repair', 'branch', 'lifecycle', 'merge']);
const overseerCircuitStateSchema = z.enum(['closed', 'open']);
const overseerDigestSchema = z.string().regex(/^[0-9a-f]{64}$/);

const overseerCapabilityStateSchema = z
  .object({
    capability: overseerCapabilitySchema,
    action_enabled: z.boolean(),
    circuit_state: overseerCircuitStateSchema,
    circuit_reason: z.string().nullable(),
    circuit_opened_at: z.string().nullable(),
    policy_digest: overseerDigestSchema,
    verifier_registry_digest: overseerDigestSchema,
    updated_at: z.string(),
    updated_by: z.string(),
  })
  .openapi('OverseerCapabilityState');

const overseerCapabilityEventSchema = z
  .object({
    event_id: z.string(),
    capability: overseerCapabilitySchema,
    event_type: z.enum([
      'gate_allowed',
      'gate_denied',
      'circuit_opened',
      'circuit_reset',
      'adapter_attempt',
    ]),
    reason: z.string(),
    actor: z.string(),
    correlation_id: z.string(),
    proposal_id: z.string().nullable(),
    execution_id: z.string().nullable(),
    policy_digest: overseerDigestSchema,
    verifier_registry_digest: overseerDigestSchema,
    details: z.record(z.unknown()),
    created_at: z.string(),
  })
  .openapi('OverseerCapabilityEvent');

export const resetOverseerCapabilityCircuitBodySchema = z
  .object({
    capability: overseerCapabilitySchema,
    reason: z.string().trim().min(1),
    correlation_id: z.string().trim().min(1),
    policy_digest: overseerDigestSchema,
    verifier_registry_digest: overseerDigestSchema,
    actor: z.string().trim().min(1).optional(),
  })
  .openapi('ResetOverseerCapabilityCircuitBody');

export const resetOverseerCapabilityCircuitResponseSchema = z
  .object({
    success: z.boolean(),
    state: overseerCapabilityStateSchema,
    event: overseerCapabilityEventSchema,
  })
  .openapi('ResetOverseerCapabilityCircuitResponse');
