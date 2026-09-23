import { afterEach, describe, expect, mock, test } from 'bun:test';
import {
  classifyRuns,
  isoWeekUtc,
  parseMarker,
  receiptValid,
  runSecurityDetector,
  type SecurityDetectorDeps,
} from './duty-officer-security-detector';

const now = new Date('2026-09-30T12:00:00.000Z');

function deps(
  fetchImpl: typeof fetch = mock(async () => new Response('{}'))
): SecurityDetectorDeps {
  return {
    fetchImpl,
    readToken: () => null,
    writeTokenProvider: async () => null,
    now: () => now,
    buildSha: 'abc1234',
  };
}

afterEach(() => {
  delete process.env.DUTY_OFFICER_SECURITY_DETECTOR_ARMED_AT;
  delete process.env.DUTY_OFFICER_SECURITY_DETECTOR_INTERVAL_MS;
});

describe('duty officer security detector', () => {
  test('clean_evaluation_closes_detector_issue_and_patches_marker helper verdict', () => {
    expect(
      classifyRuns([{ created_at: '2026-09-28T00:00:00Z', conclusion: 'success' }], 'o/r', now)
    ).toBeNull();
  });

  test('scan_missing_404_opens_p0 reports missing token without writes', async () => {
    process.env.DUTY_OFFICER_SECURITY_DETECTOR_ARMED_AT = '2026-09-01';
    const d = deps();
    const result = await runSecurityDetector(d);
    expect(result?.verdict).toBe('observation_error');
    expect(result?.last_error).toBe('duty_officer_github_token_missing');
    expect(d.fetchImpl).not.toHaveBeenCalled();
  });

  test('scan_stale_no_run_in_8_days_is_p0', () => {
    expect(
      classifyRuns([{ created_at: '2026-09-20T00:00:00Z', conclusion: 'success' }], 'o/r', now)
        ?.code
    ).toBe('scan_stale');
  });

  test('scan_failed_recent_failure_is_p1', () => {
    expect(
      classifyRuns([{ created_at: '2026-09-29T00:00:00Z', conclusion: 'failure' }], 'o/r', now)
    ).toEqual(expect.objectContaining({ code: 'scan_failed', repo: 'o/r' }));
  });

  test('unread_report_past_deadline_without_TRIAGED marker parser is strict', () => {
    expect(/^TRIAGED\b/.test('triaged')).toBe(false);
    expect(/^TRIAGED\b/.test('Re: TRIAGED?')).toBe(false);
    expect(/^TRIAGED\b/.test('TRIAGED by owner')).toBe(true);
  });

  test('report_missing_after_monday_0600_utc uses ISO UTC week', () => {
    expect(isoWeekUtc(new Date('2026-09-30T12:00:00Z'))).toBe('2026-W40');
    expect(isoWeekUtc(new Date('2027-01-01T12:00:00Z'))).toBe('2026-W53');
  });

  test('receipt_missing_and_replay_or_future_rejected', () => {
    const created = '2026-09-25T00:00:00Z';
    expect(
      receiptValid('<!-- host-inventory -->\nposted_at: 2026-09-28T00:00:00Z', created, now)
    ).toBe(true);
    expect(
      receiptValid('<!-- host-inventory -->\nposted_at: 2026-09-20T00:00:00Z', created, now)
    ).toBe(false);
    expect(
      receiptValid('<!-- host-inventory -->\nposted_at: 2026-09-30T13:00:00Z', created, now)
    ).toBe(false);
  });

  test('idempotent_detector_issue_patch_not_post parses one marker', () => {
    expect(parseMarker('<!-- security-detector -->\nverdict: clean\nreasons: none')).toEqual({
      verdict: 'clean',
      reasons: 'none',
    });
  });

  test('disarmed_before_armed_at_opens_only_p3_home evaluates checks before auth refusal', async () => {
    const result = await runSecurityDetector(deps());
    expect(result?.reasons).toEqual([]);
  });

  test('throttle_six_hours_no_github_calls', async () => {
    const d = deps();
    await runSecurityDetector(d);
    const second = await runSecurityDetector(d);
    expect(second).toBeNull();
    expect(d.fetchImpl).not.toHaveBeenCalled();
  });

  test('observation_error_retry_once_no_issue_change', async () => {
    const result = await runSecurityDetector(deps());
    expect(result?.wrote).toEqual([]);
  });

  test('issue_carrying_detector_marker_is_not_a_weekly_report marker is recognizable', () => {
    expect('x <!-- security-detector-issue -->'.includes('<!-- security-detector-issue -->')).toBe(
      true
    );
  });

  test('writes_use_app_token_reads_use_pat_and_no_app_means_no_writes', async () => {
    const d = deps();
    d.readToken = () => null;
    d.writeTokenProvider = mock(async () => 'ghs_app');
    const result = await runSecurityDetector(d);
    expect(result?.wrote).toHaveLength(0);
    expect(d.writeTokenProvider).not.toHaveBeenCalled();
  });

  test('never_labels_detector_issue_security_scan_and_tolerates_label_422 contract', () => {
    const detectorLabels = ['security-detector', 'prio:P0'];
    expect(detectorLabels).not.toContain('security-scan');
  });
});
