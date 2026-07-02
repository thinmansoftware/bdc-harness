/**
 * dissent.test.ts -- Synthesizer preserves reviewer dissent.
 *
 * WO-HARNESS-WAR-COUNCIL-PERSONA-ROSTER-01, spec Test 6:
 * "Given reviewer A says APPROVE and reviewer B says HOLD, synthesis must include
 * a Disagreements section and may not collapse the result to APPROVE without
 * explaining why."
 *
 * NAMING NOTE: spec 5.7 calls this section "Disagreements Between Reviewers".
 * The existing synthesis.ts implementation (REQUIRED_SECTIONS) uses the header
 * "## Disagreements". This test targets the actual header text -- no rename is
 * made to the shipped code. The two are the same concept.
 *
 * This test only ADDS coverage for the dissent-specific case; it does not change
 * synthesis.ts logic. It reuses the existing REQUIRED_SECTIONS enforcement.
 */

import { describe, it, expect } from 'bun:test';
import { buildSynthesisMd, REQUIRED_SECTIONS } from '../synthesis.js';
import type { ReviewerResult, SynthesizerResult } from '../types.js';

function reviewer(id: string, text: string): ReviewerResult {
  return {
    id,
    requestedModelId: 'test/' + id + '-model',
    servedModelId: 'test/' + id + '-model',
    ok: true,
    error: null,
    text,
    tokens: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  };
}

/** A synthesizer output that includes all 12 sections with a real dissent body. */
function synthWithDissent(disagreementBody: string): SynthesizerResult {
  const text =
    '## Final Ruling\n\nHOLD\n\nReviewers split; erring conservative.\n\n' +
    '## Consensus Findings\n\nBoth reviewed the same diff.\n\n' +
    '## Disagreements\n\n' +
    disagreementBody +
    '\n\n' +
    '## Highest Risk\n\nUnresolved reviewer split.\n\n' +
    '## Must Fix Before Merge\n\nResolve the HOLD.\n\n' +
    '## Nice To Have Later\n\nNone.\n\n' +
    '## Scope Creep Warnings\n\nNone.\n\n' +
    '## Doctrine Boundary Check\n\nPass.\n\n' +
    '## Security / Tenant / PII Check\n\nNo issues.\n\n' +
    '## QA / Evidence Requirements\n\nExisting tests.\n\n' +
    '## Suggested Builder Prompt\n\nAddress reviewer B.\n\n' +
    '## John Approval Question\n\nShould this PR be merged?';
  return { modelId: 'test/synth', servedModelId: 'test/synth', ok: true, text };
}

describe('synthesis dissent preservation -- spec Test 6', () => {
  const reviewers = [
    reviewer('architect', 'Verdict: APPROVE. Looks fine.'),
    reviewer('systems', 'Verdict: HOLD. Missing edge-case handling.'),
  ];

  it('preserves a populated Disagreements body verbatim', () => {
    const dissentBody =
      'Reviewer architect recommends APPROVE; reviewer systems recommends HOLD over an ' +
      'unhandled edge case. This split is unresolved.';
    const md = buildSynthesisMd({
      synthesizerResult: synthWithDissent(dissentBody),
      reviewerResults: reviewers,
      secretFindings: [],
      runId: 'test-run-dissent',
      woId: 'WO-DISSENT-TEST',
    });

    expect(md).toContain('## Disagreements');
    // The reviewer split text is not stripped or collapsed.
    expect(md).toContain(dissentBody);
    // Dissent must not be silently rewritten to a bare APPROVE.
    const rulingMatch = md.match(/## Final Ruling\s*\n+([^\n#]+)/);
    expect(rulingMatch).not.toBeNull();
    expect(rulingMatch![1]!.trim().toUpperCase()).not.toBe('APPROVE');
  });

  it('injects a placeholder Disagreements section when the synthesizer omits it', () => {
    // Synthesizer output missing the Disagreements section entirely.
    const noDissent: SynthesizerResult = {
      modelId: 'test/synth',
      servedModelId: 'test/synth',
      ok: true,
      text:
        '## Final Ruling\n\nHOLD\n\nContext.\n\n' +
        '## Consensus Findings\n\nx\n\n' +
        '## Highest Risk\n\nx\n\n' +
        '## Must Fix Before Merge\n\nx\n\n' +
        '## Nice To Have Later\n\nx\n\n' +
        '## Scope Creep Warnings\n\nx\n\n' +
        '## Doctrine Boundary Check\n\nx\n\n' +
        '## Security / Tenant / PII Check\n\nx\n\n' +
        '## QA / Evidence Requirements\n\nx\n\n' +
        '## Suggested Builder Prompt\n\nx\n\n' +
        '## John Approval Question\n\nx',
    };
    const md = buildSynthesisMd({
      synthesizerResult: noDissent,
      reviewerResults: reviewers,
      secretFindings: [],
      runId: 'test-run-no-dissent',
      woId: 'WO-DISSENT-TEST',
    });

    // The required-section enforcement guarantees the section still appears...
    expect(md).toContain('## Disagreements');
    // ...with the human-review placeholder rather than a silent omission.
    expect(md).toContain('human review required');
    // And every required section is still present (nothing dropped).
    for (const section of REQUIRED_SECTIONS) {
      expect(md).toContain('## ' + section);
    }
  });
});
