import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { DispatchMessage } from '@archon/core/db/dispatch';
import { ClaudeProvider } from '@archon/providers';
import type { MessageChunk } from '@archon/providers/types';
import {
  DUTY_OFFICER_DEFAULT_CLAUDE_MODEL,
  DUTY_OFFICER_SYSTEM_PROMPT,
  judgeDutyOfficerItem,
  parseDutyOfficerJudgeText,
  type DutyOfficerJudgeLog,
} from './duty-officer-judge';

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
  delete process.env.DUTY_OFFICER_JUDGE_PROVIDER;
  delete process.env.DUTY_OFFICER_CLAUDE_MODEL;
});

function captureLog(): {
  log: DutyOfficerJudgeLog;
  info: { obj: Record<string, unknown>; msg?: string }[];
  warn: { obj: Record<string, unknown>; msg?: string }[];
} {
  const info: { obj: Record<string, unknown>; msg?: string }[] = [];
  const warn: { obj: Record<string, unknown>; msg?: string }[] = [];
  return {
    info,
    warn,
    log: {
      info: (obj, msg) => {
        info.push({ obj, msg });
      },
      warn: (obj, msg) => {
        warn.push({ obj, msg });
      },
      error: () => {},
    },
  };
}

function countingFetch(handler?: (url: string) => Response): {
  fetchImpl: typeof fetch;
  urls: string[];
} {
  const urls: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    const href = String(url);
    urls.push(href);
    if (handler) return handler(href);
    return new Response('unexpected', { status: 500 });
  }) as typeof fetch;
  return { fetchImpl, urls };
}

function openRouterVerdict(action: string, reason: string, body: string): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({ action, reason, body }),
          },
        },
      ],
    }),
    { status: 200 }
  );
}

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
    expect(() =>
      parseDutyOfficerJudgeText('{"action":"escalate_xo","reason":"email the customer","body":"x"}')
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

  test('holds instead of escalating when every judge rung fails', async () => {
    process.env.DUTY_OFFICER_JUDGE_ENABLED = 'true';
    process.env.OPENROUTER_API_KEY = 'or-test';
    const fetchImpl = (async () => new Response('nope', { status: 402 })) as typeof fetch;
    const verdict = await judgeDutyOfficerItem(message(), { fetchImpl });
    expect(verdict.status).toBe('failed');
    expect(verdict.action).toBe('hold');
    expect(verdict.reason).toBe('duty_officer_judge_outage');
  });

  test('claude_path_returns_valid_verdict', async () => {
    process.env.DUTY_OFFICER_JUDGE_ENABLED = 'true';
    process.env.DUTY_OFFICER_JUDGE_PROVIDER = 'claude';
    const captured = captureLog();
    const { fetchImpl, urls } = countingFetch();
    let seenModel = '';
    const verdict = await judgeDutyOfficerItem(message(), {
      fetchImpl,
      log: captured.log,
      claudeComplete: async input => {
        seenModel = input.model;
        expect(input.systemPrompt).toBe(DUTY_OFFICER_SYSTEM_PROMPT);
        expect(input.userPrompt).toContain('"id":"m1"');
        return '{"action":"nudge","reason":"r","body":"b"}';
      },
    });

    expect(DUTY_OFFICER_DEFAULT_CLAUDE_MODEL).toBe('claude-haiku-5-5');
    expect(seenModel).toBe('claude-haiku-5-5');
    expect(urls).toHaveLength(0);
    expect(verdict.status).toBe('ok');
    expect(verdict.action).toBe('nudge');
    expect(verdict.transport).toBe('claude:claude-haiku-5-5');
    expect(
      captured.info.some(
        entry =>
          entry.msg === 'duty_officer_judge_ok' &&
          entry.obj.action === 'duty_officer_judge_ok' &&
          entry.obj.provider === 'claude' &&
          entry.obj.model === 'claude-haiku-5-5'
      )
    ).toBe(true);
  });

  test('forbidden_verb_guard_on_claude_path', async () => {
    process.env.DUTY_OFFICER_JUDGE_ENABLED = 'true';
    process.env.DUTY_OFFICER_JUDGE_PROVIDER = 'claude';
    const { fetchImpl, urls } = countingFetch();
    const verdict = await judgeDutyOfficerItem(message(), {
      fetchImpl,
      claudeComplete: async () => '{"action":"nudge","reason":"r","body":"deploy to production"}',
    });

    expect(urls).toHaveLength(0);
    expect(verdict.status).not.toBe('ok');
    expect(verdict.status).toBe('failed');
    expect(verdict.reason).toBe('duty_officer_judge_outage');
    expect(verdict.body).not.toContain('deploy to production');
    expect(
      verdict.failures.some(failure => failure.error.includes('duty_officer_judge_forbidden_verb'))
    ).toBe(true);
  });

  test('fallback_only_when_key_present', async () => {
    process.env.DUTY_OFFICER_JUDGE_ENABLED = 'true';
    process.env.DUTY_OFFICER_JUDGE_PROVIDER = 'claude';
    const claudeComplete = async (): Promise<string> => {
      throw new Error('refresh_expired');
    };

    process.env.OPENROUTER_API_KEY = 'or-test';
    const captured = captureLog();
    const caseA = countingFetch(href => {
      if (!href.includes('openrouter.ai')) {
        throw new Error(`unexpected_fetch:${href}`);
      }
      return openRouterVerdict('nudge', 'fallback', 'from openrouter');
    });
    const verdictA = await judgeDutyOfficerItem(message(), {
      fetchImpl: caseA.fetchImpl,
      log: captured.log,
      claudeComplete,
    });
    expect(caseA.urls).toHaveLength(1);
    expect(verdictA.status).toBe('ok');
    expect(verdictA.action).toBe('nudge');
    expect(verdictA.transport).toContain('openrouter:');
    expect(verdictA.failures.some(failure => failure.error.includes('refresh_expired'))).toBe(true);
    expect(
      captured.info.some(
        entry =>
          entry.msg === 'duty_officer_judge_ok' &&
          entry.obj.provider === 'openrouter' &&
          entry.obj.action === 'duty_officer_judge_ok'
      )
    ).toBe(true);

    delete process.env.OPENROUTER_API_KEY;
    delete process.env.GLM_API_KEY;
    delete process.env.XAI_API_KEY;
    const caseB = countingFetch();
    const verdictB = await judgeDutyOfficerItem(message(), {
      fetchImpl: caseB.fetchImpl,
      claudeComplete,
    });
    expect(caseB.urls).toHaveLength(0);
    expect(verdictB.status).toBe('failed');
    expect(verdictB.reason).toBe('duty_officer_judge_outage');
    expect(verdictB.failures.length).toBeGreaterThan(0);
    expect(verdictB.action).not.toBe('escalate_xo');
    expect(verdictB.action).not.toBe('nudge');
    expect(verdictB.status).not.toBe('ok');
  });

  test('claude_path_does_not_use_xai', async () => {
    process.env.DUTY_OFFICER_JUDGE_ENABLED = 'true';
    process.env.DUTY_OFFICER_JUDGE_PROVIDER = 'claude';
    process.env.OPENROUTER_API_KEY = 'or-test';
    process.env.XAI_API_KEY = 'xai-test';
    const { fetchImpl, urls } = countingFetch(href => {
      if (href.includes('api.x.ai')) {
        return openRouterVerdict('escalate_xo', 'should not run', 'xai trap');
      }
      return new Response('nope', { status: 402 });
    });
    const verdict = await judgeDutyOfficerItem(message(), {
      fetchImpl,
      claudeComplete: async () => {
        throw new Error('refresh_expired');
      },
    });
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('openrouter.ai');
    expect(urls.some(url => url.includes('api.x.ai'))).toBe(false);
    expect(verdict.status).toBe('failed');
    expect(verdict.reason).toBe('duty_officer_judge_outage');
    expect(verdict.action).not.toBe('escalate_xo');
  });

  test('unrecognized provider warns and keeps the default ladder', async () => {
    process.env.DUTY_OFFICER_JUDGE_ENABLED = 'true';
    process.env.DUTY_OFFICER_JUDGE_PROVIDER = 'subscription';
    process.env.OPENROUTER_API_KEY = 'or-test';
    const captured = captureLog();
    let claudeCalls = 0;
    const { fetchImpl, urls } = countingFetch(() =>
      openRouterVerdict('hold', 'default ladder', 'park')
    );
    const verdict = await judgeDutyOfficerItem(message(), {
      fetchImpl,
      log: captured.log,
      claudeComplete: async () => {
        claudeCalls += 1;
        return '{"action":"nudge","reason":"r","body":"b"}';
      },
    });
    expect(claudeCalls).toBe(0);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('openrouter.ai');
    expect(verdict.status).toBe('ok');
    expect(verdict.action).toBe('hold');
    expect(verdict.transport).toContain('openrouter:');
    expect(
      captured.warn.some(
        entry =>
          entry.msg === 'duty_officer_judge_provider_unrecognized' &&
          entry.obj.provider === 'subscription'
      )
    ).toBe(true);
  });

  test('claude_stream_error_result_after_verdict_is_not_ok', async () => {
    const envKeys = [
      'DUTY_OFFICER_JUDGE_ENABLED',
      'DUTY_OFFICER_JUDGE_PROVIDER',
      'OPENROUTER_API_KEY',
      'GLM_API_KEY',
      'XAI_API_KEY',
    ] as const;
    const prior = new Map<string, string | undefined>();
    for (const key of envKeys) {
      prior.set(key, process.env[key]);
    }

    const sendQuery = spyOn(ClaudeProvider.prototype, 'sendQuery').mockImplementation(
      async function* (): AsyncGenerator<MessageChunk> {
        yield { type: 'assistant', content: '{"action":"nudge","reason":"r","body":"b"}' };
        yield { type: 'result', isError: true, errorSubtype: 'error_during_execution' };
      }
    );

    const restoreEnv = (): void => {
      for (const key of envKeys) {
        const value = prior.get(key);
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    };

    try {
      process.env.DUTY_OFFICER_JUDGE_ENABLED = 'true';
      process.env.DUTY_OFFICER_JUDGE_PROVIDER = 'claude';
      process.env.OPENROUTER_API_KEY = 'or-test';

      const capturedA = captureLog();
      const caseA = countingFetch(href => {
        if (!href.includes('openrouter.ai')) {
          throw new Error(`unexpected_fetch:${href}`);
        }
        return openRouterVerdict('nudge', 'fallback', 'from openrouter');
      });
      sendQuery.mockClear();
      const verdictA = await judgeDutyOfficerItem(message(), {
        fetchImpl: caseA.fetchImpl,
        log: capturedA.log,
      });
      expect(sendQuery).toHaveBeenCalled();
      expect(caseA.urls).toHaveLength(1);
      expect(verdictA.status).toBe('ok');
      expect(verdictA.action).toBe('nudge');
      expect(verdictA.transport).toContain('openrouter:');
      expect(
        capturedA.info.some(
          entry => entry.msg === 'duty_officer_judge_ok' && entry.obj.provider === 'openrouter'
        )
      ).toBe(true);
      expect(
        capturedA.info.some(
          entry => entry.msg === 'duty_officer_judge_ok' && entry.obj.provider === 'claude'
        )
      ).toBe(false);
      expect(
        verdictA.failures.some(failure =>
          failure.error.includes('duty_officer_judge_claude_result_error')
        )
      ).toBe(true);

      delete process.env.OPENROUTER_API_KEY;
      delete process.env.GLM_API_KEY;
      delete process.env.XAI_API_KEY;
      const caseB = countingFetch();
      sendQuery.mockClear();
      const verdictB = await judgeDutyOfficerItem(message(), {
        fetchImpl: caseB.fetchImpl,
      });
      expect(sendQuery).toHaveBeenCalled();
      expect(caseB.urls).toHaveLength(0);
      expect(verdictB.status).toBe('failed');
      expect(verdictB.reason).toBe('duty_officer_judge_outage');
      expect(verdictB.status).not.toBe('ok');
      expect(
        verdictB.failures.some(failure =>
          failure.error.includes('duty_officer_judge_claude_result_error')
        )
      ).toBe(true);
    } finally {
      sendQuery.mockRestore();
      restoreEnv();
    }
  });
});
