import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { unlinkSync } from 'fs';
import { join } from 'path';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { ConversationLockManager } from '@archon/core';
import type { WebAdapter } from '../adapters/web';
import { SqliteAdapter } from '@archon/core/db/adapters/sqlite';
import { createAuthenticatedMessage, registerWorker } from '@archon/core/db/dispatch';
import { validationErrorHook } from './openapi-defaults';
import { mockAllWorkflowModules } from '../test/workflow-mock-factories';

delete process.env.ARCHON_OPERATOR_ACCESS_HOSTS;
delete process.env.ARCHON_OPERATOR_EMAILS;

let db: SqliteAdapter;
let currentDbPath = '';

import * as realConnection from '@archon/core/db/connection';

mock.module('@archon/core/db/connection', () => ({
  ...realConnection,
  getDatabase: () => db,
}));

mock.module('@archon/core', () => ({
  handleMessage: mock(async () => {}),
  getDatabaseType: () => 'sqlite',
  loadConfig: mock(async () => ({})),
  toSafeConfig: mock(() => ({})),
  updateGlobalConfig: mock(async () => ({})),
  cloneRepository: mock(async () => ({ codebaseId: 'x', alreadyExisted: false })),
  registerRepository: mock(async () => ({ codebaseId: 'x', alreadyExisted: false })),
  ConversationNotFoundError: class ConversationNotFoundError extends Error {},
  generateAndSetTitle: mock(async () => {}),
}));

mock.module('@archon/paths', () => ({
  createLogger: () => ({
    fatal: mock(() => undefined),
    error: mock(() => undefined),
    warn: mock(() => undefined),
    info: mock(() => undefined),
    debug: mock(() => undefined),
    trace: mock(() => undefined),
    child: mock(function (this: unknown) {
      return this;
    }),
    bindings: mock(() => ({ module: 'test' })),
    isLevelEnabled: mock(() => true),
    level: 'info',
  }),
  getWorkflowFolderSearchPaths: mock(() => ['.archon/workflows']),
  getCommandFolderSearchPaths: mock(() => ['.archon/commands']),
  getDefaultCommandsPath: mock(() => '/tmp/.archon-test-nonexistent/commands/defaults'),
  getDefaultWorkflowsPath: mock(() => '/tmp/.archon-test-nonexistent/workflows/defaults'),
  getArchonWorkspacesPath: () => '/tmp/.archon/workspaces',
  getArchonHome: () => '/tmp/.archon',
  getRunArtifactsPath: () => '/tmp/.archon/artifacts',
  isDocker: () => false,
  checkForUpdate: mock(async () => null),
  BUNDLED_IS_BINARY: false,
  BUNDLED_VERSION: 'test',
}));

mockAllWorkflowModules();

mock.module('@archon/git', () => ({
  removeWorktree: mock(async () => {}),
  toRepoPath: (p: string) => p,
  toWorktreePath: (p: string) => p,
}));

for (const moduleName of [
  '@archon/core/db/conversations',
  '@archon/core/db/codebases',
  '@archon/core/db/env-vars',
  '@archon/core/db/isolation-environments',
  '@archon/core/db/workflows',
  '@archon/core/db/workflow-events',
  '@archon/core/db/messages',
  '@archon/core/utils/commands',
]) {
  mock.module(moduleName, () => ({
    listConversations: mock(async () => []),
    findConversationByPlatformId: mock(async () => null),
    getOrCreateConversation: mock(async () => null),
    softDeleteConversation: mock(async () => {}),
    updateConversationTitle: mock(async () => {}),
    getConversationById: mock(async () => null),
    listCodebases: mock(async () => []),
    getCodebase: mock(async () => null),
    deleteCodebase: mock(async () => {}),
    listEnvVars: mock(async () => []),
    setEnvVar: mock(async () => null),
    deleteEnvVar: mock(async () => false),
    listByCodebase: mock(async () => []),
    updateStatus: mock(async () => {}),
    listWorkflowRuns: mock(async () => []),
    listDashboardRuns: mock(async () => ({
      runs: [],
      total: 0,
      counts: { all: 0, running: 0, completed: 0, failed: 0, cancelled: 0, pending: 0 },
    })),
    getWorkflowRun: mock(async () => null),
    cancelWorkflowRun: mock(async () => {}),
    getWorkflowRunByWorkerPlatformId: mock(async () => null),
    getCauldronDrainState: mock(async () => ({
      mode: 'normal',
      activeLeaseCount: 0,
      activeRunCount: 0,
      activeRunIds: [],
      drained: false,
      updatedAt: null,
    })),
    listWorkflowEvents: mock(async () => []),
    addMessage: mock(async () => null),
    listMessages: mock(async () => []),
    findMarkdownFilesRecursive: mock(async () => []),
  }));
}

import { registerApiRoutes } from './api';
import { createRealIngestDeps, reviewSubjectKey } from '@archon/overseer/pr-review-wiring';
import { isAutoRereviewReason, reviewCorrelationId } from '@archon/overseer/pr-review-ingest';
import {
  setPrReviewOperatorClock,
  setResolveCurrentHead,
} from '@archon/overseer/pr-review-operator';

const TOKEN = 'secret-token';
const OWNER = 'thinmansoftware';
const REPO = 'bdc-harness';
const PR_NUMBER = 806;
const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const HEAD_C = 'c'.repeat(40);
const HEAD_D = 'd'.repeat(40);
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const TWENTY_FIVE_HOURS_MS = 25 * 60 * 60 * 1000;
const ORPHAN_RECIPIENT = 'overseer-review-route';

function cleanupDb(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(path + suffix);
    } catch {
      /* file may not exist */
    }
  }
}

function makeApp(token?: string): OpenAPIHono {
  if (token) process.env.ARCHON_OPERATOR_TOKEN = token;
  else delete process.env.ARCHON_OPERATOR_TOKEN;
  const app = new OpenAPIHono({ defaultHook: validationErrorHook });
  registerApiRoutes(
    app,
    {
      setConversationDbId: mock(() => {}),
      emitSSE: mock(async () => {}),
      emitLockEvent: mock(async () => {}),
      registerStream: mock(() => {}),
      removeStream: mock(() => {}),
    } as unknown as WebAdapter,
    {
      acquireLock: mock(async (_id: string, fn: () => Promise<void>) => {
        await fn();
        return { status: 'started' };
      }),
      getStats: mock(() => ({ active: 0, queued: 0 })),
    } as unknown as ConversationLockManager
  );
  return app;
}

function authHeaders(): Record<string, string> {
  return { 'x-archon-operator-token': TOKEN, 'Content-Type': 'application/json' };
}

function ingestDeps(): ReturnType<typeof createRealIngestDeps> {
  return createRealIngestDeps({
    webhookSecret: 'operator-pr-review-test',
    reviewerIdentity: 'thinman-overseer[bot]',
  });
}

async function enqueueReview(input: {
  headSha: string;
  repeatReason: string | null;
  prNumber?: number;
}): Promise<{ messageId: string }> {
  const prNumber = input.prNumber ?? PR_NUMBER;
  return ingestDeps().enqueueReviewWork({
    correlationId: reviewCorrelationId({
      owner: OWNER,
      repo: REPO,
      prNumber,
      headSha: input.headSha,
    }),
    idempotencyKey: reviewCorrelationId({
      owner: OWNER,
      repo: REPO,
      prNumber,
      headSha: input.headSha,
    }),
    owner: OWNER,
    repo: REPO,
    prNumber,
    headSha: input.headSha,
    baseRef: 'dev',
    author: 'alice',
    repeatReason: input.repeatReason,
    headCiGreen: false,
  });
}

async function markDone(messageId: string): Promise<void> {
  await db.query(
    `UPDATE agent_dispatch_messages SET status = 'done', completed_at = created_at WHERE id = $1`,
    [messageId]
  );
}

async function recordVerdict(input: {
  messageId: string;
  headSha: string;
  disposition: 'approved' | 'changes_requested';
}): Promise<void> {
  await createAuthenticatedMessage(
    { kind: 'system', sender: 'overseer' },
    {
      correlation_id: reviewCorrelationId({
        owner: OWNER,
        repo: REPO,
        prNumber: PR_NUMBER,
        headSha: input.headSha,
      }),
      idempotency_key: `pr-review-submit-receipt:${input.messageId}:${input.disposition}`,
      task_type: 'run_report',
      recipient: 'operator',
      subject_key: reviewSubjectKey(OWNER, REPO, PR_NUMBER),
      repeat_reason: `review_verdict_receipt:${input.messageId}:${input.disposition}`,
      body: JSON.stringify({
        kind: 'pr_review_submit_receipt',
        messageId: input.messageId,
        disposition: input.disposition,
        owner: OWNER,
        repo: REPO,
        prNumber: PR_NUMBER,
        headSha: input.headSha,
      }),
    }
  );
}

function statusPath(prNumber = PR_NUMBER): string {
  return `/api/overseer/pr-review/status?owner=${OWNER}&repo=${REPO}&prNumber=${prNumber}`;
}

function stubCurrentHead(currentHead: string, extra?: { baseRef?: string; author?: string }): void {
  setResolveCurrentHead(async () => ({
    currentHead,
    baseRef: extra?.baseRef ?? 'dev',
    author: extra?.author ?? 'alice',
  }));
}

async function countRunReviewRows(): Promise<number> {
  const result = await db.query<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM agent_dispatch_messages WHERE task_type = 'run_review'`
  );
  return Number(result.rows[0]?.n ?? 0);
}

async function seedOrphanQueue(nowMs: number): Promise<void> {
  const created = await createAuthenticatedMessage(
    { kind: 'system', sender: 'overseer' },
    {
      correlation_id: `orphan:${ORPHAN_RECIPIENT}`,
      idempotency_key: `orphan:${ORPHAN_RECIPIENT}`,
      task_type: 'run_review',
      recipient: ORPHAN_RECIPIENT,
      body: JSON.stringify({ kind: 'orphan-fixture' }),
    }
  );
  await db.query(`UPDATE agent_dispatch_messages SET created_at = $1 WHERE id = $2`, [
    new Date(nowMs - TWENTY_FIVE_HOURS_MS).toISOString(),
    created.id,
  ]);
}

async function seedCoveringWorker(heartbeatAtMs: number): Promise<void> {
  await registerWorker({
    worker_id: ORPHAN_RECIPIENT,
    host: 'orphan-test',
    capabilities: { principal: ORPHAN_RECIPIENT },
    max_concurrency: 1,
  });
  await db.query(
    `UPDATE agent_dispatch_workers
     SET status = 'available', last_heartbeat_at = $1
     WHERE worker_id = $2`,
    [new Date(heartbeatAtMs).toISOString(), ORPHAN_RECIPIENT]
  );
}

describe('overseer PR review operator routes', () => {
  beforeEach(() => {
    process.env.BUN_ENV = 'test';
    currentDbPath = join(
      import.meta.dir,
      `.test-api-overseer-pr-review-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    );
    db = new SqliteAdapter(currentDbPath);
    stubCurrentHead(HEAD_C);
  });

  afterEach(async () => {
    setResolveCurrentHead(undefined);
    setPrReviewOperatorClock(undefined);
    delete process.env.ARCHON_OPERATOR_TOKEN;
    await db.close();
    cleanupDb(currentDbPath);
  });

  test('status on a moved head returns head_moved true and the prior judged sha', async () => {
    const first = await enqueueReview({ headSha: HEAD_A, repeatReason: null });
    await markDone(first.messageId);
    await recordVerdict({
      messageId: first.messageId,
      headSha: HEAD_A,
      disposition: 'changes_requested',
    });
    await enqueueReview({ headSha: HEAD_B, repeatReason: 'operator_request:moved' });

    const response = await makeApp(TOKEN).request(statusPath(), { headers: authHeaders() });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      head_moved: boolean;
      current_head: string | null;
      last_judged_head: string | null;
    };
    expect(body.head_moved).toBe(true);
    expect(body.current_head).toBe(HEAD_B);
    expect(body.last_judged_head).toBe(HEAD_A);
  });

  test('status on a cap-exhausted PR names the ceiling in why_no_review', async () => {
    await ingestDeps().recordReceipt({
      correlationId: reviewCorrelationId({
        owner: OWNER,
        repo: REPO,
        prNumber: PR_NUMBER,
        headSha: HEAD_A,
      }),
      deliveryId: 'cap-exhausted-1',
      owner: OWNER,
      repo: REPO,
      prNumber: PR_NUMBER,
      headSha: HEAD_A,
      disposition: 'blocked',
      reason: 'rereview_total_ceiling_reached:consecutive=0:total=10',
    });

    const response = await makeApp(TOKEN).request(statusPath(), { headers: authHeaders() });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { why_no_review: string };
    expect(body.why_no_review).toContain('rereview_total_ceiling_reached');
    expect(body.why_no_review.startsWith('blocked:')).toBe(true);
  });

  test('request at a subject with existing terminal rows succeeds', async () => {
    stubCurrentHead(HEAD_B);
    const first = await enqueueReview({ headSha: HEAD_A, repeatReason: null });
    await markDone(first.messageId);
    await recordVerdict({
      messageId: first.messageId,
      headSha: HEAD_A,
      disposition: 'changes_requested',
    });

    const response = await makeApp(TOKEN).request('/api/overseer/pr-review/request', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        owner: OWNER,
        repo: REPO,
        prNumber: PR_NUMBER,
        headSha: HEAD_B,
        reason: 'operator_rereview:repeat_reason_regression',
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; messageId: string };
    expect(body.ok).toBe(true);
    expect(typeof body.messageId).toBe('string');
    expect(body.messageId.length).toBeGreaterThan(0);
  });

  test('request twice at the same head returns the same message id', async () => {
    const app = makeApp(TOKEN);
    const payload = JSON.stringify({
      owner: OWNER,
      repo: REPO,
      prNumber: PR_NUMBER,
      headSha: HEAD_C,
      reason: 'operator_rereview:idempotent',
    });
    const first = await app.request('/api/overseer/pr-review/request', {
      method: 'POST',
      headers: authHeaders(),
      body: payload,
    });
    const second = await app.request('/api/overseer/pr-review/request', {
      method: 'POST',
      headers: authHeaders(),
      body: payload,
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstBody = (await first.json()) as { messageId: string; alreadyExisted: boolean };
    const secondBody = (await second.json()) as { messageId: string; alreadyExisted: boolean };
    expect(firstBody.alreadyExisted).toBe(false);
    expect(secondBody.alreadyExisted).toBe(true);
    expect(secondBody.messageId).toBe(firstBody.messageId);
  });

  test('the same commit spelled in uppercase hex is the same request (canonical head)', async () => {
    const app = makeApp(TOKEN);
    const lower = await app.request('/api/overseer/pr-review/request', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        owner: OWNER,
        repo: REPO,
        prNumber: PR_NUMBER,
        headSha: HEAD_C,
        reason: 'operator_rereview:case',
      }),
    });
    const upper = await app.request('/api/overseer/pr-review/request', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        owner: OWNER,
        repo: REPO,
        prNumber: PR_NUMBER,
        headSha: HEAD_C.toUpperCase(),
        reason: 'operator_rereview:case',
      }),
    });
    expect(lower.status).toBe(200);
    expect(upper.status).toBe(200);
    const lowerBody = (await lower.json()) as {
      messageId: string;
      alreadyExisted: boolean;
      correlationId: string;
    };
    const upperBody = (await upper.json()) as {
      messageId: string;
      alreadyExisted: boolean;
      correlationId: string;
    };
    expect(upperBody.alreadyExisted).toBe(true);
    expect(upperBody.messageId).toBe(lowerBody.messageId);
    expect(upperBody.correlationId).toBe(lowerBody.correlationId);
    expect(upperBody.correlationId.endsWith(`@${HEAD_C}`)).toBe(true);
    const queued = await app.request('/api/overseer/pr-review/queue', { headers: authHeaders() });
    const body = (await queued.json()) as { items: { headSha?: string | null }[] };
    expect(body.items).toHaveLength(1);
  });

  test('the operator request repeat_reason is not an auto re-review reason', async () => {
    const app = makeApp(TOKEN);
    const posted = await app.request('/api/overseer/pr-review/request', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        owner: OWNER,
        repo: REPO,
        prNumber: PR_NUMBER,
        headSha: HEAD_C,
        reason: 'operator_rereview:not-auto',
      }),
    });
    expect(posted.status).toBe(200);
    const queued = await app.request('/api/overseer/pr-review/queue', { headers: authHeaders() });
    expect(queued.status).toBe(200);
    const body = (await queued.json()) as { items: { repeat_reason: string | null }[] };
    expect(body.items).toHaveLength(1);
    expect(isAutoRereviewReason(body.items[0]?.repeat_reason)).toBe(false);
    expect(body.items[0]?.repeat_reason?.startsWith('operator_request:')).toBe(true);
  });

  test('request without an operator token is refused', async () => {
    const response = await makeApp(TOKEN).request('/api/overseer/pr-review/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        owner: OWNER,
        repo: REPO,
        prNumber: PR_NUMBER,
        headSha: HEAD_C,
        reason: 'no-token',
      }),
    });
    expect(response.status).toBe(401);
  });

  test('queue lists a queued item with its age', async () => {
    const enqueued = await enqueueReview({ headSha: HEAD_A, repeatReason: null });
    const response = await makeApp(TOKEN).request('/api/overseer/pr-review/queue', {
      headers: authHeaders(),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: Array<{
        id: string;
        status: string;
        age_seconds: number;
        owner: string | null;
        repo: string | null;
        prNumber: number | null;
        headSha: string | null;
      }>;
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.id).toBe(enqueued.messageId);
    expect(body.items[0]?.status).toBe('queued');
    expect(body.items[0]?.age_seconds).toBeGreaterThanOrEqual(0);
    expect(body.items[0]?.owner).toBe(OWNER);
    expect(body.items[0]?.repo).toBe(REPO);
    expect(body.items[0]?.prNumber).toBe(PR_NUMBER);
    expect(body.items[0]?.headSha).toBe(HEAD_A);
  });

  test('request at a mismatched head returns 409 and enqueues nothing', async () => {
    stubCurrentHead(HEAD_A);
    const response = await makeApp(TOKEN).request('/api/overseer/pr-review/request', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        owner: OWNER,
        repo: REPO,
        prNumber: PR_NUMBER,
        headSha: HEAD_B,
        reason: 'stale-head',
      }),
    });
    expect(response.status).toBe(409);
    const body = (await response.json()) as {
      ok: boolean;
      error: string;
      currentHead: string;
    };
    expect(body.ok).toBe(false);
    expect(body.error).toBe('head_not_current');
    expect(body.currentHead).toBe(HEAD_A);
    expect(await countRunReviewRows()).toBe(0);
  });

  test('request at the current head enqueues one row with baseRef and author', async () => {
    stubCurrentHead(HEAD_D, { baseRef: 'main', author: 'octocat' });
    const response = await makeApp(TOKEN).request('/api/overseer/pr-review/request', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        owner: OWNER,
        repo: REPO,
        prNumber: PR_NUMBER,
        headSha: HEAD_D,
        reason: 'exact-head',
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; messageId: string };
    expect(body.ok).toBe(true);
    expect(await countRunReviewRows()).toBe(1);
    const rows = await db.query<{ body: string }>(
      `SELECT body FROM agent_dispatch_messages WHERE task_type = 'run_review'`
    );
    const queued = JSON.parse(rows.rows[0]?.body ?? '{}') as {
      baseRef: string;
      author: string;
      headCiGreen: boolean;
      headSha: string;
    };
    expect(queued.headSha).toBe(HEAD_D);
    expect(queued.baseRef).toBe('main');
    expect(queued.author).toBe('octocat');
    expect(queued.headCiGreen).toBe(false);
  });

  test('request when current-head lookup throws returns 502 and enqueues nothing', async () => {
    setResolveCurrentHead(async () => {
      throw new Error('github unavailable');
    });
    const response = await makeApp(TOKEN).request('/api/overseer/pr-review/request', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        owner: OWNER,
        repo: REPO,
        prNumber: PR_NUMBER,
        headSha: HEAD_C,
        reason: 'lookup-failed',
      }),
    });
    expect(response.status).toBe(502);
    const body = (await response.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe('head_lookup_failed');
    expect(await countRunReviewRows()).toBe(0);
  });

  test('an available worker with a 2h-stale heartbeat does not suppress an orphan', async () => {
    const wall = Date.now();
    const nowMs = wall + TWO_HOURS_MS;
    setPrReviewOperatorClock({ now: () => nowMs });
    await seedOrphanQueue(nowMs);
    await seedCoveringWorker(wall);
    const response = await makeApp(TOKEN).request('/api/overseer/pr-review/queue', {
      headers: authHeaders(),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      orphaned: Array<{ recipient: string; count: number }>;
    };
    const hit = body.orphaned.find(row => row.recipient === ORPHAN_RECIPIENT);
    expect(hit).toBeDefined();
    expect(hit?.count).toBe(1);
  });

  test('an available worker with a fresh heartbeat suppresses an orphan', async () => {
    const nowMs = Date.now();
    setPrReviewOperatorClock({ now: () => nowMs });
    await seedOrphanQueue(nowMs);
    await seedCoveringWorker(nowMs);
    const response = await makeApp(TOKEN).request('/api/overseer/pr-review/queue', {
      headers: authHeaders(),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      orphaned: Array<{ recipient: string }>;
    };
    expect(body.orphaned.some(row => row.recipient === ORPHAN_RECIPIENT)).toBe(false);
  });
});
