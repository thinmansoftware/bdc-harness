import { z } from '@hono/zod-openapi';

// Row-count bounds for the read-only provider-attempts dashboard feed.
// Prod holds ~1505 total attempt rows (2026-08-01), and the Command Center
// cockpit (bdc-xo#1312) wants a useful recent window without paginating
// heavily -- hence a generous default (200) and a hard cap (1000) that still
// bounds a single response. These are read-only visibility numbers, not
// pagination guarantees; adjust here if the cockpit needs a wider window.
export const PROVIDER_ATTEMPTS_DEFAULT_LIMIT = 200;
export const PROVIDER_ATTEMPTS_MAX_LIMIT = 1000;

export const providerAttemptsQuerySchema = z.object({
  since: z.string().optional(),
  // Oversized positive integers are CLAMPED to the max, not rejected. The
  // cockpit is a read-only dashboard; a caller asking for more rows than the
  // cap gets the cap (the DB layer clamps identically as defense-in-depth),
  // never a 400. Only non-positive / non-integer values are rejected.
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .optional()
    .transform(value =>
      value === undefined ? undefined : Math.min(value, PROVIDER_ATTEMPTS_MAX_LIMIT)
    ),
});

// One raw row from remote_agent_provider_attempts. Field names are snake_case
// to match the table columns exactly (no aggregation, no renaming) -- the
// cockpit consumes and aggregates these downstream. outcome_class and
// reason_code are nullable in the schema (5 NULL-outcome rows exist in prod);
// they are RETURNED, never filtered.
export const providerAttemptRowSchema = z.object({
  provider: z.string(),
  model: z.string(),
  outcome_class: z.string().nullable(),
  reason_code: z.string().nullable(),
  started_at: z.string(),
  completed_at: z.string().nullable(),
  served_model_id: z.string().nullable(),
});

export const providerAttemptsResponseSchema = z.object({
  items: z.array(providerAttemptRowSchema),
});
