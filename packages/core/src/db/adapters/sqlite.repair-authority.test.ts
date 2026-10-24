import { afterEach, beforeEach, expect, test } from 'bun:test';
import { SqliteAdapter } from './sqlite';
import type { QueryResult, RunAuthoritySyncQuery } from './types';

let db: SqliteAdapter;
beforeEach(async () => {
  db = new SqliteAdapter(':memory:');
  await db.query('CREATE TABLE authority_fixture (id TEXT PRIMARY KEY)');
});
afterEach(async () => {
  await db.close();
});

async function failureOf(fn: () => Promise<unknown>): Promise<string> {
  let failure: unknown;
  try {
    await fn();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  return (failure as Error).message;
}

test('synchronous authority callback commits and expires its SQL capability', async () => {
  let escaped: RunAuthoritySyncQuery | undefined;
  expect(
    await db.withImmediateRunAuthorityTransaction(query => {
      escaped = query;
      query('INSERT INTO authority_fixture (id) VALUES ($1)', ['owned']);
      return query<{ id: string }>('SELECT id FROM authority_fixture').rows[0].id;
    })
  ).toBe('owned');
  expect(() => escaped!('INSERT INTO authority_fixture (id) VALUES ($1)', ['late'])).toThrow(
    'run_authority_query_expired'
  );
  expect((await db.query('SELECT id FROM authority_fixture')).rowCount).toBe(1);
});

test('rollback does not absorb an ordinary async write started during the callback', async () => {
  let ordinary: Promise<QueryResult<unknown>> | undefined;
  expect(
    await failureOf(() =>
      db.withImmediateRunAuthorityTransaction(query => {
        query('INSERT INTO authority_fixture (id) VALUES ($1)', ['owned']);
        ordinary = db.query('INSERT INTO authority_fixture (id) VALUES ($1)', ['ordinary']);
        throw new Error('owned failure');
      })
    )
  ).toBe('owned failure');
  expect(ordinary).toBeDefined();
  expect((await ordinary!).rowCount).toBe(1);
  expect((await db.query<{ id: string }>('SELECT id FROM authority_fixture')).rows).toEqual([
    { id: 'ordinary' },
  ]);
});

test('pre-existing raw transaction is refused and never rolled back', async () => {
  await db.query('BEGIN');
  await db.query('INSERT INTO authority_fixture (id) VALUES ($1)', ['pre-existing']);
  expect(await failureOf(() => db.withImmediateRunAuthorityTransaction(() => 'unexpected'))).toBe(
    'run_authority_transaction_already_active'
  );
  await db.query('COMMIT');
  expect((await db.query('SELECT id FROM authority_fixture')).rowCount).toBe(1);
});

test('Promise callback rolls back and its eventual expired-query rejection is consumed', async () => {
  let resumed = false;
  expect(
    await failureOf(() =>
      db.withImmediateRunAuthorityTransaction(async query => {
        query('INSERT INTO authority_fixture (id) VALUES ($1)', ['owned']);
        await Promise.resolve();
        resumed = true;
        query('INSERT INTO authority_fixture (id) VALUES ($1)', ['late']);
      })
    )
  ).toBe('run_authority_callback_must_be_synchronous');
  await Promise.resolve();
  expect(resumed).toBe(true);
  expect((await db.query('SELECT id FROM authority_fixture')).rowCount).toBe(0);
});

test('thenable callback is rejected and cannot retain transaction authority', async () => {
  expect(
    await failureOf(() =>
      db.withImmediateRunAuthorityTransaction(query => {
        query('INSERT INTO authority_fixture (id) VALUES ($1)', ['owned']);
        return {
          then: (_resolve: unknown, reject: (error: Error) => void) =>
            reject(new Error('late thenable failure')),
        };
      })
    )
  ).toBe('run_authority_callback_must_be_synchronous');
  await Promise.resolve();
  expect((await db.query('SELECT id FROM authority_fixture')).rowCount).toBe(0);
});

test('nested invocation is refused without committing or leaking either capability', async () => {
  let nested: Promise<unknown> | undefined;
  expect(
    await failureOf(() =>
      db.withImmediateRunAuthorityTransaction(query => {
        query('INSERT INTO authority_fixture (id) VALUES ($1)', ['outer']);
        nested = db.withImmediateRunAuthorityTransaction(() => 'inner');
        return nested;
      })
    )
  ).toBe('run_authority_callback_must_be_synchronous');
  expect(await failureOf(() => nested!)).toBe('run_authority_transaction_already_active');
  expect((await db.query('SELECT id FROM authority_fixture')).rowCount).toBe(0);
});

test('callback transaction-control SQL is refused inside its owned interval', async () => {
  expect(
    await failureOf(() =>
      db.withImmediateRunAuthorityTransaction(query => {
        query('INSERT INTO authority_fixture (id) VALUES ($1)', ['owned']);
        query('COMMIT');
      })
    )
  ).toBe('run_authority_query_unsupported');
  expect((await db.query('SELECT id FROM authority_fixture')).rowCount).toBe(0);
});
