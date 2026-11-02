import { expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildCanaryPlan } from './planner';
import { reduceCanaryPlan } from './reducer';
import { createCanaryReport, writeCanaryArtifacts } from './report';
import { baseSnapshot, manifest } from './test-fixtures';

test('writes deterministic JSON and Markdown artifacts atomically', async () => {
  const root = await mkdtemp(join(tmpdir(), 'canary-report-'));
  try {
    const plan = buildCanaryPlan(manifest, baseSnapshot);
    const report = createCanaryReport('suite-fixture-001', 1, plan, reduceCanaryPlan(plan));
    const paths = await writeCanaryArtifacts(root, plan, report);
    expect(paths.map(path => path.replaceAll('\\', '/').slice(root.length + 1))).toEqual([
      'suite-fixture-001/plan.json',
      'suite-fixture-001/summary.json',
      'suite-fixture-001/summary.md',
    ]);
    const markdown = await readFile(paths[2]!, 'utf8');
    expect(markdown).toContain('| Lane | Level | Verdict |');
    expect(markdown).toContain('bdc-feature-development-zero-open');
    expect(report.lanes[0]?.verdict).toBe('static_only');
    await expect(writeCanaryArtifacts(root, plan, report)).resolves.toEqual(paths);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('demotes clean per-lane static capability to static_only', () => {
  const plan = buildCanaryPlan(manifest, baseSnapshot);
  const report = createCanaryReport('suite-fixture-002', 1, plan, reduceCanaryPlan(plan));
  expect(report.lanes.every(lane => lane.verdict === 'static_only')).toBe(true);
});

test('rejects conflicting bytes for an existing suite ID', async () => {
  const root = await mkdtemp(join(tmpdir(), 'canary-report-conflict-'));
  try {
    const plan = buildCanaryPlan(manifest, baseSnapshot);
    const report = createCanaryReport('suite-fixture-001', 1, plan, reduceCanaryPlan(plan));
    await writeCanaryArtifacts(root, plan, report);
    const changed = { ...report, reasonCodes: ['changed'] };
    await expect(writeCanaryArtifacts(root, plan, changed)).rejects.toThrow(
      'canary_artifact_conflict'
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('allows concurrent identical writers without deleting another writer temporary files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'canary-report-concurrent-'));
  try {
    const plan = buildCanaryPlan(manifest, baseSnapshot);
    const report = createCanaryReport('suite-fixture-001', 1, plan, reduceCanaryPlan(plan));
    const [first, second] = await Promise.all([
      writeCanaryArtifacts(root, plan, report),
      writeCanaryArtifacts(root, plan, report),
    ]);
    expect(first).toEqual(second);
    expect((await readdir(join(root, 'suite-fixture-001'))).sort()).toEqual([
      'plan.json',
      'summary.json',
      'summary.md',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
