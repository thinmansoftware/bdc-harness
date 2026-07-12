import { expect, test } from 'bun:test';
import { runCanaryProbe } from './probe-runner';

test('maps probe block to probe_failed', async () => {
  await expect(runCanaryProbe(async () => ({ status: 'block' }))).resolves.toEqual({
    verdict: 'probe_failed',
    reasonCodes: ['probe_structural_block'],
  });
});
