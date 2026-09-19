import { afterEach, describe, expect, test } from 'bun:test';
import type { DispatchMessage } from '@archon/core/db/dispatch';
import { judgeDutyOfficerItem, parseDutyOfficerJudgeText } from './duty-officer-judge';

function message(): DispatchMessage {
  return {
    id: 'm1',
    correlation_id: 'c1',
    idempotency_key: 'k1',
    task_type: 'run_report',
    sender: 'overseer',
    recipient: 'duty-officer',
    body: '{"kind":"run_report"}',
    status: 'queued',
    result_body: null,
    created_at: new Date(0).toISOString(),
    claimed_at: null,
    completed_at: null,
    not_before: null,
    lease_owner: null,
    lease_expires_at: null,
    fencing_token: 0,
    recipient_alias: null,
    motion_id: null,
    motion_revision_sha: null,
    resolved_recipient: null,
    resolved_xo_lease_id: null,
    resolved_xo_fencing_token: null,
    resolved_at: null,
    priority: 'blocker',
    task_outcome: null,
    acknowledged_at: null,
    acknowledged_by: null,
    addressed_at: null,
    addressed_by: null,
    escalated_tg_at: null,
    escalated_sms_at: null,
    subject_key: null,
    route_disposition: null,
    supersedes_id: null,
    repeat_reason: null,
  };
}

afterEach(() => {
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.GLM_API_KEY;
  delete process.env.XAI_API_KEY;
  delete process.env.DUTY_OFFICER_JUDGE_ENABLED;
});

describe('duty officer judge', () => {
  test('parses fenced JSON and rejects spend verbs', () => {
    const parsed = parseDutyOfficerJudgeText(
      '```json\n{"action":"escalate_xo","reason":"run failed","body":"WO-X stuck"}\n```'
    );
    expect(parsed.action).toBe('escalate_xo');
    expect(() =>
      parseDutyOfficerJudgeText(
        '{"action":"escalate_xo","reason":"refund the customer","body":"x"}'
      )
    ).toThrow(/forbidden_verb/);
  });

  test('falls back to xAI Grok when OpenRouter fails', async () => {
    process.env.DUTY_OFFICER_JUDGE_ENABLED = 'true';
    process.env.OPENROUTER_API_KEY = 'or-test';
    process.env.XAI_API_KEY = 'xai-test';
    let calls = 0;
    const fetchImpl = (async (url: string | URL) => {
      calls += 1;
      const href = String(url);
      if (href.includes('openrouter.ai')) {
        return new Response('nope', { status: 402 });
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  action: 'escalate_xo',
                  reason: 'grok backup',
                  body: 'source m1',
                }),
              },
            },
          ],
        }),
        { status: 200 }
      );
    }) as typeof fetch;

    const verdict = await judgeDutyOfficerItem(message(), { fetchImpl });
    expect(calls).toBe(2);
    expect(verdict.status).toBe('ok');
    expect(verdict.transport).toContain('xai:');
    expect(verdict.action).toBe('escalate_xo');
  });

  test('unconfigured when neither key is set', async () => {
    const verdict = await judgeDutyOfficerItem(message());
    expect(verdict.status).toBe('unconfigured');
    expect(verdict.action).toBe('hold');
  });

  test('unconfigured when judge flag is off even with a key', async () => {
    process.env.OPENROUTER_API_KEY = 'or-test';
    const verdict = await judgeDutyOfficerItem(message());
    expect(verdict.status).toBe('unconfigured');
    expect(verdict.reason).toBe('judge_disabled');
  });
});
