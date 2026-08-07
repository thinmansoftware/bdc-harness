/**
 * Zod schemas for the Taskmaster Slice 1 operator routes
 * (WO-HARNESS-TASKMASTER-SLICE1-01). One file per domain per repo
 * convention; types derive via z.infer -- no parallel interfaces.
 */
import { z } from '@hono/zod-openapi';

export const taskmasterPauseStateSchema = z.enum(['RUNNING', 'PAUSED', 'HARD_PAUSE']);

export const taskmasterTickHealthSchema = z.enum(['healthy', 'degraded', 'not_running']);

export const taskmasterStatusResponseSchema = z
  .object({
    pause_state: taskmasterPauseStateSchema,
    pause_scope: z.string().nullable(),
    pause_reason: z.string().nullable(),
    pause_actor: z.string().nullable(),
    epoch: z.number(),
    tick_health: taskmasterTickHealthSchema,
    interval_ms: z.number(),
    last_tick_at: z.string().nullable(),
    headroom_state: z.enum(['OK', 'LOW', 'UNKNOWN']).nullable(),
    effects_last_24h: z.number(),
  })
  .openapi('TaskmasterStatusResponse');

export const taskmasterPauseBodySchema = z
  .object({
    reason: z.string().max(2000).optional(),
    scope: z.string().max(200).optional(),
    actor: z.string().max(200).default('operator'),
  })
  .openapi('TaskmasterPauseBody');

export const taskmasterResumeBodySchema = z
  .object({
    actor: z.string().max(200).default('john'),
  })
  .openapi('TaskmasterResumeBody');

export const taskmasterControlResponseSchema = z
  .object({
    pause_state: taskmasterPauseStateSchema,
    epoch: z.number(),
    expired_proposals: z.number().optional(),
  })
  .openapi('TaskmasterControlResponse');

export type TaskmasterStatusResponse = z.infer<typeof taskmasterStatusResponseSchema>;
export type TaskmasterPauseBody = z.infer<typeof taskmasterPauseBodySchema>;
export type TaskmasterResumeBody = z.infer<typeof taskmasterResumeBodySchema>;
export type TaskmasterControlResponse = z.infer<typeof taskmasterControlResponseSchema>;
