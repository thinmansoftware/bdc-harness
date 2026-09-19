import { createLogger } from '@archon/paths';
import type { DispatchMessage } from '@archon/core/db/dispatch';

const log = createLogger('dispatch/duty-officer-judge');

export const DUTY_OFFICER_OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const DUTY_OFFICER_XAI_CHAT_URL = 'https://api.x.ai/v1/chat/completions';
export const DUTY_OFFICER_DEFAULT_OPENROUTER_MODEL = 'x-ai/grok-4.6';
export const DUTY_OFFICER_DEFAULT_XAI_MODEL = 'grok-4.6';

export const DUTY_OFFICER_SYSTEM_PROMPT = `You are the Duty Officer of Blue Devil Collectibles (M-53).
You are an autonomous agent. John is not your backup and does not read your pass.
You nudge when the next step is already in the artifact. You escalate only real problems
(scope, money, contradiction, unknown next step, failed run_report, blocker).
You never spend money, email customers, deploy, merge, or close PRs.
You never write a report-for-John essay.

Reply with JSON only:
{"action":"escalate_xo"|"nudge"|"hold","reason":"<short>","body":"<factual payload for xo or nudge>"}
escalate_xo = post to recipient xo (the session holding the XO lease).
nudge = idle work whose next step is already written.
hold = Taskmaster digest/self-pause or mail that must stay open for XO, not marked succeeded.`;

const SPEND_SEND_DEPLOY_RE =
  /\b(charge|bill|invoice(?:d)?|refund|pay(?:ment|out)?|wire|transfer\s+funds|withdraw|deposit|purchase|buy(?:\s+now)?|deploy|merge\s+(?:to|into)\s+(?:main|master|prod|production)|push\s+to\s+prod(?:uction)?)\b/i;

export type DutyOfficerJudgeAction = 'escalate_xo' | 'nudge' | 'hold';

export interface DutyOfficerJudgeVerdict {
  status: 'ok' | 'unconfigured' | 'failed';
  transport?: string;
  action: DutyOfficerJudgeAction;
  reason: string;
  body: string;
  failures: { transport: string; error: string }[];
}

export interface DutyOfficerJudgeDeps {
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
}

function openRouterKey(): string | null {
  const token = process.env.OPENROUTER_API_KEY?.trim() || process.env.GLM_API_KEY?.trim();
  return token ? token : null;
}

function xaiKey(): string | null {
  const token = process.env.XAI_API_KEY?.trim();
  return token ? token : null;
}

export function parseDutyOfficerJudgeText(text: string): {
  action: DutyOfficerJudgeAction;
  reason: string;
  body: string;
} {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const raw = (fenced ? fenced[1] : trimmed).trim();
  const parsed = JSON.parse(raw) as { action?: unknown; reason?: unknown; body?: unknown };
  const action = parsed.action;
  if (action !== 'escalate_xo' && action !== 'nudge' && action !== 'hold') {
    throw new Error('duty_officer_judge_action_invalid');
  }
  const reason =
    typeof parsed.reason === 'string' && parsed.reason.trim() ? parsed.reason.trim() : action;
  const body = typeof parsed.body === 'string' ? parsed.body : '';
  if (SPEND_SEND_DEPLOY_RE.test(body) || SPEND_SEND_DEPLOY_RE.test(reason)) {
    throw new Error('duty_officer_judge_forbidden_verb');
  }
  return { action, reason, body };
}

async function chatCompletions(input: {
  url: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  extraHeaders?: Record<string, string>;
}): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, input.timeoutMs);
  let response: Response;
  try {
    response = await input.fetchImpl(input.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${input.apiKey}`,
        ...(input.extraHeaders ?? {}),
      },
      body: JSON.stringify({
        model: input.model,
        temperature: 0,
        messages: [
          { role: 'system', content: input.systemPrompt },
          { role: 'user', content: input.userPrompt },
        ],
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`duty_officer_judge_timeout_${input.timeoutMs}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`duty_officer_judge_http_${response.status}:${text.slice(0, 240)}`);
  }
  const parsed = JSON.parse(text) as {
    choices?: { message?: { content?: unknown } }[];
  };
  const content = parsed.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('duty_officer_judge_empty');
  }
  return content;
}

function redactSecrets(text: string): string {
  return text
    .replace(/sk-or-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/gh[pousr]_[A-Za-z0-9]+/g, '[redacted]')
    .replace(/xai-[A-Za-z0-9_-]+/g, '[redacted]');
}

function briefFor(message: DispatchMessage): string {
  return JSON.stringify({
    id: message.id,
    task_type: message.task_type,
    priority: message.priority,
    sender: message.sender,
    subject_key: message.subject_key,
    body: redactSecrets(message.body).slice(0, 4000),
  });
}

export async function judgeDutyOfficerItem(
  message: DispatchMessage,
  deps: DutyOfficerJudgeDeps = {}
): Promise<DutyOfficerJudgeVerdict> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = Math.max(5_000, Number(process.env.DUTY_OFFICER_JUDGE_TIMEOUT_MS) || 45_000);
  const failures: { transport: string; error: string }[] = [];
  const orKey = openRouterKey();
  const xKey = xaiKey();
  if (process.env.DUTY_OFFICER_JUDGE_ENABLED !== 'true' || (!orKey && !xKey)) {
    return {
      status: 'unconfigured',
      action: 'hold',
      reason:
        process.env.DUTY_OFFICER_JUDGE_ENABLED !== 'true'
          ? 'judge_disabled'
          : 'no_openrouter_or_xai_key',
      body: '',
      failures,
    };
  }

  const rungs: {
    transport: string;
    run: () => Promise<string>;
  }[] = [];
  if (orKey) {
    const model =
      process.env.DUTY_OFFICER_OPENROUTER_MODEL?.trim() || DUTY_OFFICER_DEFAULT_OPENROUTER_MODEL;
    rungs.push({
      transport: `openrouter:${model}`,
      run: () =>
        chatCompletions({
          url: DUTY_OFFICER_OPENROUTER_URL,
          apiKey: orKey,
          model,
          systemPrompt: DUTY_OFFICER_SYSTEM_PROMPT,
          userPrompt: briefFor(message),
          fetchImpl,
          timeoutMs,
          extraHeaders: {
            'HTTP-Referer': 'https://ops-cauldron.thinmansoftware.com',
            'X-Title': 'bdc-duty-officer',
          },
        }),
    });
  }
  if (xKey) {
    const model = process.env.DUTY_OFFICER_XAI_MODEL?.trim() || DUTY_OFFICER_DEFAULT_XAI_MODEL;
    rungs.push({
      transport: `xai:${model}`,
      run: () =>
        chatCompletions({
          url: DUTY_OFFICER_XAI_CHAT_URL,
          apiKey: xKey,
          model,
          systemPrompt: DUTY_OFFICER_SYSTEM_PROMPT,
          userPrompt: briefFor(message),
          fetchImpl,
          timeoutMs,
        }),
    });
  }

  for (const rung of rungs) {
    try {
      const text = await rung.run();
      const parsed = parseDutyOfficerJudgeText(text);
      log.info({ transport: rung.transport, action: parsed.action }, 'duty_officer_judge_ok');
      return {
        status: 'ok',
        transport: rung.transport,
        action: parsed.action,
        reason: parsed.reason,
        body: parsed.body,
        failures,
      };
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      failures.push({ transport: rung.transport, error: err.slice(0, 240) });
      log.warn({ transport: rung.transport, err }, 'duty_officer_judge_rung_failed');
    }
  }

  log.error({ failures }, 'duty_officer_judge_all_rungs_failed');
  return {
    status: 'failed',
    action: 'hold',
    reason: 'duty_officer_judge_outage',
    body: `DO judge outage. Source ${message.id} ${message.task_type}.`,
    failures,
  };
}
