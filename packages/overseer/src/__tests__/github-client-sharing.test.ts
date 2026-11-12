/**
 * WO-HARNESS-OVERSEER-GITHUB-READ-BUDGET-01, finding 3 (bdc-xo#5571): the Overseer's GitHub
 * clients are shared per identity, so installation-token mints fall from one per call (225 an hour
 * on 2026-11-11) to one per token lifetime, while the review and merge identities stay separate.
 */
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  createRealMergeOctokitClient,
  createRealOctokitClient,
  resetSharedGitHubClients,
} from '../adapters/github-real-deps';

function pem(): string {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey;
}

const ENV_KEYS = Object.keys(process.env).filter(
  key =>
    key.startsWith('GITHUB_APP') ||
    key === 'GH_TOKEN' ||
    key === 'GITHUB_TOKEN' ||
    key === 'MERGE_MANAGER_GH_TOKEN'
);
const saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
const TOUCHED = [
  'GITHUB_APP_OVERSEER_ID',
  'GITHUB_APP_OVERSEER_INSTALLATION_ID',
  'GITHUB_APP_OVERSEER_PRIVATE_KEY',
  'GITHUB_APP_MERGE_MANAGER_ID',
  'GITHUB_APP_MERGE_MANAGER_INSTALLATION_ID',
  'GITHUB_APP_MERGE_MANAGER_PRIVATE_KEY',
  'GITHUB_APP_PR_DISCOVERY_ID',
  'GITHUB_APP_PR_DISCOVERY_INSTALLATION_ID',
  'GITHUB_APP_PR_DISCOVERY_PRIVATE_KEY',
];

/** A fetch that answers like GitHub and counts the installation-token mints per installation. */
function countingFetch(): { fetch: typeof fetch; mints: Record<string, number>; reads: number } {
  const state = { mints: {} as Record<string, number>, reads: 0 };
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const mint = /\/app\/installations\/(\d+)\/access_tokens$/.exec(url);
    if (method === 'POST' && mint?.[1]) {
      state.mints[mint[1]] = (state.mints[mint[1]] ?? 0) + 1;
      return Response.json(
        {
          token: `test-token-${mint[1]}`,
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          permissions: {},
          repository_selection: 'all',
        },
        { status: 201 }
      );
    }
    state.reads += 1;
    return Response.json({ number: 1 }, { status: 200 });
  }) as typeof fetch;
  return {
    fetch: fakeFetch,
    get mints() {
      return state.mints;
    },
    get reads() {
      return state.reads;
    },
  };
}

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.GITHUB_APP_OVERSEER_ID = '111';
  process.env.GITHUB_APP_OVERSEER_INSTALLATION_ID = '222';
  process.env.GITHUB_APP_OVERSEER_PRIVATE_KEY = pem();
  resetSharedGitHubClients();
});

afterEach(() => {
  for (const key of [...TOUCHED, ...ENV_KEYS]) delete process.env[key];
  for (const [key, value] of Object.entries(saved))
    if (value !== undefined) process.env[key] = value;
  resetSharedGitHubClients();
});

describe('shared GitHub clients', () => {
  test('2: twenty factory calls, one client, exactly one installation-token mint', async () => {
    const probe = countingFetch();
    const clients = Array.from({ length: 20 }, () =>
      createRealOctokitClient('overseer', { fetch: probe.fetch })
    );
    expect(new Set(clients).size).toBe(1);
    await Promise.all(
      clients.map(client =>
        client.pulls.get({ owner: 'thinmansoftware', repo: 'bdc-xo', pull_number: 1 })
      )
    );
    expect(probe.mints).toEqual({ '222': 1 });
    expect(probe.reads).toBe(20);
    // A later call, long after, still reuses the cached token (one mint per token lifetime).
    await createRealOctokitClient('overseer').pulls.get({
      owner: 'thinmansoftware',
      repo: 'bdc-xo',
      pull_number: 2,
    });
    expect(probe.mints).toEqual({ '222': 1 });
  });

  test('2b: the pr_discovery service has its own client and its own mint', async () => {
    process.env.GITHUB_APP_PR_DISCOVERY_ID = '666';
    process.env.GITHUB_APP_PR_DISCOVERY_INSTALLATION_ID = '555';
    process.env.GITHUB_APP_PR_DISCOVERY_PRIVATE_KEY = pem();
    const probe = countingFetch();
    const review = createRealOctokitClient('overseer', { fetch: probe.fetch });
    const discovery = createRealOctokitClient('pr_discovery', { fetch: probe.fetch });
    expect(discovery).not.toBe(review);
    await review.pulls.get({ owner: 'thinmansoftware', repo: 'bdc-xo', pull_number: 1 });
    await discovery.pulls.get({ owner: 'thinmansoftware', repo: 'bdc-xo', pull_number: 1 });
    expect(probe.mints).toEqual({ '222': 1, '555': 1 });
  });

  test('3: the merge client and the review client stay separate identities', async () => {
    process.env.GITHUB_APP_MERGE_MANAGER_ID = '333';
    process.env.GITHUB_APP_MERGE_MANAGER_INSTALLATION_ID = '444';
    process.env.GITHUB_APP_MERGE_MANAGER_PRIVATE_KEY = pem();
    const probe = countingFetch();
    const review = createRealOctokitClient('overseer', { fetch: probe.fetch });
    const merge = createRealMergeOctokitClient({ fetch: probe.fetch });
    expect(merge).not.toBe(review);
    expect(createRealMergeOctokitClient()).toBe(merge);
    expect(createRealOctokitClient()).toBe(review);
    await Promise.all([
      review.pulls.get({ owner: 'thinmansoftware', repo: 'bdc-xo', pull_number: 1 }),
      merge.pulls.get({ owner: 'thinmansoftware', repo: 'bdc-xo', pull_number: 1 }),
    ]);
    // Each identity mints for ITS installation, once.
    expect(probe.mints).toEqual({ '222': 1, '444': 1 });
  });

  test('a rotated private key gets a new client; the old one is not reused', () => {
    const first = createRealOctokitClient('overseer', { fetch: countingFetch().fetch });
    process.env.GITHUB_APP_OVERSEER_PRIVATE_KEY = pem();
    const second = createRealOctokitClient('overseer', { fetch: countingFetch().fetch });
    expect(second).not.toBe(first);
  });

  test('a PAT identity is shared too and keyed by the token, not stored in clear', () => {
    for (const key of TOUCHED) delete process.env[key];
    process.env.GH_TOKEN = 'unit-test-placeholder-token';
    const a = createRealOctokitClient('overseer');
    expect(createRealOctokitClient('overseer')).toBe(a);
    process.env.GH_TOKEN = 'unit-test-placeholder-token-2';
    expect(createRealOctokitClient('overseer')).not.toBe(a);
  });
});
