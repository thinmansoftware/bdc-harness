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
  recoverReservedFires,
  startCauldronFireConsumer,
  stopCauldronFireConsumer,
  cauldronFireConsumerEnabled,
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
    approveResult: { ok: true, kind: 'approved', workflowName: 'wf', autoResumed: false },
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
      return (
        world.fireResults.get(input.woId) ?? {
          cascadeId: `C-${input.woId}`,
          status: 'running',
          runId: `R-${input.woId}`,
        }
      );
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

function parseReply(record: ReplyRecord): { status: number; code: string; run_id: string | null } {
  return JSON.parse(record.body) as { status: number; code: string; run_id: string | null };
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

    await recoverReservedFires(world.deps);

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
