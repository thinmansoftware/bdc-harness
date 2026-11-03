import { describe, expect, test } from 'bun:test';
import {
  IN_PROCESS_API_ORIGIN,
  createInProcessApiFetch,
  isInProcessServiceRequest,
} from './in-process-authority';

type Seen = { request: Request; authorized: boolean };

function makeApp(): { app: { fetch: (r: Request) => Promise<Response> }; seen: Seen[] } {
  const seen: Seen[] = [];
  const app = {
    fetch: async (request: Request): Promise<Response> => {
      seen.push({ request, authorized: isInProcessServiceRequest(request) });
      return new Response(JSON.stringify({ path: new URL(request.url).pathname }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    },
  };
  return { app, seen };
}

describe('in-process authority', () => {
  test('origin constant is the unresolvable in-process host', () => {
    expect(IN_PROCESS_API_ORIGIN).toBe('http://archon.in-process');
  });

  test('a request built by createInProcessApiFetch reaches app.fetch marked authorized', async () => {
    const { app, seen } = makeApp();
    const f = createInProcessApiFetch(app);
    const res = await f(`${IN_PROCESS_API_ORIGIN}/api/health?x=1`, { method: 'POST', body: 'hi' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ path: '/api/health' });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.authorized).toBe(true);
    expect(seen[0]?.request.method).toBe('POST');
    expect(await seen[0]?.request.text()).toBe('hi');
  });

  test('accepts URL and Request inputs, and still authorizes them', async () => {
    const { app, seen } = makeApp();
    const f = createInProcessApiFetch(app);
    await f(new URL(`${IN_PROCESS_API_ORIGIN}/api/a`));
    await f(new Request(`${IN_PROCESS_API_ORIGIN}/api/b`));
    expect(seen.map(s => new URL(s.request.url).pathname)).toEqual(['/api/a', '/api/b']);
    expect(seen.every(s => s.authorized)).toBe(true);
  });

  test('a network-style request spoofing the origin and headers is NOT authorized', () => {
    const spoof = new Request(`${IN_PROCESS_API_ORIGIN}/api/health`, {
      headers: {
        host: 'archon.in-process',
        origin: IN_PROCESS_API_ORIGIN,
        'x-in-process': 'true',
        'x-archon-in-process': '1',
      },
    });
    expect(isInProcessServiceRequest(spoof)).toBe(false);
    expect(isInProcessServiceRequest(new Request('http://localhost:3090/api/health'))).toBe(false);
  });

  test('a clone or re-wrap of an authorized request is not itself authorized', async () => {
    const { app, seen } = makeApp();
    await createInProcessApiFetch(app)(`${IN_PROCESS_API_ORIGIN}/api/x`);
    const original = seen[0]?.request as Request;
    expect(isInProcessServiceRequest(original)).toBe(true);
    expect(isInProcessServiceRequest(original.clone())).toBe(false);
    expect(isInProcessServiceRequest(new Request(original))).toBe(false);
  });

  test('refuses any other origin without calling app.fetch', async () => {
    const { app, seen } = makeApp();
    const f = createInProcessApiFetch(app);
    for (const url of [
      'http://localhost:3090/api/health',
      'https://archon.in-process/api/health',
      'http://archon.in-process:8080/api/health',
      'http://evil.example/api/health',
    ]) {
      await expect(f(url)).rejects.toThrow('in_process_api_fetch_origin_refused');
    }
    expect(seen).toHaveLength(0);
  });

  test('strips dispatch principal headers before dispatch', async () => {
    const { app, seen } = makeApp();
    await createInProcessApiFetch(app)(`${IN_PROCESS_API_ORIGIN}/api/dispatch/messages`, {
      headers: {
        'x-dispatch-principal-id': 'someone',
        'x-dispatch-principal-token': 'secret',
        'x-keep': 'yes',
      },
    });
    const headers = seen[0]?.request.headers as Headers;
    expect(headers.has('x-dispatch-principal-id')).toBe(false);
    expect(headers.has('x-dispatch-principal-token')).toBe(false);
    expect(headers.get('x-keep')).toBe('yes');
  });

  test('a rejected app.fetch propagates to the caller', async () => {
    const f = createInProcessApiFetch({
      fetch: async () => {
        throw new Error('boom');
      },
    });
    await expect(f(`${IN_PROCESS_API_ORIGIN}/api/x`)).rejects.toThrow('boom');
  });
});
