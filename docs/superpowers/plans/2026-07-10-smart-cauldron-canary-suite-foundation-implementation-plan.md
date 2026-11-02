# Smart Cauldron Canary Suite Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the manifest-driven Smart Cauldron canary runner and mechanically prove read-only Levels 0 and 1 for all eight lanes without firing a provider, creating a workflow run, or mutating Git/GitHub.

**Architecture:** Add an independent `@archon/canary-suite` package that reads a reviewed YAML manifest, obtains one authenticated read-only runtime snapshot from Archon, reduces deterministic contract and route verdicts, and atomically writes JSON and Markdown evidence. Add one authenticated GET endpoint that exposes fail-closed workflow, provider, codebase, drain, and revision facts; route planning remains a pure function in the canary package.

**Tech Stack:** Bun 1.3, TypeScript 5.9 strict mode, Zod 3.25, Hono OpenAPI, existing `@archon/workflows`, `@archon/providers`, `@archon/git`, and `@archon/smart-cauldron` contracts.

## Global Constraints

- This is Plan 1 of the graduated suite and implements only Levels 0 and 1.
- No workflow/provider fire, conversation creation, branch, worktree, push, PR, deploy, restart, credential change, or external mutation.
- The endpoint and runner fail closed on missing codebase, workflow loader errors, duplicate/missing lane names, unknown providers, capability mismatches, unknown base authority, or missing revisions.
- The only production-facing operation authorized by this plan is a future authenticated GET; this plan itself performs local tests only.
- The eight lane names and their default order are copied exactly from the approved design.
- `ARCHON_OPERATOR_TOKEN` may be read from environment by the CLI but is never written to reports, errors, snapshots, fixtures, or logs.
- All code and script files are ASCII-only.
- Existing direct workflow fire and Smart Cauldron cascade behavior remain unchanged.
- The design source is `docs/superpowers/specs/2026-07-10-smart-cauldron-graduated-canary-suite-design.md` at or after commit `9dc1004d`.
- Plan 2 will add Level 2 draft-PR canaries; Plan 3 will add Levels 3-5 and fault controls; Plan 4 will add scheduling and Duty Officer ingestion. Do not pull those scopes into this branch.

## File Structure

### New package

- `packages/canary-suite/package.json`: workspace package metadata and commands.
- `packages/canary-suite/tsconfig.json`: strict no-emit TypeScript config.
- `packages/canary-suite/src/types.ts`: stable manifest, snapshot, plan, result, and report contracts.
- `packages/canary-suite/src/manifest.ts`: YAML loading plus Zod validation.
- `packages/canary-suite/src/planner.ts`: pure Level 0/1 lane and conductor planning.
- `packages/canary-suite/src/reducer.ts`: pure pass/fail/blocked/aborted reduction.
- `packages/canary-suite/src/client.ts`: authenticated read-only Archon client.
- `packages/canary-suite/src/report.ts`: deterministic JSON/Markdown rendering and atomic writes.
- `packages/canary-suite/src/runner.ts`: orchestration of snapshot, plan, reducer, and report.
- `packages/canary-suite/src/cli.ts`: `check` and `plan` commands.
- `packages/canary-suite/src/index.ts`: public exports.
- `packages/canary-suite/src/*.test.ts`: focused unit and integration tests beside each module.

### Existing packages

- `packages/workflows/src/reliability/runtime-revisions.ts`: reusable revision capture.
- `packages/workflows/src/reliability/runtime-revisions.test.ts`: exact hashing tests.
- `packages/workflows/src/reliability/workflow-capability-audit.ts`: fail-closed lane capability audit.
- `packages/workflows/src/reliability/workflow-capability-audit.test.ts`: mutating/chat-only and unknown-provider tests.
- `packages/workflows/src/executor.ts`: consume shared runtime revision helper.
- `packages/workflows/package.json`: no change required; its existing `./reliability/*` export exposes both new helpers.
- `packages/server/src/routes/schemas/provider.schemas.ts`: accurately expose `agents` and execution capability fields already present at runtime.
- `packages/server/src/routes/schemas/canary.schemas.ts`: snapshot query and response schemas.
- `packages/server/src/services/canonical-remote.ts`: strict GitHub remote-to-owner/repo normalization.
- `packages/server/src/services/canonical-remote.test.ts`: SSH, HTTPS, slug, and rejection tests.
- `packages/server/src/services/canary-snapshot.ts`: fail-closed snapshot builder with injected dependencies.
- `packages/server/src/services/canary-snapshot.test.ts`: hermetic snapshot tests.
- `packages/server/src/routes/api.ts`: register one authenticated GET route.
- `packages/server/src/routes/api.canary-snapshot.test.ts`: route auth and no-mutation tests.
- `packages/server/package.json`: add `@archon/canary-suite` workspace dependency only if shared response types are imported.
- `.archon/canaries/smart-cauldron.yaml`: reviewed Levels 0/1 manifest.
- `Dockerfile`: copy `packages/canary-suite/` into the production image.
- `packages/server/src/docker-packaging.test.ts`: pin the new package COPY entry.
- `packages/smart-cauldron/package.json`: expose the existing conductor, ladder, and types modules as package subpaths.

---

### Task 1: Scaffold the canary package and validate the manifest

**Files:**
- Create: `packages/canary-suite/package.json`
- Create: `packages/canary-suite/tsconfig.json`
- Create: `packages/canary-suite/src/types.ts`
- Create: `packages/canary-suite/src/manifest.ts`
- Create: `packages/canary-suite/src/manifest.test.ts`
- Create: `packages/canary-suite/src/index.ts`
- Modify: `packages/smart-cauldron/package.json`

**Interfaces:**
- Consumes: Bun native `Bun.YAML.parse`, Zod 3.
- Produces: `CanaryManifest`, `LaneManifest`, `ConductorProbe`, and `loadCanaryManifest(path)`.

- [ ] **Step 1: Write the manifest tests**

```ts
import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadCanaryManifest } from './manifest';

const lanes = [
  'bdc-feature-development-zero-open',
  'bdc-feature-development-zero',
  'bdc-feature-development-fusion-cx-qwen',
  'bdc-feature-development-codex-only',
  'bdc-feature-development-codex',
  'bdc-feature-development',
  'bdc-feature-development-fable',
  'bdc-multi-stage-development',
];

function validManifest(): Record<string, unknown> {
  return {
    schema_version: 1,
    environment: {
      id: 'hetzner-production',
      project: 'bdc-harness',
      canonical_remote: 'bluedevilcollectibles/bdc-harness',
      base_branch: 'dev',
    },
    artifact_root: 'harness-artifacts/canaries',
    lanes: lanes.map((name, order) => ({ name, order: order + 1 })),
    conductor_probes: [
      {
        id: 'mechanical',
        wo_class: 'CODE',
        tags: ['mechanical'],
        expected_tier: 'zero',
        expected_workflow: lanes[0],
      },
    ],
  };
}

async function writeFixture(value: unknown): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'canary-manifest-'));
  const path = join(dir, 'manifest.yaml');
  // JSON is valid YAML and avoids introducing a second serializer into the test.
  await writeFile(path, JSON.stringify(value));
  return { dir, path };
}

describe('loadCanaryManifest', () => {
  test('loads the exact eight-lane Levels 0/1 contract', async () => {
    const { dir, path } = await writeFixture(validManifest());
    try {
      const manifest = await loadCanaryManifest(path);
      expect(manifest.lanes.map(lane => lane.name)).toEqual(lanes);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('rejects duplicate lane names', async () => {
    const fixture = validManifest();
    const fixtureLanes = fixture.lanes as Array<{ name: string; order: number }>;
    fixtureLanes[7] = { name: fixtureLanes[0]!.name, order: 8 };
    const { dir, path } = await writeFixture(fixture);
    try {
      await expect(loadCanaryManifest(path)).rejects.toThrow('manifest_lane_duplicate');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('rejects a non-production environment or wrong repository', async () => {
    for (const change of [
      { id: 'local', canonical_remote: 'bluedevilcollectibles/bdc-harness' },
      { id: 'hetzner-production', canonical_remote: 'other/repository' },
    ]) {
      const fixture = validManifest();
      Object.assign(fixture.environment as Record<string, unknown>, change);
      const { dir, path } = await writeFixture(fixture);
      try {
        await expect(loadCanaryManifest(path)).rejects.toThrow();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });
});
```

- [ ] **Step 2: Run the tests and confirm the package is absent**

Run: `bun test packages/canary-suite/src/manifest.test.ts`

Expected: FAIL because `packages/canary-suite` and `loadCanaryManifest` do not exist.

- [ ] **Step 3: Create package metadata**

```json
{
  "name": "@archon/canary-suite",
  "version": "0.3.10",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "bin": { "archon-canary": "./src/cli.ts" },
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "test": "bun test src/",
    "type-check": "bun x tsc --noEmit"
  },
  "dependencies": {
    "@archon/smart-cauldron": "workspace:*",
    "zod": "^3.25.28"
  }
}
```

In the existing `packages/smart-cauldron/package.json`, add this public subpath map
without changing `main` or `bin`:

```json
{
  ".": "./src/cascade.ts",
  "./conductor": "./src/conductor.ts",
  "./ladder": "./src/ladder.ts",
  "./types": "./src/types.ts"
}
```

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": { "noEmit": true },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "**/*.test.ts"]
}
```

- [ ] **Step 4: Implement the contracts and fail-closed loader**

```ts
// types.ts
export const CANARY_LANES = [
  'bdc-feature-development-zero-open',
  'bdc-feature-development-zero',
  'bdc-feature-development-fusion-cx-qwen',
  'bdc-feature-development-codex-only',
  'bdc-feature-development-codex',
  'bdc-feature-development',
  'bdc-feature-development-fable',
  'bdc-multi-stage-development',
] as const;

export type CanaryLaneName = (typeof CANARY_LANES)[number];
export type CanaryVerdict = 'passed' | 'failed' | 'blocked' | 'aborted';

export interface LaneManifest { readonly name: CanaryLaneName; readonly order: number }
export interface ConductorProbe {
  readonly id: string;
  readonly woClass?: 'CODE' | 'INFRA' | 'MIXED';
  readonly tags: readonly string[];
  readonly expectedTier: string;
  readonly expectedWorkflow: CanaryLaneName;
}
export interface CanaryManifest {
  readonly schemaVersion: 1;
  readonly environment: {
    readonly id: 'hetzner-production';
    readonly project: 'bdc-harness';
    readonly canonicalRemote: 'bluedevilcollectibles/bdc-harness';
    readonly baseBranch: 'dev';
  };
  readonly artifactRoot: string;
  readonly lanes: readonly LaneManifest[];
  readonly conductorProbes: readonly ConductorProbe[];
}
```

```ts
// manifest.ts
import { readFile } from 'fs/promises';
import { z } from 'zod';
import { CANARY_LANES, type CanaryManifest } from './types';

const laneName = z.enum(CANARY_LANES);
const rawManifestSchema = z.object({
  schema_version: z.literal(1),
  environment: z.object({
    id: z.literal('hetzner-production'),
    project: z.literal('bdc-harness'),
    canonical_remote: z.literal('bluedevilcollectibles/bdc-harness'),
    base_branch: z.literal('dev'),
  }),
  artifact_root: z.string().trim().min(1),
  lanes: z.array(z.object({ name: laneName, order: z.number().int().positive() })).length(8),
  conductor_probes: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    wo_class: z.enum(['CODE', 'INFRA', 'MIXED']).optional(),
    tags: z.array(z.string().min(1)),
    expected_tier: z.string().min(1),
    expected_workflow: laneName,
  })).min(1),
});

export async function loadCanaryManifest(path: string): Promise<CanaryManifest> {
  const parsed = rawManifestSchema.parse(Bun.YAML.parse(await readFile(path, 'utf8')));
  const laneNames = parsed.lanes.map(lane => lane.name);
  if (new Set(laneNames).size !== laneNames.length) throw new Error('manifest_lane_duplicate');
  for (const expected of CANARY_LANES) {
    if (!laneNames.includes(expected)) throw new Error(`manifest_lane_missing: ${expected}`);
  }
  return {
    schemaVersion: 1,
    environment: {
      id: parsed.environment.id,
      project: parsed.environment.project,
      canonicalRemote: parsed.environment.canonical_remote,
      baseBranch: parsed.environment.base_branch,
    },
    artifactRoot: parsed.artifact_root,
    lanes: parsed.lanes,
    conductorProbes: parsed.conductor_probes.map(probe => ({
      id: probe.id,
      woClass: probe.wo_class,
      tags: probe.tags,
      expectedTier: probe.expected_tier,
      expectedWorkflow: probe.expected_workflow,
    })),
  };
}
```

- [ ] **Step 5: Export and verify**

Export `types.ts` and `manifest.ts` from `src/index.ts`.

Run: `bun test packages/canary-suite/src/manifest.test.ts && bun --filter @archon/canary-suite type-check`

Expected: all manifest tests pass; type-check exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/canary-suite packages/smart-cauldron/package.json
git commit -m "feat(canary): add suite manifest contract"
```

### Task 2: Extract reusable runtime revisions and workflow capability audit

**Files:**
- Create: `packages/workflows/src/reliability/runtime-revisions.ts`
- Create: `packages/workflows/src/reliability/runtime-revisions.test.ts`
- Create: `packages/workflows/src/reliability/workflow-capability-audit.ts`
- Create: `packages/workflows/src/reliability/workflow-capability-audit.test.ts`
- Modify: `packages/workflows/src/executor.ts`

**Interfaces:**
- Produces: `captureRuntimeRevisions(workflow)`, `hashWorkflowDefinition(workflow)`, and `auditWorkflowExecutionCapabilities(workflow)`.
- Preserves: existing run-authority revision values byte-for-byte.

- [ ] **Step 1: Write failing revision tests**

```ts
import { expect, test } from 'bun:test';
import { captureRuntimeRevisions, hashWorkflowDefinition } from './runtime-revisions';

const workflow = { name: 'fixture', description: 'fixture', provider: 'claude', nodes: [] };

test('workflow hashing is deterministic and prefixed', () => {
  expect(hashWorkflowDefinition(workflow)).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(hashWorkflowDefinition(workflow)).toBe(hashWorkflowDefinition(workflow));
});

test('runtime revisions include engine, bundle, and nullable image', async () => {
  const revisions = await captureRuntimeRevisions(workflow);
  expect(revisions.engineRevision).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(revisions.bundleRevision).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(revisions.workflowRevision).toBe(hashWorkflowDefinition(workflow));
});
```

- [ ] **Step 2: Write failing capability tests**

Register the same provider catalog used by the server and test exact cases:

```ts
import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
  clearRegistry,
  registerBuiltinProviders,
  registerCommunityProviders,
} from '@archon/providers';
import type { WorkflowDefinition } from '../schemas';
import { auditWorkflowExecutionCapabilities } from './workflow-capability-audit';

beforeEach(() => {
  clearRegistry();
  registerBuiltinProviders();
  registerCommunityProviders();
});
afterEach(clearRegistry);

const writeWorkflowWithProvider = (provider: string) =>
  ({
    name: `fixture-${provider}`,
    description: 'capability audit fixture',
    provider,
    nodes: [{ id: 'implement', prompt: 'Implement.', allowed_tools: ['Read', 'Edit', 'Bash'] }],
  }) as WorkflowDefinition;

expect(auditWorkflowExecutionCapabilities(writeWorkflowWithProvider('opr-zero')))
  .toContainEqual(expect.objectContaining({ reason: 'provider_execution_capability_mismatch' }));
expect(auditWorkflowExecutionCapabilities(writeWorkflowWithProvider('missing-provider')))
  .toContainEqual(expect.objectContaining({ reason: 'provider_not_registered' }));
expect(auditWorkflowExecutionCapabilities(writeWorkflowWithProvider('claude'))).toEqual([]);
```

- [ ] **Step 3: Run both tests and verify missing modules**

Run: `bun test packages/workflows/src/reliability/runtime-revisions.test.ts packages/workflows/src/reliability/workflow-capability-audit.test.ts`

Expected: FAIL on unresolved modules.

- [ ] **Step 4: Implement runtime revisions**

```ts
import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import type { WorkflowDefinition } from '../schemas';
import { BUNDLED_POLICIES } from '../defaults/bundled-defaults';

const ENGINE_SOURCE_URL = new URL('../executor.ts', import.meta.url);
const sha256 = (value: string | Uint8Array): string =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`;

export function hashWorkflowDefinition(workflow: WorkflowDefinition): string {
  return sha256(JSON.stringify(workflow));
}

export async function captureRuntimeRevisions(workflow: WorkflowDefinition) {
  return {
    workflowRevision: hashWorkflowDefinition(workflow),
    bundleRevision: sha256(JSON.stringify(BUNDLED_POLICIES)),
    engineRevision: sha256(await readFile(ENGINE_SOURCE_URL)),
    runtimeImageRevision: process.env.ARCHON_RUNTIME_IMAGE_REVISION ?? null,
  } as const;
}
```

- [ ] **Step 5: Implement capability audit using the loader's existing authority rules**

```ts
import { getMissingProviderExecutionCapabilities, isRegisteredProvider } from '@archon/providers';
import type { WorkflowDefinition } from '../schemas';
import { deriveNodeExecutionRequirements } from '../schemas/dag-node';

export interface WorkflowCapabilityIssue {
  readonly workflowName: string;
  readonly nodeId: string;
  readonly provider: string;
  readonly reason: 'provider_not_registered' | 'provider_execution_capability_mismatch';
  readonly detail: string;
}

export function auditWorkflowExecutionCapabilities(
  workflow: WorkflowDefinition
): WorkflowCapabilityIssue[] {
  const issues: WorkflowCapabilityIssue[] = [];
  for (const node of workflow.nodes) {
    const required = deriveNodeExecutionRequirements(node);
    if (required.length === 0) continue;
    const provider = ('provider' in node ? node.provider : undefined) ?? workflow.provider;
    if (!provider || !isRegisteredProvider(provider)) {
      issues.push({ workflowName: workflow.name, nodeId: node.id, provider: provider ?? '', reason: 'provider_not_registered', detail: 'effective provider is not registered' });
      continue;
    }
    const missing = getMissingProviderExecutionCapabilities(provider, required);
    if (missing.length > 0) {
      issues.push({ workflowName: workflow.name, nodeId: node.id, provider, reason: 'provider_execution_capability_mismatch', detail: `missing ${missing.join(', ')}` });
    }
  }
  return issues;
}
```

- [ ] **Step 6: Refactor executor authority capture**

Remove only the local SHA helper and replace the three revision expressions in
`captureRunAuthorityInput()` with:

```ts
const revisions = await captureRuntimeRevisions(workflow);
// ...
workflowRevision: revisions.workflowRevision,
bundleRevision: revisions.bundleRevision,
engineRevision: revisions.engineRevision,
runtimeImageRevision: revisions.runtimeImageRevision,
```

Keep `readFile` and `BUNDLED_POLICIES` imports because policy loading later in the
file still uses them. Remove only the now-unused `createHash` import.

- [ ] **Step 7: Run focused regression tests**

Run:

```bash
bun test packages/workflows/src/reliability/runtime-revisions.test.ts packages/workflows/src/reliability/workflow-capability-audit.test.ts packages/workflows/src/executor.test.ts
bun --filter @archon/workflows type-check
```

Expected: all tests pass and run-authority expectations remain unchanged.

- [ ] **Step 8: Commit**

```bash
git add packages/workflows/src/reliability packages/workflows/src/executor.ts
git commit -m "refactor(workflows): expose canary revision and capability facts"
```

### Task 3: Correct the provider API capability contract

**Files:**
- Modify: `packages/server/src/routes/schemas/provider.schemas.ts`
- Modify: `packages/server/src/routes/api.providers.test.ts`

**Interfaces:**
- Produces: accurate OpenAPI schema for the existing `ProviderCapabilities` runtime response.

- [ ] **Step 1: Add a failing documented-contract test**

```ts
import { providerListResponseSchema } from './schemas/provider.schemas';

test('documents execution capabilities and agent support', async () => {
  const response = await app.request('/api/providers');
  const runtimeBody = await response.json();
  const documentedBody = providerListResponseSchema.parse(runtimeBody) as {
    providers: Array<{ capabilities: Record<string, unknown> }>;
  };
  for (const provider of documentedBody.providers) {
    expect(typeof provider.capabilities.agents).toBe('boolean');
    expect(Object.keys(provider.capabilities.execution as Record<string, boolean>).sort()).toEqual([
      'repositoryRead', 'repositoryWrite', 'shell', 'text',
    ]);
  }
});
```

- [ ] **Step 2: Run the focused test**

Run: `bun test packages/server/src/routes/api.providers.test.ts`

Expected: FAIL because Zod strips `agents` and `execution` from the documented
response while the runtime object already contains them.

- [ ] **Step 3: Extend the schema without changing provider runtime objects**

```ts
const providerExecutionCapabilitiesSchema = z.object({
  text: z.boolean(),
  repositoryRead: z.boolean(),
  repositoryWrite: z.boolean(),
  shell: z.boolean(),
});

const providerCapabilitiesSchema = z.object({
  execution: providerExecutionCapabilitiesSchema,
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
```

- [ ] **Step 4: Verify and commit**

Run: `bun test packages/server/src/routes/api.providers.test.ts && bun --filter @archon/server type-check`

Expected: PASS.

```bash
git add packages/server/src/routes/schemas/provider.schemas.ts packages/server/src/routes/api.providers.test.ts
git commit -m "fix(server): expose provider execution capabilities"
```

### Task 4: Add the authenticated read-only canary snapshot endpoint

**Files:**
- Create: `packages/server/src/routes/schemas/canary.schemas.ts`
- Create: `packages/server/src/services/canonical-remote.ts`
- Create: `packages/server/src/services/canonical-remote.test.ts`
- Create: `packages/server/src/services/canary-snapshot.ts`
- Create: `packages/server/src/services/canary-snapshot.test.ts`
- Create: `packages/server/src/routes/api.canary-snapshot.test.ts`
- Modify: `packages/server/src/routes/api.ts`

**Interfaces:**
- Consumes: codebase DB, workflow discovery, drain state, provider registry, Git authority helpers, ladder/ruleset loaders, runtime revision and capability audit helpers.
- Produces: authenticated `GET /api/admin/canary/snapshot?codebaseId=fixture-codebase&baseBranch=dev` (with the real registered ID substituted by the caller).
- Never writes: conversations, messages, runs, attempts, waits, worktrees, Git refs, or database state.

- [ ] **Step 1: Define response contracts and write service tests**

The schema must require:

```ts
export const canarySnapshotQuerySchema = z.object({
  codebaseId: z.string().min(1),
  baseBranch: z.literal('dev'),
});

export const canarySnapshotResponseSchema = z.object({
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
    engineRevision: z.string(),
    bundleRevision: z.string(),
    runtimeImageRevision: z.string().nullable(),
  }),
  drain: z.object({
    mode: z.enum(['normal', 'draining']),
    drained: z.boolean(),
    activeLeaseCount: z.number().int().nonnegative(),
    activeRunCount: z.number().int().nonnegative(),
    activeRunIds: z.array(z.string()),
    updatedAt: z.string().nullable(),
  }),
  workflows: z.array(z.object({
    name: z.string(), source: workflowSourceSchema,
    revision: z.string(), capabilityIssues: z.array(z.string()),
  })),
  providers: z.array(providerInfoSchema),
  loaderErrors: z.array(workflowLoadErrorSchema),
  ladder: z.object({ tiers: z.array(z.object({ name: z.string(), workflowName: z.string(), isFrontier: z.boolean() })) }),
  ruleset: z.object({ defaultEntry: z.string(), rules: z.array(z.record(z.unknown())) }),
});
```

Import `providerInfoSchema`, `workflowLoadErrorSchema`, and `workflowSourceSchema`
from the existing route-schema modules. Do not reuse `drainResponseSchema`: that
HTTP envelope requires `success`, while the snapshot embeds only the underlying
`CauldronDrainState`.

Service tests must prove duplicate/missing workflows, discovery errors, Git failures,
and missing image revision are returned as facts or explicit errors, never silently
replaced. `runtimeImageRevision: null` is allowed as a fact but Level 0 reducer later
fails it for `hetzner-production`.

- [ ] **Step 2: Add strict remote normalization tests**

```ts
import { expect, test } from 'bun:test';
import { normalizeGitHubRemote } from './canonical-remote';

test.each([
  ['git@github.com:BlueDevilCollectibles/bdc-harness.git', 'bluedevilcollectibles/bdc-harness'],
  ['https://github.com/BlueDevilCollectibles/bdc-harness.git', 'bluedevilcollectibles/bdc-harness'],
  ['ssh://git@github.com/BlueDevilCollectibles/bdc-harness.git', 'bluedevilcollectibles/bdc-harness'],
  ['BlueDevilCollectibles/bdc-harness', 'bluedevilcollectibles/bdc-harness'],
])('normalizes %s', (remote, expected) => {
  expect(normalizeGitHubRemote(remote)).toBe(expected);
});

test('rejects an unsupported host', () => {
  expect(() => normalizeGitHubRemote('https://example.com/owner/repo.git')).toThrow(
    'canary_remote_unsupported'
  );
});
```

Implement `normalizeGitHubRemote(remote)` as a pure parser accepting only the four
forms above, trimming a trailing slash and `.git`, lowercasing owner/repository,
and throwing `canary_remote_unsupported` for an empty value, another host, or a
path that is not exactly `owner/repository`. Never use substring matching.

```ts
export function normalizeGitHubRemote(remote: string): string {
  const trimmed = remote.trim().replace(/\/+$/, '').replace(/\.git$/i, '');
  const candidates = [
    /^git@github\.com:([^/]+)\/([^/]+)$/i,
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)$/i,
    /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+)$/i,
    /^([^/:]+)\/([^/]+)$/,
  ];
  for (const candidate of candidates) {
    const match = candidate.exec(trimmed);
    if (match?.[1] && match[2]) return `${match[1].toLowerCase()}/${match[2].toLowerCase()}`;
  }
  throw new Error(`canary_remote_unsupported: ${remote}`);
}
```

- [ ] **Step 3: Run the tests and verify missing services**

Run: `bun test packages/server/src/services/canonical-remote.test.ts packages/server/src/services/canary-snapshot.test.ts`

Expected: FAIL on missing module.

- [ ] **Step 4: Implement the service with injected dependencies**

```ts
import type { CauldronDrainState } from '@archon/core/db/workflows';
import type { ProviderInfo } from '@archon/providers';
import type { WorkflowLoadResult } from '@archon/workflows/schemas/workflow';

export interface CanarySnapshotDeps {
  getCodebase(id: string): Promise<{ id: string; default_cwd: string; repository_url: string | null } | null>;
  discover(cwd: string): Promise<WorkflowLoadResult>;
  getDrain(): Promise<CauldronDrainState>;
  getRemote(cwd: string): Promise<string | null>;
  gitRevision(cwd: string, revision: string): Promise<string>;
  getProviders(): ProviderInfo[];
  now(): Date;
}

export async function buildCanarySnapshot(
  codebaseId: string,
  baseBranch: 'dev',
  deps: CanarySnapshotDeps
): Promise<CanarySnapshotResponse> {
  const codebase = await deps.getCodebase(codebaseId);
  if (!codebase) throw new Error(`canary_codebase_missing: ${codebaseId}`);
  const discovery = await deps.discover(codebase.default_cwd);
  if (discovery.workflows.length === 0) throw new Error('canary_workflows_empty');
  const rawRemote = await deps.getRemote(codebase.default_cwd);
  if (!rawRemote) throw new Error('canary_remote_missing');
  const workflows = await Promise.all(discovery.workflows.map(async item => ({
    name: item.workflow.name,
    source: item.source,
    revision: hashWorkflowDefinition(item.workflow),
    capabilityIssues: auditWorkflowExecutionCapabilities(item.workflow).map(issue => issue.detail),
  })));
  const revisions = await captureRuntimeRevisions(discovery.workflows[0]!.workflow);
  return {
    observedAt: deps.now().toISOString(),
    codebase: {
      id: codebase.id,
      canonicalRemote: normalizeGitHubRemote(rawRemote),
      defaultCwd: codebase.default_cwd,
      baseBranch,
      baseSha: await deps.gitRevision(codebase.default_cwd, `refs/remotes/origin/${baseBranch}`),
      headSha: await deps.gitRevision(codebase.default_cwd, 'HEAD'),
    },
    revisions: {
      engineRevision: revisions.engineRevision,
      bundleRevision: revisions.bundleRevision,
      runtimeImageRevision: revisions.runtimeImageRevision,
    },
    drain: await deps.getDrain(),
    workflows,
    providers: deps.getProviders(),
    loaderErrors: discovery.errors,
    ladder: { tiers: loadLadder() },
    ruleset: loadRuleset(),
  };
}
```

The production dependency object uses `getCodebase`, `discoverWorkflows`,
`getCauldronDrainState`, `getRemoteUrl(toRepoPath(cwd))`, `execFileAsync` for the two
read-only `git rev-parse --verify ...^{commit}` calls, `getProviderInfoList`, and
`now: () => new Date()`. It passes no database write functions to the service.

- [ ] **Step 5: Register the GET route**

Add the OpenAPI route next to the existing drain admin routes and register the
handler next to other system/admin handlers. Use the existing global operator-token
middleware. Do not add a new auth mechanism.

- [ ] **Step 6: Prove read-only behavior and auth**

Route tests must assert:

```ts
const unauthorized = await app.request('/api/admin/canary/snapshot?codebaseId=x&baseBranch=dev');
expect(unauthorized.status).toBe(401);
// With test token: 200 and exact snapshot.
expect(messageDb.addMessage).not.toHaveBeenCalled();
expect(workflowDb.createWorkflowRun).not.toHaveBeenCalled();
```

Set `ARCHON_OPERATOR_TOKEN` before constructing the authenticated test app and restore
the prior environment value in `afterEach`. The authorized request must use
`x-archon-operator-token` and assert status 200 plus the exact fixture snapshot.

- [ ] **Step 7: Run focused verification and commit**

Run:

```bash
bun test packages/server/src/services/canonical-remote.test.ts packages/server/src/services/canary-snapshot.test.ts packages/server/src/routes/api.canary-snapshot.test.ts
bun --filter @archon/server type-check
```

Expected: PASS with zero mutation mock calls.

```bash
git add packages/server/src/routes/schemas/canary.schemas.ts packages/server/src/services/canonical-remote.ts packages/server/src/services/canonical-remote.test.ts packages/server/src/services/canary-snapshot.ts packages/server/src/services/canary-snapshot.test.ts packages/server/src/routes/api.canary-snapshot.test.ts packages/server/src/routes/api.ts
git commit -m "feat(server): expose read-only canary snapshot"
```

### Task 5: Implement pure planning, reduction, and coverage status

**Files:**
- Create: `packages/canary-suite/src/planner.ts`
- Create: `packages/canary-suite/src/planner.test.ts`
- Create: `packages/canary-suite/src/reducer.ts`
- Create: `packages/canary-suite/src/reducer.test.ts`
- Modify: `packages/canary-suite/src/types.ts`
- Modify: `packages/canary-suite/src/index.ts`

**Interfaces:**
- Produces: `buildCanaryPlan(manifest, snapshot)` and `reduceCanaryPlan(plan)`.
- Verdicts: `passed`, `failed`, `blocked`, or `aborted`; Levels 0/1 use only `passed`, `failed`, and `blocked`.

- [ ] **Step 1: Write the failure-table tests first**

Cover exact rows:

```ts
test.each([
  ['missing lane', snapshot({ workflows: sevenLanes }), 'failed', 'lane_missing'],
  ['duplicate lane', snapshot({ workflows: duplicateLane }), 'failed', 'lane_duplicate'],
  ['loader error', snapshot({ loaderErrors: [loaderError] }), 'failed', 'workflow_loader_error'],
  ['capability mismatch', snapshot({ workflows: [badCapabilityLane] }), 'failed', 'capability_mismatch'],
  ['wrong remote', snapshot({ codebase: { canonicalRemote: 'other/repo' } }), 'failed', 'canonical_remote_mismatch'],
  ['unknown image', snapshot({ revisions: { runtimeImageRevision: null } }), 'blocked', 'runtime_image_revision_missing'],
  ['draining', snapshot({ drain: { mode: 'draining' } }), 'blocked', 'cauldron_draining'],
])('%s', (_name, input, verdict, reason) => {
  const report = reduceCanaryPlan(buildCanaryPlan(manifest, input));
  expect(report.verdict).toBe(verdict);
  expect(report.reasonCodes).toContain(reason);
});
```

Add route tests proving all eight direct lanes resolve exactly once and conductor
probes select their configured tier/workflow through `pickEntryTier()` and the live
snapshot ladder/ruleset.

- [ ] **Step 2: Run and confirm missing planner/reducer**

Run: `bun test packages/canary-suite/src/planner.test.ts packages/canary-suite/src/reducer.test.ts`

Expected: FAIL on unresolved modules.

- [ ] **Step 3: Implement immutable plans**

Import `pickEntryTier` from `@archon/smart-cauldron/conductor` and import only
types from `@archon/smart-cauldron/types`. The server likewise imports
`loadLadder` and `loadRuleset` through public subpaths; no package may reach into
another package's `src/` directory.

The planner must sort lanes by manifest `order`, join by exact workflow name, compute
a SHA-256 request identity from canonical JSON, and produce no timestamps inside the
identity. Conductor probe selection must call the existing `pickEntryTier()` with the
snapshot ruleset and then resolve the chosen tier through the snapshot ladder.

```ts
export function buildCanaryPlan(manifest: CanaryManifest, snapshot: CanarySnapshot): CanaryPlan {
  const directRoutes = manifest.lanes
    .toSorted((a, b) => a.order - b.order)
    .map(lane => ({ lane: lane.name, matches: snapshot.workflows.filter(w => w.name === lane.name) }));
  const conductorRoutes = manifest.conductorProbes.map(probe => {
    const tier = pickEntryTier({ woClass: probe.woClass, tags: [...probe.tags] }, snapshot.ruleset);
    const binding = snapshot.ladder.tiers.find(item => item.name === tier);
    return { probeId: probe.id, tier, workflowName: binding?.workflowName ?? null };
  });
  return freezePlan({ manifest, snapshot, directRoutes, conductorRoutes });
}
```

- [ ] **Step 4: Implement the mechanical reducer**

Use explicit predicates; do not infer from narrative strings. `failed` wins over
`blocked`, and `blocked` wins over `passed`. Every non-pass result must have at least
one stable reason code and evidence reference.

- [ ] **Step 5: Verify and commit**

Run:

```bash
bun test packages/canary-suite/src/planner.test.ts packages/canary-suite/src/reducer.test.ts
bun --filter @archon/canary-suite type-check
bun --filter @archon/smart-cauldron type-check
```

Expected: complete failure table passes.

```bash
git add packages/canary-suite/src
git commit -m "feat(canary): plan and reduce read-only lane checks"
```

### Task 6: Add the authenticated client, atomic reports, runner, and CLI

**Files:**
- Create: `packages/canary-suite/src/client.ts`
- Create: `packages/canary-suite/src/client.test.ts`
- Create: `packages/canary-suite/src/report.ts`
- Create: `packages/canary-suite/src/report.test.ts`
- Create: `packages/canary-suite/src/runner.ts`
- Create: `packages/canary-suite/src/runner.test.ts`
- Create: `packages/canary-suite/src/cli.ts`
- Create: `packages/canary-suite/src/cli.test.ts`
- Modify: `packages/canary-suite/src/index.ts`

**Interfaces:**
- `ArchonCanaryClient.getSnapshot(codebaseId, baseBranch)` performs one authenticated GET.
- `runCanary({ level, manifestPath, apiBase, token, outputRoot })` returns a report and writes artifacts.
- CLI commands: `archon-canary check` for Level 0 and `archon-canary plan` for Levels 0+1.

- [ ] **Step 1: Write transport and secret-redaction tests**

Prove the token is placed only in `x-archon-operator-token`, non-2xx responses include
status and redacted body, and neither thrown errors nor serialized reports contain
the fixture token.

- [ ] **Step 2: Write atomic report tests**

Use a temporary directory and assert exactly:

```text
artifact-root/suite-fixture-001/plan.json
artifact-root/suite-fixture-001/summary.json
artifact-root/suite-fixture-001/summary.md
```

Write each to a sibling `.tmp` file with `flag: 'wx'`, then rename. Re-running the
same suite ID must compare exact bytes and return the existing report; different bytes
must throw `canary_artifact_conflict`.

- [ ] **Step 3: Write runner and CLI tests**

Tests must prove:

- `check` calls only `GET /api/admin/canary/snapshot`;
- `plan` calls the same GET and performs route planning locally;
- no request uses POST/PUT/PATCH/DELETE;
- missing `ARCHON_OPERATOR_TOKEN` exits 3 before network access;
- passed exits 0, failed exits 2, blocked exits 3, aborted exits 4;
- `--json` prints the report but never the token.

- [ ] **Step 4: Implement the client**

```ts
export class ArchonCanaryClient {
  constructor(private readonly baseUrl: string, private readonly token: string, private readonly fetcher = fetch) {}
  async getSnapshot(codebaseId: string, baseBranch: 'dev'): Promise<CanarySnapshot> {
    const url = new URL('/api/admin/canary/snapshot', this.baseUrl);
    url.searchParams.set('codebaseId', codebaseId);
    url.searchParams.set('baseBranch', baseBranch);
    const response = await this.fetcher(url, { headers: { 'x-archon-operator-token': this.token } });
    if (!response.ok) throw new Error(`canary_snapshot_http_${response.status}`);
    return canarySnapshotSchema.parse(await response.json());
  }
}
```

- [ ] **Step 5: Implement deterministic reporting**

Markdown contains one row per lane with level, verdict, reason codes, workflow
revision, provider/capability status, and evidence references. JSON is the canonical
report; Markdown is a projection. Use `JSON.stringify(report, null, 2) + '\n'`.

- [ ] **Step 6: Implement runner and CLI**

The runner creates `suiteRunId` from the manifest identity plus snapshot observation
timestamp, never from random model output. The CLI requires explicit `--codebase-id`,
`--manifest`, `--api-base`, and `--output-root`; token comes from environment or
`--token-file`, not a command-line value that leaks through process listings.

- [ ] **Step 7: Verify and commit**

Run:

```bash
bun test packages/canary-suite/src/client.test.ts packages/canary-suite/src/report.test.ts packages/canary-suite/src/runner.test.ts packages/canary-suite/src/cli.test.ts
bun --filter @archon/canary-suite type-check
```

Expected: PASS; secret fixture absent from captured stdout/stderr and artifacts.

```bash
git add packages/canary-suite/src
git commit -m "feat(canary): add read-only runner and reports"
```

### Task 7: Add the reviewed Levels 0/1 manifest and Docker packaging guard

**Files:**
- Create: `.archon/canaries/smart-cauldron.yaml`
- Modify: `Dockerfile`
- Modify: `packages/server/src/docker-packaging.test.ts`

**Interfaces:**
- Produces: canonical eight-lane manifest packaged into the image.

- [ ] **Step 1: Add a failing packaging test**

```ts
expect(dockerfile.match(/COPY packages\/canary-suite\/package\.json \.\/packages\/canary-suite\//g)).toHaveLength(2);
expect(dockerfile).toContain('COPY packages/canary-suite/ ./packages/canary-suite/');
expect(dockerfile).toContain('COPY .archon/ ./.archon/');
```

- [ ] **Step 2: Create the exact manifest**

The YAML must contain the eight names in Section 5 of the design, orders 1 through 8,
and these conductor probes:

| Probe | Class/tags | Expected tier | Expected workflow |
|---|---|---|---|
| `mechanical-code` | `CODE`, `mechanical` | `zero` | `bdc-feature-development-zero-open` |
| `generic-code` | `CODE`, none | `codex` | `bdc-feature-development-codex` |
| `security-code` | `CODE`, `security` | `claude` | `bdc-feature-development` |
| `infra` | `INFRA`, none | `claude` | `bdc-feature-development` |

- [ ] **Step 3: Add Docker COPY lines without changing runtime controls**

Add `COPY packages/canary-suite/package.json ./packages/canary-suite/` in both the
`deps` package-metadata block and the production package-metadata block. Add
`COPY packages/canary-suite/ ./packages/canary-suite/` beside the other package
source copies in the production stage. The existing `COPY .archon/ ./.archon/`
already packages the manifest, so do not add a redundant narrower copy. Do not
alter ENTRYPOINT, CMD, user, mounts, or the CI health check.

- [ ] **Step 4: Verify and commit**

Run:

```bash
bun test packages/server/src/docker-packaging.test.ts packages/canary-suite/src/manifest.test.ts
bun run check:bundled
```

Expected: PASS.

```bash
git add .archon/canaries/smart-cauldron.yaml Dockerfile packages/server/src/docker-packaging.test.ts
git commit -m "build(canary): package the read-only suite manifest"
```

### Task 8: End-to-end hermetic proof and documentation

**Files:**
- Create: `packages/canary-suite/src/foundation.integration.test.ts`
- Create: `docs/operations/smart-cauldron-canary-suite.md`
- Modify: `packages/canary-suite/package.json`

**Interfaces:**
- Proves: fake authenticated server -> snapshot -> Level 0/1 plan -> JSON/Markdown artifacts.
- Documents: local-only commands and explicit prohibition on production activation in this plan.

- [ ] **Step 1: Write the integration test**

Start a local `Bun.serve` fixture that implements only the snapshot GET. Use the real
manifest, runner, planner, reducer, and report writer. Assert:

- eight direct lane plans;
- four conductor probe plans;
- verdict `passed`;
- three artifact files;
- fixture request count 1 and method GET;
- no workflow run/provider attempt object in any artifact.

- [ ] **Step 2: Run it before adding the package test command**

Run: `bun test packages/canary-suite/src/foundation.integration.test.ts`

Expected: PASS after Tasks 1-7; if it fails, fix the owning module rather than weakening
the integration assertions.

- [ ] **Step 3: Document exact local commands**

Document:

```bash
bun --filter @archon/canary-suite test
if (-not $env:CANARY_CODEBASE_ID) { throw 'Set CANARY_CODEBASE_ID from the authenticated GET /api/codebases response.' }
bun packages/canary-suite/src/cli.ts check --manifest .archon/canaries/smart-cauldron.yaml --api-base http://127.0.0.1:3090 --codebase-id $env:CANARY_CODEBASE_ID --output-root ./harness-artifacts/canaries
bun packages/canary-suite/src/cli.ts plan --manifest .archon/canaries/smart-cauldron.yaml --api-base http://127.0.0.1:3090 --codebase-id $env:CANARY_CODEBASE_ID --output-root ./harness-artifacts/canaries
```

State that production invocation, scheduling, Level 2, and all fault profiles remain
disabled and require later plans and approvals.

- [ ] **Step 4: Run the complete verification ladder**

Run in this order:

```bash
bun --filter @archon/canary-suite test
bun test packages/workflows/src/reliability/runtime-revisions.test.ts packages/workflows/src/reliability/workflow-capability-audit.test.ts packages/workflows/src/executor.test.ts
bun test packages/server/src/routes/api.providers.test.ts packages/server/src/services/canary-snapshot.test.ts packages/server/src/routes/api.canary-snapshot.test.ts packages/server/src/docker-packaging.test.ts
bun run check:bundled
bun run type-check
bun run lint --max-warnings 0
bun run format:check
git diff --check origin/dev...HEAD
$files = git diff --name-only origin/dev...HEAD | Where-Object { $_ -match '\.(ts|tsx|js|jsx|mjs|cjs|ps1|psm1|sh|html|yaml|yml)$' }
$nonAscii = foreach ($file in $files) { if (Test-Path -LiteralPath $file) { rg -nP "[^\x00-\x7F]" -- $file } }
if ($nonAscii) { $nonAscii | Write-Error; exit 1 }
```

Expected: every command exits 0; ASCII scan prints no matches and explicitly exits
nonzero only when at least one changed script/code file contains non-ASCII text.

- [ ] **Step 5: Commit the integration proof**

```bash
git add packages/canary-suite/src/foundation.integration.test.ts packages/canary-suite/package.json docs/operations/smart-cauldron-canary-suite.md
git commit -m "test(canary): prove read-only foundation end to end"
```

## Plan 1 Stop Point

Stop after Task 8. Deliver:

- branch and commit list;
- exact changed-file list;
- focused and full verification output;
- a local JSON/Markdown Level 0/1 report from the hermetic fixture;
- proof that no POST/PUT/PATCH/DELETE request occurred;
- proof that no production host, database, workflow, provider, branch, worktree, or PR was mutated.

Do not deploy, invoke the production snapshot endpoint, enable a schedule, create a
standing canary WO, or begin Level 2 in this implementation plan.
