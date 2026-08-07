import { randomUUID } from 'crypto';
import { getDatabase } from '@archon/core/db/connection';
import { reconcileDispatchOutcomeNotices as reconcileNotices } from '@archon/core/db/dispatch';
import { sendSmsEscalation, sendTelegramEscalation, type DispatchEscalationNotifierConfig } from './notifiers';

interface EscalationRow {
  id: string; correlation_id: string; sender: string; recipient: string; body: string;
  created_at: string;
  subject_key: string | null; acknowledged_at: string | null;
  escalated_tg_at: string | null; escalated_sms_at: string | null;
}

export const reconcileDispatchOutcomeNotices = reconcileNotices;

export async function ensureXoEscalationHandoff(message: EscalationRow): Promise<void> {
  const now = new Date().toISOString();
  await getDatabase().query(
    `INSERT INTO agent_dispatch_messages
     (id, correlation_id, idempotency_key, task_type, sender, recipient, body, status, created_at, priority, fencing_token, subject_key)
     VALUES ($1,$2,$3,'agent_message','dispatch','xo',$4,'queued',$5,'blocker',0,$6)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [randomUUID(), message.correlation_id, `escalation-handoff:${message.id}`,
      `Dispatch escalation for ${message.id}: ${message.body}`, now, message.subject_key]
  );
}

/** Fire-once escalation clock; database compare-and-set claims each delivery channel. */
export async function runDispatchEscalationClock(config: DispatchEscalationNotifierConfig & {
  telegramAfterMs?: number; smsAfterMs?: number; now?: Date;
}): Promise<number> {
  const now = config.now ?? new Date();
  const oldest = new Date(now.getTime() - Math.min(config.telegramAfterMs ?? 300_000, config.smsAfterMs ?? 900_000)).toISOString();
  const due = await getDatabase().query<EscalationRow>(
    `SELECT * FROM agent_dispatch_messages WHERE status IN ('queued','claimed')
     AND priority = 'blocker' AND acknowledged_at IS NULL AND created_at <= $1`, [oldest]
  );
  let delivered = 0;
  for (const message of due.rows) {
    await ensureXoEscalationHandoff(message);
    const age = now.getTime() - new Date(message.created_at).getTime();
    for (const channel of ['tg', 'sms'] as const) {
      const threshold = channel === 'tg' ? config.telegramAfterMs ?? 300_000 : config.smsAfterMs ?? 900_000;
      if (age < threshold) continue;
      const claimed = await getDatabase().query(
        `UPDATE agent_dispatch_messages SET escalated_${channel}_at = $2
         WHERE id = $1 AND escalated_${channel}_at IS NULL AND acknowledged_at IS NULL`,
        [message.id, now.toISOString()]
      );
      if (claimed.rowCount !== 1) continue;
      const payload = { dispatch_message_id: message.id, body: message.body, subject_key: message.subject_key };
      try {
        const sent = channel === 'tg'
          ? await sendTelegramEscalation(payload, config)
          : await sendSmsEscalation(payload, config);
        if (sent) delivered++;
        else await getDatabase().query(
          `UPDATE agent_dispatch_messages SET escalated_${channel}_at = NULL WHERE id = $1 AND escalated_${channel}_at = $2`,
          [message.id, now.toISOString()]
        );
      } catch (error) {
        await getDatabase().query(
          `UPDATE agent_dispatch_messages SET escalated_${channel}_at = NULL WHERE id = $1 AND escalated_${channel}_at = $2`,
          [message.id, now.toISOString()]
        );
        throw error;
      }
    }
  }
  return delivered;
}
