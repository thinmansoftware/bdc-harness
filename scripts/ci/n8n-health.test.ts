import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_BASE_URL,
  DEFAULT_HEALTH_PATH,
  checkN8nHealth,
  parseArgs,
  responseJsonLooksHealthy,
} from './n8n-health.js';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

describe('n8n-health', () => {
  test('builds default and env-derived health URLs', () => {
    expect(parseArgs([], {}).url).toBe(`${DEFAULT_BASE_URL}${DEFAULT_HEALTH_PATH}`);
    expect(
      parseArgs([], { N8N_BASE_URL: 'https://n8n.example.test/', N8N_HEALTH_PATH: 'healthz' }).url
    ).toBe('https://n8n.example.test/healthz');
    expect(parseArgs([], { N8N_HEALTH_URL: 'https://n8n.example.test/custom' }).url).toBe(
      'https://n8n.example.test/custom'
    );
  });

  test('rejects invalid URLs and nonpositive numeric options', () => {
    expect(() => parseArgs(['--url', 'notaurl'], {})).toThrow(/invalid/);
    expect(() => parseArgs(['--timeout-ms', '0'], {})).toThrow(/positive integer/);
    expect(() => parseArgs(['--retries', '-1'], {})).toThrow(/positive integer/);
  });

  test('passes on a successful n8n JSON health response', async () => {
    const calls: string[] = [];
    const result = await checkN8nHealth(
      parseArgs(['--url', 'https://n8n.example.test/healthz', '--expect-json'], {}),
      {
        fetch: async url => {
          calls.push(String(url));
          return jsonResponse({ status: 'ok' });
        },
        sleep: async () => {},
        now: () => 100,
      }
    );

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(1);
    expect(calls).toEqual(['https://n8n.example.test/healthz']);
  });

  test('retries transient failures and reports the final error without leaking bodies', async () => {
    let attempts = 0;
    const result = await checkN8nHealth(
      parseArgs(['--url', 'https://n8n.example.test/healthz'], {}),
      {
        fetch: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error('network reset');
          return new Response('not found body with internal routing detail', { status: 404 });
        },
        sleep: async () => {},
        now: () => 100,
      }
    );

    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(3);
    expect(result.error).toBe('HTTP 404');
  });

  test('JSON expectation rejects bodies without a healthy-looking status', async () => {
    const result = await checkN8nHealth(
      parseArgs(['--url', 'https://n8n.example.test/healthz', '--expect-json'], {}),
      {
        fetch: async () => jsonResponse({ status: 'starting' }),
        sleep: async () => {},
        now: () => 100,
      }
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('healthy status');
    expect(responseJsonLooksHealthy({ status: 'ready' })).toBe(true);
    expect(responseJsonLooksHealthy({ status: 'starting' })).toBe(false);
  });
});
