/**
 * Escalation packet builder (WO-HARNESS-ESCALATED-RUN-STATUS-01).
 *
 * Builds a best-effort context packet from a rejected predecessor run so a
 * higher-tier successor can avoid the same defects. Extracted from run events
 * (validator rejection text / findings, plan text, optionally rejected diff).
 *
 * Packet is best-effort: missing artifacts are noted, available ones injected.
 * Diff is truncated first when the packet would exceed the size cap.
 */

/** Marker that must appear in injected planning input (testable). */
export const ESCALATION_FINDINGS_MARKER =
  'A prior lower-tier attempt was rejected for the following reasons; avoid these specific defects.';

/** Default size cap for the full packet body (characters). */
export const DEFAULT_PACKET_SIZE_CAP = 12_000;

/** How much of a rejected diff to keep by default when room is available. */
export const DEFAULT_DIFF_CAP = 4_000;

export interface PacketEvent {
  event_type: string;
  step_name: string | null;
  data: Record<string, unknown> | string | null;
}

export interface BuildEscalationPacketOptions {
  events: PacketEvent[];
  /** Cap total packet length (chars). Default DEFAULT_PACKET_SIZE_CAP. */
  sizeCap?: number;
  /** Cap the rejected-diff section when included (chars). Default DEFAULT_DIFF_CAP. */
  diffCap?: number;
  /** Prior run id for diagnostics in the packet header. */
  priorRunId?: string;
}

export interface EscalationPacketResult {
  /** Full packet text ready to prepend to successor user_message, or empty if nothing useful. */
  packet: string;
  /** Which artifacts were present. */
  included: {
    findings: boolean;
    plan: boolean;
    diff: boolean;
  };
  /** Which expected artifacts were absent. */
  missing: string[];
  /** True when the rejected-diff section was truncated for size. */
  diffTruncated: boolean;
}

/**
 * Normalize event data to a plain object and a search text blob.
 * Event output lives under data.output, data.node_output, or is the whole data string.
 */
function eventText(ev: PacketEvent): string {
  const data = ev.data;
  if (data == null) return '';
  if (typeof data === 'string') {
    try {
      const parsed = JSON.parse(data) as Record<string, unknown>;
      return extractOutputFields(parsed);
    } catch {
      return data;
    }
  }
  if (typeof data === 'object') {
    return extractOutputFields(data as Record<string, unknown>);
  }
  return '';
}

function extractOutputFields(data: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of ['output', 'node_output', 'error', 'message', 'text'] as const) {
    const v = data[key];
    if (typeof v === 'string' && v.length > 0) parts.push(v);
  }
  if (parts.length === 0) {
    try {
      return JSON.stringify(data);
    } catch {
      return '';
    }
  }
  return parts.join('\n');
}

/**
 * Extract reviewer findings + validator verdict text from rejected-run events.
 * Mandatory section of the escalation packet.
 *
 * Detection rule (same family as hasValidatorRejectionSignal):
 *   - fallback flip declined text, OR needs_revision / REAL_FAILURE / ratings failure
 *   - plus any war-council-validator / review / validator-class node output that
 *     contains rejection language.
 */
export function extractRejectionFindings(events: PacketEvent[]): string | null {
  const chunks: string[] = [];

  for (const ev of events) {
    const text = eventText(ev);
    if (!text) continue;
    const step = (ev.step_name ?? '').toLowerCase();
    const isGateway =
      step.includes('flip-notion') ||
      step.includes('validator') ||
      step.includes('review') ||
      step.includes('business-risk') ||
      step.includes('classify');

    const hasRejection =
      /FALLBACK_FLIP_DECLINED/i.test(text) ||
      /\bneeds[_-]?revision\b/i.test(text) ||
      /validator verdict not satisfied/i.test(text) ||
      /REAL_FAILURE/i.test(text) ||
      /CRITICAL ious31|MEDIUM and HIGH|rating[s]?\s*:\s*(CRITICAL|HIGH)/i.test(text);

    if (isGateway && hasRejection) {
      chunks.push(trimSection(text, 3_000));
    } else if (/FALLBACK_FLIP_DECLINED/i.test(text) || /\bneeds[_-]?revision\b/i.test(text)) {
      // Catch rejection signals even on unexpected step names.
      chunks.push(trimSection(text, 3_000));
    }
  }

  if (chunks.length === 0) return null;
  // Keep unique, prefer longer material
  const uniq = Array.from(new Set(chunks));
  return uniq.join('\n---\n');
}

/**
 * Extract plan text from plan / plan-review node outputs if present.
 */
export function extractPlanText(events: PacketEvent[]): string | null {
  let approvedPlan: string | null = null;
  let plainPlan: string | null = null;

  for (const ev of events) {
    if (ev.event_type !== 'node_completed' && ev.event_type !== 'step_completed') continue;
    const step = (ev.step_name ?? '').toLowerCase();
    const text = eventText(ev);
    if (!text || text.length < 40) continue;

    if (step === 'plan-review' || step.includes('plan-review')) {
      // Prefer the APPROVED_PLAN fence when present
      const fenced = text.match(
        /===+\s*APPROVED_PLAN_BEGIN\s*===+([\s\S]*?)===+\s*APPROVED_PLAN_END\s*===+/i
      );
      if (fenced?.[1]) {
        approvedPlan = trimSection(fenced[1].trim(), 4_000);
      } else if (!approvedPlan) {
        approvedPlan = trimSection(text, 4_000);
      }
    } else if (step === 'plan' || step.endsWith(':plan') || step.includes('plan-fix')) {
      if (!plainPlan) plainPlan = trimSection(text, 4_000);
    }
  }

  return approvedPlan ?? plainPlan;
}

/**
 * Extract a rejected diff-ish artifact from implement / checkpoint events if present.
 * This is labeled REJECTED and must never be treated as starting point.
 */
export function extractRejectedDiff(events: PacketEvent[]): string | null {
  // Prefer implement/checkpoint outputs that look like a diff
  let best: string | null = null;
  for (const ev of events) {
    const step = (ev.step_name ?? '').toLowerCase();
    if (
      !(
        step.includes('implement') ||
        step.includes('checkpoint') ||
        step.includes('commit-and-push') ||
        step.includes('diff')
      )
    ) {
      continue;
    }
    const text = eventText(ev);
    if (!text) continue;
    // Favor content that looks like a unified diff or a file-change list
    if (
      /^diff --git /m.test(text) ||
      /^\+\+\+ |^--- /m.test(text) ||
      /Files modified:|Files created:|git diff/i.test(text)
    ) {
      if (!best || text.length > best.length) best = text;
    }
  }
  return best;
}

function trimSection(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n...[truncated ${String(s.length - max)} chars]`;
}

/**
 * Build the escalation packet for a successor run.
 * Returns empty packet when no rejection findings exist (caller should skip inject).
 */
export function buildEscalationPacket(opts: BuildEscalationPacketOptions): EscalationPacketResult {
  const sizeCap = opts.sizeCap ?? DEFAULT_PACKET_SIZE_CAP;
  const diffCap = opts.diffCap ?? DEFAULT_DIFF_CAP;

  const findings = extractRejectionFindings(opts.events);
  const plan = extractPlanText(opts.events);
  let diff = extractRejectedDiff(opts.events);
  let diffTruncated = false;

  const missing: string[] = [];
  if (!findings) missing.push('findings');
  if (!plan) missing.push('plan');
  if (!diff) missing.push('diff');

  // Findings are mandatory -- without them, packet is not useful for mesh
  if (!findings) {
    return {
      packet: '',
      included: { findings: false, plan: Boolean(plan), diff: Boolean(diff) },
      missing,
      diffTruncated: false,
    };
  }

  // Assemble with size budgeting: findings + plan first, then diff if room
  const headerLines = [
    '=== ESCALATION PACKET (from prior lower-tier attempt) ===',
    opts.priorRunId ? `prior_run_id=${opts.priorRunId}` : null,
    missing.length > 0 ? `missing_artifacts=${missing.join(',')}` : 'missing_artifacts=(none)',
    '',
    ESCALATION_FINDINGS_MARKER,
    '',
  ].filter((x): x is string => x != null);

  const findingsBlock = ['## REVIEWER FINDINGS + VALIDATOR VERDICT', findings, ''].join('\n');

  const planBlock = plan
    ? [
        '## PRIOR APPROVED PLAN (reference only)',
        'Use as context for intent; do not assume it is still correct after rejection.',
        plan,
        '',
      ].join('\n')
    : '';

  let body = headerLines.join('\n') + findingsBlock + planBlock;

  if (diff) {
    const remaining = sizeCap - body.length - 200; // leave footer room
    if (remaining > 200) {
      const effectiveDiffCap = Math.min(diffCap, remaining);
      if (diff.length > effectiveDiffCap) {
        diff = diff.slice(0, effectiveDiffCap) + `\n...[diff truncated ${String(diff.length - effectiveDiffCap)} chars]`;
        diffTruncated = true;
      }
      body +=
        [
          '## REJECTED DIFF (reference ONLY)',
          'do not use as a starting point; useful for file locations only. Successor must build from the spec, not repair the rejected diff.',
          '```',
          diff,
          '```',
          '',
        ].join('\n') + '\n';
    } else {
      // Prefer keeping findings/verdict; drop the diff entirely when oversize
      diffTruncated = true;
      body +=
        '## REJECTED DIFF\n(omitted: packet size cap would truncate findings otherwise)\n\n';
      diff = null;
    }
  }

  body += '=== END ESCALATION PACKET ===\n';

  // Final hard truncate only as a last resort -- drop from the end (diff first was
  // already handled above). Never trim findings ahead of other sections here.
  if (body.length > sizeCap) {
    body = body.slice(0, sizeCap) + '\n...[packet hard-truncated]\n';
    diffTruncated = true;
  }

  return {
    packet: body,
    included: { findings: true, plan: Boolean(plan), diff: Boolean(diff) },
    missing,
    diffTruncated,
  };
}

/**
 * Prepend an escalation packet to a successor user_message.
 * Returns original message unchanged if packet is empty.
 */
export function prependEscalationPacket(userMessage: string, packet: string): string {
  if (!packet) return userMessage;
  return `${packet}\n\n${userMessage}`;
}
