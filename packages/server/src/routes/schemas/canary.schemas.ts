import { z } from '@hono/zod-openapi';
import { providerInfoSchema } from './provider.schemas';
import { workflowLoadErrorSchema, workflowSourceSchema } from './workflow.schemas';

export const canarySnapshotQuerySchema = z.object({
  codebaseId: z.string().min(1),
  baseBranch: z.literal('dev'),
});

export const canarySnapshotResponseSchema = z
  .object({
    observedAt: z.string(),
    codebase: z.object({
      id: z.string(),
      canonicalRemote: z.string(),
      defaultCwd: z.string(),
      baseBranch: z.literal('dev'),
      baseSha: z.string().regex(/^[a-f0-9]{40}$/),
      headSha: z.string().regex(/^[a-f0-9]{40}$/),
    }),
    revisions: z.object({
      engineRevision: z.string().trim().min(1),
      bundleRevision: z.string().trim().min(1),
      runtimeImageRevision: z.string().trim().min(1).nullable(),
    }),
    drain: z.object({
      mode: z.enum(['normal', 'draining']),
      drained: z.boolean(),
      activeLeaseCount: z.number().int().nonnegative(),
      activeRunCount: z.number().int().nonnegative(),
      activeRunIds: z.array(z.string()),
      updatedAt: z.string().nullable(),
    }),
    workflows: z.array(
      z.object({
        name: z.string(),
        source: workflowSourceSchema,
        revision: z.string(),
        capabilityIssues: z.array(z.string()),
      })
    ),
    providers: z.array(providerInfoSchema),
    loaderErrors: z.array(workflowLoadErrorSchema),
    ladder: z.object({
      tiers: z.array(
        z.object({
          name: z.string(),
          workflowName: z.string(),
          isFrontier: z.boolean(),
        })
      ),
    }),
    ruleset: z.object({
      defaultEntry: z.string(),
      rules: z.array(
        z.object({
          match: z.object({
            woClass: z.string().optional(),
            tags: z.array(z.string()).optional(),
          }),
          entry: z.string(),
        })
      ),
    }),
  })
  .openapi('CanarySnapshotResponse');

export type CanarySnapshotResponse = z.infer<typeof canarySnapshotResponseSchema>;
