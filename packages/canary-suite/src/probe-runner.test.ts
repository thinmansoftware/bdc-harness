import { expect, test } from 'bun:test';
import { runLayer2TrivialFire } from './probe-runner';

test('Layer 2 aborts unless Layer 1 is green and has no time trigger', async () => {
  await expect(runLayer2TrivialFire({ lane: 'bdc-feature-development-codex', layer1Green: false })).resolves.toBe(
    'aborted'
  );
});
