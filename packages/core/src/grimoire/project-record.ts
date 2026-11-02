import { z } from 'zod';

export const projectRecordSchema = z
  .object({
    record_version: z.literal(1),
    tier: z.enum(['bdc', 'business', 'client', 'learning']),
    base_branch: z.string(),
    production_branches: z.array(z.string()).min(1),
    test_command: z.string(),
    runner_profile: z.string(),
    spec_home: z.string(),
    reviewer_role: z.string(),
    allowed_providers: z.array(z.string()),
    secret_namespace: z.string(),
    github: z.enum(['connected', 'authoritative', 'off']),
    approver: z.string(),
    rollout: z.enum(['flag', 'staged', 'direct']),
    health_url: z.string().nullable(),
    state: z.enum(['idea', 'card', 'first_task', 'live']),
  })
  .strict()
  .refine(record => !record.production_branches.includes(record.base_branch), {
    path: ['production_branches'],
    message: 'production_branches must exclude base_branch',
  });

export type ProjectRecord = z.infer<typeof projectRecordSchema>;
export type ParsedProjectRecord =
  | { status: 'absent'; record: null }
  | { status: 'invalid'; record: null }
  | { status: 'valid'; record: ProjectRecord };

export function parseProjectRecord(raw: unknown): ParsedProjectRecord {
  if (raw === null || raw === undefined) return { status: 'absent', record: null };
  try {
    const result = projectRecordSchema.safeParse(typeof raw === 'string' ? JSON.parse(raw) : raw);
    return result.success
      ? { status: 'valid', record: result.data }
      : { status: 'invalid', record: null };
  } catch {
    return { status: 'invalid', record: null };
  }
}
