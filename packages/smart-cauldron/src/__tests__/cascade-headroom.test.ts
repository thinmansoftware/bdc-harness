import { describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { runCascade, type CascadeDeps } from '../cascade.js';
import type { SeatUsageSnapshot } from '../headroom.js';
import type { CascadeRunRecord } from '../types.js';

const THRESHOLD_ENV = 'SMART_CAULDRON_HEADROOM_THRESHOLD_PERCENT';

const HOT_CODEX_COOL_CLAUDE: SeatUsageSnapshot = {
  codex: {
    limit_source: 'measured',
    windows: [
      { name: 'primary', used_percent: 83 },
      { name: 'secondary', used_percent: 40 },
    ],
  },
  claude: {
    limit_source: 'measured',
    windows: [
      { name: 'five_hour', used_percent: 11 },
      { name: 'seven_day', used_percent: 45 },
    ],
  },
};

function recordPath(outDir: string, dispatchId: string): string {
  const slug = `dispatch-${createHash('sha256').update(dispatchId).digest('hex').slice(0, 24)}`;
  return join(outDir, slug, 'cascade-record.json');
}

async function withDefaultThreshold<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env[THRESHOLD_ENV];
  delete process.env[THRESHOLD_ENV];
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env[THRESHOLD_ENV];
    else process.env[THRESHOLD_ENV] = previous;
  }
}

function claimStubs(): Pick<CascadeDeps, 'findWoClaim' | 'acquireWoLock' | 'releaseWoLock'> {
  return {
    findWoClaim: async () => null,
    acquireWoLock: async (woId, project, cascadeId) => ({
      acquired: true,
      path: 'in-memory-test-lock',
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
  };
}

describe('cascade headroom', () => {
  test('cascade-dry-run-records-entry-selection', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'cascade-headroom-dry-'));
    try {
      await withDefaultThreshold(async () => {
        const movedId = 'headroom-dry-moved';
        const moved = await runCascade({
          woId: 'WO-HEADROOM-DRY',
          woClass: 'CODE',
          project: 'fixture',
          dryRun: true,
          outDir,
          dispatchId: movedId,
          token: 'test-token',
          deps: {
            seatUsage: async () => HOT_CODEX_COOL_CLAUDE,
          },
        });
        expect(moved.telemetry.entryTier).toBe('claude');
        expect(moved.entrySelection?.reason).toBe('seat_over_threshold:codex:83');
        expect(moved.entrySelection?.entry).toBe('claude');
        expect(moved.entrySelection?.picked).toBe('codex');
        const movedFile = JSON.parse(
          await readFile(recordPath(outDir, movedId), 'utf8')
        ) as CascadeRunRecord;
        expect(movedFile.entrySelection?.reason).toBe('seat_over_threshold:codex:83');
        expect(movedFile.telemetry.entryTier).toBe('claude');

        const pinnedId = 'headroom-dry-pinned';
        const pinned = await runCascade({
          woId: 'WO-HEADROOM-DRY',
          woClass: 'CODE',
          project: 'fixture',
          dryRun: true,
          outDir,
          dispatchId: pinnedId,
          entryOverride: 'codex',
          token: 'test-token',
          deps: {
            seatUsage: async () => HOT_CODEX_COOL_CLAUDE,
          },
        });
        expect(pinned.telemetry.entryTier).toBe('codex');
        expect(pinned.entrySelection?.reason).toBe('pinned');
        expect(pinned.entrySelection?.entry).toBe('codex');
        const pinnedFile = JSON.parse(
          await readFile(recordPath(outDir, pinnedId), 'utf8')
        ) as CascadeRunRecord;
        expect(pinnedFile.entrySelection?.reason).toBe('pinned');
        expect(pinnedFile.telemetry.entryTier).toBe('codex');
      });
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  test('seat-reader-failure-or-timeout-fails-open', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'cascade-headroom-failopen-'));
    try {
      await withDefaultThreshold(async () => {
        const rejected = await runCascade({
          woId: 'WO-HEADROOM-REJECT',
          woClass: 'CODE',
          project: 'fixture',
          dryRun: true,
          outDir,
          dispatchId: 'headroom-rejected',
          token: 'test-token',
          deps: {
            seatUsage: async () => {
              throw new Error('reader down');
            },
          },
        });
        expect(rejected.telemetry.entryTier).toBe('codex');
        expect(rejected.entrySelection?.reason).toBe('seat_usage_unavailable');

        const started = Date.now();
        const timedOut = await runCascade({
          woId: 'WO-HEADROOM-TIMEOUT',
          woClass: 'CODE',
          project: 'fixture',
          dryRun: true,
          outDir,
          dispatchId: 'headroom-timeout',
          token: 'test-token',
          deps: {
            seatUsage: () => new Promise<SeatUsageSnapshot>(() => {}),
          },
        });
        expect(Date.now() - started).toBeLessThan(8000);
        expect(timedOut.telemetry.entryTier).toBe('codex');
        expect(timedOut.entrySelection?.reason).toBe('seat_usage_unavailable');

        const absent = await runCascade({
          woId: 'WO-HEADROOM-ABSENT',
          woClass: 'CODE',
          project: 'fixture',
          dryRun: true,
          outDir,
          dispatchId: 'headroom-absent',
          token: 'test-token',
        });
        expect(absent.telemetry.entryTier).toBe('codex');
        expect(absent.entrySelection).toBeUndefined();
      });
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  }, 20000);

  test('attempt-carries-node-models', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'cascade-headroom-nodes-'));
    const dispatchId = 'headroom-node-models';
    const nodeModels = {
      implement: {
        provider: 'claude' as const,
        declared: 'sonnet' as const,
        served: 'claude-sonnet-5' as const,
      },
    };
    try {
      const record = await runCascade({
        woId: 'WO-HEADROOM-NODES',
        woClass: 'CODE',
        project: 'fixture',
        outDir,
        dispatchId,
        token: 'test-token',
        deps: {
          ...claimStubs(),
          fetchNodeTimeouts: async () => ({}),
          fire: async () => ({
            ok: true,
            runId: 'run-node-models',
            conversationId: 'conv-node-models',
            infraError: null,
          }),
          poll: async () => ({
            runId: 'run-node-models',
            terminalStatus: 'completed',
            validatorVerdict: 'satisfied',
            prUrl: 'https://github.com/org/repo/pull/1',
            prMergeable: true,
            servedModelId: 'claude-sonnet-5',
            rawMetadata: {},
            nodeModels,
          }),
          judge: () => ({
            pass: true,
            reason: 'all gate conditions passed',
            cancelled: false,
            validatorVerdict: 'satisfied',
            prOpened: true,
            prMergeable: true,
            terminalStatus: 'completed',
          }),
        },
      });
      expect(record.status).toBe('won');
      expect(record.attempts).toHaveLength(1);
      expect(record.attempts[0]?.nodeModels).toEqual(nodeModels);
      const persisted = JSON.parse(
        await readFile(recordPath(outDir, dispatchId), 'utf8')
      ) as CascadeRunRecord;
      expect(persisted.attempts[0]?.nodeModels).toEqual(nodeModels);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
});
