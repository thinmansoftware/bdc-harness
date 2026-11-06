import { test, expect } from 'bun:test';
import { getDatabase } from '@archon/core';
import { createAuthenticatedMessage, listMessages } from '@archon/core/db/dispatch';
import { setPauseState } from '@archon/core/db/taskmaster';
import { checkApprovalStalls } from './approval-stalls-runtime';
import { tickDutyOfficerClock } from '../dispatch/duty-officer-clock';
test('Piece 1 real SQLite Dispatch: journal, relay queue, DO/XO, resolution', async () => {
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
