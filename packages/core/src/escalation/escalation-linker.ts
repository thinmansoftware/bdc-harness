/**
 * Escalation linker (WO-HARNESS-ESCALATED-RUN-STATUS-01).
 *
 * Mechanism A: at dispatch time, when a NEW run starts for a WO_ID that matches
 * an existing run with status='failed' AND that prior run's events contain a
 * validator-rejection signal, update the prior run's status to 'escalated' and
 * (optionally) produce a packet of prior rejection context for the successor.
 *
 * Rejection-signal detection rule (document in manifest):
 *   A prior run is considered a gate-rejection escalation candidate IFF its
 *   stored workflow events text (any event_type/step) matches any of:
 *     1. "FALLBACK_FLIP_DECLINED"  -- honest flip-notion-on-failure leave-open
 *     2. needs_revision / needs-revision (validator/classifier verdict class)
 *     3. "validator verdict not satisfied"
 *     4. "REAL_FAILURE" or "busines(s)?_risk_gate: FAILED" / BUSINESS_RISK_GATE
 *        with FAILED, when present as gate output
 *   Real breakages without these signals stay 'failed' even if a successor fires.
 *
 * Requires BOTH: rejection signal AND a same-WO_ID successor dispatch.
 */

import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import {
  buildEscalationPacket,
  prependEscalationPacket,
  type PacketEvent,
} from './escalation-packet-builder';

/** Minimal logger facade -- avoids coupling pure linker logic to @archon/paths
 *  so unit tests stay free of workspace runtime resolution. */
function getLog(): {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
} {
  return {
    info: (obj, msg) => {
      // Structured console for operators / host metrics; no pino required here.
      if (typeof console !== 'undefined' && typeof console.info === 'function') {
        console.info(`[escalation.linker] ${msg}`, obj);
      }
    },
    warn: (obj, msg) => {
      if (typeof console !== 'undefined' && typeof console.warn === 'function') {
        console.warn(`[escalation.linker] ${msg}`, obj);
      }
    },
  };
}

/** WO_ID pattern: WO- followed by uppercase alnum / hyphens ending in digits. */
const WO_ID_RE = /\bWO-[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d+\b/;

/**
 * Extract a Work Order ID from a user_message / dispatch payload.
 * Looks for WO_ID=<id> first, then any WO-... token.
 */
export function extractWoId(userMessage: string | null | undefined): string | null {
  if (!userMessage) return null;
  const assigned = /(?:^|\n)\s*WO_ID\s*=\s*(WO-[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d+)/m.exec(
    userMessage
  );
  if (assigned?.[1]) return assigned[1];
  const bare = WO_ID_RE.exec(userMessage);
  return bare ? bare[0] : null;
}

/**
 * Returns true if the event corpus signals a validator / gate rejection
 * (as opposed to a genuine breakage with no gate verdict).
 *
 * REJECTION_SIGNAL_RULE (documented for manifest):
 * Match ANY of these substrings/regexes case-insensitively against the
 * concatenated event text (step_name + stringified data/output):
 *   - FALLBACK_FLIP_DECLINED
 *   - needs_revision | needs-revision | needs revision
 *   - validator verdict not satisfied
 *   - REAL_FAILURE
 *   - BUSINESS_RISK_GATE:\s*FAILED | BUSINESS_RISK_GATE: FAILED
 *
 * A genuine breakage without these phrases returns false -- prior stays 'failed'.
 */
export function hasValidatorRejectionSignal(
  events: { event_type?: string; step_name?: string | null; data?: unknown; error?: string }[]
): boolean {
  if (!events || events.length === 0) return false;

  for (const ev of events) {
    const blobs: string[] = [];
    if (ev.step_name) blobs.push(ev.step_name);
    if (typeof ev.error === 'string') blobs.push(ev.error);
    if (typeof ev.data === 'string') {
      blobs.push(ev.data);
    } else if (ev.data && typeof ev.data === 'object') {
      const d = ev.data as Record<string, unknown>;
      for (const key of ['output', 'node_output', 'error', 'message', 'text']) {
        if (typeof d[key] === 'string') blobs.push(d[key] as string);
      }
      // Fallback stringification for other shapes
      try {
        blobs.push(JSON.stringify(d));
      } catch {
        // ignore
      }
    }
    const text = blobs.join('\n');
    if (!text) continue;

    if (/FALLBACK_FLIP_DECLINED/i.test(text)) return true;
    if (/\bneeds[_ -]?revision\b/i.test(text)) return true;
    if (/validator verdict not satisfied/i.test(text)) return true;
    if (/\bREAL_FAILURE\b/i.test(text)) return true;
    if (/BUSINESS_RISK_GATE\s*:\s*FAILED/i.test(text)) return true;
  }
  return false;
}

/** Minimal DB surface the linker needs (narrow for tests). */
export interface EscalationLinkerStore {
  listWorkflowRuns(options: {
    status?: string | string[];
    limit?: number;
    includeArchived?: boolean;
  }): Promise<WorkflowRun[]>;
  listWorkflowEvents(runId: string): Promise<
    {
      event_type: string;
      step_name: string | null;
      data: Record<string, unknown> | string | null;
    }[]
  >;
  updateWorkflowRun(
    id: string,
    updates: { status?: string; metadata?: Record<string, unknown> }
  ): Promise<void>;
}

export interface LinkEscalationResult {
  /** Prior runs that were flipped failed -> escalated. */
  escalatedRunIds: string[];
  /** Escalation packet text to inject into the CURRENT run's message (may be empty). */
  packet: string;
  /** WO_ID extracted from the new user message, if any. */
  woId: string | null;
}

/**
 * Lookup prior same-WO_ID failed runs; escalate those with a rejection signal.
 * Build a packet from the most recent escalated predecessor for the successor.
 *
 * @param newUserMessage  The dispatch message of the NEW run (must contain WO_ID)
 * @param store           DB access
 * @param options.excludeRunId  Optional id of the new pre-created row to ignore
 */
export async function linkEscalatedPredecessor(
  newUserMessage: string,
  store: EscalationLinkerStore,
  options?: { excludeRunId?: string; now?: Date }
): Promise<LinkEscalationResult> {
  const woId = extractWoId(newUserMessage);
  if (!woId) {
    return { escalatedRunIds: [], packet: '', woId: null };
  }

  // Pull recent failed runs (include archived -- still enroll for history clarity)
  let failedRuns: WorkflowRun[] = [];
  try {
    failedRuns = await store.listWorkflowRuns({
      status: 'failed',
      limit: 200,
      includeArchived: true,
    });
  } catch (err) {
    getLog().warn({ err: err as Error, woId }, 'escalation.list_failed_runs_error');
    return { escalatedRunIds: [], packet: '', woId };
  }

  // Filter to same WO_ID, different run, and prior (started earlier if we can tell).
  // We keep the most recent matching failed prior as packet source.
  const candidates = failedRuns
    .filter(r => r.id !== options?.excludeRunId)
    .filter(r => extractWoId(r.user_message) === woId)
    .slice()
    // started_at may be Date or ISO string depending on dialect/normalize
    .sort((a, b) => {
      const ta = toMs(a.started_at);
      const tb = toMs(b.started_at);
      return tb - ta; // newest first
    });

  if (candidates.length === 0) {
    return { escalatedRunIds: [], packet: '', woId };
  }

  const escalatedRunIds: string[] = [];
  let packetSource: { run: WorkflowRun; events: PacketEvent[] } | null = null;

  for (const prior of candidates) {
    let events: PacketEvent[] = [];
    try {
      events = (await store.listWorkflowEvents(prior.id)) as PacketEvent[];
    } catch (err) {
      getLog().warn(
        { err: err as Error, priorRunId: prior.id },
        'escalation.list_events_error'
      );
      continue;
    }

    if (!hasValidatorRejectionSignal(events)) {
      // Real breakage -- leave as failed. Do not inject a packet either.
      continue;
    }

    // Flip status to escalated (idempotent if re-entered)
    try {
      await store.updateWorkflowRun(prior.id, {
        status: 'escalated',
        metadata: {
          escalated_at: (options?.now ?? new Date()).toISOString(),
          escalated_reason: 'gate_rejection_with_successor',
          escalated_wo_id: woId,
          escalated_by: 'escalation-linker',
        },
      });
      escalatedRunIds.push(prior.id);
      getLog().info(
        { priorRunId: prior.id, woId },
        'escalation.prior_run_marked_escalated'
      );
    } catch (err) {
      getLog().warn(
        { err: err as Error, priorRunId: prior.id },
        'escalation.mark_escalated_failed'
      );
      // still try to build packet
    }

    if (!packetSource) {
      packetSource = { run: prior, events };
    }
  }

  let packet = '';
  if (packetSource) {
    const built = buildEscalationPacket({
      events: packetSource.events,
      priorRunId: packetSource.run.id,
    });
    packet = built.packet;
    getLog().info(
      {
        priorRunId: packetSource.run.id,
        woId,
        included: built.included,
        missing: built.missing,
        diffTruncated: built.diffTruncated,
        packetChars: packet.length,
      },
      'escalation.packet_built'
    );
  }

  return { escalatedRunIds, packet, woId };
}

/**
 * Apply linker + packet to a fresh dispatch user message.
 * Returns possibly-augmented message and the linker result.
 */
export async function prepareDispatchWithEscalation(
  userMessage: string,
  store: EscalationLinkerStore,
  options?: { excludeRunId?: string }
): Promise<{ userMessage: string; link: LinkEscalationResult }> {
  const link = await linkEscalatedPredecessor(userMessage, store, options);
  return {
    userMessage: prependEscalationPacket(userMessage, link.packet),
    link,
  };
}

function toMs(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string' || typeof v === 'number') {
    const n = new Date(v).getTime();
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}
