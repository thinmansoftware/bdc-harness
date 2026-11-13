import { MAILBOX_SENDS_PER_HOUR, MAILBOX_SENDS_PER_UTC_DAY } from './constants';

const HOUR_MS = 3_600_000;

export interface SendLimitDecision {
  allowed: boolean;
  retryAtMs?: number;
}

export interface SendLimiter {
  tryAcquire: (slotId: string, nowMs: number) => SendLimitDecision;
}

interface SlotSendWindow {
  sentAtMs: number[];
  utcDay: string;
  dayCount: number;
}

function utcDayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function nextUtcMidnightMs(nowMs: number): number {
  const date = new Date(nowMs);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}

function hourRetryAtMs(sentAtMs: readonly number[]): number | undefined {
  const oldest = sentAtMs[0];
  if (oldest === undefined) {
    return undefined;
  }
  return oldest + HOUR_MS;
}

function blockedRetryAtMs(
  hourFull: boolean,
  dayFull: boolean,
  sentAtMs: readonly number[],
  nowMs: number
): number {
  const hourRetry = hourFull ? hourRetryAtMs(sentAtMs) : undefined;
  const dayRetry = dayFull ? nextUtcMidnightMs(nowMs) : undefined;
  if (hourRetry !== undefined && dayRetry !== undefined) {
    return Math.max(hourRetry, dayRetry);
  }
  if (hourRetry !== undefined) {
    return hourRetry;
  }
  if (dayRetry !== undefined) {
    return dayRetry;
  }
  return nowMs;
}

export function createSendLimiter(): SendLimiter {
  const slots = new Map<string, SlotSendWindow>();

  function tryAcquire(slotId: string, nowMs: number): SendLimitDecision {
    const day = utcDayKey(nowMs);
    let slotWindow = slots.get(slotId);
    if (slotWindow === undefined) {
      slotWindow = { sentAtMs: [], utcDay: day, dayCount: 0 };
      slots.set(slotId, slotWindow);
    }
    slotWindow.sentAtMs = slotWindow.sentAtMs.filter(ts => nowMs - ts < HOUR_MS);
    if (slotWindow.utcDay !== day) {
      slotWindow.utcDay = day;
      slotWindow.dayCount = 0;
    }
    const hourFull = slotWindow.sentAtMs.length >= MAILBOX_SENDS_PER_HOUR;
    const dayFull = slotWindow.dayCount >= MAILBOX_SENDS_PER_UTC_DAY;
    if (hourFull || dayFull) {
      return {
        allowed: false,
        retryAtMs: blockedRetryAtMs(hourFull, dayFull, slotWindow.sentAtMs, nowMs),
      };
    }
    slotWindow.sentAtMs.push(nowMs);
    slotWindow.dayCount += 1;
    return { allowed: true };
  }

  return { tryAcquire };
}

// Counts live only in process memory. A restart starts every slot at zero.
// Restarts are operator-only. That reset is the stated limit.
export const processSendLimiter: SendLimiter = createSendLimiter();
