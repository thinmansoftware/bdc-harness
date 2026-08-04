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

  test('keeps prompt text out of argv for every prompt-kind seat', () => {
    const prompt = 'summarize; git push && deploy';
    for (const seat of Object.values(defaultAgentConfigs)) {
      if ((seat.kind ?? 'prompt') !== 'prompt') continue;
      const invocation = buildAgentInvocation(seat, prompt);
      expect(invocation.args.every(arg => !arg.includes(prompt))).toBe(true);
    }
  });

  test('registers ACP seats without removing the CLI fallback (M-118 order 5)', () => {
    // The ruling forbids removing a working CLI/SDK fallback before its ACP
    // path proves equivalent auth and capabilities. Both must coexist.
    expect(defaultAgentConfigs.grok.kind ?? 'prompt').toBe('prompt');
    expect(defaultAgentConfigs.claude.kind ?? 'prompt').toBe('prompt');
    expect(defaultAgentConfigs['grok-acp']?.kind).toBe('acp');
    expect(defaultAgentConfigs['claude-acp']?.kind).toBe('acp');
  });

  test('grok ACP seat uses the proven stdio command and cached-token auth', () => {
    // Anchored to M-20260802-118.acp-compatibility-proof.md: `grok agent stdio`
    // authenticated via cached_token with no API key passed.
    const seat = defaultAgentConfigs['grok-acp'];
    expect(seat?.command).toBe('grok');
    expect(seat?.args).toEqual(['agent', 'stdio']);
    expect(seat?.acp?.authMethodId).toBe('cached_token');
  });

  test('ACP seats carry no inline credential material', () => {
    // Rule 6: a wrapper demanding a raw key is a finding to report, never a
    // secret to embed in argv or config.
    for (const [name, seat] of Object.entries(defaultAgentConfigs)) {
      if (seat.kind !== 'acp') continue;
      const argv = [seat.command, ...seat.args].join(' ');
      expect(argv, `${name} argv must not contain key-like material`).not.toMatch(
        /sk-|api[-_]?key|token=|Bearer /i
      );
    }
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
