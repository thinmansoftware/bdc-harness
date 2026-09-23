import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  isoWeekUtc,
  resetSecurityDetectorThrottle,
  runSecurityDetector,
  setSecurityDetectorLastRunMs,
  type SecurityDetectorDeps,
} from './duty-officer-security-detector';

const OWNER = 'thinmansoftware';
const GH_REPO = 'thinmansoftware/bdc-xo';
const SCAN_REPOS = [
  'thinmansoftware/shopops',
  'thinmansoftware/lspro-react',
  'thinmansoftware/scout-service',
  'thinmansoftware/bdc-harness',
];
const DAY = 86_400_000;
const APP_LOGIN = 'thinman-overseer[bot]';

type RouteResult = { status: number; body?: unknown };
type Route = (method: string, url: string, init: RequestInit) => RouteResult | undefined;

interface Recorded {
  method: string;
  url: string;
  auth: string;
  body: unknown;
}

function makeFetch(routes: Route[]): {
  fetchImpl: typeof fetch;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const auth = headers.Authorization ?? '';
    const parsedBody = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, url, auth, body: parsedBody });
    for (const route of routes) {
      const hit = route(method, url, init ?? {});
      if (hit) {
        return {
          status: hit.status,
          json: async () => hit.body ?? null,
        } as unknown as Response;
      }
    }
    throw new Error(`unrouted ${method} ${url}`);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function deps(
  fetchImpl: typeof fetch,
  now: Date,
  overrides: Partial<SecurityDetectorDeps> = {}
): SecurityDetectorDeps {
  return {
    fetchImpl,
    readToken: () => 'ghp_read',
    writeTokenProvider: async () => 'ghs_app',
    now: () => now,
    buildSha: 'build0001',
    ...overrides,
  };
}

function runsUrl(full: string): string {
  return `https://api.github.com/repos/${full.split('/')[0]}/${full.split('/')[1]}/actions/workflows/security-scan.yml/runs?status=completed&per_page=10`;
}

function successfulRunsRoute(full: string, ageDays: number, conclusion = 'success'): Route {
  return (method, url) => {
    if (method === 'GET' && url === runsUrl(full)) {
      return {
        status: 200,
        body: {
          workflow_runs: [
            {
              created_at: new Date(FIXED.getTime() - ageDays * DAY).toISOString(),
              conclusion,
              status: 'completed',
            },
          ],
        },
      };
    }
    return undefined;
  };
}

function cleanScanRoutes(): Route[] {
  return SCAN_REPOS.map(full => successfulRunsRoute(full, 2));
}

const FIXED = new Date('2026-09-23T12:00:00.000Z');

function weeklyIssuesUrl(): string {
  return `https://api.github.com/repos/${OWNER}/bdc-xo/issues?state=all&labels=security-scan&sort=created&direction=desc&per_page=30`;
}

function detectorIssuesUrl(): string {
  return `https://api.github.com/repos/${OWNER}/bdc-xo/issues?state=open&labels=security-detector&per_page=30`;
}

function commentsUrl(n: number): string {
  return `https://api.github.com/repos/${OWNER}/bdc-xo/issues/${n}/comments?per_page=100`;
}

function validReceipt(now: Date): { body: string; user: { login: string } } {
  // Posted one hour before `now` -- recent, not in the future, and after any
  // weekly report created a day or more before `now`.
  return {
    body: `<!-- host-inventory -->\nposted_at: ${new Date(now.getTime() - 60 * 60 * 1000).toISOString()}`,
    user: { login: 'bluedevilcollectibles' },
  };
}

function weeklyReport(n: number, week: string, createdAgoDays: number): Record<string, unknown> {
  const created = new Date(FIXED.getTime() - createdAgoDays * DAY).toISOString();
  return {
    number: n,
    title: `Security Scan -- ${week}`,
    body: 'weekly scan report',
    created_at: created,
    updated_at: created,
    labels: [{ name: 'security-scan' }],
  };
}

beforeEach(() => {
  resetSecurityDetectorThrottle();
  process.env.DUTY_OFFICER_GH_REPO = GH_REPO;
  process.env.DUTY_OFFICER_SECURITY_SCAN_REPOS = SCAN_REPOS.join(',');
  process.env.DUTY_OFFICER_SECURITY_SCAN_WORKFLOW = 'security-scan.yml';
  process.env.DUTY_OFFICER_SECURITY_DETECTOR_ARMED_AT = '2026-09-01';
  delete process.env.DUTY_OFFICER_SECURITY_DETECTOR_INTERVAL_MS;
  delete process.env.DUTY_OFFICER_GITHUB_TIMEOUT_MS;
});

afterEach(() => {
  resetSecurityDetectorThrottle();
  delete process.env.DUTY_OFFICER_GH_REPO;
  delete process.env.DUTY_OFFICER_SECURITY_SCAN_REPOS;
  delete process.env.DUTY_OFFICER_SECURITY_SCAN_WORKFLOW;
  delete process.env.DUTY_OFFICER_SECURITY_DETECTOR_ARMED_AT;
  delete process.env.DUTY_OFFICER_SECURITY_DETECTOR_INTERVAL_MS;
  delete process.env.DUTY_OFFICER_GITHUB_TIMEOUT_MS;
});

describe('security detector', () => {
  test('Test 1: clean evaluation closes the DETECTOR issue and PATCHes the marker', async () => {
    const week = isoWeekUtc(FIXED);
    const report = weeklyReport(50, week, 1);
    const routes: Route[] = [
      ...cleanScanRoutes(),
      (m, url) =>
        m === 'GET' && url === weeklyIssuesUrl() ? { status: 200, body: [report] } : undefined,
      (m, url) =>
        m === 'GET' && url === commentsUrl(50)
          ? {
              status: 200,
              body: [
                validReceipt(FIXED),
                { body: '<!-- security-detector -->\nverdict: alarm', user: { login: APP_LOGIN } },
              ],
            }
          : undefined,
      (m, url) =>
        m === 'GET' && url === detectorIssuesUrl()
          ? {
              status: 200,
              body: [
                {
                  number: 77,
                  title: 'DETECTOR: security scan -- scan_missing',
                  body: '<!-- security-detector-issue -->',
                  created_at: FIXED.toISOString(),
                  updated_at: FIXED.toISOString(),
                  labels: [{ name: 'security-detector' }],
                },
              ],
            }
          : undefined,
      (m, url) => (url.includes('/issues/comments/') ? { status: 200, body: {} } : undefined),
      (m, url) =>
        m === 'POST' && url.endsWith('/issues/77/comments') ? { status: 201, body: {} } : undefined,
      (m, url) =>
        m === 'PATCH' && url.endsWith('/issues/77') ? { status: 200, body: {} } : undefined,
    ];
    const { fetchImpl, calls } = makeFetch(routes);
    const result = await runSecurityDetector(deps(fetchImpl, FIXED));

    expect(result?.verdict).toBe('clean');
    expect(calls.some(c => c.method === 'PATCH' && c.url.endsWith('/issues/77'))).toBe(true);
    expect(calls.some(c => c.method === 'PATCH' && c.url.includes('/issues/comments/'))).toBe(true);
    // No new DETECTOR issue POSTed.
    expect(calls.some(c => c.method === 'POST' && /\/issues$/.test(c.url))).toBe(false);
  });

  test('Test 1b: a failed closing comment does NOT close the DETECTOR issue', async () => {
    const week = isoWeekUtc(FIXED);
    const report = weeklyReport(50, week, 1);
    const routes: Route[] = [
      ...cleanScanRoutes(),
      (m, url) =>
        m === 'GET' && url === weeklyIssuesUrl() ? { status: 200, body: [report] } : undefined,
      (m, url) =>
        m === 'GET' && url === commentsUrl(50)
          ? {
              status: 200,
              body: [
                validReceipt(FIXED),
                { body: '<!-- security-detector -->\nverdict: alarm', user: { login: APP_LOGIN } },
              ],
            }
          : undefined,
      (m, url) =>
        m === 'GET' && url === detectorIssuesUrl()
          ? {
              status: 200,
              body: [
                {
                  number: 77,
                  title: 'DETECTOR: security scan -- scan_missing',
                  body: '<!-- security-detector-issue -->',
                  created_at: FIXED.toISOString(),
                  updated_at: FIXED.toISOString(),
                  labels: [{ name: 'security-detector' }],
                },
              ],
            }
          : undefined,
      // The required closing comment fails.
      (m, url) =>
        m === 'POST' && url.endsWith('/issues/77/comments') ? { status: 500 } : undefined,
      (m, url) => (url.includes('/issues/comments/') ? { status: 200, body: {} } : undefined),
      (m, url) =>
        m === 'PATCH' && url.endsWith('/issues/77') ? { status: 200, body: {} } : undefined,
    ];
    const { fetchImpl, calls } = makeFetch(routes);
    const result = await runSecurityDetector(deps(fetchImpl, FIXED));

    // The close MUST NOT happen without its comment, and must not be reported.
    expect(calls.some(c => c.method === 'PATCH' && c.url.endsWith('/issues/77'))).toBe(false);
    expect(result?.wrote).not.toContain('issue_closed');
    // The failure is surfaced, not swallowed.
    expect(result?.error_count).toBeGreaterThan(0);
    expect(result?.last_error).toBe('duty_officer_github_http_500');
    // The marker still proves the detector ran.
    expect(calls.some(c => c.method === 'PATCH' && c.url.includes('/issues/comments/'))).toBe(true);
  });

  test('Test 2: a 404 on a scan workflow opens a P0 DETECTOR issue', async () => {
    const week = isoWeekUtc(FIXED);
    const report = weeklyReport(50, week, 1);
    const routes: Route[] = [
      successfulRunsRoute(SCAN_REPOS[0], 2),
      (m, url) =>
        m === 'GET' && url === runsUrl(SCAN_REPOS[1]) ? { status: 404, body: {} } : undefined,
      successfulRunsRoute(SCAN_REPOS[2], 2),
      successfulRunsRoute(SCAN_REPOS[3], 2),
      (m, url) =>
        m === 'GET' && url === weeklyIssuesUrl() ? { status: 200, body: [report] } : undefined,
      (m, url) =>
        m === 'GET' && url === commentsUrl(50)
          ? { status: 200, body: [validReceipt(FIXED)] }
          : undefined,
      (m, url) =>
        m === 'GET' && url === detectorIssuesUrl() ? { status: 200, body: [] } : undefined,
      (m, url) =>
        m === 'POST' && /\/issues$/.test(url) ? { status: 201, body: { number: 90 } } : undefined,
      (m, url) => (url.endsWith('/issues/50/comments') ? { status: 201, body: {} } : undefined),
    ];
    const { fetchImpl, calls } = makeFetch(routes);
    const result = await runSecurityDetector(deps(fetchImpl, FIXED));

    expect(result?.verdict).toBe('alarm');
    expect(result?.reasons).toContainEqual(
      expect.objectContaining({ code: 'scan_missing', repo: SCAN_REPOS[1] })
    );
    const post = calls.find(c => c.method === 'POST' && /\/issues$/.test(c.url));
    const payload = post?.body as { labels: string[]; title: string };
    expect(payload.labels).toEqual(['security-detector', 'prio:P0']);
    expect(payload.title.startsWith('DETECTOR: security scan -- ')).toBe(true);
    expect(payload.labels).not.toContain('security-scan');
  });

  test('Test 3: no run within 8 days is scan_stale (P0)', async () => {
    const week = isoWeekUtc(FIXED);
    const routes: Route[] = [
      successfulRunsRoute(SCAN_REPOS[0], 9),
      successfulRunsRoute(SCAN_REPOS[1], 2),
      successfulRunsRoute(SCAN_REPOS[2], 2),
      successfulRunsRoute(SCAN_REPOS[3], 2),
      (m, url) =>
        m === 'GET' && url === weeklyIssuesUrl()
          ? { status: 200, body: [weeklyReport(50, week, 1)] }
          : undefined,
      (m, url) =>
        m === 'GET' && url === commentsUrl(50)
          ? { status: 200, body: [validReceipt(FIXED)] }
          : undefined,
      (m, url) =>
        m === 'GET' && url === detectorIssuesUrl() ? { status: 200, body: [] } : undefined,
      (m, url) =>
        m === 'POST' && /\/issues$/.test(url) ? { status: 201, body: { number: 91 } } : undefined,
      (m, url) => (url.includes('/comments') ? { status: 201, body: {} } : undefined),
    ];
    const { fetchImpl } = makeFetch(routes);
    const result = await runSecurityDetector(deps(fetchImpl, FIXED));
    expect(result?.reasons).toContainEqual(
      expect.objectContaining({ code: 'scan_stale', repo: SCAN_REPOS[0] })
    );
  });

  test('Test 4: a recent failure is scan_failed (P1)', async () => {
    const week = isoWeekUtc(FIXED);
    const routes: Route[] = [
      successfulRunsRoute(SCAN_REPOS[0], 2),
      successfulRunsRoute(SCAN_REPOS[1], 2),
      successfulRunsRoute(SCAN_REPOS[2], 1, 'failure'),
      successfulRunsRoute(SCAN_REPOS[3], 2),
      (m, url) =>
        m === 'GET' && url === weeklyIssuesUrl()
          ? { status: 200, body: [weeklyReport(50, week, 1)] }
          : undefined,
      (m, url) =>
        m === 'GET' && url === commentsUrl(50)
          ? { status: 200, body: [validReceipt(FIXED)] }
          : undefined,
      (m, url) =>
        m === 'GET' && url === detectorIssuesUrl() ? { status: 200, body: [] } : undefined,
      (m, url) =>
        m === 'POST' && /\/issues$/.test(url) ? { status: 201, body: { number: 92 } } : undefined,
      (m, url) => (url.includes('/comments') ? { status: 201, body: {} } : undefined),
    ];
    const { fetchImpl, calls } = makeFetch(routes);
    const result = await runSecurityDetector(deps(fetchImpl, FIXED));
    expect(result?.reasons).toEqual([
      expect.objectContaining({ code: 'scan_failed', repo: SCAN_REPOS[2] }),
    ]);
    const post = calls.find(c => c.method === 'POST' && /\/issues$/.test(c.url));
    expect((post?.body as { labels: string[] }).labels).toEqual(['security-detector', 'prio:P1']);
  });

  test('Test 5: a report past its deadline without a first-line TRIAGED is unread (P0)', async () => {
    // now = Monday 05:00 UTC so report_missing is not raised (before the 06:00 grace).
    const monday0500 = new Date('2026-09-21T05:00:00.000Z');
    const report = weeklyReport(60, isoWeekUtc(new Date(monday0500.getTime() - 8 * DAY)), 0);
    report.created_at = new Date(monday0500.getTime() - 8 * DAY).toISOString();
    report.updated_at = report.created_at;
    const routes: Route[] = [
      ...SCAN_REPOS.map(
        full => (m: string, url: string) =>
          m === 'GET' && url === runsUrl(full)
            ? {
                status: 200,
                body: {
                  workflow_runs: [
                    {
                      created_at: new Date(monday0500.getTime() - 2 * DAY).toISOString(),
                      conclusion: 'success',
                      status: 'completed',
                    },
                  ],
                },
              }
            : undefined
      ),
      (m, url) =>
        m === 'GET' && url === weeklyIssuesUrl() ? { status: 200, body: [report] } : undefined,
      (m, url) =>
        m === 'GET' && url === commentsUrl(60)
          ? {
              status: 200,
              body: [
                { body: 'looks triaged to me', user: { login: 'x' } },
                { body: 'Re: TRIAGED?', user: { login: 'x' } },
                {
                  body: `<!-- host-inventory -->\nposted_at: ${new Date(monday0500.getTime() - DAY).toISOString()}`,
                  user: { login: 'x' },
                },
              ],
            }
          : undefined,
      (m, url) =>
        m === 'GET' && url === detectorIssuesUrl() ? { status: 200, body: [] } : undefined,
      (m, url) =>
        m === 'POST' && /\/issues$/.test(url) ? { status: 201, body: { number: 93 } } : undefined,
      (m, url) => (url.includes('/comments') ? { status: 201, body: {} } : undefined),
    ];
    const { fetchImpl } = makeFetch(routes);
    const result = await runSecurityDetector(deps(fetchImpl, monday0500));
    expect(result?.reasons).toContainEqual(
      expect.objectContaining({ code: 'unread', repo: '#60' })
    );
    expect(result?.reasons.some(r => r.code === 'report_missing')).toBe(false);
  });

  test('Test 6: report_missing only after Monday 06:00 UTC', async () => {
    const week = isoWeekUtc(FIXED); // Wednesday 12:00 UTC
    const lastWeekReport = weeklyReport(40, isoWeekUtc(new Date(FIXED.getTime() - 8 * DAY)), 8);
    const buildRoutes = (): Route[] => [
      ...cleanScanRoutes(),
      (m, url) =>
        m === 'GET' && url === weeklyIssuesUrl()
          ? { status: 200, body: [lastWeekReport] }
          : undefined,
      (m, url) =>
        m === 'GET' && url === commentsUrl(40)
          ? {
              status: 200,
              body: [{ body: 'TRIAGED by John', user: { login: 'x' } }, validReceipt(FIXED)],
            }
          : undefined,
      (m, url) =>
        m === 'GET' && url === detectorIssuesUrl() ? { status: 200, body: [] } : undefined,
      (m, url) =>
        m === 'POST' && /\/issues$/.test(url) ? { status: 201, body: { number: 94 } } : undefined,
      (m, url) => (url.includes('/comments') ? { status: 201, body: {} } : undefined),
    ];
    const wed = makeFetch(buildRoutes());
    const wedResult = await runSecurityDetector(deps(wed.fetchImpl, FIXED));
    expect(wedResult?.reasons).toContainEqual(
      expect.objectContaining({ code: 'report_missing', detail: week })
    );

    resetSecurityDetectorThrottle();
    const monday0500 = new Date('2026-09-21T05:00:00.000Z');
    const mon = makeFetch(buildRoutes());
    const monResult = await runSecurityDetector(deps(mon.fetchImpl, monday0500));
    expect(monResult?.reasons.some(r => r.code === 'report_missing')).toBe(false);
  });

  test('Test 7: missing/replay/future receipt is receipt_missing; a recent one is not', async () => {
    const week = isoWeekUtc(FIXED);
    const buildRoutes = (comment: Record<string, unknown> | null): Route[] => [
      ...cleanScanRoutes(),
      (m, url) =>
        m === 'GET' && url === weeklyIssuesUrl()
          ? { status: 200, body: [weeklyReport(70, week, 1)] }
          : undefined,
      (m, url) =>
        m === 'GET' && url === commentsUrl(70)
          ? { status: 200, body: comment ? [comment] : [] }
          : undefined,
      (m, url) =>
        m === 'GET' && url === detectorIssuesUrl() ? { status: 200, body: [] } : undefined,
      (m, url) =>
        m === 'POST' && /\/issues$/.test(url) ? { status: 201, body: { number: 95 } } : undefined,
      (m, url) => (url.includes('/comments') ? { status: 201, body: {} } : undefined),
    ];
    const cases: Array<Record<string, unknown> | null> = [
      null,
      {
        body: `<!-- host-inventory -->\nposted_at: ${new Date(FIXED.getTime() - 10 * DAY).toISOString()}`,
        user: { login: 'x' },
      },
      {
        body: `<!-- host-inventory -->\nposted_at: ${new Date(FIXED.getTime() + 60 * 60 * 1000).toISOString()}`,
        user: { login: 'x' },
      },
    ];
    for (const c of cases) {
      resetSecurityDetectorThrottle();
      const { fetchImpl } = makeFetch(buildRoutes(c));
      const result = await runSecurityDetector(deps(fetchImpl, FIXED));
      expect(result?.reasons.some(r => r.code === 'receipt_missing')).toBe(true);
    }
    resetSecurityDetectorThrottle();
    const good = makeFetch(
      buildRoutes({
        body: `<!-- host-inventory -->\nposted_at: ${new Date(FIXED.getTime() - 60 * 60 * 1000).toISOString()}`,
        user: { login: 'x' },
      })
    );
    const okResult = await runSecurityDetector(deps(good.fetchImpl, FIXED));
    expect(okResult?.reasons.some(r => r.code === 'receipt_missing')).toBe(false);
  });

  test('Test 8: identical alarm state PATCHes nothing on the issue and never POSTs a duplicate', async () => {
    const week = isoWeekUtc(FIXED);
    const report = weeklyReport(50, week, 1);
    const identicalJson = JSON.stringify(
      {
        verdict: 'alarm',
        reasons: [
          { code: 'scan_missing', repo: SCAN_REPOS[1], detail: 'security scan workflow not found' },
        ],
        evaluated_at: 'ignored',
        build_sha: 'build0001',
        armed_at: '2026-09-01',
      },
      null,
      2
    );
    const detectorBody = `<!-- security-detector-issue -->\n\n\`\`\`json\n${identicalJson}\n\`\`\`\n`;
    const buildRoutes = (): Route[] => [
      successfulRunsRoute(SCAN_REPOS[0], 2),
      (m, url) =>
        m === 'GET' && url === runsUrl(SCAN_REPOS[1]) ? { status: 404, body: {} } : undefined,
      successfulRunsRoute(SCAN_REPOS[2], 2),
      successfulRunsRoute(SCAN_REPOS[3], 2),
      (m, url) =>
        m === 'GET' && url === weeklyIssuesUrl() ? { status: 200, body: [report] } : undefined,
      (m, url) =>
        m === 'GET' && url === commentsUrl(50)
          ? {
              status: 200,
              body: [
                validReceipt(FIXED),
                { body: '<!-- security-detector -->\nverdict: alarm', user: { login: APP_LOGIN } },
              ],
            }
          : undefined,
      (m, url) =>
        m === 'GET' && url === detectorIssuesUrl()
          ? {
              status: 200,
              body: [
                {
                  number: 77,
                  title: 'DETECTOR',
                  body: detectorBody,
                  created_at: FIXED.toISOString(),
                  updated_at: FIXED.toISOString(),
                  labels: [{ name: 'security-detector' }],
                },
              ],
            }
          : undefined,
      (m, url) => (url.includes('/issues/comments/') ? { status: 200, body: {} } : undefined),
    ];
    const first = makeFetch(buildRoutes());
    await runSecurityDetector(deps(first.fetchImpl, FIXED));
    resetSecurityDetectorThrottle();
    const second = makeFetch(buildRoutes());
    await runSecurityDetector(deps(second.fetchImpl, FIXED));

    const allCalls = [...first.calls, ...second.calls];
    expect(allCalls.some(c => c.method === 'POST' && /\/issues$/.test(c.url))).toBe(false);
    expect(allCalls.some(c => c.method === 'PATCH' && c.url.endsWith('/issues/77'))).toBe(false);
    expect(
      first.calls.filter(c => c.method === 'PATCH' && c.url.includes('/issues/comments/')).length
    ).toBe(1);
    expect(
      second.calls.filter(c => c.method === 'PATCH' && c.url.includes('/issues/comments/')).length
    ).toBe(1);
  });

  test('Test 9: before ARMED_AT the detector opens only a P3 marker home', async () => {
    process.env.DUTY_OFFICER_SECURITY_DETECTOR_ARMED_AT = new Date(FIXED.getTime() + DAY)
      .toISOString()
      .slice(0, 10);
    const routes: Route[] = [
      ...SCAN_REPOS.map(
        full => (m: string, url: string) =>
          m === 'GET' && url === runsUrl(full) ? { status: 404, body: {} } : undefined
      ),
      (m, url) =>
        m === 'GET' && url === weeklyIssuesUrl() ? { status: 200, body: [] } : undefined,
      (m, url) =>
        m === 'GET' && url === detectorIssuesUrl() ? { status: 200, body: [] } : undefined,
      (m, url) =>
        m === 'POST' && /\/issues$/.test(url) ? { status: 201, body: { number: 96 } } : undefined,
      (m, url) =>
        m === 'POST' && url.endsWith('/issues/96/comments') ? { status: 201, body: {} } : undefined,
    ];
    const { fetchImpl, calls } = makeFetch(routes);
    const result = await runSecurityDetector(deps(fetchImpl, FIXED));
    expect(result?.verdict).toBe('disarmed');
    const post = calls.find(c => c.method === 'POST' && /\/issues$/.test(c.url));
    const payload = post?.body as { labels: string[]; body: string };
    expect(payload.labels).toEqual(['security-detector', 'prio:P3']);
    expect(payload.body).toContain('"verdict": "disarmed"');
    expect(payload.labels).not.toContain('prio:P0');
    expect(payload.labels).not.toContain('prio:P1');
  });

  test('Test 10: throttle inside the interval makes zero GitHub calls', async () => {
    setSecurityDetectorLastRunMs(FIXED.getTime() - 60 * 60 * 1000); // one hour ago
    const { fetchImpl, calls } = makeFetch([]);
    const throttled = await runSecurityDetector(deps(fetchImpl, FIXED));
    expect(throttled).toBeNull();
    expect(calls.length).toBe(0);

    // With a 1s interval and time advanced 2s, it runs again.
    process.env.DUTY_OFFICER_SECURITY_DETECTOR_INTERVAL_MS = '1000';
    const later = new Date(FIXED.getTime() + 2000);
    const routes: Route[] = [
      ...SCAN_REPOS.map(
        full => (m: string, url: string) =>
          m === 'GET' && url === runsUrl(full)
            ? {
                status: 200,
                body: {
                  workflow_runs: [
                    {
                      created_at: new Date(later.getTime() - 2 * DAY).toISOString(),
                      conclusion: 'success',
                      status: 'completed',
                    },
                  ],
                },
              }
            : undefined
      ),
      (m, url) =>
        m === 'GET' && url === weeklyIssuesUrl()
          ? { status: 200, body: [weeklyReport(50, isoWeekUtc(later), 1)] }
          : undefined,
      (m, url) =>
        m === 'GET' && url === commentsUrl(50)
          ? { status: 200, body: [validReceipt(later)] }
          : undefined,
      (m, url) =>
        m === 'GET' && url === detectorIssuesUrl() ? { status: 200, body: [] } : undefined,
      (m, url) => (url.includes('/comments') ? { status: 201, body: {} } : undefined),
    ];
    const run2 = makeFetch(routes);
    const ran = await runSecurityDetector(deps(run2.fetchImpl, later));
    expect(ran).not.toBeNull();
    expect(run2.calls.length).toBeGreaterThan(0);
  });

  test('Test 11: a 500 retries once then yields observation_error with no issue change', async () => {
    const week = isoWeekUtc(FIXED);
    let repo0Calls = 0;
    const routes: Route[] = [
      (m, url) => {
        if (m === 'GET' && url === runsUrl(SCAN_REPOS[0])) {
          repo0Calls += 1;
          return { status: 500, body: {} };
        }
        return undefined;
      },
      successfulRunsRoute(SCAN_REPOS[1], 2),
      successfulRunsRoute(SCAN_REPOS[2], 2),
      successfulRunsRoute(SCAN_REPOS[3], 2),
      (m, url) =>
        m === 'GET' && url === weeklyIssuesUrl()
          ? { status: 200, body: [weeklyReport(50, week, 1)] }
          : undefined,
      (m, url) =>
        m === 'GET' && url === commentsUrl(50)
          ? {
              status: 200,
              body: [
                validReceipt(FIXED),
                { body: '<!-- security-detector -->', user: { login: APP_LOGIN } },
              ],
            }
          : undefined,
      (m, url) =>
        m === 'GET' && url === detectorIssuesUrl()
          ? {
              status: 200,
              body: [
                {
                  number: 77,
                  title: 'DETECTOR',
                  body: '<!-- security-detector-issue -->',
                  created_at: FIXED.toISOString(),
                  updated_at: FIXED.toISOString(),
                  labels: [],
                },
              ],
            }
          : undefined,
      (m, url) =>
        m === 'PATCH' && url.includes('/issues/comments/') ? { status: 200, body: {} } : undefined,
    ];
    const { fetchImpl, calls } = makeFetch(routes);
    const result = await runSecurityDetector(deps(fetchImpl, FIXED));
    expect(repo0Calls).toBe(2);
    expect(result?.verdict).toBe('observation_error');
    expect(result?.last_error?.startsWith('duty_officer_github_http_500')).toBe(true);
    expect(
      calls.some(c => (c.method === 'POST' || c.method === 'PATCH') && /\/issues\/77$/.test(c.url))
    ).toBe(false);
  });

  test('Test 12: an issue carrying the detector marker is not a weekly report', async () => {
    const week = isoWeekUtc(FIXED);
    const impostor = {
      number: 30,
      title: `Security Scan -- ${week}`,
      body: 'looks like a report but <!-- security-detector-issue --> is here',
      created_at: FIXED.toISOString(),
      updated_at: FIXED.toISOString(),
      labels: [{ name: 'security-scan' }],
    };
    const routes: Route[] = [
      ...cleanScanRoutes(),
      (m, url) =>
        m === 'GET' && url === weeklyIssuesUrl() ? { status: 200, body: [impostor] } : undefined,
      (m, url) =>
        m === 'GET' && url === detectorIssuesUrl() ? { status: 200, body: [] } : undefined,
      (m, url) =>
        m === 'POST' && /\/issues$/.test(url) ? { status: 201, body: { number: 97 } } : undefined,
      (m, url) => (url.includes('/comments') ? { status: 201, body: {} } : undefined),
    ];
    const { fetchImpl } = makeFetch(routes);
    const result = await runSecurityDetector(deps(fetchImpl, FIXED));
    expect(result?.reasons).toContainEqual(
      expect.objectContaining({ code: 'report_missing', detail: week })
    );
  });

  test('Test 13: reads use the PAT, writes use the App token, and no App token means no writes', async () => {
    const week = isoWeekUtc(FIXED);
    const report = weeklyReport(50, week, 1);
    const buildRoutes = (): Route[] => [
      successfulRunsRoute(SCAN_REPOS[0], 2),
      (m, url) =>
        m === 'GET' && url === runsUrl(SCAN_REPOS[1]) ? { status: 404, body: {} } : undefined,
      successfulRunsRoute(SCAN_REPOS[2], 2),
      successfulRunsRoute(SCAN_REPOS[3], 2),
      (m, url) =>
        m === 'GET' && url === weeklyIssuesUrl() ? { status: 200, body: [report] } : undefined,
      (m, url) =>
        m === 'GET' && url === commentsUrl(50)
          ? { status: 200, body: [validReceipt(FIXED)] }
          : undefined,
      (m, url) =>
        m === 'GET' && url === detectorIssuesUrl() ? { status: 200, body: [] } : undefined,
      (m, url) =>
        m === 'POST' && /\/issues$/.test(url) ? { status: 201, body: { number: 98 } } : undefined,
      (m, url) => (url.includes('/comments') ? { status: 201, body: {} } : undefined),
    ];
    const withApp = makeFetch(buildRoutes());
    await runSecurityDetector(
      deps(withApp.fetchImpl, FIXED, {
        readToken: () => 'ghp_read',
        writeTokenProvider: async () => 'ghs_app',
      })
    );
    for (const call of withApp.calls) {
      if (call.method === 'GET') expect(call.auth).toBe('Bearer ghp_read');
      else expect(call.auth).toBe('Bearer ghs_app');
    }

    resetSecurityDetectorThrottle();
    const noApp = makeFetch(buildRoutes());
    const result = await runSecurityDetector(
      deps(noApp.fetchImpl, FIXED, {
        readToken: () => 'ghp_read',
        writeTokenProvider: async () => null,
      })
    );
    expect(noApp.calls.some(c => c.method === 'POST' || c.method === 'PATCH')).toBe(false);
    expect(result?.last_error).toBe('app_auth_missing');
  });

  test('Test 14: a 422 on labels is tolerated and security-scan is never written', async () => {
    const week = isoWeekUtc(FIXED);
    const report = weeklyReport(50, week, 1);
    let issuePosts = 0;
    const routes: Route[] = [
      (m, url) =>
        m === 'GET' && url === runsUrl(SCAN_REPOS[0]) ? { status: 404, body: {} } : undefined,
      successfulRunsRoute(SCAN_REPOS[1], 2),
      successfulRunsRoute(SCAN_REPOS[2], 2),
      successfulRunsRoute(SCAN_REPOS[3], 2),
      (m, url) =>
        m === 'GET' && url === weeklyIssuesUrl() ? { status: 200, body: [report] } : undefined,
      (m, url) =>
        m === 'GET' && url === commentsUrl(50)
          ? { status: 200, body: [validReceipt(FIXED)] }
          : undefined,
      (m, url) =>
        m === 'GET' && url === detectorIssuesUrl() ? { status: 200, body: [] } : undefined,
      (m, url) => {
        if (m === 'POST' && /\/issues$/.test(url)) {
          issuePosts += 1;
          return issuePosts === 1
            ? { status: 422, body: {} }
            : { status: 201, body: { number: 99 } };
        }
        return undefined;
      },
      (m, url) => (url.includes('/comments') ? { status: 201, body: {} } : undefined),
    ];
    const { fetchImpl, calls } = makeFetch(routes);
    const result = await runSecurityDetector(deps(fetchImpl, FIXED));
    expect(result?.verdict).toBe('alarm');
    expect(issuePosts).toBe(2);
    const posts = calls.filter(c => c.method === 'POST' && /\/issues$/.test(c.url));
    for (const post of posts) {
      const labels = (post.body as { labels?: string[] }).labels ?? [];
      expect(labels).not.toContain('security-scan');
    }
    // The retry drops only the volatile priority label but PRESERVES
    // security-detector, so the label-filtered discovery query (C6) can still
    // find this issue and never opens a duplicate on the next run.
    expect((posts[1].body as { labels: string[] }).labels).toEqual(['security-detector']);
  });

  test('Test 15: a non-5xx read failure (403) yields observation_error, not a false alarm', async () => {
    const routes: Route[] = [
      ...cleanScanRoutes(),
      // Weekly-report read is forbidden (403) -- an unexpected non-2xx that must
      // NOT be silently treated as an empty report set (which would false-alarm).
      (m, url) =>
        m === 'GET' && url === weeklyIssuesUrl() ? { status: 403, body: {} } : undefined,
      (m, url) =>
        m === 'GET' && url === detectorIssuesUrl() ? { status: 200, body: [] } : undefined,
    ];
    const { fetchImpl, calls } = makeFetch(routes);
    const result = await runSecurityDetector(deps(fetchImpl, FIXED));
    expect(result?.verdict).toBe('observation_error');
    expect(result?.error_count).toBeGreaterThanOrEqual(1);
    expect(result?.last_error).toContain('403');
    // observation_error never opens/closes an issue on a partial read.
    const issuePosts = calls.filter(c => c.method === 'POST' && /\/issues$/.test(c.url));
    expect(issuePosts.length).toBe(0);
    expect(result?.wrote).not.toContain('issue_opened');
    expect(result?.wrote).not.toContain('issue_closed');
  });

  test('Test 16: a failed marker write surfaces in error_count and is not recorded as wrote', async () => {
    const week = isoWeekUtc(FIXED);
    const report = weeklyReport(50, week, 1);
    const routes: Route[] = [
      (m, url) =>
        m === 'GET' && url === runsUrl(SCAN_REPOS[0]) ? { status: 404, body: {} } : undefined,
      successfulRunsRoute(SCAN_REPOS[1], 2),
      successfulRunsRoute(SCAN_REPOS[2], 2),
      successfulRunsRoute(SCAN_REPOS[3], 2),
      (m, url) =>
        m === 'GET' && url === weeklyIssuesUrl() ? { status: 200, body: [report] } : undefined,
      (m, url) =>
        m === 'GET' && url === commentsUrl(50)
          ? { status: 200, body: [validReceipt(FIXED)] }
          : undefined,
      (m, url) =>
        m === 'GET' && url === detectorIssuesUrl() ? { status: 200, body: [] } : undefined,
      (m, url) =>
        m === 'POST' && /\/issues$/.test(url) ? { status: 201, body: { number: 99 } } : undefined,
      // The marker comment POST (onto the weekly report #50) fails hard (5xx).
      (m, url) =>
        m === 'POST' && url.endsWith('/issues/50/comments') ? { status: 500, body: {} } : undefined,
    ];
    const { fetchImpl } = makeFetch(routes);
    const result = await runSecurityDetector(deps(fetchImpl, FIXED));
    expect(result?.verdict).toBe('alarm');
    // The issue opened successfully...
    expect(result?.wrote).toContain('issue_opened');
    // ...but the marker write failed, so it must NOT be recorded as wrote and
    // MUST surface in error_count / last_error.
    expect(result?.wrote).not.toContain('marker');
    expect(result?.error_count).toBeGreaterThanOrEqual(1);
    expect(result?.last_error).toContain('500');
  });
});
