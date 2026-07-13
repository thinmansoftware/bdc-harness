import { describe, expect, test } from 'bun:test';
import { judgeWithGrok, parseGrokVerdict } from '../judge-second-opinion.ts';
import type { GrokJudgeEvidence } from '../types.ts';

const evidence: GrokJudgeEvidence = {
  woId: 'WO-TEST-01',
  prNumber: 12,
  prTitle: 'Add overseer merge judge',
  checksSummary: { total: 3, passed: 3, failed: 0, pending: 0 },
  filesChangedCount: 4,
  diffStat: '+120 -8',
};

describe('grok second-opinion judge', () => {
  test('parses VERDICT: APPROVE as approve', async () => {
    await expect(
      judgeWithGrok(evidence, {
        spawn: async () => ({ exitCode: 0, stdout: 'VERDICT: APPROVE\n', timedOut: false }),
      })
    ).resolves.toBe('approve');
  });

  test('parses VERDICT: HOLD as hold', async () => {
    await expect(
      judgeWithGrok(evidence, {
        spawn: async () => ({ exitCode: 0, stdout: 'VERDICT: HOLD\n', timedOut: false }),
      })
    ).resolves.toBe('hold');
  });

  test('treats garbage, empty, and malformed verdicts as hold', () => {
    expect(parseGrokVerdict('APPROVE')).toBe('hold');
    expect(parseGrokVerdict('')).toBe('hold');
    expect(parseGrokVerdict('VERDICT: MAYBE')).toBe('hold');
  });

  test('treats missing grok CLI as hold without throwing', async () => {
    await expect(
      judgeWithGrok(evidence, {
        spawn: async () => {
          throw new Error('ENOENT');
        },
      })
    ).resolves.toBe('hold');
  });

  test('treats grok timeout as hold', async () => {
    await expect(
      judgeWithGrok(evidence, {
        timeoutMs: 1,
        spawn: async () => ({ exitCode: 124, stdout: '', timedOut: true }),
      })
    ).resolves.toBe('hold');
  });

  test('treats non-zero grok exit as hold', async () => {
    await expect(
      judgeWithGrok(evidence, {
        spawn: async () => ({ exitCode: 1, stdout: 'VERDICT: APPROVE\n', timedOut: false }),
      })
    ).resolves.toBe('hold');
  });
});
