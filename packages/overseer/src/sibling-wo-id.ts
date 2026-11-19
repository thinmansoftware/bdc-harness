/**
 * Sibling pull requests of one work order (WO-HARNESS-SIBLING-WO-PR-HOLD-AFTER-MERGE-01,
 * bdc-xo#5654).
 *
 * Two Cauldron runs for the same work order can each open a pull request (a redundant second rung
 * after the first completed: provisioner PRs 102 and 103, 2026-11-12). The reconcile pass already
 * closes an open sibling when a PR for the same work order merges, but it can only see a sibling
 * whose body declares the work order (`WO:` line) or whose branch name carries the work-order
 * token. A salvage fallback PR has neither: its body is fixed text and its branch is
 * `salvage/opus-repair-<worktree>-<pid>`. This module answers "which work order was this PR's
 * originating run fired for?" so the same pass can match it, and finds an already-merged sibling for
 * the merge gate (the race between the merge and the pass).
 *
 * Every function here fails toward "do nothing": a failed, empty or ambiguous lookup never matches.
 */
import { userMessageWoId } from './active-run-guard';
import {
  findOriginatingRunsForPullRequest,
  type ListOriginatingRunCandidates,
} from './originating-run-lookup';
import { resolveProjectBase } from './project-bases';
import {
  extractDeclaredWoStems,
  extractReconcileSkipStems,
  isSpecOnlyChangeSet,
} from './reconcile';

export type OriginatingWoResolution =
  | { readonly kind: 'one'; readonly woId: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'ambiguous'; readonly woIds: readonly string[] };

export interface ResolveOriginatingWoInput {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly headRefName: string;
}

export type ResolveOriginatingWoId = (
  input: ResolveOriginatingWoInput
) => Promise<OriginatingWoResolution>;

export interface OriginatingWoResolverDeps {
  readonly list: ListOriginatingRunCandidates;
  /** The run's user_message, or null when the run is unknown. */
  readonly readUserMessage: (runId: string) => Promise<string | null>;
}

/**
 * Which work order was the pull request's originating run fired for?
 *   one       exactly one distinct WO id across every run that opened the PR, and every such run has one
 *   none      no run opened it, or no matched run carries a WO id
 *   ambiguous several runs name different WO ids, or some matched run has no WO id while another has
 * A rejection (the candidate list or a run read throws) propagates: the caller must fail closed.
 */
export function createOriginatingWoResolver(
  deps: OriginatingWoResolverDeps
): ResolveOriginatingWoId {
  return async (input): Promise<OriginatingWoResolution> => {
    const runs = await findOriginatingRunsForPullRequest(
      {
        owner: input.owner,
        repo: input.repo,
        number: input.number,
        headRef: input.headRefName,
      },
      deps.list
    );
    if (runs.length === 0) return { kind: 'none' };
    const woIds = new Set<string>();
    let withoutWoId = 0;
    for (const run of runs) {
      const message = await deps.readUserMessage(run.runId);
      const woId = message === null ? null : userMessageWoId(message);
      if (woId === null) withoutWoId += 1;
      else woIds.add(woId.toUpperCase());
    }
    if (woIds.size === 0) return { kind: 'none' };
    if (woIds.size === 1 && withoutWoId === 0) {
      const [woId] = [...woIds];
      return { kind: 'one', woId };
    }
    return { kind: 'ambiguous', woIds: [...woIds] };
  };
}

/** One recently merged pull request of the repository, as the merge gate needs it. */
export interface RecentMergedPullRequest {
  readonly number: number;
  readonly url: string;
  readonly mergedAt: string;
  readonly body: string;
  /** The branch the merged PR targeted ('' when unknown). */
  readonly baseRef: string;
}

/** What the merge gate reads from GitHub about one candidate pull request and its repository. */
export interface SiblingMergeContext {
  readonly headRefName: string;
  readonly createdAt: string;
  readonly recentMerged: readonly RecentMergedPullRequest[];
}

export interface MergedSibling {
  readonly number: number;
  readonly url: string;
  readonly woId: string;
}

export interface MergedSiblingFinderDeps {
  readonly readContext: (input: {
    owner: string;
    repo: string;
    number: number;
  }) => Promise<SiblingMergeContext>;
  readonly resolve: ResolveOriginatingWoId;
  /** File paths of one merged PR; null when the list is unreadable or truncated. */
  readonly listMergedFiles: (input: {
    owner: string;
    repo: string;
    number: number;
  }) => Promise<readonly string[] | null>;
}

/**
 * The merge gate: is there ANOTHER pull request of the same work order, in the same repository,
 * already merged after this one was created? The same predicate the reconcile pass uses to close a
 * sibling (created before the merge; a spec-only merge is not completion evidence). Returns null on
 * any doubt, including a failed lookup: the caller treats null as "no sibling" and a thrown error
 * as "do not block".
 */
export function createMergedSiblingFinder(
  deps: MergedSiblingFinderDeps
): (input: { owner: string; repo: string; number: number }) => Promise<MergedSibling | null> {
  return async (input): Promise<MergedSibling | null> => {
    // Same eligibility rule as the reconcile supersede pass: a merge counts as completion evidence only
    // when it landed on the project's base branch. A merge into an intermediate feature or integration
    // branch, or into a repository with no known project base, never blocks a PR.
    const projectBase = resolveProjectBase(input.owner, input.repo);
    if (projectBase === null) return null;
    const context = await deps.readContext(input);
    const resolved = await deps.resolve({ ...input, headRefName: context.headRefName });
    if (resolved.kind !== 'one') return null;
    const createdAt = Date.parse(context.createdAt);
    if (Number.isNaN(createdAt)) return null;
    for (const merged of context.recentMerged) {
      if (merged.number === input.number) continue;
      if (merged.baseRef !== projectBase) continue;
      const mergedAt = Date.parse(merged.mergedAt);
      if (Number.isNaN(mergedAt) || !(createdAt < mergedAt)) continue;
      const skipped = extractReconcileSkipStems(merged.body);
      const stems = extractDeclaredWoStems(merged.body).filter(stem => !skipped.has(stem));
      if (!stems.includes(resolved.woId)) continue;
      const files = await deps.listMergedFiles({
        owner: input.owner,
        repo: input.repo,
        number: merged.number,
      });
      if (files === null || isSpecOnlyChangeSet([...files])) continue;
      return { number: merged.number, url: merged.url, woId: resolved.woId };
    }
    return null;
  };
}
