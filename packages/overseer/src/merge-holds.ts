/**
 * WO-HARNESS-MERGE-GATES-01: the ONE rule that says whether a pull request must not be merged by the
 * Overseer's merge paths.
 *
 * Before this module, merge-hold was enforced only by the merge coordinator (merge-execution-bridge.ts)
 * while the merge manager handler (merge-manager.ts) checked owner:reworking alone, so a run-backed PR
 * carrying merge-hold was merged by the manager (shopops-storefront PR 239, 2026-11-13). Both paths and
 * the single function that calls GitHub's merge API now call mergeHoldReason.
 *
 * Pure: no I/O. The three hold labels are matched case-insensitively after trimming, because GitHub label
 * names are case-insensitive and a spelling difference must never release a hold.
 */
import { OWNER_REWORKING_LABEL, RUN_BLOCKED_LABEL } from './merge-candidate-discovery';

export const MERGE_HOLD_LABEL = 'merge-hold' as const;

export type MergeHoldReason =
  | 'merge_hold_label'
  | 'run_blocked_label'
  | 'owner_reworking_label'
  | 'pr_is_draft'
  | 'fallback_pr_title'
  | 'pr_labels_unknown'
  | 'pr_draft_unknown'
  /** Amendment 1: the Overseer's latest approval at the head was given while the PR was a draft. */
  | 'approval_given_while_draft'
  /** Amendment 1: the draft/ready events or the reviews could not be read completely (fail closed). */
  | 'pr_approval_state_unknown';

export interface MergeHoldInput {
  /** GitHub label names. Undefined means "not loaded", which is not the same as "no labels". */
  readonly labels?: readonly string[] | null;
  /** True when the PR is a draft. Undefined means "not loaded". */
  readonly draft?: boolean | null;
  readonly title?: string | null;
}

export interface MergeHoldOptions {
  /**
   * When true (the choke point that calls GitHub's merge API), a response that lacks the labels or the
   * draft field is refused (pr_labels_unknown, pr_draft_unknown) instead of being assumed clean.
   */
  readonly failClosed?: boolean;
}

/** Every reason mergeHoldReason can return. A refusal for one of these is a HOLD, never a final outcome. */
export const MERGE_HOLD_REASONS: ReadonlySet<string> = new Set<MergeHoldReason>([
  'merge_hold_label',
  'run_blocked_label',
  'owner_reworking_label',
  'pr_is_draft',
  'fallback_pr_title',
  'pr_labels_unknown',
  'pr_draft_unknown',
  'approval_given_while_draft',
  'pr_approval_state_unknown',
]);

const FALLBACK_TITLE = /^\s*FALLBACK:/i;

function normalize(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Returns null when nothing holds the PR, else the first reason in this order: merge_hold_label,
 * run_blocked_label, owner_reworking_label, pr_is_draft, fallback_pr_title; then, only under failClosed,
 * pr_labels_unknown and pr_draft_unknown. The result never depends on label order.
 */
export function mergeHoldReason(
  input: MergeHoldInput,
  options: MergeHoldOptions = {}
): MergeHoldReason | null {
  const labels = input.labels ?? undefined;
  const names = new Set((labels ?? []).map(normalize));
  if (names.has(MERGE_HOLD_LABEL)) return 'merge_hold_label';
  if (names.has(normalize(RUN_BLOCKED_LABEL))) return 'run_blocked_label';
  if (names.has(normalize(OWNER_REWORKING_LABEL))) return 'owner_reworking_label';
  if (input.draft === true) return 'pr_is_draft';
  if (typeof input.title === 'string' && FALLBACK_TITLE.test(input.title)) {
    return 'fallback_pr_title';
  }
  if (options.failClosed) {
    if (labels === undefined) return 'pr_labels_unknown';
    if (input.draft === undefined || input.draft === null) return 'pr_draft_unknown';
  }
  return null;
}
