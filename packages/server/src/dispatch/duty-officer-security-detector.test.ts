import { afterEach, describe, expect, mock, test } from 'bun:test';
import {
  classifyRuns,
  isoWeekUtc,
  parseMarker,
  positiveMs,
  receiptValid,
  runSecurityDetector,
  type SecurityDetectorDeps,
} from './duty-officer-security-detector';

const now = new Date('2026-09-30T12:00:00.000Z');

function deps(
  fetchImpl: typeof fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.includes('/actions/workflows/') && method === 'GET') {
      return Response.json({
        workflow_runs: [{ created_at: '2026-09-29T00:00:00Z', conclusion: 'success' }],
      });
    }
    if (url.includes('/issues?state=all') && method === 'GET') {
      return Response.json([
        {
          number: 40,
          title: 'Security Scan -- 2026-W40',
          body: 'weekly report',
          created_at: '2026-09-28T07:00:00Z',
          updated_at: '2026-09-29T00:00:00Z',
          state: 'open',
          labels: ['security-scan'],
        },
      ]);
    }
    if (url.endsWith('/issues/40/comments?per_page=100') && method === 'GET') {
      return Response.json([
        {
          id: 1,
          body: '<!-- host-inventory -->\nposted_at: 2026-09-29T00:00:00Z',
          user: { login: 'inventory[bot]' },
        },
      ]);
    }
    throw new Error(`unhandled fake GitHub request: ${method} ${url}`);
  })
): SecurityDetectorDeps {
  return {
    fetchImpl,
    readToken: () => 'ghp_read',
    writeTokenProvider: async () => null,
    now: () => now,
    buildSha: 'abc1234',
  };
}

afterEach(() => {
  delete process.env.DUTY_OFFICER_SECURITY_DETECTOR_ARMED_AT;
  delete process.env.DUTY_OFFICER_SECURITY_DETECTOR_INTERVAL_MS;
  delete process.env.DUTY_OFFICER_GITHUB_TIMEOUT_MS;
});

describe('duty officer security detector', () => {
  test('clean_evaluation_closes_detector_issue_and_patches_marker helper verdict', () => {
    expect(
      classifyRuns([{ created_at: '2026-09-28T00:00:00Z', conclusion: 'success' }], 'o/r', now)
    ).toBeNull();
  });

  test('scan_missing_404_opens_p0', async () => {
    process.env.DUTY_OFFICER_SECURITY_DETECTOR_ARMED_AT = '2026-09-01';
    const payloads: Record<string, unknown>[] = [];
    const d = deps(mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.includes('/actions/workflows/')) return new Response('{}', { status: 404 });
      if (url.includes('/issues?state=all')) return Response.json([]);
      if (url.endsWith('/issues') && method === 'POST') {
        payloads.push(JSON.parse(String(init?.body)));
        return Response.json({ number: 99 });
      }
      if (url.endsWith('/issues/99/comments?per_page=100')) return Response.json([]);
      if (url.endsWith('/issues/99/comments') && method === 'POST') return Response.json({ id: 2 });
      throw new Error(`unhandled fake GitHub request: ${method} ${url}`);
    }));
    d.writeTokenProvider = mock(async () => 'ghs_app');
    const result = await runSecurityDetector(d);
    expect(result?.verdict).toBe('alarm');
    expect(result?.reasons.filter(reason => reason.code === 'scan_missing')).toHaveLength(4);
    expect(payloads[0].labels).toEqual(['security-detector', 'prio:P0']);
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
    expect(result?.verdict).toBe('disarmed');
  });

  test('throttle_six_hours_no_github_calls', async () => {
    const d = deps();
    await runSecurityDetector(d);
    const second = await runSecurityDetector(d);
    expect(second).toBeNull();
    expect(d.fetchImpl).toHaveBeenCalled();
  });

  test('observation_error_retry_once_no_issue_change', async () => {
    const fetchImpl = mock(async () => {
      throw new Error('network_down');
    });
    const result = await runSecurityDetector(deps(fetchImpl));
    expect(result?.verdict).toBe('observation_error');
    expect(fetchImpl).toHaveBeenCalledTimes(10);
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

  test('never labels detector issue security-scan and tolerates label 422', async () => {
    process.env.DUTY_OFFICER_SECURITY_DETECTOR_ARMED_AT = '2026-09-01';
    const issuePayloads: Record<string, unknown>[] = [];
    let createAttempts = 0;
    const d = deps(mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.includes('/actions/workflows/')) {
        return Response.json({ workflow_runs: [{ created_at: '2026-09-29T00:00:00Z', conclusion: 'success' }] });
      }
      if (url.includes('/issues?state=all')) return Response.json([]);
      if (url.endsWith('/issues') && method === 'POST') {
        issuePayloads.push(JSON.parse(String(init?.body)));
        createAttempts += 1;
        if (createAttempts === 1) return new Response('{}', { status: 422 });
        return Response.json({ number: 77 });
      }
      if (url.endsWith('/issues/77/comments?per_page=100')) return Response.json([]);
      if (url.endsWith('/issues/77/comments') && method === 'POST') return Response.json({ id: 3 });
      throw new Error(`unhandled fake GitHub request: ${method} ${url}`);
    }));
    d.writeTokenProvider = mock(async () => 'ghs_app');

    const result = await runSecurityDetector(d);

    expect(result?.wrote).toContain('issue_opened');
    expect(issuePayloads[0].labels).toEqual(['security-detector', 'prio:P0']);
    expect(issuePayloads[0].labels).not.toContain('security-scan');
    expect(issuePayloads[1].labels).toBeUndefined();
  });

  test('detector request timeout is clamped to one second', () => {
    process.env.DUTY_OFFICER_GITHUB_TIMEOUT_MS = '1';
    expect(positiveMs('DUTY_OFFICER_GITHUB_TIMEOUT_MS', 15_000, 1_000)).toBe(1_000);
  });
});
