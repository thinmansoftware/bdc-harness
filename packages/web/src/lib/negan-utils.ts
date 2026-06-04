/**
 * WO-MC-NEGAN-DIAGNOSTIC-GRAPH-01 -- pure utilities for the diagnostic Mission
 * Control surfaces (FailureReason, LucilleHint, FleetStrip co-fire detection,
 * CostBurnMeter math, live-status discriminator).
 *
 * No React deps. No SDK deps. Every input here is data the runs/events API
 * already surfaces -- the spec's "read the resolver before adding surfaces"
 * rule applied to this WO too. See WO Section 7 for verified field availability:
 *   - DashboardRunResponse.codebase_name (already returned by listDashboardRuns)
 *   - WorkflowRunResponse.metadata.total_cost_usd (already populated by
 *     WO-HARNESS-TOKEN-ATTRIBUTION-01)
 *   - WorkflowRunResponse.metadata.approval (server stores onRejectPrompt and
 *     onRejectMaxAttempts under metadata.approval at workflow definition time;
 *     client sees it through the `Record<string, unknown>` cast).
 */
import type { DashboardRunResponse, WorkflowRunResponse } from '@/lib/api';
import type { WorkflowRunStatus } from '@/lib/types';
import { ensureUtc } from '@/lib/format';

/**
 * Classify a raw node error string into a short, scannable label rendered on
 * the failed node face. The full raw error remains accessible in the existing
 * tooltip and in NodePeekPanel -- this is the "point at the brain" label, not
 * a replacement for the body of the message.
 *
 * Order of checks is significant: provider/model 400s ("not supported",
 * "gpt-5.3-codex...") are checked first because the codex saga (2026-06-02)
 * was the anchor wound this surface was built for.
 *
 * Returns undefined for undefined/empty input (the node is healthy or the
 * error has not been surfaced yet).
 */
export function classifyNodeError(error: string | undefined | null): string | undefined {
  if (error === undefined || error === null) return undefined;
  const trimmed = error.trim();
  if (trimmed.length === 0) return undefined;
  const lc = trimmed.toLowerCase();

  // Model/provider error: gpt-* / codex + 400 / not supported.
  const looksLikeModelRef = lc.includes('gpt') || lc.includes('codex');
  const looksLikeModelFailure = lc.includes('400') || lc.includes('not supported');
  if (looksLikeModelRef && looksLikeModelFailure) {
    return 'codex 400: model not supported';
  }

  // Auth: 401, "unauthorized", or "auth" / "api key" hints.
  if (
    lc.includes('401') ||
    lc.includes('unauthorized') ||
    lc.includes('api key') ||
    /\bauth\b/.test(lc)
  ) {
    return 'auth failure';
  }

  // Rate limit: 429, "rate limit", "too many".
  if (lc.includes('429') || lc.includes('rate limit') || lc.includes('too many')) {
    return 'rate limit';
  }

  // Timeout: ETIMEDOUT, "timeout".
  if (lc.includes('etimedout') || lc.includes('timed out') || lc.includes('timeout')) {
    return 'timeout';
  }

  // Crash: non-zero exit / SIGKILL / exit code.
  if (lc.includes('non-zero') || lc.includes('exit code') || lc.includes('sigkill')) {
    return 'crash';
  }

  return 'unknown error';
}

/**
 * Derive the Lucille consequence hint for an approval gate.
 *
 * The reject behavior depends on what the workflow YAML declared in the
 * approval node's `on_reject` block, captured server-side in the run's
 * `metadata.approval` object:
 *   - With on_reject + maxAttempts: reject re-drafts up to N times, then
 *     cancels. ("the headshot is /cancel, not Reject" -- Reject loops.)
 *   - With on_reject, no maxAttempts: reject re-drafts until cancelled.
 *   - Without on_reject: reject halts immediately (cancels the run).
 *
 * Approve always resumes the gate, regardless of reject config.
 *
 * The KillButton (separate UI element) is the real headshot -- this hint only
 * STATES the consequence; the action lives on the Kill button.
 */
export function deriveLucilleHint(
  onRejectPrompt: string | undefined,
  onRejectMaxAttempts: number | undefined
): { approve: string; reject: string } {
  const approve = 'Approve -> resumes run';
  let reject: string;
  if (onRejectPrompt !== undefined && onRejectPrompt.length > 0) {
    if (typeof onRejectMaxAttempts === 'number' && onRejectMaxAttempts > 0) {
      reject = `Reject -> re-drafts (up to ${String(onRejectMaxAttempts)}) then cancels`;
    } else {
      reject = 'Reject -> re-drafts then cancels';
    }
  } else {
    reject = 'Reject -> halts immediately';
  }
  return { approve, reject };
}

/**
 * Status discriminator used by the FleetStrip to filter the dashboard runs
 * payload down to LIVE runs (the ones that can co-fire, the ones whose cost
 * burns in real time). Mirrors the server-side LIVE_STATUSES used by
 * listDashboardRuns when no explicit `status` filter is passed.
 */
export function isLiveStatus(status: WorkflowRunStatus | undefined): boolean {
  return status === 'running' || status === 'pending' || status === 'paused';
}

/**
 * Group dashboard runs by their bound codebase (target repo). Returns a Map
 * from codebase_name -> array of runs. Runs whose codebase_name is null are
 * collected under the synthetic key "(no codebase)" so the FleetStrip still
 * shows them, but they cannot trigger a co-fire alarm against a "real" repo.
 *
 * Co-fire detection rule (FleetStrip): any map entry whose array length >= 2
 * AND whose key is not the synthetic "(no codebase)" placeholder is a
 * co-fire. Two unattributed runs are not a co-fire alarm -- the spec anchor
 * (2026-06-02 zombie+keeper) was about two runs hammering the same real repo.
 */
export const NO_CODEBASE_KEY = '(no codebase)';

export function groupRunsByRepo(
  runs: readonly DashboardRunResponse[]
): Map<string, DashboardRunResponse[]> {
  const groups = new Map<string, DashboardRunResponse[]>();
  for (const run of runs) {
    const key = run.codebase_name ?? NO_CODEBASE_KEY;
    const arr = groups.get(key) ?? [];
    arr.push(run);
    groups.set(key, arr);
  }
  return groups;
}

/**
 * Compute the running cost burn rate for the FleetStrip CostBurnMeter.
 *
 * totalCostUsd = sum of `metadata.total_cost_usd` across all live runs
 *   (guarded by typeof check -- metadata is Record<string, unknown> at the
 *    client; WorkflowRunCard.tsx uses the same guard pattern at L229).
 *
 * ratePerMin = totalCostUsd / elapsedMinutes, where elapsedMinutes is computed
 *   from the EARLIEST started_at across all live runs (the "session" extent).
 *   Returns null when no run has a started_at or when elapsed is zero -- never
 *   divide-by-zero, never NaN.
 *
 * The anchor wound: "$4.83 for 21min -- what happened?" with no live cost view.
 * The meter has to be readable WITHOUT recomputing in the user's head.
 */
export function computeCostBurnRate(
  liveRuns: readonly (WorkflowRunResponse | DashboardRunResponse)[],
  now: number = Date.now()
): { totalCostUsd: number; ratePerMin: number | null } {
  let totalCostUsd = 0;
  let earliestStartedAt: number | null = null;

  for (const run of liveRuns) {
    const cost = run.metadata?.total_cost_usd;
    if (typeof cost === 'number' && Number.isFinite(cost)) {
      totalCostUsd += cost;
    }
    if (typeof run.started_at === 'string' && run.started_at.length > 0) {
      const startedAt = new Date(ensureUtc(run.started_at)).getTime();
      if (Number.isFinite(startedAt)) {
        if (earliestStartedAt === null || startedAt < earliestStartedAt) {
          earliestStartedAt = startedAt;
        }
      }
    }
  }

  if (earliestStartedAt === null) {
    return { totalCostUsd, ratePerMin: null };
  }
  const elapsedMs = now - earliestStartedAt;
  if (elapsedMs <= 0) {
    return { totalCostUsd, ratePerMin: null };
  }
  const elapsedMin = elapsedMs / 60_000;
  return { totalCostUsd, ratePerMin: totalCostUsd / elapsedMin };
}
