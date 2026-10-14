import { describe, expect, test } from 'bun:test';
import { GitHubApiMeter } from './metering';
describe('Test 6: GitHub metering', () => {
  test('aggregates usage and keeps pool resources independent without network calls', async () => {
    const flushed: unknown[][] = [];
    let now = Date.parse('2026-10-14T10:01:00Z');
    const meter = new GitHubApiMeter(
      {
        flush: async (u, s) => {
          flushed.push(u, s);
        },
      },
      () => now
    );
    for (let i = 0; i < 8; i++)
      meter.record({
        service: 'taskmaster',
        poolId: 'app-2-20',
        resource: 'core',
        status: 200,
        limit: 15000,
        remaining: 14000 - i,
        resetAt: now + 1000,
        rateLimited: i < 2,
      });
    meter.record({
      service: 'overseer',
      poolId: 'app-1-10',
      resource: 'core',
      status: 200,
      limit: 15000,
      remaining: 14900,
      resetAt: now + 1000,
    });
    meter.record({
      service: 'taskmaster',
      poolId: 'app-2-20',
      resource: 'search',
      status: 200,
      limit: 30,
      remaining: 25,
      resetAt: now + 1000,
      permissionFallback: true,
    });
    expect(await meter.flush(true)).toBe(true);
    expect(flushed[0] as unknown[]).toHaveLength(3);
    expect(flushed[1] as unknown[]).toHaveLength(3);
    expect(JSON.stringify(flushed)).not.toContain('token');
  });
});
