/**
 * Zod schemas for admin API endpoints.
 *
 * Currently scoped to the global Claude provider throttle gate
 * (POST /api/admin/throttle). Added by WO-HARNESS-RATE-LIMIT-AUTO-PAUSE-ENGINE-01
 * so operators can manually pause/release every in-flight Claude SDK call when
 * the auto-engage heuristic misses or needs to be pre-empted.
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
    clearOnBoot: z.boolean().default(false),
  })
  .openapi('AdminDrainBody');

export const drainResponseSchema = z
  .object({
    success: z.boolean(),
    changed: z.boolean().optional(),
    mode: z.enum(['normal', 'draining']),
    drained: z.boolean(),
    recreateSafe: z.boolean(),
    activeLeaseCount: z.number().int().nonnegative(),
    activeRunCount: z.number().int().nonnegative(),
    pendingRunCount: z.number().int().nonnegative(),
    runningRunCount: z.number().int().nonnegative(),
    survivingRunCount: z.number().int().nonnegative(),
    activeRunIds: z.array(z.string()),
    clearOnBoot: z.boolean(),
    updatedAt: z.string().nullable(),
  })
  .openapi('AdminDrainResponse');

/** 503 body for routes that refuse new dispatch while Cauldron is draining. */
export const drainDispatchErrorSchema = z
  .object({
    error: z.string(),
    detail: z.string().optional(),
    code: z.literal('cauldron_draining').optional(),
  })
  .openapi('DrainDispatchError');
