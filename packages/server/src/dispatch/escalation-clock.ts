import { createLogger } from '@archon/paths';
import { reconcileDispatchOutcomeNotices } from '@archon/core/db/dispatch';

const log = createLogger('dispatch/escalation-clock');
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

export async function tickDispatchEscalationClock(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const activatedAt = process.env.DISPATCH_PHASE1_ACTIVATED_AT;
    if (activatedAt) await reconcileDispatchOutcomeNotices(activatedAt);
    // John-facing legs are deliberately dark unless both doors are explicit.
    if (process.env.DISPATCH_SENDER_AUTH_MODE !== 'enforce') return;
  } catch (error) {
    log.error({ err: error instanceof Error ? error : new Error(String(error)) }, 'dispatch_escalation_tick_failed');
  } finally { inFlight = false; }
}

export function startDispatchEscalationClock(): void {
  if (timer || process.env.NODE_ENV === 'test') return;
  void tickDispatchEscalationClock();
  const interval = Math.max(1_000, Number(process.env.DISPATCH_ESCALATION_INTERVAL_MS) || 60_000);
  timer = setInterval(() => void tickDispatchEscalationClock(), interval);
  timer.unref?.();
}

export function stopDispatchEscalationClock(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
