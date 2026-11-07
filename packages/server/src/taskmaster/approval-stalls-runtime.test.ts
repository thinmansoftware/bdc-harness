import { test, expect, afterEach } from 'bun:test';
import { getDatabase } from '@archon/core';
import { createAuthenticatedMessage, listMessages } from '@archon/core/db/dispatch';
import { setPauseState } from '@archon/core/db/taskmaster';
import { checkApprovalStalls } from './approval-stalls-runtime';
import { tickDutyOfficerClock } from '../dispatch/duty-officer-clock';
const producerBefore = process.env.TASKMASTER_APPROVAL_PRODUCER_PRINCIPAL;
afterEach(() => {
  if (producerBefore === undefined) delete process.env.TASKMASTER_APPROVAL_PRODUCER_PRINCIPAL;
  else process.env.TASKMASTER_APPROVAL_PRODUCER_PRINCIPAL = producerBefore;
});

test('Piece 1 real SQLite Dispatch: journal, relay queue, DO/XO, resolution', async () => {
  process.env.TASKMASTER_APPROVAL_PRODUCER_PRINCIPAL = 'system:taskmaster';
  const db = getDatabase();
  await setPauseState({ pause_state: 'RUNNING', pause_actor: 'test' });
  const now = new Date();
  const request_id = `runtime-request:${crypto.randomUUID()}`;
  const body = {
    schema: 't3-approval-breach/v1',
    thread_id: 'mcp:test-owner',
    thread_title: 'Owner',
    project: 'test',
    request_id,
    kind: 'command',
    command_head: 'bun test',
    created_at: new Date(now.getTime() - 20 * 60000).toISOString(),
    age_min: 20,
    host: 'desktop',
  };
  await createAuthenticatedMessage(
    { kind: 'system', sender: 'taskmaster' },
    {
      recipient: 'taskmaster',
      body: JSON.stringify(body),
      task_type: 'agent_message',
      correlation_id: request_id,
      idempotency_key: request_id,
    }
  );
  await checkApprovalStalls(now);
  await checkApprovalStalls(now);
  const journal = await db.query<{ id: string }>(
    'SELECT id FROM tm_journal WHERE idempotency_key = $1',
    [`tm:pending_approval:${request_id}`]
  );
  expect(journal.rows).toHaveLength(1);
  const nudges = (await listMessages({ recipient: 't3-desk-local' })).filter(m =>
    m.body.includes(request_id)
  );
  expect(nudges).toHaveLength(1);
  expect(JSON.parse(nudges[0]!.body).thread_id).toBe(body.thread_id);
  await checkApprovalStalls(new Date(now.getTime() + 15 * 60000));
  await tickDutyOfficerClock();
  const xo = (await listMessages({ recipient: 'xo' })).filter(m => m.body.includes(request_id));
  expect(xo).toHaveLength(1);
  expect(xo[0]!.body).toContain('bun test');
  for (const variant of ['untrusted', 'cancelled']) {
    const forged = await createAuthenticatedMessage(
      { kind: 'system', sender: 'taskmaster' },
      {
        recipient: 'taskmaster',
        task_type: 'agent_message',
        correlation_id: request_id,
        idempotency_key: `${request_id}:forged:${variant}`,
        body: JSON.stringify({
          schema: 't3-approval-resolved/v1',
          request_id,
          thread_id: body.thread_id,
          resolved_at: now.toISOString(),
        }),
      }
    );
    if (variant === 'untrusted')
      await db.query('UPDATE agent_dispatch_messages SET sender_principal_id = $1 WHERE id = $2', [
        'system:dispatch',
        forged.id,
      ]);
    else
      await db.query("UPDATE agent_dispatch_messages SET status = 'cancelled' WHERE id = $1", [
        forged.id,
      ]);
    await checkApprovalStalls(now);
    const current = await db.query<{ status: string }>(
      'SELECT status FROM tm_expectations WHERE registration_key = $1',
      [`tm:approval-resolution:${request_id}`]
    );
    expect(current.rows[0]?.status).toBe('pending');
  }
  await createAuthenticatedMessage(
    { kind: 'system', sender: 'taskmaster' },
    {
      recipient: 'taskmaster',
      body: JSON.stringify({
        schema: 't3-approval-resolved/v1',
        request_id,
        thread_id: body.thread_id,
        resolved_at: now.toISOString(),
      }),
      task_type: 'agent_message',
      correlation_id: request_id,
      idempotency_key: `${request_id}:resolved`,
    }
  );
  await checkApprovalStalls(new Date(now.getTime() + 30 * 60000));
  const expectation = await db.query<{ status: string }>(
    'SELECT status FROM tm_expectations WHERE registration_key = $1',
    [`tm:approval-resolution:${request_id}`]
  );
  expect(expectation.rows[0]?.status).toBe('met');
  await checkApprovalStalls(new Date(now.getTime() + 60 * 60000));
  await tickDutyOfficerClock();
  expect(
    (await listMessages({ recipient: 'xo' })).filter(m => m.body.includes(request_id))
  ).toHaveLength(1);
});

test('untrusted, legacy, and ineligible events cannot create or resolve supervision', async () => {
  process.env.TASKMASTER_APPROVAL_PRODUCER_PRINCIPAL = 'system:taskmaster';
  await setPauseState({ pause_state: 'RUNNING', pause_actor: 'test' });
  const db = getDatabase();
  const now = new Date();
  for (const variant of ['untrusted', 'legacy', 'cancelled', 'failed', 'done', 'claimed']) {
    const request_id = crypto.randomUUID();
    const event = {
      schema: 't3-approval-breach/v1',
      request_id,
      thread_id: 'mcp:security',
      host: 'desktop',
      kind: 'command',
      command_head: 'bun test',
      created_at: new Date(now.getTime() - 20 * 60000).toISOString(),
      age_min: 20,
    };
    const msg = await createAuthenticatedMessage(
      { kind: 'system', sender: 'taskmaster' },
      {
        recipient: 'taskmaster',
        body: JSON.stringify(event),
        task_type: 'agent_message',
        correlation_id: request_id,
        idempotency_key: request_id,
      }
    );
    if (variant === 'untrusted' || variant === 'legacy')
      await db.query('UPDATE agent_dispatch_messages SET sender_principal_id = $1 WHERE id = $2', [
        variant === 'legacy' ? null : 'system:dispatch',
        msg.id,
      ]);
    else
      await db.query('UPDATE agent_dispatch_messages SET status = $1 WHERE id = $2', [
        variant,
        msg.id,
      ]);
    await checkApprovalStalls(now);
    expect(
      (
        await db.query('SELECT id FROM tm_journal WHERE idempotency_key = $1', [
          `tm:pending_approval:${request_id}`,
        ])
      ).rows
    ).toHaveLength(0);
  }
});
test('missing producer configuration fails closed', async () => {
  delete process.env.TASKMASTER_APPROVAL_PRODUCER_PRINCIPAL;
  await expect(checkApprovalStalls(new Date())).rejects.toThrow('approval_producer_not_configured');
});
