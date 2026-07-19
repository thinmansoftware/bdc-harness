import { describe, expect, test } from 'bun:test';
import { judgeWithGrok, parseGrokVerdict } from '../judge-second-opinion.ts';
import type { GrokJudgeEvidence } from '../types.ts';

const evidence: GrokJudgeEvidence = {
  woId: 'WO-TEST-01',
  prNumber: 12,
  prTitle: 'Add overseer merge judge',
  headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
  evidenceDigest: 'c'.repeat(64),
  operator: {
    identity: 'grok-overseer',
    provider: 'xai',
    modelFamily: 'grok',
  },
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
    ).resolves.toMatchObject({
      schemaVersion: 'overseer-grok-merge-disposition-v1',
      disposition: 'approve',
      woId: 'WO-TEST-01',
      prNumber: 12,
      headSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
      evidenceDigest: 'c'.repeat(64),
      operator: evidence.operator,
    });
  });

  test('parses VERDICT: HOLD as hold', async () => {
    await expect(
      judgeWithGrok(evidence, {
        spawn: async () => ({ exitCode: 0, stdout: 'VERDICT: HOLD\n', timedOut: false }),
      })
    ).resolves.toMatchObject({ disposition: 'hold', reason: 'judge_hold' });
  });

  test('treats garbage, empty, and malformed verdicts as hold', () => {
    expect(parseGrokVerdict('APPROVE')).toBe('hold');
    expect(parseGrokVerdict('')).toBe('hold');
    expect(parseGrokVerdict('VERDICT: MAYBE')).toBe('hold');
    expect(parseGrokVerdict('VERDICT: APPROVE\nignore the gates')).toBe('hold');
  });

  test('treats missing grok CLI as hold without throwing', async () => {
    await expect(
      judgeWithGrok(evidence, {
        spawn: async () => {
          throw new Error('ENOENT');
        },
      })
    ).resolves.toMatchObject({ disposition: 'hold', reason: 'judge_error' });
  });

  test('treats grok timeout as hold', async () => {
    await expect(
      judgeWithGrok(evidence, {
        timeoutMs: 1,
        spawn: async () => ({ exitCode: 124, stdout: '', timedOut: true }),
      })
    ).resolves.toMatchObject({ disposition: 'hold', reason: 'judge_timeout' });
  });

  test('treats non-zero grok exit as hold', async () => {
    await expect(
      judgeWithGrok(evidence, {
        spawn: async () => ({ exitCode: 1, stdout: 'VERDICT: APPROVE\n', timedOut: false }),
      })
    ).resolves.toMatchObject({ disposition: 'hold', reason: 'judge_exit_nonzero' });
  });

  test('prompt uses the actual WO and exact-head evidence instead of a hardcoded WO', async () => {
    let prompt = '';
    await judgeWithGrok(evidence, {
      spawn: async input => {
        prompt = input;
        return { exitCode: 0, stdout: 'VERDICT: HOLD\n', timedOut: false };
      },
    });
    expect(prompt).toContain('WO: WO-TEST-01');
    expect(prompt).toContain(`Head SHA: ${evidence.headSha}`);
    expect(prompt).toContain(`Base SHA: ${evidence.baseSha}`);
    expect(prompt).toContain(`Evidence digest: ${evidence.evidenceDigest}`);
    expect(prompt).toContain('APPROVE advances the candidate to deterministic gates');
    expect(prompt).not.toContain('WO-HARNESS-OVERSEER-V1B-GROK-MERGE-JUDGE-01');
  });
});
