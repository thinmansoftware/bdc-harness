/**
 * integrity.test.ts -- INTEGRITY: missing reviewer tests
 *
 * Scenario 2 from WO spec: "when a reviewer call errors or returns empty,
 * that reviewer is marked MISSING in the manifest and synthesis notes the
 * reduced panel -- the run does NOT silently count it as APPROVE."
 *
 * The GLM lesson: a reviewer that errored is NOT a valid review voice.
 * Missing reviewers MUST cause conservative ruling (no bare APPROVE).
 */

import { describe, it, expect } from 'bun:test';
import { buildManifest } from '../manifest.js';
import { buildSynthesisMd, REQUIRED_SECTIONS } from '../synthesis.js';
import { runRound1, buildInputMd } from '../rounds.js';
import type {
  FusionConfig,
  FusionInputs,
  ModelGateway,
  ReviewerResult,
  SynthesizerResult,
} from '../types.js';

const TWO_REVIEWER_CONFIG: FusionConfig = {
  reviewers: [
    {
      id: 'reviewer-a',
      modelId: 'test/model-a',
      role: 'architecture',
      promptTemplate: 'reviewer-architecture.txt',
    },
    {
      id: 'reviewer-b',
      modelId: 'test/model-b',
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

function buildTestInputMd(): string {
  const inputs: FusionInputs = {
    woId: 'WO-INTEGRITY-TEST',
    woSpec: 'Test WO spec for integrity tests',
    diff: 'diff --git a/test.ts\n+// change',
    tests: '2 tests passed',
    manifest: '{"WO":"WO-INTEGRITY-TEST","Tests":"2 passing / 2 total"}',
    captainCi: '',
  };
  const { inputMd } = buildInputMd(inputs);
  return inputMd;
}

describe('INTEGRITY -- missing reviewer path', () => {
  it('reviewer marked ok=false when gateway returns error', async () => {
    const mixedGateway: ModelGateway = async req => {
      if (req.modelId === 'test/model-a') {
        // reviewer-a succeeds
        return {
          text: 'reviewer-a response: looks good.',
          servedModelId: 'test/model-a',
          usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
          ok: true,
          error: null,
        };
      }
      // reviewer-b fails (simulates GLM lane error)
      return {
        text: '',
        servedModelId: null,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        ok: false,
        error: 'Connection timeout: model unavailable',
      };
    };

    const inputMd = buildTestInputMd();
    const results = await runRound1(TWO_REVIEWER_CONFIG, inputMd, mixedGateway);

    expect(results.length).toBe(2);

    const reviewerA = results.find(r => r.id === 'reviewer-a');
    const reviewerB = results.find(r => r.id === 'reviewer-b');

    expect(reviewerA!.ok).toBe(true);
    expect(reviewerB!.ok).toBe(false);
    expect(reviewerB!.error).toContain('Connection timeout');
    expect(reviewerB!.servedModelId).toBeNull();
  });

  it('manifest status is completed-with-missing-reviewers when any reviewer fails', () => {
    const reviewerResults: ReviewerResult[] = [
      {
        id: 'reviewer-a',
        requestedModelId: 'test/model-a',
        servedModelId: 'test/model-a',
        ok: true,
        error: null,
        text: 'OK review',
        tokens: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      },
      {
        id: 'reviewer-b',
        requestedModelId: 'test/model-b',
        servedModelId: null,
        ok: false,
        error: 'Empty response',
        text: '',
        tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      },
    ];

    const synthResult: SynthesizerResult = {
      modelId: 'test/synth',
      servedModelId: 'test/synth',
      ok: true,
      text: 'Synthesis output.',
    };

    const manifest = buildManifest({
      woId: 'WO-TEST',
      inputMdContents: 'test input',
      reviewerResults,
      synthesizerResult: synthResult,
      outputFiles: ['input.md', 'synthesis.md', 'manifest.json'],
    });

    expect(manifest.status).toBe('completed-with-missing-reviewers');

    // Missing reviewer has ok=false in manifest
    const missingEntry = manifest.reviewers.find(r => r.id === 'reviewer-b');
    expect(missingEntry!.ok).toBe(false);
    expect(missingEntry!.servedModelId).toBeNull();
  });

  it('synthesis does NOT produce bare APPROVE when reviewer is MISSING', () => {
    const reviewerResults: ReviewerResult[] = [
      {
        id: 'reviewer-a',
        requestedModelId: 'test/model-a',
        servedModelId: 'test/model-a',
        ok: true,
        error: null,
        text: 'No issues.',
        tokens: { inputTokens: 5, outputTokens: 10, totalTokens: 15 },
      },
      {
        id: 'reviewer-b',
        requestedModelId: 'test/model-b',
        servedModelId: null,
        ok: false,
        error: 'Timeout',
        text: '',
        tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      },
    ];

    // Synthesizer returns a bare APPROVE (should be overridden)
    const synthResult: SynthesizerResult = {
      modelId: 'test/synth',
      servedModelId: 'test/synth',
      ok: true,
      text:
        '## Final Ruling\n\nAPPROVE\n\n' +
        'All reviewers approved.\n\n' +
        '## Consensus Findings\n\nNo issues.\n\n' +
        '## Disagreements\n\nNo disagreements.\n\n' +
        '## Highest Risk\n\nNone.\n\n' +
        '## Must Fix Before Merge\n\nNone.\n\n' +
        '## Nice To Have Later\n\nNone.\n\n' +
        '## Scope Creep Warnings\n\nNone.\n\n' +
        '## Doctrine Boundary Check\n\nAll pass.\n\n' +
        '## Security / Tenant / PII Check\n\nNo issues.\n\n' +
        '## QA / Evidence Requirements\n\nTests pass.\n\n' +
        '## Suggested Builder Prompt\n\nN/A.\n\n' +
        '## John Approval Question\n\nShould this be merged?',
    };

    const synthesisMd = buildSynthesisMd({
      synthesizerResult: synthResult,
      reviewerResults,
      secretFindings: [],
      runId: 'test-run-id',
      woId: 'WO-TEST',
    });

    // Bare APPROVE must be overridden to HOLD
    const finalRulingMatch = synthesisMd.match(/## Final Ruling\s*\n+([^\n#]+)/);
    expect(finalRulingMatch).not.toBeNull();
    const ruling = finalRulingMatch![1]!.trim().toUpperCase();
    expect(ruling).toBe('HOLD');
    expect(synthesisMd).toContain('INTEGRITY OVERRIDE');
  });

  it('synthesis notes the reduced panel in the document', () => {
    const reviewerResults: ReviewerResult[] = [
      {
        id: 'reviewer-a',
        requestedModelId: 'test/model-a',
        servedModelId: 'test/model-a',
        ok: true,
        error: null,
        text: 'OK.',
        tokens: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
      },
      {
        id: 'reviewer-b',
        requestedModelId: 'test/model-b',
        servedModelId: null,
        ok: false,
        error: 'API error 503',
        text: '',
        tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      },
    ];

    const synthResult: SynthesizerResult = {
      modelId: 'test/synth',
      servedModelId: 'test/synth',
      ok: true,
      text:
        '## Final Ruling\n\nHOLD\n\n' +
        '## Consensus Findings\n\nNA\n\n' +
        '## Disagreements\n\nNA\n\n' +
        '## Highest Risk\n\nNA\n\n' +
        '## Must Fix Before Merge\n\nNA\n\n' +
        '## Nice To Have Later\n\nNA\n\n' +
        '## Scope Creep Warnings\n\nNA\n\n' +
        '## Doctrine Boundary Check\n\nNA\n\n' +
        '## Security / Tenant / PII Check\n\nNA\n\n' +
        '## QA / Evidence Requirements\n\nNA\n\n' +
        '## Suggested Builder Prompt\n\nNA\n\n' +
        '## John Approval Question\n\nNA',
    };

    const synthesisMd = buildSynthesisMd({
      synthesizerResult: synthResult,
      reviewerResults,
      secretFindings: [],
      runId: 'test-run-id-2',
      woId: 'WO-TEST',
    });

    // Header must show REDUCED PANEL
    expect(synthesisMd).toContain('REDUCED PANEL');
    expect(synthesisMd).toContain('1/2');
  });

  it('all 12 required sections present even when synthesizer partially fails', () => {
    const reviewerResults: ReviewerResult[] = [
      {
        id: 'reviewer-a',
        requestedModelId: 'test/model-a',
        servedModelId: null,
        ok: false,
        error: 'Timeout',
        text: '',
        tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      },
    ];

    // Synthesizer returns only partial output (missing some sections)
    const synthResult: SynthesizerResult = {
      modelId: 'test/synth',
      servedModelId: 'test/synth',
      ok: true,
      text: '## Final Ruling\n\nHOLD\n\n## Consensus Findings\n\nNone.\n',
    };

    const synthesisMd = buildSynthesisMd({
      synthesizerResult: synthResult,
      reviewerResults,
      secretFindings: [],
      runId: 'test-run-id-3',
      woId: 'WO-TEST',
    });

    // All 12 sections must be present
    for (const section of REQUIRED_SECTIONS) {
      expect(synthesisMd).toContain(`## ${section}`);
    }
  });
});
