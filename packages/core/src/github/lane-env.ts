import { chmodSync, existsSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';

export const LANE_HOME = '/home/laneuser';
export const LANE_LAUNCHER = '/usr/local/bin/archon-lane-exec';

export function laneIsolationAvailable(): boolean {
  return process.env.ARCHON_LANE_UID_ISOLATION !== '0' && existsSync(LANE_LAUNCHER);
}

const FORBIDDEN_SERVICES = [
  'OVERSEER',
  'PR_DISCOVERY',
  'MERGE_MANAGER',
  'TASKMASTER',
  'DUTY_OFFICER',
  'SMART_CAULDRON',
];

export function buildLaneSubprocessEnv(
  input: NodeJS.ProcessEnv | Record<string, string | undefined>
): NodeJS.ProcessEnv {
  const forbidden = new Set([
    'GITHUB_APP_PRIVATE_KEY',
    'GITHUB_APP_PRIVATE_KEY_PATH',
    'GITHUB_APP_PRIVATE_KEY_HOST_PATH',
    'GITHUB_APP_ID',
    'GITHUB_APP_INSTALLATION_ID',
    'MERGE_MANAGER_GH_TOKEN',
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'GH_AUTH_TOKEN_INTERNAL',
    'ARCHON_GITHUB_PERMISSION_FALLBACK_TOKEN',
    'ARCHON_OPERATOR_TOKEN',
    'ARCHON_ALLOW_PR_MERGE',
  ]);
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(input).filter(
      ([key]) =>
        !forbidden.has(key) &&
        !FORBIDDEN_SERVICES.some(service => key.startsWith(`GITHUB_APP_${service}_`))
    )
  );
  if (env.GIT_CONFIG_GLOBAL?.startsWith('/home/appuser')) delete env.GIT_CONFIG_GLOBAL;
  env.ARCHON_GITHUB_SERVICE = 'run_nodes';
  env.HOME = LANE_HOME;
  return env;
}

export function laneSpawnArgv(argv: string[]): string[] {
  if (!laneIsolationAvailable()) return argv;
  return [LANE_LAUNCHER, ...argv];
}

/** Build an executable shim for SDKs that accept a binary path but not an argv prefix. */
export function laneExecutablePath(executable: string | undefined): string | undefined {
  if (!executable || !laneIsolationAvailable()) {
    return executable;
  }
  const digest = createHash('sha256').update(executable).digest('hex').slice(0, 16);
  const wrapper = `/tmp/archon-lane-sdk-${digest}`;
  if (!existsSync(wrapper)) {
    const quoted = executable.replaceAll("'", "'\\''");
    writeFileSync(wrapper, `#!/bin/sh\nexec '${LANE_LAUNCHER}' '${quoted}' "$@"\n`, {
      mode: 0o755,
    });
    chmodSync(wrapper, 0o755);
  }
  return wrapper;
}
