import { describe, expect, mock, test } from 'bun:test';

const query = mock(async () => ({ rows: [], rowCount: 0 }));
mock.module('@archon/core/db/connection', () => ({ getDatabase: () => ({ query }) }));
mock.module('@archon/core/db/dispatch', () => ({ reconcileDispatchOutcomeNotices: async () => 0 }));

describe('dispatch escalation clock', () => {
  test('does not deliver when no blocker is due', async () => {
    const { runDispatchEscalationClock } = await import('./escalation-clock');
    expect(await runDispatchEscalationClock({ now: new Date('2026-01-01T00:00:00Z') })).toBe(0);
    expect(query).toHaveBeenCalledTimes(1);
  });
});
