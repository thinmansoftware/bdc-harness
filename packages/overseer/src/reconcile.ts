import { resolveProjectBase } from './project-bases';

const log: ReconcileLogger = {
  warn(fields, message) {
    console.warn('[overseer/reconcile]', message, fields);
  },
  info(fields, message) {
    console.info('[overseer/reconcile]', message, fields);
  },
};

export const RECONCILE_ACTION = 'reconcile_close';
export const RECONCILE_SKIP_ACTION = 'reconcile_skip_noted';
export const RECONCILE_HOLD_OPEN_ACTION = 'reconcile_hold_open_noted';
/**
 * A merged PR on its project base declared a WO (manifest `WO:` line) but carried
 * NO closing keyword for that WO's tracker, so reconcile did not close it and
 * neither did GitHub. One deduplicated audit row records the gap; the tracker is
 * left OPEN (a declaration is not completion evidence -- only a closing keyword is).
 */
export const RECONCILE_KEYWORD_MISSING_ACTION = 'reconcile_keyword_missing_noted';
/**
 * MERGED IS NOT DONE (WO-HARNESS-STAGING-CLOSES-LINK-01 amendment A1; John
 * 2026-10-15 "DONE = tested live, not merged"). A keyword merge on the project
 * base marks the tracker `status:merged` and leaves it OPEN; one row with this
 * action records the mark so a rescan never repeats it.
 */
export const RECONCILE_MERGED_ACTION = 'reconcile_merged_noted';
/**
 * A merged PR closed another OPEN PR that declares the same WO. One row per
 * sibling so a later pass does not comment or close again.
 */
export const RECONCILE_SUPERSEDE_ACTION = 'reconcile_supersede_close';
/** Action-record class for a tracker closed by a LIVE-PROOF comment. */
export const RECONCILE_LIVE_PROOF_CLASS = 'live_proof';
export const MERGED_LABEL = 'status:merged';
/** Claim labels removed when a tracker is marked merged. */
export const STALE_STATUS_LABELS = ['status:building', 'status:review'] as const;
/** Hidden marker in the merged comment; a LIVE-PROOF only counts after it. */
export const MERGED_MARKER = '<!-- overseer:merged-not-done -->';
/** `LIVE-PROOF <evidence>` on a line of its own; evidence must be non-empty. */
export const LIVE_PROOF_PATTERN = /^[ \t]*LIVE-PROOF[ \t]+(\S.*)$/;
const DEFAULT_LIVE_PROOF_AUTHORS = ['bluedevilcollectibles'];
/** Action-record class for a tracker closed by a merged-PR closing keyword on the project base. */
export const RECONCILE_CLOSES_KEYWORD_CLASS = 'closes_keyword';
/** Action-record class for the non-close reconcile audit rows (skip/hold/keyword-missing). */
export const RECONCILE_TRACKER_CLASS = 'tracker_reconcile';
export const WO_STEM_PATTERN = /\bWO-[A-Z0-9]+(?:-[A-Z0-9]+)*-[0-9]{2}\b/g;
/**
 * `Reconcile-Skip: <WO-ID>[, <WO-ID> ...]` on a line of its own. The keyword
 * matches in any case; the id list may be comma and/or space separated. Line
 * anchored so a sentence that merely TALKS about the marker does not fire it.
 * Tolerates CRLF bodies (GitHub returns `\r\n` for PRs edited in the web UI).
 */
export const RECONCILE_SKIP_PATTERN = /^reconcile-skip[ \t]*:[ \t]*(\S.*)$/i;
/**
 * Manifest v2 `WO: <WO-ID>` declaration line. The PR body manifest is the
 * canonical completion record (CLAUDE.md Rule 2), so when a PR declares its
 * WO(s) this way, that list -- not every stem mentioned in prose -- is what the
 * PR is evidence for. See classifyPullRequestStems.
 */
export const WO_DECLARATION_PATTERN = /^WO[ \t]*:[ \t]*(\S.*)$/i;
const DEFAULT_ORG = 'thinmansoftware';
const DEFAULT_TRACKER_REPO = 'bdc-xo';
const DEFAULT_LOOKBACK_DAYS = 14;
/**
 * Lower bound on the merged-PR rescan window. `since` is the EARLIER of the
 * cursor (date of the newest reconcile_close) and today minus this floor, so a PR
 * that merged a few days before the newest close is still re-scanned. The existing
 * re-close / already-closed guards make the rescan idempotent. Env-overridable.
 */
const RECONCILE_MIN_LOOKBACK_DAYS = Number(process.env.RECONCILE_MIN_LOOKBACK_DAYS ?? 7);
const DONE_LABEL = 'wo:done';

export interface ReconcileMergedPullRequest {
  owner: string;
  repo: string;
  number: number;
  title: string;
  body?: string | null;
  htmlUrl: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeCommitSha?: string | null;
  mergedAt?: string | null;
  /**
   * The branch this PR merged into (GitHub `base.ref`). Optional for backward
   * compatibility; when absent the PR matches no project base, so it closes
   * nothing (fail-safe). searchMergedPullRequests always records it.
   */
  baseRef?: string | null;
}

export type ReconcileOpenPullRequest = Pick<
  ReconcileMergedPullRequest,
  'owner' | 'repo' | 'number' | 'title' | 'body' | 'htmlUrl'
>;

/**
 * One OPEN pull request in the merged PR's repository, for the supersede pass.
 * `headRepository` is null when the head repo cannot be verified (deleted fork).
 */
export interface ReconcileRepoOpenPullRequest {
  number: number;
  body?: string | null;
  headRefName: string;
  isDraft: boolean;
  headRepository: { owner: string; repo: string } | null;
  /**
   * ISO creation time of the open PR. Optional for readers that predate the
   * field; a missing or unparseable time is not created-before-merge.
   */
  createdAt?: string | null;
}

export interface ReconcileTrackerIssue {
  owner: string;
  repo: string;
  number: number;
  title: string;
  state: 'open' | 'closed';
  /**
   * ISO creation time of the tracker issue. Optional for backward
   * compatibility; when present, a PR merged before the tracker existed is
   * never completion evidence for it (anchor: bdc-xo #4344, created
   * 2026-11-03T01:51Z, closed two minutes later on PR 4326 merged 11/02 20:15Z).
   */
  createdAt?: string | null;
}

/**
 * Result of a capped, paginated GitHub read. `truncated` is true when the page cap
 * was reached on a full page (more may exist) or a page was malformed, so the
 * items cannot be treated as complete. Every decision that reads one takes its
 * no-change path when truncated (reopen: leave closed; mark: leave unmarked;
 * close: leave open).
 */
export interface PagedRead<T> {
  items: T[];
  truncated: boolean;
}

/** Close-event history verdict for the A2.1 reopen. */
export interface CloseEventRead {
  closedByThisPr: boolean;
  truncated: boolean;
}

export interface ReconcileTrackerComment {
  author: string;
  body: string;
  htmlUrl: string;
  createdAt: string;
}

export interface ReconcileActionRecord {
  prRef: string;
  woId: string;
  class: string;
  action: string;
  result: string;
}

export interface ReconcileLogger {
  warn(fields: Record<string, unknown>, message: string): void;
  info?(fields: Record<string, unknown>, message: string): void;
}

export interface ReconcileDeps {
  readCursor?: () => Promise<string | null>;
  searchMergedPullRequests: (input: {
    org: string;
    since: string;
  }) => Promise<ReconcileMergedPullRequest[]>;
  /** Optional scope is fresh for each run; default reads share only that run's snapshot. */
  findTrackerIssueByStem: (stem: string, scope?: object) => Promise<ReconcileTrackerIssue | null>;
  /**
   * Resolve a tracker issue by its issue NUMBER in the tracker repo. Used by the
   * keyword-close path: a closing keyword references an issue number, not a stem.
   * Shares the per-run snapshot/scope with findTrackerIssueByStem (one REST scan).
   * Optional for deps objects that predate the keyword-close path; when absent,
   * the keyword-close path is skipped (name-mention still never closes).
   */
  findTrackerIssueByNumber?: (
    number: number,
    scope?: object
  ) => Promise<ReconcileTrackerIssue | null>;
  addTrackerEvidenceComment: (input: {
    issue: ReconcileTrackerIssue;
    body: string;
  }) => Promise<void>;
  addTrackerLabel: (input: { issue: ReconcileTrackerIssue; label: string }) => Promise<void>;
  closeTrackerIssue: (input: { issue: ReconcileTrackerIssue }) => Promise<void>;
  hasSkipBeenNoted?: (input: { prRef: string; woId: string }) => Promise<boolean>;
  /**
   * True when this PR has ALREADY closed this WO's tracker once (an
   * action=reconcile_close row exists for prRef+woId). Used by the re-close
   * guard: a tracker that is open again after that was reopened by a human, and
   * the same merged PR is not new evidence. Optional for deps objects that
   * predate the guard; the default reads overseer_reconcile_actions.
   */
  hasCloseBeenRecorded?: (input: { prRef: string; woId: string }) => Promise<boolean>;
  insertAction?: (record: ReconcileActionRecord) => Promise<unknown>;
  /**
   * Changed-file paths for a merged PR. Used to refuse closing a tracker on a
   * SPEC-ONLY merge (see isSpecOnlyChangeSet). Optional: when absent, reconcile
   * falls back to prior behavior rather than blocking, so a deps object that
   * predates this guard still works.
   */
  listPullRequestFiles?: (pr: ReconcileMergedPullRequest) => Promise<string[] | PagedRead<string>>;
  /**
   * Open pull requests that may still reference this tracker. When one of them
   * holds the WO, reconcile leaves the tracker open. Optional: when absent,
   * reconcile falls back to prior behavior rather than blocking, so a deps
   * object that predates this guard still works.
   */
  listOpenPullRequestsReferencingTracker?: (input: {
    issue: ReconcileTrackerIssue;
    stem: string;
  }) => Promise<ReconcileOpenPullRequest[]>;
  /**
   * True when this merged PR has already posted the hold-open note for this WO
   * (an action=reconcile_hold_open_noted row exists for prRef+woId). Optional
   * for deps objects that predate the guard; the default reads
   * overseer_reconcile_actions.
   */
  hasHoldBeenNoted?: (input: { prRef: string; woId: string }) => Promise<boolean>;
  /**
   * True when this merged PR has already recorded a keyword-missing note for this
   * WO (an action=reconcile_keyword_missing_noted row exists for prRef+woId).
   * Optional for deps objects that predate the note; the default reads
   * overseer_reconcile_actions.
   */
  hasKeywordMissingBeenNoted?: (input: { prRef: string; woId: string }) => Promise<boolean>;
  /** Remove a label from a tracker; a label that is not present is not an error. */
  removeTrackerLabel?: (input: { issue: ReconcileTrackerIssue; label: string }) => Promise<void>;
  /**
   * True when this merged PR already marked this WO's tracker merged (an
   * action=reconcile_merged_noted row exists for prRef+woId).
   */
  hasMergedBeenNoted?: (input: { prRef: string; woId: string }) => Promise<boolean>;
  /**
   * Open tracker issues labelled status:merged (the LIVE-PROOF pass). Optional:
   * when absent, or when listTrackerComments is absent, the pass is skipped.
   */
  listMergedAwaitingProof?: () => Promise<
    ReconcileTrackerIssue[] | PagedRead<ReconcileTrackerIssue>
  >;
  /** Comments on a tracker issue, oldest first. */
  listTrackerComments?: (input: {
    issue: ReconcileTrackerIssue;
  }) => Promise<ReconcileTrackerComment[] | PagedRead<ReconcileTrackerComment>>;
  /**
   * Amendment A2.1: true when the tracker's most recent `closed` event carries
   * this PR's merge commit sha (GitHub closed it natively on the keyword merge).
   * Optional: when absent, a closed tracker is left closed.
   */
  wasClosedByPullRequestMerge?: (input: {
    issue: ReconcileTrackerIssue;
    pr: ReconcileMergedPullRequest;
  }) => Promise<boolean | CloseEventRead>;
  /** Reopen a tracker issue (amendment A2.1). */
  reopenTrackerIssue?: (input: { issue: ReconcileTrackerIssue }) => Promise<void>;
  /**
   * OPEN pull requests in one repository. Optional: when absent, the supersede
   * pass is skipped so older deps objects keep their current behavior.
   * A truncated page set may still be processed.
   */
  listOpenPullRequestsInRepo?: (input: {
    owner: string;
    repo: string;
  }) => Promise<ReconcileRepoOpenPullRequest[] | PagedRead<ReconcileRepoOpenPullRequest>>;
  /** Comment and close one pull request. A throw writes no supersede action row. */
  closePullRequest?: (input: {
    owner: string;
    repo: string;
    number: number;
    comment: string;
  }) => Promise<void>;
  /**
   * True when this sibling PR already has a reconcile_supersede_close row for
   * this WO. Defaults to the existing action lookup.
   */
  hasSupersedeBeenRecorded?: (input: { prRef: string; woId: string }) => Promise<boolean>;
  now?: () => Date;
  log?: ReconcileLogger;
}

export interface OctokitLike {
  search: {
    issuesAndPullRequests(input: Record<string, unknown>): Promise<{
      data: {
        total_count?: number;
        incomplete_results?: boolean;
        items: {
          number: number;
          title: string;
          body?: string | null;
          html_url?: string;
          state: string;
          pull_request?: unknown;
          repository_url?: string;
        }[];
      };
    }>;
  };
  pulls: {
    list?(input: Record<string, unknown>): Promise<{ data: unknown }>;
    listFiles(input: Record<string, unknown>): Promise<{
      data: { filename: string }[];
    }>;
    get(input: Record<string, unknown>): Promise<{
      data: {
        title?: string;
        body?: string | null;
        html_url: string;
        state: 'open' | 'closed';
        merged?: boolean;
        merge_commit_sha?: string | null;
        merged_at?: string | null;
        base?: { ref?: string | null } | null;
      };
    }>;
  };
  issues: {
    listForRepo?(input: Record<string, unknown>): Promise<{ data: unknown }>;
    createComment(input: Record<string, unknown>): Promise<unknown>;
    addLabels(input: Record<string, unknown>): Promise<unknown>;
    removeLabel?(input: Record<string, unknown>): Promise<unknown>;
    listComments?(input: Record<string, unknown>): Promise<{ data: unknown }>;
    listEvents?(input: Record<string, unknown>): Promise<{ data: unknown }>;
    update(input: Record<string, unknown>): Promise<unknown>;
  };
}

export interface RunReconcileInput {
  org?: string;
  trackerRepo?: string;
  lookbackDays?: number;
  deps?: ReconcileDeps;
}

export interface ReconcileResult {
  scanned: number;
  /** Trackers closed (only by a LIVE-PROOF comment since amendment A1). */
  closed: number;
  skipped: boolean;
}

export async function runReconcileOnce(input: RunReconcileInput = {}): Promise<ReconcileResult> {
  const deps = input.deps ?? createDefaultReconcileDeps();
  const trackerLookupScope = {};
  const successfullyClosedTrackers = new Set<string>();
  const logger = deps.log ?? log;
  const org = input.org ?? DEFAULT_ORG;
  const since = await resolveSearchSince(input, deps);

  let pullRequests: ReconcileMergedPullRequest[];
  try {
    pullRequests = await deps.searchMergedPullRequests({ org, since });
  } catch (error) {
    if (isRateLimitError(error)) {
      logger.warn({ err: error as Error, rateLimit: true }, 'overseer.reconcile.rate_limit_skip');
      return { scanned: 0, closed: 0, skipped: true };
    }
    if (isAuthError(error)) {
      logger.warn({ err: error as Error, authError: true }, 'overseer.reconcile.auth_error_skip');
      return { scanned: 0, closed: 0, skipped: true };
    }
    logger.warn({ err: error as Error }, 'overseer.reconcile.transport_error_skip');
    return { scanned: 0, closed: 0, skipped: true };
  }

  let closed = 0;
  let marked = 0;
  const seen = new Set<string>();
  for (const pr of pullRequests) {
    const key = `${pr.owner}/${pr.repo}#${pr.number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!pr.merged || pr.state !== 'closed') continue;
    const classified = classifyPullRequestStems(pr);
    const prRef = `${pr.owner}/${pr.repo}#${pr.number}`;
    const body = pr.body ?? '';
    const skippedSet = new Set(classified.skipped);
    const evidenceResult = `${pr.htmlUrl}:${pr.mergeCommitSha ?? 'merge_sha_unknown'}`;

    // RECONCILE-SKIP. An author who writes `Reconcile-Skip: <WO-ID>` is saying
    // "this PR is NOT evidence that <WO-ID> is done". A closing keyword naming
    // that WO's tracker is therefore ignored, and NO comment is posted -- the
    // marker exists precisely so the tracker is left alone (the old "noted merged
    // PR evidence" comment put four notices on bdc-xo #1889 in one morning). One
    // deduplicated action row is the audit trail.
    for (const stem of classified.skipped) {
      const alreadyNoted = await (deps.hasSkipBeenNoted ?? hasDefaultSkipBeenNoted)({
        prRef,
        woId: stem,
      });
      if (alreadyNoted) continue;
      logger.info?.({ prRef, stem }, 'overseer.reconcile.skip_marker_excluded_pr_evidence');
      await (deps.insertAction ?? insertDefaultOverseerAction)({
        prRef,
        woId: stem,
        class: RECONCILE_TRACKER_CLASS,
        action: RECONCILE_SKIP_ACTION,
        result: evidenceResult,
      });
    }
    for (const stem of classified.incidental) {
      logger.info?.({ prRef, stem }, 'overseer.reconcile.incidental_mention_not_evidence');
    }

    // PROJECT-BASE GATE. GitHub only honours closing keywords on a merge into the
    // repository default branch, so a project whose Cauldron base is staging/dev/
    // bdc-main never gets its tracker closed by GitHub. Reconcile closes a tracker
    // ONLY when the merged PR's base ref equals that project's base AND the PR
    // carries a closing keyword naming the tracker issue. A merge into any other
    // branch (feature-to-feature) closes nothing. A merged PR that merely NAMES a
    // WO (prose, or a bare `WO:` line with no keyword) is never completion evidence
    // for its tracker.
    const projectBase = resolveProjectBase(pr.owner, pr.repo);
    if (projectBase === null || projectBase !== (pr.baseRef ?? null)) continue;

    // Supersede sibling OPEN PRs only after the project-base gate. A merged PR
    // that is not completion evidence must not close siblings. Reconcile-Skip
    // stems are removed inside the call. A rate-limit or auth error aborts the
    // pass the same way other GitHub reads do.
    const supersede = await closeSupersededSiblingPullRequests(pr, deps, logger);
    if (supersede === 'rate_limit' || supersede === 'auth') {
      return { scanned: seen.size, closed, skipped: true };
    }

    const refNumbers = extractClosingKeywordTrackerRefs(body, pr.owner, pr.repo);
    const declaredStems = extractDeclaredWoStems(body);

    if (deps.findTrackerIssueByNumber) {
      for (const number of refNumbers) {
        let tracker: ReconcileTrackerIssue | null;
        try {
          tracker = await deps.findTrackerIssueByNumber(number, trackerLookupScope);
        } catch (error) {
          if (isRateLimitError(error)) {
            logger.warn(
              { err: error as Error, rateLimit: true, number },
              'overseer.reconcile.rate_limit_skip'
            );
            return { scanned: seen.size, closed, skipped: true };
          }
          if (isAuthError(error)) {
            logger.warn(
              { err: error as Error, authError: true, number },
              'overseer.reconcile.auth_error_skip'
            );
            return { scanned: seen.size, closed, skipped: true };
          }
          throw error;
        }
        if (!tracker) continue;
        const woId = deriveTrackerWoId(tracker);
        const holderStem = isWoStem(tracker.title) ? tracker.title : woId;

        // A skip marker naming this WO suppresses its keyword close.
        if (isWoStem(woId) && skippedSet.has(woId)) {
          logger.info?.(
            { prRef, woId, tracker: tracker.number },
            'overseer.reconcile.skip_marker_excluded_pr_evidence'
          );
          continue;
        }
        // GitHub may have closed the tracker natively on a default-branch keyword
        // merge. Amendment A2.1: if THIS PR's merge closed it, reopen it below
        // (after every guard) and mark it merged; any other closer is respected.
        let reopenNeeded = false;
        if (tracker.state !== 'open') {
          if (!deps.wasClosedByPullRequestMerge || !deps.reopenTrackerIssue) continue;
          if (!pr.mergeCommitSha) continue;
          let closeRead: CloseEventRead;
          try {
            const raw = await deps.wasClosedByPullRequestMerge({ issue: tracker, pr });
            closeRead = typeof raw === 'boolean' ? { closedByThisPr: raw, truncated: false } : raw;
          } catch (error) {
            logger.warn(
              { err: error as Error, prRef, tracker: tracker.number },
              'overseer.reconcile.close_event_lookup_failed_left_closed'
            );
            continue;
          }
          if (closeRead.truncated) {
            // Capped event history: a later close may be unread. Leave it closed.
            logger.warn(
              { prRef, tracker: tracker.number },
              'overseer.reconcile.close_event_history_truncated_left_closed'
            );
            continue;
          }
          if (!closeRead.closedByThisPr) continue;
          reopenNeeded = true;
          // Reopen NOW, before the spec-only/holder guards: a native close by this
          // PR's merge is never left standing, whatever those guards decide about
          // the status:merged mark. A close by anyone else never reaches here.
          await deps.reopenTrackerIssue({ issue: tracker });
          logger.info?.(
            { prRef, woId, tracker: tracker.number },
            'overseer.reconcile.native_close_reopened'
          );
        }
        // PRE-TRACKER GUARD. A PR that merged before the tracker issue existed
        // cannot be the work that tracker asks for (bdc-xo #4344 anchor).
        if (mergedBeforeTrackerCreated(pr.mergedAt, tracker.createdAt)) {
          logger.warn(
            {
              prRef,
              woId,
              tracker: tracker.number,
              mergedAt: pr.mergedAt,
              trackerCreatedAt: tracker.createdAt,
            },
            'overseer.reconcile.pr_merged_before_tracker_created_left_open'
          );
          continue;
        }
        const trackerIdentity = `${tracker.owner}/${tracker.repo}#${tracker.number}`.toLowerCase();
        if (successfullyClosedTrackers.has(trackerIdentity)) continue;

        // RE-CLOSE GUARD. If this PR already closed this tracker once and the
        // tracker is open again, a human reopened it on purpose. The same merged
        // PR is not new evidence, so the lookback re-scan must not undo that
        // decision. Anchor (2026-09-02): XO reopened bdc-xo #1889 at 13:51:26Z
        // with a comment explaining why; reconcile re-closed it at 13:51:33Z on
        // the same shopops#662 evidence.
        const closeRecorded = await (deps.hasCloseBeenRecorded ?? hasDefaultCloseBeenRecorded)({
          prRef,
          woId,
        });
        if (closeRecorded) {
          logger.warn(
            { prRef, woId, tracker: tracker.number },
            'overseer.reconcile.tracker_reopened_after_close_left_open'
          );
          continue;
        }
        const mergedNoted = await (deps.hasMergedBeenNoted ?? hasDefaultMergedBeenNoted)({
          prRef,
          woId,
        });
        if (mergedNoted) continue;

        // SPEC-ONLY GUARD. author-wo.sh lands the WO spec document via its own PR,
        // which names the WO stem -- so without this, a WO can be closed as done
        // by the very PR that CREATED it. See isSpecOnlyChangeSet for the anchor.
        const listFiles = deps.listPullRequestFiles;
        if (listFiles) {
          let changedPaths: string[] | null = null;
          try {
            const read = asPagedRead(await listFiles(pr));
            if (read.truncated) {
              // Capped file list: cannot prove the merge is not spec-only. No mark.
              logger.warn(
                { prRef, woId },
                'overseer.reconcile.file_list_truncated_leaving_tracker_unmarked'
              );
              continue;
            }
            changedPaths = read.items;
          } catch (error) {
            // Fail OPEN on a file-listing error: leave the tracker alone rather
            // than closing on unverified evidence. A tracker left open is visible
            // and fixable; one falsely closed is invisible.
            logger.warn(
              { err: error as Error, prRef, woId },
              'overseer.reconcile.file_list_failed_leaving_tracker_open'
            );
            continue;
          }
          if (isSpecOnlyChangeSet(changedPaths)) {
            // warn, not info: `info` is optional on ReconcileLogger while `warn`
            // is guaranteed, and a spec-only merge that LOOKS like completion is
            // worth surfacing rather than burying at info level.
            logger.warn(
              { prRef, woId, changedPaths },
              'overseer.reconcile.spec_only_merge_tracker_left_open'
            );
            // Silent by design. Reconcile re-scans a lookback window, so
            // commenting here would re-post on every pass for the life of the
            // window. The log line above is the record; the tracker stays open.
            continue;
          }
        }

        // OPEN-PR GUARD. A two-stage WO shares one tracker across PRs. Closing the
        // tracker when the first stage merges leaves later stages (still open,
        // sometimes with changes requested) looking done. Anchor: bdc-harness
        // #1051 -- shopops#760 merged and closed bdc-xo#2581 while #762 and #763
        // were still open.
        const listOpen = deps.listOpenPullRequestsReferencingTracker;
        if (listOpen) {
          let openPullRequests: ReconcileOpenPullRequest[];
          try {
            openPullRequests = await listOpen({ issue: tracker, stem: holderStem });
          } catch (error) {
            // Fail OPEN on a lookup error: leave the tracker alone rather than
            // closing on unverified evidence.
            logger.warn(
              { err: error as Error, prRef, woId },
              'overseer.reconcile.open_pr_lookup_failed_leaving_tracker_open'
            );
            continue;
          }
          const holders = openPullRequestsHoldingTracker({
            stem: holderStem,
            mergedPr: pr,
            tracker,
            openPullRequests,
          });
          if (holders.length > 0) {
            const alreadyNoted = await (deps.hasHoldBeenNoted ?? hasDefaultHoldBeenNoted)({
              prRef,
              woId,
            });
            if (alreadyNoted) {
              logger.warn(
                { prRef, woId, tracker: tracker.number },
                'overseer.reconcile.open_prs_hold_tracker_open'
              );
              continue;
            }
            await deps.addTrackerEvidenceComment({
              issue: tracker,
              body: buildHoldOpenComment({ pr, stem: holderStem, holders }),
            });
            await (deps.insertAction ?? insertDefaultOverseerAction)({
              prRef,
              woId,
              class: RECONCILE_TRACKER_CLASS,
              action: RECONCILE_HOLD_OPEN_ACTION,
              result: evidenceResult,
            });
            continue;
          }
        }

        // MERGED IS NOT DONE (amendment A1). Mark the tracker and leave it open;
        // only a LIVE-PROOF comment closes it (see the pass after this loop).
        await deps.addTrackerLabel({ issue: tracker, label: MERGED_LABEL });
        for (const stale of STALE_STATUS_LABELS) {
          await deps.removeTrackerLabel?.({ issue: tracker, label: stale });
        }
        await deps.addTrackerEvidenceComment({
          issue: tracker,
          body: buildMergedComment({ pr, stem: holderStem, reopened: reopenNeeded }),
        });
        successfullyClosedTrackers.add(trackerIdentity);
        await (deps.insertAction ?? insertDefaultOverseerAction)({
          prRef,
          woId,
          class: RECONCILE_CLOSES_KEYWORD_CLASS,
          action: RECONCILE_MERGED_ACTION,
          result: evidenceResult,
        });
        marked += 1;
      }
    }

    // KEYWORD-MISSING NOTE. A PR on its project base that declares a WO on a
    // manifest `WO:` line but carries NO closing keyword for that WO's tracker
    // leaves the tracker OPEN (a declaration is not completion evidence) and
    // records one deduplicated audit row so the gap is visible.
    for (const declared of declaredStems) {
      if (skippedSet.has(declared)) continue;
      let declaredTracker: ReconcileTrackerIssue | null;
      try {
        declaredTracker = await deps.findTrackerIssueByStem(declared, trackerLookupScope);
      } catch (error) {
        if (isRateLimitError(error)) {
          logger.warn(
            { err: error as Error, rateLimit: true, stem: declared },
            'overseer.reconcile.rate_limit_skip'
          );
          return { scanned: seen.size, closed, skipped: true };
        }
        if (isAuthError(error)) {
          logger.warn(
            { err: error as Error, authError: true, stem: declared },
            'overseer.reconcile.auth_error_skip'
          );
          return { scanned: seen.size, closed, skipped: true };
        }
        throw error;
      }
      if (declaredTracker?.state !== 'open') continue;
      if (refNumbers.includes(declaredTracker.number)) continue;
      const alreadyNoted = await (
        deps.hasKeywordMissingBeenNoted ?? hasDefaultKeywordMissingBeenNoted
      )({ prRef, woId: declared });
      if (alreadyNoted) continue;
      logger.info?.(
        { prRef, woId: declared, tracker: declaredTracker.number },
        'overseer.reconcile.keyword_missing_tracker_left_open'
      );
      await (deps.insertAction ?? insertDefaultOverseerAction)({
        prRef,
        woId: declared,
        class: RECONCILE_TRACKER_CLASS,
        action: RECONCILE_KEYWORD_MISSING_ACTION,
        result: evidenceResult,
      });
    }
  }

  closed += await runLiveProofPass(deps, logger);
  if (marked > 0) logger.info?.({ marked }, 'overseer.reconcile.trackers_marked_merged');

  return { scanned: seen.size, closed, skipped: false };
}

/**
 * LIVE-PROOF pass (amendment A1.3). Closes an open `status:merged` tracker when
 * an allowed author posted `LIVE-PROOF <evidence>` after the Overseer's merged
 * comment. Any lookup failure leaves every tracker open for the next pass.
 */
async function runLiveProofPass(deps: ReconcileDeps, logger: ReconcileLogger): Promise<number> {
  if (!deps.listMergedAwaitingProof || !deps.listTrackerComments) return 0;
  let awaiting: ReconcileTrackerIssue[];
  try {
    const read = asPagedRead(await deps.listMergedAwaitingProof());
    if (read.truncated) {
      // Capped list of status:merged issues: close nothing this pass.
      logger.warn({ read: read.items.length }, 'overseer.reconcile.live_proof_list_truncated');
      return 0;
    }
    awaiting = read.items;
  } catch (error) {
    logger.warn({ err: error as Error }, 'overseer.reconcile.live_proof_list_failed');
    return 0;
  }
  const allowed = liveProofAuthors();
  let closed = 0;
  for (const issue of awaiting) {
    if (issue.state !== 'open') continue;
    const prRef = `${issue.owner}/${issue.repo}#${issue.number}`;
    const woId = deriveTrackerWoId(issue);
    // One live-proof close per issue: a human reopen afterwards is not undone.
    const already = await (deps.hasCloseBeenRecorded ?? hasDefaultCloseBeenRecorded)({
      prRef,
      woId,
    });
    if (already) continue;
    let comments: ReconcileTrackerComment[];
    try {
      const read = asPagedRead(await deps.listTrackerComments({ issue }));
      if (read.truncated) {
        // Capped comment list: a newer merged marker may be unread. Leave open.
        logger.warn({ prRef }, 'overseer.reconcile.live_proof_comments_truncated_left_open');
        continue;
      }
      comments = read.items;
    } catch (error) {
      logger.warn({ err: error as Error, prRef }, 'overseer.reconcile.live_proof_comments_failed');
      continue;
    }
    const proof = findLiveProof(comments, allowed);
    if (!proof) continue;
    // Amendment A2.2: an open PR that still holds this WO keeps it open, and a
    // failed holder lookup keeps it open too (a false close is invisible).
    if (deps.listOpenPullRequestsReferencingTracker) {
      const stem = isWoStem(issue.title) ? issue.title : woId;
      let holders: ReconcileOpenPullRequest[];
      try {
        const open = await deps.listOpenPullRequestsReferencingTracker({ issue, stem });
        holders = openPullRequestsHoldingTracker({
          stem,
          mergedPr: { owner: '', repo: '', number: 0 },
          tracker: issue,
          openPullRequests: open,
        });
      } catch (error) {
        logger.warn(
          { err: error as Error, prRef },
          'overseer.reconcile.live_proof_holder_lookup_failed_left_open'
        );
        continue;
      }
      if (holders.length > 0) {
        logger.warn(
          { prRef, holders: holders.map(h => `${h.owner}/${h.repo}#${h.number}`) },
          'overseer.reconcile.live_proof_open_prs_hold_tracker_open'
        );
        continue;
      }
    }
    await deps.addTrackerEvidenceComment({ issue, body: buildLiveProofComment(proof) });
    await deps.addTrackerLabel({ issue, label: DONE_LABEL });
    await deps.closeTrackerIssue({ issue });
    await (deps.insertAction ?? insertDefaultOverseerAction)({
      prRef,
      woId,
      class: RECONCILE_LIVE_PROOF_CLASS,
      action: RECONCILE_ACTION,
      result: proof.htmlUrl,
    });
    closed += 1;
  }
  return closed;
}

/** Allowed LIVE-PROOF authors: OVERSEER_LIVE_PROOF_AUTHORS (comma logins) or the default. */
export function liveProofAuthors(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.OVERSEER_LIVE_PROOF_AUTHORS;
  const list = (raw ?? '')
    .split(',')
    .map(login => login.trim().toLowerCase())
    .filter(login => login.length > 0);
  return list.length > 0 ? list : DEFAULT_LIVE_PROOF_AUTHORS;
}

/**
 * The first LIVE-PROOF comment by an allowed author that comes AFTER the latest
 * Overseer merged comment (MERGED_MARKER). No marker means no proof counts.
 */
export function findLiveProof(
  comments: readonly ReconcileTrackerComment[],
  allowedAuthors: readonly string[]
): (ReconcileTrackerComment & { evidence: string }) | null {
  let markerIndex = -1;
  comments.forEach((comment, index) => {
    if (comment.body.includes(MERGED_MARKER)) markerIndex = index;
  });
  if (markerIndex < 0) return null;
  const allowed = new Set(allowedAuthors.map(a => a.toLowerCase()));
  for (const comment of comments.slice(markerIndex + 1)) {
    if (!allowed.has(comment.author.toLowerCase())) continue;
    for (const rawLine of comment.body.split('\n')) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      const match = LIVE_PROOF_PATTERN.exec(line);
      if (match?.[1]) return { ...comment, evidence: match[1].trim() };
    }
  }
  return null;
}

export function buildMergedComment(input: {
  pr: ReconcileMergedPullRequest;
  stem: string;
  reopened?: boolean;
}): string {
  return [
    MERGED_MARKER,
    `Overseer reconcile: ${input.stem} merged, not done. Label ${MERGED_LABEL}; this issue stays open.`,
    ...(input.reopened
      ? [
          '',
          'reopened: DONE = tested live (John 2026-10-15); close with LIVE-PROOF. GitHub closed this issue on the merge; the Overseer reopened it.',
        ]
      : []),
    '',
    `Merged PR: ${input.pr.htmlUrl}`,
    `Merge SHA: ${input.pr.mergeCommitSha ?? 'unknown'}`,
    `Base: ${input.pr.baseRef ?? 'unknown'}`,
    '',
    'It closes when the XO or the builder posts a comment line `LIVE-PROOF <evidence url or command output>` after deploy.',
  ].join('\n');
}

export function buildLiveProofComment(
  proof: ReconcileTrackerComment & { evidence: string }
): string {
  return [
    `Overseer reconcile closed this issue on LIVE-PROOF by @${proof.author}.`,
    '',
    `Proof comment: ${proof.htmlUrl}`,
  ].join('\n');
}

/** Nine GitHub closing-keyword forms, word-bounded, case-insensitive. */
const CLOSING_KEYWORD_SOURCE = '(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)';
/**
 * A closing keyword immediately followed (optional `:` and whitespace) by an
 * issue reference: `#N` (the PR's own repo) or `owner/repo#N` (cross-repo).
 *
 * The trailing `\b` is a hard reference boundary so a number glued to more text
 * (`thinmansoftware/bdc-xo#4130draft`, `#4130x`) is NOT parsed as `#4130`. This
 * mirrors the trailing-boundary check in lineClosesTracker; without it a PR that
 * references a lookalike tracker could close the wrong issue.
 */
const CLOSING_KEYWORD_REF_SOURCE = `\\b${CLOSING_KEYWORD_SOURCE}\\b[:\\s]+([A-Za-z0-9][A-Za-z0-9_.-]*\\/[A-Za-z0-9][A-Za-z0-9_.-]*#\\d+|#\\d+)\\b`;

/** True when `value` is exactly a WO stem (WO-...-NN). */
export function isWoStem(value: string): boolean {
  return new RegExp(`^${WO_STEM_PATTERN.source}$`).test(value);
}

/**
 * The woId for an action row closing `tracker`: the WO stem that is the tracker's
 * title, or `gh:<owner>/<repo>#<number>` when the title is not a WO stem.
 */
export function deriveTrackerWoId(tracker: ReconcileTrackerIssue): string {
  if (isWoStem(tracker.title)) return tracker.title;
  return `gh:${tracker.owner}/${tracker.repo}#${tracker.number}`;
}

/**
 * Issue numbers in the tracker repo (thinmansoftware/bdc-xo) that a closing
 * keyword in `body` references. `#N` resolves to the PR's own repo (so it only
 * counts when the PR itself is in the tracker repo); `owner/repo#N` counts when
 * owner/repo IS the tracker repo. Word boundaries match lineClosesTracker:
 * `evilthinmansoftware/bdc-xo#1` and `#10440` do not masquerade as `#1044`.
 */
export function extractClosingKeywordTrackerRefs(
  body: string,
  prOwner: string,
  prRepo: string
): number[] {
  const numbers = new Set<number>();
  for (const rawLine of body.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.length > RECONCILE_LINE_MAX) continue;
    const re = new RegExp(CLOSING_KEYWORD_REF_SOURCE, 'gi');
    let match: RegExpExecArray | null;
    while ((match = re.exec(line)) !== null) {
      const resolved = resolveTrackerRef(match[1] ?? '', prOwner, prRepo);
      if (resolved !== null) numbers.add(resolved);
    }
  }
  return [...numbers];
}

function resolveTrackerRef(ref: string, prOwner: string, prRepo: string): number | null {
  let owner = prOwner;
  let repo = prRepo;
  let numberText: string;
  if (ref.startsWith('#')) {
    numberText = ref.slice(1);
  } else {
    const parts = /^([A-Za-z0-9][A-Za-z0-9_.-]*)\/([A-Za-z0-9][A-Za-z0-9_.-]*)#(\d+)$/.exec(ref);
    if (!parts) return null;
    owner = parts[1] ?? '';
    repo = parts[2] ?? '';
    numberText = parts[3] ?? '';
  }
  if (owner.toLowerCase() !== DEFAULT_ORG || repo.toLowerCase() !== DEFAULT_TRACKER_REPO) {
    return null;
  }
  const number = Number(numberText);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return number;
}

/**
 * True when a merged PR contains ONLY the WO spec document (and adjacent
 * governance paperwork) -- no implementation.
 *
 * Why this exists: `author-wo.sh` lands `docs/work-orders/<WO-ID>.md` on bdc-xo
 * main via its own PR. That PR mentions the WO stem, so reconcile matched it and
 * closed the tracker as `wo:done` -- while zero code had been written.
 *
 * Anchor (2026-07-25): four WOs authored in one session were all closed within
 * minutes by their own spec PRs. For WO-XO-CRM-MINIMUM-COMPLETE-JOURNEY-01 the
 * target repository `bdc-crm` did not exist at all -- `gh repo view` returned
 * "Could not resolve to a Repository" -- so the WO could not possibly have been
 * done. Prior anchors: bdc-xo #1128, #1149.
 *
 * Deliberately conservative: it only returns true when EVERY changed path is
 * paperwork. One source file anywhere in the PR means this is a real build and
 * reconcile proceeds as before. False negatives (a real build we fail to
 * recognise as spec-only) are harmless; false positives would re-open the hole.
 */
export function isSpecOnlyChangeSet(paths: readonly string[]): boolean {
  if (paths.length === 0) return false; // no information -- do not assume spec-only
  return paths.every(
    path =>
      path.startsWith('docs/work-orders/') ||
      path.startsWith('docs/board/motions/') ||
      path.startsWith('docs/superpowers/specs/')
  );
}

export function extractWoStems(input: string): string[] {
  const matches = input.match(WO_STEM_PATTERN) ?? [];
  return [...new Set(matches)];
}

/** WO stems on every `Reconcile-Skip:` line of a PR body. Ids are upper-cased. */
export function extractReconcileSkipStems(input: string): Set<string> {
  return collectStemsFromLines(input, RECONCILE_SKIP_PATTERN);
}

/** WO stems on every manifest `WO:` line of a PR body. Ids are upper-cased. */
export function extractDeclaredWoStems(input: string): string[] {
  return [...collectStemsFromLines(input, WO_DECLARATION_PATTERN)];
}

type SupersedeOutcome = 'continue' | 'rate_limit' | 'auth';

function headIsTargetRepo(
  candidate: ReconcileRepoOpenPullRequest,
  owner: string,
  repo: string
): boolean {
  const headOwner = candidate.headRepository?.owner;
  const headRepo = candidate.headRepository?.repo;
  if (!headOwner || !headRepo) return false;
  return (
    headOwner.toLowerCase() === owner.toLowerCase() && headRepo.toLowerCase() === repo.toLowerCase()
  );
}

/** First declared stem that the candidate's WO: line or head branch names. */
function firstMatchedSupersedeStem(
  candidate: ReconcileRepoOpenPullRequest,
  stems: readonly string[]
): string | null {
  const declared = new Set(extractDeclaredWoStems(candidate.body ?? ''));
  const head = candidate.headRefName.toLowerCase();
  for (const stem of stems) {
    if (declared.has(stem) || (stem.length > 0 && head.includes(stem.toLowerCase()))) return stem;
  }
  return null;
}

/**
 * True only when both times parse and the sibling was created strictly before
 * mergedAt. Missing, empty, invalid, or equal times return false (fail closed:
 * the sibling is not superseded). Same parse and Number.isNaN checks as
 * mergedBeforeTrackerCreated.
 */
function siblingCreatedBeforeMerge(
  createdAt: string | null | undefined,
  mergedAt: string | null | undefined
): boolean {
  if (!createdAt || !mergedAt) return false;
  const created = Date.parse(createdAt);
  const merged = Date.parse(mergedAt);
  if (Number.isNaN(created) || Number.isNaN(merged)) return false;
  return created < merged;
}

/**
 * Close OPEN non-draft, non-fork PRs in the merged PR's repo that declare one
 * of its eligible WO stems and were created strictly before mergedAt.
 * Eligible stems are manifest `WO:` lines minus `Reconcile-Skip:` stems.
 * A merged PR whose base is not the project base, or that has no eligible
 * stems, returns without listing siblings. Does not call closeTrackerIssue.
 * A failed list closes nothing. A truncated list still processes what it returned.
 */
async function closeSupersededSiblingPullRequests(
  pr: ReconcileMergedPullRequest,
  deps: ReconcileDeps,
  logger: ReconcileLogger
): Promise<SupersedeOutcome> {
  if (!deps.listOpenPullRequestsInRepo || !deps.closePullRequest) return 'continue';
  const projectBase = resolveProjectBase(pr.owner, pr.repo);
  if (projectBase === null || projectBase !== (pr.baseRef ?? null)) return 'continue';
  const prRef = `${pr.owner}/${pr.repo}#${pr.number}`;
  const skipped = extractReconcileSkipStems(pr.body ?? '');
  const stems = extractDeclaredWoStems(pr.body ?? '').filter(stem => !skipped.has(stem));
  if (stems.length === 0) return 'continue';

  let listed: PagedRead<ReconcileRepoOpenPullRequest>;
  try {
    listed = asPagedRead(await deps.listOpenPullRequestsInRepo({ owner: pr.owner, repo: pr.repo }));
  } catch (error) {
    if (isRateLimitError(error)) {
      logger.warn(
        { err: error as Error, rateLimit: true, prRef },
        'overseer.reconcile.rate_limit_skip'
      );
      return 'rate_limit';
    }
    if (isAuthError(error)) {
      logger.warn(
        { err: error as Error, authError: true, prRef },
        'overseer.reconcile.auth_error_skip'
      );
      return 'auth';
    }
    logger.warn({ err: error as Error, prRef }, 'overseer.reconcile.supersede_list_failed');
    return 'continue';
  }

  for (const candidate of listed.items) {
    if (candidate.number === pr.number) continue;
    if (candidate.isDraft) continue;
    if (!headIsTargetRepo(candidate, pr.owner, pr.repo)) continue;
    const woId = firstMatchedSupersedeStem(candidate, stems);
    if (!woId) continue;
    if (!siblingCreatedBeforeMerge(candidate.createdAt, pr.mergedAt)) continue;
    const siblingRef = `${pr.owner}/${pr.repo}#${candidate.number}`;
    const already = await (deps.hasSupersedeBeenRecorded ?? hasDefaultSupersedeBeenRecorded)({
      prRef: siblingRef,
      woId,
    });
    if (already) continue;
    const comment = `Superseded by #${String(pr.number)}`;
    try {
      await deps.closePullRequest({
        owner: pr.owner,
        repo: pr.repo,
        number: candidate.number,
        comment,
      });
    } catch (error) {
      if (isRateLimitError(error)) {
        logger.warn(
          { err: error as Error, rateLimit: true, prRef: siblingRef },
          'overseer.reconcile.rate_limit_skip'
        );
        return 'rate_limit';
      }
      if (isAuthError(error)) {
        logger.warn(
          { err: error as Error, authError: true, prRef: siblingRef },
          'overseer.reconcile.auth_error_skip'
        );
        return 'auth';
      }
      logger.warn(
        { err: error as Error, woId, prNumber: candidate.number },
        'overseer.reconcile.supersede_close_failed'
      );
      continue;
    }
    await (deps.insertAction ?? insertDefaultOverseerAction)({
      prRef: siblingRef,
      woId,
      class: 'supersede',
      action: RECONCILE_SUPERSEDE_ACTION,
      result: `#${String(pr.number)}`,
    });
    logger.info?.(
      { woId, prNumber: candidate.number, reason: 'superseded_by_merge' },
      'overseer.reconcile.supersede_close'
    );
  }
  return 'continue';
}

const RECONCILE_LINE_MAX = 4096;

function collectStemsFromLines(input: string, linePattern: RegExp): Set<string> {
  const stems = new Set<string>();
  for (const line of input.split('\n')) {
    if (line.length > RECONCILE_LINE_MAX) continue;
    const match = linePattern.exec(line.trim());
    const list = match?.[1];
    if (!list) continue;
    // Upper-case before stem matching so `reconcile-skip: wo-foo-01` names the
    // same tracker as `WO-FOO-01`. Comma/space separation falls out of the stem
    // pattern itself: anything between ids that is not a stem is ignored.
    for (const stem of extractWoStems(list.toUpperCase())) stems.add(stem);
  }
  return stems;
}

export interface PullRequestStemClassification {
  /** Stems this merged PR is satisfaction evidence for. */
  evidence: string[];
  /** Stems the author excluded with `Reconcile-Skip:`. Never evidence. */
  skipped: string[];
  /**
   * Stems mentioned in passing while the body declares OTHER WO(s) on manifest
   * `WO:` lines. Never evidence.
   */
  incidental: string[];
}

/**
 * Classify the WO stems a merged PR names. Used by the open-PR holder guard and
 * for incidental-mention logging; the merged-PR CLOSE decision is driven by the
 * keyword-close path (extractClosingKeywordTrackerRefs), not by this function.
 *
 * 1. `Reconcile-Skip: <id>` removes <id> from the candidate set, whatever else
 *    the body says. The PR still counts for every other stem it names.
 * 2. The candidate set is the stems in the title plus any manifest v2 `WO:`
 *    declaration. A bare prose mention is NEVER a candidate (rule 3 removed,
 *    WO-HARNESS-STAGING-CLOSES-LINK-01): a name-mention does not make a PR
 *    evidence for a WO. Anchor (2026-09-02): a reply to an Overseer finding on
 *    shopops#662 mentioned WO-LSPRO-M157-STREAM-STAYS-OPEN-UI-01 in prose and
 *    reconcile closed bdc-xo #1889 on it.
 * Everything mentioned that is not a candidate and not skipped is `incidental`.
 */
export function classifyPullRequestStems(
  pr: Pick<ReconcileMergedPullRequest, 'title' | 'body'>
): PullRequestStemClassification {
  const body = pr.body ?? '';
  const mentioned = extractWoStems(`${pr.title}\n${body}`);
  const skipped = extractReconcileSkipStems(body);
  const declared = extractDeclaredWoStems(body);
  const candidates = [...new Set([...extractWoStems(pr.title), ...declared])];
  const candidateSet = new Set(candidates);
  return {
    evidence: candidates.filter(stem => !skipped.has(stem)),
    skipped: [...skipped],
    incidental: mentioned.filter(stem => !candidateSet.has(stem) && !skipped.has(stem)),
  };
}

/**
 * Open PRs that still count as unfinished work for this tracker.
 * The just-merged PR is never a holder. A candidate holds the tracker when
 * classifyPullRequestStems evidence contains the stem, or when a body line
 * uses Closes/Fixes/Resolves and the exact owner/repo#number token.
 */
export function openPullRequestsHoldingTracker(input: {
  stem: string;
  mergedPr: Pick<ReconcileMergedPullRequest, 'owner' | 'repo' | 'number'>;
  tracker: Pick<ReconcileTrackerIssue, 'owner' | 'repo' | 'number'>;
  openPullRequests: readonly ReconcileOpenPullRequest[];
}): ReconcileOpenPullRequest[] {
  const token = `${input.tracker.owner}/${input.tracker.repo}#${input.tracker.number}`;
  const holders: ReconcileOpenPullRequest[] = [];
  for (const candidate of input.openPullRequests) {
    if (
      candidate.owner === input.mergedPr.owner &&
      candidate.repo === input.mergedPr.repo &&
      candidate.number === input.mergedPr.number
    ) {
      continue;
    }
    const evidence = classifyPullRequestStems({
      title: candidate.title,
      body: candidate.body,
    }).evidence;
    // Same-repo `Fixes #N` in a tracker-repo PR resolves through the same parser
    // the close path uses, so any reference that could CLOSE the tracker also
    // HOLDS it while the PR is open.
    const keywordRefs = extractClosingKeywordTrackerRefs(
      candidate.body ?? '',
      candidate.owner,
      candidate.repo
    );
    const trackerIsDefault =
      input.tracker.owner.toLowerCase() === DEFAULT_ORG &&
      input.tracker.repo.toLowerCase() === DEFAULT_TRACKER_REPO;
    if (
      evidence.includes(input.stem) ||
      bodyClosesTracker(candidate.body ?? '', token) ||
      (trackerIsDefault && keywordRefs.includes(input.tracker.number))
    ) {
      holders.push(candidate);
    }
  }
  return holders;
}

function bodyClosesTracker(body: string, token: string): boolean {
  for (const rawLine of body.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.length > RECONCILE_LINE_MAX) continue;
    if (lineClosesTracker(line, token)) return true;
  }
  return false;
}

function lineClosesTracker(line: string, token: string): boolean {
  // Non-global so lastIndex cannot leak across lines. All nine GitHub closing
  // keyword forms (close/closes/closed, fix/fixes/fixed, resolve/resolves/resolved).
  const match = new RegExp(`\\b${CLOSING_KEYWORD_SOURCE}\\b`, 'i').exec(line);
  if (!match || token.length === 0) return false;
  const rest = line.slice(match.index + match[0].length);
  let from = 0;
  while (from <= rest.length) {
    const index = rest.indexOf(token, from);
    if (index < 0) return false;
    const at = match.index + match[0].length + index;
    const prev = at === 0 ? '' : line.charAt(at - 1);
    const next = line.charAt(at + token.length);
    // Leading boundary so evilthinmansoftware/bdc-xo#1044 does not match
    // thinmansoftware/bdc-xo#1044. Trailing boundary so #1044 does not match
    // the prefix of #10440.
    const leadingOk = prev === '' || /[^A-Za-z0-9_]/.test(prev);
    const trailingOk = next === '' || /[^A-Za-z0-9_]/.test(next);
    if (leadingOk && trailingOk) return true;
    from = index + 1;
  }
  return false;
}

export function buildEvidenceComment(input: {
  pr: ReconcileMergedPullRequest;
  stem: string;
}): string {
  return [
    `Overseer reconcile closed tracker for ${input.stem}.`,
    '',
    `Merged PR: ${input.pr.htmlUrl}`,
    `Repository: ${input.pr.owner}/${input.pr.repo}`,
    `Merge SHA: ${input.pr.mergeCommitSha ?? 'unknown'}`,
  ].join('\n');
}

export function buildHoldOpenComment(input: {
  pr: ReconcileMergedPullRequest;
  stem: string;
  holders: readonly ReconcileOpenPullRequest[];
}): string {
  const lines = [
    `Overseer reconcile: stage merged, ${input.holders.length} PRs still open for ${input.stem}.`,
    '',
    `Merged PR: ${input.pr.htmlUrl}`,
    '',
    'Still open:',
    ...input.holders.map(h => `- ${h.owner}/${h.repo}#${h.number} ${h.htmlUrl}`),
  ];
  return lines.join('\n');
}

export async function readReconcileCursorFromActions(): Promise<string | null> {
  const { getDatabase } = await import('@archon/core/db/connection');
  const db = getDatabase();
  const result = await db.query<{ cursor: string | null }>(
    'SELECT MAX(created_at) AS cursor FROM overseer_reconcile_actions WHERE action IN ($1, $2)',
    [RECONCILE_ACTION, RECONCILE_MERGED_ACTION]
  );
  return result.rows[0]?.cursor ?? null;
}

async function insertDefaultOverseerAction(record: ReconcileActionRecord): Promise<unknown> {
  const { insertReconcileAction } = await import('@archon/core/db/overseer');
  return insertReconcileAction(record);
}

async function hasDefaultSkipBeenNoted(input: { prRef: string; woId: string }): Promise<boolean> {
  const { hasReconcileActionForPr } = await import('@archon/core/db/overseer');
  return hasReconcileActionForPr({
    prRef: input.prRef,
    woId: input.woId,
    action: RECONCILE_SKIP_ACTION,
  });
}

async function hasDefaultCloseBeenRecorded(input: {
  prRef: string;
  woId: string;
}): Promise<boolean> {
  const { hasReconcileActionForPr } = await import('@archon/core/db/overseer');
  return hasReconcileActionForPr({
    prRef: input.prRef,
    woId: input.woId,
    action: RECONCILE_ACTION,
  });
}

async function hasDefaultMergedBeenNoted(input: { prRef: string; woId: string }): Promise<boolean> {
  const { hasReconcileActionForPr } = await import('@archon/core/db/overseer');
  return hasReconcileActionForPr({
    prRef: input.prRef,
    woId: input.woId,
    action: RECONCILE_MERGED_ACTION,
  });
}

async function hasDefaultHoldBeenNoted(input: { prRef: string; woId: string }): Promise<boolean> {
  const { hasReconcileActionForPr } = await import('@archon/core/db/overseer');
  return hasReconcileActionForPr({
    prRef: input.prRef,
    woId: input.woId,
    action: RECONCILE_HOLD_OPEN_ACTION,
  });
}

async function hasDefaultKeywordMissingBeenNoted(input: {
  prRef: string;
  woId: string;
}): Promise<boolean> {
  const { hasReconcileActionForPr } = await import('@archon/core/db/overseer');
  return hasReconcileActionForPr({
    prRef: input.prRef,
    woId: input.woId,
    action: RECONCILE_KEYWORD_MISSING_ACTION,
  });
}

async function hasDefaultSupersedeBeenRecorded(input: {
  prRef: string;
  woId: string;
}): Promise<boolean> {
  const { hasReconcileActionForPr } = await import('@archon/core/db/overseer');
  return hasReconcileActionForPr({
    prRef: input.prRef,
    woId: input.woId,
    action: RECONCILE_SUPERSEDE_ACTION,
  });
}

/**
 * Comment, then close. A retry after a successful comment and a failed close
 * does not post the comment again when that body is already in the pages read.
 * A truncated listing is not proof the comment exists: when the body is absent
 * from the returned pages, it is posted before the close. The caller records
 * the action only after this returns, so a failed close stays eligible for
 * another pass.
 */
export async function closeSupersededPullRequest(
  client: OctokitLike,
  input: { owner: string; repo: string; number: number; comment: string }
): Promise<void> {
  const wanted = input.comment.trim();
  let skipComment = false;
  if (client.issues.listComments) {
    const existing = await listIssueComments(client, {
      owner: input.owner,
      repo: input.repo,
      number: input.number,
      title: '',
      state: 'open',
    });
    const found = existing.items.some(comment => comment.body.trim() === wanted);
    // Truncation must not skip the post. The comment may be absent entirely,
    // and closing without it drops the required supersede note.
    skipComment = found;
  }
  if (!skipComment) {
    await client.issues.createComment({
      owner: input.owner,
      repo: input.repo,
      issue_number: input.number,
      body: input.comment,
    });
  }
  await client.issues.update({
    owner: input.owner,
    repo: input.repo,
    issue_number: input.number,
    state: 'closed',
  });
}

export function createDefaultReconcileDeps(): ReconcileDeps {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const appConfigured = ['GITHUB_APP_', 'GITHUB_APP_OVERSEER_'].some(prefix =>
    ['ID', 'INSTALLATION_ID', 'PRIVATE_KEY', 'PRIVATE_KEY_PATH'].some(suffix =>
      Boolean(process.env[`${prefix}${suffix}`]?.trim())
    )
  );
  if (!token && !appConfigured) {
    return {
      readCursor: async () => null,
      searchMergedPullRequests: async (): Promise<ReconcileMergedPullRequest[]> => {
        log.warn({ rateLimit: false }, 'overseer.reconcile.github_token_missing');
        return [];
      },
      findTrackerIssueByStem: async () => null,
      findTrackerIssueByNumber: async () => null,
      addTrackerEvidenceComment: async () => undefined,
      addTrackerLabel: async () => undefined,
      closeTrackerIssue: async () => undefined,
      hasSkipBeenNoted: async () => false,
      hasCloseBeenRecorded: async () => false,
      hasKeywordMissingBeenNoted: async () => false,
      listOpenPullRequestsInRepo: async () => [],
      closePullRequest: async () => undefined,
      hasSupersedeBeenRecorded: async () => false,
      insertAction: insertDefaultOverseerAction,
      log,
    };
  }

  let octokit: Promise<OctokitLike> | null = null;
  const trackerSnapshots = new WeakMap<object, Promise<TrackerIssueSnapshot>>();
  const getOctokit = async (): Promise<OctokitLike> => {
    octokit ??= Promise.all([import('@octokit/rest'), import('@archon/core/github/request')]).then(
      ([module, transport]) => {
        // Octokit supplies URL + RequestInit; the existing service transport owns
        // authentication and quota state, including fail-closed App validation.
        const requestFetch = async (
          input: string | URL | Request,
          init?: RequestInit
        ): Promise<Response> => {
          const url = input instanceof Request ? input.url : input;
          const path = new URL(String(url)).pathname;
          const method = (init?.method ?? 'GET').toUpperCase();
          const trackerWrite =
            (method === 'POST' &&
              /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/(comments|labels)$/.test(path)) ||
            (method === 'PATCH' && /^\/repos\/[^/]+\/[^/]+\/issues\/\d+$/.test(path)) ||
            (method === 'DELETE' &&
              /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/labels\/[^/]+$/.test(path));
          const request = trackerWrite
            ? transport.serviceGitHubFetchWithPermissionFallback
            : transport.serviceGitHubFetch;
          return request({ service: 'overseer', url, init });
        };
        return new module.Octokit({ request: { fetch: requestFetch } }) as unknown as OctokitLike;
      }
    );
    return octokit;
  };
  return {
    readCursor: readReconcileCursorFromActions,
    searchMergedPullRequests: async (input): Promise<ReconcileMergedPullRequest[]> => {
      const read = await searchMergedPullRequestsPaged(await getOctokit(), input);
      // Discovery only: a capped search can omit PRs (no change for those); every
      // decision is made per PR on that PR's own complete data.
      if (read.truncated)
        log.warn({ found: read.items.length }, 'overseer.reconcile.merged_search_truncated');
      return read.items;
    },
    findTrackerIssueByStem: async (stem, scope): Promise<ReconcileTrackerIssue | null> => {
      let snapshot = scope ? trackerSnapshots.get(scope) : undefined;
      if (!snapshot) {
        // Store before awaiting: concurrent lookups share completion or failure.
        // A direct no-scope call always reads anew; reused factories cannot cache
        // tracker state across runReconcileOnce invocations.
        snapshot = getOctokit().then(client => readTrackerIssueSnapshot(client));
        if (scope) trackerSnapshots.set(scope, snapshot);
      }
      return findTrackerIssueByStem(await snapshot, stem);
    },
    findTrackerIssueByNumber: async (number, scope): Promise<ReconcileTrackerIssue | null> => {
      // Share the per-run snapshot with findTrackerIssueByStem via the same scope,
      // so a reconcile pass makes ONE tracker REST scan for both lookups.
      let snapshot = scope ? trackerSnapshots.get(scope) : undefined;
      if (!snapshot) {
        snapshot = getOctokit().then(client => readTrackerIssueSnapshot(client));
        if (scope) trackerSnapshots.set(scope, snapshot);
      }
      return findTrackerIssueByNumber(await snapshot, number);
    },
    listOpenPullRequestsReferencingTracker: async input =>
      searchOpenPullRequestsReferencingTracker(await getOctokit(), input),
    listPullRequestFiles: async (pr): Promise<PagedRead<string>> =>
      listPullRequestFilePaths(await getOctokit(), pr),
    addTrackerEvidenceComment: async (input): Promise<void> => {
      const client = await getOctokit();
      await client.issues.createComment({
        owner: input.issue.owner,
        repo: input.issue.repo,
        issue_number: input.issue.number,
        body: input.body,
      });
    },
    addTrackerLabel: async (input): Promise<void> => {
      const client = await getOctokit();
      await client.issues.addLabels({
        owner: input.issue.owner,
        repo: input.issue.repo,
        issue_number: input.issue.number,
        labels: [input.label],
      });
    },
    closeTrackerIssue: async (input): Promise<void> => {
      const client = await getOctokit();
      await client.issues.update({
        owner: input.issue.owner,
        repo: input.issue.repo,
        issue_number: input.issue.number,
        state: 'closed',
        state_reason: 'completed',
      });
    },
    hasSkipBeenNoted: hasDefaultSkipBeenNoted,
    hasCloseBeenRecorded: hasDefaultCloseBeenRecorded,
    hasHoldBeenNoted: hasDefaultHoldBeenNoted,
    hasKeywordMissingBeenNoted: hasDefaultKeywordMissingBeenNoted,
    hasMergedBeenNoted: hasDefaultMergedBeenNoted,
    listOpenPullRequestsInRepo: async (input): Promise<PagedRead<ReconcileRepoOpenPullRequest>> =>
      listRepoOpenPullRequests(await getOctokit(), input.owner, input.repo),
    closePullRequest: async (input): Promise<void> => {
      await closeSupersededPullRequest(await getOctokit(), input);
    },
    hasSupersedeBeenRecorded: hasDefaultSupersedeBeenRecorded,
    removeTrackerLabel: async (input): Promise<void> => {
      const client = await getOctokit();
      if (!client.issues.removeLabel) return;
      try {
        await client.issues.removeLabel({
          owner: input.issue.owner,
          repo: input.issue.repo,
          issue_number: input.issue.number,
          name: input.label,
        });
      } catch (error) {
        // 404 = the label was not on the issue; that is the desired end state.
        if ((error as { status?: number }).status !== 404) throw error;
      }
    },
    listMergedAwaitingProof: async (): Promise<PagedRead<ReconcileTrackerIssue>> =>
      listOpenMergedTrackers(await getOctokit()),
    listTrackerComments: async (input): Promise<PagedRead<ReconcileTrackerComment>> =>
      listIssueComments(await getOctokit(), input.issue),
    wasClosedByPullRequestMerge: async (input): Promise<CloseEventRead> => {
      const read = await readLatestCloseEvent(await getOctokit(), input.issue);
      return {
        closedByThisPr: read.sha !== null && read.sha === input.pr.mergeCommitSha,
        truncated: read.truncated,
      };
    },
    reopenTrackerIssue: async (input): Promise<void> => {
      const client = await getOctokit();
      await client.issues.update({
        owner: input.issue.owner,
        repo: input.issue.repo,
        issue_number: input.issue.number,
        state: 'open',
      });
    },
    insertAction: insertDefaultOverseerAction,
    log,
  };
}

const READ_PAGE_SIZE = 100;
const READ_MAX_PAGES = 10;
/** GitHub's pulls.listFiles returns at most 3000 files (30 pages of 100). */
const PR_FILES_MAX_PAGES = 30;

/**
 * THE one paginator for capped reconcile reads. Complete only when a short page is
 * seen; a full page at the cap, or a malformed page, is `truncated: true`.
 */
async function readPages<T>(
  fetchPage: (page: number) => Promise<unknown>,
  map: (row: Record<string, unknown>) => T | null,
  maxPages: number = READ_MAX_PAGES
): Promise<PagedRead<T>> {
  const items: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const data = await fetchPage(page);
    if (!Array.isArray(data)) return { items, truncated: true };
    for (const row of data as Record<string, unknown>[]) {
      const value = map(row);
      if (value !== null) items.push(value);
    }
    if (data.length < READ_PAGE_SIZE) return { items, truncated: false };
  }
  return { items, truncated: true };
}

export function asPagedRead<T>(value: T[] | PagedRead<T>): PagedRead<T> {
  return Array.isArray(value) ? { items: value, truncated: false } : value;
}

function mapRepoOpenPullRequest(row: Record<string, unknown>): ReconcileRepoOpenPullRequest | null {
  if (typeof row.number !== 'number' || !Number.isSafeInteger(row.number)) return null;
  const head =
    row.head && typeof row.head === 'object' ? (row.head as Record<string, unknown>) : undefined;
  const headRefName = typeof head?.ref === 'string' ? head.ref : '';
  const repoValue = head?.repo;
  const repoRecord =
    repoValue && typeof repoValue === 'object' ? (repoValue as Record<string, unknown>) : undefined;
  const fullName = typeof repoRecord?.full_name === 'string' ? repoRecord.full_name : '';
  const slash = fullName.indexOf('/');
  const owner = slash > 0 ? fullName.slice(0, slash) : '';
  const repo = slash > 0 ? fullName.slice(slash + 1) : '';
  return {
    number: row.number,
    body: typeof row.body === 'string' ? row.body : null,
    headRefName,
    isDraft: row.draft === true,
    headRepository: owner.length > 0 && repo.length > 0 ? { owner, repo } : null,
    createdAt: typeof row.created_at === 'string' ? row.created_at : null,
  };
}

/** Paginated open PRs for the supersede pass. A missing list method is a failed read. */
async function listRepoOpenPullRequests(
  octokit: OctokitLike,
  owner: string,
  repo: string
): Promise<PagedRead<ReconcileRepoOpenPullRequest>> {
  if (!octokit.pulls.list) return { items: [], truncated: true };
  return readPages(
    async page =>
      (
        await octokit.pulls.list?.({
          owner,
          repo,
          state: 'open',
          per_page: READ_PAGE_SIZE,
          page,
        })
      )?.data,
    mapRepoOpenPullRequest
  );
}

/** Reader 1: open tracker issues labelled status:merged (LIVE-PROOF pass input). */
export async function listOpenMergedTrackers(
  octokit: OctokitLike
): Promise<PagedRead<ReconcileTrackerIssue>> {
  if (!octokit.issues.listForRepo) return { items: [], truncated: true };
  return readPages(
    async page =>
      (
        await octokit.issues.listForRepo?.({
          owner: DEFAULT_ORG,
          repo: DEFAULT_TRACKER_REPO,
          state: 'open',
          labels: MERGED_LABEL,
          per_page: READ_PAGE_SIZE,
          page,
        })
      )?.data,
    row => {
      if (row.pull_request !== undefined) return null;
      if (!Number.isSafeInteger(row.number) || typeof row.title !== 'string') return null;
      return {
        owner: DEFAULT_ORG,
        repo: DEFAULT_TRACKER_REPO,
        number: row.number as number,
        title: row.title,
        state: row.state === 'closed' ? 'closed' : 'open',
        createdAt: typeof row.created_at === 'string' ? row.created_at : null,
      };
    }
  );
}

/** Reader 2: commit sha of the most recent `closed` event (A2.1 reopen input). */
export async function readLatestCloseEvent(
  octokit: OctokitLike,
  issue: ReconcileTrackerIssue
): Promise<{ sha: string | null; truncated: boolean }> {
  if (!octokit.issues.listEvents) return { sha: null, truncated: true };
  const read = await readPages(
    async page =>
      (
        await octokit.issues.listEvents?.({
          owner: issue.owner,
          repo: issue.repo,
          issue_number: issue.number,
          per_page: READ_PAGE_SIZE,
          page,
        })
      )?.data,
    row =>
      row.event === 'closed'
        ? { sha: typeof row.commit_id === 'string' ? row.commit_id : null }
        : null
  );
  const last = read.items[read.items.length - 1];
  return { sha: last ? last.sha : null, truncated: read.truncated };
}

/** Reader 3: comments on a tracker issue, oldest first (LIVE-PROOF input). */
export async function listIssueComments(
  octokit: OctokitLike,
  issue: ReconcileTrackerIssue
): Promise<PagedRead<ReconcileTrackerComment>> {
  if (!octokit.issues.listComments) return { items: [], truncated: true };
  return readPages(
    async page =>
      (
        await octokit.issues.listComments?.({
          owner: issue.owner,
          repo: issue.repo,
          issue_number: issue.number,
          per_page: READ_PAGE_SIZE,
          page,
        })
      )?.data,
    row => {
      const user = row.user as { login?: unknown } | null | undefined;
      return {
        author: typeof user?.login === 'string' ? user.login : '',
        body: typeof row.body === 'string' ? row.body : '',
        htmlUrl: typeof row.html_url === 'string' ? row.html_url : '',
        createdAt: typeof row.created_at === 'string' ? row.created_at : '',
      };
    }
  );
}

/** Reader 4: changed file paths of a merged PR (spec-only guard input). */
export async function listPullRequestFilePaths(
  octokit: OctokitLike,
  pr: Pick<ReconcileMergedPullRequest, 'owner' | 'repo' | 'number'>
): Promise<PagedRead<string>> {
  return readPages(
    async page =>
      (
        await octokit.pulls.listFiles({
          owner: pr.owner,
          repo: pr.repo,
          pull_number: pr.number,
          per_page: READ_PAGE_SIZE,
          page,
        })
      ).data,
    row => (typeof row.filename === 'string' ? row.filename : null),
    PR_FILES_MAX_PAGES
  );
}

async function resolveSearchSince(input: RunReconcileInput, deps: ReconcileDeps): Promise<string> {
  const now = deps.now?.() ?? new Date();
  const dayMs = 24 * 60 * 60 * 1000;
  // Floor: always rescan at least the last RECONCILE_MIN_LOOKBACK_DAYS so a PR
  // that merged shortly BEFORE the newest reconcile_close is not skipped. The
  // re-close / already-closed guards make the overlap idempotent.
  const floorDays = Number.isFinite(RECONCILE_MIN_LOOKBACK_DAYS) ? RECONCILE_MIN_LOOKBACK_DAYS : 7;
  const floor = new Date(now.getTime() - floorDays * dayMs).toISOString().slice(0, 10);

  const cursor = await (deps.readCursor ?? readReconcileCursorFromActions)();
  if (cursor) {
    const cursorDate = cursor.slice(0, 10);
    // `since` is the EARLIER (older) of the cursor and the floor.
    return cursorDate < floor ? cursorDate : floor;
  }

  const lookbackDays = input.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const since = new Date(now.getTime() - lookbackDays * dayMs);
  return since.toISOString().slice(0, 10);
}

/** Reader 5: merged PRs for reconcile, with the capped-search flag. */
export async function searchMergedPullRequests(
  octokit: OctokitLike,
  input: { org: string; since: string }
): Promise<ReconcileMergedPullRequest[]> {
  return (await searchMergedPullRequestsPaged(octokit, input)).items;
}

export async function searchMergedPullRequestsPaged(
  octokit: OctokitLike,
  input: { org: string; since: string }
): Promise<PagedRead<ReconcileMergedPullRequest>> {
  const queries = [
    `org:${input.org} is:pr is:merged merged:>=${input.since} WO- in:title`,
    `org:${input.org} is:pr is:merged merged:>=${input.since} WO- in:body`,
    // Keyword-close PRs need NOT name a WO stem: `Fixes #4999` (a tracker-repo PR)
    // or `Closes thinmansoftware/bdc-xo#4999` (cross-repo) carry no `WO-` text, so
    // the two WO- queries above never return them. Without these the keyword-close
    // path (extractClosingKeywordTrackerRefs) has nothing to act on in production.
    //   - same-repo `#N` closes only resolve in the tracker repo, so scan it whole
    //   - cross-repo `<org>/<tracker>#N` refs contain the tracker-repo name in body
    `repo:${DEFAULT_ORG}/${DEFAULT_TRACKER_REPO} is:pr is:merged merged:>=${input.since}`,
    `org:${input.org} is:pr is:merged merged:>=${input.since} ${DEFAULT_TRACKER_REPO} in:body`,
  ];
  const results = new Map<string, ReconcileMergedPullRequest>();
  let truncated = false;

  for (const q of queries) {
    let complete = false;
    // Paginate each query to GitHub's 1000-result cap (10 pages of 100). Before,
    // only page 1 was read, so a merged PR beyond the first 100 results was never
    // seen and its tracker never closed (bdc-xo #4130 / shopops #948 miss).
    for (let page = 1; page <= OPEN_PR_SEARCH_MAX_PAGES; page++) {
      const search = await octokit.search.issuesAndPullRequests({
        q,
        per_page: OPEN_PR_SEARCH_PAGE_SIZE,
        page,
        sort: 'updated',
        order: 'desc',
      });
      const items = search.data.items;
      for (const item of items) {
        if (!item.pull_request) continue;
        const repo = parseRepositoryFromUrl(item.repository_url);
        if (!repo) continue;
        const refKey = `${repo.owner}/${repo.repo}#${item.number}`;
        if (results.has(refKey)) continue;
        const pr = await octokit.pulls.get({
          owner: repo.owner,
          repo: repo.repo,
          pull_number: item.number,
        });
        results.set(refKey, {
          owner: repo.owner,
          repo: repo.repo,
          number: item.number,
          title: pr.data.title ?? item.title,
          body: pr.data.body ?? item.body,
          htmlUrl: pr.data.html_url,
          state: pr.data.state,
          merged: Boolean(pr.data.merged),
          mergeCommitSha: pr.data.merge_commit_sha,
          mergedAt: pr.data.merged_at,
          baseRef: pr.data.base?.ref ?? null,
        });
      }
      // Fewer than a full page means the query is exhausted.
      if (items.length < OPEN_PR_SEARCH_PAGE_SIZE) {
        complete = true;
        break;
      }
    }
    if (!complete) truncated = true;
  }

  return { items: [...results.values()], truncated };
}

// GitHub search returns at most 1000 results per query.
const OPEN_PR_SEARCH_PAGE_SIZE = 100;
const OPEN_PR_SEARCH_MAX_PAGES = 10;

export async function searchOpenPullRequestsReferencingTracker(
  octokit: OctokitLike,
  input: { issue: ReconcileTrackerIssue; stem: string }
): Promise<ReconcileOpenPullRequest[]> {
  const issueRef = `${input.issue.owner}/${input.issue.repo}#${input.issue.number}`;
  const queries = [
    `org:${DEFAULT_ORG} is:pr is:open ${input.stem}`,
    `org:${DEFAULT_ORG} is:pr is:open ${issueRef}`,
    // Same-repo `Fixes #N` holders live in the tracker repo and never spell the
    // owner/repo token; search that repo for the bare number and let
    // openPullRequestsHoldingTracker decide which candidates really hold it.
    `repo:${input.issue.owner}/${input.issue.repo} is:pr is:open ${input.issue.number}`,
  ];
  const results = new Map<string, ReconcileOpenPullRequest>();

  for (const q of queries) {
    // Paginate to exhaustion. If completeness cannot be established, throw so the
    // caller leaves the tracker open (a missed holder would close it prematurely).
    let retrieved = 0;
    let expectedTotal: number | undefined;
    const identities = new Set<string>();
    for (let page = 1; ; page++) {
      if (page > OPEN_PR_SEARCH_MAX_PAGES) {
        throw new Error(`open PR search exceeds retrievable results for query: ${q}`);
      }
      const search = await octokit.search.issuesAndPullRequests({
        q,
        per_page: OPEN_PR_SEARCH_PAGE_SIZE,
        page,
      });
      const data = search.data;
      if (
        !data ||
        typeof data !== 'object' ||
        data.incomplete_results !== false ||
        typeof data.total_count !== 'number' ||
        !Number.isSafeInteger(data.total_count) ||
        (data.total_count ?? -1) < 0 ||
        !Array.isArray(data.items) ||
        data.items.length > OPEN_PR_SEARCH_PAGE_SIZE
      ) {
        throw new Error(`open PR search returned incomplete or malformed results for query: ${q}`);
      }
      const total = data.total_count;
      if (total > OPEN_PR_SEARCH_PAGE_SIZE * OPEN_PR_SEARCH_MAX_PAGES) {
        throw new Error(`open PR search exceeds retrievable results for query: ${q}`);
      }
      if (expectedTotal !== undefined && total !== expectedTotal) {
        throw new Error(`open PR search total changed for query: ${q}`);
      }
      expectedTotal = total;
      retrieved += data.items.length;
      for (const item of data.items) {
        const candidate = validatedOpenSearchPullRequest(item);
        const key = `${candidate.owner}/${candidate.repo}#${candidate.number}`.toLowerCase();
        identities.add(key);
        const prior = results.get(key);
        if (
          prior &&
          (prior.title !== candidate.title ||
            prior.body !== candidate.body ||
            prior.htmlUrl.toLowerCase() !== candidate.htmlUrl.toLowerCase())
        ) {
          throw new Error(`open PR search returned conflicting copies for ${key}`);
        }
        results.set(key, candidate);
      }
      if (retrieved > total || identities.size > total) {
        throw new Error(`open PR search exceeds total_count for query: ${q}`);
      }
      if (identities.size === total) break;
      if (data.items.length < OPEN_PR_SEARCH_PAGE_SIZE) {
        throw new Error(`open PR search short page before distinct total_count for query: ${q}`);
      }
    }
  }

  return [...results.values()];
}

/** Malformed or stale holder evidence must never become permission to close a tracker. */
function validatedOpenSearchPullRequest(item: unknown): ReconcileOpenPullRequest {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new Error('open PR search returned malformed row');
  }
  const row = item as Record<string, unknown>;
  if (
    !Number.isSafeInteger(row.number) ||
    (row.number as number) <= 0 ||
    typeof row.title !== 'string' ||
    !(row.body === null || typeof row.body === 'string') ||
    row.state !== 'open' ||
    !row.pull_request ||
    typeof row.pull_request !== 'object' ||
    Array.isArray(row.pull_request) ||
    typeof row.repository_url !== 'string' ||
    typeof row.html_url !== 'string'
  ) {
    throw new Error('open PR search returned malformed row');
  }
  const repository =
    /^https:\/\/api\.github\.com\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(
      row.repository_url
    );
  const owner = repository?.[1];
  const repo = repository?.[2];
  if (
    !owner ||
    !repo ||
    repo === '.' ||
    repo === '..' ||
    owner.toLowerCase() !== DEFAULT_ORG ||
    row.html_url.toLowerCase() !==
      `https://github.com/${owner}/${repo}/pull/${row.number as number}`.toLowerCase()
  ) {
    throw new Error('open PR search returned inconsistent repository or PR identity');
  }
  return {
    owner,
    repo,
    number: row.number as number,
    title: row.title,
    body: row.body,
    htmlUrl: row.html_url,
  };
}

const TRACKER_ISSUE_PAGE_SIZE = 100;
const TRACKER_ISSUE_MAX_PAGES = 100;
interface TrackerSnapshotRow {
  readonly number: number;
  readonly title: string;
  readonly state: 'open' | 'closed';
  readonly htmlUrl: string;
  readonly pullRequest: boolean;
  readonly createdAt: string | null;
}
type TrackerIssueSnapshot = ReadonlyMap<number, TrackerSnapshotRow>;

async function readTrackerIssueSnapshot(octokit: OctokitLike): Promise<TrackerIssueSnapshot> {
  const issues = octokit.issues;
  if (!issues.listForRepo) throw new Error('tracker issue REST listing is unavailable');
  const rows = new Map<number, TrackerSnapshotRow>();
  // At most 100 logical core reads per invocation. Created order reduces churn;
  // REST pagination is not an atomic snapshot and issue numbers need not increase.
  for (let page = 1; page <= TRACKER_ISSUE_MAX_PAGES; page++) {
    const response = await issues.listForRepo({
      owner: DEFAULT_ORG,
      repo: DEFAULT_TRACKER_REPO,
      state: 'all',
      sort: 'created',
      direction: 'asc',
      per_page: TRACKER_ISSUE_PAGE_SIZE,
      page,
    });
    if (
      !response ||
      !Array.isArray(response.data) ||
      response.data.length > TRACKER_ISSUE_PAGE_SIZE
    ) {
      throw new Error('tracker issue REST listing returned a malformed page');
    }
    for (const value of response.data) {
      const row = validatedTrackerSnapshotRow(value);
      const prior = rows.get(row.number);
      if (
        prior &&
        (prior.title !== row.title ||
          prior.state !== row.state ||
          prior.htmlUrl.toLowerCase() !== row.htmlUrl.toLowerCase() ||
          prior.pullRequest !== row.pullRequest)
      ) {
        throw new Error(`tracker issue REST listing returned conflicting copies of ${row.number}`);
      }
      rows.set(row.number, row);
    }
    if (response.data.length < TRACKER_ISSUE_PAGE_SIZE) return rows;
  }
  throw new Error('tracker issue REST listing exceeded its complete-page budget');
}

function validatedTrackerSnapshotRow(value: unknown): TrackerSnapshotRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('tracker issue REST listing returned a malformed row');
  }
  const row = value as Record<string, unknown>;
  const pullRequest = row.pull_request !== undefined;
  const repositoryUrl = `https://api.github.com/repos/${DEFAULT_ORG}/${DEFAULT_TRACKER_REPO}`;
  const webUrl = `https://github.com/${DEFAULT_ORG}/${DEFAULT_TRACKER_REPO}/${pullRequest ? 'pull' : 'issues'}/${row.number}`;
  if (
    !Number.isSafeInteger(row.number) ||
    (row.number as number) <= 0 ||
    typeof row.title !== 'string' ||
    !(row.body === null || typeof row.body === 'string') ||
    (row.state !== 'open' && row.state !== 'closed') ||
    typeof row.repository_url !== 'string' ||
    row.repository_url.toLowerCase() !== repositoryUrl ||
    typeof row.html_url !== 'string' ||
    row.html_url.toLowerCase() !== webUrl.toLowerCase()
  ) {
    throw new Error('tracker issue REST listing returned a malformed identity or state');
  }
  if (pullRequest) {
    const detail = row.pull_request as Record<string, unknown> | null;
    const expected = `https://api.github.com/repos/${DEFAULT_ORG}/${DEFAULT_TRACKER_REPO}/pulls/${row.number}`;
    if (
      !detail ||
      typeof detail !== 'object' ||
      Array.isArray(detail) ||
      typeof detail.url !== 'string' ||
      detail.url.toLowerCase() !== expected.toLowerCase()
    ) {
      throw new Error('tracker issue REST listing returned malformed PR metadata');
    }
  }
  // Retain only identity/matching metadata, not potentially large unused bodies.
  return {
    number: row.number as number,
    title: row.title,
    state: row.state,
    htmlUrl: row.html_url,
    pullRequest,
    createdAt: typeof row.created_at === 'string' ? row.created_at : null,
  };
}

function findTrackerIssueByStem(
  snapshot: TrackerIssueSnapshot,
  stem: string
): ReconcileTrackerIssue | null {
  const matches = [...snapshot.values()].filter(row => !row.pullRequest && row.title === stem);
  if (matches.length > 1) throw new Error(`tracker issue title is ambiguous: ${stem}`);
  const exact = matches[0];
  if (!exact) return null;
  return {
    owner: DEFAULT_ORG,
    repo: DEFAULT_TRACKER_REPO,
    number: exact.number,
    title: exact.title,
    state: exact.state,
    createdAt: exact.createdAt,
  };
}

function findTrackerIssueByNumber(
  snapshot: TrackerIssueSnapshot,
  number: number
): ReconcileTrackerIssue | null {
  const row = snapshot.get(number);
  // Pull request rows are not tracker issues; a closing keyword referencing a PR
  // number never closes a WO tracker.
  if (!row || row.pullRequest) return null;
  return {
    owner: DEFAULT_ORG,
    repo: DEFAULT_TRACKER_REPO,
    number: row.number,
    title: row.title,
    state: row.state,
    createdAt: row.createdAt,
  };
}

function parseRepositoryFromUrl(url?: string): { owner: string; repo: string } | null {
  const match = /\/repos\/([^/]+)\/([^/]+)$/.exec(url ?? '');
  if (!match) return null;
  return { owner: match[1] ?? '', repo: match[2] ?? '' };
}

function isRateLimitError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as {
    status?: number;
    message?: string;
    response?: { headers?: unknown };
  };
  if (candidate.message?.includes('github_pool_backoff:')) return true;
  if (candidate.status === 403 || candidate.status === 429) {
    const message = candidate.message ?? '';
    if (/rate.limit|rateLimit|rate limit|secondary rate/i.test(message)) return true;
  }
  return false;
}

function isAuthError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { status?: number };
  if (candidate.status === 401) return true;
  if (candidate.status === 403 && !isRateLimitError(error)) return true;
  return false;
}

/**
 * True only when both times parse and the merge happened strictly before the
 * tracker issue was created. Missing or unparseable times return false so the
 * other guards decide (backward compatible with callers that omit them).
 */
export function mergedBeforeTrackerCreated(
  mergedAt: string | null | undefined,
  trackerCreatedAt: string | null | undefined
): boolean {
  if (!mergedAt || !trackerCreatedAt) return false;
  const merged = Date.parse(mergedAt);
  const created = Date.parse(trackerCreatedAt);
  if (Number.isNaN(merged) || Number.isNaN(created)) return false;
  return merged < created;
}
