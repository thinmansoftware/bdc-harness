import { afterEach, describe, expect, it } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { clearServiceGitHubTokenCache, resolveServiceGitHubAuth } from './service-identity';

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
    for (const service of ['taskmaster', 'duty_officer', 'smart_cauldron', 'run_nodes'] as const) {
      expect(resolveServiceGitHubAuth(service, env).poolId).toBe('app-1-2');
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
    expect(resolveServiceGitHubAuth('smart_cauldron', env).poolId).toBe('app-3-4');
    expect(resolveServiceGitHubAuth('run_nodes', env).poolId).toBe('app-3-4');
    expect(() =>
      resolveServiceGitHubAuth('taskmaster', { GITHUB_APP_TASKMASTER_ID: '3', GH_TOKEN: 'user' })
    ).toThrow('GITHUB_APP_TASKMASTER_INSTALLATION_ID');
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
