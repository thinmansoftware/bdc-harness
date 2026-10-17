export type MergeSkipClassification = 'transient' | 'terminal';

const TRANSIENT_EXACT_REASONS = new Set([
  'mergeable_state_not_clean',
  'required_checks_not_success',
  'pr_lookup_failed',
  'open_pr_not_found',
  'changed_files_unresolved',
  'pr_context_fetch_failed',
]);

const TRANSIENT_MESSAGE_PATTERN =
  /rate limit|not mergeable|already in progress|base branch was modified|timed? ?out|ETIMEDOUT|ECONNRESET|50[234]/i;

export function classifyMergeSkip(reason: string): MergeSkipClassification {
  if (reason.startsWith('transient_exhausted:')) return 'terminal';
  if (reason.startsWith('merge_executed')) return 'terminal';
  if (reason === 'github_merge_transport_ambiguous') return 'terminal';
  if (TRANSIENT_EXACT_REASONS.has(reason)) return 'transient';
  if (reason.startsWith('merge_failed:')) {
    return TRANSIENT_MESSAGE_PATTERN.test(reason.slice('merge_failed:'.length))
      ? 'transient'
      : 'terminal';
  }
  return TRANSIENT_MESSAGE_PATTERN.test(reason) ? 'transient' : 'terminal';
}

export function isRateLimitSkip(reason: string): boolean {
  return /rate limit/i.test(reason);
}
