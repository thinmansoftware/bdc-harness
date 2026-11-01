/**
 * Startup redelivery and the review-gap sweeper.
 *
 * Real SQLite, fake GitHub. No mock.module: every external effect is an
 * argument. Receipts are real agent_dispatch_messages rows.
 */
import { createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, spyOn, test as bunTest } from 'bun:test';
import { SqliteAdapter } from '@archon/core/db/adapters/sqlite';
import { removeTempDirWithRetry } from '@archon/core/test/temp-dir';
import { discoverMergeCandidates } from '../merge-candidate-discovery';
import { reviewCorrelationId, type IngestRequest } from '../pr-review-ingest';
import { reviewSubjectKey, type ReviewRouteConfig } from '../pr-review-wiring';
import { hasIngestReceiptForHead, hasOverseerReviewForHead } from '../review-ingest-receipts';
import {
  readHeadPushedAt,
  runReviewGapSweep,
  type ReviewGapPull,
  type ReviewGapSweepDeps,
} from '../review-gap-sweeper';
import { runWebhookRedeliveryCatchup } from '../review-webhook-catchup';
import type { DiscoveredPullRequest } from '../types';
import { runWithBoundDatabase } from './isolated-database';

const BEARER = 'Bearer SENTINEL-DO-NOT-LOG';
const SECRET = 'secret-do-not-log';
const NOW = Date.parse('2026-11-01T21:00:00.000Z');
const MINUTE = 60 * 1000;
const CONFIG: ReviewRouteConfig = {
  webhookSecret: SECRET,
  reviewerIdentity: 'thinman-overseer[bot]',
};

let db: SqliteAdapter;
let home = '';

function test(name: string, fn: () => Promise<void>): void {
  bunTest(name, () => {
    if (!db) throw new Error('sqlite adapter was not created');
    return runWithBoundDatabase(db, () => fn());
  });
}

interface LogLine {
  data: Record<string, unknown>;
  message: string;
}

function captureLog(): { lines: LogLine[]; log: ReviewGapSweepDeps['log'] } {
  const lines: LogLine[] = [];
  const log: NonNullable<ReviewGapSweepDeps['log']> = {
    info(data, message) {
      lines.push({ data, message });
    },
    warn(data, message) {
      lines.push({ data, message });
    },
    error(data, message) {
      lines.push({ data, message });
    },
  };
  return { lines, log };
}

function sign(body: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

interface RecordedCall {
  url: string;
  method: string;
  authorization: string | null;
}

function recordedFetch(handler: (url: URL, method: string) => Response): {
  calls: RecordedCall[];
  fetch: typeof fetch;
} {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(requestUrl(input));
    const method = init?.method ?? 'GET';
    const authorization = new Headers(init?.headers).get('authorization');
    calls.push({ url: url.toString(), method, authorization });
    return handler(url, method);
  }) as typeof fetch;
  return { calls, fetch: fetchImpl };
}

async function insertIngestReceipt(input: {
  id: string;
  guid: string;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  createdAt: string;
}): Promise<void> {
  await db.query(
    `INSERT INTO agent_dispatch_messages (
       id, correlation_id, idempotency_key, task_type, sender, recipient, body, status, seq, created_at
     ) VALUES ($1, $2, $3, 'run_report', 'overseer', 'pr-review-log', $4, 'done', $5, $6)`,
    [
      input.id,
      reviewCorrelationId({
        owner: input.owner,
        repo: input.repo,
        prNumber: input.prNumber,
        headSha: input.headSha,
      }),
      `pr-review-receipt:${input.guid}:queued`,
      JSON.stringify({
        kind: 'pr_review_ingest_receipt',
        deliveryId: input.guid,
        owner: input.owner,
        repo: input.repo,
        prNumber: input.prNumber,
        headSha: input.headSha,
        disposition: 'queued',
      }),
      1,
      input.createdAt,
    ]
  );
}

async function insertSubmitReceipt(input: {
  id: string;
  prNumber: number;
  headSha: string;
  disposition: string;
  reason?: string;
  event?: string;
  seq: number;
}): Promise<void> {
  const owner = 'thinmansoftware';
  const repo = 'bdc-xo';
  await db.query(
    `INSERT INTO agent_dispatch_messages (
       id, correlation_id, idempotency_key, task_type, sender, recipient, subject_key, body, status, seq, created_at
     ) VALUES ($1, $2, $3, 'run_report', 'overseer', 'pr-review-log', $4, $5, 'done', $6, $7)`,
    [
      input.id,
      `pr-review:${owner}/${repo}#${input.prNumber}@${input.headSha}`,
      `pr-review-submit-receipt:${input.id}:${input.disposition}`,
      reviewSubjectKey(owner, repo, input.prNumber),
      JSON.stringify({
        kind: 'pr_review_submit_receipt',
        owner,
        repo,
        prNumber: input.prNumber,
        headSha: input.headSha,
        disposition: input.disposition,
        ...(input.reason ? { reason: input.reason } : {}),
        ...(input.event ? { event: input.event } : {}),
      }),
      input.seq,
      '2026-11-01T20:40:00.000Z',
    ]
  );
}

function gapPull(
  overrides: Partial<ReviewGapPull> & Pick<ReviewGapPull, 'prNumber' | 'headSha'>
): ReviewGapPull {
  return {
    owner: 'thinmansoftware',
    repo: 'bdc-xo',
    headRef: 'feature',
    baseRef: 'main',
    authorLogin: 'spec-author',
    draft: false,
    state: 'open',
    ...overrides,
  };
}

function discovered(
  overrides: Partial<DiscoveredPullRequest> & { prNumber: number }
): DiscoveredPullRequest {
  return {
    owner: 'thinmansoftware',
    repo: 'bdc-xo',
    title: `pull request ${overrides.prNumber}`,
    state: 'open',
    draft: false,
    baseRef: 'main',
    headRef: `feat/${overrides.prNumber}`,
    headSha: `${overrides.prNumber}`.padStart(40, 'a'),
    reviewDecision: 'REVIEW_REQUIRED',
    ...overrides,
  };
}

describe('review webhook restart catch-up', () => {
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'archon-review-catchup-'));
    db = new SqliteAdapter(join(home, 'archon.db'));
  });

  afterEach(async () => {
    await db.close();
    removeTempDirWithRetry(home);
  });

  test('a failed opened delivery is redelivered once at startup', async () => {
    const { lines, log } = captureLog();
    const { calls, fetch } = recordedFetch((url, method) => {
      if (method === 'POST' && url.pathname.endsWith('/attempts')) {
        return new Response('{}', { status: 202 });
      }
      if (/\/app\/hook\/deliveries\/\d+$/.test(url.pathname)) {
        return Response.json({
          request: { payload: { number: 4184, pull_request: { number: 4184 } } },
        });
      }
      return Response.json([
        {
          id: 4242,
          guid: 'guid-failed-opened',
          delivered_at: '2026-11-01T20:55:00.000Z',
          status: 'failed',
          event: 'pull_request',
          action: 'opened',
        },
      ]);
    });

    await runWebhookRedeliveryCatchup(CONFIG, {
      fetch,
      authorizationHeader: BEARER,
      containerStartedAt: Date.parse('2026-11-01T20:54:21.000Z'),
      now: () => Date.parse('2026-11-01T20:56:59.000Z'),
      log,
    });

    const attempts = calls.filter(call => call.method === 'POST');
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.url).toBe('https://api.github.com/app/hook/deliveries/4242/attempts');
    expect(attempts[0]?.authorization).toBe(BEARER);
    const redelivered = lines.filter(line => line.message === 'webhook_redelivered');
    expect(redelivered).toHaveLength(1);
    expect(redelivered[0]?.data).toMatchObject({
      deliveryId: 4242,
      guid: 'guid-failed-opened',
      prNumber: 4184,
    });
    const dumped = JSON.stringify(lines);
    expect(dumped).not.toContain('SENTINEL');
    expect(dumped).not.toContain(SECRET);
  });

  test('OK or already-ingested deliveries are not redelivered', async () => {
    await insertIngestReceipt({
      id: 'receipt-ok',
      guid: 'ok-guid-4184',
      owner: 'thinmansoftware',
      repo: 'bdc-xo',
      prNumber: 4184,
      headSha: 'c'.repeat(40),
      createdAt: '2026-11-01T21:00:00.000Z',
    });
    const { lines, log } = captureLog();
    const { calls, fetch } = recordedFetch(() =>
      Response.json([
        {
          id: 5001,
          guid: 'ok-guid-4184',
          delivered_at: '2026-11-01T20:55:00.000Z',
          status: 'OK',
          event: 'pull_request',
          action: 'opened',
        },
        {
          id: 5000,
          guid: 'old-guid-1',
          delivered_at: '2026-11-01T20:40:00.000Z',
          status: 'failed',
          event: 'pull_request',
          action: 'opened',
        },
      ])
    );

    await runWebhookRedeliveryCatchup(CONFIG, {
      fetch,
      authorizationHeader: BEARER,
      containerStartedAt: Date.parse('2026-11-01T18:00:00.000Z'),
      now: () => NOW,
      log,
    });

    expect(calls.filter(call => call.method === 'POST')).toHaveLength(0);
    expect(calls.some(call => call.url.includes('/app/hook/deliveries?'))).toBe(true);
    expect(lines.some(line => line.message === 'webhook_catchup_skipped')).toBe(false);
    expect(JSON.stringify(lines)).not.toContain('SENTINEL');
  });

  test('a delivery during a long startup is inside the process-start window', async () => {
    const now = Date.parse('2026-11-01T21:00:00.000Z');
    const uptime = spyOn(process, 'uptime').mockReturnValue(11 * 60);
    const deliveredAt = new Date(now - 10 * MINUTE - 30 * 1000).toISOString();
    const { lines, log } = captureLog();
    const { calls, fetch } = recordedFetch((url, method) => {
      if (method === 'POST' && url.pathname.endsWith('/attempts')) {
        return new Response('{}', { status: 202 });
      }
      if (/\/app\/hook\/deliveries\/\d+$/.test(url.pathname)) {
        return Response.json({ request: { payload: { number: 4184 } } });
      }
      return Response.json([
        {
          id: 4243,
          guid: 'guid-during-startup',
          delivered_at: deliveredAt,
          status: 'failed',
          event: 'pull_request',
          action: 'opened',
        },
      ]);
    });

    try {
      await runWebhookRedeliveryCatchup(CONFIG, {
        fetch,
        authorizationHeader: BEARER,
        now: () => now,
        log,
      });
    } finally {
      uptime.mockRestore();
    }

    expect(calls.filter(call => call.method === 'POST')).toHaveLength(1);
    expect(lines.filter(line => line.message === 'webhook_redelivered')).toHaveLength(1);
  });

  test('the sweeper requests a review for an unreviewed head after 10 minutes', async () => {
    const headSha = 'e'.repeat(40);
    const pull = gapPull({ prNumber: 4184, headSha });
    const { lines, log } = captureLog();
    const ingestCalls: IngestRequest[] = [];
    let updatedAfterMs = 0;
    const deps: ReviewGapSweepDeps = {
      webhookSecret: SECRET,
      reviewerIdentity: CONFIG.reviewerIdentity,
      listRepos: () => ['thinmansoftware/bdc-xo'],
      listRecentPulls: async input => {
        updatedAfterMs = input.updatedAfterMs;
        return [pull];
      },
      getHeadPushedAt: async () => new Date(NOW - 11 * MINUTE).toISOString(),
      ingest: async request => {
        ingestCalls.push(request);
      },
      log,
    };

    await runReviewGapSweep(deps, NOW);

    expect(updatedAfterMs).toBe(NOW - 2 * 60 * 60 * 1000);
    expect(ingestCalls).toHaveLength(1);
    const request = ingestCalls[0];
    if (!request) throw new Error('missing ingest request');
    expect(request.eventType).toBe('pull_request');
    expect(request.deliveryId).toBe(`review-gap:thinmansoftware/bdc-xo#4184@${headSha}`);
    expect(request.signature).toBe(sign(request.rawBody, SECRET));
    const body = JSON.parse(request.rawBody) as {
      action?: string;
      number?: number;
      pull_request?: { number?: number; head?: { sha?: string } };
      repository?: { name?: string; owner?: { login?: string } };
    };
    expect(body.action).toBe('synchronize');
    expect(body.number).toBe(4184);
    expect(body.pull_request?.number).toBe(4184);
    expect(body.pull_request?.head?.sha).toBe(headSha);
    expect(body.repository?.name).toBe('bdc-xo');
    expect(body.repository?.owner?.login).toBe('thinmansoftware');
    const swept = lines.filter(line => line.message === 'review_gap_swept');
    expect(swept).toHaveLength(1);
    expect(swept[0]?.data).toMatchObject({
      owner: 'thinmansoftware',
      repository: 'bdc-xo',
      prNumber: 4184,
      headSha,
    });
    expect(JSON.stringify(lines)).not.toContain(SECRET);
  });

  test('the sweeper leaves fresh or covered heads alone', async () => {
    const freshSha = 'a'.repeat(40);
    const coveredSha = 'b'.repeat(40);
    await insertIngestReceipt({
      id: 'receipt-covered',
      guid: 'covered-guid',
      owner: 'thinmansoftware',
      repo: 'bdc-xo',
      prNumber: 11,
      headSha: coveredSha,
      createdAt: '2026-11-01T20:40:00.000Z',
    });
    const receiptResults: boolean[] = [];
    const ingestCalls: IngestRequest[] = [];
    const { lines, log } = captureLog();
    const deps: ReviewGapSweepDeps = {
      webhookSecret: SECRET,
      reviewerIdentity: CONFIG.reviewerIdentity,
      listRepos: () => ['thinmansoftware/bdc-xo'],
      listRecentPulls: async () => [
        gapPull({ prNumber: 10, headSha: freshSha }),
        gapPull({ prNumber: 11, headSha: coveredSha }),
      ],
      getHeadPushedAt: async input =>
        new Date(NOW - (input.sha === freshSha ? 9 : 11) * MINUTE).toISOString(),
      hasIngestReceiptForHead: async (owner, repo, prNumber, headSha) => {
        const found = await hasIngestReceiptForHead(owner, repo, prNumber, headSha);
        receiptResults.push(found);
        return found;
      },
      ingest: async request => {
        ingestCalls.push(request);
      },
      log,
    };

    await runReviewGapSweep(deps, NOW);

    expect(receiptResults).toEqual([true]);
    expect(ingestCalls).toHaveLength(0);
    expect(lines.some(line => line.message === 'review_gap_swept')).toBe(false);
  });

  test('a nine-minute-old push of an older commit is not swept', async () => {
    const headSha = 'f'.repeat(40);
    const pushedDate = new Date(NOW - 9 * MINUTE).toISOString();
    const committedDate = new Date(NOW - 120 * MINUTE).toISOString();
    let query = '';
    const stamp = await readHeadPushedAt(
      {
        graphql: async (text: string) => {
          query = text;
          return {
            repository: {
              pullRequest: {
                headRefOid: headSha,
                commits: {
                  nodes: [{ commit: { oid: headSha, committedDate, pushedDate } }],
                },
              },
            },
          };
        },
      },
      { owner: 'thinmansoftware', repo: 'bdc-xo', sha: headSha, prNumber: 4184 }
    );
    expect(stamp).toBe(pushedDate);
    expect(query).toContain('pushedDate');
    expect(query).not.toContain('committedDate');

    const ingestCalls: IngestRequest[] = [];
    const deps: ReviewGapSweepDeps = {
      webhookSecret: SECRET,
      reviewerIdentity: CONFIG.reviewerIdentity,
      listRepos: () => ['thinmansoftware/bdc-xo'],
      listRecentPulls: async () => [gapPull({ prNumber: 4184, headSha })],
      getHeadPushedAt: async () => stamp,
      ingest: async request => {
        ingestCalls.push(request);
      },
    };

    await runReviewGapSweep(deps, NOW);

    expect(ingestCalls).toHaveLength(0);
  });

  test('a failed submit receipt does not hide the head from the sweeper', async () => {
    const headSha = 'd'.repeat(40);
    await insertSubmitReceipt({
      id: 'sub-pending',
      prNumber: 4184,
      headSha,
      disposition: 'checks_pending',
      seq: 2,
    });
    await insertSubmitReceipt({
      id: 'sub-transport',
      prNumber: 4184,
      headSha,
      disposition: 'transport_error',
      seq: 3,
    });
    await insertSubmitReceipt({
      id: 'sub-failed',
      prNumber: 4184,
      headSha,
      disposition: 'submission_failed',
      event: 'REQUEST_CHANGES',
      reason: 'github_review_transport_ambiguous',
      seq: 4,
    });
    await insertSubmitReceipt({
      id: 'sub-blocked-failed',
      prNumber: 4184,
      headSha,
      disposition: 'blocked_required_contexts_unavailable',
      reason: 'required_contexts_unavailable_blocked:comment_failed:boom',
      event: 'COMMENT',
      seq: 5,
    });

    expect(
      await hasOverseerReviewForHead(
        'thinmansoftware',
        'bdc-xo',
        4184,
        headSha,
        CONFIG.reviewerIdentity
      )
    ).toBe(false);

    const ingestCalls: IngestRequest[] = [];
    const deps: ReviewGapSweepDeps = {
      webhookSecret: SECRET,
      reviewerIdentity: CONFIG.reviewerIdentity,
      listRepos: () => ['thinmansoftware/bdc-xo'],
      listRecentPulls: async () => [gapPull({ prNumber: 4184, headSha })],
      getHeadPushedAt: async () => new Date(NOW - 11 * MINUTE).toISOString(),
      ingest: async request => {
        ingestCalls.push(request);
      },
    };

    await runReviewGapSweep(deps, NOW);

    expect(ingestCalls).toHaveLength(1);
  });

  test('a landed Overseer review keeps the sweeper off the head', async () => {
    const headSha = 'c'.repeat(40);
    await insertSubmitReceipt({
      id: 'sub-approved',
      prNumber: 4184,
      headSha,
      disposition: 'approved',
      event: 'APPROVE',
      seq: 2,
    });
    await insertSubmitReceipt({
      id: 'sub-blocked',
      prNumber: 12,
      headSha: 'b'.repeat(40),
      disposition: 'blocked_required_contexts_unavailable',
      reason: 'required_contexts_unavailable_blocked',
      event: 'COMMENT',
      seq: 3,
    });

    expect(
      await hasOverseerReviewForHead(
        'thinmansoftware',
        'bdc-xo',
        4184,
        headSha,
        CONFIG.reviewerIdentity
      )
    ).toBe(true);
    expect(
      await hasOverseerReviewForHead(
        'thinmansoftware',
        'bdc-xo',
        12,
        'b'.repeat(40),
        CONFIG.reviewerIdentity
      )
    ).toBe(true);

    const ingestCalls: IngestRequest[] = [];
    const deps: ReviewGapSweepDeps = {
      webhookSecret: SECRET,
      reviewerIdentity: CONFIG.reviewerIdentity,
      listRepos: () => ['thinmansoftware/bdc-xo'],
      listRecentPulls: async () => [gapPull({ prNumber: 4184, headSha })],
      getHeadPushedAt: async () => new Date(NOW - 11 * MINUTE).toISOString(),
      ingest: async request => {
        ingestCalls.push(request);
      },
    };

    await runReviewGapSweep(deps, NOW);

    expect(ingestCalls).toHaveLength(0);
  });

  test('discovery names the gap', async () => {
    const gap = discovered({ prNumber: 4184, reviewDecision: 'REVIEW_REQUIRED' });
    const draft = discovered({ prNumber: 4185, draft: true, reviewDecision: 'APPROVED' });
    const result = await discoverMergeCandidates(
      {
        listOpenPullRequests: async () => [gap, draft],
        findPullRequest: async () => {
          throw new Error('evidence_lookup_not_expected');
        },
      },
      {
        repos: [{ owner: 'thinmansoftware', repo: 'bdc-xo' }],
        watchedBases: ['main'],
        cursor: null,
        hasIngestReceiptForHead: candidate =>
          hasIngestReceiptForHead(
            candidate.owner,
            candidate.repo,
            candidate.prNumber,
            candidate.headSha
          ),
      }
    );

    const byNumber = new Map(result.exclusions.map(item => [item.prNumber, item.reason]));
    expect(byNumber.get(4184)).toBe('review_missing');
    expect(byNumber.get(4185)).toBe('draft');
    expect(result.exclusions.find(item => item.prNumber === 4184)?.detail).toBe(
      'current head has no ingest receipt'
    );
  });
});
