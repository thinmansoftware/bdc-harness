import { describe, expect, test } from 'bun:test';
import { MemoryOverseerActionStore, OverseerService } from '../index.ts';

describe('OverseerService', () => {
  test('honors OVERSEER_ENABLED-style disabled mode', async () => {
    const store = new MemoryOverseerActionStore();
    const service = new OverseerService({ enabled: false, store });
    const action = await service.reconcile({
      runId: 'run-1',
      failureClass: 'rate_limit_exceeded',
      attempt: 1,
      hasCommittedDiff: false,
      hasUnstagedDiff: false,
    });
    expect(action).toBeUndefined();
    expect(await service.actions('run-1')).toHaveLength(0);
  });

  test('records actions when enabled', async () => {
    const service = new OverseerService({ enabled: true });
    const action = await service.reconcile({
      runId: 'run-1',
      failureClass: 'rate_limit_exceeded',
      attempt: 1,
      hasCommittedDiff: false,
      hasUnstagedDiff: false,
    });
    expect(action?.kind).toBe('rate_limit');
    expect(await service.actions('run-1')).toHaveLength(1);
  });
});
