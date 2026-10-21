import { afterAll, beforeAll, expect, mock, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PostgresAdapter, postgresDialect } from './adapters/postgres';

let db: PostgresAdapter;
let admin: PostgresAdapter | undefined;
const schema = `drain_${randomUUID().replaceAll('-', '')}`;
const guardOnly = process.env.DRAIN_POSTGRES_GUARD_ONLY === '1';

function testDatabaseUrl(raw: string): URL {
  const url = new URL(raw);
  // pg-connection-string allows query keys such as host to override the URL
  // authority. Accept only the fixed test target, then add owned options below.
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    (url.pathname !== '/phase15' && !url.pathname.endsWith('_test')) ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('drain integration requires a loopback test database');
  }
  return url;
}

mock.module('./connection', () => ({
  getDatabase: () => db,
  getDialect: () => postgresDialect,
  getDatabaseType: () => 'postgresql',
  pool: { query: (sql: string, params?: unknown[]) => db.query(sql, params) },
}));
import { setCauldronDrainMode, applyCauldronDrainClearOnBoot } from './workflows';

beforeAll(async () => {
  if (guardOnly) return;
  const raw = process.env.DRAIN_POSTGRES_TEST_URL;
  if (!raw) throw new Error('DRAIN_POSTGRES_TEST_URL is required');
  const url = testDatabaseUrl(raw);
  admin = new PostgresAdapter(raw);
  await admin.query(`CREATE SCHEMA ${schema}`);
  url.searchParams.set('options', `-c search_path=${schema}`);
  db = new PostgresAdapter(url.toString());
  for (const name of ['025_cauldron_drain_mode.sql', '066_cauldron_drain_clear_on_boot.sql']) {
    await db.query(readFileSync(resolve(import.meta.dir, '../../../../migrations', name), 'utf8'));
  }
});

afterAll(async () => {
  if (guardOnly) {
    expect(db).toBeUndefined();
    expect(admin).toBeUndefined();
    return;
  }
  await db?.close();
  if (admin) {
    try {
      if (!/^drain_[0-9a-f]{32}$/.test(schema)) throw new Error('invalid owned fixture schema');
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await admin.close();
    }
  }
});

test('test database guard rejects authority overrides before constructing adapters', () => {
  for (const raw of [
    'postgresql://fixture@external.example/phase15',
    'postgresql://fixture@127.0.0.1/production',
    'postgresql://fixture@127.0.0.1/phase15?host=external.example',
    'postgresql://fixture@127.0.0.1/phase15?hostaddr=203.0.113.1',
    'postgresql://fixture@127.0.0.1/phase15?database=production',
    'postgresql://fixture@127.0.0.1/phase15#fragment',
  ])
    expect(() => testDatabaseUrl(raw)).toThrow('requires a loopback test database');
  expect(testDatabaseUrl('postgresql://fixture@127.0.0.1/phase15').hostname).toBe('127.0.0.1');
});

test.skipIf(guardOnly)(
  'real PostgreSQL migration, concurrent acquisition, stale-token fencing, and boot clearing',
  async () => {
    const request = { actor: 'fixture', reason: 'test', updatedAt: new Date().toISOString() };
    const legacy = await db.query<{ drain_token: string | null }>(
      'SELECT drain_token FROM remote_agent_cauldron_control'
    );
    expect(legacy.rows[0]?.drain_token).toBeNull();
    const grants = await Promise.all([
      setCauldronDrainMode({ ...request, mode: 'draining', clearOnBoot: true }),
      setCauldronDrainMode({ ...request, mode: 'draining', clearOnBoot: true }),
    ]);
    const winner = grants.find(grant => grant.changed);
    expect(grants.filter(grant => grant.changed)).toHaveLength(1);
    expect(grants.filter(grant => !grant.changed)).toEqual([
      { changed: false, mode: 'draining', acquiredDrainToken: null },
    ]);
    expect(winner?.acquiredDrainToken).toMatch(/^[0-9a-f-]{36}$/);
    await setCauldronDrainMode({ ...request, mode: 'normal' });
    const incident = await setCauldronDrainMode({ ...request, mode: 'draining' });
    const events = await db.query('SELECT * FROM remote_agent_cauldron_control_events ORDER BY id');
    await expect(
      setCauldronDrainMode({
        ...request,
        mode: 'normal',
        expectedDrainToken: winner?.acquiredDrainToken ?? undefined,
      })
    ).rejects.toMatchObject({ code: 'cauldron_drain_ownership_conflict' });
    expect(
      (await db.query('SELECT * FROM remote_agent_cauldron_control_events ORDER BY id')).rows
    ).toEqual(events.rows);
    expect(
      (await db.query('SELECT mode, drain_token FROM remote_agent_cauldron_control')).rows
    ).toEqual([{ mode: 'draining', drain_token: incident.acquiredDrainToken }]);
    expect(await applyCauldronDrainClearOnBoot()).toBe('persisted');
    await setCauldronDrainMode({
      ...request,
      mode: 'normal',
      expectedDrainToken: incident.acquiredDrainToken ?? undefined,
    });
    await setCauldronDrainMode({ ...request, mode: 'draining', clearOnBoot: true });
    expect(await applyCauldronDrainClearOnBoot()).toBe('cleared');
    expect(
      (await db.query('SELECT mode, clear_on_boot, drain_token FROM remote_agent_cauldron_control'))
        .rows
    ).toEqual([{ mode: 'normal', clear_on_boot: 0, drain_token: null }]);
  }
);
