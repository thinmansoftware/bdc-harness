/**
 * Lane subprocess env/argv helpers for Cauldron builder lanes
 * (WO-HARNESS-APP-KEY-ISOLATION-01).
 *
 * The implementations live in @archon/paths because packages/git/src/exec.ts
 * (@archon/git) and the providers (@archon/providers) must call them too, and
 * neither package may import @archon/core (core already depends on git, so a
 * core import from git would be a dependency cycle). @archon/paths is the shared
 * leaf package that every consumer already depends on.
 *
 * This file is the @archon/core/github/lane-env entry point named by the WO:
 * lane callers in @archon/core and @archon/workflows import from here, while
 * @archon/git and @archon/providers import the same functions directly from
 * @archon/paths.
 */
export {
  buildLaneSubprocessEnv,
  laneSpawnArgv,
  laneSpawnActive,
  laneExecPath,
  laneUidIsolationEnabled,
  LANE_HOME,
  DEFAULT_LANE_EXEC_PATH,
} from '@archon/paths';
