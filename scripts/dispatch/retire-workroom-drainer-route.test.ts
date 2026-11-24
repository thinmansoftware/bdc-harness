/**
 * retire-workroom-drainer-route.ts (WO-HARNESS-RETIRE-WORKROOM-DRAINER-ROUTE-01, Tests 4 to 6).
 * Only this file runs in its bun process, so mocking the connection module is safe.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SqliteAdapter } from '../../packages/core/src/db/adapters/sqlite';

let db: SqliteAdapter;

mock.module('../../packages/core/src/db/connection', () => ({
  getDatabase: () => db,
  closeDatabase: async () => {},
}));

const { runRetireWorkroomDrainerRoute, RESULT_BODY, journalKeyFor } =
  await import('./retire-workroom-drainer-route');

const NOW = new Date('2026-11-24T12:00:00.000Z');
const STALL =
  '{"kind":"workroom_drainer_stall","reason":"both","text":"Workroom order notices are not being delivered."}';
let dir: string;

async function insert(row: {
  id: string;
  sender: string;
  recipient: string;
  body?: string;
  acknowledged?: boolean;
}): Promise<void> {
  await db.query(
    `INSERT INTO agent_dispatch_messages
       (id, correlation_id, idempotency_key, task_type, sender, sender_principal_id, recipient,
        body, status, created_at, priority, fencing_token, acknowledged_at, acknowledged_by)
     VALUES ($1, $2, $1, 'agent_message', $3, $4, $5, $6, 'queued', $7, 'normal', 0, $8, $9)`,
    [
      row.id,
      `corr-${row.id}`,
      row.sender,
      row.sender,
      row.recipient,
      row.body ?? `WhatNot order created: ${row.id}`,
      '2026-11-20T10:00:00.000Z',
      row.acknowledged ? '2026-11-20T11:00:00.000Z' : null,
      row.acknowledged ? row.recipient : null,
    ]
  );
}

async function rowOf(id: string): Promise<Record<string, unknown>> {
  const result = await db.query<Record<string, unknown>>(
    'SELECT status, completed_at, route_disposition, result_body FROM agent_dispatch_messages WHERE id = $1',
    [id]
  );
  return result.rows[0]!;
}

async function journalCount(): Promise<number> {
  const result = await db.query<{ n: number }>(
    'SELECT COUNT(*) AS n FROM tm_journal WHERE idempotency_key = $1',
    [journalKeyFor(NOW)]
  );
  return Number(result.rows[0]?.n ?? 0);
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'retire-drainer-'));
  db = new SqliteAdapter(join(dir, 'test.db'));
  // (a) copies to the retired recipient; one of them is excluded (order not on the desk)
  await insert({ id: 'copy-1', sender: 'order-events', recipient: 'workroom-drainer' });
  await insert({ id: 'copy-2', sender: 'order-events', recipient: 'workroom-drainer' });
  await insert({ id: 'copy-off-desk', sender: 'order-events', recipient: 'workroom-drainer' });
  // (b) the retired stall alarm
  await insert({ id: 'alarm-1', sender: 'dispatch', recipient: 'xo', body: STALL });
  // never touched: the XO's own order alert, another dispatch row, an acknowledged copy
  await insert({ id: 'xo-order', sender: 'order-events', recipient: 'xo' });
  await insert({
    id: 'xo-other',
    sender: 'dispatch',
    recipient: 'xo',
    body: '{"kind":"duty_officer_escalation"}',
  });
  // never touched: look-alikes of the alarm (Overseer App review at d99a8e0b): the stall kind
  // only in a nested field, and an underscore-wildcard match of the kind text
  await insert({
    id: 'xo-nested',
    sender: 'dispatch',
    recipient: 'xo',
    body: '{"kind":"duty_officer_escalation","detail":{"kind":"workroom_drainer_stall"}}',
  });
  await insert({
    id: 'xo-wildcard',
    sender: 'dispatch',
    recipient: 'xo',
    body: '{"kind":"workroomXdrainerXstall"}',
  });
  await insert({
    id: 'copy-acked',
    sender: 'order-events',
    recipient: 'workroom-drainer',
    acknowledged: true,
  });
});

afterEach(async () => {
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

const lines: string[] = [];
const log = (line: string): void => {
  lines.push(line);
};

describe('retire-workroom-drainer-route', () => {
  test('Test 4: the dry run changes nothing and names every id', async () => {
    lines.length = 0;
    const before = await rowOf('copy-1');
    const result = await runRetireWorkroomDrainerRoute({
      confirm: false,
      exclude: ['copy-off-desk'],
      now: NOW,
      log,
    });
    expect(result.mode).toBe('dry-run');
    expect(result.selected.map(row => row.id).sort()).toEqual(['alarm-1', 'copy-1', 'copy-2']);
    expect(result.excluded).toEqual(['copy-off-desk']);
    for (const id of ['alarm-1', 'copy-1', 'copy-2']) {
      expect(lines.some(line => line.includes(`would supersede ${id}`))).toBe(true);
    }
    expect(
      lines.some(line => line.includes('excluded (order not on the desk) copy-off-desk'))
    ).toBe(true);
    expect(await rowOf('copy-1')).toEqual(before);
    expect(await journalCount()).toBe(0);
  });

  test('Test 5: --confirm supersedes only (a) and (b), with one journal row holding previous values', async () => {
    const untouched = {
      'xo-order': await rowOf('xo-order'),
      'xo-other': await rowOf('xo-other'),
      'xo-nested': await rowOf('xo-nested'),
      'xo-wildcard': await rowOf('xo-wildcard'),
      'copy-acked': await rowOf('copy-acked'),
      'copy-off-desk': await rowOf('copy-off-desk'),
    };
    const result = await runRetireWorkroomDrainerRoute({
      confirm: true,
      exclude: ['copy-off-desk'],
      now: NOW,
      log,
    });
    expect(result.mode).toBe('confirmed');
    expect(result.changed).toBe(3);
    for (const id of ['alarm-1', 'copy-1', 'copy-2']) {
      expect(await rowOf(id)).toEqual({
        status: 'done',
        completed_at: NOW.toISOString(),
        route_disposition: 'superseded',
        result_body: RESULT_BODY,
      });
    }
    // The XO's own order alert, other dispatch mail, the acknowledged copy and the excluded
    // copy are unchanged.
    for (const [id, before] of Object.entries(untouched)) {
      expect(await rowOf(id)).toEqual(before);
    }
    expect(await journalCount()).toBe(1);
    const journal = await db.query<{ proposal_json: string }>(
      'SELECT proposal_json FROM tm_journal WHERE idempotency_key = $1',
      [journalKeyFor(NOW)]
    );
    const proposal = JSON.parse(journal.rows[0]!.proposal_json) as {
      ids: string[];
      excluded: string[];
      previous: Array<{ id: string; status: string; route_disposition: string | null }>;
    };
    expect(proposal.ids.sort()).toEqual(['alarm-1', 'copy-1', 'copy-2']);
    expect(proposal.excluded).toEqual(['copy-off-desk']);
    expect(
      proposal.previous.map(row => [row.id, row.status, row.route_disposition]).sort()
    ).toEqual([
      ['alarm-1', 'queued', null],
      ['copy-1', 'queued', null],
      ['copy-2', 'queued', null],
    ]);
  });

  test('Test 6: a second --confirm run on the same date changes nothing', async () => {
    await runRetireWorkroomDrainerRoute({
      confirm: true,
      exclude: ['copy-off-desk'],
      now: NOW,
      log,
    });
    const afterFirst = await rowOf('copy-off-desk');
    lines.length = 0;
    const second = await runRetireWorkroomDrainerRoute({
      confirm: true,
      exclude: [],
      now: NOW,
      log,
    });
    expect(second.mode).toBe('already-done');
    expect(second.changed).toBe(0);
    expect(await rowOf('copy-off-desk')).toEqual(afterFirst);
    expect(await journalCount()).toBe(1);
    expect(lines.some(line => line.includes('already done'))).toBe(true);
  });
});
