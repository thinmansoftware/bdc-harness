import { z } from '@hono/zod-openapi';

export const cleanupReportSchema = z.object({
  removed: z.array(z.string()),
  skipped: z.array(z.object({ id: z.string(), reason: z.string() })),
  errors: z.array(z.object({ id: z.string(), error: z.string() })),
  sessionsDeleted: z.number().int().nonnegative(),
});
