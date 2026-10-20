import { describe, expect, test } from 'bun:test';
import { classifyMergeSkip, isRateLimitSkip } from '../merge-skip-classification';

describe('merge skip classification', () => {
  test('classifyMergeSkip maps every known reason', () => {
    const transient = [
      'mergeable_state_not_clean',
      'required_checks_not_success',
      'pr_lookup_failed',
      'open_pr_not_found',
      'changed_files_unresolved',
      'pr_context_fetch_failed',
      'review_gate_reviews_unavailable',
      'review_gate_reviews_lookup_failed',
      'review_gate_approval_missing_for_head',
      'merge_failed:Pull Request is not mergeable',
      'merge_failed:Merge already in progress',
      'merge_failed:API rate limit exceeded',
      'merge_failed:base branch was modified',
      'merge_failed:timed out',
      'merge_failed:ETIMEDOUT',
      'merge_failed:ECONNRESET',
      'merge_failed:503',
      'Pull Request is not mergeable',
    ];
    const terminal = [
      'spec_only',
      'pr_not_open',
      'head_moved',
      'verdict_stale_head',
      'not_mergeable_dirty',
      'base_not_allowlisted',
      'integration_base_mismatch',
      'repo_not_allowed',
      'run_context_unresolvable',
      'pr_context_unresolvable',
      'service_disabled',
      'emergency_stop',
      'legacy_dry_run',
      'merge_actions_disabled',
      'ce_scope_recheck_failed',
      'github_merge_transport_ambiguous',
      'merge_executed',
      'merge_executed_outcome_unpersisted:error',
      'merge_failed',
      'merge_failed:Head branch was modified',
      'transient_exhausted:mergeable_state_not_clean',
      'transient_exhausted:review_gate_approval_missing_for_head',
      'execution_evidence_unavailable',
    ];
    for (const reason of transient) expect(classifyMergeSkip(reason), reason).toBe('transient');
    for (const reason of terminal) expect(classifyMergeSkip(reason), reason).toBe('terminal');
    expect(isRateLimitSkip('merge_failed:API rate limit exceeded')).toBe(true);
    expect(isRateLimitSkip('merge_failed:timed out')).toBe(false);
  });
});
