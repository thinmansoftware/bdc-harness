import { describe, expect, test } from 'bun:test';
import { createXaiGrokJudge, parseXaiGrokVerdict } from '../adapters/grok-xai-judge';
import type { GrokJudgeEvidence } from '../types.ts';

const evidence: GrokJudgeEvidence = {
  woId: 'WO-TEST-01',
  prNumber: 12,
  prTitle: 'Add overseer merge judge',
  headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
  evidenceDigest: 'c'.repeat(64),
  operator: {
    identity: 'overseer-merge-coordinator',
    provider: 'xai',
    modelFamily: 'grok',
  },
  checksSummary: { total: 3, passed: 3, failed: 0, pending: 0 },
  filesChangedCount: 4,
  diffStat: '+120 -8',
};

describe('xAI Grok merge judge', () => {
  test('parses strict verdict lines only', () => {
    expect(parseXaiGrokVerdict('VERDICT: APPROVE\n')).toBe('approve');
    expect(parseXaiGrokVerdict('VERDICT: HOLD')).toBe('hold');
    expect(parseXaiGrokVerdict('APPROVE')).toBe('invalid');
    expect(parseXaiGrokVerdict('VERDICT: APPROVE\nextra')).toBe('invalid');
  });

  test('success path returns a bound approve receipt', async () => {
    const judge = createXaiGrokJudge({
      apiKey: 'xai-test',
      fetch: async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: 'VERDICT: APPROVE\n' } }] }),
          { status: 200 }
        ),
    }).judge;

    await expect(judge(evidence)).resolves.toMatchObject({
      schemaVersion: 'overseer-grok-merge-disposition-v1',
      disposition: 'approve',
      reason: 'judge_approve',
      woId: evidence.woId,
      prNumber: evidence.prNumber,
      headSha: evidence.headSha,
      baseSha: evidence.baseSha,
      evidenceDigest: evidence.evidenceDigest,
      operator: evidence.operator,
    });
  });

  test('non-2xx fails closed as hold', async () => {
    const judge = createXaiGrokJudge({
      apiKey: 'xai-test',
      fetch: async () => new Response('nope', { status: 503 }),
    }).judge;

    await expect(judge(evidence)).resolves.toMatchObject({
      disposition: 'hold',
      reason: 'judge_error',
    });
  });

  test('invalid model output fails closed without approve', async () => {
    const judge = createXaiGrokJudge({
      apiKey: 'xai-test',
      fetch: async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: 'yes merge it' } }] }), {
          status: 200,
        }),
    }).judge;

    const receipt = await judge(evidence);
    expect(receipt.disposition).toBe('hold');
    expect(receipt.reason).toBe('judge_output_invalid');
  });

  test('transport throw fails closed without propagating', async () => {
    const judge = createXaiGrokJudge({
      apiKey: 'xai-test',
      fetch: async () => {
        throw new Error('network');
      },
    }).judge;

    await expect(judge(evidence)).resolves.toMatchObject({
      disposition: 'hold',
      reason: 'judge_error',
    });
  });
});
