/**
 * M-42 Slice 5 -- deterministic branch-mutation fixture boundary.
 *
 * This adapter performs an authorized REFRESH or REBASE of a controlled factory
 * branch against its exact canonical non-production base. In this WO it is a
 * fixture-only boundary: it never pushes, never talks to a real remote, and
 * performs no sandbox-provider mutation. Every low-level Git/worktree primitive
 * is injected via BranchMutationDepsV1 so this source file imports no Git
 * package and shells out to nothing -- the real (or sandbox) wiring is Slice 8's
 * responsibility.
 *
 * Contract: a conflict is never resolved here. applyRebase/applyRefresh either
 * return a clean rewrite or a conflict probe; the caller classifies and stops.
 */

/** Read-only observation of a controlled worktree at a point in time. */
export interface WorktreeObservationV1 {
  readonly clean: boolean;
  readonly current_branch: string;
  readonly head_sha: string;
  /** True only when the branch was created by controlled factory work. */
  readonly factory_owned: boolean;
}

/** Content signal a probe attaches to a code conflict for classification. */
export type RebaseConflictSignalV1 = 'whitespace' | 'logic' | 'none';

/** Result of a read-only trial rebase. Observation only -- no branch rewrite. */
export interface RebaseConflictProbeV1 {
  readonly conflicted: boolean;
  readonly conflict_paths: readonly string[];
  readonly conflict_signal: RebaseConflictSignalV1;
}

/** Outcome of an actual refresh/rebase against the exact base. */
export type BranchRewriteResultV1 =
  | {
      readonly status: 'rewritten';
      readonly new_head_sha: string;
      readonly new_tree_sha: string;
    }
  | { readonly status: 'conflict'; readonly probe: RebaseConflictProbeV1 };

/**
 * Injected worktree/Git primitive interface. Production wiring (real Git or a
 * bounded sandbox provider) is out of scope for this WO and Slice 8-owned.
 */
export interface BranchMutationDepsV1 {
  observeWorktree(input: {
    readonly worktree_path: string;
    readonly branch: string;
  }): Promise<WorktreeObservationV1>;
  countUniqueCommits(input: {
    readonly worktree_path: string;
    readonly base_sha: string;
    readonly head_sha: string;
  }): Promise<number>;
  probeRebase(input: {
    readonly worktree_path: string;
    readonly base_sha: string;
  }): Promise<RebaseConflictProbeV1>;
  applyRefresh(input: {
    readonly worktree_path: string;
    readonly base_sha: string;
  }): Promise<BranchRewriteResultV1>;
  applyRebase(input: {
    readonly worktree_path: string;
    readonly base_sha: string;
  }): Promise<BranchRewriteResultV1>;
  readTreeSha(input: { readonly worktree_path: string; readonly ref: string }): Promise<string>;
}

export type BranchMutationModeV1 = 'REFRESH' | 'REBASE';

export interface BranchMutationRequestV1 {
  readonly worktree_path: string;
  readonly branch: string;
  readonly base_sha: string;
  readonly old_head_sha: string;
  readonly mode: BranchMutationModeV1;
  readonly permit_id: string;
  readonly execution_id: string;
}

export type BranchMutationReceiptV1 =
  | {
      readonly adapter: 'fake-branch-mutation';
      readonly status: 'rewritten';
      readonly mode: BranchMutationModeV1;
      readonly old_head_sha: string;
      readonly new_head_sha: string;
      readonly new_tree_sha: string;
      readonly pushed: false;
      readonly permit_id: string;
      readonly execution_id: string;
    }
  | {
      readonly adapter: 'fake-branch-mutation';
      readonly status: 'conflict';
      readonly mode: BranchMutationModeV1;
      readonly old_head_sha: string;
      readonly conflict: RebaseConflictProbeV1;
      readonly pushed: false;
      readonly permit_id: string;
      readonly execution_id: string;
    };

export interface BranchMutationAdapterV1 {
  perform(request: BranchMutationRequestV1): Promise<BranchMutationReceiptV1>;
}

function snapshotRequest(request: BranchMutationRequestV1): BranchMutationRequestV1 {
  return {
    worktree_path: request.worktree_path,
    branch: request.branch,
    base_sha: request.base_sha,
    old_head_sha: request.old_head_sha,
    mode: request.mode,
    permit_id: request.permit_id,
    execution_id: request.execution_id,
  };
}

/**
 * Deterministic fixture boundary. It rewrites the branch in an isolated local
 * worktree via injected primitives and reports the result. It never pushes.
 */
export function createBranchMutationAdapter(deps: BranchMutationDepsV1): BranchMutationAdapterV1 {
  return {
    async perform(request: BranchMutationRequestV1): Promise<BranchMutationReceiptV1> {
      const bound = snapshotRequest(request);
      const rewrite =
        bound.mode === 'REFRESH'
          ? await deps.applyRefresh({
              worktree_path: bound.worktree_path,
              base_sha: bound.base_sha,
            })
          : await deps.applyRebase({
              worktree_path: bound.worktree_path,
              base_sha: bound.base_sha,
            });

      if (rewrite.status === 'conflict') {
        return {
          adapter: 'fake-branch-mutation',
          status: 'conflict',
          mode: bound.mode,
          old_head_sha: bound.old_head_sha,
          conflict: rewrite.probe,
          pushed: false,
          permit_id: bound.permit_id,
          execution_id: bound.execution_id,
        };
      }

      return {
        adapter: 'fake-branch-mutation',
        status: 'rewritten',
        mode: bound.mode,
        old_head_sha: bound.old_head_sha,
        new_head_sha: rewrite.new_head_sha,
        new_tree_sha: rewrite.new_tree_sha,
        pushed: false,
        permit_id: bound.permit_id,
        execution_id: bound.execution_id,
      };
    },
  };
}
