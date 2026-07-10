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
  lanes: z
    .array(z.object({ name: laneName, order: z.number().int().positive() }))
    .length(CANARY_LANES.length),
  conductor_probes: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z0-9-]+$/),
        wo_class: z.enum(['CODE', 'INFRA', 'MIXED']).optional(),
        tags: z.array(z.string().min(1)),
        expected_tier: z.string().min(1),
        expected_workflow: laneName,
      })
    )
    .min(1),
});

export async function loadCanaryManifest(path: string): Promise<CanaryManifest> {
  const parsed = rawManifestSchema.parse(Bun.YAML.parse(await readFile(path, 'utf8')));
  const laneNames = parsed.lanes.map(lane => lane.name);
  if (new Set(laneNames).size !== laneNames.length) {
    throw new Error('manifest_lane_duplicate');
  }
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
      ...(probe.wo_class === undefined ? {} : { woClass: probe.wo_class }),
      tags: probe.tags,
      expectedTier: probe.expected_tier,
      expectedWorkflow: probe.expected_workflow,
    })),
  };
}
