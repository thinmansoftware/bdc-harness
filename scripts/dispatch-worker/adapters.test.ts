import { describe, expect, test } from 'bun:test';
import {
  assertNoLegacyPromptPlaceholder,
  buildAgentInvocation,
  defaultAgentConfigs,
  parseFusionReviewBody,
  seatPromptDelivery,
  STDIN_PROMPT_SEATS,
  type AgentConfig,
} from './adapters';

describe('dispatch worker adapters', () => {
  test('ships read-only invocation contracts for installed desktop agents', () => {
    // stdin seats need no prompt; argv seats (grok/cursor) require one to
    // substitute into the {{prompt}} placeholder.
    expect(buildAgentInvocation('claude', defaultAgentConfigs.claude).args).toContain('plan');
    expect(buildAgentInvocation('codex', defaultAgentConfigs.codex).args).toContain('read-only');
    expect(buildAgentInvocation('grok', defaultAgentConfigs.grok, 'ping').args).toContain('plan');
    expect(buildAgentInvocation('cursor', defaultAgentConfigs.cursor, 'ping').args).toContain(
      'ask'
    );
  });

  test('claude and codex deliver the prompt over stdin, never in argv', () => {
    // WO-HARNESS-DISPATCH-STDIN-PROMPT-01 Scope IN (M-126 Q2): argv delivery is
    // hard-removed for the claude/codex seats. Their static args carry no
    // {{prompt}} placeholder and the prompt never enters argv.
    const promptSamples = ['summarize; git push && deploy', 'Reply with exactly: ROUND_TRIP_OK'];
    for (const name of ['claude', 'codex']) {
      const config = defaultAgentConfigs[name];
      // No placeholder in the static config...
      expect(config.args, `${name} args must not carry {{prompt}}`).not.toContain('{{prompt}}');
      expect(seatPromptDelivery(name), `${name} must use stdin delivery`).toBe('stdin');
      const invocation = buildAgentInvocation(name, config);
      expect(invocation.delivery, `${name} invocation delivery`).toBe('stdin');
      // ...and the built argv is exactly the static flags, with no prompt text.
      expect(invocation.args, `${name} argv must equal static flags`).toEqual(config.args);
      for (const sample of promptSamples) {
        for (const arg of invocation.args) {
          expect(arg, `${name} argv element must not contain prompt text`).not.toContain(sample);
        }
      }
    }
    expect(buildAgentInvocation('codex', defaultAgentConfigs.codex).command).toBe('codex');
  });

  test('grok and cursor remain argv-cliffed: prompt is one substituted argv element', () => {
    // WO-HARNESS-DISPATCH-STDIN-PROMPT-01 Scope OUT (board Q3): grok/cursor CLIs
    // are not proven stdin-capable, so their transport is intentionally
    // UNCHANGED. They retain the {{prompt}} placeholder and receive the prompt
    // via argv as one element (no shell interpolation / splitting).
    const prompt = 'summarize; git push && deploy';
    for (const name of ['grok', 'cursor']) {
      const config = defaultAgentConfigs[name];
      expect(config.args, `${name} must retain the argv placeholder`).toContain('{{prompt}}');
      expect(seatPromptDelivery(name), `${name} must use argv delivery`).toBe('argv');
      const invocation = buildAgentInvocation(name, config, prompt);
      expect(invocation.delivery, `${name} invocation delivery`).toBe('argv');
      // The raw placeholder is fully replaced -- none survives in argv.
      expect(invocation.args, `${name} argv must not keep the raw placeholder`).not.toContain(
        '{{prompt}}'
      );
      // The prompt appears exactly once, as a single argv element.
      const hits = invocation.args.filter(arg => arg === prompt);
      expect(hits.length, `${name} must place the prompt as one argv element`).toBe(1);
    }
    // An argv-delivery seat with no prompt supplied is a programming error.
    expect(() => buildAgentInvocation('grok', defaultAgentConfigs.grok)).toThrow(
      'argv_delivery_seat_requires_prompt'
    );
  });

  test('argv delivery is hard-removed for claude/codex -- config cannot re-enable it', () => {
    // Final-review regression (M-126 Q2): transport must be a property of the
    // SEAT IDENTITY, not of config content. readConfig merges operator config
    // over the defaults wholesale, so if the {{prompt}} placeholder acted as a
    // transport switch, a drifted config could silently put the prompt back in
    // argv and resurrect the process-list leak + Windows argv size cliff.
    const prompt = 'summarize; git push && deploy';

    for (const seat of ['claude', 'codex']) {
      // A drifted config that re-adds the legacy placeholder...
      const drifted: AgentConfig = {
        command: seat,
        args: ['--flag', '{{prompt}}'],
      };
      // ...must NOT flip the seat to argv.
      expect(seatPromptDelivery(seat), `${seat} stays stdin under any config`).toBe('stdin');
      // ...and must be rejected outright rather than absorbed. This covers both
      // failure modes: silent argv restore AND leaking the literal placeholder.
      expect(
        () => buildAgentInvocation(seat, drifted, prompt),
        `${seat} must reject a configured {{prompt}}`
      ).toThrow(/stdin/);
      expect(() => assertNoLegacyPromptPlaceholder(seat, drifted)).toThrow(/stdin/);

      // A clean override still works and never carries prompt text in argv.
      const clean: AgentConfig = { command: seat, args: ['--flag'] };
      const inv = buildAgentInvocation(seat, clean, prompt);
      expect(inv.delivery).toBe('stdin');
      expect(inv.args).toEqual(['--flag']);
      expect(inv.args).not.toContain(prompt);
    }

    // The hard-removal set is exactly the Scope IN seats -- out-of-scope seats
    // keep their pre-WO argv transport.
    expect([...STDIN_PROMPT_SEATS].sort()).toEqual(['claude', 'codex']);
    for (const seat of ['grok', 'cursor']) {
      expect(seatPromptDelivery(seat)).toBe('argv');
      expect(() => assertNoLegacyPromptPlaceholder(seat, defaultAgentConfigs[seat])).not.toThrow();
    }
  });

  test('operator-defined seats keep the pre-WO argv behavior (scope wall)', () => {
    // Scope OUT: an unknown/custom CLI is not proven stdin-capable, so it must
    // behave exactly as before this WO -- argv substitution, no literal
    // placeholder surviving.
    const prompt = 'do the thing';
    const legacy: AgentConfig = { command: 'legacy-cli', args: ['--go', '{{prompt}}'] };
    const inv = buildAgentInvocation('legacy-cli', legacy, prompt);
    expect(inv.delivery).toBe('argv');
    expect(inv.args).toEqual(['--go', prompt]);
    expect(inv.args, 'literal placeholder must never survive').not.toContain('{{prompt}}');
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
