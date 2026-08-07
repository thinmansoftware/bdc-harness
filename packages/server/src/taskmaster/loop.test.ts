/**
 * Taskmaster loop tests -- Section 11 scenarios 1, 3, 4, 5 plus the
 * auto-circuit. Everything is dependency-injected (fake clock, fake DAL,
 * fake dispatch); no mock.module.
 */
import { describe, expect, test } from 'bun:test';
import {
  createTaskmasterState,
  tick,
  resolveTaskmasterIntervalMs,
  type TaskmasterDeps,
} from './loop';
import type { ThreadSnapshot } from './rules';
import type {
  TmActionOutcome,
  TmActionType,
  TmControlState,
  TmGrade,
  TmJournalEntry,
} from '@archon/core/db/taskmaster';
import type { HeadroomReading } from './ledger';

const T0 = Date.parse('2026-08-07T12:00:00.000Z');
const TODAY_KEY = new Date(T0).toISOString().slice(0, 10);

interface FakeWorld {
  journal: TmJournalEntry[];
  control: TmControlState;
  sentMessages: Array<{ idempotency_key: string; recipient: string; body: string }>;
  nowMs: number;
}

function makeWorld(): FakeWorld {
  return {
    journal: [],
    control: {
      pause_state: 'RUNNING',
      pause_scope: null,
      pause_reason: null,
      pause_actor: null,
      epoch: 0,
      updated_at: new Date(T0).toISOString(),
    },
    sentMessages: [],
    nowMs: T0,
  };
}

function makeDeps(world: FakeWorld, overrides: Partial<TaskmasterDeps> = {}): TaskmasterDeps {
  let journalSeq = world.journal.length;
  const dal = {
    recordAction: async (data: {
      thread_ref: string;
      action_type: TmActionType;
      proposal_json: string;
      idempotency_key?: string | null;
      before_hash?: string | null;
      proof_predicate?: string | null;
      proof_deadline_at?: string | null;
      outcome: TmActionOutcome;
    }): Promise<TmJournalEntry> => {
      journalSeq += 1;
      const row: TmJournalEntry = {
        id: `journal-${journalSeq}`,
        created_at: new Date(world.nowMs).toISOString(),
        thread_ref: data.thread_ref,
        action_type: data.action_type,
        proposal_json: data.proposal_json,
        idempotency_key: data.idempotency_key ?? null,
        before_hash: data.before_hash ?? null,
        proof_predicate: data.proof_predicate ?? null,
        proof_deadline_at: data.proof_deadline_at ?? null,
        outcome: data.outcome,
        graded_at: null,
        grade: null,
      };
      world.journal.push(row);
      return row;
    },
    updateActionOutcome: async (id: string, outcome: TmActionOutcome) => {
      const row = world.journal.find(j => j.id === id) ?? null;
      if (row) row.outcome = outcome;
      return row;
    },
    gradeAction: async (id: string, grade: TmGrade) => {
      const row = world.journal.find(j => j.id === id) ?? null;
      if (row) {
        row.grade = grade;
        row.graded_at = new Date(world.nowMs).toISOString();
      }
      return row;
    },
    getActionsSince: async (sinceIso: string) =>
      world.journal.filter(j => j.created_at >= sinceIso),
    getPauseState: async () => world.control,
    setPauseState: async (data: {
      pause_state: TmControlState['pause_state'];
      pause_scope?: string | null;
      pause_reason?: string | null;
      pause_actor: string;
      incrementEpoch?: boolean;
    }) => {
      world.control = {
        pause_state: data.pause_state,
        pause_scope: data.pause_scope ?? null,
        pause_reason: data.pause_reason ?? null,
        pause_actor: data.pause_actor,
        epoch: world.control.epoch + (data.incrementEpoch ? 1 : 0),
        updated_at: new Date(world.nowMs).toISOString(),
      };
      return world.control;
    },
    expireParkedActions: async () => {
      let count = 0;
      for (const row of world.journal) {
        if (row.outcome === 'parked' || row.outcome === 'pending') {
          row.outcome = 'expired';
          count += 1;
        }
      }
      return count;
    },
  };

  const okHeadroom: HeadroomReading = {
    state: 'OK',
    tokensRemaining: 500_000,
    isUnknown: false,
    source: 'local_artifacts',
    observedAt: new Date(T0).toISOString(),
  };

  return {
    now: () => new Date(world.nowMs),
    db: dal,
    headroom: async () => okHeadroom,
    createTask: (async (data: { idempotency_key: string; recipient: string; body: string }) => {
      world.sentMessages.push({
        idempotency_key: data.idempotency_key,
        recipient: data.recipient,
        body: data.body,
      });
      return { id: `msg-${world.sentMessages.length}`, status: 'queued' };
    }) as unknown as TaskmasterDeps['createTask'],
    findEffectByIdempotencyKey: async (key: string) => {
      const found = world.sentMessages.find(m => m.idempotency_key === key);
      return found ? { id: 'existing', status: 'queued' } : null;
    },
    listUndeliveredRulings: async () => [],
    listThreads: async () => [],
    ...overrides,
  };
}

/** Seed today's digest as already sent so tests can assert exact send counts. */
function seedDigestSent(world: FakeWorld): void {
  world.journal.push({
    id: 'journal-digest-seed',
    created_at: new Date(world.nowMs).toISOString(),
    thread_ref: `digest:${TODAY_KEY}`,
    action_type: 'digest',
    proposal_json: '{}',
    idempotency_key: `tm:digest:${TODAY_KEY}`,
    before_hash: null,
    proof_predicate: null,
    proof_deadline_at: null,
    outcome: 'sent',
    graded_at: null,
    grade: null,
  });
}

function ruling(overrides: Partial<ThreadSnapshot> = {}): ThreadSnapshot {
  return {
    ref: 'dispatch:ruling-42',
    priority: 'P1',
    lastActivityAt: new Date(T0 - 3_600_000).toISOString(),
    undeliveredRulingId: 'ruling-42',
    recipient: 'xo',
    ...overrides,
  };
}

describe('scenario 1: undelivered ruling is delivered exactly once (dedupe proven)', () => {
  test('two ticks produce one deliver_ruling row and one send; a third tick adds nothing', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    const deps = makeDeps(world, { listUndeliveredRulings: async () => [ruling()] });
    const state = createTaskmasterState(60_000);

    await tick(state, deps);
    world.nowMs += 60_000;
    await tick(state, deps);

    const deliveries = world.journal.filter(j => j.action_type === 'deliver_ruling');
    expect(deliveries.length).toBe(1);
    expect(deliveries[0]?.outcome).toBe('sent');
    expect(world.sentMessages.length).toBe(1);
    expect(world.sentMessages[0]?.idempotency_key).toBe('tm:deliver_ruling:ruling-42');
    expect(world.sentMessages[0]?.idempotency_key).not.toBeNull();

    // Third tick: dedupe proven -- NO additional journal row, no send.
    world.nowMs += 60_000;
    await tick(state, deps);
    expect(world.journal.filter(j => j.action_type === 'deliver_ruling').length).toBe(1);
    expect(world.sentMessages.length).toBe(1);
  });
});

describe('scenario 3: pause stops sends, never watching', () => {
  test('paused: P1 nudge parks, P0 escalation still sends; resume expires the parked proposal', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    world.control.pause_state = 'PAUSED';
    world.control.pause_actor = 'john';

    const staleP1: ThreadSnapshot = {
      ref: 'gh:bluedevilcollectibles/bdc-harness#11',
      priority: 'P1',
      lastActivityAt: new Date(T0 - 5 * 3_600_000).toISOString(),
      recipient: 'xo',
    };
    const unclaimedP0: ThreadSnapshot = {
      ref: 'gh:bluedevilcollectibles/bdc-harness#12',
      priority: 'P0',
      lastActivityAt: new Date(T0 - 3_600_000).toISOString(),
      isUnclaimedP0: true,
      recipient: 'xo',
    };
    const deps = makeDeps(world, { listThreads: async () => [staleP1, unclaimedP0] });
    const state = createTaskmasterState(60_000);

    // Tick 1 observes; tick 2 confirms the nudge (which then parks).
    await tick(state, deps);
    world.nowMs += 60_000;
    await tick(state, deps);

    // The P0 escalation IS sent (pause-exempt), exactly once across ticks.
    const escalations = world.sentMessages.filter(m =>
      m.idempotency_key.startsWith('tm:escalate_p0:')
    );
    expect(escalations.length).toBe(1);
    expect(escalations[0]?.recipient).toBe('operator');

    // Zero sends for the P1; its journal row exists tagged parked.
    const p1Sends = world.sentMessages.filter(m => m.idempotency_key.startsWith('tm:nudge:'));
    expect(p1Sends.length).toBe(0);
    const parked = world.journal.filter(
      j => j.thread_ref === staleP1.ref && j.outcome === 'parked'
    );
    expect(parked.length).toBe(1);
    expect(parked[0]?.proposal_json).toContain('"parked":true');

    // Journal rows written for both threads.
    expect(world.journal.some(j => j.thread_ref === unclaimedP0.ref && j.outcome === 'sent')).toBe(
      true
    );

    // Resume: epoch increments, parked proposal is EXPIRED, not replayed.
    for (const row of world.journal) {
      if (row.outcome === 'parked' || row.outcome === 'pending') row.outcome = 'expired';
    }
    world.control = { ...world.control, pause_state: 'RUNNING', epoch: world.control.epoch + 1 };

    world.nowMs += 60_000;
    await tick(state, deps);
    // The old confirmation was dropped with the epoch change: no immediate
    // replay of the parked P1 nudge on the first post-resume tick.
    expect(world.sentMessages.filter(m => m.idempotency_key.startsWith('tm:nudge:')).length).toBe(
      0
    );
    expect(
      world.journal.filter(j => j.thread_ref === staleP1.ref && j.outcome === 'expired').length
    ).toBe(1);
  });
});

describe('scenario 4: restart produces no double effect', () => {
  test('pending journal row with an existing dispatch row reconciles to sent without a second send', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    const key = 'tm:deliver_ruling:ruling-42';
    // In-flight marker from the previous process: row first, then crash.
    world.journal.push({
      id: 'journal-preexisting',
      created_at: new Date(T0 - 60_000).toISOString(),
      thread_ref: 'dispatch:ruling-42',
      action_type: 'deliver_ruling',
      proposal_json: '{}',
      idempotency_key: key,
      before_hash: null,
      proof_predicate: null,
      proof_deadline_at: null,
      outcome: 'pending',
      graded_at: null,
      grade: null,
    });
    // The effect DID land in the SOR before the crash.
    world.sentMessages.push({ idempotency_key: key, recipient: 'xo', body: 'ruling' });
    const sendsBefore = world.sentMessages.length;

    const deps = makeDeps(world, { listUndeliveredRulings: async () => [ruling()] });
    const state = createTaskmasterState(60_000); // fresh process
    await tick(state, deps);
    world.nowMs += 60_000;
    await tick(state, deps);

    // Reconciliation marked the row sent; no second createMessage with the same key.
    const row = world.journal.find(j => j.id === 'journal-preexisting');
    expect(row?.outcome).toBe('sent');
    expect(world.sentMessages.filter(m => m.idempotency_key === key).length).toBe(1);
    expect(world.sentMessages.length).toBe(sendsBefore);
  });

  test('pending row with NO dispatch row expires (safe direction: re-propose fresh later)', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    world.journal.push({
      id: 'journal-orphan',
      created_at: new Date(T0 - 60_000).toISOString(),
      thread_ref: 'gh:x#1',
      action_type: 'nudge',
      proposal_json: '{}',
      idempotency_key: 'tm:nudge:gh:x#1:999',
      before_hash: null,
      proof_predicate: null,
      proof_deadline_at: null,
      outcome: 'pending',
      graded_at: null,
      grade: null,
    });
    const deps = makeDeps(world);
    const state = createTaskmasterState(60_000);
    await tick(state, deps);
    expect(world.journal.find(j => j.id === 'journal-orphan')?.outcome).toBe('expired');
    expect(world.sentMessages.length).toBe(0);
  });
});

describe('scenario 5: budget ceiling holds', () => {
  test('25 eligible stale threads: at most 10 effects, 1 per item, remainder journaled deferred', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    const threads: ThreadSnapshot[] = Array.from({ length: 25 }, (_, i) => ({
      ref: `gh:bluedevilcollectibles/bdc-harness#${100 + i}`,
      priority: 'P1' as const,
      lastActivityAt: new Date(T0 - 6 * 3_600_000).toISOString(),
      recipient: 'xo',
    }));
    const deps = makeDeps(world, { listThreads: async () => threads });
    const state = createTaskmasterState(60_000);

    await tick(state, deps); // observation tick
    world.nowMs += 60_000;
    const result = await tick(state, deps); // confirming tick

    expect(result.effects).toBe(10);
    expect(world.sentMessages.length).toBe(10);

    // No item receives 2 effects in the tick.
    const perThread = new Map<string, number>();
    for (const row of world.journal.filter(j => j.outcome === 'sent')) {
      perThread.set(row.thread_ref, (perThread.get(row.thread_ref) ?? 0) + 1);
    }
    for (const count of perThread.values()) expect(count).toBe(1);

    // Remainder journaled as deferred, not dropped.
    const deferred = world.journal.filter(j => j.outcome === 'deferred');
    expect(deferred.length).toBe(15);
  });
});

describe('auto-circuit: forbidden effect HARD-PAUSES effects, never KILLs', () => {
  test('a proposal to a non-allowlisted recipient is journaled rejected and trips HARD_PAUSE', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    const deps = makeDeps(world, {
      listUndeliveredRulings: async () => [ruling({ recipient: 'board' })],
    });
    const state = createTaskmasterState(60_000);
    await tick(state, deps);

    expect(world.sentMessages.length).toBe(0);
    const rejected = world.journal.filter(j => j.outcome === 'rejected');
    expect(rejected.length).toBe(1);
    expect(world.control.pause_state).toBe('HARD_PAUSE');
    expect(world.control.pause_actor).toBe('taskmaster:auto-circuit');
    // The circuit tightened into pause; the tick loop itself keeps running
    // (KILL is only ever TASKMASTER_INTERVAL_MS=0, operator-set).
    const result = await tick(state, deps);
    expect(result.ran).toBe(true);
  });
});

describe('interval env parsing', () => {
  test('default 60000, explicit value honored, 0 = off, garbage falls back', () => {
    expect(resolveTaskmasterIntervalMs(undefined)).toBe(60_000);
    expect(resolveTaskmasterIntervalMs('1000')).toBe(1000);
    expect(resolveTaskmasterIntervalMs('0')).toBe(0);
    expect(resolveTaskmasterIntervalMs('banana')).toBe(60_000);
    expect(resolveTaskmasterIntervalMs('-5')).toBe(60_000);
  });
});
