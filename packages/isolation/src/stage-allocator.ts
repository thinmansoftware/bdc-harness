/**
 * Stage Allocator -- Multi-stage Cauldron pipeline substrate
 *
 * WO-CAULDRON-MULTI-STAGE-PIPELINE-01 (2026-06-09)
 *
 * Allocates ONE worktree per stage of a multi-stage pipeline (connect=2, storefront=4, future=N).
 *
 * Branch naming is deterministic and STABLE across workflow re-fires for the same
 * (woId, stageId) pair: `archon/<woId>/<stageId>`. No run-id suffix -- this is the
 * idempotency contract required by spec C5 ("re-fires UPDATE the same stage branch
 * -- NO duplicate-PR spray").
 *
 * Composition (not modification): this module calls the public `@archon/git` worktree
 * primitives directly rather than extending `WorktreeProvider`'s discriminated
 * `IsolationRequest` union with a new `stage` workflow type. Rationale:
 *   - `WorktreeProvider.generateBranchName()` slugifies / hashes identifiers and
 *     prepends `task-` / `thread-` etc.; none of those derivations produce the
 *     exact `archon/<woId>/<stageId>` shape spec C5 mandates.
 *   - Adding a `stage` variant would touch `IsolationRequest`, `generateBranchName`,
 *     and `createNewBranch` -- a wider surface change than the plan authorizes
 *     ("No modifications to WorktreeProvider internals").
 * This file reuses the same low-level git helpers (`syncWorkspace`, `getWorktreeBase`,
 * `worktreeExists`, `getCanonicalRepoPath`, `execFileAsync`) so behavior stays in
 * lock-step with WorktreeProvider for the operations we share.
 *
 * Idempotency: if the stage branch already exists at the resolved worktree path,
 * the existing worktree is adopted only after repo ownership and exact branch
 * identity are verified (re-fire update path). If the branch exists but
 * the worktree is missing (e.g. cleaned up between fires), the branch is reused
 * and a fresh worktree is created on it -- the branch's commits are preserved so
 * the same PR is updated. If neither exists, both are created fresh from
 * `target_branch` on origin.
 */

import { join, resolve } from 'path';

import {
  execFileAsync,
  getCanonicalRepoPath,
  getWorktreeBase,
  listWorktrees,
  mkdirAsync,
  syncWorkspace,
  toBranchName,
  toRepoPath,
  toWorktreePath,
  verifyWorktreeOwnership,
  worktreeExists,
} from '@archon/git';
import type { RepoPath } from '@archon/git';
import { createLogger } from '@archon/paths';

import type { RepoConfigLoader } from './types';

/**
 * Subprocess ceiling for git worktree ops in the stage allocator. Matches the
 * WorktreeProvider ceiling (5 min) so behavior is consistent across the two
 * allocation paths.
 */
const GIT_OPERATION_TIMEOUT_MS = 5 * 60 * 1000;

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('isolation.stage-allocator');
  return cachedLog;
}

/**
 * Inputs for allocating a single stage's worktree.
 *
 * Resolution contract:
 *   - `canonicalRepoPath` MUST be the resolved main checkout for the stage's repo
 *     (NOT a worktree). The caller (the preflight-repo-registry node in
 *     `bdc-multi-stage-development.yaml`) resolves this from the codebase registry
 *     and threads it forward via `stages-enriched.json`.
 *   - `codebaseName` is the owner/repo string used by `getWorktreeBase()` to compute
 *     the workspace-scoped base path.
 *   - `codebaseId` is the Archon codebase database ID -- recorded in the result for
 *     downstream artifact tracking. The allocator itself does not consult the DB.
 *   - `targetBranch` is the stage's `target_branch` from the WO spec. It is the
 *     start-point on origin for NEW branch creation. For existing-branch adoption
 *     it is informational only (the branch's commits are preserved).
 */
export interface StageWorktreeOpts {
  /** WO identifier (e.g. "WO-CONNECT-MANUAL-AND-UI-01") */
  woId: string;
  /** Stage identifier (e.g. "backend", "ui", "infra") */
  stageId: string;
  /** Codebase database ID (informational; threaded into result) */
  codebaseId: string;
  /** owner/repo string (e.g. "bluedevilcollectibles/shopops") */
  codebaseName: string;
  /** Absolute, resolved path to the main repo checkout */
  canonicalRepoPath: string;
  /** Stage's target_branch from the WO spec (e.g. "staging", "dev") */
  targetBranch: string;
}

/**
 * Result of allocating a single stage's worktree.
 *
 * `adopted: true` means the worktree existed at the resolved path before this call
 * (re-fire update path). `adopted: false` means a new worktree was created in this
 * call. Either way, the worktree is ready for build operations.
 */
export interface StageWorktreeResult {
  stageId: string;
  branchName: string;
  worktreePath: string;
  codebaseId: string;
  /** Immutable origin/<targetBranch> authority captured before allocation. */
  baseSha: string;
  adopted: boolean;
}

/**
 * Derive the deterministic stage branch name.
 *
 * Shape: `archon/<woId>/<stageId>` -- STABLE across re-fires. Exported so the
 * workflow YAML (or future engine integration) can compute the same name without
 * re-implementing the rule.
 *
 * No run-id suffix: spec C5 mandates "re-fires UPDATE the same stage branch -- NO
 * duplicate-PR spray". Including run-id would break this contract.
 */
export function deriveStageBranchName(woId: string, stageId: string): string {
  if (!woId) throw new Error('deriveStageBranchName: woId required');
  if (!stageId) throw new Error('deriveStageBranchName: stageId required');
  return `archon/${woId}/${stageId}`;
}

/**
 * Allocate a stage worktree.
 *
 * Behavior:
 *   1. Fetch `targetBranch` without resetting the canonical checkout, then freeze
 *      its full origin commit SHA as this stage's immutable base authority.
 *   2. Compute the workspace-scoped worktree path: `<base>/archon/<woId>/<stageId>`.
 *   3. If a worktree already exists at the path, verify its canonical repo owner
 *      and exact deterministic branch before returning `adopted: true`.
 *   4. Otherwise create the worktree. If the branch already exists (worktree was
 *      cleaned up but the branch survived), reuse the branch's commits and attach
 *      a new worktree to it. If the branch does not exist, create it from
 *      `origin/<targetBranch>`.
 *
 * @throws Error on sync failure or unrecoverable git errors.
 */
export async function createStageWorktree(
  opts: StageWorktreeOpts,
  loadConfig: RepoConfigLoader = () => Promise.resolve(null)
): Promise<StageWorktreeResult> {
  const { woId, stageId, codebaseId, codebaseName, canonicalRepoPath, targetBranch } = opts;

  if (!canonicalRepoPath) {
    throw new Error('createStageWorktree: canonicalRepoPath required');
  }
  if (!codebaseName) {
    throw new Error('createStageWorktree: codebaseName required');
  }
  if (!targetBranch) {
    throw new Error('createStageWorktree: targetBranch required');
  }

  const branchName = deriveStageBranchName(woId, stageId);
  const repoPath = toRepoPath(canonicalRepoPath);

  // Load repo config (best-effort) so we keep parity with WorktreeProvider's
  // "load once, fail loudly" contract. Failures are logged but non-fatal -- the
  // stage allocator only uses default layout here; per-repo `worktree.path`
  // overrides are not yet wired in (deferred to follow-up if needed). Eagerly
  // loading still catches config corruption early so the operator sees it.
  try {
    await loadConfig(canonicalRepoPath);
  } catch (error) {
    const err = error as Error;
    getLog().warn(
      { err, canonicalRepoPath, woId, stageId },
      'stage_allocator.repo_config_load_failed'
    );
    // Continue -- default layout still works.
  }

  // Fetch target authority without resetting or checking out the canonical repo.
  // The main checkout may contain operator work and is never an allocator scratchpad.
  try {
    await syncWorkspace(repoPath, toBranchName(targetBranch), { resetAfterFetch: false });
  } catch (error) {
    const err = error as Error;
    getLog().error(
      { err, canonicalRepoPath, targetBranch, woId, stageId },
      'stage_allocator.sync_failed'
    );
    throw new Error(
      `Stage allocator: failed to sync ${canonicalRepoPath} on ${targetBranch}: ${err.message}`
    );
  }

  const { stdout: baseStdout } = await execFileAsync(
    'git',
    ['-C', repoPath, 'rev-parse', `origin/${targetBranch}^{commit}`],
    { timeout: GIT_OPERATION_TIMEOUT_MS }
  );
  const baseSha = baseStdout.trim();
  if (!/^[0-9a-f]{40}$/.test(baseSha)) {
    throw new Error(`Stage allocator: origin/${targetBranch} did not resolve to a full commit SHA`);
  }

  const { base: worktreeBase } = getWorktreeBase(repoPath, codebaseName);
  const worktreePath = join(worktreeBase, branchName);

  // Adopt if worktree already exists at the expected path (re-fire update path).
  if (await worktreeExists(toWorktreePath(worktreePath))) {
    await verifyWorktreeOwnership(toWorktreePath(worktreePath), repoPath);
    const registered = (await listWorktrees(repoPath)).find(
      worktree => resolve(worktree.path) === resolve(worktreePath)
    );
    if (registered?.branch !== branchName) {
      throw new Error(
        `Cannot adopt ${worktreePath}: expected branch ${branchName}, ` +
          `found ${registered?.branch ?? 'unregistered worktree'}.`
      );
    }
    getLog().info(
      { worktreePath, branchName, woId, stageId, codebaseId },
      'stage_allocator.worktree_adopted'
    );
    return {
      stageId,
      branchName,
      worktreePath,
      codebaseId,
      baseSha,
      adopted: true,
    };
  }

  // Ensure the worktree base directory exists (mkdir -p).
  await mkdirAsync(worktreeBase, { recursive: true });

  await createWorktreeAt(repoPath, worktreePath, branchName, targetBranch, {
    woId,
    stageId,
    codebaseId,
  });

  getLog().info(
    { worktreePath, branchName, woId, stageId, codebaseId },
    'stage_allocator.worktree_created'
  );

  return {
    stageId,
    branchName,
    worktreePath,
    codebaseId,
    baseSha,
    adopted: false,
  };
}

/**
 * Create the actual worktree. Handles the "branch already exists" path by
 * attaching to the existing branch (preserves prior stage commits for re-fires).
 *
 * Does NOT reset the branch to start-point on the "exists" path -- that would
 * destroy in-progress stage commits we want to preserve across re-fires. This is
 * the deliberate difference from WorktreeProvider.createNewBranch (which resets
 * to start-point for task workflows). Stage branches are long-lived PR branches,
 * not throwaway task branches.
 *
 * @param logCtx - Context fields included in log entries (woId, stageId, codebaseId)
 *                 -- typed loosely because they are pure logging payload.
 */
async function createWorktreeAt(
  repoPath: RepoPath,
  worktreePath: string,
  branchName: string,
  targetBranch: string,
  logCtx: { woId: string; stageId: string; codebaseId: string }
): Promise<void> {
  const startPoint = `origin/${targetBranch}`;

  try {
    // Try to create with new branch from origin/<targetBranch>.
    await execFileAsync(
      'git',
      ['-C', repoPath, 'worktree', 'add', worktreePath, '-b', branchName, startPoint],
      { timeout: GIT_OPERATION_TIMEOUT_MS }
    );
    return;
  } catch (error) {
    const err = error as Error & { stderr?: string };
    const stderr = err.stderr ?? '';

    if (!stderr.includes('already exists')) {
      getLog().error(
        { err, worktreePath, branchName, ...logCtx },
        'stage_allocator.worktree_create_failed'
      );
      throw err;
    }

    // Branch already exists -- attach to it WITHOUT resetting (preserve commits).
    // This is the re-fire path when a prior stage build advanced the branch but
    // the worktree was cleaned up.
    getLog().info(
      { worktreePath, branchName, ...logCtx },
      'stage_allocator.attaching_existing_branch'
    );
    try {
      await execFileAsync('git', ['-C', repoPath, 'worktree', 'add', worktreePath, branchName], {
        timeout: GIT_OPERATION_TIMEOUT_MS,
      });
    } catch (attachError) {
      const aErr = attachError as Error;
      getLog().error(
        { err: attachError, worktreePath, branchName, ...logCtx },
        'stage_allocator.worktree_attach_failed'
      );
      throw new Error(
        `Stage allocator: branch ${branchName} exists but could not attach a worktree at ${worktreePath}: ${aErr.message}`
      );
    }
  }
}

/**
 * Resolve the canonical repo path from a possibly-worktree path. Thin re-export
 * convenience for callers that only have a worktree path in hand (e.g. workflow
 * nodes whose CWD is inside a worktree).
 *
 * Returns the canonical repo path (suitable for `createStageWorktree.canonicalRepoPath`).
 */
export async function resolveStageRepoPath(possiblePath: string): Promise<string> {
  if (!possiblePath) {
    throw new Error('resolveStageRepoPath: path required');
  }
  return await getCanonicalRepoPath(possiblePath);
}
