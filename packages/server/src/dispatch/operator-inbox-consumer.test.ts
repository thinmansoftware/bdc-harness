/**
 * Operator inbox consumer tests -- WO-HARNESS-OPERATOR-INBOX-CONSUMER-01 / bdc-xo#1455,
 * receipt-honesty correction WO-HARNESS-DISPATCH-HONEST-RECEIPTS-01 / M-187a.
 *
 * Section 11 (M-187a) scenarios:
 *   1. one needs_human row, TWO drain ticks -> exactly ONE surface entry, row is
 *      'auto_surfaced', all four receipt columns null.
 *   2. one code_actionable row, one tick -> same shape as needs_human.
 *   3. one digest_only row, one tick -> 'expired', all four receipt columns null.
 *   4. rollback: under the receipt freeze, legacy ack+address writes nothing and
 *      fails loudly (result.failed == row count, acknowledged_at null on every row).
 *
 * All deps injected; no mock.module; no real network / real DB.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  classifyOperatorMessage,
  drainOperatorInbox,
  resolveOperatorInboxIntervalMs,
  startOperatorInboxConsumer,
  stopOperatorInboxConsumer,
  getOperatorInboxRuntime,
  type OperatorInboxDeps,
  type OperatorInboxMessage,
  type SurfaceEntry,
} from './operator-inbox-consumer';

const T0 = '2026-07-31T13:24:05.000Z';

function makeMessage(overrides: Partial<OperatorInboxMessage> = {}): OperatorInboxMessage {
  const id = overrides.id ?? `msg-${Math.random().toString(36).slice(2, 10)}`;
  return {
    id,
    task_type: 'run_report',
    sender: 'overseer',
    recipient: 'operator',
    body: JSON.stringify({
      kind: 'overseer_run_report',
      blocker: 'completely novel failure mode never seen before XYZ-999',
      woId: 'WO-UNKNOWN-NOVEL-01',
      runId: 'run-1',
    }),
    status: 'queued',
    created_at: T0,
    acknowledged_at: null,
    acknowledged_by: null,
    addressed_at: null,
    addressed_by: null,
    route_disposition: null,
    ...overrides,
  };
}

interface FakeWorld {
  messages: OperatorInboxMessage[];
  surfaces: SurfaceEntry[];
  disposeCalls: { id: string; actor: string; disposition: string }[];
}

function makeWorld(seed: OperatorInboxMessage[] = []): FakeWorld {
  return {
    messages: seed.map(m => ({ ...m })),
    surfaces: [],
    disposeCalls: [],
  };
}

function makeDeps(world: FakeWorld, overrides: Partial<OperatorInboxDeps> = {}): OperatorInboxDeps {
  return {
    listMessages: async filters => {
      return world.messages.filter(m => {
        if (filters.recipient && m.recipient !== filters.recipient) return false;
        if (filters.status === 'queued') {
          if (m.status !== 'queued') return false;
          if (m.addressed_at !== null) return false;
          // Disposed rows leave the queued drain list (item 3, M-187a).
          if (m.route_disposition !== null) return false;
        }
        return true;
      });
    },
    disposeMessageByMachine: async data => {
      world.disposeCalls.push({ id: data.id, actor: data.actor, disposition: data.disposition });
      const msg = world.messages.find(m => m.id === data.id);
      if (!msg) return { ok: false as const, reason: 'not_found' as const };
      if (msg.route_disposition !== null) {
        return { ok: false as const, reason: 'already_disposed' as const };
      }
      msg.route_disposition = data.disposition;
      return { ok: true as const, message: msg };
    },
    surface: async entry => {
      world.surfaces.push(entry);
    },
    ...overrides,
  };
}

function assertNoReceipt(message: OperatorInboxMessage): void {
  expect(message.acknowledged_at).toBeNull();
  expect(message.acknowledged_by).toBeNull();
  expect(message.addressed_at).toBeNull();
  expect(message.addressed_by).toBeNull();
}

describe('operator inbox consumer (M-187a honest receipts)', () => {
  afterEach(() => {
    stopOperatorInboxConsumer();
  });

  test('needs_human: two drain ticks surface exactly once and auto_surface with no receipt', async () => {
    const world = makeWorld([makeMessage({ id: 'nh-1' })]);
    const deps = makeDeps(world);

    const first = await drainOperatorInbox(deps);
    expect(first.found).toBe(1);
    expect(first.processed).toBe(1);
    expect(first.needsHuman).toBe(1);

    // Second tick: the disposed row leaves the queued list, so nothing to do.
    const second = await drainOperatorInbox(deps);
    expect(second.found).toBe(0);
    expect(second.processed).toBe(0);

    expect(world.surfaces.filter(s => s.messageId === 'nh-1')).toHaveLength(1);
    expect(world.messages[0]!.route_disposition).toBe('auto_surfaced');
    expect(world.disposeCalls).toEqual([
      { id: 'nh-1', actor: 'system:operator-inbox-consumer', disposition: 'auto_surfaced' },
    ]);
    assertNoReceipt(world.messages[0]!);
  });

  test('code_actionable: one tick surfaces and auto_surfaces with no receipt', async () => {
    const world = makeWorld([
      makeMessage({
        id: 'ca-1',
        body: JSON.stringify({
          kind: 'overseer_run_report',
          blocker: 'judge_daily_budget_exceeded after 3 retries',
          woId: 'WO-HARNESS-JUDGE-BUDGET-01',
        }),
      }),
    ]);
    await drainOperatorInbox(makeDeps(world));

    expect(world.surfaces).toHaveLength(1);
    expect(world.surfaces[0]!.classification).toBe('code_actionable');
    expect(world.messages[0]!.route_disposition).toBe('auto_surfaced');
    expect(world.disposeCalls[0]!.disposition).toBe('auto_surfaced');
    assertNoReceipt(world.messages[0]!);
  });

  test('digest_only: one tick expires with no surface and no receipt', async () => {
    const world = makeWorld([
      makeMessage({
        id: 'dg-1',
        task_type: 'agent_message',
        sender: 'taskmaster',
        body:
          'Taskmaster daily digest for 2026-08-07: no actions in the last 24h. ' +
          'Pause/resume/status runbook: xo-wiki/wiki/tools/taskmaster/_index.md.',
      }),
    ]);
    await drainOperatorInbox(makeDeps(world));

    expect(world.surfaces).toHaveLength(0);
    expect(world.messages[0]!.route_disposition).toBe('expired');
    expect(world.disposeCalls).toEqual([
      { id: 'dg-1', actor: 'system:operator-inbox-consumer', disposition: 'expired' },
    ]);
    assertNoReceipt(world.messages[0]!);
  });

  test('rollback: under the receipt freeze, legacy ack+address writes nothing and fails loudly', async () => {
    const world = makeWorld([makeMessage({ id: 'f-1' }), makeMessage({ id: 'f-2' })]);
    // Simulate a rolled-back LEGACY image whose ack+address receipt UPDATE hits
    // scripts/dispatch/receipt-freeze.sql and aborts. The disposition dep is the
    // injection point; the legacy write raises dispatch_receipts_frozen and no
    // receipt is ever written.
    const deps = makeDeps(world, {
      disposeMessageByMachine: async () => {
        throw new Error('dispatch_receipts_frozen');
      },
    });

    const result = await drainOperatorInbox(deps);
    expect(result.failed).toBe(2);
    expect(result.errors.every(e => e.includes('dispatch_receipts_frozen'))).toBe(true);
    expect(world.messages.every(m => m.acknowledged_at === null)).toBe(true);
    expect(world.messages.every(m => m.addressed_at === null)).toBe(true);
    // No row was disposed either -- honest code is absent.
    expect(world.messages.every(m => m.route_disposition === null)).toBe(true);
  });

  test('idempotent re-run: an already-disposed row is not reprocessed', async () => {
    const disposed = makeMessage({ id: 'done-1', route_disposition: 'auto_surfaced' });
    const pending = makeMessage({ id: 'pending-1' });
    const world = makeWorld([disposed, pending]);
    const deps = makeDeps(world);

    const first = await drainOperatorInbox(deps);
    expect(first.found).toBe(1);
    expect(first.processed).toBe(1);
    expect(world.disposeCalls.map(c => c.id)).toEqual(['pending-1']);

    const second = await drainOperatorInbox(deps);
    expect(second.found).toBe(0);
    expect(world.disposeCalls.map(c => c.id)).toEqual(['pending-1']);
  });

  test('drain failure is loud: mid-drain throw is reported, not swallowed', async () => {
    const world = makeWorld([makeMessage({ id: 'boom-1' }), makeMessage({ id: 'ok-2' })]);
    const baseline = makeDeps(world);
    const deps = makeDeps(world, {
      disposeMessageByMachine: async data => {
        if (data.id === 'boom-1') throw new Error('simulated_mid_drain_failure');
        return baseline.disposeMessageByMachine!(data);
      },
    });

    const result = await drainOperatorInbox(deps);
    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect(result.errors.some(e => e.includes('simulated_mid_drain_failure'))).toBe(true);
    // Other messages still process -- one failure must not permanently stop drain.
    expect(world.messages.find(m => m.id === 'ok-2')!.route_disposition).toBe('auto_surfaced');
  });

  test('classifier: known budget/PR patterns are code_actionable; novel is needs_human; digest is digest_only', () => {
    expect(
      classifyOperatorMessage(
        makeMessage({
          body: JSON.stringify({
            blocker: 'judge_daily_budget_exceeded after retries',
            woId: 'WO-X',
          }),
        })
      ).kind
    ).toBe('code_actionable');

    expect(
      classifyOperatorMessage(
        makeMessage({
          body: JSON.stringify({
            blocker: 'PR lookup failed / pull request creation error',
            woId: 'WO-Y',
          }),
        })
      ).kind
    ).toBe('code_actionable');

    expect(
      classifyOperatorMessage(
        makeMessage({
          body: JSON.stringify({ blocker: 'totally unknown zebra failure' }),
        })
      ).kind
    ).toBe('needs_human');

    expect(
      classifyOperatorMessage(
        makeMessage({
          task_type: 'agent_message',
          sender: 'taskmaster',
          body: 'Taskmaster daily digest for 2026-08-07: no actions in the last 24h.',
        })
      ).kind
    ).toBe('digest_only');
  });

  test('resolveOperatorInboxIntervalMs: default 60000, 0 disables, invalid falls back', () => {
    expect(resolveOperatorInboxIntervalMs(undefined)).toBe(60_000);
    expect(resolveOperatorInboxIntervalMs('0')).toBe(0);
    expect(resolveOperatorInboxIntervalMs('15000')).toBe(15_000);
    expect(resolveOperatorInboxIntervalMs('nope')).toBe(60_000);
  });

  test('startOperatorInboxConsumer is a singleton and respects interval=0', () => {
    process.env.OPERATOR_INBOX_INTERVAL_MS = '0';
    startOperatorInboxConsumer(makeDeps(makeWorld()));
    expect(getOperatorInboxRuntime()).toBeUndefined();
    delete process.env.OPERATOR_INBOX_INTERVAL_MS;

    process.env.OPERATOR_INBOX_INTERVAL_MS = '60000';
    startOperatorInboxConsumer(makeDeps(makeWorld()));
    const first = getOperatorInboxRuntime();
    startOperatorInboxConsumer(makeDeps(makeWorld()));
    expect(getOperatorInboxRuntime()).toBe(first);
    stopOperatorInboxConsumer();
    delete process.env.OPERATOR_INBOX_INTERVAL_MS;
  });
});
