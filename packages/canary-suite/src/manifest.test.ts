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
