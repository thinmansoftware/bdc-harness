/**
 * gateway.test.ts -- Gateway seam unit tests
 *
 * Verifies that the ModelGateway abstraction works correctly with a stub backend.
 * Tests that round-runner and synthesis work when a stub callModel is injected --
 * proving the abstraction, not OpenRouter coupling.
 *
 * Scenario 4 from WO spec: "a unit test swaps the OpenRouter backend for a stub
 * callModel and the round-runner/synthesis still works."
 */

import { describe, it, expect } from 'bun:test';
import { runRound1, runSynthesizer, buildInputMd } from '../rounds.js';
import type {
  FusionConfig,
  FusionInputs,
  ModelCallRequest,
  ModelCallResult,
  ModelGateway,
} from '../types.js';

// Minimal config for testing
const TEST_CONFIG: FusionConfig = {
  reviewers: [
    {
      id: 'test-reviewer',
      modelId: 'test/model-a',
      role: 'test-architecture',
      promptTemplate: 'reviewer-architecture.txt',
    },
  ],
  synthesizer: {
    modelId: 'test/synthesizer',
    promptTemplate: 'synthesizer.txt',
  },
  enableRound2: false,
};

function makeStubGateway(responseText: string, servedModelId: string): ModelGateway {
  return async (_req: ModelCallRequest): Promise<ModelCallResult> => ({
    text: responseText,
    servedModelId,
    usage: { inputTokens: 5, outputTokens: 10, totalTokens: 15 },
    ok: true,
    error: null,
  });
}

function buildTestInputMd(): string {
  const inputs: FusionInputs = {
    woId: 'WO-TEST-001',
    woSpec: 'Test WO spec',
    diff: 'diff --git a/test.ts\n+// new line',
    tests: '1 test passed',
    manifest: '{"WO":"WO-TEST-001"}',
    captainCi: '',
  };
  const { inputMd } = buildInputMd(inputs);
  return inputMd;
}

describe('gateway abstraction -- stub injection', () => {
  it('round1 uses injected stub gateway (not real callModel)', async () => {
    const capturedRequests: ModelCallRequest[] = [];
    const stubGateway: ModelGateway = async req => {
      capturedRequests.push(req);
      return {
        text: 'Stub reviewer response: no issues found.',
        servedModelId: 'stub/reviewer-model',
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        ok: true,
        error: null,
      };
    };

    const inputMd = buildTestInputMd();
    const results = await runRound1(TEST_CONFIG, inputMd, stubGateway);

    // Verify the stub was called (not real OpenRouter)
    expect(capturedRequests.length).toBe(1);
    expect(capturedRequests[0]!.modelId).toBe('test/model-a');
    expect(results.length).toBe(1);
    expect(results[0]!.ok).toBe(true);
    expect(results[0]!.servedModelId).toBe('stub/reviewer-model');
    expect(results[0]!.text).toContain('Stub reviewer response');
  });

  it('synthesizer uses injected stub gateway', async () => {
    const inputMd = buildTestInputMd();
    const reviewerResults = [
      {
        id: 'test-reviewer',
        requestedModelId: 'test/model-a',
        servedModelId: 'stub/reviewer',
        ok: true,
        error: null,
        text: 'All looks good.',
        tokens: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      },
    ];

    const synthStub = makeStubGateway('Stub synthesis complete.', 'stub/synth-model');
    const result = await runSynthesizer(TEST_CONFIG, reviewerResults, [], inputMd, synthStub);

    expect(result.ok).toBe(true);
    expect(result.servedModelId).toBe('stub/synth-model');
    expect(result.text).toContain('Stub synthesis complete');
  });

  it('gateway result carries servedModelId through to ReviewerResult', async () => {
    const gateway = makeStubGateway('Reviewer output text.', 'actual/served-model-xyz');
    const inputMd = buildTestInputMd();
    const results = await runRound1(TEST_CONFIG, inputMd, gateway);

    expect(results[0]!.servedModelId).toBe('actual/served-model-xyz');
    expect(results[0]!.requestedModelId).toBe('test/model-a');
    // Served model captured separately from requested -- this is the INTEGRITY check
    expect(results[0]!.servedModelId).not.toBe(results[0]!.requestedModelId);
  });

  it('ok=false when gateway returns empty text', async () => {
    const emptyGateway: ModelGateway = async () => ({
      text: '',
      servedModelId: 'test/model',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      ok: false,
      error: 'Model returned empty response',
    });

    const inputMd = buildTestInputMd();
    const results = await runRound1(TEST_CONFIG, inputMd, emptyGateway);

    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.error).toBeDefined();
  });
});
