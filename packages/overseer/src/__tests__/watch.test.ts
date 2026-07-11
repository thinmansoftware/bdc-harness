import { describe, expect, test } from 'bun:test';
import { MemoryOverseerActionStore, watchFailure } from '../index.ts';

describe('watchFailure', () => {
  test('classifies and persists a watched failure action', async () => {
    const store = new MemoryOverseerActionStore();
    const action = await watchFailure({
      runId: 'run-1',
      message: 'rate_limit_exceeded',
      attempt: 1,
      store,
    });
    expect(action?.kind).toBe('rate_limit');
    expect(await store.list('run-1')).toHaveLength(1);
  });
});
