import { expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { renderLifecycleMarkdown, writeLifecycleCanaryArtifacts } from './lifecycle-report';
import type { LifecycleCanaryReport } from './types';

function report(overrides: Partial<LifecycleCanaryReport> = {}): LifecycleCanaryReport {
  return {
    schemaVersion: 1,
    suiteRunId: 'lifecycle-fixture-001',
    generatedAt: '2026-09-02T00:00:00.000Z',
    verdict: 'blocked',
    reasonCodes: ['taskmaster_never_fires'],
    invariantViolations: [],
    legs: [
      {
        legId: 'taskmaster-fire',
        title: 'Taskmaster proposes/dispatches the canary WO',
        verdict: 'blocked',
        reasonCodes: ['taskmaster_never_fires'],
        evidenceRefs: ['tm_journal.fire_cauldron_rows=0'],
        gap: 'taskmaster-never-fired, fallback: fire.ps1 used',
      },
      {
        legId: 'canary-reverts',
        title: 'the canary change reverts so dev stays clean',
        verdict: 'passed',
        reasonCodes: [],
        evidenceRefs: ['scratch_residue_diff=empty'],
      },
    ],
    ...overrides,
  };
}

test('renders every leg with verdict, reasons, gap and evidence', () => {
  const markdown = renderLifecycleMarkdown(report());
  expect(markdown).toContain('| # | Leg | Verdict | Reasons | Gap | Evidence |');
  expect(markdown).toContain('Taskmaster proposes/dispatches the canary WO');
  expect(markdown).toContain('taskmaster_never_fires');
  expect(markdown).toContain('taskmaster-never-fired, fallback: fire.ps1 used');
  expect(markdown).toContain('- No invariant violations detected.');
});

test('renders invariant violations when present', () => {
  const markdown = renderLifecycleMarkdown(
    report({ invariantViolations: ['canary_diff_scope_violation: packages/server/src/x.ts'] })
  );
  expect(markdown).toContain('VIOLATED: canary_diff_scope_violation');
});

test('writes summary.json and summary.md atomically and idempotently', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lifecycle-report-'));
  try {
    const paths = await writeLifecycleCanaryArtifacts(root, report());
    expect(paths.map(path => path.replaceAll('\\', '/').slice(root.length + 1))).toEqual([
      'lifecycle-fixture-001/summary.json',
      'lifecycle-fixture-001/summary.md',
    ]);
    expect(JSON.parse(await readFile(paths[0]!, 'utf8')).suiteRunId).toBe('lifecycle-fixture-001');
    // Idempotent second write returns the same paths.
    await expect(writeLifecycleCanaryArtifacts(root, report())).resolves.toEqual(paths);
    expect((await readdir(join(root, 'lifecycle-fixture-001'))).sort()).toEqual([
      'summary.json',
      'summary.md',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects conflicting bytes for an existing run id', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lifecycle-report-conflict-'));
  try {
    await writeLifecycleCanaryArtifacts(root, report());
    await expect(
      writeLifecycleCanaryArtifacts(root, report({ verdict: 'failed' }))
    ).rejects.toThrow('lifecycle_canary_artifact_conflict');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
