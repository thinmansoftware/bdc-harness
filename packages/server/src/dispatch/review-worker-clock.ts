import {
  claimMessage,
  deferMessage,
  heartbeatWorker,
  listMessages,
  postResult,
  registerWorker,
  releaseMessage,
  renewMessageLease,
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
import { chmod, lstat, mkdir, opendir, readFile, realpath, rename, rm } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
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
  const planPath = join(checkoutPath, REVIEW_CHECK_PLAN_PATH);
  try {
    const [checkoutReal, planReal, info] = await Promise.all([
      realpath(checkoutPath),
      realpath(planPath),
      lstat(planPath),
    ]);
    if (
      !info.isFile() ||
      !planReal.startsWith(checkoutReal.endsWith(sep) ? checkoutReal : `${checkoutReal}${sep}`)
    )
      return { status: 'unsafe', commands: [] };
    return parseTrustedCheckPlan(await readFile(planReal, 'utf8'));
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
  };
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
        const checkoutPath = deps.prepareCheckout
          ? await deps.prepareCheckout({
              owner: body.owner,
              repo: body.repo,
              prNumber: body.prNumber,
              headSha: body.headSha,
              baseRef: body.baseRef,
              baseSha: body.baseSha ?? '',
            })
          : resolveTrustedCheckoutPath(body.owner, body.repo, body.headSha);
        const checkPlan = await readTrustedCheckPlan(checkoutPath);
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
  } catch (error) {
    log.error({ err: error }, 'overseer_review_worker_tick_failed');
  } finally {
    inFlight = false;
  }
}

function resolveTrustedCheckoutPath(owner: string, repo: string, headSha: string): string {
  const spool = process.env.OVERSEER_REVIEW_SPOOL?.trim() || '/var/lib/overseer-review';
  const root = process.env.OVERSEER_REVIEW_CHECKOUT_ROOT?.trim() || join(spool, 'checkouts');
  if (!/^[0-9a-f]{40}$/i.test(headSha)) return '';
  const safe = (value: string): string => value.replace(/[^A-Za-z0-9_.-]/g, '_');
  return `${root}/${safe(owner)}/${safe(repo)}/${headSha}`;
}

async function runCheckoutGit(argv: string[], cwd: string): Promise<string> {
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
  return stdout.trim();
}

/** Seal without following checkout-controlled symlinks. */
export async function sealReviewCheckout(path: string): Promise<void> {
  const directory = await opendir(path);
  for await (const entry of directory) {
    const child = join(path, entry.name);
    const info = await lstat(child);
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) await sealReviewCheckout(child);
    else if (info.isFile()) await chmod(child, 0o640);
  }
  await chmod(path, 0o750);
}

/** Materialize an immutable exact-head checkout, with its exact base commit available. */
export async function prepareReviewCheckout(input: {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  baseRef: string;
  baseSha: string;
}): Promise<string> {
  if (
    !/^[A-Za-z0-9_.-]+$/.test(input.owner) ||
    !/^[A-Za-z0-9_.-]+$/.test(input.repo) ||
    !Number.isSafeInteger(input.prNumber) ||
    input.prNumber < 1 ||
    !/^[0-9a-f]{40}$/i.test(input.headSha) ||
    (input.baseRef !== '' &&
      (!/^[A-Za-z0-9._/-]+$/.test(input.baseRef) ||
        input.baseRef.startsWith('-') ||
        input.baseRef.includes('..')))
  ) {
    throw new Error('review_checkout_identity_invalid');
  }
  const checkout = resolveTrustedCheckoutPath(input.owner, input.repo, input.headSha);
  if (!checkout) throw new Error('review_checkout_root_unconfigured');
  try {
    if ((await runCheckoutGit(['git', 'rev-parse', 'HEAD'], checkout)) === input.headSha) {
      if (input.baseSha)
        await runCheckoutGit(['git', 'cat-file', '-e', `${input.baseSha}^{commit}`], checkout);
      await sealReviewCheckout(checkout);
      return await realpath(checkout);
    }
  } catch {
    // Missing or stale paths are replaced atomically below.
  }
  const temporary = `${checkout}.tmp-${randomUUID()}`;
  if (!/^[0-9a-f]{40}$/i.test(input.baseSha) || !input.baseRef)
    throw new Error('review_checkout_base_identity_missing');
  await mkdir(dirname(checkout), { recursive: true, mode: 0o2770 });
  await rm(temporary, { recursive: true, force: true });
  try {
    await mkdir(temporary, { mode: 0o700 });
    await runCheckoutGit(['git', 'init', '--quiet'], temporary);
    const remote = `https://github.com/${input.owner}/${input.repo}.git`;
    await runCheckoutGit(
      [
        'git',
        'fetch',
        '--no-tags',
        remote,
        `+refs/heads/${input.baseRef}:refs/review/base`,
        `+refs/pull/${input.prNumber}/head:refs/review/head`,
      ],
      temporary
    );
    const [head, base] = await Promise.all([
      runCheckoutGit(['git', 'rev-parse', 'refs/review/head'], temporary),
      runCheckoutGit(['git', 'rev-parse', 'refs/review/base'], temporary),
    ]);
    if (head !== input.headSha || base !== input.baseSha)
      throw new Error('review_checkout_identity_failure');
    await runCheckoutGit(['git', 'checkout', '--quiet', '--detach', input.headSha], temporary);
    await sealReviewCheckout(temporary);
    await rm(checkout, { recursive: true, force: true });
    await rename(temporary, checkout);
    return await realpath(checkout);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
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
