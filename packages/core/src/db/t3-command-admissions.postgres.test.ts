/**
 * WO-HARNESS-T3-FIRE-RUN-OUTCOME-REPLY-01 (Amendment 2), Tests 19-22: real
 * PostgreSQL engine proof for migration 070 and the combined schema.
 *
 * Runs only in the dispatch-phase15-postgres CI job. It requires
 * DISPATCH_POSTGRES_PHASE15_TEST_URL and THROWS when it is missing or not a
 * loopback test database, so a missing database fails the run; it never skips.
 * Each case uses its own synthetic schema and executes the ACTUAL migration
 * text read from disk.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { randomUUID } from 'crypto';
import { PostgresAdapter } from './adapters/postgres';

function requireLoopbackUrl(raw: string | undefined): string {
  if (!raw) throw new Error('DISPATCH_POSTGRES_PHASE15_TEST_URL is required');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('DISPATCH_POSTGRES_PHASE15_TEST_URL is invalid');
  }
  const host = url.hostname.toLowerCase();
  const allowed = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (!allowed) {
    throw new Error('DISPATCH_POSTGRES_PHASE15_TEST_URL must target loopback only');
  }
  const databaseName = url.pathname.replace(/^\//, '');
  if (databaseName !== 'phase15' && !databaseName.endsWith('_test')) {
    throw new Error('DISPATCH_POSTGRES_PHASE15_TEST_URL must target a test database');
  }
  return raw;
}

function withSchemaSearchPath(raw: string, schema: string): string {
  const url = new URL(raw);
  url.searchParams.set('options', `-c search_path=${schema}`);
  return url.toString();
}

const MIGRATION_070 = readFileSync(
  resolve(import.meta.dir, '../../../../migrations/070_t3_command_outcome.sql'),
  'utf8'
);
const COMBINED = readFileSync(
  resolve(import.meta.dir, '../../../../migrations/000_combined.sql'),
  'utf8'
);

// The migration 067 shape of the table, before 070.
const OLD_T3_TABLE = `
  CREATE TABLE t3_command_admissions (
    request_id TEXT PRIMARY KEY,
    actor_principal_id TEXT NOT NULL,
    verb TEXT NOT NULL CHECK (verb IN ('fire', 'cancel-own', 'approve')),
    payload_sha256 TEXT NOT NULL,
    wo_id TEXT,
    project TEXT,
    target_run_id TEXT,
    pr_ref TEXT,
    head_sha TEXT,
    thread_id TEXT,
    source_message_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('reserved', 'admitted', 'refused', 'unknown')),
    status_code INTEGER,
    code TEXT,
    cascade_id TEXT,
    run_id TEXT,
    reply_message_id TEXT,
    effect_started_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;

const T0 = '2026-11-14T23:30:00.000Z';

let baseUrl = '';
let adminDb: PostgresAdapter;
const schemas: string[] = [];

async function newSchema(tag: string): Promise<{ name: string; db: PostgresAdapter }> {
  const name = `t3outcome_${tag}_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  await adminDb.query(`CREATE SCHEMA ${name}`);
  schemas.push(name);
  return { name, db: new PostgresAdapter(withSchemaSearchPath(baseUrl, name)) };
}

async function insertRow(
  db: PostgresAdapter,
  requestId: string,
  withMarker: boolean
): Promise<void> {
  const columns = withMarker ? ', outcome_message_id' : '';
  const value = withMarker ? ', NULL' : '';
  await db.query(
    `INSERT INTO t3_command_admissions
      (request_id, actor_principal_id, verb, payload_sha256, wo_id, project, thread_id,
       source_message_id, state, status_code, code, cascade_id, run_id, reply_message_id,
       created_at, updated_at${columns})
     VALUES ($1, 't3-bridge', 'fire', 'seed', $2, 'bdc-xo', $3, $4, 'admitted', 200, 'ok',
             $5, $6, $7, $8, $8${value})`,
    [
      requestId,
      `WO-XO-${requestId}-01`,
      `th-${requestId}`,
      `src-${requestId}`,
      `C-${requestId}`,
      `R-${requestId}`,
      `rep-${requestId}`,
      T0,
    ]
  );
}

async function columnsOf(schema: string): Promise<string[]> {
  const result = await adminDb.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 't3_command_admissions'`,
    [schema]
  );
  return result.rows.map(row => row.column_name);
}

async function oldRows(db: PostgresAdapter): Promise<Record<string, unknown>[]> {
  const result = await db.query<Record<string, unknown>>(
    `SELECT request_id, actor_principal_id, verb, payload_sha256, wo_id, project, thread_id,
            source_message_id, state, status_code, code, cascade_id, run_id,
            reply_message_id, created_at, updated_at
       FROM t3_command_admissions ORDER BY request_id`
  );
  return result.rows;
}

async function markers(db: PostgresAdapter): Promise<Record<string, string | null>> {
  const result = await db.query<{ request_id: string; outcome_message_id: string | null }>(
    'SELECT request_id, outcome_message_id FROM t3_command_admissions ORDER BY request_id'
  );
  return Object.fromEntries(result.rows.map(row => [row.request_id, row.outcome_message_id]));
}

beforeAll(() => {
  baseUrl = requireLoopbackUrl(process.env.DISPATCH_POSTGRES_PHASE15_TEST_URL);
  adminDb = new PostgresAdapter(baseUrl);
});

afterAll(async () => {
  for (const name of schemas) {
    try {
      await adminDb.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`);
    } catch {
      /* ignore */
    }
  }
  await adminDb?.close();
});

describe('migration 070 on PostgreSQL', () => {
  test('Tests 19, 20, 21: fault after ALTER rolls back; retry backfills; repeat keeps new rows', async () => {
    const { name, db } = await newSchema('fault');
    try {
      await db.query(OLD_T3_TABLE);
      await insertRow(db, 'OLD1', false);
      await insertRow(db, 'OLD2', false);
      await db.query(`
        CREATE FUNCTION t3_outcome_fault() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'outcome_backfill_fault';
        END;
        $$
      `);
      await db.query(`
        CREATE TRIGGER t3_outcome_fault BEFORE UPDATE ON t3_command_admissions
        FOR EACH ROW EXECUTE FUNCTION t3_outcome_fault()
      `);
      const before = await oldRows(db);

      // Test 19: the backfill UPDATE fails AFTER the ALTER; the whole statement rolls back.
      await expect(db.query(MIGRATION_070)).rejects.toThrow('outcome_backfill_fault');
      expect(await columnsOf(name)).not.toContain('outcome_message_id');
      expect(await oldRows(db)).toEqual(before);

      // Test 20: without the fault, the column is added and both old rows are marked.
      await db.query('DROP TRIGGER t3_outcome_fault ON t3_command_admissions');
      await db.query(MIGRATION_070);
      expect(await columnsOf(name)).toContain('outcome_message_id');
      expect(await markers(db)).toEqual({
        OLD1: 'pre-outcome-backfill',
        OLD2: 'pre-outcome-backfill',
      });

      // Test 21: a new row keeps its null marker when 070 runs again.
      await insertRow(db, 'NEW1', true);
      await db.query(MIGRATION_070);
      expect(await markers(db)).toEqual({
        NEW1: null,
        OLD1: 'pre-outcome-backfill',
        OLD2: 'pre-outcome-backfill',
      });
    } finally {
      await db.close();
    }
  });

  test('Test 22: a fresh combined schema has the column and re-runs cleanly', async () => {
    const { name, db } = await newSchema('fresh');
    try {
      await db.query(COMBINED);
      expect(await columnsOf(name)).toContain('outcome_message_id');
      await insertRow(db, 'MID1', true);
      await db.query(COMBINED);
      expect(await markers(db)).toEqual({ MID1: null });
    } finally {
      await db.close();
    }
  });
});
