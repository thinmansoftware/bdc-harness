import { getDatabase } from '@archon/core';
import { createAuthenticatedMessage, cancelMessage } from '@archon/core/db/dispatch';
import * as tm from '@archon/core/db/taskmaster';
import { approvalPass, ApprovalContentRejection, type ApprovalState } from './approval-stalls';
import { validateProposal, validateForbiddenActionContent } from './guard';

/** Dispatch remains the sole transport; runtime approval APIs are never called. */
export async function checkApprovalStalls(now: Date): Promise<void> {
  const db = getDatabase();
  const control = await tm.getPauseState();
  if (control.pause_state !== 'RUNNING') return;
  const producer = process.env.TASKMASTER_APPROVAL_PRODUCER_PRINCIPAL?.trim();
  if (!producer) return;
  const inbox = await db.query<{ body: string }>(
    "SELECT body FROM agent_dispatch_messages WHERE recipient = 'taskmaster' AND sender_principal_id = $1 AND status = 'queued' ORDER BY created_at ASC",
    [producer]
  );
  const messages: unknown[] = [];
  for (const row of inbox.rows) {
    try {
      messages.push(JSON.parse(row.body));
    } catch {
      /* Unrelated messages stay untouched. */
    }
  }
  await approvalPass(messages, now, {
    read: async () => {
      const rows = await db.query<{ proposal_json: string }>(
        "SELECT proposal_json FROM tm_journal WHERE idempotency_key LIKE 'tm:pending_approval:%'"
      );
      return rows.rows.map(row => JSON.parse(row.proposal_json) as ApprovalState);
    },
    save: async state => {
      const row = await tm.recordAction({
        thread_ref: state.thread_id,
        action_type: 'nudge',
        proposal_json: JSON.stringify(state),
        idempotency_key: `tm:pending_approval:${state.request_id}`,
        outcome: 'pending',
      });
      await tm.updateActionOutcome(
        row.id,
        state.resolved ? 'expired' : state.guard_rejected ? 'rejected' : 'pending',
        JSON.stringify(state)
      );
    },
    send: async (recipient, body, key) => {
      const fresh = await tm.getPauseState();
      if (fresh.pause_state !== 'RUNNING' || fresh.epoch !== control.epoch)
        throw new Error('approval_stall_pause_changed');
      const contentGuard = validateForbiddenActionContent(body);
      if (!contentGuard.allowed) throw new ApprovalContentRejection(contentGuard.reason);
      if (recipient === 't3-desk-local') {
        const result = validateProposal({
          type: 'nudge',
          recipient,
          body,
          threadRef: 'pending_approval',
          idempotencyKey: key,
          actsImmediately: true,
        });
        if (!result.allowed) throw new ApprovalContentRejection(result.reason);
      }
      const sent = await createAuthenticatedMessage(
        { kind: 'system', sender: 'taskmaster' },
        { recipient, body, idempotency_key: key, correlation_id: key, task_type: 'agent_message' }
      );
      return sent.id;
    },
    expect: async (state, id) => {
      await tm.registerExpectation({
        dispatch_ref: id,
        recipient: 't3-desk-local',
        registration_key: `tm:approval-resolution:${state.request_id}`,
        registered_by: 'taskmaster',
        evidence_json: JSON.stringify({
          kind: 'db_row_exists',
          table: 'tm_journal',
          where: { idempotency_key: `tm:pending_approval:${state.request_id}`, outcome: 'expired' },
        }),
        due_at: new Date(now.getTime() + 15 * 60000).toISOString(),
        on_absence: 'give_up',
        max_retries: 0,
      });
    },
    close: async requestId => {
      const queued = await db.query<{ id: string }>(
        "SELECT id FROM agent_dispatch_messages WHERE sender = 'taskmaster' AND idempotency_key = $1 AND status IN ('queued', 'claimed')",
        [`tm:blocker_report:pending_approval:${requestId}`]
      );
      for (const row of queued.rows) await cancelMessage({ id: row.id, sender: 'taskmaster' });
      const rows = await db.query<{ id: string }>(
        'SELECT id FROM tm_expectations WHERE registration_key = $1',
        [`tm:approval-resolution:${requestId}`]
      );
      for (const row of rows.rows)
        await tm.markMet(row.id, `pending_approval:resolved:${requestId}`);
    },
  });
}
