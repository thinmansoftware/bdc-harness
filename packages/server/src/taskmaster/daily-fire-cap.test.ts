import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCascade, readCascadeRecord } from '@archon/smart-cauldron/cascade';
import type { RunCascadeOptions } from '@archon/smart-cauldron/cascade';
import { SqliteAdapter } from '@archon/core/db/adapters/sqlite';
import { reserveAutomaticFire, authorizeAutomaticFire } from '@archon/core/db/taskmaster';
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
