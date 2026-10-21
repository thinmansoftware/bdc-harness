import { describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLaneSubprocessEnv, laneSpawnArgv } from './lane-env';
import { resolveServiceGitHubAuth } from './service-identity';

describe('lane subprocess environment', () => {
  test('lane_env_drops_reviewer_and_pat_material', () => {
    const env = buildLaneSubprocessEnv({
      GITHUB_APP_ID: 'reviewer',
      GITHUB_APP_PRIVATE_KEY_PATH: '/reviewer.pem',
      GITHUB_APP_MERGE_MANAGER_PRIVATE_KEY_PATH: '/merge.pem',
      MERGE_MANAGER_GH_TOKEN: 'pat',
      GH_TOKEN: 'pat',
      ARCHON_OPERATOR_TOKEN: 'operator',
      ARCHON_GITHUB_SERVICE: 'overseer',
      GITHUB_APP_RUN_NODES_ID: 'builder',
      GITHUB_APP_RUN_NODES_INSTALLATION_ID: 'installation',
      GITHUB_APP_RUN_NODES_PRIVATE_KEY_PATH: '/builder.pem',
      GIT_CONFIG_GLOBAL: '/home/appuser/.gitconfig',
    });
    expect(env.GITHUB_APP_ID).toBeUndefined();
    expect(env.GITHUB_APP_PRIVATE_KEY_PATH).toBeUndefined();
    expect(env.GITHUB_APP_MERGE_MANAGER_PRIVATE_KEY_PATH).toBeUndefined();
    expect(env.MERGE_MANAGER_GH_TOKEN).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.ARCHON_OPERATOR_TOKEN).toBeUndefined();
    expect(env.GIT_CONFIG_GLOBAL).toBeUndefined();
    expect(env.GITHUB_APP_RUN_NODES_ID).toBe('builder');
    expect(env.GITHUB_APP_RUN_NODES_INSTALLATION_ID).toBe('installation');
    expect(env.GITHUB_APP_RUN_NODES_PRIVATE_KEY_PATH).toBe('/builder.pem');
    expect(env.ARCHON_GITHUB_SERVICE).toBe('run_nodes');
    expect(env.HOME).toBe('/home/laneuser');
  });

  test('isolation can be disabled for local development', () => {
    const previous = process.env.ARCHON_LANE_UID_ISOLATION;
    process.env.ARCHON_LANE_UID_ISOLATION = '0';
    expect(laneSpawnArgv(['git', 'status'])).toEqual(['git', 'status']);
    if (previous === undefined) delete process.env.ARCHON_LANE_UID_ISOLATION;
    else process.env.ARCHON_LANE_UID_ISOLATION = previous;
  });

  test('lane_identity_still_resolves_builder_two', () => {
    const directory = mkdtempSync(join(tmpdir(), 'lane-env-'));
    try {
      const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
        type: 'pkcs8',
        format: 'pem',
      });
      const keyPath = join(directory, 'builder.pem');
      writeFileSync(keyPath, privateKey);
      const env = buildLaneSubprocessEnv({
        GITHUB_APP_ID: '4574893',
        GITHUB_APP_PRIVATE_KEY_PATH: '/reviewer.pem',
        GITHUB_APP_RUN_NODES_ID: '5407122',
        GITHUB_APP_RUN_NODES_INSTALLATION_ID: '99',
        GITHUB_APP_RUN_NODES_PRIVATE_KEY_PATH: keyPath,
      });
      expect(resolveServiceGitHubAuth('run_nodes', env)).toMatchObject({
        kind: 'app',
        appId: '5407122',
      });
      expect(() => resolveServiceGitHubAuth('overseer', env)).toThrow('github_auth_missing');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
