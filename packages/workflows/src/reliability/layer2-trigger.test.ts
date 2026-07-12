import { expect, test } from 'bun:test';
import { mayStartLayer2Canary, shouldRunLayer2Canary } from './layer2-trigger';

test('layer 2 triggers only from explicit events', () => {
  expect(shouldRunLayer2Canary({ type: 'provider_change', path: 'packages/providers/src/index.ts' })).toBe(true);
  expect(shouldRunLayer2Canary({ type: 'lane_workflow_change', path: '.archon/workflows/defaults/lane.yaml' })).toBe(true);
  expect(shouldRunLayer2Canary({ type: 'runtime_revision_change', revision: 'abc123' })).toBe(true);
  expect(shouldRunLayer2Canary({ type: 'operator_command', lane: 'bdc-feature-development-codex' })).toBe(true);
  expect(shouldRunLayer2Canary({ type: 'provider_change', path: 'packages/server/src/index.ts' })).toBe(false);
});

test('layer 2 aborts unless layer 1 is green', () => {
  expect(mayStartLayer2Canary('pass')).toBe(true);
  expect(mayStartLayer2Canary('warn')).toBe(false);
  expect(mayStartLayer2Canary('block')).toBe(false);
});
