/**
 * Taskmaster loop tests -- Section 11 scenarios 1, 3, 4, 5 plus the
 * auto-circuit. Everything is dependency-injected (fake clock, fake DAL,
 * fake dispatch). A separate fail-closed preload catches undeclared defaults.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { DispatchDeliveryMode } from '@archon/core/db/dispatch';
import type { ThreadSnapshot } from './rules';
import type {
  TmActionOutcome,
  TmActionType,
  TmControlState,
  TmGrade,
  TmJournalEntry,
} from '@archon/core/db/taskmaster';
import type { HeadroomReading } from './ledger';
import type { LanePrRegistryDb } from '@archon/core/db/lane-pr-registry';
import type {
  TaskmasterDeps,
  ListedThread,
  GithubIssueEvidence,
  AdoptionRefreshResult,
} from './loop';
import type { PrRepairQueuedMessage, PrRepairOwnerDeps } from './pr-repair-owner';
import type { EscalationDeliveryDeps, EscalationIssueComment } from './escalation-delivery';
import type { ActionProposal } from './rules';
import type { TmExpectation, TmAdoptionRow, TmSuppressionRow } from '@archon/core/db/taskmaster';
import type {
  SeatUsageReader,
  SeatReading,
  SeatId,
} from '@archon/workflows/reliability/seat-usage';

if (Reflect.get(globalThis, Symbol.for('bdc.pr-detection-isolated')) !== true) {
  throw new Error('PR_DETECTION_ISOLATION_PRELOAD_REQUIRED');
}
const guardedConnection = await import('@archon/core/db/connection');
const canonicalConnection = await import('../../../core/src/db/connection');
if (
  Reflect.get(guardedConnection, '__PR_DETECTION_GUARD__') !== true ||
  Reflect.get(canonicalConnection, '__PR_DETECTION_GUARD__') !== true ||
  guardedConnection.getDatabase !== canonicalConnection.getDatabase
) {
  throw new Error('PR_DETECTION_CONNECTION_GUARD_REQUIRED');
}
const { takeDeniedFallbacks } =
  await import('../../../smart-cauldron/src/__tests__/pr-detection-isolation.preload');
afterEach(() => expect(takeDeniedFallbacks()).toEqual([]));

const { listWosWithMultipleLanePrs } = await import('@archon/core/db/lane-pr-registry');
const { rootLogger } = await import('@archon/paths');
const githubMeter = await import('@archon/core/github/metering');
const { resetGitHubApiMeterForTests } = githubMeter;
const { setSeatUsageReaderForTests, unknownSeatReading } =
  await import('@archon/workflows/reliability/seat-usage');
const fixtureSeatUsage: SeatUsageReader = async seats => {
  const readings: Partial<Record<SeatId, SeatReading>> = {};
  for (const seat of seats) readings[seat] = unknownSeatReading(seat, 'synthetic loop fixture');
  return readings;
};
// Install before the loop graph and every test: native seat readers load auth
// files before network, so denying fetch alone does not isolate these fixtures.
setSeatUsageReaderForTests(fixtureSeatUsage);
beforeEach(() => setSeatUsageReaderForTests(fixtureSeatUsage));
afterEach(() => setSeatUsageReaderForTests(fixtureSeatUsage));
const {
  createTaskmasterState,
  createGhLaneFetcher,
  createRealPrRepairOwnerDeps,
  defaultFindEffectByIdempotencyKey,
  defaultGetGithubIssueEvidence,
  defaultListThreads,
  priorityFromLabels,
  tick,
  resolveTaskmasterIntervalMs,
  resolveFireVerbEnabled,
  resolveBlockerReportEnabled,
  MAX_BLOCKER_REPORTS_PER_TICK,
  refreshAdoption,
  canonicalizeThreadRef,
  resolveRecipient,
  MAX_EFFECTS_PER_TICK,
  OWNER_RECIPIENT_MAP,
  isPauseEffectsExempt,
  TM_REPEAT_REASON_BY_TYPE,
  isPostCutoverReceipt,
  digestProposal,
} = await import('./loop');
const { checkEvidence, checkExpectations } = await import('./expectations');
const { runPrRepairOwner } = await import('./pr-repair-owner');
const { TASKMASTER_ESCALATION_MARKER, TASKMASTER_ESCALATION_COOLDOWN_MS } =
  await import('./escalation-delivery');
const { validateProposal, TM_ALLOWED_ACTION_TYPES, TM_ALLOWED_RECIPIENTS } =
  await import('./guard');
const { classifyThread, computeNextAction, MAX_INTERVENTIONS_PER_ITEM_24H, NUDGE_CLOCK_MS } =
  await import('./rules');
const { expectationRegistrationKey } = await import('@archon/core/db/taskmaster');
const { SqliteAdapter } = await import('@archon/core/db/adapters/sqlite');
const fireBudgetDb = await import('@archon/core/db/taskmaster');
type SqliteAdapter = InstanceType<typeof SqliteAdapter>;

// Synthetic exhausted responses belong to one test.
beforeEach(resetGitHubApiMeterForTests);
afterEach(resetGitHubApiMeterForTests);

describe('Taskmaster reset visibility and canary', () => {
  test('legacy_unverified receipts are never post-cutover evidence', () => {
    const cutover = '2026-09-23T16:00:00.000Z';
    expect(isPostCutoverReceipt('2026-09-23T15:59:59.999Z', cutover)).toBe(false);
    expect(isPostCutoverReceipt(cutover, cutover)).toBe(true);
    expect(isPostCutoverReceipt(null, cutover)).toBe(false);
  });

  test('PAUSED ticks do not write a tm_journal effect', async () => {
    const world = makeWorld();
    world.control.pause_state = 'PAUSED';
    seedDigestSent(world);
    const before = world.journal.length;
    await tick(createTaskmasterState(60_000), makeDeps(world));
    expect(world.journal).toHaveLength(before);
  });

  test('only the two WO-authorized monitoring signals escape an effects pause', () => {
    expect(isPauseEffectsExempt('canary', 'effects')).toBe(true);
    expect(isPauseEffectsExempt('self_pause_notice', 'effects')).toBe(true);
    expect(isPauseEffectsExempt('digest', 'effects')).toBe(false);
    expect(isPauseEffectsExempt('escalate_p0', 'effects')).toBe(false);
    expect(isPauseEffectsExempt('nudge', 'effects')).toBe(false);
    expect(isPauseEffectsExempt('fire_cauldron', 'effects')).toBe(false);
    expect(isPauseEffectsExempt('deliver_ruling', 'effects')).toBe(false);
  });

  test('paused daily canary reaches duty-officer once and carries reset guidance', async () => {
    const world = makeWorld();
    world.control.pause_state = 'PAUSED';
    world.control.pause_scope = 'effects';
    world.control.pause_reason = 'operator safety pause';
    const deps = makeDeps(world);
    const state = createTaskmasterState(60_000);

    await tick(state, deps);
    await tick(state, deps);

    const canaries = world.sentMessages.filter(m => m.idempotency_key === `tm:digest:${TODAY_KEY}`);
    expect(canaries).toHaveLength(1);
    expect(canaries[0]?.recipient).toBe('duty-officer');
    expect(canaries[0]?.body).toContain('operator safety pause');
    expect(canaries[0]?.body).toContain('scripts/taskmaster/reset.sh');
  });

  test('healthy quiet day still sends a daily canary', async () => {
    const world = makeWorld();
    await tick(createTaskmasterState(60_000), makeDeps(world));
    expect(world.sentMessages).toHaveLength(1);
    expect(world.sentMessages[0]?.recipient).toBe('duty-officer');
    expect(world.sentMessages[0]?.body).toContain('no proposals today');
  });

  test('reset audit does not inflate a quiet daily canary outcome count', async () => {
    const world = makeWorld();
    world.journal.push({
      id: 'reset-audit',
      created_at: new Date(world.nowMs).toISOString(),
      thread_ref: 'taskmaster:reset',
      action_type: 'digest',
      proposal_json: JSON.stringify({ audit_type: 'taskmaster_reset' }),
      idempotency_key: null,
      before_hash: null,
      proof_predicate: null,
      proof_deadline_at: null,
      outcome: 'sent',
      graded_at: null,
      grade: null,
    });

    await tick(createTaskmasterState(60_000), makeDeps(world));

    expect(world.sentMessages).toHaveLength(1);
    expect(world.sentMessages[0]?.body).toContain('sent=0, parked=0, rejected=0');
    expect(world.sentMessages[0]?.body).toContain('no proposals today');
  });

  test('post-resume noise pauses and sends the Duty Officer reset notice', async () => {
    const world = makeWorld();
    for (let i = 0; i < 20; i += 1) {
      world.journal.push({
        id: `noise-${i}`,
        created_at: new Date(T0 + i + 1).toISOString(),
        thread_ref: `gh:test/repo#${i}`,
        action_type: 'nudge',
        proposal_json: '{}',
        idempotency_key: `noise-${i}`,
        before_hash: null,
        proof_predicate: null,
        proof_deadline_at: null,
        outcome: 'sent',
        graded_at: new Date(T0 + i + 1).toISOString(),
        grade: 'noise',
      });
    }
    await tick(createTaskmasterState(60_000), makeDeps(world));
    expect(world.control.pause_state).toBe('PAUSED');
    const notice = world.sentMessages.find(m => m.idempotency_key.startsWith('tm:self-pause:'));
    expect(notice?.recipient).toBe('duty-officer');
    expect(notice?.body).toContain('scripts/taskmaster/reset.sh');
    expect(notice?.body).toContain('M-155 useful-rate floor auto-pause');
  });

  test.each(['epoch', 'pause state', 'enqueue'] as const)(
    'a changed control %s prevents a stale self-pause notice',
    async change => {
      const world = makeWorld();
      for (let i = 0; i < 20; i += 1) {
        world.journal.push({
          id: `noise-fenced-${i}`,
          created_at: new Date(T0 + i + 1).toISOString(),
          thread_ref: `gh:test/repo#${i}`,
          action_type: 'nudge',
          proposal_json: '{}',
          idempotency_key: `noise-fenced-${i}`,
          before_hash: null,
          proof_predicate: null,
          proof_deadline_at: null,
          outcome: 'sent',
          graded_at: new Date(T0 + i + 1).toISOString(),
          grade: 'noise',
        });
      }
      const deps = makeDeps(world);
      const originalSetPauseState = deps.db!.setPauseState;
      if (change === 'enqueue') {
        const originalCreate = deps.createTask!;
        deps.createTask = (async (context, data, fence) => {
          if (data.idempotency_key.startsWith('tm:self-pause:')) {
            world.control = {
              ...world.control,
              pause_state: 'RUNNING',
              epoch: world.control.epoch + 1,
            };
          }
          return fence ? originalCreate(context, data, fence) : originalCreate(context, data);
        }) as TaskmasterDeps['createTask'];
      } else
        deps.db!.setPauseState = async data => {
          const paused = await originalSetPauseState(data);
          const snapshot = { ...paused };
          world.control =
            change === 'epoch'
              ? { ...paused, epoch: paused.epoch + 1 }
              : { ...paused, pause_state: 'RUNNING' };
          return snapshot;
        };
      await tick(createTaskmasterState(60_000), deps);
      expect(
        world.sentMessages.filter(m => m.idempotency_key.startsWith('tm:self-pause:'))
      ).toHaveLength(0);
    }
  );
});

const T0 = Date.parse('2026-08-07T12:00:00.000Z');
const TODAY_KEY = new Date(T0).toISOString().slice(0, 10);

interface FakeWorld {
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

function makeWorld(): FakeWorld {
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

const budgetStores = new WeakMap<FakeWorld, SqliteAdapter>();
const openedBudgetStores: SqliteAdapter[] = [];
afterAll(async () => {
  for (const db of openedBudgetStores) await db.close();
});
function fixtureFireBudget(world: FakeWorld): NonNullable<TaskmasterDeps['fireBudget']> {
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
function makeDeps(world: FakeWorld, overrides: Partial<TaskmasterDeps> = {}): TaskmasterDeps {
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
    // A fake DAL must not fall through to the singleton operational database.
    // Tests of lane health override this with their explicit fixture samples.
    getHealthSample: async () => null,
    getFireRunEvidence: async () => null,
    checkFireEligibility: async () => ({ eligible: false, reason: 'fixture_no_automatic_fire' }),
    runCascade: async () => {
      throw new Error('unexpected fixture cascade');
    },
    escalationDelivery: makeIssueCommentSink(world).delivery,
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

/**
 * Fake GitHub-issue escalation delivery seam
 * (WO-HARNESS-TASKMASTER-ESCALATE-TO-ISSUE-01). Records posted comments; its
 * clock tracks world.nowMs so the module's 72h cooldown is evaluated against the
 * same virtual time the tick uses. `onPost` lets ordering tests observe the post.
 */
function makeIssueCommentSink(
  world: FakeWorld,
  onPost?: (body: string) => void
): { delivery: EscalationDeliveryDeps; posts: () => number; comments: EscalationIssueComment[] } {
  // Comments are keyed per issue (owner/repo#number) so distinct issues do not
  // share a dedupe window; `comments` is the flat aggregate for assertions.
  const byIssue = new Map<string, EscalationIssueComment[]>();
  const all: EscalationIssueComment[] = [];
  let posts = 0;
  const keyOf = (issue: { owner: string; repo: string; number: number }): string =>
    `${issue.owner}/${issue.repo}#${issue.number}`;
  return {
    comments: all,
    posts: () => posts,
    delivery: {
      listIssueComments: async issue => byIssue.get(keyOf(issue)) ?? [],
      postIssueComment: async (issue, body) => {
        posts += 1;
        const comment = {
          body,
          created_at: new Date(world.nowMs).toISOString(),
          authorLogin: 'taskmaster-bot',
        };
        const list = byIssue.get(keyOf(issue)) ?? [];
        list.push(comment);
        byIssue.set(keyOf(issue), list);
        all.push(comment);
        onPost?.(body);
      },
      posterLogin: async () => 'taskmaster-bot',
      now: () => new Date(world.nowMs),
    },
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

describe('expectation registry tick wiring', () => {
  test('checks expectations, reports counts, and registers ordinary dispatch proof', async () => {
    const world = makeWorld();
    const checkedAt: Date[] = [];
    const registered: Array<{ dispatch_ref: string; on_absence: string }> = [];
    const deps = makeDeps(world, {
      checkExpectations: async now => {
        checkedAt.push(now);
      },
      listThreads: async () =>
        Object.assign([], {
          unlabelledPriorityTriage: ['gh:thinmansoftware/bdc-harness#404'],
        }),
    });
    deps.db = {
      ...deps.db!,
      getExpectationCounts: async () => ({
        pending: 2,
        met: 3,
        failed: 4,
        escalating: 7,
        escalated: 5,
        given_up: 6,
      }),
      registerExpectation: async data => {
        registered.push(data);
        return 'expectation-digest';
      },
    };

    await tick(createTaskmasterState(60_000), deps);

    expect(checkedAt).toEqual([new Date(T0)]);
    expect(registered).toHaveLength(1);
    expect(registered[0]?.dispatch_ref).toBe('msg-1');
    expect(registered[0]?.on_absence).toBe('escalate');
    // The journal action id is the other half of the deterministic identity;
    // without it a replayed action would register a second expectation.
    expect(registered[0]?.action_ref).toBeTruthy();
    const digest = world.sentMessages.find(message =>
      message.idempotency_key.startsWith('tm:digest:')
    );
    // `escalating` is in the digest: a non-terminal claimed-but-unsent
    // escalation is exactly the thing a human needs to see in the daily line.
    expect(digest?.body).toContain(
      'pending=2, met=3, failed=4, escalating=7, escalated=5, given_up=6'
    );
    expect(digest?.body).toContain('Needs priority triage: gh:thinmansoftware/bdc-harness#404');
  });
});

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

describe('scenario 3: pause scope=effects withholds ALL effects (P0 escalation no longer exempt)', () => {
  test('paused scope=effects: P1 nudge AND P0 escalation park with reason=paused, zero sends', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    world.control.pause_state = 'PAUSED';
    world.control.pause_scope = 'effects';
    world.control.pause_actor = 'john';

    const staleP1 = makeListedThread({
      ref: 'gh:thinmansoftware/bdc-harness#11',
      priority: 'P1',
      lastActivityAt: new Date(T0 - 5 * 3_600_000).toISOString(),
      recipient: 'xo',
      title: 'Stale P1 item',
    });
    const unclaimedP0 = makeListedThread({
      ref: 'gh:thinmansoftware/bdc-harness#12',
      priority: 'P0',
      lastActivityAt: new Date(T0 - 3_600_000).toISOString(),
      isUnclaimedP0: true,
      recipient: 'xo',
      title: 'Unclaimed P0 item',
    });
    const deps = makeDeps(world, {
      listThreads: async () => [staleP1, unclaimedP0],
      // Content-complete adoption (PROGRESS marker -> next_action) so the
      // ordinary nudge is composed; this test is about the pause parking it.
      getGithubIssueEvidence: async () =>
        makeEvidence({
          ownerLogin: 'major-build',
          latestMarkerKind: 'PROGRESS',
          latestMarkerText: 'waiting on review feedback',
          latestMarkerAt: new Date(T0 - 3 * 3_600_000).toISOString(),
          lastMovementAt: new Date(T0 - 3 * 3_600_000).toISOString(),
          lastMovementKind: 'progress_comment',
        }),
    });
    const state = createTaskmasterState(60_000);

    // Tick 1 observes; tick 2 confirms the nudge (which then parks). The P0
    // escalation acts immediately, so it parks on tick 1.
    await tick(state, deps);
    world.nowMs += 60_000;
    await tick(state, deps);

    // NEW BEHAVIOR: the P0 escalation is withheld (parked), NOT sent, because
    // the pause scope is 'effects'.
    const escalations = world.sentMessages.filter(m =>
      m.idempotency_key.startsWith('tm:escalate_p0:')
    );
    expect(escalations.length).toBe(0);
    const escalationParked = world.journal.filter(
      j => j.thread_ref === unclaimedP0.ref && j.outcome === 'parked'
    );
    expect(escalationParked.length).toBe(1);
    expect(escalationParked[0]?.proposal_json).toContain('"reason":"paused"');

    // Zero sends for the P1; its journal row exists tagged parked with reason.
    const p1Sends = world.sentMessages.filter(m => m.idempotency_key.startsWith('tm:nudge:'));
    expect(p1Sends.length).toBe(0);
    const parked = world.journal.filter(
      j => j.thread_ref === staleP1.ref && j.outcome === 'parked'
    );
    expect(parked.length).toBe(1);
    expect(parked[0]?.proposal_json).toContain('"parked":true');
    expect(parked[0]?.proposal_json).toContain('"reason":"paused"');

    // Absolutely zero effects left the process this pause window.
    expect(world.sentMessages.length).toBe(0);
    // No journal row was marked sent for either thread.
    expect(
      world.journal.some(
        j =>
          (j.thread_ref === staleP1.ref || j.thread_ref === unclaimedP0.ref) && j.outcome === 'sent'
      )
    ).toBe(false);

    // Resume: epoch increments, parked proposals are EXPIRED, not replayed.
    for (const row of world.journal) {
      if (row.outcome === 'parked' || row.outcome === 'pending') row.outcome = 'expired';
    }
    world.control = {
      ...world.control,
      pause_state: 'RUNNING',
      pause_scope: null,
      epoch: world.control.epoch + 1,
    };

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

const EXPECTED_SPEC = {
  specSource: 'github:thinmansoftware/bdc-xo:docs/work-orders/WO-HARNESS-EXAMPLE-01.md',
  specRevision: 'a'.repeat(40),
  specHash: `sha256:${'b'.repeat(64)}`,
};
describe('fire_cauldron loop', () => {
  test.each(['refused', 'planned'] as const)(
    'definitive pre-permission %s releases only the owned reservation',
    async status => {
      const prior = process.env.TASKMASTER_FIRE_VERB_ENABLED;
      process.env.TASKMASTER_FIRE_VERB_ENABLED = 'true';
      try {
        const world = makeWorld();
        seedDigestSent(world);
        const deps = makeDeps(world, {
          listThreads: async () => [
            makeListedThread({
              ref: 'gh:thinmansoftware/bdc-harness#709',
              title: 'WO-HARNESS-EXAMPLE-709',
              priority: 'P0',
              isUnclaimed: true,
              isUnclaimedP0: true,
            }),
          ],
          checkFireEligibility: async () => ({
            eligible: true,
            evidence: {
              woId: 'WO-HARNESS-EXAMPLE-709',
              targetRepo: 'thinmansoftware/bdc-harness',
              project: 'bdc-harness',
              specVerifiedAt: new Date(T0).toISOString(),
              noOpenOrMergedPr: true,
              expectedSpec: EXPECTED_SPEC,
            },
          }),
        });
        let calls = 0;
        // Bypass the fixture's automatic gate wrapper: a real pre-admission
        // refusal/dry-run returns WITHOUT asking for permission.
        deps.runCascade = async options => {
          calls++;
          return {
            cascadeId: options.dispatchId,
            woId: options.woId,
            project: options.project,
            status,
            attempts: [],
          } as never;
        };
        const result = await tick(createTaskmasterState(60_000), deps);
        expect(calls).toBe(1);
        expect(result.failed).toBe(0);
        expect(world.journal.find(row => row.action_type === 'fire_cauldron')?.outcome).toBe(
          'expired'
        );
        const rows = (
          await budgetStores.get(world)!.query<{
            state: string;
            admitted_at: string | null;
          }>('SELECT state,admitted_at FROM tm_fire_admissions')
        ).rows;
        expect(rows).toHaveLength(1);
        expect(rows[0]?.state).toBe('released');
        expect(rows[0]?.admitted_at).toBeNull();
      } finally {
        if (prior === undefined) delete process.env.TASKMASTER_FIRE_VERB_ENABLED;
        else process.env.TASKMASTER_FIRE_VERB_ENABLED = prior;
      }
    }
  );

  test('beyond_first_page_cannot_fire_by_default', async () => {
    const priorFireVerb = process.env.TASKMASTER_FIRE_VERB_ENABLED;
    const priorBeyondPage = process.env.TASKMASTER_FIRE_BEYOND_FIRST_PAGE;
    process.env.TASKMASTER_FIRE_VERB_ENABLED = 'true';
    const run = async (allowBeyondPage: boolean) => {
      if (allowBeyondPage) process.env.TASKMASTER_FIRE_BEYOND_FIRST_PAGE = 'true';
      else delete process.env.TASKMASTER_FIRE_BEYOND_FIRST_PAGE;
      const world = makeWorld();
      seedDigestSent(world);
      const item = makeListedThread({
        ref: 'gh:thinmansoftware/bdc-harness#499',
        title: 'WO-HARNESS-EXAMPLE-01',
        priority: 'P0',
        isUnclaimed: true,
        isUnclaimedP0: true,
        beyondFirstPage: true,
      });
      const deps = makeDeps(world, {
        listThreads: async () => [item],
        checkFireEligibility: async () => ({
          eligible: true,
          evidence: {
            woId: 'WO-HARNESS-EXAMPLE-01',
            targetRepo: 'thinmansoftware/bdc-harness',
            project: 'bdc-harness',
            specVerifiedAt: new Date(T0).toISOString(),
            noOpenOrMergedPr: true,
            expectedSpec: EXPECTED_SPEC,
          },
        }),
        runCascade: async options => {
          const record = { cascadeId: 'cascade-499', status: 'running' } as never;
          options.onAdmission?.(record, true);
          return record;
        },
      });
      const state = createTaskmasterState(60_000);
      await tick(state, deps);
      await tick(state, deps);
      return world.journal.map(row => row.action_type);
    };

    try {
      const gatedActions = await run(false);
      expect(gatedActions).not.toContain('fire_cauldron');
      expect(gatedActions).toContain('escalate_p0');
      const allowedActions = await run(true);
      expect(allowedActions).toContain('fire_cauldron');
    } finally {
      if (priorFireVerb === undefined) delete process.env.TASKMASTER_FIRE_VERB_ENABLED;
      else process.env.TASKMASTER_FIRE_VERB_ENABLED = priorFireVerb;
      if (priorBeyondPage === undefined) delete process.env.TASKMASTER_FIRE_BEYOND_FIRST_PAGE;
      else process.env.TASKMASTER_FIRE_BEYOND_FIRST_PAGE = priorBeyondPage;
    }
  });

  test('legacy eligibility without immutable identity never dispatches a cascade', async () => {
    const prior = process.env.TASKMASTER_FIRE_VERB_ENABLED;
    process.env.TASKMASTER_FIRE_VERB_ENABLED = 'true';
    try {
      const world = makeWorld();
      seedDigestSent(world);
      let admissions = 0;
      await tick(
        createTaskmasterState(60_000),
        makeDeps(world, {
          listThreads: async () => [
            makeListedThread({ isUnclaimed: true, title: 'WO-HARNESS-EXAMPLE-01', priority: 'P1' }),
          ],
          checkFireEligibility: async () => ({
            eligible: true,
            evidence: {
              woId: 'WO-HARNESS-EXAMPLE-01',
              targetRepo: 'thinmansoftware/bdc-harness',
              project: 'bdc-harness',
              noOpenOrMergedPr: true,
              specVerifiedAt: new Date(T0).toISOString(),
            },
          }),
          runCascade: async options => {
            admissions++;
            const record = { cascadeId: 'bad', status: 'running' } as never;
            options.onAdmission?.(record, true);
            return record;
          },
        })
      );
      expect(admissions).toBe(0);
      expect(
        world.journal.some(row => row.action_type === 'fire_cauldron' && row.outcome === 'sent')
      ).toBe(false);
    } finally {
      if (prior === undefined) delete process.env.TASKMASTER_FIRE_VERB_ENABLED;
      else process.env.TASKMASTER_FIRE_VERB_ENABLED = prior;
    }
  });
  test('fire backoff still delivers an outstanding ruling for the P0', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    const item = makeListedThread({
      ref: 'gh:thinmansoftware/bdc-harness#500',
      priority: 'P0',
      isUnclaimedP0: true,
      undeliveredRulingId: 'ruling-during-fire-backoff',
    });
    world.journal.push({
      id: 'failed-fire-500',
      created_at: new Date(T0).toISOString(),
      thread_ref: item.ref,
      action_type: 'fire_cauldron',
      proposal_json: '{}',
      idempotency_key: 'old-fire-500',
      before_hash: null,
      proof_predicate: null,
      proof_deadline_at: null,
      outcome: 'failed',
      graded_at: null,
      grade: null,
    });
    await tick(createTaskmasterState(60_000), makeDeps(world, { listThreads: async () => [item] }));
    expect(world.journal.some(row => row.action_type === 'deliver_ruling')).toBe(true);
  });

  test('qualified fresh unclaimed P1 admits exactly one cascade and journals its run id', async () => {
    const prior = process.env.TASKMASTER_FIRE_VERB_ENABLED;
    process.env.TASKMASTER_FIRE_VERB_ENABLED = 'true';
    try {
      const world = makeWorld();
      seedDigestSent(world);
      const item: ListedThread = {
        ref: 'gh:thinmansoftware/bdc-harness#501',
        priority: 'P1',
        lastActivityAt: new Date(T0 - 3_600_000).toISOString(),
        isUnclaimed: true,
        recipient: 'xo',
        title: 'WO-HARNESS-EXAMPLE-01 urgent build',
      };
      let admissions = 0;
      const record = { cascadeId: 'cascade-501', status: 'running' } as unknown as Awaited<
        ReturnType<NonNullable<TaskmasterDeps['runCascade']>>
      >;
      const deps = makeDeps(world, {
        listUndeliveredRulings: async () => [],
        listThreads: async () => [item],
        checkFireEligibility: async () => ({
          eligible: true,
          evidence: {
            woId: 'WO-HARNESS-EXAMPLE-01',
            targetRepo: 'thinmansoftware/bdc-harness',
            project: 'bdc-harness',
            specVerifiedAt: new Date(T0).toISOString(),
            noOpenOrMergedPr: true,
            expectedSpec: EXPECTED_SPEC,
          },
        }),
        runCascade: (async options => {
          admissions += 1;
          expect(options.expectedSpec).toEqual(EXPECTED_SPEC);
          options.onAdmission?.(record, true);
          return record;
        }) as NonNullable<TaskmasterDeps['runCascade']>,
      });
      const registered: Array<{ dispatch_ref: string; evidence_json: string }> = [];
      const storeExpectation = deps.db!.registerExpectation!;
      deps.db = {
        ...deps.db!,
        registerExpectation: async data => {
          registered.push(data);
          return storeExpectation(data);
        },
      };
      const state = createTaskmasterState(60_000);
      await tick(state, deps);
      await tick(state, deps);
      expect(admissions).toBe(1);
      const fires = world.journal.filter(row => row.action_type === 'fire_cauldron');
      expect(fires).toHaveLength(1);
      expect(fires[0]?.outcome).toBe('sent');
      expect(JSON.parse(fires[0]!.proposal_json).runId).toBe(`actual-${fires[0]!.idempotency_key}`);
      expect(registered).toHaveLength(1);
      expect(registered[0]?.dispatch_ref).toBe(fires[0]!.idempotency_key);
      expect(registered[0]?.evidence_json).toContain('cascade_workflow_completed');
      // Deterministic identity: the journal action id is passed so a replayed
      // fire reuses this expectation instead of registering a second one.
      expect(registered[0]?.action_ref).toBe(fires[0]?.id);

      // The evidence must be a TERMINAL, SUCCESSFUL outcome. Matching only on
      // the admission row's existence is self-fulfilling -- admission creates
      // that row -- so a failed or stalled cascade would never escalate.
      const spec = JSON.parse(registered[0]!.evidence_json);
      expect(spec).toMatchObject({
        kind: 'cascade_workflow_completed',
        woId: 'WO-HARNESS-EXAMPLE-01',
        project: 'bdc-harness',
      });

      // Run the registered spec against a run table to prove it: admitted but
      // unfinished is NOT met, failed is NOT met, completed IS met.
      const runs = [
        {
          id: 'actual-workflow-501',
          workflow_name: 'bound-workflow',
          status: 'running',
          metadata: '{}',
        },
      ];
      const query = async <T>(_sql: string, params?: unknown[]) => {
        const [id, workflowName] = (params ?? []) as string[];
        return {
          rows: runs.filter(
            run => run.id === id && run.workflow_name === workflowName
          ) as unknown as T[],
        };
      };
      const probe = async () => {
        let met = false;
        await checkExpectations(new Date(T0), {
          listDueExpectations: async () => [...world.expectations.values()],
          readCascade: async () =>
            ({
              cascadeId: spec.cascadeId,
              woId: spec.woId,
              project: spec.project,
              request: { dryRun: false },
              attempts: [{ runId: runs[0]!.id, workflowName: 'bound-workflow' }],
            }) as never,
          query,
          markMet: async () => {
            met = true;
            return true;
          },
        });
        return met;
      };
      expect(await probe()).toBe(false);
      runs[0]!.status = 'failed';
      expect(await probe()).toBe(false);
      runs[0]!.status = 'completed';
      expect(await probe()).toBe(true);
      expect(world.sentMessages.some(message => message.body.includes('Unclaimed P0'))).toBe(false);
    } finally {
      if (prior === undefined) delete process.env.TASKMASTER_FIRE_VERB_ENABLED;
      else process.env.TASKMASTER_FIRE_VERB_ENABLED = prior;
    }
  });

  test('hold-labeled unclaimed work is refused fire even when its blocker names a seat', async () => {
    const prior = process.env.TASKMASTER_FIRE_VERB_ENABLED;
    process.env.TASKMASTER_FIRE_VERB_ENABLED = 'true';
    try {
      const world = makeWorld();
      seedDigestSent(world);
      const item = makeListedThread({
        ref: 'gh:thinmansoftware/bdc-harness#509',
        priority: 'P1',
        isUnclaimed: true,
        isBlocked: true,
        labels: ['wo', 'status:hold'],
        title: 'WO-HARNESS-EXAMPLE-509 held build',
      });
      let admissions = 0;
      await tick(
        createTaskmasterState(60_000),
        makeDeps(world, {
          listThreads: async () => [item],
          getGithubIssueEvidence: async () =>
            makeEvidence({
              latestMarkerKind: 'BLOCKED',
              latestMarkerText: 'major-build must resolve the hold',
            }),
          checkFireEligibility: async () => ({
            eligible: true,
            evidence: {
              woId: 'WO-HARNESS-EXAMPLE-509',
              targetRepo: 'thinmansoftware/bdc-harness',
              project: 'bdc-harness',
              specVerifiedAt: new Date(T0).toISOString(),
              noOpenOrMergedPr: true,
              expectedSpec: EXPECTED_SPEC,
              specSource: 'issue-body',
            },
          }),
          runCascade: (async () => {
            admissions += 1;
            return { cascadeId: 'unexpected', status: 'running' } as never;
          }) as NonNullable<TaskmasterDeps['runCascade']>,
        })
      );
      expect(admissions).toBe(0);
      expect(world.journal.some(row => row.action_type === 'fire_cauldron')).toBe(false);
    } finally {
      if (prior === undefined) delete process.env.TASKMASTER_FIRE_VERB_ENABLED;
      else process.env.TASKMASTER_FIRE_VERB_ENABLED = prior;
    }
  });

  test('mixed immediate proposals keep exceptions ahead of priority-ordered fires', async () => {
    const prior = process.env.TASKMASTER_FIRE_VERB_ENABLED;
    process.env.TASKMASTER_FIRE_VERB_ENABLED = 'true';
    try {
      const world = makeWorld();
      seedDigestSent(world);
      const events: string[] = [];
      const threads = [
        makeListedThread({
          ref: 'gh:thinmansoftware/bdc-harness#523',
          priority: 'P3',
          isUnclaimed: true,
          title: 'WO-HARNESS-EXAMPLE-523 build',
        }),
        makeListedThread({
          ref: 'gh:thinmansoftware/bdc-harness#520',
          priority: 'P0',
          isUnclaimed: true,
          isUnclaimedP0: true,
          title: 'WO-HARNESS-EXAMPLE-520 no spec',
        }),
        makeListedThread({
          ref: 'gh:thinmansoftware/bdc-harness#521',
          priority: 'P1',
          isUnclaimed: true,
          title: 'WO-HARNESS-EXAMPLE-521 build',
        }),
      ];
      const deps = makeDeps(world, {
        listUndeliveredRulings: async () => [ruling()],
        listThreads: async () => threads,
        checkFireEligibility: async title => {
          const woId = title.split(' ')[0]!;
          if (woId.endsWith('-520')) return { eligible: false, reason: 'missing_spec' };
          return {
            eligible: true,
            evidence: {
              woId,
              targetRepo: 'thinmansoftware/bdc-harness',
              project: 'bdc-harness',
              specVerifiedAt: new Date(T0).toISOString(),
              noOpenOrMergedPr: true,
              expectedSpec: EXPECTED_SPEC,
              specSource: 'repo-path',
            },
          };
        },
        createTask: (async (_context, data) => {
          events.push(data.body.includes('Ratified ruling') ? 'deliver_ruling' : 'escalate_p0');
          return { id: `msg-${events.length}`, status: 'queued' } as never;
        }) as TaskmasterDeps['createTask'],
        // The unclaimed-P0 escalation (#520) now delivers as a GitHub issue
        // comment, not a dispatch message; record it in the same ordering trace
        // (WO-HARNESS-TASKMASTER-ESCALATE-TO-ISSUE-01).
        escalationDelivery: makeIssueCommentSink(world, () => events.push('escalate_p0')).delivery,
        runCascade: (async options => {
          events.push(`fire:${options.woId}`);
          const record = { cascadeId: `cascade-${options.woId}`, status: 'running' } as never;
          options.onAdmission?.(record, true);
          return record;
        }) as NonNullable<TaskmasterDeps['runCascade']>,
      });
      await tick(createTaskmasterState(60_000), deps);
      expect(events).toEqual([
        'deliver_ruling',
        'escalate_p0',
        'fire:WO-HARNESS-EXAMPLE-521',
        'fire:WO-HARNESS-EXAMPLE-523',
      ]);
    } finally {
      if (prior === undefined) delete process.env.TASKMASTER_FIRE_VERB_ENABLED;
      else process.env.TASKMASTER_FIRE_VERB_ENABLED = prior;
    }
  });

  test('daily cap dispatches P0 and P1 first and preserves overflow across ticks and restart', async () => {
    const prior = process.env.TASKMASTER_FIRE_VERB_ENABLED;
    process.env.TASKMASTER_FIRE_VERB_ENABLED = 'true';
    try {
      const world = makeWorld();
      seedDigestSent(world);
      const threads = [
        ['P3', 513],
        ['P2', 512],
        ['P0', 510],
        ['P3', 514],
        ['P1', 511],
      ].map(([priority, number]) =>
        makeListedThread({
          ref: `gh:thinmansoftware/bdc-harness#${number}`,
          priority: priority as ThreadSnapshot['priority'],
          isUnclaimed: true,
          isUnclaimedP0: priority === 'P0',
          title: `WO-HARNESS-EXAMPLE-${number} build`,
          lastActivityAt: new Date(T0).toISOString(),
        })
      );
      const admitted: string[] = [];
      const deps = makeDeps(world, {
        listThreads: async () => threads,
        checkFireEligibility: async title => {
          const woId = title.split(' ')[0]!;
          return {
            eligible: true,
            evidence: {
              woId,
              targetRepo: 'thinmansoftware/bdc-harness',
              project: 'bdc-harness',
              specVerifiedAt: new Date(T0).toISOString(),
              noOpenOrMergedPr: true,
              expectedSpec: EXPECTED_SPEC,
              specSource: 'repo-path',
            },
          };
        },
        runCascade: (async options => {
          admitted.push(options.woId);
          const record = { cascadeId: `cascade-${options.woId}`, status: 'running' } as never;
          options.onAdmission?.(record, true);
          return record;
        }) as NonNullable<TaskmasterDeps['runCascade']>,
      });
      const state = createTaskmasterState(60_000);
      await tick(state, deps);
      expect(admitted).toEqual(['WO-HARNESS-EXAMPLE-510', 'WO-HARNESS-EXAMPLE-511']);
      expect(world.journal.filter(row => row.outcome === 'deferred')).toHaveLength(3);

      world.nowMs += 60_000;
      await tick(state, deps);
      expect(admitted).toHaveLength(2);
      world.nowMs += 60_000;
      await tick(createTaskmasterState(60_000), deps);
      expect(admitted).toHaveLength(2);
    } finally {
      if (prior === undefined) delete process.env.TASKMASTER_FIRE_VERB_ENABLED;
      else process.env.TASKMASTER_FIRE_VERB_ENABLED = prior;
    }
  });

  test('prior same-day unresolved automatic fires close the daily faucet', async () => {
    const prior = process.env.TASKMASTER_FIRE_VERB_ENABLED;
    process.env.TASKMASTER_FIRE_VERB_ENABLED = 'true';
    try {
      const world = makeWorld();
      seedDigestSent(world);
      const item = makeListedThread({
        ref: 'gh:thinmansoftware/bdc-harness#504',
        priority: 'P0',
        isUnclaimedP0: true,
        title: 'WO-HARNESS-EXAMPLE-01 urgent build',
      });
      for (const n of [1, 2]) {
        world.journal.push({
          id: `same-day-fire-${n}`,
          created_at: new Date(T0 - n * 60_000).toISOString(),
          thread_ref: item.ref,
          action_type: 'fire_cauldron',
          proposal_json: JSON.stringify({
            type: 'fire_cauldron',
            cascadeId: `old-cascade-${n}`,
            fireEvidence: { woId: 'WO-HARNESS-EXAMPLE-01' },
          }),
          idempotency_key: `old-fire-${n}`,
          before_hash: null,
          proof_predicate: null,
          proof_deadline_at: new Date(T0 + 60_000).toISOString(),
          outcome: 'sent',
          graded_at: null,
          grade: null,
        });
      }
      let admissions = 0;
      await tick(
        createTaskmasterState(60_000),
        makeDeps(world, {
          listThreads: async () => [item],
          getFireRunEvidence: async () => ({ status: 'completed', prOpened: false }),
          checkFireEligibility: async () => ({
            eligible: true,
            evidence: {
              woId: 'WO-HARNESS-EXAMPLE-01',
              targetRepo: 'thinmansoftware/bdc-harness',
              project: 'bdc-harness',
              specVerifiedAt: new Date(T0).toISOString(),
              noOpenOrMergedPr: true,
              expectedSpec: EXPECTED_SPEC,
            },
          }),
          runCascade: (async options => {
            admissions += 1;
            const record = { cascadeId: 'new-cascade', status: 'running' } as never;
            options.onAdmission?.(record, true);
            return record;
          }) as NonNullable<TaskmasterDeps['runCascade']>,
        })
      );
      expect(admissions).toBe(0);
      expect(world.journal.filter(row => row.action_type === 'fire_cauldron')).toHaveLength(3);
    } finally {
      if (prior === undefined) delete process.env.TASKMASTER_FIRE_VERB_ENABLED;
      else process.env.TASKMASTER_FIRE_VERB_ENABLED = prior;
    }
  });

  test('tick derives case-insensitive customer P0 exemption while holding all lanes', async () => {
    const prior = process.env.TASKMASTER_FIRE_VERB_ENABLED;
    process.env.TASKMASTER_FIRE_VERB_ENABLED = 'true';
    try {
      const world = makeWorld();
      seedDigestSent(world);
      const threads = [
        makeListedThread({
          ref: 'gh:thinmansoftware/bdc-harness#505',
          priority: 'P0',
          isUnclaimedP0: true,
          labels: ['wo', 'CuStOmEr-FaCiNg'],
          title: 'WO-HARNESS-EXAMPLE-01 customer outage',
        }),
        makeListedThread({
          ref: 'gh:thinmansoftware/bdc-harness#506',
          priority: 'P1',
          isUnclaimedP0: true,
          labels: ['CUSTOMER'],
          title: 'WO-HARNESS-EXAMPLE-02 mislabeled priority',
        }),
      ];
      const healthProviders: string[] = [];
      let admissions = 0;
      await tick(
        createTaskmasterState(60_000),
        makeDeps(world, {
          listThreads: async () => threads,
          headroom: async () => ({
            state: 'LOW',
            tokensRemaining: 0,
            isUnknown: false,
            source: 'test',
            observedAt: new Date(T0).toISOString(),
          }),
          getHealthSample: async provider => {
            healthProviders.push(provider);
            return {
              provider,
              state: 'degraded',
              sampled_at: new Date(T0).toISOString(),
              expires_at: new Date(T0 + 60_000).toISOString(),
              evidence: null,
            };
          },
          checkFireEligibility: async title => ({
            eligible: true,
            evidence: {
              woId: title.includes('EXAMPLE-01')
                ? 'WO-HARNESS-EXAMPLE-01'
                : 'WO-HARNESS-EXAMPLE-02',
              targetRepo: 'thinmansoftware/bdc-harness',
              project: 'bdc-harness',
              specVerifiedAt: new Date(T0).toISOString(),
              noOpenOrMergedPr: true,
              expectedSpec: EXPECTED_SPEC,
            },
          }),
          runCascade: (async options => {
            admissions += 1;
            const record = { cascadeId: 'customer-cascade', status: 'running' } as never;
            options.onAdmission?.(record, true);
            return record;
          }) as NonNullable<TaskmasterDeps['runCascade']>,
        })
      );
      expect(healthProviders.sort()).toEqual(['codex', 'cursor', 'xai', 'zero']);
      expect(admissions).toBe(1);
      expect(
        world.journal.filter(row => row.action_type === 'fire_cauldron').map(row => row.thread_ref)
      ).toEqual([threads[0]!.ref]);
    } finally {
      if (prior === undefined) delete process.env.TASKMASTER_FIRE_VERB_ENABLED;
      else process.env.TASKMASTER_FIRE_VERB_ENABLED = prior;
    }
  });

  test('budget hold monitor is visible once per 96 ticks and health is read each tick', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    const monitorTicks: number[] = [];
    let healthReads = 0;
    const deps = makeDeps(world, {
      headroom: async () => ({
        state: 'LOW',
        tokensRemaining: 0,
        isUnknown: false,
        source: 'test',
        observedAt: new Date(world.nowMs).toISOString(),
      }),
      getHealthSample: async provider => {
        healthReads += 1;
        return {
          provider,
          state: 'degraded',
          sampled_at: new Date(world.nowMs).toISOString(),
          expires_at: new Date(world.nowMs + 60_000).toISOString(),
          evidence: null,
        };
      },
      onFireBudgetHolding: tickIndex => monitorTicks.push(tickIndex),
    });
    const state = createTaskmasterState(60_000);
    for (let n = 0; n < 97; n += 1) {
      await tick(state, deps);
      world.nowMs += 60_000;
    }
    expect(monitorTicks).toEqual([1, 97]);
    expect(healthReads).toBe(97 * 4);
  });

  test('pause scope=effects parks an eligible fire without admitting a cascade', async () => {
    const prior = process.env.TASKMASTER_FIRE_VERB_ENABLED;
    process.env.TASKMASTER_FIRE_VERB_ENABLED = 'true';
    try {
      const world = makeWorld();
      seedDigestSent(world);
      world.control.pause_state = 'PAUSED';
      world.control.pause_scope = 'effects';
      const item = makeListedThread({
        ref: 'gh:thinmansoftware/bdc-harness#502',
        priority: 'P0',
        isUnclaimedP0: true,
        title: 'WO-HARNESS-EXAMPLE-01 urgent build',
      });
      let admissions = 0;
      await tick(
        createTaskmasterState(60_000),
        makeDeps(world, {
          listThreads: async () => [item],
          checkFireEligibility: async () => ({
            eligible: true,
            evidence: {
              woId: 'WO-HARNESS-EXAMPLE-01',
              targetRepo: 'thinmansoftware/bdc-harness',
              project: 'bdc-harness',
              specVerifiedAt: new Date(T0).toISOString(),
              noOpenOrMergedPr: true,
              expectedSpec: EXPECTED_SPEC,
            },
          }),
          runCascade: (async () => {
            admissions += 1;
            throw new Error('paused fire must not run');
          }) as NonNullable<TaskmasterDeps['runCascade']>,
        })
      );
      expect(admissions).toBe(0);
      const fire = world.journal.find(row => row.action_type === 'fire_cauldron');
      expect(fire?.outcome).toBe('parked');
      expect(fire?.proposal_json).toContain('"reason":"paused"');
    } finally {
      if (prior === undefined) delete process.env.TASKMASTER_FIRE_VERB_ENABLED;
      else process.env.TASKMASTER_FIRE_VERB_ENABLED = prior;
    }
  });

  test('grades proven fire evidence and leaves overdue UNKNOWN ungraded', async () => {
    for (const testCase of [
      { id: 'completed-fire', status: 'completed', deadline: T0 + 60_000, grade: 'useful' },
      { id: 'overdue-running-fire', status: 'running', deadline: T0 - 1, grade: 'noise' },
      { id: 'overdue-unknown-fire', status: null, deadline: T0 - 1, grade: null },
    ] as const) {
      const world = makeWorld();
      seedDigestSent(world);
      world.journal.push({
        id: testCase.id,
        created_at: new Date(T0 - 60_000).toISOString(),
        thread_ref: 'gh:thinmansoftware/bdc-harness#503',
        action_type: 'fire_cauldron',
        proposal_json: JSON.stringify({
          type: 'fire_cauldron',
          cascadeId: `cascade-${testCase.id}`,
          fireEvidence: { woId: 'WO-HARNESS-EXAMPLE-01', project: 'bdc-harness' },
        }),
        idempotency_key: `tm:fire:${testCase.id}`,
        before_hash: null,
        proof_predicate: 'cascade completes, opens a PR, or issue enters BUILDING',
        proof_deadline_at: new Date(testCase.deadline).toISOString(),
        outcome: 'sent',
        graded_at: null,
        grade: null,
      });
      let evidenceCalls = 0;
      await tick(
        createTaskmasterState(60_000),
        makeDeps(world, {
          getFireRunEvidence: async (woId, cascadeId, project) => {
            evidenceCalls += 1;
            expect([woId, cascadeId, project]).toEqual([
              'WO-HARNESS-EXAMPLE-01',
              `cascade-${testCase.id}`,
              'bdc-harness',
            ]);
            if (testCase.status === null) throw new Error('taskmaster_cascade_evidence_unknown');
            return { status: testCase.status, prOpened: false };
          },
        })
      );
      expect(evidenceCalls).toBe(1);
      expect(world.journal.find(row => row.id === testCase.id)?.grade).toBe(testCase.grade);
    }
  });

  test('entry_override_passed_for_cursor_and_zero_only', async () => {
    const prior = process.env.TASKMASTER_FIRE_VERB_ENABLED;
    process.env.TASKMASTER_FIRE_VERB_ENABLED = 'true';
    const low = {
      state: 'LOW' as const,
      tokensRemaining: 0,
      isUnknown: false,
      source: 'test' as const,
      observedAt: new Date(T0).toISOString(),
    };
    const fireOnce = async (phase: 'cursor' | 'zero', ref: string): Promise<unknown> => {
      const world = makeWorld();
      seedDigestSent(world);
      let entryOverride: unknown;
      let admissions = 0;
      await tick(
        createTaskmasterState(60_000),
        makeDeps(world, {
          listThreads: async () => [
            makeListedThread({
              ref,
              priority: 'P1',
              isUnclaimed: true,
              title: 'WO-HARNESS-EXAMPLE-01 urgent build',
            }),
          ],
          headroom: async () => low,
          getHealthSample: async provider => {
            const state =
              provider === 'codex'
                ? 'degraded'
                : provider === 'cursor'
                  ? phase === 'cursor'
                    ? 'healthy'
                    : 'degraded'
                  : provider === 'zero' && phase === 'zero'
                    ? 'healthy'
                    : 'degraded';
            return {
              provider,
              state,
              sampled_at: new Date(T0).toISOString(),
              expires_at: new Date(T0 + 60_000).toISOString(),
              evidence: null,
            };
          },
          checkFireEligibility: async () => ({
            eligible: true,
            evidence: {
              woId: 'WO-HARNESS-EXAMPLE-01',
              targetRepo: 'thinmansoftware/bdc-harness',
              project: 'bdc-harness',
              specVerifiedAt: new Date(T0).toISOString(),
              noOpenOrMergedPr: true,
              expectedSpec: EXPECTED_SPEC,
            },
          }),
          runCascade: (async options => {
            admissions += 1;
            entryOverride = options.entryOverride;
            const record = { cascadeId: `cascade-${phase}`, status: 'running' } as never;
            options.onAdmission?.(record, true);
            return record;
          }) as NonNullable<TaskmasterDeps['runCascade']>,
        })
      );
      expect(admissions).toBe(1);
      return entryOverride;
    };
    try {
      expect(await fireOnce('cursor', 'gh:thinmansoftware/bdc-harness#611')).toBe('cursor');
      expect(await fireOnce('zero', 'gh:thinmansoftware/bdc-harness#612')).toBe('zero');
    } finally {
      if (prior === undefined) delete process.env.TASKMASTER_FIRE_VERB_ENABLED;
      else process.env.TASKMASTER_FIRE_VERB_ENABLED = prior;
    }
  });

  test('entry_override_absent_for_claude_codex_xai', async () => {
    const prior = process.env.TASKMASTER_FIRE_VERB_ENABLED;
    process.env.TASKMASTER_FIRE_VERB_ENABLED = 'true';
    const low = {
      state: 'LOW' as const,
      tokensRemaining: 0,
      isUnknown: false,
      source: 'test' as const,
      observedAt: new Date(T0).toISOString(),
    };
    const cases = [
      {
        ref: 'gh:thinmansoftware/bdc-harness#621',
        lane: 'claude',
        headroom: undefined,
        health: {} as Partial<Record<string, 'healthy' | 'degraded'>>,
      },
      {
        ref: 'gh:thinmansoftware/bdc-harness#622',
        lane: 'codex',
        headroom: low,
        health: {
          codex: 'healthy' as const,
          cursor: 'degraded' as const,
          zero: 'degraded' as const,
        },
      },
      {
        ref: 'gh:thinmansoftware/bdc-harness#623',
        lane: 'xai',
        headroom: low,
        health: {
          codex: 'degraded' as const,
          cursor: 'degraded' as const,
          zero: 'degraded' as const,
          xai: 'healthy' as const,
        },
      },
    ];
    // Measured Claude seat usage in this environment would skip the default
    // lane. Unknown readings keep the test on the headroom decision.
    setSeatUsageReaderForTests(async seats => {
      const readings: Partial<
        Record<(typeof seats)[number], ReturnType<typeof unknownSeatReading>>
      > = {};
      for (const seat of seats) readings[seat] = unknownSeatReading(seat, 'test');
      return readings;
    });
    try {
      for (const testCase of cases) {
        const world = makeWorld();
        seedDigestSent(world);
        const seen: unknown[] = [];
        await tick(
          createTaskmasterState(60_000),
          makeDeps(world, {
            listThreads: async () => [
              makeListedThread({
                ref: testCase.ref,
                priority: 'P1',
                isUnclaimed: true,
                title: 'WO-HARNESS-EXAMPLE-01 urgent build',
              }),
            ],
            ...(testCase.headroom ? { headroom: async () => testCase.headroom } : {}),
            getHealthSample: async provider => {
              const state = testCase.health[provider];
              if (!state) return null;
              return {
                provider,
                state,
                sampled_at: new Date(T0).toISOString(),
                expires_at: new Date(T0 + 60_000).toISOString(),
                evidence: null,
              };
            },
            checkFireEligibility: async () => ({
              eligible: true,
              evidence: {
                woId: 'WO-HARNESS-EXAMPLE-01',
                targetRepo: 'thinmansoftware/bdc-harness',
                project: 'bdc-harness',
                specVerifiedAt: new Date(T0).toISOString(),
                noOpenOrMergedPr: true,
                expectedSpec: EXPECTED_SPEC,
              },
            }),
            runCascade: (async options => {
              seen.push(options.entryOverride);
              const record = { cascadeId: `cascade-${testCase.ref}`, status: 'running' } as never;
              options.onAdmission?.(record, true);
              return record;
            }) as NonNullable<TaskmasterDeps['runCascade']>,
          })
        );
        expect(seen).toEqual([undefined]);
        expect(
          world.journal.find(row => row.action_type === 'fire_cauldron')?.proposal_json
        ).toContain(`on ${testCase.lane} lane`);
      }
    } finally {
      setSeatUsageReaderForTests(fixtureSeatUsage);
      if (prior === undefined) delete process.env.TASKMASTER_FIRE_VERB_ENABLED;
      else process.env.TASKMASTER_FIRE_VERB_ENABLED = prior;
    }
  });
});

describe('pending fire custody', () => {
  let prior: string | undefined;
  beforeEach(() => {
    prior = process.env.TASKMASTER_FIRE_VERB_ENABLED;
    process.env.TASKMASTER_FIRE_VERB_ENABLED = 'true';
  });
  afterEach(() => {
    if (prior === undefined) delete process.env.TASKMASTER_FIRE_VERB_ENABLED;
    else process.env.TASKMASTER_FIRE_VERB_ENABLED = prior;
  });

  function setup(world: FakeWorld, overrides: Partial<TaskmasterDeps> = {}) {
    let fires = 0;
    const deps = makeDeps(world, {
      listUndeliveredRulings: async () => [],
      escalationDelivery: makeIssueCommentSink(world).delivery,
      listThreads: async () => [
        makeListedThread({
          ref: 'gh:thinmansoftware/bdc-harness#700',
          priority: 'P0',
          isUnclaimedP0: true,
          title: 'WO-HARNESS-CUSTODY-01',
        }),
      ],
      checkFireEligibility: async title => ({
        eligible: true,
        evidence: {
          woId: title,
          project: 'bdc-harness',
          targetRepo: 'thinmansoftware/bdc-harness',
          noOpenOrMergedPr: true,
          specVerifiedAt: new Date(T0).toISOString(),
          expectedSpec: EXPECTED_SPEC,
        },
      }),
      runCascade: async options => {
        fires++;
        const record = {
          cascadeId: options.dispatchId,
          woId: options.woId,
          project: options.project,
          status: 'running',
          attempts: [],
          request: { dryRun: false },
        } as never;
        options.onAdmission?.(record, true);
        return record;
      },
      ...overrides,
    });
    return { deps, fires: () => fires };
  }

  test.each([false, true])(
    'delayed admission shares its durable deadline with supervision (crash=%s)',
    async crashAfterRegistration => {
      const world = makeWorld();
      seedDigestSent(world);
      const native = new SqliteAdapter(':memory:');
      await native.query("UPDATE tm_control SET pause_state='RUNNING',epoch=$1 WHERE id=1", [
        world.control.epoch,
      ]);
      const budget: NonNullable<TaskmasterDeps['fireBudget']> = {
        reserveAutomaticFire: input => fireBudgetDb.reserveAutomaticFire(input, native),
        authorizeAutomaticFire: input => fireBudgetDb.authorizeAutomaticFire(input, native),
        releaseAutomaticFire: input => fireBudgetDb.releaseAutomaticFire(input, native),
        settleAutomaticFire: input => fireBudgetDb.settleAutomaticFire(input, native),
        seedAutomaticFireHistory: input => fireBudgetDb.seedAutomaticFireHistory(input, native),
        listAutomaticFireAdmissions: () => fireBudgetDb.listAutomaticFireAdmissions(native),
        updateAutomaticFireExpectation: input =>
          fireBudgetDb.updateAutomaticFireExpectation(input, native),
      };
      const fixture = setup(world, { fireBudget: budget });
      const dal = fixture.deps.db!;
      let interrupted = false;
      fixture.deps.db = {
        ...dal,
        recordAction: async data => {
          const row = await dal.recordAction(data);
          await native.query(
            `INSERT INTO tm_journal
          (id,thread_ref,action_type,proposal_json,idempotency_key,outcome,created_at,proof_deadline_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [
              row.id,
              row.thread_ref,
              row.action_type,
              row.proposal_json,
              row.idempotency_key,
              row.outcome,
              row.created_at,
              row.proof_deadline_at,
            ]
          );
          return row;
        },
        getActionByIdempotencyKey: async key =>
          (
            await native.query<TmJournalEntry>(
              'SELECT * FROM tm_journal WHERE idempotency_key=$1',
              [key]
            )
          ).rows[0] ?? null,
        listPendingFireActions: async () =>
          (
            await native.query<TmJournalEntry>(
              "SELECT * FROM tm_journal WHERE action_type='fire_cauldron' AND outcome='pending'"
            )
          ).rows,
        registerExpectation: async data => {
          const key = expectationRegistrationKey(data.action_ref ?? null, data.dispatch_ref);
          // Match production idempotency: an existing expectation's deadline is retained.
          await native.query(
            `INSERT INTO tm_expectations
          (id,registration_key,dispatch_ref,recipient,evidence_json,due_at,on_absence,max_retries,
           retries,status,registered_by,self_supervised,created_at,updated_at)
          VALUES ($1,$1,$2,$3,$4,$5,$6,$7,0,'pending','taskmaster',0,$8,$8)
          ON CONFLICT(registration_key) DO NOTHING`,
            [
              key,
              data.dispatch_ref,
              data.recipient,
              data.evidence_json,
              data.due_at,
              data.on_absence,
              data.max_retries,
              new Date(world.nowMs).toISOString(),
            ]
          );
          return key;
        },
        getExpectationByRegistrationKey: async key =>
          (
            await native.query<TmExpectation>(
              'SELECT * FROM tm_expectations WHERE registration_key=$1',
              [key]
            )
          ).rows[0] ?? null,
        transitionPendingFireAction: async (id, expected, outcome, proposal) => {
          if (crashAfterRegistration && outcome === 'sent' && !interrupted) {
            interrupted = true;
            return false; // Crash boundary: supervision persisted, journal still pending.
          }
          const result = await native.query(
            `UPDATE tm_journal SET outcome=$1,proposal_json=$2
          WHERE id=$3 AND outcome='pending' AND proposal_json=$4`,
            [outcome, proposal, id, expected]
          );
          if (result.rowCount)
            await dal.transitionPendingFireAction!(id, expected, outcome, proposal);
          return result.rowCount === 1;
        },
      };
      fixture.deps.runCascade = async options => {
        world.nowMs += 45 * 60_000; // Async preflight finishes well after journal creation.
        const permission = await options.beforeAdmission!();
        const record = {
          cascadeId: options.dispatchId!,
          woId: options.woId,
          project: options.project,
          automaticFireAdmission: permission,
          status: 'running',
          attempts: [{ runId: 'actual-delayed-workflow' }],
        } as Awaited<ReturnType<NonNullable<TaskmasterDeps['runCascade']>>>;
        options.onAdmission?.(record, true);
        return record;
      };
      try {
        await tick(createTaskmasterState(60_000), fixture.deps);
        const row = (
          await native.query<TmJournalEntry>(
            "SELECT * FROM tm_journal WHERE action_type='fire_cauldron'"
          )
        ).rows[0]!;
        const expectation = (await native.query<TmExpectation>('SELECT * FROM tm_expectations'))
          .rows[0]!;
        const correctDue = new Date(world.nowMs + 86_400_000).toISOString();
        expect(row.proof_deadline_at).toBe(correctDue);
        expect(expectation.due_at).toBe(correctDue);
        expect(row.outcome).toBe(crashAfterRegistration ? 'pending' : 'sent');
        if (crashAfterRegistration) {
          fixture.deps.listThreads = async () => []; // Recover custody without proposing new work.
          await tick(createTaskmasterState(60_000), fixture.deps);
          const recovered = (
            await native.query<TmJournalEntry>('SELECT * FROM tm_journal WHERE id=$1', [row.id])
          ).rows[0]!;
          expect(recovered.outcome).toBe('sent');
          expect((await native.query('SELECT * FROM tm_expectations')).rows).toHaveLength(1);
          expect(
            (await native.query<TmExpectation>('SELECT * FROM tm_expectations')).rows[0]!.due_at
          ).toBe(correctDue);
        }
      } finally {
        await native.close();
      }
    }
  );

  test('admission without a proven workflow stays pending across later ticks and buckets', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    const fixture = setup(world, {
      readFireCascadeEvidence: async () => {
        throw new Error('taskmaster_cascade_evidence_unknown');
      },
    });
    const state = createTaskmasterState(60_000);
    const first = await tick(state, fixture.deps);
    const fire = world.journal.find(row => row.action_type === 'fire_cauldron');
    expect(fire?.outcome).toBe('pending');
    expect(JSON.parse(fire!.proposal_json).runId).toBeUndefined();
    expect(first.effects).toBe(0);
    world.nowMs += 4 * 3_600_000;
    await tick(state, fixture.deps);
    expect(fixture.fires()).toBe(1);
    expect(fire?.outcome).toBe('pending');
  });

  test('journal sent identity is the actual workflow and stored supervision is cascade-bound', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    const fixture = setup(world, {
      readFireCascadeEvidence: async () => ({
        earliestRunId: 'actual-workflow-123',
        completedRunId: null,
        status: 'running',
        prOpened: false,
      }),
    });
    await tick(createTaskmasterState(60_000), fixture.deps);
    const fire = world.journal.find(row => row.action_type === 'fire_cauldron')!;
    const proposal = JSON.parse(fire.proposal_json);
    expect(fire.outcome).toBe('sent');
    expect(proposal.runId).toBe('actual-workflow-123');
    expect(proposal.cascadeId).toBe(fire.idempotency_key);
    const stored = [...world.expectations.values()][0]!;
    expect(JSON.parse(stored.evidence_json)).toMatchObject({
      kind: 'cascade_workflow_completed',
      cascadeId: proposal.cascadeId,
      woId: 'WO-HARNESS-CUSTODY-01',
      project: 'bdc-harness',
    });
    expect(stored.due_at).toBe(fire.proof_deadline_at);
  });

  test('explicit zero-attempt refusal before permission expires without reporting a sent fire', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    const fixture = setup(world);
    // Use the real pre-permission boundary, bypassing the admitted-fire wrapper.
    fixture.deps.runCascade = async options =>
      ({
        cascadeId: options.dispatchId,
        woId: options.woId,
        project: options.project,
        status: 'refused',
        attempts: [],
      }) as never;
    const result = await tick(createTaskmasterState(60_000), fixture.deps);
    expect(world.journal.find(row => row.action_type === 'fire_cauldron')?.outcome).toBe('expired');
    expect(result.effects).toBe(0);
    expect(world.expectations.size).toBe(0);
  });

  test('zero-attempt refusal after committed permission stays charged and pending', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    const fixture = setup(world, {
      runCascade: async options =>
        ({
          cascadeId: options.dispatchId,
          woId: options.woId,
          project: options.project,
          status: 'refused',
          attempts: [],
        }) as never,
      readFireCascadeEvidence: async () => {
        throw new Error('no workflow proof');
      },
    });
    const result = await tick(createTaskmasterState(60_000), fixture.deps);
    expect(world.journal.find(row => row.action_type === 'fire_cauldron')?.outcome).toBe('pending');
    expect(result.effects).toBe(0);
    const rows = (
      await budgetStores.get(world)!.query<{
        state: string;
        admitted_at: string | null;
      }>('SELECT state,admitted_at FROM tm_fire_admissions')
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe('admitted');
    expect(rows[0]!.admitted_at).not.toBeNull();
  });

  test('ambiguous dispatch rejection retains pending custody instead of retryable failure', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    let calls = 0;
    const fixture = setup(world, {
      runCascade: async () => {
        calls++;
        throw new Error('synthetic ambiguous execution');
      },
      readFireCascadeEvidence: async () => {
        throw new Error('unknown');
      },
    });
    const state = createTaskmasterState(60_000);
    await tick(state, fixture.deps);
    await tick(state, fixture.deps);
    expect(calls).toBe(1);
    expect(world.journal.find(row => row.action_type === 'fire_cauldron')?.outcome).toBe('pending');
  });

  test('uncertain release storage preserves pending custody after an ambiguous launch', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    const budget = fixtureFireBudget(world);
    const fixture = setup(world, {
      fireBudget: {
        ...budget,
        releaseAutomaticFire: async () => {
          throw new Error('synthetic storage uncertainty');
        },
      },
      runCascade: async () => {
        throw new Error('synthetic lost launch result');
      },
      readFireCascadeEvidence: async () => {
        throw new Error('unknown workflow');
      },
    });
    await tick(createTaskmasterState(60_000), fixture.deps);
    expect(world.journal.find(row => row.action_type === 'fire_cauldron')?.outcome).toBe('pending');
    const rows = await budget.listAutomaticFireAdmissions();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe('unknown');
    expect(rows[0]!.admitted_at).not.toBeNull();
  });

  test.each([
    [2, 2],
    [5, 3],
  ])(
    'unconfirmed admissions obey daily limit %i and per-tick ceiling (%i)',
    async (limit, expected) => {
      const previous = process.env.TASKMASTER_FIRE_MAX_PER_DAY;
      process.env.TASKMASTER_FIRE_MAX_PER_DAY = String(limit);
      try {
        const world = makeWorld();
        seedDigestSent(world);
        const fixture = setup(world, {
          listThreads: async () =>
            [1, 2, 3, 4].map(n =>
              makeListedThread({
                ref: `gh:thinmansoftware/bdc-harness#${700 + n}`,
                priority: 'P0',
                isUnclaimedP0: true,
                title: `WO-HARNESS-CUSTODY-${String(n).padStart(2, '0')}`,
              })
            ),
          readFireCascadeEvidence: async () => {
            throw new Error('not ready');
          },
        });
        const result = await tick(createTaskmasterState(60_000), fixture.deps);
        expect(fixture.fires()).toBe(expected);
        expect(
          world.journal.filter(
            row => row.action_type === 'fire_cauldron' && row.outcome === 'pending'
          )
        ).toHaveLength(expected);
        expect(world.journal.filter(row => row.outcome === 'deferred')).toHaveLength(4 - expected);
        expect(result.effects).toBe(0);
      } finally {
        if (previous === undefined) delete process.env.TASKMASTER_FIRE_MAX_PER_DAY;
        else process.env.TASKMASTER_FIRE_MAX_PER_DAY = previous;
      }
    }
  );

  function seedPending(world: FakeWorld, ageDays = 8): TmJournalEntry {
    const key = 'tm:fire:old-custody';
    const created = world.nowMs - ageDays * 86_400_000;
    const row: TmJournalEntry = {
      id: 'old-pending-fire',
      created_at: new Date(created).toISOString(),
      thread_ref: 'gh:thinmansoftware/bdc-harness#700',
      action_type: 'fire_cauldron',
      proposal_json: JSON.stringify({
        type: 'fire_cauldron',
        threadRef: 'gh:thinmansoftware/bdc-harness#700',
        recipient: 'xo',
        body: '',
        actsImmediately: true,
        idempotencyKey: key,
        cascadeId: key,
        fireEvidence: {
          woId: 'WO-HARNESS-CUSTODY-01',
          project: 'bdc-harness',
          targetRepo: 'thinmansoftware/bdc-harness',
          expectedSpec: EXPECTED_SPEC,
        },
      }),
      idempotency_key: key,
      before_hash: null,
      proof_predicate: 'actual workflow completion',
      proof_deadline_at: new Date(created + 86_400_000).toISOString(),
      outcome: 'pending',
      graded_at: null,
      grade: null,
    };
    world.journal.push(row);
    return row;
  }

  for (const priorRegistration of ['none', 'matching', 'legacy-wrong'] as const) {
    test(`old pending fire reconciles exact custody without another invocation (${priorRegistration})`, async () => {
      const world = makeWorld();
      seedDigestSent(world);
      const pending = seedPending(world);
      const due = pending.proof_deadline_at;
      const key = expectationRegistrationKey(pending.id, pending.idempotency_key!);
      if (priorRegistration !== 'none') {
        world.expectations.set(key, {
          id: 'existing-expectation',
          dispatch_ref: pending.idempotency_key!,
          recipient: 'xo',
          evidence_json: JSON.stringify(
            priorRegistration === 'matching'
              ? {
                  kind: 'cascade_workflow_completed',
                  cascadeId: pending.idempotency_key,
                  woId: 'WO-HARNESS-CUSTODY-01',
                  project: 'bdc-harness',
                }
              : {
                  kind: 'db_row_exists',
                  table: 'remote_agent_workflow_runs',
                  where: { id: pending.idempotency_key, status: ['completed'] },
                }
          ),
          due_at: due!,
          on_absence: 'escalate',
          max_retries: 0,
          retries: 0,
          status: 'pending',
          evidence_pointer: null,
          registered_by: 'taskmaster',
          self_supervised: 0,
          created_at: pending.created_at,
          updated_at: pending.created_at,
        });
      }
      let invokes = 0;
      const fixture = setup(world, {
        listThreads: async () => [],
        runCascade: async () => {
          invokes++;
          throw new Error('must not invoke');
        },
      });
      await tick(createTaskmasterState(60_000), fixture.deps);
      expect(invokes).toBe(0);
      expect(world.expectations.size).toBe(1);
      const stored = world.expectations.get(key)!;
      expect(stored.due_at).toBe(due);
      if (priorRegistration === 'legacy-wrong') {
        expect(pending.outcome).toBe('pending');
        expect(JSON.parse(pending.proposal_json).fireHoldReason).toBe(
          'expectation-registration-mismatch'
        );
        expect(JSON.parse(stored.evidence_json).kind).toBe('db_row_exists');
      } else {
        expect(pending.outcome).toBe('sent');
        expect(JSON.parse(pending.proposal_json).runId).toBe(`actual-${pending.idempotency_key}`);
        if (priorRegistration === 'matching') expect(stored.id).toBe('existing-expectation');
      }
    });
  }

  test('old UNKNOWN custody holds its exact scope across a new key and process', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    const pending = seedPending(world);
    const fixture = setup(world, {
      readFireCascadeEvidence: async () => {
        throw new Error('missing record');
      },
    });
    await tick(createTaskmasterState(60_000), fixture.deps);
    expect(fixture.fires()).toBe(0);
    expect(pending.outcome).toBe('pending');
    expect(world.journal.filter(row => row.action_type === 'fire_cauldron')).toHaveLength(1);
  });

  test('malformed unresolved fire metadata holds all new fires rather than vanishing', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    const pending = seedPending(world);
    pending.proposal_json = '{';
    const fixture = setup(world);
    await tick(createTaskmasterState(60_000), fixture.deps);
    expect(fixture.fires()).toBe(0);
    expect(pending.outcome).toBe('pending');
    expect(pending.proposal_json).toBe('{');
  });

  test('a malformed WO with trailing text cannot evade custody scope matching', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    const pending = seedPending(world);
    const proposal = JSON.parse(pending.proposal_json);
    proposal.fireEvidence.woId += ' trailing text';
    pending.proposal_json = JSON.stringify(proposal);
    const fixture = setup(world);
    await tick(createTaskmasterState(60_000), fixture.deps);
    expect(fixture.fires()).toBe(0);
    expect(pending.outcome).toBe('pending');
  });

  test('a project with whitespace cannot evade custody scope matching', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    const pending = seedPending(world);
    const proposal = JSON.parse(pending.proposal_json);
    proposal.fireEvidence.project += ' ';
    pending.proposal_json = JSON.stringify(proposal);
    const fixture = setup(world);
    await tick(createTaskmasterState(60_000), fixture.deps);
    expect(fixture.fires()).toBe(0);
    expect(pending.outcome).toBe('pending');
  });

  test('unavailable pending-custody read prevents new fire', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    const fixture = setup(world);
    fixture.deps.db!.listPendingFireActions = async () => {
      throw new Error('unavailable');
    };
    await tick(createTaskmasterState(60_000), fixture.deps);
    expect(fixture.fires()).toBe(0);
  });

  test('eight confirmed effects plus unconfirmed fire reservations obey the same ten-effect bound', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    const fixture = setup(world, {
      listUndeliveredRulings: async () =>
        Array.from({ length: 8 }, (_, n) =>
          ruling({ ref: `dispatch:budget-${n}`, undeliveredRulingId: `budget-${n}` })
        ),
      listThreads: async () =>
        [1, 2, 3].map(n =>
          makeListedThread({
            ref: `gh:thinmansoftware/bdc-harness#${710 + n}`,
            priority: 'P0',
            isUnclaimedP0: true,
            title: `WO-HARNESS-BUDGET-${String(n).padStart(2, '0')}`,
          })
        ),
      readFireCascadeEvidence: async () => {
        throw new Error('not ready');
      },
    });
    const result = await tick(createTaskmasterState(60_000), fixture.deps);
    expect(result.effects).toBe(8);
    expect(fixture.fires()).toBe(2);
    expect(
      world.journal.filter(row => row.action_type === 'fire_cauldron' && row.outcome === 'pending')
    ).toHaveLength(2);
    expect(world.journal.filter(row => row.outcome === 'deferred')).toHaveLength(1);
  });
});

describe('WO pause-gate enforcement (WO-HARNESS-TASKMASTER-PAUSE-GATE-ENFORCE-01)', () => {
  // Three deliverable-in-one-tick proposals: one deliver_ruling + two
  // unclaimed-P0 escalations (all actsImmediately, distinct threads).
  function threeDeliverables(): {
    rulings: ThreadSnapshot[];
    threads: ThreadSnapshot[];
    refs: string[];
  } {
    const ruled: ThreadSnapshot = {
      ref: 'dispatch:ruling-77',
      priority: 'P1',
      lastActivityAt: new Date(T0 - 3_600_000).toISOString(),
      undeliveredRulingId: 'ruling-77',
      recipient: 'xo',
    };
    const p0a: ThreadSnapshot = {
      ref: 'gh:thinmansoftware/bdc-harness#21',
      priority: 'P0',
      lastActivityAt: new Date(T0 - 3_600_000).toISOString(),
      isUnclaimedP0: true,
      recipient: 'xo',
    };
    const p0b: ThreadSnapshot = {
      ref: 'gh:thinmansoftware/bdc-harness#22',
      priority: 'P0',
      lastActivityAt: new Date(T0 - 3_600_000).toISOString(),
      isUnclaimedP0: true,
      recipient: 'xo',
    };
    return { rulings: [ruled], threads: [p0a, p0b], refs: [ruled.ref, p0a.ref, p0b.ref] };
  }

  test('Test 1: paused scope=effects tick withholds all 3 effects, parks each with reason=paused', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    world.control.pause_state = 'PAUSED';
    world.control.pause_scope = 'effects';
    world.control.pause_actor = 'john';

    const { rulings, threads, refs } = threeDeliverables();
    const deps = makeDeps(world, {
      listUndeliveredRulings: async () => rulings,
      listThreads: async () => threads,
    });
    const state = createTaskmasterState(60_000);

    const result = await tick(state, deps);

    // Zero transport calls.
    expect(world.sentMessages.length).toBe(0);
    // Exactly 3 parked rows, one per deliverable, each with reason=paused.
    expect(result.parked).toBe(3);
    const parked = world.journal.filter(j => j.outcome === 'parked' && refs.includes(j.thread_ref));
    expect(parked.length).toBe(3);
    for (const row of parked) {
      expect(row.proposal_json).toContain('"reason":"paused"');
    }
    // No sent journal rows for this tick.
    expect(world.journal.some(j => j.outcome === 'sent' && refs.includes(j.thread_ref))).toBe(
      false
    );
  });

  test('Test 2: running (RUNNING) tick delivers all 3 effects (no regression)', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    // pause_state defaults to RUNNING, pause_scope null.

    const { rulings, threads, refs } = threeDeliverables();
    const sink = makeIssueCommentSink(world);
    const deps = makeDeps(world, {
      listUndeliveredRulings: async () => rulings,
      listThreads: async () => threads,
      escalationDelivery: sink.delivery,
    });
    const state = createTaskmasterState(60_000);

    const result = await tick(state, deps);

    // All 3 deliver exactly as before the gate WO -- but the two gh-ref P0
    // escalations now land on their GitHub issues, not the operator mailbox
    // (WO-HARNESS-TASKMASTER-ESCALATE-TO-ISSUE-01). The ruling still dispatches.
    expect(result.effects).toBe(3);
    expect(result.parked).toBe(0);
    expect(world.sentMessages.length).toBe(1);
    expect(sink.posts()).toBe(2);
    const sent = world.journal.filter(j => j.outcome === 'sent' && refs.includes(j.thread_ref));
    expect(sent.length).toBe(3);
  });

  test('Test 3: no burst on unpause -- previously parked-by-pause rows are not replayed', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    world.control.pause_state = 'PAUSED';
    world.control.pause_scope = 'effects';
    world.control.pause_actor = 'john';

    const { rulings, threads, refs } = threeDeliverables();
    const deps = makeDeps(world, {
      listUndeliveredRulings: async () => rulings,
      listThreads: async () => threads,
    });
    const state = createTaskmasterState(60_000);

    // Paused tick parks all 3.
    const paused = await tick(state, deps);
    expect(paused.parked).toBe(3);
    expect(world.sentMessages.length).toBe(0);

    // Flip to RUNNING with a fresh epoch (resume pattern).
    world.control = {
      ...world.control,
      pause_state: 'RUNNING',
      pause_scope: null,
      epoch: world.control.epoch + 1,
    };

    // Next tick: the parked rows are NOT replayed (skip-on-parked at the top of
    // the effect loop guarantees this). The same proposals recompute; because
    // they still carry outcome='parked' from the prior tick they are skipped,
    // so no burst of sends fires from the pause backlog.
    world.nowMs += 60_000;
    const resumed = await tick(state, deps);

    // The previously-parked rows drive zero replays.
    expect(world.sentMessages.length).toBe(0);
    expect(resumed.effects).toBe(0);
    // The parked rows remain parked (not converted to sent).
    const stillParked = world.journal.filter(
      j => j.outcome === 'parked' && refs.includes(j.thread_ref)
    );
    expect(stillParked.length).toBe(3);
  });

  test('mid-tick pause (fresh-epoch re-check) also honors scope=effects for escalate_p0', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    // Start RUNNING so the initial gate lets the escalation through to the
    // ROW-FIRST write, then a pause lands before the fresh re-check.
    const p0: ThreadSnapshot = {
      ref: 'gh:thinmansoftware/bdc-harness#31',
      priority: 'P0',
      lastActivityAt: new Date(T0 - 3_600_000).toISOString(),
      isUnclaimedP0: true,
      recipient: 'xo',
    };

    let getCalls = 0;
    const deps = makeDeps(world, {
      listThreads: async () => [p0],
      db: {
        ...makeDeps(world).db,
        // First getPauseState (top of tick) sees RUNNING; the fresh re-check
        // just before the send sees PAUSED scope=effects at the SAME epoch, so
        // only the scope recompute (not the epoch mismatch) can catch it. Under
        // the old code escalate_p0 was pause-exempt and would have sent.
        getPauseState: async () => {
          getCalls += 1;
          if (getCalls === 1) return world.control;
          return {
            ...world.control,
            pause_state: 'PAUSED',
            pause_scope: 'effects',
          };
        },
      },
    });
    const state = createTaskmasterState(60_000);

    const result = await tick(state, deps);

    // The escalation reached the ROW-FIRST write but the fresh re-check caught
    // the mid-tick pause: it is withheld (parked), NOT sent.
    expect(world.sentMessages.length).toBe(0);
    expect(world.journal.some(j => j.thread_ref === p0.ref && j.outcome === 'sent')).toBe(false);

    // A mid-tick pause is a pause-park, not a stale-epoch/resume expiry: the row
    // is re-tagged 'parked' (NOT 'expired') so it is indistinguishable from a
    // site-1 pause-park.
    const p0Row = world.journal.find(
      j => j.thread_ref === p0.ref && j.action_type === 'escalate_p0'
    );
    expect(p0Row?.outcome).toBe('parked');
    expect(world.journal.some(j => j.thread_ref === p0.ref && j.outcome === 'expired')).toBe(false);

    // Its proposal_json carries reason='paused' -- the design-required parked
    // provenance, matching what site 1 writes.
    const parsed = JSON.parse(p0Row?.proposal_json ?? '{}') as {
      parked?: boolean;
      reason?: string;
    };
    expect(parsed.parked).toBe(true);
    expect(parsed.reason).toBe('paused');

    // The withheld effect is counted in result.parked (the exact withheld total
    // that the tick_paused_withheld log reports) and NOT in result.expired.
    expect(result.parked).toBe(1);
    expect(result.expired).toBe(0);
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
    world.sentMessages.push({
      idempotency_key: key,
      recipient: 'xo',
      body: 'ruling',
      createdAt: new Date(T0 - 30_000).toISOString(),
    });
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

  test('legacy null-principal taskmaster effect cannot reconcile a pending journal', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    const key = 'tm:nudge:gh:thinmansoftware/bdc-xo#129:1';
    world.journal.push({
      id: 'journal-legacy-taskmaster-effect',
      created_at: new Date(T0 - 60_000).toISOString(),
      thread_ref: 'gh:thinmansoftware/bdc-xo#129',
      action_type: 'nudge',
      proposal_json: '{}',
      idempotency_key: key,
      before_hash: null,
      proof_predicate: null,
      proof_deadline_at: null,
      outcome: 'pending',
      graded_at: null,
      grade: null,
    });
    const queries: string[] = [];
    const findLegacyEffect = (effectKey: string) =>
      defaultFindEffectByIdempotencyKey(effectKey, async (sql, params) => {
        queries.push(sql);
        if (params[0] !== key) return { rows: [] };
        return sql.includes('sender_principal_id IS NULL')
          ? {
              rows: [
                {
                  id: 'legacy-taskmaster-dispatch',
                  status: 'queued',
                  created_at: new Date(T0 - 30_000).toISOString(),
                },
              ],
            }
          : { rows: [] };
      });
    const state = createTaskmasterState(60_000);

    await tick(
      state,
      makeDeps(world, {
        findEffectByIdempotencyKey: findLegacyEffect,
        getDispatchMessageById: async () => null,
        getGithubIssueEvidence: async () => null,
        listThreads: async () => [],
      })
    );

    expect(world.journal.find(row => row.id === 'journal-legacy-taskmaster-effect')?.outcome).toBe(
      'expired'
    );
    expect(queries[0]).toContain("sender_principal_id = 'system:taskmaster'");
    expect(queries[0]).not.toContain('sender_principal_id IS NULL');
  });
});

describe('failed effect reuse and successful-tick health', () => {
  test('a failed effect retries on the same journal row and recovers on the next tick', async () => {
    const world = makeWorld();
    let attempts = 0;
    const deps = makeDeps(world, {
      createTask: (async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('synthetic dispatch failure');
        return { id: 'digest-message', status: 'queued' };
      }) as unknown as TaskmasterDeps['createTask'],
    });
    const state = createTaskmasterState(60_000);

    const failed = await tick(state, deps);
    expect(failed.successful).toBe(false);
    expect(failed.failed).toBe(1);
    expect(world.journal.filter(row => row.action_type === 'digest')).toHaveLength(1);
    expect(world.journal[0]?.outcome).toBe('failed');
    expect(state.deadman.lastTickAtMs).toBeNull();

    world.nowMs += 60_000;
    const recovered = await tick(state, deps);
    expect(recovered.successful).toBe(true);
    expect(attempts).toBe(2);
    expect(world.journal.filter(row => row.action_type === 'digest')).toHaveLength(1);
    expect(world.journal[0]?.outcome).toBe('sent');
    expect(state.deadman.lastTickAtMs).toBe(world.nowMs);
  });

  test('an expired failed effect is not retried or inserted again', async () => {
    const world = makeWorld();
    world.journal.push({
      id: 'expired-digest-attempt',
      created_at: new Date(T0 - 60_000).toISOString(),
      thread_ref: `digest:${TODAY_KEY}`,
      action_type: 'digest',
      proposal_json: '{}',
      idempotency_key: `tm:digest:${TODAY_KEY}`,
      before_hash: null,
      proof_predicate: 'digest delivery only',
      proof_deadline_at: new Date(T0 - 1).toISOString(),
      outcome: 'failed',
      graded_at: null,
      grade: null,
    });
    const deps = makeDeps(world);
    const state = createTaskmasterState(60_000);

    const result = await tick(state, deps);

    expect(result.successful).toBe(true);
    expect(world.sentMessages).toHaveLength(0);
    expect(world.journal).toHaveLength(1);
    expect(world.journal[0]?.outcome).toBe('expired');
  });

  test('repeated failures attempt once per tick and keep one failed row', async () => {
    const world = makeWorld();
    let attempts = 0;
    const deps = makeDeps(world, {
      createTask: (async () => {
        attempts += 1;
        throw new Error('persistent dispatch failure');
      }) as unknown as TaskmasterDeps['createTask'],
    });
    const state = createTaskmasterState(60_000);

    for (let tickNumber = 0; tickNumber < 3; tickNumber += 1) {
      const result = await tick(state, deps);
      expect(result.successful).toBe(false);
      world.nowMs += 60_000;
    }

    expect(attempts).toBe(3);
    expect(world.journal.filter(row => row.action_type === 'digest')).toHaveLength(1);
    expect(world.journal[0]?.outcome).toBe('failed');
  });

  test('a deferred row is reused when the next tick has budget', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    const staleThread = makeListedThread({
      ref: 'gh:thinmansoftware/bdc-xo#1500',
      priority: 'P1',
      lastActivityAt: new Date(T0 - 5 * 3_600_000).toISOString(),
      recipient: 'xo',
      title: 'Deferred stale item',
    });
    world.journal.push({
      id: 'deferred-nudge',
      created_at: new Date(T0 - 60_000).toISOString(),
      thread_ref: staleThread.ref,
      action_type: 'nudge',
      proposal_json: '{}',
      idempotency_key: `tm:nudge:${staleThread.ref}:${Math.floor(T0 / NUDGE_CLOCK_MS.P1)}`,
      before_hash: null,
      proof_predicate: 'source issue progress after send',
      proof_deadline_at: new Date(T0 + 60_000).toISOString(),
      outcome: 'deferred',
      graded_at: null,
      grade: null,
    });

    const result = await tick(
      createTaskmasterState(60_000),
      makeDeps(world, {
        listThreads: async () => [staleThread],
        getGithubIssueEvidence: async () =>
          makeEvidence({
            ownerLogin: 'major-build',
            latestMarkerKind: 'PROGRESS',
            latestMarkerText: 'waiting on review feedback',
            latestMarkerAt: new Date(T0 - 3 * 3_600_000).toISOString(),
            lastMovementAt: new Date(T0 - 3 * 3_600_000).toISOString(),
            lastMovementKind: 'progress_comment',
          }),
      })
    );

    expect(result.effects).toBe(1);
    expect(world.journal.filter(row => row.id === 'deferred-nudge')).toHaveLength(1);
    expect(world.journal.find(row => row.id === 'deferred-nudge')?.outcome).toBe('sent');
  });

  test('an expired deferred row is terminal and is not sent', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    const staleThread = makeListedThread({
      ref: 'gh:thinmansoftware/bdc-xo#1501',
      priority: 'P1',
      lastActivityAt: new Date(T0 - 5 * 3_600_000).toISOString(),
      recipient: 'xo',
      title: 'Expired deferred item',
    });
    world.journal.push({
      id: 'expired-deferred-nudge',
      created_at: new Date(T0 - 60_000).toISOString(),
      thread_ref: staleThread.ref,
      action_type: 'nudge',
      proposal_json: '{}',
      idempotency_key: `tm:nudge:${staleThread.ref}:${Math.floor(T0 / NUDGE_CLOCK_MS.P1)}`,
      before_hash: null,
      proof_predicate: 'source issue progress after send',
      proof_deadline_at: new Date(T0 - 1).toISOString(),
      outcome: 'deferred',
      graded_at: null,
      grade: null,
    });

    const result = await tick(
      createTaskmasterState(60_000),
      makeDeps(world, {
        listThreads: async () => [staleThread],
        getGithubIssueEvidence: async () =>
          makeEvidence({
            ownerLogin: 'major-build',
            latestMarkerKind: 'PROGRESS',
            latestMarkerText: 'waiting on review feedback',
            latestMarkerAt: new Date(T0 - 3 * 3_600_000).toISOString(),
            lastMovementAt: new Date(T0 - 3 * 3_600_000).toISOString(),
            lastMovementKind: 'progress_comment',
          }),
      })
    );

    expect(result.effects).toBe(0);
    expect(world.sentMessages).toHaveLength(0);
    expect(world.journal).toHaveLength(2);
    expect(world.journal.find(row => row.id === 'expired-deferred-nudge')?.outcome).toBe('expired');
  });

  test('a successful no-op tick records the successful heartbeat', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    const state = createTaskmasterState(60_000);

    const result = await tick(state, makeDeps(world));

    expect(result.successful).toBe(true);
    expect(result.failed).toBe(0);
    expect(state.deadman.lastTickAtMs).toBe(T0);
  });

  test.each(['rejected', 'empty'])(
    'adoption snapshot after %s work-SOR read retains the correct custody',
    async mode => {
      const world = makeWorld();
      seedDigestSent(world);
      const deps = makeDeps(world, {
        listThreads: async () => {
          if (mode === 'rejected') throw new Error('synthetic rejected work-SOR read');
          return [];
        },
        getGithubIssueEvidence: async () => makeEvidence(),
      });
      await refreshAdoption(
        [makeListedThread({ ref: 'gh:thinmansoftware/bdc-xo#123', title: 'known work' })],
        deps
      );
      const beforeMeta = structuredClone(world.adoptionMeta);
      const beforeRows = structuredClone(world.adoptionRows);
      const state = createTaskmasterState(60_000);
      const result = await tick(state, deps);
      if (mode === 'rejected') {
        expect(world.adoptionMeta).toEqual(beforeMeta);
        expect(world.adoptionRows).toEqual(beforeRows);
        expect(result.successful).toBe(false);
        expect(state.deadman.lastTickAtMs).toBeNull();
      } else {
        expect(world.adoptionMeta.row_count).toBe(0);
        expect(world.adoptionRows).toEqual([]);
        expect(result.successful).toBe(true);
      }
    }
  );

  test('a failed source read does not advance the successful heartbeat', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    const state = createTaskmasterState(60_000);

    const result = await tick(
      state,
      makeDeps(world, {
        listThreads: async () => {
          throw new Error('synthetic GitHub read failure');
        },
      })
    );

    expect(result.successful).toBe(false);
    expect(result.failed).toBe(1);
    expect(state.deadman.lastTickAtMs).toBeNull();
  });
});

describe('SC7 grading requires external source progress', () => {
  test('a pre-cutover acknowledgement is graded unheard through tick', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    const key = 'tm:nudge:gh:thinmansoftware/bdc-xo#1448:1';
    world.journal.push({
      id: 'pre-cutover-ack',
      created_at: new Date(T0 - 60_000).toISOString(),
      thread_ref: 'gh:thinmansoftware/bdc-xo#1448',
      action_type: 'nudge',
      proposal_json: '{}',
      idempotency_key: key,
      before_hash: null,
      proof_predicate: 'source issue progress after send',
      proof_deadline_at: new Date(T0 + 60_000).toISOString(),
      outcome: 'sent',
      graded_at: null,
      grade: null,
    });
    world.sentMessages.push({
      idempotency_key: key,
      recipient: 'major-build',
      body: 'reminder',
      createdAt: new Date(T0 - 45_000).toISOString(),
      acknowledged_at: new Date(T0 - 40_000).toISOString(),
    });
    await tick(
      createTaskmasterState(60_000),
      makeDeps(world, {
        getDispatchReceiptCutoverAt: async () => new Date(T0 - 20_000).toISOString(),
      })
    );
    expect(world.journal.find(row => row.id === 'pre-cutover-ack')?.grade).toBe('unheard');
  });

  test('a pre-cutover addressed_at does not make a ruling delivery useful through tick', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    const key = 'tm:deliver_ruling:ruling-pre-cutover-address';
    world.journal.push({
      id: 'pre-cutover-address',
      created_at: new Date(T0 - 60_000).toISOString(),
      thread_ref: 'dispatch:ruling-pre-cutover-address',
      action_type: 'deliver_ruling',
      proposal_json: '{}',
      idempotency_key: key,
      before_hash: null,
      proof_predicate: 'original ruling addressed after send',
      proof_deadline_at: new Date(T0 + 60_000).toISOString(),
      outcome: 'sent',
      graded_at: null,
      grade: null,
    });
    world.sentMessages.push({
      idempotency_key: key,
      recipient: 'major-build',
      body: 'ruling reminder',
      createdAt: new Date(T0 - 45_000).toISOString(),
      acknowledged_at: new Date(T0 - 10_000).toISOString(),
    });
    const deps = makeDeps(world, {
      getDispatchReceiptCutoverAt: async () => new Date(T0 - 20_000).toISOString(),
      getDispatchMessageById: (async (id: string) =>
        id === key
          ? {
              id,
              recipient: 'major-build',
              resolved_recipient: 'major-build',
              acknowledged_at: new Date(T0 - 10_000).toISOString(),
              addressed_at: null,
              addressed_by: null,
            }
          : {
              id,
              recipient: 'major-build',
              resolved_recipient: 'major-build',
              acknowledged_at: new Date(T0 - 30_000).toISOString(),
              addressed_at: new Date(T0 - 25_000).toISOString(),
              addressed_by: 'major-build',
            }) as unknown as TaskmasterDeps['getDispatchMessageById'],
    });
    await tick(createTaskmasterState(60_000), deps);
    expect(world.journal.find(row => row.id === 'pre-cutover-address')?.grade).toBeNull();
  });

  test('a queued outbound reminder row alone remains ungraded', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    world.journal.push({
      id: 'sent-nudge',
      created_at: new Date(T0 - 60_000).toISOString(),
      thread_ref: 'gh:thinmansoftware/bdc-xo#1450',
      action_type: 'nudge',
      proposal_json: '{}',
      idempotency_key: 'tm:nudge:gh:thinmansoftware/bdc-xo#1450:1',
      before_hash: null,
      proof_predicate: 'source issue progress after send',
      proof_deadline_at: new Date(T0 + 60_000).toISOString(),
      outcome: 'sent',
      graded_at: null,
      grade: null,
    });
    world.sentMessages.push({
      idempotency_key: 'tm:nudge:gh:thinmansoftware/bdc-xo#1450:1',
      // Heard channel (major-build is worker_poll, not drain_on_start) with an
      // ack, so this test exercises the "no external progress -> not useful
      // (stays ungraded until deadline)" gate rather than short-circuiting on
      // the M-155 Amendment 03 'unheard' gate.
      recipient: 'major-build',
      body: 'reminder',
      createdAt: new Date(T0 - 45_000).toISOString(),
      acknowledged_at: new Date(T0 - 40_000).toISOString(),
    });
    world.sentMessages.push({
      idempotency_key: `tm:digest:${TODAY_KEY}`,
      recipient: 'operator',
      body: 'digest',
      createdAt: new Date(T0 - 45_000).toISOString(),
    });

    await tick(createTaskmasterState(60_000), makeDeps(world));

    expect(world.journal.find(row => row.id === 'sent-nudge')?.grade).toBeNull();
    expect(world.journal.find(row => row.action_type === 'digest')?.grade).toBeNull();
  });

  test('the original ruling addressed by its recipient makes delivery useful', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    world.journal.push({
      id: 'sent-ruling-reminder',
      created_at: new Date(T0 - 60_000).toISOString(),
      thread_ref: 'dispatch:ruling-original',
      action_type: 'deliver_ruling',
      proposal_json: '{}',
      idempotency_key: 'tm:deliver_ruling:ruling-original',
      before_hash: null,
      proof_predicate: 'original ruling addressed after send',
      proof_deadline_at: new Date(T0 + 60_000).toISOString(),
      outcome: 'sent',
      graded_at: null,
      grade: null,
    });
    world.sentMessages.push({
      idempotency_key: 'tm:deliver_ruling:ruling-original',
      // Heard channel (major-build is worker_poll, not drain_on_start) + ack so
      // the M-155 Amendment 03 heard gate passes and this test exercises the
      // deliver_ruling useful path rather than short-circuiting to 'unheard'.
      recipient: 'major-build',
      body: 'ruling reminder',
      createdAt: new Date(T0 - 45_000).toISOString(),
      acknowledged_at: new Date(T0 - 40_000).toISOString(),
    });
    const deps = makeDeps(world, {
      getDispatchMessageById: (async () => ({
        id: 'ruling-original',
        recipient: 'major-build',
        resolved_recipient: 'major-build',
        acknowledged_at: new Date(T0 - 40_000).toISOString(),
        addressed_at: new Date(T0 - 30_000).toISOString(),
        addressed_by: 'major-build',
      })) as unknown as TaskmasterDeps['getDispatchMessageById'],
    });

    await tick(createTaskmasterState(60_000), deps);

    expect(world.journal.find(row => row.id === 'sent-ruling-reminder')?.grade).toBe('useful');
  });

  test('a post-send source progress marker makes a nudge useful', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    const key = 'tm:nudge:gh:thinmansoftware/bdc-xo#1450:1';
    world.journal.push({
      id: 'progress-nudge',
      created_at: new Date(T0 - 60_000).toISOString(),
      thread_ref: 'gh:thinmansoftware/bdc-xo#1450',
      action_type: 'nudge',
      proposal_json: '{}',
      idempotency_key: key,
      before_hash: null,
      proof_predicate: 'post-send source progress',
      proof_deadline_at: new Date(T0 + 60_000).toISOString(),
      outcome: 'sent',
      graded_at: null,
      grade: null,
    });
    world.sentMessages.push({
      idempotency_key: key,
      // Heard channel + ack so the M-155 Amendment 03 heard gate passes and this
      // test exercises the nudge useful path (post-send progress marker).
      recipient: 'major-build',
      body: 'nudge',
      createdAt: new Date(T0 - 45_000).toISOString(),
      acknowledged_at: new Date(T0 - 40_000).toISOString(),
    });
    const deps = makeDeps(world, {
      getGithubIssueEvidence: async () => ({
        state: 'open',
        updatedAt: new Date(T0 - 30_000).toISOString(),
        labels: ['wo', 'prio:P1', 'status:building'],
        assigneeCount: 0,
        closedAt: null,
        assignedAt: null,
        activeStatusAt: null,
        progressRecordedAt: new Date(T0 - 30_000).toISOString(),
      }),
    });

    await tick(createTaskmasterState(60_000), deps);

    expect(world.journal.find(row => row.id === 'progress-nudge')?.grade).toBe('useful');
  });

  test('source progress after journal creation but before the actual send is not useful', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    const key = 'tm:nudge:gh:thinmansoftware/bdc-xo#1451:1';
    world.journal.push({
      id: 'pre-send-progress-nudge',
      created_at: new Date(T0 - 60_000).toISOString(),
      thread_ref: 'gh:thinmansoftware/bdc-xo#1451',
      action_type: 'nudge',
      proposal_json: '{}',
      idempotency_key: key,
      before_hash: null,
      proof_predicate: 'post-send source progress',
      proof_deadline_at: new Date(T0 + 60_000).toISOString(),
      outcome: 'sent',
      graded_at: null,
      grade: null,
    });
    world.sentMessages.push({
      idempotency_key: key,
      // Heard channel + ack so this test exercises the pre-send-timing gate
      // (progress before the send is not useful) rather than the M-155
      // Amendment 03 'unheard' gate.
      recipient: 'major-build',
      body: 'nudge',
      createdAt: new Date(T0 - 30_000).toISOString(),
      acknowledged_at: new Date(T0 - 25_000).toISOString(),
    });
    const deps = makeDeps(world, {
      getGithubIssueEvidence: async () => ({
        state: 'open',
        updatedAt: new Date(T0 - 45_000).toISOString(),
        labels: ['wo', 'prio:P1'],
        assigneeCount: 0,
        closedAt: null,
        assignedAt: null,
        activeStatusAt: null,
        progressRecordedAt: new Date(T0 - 45_000).toISOString(),
      }),
    });

    await tick(createTaskmasterState(60_000), deps);

    expect(world.journal.find(row => row.id === 'pre-send-progress-nudge')?.grade).toBeNull();
  });

  test('unacknowledged, acknowledged-only, and auto-addressed rulings are not useful', async () => {
    // Routed to a non-draining recipient (major-build, worker_poll) so this
    // test exercises the deliver_ruling addressed-by logic. M-155 Amendment 03:
    // the unacknowledged case is 'unheard' (never acked); the acked-but-not-
    // addressed cases stay ungraded (heard, but no useful proof yet). None are
    // 'useful' -- the invariant this test protects.
    const cases: Array<{
      name: string;
      acknowledged_at: string | null;
      addressed_at: string | null;
      addressed_by: string | null;
      expected: TmGrade | null;
    }> = [
      {
        name: 'unacknowledged',
        acknowledged_at: null,
        addressed_at: null,
        addressed_by: null,
        expected: 'unheard',
      },
      {
        name: 'acknowledged-only',
        acknowledged_at: new Date(T0 - 20_000).toISOString(),
        addressed_at: null,
        addressed_by: null,
        expected: null,
      },
      {
        name: 'auto-addressed',
        acknowledged_at: new Date(T0 - 20_000).toISOString(),
        addressed_at: new Date(T0 - 10_000).toISOString(),
        addressed_by: 'taskmaster:auto',
        expected: null,
      },
    ];

    for (const testCase of cases) {
      const world = makeWorld();
      seedDigestSent(world);
      const rulingId = `ruling-${testCase.name}`;
      const key = `tm:deliver_ruling:${rulingId}`;
      world.journal.push({
        id: `journal-${testCase.name}`,
        created_at: new Date(T0 - 60_000).toISOString(),
        thread_ref: `dispatch:${rulingId}`,
        action_type: 'deliver_ruling',
        proposal_json: '{}',
        idempotency_key: key,
        before_hash: null,
        proof_predicate: 'original ruling addressed after send',
        proof_deadline_at: new Date(T0 + 60_000).toISOString(),
        outcome: 'sent',
        graded_at: null,
        grade: null,
      });
      world.sentMessages.push({
        idempotency_key: key,
        recipient: 'major-build',
        body: 'ruling reminder',
        createdAt: new Date(T0 - 30_000).toISOString(),
      });
      const deps = makeDeps(world, {
        getDispatchMessageById: (async () => ({
          id: rulingId,
          recipient: 'major-build',
          resolved_recipient: 'major-build',
          acknowledged_at: testCase.acknowledged_at,
          addressed_at: testCase.addressed_at,
          addressed_by: testCase.addressed_by,
        })) as unknown as TaskmasterDeps['getDispatchMessageById'],
      });

      await tick(createTaskmasterState(60_000), deps);

      expect(world.journal.find(row => row.id === `journal-${testCase.name}`)?.grade).toBe(
        testCase.expected
      );
    }
  });

  test('a cancelled effect is unheard (never delivered) and an unchanged P0 source is not useful', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    const key = 'tm:escalate_p0:gh:thinmansoftware/bdc-xo#1600:1';
    world.journal.push({
      id: 'cancelled-escalation',
      created_at: new Date(T0 - 60_000).toISOString(),
      thread_ref: 'gh:thinmansoftware/bdc-xo#1600',
      action_type: 'escalate_p0',
      proposal_json: '{}',
      idempotency_key: key,
      before_hash: null,
      proof_predicate: 'P0 source claim after send',
      proof_deadline_at: new Date(T0 + 60_000).toISOString(),
      outcome: 'sent',
      graded_at: null,
      grade: null,
    });
    const deps = makeDeps(world, {
      findEffectByIdempotencyKey: async effectKey =>
        effectKey === key
          ? {
              id: 'cancelled-effect',
              status: 'cancelled',
              createdAt: new Date(T0 - 45_000).toISOString(),
            }
          : null,
      getGithubIssueEvidence: async () => ({
        state: 'open',
        updatedAt: new Date(T0 - 60_000).toISOString(),
        labels: ['wo', 'P0'],
        assigneeCount: 0,
        closedAt: null,
        assignedAt: null,
        activeStatusAt: null,
        progressRecordedAt: null,
      }),
    });

    await tick(createTaskmasterState(60_000), deps);

    // M-155 Amendment 03: a cancelled dispatch was never delivered, so it is
    // 'unheard' (excluded from the floor denominator), not 'noise'.
    expect(world.journal.find(row => row.id === 'cancelled-escalation')?.grade).toBe('unheard');
  });

  test('a post-send assignment event makes a P0 escalation useful', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    const key = 'tm:escalate_p0:gh:thinmansoftware/bdc-xo#1601:1';
    world.journal.push({
      id: 'assigned-escalation',
      created_at: new Date(T0 - 60_000).toISOString(),
      thread_ref: 'gh:thinmansoftware/bdc-xo#1601',
      action_type: 'escalate_p0',
      proposal_json: '{}',
      idempotency_key: key,
      before_hash: null,
      proof_predicate: 'P0 source claim after send',
      proof_deadline_at: new Date(T0 + 60_000).toISOString(),
      outcome: 'sent',
      graded_at: null,
      grade: null,
    });
    world.sentMessages.push({
      idempotency_key: key,
      // Heard channel + ack so the M-155 Amendment 03 heard gate passes and this
      // test exercises the P0 escalation useful path (post-send assignment).
      recipient: 'major-build',
      body: 'escalate',
      createdAt: new Date(T0 - 45_000).toISOString(),
      acknowledged_at: new Date(T0 - 40_000).toISOString(),
    });
    const deps = makeDeps(world, {
      getGithubIssueEvidence: async () => ({
        state: 'open',
        updatedAt: new Date(T0 - 30_000).toISOString(),
        labels: ['wo', 'P0'],
        assigneeCount: 1,
        closedAt: null,
        assignedAt: new Date(T0 - 30_000).toISOString(),
        activeStatusAt: null,
        progressRecordedAt: null,
      }),
    });

    await tick(createTaskmasterState(60_000), deps);

    expect(world.journal.find(row => row.id === 'assigned-escalation')?.grade).toBe('useful');
  });

  test('a pre-existing assignee without a post-send event is not useful proof', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    const key = 'tm:escalate_p0:gh:thinmansoftware/bdc-xo#1602:1';
    world.journal.push({
      id: 'preexisting-assignee-escalation',
      created_at: new Date(T0 - 60_000).toISOString(),
      thread_ref: 'gh:thinmansoftware/bdc-xo#1602',
      action_type: 'escalate_p0',
      proposal_json: '{}',
      idempotency_key: key,
      before_hash: null,
      proof_predicate: 'P0 source claim after send',
      proof_deadline_at: new Date(T0 + 60_000).toISOString(),
      outcome: 'sent',
      graded_at: null,
      grade: null,
    });
    world.sentMessages.push({
      idempotency_key: key,
      // Heard channel + ack so this test exercises the "pre-existing assignee
      // (no post-send event) is not useful proof" gate rather than the M-155
      // Amendment 03 'unheard' gate.
      recipient: 'major-build',
      body: 'escalate',
      createdAt: new Date(T0 - 45_000).toISOString(),
      acknowledged_at: new Date(T0 - 40_000).toISOString(),
    });
    const deps = makeDeps(world, {
      getGithubIssueEvidence: async () => ({
        state: 'open',
        updatedAt: new Date(T0 - 30_000).toISOString(),
        labels: ['wo', 'P0'],
        assigneeCount: 1,
        closedAt: null,
        assignedAt: null,
        activeStatusAt: null,
        progressRecordedAt: null,
      }),
    });

    await tick(createTaskmasterState(60_000), deps);

    expect(
      world.journal.find(row => row.id === 'preexisting-assignee-escalation')?.grade
    ).toBeNull();
  });
});

describe('M-155 Amendment 03: unheard grade (WO-HARNESS-TASKMASTER-UNHEARD-GRADE-01)', () => {
  // Helper: seed a single sent escalate_p0 action + its dispatch row.
  function seedSentEscalation(
    world: FakeWorld,
    opts: {
      id: string;
      recipient: string;
      acknowledged_at?: string | null;
      deadlineMsFromNow?: number;
    }
  ): void {
    const key = `tm:escalate_p0:gh:thinmansoftware/bdc-xo#${opts.id}:1`;
    world.journal.push({
      id: `journal-${opts.id}`,
      created_at: new Date(T0 - 60_000).toISOString(),
      thread_ref: `gh:thinmansoftware/bdc-xo#${opts.id}`,
      action_type: 'escalate_p0',
      proposal_json: '{}',
      idempotency_key: key,
      before_hash: null,
      proof_predicate: 'P0 source claim after send',
      proof_deadline_at: new Date(T0 + (opts.deadlineMsFromNow ?? 60_000)).toISOString(),
      outcome: 'sent',
      graded_at: null,
      grade: null,
    });
    world.sentMessages.push({
      idempotency_key: key,
      recipient: opts.recipient,
      body: 'escalate',
      createdAt: new Date(T0 - 45_000).toISOString(),
      acknowledged_at: opts.acknowledged_at ?? null,
    });
  }

  test('scenario 1: an unread drain_on_start send with no ack is graded unheard', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    // recipient operator == drain_on_start; acknowledged_at null; deadline still
    // in the future -> unheard is assigned immediately, without waiting.
    seedSentEscalation(world, { id: '2200', recipient: 'operator', acknowledged_at: null });

    await tick(createTaskmasterState(60_000), makeDeps(world));

    expect(world.journal.find(row => row.id === 'journal-2200')?.grade).toBe('unheard');
  });

  test('scenario 2: an ack from a draining principal does not count -- still unheard', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    // operator is drain_on_start; even with acknowledged_at set, a drainer ack
    // is not a human acknowledgement -> unheard.
    seedSentEscalation(world, {
      id: '2201',
      recipient: 'operator',
      acknowledged_at: new Date(T0 - 30_000).toISOString(),
    });

    await tick(createTaskmasterState(60_000), makeDeps(world));

    expect(world.journal.find(row => row.id === 'journal-2201')?.grade).toBe('unheard');
  });

  test('scenario 3: an ack from a non-draining principal is heard (useful or noise)', async () => {
    // 3a: heard + post-send movement -> useful.
    const worldUseful = makeWorld();
    seedDigestSent(worldUseful);
    seedSentEscalation(worldUseful, {
      id: '2202',
      recipient: 'major-build', // worker_poll, not drain_on_start
      acknowledged_at: new Date(T0 - 40_000).toISOString(),
    });
    await tick(
      createTaskmasterState(60_000),
      makeDeps(worldUseful, {
        getGithubIssueEvidence: async () => ({
          state: 'open',
          updatedAt: new Date(T0 - 30_000).toISOString(),
          labels: ['wo', 'P0'],
          assigneeCount: 1,
          closedAt: null,
          assignedAt: new Date(T0 - 30_000).toISOString(),
          activeStatusAt: null,
          progressRecordedAt: null,
        }),
      })
    );
    expect(worldUseful.journal.find(row => row.id === 'journal-2202')?.grade).toBe('useful');

    // 3b: heard + no movement + deadline passed -> noise (NOT unheard).
    const worldNoise = makeWorld();
    seedDigestSent(worldNoise);
    seedSentEscalation(worldNoise, {
      id: '2203',
      recipient: 'major-build',
      acknowledged_at: new Date(T0 - 40_000).toISOString(),
      deadlineMsFromNow: -1, // deadline already passed
    });
    await tick(createTaskmasterState(60_000), makeDeps(worldNoise));
    expect(worldNoise.journal.find(row => row.id === 'journal-2203')?.grade).toBe('noise');
  });

  test('scenario 4: the useful-rate floor denominator excludes unheard (no auto-pause)', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    // 62 unheard + 1 useful, all already graded and inside the floor lookback.
    // Only useful/noise count -> denominator = 1 (< USEFUL_RATE_MIN_GRADED),
    // so the floor does not breach and the loop is NOT auto-paused. Were the 62
    // unheard rows counted as noise instead, 1/63 = 1.6% < 40% would breach.
    for (let i = 0; i < 62; i += 1) {
      world.journal.push({
        id: `unheard-${i}`,
        created_at: new Date(T0).toISOString(),
        thread_ref: `gh:thinmansoftware/bdc-xo#${3000 + i}`,
        action_type: 'escalate_p0',
        proposal_json: '{}',
        idempotency_key: `tm:escalate_p0:unheard:${i}`,
        before_hash: null,
        proof_predicate: 'P0 source claim after send',
        proof_deadline_at: null,
        outcome: 'sent',
        graded_at: new Date(T0).toISOString(),
        grade: 'unheard',
      });
    }
    world.journal.push({
      id: 'useful-1',
      created_at: new Date(T0).toISOString(),
      thread_ref: 'gh:thinmansoftware/bdc-xo#3100',
      action_type: 'deliver_ruling',
      proposal_json: '{}',
      idempotency_key: 'tm:deliver_ruling:useful-1',
      before_hash: null,
      proof_predicate: 'original ruling addressed after send',
      proof_deadline_at: null,
      outcome: 'sent',
      graded_at: new Date(T0).toISOString(),
      grade: 'useful',
    });

    await tick(createTaskmasterState(60_000), makeDeps(world));

    expect(world.control.pause_state).toBe('RUNNING');
    expect(world.control.pause_actor).not.toBe('taskmaster:useful-rate-floor');
  });

  test('scenario 5: no regression on the useful/noise split for heard actions', async () => {
    // Heard action (non-draining recipient + ack) with GitHub movement -> useful.
    const worldUseful = makeWorld();
    seedDigestSent(worldUseful);
    const usefulKey = 'tm:nudge:gh:thinmansoftware/bdc-xo#2300:1';
    worldUseful.journal.push({
      id: 'heard-useful-nudge',
      created_at: new Date(T0 - 60_000).toISOString(),
      thread_ref: 'gh:thinmansoftware/bdc-xo#2300',
      action_type: 'nudge',
      proposal_json: '{}',
      idempotency_key: usefulKey,
      before_hash: null,
      proof_predicate: 'post-send source progress',
      proof_deadline_at: new Date(T0 + 60_000).toISOString(),
      outcome: 'sent',
      graded_at: null,
      grade: null,
    });
    worldUseful.sentMessages.push({
      idempotency_key: usefulKey,
      recipient: 'major-build',
      body: 'nudge',
      createdAt: new Date(T0 - 45_000).toISOString(),
      acknowledged_at: new Date(T0 - 40_000).toISOString(),
    });
    await tick(
      createTaskmasterState(60_000),
      makeDeps(worldUseful, {
        getGithubIssueEvidence: async () => ({
          state: 'open',
          updatedAt: new Date(T0 - 30_000).toISOString(),
          labels: ['wo', 'prio:P1', 'status:building'],
          assigneeCount: 0,
          closedAt: null,
          assignedAt: null,
          activeStatusAt: null,
          progressRecordedAt: new Date(T0 - 30_000).toISOString(),
        }),
      })
    );
    expect(worldUseful.journal.find(row => row.id === 'heard-useful-nudge')?.grade).toBe('useful');

    // Heard action with no movement and deadline passed -> noise.
    const worldNoise = makeWorld();
    seedDigestSent(worldNoise);
    const noiseKey = 'tm:nudge:gh:thinmansoftware/bdc-xo#2301:1';
    worldNoise.journal.push({
      id: 'heard-noise-nudge',
      created_at: new Date(T0 - 60_000).toISOString(),
      thread_ref: 'gh:thinmansoftware/bdc-xo#2301',
      action_type: 'nudge',
      proposal_json: '{}',
      idempotency_key: noiseKey,
      before_hash: null,
      proof_predicate: 'post-send source progress',
      proof_deadline_at: new Date(T0 - 1).toISOString(),
      outcome: 'sent',
      graded_at: null,
      grade: null,
    });
    worldNoise.sentMessages.push({
      idempotency_key: noiseKey,
      recipient: 'major-build',
      body: 'nudge',
      createdAt: new Date(T0 - 45_000).toISOString(),
      acknowledged_at: new Date(T0 - 40_000).toISOString(),
    });
    await tick(createTaskmasterState(60_000), makeDeps(worldNoise));
    expect(worldNoise.journal.find(row => row.id === 'heard-noise-nudge')?.grade).toBe('noise');
  });

  test('scenario 6: downstream movement on an unheard send is unheard, NOT useful', async () => {
    // The heard gate precedes the useful/noise split (M-155 Amendment 03,
    // spec section 3.2). recipient=operator (drain_on_start) with no ack means
    // the send was never heard, so even a post-send GitHub assignment (which
    // would otherwise grade 'useful') cannot be attributed to it. Prior to the
    // fix this row graded 'useful' and falsely inflated the floor numerator.
    const world = makeWorld();
    seedDigestSent(world);
    seedSentEscalation(world, { id: '2204', recipient: 'operator', acknowledged_at: null });
    await tick(
      createTaskmasterState(60_000),
      makeDeps(world, {
        getGithubIssueEvidence: async () => ({
          state: 'open',
          updatedAt: new Date(T0 - 30_000).toISOString(),
          labels: ['wo', 'P0'],
          assigneeCount: 1,
          closedAt: null,
          assignedAt: new Date(T0 - 30_000).toISOString(),
          activeStatusAt: null,
          progressRecordedAt: null,
        }),
      })
    );
    expect(world.journal.find(row => row.id === 'journal-2204')?.grade).toBe('unheard');
  });

  test('scenario 7: a cancelled dispatch is graded unheard, NOT noise', async () => {
    // A cancelled dispatch was never delivered, so no principal could have heard
    // it. Deadline is already past, so the pre-fix path forced 'noise' (into the
    // floor denominator); the fix grades 'unheard' (excluded).
    const world = makeWorld();
    seedDigestSent(world);
    const key = 'tm:escalate_p0:gh:thinmansoftware/bdc-xo#2205:1';
    world.journal.push({
      id: 'journal-2205',
      created_at: new Date(T0 - 60_000).toISOString(),
      thread_ref: 'gh:thinmansoftware/bdc-xo#2205',
      action_type: 'escalate_p0',
      proposal_json: '{}',
      idempotency_key: key,
      before_hash: null,
      proof_predicate: 'P0 source claim after send',
      proof_deadline_at: new Date(T0 - 1).toISOString(),
      outcome: 'sent',
      graded_at: null,
      grade: null,
    });
    await tick(
      createTaskmasterState(60_000),
      makeDeps(world, {
        findEffectByIdempotencyKey: async () => ({
          id: key,
          status: 'cancelled',
          createdAt: new Date(T0 - 45_000).toISOString(),
        }),
      })
    );
    expect(world.journal.find(row => row.id === 'journal-2205')?.grade).toBe('unheard');
  });

  test('scenario 7b: a cancelled dispatch ACKED by a non-draining principal stays eligible for useful/noise', async () => {
    // Cancellation is not itself proof of deafness. This row was acknowledged
    // by 'major-build' (worker_poll => NOT drain_on_start) before it was
    // cancelled, so a human provably read it. It must therefore receive the
    // same heard classification as any other dispatch and fall through to the
    // normal useful/noise evaluation -- here: heard, deadline passed, no
    // downstream movement => 'noise' (in the floor denominator). Grading it
    // 'unheard' would wrongly excuse a genuinely-heard send from the floor.
    const world = makeWorld();
    seedDigestSent(world);
    const key = 'tm:escalate_p0:gh:thinmansoftware/bdc-xo#2206:1';
    seedSentEscalation(world, {
      id: '2206',
      recipient: 'major-build',
      acknowledged_at: new Date(T0 - 40_000).toISOString(),
      deadlineMsFromNow: -1, // deadline already passed
    });

    await tick(
      createTaskmasterState(60_000),
      makeDeps(world, {
        // Mirror the default effect lookup, but report THIS row as cancelled so
        // the cancelled branch is the path under test. Other rows (the digest
        // seed) keep their normal status.
        findEffectByIdempotencyKey: async (k: string) => {
          const found = world.sentMessages.find(m => m.idempotency_key === k);
          if (!found) return null;
          return {
            id: found.idempotency_key,
            status: k === key ? 'cancelled' : 'queued',
            createdAt: found.createdAt,
          };
        },
      })
    );

    expect(world.journal.find(row => row.id === 'journal-2206')?.grade).toBe('noise');
  });
});

describe('scenario 5: budget ceiling holds', () => {
  test('25 eligible stale threads: at most 10 effects, 1 per item, remainder journaled deferred', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    const threads = Array.from({ length: 25 }, (_, i) =>
      makeListedThread({
        ref: `gh:thinmansoftware/bdc-harness#${100 + i}`,
        priority: 'P1',
        lastActivityAt: new Date(T0 - 6 * 3_600_000).toISOString(),
        recipient: 'xo',
        title: `Stale item ${100 + i}`,
      })
    );
    const deps = makeDeps(world, {
      listThreads: async () => threads,
      // Content-complete adoption for every thread so all 25 nudges compose;
      // this test is about the EFFECT budget (10/tick), so the adoption
      // evidence budget is raised to cover the full set in one tick.
      getGithubIssueEvidence: async () =>
        makeEvidence({
          ownerLogin: 'major-build',
          latestMarkerKind: 'PROGRESS',
          latestMarkerText: 'waiting on review feedback',
          latestMarkerAt: new Date(T0 - 3 * 3_600_000).toISOString(),
          lastMovementAt: new Date(T0 - 3 * 3_600_000).toISOString(),
          lastMovementKind: 'progress_comment',
        }),
    });
    const state = createTaskmasterState(60_000);

    const priorBudget = process.env.TASKMASTER_ADOPTION_EVIDENCE_BUDGET;
    process.env.TASKMASTER_ADOPTION_EVIDENCE_BUDGET = '25';
    let result;
    try {
      await tick(state, deps); // observation tick
      world.nowMs += 60_000;
      result = await tick(state, deps); // confirming tick
    } finally {
      if (priorBudget === undefined) delete process.env.TASKMASTER_ADOPTION_EVIDENCE_BUDGET;
      else process.env.TASKMASTER_ADOPTION_EVIDENCE_BUDGET = priorBudget;
    }

    expect(result.effects).toBe(10);
    expect(world.sentMessages.length).toBe(10);
    expect(world.sentMessages.every(message => message.body.includes('[PROGRESS]'))).toBe(true);
    expect(world.sentMessages.every(message => message.body.includes('[BLOCKED]'))).toBe(true);

    // No item receives 2 effects in the tick.
    const perThread = new Map<string, number>();
    for (const row of world.journal.filter(j => j.outcome === 'sent')) {
      perThread.set(row.thread_ref, (perThread.get(row.thread_ref) ?? 0) + 1);
    }
    for (const count of perThread.values()) expect(count).toBe(1);

    // Remainder journaled as deferred, not dropped.
    const deferred = world.journal.filter(j => j.outcome === 'deferred');
    expect(deferred.length).toBe(15);
    expect(deferred.every(row => row.proof_predicate !== null)).toBe(true);
    expect(deferred.every(row => row.proof_deadline_at !== null)).toBe(true);
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

describe('defaultListThreads -- GitHub work-SOR read', () => {
  // This group tests the real HTTP adapter over synthetic responses, not the
  // shared quota database. Isolate persistence before its default DB argument
  // can be evaluated; keep in-memory metering and response policy unchanged.
  let restorePersistence = (): void => {};
  beforeEach(() => {
    const quota = spyOn(githubMeter, 'assertPersistedGitHubPoolAvailable').mockImplementation(
      async (poolId, resources) => {
        for (const resource of resources) githubMeter.assertGitHubPoolAvailable(poolId, resource);
      }
    );
    const flush = spyOn(githubMeter, 'flushGitHubApiMeter').mockImplementation(async () => {});
    restorePersistence = () => {
      resetGitHubApiMeterForTests();
      flush.mockRestore();
      quota.mockRestore();
    };
  });
  afterEach(() => restorePersistence());
  // Pin the repo list so an operator env var cannot skew the assertions.
  const priorRepos = process.env.TASKMASTER_GH_REPOS;
  process.env.TASKMASTER_GH_REPOS = 'thinmansoftware/bdc-harness';
  afterAll(() => {
    if (priorRepos === undefined) delete process.env.TASKMASTER_GH_REPOS;
    else process.env.TASKMASTER_GH_REPOS = priorRepos;
  });

  function ghIssue(
    number: number,
    labels: string[],
    overrides: Record<string, unknown> = {}
  ): Record<string, unknown> {
    return {
      number,
      updated_at: new Date(T0).toISOString(),
      labels: labels.map(name => ({ name })),
      assignees: [],
      ...overrides,
    };
  }

  function fakeGithubFetch(byLabel: Record<string, Record<string, unknown>[]>): {
    urls: string[];
    fetchImpl: typeof fetch;
  } {
    const urls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      const label = new URL(url).searchParams.get('labels') ?? '';
      return new Response(JSON.stringify(byLabel[label] ?? []), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-ratelimit-remaining': '100',
        },
      });
    }) as typeof fetch;
    return { urls, fetchImpl };
  }

  test('paginates_all_pages', async () => {
    const urls: string[] = [];
    const pageIssues = (start: number, count: number) =>
      Array.from({ length: count }, (_, index) => ghIssue(start + index, ['wo', 'prio:P1']));
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      const parsed = new URL(url);
      const label = parsed.searchParams.get('labels');
      const page = Number(parsed.searchParams.get('page'));
      let issues: Record<string, unknown>[] = [];
      if (label === 'wo' && page === 1) issues = pageIssues(1, 100);
      if (label === 'wo' && page === 2) issues = pageIssues(101, 100);
      if (label === 'wo' && page === 3) issues = pageIssues(201, 30);
      return new Response(JSON.stringify(issues), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '100' },
      });
    }) as typeof fetch;

    const threads = await defaultListThreads(fetchImpl);
    expect(threads).toHaveLength(230);
    const woPages = urls
      .filter(url => new URL(url).searchParams.get('labels') === 'wo')
      .map(url => Number(new URL(url).searchParams.get('page')));
    expect(woPages).toEqual([1, 2, 3]);
    expect(urls.some(url => new URL(url).searchParams.get('labels') === 'project')).toBe(true);
    expect(urls.some(url => new URL(url).searchParams.get('labels') === 'arc')).toBe(true);
    expect(threads.slice(0, 100).every(thread => thread.beyondFirstPage === false)).toBe(true);
    expect(threads.slice(100).every(thread => thread.beyondFirstPage === true)).toBe(true);
  });

  test('caps_pages_per_label', async () => {
    const urls: string[] = [];
    const streamSymbol = Object.getOwnPropertySymbols(rootLogger).find(
      symbol => symbol.description === 'pino.stream'
    );
    if (streamSymbol === undefined) throw new Error('pino.stream symbol missing on rootLogger');
    const stream = (rootLogger as unknown as Record<symbol, { write: (chunk: string) => boolean }>)[
      streamSymbol
    ];
    const chunks: string[] = [];
    const originalWrite = stream.write;
    stream.write = (chunk: string) => {
      chunks.push(String(chunk));
      return true;
    };
    try {
      const fetchImpl = (async (input: string | URL | Request) => {
        const url = String(input);
        urls.push(url);
        const parsed = new URL(url);
        const label = parsed.searchParams.get('labels');
        const page = Number(parsed.searchParams.get('page'));
        const issues =
          label === 'wo'
            ? Array.from({ length: 100 }, (_, index) =>
                ghIssue((page - 1) * 100 + index + 1, ['wo', 'prio:P1'])
              )
            : [];
        return new Response(JSON.stringify(issues), {
          status: 200,
          headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '100' },
        });
      }) as typeof fetch;

      const threads = await defaultListThreads(fetchImpl);
      const woPages = urls
        .filter(url => new URL(url).searchParams.get('labels') === 'wo')
        .map(url => Number(new URL(url).searchParams.get('page')));
      expect(woPages).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(threads).toHaveLength(1000);
      expect(
        chunks.filter(chunk => chunk.includes('taskmaster.github_page_limit_reached'))
      ).toHaveLength(1);
    } finally {
      stream.write = originalWrite;
    }
  });

  test('queries wo, project, and arc separately while preserving an explicit repo override', async () => {
    const { urls, fetchImpl } = fakeGithubFetch({
      wo: [ghIssue(1, ['wo', 'P1']), ghIssue(3, ['wo', 'arc', 'P0'])],
      arc: [ghIssue(2, ['arc', 'P2']), ghIssue(3, ['wo', 'arc', 'P0'])],
      project: [ghIssue(5, ['project', 'prio:P1'])],
    });

    const threads = await defaultListThreads(fetchImpl);

    // One request per work label -- never a single labels=wo,arc request,
    // which GitHub treats as AND (both labels required).
    const labelParams = urls.map(u => new URL(u).searchParams.get('labels'));
    expect(labelParams).toContain('wo');
    expect(labelParams).toContain('arc');
    expect(labelParams).toContain('project');
    expect(labelParams.every(l => l === 'wo' || l === 'project' || l === 'arc')).toBe(true);

    // arc-only work IS observed; both-label work appears exactly once.
    const refs = threads.map(t => t.ref).sort();
    expect(refs).toEqual([
      'gh:thinmansoftware/bdc-harness#1',
      'gh:thinmansoftware/bdc-harness#2',
      'gh:thinmansoftware/bdc-harness#3',
      'gh:thinmansoftware/bdc-harness#5',
    ]);
    const p0 = threads.find(t => t.ref.endsWith('#3'));
    expect(p0?.priority).toBe('P0');
    expect(p0?.isUnclaimed).toBe(true);
    expect(p0?.isUnclaimedP0).toBe(true);
  });

  test('normalizes exact priority label families and status-prefixed blocked labels', async () => {
    const { fetchImpl } = fakeGithubFetch({
      wo: [
        ghIssue(10, ['wo', 'P1']),
        ghIssue(11, ['wo', 'prio:P1']),
        ghIssue(12, ['wo', 'priority:p1']),
        ghIssue(13, ['wo', 'not-p0', 'P3', 'prio:P0']),
        ghIssue(14, ['wo', 'priority-ish:p1']),
        ghIssue(15, ['wo', 'P0', 'status:blocked']),
        ghIssue(16, ['wo', 'P0', 'status:review']),
        ghIssue(17, ['wo', 'P2', 'status:hold']),
        ghIssue(18, ['wo', 'P3', 'status:building']),
      ],
    });

    const threads = await defaultListThreads(fetchImpl);
    const byNumber = new Map(threads.map(thread => [Number(thread.ref.split('#')[1]), thread]));
    expect([10, 11, 12].map(number => byNumber.get(number)?.priority)).toEqual(['P1', 'P1', 'P1']);
    expect(byNumber.get(13)?.priority).toBe('P0');
    expect(byNumber.has(14)).toBe(false);
    expect(byNumber.get(15)?.isBlocked).toBe(true);
    expect(byNumber.get(16)?.isUnclaimedP0).toBe(false);
    expect(byNumber.get(17)?.isBlocked).toBe(false);
    expect(byNumber.get(17)?.isHeld).toBe(true);
    expect(byNumber.get(18)?.isUnclaimed).toBe(false);
  });

  test('unlabelled_priority_surfaces_for_triage', async () => {
    const { fetchImpl } = fakeGithubFetch({ wo: [ghIssue(44, ['wo'])] });
    const threads = await defaultListThreads(fetchImpl);
    expect(threads).toHaveLength(0);
    expect(threads.unlabelledPriorityTriage).toEqual(['gh:thinmansoftware/bdc-harness#44']);
    expect(priorityFromLabels(['wo'])).toBeNull();
  });

  test('project_issue_without_prio_defaults_to_p1', async () => {
    const { fetchImpl } = fakeGithubFetch({ project: [ghIssue(9001, ['project'])] });
    const threads = await defaultListThreads(fetchImpl);
    expect(threads.find(thread => thread.ref.endsWith('#9001'))?.priority).toBe('P1');
    expect(threads.unlabelledPriorityTriage).not.toContain('gh:thinmansoftware/bdc-harness#9001');
  });

  test('wo_issue_without_prio_still_goes_to_triage', async () => {
    const { fetchImpl } = fakeGithubFetch({ wo: [ghIssue(9002, ['wo'])] });
    const threads = await defaultListThreads(fetchImpl);
    expect(threads.some(thread => thread.ref.endsWith('#9002'))).toBe(false);
    expect(threads.unlabelledPriorityTriage).toContain('gh:thinmansoftware/bdc-harness#9002');
  });

  test('project_issue_with_explicit_prio_keeps_it', async () => {
    const { fetchImpl } = fakeGithubFetch({
      project: [ghIssue(9003, ['project', 'prio:P2'])],
    });
    const threads = await defaultListThreads(fetchImpl);
    expect(threads.find(thread => thread.ref.endsWith('#9003'))?.priority).toBe('P2');
  });

  test('project_label_match_is_exact_and_case_insensitive', async () => {
    const { fetchImpl } = fakeGithubFetch({
      project: [ghIssue(9004, ['Project']), ghIssue(9005, ['project-x'])],
    });
    const threads = await defaultListThreads(fetchImpl);
    expect(threads.find(thread => thread.ref.endsWith('#9004'))?.priority).toBe('P1');
    expect(threads.some(thread => thread.ref.endsWith('#9005'))).toBe(false);
    expect(threads.unlabelledPriorityTriage).toContain('gh:thinmansoftware/bdc-harness#9005');
  });

  test('defaults to bdc-xo when TASKMASTER_GH_REPOS is unset', async () => {
    delete process.env.TASKMASTER_GH_REPOS;
    try {
      const { urls, fetchImpl } = fakeGithubFetch({});
      await defaultListThreads(fetchImpl);
      expect(urls.length).toBeGreaterThan(0);
      expect(urls.every(url => url.includes('/repos/thinmansoftware/bdc-xo/issues'))).toBe(true);
    } finally {
      process.env.TASKMASTER_GH_REPOS = 'thinmansoftware/bdc-harness';
    }
  });

  test('pull requests are skipped', async () => {
    const { fetchImpl } = fakeGithubFetch({
      wo: [ghIssue(4, ['wo'], { pull_request: { url: 'x' } })],
      // 'arc' key absent -> empty list
    });
    const threads = await defaultListThreads(fetchImpl);
    expect(threads.length).toBe(0);
  });

  test('a non-OK work-SOR response makes the production adapter fail closed', async () => {
    const fetchImpl = (async () => new Response('unavailable', { status: 503 })) as typeof fetch;
    await expect(defaultListThreads(fetchImpl)).rejects.toThrow(
      'taskmaster_github_work_sor_read_failed:503'
    );
  });

  test('a thrown work-SOR fetch makes the tick unsuccessful', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    const fetchImpl = (async () => {
      throw new Error('synthetic network failure');
    }) as typeof fetch;
    const state = createTaskmasterState(60_000);

    const result = await tick(
      state,
      makeDeps(world, { listThreads: () => defaultListThreads(fetchImpl) })
    );

    expect(result.successful).toBe(false);
    expect(state.deadman.lastTickAtMs).toBeNull();
  });

  test('a non-OK evidence response makes the tick unsuccessful', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    const key = 'tm:nudge:gh:thinmansoftware/bdc-xo#1452:1';
    world.journal.push({
      id: 'evidence-read-failure',
      created_at: new Date(T0 - 60_000).toISOString(),
      thread_ref: 'gh:thinmansoftware/bdc-xo#1452',
      action_type: 'nudge',
      proposal_json: '{}',
      idempotency_key: key,
      before_hash: null,
      proof_predicate: 'post-send source progress',
      proof_deadline_at: new Date(T0 + 60_000).toISOString(),
      outcome: 'sent',
      graded_at: null,
      grade: null,
    });
    world.sentMessages.push({
      idempotency_key: key,
      recipient: 'xo',
      body: 'nudge',
      createdAt: new Date(T0 - 30_000).toISOString(),
    });
    const fetchImpl = (async () => new Response('unavailable', { status: 503 })) as typeof fetch;
    const state = createTaskmasterState(60_000);

    const result = await tick(
      state,
      makeDeps(world, {
        getGithubIssueEvidence: (ref, sinceIso) =>
          defaultGetGithubIssueEvidence(ref, sinceIso, fetchImpl),
      })
    );

    expect(result.successful).toBe(false);
    expect(state.deadman.lastTickAtMs).toBeNull();
  });

  test('a thrown evidence fetch makes the production adapter fail closed', async () => {
    const fetchImpl = (async () => {
      throw new Error('synthetic evidence network failure');
    }) as typeof fetch;

    await expect(
      defaultGetGithubIssueEvidence(
        'gh:thinmansoftware/bdc-xo#1452',
        new Date(T0 - 30_000).toISOString(),
        fetchImpl
      )
    ).rejects.toThrow('synthetic evidence network failure');
  });

  test('low evidence quota stops later evidence calls and the successful heartbeat', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    for (const issueNumber of [1453, 1454]) {
      const key = `tm:nudge:gh:thinmansoftware/bdc-xo#${issueNumber}:1`;
      world.journal.push({
        id: `low-quota-${issueNumber}`,
        created_at: new Date(T0 - 60_000).toISOString(),
        thread_ref: `gh:thinmansoftware/bdc-xo#${issueNumber}`,
        action_type: 'nudge',
        proposal_json: '{}',
        idempotency_key: key,
        before_hash: null,
        proof_predicate: 'post-send source progress',
        proof_deadline_at: new Date(T0 + 60_000).toISOString(),
        outcome: 'sent',
        graded_at: null,
        grade: null,
      });
      world.sentMessages.push({
        idempotency_key: key,
        recipient: 'xo',
        body: 'nudge',
        createdAt: new Date(T0 - 30_000).toISOString(),
      });
    }
    const urls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (urls.length === 1) {
        return new Response(
          JSON.stringify({
            number: 1453,
            state: 'open',
            updated_at: new Date(T0).toISOString(),
            labels: [{ name: 'wo' }],
            assignees: [],
          }),
          { status: 200, headers: { 'x-ratelimit-remaining': '100' } }
        );
      }
      return new Response('[]', {
        status: 200,
        headers: { 'x-ratelimit-remaining': '4' },
      });
    }) as typeof fetch;
    const state = createTaskmasterState(60_000);

    const result = await tick(
      state,
      makeDeps(world, {
        getGithubIssueEvidence: (ref, sinceIso) =>
          defaultGetGithubIssueEvidence(ref, sinceIso, fetchImpl),
      })
    );

    expect(result.successful).toBe(false);
    expect(state.deadman.lastTickAtMs).toBeNull();
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain('/issues/1453');
    expect(urls[1]).toContain('/issues/1453/comments');
    expect(urls.some(url => url.includes('/events'))).toBe(false);
    expect(urls.some(url => url.includes('/issues/1454'))).toBe(false);
  });

  test('wo_blocked_label_is_blocked', async () => {
    const { fetchImpl } = fakeGithubFetch({
      wo: [ghIssue(21, ['wo', 'prio:P0', 'wo:blocked'])],
    });
    const threads = await defaultListThreads(fetchImpl);
    expect(threads).toHaveLength(1);
    const thread = threads[0];
    if (thread === undefined) throw new Error('missing blocked thread');
    expect(thread.isBlocked).toBe(true);
    expect(
      computeNextAction(thread, classifyThread(thread, T0), {
        interventionsLast24h: 0,
        nowMs: T0,
      })
    ).toBeNull();
  });

  test('open_pr_counts_as_claim', async () => {
    const searchUrls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/search/issues')) {
        searchUrls.push(url);
        return new Response(JSON.stringify({ items: [{ title: 'WO-EXAMPLE-FOO-01' }] }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-ratelimit-remaining': '100',
          },
        });
      }
      const label = new URL(url).searchParams.get('labels') ?? '';
      const issues =
        label === 'wo' ? [ghIssue(31, ['wo', 'prio:P0'], { title: 'WO-EXAMPLE-FOO-01' })] : [];
      return new Response(JSON.stringify(issues), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-ratelimit-remaining': '100',
        },
      });
    }) as typeof fetch;

    const threads = await defaultListThreads(fetchImpl);
    expect(searchUrls).toHaveLength(1);
    const searchUrl = searchUrls[0];
    expect(searchUrl).toBeDefined();
    const q = new URL(searchUrl ?? '').searchParams.get('q') ?? '';
    expect(q).toContain('is:pr');
    expect(q).toContain('is:open');
    expect(q).toContain('in:title,body');
    expect(q).toContain('WO-EXAMPLE-FOO-01');
    expect(q).toContain('org:thinmansoftware');
    expect(threads).toHaveLength(1);
    expect(threads[0]?.isUnclaimed).toBe(false);
    expect(threads[0]?.isUnclaimedP0).toBe(false);
  });

  test('pr_lookup_fails_open', async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/search/issues')) {
        return new Response('rate limited', {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0' },
        });
      }
      const label = new URL(url).searchParams.get('labels') ?? '';
      const issues =
        label === 'wo' ? [ghIssue(32, ['wo', 'prio:P0'], { title: 'WO-EXAMPLE-FOO-01' })] : [];
      return new Response(JSON.stringify(issues), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-ratelimit-remaining': '100',
        },
      });
    }) as typeof fetch;

    // Pino keeps the destination on a local Symbol(pino.stream), not Symbol.for.
    const streamSymbol = Object.getOwnPropertySymbols(rootLogger).find(
      symbol => symbol.description === 'pino.stream'
    );
    if (streamSymbol === undefined) {
      throw new Error('pino.stream symbol missing on rootLogger');
    }
    const stream = (rootLogger as unknown as Record<symbol, { write: (chunk: string) => boolean }>)[
      streamSymbol
    ];
    const chunks: string[] = [];
    const originalWrite = stream.write;
    stream.write = (chunk: string) => {
      chunks.push(String(chunk));
      return true;
    };
    try {
      const threads = await defaultListThreads(fetchImpl);
      expect(threads).toHaveLength(1);
      expect(threads[0]?.isUnclaimed).toBe(true);
      expect(threads[0]?.isUnclaimedP0).toBe(true);
      expect(chunks.join('')).toContain('taskmaster.pr_claim_lookup_failed');
    } finally {
      stream.write = originalWrite;
    }
  });
});

// ---------------------------------------------------------------------------
// Adoption projection (WO-HARNESS-TASKMASTER-ADOPTION-PROJECTION-01)
// Section 11 scenarios -- every test name includes "adoption" or "canonicaliz"
// ---------------------------------------------------------------------------

function makeListedThread(overrides: Partial<ListedThread> & { ref: string }): ListedThread {
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

function makeEvidence(overrides: Partial<GithubIssueEvidence> = {}): GithubIssueEvidence {
  return {
    state: 'open',
    updatedAt: new Date(T0).toISOString(),
    labels: ['wo', 'prio:P1'],
    assigneeCount: 0,
    closedAt: null,
    assignedAt: null,
    activeStatusAt: null,
    progressRecordedAt: null,
    ownerLogin: null,
    latestMarkerKind: null,
    latestMarkerText: null,
    latestMarkerAt: null,
    lastMovementAt: null,
    lastMovementKind: null,
    ...overrides,
  };
}

describe('adoption projection', () => {
  test('evidence_survives_snapshot', async () => {
    const priorBudget = process.env.TASKMASTER_ADOPTION_EVIDENCE_BUDGET;
    process.env.TASKMASTER_ADOPTION_EVIDENCE_BUDGET = '1';
    try {
      const world = makeWorld();
      const refs = [4101, 4102, 4103].map(number => `gh:thinmansoftware/bdc-xo#${number}`);
      let threads = refs.map((ref, index) =>
        makeListedThread({
          ref,
          title: `Tick 1 title ${index}`,
          priority: 'P1',
          labels: ['wo', 'prio:P1'],
          lastActivityAt: new Date(T0 - 10_000).toISOString(),
        })
      );
      const enriched: string[] = [];
      const deps = makeDeps(world, {
        getGithubIssueEvidence: async ref => {
          enriched.push(ref);
          return makeEvidence({
            ownerLogin: `owner-${ref.slice(-1)}`,
            state: 'open',
            labels: ['wo', 'prio:P1', 'evidence'],
            updatedAt: new Date(T0).toISOString(),
            latestMarkerKind: 'PROGRESS',
            latestMarkerText: `next-${ref.slice(-1)}`,
            latestMarkerAt: new Date(T0 - 2_000).toISOString(),
            lastMovementAt: new Date(T0 - 3_000).toISOString(),
            lastMovementKind: 'progress_comment',
          });
        },
      });

      await refreshAdoption(threads, deps);
      const firstA = (await deps.db!.getAdoption!()).find(row => row.thread_ref === refs[0]);
      expect(firstA?.owner_login).toBe('owner-1');

      threads = threads.map((thread, index) => ({
        ...thread,
        title: `Tick 2 title ${index}`,
        priority: 'P2',
        labels: ['wo', 'prio:P2'],
        isBlocked: true,
        lastActivityAt: new Date(T0 - 20_000).toISOString(),
      }));
      await refreshAdoption(threads, deps);
      const secondRows = await deps.db!.getAdoption!();
      const secondA = secondRows.find(row => row.thread_ref === refs[0]);
      expect(secondA?.owner_login).toBe('owner-1');
      expect(secondA?.last_movement_at).toBe(new Date(T0 - 3_000).toISOString());
      expect(secondA?.latest_marker_kind).toBe('PROGRESS');
      expect(secondA?.next_action).toBe('next-1');
      expect(secondA?.evidence_observed_at).not.toBeNull();
      expect(secondA?.title).toBe('Tick 2 title 0');
      expect(secondA?.priority).toBe('P2');
      expect(secondA?.is_blocked).toBe(1);
      expect(secondA?.source_updated_at).toBe(new Date(T0).toISOString());
      expect(
        secondRows.find(row => row.thread_ref === refs[1])?.evidence_observed_at
      ).not.toBeNull();
      expect(secondRows.find(row => row.thread_ref === refs[2])?.evidence_observed_at).toBeNull();

      threads = threads.map((thread, index) =>
        index === 0 ? { ...thread, lastActivityAt: new Date(T0 + 10_000).toISOString() } : thread
      );
      await refreshAdoption(threads, deps);
      const thirdA = (await deps.db!.getAdoption!()).find(row => row.thread_ref === refs[0]);
      expect(thirdA?.source_updated_at).toBe(new Date(T0 + 10_000).toISOString());
      expect(enriched).toEqual(refs);
    } finally {
      if (priorBudget === undefined) delete process.env.TASKMASTER_ADOPTION_EVIDENCE_BUDGET;
      else process.env.TASKMASTER_ADOPTION_EVIDENCE_BUDGET = priorBudget;
    }
  });

  test('adoption: captures charter-minimum state (title owner blocker movement)', async () => {
    const world = makeWorld();
    const thread = makeListedThread({
      ref: 'gh:thinmansoftware/bdc-xo#100',
      title: 'Fix the thing',
      ownerLogin: 'major-build',
      priority: 'P1',
      labels: ['wo', 'prio:P1'],
    });
    const deps = makeDeps(world, {
      listThreads: async () => [thread],
      getGithubIssueEvidence: async () =>
        makeEvidence({
          ownerLogin: 'major-build',
          latestMarkerKind: 'BLOCKED',
          latestMarkerText: '[BLOCKED] waiting on Stripe key rotation',
          latestMarkerAt: new Date(T0 - 3_600_000).toISOString(),
          assignedAt: new Date(T0 - 7_200_000).toISOString(),
          lastMovementAt: new Date(T0 - 7_200_000).toISOString(),
          lastMovementKind: 'assigned',
          assigneeCount: 1,
        }),
    });

    const result = await refreshAdoption([thread], deps);
    expect(result.failed).toBe(false);
    const rows = await deps.db!.getAdoption!();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.title).toBe('Fix the thing');
    expect(row.owner_login).toBe('major-build');
    expect(row.is_blocked).toBe(1);
    expect(row.blocked_reason).toContain('Stripe key rotation');
    expect(row.last_movement_kind).not.toBeNull();
    expect(row.evidence_observed_at).not.toBeNull();
  });

  test('adoption: UNKNOWN is preserved, never guessed for owner or next_action', async () => {
    const world = makeWorld();
    const thread = makeListedThread({
      ref: 'gh:thinmansoftware/bdc-xo#101',
      title: 'No owner yet',
      ownerLogin: null,
    });
    const deps = makeDeps(world, {
      getGithubIssueEvidence: async () =>
        makeEvidence({
          ownerLogin: null,
          latestMarkerKind: null,
          latestMarkerText: null,
        }),
    });
    await refreshAdoption([thread], deps);
    const row = (await deps.db!.getAdoption!())[0];
    expect(row.owner_login).toBeNull();
    expect(row.next_action).toBeNull();
    expect(row.owner_login).not.toBe('');
    expect(row.next_action).not.toBe('');
  });

  test('adoption: partial read never overwrites a good snapshot', async () => {
    const world = makeWorld();
    // Seed a committed snapshot with 3 rows.
    const seedId = 'snap-good';
    for (let i = 1; i <= 3; i++) {
      world.adoptionRows.push({
        thread_ref: `gh:thinmansoftware/bdc-xo#${i}`,
        snapshot_id: seedId,
        repo: 'thinmansoftware/bdc-xo',
        issue_number: i,
        title: `Seed ${i}`,
        priority: 'P2',
        labels_json: '[]',
        owner_login: null,
        is_blocked: 0,
        blocked_reason: null,
        next_action: null,
        latest_marker_kind: null,
        latest_marker_at: null,
        state: 'open',
        last_movement_at: null,
        last_movement_kind: null,
        attempts_24h: 0,
        attempts_total: 0,
        evidence_observed_at: new Date(T0).toISOString(),
        source_updated_at: new Date(T0).toISOString(),
      });
    }
    world.adoptionMeta = {
      committed_snapshot_id: seedId,
      rebuilt_at: new Date(T0).toISOString(),
      row_count: 3,
      source_commit: null,
      complete: 1,
    };

    let evidenceCalls = 0;
    const threads = [1, 2, 3].map(i =>
      makeListedThread({ ref: `gh:thinmansoftware/bdc-xo#${i}`, title: `T${i}` })
    );
    const deps = makeDeps(world, {
      getGithubIssueEvidence: async () => {
        evidenceCalls += 1;
        if (evidenceCalls === 1) {
          return makeEvidence({ ownerLogin: 'ok' });
        }
        // Simulate assertGithubRateLimit throw after first success.
        const err = new Error('taskmaster_github_rate_limit_backoff:4');
        err.name = 'GithubRateLimitBackoffError';
        throw err;
      },
    });

    const result = await refreshAdoption(threads, deps);
    expect(result.failed).toBe(true);
    expect(result.error).not.toBeNull();
    expect(world.adoptionMeta.committed_snapshot_id).toBe(seedId);
    const rows = await deps.db!.getAdoption!();
    expect(rows).toHaveLength(3);
    expect(rows.every(r => r.snapshot_id === seedId)).toBe(true);
    // No rows remain under the abandoned (non-seed) snapshot.
    const abandoned = world.adoptionRows.filter(r => r.snapshot_id !== seedId);
    expect(abandoned).toHaveLength(0);
  });

  test('adoption: failed refresh suppresses tick heartbeat', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    let evidenceCalls = 0;
    const thread = makeListedThread({
      ref: 'gh:thinmansoftware/bdc-xo#200',
      // Make it healthy so send path has nothing to do besides digest (already seeded).
      lastActivityAt: new Date(T0).toISOString(),
      isBlocked: false,
    });
    const deps = makeDeps(world, {
      listThreads: async () => [thread],
      getGithubIssueEvidence: async () => {
        evidenceCalls += 1;
        throw new Error('taskmaster_github_rate_limit_backoff:4');
      },
    });
    const state = createTaskmasterState(60_000);
    const result = await tick(state, deps);
    expect(result.successful).toBe(false);
    expect(state.deadman.lastTickAtMs).toBeNull();
    // grade/send phase still executed: digest was already seeded so no new send,
    // but tick completed (ran=true) rather than aborting mid-flow.
    expect(result.ran).toBe(true);
    expect(evidenceCalls).toBeGreaterThanOrEqual(1);
  });

  test('adoption: canonicalizeThreadRef spans org AND repo', async () => {
    expect(canonicalizeThreadRef('gh:bluedevilcollectibles/bdc-xo#1366')).toBe(
      'gh:thinmansoftware/bdc-xo#1366'
    );
    expect(canonicalizeThreadRef('gh:bluedevilcollectibles/bdc-harness#209')).toBe(
      'gh:thinmansoftware/bdc-harness#209'
    );
    expect(canonicalizeThreadRef('digest:2026-08-17')).toBe('digest:2026-08-17');
  });

  test('adoption: attempt counts span org eras via canonicalization', async () => {
    const world = makeWorld();
    const nowIso = new Date(T0).toISOString();
    const within24h = new Date(T0 - 3_600_000).toISOString();
    const older = new Date(T0 - 48 * 3_600_000).toISOString();
    // 3 sent on old org (1 within 24h), 2 sent on new org (both within 24h)
    const seed = (ref: string, created_at: string, id: string): void => {
      world.journal.push({
        id,
        created_at,
        thread_ref: ref,
        action_type: 'nudge',
        proposal_json: '{}',
        idempotency_key: `tm:nudge:${ref}:${id}`,
        before_hash: null,
        proof_predicate: null,
        proof_deadline_at: null,
        outcome: 'sent',
        graded_at: null,
        grade: null,
      });
    };
    seed('gh:bluedevilcollectibles/bdc-xo#1366', older, 'old-1');
    seed('gh:bluedevilcollectibles/bdc-xo#1366', older, 'old-2');
    seed('gh:bluedevilcollectibles/bdc-xo#1366', within24h, 'old-3');
    seed('gh:thinmansoftware/bdc-xo#1366', within24h, 'new-1');
    seed('gh:thinmansoftware/bdc-xo#1366', within24h, 'new-2');

    const thread = makeListedThread({
      ref: 'gh:thinmansoftware/bdc-xo#1366',
      title: 'Cross-era',
    });
    const deps = makeDeps(world, {
      getGithubIssueEvidence: async () => makeEvidence({ ownerLogin: 'xo' }),
    });
    await refreshAdoption([thread], deps);
    const rows = await deps.db!.getAdoption!();
    expect(rows).toHaveLength(1);
    expect(rows[0].thread_ref).toBe('gh:thinmansoftware/bdc-xo#1366');
    expect(rows[0].attempts_total).toBe(5);
    expect(rows[0].attempts_24h).toBe(3);
  });

  test('adoption: evidence budget bounds requests per tick at default 10', async () => {
    const world = makeWorld();
    const prior = process.env.TASKMASTER_ADOPTION_EVIDENCE_BUDGET;
    delete process.env.TASKMASTER_ADOPTION_EVIDENCE_BUDGET;
    try {
      const threads = Array.from({ length: 100 }, (_, i) =>
        makeListedThread({
          ref: `gh:thinmansoftware/bdc-xo#${1000 + i}`,
          title: `Issue ${i}`,
        })
      );
      let evidenceCalls = 0;
      const deps = makeDeps(world, {
        getGithubIssueEvidence: async () => {
          evidenceCalls += 1;
          return makeEvidence();
        },
      });
      await refreshAdoption(threads, deps);
      expect(evidenceCalls).toBeLessThanOrEqual(10);
      const rows = await deps.db!.getAdoption!();
      expect(rows).toHaveLength(100);
      const unknown = rows.filter(r => r.evidence_observed_at === null);
      expect(unknown.length).toBeGreaterThanOrEqual(90);
    } finally {
      if (prior === undefined) delete process.env.TASKMASTER_ADOPTION_EVIDENCE_BUDGET;
      else process.env.TASKMASTER_ADOPTION_EVIDENCE_BUDGET = prior;
    }
  });

  test('adoption: budget is env-overridable and enriches oldest first', async () => {
    const world = makeWorld();
    const prior = process.env.TASKMASTER_ADOPTION_EVIDENCE_BUDGET;
    process.env.TASKMASTER_ADOPTION_EVIDENCE_BUDGET = '3';
    try {
      // Seed prior committed snapshot for all 100 threads with deterministic ages.
      // Index 0 = NULL (oldest/unknown), then increasing timestamps so
      // indices 1 and 2 are the next two oldest non-null.
      const seedId = 'snap-prior';
      for (let i = 0; i < 100; i++) {
        const evidenceAt = i === 0 ? null : new Date(T0 - (100 - i) * 1_000).toISOString();
        world.adoptionRows.push({
          thread_ref: `gh:thinmansoftware/bdc-xo#${2000 + i}`,
          snapshot_id: seedId,
          repo: 'thinmansoftware/bdc-xo',
          issue_number: 2000 + i,
          title: `Prior ${i}`,
          priority: 'P2',
          labels_json: '[]',
          owner_login: null,
          is_blocked: 0,
          blocked_reason: null,
          next_action: null,
          latest_marker_kind: null,
          latest_marker_at: null,
          state: 'open',
          last_movement_at: null,
          last_movement_kind: null,
          attempts_24h: 0,
          attempts_total: 0,
          evidence_observed_at: evidenceAt,
          source_updated_at: new Date(T0).toISOString(),
        });
      }
      world.adoptionMeta = {
        committed_snapshot_id: seedId,
        rebuilt_at: new Date(T0).toISOString(),
        row_count: 100,
        source_commit: null,
        complete: 1,
      };

      const threads = Array.from({ length: 100 }, (_, i) =>
        makeListedThread({
          ref: `gh:thinmansoftware/bdc-xo#${2000 + i}`,
          title: `Issue ${i}`,
        })
      );

      const enrichedRefs: string[] = [];
      const deps = makeDeps(world, {
        getGithubIssueEvidence: async ref => {
          enrichedRefs.push(ref);
          return makeEvidence();
        },
      });
      await refreshAdoption(threads, deps);
      expect(enrichedRefs.length).toBeLessThanOrEqual(3);
      // Oldest-first: NULL (2000), then 2001 (oldest non-null), then 2002.
      expect(enrichedRefs[0]).toBe('gh:thinmansoftware/bdc-xo#2000');
      expect(enrichedRefs[1]).toBe('gh:thinmansoftware/bdc-xo#2001');
      expect(enrichedRefs[2]).toBe('gh:thinmansoftware/bdc-xo#2002');
    } finally {
      if (prior === undefined) delete process.env.TASKMASTER_ADOPTION_EVIDENCE_BUDGET;
      else process.env.TASKMASTER_ADOPTION_EVIDENCE_BUDGET = prior;
    }
  });

  test('adoption: send path untouched regression guard', async () => {
    // Re-run a classic send scenario to prove the adoption insert did not
    // change send/grade behavior. Existing suite scenarios remain unmodified.
    const world = makeWorld();
    seedDigestSent(world);
    const deps = makeDeps(world, {
      listUndeliveredRulings: async () => [
        {
          ref: 'dispatch:ruling-42',
          priority: 'P1',
          lastActivityAt: new Date(T0 - 3_600_000).toISOString(),
          undeliveredRulingId: 'ruling-42',
          recipient: 'xo',
        },
      ],
      listThreads: async () => [],
    });
    const state = createTaskmasterState(60_000);
    const first = await tick(state, deps);
    expect(first.effects).toBe(1);
    const second = await tick(state, deps);
    // Second tick: two-tick confirm already satisfied on first for actsImmediately.
    // deliver_ruling is actsImmediately; second tick should not double-send.
    const deliverRows = world.journal.filter(j => j.action_type === 'deliver_ruling');
    expect(deliverRows.length).toBe(1);
    expect(
      world.sentMessages.filter(m => m.idempotency_key.includes('deliver_ruling')).length
    ).toBe(1);
    expect(second.effects).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// M-155 WO 3 (WO-HARNESS-TASKMASTER-EXCEPTION-PUSH-01) -- exception push:
// recipient routing stub, noise-suppression wiring, dispatch metadata,
// safety-spine regression. Every test name carries the literal 'push:'.
// ---------------------------------------------------------------------------

describe('M-155 exception push (loop)', () => {
  /** Content-complete evidence: PROGRESS marker becomes next_action in adoption. */
  function contentEvidence(markerText: string, movedAtMs: number): GithubIssueEvidence {
    return makeEvidence({
      ownerLogin: 'major-build',
      latestMarkerKind: 'PROGRESS',
      latestMarkerText: markerText,
      latestMarkerAt: new Date(movedAtMs).toISOString(),
      lastMovementAt: new Date(movedAtMs).toISOString(),
      lastMovementKind: 'progress_comment',
      progressRecordedAt: null,
    });
  }

  function suppressionDb(
    world: FakeWorld,
    store: Map<string, TmSuppressionRow>
  ): TaskmasterDeps['db'] {
    const base = makeDeps(world).db;
    return {
      ...base,
      getSuppression: async (): Promise<Map<string, TmSuppressionRow>> => new Map(store),
      setSuppression: async (threadRef: string, hash: string): Promise<void> => {
        store.set(threadRef, {
          thread_ref: threadRef,
          suppressed_until_hash: hash,
          suppressed_at: new Date(world.nowMs).toISOString(),
          noise_grade_count: 2,
        });
      },
      clearSuppression: async (threadRef: string): Promise<void> => {
        store.delete(threadRef);
      },
    } as TaskmasterDeps['db'];
  }

  test('push: every owner resolves to an allowed active draining principal', async () => {
    // Only 'xo' (XO session-start reflex) and 'operator' (John) have a
    // documented drainer; routing to any other mailbox would manufacture a
    // second dead-letter box -- the failure this WO exists to end.
    for (const owner of ['major-build', 'captain-ci', 'unmapped-login', null]) {
      const resolved = resolveRecipient(owner);
      expect(resolved).toBe('xo');
      expect(TM_ALLOWED_RECIPIENTS).toContain(resolved);
    }
    // The map structure exists and every entry points at 'xo', so widening it
    // later is a data change rather than a code change.
    expect(Object.keys(OWNER_RECIPIENT_MAP).length).toBeGreaterThan(0);
    const principalDb = new SqliteAdapter(':memory:');
    try {
      for (const target of Object.values(OWNER_RECIPIENT_MAP)) {
        expect(TM_ALLOWED_RECIPIENTS).toContain(target);
        const result = await principalDb.query<{ active: number; delivery_mode: string }>(
          'SELECT active, delivery_mode FROM dispatch_principals WHERE principal_id = $1',
          [target]
        );
        expect(result.rows[0]?.active).toBe(1);
        expect(['drain_on_start', 'worker_poll']).toContain(result.rows[0]?.delivery_mode);
      }
    } finally {
      await principalDb.close();
    }
  });

  test('push: content_incomplete is an ordinary reject, never a HARD_PAUSE', async () => {
    // Guard half: a proposal flagged content-incomplete (or with a null body)
    // is rejected with the ORDINARY content_incomplete reason -- forbiddenEffect
    // stays falsy, so the auto-circuit cannot trip.
    const base: ActionProposal = {
      type: 'nudge',
      threadRef: 'gh:thinmansoftware/bdc-xo#930',
      recipient: 'xo',
      body: 'placeholder',
      idempotencyKey: 'tm:nudge:gh:thinmansoftware/bdc-xo#930:1',
      actsImmediately: false,
    };
    const flagged = validateProposal({ ...base, contentIncomplete: true });
    expect(flagged.allowed).toBe(false);
    expect(flagged.reason).toContain('content_incomplete');
    expect(flagged.forbiddenEffect).toBeFalsy();
    const nullBody = validateProposal({ ...base, body: null as unknown as string });
    expect(nullBody.allowed).toBe(false);
    expect(nullBody.reason).toContain('content_incomplete');
    expect(nullBody.forbiddenEffect).toBeFalsy();

    // Loop half: an ordinary (non-forbiddenEffect) guard rejection flowing
    // through a real tick is journaled 'rejected' and leaves tm_control
    // untouched -- no auto-circuit, no HARD_PAUSE.
    const world = makeWorld();
    seedDigestSent(world);
    const ref = 'gh:thinmansoftware/bdc-xo#931';
    const thread = makeListedThread({
      ref,
      title: 'Content-rejected item',
      lastActivityAt: new Date(T0 - 6 * 3_600_000).toISOString(),
    });
    const deps = makeDeps(world, {
      listThreads: async () => [thread],
      // The composed next action carries a forbidden verb, so the guard
      // rejects the content (ordinary reject path, same as content_incomplete).
      getGithubIssueEvidence: async () =>
        contentEvidence('[PROGRESS] deploy to production now', T0 - 3 * 3_600_000),
    });
    const state = createTaskmasterState(60_000);
    await tick(state, deps); // observation tick
    world.nowMs += 60_000;
    const result = await tick(state, deps); // confirming tick -> guard reject

    expect(result.rejected).toBe(1);
    const rejected = world.journal.filter(j => j.thread_ref === ref && j.outcome === 'rejected');
    expect(rejected.length).toBe(1);
    expect(rejected[0]?.proposal_json).toContain('spend_send_deploy_verb_rejected');
    expect(world.sentMessages.filter(m => m.idempotency_key.startsWith('tm:nudge:'))).toHaveLength(
      0
    );
    // The pause matrix is untouched: still RUNNING, no auto-circuit actor.
    expect(world.control.pause_state).toBe('RUNNING');
    expect(world.control.pause_actor).toBeNull();
  });

  test('push: subject_key + repeat_reason satisfy the dispatch contract (loop side)', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    // Old-org ref proves the subject_key is CANONICALIZED before dispatch.
    const rawRef = 'gh:bluedevilcollectibles/bdc-xo#911';
    const canonRef = canonicalizeThreadRef(rawRef);
    const thread = makeListedThread({
      ref: rawRef,
      title: 'Cross-era subject',
      lastActivityAt: new Date(T0 - 6 * 3_600_000).toISOString(),
    });
    const captured: Array<Record<string, unknown>> = [];
    const deps = makeDeps(world, {
      listThreads: async () => [thread],
      getGithubIssueEvidence: async () =>
        contentEvidence('[PROGRESS] waiting on review feedback', T0 - 3 * 3_600_000),
      createTask: (async (_context: unknown, data: Record<string, unknown>) => {
        captured.push(data);
        world.sentMessages.push({
          idempotency_key: String(data.idempotency_key),
          recipient: String(data.recipient),
          body: String(data.body),
          createdAt: new Date(world.nowMs).toISOString(),
        });
        return { id: `msg-${captured.length}`, status: 'queued' };
      }) as unknown as TaskmasterDeps['createTask'],
    });
    const state = createTaskmasterState(60_000);
    await tick(state, deps); // observation
    world.nowMs += 60_000;
    await tick(state, deps); // confirm + send

    const nudgeCall = captured.find(c => String(c.idempotency_key).startsWith('tm:nudge:'));
    expect(nudgeCall).toBeDefined();
    // Loop supplies subject_key (canonical) + the per-verb repeat_reason
    // literal UNCONDITIONALLY, so the migration-042 repeat_reason_required
    // throw can never fire on the real send path (DB-level throw behavior is
    // proven in packages/core/src/db/taskmaster.test.ts push: coverage).
    expect(nudgeCall?.subject_key).toBe(canonRef);
    expect(nudgeCall?.repeat_reason).toBe('tm:nudge:follow-up');
    expect(TM_REPEAT_REASON_BY_TYPE.escalate_p0).toBe('tm:escalate_p0:repeated');
    expect(TM_REPEAT_REASON_BY_TYPE.deliver_ruling).toBe('tm:deliver_ruling:repeated');
    expect(String(nudgeCall?.body)).toContain('Cross-era subject');
  });

  test('push: two consecutive noise grades suppress until content changes (loop wiring)', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    const ref = 'gh:thinmansoftware/bdc-xo#910';
    // Two prior sends, both GRADED noise (created within 24h; budget 3 not hit).
    for (const [idx, gradedAt] of [T0 - 2 * 3_600_000, T0 - 3_600_000].entries()) {
      world.journal.push({
        id: `noise-${idx}`,
        created_at: new Date(T0 - 12 * 3_600_000).toISOString(),
        thread_ref: ref,
        action_type: 'nudge',
        proposal_json: '{}',
        idempotency_key: `tm:nudge:${ref}:old${idx}`,
        before_hash: null,
        proof_predicate: null,
        proof_deadline_at: null,
        outcome: 'sent',
        graded_at: new Date(gradedAt).toISOString(),
        grade: 'noise',
      });
    }
    const thread = makeListedThread({
      ref,
      title: 'Chronic but titled',
      lastActivityAt: new Date(T0 - 6 * 3_600_000).toISOString(),
    });
    // Movement OLDER than the later noise grade: content unchanged since.
    let evidence = contentEvidence('[PROGRESS] waiting on review', T0 - 3 * 24 * 3_600_000);
    const suppStore = new Map<string, TmSuppressionRow>();
    const deps = makeDeps(world, {
      listThreads: async () => [thread],
      getGithubIssueEvidence: async () => evidence,
    });
    deps.db = suppressionDb(world, suppStore);
    const state = createTaskmasterState(60_000);

    await tick(state, deps);
    world.nowMs += 60_000;
    await tick(state, deps);

    // A durable tm_suppression row was written and no nudge left the process.
    expect(suppStore.has(ref)).toBe(true);
    expect(world.sentMessages.filter(m => m.idempotency_key.startsWith('tm:nudge:'))).toHaveLength(
      0
    );

    // The work moves: next_action + last_movement_at change -> hash differs ->
    // suppression lifts (row deleted) and the nudge sends after re-confirm.
    evidence = contentEvidence('[PROGRESS] waiting on John decision', T0 - 30 * 60_000);
    world.nowMs += 60_000;
    await tick(state, deps); // lift + observation
    expect(suppStore.has(ref)).toBe(false);
    world.nowMs += 60_000;
    await tick(state, deps); // confirm + send

    const nudges = world.sentMessages.filter(m => m.idempotency_key.startsWith('tm:nudge:'));
    expect(nudges).toHaveLength(1);
    expect(nudges[0]?.body).toContain('waiting on John decision');
    expect(nudges[0]?.body).toContain('Chronic but titled');
  });

  test('push: the six-verb allowlist and the budgets are explicit (regression)', () => {
    expect(MAX_INTERVENTIONS_PER_ITEM_24H).toBe(3);
    expect(MAX_EFFECTS_PER_TICK).toBe(10);
    expect([...TM_ALLOWED_ACTION_TYPES]).toEqual([
      'deliver_ruling',
      'nudge',
      'escalate_p0',
      'digest',
      'fire_cauldron',
      'blocker_report',
      'pr_repair',
    ]);
    expect([...TM_ALLOWED_RECIPIENTS]).toEqual([
      'xo',
      'major-build',
      'captain-ci',
      'operator',
      'duty-officer',
    ]);
  });

  test('fire verb environment defaults OFF without a calendar budget', () => {
    expect(resolveFireVerbEnabled(undefined)).toBe(false);
    expect(resolveFireVerbEnabled('true')).toBe(true);
  });

  test('push: the loop never resumes itself -- no setPauseState RUNNING write', () => {
    // Source assertion: every setPauseState call site in the taskmaster server
    // source writes a pause, never 'RUNNING'. Un-pause is an operator action
    // at M-155 gate G11, never a code path. Reads/comparisons of 'RUNNING'
    // are legitimate and remain.
    for (const file of ['loop.ts', 'rules.ts', 'guard.ts']) {
      const source = readFileSync(join(import.meta.dir, file), 'utf8');
      const callSites = source.split('setPauseState(').slice(1);
      for (const site of callSites) {
        expect(site.slice(0, 300)).not.toContain("'RUNNING'");
      }
      expect(/pause_state:\s*'RUNNING'/.test(source)).toBe(false);
    }
  });
});

describe('escalate_p0 GitHub-issue delivery (WO-HARNESS-TASKMASTER-ESCALATE-TO-ISSUE-01)', () => {
  const P0_REF = 'gh:thinmansoftware/bdc-harness#194';

  function seedEscalation(
    world: FakeWorld,
    outcome: TmActionOutcome,
    proposal: Record<string, unknown>
  ): void {
    world.journal.push({
      id: `journal-escalate-seed-${world.journal.length}`,
      created_at: new Date(world.nowMs - 31 * 60_000).toISOString(),
      thread_ref: P0_REF,
      action_type: 'escalate_p0',
      proposal_json: JSON.stringify(proposal),
      idempotency_key: 'tm:escalate_p0:seed',
      before_hash: null,
      proof_predicate: null,
      proof_deadline_at: null,
      outcome,
      graded_at: null,
      grade: null,
    });
  }

  function unclaimedP0(ref = P0_REF): ListedThread {
    return makeListedThread({
      ref,
      priority: 'P0',
      isUnclaimed: true,
      isUnclaimedP0: true,
      lastActivityAt: new Date(T0 - 6 * 3_600_000).toISOString(),
      title: 'WO-HARNESS-EXAMPLE-194 stuck P0',
    });
  }

  test('adopt_fixup_stale_epoch_expired_does_not_suppress', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    seedEscalation(world, 'expired', { type: 'escalate_p0' });
    const gh = makeIssueCommentSink(world);
    const deps = makeDeps(world, {
      listThreads: async () => [unclaimedP0()],
      escalationDelivery: gh.delivery,
      checkFireEligibility: async () => ({ eligible: false, reason: 'test_no_fire' }),
    });

    const result = await tick(createTaskmasterState(60_000), deps);

    expect(result.effects).toBe(1);
    expect(gh.posts()).toBe(1);
    expect(
      world.journal.filter(row => row.thread_ref === P0_REF && row.action_type === 'escalate_p0')
    ).toHaveLength(2);
  });

  test('adopt_fixup_pending_and_suppressed_dedupe_boundaries', async () => {
    const pendingWorld = makeWorld();
    seedDigestSent(pendingWorld);
    seedEscalation(pendingWorld, 'pending', { type: 'escalate_p0' });
    const pendingGh = makeIssueCommentSink(pendingWorld);
    const pendingDeps = makeDeps(pendingWorld, {
      listThreads: async () => [unclaimedP0()],
      escalationDelivery: pendingGh.delivery,
      checkFireEligibility: async () => ({ eligible: false, reason: 'test_no_fire' }),
    });

    await tick(createTaskmasterState(60_000), pendingDeps);

    expect(pendingGh.posts()).toBe(1);
    expect(
      pendingWorld.journal.filter(
        row => row.thread_ref === P0_REF && row.action_type === 'escalate_p0'
      )
    ).toHaveLength(2);

    const suppressedWorld = makeWorld();
    seedDigestSent(suppressedWorld);
    seedEscalation(suppressedWorld, 'expired', {
      type: 'escalate_p0',
      suppressed: 'claim_held',
    });
    const suppressedGh = makeIssueCommentSink(suppressedWorld);
    const suppressedDeps = makeDeps(suppressedWorld, {
      listThreads: async () => [unclaimedP0()],
      escalationDelivery: suppressedGh.delivery,
      checkFireEligibility: async () => ({ eligible: false, reason: 'test_no_fire' }),
    });

    await tick(createTaskmasterState(60_000), suppressedDeps);

    expect(suppressedGh.posts()).toBe(0);
    expect(
      suppressedWorld.journal.filter(
        row => row.thread_ref === P0_REF && row.action_type === 'escalate_p0'
      )
    ).toHaveLength(1);
  });

  test('adopt_fixup_concurrent_ticks_journal_one_escalation', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    const gh = makeIssueCommentSink(world);
    const deps = makeDeps(world, {
      listThreads: async () => [unclaimedP0()],
      escalationDelivery: gh.delivery,
      checkFireEligibility: async () => ({ eligible: false, reason: 'test_no_fire' }),
    });
    const getActionsSince = deps.db!.getActionsSince.bind(deps.db);
    let releaseLookback: (() => void) | undefined;
    const lookbackBarrier = new Promise<void>(resolve => {
      releaseLookback = resolve;
    });
    let lookbackCalls = 0;
    deps.db = {
      ...deps.db!,
      getActionsSince: async sinceIso => {
        lookbackCalls += 1;
        if (lookbackCalls === 1) setTimeout(() => releaseLookback?.(), 0);
        if (lookbackCalls <= 2) await lookbackBarrier;
        return getActionsSince(sinceIso);
      },
    };

    try {
      await Promise.all([
        tick(createTaskmasterState(60_000), deps),
        tick(createTaskmasterState(60_000), deps),
      ]);
    } finally {
      releaseLookback?.();
    }

    expect(
      world.journal.filter(row => row.thread_ref === P0_REF && row.action_type === 'escalate_p0')
    ).toHaveLength(1);
    expect(gh.posts()).toBe(1);
  });

  test('gh-ref escalation posts exactly one marked comment and sends NO dispatch message', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    const gh = makeIssueCommentSink(world);
    const deps = makeDeps(world, {
      listThreads: async () => [unclaimedP0()],
      escalationDelivery: gh.delivery,
      // Ambient TASKMASTER_FIRE_VERB_ENABLED must not turn these into fire cascades.
      checkFireEligibility: async () => ({ eligible: false, reason: 'test_no_fire' }),
    });

    await tick(createTaskmasterState(60_000), deps);

    // One marked issue comment; zero operator-mailbox dispatch messages.
    expect(gh.posts()).toBe(1);
    expect(gh.comments).toHaveLength(1);
    expect(gh.comments[0]?.body).toContain(TASKMASTER_ESCALATION_MARKER);
    expect(gh.comments[0]?.body).toContain('Escalated by Taskmaster (M-155).');
    expect(world.sentMessages).toHaveLength(0);

    // Journal: the escalate_p0 row is sent + graded delivered_to_issue.
    const row = world.journal.find(j => j.thread_ref === P0_REF && j.action_type === 'escalate_p0');
    expect(row?.outcome).toBe('sent');
    expect(row?.grade).toBe('delivered_to_issue');
  });

  test('a later tick with no new activity (within cooldown) posts nothing more', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    const gh = makeIssueCommentSink(world);
    const deps = makeDeps(world, {
      listThreads: async () => [unclaimedP0()],
      escalationDelivery: gh.delivery,
      // Ambient TASKMASTER_FIRE_VERB_ENABLED must not turn these into fire cascades.
      checkFireEligibility: async () => ({ eligible: false, reason: 'test_no_fire' }),
    });

    // Tick 1 posts.
    await tick(createTaskmasterState(60_000), deps);
    expect(gh.posts()).toBe(1);

    // Advance past the P0 bucket (30m) so a fresh escalate_p0 proposal is made,
    // but stay well inside the 72h cooldown. The module suppresses the repeat.
    world.nowMs += 45 * 60_000;
    await tick(createTaskmasterState(60_000), deps);
    expect(gh.posts()).toBe(1);
    expect(gh.comments).toHaveLength(1);
    expect(world.sentMessages).toHaveLength(0);
  });

  test('posted:true -> row sent + delivered_to_issue and counted as one tick effect', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    const gh = makeIssueCommentSink(world);
    const deps = makeDeps(world, {
      listThreads: async () => [unclaimedP0()],
      escalationDelivery: gh.delivery,
      checkFireEligibility: async () => ({ eligible: false, reason: 'test_no_fire' }),
    });

    const result = await tick(createTaskmasterState(60_000), deps);

    expect(gh.posts()).toBe(1);
    expect(result.effects).toBe(1);
    expect(result.expired).toBe(0);
    const rows = world.journal.filter(
      j => j.thread_ref === P0_REF && j.action_type === 'escalate_p0'
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe('sent');
    expect(rows[0]?.grade).toBe('delivered_to_issue');
    expect(JSON.parse(rows[0]?.proposal_json ?? '{}').suppressed).toBeUndefined();
  });

  test('posted:false (cooldown marker) -> expired + suppressed detail, ungraded, not an effect', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    const gh = makeIssueCommentSink(world);
    const deps = makeDeps(world, {
      listThreads: async () => [unclaimedP0()],
      escalationDelivery: {
        ...gh.delivery,
        listIssueComments: async () => [
          {
            body: TASKMASTER_ESCALATION_MARKER,
            created_at: new Date(world.nowMs).toISOString(),
            authorLogin: 'taskmaster-bot',
          },
        ],
      },
      checkFireEligibility: async () => ({ eligible: false, reason: 'test_no_fire' }),
    });

    const first = await tick(createTaskmasterState(60_000), deps);
    expect(first.expired).toBe(1);
    expect(gh.posts()).toBe(0);

    // New P0 bucket (30m), same 24h journal window: proposal-level dedupe
    // prevents a second delivery attempt and journal row.
    world.nowMs += 45 * 60_000;
    const result = await tick(createTaskmasterState(60_000), deps);

    expect(gh.posts()).toBe(0);
    expect(result.effects).toBe(0);
    expect(result.expired).toBe(0);
    const rows = world.journal.filter(
      j => j.thread_ref === P0_REF && j.action_type === 'escalate_p0'
    );
    expect(rows).toHaveLength(1);
    const suppressed = rows[0];
    expect(suppressed?.outcome).toBe('expired');
    expect(suppressed?.grade).toBeNull();
    expect(JSON.parse(suppressed?.proposal_json ?? '{}').suppressed).toBe('cooldown_marker');
  });

  test('claim held by another attempt -> expired with suppressed=claim_held, nothing posted', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    const gh = makeIssueCommentSink(world);
    let lists = 0;
    const deps = makeDeps(world, {
      listThreads: async () => [unclaimedP0()],
      escalationDelivery: {
        ...gh.delivery,
        listIssueComments: async (...args) => {
          lists += 1;
          return gh.delivery.listIssueComments(...args);
        },
        claim: {
          claim: async () => null,
          complete: async () => {},
          release: async () => {},
        },
      },
      checkFireEligibility: async () => ({ eligible: false, reason: 'test_no_fire' }),
    });

    const result = await tick(createTaskmasterState(60_000), deps);

    // The claim is taken BEFORE the GitHub list+post: neither happens.
    expect(lists).toBe(0);
    expect(gh.posts()).toBe(0);
    expect(result.effects).toBe(0);
    expect(result.expired).toBe(1);
    const row = world.journal.find(j => j.thread_ref === P0_REF && j.action_type === 'escalate_p0');
    expect(row?.outcome).toBe('expired');
    expect(row?.grade).toBeNull();
    expect(JSON.parse(row?.proposal_json ?? '{}').suppressed).toBe('claim_held');
  });

  test('escalate_p0_journaled_once_per_issue_per_24h', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    const gh = makeIssueCommentSink(world);
    const deps = makeDeps(world, {
      listThreads: async () => [unclaimedP0()],
      escalationDelivery: {
        ...gh.delivery,
        claim: { claim: async () => null, complete: async () => {}, release: async () => {} },
      },
      checkFireEligibility: async () => ({ eligible: false, reason: 'test_no_fire' }),
    });

    for (let index = 0; index < 3; index += 1) {
      const result = await tick(createTaskmasterState(60_000), deps);
      expect(result.expired).toBe(index === 0 ? 1 : 0);
      world.nowMs += 31 * 60_000;
    }

    expect(
      world.journal.filter(row => row.thread_ref === P0_REF && row.action_type === 'escalate_p0')
    ).toHaveLength(1);
  });

  test('escalate_p0_reproposed_after_24h', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    const gh = makeIssueCommentSink(world);
    const deps = makeDeps(world, {
      listThreads: async () => [unclaimedP0()],
      escalationDelivery: {
        ...gh.delivery,
        claim: { claim: async () => null, complete: async () => {}, release: async () => {} },
      },
      checkFireEligibility: async () => ({ eligible: false, reason: 'test_no_fire' }),
    });

    await tick(createTaskmasterState(60_000), deps);
    world.nowMs += 25 * 60 * 60_000;
    const result = await tick(createTaskmasterState(60_000), deps);

    expect(result.expired).toBe(1);
    expect(
      world.journal.filter(row => row.thread_ref === P0_REF && row.action_type === 'escalate_p0')
    ).toHaveLength(2);
  });

  test('escalate_p0_dedupe_is_per_thread', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    const refs = ['gh:thinmansoftware/bdc-harness#9101', 'gh:thinmansoftware/bdc-harness#9102'];
    const gh = makeIssueCommentSink(world);
    const deps = makeDeps(world, {
      listThreads: async () => refs.map(ref => unclaimedP0(ref)),
      escalationDelivery: {
        ...gh.delivery,
        claim: { claim: async () => null, complete: async () => {}, release: async () => {} },
      },
      checkFireEligibility: async () => ({ eligible: false, reason: 'test_no_fire' }),
    });

    for (let index = 0; index < 3; index += 1) {
      await tick(createTaskmasterState(60_000), deps);
      world.nowMs += 31 * 60_000;
    }

    for (const ref of refs) {
      expect(
        world.journal.filter(row => row.thread_ref === ref && row.action_type === 'escalate_p0')
      ).toHaveLength(1);
    }
  });

  test('suppressed escalations do not consume the per-item 24h intervention cap or the floor', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    const gh = makeIssueCommentSink(world);
    const deps = makeDeps(world, {
      listThreads: async () => [unclaimedP0()],
      escalationDelivery: {
        ...gh.delivery,
        claim: {
          claim: async () => null,
          complete: async () => {},
          release: async () => {},
        },
      },
      checkFireEligibility: async () => ({ eligible: false, reason: 'test_no_fire' }),
    });

    // Tick 1 reaches delivery and is suppressed. Later buckets are dropped by
    // proposal-level dedupe before delivery and do not affect intervention
    // accounting or the useful-rate floor.
    const first = await tick(createTaskmasterState(60_000), deps);
    expect(first.expired).toBe(1);
    const suppressedTicks = MAX_INTERVENTIONS_PER_ITEM_24H + 2;
    for (let i = 0; i < suppressedTicks; i += 1) {
      world.nowMs += 31 * 60_000;
      const result = await tick(createTaskmasterState(60_000), deps);
      expect(result.effects).toBe(0);
      expect(result.expired).toBe(0);
    }

    expect(gh.posts()).toBe(0);
    const rows = world.journal.filter(
      j => j.thread_ref === P0_REF && j.action_type === 'escalate_p0'
    );
    expect(rows).toHaveLength(1);
    expect(rows.filter(r => r.outcome === 'sent')).toHaveLength(0);
    expect(rows.filter(r => r.outcome === 'expired')).toHaveLength(1);
    // Never graded: not in the useful-rate floor (only 'useful'/'noise' count)
    // and never 'delivered_to_issue'.
    for (const row of rows.filter(r => r.outcome === 'expired')) {
      expect(row.grade).toBeNull();
    }
  });

  test('after the 72h cooldown, the next tick escalates again', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    const gh = makeIssueCommentSink(world);
    const deps = makeDeps(world, {
      listThreads: async () => [unclaimedP0()],
      escalationDelivery: gh.delivery,
      // Ambient TASKMASTER_FIRE_VERB_ENABLED must not turn these into fire cascades.
      checkFireEligibility: async () => ({ eligible: false, reason: 'test_no_fire' }),
    });

    await tick(createTaskmasterState(60_000), deps);
    expect(gh.posts()).toBe(1);

    // Advance beyond the cooldown (new bucket, new idempotency key): re-escalate.
    // Crossing >72h lands on a new UTC day, so a fresh digest legitimately
    // dispatches; assert only that NO escalate_p0 went to the operator mailbox.
    world.nowMs += TASKMASTER_ESCALATION_COOLDOWN_MS + 60 * 60_000;
    await tick(createTaskmasterState(60_000), deps);
    expect(gh.posts()).toBe(2);
    expect(gh.comments).toHaveLength(2);
    expect(
      world.sentMessages.filter(m => m.idempotency_key.startsWith('tm:escalate_p0:'))
    ).toHaveLength(0);
  });

  test('a non-gh escalate_p0 thread keeps the operator-mailbox dispatch path', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    const gh = makeIssueCommentSink(world);
    const deps = makeDeps(world, {
      listThreads: async () => [unclaimedP0('dispatch:orphan-p0-1')],
      escalationDelivery: gh.delivery,
      // Ambient TASKMASTER_FIRE_VERB_ENABLED must not turn these into fire cascades.
      checkFireEligibility: async () => ({ eligible: false, reason: 'test_no_fire' }),
    });

    await tick(createTaskmasterState(60_000), deps);

    // No issue comment; the escalation goes out as a dispatch message as before.
    expect(gh.posts()).toBe(0);
    const escalations = world.sentMessages.filter(m =>
      m.idempotency_key.startsWith('tm:escalate_p0:')
    );
    expect(escalations).toHaveLength(1);
    expect(escalations[0]?.recipient).toBe('operator');
    expect(escalations[0]?.body).toContain('Unclaimed P0');
  });

  test('kill switch TASKMASTER_ESCALATE_TO_ISSUE=false restores the dispatch path for a gh-ref', async () => {
    const prior = process.env.TASKMASTER_ESCALATE_TO_ISSUE;
    process.env.TASKMASTER_ESCALATE_TO_ISSUE = 'false';
    try {
      const world = makeWorld();
      seedDigestSent(world);
      const gh = makeIssueCommentSink(world);
      const deps = makeDeps(world, {
        listThreads: async () => [unclaimedP0()],
        escalationDelivery: gh.delivery,
        checkFireEligibility: async () => ({ eligible: false, reason: 'test_no_fire' }),
      });

      await tick(createTaskmasterState(60_000), deps);

      // Kill switch off => no issue comment; old dispatch-mailbox path used.
      expect(gh.posts()).toBe(0);
      const escalations = world.sentMessages.filter(m =>
        m.idempotency_key.startsWith('tm:escalate_p0:')
      );
      expect(escalations).toHaveLength(1);
      expect(escalations[0]?.recipient).toBe('operator');
    } finally {
      if (prior === undefined) delete process.env.TASKMASTER_ESCALATE_TO_ISSUE;
      else process.env.TASKMASTER_ESCALATE_TO_ISSUE = prior;
    }
  });
});

describe('blocker_report loop (WO-HARNESS-TASKMASTER-BLOCKER-REPORT-TO-DO-01)', () => {
  const HOUR = 3_600_000;

  function withBlockerFlag(value: string | undefined): () => void {
    const prior = process.env.TASKMASTER_BLOCKER_REPORT;
    if (value === undefined) delete process.env.TASKMASTER_BLOCKER_REPORT;
    else process.env.TASKMASTER_BLOCKER_REPORT = value;
    return () => {
      if (prior === undefined) delete process.env.TASKMASTER_BLOCKER_REPORT;
      else process.env.TASKMASTER_BLOCKER_REPORT = prior;
    };
  }

  function blockedThread(n: number): ListedThread {
    return makeListedThread({
      ref: `gh:thinmansoftware/bdc-xo#${n}`,
      priority: 'P1',
      title: `WO-BLOCK-${n} stuck`,
      isBlocked: true,
      labels: ['wo', 'prio:P1', 'blocked'],
      lastActivityAt: new Date(T0 - 3 * HOUR).toISOString(),
    });
  }

  test('blocker_report: tick sends to duty-officer with subject and repeat reason, capped per tick', async () => {
    const restore = withBlockerFlag('true');
    try {
      const world = makeWorld();
      seedDigestSent(world);
      const threads = [1, 2, 3, 4, 5].map(blockedThread);
      const createCalls: Array<{
        idempotency_key: string;
        recipient: string;
        subject_key?: string;
        repeat_reason?: string;
        priority?: string;
        body: string;
      }> = [];
      const deps = makeDeps(world, {
        listThreads: async () =>
          Object.assign([...threads], { unlabelledPriorityTriage: [] as string[] }),
        createTask: (async (
          _ctx: unknown,
          data: {
            idempotency_key: string;
            recipient: string;
            subject_key?: string;
            repeat_reason?: string;
            priority?: string;
            body: string;
          }
        ) => {
          createCalls.push(data);
          world.sentMessages.push({
            idempotency_key: data.idempotency_key,
            recipient: data.recipient,
            body: data.body,
            createdAt: new Date(world.nowMs).toISOString(),
          });
          return { id: `msg-${world.sentMessages.length}`, status: 'queued' };
        }) as unknown as TaskmasterDeps['createTask'],
      });
      const registered: Array<{ recipient: string; on_absence: string; max_retries: number }> = [];
      deps.db = {
        ...deps.db!,
        registerExpectation: async (d: {
          recipient: string;
          on_absence: string;
          max_retries: number;
        }) => {
          registered.push(d);
          return `exp-${registered.length}`;
        },
      };
      const state = createTaskmasterState(60_000);
      await tick(state, deps); // confirm tick
      world.nowMs += 60_000;
      await tick(state, deps); // send tick

      const reportCalls = createCalls.filter(c =>
        c.idempotency_key.startsWith('tm:blocker_report:')
      );
      expect(reportCalls).toHaveLength(MAX_BLOCKER_REPORTS_PER_TICK);
      for (const c of reportCalls) {
        expect(c.recipient).toBe('duty-officer');
        expect(c.subject_key).toMatch(/^gh:thinmansoftware\/bdc-xo#\d+$/);
        expect(c.repeat_reason).toBe('tm:blocker_report:repeated');
        expect(c.priority).toBeUndefined();
      }
      // The other 2 are journaled deferred.
      const deferred = world.journal.filter(
        j => j.action_type === 'blocker_report' && j.outcome === 'deferred'
      );
      expect(deferred).toHaveLength(2);
      // No createTask addressed to xo or an owner seat.
      expect(
        createCalls.some(c => ['xo', 'major-build', 'captain-ci', 'operator'].includes(c.recipient))
      ).toBe(false);
      // Each blocker_report expectation: give_up / 0 retries (no redispatch).
      const blockerExps = registered.filter(e => e.recipient === 'duty-officer');
      expect(blockerExps).toHaveLength(MAX_BLOCKER_REPORTS_PER_TICK);
      for (const e of blockerExps) {
        expect(e.on_absence).toBe('give_up');
        expect(e.max_retries).toBe(0);
      }
    } finally {
      restore();
    }
  });

  test('blocker_report: pause parks it and the flag turns it off', async () => {
    // (a) PAUSED scope effects -> parked, no send.
    {
      const restore = withBlockerFlag('true');
      try {
        const world = makeWorld();
        seedDigestSent(world);
        world.control.pause_state = 'PAUSED';
        world.control.pause_scope = 'effects';
        const deps = makeDeps(world, { listThreads: async () => [blockedThread(11)] });
        const state = createTaskmasterState(60_000);
        await tick(state, deps);
        world.nowMs += 60_000;
        await tick(state, deps);
        const row = world.journal.find(j => j.action_type === 'blocker_report');
        expect(row?.outcome).toBe('parked');
        expect(JSON.parse(row?.proposal_json ?? '{}').reason).toBe('paused');
        expect(
          world.sentMessages.some(m => m.idempotency_key.startsWith('tm:blocker_report:'))
        ).toBe(false);
      } finally {
        restore();
      }
    }
    // (b) PAUSED scope null -> still parked (blocker_report is never pause-exempt).
    {
      const restore = withBlockerFlag('true');
      try {
        const world = makeWorld();
        seedDigestSent(world);
        world.control.pause_state = 'PAUSED';
        world.control.pause_scope = null;
        const deps = makeDeps(world, { listThreads: async () => [blockedThread(12)] });
        const state = createTaskmasterState(60_000);
        await tick(state, deps);
        world.nowMs += 60_000;
        await tick(state, deps);
        const row = world.journal.find(j => j.action_type === 'blocker_report');
        expect(row?.outcome).toBe('parked');
        expect(JSON.parse(row?.proposal_json ?? '{}').reason).toBe('paused');
      } finally {
        restore();
      }
    }
    // (c) RUNNING with flag 'false' -> no proposal at all.
    {
      const restore = withBlockerFlag('false');
      try {
        const world = makeWorld();
        seedDigestSent(world);
        const deps = makeDeps(world, { listThreads: async () => [blockedThread(13)] });
        const state = createTaskmasterState(60_000);
        await tick(state, deps);
        world.nowMs += 60_000;
        await tick(state, deps);
        expect(world.journal.some(j => j.action_type === 'blocker_report')).toBe(false);
        expect(
          world.sentMessages.some(m => m.idempotency_key.startsWith('tm:blocker_report:'))
        ).toBe(false);
      } finally {
        restore();
      }
    }
    // (d) unset follows the clock-enabled signal.
    expect(resolveBlockerReportEnabled(undefined, false)).toBe(false);
    expect(resolveBlockerReportEnabled(undefined, true)).toBe(true);
    expect(resolveBlockerReportEnabled('false', true)).toBe(false);
    expect(resolveBlockerReportEnabled('1', false)).toBe(true);
  });

  test('blocker_report: never graded useful or noise and never moves the floor', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    const nudgeRef = 'gh:thinmansoftware/bdc-xo#700';
    const blockerRef = 'gh:thinmansoftware/bdc-xo#701';
    const nudgeKey = `tm:nudge:${nudgeRef}:1`;
    const blockerKey = `tm:blocker_report:${blockerRef}:1`;
    const createdAt = new Date(T0 - 23 * HOUR).toISOString();
    const deadline = new Date(T0 - 1 * HOUR).toISOString();

    for (const [key, ref, type, recipient] of [
      [nudgeKey, nudgeRef, 'nudge', 'major-build'],
      [blockerKey, blockerRef, 'blocker_report', 'duty-officer'],
    ] as const) {
      world.journal.push({
        id: `seed-${type}`,
        created_at: createdAt,
        thread_ref: ref,
        action_type: type,
        proposal_json: '{}',
        idempotency_key: key,
        before_hash: null,
        proof_predicate: null,
        proof_deadline_at: deadline,
        outcome: 'sent',
        graded_at: null,
        grade: null,
      });
      world.sentMessages.push({
        idempotency_key: key,
        recipient,
        body: 'seeded',
        createdAt,
        acknowledged_at: new Date(T0 - 2 * HOUR).toISOString(),
      });
    }

    const deps = makeDeps(world, {
      // Both the nudge and the blocker_report rows refer to a now-closed issue.
      getGithubIssueEvidence: async () =>
        makeEvidence({ state: 'closed', closedAt: new Date(T0 - 2 * HOUR).toISOString() }),
      // Live principals: duty-officer is worker_poll (non-draining), so the
      // blocker_report's dispatch row counts as heard -- yet it must still never
      // be graded useful/noise.
      assessDispatchRecipient: (async (recipient: string) => ({
        ok: true,
        canonical_principal: recipient.trim().toLowerCase(),
        delivery_mode: 'worker_poll' as DispatchDeliveryMode,
        reason: null,
      })) as unknown as TaskmasterDeps['assessDispatchRecipient'],
    });

    await tick(createTaskmasterState(60_000), deps);

    const nudgeRow = world.journal.find(j => j.id === 'seed-nudge');
    const blockerRow = world.journal.find(j => j.id === 'seed-blocker_report');
    // The ordinary nudge is graded exactly as before (a closed issue -> useful).
    expect(nudgeRow?.grade).toBe('useful');
    // The blocker_report is NEVER graded useful or noise -> absent from the floor.
    expect(blockerRow?.grade).toBeNull();
  });

  test('blocker_report: other verbs are unchanged when the flag is on', async () => {
    const restoreFlag = withBlockerFlag('true');
    const priorFire = process.env.TASKMASTER_FIRE_VERB_ENABLED;
    process.env.TASKMASTER_FIRE_VERB_ENABLED = 'true';
    try {
      const world = makeWorld();
      seedDigestSent(world);
      const A = makeListedThread({
        ref: 'gh:thinmansoftware/bdc-harness#801',
        priority: 'P0',
        isUnclaimed: true,
        isUnclaimedP0: true,
        title: 'WO-FIRE-ELIGIBLE-801 outage',
        lastActivityAt: new Date(T0 - 3 * HOUR).toISOString(),
      });
      const B = makeListedThread({
        ref: 'gh:thinmansoftware/bdc-harness#802',
        priority: 'P0',
        isUnclaimed: true,
        isUnclaimedP0: true,
        title: 'WO-NONFIRE-802 stuck',
        lastActivityAt: new Date(T0 - 3 * HOUR).toISOString(),
      });
      const C = makeListedThread({
        ref: 'gh:thinmansoftware/bdc-harness#803',
        priority: 'P1',
        isUnclaimed: false,
        ownerLogin: 'major-build',
        title: 'WO-NUDGE-803 investigate',
        lastActivityAt: new Date(T0 - 3 * HOUR).toISOString(),
      });
      const gh = makeIssueCommentSink(world);
      const record = { cascadeId: 'cascade-801', status: 'running' } as unknown as Awaited<
        ReturnType<NonNullable<TaskmasterDeps['runCascade']>>
      >;
      const deps = makeDeps(world, {
        listThreads: async () =>
          Object.assign([A, B, C], { unlabelledPriorityTriage: [] as string[] }),
        escalationDelivery: gh.delivery,
        checkFireEligibility: async (title: string) =>
          title.includes('WO-FIRE-ELIGIBLE-801')
            ? {
                eligible: true,
                evidence: {
                  woId: 'WO-FIRE-ELIGIBLE-801',
                  targetRepo: 'thinmansoftware/bdc-harness',
                  project: 'bdc-harness',
                  specVerifiedAt: new Date(T0).toISOString(),
                  noOpenOrMergedPr: true,
                  expectedSpec: EXPECTED_SPEC,
                },
              }
            : { eligible: false, reason: 'not_eligible' },
        runCascade: (async options => {
          options.onAdmission?.(record, true);
          return record;
        }) as NonNullable<TaskmasterDeps['runCascade']>,
        getGithubIssueEvidence: async (ref: string) =>
          ref.includes('#803')
            ? makeEvidence({
                ownerLogin: 'major-build',
                latestMarkerKind: 'PROGRESS',
                latestMarkerText: 'rerun the failing export suite',
                updatedAt: new Date(T0 - 3 * HOUR).toISOString(),
                lastMovementAt: new Date(T0 - 3 * HOUR).toISOString(),
              })
            : null,
      });
      const state = createTaskmasterState(60_000);
      await tick(state, deps);
      world.nowMs += 60_000;
      await tick(state, deps);

      // fire_cauldron produced for A (and A gets NO blocker_report).
      expect(
        world.journal.some(j => j.action_type === 'fire_cauldron' && j.outcome === 'sent')
      ).toBe(true);
      expect(
        world.journal.some(j => j.action_type === 'blocker_report' && j.thread_ref === A.ref)
      ).toBe(false);

      // escalate_p0 for B delivered via the issue-comment path (not displaced).
      const escalateB = world.journal.find(
        j => j.action_type === 'escalate_p0' && j.thread_ref === B.ref
      );
      expect(escalateB?.outcome).toBe('sent');
      expect(escalateB?.grade).toBe('delivered_to_issue');
      expect(gh.posts()).toBeGreaterThanOrEqual(1);

      // nudge for C sent exactly as before.
      expect(world.sentMessages.some(m => m.idempotency_key.startsWith(`tm:nudge:${C.ref}:`))).toBe(
        true
      );

      // B additionally gets ONE blocker_report (deferred to a later tick by the
      // 1-effect-per-item rule), never in place of escalate_p0.
      const blockerB = world.sentMessages.filter(
        m => m.idempotency_key === `tm:blocker_report:${B.ref}:${Math.floor(T0 / (72 * HOUR))}`
      );
      expect(blockerB).toHaveLength(1);
      expect(blockerB[0]?.recipient).toBe('duty-officer');
    } finally {
      restoreFlag();
      if (priorFire === undefined) delete process.env.TASKMASTER_FIRE_VERB_ENABLED;
      else process.env.TASKMASTER_FIRE_VERB_ENABLED = priorFire;
    }
  });
});

describe('production repair-owner GitHub fetcher', () => {
  test('propagates read failures rather than hiding an unresolved PR', async () => {
    const fetcher = createGhLaneFetcher((async () => {
      throw new Error('github_transient_failure');
    }) as Parameters<typeof createGhLaneFetcher>[0]);
    let caught: unknown;
    try {
      await fetcher('thinmansoftware', 'bdc-harness', 1120);
    } catch (error) {
      caught = error;
    }
    expect((caught as Error)?.message).toBe('github_transient_failure');
  });

  test('a throwing fetcher for one citation does not throw the owner tick', async () => {
    const woId = 'WO-HARNESS-LOOP-ISO-01';
    const { db, sqlite } = makeLoopRegistryDb();
    sqlite.run(
      `INSERT INTO remote_agent_workflow_runs
         (id, workflow_name, status, started_at, completed_at, user_message)
       VALUES ('run-loop-iso', 'bdc-feature-development', 'completed', ?, ?, ?)`,
      ['2026-10-14T01:00:00Z', '2026-10-14T02:00:00Z', `WO_ID=${woId} --project bdc-xo`]
    );
    sqlite.run(
      `INSERT INTO remote_agent_workflow_events
         (id, workflow_run_id, event_type, step_index, step_name, data, created_at)
       VALUES ('evt-loop-iso', 'run-loop-iso', 'node_completed', 0, 'implement', ?, ?)`,
      [
        JSON.stringify({
          output: 'opened https://github.com/thinmansoftware/bdc-xo/pull/1120',
        }),
        '2026-10-14T01:00:00Z',
      ]
    );
    let fetches = 0;
    const fetcher = createGhLaneFetcher((async () => {
      fetches += 1;
      throw new Error('github_transient_failure');
    }) as Parameters<typeof createGhLaneFetcher>[0]);
    const exhausted: PrRepairQueuedMessage = {
      id: 'ex-loop',
      body: JSON.stringify({
        kind: 'overseer_remediation_exhausted',
        owner: 'thinmansoftware',
        repo: 'shopops',
        prNumber: 873,
        headSha: 'sha-exhausted',
        woId: 'WO-SHOPOPS-STRIPE-ORPHANED-INVOICE-ATTRIBUTION-01',
        reason: 'attempt_cap',
      }),
      sender: 'overseer',
      sender_principal_id: 'system:overseer',
      recipient: 'taskmaster',
      resolved_recipient: null,
      status: 'queued',
      addressed_at: null,
      addressed_by: null,
      route_disposition: null,
      acknowledged_at: null,
      acknowledged_by: null,
    };
    try {
      const result = await runPrRepairOwner({
        now: () => Date.parse('2026-10-14T12:00:00Z'),
        fetchPr: fetcher,
        canApplyEffect: async () => true,
        listWosWithMultipleLanePrs: opts => listWosWithMultipleLanePrs({ ...opts, db }),
        listLanePrsForWo: async () => [],
        listQueuedTaskmasterMessages: async () => [exhausted],
        acknowledgeRow: async () => undefined,
        addressRow: async () => undefined,
        closePr: async () => undefined,
        hasRunningRunForWo: async () => false,
        fireRepairCascade: async () => ({ cascadeId: 'unused', status: 'won' }),
      });
      expect(fetches).toBe(1);
      expect(result.digestItems).toEqual([
        'thinmansoftware/shopops#873 WO-SHOPOPS-STRIPE-ORPHANED-INVOICE-ATTRIBUTION-01 repair_owner_unresolved:attempt_cap',
      ]);
    } finally {
      sqlite.close();
    }
  });
});

describe('PR repair owner shared effect contracts', () => {
  function fixture(ids: string[]) {
    const world = makeWorld();
    const addressed = new Set<string>();
    const acknowledged: string[] = [];
    const queued = ids.map(
      (id, index): PrRepairQueuedMessage => ({
        id,
        body: JSON.stringify({
          kind: 'overseer_remediation_exhausted',
          owner: 'thinmansoftware',
          repo: 'bdc-harness',
          prNumber: index + 1,
          headSha: `head-${id}`,
          woId: `WO-REPAIR-NOTICE-${index + 10}`,
          reason: 'attempt_cap',
          buildLine: 'outside',
        }),
        sender: 'overseer',
        sender_principal_id: 'system:overseer',
        recipient: 'taskmaster',
        resolved_recipient: null,
        status: 'queued',
        addressed_at: null,
        addressed_by: null,
        route_disposition: null,
        acknowledged_at: null,
        acknowledged_by: null,
      })
    );
    const owner: PrRepairOwnerDeps = {
      now: () => world.nowMs,
      planEffects: true,
      fetchPr: async () => null,
      listWosWithMultipleLanePrs: async () => ({ groups: [], unresolved: [] }),
      listLanePrsForWo: async () => [],
      listQueuedTaskmasterMessages: async () => queued.filter(row => !addressed.has(row.id)),
      acknowledgeRow: async id => {
        acknowledged.push(id);
      },
      addressRow: async id => {
        addressed.add(id);
      },
      closePr: async () => {
        throw new Error('No closure planned');
      },
      hasRunningRunForWo: async () => false,
      listOwnerIssues: async () => [],
    };
    const stored = new Map<string, { id: string; body: string; status: string }>();
    const deps = makeDeps(world);
    // Actual owner and actual tick execute; only external effects are faked.
    Object.assign(deps, { prRepairOwnerDeps: owner });
    deps.createTask = (async (_context, data) => {
      const existing = stored.get(data.idempotency_key);
      if (existing) return existing;
      const message = { id: `stored-${stored.size + 1}`, body: data.body, status: 'queued' };
      stored.set(data.idempotency_key, message);
      world.sentMessages.push({
        idempotency_key: data.idempotency_key,
        recipient: data.recipient,
        body: data.body,
        createdAt: new Date(world.nowMs).toISOString(),
      });
      return message;
    }) as TaskmasterDeps['createTask'];
    return { world, owner, deps, queued, addressed, acknowledged, stored };
  }

  function duplicateGroup(h: ReturnType<typeof fixture>, count = 4) {
    const woId = 'WO-REPAIR-DEDUPE-01';
    const prs = Array.from({ length: count }, (_, index) => ({
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      prNumber: index + 1,
      headRef: `feat/repair-${index + 1}`,
      headSha: `sha-${index + 1}`,
      state: 'OPEN' as 'OPEN' | 'CLOSED',
      reviewDecision: 'CHANGES_REQUESTED',
      createdAt: new Date(T0 - 10_000 + index).toISOString(),
      runId: `run-${index + 1}`,
      workflowName: 'bdc-feature-development-codex',
    }));
    const closed: number[] = [];
    h.owner.listWosWithMultipleLanePrs = async () => ({
      groups:
        prs.filter(pr => pr.state === 'OPEN').length >= 2
          ? [{ woId, prs: prs.map(pr => ({ ...pr })) }]
          : [],
      unresolved: [],
    });
    h.owner.fetchPr = async (_owner, _repo, number) => {
      const pr = prs.find(pr => pr.prNumber === number);
      return pr
        ? {
            number,
            state: pr.state,
            reviewDecision: pr.reviewDecision,
            createdAt: pr.createdAt,
            headRefName: pr.headRef,
            headSha: pr.headSha,
            headRepoFullName: 'thinmansoftware/bdc-harness',
            baseRepoFullName: 'thinmansoftware/bdc-harness',
            title: woId,
            body: '',
          }
        : null;
    };
    h.owner.closePr = async ({ prNumber }) => {
      closed.push(prNumber);
      prs.find(pr => pr.prNumber === prNumber)!.state = 'CLOSED';
    };
    return { prs, closed };
  }

  test('three closes and an owner nudge share the last two tick slots and resume', async () => {
    const h = fixture(['owner-notice']);
    const { closed } = duplicateGroup(h);
    const nudges: string[] = [];
    h.owner.listOwnerIssues = async () => [
      {
        title: 'WO-REPAIR-NOTICE-10',
        state: 'open',
        labels: ['owner:major-build'],
        ownerLogin: null,
      },
    ];
    h.owner.createOwnerNudge = async input => {
      nudges.push(input.recipient);
      return { body: input.body };
    };
    h.deps.listUndeliveredRulings = async () =>
      Array.from({ length: 8 }, (_, i) =>
        ruling({ ref: `dispatch:ruling-${i}`, undeliveredRulingId: `ruling-${i}` })
      );
    h.deps.runCascade = (async () => {
      throw new Error('Repair must not fire a cascade');
    }) as TaskmasterDeps['runCascade'];
    const state = createTaskmasterState(60_000);
    const first = await tick(state, h.deps);
    expect(first.effects).toBe(10);
    expect(closed).toHaveLength(2);
    expect(nudges).toEqual([]);
    expect(
      h.world.journal.filter(row => row.action_type === 'pr_repair' && row.outcome === 'sent')
    ).toHaveLength(2);
    expect(
      h.world.journal.filter(row => row.action_type === 'pr_repair' && row.outcome === 'deferred')
    ).toHaveLength(2);
    h.world.nowMs += 60_000;
    const second = await tick(state, h.deps);
    expect(second.effects).toBe(3);
    expect(closed).toHaveLength(3);
    expect(nudges).toEqual(['major-build']);
    expect(
      h.world.journal.filter(row => row.action_type === 'pr_repair' && row.outcome === 'sent')
    ).toHaveLength(4);
  });

  test('paused dedupe closes and owner nudges are journaled parked without effects', async () => {
    const h = fixture(['owner-notice']);
    const { closed } = duplicateGroup(h);
    let nudges = 0;
    h.owner.listOwnerIssues = async () => [
      {
        title: 'WO-REPAIR-NOTICE-10',
        state: 'open',
        labels: ['owner:major-build'],
        ownerLogin: null,
      },
    ];
    h.owner.createOwnerNudge = async () => {
      nudges++;
      return {};
    };
    h.world.control = { ...h.world.control, pause_state: 'SOFT_PAUSE', pause_scope: 'effects' };
    const result = await tick(createTaskmasterState(60_000), h.deps);
    expect(result.parked).toBe(4);
    expect(closed).toEqual([]);
    expect(nudges).toBe(0);
    expect(
      h.world.journal.filter(row => row.action_type === 'pr_repair' && row.outcome === 'parked')
    ).toHaveLength(4);
    expect(h.addressed.size).toBe(0);
  });

  for (const failure of ['eligibility', 'fetch-error'] as const) {
    test(`apply-time ${failure} records the actual non-effect and preserves retry semantics`, async () => {
      const h = fixture([]);
      const { prs, closed } = duplicateGroup(h, 2);
      const fetch = h.owner.fetchPr;
      let failRead = false;
      h.owner.fetchPr = async (...args) => {
        if (failRead) throw new Error('synthetic GitHub read failure');
        return fetch(...args);
      };
      h.deps.listUndeliveredRulings = async () => [ruling()];
      const createTask = h.deps.createTask!;
      h.deps.createTask = (async (...args) => {
        if (args[1].idempotency_key.startsWith('tm:deliver_ruling:')) {
          if (failure === 'eligibility') prs[0].reviewDecision = 'APPROVED';
          else failRead = true;
        }
        return createTask(...args);
      }) as TaskmasterDeps['createTask'];
      const state = createTaskmasterState(60_000);
      const first = await tick(state, h.deps);
      expect(closed).toEqual([]);
      expect(first.effects).toBe(2); // ruling + ordinary digest, no close
      const repair = h.world.journal.find(row => row.action_type === 'pr_repair')!;
      expect(repair.outcome).toBe(failure === 'eligibility' ? 'expired' : 'failed');
      if (failure === 'eligibility')
        expect(JSON.parse(repair.proposal_json).suppressed).toBe('pr_eligibility_changed');
      else {
        failRead = false;
        h.world.nowMs += 60_000;
        await tick(state, h.deps);
        expect(closed).toEqual([1]);
        expect(repair.outcome).toBe('sent');
      }
    });
  }

  test('a prior admitted notice cannot bypass a newly paused repair-delivery gate', async () => {
    const h = fixture(['prior-admission']);
    const create = h.deps.createTask!;
    let failDigest = true;
    h.deps.createTask = (async (...args) => {
      if (failDigest) throw new Error('synthetic persistence failure');
      return create(...args);
    }) as TaskmasterDeps['createTask'];
    const state = createTaskmasterState(60_000);
    await tick(state, h.deps);
    expect(h.addressed.size).toBe(0);
    failDigest = false;
    h.world.control = {
      ...h.world.control,
      pause_state: 'SOFT_PAUSE',
      pause_scope: 'effects',
      epoch: 1,
    };
    h.world.nowMs += 60_000;
    await tick(state, h.deps);
    expect(h.world.sentMessages.at(-1)?.body).not.toContain('repair_owner_unresolved');
    expect(h.addressed.size).toBe(0);
  });

  test.each(['before_hash', 'thread_ref', 'action_type'] as const)(
    'a mismatched SENT %s is not admission evidence',
    async field => {
      const h = fixture(['bad-admission']);
      const create = h.deps.createTask!;
      let fail = true;
      h.deps.createTask = (async (...args) => {
        if (fail) throw new Error('synthetic persistence failure');
        return create(...args);
      }) as TaskmasterDeps['createTask'];
      const state = createTaskmasterState(60_000);
      await tick(state, h.deps);
      const row = h.world.journal.find(row => row.action_type === 'pr_repair')!;
      Object.assign(row, { [field]: 'mismatched' });
      fail = false;
      h.world.nowMs += 60_000;
      await tick(state, h.deps);
      expect(h.world.sentMessages.at(-1)?.body).not.toContain('repair_owner_unresolved');
      expect(h.addressed.size).toBe(0);
    }
  );

  test('a paused repair notice cannot ride the exempt ordinary digest', async () => {
    const h = fixture(['paused-notice']);
    h.world.control = { ...h.world.control, pause_state: 'SOFT_PAUSE', pause_scope: 'effects' };
    const result = await tick(createTaskmasterState(60_000), h.deps);
    expect(result.parked).toBeGreaterThanOrEqual(1);
    const digest = h.world.sentMessages.find(row => row.idempotency_key.startsWith('tm:digest:'));
    expect(digest).toBeDefined();
    expect(digest!.body).not.toContain('repair_owner_unresolved');
    expect(h.addressed.size).toBe(0);
    expect(h.acknowledged).toEqual([]);
  });

  test('repair item admission precedes actual daily digest rendering', async () => {
    const h = fixture(['admitted-notice']);
    const createTask = h.deps.createTask!;
    h.deps.createTask = (async (...args) => {
      if (args[1].idempotency_key.startsWith('tm:digest:')) {
        expect(
          h.world.journal.some(row => row.action_type === 'pr_repair' && row.outcome === 'sent')
        ).toBe(true);
        expect(args[1].body).toContain('repair_owner_unresolved');
      }
      return createTask(...args);
    }) as TaskmasterDeps['createTask'];
    const result = await tick(createTaskmasterState(60_000), h.deps);
    expect(result.effects).toBe(2);
    expect(h.addressed.has('admitted-notice')).toBe(true);
  });

  test('owner_effects_are_journaled_counted_and_budgeted', async () => {
    const h = fixture(Array.from({ length: 12 }, (_, i) => `notice-${i}`));
    const state = createTaskmasterState(60_000);
    const first = await tick(state, h.deps);
    expect(first.effects).toBe(MAX_EFFECTS_PER_TICK);
    expect(
      h.world.journal.filter(row => row.action_type === 'pr_repair' && row.outcome === 'sent')
    ).toHaveLength(10);
    expect(
      h.world.journal.filter(row => row.action_type === 'pr_repair' && row.outcome === 'deferred')
    ).toHaveLength(2);
    expect(h.addressed.size).toBe(0);
    h.world.nowMs += 60_000;
    const second = await tick(state, h.deps);
    expect(second.effects).toBe(3);
    expect(h.addressed.size).toBe(12);
    expect(h.world.journal.some(row => row.action_type === 'fire_cauldron')).toBe(false);
  });

  test('digest_retry_addresses_only_notices_in_the_persisted_body', async () => {
    const h = fixture(['N1', 'N2', 'N3']);
    const n3 = h.queued.pop()!;
    let failOnce = true;
    h.deps.db!.registerExpectation = async () => {
      if (failOnce) {
        failOnce = false;
        throw new Error('synthetic expectation failure after persistence');
      }
      return 'expectation';
    };
    const state = createTaskmasterState(60_000);
    await tick(state, h.deps);
    h.queued.push(n3);
    h.world.nowMs += 60_000;
    await tick(state, h.deps);
    expect(h.addressed.has('N1')).toBe(true);
    expect(h.addressed.has('N2')).toBe(true);
    expect(h.addressed.has('N3')).toBe(false);
    h.world.nowMs += 24 * 60 * 60_000;
    await tick(state, h.deps);
    expect(h.addressed.has('N3')).toBe(true);
  });

  test('rejected repair text never rides the ordinary digest', async () => {
    const h = fixture(['rejected-notice']);
    const data = JSON.parse(h.queued[0].body);
    h.queued[0].body = JSON.stringify({ ...data, woId: null, reason: 'deploy production' });
    // no_wo is canonicalized by the owner; use the validated PR slug to exercise content guard.
    h.queued[0].body = JSON.stringify({ ...data, owner: 'deploy production' });
    await tick(createTaskmasterState(60_000), h.deps);
    expect(h.addressed.size).toBe(0);
    expect(h.world.sentMessages.every(row => !row.body.includes('repair_owner_unresolved'))).toBe(
      true
    );
  });
});

function makeLoopRegistryDb(): { db: LanePrRegistryDb; sqlite: Database } {
  const sqlite = new Database(':memory:');
  sqlite.run(
    `CREATE TABLE remote_agent_workflow_runs (
       id TEXT PRIMARY KEY,
       workflow_name TEXT,
       status TEXT,
       started_at TEXT,
       completed_at TEXT,
       user_message TEXT
     )`
  );
  sqlite.run(
    `CREATE TABLE remote_agent_workflow_events (
       id TEXT PRIMARY KEY,
       workflow_run_id TEXT,
       event_type TEXT,
       step_index INTEGER,
       step_name TEXT,
       data TEXT,
       created_at TEXT
     )`
  );
  const db: LanePrRegistryDb = {
    async query<T>(sql: string, params: unknown[] = []): Promise<{ rows: T[]; rowCount: number }> {
      const translated = sql.replace(/\$\d+/g, '?');
      const rows = sqlite.query(translated).all(...(params as never[])) as T[];
      return { rows, rowCount: rows.length };
    },
  };
  return { db, sqlite };
}

test('production repair-owner effect gate reads fresh pause and captured epoch', async () => {
  let epoch = 5;
  let pause_state: 'RUNNING' | 'PAUSED' = 'RUNNING';
  let reads = 0;
  const deps = createRealPrRepairOwnerDeps(T0, 5, async () => {
    reads++;
    return { epoch, pause_state } as never;
  });
  expect(await deps.canApplyEffect()).toBe(true);
  pause_state = 'PAUSED';
  expect(await deps.canApplyEffect()).toBe(false);
  pause_state = 'RUNNING';
  epoch = 6;
  expect(await deps.canApplyEffect()).toBe(false);
  expect(reads).toBe(3);
});
