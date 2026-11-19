import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';
import { removeTempDirWithRetry } from '../test/temp-dir';
import { closeDatabase, getDatabase, resetDatabase } from './connection';
import {
  acquireReviewSpoolLease,
  checkReviewSpoolLease,
  releaseReviewSpoolLease,
  renewReviewSpoolLease,
  type ReviewSpoolLease,
} from './review-spool-leases';

const SPOOL = 'review-spool:/test/spool/checkouts';
const oldArchonHome = process.env.ARCHON_HOME;
const oldDatabaseUrl = process.env.DATABASE_URL;
let currentHome = '';

async function expire(spoolKey: string): Promise<void> {
  await getDatabase().query(
    `UPDATE review_spool_leases SET expires_at='2000-01-01T00:00:00.000Z' WHERE spool_key=$1`,
    [spoolKey]
  );
}

function identity(lease: ReviewSpoolLease): {
  spool_key: string;
  holder_id: string;
  fencing_token: number;
} {
  return {
    spool_key: lease.spool_key,
    holder_id: lease.holder_id,
    fencing_token: lease.fencing_token,
  };
}

describe('review spool lease (real sqlite, WO-HARNESS-REVIEW-CHECKOUT-CACHE-EVICTION-01)', () => {
  beforeEach(async () => {
    await closeDatabase();
    resetDatabase();
    currentHome = join(
      import.meta.dir,
      `.test-review-spool-leases-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    process.env.ARCHON_HOME = currentHome;
    delete process.env.DATABASE_URL;
    expect(getDatabase().dialect).toBe('sqlite');
  });

  afterEach(async () => {
    await closeDatabase();
    resetDatabase();
    if (oldArchonHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = oldArchonHome;
    if (oldDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = oldDatabaseUrl;
    removeTempDirWithRetry(currentHome);
  });

  test('Test 7: a live lease excludes a second worker; takeover only after expiry, with a higher token', async () => {
    const first = await acquireReviewSpoolLease({
      spool_key: SPOOL,
      holder_id: 'worker-a',
      ttl_seconds: 600,
    });
    expect(first).not.toBeNull();
    expect(first!.fencing_token).toBe(1);
    expect(await checkReviewSpoolLease(identity(first!))).toBe(true);

    // A second worker gets nothing while the lease is live.
    expect(
      await acquireReviewSpoolLease({ spool_key: SPOOL, holder_id: 'worker-b', ttl_seconds: 600 })
    ).toBeNull();

    // Renew by the holder extends the lease; renew by a stale token or holder changes nothing.
    const renewed = await renewReviewSpoolLease(identity(first!), 600);
    expect(renewed?.fencing_token).toBe(1);
    expect(await renewReviewSpoolLease({ ...identity(first!), fencing_token: 2 }, 600)).toBeNull();
    expect(
      await renewReviewSpoolLease({ ...identity(first!), holder_id: 'worker-b' }, 600)
    ).toBeNull();
    expect(await releaseReviewSpoolLease({ ...identity(first!), holder_id: 'worker-b' })).toBe(
      false
    );
    expect(await checkReviewSpoolLease(identity(first!))).toBe(true);

    // The holder dies: its lease expires and is taken over with a higher token.
    await expire(SPOOL);
    expect(await checkReviewSpoolLease(identity(first!))).toBe(false);
    const second = await acquireReviewSpoolLease({
      spool_key: SPOOL,
      holder_id: 'worker-b',
      ttl_seconds: 600,
    });
    expect(second).not.toBeNull();
    expect(second!.fencing_token).toBe(2);
    expect(await checkReviewSpoolLease(identity(second!))).toBe(true);

    // The old holder can no longer renew, release or pass a check.
    expect(await renewReviewSpoolLease(identity(first!), 600)).toBeNull();
    expect(await releaseReviewSpoolLease(identity(first!))).toBe(false);
    expect(await checkReviewSpoolLease(identity(first!))).toBe(false);
    expect(await checkReviewSpoolLease(identity(second!))).toBe(true);

    // Release by the holder frees it; the next holder's token keeps climbing.
    expect(await releaseReviewSpoolLease(identity(second!))).toBe(true);
    expect(await checkReviewSpoolLease(identity(second!))).toBe(false);
    expect(await releaseReviewSpoolLease(identity(second!))).toBe(false);
    const third = await acquireReviewSpoolLease({
      spool_key: SPOOL,
      holder_id: 'worker-c',
      ttl_seconds: 600,
    });
    expect(third?.fencing_token).toBe(3);

    // A different spool is an independent lease.
    const other = await acquireReviewSpoolLease({
      spool_key: `${SPOOL}-other`,
      holder_id: 'worker-a',
      ttl_seconds: 600,
    });
    expect(other?.fencing_token).toBe(1);
  });

  test('Test 8: 20 contenders racing for an expired lease -- exactly one holder in 100/100 trials', async () => {
    const contenders = 20;
    const trials = 100;
    let passed = 0;
    let previousToken = 0;
    for (let trial = 0; trial < trials; trial += 1) {
      const key = `${SPOOL}-race`;
      if (trial === 0) {
        const seed = await acquireReviewSpoolLease({
          spool_key: key,
          holder_id: 'seed',
          ttl_seconds: 600,
        });
        previousToken = seed!.fencing_token;
      }
      await expire(key);
      const results = await Promise.all(
        Array.from({ length: contenders }, (_, i) =>
          acquireReviewSpoolLease({
            spool_key: key,
            holder_id: `trial-${trial}-contender-${i}`,
            ttl_seconds: 600,
          })
        )
      );
      const holders = results.filter((lease): lease is ReviewSpoolLease => lease !== null);
      const row = (
        await getDatabase().query<{ holder_id: string; fencing_token: number }>(
          'SELECT holder_id,fencing_token FROM review_spool_leases WHERE spool_key=$1',
          [key]
        )
      ).rows[0];
      if (
        holders.length === 1 &&
        holders[0].fencing_token > previousToken &&
        row?.holder_id === holders[0].holder_id &&
        Number(row.fencing_token) === holders[0].fencing_token
      ) {
        passed += 1;
      }
      previousToken = Number(row?.fencing_token ?? previousToken);
    }
    expect(passed).toBe(trials);
  });

  test('Test 8 (cross-process): separate processes racing for an expired lease -- exactly one holder', async () => {
    // The in-process race above shares one connection; this one gives every
    // contender its own process and its own SQLite connection to the same file.
    const key = `${SPOOL}-xproc`;
    const seed = await acquireReviewSpoolLease({
      spool_key: key,
      holder_id: 'seed',
      ttl_seconds: 600,
    });
    let previousToken = seed!.fencing_token;
    const url = (path: string): string =>
      JSON.stringify(pathToFileURL(resolve(import.meta.dir, path)).href);
    const script = join(currentHome, 'contender.ts');
    writeFileSync(
      script,
      `
      const { getDatabase, closeDatabase } = await import(${url('./connection.ts')});
      const leases = await import(${url('./review-spool-leases.ts')});
      getDatabase();
      const startAt = Number(process.argv[2]);
      while (Date.now() < startAt) await new Promise(r => setTimeout(r, 1));
      try {
        const lease = await leases.acquireReviewSpoolLease({ spool_key: ${JSON.stringify(key)}, holder_id: process.argv[3], ttl_seconds: 600 });
        console.log('RESULT=' + JSON.stringify(lease ? { held: true, token: lease.fencing_token } : { held: false }));
      } finally { await closeDatabase(); }
      `
    );
    const contenders = 8;
    const trials = 3;
    let passed = 0;
    for (let trial = 0; trial < trials; trial += 1) {
      await expire(key);
      const startAt = Date.now() + 2_500;
      const children = Array.from({ length: contenders }, (_, i) =>
        Bun.spawn([process.execPath, script, String(startAt), `xproc-${trial}-${i}`], {
          env: { ...process.env, ARCHON_HOME: currentHome, LOG_LEVEL: 'error' },
          stdout: 'pipe',
          stderr: 'pipe',
        })
      );
      const outputs = await Promise.all(
        children.map(async child => {
          const [code, out] = await Promise.all([child.exited, new Response(child.stdout).text()]);
          const line = out.split('\n').find(l => l.startsWith('RESULT='));
          return code === 0 && line
            ? (JSON.parse(line.slice('RESULT='.length)) as { held: boolean; token?: number })
            : null;
        })
      );
      expect(outputs.every(o => o !== null)).toBe(true);
      const holders = outputs.filter(o => o?.held);
      if (holders.length === 1 && (holders[0]?.token ?? 0) > previousToken) passed += 1;
      previousToken = holders[0]?.token ?? previousToken;
    }
    expect(passed).toBe(trials);
  }, 60_000);

  test('rejects malformed input instead of guessing', async () => {
    await expect(
      acquireReviewSpoolLease({ spool_key: ' ', holder_id: 'w', ttl_seconds: 600 })
    ).rejects.toThrow('review_spool_lease_invalid_input');
    await expect(
      acquireReviewSpoolLease({ spool_key: SPOOL, holder_id: 'w', ttl_seconds: 0 })
    ).rejects.toThrow('review_spool_lease_invalid_input');
    expect(
      await checkReviewSpoolLease({ spool_key: SPOOL, holder_id: 'w', fencing_token: 0 })
    ).toBe(false);
  });
});
