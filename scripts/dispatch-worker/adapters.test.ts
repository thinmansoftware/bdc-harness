import { describe, expect, test } from 'bun:test';
import { buildAgentInvocation, defaultAgentConfigs, parseFusionReviewBody } from './adapters';

describe('dispatch worker adapters', () => {
  test('ships read-only invocation contracts for installed desktop agents', () => {
    const prompt = 'Reply with exactly: ROUND_TRIP_OK';
    expect(buildAgentInvocation(defaultAgentConfigs.claude, prompt).args).toContain('plan');
    expect(buildAgentInvocation(defaultAgentConfigs.codex, prompt).args).toContain('read-only');
    expect(buildAgentInvocation(defaultAgentConfigs.grok, prompt).args).toContain('plan');
    expect(buildAgentInvocation(defaultAgentConfigs.cursor, prompt).args).toContain('ask');
  });

  test('substitutes prompt as one argv element without shell interpolation', () => {
    const prompt = 'summarize; git push && deploy';
    const invocation = buildAgentInvocation(defaultAgentConfigs.codex, prompt);
    expect(invocation.args.at(-1)).toBe(prompt);
    expect(invocation.command).toBe('codex');
  });

  test('fusion accepts only a structured advisory review artifact set', () => {
    expect(
      parseFusionReviewBody(
        JSON.stringify({
          wo: 'C:/safe/wo.md',
          diff: 'C:/safe/diff.patch',
          tests: 'C:/safe/tests.txt',
          manifest: 'C:/safe/manifest.txt',
        })
      )
    ).toEqual({
      wo: 'C:/safe/wo.md',
      diff: 'C:/safe/diff.patch',
      tests: 'C:/safe/tests.txt',
      manifest: 'C:/safe/manifest.txt',
    });
    expect(() => parseFusionReviewBody('review this raw prompt')).toThrow(
      'fusion_review_body_invalid'
    );
  });
});
