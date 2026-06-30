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

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

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
    // node_output is the canonical field name confirmed by CLI workflow.ts:814
    // and server test fixtures (data: { node_output: '...' }).
    // Typed explicitly so ev.data.output access is a compile-time error.
    data: { node_output?: string; [key: string]: unknown };
  }[];
}

interface PollOptions {
  runId: string;
  apiBaseUrl: string;
  /** How long to wait before giving up (ms). Default: 3600000 (1 hour). */
  timeoutMs?: number;
  /** Poll interval (ms). Default: 30000 (30 seconds). */
  intervalMs?: number;
}

/**
 * Poll a workflow run until it reaches a terminal state (completed/failed/cancelled).
 *
 * @returns PollResult with terminal status, validator verdict, PR info, and metadata.
 * @throws If the run does not reach terminal state within timeoutMs.
 */
export async function pollForTerminal(opts: PollOptions): Promise<PollResult> {
  const { runId, apiBaseUrl, timeoutMs = 3_600_000, intervalMs = 30_000 } = opts;

  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const detail = await fetchRunDetail(runId, apiBaseUrl);

    if (detail && TERMINAL_STATUSES.has(detail.run.status)) {
      const terminalStatus = detail.run.status as 'completed' | 'failed' | 'cancelled';
      const events = detail.events ?? [];

      const validatorVerdict = extractValidatorVerdict(events);
      const prUrl = extractPrUrl(events);
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

    // Not terminal yet -- wait before next poll
    const remaining = deadline - Date.now();
    const waitMs = Math.min(intervalMs, remaining);
    if (waitMs <= 0) break;
    await new Promise<void>(resolve => setTimeout(resolve, waitMs));
  }

  throw new Error(
    `[smart-cauldron/poll] Run ${runId} did not reach terminal state within ${timeoutMs}ms`
  );
}

async function fetchRunDetail(runId: string, apiBaseUrl: string): Promise<RunApiResponse | null> {
  try {
    const res = await fetch(`${apiBaseUrl}/api/workflows/runs/${encodeURIComponent(runId)}`);
    if (!res.ok) return null;
    return (await res.json()) as RunApiResponse;
  } catch {
    return null;
  }
}

/**
 * Extract war-council-validator verdict from node_completed events.
 *
 * Scans for event_type === "node_completed" AND step_name === "war-council-validator".
 * Checks data.node_output string for "satisfied" or "needs_revision".
 * Field name confirmed: CLI workflow.ts:814 uses event.data.node_output.
 */
function extractValidatorVerdict(
  events: {
    event_type: string;
    step_name: string | null;
    data: { node_output?: string; [key: string]: unknown };
  }[]
): 'satisfied' | 'needs_revision' | 'unknown' {
  for (const ev of events) {
    if (ev.event_type === 'node_completed' && ev.step_name === 'war-council-validator') {
      const output = typeof ev.data.node_output === 'string' ? ev.data.node_output : '';
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
 * Looks for node with step_name === "open-pr-if-needed" (the real node ID in
 * bdc-feature-development.yaml, confirmed by canary doc open-pr-if-needed node_output).
 * Falls back to any step whose name contains "open-pr" to handle custom lanes.
 * Avoids false positives on "approve" or "preflight" (no longer matches on bare "pr").
 * Parses PR_URL=https://... pattern from data.node_output.
 */
function extractPrUrl(
  events: {
    event_type: string;
    step_name: string | null;
    data: { node_output?: string; [key: string]: unknown };
  }[]
): string | null {
  const prUrlPattern = /PR_URL=(https?:\/\/\S+)/i;

  for (const ev of events) {
    if (ev.event_type !== 'node_completed') continue;
    const stepName = ev.step_name ?? '';
    // Exact match on the real step ID; fallback on steps that contain "open-pr"
    // (not bare "pr" to avoid matching "approve", "preflight", etc.).
    if (stepName !== 'open-pr-if-needed' && !stepName.toLowerCase().includes('open-pr')) continue;

    const output = typeof ev.data.node_output === 'string' ? ev.data.node_output : '';
    const match = prUrlPattern.exec(output);
    if (match?.[1]) return match[1];

    // Also check for raw GitHub PR URL in output
    const rawMatch = /(https:\/\/github\.com\/[^\s]+\/pull\/\d+)/.exec(output);
    if (rawMatch?.[1]) return rawMatch[1];
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
