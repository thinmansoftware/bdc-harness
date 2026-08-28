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
const { createRealIngestDeps, createRealSubmitDeps, REVIEW_RECIPIENT, REVIEW_SENDER } =
  await import('../pr-review-wiring.ts');
const { REMEDIATION_RECIPIENT, REMEDIATION_SENDER, MAX_REMEDIATION_ATTEMPTS } =
  await import('../remediation-candidate.ts');
const { ingestPullRequestEvent } = await import('../pr-review-ingest.ts');
const { createRealOctokitClient } = await import('../adapters/github-real-deps.ts');
const { createHmac } = await import('crypto');

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

  test('two heads racing for the SAME attempt yield exactly ONE durable row', async () => {
    const deps = createRealSubmitDeps('thinman-overseer[bot]', { octokit: stubOctokit() });
    const emit = deps.emitRemediationCandidate;
    const count = deps.countPriorRemediationAttempts;
    if (!emit || !count) throw new Error('remediation deps must be wired');

    const pr = { owner: 'thinmansoftware', repo: 'shopops', prNumber: 651 };
    const candidate = (headSha: string) => ({
      kind: 'overseer_remediation_candidate' as const,
      ...pr,
      headSha,
      attempt: 1,
      maxAttempts: MAX_REMEDIATION_ATTEMPTS,
      findingClasses: ['migration_ordering'],
      verdictBody: `verdict at ${headSha}`,
      woId: null,
      owningLane: 'cauldron-lane-a',
    });

    // The race the Overseer gate caught: both read prior count 0, both compute
    // attempt 1, different heads. The UNIQUE attempt slot must arbitrate.
    const winner = await emit(candidate('c'.repeat(40)));
    const loser = await emit(candidate('d'.repeat(40)));

    expect(winner.claimed).toBe(true);
    expect(loser.claimed).toBe(false);
    expect(await count(pr)).toBe(1);
  });
});
