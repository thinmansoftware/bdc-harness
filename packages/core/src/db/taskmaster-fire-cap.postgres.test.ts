import { beforeAll, afterAll, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PostgresAdapter } from './adapters/postgres';
import {
  reserveAutomaticFire,
  authorizeAutomaticFire,
  settleAutomaticFire,
  releaseAutomaticFire,
  type AutomaticFireRequest,
  listAutomaticFireAdmissions,
} from './taskmaster';

const schema = `tm_fire_cap_${randomUUID().replace(/-/g, '')}`;
let admin: PostgresAdapter | undefined;
let first: PostgresAdapter | undefined;
let second: PostgresAdapter | undefined;
const now = '2026-10-18T12:00:00.000Z';
beforeAll(async () => {
  const raw = process.env.TASKMASTER_POSTGRES_TEST_URL;
  if (!raw) throw new Error('TASKMASTER_POSTGRES_TEST_URL is required; missing proof is BLOCKED');
  const url = new URL(raw);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    (url.pathname !== '/phase15' && !url.pathname.endsWith('_test'))
  )
    throw new Error('Automatic fire tests require an isolated loopback test database');
  admin = new PostgresAdapter(raw);
  await admin.query(`CREATE SCHEMA ${schema}`);
  url.searchParams.set('options', `-c search_path=${schema}`);
  first = new PostgresAdapter(url.toString());
  second = new PostgresAdapter(url.toString());
  // Install existing journal/control types, then the additive cap migration.
  await first.query(
    readFileSync(
      resolve(import.meta.dir, '../../../../migrations/041_taskmaster_slice1.sql'),
      'utf8'
    )
  );
  // Avoid 045's historical unqualified pg_class lookup: constrain THIS test schema.
  await first.query('ALTER TABLE tm_journal DROP CONSTRAINT tm_journal_action_type_check');
  await first.query("ALTER TABLE tm_journal ADD CHECK(action_type IN ('digest','fire_cauldron'))");
  const migration = readFileSync(
    resolve(import.meta.dir, '../../../../migrations/063_tm_fire_admissions.sql'),
    'utf8'
  );
  await first.query(migration);
  await first.query(migration); // Additive/idempotent installation.
});
beforeEach(async () => {
  if (!first) return;
  await first.query('TRUNCATE tm_fire_admissions,tm_journal');
  await first.query("UPDATE tm_control SET pause_state='RUNNING',epoch=1 WHERE id=1");
});
afterAll(async () => {
  await Promise.all([first?.close(), second?.close()]);
  if (admin) {
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await admin.close();
    }
  }
});
async function request(key: string): Promise<AutomaticFireRequest> {
  const journalId = randomUUID();
  await first!.query(
    `INSERT INTO tm_journal(id,thread_ref,action_type,proposal_json,idempotency_key,outcome,created_at)
    VALUES ($1,$2,'fire_cauldron','{}',$2,'pending',$3)`,
    [journalId, key, now]
  );
  return {
    actionKey: key,
    journalId,
    sourceThreadRef: key,
    ownerToken: randomUUID(),
    cascadeId: key,
    epoch: 1,
    limit: 2,
    now,
  };
}
test('real PostgreSQL pools serialize twelve competitors for one remaining slot', async () => {
  const used = await request('first');
  expect((await reserveAutomaticFire(used, first)).allowed).toBe(true);
  const inputs = await Promise.all(Array.from({ length: 12 }, (_, i) => request(`race-${i}`)));
  const results = await Promise.all(
    inputs.map((input, i) => reserveAutomaticFire(input, i % 2 ? first : second))
  );
  expect(results.filter(result => result.allowed)).toHaveLength(1);
});
test('PostgreSQL replay grants one invocation; rebooking uses the admission day and survives restart', async () => {
  const input = await request('same');
  const contender = { ...input, ownerToken: 'contender' };
  const results = await Promise.all([
    reserveAutomaticFire(input, first),
    reserveAutomaticFire(contender, second),
  ]);
  expect(results.filter(result => result.allowed)).toHaveLength(1);
  const owner = results[0]!.allowed ? input : contender;
  const authorization = await authorizeAutomaticFire(
    { ...owner, now: '2026-10-19T00:00:01.000Z' },
    second
  );
  expect(authorization.allowed).toBe(true);
  expect(authorization.admission?.utcDay).toBe('2026-10-19');
  expect(await releaseAutomaticFire(input, first)).toBe(false);
  await settleAutomaticFire(
    {
      actionKey: input.actionKey,
      cascadeId: input.cascadeId,
      state: 'admitted',
      admittedAt: '2026-10-19T00:00:01.000Z',
      runIds: ['child'],
    },
    second
  );
  const deadline = await first!.query<{ proof_deadline_at: Date | string }>(
    'SELECT proof_deadline_at FROM tm_journal WHERE id=$1',
    [input.journalId]
  );
  expect(new Date(deadline.rows[0]!.proof_deadline_at).toISOString()).toBe(
    '2026-10-20T00:00:01.000Z'
  );
  const a = { ...(await request('next')), now: '2026-10-19T00:01:00.000Z' };
  const b = { ...(await request('overflow')), now: '2026-10-19T00:01:00.000Z' };
  expect((await reserveAutomaticFire(a, first)).allowed).toBe(true);
  expect((await reserveAutomaticFire(b, second)).allowed).toBe(false);
});
test('PostgreSQL epoch fence and definitive no-permission release preserve unknown capacity', async () => {
  const input = await request('pause');
  await reserveAutomaticFire(input, first);
  await first!.query("UPDATE tm_control SET pause_state='PAUSED',epoch=2 WHERE id=1");
  expect((await authorizeAutomaticFire(input, second)).allowed).toBe(false);
  expect(await releaseAutomaticFire(input, first)).toBe(true);
});

test('PostgreSQL excludes only proven pre-effect expirations from legacy history', async () => {
  const expired = await request('stale-before-effect');
  await first!.query("UPDATE tm_journal SET outcome='expired',proposal_json=$1 WHERE id=$2", [
    JSON.stringify({ reason: 'stale_epoch_before_effect' }),
    expired.journalId,
  ]);
  const input = await request('fresh-after-expiration');
  expect(await reserveAutomaticFire(input, second)).toEqual({ allowed: true });
  expect((await authorizeAutomaticFire(input, first)).allowed).toBe(true);
  const unknown = await request('unknown-expiration');
  await first!.query("UPDATE tm_journal SET outcome='expired' WHERE id=$1", [unknown.journalId]);
  expect(await reserveAutomaticFire(await request('blocked-by-unknown'), second)).toEqual({
    allowed: false,
    reason: 'daily_cap_legacy_history_unknown',
  });
});

test('PostgreSQL unowned settlement never releases reserved or committed permission', async () => {
  const input = { ...(await request('settlement-refund')), limit: 1 };
  await reserveAutomaticFire(input, first);
  await settleAutomaticFire(
    { actionKey: input.actionKey, cascadeId: input.cascadeId, state: 'released' },
    second
  );
  expect((await listAutomaticFireAdmissions(first))[0]?.state).toBe('reserved');
  expect(await releaseAutomaticFire({ ...input, ownerToken: 'foreign' }, second)).toBe(false);
  expect((await authorizeAutomaticFire(input, first)).allowed).toBe(true);
  const row = (await listAutomaticFireAdmissions(first))[0]!;
  await settleAutomaticFire(
    { actionKey: input.actionKey, cascadeId: input.cascadeId, state: 'released' },
    second
  );
  expect((await listAutomaticFireAdmissions(first))[0]).toEqual(row);
  await settleAutomaticFire(
    {
      actionKey: input.actionKey,
      cascadeId: input.cascadeId,
      state: 'admitted',
      admittedAt: '2026-10-17T12:00:00.000Z',
    },
    second
  );
  expect((await listAutomaticFireAdmissions(first))[0]).toEqual(row);
  expect(
    (await reserveAutomaticFire({ ...(await request('replacement')), limit: 1 }, second)).allowed
  ).toBe(false);
});

test.each([true, false])(
  'PostgreSQL owned release and authorization serialize: releaseFirst=%s',
  async releaseFirst => {
    const input = { ...(await request('release-race')), limit: 1 };
    await reserveAutomaticFire(input, first);
    const release = () => releaseAutomaticFire(input, second);
    const authorize = () => authorizeAutomaticFire(input, first);
    const [released, decision] = releaseFirst
      ? await Promise.all([release(), authorize()])
      : await Promise.all([authorize(), release()]).then(([a, r]) => [r, a] as const);
    expect(Number(released) + Number(decision.allowed)).toBe(1);
    const row = (
      await first!.query<{ state: string; admitted_at: string | null }>(
        'SELECT state,admitted_at FROM tm_fire_admissions WHERE action_key=$1',
        [input.actionKey]
      )
    ).rows[0]!;
    expect(row.state).toBe(released ? 'released' : 'unknown');
    expect(row.admitted_at === null).toBe(released);
    expect(
      (await reserveAutomaticFire({ ...(await request('after-race')), limit: 1 }, second)).allowed
    ).toBe(released);
  }
);
