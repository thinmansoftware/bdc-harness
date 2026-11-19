/**
 * WO-HARNESS-MERGE-GATES-01, Test 10 (classification half): a refusal because the PR is a draft, or
 * because a hold applies, is never a FINAL outcome. Before this change GitHub's 405 "Pull Request is still
 * a draft" was classified terminal and finalized the verdict, so marking the PR ready later did nothing
 * (bdc-xo #6036; 11 verdicts finalized that way between 2026-11-12 and 2026-11-13).
 */
import { describe, expect, test } from 'bun:test';
import { classifyMergeSkip } from './merge-skip-classification.ts';
import { MERGE_HOLD_REASONS } from './merge-holds.ts';

describe('merge skip classification: draft and hold refusals are transient', () => {
  const draft405 =
    'Pull Request is still a draft - https://docs.github.com/rest/pulls/pulls#merge-a-pull-request';

  test('the exact GitHub 405 text and its merge_failed wrapper are transient', () => {
    expect(classifyMergeSkip(draft405)).toBe('transient');
    expect(classifyMergeSkip(`merge_failed:${draft405}`)).toBe('transient');
    expect(classifyMergeSkip('merge_failed:Pull Request is still a draft')).toBe('transient');
  });

  test('every hold reason is transient', () => {
    for (const reason of MERGE_HOLD_REASONS) {
      expect(classifyMergeSkip(reason)).toBe('transient');
    }
  });

  test('final outcomes stay final', () => {
    expect(classifyMergeSkip('merge_executed')).toBe('terminal');
    expect(classifyMergeSkip('github_merge_transport_ambiguous')).toBe('terminal');
    expect(classifyMergeSkip('transient_exhausted:pr_is_draft')).toBe('terminal');
    expect(classifyMergeSkip('github_merge_rejected_422')).toBe('terminal');
  });
});
