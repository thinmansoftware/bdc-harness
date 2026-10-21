import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';

export const LANE_HOME = '/home/laneuser';
export const LANE_LAUNCHER = '/usr/local/bin/archon-lane-exec';
const LANE_SHIM_DIRECTORY = '/tmp/archon-lane-sdk';

/** Test-only launcher probe. Production spawn paths keep LANE_LAUNCHER. */
let launcherPathForTests: string | undefined;

export function setLaneLauncherPathForTests(path: string | undefined): void {
  launcherPathForTests = path;
}

export function laneIsolationAvailable(): boolean {
  const launcher = launcherPathForTests ?? LANE_LAUNCHER;
  return process.env.ARCHON_LANE_UID_ISOLATION !== '0' && existsSync(launcher);
}

const DATABASE_CONNECTION_KEYS = new Set([
  'DATABASE_URL',
  'PGHOST',
  'PGHOSTADDR',
  'PGPORT',
  'PGUSER',
  'PGPASSWORD',
  'PGDATABASE',
  'PGPASSFILE',
  'PGSERVICE',
  'PGSERVICEFILE',
  'PGOPTIONS',
  'PGSSLMODE',
  'PGSSLKEY',
  'PGSSLCERT',
  'PGSSLROOTCERT',
  'PGSSLCRL',
  'SQLITE_PATH',
  'SQLITE_DATABASE',
]);

function isDatabaseCredential(key: string): boolean {
  return DATABASE_CONNECTION_KEYS.has(key) || key.includes('DATABASE');
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
  if (!laneIsolationAvailable()) {
    return { ...input };
  }
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
        !isDatabaseCredential(key) &&
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
  const currentUid = process.getuid?.();
  if (currentUid === undefined) {
    throw new Error('lane_sdk_shim_owner_unavailable');
  }
  try {
    mkdirSync(LANE_SHIM_DIRECTORY, { mode: 0o755 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const directoryStat = lstatSync(LANE_SHIM_DIRECTORY);
  if (
    !directoryStat.isDirectory() ||
    directoryStat.isSymbolicLink() ||
    directoryStat.uid !== currentUid ||
    (directoryStat.mode & 0o022) !== 0
  ) {
    throw new Error('lane_sdk_shim_directory_unsafe');
  }
  const wrapper = `${LANE_SHIM_DIRECTORY}/${digest}`;
  const quoted = executable.replaceAll("'", "'\\''");
  const contents = `#!/bin/sh\nexec '${LANE_LAUNCHER}' '${quoted}' "$@"\n`;
  try {
    writeFileSync(wrapper, contents, { mode: 0o755, flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const wrapperStat = lstatSync(wrapper);
    if (
      !wrapperStat.isFile() ||
      wrapperStat.isSymbolicLink() ||
      wrapperStat.uid !== currentUid ||
      (wrapperStat.mode & 0o022) !== 0 ||
      readFileSync(wrapper, 'utf8') !== contents
    ) {
      throw new Error('lane_sdk_shim_unsafe');
    }
  }
  return wrapper;
}
