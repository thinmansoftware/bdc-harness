import { describe, expect, test } from 'bun:test';
import { buildAgentInvocation, defaultAgentConfigs, parseFusionReviewBody } from './adapters';

describe('dispatch worker adapters', () => {
  test('ships read-only invocation contracts for installed desktop agents', () => {
    expect(buildAgentInvocation(defaultAgentConfigs.claude).args).toContain('plan');
    expect(buildAgentInvocation(defaultAgentConfigs.codex).args).toContain('read-only');
    expect(buildAgentInvocation(defaultAgentConfigs.grok).args).toContain('plan');
    expect(buildAgentInvocation(defaultAgentConfigs.cursor).args).toContain('ask');
  });

  test('never places prompt text into argv for prompt-kind seats', () => {
    // WO-HARNESS-DISPATCH-STDIN-PROMPT-01 (M-126 Q2): argv delivery of the
    // prompt was removed outright. The prompt now travels over stdin, so no
    // seat config may carry a substitution placeholder and buildAgentInvocation
    // must never inject prompt text into argv.
    const promptSamples = ['summarize; git push && deploy', 'Reply with exactly: ROUND_TRIP_OK'];
    for (const name of ['claude', 'codex', 'grok', 'cursor']) {
      const config = defaultAgentConfigs[name];
      const invocation = buildAgentInvocation(config);
      // No leftover placeholder in the static config...
      expect(config.args, `${name} args must not carry {{prompt}}`).not.toContain('{{prompt}}');
      // ...and the built argv is exactly the static flags, with no prompt text.
      expect(invocation.args, `${name} argv must equal static flags`).toEqual(config.args);
      for (const sample of promptSamples) {
        for (const arg of invocation.args) {
          expect(arg, `${name} argv element must not contain prompt text`).not.toContain(sample);
        }
      }
    }
    expect(buildAgentInvocation(defaultAgentConfigs.codex).command).toBe('codex');
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
