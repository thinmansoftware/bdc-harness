import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getArchonHome } from '@archon/paths';
import { PostgresAdapter } from '@archon/core/db/adapters/postgres';
import type { IDatabase, QueryResult } from '@archon/core/db/adapters/types';

/** The SELECT-only surface the card's database sources need. */
export type ReadOnlyQuery = Pick<IDatabase, 'query'>;

/** bun:sqlite opened read-only; never creates or migrates the file. */
class ReadOnlySqlite implements ReadOnlyQuery {
  constructor(private readonly db: Database) {}
  async query<T>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    // $N -> ?N keeps PostgreSQL-style numbered (and reused) placeholders.
    const stmt = this.db.prepare(sql.replace(/\$(\d+)/g, '?$1'));
    try {
      const rows = stmt.all(...(params as SQLQueryBindings[])) as T[];
      return { rows, rowCount: rows.length };
    } finally {
      stmt.finalize();
    }
  }
}

/**
 * PostgreSQL, read-only per transaction. Each query runs in its own transaction
 * opened with SET TRANSACTION READ ONLY, which ends with that transaction. Never
 * a session-level setting: on a pooled backend that outlives this card and
 * breaks every later writer handed the same connection (2026-10-28 incident).
 */
export class ReadOnlyPostgres implements ReadOnlyQuery {
  constructor(private readonly adapter: Pick<PostgresAdapter, 'withTransaction'>) {}
  async query<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
    return this.adapter.withTransaction(async q => {
      await q('SET TRANSACTION READ ONLY');
      return q<T>(sql, params);
    });
  }
}

/**
 * Run `fn` against a database connection that cannot change the database.
 *
 * Deliberately NOT core's getDatabase(): without DATABASE_URL that opens the
 * writable SqliteAdapter, whose constructor creates the file and migrates every
 * table, and whose first query installs more schemas -- so a "read-only" card
 * would mutate the operator's archon.db. Here:
 * - PostgreSQL: a dedicated pool (PostgresAdapter runs no DDL), every query in
 *   a read-only transaction (ReadOnlyPostgres), pool closed after use.
 * - SQLite: bun:sqlite opened with { readonly: true }; a missing file is an
 *   error (reported as unavailable), never created.
 */
export async function withReadOnlyDatabase<T>(fn: (db: ReadOnlyQuery) => Promise<T>): Promise<T> {
  const url = process.env.DATABASE_URL;
  if (url) {
    const pg = new PostgresAdapter(url);
    try {
      return await fn(new ReadOnlyPostgres(pg));
    } finally {
      await pg.close();
    }
  }
  const path = join(getArchonHome(), 'archon.db');
  if (!existsSync(path)) throw new Error(`no archon database at ${path}`);
  const sqlite = new Database(path, { readonly: true });
  try {
    return await fn(new ReadOnlySqlite(sqlite));
  } finally {
    sqlite.close();
  }
}
