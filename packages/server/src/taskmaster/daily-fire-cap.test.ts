import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCascade, readCascadeRecord } from '@archon/smart-cauldron/cascade';
import type { RunCascadeOptions } from '@archon/smart-cauldron/cascade';
import { SqliteAdapter } from '@archon/core/db/adapters/sqlite';
import { reserveAutomaticFire, authorizeAutomaticFire } from '@archon/core/db/taskmaster';
import * as taskmasterDb from '@archon/core/db/taskmaster';
import * as loop from './loop';

test('daily cap defaults to two and invalid configuration fails closed', () => {
  expect(loop.resolveTaskmasterFireDailyLimit(undefined)).toBe(2);
  expect(loop.resolveTaskmasterFireDailyLimit('0')).toBe(0);
  expect(loop.resolveTaskmasterFireDailyLimit('5')).toBe(5);
  for (const input of ['-1', '1.5', 'NaN', '', '2oops', '9007199254740992']) {
    expect(loop.resolveTaskmasterFireDailyLimit(input)).toBe(0);
  }
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
      limit: 2,
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
  const priorFlag = process.env.TASKMASTER_FIRE_VERB_ENABLED;
  process.env.TASKMASTER_FIRE_VERB_ENABLED = '1';
  try {
    await db.query("UPDATE tm_control SET pause_state='RUNNING',epoch=1 WHERE id=1");
    const records = new Map<string, NonNullable<Awaited<ReturnType<typeof readCascadeRecord>>>>();
    const day = '2026-10-18T12:00:00.000Z';
    for (const key of ['legacy-a', 'legacy-b']) {
      const options = fakeCascade(directory);
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
          limit: 2,
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
    expect(
      (
        await reserveAutomaticFire(
          {
            actionKey: 'same-day',
            journalId: 'unused',
            sourceThreadRef: 'unused',
            ownerToken: 'unused',
            cascadeId: 'unused',
            epoch: 1,
            limit: 2,
            now: day,
          },
          db
        )
      ).allowed
    ).toBe(false);
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
          limit: 2,
          now: nextDay,
        },
        db
      );
      expect(decision.allowed).toBe(scenario.startsWith('proved') && key !== 'today-overflow');
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
    if (priorFlag === undefined) delete process.env.TASKMASTER_FIRE_VERB_ENABLED;
    else process.env.TASKMASTER_FIRE_VERB_ENABLED = priorFlag;
    await db.close();
    db = undefined as unknown as SqliteAdapter;
    await new Promise<void>(resolve => setImmediate(resolve));
    Bun.gc(true);
    // Yield for Bun's closed SQLite handle finalizer on Windows before cleanup.
    if (!directory.startsWith(join(tmpdir(), 'tm-cap-legacy-')))
      throw new Error('invalid test root');
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
