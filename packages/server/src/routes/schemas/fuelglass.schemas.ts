/**
 * Zod schemas for Fuelglass subscription seat usage.
 *
 * GET /api/fuelglass/seats reports measured usage. POST /api/fuelglass/cutoff
 * persists the operator cutoff until cleared. Added by WO-HARNESS-FUELGLASS-SEAT-GATE-01.
 */
import { z } from '@hono/zod-openapi';

const sevenDaySchema = z.union([
  z.object({
    used_percent: z.number(),
    remaining_percent: z.number(),
    resets_at: z.string(),
  }),
  z.literal('UNKNOWN'),
  z.literal('NOT_APPLICABLE'),
]);

const seatWindowSchema = z.object({
  name: z.string(),
  used_percent: z.number(),
  remaining_percent: z.number(),
  resets_at: z.string(),
  window_seconds: z.union([z.number(), z.literal('UNKNOWN')]).optional(),
});

const seatReadingSchema = z.object({
  seat: z.enum(['claude', 'codex', 'cursor']),
  limit_source: z.enum(['measured', 'UNKNOWN']),
  plan: z.string().optional(),
  windows: z.array(seatWindowSchema),
  seven_day: sevenDaySchema,
  gate_windows: z.array(z.string()),
  note: z.string(),
  probed_at: z.string(),
  endpoint: z.string(),
  http_status: z.number().optional(),
  allowed: z.boolean().optional(),
  limit_reached: z.boolean().optional(),
  reading_source: z.enum(['probe', 'pushed']).optional(),
  observed_at: z.string().optional(),
});

const cutoffSchema = z.object({
  percent: z.number(),
  source: z.enum(['operator', 'env', 'default']),
  set_at: z.string().optional(),
  set_by: z.string().optional(),
});

export const fuelglassSeatsResponseSchema = z
  .object({
    success: z.boolean(),
    generated_at: z.string(),
    cutoff: cutoffSchema,
    gate_enabled: z.boolean(),
    seats: z.object({
      claude: seatReadingSchema,
      codex: seatReadingSchema,
      cursor: seatReadingSchema,
    }),
  })
  .openapi('FuelglassSeatsResponse');

const CUTOFF_RANGE_ERROR = 'seat_cutoff_out_of_range: percent must be between 1 and 95';

/**
 * POST /api/fuelglass/cutoff. percent null clears the operator override.
 * The range is 1-95: a higher cutoff would switch the gate off in effect.
 */
export const fuelglassCutoffBodySchema = z
  .object({
    percent: z
      .number()
      .min(1, { message: CUTOFF_RANGE_ERROR })
      .max(95, { message: CUTOFF_RANGE_ERROR })
      .nullable(),
    reason: z.string().optional(),
  })
  .openapi('FuelglassCutoffBody');

export const fuelglassCutoffResponseSchema = z
  .object({
    success: z.boolean(),
    cutoff: cutoffSchema,
  })
  .openapi('FuelglassCutoffResponse');

const READING_FIELDS = {
  seat: z.string(),
  used_percent: z.number(),
  remaining_percent: z.number(),
  resets_at: z.string(),
  observed_at: z.string(),
  source: z.string(),
} as const;

/**
 * Strict six-field payload. The readings route publishes this component and
 * does not attach it as request middleware: the handler scans the raw JSON
 * for credentials before safeParse.
 */
export const fuelglassReadingPushBodySchema = z
  .object(READING_FIELDS)
  .strict()
  .openapi('FuelglassReadingPushBody');

export const fuelglassReadingRecordSchema = z
  .object({
    ...READING_FIELDS,
    received_at: z.string(),
  })
  .openapi('FuelglassReadingRecord');

export const fuelglassReadingPostResponseSchema = z
  .object({
    success: z.boolean(),
    reading: fuelglassReadingRecordSchema,
  })
  .openapi('FuelglassReadingPostResponse');

export const fuelglassReadingGetResponseSchema = z
  .object({
    success: z.boolean(),
    reading: fuelglassReadingRecordSchema.nullable(),
    fresh: z.boolean(),
    age_seconds: z.number().nullable(),
    max_age_minutes: z.number(),
  })
  .openapi('FuelglassReadingGetResponse');
