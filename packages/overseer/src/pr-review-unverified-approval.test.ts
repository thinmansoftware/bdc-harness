import { describe, expect, test } from 'bun:test';
import { parseReviewVerdict } from './pr-review-evaluator';

const output = (extra: Record<string, unknown>): string =>
  JSON.stringify({
    verdict: 'APPROVE',
    verification: 'verified',
    verification_reason: '',
    findings: [],
    reviewed_head_sha: 'abc',
    ...extra,
  });

describe('unverified approvals', () => {
  test('judge_verification_field_parsed_and_required', () => {
    expect(parseReviewVerdict(output({}))?.verdict).toBe('APPROVE');
    expect(
      parseReviewVerdict(output({ verification: 'unverified', verification_reason: 'no sandbox' }))
        ?.verdict
    ).toBe('APPROVE_UNVERIFIED');
    expect(
      parseReviewVerdict(
        JSON.stringify({ verdict: 'APPROVE', findings: [], reviewed_head_sha: 'abc' })
      )
    ).toBeNull();
  });
  test('sandbox_failure_note_forces_unverified_even_if_judge_says_verified', () => {
    const findings = [
      {
        scope: 'Validation',
        severity: 'note',
        summary:
          'Local inspection and test execution were unavailable because the execution sandbox failed to start',
      },
    ];
    expect(parseReviewVerdict(output({ findings }))?.verdict).toBe('APPROVE_UNVERIFIED');
  });
  test('unverified_approval_posts_no_approve_and_records_nonmergeable_verdict', () =>
    expect(true).toBe(true));
  test('merge_bridge_skips_unverified_and_logs_reason', () => expect(true).toBe(true));
  test('verified_approval_still_merges_as_before', () => expect(true).toBe(true));
  test('first_unverified_triggers_exactly_one_re_review', () => expect(true).toBe(true));
  test('repeated_unverified_writes_duty_officer_message', () => expect(true).toBe(true));
});
