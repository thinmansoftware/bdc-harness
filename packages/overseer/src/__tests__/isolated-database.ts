/**
 * Per-test SQLite isolation for aggregate `bun test` runs.
 *
 * Bun executes every file in one process and shares getDatabase(). A test that
 * closes that singleton or repoints ARCHON_HOME breaks other files. This helper
 * opens a private adapter and exposes it only on the calling async context, so
 * the process-wide connection and environment stay untouched.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spyOn } from 'bun:test';
import { removeTempDirWithRetry } from '@archon/core/test/temp-dir';
import { SqliteAdapter } from '@archon/core/db/adapters/sqlite';
import type { IDatabase } from '@archon/core/db/adapters/types';
import * as connection from '@archon/core/db/connection';

interface IsolatedDatabaseSlot {
  storage: AsyncLocalStorage<IDatabase>;
  router: (() => IDatabase) | undefined;
}

const STORAGE_KEY = '__archonOverseerIsolatedDatabase';

function slot(): IsolatedDatabaseSlot {
  const globals = globalThis as Record<string, IsolatedDatabaseSlot | undefined>;
  const existing = globals[STORAGE_KEY];
  if (existing) return existing;
  const created: IsolatedDatabaseSlot = {
    storage: new AsyncLocalStorage<IDatabase>(),
    router: undefined,
  };
  globals[STORAGE_KEY] = created;
  return created;
}

function ensureRouter(state: IsolatedDatabaseSlot): void {
  if (state.router !== undefined && connection.getDatabase === state.router) return;
  const previous = connection.getDatabase.bind(connection);
  spyOn(connection, 'getDatabase').mockImplementation(() => {
    return state.storage.getStore() ?? previous();
  });
  state.router = connection.getDatabase;
}

/** Route getDatabase() to this adapter for the async extent of `work` only. */
export async function runWithBoundDatabase<T>(
  database: IDatabase,
  work: () => Promise<T>
): Promise<T> {
  const state = slot();
  ensureRouter(state);
  return state.storage.run(database, work);
}

export async function withIsolatedDatabase<T>(work: () => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'archon-overseer-isolated-'));
  const database = new SqliteAdapter(join(home, 'archon.db'));
  try {
    return await runWithBoundDatabase(database, work);
  } finally {
    await database.close();
    removeTempDirWithRetry(home);
  }
}
