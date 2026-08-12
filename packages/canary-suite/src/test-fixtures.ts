import { CANARY_LANES, type CanaryManifest, type CanarySnapshot } from './types';

export const manifest: CanaryManifest = {
  schemaVersion: 1,
  environment: {
    id: 'hetzner-production',
    project: 'bdc-harness',
    canonicalRemote: 'thinmansoftware/bdc-harness',
    baseBranch: 'dev',
  },
  artifactRoot: 'harness-artifacts/canaries',
  lanes: CANARY_LANES.map((name, index) => ({ name, order: index + 1 })),
  conductorProbes: [
    {
      id: 'mechanical-code',
      woClass: 'CODE',
      tags: ['mechanical'],
      expectedTier: 'zero',
      expectedWorkflow: 'bdc-feature-development-zero-open',
    },
    {
      id: 'generic-code',
      woClass: 'CODE',
      tags: [],
      expectedTier: 'codex',
      expectedWorkflow: 'bdc-feature-development-codex',
    },
    {
      id: 'security-code',
      woClass: 'CODE',
      tags: ['security'],
      expectedTier: 'claude',
      expectedWorkflow: 'bdc-feature-development',
    },
    {
      id: 'infra',
      woClass: 'INFRA',
      tags: [],
      expectedTier: 'claude',
      expectedWorkflow: 'bdc-feature-development',
    },
  ],
};

export const baseSnapshot: CanarySnapshot = {
  observedAt: '2026-07-10T12:00:00.000Z',
  codebase: {
    id: 'codebase-1',
    canonicalRemote: 'thinmansoftware/bdc-harness',
    defaultCwd: '/workspace/bdc-harness',
    baseBranch: 'dev',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
  },
  revisions: {
    engineRevision: 'sha256:engine',
    bundleRevision: 'sha256:bundle',
    runtimeImageRevision: 'sha256:image',
  },
  drain: {
    mode: 'normal',
    drained: false,
    activeLeaseCount: 0,
    activeRunCount: 0,
    activeRunIds: [],
    updatedAt: null,
  },
  workflows: CANARY_LANES.map(name => ({
    name,
    source: 'project',
    revision: `sha256:${name}`,
    capabilityIssues: [],
  })),
  providers: [],
  loaderErrors: [],
  ladder: {
    tiers: [
      { name: 'zero', workflowName: 'bdc-feature-development-zero-open', isFrontier: false },
      { name: 'codex', workflowName: 'bdc-feature-development-codex', isFrontier: false },
      { name: 'claude', workflowName: 'bdc-feature-development', isFrontier: false },
    ],
  },
  ruleset: {
    defaultEntry: 'codex',
    rules: [
      { match: { tags: ['security'] }, entry: 'claude' },
      { match: { woClass: 'INFRA' }, entry: 'claude' },
      { match: { woClass: 'CODE', tags: ['mechanical'] }, entry: 'zero' },
      { match: { woClass: 'CODE' }, entry: 'codex' },
    ],
  },
};

export function snapshot(overrides: Partial<CanarySnapshot> = {}): CanarySnapshot {
  return {
    ...baseSnapshot,
    ...overrides,
    codebase: { ...baseSnapshot.codebase, ...(overrides.codebase ?? {}) },
    revisions: { ...baseSnapshot.revisions, ...(overrides.revisions ?? {}) },
    drain: { ...baseSnapshot.drain, ...(overrides.drain ?? {}) },
  };
}
