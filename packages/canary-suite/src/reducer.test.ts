import { expect, test } from 'bun:test';
import { buildCanaryPlan } from './planner';
import { reduceCanaryPlan } from './reducer';
import { baseSnapshot, manifest, snapshot } from './test-fixtures';

const sevenLanes = baseSnapshot.workflows.slice(0, 7);
const duplicateLane = [...baseSnapshot.workflows, baseSnapshot.workflows[0]!];
const loaderError = {
  filename: 'broken.yaml',
  error: 'invalid',
  errorType: 'validation_error' as const,
};
const badCapabilityLane = {
  ...baseSnapshot.workflows[0]!,
  capabilityIssues: ['provider_execution_capability_mismatch'],
};

test.each([
  ['missing lane', snapshot({ workflows: sevenLanes }), 'failed', 'lane_missing'],
  ['duplicate lane', snapshot({ workflows: duplicateLane }), 'failed', 'lane_duplicate'],
  ['loader error', snapshot({ loaderErrors: [loaderError] }), 'failed', 'workflow_loader_error'],
  [
    'capability mismatch',
    snapshot({ workflows: [badCapabilityLane, ...baseSnapshot.workflows.slice(1)] }),
    'failed',
    'capability_mismatch',
  ],
  [
    'wrong remote',
    snapshot({ codebase: { ...baseSnapshot.codebase, canonicalRemote: 'other/repo' } }),
    'failed',
    'canonical_remote_mismatch',
  ],
  [
    'unknown image',
    snapshot({ revisions: { ...baseSnapshot.revisions, runtimeImageRevision: null } }),
    'blocked',
    'runtime_image_revision_missing',
  ],
  [
    'draining',
    snapshot({ drain: { ...baseSnapshot.drain, mode: 'draining' } }),
    'blocked',
    'cauldron_draining',
  ],
] as const)('%s', (_name, input, verdict, reason) => {
  const report = reduceCanaryPlan(buildCanaryPlan(manifest, input));
  expect(report.verdict).toBe(verdict);
  expect(report.reasonCodes).toContain(reason);
  expect(report.evidenceRefs.length).toBeGreaterThan(0);
});

test('passes a complete clean snapshot', () => {
  const result = reduceCanaryPlan(buildCanaryPlan(manifest, baseSnapshot));
  expect(result).toEqual({ verdict: 'passed', reasonCodes: [], evidenceRefs: [] });
});

test('failed takes precedence over blocked', () => {
  const input = snapshot({
    workflows: sevenLanes,
    revisions: { ...baseSnapshot.revisions, runtimeImageRevision: null },
  });
  expect(reduceCanaryPlan(buildCanaryPlan(manifest, input)).verdict).toBe('failed');
});

test('Level 0 ignores conductor routing while Level 1 evaluates it', () => {
  const input = snapshot({ ladder: { tiers: [] } });
  const plan = buildCanaryPlan(manifest, input);
  expect(reduceCanaryPlan(plan, 0).verdict).toBe('passed');
  expect(reduceCanaryPlan(plan, 1).reasonCodes).toContain('conductor_route_mismatch');
});
