import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildLaneSubprocessEnv,
  laneExecPath,
  laneSpawnArgv,
  laneUidIsolationEnabled,
} from './lane-env';
import { resolveServiceGitHubAuth } from './service-identity';

function testPem(): string {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  }).privateKey;
}

describe('buildLaneSubprocessEnv (Test 1: drops reviewer and PAT material)', () => {
  test('strips reviewer/merge/PAT/operator names, keeps RUN_NODES, forces service + HOME', () => {
    const env = {
      GITHUB_APP_ID: '4574893',
      GITHUB_APP_INSTALLATION_ID: '111',
      GITHUB_APP_PRIVATE_KEY_PATH: '/run/secrets/thinman-overseer.pem',
      GITHUB_APP_PRIVATE_KEY_HOST_PATH: '/opt/bdc/archon/secrets/overseer.pem',
      GITHUB_APP_MERGE_MANAGER_PRIVATE_KEY_PATH: '/run/secrets/thinman-mm.pem',
      GITHUB_APP_MERGE_MANAGER_ID: '222',
      GITHUB_APP_TASKMASTER_ID: '333',
      GITHUB_APP_SMART_CAULDRON_ID: '444',
      MERGE_MANAGER_GH_TOKEN: 'mm-pat-token-value-xxxxxxxxxxxxxxxxxxxx',
      GH_TOKEN: 'user-pat-token-value-xxxxxxxxxxxxxxxxxxxx',
      GITHUB_TOKEN: 'user-pat-token-value-xxxxxxxxxxxxxxxxxxxx',
      GH_AUTH_TOKEN_INTERNAL: 'internal-pat-xxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      ARCHON_GITHUB_PERMISSION_FALLBACK_TOKEN: 'fallback-xxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      ARCHON_OPERATOR_TOKEN: 'operator-xxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      ARCHON_ALLOW_PR_MERGE: '1',
      ARCHON_GITHUB_SERVICE: 'overseer',
      GITHUB_APP_RUN_NODES_ID: '5407122',
      GITHUB_APP_RUN_NODES_INSTALLATION_ID: '999',
      GITHUB_APP_RUN_NODES_PRIVATE_KEY_PATH: '/run/secrets/thinman-builder-2.pem',
      PATH: '/usr/bin',
    };

    const lane = buildLaneSubprocessEnv(env);

    for (const dropped of [
      'GITHUB_APP_ID',
      'GITHUB_APP_INSTALLATION_ID',
      'GITHUB_APP_PRIVATE_KEY_PATH',
      'GITHUB_APP_PRIVATE_KEY_HOST_PATH',
      'GITHUB_APP_MERGE_MANAGER_PRIVATE_KEY_PATH',
      'GITHUB_APP_MERGE_MANAGER_ID',
      'GITHUB_APP_TASKMASTER_ID',
      'GITHUB_APP_SMART_CAULDRON_ID',
      'MERGE_MANAGER_GH_TOKEN',
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'GH_AUTH_TOKEN_INTERNAL',
      'ARCHON_GITHUB_PERMISSION_FALLBACK_TOKEN',
      'ARCHON_OPERATOR_TOKEN',
      'ARCHON_ALLOW_PR_MERGE',
    ]) {
      expect(lane[dropped]).toBeUndefined();
    }

    expect(lane.GITHUB_APP_RUN_NODES_ID).toBe('5407122');
    expect(lane.GITHUB_APP_RUN_NODES_INSTALLATION_ID).toBe('999');
    expect(lane.GITHUB_APP_RUN_NODES_PRIVATE_KEY_PATH).toBe('/run/secrets/thinman-builder-2.pem');
    expect(lane.ARCHON_GITHUB_SERVICE).toBe('run_nodes');
    expect(lane.HOME).toBe('/home/laneuser');
    // Unrelated vars pass through untouched.
    expect(lane.PATH).toBe('/usr/bin');
  });

  test('drops a GIT_CONFIG_GLOBAL override that points into the server home', () => {
    const lane = buildLaneSubprocessEnv({
      GIT_CONFIG_GLOBAL: '/home/appuser/.gitconfig',
      ARCHON_LANE_KEEP: 'yes',
    });
    expect(lane.GIT_CONFIG_GLOBAL).toBeUndefined();
    expect(lane.ARCHON_LANE_KEEP).toBe('yes');
  });
});

describe('lane identity resolution (Test 2: still resolves Builder 2, reviewer unreachable)', () => {
  let dir: string;
  let pemPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lane-env-'));
    pemPath = join(dir, 'thinman-builder-2.pem');
    writeFileSync(pemPath, testPem());
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('run_nodes resolves to the Builder 2 App; overseer throws github_auth_missing', () => {
    const laneEnv = buildLaneSubprocessEnv({
      GITHUB_APP_ID: '4574893',
      GITHUB_APP_PRIVATE_KEY_PATH: '/run/secrets/thinman-overseer.pem',
      GH_TOKEN: 'user-pat-token-value-xxxxxxxxxxxxxxxxxxxx',
      GITHUB_TOKEN: 'user-pat-token-value-xxxxxxxxxxxxxxxxxxxx',
      ARCHON_GITHUB_SERVICE: 'overseer',
      GITHUB_APP_RUN_NODES_ID: '5407122',
      GITHUB_APP_RUN_NODES_INSTALLATION_ID: '999',
      GITHUB_APP_RUN_NODES_PRIVATE_KEY_PATH: pemPath,
    });

    const builder = resolveServiceGitHubAuth('run_nodes', laneEnv);
    expect(builder.kind).toBe('app');
    if (builder.kind === 'app') {
      expect(builder.appId).toBe('5407122');
    }

    expect(() => resolveServiceGitHubAuth('overseer', laneEnv)).toThrow('github_auth_missing');
  });
});

describe('laneSpawnArgv / isolation toggle', () => {
  test('prefixes the launcher when enabled and the launcher exists', () => {
    const argv = laneSpawnArgv(['bash', '/tmp/node.sh'], {
      env: { ARCHON_LANE_EXEC_PATH: '/custom/lane-exec' },
      exists: () => true,
    });
    expect(argv).toEqual(['/custom/lane-exec', 'bash', '/tmp/node.sh']);
  });

  test('default launcher path is /usr/local/bin/archon-lane-exec', () => {
    const argv = laneSpawnArgv(['git', 'status'], { env: {}, exists: () => true });
    expect(argv[0]).toBe('/usr/local/bin/archon-lane-exec');
  });

  test('returns argv unchanged when the launcher is absent (local dev / CI)', () => {
    const argv = laneSpawnArgv(['bash', '/tmp/node.sh'], { env: {}, exists: () => false });
    expect(argv).toEqual(['bash', '/tmp/node.sh']);
  });

  test('returns argv unchanged when isolation is disabled', () => {
    const argv = laneSpawnArgv(['bash', '/tmp/node.sh'], {
      env: { ARCHON_LANE_UID_ISOLATION: '0' },
      exists: () => true,
    });
    expect(argv).toEqual(['bash', '/tmp/node.sh']);
  });

  test('isolation flag + path helpers read env', () => {
    expect(laneUidIsolationEnabled({})).toBe(true);
    expect(laneUidIsolationEnabled({ ARCHON_LANE_UID_ISOLATION: '0' })).toBe(false);
    expect(laneExecPath({})).toBe('/usr/local/bin/archon-lane-exec');
    expect(laneExecPath({ ARCHON_LANE_EXEC_PATH: '/x/y' })).toBe('/x/y');
  });
});
