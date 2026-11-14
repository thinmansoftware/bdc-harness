/**
 * address-batch tests (WO-HARNESS-TASKMASTER-ESCALATE-P0-FLOOD-01, Test 7): a
 * real sqlite database with the real agent_dispatch_messages and
 * board_xo_leases tables, and a temp audit file. Seven cases.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createHash } from 'crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SqliteAdapter } from '../../packages/core/src/db/adapters/sqlite';

let db: SqliteAdapter;

mock.module('../../packages/core/src/db/connection', () => ({
  getDatabase: () => db,
}));

const { runAddressBatch } = await import('./address-batch');

const NOW = new Date('2026-11-13T20:00:00.000Z');
const HOUR = 3_600_000;
const HOLDER_TOKEN = 'xht-TEST-ONLY';
const HOLDER_HASH = createHash('sha256').update(HOLDER_TOKEN).digest('hex');
const OLD_IDS = ['m-old-1', 'm-old-2', 'm-old-3'];
const NEW_IDS = ['m-new-1', 'm-new-2', 'm-new-3'];

let dir: string;
let auditFile: string;
let bindFile: string;

interface Row {
  id: string;
  addressed_at: string | null;
  addressed_by: string | null;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  status: string;
}

async function insertMessage(
  id: string,
  kind: string,
  hoursOld: number,
  acked: boolean,
  body: string = JSON.stringify({ kind, text: 'test row' })
): Promise<void> {
  await db.query(
    `INSERT INTO agent_dispatch_messages
       (id, correlation_id, idempotency_key, task_type, sender, recipient, body, status,
        created_at, acknowledged_at, acknowledged_by)
     VALUES ($1, $1, $1, 'agent_message', 'system:dispatch', 'xo', $2, 'queued', $3, $4, $5)`,
    [
      id,
      body,
      new Date(NOW.getTime() - hoursOld * HOUR).toISOString(),
      acked ? new Date(NOW.getTime() - HOUR).toISOString() : null,
      acked ? 'xo' : null,
    ]
  );
}

async function rows(): Promise<Row[]> {
  // QueryResult.rows is readonly; copy it so callers get a plain Row[] (TS4104).
  return [
    ...(
      await db.query<Row>(
        `SELECT id, addressed_at, addressed_by, acknowledged_at, acknowledged_by, status
       FROM agent_dispatch_messages ORDER BY id`
      )
    ).rows,
  ];
}

function auditLines(): Array<Record<string, unknown>> {
  if (!existsSync(auditFile)) return [];
  return readFileSync(auditFile, 'utf8')
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

const FILTERS = [
  '--recipient',
  'xo',
  '--status',
  'queued',
  '--kind',
  'duty_officer_escalation',
  '--min-age-hours',
  '72',
];

async function run(
  argv: string[],
  beforeUpdateForTests?: (
    query: (sql: string, params?: unknown[]) => Promise<unknown>
  ) => Promise<void>
): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runAddressBatch([...argv, '--audit-file', auditFile], {
    db,
    now: () => NOW,
    env: {},
    out: line => out.push(line),
    err: line => err.push(line),
    beforeUpdateForTests: beforeUpdateForTests as never,
  });
  return { code, out, err };
}

async function dryRun(): Promise<string> {
  const result = await run(FILTERS);
  expect(result.code).toBe(0);
  const line = result.out.find(l => l.startsWith('dry_run_id: '));
  return line!.slice('dry_run_id: '.length);
}

function writeBind(overrides: Record<string, unknown> = {}): void {
  writeFileSync(
    bindFile,
    JSON.stringify({
      kind: 'xo_lease',
      lease_id: 'lease-1',
      fencing_token: 7,
      holder_token_hash: HOLDER_HASH,
      holder_principal_id: 'xo-holder',
      ...overrides,
    })
  );
}

beforeEach(async () => {
  db = new SqliteAdapter(':memory:');
  dir = mkdtempSync(join(tmpdir(), 'address-batch-'));
  auditFile = join(dir, 'audit.jsonl');
  bindFile = join(dir, 'bind.json');
  // 3 duty_officer_escalation older than 72 h (2 never acknowledged), 3 newer agent_message.
  await insertMessage(OLD_IDS[0]!, 'duty_officer_escalation', 100, true);
  await insertMessage(OLD_IDS[1]!, 'duty_officer_escalation', 90, false);
  await insertMessage(OLD_IDS[2]!, 'duty_officer_escalation', 80, false);
  for (const id of NEW_IDS) await insertMessage(id, 'agent_message', 2, false);
  // Ordinary text, malformed JSON and valid non-kind bodies coexist with the
  // escalation flood. Every row is old enough and in the selected mailbox.
  for (const [id, body] of [
    ['m-plain', 'duty_officer_escalation: ordinary text message'],
    ['m-malformed', '{"kind":'],
    ['m-empty', ''],
    ['m-json-null', 'null'],
    ['m-json-string', '"duty_officer_escalation"'],
    ['m-json-other-kind', '{"kind":"agent_message"}'],
  ]) {
    await insertMessage(id!, 'agent_message', 100, false, body!);
  }
  await db.query(
    `INSERT INTO board_xo_leases
       (id, lease_id, principal_id, seat_id, holder_id, holder_token_hash, fencing_token,
        acquired_at, expires_at)
     VALUES (1, 'lease-1', 'xo-holder', 'xo', 'holder-1', $1, 7, $2, $3)`,
    [
      HOLDER_HASH,
      new Date(NOW.getTime() - HOUR).toISOString(),
      new Date(Date.now() + 24 * HOUR).toISOString(),
    ]
  );
  writeBind();
});

afterEach(async () => {
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('scripts/dispatch/address-batch.ts', () => {
  test('address-batch: refuses without filters', async () => {
    const before = await rows();
    const result = await run(['--recipient', 'xo']);
    expect(result.code).toBe(2);
    expect(result.err.join('\n')).toContain('usage:');
    expect(await rows()).toEqual(before);
    expect(auditLines()).toEqual([]);
  });

  test('address-batch: dry run lists and changes nothing', async () => {
    const before = await rows();
    const result = await run(FILTERS);
    expect(result.code).toBe(0);
    expect(result.out.filter(line => line.startsWith('m-'))).toEqual(OLD_IDS);
    expect(
      result.out.some(line => line.startsWith('filter: ') && line.includes('created_at <='))
    ).toBe(true);
    expect(result.out).toContain(
      "kind expression: CASE WHEN json_valid(body) THEN json_extract(body, '$.kind') ELSE NULL END"
    );
    expect(await rows()).toEqual(before);
    const lines = auditLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ type: 'dry_run', ids: OLD_IDS, count: 3 });
    expect(typeof lines[0]!.dry_run_id).toBe('string');
  });

  test('address-batch: confirm needs actor and reason', async () => {
    const id = await dryRun();
    const before = await rows();
    for (const argv of [
      [
        ...FILTERS,
        '--confirm',
        '--dry-run-id',
        id,
        '--reason',
        'flood',
        '--xo-bind-file',
        bindFile,
      ],
      [
        ...FILTERS,
        '--confirm',
        '--dry-run-id',
        id,
        '--actor',
        'xo-test',
        '--xo-bind-file',
        bindFile,
      ],
      [...FILTERS, '--confirm', '--dry-run-id', id, '--actor', 'xo-test', '--reason', 'flood'],
    ]) {
      const result = await run(argv);
      expect(result.code).toBe(2);
    }
    // A confirm on any status but queued can never match its UPDATE: refused up front.
    const notQueued = await run([
      '--recipient',
      'xo',
      '--status',
      'done',
      '--kind',
      'duty_officer_escalation',
      '--min-age-hours',
      '72',
      '--confirm',
      '--dry-run-id',
      id,
      '--actor',
      'xo-test',
      '--reason',
      'flood',
      '--xo-bind-file',
      bindFile,
    ]);
    expect(notQueued.code).toBe(2);
    expect(notQueued.err.join('\n')).toContain('confirm_requires_status_queued');
    expect(await rows()).toEqual(before);
    expect(auditLines().filter(line => line.type === 'confirm')).toEqual([]);
  });

  test('address-batch: confirm needs a matching dry run', async () => {
    await dryRun();
    const before = await rows();
    const missing = await run([
      ...FILTERS,
      '--confirm',
      '--actor',
      'xo-test',
      '--reason',
      'flood',
      '--xo-bind-file',
      bindFile,
    ]);
    expect(missing.code).toBe(2);
    const wrong = await run([
      ...FILTERS,
      '--confirm',
      '--dry-run-id',
      'f'.repeat(64),
      '--actor',
      'xo-test',
      '--reason',
      'flood',
      '--xo-bind-file',
      bindFile,
    ]);
    expect(wrong.code).toBe(2);
    expect(wrong.err.join('\n')).toContain('dry_run_mismatch');
    expect(await rows()).toEqual(before);
    expect(auditLines().filter(line => line.type === 'confirm')).toEqual([]);
  });

  test('address-batch: confirm addresses exactly the dry-run set', async () => {
    const id = await dryRun();
    const before = await rows();
    const result = await run([
      ...FILTERS,
      '--confirm',
      '--dry-run-id',
      id,
      '--actor',
      'xo-test',
      '--reason',
      'flood',
      '--xo-bind-file',
      bindFile,
    ]);
    expect(result.code).toBe(0);
    const after = await rows();
    for (const row of after) {
      const prior = before.find(b => b.id === row.id)!;
      // acknowledged_* and status never change, on any row.
      expect(row.acknowledged_at).toBe(prior.acknowledged_at);
      expect(row.acknowledged_by).toBe(prior.acknowledged_by);
      expect(row.status).toBe(prior.status);
      if (OLD_IDS.includes(row.id)) {
        // Includes the 2 never acknowledged: the stated departure from addressMessage.
        expect(row.addressed_at).toBe(NOW.toISOString());
        expect(row.addressed_by).toBe('bulk-address:xo-test');
      } else {
        expect(row.addressed_at).toBeNull();
        expect(row.addressed_by).toBeNull();
      }
    }
    const confirm = auditLines().filter(line => line.type === 'confirm');
    expect(confirm).toHaveLength(1);
    // The pending line is written inside the transaction, the confirm line after COMMIT.
    expect(auditLines().filter(line => line.type === 'confirm_pending')).toHaveLength(1);
    expect(confirm[0]).toMatchObject({
      actor: 'xo-test',
      reason: 'flood',
      dry_run_ids: OLD_IDS,
      confirmed_ids: OLD_IDS,
      count: 3,
    });
  });

  test('address-batch: rolls back when the count differs', async () => {
    const confirmArgs = (dryRunIdValue: string): string[] => [
      ...FILTERS,
      '--confirm',
      '--dry-run-id',
      dryRunIdValue,
      '--actor',
      'xo-test',
      '--reason',
      'flood',
      '--xo-bind-file',
      bindFile,
    ];
    // (1) The UPDATE itself matches fewer rows than the dry run: another writer
    // addresses one row INSIDE the transaction, after the dry-run re-check. The
    // count differs, exit 3, and the whole transaction rolls back -- including
    // that writer's change, which proves the rollback.
    const firstId = await dryRun();
    const before = await rows();
    const raced = await run(confirmArgs(firstId), async query => {
      await query(
        "UPDATE agent_dispatch_messages SET addressed_at = $1, addressed_by = 'someone-else' WHERE id = $2",
        [NOW.toISOString(), OLD_IDS[1]]
      );
    });
    expect(raced.code).toBe(3);
    expect(auditLines().filter(line => line.type === 'confirm_pending')).toEqual([]);
    expect(raced.err.join('\n')).toContain('count_mismatch_rolled_back');
    expect(await rows()).toEqual(before);
    expect(auditLines().filter(line => line.type === 'confirm')).toEqual([]);

    // A selected body can become non-JSON after the transactional re-check.
    // The guarded UPDATE excludes it; the count mismatch rolls everything back.
    const bodyBefore = await db.query<{ body: string }>(
      'SELECT body FROM agent_dispatch_messages WHERE id = $1',
      [OLD_IDS[0]]
    );
    const malformed = await run(confirmArgs(await dryRun()), async query => {
      await query('UPDATE agent_dispatch_messages SET body = $1 WHERE id = $2', [
        'ordinary text after re-check',
        OLD_IDS[0],
      ]);
    });
    expect(malformed.code).toBe(3);
    expect(malformed.err.join('\n')).toContain('count_mismatch_rolled_back');
    expect(await rows()).toEqual(before);
    expect(
      (
        await db.query<{ body: string }>('SELECT body FROM agent_dispatch_messages WHERE id = $1', [
          OLD_IDS[0],
        ])
      ).rows
    ).toEqual(bodyBefore.rows);
    expect(auditLines().filter(line => line.type === 'confirm_pending')).toEqual([]);

    // (2) A row changed BETWEEN the dry run and the confirm is caught by the
    // dry-run re-check before any update: exit 2.
    const id = await dryRun();
    // Another actor addresses one of the three after the dry run.
    await db.query(
      "UPDATE agent_dispatch_messages SET addressed_at = $1, addressed_by = 'someone-else' WHERE id = $2",
      [NOW.toISOString(), OLD_IDS[1]]
    );
    const result = await run([
      ...FILTERS,
      '--confirm',
      '--dry-run-id',
      id,
      '--actor',
      'xo-test',
      '--reason',
      'flood',
      '--xo-bind-file',
      bindFile,
    ]);
    expect(result.code).toBe(2);
    expect(result.err.join('\n')).toContain('dry_run_mismatch');
    const after = await rows();
    expect(after.filter(row => row.addressed_by === 'bulk-address:xo-test')).toEqual([]);
    expect(auditLines().filter(line => line.type === 'confirm')).toEqual([]);
  });

  test('address-batch: confirm refuses a stale XO lease bind', async () => {
    const id = await dryRun();
    const before = await rows();
    writeBind({ fencing_token: 8 });
    const stale = await run([
      ...FILTERS,
      '--confirm',
      '--dry-run-id',
      id,
      '--actor',
      'xo-test',
      '--reason',
      'flood',
      '--xo-bind-file',
      bindFile,
    ]);
    expect(stale.code).toBe(2);
    expect(stale.err.join('\n')).toContain('lease_fence_stale');
    // Second sub-case: the live lease has expired.
    writeBind();
    await db.query('UPDATE board_xo_leases SET expires_at = $1 WHERE id = 1', [
      new Date(Date.now() - HOUR).toISOString(),
    ]);
    const expired = await run([
      ...FILTERS,
      '--confirm',
      '--dry-run-id',
      id,
      '--actor',
      'xo-test',
      '--reason',
      'flood',
      '--xo-bind-file',
      bindFile,
    ]);
    expect(expired.code).toBe(2);
    expect(expired.err.join('\n')).toContain('lease_fence_stale');
    expect(await rows()).toEqual(before);
    expect(auditLines().filter(line => line.type === 'confirm')).toEqual([]);
  });
});
