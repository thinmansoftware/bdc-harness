// Archon path resolution utilities
export {
  expandTilde,
  isDocker,
  getArchonHome,
  getArchonWorkspacesPath,
  ensureArchonWorkspacesPath,
  getArchonWorktreesPath,
  getArchonConfigPath,
  getArchonEnvPath,
  getRepoArchonEnvPath,
  getHomeWorkflowsPath,
  getHomeCommandsPath,
  getHomeScriptsPath,
  getLegacyHomeWorkflowsPath,
  getCommandFolderSearchPaths,
  getWorkflowFolderSearchPaths,
  getAppArchonBasePath,
  getDefaultCommandsPath,
  getDefaultWorkflowsPath,
  logArchonPaths,
  validateAppDefaultsPaths,
  parseOwnerRepo,
  getProjectRoot,
  getProjectSourcePath,
  getProjectWorktreesPath,
  getProjectArtifactsPath,
  getProjectLogsPath,
  getRunArtifactsPath,
  getRunLogPath,
  resolveProjectRootFromCwd,
  ensureProjectStructure,
  createProjectSourceSymlink,
  findMarkdownFilesRecursive,
  getWebDistDir,
} from './archon-paths';

// Lane subprocess isolation (WO-HARNESS-APP-KEY-ISOLATION-01)
export {
  buildLaneSubprocessEnv,
  laneSpawnArgv,
  laneSpawnActive,
  laneExecPath,
  laneUidIsolationEnabled,
  LANE_HOME,
  DEFAULT_LANE_EXEC_PATH,
} from './lane-env';

// Logger
export { createLogger, setLogLevel, getLogLevel, rootLogger } from './logger';
export type { Logger } from './logger';

// Build-time constants (rewritten by scripts/build-binaries.sh)
export { BUNDLED_IS_BINARY, BUNDLED_VERSION, BUNDLED_GIT_COMMIT } from './bundled-build';

// Update check
export {
  checkForUpdate,
  getCachedUpdateCheck,
  isNewerVersion,
  parseLatestRelease,
} from './update-check';
export type { UpdateCheckResult } from './update-check';

// Anonymous telemetry
export { captureWorkflowInvoked, shutdownTelemetry, isTelemetryDisabled } from './telemetry';
export type { WorkflowInvokedProperties } from './telemetry';
