// Types
export type {
  RepoPath,
  BranchName,
  WorktreePath,
  GitResult,
  GitError,
  WorkspaceSyncResult,
  WorktreeInfo,
} from './types';
export { toRepoPath, toBranchName, toWorktreePath } from './types';

// Process and filesystem wrappers
export {
  execFileAsync,
  mkdirAsync,
  execOwnedProcessGroup,
  endProcessGroup,
  processGroupExists,
  setProcessGroupControlForTests,
  setWindowsOwnedTreeControlForTests,
  isTreeSurvivedError,
  TERMINATION_GRACE_MS,
  TERMINATION_CONFIRM_MS,
} from './exec';
export type {
  OwnedGroupExecOptions,
  OwnedGroupExecResult,
  ProcessGroupControl,
  WindowsOwnedTreeControl,
  TreeSurvivedError,
} from './exec';

// Worktree operations
export {
  extractOwnerRepo,
  getWorktreeBase,
  isProjectScopedWorktreeBase,
  worktreeExists,
  listWorktrees,
  findWorktreeByBranch,
  isWorktreePath,
  removeWorktree,
  getCanonicalRepoPath,
  verifyWorktreeOwnership,
} from './worktree';
export type { WorktreeLayout, WorktreeBaseOverride } from './worktree';

// Branch operations
export {
  getDefaultBranch,
  isValidBranchName,
  checkout,
  hasUncommittedChanges,
  commitAllChanges,
  isBranchMerged,
  isPatchEquivalent,
  isAncestorOf,
  getLastCommitDate,
} from './branch';

// Repository operations
export {
  findRepoRoot,
  getRemoteUrl,
  syncWorkspace,
  cloneRepository,
  syncRepository,
  addSafeDirectory,
} from './repo';
