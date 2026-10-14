import { describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { GITHUB_SERVICES, resolveServiceGitHubAuth } from './service-identity';
const pem = generateKeyPairSync('rsa', {
  modulusLength: 1024,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;
const shared = {
  GITHUB_APP_ID: '1',
  GITHUB_APP_INSTALLATION_ID: '10',
  GITHUB_APP_PRIVATE_KEY: pem,
  GH_TOKEN: 'user',
  MERGE_MANAGER_GH_TOKEN: 'merge',
};
describe('Test 2: explicit precedence, separation, and activation', () => {
  test('state A preserves identities', () => {
    expect(resolveServiceGitHubAuth('overseer', { env: shared }).poolId).toBe('app-1-10');
    expect(resolveServiceGitHubAuth('pr_discovery', { env: shared }).poolId).toBe('app-1-10');
    expect(resolveServiceGitHubAuth('merge_manager', { env: shared }).poolId).toBe(
      'merge-manager-pat'
    );
    for (const service of ['taskmaster', 'duty_officer', 'smart_cauldron', 'run_nodes'] as const)
      expect(resolveServiceGitHubAuth(service, { env: shared }).poolId).toBe('user-pat');
  });
  test('alias, override, partial trio, and merge HOLD', () => {
    const alias = {
      ...shared,
      GITHUB_APP_TASKMASTER_ID: '2',
      GITHUB_APP_TASKMASTER_INSTALLATION_ID: '20',
      GITHUB_APP_TASKMASTER_PRIVATE_KEY: pem,
    };
    for (const service of ['taskmaster', 'duty_officer', 'smart_cauldron', 'run_nodes'] as const)
      expect(resolveServiceGitHubAuth(service, { env: alias }).poolId).toBe('app-2-20');
    expect(resolveServiceGitHubAuth('merge_manager', { env: alias }).poolId).toBe(
      'merge-manager-pat'
    );
    expect(() =>
      resolveServiceGitHubAuth('taskmaster', { env: { GITHUB_APP_TASKMASTER_ID: '2' } })
    ).toThrow('GITHUB_APP_TASKMASTER_INSTALLATION_ID');
    expect(
      resolveServiceGitHubAuth('merge_manager', { env: shared, readFile: () => '' }).kind
    ).toBe('pat');
    const noMerge = { ...shared };
    delete (noMerge as Partial<typeof shared>).MERGE_MANAGER_GH_TOKEN;
    expect(resolveServiceGitHubAuth('merge_manager', { env: noMerge })).toEqual({
      kind: 'none',
      poolId: 'none',
      distinct: false,
    });
    expect(GITHUB_SERVICES).toHaveLength(7);
  });
});
