import { z } from '@hono/zod-openapi';

const evaluationSource = /held[-_ ]?out|gauntlet|benchmark|fixture|evaluation[-_ ]?bank/i;
function capturedGithubUrl(url: string): boolean {
  try {
    return (
      /^https:\/\/github\.com\/thinmansoftware\/(bdc-harness|bdc-xo)\/(pull|issues|blob)\//.test(
        url
      ) && !evaluationSource.test(decodeURIComponent(url))
    );
  } catch {
    return false;
  }
}
export const advicePacketSchema = z
  .object({
    request_id: z.string().uuid(),
    lease_id: z.string().min(1).max(120),
    fencing_token: z.number().int().positive(),
    task: z.string().min(1).max(2000),
    category: z.enum(['status', 'duplicate_work', 'checkpoint', 'important']),
    captured_at: z.string().datetime({ offset: true }),
    evidence: z
      .array(
        z
          .object({
            id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
            url: z
              .string()
              .url()
              .refine(capturedGithubUrl, 'captured_github_only_no_evaluation_sources'),
            content: z.string().min(1).max(16000),
          })
          .strict()
      )
      .min(1)
      .max(8),
  })
  .strict();
