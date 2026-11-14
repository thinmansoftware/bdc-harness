/**
 * WO-HARNESS-T3-FIRE-RUN-OUTCOME-REPLY-01 (Amendment 2): the run outcome
 * message a T3 thread gets when the fire it started has ended.
 *
 * Tests 1-18 and 23 of the work order. The admission ledger is a real SQLite
 * adapter. The cascade record is a real file in a temporary directory, read by
 * the production extraction (readFireOutcome); only the run-row status and the
 * run's events are faked. Test 23 runs the REAL dispatch store behind the
 * production sendReply. Tests 9, 14, 15 and 16 build an old-shape SQLite file
 * with a raw connection and open it with the adapter.
 *
 * Test 1 drives the existing tickCauldronFireConsumer export, so before the
 * change it runs and fails on behaviour (no outcome sent), not on an import.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'crypto';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as realConnection from '@archon/core/db/connection';
import { SqliteAdapter } from '@archon/core/db/adapters/sqlite';
import type { IDatabase } from '@archon/core';

// Test 23 needs the real dispatch store on the test database. Every other
// caller of the connection module keeps the real one (testDb is null outside
// Test 23), so other files in this folder are unaffected.
let testDb: SqliteAdapter | null = null;
mock.module('@archon/core/db/connection', () => ({
  ...realConnection,
  getDatabase: () => testDb ?? realConnection.getDatabase(),
}));

import type { DispatchMessage } from '@archon/core/db/dispatch';
import * as consumer from './cauldron-fire-consumer';
import type { CauldronFireConsumerDeps } from './cauldron-fire-consumer';

const T0 = '2026-11-14T23:30:00.000Z';
const ACTOR = 't3-bridge';
const MAILBOX = 't3-desktop';

let db: SqliteAdapter;
let dbPath = '';
let recordDir = '';

function cleanupDb(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(path + suffix);
    } catch {
      /* file may not exist */
    }
  }
}

function newDbPath(tag: string): string {
  return join(tmpdir(), `fire-outcome-${tag}-${Date.now()}-${Math.random()}.db`);
}

// ---------------------------------------------------------------------------
// Cascade record files (the layout readCascadeRecord reads)
// ---------------------------------------------------------------------------

interface AttemptSpec {
  tier: string;
  runId: string | null;
  outcome: string;
}

function writeRecord(
  cascadeId: string,
  status: string,
  attempts: AttemptSpec[],
  extra: Record<string, unknown> = {}
): void {
  const digest = createHash('sha256').update(cascadeId).digest('hex').slice(0, 24);
  const dir = join(recordDir, `dispatch-${digest}`);
  mkdirSync(dir, { recursive: true });
  const winning = attempts.find(attempt => attempt.outcome === 'won');
  const record = {
    cascadeId,
    woId: 'WO-XO-EXAMPLE-01',
    project: 'bdc-xo',
    request: { woClass: 'CODE', tags: [], entryOverride: null, dryRun: false },
    createdAt: T0,
    status,
    winningTier: status === 'won' ? (winning?.tier ?? null) : null,
    attempts: attempts.map((attempt, index) => ({
      sourceEventId: `ev-${index}`,
      sourceEventAt: T0,
      tier: attempt.tier,
      workflowName: `bdc-feature-development-${attempt.tier}`,
      runId: attempt.runId,
      outcome: attempt.outcome,
      gateFailReason: null,
      infraErrorReason: null,
      servedModelId: null,
    })),
    ...extra,
  };
  writeFileSync(join(dir, 'cascade-record.json'), JSON.stringify(record));
}

function writeCorruptRecord(cascadeId: string): void {
  const digest = createHash('sha256').update(cascadeId).digest('hex').slice(0, 24);
  const dir = join(recordDir, `dispatch-${digest}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'cascade-record.json'), '{not json');
}

// ---------------------------------------------------------------------------
// Admission rows (base columns only, so the same helper works on any shape)
// ---------------------------------------------------------------------------

interface AdmissionSpec {
  requestId: string;
  verb?: string;
  state?: string;
  cascadeId?: string | null;
  runId?: string | null;
  threadId?: string | null;
  woId?: string | null;
  replyMessageId?: string | null;
  createdAt?: string;
}

async function insertAdmission(target: IDatabase, spec: AdmissionSpec): Promise<void> {
  await target.query(
    `INSERT INTO t3_command_admissions
      (request_id, actor_principal_id, verb, payload_sha256, wo_id, project, thread_id,
       source_message_id, state, status_code, code, cascade_id, run_id, reply_message_id,
       created_at, updated_at)
     VALUES ($1,$2,$3,'seed',$4,'bdc-xo',$5,$6,$7,200,'ok',$8,$9,$10,$11,$11)`,
    [
      spec.requestId,
      ACTOR,
      spec.verb ?? 'fire',
      spec.woId === undefined ? 'WO-XO-EXAMPLE-01' : spec.woId,
      spec.threadId === undefined ? `th-${spec.requestId}` : spec.threadId,
      `src-${spec.requestId}`,
      spec.state ?? 'admitted',
      spec.cascadeId === undefined ? `C-${spec.requestId}` : spec.cascadeId,
      spec.runId === undefined ? `R-${spec.requestId}` : spec.runId,
      spec.replyMessageId === undefined ? `rep-decision-${spec.requestId}` : spec.replyMessageId,
      spec.createdAt ?? T0,
    ]
  );
}

async function markerOf(target: IDatabase, requestId: string): Promise<string | null> {
  const result = await target.query<{ outcome_message_id: string | null }>(
    'SELECT outcome_message_id FROM t3_command_admissions WHERE request_id = $1',
    [requestId]
  );
  return result.rows[0]?.outcome_message_id ?? null;
}

// ---------------------------------------------------------------------------
// The test world: real ledger, fake transport, real extraction
// ---------------------------------------------------------------------------

interface SentRecord {
  recipient: string;
  correlationId: string;
  idempotencyKey: string;
  body: string;
  id: string;
  extraKeys: string[];
}

interface World {
  deps: CauldronFireConsumerDeps;
  sends: SentRecord[]; // every sendReply call, in order
  stored: Map<string, SentRecord>; // one per idempotency key
  runStatus: Map<string, string>;
  runEvents: Map<string, { event_type: string; step_name: string | null; data: unknown }[]>;
  mailboxResolves: boolean;
  failSendFor: Set<string>; // request ids whose sendReply throws
}

/** A db wrapper whose outcome-marker UPDATE fails the first `failures` times. */
function failingMarkerDb(inner: IDatabase, failures: number): IDatabase {
  let remaining = failures;
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'query') {
        return async (sql: string, params?: unknown[]) => {
          if (remaining > 0 && /SET\s+outcome_message_id/i.test(sql)) {
            remaining -= 1;
            throw new Error('injected_marker_write_failure');
          }
          return target.query(sql, params as never);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function makeWorld(ledger: IDatabase = db): World {
  const world: World = {
    deps: undefined as unknown as CauldronFireConsumerDeps,
    sends: [],
    stored: new Map(),
    runStatus: new Map(),
    runEvents: new Map(),
    mailboxResolves: true,
    failSendFor: new Set(),
  };
  const deps = {
    env: {},
    now: () => new Date(T0),
    db: ledger,
    listCommands: async () => [],
    sendReply: async (input: {
      recipient: string;
      correlationId: string;
      idempotencyKey: string;
      body: string;
    }) => {
      const extraKeys = Object.keys(input).filter(
        key => !['recipient', 'correlationId', 'idempotencyKey', 'body'].includes(key)
      );
      if (world.failSendFor.has(input.correlationId)) {
        throw new Error('injected_send_failure');
      }
      const existing = world.stored.get(input.idempotencyKey);
      const record: SentRecord = existing ?? {
        ...input,
        id: `out-${world.stored.size + 1}`,
        extraKeys,
      };
      if (!existing) world.stored.set(input.idempotencyKey, record);
      world.sends.push({ ...input, id: record.id, extraKeys });
      return { id: record.id } as DispatchMessage;
    },
    acknowledge: async () => undefined,
    resolveActorMailbox: (principal: string) =>
      world.mailboxResolves && principal === ACTOR ? MAILBOX : null,
    resolveProjectRepository: async () => undefined,
    hasLiveWorkflowRun: async () => ({ live: false, runId: null }),
    checkFireEligibility: async () => ({ eligible: false, reason: 'unused' }),
    fireCascade: async () => {
      throw new Error('fire_not_expected');
    },
    cancelRun: async () => {
      throw new Error('cancel_not_expected');
    },
    approveRun: async () => {
      throw new Error('approve_not_expected');
    },
    proveFireCustody: async () => null,
    readCascadeRunIds: async () => [],
    proveCancel: async () => false,
    proveApprove: async () => false,
    getRunApproval: async () => null,
    findRunsForWoSince: async () => [],
    alertOperator: async () => undefined,
    leaseHolder: 'outcome-test-holder',
    getRunRepository: async () => null,
    getRunBranch: async () => null,
    getPullRequest: async () => null,
    // The production extraction, against the temporary record directory.
    getFireOutcome: (row: Parameters<CauldronFireConsumerDeps['getFireOutcome']>[0]) =>
      consumer.readFireOutcome(row, {
        cascadeRecordDir: recordDir,
        getRunStatus: async (runId: string) => world.runStatus.get(runId) ?? null,
        listRunEvents: async (runId: string) => world.runEvents.get(runId) ?? [],
      }),
  };
  world.deps = deps as unknown as CauldronFireConsumerDeps;
  return world;
}

function prEvent(url: string): { event_type: string; step_name: string; data: unknown } {
  return {
    event_type: 'node_completed',
    step_name: 'open-pr-if-needed',
    data: { node_output: `ORIGIN_PRECONDITION_OK: x\nPR_URL=${url}\n` },
  };
}

function outcomeSends(world: World): SentRecord[] {
  return world.sends.filter(send => send.idempotencyKey.startsWith('outcome:'));
}

beforeEach(() => {
  dbPath = newDbPath('ledger');
  db = new SqliteAdapter(dbPath);
  recordDir = mkdtempSync(join(tmpdir(), 'fire-outcome-records-'));
});

afterEach(async () => {
  testDb = null;
  await db.close();
  cleanupDb(dbPath);
  rmSync(recordDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests 1-8, 10-13, 17, 18: the outcome pass
// ---------------------------------------------------------------------------

describe('Test 1: one outcome row for an ended fire', () => {
  test('won cascade -> one outcome send with the exact body, marker recorded', async () => {
    const world = makeWorld();
    await insertAdmission(db, { requestId: 'R1', threadId: 'T1', runId: 'X' });
    writeRecord('C-R1', 'won', [{ tier: 'codex', runId: 'X', outcome: 'won' }]);
    world.runStatus.set('X', 'completed');
    world.runEvents.set('X', [prEvent('https://github.com/thinmansoftware/bdc-xo/pull/101')]);

    await consumer.tickCauldronFireConsumer(world.deps);

    const sent = outcomeSends(world);
    expect(sent.length).toBe(1);
    const [send] = sent;
    expect(send.recipient).toBe(MAILBOX);
    expect(send.correlationId).toBe('R1');
    expect(send.idempotencyKey).toBe('outcome:R1');
    expect(send.extraKeys).toEqual([]);
    const body = JSON.parse(send.body) as Record<string, unknown>;
    expect(body).not.toHaveProperty('status');
    expect(body).toEqual({
      schema: 't3-command-reply/v1',
      request_id: 'R1',
      verb: 'fire',
      phase: 'outcome',
      code: 'cascade_won',
      task_outcome: 'won',
      cascade_id: 'C-R1',
      cascade_status: 'won',
      winning_tier: 'codex',
      attempts: 1,
      run_id: 'X',
      run_status: 'completed',
      pr_url: 'https://github.com/thinmansoftware/bdc-xo/pull/101',
      wo_id: 'WO-XO-EXAMPLE-01',
      thread_id: 'T1',
    });
    expect(await markerOf(db, 'R1')).toBe(send.id);
  });
});

describe('Test 2: sent once', () => {
  test('a second tick sends nothing more for the same fire', async () => {
    const world = makeWorld();
    await insertAdmission(db, { requestId: 'R1' });
    writeRecord('C-R1', 'won', [{ tier: 'codex', runId: 'R-R1', outcome: 'won' }]);
    await consumer.tickCauldronFireConsumer(world.deps);
    await consumer.tickCauldronFireConsumer(world.deps);
    expect(outcomeSends(world).length).toBe(1);
  });
});

describe('Test 3: a failed first run is not the fire ending', () => {
  test('cascade still running -> nothing sent, marker null', async () => {
    const world = makeWorld();
    await insertAdmission(db, { requestId: 'R3', runId: 'A' });
    world.runStatus.set('A', 'failed');
    writeRecord('C-R3', 'running', [{ tier: 'zero', runId: 'A', outcome: 'gate-failed' }]);
    await consumer.tickCauldronFireConsumer(world.deps);
    expect(outcomeSends(world).length).toBe(0);
    expect(await markerOf(db, 'R3')).toBeNull();
  });
});

describe('Test 4: tier climb reports the last run', () => {
  test('won on the second tier -> reports run B, its PR, attempts 2', async () => {
    const world = makeWorld();
    await insertAdmission(db, { requestId: 'R4', runId: 'A' });
    writeRecord('C-R4', 'won', [
      { tier: 'zero', runId: 'A', outcome: 'gate-failed' },
      { tier: 'codex', runId: 'B', outcome: 'won' },
    ]);
    world.runStatus.set('A', 'failed');
    world.runStatus.set('B', 'completed');
    world.runEvents.set('B', [prEvent('https://github.com/thinmansoftware/bdc-xo/pull/202')]);
    await consumer.tickCauldronFireConsumer(world.deps);
    const sent = outcomeSends(world);
    expect(sent.length).toBe(1);
    const body = JSON.parse(sent[0].body) as Record<string, unknown>;
    expect(body.run_id).toBe('B');
    expect(body.pr_url).toBe('https://github.com/thinmansoftware/bdc-xo/pull/202');
    expect(body.attempts).toBe(2);
    expect(body.winning_tier).toBe('codex');
    expect(sent.some(send => send.body.includes('"run_id":"A"'))).toBe(false);
  });
});

describe('Test 5: spec-repair with no PR', () => {
  test('code cascade_spec_repair, task_outcome spec-repair, pr_url null', async () => {
    const world = makeWorld();
    await insertAdmission(db, { requestId: 'R5' });
    writeRecord('C-R5', 'spec-repair', [
      { tier: 'frontier', runId: 'R-R5', outcome: 'gate-failed' },
    ]);
    await consumer.tickCauldronFireConsumer(world.deps);
    const sent = outcomeSends(world);
    expect(sent.length).toBe(1);
    const body = JSON.parse(sent[0].body) as Record<string, unknown>;
    expect(body.code).toBe('cascade_spec_repair');
    expect(body.task_outcome).toBe('spec-repair');
    expect(body.pr_url).toBeNull();
  });
});

describe('Test 6: approval pause and hand-off', () => {
  test('pending -> nothing; approved to running C2 -> nothing; C2 won -> one row for C2', async () => {
    const world = makeWorld();
    await insertAdmission(db, { requestId: 'R6' });
    writeRecord('C-R6', 'pending-frontier-approval', [
      { tier: 'codex', runId: 'R-R6', outcome: 'gate-failed' },
    ]);
    await consumer.tickCauldronFireConsumer(world.deps);
    expect(outcomeSends(world).length).toBe(0);

    writeRecord(
      'C-R6',
      'frontier-approved',
      [{ tier: 'codex', runId: 'R-R6', outcome: 'gate-failed' }],
      { frontierApproval: { resumeCascadeId: 'C2' } }
    );
    writeRecord('C2', 'running', []);
    await consumer.tickCauldronFireConsumer(world.deps);
    expect(outcomeSends(world).length).toBe(0);

    writeRecord('C2', 'won', [{ tier: 'frontier', runId: 'Z', outcome: 'won' }]);
    await consumer.tickCauldronFireConsumer(world.deps);
    const sent = outcomeSends(world);
    expect(sent.length).toBe(1);
    const body = JSON.parse(sent[0].body) as Record<string, unknown>;
    expect(body.run_id).toBe('Z');
    expect(body.cascade_id).toBe('C2');
    expect(body.cascade_status).toBe('won');
  });
});

describe('Test 7: unresolved mailbox', () => {
  test('null mailbox -> nothing sent or recorded; later resolves -> sent', async () => {
    const world = makeWorld();
    world.mailboxResolves = false;
    await insertAdmission(db, { requestId: 'R7' });
    writeRecord('C-R7', 'blocked', [{ tier: 'codex', runId: 'R-R7', outcome: 'gate-failed' }]);
    await consumer.tickCauldronFireConsumer(world.deps);
    expect(outcomeSends(world).length).toBe(0);
    expect(await markerOf(db, 'R7')).toBeNull();

    world.mailboxResolves = true;
    await consumer.tickCauldronFireConsumer(world.deps);
    expect(outcomeSends(world).length).toBe(1);
    expect(await markerOf(db, 'R7')).toBe(outcomeSends(world)[0].id);
  });
});

describe('Test 8: one failed send does not stop the pass', () => {
  test('first send throws -> tick survives, second fire sent and recorded', async () => {
    const world = makeWorld();
    await insertAdmission(db, { requestId: 'R8a', createdAt: '2026-11-14T23:00:00.000Z' });
    await insertAdmission(db, { requestId: 'R8b', createdAt: '2026-11-14T23:01:00.000Z' });
    writeRecord('C-R8a', 'won', [{ tier: 'codex', runId: 'R-R8a', outcome: 'won' }]);
    writeRecord('C-R8b', 'won', [{ tier: 'codex', runId: 'R-R8b', outcome: 'won' }]);
    world.failSendFor.add('R8a');
    await consumer.tickCauldronFireConsumer(world.deps);
    expect(await markerOf(db, 'R8a')).toBeNull();
    const sent = outcomeSends(world);
    expect(sent.map(send => send.correlationId)).toEqual(['R8b']);
    expect(await markerOf(db, 'R8b')).toBe(sent[0].id);
  });
});

describe('Test 10: only admitted fires with an ended record', () => {
  test('other verbs, other states and a missing record send nothing', async () => {
    const world = makeWorld();
    await insertAdmission(db, { requestId: 'V1', verb: 'cancel-own', woId: null });
    await insertAdmission(db, { requestId: 'V2', verb: 'approve', woId: null });
    await insertAdmission(db, { requestId: 'S1', state: 'refused', woId: 'WO-XO-OTHER-01' });
    await insertAdmission(db, { requestId: 'S2', state: 'unknown', woId: 'WO-XO-OTHER-02' });
    await insertAdmission(db, { requestId: 'M1', woId: 'WO-XO-OTHER-03' });
    for (const id of ['V1', 'V2', 'S1', 'S2']) {
      writeRecord(`C-${id}`, 'won', [{ tier: 'codex', runId: `R-${id}`, outcome: 'won' }]);
    }
    // M1 has no cascade record file at all.
    await consumer.tickCauldronFireConsumer(world.deps);
    expect(outcomeSends(world).length).toBe(0);
  });
});

describe('Test 11: O1 liveness, no starvation', () => {
  test('a fire whose decision send failed and a dead-lettered one each get one outcome', async () => {
    const world = makeWorld();
    await insertAdmission(db, { requestId: 'L1', replyMessageId: null });
    await insertAdmission(db, { requestId: 'L2', replyMessageId: null, woId: 'WO-XO-OTHER-04' });
    writeRecord('C-L1', 'won', [{ tier: 'codex', runId: 'R-L1', outcome: 'won' }]);
    writeRecord('C-L2', 'cancelled', [{ tier: 'codex', runId: 'R-L2', outcome: 'cancelled' }]);
    await consumer.tickCauldronFireConsumer(world.deps);
    const sent = outcomeSends(world);
    expect(sent.map(send => send.correlationId).sort()).toEqual(['L1', 'L2']);
    expect(await markerOf(db, 'L1')).not.toBeNull();
    expect(await markerOf(db, 'L2')).not.toBeNull();
  });
});

describe('Tests 12 and 17: identity across a marker failure (fake store)', () => {
  test('marker write fails once -> same id on retry, marker set, third tick sends nothing', async () => {
    const world = makeWorld(failingMarkerDb(db, 1));
    await insertAdmission(db, { requestId: 'I1' });
    writeRecord('C-I1', 'won', [{ tier: 'codex', runId: 'R-I1', outcome: 'won' }]);

    // Test 12, tick 1: one stored row under the outcome key; marker still null.
    await consumer.tickCauldronFireConsumer(world.deps);
    expect([...world.stored.keys()]).toEqual(['outcome:I1']);
    expect(await markerOf(db, 'I1')).toBeNull();

    // Test 12, tick 2: the same id comes back; still one key, one stored row.
    await consumer.tickCauldronFireConsumer(world.deps);
    const sent = outcomeSends(world);
    expect(sent.length).toBe(2);
    expect(sent[1].id).toBe(sent[0].id);
    expect(world.stored.size).toBe(1);

    // Test 17: the marker now equals that id, and a third tick makes no send.
    expect(await markerOf(db, 'I1')).toBe(sent[0].id);
    await consumer.tickCauldronFireConsumer(world.deps);
    expect(outcomeSends(world).length).toBe(2);
  });
});

describe('Test 13: an unreadable record is isolated per row', () => {
  test('corrupt record on the first fire -> second fire still sent and recorded', async () => {
    const world = makeWorld();
    await insertAdmission(db, { requestId: 'U1', createdAt: '2026-11-14T23:00:00.000Z' });
    await insertAdmission(db, {
      requestId: 'U2',
      createdAt: '2026-11-14T23:01:00.000Z',
      woId: 'WO-XO-OTHER-05',
    });
    writeCorruptRecord('C-U1');
    writeRecord('C-U2', 'won', [{ tier: 'codex', runId: 'R-U2', outcome: 'won' }]);
    await consumer.tickCauldronFireConsumer(world.deps);
    expect(await markerOf(db, 'U1')).toBeNull();
    const sent = outcomeSends(world);
    expect(sent.map(send => send.correlationId)).toEqual(['U2']);
    expect(await markerOf(db, 'U2')).toBe(sent[0].id);
  });
});

describe('Test 18: real approval sequence', () => {
  test('original pending while C2 already won -> nothing; original approved -> one row for C2', async () => {
    const world = makeWorld();
    await insertAdmission(db, { requestId: 'A1' });
    writeRecord('C-A1', 'pending-frontier-approval', [
      { tier: 'codex', runId: 'R-A1', outcome: 'gate-failed' },
    ]);
    writeRecord('C2-A1', 'won', [{ tier: 'frontier', runId: 'Z1', outcome: 'won' }]);
    await consumer.tickCauldronFireConsumer(world.deps);
    expect(outcomeSends(world).length).toBe(0);

    writeRecord(
      'C-A1',
      'frontier-approved',
      [{ tier: 'codex', runId: 'R-A1', outcome: 'gate-failed' }],
      { frontierApproval: { resumeCascadeId: 'C2-A1' } }
    );
    await consumer.tickCauldronFireConsumer(world.deps);
    const sent = outcomeSends(world);
    expect(sent.length).toBe(1);
    const body = JSON.parse(sent[0].body) as Record<string, unknown>;
    expect(body.run_id).toBe('Z1');
    expect(body.cascade_id).toBe('C2-A1');
  });
});

// ---------------------------------------------------------------------------
// Tests 9, 14, 15, 16: the SQLite migration (old-shape files, raw connection)
// ---------------------------------------------------------------------------

const OLD_T3_TABLE = `
  CREATE TABLE t3_command_admissions (
    request_id TEXT PRIMARY KEY,
    actor_principal_id TEXT NOT NULL,
    verb TEXT NOT NULL CHECK (verb IN ('fire','cancel-own','approve')),
    payload_sha256 TEXT NOT NULL,
    wo_id TEXT,
    project TEXT,
    target_run_id TEXT,
    pr_ref TEXT,
    head_sha TEXT,
    thread_id TEXT,
    source_message_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('reserved','admitted','refused','unknown')),
    status_code INTEGER,
    code TEXT,
    cascade_id TEXT,
    run_id TEXT,
    reply_message_id TEXT,
    effect_started_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;

function buildOldShapeFile(path: string, withFault: boolean): void {
  const raw = new Database(path);
  raw.run('PRAGMA journal_mode = WAL');
  raw.run(OLD_T3_TABLE);
  raw.run(
    `INSERT INTO t3_command_admissions
      (request_id, actor_principal_id, verb, payload_sha256, wo_id, project, thread_id,
       source_message_id, state, status_code, code, cascade_id, run_id, reply_message_id,
       created_at, updated_at)
     VALUES ('OLD1','t3-bridge','fire','seed','WO-XO-OLD-01','bdc-xo','th-old','src-old',
             'admitted',200,'ok','C-OLD1','R-OLD1','rep-old','${T0}','${T0}')`
  );
  if (withFault) {
    // A DATABASE-SCHEMA trigger, visible to the adapter's own connection.
    raw.run(
      `CREATE TRIGGER t3_outcome_fault BEFORE UPDATE ON t3_command_admissions
       BEGIN SELECT RAISE(ABORT, 'outcome_backfill_fault'); END`
    );
  }
  raw.close();
}

function rawColumns(path: string): string[] {
  const raw = new Database(path);
  const columns = (
    raw.query("PRAGMA table_info('t3_command_admissions')").all() as {
      name: string;
    }[]
  ).map(column => column.name);
  raw.close();
  return columns;
}

function rawOldRow(path: string): Record<string, unknown> {
  const raw = new Database(path);
  const row = raw
    .query(
      `SELECT request_id, actor_principal_id, verb, payload_sha256, wo_id, project, thread_id,
              source_message_id, state, status_code, code, cascade_id, run_id,
              reply_message_id, created_at, updated_at
         FROM t3_command_admissions WHERE request_id = 'OLD1'`
    )
    .get() as Record<string, unknown>;
  raw.close();
  return row;
}

describe('Tests 9, 14, 15: migration fault, clean retry, double open', () => {
  test('fault refuses the open and changes nothing; retry backfills; reopen leaves new fires alone', async () => {
    const path = newDbPath('migration');
    try {
      buildOldShapeFile(path, true);
      const before = rawOldRow(path);

      // Test 9: the adapter's own backfill hits the trigger; the open is refused.
      let thrown: unknown = null;
      try {
        const adapter = new SqliteAdapter(path);
        await adapter.close();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).not.toBeNull();
      expect(String((thrown as Error).message)).toContain('outcome_backfill_fault');
      expect(rawColumns(path)).not.toContain('outcome_message_id');
      expect(rawOldRow(path)).toEqual(before);

      // Test 14: drop the trigger through a raw connection; the open succeeds.
      const raw = new Database(path);
      raw.run('DROP TRIGGER t3_outcome_fault');
      raw.close();
      const first = new SqliteAdapter(path);
      expect(await markerOf(first, 'OLD1')).toBe('pre-outcome-backfill');

      // Test 15: a new fire stays null across a second open and gets its outcome.
      await insertAdmission(first, { requestId: 'NEW1', woId: 'WO-XO-NEW-01' });
      await first.close();
      const second = new SqliteAdapter(path);
      try {
        expect(await markerOf(second, 'NEW1')).toBeNull();
        expect(await markerOf(second, 'OLD1')).toBe('pre-outcome-backfill');
        writeRecord('C-NEW1', 'won', [{ tier: 'codex', runId: 'R-NEW1', outcome: 'won' }]);
        writeRecord('C-OLD1', 'won', [{ tier: 'codex', runId: 'R-OLD1', outcome: 'won' }]);
        const world = makeWorld(second);
        await consumer.tickCauldronFireConsumer(world.deps);
        const sent = outcomeSends(world);
        expect(sent.map(send => send.correlationId)).toEqual(['NEW1']);
        expect(await markerOf(second, 'NEW1')).toBe(sent[0].id);
      } finally {
        await second.close();
      }
    } finally {
      cleanupDb(path);
    }
  }, 60000);
});

describe('Test 16: lock failure refuses the open', () => {
  test('another connection holds the write lock past the busy timeout -> open throws, column absent', async () => {
    const path = newDbPath('lock');
    try {
      buildOldShapeFile(path, false);
      const holder = new Database(path);
      holder.run('BEGIN IMMEDIATE');
      let thrown: unknown = null;
      try {
        const adapter = new SqliteAdapter(path);
        await adapter.close();
      } catch (error) {
        thrown = error;
      }
      holder.run('ROLLBACK');
      holder.close();
      expect(thrown).not.toBeNull();
      expect(rawColumns(path)).not.toContain('outcome_message_id');
    } finally {
      cleanupDb(path);
    }
  }, 120000);
});

// ---------------------------------------------------------------------------
// Test 23: the real SQLite Dispatch store behind the production sendReply
// ---------------------------------------------------------------------------

const PRINCIPALS_ENV = {
  DISPATCH_PRINCIPALS_JSON: JSON.stringify([
    {
      credential_id: 't3-bridge-1',
      principal_id: ACTOR,
      token_sha256: 'a'.repeat(64),
      status: 'active',
      send_as: [ACTOR],
      receive_as: [MAILBOX],
      roles: ['send', 'receive'],
    },
  ]),
};

describe('Test 23: real Dispatch store, outcome identity', () => {
  test('marker fails once after the durable enqueue -> same row id, marker set, third tick sends nothing', async () => {
    testDb = db;
    const real = consumer.createRealCauldronFireConsumerDeps(
      PRINCIPALS_ENV,
      (async () => new Response('unused', { status: 500 })) as unknown as typeof fetch
    );
    let sendCalls = 0;
    const deps: CauldronFireConsumerDeps = {
      ...real,
      db: failingMarkerDb(db, 1),
      now: () => new Date(T0),
      leaseHolder: 'outcome-test-holder',
      sendReply: async input => {
        sendCalls += 1;
        return real.sendReply(input);
      },
      getFireOutcome: row =>
        consumer.readFireOutcome(row, {
          cascadeRecordDir: recordDir,
          getRunStatus: async () => 'completed',
          listRunEvents: async () => [],
        }),
    };
    await insertAdmission(db, { requestId: 'D1' });
    writeRecord('C-D1', 'won', [{ tier: 'codex', runId: 'R-D1', outcome: 'won' }]);

    const rowsFor = async () =>
      (
        await db.query<{ id: string; sender_principal_id: string | null; recipient: string }>(
          `SELECT id, sender_principal_id, recipient FROM agent_dispatch_messages
            WHERE idempotency_key = 'outcome:D1'`
        )
      ).rows;

    await consumer.tickCauldronFireConsumer(deps);
    const afterFirst = await rowsFor();
    expect(afterFirst.length).toBe(1);
    expect(afterFirst[0].recipient).toBe(MAILBOX);
    expect(afterFirst[0].sender_principal_id).toBe('system:cauldron-fire');
    expect(await markerOf(db, 'D1')).toBeNull();

    await consumer.tickCauldronFireConsumer(deps);
    const afterSecond = await rowsFor();
    expect(afterSecond.length).toBe(1);
    expect(afterSecond[0].id).toBe(afterFirst[0].id);
    expect(await markerOf(db, 'D1')).toBe(afterFirst[0].id);
    expect(sendCalls).toBe(2);

    await consumer.tickCauldronFireConsumer(deps);
    expect((await rowsFor()).length).toBe(1);
    expect(sendCalls).toBe(2);
  });
});
