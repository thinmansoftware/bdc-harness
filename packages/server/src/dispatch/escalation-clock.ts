import { createLogger } from '@archon/paths';
import {
  claimDispatchEscalation,
  ensureXoEscalationHandoffs,
  listEligibleXoEscalations,
  reconcileDispatchOutcomeNotices,
  releaseDispatchEscalationClaim,
  type DispatchEscalationLeg,
} from '@archon/core/db/dispatch';
import { sendSmsEscalation, sendTelegramEscalation } from './notifiers';

const log = createLogger('dispatch/escalation-clock');
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

export interface DispatchEscalationClockDependencies {
  now?: () => Date;
  telegram?: (messageId: string) => Promise<void>;
  sms?: (messageId: string) => Promise<void>;
}

export async function tickDispatchEscalationClock(
  dependencies: DispatchEscalationClockDependencies = {}
): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const activatedAt = process.env.DISPATCH_PHASE1_ACTIVATED_AT;
    if (!activatedAt || !Number.isFinite(Date.parse(activatedAt))) return;
    await reconcileDispatchOutcomeNotices(activatedAt);
    await ensureXoEscalationHandoffs(activatedAt);
    if (process.env.DISPATCH_SENDER_AUTH_MODE !== 'enforce') return;
    const now = (dependencies.now ?? (() => new Date()))().toISOString();
    const candidates = await listEligibleXoEscalations(activatedAt);
    const legs: Array<[DispatchEscalationLeg, boolean, (id: string) => Promise<void>]> = [
      [
        'telegram',
        process.env.DISPATCH_TELEGRAM_ENABLED === 'true',
        dependencies.telegram ?? sendTelegramEscalation,
      ],
      ['sms', process.env.DISPATCH_SMS_ENABLED === 'true', dependencies.sms ?? sendSmsEscalation],
    ];
    for (const candidate of candidates)
      for (const [leg, enabled, notify] of legs) {
        if (!enabled) continue;
        const claimed = await claimDispatchEscalation({ id: candidate.id, leg, now });
        if (!claimed) continue;
        try {
          await notify(claimed.id);
        } catch (error) {
          await releaseDispatchEscalationClaim({ id: claimed.id, leg, claimed_at: now });
          log.error(
            {
              messageId: claimed.id,
              leg,
              err: error instanceof Error ? error : new Error(String(error)),
            },
            'dispatch_escalation_delivery_failed'
          );
        }
      }
  } catch (error) {
    log.error(
      { err: error instanceof Error ? error : new Error(String(error)) },
      'dispatch_escalation_tick_failed'
    );
  } finally {
    inFlight = false;
  }
}

export function startDispatchEscalationClock(
  dependencies: DispatchEscalationClockDependencies = {}
): void {
  if (timer || process.env.NODE_ENV === 'test') return;
  void tickDispatchEscalationClock(dependencies);
  const interval = Math.max(1_000, Number(process.env.DISPATCH_ESCALATION_INTERVAL_MS) || 60_000);
  timer = setInterval(() => void tickDispatchEscalationClock(dependencies), interval);
  timer.unref?.();
}

export function stopDispatchEscalationClock(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
