/**
 * WO-HARNESS-OVERSEER-REVIEW-ROUTE-01 -- integration test against a REAL
 * database, not a fake IngestDeps.
 *
 * Review finding (Codex, third-pass review, 2026-08-19): the unit tests for
 * pr-review-wiring.ts never exercised createRealIngestDeps against the real
 * dispatch DAL. That gap hid a real defect -- enqueueReviewWork sends to
 * recipient overseer-reviewer, but createMessage's
 * assessDispatchRecipientWithQuery REJECTS any recipient absent from
 * dispatch_principals with reason missing_principal. Neither
 * overseer-reviewer (recipient) nor overseer-review-route (sender) was
 * seeded anywhere, so every real enqueue attempt would have failed on first
 * use. Fixed by migration 043 (+ the SQLite adapter's seed mirror, which is
 * hand-maintained and NOT derived from the migration files).
 *
 * This test proves the fix by running createRealIngestDeps against a real
 * SqliteAdapter -- the same adapter class production code uses -- with NO
 * mocking of the dispatch DAL. If the principals are ever un-seeded again,
 * this test fails with the exact real-world symptom instead of passing
 * vacuously against a fake.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test, mock } from 'bun:test';
import { unlinkSync } from 'fs';
import { join } from 'path';

let db: import('@archon/core/db/adapters/sqlite').SqliteAdapter;
let currentDbPath = '';

// Bug found + fixed 2026-08-25 (same disease class as the CI-stabilization
// WO this test's sibling PR fixed): mock.module() patches the PROCESS-GLOBAL
// module registry, so replacing '@archon/core/db/connection' with an object
// carrying ONLY getDatabase silently dropped every other export of that
// module (getDialect, pool, etc.) for every LATER-loaded test file that
// imports from it -- crashing them at import time with "Export named
// 'getDialect' not found". Spreading the real module and restoring in
// afterAll keeps the blast radius inside this file.
import * as realConnection from '@archon/core/db/connection';

mock.module('@archon/core/db/connection', () => ({
  ...realConnection,
  getDatabase: () => db,
}));

afterAll(() => {
  mock.restore();
});

const { SqliteAdapter } = await import('@archon/core/db/adapters/sqlite');
// Imported dynamically, AFTER the mock.module above, so it binds the mocked
// getDatabase and exercises the real write path against this file's SqliteAdapter.
const dispatch = await import('@archon/core/db/dispatch');
const {
  createRealIngestDeps,
  createRealSubmitDeps,
  REVIEW_RECIPIENT,
  REVIEW_SENDER,
  REVIEW_RECEIPTS_LOG,
} = await import('../pr-review-wiring.ts');
const { ingestPullRequestEvent } = await import('../pr-review-ingest.ts');
const { createHmac } = await import('crypto');

// recordReceipt never touches octokit; a fake avoids App-credential creation.
const fakeSubmitOctokit = {
  pulls: { get: async () => ({ data: { head: { sha: 'a'.repeat(40) } } }) },
} as never;

async function countRows(recipient: string): Promise<number> {
  const rows = await db.query<{ n: number }>(
    'SELECT COUNT(*) AS n FROM agent_dispatch_messages WHERE recipient = $1',
    [recipient]
  );
  return Number(rows.rows[0]?.n ?? 0);
}

function cleanupDb(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(path + suffix);
    } catch {
      /* file may not exist */
    }
  }
}

function sign(payload: string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex');
}

describe('pr-review-wiring against a real SqliteAdapter', () => {
  beforeEach(() => {
    currentDbPath = join(
      import.meta.dir,
      `.test-pr-review-wiring-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    );
    db = new SqliteAdapter(currentDbPath);
  });

  afterEach(async () => {
    await db.close();
    cleanupDb(currentDbPath);
  });

  test('overseer-reviewer and overseer-review-route are seeded principals', async () => {
    const rows = await db.query<{ principal_id: string; active: number }>(
      'SELECT principal_id, active FROM dispatch_principals WHERE principal_id IN ($1, $2)',
      [REVIEW_RECIPIENT, REVIEW_SENDER]
    );
    const found = new Set(rows.rows.map(row => row.principal_id));
    expect(found.has(REVIEW_RECIPIENT)).toBe(true);
    expect(found.has(REVIEW_SENDER)).toBe(true);
    expect(rows.rows.every(row => row.active === 1)).toBe(true);
  });

  test('a real pull_request event enqueues successfully end-to-end (no missing_principal)', async () => {
    const config = {
      webhookSecret: 'integration-test-secret',
      reviewerIdentity: 'thinman-overseer[bot]',
    };
    const deps = createRealIngestDeps(config);

    const headSha = 'c'.repeat(40);
    const payload = JSON.stringify({
      action: 'opened',
      number: 42,
      pull_request: {
        number: 42,
        draft: false,
        head: { sha: headSha, ref: 'feature-branch' },
        base: { ref: 'dev', sha: 'd'.repeat(40) },
        user: { login: 'bluedevilcollectibles' },
      },
      repository: { name: 'bdc-harness', owner: { login: 'thinmansoftware' } },
    });

    const result = await ingestPullRequestEvent(
      {
        rawBody: payload,
        signature: sign(payload, config.webhookSecret),
        eventType: 'pull_request',
        deliveryId: 'integration-delivery-1',
      },
      deps
    );

    expect(result.disposition).toBe('queued');
    expect(result.messageId).toBeDefined();

    const row = await db.query<{ recipient: string; sender: string; task_type: string }>(
      'SELECT recipient, sender, task_type FROM agent_dispatch_messages WHERE id = $1',
      [result.messageId]
    );
    expect(row.rows[0]?.recipient).toBe(REVIEW_RECIPIENT);
    expect(row.rows[0]?.sender).toBe(REVIEW_SENDER);
    expect(row.rows[0]?.task_type).toBe('run_review');
  });

  test('a second delivery of the same head is a genuine no-op duplicate (DB-enforced)', async () => {
    const config = {
      webhookSecret: 'integration-test-secret',
      reviewerIdentity: 'thinman-overseer[bot]',
    };
    const deps = createRealIngestDeps(config);
    const headSha = 'e'.repeat(40);
    const payload = JSON.stringify({
      action: 'opened',
      number: 99,
      pull_request: {
        number: 99,
        draft: false,
        head: { sha: headSha, ref: 'feature-branch' },
        base: { ref: 'dev', sha: 'f'.repeat(40) },
        user: { login: 'bluedevilcollectibles' },
      },
      repository: { name: 'bdc-harness', owner: { login: 'thinmansoftware' } },
    });
    const req = {
      rawBody: payload,
      signature: sign(payload, config.webhookSecret),
      eventType: 'pull_request',
      deliveryId: 'integration-delivery-2',
    };

    const first = await ingestPullRequestEvent(req, deps);
    expect(first.disposition).toBe('queued');

    const second = await ingestPullRequestEvent(
      { ...req, deliveryId: 'integration-delivery-2-retry' },
      deps
    );
    expect(second.disposition).toBe('duplicate_delivery');
    expect(second.messageId).toBe(first.messageId);

    const count = await db.query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM agent_dispatch_messages WHERE recipient = $1',
      [REVIEW_RECIPIENT]
    );
    expect(Number(count.rows[0]?.n ?? 0)).toBe(1);
  });

  // WO-HARNESS-OPERATOR-INBOX-BACKPRESSURE-01: receipt suppression against a REAL
  // SqliteAdapter. Proves the review-receipts-log principal is seeded (closing
  // the same migration/hand-mirror gap 043 warned about) and that routing lands
  // rows where governance says, not on the operator inbox.
  test('the review-receipts-log principal is seeded (migration + SQLite mirror parity)', async () => {
    const rows = await db.query<{ principal_id: string; active: number; delivery_mode: string }>(
      'SELECT principal_id, active, delivery_mode FROM dispatch_principals WHERE principal_id = $1',
      [REVIEW_RECEIPTS_LOG]
    );
    expect(rows.rows[0]?.principal_id).toBe(REVIEW_RECEIPTS_LOG);
    expect(rows.rows[0]?.active).toBe(1);
    expect(rows.rows[0]?.delivery_mode).toBe('notify_only');
  });

  test('scenario 8: routine ingest + submit receipts land in the audit log, NOT the operator inbox, and stay retrievable', async () => {
    const ingestDeps = createRealIngestDeps({
      webhookSecret: 'integration-test-secret',
      reviewerIdentity: 'thinman-overseer[bot]',
    });
    // A routine ingest receipt (a webhook arrived and was queued).
    await ingestDeps.recordReceipt({
      correlationId: 'corr-ingest',
      deliveryId: 'delivery-routine-ingest',
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      prNumber: 42,
      headSha: 'a'.repeat(40),
      disposition: 'queued',
    });

    // A routine submit receipt (a review was submitted / approved).
    const submitDeps = createRealSubmitDeps('thinman-overseer[bot]', {
      octokit: fakeSubmitOctokit,
    });
    await submitDeps.recordReceipt({
      correlationId: 'corr-submit',
      messageId: 'message-approved-1',
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      prNumber: 42,
      headSha: 'a'.repeat(40),
      disposition: 'approved',
    });

    // NEITHER created an operator-inbox row...
    expect(await countRows('operator')).toBe(0);
    // ...and BOTH are retrievable from their audit home.
    expect(await countRows(REVIEW_RECEIPTS_LOG)).toBe(2);
  });

  test('scenario 9: a receipt carrying a blocker/decision IS delivered to the operator inbox', async () => {
    const ingestDeps = createRealIngestDeps({
      webhookSecret: 'integration-test-secret',
      reviewerIdentity: 'thinman-overseer[bot]',
    });
    // A custody conflict is a genuine operator decision.
    await ingestDeps.recordReceipt({
      correlationId: 'corr-blocker',
      deliveryId: 'delivery-custody-conflict',
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      prNumber: 7,
      headSha: 'b'.repeat(40),
      disposition: 'custody_conflict',
      reason: 'reviewer identity clashes with author custody',
    });

    const submitDeps = createRealSubmitDeps('thinman-overseer[bot]', {
      octokit: fakeSubmitOctokit,
    });
    await submitDeps.recordReceipt({
      correlationId: 'corr-submit-fail',
      messageId: 'message-submission-failed-1',
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      prNumber: 7,
      headSha: 'b'.repeat(40),
      disposition: 'submission_failed',
      reason: 'github rejected the review submission',
    });

    // Both blockers reach the operator inbox; neither pollutes the audit log.
    expect(await countRows('operator')).toBe(2);
    expect(await countRows(REVIEW_RECEIPTS_LOG)).toBe(0);
  });

  test('scenario 9b: the write path refuses an information-only receipt aimed at the operator, whatever the producer', async () => {
    // The review route routes its own receipts correctly (scenario 8). This
    // asserts the SYSTEM-WIDE backstop underneath it: the invariant lives in
    // createMessage, so ANY producer -- review route, escalation delivery, an
    // API handler, or something written next year -- is refused when it declares
    // a message information-only and addresses it to the human operator mailbox.
    await expect(
      dispatch.createMessage({
        correlation_id: 'corr-arbitrary-producer',
        idempotency_key: 'idem-arbitrary-producer',
        task_type: 'run_report',
        sender: REVIEW_SENDER,
        recipient: 'operator',
        body: JSON.stringify({ kind: 'some_other_routine_receipt' }),
        governance_classification: 'information-only',
      })
    ).rejects.toThrow('information_only_to_operator');

    // Fail-closed: the rejected write left no row behind.
    expect(await countRows('operator')).toBe(0);
  });

  test('scenario 10: a simulated day of review-route receipts creates at most a tiny operator-inbox bound', async () => {
    const ingestDeps = createRealIngestDeps({
      webhookSecret: 'integration-test-secret',
      reviewerIdentity: 'thinman-overseer[bot]',
    });
    // Observed 2026-08-27 volume/mix: 107 ingest_receipt + 48 submit_receipt =
    // 155 routine receipts, all information-only.
    for (let i = 0; i < 107; i += 1) {
      await ingestDeps.recordReceipt({
        correlationId: `corr-ingest-${i}`,
        deliveryId: `delivery-ingest-${i}`,
        owner: 'thinmansoftware',
        repo: 'bdc-harness',
        prNumber: i,
        headSha: 'a'.repeat(40),
        disposition: i % 2 === 0 ? 'queued' : 'duplicate_delivery',
      });
    }
    const submitDeps = createRealSubmitDeps('thinman-overseer[bot]', {
      octokit: fakeSubmitOctokit,
    });
    for (let i = 0; i < 48; i += 1) {
      await submitDeps.recordReceipt({
        correlationId: `corr-submit-${i}`,
        messageId: `message-submit-${i}`,
        owner: 'thinmansoftware',
        repo: 'bdc-harness',
        prNumber: i,
        headSha: 'a'.repeat(40),
        disposition: i % 2 === 0 ? 'approved' : 'changes_requested',
      });
    }

    // On the untouched tree this would be 155 operator rows. Here: ZERO -- every
    // routine receipt is information-only. The stated small bound is 0.
    expect(await countRows('operator')).toBe(0);
    expect(await countRows(REVIEW_RECEIPTS_LOG)).toBe(155);
  });
});
