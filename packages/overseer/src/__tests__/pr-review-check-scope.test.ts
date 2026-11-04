/**
 * WO-HARNESS-OVERSEER-RECHECK-CHECK-SCOPE-01 (bdc-xo #4575).
 *
 * Anchor: lspro-react #777 at head ca6fa304. Every standing CHANGES_REQUESTED
 * blamed the CE Promotion Gate in free text ("Required checks / CE Promotion
 * Gate") and added a non-blocking [note] on a test file. When the gate turned
 * green (2026-11-03 23:56Z) the recheck ingest ignored all seven completions as
 * verdict_not_check_caused, and the PR waited for a hand nudge.
 */
import { createHmac } from 'node:crypto';
import { expect, test } from 'bun:test';
import {
  blockingCheckNamesFromVerdict,
  blockingFindingsAreCheckScoped,
  checkNameFromFindingScope,
  ingestCheckCompletionEvent,
  summaryNamesACheck,
  type RecheckIngestDeps,
  type StandingVerdict,
} from '../pr-review-check-ingest';

const HEAD = 'ca6fa304f66296e99185567de3bc5cf05f2a6f68';
const GATE = 'CE Promotion Gate';

// Real #777 review bodies at head ca6fa304 (2026-11-03 20:33Z and 20:34Z).
const PR777_SLASH_SUMMARY =
  'Independent review by the Overseer App at head `ca6fa304f66296e99185567de3bc5cf05f2a6f68`.\n' +
  '\n' +
  '[major] Required checks / CE Promotion Gate: The supplied required CE Promotion Gate result is skipped, so it does not demonstrate successful promotion validation for this head.\n' +
  '[note] scripts/ci/vercel-api-routing.test.ts: The 3 tests execute 10 meaningful assertions with no zero-assertion tests.';
const PR777_COLON_SUMMARY =
  'Independent review by the Overseer App at head `ca6fa304f66296e99185567de3bc5cf05f2a6f68`.\n' +
  '\n' +
  '[major] Required check: CE Promotion Gate (126186742456): The supplied required gate concluded skipped, so successful promotion validation is missing for this exact head.\n' +
  '[note] scripts/ci/vercel-api-routing.test.ts: Static review found 3 tests with 10 executed value assertions and no assertion-free tests.';

test('Test 1: notes do not stop a check-only verdict from counting as check-caused', () => {
  const summary =
    '[major] checks/CE Promotion Gate failed\n[note] scripts/ci/x.test.ts: tests look fine';
  expect(blockingFindingsAreCheckScoped(summary)).toBe(true);
  expect(summaryNamesACheck(summary)).toBe(true);
  // minor is advisory too
  expect(summaryNamesACheck('[major] checks/lint failed\n[minor] src/a.ts: rename x')).toBe(true);
});

test('Test 2: the real #777 "Required checks / <name>" verdict is check-caused', () => {
  expect(summaryNamesACheck(PR777_SLASH_SUMMARY)).toBe(true);
  expect(blockingCheckNamesFromVerdict(PR777_SLASH_SUMMARY)).toEqual([GATE]);
  expect(checkNameFromFindingScope('Required checks / CE Promotion Gate')).toBe(GATE);
});

test('Test 3: the real #777 "Required check: <name> (<id>):" verdict is check-caused', () => {
  expect(summaryNamesACheck(PR777_COLON_SUMMARY)).toBe(true);
  expect(blockingCheckNamesFromVerdict(PR777_COLON_SUMMARY)).toEqual([GATE]);
  expect(
    checkNameFromFindingScope('Required check', 'CE Promotion Gate (126186742456): The supplied')
  ).toBe(GATE);
  // A matrix cell is part of the name; only a numeric run id is dropped.
  expect(checkNameFromFindingScope('checks/test (windows-latest) failed')).toBe(
    'test (windows-latest)'
  );
});

test('Test 4: a blocking code finding still prevents a recheck', () => {
  const mixed = '[major] checks/CE Promotion Gate failed\n[major] src/main.tsx: logic bug';
  expect(blockingFindingsAreCheckScoped(mixed)).toBe(false);
  expect(summaryNamesACheck(mixed)).toBe(false);
  expect(summaryNamesACheck('[blocker] src/db.ts: SQL injection')).toBe(false);
  // Only notes: nothing blocking, so not check-caused.
  expect(blockingFindingsAreCheckScoped('[note] checks/lint: fine')).toBe(false);
  // A bare "Required check" with no named check is not check-scoped.
  expect(checkNameFromFindingScope('Required check', 'skipped at this head')).toBeNull();
  expect(blockingFindingsAreCheckScoped('')).toBe(false);
  expect(blockingFindingsAreCheckScoped(null)).toBe(false);
});

test('Test 5: a green CE Promotion Gate queues a recheck for the #777 verdict', async () => {
  const secret = 'test-webhook-secret';
  const verdict: StandingVerdict = {
    headSha: HEAD,
    disposition: 'changes_requested',
    summary: PR777_SLASH_SUMMARY,
    recordedAt: '2026-11-03T20:34:52.000Z',
  };
  const enqueued: string[] = [];
  const receipts: { disposition: string; reason?: string }[] = [];
  const deps: RecheckIngestDeps = {
    webhookSecret: secret,
    async readStandingVerdict() {
      return verdict;
    },
    async enqueueRecheckWork(input) {
      enqueued.push(input.idempotencyKey);
      return { messageId: 'msg-1', alreadyExisted: false };
    },
    async recordReceipt(input) {
      receipts.push({
        disposition: input.disposition,
        ...(input.reason ? { reason: input.reason } : {}),
      });
    },
  };
  const rawBody = JSON.stringify({
    action: 'completed',
    check_run: {
      id: 126288831019,
      name: GATE,
      status: 'completed',
      conclusion: 'success',
      head_sha: HEAD,
      pull_requests: [{ number: 777, head: { sha: HEAD } }],
    },
    repository: { name: 'lspro-react', owner: { login: 'thinmansoftware' } },
  });
  const signature = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;

  const result = await ingestCheckCompletionEvent(
    { rawBody, signature, eventType: 'check_run', deliveryId: 'pr777-gate-green' },
    deps
  );
  expect(result.disposition).toBe('queued');
  expect(enqueued).toHaveLength(1);
  expect(receipts.some(r => r.disposition === 'ignored_no_authorizing_verdict')).toBe(false);
});
