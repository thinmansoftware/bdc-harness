/**
 * bdc-harness #847 items 1 and 2 -- judge quota/credit/auth classification and
 * the ladder-exhausted circuit breaker. Hermetic: fake rungs, fake ingest
 * deps, fixed clock, no network, no database.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import {
  applyLadderRestoredRequest,
  classifyJudgeOutage,
  createJudgeLadderBreaker,
  evaluateJudgeLadder,
  parseCodexRetryAt,
  recordJudgeRungOutage,
  recoverParkedJudgeHeads,
  resetJudgeLadderHealth,
  type JudgeOutage,
} from '../judge-ladder-health.ts';
import {
  evaluatePullRequest,
  reviewErrorCode,
  type PrReviewDeps,
  type PrReviewInput,
  type PrReviewModelResult,
} from '../pr-review-evaluator.ts';
import {
  ingestPullRequestEvent,
  type IngestDeps,
  type IngestRequest,
} from '../pr-review-ingest.ts';

const NOW = new Date('2026-09-14T21:15:00.000Z');
/** Past grok's 60-minute TTL; codex's stated retry (Sep 20th) is still ahead. */
const LATER = new Date('2026-09-14T22:16:00.000Z');
const HEAD = 'd'.repeat(40);
const SECRET = 'ladder-test-secret';
const REVIEWER = 'thinman-overseer[bot]';
const LADDER = ['codex', 'grok'] as const;

/** Verbatim from the container probe, 2026-09-14 21:15Z. */
const CODEX_STDERR =
  "ERROR: You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 20th, 2026 1:13 PM.";
const XAI_STDERR =
  'Error: 402 Payment Required: insufficient credits. Add credits at https://console.x.ai to continue.';

const input: PrReviewInput = {
  owner: 'thinmansoftware',
  repo: 'bdc-harness',
  pr_number: 847,
  head_sha: HEAD,
};

function verdictJson(): string {
  return JSON.stringify({ verdict: 'APPROVE', findings: [], reviewed_head_sha: HEAD });
}

function evaluatorDeps(overrides: Partial<PrReviewDeps> = {}): PrReviewDeps {
  return {
    reviewer: { provider: 'cli', model: 'codex' },
    fetchEvidence: async () => ({
      diff: '+ change',
      checks: [{ name: 'test', status: 'completed', conclusion: 'success' }],
    }),
    fetchAcceptanceCriteria: async () => null,
    invokeModel: async () => ({ exitCode: 0, timedOut: false, stdout: verdictJson() }),
    ladder: [...LADDER],
    ...overrides,
  };
}

/** Both rungs as they were on 2026-09-14: codex refuses on stderr, grok on stdout. */
async function deadLadder(binary: string): Promise<PrReviewModelResult> {
  if (binary === 'codex') return { exitCode: 1, timedOut: false, stdout: '', stderr: CODEX_STDERR };
  return { exitCode: 1, timedOut: false, stdout: XAI_STDERR, stderr: '' };
}

/** Trip the breaker the way production does: one review runs through both dead rungs. */
async function tripLadder(at: Date = NOW): Promise<void> {
  const result = await evaluatePullRequest(
    input,
    evaluatorDeps({
      invokeModel: deadLadder,
      recordRungOutage: (binary, outage) => recordJudgeRungOutage(binary, outage, at),
    })
  );
  expect(result.verdict).toBe('INDETERMINATE');
}

function sign(payload: string): string {
  return 'sha256=' + createHmac('sha256', SECRET).update(payload).digest('hex');
}

function prPayload(): string {
  return JSON.stringify({
    action: 'synchronize',
    number: 847,
    pull_request: {
      number: 847,
      draft: false,
      state: 'open',
      head: { sha: HEAD, ref: 'fix/judge-ladder' },
      base: { ref: 'dev', sha: 'c'.repeat(40) },
      user: { login: 'bluedevilcollectibles', type: 'User' },
    },
    repository: {
      name: 'bdc-harness',
      owner: { login: 'thinmansoftware' },
      full_name: 'thinmansoftware/bdc-harness',
    },
  });
}

function request(deliveryId: string): IngestRequest {
  const body = prPayload();
  return { rawBody: body, signature: sign(body), eventType: 'pull_request', deliveryId };
}

interface Recorded {
  receipts: Parameters<IngestDeps['recordReceipt']>[0][];
  enqueued: Parameters<IngestDeps['enqueueReviewWork']>[0][];
  comments: number;
}

function ingestDeps(breaker?: IngestDeps['judgeLadderBreaker']): {
  deps: IngestDeps;
  rec: Recorded;
} {
  const rec: Recorded = { receipts: [], enqueued: [], comments: 0 };
  const deps: IngestDeps = {
    webhookSecret: SECRET,
    reviewerIdentity: REVIEWER,
    listPriorReviewWork: async () => [],
    cancelReviewWork: async ids => ids.messageIds,
    enqueueReviewWork: async work => {
      rec.enqueued.push(work);
      return { messageId: `msg-${rec.enqueued.length}`, alreadyExisted: false };
    },
    postCapExhaustedComment: async () => {
      rec.comments += 1;
      return { posted: true };
    },
    recordReceipt: async receipt => {
      rec.receipts.push(receipt);
    },
    ...(breaker ? { judgeLadderBreaker: breaker } : {}),
  };
  return { deps, rec };
}

beforeEach(() => {
  resetJudgeLadderHealth();
});

describe('#847 -- judge stderr is classified into reason codes', () => {
  test('the Codex usage-limit text yields usage_limit_until with the parsed UTC date', async () => {
    const result = await evaluatePullRequest(
      input,
      evaluatorDeps({
        ladder: ['codex'],
        invokeModel: async () => ({
          exitCode: 1,
          timedOut: false,
          stdout: '',
          stderr: CODEX_STDERR,
        }),
      })
    );
    expect(result.verdict).toBe('INDETERMINATE');
    expect(result.error).toBe('usage_limit_until:2026-09-20T13:13:00.000Z');
    expect(reviewErrorCode(result.error)).toBe('usage_limit_until');
    // Judgment, not transport: terminal, no retry budget -- exactly as before.
    expect(result.retry_after_ms).toBeUndefined();
  });

  test('the xAI insufficient-credits text yields provider_credits_exhausted', async () => {
    const result = await evaluatePullRequest(
      input,
      evaluatorDeps({
        ladder: ['grok'],
        // stdout fallback path: runReviewModelProcess substitutes stderr when stdout is empty.
        invokeModel: async () => ({ exitCode: 1, timedOut: false, stdout: XAI_STDERR }),
      })
    );
    expect(result.verdict).toBe('INDETERMINATE');
    expect(result.error).toBe('provider_credits_exhausted');
  });

  test('an unknown stderr keeps model_exit_nonzero:<binary>', async () => {
    const result = await evaluatePullRequest(
      input,
      evaluatorDeps({
        ladder: ['grok'],
        invokeModel: async () => ({
          exitCode: 3,
          timedOut: false,
          stdout: '',
          stderr: 'panic: something unrelated at line 12',
        }),
      })
    );
    expect(result.verdict).toBe('INDETERMINATE');
    expect(result.error).toBe('model_exit_nonzero:grok');
  });

  test('a thrown 401 is auth_expired and terminal', async () => {
    const result = await evaluatePullRequest(
      input,
      evaluatorDeps({
        ladder: ['grok'],
        invokeModel: async () => {
          throw new Error('401 Unauthorized: Authentication required');
        },
      })
    );
    expect(result.verdict).toBe('INDETERMINATE');
    expect(result.error).toBe('auth_expired');
    expect(result.retry_after_ms).toBeUndefined();
  });

  test('an unparseable retry date degrades to usage_limit', async () => {
    const result = await evaluatePullRequest(
      input,
      evaluatorDeps({
        ladder: ['codex'],
        invokeModel: async () => ({
          exitCode: 1,
          timedOut: false,
          stdout: '',
          stderr: "You've hit your usage limit. Try again at soon.",
        }),
      })
    );
    expect(result.error).toBe('usage_limit');
  });

  test('the outage seam sees every refusal and every clean exit', async () => {
    const calls: [string, JudgeOutage | null][] = [];
    await evaluatePullRequest(
      input,
      evaluatorDeps({
        invokeModel: deadLadder,
        recordRungOutage: (binary, outage) => {
          calls.push([binary, outage]);
        },
      })
    );
    expect(calls.map(([binary, outage]) => [binary, outage?.code ?? null])).toEqual([
      ['codex', 'usage_limit_until:2026-09-20T13:13:00.000Z'],
      ['grok', 'provider_credits_exhausted'],
    ]);

    calls.length = 0;
    await evaluatePullRequest(
      input,
      evaluatorDeps({
        ladder: ['grok'],
        recordRungOutage: (binary, outage) => {
          calls.push([binary, outage]);
        },
      })
    );
    expect(calls).toEqual([['grok', null]]);
  });

  test('parseCodexRetryAt handles ordinals, 12-hour clock, and garbage', () => {
    expect(parseCodexRetryAt(CODEX_STDERR)).toBe('2026-09-20T13:13:00.000Z');
    expect(parseCodexRetryAt('try again at Dec 1st, 2026 12:05 AM.')).toBe(
      '2026-12-01T00:05:00.000Z'
    );
    expect(parseCodexRetryAt('try again at Sep 20th, 2026')).toBe('2026-09-20T00:00:00.000Z');
    expect(parseCodexRetryAt('try again at soon')).toBeNull();
    expect(classifyJudgeOutage('')).toBeNull();
  });
});

describe('#847 -- ladder-exhausted breaker at ingest', () => {
  test('both rungs out: a new head is parked, nothing enqueued, one notice per hour', async () => {
    await tripLadder();
    const sent: { idempotencyKey: string; body: string }[] = [];
    const breaker = createJudgeLadderBreaker({
      ladder: LADDER,
      now: () => NOW,
      sendOperatorMessage: async message => {
        sent.push(message);
      },
    });
    const { deps, rec } = ingestDeps(breaker);

    for (const deliveryId of ['delivery-1', 'delivery-2', 'delivery-3']) {
      const result = await ingestPullRequestEvent(request(deliveryId), deps);
      expect(result.disposition).toBe('blocked');
      expect(result.status).toBe(200);
      // grok's credit record expires 60 minutes after 21:15Z; codex is out until Sep 20th.
      expect(result.reason).toBe('judge_ladder_exhausted_until:2026-09-14T22:15:00.000Z');
    }

    expect(rec.enqueued).toHaveLength(0);
    expect(rec.comments).toBe(0);
    expect(rec.receipts).toHaveLength(3);
    for (const receipt of rec.receipts) {
      expect(receipt.disposition).toBe('blocked');
      expect(receipt.reason).toBe('judge_ladder_exhausted_until:2026-09-14T22:15:00.000Z');
    }
    expect(sent).toHaveLength(1);
    expect(sent[0]?.idempotencyKey).toBe('judge-ladder-exhausted:2026-09-14T21');
    expect(sent[0]?.body).toContain('codex: usage_limit_until:2026-09-20T13:13:00.000Z');
    expect(sent[0]?.body).toContain('grok: provider_credits_exhausted');
    expect(sent[0]?.body).toContain('thinmansoftware/bdc-harness#847@ddddddd');
    expect(sent[0]?.body).toContain('operator_request:ladder_restored');
  });

  test('one healthy rung keeps the ladder open', async () => {
    recordJudgeRungOutage('codex', classifyJudgeOutage(CODEX_STDERR), NOW);
    expect(evaluateJudgeLadder(LADDER, NOW)).toBeNull();

    const breaker = createJudgeLadderBreaker({
      ladder: LADDER,
      now: () => NOW,
      sendOperatorMessage: async () => {},
    });
    const { deps, rec } = ingestDeps(breaker);
    const result = await ingestPullRequestEvent(request('delivery-1'), deps);
    expect(result.disposition).toBe('queued');
    expect(rec.enqueued).toHaveLength(1);
  });

  test('an operator_request:ladder_restored row clears the breaker and the judge runs again', async () => {
    await tripLadder();
    const breaker = createJudgeLadderBreaker({
      ladder: LADDER,
      now: () => NOW,
      sendOperatorMessage: async () => {},
    });
    const { deps, rec } = ingestDeps(breaker);
    expect((await ingestPullRequestEvent(request('delivery-1'), deps)).disposition).toBe('blocked');

    expect(applyLadderRestoredRequest('supersede:a->b after approved')).toBe(false);
    expect(applyLadderRestoredRequest(null)).toBe(false);
    expect(
      applyLadderRestoredRequest('operator_request:ladder_restored: xai credits topped up')
    ).toBe(true);

    const result = await ingestPullRequestEvent(request('delivery-2'), deps);
    expect(result.disposition).toBe('queued');
    expect(rec.enqueued).toHaveLength(1);
    expect(rec.enqueued[0]?.headSha).toBe(HEAD);
  });

  test('parked heads are re-enqueued once the earliest retry time passes', async () => {
    await tripLadder();
    const breaker = createJudgeLadderBreaker({
      ladder: LADDER,
      now: () => NOW,
      sendOperatorMessage: async () => {},
    });
    const { deps, rec } = ingestDeps(breaker);
    await ingestPullRequestEvent(request('delivery-1'), deps);
    expect(rec.enqueued).toHaveLength(0);

    // Still exhausted at 21:15Z: nothing moves.
    expect(await recoverParkedJudgeHeads(deps, LADDER, NOW)).toEqual({
      recovered: [],
      stillParked: 1,
    });

    // grok's TTL has lapsed at 22:16Z: the ladder is open, the head is queued.
    const outcome = await recoverParkedJudgeHeads(deps, LADDER, LATER);
    expect(outcome.recovered).toHaveLength(1);
    expect(outcome.stillParked).toBe(0);
    expect(rec.enqueued).toHaveLength(1);
    expect(rec.enqueued[0]?.headSha).toBe(HEAD);
    expect(rec.enqueued[0]?.repeatReason).toBe(`judge_ladder_recovered:${HEAD}`);
    const recovery = rec.receipts.find(receipt => receipt.reason === 'judge_ladder_recovered');
    expect(recovery?.disposition).toBe('queued');
    expect(recovery?.messageId).toBe('msg-1');

    // Idempotent: a second pass has nothing left to do.
    expect(await recoverParkedJudgeHeads(deps, LADDER, LATER)).toEqual({
      recovered: [],
      stillParked: 0,
    });
  });

  test('a new hour sends a new notice; a restart in the same hour reuses the same key', async () => {
    await tripLadder();
    let clock = NOW;
    const sent: string[] = [];
    const breaker = createJudgeLadderBreaker({
      ladder: LADDER,
      now: () => clock,
      sendOperatorMessage: async message => {
        sent.push(message.idempotencyKey);
      },
    });
    const { deps } = ingestDeps(breaker);

    await ingestPullRequestEvent(request('delivery-1'), deps);
    clock = new Date('2026-09-14T21:59:00.000Z');
    await ingestPullRequestEvent(request('delivery-2'), deps);
    expect(sent).toEqual(['judge-ladder-exhausted:2026-09-14T21']);

    // 22:05Z: grok's record (until 22:15Z) is still in force -> new hour, new notice.
    clock = new Date('2026-09-14T22:05:00.000Z');
    await ingestPullRequestEvent(request('delivery-3'), deps);
    expect(sent).toEqual([
      'judge-ladder-exhausted:2026-09-14T21',
      'judge-ladder-exhausted:2026-09-14T22',
    ]);

    // Restart inside 21:xx: memory is gone, the ladder re-trips, and the notice
    // is re-sent -- with the SAME key, which the dispatch store dedupes.
    resetJudgeLadderHealth();
    clock = new Date('2026-09-14T21:30:00.000Z');
    await tripLadder(clock);
    await ingestPullRequestEvent(request('delivery-4'), deps);
    expect(sent.at(-1)).toBe('judge-ladder-exhausted:2026-09-14T21');
  });

  test('an expired credit record no longer counts toward exhaustion', async () => {
    await tripLadder();
    expect(evaluateJudgeLadder(LADDER, NOW)?.until).toBe('2026-09-14T22:15:00.000Z');
    expect(evaluateJudgeLadder(LADDER, LATER)).toBeNull();
    // An empty or blank ladder can never be "exhausted".
    expect(evaluateJudgeLadder([], NOW)).toBeNull();
    expect(evaluateJudgeLadder([' '], NOW)).toBeNull();
  });
});
