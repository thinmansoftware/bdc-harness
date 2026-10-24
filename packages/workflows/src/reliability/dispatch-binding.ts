import { z } from '@hono/zod-openapi';
import { posix, win32 } from 'node:path';

export type CodexOnlyV2ProviderId = 'codex' | 'codex-native-strict';

/** Literal admission only; this does not choose a provider transport. */
export function isCodexOnlyV2ProviderId(providerId: unknown): providerId is CodexOnlyV2ProviderId {
  return providerId === 'codex' || providerId === 'codex-native-strict';
}

function comparisonText(maximum: number): z.ZodString {
  return z
    .string()
    .min(1)
    .max(maximum)
    .regex(/^\P{Cc}*$/u, 'Control characters are not allowed')
    .regex(/\S/u, 'Expected a nonblank value');
}

/** A comparison snapshot, not dispatch authority or proof of filesystem ownership. */
export const dispatchBindingSchema = z
  .object({
    version: z.literal('codex-only-v2'),
    project: comparisonText(512),
    codebaseId: comparisonText(128),
    codebaseName: comparisonText(512),
    defaultCwd: comparisonText(4096).refine(cwd => posix.isAbsolute(cwd) || win32.isAbsolute(cwd), {
      message: 'Expected a lexical absolute path',
    }),
    workflowName: z.literal('bdc-feature-development-codex-only'),
    workflowSha256: z.string().regex(/^[a-f0-9]{64}$/, 'Expected a lowercase SHA256 digest'),
  })
  .strict()
  .openapi('CodexOnlyDispatchBinding');

export type CodexOnlyDispatchBinding = z.infer<typeof dispatchBindingSchema>;
