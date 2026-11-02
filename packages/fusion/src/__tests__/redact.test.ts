/**
 * redact.test.ts -- Secret boundary tests (unit + integration)
 *
 * Scenario 3 from WO spec: "a diff containing an obvious secret pattern is
 * redacted before the model call AND surfaced as a finding."
 *
 * Two parts:
 *   a. Unit tests of redactSecrets() -- each pattern, clean input, findings
 *   b. Integration: round-runner never sends raw secrets to the gateway
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { redactSecrets } from '../redact.js';
import { buildInputMd, runRound1 } from '../rounds.js';
import { buildSynthesisMd } from '../synthesis.js';
import type {
  FusionConfig,
  FusionInputs,
  ModelCallRequest,
  ModelCallResult,
  ModelGateway,
  SynthesizerResult,
} from '../types.js';

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(THIS_DIR, '..', '..', 'fixtures');

// ---------------------------------------------------------------------------
// a. Unit tests of redactSecrets()
// ---------------------------------------------------------------------------

describe('redactSecrets() -- unit', () => {
  it('redacts OpenAI/generic API key (sk- prefix)', () => {
    const input = 'token=sk-abcdefghijklmnopqrstuvwxyz1234567890';
    const { redacted, findings } = redactSecrets(input);
    expect(redacted).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
    expect(redacted).toContain('[REDACTED SECRET]');
    expect(findings.length).toBeGreaterThan(0);
  });

  it('redacts OpenRouter API key (sk-or- prefix)', () => {
    const input = 'key=sk-or-v1-abcdefghijklmnopqrstuvwxyz12345678';
    const { redacted, findings } = redactSecrets(input);
    expect(redacted).not.toContain('sk-or-v1-');
    expect(redacted).toContain('[REDACTED SECRET]');
    expect(findings.length).toBeGreaterThan(0);
  });

  it('redacts JWT tokens', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fwpM';
    const input = `Authorization: Bearer ${jwt}`;
    const { redacted, findings } = redactSecrets(input);
    expect(redacted).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    expect(redacted).toContain('[REDACTED SECRET]');
    expect(findings.length).toBeGreaterThan(0);
  });

  it('redacts GitHub Personal Access Tokens (ghp_)', () => {
    const input = 'GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz1234567890123456';
    const { redacted, findings } = redactSecrets(input);
    expect(redacted).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz');
    expect(redacted).toContain('[REDACTED SECRET]');
    expect(findings.length).toBeGreaterThan(0);
  });

  it('redacts AWS Access Key IDs (AKIA)', () => {
    const input = 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE';
    const { redacted, findings } = redactSecrets(input);
    expect(redacted).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(redacted).toContain('[REDACTED SECRET]');
    expect(findings.length).toBeGreaterThan(0);
  });

  it('clean input passes through unchanged with empty findings', () => {
    const input = 'const x = 42;\nconst name = "hello world";';
    const { redacted, findings } = redactSecrets(input);
    expect(redacted).toBe(input);
    expect(findings.length).toBe(0);
  });

  it('findings array has one entry per match', () => {
    const input = 'key1=sk-aaaaaaaaaaaaaaaaaaaaaaaaa key2=sk-bbbbbbbbbbbbbbbbbbbbbbbbb';
    const { findings } = redactSecrets(input);
    expect(findings.length).toBe(2);
  });

  it('findings contain safe preview (first 8 chars + ...)', () => {
    const input = 'token=sk-abcdefghijklmnopqrstuvwxyz';
    const { findings } = redactSecrets(input);
    // Finding should contain a safe excerpt, not the full token
    expect(findings[0]).toContain('sk-abcde');
    expect(findings[0]).toContain('...');
    // Full token must NOT appear in findings
    expect(findings[0]).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
  });
});

// ---------------------------------------------------------------------------
// b. Integration: round-runner does not leak secrets to gateway
// ---------------------------------------------------------------------------

const SINGLE_REVIEWER_CONFIG: FusionConfig = {
  reviewers: [
    {
      id: 'test-reviewer',
      modelId: 'test/model',
      role: 'implementation',
      promptTemplate: 'reviewer-implementation.txt',
    },
  ],
  synthesizer: {
    modelId: 'test/synth',
    promptTemplate: 'synthesizer.txt',
  },
  enableRound2: false,
};

describe('redact integration -- round-runner never leaks secrets to gateway', () => {
  it('prompt sent to gateway does not contain raw secret from diff fixture', async () => {
    // Load the secret fixture diff
    const secretDiff = readFileSync(resolve(FIXTURES_DIR, 'sample-diff-with-secret.patch'), 'utf8');

    // Verify fixture actually contains a secret (test self-check)
    expect(secretDiff).toContain('sk-abcdefghijklmnopqrstuvwxyz');

    // Capture the prompt sent to the gateway
    let capturedPrompt = '';
    const capturingGateway: ModelGateway = async (
      req: ModelCallRequest
    ): Promise<ModelCallResult> => {
      capturedPrompt = req.prompt;
      return {
        text: 'Review complete.',
        servedModelId: 'test/model',
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        ok: true,
        error: null,
      };
    };

    const inputs: FusionInputs = {
      woId: 'WO-REDACT-TEST',
      woSpec: 'Test WO spec',
      diff: secretDiff,
      tests: '1 test passed',
      manifest: '{"WO":"WO-REDACT-TEST"}',
      captainCi: '',
    };

    const { inputMd, secretFindings } = buildInputMd(inputs);

    // Verify secrets were detected
    expect(secretFindings.length).toBeGreaterThan(0);
    expect(secretFindings.some(f => f.includes('REDACTED SECRET'))).toBe(true);

    // Run round 1 with the capturing gateway
    await runRound1(SINGLE_REVIEWER_CONFIG, inputMd, capturingGateway);

    // The prompt must NOT contain the raw secret
    expect(capturedPrompt).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
    // The prompt SHOULD contain the REDACTED marker
    expect(capturedPrompt).toContain('[REDACTED SECRET]');
  });

  it('synthesis.md Security section contains REDACTED SECRET when secrets found', () => {
    const secretFindings = ['REDACTED SECRET -- OpenAI/generic API key (sk-): sk-abcde...'];

    const synthResult: SynthesizerResult = {
      modelId: 'test/synth',
      servedModelId: 'test/synth',
      ok: true,
      text:
        '## Final Ruling\n\nHOLD\n\n' +
        '## Consensus Findings\n\nSecrets in diff.\n\n' +
        '## Disagreements\n\nNA\n\n' +
        '## Highest Risk\n\nSecret exposure.\n\n' +
        '## Must Fix Before Merge\n\nRemove secrets from source.\n\n' +
        '## Nice To Have Later\n\nNA\n\n' +
        '## Scope Creep Warnings\n\nNA\n\n' +
        '## Doctrine Boundary Check\n\nRule 6 violated.\n\n' +
        '## Security / Tenant / PII Check\n\nSecret found in diff.\n\n' +
        '## QA / Evidence Requirements\n\nNA\n\n' +
        '## Suggested Builder Prompt\n\nRemove secret and rotate.\n\n' +
        '## John Approval Question\n\nShould this be rejected?',
    };

    const synthesisMd = buildSynthesisMd({
      synthesizerResult: synthResult,
      reviewerResults: [
        {
          id: 'test-reviewer',
          requestedModelId: 'test/model',
          servedModelId: 'test/model',
          ok: true,
          error: null,
          text: 'Secret in diff.',
          tokens: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
        },
      ],
      secretFindings,
      runId: 'test-run-secret',
      woId: 'WO-REDACT-TEST',
    });

    // Security section must contain REDACTED SECRET
    expect(synthesisMd).toContain('REDACTED SECRET');
    // Full section must be present
    expect(synthesisMd).toContain('## Security / Tenant / PII Check');
  });
});
