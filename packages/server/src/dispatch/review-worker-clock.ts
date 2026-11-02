/**
 * Overseer review worker clock: claims run_review work, prepares an exact-head
 * sealed checkout, runs the judge and submits the verdict.
 *
 * REVIEW CHECKOUT CACHE (WO-HARNESS-REVIEW-CHECKOUT-CACHE-EVICTION-01).
 * Cached checkouts live at `<checkout root>/<owner>/<repo>/<40-hex headSha>`
 * (root = OVERSEER_REVIEW_CHECKOUT_ROOT, else `<OVERSEER_REVIEW_SPOOL>/checkouts`,
 * spool default /var/lib/overseer-review). An eviction pass runs before each
 * checkout is prepared and once per tick after the queue drain:
 *
 * - OVERSEER_REVIEW_CHECKOUT_CACHE_MAX_BYTES (default 3221225472 = 3GB): total
 *   cache cap. Over it, least-recently-used checkouts (directory mtime, touched
 *   on creation and on every reuse) are evicted first, but the newest 2 per
 *   owner/repo are always kept. If the cap still cannot be met the pass logs
 *   `overseer_review_checkout_cache_over_cap` with the total and stops.
 * - Merged or closed PR -> evicted; superseded head (the PR's live head is a
 *   different, also-cached checkout) -> evicted. The PR is read from GitHub at
 *   most once per OVERSEER_REVIEW_CHECKOUT_STATE_SWEEP_MS (default 900000 =
 *   15 minutes); a lookup failure KEEPS the directory and logs
 *   `overseer_review_checkout_state_unknown`.
 * - Never evicted: a checkout bound to an in-flight run_review (claimed, lease
 *   not expired) or to the review being prepared. Never walked or touched:
 *   anything that is not a 40-hex directory under `<root>/<owner>/<repo>/`
 *   (job scratch `<spool>/<id>.scratch`, in-progress `*.tmp-*`, symlinks).
 * - Each eviction logs `overseer_review_checkout_evicted` with owner, repo,
 *   headSha, reason (merged, closed, superseded, cap) and bytesFreed; a pass
 *   that evicted anything logs `overseer_review_checkout_eviction_pass` with
 *   freedBytes and totalBytes.
 *
 * SMALLER CHECKOUTS. New checkouts fetch head and base with `--depth 1` and
 * `--filter=blob:none`, then prefetch the base..head diff blobs so
 * `git diff <base> <head>` works offline. OVERSEER_REVIEW_SPARSE_EXCLUDES
 * (comma-separated `owner/repo:path` entries, default
 * `thinmansoftware/bdc-xo:generations/`, empty string = none) enables a
 * non-cone sparse-checkout that leaves those paths out of the worktree.
 */
import {
  claimMessage,
  deferMessage,
  heartbeatWorker,
  listMessages,
  postResult,
  registerWorker,
  releaseMessage,
  renewMessageLease,
  type DispatchMessage,
  type DispatchTaskOutcome,
} from '@archon/core/db/dispatch';
import {
  createDurableSweepCursor,
  createRealStaleVerdictSweepDeps,
  resolveStaleSweepMax,
  runStaleVerdictSweep,
} from './stale-verdict-sweep-wiring';
import { createLogger } from '@archon/paths';
import {
  applyLadderRestoredRequest,
  recoverParkedJudgeHeads,
} from '@archon/overseer/judge-ladder-health';
import { defaultReviewLadder } from '@archon/overseer/pr-review-evaluator';
import type { IngestDeps } from '@archon/overseer/pr-review-ingest';
import {
  createRealIngestDeps,
  createRealSubmitDeps,
  parseReviewWorkBody,
  REVIEW_RECIPIENT,
  type ReviewRouteConfig,
} from '@archon/overseer/pr-review-wiring';
import {
  runAndSubmitReview,
  type ReviewWorkItem,
  type SubmitDisposition,
  type SubmitOutcome,
} from '@archon/overseer/pr-review-submit';
import { createRealOctokitClient } from '@archon/overseer/adapters/github-real-deps';
import {
  chmod,
  lstat,
  mkdir,
  opendir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const log = createLogger('dispatch/review-worker-clock');
const REVIEW_WORKER_ID = 'overseer-review-worker';
const REVIEW_TASK_TYPE = 'run_review';
// How long a checks-pending review item is held back before it becomes
// re-claimable, so the worker does not re-poll the checks API every tick.
const CHECKS_PENDING_BACKOFF_MS = Math.max(
  1_000,
  Number(process.env.OVERSEER_REVIEW_CHECKS_PENDING_BACKOFF_MS) || 60_000
);
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

export const REVIEW_CHECK_PLAN_PATH = '.github/overseer-review-check-plan.json';

export type TrustedCheckPlan =
  | { status: 'absent'; commands: readonly (readonly string[])[] }
  | { status: 'present'; commands: readonly (readonly string[])[] }
  | { status: 'unsafe'; commands: readonly (readonly string[])[] };

export function parseTrustedCheckPlan(raw: string): TrustedCheckPlan {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value) || value.length === 0) return { status: 'unsafe', commands: [] };
    if (
      !value.every(
        command =>
          Array.isArray(command) &&
          command.length > 0 &&
          !['sh', 'bash', 'zsh', 'cmd', 'cmd.exe', 'powershell', 'pwsh'].includes(command[0]) &&
          command.every(
            argument =>
              typeof argument === 'string' &&
              argument.length > 0 &&
              !argument.includes('\0') &&
              argument.length <= 4096
          )
      )
    ) {
      return { status: 'unsafe', commands: [] };
    }
    return { status: 'present', commands: value as string[][] };
  } catch {
    return { status: 'unsafe', commands: [] };
  }
}

export async function readTrustedCheckPlan(checkoutPath: string): Promise<TrustedCheckPlan> {
  if (!checkoutPath) return { status: 'unsafe', commands: [] };
  const planPath = join(checkoutPath, REVIEW_CHECK_PLAN_PATH);
  try {
    // Containment by lstat, never by comparing realpath strings: Windows can
    // return a short (8.3) name for one path and the long name for the other.
    // The checkout root is server-created; if neither `.github` nor the plan
    // is a symlink, the plan cannot resolve outside the checkout.
    const planDir = await lstat(dirname(planPath));
    if (planDir.isSymbolicLink() || !planDir.isDirectory())
      return { status: 'unsafe', commands: [] };
    const info = await lstat(planPath);
    if (!info.isFile()) return { status: 'unsafe', commands: [] };
    return parseTrustedCheckPlan(await readFile(planPath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { status: 'absent', commands: [] };
    return { status: 'unsafe', commands: [] };
  }
}

interface ReviewWorkerLogger {
  warn(data: Record<string, unknown>, message: string): void;
}

export interface ReviewWorkerDeps {
  registerWorker: typeof registerWorker;
  heartbeatWorker: typeof heartbeatWorker;
  listMessages: typeof listMessages;
  claimMessage: typeof claimMessage;
  postResult: typeof postResult;
  releaseMessage: typeof releaseMessage;
  /**
   * Fenced claimed->queued deferral with a future clock. Named per
   * WO-HARNESS-OVERSEER-REVIEW-CHECK-DEFERRAL-01 Section 7; delegates to
   * `releaseMessage`, which already carries the required fencing guards.
   */
  deferMessage: typeof deferMessage;
  renewMessageLease?: typeof renewMessageLease;
  runAndSubmitReview: typeof runAndSubmitReview;
  createSubmitDeps: (reviewerIdentity: string) => ReturnType<typeof createRealSubmitDeps>;
  prepareCheckout?: (input: {
    owner: string;
    repo: string;
    prNumber: number;
    headSha: string;
    baseRef: string;
    baseSha: string;
  }) => Promise<string>;
  /**
   * Trusted base capture for queued work that omits baseSha (check-completion
   * and ladder-recovery re-reviews). The parent asks GitHub with its own
   * installation credential; the answer becomes this review's captured base.
   * Absent or failing = the checkout cannot be prepared (review_incomplete).
   */
  resolveReviewBase?: (input: {
    owner: string;
    repo: string;
    prNumber: number;
  }) => Promise<{ baseRef: string; baseSha: string }>;
  /** Optional logger seam for deterministic observability tests. */
  logger?: ReviewWorkerLogger;
  /**
   * Backstop for lost check-completion deliveries (#782 part 3). Optional so a
   * test double can omit it; when absent the sweep simply does not run and the
   * primary review path is untouched.
   */
  staleVerdictSweep?: (config: ReviewRouteConfig) => Promise<unknown>;
  /**
   * Re-enqueue heads parked by the judge-ladder breaker once the ladder is
   * open again (#847). Optional for the same reason as the sweep; when absent
   * parked heads wait for an operator `ladder_restored` row.
   */
  judgeLadderRecovery?: (config: ReviewRouteConfig) => Promise<unknown>;
  /**
   * Review checkout cache eviction (WO-HARNESS-REVIEW-CHECKOUT-CACHE-EVICTION-01).
   * Called before each checkout is prepared (protecting that head) and once per
   * tick after the drain. Optional so test doubles can omit it; a failure is
   * logged and never blocks a review.
   */
  evictCheckouts?: (input: { protect: readonly ReviewCheckoutKey[] }) => Promise<unknown>;
}

interface ResultMapping {
  status: 'done' | 'failed';
  task_outcome: DispatchTaskOutcome;
}

function mapSubmitOutcome(
  disposition: Exclude<SubmitDisposition, 'checks_pending' | 'transport_error' | 'rate_limited'>
): ResultMapping {
  switch (disposition) {
    // `stale_head` and `superseded_head` both mean the head this item is BOUND
    // to is no longer the live head. The item's payload carries that dead SHA
    // and nothing rewrites it, so releasing it back to the queue would make
    // every later tick re-evaluate the same stale SHA and return the same
    // disposition forever (#777 review finding). Ingest already covers the new
    // head: a push cancels every in-flight item bound to a different SHA and
    // enqueues a fresh item bound to the exact new head, so this item retiring
    // leaves no head unreviewed. TERMINAL, and `succeeded` rather than
    // `blocked` because supersession is the system working, not a failure.
    case 'approved':
    case 'changes_requested':
    case 'stale_head':
    case 'superseded_head':
      return { status: 'done', task_outcome: 'succeeded' };
    // `blocked_required_contexts_unavailable` (#775): the required
    // status-check contexts could not be read after the attempt bound.
    // TERMINAL and blocked -- never released for another tick (unbounded
    // release is what parked these rows at fencing_token 240) and never
    // succeeded, because no review judgment was ever formed.
    case 'custody_conflict':
    case 'merge_custody_conflict':
    case 'blocked_required_contexts_unavailable':
    case 'review_incomplete':
      return { status: 'failed', task_outcome: 'blocked' };
    case 'reviewer_failed':
    case 'submission_failed':
      return { status: 'failed', task_outcome: 'failed' };
    default: {
      const exhaustive: never = disposition;
      throw new Error(`unknown_review_submit_disposition:${String(exhaustive)}`);
    }
  }
}

export function createRealReviewWorkerDeps(): ReviewWorkerDeps {
  // Built once, lazily: createRealIngestDeps logs its configuration at
  // construction and the recovery pass runs every tick.
  let ingestDeps: IngestDeps | undefined;
  return {
    registerWorker,
    heartbeatWorker,
    listMessages,
    claimMessage,
    postResult,
    releaseMessage,
    deferMessage,
    renewMessageLease,
    runAndSubmitReview,
    createSubmitDeps: createRealSubmitDeps,
    prepareCheckout: prepareReviewCheckout,
    resolveReviewBase: resolveLiveReviewBase,
    staleVerdictSweep: config =>
      runStaleVerdictSweep(
        createRealStaleVerdictSweepDeps(config),
        resolveStaleSweepMax(),
        // DURABLE, not process-local: archon-app-1 is rebuilt regularly, and a
        // cursor that rewinds on restart can never walk a store larger than one
        // process lifetime covers (#786 review @45aa739e).
        createDurableSweepCursor()
      ),
    judgeLadderRecovery: (config): Promise<{ recovered: string[]; stillParked: number }> => {
      ingestDeps ??= createRealIngestDeps(config);
      return recoverParkedJudgeHeads(ingestDeps, defaultReviewLadder());
    },
    evictCheckouts: createReviewCheckoutEvictor({
      listMessages,
      lookupPrState: createGitHubReviewCheckoutPrLookup(),
    }),
  };
}

async function runCheckoutEviction(
  deps: ReviewWorkerDeps,
  protect: readonly ReviewCheckoutKey[]
): Promise<void> {
  if (!deps.evictCheckouts) return;
  try {
    await deps.evictCheckouts({ protect });
  } catch (error) {
    log.error({ err: error }, 'overseer_review_checkout_eviction_failed');
  }
}

export async function tickReviewWorkerClock(
  config: ReviewRouteConfig,
  deps: ReviewWorkerDeps
): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    await deps.registerWorker({
      worker_id: REVIEW_WORKER_ID,
      host: process.env.HOSTNAME ?? 'in-process',
      capabilities: { task_types: [REVIEW_TASK_TYPE], principal: REVIEW_RECIPIENT },
      max_concurrency: 1,
    });
    await deps.heartbeatWorker({ worker_id: REVIEW_WORKER_ID, status: 'available' });

    // listMessages has no task_type filter. Restrict the recipient in SQL and
    // then filter its generic dispatch queue locally before claiming.
    const messages = (
      await deps.listMessages({ recipient: REVIEW_RECIPIENT, status: 'queued' })
    ).filter(message => message.task_type === REVIEW_TASK_TYPE);

    for (const message of messages) {
      try {
        const claimed = await deps.claimMessage({ id: message.id, worker_id: REVIEW_WORKER_ID });
        if (!claimed) continue;
        const body = parseReviewWorkBody(claimed.body);
        if (!body) {
          // Permanent input failure: retire through the existing fenced result
          // path. Never construct a reviewer or apply an override for bad work.
          const rejected = await deps.postResult({
            id: claimed.id,
            worker_id: REVIEW_WORKER_ID,
            fencing_token: claimed.fencing_token,
            status: 'failed',
            task_outcome: 'blocked',
            result_body: JSON.stringify({ reason: 'invalid_review_work_body' }),
          });
          log.warn(
            { messageId: claimed.id, terminalized: rejected !== null },
            rejected === null
              ? 'overseer_review_invalid_body_fence_conflict'
              : 'overseer_review_invalid_body_blocked'
          );
          continue;
        }
        // OPERATOR OVERRIDE (#847): a hand-enqueued run_review whose
        // repeat_reason starts with `operator_request:ladder_restored` clears
        // the judge-ladder breaker before the judge runs; the recovery pass at
        // the end of this tick then re-enqueues every parked head.
        if (applyLadderRestoredRequest(claimed.repeat_reason)) {
          log.info({ messageId: claimed.id }, 'overseer_review_judge_ladder_restored_by_operator');
        }
        // S1/S6: a checkout that cannot be prepared or verified becomes a
        // review_incomplete COMMENT, never a silently stuck claim and never an
        // approval. The reason travels in the server-built execution context.
        let checkoutPath = '';
        let checkoutFailure: string | undefined;
        // Make room before materializing a new checkout; the head about to be
        // prepared is protected even if it is already cached and over cap.
        await runCheckoutEviction(deps, [
          { owner: body.owner, repo: body.repo, headSha: body.headSha },
        ]);
        try {
          checkoutPath = deps.prepareCheckout
            ? await deps.prepareCheckout(await captureReviewBase(body, deps))
            : resolveTrustedCheckoutPath(body.owner, body.repo, body.headSha);
          if (!checkoutPath) checkoutFailure = 'review_checkout_root_unconfigured';
        } catch (error) {
          checkoutPath = '';
          checkoutFailure = classifyCheckoutFailure(error);
          log.warn(
            { messageId: claimed.id, reason: checkoutFailure },
            'overseer_review_checkout_preparation_failed'
          );
        }
        const checkPlan: TrustedCheckPlan = checkoutFailure
          ? { status: 'unsafe', commands: [] }
          : await readTrustedCheckPlan(checkoutPath);
        const work: ReviewWorkItem = {
          correlationId: claimed.correlation_id,
          messageId: claimed.id,
          owner: body.owner,
          repo: body.repo,
          prNumber: body.prNumber,
          headSha: body.headSha,
          author: body.author,
          executionContext: Object.freeze({
            requestId: claimed.id,
            workerId: REVIEW_WORKER_ID,
            fencingToken: claimed.fencing_token,
            owner: body.owner,
            repo: body.repo,
            prNumber: body.prNumber,
            headSha: body.headSha,
            checkoutPath,
            reviewerIdentity: config.reviewerIdentity,
            rung: 'pr-review',
            checkPlanStatus: checkPlan.status,
            checkPlan: Object.freeze(checkPlan.commands),
            ...(checkoutFailure ? { checkoutFailure } : {}),
          }),
        };
        const renew = deps.renewMessageLease;
        const leaseTimer = renew
          ? setInterval(() => {
              void renew({
                id: claimed.id,
                worker_id: REVIEW_WORKER_ID,
                fencing_token: claimed.fencing_token,
              });
            }, 30_000)
          : undefined;
        let outcome: SubmitOutcome;
        try {
          outcome = await deps.runAndSubmitReview(
            work,
            deps.createSubmitDeps(config.reviewerIdentity)
          );
        } finally {
          if (leaseTimer) clearInterval(leaseTimer);
        }
        // CHECKS PENDING is the ONLY non-terminal disposition: the bound head is
        // still live and CI on it has simply not concluded, so releasing the
        // claim with a backoff retries the SAME head productively.
        //
        // `superseded_head` is deliberately NOT released here. Its bound head is
        // dead, the payload still names that dead SHA, and a release would spin
        // the item forever -- see mapSubmitOutcome for the full reasoning.
        if (outcome.disposition === 'checks_pending') {
          // WO-HARNESS-OVERSEER-REVIEW-CHECK-DEFERRAL-01 Section 7 names this
          // transition `deferMessage`; it is the same fenced claimed->queued
          // transition, called by its WO name.
          const deferUntil = new Date(Date.now() + CHECKS_PENDING_BACKOFF_MS).toISOString();
          const pendingChecks = outcome.pendingChecks ?? [];
          (deps.logger ?? log).warn(
            {
              messageId: claimed.id,
              owner: work.owner,
              repo: work.repo,
              prNumber: work.prNumber,
              headSha: work.headSha,
              defer_until: deferUntil,
              pending_checks: pendingChecks,
              ...(outcome.pendingChecks === undefined ? { reason: 'no_checks_reported' } : {}),
            },
            'overseer_review_checks_pending_deferred'
          );
          await deps.deferMessage({
            id: claimed.id,
            worker_id: REVIEW_WORKER_ID,
            fencing_token: claimed.fencing_token,
            defer_until: deferUntil,
          });
          continue;
        }
        // RATE LIMITED (#782 part 2) is non-terminal for the same reason, but
        // its backoff comes from GitHub's own reset clock rather than a fixed
        // interval: retrying before the budget refills would just burn another
        // request and re-defer (#774's spin). A response with no usable clock
        // falls back to the checks-pending interval so the wait is always
        // finite.
        if (outcome.disposition === 'rate_limited') {
          const deferUntil =
            outcome.retryAfter ??
            new Date(
              Date.now() + (outcome.retryAfterMs ?? CHECKS_PENDING_BACKOFF_MS)
            ).toISOString();
          log.warn(
            { messageId: claimed.id, reason: outcome.reason, deferUntil },
            'overseer_review_rate_limited_deferred'
          );
          await deps.deferMessage({
            id: claimed.id,
            worker_id: REVIEW_WORKER_ID,
            fencing_token: claimed.fencing_token,
            defer_until: deferUntil,
          });
          continue;
        }
        // TRANSPORT ERROR (#789) is non-terminal for the same reason: the judge
        // process was never reached, so nothing about the code was evaluated.
        // Terminating here would post CHANGES_REQUESTED for a review that never
        // ran -- the bug this fixes. The backoff comes from the evaluator so a
        // persistent spawn failure cannot spin the worker every tick.
        if (outcome.disposition === 'transport_error') {
          log.warn(
            { messageId: claimed.id, reason: outcome.reason },
            'overseer_review_transport_error_deferred'
          );
          await deps.releaseMessage({
            id: claimed.id,
            worker_id: REVIEW_WORKER_ID,
            fencing_token: claimed.fencing_token,
            not_before: new Date(
              Date.now() + (outcome.retryAfterMs ?? CHECKS_PENDING_BACKOFF_MS)
            ).toISOString(),
          });
          continue;
        }
        const result = mapSubmitOutcome(outcome.disposition);
        await deps.postResult({
          id: claimed.id,
          worker_id: REVIEW_WORKER_ID,
          fencing_token: claimed.fencing_token,
          ...result,
          result_body: JSON.stringify(outcome),
        });
      } catch (error) {
        log.error({ err: error, messageId: message.id }, 'overseer_review_work_item_failed');
      }
    }

    // STALE-VERDICT SWEEP (#782 part 3). Runs AFTER the queue is drained so a
    // sweep-enqueued re-review is picked up on the NEXT tick rather than
    // extending this one, and so a sweep failure can never delay the primary
    // review path. It is internally bounded and never throws.
    if (deps.staleVerdictSweep) {
      try {
        await deps.staleVerdictSweep(config);
      } catch (error) {
        log.error({ err: error }, 'overseer_stale_verdict_sweep_failed');
      }
    }

    // JUDGE LADDER RECOVERY (#847). Also after the drain: a head re-enqueued
    // here is claimed on the NEXT tick, and a failure here never delays the
    // primary review path. The pass is a no-op while any rung's outage record
    // is still in force.
    if (deps.judgeLadderRecovery) {
      try {
        await deps.judgeLadderRecovery(config);
      } catch (error) {
        log.error({ err: error }, 'overseer_judge_ladder_recovery_failed');
      }
    }

    // CHECKOUT CACHE EVICTION. After the drain, so nothing this tick is still
    // using a checkout; in-flight claims elsewhere are protected by the pass.
    await runCheckoutEviction(deps, []);
  } catch (error) {
    log.error({ err: error }, 'overseer_review_worker_tick_failed');
  } finally {
    inFlight = false;
  }
}

function resolveReviewCheckoutRoot(): string {
  const spool = process.env.OVERSEER_REVIEW_SPOOL?.trim() || '/var/lib/overseer-review';
  return process.env.OVERSEER_REVIEW_CHECKOUT_ROOT?.trim() || join(spool, 'checkouts');
}

function resolveTrustedCheckoutPath(
  owner: string,
  repo: string,
  headSha: string,
  checkoutRoot?: string
): string {
  const root = checkoutRoot ?? resolveReviewCheckoutRoot();
  if (!/^[0-9a-f]{40}$/i.test(headSha)) return '';
  const safe = (value: string): string => value.replace(/[^A-Za-z0-9_.-]/g, '_');
  return `${root}/${safe(owner)}/${safe(repo)}/${headSha}`;
}

async function runCheckoutGit(
  argv: string[],
  cwd: string,
  options: { trim?: boolean } = {}
): Promise<string> {
  const token = process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim();
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? '/tmp',
    GIT_TERMINAL_PROMPT: '0',
  };
  if (token) {
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader';
    env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  }
  const child = Bun.spawn(argv, { cwd, env, stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`review_checkout_git_failed:${stderr.slice(0, 300)}`);
  return options.trim === false ? stdout : stdout.trim();
}

const CHECKOUT_IDENTITY_FAILURE = 'review_checkout_identity_failure';
const SHA_PATTERN = /^[0-9a-f]{40}$/i;

function classifyCheckoutFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (message.startsWith('review_checkout_git_failed')) return CHECKOUT_IDENTITY_FAILURE;
  const code = /^review_checkout_[a-z_]+/.exec(message)?.[0];
  return code ?? CHECKOUT_IDENTITY_FAILURE;
}

interface ReviewCheckoutInput {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  baseRef: string;
  baseSha: string;
}

async function captureReviewBase(
  body: {
    owner: string;
    repo: string;
    prNumber: number;
    headSha: string;
    baseRef: string;
    baseSha?: string;
  },
  deps: Pick<ReviewWorkerDeps, 'resolveReviewBase'>
): Promise<ReviewCheckoutInput> {
  let baseRef = body.baseRef;
  let baseSha = body.baseSha ?? '';
  if (!SHA_PATTERN.test(baseSha)) {
    if (!deps.resolveReviewBase) throw new Error('review_checkout_base_identity_missing');
    const live = await deps.resolveReviewBase({
      owner: body.owner,
      repo: body.repo,
      prNumber: body.prNumber,
    });
    baseSha = live.baseSha;
    baseRef = baseRef || live.baseRef;
  }
  return {
    owner: body.owner,
    repo: body.repo,
    prNumber: body.prNumber,
    headSha: body.headSha,
    baseRef,
    baseSha,
  };
}

async function resolveLiveReviewBase(input: {
  owner: string;
  repo: string;
  prNumber: number;
}): Promise<{ baseRef: string; baseSha: string }> {
  const pr = await createRealOctokitClient().pulls.get({
    owner: input.owner,
    repo: input.repo,
    pull_number: input.prNumber,
  });
  const baseSha = pr.data.base?.sha ?? '';
  if (!SHA_PATTERN.test(baseSha)) throw new Error('review_checkout_base_identity_missing');
  return { baseRef: pr.data.base?.ref ?? '', baseSha };
}

/** Paths Git records as executable (mode 100755), relative and '/'-separated. */
async function readTrackedExecutables(checkout: string): Promise<Set<string>> {
  const listing = await runCheckoutGit(['git', 'ls-files', '--stage', '-z'], checkout, {
    trim: false,
  });
  const executables = new Set<string>();
  for (const record of listing.split('\0')) {
    const tab = record.indexOf('\t');
    if (tab === -1) continue;
    if (record.startsWith('100755 ')) executables.add(record.slice(tab + 1));
  }
  return executables;
}

/**
 * Seal without following checkout-controlled symlinks (S2). Tracked 100755
 * files become 0750, every other regular file 0640, directories 0750, so the
 * `reviewer` group can read (and execute what Git records as executable) but
 * modify nothing, and Git's core.filemode comparison still matches HEAD.
 */
export async function sealReviewCheckout(
  path: string,
  executables: ReadonlySet<string> = new Set()
): Promise<void> {
  await sealDirectory(path, '', executables);
}

async function sealDirectory(
  path: string,
  relative: string,
  executables: ReadonlySet<string>
): Promise<void> {
  const directory = await opendir(path);
  for await (const entry of directory) {
    const child = join(path, entry.name);
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    const info = await lstat(child);
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) await sealDirectory(child, childRelative, executables);
    else if (info.isFile()) await chmod(child, executables.has(childRelative) ? 0o750 : 0o640);
  }
  await chmod(path, 0o750);
}

/** Pristine: HEAD and tree bound to H, base B present, no mode, content or untracked drift. */
async function verifySealedCheckout(
  checkout: string,
  headSha: string,
  baseSha: string
): Promise<void> {
  const head = await runCheckoutGit(['git', 'rev-parse', 'HEAD'], checkout);
  const tree = await runCheckoutGit(['git', 'rev-parse', 'HEAD^{tree}'], checkout);
  const expectedTree = await runCheckoutGit(['git', 'rev-parse', `${headSha}^{tree}`], checkout);
  if (head !== headSha || tree !== expectedTree) throw new Error(CHECKOUT_IDENTITY_FAILURE);
  await runCheckoutGit(['git', 'cat-file', '-e', `${baseSha}^{commit}`], checkout);
  await runCheckoutGit(['git', '-c', 'core.filemode=true', 'diff', '--quiet', 'HEAD'], checkout);
  const status = await runCheckoutGit(
    ['git', '-c', 'core.filemode=true', 'status', '--porcelain=v1', '--untracked-files=all'],
    checkout
  );
  if (status.length > 0) throw new Error(CHECKOUT_IDENTITY_FAILURE);
}

export interface PrepareReviewCheckoutOptions {
  /** Remote to fetch object ids from. Defaults to the GitHub repository URL. */
  remoteUrl?: string;
  /** Root for exact-head checkouts. Defaults to the broker spool checkouts dir. */
  checkoutRoot?: string;
}

/**
 * Materialize an immutable exact-head checkout with its captured base commit
 * (S1). Both commits are fetched BY OBJECT ID: the moving base branch tip is
 * never consulted, so a base branch that advanced after the review was queued
 * cannot fail a pristine head, and an object that cannot be fetched or
 * verified fails closed with review_checkout_identity_failure.
 */
export async function prepareReviewCheckout(
  input: ReviewCheckoutInput,
  options: PrepareReviewCheckoutOptions = {}
): Promise<string> {
  if (
    !/^[A-Za-z0-9_.-]+$/.test(input.owner) ||
    !/^[A-Za-z0-9_.-]+$/.test(input.repo) ||
    !Number.isSafeInteger(input.prNumber) ||
    input.prNumber < 1 ||
    !SHA_PATTERN.test(input.headSha)
  ) {
    throw new Error('review_checkout_identity_invalid');
  }
  if (!SHA_PATTERN.test(input.baseSha)) throw new Error('review_checkout_base_identity_missing');
  const headSha = input.headSha.toLowerCase();
  const baseSha = input.baseSha.toLowerCase();
  const checkout = resolveTrustedCheckoutPath(
    input.owner,
    input.repo,
    headSha,
    options.checkoutRoot
  );
  if (!checkout) throw new Error('review_checkout_root_unconfigured');
  try {
    // Cached checkout: re-seal from Git's own modes, then re-verify. Any
    // drift (mode, content, untracked file, missing base) discards it.
    await sealReviewCheckout(checkout, await readTrackedExecutables(checkout));
    await verifySealedCheckout(checkout, headSha, baseSha);
    await recordCheckoutUse(checkout, input.prNumber);
    return await realpath(checkout);
  } catch {
    // Missing or stale paths are replaced atomically below.
  }
  const temporary = `${checkout}.tmp-${randomUUID()}`;
  await mkdir(dirname(checkout), { recursive: true, mode: 0o2770 });
  await rm(temporary, { recursive: true, force: true });
  try {
    await mkdir(temporary, { mode: 0o700 });
    await runCheckoutGit(['git', 'init', '--quiet'], temporary);
    const remote = options.remoteUrl ?? `https://github.com/${input.owner}/${input.repo}.git`;
    // A NAMED remote: a partial (--filter) fetch records it as the promisor
    // that later checkout and diff steps lazily fetch missing blobs from. The
    // credential stays in runCheckoutGit's env and is never written to config.
    await runCheckoutGit(['git', 'remote', 'add', 'origin', remote], temporary);
    const sparseExcludes = resolveSparseExcludes(input.owner, input.repo);
    if (sparseExcludes.length > 0) {
      // Non-cone sparse-checkout, set BEFORE checkout so excluded blobs are
      // never fetched or written. Tree identity is unchanged, so
      // verifySealedCheckout still binds HEAD and its tree to headSha.
      await runCheckoutGit(
        [
          'git',
          'sparse-checkout',
          'set',
          '--no-cone',
          '/*',
          ...sparseExcludes.map(path => `!/${path}/`),
        ],
        temporary
      );
    }
    try {
      await runCheckoutGit(
        [
          'git',
          'fetch',
          '--quiet',
          '--no-tags',
          '--no-write-fetch-head',
          '--depth',
          '1',
          '--filter=blob:none',
          'origin',
          headSha,
          baseSha,
        ],
        temporary
      );
      await runCheckoutGit(['git', 'cat-file', '-e', `${headSha}^{commit}`], temporary);
      await runCheckoutGit(['git', 'cat-file', '-e', `${baseSha}^{commit}`], temporary);
    } catch {
      throw new Error(CHECKOUT_IDENTITY_FAILURE);
    }
    await runCheckoutGit(['git', 'checkout', '--quiet', '--detach', headSha], temporary);
    // Prefetch both sides of the base..head diff now, while the parent holds
    // the credential, so the reviewer's `git diff <base> <head>` never needs
    // the network.
    await runCheckoutGit(['git', 'diff', '--stat', baseSha, headSha], temporary);
    await sealReviewCheckout(temporary, await readTrackedExecutables(temporary));
    await verifySealedCheckout(temporary, headSha, baseSha);
    await rm(checkout, { recursive: true, force: true });
    await rename(temporary, checkout);
    await recordCheckoutUse(checkout, input.prNumber);
    return await realpath(checkout);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Review checkout cache (WO-HARNESS-REVIEW-CHECKOUT-CACHE-EVICTION-01). See the
// file header for the env vars and log lines.
// ---------------------------------------------------------------------------

export const DEFAULT_REVIEW_CHECKOUT_CACHE_MAX_BYTES = 3 * 1024 * 1024 * 1024;
export const DEFAULT_REVIEW_SPARSE_EXCLUDES = 'thinmansoftware/bdc-xo:generations/';
const REVIEW_CHECKOUT_KEEP_PER_REPO = 2;
const DEFAULT_REVIEW_CHECKOUT_STATE_SWEEP_MS = 15 * 60_000;
const CACHE_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;
const CACHED_HEAD_PATTERN = /^[0-9a-f]{40}$/;
const SPARSE_PATH_PATTERN = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;

export function resolveReviewCheckoutCacheMaxBytes(
  raw: string | undefined = process.env.OVERSEER_REVIEW_CHECKOUT_CACHE_MAX_BYTES
): number {
  const value = Number(raw?.trim());
  return raw?.trim() && Number.isSafeInteger(value) && value > 0
    ? value
    : DEFAULT_REVIEW_CHECKOUT_CACHE_MAX_BYTES;
}

/**
 * Repo-relative directories left out of a review checkout for owner/repo, from
 * `owner/repo:path` entries. Invalid paths (absolute, `..`, glob characters)
 * are ignored so an exclude can never widen into a broader pattern.
 */
export function resolveSparseExcludes(
  owner: string,
  repo: string,
  raw: string = process.env.OVERSEER_REVIEW_SPARSE_EXCLUDES ?? DEFAULT_REVIEW_SPARSE_EXCLUDES
): string[] {
  const target = `${owner}/${repo}`.toLowerCase();
  const paths: string[] = [];
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    const colon = trimmed.indexOf(':');
    if (colon <= 0) continue;
    if (trimmed.slice(0, colon).toLowerCase() !== target) continue;
    const path = trimmed.slice(colon + 1).replace(/^\/+|\/+$/g, '');
    if (!SPARSE_PATH_PATTERN.test(path)) continue;
    if (path.split('/').some(segment => segment === '.' || segment === '..')) continue;
    if (!paths.includes(path)) paths.push(path);
  }
  return paths;
}

export interface ReviewCheckoutKey {
  owner: string;
  repo: string;
  headSha: string;
}

function checkoutKey(key: ReviewCheckoutKey): string {
  return `${key.owner}/${key.repo}/${key.headSha}`.toLowerCase();
}

export type ReviewCheckoutPrState =
  | { state: 'open'; headSha: string }
  | { state: 'merged' }
  | { state: 'closed' }
  | { state: 'unknown'; reason: string };

export type ReviewCheckoutPrLookup = (
  input: ReviewCheckoutKey & { prNumber?: number }
) => Promise<ReviewCheckoutPrState>;

export type ReviewCheckoutEvictionReason = 'merged' | 'closed' | 'superseded' | 'cap';

export interface ReviewCheckoutCacheLogger {
  info(data: Record<string, unknown>, message: string): void;
  warn(data: Record<string, unknown>, message: string): void;
}

export interface CachedReviewCheckout extends ReviewCheckoutKey {
  path: string;
  bytes: number;
  lastUsedMs: number;
  prNumber?: number;
}

export interface ReviewCheckoutEvictionResult {
  evicted: (ReviewCheckoutKey & { reason: ReviewCheckoutEvictionReason; bytes: number })[];
  freedBytes: number;
  totalBytes: number;
  overCap: boolean;
}

/**
 * Last use = directory mtime, set on creation and every reuse. The mtime of
 * the checkout ROOT only; nothing is written inside the sealed tree, so the
 * pristine (no untracked file) contract is unaffected.
 */
async function recordCheckoutUse(checkout: string, prNumber: number): Promise<void> {
  try {
    const now = new Date();
    await utimes(checkout, now, now);
    // Sibling marker `<headSha>.pr`, OUTSIDE the checkout: lets the eviction
    // pass read the PR by number instead of by commit association.
    await writeFile(`${checkout}.pr`, `${prNumber}\n`, { mode: 0o640 });
  } catch (error) {
    log.warn({ err: error, checkout }, 'overseer_review_checkout_use_record_failed');
  }
}

async function listDirectoryNames(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function isRealDirectory(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

/** Sealed checkouts are immutable, so a size is cached per path and inode. */
const checkoutSizeCache = new Map<string, { ino: number; bytes: number }>();

async function treeBytes(path: string): Promise<number> {
  let total = 0;
  const directory = await opendir(path);
  for await (const entry of directory) {
    const child = join(path, entry.name);
    const info = await lstat(child);
    if (info.isDirectory() && !info.isSymbolicLink()) total += await treeBytes(child);
    else total += info.size;
  }
  return total;
}

async function readPrMarker(path: string): Promise<number | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > 32) return undefined;
    const value = Number((await readFile(path, 'utf8')).trim());
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Cached checkouts are EXACTLY `<root>/<owner>/<repo>/<40 lowercase hex>`
 * real directories. Symlinks, `*.tmp-*` builds in progress, markers and
 * anything else are never returned, so they are never sized or deleted.
 */
export async function listCachedReviewCheckouts(root: string): Promise<CachedReviewCheckout[]> {
  const found: CachedReviewCheckout[] = [];
  for (const owner of await listDirectoryNames(root)) {
    if (!CACHE_NAME_PATTERN.test(owner) || owner === '.' || owner === '..') continue;
    const ownerPath = join(root, owner);
    if (!(await isRealDirectory(ownerPath))) continue;
    for (const repo of await listDirectoryNames(ownerPath)) {
      if (!CACHE_NAME_PATTERN.test(repo) || repo === '.' || repo === '..') continue;
      const repoPath = join(ownerPath, repo);
      if (!(await isRealDirectory(repoPath))) continue;
      for (const name of await listDirectoryNames(repoPath)) {
        if (!CACHED_HEAD_PATTERN.test(name)) continue;
        const path = join(repoPath, name);
        let info;
        try {
          info = await lstat(path);
        } catch {
          continue;
        }
        if (!info.isDirectory() || info.isSymbolicLink()) continue;
        let bytes: number;
        const known = checkoutSizeCache.get(path);
        if (known?.ino === info.ino) bytes = known.bytes;
        else {
          try {
            bytes = await treeBytes(path);
          } catch {
            continue;
          }
          checkoutSizeCache.set(path, { ino: info.ino, bytes });
        }
        const prNumber = await readPrMarker(`${path}.pr`);
        found.push({
          owner,
          repo,
          headSha: name,
          path,
          bytes,
          lastUsedMs: info.mtimeMs,
          ...(prNumber ? { prNumber } : {}),
        });
      }
    }
  }
  return found;
}

async function removeCachedCheckout(root: string, checkout: CachedReviewCheckout): Promise<void> {
  // Recompute the path from validated parts; never trust a stored string.
  if (
    !CACHE_NAME_PATTERN.test(checkout.owner) ||
    !CACHE_NAME_PATTERN.test(checkout.repo) ||
    !CACHED_HEAD_PATTERN.test(checkout.headSha)
  ) {
    throw new Error('review_checkout_evict_refused');
  }
  const path = join(root, checkout.owner, checkout.repo, checkout.headSha);
  if (path !== checkout.path || !(await isRealDirectory(path))) {
    throw new Error('review_checkout_evict_refused');
  }
  await rm(path, { recursive: true, force: true });
  await rm(`${path}.pr`, { force: true });
  checkoutSizeCache.delete(path);
}

export interface EvictReviewCheckoutsOptions {
  checkoutRoot: string;
  maxBytes: number;
  /** Checkouts that must never be evicted (in-flight reviews, the head being prepared). */
  inUse: readonly ReviewCheckoutKey[];
  /** Absent = cap-only pass (no merged/closed/superseded phase). */
  lookupPrState?: ReviewCheckoutPrLookup;
  logger?: ReviewCheckoutCacheLogger;
  keepPerRepo?: number;
}

export async function evictReviewCheckouts(
  options: EvictReviewCheckoutsOptions
): Promise<ReviewCheckoutEvictionResult> {
  const logger = options.logger ?? log;
  const keepPerRepo = options.keepPerRepo ?? REVIEW_CHECKOUT_KEEP_PER_REPO;
  const inUse = new Set<string>(options.inUse.map(checkoutKey));
  const evicted: ReviewCheckoutEvictionResult['evicted'] = [];
  const evict = async (
    checkout: CachedReviewCheckout,
    reason: ReviewCheckoutEvictionReason
  ): Promise<boolean> => {
    const identity = { owner: checkout.owner, repo: checkout.repo, headSha: checkout.headSha };
    try {
      await removeCachedCheckout(options.checkoutRoot, checkout);
    } catch (error) {
      logger.warn(
        { ...identity, reason, error: error instanceof Error ? error.message : String(error) },
        'overseer_review_checkout_evict_failed'
      );
      return false;
    }
    evicted.push({ ...identity, reason, bytes: checkout.bytes });
    logger.info(
      { ...identity, reason, bytesFreed: checkout.bytes },
      'overseer_review_checkout_evicted'
    );
    return true;
  };

  let cached = await listCachedReviewCheckouts(options.checkoutRoot);

  if (options.lookupPrState) {
    const cachedKeys = new Set(cached.map(checkoutKey));
    const survivors: CachedReviewCheckout[] = [];
    for (const checkout of cached) {
      if (inUse.has(checkoutKey(checkout))) {
        survivors.push(checkout);
        continue;
      }
      let state: ReviewCheckoutPrState;
      try {
        state = await options.lookupPrState({
          owner: checkout.owner,
          repo: checkout.repo,
          headSha: checkout.headSha,
          ...(checkout.prNumber ? { prNumber: checkout.prNumber } : {}),
        });
      } catch (error) {
        state = {
          state: 'unknown',
          reason: error instanceof Error ? error.message.slice(0, 200) : 'lookup_failed',
        };
      }
      let reason: ReviewCheckoutEvictionReason | undefined;
      if (state.state === 'merged' || state.state === 'closed') reason = state.state;
      else if (
        state.state === 'open' &&
        state.headSha.toLowerCase() !== checkout.headSha &&
        cachedKeys.has(checkoutKey({ ...checkout, headSha: state.headSha }))
      ) {
        reason = 'superseded';
      } else if (state.state === 'unknown') {
        // Doubt keeps the directory: only the cap may remove it.
        logger.warn(
          {
            owner: checkout.owner,
            repo: checkout.repo,
            headSha: checkout.headSha,
            reason: state.reason,
          },
          'overseer_review_checkout_state_unknown'
        );
      }
      if (reason && (await evict(checkout, reason))) continue;
      survivors.push(checkout);
    }
    cached = survivors;
  }

  let totalBytes = cached.reduce((sum, checkout) => sum + checkout.bytes, 0);
  if (totalBytes > options.maxBytes) {
    const newestFloor = new Set<string>();
    const byRepo = new Map<string, CachedReviewCheckout[]>();
    for (const checkout of cached) {
      const repoKey = `${checkout.owner}/${checkout.repo}`.toLowerCase();
      byRepo.set(repoKey, [...(byRepo.get(repoKey) ?? []), checkout]);
    }
    for (const group of byRepo.values()) {
      group
        .sort((a, b) => b.lastUsedMs - a.lastUsedMs)
        .slice(0, keepPerRepo)
        .forEach(checkout => newestFloor.add(checkoutKey(checkout)));
    }
    const candidates = cached
      .filter(c => !inUse.has(checkoutKey(c)) && !newestFloor.has(checkoutKey(c)))
      .sort((a, b) => a.lastUsedMs - b.lastUsedMs || a.headSha.localeCompare(b.headSha));
    for (const checkout of candidates) {
      if (totalBytes <= options.maxBytes) break;
      if (await evict(checkout, 'cap')) totalBytes -= checkout.bytes;
    }
  }
  const overCap = totalBytes > options.maxBytes;
  if (overCap) {
    logger.warn(
      { totalBytes, maxBytes: options.maxBytes },
      'overseer_review_checkout_cache_over_cap'
    );
  }
  const freedBytes = evicted.reduce((sum, entry) => sum + entry.bytes, 0);
  if (evicted.length > 0) {
    logger.info(
      { evicted: evicted.length, freedBytes, totalBytes },
      'overseer_review_checkout_eviction_pass'
    );
  }
  return { evicted, freedBytes, totalBytes, overCap };
}

interface AssociatedPull {
  state?: string;
  merged_at?: string | null;
  head?: { sha?: string };
}

/** PR state from `GET /repos/{o}/{r}/commits/{sha}/pulls` (legacy dirs with no marker). */
export function derivePrStateFromAssociatedPulls(
  headSha: string,
  pulls: unknown
): ReviewCheckoutPrState {
  if (!Array.isArray(pulls)) return { state: 'unknown', reason: 'lookup_malformed' };
  if (pulls.length === 0) return { state: 'unknown', reason: 'no_associated_pr' };
  const typed = pulls as AssociatedPull[];
  const open = typed.filter(pull => pull.state === 'open');
  if (open.length > 0) {
    const exact = open.find(pull => pull.head?.sha?.toLowerCase() === headSha.toLowerCase());
    const live = (exact ?? open[0]).head?.sha ?? '';
    return SHA_PATTERN.test(live)
      ? { state: 'open', headSha: live }
      : { state: 'unknown', reason: 'lookup_malformed' };
  }
  return typed.some(pull => pull.merged_at) ? { state: 'merged' } : { state: 'closed' };
}

interface OctokitRequester {
  request?: (route: string, params: Record<string, unknown>) => Promise<{ data: unknown }>;
}

export function createGitHubReviewCheckoutPrLookup(
  clientFactory: () => ReturnType<typeof createRealOctokitClient> = () => createRealOctokitClient()
): ReviewCheckoutPrLookup {
  let client: ReturnType<typeof createRealOctokitClient> | undefined;
  return async ({ owner, repo, headSha, prNumber }) => {
    client ??= clientFactory();
    if (prNumber) {
      const pr = (await client.pulls.get({ owner, repo, pull_number: prNumber })).data;
      if (pr.state === 'open') {
        return SHA_PATTERN.test(pr.head?.sha ?? '')
          ? { state: 'open', headSha: pr.head.sha }
          : { state: 'unknown', reason: 'lookup_malformed' };
      }
      if (pr.state === 'closed') return pr.merged ? { state: 'merged' } : { state: 'closed' };
      return { state: 'unknown', reason: 'lookup_malformed' };
    }
    const requester = client as unknown as OctokitRequester;
    if (typeof requester.request !== 'function') {
      return { state: 'unknown', reason: 'lookup_unavailable' };
    }
    const response = await requester.request(
      'GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls',
      {
        owner,
        repo,
        commit_sha: headSha,
      }
    );
    return derivePrStateFromAssociatedPulls(headSha, response.data);
  };
}

export interface ReviewCheckoutEvictorDeps {
  listMessages: (filters: {
    recipient: string;
    status: 'claimed';
    limit: number;
  }) => Promise<DispatchMessage[]>;
  lookupPrState?: ReviewCheckoutPrLookup;
  checkoutRoot?: string;
  /** Defaults to OVERSEER_REVIEW_CHECKOUT_CACHE_MAX_BYTES, read on every pass. */
  maxBytes?: number;
  now?: () => number;
  stateSweepIntervalMs?: number;
  logger?: ReviewCheckoutCacheLogger;
}

/**
 * Real eviction entry point. In-use = every claimed run_review whose lease has
 * not expired, plus the caller's protected heads. If the claims cannot be read
 * the pass is SKIPPED (never evict blind). GitHub is consulted at most once
 * per state-sweep interval; other passes are cap-only.
 */
export function createReviewCheckoutEvictor(
  deps: ReviewCheckoutEvictorDeps
): (input: {
  protect: readonly ReviewCheckoutKey[];
}) => Promise<ReviewCheckoutEvictionResult | null> {
  let lastStateSweepAt = Number.NEGATIVE_INFINITY;
  return async ({ protect }) => {
    const logger = deps.logger ?? log;
    let claimed: DispatchMessage[];
    try {
      claimed = await deps.listMessages({
        recipient: REVIEW_RECIPIENT,
        status: 'claimed',
        limit: 500,
      });
    } catch (error) {
      logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'overseer_review_checkout_eviction_skipped'
      );
      return null;
    }
    const now = (deps.now ?? Date.now)();
    const inUse: ReviewCheckoutKey[] = [...protect];
    for (const message of claimed) {
      if (message.task_type !== REVIEW_TASK_TYPE || message.status !== 'claimed') continue;
      if (message.lease_expires_at && Date.parse(message.lease_expires_at) <= now) continue;
      const body = parseReviewWorkBody(message.body);
      if (body) inUse.push({ owner: body.owner, repo: body.repo, headSha: body.headSha });
    }
    const interval =
      deps.stateSweepIntervalMs ??
      (Number(process.env.OVERSEER_REVIEW_CHECKOUT_STATE_SWEEP_MS) ||
        DEFAULT_REVIEW_CHECKOUT_STATE_SWEEP_MS);
    const withState = deps.lookupPrState !== undefined && now - lastStateSweepAt >= interval;
    if (withState) lastStateSweepAt = now;
    return evictReviewCheckouts({
      checkoutRoot: deps.checkoutRoot ?? resolveReviewCheckoutRoot(),
      maxBytes: deps.maxBytes ?? resolveReviewCheckoutCacheMaxBytes(),
      inUse,
      ...(withState ? { lookupPrState: deps.lookupPrState } : {}),
      logger,
    });
  };
}

export function startReviewWorkerClock(
  config: ReviewRouteConfig | null | undefined,
  deps: ReviewWorkerDeps = createRealReviewWorkerDeps()
): void {
  if (!config || timer || process.env.NODE_ENV === 'test') return;
  void tickReviewWorkerClock(config, deps);
  const interval = Math.max(
    1_000,
    Number(process.env.OVERSEER_REVIEW_WORKER_INTERVAL_MS) || 60_000
  );
  timer = setInterval(() => void tickReviewWorkerClock(config, deps), interval);
  timer.unref?.();
}

export function stopReviewWorkerClock(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
