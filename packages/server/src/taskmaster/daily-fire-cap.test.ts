import { expect, test } from 'bun:test';
import { lstatSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { runCascade, readCascadeRecord } from '@archon/smart-cauldron/cascade';
import type { RunCascadeOptions } from '@archon/smart-cauldron/cascade';
import { SqliteAdapter } from '@archon/core/db/adapters/sqlite';
import { reserveAutomaticFire, authorizeAutomaticFire } from '@archon/core/db/taskmaster';
import * as taskmasterDb from '@archon/core/db/taskmaster';
import * as loop from './loop';
import { createRecord, writeRecord } from '../../../smart-cauldron/src/recorder';
import type { FakeWorld } from '../test/taskmaster-loop-world';
import {
  EXPECTED_SPEC,
  makeDeps,
  makeListedThread,
  makeWorld,
  seedDigestSent,
} from '../test/taskmaster-loop-world';

test('there is no daily cap: the retired setting has no reader; the per-WO stop is a fixed 2', () => {
  // WO-HARNESS-TASKMASTER-NO-DAILY-FIRE-CAP-01 (John, 2026-11-23): TASKMASTER_FIRE_MAX_PER_DAY is
  // no longer read, and John's answer B is a constant, read from no setting.
  expect('resolveTaskmasterFireDailyLimit' in loop).toBe(false);
  expect(loop.MAX_FIRES_PER_TICK).toBe(3);
  expect(loop.MAX_NO_PR_FIRES_PER_WO_PER_DAY).toBe(2);
});

function fakeCascade(outDir: string): RunCascadeOptions {
  return {
    woId: 'WO-CAP-TEST-01',
    project: 'test-project',
    dispatchId: 'cap-test',
    outDir,
    deps: {
      findWoClaim: async () => null,
      acquireWoLock: async (woId, project, cascadeId) => ({
        acquired: true,
        path: 'fake',
        record: {
          woId,
          project,
          cascadeId,
          status: 'running',
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        },
      }),
      releaseWoLock: async () => {},
      fetchNodeTimeouts: async () => ({}),
      fire: async () => ({
        ok: true,
        runId: 'actual-child-id',
        conversationId: 'fake',
        infraError: null,
      }),
      poll: async () => ({
        runId: 'actual-child-id',
        terminalStatus: 'completed',
        validatorVerdict: 'satisfied',
        prUrl: 'https://example.test/pr/1',
        prMergeable: true,
        servedModelId: null,
        rawMetadata: {},
      }),
      judge: () => ({
        pass: true,
        reason: 'fake pass',
        cancelled: false,
        validatorVerdict: 'satisfied',
        prOpened: true,
        prMergeable: true,
        terminalStatus: 'completed',
      }),
      escalate: async () => {},
    },
  };
}

function legacyCleanupMetadata(directory: string) {
  if (!directory.startsWith(join(tmpdir(), 'tm-cap-legacy-')))
    throw new Error('invalid diagnostic root');
  if (lstatSync(directory).isSymbolicLink()) throw new Error('diagnostic root is a link');
  const classify = (name: string) =>
    name === 'isolated.db'
      ? 'db'
      : name === 'isolated.db-wal'
        ? 'wal'
        : name === 'isolated.db-shm'
          ? 'shm'
          : /^dispatch-[a-f0-9]{24}$/.test(name)
            ? 'recorder'
            : 'other';
  const all = readdirSync(directory, { withFileTypes: true });
  const entries = all.slice(0, 8).map(entry => {
    const info = lstatSync(join(directory, entry.name));
    return {
      classification: classify(entry.name),
      kind: info.isSymbolicLink() ? 'link' : info.isDirectory() ? 'directory' : 'file',
      bytes: info.size,
    };
  });
  return { status: 'available', entryCount: all.length, truncated: all.length > 8, entries };
}

async function removeLegacyFixture(
  directory: string,
  diagnostic: {
    remove?: typeof rm;
    inspect?: typeof legacyCleanupMetadata;
    report?: (metadata: object) => void;
    synthetic?: boolean;
  } = {}
) {
  try {
    await (diagnostic.remove ?? rm)(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  } catch (original) {
    let metadata: object = { status: 'diagnostic-unavailable' };
    try {
      metadata = (diagnostic.inspect ?? legacyCleanupMetadata)(directory);
    } catch {
      // Inspection cannot replace the original cleanup failure.
    }
    const code = (original as NodeJS.ErrnoException | null)?.code;
    const errorClass =
      original instanceof Error &&
      ['Error', 'TypeError', 'RangeError', 'SystemError'].includes(original.name)
        ? original.name
        : 'unknown';
    const report = {
      synthetic: diagnostic.synthetic ?? false,
      stage: diagnostic.synthetic ? 'synthetic-cleanup-control' : 'after-close-clear-yield-gc',
      runtime: Bun.version,
      platform: process.platform,
      errorClass,
      code: typeof code === 'string' && /^[A-Z0-9_]{1,24}$/.test(code) ? code : 'unknown',
      metadata,
    };
    try {
      (diagnostic.report ?? (value => console.error('[tm-cap-cleanup]', JSON.stringify(value))))(
        report
      );
    } catch {
      try {
        console.error('[tm-cap-cleanup]', '{"status":"diagnostic-unavailable"}');
      } catch {
        // Even a broken reporter must not replace the original failure.
      }
    }
    throw original;
  }
}

test('synthetic cleanup diagnostics preserve the original error and bound owned metadata', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tm-cap-legacy-diagnostic-'));
  const original = Object.assign(new Error('synthetic cleanup control'), { code: 'EBUSY' });
  const reports: object[] = [];
  try {
    for (let index = 0; index < 20; index++)
      writeFileSync(join(directory, `synthetic-${index}`), 'x');
    const metadata = legacyCleanupMetadata(directory);
    expect(metadata.entryCount).toBe(20);
    expect(metadata.entries).toHaveLength(8);
    expect(metadata.truncated).toBe(true);
    expect(metadata.entries.every(entry => entry.classification === 'other')).toBe(true);
    expect(JSON.stringify(metadata)).not.toContain(directory);
    expect(JSON.stringify(metadata)).not.toContain('synthetic-');
    expect(JSON.stringify(metadata).length).toBeLessThan(2048);
    await expect(
      removeLegacyFixture(directory, {
        remove: async () => {
          throw original;
        },
        report: value => reports.push(value),
        synthetic: true,
      })
    ).rejects.toBe(original);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      synthetic: true,
      code: 'EBUSY',
      metadata: { status: 'available', entryCount: 20, truncated: true },
    });
    expect(JSON.stringify(reports)).not.toContain(original.message);
    expect(JSON.stringify(reports).length).toBeLessThan(2048);
    reports.length = 0;
    await expect(
      removeLegacyFixture(directory, {
        remove: async () => {
          throw original;
        },
        inspect: () => {
          throw new Error('synthetic inspection failure');
        },
        report: value => reports.push(value),
        synthetic: true,
      })
    ).rejects.toBe(original);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      synthetic: true,
      stage: 'synthetic-cleanup-control',
      errorClass: 'Error',
      code: 'EBUSY',
      metadata: { status: 'diagnostic-unavailable' },
    });
  } finally {
    if (!directory.startsWith(join(tmpdir(), 'tm-cap-legacy-diagnostic-')))
      throw new Error('invalid synthetic diagnostic root');
    rmSync(directory, { recursive: true, force: true });
  }
});

test('synthetic raw file WAL control closes finalized old and reopened connections', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tm-cap-legacy-raw-wal-'));
  try {
    for (const role of ['old', 'reopened']) {
      const native = new Database(join(directory, 'isolated.db'));
      let statement: ReturnType<Database['prepare']> | undefined;
      try {
        native.run('PRAGMA journal_mode = WAL');
        native.run('PRAGMA busy_timeout = 5000');
        native.run('PRAGMA foreign_keys = ON');
        statement = native.prepare('SELECT 1 AS value');
        expect((statement.get() as { value: number }).value).toBe(1);
        statement.finalize();
        expect(native.inTransaction).toBe(false);
        native.close(true);
        console.info(
          '[tm-cap-native-close]',
          JSON.stringify({
            synthetic: true,
            role,
            control: 'raw-file-wal-finalized',
            outcome: 'returned',
          })
        );
      } finally {
        statement?.finalize();
        native.close();
      }
    }
  } finally {
    if (!directory.startsWith(join(tmpdir(), 'tm-cap-legacy-raw-wal-')))
      throw new Error('invalid raw WAL diagnostic root');
    await removeLegacyFixture(directory, { synthetic: true });
  }
});

test('synthetic native-close controls distinguish owned statement and connection lifetimes', async () => {
  const samples: object[] = [];
  const finalizedControl = new Database(':memory:');
  const finalizedStatement = finalizedControl.prepare('SELECT 1 AS value');
  try {
    expect((finalizedStatement.get() as { value: number }).value).toBe(1);
    finalizedStatement.finalize();
    finalizedControl.close(true);
    console.info(
      '[tm-cap-native-close]',
      JSON.stringify({ synthetic: true, role: 'finalized-native-control', outcome: 'returned' })
    );
  } finally {
    finalizedStatement.finalize();
    finalizedControl.close();
  }
  for (const closeMode of ['adapter-default', 'native-strict']) {
    for (const statementMode of ['pending', 'finalized']) {
      const directory = mkdtempSync(join(tmpdir(), 'tm-cap-legacy-native-'));
      try {
        for (const role of ['old', 'reopened']) {
          const adapter = new SqliteAdapter(join(directory, 'isolated.db'));
          // Explicit A5 diagnostic permission: OWN disposable connection only.
          const native = (adapter as unknown as { db: Database }).db;
          const statement = native.prepare('SELECT 1 AS value');
          try {
            expect(
              (await adapter.query<{ value: number }>('SELECT 1 AS value')).rows[0]?.value
            ).toBe(1);
            expect((statement.get() as { value: number }).value).toBe(1);
            if (statementMode === 'finalized') statement.finalize();
            const inTransactionBeforeClose = native.inTransaction;
            let outcome = 'returned';
            try {
              if (closeMode === 'native-strict') native.close(true);
              else await adapter.close();
            } catch (error) {
              const code = (error as NodeJS.ErrnoException).code;
              const message = error instanceof Error ? error.message : '';
              if (code === 'SQLITE_BUSY') outcome = 'reported-in-use-code';
              else if (message === 'database is locked') outcome = 'reported-in-use-message';
              else throw error;
            }
            let statementAfterClose = 'usable';
            try {
              statement.get();
            } catch (error) {
              const message = error instanceof Error ? error.message : '';
              statementAfterClose = /finalized/i.test(message)
                ? 'finalized'
                : /closed/i.test(message)
                  ? 'closed'
                  : 'other-error';
            }
            const sample = {
              synthetic: true,
              closeMode,
              statementMode,
              role,
              outcome,
              inTransactionBeforeClose,
              statementAfterClose,
            };
            samples.push(sample);
            console.info('[tm-cap-native-close]', JSON.stringify(sample));
            if (closeMode === 'native-strict') {
              if (statementMode === 'pending') {
                expect(outcome).toMatch(/^reported-in-use/);
                expect(statementAfterClose).toBe('usable');
              } else {
                expect(outcome).toBe('returned');
                expect(statementAfterClose).toBe('finalized');
              }
            }
          } finally {
            // Only the deliberately created control statement is finalized here.
            statement.finalize();
            await adapter.close();
          }
        }
      } finally {
        if (!directory.startsWith(join(tmpdir(), 'tm-cap-legacy-native-')))
          throw new Error('invalid native diagnostic root');
        await removeLegacyFixture(directory, { synthetic: true });
      }
    }
  }
  expect(samples).toHaveLength(8);
});
test('production cascade awaits preflight then rebooks actual UTC admission day before a fake effect', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tm-cap-cascade-'));
  const db = new SqliteAdapter(join(directory, 'isolated.db'));
  try {
    await db.query("UPDATE tm_control SET pause_state='RUNNING',epoch=1 WHERE id=1");
    await db.query(`INSERT INTO tm_journal(id,thread_ref,action_type,proposal_json,outcome)
      VALUES ('journal','test:cap','fire_cauldron','{}','pending')`);
    let clock = '2026-10-17T23:59:59.000Z';
    const input = {
      actionKey: 'cap-test',
      journalId: 'journal',
      sourceThreadRef: 'test:cap',
      ownerToken: 'test-owner',
      cascadeId: 'cap-test',
      epoch: 1,
      now: clock,
    };
    expect((await reserveAutomaticFire(input, db)).allowed).toBe(true);
    const options = fakeCascade(directory);
    let preflights = 0;
    options.deps!.preflight = async () => {
      await Promise.resolve();
      preflights++;
      clock = '2026-10-18T00:00:01.000Z';
    };
    options.beforeAdmission = async () => {
      expect(preflights).toBe(1);
      const result = await authorizeAutomaticFire({ ...input, now: clock }, db);
      expect(result.allowed).toBe(true);
      return result.admission!;
    };
    const record = await runCascade(options);
    expect(preflights).toBe(1);
    const durable = await readCascadeRecord(record.cascadeId, directory);
    expect(durable?.automaticFireAdmission?.utcDay).toBe('2026-10-18');
    expect(durable?.attempts[0]?.runId).toBe('actual-child-id');
  } finally {
    await db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
test('denied admission gate creates no provider effect; dry-run never requests permission', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tm-cap-denied-'));
  try {
    let effects = 0;
    let permissions = 0;
    const options = fakeCascade(directory);
    options.deps!.fire = async () => {
      effects++;
      throw new Error('must not fire');
    };
    options.beforeAdmission = async () => {
      permissions++;
      throw new Error('daily cap exhausted');
    };
    await expect(runCascade(options)).rejects.toThrow('daily cap exhausted');
    expect(effects).toBe(0);
    expect(await readCascadeRecord('cap-test', directory)).toBeNull();
    options.dryRun = true;
    expect((await runCascade(options)).status).toBe('planned');
    expect(permissions).toBe(1);
    expect(effects).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test.each([
  'manual-refused',
  'manual-planned',
  'dry-run',
  'matching-permission',
  'foreign-action',
  'foreign-journal',
  'foreign-thread',
  'foreign-cascade',
  'foreign-time',
])('pre-existing zero-attempt record cannot refund later permission: %s', async scenario => {
  const directory = mkdtempSync(join(tmpdir(), 'tm-cap-legacy-collision-'));
  let db = new SqliteAdapter(join(directory, 'test.db'));
  const previousFlag = process.env.TASKMASTER_FIRE_VERB_ENABLED;
  process.env.TASKMASTER_FIRE_VERB_ENABLED = '1';
  try {
    await db.query("UPDATE tm_control SET pause_state='RUNNING',epoch=1 WHERE id=1");
    const day = new Date().toISOString();
    let effects = 0;
    const options = fakeCascade(directory);
    options.deps!.fire = async () => {
      effects++;
      throw new Error('collision must not start a provider');
    };
    if (scenario === 'dry-run') options.dryRun = true;
    else
      options.deps!.findWoClaim = async () => ({
        number: 1,
        state: 'OPEN',
        title: 'existing manual claim',
        url: 'https://example.test/pr/1',
        repo: 'fixture/repo',
      });
    const prior = await runCascade(options);
    if (scenario === 'manual-planned') {
      prior.status = 'planned';
      await writeRecord(prior, directory);
    }
    expect(prior.attempts).toHaveLength(0);
    expect(prior.automaticFireAdmission).toBeUndefined();
    await db.query(
      `INSERT INTO tm_journal(id,thread_ref,action_type,proposal_json,idempotency_key,outcome,created_at)
         VALUES ('collision','test:collision','fire_cauldron',$1,'cap-test','pending',$2)`,
      [
        JSON.stringify({
          cascadeId: 'cap-test',
          fireEvidence: { woId: options.woId, project: options.project },
        }),
        day,
      ]
    );
    const input = {
      actionKey: 'cap-test',
      journalId: 'collision',
      sourceThreadRef: 'test:collision',
      ownerToken: 'actual-owner',
      cascadeId: 'cap-test',
      epoch: 1,
      now: day,
    };
    expect((await reserveAutomaticFire(input, db)).allowed).toBe(true);
    const automatic = fakeCascade(directory);
    automatic.deps!.fire = options.deps!.fire;
    let permission: taskmasterDb.AutomaticFireProvenance | undefined;
    automatic.beforeAdmission = async () => {
      const decision = await authorizeAutomaticFire(input, db);
      expect(decision.allowed).toBe(true);
      permission = decision.admission;
      return decision.admission!;
    };
    if (scenario === 'dry-run')
      await expect(runCascade(automatic)).rejects.toThrow('dispatch identity conflict');
    else expect((await runCascade(automatic)).status).toBe(prior.status);
    expect(await taskmasterDb.releaseAutomaticFire(input, db)).toBe(false);
    await db.query("UPDATE tm_journal SET outcome='failed' WHERE id='collision'");
    const before = (await taskmasterDb.listAutomaticFireAdmissions(db))[0]!;
    expect(before.state).toBe('unknown');
    expect(before.admitted_at).toBe(day);
    if (scenario === 'matching-permission' || scenario.startsWith('foreign-')) {
      // Persist actual returned permission, then isolate one provenance conflict.
      prior.automaticFireAdmission = { ...permission! };
      if (scenario === 'foreign-action') prior.automaticFireAdmission.actionKey = 'foreign';
      if (scenario === 'foreign-journal') prior.automaticFireAdmission.journalId = 'foreign';
      if (scenario === 'foreign-thread') prior.automaticFireAdmission.sourceThreadRef = 'foreign';
      if (scenario === 'foreign-cascade') prior.automaticFireAdmission.cascadeId = 'foreign';
      if (scenario === 'foreign-time') {
        prior.automaticFireAdmission.admittedAt = new Date(
          Date.parse(day) - 86_400_000
        ).toISOString();
        prior.automaticFireAdmission.utcDay = prior.automaticFireAdmission.admittedAt.slice(0, 10);
      }
      await writeRecord(prior, directory);
    }
    if (scenario === 'matching-permission')
      await db.query("UPDATE tm_journal SET outcome='pending' WHERE id='collision'");
    const reconcile = async (at: string) => {
      await expect(
        loop.tick(loop.createTaskmasterState(60_000), {
          now: () => new Date(at),
          db: {
            ...taskmasterDb,
            getActionsSince: async () =>
              (await db.query<taskmasterDb.TmJournalEntry>('SELECT * FROM tm_journal')).rows,
            getPauseState: async () => {
              throw new Error('collision-reconciliation-stop');
            },
            updateActionOutcome: async (id, outcome, proposal) => {
              await db.query('UPDATE tm_journal SET outcome=$1,proposal_json=$2 WHERE id=$3', [
                outcome,
                proposal ?? '{}',
                id,
              ]);
              return null;
            },
            registerExpectation: undefined,
          },
          fireBudget: {
            reserveAutomaticFire: value => taskmasterDb.reserveAutomaticFire(value, db),
            authorizeAutomaticFire: value => taskmasterDb.authorizeAutomaticFire(value, db),
            releaseAutomaticFire: value => taskmasterDb.releaseAutomaticFire(value, db),
            settleAutomaticFire: value => taskmasterDb.settleAutomaticFire(value, db),
            seedAutomaticFireHistory: value => taskmasterDb.seedAutomaticFireHistory(value, db),
            listAutomaticFireAdmissions: () => taskmasterDb.listAutomaticFireAdmissions(db),
            updateAutomaticFireExpectation: value =>
              taskmasterDb.updateAutomaticFireExpectation(value, db),
          },
          readFireCascade: id => readCascadeRecord(id, directory),
          getDispatchReceiptCutoverAt: async () => null,
          checkExpectations: async () => {},
        })
      ).rejects.toThrow('collision-reconciliation-stop');
      const after = (await taskmasterDb.listAutomaticFireAdmissions(db))[0]!;
      if (scenario === 'matching-permission') {
        expect(after.state).toBe('admitted');
        expect(after.admitted_at).toBe(before.admitted_at);
        expect(after.owner_token).toBe(before.owner_token);
        expect(after.utc_day).toBe(before.utc_day);
        // Accounting proof alone cannot confirm custody, before or after restart.
        expect(
          (
            await db.query<{ outcome: string }>(
              "SELECT outcome FROM tm_journal WHERE id='collision'"
            )
          ).rows[0]!.outcome
        ).toBe('pending');
      } else expect(after).toEqual(before);
    };
    await reconcile(day);
    await db.close();
    db = new SqliteAdapter(join(directory, 'test.db'));
    const nextDay = new Date(Date.parse(day) + 86_400_000).toISOString();
    await reconcile(nextDay);
    await db.query(
      `INSERT INTO tm_journal(id,thread_ref,action_type,proposal_json,outcome,created_at)
        VALUES ('replacement','replacement','fire_cauldron','{}','pending',$1)`,
      [nextDay]
    );
    expect(
      (
        await reserveAutomaticFire(
          {
            ...input,
            actionKey: 'replacement',
            journalId: 'replacement',
            sourceThreadRef: 'replacement',
            cascadeId: 'replacement',
            now: nextDay,
          },
          db
        )
      ).allowed
    ).toBe(true); // No daily cap: a distinct action is never refused (custody checks above stay).
    expect(effects).toBe(0);
    expect(await readCascadeRecord('cap-test', directory)).toEqual(prior);
  } finally {
    if (previousFlag === undefined) delete process.env.TASKMASTER_FIRE_VERB_ENABLED;
    else process.env.TASKMASTER_FIRE_VERB_ENABLED = previousFlag;
    await db.close();
    db = undefined as unknown as SqliteAdapter;
    await new Promise<void>(resolve => setImmediate(resolve));
    Bun.gc(true);
    await removeLegacyFixture(directory);
  }
});

test.each([
  'proved',
  'proved-failed',
  'proved-expired',
  'missing-record',
  'wrong-wo',
  'wrong-project',
  'wrong-cascade',
  'running',
  'no-child',
  'invalid-time',
  'future-time',
  'old-pending',
  'post-permission',
  'no-completion',
  'empty-child',
  'missing-identity',
  'invalid-journal-time',
  'cross-day-window',
])('legacy reconciliation across restart and UTC day: %s', async scenario => {
  const directory = mkdtempSync(join(tmpdir(), 'tm-cap-legacy-'));
  let db = new SqliteAdapter(join(directory, 'isolated.db'));
  // D1 observes only the original failing synthetic case. This measures awaited
  // test-owned calls, not native handles or unrelated OS readers/writers.
  const lifecycle: Array<{
    sequence: number;
    phase: string;
    stage: string;
    active: number;
    elapsedMs: number;
    code?: string;
  }> = [];
  const activeWriters = new Map<string, number>();
  const started = performance.now();
  let sequence = 0;
  let peakOwnedWriters = 0;
  const observe = async <T>(
    phase: string,
    key: string,
    operation: () => Promise<T>
  ): Promise<T> => {
    const record = (stage: string, code?: string) => {
      if (lifecycle.length < 32)
        lifecycle.push({
          sequence: sequence++,
          phase,
          stage,
          active: activeWriters.get(key) ?? 0,
          elapsedMs: Math.round(performance.now() - started),
          ...(code ? { code } : {}),
        });
    };
    activeWriters.set(key, (activeWriters.get(key) ?? 0) + 1);
    peakOwnedWriters = Math.max(peakOwnedWriters, activeWriters.get(key)!);
    record('begin');
    try {
      const result = await operation();
      record('fulfilled');
      return result;
    } catch (error) {
      const code: unknown = (error as NodeJS.ErrnoException).code;
      record(
        'rejected',
        typeof code === 'string' && /^[A-Z0-9_]{1,24}$/.test(code) ? code : 'unknown'
      );
      throw error;
    } finally {
      activeWriters.set(key, activeWriters.get(key)! - 1);
      record('end');
    }
  };
  const priorFlag = process.env.TASKMASTER_FIRE_VERB_ENABLED;
  process.env.TASKMASTER_FIRE_VERB_ENABLED = '1';
  try {
    await db.query("UPDATE tm_control SET pause_state='RUNNING',epoch=1 WHERE id=1");
    const records = new Map<string, NonNullable<Awaited<ReturnType<typeof readCascadeRecord>>>>();
    const day = '2026-10-18T12:00:00.000Z';
    for (const key of ['legacy-a', 'legacy-b']) {
      const options = fakeCascade(directory);
      if (scenario === 'old-pending') {
        // Specify BOTH normal methods: supplying writeRecord alone would select
        // runCascade's legacy create shim instead of its real exclusive create.
        options.deps!.createRecord = (record, outDir) =>
          observe('create', key, () => createRecord(record, outDir));
        options.deps!.writeRecord = (record, outDir) =>
          observe('write', key, () => writeRecord(record, outDir));
      }
      options.dispatchId = key;
      const record = await runCascade(options);
      record.createdAt = day;
      for (const attempt of record.attempts) {
        attempt.startedAt = day;
        attempt.completedAt = day;
      }
      if (scenario === 'wrong-wo') record.woId = 'WO-OTHER-01';
      if (scenario === 'wrong-project') record.project = 'other-project';
      if (scenario === 'wrong-cascade') record.cascadeId = 'other-cascade';
      if (scenario === 'running') record.status = 'running';
      if (scenario === 'no-child') record.attempts[0]!.runId = null;
      if (scenario === 'empty-child') record.attempts[0]!.runId = '  ';
      if (scenario === 'no-completion') record.attempts[0]!.completedAt = null;
      if (scenario === 'proved-failed') record.status = 'blocked';
      if (scenario === 'cross-day-window') {
        record.attempts[0]!.startedAt = '2026-10-19T00:00:01.000Z';
        record.attempts[0]!.completedAt = '2026-10-19T00:00:01.000Z';
      }
      if (scenario === 'invalid-time') record.createdAt = 'not-a-time';
      if (scenario === 'future-time') record.createdAt = '2026-10-22T12:00:00.000Z';
      if (!['missing-record', 'old-pending'].includes(scenario)) records.set(key, record);
      await db.query(
        `INSERT INTO tm_journal(id,thread_ref,action_type,proposal_json,idempotency_key,outcome,created_at)
         VALUES ($1,$2,'fire_cauldron',$3,$1,$5,$4)`,
        [
          key,
          `test:${key}`,
          JSON.stringify({
            cascadeId: key,
            fireEvidence:
              scenario === 'missing-identity'
                ? {}
                : { woId: 'WO-CAP-TEST-01', project: 'test-project' },
          }),
          scenario === 'old-pending'
            ? '2026-10-10T12:00:00.000Z'
            : scenario === 'invalid-journal-time'
              ? 'invalid-time'
              : day,
          scenario === 'old-pending'
            ? 'pending'
            : scenario === 'proved-failed'
              ? 'failed'
              : scenario === 'proved-expired'
                ? 'expired'
                : 'sent',
        ]
      );
      if (scenario === 'post-permission') {
        const input = {
          actionKey: key,
          journalId: key,
          sourceThreadRef: `test:${key}`,
          ownerToken: `real-owner:${key}`,
          cascadeId: key,
          epoch: 1,
          now: day,
        };
        // Permission is genuine but its returned provenance was lost before recording.
        await db.query("UPDATE tm_journal SET outcome='pending' WHERE id=$1", [key]);
        expect((await taskmasterDb.reserveAutomaticFire(input, db)).allowed).toBe(true);
        expect((await taskmasterDb.authorizeAutomaticFire(input, db)).allowed).toBe(true);
      }
    }
    const reconcile = async (at: string): Promise<void> => {
      const budget: NonNullable<loop.TaskmasterDeps['fireBudget']> = {
        reserveAutomaticFire: input => taskmasterDb.reserveAutomaticFire(input, db),
        authorizeAutomaticFire: input => taskmasterDb.authorizeAutomaticFire(input, db),
        releaseAutomaticFire: input => taskmasterDb.releaseAutomaticFire(input, db),
        settleAutomaticFire: input => taskmasterDb.settleAutomaticFire(input, db),
        seedAutomaticFireHistory: input => taskmasterDb.seedAutomaticFireHistory(input, db),
        listAutomaticFireAdmissions: () => taskmasterDb.listAutomaticFireAdmissions(db),
        updateAutomaticFireExpectation: input =>
          taskmasterDb.updateAutomaticFireExpectation(input, db),
      };
      // Stop after the real reconciliation boundary, before unrelated tick reads/effects.
      await expect(
        loop.tick(loop.createTaskmasterState(60_000), {
          now: () => new Date(at),
          db: {
            ...taskmasterDb,
            getActionsSince: async since =>
              (
                await db.query<taskmasterDb.TmJournalEntry>(
                  'SELECT * FROM tm_journal WHERE created_at >= $1',
                  [since]
                )
              ).rows,
            getPauseState: async () => {
              throw new Error('isolated-reconciliation-stop');
            },
          },
          fireBudget: budget,
          readFireCascade: async id => records.get(id) ?? null,
          getDispatchReceiptCutoverAt: async () => null,
          checkExpectations: async () => {},
        })
      ).rejects.toThrow('isolated-reconciliation-stop');
    };
    await reconcile(day);
    // No daily cap: unresolved legacy history keeps its custody (asserted below) but never
    // refuses a distinct action.
    await db.query(
      `INSERT INTO tm_journal(id,thread_ref,action_type,proposal_json,
      idempotency_key,outcome,created_at) VALUES ('same-day','same-day','fire_cauldron','{}','same-day','pending',$1)`,
      [day]
    );
    expect(
      (
        await reserveAutomaticFire(
          {
            actionKey: 'same-day',
            journalId: 'same-day',
            sourceThreadRef: 'same-day',
            ownerToken: 'unused',
            cascadeId: 'same-day',
            epoch: 1,
            now: day,
          },
          db
        )
      ).allowed
    ).toBe(true);
    await db.close();
    db = new SqliteAdapter(join(directory, 'isolated.db'));
    const nextDay = '2026-10-19T12:00:00.000Z';
    await reconcile(nextDay);
    for (const key of ['today-a', 'today-b', 'today-overflow']) {
      await db.query(
        `INSERT INTO tm_journal(id,thread_ref,action_type,proposal_json,
        idempotency_key,outcome,created_at) VALUES ($1,$1,'fire_cauldron','{}',$1,'pending',$2)`,
        [key, nextDay]
      );
      const decision = await reserveAutomaticFire(
        {
          actionKey: key,
          journalId: key,
          sourceThreadRef: key,
          ownerToken: 'new-owner',
          cascadeId: key,
          epoch: 1,
          now: nextDay,
        },
        db
      );
      expect(decision.allowed).toBe(true);
    }
    const legacy = (await taskmasterDb.listAutomaticFireAdmissions(db)).filter(row =>
      row.action_key.startsWith('legacy-')
    );
    // Invalid journal time fails the conservative seed before any ledger import.
    expect(legacy).toHaveLength(scenario === 'invalid-journal-time' ? 0 : 2);
    expect(
      legacy.every(row => row.state === (scenario.startsWith('proved') ? 'admitted' : 'unknown'))
    ).toBe(true);
    expect(
      legacy.every(
        row =>
          row.owner_token ===
          (scenario === 'post-permission'
            ? `real-owner:${row.action_key}`
            : 'legacy-reconciliation')
      )
    ).toBe(true);
    expect(records.get('legacy-a')?.automaticFireAdmission).toBeUndefined();
    if (scenario !== 'post-permission')
      expect(
        (await db.query('SELECT proof_deadline_at FROM tm_journal WHERE id=$1', ['legacy-a']))
          .rows[0]?.proof_deadline_at
      ).toBeNull();
  } finally {
    if (scenario === 'old-pending') {
      try {
        console.error(
          'D1_OWNED_RECORDER_LIFECYCLE',
          JSON.stringify({
            synthetic: true,
            peakOwnedWriters,
            activeAtStop: [...activeWriters.values()],
            lifecycle,
            nativeHandleClosure: 'unobserved',
            externalOwners: 'unobserved',
          })
        );
      } catch {
        /* Diagnostic reporting cannot replace the original test error. */
      }
    }
    if (priorFlag === undefined) delete process.env.TASKMASTER_FIRE_VERB_ENABLED;
    else process.env.TASKMASTER_FIRE_VERB_ENABLED = priorFlag;
    await db.close();
    db = undefined as unknown as SqliteAdapter;
    await new Promise<void>(resolve => setImmediate(resolve));
    Bun.gc(true);
    // Yield for Bun's closed SQLite handle finalizer on Windows before cleanup.
    if (!directory.startsWith(join(tmpdir(), 'tm-cap-legacy-')))
      throw new Error('invalid test root');
    await removeLegacyFixture(directory);
  }
});

// ---------------------------------------------------------------------------
// WO-HARNESS-TASKMASTER-NO-DAILY-FIRE-CAP-01 Stop 3: spec Tests 1 and 2 at their stated
// size, through the real loop.tick with the fire budget on a temporary SQLite FILE.
// The world and the other dependencies are the shared fake world
// (../test/taskmaster-loop-world), whose runCascade wrapper asks the loop's real
// beforeAdmission (authorizeAutomaticFire) for permission before the fake effect, so
// every counted fire carries real ledger permission evidence in the file database.
// Added on the acting XO's ruling, bdc-xo#6468 comment 7128535988.
// ---------------------------------------------------------------------------

function fileFireBudget(
  world: FakeWorld,
  db: SqliteAdapter,
  // Runs after a reservation commits and before permission is asked: the asynchronous
  // gap a test may use to move the clock.
  afterReserve: () => void = () => {},
  // Receives the provenance each granted permission returns (what the loop records).
  onPermission: (cascadeId: string, utcDay: string) => void = () => {}
): NonNullable<loop.TaskmasterDeps['fireBudget']> {
  // Mirror the fake world's control row and journal into the file database before each
  // call, exactly as the in-memory fixture does, so reservations join their journal rows.
  const sync = async (): Promise<SqliteAdapter> => {
    await db.query('UPDATE tm_control SET pause_state=$1,epoch=$2 WHERE id=1', [
      world.control.pause_state,
      world.control.epoch,
    ]);
    for (const row of world.journal)
      await db.query(
        `INSERT INTO tm_journal(id,thread_ref,action_type,proposal_json,idempotency_key,outcome,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO UPDATE SET outcome=$6,proposal_json=$4`,
        [
          row.id,
          row.thread_ref,
          row.action_type,
          row.proposal_json,
          row.idempotency_key,
          row.outcome,
          row.created_at,
        ]
      );
    return db;
  };
  return {
    reserveAutomaticFire: async input => {
      const decision = await taskmasterDb.reserveAutomaticFire(input, await sync());
      afterReserve();
      return decision;
    },
    authorizeAutomaticFire: async input => {
      const decision = await taskmasterDb.authorizeAutomaticFire(input, await sync());
      if (decision.allowed && decision.admission)
        onPermission(input.cascadeId, decision.admission.utcDay);
      return decision;
    },
    releaseAutomaticFire: async input => taskmasterDb.releaseAutomaticFire(input, await sync()),
    settleAutomaticFire: async input => taskmasterDb.settleAutomaticFire(input, await sync()),
    seedAutomaticFireHistory: async input =>
      taskmasterDb.seedAutomaticFireHistory(input, await sync()),
    listAutomaticFireAdmissions: async () => taskmasterDb.listAutomaticFireAdmissions(await sync()),
    updateAutomaticFireExpectation: async input =>
      taskmasterDb.updateAutomaticFireExpectation(input, await sync()),
  };
}

function realLoopFixture(
  world: FakeWorld,
  db: SqliteAdapter,
  numbers: number[],
  afterReserve?: () => void
): {
  deps: loop.TaskmasterDeps;
  invocations: Array<{ woId: string; cascadeId: string }>;
  permissionDay: Map<string, string>;
} {
  const threads = numbers.map(number =>
    makeListedThread({
      ref: `gh:thinmansoftware/bdc-harness#${number}`,
      priority: 'P0',
      isUnclaimed: true,
      isUnclaimedP0: true,
      title: `WO-HARNESS-CAP-${number} build`,
      lastActivityAt: new Date(world.nowMs).toISOString(),
    })
  );
  const invocations: Array<{ woId: string; cascadeId: string }> = [];
  const permissionDay = new Map<string, string>();
  const deps = makeDeps(world, {
    listThreads: async () => threads,
    fireBudget: fileFireBudget(world, db, afterReserve, (cascadeId, utcDay) =>
      permissionDay.set(cascadeId, utcDay)
    ),
    // A work order already admitted has its build running, so it is not eligible again;
    // that and the per-tick ceiling are the only gates.
    checkFireEligibility: async title => {
      const woId = title.split(' ')[0]!;
      if (invocations.some(entry => entry.woId === woId)) return { eligible: false };
      return {
        eligible: true,
        evidence: {
          woId,
          targetRepo: 'thinmansoftware/bdc-harness',
          project: 'bdc-harness',
          specVerifiedAt: new Date(world.nowMs).toISOString(),
          noOpenOrMergedPr: true,
          expectedSpec: EXPECTED_SPEC,
          specSource: 'repo-path',
        },
      };
    },
    // The fake effect. The shared wrapper has already obtained real permission.
    runCascade: (async options => {
      invocations.push({ woId: options.woId, cascadeId: options.dispatchId! });
      const record = { cascadeId: options.dispatchId, status: 'running' } as never;
      options.onAdmission?.(record, true);
      return record;
    }) as NonNullable<loop.TaskmasterDeps['runCascade']>,
  });
  return { deps, invocations, permissionDay };
}

/** Ledger rows that carry permission (authorized: unknown until settled, or admitted). */
async function permittedRows(db: SqliteAdapter): Promise<taskmasterDb.AutomaticFireAdmission[]> {
  return (await taskmasterDb.listAutomaticFireAdmissions(db)).filter(
    row => (row.state === 'unknown' || row.state === 'admitted') && row.admitted_at !== null
  );
}

test('spec Test 1: three consecutive ticks fire exactly 3 each, 9 distinct P0 work orders, real ledger permission, no daily deferral', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tm-cap-spec1-'));
  const db = new SqliteAdapter(join(directory, 'budget.db'));
  const prior = process.env.TASKMASTER_FIRE_VERB_ENABLED;
  process.env.TASKMASTER_FIRE_VERB_ENABLED = 'true';
  try {
    const world = makeWorld();
    seedDigestSent(world);
    world.nowMs = Date.parse('2026-08-07T10:00:00.000Z');
    const numbers = [701, 702, 703, 704, 705, 706, 707, 708, 709, 710, 711];
    const { deps, invocations } = realLoopFixture(world, db, numbers);
    const state = loop.createTaskmasterState(60_000);
    const perTick: number[] = [];
    for (let i = 0; i < 3; i++) {
      const before = invocations.length;
      await loop.tick(state, deps);
      perTick.push(invocations.length - before);
      world.nowMs += 60_000;
    }
    // Exactly three per tick on the same UTC day: nine, never two (the old daily cap).
    expect(perTick).toEqual([3, 3, 3]);
    expect(new Set(invocations.map(entry => entry.woId)).size).toBe(9);
    expect(new Set(invocations.map(entry => entry.cascadeId)).size).toBe(9);
    // Ledger permission evidence in the file database: one permitted row per invocation.
    const rows = await permittedRows(db);
    expect(rows.map(row => row.cascade_id).sort()).toEqual(
      invocations.map(entry => entry.cascadeId).sort()
    );
    expect(rows.every(row => row.utc_day === '2026-08-07')).toBe(true);
    // No daily-budget deferral anywhere.
    expect(world.journal.some(row => row.proposal_json.includes('daily_cap'))).toBe(false);
  } finally {
    if (prior === undefined) delete process.env.TASKMASTER_FIRE_VERB_ENABLED;
    else process.env.TASKMASTER_FIRE_VERB_ENABLED = prior;
    await db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('spec Test 2: ticks straddling 00:00Z, with permission asked after midnight for a reservation made before it, fire 3 each and record the actual permission day', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tm-cap-spec2-'));
  const db = new SqliteAdapter(join(directory, 'budget.db'));
  const prior = process.env.TASKMASTER_FIRE_VERB_ENABLED;
  process.env.TASKMASTER_FIRE_VERB_ENABLED = 'true';
  try {
    const world = makeWorld();
    seedDigestSent(world);
    const beforeMidnight = Date.parse('2026-08-07T23:59:00.000Z');
    const lastSecond = Date.parse('2026-08-07T23:59:59.500Z');
    const afterMidnight = Date.parse('2026-08-08T00:00:01.000Z');
    world.nowMs = beforeMidnight;
    let crossMidnight = false;
    const { deps, invocations, permissionDay } = realLoopFixture(
      world,
      db,
      [801, 802, 803, 804, 805, 806, 807, 808, 809],
      () => {
        // The asynchronous gap between reservation and permission crosses midnight.
        if (crossMidnight) world.nowMs = afterMidnight;
      }
    );
    const state = loop.createTaskmasterState(60_000);
    await loop.tick(state, deps);
    expect(invocations).toHaveLength(3);

    world.nowMs = lastSecond;
    crossMidnight = true;
    await loop.tick(state, deps);
    crossMidnight = false;
    expect(invocations).toHaveLength(6);

    world.nowMs = afterMidnight + 60_000;
    await loop.tick(state, deps);
    expect(invocations).toHaveLength(9);
    expect(new Set(invocations.map(entry => entry.woId)).size).toBe(9);

    // Provenance records the actual permission day (the admission the loop stores):
    // the first tick before midnight, everything permitted after midnight on 2026-08-08.
    const rows = await permittedRows(db);
    expect(rows).toHaveLength(9);
    expect(invocations.map(entry => permissionDay.get(entry.cascadeId))).toEqual([
      '2026-08-07',
      '2026-08-07',
      '2026-08-07',
      '2026-08-08',
      '2026-08-08',
      '2026-08-08',
      '2026-08-08',
      '2026-08-08',
      '2026-08-08',
    ]);
    // The crossing really happened: a fire reserved on 2026-08-07 was permitted on 2026-08-08.
    const crossed = rows.filter(
      row =>
        row.reserved_at.startsWith('2026-08-07') &&
        permissionDay.get(row.cascade_id) === '2026-08-08'
    );
    expect(crossed.length).toBeGreaterThanOrEqual(1);
    // No rollover capacity check and no daily-budget deferral.
    expect(world.journal.some(row => row.proposal_json.includes('daily_cap'))).toBe(false);
  } finally {
    if (prior === undefined) delete process.env.TASKMASTER_FIRE_VERB_ENABLED;
    else process.env.TASKMASTER_FIRE_VERB_ENABLED = prior;
    await db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
