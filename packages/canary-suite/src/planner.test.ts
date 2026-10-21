import { expect, test } from 'bun:test';
import { buildCanaryPlan } from './planner';
import { baseSnapshot, manifest } from './test-fixtures';

test('plans all nine direct lanes and four conductor probes exactly', () => {
  const plan = buildCanaryPlan(manifest, baseSnapshot);
  expect(plan.directRoutes).toHaveLength(9);
  expect(plan.directRoutes.every(route => route.matches.length === 1)).toBe(true);
  expect(plan.directRoutes.find(route => route.lane === 'bdc-feature-development-grok')).toEqual({
    lane: 'bdc-feature-development-grok',
    matches: [
      {
        name: 'bdc-feature-development-grok',
        source: 'project',
        revision: 'sha256:bdc-feature-development-grok',
        capabilityIssues: [],
      },
    ],
  });
  expect(plan.conductorRoutes).toEqual([
    {
      probeId: 'mechanical-code',
      expectedTier: 'zero',
      expectedWorkflow: 'bdc-feature-development-zero-open',
      tier: 'zero',
      workflowName: 'bdc-feature-development-zero-open',
    },
    {
      probeId: 'generic-code',
      expectedTier: 'cursor',
      expectedWorkflow: 'bdc-feature-development-cursor',
      tier: 'cursor',
      workflowName: 'bdc-feature-development-cursor',
    },
    {
      probeId: 'security-code',
      expectedTier: 'cursor',
      expectedWorkflow: 'bdc-feature-development-cursor',
      tier: 'cursor',
      workflowName: 'bdc-feature-development-cursor',
    },
    {
      probeId: 'infra',
      expectedTier: 'cursor',
      expectedWorkflow: 'bdc-feature-development-cursor',
      tier: 'cursor',
      workflowName: 'bdc-feature-development-cursor',
    },
  ]);
});

test('uses a deterministic request identity and freezes the plan', () => {
  const first = buildCanaryPlan(manifest, baseSnapshot);
  const second = buildCanaryPlan(manifest, baseSnapshot);
  expect(first.requestId).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(first.requestId).toBe(second.requestId);
  expect(Object.isFrozen(first)).toBe(true);
  expect(Object.isFrozen(first.directRoutes)).toBe(true);
});
