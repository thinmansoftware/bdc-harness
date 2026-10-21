/**
 * Lane subprocess isolation helpers (WO-HARNESS-APP-KEY-ISOLATION-01).
 *
 * A Cauldron builder lane runs untrusted, AI-authored code. It must NOT be able
 * to act as the Overseer (reviewer) App, the merge manager, or the operator, and
 * it must not inherit the reviewer/merge/PAT material that lives in the server
 * process environment.
 *
 * Two primitives:
 *
 * 1. buildLaneSubprocessEnv(env): returns a copy of `env` with every
 *    reviewer / merge-manager / PAT / operator credential removed, the Builder 2
 *    (run_nodes) App material kept, ARCHON_GITHUB_SERVICE forced to run_nodes,
 *    and HOME repointed at the lane user's home. This is what a lane subprocess
 *    is allowed to see.
 *
 * 2. laneSpawnArgv(argv): when UID isolation is enabled and the setuid launcher
 *    exists on disk, prefixes the launcher so the spawned process drops to the
 *    unprivileged lane UID. In local dev (no image, no launcher) it returns the
 *    argv unchanged so `bun run dev` and the test suite still work.
 *
 * These live in @archon/paths -- the shared leaf package that @archon/git,
 * @archon/providers, @archon/workflows and @archon/core all depend on -- because
 * packages/git/src/exec.ts and the providers must call them and neither may
 * depend on @archon/core (core already depends on git, so a core import would be
 * a dependency cycle). @archon/core/github/lane-env re-exports them so lane
 * callers inside core/workflows have one obvious import site.
 */
import { existsSync } from 'node:fs';

type Env = Record<string, string | undefined>;

/** Lane user home. The entrypoint seeds it from /home/appuser without copying
 * credentials (no .git-credentials, no gh hosts.yml). */
export const LANE_HOME = '/home/laneuser';

/** Default absolute path of the setuid launcher installed in the image. */
export const DEFAULT_LANE_EXEC_PATH = '/usr/local/bin/archon-lane-exec';

/**
 * Service-scoped App credential prefixes that belong to the reviewer, merge
 * manager, or other non-builder identities. Every env key beginning with one of
 * these is stripped from a lane. GITHUB_APP_RUN_NODES_* (Builder 2) is kept --
 * lanes ARE Builder 2, so they keep self-minting Builder 2 tokens.
 */
const REVIEWER_MERGE_SERVICE_PREFIXES = [
  'GITHUB_APP_OVERSEER_',
  'GITHUB_APP_PR_DISCOVERY_',
  'GITHUB_APP_MERGE_MANAGER_',
  'GITHUB_APP_TASKMASTER_',
  'GITHUB_APP_DUTY_OFFICER_',
  'GITHUB_APP_SMART_CAULDRON_',
];

/** Exact env keys stripped from a lane: the bare reviewer App, every PAT, and
 * the operator / merge-authorization tokens. */
const EXACT_DROP_KEYS = new Set([
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

/**
 * Build the environment a lane subprocess is allowed to inherit. Strips every
 * reviewer / merge / PAT / operator credential, keeps GITHUB_APP_RUN_NODES_*,
 * forces ARCHON_GITHUB_SERVICE=run_nodes, repoints HOME at the lane home, and
 * drops any GIT_CONFIG_GLOBAL override that points into the server's home (so a
 * lane cannot be handed a gitconfig that reaches appuser's credential helper).
 */
export function buildLaneSubprocessEnv(env: Env = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (EXACT_DROP_KEYS.has(key)) continue;
    if (REVIEWER_MERGE_SERVICE_PREFIXES.some(prefix => key.startsWith(prefix))) continue;
    if (key === 'GIT_CONFIG_GLOBAL' && value.includes('/home/appuser')) continue;
    out[key] = value;
  }
  out.ARCHON_GITHUB_SERVICE = 'run_nodes';
  out.HOME = LANE_HOME;
  return out;
}

/** UID isolation is on unless explicitly disabled with ARCHON_LANE_UID_ISOLATION=0. */
export function laneUidIsolationEnabled(env: Env = process.env): boolean {
  return env.ARCHON_LANE_UID_ISOLATION !== '0';
}

/** Resolve the launcher path (ARCHON_LANE_EXEC_PATH override, else the default). */
export function laneExecPath(env: Env = process.env): string {
  const override = env.ARCHON_LANE_EXEC_PATH?.trim();
  return override ? override : DEFAULT_LANE_EXEC_PATH;
}

/**
 * True when lane UID isolation is both enabled and actually usable (the launcher
 * is present on disk). Callers that cannot cheaply inspect a rewritten argv (e.g.
 * SDKs that only accept a single executable path) use this to decide whether to
 * scrub the environment and route through the launcher.
 */
export function laneSpawnActive(
  opts: { env?: Env; exists?: (path: string) => boolean } = {}
): boolean {
  const env = opts.env ?? process.env;
  if (!laneUidIsolationEnabled(env)) return false;
  const exists = opts.exists ?? existsSync;
  return exists(laneExecPath(env));
}

/**
 * Prefix the setuid launcher onto an argv so the spawned process drops to the
 * lane UID. Returns argv unchanged when isolation is disabled or the launcher is
 * not present (local dev / CI without the built image), so callers can wire this
 * unconditionally.
 */
export function laneSpawnArgv(
  argv: string[],
  opts: { env?: Env; exists?: (path: string) => boolean } = {}
): string[] {
  if (argv.length === 0) return argv;
  const env = opts.env ?? process.env;
  if (!laneUidIsolationEnabled(env)) return argv;
  const launcher = laneExecPath(env);
  const exists = opts.exists ?? existsSync;
  if (!exists(launcher)) return argv;
  return [launcher, ...argv];
}
