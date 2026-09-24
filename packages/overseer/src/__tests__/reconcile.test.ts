import { describe, expect, mock, test } from 'bun:test';
import { DEFAULT_RATE_LIMIT_RETRY_MS } from '../github-rate-limit';
import {
  reconcileSchedulerWaitMs,
  runReconcileOnce,
  type ReconcileActionRecord,
  type ReconcileDeps,
  type ReconcileMergedPullRequest,
  type ReconcileTrackerIssue,
} from '../reconcile';

export const stem = 'WO-HARNESS-OVERSEER-V1B-TRACKER-RECONCILE-01';

export function mergedPr(
  overrides: Partial<ReconcileMergedPullRequest> = {}
): ReconcileMergedPullRequest {
  return {
    owner: 'thinmansoftware',
    repo: 'bdc-harness',
    number: 404,
    title: 'BDC feature Work Order implementation',
    body: `Implements ${stem}.`,
    htmlUrl: 'https://github.com/thinmansoftware/bdc-harness/pull/404',
    state: 'closed',
    merged: true,
    mergeCommitSha: 'abc123merge',
    mergedAt: '2026-07-17T12:00:00Z',
    ...overrides,
  };
}

export function trackerIssue(state: 'open' | 'closed' = 'open'): ReconcileTrackerIssue {
  return {
    owner: 'thinmansoftware',
    repo: 'bdc-xo',
    number: 1044,
    title: stem,
    state,
  };
}

export function fakeDeps(
  input: {
    prs?: ReconcileMergedPullRequest[];
    tracker?: ReconcileTrackerIssue | null;
    searchError?: unknown;
    trackerLookupError?: unknown;
    skipAlreadyNoted?: boolean;
    closeAlreadyRecorded?: boolean;
  } = {}
): ReconcileDeps & {
  comments: string[];
  labels: string[];
  closes: number[];
  actions: ReconcileActionRecord[];
  warnings: string[];
  warningFields: Record<string, unknown>[];
  infos: string[];
} {
  const comments: string[] = [];
  const labels: string[] = [];
  const closes: number[] = [];
  const actions: ReconcileActionRecord[] = [];
  const warnings: string[] = [];
  const warningFields: Record<string, unknown>[] = [];
  const infos: string[] = [];
  return {
    comments,
    labels,
    closes,
    actions,
    warnings,
    warningFields,
    infos,
    readCursor: mock(async () => null),
    now: () => new Date('2026-07-17T12:00:00Z'),
    searchMergedPullRequests: mock(async () => {
      if (input.searchError) throw input.searchError;
      return input.prs ?? [mergedPr()];
    }),
    findTrackerIssueByStem: mock(async (candidate: string) => {
      if (input.trackerLookupError) throw input.trackerLookupError;
      if (candidate !== stem) return null;
      return input.tracker === undefined ? trackerIssue() : input.tracker;
    }),
    addTrackerEvidenceComment: mock(async request => {
      comments.push(request.body);
    }),
    addTrackerLabel: mock(async request => {
      labels.push(request.label);
    }),
    closeTrackerIssue: mock(async request => {
      closes.push(request.issue.number);
    }),
    hasSkipBeenNoted: mock(async () => Boolean(input.skipAlreadyNoted)),
    hasCloseBeenRecorded: mock(async () => Boolean(input.closeAlreadyRecorded)),
    insertAction: mock(async record => {
      actions.push(record);
    }),
    log: {
      warn: (fields, message) => {
        warnings.push(message);
        warningFields.push(fields);
      },
      info: (_fields, message) => {
        infos.push(message);
      },
    },
  };
}

describe('reconcile', () => {
  test('merged fixture PR with stem in BODY and open tracker closes with evidence and records action=reconcile_close', async () => {
    const deps = fakeDeps();

    const result = await runReconcileOnce({ deps });

    expect(result).toEqual({ scanned: 1, closed: 1, skipped: false });
    expect(deps.comments).toHaveLength(1);
    expect(deps.comments[0]).toContain('https://github.com/thinmansoftware/bdc-harness/pull/404');
    expect(deps.comments[0]).toContain('abc123merge');
    expect(deps.comments[0]).toContain('thinmansoftware/bdc-harness');
    expect(deps.labels).toEqual(['wo:done']);
    expect(deps.closes).toEqual([1044]);
    expect(deps.actions).toMatchObject([
      {
        woId: stem,
        action: 'reconcile_close',
        result: 'https://github.com/thinmansoftware/bdc-harness/pull/404:abc123merge',
      },
    ]);
  });

  test('same input second run no-ops when tracker is already closed', async () => {
    const deps = fakeDeps({ tracker: trackerIssue('open') });
    await runReconcileOnce({ deps });
    deps.comments.length = 0;
    deps.labels.length = 0;
    deps.closes.length = 0;
    deps.actions.length = 0;
    deps.findTrackerIssueByStem = mock(async () => trackerIssue('closed'));

    const result = await runReconcileOnce({ deps });

    expect(result).toEqual({ scanned: 1, closed: 0, skipped: false });
    expect(deps.comments).toEqual([]);
    expect(deps.labels).toEqual([]);
    expect(deps.closes).toEqual([]);
    expect(deps.actions).toEqual([]);
  });

  test('merged PR with no stem is ignored', async () => {
    const deps = fakeDeps({
      prs: [mergedPr({ title: 'Generic merged PR', body: 'No work order marker here.' })],
    });

    const result = await runReconcileOnce({ deps });

    expect(result).toEqual({ scanned: 1, closed: 0, skipped: false });
    expect(deps.findTrackerIssueByStem).not.toHaveBeenCalled();
    expect(deps.closes).toEqual([]);
  });

  test('OPEN unmerged PR with stem is ignored', async () => {
    const deps = fakeDeps({ prs: [mergedPr({ state: 'open', merged: false })] });

    const result = await runReconcileOnce({ deps });

    expect(result).toEqual({ scanned: 1, closed: 0, skipped: false });
    expect(deps.findTrackerIssueByStem).not.toHaveBeenCalled();
    expect(deps.closes).toEqual([]);
  });

  test('rate-limit response skips cycle with warn log and no tracker action or false no PR conclusion', async () => {
    const deps = fakeDeps({
      searchError: Object.assign(new Error('API rate limit exceeded'), { status: 403 }),
    });

    const result = await runReconcileOnce({ deps });

    expect(result).toMatchObject({ scanned: 0, closed: 0, skipped: true });
    expect(result.retryAfterMs).toBe(DEFAULT_RATE_LIMIT_RETRY_MS);
    expect(deps.warnings).toEqual(['overseer.reconcile.rate_limit_skip']);
    expect(deps.findTrackerIssueByStem).not.toHaveBeenCalled();
    expect(deps.comments).toEqual([]);
    expect(deps.closes).toEqual([]);
    expect(deps.actions).toEqual([]);
  });

  test('401 auth-error response skips cycle with warn log and does not throw', async () => {
    const deps = fakeDeps({
      searchError: Object.assign(new Error('Bad credentials'), { status: 401 }),
    });

    const result = await runReconcileOnce({ deps });

    expect(result).toEqual({ scanned: 0, closed: 0, skipped: true });
    expect(deps.warnings).toEqual(['overseer.reconcile.auth_error_skip']);
    expect(deps.findTrackerIssueByStem).not.toHaveBeenCalled();
    expect(deps.comments).toEqual([]);
    expect(deps.closes).toEqual([]);
    expect(deps.actions).toEqual([]);
  });

  test('generic search transport error skips cycle with warn log and does not throw', async () => {
    const deps = fakeDeps({ searchError: new Error('socket reset') });

    const result = await runReconcileOnce({ deps });

    expect(result).toEqual({ scanned: 0, closed: 0, skipped: true });
    expect(deps.warnings).toEqual(['overseer.reconcile.transport_error_skip']);
    expect(deps.findTrackerIssueByStem).not.toHaveBeenCalled();
  });

  test('rate-limit response from findTrackerIssueByStem (per-stem search, not the merged-PR search) skips cleanly instead of crashing the watcher (regression: live incident 2026-07-22, overseer_runtime.watcher_exception_degraded)', async () => {
    const deps = fakeDeps({
      trackerLookupError: Object.assign(new Error('API rate limit exceeded'), {
        status: 403,
        response: { headers: { 'x-ratelimit-resource': 'search' } },
      }),
    });

    const result = await runReconcileOnce({ deps });

    expect(result).toMatchObject({ scanned: 1, closed: 0, skipped: true });
    expect(result.retryAfterMs).toBe(DEFAULT_RATE_LIMIT_RETRY_MS);
    expect(deps.warnings).toEqual(['overseer.reconcile.rate_limit_skip']);
    expect(deps.comments).toEqual([]);
    expect(deps.closes).toEqual([]);
    expect(deps.actions).toEqual([]);
  });

  test('401 auth-error response from findTrackerIssueByStem skips cleanly instead of crashing the watcher', async () => {
    const deps = fakeDeps({
      trackerLookupError: Object.assign(new Error('Bad credentials'), { status: 401 }),
    });

    const result = await runReconcileOnce({ deps });

    expect(result).toEqual({ scanned: 1, closed: 0, skipped: true });
    expect(deps.warnings).toEqual(['overseer.reconcile.auth_error_skip']);
    expect(deps.comments).toEqual([]);
    expect(deps.closes).toEqual([]);
    expect(deps.actions).toEqual([]);
  });

  test('403 with x-ratelimit-remaining 0 defers with classified fields and does not throw', async () => {
    const deps = fakeDeps({
      searchError: Object.assign(new Error('Forbidden'), {
        status: 403,
        response: { headers: { 'x-ratelimit-remaining': '0' } },
      }),
    });
    deps.githubIdentity = 'pat';

    const result = await runReconcileOnce({ deps });

    expect(result).toMatchObject({ scanned: 0, closed: 0, skipped: true });
    expect(result.retryAfterMs).toBe(DEFAULT_RATE_LIMIT_RETRY_MS);
    expect(deps.warnings).toEqual(['overseer.reconcile.rate_limit_skip']);
    expect(deps.warnings).not.toContain('overseer.reconcile.iteration_failed_isolated');
    const fields = deps.warningFields[0];
    expect(fields).toMatchObject({
      identity: 'pat',
      operation: 'searchMergedPullRequests',
      rateLimitRemaining: '0',
      source: 'default',
      kind: 'primary',
    });
    expect(typeof fields?.retryAfterMs).toBe('number');
    expect(fields?.retryAfter).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(deps.findTrackerIssueByStem).not.toHaveBeenCalled();
    expect(deps.closes).toEqual([]);
  });

  test('classified rate limit from listPullRequestFiles defers instead of failing open', async () => {
    const deps = fakeDeps();
    deps.githubIdentity = 'app';
    deps.listPullRequestFiles = async () => {
      throw Object.assign(new Error('Forbidden'), {
        status: 403,
        response: { headers: { 'x-ratelimit-remaining': '0' } },
      });
    };

    const result = await runReconcileOnce({ deps });

    expect(result).toMatchObject({ scanned: 1, closed: 0, skipped: true });
    expect(result.retryAfterMs).toBe(DEFAULT_RATE_LIMIT_RETRY_MS);
    expect(deps.warnings).toContain('overseer.reconcile.rate_limit_skip');
    expect(deps.warnings).not.toContain('overseer.reconcile.file_list_failed_leaving_tracker_open');
    expect(deps.closes).toEqual([]);
    expect(deps.warningFields[0]).toMatchObject({
      identity: 'app',
      operation: 'listPullRequestFiles',
      rateLimitRemaining: '0',
      kind: 'primary',
    });
  });

  test('classified rate limit from addTrackerEvidenceComment defers and keeps prior counts', async () => {
    const deps = fakeDeps();
    deps.githubIdentity = 'app';
    deps.addTrackerEvidenceComment = async () => {
      throw Object.assign(new Error('Forbidden'), {
        status: 403,
        response: { headers: { 'x-ratelimit-remaining': '0' } },
      });
    };

    const result = await runReconcileOnce({ deps });

    expect(result).toMatchObject({ scanned: 1, closed: 0, skipped: true });
    expect(result.retryAfterMs).toBe(DEFAULT_RATE_LIMIT_RETRY_MS);
    expect(deps.closes).toEqual([]);
    expect(deps.warningFields.at(-1)).toMatchObject({
      identity: 'app',
      operation: 'addTrackerEvidenceComment',
      kind: 'primary',
    });
  });

  test('non-rate-limit evidence comment failure still throws', async () => {
    const deps = fakeDeps();
    deps.addTrackerEvidenceComment = async () => {
      throw new Error('boom');
    };

    await expect(runReconcileOnce({ deps })).rejects.toThrow('boom');
  });

  test('tracker already closed no-ops with no duplicate comment', async () => {
    const deps = fakeDeps({ tracker: trackerIssue('closed') });

    const result = await runReconcileOnce({ deps });

    expect(result).toEqual({ scanned: 1, closed: 0, skipped: false });
    expect(deps.comments).toEqual([]);
    expect(deps.labels).toEqual([]);
    expect(deps.closes).toEqual([]);
    expect(deps.actions).toEqual([]);
  });
});

interface AuthProbeResult {
  ok: boolean;
  error?: string;
  constructions: {
    hasAuthStrategy: boolean;
    authStrategyName: string | null;
    appId: string | null;
    installationId: string | null;
    authIsString: boolean;
  }[];
  logs: { message: string; identity?: string; operation?: string; rateLimitRemaining?: string }[];
  missingCredentials: boolean;
  issueCalls?: { operation: string; authIsString: boolean }[];
}

function runAuthProbe(
  mode: 'app-and-pat' | 'pat-only' | 'app-only' | 'issue-mutations',
  issueFailure: 'none' | 'permission' | 'rate-limit' = 'none'
): AuthProbeResult {
  const probe = new URL('./fixtures/reconcile-auth-probe.ts', import.meta.url);
  const child = Bun.spawnSync([process.execPath, probe.pathname, mode, issueFailure], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  });
  const stdout = child.stdout.toString();
  const line = stdout
    .trim()
    .split('\n')
    .filter(row => row.startsWith('{'))
    .at(-1);
  if (!line) {
    throw new Error(
      `auth probe produced no JSON (exit ${child.exitCode}): ${child.stderr.toString()}\n${stdout}`
    );
  }
  return JSON.parse(line) as AuthProbeResult;
}

describe('reconcile scheduler wait', () => {
  test('a classified skip extends the interval to retryAfterMs', () => {
    expect(
      reconcileSchedulerWaitMs(30_000, {
        scanned: 0,
        closed: 0,
        skipped: true,
        retryAfterMs: 900_000,
      })
    ).toBe(900_000);
  });

  test('a shorter deadline does not retry before the normal interval', () => {
    expect(
      reconcileSchedulerWaitMs(30_000, { scanned: 0, closed: 0, skipped: true, retryAfterMs: 5_000 })
    ).toBe(30_000);
  });

  test('auth and transport skips keep the normal interval', () => {
    expect(reconcileSchedulerWaitMs(30_000, { scanned: 0, closed: 0, skipped: true })).toBe(30_000);
    expect(reconcileSchedulerWaitMs(30_000, undefined)).toBe(30_000);
  });
});

describe('reconcile default client auth', () => {
  test('App and PAT configured: client uses App auth and logs identity app', () => {
    const result = runAuthProbe('app-and-pat');
    expect(result.ok).toBe(true);
    expect(result.missingCredentials).toBe(false);
    expect(result.constructions.length).toBeGreaterThan(0);
    expect(result.constructions[0]).toMatchObject({
      hasAuthStrategy: true,
      authStrategyName: 'createAppAuth',
      appId: '4574893',
      installationId: '153295654',
      authIsString: false,
    });
    expect(result.constructions.some(item => item.authIsString)).toBe(false);
    expect(result.logs.some(entry => entry.identity === 'app')).toBe(true);
  });

  test('App vars absent and PAT present: client falls back to PAT and logs identity pat', () => {
    const result = runAuthProbe('pat-only');
    expect(result.ok).toBe(true);
    expect(result.missingCredentials).toBe(false);
    expect(result.constructions[0]).toMatchObject({
      hasAuthStrategy: false,
      authIsString: true,
    });
    expect(result.logs.some(entry => entry.identity === 'pat')).toBe(true);
  });

  test('App configured with no PAT: default deps construct a client instead of the missing-credentials stub', () => {
    const result = runAuthProbe('app-only');
    expect(result.ok).toBe(true);
    expect(result.missingCredentials).toBe(false);
    expect(result.constructions.length).toBeGreaterThan(0);
    expect(result.constructions[0]?.hasAuthStrategy).toBe(true);
    expect(result.logs.some(entry => entry.identity === 'app')).toBe(true);
  });

  test('App Issues-permission 403 falls back to the configured PAT for comment, label, and close', () => {
    const result = runAuthProbe('issue-mutations', 'permission');
    expect(result.ok).toBe(true);
    expect(result.constructions.some(item => item.hasAuthStrategy)).toBe(true);
    expect(result.constructions.some(item => item.authIsString)).toBe(true);
    const calls = result.issueCalls ?? [];
    expect(calls.filter(call => call.authIsString).map(call => call.operation)).toEqual([
      'createComment',
      'addLabels',
      'update',
    ]);
    expect(result.logs.some(entry => entry.identity === 'pat')).toBe(true);
  });

  test('a classified rate limit on an issue mutation does not fall back to the PAT', () => {
    const result = runAuthProbe('issue-mutations', 'rate-limit');
    expect(result.ok).toBe(false);
    expect(result.constructions.some(item => item.authIsString)).toBe(false);
    expect(result.issueCalls ?? []).toEqual([
      { operation: 'createComment', authIsString: false },
    ]);
  });
});
