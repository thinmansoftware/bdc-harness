import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from 'bun:test';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { createHash, randomUUID } from 'crypto';
import { PostgresAdapter } from './adapters/postgres';
import { DispatchNonSystemCapability } from './dispatch-sender-authority';

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

let db: PostgresAdapter;
let adminDb: PostgresAdapter;
const schemaName = `phase15_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

mock.module('./connection', () => ({
  getDatabase: () => db,
}));

const { createAuthenticatedMessage, acknowledgeMessage, addressMessage, getMessage } =
  await import('./dispatch');
import type { DispatchQueryExecutor, XoLeaseBind } from './dispatch';

function setSenderAuthMode(mode: 'enforce'): void {
  process.env.DISPATCH_SENDER_AUTH_MODE = mode;
}

function testAuthenticatedCapability(principalId: string, sender: string) {
  const token = `test-token-${principalId}-${sender}`;
  const priorRegistry = process.env.DISPATCH_PRINCIPALS_JSON;
  const priorMode = process.env.DISPATCH_SENDER_AUTH_MODE;
  try {
    setSenderAuthMode('enforce');
    process.env.DISPATCH_PRINCIPALS_JSON = JSON.stringify([
      {
        credential_id: `test-${principalId}-${sender}`,
        principal_id: principalId,
        token_sha256: createHash('sha256').update(token).digest('hex'),
        status: 'active',
        send_as: [sender],
        receive_as: [sender],
        roles: ['send', 'receive'],
      },
    ]);
    return DispatchNonSystemCapability.fromAuthenticatedRequest({
      principal_id: principalId,
      token,
      requested_sender: sender,
    });
  } finally {
    if (priorRegistry === undefined) delete process.env.DISPATCH_PRINCIPALS_JSON;
    else process.env.DISPATCH_PRINCIPALS_JSON = priorRegistry;
    if (priorMode === undefined) delete process.env.DISPATCH_SENDER_AUTH_MODE;
    else process.env.DISPATCH_SENDER_AUTH_MODE = priorMode;
  }
}

beforeAll(async () => {
  const url = requireLoopbackUrl(process.env.DISPATCH_POSTGRES_PHASE15_TEST_URL);
  adminDb = new PostgresAdapter(url);
  await adminDb.query(`CREATE SCHEMA ${schemaName}`);
  db = new PostgresAdapter(withSchemaSearchPath(url, schemaName));
  if (db.dialect !== 'postgres') throw new Error('expected postgres dialect');
  await db.query(`
    CREATE TABLE dispatch_principals (
      principal_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      delivery_mode TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE
    )
  `);
  await db.query(`
    INSERT INTO dispatch_principals (principal_id, display_name, delivery_mode, active) VALUES
      ('claude', 'Claude', 'worker_poll', TRUE),
      ('codex', 'Codex', 'worker_poll', TRUE),
      ('fusion', 'Fusion', 'worker_poll', TRUE),
      ('xo', 'XO', 'drain_on_start', TRUE)
  `);
  await db.query(`
    CREATE TABLE agent_dispatch_messages (
      id UUID PRIMARY KEY,
      correlation_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      task_type TEXT NOT NULL,
      sender TEXT NOT NULL,
      recipient TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      result_body TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      claimed_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      not_before TIMESTAMPTZ,
      lease_owner TEXT,
      lease_expires_at TIMESTAMPTZ,
      fencing_token BIGINT NOT NULL DEFAULT 0,
      recipient_alias TEXT,
      motion_id TEXT,
      motion_revision_sha TEXT,
      resolved_recipient TEXT,
      resolved_xo_lease_id TEXT,
      resolved_xo_fencing_token BIGINT,
      resolved_at TIMESTAMPTZ,
      priority TEXT NOT NULL DEFAULT 'normal',
      task_outcome TEXT,
      acknowledged_at TIMESTAMPTZ,
      acknowledged_by TEXT,
      addressed_at TIMESTAMPTZ,
      addressed_by TEXT,
      escalated_tg_at TIMESTAMPTZ,
      escalated_sms_at TIMESTAMPTZ,
      subject_key TEXT,
      repeat_reason TEXT,
      route_disposition TEXT,
      supersedes_id UUID
    )
  `);
  await db.query(`
    CREATE TABLE board_xo_leases (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      lease_id UUID NOT NULL UNIQUE,
      principal_id TEXT NOT NULL,
      seat_id TEXT NOT NULL,
      holder_id TEXT NOT NULL,
      holder_token_hash TEXT NOT NULL,
      fencing_token BIGINT NOT NULL,
      acquired_at TIMESTAMPTZ NOT NULL,
      renewed_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ NOT NULL,
      released_at TIMESTAMPTZ
    )
  `);
  const migration = readFileSync(
    resolve(import.meta.dir, '../../../../migrations/043_agent_messaging_phase15.sql'),
    'utf8'
  );
  await db.query(migration);
  // 047 adds the `seq` insertion counter that every newest-first read orders by
  // and that createMessage writes. Production applies migrations in order, so
  // this fixture must too -- without it the inserts under test fail with
  // 'column "seq" of relation "agent_dispatch_messages" does not exist'.
  await db.query(
    readFileSync(
      resolve(import.meta.dir, '../../../../migrations/047_agent_dispatch_seq.sql'),
      'utf8'
    )
  );
});

afterAll(async () => {
  try {
    await adminDb.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
  } catch {
    /* ignore */
  }
  await db?.close();
  await adminDb?.close();
});

describe('dispatch Phase 1.5 PostgreSQL integration', () => {
  test('refuses non-loopback and non-test database targets', () => {
    expect(() => requireLoopbackUrl('postgresql://postgres@db:5432/phase15')).toThrow(
      'must target loopback only'
    );
    expect(() => requireLoopbackUrl('postgresql://postgres@127.0.0.1:5432/production')).toThrow(
      'must target a test database'
    );
  });

  for (const action of ['acknowledge', 'address'] as const) {
    for (const turnover of ['replace', 'release'] as const) {
      for (const receiptFirst of [true, false]) {
        test(`${action} serializes XO lease ${turnover} (${receiptFirst ? 'receipt' : 'turnover'} first)`, async () => {
          const message = await createAuthenticatedMessage(
            { kind: 'system', sender: 'dispatch' },
            {
              correlation_id: randomUUID(),
              idempotency_key: randomUUID(),
              task_type: 'agent_message',
              recipient: 'xo',
              body: 'XO lease turnover.',
            }
          );
          const bind: XoLeaseBind = {
            kind: 'xo_lease',
            lease_id: '11111111-1111-4111-8111-111111111111',
            fencing_token: 9,
            holder_token_hash: createHash('sha256').update('test-holder').digest('hex'),
          };
          await db.query(
            `INSERT INTO board_xo_leases
           (id, lease_id, principal_id, seat_id, holder_id, holder_token_hash, fencing_token,
            acquired_at, expires_at)
           VALUES (1, $1, 'xo', 'xo', 'holder', $2, $3, $4, $5)`,
            [
              bind.lease_id,
              bind.holder_token_hash,
              bind.fencing_token,
              new Date().toISOString(),
              new Date(Date.now() + 60_000).toISOString(),
            ]
          );
          const data = { id: message.id, principal_id: 'xo', bind };
          if (action === 'address') expect((await acknowledgeMessage(data)).ok).toBe(true);
          const before = await getMessage(message.id);
          const turnoverDb = new PostgresAdapter(
            withSchemaSearchPath(
              requireLoopbackUrl(process.env.DISPATCH_POSTGRES_PHASE15_TEST_URL),
              schemaName
            )
          );
          const turnoverSql =
            turnover === 'replace'
              ? "UPDATE board_xo_leases SET lease_id = '22222222-2222-4222-8222-222222222222', fencing_token = fencing_token + 1 WHERE id = 1"
              : 'UPDATE board_xo_leases SET released_at = $1 WHERE id = 1';
          const turnoverParams = turnover === 'release' ? [new Date().toISOString()] : [];
          const mutate = action === 'acknowledge' ? acknowledgeMessage : addressMessage;
          const withTransaction = db.withTransaction.bind(db);
          let releaseReceipt!: () => void;
          const receiptGate = new Promise<void>(resolve => {
            releaseReceipt = resolve;
          });
          let signalLeaseLocked!: () => void;
          const leaseLocked = new Promise<void>(resolve => {
            signalLeaseLocked = resolve;
          });
          let releaseCommit!: () => void;
          const commitGate = new Promise<void>(resolve => {
            releaseCommit = resolve;
          });
          let signalBeforeCommit!: () => void;
          const beforeCommit = new Promise<void>(resolve => {
            signalBeforeCommit = resolve;
          });
          const transactionSpy = spyOn(db, 'withTransaction').mockImplementation(fn =>
            withTransaction(async query => {
              const wrappedQuery: DispatchQueryExecutor = async <T>(
                sql: string,
                params?: unknown[]
              ) => {
                const result = await query<T>(sql, params);
                if (sql.startsWith('SELECT lease_id, fencing_token, holder_token_hash')) {
                  expect(sql).toContain('FOR UPDATE');
                  if (receiptFirst) {
                    expect(result.rowCount).toBe(1);
                    signalLeaseLocked();
                    await receiptGate;
                  }
                }
                return result;
              };
              const result = await fn(wrappedQuery);
              if (receiptFirst) {
                signalBeforeCommit();
                await commitGate;
              }
              return result;
            })
          );
          let receiptPending: ReturnType<typeof mutate> | undefined;
          let turnoverPending: Promise<void> | undefined;
          try {
            if (receiptFirst) {
              receiptPending = mutate(data);
              // Fail promptly if the receipt errors or returns without acquiring the lock.
              await Promise.race([
                leaseLocked,
                receiptPending.then(() => {
                  throw new Error('Receipt completed before lease lock hook');
                }),
              ]);
              let turnoverPid = 0;
              let turnoverCompleted = false;
              turnoverPending = turnoverDb
                .withTransaction(async query => {
                  await query("SET LOCAL lock_timeout = '3s'");
                  const pid = await query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
                  turnoverPid = pid.rows[0].pid;
                  await query(turnoverSql, turnoverParams);
                })
                .then(() => {
                  turnoverCompleted = true;
                });
              // Observe the server-side lock wait so an idle connection cannot pass this test.
              const deadline = Date.now() + 1500;
              let turnoverBlocked = false;
              while (Date.now() < deadline && !turnoverBlocked) {
                await Promise.race([Bun.sleep(10), turnoverPending]);
                const blockers = await db.query<{ blocked: boolean }>(
                  'SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked',
                  [turnoverPid]
                );
                turnoverBlocked = blockers.rows[0].blocked;
                if (turnoverCompleted) break;
              }
              expect(turnoverBlocked).toBe(true);
              await Promise.race([Bun.sleep(100), turnoverPending]);
              expect(turnoverCompleted).toBe(false);
              releaseReceipt();
              await Promise.race([beforeCommit, receiptPending]);
              // The receipt UPDATE has finished, but turnover must still wait for COMMIT.
              await Promise.race([Bun.sleep(100), turnoverPending]);
              expect(turnoverCompleted).toBe(false);
              releaseCommit();
              expect((await receiptPending).ok).toBe(true);
              await turnoverPending;
              expect(turnoverCompleted).toBe(true);
              const stored = await getMessage(message.id);
              expect(stored?.acknowledged_by).toBe('xo');
              expect(stored?.acknowledged_at).not.toBeNull();
              if (action === 'address') {
                expect(stored?.addressed_by).toBe('xo');
                expect(stored?.addressed_at).not.toBeNull();
              }
            } else {
              await turnoverDb.withTransaction(async query => {
                await query(turnoverSql, turnoverParams);
              });
              await expect(mutate(data)).resolves.toEqual({
                ok: false,
                reason: 'lease_fence_stale',
              });
              expect(await getMessage(message.id)).toEqual(before);
            }
          } finally {
            releaseReceipt();
            releaseCommit();
            await Promise.allSettled([receiptPending, turnoverPending]);
            transactionSpy.mockRestore();
            await turnoverDb.close();
            await db.query('DELETE FROM board_xo_leases WHERE id = 1');
          }
        });
      }
    }
  }

  test('migration 043 removes global unique and installs both partial indexes', async () => {
    const schemaChecks = await Promise.all(
      Array.from({ length: 12 }, () =>
        db.query<{ schema: string }>('SELECT current_schema() AS schema')
      )
    );
    expect(schemaChecks.every(result => result.rows[0]?.schema === schemaName)).toBe(true);
    const indexes = await db.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = $1 AND tablename = 'agent_dispatch_messages'
       ORDER BY indexname`,
      [schemaName]
    );
    const byName = Object.fromEntries(indexes.rows.map(r => [r.indexname, r.indexdef]));
    expect(byName.uq_agent_dispatch_messages_sender_idempotency_authenticated).toContain(
      'sender_principal_id'
    );
    expect(
      byName.uq_agent_dispatch_messages_sender_idempotency_authenticated.toLowerCase()
    ).toContain('sender_principal_id is not null');
    expect(byName.uq_agent_dispatch_messages_idempotency_legacy.toLowerCase()).toContain(
      'sender_principal_id is null'
    );
    const constraints = await db.query<{ conname: string }>(
      `SELECT c.conname
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = $1
          AND t.relname = 'agent_dispatch_messages'
          AND c.contype = 'u'`,
      [schemaName]
    );
    expect(constraints.rows.map(r => r.conname)).not.toContain(
      'agent_dispatch_messages_idempotency_key_key'
    );
  });

  test('migration 043 rolls back the complete schema change after a late failure', async () => {
    const rollbackSchema = `phase15_rollback_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    await adminDb.query(`CREATE SCHEMA ${rollbackSchema}`);
    let failingDb: PostgresAdapter | undefined;
    let inspectDb: PostgresAdapter | undefined;
    try {
      const url = requireLoopbackUrl(process.env.DISPATCH_POSTGRES_PHASE15_TEST_URL);
      failingDb = new PostgresAdapter(withSchemaSearchPath(url, rollbackSchema));
      await failingDb.query(`
        CREATE TABLE agent_dispatch_messages (
          id UUID PRIMARY KEY,
          idempotency_key TEXT NOT NULL UNIQUE
        )
      `);
      const migration = readFileSync(
        resolve(import.meta.dir, '../../../../migrations/043_agent_messaging_phase15.sql'),
        'utf8'
      );
      const failingMigration = migration.replace(
        /COMMIT;\s*$/,
        'SELECT phase15_intentional_late_failure();\nCOMMIT;'
      );
      expect(failingMigration).not.toBe(migration);
      await expect(failingDb.query(failingMigration)).rejects.toThrow();
      await failingDb.close();
      failingDb = undefined;

      inspectDb = new PostgresAdapter(withSchemaSearchPath(url, rollbackSchema));
      const columns = await inspectDb.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'agent_dispatch_messages'`,
        [rollbackSchema]
      );
      expect(columns.rows.map(row => row.column_name)).not.toContain('sender_principal_id');
      const constraints = await inspectDb.query<{ conname: string }>(
        `SELECT c.conname
           FROM pg_constraint c
           JOIN pg_class t ON t.oid = c.conrelid
           JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = $1
            AND t.relname = 'agent_dispatch_messages'
            AND c.contype = 'u'`,
        [rollbackSchema]
      );
      expect(constraints.rows.map(row => row.conname)).toContain(
        'agent_dispatch_messages_idempotency_key_key'
      );
      const partialIndexes = await inspectDb.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM pg_indexes
         WHERE schemaname = $1
           AND indexname IN (
             'uq_agent_dispatch_messages_sender_idempotency_authenticated',
             'uq_agent_dispatch_messages_idempotency_legacy'
           )`,
        [rollbackSchema]
      );
      expect(partialIndexes.rows[0]?.count).toBe('0');
    } finally {
      await failingDb?.close();
      await inspectDb?.close();
      await adminDb.query(`DROP SCHEMA IF EXISTS ${rollbackSchema} CASCADE`);
    }
  });

  test('migration 056 replaces every stale route-disposition check', async () => {
    await db.query(`
      ALTER TABLE agent_dispatch_messages
        ADD CONSTRAINT route_disposition_stale_a
          CHECK (route_disposition IS NULL OR route_disposition IN ('unroutable', 'superseded')),
        ADD CONSTRAINT route_disposition_stale_b
          CHECK (route_disposition IS NULL OR route_disposition <> 'expired')
    `);
    const migration = readFileSync(
      resolve(import.meta.dir, '../../../../migrations/056_dispatch_machine_disposition.sql'),
      'utf8'
    );
    await db.query(migration);

    const checks = await db.query<{ conname: string; definition: string }>(
      `SELECT c.conname, pg_get_constraintdef(c.oid) AS definition
         FROM pg_constraint c
        WHERE c.conrelid = to_regclass('agent_dispatch_messages')
          AND c.contype = 'c'
          AND pg_get_constraintdef(c.oid) LIKE '%route_disposition%'`
    );
    expect(checks.rows).toHaveLength(1);
    expect(checks.rows[0]?.conname).not.toBe('route_disposition_stale_a');
    expect(checks.rows[0]?.conname).not.toBe('route_disposition_stale_b');
    expect(checks.rows[0]?.definition).toContain('auto_surfaced');
    expect(checks.rows[0]?.definition).toContain('expired');

    await db.query(
      `INSERT INTO agent_dispatch_messages
       (id, correlation_id, idempotency_key, task_type, sender, recipient, body, route_disposition)
       VALUES ($1, $2, $3, 'agent_message', 'xo', 'codex', 'migration 056', 'auto_surfaced')`,
      [randomUUID(), randomUUID(), `migration-056-${randomUUID()}`]
    );
  });

  test('same-principal concurrent retries return one row; different principals share keys', async () => {
    const key = `race-${randomUUID()}`;
    const mk = (principal: string, sender: string, body: string) =>
      createAuthenticatedMessage(testAuthenticatedCapability(principal, sender), {
        correlation_id: randomUUID(),
        idempotency_key: key,
        task_type: 'agent_message',
        recipient: 'codex',
        body,
      });

    const [a1, a2, a3] = await Promise.all([
      mk('alice', 'claude', 'a1'),
      mk('alice', 'claude', 'a2'),
      mk('alice', 'claude', 'a3'),
    ]);
    expect(new Set([a1.id, a2.id, a3.id]).size).toBe(1);
    expect(a1.sender_principal_id).toBe('alice');

    const bobDb = new PostgresAdapter(
      withSchemaSearchPath(
        requireLoopbackUrl(process.env.DISPATCH_POSTGRES_PHASE15_TEST_URL),
        schemaName
      )
    );
    const previous = db;
    db = bobDb;
    try {
      const bob = await mk('bob', 'fusion', 'bob');
      expect(bob.id).not.toBe(a1.id);
      expect(bob.sender_principal_id).toBe('bob');
    } finally {
      db = previous;
      await bobDb.close();
    }

    const count = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM agent_dispatch_messages WHERE idempotency_key = $1`,
      [key]
    );
    expect(count.rows[0]?.count).toBe('2');
  });

  test('fixed system retry is not suppressed by a null-principal row', async () => {
    const id = randomUUID();
    const key = `legacy-system-${randomUUID()}`;
    await db.query(
      `INSERT INTO agent_dispatch_messages
       (id, correlation_id, idempotency_key, task_type, sender, sender_principal_id,
        recipient, body, status)
       VALUES ($1, $2, $3, 'agent_message', 'taskmaster', NULL,
        'xo', 'hostile legacy taskmaster effect', 'queued')`,
      [id, randomUUID(), key]
    );

    const retried = await createAuthenticatedMessage(
      { kind: 'system', sender: 'taskmaster' },
      {
        correlation_id: randomUUID(),
        idempotency_key: key,
        task_type: 'agent_message',
        recipient: 'xo',
        body: 'authenticated taskmaster effect',
      }
    );

    expect(retried.id).not.toBe(id);
    expect(retried.sender_principal_id).toBe('system:taskmaster');
    const count = await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM agent_dispatch_messages WHERE idempotency_key = $1',
      [key]
    );
    expect(count.rows[0]?.count).toBe('2');
  });
});
