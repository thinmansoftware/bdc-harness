import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { invokeConfiguredReviewModel, evaluatePullRequest } from '../pr-review-evaluator.ts';
import { terminationDiagnostic, submitReviewerBrokerJob } from '../reviewer-broker-client.ts';
import { buildIndeterminateSummary } from '../pr-review-wiring.ts';
import {
  runAndSubmitReview,
  type ReviewWorkItem,
  type ReviewExecutionProof,
} from '../pr-review-submit.ts';
/**
 * WO-HARNESS-OVERSEER-REVIEW-ROUTE-01 -- integration test against a REAL
 * database, not a fake IngestDeps.
 *
 * Review finding (Codex, third-pass review, 2026-08-19): the unit tests for
 * pr-review-wiring.ts never exercised createRealIngestDeps against the real
 * dispatch DAL. That gap hid a real defect -- enqueueReviewWork sends to
 * recipient overseer-reviewer, but Dispatch recipient validation
 * assessDispatchRecipientWithQuery REJECTS any recipient absent from
 * dispatch_principals with reason missing_principal. The recipient was not
 * seeded anywhere, so every real enqueue attempt would have failed on first
 * use. Fixed by migration 043 (+ the SQLite adapter's seed mirror, which is
 * hand-maintained and NOT derived from the migration files). M-129 Phase 1.5
 * additionally binds the internal writer to the code-fixed system:overseer
 * principal instead of accepting an unguarded sender string.
 *
 * This test proves the fix by running createRealIngestDeps against a real
 * SqliteAdapter -- the same adapter class production code uses -- with NO
 * mocking of the dispatch DAL. If the principals are ever un-seeded again,
 * this test fails with the exact real-world symptom instead of passing
 * vacuously against a fake.
 */
import { afterEach, beforeEach, describe, expect, test as bunTest } from 'bun:test';
import { unlinkSync } from 'fs';
import { join } from 'path';
import type { RealGitHubOctokitLike } from '../adapters/github-real-deps.ts';
import { runWithBoundDatabase } from './isolated-database';

let db: import('@archon/core/db/adapters/sqlite').SqliteAdapter;
let currentDbPath = '';

// getDatabase() follows the calling async context. mock.module() on
// '@archon/core/db/connection' is process-global: its closed adapter then
// fails every later suite in one `bun test` directory run.
function test(name: string, fn: () => Promise<unknown>, timeout?: number): void {
  bunTest(
    name,
    () => {
      if (!db) throw new Error('pr-review sqlite adapter was not created');
      return runWithBoundDatabase(db, () => Promise.resolve(fn()));
    },
    timeout
  );
}

const { SqliteAdapter } = await import('@archon/core/db/adapters/sqlite');
const {
  createRealIngestDeps,
  createRealSubmitDeps,
  reviewSubjectKey,
  REVIEW_RECIPIENT,
  REVIEW_SENDER,
} = await import('../pr-review-wiring.ts');
const {
  AUTO_REREVIEW_REASON_PREFIX,
  MAX_REREVIEW_ATTEMPTS,
  buildSupersedeReason,
  ingestPullRequestEvent,
} = await import('../pr-review-ingest.ts');
// LEGACY_PATTERN_CLASSES: the shipped AUTO_FIXABLE_CLASSES is empty (disarmed
// pending a structured eligibility signal), so these FENCE tests inject the
// former pattern table to get an eligible candidate. The fence, cap and
// idempotency are what they exercise -- not the classification decision.
const {
  REMEDIATION_RECIPIENT,
  REMEDIATION_SENDER,
  MAX_REMEDIATION_ATTEMPTS,
  decideRemediation,
  LEGACY_PATTERN_CLASSES,
} = await import('../remediation-candidate.ts');
const { createRealOctokitClient } = await import('../adapters/github-real-deps.ts');
const { createHmac } = await import('crypto');
// Imported after the test wrapper so runtime getDatabase() calls see this
// file's per-test SqliteAdapter.
const dispatchModule = await import('@archon/core/db/dispatch');

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

function submitOctokit(): RealGitHubOctokitLike {
  return {
    pulls: {
      get: async () => ({ data: { head: { sha: 'a'.repeat(40) } } }),
      createReview: async () => ({ data: { id: 1, state: 'APPROVED' } }),
    },
    checks: { listForRef: async () => ({ data: { check_runs: [] } }) },
  } as unknown as RealGitHubOctokitLike;
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

  test('overseer-reviewer and the code-fixed Overseer sender are seeded principals', async () => {
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

    const row = await db.query<{
      recipient: string;
      sender: string;
      sender_principal_id: string | null;
      task_type: string;
    }>(
      `SELECT recipient, sender, sender_principal_id, task_type
       FROM agent_dispatch_messages WHERE id = $1`,
      [result.messageId]
    );
    expect(row.rows[0]?.recipient).toBe(REVIEW_RECIPIENT);
    expect(row.rows[0]?.sender).toBe(REVIEW_SENDER);
    expect(row.rows[0]?.sender_principal_id).toBe('system:overseer');
    expect(row.rows[0]?.task_type).toBe('run_review');
  });

  test('a real review submission receipt binds the code-fixed Overseer system principal', async () => {
    const deps = createRealSubmitDeps('thinman-overseer[bot]', {
      octokit: submitOctokit(),
      recordApprovalVerdict: async () => {},
    });

    await deps.recordReceipt({
      correlationId: 'submit-correlation-1',
      messageId: 'submit-message-1',
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      prNumber: 669,
      headSha: 'b'.repeat(40),
      disposition: 'approved',
      event: 'APPROVE',
    });

    const row = await db.query<{
      recipient: string;
      sender: string;
      sender_principal_id: string | null;
      task_type: string;
    }>(
      `SELECT recipient, sender, sender_principal_id, task_type
       FROM agent_dispatch_messages
       WHERE idempotency_key = $1`,
      ['pr-review-submit-receipt:submit-message-1:approved']
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]?.recipient).toBe('pr-review-log');
    expect(row.rows[0]?.sender).toBe(REVIEW_SENDER);
    expect(row.rows[0]?.sender_principal_id).toBe('system:overseer');
    expect(row.rows[0]?.task_type).toBe('run_report');
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

  test('a new head enqueues after the prior review reaches a terminal state', async () => {
    const config = {
      webhookSecret: 'integration-test-secret',
      reviewerIdentity: 'thinman-overseer[bot]',
    };
    const deps = createRealIngestDeps(config);

    const payloadFor = (action: 'opened' | 'synchronize', headSha: string): string =>
      JSON.stringify({
        action,
        number: 148,
        pull_request: {
          number: 148,
          draft: false,
          head: { sha: headSha, ref: 'feature-branch' },
          base: { ref: 'dev', sha: 'f'.repeat(40) },
          user: { login: 'bluedevilcollectibles' },
        },
        repository: { name: 'bdc-harness', owner: { login: 'thinmansoftware' } },
      });

    const firstPayload = payloadFor('opened', '1'.repeat(40));
    const first = await ingestPullRequestEvent(
      {
        rawBody: firstPayload,
        signature: sign(firstPayload, config.webhookSecret),
        eventType: 'pull_request',
        deliveryId: 'integration-delivery-terminal-head-1',
      },
      deps
    );
    expect(first.disposition).toBe('queued');

    await db.query(
      `UPDATE agent_dispatch_messages
       SET status = 'done', completed_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [first.messageId]
    );
    await createRealSubmitDeps('thinman-overseer[bot]', {
      octokit: submitOctokit(),
      recordApprovalVerdict: async () => {},
    }).recordReceipt({
      correlationId: first.correlationId ?? '',
      messageId: first.messageId ?? '',
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      prNumber: 148,
      headSha: '1'.repeat(40),
      disposition: 'changes_requested',
      event: 'REQUEST_CHANGES',
    });

    const secondHeadSha = '2'.repeat(40);
    const secondPayload = payloadFor('synchronize', secondHeadSha);
    const second = await ingestPullRequestEvent(
      {
        rawBody: secondPayload,
        signature: sign(secondPayload, config.webhookSecret),
        eventType: 'pull_request',
        deliveryId: 'integration-delivery-terminal-head-2',
      },
      deps
    );

    expect(second.disposition).toBe('queued');
    expect(second.messageId).not.toBe(first.messageId);

    const rows = await db.query<{ repeat_reason: string | null; body: string }>(
      `SELECT repeat_reason, body
       FROM agent_dispatch_messages
       WHERE id = $1`,
      [second.messageId]
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.repeat_reason).toContain('changes_requested verdict');
    expect(rows.rows[0]?.repeat_reason).toContain('1'.repeat(40));
    expect(rows.rows[0]?.repeat_reason).toContain(secondHeadSha);
    expect(JSON.parse(rows.rows[0]?.body ?? '{}').headSha).toBe(secondHeadSha);
  });

  test('an approved receipt round-trip still reviews a newer head with a supersede reason', async () => {
    const config = {
      webhookSecret: 'integration-test-secret',
      reviewerIdentity: 'thinman-overseer[bot]',
    };
    const deps = createRealIngestDeps(config);
    const payloadFor = (action: 'opened' | 'synchronize', headSha: string): string =>
      JSON.stringify({
        action,
        number: 149,
        pull_request: {
          number: 149,
          draft: false,
          head: { sha: headSha, ref: 'feature-branch' },
          base: { ref: 'dev', sha: 'f'.repeat(40) },
          user: { login: 'bluedevilcollectibles' },
        },
        repository: { name: 'bdc-harness', owner: { login: 'thinmansoftware' } },
      });

    const firstHeadSha = '6'.repeat(40);
    const firstPayload = payloadFor('opened', firstHeadSha);
    const first = await ingestPullRequestEvent(
      {
        rawBody: firstPayload,
        signature: sign(firstPayload, config.webhookSecret),
        eventType: 'pull_request',
        deliveryId: 'integration-delivery-approved-head-1',
      },
      deps
    );
    expect(first.disposition).toBe('queued');

    await db.query(
      `UPDATE agent_dispatch_messages
       SET status = 'done', completed_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [first.messageId]
    );
    const submitDeps = createRealSubmitDeps('thinman-overseer[bot]', {
      octokit: submitOctokit(),
      recordApprovalVerdict: async () => {},
    });
    await submitDeps.recordReceipt({
      correlationId: first.correlationId ?? '',
      messageId: first.messageId ?? '',
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      prNumber: 149,
      headSha: firstHeadSha,
      disposition: 'submission_failed',
      reason: 'transient_failure',
    });
    await db.query(
      `UPDATE agent_dispatch_messages
       SET created_at = '2000-01-01 00:00:00'
       WHERE idempotency_key = $1`,
      [`pr-review-submit-receipt:${first.messageId}:submission_failed`]
    );
    await submitDeps.recordReceipt({
      correlationId: first.correlationId ?? '',
      messageId: first.messageId ?? '',
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      prNumber: 149,
      headSha: firstHeadSha,
      disposition: 'approved',
      event: 'APPROVE',
    });

    const prior = await deps.listPriorReviewWork({
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      prNumber: 149,
    });
    expect(prior.find(work => work.messageId === first.messageId)?.verdict).toBe('approved');

    const secondHeadSha = '7'.repeat(40);
    const secondPayload = payloadFor('synchronize', secondHeadSha);
    const second = await ingestPullRequestEvent(
      {
        rawBody: secondPayload,
        signature: sign(secondPayload, config.webhookSecret),
        eventType: 'pull_request',
        deliveryId: 'integration-delivery-approved-head-2',
      },
      deps
    );

    expect(second.disposition).toBe('queued');
    const rows = await db.query<{ repeat_reason: string | null }>(
      `SELECT repeat_reason FROM agent_dispatch_messages
       WHERE recipient = $1 AND body LIKE $2`,
      [REVIEW_RECIPIENT, `%${secondHeadSha}%`]
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.repeat_reason).toBe(
      buildSupersedeReason(firstHeadSha, secondHeadSha, 'approved')
    );
    expect(rows.rows[0]?.repeat_reason?.startsWith(AUTO_REREVIEW_REASON_PREFIX)).toBe(false);
  });

  /**
   * Real-world reproduction (2026-09-02): a `synchronize` push arrives while
   * the FIRST review for that PR is still 'queued' (not yet claimed or
   * terminal) -- the common case, since re-review usually beats the reviewer
   * to the mailbox. Prior coverage only proved the terminal-state case
   * (review already 'done'); this proves the non-terminal case end-to-end
   * against the real dispatch DAL, including that ingest's own stale-head
   * cancellation runs BEFORE the second enqueue rather than racing it.
   */
  test('a synchronize event enqueues a fresh review while the prior review for an older head is still queued', async () => {
    const config = {
      webhookSecret: 'integration-test-secret',
      reviewerIdentity: 'thinman-overseer[bot]',
    };
    const deps = createRealIngestDeps(config);

    const payloadFor = (action: 'opened' | 'synchronize', headSha: string): string =>
      JSON.stringify({
        action,
        number: 117,
        pull_request: {
          number: 117,
          draft: false,
          head: { sha: headSha, ref: 'feature-branch' },
          base: { ref: 'dev', sha: 'f'.repeat(40) },
          user: { login: 'bluedevilcollectibles' },
        },
        repository: { name: 'shopops-comic-theme', owner: { login: 'thinmansoftware' } },
      });

    const firstHeadSha = '3'.repeat(40);
    const firstPayload = payloadFor('opened', firstHeadSha);
    const first = await ingestPullRequestEvent(
      {
        rawBody: firstPayload,
        signature: sign(firstPayload, config.webhookSecret),
        eventType: 'pull_request',
        deliveryId: 'integration-delivery-nonterminal-1',
      },
      deps
    );
    expect(first.disposition).toBe('queued');

    // Deliberately left 'queued' -- do NOT mark it done/claimed. This is the
    // gap the terminal-state test above does not exercise.
    const priorStatus = await db.query<{ status: string }>(
      `SELECT status FROM agent_dispatch_messages WHERE id = $1`,
      [first.messageId]
    );
    expect(priorStatus.rows[0]?.status).toBe('queued');

    const secondHeadSha = '4'.repeat(40);
    const secondPayload = payloadFor('synchronize', secondHeadSha);
    const second = await ingestPullRequestEvent(
      {
        rawBody: secondPayload,
        signature: sign(secondPayload, config.webhookSecret),
        eventType: 'pull_request',
        deliveryId: 'integration-delivery-nonterminal-2',
      },
      deps
    );

    expect(second.disposition).toBe('superseded_head');
    expect(second.messageId).toBeDefined();
    expect(second.messageId).not.toBe(first.messageId);
    expect(second.invalidatedMessageIds).toContain(first.messageId);

    const rows = await db.query<{
      status: string;
      repeat_reason: string | null;
      body: string;
    }>(`SELECT status, repeat_reason, body FROM agent_dispatch_messages WHERE id = $1`, [
      second.messageId,
    ]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.status).toBe('queued');
    expect(rows.rows[0]?.repeat_reason).toBeNull();
    expect(JSON.parse(rows.rows[0]?.body ?? '{}').headSha).toBe(secondHeadSha);

    // The original (older-head) queued row was cancelled, not left dangling.
    const cancelledPriorStatus = await db.query<{ status: string }>(
      `SELECT status FROM agent_dispatch_messages WHERE id = $1`,
      [first.messageId]
    );
    expect(cancelledPriorStatus.rows[0]?.status).toBe('cancelled');
  });

  /**
   * Review finding (Overseer, PR #772): `isAutoRereview` was derived from
   * `repeat_reason !== null`. Because the pre-2026-09 enqueue path stamped
   * EVERY review -- initial ones included -- with `review_exact_head:<sha>`,
   * and because unrelated writers (Taskmaster nudges, operator re-review
   * requests) also fill that shared column, a PR whose history predates this
   * change could exhaust MAX_REREVIEW_ATTEMPTS without a single automatic
   * re-review having run. Verified live 2026-09-06: 6 legacy-format rows and
   * 134 prose reasons on the reviewer queue, shopops#662 holding 16 alone.
   *
   * This proves the derivation against the REAL dispatch DAL, since the fake
   * IngestDeps in the unit suite set `isAutoRereview` directly and so cannot
   * exercise the wiring where the defect lived.
   */
  test('legacy and foreign repeat_reason rows are not counted as auto re-review attempts', async () => {
    const config = {
      webhookSecret: 'integration-test-secret',
      reviewerIdentity: 'thinman-overseer[bot]',
    };
    const deps = createRealIngestDeps(config);
    const prNumber = 662;
    const subjectKey = reviewSubjectKey('thinmansoftware', 'shopops', prNumber);

    const payloadFor = (action: 'opened' | 'synchronize', headSha: string): string =>
      JSON.stringify({
        action,
        number: prNumber,
        pull_request: {
          number: prNumber,
          draft: false,
          head: { sha: headSha, ref: 'feature-branch' },
          base: { ref: 'dev', sha: 'f'.repeat(40) },
          user: { login: 'bluedevilcollectibles' },
        },
        repository: { name: 'shopops', owner: { login: 'thinmansoftware' } },
      });

    const firstHeadSha = '8'.repeat(40);
    const firstPayload = payloadFor('opened', firstHeadSha);
    const first = await ingestPullRequestEvent(
      {
        rawBody: firstPayload,
        signature: sign(firstPayload, config.webhookSecret),
        eventType: 'pull_request',
        deliveryId: 'integration-delivery-legacy-reason-1',
      },
      deps
    );
    expect(first.disposition).toBe('queued');

    // Backfill the legacy shape onto the initial review, exactly as the old
    // enqueue path wrote it, and add more legacy/foreign rows than the cap
    // allows. None of these were automatic re-reviews.
    await db.query(`UPDATE agent_dispatch_messages SET repeat_reason = $1 WHERE id = $2`, [
      `review_exact_head:${firstHeadSha}`,
      first.messageId,
    ]);
    const legacyReasons = [
      `review_exact_head:${'a'.repeat(40)}`,
      'tm:nudge:follow-up',
      'Fresh exact-head review after source repair.',
      'system XO escalation handoff',
    ];
    expect(legacyReasons.length).toBeGreaterThan(MAX_REREVIEW_ATTEMPTS);
    for (const [index, reason] of legacyReasons.entries()) {
      // Backdated: listMessages orders subject_key queries newest-first, and
      // in real history these legacy rows predate the review that carries the
      // CHANGES_REQUESTED verdict. Keeping that order means this test
      // exercises the attempt cap rather than the reason-selection path.
      await db.query(
        `INSERT INTO agent_dispatch_messages
           (id, correlation_id, idempotency_key, task_type, sender, recipient,
            body, subject_key, repeat_reason, status, created_at)
         VALUES ($1, $2, $3, 'run_review', $4, $5, $6, $7, $8, 'done', '2000-01-01 00:00:00')`,
        [
          `legacy-row-${index}`,
          `legacy-correlation-${index}`,
          `legacy-idempotency-${index}`,
          REVIEW_SENDER,
          REVIEW_RECIPIENT,
          JSON.stringify({
            owner: 'thinmansoftware',
            repo: 'shopops',
            prNumber,
            headSha: String(index + 1).repeat(40),
            baseRef: 'dev',
            author: 'bluedevilcollectibles',
          }),
          subjectKey,
          reason,
        ]
      );
    }

    const prior = await deps.listPriorReviewWork({
      owner: 'thinmansoftware',
      repo: 'shopops',
      prNumber,
    });
    expect(prior.length).toBe(legacyReasons.length + 1);
    expect(prior.every(work => work.isAutoRereview === false)).toBe(true);

    // Give the initial review a CHANGES_REQUESTED verdict so the next push
    // takes the re-review path -- the path the cap guards.
    await db.query(
      `UPDATE agent_dispatch_messages
       SET status = 'done', completed_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [first.messageId]
    );
    await createRealSubmitDeps('thinman-overseer[bot]', {
      octokit: submitOctokit(),
      recordApprovalVerdict: async () => {},
    }).recordReceipt({
      correlationId: first.correlationId ?? '',
      messageId: first.messageId ?? '',
      owner: 'thinmansoftware',
      repo: 'shopops',
      prNumber,
      headSha: firstHeadSha,
      disposition: 'changes_requested',
      event: 'REQUEST_CHANGES',
    });

    const secondHeadSha = '9'.repeat(40);
    const secondPayload = payloadFor('synchronize', secondHeadSha);
    const second = await ingestPullRequestEvent(
      {
        rawBody: secondPayload,
        signature: sign(secondPayload, config.webhookSecret),
        eventType: 'pull_request',
        deliveryId: 'integration-delivery-legacy-reason-2',
      },
      deps
    );

    // Pre-fix this was 'blocked' / 'rereview_attempts_exhausted'.
    expect(second.disposition).toBe('queued');

    // The reason the auto path just wrote IS the one the cap reads back.
    const rows = await db.query<{ repeat_reason: string | null }>(
      `SELECT repeat_reason FROM agent_dispatch_messages WHERE id = $1`,
      [second.messageId]
    );
    const writtenReason = rows.rows[0]?.repeat_reason ?? null;
    expect(writtenReason).toContain(AUTO_REREVIEW_REASON_PREFIX);
    const afterRereview = await deps.listPriorReviewWork({
      owner: 'thinmansoftware',
      repo: 'shopops',
      prNumber,
    });
    expect(afterRereview.filter(work => work.isAutoRereview).length).toBe(1);
    expect(afterRereview.find(work => work.messageId === second.messageId)?.isAutoRereview).toBe(
      true
    );
  });

  test('a same-head redelivery while the review is still queued is a duplicate, not a new enqueue', async () => {
    const config = {
      webhookSecret: 'integration-test-secret',
      reviewerIdentity: 'thinman-overseer[bot]',
    };
    const deps = createRealIngestDeps(config);
    const headSha = '5'.repeat(40);
    const payload = JSON.stringify({
      action: 'opened',
      number: 200,
      pull_request: {
        number: 200,
        draft: false,
        head: { sha: headSha, ref: 'feature-branch' },
        base: { ref: 'dev', sha: 'f'.repeat(40) },
        user: { login: 'bluedevilcollectibles' },
      },
      repository: { name: 'shopops-comic-theme', owner: { login: 'thinmansoftware' } },
    });

    const first = await ingestPullRequestEvent(
      {
        rawBody: payload,
        signature: sign(payload, config.webhookSecret),
        eventType: 'pull_request',
        deliveryId: 'integration-delivery-samehead-1',
      },
      deps
    );
    expect(first.disposition).toBe('queued');

    // Same head re-delivered via `synchronize` (e.g. a force-push landing
    // back on the same sha, or a redundant webhook retry with a fresh
    // delivery id) while the first review is still queued.
    const secondPayload = JSON.stringify({
      action: 'synchronize',
      number: 200,
      pull_request: {
        number: 200,
        draft: false,
        head: { sha: headSha, ref: 'feature-branch' },
        base: { ref: 'dev', sha: 'f'.repeat(40) },
        user: { login: 'bluedevilcollectibles' },
      },
      repository: { name: 'shopops-comic-theme', owner: { login: 'thinmansoftware' } },
    });
    const second = await ingestPullRequestEvent(
      {
        rawBody: secondPayload,
        signature: sign(secondPayload, config.webhookSecret),
        eventType: 'pull_request',
        deliveryId: 'integration-delivery-samehead-2',
      },
      deps
    );

    expect(second.disposition).toBe('duplicate_delivery');
    expect(second.messageId).toBe(first.messageId);

    const count = await db.query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM agent_dispatch_messages WHERE recipient = $1 AND body LIKE $2',
      [REVIEW_RECIPIENT, `%${headSha}%`]
    );
    expect(Number(count.rows[0]?.n ?? 0)).toBe(1);
  });

  /**
   * Review finding (Overseer, PR #772): verdict discovery queries receipts by
   * subject_key, but subject_key on submit receipts is NEW in this change --
   * recordReceipt did not persist it before. Every receipt written prior to
   * deployment is therefore invisible to that query, so the completed
   * CHANGES_REQUESTED reviews that exist today -- exactly the historical cases
   * this change intends to repair -- could not authorize an automatic
   * re-review at all.
   */
  test('a legacy receipt with no subject_key still authorizes the re-review', async () => {
    const config = {
      webhookSecret: 'integration-test-secret',
      reviewerIdentity: 'thinman-overseer[bot]',
    };
    const deps = createRealIngestDeps(config);
    const prNumber = 771;

    const payloadFor = (action: 'opened' | 'synchronize', headSha: string): string =>
      JSON.stringify({
        action,
        number: prNumber,
        pull_request: {
          number: prNumber,
          draft: false,
          head: { sha: headSha, ref: 'feature-branch' },
          base: { ref: 'dev', sha: 'f'.repeat(40) },
          user: { login: 'bluedevilcollectibles' },
        },
        repository: { name: 'bdc-harness', owner: { login: 'thinmansoftware' } },
      });

    const firstHeadSha = '3'.repeat(40);
    const firstPayload = payloadFor('opened', firstHeadSha);
    const first = await ingestPullRequestEvent(
      {
        rawBody: firstPayload,
        signature: sign(firstPayload, config.webhookSecret),
        eventType: 'pull_request',
        deliveryId: 'integration-delivery-legacy-receipt-1',
      },
      deps
    );
    expect(first.disposition).toBe('queued');

    await db.query(
      `UPDATE agent_dispatch_messages
       SET status = 'done', completed_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [first.messageId]
    );
    await createRealSubmitDeps('thinman-overseer[bot]', {
      octokit: submitOctokit(),
      recordApprovalVerdict: async () => {},
    }).recordReceipt({
      correlationId: first.correlationId ?? '',
      messageId: first.messageId ?? '',
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      prNumber,
      headSha: firstHeadSha,
      disposition: 'changes_requested',
      event: 'REQUEST_CHANGES',
    });

    // Rewrite the receipt into the PRE-DEPLOYMENT shape: no subject_key, which
    // is precisely what every receipt on disk today looks like. correlation_id
    // is left intact because legacy receipts do carry it.
    const stripped = await db.query(
      `UPDATE agent_dispatch_messages
       SET subject_key = NULL
       WHERE task_type = 'run_report' AND body LIKE '%pr_review_submit_receipt%'`,
      []
    );
    expect(stripped.rowCount).toBeGreaterThan(0);
    const remaining = await db.query<{ count: number }>(
      `SELECT COUNT(*) AS count
       FROM agent_dispatch_messages
       WHERE task_type = 'run_report'
         AND subject_key IS NOT NULL
         AND body LIKE '%pr_review_submit_receipt%'`,
      []
    );
    // Proves the subject_key query below genuinely has nothing to find.
    expect(Number(remaining.rows[0]?.count ?? 0)).toBe(0);

    const secondHeadSha = '4'.repeat(40);
    const secondPayload = payloadFor('synchronize', secondHeadSha);
    const second = await ingestPullRequestEvent(
      {
        rawBody: secondPayload,
        signature: sign(secondPayload, config.webhookSecret),
        eventType: 'pull_request',
        deliveryId: 'integration-delivery-legacy-receipt-2',
      },
      deps
    );

    // Pre-fix: the subject_key query returned nothing, the prior verdict was
    // null, no reason was built, and Dispatch refused the enqueue.
    expect(second.disposition).toBe('queued');
    const rows = await db.query<{ repeat_reason: string | null }>(
      `SELECT repeat_reason FROM agent_dispatch_messages WHERE id = $1`,
      [second.messageId]
    );
    const reason = rows.rows[0]?.repeat_reason ?? '';
    expect(reason.startsWith(AUTO_REREVIEW_REASON_PREFIX)).toBe(true);
    expect(reason).toContain('changes_requested verdict');
    expect(reason).toContain(firstHeadSha);
    expect(reason).toContain(secondHeadSha);
  });

  test('a legacy receipt belonging to a DIFFERENT pr does not authorize a re-review', async () => {
    // The fallback scans operator receipts without a subject_key filter, so it
    // must discriminate by correlation prefix. A neighbouring PR's legacy
    // changes_requested receipt must not leak across.
    const config = {
      webhookSecret: 'integration-test-secret',
      reviewerIdentity: 'thinman-overseer[bot]',
    };
    const deps = createRealIngestDeps(config);

    const payloadFor = (
      action: 'opened' | 'synchronize',
      prNumber: number,
      headSha: string
    ): string =>
      JSON.stringify({
        action,
        number: prNumber,
        pull_request: {
          number: prNumber,
          draft: false,
          head: { sha: headSha, ref: 'feature-branch' },
          base: { ref: 'dev', sha: 'f'.repeat(40) },
          user: { login: 'bluedevilcollectibles' },
        },
        repository: { name: 'bdc-harness', owner: { login: 'thinmansoftware' } },
      });

    // A neighbouring PR reaches changes_requested, and its receipt is legacy.
    const neighbourHeadSha = '5'.repeat(40);
    const neighbourPayload = payloadFor('opened', 900, neighbourHeadSha);
    const neighbour = await ingestPullRequestEvent(
      {
        rawBody: neighbourPayload,
        signature: sign(neighbourPayload, config.webhookSecret),
        eventType: 'pull_request',
        deliveryId: 'integration-delivery-legacy-neighbour-1',
      },
      deps
    );
    expect(neighbour.disposition).toBe('queued');
    await createRealSubmitDeps('thinman-overseer[bot]', {
      octokit: submitOctokit(),
      recordApprovalVerdict: async () => {},
    }).recordReceipt({
      correlationId: neighbour.correlationId ?? '',
      messageId: neighbour.messageId ?? '',
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      prNumber: 900,
      headSha: neighbourHeadSha,
      disposition: 'changes_requested',
      event: 'REQUEST_CHANGES',
    });
    await db.query(
      `UPDATE agent_dispatch_messages
       SET subject_key = NULL
       WHERE task_type = 'run_report' AND body LIKE '%pr_review_submit_receipt%'`,
      []
    );

    // The PR under test has been reviewed once with NO verdict recorded.
    const firstHeadSha = '7'.repeat(40);
    const firstPayload = payloadFor('opened', 901, firstHeadSha);
    const first = await ingestPullRequestEvent(
      {
        rawBody: firstPayload,
        signature: sign(firstPayload, config.webhookSecret),
        eventType: 'pull_request',
        deliveryId: 'integration-delivery-legacy-neighbour-2',
      },
      deps
    );
    expect(first.disposition).toBe('queued');

    const secondPayload = payloadFor('synchronize', 901, '8'.repeat(40));
    const second = await ingestPullRequestEvent(
      {
        rawBody: secondPayload,
        signature: sign(secondPayload, config.webhookSecret),
        eventType: 'pull_request',
        deliveryId: 'integration-delivery-legacy-neighbour-3',
      },
      deps
    );

    // The PR under test has no verdict of its own, so NO re-review reason may
    // be built. The neighbour's legacy changes_requested receipt must not leak
    // across: the fallback scans operator receipts unfiltered by subject_key,
    // so correlation-prefix discrimination is the only thing separating them.
    // (The prior row was still queued, so it is cancelled as stale and the
    // enqueue itself succeeds -- Dispatch only demands a reason once a prior
    // row is terminal. The load-bearing assertion is the null reason.)
    expect(second.disposition).toBe('superseded_head');
    const rows = await db.query<{ repeat_reason: string | null }>(
      `SELECT repeat_reason FROM agent_dispatch_messages WHERE id = $1`,
      [second.messageId]
    );
    expect(rows.rows[0]?.repeat_reason ?? null).toBeNull();
    expect(rows.rows[0]?.repeat_reason ?? '').not.toContain(neighbourHeadSha);
  });

  /**
   * Review finding (coordinator, PR #772): the first version of the legacy
   * fallback scanned a single `listMessages` page. That page is hard-capped at
   * 500 rows and has no offset or cursor, while the live store holds ~2,700
   * queued operator rows (bdc-harness #761 backlog) plus completed ones. A
   * genuinely old CHANGES_REQUESTED receipt therefore falls outside the
   * window -- defeating the fallback exactly where it matters most, on the
   * oldest PRs it exists to repair.
   *
   * This test buries the legacy receipt behind MORE than 500 newer, unrelated
   * operator rows. It passes only because the prefix match runs in SQL.
   */
  test('a legacy receipt survives a backlog of 600 newer unrelated operator rows', async () => {
    const config = {
      webhookSecret: 'integration-test-secret',
      reviewerIdentity: 'thinman-overseer[bot]',
    };
    const deps = createRealIngestDeps(config);
    const prNumber = 761;

    const payloadFor = (action: 'opened' | 'synchronize', headSha: string): string =>
      JSON.stringify({
        action,
        number: prNumber,
        pull_request: {
          number: prNumber,
          draft: false,
          head: { sha: headSha, ref: 'feature-branch' },
          base: { ref: 'dev', sha: 'f'.repeat(40) },
          user: { login: 'bluedevilcollectibles' },
        },
        repository: { name: 'bdc-harness', owner: { login: 'thinmansoftware' } },
      });

    const firstHeadSha = 'a'.repeat(40);
    const firstPayload = payloadFor('opened', firstHeadSha);
    const first = await ingestPullRequestEvent(
      {
        rawBody: firstPayload,
        signature: sign(firstPayload, config.webhookSecret),
        eventType: 'pull_request',
        deliveryId: 'integration-delivery-backlog-1',
      },
      deps
    );
    expect(first.disposition).toBe('queued');

    await db.query(
      `UPDATE agent_dispatch_messages
       SET status = 'done', completed_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [first.messageId]
    );
    await createRealSubmitDeps('thinman-overseer[bot]', {
      octokit: submitOctokit(),
      recordApprovalVerdict: async () => {},
    }).recordReceipt({
      correlationId: first.correlationId ?? '',
      messageId: first.messageId ?? '',
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      prNumber,
      headSha: firstHeadSha,
      disposition: 'changes_requested',
      event: 'REQUEST_CHANGES',
    });

    // Legacy shape: no subject_key, correlation_id intact. Pinned to a
    // timestamp strictly NEWER than every backlog row below. An unfiltered
    // listMessages orders OLDEST-first, so this receipt sorts last -- past the
    // 500-row page cap, and therefore unreachable by a client-side scan. The
    // DAL query orders newest-first and finds it immediately.
    await db.query(
      `UPDATE agent_dispatch_messages
       SET subject_key = NULL, created_at = '2026-06-01T00:00:00.000Z'
       WHERE task_type = 'run_report' AND body LIKE '%pr_review_submit_receipt%'`,
      []
    );

    // 600 newer operator rows -- more than listMessages can return in one
    // page. These are ordinary run_report traffic for other subjects, exactly
    // what the #761 backlog looks like.
    const BACKLOG_ROWS = 600;
    for (let index = 0; index < BACKLOG_ROWS; index += 1) {
      await db.query(
        `INSERT INTO agent_dispatch_messages
           (id, correlation_id, idempotency_key, task_type, sender, recipient, body, status, created_at)
         VALUES ($1, $2, $3, 'run_report', 'overseer', 'operator', $4, 'queued', $5)`,
        [
          `backlog-${index}`,
          `unrelated-correlation:${index}`,
          `backlog-idem-${index}`,
          JSON.stringify({ kind: 'unrelated_report', index }),
          `2026-01-01T00:00:${String(index % 60).padStart(2, '0')}.${String(index).padStart(3, '0')}Z`,
        ]
      );
    }

    // The backlog genuinely exceeds a single page, and the legacy receipt is
    // NOT in it -- so the previous client-side scan could not have found it.
    // listMessages caps limit at 500 and exposes no offset, so there is no
    // second page to ask for.
    const page = await dispatchModule.listMessages({ recipient: 'operator', limit: 500 });
    expect(page.length).toBe(500);
    expect(page.some(message => message.body.includes('pr_review_submit_receipt'))).toBe(false);

    const secondHeadSha = 'b'.repeat(40);
    const secondPayload = payloadFor('synchronize', secondHeadSha);
    const second = await ingestPullRequestEvent(
      {
        rawBody: secondPayload,
        signature: sign(secondPayload, config.webhookSecret),
        eventType: 'pull_request',
        deliveryId: 'integration-delivery-backlog-2',
      },
      deps
    );

    // Found despite the backlog: the prefix filter runs in SQL.
    expect(second.disposition).toBe('queued');
    const rows = await db.query<{ repeat_reason: string | null }>(
      `SELECT repeat_reason FROM agent_dispatch_messages WHERE id = $1`,
      [second.messageId]
    );
    const reason = rows.rows[0]?.repeat_reason ?? '';
    expect(reason.startsWith(AUTO_REREVIEW_REASON_PREFIX)).toBe(true);
    expect(reason).toContain('changes_requested verdict');
    expect(reason).toContain(firstHeadSha);
    expect(reason).toContain(secondHeadSha);
  });

  test('the correlation-prefix DAL query is scoped, escaped and newest-first', async () => {
    // Direct DAL coverage: the wiring test above proves the end-to-end path,
    // this pins the query contract the fallback depends on.
    const rows: [string, string, string | null][] = [
      ['dal-a', 'pr-review:thinmansoftware/bdc-harness#800@aaa', null],
      ['dal-b', 'pr-review:thinmansoftware/bdc-harness#800@bbb', null],
      // Same prefix but already indexed by subject_key -- excluded, because
      // the indexed query already reaches it.
      [
        'dal-c',
        'pr-review:thinmansoftware/bdc-harness#800@ccc',
        'gh:thinmansoftware/bdc-harness#800',
      ],
      // A different PR whose number merely STARTS with 800.
      ['dal-d', 'pr-review:thinmansoftware/bdc-harness#8001@ddd', null],
      // A different repo.
      ['dal-e', 'pr-review:thinmansoftware/shopops#800@eee', null],
    ];
    for (const [index, [id, correlationId, subjectKey]] of rows.entries()) {
      await db.query(
        `INSERT INTO agent_dispatch_messages
           (id, correlation_id, idempotency_key, task_type, sender, recipient, body, status, created_at, subject_key)
         VALUES ($1, $2, $3, 'run_report', 'overseer', 'operator', '{}', 'queued', $4, $5)`,
        [id, correlationId, `dal-idem-${id}`, `2026-02-0${index + 1}T00:00:00.000Z`, subjectKey]
      );
    }

    const found = await dispatchModule.listMessagesByCorrelationPrefixWithoutSubjectKey({
      recipient: 'operator',
      correlationPrefix: 'pr-review:thinmansoftware/bdc-harness#800@',
    });

    // Only the two subject_key-less rows for THIS pr, newest-first.
    expect(found.map(message => message.id)).toEqual(['dal-b', 'dal-a']);
  });

  test('an underscore in a repo name is matched literally, not as a wildcard', async () => {
    // '_' is a single-character LIKE wildcard. Without escaping, a prefix for
    // repo 'a_c' would also match repo 'abc' and leak a foreign verdict.
    await db.query(
      `INSERT INTO agent_dispatch_messages
         (id, correlation_id, idempotency_key, task_type, sender, recipient, body, status, created_at)
       VALUES ($1, $2, $3, 'run_report', 'overseer', 'operator', '{}', 'queued', $4)`,
      [
        'wildcard-decoy',
        'pr-review:thinmansoftware/abc#1@aaa',
        'wildcard-idem',
        '2026-03-01T00:00:00.000Z',
      ]
    );

    const found = await dispatchModule.listMessagesByCorrelationPrefixWithoutSubjectKey({
      recipient: 'operator',
      correlationPrefix: 'pr-review:thinmansoftware/a_c#1@',
    });
    expect(found).toHaveLength(0);
  });
});

/**
 * Remediation hand-back against the REAL dispatch DAL
 * (WO-HARNESS-OVERSEER-VERDICT-TO-TASKMASTER-REMEDIATION-01).
 *
 * Same lesson as this file's header, one layer up. A fake emitter proves
 * nothing about whether `createMessage` will actually ACCEPT the row, and two
 * real rejection rules sit on that path:
 *
 *   1. `assessDispatchRecipientWithQuery` rejects any recipient absent from
 *      `dispatch_principals` -- so `taskmaster` must be seeded.
 *   2. `repeat_reason_required` -- once ANY earlier message under this PR's
 *      subject key is terminal, a further message is refused unless it carries
 *      a `repeat_reason`. Attempt 2 is exactly that case.
 *
 * Rule 2 was a live defect found on this WO's own PR #740 (2026-08-28): the
 * review route hit `enqueue_failed:repeat_reason_required` on its second push,
 * which is the same disease in the sibling code path. Without the test below,
 * the cap of 2 would silently have been a cap of 1.
 */
/**
 * The remediation emitter never touches GitHub -- it writes to dispatch. But
 * createRealSubmitDeps builds an Octokit eagerly, which throws without a token.
 * Injecting a stub keeps these tests on the REAL dispatch DAL (the thing under
 * test) without requiring credentials in CI.
 */
function stubOctokit() {
  return {
    pulls: { get: async () => ({ data: { head: { sha: '0'.repeat(40) } } }) },
  } as unknown as ReturnType<typeof createRealOctokitClient>;
}

describe('remediation hand-back against a real SqliteAdapter', () => {
  beforeEach(() => {
    currentDbPath = join(
      import.meta.dir,
      `.test-remediation-wiring-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    );
    db = new SqliteAdapter(currentDbPath);
  });

  afterEach(async () => {
    await db.close();
    cleanupDb(currentDbPath);
  });

  test('taskmaster is a seeded dispatch principal', async () => {
    const rows = await db.query<{ principal_id: string; active: number }>(
      'SELECT principal_id, active FROM dispatch_principals WHERE principal_id IN ($1, $2)',
      [REMEDIATION_RECIPIENT, REMEDIATION_SENDER]
    );
    const found = new Set(rows.rows.map(row => row.principal_id));
    expect(found.has(REMEDIATION_RECIPIENT)).toBe(true);
    expect(found.has(REMEDIATION_SENDER)).toBe(true);
  });

  /**
   * REGRESSION -- PR #740 [minor] (2026-09-04): the declared REMEDIATION_SENDER
   * was 'overseer-review-route' while the emitter authenticated as 'overseer',
   * so the exported wire contract and this suite's principal assertion were
   * both describing a sender that never sent anything.
   *
   * Asserting against the STORED row is what makes the contract honest -- a
   * constant can be edited to agree with itself, but the database records who
   * actually authenticated.
   */
  test('the stored sender equals the declared REMEDIATION_SENDER', async () => {
    const deps = createRealSubmitDeps('thinman-overseer[bot]', { octokit: stubOctokit() });
    const emit = deps.emitRemediationCandidate;
    if (!emit) throw new Error('remediation deps must be wired');

    const pr = { owner: 'thinmansoftware', repo: 'shopops', prNumber: 660 };
    await emit({
      kind: 'overseer_remediation_candidate' as const,
      ...pr,
      headSha: 'e'.repeat(40),
      attempt: 1,
      maxAttempts: MAX_REMEDIATION_ATTEMPTS,
      findingClasses: ['migration_ordering'],
      verdictBody: 'verdict',
      woId: null,
      owningLane: 'cauldron-lane-a',
    });

    const row = await db.query<{ sender: string; recipient: string }>(
      'SELECT sender, recipient FROM agent_dispatch_messages WHERE recipient = $1',
      [REMEDIATION_RECIPIENT]
    );
    expect(row.rows[0]?.sender).toBe(REMEDIATION_SENDER);
    expect(row.rows[0]?.recipient).toBe(REMEDIATION_RECIPIENT);
  });

  /**
   * REGRESSION -- PR #740 [minor] (2026-09-04): `claimed` compared the returned
   * body to the submitted one, so an idempotent replay whose stored body was
   * byte-identical also reported claimed:true. A duplicate submission was then
   * recorded as a newly emitted attempt, contradicting the documented
   * claimed:false / attempt_slot_already_claimed contract.
   *
   * This is the case the earlier race test could NOT catch: there the two
   * bodies differed by headSha, so body comparison happened to work. Here the
   * SAME candidate is submitted twice and the bodies are equal.
   */
  /**
   * REGRESSION -- PR #740 round 3 [major] (2026-09-04).
   *
   * The previous version of this test called `emit` twice with a HAND-BUILT
   * candidate carrying a hardcoded `attempt: 1`, so it never exercised
   * countPriorRemediationAttempts -> decideRemediation. The gate caught that
   * the production path behaved differently: after attempt 1 lands the count
   * returns 1, so replaying the SAME verdict computed attempt 2, a DIFFERENT
   * idempotency key, and a second durable row -- duplicate remediation work
   * that also consumed half the cap. Spec safety rule 3 forbids exactly this.
   *
   * This version drives the REAL sequence a redelivered webhook drives:
   * count -> decide -> emit, twice, with the attempt number derived rather
   * than asserted. The fix is keying idempotency on the HEAD SHA, which is
   * what identifies a verdict; the attempt number is audit metadata and no
   * longer part of the uniqueness decision.
   */
  test('REDELIVERY through the real count/decide path enqueues exactly one row', async () => {
    const deps = createRealSubmitDeps('thinman-overseer[bot]', { octokit: stubOctokit() });
    const emit = deps.emitRemediationCandidate;
    const count = deps.countPriorRemediationAttempts;
    if (!emit || !count) throw new Error('remediation deps must be wired');

    const pr = { owner: 'thinmansoftware', repo: 'shopops', prNumber: 661 };
    const headSha = 'f'.repeat(40);
    const findings = [
      {
        scope: 'migrations/041.sql',
        severity: 'blocker' as const,
        summary:
          'The migration updates the parent before the child rows; the composite foreign key rejects that ordering.',
      },
    ];

    // One delivery of the verdict, exactly as production does it.
    const deliver = async () => {
      const priorAttempts = await count(pr);
      const decision = decideRemediation(
        {
          ...pr,
          headSha,
          verdict: 'CHANGES_REQUESTED',
          findings,
          verdictBody: 'byte-identical verdict body',
          priorAttempts,
        },
        LEGACY_PATTERN_CLASSES
      );
      if (!decision.emit) return { emitted: false as const, reason: decision.reason };
      const result = await emit(decision.body);
      return { emitted: true as const, claimed: result.claimed, attempt: decision.body.attempt };
    };

    const first = await deliver();
    const replay = await deliver();

    expect(first.emitted).toBe(true);
    expect(first.emitted && first.claimed).toBe(true);

    // The replay is allowed to BUILD a candidate (the count legitimately moved),
    // but it must not create a second durable row.
    if (replay.emitted) expect(replay.claimed).toBe(false);

    // The load-bearing assertion: one reviewed head, one row, one attempt spent.
    expect(await count(pr)).toBe(1);
    const rows = await db.query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM agent_dispatch_messages WHERE recipient = $1',
      [REMEDIATION_RECIPIENT]
    );
    expect(Number(rows.rows[0]?.n ?? 0)).toBe(1);
  });

  test('attempt 1 and attempt 2 BOTH enqueue for the same PR (repeat_reason honored)', async () => {
    const deps = createRealSubmitDeps('thinman-overseer[bot]', { octokit: stubOctokit() });
    const emit = deps.emitRemediationCandidate;
    const count = deps.countPriorRemediationAttempts;
    if (!emit || !count) throw new Error('remediation deps must be wired');

    const pr = { owner: 'thinmansoftware', repo: 'shopops', prNumber: 650 };
    const candidate = (attempt: number, headSha: string) => ({
      kind: 'overseer_remediation_candidate' as const,
      ...pr,
      headSha,
      attempt,
      maxAttempts: MAX_REMEDIATION_ATTEMPTS,
      findingClasses: ['migration_ordering'],
      verdictBody: `verdict at ${headSha}`,
      woId: null,
      owningLane: 'cauldron-lane-a',
    });

    expect(await count(pr)).toBe(0);

    const first = await emit(candidate(1, 'a'.repeat(40)));
    expect(first.claimed).toBe(true);
    expect(await count(pr)).toBe(1);

    // Drive the first row terminal -- this is what arms the repeat_reason rule
    // and is exactly the real-world state after Taskmaster consumes attempt 1.
    await db.query("UPDATE agent_dispatch_messages SET status = 'done' WHERE recipient = $1", [
      REMEDIATION_RECIPIENT,
    ]);

    // Attempt 2 after a fix push. Before repeat_reason was supplied this threw
    // `repeat_reason_required` and the second remediation was impossible.
    const second = await emit(candidate(2, 'b'.repeat(40)));
    expect(second.claimed).toBe(true);
    expect(await count(pr)).toBe(2);
  });

  /**
   * The round-1 guarantee, re-proved under the round-3 key.
   *
   * Round 1's race test asserted that two DIFFERENT heads collide on one key.
   * That was true when the key was (PR, attempt) and is deliberately NOT true
   * now: keying on the head gives each reviewed head its own slot, which is
   * what makes redelivery idempotent. Two distinct heads are two distinct
   * verdicts and each may legitimately produce a candidate.
   *
   * So the bounded-loop property is no longer enforced by key collision -- it
   * is enforced by decideRemediation refusing once the count reaches the cap.
   * That is the thing worth testing, and this replaces the now-obsolete
   * collision assertion rather than deleting the coverage.
   */
  /**
   * REGRESSION -- PR #740 round 4 [major] (2026-09-04).
   *
   * The cap must hold when the count is read CONCURRENTLY, not just when
   * deliveries are sequential. Under head-keyed idempotency three racers on
   * three distinct heads each read prior count 0, each built a candidate, and
   * each inserted under its own key -- three rows against a cap of two.
   *
   * This drives them with NO awaits in between (all decided from the same
   * below-cap count, then emitted together), which is the interleaving the
   * sequential test cannot produce. The attempt SLOT is the scarce resource, so
   * however the reads interleave, at most MAX_REMEDIATION_ATTEMPTS rows exist.
   */
  /**
   * REGRESSION -- PR #740 round 5 [major] (2026-09-23).
   *
   * The round-4 emitter deduped with a READ before inserting, which is not
   * atomic: two deliveries of the SAME reviewed head both completed the
   * precheck before either inserted, then one took slot 1 and the other took
   * slot 2. One verdict produced two candidates and consumed the whole cap.
   *
   * The existing tests could not catch it -- they covered sequential same-head
   * delivery (the precheck does work when the first insert has landed) and
   * CONCURRENT DISTINCT heads (a different invariant). This covers the gap:
   * concurrent SAME head.
   *
   * The fix moves the dedupe read inside the insert transaction, so exactly one
   * row can exist for one head no matter how the deliveries interleave.
   */
  test('CONCURRENT deliveries of the SAME head yield exactly ONE row', async () => {
    const deps = createRealSubmitDeps('thinman-overseer[bot]', { octokit: stubOctokit() });
    const emit = deps.emitRemediationCandidate;
    const count = deps.countPriorRemediationAttempts;
    if (!emit || !count) throw new Error('remediation deps must be wired');

    const pr = { owner: 'thinmansoftware', repo: 'shopops', prNumber: 653 };
    const headSha = '9'.repeat(40);
    const candidate = {
      kind: 'overseer_remediation_candidate' as const,
      ...pr,
      headSha,
      attempt: 1,
      maxAttempts: MAX_REMEDIATION_ATTEMPTS,
      findingClasses: ['migration_ordering'],
      verdictBody: 'one verdict, delivered twice at once',
      woId: null,
      owningLane: 'cauldron-lane-a',
    };

    // Dispatch both without awaiting between them. The fence serializes them
    // (BEGIN IMMEDIATE on sqlite), so whichever runs second sees the first
    // insert and dedupes on the head rather than taking the next slot.
    const [first, second] = await Promise.all([emit(candidate), emit(candidate)]);

    const claims = [first, second].filter(r => r.claimed);
    expect(claims).toHaveLength(1);
    const loser = [first, second].find(r => !r.claimed);
    expect(loser?.reason).toBe('duplicate_unit_of_work');

    // ONE verdict, ONE row, ONE attempt spent -- not two.
    expect(await count(pr)).toBe(1);
    const rows = await db.query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM agent_dispatch_messages WHERE recipient = $1',
      [REMEDIATION_RECIPIENT]
    );
    expect(Number(rows.rows[0]?.n ?? 0)).toBe(1);
  });

  /**
   * NOTE ON WHERE ATOMICITY IS PROVED.
   *
   * These overseer-level tests exercise the WIRING -- that the emitter asks the
   * fence for the right thing and reports what it is told. They deliberately do
   * NOT claim to prove atomicity: Bun's sqlite driver runs queries
   * synchronously, so two awaited emits run back-to-back and a racy
   * read-then-insert emitter passes them just as happily (verified by reverting
   * the emitter: 23 pass either way). A test that cannot fail proves nothing.
   *
   * The atomicity guarantee is proved where it is implemented, against a real
   * database and with the transaction as the thing under test, in
   * packages/core/src/db/dispatch.test.ts -> "createCappedSubjectMessage
   * (capped-subject fence)". Removing the transaction from the fence makes the
   * distinct-token case exceed maxRows and that suite fail.
   */

  /**
   * PR #740 round 5 [minor]: the receipt reported the attempt the caller
   * PREDICTED, but the emitter may claim a different slot when a racer took an
   * earlier one. The emitter now returns the slot it actually claimed.
   */
  test('the emitter reports the slot it ACTUALLY claimed', async () => {
    const deps = createRealSubmitDeps('thinman-overseer[bot]', { octokit: stubOctokit() });
    const emit = deps.emitRemediationCandidate;
    if (!emit) throw new Error('remediation deps must be wired');

    const pr = { owner: 'thinmansoftware', repo: 'shopops', prNumber: 654 };
    const make = (headSha: string) => ({
      kind: 'overseer_remediation_candidate' as const,
      ...pr,
      headSha,
      // Both deliveries PREDICT slot 1; the second must be told it got slot 2.
      attempt: 1,
      maxAttempts: MAX_REMEDIATION_ATTEMPTS,
      findingClasses: ['migration_ordering'],
      verdictBody: `verdict at ${headSha}`,
      woId: null,
      owningLane: 'cauldron-lane-a',
    });

    const first = await emit(make('a'.repeat(40)));
    const second = await emit(make('b'.repeat(40)));

    expect(first.claimed).toBe(true);
    expect(first.attempt).toBe(1);
    expect(second.claimed).toBe(true);
    expect(second.attempt).toBe(2);

    // And the durable row agrees with what was reported.
    const rows = await db.query<{ body: string }>(
      'SELECT body FROM agent_dispatch_messages WHERE recipient = $1 ORDER BY created_at ASC',
      [REMEDIATION_RECIPIENT]
    );
    const attempts = rows.rows.map(r => (JSON.parse(r.body) as { attempt: number }).attempt);
    expect(attempts).toEqual([1, 2]);
  });

  test('CONCURRENT racers on distinct heads cannot exceed the cap', async () => {
    const deps = createRealSubmitDeps('thinman-overseer[bot]', { octokit: stubOctokit() });
    const emit = deps.emitRemediationCandidate;
    const count = deps.countPriorRemediationAttempts;
    if (!emit || !count) throw new Error('remediation deps must be wired');

    const pr = { owner: 'thinmansoftware', repo: 'shopops', prNumber: 652 };
    const findings = [
      {
        scope: 'migrations/041.sql',
        severity: 'blocker' as const,
        summary:
          'The migration updates the parent before the child rows; the composite foreign key rejects that ordering.',
      },
    ];

    // Every racer decides from the SAME below-cap count -- the stale read.
    const priorAttempts = await count(pr);
    expect(priorAttempts).toBe(0);

    const heads = ['1'.repeat(40), '2'.repeat(40), '3'.repeat(40), '4'.repeat(40)];
    const bodies = heads.map(headSha => {
      const decision = decideRemediation(
        {
          ...pr,
          headSha,
          verdict: 'CHANGES_REQUESTED',
          findings,
          verdictBody: `verdict at ${headSha}`,
          priorAttempts,
        },
        LEGACY_PATTERN_CLASSES
      );
      if (!decision.emit) throw new Error('expected every racer to build a candidate');
      return decision.body;
    });

    const results = await Promise.all(bodies.map(b => emit(b)));
    const won = results.filter(r => r.claimed).length;

    // At most the cap may win, and the durable rows must agree.
    expect(won).toBe(MAX_REMEDIATION_ATTEMPTS);
    expect(await count(pr)).toBe(MAX_REMEDIATION_ATTEMPTS);
    const rows = await db.query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM agent_dispatch_messages WHERE recipient = $1',
      [REMEDIATION_RECIPIENT]
    );
    expect(Number(rows.rows[0]?.n ?? 0)).toBe(MAX_REMEDIATION_ATTEMPTS);
  });

  test('distinct heads each get a slot, but the CAP still bounds the loop', async () => {
    const deps = createRealSubmitDeps('thinman-overseer[bot]', { octokit: stubOctokit() });
    const emit = deps.emitRemediationCandidate;
    const count = deps.countPriorRemediationAttempts;
    if (!emit || !count) throw new Error('remediation deps must be wired');

    const pr = { owner: 'thinmansoftware', repo: 'shopops', prNumber: 651 };
    const findings = [
      {
        scope: 'migrations/041.sql',
        severity: 'blocker' as const,
        summary:
          'The migration updates the parent before the child rows; the composite foreign key rejects that ordering.',
      },
    ];

    // Each call is a full delivery for a NEW head, through the real path.
    const deliverHead = async (headSha: string) => {
      const priorAttempts = await count(pr);
      const decision = decideRemediation(
        {
          ...pr,
          headSha,
          verdict: 'CHANGES_REQUESTED',
          findings,
          verdictBody: `verdict at ${headSha}`,
          priorAttempts,
        },
        LEGACY_PATTERN_CLASSES
      );
      if (!decision.emit) return { emitted: false as const, reason: decision.reason };
      const result = await emit(decision.body);
      return { emitted: true as const, claimed: result.claimed };
    };

    const one = await deliverHead('c'.repeat(40));
    const two = await deliverHead('d'.repeat(40));
    const three = await deliverHead('e'.repeat(40));

    expect(one.emitted && one.claimed).toBe(true);
    expect(two.emitted && two.claimed).toBe(true);

    // The third is over the cap of 2 and must be REFUSED -- this is the
    // unattended reviewer-fix-reviewer loop the WO must not create.
    expect(three.emitted).toBe(false);
    expect(three.emitted === false && three.reason).toBe('remediation_attempts_exhausted');

    expect(await count(pr)).toBe(MAX_REMEDIATION_ATTEMPTS);
    const rows = await db.query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM agent_dispatch_messages WHERE recipient = $1',
      [REMEDIATION_RECIPIENT]
    );
    expect(Number(rows.rows[0]?.n ?? 0)).toBe(MAX_REMEDIATION_ATTEMPTS);
  });
});

describe('Phase A production diagnostic return wiring', () => {
  beforeEach(() => {
    currentDbPath = join(
      import.meta.dir,
      `.test-diagnostic-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    );
    db = new SqliteAdapter(currentDbPath);
  });
  afterEach(async () => {
    await db.close();
    cleanupDb(currentDbPath);
  });

  test('A8 real native-client evaluator submit wiring keeps exact safe body and proof gates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'diagnostic-return-'));
    await writeFile(join(root, 'ready'), 'synthetic');
    try {
      const checkout = join(root, 'checkout');
      await mkdir(checkout);
      await writeFile(join(checkout, 'fixture.txt'), 'synthetic repository\n');
      const git = (args: string[]): string => {
        const result = Bun.spawnSync(['git', '-C', checkout, ...args], {
          stdout: 'pipe',
          stderr: 'pipe',
        });
        expect(result.exitCode).toBe(0);
        return result.stdout.toString().trim();
      };
      git(['init', '-q']);
      git(['add', 'fixture.txt']);
      git([
        '-c',
        'user.name=Synthetic Reviewer',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-qm',
        'synthetic fixture',
      ]);
      const head = git(['rev-parse', 'HEAD']);
      const tree = git(['rev-parse', 'HEAD^{tree}']);
      const native = await invokeConfiguredReviewModel(
        'codex',
        'PRIVATE_PROMPT_CANARY',
        {
          kind: 'pr-review',
          cwd: checkout,
          expectedHeadSha: head,
          nativePolicy: 'codex_bubblewrap',
        },
        1000,
        async (job, options) => {
          await writeFile(
            join(root, `${options?.id}.result.json`),
            JSON.stringify({
              id: options?.id,
              ok: false,
              exitCode: 1,
              stdout: 'PRIVATE_STDOUT_CANARY',
              stderr: 'PRIVATE_CREDENTIAL_CANARY authentication required',
              uid: 1002,
            })
          );
          return submitReviewerBrokerJob(job, { ...options, env: { OVERSEER_REVIEW_SPOOL: root } });
        }
      );
      expect((await readdir(root)).sort()).toEqual(['checkout', 'ready']);
      const context = {
        requestId: 'synthetic-request',
        workerId: 'synthetic-worker',
        fencingToken: 1,
        owner: 'thinmansoftware',
        repo: 'fixture',
        prNumber: 1,
        headSha: head,
        checkoutPath: checkout,
        reviewerIdentity: 'thinman-overseer[bot]',
        rung: 'codex',
        checkPlanStatus: 'absent' as const,
        checkPlan: [],
      };
      const proof: ReviewExecutionProof = {
        requestId: context.requestId,
        headSha: head,
        treeSha: tree,
        cwd: checkout,
        nativePolicy: 'codex_bubblewrap',
        nativeVersion: 'synthetic-version',
        runtimeUid: 1002,
        inspectionObserved: true,
        check_plan: 'absent',
        checks: [],
        startedAt: '2026-01-01T00:00:00Z',
        endedAt: '2026-01-01T00:00:01Z',
      };
      const work: ReviewWorkItem = {
        correlationId: 'synthetic-review',
        messageId: 'synthetic-message',
        owner: context.owner,
        repo: context.repo,
        prNumber: 1,
        headSha: head,
        author: 'fixture-author',
        executionContext: context,
      };
      const evaluator = async () =>
        evaluatePullRequest(
          { owner: work.owner, repo: work.repo, pr_number: 1, head_sha: head },
          {
            reviewer: { provider: 'synthetic', model: 'synthetic' },
            fetchEvidence: async () => ({
              diff: '+synthetic',
              checks: [{ name: 'synthetic-ci', status: 'completed', conclusion: 'success' }],
              requiredContexts: ['synthetic-ci'],
            }),
            fetchAcceptanceCriteria: async () => null,
            ladder: ['codex', 'cursor'],
            invokeModel: async binary =>
              binary === 'codex'
                ? native
                : invokeConfiguredReviewModel(
                    binary,
                    'PRIVATE_FALLBACK_PROMPT_CANARY',
                    {
                      kind: 'pr-review',
                      cwd: checkout,
                      expectedHeadSha: head,
                      nativePolicy: 'codex_bubblewrap',
                    },
                    1000,
                    async () => {
                      throw new Error('unexpected_fake_broker_call');
                    }
                  ),
          }
        );
      const production = createRealSubmitDeps('thinman-overseer[bot]', {
        octokit: stubOctokit(),
        patOctokit: null,
        evaluate: evaluator,
        observeExecution: async () => proof,
      });
      const bodies: { body: string; commitId?: string; event: string }[] = [];
      const receipts: unknown[] = [];
      const isolated = {
        ...production,
        currentHeadSha: async () => head,
        isDraft: async () => false,
        hasCustody: async () => true,
        recordReceipt: async (receipt: Parameters<typeof production.recordReceipt>[0]) => {
          receipts.push(receipt);
        },
        submitReview: async (request: Parameters<typeof production.submitReview>[0]) => {
          bodies.push(request);
          return {
            submitted: true,
            review: {
              id: 1,
              url: 'https://example.invalid/review',
              commitSha: head,
              state: 'CHANGES_REQUESTED',
            },
          };
        },
      };
      const outcome = await runAndSubmitReview(work, isolated);
      expect(outcome).toMatchObject({ disposition: 'changes_requested' });
      expect(bodies).toHaveLength(1);
      expect(bodies[0].event).toBe('REQUEST_CHANGES');
      expect(bodies[0].commitId).toBe(head);
      const body = bodies[0].body;
      expect(body).toContain('Reviewer diagnostic (sanitized):');
      expect(body).toContain(JSON.stringify(native.diagnostic));
      expect(body).toContain('End reviewer diagnostic.');
      const safeEntries = body
        .split('Reviewer diagnostic (sanitized):\n')[1]
        .split('\nEnd reviewer diagnostic.')[0]
        .split('\n')
        .map(line => JSON.parse(line));
      expect(safeEntries).toHaveLength(2);
      expect(safeEntries[0]).toEqual(native.diagnostic);
      expect(safeEntries[1].terminationClass).toBe('unsupported_binary');
      expect(safeEntries[1].exitCode).toBeNull();
      expect(safeEntries[1].correlationId).not.toBe(safeEntries[0].correlationId);
      expect(body).toContain(head);
      expect(body.length).toBeLessThanOrEqual(60_000);
      for (const canary of [
        'PRIVATE_PROMPT_CANARY',
        'PRIVATE_STDOUT_CANARY',
        'PRIVATE_CREDENTIAL_CANARY',
        'PRIVATE_FALLBACK_PROMPT_CANARY',
        'reviewer_auth_missing',
      ]) {
        expect(JSON.stringify(bodies)).not.toContain(canary);
        expect(JSON.stringify(receipts)).not.toContain(canary);
      }
      // Actual production proof-refusal branch must remain a COMMENT, with no forced section.
      const incomplete = createRealSubmitDeps('thinman-overseer[bot]', {
        octokit: stubOctokit(),
        patOctokit: null,
        evaluate: evaluator,
        observeExecution: async () => undefined,
      });
      const refused = await runAndSubmitReview(work, {
        ...isolated,
        runReviewer: incomplete.runReviewer,
      });
      expect(refused.disposition).toBe('review_incomplete');
      expect(bodies.at(-1)?.event).toBe('COMMENT');
      expect(bodies.at(-1)?.body).not.toContain('Reviewer diagnostic (sanitized):');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('A9 renderer refuses caller/model metadata without invoking malicious getters', async () => {
    let reads = 0;
    const foreign = {
      terminationClass: 'auth_expired',
      exitCode: 1,
      correlationId: '11111111-1111-4111-8111-111111111111',
      secret: 'PRIVATE_FOREIGN_CANARY',
    };
    const getter = Object.defineProperty({}, 'terminationClass', {
      get() {
        reads++;
        throw new Error('PRIVATE_GETTER_CANARY');
      },
    });
    const safe = terminationDiagnostic('unknown_error', null);
    const summary = buildIndeterminateSummary('model_error:PRIVATE_EXCEPTION_CANARY', [
      foreign,
      getter,
      safe,
    ] as never);
    expect(reads).toBe(0);
    expect(summary).toContain(JSON.stringify(safe));
    expect(summary).not.toContain(foreign.correlationId);
    for (const canary of [
      'PRIVATE_FOREIGN_CANARY',
      'PRIVATE_GETTER_CANARY',
      'PRIVATE_EXCEPTION_CANARY',
    ])
      expect(summary).not.toContain(canary);
    expect(buildIndeterminateSummary('model_error', [foreign] as never)).not.toContain(
      'Reviewer diagnostic (sanitized):'
    );
  });
});

describe('Phase B factory snapshots and designated refusal', () => {
  bunTest(
    'F1/F6 factory reads once; designated missing context refuses without observer/model/fallback',
    async () => {
      const { FABLE_MODEL, FABLE_POLICY, parseFablePermits } = await import('../judge-transport');
      let reads = 0;
      let invocations = 0;
      const permit = {
        owner: 'o',
        repo: 'r',
        prNumber: 1,
        headSha: 'a'.repeat(40),
        requestId: 'request',
        workerId: 'worker',
        fencingToken: 1,
        modelId: FABLE_MODEL,
        policy: FABLE_POLICY,
        accountBindingId: 'ultra',
        permitId: 'permit',
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      };
      const snapshot = parseFablePermits(JSON.stringify({ version: 1, entries: [permit] }));
      const overrides = {
        octokit: {} as never,
        patOctokit: null,
        readFablePermits: () => {
          reads++;
          return snapshot;
        },
        observeExecution: async () => {
          invocations++;
          return undefined;
        },
        invokeModel: async () => {
          invocations++;
          throw new Error('MUST_NOT_RUN');
        },
      };
      const deps = createRealSubmitDeps('bot', overrides);
      expect(reads).toBe(1);
      const work = {
        owner: 'o',
        repo: 'r',
        prNumber: 1,
        headSha: permit.headSha,
        correlationId: 'synthetic',
        messageId: 'request',
      };
      for (let i = 0; i < 2; i++) {
        const result = await deps.runReviewer(work);
        expect(result.approved).toBe(false);
        expect(result.reasonCode).toBe('fable_permission_refused');
      }
      expect(reads).toBe(1);
      expect(invocations).toBe(0);
      createRealSubmitDeps('bot', overrides);
      expect(reads).toBe(2);
    }
  );
  bunTest('F1 invalid configured snapshot refuses every item before native execution', async () => {
    const deps = createRealSubmitDeps('bot', {
      octokit: {} as never,
      patOctokit: null,
      readFablePermits: () => {
        throw new Error('PRIVATE_PATH_CANARY');
      },
    });
    const result = await deps.runReviewer({
      owner: 'o',
      repo: 'r',
      prNumber: 1,
      headSha: 'a'.repeat(40),
      correlationId: 'synthetic',
      messageId: 'request',
    });
    expect(result.reasonCode).toBe('fable_configuration_invalid');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_PATH_CANARY');
  });
});

describe('Phase B existing submission boundary characterization', () => {
  bunTest(
    'F7 ambiguous lost response stays failure; existing adapter provides no replay dedupe',
    async () => {
      const { createRealSubmitPullRequestReview } = await import('../adapters/github-real-deps');
      let calls = 0;
      const submit = createRealSubmitPullRequestReview({
        pulls: {
          createReview: async () => {
            calls++;
            throw new Error('SYNTHETIC_POST_SUCCESS_LOST_RESPONSE');
          },
        },
      } as never);
      const input = {
        owner: 'o',
        repo: 'r',
        number: 1,
        event: 'APPROVE' as const,
        commitId: 'a'.repeat(40),
        body: 'synthetic',
      };
      expect(await submit(input)).toEqual({
        submitted: false,
        message: 'github_review_transport_ambiguous',
      });
      expect(calls).toBe(1);
      expect(await submit(input)).toEqual({
        submitted: false,
        message: 'github_review_transport_ambiguous',
      });
      expect(calls).toBe(2); // Characterization, NOT F7 acceptance: no adapter dedupe/readback exists.
    }
  );
});

describe('Phase B exact native-client evaluator factory return', () => {
  bunTest.skipIf(process.platform !== 'linux')(
    'F4/F5/F6 actual post-invocation proof, exact attribution, lost custody and malformed output',
    async () => {
      const { FABLE_MODEL, FABLE_POLICY, parseFablePermits } = await import('../judge-transport');
      const root = await mkdtemp(join(tmpdir(), 'fable-factory-return-'));
      const checkout = join(root, 'checkout');
      await mkdir(checkout);
      await writeFile(join(checkout, 'fixture'), 'noncustomer synthetic');
      const git = (args: string[]): string => {
        const result = Bun.spawnSync(['git', '-C', checkout, ...args], {
          stdout: 'pipe',
          stderr: 'pipe',
        });
        expect(result.exitCode).toBe(0);
        return result.stdout.toString().trim();
      };
      git(['init', '-q']);
      git(['add', 'fixture']);
      git([
        '-c',
        'user.name=Synthetic',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-qm',
        'fixture',
      ]);
      const head = git(['rev-parse', 'HEAD']);
      const context = {
        owner: 'o',
        repo: 'r',
        prNumber: 1,
        headSha: head,
        requestId: 'synthetic-request',
        workerId: 'synthetic-worker',
        fencingToken: 1,
        checkoutPath: checkout,
        reviewerIdentity: 'thinman-overseer[bot]',
        rung: 'pr-review',
        checkPlanStatus: 'absent' as const,
        checkPlan: [],
      };
      const work: ReviewWorkItem = {
        owner: 'o',
        repo: 'r',
        prNumber: 1,
        headSha: head,
        messageId: context.requestId,
        correlationId: 'synthetic',
        author: 'other',
        executionContext: context,
      };
      const permit = {
        owner: 'o',
        repo: 'r',
        prNumber: 1,
        headSha: head,
        requestId: context.requestId,
        workerId: context.workerId,
        fencingToken: 1,
        modelId: FABLE_MODEL,
        policy: FABLE_POLICY,
        accountBindingId: 'ultra',
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        permitId: 'one',
      };
      const snapshot = parseFablePermits(JSON.stringify({ version: 1, entries: [permit] }));
      let custody = true;
      let malformed = false;
      let calls = 0;
      let inspectionFinished = false;
      const observed: ReviewExecutionProof = {
        requestId: context.requestId,
        headSha: head,
        treeSha: git(['rev-parse', 'HEAD^{tree}']),
        cwd: checkout,
        nativePolicy: FABLE_POLICY,
        nativeVersion: 'inspection',
        runtimeUid: 1002,
        inspectionObserved: true,
        check_plan: 'absent',
        checks: [],
        startedAt: '2026-01-01T00:00:00Z',
        endedAt: '2026-01-01T00:00:01Z',
      };
      try {
        await writeFile(join(root, 'ready'), 'synthetic');
        const production = createRealSubmitDeps('thinman-overseer[bot]', {
          octokit: stubOctokit(),
          patOctokit: null,
          readFablePermits: () => snapshot,
          hasCustody: async () => custody,
          observeExecution: async (_context, selected) => {
            expect(selected).toEqual(permit);
            inspectionFinished = true;
            return observed;
          },
          evaluate: (input, deps) =>
            evaluatePullRequest(input, {
              ...deps,
              fetchEvidence: async () => ({
                diff: '+synthetic',
                checks: [{ name: 'ci', status: 'completed', conclusion: 'success' }],
                requiredContexts: ['ci'],
              }),
            }),
          invokeModel: async (binary, prompt, transportContext) => {
            expect(inspectionFinished).toBe(true);
            expect(binary).toBe(FABLE_MODEL);
            calls++;
            return invokeConfiguredReviewModel(
              binary,
              prompt,
              transportContext,
              1000,
              async (job, options) => {
                const id = options!.id!;
                await writeFile(
                  join(root, `${id}.result.json`),
                  JSON.stringify({
                    id,
                    ok: true,
                    uid: 1002,
                    exitCode: 0,
                    stdout: malformed
                      ? 'malformed inert text'
                      : JSON.stringify({
                          verdict: 'APPROVE',
                          findings: [],
                          reviewed_head_sha: head,
                        }),
                    stderr: '',
                    timedOut: false,
                    outputTruncated: false,
                    fableEvidence: {
                      policy: FABLE_POLICY,
                      provider: 'claude',
                      model: FABLE_MODEL,
                      executableSha256: 'a'.repeat(64),
                      version: 'synthetic',
                      accountBindingId: 'ultra',
                      invocationId: id,
                      requestId: context.requestId,
                      workerId: context.workerId,
                      fencingToken: 1,
                      headSha: head,
                      permitId: 'one',
                      credentialEgressPassed: true,
                    },
                  })
                );
                return submitReviewerBrokerJob(job, {
                  ...options,
                  env: { OVERSEER_REVIEW_SPOOL: root },
                });
              }
            );
          },
        });
        const bodies: { body: string; commitId?: string; event: string }[] = [];
        const isolated = {
          ...production,
          currentHeadSha: async () => head,
          isDraft: async () => false,
          recordExecutionProof: async () => undefined,
          recordReceipt: async () => undefined,
          recordApprovalVerdict: async () => undefined,
          submitReview: async (request: Parameters<typeof production.submitReview>[0]) => {
            bodies.push(request);
            return {
              submitted: true,
              review: {
                id: 1,
                url: 'https://example.invalid/1',
                commitSha: head,
                state: request.event === 'APPROVE' ? 'APPROVED' : 'CHANGES_REQUESTED',
              },
            };
          },
        };
        const result = await runAndSubmitReview(work, isolated);
        expect(result.disposition).toBe('approved');
        expect(calls).toBe(1);
        expect(bodies[0].commitId).toBe(head);
        expect(bodies[0].event).toBe('APPROVE');
        expect(bodies[0].body).toContain(
          'Observed reviewer: claude/claude-fable-5-2 (claude_model_only_broker_v1).'
        );
        malformed = true;
        const invalid = await runAndSubmitReview(work, isolated);
        expect(invalid.disposition).toBe('changes_requested');
        expect(calls).toBe(2);
        expect(bodies[1].body).toContain('Reviewer diagnostic (sanitized):');
        expect(bodies[1].body).not.toContain('malformed inert text');
        custody = false;
        expect((await runAndSubmitReview(work, isolated)).disposition).toBe('review_incomplete');
        expect(calls).toBe(2);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );
});
