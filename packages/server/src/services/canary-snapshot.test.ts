import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ProviderInfo } from '@archon/providers';
import type { WorkflowDefinition, WorkflowLoadResult } from '@archon/workflows/schemas/workflow';
import type { CauldronDrainState } from '@archon/core/db/workflows';
import { buildCanarySnapshot, type CanarySnapshotDeps } from './canary-snapshot';

const sha = 'a'.repeat(40);
const workflow = {
  name: 'bdc-feature-development-zero-open',
  description: 'fixture',
  provider: 'claude',
  nodes: [],
} as WorkflowDefinition;
const discovery: WorkflowLoadResult = {
  workflows: [{ workflow, source: 'project' }],
  errors: [],
};
const drain: CauldronDrainState = {
  mode: 'normal',
  activeLeaseCount: 0,
  activeRunCount: 0,
  activeRunIds: [],
  drained: false,
  updatedAt: null,
};
const providers: ProviderInfo[] = [
  {
    id: 'claude',
    displayName: 'Claude',
    builtIn: true,
    capabilities: {
      execution: { text: true, repositoryRead: true, repositoryWrite: true, shell: true },
      sessionResume: true,
      mcp: true,
      hooks: true,
      skills: true,
      agents: true,
      toolRestrictions: true,
      structuredOutput: true,
      envInjection: true,
      costControl: true,
      effortControl: true,
      thinkingControl: true,
      fallbackModel: true,
      sandbox: true,
    },
  },
];

function deps(overrides: Partial<CanarySnapshotDeps> = {}): CanarySnapshotDeps {
  return {
    getCodebase: async () => ({
      id: 'codebase-1',
      default_cwd: '/workspace/bdc-harness',
      repository_url: null,
    }),
    discover: async () => discovery,
    getDrain: async () => drain,
    getRemote: async () => 'git@github.com:BlueDevilCollectibles/bdc-harness.git',
    gitRevision: async () => sha,
    getProviders: () => providers,
    now: () => new Date('2026-07-10T12:00:00.000Z'),
    ...overrides,
  };
}

let originalImageRevision: string | undefined;

beforeEach(() => {
  originalImageRevision = process.env.ARCHON_RUNTIME_IMAGE_REVISION;
  process.env.ARCHON_RUNTIME_IMAGE_REVISION = 'sha256:image-fixture';
});

afterEach(() => {
  if (originalImageRevision === undefined) delete process.env.ARCHON_RUNTIME_IMAGE_REVISION;
  else process.env.ARCHON_RUNTIME_IMAGE_REVISION = originalImageRevision;
});

describe('buildCanarySnapshot', () => {
  test('returns normalized immutable facts without writes', async () => {
    const result = await buildCanarySnapshot('codebase-1', 'dev', deps());
    expect(result.codebase).toEqual({
      id: 'codebase-1',
      canonicalRemote: 'bluedevilcollectibles/bdc-harness',
      defaultCwd: '/workspace/bdc-harness',
      baseBranch: 'dev',
      baseSha: sha,
      headSha: sha,
    });
    expect(result.workflows).toHaveLength(1);
    expect(result.workflows[0]?.capabilityIssues).toEqual([]);
    expect(result.revisions.runtimeImageRevision).toBe('sha256:image-fixture');
    expect(result.ladder.tiers.length).toBeGreaterThan(0);
    expect(result.ruleset.defaultEntry).toBeTruthy();
  });

  test('preserves duplicate workflows and loader errors as explicit facts', async () => {
    const error = {
      filename: 'broken.yaml',
      error: 'broken',
      errorType: 'validation_error' as const,
    };
    const result = await buildCanarySnapshot(
      'codebase-1',
      'dev',
      deps({
        discover: async () => ({
          workflows: [discovery.workflows[0]!, discovery.workflows[0]!],
          errors: [error],
        }),
      })
    );
    expect(result.workflows).toHaveLength(2);
    expect(result.loaderErrors).toEqual([error]);
  });

  test('preserves a missing runtime image revision as null', async () => {
    delete process.env.ARCHON_RUNTIME_IMAGE_REVISION;
    const result = await buildCanarySnapshot('codebase-1', 'dev', deps());
    expect(result.revisions.runtimeImageRevision).toBeNull();
  });

  test('fails closed when no workflows or remote are available', async () => {
    await expect(
      buildCanarySnapshot(
        'codebase-1',
        'dev',
        deps({ discover: async () => ({ workflows: [], errors: [] }) })
      )
    ).rejects.toThrow('canary_workflows_empty');
    await expect(
      buildCanarySnapshot('codebase-1', 'dev', deps({ getRemote: async () => null }))
    ).rejects.toThrow('canary_remote_missing');
  });

  test('propagates Git authority failures', async () => {
    await expect(
      buildCanarySnapshot(
        'codebase-1',
        'dev',
        deps({ gitRevision: async () => Promise.reject(new Error('git_revision_missing')) })
      )
    ).rejects.toThrow('git_revision_missing');
  });
});
