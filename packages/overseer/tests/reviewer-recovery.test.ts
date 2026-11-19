import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  evaluatePullRequest,
  invokeConfiguredReviewModel,
  type PrReviewDeps,
} from '../src/pr-review-evaluator';
import { supportedPrReviewLadder } from '../src/judge-transport';
import {
  submitReviewerBrokerJob,
  diagnosticForError,
  terminationDiagnostic,
  type ReviewerBrokerResult,
} from '../src/reviewer-broker-client';
import {
  classifyJudgeOutage,
  createJudgeLadderBreaker,
  recordJudgeRungOutage,
  resetJudgeLadderHealth,
} from '../src/judge-ladder-health';

const head = 'a'.repeat(40);
const context = {
  kind: 'pr-review' as const,
  cwd: '/synthetic',
  expectedHeadSha: head,
  nativePolicy: 'codex_bubblewrap' as const,
};
const input = { owner: 'synthetic', repo: 'fixture', pr_number: 1, head_sha: head };
const canary = 'PRIVATE_RECOVERY_CANARY';
afterEach(resetJudgeLadderHealth);

async function nativeResult(fields: Partial<ReviewerBrokerResult>) {
  const spool = await mkdtemp(join(tmpdir(), 'review-recovery-'));
  await writeFile(join(spool, 'ready'), 'fake');
  try {
    return await invokeConfiguredReviewModel(
      'codex',
      canary,
      context,
      1000,
      async (job, options) => {
        await writeFile(
          join(spool, `${options?.id}.result.json`),
          JSON.stringify({
            id: options?.id,
            uid: 1002,
            ok: false,
            exitCode: 1,
            stdout: canary,
            stderr: 'token_revoked ' + canary,
            timedOut: false,
            outputTruncated: false,
            ...fields,
          })
        );
        return submitReviewerBrokerJob(job, { ...options, env: { OVERSEER_REVIEW_SPOOL: spool } });
      }
    );
  } finally {
    expect(await readdir(spool)).toEqual(['ready']);
    await rm(spool, { recursive: true, force: true });
  }
}

function deps(
  invokeModel: PrReviewDeps['invokeModel'],
  extra: Partial<PrReviewDeps> = {}
): PrReviewDeps {
  return {
    reviewer: { provider: 'fixture', model: 'fixture' },
    fetchEvidence: async () => ({
      diff: '+ synthetic',
      checks: [{ name: 'test', status: 'completed', conclusion: 'success' }],
    }),
    fetchAcceptanceCriteria: async () => null,
    ladder: ['codex', 'cursor'],
    executionContext: context,
    invokeModel,
    recordRungOutage: recordJudgeRungOutage,
    ...extra,
  };
}

for (const code of ['token_revoked', 'refresh_token_invalidated']) {
  test(`R2 actual fake client auth ${code} reaches evaluator and supported breaker without private text`, async () => {
    const result = await nativeResult({ stderr: code + ' ' + canary });
    const calls: string[] = [];
    const evaluated = await evaluatePullRequest(
      input,
      deps(async binary => {
        calls.push(binary);
        return result;
      })
    );
    expect(evaluated.verdict).toBe('INDETERMINATE');
    expect(evaluated.error).toBe('auth_expired');
    expect(calls).toEqual(['codex']);
    expect(evaluated.diagnostics?.map(d => d.terminationClass)).toEqual([
      'auth_expired',
      'unsupported_binary',
    ]);
    const breaker = createJudgeLadderBreaker({
      ladder: ['codex', 'cursor'],
      nativePrReview: true,
      sendOperatorMessage: async () => {},
    });
    expect(breaker.check()?.rungs.map(r => r.binary)).toEqual(['codex']);
    expect(JSON.stringify([evaluated, breaker.check()])).not.toContain(canary);
  });
}

test('R2 named invalidation recognition is finite', () => {
  expect(classifyJudgeOutage('token_revoked')?.kind).toBe('auth_expired');
  expect(classifyJudgeOutage('refresh_token_invalidated')?.kind).toBe('auth_expired');
  expect(classifyJudgeOutage('not_token_revoked_suffix')).toBeNull();
});

for (const fields of [
  { uid: 999 },
  { id: 'wrong-id' },
  { exitCode: 0, ok: true },
  { exitCode: 1.5 },
  { ok: true },
  { timedOut: true },
  { outputTruncated: true },
]) {
  test(`R2 inconsistent process cannot assert auth ${JSON.stringify(fields)}`, async () => {
    const callbacks: unknown[] = [];
    let result;
    try {
      result = await nativeResult(fields);
    } catch (error) {
      expect(diagnosticForError(error)?.terminationClass).toBe('invalid_broker_result');
      expect(callbacks).toEqual([]);
      return;
    }
    const evaluated = await evaluatePullRequest(
      input,
      deps(async () => result, { recordRungOutage: (_binary, outage) => callbacks.push(outage) })
    );
    expect(evaluated.verdict).not.toBe('APPROVE');
    expect(evaluated.error).not.toBe('auth_expired');
    expect(
      callbacks.filter(value => value && (value as { kind: string }).kind === 'auth_expired')
    ).toEqual([]);
  });
}

test('R2 forged and factory-only diagnostics cannot claim observed auth', async () => {
  for (const diagnostic of [
    { terminationClass: 'auth_expired', exitCode: 1, correlationId: 'fake' },
    terminationDiagnostic('auth_expired', 1),
  ]) {
    const evaluated = await evaluatePullRequest(
      input,
      deps(async () => ({
        exitCode: 1,
        timedOut: false,
        stdout: 'token_revoked ' + canary,
        diagnostic: diagnostic as ReturnType<typeof terminationDiagnostic>,
      }))
    );
    expect(evaluated.error).not.toBe('auth_expired');
    expect(JSON.stringify(evaluated)).not.toContain(canary);
  }
});

test('R2 broker catch125 reason is not process authentication evidence', async () => {
  const result = await nativeResult({
    exitCode: 125,
    stdout: '',
    stderr: '',
    timedOut: undefined,
    outputTruncated: undefined,
    reason: 'token_revoked ' + canary,
  });
  const evaluated = await evaluatePullRequest(
    input,
    deps(async () => result)
  );
  expect(evaluated.error).not.toBe('auth_expired');
  expect(evaluated.diagnostics?.[0]).toMatchObject({
    terminationClass: 'broker_unavailable',
    exitCode: null,
  });
  expect(JSON.stringify(evaluated)).not.toContain(canary);
});

test('R3 unsupported-only and empty ladders make zero calls and never approve', async () => {
  for (const ladder of [['cursor'], []]) {
    let calls = 0;
    const evaluated = await evaluatePullRequest(
      input,
      deps(
        async () => {
          calls++;
          throw new Error(canary);
        },
        { ladder }
      )
    );
    expect(calls).toBe(0);
    expect(evaluated.verdict).toBe('INDETERMINATE');
    expect(JSON.stringify(evaluated)).not.toContain(canary);
  }
});

test('R3 unsupported secondary preserves generic primary failure and ordered diagnostics', async () => {
  const result = await nativeResult({ stderr: canary });
  const evaluated = await evaluatePullRequest(
    input,
    deps(async () => result)
  );
  expect(evaluated.error).toBe('model_exit_nonzero:codex');
  expect(evaluated.diagnostics?.map(d => d.terminationClass)).toEqual([
    'unknown_nonzero',
    'unsupported_binary',
  ]);
});

test('R2 genuine observed process125 may carry auth, unlike broker catch125', async () => {
  const result = await nativeResult({ exitCode: 125 });
  const evaluated = await evaluatePullRequest(
    input,
    deps(async () => result)
  );
  expect(evaluated.error).toBe('auth_expired');
  expect(evaluated.diagnostics?.[0].exitCode).toBe(125);
});

test('R2 native thrown text is not process auth and does not escape the business sink', async () => {
  const callbacks: unknown[] = [];
  const evaluated = await evaluatePullRequest(
    input,
    deps(
      async () => {
        throw new Error('token_revoked ' + canary);
      },
      { recordRungOutage: (_binary, outage) => callbacks.push(outage) }
    )
  );
  expect(evaluated.error).toBe('model_error');
  expect(evaluated.diagnostics?.[0].terminationClass).toBe('unknown_error');
  expect(callbacks).toEqual([]);
  expect(JSON.stringify(evaluated)).not.toContain(canary);
});

test('R3 capability selection is shared, deduped and does not enable a fallback', () => {
  expect(supportedPrReviewLadder(['cursor', 'codex', 'codex', 'grok', ''])).toEqual(['codex']);
  expect(supportedPrReviewLadder(['cursor'])).toEqual([]);
});

test('R2 existing quota class still reaches the native breaker without raw output', async () => {
  const result = await nativeResult({ stderr: 'usage limit exceeded ' + canary });
  const evaluated = await evaluatePullRequest(
    input,
    deps(async () => result)
  );
  expect(evaluated.error).toBe('usage_limit');
  expect(JSON.stringify(evaluated)).not.toContain(canary);
});

test('R3 qualified success remains determinate and clears the supported outage', async () => {
  recordJudgeRungOutage('codex', { kind: 'auth_expired', code: 'auth_expired' });
  const result = await nativeResult({
    ok: true,
    exitCode: 0,
    stderr: '',
    stdout: JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'agent_message',
        text: JSON.stringify({ verdict: 'APPROVE', findings: [], reviewed_head_sha: head }),
      },
    }),
  });
  const evaluated = await evaluatePullRequest(
    input,
    deps(async () => result)
  );
  expect(evaluated.verdict).toBe('APPROVE');
  expect(
    createJudgeLadderBreaker({
      ladder: ['codex', 'cursor'],
      nativePrReview: true,
      sendOperatorMessage: async () => {},
    }).check()
  ).toBeNull();
});

for (const fields of [
  { uid: 999 },
  { ok: false },
  { outputTruncated: true },
  { timedOut: undefined },
]) {
  test(`R2 valid APPROVE payload cannot outvote malformed native envelope ${JSON.stringify(fields)}`, async () => {
    recordJudgeRungOutage('codex', { kind: 'auth_expired', code: 'auth_expired' });
    const callbacks: unknown[] = [];
    const result = await nativeResult({
      ok: true,
      exitCode: 0,
      stderr: '',
      stdout: JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'agent_message',
          text: JSON.stringify({ verdict: 'APPROVE', findings: [], reviewed_head_sha: head }),
        },
      }),
      ...fields,
    });
    const evaluated = await evaluatePullRequest(
      input,
      deps(async () => result, {
        recordRungOutage: (binary, outage) => {
          callbacks.push(outage);
          recordJudgeRungOutage(binary, outage);
        },
      })
    );
    expect(evaluated.verdict).toBe('INDETERMINATE');
    expect(evaluated.error).toBe('invalid_broker_result');
    expect(callbacks).toEqual([]);
    expect(
      createJudgeLadderBreaker({
        ladder: ['codex'],
        nativePrReview: true,
        sendOperatorMessage: async () => {},
      }).check()?.rungs[0].code
    ).toBe('auth_expired');
    expect(result.stdout).toBe('');
    expect(JSON.stringify(evaluated)).not.toContain(canary);
  });
}
