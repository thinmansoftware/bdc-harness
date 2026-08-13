/**
 * poll.ts -- Polls a workflow run until it reaches a terminal state.
 *
 * Extracts validator verdict, PR URL, and PR mergeability from the run events.
 * Uses event_type === "node_completed" (confirmed from WORKFLOW_EVENT_TYPES in
 * packages/workflows/src/store.ts and packages/workflows/src/event-emitter.ts).
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import type { PollResult } from './types.js';

const execFileAsync = promisify(execFile);

// escalated is terminal (gate-rejection re-label) -- include for status robustness;
// smart-cauldron still treats it like a non-success terminal for climb decisions via
// the returned terminalStatus string.
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'escalated', 'cancelled']);

/**
 * Thrown by pollForTerminal when a run does not reach a terminal state within
 * the poll budget. Distinguishable from network/API errors so callers (the
 * cascade) can treat a progress-timeout as a quality-fail-and-climb signal
 * instead of an infra-error.
 */
export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/** A real HTTP/network failure while reading run state. Never masquerades as progress timeout. */
export class PollTransportError extends Error {
  readonly statusCode: number | null;

  constructor(message: string, statusCode: number | null = null) {
    super(message);
    this.name = 'PollTransportError';
    this.statusCode = statusCode;
  }
}

interface RunApiResponse {
  run: {
    id: string;
    status: string;
    metadata?: Record<string, unknown>;
    completed_at?: string | null;
  };
  events?: {
    event_type: string;
    step_name: string | null;
    data: Record<string, unknown>;
    /** Server-side emit time. Drives liveness/stall detection. */
    created_at?: string | null;
  }[];
}

interface PollOptions {
  runId: string;
  apiBaseUrl: string;
  /** Operator token for Archon API auth. Defaults to ARCHON_OPERATOR_TOKEN env. */
  token?: string;
  /**
   * HARD CEILING on total run duration (ms). Default: 14400000 (4 hours).
   *
   * This is a backstop against true runaways, NOT the normal stop condition --
   * see `stallTimeoutMs`. Measured 2026-07-25 against 252 real runs since
   * 2026-07-01: SUCCESSFUL runs average 24.6 min and reach 74.3 min, while the
   * cancelled cohort averaged 77.9 min and reached 730.9 min (12+ hours). The
   * old 30-minute default sat BELOW the observed success range, so it was
   * killing healthy work -- WO-HARNESS-DISPATCH-SYNC-BEFORE-RESOLVE-01 was
   * actively emitting tool events 56 seconds before it was cut at exactly
   * 30:00.000.
   */
  timeoutMs?: number;
  /**
   * STALL DETECTION (ms of silence). Default: 1200000 (20 minutes).
   *
   * The real stop condition. A run is stuck when it stops EMITTING, not when it
   * takes a while -- "has this taken too long?" is unanswerable because WOs
   * cannot be estimated and are getting harder; "is it still doing anything?"
   * is directly observable. If no new event arrives within this window, the run
   * is treated as stalled and the cascade climbs.
   *
   * Set to 0 to disable stall detection and fall back to duration-only.
   */
  stallTimeoutMs?: number;
  /** Poll interval (ms). Default: 30000 (30 seconds). */
  intervalMs?: number;
  /**
   * Retries for the PR-URL lookup when a run reports "completed" but no
   * open-pr node event is visible yet (event feed can lag the status flip --
   * anchor 2026-07-17 WO-HARNESS-WORKTREE-ORPHAN-QUARANTINE-01: gate declared
   * "no PR opened" ~6s after completion while PR #488 existed, causing a tier
   * climb and a duplicate build). Default: 3.
   */
  prRetryAttempts?: number;
  /** Delay between PR-URL lookup retries (ms). Default: 10000 (10 seconds). */
  prRetryDelayMs?: number;
  /**
   * Retries for the ALREADY-OPEN-PR branch lookup (findExistingPrForBranch's
   * `gh pr list --head <branch>` call). Default: 3.
   *
   * DEFECT FIX 2026-08-13 WO-HARNESS-CASCADE-GATE-PR-DETECTION-01 (anchor: issue
   * thinmansoftware/bdc-xo#1502). The event-feed retries above (prRetryAttempts)
   * cover the race where an open-pr NODE EVENT lands late. They do NOT cover the
   * separate GitHub eventual-consistency window on the `gh pr list --head` REST
   * path: a run can push its branch and open a PR, yet `gh pr list --head` return
   * an empty list for several seconds after the run status flips to completed.
   * A single-shot lookup in that window false-negatives -> gate reads "no PR
   * opened" -> ladder climbs on already-landed work (incident #1502: lspro-react
   * PRs #513/#515 existed while the conductor climbed to apex). Retry the branch
   * lookup with backoff before concluding the branch has no PR.
   */
  prBranchLookupAttempts?: number;
  /** Delay between findExistingPrForBranch `gh pr list` retries (ms). Default: 10000. */
  prBranchLookupDelayMs?: number;
  /**
   * Injectable seam for the `gh pr list --head <branch>` lookup. Test-only:
   * production always uses the real gh CLI (ghPrListForBranchDefault). Returns
   * the PR URL for the branch, or null when gh is unavailable / no PR is found.
   */
  ghPrListForBranch?: (branch: string) => Promise<string | null>;
}

/**
 * Poll a workflow run until it reaches a terminal state (completed/failed/cancelled).
 *
 * @returns PollResult with terminal status, validator verdict, PR info, and metadata.
 * @throws If the run does not reach terminal state within timeoutMs.
 */
export async function pollForTerminal(opts: PollOptions): Promise<PollResult> {
  const {
    runId,
    apiBaseUrl,
    token: tokenOverride,
    timeoutMs = 14_400_000,
    stallTimeoutMs = 1_200_000,
    intervalMs = 30_000,
    prRetryAttempts = 3,
    prRetryDelayMs = 10_000,
    prBranchLookupAttempts = 3,
    prBranchLookupDelayMs = 10_000,
    ghPrListForBranch = ghPrListForBranchDefault,
  } = opts;
  const token = tokenOverride ?? process.env.ARCHON_OPERATOR_TOKEN ?? '';

  const deadline = Date.now() + timeoutMs;

  // Liveness tracking. `lastActivityAt` is wall-clock time on OUR side, advanced
  // whenever the run's newest event timestamp moves -- so clock skew between this
  // process and the container cannot make a healthy run look stalled. We only
  // compare the server's timestamps to each other, never to our own clock.
  let newestEventSeen: number | null = null;
  let lastActivityAt = Date.now();

  while (Date.now() < deadline) {
    const detail = await fetchRunDetail(runId, apiBaseUrl, token);

    const newestNow = newestEventTimestamp(detail.events ?? []);
    if (newestNow !== null && (newestEventSeen === null || newestNow > newestEventSeen)) {
      newestEventSeen = newestNow;
      lastActivityAt = Date.now();
    }

    if (TERMINAL_STATUSES.has(detail.run.status)) {
      const terminalStatus = detail.run.status as
        | 'completed'
        | 'failed'
        | 'escalated'
        | 'cancelled';
      let events = detail.events ?? [];

      let validatorVerdict = extractValidatorVerdict(events);
      let prUrl = extractPrUrl(events);

      // Race guard: run status can flip to "completed" before the
      // open-pr-if-needed node event lands in the event feed. A single read
      // taken in that window sees no PR and the gate false-negatives into a
      // tier climb. Re-read the run events with backoff before concluding
      // that no PR was opened.
      if (terminalStatus === 'completed' && prUrl === null) {
        for (let attempt = 0; attempt < prRetryAttempts && prUrl === null; attempt++) {
          await new Promise<void>(resolve => setTimeout(resolve, prRetryDelayMs));
          const retryDetail = await fetchRunDetail(runId, apiBaseUrl, token);
          events = retryDetail.events ?? [];
          prUrl = extractPrUrl(events);
          // The validator event can lag for the same reason -- refresh it too.
          if (validatorVerdict === 'unknown') {
            validatorVerdict = extractValidatorVerdict(events);
          }
        }

        // DEFECT FIX 2026-07-27: the retries above only cover the RACE where an
        // open-pr event lands late. They do not cover the legitimate case where
        // the run was told to converge an existing PR and correctly opened
        // NOTHING. Before failing the gate, ask GitHub whether the branch this
        // run pushed already has an open PR. See findExistingPrForBranch.
        if (prUrl === null) {
          prUrl = await findExistingPrForBranch(
            events,
            ghPrListForBranch,
            prBranchLookupAttempts,
            prBranchLookupDelayMs
          );
          if (prUrl !== null) {
            console.log(
              `[poll] run ${runId} opened no PR, but its pushed branch already has one: ${prUrl} -- treating as satisfied (converge-existing-PR WO)`
            );
          }
        }
      }

      const prMergeable = prUrl ? await checkPrMergeable(prUrl) : null;
      const servedModelId = extractServedModelId(detail.run.metadata ?? {});

      return {
        runId,
        terminalStatus,
        validatorVerdict,
        prUrl,
        prMergeable,
        servedModelId,
        rawMetadata: detail.run.metadata ?? {},
      };
    }

    // Stall check: silence, not duration, is what indicates a stuck run.
    if (stallTimeoutMs > 0) {
      const silentFor = Date.now() - lastActivityAt;
      if (silentFor >= stallTimeoutMs) {
        throw new TimeoutError(
          `[smart-cauldron/poll] Run ${runId} stalled: no new events for ${String(silentFor)}ms ` +
            `(stall budget ${String(stallTimeoutMs)}ms). Last activity was at ` +
            `${newestEventSeen === null ? 'no events observed' : new Date(newestEventSeen).toISOString()}.`
        );
      }
    }

    // Not terminal yet -- wait before next poll
    const remaining = deadline - Date.now();
    const waitMs = Math.min(intervalMs, remaining);
    if (waitMs <= 0) break;
    await new Promise<void>(resolve => setTimeout(resolve, waitMs));
  }

  throw new TimeoutError(
    `[smart-cauldron/poll] Run ${runId} exceeded the ${String(timeoutMs)}ms hard ceiling ` +
      'without reaching a terminal state (it was still emitting events -- this is the runaway ' +
      'backstop, not a stall)'
  );
}

/**
 * Newest event timestamp in ms, or null when there are no parseable timestamps.
 *
 * Events are ordered by the API, but this does not assume that -- it takes the max
 * so an out-of-order or backfilled event cannot make liveness go backwards.
 */
function newestEventTimestamp(events: { created_at?: string | null }[]): number | null {
  let newest: number | null = null;
  for (const ev of events) {
    if (!ev.created_at) continue;
    // SQLite emits "YYYY-MM-DD HH:MM:SS" (space-separated, UTC, no zone marker).
    // Date.parse treats that as LOCAL time on some runtimes, which would skew
    // every comparison. Normalize to ISO-8601 UTC before parsing.
    const raw = ev.created_at.trim();
    const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(raw)
      ? `${raw.replace(' ', 'T')}Z`
      : raw;
    const parsed = Date.parse(iso);
    if (!Number.isNaN(parsed) && (newest === null || parsed > newest)) newest = parsed;
  }
  return newest;
}

async function fetchRunDetail(
  runId: string,
  apiBaseUrl: string,
  token: string
): Promise<RunApiResponse> {
  let res: Response;
  try {
    res = await fetch(`${apiBaseUrl}/api/workflows/runs/${encodeURIComponent(runId)}`, {
      headers: { 'x-archon-operator-token': token },
    });
  } catch (error) {
    throw new PollTransportError(
      `[smart-cauldron/poll] Network failure reading run ${runId}: ${(error as Error).message}`
    );
  }
  if (!res.ok) {
    throw new PollTransportError(
      `[smart-cauldron/poll] HTTP ${String(res.status)} reading run ${runId}`,
      res.status
    );
  }
  return (await res.json()) as RunApiResponse;
}

/**
 * Extract war-council-validator verdict from node_completed events.
 *
 * Scans for event_type === "node_completed" AND step_name === "war-council-validator".
 * Checks data.output string for "satisfied" or "needs_revision".
 */
function extractValidatorVerdict(
  events: { event_type: string; step_name: string | null; data: Record<string, unknown> }[]
): 'satisfied' | 'needs_revision' | 'unknown' {
  for (const ev of events) {
    if (ev.event_type === 'node_completed' && ev.step_name === 'war-council-validator') {
      const output = typeof ev.data.output === 'string' ? ev.data.output : '';
      if (/\bsatisfied\b/i.test(output)) return 'satisfied';
      if (/\bneeds[_-]revision\b/i.test(output) || /\bneeds revision\b/i.test(output))
        return 'needs_revision';
    }
  }
  return 'unknown';
}

/**
 * Extract PR URL from node_completed events.
 *
 * Looks for node with step_name matching "open-pr" or containing "pr".
 * Parses PR_URL=https://... pattern from data.output.
 */
function extractPrUrl(
  events: { event_type: string; step_name: string | null; data: Record<string, unknown> }[]
): string | null {
  const prUrlPattern = /PR_URL=(https?:\/\/\S+)/i;

  for (const ev of events) {
    if (ev.event_type !== 'node_completed') continue;
    const stepName = ev.step_name ?? '';
    if (stepName !== 'open-pr' && !stepName.toLowerCase().includes('pr')) continue;

    const output = typeof ev.data.output === 'string' ? ev.data.output : '';
    const match = prUrlPattern.exec(output);
    if (match?.[1]) return match[1];

    // Also check for raw GitHub PR URL in output
    const rawMatch = /(https:\/\/github\.com\/[^\s]+\/pull\/\d+)/.exec(output);
    if (rawMatch?.[1]) return rawMatch[1];
  }

  return null;
}

/**
 * Find an ALREADY-OPEN PR for the branch this run pushed to.
 *
 * DEFECT FIX 2026-07-27 (anchor: WO-CRM-SUPABASE-CONVERGENCE-01, cascade
 * dispatch-e252e3db). The gate asks "did this run open a PR?" and treats no
 * for an answer as failure. But a WO can legitimately instruct the builder to
 * CONVERGE AN EXISTING PR ("do NOT open a competing PR"). The builder obeys,
 * pushes to the existing branch, opens nothing -- and the gate reads that
 * correct behavior as "no PR opened after completed run", fails the tier, and
 * climbs. Observed cost: three runs (codex -> claude -> frontier), two useless
 * tier climbs, and two spurious salvage PRs opened against work that was
 * already correct and already green.
 *
 * So before concluding no PR exists, ASK GITHUB whether the pushed branch
 * already has one. Returns null when gh is unavailable or nothing is found --
 * callers must treat null as "unknown", never as "confirmed absent".
 *
 * The pushed / PR-head branch is ALWAYS the workflow's UNIQUE_BRANCH
 * ("${BRANCH}-thread-${THREAD_ID}", BRANCH validated ^(feat|fix|wip)/...),
 * emitted by the commit-and-push node as `unique_branch=<name>` (verified in
 * bdc-feature-development-zero.yaml:2316 and siblings). `archon/thread-<hash>`
 * is only the LOCAL worktree ref used to derive THREAD_ID -- it is never the
 * pushed branch -- so matching on the parsed `unique_branch=` value and passing
 * it to `gh pr list --head` is the correct attribution for every ladder rung.
 *
 * RETRY (2026-08-13 WO-HARNESS-CASCADE-GATE-PR-DETECTION-01, issue #1502): the
 * `gh pr list --head` REST path has its own GitHub eventual-consistency window
 * that is independent of the caller's event-feed re-read loop. A single-shot
 * lookup can return an empty list for several seconds after a PR was opened,
 * false-negativing the gate and climbing the ladder on already-landed work.
 * Retry the lookup with backoff before returning null.
 */
async function findExistingPrForBranch(
  events: { event_type: string; step_name: string | null; data: Record<string, unknown> }[],
  lookup: (branch: string) => Promise<string | null>,
  attempts: number,
  delayMs: number
): Promise<string | null> {
  // The commit-and-push node reports its final target as unique_branch=<name>.
  let branch: string | null = null;
  for (const ev of events) {
    const output = typeof ev.data.output === 'string' ? ev.data.output : '';
    const m = /unique_branch=(\S+)/.exec(output);
    if (m?.[1]) branch = m[1];
  }
  if (!branch) return null;

  // At least one attempt regardless of a zero/negative attempts value.
  const totalAttempts = attempts > 0 ? attempts : 1;
  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    if (attempt > 0) {
      await new Promise<void>(resolve => setTimeout(resolve, delayMs));
    }
    const url = await lookup(branch);
    if (url !== null) return url;
  }
  return null;
}

/**
 * Default `gh pr list --head <branch>` lookup used in production. Returns the
 * open PR URL for the branch, or null when gh is unavailable or nothing matches.
 * Callers must treat null as "unknown", never as "confirmed absent".
 */
async function ghPrListForBranchDefault(branch: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('gh', [
      'pr',
      'list',
      '--head',
      branch,
      '--state',
      'open',
      '--json',
      'url',
      '--jq',
      '.[0].url // empty',
    ]);
    const url = stdout.trim();
    return url.length > 0 ? url : null;
  } catch {
    return null;
  }
}

/**
 * Extract served model ID from run metadata.
 * Checks metadata.served_model_id and metadata.model_id.
 */
function extractServedModelId(metadata: Record<string, unknown>): string | null {
  const id = metadata.served_model_id ?? metadata.model_id;
  return typeof id === 'string' ? id : null;
}

/**
 * Check if a PR is mergeable via the gh CLI.
 * Returns null if gh is unavailable or returns non-zero.
 */
async function checkPrMergeable(prUrl: string): Promise<boolean | null> {
  try {
    const { stdout } = await execFileAsync('gh', [
      'pr',
      'view',
      prUrl,
      '--json',
      'mergeable',
      '--jq',
      '.mergeable',
    ]);
    const val = stdout.trim().toUpperCase();
    if (val === 'MERGEABLE') return true;
    if (val === 'CONFLICTING' || val === 'BLOCKED') return false;
    return null;
  } catch {
    return null;
  }
}
