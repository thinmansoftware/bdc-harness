import { z } from 'zod';
import type { CanarySnapshot } from './types';

const providerCapabilitiesSchema = z.object({
  execution: z.object({
    text: z.boolean(),
    repositoryRead: z.boolean(),
    repositoryWrite: z.boolean(),
    shell: z.boolean(),
  }),
  sessionResume: z.boolean(),
  mcp: z.boolean(),
  hooks: z.boolean(),
  skills: z.boolean(),
  agents: z.boolean(),
  toolRestrictions: z.boolean(),
  structuredOutput: z.boolean(),
  envInjection: z.boolean(),
  costControl: z.boolean(),
  effortControl: z.boolean(),
  thinkingControl: z.boolean(),
  fallbackModel: z.boolean(),
  sandbox: z.boolean(),
});

export const canarySnapshotSchema = z.object({
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
    engineRevision: z.string().min(1),
    bundleRevision: z.string().min(1),
    runtimeImageRevision: z.string().min(1).nullable(),
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
      source: z.enum(['project', 'bundled', 'global']),
      revision: z.string(),
      capabilityIssues: z.array(z.string()),
    })
  ),
  providers: z.array(
    z.object({
      id: z.string(),
      displayName: z.string(),
      builtIn: z.boolean(),
      capabilities: providerCapabilitiesSchema,
    })
  ),
  loaderErrors: z.array(
    z.object({
      filename: z.string(),
      path: z.string().optional(),
      error: z.string(),
      errorType: z.enum(['read_error', 'parse_error', 'validation_error']),
    })
  ),
  ladder: z.object({
    tiers: z.array(
      z.object({ name: z.string(), workflowName: z.string(), isFrontier: z.boolean() })
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
});

export class ArchonCanaryClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch
  ) {}

  async getSnapshot(codebaseId: string, baseBranch: 'dev'): Promise<CanarySnapshot> {
    const url = new URL('/api/admin/canary/snapshot', this.baseUrl);
    url.searchParams.set('codebaseId', codebaseId);
    url.searchParams.set('baseBranch', baseBranch);
    const response = await this.fetcher(url, {
      method: 'GET',
      headers: { 'x-archon-operator-token': this.token },
    });
    if (!response.ok) {
      const body = (await response.text()).slice(0, 500).replaceAll(this.token, '[REDACTED]');
      throw new Error(`canary_snapshot_http_${response.status}: ${body}`);
    }
    return canarySnapshotSchema.parse(await response.json()) as CanarySnapshot;
  }
}
