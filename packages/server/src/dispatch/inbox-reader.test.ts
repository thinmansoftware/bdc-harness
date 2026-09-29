import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  buildReportFromSurfaceLines,
  resolveInboxReaderConfig,
  runInboxReader,
  shouldStartOperatorInboxConsumer,
  type InboxReaderConfig,
  type InboxReaderDeps,
  type InboxReaderFs,
} from './inbox-reader';
import { classifyInboxMessage } from './inbox-reader-rules';
import { readWorkerHeartbeatAlarmConfig } from './worker-heartbeat-alarm';
import {
  buildRow,
  F1,
  F2,
  F3,
  F4,
  F5,
  F6,
  F7,
  F8,
  F9,
  F10,
  F11,
  F12,
  type InboxFixture,
} from './inbox-reader.fixtures';

const NOW = '2026-09-29T12:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const ROOT = '/mem/inbox-reader';

function isoAgoHours(hours: number): string {
  return new Date(NOW_MS - hours * 3_600_000).toISOString();
}
function isoAgoMinutes(minutes: number): string {
  return new Date(NOW_MS - minutes * 60_000).toISOString();
}

/**
 * In-memory filesystem. Used instead of the real fs so these tests are immune to
 * the process-global `mock.module('fs/promises', ...)` pollution from sibling
 * dispatch test files (notifiers.test.ts). Satisfies the WO's DI requirement:
 * the file-write functions are injected and can be forced to throw (Test 11a).
 */
function makeMemFs(): { fs: InboxReaderFs; files: Map<string, string> } {
  const files = new Map<string, string>();
  const fs: InboxReaderFs = {
    writeFileAtomic: async (path, contents): Promise<void> => {
      files.set(path, contents);
    },
    readFile: async (path): Promise<string> => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`ENOENT:${path}`);
      return value;
    },
    appendLine: async (path, line): Promise<void> => {
      files.set(path, `${files.get(path) ?? ''}${line}\n`);
    },
    ensureDir: async (): Promise<void> => {},
    listDir: async (path): Promise<string[]> => {
      const prefix = path.endsWith('/') ? path : `${path}/`;
      return [...files.keys()]
        .filter(key => key.startsWith(prefix))
        .map(key => key.slice(prefix.length))
        .filter(name => !name.includes('/'));
    },
    removeFile: async (path): Promise<void> => {
      files.delete(path);
    },
  };
  return { fs, files };
}

function makeConfig(overrides: Partial<InboxReaderConfig> = {}): InboxReaderConfig {
  return {
    intervalMs: 300_000,
    mode: 'dry-run',
    maxPerRun: 500,
    minAgeMs: 600_000,
    operatorOwner: 'consumer',
    recipients: ['xo'],
    actionableAlertHours: 24,
    gapAlertHours: 2,
    alertRepeatHours: 6,
    retentionDays: 14,
    ...overrides,
  };
}

interface DisposeCall {
  id: string;
  actor: string;
  disposition: string;
  requireNoReceipt: boolean;
}

interface HarnessOptions {
  rows: Record<string, ReturnType<typeof buildRow>[]>;
  disposeImpl?: (data: DisposeCall) => Promise<{ ok: true } | { ok: false; reason: string }>;
  listImpl?: InboxReaderDeps['listMessages'];
  clock?: () => Date;
  fs?: InboxReaderFs;
}

function makeDeps(opts: HarnessOptions): {
  deps: InboxReaderDeps;
  disposeCalls: DisposeCall[];
  heartbeatCalls: { worker_id: string }[];
  files: Map<string, string>;
} {
  const disposeCalls: DisposeCall[] = [];
  const heartbeatCalls: { worker_id: string }[] = [];
  const mem = makeMemFs();
  const fs = opts.fs ?? mem.fs;
  const deps: InboxReaderDeps = {
    listMessages:
      opts.listImpl ??
      (async ({ recipient, limit }): Promise<ReturnType<typeof buildRow>[]> => {
        const all = opts.rows[recipient] ?? [];
        return all.slice(0, limit);
      }),
    disposeMessageByMachine: async (
      data
    ): Promise<{ ok: true } | { ok: false; reason: string }> => {
      disposeCalls.push({ ...data });
      if (opts.disposeImpl) return opts.disposeImpl(data);
      return { ok: true };
    },
    heartbeatWorker: async (data): Promise<unknown> => {
      heartbeatCalls.push(data);
      return null;
    },
    now: opts.clock ?? ((): Date => new Date(NOW)),
    rootDir: ROOT,
    fs,
  };
  return { deps, disposeCalls, heartbeatCalls, files: mem.files };
}

function readLatest(files: Map<string, string>): Record<string, unknown> {
  const raw = files.get(join(ROOT, 'latest.json'));
  if (raw === undefined) throw new Error('latest.json not written');
  return JSON.parse(raw);
}
function runFileCount(files: Map<string, string>): number {
  const prefix = `${join(ROOT, 'runs')}/`;
  return [...files.keys()].filter(key => key.startsWith(prefix) && key.endsWith('.json')).length;
}
function alertLines(files: Map<string, string>): Record<string, unknown>[] {
  const raw = files.get(join(ROOT, 'alerts.jsonl'));
  if (raw === undefined) return [];
  return raw
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line));
}

describe('inbox-reader', () => {
  test('T1 overseer approved receipt is INFO_DUPLICATE and disposed expired in enforce', async () => {
    const rows = [
      buildRow(F1, { created_at: isoAgoHours(2) }),
      buildRow(F2, { created_at: isoAgoHours(2) }),
    ];
    const { deps, disposeCalls } = makeDeps({ rows: { xo: rows } });
    const result = await runInboxReader(deps, makeConfig({ mode: 'enforce' }));

    for (const row of rows) {
      expect(classifyInboxMessage(row).class).toBe('INFO_DUPLICATE');
      expect(classifyInboxMessage(row).rule_id).toBe('info_review_posted');
    }
    expect(disposeCalls).toEqual([
      { id: F1.id, actor: 'system:inbox-reader', disposition: 'expired', requireNoReceipt: true },
      { id: F2.id, actor: 'system:inbox-reader', disposition: 'expired', requireNoReceipt: true },
    ]);
    const plan = result.digest?.disposal_plan ?? [];
    expect(plan).toHaveLength(2);
    for (const entry of plan) {
      expect(entry.reason.startsWith('inbox-reader R1 info_review_posted')).toBe(true);
    }
  });

  test('T2 intermediate and ingest receipts are INFO_DUPLICATE', () => {
    const f3 = classifyInboxMessage(buildRow(F3, { created_at: isoAgoHours(2) }));
    const f4 = classifyInboxMessage(buildRow(F4, { created_at: isoAgoHours(2) }));
    expect(f3).toMatchObject({ class: 'INFO_DUPLICATE', rule_id: 'info_submit_intermediate' });
    expect(f4).toMatchObject({ class: 'INFO_DUPLICATE', rule_id: 'info_ingest_receipt' });
  });

  test('T3 taskmaster daily nudges collapse to one line with count and newest timestamp', async () => {
    const newest = isoAgoHours(1);
    const rows = [
      buildRow(F7, { id: 'nudge-3h', created_at: isoAgoHours(3) }),
      buildRow(F7, { id: 'nudge-2h', created_at: isoAgoHours(2) }),
      buildRow(F7, { id: 'nudge-1h', created_at: newest }),
    ];
    const { deps, disposeCalls } = makeDeps({ rows: { xo: rows } });
    const result = await runInboxReader(deps, makeConfig({ mode: 'enforce' }));

    const nudges = result.digest?.nudges ?? [];
    expect(nudges).toHaveLength(1);
    expect(nudges[0].count).toBe(3);
    expect(nudges[0].newest_created_at).toBe(newest);
    expect(nudges[0].ids).toHaveLength(3);
    expect(disposeCalls).toHaveLength(3);
    expect(classifyInboxMessage(rows[0]).class).toBe('NUDGE');
  });

  test('T4 codex escalation asking a question is ACTIONABLE and never disposed', async () => {
    const row = buildRow(F8, { created_at: isoAgoHours(30) });
    const { deps, disposeCalls } = makeDeps({ rows: { xo: [row] } });
    const result = await runInboxReader(deps, makeConfig({ mode: 'enforce' }));

    expect(classifyInboxMessage(row)).toMatchObject({
      class: 'ACTIONABLE',
      rule_id: 'unknown_sender',
    });
    const actionable = result.digest?.actionable ?? [];
    const entry = actionable.find(a => a.id === F8.id);
    expect(entry).toBeDefined();
    expect(entry?.excerpt.length).toBe(200);
    expect(disposeCalls.find(c => c.id === F8.id)).toBeUndefined();
    expect(
      result.alertsWritten.some(a => a.kind === 'actionable_stale' && a.recipient === 'xo')
    ).toBe(true);
  });

  test('T5 P0 and blocker-priority messages are ACTIONABLE', () => {
    expect(classifyInboxMessage(buildRow(F9, { created_at: NOW }))).toMatchObject({
      class: 'ACTIONABLE',
      rule_id: 'keyword',
    });
    expect(classifyInboxMessage(buildRow(F10, { created_at: NOW }))).toMatchObject({
      class: 'ACTIONABLE',
      rule_id: 'blocker_priority',
    });
    expect(classifyInboxMessage(buildRow(F5, { created_at: NOW }))).toMatchObject({
      class: 'ACTIONABLE',
      rule_id: 'keyword',
    });
    expect(classifyInboxMessage(buildRow(F6, { created_at: NOW }))).toMatchObject({
      class: 'ACTIONABLE',
      rule_id: 'no_rule_matched',
    });
    expect(classifyInboxMessage(buildRow(F12, { created_at: NOW }))).toMatchObject({
      class: 'ACTIONABLE',
      rule_id: 'keyword',
    });
  });

  test('T6 unknown sender is ACTIONABLE', () => {
    expect(classifyInboxMessage(buildRow(F11, { created_at: NOW }))).toMatchObject({
      class: 'ACTIONABLE',
      rule_id: 'unknown_sender',
    });
    const alteredF1: InboxFixture = { ...F1, sender: 'overseer-v2' };
    expect(classifyInboxMessage(buildRow(alteredF1, { created_at: NOW }))).toMatchObject({
      class: 'ACTIONABLE',
      rule_id: 'unknown_sender',
    });
  });

  test('T7 a 5-minute-old message is never disposed', async () => {
    const row = buildRow(F1, { created_at: isoAgoMinutes(5) });
    const { deps, disposeCalls } = makeDeps({ rows: { xo: [row] } });
    const result = await runInboxReader(deps, makeConfig({ mode: 'enforce' }));

    expect(classifyInboxMessage(row).class).toBe('INFO_DUPLICATE');
    expect(result.digest?.counts.xo.too_young).toBe(1);
    expect(result.digest?.disposal_plan).toHaveLength(0);
    expect(disposeCalls).toHaveLength(0);
  });

  test('T8 non-queued, already-disposed, addressed and acked rows are not disposed', async () => {
    const rows = [
      buildRow(F1, { id: 'done', created_at: isoAgoHours(2), status: 'done' }),
      buildRow(F1, {
        id: 'surfaced',
        created_at: isoAgoHours(2),
        route_disposition: 'auto_surfaced',
      }),
      buildRow(F1, { id: 'addressed', created_at: isoAgoHours(2), addressed_at: isoAgoHours(1) }),
      buildRow(F1, { id: 'acked', created_at: isoAgoHours(2), acknowledged_at: isoAgoHours(1) }),
    ];
    const { deps, disposeCalls } = makeDeps({ rows: { xo: rows } });
    const result = await runInboxReader(deps, makeConfig({ mode: 'enforce' }));

    expect(disposeCalls).toHaveLength(0);
    expect(result.digest?.counts.xo.skipped).toBe(3);
    expect(result.digest?.counts.xo.acked_open).toBe(1);
  });

  test('T9 per-run cap of 500 is batched, resumable and idempotent', async () => {
    const store = Array.from({ length: 620 }, (_, i) =>
      buildRow(F1, { id: `m${i}`, created_at: isoAgoHours(2) })
    );
    const disposed = new Set<string>();
    const listCalls: number[] = [];
    const mem = makeMemFs();
    const deps: InboxReaderDeps = {
      listMessages: async ({ limit }): Promise<ReturnType<typeof buildRow>[]> => {
        listCalls.push(limit);
        return store.filter(r => !disposed.has(r.id)).slice(0, limit);
      },
      disposeMessageByMachine: async ({ id }): Promise<{ ok: true }> => {
        if (disposed.has(id)) throw new Error(`double_dispose:${id}`);
        disposed.add(id);
        return { ok: true };
      },
      heartbeatWorker: async (): Promise<unknown> => null,
      now: (): Date => new Date(NOW),
      rootDir: ROOT,
      fs: mem.fs,
    };
    const config = makeConfig({ mode: 'enforce', maxPerRun: 500 });

    const r1 = await runInboxReader(deps, config);
    expect(listCalls[0]).toBe(500);
    expect(r1.digest?.disposal_summary.disposed).toBe(500);
    expect(disposed.size).toBe(500);

    const r2 = await runInboxReader(deps, config);
    expect(r2.digest?.disposal_summary.disposed).toBe(120);
    expect(disposed.size).toBe(620);

    const r3 = await runInboxReader(deps, config);
    expect(r3.digest?.disposal_summary.disposed).toBe(0);
    expect(disposed.size).toBe(620);
  });

  test('T10 dry-run is the default and writes the digest without any disposition', async () => {
    const config = resolveInboxReaderConfig({} as NodeJS.ProcessEnv);
    expect(config.mode).toBe('dry-run');

    const rows = [
      buildRow(F1, { created_at: isoAgoHours(2) }),
      buildRow(F3, { created_at: isoAgoHours(2) }),
      buildRow(F7, { created_at: isoAgoHours(2) }),
      buildRow(F8, { created_at: isoAgoHours(2) }),
    ];
    const { deps, disposeCalls, files } = makeDeps({ rows: { xo: rows } });

    await runInboxReader(deps, config);
    await runInboxReader(deps, config);

    expect(disposeCalls).toHaveLength(0);
    expect(runFileCount(files)).toBeGreaterThanOrEqual(1);
    const latest = readLatest(files) as {
      disposal_plan: unknown[];
      actionable: unknown[];
      disposal_results: unknown[];
    };
    expect(latest.disposal_plan).toHaveLength(3);
    expect(latest.actionable).toHaveLength(1);
    expect(latest.disposal_results).toHaveLength(0);

    expect(
      resolveInboxReaderConfig({ INBOX_READER_MODE: 'Enforce' } as NodeJS.ProcessEnv).mode
    ).toBe('dry-run');
  });

  test('T11 digest is persisted and read back before the first disposition', async () => {
    // (a) filesystem write throws => zero dispose, digest_write_failed.
    {
      const mem = makeMemFs();
      const throwingFs: InboxReaderFs = {
        ...mem.fs,
        writeFileAtomic: async (): Promise<void> => {
          throw new Error('disk_full');
        },
      };
      const { deps, disposeCalls } = makeDeps({
        rows: { xo: [buildRow(F1, { created_at: isoAgoHours(2) })] },
        fs: throwingFs,
      });
      const result = await runInboxReader(deps, makeConfig({ mode: 'enforce' }));
      expect(disposeCalls).toHaveLength(0);
      expect(result.digestWriteFailed).toBe(true);
    }

    // (b) call-order recorder: run-file rename + read-back strictly before first dispose.
    {
      const order: string[] = [];
      const mem = makeMemFs();
      const recordingFs: InboxReaderFs = {
        ...mem.fs,
        writeFileAtomic: async (path, contents): Promise<void> => {
          await mem.fs.writeFileAtomic(path, contents);
          order.push(`write:${path.includes('runs') ? 'runfile' : 'latest'}`);
        },
        readFile: async (path): Promise<string> => {
          const data = await mem.fs.readFile(path);
          order.push('read');
          return data;
        },
      };
      const { deps, disposeCalls } = makeDeps({
        rows: { xo: [buildRow(F1, { created_at: isoAgoHours(2) })] },
        fs: recordingFs,
        disposeImpl: async (): Promise<{ ok: true }> => {
          order.push('dispose');
          return { ok: true };
        },
      });
      await runInboxReader(deps, makeConfig({ mode: 'enforce' }));
      const files = mem.files;

      const firstDispose = order.indexOf('dispose');
      const lastRead = order.lastIndexOf('read');
      const runfileWrite = order.indexOf('write:runfile');
      expect(firstDispose).toBeGreaterThan(-1);
      expect(runfileWrite).toBeGreaterThan(-1);
      expect(runfileWrite).toBeLessThan(firstDispose);
      expect(lastRead).toBeLessThan(firstDispose);
      expect(disposeCalls).toHaveLength(1);

      const prefix = `${join(ROOT, 'runs')}/`;
      const runKey = [...files.keys()].find(key => key.startsWith(prefix) && key.endsWith('.json'));
      expect(runKey).toBeDefined();
      const parsed = JSON.parse(files.get(runKey as string) as string) as {
        disposal_plan: { id: string }[];
      };
      expect(parsed.disposal_plan.some(entry => entry.id === F1.id)).toBe(true);
    }
  });

  test('T12 ACTIONABLE never reaches disposeMessageByMachine', async () => {
    const all = [F1, F2, F3, F4, F5, F6, F7, F8, F9, F10, F11, F12].map(f =>
      buildRow(f, { created_at: isoAgoHours(48) })
    );
    const { deps, disposeCalls } = makeDeps({ rows: { xo: all } });
    await runInboxReader(deps, makeConfig({ mode: 'enforce' }));

    const disposedIds = new Set(disposeCalls.map(c => c.id));
    expect(disposedIds).toEqual(new Set([F1.id, F2.id, F3.id, F4.id, F7.id]));
    const actionableIds = new Set(
      all.filter(r => classifyInboxMessage(r).class === 'ACTIONABLE').map(r => r.id)
    );
    for (const id of disposedIds) {
      expect(actionableIds.has(id)).toBe(false);
    }
  });

  test('T13 alerts are written once per repeat window, including reader gap', async () => {
    const mem = makeMemFs();
    mem.files.set(
      join(ROOT, 'state.json'),
      JSON.stringify({
        last_run_at: isoAgoHours(3),
        content_hash: null,
        last_run_file: null,
        alerts: {},
      })
    );

    let clockIso = NOW;
    const { deps } = makeDeps({
      rows: { xo: [buildRow(F8, { created_at: isoAgoHours(30) })] },
      fs: mem.fs,
      clock: (): Date => new Date(clockIso),
    });

    await runInboxReader(deps, makeConfig());
    const afterRun1 = alertLines(mem.files);
    expect(
      afterRun1.filter(a => a.kind === 'actionable_stale' && a.recipient === 'xo')
    ).toHaveLength(1);
    expect(afterRun1.filter(a => a.kind === 'reader_gap')).toHaveLength(1);

    clockIso = new Date(NOW_MS + 10 * 60_000).toISOString();
    await runInboxReader(deps, makeConfig());
    const afterRun2 = alertLines(mem.files);
    expect(afterRun2).toHaveLength(afterRun1.length);
  });

  test('T14 config resolver clamps and floors', () => {
    expect(
      resolveInboxReaderConfig({ INBOX_READER_MAX_PER_RUN: '0' } as NodeJS.ProcessEnv).maxPerRun
    ).toBe(1);
    expect(
      resolveInboxReaderConfig({ INBOX_READER_MAX_PER_RUN: '9999' } as NodeJS.ProcessEnv).maxPerRun
    ).toBe(500);
    expect(
      resolveInboxReaderConfig({ INBOX_READER_MIN_AGE_MS: '60000' } as NodeJS.ProcessEnv).minAgeMs
    ).toBe(600_000);
    expect(
      resolveInboxReaderConfig({ INBOX_READER_INTERVAL_MS: 'abc' } as NodeJS.ProcessEnv).intervalMs
    ).toBe(300_000);
    expect(resolveInboxReaderConfig({} as NodeJS.ProcessEnv).recipients).toEqual(['xo']);
    expect(
      resolveInboxReaderConfig({ INBOX_READER_OPERATOR_OWNER: 'reader' } as NodeJS.ProcessEnv)
        .recipients
    ).toEqual(['xo', 'operator']);
  });

  test('T15 operator consumer start is gated on the owner flag', () => {
    expect(shouldStartOperatorInboxConsumer({} as NodeJS.ProcessEnv)).toBe(true);
    expect(
      shouldStartOperatorInboxConsumer({
        INBOX_READER_OPERATOR_OWNER: 'reader',
      } as NodeJS.ProcessEnv)
    ).toBe(false);
    expect(
      shouldStartOperatorInboxConsumer({
        INBOX_READER_OPERATOR_OWNER: 'READER',
      } as NodeJS.ProcessEnv)
    ).toBe(true);
  });

  test('T16 heartbeat every run, even when listing fails', async () => {
    let called = false;
    const heartbeatCalls: { worker_id: string }[] = [];
    const disposeCalls: unknown[] = [];
    const mem = makeMemFs();
    const deps: InboxReaderDeps = {
      listMessages: async (): Promise<ReturnType<typeof buildRow>[]> => {
        called = true;
        throw new Error('list_boom');
      },
      disposeMessageByMachine: async (data): Promise<{ ok: true }> => {
        disposeCalls.push(data);
        return { ok: true };
      },
      heartbeatWorker: async (data): Promise<unknown> => {
        heartbeatCalls.push(data);
        return null;
      },
      now: (): Date => new Date(NOW),
      rootDir: ROOT,
      fs: mem.fs,
    };

    const result = await runInboxReader(deps, makeConfig({ mode: 'enforce' }));
    expect(called).toBe(true);
    expect(heartbeatCalls).toEqual([{ worker_id: 'inbox-reader' }]);
    expect(result.listErrors.length).toBeGreaterThanOrEqual(1);
    expect(disposeCalls).toHaveLength(0);

    expect(readWorkerHeartbeatAlarmConfig().workers).toContain('inbox-reader');
  });

  test('T17 surface.jsonl report classifies legacy lines read-only', () => {
    const lines = readFileSync(
      join(import.meta.dir, 'inbox-reader.surface-fixture.jsonl'),
      'utf8'
    ).split('\n');
    const report = buildReportFromSurfaceLines(lines);
    expect(report.counts.INFO_DUPLICATE).toBe(2);
    expect(report.counts.ACTIONABLE).toBe(2);
    expect(report.parse_errors).toBe(1);
  });

  test('T19 reader records the ack race as skipped_race and keeps going', async () => {
    const rows = [
      buildRow(F1, { created_at: isoAgoHours(2) }),
      buildRow(F3, { created_at: isoAgoHours(2) }),
    ];
    const { deps, disposeCalls } = makeDeps({
      rows: { xo: rows },
      disposeImpl: async (data): Promise<{ ok: true } | { ok: false; reason: string }> =>
        data.id === F1.id ? { ok: false, reason: 'receipt_present' } : { ok: true },
    });
    const result = await runInboxReader(deps, makeConfig({ mode: 'enforce' }));

    for (const call of disposeCalls) {
      expect(call.requireNoReceipt).toBe(true);
    }
    const results = result.digest?.disposal_results ?? [];
    expect(results.find(r => r.id === F1.id)).toMatchObject({
      ok: false,
      reason: 'receipt_present',
    });
    expect(results.find(r => r.id === F3.id)).toMatchObject({ ok: true });
    expect(result.skippedRace).toBe(1);
    expect(result.disposalErrors).toHaveLength(0);
  });

  test('T20 a full page that cannot advance raises page_not_advancing in dry-run and enforce', async () => {
    const buildPage = (): ReturnType<typeof buildRow>[] => [
      buildRow(F1, { created_at: isoAgoHours(2) }),
      buildRow(F3, { created_at: isoAgoHours(2) }),
      buildRow(F7, { created_at: isoAgoHours(2) }),
      buildRow(F8, { created_at: isoAgoHours(2) }),
      buildRow(F10, { created_at: isoAgoHours(2) }),
    ];

    // (a) dry-run.
    {
      const { deps } = makeDeps({ rows: { xo: buildPage() } });
      const result = await runInboxReader(deps, makeConfig({ mode: 'dry-run', maxPerRun: 5 }));
      const alerts = (result.digest?.alerts ?? []).filter(
        a => a.kind === 'page_not_advancing' && a.recipient === 'xo'
      );
      expect(alerts).toHaveLength(1);
      expect(alerts[0].detail).toContain('dry-run');
    }

    // (b) enforce, dispose returns receipt_present for all three.
    {
      const { deps, disposeCalls } = makeDeps({
        rows: { xo: buildPage() },
        disposeImpl: async (): Promise<{ ok: false; reason: string }> => ({
          ok: false,
          reason: 'receipt_present',
        }),
      });
      const result = await runInboxReader(deps, makeConfig({ mode: 'enforce', maxPerRun: 5 }));
      const alerts = (result.digest?.alerts ?? []).filter(
        a => a.kind === 'page_not_advancing' && a.recipient === 'xo'
      );
      expect(alerts).toHaveLength(1);
      expect(alerts[0].detail).toContain('enforce');
      expect(disposeCalls.find(c => c.id === F8.id || c.id === F10.id)).toBeUndefined();
    }

    // (c) enforce, dispose ok for all three => page shrinks => no alert.
    {
      const { deps, disposeCalls } = makeDeps({
        rows: { xo: buildPage() },
        disposeImpl: async (): Promise<{ ok: true }> => ({ ok: true }),
      });
      const result = await runInboxReader(deps, makeConfig({ mode: 'enforce', maxPerRun: 5 }));
      const alerts = (result.digest?.alerts ?? []).filter(a => a.kind === 'page_not_advancing');
      expect(alerts).toHaveLength(0);
      expect(disposeCalls.find(c => c.id === F8.id || c.id === F10.id)).toBeUndefined();
    }
  });
});
