/**
 * mailbox-lifecycle tests (WO-HARNESS-XO-MAILBOX-LIFECYCLE-01, spec Tests 8-12):
 * a real sqlite database with the real agent_dispatch_messages, dispatch_principals
 * and tm_journal tables, and temp files for the evidence and the export directory.
 * Only this file runs in its bun process, so mocking the connection module is safe.
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
  closeDatabase: async () => {},
}));

const { runMailboxLifecycle } = await import('./mailbox-lifecycle');

const NOW = new Date('2026-11-22T18:00:00.000Z');
const HOUR = 3_600_000;
const SUBJECT = 'gh:thinmansoftware/bdc-xo#1538';
const WO = 'WO-HARNESS-XO-MAILBOX-LIFECYCLE-01';

let dir: string;
let outDir: string;

interface FixtureRow {
  id: string;
  sender: string;
  sender_principal_id: string | null;
  recipient?: string;
  body?: string;
  status?: string;
  hoursOld: number;
  subject_key?: string | null;
  correlation_id?: string;
  acknowledged?: boolean;
  addressed?: boolean;
  priority?: string;
}

async function insertRow(row: FixtureRow): Promise<void> {
  const created = new Date(NOW.getTime() - row.hoursOld * HOUR).toISOString();
  const receipt = new Date(NOW.getTime() - (row.hoursOld - 0.5) * HOUR).toISOString();
  await db.query(
    `INSERT INTO agent_dispatch_messages
       (id, correlation_id, idempotency_key, task_type, sender, sender_principal_id, recipient,
        body, status, created_at, priority, fencing_token, subject_key,
        acknowledged_at, acknowledged_by, addressed_at, addressed_by)
     VALUES ($1, $2, $1, 'agent_message', $3, $4, $5, $6, $7, $8, $9, 0, $10, $11, $12, $13, $14)`,
    [
      row.id,
      row.correlation_id ?? `corr-${row.id}`,
      row.sender,
      row.sender_principal_id,
      row.recipient ?? 'xo',
      row.body ?? `body of ${row.id}`,
      row.status ?? 'queued',
      created,
      row.priority ?? 'normal',
      row.subject_key === undefined ? SUBJECT : row.subject_key,
      row.acknowledged || row.addressed ? receipt : null,
      row.acknowledged || row.addressed ? (row.recipient ?? 'xo') : null,
      row.addressed ? receipt : null,
      row.addressed ? (row.recipient ?? 'xo') : null,
    ]
  );
}

const BIG_650 = 'A'.repeat(650 * 1024);
const BIG_30 = 'B'.repeat(30 * 1024);
const SMALL_1 = 'C'.repeat(1024);

async function seedFixture(): Promise<void> {
  const system = (id: string, principal: string, hoursOld: number, extra = {}) =>
    insertRow({
      id,
      sender: principal.slice(7),
      sender_principal_id: principal,
      hoursOld,
      ...extra,
    });
  // Addressed but still queued (the backfill class).
  await system('bf-1', 'system:dispatch', 60, { addressed: true, subject_key: null });
  await system('bf-2', 'system:taskmaster', 59, { addressed: true, subject_key: null });
  await system('bf-op-1', 'system:dispatch', 58, {
    addressed: true,
    recipient: 'operator',
    subject_key: null,
  });
  // K1: Duty Officer and handoff repeats from system:dispatch.
  await system('k1-1', 'system:dispatch', 50);
  await system('k1-2', 'system:dispatch', 40);
  await system('k1-3', 'system:dispatch', 30);
  // K2: Taskmaster repeats, by subject and (no subject) by correlation id.
  await system('k2-1', 'system:taskmaster', 45);
  await system('k2-2', 'system:taskmaster', 35);
  await system('k2-c-1', 'system:taskmaster', 44, { subject_key: null, correlation_id: 'tm-same' });
  await system('k2-c-2', 'system:taskmaster', 34, { subject_key: null, correlation_id: 'tm-same' });
  // Old subject-less EXHAUSTED rows: one per expectation, never grouped together.
  for (const [id, hoursOld] of [
    ['ex-1', 33],
    ['ex-2', 32],
  ] as const) {
    await system(id, 'system:taskmaster', hoursOld, {
      subject_key: null,
      priority: 'blocker',
      body: `Taskmaster expectation EXHAUSTED -- no human has confirmed this work landed.\n\nexpectation_id: ${id}`,
    });
  }
  // An acknowledged system row: not open, never superseded.
  await system('ack-1', 'system:dispatch', 31, { acknowledged: true });
  // Worker-poll repeats (codex is a worker_poll principal): never collapsed.
  await system('wp-1', 'system:dispatch', 20, { recipient: 'codex' });
  await system('wp-2', 'system:dispatch', 19, { recipient: 'codex' });
  // A seat-authored repeat.
  await insertRow({ id: 'seat-1', sender: 'codex', sender_principal_id: 'codex', hoursOld: 29 });
  await insertRow({ id: 'seat-2', sender: 'codex', sender_principal_id: 'codex', hoursOld: 28 });
  // K3: DISK ALERT digests from the xo seat.
  for (const [id, hoursOld] of [
    ['disk-1', 27],
    ['disk-2', 26],
  ] as const) {
    await insertRow({
      id,
      sender: 'xo',
      sender_principal_id: 'xo',
      hoursOld,
      subject_key: null,
      body: `DISK ALERT ubuntu-8gb-hil-1 / at 9${id.slice(-1)} percent`,
    });
  }
  // K4: customer rows, including an addressed one and a large one.
  await insertRow({
    id: 'cust-1',
    sender: 'order-events',
    sender_principal_id: 'order-events',
    hoursOld: 25,
    subject_key: null,
    body: 'eBay order PAID',
  });
  await insertRow({
    id: 'cust-2',
    sender: 'whatnot-webhook',
    sender_principal_id: 'whatnot-webhook',
    hoursOld: 24,
    subject_key: null,
  });
  await insertRow({
    id: 'cust-bf',
    sender: 'order-events',
    sender_principal_id: 'order-events',
    hoursOld: 23,
    subject_key: null,
    addressed: true,
  });
  await insertRow({
    id: 'cust-big',
    sender: 'order-events',
    sender_principal_id: 'order-events',
    hoursOld: 22,
    subject_key: null,
    body: BIG_30,
  });
  // K5: large bodies.
  await insertRow({
    id: 'big-650',
    sender: 'codex-session-audit',
    sender_principal_id: 'codex-session-audit',
    hoursOld: 21,
    subject_key: null,
    body: BIG_650,
  });
  await insertRow({
    id: 'big-30',
    sender: 'codex',
    sender_principal_id: 'codex',
    hoursOld: 20.5,
    subject_key: null,
    status: 'cancelled',
    body: BIG_30,
  });
  await insertRow({
    id: 'small-1',
    sender: 'codex',
    sender_principal_id: 'codex',
    hoursOld: 20.2,
    subject_key: null,
    body: SMALL_1,
  });
}

async function run(args: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const result = await runMailboxLifecycle(args, {
    now: () => NOW,
    out: line => out.push(line),
    err: line => err.push(line),
  });
  return { code: result.code, out, err };
}

function tokenOf(out: string[]): string {
  const line = out.find(item => item.startsWith('confirm_token: '));
  if (!line) throw new Error(`no confirm_token line in:\n${out.join('\n')}`);
  return line.slice('confirm_token: '.length).trim();
}

function classLine(out: string[], name: string): string {
  const line = out.find(item => item.startsWith(`class ${name}:`));
  if (!line) throw new Error(`no class ${name} line in:\n${out.join('\n')}`);
  return line;
}

async function tableChecksum(): Promise<string> {
  const rows = await db.query<Record<string, unknown>>(
    'SELECT * FROM agent_dispatch_messages ORDER BY id'
  );
  return createHash('sha256').update(JSON.stringify(rows.rows)).digest('hex');
}

async function row(id: string): Promise<Record<string, unknown>> {
  const result = await db.query<Record<string, unknown>>(
    'SELECT * FROM agent_dispatch_messages WHERE id = $1',
    [id]
  );
  return result.rows[0] ?? {};
}

function writeEvidence(minutesOld: number, usePercent: number, threshold = 85): string {
  const path = join(dir, `evidence-${String(minutesOld)}-${String(usePercent)}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      taken_at: new Date(NOW.getTime() - minutesOld * 60_000).toISOString(),
      host: 'ubuntu-8gb-hil-1',
      threshold_percent: threshold,
      df: [
        'Filesystem     1024-blocks      Used Available Capacity Mounted on',
        `/dev/sda1        80000000  ${String(usePercent * 800000)}  1000  ${String(usePercent)}% /`,
      ].join('\n'),
    })
  );
  return path;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mailbox-lifecycle-'));
  outDir = join(dir, 'out');
  db = new SqliteAdapter(join(dir, 'test.db'));
  await seedFixture();
});

afterEach(async () => {
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('mailbox-lifecycle script', () => {
  test('Test 8: the script is a dry run by default and changes no row', async () => {
    const before = await tableChecksum();
    const result = await run([]);
    expect(result.code).toBe(0);
    expect(await tableChecksum()).toBe(before);

    expect(result.out.some(line => line.includes('mode=dry-run'))).toBe(true);
    expect(classLine(result.out, 'backfill')).toContain('count=2');
    expect(classLine(result.out, 'backfill')).toContain('bf-1');
    expect(result.out.join('\n')).toContain('operator=1');
    expect(classLine(result.out, 'k1_collapse_dispatch')).toContain('count=2');
    expect(classLine(result.out, 'k2_collapse_system')).toContain('count=2');
    expect(classLine(result.out, 'k3_disk_alerts')).toContain('count=0');
    expect(classLine(result.out, 'k5_large_bodies')).toContain('count=2');
    expect(classLine(result.out, 'k5_large_bodies')).not.toContain('cust-big');
    const protectedLine = result.out.find(line => line.startsWith('protected k4_customer:'));
    expect(protectedLine).toContain('cust-1');
    expect(protectedLine).toContain('cust-2');
    const senders = result.out.find(line => line.startsWith('collapse_system_senders:'));
    expect(senders).toBe('collapse_system_senders: system:dispatch, system:taskmaster');
    expect(result.out).toContain('exhausted_subjectless_uncollapsed: 2');
    expect(tokenOf(result.out)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('Test 9: execute requires the reviewed set and journals each class', async () => {
    const dry = await run(['--out-dir', outDir]);
    const token = tokenOf(dry.out);
    const before = await tableChecksum();

    const missing = await run(['--execute', '--out-dir', outDir]);
    expect(missing.code).toBe(2);
    expect(missing.err.join('\n')).toContain('confirm_token_required');
    const wrong = await run(['--execute', '--confirm', 'f'.repeat(64), '--out-dir', outDir]);
    expect(wrong.code).toBe(2);
    expect(wrong.err.join('\n')).toContain('confirm_token_mismatch');
    expect(await tableChecksum()).toBe(before);

    const done = await run(['--execute', '--confirm', token, '--out-dir', outDir]);
    expect(done.code).toBe(0);

    const backfilled = await row('bf-1');
    expect(backfilled.status).toBe('done');
    expect(backfilled.completed_at).toBe(backfilled.addressed_at);
    expect((await row('bf-op-1')).status).toBe('queued');
    for (const id of ['k1-1', 'k1-2']) {
      const superseded = await row(id);
      expect(superseded.status).toBe('done');
      expect(superseded.route_disposition).toBe('superseded');
      expect(JSON.parse(String(superseded.result_body))).toEqual({
        reason: 'repeat',
        superseded_by: 'k1-3',
      });
    }
    expect((await row('k1-3')).status).toBe('queued');
    expect(JSON.parse(String((await row('k2-c-1')).result_body)).superseded_by).toBe('k2-c-2');
    for (const id of ['ack-1', 'wp-1', 'wp-2', 'ex-1', 'ex-2']) {
      expect((await row(id)).status).toBe('queued');
      expect((await row(id)).route_disposition).toBeNull();
    }

    const journal = await db.query<{
      idempotency_key: string;
      action_type: string;
      outcome: string;
      thread_ref: string | null;
      proposal_json: string;
    }>(
      "SELECT idempotency_key, action_type, outcome, thread_ref, proposal_json FROM tm_journal WHERE idempotency_key LIKE 'mailbox-lifecycle:%' ORDER BY idempotency_key"
    );
    expect(journal.rows.map(item => item.idempotency_key)).toEqual(
      ['backfill', 'k1_collapse_dispatch', 'k2_collapse_system', 'k5_large_bodies'].map(
        name => `mailbox-lifecycle:${name}:${token}`
      )
    );
    for (const item of journal.rows) {
      expect(item.action_type).toBe('digest');
      expect(item.outcome).toBe('expired');
      expect(item.thread_ref).not.toBeNull();
      expect(item.proposal_json).toContain(WO);
    }

    // The open-work list is a file for Taskmaster and the arc owners.
    const openWork = readFileSync(join(outDir, 'open-work-xo.txt'), 'utf8');
    expect(openWork).toContain(SUBJECT);
  });

  test('Test 9: a set that changed after the dry run is refused', async () => {
    const dry = await run(['--out-dir', outDir]);
    await insertRow({
      id: 'k1-late',
      sender: 'dispatch',
      sender_principal_id: 'system:dispatch',
      hoursOld: 1,
    });
    const before = await tableChecksum();
    const result = await run(['--execute', '--confirm', tokenOf(dry.out), '--out-dir', outDir]);
    expect(result.code).toBe(2);
    expect(result.err.join('\n')).toContain('confirm_token_mismatch');
    expect(await tableChecksum()).toBe(before);
  });

  test('Test 12: the executed collapse cancels nothing and every pointer names a real row', async () => {
    const dry = await run(['--out-dir', outDir]);
    expect(
      (await run(['--execute', '--confirm', tokenOf(dry.out), '--out-dir', outDir])).code
    ).toBe(0);
    const cancelled = await db.query<{ id: string }>(
      "SELECT id FROM agent_dispatch_messages WHERE status = 'cancelled'"
    );
    // Only the fixture's own pre-existing cancelled row.
    expect(cancelled.rows.map(item => item.id)).toEqual(['big-30']);
    const superseded = await db.query<{ status: string; result_body: string }>(
      "SELECT status, result_body FROM agent_dispatch_messages WHERE route_disposition = 'superseded'"
    );
    expect(superseded.rows).toHaveLength(4);
    for (const item of superseded.rows) {
      expect(item.status).toBe('done');
      const pointer = (JSON.parse(item.result_body) as { superseded_by: string }).superseded_by;
      expect((await row(pointer)).id).toBe(pointer);
    }
  });

  test('Test 4: the collapse never retires an open blocker for a newer lower-priority row', async () => {
    const MIXED = 'gh:example/repo#9';
    const TM = {
      sender: 'taskmaster',
      sender_principal_id: 'system:taskmaster',
      subject_key: MIXED,
    };
    // Group A: an older blocker followed only by normal rows.
    await insertRow({ ...TM, id: 'mp-blk', hoursOld: 30, priority: 'blocker' });
    await insertRow({ ...TM, id: 'mp-n1', hoursOld: 20 });
    await insertRow({ ...TM, id: 'mp-n2', hoursOld: 10 });
    const dry = await run(['--out-dir', outDir]);
    expect(
      (await run(['--execute', '--confirm', tokenOf(dry.out), '--out-dir', outDir])).code
    ).toBe(0);
    expect([(await row('mp-blk')).status, (await row('mp-blk')).route_disposition]).toEqual([
      'queued',
      null,
    ]);
    expect(JSON.parse(String((await row('mp-n1')).result_body))).toEqual({
      reason: 'repeat',
      superseded_by: 'mp-n2',
    });
    expect((await row('mp-n2')).status).toBe('queued');
  });

  test('Test 4: a normal row between blockers folds into the newest later normal row', async () => {
    const MIXED = 'gh:example/repo#10';
    const TM = {
      sender: 'taskmaster',
      sender_principal_id: 'system:taskmaster',
      subject_key: MIXED,
    };
    await insertRow({ ...TM, id: 'mq-n1', hoursOld: 30 });
    await insertRow({ ...TM, id: 'mq-b', hoursOld: 20, priority: 'blocker' });
    await insertRow({ ...TM, id: 'mq-n2', hoursOld: 10 });
    const dry = await run(['--out-dir', outDir]);
    expect(
      (await run(['--execute', '--confirm', tokenOf(dry.out), '--out-dir', outDir])).code
    ).toBe(0);
    expect(JSON.parse(String((await row('mq-n1')).result_body)).superseded_by).toBe('mq-n2');
    expect((await row('mq-b')).status).toBe('queued');
    expect((await row('mq-n2')).status).toBe('queued');
  });

  test('Test 8: worker-poll recipients are never collapsed', async () => {
    const result = await run(['--recipient', 'codex']);
    expect(result.code).toBe(0);
    expect(classLine(result.out, 'k1_collapse_dispatch')).toContain('count=0');
  });

  test('Test 10: protected and unproven rows are never touched', async () => {
    const customers = await Promise.all(['cust-1', 'cust-2', 'cust-bf', 'cust-big'].map(row));
    const seats = await Promise.all(['seat-1', 'seat-2'].map(row));

    // Missing evidence: the class does not run; the rows are listed.
    const noEvidence = await run(['--out-dir', outDir]);
    expect(classLine(noEvidence.out, 'k3_disk_alerts')).toContain('count=0');
    expect(noEvidence.out.join('\n')).toContain('k3_left_open: disk-1');
    expect(
      (await run(['--execute', '--confirm', tokenOf(noEvidence.out), '--out-dir', outDir])).code
    ).toBe(0);
    expect((await row('disk-1')).route_disposition).toBeNull();

    // Stale evidence (older than 15 minutes) and an above-threshold reading.
    for (const evidence of [writeEvidence(20, 70), writeEvidence(1, 91)]) {
      const dry = await run(['--evidence-file', evidence, '--out-dir', outDir]);
      expect(classLine(dry.out, 'k3_disk_alerts')).toContain('count=0');
      const exec = await run([
        '--execute',
        '--confirm',
        tokenOf(dry.out),
        '--evidence-file',
        evidence,
        '--out-dir',
        outDir,
      ]);
      expect(exec.code).toBe(0);
      expect((await row('disk-1')).route_disposition).toBeNull();
      expect((await row('disk-2')).route_disposition).toBeNull();
    }

    // A fresh reading below the threshold expires them, each with the evidence note.
    const fresh = writeEvidence(1, 70);
    const dry = await run(['--evidence-file', fresh, '--out-dir', outDir]);
    expect(classLine(dry.out, 'k3_disk_alerts')).toContain('count=2');
    const exec = await run([
      '--execute',
      '--confirm',
      tokenOf(dry.out),
      '--evidence-file',
      fresh,
      '--out-dir',
      outDir,
    ]);
    expect(exec.code).toBe(0);
    for (const id of ['disk-1', 'disk-2']) {
      const expired = await row(id);
      expect(expired.route_disposition).toBe('expired');
      expect(String(expired.result_body)).toContain('ubuntu-8gb-hil-1');
      expect(String(expired.result_body)).toContain('70%');
    }

    expect(await Promise.all(['cust-1', 'cust-2', 'cust-bf', 'cust-big'].map(row))).toEqual(
      customers
    );
    expect(await Promise.all(['seat-1', 'seat-2'].map(row))).toEqual(seats);
  });

  test('Test 11: large bodies are exported and verified before they are stubbed', async () => {
    const dry = await run(['--out-dir', outDir]);
    const result = await run(['--execute', '--confirm', tokenOf(dry.out), '--out-dir', outDir]);
    expect(result.code).toBe(0);

    const manifest = JSON.parse(
      readFileSync(join(outDir, 'large-bodies-manifest.json'), 'utf8')
    ) as { id: string; sender: string; bytes: number; sha256: string; file: string }[];
    expect(manifest.map(item => item.id).sort()).toEqual(['big-30', 'big-650']);
    for (const [id, body] of [
      ['big-650', BIG_650],
      ['big-30', BIG_30],
    ] as const) {
      const entry = manifest.find(item => item.id === id);
      const file = readFileSync(join(outDir, entry?.file ?? 'missing'));
      const sha = createHash('sha256').update(file).digest('hex');
      expect(sha).toBe(entry?.sha256 ?? '');
      expect(sha).toBe(createHash('sha256').update(body).digest('hex'));
      expect(JSON.parse(String((await row(id)).body))).toEqual({
        archived_to: `${id}.body`,
        sha256: sha,
        bytes: Buffer.byteLength(body),
      });
    }
    expect((await row('small-1')).body).toBe(SMALL_1);
    expect((await row('cust-big')).body).toBe(BIG_30);
  });

  test('Test 11: a failed export leaves every live body unchanged', async () => {
    const blocked = join(dir, 'not-a-directory');
    writeFileSync(blocked, 'a file where the export directory should be');
    const dry = await run(['--out-dir', blocked]);
    const before = await tableChecksum();
    const result = await run(['--execute', '--confirm', tokenOf(dry.out), '--out-dir', blocked]);
    expect(result.code).toBe(1);
    expect(result.err.join('\n')).toContain('k5_export_failed');
    expect(await tableChecksum()).toBe(before);
    expect(existsSync(join(blocked, 'big-650.body'))).toBe(false);
  });
});
