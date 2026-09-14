/**
 * check_run / workflow_run completion -> automatic re-review ingestion
 * (bdc-harness #782 part 1; John's ruling 2026-09-07 "on overseer the recheck
 * should be implemented").
 *
 * THE GAP THIS CLOSES: the reviewer reviews a PR head on PUSH. When a required
 * check is RED at review time it posts CHANGES_REQUESTED naming the check. If
 * that check is later re-run IN PLACE and goes green at the SAME head, nothing
 * re-triggers the review: there is no new push, and the route subscribed only
 * to `pull_request`. The CHANGES_REQUESTED verdict then stands forever unless a
 * human sends a run_review row by hand. Observed live 2026-09-07 on #746
 * @1191a736 and #777 @5ac93b76: both needed an XO nudge, both then APPROVED.
 *
 * DELIBERATELY A SEPARATE MODULE FROM `pr-review-ingest.ts`. That module
 * handles the head-MOVED path (a new commit supersedes prior work); this one
 * handles the SAME-head path (the code did not change, the evidence did). The
 * two have different idempotency keys, different authorization questions, and
 * different bounds, and keeping them apart means neither can regress the other.
 *
 * PURE AND INJECTABLE, exactly like the pull_request ingest: every branch --
 * signature rejection, wrong event, still-running check, no authorizing
 * verdict, duplicate delivery, enqueue failure -- is testable with no network,
 * no database and no GitHub App key.
 *
 * RATE BUDGET: the per-user GitHub budget is shared across the whole harness
 * (it is what exhausted during #776's review). check_run completions still
 * decide from the webhook payload plus the local store. A suite-level
 * completion (`workflow_run` / `check_suite`) whose name does not match a
 * verdict-named check may issue ONE `checks.listForRef` read to verify those
 * named blocking checks are now passing -- the same latest-attempt rule the
 * stale sweep uses. An unmatched name without that verification never enqueues.
 */
import { checkGitHubWebhookSignature } from '@archon/adapters/forge/github/webhook-signature';

/** Event types this ingest accepts. Anything else is ignored, not an error. */
export const RECHECK_EVENT_TYPES = ['check_run', 'check_suite', 'workflow_run'] as const;
export type RecheckEventType = (typeof RECHECK_EVENT_TYPES)[number];

/** Terminal dispositions. Every one is recorded as a receipt. */
export type RecheckDisposition =
  | 'queued'
  | 'duplicate_delivery'
  | 'ignored_event'
  | 'ignored_not_completed'
  | 'ignored_no_open_pull_request'
  | 'ignored_no_authorizing_verdict'
  /**
   * The PR had an authorizing verdict, but THIS completion does not warrant a
   * re-review: it did not pass, or it is unrelated to the check the verdict
   * named. Distinct from `ignored_no_authorizing_verdict` so the receipts can
   * tell "this PR is not eligible" apart from "this event is not the trigger".
   */
  | 'ignored_check_not_actionable'
  | 'rejected_signature'
  | 'blocked';

export interface RecheckIngestResult {
  disposition: RecheckDisposition;
  /** HTTP status the route should return. */
  status: number;
  /** Stable machine-readable reason; the visible blocker on failure. */
  reason?: string;
  correlationId?: string;
  messageId?: string;
  /** Exact head SHA the queued re-review is bound to. */
  headSha?: string;
  /** PR numbers a re-review was queued for. */
  prNumbers?: number[];
}

/** Minimal PR reference carried inside a check_run / workflow_run payload. */
export interface CheckPullRequestRef {
  number?: number;
  head?: { sha?: string; ref?: string };
  base?: { ref?: string };
  state?: string;
}

/** Minimal shape of the inbound check_run / workflow_run webhook payload. */
export interface CheckCompletionWebhookPayload {
  action?: string;
  check_run?: {
    id?: number;
    name?: string;
    status?: string;
    conclusion?: string | null;
    head_sha?: string;
    pull_requests?: CheckPullRequestRef[];
  };
  check_suite?: {
    id?: number;
    status?: string;
    conclusion?: string | null;
    head_sha?: string;
    pull_requests?: CheckPullRequestRef[];
  };
  workflow_run?: {
    id?: number;
    name?: string;
    status?: string;
    conclusion?: string | null;
    head_sha?: string;
    head_branch?: string;
    pull_requests?: CheckPullRequestRef[];
  };
  repository?: { name?: string; owner?: { login?: string }; full_name?: string };
}

/**
 * The standing Overseer verdict for one PR head, as reconstructed from the
 * local submit receipts. This is the authorization question: a re-review is
 * warranted only when the last thing the reviewer said about THIS head was
 * "changes requested because of a check", or "I deferred, checks were pending".
 */
export interface StandingVerdict {
  headSha: string;
  /**
   * Terminal disposition of the last submitted review at this head, as written
   * by `pr-review-submit`. `checks_pending` is the deferral case.
   */
  disposition: string;
  /**
   * The review summary the reviewer posted, if any. Used to decide whether a
   * CHANGES_REQUESTED verdict was caused BY A CHECK rather than by a code
   * finding: only a check-caused rejection is auto-cleared by a green re-run.
   */
  summary?: string | null;
  /** When the verdict was recorded (ISO-8601), for the stale sweep. */
  recordedAt?: string | null;
}

/**
 * Normalized completion facts extracted from whichever event shape arrived.
 * Exported for the stale sweep, which builds the same shape from its own read.
 */
export interface CheckCompletion {
  /** Stable id of the completed unit; part of the idempotency key. */
  checkId: string;
  /** Human name of the check, for the receipt and the repeat reason. */
  checkName: string;
  headSha: string;
  conclusion: string | null;
  prNumbers: number[];
}

/** Minimal check-run row from `checks.listForRef`, for latest-attempt grouping. */
export interface RecheckCheckRun {
  id?: number;
  name?: string;
  status?: string;
  conclusion?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  app?: { slug?: string; name?: string };
}

export interface RecheckIngestDeps {
  /** Shared webhook secret. Empty/absent means the route must fail closed. */
  webhookSecret: string;
  /**
   * The standing verdict at (owner, repo, prNumber, headSha), or null when the
   * reviewer has never reached a terminal verdict at that head. Reads the LOCAL
   * dispatch store -- never GitHub -- so this path costs no rate budget.
   */
  readStandingVerdict(input: {
    owner: string;
    repo: string;
    prNumber: number;
    headSha: string;
  }): Promise<StandingVerdict | null>;
  /**
   * Enqueue one durable re-review. MUST be backed by
   * agent_dispatch_messages(task_type='run_review'); its UNIQUE
   * idempotency_key is what makes a second identical completion event a no-op.
   */
  enqueueRecheckWork(input: {
    correlationId: string;
    idempotencyKey: string;
    owner: string;
    repo: string;
    prNumber: number;
    headSha: string;
    repeatReason: string;
  }): Promise<{ messageId: string; alreadyExisted: boolean }>;
  /** Persist a correlated audit receipt. Never throws the ingest path open. */
  recordReceipt(input: {
    correlationId: string;
    deliveryId: string;
    owner: string;
    repo: string;
    prNumber: number | null;
    headSha: string | null;
    disposition: RecheckDisposition;
    reason?: string;
    messageId?: string;
  }): Promise<void>;
  /**
   * Optional GitHub `checks.listForRef` read. Used ONLY when a suite-level
   * (`workflow_run` / `check_suite`) completion cannot be matched by name
   * against the verdict's `checks/` findings. Absent, incomplete, or throwing
   * is fail-closed: the completion is not treated as relevant.
   */
  listCheckRunsForRef?(input: {
    owner: string;
    repo: string;
    headSha: string;
  }): Promise<{ runs: RecheckCheckRun[]; complete: boolean }>;
}

export interface RecheckIngestRequest {
  /** RAW request body. Never a re-serialized object. */
  rawBody: string;
  signature: string | undefined | null;
  /** x-github-event */
  eventType: string | undefined | null;
  /** x-github-delivery -- the dedupe key for retried deliveries. */
  deliveryId: string | undefined | null;
}

/**
 * Correlation id for one automatic re-review. Head-bound, exactly like the
 * push-path correlation id, so a re-review is traceable to the same PR head the
 * original review examined.
 */
export function recheckCorrelationId(input: {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
}): string {
  return `pr-review:${input.owner}/${input.repo}#${input.prNumber}@${input.headSha}`;
}

/**
 * Idempotency key for a re-review row.
 *
 * INCLUDES THE CHECK ID on purpose (spec #782: "a fresh idempotency key that
 * includes the check_run id"). The push path's key is head-only, so reusing it
 * would collide with the original review's row and the re-review would silently
 * become a duplicate -- the exact no-op this WO exists to prevent. Including
 * the check id also gives the required bound: ONE automatic re-review per
 * (head, completed check), because a repeated delivery of the same completion
 * computes the same key and the database refuses the second insert.
 */
export function recheckIdempotencyKey(input: {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  checkId: string;
}): string {
  return `pr-recheck:${input.owner}/${input.repo}#${input.prNumber}@${input.headSha}:${input.checkId}`;
}

/** Machine-readable marker prefixing every repeat_reason this module writes. */
export const RECHECK_REASON_PREFIX = 'recheck:check_completed:';

/**
 * Conclusions that count as a check having PASSED.
 *
 * `success` is the unambiguous pass. `neutral` and `skipped` are included
 * because GitHub's own branch protection treats them as non-blocking: a
 * required context that concludes `skipped` (a path-filtered job) or `neutral`
 * does not hold a PR back, so a verdict that was waiting on it is genuinely
 * unblocked. Everything else -- `failure`, `cancelled`, `timed_out`,
 * `action_required`, `stale`, or a null conclusion -- is NOT a pass, and must
 * never trigger a re-review: the reviewer's rejection still stands, and
 * re-running the model would churn a valid CHANGES_REQUESTED.
 */
export const PASSING_CONCLUSIONS = ['success', 'neutral', 'skipped'] as const;

/** True when a completed check's conclusion means "this check is no longer blocking". */
export function conclusionIsPassing(conclusion: string | null | undefined): boolean {
  if (typeof conclusion !== 'string') return false;
  return (PASSING_CONCLUSIONS as readonly string[]).includes(conclusion.toLowerCase());
}

const FINDING_LINE_RE = /^\[(blocker|major|minor|note)\]\s+(.+)$/i;
const CHECKS_SCOPE_PREFIX = 'checks/';

/**
 * Split a persisted review summary into finding lines.
 *
 * The reviewer posts `[severity] scope: summary` (pr-review-wiring). The real
 * discriminator is `IndependentReviewFinding.scope`: check failures use the
 * `checks/` prefix; code findings use a path.
 */
function parseReviewFindingLines(
  summary: string | null | undefined
): { severity: string; scope: string }[] {
  if (typeof summary !== 'string' || summary.length === 0) return [];
  const findings: { severity: string; scope: string }[] = [];
  for (const raw of summary.split(/\r?\n/)) {
    const line = raw.trim();
    const match = FINDING_LINE_RE.exec(line);
    if (!match) continue;
    const rest = match[2] ?? '';
    const colon = rest.indexOf(':');
    const scope = (colon === -1 ? rest : rest.slice(0, colon)).trim();
    if (scope.length === 0) continue;
    findings.push({ severity: (match[1] ?? '').toLowerCase(), scope });
  }
  return findings;
}

/**
 * Check names the standing verdict actually rejected for, from `checks/`
 * finding lines. Moved here from the stale sweep (round 4) so ingest and
 * sweep share one extractor.
 *
 * Unstructured prose (no finding lines) returns empty: the caller then falls
 * back to every latest attempt when verifying via listForRef. Do not
 * GitHub-read required contexts here.
 */
export function blockingCheckNamesFromVerdict(summary: string | null | undefined): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const finding of parseReviewFindingLines(summary)) {
    const scope = finding.scope;
    if (!scope.toLowerCase().startsWith(CHECKS_SCOPE_PREFIX)) continue;
    const name = scope
      .slice(CHECKS_SCOPE_PREFIX.length)
      .trim()
      .replace(/\s+failed\b.*$/i, '')
      .trim();
    const key = name.toLowerCase();
    if (name.length === 0 || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

function isSuiteLevelCheckId(checkId: string): boolean {
  return checkId.startsWith('workflow_run:') || checkId.startsWith('check_suite:');
}

/**
 * Sweep-style matcher: exact, or bare context vs matrix job. Two different
 * matrix cells (windows vs ubuntu) do not match each other.
 */
function checkNameMatchesBlockingName(checkName: string, named: string): boolean {
  const runName = checkName.trim().toLowerCase();
  const want = named.trim().toLowerCase();
  if (runName.length === 0 || want.length === 0) return false;
  if (runName === want) return true;
  const runBare = runName.replace(/\s*\([^)]*\)\s*$/, '').trim();
  const wantBare = want.replace(/\s*\([^)]*\)\s*$/, '').trim();
  if (runBare.length >= 3 && runBare === want) return true;
  if (wantBare.length >= 3 && wantBare === runName) return true;
  return false;
}

function checkAttemptKey(run: RecheckCheckRun): string {
  const name = (run.name ?? 'check').trim().toLowerCase();
  const app = (run.app?.slug ?? run.app?.name ?? '').trim().toLowerCase();
  return app.length > 0 ? `${name}@${app}` : name;
}

function checkAttemptRank(run: RecheckCheckRun): number {
  const completed = typeof run.completed_at === 'string' ? Date.parse(run.completed_at) : NaN;
  if (Number.isFinite(completed)) return completed;
  const started = typeof run.started_at === 'string' ? Date.parse(run.started_at) : NaN;
  if (Number.isFinite(started)) return started;
  return Number.NEGATIVE_INFINITY;
}

function checkAttemptIsNewer(candidate: RecheckCheckRun, current: RecheckCheckRun): boolean {
  const candidateRank = checkAttemptRank(candidate);
  const currentRank = checkAttemptRank(current);
  if (candidateRank !== currentRank) return candidateRank > currentRank;
  return (candidate.id ?? 0) > (current.id ?? 0);
}

function latestAttemptPerCheck(runs: RecheckCheckRun[]): RecheckCheckRun[] {
  const latest = new Map<string, RecheckCheckRun>();
  for (const run of runs) {
    const key = checkAttemptKey(run);
    const held = latest.get(key);
    if (!held || checkAttemptIsNewer(run, held)) latest.set(key, run);
  }
  return [...latest.values()];
}

function latestAttemptIsBlocking(
  run: RecheckCheckRun,
  blockingCheckNames: readonly string[]
): boolean {
  if (blockingCheckNames.length === 0) return true;
  return blockingCheckNames.some(name => checkNameMatchesBlockingName(run.name ?? '', name));
}

function blockingNamesAllHaveAttempts(
  current: RecheckCheckRun[],
  blockingCheckNames: readonly string[]
): boolean {
  if (blockingCheckNames.length === 0) return true;
  return blockingCheckNames.every(name =>
    current.some(run => checkNameMatchesBlockingName(run.name ?? '', name))
  );
}

/**
 * True when every verdict-named blocking check's LATEST attempt is passing.
 * Incomplete listForRef evidence is fail-closed. Empty names keep the sweep's
 * every-latest-attempt fallback.
 */
export function namedBlockingChecksAreGreen(
  runs: RecheckCheckRun[],
  blockingCheckNames: readonly string[],
  complete = true
): boolean {
  if (!complete) return false;
  const current = latestAttemptPerCheck(runs);
  if (current.length === 0) return false;
  const blocking = blockingCheckNames.map(name => name.trim()).filter(name => name.length > 0);
  let allChecksGreen = true;
  for (const run of current) {
    if (
      latestAttemptIsBlocking(run, blocking) &&
      (run.status !== 'completed' || !conclusionIsPassing(run.conclusion))
    ) {
      allChecksGreen = false;
    }
  }
  return allChecksGreen && blockingNamesAllHaveAttempts(current, blocking);
}

async function suiteBlockingChecksAreGreen(
  deps: RecheckIngestDeps,
  input: { owner: string; repo: string; headSha: string; summary?: string | null }
): Promise<boolean> {
  if (!deps.listCheckRunsForRef) return false;
  try {
    const listed = await deps.listCheckRunsForRef({
      owner: input.owner,
      repo: input.repo,
      headSha: input.headSha,
    });
    return namedBlockingChecksAreGreen(
      listed.runs,
      blockingCheckNamesFromVerdict(input.summary),
      listed.complete
    );
  } catch {
    // Fail closed: a listForRef fault must not enqueue. The sweep is the backstop.
    return false;
  }
}

/**
 * Does the completed check bear on what the standing verdict was actually
 * waiting for?
 *
 * THE GAP THIS CLOSES (#786 review @18df6323): the recheck path used to fire on
 * ANY completed check, so an unrelated job going green -- or the SAME job going
 * red again -- re-ran the reviewer against an unchanged head and could churn a
 * valid CHANGES_REQUESTED.
 *
 * The test is deliberately asymmetric between the two authorizing verdicts:
 *
 *  - `checks_pending` carries NO check names (the reviewer deferred before
 *    forming a finding, and its summary is the empty string). There is nothing
 *    to match against, so any PASSING completion is relevant -- that is exactly
 *    the event the deferral was waiting for. Requiring a name here would make
 *    the deferral case permanently unrecoverable.
 *
 *  - `changes_requested` DOES name its checks, in the finding text
 *    (`[major] checks/test (windows-latest): ...`). A completion is relevant
 *    only when the verdict's summary mentions that check's name. This is the
 *    fail-closed direction: an unrecognised name is treated as unrelated, so a
 *    stray green job cannot clear a real rejection.
 *
 *  - A SUITE-level unit (`workflow_run`, `check_suite`) is relevant only when
 *    the payload name matches a verdict-named `checks/` finding
 *    (case-insensitive, bare-context tolerant, same matcher as the sweep).
 *    When the name cannot be matched, this function returns false and the
 *    ingest path may still enqueue after listForRef shows every named
 *    blocking check's latest attempt is passing.
 *
 * NO GITHUB READ. The spec's alternative -- "the required-context set for the
 * head is now fully green" -- would need a `checks.listForRef` call per
 * completion event, on a path that exists precisely because the shared per-user
 * rate budget is what collapsed the review on #776. The sweep, which already
 * spends one bounded GitHub read per candidate, is where a whole-suite check
 * belongs; see `allRelevantChecksGreen` there.
 */
export function completionIsRelevantToVerdict(
  verdict: StandingVerdict,
  completion: { checkName: string; checkId?: string }
): boolean {
  // The deferral case names nothing and is unblocked by any passing completion.
  if (verdict.disposition === 'checks_pending') return true;

  // Mixed check-and-code rejections must not auto-clear: a green check does
  // not unwind a code finding that still stands. Checked before the suite-level
  // early return so a green workflow_run cannot authorize a mixed verdict.
  if (verdict.disposition === 'changes_requested' && !summaryNamesACheck(verdict.summary)) {
    return false;
  }

  // A SUITE-LEVEL completion (`workflow_run` / `check_suite`) that concluded
  // passing means EVERY job inside it passed, including whichever one the
  // verdict named. That is strictly stronger evidence than a single job going
  // green, so it is always relevant -- and its name ("CI") deliberately will
  // not match an individual job name like "test (windows-latest)".
  const checkId = completion.checkId ?? '';
  if (isSuiteLevelCheckId(checkId)) {
    const blocking = blockingCheckNamesFromVerdict(verdict.summary);
    return blocking.some(name => checkNameMatchesBlockingName(completion.checkName, name));
  }

  const summary = typeof verdict.summary === 'string' ? verdict.summary.toLowerCase() : '';
  if (summary.length === 0) return false;

  const name = completion.checkName.trim().toLowerCase();
  if (name.length === 0) return false;

  // Exact mention wins: "checks/test (windows-latest)" contains "test
  // (windows-latest)".
  if (summary.includes(name)) return true;

  // GitHub reports a matrix job as `test (windows-latest)` while a required
  // CONTEXT is sometimes just `test`. Compare the bare job name too, so the
  // matrix suffix does not defeat an otherwise exact match. Bounded to a
  // non-trivial stem so a one-letter fragment cannot match everything.
  const bare = name.replace(/\s*\([^)]*\)\s*$/, '').trim();
  return bare.length >= 3 && bare !== name && summary.includes(bare);
}

export function buildRecheckReason(completion: {
  checkName: string;
  checkId: string;
  headSha: string;
  conclusion: string | null;
}): string {
  return `${RECHECK_REASON_PREFIX}${completion.headSha} check ${completion.checkName} (${completion.checkId}) completed ${completion.conclusion ?? 'unknown'}; re-review same head`;
}

function isRecheckEventType(eventType: string | undefined | null): eventType is RecheckEventType {
  return (RECHECK_EVENT_TYPES as readonly string[]).includes(eventType ?? '');
}

/**
 * Pull the completion facts out of whichever of the three event shapes arrived.
 * Returns null when the payload does not describe a COMPLETED unit with a head.
 */
export function extractCheckCompletion(
  eventType: RecheckEventType,
  payload: CheckCompletionWebhookPayload
): CheckCompletion | null {
  const unit =
    eventType === 'check_run'
      ? payload.check_run
      : eventType === 'check_suite'
        ? payload.check_suite
        : payload.workflow_run;
  if (!unit) return null;
  if (unit.status !== 'completed') return null;
  const headSha = unit.head_sha ?? '';
  if (!headSha) return null;
  const id = unit.id;
  if (id === undefined || id === null) return null;
  const named = unit as { name?: string };
  const prNumbers = (unit.pull_requests ?? [])
    .map(reference => reference.number)
    .filter((value): value is number => typeof value === 'number' && value > 0);
  return {
    checkId: `${eventType}:${id}`,
    checkName: named.name ?? eventType,
    headSha,
    conclusion: unit.conclusion ?? null,
    prNumbers: Array.from(new Set(prNumbers)),
  };
}

/**
 * Does this standing verdict authorize an automatic re-review at the same head?
 *
 * TWO cases, both from the spec:
 *  - `checks_pending`: the reviewer explicitly deferred because CI was not
 *    terminal. A completion is exactly the event it was waiting for.
 *  - `changes_requested` BECAUSE OF A CHECK. A rejection grounded in a CODE
 *    finding must NOT be cleared by re-running a job: the code did not change,
 *    so the finding still stands and a re-review would waste a model call and
 *    could churn the verdict. Only a rejection whose evidence names a check is
 *    auto-cleared.
 *
 * Everything else -- approved, custody conflicts, submission failures, and any
 * disposition this module does not recognize -- is deliberately NOT authorizing.
 * Failing closed here costs one missed automatic re-review; failing open would
 * let any completion re-run the reviewer on every PR in the repository.
 */
export function verdictAuthorizesRecheck(verdict: StandingVerdict | null): boolean {
  if (!verdict) return false;
  if (verdict.disposition === 'checks_pending') return true;
  if (verdict.disposition !== 'changes_requested') return false;
  return summaryNamesACheck(verdict.summary);
}

/**
 * True when a REQUEST_CHANGES summary blames a check rather than the code.
 *
 * The reviewer writes findings as `[severity] scope: summary`, and a
 * check-caused rejection carries the check in its scope -- live examples from
 * 2026-09-07: `[major] checks/test (windows-latest) failed`. Matching on the
 * `checks/` scope prefix is the structured discriminator. A mixed summary
 * (any finding whose scope is not `checks/`) does NOT authorize: the code
 * finding still stands after a green rerun. Unstructured prose falls back to
 * the small set of phrases the reviewer actually emits; an unrecognized
 * summary is treated as a code finding and does NOT authorize.
 */
export function summaryNamesACheck(summary: string | null | undefined): boolean {
  if (typeof summary !== 'string' || summary.trim().length === 0) return false;
  const findings = parseReviewFindingLines(summary);
  if (findings.length > 0) {
    return findings.every(finding => finding.scope.trim().toLowerCase().startsWith('checks/'));
  }
  const text = summary.toLowerCase();
  return (
    text.includes('checks/') ||
    text.includes('check run') ||
    text.includes('required check') ||
    text.includes('ci check') ||
    /\bcheck\b[^\n]*\bfail/.test(text) ||
    /\bfail[^\n]*\bcheck\b/.test(text)
  );
}

/**
 * Verify, ingest, and enqueue at most one re-review per (head, completed check)
 * per open pull request the completion belongs to.
 *
 * Fails closed at every branch: a missing secret, a bad signature, an
 * unparseable body, a non-completed unit, an absent PR reference, or an absent
 * authorizing verdict all produce a receipt and a non-queued disposition.
 */
export async function ingestCheckCompletionEvent(
  request: RecheckIngestRequest,
  deps: RecheckIngestDeps
): Promise<RecheckIngestResult> {
  const deliveryId = request.deliveryId?.trim() ?? '';

  if (!deps.webhookSecret) {
    return await finish(deps, deliveryId, {
      disposition: 'blocked',
      status: 500,
      reason: 'webhook_secret_not_configured',
    });
  }

  const signature = checkGitHubWebhookSignature(
    request.rawBody,
    request.signature,
    deps.webhookSecret
  );
  if (!signature.valid) {
    return await finish(deps, deliveryId, {
      disposition: 'rejected_signature',
      status: 401,
      reason: `signature_${signature.reason ?? 'invalid'}`,
    });
  }

  // Only parse AFTER the signature passes -- unverified input is never parsed.
  let payload: CheckCompletionWebhookPayload;
  try {
    payload = JSON.parse(request.rawBody) as CheckCompletionWebhookPayload;
  } catch {
    return await finish(deps, deliveryId, {
      disposition: 'blocked',
      status: 400,
      reason: 'payload_unparseable',
    });
  }

  if (!isRecheckEventType(request.eventType)) {
    return await finish(deps, deliveryId, {
      disposition: 'ignored_event',
      status: 200,
      reason: 'event_type_not_check_completion',
    });
  }
  if (payload.action !== 'completed') {
    return await finish(deps, deliveryId, {
      disposition: 'ignored_not_completed',
      status: 200,
      reason: 'action_not_completed',
    });
  }

  const owner = payload.repository?.owner?.login ?? '';
  const repo = payload.repository?.name ?? '';
  const completion = extractCheckCompletion(request.eventType, payload);
  if (!owner || !repo || !completion) {
    return await finish(deps, deliveryId, {
      disposition: 'blocked',
      status: 400,
      reason: 'incomplete_check_completion_context',
      owner,
      repo,
    });
  }

  // NO GITHUB READ HERE. GitHub embeds the associated pull requests in the
  // event itself; when it embeds none (a push to a branch with no PR, or a
  // fork-sourced run) there is nothing to re-review and querying the API for
  // every completion in every watched repo would burn the shared per-user
  // budget that already collapsed one review (#776).
  if (completion.prNumbers.length === 0) {
    return await finish(deps, deliveryId, {
      disposition: 'ignored_no_open_pull_request',
      status: 200,
      reason: 'event_carries_no_pull_request',
      owner,
      repo,
      headSha: completion.headSha,
    });
  }

  const queuedPrNumbers: number[] = [];
  let lastCorrelationId: string | undefined;
  let lastMessageId: string | undefined;
  let anyAuthorized = false;
  let allDuplicates = true;

  for (const prNumber of completion.prNumbers) {
    const correlationId = recheckCorrelationId({
      owner,
      repo,
      prNumber,
      headSha: completion.headSha,
    });

    let verdict: StandingVerdict | null;
    try {
      verdict = await deps.readStandingVerdict({
        owner,
        repo,
        prNumber,
        headSha: completion.headSha,
      });
    } catch (error) {
      return await finish(deps, deliveryId, {
        disposition: 'blocked',
        status: 500,
        reason: `standing_verdict_read_failed:${errorCode(error)}`,
        correlationId,
        owner,
        repo,
        prNumber,
        headSha: completion.headSha,
      });
    }

    if (!verdictAuthorizesRecheck(verdict)) {
      await safeReceipt(deps, {
        correlationId,
        deliveryId,
        owner,
        repo,
        prNumber,
        headSha: completion.headSha,
        disposition: 'ignored_no_authorizing_verdict',
        reason: verdict
          ? `verdict_not_check_caused:${verdict.disposition}`
          : 'no_standing_verdict_at_head',
      });
      continue;
    }

    // THE COMPLETION ITSELF MUST WARRANT THE RE-REVIEW (#786 review @18df6323).
    // An authorizing verdict says the PR is ELIGIBLE; it does not say THIS
    // event is the one that changed anything. A check that failed, was
    // cancelled, or is unrelated to what the verdict named leaves the rejection
    // exactly as valid as it was, and re-running the reviewer on an unchanged
    // head would churn it.
    if (!conclusionIsPassing(completion.conclusion)) {
      await safeReceipt(deps, {
        correlationId,
        deliveryId,
        owner,
        repo,
        prNumber,
        headSha: completion.headSha,
        disposition: 'ignored_check_not_actionable',
        reason: `rereview_skipped_check_not_success:${completion.checkName}:${completion.conclusion ?? 'null'}`,
      });
      continue;
    }

    if (
      !verdict ||
      !completionIsRelevantToVerdict(verdict, {
        checkName: completion.checkName,
        checkId: completion.checkId,
      })
    ) {
      let verifiedGreen = false;
      if (verdict && isSuiteLevelCheckId(completion.checkId)) {
        verifiedGreen = await suiteBlockingChecksAreGreen(deps, {
          owner,
          repo,
          headSha: completion.headSha,
          summary: verdict.summary,
        });
      }
      if (verifiedGreen) {
        // Name did not match; listForRef showed every named blocking check green.
      } else {
        await safeReceipt(deps, {
          correlationId,
          deliveryId,
          owner,
          repo,
          prNumber,
          headSha: completion.headSha,
          disposition: 'ignored_check_not_actionable',
          reason: `rereview_skipped_check_not_relevant:${completion.checkName}`,
        });
        continue;
      }
    }

    anyAuthorized = true;
    try {
      const enqueued = await deps.enqueueRecheckWork({
        correlationId,
        idempotencyKey: recheckIdempotencyKey({
          owner,
          repo,
          prNumber,
          headSha: completion.headSha,
          checkId: completion.checkId,
        }),
        owner,
        repo,
        prNumber,
        headSha: completion.headSha,
        repeatReason: buildRecheckReason(completion),
      });
      lastCorrelationId = correlationId;
      lastMessageId = enqueued.messageId;
      if (!enqueued.alreadyExisted) {
        allDuplicates = false;
        queuedPrNumbers.push(prNumber);
      }
      await safeReceipt(deps, {
        correlationId,
        deliveryId,
        owner,
        repo,
        prNumber,
        headSha: completion.headSha,
        disposition: enqueued.alreadyExisted ? 'duplicate_delivery' : 'queued',
        messageId: enqueued.messageId,
        ...(enqueued.alreadyExisted ? { reason: 'idempotent_replay' } : {}),
      });
    } catch (error) {
      return await finish(deps, deliveryId, {
        disposition: 'blocked',
        status: 500,
        reason: `enqueue_failed:${errorCode(error)}`,
        correlationId,
        owner,
        repo,
        prNumber,
        headSha: completion.headSha,
      });
    }
  }

  if (!anyAuthorized) {
    return {
      disposition: 'ignored_no_authorizing_verdict',
      status: 200,
      reason: 'no_pull_request_had_a_check_caused_verdict',
      headSha: completion.headSha,
    };
  }

  return {
    disposition: allDuplicates ? 'duplicate_delivery' : 'queued',
    status: 200,
    headSha: completion.headSha,
    ...(lastCorrelationId ? { correlationId: lastCorrelationId } : {}),
    ...(lastMessageId ? { messageId: lastMessageId } : {}),
    ...(allDuplicates ? { reason: 'idempotent_replay' } : { prNumbers: queuedPrNumbers }),
  };
}

function errorCode(error: unknown): string {
  if (error instanceof Error && error.message) return error.message.slice(0, 120);
  return 'unknown_error';
}

async function finish(
  deps: RecheckIngestDeps,
  deliveryId: string,
  outcome: RecheckIngestResult & {
    owner?: string;
    repo?: string;
    prNumber?: number;
  }
): Promise<RecheckIngestResult> {
  await safeReceipt(deps, {
    correlationId: outcome.correlationId ?? '',
    deliveryId,
    owner: outcome.owner ?? '',
    repo: outcome.repo ?? '',
    prNumber: outcome.prNumber ?? null,
    headSha: outcome.headSha ?? null,
    disposition: outcome.disposition,
    ...(outcome.reason ? { reason: outcome.reason } : {}),
  });
  const result: RecheckIngestResult = {
    disposition: outcome.disposition,
    status: outcome.status,
  };
  if (outcome.reason) result.reason = outcome.reason;
  if (outcome.correlationId) result.correlationId = outcome.correlationId;
  if (outcome.headSha) result.headSha = outcome.headSha;
  return result;
}

/**
 * Receipt persistence must never convert a classified outcome into an unhandled
 * throw. The ingest disposition stands regardless.
 */
async function safeReceipt(
  deps: RecheckIngestDeps,
  input: Parameters<RecheckIngestDeps['recordReceipt']>[0]
): Promise<void> {
  try {
    await deps.recordReceipt(input);
  } catch {
    // Intentionally swallowed: see doc comment.
  }
}
