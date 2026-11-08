/**
 * gate-misfire.ts -- classify harness-side gate failures that must not climb.
 *
 * A misfire is a gate-node failure whose text is a harness defect (dropped
 * grep, missing repair-target record, dead auth, held checkout). Implement
 * and plan-quality failures return null so the cascade climbs as before.
 *
 * repair_gate_closed matches only checkout_failed and plan_review_skipped.
 * plan_review_not_approved is a quality rejection and must climb.
 */

import type { PollResult } from './types.js';

export type GateMisfireKind =
  | 'repair_target_unavailable'
  | 'repair_gate_closed'
  | 'plan_review_record_demand'
  | 'evidence_harness_refused'
  | 'evidence_spec_defect'
  | 'manifest_gate_scope_mismatch'
  | 'docs_only_no_checks'
  | 'auth_dead';

export interface GateMisfire {
  kind: GateMisfireKind;
  gateNode: string;
  failedNodes: string[];
  reason: string;
}

const GATE_SET: ReadonlySet<string> = new Set([
  'checkout-repair-target',
  'repair-gate',
  'repair-gate-fail',
  'plan-review',
  'build-manifest',
  'stamp-manifest-evidence',
  'manifest-evidence-check',
  'verify-manifest-assertions',
  'manifest-consistency-check',
  'run-stop-greps',
]);

const IMPLEMENT_SIDE_MARKERS: readonly string[] = [
  'implement',
  'diff-repair',
  'opus-repair',
  'commit-and-push',
  'assert-implement-produced-work',
];

const REPAIR_TARGET_UNAVAILABLE =
  /repair_target_branch_held|invalid repair_target_branch|declared repair target #\d+ (not found|is (MERGED|CLOSED))|repair_target_rejected:fork|repair_target_upstream_mismatch/;

const REPAIR_GATE_CLOSED = /repair_gate_closed: (checkout_failed|plan_review_skipped)/;

const PLAN_REVIEW_RECORD_DEMAND: readonly RegExp[] = [
  /lane-verified (repair-target )?record/i,
  /repair-target record/i,
  /REPAIR_TARGET ?\/? ?REPAIR_TARGET_BRANCH record/i,
  /provide (its|the) matching head branch/i,
  /supply .*repair-target/i,
];

const AUTH_DEAD = /Cauldron auth for \w+ is dead|refresh_expired|no_refresh_token/;

function readError(raw: Record<string, unknown>): string | null {
  const error = raw.error;
  return typeof error === 'string' ? error : null;
}

/**
 * Absent metadata, a non-array, and an empty array are "no failed_nodes".
 * An array that contains a non-string is invalid and the caller must return null.
 */
function readFailedNodes(raw: Record<string, unknown>): {
  nodes: string[] | null;
  invalid: boolean;
} {
  const value = raw.failed_nodes;
  if (!Array.isArray(value) || value.length === 0) {
    return { nodes: null, invalid: false };
  }
  const nodes: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      return { nodes: null, invalid: true };
    }
    nodes.push(entry);
  }
  return { nodes, invalid: false };
}

function mentionsImplementSide(error: string): boolean {
  return IMPLEMENT_SIDE_MARKERS.some(marker => error.includes(marker));
}

function matchKind(error: string, failedNodes: string[] | null): GateMisfireKind | null {
  if (REPAIR_TARGET_UNAVAILABLE.test(error)) return 'repair_target_unavailable';
  if (REPAIR_GATE_CLOSED.test(error)) return 'repair_gate_closed';
  if (
    failedNodes?.includes('plan-review') &&
    PLAN_REVIEW_RECORD_DEMAND.some(pattern => pattern.test(error))
  ) {
    return 'plan_review_record_demand';
  }
  if (error.includes('HARNESS_REFUSED:')) return 'evidence_harness_refused';
  if (error.includes('SPEC_DEFECT:')) return 'evidence_spec_defect';
  if (error.includes('gate_scope_mismatch')) return 'manifest_gate_scope_mismatch';
  if (error.includes('no_checks_reported')) return 'docs_only_no_checks';
  if (AUTH_DEAD.test(error)) return 'auth_dead';
  return null;
}

/**
 * Classify a terminal poll as a harness gate misfire.
 *
 * Returns null unless every failed node is in the gate set (or failed_nodes is
 * absent and the text does not name an implement-side node) AND the error text
 * matches one harness-misfire kind. First matching pattern wins.
 */
export function classifyGateMisfire(poll: PollResult): GateMisfire | null {
  const raw = poll.rawMetadata;
  const failed = readFailedNodes(raw);
  if (failed.invalid) return null;

  const error = readError(raw);
  if (error === null) return null;

  if (failed.nodes) {
    if (failed.nodes.some(node => !GATE_SET.has(node))) return null;
  } else if (mentionsImplementSide(error)) {
    return null;
  }

  const kind = matchKind(error, failed.nodes);
  if (!kind) return null;

  return {
    kind,
    gateNode: failed.nodes?.[0] ?? 'unknown',
    failedNodes: failed.nodes ?? [],
    reason: error,
  };
}
