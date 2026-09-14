import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeDatabase, resetDatabase } from '@archon/core/db';
import { removeTempDirWithRetry } from '@archon/core/test/temp-dir';
import type { PriorReviewWork } from '@archon/overseer/pr-review-ingest';
import { deliverNeedsHumanToOperator } from './escalation-reaches-human-canary';
import { runPrReviewCanarySuite, writePrReviewCanaryArtifacts } from './pr-review-canary';

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const HEAD_C = 'c'.repeat(40);
const NOW = Date.parse('2026-09-14T12:00:00.000Z');
const SUBJECT = 'gh:thinmansoftware/bdc-harness#806';
const databases: Database[] = [];

function work(overrides: Partial<PriorReviewWork>): PriorReviewWork {
  return {
    messageId: 'review-1',
    headSha: HEAD_A,
    status: 'done',
    verdict: 'changes_requested',
    verdictId: 'verdict-1',
    isAutoRereview: false,
    headCiGreen: false,
    ...overrides,
  };
}

function fixture(): Database {
  const db = new Database(':memory:');
  db.run(`CREATE TABLE agent_dispatch_messages (
    id TEXT PRIMARY KEY,
    correlation_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    task_type TEXT NOT NULL,
    sender TEXT NOT NULL DEFAULT 'overseer',
    recipient TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    subject_key TEXT,
    repeat_reason TEXT
  )`);
  db.run(`CREATE TABLE agent_dispatch_workers (
    worker_id TEXT PRIMARY KEY,
    host TEXT NOT NULL DEFAULT 'test',
    capabilities TEXT NOT NULL DEFAULT '{}',
    max_concurrency INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL,
    last_heartbeat_at TEXT NOT NULL
  )`);
  databases.push(db);
  return db;
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe.serial('PR review outcome canary suite', () => {
  let home = '';
  const originalHome = process.env.ARCHON_HOME;
  const originalUrl = process.env.DATABASE_URL;
  const originalNotion = process.env.NOTION_API_KEY;

  beforeEach(async () => {
    await closeDatabase();
    resetDatabase();
    home = join(import.meta.dir, `.archon-c3-suite-${Date.now()}-${Math.random()}`);
    process.env.ARCHON_HOME = home;
    delete process.env.DATABASE_URL;
    delete process.env.NOTION_API_KEY;
  });

  afterEach(async () => {
    await closeDatabase();
    resetDatabase();
    if (originalHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = originalHome;
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
    if (originalNotion === undefined) delete process.env.NOTION_API_KEY;
    else process.env.NOTION_API_KEY = originalNotion;
    removeTempDirWithRetry(home);
  });

  test('GREEN fixtures pass the composed suite', async () => {
    const db = fixture();
    db.run(
      `INSERT INTO agent_dispatch_messages
       (id, correlation_id, idempotency_key, task_type, recipient, body, status, created_at, subject_key, repeat_reason)
       VALUES ('done-1', 'pr-review:thinmansoftware/bdc-harness#806@${HEAD_A}', 'done-1', 'run_review', 'overseer-reviewer', ?, 'done', '2026-09-14T11:00:00.000Z', ?, NULL)`,
      [
        JSON.stringify({
          owner: 'thinmansoftware',
          repo: 'bdc-harness',
          prNumber: 806,
          headSha: HEAD_A,
        }),
        SUBJECT,
      ]
    );
    db.run(
      `INSERT INTO agent_dispatch_messages
       (id, correlation_id, idempotency_key, task_type, recipient, body, status, created_at, subject_key, repeat_reason)
       VALUES ('queued-1', 'pr-review:thinmansoftware/bdc-harness#806@${HEAD_B}', 'queued-1', 'run_review', 'overseer-reviewer', ?, 'queued', '2026-09-14T11:59:55.000Z', ?, 'operator_request:canary')`,
      [
        JSON.stringify({
          owner: 'thinmansoftware',
          repo: 'bdc-harness',
          prNumber: 806,
          headSha: HEAD_B,
        }),
        SUBJECT,
      ]
    );
    db.run(
      `INSERT INTO agent_dispatch_messages
       (id, correlation_id, idempotency_key, task_type, recipient, body, status, created_at, subject_key, repeat_reason)
       VALUES ('ingest-1', 'pr-review:thinmansoftware/bdc-harness#806@${HEAD_B}', 'ingest-1', 'run_report', 'operator', ?, 'done', '2026-09-14T11:59:50.000Z', ?, NULL)`,
      [
        JSON.stringify({
          kind: 'pr_review_ingest_receipt',
          disposition: 'queued',
          reason: null,
          headSha: HEAD_B,
        }),
        SUBJECT,
      ]
    );
    const result = await runPrReviewCanarySuite({
      db,
      now: () => NOW,
      env: {},
      fetcher: async () => new Response('{}', { status: 200 }),
      subjectKey: SUBJECT,
      subjects: [
        {
          id: SUBJECT,
          prior: [
            work({
              messageId: 'auto-2',
              headSha: HEAD_C,
              isAutoRereview: true,
              headCiGreen: true,
            }),
            work({
              messageId: 'auto-1',
              headSha: HEAD_B,
              isAutoRereview: true,
              headCiGreen: true,
            }),
            work({ messageId: 'initial' }),
          ],
          currentHead: HEAD_C,
          currentHeadCiGreen: true,
        },
      ],
      deliver: deliverNeedsHumanToOperator,
      c3SyntheticEscalation: true,
      github: {
        getAllStatusCheckContexts: async () => ({ data: ['docker-build'] }),
        listCheckRunsForRef: async () => ({
          data: {
            check_runs: [{ name: 'docker-build', status: 'completed', conclusion: 'success' }],
          },
        }),
      },
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      branch: 'dev',
      headSha: HEAD_C,
    });
    expect(result.verdict).toBe('passed');
    expect(result.checks).toHaveLength(6);
  });

  test('without a github client only C6 is blocked when C3 is enabled', async () => {
    const db = fixture();
    db.run(
      `INSERT INTO agent_dispatch_messages
       (id, correlation_id, idempotency_key, task_type, recipient, body, status, created_at, subject_key, repeat_reason)
       VALUES ('done-1', 'pr-review:thinmansoftware/bdc-harness#806@${HEAD_A}', 'done-1', 'run_review', 'overseer-reviewer', ?, 'done', '2026-09-14T11:00:00.000Z', ?, NULL)`,
      [
        JSON.stringify({
          owner: 'thinmansoftware',
          repo: 'bdc-harness',
          prNumber: 806,
          headSha: HEAD_A,
        }),
        SUBJECT,
      ]
    );
    db.run(
      `INSERT INTO agent_dispatch_messages
       (id, correlation_id, idempotency_key, task_type, recipient, body, status, created_at, subject_key, repeat_reason)
       VALUES ('queued-1', 'pr-review:thinmansoftware/bdc-harness#806@${HEAD_B}', 'queued-1', 'run_review', 'overseer-reviewer', ?, 'queued', '2026-09-14T11:59:55.000Z', ?, 'operator_request:canary')`,
      [
        JSON.stringify({
          owner: 'thinmansoftware',
          repo: 'bdc-harness',
          prNumber: 806,
          headSha: HEAD_B,
        }),
        SUBJECT,
      ]
    );
    db.run(
      `INSERT INTO agent_dispatch_messages
       (id, correlation_id, idempotency_key, task_type, recipient, body, status, created_at, subject_key, repeat_reason)
       VALUES ('ingest-1', 'pr-review:thinmansoftware/bdc-harness#806@${HEAD_B}', 'ingest-1', 'run_report', 'operator', ?, 'done', '2026-09-14T11:59:50.000Z', ?, NULL)`,
      [
        JSON.stringify({
          kind: 'pr_review_ingest_receipt',
          disposition: 'queued',
          reason: null,
          headSha: HEAD_B,
        }),
        SUBJECT,
      ]
    );
    const result = await runPrReviewCanarySuite({
      db,
      now: () => NOW,
      env: {},
      fetcher: async () => new Response('{}', { status: 200 }),
      subjectKey: SUBJECT,
      subjects: [
        {
          id: SUBJECT,
          prior: [
            work({
              messageId: 'auto-2',
              headSha: HEAD_C,
              isAutoRereview: true,
              headCiGreen: true,
            }),
            work({
              messageId: 'auto-1',
              headSha: HEAD_B,
              isAutoRereview: true,
              headCiGreen: true,
            }),
            work({ messageId: 'initial' }),
          ],
          currentHead: HEAD_C,
          currentHeadCiGreen: true,
        },
      ],
      deliver: deliverNeedsHumanToOperator,
      c3SyntheticEscalation: true,
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      branch: 'dev',
      headSha: HEAD_C,
    });
    expect(result.verdict).toBe('blocked');
    expect(result.reasonCodes).toEqual(['c6_github_client_unavailable']);
    expect(
      result.checks?.filter(check => check.verdict === 'blocked').map(check => check.id)
    ).toEqual(['C6']);
  });

  test('writes the suite report beneath the canary artifact root', async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), 'pr-review-canary-'));
    const report = {
      verdict: 'failed' as const,
      reasonCodes: ['c1_budget_exhausted_on_converging_pr'],
      evidenceRefs: ['max_attempts=1'],
    };
    try {
      const paths = await writePrReviewCanaryArtifacts(outputRoot, report);
      expect(paths).toHaveLength(1);
      expect(paths[0]?.startsWith(outputRoot)).toBe(true);
      expect(JSON.parse(await readFile(paths[0]!, 'utf8'))).toEqual(report);
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });
});
