#!/usr/bin/env bun
/**
 * retire-workroom-drainer-route.ts -- mark the retired Workroom drainer route's open rows
 * superseded (WO-HARNESS-RETIRE-WORKROOM-DRAINER-ROUTE-01).
 *
 * Dry run by default; --confirm mutates. Selects ONLY rows that are queued, unacknowledged,
 * unaddressed and without a route disposition, of two kinds:
 *   (a) recipient 'workroom-drainer' from sender 'order-events' (order-notice copies to a
 *       recipient that was never installed);
 *   (b) recipient 'xo' from sender 'dispatch' whose body kind is 'workroom_drainer_stall'
 *       (the retired stall alarm).
 * It never touches a row to recipient 'xo' from 'order-events' (the XO's own order alerts),
 * and it does not use or loosen the K4 protection of scripts/dispatch/mailbox-lifecycle.ts.
 *
 * --exclude <id,id,...> leaves those rows queued: per XO-WR-1 (bdc-xo#5291 comment
 * 6842204011), "a message whose order the importer's preview does NOT show is not superseded".
 *
 * One transaction, one tm_journal row (key retire-workroom-drainer-route:<UTC date>) carrying
 * the ids, the ruling citation and each row's previous values, so the run can be rolled back
 * from the journal row alone. A second --confirm run on the same date changes nothing.
 *
 * The run itself is an operator step under a recorded board motion and John's go; it is not
 * part of the build.
 *
 * Usage:
 *   bun scripts/dispatch/retire-workroom-drainer-route.ts                       # dry run
 *   bun scripts/dispatch/retire-workroom-drainer-route.ts --exclude id1,id2     # dry run
 *   bun scripts/dispatch/retire-workroom-drainer-route.ts --confirm --exclude id1,id2
 */
import { randomUUID } from 'node:crypto';
import { closeDatabase, getDatabase } from '../../packages/core/src/db/connection';

const OPEN = `status = 'queued' AND acknowledged_at IS NULL AND addressed_at IS NULL
  AND route_disposition IS NULL`;

const SELECT_SQL = `SELECT id, recipient, sender, status, completed_at, route_disposition, result_body, created_at
  FROM agent_dispatch_messages
  WHERE ${OPEN}
    AND (
      (recipient = 'workroom-drainer' AND sender = 'order-events')
      OR (recipient = 'xo' AND sender = 'dispatch' AND body LIKE '%"kind":"workroom_drainer_stall"%')
    )
  ORDER BY created_at, id`;

export const RESULT_BODY = JSON.stringify({
  reason: 'retired_route',
  ruling: 'XO-WR-1 (2026-11-13, bdc-xo#5291 comment 6842204011)',
  work_order: 'WO-HARNESS-RETIRE-WORKROOM-DRAINER-ROUTE-01',
});

export interface RetireRow {
  id: string;
  recipient: string;
  sender: string;
  status: string;
  completed_at: string | null;
  route_disposition: string | null;
  result_body: string | null;
  created_at: string;
}

export interface RetireResult {
  mode: 'dry-run' | 'confirmed' | 'already-done';
  journalKey: string;
  selected: RetireRow[];
  excluded: string[];
  changed: number;
}

export function journalKeyFor(now: Date): string {
  return `retire-workroom-drainer-route:${now.toISOString().slice(0, 10)}`;
}

export async function runRetireWorkroomDrainerRoute(options: {
  confirm: boolean;
  exclude: readonly string[];
  now?: Date;
  log?: (line: string) => void;
}): Promise<RetireResult> {
  const now = options.now ?? new Date();
  const log =
    options.log ??
    ((line: string): void => {
      console.log(line);
    });
  const db = getDatabase();
  const journalKey = journalKeyFor(now);
  const excludeSet = new Set(options.exclude.map(id => id.trim()).filter(Boolean));

  const existing = await db.query<{ id: string }>(
    'SELECT id FROM tm_journal WHERE idempotency_key = $1',
    [journalKey]
  );
  if (options.confirm && existing.rows.length > 0) {
    log(`[retire] already done: journal row ${journalKey} exists; nothing changed.`);
    return { mode: 'already-done', journalKey, selected: [], excluded: [], changed: 0 };
  }

  const all = (await db.query<RetireRow>(SELECT_SQL)).rows;
  const selected = all.filter(row => !excludeSet.has(row.id));
  const excluded = all.filter(row => excludeSet.has(row.id)).map(row => row.id);
  for (const row of selected) {
    log(
      `[retire] ${options.confirm ? 'supersede' : 'would supersede'} ${row.id} ${row.recipient} ${row.sender} ${row.created_at}`
    );
  }
  for (const id of excluded) log(`[retire] excluded (order not on the desk) ${id}`);
  const unmatched = [...excludeSet].filter(id => !all.some(row => row.id === id));
  for (const id of unmatched) log(`[retire] excluded id not among the open rows: ${id}`);

  if (!options.confirm) {
    log(
      `[retire] dry run: ${selected.length} would be superseded, ${excluded.length} excluded. Re-run with --confirm under the recorded motion.`
    );
    return { mode: 'dry-run', journalKey, selected, excluded, changed: 0 };
  }

  const nowIso = now.toISOString();
  let changed = 0;
  await db.withTransaction(async query => {
    for (const row of selected) {
      const result = await query(
        `UPDATE agent_dispatch_messages
           SET status = 'done', completed_at = $2, route_disposition = 'superseded', result_body = $3
         WHERE id = $1 AND ${OPEN}`,
        [row.id, nowIso, RESULT_BODY]
      );
      if (result.rowCount !== 1) throw new Error(`retire_row_changed_under_us:${row.id}`);
      changed += 1;
    }
    await query(
      `INSERT INTO tm_journal
         (id, created_at, thread_ref, action_type, proposal_json, idempotency_key, outcome)
       VALUES ($1, $2, $3, 'digest', $4, $5, 'expired')`,
      [
        randomUUID(),
        nowIso,
        'retire-workroom-drainer-route',
        JSON.stringify({
          note:
            `Superseded ${selected.length} open rows of the retired Workroom drainer route. ` +
            'Authority: XO-WR-1 (bdc-xo#5291 comment 6842204011) under a recorded motion and ' +
            "John's go; WO-HARNESS-RETIRE-WORKROOM-DRAINER-ROUTE-01.",
          ids: selected.map(row => row.id),
          excluded,
          previous: selected.map(row => ({
            id: row.id,
            status: row.status,
            completed_at: row.completed_at,
            route_disposition: row.route_disposition,
            result_body: row.result_body,
          })),
        }),
        journalKey,
      ]
    );
  });
  log(`[retire] superseded ${changed} rows, ${excluded.length} excluded, journal ${journalKey}.`);
  return { mode: 'confirmed', journalKey, selected, excluded, changed };
}

function parseExclude(argv: readonly string[]): string[] {
  const index = argv.indexOf('--exclude');
  if (index === -1) return [];
  const value = argv[index + 1];
  if (!value || value.startsWith('--'))
    throw new Error('--exclude needs a comma-separated id list');
  return value.split(',');
}

if (import.meta.main) {
  runRetireWorkroomDrainerRoute({
    confirm: process.argv.includes('--confirm'),
    exclude: parseExclude(process.argv),
  })
    .then(async () => {
      await closeDatabase();
    })
    .catch(async error => {
      console.error(error instanceof Error ? error.message : String(error));
      await closeDatabase();
      process.exit(1);
    });
}
