import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
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

  test('T6b overseer run_report with a null, scalar, array or non-JSON body is ACTIONABLE', () => {
    for (const body of ['null', '42', '"text"', '[]', '[{"kind":"x"}]', 'not json', '']) {
      const verdict = classifyInboxMessage({ ...F1, body });
      expect(verdict.class).toBe('ACTIONABLE');
      expect(verdict.rule_id).toBe('body_not_json');
    }
    expect(classifyInboxMessage({ ...F2, body: 'null' }).class).toBe('ACTIONABLE');
  });

  test('T6c a null-body overseer report does not abort the run and is never disposed', async () => {
    const nullBody = { ...F1, id: 'null-body-row', body: 'null' };
    const { result, disposed } = await harness([nullBody, F3]);
    expect(result.errors).toEqual([]);
    expect(disposed.map(item => item.id)).toEqual([F3.id]);
    expect(result.digest?.actionable.map(item => item.id)).toContain('null-body-row');
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

  test('T9 620 rows are capped, resumable, and idempotent across three runs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inbox-reader-'));
    roots.push(root);
    const queued = Array.from({ length: 620 }, (_, index) => ({
      ...F1,
      id: `bulk-${index}`,
    }));
    const disposed: string[] = [];
    const deps: InboxReaderDeps = {
      root,
      now: () => new Date('2026-09-29T12:00:00Z'),
      listMessages: async ({ limit }) => queued.slice(0, limit),
      disposeMessageByMachine: async ({ id }) => {
        disposed.push(id);
        queued.splice(
          queued.findIndex(row => row.id === id),
          1
        );
        return { ok: true, message: { id } as never };
      },
      registerWorker: async () => undefined,
      heartbeatWorker: async () => undefined,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    };
    const config = resolveInboxReaderConfig({
      INBOX_READER_MODE: 'enforce',
      INBOX_READER_MAX_PER_RUN: '620',
    });

    const first = await runInboxReader(deps, config);
    const second = await runInboxReader(deps, config);
    const third = await runInboxReader(deps, config);

    expect(first.digest?.disposal_results).toHaveLength(500);
    expect(second.digest?.disposal_results).toHaveLength(120);
    expect(third.digest?.disposal_results).toHaveLength(0);
    expect(disposed).toHaveLength(620);
    expect(new Set(disposed).size).toBe(620);
  });

  test('T10 dry-run is the default and writes the digest without any disposition', async () => {
    const { root, result, disposed } = await harness([F1, F3, F7, F8], 'dry-run');
    expect(disposed).toHaveLength(0);
    expect(result.digest?.disposal_plan).toHaveLength(3);
    expect(JSON.parse(await Bun.file(join(root, 'latest.json')).text()).mode).toBe('dry-run');
    expect(resolveInboxReaderConfig({ INBOX_READER_MODE: 'Enforce' }).mode).toBe('dry-run');
  });

  test('T11 read-back precedes disposal and persistence failures cause zero disposition', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inbox-reader-'));
    roots.push(root);
    const events: string[] = [];
    let currentTime = '2026-09-29T12:00:00Z';
    const config = resolveInboxReaderConfig({ INBOX_READER_MODE: 'enforce' });
    const base: InboxReaderDeps = {
      root,
      now: () => new Date(currentTime),
      listMessages: async () => [F1],
      registerWorker: async () => undefined,
      heartbeatWorker: async () => undefined,
      atomicWrite: async (path, contents) => {
        events.push(`write:${path}`);
        await writeFile(path, contents);
      },
      readText: async path => {
        events.push(`read:${path}`);
        return Bun.file(path).text();
      },
      disposeMessageByMachine: async data => {
        events.push(`dispose:${data.id}`);
        return { ok: true, message: F1 as never };
      },
      log: { info: () => {}, warn: () => {}, error: () => {} },
    };
    await runInboxReader(base, config);
    expect(
      events.findIndex(event => event.includes('read:') && event.endsWith('latest.json'))
    ).toBeLessThan(events.findIndex(event => event.startsWith('dispose:')));

    events.length = 0;
    currentTime = '2026-09-29T13:00:00Z';
    await runInboxReader(
      {
        ...base,
        readText: async path => {
          if (path.endsWith('latest.json')) throw new Error('injected read-back failure');
          return Bun.file(path).text();
        },
      },
      config
    );
    expect(events.filter(event => event.startsWith('dispose:'))).toHaveLength(0);
    expect(await Bun.file(join(root, 'state.json')).text()).toContain('2026-09-29T13:00:00.000Z');

    events.length = 0;
    currentTime = '2026-09-29T14:00:00Z';
    const writeFailure = await runInboxReader(
      {
        ...base,
        atomicWrite: async (path, contents) => {
          if (path.endsWith('latest.json')) throw new Error('injected write failure');
          await writeFile(path, contents);
        },
      },
      config
    );
    expect(events.filter(event => event.startsWith('dispose:'))).toHaveLength(0);
    expect(writeFailure.errors.join()).toContain('digest_write_failed');
    expect(await Bun.file(join(root, 'state.json')).text()).toContain('2026-09-29T14:00:00.000Z');
  });

  test('T12 ACTIONABLE never reaches disposeMessageByMachine', async () => {
    const { disposed } = await harness([F1, F2, F3, F4, F5, F6, F7, F8, F9, F10, F11, F12]);
    expect(new Set(disposed.map(row => row.id))).toEqual(
      new Set([F1.id, F2.id, F3.id, F4.id, F7.id])
    );
  });

  test('T13 reader-gap alerts are detected and repeat-suppressed across runs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inbox-reader-'));
    roots.push(root);
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, 'state.json'),
      JSON.stringify({ last_run_at: '2026-09-29T00:00:00.000Z' })
    );
    const deps: InboxReaderDeps = {
      root,
      now: () => new Date('2026-09-29T12:00:00Z'),
      listMessages: async () => [],
      registerWorker: async () => undefined,
      heartbeatWorker: async () => undefined,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    };
    const first = await runInboxReader(deps, resolveInboxReaderConfig({}));
    const second = await runInboxReader(deps, resolveInboxReaderConfig({}));
    expect(first.digest?.alerts.map(row => row.kind)).toContain('reader_gap');
    expect(second.digest?.alerts.map(row => row.kind)).not.toContain('reader_gap');
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
      await Bun.file(join(import.meta.dir, 'inbox-reader.surface-fixture.jsonl')).text()
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

  test('T20 full-page alerting covers dry-run, all-race enforce, and successful progress', async () => {
    const rows = [F1, F3, F7, F8, F10].map(row => ({ ...row, recipient: 'xo' as const }));
    const root = await mkdtemp(join(tmpdir(), 'inbox-reader-'));
    roots.push(root);
    const run = (mode: 'dry-run' | 'enforce', outcome: 'race' | 'success') =>
      runInboxReader(
        {
          root,
          now: () => new Date('2026-09-29T12:00:00Z'),
          listMessages: async () => rows,
          registerWorker: async () => undefined,
          heartbeatWorker: async () => undefined,
          disposeMessageByMachine: async data =>
            outcome === 'race'
              ? { ok: false, reason: 'receipt_present' }
              : { ok: true, message: { id: data.id } as never },
          log: { info: () => {}, warn: () => {}, error: () => {} },
        },
        {
          ...resolveInboxReaderConfig({ INBOX_READER_MODE: mode }),
          maxPerRun: 5,
          alertRepeatHours: 0,
        }
      );
    const dryRun = await run('dry-run', 'success');
    const allRace = await run('enforce', 'race');
    const progress = await run('enforce', 'success');
    expect(dryRun.digest?.alerts.map(row => row.kind)).toContain('page_not_advancing');
    expect(allRace.digest?.alerts.map(row => row.kind)).toContain('page_not_advancing');
    expect(progress.digest?.alerts.map(row => row.kind)).not.toContain('page_not_advancing');
  });

  test('T21 a full page of retained ACTIONABLE xo mail neither starves operator nor hides later rows', async () => {
    type Row = typeof F1 & { cursor_seq: number };
    const store: Row[] = [];
    let seq = 0;
    for (let index = 0; index < 600; index += 1) {
      seq += 1;
      store.push({
        ...F1,
        id: `xo-actionable-${index}`,
        sender: 'codex',
        task_type: 'agent_message',
        recipient: 'xo',
        body: `escalation ${index}`,
        cursor_seq: seq,
      } as Row);
    }
    for (const [index, row] of [F1, F3, F4].entries()) {
      seq += 1;
      store.push({ ...row, id: `operator-info-${index}`, cursor_seq: seq } as Row);
    }
    const root = await mkdtemp(join(tmpdir(), 'inbox-reader-'));
    roots.push(root);
    const disposed = new Set<string>();
    const seen = new Set<string>();
    const listCalls: { recipient: string; limit: number; afterSeq?: number }[] = [];
    const run = (mode: 'dry-run' | 'enforce') =>
      runInboxReader(
        {
          root,
          now: () => new Date('2026-09-29T12:00:00Z'),
          listMessages: async ({ recipient, limit, afterSeq }) => {
            listCalls.push({ recipient, limit, afterSeq });
            const rows = store
              .filter(row => row.recipient === recipient && !disposed.has(row.id))
              .filter(row => afterSeq === undefined || row.cursor_seq > afterSeq)
              .slice(0, limit);
            for (const row of rows) seen.add(row.id);
            return rows;
          },
          disposeMessageByMachine: async data => {
            disposed.add(data.id);
            return { ok: true, message: { id: data.id } as never };
          },
          registerWorker: async () => undefined,
          heartbeatWorker: async () => undefined,
          log: { info: () => {}, warn: () => {}, error: () => {} },
        },
        {
          ...resolveInboxReaderConfig({
            INBOX_READER_MODE: mode,
            INBOX_READER_OPERATOR_OWNER: 'reader',
          }),
          alertRepeatHours: 0,
        }
      );

    const first = await run('enforce');
    expect(first.errors).toEqual([]);
    // Fair share: operator is listed in the same run even though xo alone could fill 500.
    expect(first.digest?.counts.operator.listed).toBe(3);
    expect([...disposed].sort()).toEqual(['operator-info-0', 'operator-info-1', 'operator-info-2']);
    expect(first.digest?.counts.xo.listed).toBe(497);
    // The retained ACTIONABLE page does not stop the walk: run 2 resumes after it.
    const second = await run('enforce');
    expect(second.errors).toEqual([]);
    expect(listCalls.some(call => call.recipient === 'xo' && call.afterSeq !== undefined)).toBe(
      true
    );
    for (let index = 0; index < 600; index += 1)
      expect(seen.has(`xo-actionable-${index}`)).toBe(true);
    // No ACTIONABLE row is ever disposed.
    expect([...disposed].every(id => id.startsWith('operator-info-'))).toBe(true);

    // Dry-run walks the whole mailbox across runs too (nothing is ever disposed there).
    disposed.clear();
    seen.clear();
    await rm(join(root, 'state.json'), { force: true });
    await run('dry-run');
    await run('dry-run');
    expect(disposed.size).toBe(0);
    for (let index = 0; index < 600; index += 1)
      expect(seen.has(`xo-actionable-${index}`)).toBe(true);
    expect(seen.has('operator-info-0')).toBe(true);
  });

  test('T22 a budget of 1 rotates across mailboxes so operator is never starved', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inbox-reader-'));
    roots.push(root);
    const store = [
      {
        ...F1,
        id: 'xo-retained',
        sender: 'codex',
        task_type: 'agent_message',
        recipient: 'xo',
        body: 'escalation',
        cursor_seq: 1,
      },
      { ...F1, id: 'operator-one', recipient: 'operator', cursor_seq: 2 },
    ] as (typeof F1 & { cursor_seq: number })[];
    const listed: string[] = [];
    const run = () =>
      runInboxReader(
        {
          root,
          now: () => new Date('2026-09-29T12:00:00Z'),
          listMessages: async ({ recipient, limit, afterSeq }) => {
            const rows = store
              .filter(row => row.recipient === recipient)
              .filter(row => afterSeq === undefined || row.cursor_seq > afterSeq)
              .slice(0, limit);
            for (const row of rows) listed.push(row.id);
            return rows;
          },
          disposeMessageByMachine: async data => ({ ok: true, message: { id: data.id } as never }),
          registerWorker: async () => undefined,
          heartbeatWorker: async () => undefined,
          log: { info: () => {}, warn: () => {}, error: () => {} },
        },
        {
          ...resolveInboxReaderConfig({
            INBOX_READER_MODE: 'dry-run',
            INBOX_READER_MAX_PER_RUN: '1',
            INBOX_READER_OPERATOR_OWNER: 'reader',
          }),
          alertRepeatHours: 0,
        }
      );
    await run();
    await run();
    expect(listed).toContain('operator-one');
    expect(listed).toContain('xo-retained');
  });

  test('retention deletes only expired timestamped run files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inbox-reader-'));
    roots.push(root);
    await mkdir(join(root, 'runs'), { recursive: true });
    await writeFile(join(root, 'runs', '20260901T120000Z-old.json'), '{}');
    await writeFile(join(root, 'runs', '20260929T110000Z-new.json'), '{}');
    await runInboxReader(
      {
        root,
        now: () => new Date('2026-09-29T12:00:00Z'),
        listMessages: async () => [],
        registerWorker: async () => undefined,
        heartbeatWorker: async () => undefined,
        log: { info: () => {}, warn: () => {}, error: () => {} },
      },
      { ...resolveInboxReaderConfig({}), retentionDays: 14 }
    );
    const runFiles = await readdir(join(root, 'runs'));
    expect(runFiles).not.toContain('20260901T120000Z-old.json');
    expect(runFiles).toContain('20260929T110000Z-new.json');
  });
});
