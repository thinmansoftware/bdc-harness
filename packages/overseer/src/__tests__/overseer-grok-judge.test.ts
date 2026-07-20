import { describe, expect, test } from 'bun:test';
import { createXaiGrokMergeJudge, parseXaiGrokVerdict } from '../overseer-grok-judge.ts';
import type { GrokJudgeEvidence } from '../types.ts';

const evidence: GrokJudgeEvidence = {
  woId: 'WO-TEST-01',
  prNumber: 12,
  prTitle: 'Add coordinator',
  headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
  evidenceDigest: 'c'.repeat(64),
  operator: { identity: 'grok-overseer', provider: 'xai', modelFamily: 'grok' },
  checksSummary: { total: 1, passed: 1, failed: 0, pending: 0 },
  filesChangedCount: 2,
  diffStat: '+3 -1',
};

describe('xAI Grok merge judge', () => {
  test('parses exact verdict lines only', () => {
    expect(parseXaiGrokVerdict('VERDICT: APPROVE')).toBe('approve');
    expect(parseXaiGrokVerdict('VERDICT: HOLD')).toBe('hold');
    expect(parseXaiGrokVerdict('APPROVE')).toBe('invalid');
    expect(parseXaiGrokVerdict('VERDICT: APPROVE\nextra')).toBe('invalid');
  });

  test('approves only on a valid xAI approve response', async () => {
    const judge = createXaiGrokMergeJudge({
      apiKey: 'test-key',
      fetch: async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: 'VERDICT: APPROVE' } }] }), {
          status: 200,
        }),
    });
    await expect(judge(evidence)).resolves.toMatchObject({
      disposition: 'approve',
      reason: 'judge_approve',
      woId: evidence.woId,
      evidenceDigest: evidence.evidenceDigest,
    });
  });

  test('transport failure fails closed to HOLD without throwing', async () => {
    const judge = createXaiGrokMergeJudge({
      apiKey: 'test-key',
      fetch: async () => {
        throw new Error('network down');
      },
    });
    await expect(judge(evidence)).resolves.toMatchObject({
      disposition: 'hold',
      reason: 'judge_error',
    });
  });

  test('malformed model output fails closed to HOLD', async () => {
    const judge = createXaiGrokMergeJudge({
      apiKey: 'test-key',
      fetch: async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: 'APPROVE' } }] }), {
          status: 200,
        }),
    });
    await expect(judge(evidence)).resolves.toMatchObject({
      disposition: 'hold',
      reason: 'judge_output_invalid',
    });
  });
});
