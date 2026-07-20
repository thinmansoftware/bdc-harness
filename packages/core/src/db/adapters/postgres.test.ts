import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// ---- pg mock setup --------------------------------------------------------
// Must be declared before importing the module under test so that the mock
// is in place when PostgresAdapter's constructor calls `new Pool(...)`.

type MockQueryFn = (
  sql: string,
  params?: unknown[]
) => Promise<{ rows: unknown[]; rowCount: number }>;

interface MockClient {
  query: MockQueryFn;
  release: () => void;
}

// Mutable state shared between the mock factory and individual tests
let mockPoolQuery: MockQueryFn = async () => ({ rows: [], rowCount: 0 });
let mockClient: MockClient = {
  query: async () => ({ rows: [], rowCount: 0 }),
  release: () => {},
};
let poolErrorHandler: ((err: Error) => void) | undefined;

const MockPool = mock(function MockPool(_config: unknown) {
  return {
    query: (sql: string, params?: unknown[]) => mockPoolQuery(sql, params),
    connect: async () => mockClient,
    on: (event: string, handler: (err: Error) => void) => {
      if (event === 'error') {
        poolErrorHandler = handler;
      }
    },
    end: async () => {},
  };
});

mock.module('pg', () => ({
  Pool: MockPool,
}));

// ---- also mock @archon/paths so logger calls don't blow up ----------------
mock.module('@archon/paths', () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    fatal: () => {},
    debug: () => {},
    trace: () => {},
  }),
}));

// ---- import after mocks are registered ------------------------------------
import { PostgresAdapter, postgresDialect } from './postgres';

// ---------------------------------------------------------------------------

describe('PostgresAdapter', () => {
  let adapter: PostgresAdapter;

  beforeEach(() => {
    // Reset shared mock state before each test
    mockPoolQuery = async () => ({ rows: [], rowCount: 0 });
    mockClient = {
      query: async () => ({ rows: [], rowCount: 0 }),
      release: () => {},
    };
    poolErrorHandler = undefined;

    adapter = new PostgresAdapter('postgresql://localhost:5432/testdb');
  });

  describe('Smart Cauldron reliability schema', () => {
    test('numbered migration defines the same additive tables and indexes as SQLite', () => {
      const migration = ['024_smart_cauldron_reliability.sql', '026_supervisor_incidents.sql']
        .map(file =>
          readFileSync(resolve(import.meta.dir, '../../../../../migrations', file), 'utf8')
        )
        .join('\n');

      for (const table of [
        'remote_agent_run_authorities',
        'remote_agent_run_leases',
        'remote_agent_provider_attempts',
        'remote_agent_run_outcomes',
        'remote_agent_scheduled_waits',
        'remote_agent_supervisor_incidents',
        'remote_agent_supervisor_observations',
        'remote_agent_supervisor_repair_leases',
        'remote_agent_supervisor_actions',
      ]) {
        expect(migration).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
      }
      for (const index of [
        'idx_reliability_active_leases',
        'idx_reliability_attempts_run_node',
        'idx_reliability_due_waits',
        'idx_supervisor_observations_incident',
        'idx_supervisor_actions_incident',
        'idx_supervisor_repair_leases_expiry',
      ]) {
        expect(migration).toContain(`CREATE INDEX IF NOT EXISTS ${index}`);
      }
    });
  });

  describe('Board authority foundation schema', () => {
    test('numbered migration, combined schema, and SQLite bootstrap define authority tables', () => {
      const migration = readFileSync(
        resolve(import.meta.dir, '../../../../../migrations', '029_board_authority_foundation.sql'),
        'utf8'
      );
      const combined = readFileSync(
        resolve(import.meta.dir, '../../../../../migrations', '000_combined.sql'),
        'utf8'
      );
      const sqlite = readFileSync(resolve(import.meta.dir, 'sqlite.ts'), 'utf8');

      for (const schema of [migration, combined, sqlite]) {
        expect(schema).toContain('CREATE TABLE IF NOT EXISTS board_xo_leases');
        expect(schema).toContain('CREATE TABLE IF NOT EXISTS board_audit_events');
        expect(schema).toContain('idx_board_xo_leases_active');
        expect(schema).toContain('idx_board_audit_events_created');
        expect(schema).toContain('idx_board_audit_events_motion');
        expect(schema).toContain('trg_board_audit_events_no_update');
        expect(schema).toContain('trg_board_audit_events_no_delete');
        expect(schema).toContain("seat_id IN ('john', 'general', 'xo')");
        expect(schema).toContain('holder_token_hash');
        expect(schema).toContain('fencing_token');
      }
    });
  });

  describe('Board motion dispatch schema', () => {
    test('numbered migration, combined schema, and SQLite bootstrap define resolution fields', () => {
      const migration = readFileSync(
        resolve(import.meta.dir, '../../../../../migrations', '031_board_motion_dispatch.sql'),
        'utf8'
      );
      const combined = readFileSync(
        resolve(import.meta.dir, '../../../../../migrations', '000_combined.sql'),
        'utf8'
      );
      const sqlite = readFileSync(resolve(import.meta.dir, 'sqlite.ts'), 'utf8');

      for (const schema of [migration, combined, sqlite]) {
        expect(schema).toContain('recipient_alias');
        expect(schema).toContain('motion_id');
        expect(schema).toContain('motion_revision_sha');
        expect(schema).toContain('resolved_recipient');
        expect(schema).toContain('resolved_xo_lease_id');
        expect(schema).toContain('resolved_xo_fencing_token');
        expect(schema).toContain('resolved_at');
        expect(schema).toContain('idx_dispatch_board_pending');
        expect(schema).toContain('board_motion');
        expect(schema).toContain('board_petition_delivered');
      }
      // The M-27A dispatch migration must never mention execution claims; that
      // feature is owned by the M-27B migration. The combined and SQLite
      // surfaces legitimately carry the execution-claim tables (see the
      // "Board execution claims schema" block below), so the negative
      // assertion applies only to the numbered dispatch migration.
      expect(migration).not.toContain('board_execution_claim');
    });
  });

  describe('Board execution claims schema', () => {
    test('numbered migration, combined schema, and SQLite bootstrap define claim tables', () => {
      const migration = readFileSync(
        resolve(import.meta.dir, '../../../../../migrations', '032_board_execution_claims.sql'),
        'utf8'
      );
      const combined = readFileSync(
        resolve(import.meta.dir, '../../../../../migrations', '000_combined.sql'),
        'utf8'
      );
      const sqlite = readFileSync(resolve(import.meta.dir, 'sqlite.ts'), 'utf8');

      for (const schema of [migration, combined, sqlite]) {
        expect(schema).toContain('CREATE TABLE IF NOT EXISTS board_execution_claims');
        expect(schema).toContain('CREATE TABLE IF NOT EXISTS board_execution_claim_events');
        expect(schema).toContain('idx_board_execution_claims_active');
        expect(schema).toContain('idx_board_execution_claim_events_claim');
        expect(schema).toContain('trg_board_execution_claim_events_no_update');
        expect(schema).toContain('trg_board_execution_claim_events_no_delete');
        // Action identity + idempotency uniqueness make concurrent acquire atomic.
        expect(schema).toContain('action_key');
        expect(schema).toContain('idempotency_key');
        expect(schema).toContain('board_execution_claims_action_identity_unique');
        expect(schema).toContain('board_execution_claim_events_sequence_unique');
        // Closed enums.
        expect(schema).toContain("action_kind = 'production_deploy'");
        expect(schema).toContain("environment = 'production'");
        expect(schema).toContain("status IN ('active', 'released', 'completed')");
        expect(schema).toContain('execution_fencing_token');
        expect(schema).toContain('effect_attempt_state');
        expect(schema).toContain('reconciliation_status');
        // Pre-claim board-audit events extend the foundation closed check.
        expect(schema).toContain('execution_claim_authority_rejected');
        expect(schema).toContain('manual_initiation_recorded');
      }
      // Hard separation: the numbered M-27B migration references no Dispatch
      // table. (The combined/sqlite surfaces legitimately contain the Dispatch
      // schema from earlier migrations, so this applies only to 032.)
      expect(migration).not.toContain('agent_dispatch_messages');
    });
  });

  describe('Recovery execution claims schema', () => {
    test('numbered migration, combined schema, and SQLite bootstrap define claim tables', () => {
      const migration = readFileSync(
        resolve(import.meta.dir, '../../../../../migrations', '038_recovery_execution_claims.sql'),
        'utf8'
      );
      const combined = readFileSync(
        resolve(import.meta.dir, '../../../../../migrations', '000_combined.sql'),
        'utf8'
      );
      const sqlite = readFileSync(resolve(import.meta.dir, 'sqlite.ts'), 'utf8');

      for (const schema of [migration, combined, sqlite]) {
        expect(schema).toContain('CREATE TABLE IF NOT EXISTS remote_agent_recovery_execution_claims');
        expect(schema).toContain(
          'CREATE TABLE IF NOT EXISTS remote_agent_recovery_execution_claim_events'
        );
        expect(schema).toContain('idx_recovery_execution_claims_active');
        expect(schema).toContain('idx_recovery_execution_claim_events_claim');
        expect(schema).toContain('trg_recovery_execution_claim_events_no_update');
        expect(schema).toContain('trg_recovery_execution_claim_events_no_delete');
        expect(schema).toContain('recovery_execution_claims_identity_unique');
        expect(schema).toContain('recovery_execution_claim_events_sequence_unique');
        expect(schema).toContain("actor_kind IN ('overseer', 'conductor', 'manual')");
        expect(schema).toContain("status IN ('active', 'released', 'completed')");
        expect(schema).toContain('execution_fencing_token');
        expect(schema).toContain('effect_attempt_state');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Static properties
  // -------------------------------------------------------------------------

  describe('properties', () => {
    test('dialect is "postgres"', () => {
      expect(adapter.dialect).toBe('postgres');
    });

    test('sql dialect is postgresDialect', () => {
      expect(adapter.sql).toBe(postgresDialect);
    });
  });

  // -------------------------------------------------------------------------
  // query()
  // -------------------------------------------------------------------------

  describe('query()', () => {
    test('delegates to pool.query and returns rows and rowCount', async () => {
      const fakeRows = [
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
      ];
      mockPoolQuery = async () => ({ rows: fakeRows, rowCount: 2 });

      const result = await adapter.query<{ id: number; name: string }>('SELECT * FROM users');
      expect(result.rows).toEqual(fakeRows);
      expect(result.rowCount).toBe(2);
    });

    test('forwards sql and params to pool.query', async () => {
      let capturedSql = '';
      let capturedParams: unknown[] | undefined;

      mockPoolQuery = async (sql, params) => {
        capturedSql = sql;
        capturedParams = params;
        return { rows: [], rowCount: 0 };
      };

      await adapter.query('SELECT * FROM users WHERE id = $1', [42]);
      expect(capturedSql).toBe('SELECT * FROM users WHERE id = $1');
      expect(capturedParams).toEqual([42]);
    });

    test('returns rowCount 0 when pool returns null rowCount', async () => {
      // pg can return rowCount: null for some query types
      mockPoolQuery = async () => ({ rows: [], rowCount: null as unknown as number });

      const result = await adapter.query('SELECT 1');
      expect(result.rowCount).toBe(0);
    });

    test('returns empty rows array when pool returns no rows', async () => {
      mockPoolQuery = async () => ({ rows: [], rowCount: 0 });

      const result = await adapter.query('DELETE FROM users WHERE id = $1', [99]);
      expect(result.rows).toHaveLength(0);
      expect(result.rowCount).toBe(0);
    });

    test('propagates errors thrown by pool.query', async () => {
      mockPoolQuery = async () => {
        throw new Error('connection lost');
      };

      await expect(adapter.query('SELECT 1')).rejects.toThrow('connection lost');
    });

    test('query without params passes undefined to pool', async () => {
      let capturedParams: unknown[] | undefined = ['sentinel'];

      mockPoolQuery = async (_sql, params) => {
        capturedParams = params;
        return { rows: [], rowCount: 0 };
      };

      await adapter.query('SELECT NOW()');
      expect(capturedParams).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // withTransaction()
  // -------------------------------------------------------------------------

  describe('withTransaction()', () => {
    test('issues BEGIN and COMMIT on success', async () => {
      const issued: string[] = [];
      mockClient = {
        query: async sql => {
          issued.push(sql);
          return { rows: [], rowCount: 0 };
        },
        release: () => {},
      };

      await adapter.withTransaction(async () => 'ok');

      expect(issued[0]).toBe('BEGIN');
      expect(issued[issued.length - 1]).toBe('COMMIT');
      expect(issued).not.toContain('ROLLBACK');
    });

    test('issues BEGIN and ROLLBACK on error, then re-throws', async () => {
      const issued: string[] = [];
      mockClient = {
        query: async sql => {
          issued.push(sql);
          return { rows: [], rowCount: 0 };
        },
        release: () => {},
      };

      const boom = new Error('query failed inside tx');
      await expect(
        adapter.withTransaction(async () => {
          throw boom;
        })
      ).rejects.toThrow('query failed inside tx');

      expect(issued[0]).toBe('BEGIN');
      expect(issued).toContain('ROLLBACK');
      expect(issued).not.toContain('COMMIT');
    });

    test('always releases client on success', async () => {
      let released = false;
      mockClient = {
        query: async () => ({ rows: [], rowCount: 0 }),
        release: () => {
          released = true;
        },
      };

      await adapter.withTransaction(async () => 'done');
      expect(released).toBe(true);
    });

    test('always releases client on error', async () => {
      let released = false;
      mockClient = {
        query: async () => ({ rows: [], rowCount: 0 }),
        release: () => {
          released = true;
        },
      };

      await expect(
        adapter.withTransaction(async () => {
          throw new Error('tx error');
        })
      ).rejects.toThrow('tx error');

      expect(released).toBe(true);
    });

    test('txQuery returns rows and rowCount from client', async () => {
      const fakeRows = [{ x: 42 }];
      mockClient = {
        query: async (sql: string) => {
          if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [], rowCount: 0 };
          return { rows: fakeRows, rowCount: 1 };
        },
        release: () => {},
      };

      const result = await adapter.withTransaction(async txQuery => {
        return txQuery<{ x: number }>('SELECT 42 AS x');
      });

      expect(result.rows).toEqual(fakeRows);
      expect(result.rowCount).toBe(1);
    });

    test('txQuery forwards sql and params to client.query', async () => {
      let capturedSql = '';
      let capturedParams: unknown[] | undefined;

      mockClient = {
        query: async (sql: string, params?: unknown[]) => {
          if (sql !== 'BEGIN' && sql !== 'COMMIT') {
            capturedSql = sql;
            capturedParams = params;
          }
          return { rows: [], rowCount: 0 };
        },
        release: () => {},
      };

      await adapter.withTransaction(async txQuery => {
        await txQuery('UPDATE users SET name = $1 WHERE id = $2', ['Bob', 7]);
        return undefined;
      });

      expect(capturedSql).toBe('UPDATE users SET name = $1 WHERE id = $2');
      expect(capturedParams).toEqual(['Bob', 7]);
    });

    test('txQuery rowCount defaults to 0 when client returns null rowCount', async () => {
      mockClient = {
        query: async (sql: string) => {
          if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [], rowCount: 0 };
          return { rows: [], rowCount: null as unknown as number };
        },
        release: () => {},
      };

      const result = await adapter.withTransaction(async txQuery => {
        return txQuery('DELETE FROM users WHERE 1=0');
      });

      expect(result.rowCount).toBe(0);
    });

    test('returns value from callback on success', async () => {
      mockClient = {
        query: async () => ({ rows: [], rowCount: 0 }),
        release: () => {},
      };

      const value = await adapter.withTransaction(async () => 'transaction-result');
      expect(value).toBe('transaction-result');
    });

    test('still releases client when ROLLBACK itself throws', async () => {
      let released = false;
      let callCount = 0;

      mockClient = {
        query: async (sql: string) => {
          callCount++;
          if (sql === 'ROLLBACK') throw new Error('rollback failed');
          return { rows: [], rowCount: 0 };
        },
        release: () => {
          released = true;
        },
      };

      await expect(
        adapter.withTransaction(async () => {
          throw new Error('original error');
        })
      ).rejects.toThrow('original error');

      expect(released).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // close()
  // -------------------------------------------------------------------------

  describe('close()', () => {
    test('calls pool.end() without throwing', async () => {
      await expect(adapter.close()).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Pool error handler
  // -------------------------------------------------------------------------

  describe('pool error event', () => {
    test('registers an error event handler on the pool', () => {
      // poolErrorHandler is captured by MockPool.on() during constructor
      expect(typeof poolErrorHandler).toBe('function');
    });

    test('error handler does not throw when called', () => {
      // The handler should log, not rethrow (event handlers cannot throw usefully)
      expect(() => {
        if (poolErrorHandler) poolErrorHandler(new Error('pool went away'));
      }).not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------

describe('postgresDialect', () => {
  describe('generateUuid()', () => {
    test('returns a valid UUID v4 string', () => {
      const uuid = postgresDialect.generateUuid();
      // UUID v4 pattern: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
      expect(uuid).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
    });

    test('generates unique UUIDs on successive calls', () => {
      const a = postgresDialect.generateUuid();
      const b = postgresDialect.generateUuid();
      expect(a).not.toBe(b);
    });
  });

  describe('now()', () => {
    test('returns "NOW()"', () => {
      expect(postgresDialect.now()).toBe('NOW()');
    });
  });

  describe('jsonMerge()', () => {
    test('returns correct merge expression', () => {
      expect(postgresDialect.jsonMerge('metadata', 1)).toBe('metadata || $1::jsonb');
    });

    test('uses provided param index', () => {
      expect(postgresDialect.jsonMerge('data', 3)).toBe('data || $3::jsonb');
    });

    test('uses provided column name', () => {
      expect(postgresDialect.jsonMerge('extra_fields', 2)).toBe('extra_fields || $2::jsonb');
    });
  });

  describe('jsonArrayContains()', () => {
    test('returns correct containment expression', () => {
      expect(postgresDialect.jsonArrayContains('tags', 'labels', 1)).toBe("tags->'labels' ? $1");
    });

    test('uses provided param index', () => {
      expect(postgresDialect.jsonArrayContains('data', 'ids', 5)).toBe("data->'ids' ? $5");
    });

    test('uses provided column and path', () => {
      expect(postgresDialect.jsonArrayContains('meta', 'related_issues', 2)).toBe(
        "meta->'related_issues' ? $2"
      );
    });
  });

  describe('nowMinusDays()', () => {
    test('returns correct interval expression', () => {
      expect(postgresDialect.nowMinusDays(1)).toBe("NOW() - ($1 || ' days')::INTERVAL");
    });

    test('uses provided param index', () => {
      expect(postgresDialect.nowMinusDays(4)).toBe("NOW() - ($4 || ' days')::INTERVAL");
    });
  });

  describe('daysSince()', () => {
    test('returns correct epoch extraction expression', () => {
      expect(postgresDialect.daysSince('created_at')).toBe(
        'EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400'
      );
    });

    test('uses provided column name', () => {
      expect(postgresDialect.daysSince('updated_at')).toBe(
        'EXTRACT(EPOCH FROM (NOW() - updated_at)) / 86400'
      );
    });
  });
});
