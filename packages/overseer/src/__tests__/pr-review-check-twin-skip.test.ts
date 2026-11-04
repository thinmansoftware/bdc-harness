import { expect, test } from 'bun:test';
import { latestAttemptPerCheck, namedBlockingChecksAreGreen } from '../pr-review-check-ingest.ts';
import {
  applyRequiredCheckGate,
  partitionChecksByRequired,
  type PrReviewCheck,
} from '../pr-review-evaluator.ts';

// Anchor: lspro-react #777 at head ca6fa304. ce-promotion-gate.yml has two jobs
// named "CE Promotion Gate"; the PR #429 self-install exemption job is skipped on
// every other PR and is created AFTER the real job, so it has the higher run id.
const GATE = 'CE Promotion Gate';
const APP = { slug: 'github-actions' };

function run(id: number, conclusion: string | null, status = 'completed'): PrReviewCheck {
  return {
    id,
    name: GATE,
    status,
    conclusion,
    started_at: '2026-11-03T23:55:59Z',
    completed_at: status === 'completed' ? '2026-11-03T23:56:01Z' : null,
    app: APP,
  };
}

test('twin job: the real success wins over a newer skipped twin', () => {
  const real = run(126288831019, 'success');
  const twin = run(126288833084, 'skipped');
  expect(latestAttemptPerCheck([real, twin]).map(c => c.id)).toEqual([126288831019]);
  expect(latestAttemptPerCheck([twin, real]).map(c => c.id)).toEqual([126288831019]);

  const partition = partitionChecksByRequired([real, twin], [GATE]);
  expect(partition.gating).toHaveLength(1);
  expect(partition.gating[0]?.conclusion).toBe('success');
});

test('twin job: a real failure is not masked by a newer skipped twin', () => {
  const real = run(126188364537, 'failure');
  const twin = run(126188367041, 'skipped');
  const kept = latestAttemptPerCheck([real, twin]);
  expect(kept.map(c => c.conclusion)).toEqual(['failure']);

  // Before the fix the skipped twin was kept, and skipped counts as passing.
  expect(namedBlockingChecksAreGreen([real, twin], [GATE])).toBe(false);

  const gated = applyRequiredCheckGate(
    { verdict: 'APPROVE' as const, findings: [] },
    partitionChecksByRequired([real, twin], [GATE])
  );
  expect(gated.verdict).toBe('REQUEST_CHANGES');
  expect(gated.findings.map(f => f.scope)).toEqual([`checks/${GATE}`]);
});

test('only skipped runs: the check stays skipped (newest skipped kept)', () => {
  const older = run(100, 'skipped');
  const newer = run(200, 'skipped');
  const kept = latestAttemptPerCheck([newer, older]);
  expect(kept.map(c => c.id)).toEqual([200]);
  expect(kept[0]?.conclusion).toBe('skipped');
});

test('rerun among non-skipped runs: newest attempt still wins', () => {
  const firstFail = run(300, 'failure');
  const rerunPass = run(400, 'success');
  expect(latestAttemptPerCheck([firstFail, rerunPass]).map(c => c.id)).toEqual([400]);

  const firstPass = run(500, 'success');
  const rerunFail = run(600, 'failure');
  expect(latestAttemptPerCheck([rerunFail, firstPass]).map(c => c.id)).toEqual([600]);
});

test('a non-skipped run still in progress outranks a skipped twin', () => {
  const pending = run(700, null, 'in_progress');
  const twin = run(800, 'skipped');
  const kept = latestAttemptPerCheck([pending, twin]);
  expect(kept.map(c => c.id)).toEqual([700]);
  expect(namedBlockingChecksAreGreen([pending, twin], [GATE])).toBe(false);
});

test('different check names are never merged by the twin rule', () => {
  const gate = run(126288831019, 'success');
  const other: PrReviewCheck = { ...run(126288833084, 'skipped'), name: 'CE Regression Gate' };
  expect(
    latestAttemptPerCheck([gate, other])
      .map(c => c.id)
      .sort()
  ).toEqual([126288831019, 126288833084]);
});
