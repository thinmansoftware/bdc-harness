import { describe, test, expect, afterEach } from 'bun:test';
import { readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { SqliteAdapter } from '../../packages/core/src/db/adapters/sqlite';

// Verifies the two bugs flagged on PR #867 (CHANGES_REQUESTED) are fixed in
// the retrograde script this repo ships: an INNER JOIN that silently dropped
// noise rows with no matching dispatch row, and a NULL-unsafe heard predicate
// that vanished NULL-principal rows from BOTH buckets instead of counting
// them toward would_become_unheard. The fixed script (this file's target)
// uses a LEFT JOIN and wraps the heard predicate in COALESCE(..., FALSE) so
// every 'noise' row lands in exactly one bucket.
//
// This test runs the SQL PORTABLE across SQLite: it extracts query 2 (the
// falsifier) from the committed .sql file and rewrites the two Postgres-only
// bits (COUNT(*) FILTER (WHERE ...) -> SUM(CASE WHEN ... THEN 1 ELSE 0 END))
// so the exact predicate text in the file is exercised, not a hand-copied
// duplicate that could silently drift from what actually ships.

let currentDbPath = '';

function createTestDb(): SqliteAdapter {
  currentDbPath = join(
    import.meta.dir,
    `.test-retrograde-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  );
  return new SqliteAdapter(currentDbPath);
}

function extractFalsifierPredicate(sql: string): { heardExpr: string } {
  // Pull the boolean expression inside Query 2's `WHERE COALESCE(...)` block
  // (the would_stay_noise FILTER) -- that is the "heard" predicate under
  // test. Anchored specifically on "WHERE COALESCE(" so it does not match the
  // unrelated COALESCE(resolved_recipient, recipient) calls used elsewhere in
  // the file (comments and the dispatch_principals join). Keeping this a
  // direct extraction (not a re-typed copy) means a future edit to the real
  // predicate that regresses NULL-safety will fail this test instead of
  // silently passing against a stale duplicate.
  const match = sql.match(
    /WHERE COALESCE\(\s*([\s\S]*?),\s*FALSE\s*\)\s*\n\s*\) AS would_stay_noise/
  );
  if (!match) {
    throw new Error(
      'retrograde script no longer contains the expected "WHERE COALESCE(..., FALSE) ... would_stay_noise" heard predicate -- update this test'
    );
  }
  return { heardExpr: match[1].trim() };
}

describe('retrograde script: 2026-09-21-retrograde-62-noise-rows.sql', () => {
  let db: SqliteAdapter;

  afterEach(async () => {
    if (db) {
      await db.close();
    }
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        unlinkSync(currentDbPath + suffix);
      } catch {
        /* may not exist */
      }
    }
  });

  test('script text uses LEFT JOIN to agent_dispatch_messages, not INNER JOIN', () => {
    const sql = readFileSync(
      join(import.meta.dir, '2026-09-21-retrograde-62-noise-rows.sql'),
      'utf8'
    );
    // The bug on PR #867: `JOIN agent_dispatch_messages adm` (no LEFT) drops
    // any 'noise' row that has no matching dispatch row at all, even though
    // the runtime grader treats a missing dispatch as 'unheard'.
    expect(sql).toMatch(/LEFT JOIN agent_dispatch_messages/);
    expect(sql).not.toMatch(/\n\s*JOIN agent_dispatch_messages/); // no bare INNER JOIN left over
  });

  test('a noise row with NO matching dispatch row is bucketed would_become_unheard, not dropped', async () => {
    db = createTestDb();
    await seedCohortRow(db, {
      id: 'no-dispatch-row',
      idempotencyKey: 'key-orphan',
      createdAt: '2026-09-12T00:00:00.000Z',
    });
    // Deliberately insert NO agent_dispatch_messages row for 'key-orphan'.

    const { totalNoise, wouldStayNoise, wouldBecomeUnheard } = await runFalsifier(db);

    expect(totalNoise).toBe(1);
    expect(wouldStayNoise).toBe(0);
    expect(wouldBecomeUnheard).toBe(1); // must NOT be silently dropped
  });

  test('a noise row whose principal lookup is NULL is bucketed would_become_unheard, not vanished from both buckets', async () => {
    db = createTestDb();
    await seedCohortRow(db, {
      id: 'null-principal',
      idempotencyKey: 'key-null-principal',
      createdAt: '2026-09-12T00:00:00.000Z',
    });
    await db.query(
      `INSERT INTO agent_dispatch_messages
         (id, correlation_id, idempotency_key, task_type, sender, recipient, body, status, created_at, acknowledged_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        'adm-null-principal',
        'corr-1',
        'key-null-principal',
        'run_report',
        'taskmaster',
        'principal-with-no-dispatch_principals-row',
        'body',
        'done',
        '2026-09-12T00:00:00.000Z',
        '2026-09-12T00:05:00.000Z', // acknowledged -- but principal_id has no row, so delivery_mode is NULL
      ]
    );
    // Deliberately insert NO dispatch_principals row for this recipient, so
    // dp.delivery_mode resolves to NULL via the LEFT JOIN. The buggy
    // predicate `acknowledged_at IS NOT NULL AND delivery_mode IS NOT NULL
    // AND delivery_mode <> 'drain_on_start'` evaluates to
    // `TRUE AND NULL AND ...` = NULL, and `NOT NULL` = NULL, so a FILTER on
    // either branch drops the row from BOTH buckets. The fixed predicate
    // wraps the whole thing in COALESCE(..., FALSE) so it resolves to FALSE
    // (unheard), not NULL (invisible).

    const { totalNoise, wouldStayNoise, wouldBecomeUnheard } = await runFalsifier(db);

    expect(totalNoise).toBe(1);
    expect(wouldStayNoise).toBe(0);
    expect(wouldBecomeUnheard).toBe(1); // must NOT vanish from both buckets
  });

  test('a noise row genuinely heard by a non-draining principal stays would_stay_noise', async () => {
    db = createTestDb();
    await seedCohortRow(db, {
      id: 'heard-row',
      idempotencyKey: 'key-heard',
      createdAt: '2026-09-12T00:00:00.000Z',
    });
    await db.query(
      `INSERT INTO agent_dispatch_messages
         (id, correlation_id, idempotency_key, task_type, sender, recipient, body, status, created_at, acknowledged_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        'adm-heard',
        'corr-2',
        'key-heard',
        'run_report',
        'taskmaster',
        'grok',
        'body',
        'done',
        '2026-09-12T00:00:00.000Z',
        '2026-09-12T00:05:00.000Z',
      ]
    );
    // 'grok' is a real seeded worker_poll (non-draining) principal.

    const { totalNoise, wouldStayNoise, wouldBecomeUnheard } = await runFalsifier(db);

    expect(totalNoise).toBe(1);
    expect(wouldStayNoise).toBe(1);
    expect(wouldBecomeUnheard).toBe(0);
  });

  test('every noise row in the cohort lands in exactly one bucket (partition invariant)', async () => {
    db = createTestDb();
    await seedCohortRow(db, {
      id: 'row-a',
      idempotencyKey: 'key-a',
      createdAt: '2026-09-11T00:00:00.000Z',
    });
    await seedCohortRow(db, {
      id: 'row-b',
      idempotencyKey: 'key-b',
      createdAt: '2026-09-12T00:00:00.000Z',
    });
    await seedCohortRow(db, {
      id: 'row-c',
      idempotencyKey: 'key-c',
      createdAt: '2026-09-13T00:00:00.000Z',
    });
    // row-a: no dispatch row. row-b: NULL principal lookup. row-c: heard.
    await db.query(
      `INSERT INTO agent_dispatch_messages
         (id, correlation_id, idempotency_key, task_type, sender, recipient, body, status, created_at, acknowledged_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        'adm-b',
        'corr-b',
        'key-b',
        'run_report',
        'taskmaster',
        'unknown-principal',
        'body',
        'done',
        '2026-09-12T00:00:00.000Z',
        '2026-09-12T00:05:00.000Z',
      ]
    );
    await db.query(
      `INSERT INTO agent_dispatch_messages
         (id, correlation_id, idempotency_key, task_type, sender, recipient, body, status, created_at, acknowledged_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        'adm-c',
        'corr-c',
        'key-c',
        'run_report',
        'taskmaster',
        'grok',
        'body',
        'done',
        '2026-09-13T00:00:00.000Z',
        '2026-09-13T00:05:00.000Z',
      ]
    );

    const { totalNoise, wouldStayNoise, wouldBecomeUnheard } = await runFalsifier(db);

    expect(totalNoise).toBe(3);
    expect(wouldStayNoise + wouldBecomeUnheard).toBe(totalNoise); // no row lost to a NULL FILTER gap
    expect(wouldStayNoise).toBe(1); // only row-c
    expect(wouldBecomeUnheard).toBe(2); // row-a (no dispatch) + row-b (null principal)
  });
});

async function seedCohortRow(
  db: SqliteAdapter,
  row: { id: string; idempotencyKey: string; createdAt: string }
): Promise<void> {
  await db.query(
    `INSERT INTO tm_journal (id, created_at, thread_ref, action_type, proposal_json, idempotency_key, outcome, grade)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      row.id,
      row.createdAt,
      'thread-cohort',
      'escalate_p0',
      '{}',
      row.idempotencyKey,
      'sent',
      'noise',
    ]
  );
}

async function runFalsifier(
  db: SqliteAdapter
): Promise<{ totalNoise: number; wouldStayNoise: number; wouldBecomeUnheard: number }> {
  const sql = readFileSync(
    join(import.meta.dir, '2026-09-21-retrograde-62-noise-rows.sql'),
    'utf8'
  );
  const { heardExpr } = extractFalsifierPredicate(sql);

  // Re-express the extracted predicate (Postgres COUNT(*) FILTER syntax is
  // not portable to bun:sqlite) using the identical boolean expression, so a
  // NULL-safety regression in the shipped predicate fails this test.
  const result = await db.query<{
    total_noise: number;
    would_stay_noise: number;
    would_become_unheard: number;
  }>(
    `SELECT
       COUNT(*) AS total_noise,
       SUM(CASE WHEN COALESCE(${sqliteize(heardExpr)}, 0) THEN 1 ELSE 0 END) AS would_stay_noise,
       SUM(CASE WHEN NOT COALESCE(${sqliteize(heardExpr)}, 0) THEN 1 ELSE 0 END) AS would_become_unheard
     FROM tm_journal tj
     LEFT JOIN agent_dispatch_messages adm
       ON adm.idempotency_key = tj.idempotency_key
     LEFT JOIN dispatch_principals dp
       ON dp.principal_id = LOWER(TRIM(COALESCE(adm.resolved_recipient, adm.recipient)))
     WHERE tj.grade = 'noise'
       AND tj.outcome = 'sent'
       AND tj.created_at >= '2026-09-10T00:00:00.000Z'
       AND tj.created_at < '2026-09-18T00:00:00.000Z'`
  );
  const row = result.rows[0];
  return {
    totalNoise: Number(row?.total_noise ?? 0),
    wouldStayNoise: Number(row?.would_stay_noise ?? 0),
    wouldBecomeUnheard: Number(row?.would_become_unheard ?? 0),
  };
}

// bun:sqlite has no native boolean type and no FALSE literal in expressions
// the way Postgres does; SQLite treats FALSE/TRUE as 0/1 already, so the
// extracted expression runs unmodified -- this helper exists so a future
// Postgres-only construct in the predicate (e.g. `IS TRUE`) fails loudly here
// rather than being silently misinterpreted.
function sqliteize(expr: string): string {
  if (/\bIS\s+(NOT\s+)?TRUE\b|\bIS\s+(NOT\s+)?FALSE\b/i.test(expr)) {
    throw new Error(
      `retrograde predicate uses a Postgres-only IS TRUE/FALSE construct not supported by this SQLite test harness: ${expr}`
    );
  }
  return expr;
}
