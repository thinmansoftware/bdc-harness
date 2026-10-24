import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAdapter } from './adapters/sqlite';
import * as tm from './taskmaster';
import { withOverseerControlPlaneImmediateTransaction } from './overseer-control-plane-sqlite';

let directory: string;
let db: SqliteAdapter;
let other: SqliteAdapter;
const now = '2026-10-18T12:00:00.000Z';
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'tm-cap-'));
  db = new SqliteAdapter(join(directory, 'test.db'));
  other = new SqliteAdapter(join(directory, 'test.db'));
  await db.query("UPDATE tm_control SET pause_state='RUNNING', epoch=1 WHERE id=1");
});
afterEach(async () => {
  await other.close();
  await db.close();
  rmSync(directory, { recursive: true, force: true });
});
async function request(key: string, at = now): Promise<tm.AutomaticFireRequest> {
  await db.query(
    `INSERT INTO tm_journal(id,thread_ref,action_type,proposal_json,idempotency_key,outcome,created_at)
     VALUES ($1,$2,'fire_cauldron','{}',$1,'pending',$3)`,
    [key, `test:${key}`, at]
  );
  return {
    actionKey: key,
    journalId: key,
    sourceThreadRef: `test:${key}`,
    ownerToken: `owner:${key}`,
    cascadeId: key,
    epoch: 1,
    limit: 2,
    now: at,
  };
}
test('two durable slots survive restart; third automatic fire is denied', async () => {
  for (const key of ['a', 'b']) {
    const input = await request(key);
    expect((await tm.reserveAutomaticFire(input, db)).allowed).toBe(true);
    expect((await tm.authorizeAutomaticFire(input, db)).allowed).toBe(true);
    await tm.settleAutomaticFire(
      {
        actionKey: key,
        cascadeId: key,
        state: 'admitted',
        admittedAt: now,
        runIds: [`child:${key}`],
      },
      db
    );
  }
  expect((await tm.reserveAutomaticFire(await request('c'), other)).allowed).toBe(false);
});
test('independent connections reserve one remaining slot atomically', async () => {
  expect((await tm.reserveAutomaticFire(await request('first'), db)).allowed).toBe(true);
  const a = await request('a');
  const b = await request('b');
  const results = await Promise.all([
    tm.reserveAutomaticFire(a, db),
    tm.reserveAutomaticFire(b, other),
  ]);
  expect(results.filter(result => result.allowed)).toHaveLength(1);
});
test('separate operating-system processes cannot spend the same final SQLite slot', async () => {
  await tm.reserveAutomaticFire(await request('used'), db);
  const a = await request('process-a');
  const b = await request('process-b');
  const fixture = join(import.meta.dir, 'taskmaster-fire-cap-race.fixture.ts');
  const results = await Promise.all(
    [a, b].map(async input => {
      const child = Bun.spawn(
        [process.execPath, fixture, join(directory, 'test.db'), JSON.stringify(input)],
        { stdout: 'pipe', stderr: 'pipe' }
      );
      const [output, error, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (exit !== 0) throw new Error(`Isolated SQLite competitor failed: ${error}`);
      const line = output.split('\n').find(line => line.startsWith('FIRE_CAP_RESULT:'));
      if (!line) throw new Error('SQLite competitor did not return a result');
      return JSON.parse(line.slice('FIRE_CAP_RESULT:'.length)) as tm.AutomaticFireDecision;
    })
  );
  expect(results.filter(result => result.allowed)).toHaveLength(1);
});
test('same action cannot grant two invocations even with different owner tokens', async () => {
  const input = await request('same');
  const results = await Promise.all([
    tm.reserveAutomaticFire(input, db),
    tm.reserveAutomaticFire({ ...input, ownerToken: 'different' }, other),
  ]);
  expect(results.filter(result => result.allowed)).toHaveLength(1);
});
test('admission rechecks UTC day after asynchronous preflight', async () => {
  const input = await request('midnight', '2026-10-17T23:59:59.000Z');
  expect((await tm.reserveAutomaticFire(input, db)).allowed).toBe(true);
  const result = await tm.authorizeAutomaticFire({ ...input, now }, db);
  expect(result.allowed).toBe(true);
  expect(result.admission?.utcDay).toBe('2026-10-18');
});
test('proof deadline follows actual admission rather than stale preflight time', async () => {
  const input = await request('proof-clock', '2026-10-16T23:59:59.000Z');
  await tm.reserveAutomaticFire(input, db);
  const permission = await tm.authorizeAutomaticFire({ ...input, now }, db);
  expect(permission.allowed).toBe(true);
  await tm.settleAutomaticFire(
    {
      actionKey: input.actionKey,
      cascadeId: input.cascadeId,
      state: 'admitted',
      admittedAt: now,
      runIds: ['child'],
    },
    db
  );
  const result = await db.query<{ proof_deadline_at: string }>(
    'SELECT proof_deadline_at FROM tm_journal WHERE id=$1',
    [input.journalId]
  );
  expect(result.rows[0]?.proof_deadline_at).toBe('2026-10-19T12:00:00.000Z');
});
test('admission clock is read after waiting for the database transaction lock', async () => {
  const input = await request('lock-midnight', '2026-10-17T23:59:59.000Z');
  await tm.reserveAutomaticFire(input, db);
  let release!: () => void;
  let locked!: () => void;
  const acquired = new Promise<void>(resolve => {
    locked = resolve;
  });
  const held = withOverseerControlPlaneImmediateTransaction(other, async () => {
    locked();
    await new Promise<void>(resolve => {
      release = resolve;
    });
  });
  await acquired;
  let clock = input.now;
  const result = tm.authorizeAutomaticFire({ ...input, clock: () => clock }, db);
  clock = now;
  release();
  await held;
  expect((await result).admission?.utcDay).toBe('2026-10-18');
});
test('unknown permission remains held on later days; only proved refusal releases', async () => {
  const input = await request('unknown');
  await tm.reserveAutomaticFire(input, db);
  await tm.authorizeAutomaticFire(input, db);
  expect(
    (
      await tm.reserveAutomaticFire(
        { ...(await request('later')), limit: 1, now: '2026-10-29T12:00:00.000Z' },
        other
      )
    ).allowed
  ).toBe(false);
  await expect(tm.releaseAutomaticFire(input, db)).resolves.toBe(false);
  const refusal = await request('refusal');
  expect((await tm.reserveAutomaticFire(refusal, db)).allowed).toBe(true);
  expect(await tm.releaseAutomaticFire(refusal, db)).toBe(true);
});
test('fresh pause or epoch drift refuses permission before the effect', async () => {
  const input = await request('paused');
  await tm.reserveAutomaticFire(input, db);
  await db.query("UPDATE tm_control SET pause_state='PAUSED', epoch=2 WHERE id=1");
  expect((await tm.authorizeAutomaticFire(input, db)).allowed).toBe(false);
});

test('reconciliation settlement cannot refund committed permission', async () => {
  const input = await request('settlement-refund');
  await tm.reserveAutomaticFire({ ...input, limit: 1 }, db);
  await tm.settleAutomaticFire(
    { actionKey: input.actionKey, cascadeId: input.cascadeId, state: 'released' },
    other
  );
  expect((await tm.listAutomaticFireAdmissions(db))[0]?.state).toBe('reserved');
  expect(await tm.releaseAutomaticFire({ ...input, ownerToken: 'foreign' }, other)).toBe(false);
  await tm.authorizeAutomaticFire({ ...input, limit: 1 }, db);
  const before = (await tm.listAutomaticFireAdmissions(db))[0]!;
  await tm.settleAutomaticFire(
    { actionKey: input.actionKey, cascadeId: input.cascadeId, state: 'released' },
    other
  );
  expect((await tm.listAutomaticFireAdmissions(db))[0]).toEqual(before);
  await tm.settleAutomaticFire(
    {
      actionKey: input.actionKey,
      cascadeId: input.cascadeId,
      state: 'admitted',
      admittedAt: '2026-10-17T12:00:00.000Z',
    },
    other
  );
  expect((await tm.listAutomaticFireAdmissions(db))[0]).toEqual(before);
  expect(
    (await tm.reserveAutomaticFire({ ...(await request('not-refunded')), limit: 1 }, other)).allowed
  ).toBe(false);
});

test.each([true, false])(
  'owned release and authorization serialize across SQLite connections: releaseFirst=%s',
  async releaseFirst => {
    const input = { ...(await request('release-race')), limit: 1 };
    await tm.reserveAutomaticFire(input, db);
    const release = () => tm.releaseAutomaticFire(input, other);
    const authorize = () => tm.authorizeAutomaticFire(input, db);
    const [released, decision] = releaseFirst
      ? await Promise.all([release(), authorize()])
      : await Promise.all([authorize(), release()]).then(([a, r]) => [r, a] as const);
    expect(Number(released) + Number(decision.allowed)).toBe(1);
    const row = (
      await db.query<tm.AutomaticFireAdmission>(
        'SELECT * FROM tm_fire_admissions WHERE action_key=$1',
        [input.actionKey]
      )
    ).rows[0]!;
    expect(row.state).toBe(released ? 'released' : 'unknown');
    expect(row.admitted_at).toBe(released ? null : now);
    expect(
      (await tm.reserveAutomaticFire({ ...(await request('after-race')), limit: 1 }, other)).allowed
    ).toBe(released);
  }
);
test('unreconciled legacy fire journal blocks fresh budget', async () => {
  await request('legacy');
  await db.query("UPDATE tm_journal SET outcome='sent' WHERE id='legacy'");
  expect((await tm.reserveAutomaticFire(await request('new'), db)).allowed).toBe(false);
});

test('proven pre-effect expiration permits fresh reservation and authorization', async () => {
  await request('stale-before-effect');
  await db.query("UPDATE tm_journal SET outcome='expired',proposal_json=$1 WHERE id=$2", [
    JSON.stringify({ reason: 'stale_epoch_before_effect' }),
    'stale-before-effect',
  ]);
  const input = await request('after-stale');
  expect(await tm.reserveAutomaticFire(input, other)).toEqual({ allowed: true });
  expect((await tm.authorizeAutomaticFire(input, db)).allowed).toBe(true);
  expect((await tm.listAutomaticFireAdmissions(db)).map(row => row.action_key)).toEqual([
    input.actionKey,
  ]);
});

test.each([
  ['expired', '{}'],
  ['expired', '{bad-json'],
  ['expired', 'null'],
  ['expired', JSON.stringify({ reason: 'other_expiration' })],
  ['sent', JSON.stringify({ reason: 'stale_epoch_before_effect' })],
  ['failed', JSON.stringify({ reason: 'stale_epoch_before_effect' })],
])('unknown legacy history stays blocked: outcome=%s proposal=%s', async (outcome, proposal) => {
  const input = await request('reserved-before-history');
  expect((await tm.reserveAutomaticFire(input, db)).allowed).toBe(true);
  for (const [key, value] of [
    ['proven-first', JSON.stringify({ reason: 'stale_epoch_before_effect' })],
    ['unknown-after', proposal],
  ] as const) {
    await request(key);
    await db.query('UPDATE tm_journal SET outcome=$1,proposal_json=$2 WHERE id=$3', [
      key === 'proven-first' ? 'expired' : outcome,
      value,
      key,
    ]);
  }
  const refused = { allowed: false, reason: 'daily_cap_legacy_history_unknown' };
  expect(await tm.reserveAutomaticFire(await request('new-after-history'), other)).toEqual(refused);
  expect(await tm.authorizeAutomaticFire(input, db)).toEqual(refused);
});

test('pre-effect label cannot refund an existing committed permission', async () => {
  const input = { ...(await request('committed')), limit: 1 };
  await tm.reserveAutomaticFire(input, db);
  await tm.authorizeAutomaticFire(input, db);
  await db.query("UPDATE tm_journal SET outcome='expired',proposal_json=$1 WHERE id=$2", [
    JSON.stringify({ reason: 'stale_epoch_before_effect' }),
    input.journalId,
  ]);
  expect(
    await tm.reserveAutomaticFire({ ...(await request('still-charged')), limit: 1 }, other)
  ).toEqual({ allowed: false, reason: 'daily_cap_exhausted' });
});

test('proved legacy settlement preserves journal supervision and legacy attribution', async () => {
  const input = await request('proved-legacy');
  const deadline = '2026-10-18T23:00:00.000Z';
  await db.query("UPDATE tm_journal SET outcome='sent',proof_deadline_at=$1 WHERE id=$2", [
    deadline,
    input.journalId,
  ]);
  await tm.seedAutomaticFireHistory({ ...input, ownerToken: 'legacy-reconciliation' }, db);
  await tm.settleAutomaticFire(
    {
      actionKey: input.actionKey,
      cascadeId: input.cascadeId,
      state: 'admitted',
      admittedAt: now,
      runIds: ['legacy-child'],
    },
    other
  );
  const row = (await tm.listAutomaticFireAdmissions(db))[0]!;
  expect(row.owner_token).toBe('legacy-reconciliation');
  expect(row.utc_day).toBe('2026-10-18');
  expect(row.state).toBe('admitted');
  expect(JSON.parse(row.run_ids_json)).toEqual(['legacy-child']);
  expect(
    (
      await db.query<{ proof_deadline_at: string }>(
        'SELECT proof_deadline_at FROM tm_journal WHERE id=$1',
        [input.journalId]
      )
    ).rows[0]?.proof_deadline_at
  ).toBe(deadline);
  expect(
    (
      await tm.reserveAutomaticFire(
        { ...(await request('next-legacy-day')), now: '2026-10-19T12:00:00.000Z' },
        other
      )
    ).allowed
  ).toBe(true);
});
test('zero or invalid limit cannot reserve; schema preserves prior journal rows', async () => {
  const input = await request('disabled');
  for (const limit of [0, -1, 1.5, Number.NaN]) {
    expect((await tm.reserveAutomaticFire({ ...input, limit }, db)).allowed).toBe(false);
  }
  expect((await db.query('SELECT id FROM tm_journal')).rowCount).toBe(1);
});
test('additive SQLite bootstrap preserves an existing journal and installs only the cap table', async () => {
  await request('existing');
  await db.query('DROP TABLE tm_fire_admissions');
  await other.close();
  other = new SqliteAdapter(join(directory, 'test.db'));
  expect((await other.query("SELECT id FROM tm_journal WHERE id='existing'")).rowCount).toBe(1);
  const columns = await other.query<{ name: string }>('PRAGMA table_info(tm_fire_admissions)');
  expect(columns.rows.map(row => row.name)).toContain('owner_token');
  expect(columns.rows.map(row => row.name)).toContain('run_ids_json');
});
