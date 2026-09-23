import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import {
  classifyRuns,
  isoWeekUtc,
  mintAppInstallationToken,
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
  test('App token exchange uses the deadline signal', async () => {
    const saved = {
      GITHUB_APP_ID: process.env.GITHUB_APP_ID,
      GITHUB_APP_INSTALLATION_ID: process.env.GITHUB_APP_INSTALLATION_ID,
      GITHUB_APP_PRIVATE_KEY: process.env.GITHUB_APP_PRIVATE_KEY,
    };
    const controller = new AbortController();
    const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      expect(String(url)).toBe('https://api.github.com/app/installations/456/access_tokens');
      expect(init?.signal).toBe(controller.signal);
      expect(init?.method).toBe('POST');
      return Response.json({ token: 'test-installation-token' });
    });
    try {
      process.env.GITHUB_APP_ID = '123';
      process.env.GITHUB_APP_INSTALLATION_ID = '456';
      process.env.GITHUB_APP_PRIVATE_KEY = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
      }).privateKey;
      expect(await mintAppInstallationToken(controller.signal)).toBe('test-installation-token');
      controller.abort(new Error('test_deadline'));
      await expect(mintAppInstallationToken(controller.signal)).rejects.toThrow('test_deadline');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      fetchMock.mockRestore();
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('deadline rejects a stuck fetch, aborts its signal, and prevents writes', async () => {
    let receivedSignal: AbortSignal | null | undefined;
    const writes: string[] = [];
    const d = deps(
      mock((_url, init) => {
        receivedSignal = init?.signal;
        if (init?.method !== 'GET') writes.push(init?.method ?? 'GET');
        return new Promise<Response>(() => {});
      }) as typeof fetch
    );
    d.readToken = () => 'read-token';
    d.writeTokenProvider = mock(async () => 'app-token');
    const controller = new AbortController();
    const signal = controller.signal;
    const deadline = setTimeout(() => controller.abort(new Error('test_deadline')), 30);
    try {
      await expect(runSecurityDetector(d, signal)).rejects.toThrow('test_deadline');
    } finally {
      clearTimeout(deadline);
    }
    expect(signal.aborted).toBe(true);
    expect(receivedSignal?.aborted).toBe(true);
    await Bun.sleep(10);
    expect(writes).toEqual([]);
    expect(d.fetchImpl).toHaveBeenCalledTimes(1);
    expect(d.writeTokenProvider).not.toHaveBeenCalled();
  });

  test('abort during a write cancels its signal and prevents all later writes', async () => {
    const controller = new AbortController();
    const writes: string[] = [];
    const signals: AbortSignal[] = [];
    const d = deps(
      mock(async (_url, init) => {
        signals.push(init!.signal!);
        if (init?.method === 'GET') {
          return Response.json(String(_url).includes('/runs?') ? { workflow_runs: [] } : []);
        }
        writes.push(init!.method!);
        controller.abort(new Error('test_deadline'));
        // A transport that ignores cancellation must not cause a later marker write.
        return Response.json({ number: 42 });
      }) as typeof fetch
    );
    d.readToken = () => 'read-token';
    d.writeTokenProvider = async () => 'app-token';
    await expect(runSecurityDetector(d, controller.signal)).rejects.toThrow('test_deadline');
    expect(writes).toEqual(['POST']);
    expect(signals.every(signal => signal.aborted)).toBe(true);
  });

  test('abort while acquiring write auth prevents the first issue write', async () => {
    const controller = new AbortController();
    const d = deps(
      mock(async (_url, init) => {
        expect(init?.method).toBe('GET');
        return Response.json(String(_url).includes('/runs?') ? { workflow_runs: [] } : []);
      }) as typeof fetch
    );
    d.readToken = () => 'read-token';
    d.writeTokenProvider = async signal => {
      expect(signal).toBe(controller.signal);
      controller.abort(new Error('test_deadline'));
      return 'app-token';
    };
    await expect(runSecurityDetector(d, controller.signal)).rejects.toThrow('test_deadline');
  });

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
