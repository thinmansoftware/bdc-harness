import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { resolveServiceGitHubLogin } from './github-service-login';

// Env keys that influence resolveServiceGitHubAuth('run_nodes'). Snapshot and
// clear them so the tests are hermetic regardless of ambient CI env.
const ENV_KEYS = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GITHUB_APP_RUN_NODES_ID',
  'GITHUB_APP_RUN_NODES_INSTALLATION_ID',
  'GITHUB_APP_RUN_NODES_PRIVATE_KEY',
  'GITHUB_APP_RUN_NODES_PRIVATE_KEY_PATH',
  'GITHUB_APP_OVERSEER_ID',
  'GITHUB_APP_OVERSEER_INSTALLATION_ID',
  'GITHUB_APP_OVERSEER_PRIVATE_KEY',
  'GITHUB_APP_ID',
  'GITHUB_APP_INSTALLATION_ID',
  'GITHUB_APP_PRIVATE_KEY',
];

let snapshot: Record<string, string | undefined> = {};

beforeEach(() => {
  snapshot = {};
  for (const key of ENV_KEYS) {
    snapshot[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (snapshot[key] === undefined) delete process.env[key];
    else process.env[key] = snapshot[key];
  }
});

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const segment = jwt.split('.')[1];
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe('Test 1: login-helper-resolves-pat-user', () => {
  it('names a PAT identity via GET /user and leaks the token nowhere else', async () => {
    process.env.GH_TOKEN = 'synthetic-pat';
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const stubFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const headers = new Headers(init?.headers);
      requests.push({ url, authorization: headers.get('authorization') });
      return new Response(JSON.stringify({ login: 'bluedevilcollectibles' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const login = await resolveServiceGitHubLogin('run_nodes', { fetch: stubFetch });

    expect(login).toBe('bluedevilcollectibles');
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('https://api.github.com/user');
    expect(requests[0].authorization).toBe('Bearer synthetic-pat');
  });
});

describe('Test 2: login-helper-resolves-app-slug-as-bot-login', () => {
  it('names an App identity via GET /app as "<slug>[bot]" and never calls /user', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    process.env.GITHUB_APP_RUN_NODES_ID = '5';
    process.env.GITHUB_APP_RUN_NODES_INSTALLATION_ID = '6';
    process.env.GITHUB_APP_RUN_NODES_PRIVATE_KEY = privateKey.export({
      type: 'pkcs1',
      format: 'pem',
    }) as string;

    const requests: Array<{ url: string; authorization: string | null }> = [];
    const stubFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const headers = new Headers(init?.headers);
      requests.push({ url, authorization: headers.get('authorization') });
      return new Response(JSON.stringify({ slug: 'thinman-builder' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const login = await resolveServiceGitHubLogin('run_nodes', { fetch: stubFetch });

    expect(login).toBe('thinman-builder[bot]');
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('https://api.github.com/app');
    expect(requests.some(r => r.url.endsWith('/user'))).toBe(false);

    const auth = requests[0].authorization ?? '';
    expect(auth.startsWith('Bearer ')).toBe(true);
    const payload = decodeJwtPayload(auth.slice('Bearer '.length));
    expect(payload.iss).toBe('5');
  });
});
