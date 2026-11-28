/**
 * Shared Taskmaster loop test world: a fake world, a real SQLite fire budget and
 * the full fake dependency set for loop.tick. Moved out of loop.test.ts unchanged
 * (WO-HARNESS-TASKMASTER-NO-DAILY-FIRE-CAP-01, Stop 3) so daily-fire-cap.test.ts can
 * drive the same real tick. Test helper only (src/test/**).
 */
import { afterAll } from 'bun:test';
import { type TaskmasterDeps, type ListedThread } from '../taskmaster/loop';
import type { DispatchDeliveryMode } from '@archon/core/db/dispatch';
import {
  expectationRegistrationKey,
  type TmExpectation,
  type TmAdoptionRow,
} from '@archon/core/db/taskmaster';
import type {
  TmActionOutcome,
  TmActionType,
  TmControlState,
  TmGrade,
  TmJournalEntry,
} from '@archon/core/db/taskmaster';
import type { HeadroomReading } from '../taskmaster/ledger';
import { SqliteAdapter } from '@archon/core/db/adapters/sqlite';
import * as fireBudgetDb from '@archon/core/db/taskmaster';

export const T0 = Date.parse('2026-08-07T12:00:00.000Z');
export const TODAY_KEY = new Date(T0).toISOString().slice(0, 10);

export interface FakeWorld {
  expectations: Map<string, TmExpectation>;
  journal: TmJournalEntry[];
  control: TmControlState;
  sentMessages: Array<{
    idempotency_key: string;
    recipient: string;
    body: string;
    createdAt: string;
    // M-155 Amendment 03: optional ack timestamp for the sent dispatch row,
    // used by the default getDispatchMessageById mock to drive 'unheard' grading.
    acknowledged_at?: string | null;
  }>;
  nowMs: number;
  recordCalls: number;
  adoptionRows: TmAdoptionRow[];
  adoptionMeta: {
    committed_snapshot_id: string | null;
    rebuilt_at: string | null;
    row_count: number | null;
    source_commit: string | null;
    complete: number;
  };
}

export function makeWorld(): FakeWorld {
  return {
    expectations: new Map(),
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
    recordCalls: 0,
    adoptionRows: [],
    adoptionMeta: {
      committed_snapshot_id: null,
      rebuilt_at: null,
      row_count: null,
      source_commit: null,
      complete: 0,
    },
  };
}

export const budgetStores = new WeakMap<FakeWorld, SqliteAdapter>();
const openedBudgetStores: SqliteAdapter[] = [];
afterAll(async () => {
  for (const db of openedBudgetStores) await db.close();
});
export function fixtureFireBudget(world: FakeWorld): NonNullable<TaskmasterDeps['fireBudget']> {
  const database = async (): Promise<SqliteAdapter> => {
    let db = budgetStores.get(world);
    if (!db) {
      db = new SqliteAdapter(':memory:');
      budgetStores.set(world, db);
      openedBudgetStores.push(db);
    }
    await db.query('UPDATE tm_control SET pause_state=$1,epoch=$2 WHERE id=1', [
      world.control.pause_state,
      world.control.epoch,
    ]);
    for (const row of world.journal)
      await db.query(
        `INSERT INTO tm_journal(id,thread_ref,action_type,proposal_json,idempotency_key,outcome,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO UPDATE SET outcome=$6,proposal_json=$4`,
        [
          row.id,
          row.thread_ref,
          row.action_type,
          row.proposal_json,
          row.idempotency_key,
          row.outcome,
          row.created_at,
        ]
      );
    return db;
  };
  return {
    reserveAutomaticFire: async input => fireBudgetDb.reserveAutomaticFire(input, await database()),
    authorizeAutomaticFire: async input =>
      fireBudgetDb.authorizeAutomaticFire(input, await database()),
    releaseAutomaticFire: async input => fireBudgetDb.releaseAutomaticFire(input, await database()),
    settleAutomaticFire: async input => fireBudgetDb.settleAutomaticFire(input, await database()),
    seedAutomaticFireHistory: async input =>
      fireBudgetDb.seedAutomaticFireHistory(input, await database()),
    listAutomaticFireAdmissions: async () =>
      fireBudgetDb.listAutomaticFireAdmissions(await database()),
    updateAutomaticFireExpectation: async input =>
      fireBudgetDb.updateAutomaticFireExpectation(input, await database()),
  };
}
export function makeDeps(
  world: FakeWorld,
  overrides: Partial<TaskmasterDeps> = {}
): TaskmasterDeps {
  let journalSeq = world.journal.length;
  const dal = {
    listPendingFireActions: async () =>
      world.journal.filter(row => row.action_type === 'fire_cauldron' && row.outcome === 'pending'),
    transitionPendingFireAction: async (
      id: string,
      expectedJson: string,
      outcome: 'pending' | 'sent' | 'expired',
      proposalJson: string
    ) => {
      const row = world.journal.find(row => row.id === id);
      if (
        !row ||
        row.action_type !== 'fire_cauldron' ||
        row.outcome !== 'pending' ||
        row.proposal_json !== expectedJson
      )
        return false;
      row.outcome = outcome;
      row.proposal_json = proposalJson;
      return true;
    },
    registerExpectation: async (data: {
      action_ref?: string | null;
      dispatch_ref: string;
      recipient: string;
      evidence_json: string;
      due_at: string;
      on_absence: 'redispatch' | 'escalate' | 'give_up';
      max_retries: number;
    }) => {
      const key = expectationRegistrationKey(data.action_ref ?? null, data.dispatch_ref);
      const prior = world.expectations.get(key);
      if (prior) return prior.id;
      const row: TmExpectation = {
        ...data,
        id: `expectation-${world.expectations.size + 1}`,
        retries: 0,
        status: 'pending',
        evidence_pointer: null,
        registered_by: 'taskmaster',
        self_supervised: 0,
        created_at: new Date(world.nowMs).toISOString(),
        updated_at: new Date(world.nowMs).toISOString(),
      };
      world.expectations.set(key, row);
      return row.id;
    },
    getExpectationByRegistrationKey: async (key: string) => world.expectations.get(key) ?? null,
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
      world.recordCalls += 1;
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
    updateActionOutcome: async (id: string, outcome: TmActionOutcome, proposalJson?: string) => {
      const row = world.journal.find(j => j.id === id) ?? null;
      if (row) {
        row.outcome = outcome;
        if (proposalJson !== undefined) row.proposal_json = proposalJson;
      }
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
    getActionByIdempotencyKey: async (key: string) =>
      world.journal.find(j => j.idempotency_key === key) ?? null,
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
        if (
          row.outcome === 'parked' ||
          (row.outcome === 'pending' && row.action_type !== 'fire_cauldron')
        ) {
          row.outcome = 'expired';
          count += 1;
        }
      }
      return count;
    },
    beginAdoptionSnapshot: async () => `snap-${world.nowMs}-${world.adoptionRows.length}`,
    upsertAdoptionRow: async (snapshotId: string, row: Omit<TmAdoptionRow, 'snapshot_id'>) => {
      const full: TmAdoptionRow = { ...row, snapshot_id: snapshotId };
      const idx = world.adoptionRows.findIndex(
        r => r.snapshot_id === snapshotId && r.thread_ref === row.thread_ref
      );
      if (idx >= 0) world.adoptionRows[idx] = full;
      else world.adoptionRows.push(full);
    },
    commitAdoptionSnapshot: async (snapshotId: string, sourceCommit?: string | null) => {
      world.adoptionRows = world.adoptionRows.filter(r => r.snapshot_id === snapshotId);
      world.adoptionMeta = {
        committed_snapshot_id: snapshotId,
        rebuilt_at: new Date(world.nowMs).toISOString(),
        row_count: world.adoptionRows.length,
        source_commit: sourceCommit ?? null,
        complete: 1,
      };
    },
    abandonAdoptionSnapshot: async (snapshotId: string) => {
      world.adoptionRows = world.adoptionRows.filter(r => r.snapshot_id !== snapshotId);
    },
    getAdoption: async () => {
      const id = world.adoptionMeta.committed_snapshot_id;
      if (!id) return [];
      return world.adoptionRows.filter(r => r.snapshot_id === id);
    },
    getAdoptionMeta: async () => ({
      id: 1,
      committed_snapshot_id: world.adoptionMeta.committed_snapshot_id,
      rebuilt_at: world.adoptionMeta.rebuilt_at,
      row_count: world.adoptionMeta.row_count,
      source_commit: world.adoptionMeta.source_commit,
      complete: world.adoptionMeta.complete,
    }),
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
    // Most fire fixtures model a created workflow; no-run/corruption tests
    // override this independent SOR proof instead of treating admission as proof.
    readFireCascadeEvidence: async (identity: { cascadeId: string }) => ({
      earliestRunId: `actual-${identity.cascadeId}`,
      completedRunId: null,
      status: 'running',
      prOpened: false,
    }),
    getDispatchReceiptCutoverAt: async () => new Date(T0 - 86_400_000).toISOString(),
    headroom: async () => okHeadroom,
    createTask: (async (
      _context: unknown,
      data: { idempotency_key: string; recipient: string; body: string },
      fence?: {
        taskmasterPausedEpoch: number;
        taskmasterPausedState?: string;
        taskmasterPausedScope?: string | null;
      }
    ) => {
      // Fake the Dispatch boundary; its real SQLite/PG transaction has DAL
      // tests. Mirror the real fence exactly: the notice is refused unless the
      // live control row still matches the authorized state, scope and epoch.
      if (
        fence &&
        (world.control.pause_state !== fence.taskmasterPausedState ||
          (world.control.pause_scope ?? null) !== (fence.taskmasterPausedScope ?? null) ||
          world.control.epoch !== fence.taskmasterPausedEpoch)
      ) {
        return null;
      }
      world.sentMessages.push({
        idempotency_key: data.idempotency_key,
        recipient: data.recipient,
        body: data.body,
        createdAt: new Date(world.nowMs).toISOString(),
      });
      return { id: `msg-${world.sentMessages.length}`, status: 'queued' } as never;
    }) as unknown as TaskmasterDeps['createTask'],
    findEffectByIdempotencyKey: async (key: string) => {
      const found = world.sentMessages.find(m => m.idempotency_key === key);
      // Use the idempotency_key as the dispatch id so the default
      // getDispatchMessageById below can map effect.id back to the sent row
      // for M-155 Amendment 03 'unheard' grading.
      return found
        ? { id: found.idempotency_key, status: 'queued', createdAt: found.createdAt }
        : null;
    },
    // M-155 Amendment 03: synthesize the sent dispatch row from world.sentMessages
    // (keyed by idempotency_key == effect.id). acknowledged_at defaults to null
    // (unacked) unless a test seeds it.
    getDispatchMessageById: (async (id: string) => {
      const found = world.sentMessages.find(m => m.idempotency_key === id);
      if (!found) return null;
      return {
        id,
        recipient: found.recipient,
        resolved_recipient: null,
        acknowledged_at: found.acknowledged_at ?? null,
        addressed_at: null,
        addressed_by: null,
      };
    }) as unknown as TaskmasterDeps['getDispatchMessageById'],
    // M-155 Amendment 03: mirror the seeded principal delivery modes
    // (packages/core/src/db/adapters/sqlite.ts). operator + xo are
    // drain_on_start; unknown recipients default to drain_on_start (matching
    // the migration 040 backfill), so a message is 'heard' only when a test
    // both seeds acknowledged_at AND routes to a non-draining recipient.
    assessDispatchRecipient: (async (recipient: string) => {
      const nonDrain: Record<string, DispatchDeliveryMode> = {
        overseer: 'notify_only',
        cauldron: 'notify_only',
        claude: 'worker_poll',
        codex: 'worker_poll',
        'major-build': 'worker_poll',
        'captain-ci': 'worker_poll',
        board: 'alias_resolved',
      };
      const canonical = recipient.trim().toLowerCase();
      const delivery_mode = nonDrain[canonical] ?? 'drain_on_start';
      return { ok: true, canonical_principal: canonical, delivery_mode, reason: null };
    }) as unknown as TaskmasterDeps['assessDispatchRecipient'],
    listUndeliveredRulings: async () => [],
    listThreads: async () => [],
    // Default no-op evidence so adoption refresh never hits the network in unit tests.
    getGithubIssueEvidence: async () => null,
    ...overrides,
    fireBudget: overrides.fireBudget ?? fixtureFireBudget(world),
    readFireCascade: overrides.readFireCascade ?? (async () => null),
    readFireRun:
      overrides.readFireRun ?? (async () => ({ status: 'completed', approvalHandOff: false })),
    ...(overrides.runCascade
      ? {
          runCascade: (async options => {
            const provenance = await options.beforeAdmission?.();
            const normalize = (
              record: Awaited<ReturnType<NonNullable<TaskmasterDeps['runCascade']>>>
            ) => ({
              ...record,
              cascadeId: options.dispatchId!,
              automaticFireAdmission: provenance,
              attempts: record.attempts ?? [{ runId: record.cascadeId }],
            });
            const record = await overrides.runCascade!({
              ...options,
              onAdmission: (record, created) => options.onAdmission?.(normalize(record), created),
            });
            return normalize(record);
          }) as NonNullable<TaskmasterDeps['runCascade']>,
        }
      : {}),
  };
}

/** Seed today's digest as already sent so tests can assert exact send counts. */
export function seedDigestSent(world: FakeWorld): void {
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

export const EXPECTED_SPEC = {
  specSource: 'github:thinmansoftware/bdc-xo:docs/work-orders/WO-HARNESS-EXAMPLE-01.md',
  specRevision: 'a'.repeat(40),
  specHash: `sha256:${'b'.repeat(64)}`,
};

export function makeListedThread(overrides: Partial<ListedThread> & { ref: string }): ListedThread {
  return {
    priority: 'P1',
    lastActivityAt: new Date(T0).toISOString(),
    recipient: 'xo',
    title: 'untitled',
    ownerLogin: null,
    labels: ['wo', 'prio:P1'],
    ...overrides,
  };
}
