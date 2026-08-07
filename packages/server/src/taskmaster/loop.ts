/**
 * Taskmaster Slice 1 -- the always-on loop (WO-HARNESS-TASKMASTER-SLICE1-01, M-133).
 *
 * `tick()` is the pure-ish decision engine: every side effect is injected via
 * TickContext so the five Section 11 scenarios are deterministic and unit-testable.
 * `startTaskmaster()` clones the provider-wait scheduler skeleton
 * (api.ts:2909-2945) exactly -- NODE_ENV gate, module-scope timer singleton,
 * ownerId, integer-validated env interval, inFlight guard, try/catch/finally,
 * setInterval + unref, immediate void tick().
 *
 * Row-first discipline: recordAction writes the journal row BEFORE any send, and
 * idempotency keys are deterministic (ref + epoch + day-bucket, no random) so a
 * restart cannot double-send -- the journal row and the dispatch idempotency_key
 * both dedupe.
 */
import { randomUUID } from 'crypto';
import { createLogger } from '@archon/paths';
import {
  countInterventionsSince,
  createMessage,
  getPauseState,
  recordAction,
  recordUsageSample,
  updateActionOutcome,
  listMessages,
  type TaskmasterPauseState,
} from '@archon/core/db';
import { currentHeadroom, type Headroom } from './ledger';
import { recordTickHeartbeat } from './deadman';
import { validate as guardValidate } from './guard';
import { computeNextAction, type TaskmasterProposal, type TaskmasterThread } from './rules';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export const MAX_EFFECTS_PER_TICK = 10;
export const MAX_INTERVENTIONS_PER_24H = 3;

function getLog(): ReturnType<typeof createLogger> {
  return createLogger('taskmaster');
}

/** Two-tick eligibility memory: how many consecutive ticks a thread has qualified. */
interface EligibilityEntry {
  count: number;
  epoch: number;
}

export interface TickContext {
  now: number;
  readPause: () => Promise<{ pause_state: TaskmasterPauseState; epoch: number }>;
  readThreads: () => Promise<TaskmasterThread[]>;
  currentHeadroom: () => Promise<Headroom>;
  recordAction: (input: {
    thread_ref: string;
    action_type: TaskmasterProposal['actionType'];
    proposal_json: string;
    idempotency_key: string;
    outcome?: string;
    proof_predicate?: string | null;
    proof_deadline_at?: string | null;
  }) => Promise<{ id: string; outcome: string }>;
  updateActionOutcome: (id: string, outcome: string, grade?: string | null) => Promise<void>;
  countInterventionsSince: (threadRef: string, sinceIso: string) => Promise<number>;
  sendMessage: (proposal: TaskmasterProposal) => Promise<{ id: string }>;
  validate: (proposal: TaskmasterProposal) => { allowed: boolean; reason?: string };
  recordHeartbeat: (now: number) => void;
  /** Persisted between ticks (module-scope in production; injected in tests). */
  eligibility: Map<string, EligibilityEntry>;
  maxEffectsPerTick?: number;
  maxInterventionsPer24h?: number;
}

export interface TickResult {
  sent: number;
  parked: number;
  deferred: number;
  rejected: number;
  noop: number;
  headroom: Headroom['state'];
}

/**
 * One decision pass. Enforces, in order: two-tick eligibility (except
 * act-immediately proposals), 1-effect-per-item-per-tick, max-effects-per-tick
 * (remainder journalled as deferred, never dropped), the outbound guard, the
 * per-item 24h intervention budget, row-first journaling, pause (sends blocked
 * except P0 escalation), and a pre-effect epoch re-check (resume expires stale
 * proposals rather than replaying them).
 */
export async function tick(ctx: TickContext): Promise<TickResult> {
  const pause = await ctx.readPause();
  const epoch = pause.epoch;
  const maxEffects = ctx.maxEffectsPerTick ?? MAX_EFFECTS_PER_TICK;
  const maxPer24h = ctx.maxInterventionsPer24h ?? MAX_INTERVENTIONS_PER_24H;
  const since24h = new Date(ctx.now - DAY).toISOString();

  const headroom = await ctx.currentHeadroom();

  const threads = await ctx.readThreads();
  const touchedThisTick = new Set<string>();
  const result: TickResult = {
    sent: 0,
    parked: 0,
    deferred: 0,
    rejected: 0,
    noop: 0,
    headroom: headroom.state,
  };

  for (const thread of threads) {
    const proposal = computeNextAction(thread, ctx.now, epoch);
    if (!proposal) {
      ctx.eligibility.delete(thread.ref);
      result.noop++;
      continue;
    }

    // Two-consecutive-tick eligibility, EXCEPT undelivered rulings + unclaimed P0s.
    if (!proposal.actImmediately) {
      const prev = ctx.eligibility.get(thread.ref);
      const count = prev?.epoch === epoch ? prev.count + 1 : 1;
      ctx.eligibility.set(thread.ref, { count, epoch });
      if (count < 2) continue; // wait for the confirming tick
    } else {
      ctx.eligibility.delete(thread.ref);
    }

    // Budget: at most one effect per item per tick.
    if (touchedThisTick.has(thread.ref)) continue;

    // Budget: max effects per tick. Remainder is journalled deferred, not dropped.
    if (result.sent + result.parked >= maxEffects) {
      await ctx.recordAction({
        thread_ref: proposal.threadRef,
        action_type: proposal.actionType,
        proposal_json: JSON.stringify(proposal),
        idempotency_key: proposal.idempotencyKey,
        outcome: 'deferred',
      });
      result.deferred++;
      touchedThisTick.add(thread.ref);
      continue;
    }

    // Outbound guard (effect allowlist + content guard). Rejection = journal only.
    const guard = ctx.validate(proposal);
    if (!guard.allowed) {
      await ctx.recordAction({
        thread_ref: proposal.threadRef,
        action_type: proposal.actionType,
        proposal_json: JSON.stringify({ proposal, reason: guard.reason }),
        idempotency_key: proposal.idempotencyKey,
        outcome: 'rejected',
      });
      result.rejected++;
      touchedThisTick.add(thread.ref);
      continue;
    }

    // Per-item 24h intervention budget (max 3 SENT per item per 24h).
    const priorSent = await ctx.countInterventionsSince(proposal.threadRef, since24h);
    if (priorSent >= maxPer24h) {
      await ctx.recordAction({
        thread_ref: proposal.threadRef,
        action_type: proposal.actionType,
        proposal_json: JSON.stringify(proposal),
        idempotency_key: proposal.idempotencyKey,
        outcome: 'deferred',
      });
      result.deferred++;
      touchedThisTick.add(thread.ref);
      continue;
    }

    // ROW FIRST -- always journal before the effect. Idempotent on the key: a
    // restart returns the existing row, and a previously-sent row short-circuits.
    const row = await ctx.recordAction({
      thread_ref: proposal.threadRef,
      action_type: proposal.actionType,
      proposal_json: JSON.stringify(proposal),
      idempotency_key: proposal.idempotencyKey,
      outcome: 'proposed',
      proof_predicate: `delivered:${proposal.idempotencyKey}`,
      proof_deadline_at: new Date(ctx.now + 48 * HOUR).toISOString(),
    });
    if (row.outcome === 'sent') {
      // Reconciliation: this action already actuated in a prior run. No re-send.
      touchedThisTick.add(thread.ref);
      continue;
    }

    // Pause: sends are blocked EXCEPT P0 escalation. Monitoring + escalation stay alive.
    const sendsBlocked = pause.pause_state !== 'RUNNING';
    const isP0Escalation = proposal.actionType === 'escalate' && proposal.priority === 'P0';
    if (sendsBlocked && !isP0Escalation) {
      await ctx.updateActionOutcome(row.id, 'parked');
      result.parked++;
      touchedThisTick.add(thread.ref);
      continue;
    }

    // Re-check the pause epoch immediately before the effect: if a resume bumped
    // the epoch since tick start, this proposal is stale -> expire, do not send.
    const fresh = await ctx.readPause();
    if (fresh.epoch !== epoch) {
      await ctx.updateActionOutcome(row.id, 'expired');
      touchedThisTick.add(thread.ref);
      continue;
    }

    await ctx.sendMessage(proposal);
    await ctx.updateActionOutcome(row.id, 'sent', 'useful');
    result.sent++;
    touchedThisTick.add(thread.ref);
  }

  ctx.recordHeartbeat(ctx.now);
  return result;
}

// ---------------------------------------------------------------------------
// Production wiring
// ---------------------------------------------------------------------------

let taskmasterTimer: ReturnType<typeof setInterval> | undefined;
const productionEligibility = new Map<string, EligibilityEntry>();

/**
 * Build the current stalled-thread set for real wiring. Slice 1 sources threads
 * from the dispatch mailbox (the sanctioned SOR path): queued-but-unaddressed
 * ratified rulings become deliver_ruling threads. The GitHub-issue SOR reader
 * (nudge/escalate of wo/arc-labelled issues) is a follow-up -- no issue-LISTING
 * client exists in-repo today (only webhook receipt + work-order freeze), and
 * inventing one is out of Slice 1 scope. See manifest.
 */
async function buildThreadsFromMailbox(now: number): Promise<TaskmasterThread[]> {
  const queued = await listMessages({ status: 'queued', limit: 200 });
  const threads: TaskmasterThread[] = [];
  for (const msg of queued) {
    const isRuling = Boolean(msg.motion_id);
    if (!isRuling) continue;
    const createdMs = Date.parse(msg.created_at);
    threads.push({
      ref: `ruling/${msg.motion_id}`,
      priority: msg.priority === 'blocker' ? 'P0' : 'P1',
      lastActivityAt: Number.isNaN(createdMs) ? now : createdMs,
      claimed: false,
      undeliveredRuling: true,
      recipient: msg.recipient,
      subject: msg.motion_id ?? msg.id,
    });
  }
  return threads;
}

/** Real sender: routes a Taskmaster proposal through the dispatch DAL. */
async function sendViaDispatch(proposal: TaskmasterProposal): Promise<{ id: string }> {
  const message = await createMessage({
    correlation_id: `taskmaster:${proposal.threadRef}`,
    idempotency_key: proposal.idempotencyKey,
    task_type: 'agent_message',
    sender: 'taskmaster',
    recipient: proposal.recipient,
    body: proposal.body,
    priority: proposal.priority === 'P0' ? 'blocker' : 'normal',
  });
  return { id: message.id };
}

/** Real headroom readers -- fail-closed to UNKNOWN, never zero-as-capacity. */
function buildLedgerHeadroom(): () => Promise<Headroom> {
  return () =>
    currentHeadroom({
      readLocalArtifacts: async () => {
        // Absent a wired local-artifact meter, the read is UNKNOWN by throwing --
        // NOT a fabricated numeric-zero. This is the correct fail-closed posture.
        throw new Error('local_artifact_meter_unwired');
      },
      sampleCliAnchor: async () => {
        throw new Error('cli_anchor_unwired');
      },
      recordUsageSample: async input => {
        await recordUsageSample(input);
      },
    });
}

/**
 * Start the always-on Taskmaster loop. Clones the provider-wait scheduler pattern.
 * Interval is TASKMASTER_INTERVAL_MS (default 60000); an explicit value of 0 means
 * KILLED (loop never starts).
 */
export function startTaskmaster(): void {
  if (process.env.NODE_ENV === 'test' || taskmasterTimer !== undefined) return;

  const raw = process.env.TASKMASTER_INTERVAL_MS;
  const parsed = Number.parseInt(raw ?? '', 10);
  if (raw !== undefined && parsed === 0) {
    getLog().info('taskmaster.killed_interval_zero');
    return; // KILLED
  }
  const intervalMs = Number.isInteger(parsed) && parsed > 0 ? parsed : 60_000;

  const ownerId = `taskmaster:${randomUUID()}`;
  let inFlight = false;

  const runTick = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      const now = Date.now();
      const result = await tick({
        now,
        readPause: async () => {
          const state = await getPauseState();
          return { pause_state: state.pause_state, epoch: state.epoch };
        },
        readThreads: () => buildThreadsFromMailbox(now),
        currentHeadroom: buildLedgerHeadroom(),
        recordAction: async input => {
          const created = await recordAction({
            thread_ref: input.thread_ref,
            action_type: input.action_type,
            proposal_json: input.proposal_json,
            idempotency_key: input.idempotency_key,
            outcome: (input.outcome ?? 'proposed') as 'proposed',
            proof_predicate: input.proof_predicate ?? null,
            proof_deadline_at: input.proof_deadline_at ?? null,
          });
          return { id: created.id, outcome: created.outcome };
        },
        updateActionOutcome: (id, outcome, grade) =>
          updateActionOutcome(id, outcome as 'sent', grade ?? null),
        countInterventionsSince,
        sendMessage: sendViaDispatch,
        validate: guardValidate,
        recordHeartbeat: recordTickHeartbeat,
        eligibility: productionEligibility,
      });
      if (result.sent > 0 || result.parked > 0 || result.deferred > 0) {
        getLog().info({ ...result, ownerId }, 'taskmaster.tick');
      }
    } catch (error) {
      getLog().error({ err: error as Error, ownerId }, 'taskmaster.tick_failed');
    } finally {
      inFlight = false;
    }
  };

  taskmasterTimer = setInterval(() => void runTick(), intervalMs);
  taskmasterTimer.unref?.();
  void runTick();
  getLog().info({ intervalMs, ownerId }, 'taskmaster.started');
}
