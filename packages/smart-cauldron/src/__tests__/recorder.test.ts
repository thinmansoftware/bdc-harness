import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { createRecord, writeRecord } from '../recorder.js';
import type { CascadeRunRecord } from '../types.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

function record(overrides: Partial<CascadeRunRecord> = {}): CascadeRunRecord {
  return {
    cascadeId: 'caller-supplied-idempotency-key-with-shared-prefix',
    woId: 'WO-TEST-RECORDER-001',
    project: 'harness',
    request: {
      woClass: 'CODE',
      tags: ['mechanical'],
      entryOverride: null,
      dryRun: false,
    },
    createdAt: '2026-07-09T12:00:00.000Z',
    status: 'running',
    winningTier: null,
    attempts: [],
    totalCostUsd: null,
    telemetry: {
      entryTier: 'codex',
      climbed: false,
      climbCount: 0,
      wonCheap: false,
    },
    ...overrides,
  };
}

async function makeOutDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'smart-cauldron-recorder-'));
  tempDirs.push(dir);
  return dir;
}

describe('durable cascade recorder', () => {
  test('deduplicates the full dispatch identity across creation dates', async () => {
    const outDir = await makeOutDir();
    const first = await createRecord(record(), outDir);
    const replay = await createRecord(
      record({ createdAt: '2026-07-10T12:00:00.000Z', status: 'planned' }),
      outDir
    );

    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.path).toBe(first.path);
    expect(replay.record.createdAt).toBe('2026-07-09T12:00:00.000Z');
    expect(replay.record.status).toBe('running');
  });

  test('does not collide when dispatch keys share their first eight characters', async () => {
    const outDir = await makeOutDir();
    const first = await createRecord(record({ cascadeId: 'shared-prefix-key-a' }), outDir);
    const second = await createRecord(record({ cascadeId: 'shared-prefix-key-b' }), outDir);

    expect(second.created).toBe(true);
    expect(second.path).not.toBe(first.path);
  });

  test('rejects reuse of a dispatch key for a different authority scope', async () => {
    const outDir = await makeOutDir();
    await createRecord(record(), outDir);

    await expect(createRecord(record({ project: 'shopops' }), outDir)).rejects.toThrow(
      'dispatch identity conflict'
    );
  });

  test('rejects reuse of a dispatch key for a different WO or request shape', async () => {
    const outDir = await makeOutDir();
    await createRecord(record(), outDir);

    await expect(createRecord(record({ woId: 'WO-TEST-RECORDER-002' }), outDir)).rejects.toThrow(
      'dispatch identity conflict'
    );
    await expect(
      createRecord(
        record({
          request: {
            woClass: 'INFRA',
            tags: ['mechanical'],
            entryOverride: null,
            dryRun: false,
          },
        }),
        outDir
      )
    ).rejects.toThrow('dispatch identity conflict');
  });

  test('replaces checkpoints with complete JSON records', async () => {
    const outDir = await makeOutDir();
    const admitted = await createRecord(record(), outDir);
    await writeRecord(record({ status: 'won', winningTier: 'codex' }), outDir);

    const persisted = JSON.parse(await readFile(admitted.path, 'utf8')) as CascadeRunRecord;
    expect(persisted.status).toBe('won');
    expect(persisted.winningTier).toBe('codex');
  });
});
