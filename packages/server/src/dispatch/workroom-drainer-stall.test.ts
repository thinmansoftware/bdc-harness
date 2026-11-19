import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { SqliteAdapter } from '@archon/core/db/adapters/sqlite';
import * as connection from '@archon/core/db/connection';
import type { WorkroomDrainerStallDeps, WorkroomDrainerStallState } from './workroom-drainer-stall';

const MINUTE = 60_000;
const BOOT = Date.parse('2026-11-10T14:00:00Z');
const load = () => import('./workroom-drainer-stall');
const envKeys = [
  'NODE_ENV',
  'WORKROOM_DRAINER_STALL_ENABLED',
  'WORKROOM_DRAINER_STALL_MINUTES',
  'WORKROOM_DRAINER_STALL_REPEAT_HOURS',
  'WORKROOM_DRAINER_STALL_HOURS',
  'WORKROOM_DRAINER_STALL_TZ',
];
const savedEnv = new Map(envKeys.map(key => [key, process.env[key]]));
afterEach(async () => {
  (await load()).stopWorkroomDrainerStallTimer();
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function fixture(elapsedMinutes = 31) {
  for (const key of envKeys) if (key !== 'NODE_ENV') delete process.env[key];
  const state: WorkroomDrainerStallState = {
    startedAt: BOOT,
    polls: new Map(),
    sentKeys: new Set(),
  };
  let now = BOOT + elapsedMinutes * MINUTE;
  let oldest: { id: string; created_at: string } | null = null;
  const createAuthenticatedMessage = mock(async () => ({}));
  const readOldestUnackedMessage = mock(async () => oldest);
  const error = mock(() => undefined);
  const deps: WorkroomDrainerStallDeps = {
    state,
    now: () => new Date(now),
    readOldestUnackedMessage,
    createAuthenticatedMessage,
    log: { error },
  };
  return {
    state,
    deps,
    createAuthenticatedMessage,
    readOldestUnackedMessage,
    error,
    clock: (minutes: number) => {
      now = BOOT + minutes * MINUTE;
    },
    oldest: (value: typeof oldest) => {
      oldest = value;
    },
  };
}

describe('Workroom drainer stall', () => {
  test('T1: no poll for 31 minutes during working hours alerts XO once', async () => {
    const f = fixture();
    await (await load()).runWorkroomDrainerStallCheck(f.deps);
    expect(f.createAuthenticatedMessage).toHaveBeenCalledTimes(1);
    expect(f.createAuthenticatedMessage).toHaveBeenCalledWith(
      { kind: 'system', sender: 'dispatch' },
      expect.objectContaining({
        recipient: 'xo',
        task_type: 'agent_message',
        priority: 'normal',
        idempotency_key: 'workroom-drainer-stall:2026-11-10T14:00:00.000Z:0',
      })
    );
    const call = f.createAuthenticatedMessage.mock.calls[0] as unknown as [
      unknown,
      { body: string },
    ];
    expect(JSON.parse(call[1].body)).toEqual({
      kind: 'workroom_drainer_stall',
      reason: 'no_poll',
      minutes_since_last_poll: 31,
      oldest_unacked_message_id: null,
      oldest_unacked_age_minutes: null,
      threshold_minutes: 30,
      text: 'Workroom order notices are not being delivered.',
      note: 'order notices are not being delivered; see docs/operations/workroom-drainer-stall.md',
    });
  });

  test('T2: outside working hours does not alert or read the database', async () => {
    const f = fixture(14 * 60);
    await (await load()).runWorkroomDrainerStallCheck(f.deps);
    expect(f.createAuthenticatedMessage).not.toHaveBeenCalled();
    expect(f.readOldestUnackedMessage).not.toHaveBeenCalled();
  });

  test('T3: fresh poll and no old unacked message is healthy', async () => {
    const f = fixture();
    f.state.polls.set('workroom-drainer', BOOT + 20 * MINUTE);
    await (await load()).runWorkroomDrainerStallCheck(f.deps);
    expect(f.createAuthenticatedMessage).not.toHaveBeenCalled();
  });

  test('T4: fresh polls do not hide an unacked message older than the threshold', async () => {
    const f = fixture();
    f.state.polls.set('workroom-drainer', BOOT + 30 * MINUTE);
    f.oldest({ id: 'order-old', created_at: new Date(BOOT).toISOString() });
    await (await load()).runWorkroomDrainerStallCheck(f.deps);
    const call = f.createAuthenticatedMessage.mock.calls[0] as unknown as [
      unknown,
      { body: string; idempotency_key: string },
    ];
    expect(JSON.parse(call[1].body)).toMatchObject({
      reason: 'unacked_message_age',
      oldest_unacked_message_id: 'order-old',
      oldest_unacked_age_minutes: 31,
      minutes_since_last_poll: 1,
    });
    expect(call[1].idempotency_key).toBe('workroom-drainer-stall:order-old:0');
  });

  test('T5: same bucket is silent, next bucket repeats, failed sends retry and later stalls alert again', async () => {
    const f = fixture();
    const { runWorkroomDrainerStallCheck: check } = await load();
    await check(f.deps);
    await check(f.deps);
    expect(f.createAuthenticatedMessage).toHaveBeenCalledTimes(1);
    f.clock(241);
    await check(f.deps);
    expect(f.createAuthenticatedMessage).toHaveBeenCalledTimes(2);
    expect(f.createAuthenticatedMessage).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        idempotency_key: 'workroom-drainer-stall:2026-11-10T14:00:00.000Z:1',
      })
    );
    const failed = fixture();
    failed.createAuthenticatedMessage.mockImplementationOnce(async () => {
      throw new Error('send failed');
    });
    await expect(check(failed.deps)).resolves.toBeUndefined();
    await check(failed.deps);
    await check(failed.deps);
    expect(failed.createAuthenticatedMessage).toHaveBeenCalledTimes(2);
    expect(failed.error).toHaveBeenCalledTimes(1);
    f.state.polls.set('workroom-drainer', BOOT + 242 * MINUTE);
    f.clock(243);
    await check(f.deps);
    f.clock(273);
    await check(f.deps);
    expect(f.createAuthenticatedMessage).toHaveBeenCalledTimes(3);
  });

  test('T6: process start grants 30 minutes before the first no-poll alert', async () => {
    const f = fixture(0);
    const { runWorkroomDrainerStallCheck: check } = await load();
    await check(f.deps);
    f.clock(30);
    await check(f.deps);
    expect(f.createAuthenticatedMessage).not.toHaveBeenCalled();
    f.clock(31);
    await check(f.deps);
    expect(f.createAuthenticatedMessage).toHaveBeenCalledTimes(1);
    f.state.polls.set('workroom-drainer', BOOT - 60 * MINUTE);
    f.clock(1);
    await check(f.deps);
    expect(f.createAuthenticatedMessage).toHaveBeenCalledTimes(1);
  });

  test('T7: database failure is logged and swallowed without an alert', async () => {
    const f = fixture();
    f.readOldestUnackedMessage.mockImplementation(async () => {
      throw new Error('database unavailable');
    });
    await expect((await load()).runWorkroomDrainerStallCheck(f.deps)).resolves.toBeUndefined();
    expect(f.error).toHaveBeenCalledTimes(1);
    expect(f.createAuthenticatedMessage).not.toHaveBeenCalled();
  });

  test('notePrincipalPoll supplies the production poll map used by the check', async () => {
    const f = fixture();
    delete f.deps.state;
    const { notePrincipalPoll, runWorkroomDrainerStallCheck } = await load();
    const now = new Date();
    now.setUTCDate(now.getUTCDate() + 1);
    now.setUTCHours(12, 0, 0, 0);
    process.env.WORKROOM_DRAINER_STALL_TZ = 'UTC';
    f.deps.now = () => now;
    notePrincipalPoll('workroom-drainer', new Date(now.getTime() - MINUTE));
    await runWorkroomDrainerStallCheck(f.deps);
    expect(f.createAuthenticatedMessage).not.toHaveBeenCalled();
  });

  test('both reasons, timezones, overnight hours, invalid config and literal disable', async () => {
    const { runWorkroomDrainerStallCheck: check } = await load();
    const f = fixture();
    f.oldest({ id: 'order-both', created_at: new Date(BOOT).toISOString() });
    await check(f.deps);
    const call = f.createAuthenticatedMessage.mock.calls[0] as unknown as [
      unknown,
      { body: string },
    ];
    expect(JSON.parse(call[1].body).reason).toBe('both');
    const overnight = fixture(14 * 60);
    process.env.WORKROOM_DRAINER_STALL_HOURS = '22:00-07:00';
    await check(overnight.deps);
    expect(overnight.createAuthenticatedMessage).toHaveBeenCalledTimes(1);
    const invalid = fixture();
    process.env.WORKROOM_DRAINER_STALL_MINUTES = 'Infinity';
    process.env.WORKROOM_DRAINER_STALL_REPEAT_HOURS = 'bad';
    process.env.WORKROOM_DRAINER_STALL_HOURS = '25:90-99:00';
    process.env.WORKROOM_DRAINER_STALL_TZ = 'bad/timezone';
    await check(invalid.deps);
    expect(invalid.createAuthenticatedMessage).toHaveBeenCalledTimes(1);
    const disabled = fixture();
    process.env.WORKROOM_DRAINER_STALL_ENABLED = 'false';
    await check(disabled.deps);
    expect(disabled.createAuthenticatedMessage).not.toHaveBeenCalled();
    process.env.WORKROOM_DRAINER_STALL_ENABLED = 'FALSE';
    await check(disabled.deps);
    expect(disabled.createAuthenticatedMessage).toHaveBeenCalledTimes(1);
  });

  test('numeric minimums clamp to one and a configured timezone changes working hours', async () => {
    const { runWorkroomDrainerStallCheck: check } = await load();
    const f = fixture(2);
    process.env.WORKROOM_DRAINER_STALL_MINUTES = '0';
    process.env.WORKROOM_DRAINER_STALL_REPEAT_HOURS = '-1';
    await check(f.deps);
    expect(f.createAuthenticatedMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ body: expect.stringContaining('"threshold_minutes":1') })
    );
    f.clock(61);
    await check(f.deps);
    expect(f.createAuthenticatedMessage).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        idempotency_key: 'workroom-drainer-stall:2026-11-10T14:00:00.000Z:1',
      })
    );
    const timezone = fixture();
    process.env.WORKROOM_DRAINER_STALL_TZ = 'Asia/Tokyo';
    await check(timezone.deps);
    expect(timezone.createAuthenticatedMessage).not.toHaveBeenCalled();
  });

  test('real reader selects the oldest queued unacked notice, independent of priority and other recipients', async () => {
    const path = join(import.meta.dir, `.test-workroom-stall-${randomUUID()}.db`);
    const database = new SqliteAdapter(path);
    const getDatabase = spyOn(connection, 'getDatabase').mockReturnValue(database);
    try {
      for (const [id, recipient, status, at, ack, priority] of [
        [
          'acked',
          'workroom-drainer',
          'queued',
          '2026-11-09T01:00:00Z',
          '2026-11-09T02:00:00Z',
          'normal',
        ],
        ['other', 'operator', 'queued', '2026-11-09T01:00:00Z', null, 'normal'],
        ['done', 'workroom-drainer', 'done', '2026-11-09T01:00:00Z', null, 'normal'],
        ['old', 'workroom-drainer', 'queued', '2026-11-10T12:00:00Z', null, 'normal'],
        ['new', 'workroom-drainer', 'queued', '2026-11-10T13:00:00Z', null, 'blocker'],
      ]) {
        await database.query(
          `INSERT INTO agent_dispatch_messages
           (id, correlation_id, idempotency_key, task_type, sender, recipient, body, status, created_at, acknowledged_at, priority)
           VALUES ($1, $1, $1, 'agent_message', 'dispatch', $2, '{}', $3, $4, $5, $6)`,
          [id, recipient, status, at, ack, priority]
        );
      }
      const deps = (await load()).createRealWorkroomDrainerStallDeps();
      expect(await deps.readOldestUnackedMessage()).toEqual({
        id: 'old',
        created_at: '2026-11-10T12:00:00Z',
      });
      await database.query(
        "UPDATE agent_dispatch_messages SET acknowledged_at = created_at WHERE id IN ('old', 'new')"
      );
      expect(await deps.readOldestUnackedMessage()).toBeNull();
    } finally {
      getDatabase.mockRestore();
      await database.close();
      for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(path + suffix, { force: true });
    }
  });

  test('timer is test-disabled, idempotent, unrefed, guarded against overlapping checks and stoppable', async () => {
    const { startWorkroomDrainerStallTimer: start, stopWorkroomDrainerStallTimer: stop } =
      await load();
    const f = fixture();
    let tick: (() => void) | undefined;
    const unref = mock(() => undefined);
    const setIntervalFn = mock((fn: () => void, _ms: number) => {
      tick = fn;
      return { unref };
    });
    const clearIntervalFn = mock(() => undefined);
    const options = { deps: f.deps, setIntervalFn, clearIntervalFn };
    process.env.NODE_ENV = 'test';
    start(options);
    expect(setIntervalFn).not.toHaveBeenCalled();
    process.env.NODE_ENV = 'production';
    let finish: (() => void) | undefined;
    f.readOldestUnackedMessage.mockImplementation(async () => {
      await new Promise<void>(resolve => {
        finish = resolve;
      });
      return null;
    });
    start(options);
    start(options);
    expect(setIntervalFn).toHaveBeenCalledTimes(1);
    expect(setIntervalFn).toHaveBeenCalledWith(expect.any(Function), 60_000);
    expect(unref).toHaveBeenCalledTimes(1);
    tick?.();
    tick?.();
    expect(f.readOldestUnackedMessage).toHaveBeenCalledTimes(1);
    finish?.();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.createAuthenticatedMessage).toHaveBeenCalledTimes(1);
    tick?.();
    expect(f.readOldestUnackedMessage).toHaveBeenCalledTimes(2);
    finish?.();
    await new Promise(resolve => setTimeout(resolve, 0));
    stop();
    stop();
    expect(clearIntervalFn).toHaveBeenCalledTimes(1);
  });
});
