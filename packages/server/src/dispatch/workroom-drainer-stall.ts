import {
  createAuthenticatedMessage,
  type CreateAuthenticatedMessageData,
  type DispatchSenderContext,
} from '@archon/core/db/dispatch';
import { getDatabase } from '@archon/core/db/connection';
import { createLogger } from '@archon/paths';

const log = createLogger('dispatch/workroom-drainer-stall');
const PRINCIPAL = 'workroom-drainer';
const SENDER: DispatchSenderContext = { kind: 'system', sender: 'dispatch' };
const MINUTE_MS = 60_000;
const DEFAULT_HOURS = '07:00-22:00';
const DEFAULT_TZ = 'America/New_York';

export interface WorkroomDrainerStallState {
  startedAt: number;
  polls: Map<string, number>;
  sentKeys: Set<string>;
}

const state: WorkroomDrainerStallState = {
  startedAt: Date.now() - process.uptime() * 1000,
  polls: new Map(),
  sentKeys: new Set(),
};

export interface WorkroomDrainerStallDeps {
  readOldestUnackedMessage: () => Promise<{ id: string; created_at: string } | null>;
  createAuthenticatedMessage: (
    context: DispatchSenderContext,
    data: CreateAuthenticatedMessageData
  ) => Promise<unknown>;
  now?: () => Date;
  state?: WorkroomDrainerStallState;
  log?: { error: (bindings: Record<string, unknown>, message: string) => void };
}

/** Called only after an authenticated principal list has completed successfully. */
export function notePrincipalPoll(principalId: string, now: Date = new Date()): void {
  const at = now.getTime();
  if (principalId && Number.isFinite(at)) state.polls.set(principalId, at);
}

function positiveNumber(raw: string | undefined, fallback: number): number {
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(1, value) : fallback;
}

function workingHours(): { start: number; end: number; formatter: Intl.DateTimeFormat } {
  const pattern = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;
  const raw = process.env.WORKROOM_DRAINER_STALL_HOURS ?? DEFAULT_HOURS;
  let match = pattern.exec(raw);
  if (!match || (match[1] === match[3] && match[2] === match[4]))
    match = pattern.exec(DEFAULT_HOURS);
  // The default is a literal valid range; keep invalid config on the default schedule.
  const start = Number(match?.[1] ?? 7) * 60 + Number(match?.[2] ?? 0);
  const end = Number(match?.[3] ?? 22) * 60 + Number(match?.[4] ?? 0);
  const options = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } as const;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      ...options,
      timeZone: process.env.WORKROOM_DRAINER_STALL_TZ ?? DEFAULT_TZ,
    });
  } catch {
    formatter = new Intl.DateTimeFormat('en-US', { ...options, timeZone: DEFAULT_TZ });
  }
  return { start, end, formatter };
}

function messageTime(raw: string): number {
  // SQLite CURRENT_TIMESTAMP is UTC but has no suffix. Postgres and Dispatch writers use ISO.
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(raw)
    ? `${raw.replace(' ', 'T')}Z`
    : raw;
  const at = Date.parse(normalized);
  if (!Number.isFinite(at)) throw new Error('workroom_drainer_unacked_timestamp_invalid');
  return at;
}

export function createRealWorkroomDrainerStallDeps(): WorkroomDrainerStallDeps {
  return {
    createAuthenticatedMessage,
    readOldestUnackedMessage: async (): Promise<{ id: string; created_at: string } | null> => {
      // listMessages is priority ordered, page capped, and has no unacknowledged filter.
      // Query the actual oldest queued/unacked notice directly, without changing custody.
      const result = await getDatabase().query<{ id: string; created_at: string | Date }>(
        `SELECT id, created_at FROM agent_dispatch_messages
         WHERE recipient = $1 AND acknowledged_at IS NULL AND status = 'queued'
         ORDER BY created_at ASC LIMIT 1`,
        [PRINCIPAL]
      );
      const row = result.rows[0];
      return row
        ? {
            id: row.id,
            created_at:
              row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
          }
        : null;
    },
  };
}

/** The API poll is the heartbeat; queued/unacked age also catches a live but broken drainer. */
export async function runWorkroomDrainerStallCheck(deps: WorkroomDrainerStallDeps): Promise<void> {
  if (process.env.WORKROOM_DRAINER_STALL_ENABLED === 'false') return;
  try {
    const now = deps.now?.() ?? new Date();
    const nowMs = now.getTime();
    const hours = workingHours();
    const parts = hours.formatter.formatToParts(now);
    const localMinute =
      Number(parts.find(part => part.type === 'hour')?.value) * 60 +
      Number(parts.find(part => part.type === 'minute')?.value);
    const inHours =
      hours.start < hours.end
        ? localMinute >= hours.start && localMinute < hours.end
        : localMinute >= hours.start || localMinute < hours.end;
    if (!inHours) return;

    const current = deps.state ?? state;
    const threshold = positiveNumber(process.env.WORKROOM_DRAINER_STALL_MINUTES, 30);
    const repeatMs =
      positiveNumber(process.env.WORKROOM_DRAINER_STALL_REPEAT_HOURS, 4) * 60 * MINUTE_MS;
    const lastPollOrBoot = Math.max(
      current.startedAt,
      current.polls.get(PRINCIPAL) ?? current.startedAt
    );
    const elapsed = Math.max(0, nowMs - lastPollOrBoot);
    // A read failure must skip the whole tick, even when the poll clock is stale.
    const oldest = await deps.readOldestUnackedMessage();
    const oldestElapsed = oldest ? Math.max(0, nowMs - messageTime(oldest.created_at)) : null;
    const noPoll = elapsed > threshold * MINUTE_MS;
    const unacked = oldestElapsed !== null && oldestElapsed > threshold * MINUTE_MS;
    if (!noPoll && !unacked) return;
    const reason = noPoll && unacked ? 'both' : noPoll ? 'no_poll' : 'unacked_message_age';
    // A stuck message anchors both/b independently of fresh polls, avoiding repeated alerts
    // every time a polling drainer fails to acknowledge that same notice.
    const episode = unacked && oldest ? oldest.id : new Date(lastPollOrBoot).toISOString();
    const bucket = Math.floor((unacked ? (oldestElapsed ?? 0) : elapsed) / repeatMs);
    const key = `workroom-drainer-stall:${episode}:${bucket}`;
    if (current.sentKeys.has(key)) return;
    await deps.createAuthenticatedMessage(SENDER, {
      correlation_id: 'workroom-drainer-stall',
      idempotency_key: key,
      recipient: 'xo',
      task_type: 'agent_message',
      priority: 'normal',
      body: JSON.stringify({
        kind: 'workroom_drainer_stall',
        reason,
        minutes_since_last_poll: Math.floor(elapsed / MINUTE_MS),
        oldest_unacked_message_id: oldest?.id ?? null,
        oldest_unacked_age_minutes:
          oldestElapsed === null ? null : Math.floor(oldestElapsed / MINUTE_MS),
        threshold_minutes: threshold,
        text: 'Workroom order notices are not being delivered.',
        note: 'order notices are not being delivered; see docs/operations/workroom-drainer-stall.md',
      }),
    });
    current.sentKeys.add(key);
  } catch (error) {
    (deps.log ?? log).error({ err: error }, 'workroom_drainer_stall_check_failed');
  }
}

let timer: unknown = null;
let clearTimer: ((handle: unknown) => void) | null = null;
let inFlight = false;

export interface WorkroomDrainerStallTimerOptions {
  deps?: WorkroomDrainerStallDeps;
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
}

export function startWorkroomDrainerStallTimer(
  options: WorkroomDrainerStallTimerOptions = {}
): void {
  if (process.env.NODE_ENV === 'test' || timer !== null) return;
  const deps = options.deps ?? createRealWorkroomDrainerStallDeps();
  const set =
    options.setIntervalFn ?? ((fn: () => void, ms: number): unknown => setInterval(fn, ms));
  const handle = set(() => {
    if (inFlight) return;
    inFlight = true;
    void runWorkroomDrainerStallCheck(deps)
      .catch((error: unknown) => {
        log.error({ err: error }, 'workroom_drainer_stall_timer_failed');
      })
      .finally(() => {
        inFlight = false;
      });
  }, 60_000);
  (handle as { unref?: () => void })?.unref?.();
  timer = handle;
  clearTimer =
    options.clearIntervalFn ??
    ((value: unknown): void => {
      clearInterval(value as ReturnType<typeof setInterval>);
    });
}

export function stopWorkroomDrainerStallTimer(): void {
  if (timer !== null && clearTimer) clearTimer(timer);
  timer = null;
  clearTimer = null;
}
