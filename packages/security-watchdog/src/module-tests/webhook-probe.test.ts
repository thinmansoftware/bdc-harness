import { describe, expect, test } from 'bun:test';
import { scanWebhooks } from '../modules/webhook-probe';
import { fixtureBaseline } from '../test-fixtures';

describe('scanWebhooks', () => {
  test('flags public unauthenticated webhook paths outside baseline', async () => {
    const findings = await scanWebhooks(fixtureBaseline, {
      paths: ['/webhook/debug'],
      fetcher: async (path, method) => ({ path, method, status: method === 'GET' ? 200 : 404, bodySample: 'ok' }),
    });
    expect(findings[0]).toMatchObject({
      severity: 'HIGH',
      target: '/webhook/debug',
      reason_code: 'webhook_public_reachable',
    });
  });
});
