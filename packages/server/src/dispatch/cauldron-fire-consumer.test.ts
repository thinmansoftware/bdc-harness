/**
 * cauldron-fire command consumer tests -- WO-HARNESS-T3-COMMAND-CONSUMER-01.
 *
 * Section 11 scenarios covered here (fakes count calls; the admission ledger is
 * a real SQLite adapter so dedupe, the fire lock, and ownership are exercised
 * against the actual DAL, not a reimplementation):
 *   1 fire admitted once and replied
 *   2 double fire returns the first run id
 *   3 live run refused server-side
 *   4 cancel of another principal's run returns 403
 *   5 approve bound server-side to actor's own run, repo, PR and exact head
 *   6 validation refuses before anything executes
 *   7 conflicts are answered even after the original reply exists
 *   8 crash safety
 *   10 disabled by default
 *
 * Test 9 (principal issuance + route blast radius) lives in
 * api.t3-bridge-principal.test.ts -- it needs the real HTTP app.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SqliteAdapter } from '@archon/core/db/adapters/sqlite';
import type { DispatchMessage } from '@archon/core/db/dispatch';
import * as admissions from '@archon/core/db/t3-command-admissions';
import {
  type CauldronFireConsumerDeps,
  type PullRequestIdentity,
  type T3Command,
  processCommand,
  recoverStaleReservations,
  startCauldronFireConsumer,
  stopCauldronFireConsumer,
  cauldronFireConsumerEnabled,
  canonicalDigest,
  fireCascadeUntilRunDiscovered,
  tickCauldronFireConsumer,
} from './cauldron-fire-consumer';

const T0 = '2026-11-02T13:24:05.000Z';
const SHA_STALE = '1'.repeat(40);
const SHA_CURRENT = '2'.repeat(40);
const SHA_LSPRO = '3'.repeat(40);

let db: SqliteAdapter;
let dbPath = '';

function cleanupDb(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(path + suffix);
    } catch {
      /* file may not exist */
    }
  }
}

interface ReplyRecord {
  recipient: string;
  correlationId: string;
  idempotencyKey: string;
  body: string;
  id: string;
}

interface World {
  deps: CauldronFireConsumerDeps;
  queue: DispatchMessage[];
  acked: string[];
  replies: ReplyRecord[]; // one per distinct idempotency key
  replyById: Map<string, ReplyRecord>;
  events: string[]; // ordered log of 'reply:<key>' and 'ack:<id>'
  calls: { fire: number; cancel: number; approve: number };
  fireResults: Map<string, { cascadeId: string; status: string; runId: string | null }>;
  liveRuns: Map<string, string>; // woId -> live run id
  eligible: boolean;
  cancelResult: (
    runId: string
  ) => { ok: true; run: unknown } | { ok: false; status: 400 | 404 | 409 | 422; message: string };
  cancelActors: string[];
  runRepos: Map<string, string>;
  runBranches: Map<string, string>;
  projectRepos: Map<string, string | null | undefined>;
  prs: Map<string, PullRequestIdentity | null>;
  approveResult:
    | { ok: true; kind: 'approved'; workflowName: string; autoResumed: boolean }
    | { ok: false; status: 400 | 404; message: string };
  fireCustody: Map<string, { runId: string; cascadeId: string | null; runIds: string[] }>;
  cascadeRuns: Map<string, string[]>; // cascadeId -> run ids (custody fallback)
  cascadeReads: number;
  cancelledBy: Map<string, string>; // runId -> actor
  approvedRuns: Set<string>;
}

function makeWorld(env: Record<string, string | undefined>): World {
  const world: World = {
    deps: undefined as unknown as CauldronFireConsumerDeps,
    queue: [],
    acked: [],
    replies: [],
    replyById: new Map(),
    events: [],
    calls: { fire: 0, cancel: 0, approve: 0 },
    fireResults: new Map(),
    liveRuns: new Map(),
    eligible: true,
    cancelResult: () => ({ ok: true, run: {} }),
    cancelActors: [],
    runRepos: new Map(),
    runBranches: new Map(),
    projectRepos: new Map(),
    prs: new Map(),
    approveResult: { ok: true, kind: 'approved', workflowName: 'wf', autoResumed: true },
    fireCustody: new Map(),
    cascadeRuns: new Map(),
    cascadeReads: 0,
    cancelledBy: new Map(),
    approvedRuns: new Set(),
  };

  world.deps = {
    env,
    now: () => new Date(T0),
    db,
    listCommands: async (recipient, limit) =>
      world.queue
        .filter(m => m.recipient === recipient && !world.acked.includes(m.id))
        .slice(0, limit),
    sendReply: async input => {
      const existing = world.replyById.get(input.idempotencyKey);
      if (existing) {
        world.events.push(`reply:${input.idempotencyKey}`);
        return { id: existing.id } as DispatchMessage;
      }
      const record: ReplyRecord = { ...input, id: `rep-${world.replies.length + 1}` };
      world.replies.push(record);
      world.replyById.set(input.idempotencyKey, record);
      world.events.push(`reply:${input.idempotencyKey}`);
      return { id: record.id } as DispatchMessage;
    },
    acknowledge: async messageId => {
      world.acked.push(messageId);
      world.events.push(`ack:${messageId}`);
    },
    resolveActorMailbox: principalOrSender =>
      principalOrSender ? `${principalOrSender}-mbox` : null,
    resolveProjectRepository: async project => world.projectRepos.get(project),
    hasLiveWorkflowRun: async woId => {
      const runId = world.liveRuns.get(woId);
      return runId ? { live: true, runId } : { live: false, runId: null };
    },
    checkFireEligibility: async () => ({ eligible: world.eligible, reason: 'spec_missing' }),
    fireCascade: async input => {
      world.calls.fire += 1;
      const result = world.fireResults.get(input.woId) ?? {
        cascadeId: `C-${input.woId}`,
        status: 'running',
        runId: `R-${input.woId}`,
      };
      // A successful fire produces a live workflow run that names this WO (the
      // real `remote_agent_workflow_runs` row). Model it so a subsequent fire
      // for the same WO is blocked by hasLiveWorkflowRun -- not by a historical
      // `admitted` admission, which must NOT block once its run completes.
      if (result.runId) world.liveRuns.set(input.woId, result.runId);
      if (result.runId) input.onRunDiscovered?.(result.runId, 'tier-1');
      return result;
    },
    cancelRun: async (runId, opts) => {
      world.calls.cancel += 1;
      world.cancelActors.push(opts.actor);
      return world.cancelResult(runId) as never;
    },
    approveRun: async () => {
      world.calls.approve += 1;
      return world.approveResult as never;
    },
    getRunRepository: async runId => world.runRepos.get(runId) ?? null,
    getRunBranch: async runId => world.runBranches.get(runId) ?? null,
    getPullRequest: async (repo, number) => world.prs.get(`${repo}#${number}`) ?? null,
    proveFireCustody: async row => world.fireCustody.get(row.request_id) ?? null,
    readCascadeRunIds: async cascadeId => {
      world.cascadeReads += 1;
      return world.cascadeRuns.get(cascadeId) ?? [];
    },
    proveCancel: async (runId, actor) => world.cancelledBy.get(runId) === actor,
    proveApprove: async runId => world.approvedRuns.has(runId),
  };
  return world;
}

function cmdBody(
  cmd: Partial<T3Command> & { request_id: string; verb: string; project: string }
): string {
  return JSON.stringify({ schema: 't3-command/v1', thread_id: 'th-1', ...cmd });
}

let msgSeq = 0;
function makeMessage(overrides: {
  id?: string;
  sender?: string | null;
  principal?: string | null;
  idempotencyKey: string;
  body: string;
}): DispatchMessage {
  msgSeq += 1;
  const id = overrides.id ?? `cmd-${msgSeq}`;
  return {
    id,
    correlation_id: overrides.idempotencyKey,
    idempotency_key: overrides.idempotencyKey,
    task_type: 'agent_message',
    sender: overrides.sender === undefined ? 't3-bridge' : (overrides.sender ?? ''),
    sender_principal_id: overrides.principal === undefined ? 't3-bridge' : overrides.principal,
    recipient: 'cauldron-fire',
    body: overrides.body,
    status: 'queued',
    result_body: null,
    created_at: T0,
    claimed_at: null,
    completed_at: null,
    not_before: null,
    lease_owner: null,
    lease_expires_at: null,
    fencing_token: 0,
    recipient_alias: null,
    motion_id: null,
    motion_revision_sha: null,
    resolved_recipient: null,
    resolved_xo_lease_id: null,
    resolved_xo_fencing_token: null,
    resolved_at: null,
    priority: 'normal',
    task_outcome: null,
    acknowledged_at: null,
    acknowledged_by: null,
    addressed_at: null,
    addressed_by: null,
    escalated_tg_at: null,
    escalated_sms_at: null,
    subject_key: null,
    route_disposition: null,
    route_disposed_at: null,
    supersedes_id: null,
    repeat_reason: null,
  };
}

const BASE_ENV = {
  T3_COMMAND_ACTORS: 't3-bridge,p2',
  T3_COMMAND_PROJECTS: 'bdc-harness,lspro-react',
  T3_COMMAND_APPROVE_BASES: 'thinmansoftware/bdc-harness:dev',
};

function parseReply(record: ReplyRecord): {
  status: number;
  code: string;
  run_id: string | null;
  cascade_id: string | null;
} {
  return JSON.parse(record.body) as {
    status: number;
    code: string;
    run_id: string | null;
    cascade_id: string | null;
  };
}

/** Seed an admitted fire admission (a prior fire the actor made through the consumer). */
async function seedAdmittedFire(
  actor: string,
  woId: string,
  runId: string,
  requestId: string
): Promise<void> {
  await admissions.reserveAdmission(
    {
      request_id: requestId,
      actor_principal_id: actor,
      verb: 'fire',
      payload_sha256: 'seed',
      wo_id: woId,
      project: 'bdc-harness',
      source_message_id: `seed-${requestId}`,
      now: T0,
    },
    db
  );
  await admissions.markAdmitted(
    requestId,
    { status_code: 200, code: 'ok', cascade_id: `C-${woId}`, run_id: runId, now: T0 },
    db
  );
}

beforeEach(() => {
  dbPath = join(tmpdir(), `cauldron-fire-${Date.now()}-${Math.random()}.db`);
  db = new SqliteAdapter(dbPath);
  msgSeq = 0;
});

afterEach(async () => {
  stopCauldronFireConsumer();
  await db.close();
  cleanupDb(dbPath);
});

describe('Test 1: fire admitted once and replied', () => {
  test('one fire -> one cascade, admitted admission, 200 reply, ack after reply', async () => {
    const world = makeWorld({ ...BASE_ENV });
    world.projectRepos.set('bdc-harness', 'thinmansoftware/bdc-harness');
    world.fireResults.set('WO-A', { cascadeId: 'C1', status: 'running', runId: 'R1' });
    const message = makeMessage({
      idempotencyKey: 'Q1',
      body: cmdBody({ request_id: 'Q1', verb: 'fire', wo_id: 'WO-A', project: 'bdc-harness' }),
    });
    world.queue.push(message);

    await processCommand(world.deps, message);

    expect(world.calls.fire).toBe(1);
    const row = await admissions.getByRequestId('Q1', db);
    expect(row?.state).toBe('admitted');
    expect(row?.cascade_id).toBe('C1');
    expect(row?.run_id).toBe('R1');
    expect(world.replies).toHaveLength(1);
    const reply = parseReply(world.replies[0]);
    expect(reply.status).toBe(200);
    expect(reply.run_id).toBe('R1');
    expect(world.replies[0].recipient).toBe('t3-bridge-mbox');
    expect(world.replies[0].correlationId).toBe('Q1');
    // ack after the reply exists
    expect(world.events).toEqual(['reply:reply:cmd-1', 'ack:cmd-1']);
  });
});

describe('Test 2: double fire returns the first run id', () => {
  test('re-processing the same row never fires twice and replays R1', async () => {
    const world = makeWorld({ ...BASE_ENV });
    world.projectRepos.set('bdc-harness', 'thinmansoftware/bdc-harness');
    world.fireResults.set('WO-A', { cascadeId: 'C1', status: 'running', runId: 'R1' });
    const message = makeMessage({
      idempotencyKey: 'Q1',
      body: cmdBody({ request_id: 'Q1', verb: 'fire', wo_id: 'WO-A', project: 'bdc-harness' }),
    });

    await processCommand(world.deps, message); // first admission
    // retry while running
    await processCommand(world.deps, message);
    // retry after completion (no live run guard needed -- replay short-circuits)
    await processCommand(world.deps, message);

    expect(world.calls.fire).toBe(1);
    expect(world.replies).toHaveLength(1); // same reply identity, deduped
    for (const reply of world.replies) {
      const parsed = parseReply(reply);
      expect(parsed.status).toBe(200);
      expect(parsed.run_id).toBe('R1');
    }
  });
});

describe('Test 3: live run refused server-side', () => {
  test('existing workflow run blocks fire; concurrent distinct requests admit exactly one', async () => {
    const world = makeWorld({ ...BASE_ENV });
    world.projectRepos.set('bdc-harness', 'thinmansoftware/bdc-harness');
    world.liveRuns.set('WO-A', 'existing-run-A');
    world.fireResults.set('WO-B', { cascadeId: 'CB', status: 'running', runId: 'RB' });

    const q2 = makeMessage({
      idempotencyKey: 'Q2',
      body: cmdBody({ request_id: 'Q2', verb: 'fire', wo_id: 'WO-A', project: 'bdc-harness' }),
    });
    await processCommand(world.deps, q2);

    expect(world.calls.fire).toBe(0);
    const q2Reply = parseReply(world.replies[world.replies.length - 1]);
    expect(q2Reply.status).toBe(409);
    expect(q2Reply.code).toBe('live_run');
    expect(q2Reply.run_id).toBe('existing-run-A');

    const q3 = makeMessage({
      idempotencyKey: 'Q3',
      body: cmdBody({ request_id: 'Q3', verb: 'fire', wo_id: 'WO-B', project: 'bdc-harness' }),
    });
    const q4 = makeMessage({
      idempotencyKey: 'Q4',
      body: cmdBody({ request_id: 'Q4', verb: 'fire', wo_id: 'WO-B', project: 'bdc-harness' }),
    });
    await processCommand(world.deps, q3);
    await processCommand(world.deps, q4);

    expect(world.calls.fire).toBe(1); // exactly one WO-B fire
    const q3Row = await admissions.getByRequestId('Q3', db);
    const q4Row = await admissions.getByRequestId('Q4', db);
    const states = [q3Row?.state, q4Row?.state].sort();
    expect(states).toEqual(['admitted', 'refused']);
    const refusedRow = q3Row?.state === 'refused' ? q3Row : q4Row;
    expect(refusedRow?.code).toBe('live_run');
  });
});

describe('Test 3b: a completed fire (admitted, run no longer live) does not block a fresh fire', () => {
  test('after the prior run has completed, a new fire for the same WO is admitted', async () => {
    const world = makeWorld({ ...BASE_ENV });
    world.projectRepos.set('bdc-harness', 'thinmansoftware/bdc-harness');
    // A prior fire was admitted; its run has since completed, so it is NOT in
    // liveRuns. The admission row persists forever (rows are never deleted).
    await seedAdmittedFire('t3-bridge', 'WO-DONE', 'R-OLD', 'OLD');

    const q = makeMessage({
      idempotencyKey: 'NEW',
      body: cmdBody({ request_id: 'NEW', verb: 'fire', wo_id: 'WO-DONE', project: 'bdc-harness' }),
    });
    await processCommand(world.deps, q);

    // The historical admitted row must not masquerade as a live fire.
    expect(world.calls.fire).toBe(1);
    const reply = parseReply(world.replies[world.replies.length - 1]);
    expect(reply.status).toBe(200);
    expect(reply.code).toBe('ok');
    const row = await admissions.getByRequestId('NEW', db);
    expect(row?.state).toBe('admitted');
  });
});

describe('Test 3c: a cascade that returns no run id is not replied as success', () => {
  test('null run id -> unknown admission, in-contract 409, cascade id retained', async () => {
    const world = makeWorld({ ...BASE_ENV });
    world.projectRepos.set('bdc-harness', 'thinmansoftware/bdc-harness');
    world.fireResults.set('WO-NORUN', { cascadeId: 'CX', status: 'running', runId: null });

    const q = makeMessage({
      idempotencyKey: 'NR',
      body: cmdBody({ request_id: 'NR', verb: 'fire', wo_id: 'WO-NORUN', project: 'bdc-harness' }),
    });
    await processCommand(world.deps, q);

    // Reply contract (runbook): status is one of 200/400/403/409/422 and an
    // unproven admission is 409 admission_unknown -- never a 5xx.
    const reply = parseReply(world.replies[world.replies.length - 1]);
    expect(reply.status).toBe(409);
    expect(reply.code).toBe('admission_unknown');
    expect(reply.run_id).toBeNull();
    // The cascade id WAS observed, so it is durably recorded for adjudication.
    expect(reply.cascade_id).toBe('CX');
    const row = await admissions.getByRequestId('NR', db);
    expect(row?.state).toBe('unknown');
    expect(row?.status_code).toBe(409);
    expect(row?.code).toBe('admission_unknown');
    expect(row?.cascade_id).toBe('CX');
    expect(row?.run_id).toBeNull();
  });
});

describe('Test 3d: a persistence failure after an executed cascade is reconciled, never refused', () => {
  test('markAdmitted failure -> unknown (not refused), so the WO is never released for a refire', async () => {
    const world = makeWorld({ ...BASE_ENV });
    world.projectRepos.set('bdc-harness', 'thinmansoftware/bdc-harness');
    world.fireResults.set('WO-A', { cascadeId: 'C1', status: 'running', runId: 'R1' });
    // Fail ONLY the write that persists the admitted outcome; reads and the
    // unknown-reconciliation write still succeed.
    const realDb = db;
    world.deps.db = new Proxy(realDb, {
      get(target, prop, receiver): unknown {
        if (prop === 'query') {
          return async (sql: string, params?: unknown[]): Promise<unknown> => {
            if (typeof sql === 'string' && sql.includes("state = 'admitted'")) {
              throw new Error('persist boom');
            }
            return target.query(sql, params as never);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as typeof realDb;

    const q = makeMessage({
      idempotencyKey: 'PF',
      body: cmdBody({ request_id: 'PF', verb: 'fire', wo_id: 'WO-A', project: 'bdc-harness' }),
    });
    await processCommand(world.deps, q);

    // The cascade executed exactly once and must NOT be refused.
    expect(world.calls.fire).toBe(1);
    // In-contract unknown reply (never a 5xx), carrying the executed run.
    const reply = parseReply(world.replies[world.replies.length - 1]);
    expect(reply.status).toBe(409);
    expect(reply.code).toBe('admission_unknown');
    expect(reply.run_id).toBe('R1');
    expect(reply.cascade_id).toBe('C1');
    const row = await admissions.getByRequestId('PF', db);
    expect(row?.state).toBe('unknown');
    expect(row?.state).not.toBe('refused');
    // Durable request/run identity: the executed cascade's ids survive the
    // failed admitted-write, so the ledger still knows which run this request owns.
    expect(row?.run_id).toBe('R1');
    expect(row?.cascade_id).toBe('C1');

    // Retry semantics: a later retry of the SAME request_id (new message row, so
    // a new reply identity) replays the original outcome AND the original run
    // identity -- never null, and never a second fire.
    const retry = makeMessage({
      id: 'cmd-pf-retry',
      idempotencyKey: 'PF',
      body: cmdBody({ request_id: 'PF', verb: 'fire', wo_id: 'WO-A', project: 'bdc-harness' }),
    });
    await processCommand(world.deps, retry);
    expect(world.calls.fire).toBe(1);
    const replayed = parseReply(world.replies[world.replies.length - 1]);
    expect(replayed.status).toBe(409);
    expect(replayed.code).toBe('admission_unknown');
    expect(replayed.run_id).toBe('R1');
    expect(replayed.cascade_id).toBe('C1');
  });
});

describe('Test 3e: an unknown fire holds the WO lock until operator adjudication', () => {
  test('a new request after an unknown admission is refused with the original admission id', async () => {
    const world = makeWorld({ ...BASE_ENV });
    world.projectRepos.set('bdc-harness', 'thinmansoftware/bdc-harness');
    // Uncertain cascade: no run id -> the admission becomes `unknown`.
    world.fireResults.set('WO-U', { cascadeId: 'CU', status: 'running', runId: null });
    await processCommand(
      world.deps,
      makeMessage({
        id: 'cmd-u1',
        idempotencyKey: 'U1',
        body: cmdBody({ request_id: 'U1', verb: 'fire', wo_id: 'WO-U', project: 'bdc-harness' }),
      })
    );
    expect((await admissions.getByRequestId('U1', db))?.state).toBe('unknown');
    expect(world.calls.fire).toBe(1);

    // No live run is visible (liveRuns empty) -- the ledger alone must refuse.
    world.fireResults.set('WO-U', { cascadeId: 'CU2', status: 'running', runId: 'RU2' });
    await processCommand(
      world.deps,
      makeMessage({
        id: 'cmd-u2',
        idempotencyKey: 'U2',
        body: cmdBody({ request_id: 'U2', verb: 'fire', wo_id: 'WO-U', project: 'bdc-harness' }),
      })
    );
    expect(world.calls.fire).toBe(1);
    const refused = parseReply(world.replyById.get('reply:cmd-u2')!);
    expect(refused.status).toBe(409);
    expect(refused.code).toBe('admission_unknown');
    expect(refused.run_id).toBe('U1');
    expect((await admissions.getByRequestId('U2', db))?.state).toBe('refused');
    expect((await admissions.getByRequestId('U1', db))?.state).toBe('unknown');
  });

  test('the unique index alone refuses a reservation while an unknown fire holds the WO', async () => {
    const base = {
      actor_principal_id: 't3-bridge',
      verb: 'fire' as const,
      payload_sha256: 'd',
      wo_id: 'WO-IDX',
      project: 'bdc-harness',
      now: T0,
    };
    await admissions.reserveAdmission({ ...base, request_id: 'I1', source_message_id: 'm-i1' }, db);
    await admissions.markUnknown(
      'I1',
      { status_code: 409, code: 'admission_unknown', now: T0 },
      db
    );
    const second = await admissions.reserveAdmission(
      { ...base, request_id: 'I2', source_message_id: 'm-i2' },
      db
    );
    expect(second.status).toBe('wo_fire_locked');
  });

  test('adjudication (no_run) releases the WO; a later request fires once', async () => {
    const world = makeWorld({ ...BASE_ENV });
    world.projectRepos.set('bdc-harness', 'thinmansoftware/bdc-harness');
    world.fireResults.set('WO-J', { cascadeId: 'CJ', status: 'running', runId: null });
    await processCommand(
      world.deps,
      makeMessage({
        id: 'cmd-j1',
        idempotencyKey: 'J1',
        body: cmdBody({ request_id: 'J1', verb: 'fire', wo_id: 'WO-J', project: 'bdc-harness' }),
      })
    );
    expect((await admissions.getByRequestId('J1', db))?.state).toBe('unknown');

    // Compare-and-set: adjudicating a non-unknown row changes nothing.
    expect(
      (
        await admissions.adjudicateUnknownFire(
          'NOPE',
          { resolution: 'no_run', adjudicated_by: 'operator', now: T0 },
          db
        )
      ).status
    ).toBe('not_found');

    const result = await admissions.adjudicateUnknownFire(
      'J1',
      { resolution: 'no_run', adjudicated_by: 'operator', now: T0 },
      db
    );
    expect(result.status).toBe('adjudicated');
    const adjudicated = await admissions.getByRequestId('J1', db);
    expect(adjudicated?.state).toBe('refused');
    expect(adjudicated?.code).toBe('adjudicated_no_run:operator');
    // A second adjudication is a no-op on the now-resolved row.
    expect(
      (
        await admissions.adjudicateUnknownFire(
          'J1',
          { resolution: 'run', run_id: 'RX', adjudicated_by: 'operator', now: T0 },
          db
        )
      ).status
    ).toBe('not_unknown');

    world.fireResults.set('WO-J', { cascadeId: 'CJ2', status: 'running', runId: 'RJ2' });
    await processCommand(
      world.deps,
      makeMessage({
        id: 'cmd-j2',
        idempotencyKey: 'J2',
        body: cmdBody({ request_id: 'J2', verb: 'fire', wo_id: 'WO-J', project: 'bdc-harness' }),
      })
    );
    expect(world.calls.fire).toBe(2);
    const ok = parseReply(world.replyById.get('reply:cmd-j2')!);
    expect(ok).toMatchObject({ status: 200, code: 'ok', run_id: 'RJ2' });
  });

  test('adjudication (run) admits the proven run to the original actor and releases the lock', async () => {
    const world = makeWorld({ ...BASE_ENV });
    world.projectRepos.set('bdc-harness', 'thinmansoftware/bdc-harness');
    world.fireResults.set('WO-K', { cascadeId: 'CK', status: 'running', runId: null });
    await processCommand(
      world.deps,
      makeMessage({
        id: 'cmd-k1',
        idempotencyKey: 'K1',
        body: cmdBody({ request_id: 'K1', verb: 'fire', wo_id: 'WO-K', project: 'bdc-harness' }),
      })
    );
    const result = await admissions.adjudicateUnknownFire(
      'K1',
      { resolution: 'run', run_id: 'RK', adjudicated_by: 'operator', now: T0 },
      db
    );
    expect(result.status).toBe('adjudicated');
    const row = await admissions.getByRequestId('K1', db);
    expect(row).toMatchObject({ state: 'admitted', status_code: 200, code: 'ok', run_id: 'RK' });
    expect(await admissions.ownsRun('t3-bridge', 'RK', db)).toBe(true);
    expect(await admissions.findLiveFireForWo('WO-K', undefined, db)).toBeNull();
  });
});

describe('Test 4: cancel of another principal run returns 403', () => {
  test('non-owners refused; owner cancels once; retry replays without a second cancel', async () => {
    const world = makeWorld({ ...BASE_ENV });
    world.projectRepos.set('bdc-harness', 'thinmansoftware/bdc-harness');
    await seedAdmittedFire('t3-bridge', 'WO-R1', 'R1', 'fire-R1');

    // t3-bridge cancels R9 (not owned by anyone here)
    const c1 = makeMessage({
      idempotencyKey: 'C1',
      body: cmdBody({ request_id: 'C1', verb: 'cancel-own', project: 'bdc-harness', run_id: 'R9' }),
    });
    // p2 cancels R1 (owned by t3-bridge)
    const c2 = makeMessage({
      idempotencyKey: 'C2',
      sender: 'p2',
      principal: 'p2',
      body: cmdBody({ request_id: 'C2', verb: 'cancel-own', project: 'bdc-harness', run_id: 'R1' }),
    });
    // t3-bridge cancels R1 (owned) then retries same request
    const c3 = makeMessage({
      idempotencyKey: 'C3',
      body: cmdBody({ request_id: 'C3', verb: 'cancel-own', project: 'bdc-harness', run_id: 'R1' }),
    });

    await processCommand(world.deps, c1);
    await processCommand(world.deps, c2);
    expect(world.calls.cancel).toBe(0);
    expect(parseReply(world.replyById.get('reply:cmd-1')!).code).toBe('forbidden_not_own_run');
    expect(parseReply(world.replyById.get('reply:cmd-1')!).status).toBe(403);
    expect(parseReply(world.replyById.get('reply:cmd-2')!).code).toBe('forbidden_not_own_run');
    expect(world.replyById.get('reply:cmd-2')!.recipient).toBe('p2-mbox');

    await processCommand(world.deps, c3);
    expect(world.calls.cancel).toBe(1);
    expect(world.cancelActors).toEqual(['t3-bridge']);
    expect(parseReply(world.replyById.get('reply:cmd-3')!).status).toBe(200);

    await processCommand(world.deps, c3); // retry
    expect(world.calls.cancel).toBe(1); // no second cancel
    expect(parseReply(world.replyById.get('reply:cmd-3')!).status).toBe(200);
  });
});

describe('Test 5: approve is bound server-side', () => {
  test('ownership, repo, PR, base and exact head are all enforced', async () => {
    const world = makeWorld({ ...BASE_ENV });
    world.projectRepos.set('bdc-harness', 'thinmansoftware/bdc-harness');
    world.projectRepos.set('lspro-react', 'thinmansoftware/lspro-react');
    // P1 and P3 fired by t3-bridge; P2 by someone else (not seeded).
    await seedAdmittedFire('t3-bridge', 'WO-P1', 'P1', 'fire-P1');
    await seedAdmittedFire('t3-bridge', 'WO-P3', 'P3', 'fire-P3');
    world.runRepos.set('P1', 'thinmansoftware/bdc-harness');
    world.runRepos.set('P2', 'thinmansoftware/bdc-harness');
    world.runRepos.set('P3', 'thinmansoftware/lspro-react');
    world.runBranches.set('P1', 'feat/x');
    world.runBranches.set('P2', 'feat/x');
    world.runBranches.set('P3', 'feat/x');
    world.prs.set('thinmansoftware/bdc-harness#5', {
      open: true,
      headRepo: 'thinmansoftware/bdc-harness',
      baseRepo: 'thinmansoftware/bdc-harness',
      headRef: 'feat/x',
      baseRef: 'dev',
      headSha: SHA_CURRENT,
    });
    world.prs.set('thinmansoftware/lspro-react#9', {
      open: true,
      headRepo: 'thinmansoftware/lspro-react',
      baseRepo: 'thinmansoftware/lspro-react',
      headRef: 'feat/x',
      baseRef: 'main',
      headSha: SHA_LSPRO,
    });

    const approve = (
      key: string,
      runIdForApprove: string,
      project: string,
      pr: string,
      headSha: string
    ): DispatchMessage =>
      makeMessage({
        idempotencyKey: key,
        body: cmdBody({
          request_id: key,
          verb: 'approve',
          project,
          run_id_for_approve: runIdForApprove,
          pr,
          head_sha: headSha,
        }),
      });

    // (a) stale head for P1
    await processCommand(
      world.deps,
      approve('A', 'P1', 'bdc-harness', 'thinmansoftware/bdc-harness#5', SHA_STALE)
    );
    // (b) unrelated run P2 sharing the branch name
    await processCommand(
      world.deps,
      approve('B', 'P2', 'bdc-harness', 'thinmansoftware/bdc-harness#5', SHA_CURRENT)
    );
    // (c) other-repo run P3 sharing the branch name
    await processCommand(
      world.deps,
      approve('C', 'P3', 'bdc-harness', 'thinmansoftware/bdc-harness#5', SHA_CURRENT)
    );
    // (d) PR in a different repo than P1's run
    await processCommand(
      world.deps,
      approve('D', 'P1', 'bdc-harness', 'thinmansoftware/lspro-react#9', SHA_LSPRO)
    );
    // (e) production base
    await processCommand(
      world.deps,
      approve('E', 'P3', 'lspro-react', 'thinmansoftware/lspro-react#9', SHA_LSPRO)
    );

    expect(world.calls.approve).toBe(0);
    expect(parseReply(world.replyById.get('reply:cmd-1')!)).toMatchObject({
      status: 422,
      code: 'stale_head',
    });
    expect(parseReply(world.replyById.get('reply:cmd-2')!)).toMatchObject({
      status: 403,
      code: 'forbidden_not_own_run',
    });
    expect(parseReply(world.replyById.get('reply:cmd-3')!)).toMatchObject({
      status: 409,
      code: 'run_pr_mismatch',
    });
    expect(parseReply(world.replyById.get('reply:cmd-4')!)).toMatchObject({
      status: 409,
      code: 'run_pr_mismatch',
    });
    expect(parseReply(world.replyById.get('reply:cmd-5')!)).toMatchObject({
      status: 403,
      code: 'base_not_allowed',
    });

    // (f) valid approve of P1 at the current head
    await processCommand(
      world.deps,
      approve('F', 'P1', 'bdc-harness', 'thinmansoftware/bdc-harness#5', SHA_CURRENT)
    );
    expect(world.calls.approve).toBe(1);
    expect(parseReply(world.replyById.get('reply:cmd-6')!).status).toBe(200);
    const fRow = await admissions.getByRequestId('F', db);
    expect(fRow?.pr_ref).toBe('thinmansoftware/bdc-harness#5');
    expect(fRow?.head_sha).toBe(SHA_CURRENT);
    expect(fRow?.project).toBe('bdc-harness');
  });
});

describe('Test 6: validation refuses before anything executes', () => {
  test('each invalid row is replied once and acked; nothing executes', async () => {
    const world = makeWorld({ ...BASE_ENV });
    world.projectRepos.set('bdc-harness', 'thinmansoftware/bdc-harness');

    const rows: { msg: DispatchMessage; expectCode: string }[] = [
      {
        msg: makeMessage({
          idempotencyKey: 'V1',
          principal: null,
          body: cmdBody({ request_id: 'V1', verb: 'fire', wo_id: 'WO-A', project: 'bdc-harness' }),
        }),
        expectCode: 'actor_not_allowed',
      },
      {
        msg: makeMessage({
          idempotencyKey: 'V2',
          sender: 'rogue',
          principal: 'rogue',
          body: cmdBody({ request_id: 'V2', verb: 'fire', wo_id: 'WO-A', project: 'bdc-harness' }),
        }),
        expectCode: 'actor_not_allowed',
      },
      {
        msg: makeMessage({
          idempotencyKey: 'V3',
          body: cmdBody({ request_id: 'V3', verb: 'fire', wo_id: 'WO-A', project: 'nope' }),
        }),
        expectCode: 'project_not_allowed',
      },
      {
        msg: makeMessage({
          idempotencyKey: 'V4',
          body: cmdBody({
            request_id: 'V4',
            verb: 'delete',
            wo_id: 'WO-A',
            project: 'bdc-harness',
          }),
        }),
        expectCode: 'unknown_verb',
      },
      {
        msg: makeMessage({ idempotencyKey: 'V5', body: 'not-json{' }),
        expectCode: 'invalid_body',
      },
      {
        msg: makeMessage({
          idempotencyKey: 'V6',
          body: cmdBody({
            request_id: 'DIFFERENT',
            verb: 'fire',
            wo_id: 'WO-A',
            project: 'bdc-harness',
          }),
        }),
        expectCode: 'request_id_mismatch',
      },
    ];

    for (const row of rows) {
      await processCommand(world.deps, row.msg);
    }

    expect(world.calls).toEqual({ fire: 0, cancel: 0, approve: 0 });
    expect(world.replies).toHaveLength(rows.length);
    expect(world.acked).toHaveLength(rows.length);
    for (let i = 0; i < rows.length; i++) {
      expect(parseReply(world.replyById.get(`reply:${rows[i].msg.id}`)!).code).toBe(
        rows[i].expectCode
      );
    }
    // No admission rows for validation failures.
    for (const key of ['V1', 'V2', 'V3', 'V4', 'V5', 'V6']) {
      expect(await admissions.getByRequestId(key, db)).toBeNull();
    }
  });
});

describe('Test 7: conflicts are answered even after the original reply exists', () => {
  test('changed-payload reuse and cross-actor reuse each get a fresh 409, original untouched', async () => {
    const world = makeWorld({ ...BASE_ENV });
    world.projectRepos.set('bdc-harness', 'thinmansoftware/bdc-harness');
    world.fireResults.set('WO-A', { cascadeId: 'C1', status: 'running', runId: 'R1' });

    const original = makeMessage({
      idempotencyKey: 'Q1',
      body: cmdBody({ request_id: 'Q1', verb: 'fire', wo_id: 'WO-A', project: 'bdc-harness' }),
    });
    await processCommand(world.deps, original);
    const originalReply = world.replyById.get('reply:cmd-1')!;
    expect(parseReply(originalReply).status).toBe(200);

    // (a) same request_id, changed payload (WO-Z), same actor -> 409 under a NEW reply identity
    const changed = makeMessage({
      idempotencyKey: 'Q1',
      body: cmdBody({ request_id: 'Q1', verb: 'fire', wo_id: 'WO-Z', project: 'bdc-harness' }),
    });
    await processCommand(world.deps, changed);
    const changedReply = world.replyById.get(`reply:${changed.id}`)!;
    expect(parseReply(changedReply)).toMatchObject({ status: 409, code: 'request_conflict' });
    expect(changedReply.id).not.toBe(originalReply.id);

    // (b) same request_id, original payload, DIFFERENT actor -> 409 to p2's mailbox
    const crossActor = makeMessage({
      idempotencyKey: 'Q1',
      sender: 'p2',
      principal: 'p2',
      body: cmdBody({ request_id: 'Q1', verb: 'fire', wo_id: 'WO-A', project: 'bdc-harness' }),
    });
    await processCommand(world.deps, crossActor);
    const crossReply = world.replyById.get(`reply:${crossActor.id}`)!;
    expect(parseReply(crossReply)).toMatchObject({ status: 409, code: 'request_conflict' });
    expect(crossReply.recipient).toBe('p2-mbox');

    // runCascade not called again; original admission + reply unchanged
    expect(world.calls.fire).toBe(1);
    const row = await admissions.getByRequestId('Q1', db);
    expect(row?.state).toBe('admitted');
    expect(row?.wo_id).toBe('WO-A');
    expect(row?.run_id).toBe('R1');
    expect(parseReply(originalReply).status).toBe(200);
  });
});

describe('Test 8: crash safety', () => {
  test('(a) reserved fire at startup -> unknown + 409 admission_unknown, no refire', async () => {
    const world = makeWorld({ ...BASE_ENV });
    world.projectRepos.set('bdc-harness', 'thinmansoftware/bdc-harness');
    await admissions.reserveAdmission(
      {
        request_id: 'RESV',
        actor_principal_id: 't3-bridge',
        verb: 'fire',
        payload_sha256: 'd',
        wo_id: 'WO-CRASH',
        project: 'bdc-harness',
        source_message_id: 'cmd-crash',
        now: T0,
      },
      db
    );
    // The cascade dispatch had started (effect marker set) before the crash.
    await admissions.markEffectStarted('RESV', T0, db);
    world.deps.now = (): Date => new Date(Date.parse(T0) + 301_000);

    await recoverStaleReservations(world.deps);

    expect(world.calls.fire).toBe(0);
    const row = await admissions.getByRequestId('RESV', db);
    expect(row?.state).toBe('unknown');
    const reply = parseReply(world.replyById.get('reply:cmd-crash')!);
    expect(reply).toMatchObject({ status: 409, code: 'admission_unknown' });
  });

  test('(b) decided+replied row whose ack failed produces no second reply and is acked', async () => {
    const world = makeWorld({ ...BASE_ENV });
    world.projectRepos.set('bdc-harness', 'thinmansoftware/bdc-harness');
    world.fireResults.set('WO-A', { cascadeId: 'C1', status: 'running', runId: 'R1' });
    const message = makeMessage({
      idempotencyKey: 'Q1',
      body: cmdBody({ request_id: 'Q1', verb: 'fire', wo_id: 'WO-A', project: 'bdc-harness' }),
    });
    await processCommand(world.deps, message);
    const replyCountAfterFirst = world.replies.length;
    world.acked.length = 0; // simulate the ack never landing

    await processCommand(world.deps, message);

    expect(world.replies.length).toBe(replyCountAfterFirst); // no new reply row
    expect(world.acked).toContain(message.id); // re-acked
    expect(world.calls.fire).toBe(1);
  });
});

describe('Test 10: disabled by default', () => {
  test('start is a no-op with T3_COMMAND_CONSUMER_ENABLED unset', async () => {
    const world = makeWorld({ ...BASE_ENV }); // no enable flag
    let listCalls = 0;
    world.deps.listCommands = async () => {
      listCalls += 1;
      return [];
    };
    const message = makeMessage({
      idempotencyKey: 'Q1',
      body: cmdBody({ request_id: 'Q1', verb: 'fire', wo_id: 'WO-A', project: 'bdc-harness' }),
    });
    world.queue.push(message);

    expect(cauldronFireConsumerEnabled(world.deps.env)).toBe(false);
    startCauldronFireConsumer(world.deps);
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(listCalls).toBe(0);
    expect(world.acked).toHaveLength(0);
    expect(await admissions.getByRequestId('Q1', db)).toBeNull();
  });
});

describe('single-flight ticks and active reservations', () => {
  test('a tick firing while runCascade is in flight is a no-op', async () => {
    const world = makeWorld({ ...BASE_ENV });
    world.projectRepos.set('bdc-harness', 'thinmansoftware/bdc-harness');
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const baseFire = world.deps.fireCascade;
    world.deps.fireCascade = async input => {
      await gate;
      return baseFire(input);
    };
    const message = makeMessage({
      id: 'cmd-sf',
      idempotencyKey: 'SF',
      body: cmdBody({ request_id: 'SF', verb: 'fire', wo_id: 'WO-SF', project: 'bdc-harness' }),
    });
    world.queue.push(message);

    const first = tickCauldronFireConsumer(world.deps);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect((await admissions.getByRequestId('SF', db))?.state).toBe('reserved');

    // Overlapping tick while the fire is still executing: does nothing.
    await tickCauldronFireConsumer(world.deps);
    expect(world.replies).toHaveLength(0);
    expect(world.acked).toHaveLength(0);
    expect((await admissions.getByRequestId('SF', db))?.state).toBe('reserved');

    release();
    await first;
    expect(world.calls.fire).toBe(1);
    expect(world.replies).toHaveLength(1);
    expect(parseReply(world.replies[0] as ReplyRecord)).toMatchObject({ status: 200, code: 'ok' });
    expect(world.acked).toEqual(['cmd-sf']);
  });

  test('a retry of a request whose reservation is still active gets 202 pending and is acked', async () => {
    const world = makeWorld({ ...BASE_ENV });
    world.projectRepos.set('bdc-harness', 'thinmansoftware/bdc-harness');
    const body = cmdBody({
      request_id: 'AR',
      verb: 'fire',
      wo_id: 'WO-AR',
      project: 'bdc-harness',
    });
    const cmd = JSON.parse(body) as T3Command;
    // The original command (cmd-ar-1) is mid-execution: its admission is reserved.
    await admissions.reserveAdmission(
      {
        request_id: 'AR',
        actor_principal_id: 't3-bridge',
        verb: 'fire',
        payload_sha256: canonicalDigest(cmd),
        wo_id: 'WO-AR',
        project: 'bdc-harness',
        thread_id: 'th-1',
        source_message_id: 'cmd-ar-1',
        now: T0,
      },
      db
    );
    const retry = makeMessage({ id: 'cmd-ar-2', idempotencyKey: 'AR', body });
    await processCommand(world.deps, retry);
    // Amendment 2 A2.2 rule 5: 202 pending under the retry row's own identity.
    expect(world.replies).toHaveLength(1);
    expect(parseReply(world.replyById.get('reply:cmd-ar-2') as ReplyRecord)).toMatchObject({
      status: 202,
      code: 'pending',
    });
    expect(world.acked).toEqual(['cmd-ar-2']);
    expect(world.calls.fire).toBe(0);
  });
});

describe('run ownership is persisted at run discovery, before terminal polling', () => {
  type CascadeImpl = Parameters<typeof fireCascadeUntilRunDiscovered>[0];
  type CascadeOpts = Parameters<CascadeImpl>[0];

  test('cancel-own and approve succeed while the fired run is still running / paused', async () => {
    const world = makeWorld({ ...BASE_ENV });
    world.projectRepos.set('bdc-harness', 'thinmansoftware/bdc-harness');
    let cascadeFinished = false;
    const impl = (async (opts: CascadeOpts) => {
      // Dispatch proven and run discovered...
      opts.onRunDiscovered?.('RLIVE', `C-${opts.woId}`);
      // ...then terminal-state polling that does not finish during this test.
      await new Promise<void>(() => undefined);
      cascadeFinished = true;
      return {} as never;
    }) as unknown as CascadeImpl;
    world.deps.fireCascade = async input => {
      world.calls.fire += 1;
      return fireCascadeUntilRunDiscovered(impl, async () => null, {
        woId: input.woId,
        project: input.project,
        dispatchId: input.dispatchId,
      });
    };

    await processCommand(
      world.deps,
      makeMessage({
        id: 'cmd-live-fire',
        idempotencyKey: 'LF',
        body: cmdBody({
          request_id: 'LF',
          verb: 'fire',
          wo_id: 'WO-LIVE',
          project: 'bdc-harness',
        }),
      })
    );
    // The cascade has NOT finished, yet the fire is admitted with its run id.
    expect(cascadeFinished).toBe(false);
    const fired = parseReply(world.replyById.get('reply:cmd-live-fire') as ReplyRecord);
    expect(fired).toMatchObject({
      status: 200,
      code: 'ok',
      run_id: 'RLIVE',
      cascade_id: 'C-WO-LIVE',
    });
    expect(await admissions.ownsRun('t3-bridge', 'RLIVE', db)).toBe(true);

    // Approve the paused run, bound to its repo / PR / exact head.
    world.runRepos.set('RLIVE', 'thinmansoftware/bdc-harness');
    world.runBranches.set('RLIVE', 'feat/live');
    world.prs.set('thinmansoftware/bdc-harness#7', {
      open: true,
      headRepo: 'thinmansoftware/bdc-harness',
      baseRepo: 'thinmansoftware/bdc-harness',
      headRef: 'feat/live',
      baseRef: 'dev',
      headSha: SHA_CURRENT,
    });
    await processCommand(
      world.deps,
      makeMessage({
        id: 'cmd-live-approve',
        idempotencyKey: 'LA',
        body: cmdBody({
          request_id: 'LA',
          verb: 'approve',
          project: 'bdc-harness',
          run_id_for_approve: 'RLIVE',
          pr: 'thinmansoftware/bdc-harness#7',
          head_sha: SHA_CURRENT,
        }),
      })
    );
    expect(world.calls.approve).toBe(1);
    expect(parseReply(world.replyById.get('reply:cmd-live-approve') as ReplyRecord)).toMatchObject({
      status: 200,
      code: 'approved',
    });

    // Cancel the still-running run.
    await processCommand(
      world.deps,
      makeMessage({
        id: 'cmd-live-cancel',
        idempotencyKey: 'LC',
        body: cmdBody({
          request_id: 'LC',
          verb: 'cancel-own',
          project: 'bdc-harness',
          run_id: 'RLIVE',
        }),
      })
    );
    expect(world.calls.cancel).toBe(1);
    expect(world.cancelActors).toEqual(['t3-bridge']);
    expect(parseReply(world.replyById.get('reply:cmd-live-cancel') as ReplyRecord)).toMatchObject({
      status: 200,
      code: 'ok',
    });
  });

  test('a cascade that ends before any run is discovered falls back to its final record', async () => {
    const impl = (async () => ({
      cascadeId: 'C-END',
      status: 'refused',
      attempts: [],
    })) as unknown as CascadeImpl;
    const result = await fireCascadeUntilRunDiscovered(impl, async () => null, {
      woId: 'WO-END',
      project: 'bdc-harness',
      dispatchId: 'd',
    });
    expect(result).toEqual({ cascadeId: 'C-END', status: 'refused', runId: null });
  });
});

// ---------------------------------------------------------------------------
// Amendment 2 (A2.2): outcome states for every verb
// ---------------------------------------------------------------------------

class GitHubRequestError extends Error {}

const STALE_NOW = (): Date => new Date(Date.parse(T0) + 301_000);

function fireMsg(id: string, requestId: string, woId: string): DispatchMessage {
  return makeMessage({
    id,
    idempotencyKey: requestId,
    body: cmdBody({ request_id: requestId, verb: 'fire', wo_id: woId, project: 'bdc-harness' }),
  });
}

function cancelMsg(id: string, requestId: string, runId: string): DispatchMessage {
  return makeMessage({
    id,
    idempotencyKey: requestId,
    body: cmdBody({
      request_id: requestId,
      verb: 'cancel-own',
      project: 'bdc-harness',
      run_id: runId,
    }),
  });
}

function approveMsg(id: string, requestId: string, runId: string): DispatchMessage {
  return makeMessage({
    id,
    idempotencyKey: requestId,
    body: cmdBody({
      request_id: requestId,
      verb: 'approve',
      project: 'bdc-harness',
      run_id_for_approve: runId,
      pr: 'thinmansoftware/bdc-harness#5',
      head_sha: SHA_CURRENT,
    }),
  });
}

function replyFor(world: World, messageId: string): Record<string, unknown> {
  const record = world.replyById.get(`reply:${messageId}`);
  if (!record) throw new Error(`no reply for ${messageId}`);
  return JSON.parse(record.body) as Record<string, unknown>;
}

function setupApprovableP1(world: World): void {
  world.projectRepos.set('bdc-harness', 'thinmansoftware/bdc-harness');
  world.runRepos.set('P1', 'thinmansoftware/bdc-harness');
  world.runBranches.set('P1', 'feat/x');
  world.prs.set('thinmansoftware/bdc-harness#5', {
    open: true,
    headRepo: 'thinmansoftware/bdc-harness',
    baseRepo: 'thinmansoftware/bdc-harness',
    headRef: 'feat/x',
    baseRef: 'dev',
    headSha: SHA_CURRENT,
  });
}

describe('Test 13: fire -- before effect, after effect, pending, recovery', () => {
  test('(a) eligibility throws -> refused 503 failed_before_effect, WO lock released, no cascade', async () => {
    const world = makeWorld({ ...BASE_ENV });
    world.projectRepos.set('bdc-harness', 'thinmansoftware/bdc-harness');
    world.deps.checkFireEligibility = async () => {
      throw new GitHubRequestError('boom');
    };
    await processCommand(world.deps, fireMsg('cmd-q10', 'Q10', 'WO-C'));
    expect(world.calls.fire).toBe(0);
    const row = await admissions.getByRequestId('Q10', db);
    expect(row?.state).toBe('refused');
    expect(row?.effect_started_at).toBeNull();
    expect(replyFor(world, 'cmd-q10')).toMatchObject({
      status: 503,
      code: 'failed_before_effect',
      error_class: 'GitHubRequestError',
    });
    expect(world.acked).toContain('cmd-q10');
    // A retry with the SAME request_id replays the refusal.
    await processCommand(world.deps, fireMsg('cmd-q10b', 'Q10', 'WO-C'));
    expect(replyFor(world, 'cmd-q10b')).toMatchObject({
      status: 503,
      code: 'failed_before_effect',
    });
    // The WO lock is released: a NEW request for WO-C is admitted.
    world.deps.checkFireEligibility = async () => ({ eligible: true });
    await processCommand(world.deps, fireMsg('cmd-q10c', 'Q10C', 'WO-C'));
    expect(replyFor(world, 'cmd-q10c')).toMatchObject({ status: 200, code: 'ok' });
    expect(world.calls.fire).toBe(1);
  });

  test('(b) cascade throws after dispatch -> unknown 409, WO held', async () => {
    const world = makeWorld({ ...BASE_ENV });
    world.projectRepos.set('bdc-harness', 'thinmansoftware/bdc-harness');
    const posts: string[] = [];
    world.deps.fireCascade = async input => {
      world.calls.fire += 1;
      posts.push(`POST /api/conversations ${input.woId}`);
      throw new Error('cascade died after dispatch');
    };
    await processCommand(world.deps, fireMsg('cmd-q11', 'Q11', 'WO-D'));
    expect(posts).toHaveLength(1);
    const row = await admissions.getByRequestId('Q11', db);
    expect(row?.state).toBe('unknown');
    expect(row?.effect_started_at).not.toBeNull();
    expect(replyFor(world, 'cmd-q11')).toMatchObject({
      status: 409,
      code: 'admission_unknown',
      message: 'unknown, adjudication required',
    });
    await processCommand(world.deps, fireMsg('cmd-q11b', 'Q11B', 'WO-D'));
    expect(replyFor(world, 'cmd-q11b')).toMatchObject({
      status: 409,
      code: 'admission_unknown',
      run_id: 'Q11',
    });
    expect(world.calls.fire).toBe(1);
  });

  test('(c) a retry during a held fire gets 202 pending; the original later gets its 200', async () => {
    const world = makeWorld({ ...BASE_ENV });
    world.projectRepos.set('bdc-harness', 'thinmansoftware/bdc-harness');
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const baseFire = world.deps.fireCascade;
    world.deps.fireCascade = async input => {
      await gate;
      return baseFire(input);
    };
    const original = processCommand(world.deps, fireMsg('cmd-q12', 'Q12', 'WO-E'));
    await new Promise(resolve => setTimeout(resolve, 20));
    await processCommand(world.deps, fireMsg('cmd-q12-retry', 'Q12', 'WO-E'));
    expect(replyFor(world, 'cmd-q12-retry')).toMatchObject({ status: 202, code: 'pending' });
    expect(world.acked).toContain('cmd-q12-retry');
    release();
    await original;
    expect(replyFor(world, 'cmd-q12')).toMatchObject({ status: 200, code: 'ok' });
    expect(world.calls.fire).toBe(1);
  });

  test('(d) stale reserved fire with no effect marker -> refused, replied once, acked, no cascade', async () => {
    const world = makeWorld({ ...BASE_ENV });
    await admissions.reserveAdmission(
      {
        request_id: 'Q13',
        actor_principal_id: 't3-bridge',
        verb: 'fire',
        payload_sha256: 'd',
        wo_id: 'WO-F',
        project: 'bdc-harness',
        source_message_id: 'cmd-q13',
        now: T0,
      },
      db
    );
    world.deps.now = STALE_NOW;
    await recoverStaleReservations(world.deps);
    await recoverStaleReservations(world.deps); // idempotent: nothing left to sweep
    expect((await admissions.getByRequestId('Q13', db))?.state).toBe('refused');
    expect(world.replies.filter(r => r.idempotencyKey === 'reply:cmd-q13')).toHaveLength(1);
    expect(replyFor(world, 'cmd-q13')).toMatchObject({
      status: 503,
      code: 'failed_before_effect',
      error_class: 'RecoveredBeforeEffect',
    });
    expect(world.acked).toEqual(['cmd-q13']);
    expect(world.calls.fire).toBe(0);
  });
});

describe('Test 14: cancel-own -- before effect, after effect, pending, recovery', () => {
  test('(a) ownership read throws -> refused 503, cancel not called, no run lock left', async () => {
    const world = makeWorld({ ...BASE_ENV });
    world.projectRepos.set('bdc-harness', 'thinmansoftware/bdc-harness');
    await seedAdmittedFire('t3-bridge', 'WO-A', 'R1', 'fire-R1');
    const realDb = db;
    world.deps.db = new Proxy(realDb, {
      get(target, prop, receiver): unknown {
        if (prop === 'query') {
          return async (sql: string, params?: unknown[]): Promise<unknown> => {
            if (sql.includes('a.actor_principal_id = $1')) {
              throw new TypeError('ownership read failed');
            }
            return target.query(sql, params as never);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as typeof realDb;
    await processCommand(world.deps, cancelMsg('cmd-q20', 'Q20', 'R1'));
    expect(world.calls.cancel).toBe(0);
    expect((await admissions.getByRequestId('Q20', db))?.state).toBe('refused');
    expect(replyFor(world, 'cmd-q20')).toMatchObject({
      status: 503,
      code: 'failed_before_effect',
      error_class: 'TypeError',
    });
    expect(await admissions.findRunLockHolder('R1', undefined, db)).toBeNull();
  });

  test('(b) cancel throws after being called -> unknown, run lock held for cancel and approve', async () => {
    const world = makeWorld({ ...BASE_ENV });
    setupApprovableP1(world);
    await seedAdmittedFire('t3-bridge', 'WO-A', 'R1', 'fire-R1');
    world.deps.cancelRun = async () => {
      world.calls.cancel += 1;
      throw new Error('cancel died midway');
    };
    await processCommand(world.deps, cancelMsg('cmd-q21', 'Q21', 'R1'));
    expect(world.calls.cancel).toBe(1);
    expect((await admissions.getByRequestId('Q21', db))?.state).toBe('unknown');
    expect(replyFor(world, 'cmd-q21')).toMatchObject({ status: 409, code: 'admission_unknown' });

    await processCommand(world.deps, cancelMsg('cmd-q21b', 'Q21B', 'R1'));
    expect(replyFor(world, 'cmd-q21b')).toMatchObject({
      status: 409,
      code: 'admission_unknown',
      run_id: 'Q21',
    });
    await processCommand(world.deps, approveMsg('cmd-q21c', 'Q21C', 'R1'));
    expect(replyFor(world, 'cmd-q21c')).toMatchObject({
      status: 409,
      code: 'admission_unknown',
      run_id: 'Q21',
    });
    expect(world.calls.cancel).toBe(1);
    expect(world.calls.approve).toBe(0);
  });

  test('(c) a retry during a held cancel gets 202 pending', async () => {
    const world = makeWorld({ ...BASE_ENV });
    world.projectRepos.set('bdc-harness', 'thinmansoftware/bdc-harness');
    await seedAdmittedFire('t3-bridge', 'WO-A', 'R1', 'fire-R1');
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    world.deps.cancelRun = async () => {
      world.calls.cancel += 1;
      await gate;
      return { ok: true, run: {} } as never;
    };
    const original = processCommand(world.deps, cancelMsg('cmd-q22', 'Q22', 'R1'));
    await new Promise(resolve => setTimeout(resolve, 20));
    await processCommand(world.deps, cancelMsg('cmd-q22-retry', 'Q22', 'R1'));
    expect(replyFor(world, 'cmd-q22-retry')).toMatchObject({ status: 202, code: 'pending' });
    release();
    await original;
    expect(replyFor(world, 'cmd-q22')).toMatchObject({ status: 200, code: 'ok' });
    expect(world.calls.cancel).toBe(1);
  });

  test('(d) stale cancel with effect marker, run proven cancelled by the actor -> admitted', async () => {
    const world = makeWorld({ ...BASE_ENV });
    await admissions.reserveAdmission(
      {
        request_id: 'Q23',
        actor_principal_id: 't3-bridge',
        verb: 'cancel-own',
        payload_sha256: 'd',
        project: 'bdc-harness',
        target_run_id: 'R1',
        source_message_id: 'cmd-q23',
        now: T0,
      },
      db
    );
    await admissions.markEffectStarted('Q23', T0, db);
    world.cancelledBy.set('R1', 't3-bridge');
    world.deps.now = STALE_NOW;
    await recoverStaleReservations(world.deps);
    const row = await admissions.getByRequestId('Q23', db);
    expect(row).toMatchObject({ state: 'admitted', code: 'ok', run_id: 'R1' });
    expect(world.replies.filter(r => r.idempotencyKey === 'reply:cmd-q23')).toHaveLength(1);
    expect(world.acked).toEqual(['cmd-q23']);
    expect(world.calls.cancel).toBe(0);
  });
});

describe('Test 15: approve -- before effect, after effect, pending, recovery', () => {
  test('(a) GitHub PR read throws -> refused 503 with the client error class, acked', async () => {
    const world = makeWorld({ ...BASE_ENV });
    setupApprovableP1(world);
    await seedAdmittedFire('t3-bridge', 'WO-P1', 'P1', 'fire-P1');
    world.deps.getPullRequest = async () => {
      throw new GitHubRequestError('HTTP 502 from api.github.com');
    };
    await processCommand(world.deps, approveMsg('cmd-q30', 'Q30', 'P1'));
    expect(world.calls.approve).toBe(0);
    expect((await admissions.getByRequestId('Q30', db))?.state).toBe('refused');
    const reply = replyFor(world, 'cmd-q30');
    expect(reply).toMatchObject({
      status: 503,
      code: 'failed_before_effect',
      error_class: 'GitHubRequestError',
    });
    expect(JSON.stringify(reply)).not.toContain('api.github.com');
    expect(world.acked).toContain('cmd-q30');
    expect(await admissions.findRunLockHolder('P1', undefined, db)).toBeNull();
  });

  test('(b) approve throws after writing approval_received -> unknown, run lock held', async () => {
    const world = makeWorld({ ...BASE_ENV });
    setupApprovableP1(world);
    await seedAdmittedFire('t3-bridge', 'WO-P1', 'P1', 'fire-P1');
    world.deps.approveRun = async () => {
      world.calls.approve += 1;
      world.approvedRuns.add('P1'); // the approval_received event was written
      throw new Error('resume dispatch crashed');
    };
    await processCommand(world.deps, approveMsg('cmd-q31', 'Q31', 'P1'));
    expect((await admissions.getByRequestId('Q31', db))?.state).toBe('unknown');
    expect(replyFor(world, 'cmd-q31')).toMatchObject({ status: 409, code: 'admission_unknown' });
    const holder = await admissions.findRunLockHolder('P1', undefined, db);
    expect(holder?.request_id).toBe('Q31');
    await processCommand(world.deps, approveMsg('cmd-q31b', 'Q31B', 'P1'));
    expect(replyFor(world, 'cmd-q31b')).toMatchObject({ status: 409, code: 'admission_unknown' });
    expect(world.calls.approve).toBe(1);
  });

  test('(c) a retry during a held approve gets 202 pending', async () => {
    const world = makeWorld({ ...BASE_ENV });
    setupApprovableP1(world);
    await seedAdmittedFire('t3-bridge', 'WO-P1', 'P1', 'fire-P1');
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    world.deps.approveRun = async () => {
      world.calls.approve += 1;
      await gate;
      return { ok: true, kind: 'approved', workflowName: 'wf', autoResumed: true };
    };
    const original = processCommand(world.deps, approveMsg('cmd-q32', 'Q32', 'P1'));
    await new Promise(resolve => setTimeout(resolve, 20));
    await processCommand(world.deps, approveMsg('cmd-q32-retry', 'Q32', 'P1'));
    expect(replyFor(world, 'cmd-q32-retry')).toMatchObject({ status: 202, code: 'pending' });
    release();
    await original;
    expect(replyFor(world, 'cmd-q32')).toMatchObject({ status: 200, code: 'approved' });
    expect(world.calls.approve).toBe(1);
  });

  test('(d) stale approve with effect marker and no approval event -> unknown, replied once', async () => {
    const world = makeWorld({ ...BASE_ENV });
    await admissions.reserveAdmission(
      {
        request_id: 'Q33',
        actor_principal_id: 't3-bridge',
        verb: 'approve',
        payload_sha256: 'd',
        project: 'bdc-harness',
        target_run_id: 'P1',
        source_message_id: 'cmd-q33',
        now: T0,
      },
      db
    );
    await admissions.markEffectStarted('Q33', T0, db);
    world.deps.now = STALE_NOW;
    await recoverStaleReservations(world.deps);
    expect((await admissions.getByRequestId('Q33', db))?.state).toBe('unknown');
    expect(world.replies.filter(r => r.idempotencyKey === 'reply:cmd-q33')).toHaveLength(1);
    expect(replyFor(world, 'cmd-q33')).toMatchObject({ status: 409, code: 'admission_unknown' });
    expect(world.acked).toEqual(['cmd-q33']);
    expect(world.calls.approve).toBe(0);
  });
});

describe('Test 16: stranded commands cannot starve the page', () => {
  test('60 rows that throw before effect are all answered; a valid fire is then admitted', async () => {
    const world = makeWorld({ ...BASE_ENV });
    world.projectRepos.set('bdc-harness', 'thinmansoftware/bdc-harness');
    world.deps.checkFireEligibility = async woId => {
      if (woId.startsWith('WO-BAD-')) throw new GitHubRequestError('issue read failed');
      return { eligible: true };
    };
    for (let i = 1; i <= 60; i += 1) {
      world.queue.push(fireMsg(`cmd-bad-${i}`, `BAD-${i}`, `WO-BAD-${i}`));
    }
    for (let guard = 0; guard < 10; guard += 1) {
      const before = world.acked.length;
      await tickCauldronFireConsumer(world.deps);
      if (world.acked.length === before) break;
    }
    expect(world.acked).toHaveLength(60);
    for (let i = 1; i <= 60; i += 1) {
      expect(replyFor(world, `cmd-bad-${i}`)).toMatchObject({
        status: 503,
        code: 'failed_before_effect',
      });
    }
    world.queue.push(fireMsg('cmd-good', 'GOOD', 'WO-GOOD'));
    await tickCauldronFireConsumer(world.deps);
    expect(replyFor(world, 'cmd-good')).toMatchObject({ status: 200, code: 'ok' });
    expect((await admissions.getByRequestId('GOOD', db))?.state).toBe('admitted');
  });
});

describe('Amendment 3: run custody follows the cascade across tiers', () => {
  type CascadeImpl = Parameters<typeof fireCascadeUntilRunDiscovered>[0];
  type CascadeOpts = Parameters<CascadeImpl>[0];

  test('Test 17: tier 1 fails, tier 2 runs; the submitter owns T2, another principal does not', async () => {
    const world = makeWorld({ ...BASE_ENV });
    world.projectRepos.set('bdc-harness', 'thinmansoftware/bdc-harness');
    const impl = (async (opts: CascadeOpts) => {
      opts.onRunDiscovered?.('T1', `C-${opts.woId}`, 'zero'); // tier 1: fails, climbs
      opts.onRunDiscovered?.('T2', `C-${opts.woId}`, 'cursor'); // tier 2: running / paused
      await new Promise<void>(() => undefined);
      return {} as never;
    }) as unknown as CascadeImpl;
    world.deps.fireCascade = async input => {
      world.calls.fire += 1;
      return fireCascadeUntilRunDiscovered(
        impl,
        async () => null,
        { woId: input.woId, project: input.project, dispatchId: input.dispatchId },
        input.onRunDiscovered
      );
    };
    await processCommand(world.deps, fireMsg('cmd-t17', 'T17', 'WO-T'));
    await new Promise(resolve => setTimeout(resolve, 20)); // custody appends settle
    expect(replyFor(world, 'cmd-t17')).toMatchObject({ status: 200, code: 'ok', run_id: 'T1' });
    const custody = await admissions.listRunCustody('T17', db);
    expect(custody.map(row => [row.run_id, row.tier])).toEqual([
      ['T1', 'zero'],
      ['T2', 'cursor'],
    ]);

    // Bindings for approving T2 (paused at its gate).
    world.runRepos.set('T2', 'thinmansoftware/bdc-harness');
    world.runBranches.set('T2', 'feat/x');
    world.prs.set('thinmansoftware/bdc-harness#5', {
      open: true,
      headRepo: 'thinmansoftware/bdc-harness',
      baseRepo: 'thinmansoftware/bdc-harness',
      headRef: 'feat/x',
      baseRef: 'dev',
      headSha: SHA_CURRENT,
    });

    // (c) another allowlisted principal: forbidden, no effect.
    const p2Cancel = makeMessage({
      id: 'cmd-t17-p2c',
      idempotencyKey: 'T17-P2C',
      sender: 'p2',
      principal: 'p2',
      body: cmdBody({
        request_id: 'T17-P2C',
        verb: 'cancel-own',
        project: 'bdc-harness',
        run_id: 'T2',
      }),
    });
    const p2Approve = makeMessage({
      id: 'cmd-t17-p2a',
      idempotencyKey: 'T17-P2A',
      sender: 'p2',
      principal: 'p2',
      body: cmdBody({
        request_id: 'T17-P2A',
        verb: 'approve',
        project: 'bdc-harness',
        run_id_for_approve: 'T2',
        pr: 'thinmansoftware/bdc-harness#5',
        head_sha: SHA_CURRENT,
      }),
    });
    await processCommand(world.deps, p2Cancel);
    await processCommand(world.deps, p2Approve);
    expect(JSON.parse(world.replyById.get('reply:cmd-t17-p2c')!.body)).toMatchObject({
      status: 403,
      code: 'forbidden_not_own_run',
    });
    expect(JSON.parse(world.replyById.get('reply:cmd-t17-p2a')!.body)).toMatchObject({
      status: 403,
      code: 'forbidden_not_own_run',
    });
    expect(world.calls.cancel).toBe(0);
    expect(world.calls.approve).toBe(0);

    // (b) the submitter approves the tier-2 run, then (a) cancels it.
    await processCommand(world.deps, approveMsg('cmd-t17-a', 'T17-A', 'T2'));
    expect(replyFor(world, 'cmd-t17-a')).toMatchObject({ status: 200, code: 'approved' });
    await processCommand(world.deps, cancelMsg('cmd-t17-c', 'T17-C', 'T2'));
    expect(replyFor(world, 'cmd-t17-c')).toMatchObject({ status: 200, code: 'ok', run_id: 'T2' });
    expect(world.calls.approve).toBe(1);
    expect(world.calls.cancel).toBe(1);
    expect(world.cancelActors).toEqual(['t3-bridge']);
  });

  test('Test 18: a run missing from custody is resolved once from the cascade record, then appended', async () => {
    const world = makeWorld({ ...BASE_ENV });
    world.projectRepos.set('bdc-harness', 'thinmansoftware/bdc-harness');
    await seedAdmittedFire('t3-bridge', 'WO-F18', 'T3-FIRST', 'fire-18');
    world.cascadeRuns.set('C-WO-F18', ['T3-FIRST', 'T3']);
    expect(await admissions.hasRunCustody('T3', db)).toBe(false);

    await processCommand(world.deps, cancelMsg('cmd-t18', 'T18', 'T3'));
    expect(replyFor(world, 'cmd-t18')).toMatchObject({ status: 200, code: 'ok', run_id: 'T3' });
    expect(world.cascadeReads).toBe(1);
    const custody = await admissions.listRunCustody('fire-18', db);
    expect(custody.map(row => row.run_id)).toEqual(['T3']);

    // Custody now answers directly: no second fallback read.
    expect(await admissions.ownsRun('t3-bridge', 'T3', db)).toBe(true);
    // A run already in someone's custody never falls back for another actor.
    expect(await admissions.ownsRun('p2', 'T3', db)).toBe(false);
  });
});

describe('Amendment 4', () => {
  test('Test 19: cancel-own is bound to the run recorded project, not the request', async () => {
    const world = makeWorld({ ...BASE_ENV, T3_COMMAND_PROJECTS: 'bdc-harness' });
    world.projectRepos.set('bdc-harness', 'thinmansoftware/bdc-harness');
    world.projectRepos.set('lspro-react', 'thinmansoftware/lspro-react');
    await admissions.reserveAdmission(
      {
        request_id: 'fire-R7',
        actor_principal_id: 't3-bridge',
        verb: 'fire',
        payload_sha256: 'seed',
        wo_id: 'WO-R7',
        project: 'lspro-react',
        source_message_id: 'seed-R7',
        now: T0,
      },
      db
    );
    await admissions.markAdmitted(
      'fire-R7',
      { status_code: 200, code: 'ok', cascade_id: 'C-R7', run_id: 'R7', now: T0 },
      db
    );

    // (a) lspro-react was removed from the allowlist; the request names an allowed project.
    await processCommand(world.deps, cancelMsg('cmd-q19a', 'Q19A', 'R7'));
    const a = replyFor(world, 'cmd-q19a');
    expect(a.status).toBe(403);
    expect(['project_mismatch', 'project_not_allowed']).toContain(a.code as string);

    // (b) lspro-react allowlisted again, request still names bdc-harness.
    world.deps.env = { ...world.deps.env, T3_COMMAND_PROJECTS: 'bdc-harness,lspro-react' };
    await processCommand(world.deps, cancelMsg('cmd-q19b', 'Q19B', 'R7'));
    expect(replyFor(world, 'cmd-q19b')).toMatchObject({ status: 403, code: 'project_mismatch' });

    expect(world.calls.cancel).toBe(0);
  });

  test('Test 20: a re-read source row gets no reply; recovery later delivers the final outcome', async () => {
    const world = makeWorld({ ...BASE_ENV });
    world.projectRepos.set('bdc-harness', 'thinmansoftware/bdc-harness');
    const source = fireMsg('cmd-q40', 'Q40', 'WO-Q40');
    const cmd = JSON.parse(source.body) as T3Command;
    await admissions.reserveAdmission(
      {
        request_id: 'Q40',
        actor_principal_id: 't3-bridge',
        verb: 'fire',
        payload_sha256: canonicalDigest(cmd),
        wo_id: 'WO-Q40',
        project: 'bdc-harness',
        thread_id: 'th-1',
        source_message_id: 'cmd-q40',
        now: T0,
      },
      db
    );
    await admissions.markEffectStarted('Q40', T0, db);
    world.queue.push(source);

    // Restart: a fresh tick re-reads the still-queued source row before staleness.
    await tickCauldronFireConsumer(world.deps);
    expect(world.replyById.has('reply:cmd-q40')).toBe(false);
    expect(world.acked).not.toContain('cmd-q40');
    expect(world.calls.fire).toBe(0);

    // The reservation goes stale; recovery owns the source row's final reply.
    world.deps.now = STALE_NOW;
    await tickCauldronFireConsumer(world.deps);
    const reply = replyFor(world, 'cmd-q40');
    expect(reply.status).not.toBe(202);
    expect(reply).toMatchObject({ status: 409, code: 'admission_unknown' });
    expect(world.acked).toContain('cmd-q40');
    expect(world.replies.filter(r => r.idempotencyKey === 'reply:cmd-q40')).toHaveLength(1);
    expect(world.calls.fire).toBe(0);
  });
});
