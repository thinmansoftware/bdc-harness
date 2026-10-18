import { describe, expect, it } from 'bun:test';
import OpenAI from 'openai';
import {
  evidenceHash,
  validateReviewEvidence,
  type ReviewBinding,
  type TrustedCheck,
} from './restricted-review-evidence';
import {
  REVIEW_ENDPOINT,
  REVIEW_MODEL,
  REVIEW_SYSTEM,
  REVIEW_DIGEST,
} from './restricted-review-policy';
import { buildRestrictedReviewWire } from './restricted-review-wire';

function fixture(): Parameters<typeof validateReviewEvidence>[0] {
  const binding: ReviewBinding = {
    runId: 'run-1',
    nodeId: 'review',
    attempt: 1,
    baseCommit: '1'.repeat(40),
    headCommit: '2'.repeat(40),
    sourceTree: '3'.repeat(40),
    authorityHash: 'sha256:' + '4'.repeat(64),
    policyHash: 'sha256:' + '5'.repeat(64),
    builderImage: 'sha256:' + '6'.repeat(64),
    testImage: 'sha256:' + '7'.repeat(64),
    reviewerImage: 'sha256:' + '8'.repeat(64),
    reviewerSource: '9'.repeat(40),
    reviewerModelDigest: REVIEW_DIGEST,
    reviewerSchemaHash: 'b'.repeat(64),
    workerAttemptId: 'worker-1',
    snapshotManifestHash: 'c'.repeat(64),
  };
  const check: TrustedCheck = {
    id: 'behavior',
    commandHash: evidenceHash('bun test behavior.test.ts'),
    sourceTree: binding.sourceTree,
    image: binding.testImage,
    exitCode: 0,
    termination: 'completed',
    truncated: false,
    skipped: 0,
    assertions: 4,
    output: 'Synthetic receipt fixture: 4 assertions passed',
    outputHash: evidenceHash('Synthetic receipt fixture: 4 assertions passed'),
  };
  const checks = [check];
  const packageText = JSON.stringify({
    complete: true,
    artifacts: [
      {
        id: 'spec',
        content: 'Synthetic foundation specification',
        sha256: evidenceHash('Synthetic foundation specification'),
      },
      {
        id: 'diff',
        content: 'Synthetic complete source diff',
        sha256: evidenceHash('Synthetic complete source diff'),
      },
      {
        id: 'tests',
        content: JSON.stringify(checks),
        sha256: evidenceHash(JSON.stringify(checks)),
      },
    ],
  });
  const payload = {
    model: REVIEW_MODEL,
    stream: true,
    max_tokens: 1024,
    messages: [
      {
        role: 'system',
        content:
          REVIEW_SYSTEM + '\nCurrent date: 2026-10-18\nCurrent working directory: /workspace',
      },
      { role: 'user', content: packageText },
    ],
  };
  binding.reviewerSchemaHash = buildRestrictedReviewWire(JSON.stringify(payload)).schemaHash;
  return {
    binding,
    expectedBinding: { ...binding },
    packageText,
    serializedSdkRequest: JSON.stringify(payload),
    requiredChecks: [{ id: check.id, commandHash: check.commandHash }],
    checks,
    envelope: {
      binding: { ...binding },
      packageHash: evidenceHash(packageText),
      events: [
        {
          type: 'result',
          normalCompletion: true,
          isError: false,
          verdictText: JSON.stringify({
            verdict: 'APPROVED',
            reasons: ['All synthetic evidence is consistent'],
            evidenceIds: ['spec', 'diff', 'tests'],
          }),
        },
      ],
    },
  };
}

describe('unregistered trusted review evidence validator', () => {
  it('returns a bound candidate for complete consistent evidence', () => {
    const input = fixture();
    const result = validateReviewEvidence(input);
    expect(result.verdict).toBe('APPROVED');
    expect(result.packageHash).toBe(evidenceHash(input.packageText));
    expect(result.bindingHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.wireBytes).toBeLessThanOrEqual(6000);
  });
  it('rejects every changed run, source, image, policy and snapshot identity', () => {
    for (const key of Object.keys(fixture().binding) as Array<keyof ReviewBinding>) {
      const input = fixture();
      const changed = { ...input.envelope.binding };
      if (key === 'attempt') changed.attempt = 2;
      else changed[key] = String(changed[key]).replace(/.$/, 'd');
      input.envelope.binding = changed;
      expect(() => validateReviewEvidence(input)).toThrow();
    }
  });
  it('rejects missing and duplicated required checks', () => {
    for (const shape of ['empty', 'missing', 'duplicate', 'foreign']) {
      const input = fixture();
      if (shape === 'empty') input.requiredChecks = [];
      if (shape === 'missing') input.checks = [];
      if (shape === 'duplicate')
        input.requiredChecks = [...input.requiredChecks, ...input.requiredChecks];
      if (shape === 'foreign') input.checks = [{ ...input.checks[0]!, id: 'foreign' }];
      expect(() => validateReviewEvidence(input)).toThrow();
    }
  });
  it('rejects mutually matching bindings with a foreign schema or reviewer model', () => {
    for (const key of ['reviewerSchemaHash', 'reviewerModelDigest'] as const) {
      const input = fixture();
      input.binding[key] =
        input.expectedBinding[key] =
        input.envelope.binding[key] =
          'd'.repeat(64);
      expect(() => validateReviewEvidence(input)).toThrow('reviewer schema or model');
    }
    const input = fixture();
    input.binding.policyHash =
      input.expectedBinding.policyHash =
      input.envelope.binding.policyHash =
        'd'.repeat(64);
    expect(() => validateReviewEvidence(input)).toThrow('source identity');
  });
  it('rejects failed, incomplete, altered and foreign-source test receipts', () => {
    const variants: Array<Partial<TrustedCheck>> = [
      { exitCode: 1 },
      { termination: 'timeout' },
      { termination: 'aborted' },
      { truncated: true },
      { skipped: 1 },
      { assertions: 0 },
      { assertions: NaN },
      { output: 'changed output' },
      { sourceTree: 'd'.repeat(40) },
      { image: 'sha256:' + 'd'.repeat(64) },
      { commandHash: 'd'.repeat(64) },
    ];
    for (const change of variants) {
      const input = fixture();
      input.checks = [{ ...input.checks[0]!, ...change }];
      expect(() => validateReviewEvidence(input)).toThrow();
    }
  });
  it('rejects tampered artifacts and different package contents on the wire', () => {
    const input = fixture();
    input.packageText = input.packageText.replace(
      'foundation specification',
      'altered specification'
    );
    expect(() => validateReviewEvidence(input)).toThrow();
    const second = fixture();
    const body = JSON.parse(second.serializedSdkRequest);
    body.messages[1].content = 'different';
    second.serializedSdkRequest = JSON.stringify(body);
    expect(() => validateReviewEvidence(second)).toThrow('wire package');
  });
  it('rejects model summaries instead of complete trusted receipts', () => {
    const input = fixture();
    const pack = JSON.parse(input.packageText);
    pack.artifacts[2].content = 'All tests passed';
    pack.artifacts[2].sha256 = evidenceHash(pack.artifacts[2].content);
    input.packageText = JSON.stringify(pack);
    const body = JSON.parse(input.serializedSdkRequest);
    body.messages[1].content = input.packageText;
    input.serializedSdkRequest = JSON.stringify(body);
    input.envelope.packageHash = evidenceHash(input.packageText);
    expect(() => validateReviewEvidence(input)).toThrow('trusted receipts');
  });
  it('rejects stale, duplicate, malformed and unsuccessful terminals', () => {
    for (const variant of [
      'hash',
      'duplicate',
      'tool',
      'fallback',
      'incomplete',
      'error',
      'malformed',
      'rejected',
    ]) {
      const input = fixture();
      if (variant === 'hash') input.envelope.packageHash = 'd'.repeat(64);
      if (variant === 'duplicate') input.envelope.events.push(input.envelope.events[0]!);
      if (variant === 'tool' || variant === 'fallback') input.envelope.events[0]!.type = variant;
      if (variant === 'incomplete') input.envelope.events[0]!.normalCompletion = false;
      if (variant === 'error') input.envelope.events[0]!.isError = true;
      if (variant === 'malformed') input.envelope.events[0]!.verdictText = 'APPROVED';
      if (variant === 'rejected')
        input.envelope.events[0]!.verdictText = JSON.stringify({
          verdict: 'REJECTED',
          reasons: ['Reject fixture'],
          evidenceIds: ['tests'],
        });
      expect(() => validateReviewEvidence(input)).toThrow();
    }
  });
  it('enforces the UTF-8 size of the final schema-injected wire', () => {
    const input = fixture();
    const body = JSON.parse(input.serializedSdkRequest);
    const base = buildRestrictedReviewWire(JSON.stringify(body)).bytes;
    body.messages[1].content += 'x'.repeat(6000 - base);
    expect(buildRestrictedReviewWire(JSON.stringify(body)).bytes).toBe(6000);
    body.messages[1].content += String.fromCharCode(233);
    expect(() => buildRestrictedReviewWire(JSON.stringify(body))).toThrow('final review wire');
  });
  it('validates the real installed OpenAI SDK request before upstream delivery', async () => {
    const input = fixture();
    const payload = JSON.parse(input.serializedSdkRequest);
    let validated = false;
    const client = new OpenAI({
      apiKey: 'local-no-auth',
      baseURL: REVIEW_ENDPOINT + '/v1',
      maxRetries: 0,
      fetch: (async (raw: Request | string | URL, init?: RequestInit) => {
        const request =
          raw instanceof Request ? new Request(raw, init) : new Request(String(raw), init);
        const actual = await request.text();
        const candidate = validateReviewEvidence({ ...input, serializedSdkRequest: actual });
        expect(candidate.verdict).toBe('APPROVED');
        validated = true;
        return new Response('data: [DONE]\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        });
      }) as typeof fetch,
    });
    const stream = await client.chat.completions.create(payload);
    for await (const _item of stream) {
      /* Synthetic stream ends immediately. */
    }
    expect(validated).toBe(true);
  });
});
