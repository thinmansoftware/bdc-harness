import { afterEach, describe, expect, it } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import {
  SERVICE_GITHUB_AUTH_PRECEDENCE,
  clearServiceGitHubTokenCache,
  getServiceGitHubToken,
  resolveServiceGitHubAuth,
} from './service-identity';

const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();

afterEach(clearServiceGitHubTokenCache);

describe('Test 2: service GitHub identity precedence', () => {
  it('preserves legacy identities and review/merge separation', () => {
    const env = {
      GITHUB_APP_ID: '1',
      GITHUB_APP_INSTALLATION_ID: '2',
      GITHUB_APP_PRIVATE_KEY: privateKey,
      GH_TOKEN: 'user',
      MERGE_MANAGER_GH_TOKEN: 'merge',
    };
    expect(resolveServiceGitHubAuth('overseer', env).poolId).toBe('app-1-2');
    expect(resolveServiceGitHubAuth('pr_discovery', env).poolId).toBe('app-1-2');
    expect(resolveServiceGitHubAuth('merge_manager', env).poolId).toBe('merge-manager-pat');
    for (const service of ['taskmaster', 'duty_officer'] as const) {
      expect(resolveServiceGitHubAuth(service, env).poolId).toBe('app-1-2');
    }
    // Builder lanes never borrow the shared reviewer App; with no own App they use the PAT.
    for (const service of ['smart_cauldron', 'run_nodes'] as const) {
      const identity = resolveServiceGitHubAuth(service, env);
      expect(identity.kind).toBe('pat');
      expect(identity.poolId).toBe('user-pat');
    }
  });

  it('uses the taskmaster alias family, an own override, and throws on partial trios', () => {
    const env = {
      GITHUB_APP_TASKMASTER_ID: '3',
      GITHUB_APP_TASKMASTER_INSTALLATION_ID: '4',
      GITHUB_APP_TASKMASTER_PRIVATE_KEY: privateKey,
      GH_TOKEN: 'user',
    };
    expect(resolveServiceGitHubAuth('duty_officer', env).poolId).toBe('app-3-4');
    // Builder lanes never borrow the Taskmaster alias; with no own App they use the PAT.
    for (const service of ['smart_cauldron', 'run_nodes'] as const) {
      const identity = resolveServiceGitHubAuth(service, env);
      expect(identity.kind).toBe('pat');
      expect(identity.poolId).toBe('user-pat');
    }
    expect(() =>
      resolveServiceGitHubAuth('taskmaster', { GITHUB_APP_TASKMASTER_ID: '3', GH_TOKEN: 'user' })
    ).toThrow('GITHUB_APP_TASKMASTER_INSTALLATION_ID');
  });

  it('Test 1: builder services never borrow the shared or taskmaster App', () => {
    const reviewerOnly = {
      GITHUB_APP_ID: '1',
      GITHUB_APP_INSTALLATION_ID: '2',
      GITHUB_APP_PRIVATE_KEY: privateKey,
      GH_TOKEN: 'user',
    };
    const taskmasterOnly = {
      GITHUB_APP_TASKMASTER_ID: '3',
      GITHUB_APP_TASKMASTER_INSTALLATION_ID: '4',
      GITHUB_APP_TASKMASTER_PRIVATE_KEY: privateKey,
      GH_TOKEN: 'user',
    };
    for (const env of [reviewerOnly, taskmasterOnly]) {
      for (const service of ['run_nodes', 'smart_cauldron'] as const) {
        const identity = resolveServiceGitHubAuth(service, env);
        expect(identity.kind).toBe('pat');
        expect(identity.poolId).toBe('user-pat');
      }
    }
    expect(SERVICE_GITHUB_AUTH_PRECEDENCE.run_nodes).toEqual(['service_app', 'pat']);
    expect(SERVICE_GITHUB_AUTH_PRECEDENCE.smart_cauldron).toEqual(['service_app', 'pat']);
  });

  it('Test 2: a builder App equal to the reviewer App throws', () => {
    const envA = {
      GITHUB_APP_ID: '1',
      GITHUB_APP_INSTALLATION_ID: '2',
      GITHUB_APP_PRIVATE_KEY: privateKey,
      GITHUB_APP_RUN_NODES_ID: '1',
      GITHUB_APP_RUN_NODES_INSTALLATION_ID: '99',
      GITHUB_APP_RUN_NODES_PRIVATE_KEY: privateKey,
    };
    expect(() => resolveServiceGitHubAuth('run_nodes', envA)).toThrow(
      /^builder_identity_equals_reviewer/
    );
    const envB = {
      GITHUB_APP_OVERSEER_ID: '7',
      GITHUB_APP_OVERSEER_INSTALLATION_ID: '8',
      GITHUB_APP_OVERSEER_PRIVATE_KEY: privateKey,
      GITHUB_APP_SMART_CAULDRON_ID: '7',
      GITHUB_APP_SMART_CAULDRON_INSTALLATION_ID: '9',
      GITHUB_APP_SMART_CAULDRON_PRIVATE_KEY: privateKey,
    };
    expect(() => resolveServiceGitHubAuth('smart_cauldron', envB)).toThrow(
      /^builder_identity_equals_reviewer/
    );
  });

  it('Test 3: own builder App resolves and other services are unchanged', () => {
    const env = {
      GITHUB_APP_ID: '1',
      GITHUB_APP_INSTALLATION_ID: '2',
      GITHUB_APP_PRIVATE_KEY: privateKey,
      GITHUB_APP_RUN_NODES_ID: '5',
      GITHUB_APP_RUN_NODES_INSTALLATION_ID: '6',
      GITHUB_APP_RUN_NODES_PRIVATE_KEY: privateKey,
      GITHUB_APP_TASKMASTER_ID: '3',
      GITHUB_APP_TASKMASTER_INSTALLATION_ID: '4',
      GITHUB_APP_TASKMASTER_PRIVATE_KEY: privateKey,
      GH_TOKEN: 'user',
    };
    const runNodes = resolveServiceGitHubAuth('run_nodes', env);
    expect(runNodes.kind).toBe('app');
    expect(runNodes.poolId).toBe('app-5-6');
    expect(runNodes.distinct).toBe(true);
    expect(resolveServiceGitHubAuth('taskmaster', env).poolId).toBe('app-3-4');
    expect(resolveServiceGitHubAuth('duty_officer', env).poolId).toBe('app-3-4');
    expect(resolveServiceGitHubAuth('overseer', env).poolId).toBe('app-1-2');
  });

  it('holds merge when no distinct identity exists', () => {
    expect(resolveServiceGitHubAuth('merge_manager', { GH_TOKEN: 'user' })).toEqual({
      kind: 'none',
      service: 'merge_manager',
      poolId: 'none',
      distinct: false,
    });
  });
  it('holds a merge App matching the effective reviewer, including another installation', () => {
    const shared = {
      GITHUB_APP_ID: '1',
      GITHUB_APP_INSTALLATION_ID: '2',
      GITHUB_APP_PRIVATE_KEY: privateKey,
    };
    for (const installation of ['2', '99']) {
      expect(
        resolveServiceGitHubAuth('merge_manager', {
          ...shared,
          GITHUB_APP_MERGE_MANAGER_ID: '1',
          GITHUB_APP_MERGE_MANAGER_INSTALLATION_ID: installation,
          GITHUB_APP_MERGE_MANAGER_PRIVATE_KEY: privateKey,
        }).distinct
      ).toBe(false);
    }
    expect(
      resolveServiceGitHubAuth('merge_manager', {
        ...shared,
        GITHUB_APP_OVERSEER_ID: '3',
        GITHUB_APP_OVERSEER_INSTALLATION_ID: '4',
        GITHUB_APP_OVERSEER_PRIVATE_KEY: privateKey,
        GITHUB_APP_MERGE_MANAGER_ID: '1',
        GITHUB_APP_MERGE_MANAGER_INSTALLATION_ID: '2',
        GITHUB_APP_MERGE_MANAGER_PRIVATE_KEY: privateKey,
      }).distinct
    ).toBe(true);
  });
});

it('Test 3: refreshes a nearly expired token with one concurrent mint', async () => {
  const identity = {
    kind: 'app' as const,
    service: 'taskmaster' as const,
    appId: 'single-flight',
    installationId: '42',
    privateKey,
    poolId: 'app-single-flight-42',
    distinct: true as const,
  };
  const now = Date.now();
  let mints = 0;
  const fetchImpl = (async () => {
    mints += 1;
    return Response.json({
      token: `token-${mints}`,
      expires_at: new Date(now + (mints === 1 ? 5 * 60_000 : 60 * 60_000)).toISOString(),
    });
  }) as typeof fetch;
  expect(await getServiceGitHubToken(identity, { fetch: fetchImpl, now: () => now })).toBe(
    'token-1'
  );
  const [first, second] = await Promise.all([
    getServiceGitHubToken(identity, { fetch: fetchImpl, now: () => now }),
    getServiceGitHubToken(identity, { fetch: fetchImpl, now: () => now }),
  ]);
  expect(first).toBe('token-2');
  expect(second).toBe('token-2');
  expect(mints).toBe(2);
});
