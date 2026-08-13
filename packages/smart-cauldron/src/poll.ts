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
   * Target GitHub repository ("owner/name") the run's PR would be opened on.
   * When set, branch-based PR lookups pass `--repo` to gh so attribution works
   * even when the conductor's cwd is a DIFFERENT repo than the WO's target.
   * Anchor incident 2026-08-11 (bdc-xo#1502): lspro-react PRs #513/#515 were
   * invisible to a gate whose gh resolved the repo from the bdc-harness cwd,
   * so the ladder climbed to apex on finished work. When absent, gh falls back
   * to its cwd-derived repo (legacy behavior).
   */
  repo?: string;
  /**
   * Injectable gh CLI runner (tests). Defaults to execFile('gh', args).
   * Keeps PR-lookup tests hermetic -- no live GitHub calls.
   */
  execGh?: GhRunner;
}

/** Runs the gh CLI with the given args and resolves with its stdout. */
export type GhRunner = (args: string[]) => Promise<{ stdout: string }>;

const defaultGhRunner: GhRunner = async args => {
  const { stdout } = await execFileAsync('gh', args);
  return { stdout };
};

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
    repo,
    execGh = defaultGhRunner,
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
      //
      // DEFECT FIX 2026-08-13 (WO-HARNESS-CASCADE-GATE-PR-DETECTION-01, anchor
      // bdc-xo#1502): the branch-based GitHub lookup used to run ONCE, only
      // after the event-feed retries were exhausted. GitHub's PR list is itself
      // eventually consistent right after a run completes, so a single query in
      // that window returned empty and the gate false-negatived at EVERY rung
      // (lspro-react PRs #513-#518, apex burned on finished work). The lookup
      // now runs on the initial read AND inside each bounded retry, so a
      // briefly-empty PR list gets re-asked before the gate concludes no-PR.
      // Retries stay bounded and the whole path is read-only/idempotent.
      if (terminalStatus === 'completed' && prUrl === null) {
        let foundViaGitHub = false;
        prUrl = await findExistingPrForBranch(events, repo, execGh);
        foundViaGitHub = prUrl !== null;
        for (let attempt = 0; attempt < prRetryAttempts && prUrl === null; attempt++) {
          await new Promise<void>(resolve => setTimeout(resolve, prRetryDelayMs));
          const retryDetail = await fetchRunDetail(runId, apiBaseUrl, token);
          events = retryDetail.events ?? [];
          prUrl = extractPrUrl(events);
          // The validator event can lag for the same reason -- refresh it too.
          if (validatorVerdict === 'unknown') {
            validatorVerdict = extractValidatorVerdict(events);
          }
          // DEFECT FIX 2026-07-27: the event retries only cover the RACE where
          // an open-pr event lands late. They do not cover the legitimate case
          // where the run was told to converge an existing PR and correctly
          // opened NOTHING, nor a run whose PR event output lacks a URL. Before
          // failing the gate, ask GitHub whether a branch this run pushed
          // already has an open PR. See findExistingPrForBranch.
          if (prUrl === null) {
            prUrl = await findExistingPrForBranch(events, repo, execGh);
            foundViaGitHub = prUrl !== null;
          }
        }
        if (foundViaGitHub && prUrl !== null) {
          console.log(
            `[poll] run ${runId} reported no PR event, but a branch it pushed has an open PR: ${prUrl} -- treating as satisfied`
          );
        }
      }

      const prMergeable = prUrl ? await checkPrMergeable(prUrl, execGh) : null;
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
 * Upper bound on branch candidates queried per fallback invocation. Keeps the
 * gh call count bounded (idempotency requirement: retries are bounded).
 */
const MAX_BRANCH_CANDIDATES = 8;

/**
 * Collect every branch this run plausibly pushed, from its event outputs.
 *
 * Two sources, in attribution-priority order:
 *   1. `unique_branch=<name>` markers emitted by the commit-and-push node --
 *      the canonical PR branch. Later markers win (a retry may retarget), so
 *      they are returned newest-first.
 *   2. Branch tokens matching the push patterns a run can actually produce
 *      (verified against the active bdc-feature-development-* workflow YAMLs):
 *      `(feat|fix|wip)/wo-*` feature branches and the engine's per-run
 *      `archon/thread-<hash>` worktree branch, which the implement loop pushes
 *      directly (Patch 2 commit-and-push) even when the marker is never
 *      emitted. Anchor bdc-xo#1502: matching ONLY the marker missed both.
 *
 * Deduplicated, capped at MAX_BRANCH_CANDIDATES.
 */
function collectCandidateBranches(
  events: { event_type: string; step_name: string | null; data: Record<string, unknown> }[]
): string[] {
  const candidates: string[] = [];
  const add = (branch: string): void => {
    if (branch.length > 0 && !candidates.includes(branch)) candidates.push(branch);
  };

  // Source 1: unique_branch= markers, newest-first.
  const markers: string[] = [];
  for (const ev of events) {
    const output = typeof ev.data.output === 'string' ? ev.data.output : '';
    const markerPattern = /unique_branch=(\S+)/g;
    let m: RegExpExecArray | null;
    while ((m = markerPattern.exec(output)) !== null) {
      if (m[1]) markers.push(m[1]);
    }
  }
  for (const marker of markers.reverse()) add(marker);

  // Source 2: push-pattern branch tokens anywhere in event outputs.
  const tokenPattern = /\b(?:archon\/thread-[A-Za-z0-9_-]+|(?:feat|fix|wip)\/wo-[A-Za-z0-9_-]+)\b/g;
  for (const ev of events) {
    const output = typeof ev.data.output === 'string' ? ev.data.output : '';
    let m: RegExpExecArray | null;
    while ((m = tokenPattern.exec(output)) !== null) {
      add(m[0]);
    }
  }

  return candidates.slice(0, MAX_BRANCH_CANDIDATES);
}

/**
 * Find an ALREADY-OPEN PR for a branch this run pushed.
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
 * DEFECT FIX 2026-08-13 (WO-HARNESS-CASCADE-GATE-PR-DETECTION-01, anchor
 * bdc-xo#1502): two attribution gaps closed.
 *   (a) The gh query carried no --repo, so gh resolved the repo from the
 *       CONDUCTOR'S cwd -- PRs on any other repo (lspro-react #513/#515) were
 *       invisible at every rung. `repo` ("owner/name") now scopes the lookup.
 *   (b) Only the last `unique_branch=` marker was checked. Runs that push the
 *       engine's `archon/thread-*` branch without emitting the marker, or that
 *       dual-push `archon/thread-*` + `feat/wo-*`, were unattributable. All
 *       candidate branches are now queried (see collectCandidateBranches).
 *
 * So before concluding no PR exists, ASK GITHUB whether a pushed branch
 * already has one. Returns null when gh is unavailable or nothing is found --
 * callers must treat null as "unknown", never as "confirmed absent". gh
 * failures are logged (not swallowed) so a broken lookup is visible in the
 * cascade output.
 */
async function findExistingPrForBranch(
  events: { event_type: string; step_name: string | null; data: Record<string, unknown> }[],
  repo?: string,
  execGh: GhRunner = defaultGhRunner
): Promise<string | null> {
  const candidates = collectCandidateBranches(events);

  for (const branch of candidates) {
    const args = ['pr', 'list'];
    if (repo) args.push('--repo', repo);
    args.push('--head', branch, '--state', 'open', '--json', 'url', '--jq', '.[0].url // empty');
    try {
      const { stdout } = await execGh(args);
      const url = stdout.trim();
      if (url.length > 0) return url;
    } catch (err) {
      console.log(
        `[poll] gh pr list --head ${branch}${repo ? ` --repo ${repo}` : ''} failed: ` +
          `${(err as Error).message} (result is UNKNOWN, not confirmed-absent)`
      );
    }
  }

  return null;
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
async function checkPrMergeable(
  prUrl: string,
  execGh: GhRunner = defaultGhRunner
): Promise<boolean | null> {
  try {
    const { stdout } = await execGh([
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
