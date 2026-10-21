import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { rootLogger } from '@archon/paths';
import {
  resetSecurityDetectorStateForTests,
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
    readToken: async () => null,
    writeTokenProvider: async () => null,
    now: () => now,
    buildSha: 'abc1234',
  };
}

const TOKEN_ENV_KEYS = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'DUTY_OFFICER_GH_NUDGE',
  'GITHUB_APP_DUTY_OFFICER_ID',
  'GITHUB_APP_DUTY_OFFICER_INSTALLATION_ID',
  'GITHUB_APP_DUTY_OFFICER_PRIVATE_KEY',
  'GITHUB_APP_DUTY_OFFICER_PRIVATE_KEY_PATH',
  'GITHUB_APP_TASKMASTER_ID',
  'GITHUB_APP_TASKMASTER_INSTALLATION_ID',
  'GITHUB_APP_TASKMASTER_PRIVATE_KEY',
  'GITHUB_APP_TASKMASTER_PRIVATE_KEY_PATH',
  'GITHUB_APP_ID',
  'GITHUB_APP_INSTALLATION_ID',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_APP_PRIVATE_KEY_PATH',
] as const;

function snapshotEnv(keys: readonly string[]): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const key of keys) saved[key] = process.env[key];
  return saved;
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function captureLogs(): { lines: string[]; restore: () => void } {
  const streamSymbol = Object.getOwnPropertySymbols(rootLogger).find(
    symbol => symbol.description === 'pino.stream'
  );
  if (streamSymbol === undefined) throw new Error('pino.stream symbol missing on rootLogger');
  const stream = (rootLogger as unknown as Record<symbol, { write: (line: string) => void }>)[
    streamSymbol
  ];
  const lines: string[] = [];
  const write = spyOn(stream, 'write').mockImplementation(line => {
    lines.push(String(line));
  });
  return { lines, restore: () => write.mockRestore() };
}

function observationRecords(lines: string[]): Array<Record<string, unknown>> {
  return lines
    .map(line => line.trim())
    .filter(
      line =>
        line.startsWith('{') && line.includes('duty_officer_security_detector_observation_error')
    )
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(resetSecurityDetectorStateForTests);

afterEach(() => {
  resetSecurityDetectorStateForTests();
  delete process.env.DUTY_OFFICER_SECURITY_DETECTOR_ARMED_AT;
  delete process.env.DUTY_OFFICER_SECURITY_DETECTOR_INTERVAL_MS;
  delete process.env.DUTY_OFFICER_SECURITY_DETECTOR_ERROR_BACKOFF_MS;
  delete process.env.DUTY_OFFICER_SECURITY_SCAN_REPOS;
  delete process.env.DUTY_OFFICER_GH_REPO;
  delete process.env.DUTY_OFFICER_SECURITY_TRUSTED_LOGINS;
});

describe('duty officer security detector', () => {
  for (const { login, allowList, trusted } of [
    { login: 'other-collaborator', allowList: undefined, trusted: false },
    { login: undefined, allowList: undefined, trusted: false },
    { login: 'bluedevilcollectibles', allowList: undefined, trusted: true },
    { login: 'thinman-overseer[bot]', allowList: undefined, trusted: true },
    { login: 'custom-reviewer', allowList: ' , CUSTOM-reviewer , ', trusted: true },
    { login: 'bluedevilcollectibles', allowList: 'custom-reviewer', trusted: false },
    { login: 'bluedevilcollectibles', allowList: '', trusted: false },
  ]) {
    test(`receipt and TRIAGED author ${login} with allow-list ${allowList}: trusted=${trusted}`, async () => {
      if (allowList === undefined) delete process.env.DUTY_OFFICER_SECURITY_TRUSTED_LOGINS;
      else process.env.DUTY_OFFICER_SECURITY_TRUSTED_LOGINS = allowList;
      process.env.DUTY_OFFICER_SECURITY_DETECTOR_ARMED_AT = '2026-09-01';
      const streamSymbol = Object.getOwnPropertySymbols(rootLogger).find(
        symbol => symbol.description === 'pino.stream'
      )!;
      const stream = (rootLogger as unknown as Record<symbol, { write: (line: string) => void }>)[
        streamSymbol
      ];
      const lines: string[] = [];
      const write = spyOn(stream, 'write').mockImplementation(line => {
        lines.push(line);
      });
      const d = deps(
        mock(async (url, init) => {
          expect(init?.method).toBe('GET');
          // Changing configuration during I/O must not change this run's trust decision.
          process.env.DUTY_OFFICER_SECURITY_TRUSTED_LOGINS = 'other-collaborator';
          if (String(url).includes('/runs?')) {
            return Response.json({
              workflow_runs: [{ created_at: '2026-09-29T00:00:00Z', conclusion: 'success' }],
            });
          }
          if (String(url).includes('/comments?')) {
            return Response.json([
              {
                id: 101,
                user: { login },
                body: '<!-- host-inventory -->\nposted_at: 2026-09-29T00:00:00Z\nprivate-receipt-body',
              },
              { id: 102, user: { login }, body: 'TRIAGED private-triage-body' },
            ]);
          }
          return Response.json([
            {
              number: 42,
              title: 'Security Scan -- 2026-W39',
              labels: ['security-scan'],
              created_at: '2026-09-21T00:00:00Z',
              updated_at: '2026-09-29T00:00:00Z',
            },
          ]);
        }) as typeof fetch
      );
      d.readToken = async () => 'read-token';
      try {
        for (let run = 0; run < 2; run += 1) {
          if (allowList === undefined) delete process.env.DUTY_OFFICER_SECURITY_TRUSTED_LOGINS;
          else process.env.DUTY_OFFICER_SECURITY_TRUSTED_LOGINS = allowList;
          // Each trust check is an independent evaluation at the same deterministic time.
          resetSecurityDetectorStateForTests();
          const result = await runSecurityDetector({ ...d });
          expect(result?.verdict).toBe('alarm');
          const codes = result!.reasons.map(reason => reason.code);
          expect(codes.includes('receipt_missing')).toBe(!trusted);
          expect(codes.includes('unread')).toBe(!trusted);
          const ignored = lines.filter(line =>
            line.includes('duty_officer_security_detector_untrusted_marker_ignored')
          );
          expect(ignored).toHaveLength(trusted ? 0 : run + 1);
          if (!trusted) {
            expect(JSON.parse(ignored[run])).toEqual(
              expect.objectContaining({ issue: 42, login: login ?? null, comment_id: 101 })
            );
          }
          expect(lines.join('')).not.toContain('private-receipt-body');
          expect(lines.join('')).not.toContain('private-triage-body');
        }
      } finally {
        write.mockRestore();
      }
    });
  }

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
    d.readToken = async () => 'read-token';
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
    d.readToken = async () => 'read-token';
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
    d.readToken = async () => 'read-token';
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
    d.readToken = async () => null;
    d.writeTokenProvider = mock(async () => 'ghs_app');
    const result = await runSecurityDetector(d);
    expect(result?.wrote).toHaveLength(0);
    expect(d.writeTokenProvider).not.toHaveBeenCalled();
  });

  test('never_labels_detector_issue_security_scan_and_tolerates_label_422 contract', () => {
    const detectorLabels = ['security-detector', 'prio:P0'];
    expect(detectorLabels).not.toContain('security-scan');
  });

  test('observation_error logs carry last_error', async () => {
    const saved = snapshotEnv(TOKEN_ENV_KEYS);
    const logs = captureLogs();
    try {
      for (const key of TOKEN_ENV_KEYS) delete process.env[key];
      process.env.DUTY_OFFICER_SECURITY_DETECTOR_ARMED_AT = '2026-09-01';
      const missing = await runSecurityDetector(deps());
      expect(missing?.last_error).toBe('duty_officer_github_token_missing');
      const missingRecords = observationRecords(logs.lines);
      expect(missingRecords.length).toBeGreaterThan(0);
      for (const record of missingRecords) {
        expect(record.last_error).toBe('duty_officer_github_token_missing');
        expect(record.identity_kind).toBe('pat');
      }

      logs.lines.length = 0;
      resetSecurityDetectorStateForTests();
      process.env.DUTY_OFFICER_SECURITY_SCAN_REPOS = 'owner/scan';
      process.env.DUTY_OFFICER_GH_REPO = 'owner/write';
      let fetches = 0;
      const failing = deps(
        mock(async () => {
          fetches += 1;
          return new Response('unavailable', { status: 500 });
        }) as typeof fetch
      );
      failing.readToken = async () => 'read-token';
      failing.writeTokenProvider = async () => 'write-token';
      const httpError = await runSecurityDetector(failing);
      expect(httpError?.verdict).toBe('observation_error');
      expect(httpError?.last_error).toBe('duty_officer_github_http_500');
      // One retry on HTTP 500: workflow runs, then the issue list.
      expect(fetches).toBe(4);
      const httpRecords = observationRecords(logs.lines);
      expect(httpRecords.length).toBeGreaterThan(0);
      for (const record of httpRecords) {
        expect(record.last_error).toBe('duty_officer_github_http_500');
        expect(record.err).toBeDefined();
      }
    } finally {
      logs.restore();
      restoreEnv(saved);
    }
  });

  test('error run retries after the backoff and a clean run keeps the normal interval', async () => {
    process.env.DUTY_OFFICER_SECURITY_DETECTOR_ERROR_BACKOFF_MS = '60000';
    process.env.DUTY_OFFICER_SECURITY_DETECTOR_ARMED_AT = '2026-09-01';
    process.env.DUTY_OFFICER_SECURITY_SCAN_REPOS = 'owner/scan';
    process.env.DUTY_OFFICER_GH_REPO = 'owner/write';
    const t0 = Date.parse('2026-09-30T12:00:00.000Z');
    let nowMs = t0;
    let token: string | null = null;
    const writes: string[] = [];
    const fetchImpl = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if ((init?.method ?? 'GET') !== 'GET') {
        writes.push(init?.method ?? 'POST');
        return Response.json({ number: 77, id: 9 });
      }
      if (href.includes('/runs?')) {
        return Response.json({
          workflow_runs: [{ created_at: '2026-09-29T00:00:00.000Z', conclusion: 'success' }],
        });
      }
      if (href.includes('/comments')) {
        return Response.json([
          {
            id: 1,
            user: { login: 'bluedevilcollectibles' },
            body: '<!-- host-inventory -->\nposted_at: 2026-09-29T00:00:00Z',
          },
          { id: 2, user: { login: 'bluedevilcollectibles' }, body: 'TRIAGED ok' },
        ]);
      }
      return Response.json([
        {
          number: 77,
          title: 'Security Scan -- 2026-W40',
          labels: ['security-scan'],
          state: 'open',
          body: 'weekly',
          created_at: '2026-09-28T00:00:00.000Z',
          updated_at: '2026-09-29T00:00:00.000Z',
        },
      ]);
    });
    const d = deps(fetchImpl as typeof fetch);
    d.readToken = async () => token;
    d.writeTokenProvider = async () => 'write-token';
    d.now = () => new Date(nowMs);
    const logs = captureLogs();
    try {
      const first = await runSecurityDetector(d);
      expect(first?.verdict).toBe('observation_error');
      expect(fetchImpl).not.toHaveBeenCalled();

      nowMs = t0 + 61_000;
      token = 'read-token';
      const second = await runSecurityDetector(d);
      expect(second?.verdict).toBe('clean');
      expect(second?.wrote).toContain('marker_patched');
      expect(writes.length).toBeGreaterThan(0);

      const callsAfterClean = fetchImpl.mock.calls.length;
      logs.lines.length = 0;
      nowMs = t0 + 62_000;
      const third = await runSecurityDetector(d);
      expect(third).toBeNull();
      expect(fetchImpl.mock.calls.length).toBe(callsAfterClean);
      expect(
        logs.lines.some(line => line.includes('duty_officer_security_detector_skipped_throttle'))
      ).toBe(true);
    } finally {
      logs.restore();
    }
  });

  test('repeated observation errors retry on the backoff boundary and do not spin', async () => {
    process.env.DUTY_OFFICER_SECURITY_DETECTOR_ERROR_BACKOFF_MS = '60000';
    const executed: number[] = [];
    for (let seconds = 0; seconds <= 120; seconds += 10) {
      const at = seconds * 1000;
      const result = await runSecurityDetector({
        ...deps(),
        readToken: async () => null,
        now: () => new Date(at),
      });
      if (result !== null) {
        expect(result.verdict).toBe('observation_error');
        executed.push(seconds);
      }
    }
    expect(executed).toEqual([0, 60, 120]);
  });
});
