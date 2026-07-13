import { expect, mock, test } from 'bun:test';
import { mkdtemp, readdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { runCanary } from './runner';
import { baseSnapshot, manifest } from './test-fixtures';

test('runs Levels 0 and 1 through exactly one GET and writes evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'canary-runner-'));
  try {
    const manifestPath = join(root, 'manifest.yaml');
    await writeFile(
      manifestPath,
      JSON.stringify({
        schema_version: manifest.schemaVersion,
        environment: {
          id: manifest.environment.id,
          project: manifest.environment.project,
          canonical_remote: manifest.environment.canonicalRemote,
          base_branch: manifest.environment.baseBranch,
        },
        artifact_root: manifest.artifactRoot,
        lanes: manifest.lanes,
        conductor_probes: manifest.conductorProbes.map(probe => ({
          id: probe.id,
          wo_class: probe.woClass,
          tags: probe.tags,
          expected_tier: probe.expectedTier,
          expected_workflow: probe.expectedWorkflow,
        })),
      })
    );
    const methods: string[] = [];
    const fetcher = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      methods.push(init?.method ?? 'GET');
      return Response.json(baseSnapshot);
    });
    const result = await runCanary({
      level: 1,
      manifestPath,
      apiBase: 'http://127.0.0.1:3090',
      token: 'fixture-token',
      outputRoot: join(root, 'artifacts'),
      codebaseId: 'codebase-1',
      fetcher,
    });
    expect(result.report.verdict).toBe('static_only');
    expect(result.report.lanes).toHaveLength(8);
    expect(methods).toEqual(['GET']);
    expect(await readdir(join(root, 'artifacts', result.report.suiteRunId))).toEqual([
      'plan.json',
      'summary.json',
      'summary.md',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
