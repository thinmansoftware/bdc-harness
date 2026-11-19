/**
 * Environment for processes that run agent- or workflow-authored code ("lanes").
 *
 * The harness container holds a personal GitHub token for a human account (the same
 * string under GH_TOKEN, GITHUB_TOKEN, MERGE_MANAGER_GH_TOKEN and two aliases). Server
 * code needs it (the merge manager, the permission fallback); a lane does not: its `gh`
 * calls go through the merge-guard shim as the builder-2 App, and its `git push` uses
 * the builder-2 credential helper. A lane that inherits the token can act as the human
 * account, so lane children get an environment without any of these names (bdc-xo#5464).
 *
 * The server's own process environment is unchanged and still readable from /proc by the
 * lane uid until the lane uid split ships; this narrows only what a lane inherits.
 */

/** Every name that carries (or points to a fallback for) the personal GitHub token. */
export const PERSONAL_TOKEN_ENV_NAMES = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'MERGE_MANAGER_GH_TOKEN',
  'GH_AUTH_TOKEN_INTERNAL',
  'ARCHON_GITHUB_PERMISSION_FALLBACK_TOKEN',
] as const;

/** Remove the personal-token names from an environment object (returns a copy). */
export function stripPersonalTokens<T extends Record<string, string | undefined>>(env: T): T {
  const drop = new Set<string>(PERSONAL_TOKEN_ENV_NAMES);
  return Object.fromEntries(Object.entries(env).filter(([name]) => !drop.has(name))) as T;
}

/**
 * The environment a lane child starts with: the base environment without the personal
 * token names, and with the GitHub permission fallback switched off, so an App 403 fails
 * closed instead of silently retrying as a user.
 */
export function laneEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...stripPersonalTokens(base), ARCHON_GITHUB_NO_PERMISSION_FALLBACK: '1' };
}
