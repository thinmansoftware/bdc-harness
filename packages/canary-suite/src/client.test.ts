import { expect, mock, test } from 'bun:test';
import { ArchonCanaryClient } from './client';
import { baseSnapshot } from './test-fixtures';

test('performs one authenticated GET and parses the snapshot', async () => {
  const token = 'fixture-secret-token';
  const fetcher = mock(async (_input: string | URL | Request, _init?: RequestInit) =>
    Response.json(baseSnapshot)
  );
  const client = new ArchonCanaryClient('http://127.0.0.1:3090', token, fetcher);
  expect(await client.getSnapshot('codebase-1', 'dev')).toEqual(baseSnapshot);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [input, init] = fetcher.mock.calls[0]!;
  expect(String(input)).toContain(
    '/api/admin/canary/snapshot?codebaseId=codebase-1&baseBranch=dev'
  );
  expect(init?.method).toBe('GET');
  expect(init?.headers).toEqual({ 'x-archon-operator-token': token });
});

test('redacts the token from non-2xx response errors', async () => {
  const token = 'fixture-secret-token';
  const fetcher = mock(async () => new Response(`upstream echoed ${token}`, { status: 503 }));
  const client = new ArchonCanaryClient('http://127.0.0.1:3090', token, fetcher);
  let message = '';
  try {
    await client.getSnapshot('codebase-1', 'dev');
  } catch (error) {
    message = (error as Error).message;
  }
  expect(message).toContain('canary_snapshot_http_503');
  expect(message).toContain('[REDACTED]');
  expect(message).not.toContain(token);
});
