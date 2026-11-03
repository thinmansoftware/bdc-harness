/**
 * WO-HARNESS-T3-COMMAND-CONSUMER-01 Amendment 5: production dependencies under
 * test against the real SQLite adapter (A5.15 / Test 33), second-resolution
 * proofs (Test 30), the widened live-run query (Test 23), and the shared WO
 * claim between a Taskmaster cascade and a T3 cascade (A5.0 / Test 24).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createHash, randomUUID } from 'crypto';
import { mkdirSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SqliteAdapter, sqliteDialect } from '@archon/core/db/adapters/sqlite';

let db: SqliteAdapter;
let dbPath = '';

mock.module('@archon/core/db/connection', () => ({
  getDatabase: () => db,
  getDatabaseType: () => 'sqlite',
  getDialect: () => sqliteDialect,
  pool: {
    query: (sql: string, params?: unknown[]) => db.query(sql, params as never),
    end: async () => undefined,
  },
  closeDatabase: async () => undefined,
  resetDatabase: () => undefined,
}));

import * as conversationsDb from '@archon/core/db/conversations';
import * as workflowsDb from '@archon/core/db/workflows';
import * as workflowEventsDb from '@archon/core/db/workflow-events';
import * as claims from '@archon/core/db/cascade-wo-claims';
import { runCascade } from '@archon/smart-cauldron/cascade';
import type { CascadeDeps } from '@archon/smart-cauldron/cascade';
import type { DispatchMessage } from '@archon/core/db/dispatch';
import {
  createRealCauldronFireConsumerDeps,
  findLiveRunForWo,
  mapPullRequest,
  processCommand,
  NON_TERMINAL_RUN_STATUSES,
  type CauldronFireConsumerDeps,
} from '../dispatch/cauldron-fire-consumer';
import { cascadeWoClaimDeps } from '../cascade/wo-claim';

function cleanupDb(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(path + suffix);
    } catch {
      /* file may not exist */
    }
  }
}

const ENV = {
  T3_COMMAND_CONSUMER_ENABLED: '1',
  T3_COMMAND_ACTORS: 't3-bridge',
  T3_COMMAND_PROJECTS: 'bdc-harness',
  DISPATCH_PRINCIPALS_JSON: JSON.stringify([
    {
      credential_id: 't3-bridge-1',
      principal_id: 't3-bridge',
      token_sha256: 'a'.repeat(64),
      status: 'active',
      send_as: ['t3-bridge'],
      receive_as: ['t3-desktop'],
      roles: ['send', 'receive'],
    },
    {
      credential_id: 'old-1',
      principal_id: 'old-bridge',
      token_sha256: 'b'.repeat(64),
      status: 'disabled',
      send_as: ['old-bridge'],
      receive_as: ['old-desktop'],
      roles: ['send', 'receive'],
    },
  ]),
};

function realDeps(env: Record<string, string | undefined> = ENV): CauldronFireConsumerDeps {
  return createRealCauldronFireConsumerDeps(
    env,
    (async () => new Response('unused', { status: 500 })) as unknown as typeof fetch
  );
}

async function makeRun(woId: string, status: string, metadata: Record<string, unknown> = {}) {
  const conversation = await conversationsDb.getOrCreateConversation('web', `web-${randomUUID()}`);
  const run = await workflowsDb.createWorkflowRun({
    workflow_name: 'wf',
    conversation_id: conversation.id,
    user_message: `WO_ID=${woId} --project bdc-harness`,
    metadata,
  });
  await db.query('UPDATE remote_agent_workflow_runs SET status = $1 WHERE id = $2', [
    status,
    run.id,
  ]);
  return run.id;
}

beforeEach(() => {
  dbPath = join(tmpdir(), `t3-real-deps-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  db = new SqliteAdapter(dbPath);
});

afterEach(async () => {
  await db.close();
  cleanupDb(dbPath);
});

describe('Test 23 / 33: live-run query on the real store', () => {
  test('every non-terminal status is live; a fresh approval hand-off is live; terminal is not', async () => {
    const nowMs = Date.now();
    for (const [index, status] of NON_TERMINAL_RUN_STATUSES.entries()) {
      const woId = `WO-LIVE-${index + 1}`;
      const runId = await makeRun(woId, status);
      expect(await findLiveRunForWo(db, woId, ENV, nowMs)).toEqual({ live: true, runId });
    }
    const handOff = await makeRun('WO-HAND-01', 'failed');
    await workflowEventsDb.createWorkflowEvent({
      workflow_run_id: handOff,
      event_type: 'approval_received',
      step_name: 'gate',
      data: {},
    });
    expect(await findLiveRunForWo(db, 'WO-HAND-01', ENV, Date.now())).toEqual({
      live: true,
      runId: handOff,
    });
    // Past the bound it is a real failure.
    expect((await findLiveRunForWo(db, 'WO-HAND-01', ENV, Date.now() + 10 * 60_000)).live).toBe(
      false
    );
    await makeRun('WO-FAILED-01', 'failed');
    await makeRun('WO-DONE-01', 'completed');
    expect((await findLiveRunForWo(db, 'WO-FAILED-01', ENV, nowMs)).live).toBe(false);
    expect((await findLiveRunForWo(db, 'WO-DONE-01', ENV, nowMs)).live).toBe(false);
    // Token match, not substring.
    await makeRun('WO-PRE-10', 'running');
    expect((await findLiveRunForWo(db, 'WO-PRE-1', ENV, nowMs)).live).toBe(false);
  });
});

describe('Test 30 / 33: recovery proofs on the real store (second-resolution UTC)', () => {
  test('approve and cancel proofs hold for events in the same second as the marker', async () => {
    const deps = realDeps();
    const runId = await makeRun('WO-PROOF-01', 'failed');
    const marker = new Date().toISOString(); // millisecond ISO, written just before
    await workflowEventsDb.createWorkflowEvent({
      workflow_run_id: runId,
      event_type: 'approval_received',
      step_name: 'gate',
      data: {},
    });
    expect(await deps.proveApprove(runId, marker)).toBe(true);
    expect(await deps.proveApprove(runId, new Date(Date.now() + 3_600_000).toISOString())).toBe(
      false
    );

    const cancelled = await makeRun('WO-PROOF-02', 'cancelled');
    await workflowEventsDb.createWorkflowEvent({
      workflow_run_id: cancelled,
      event_type: 'run_cancelled',
      data: { reason: 'T3 cancel-own', actor: 't3-bridge' },
    });
    expect(await deps.proveCancel(cancelled, 't3-bridge')).toBe(true);
    expect(await deps.proveCancel(cancelled, 'p2')).toBe(false);
    const stillRunning = await makeRun('WO-PROOF-03', 'running');
    expect(await deps.proveCancel(stillRunning, 't3-bridge')).toBe(false);
  });

  test('fire custody proof reads the cascade record and checks the run names the WO', async () => {
    const deps = realDeps();
    const runId = await makeRun('WO-CUST-01', 'running');
    const work = join(tmpdir(), `t3-cascade-${randomUUID()}`);
    const digest = createHash('sha256').update('disp-cust').digest('hex').slice(0, 24);
    mkdirSync(join(work, 'cascade-runs', `dispatch-${digest}`), { recursive: true });
    writeFileSync(
      join(work, 'cascade-runs', `dispatch-${digest}`, 'cascade-record.json'),
      JSON.stringify({ cascadeId: 'disp-cust', attempts: [{ runId }, { runId: 'later-run' }] })
    );
    const cwd = process.cwd();
    process.chdir(work);
    try {
      const row = { request_id: 'disp-cust', cascade_id: 'disp-cust', wo_id: 'WO-CUST-01' };
      const proof = await deps.proveFireCustody(row as never);
      expect(proof).toEqual({ runId, cascadeId: 'disp-cust', runIds: [runId, 'later-run'] });
      expect(await deps.proveFireCustody({ ...row, wo_id: 'WO-OTHER-01' } as never)).toBeNull();
    } finally {
      process.chdir(cwd);
      rmSync(work, { recursive: true, force: true });
    }
  });
});

describe('Test 33: remaining production deps', () => {
  test('mailbox resolution, gate read, fresh-run lookup and PR mapping', async () => {
    const deps = realDeps();
    expect(deps.resolveActorMailbox('t3-bridge')).toBe('t3-desktop');
    expect(deps.resolveActorMailbox('old-bridge')).toBeNull(); // disabled credential
    expect(
      realDeps({ ...ENV, DISPATCH_PRINCIPALS_JSON: '{not json' }).resolveActorMailbox('t3-bridge')
    ).toBeNull();

    const paused = await makeRun('WO-GATE-01', 'paused', {
      approval: { nodeId: 'gate', type: 'approval', captureResponse: true },
    });
    expect(await deps.getRunApproval(paused)).toEqual({
      nodeId: 'gate',
      type: 'approval',
      captureResponse: true,
    });
    const running = await makeRun('WO-GATE-02', 'running', { approval: { nodeId: 'gate' } });
    expect(await deps.getRunApproval(running)).toBeNull();

    const since = new Date(Date.now() - 1000).toISOString();
    const fresh = await makeRun('WO-FRESH-01', 'running');
    expect(await deps.findRunsForWoSince('WO-FRESH-01', since)).toEqual([fresh]);
    expect(
      await deps.findRunsForWoSince('WO-FRESH-01', new Date(Date.now() + 3_600_000).toISOString())
    ).toEqual([]);

    expect(
      mapPullRequest({
        state: 'open',
        head: {
          ref: 'feat/x',
          sha: 'c'.repeat(40),
          repo: { full_name: 'ThinManSoftware/BDC-Harness' },
        },
        base: { ref: 'dev', repo: { full_name: 'thinmansoftware/bdc-harness' } },
      })
    ).toEqual({
      open: true,
      headRepo: 'thinmansoftware/bdc-harness',
      baseRepo: 'thinmansoftware/bdc-harness',
      headRef: 'feat/x',
      baseRef: 'dev',
      headSha: 'c'.repeat(40),
    });
    expect(
      mapPullRequest({
        state: 'closed',
        head: { ref: 'x', sha: 'd'.repeat(40), repo: null },
        base: { ref: 'dev', repo: { full_name: 'o/r' } },
      }).headRepo
    ).toBe('');
  });
});

describe('A5.0: a Taskmaster cascade and a T3 fire for the same WO cannot both proceed', () => {
  function stubCascadeDeps(fires: string[], tag: string): CascadeDeps {
    return {
      findWoClaim: async () => null,
      seatUsage: async () => {
        const reading = {
          limit_source: 'measured' as const,
          windows: [{ name: '5h', used_percent: 5 }],
        };
        return { claude: reading, codex: reading, cursor: reading };
      },
      fire: async () => {
        fires.push(tag);
        return { ok: true, runId: `${tag}-run`, conversationId: 'c', infraError: null };
      },
      // Terminal-state polling that does not finish while this test runs: the
      // cascade (and its claim) stays active.
      poll: () => new Promise(() => undefined),
      fetchNodeTimeouts: async () => ({}),
      writeRecord: async record => `/tmp/${record.cascadeId}.json`,
      escalate: async () => undefined,
      readRunDetail: async () => null,
    };
  }

  test('Taskmaster holds the claim: the T3 fire is refused and a T3 cascade is blocked; and the reverse', async () => {
    const outDir = join(tmpdir(), `t3-race-${randomUUID()}`);
    const fires: string[] = [];
    // A Taskmaster cascade (as loop.ts runs it: with cascadeWoClaimDeps('taskmaster')).
    let tmDiscovered = false;
    void runCascade({
      woId: 'WO-RACE-01',
      woClass: 'CODE',
      tags: ['mechanical'],
      outDir,
      token: 't',
      project: 'bdc-harness',
      dispatchId: 'tm-cascade-1',
      onRunDiscovered: () => {
        tmDiscovered = true;
      },
      deps: { ...stubCascadeDeps(fires, 'tm'), ...cascadeWoClaimDeps('taskmaster', db) },
    });
    for (let i = 0; i < 100 && !tmDiscovered; i += 1) await new Promise(r => setTimeout(r, 10));
    expect(tmDiscovered).toBe(true);
    expect((await claims.findActiveWoClaim('WO-RACE-01', db))?.holder).toBe('taskmaster');

    // T3 path 1: the consumer refuses before admission (shared claim pre-check).
    const replies: Record<string, unknown>[] = [];
    const t3Fires: string[] = [];
    const deps: CauldronFireConsumerDeps = {
      ...realDeps(),
      db,
      resolveProjectRepository: async () => 'thinmansoftware/bdc-harness',
      hasLiveWorkflowRun: async () => ({ live: false, runId: null }),
      checkFireEligibility: async woId => ({
        eligible: true,
        evidence: { woId, project: 'bdc-harness' },
      }),
      fireCascade: async () => {
        t3Fires.push('t3');
        return { cascadeId: 'x', status: 'running', runId: 'x' };
      },
      sendReply: async input => {
        replies.push(JSON.parse(input.body) as Record<string, unknown>);
        return { id: `rep-${replies.length}` } as DispatchMessage;
      },
      acknowledge: async () => undefined,
    };
    await processCommand(deps, {
      id: 'cmd-race',
      correlation_id: 'RACE',
      idempotency_key: 'RACE',
      sender: 't3-bridge',
      sender_principal_id: 't3-bridge',
      recipient: 'cauldron-fire',
      created_at: new Date().toISOString(),
      body: JSON.stringify({
        schema: 't3-command/v1',
        request_id: 'RACE',
        verb: 'fire',
        wo_id: 'WO-RACE-01',
        project: 'bdc-harness',
      }),
    } as unknown as DispatchMessage);
    expect(replies[0]).toMatchObject({ status: 409, code: 'live_run', cascade_id: 'tm-cascade-1' });
    expect(t3Fires).toHaveLength(0);

    // T3 path 2: even past the pre-check, the claim inside runCascade blocks it.
    const blocked = await runCascade({
      woId: 'WO-RACE-01',
      woClass: 'CODE',
      tags: ['mechanical'],
      outDir,
      token: 't',
      project: 'bdc-harness',
      dispatchId: 't3-cascade-1',
      deps: { ...stubCascadeDeps(fires, 't3'), ...cascadeWoClaimDeps('t3:test', db) },
    });
    expect(blocked.status).toBe('blocked');
    expect(blocked.attempts).toHaveLength(0);
    expect(fires).toEqual(['tm']);

    // Reverse: a T3 cascade holds a different WO; a Taskmaster cascade is blocked.
    let t3Discovered = false;
    void runCascade({
      woId: 'WO-RACE-02',
      woClass: 'CODE',
      tags: ['mechanical'],
      outDir,
      token: 't',
      project: 'bdc-harness',
      dispatchId: 't3-cascade-2',
      onRunDiscovered: () => {
        t3Discovered = true;
      },
      deps: { ...stubCascadeDeps(fires, 't3'), ...cascadeWoClaimDeps('t3:test', db) },
    });
    for (let i = 0; i < 100 && !t3Discovered; i += 1) await new Promise(r => setTimeout(r, 10));
    const tmBlocked = await runCascade({
      woId: 'WO-RACE-02',
      woClass: 'CODE',
      tags: ['mechanical'],
      outDir,
      token: 't',
      project: 'bdc-harness',
      dispatchId: 'tm-cascade-2',
      deps: { ...stubCascadeDeps(fires, 'tm'), ...cascadeWoClaimDeps('taskmaster', db) },
    });
    expect(tmBlocked.status).toBe('blocked');
    expect(fires).toEqual(['tm', 't3']);
    rmSync(outDir, { recursive: true, force: true });
  });
});
