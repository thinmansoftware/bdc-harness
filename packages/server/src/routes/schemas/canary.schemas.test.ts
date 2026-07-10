import { expect, test } from 'bun:test';
import { canarySnapshotResponseSchema } from './canary.schemas';

test('rejects whitespace-only runtime revision values', () => {
  const revisionsSchema = canarySnapshotResponseSchema.shape.revisions;
  expect(() =>
    revisionsSchema.parse({
      engineRevision: 'sha256:engine',
      bundleRevision: 'sha256:bundle',
      runtimeImageRevision: '   ',
    })
  ).toThrow();
});
