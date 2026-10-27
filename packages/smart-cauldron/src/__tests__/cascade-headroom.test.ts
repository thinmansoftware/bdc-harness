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

const HOT_CURSOR_COOL_CODEX: SeatUsageSnapshot = {
  cursor: {
    limit_source: 'measured',
    windows: [{ name: 'primary', used_percent: 83 }],
  },
  codex: {
    limit_source: 'measured',
    windows: [
      { name: 'primary', used_percent: 11 },
      { name: 'secondary', used_percent: 40 },
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
  test('explicit claude entry admits measured headroom and records the decision', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'cascade-claude-admit-'));
    const workflows: string[] = [];
    try {
      const record = await runCascade({
        woId: 'WO-CLAUDE-ADMIT',
        entryOverride: 'claude',
        project: 'fixture',
        outDir,
        token: 'test-token',
        deps: {
          ...claimStubs(),
          seatUsage: async () => ({
            claude: {
              limit_source: 'measured',
              windows: [
                { name: 'seven_day', used_percent: 41 },
                { name: 'five_hour', used_percent: 62 },
              ],
            },
          }),
          fetchNodeTimeouts: async () => ({}),
          fire: async opts => {
            workflows.push(opts.workflowName);
            return { ok: true, runId: 'run-claude', conversationId: 'conv', infraError: null };
          },
          poll: async () => ({
            runId: 'run-claude',
            terminalStatus: 'completed',
            validatorVerdict: 'satisfied',
            prUrl: 'https://github.com/org/repo/pull/1',
            prMergeable: true,
            servedModelId: 'claude-sonnet-5-5',
            rawMetadata: {},
          }),
          judge: () => ({
            pass: true,
            reason: 'passed',
            cancelled: false,
            validatorVerdict: 'satisfied',
            prOpened: true,
            prMergeable: true,
            terminalStatus: 'completed',
          }),
        },
      });
      expect(workflows).toEqual(['bdc-feature-development']);
      expect(record.entrySelection?.reason).toBe('claude_seat_ok:62:80');
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  test('explicit claude entry refuses over-threshold and unknown before recording', async () => {
    for (const [usage, reason] of [
      [
        {
          claude: {
            limit_source: 'measured' as const,
            windows: [{ name: 'seven_day', used_percent: 91 }],
          },
        },
        'claude_seat_over_threshold:91:80',
      ],
      [{ claude: { limit_source: 'UNKNOWN' as const, windows: [] } }, 'claude_seat_unknown'],
    ] as const) {
      let fired = false;
      let recorded = false;
      await expect(
        runCascade({
          woId: 'WO-CLAUDE-DENY',
          entryOverride: 'claude',
          project: 'fixture',
          token: 'test-token',
          deps: {
            seatUsage: async () => usage,
            fire: async () => {
              fired = true;
              return { ok: false, runId: null, conversationId: null, infraError: 'unexpected' };
            },
            createRecord: async record => {
              recorded = true;
              return { created: true, path: 'unexpected', record };
            },
          },
        })
      ).rejects.toThrow(reason);
      expect(fired).toBe(false);
      expect(recorded).toBe(false);
    }
  });

  test('automatic climb admits claude under threshold', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'cascade-claude-climb-'));
    const workflows: string[] = [];
    let judged = 0;
    try {
      const record = await runCascade({
        woId: 'WO-CLAUDE-CLIMB',
        entryOverride: 'codex',
        project: 'fixture',
        outDir,
        token: 'test-token',
        deps: {
          ...claimStubs(),
          seatUsage: async () => ({
            claude: {
              limit_source: 'measured',
              windows: [{ name: 'seven_day', used_percent: 41 }],
            },
          }),
          fetchNodeTimeouts: async () => ({}),
          fire: async opts => {
            workflows.push(opts.workflowName);
            return {
              ok: true,
              runId: `run-${workflows.length}`,
              conversationId: 'conv',
              infraError: null,
            };
          },
          poll: async () => ({
            runId: 'run',
            terminalStatus: 'completed',
            validatorVerdict: 'satisfied',
            prUrl: 'https://github.com/org/repo/pull/1',
            prMergeable: true,
            servedModelId: null,
            rawMetadata: {},
          }),
          judge: () => {
            judged++;
            return {
              pass: judged === 2,
              reason: judged === 2 ? 'passed' : 'needs revision',
              cancelled: false,
              validatorVerdict: judged === 2 ? 'satisfied' : 'needs_revision',
              prOpened: judged === 2,
              prMergeable: judged === 2,
              terminalStatus: 'completed',
            };
          },
        },
      });
      expect(workflows).toEqual(['bdc-feature-development-codex', 'bdc-feature-development']);
      expect(record.winningTier).toBe('claude');
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  test('default Fuelglass reader parses seats and converts HTTP 500 to unknown', async () => {
    let status = 200;
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        status === 200
          ? Response.json({
              seats: {
                claude: {
                  limit_source: 'measured',
                  windows: [{ name: 'seven_day', used_percent: 41 }],
                },
                codex: { limit_source: 'UNKNOWN', windows: [] },
                cursor: { limit_source: 'UNKNOWN', windows: [] },
              },
            })
          : new Response('failed', { status }),
    });
    try {
      const measured = await runCascade({
        woId: 'WO-DEFAULT-SEATS',
        entryOverride: 'claude',
        project: 'fixture',
        dryRun: true,
        apiBaseUrl: server.url.origin,
        token: 'test-token',
      });
      expect(measured.entrySelection?.reason).toBe('claude_seat_ok:41:80');
      status = 500;
      const unavailable = await runCascade({
        woId: 'WO-DEFAULT-SEATS-500',
        project: 'fixture',
        dryRun: true,
        apiBaseUrl: server.url.origin,
        token: 'test-token',
      });
      expect(unavailable.telemetry.entryTier).toBe('cursor');
      expect(unavailable.entrySelection?.reason).toBe('seat_unknown:cursor');
    } finally {
      server.stop(true);
    }
  });

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
            seatUsage: async () => HOT_CURSOR_COOL_CODEX,
          },
        });
        expect(moved.telemetry.entryTier).toBe('codex');
        expect(moved.entrySelection?.reason).toBe('seat_over_threshold:cursor:83');
        expect(moved.entrySelection?.entry).toBe('codex');
        expect(moved.entrySelection?.picked).toBe('cursor');
        const movedFile = JSON.parse(
          await readFile(recordPath(outDir, movedId), 'utf8')
        ) as CascadeRunRecord;
        expect(movedFile.entrySelection?.reason).toBe('seat_over_threshold:cursor:83');
        expect(movedFile.telemetry.entryTier).toBe('codex');

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
        expect(rejected.telemetry.entryTier).toBe('cursor');
        expect(rejected.entrySelection?.reason).toBe('seat_unknown:cursor');

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
        expect(timedOut.telemetry.entryTier).toBe('cursor');
        expect(timedOut.entrySelection?.reason).toBe('seat_unknown:cursor');

        const absent = await runCascade({
          woId: 'WO-HEADROOM-ABSENT',
          woClass: 'CODE',
          project: 'fixture',
          dryRun: true,
          outDir,
          dispatchId: 'headroom-absent',
          token: 'test-token',
        });
        expect(absent.telemetry.entryTier).toBe('cursor');
        expect(absent.entrySelection?.reason).toBe('seat_unknown:cursor');
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
