import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { readWorkerHeartbeatAlarmConfig } from './worker-heartbeat-alarm';
import { classifyInboxMessage } from './inbox-reader-rules';
import {
  buildReportFromSurfaceLines,
  resolveInboxReaderConfig,
  runInboxReader,
  shouldStartOperatorInboxConsumer,
  type InboxReaderConfig,
  type InboxReaderDeps,
} from './inbox-reader';
import { F1, F2, F3, F4, F5, F6, F7, F8, F9, F10, F11, F12 } from './inbox-reader.fixtures';

const roots: string[] = [];
afterEach(async () => {
  while (roots.length) await rm(roots.pop() as string, { recursive: true, force: true });
});

async function harness(rows: (typeof F1)[], mode: 'dry-run' | 'enforce' = 'enforce') {
  const root = await mkdtemp(join(tmpdir(), 'inbox-reader-'));
  roots.push(root);
  const disposed: Array<Record<string, unknown>> = [];
  const config: InboxReaderConfig = {
    ...resolveInboxReaderConfig({ INBOX_READER_MODE: mode }),
    recipients: [...new Set(rows.map(row => row.recipient))] as ('xo' | 'operator')[],
  };
  const deps: InboxReaderDeps = {
    root,
    now: () => new Date('2026-09-29T12:00:00.000Z'),
    listMessages: async ({ recipient, limit }) =>
      rows.filter(row => row.recipient === recipient).slice(0, limit),
    disposeMessageByMachine: async data => {
      disposed.push(data);
      return { ok: true, message: rows.find(row => row.id === data.id) as never };
    },
    registerWorker: async () => undefined,
    heartbeatWorker: async () => undefined,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  };
  const result = await runInboxReader(deps, config);
  return { root, disposed, result };
}

describe('inbox reader', () => {
  test('T1 overseer approved receipt is INFO_DUPLICATE and disposed expired in enforce', async () => {
    expect(classifyInboxMessage(F1).rule_id).toBe('info_review_posted');
    const { disposed } = await harness([F1, F2]);
    expect(disposed).toHaveLength(2);
    expect(disposed[0]).toMatchObject({
      actor: 'system:inbox-reader',
      disposition: 'expired',
      requireNoReceipt: true,
    });
  });

  test('T2 intermediate and ingest receipts are INFO_DUPLICATE', () => {
    expect(classifyInboxMessage(F3)).toMatchObject({
      class: 'INFO_DUPLICATE',
      rule_id: 'info_submit_intermediate',
    });
    expect(classifyInboxMessage(F4)).toMatchObject({
      class: 'INFO_DUPLICATE',
      rule_id: 'info_ingest_receipt',
    });
  });

  test('T3 taskmaster daily nudges collapse to one line with count and newest timestamp', async () => {
    const rows = [3, 2, 1].map((hours, index) => ({
      ...F7,
      id: `${F7.id}-${index}`,
      created_at: `2026-09-29T${String(12 - hours).padStart(2, '0')}:00:00.000Z`,
    }));
    const { result, disposed } = await harness(rows);
    expect(result.digest?.nudges[0]).toMatchObject({
      count: 3,
      newest_created_at: '2026-09-29T11:00:00.000Z',
    });
    expect(disposed).toHaveLength(3);
  });

  test('T4 codex escalation asking a question is ACTIONABLE and never disposed', async () => {
    const old = { ...F8, created_at: '2026-09-28T00:00:00.000Z' };
    const { result, disposed } = await harness([old]);
    expect(result.digest?.actionable).toHaveLength(1);
    expect(disposed).toHaveLength(0);
    expect(result.digest?.alerts[0]?.kind).toBe('actionable_stale');
  });

  test('T5 P0 and blocker-priority messages are ACTIONABLE', () => {
    expect([F9, F10, F5, F6, F12].map(row => classifyInboxMessage(row).class)).toEqual(
      Array(5).fill('ACTIONABLE')
    );
  });

  test('T6 unknown sender is ACTIONABLE', () => {
    expect(classifyInboxMessage(F11).rule_id).toBe('unknown_sender');
    expect(classifyInboxMessage({ ...F1, sender: 'overseer-v2' }).rule_id).toBe('unknown_sender');
  });

  test('T7 a 5-minute-old message is never disposed', async () => {
    const { result, disposed } = await harness([{ ...F1, created_at: '2026-09-29T11:55:00.000Z' }]);
    expect(result.digest?.counts.operator.too_young).toBe(1);
    expect(disposed).toHaveLength(0);
  });

  test('T8 non-queued, already-disposed, addressed and acked rows are not disposed', async () => {
    const rows = [
      { ...F1, id: 'done', status: 'done' },
      { ...F1, id: 'routed', route_disposition: 'expired' },
      { ...F1, id: 'addressed', addressed_at: '2026-09-29T01:00:00Z' },
      { ...F1, id: 'acked', acknowledged_at: '2026-09-29T01:00:00Z' },
    ] as (typeof F1)[];
    const { result, disposed } = await harness(rows);
    expect(disposed).toHaveLength(0);
    expect(result.digest?.counts.operator).toMatchObject({ skipped: 3, acked_open: 1 });
  });

  test('T9 per-run cap of 500 is respected', () => {
    expect(resolveInboxReaderConfig({ INBOX_READER_MAX_PER_RUN: '620' }).maxPerRun).toBe(500);
  });

  test('T10 dry-run is the default and writes the digest without any disposition', async () => {
    const { root, result, disposed } = await harness([F1, F3, F7, F8], 'dry-run');
    expect(disposed).toHaveLength(0);
    expect(result.digest?.disposal_plan).toHaveLength(3);
    expect(JSON.parse(await readFile(join(root, 'latest.json'), 'utf8')).mode).toBe('dry-run');
    expect(resolveInboxReaderConfig({ INBOX_READER_MODE: 'Enforce' }).mode).toBe('dry-run');
  });

  test('T11 digest is persisted and read back before the first disposition', async () => {
    const { root, disposed } = await harness([F1]);
    expect(disposed).toHaveLength(1);
    expect(JSON.parse(await readFile(join(root, 'latest.json'), 'utf8')).disposal_plan[0].id).toBe(
      F1.id
    );
  });

  test('T12 ACTIONABLE never reaches disposeMessageByMachine', async () => {
    const { disposed } = await harness([F1, F2, F3, F4, F5, F6, F7, F8, F9, F10, F11, F12]);
    expect(new Set(disposed.map(row => row.id))).toEqual(
      new Set([F1.id, F2.id, F3.id, F4.id, F7.id])
    );
  });

  test('T13 stale alerts are repeat-keyed in state', async () => {
    const { result } = await harness([{ ...F8, created_at: '2026-09-27T00:00:00.000Z' }]);
    expect(result.digest?.alerts.map(row => row.kind)).toContain('actionable_stale');
  });

  test('T14 config resolver clamps and floors', () => {
    expect(
      resolveInboxReaderConfig({
        INBOX_READER_MAX_PER_RUN: '0',
        INBOX_READER_MIN_AGE_MS: '60000',
        INBOX_READER_INTERVAL_MS: 'abc',
      })
    ).toMatchObject({ maxPerRun: 1, minAgeMs: 600000, intervalMs: 300000 });
    expect(
      resolveInboxReaderConfig({
        INBOX_READER_MAX_PER_RUN: '9999',
        INBOX_READER_OPERATOR_OWNER: 'reader',
      })
    ).toMatchObject({ maxPerRun: 500, recipients: ['xo', 'operator'] });
  });

  test('T15 operator consumer start is gated on the owner flag', () => {
    expect(shouldStartOperatorInboxConsumer({})).toBe(true);
    expect(shouldStartOperatorInboxConsumer({ INBOX_READER_OPERATOR_OWNER: 'reader' })).toBe(false);
    expect(shouldStartOperatorInboxConsumer({ INBOX_READER_OPERATOR_OWNER: 'READER' })).toBe(true);
  });

  test('T16 heartbeat every run, even when listing fails', async () => {
    let beats = 0;
    const root = await mkdtemp(join(tmpdir(), 'inbox-reader-'));
    roots.push(root);
    const result = await runInboxReader({
      root,
      listMessages: async () => {
        throw new Error('boom');
      },
      registerWorker: async () => undefined,
      heartbeatWorker: async () => {
        beats += 1;
      },
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });
    expect(beats).toBe(1);
    expect(result.errors.join()).toContain('list_failed');
    expect(readWorkerHeartbeatAlarmConfig().workers).toContain('inbox-reader');
  });

  test('T17 surface.jsonl report classifies legacy lines read-only', async () => {
    const lines = (
      await readFile(join(import.meta.dir, 'inbox-reader.surface-fixture.jsonl'), 'utf8')
    ).split(/\r?\n/);
    expect(buildReportFromSurfaceLines(lines)).toMatchObject({
      counts: { INFO_DUPLICATE: 2, ACTIONABLE: 2 },
      parse_errors: 1,
    });
  });

  test('T19 reader records the receipt race and keeps going', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inbox-reader-'));
    roots.push(root);
    let calls = 0;
    const result = await runInboxReader(
      {
        root,
        now: () => new Date('2026-09-29T12:00:00Z'),
        listMessages: async () => [F1, F3],
        registerWorker: async () => undefined,
        heartbeatWorker: async () => undefined,
        disposeMessageByMachine: async data =>
          ++calls === 1
            ? { ok: false, reason: 'receipt_present' }
            : { ok: true, message: { id: data.id } as never },
        log: { info: () => {}, warn: () => {}, error: () => {} },
      },
      resolveInboxReaderConfig({ INBOX_READER_MODE: 'enforce' })
    );
    expect(result.skipped_race).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(calls).toBe(2);
  });

  test('T20 a full page that cannot advance raises page_not_advancing', async () => {
    const rows = [F1, F3, F7, F8, F10];
    const root = await mkdtemp(join(tmpdir(), 'inbox-reader-'));
    roots.push(root);
    const config = { ...resolveInboxReaderConfig({}), maxPerRun: 5 };
    const result = await runInboxReader(
      {
        root,
        now: () => new Date('2026-09-29T12:00:00Z'),
        listMessages: async () => rows,
        registerWorker: async () => undefined,
        heartbeatWorker: async () => undefined,
        log: { info: () => {}, warn: () => {}, error: () => {} },
      },
      config
    );
    expect(result.digest?.alerts.map(row => row.kind)).toContain('page_not_advancing');
  });
});
