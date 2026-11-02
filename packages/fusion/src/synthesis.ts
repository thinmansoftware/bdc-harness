/**
 * synthesis.ts -- Build synthesis.md from synthesizer output
 *
 * The synthesizer model is prompted to produce text containing all 12 required
 * sections. This module validates that all sections are present and applies
 * fallback text for any missing sections (rather than silently omitting them).
 *
 * Required sections (doctrine section 4E):
 *   1.  Final Ruling
 *   2.  Consensus Findings
 *   3.  Disagreements
 *   4.  Highest Risk
 *   5.  Must Fix Before Merge
 *   6.  Nice To Have Later
 *   7.  Scope Creep Warnings
 *   8.  Doctrine Boundary Check
 *   9.  Security / Tenant / PII Check
 *   10. QA / Evidence Requirements
 *   11. Suggested Builder Prompt
 *   12. John Approval Question
 */

import type { ReviewerResult, SynthesizerResult } from './types.js';

export const REQUIRED_SECTIONS = [
  'Final Ruling',
  'Consensus Findings',
  'Disagreements',
  'Highest Risk',
  'Must Fix Before Merge',
  'Nice To Have Later',
  'Scope Creep Warnings',
  'Doctrine Boundary Check',
  'Security / Tenant / PII Check',
  'QA / Evidence Requirements',
  'Suggested Builder Prompt',
  'John Approval Question',
] as const;

export type RequiredSection = (typeof REQUIRED_SECTIONS)[number];

const VALID_RULINGS = ['APPROVE', 'APPROVE WITH PATCH', 'HOLD', 'REJECT'] as const;

/**
 * buildSynthesisMd -- validate and finalize the synthesis document.
 *
 * If the synthesizer produced text that already contains all 12 sections,
 * return it as-is (with a header). Otherwise, inject missing sections with
 * placeholder text flagged for human review.
 *
 * Secret findings are appended to the Security section if not already present.
 * Missing reviewers trigger conservative-ruling enforcement on Final Ruling.
 */
export function buildSynthesisMd(opts: {
  synthesizerResult: SynthesizerResult;
  reviewerResults: ReviewerResult[];
  secretFindings: string[];
  runId: string;
  woId: string;
}): string {
  const { synthesizerResult, reviewerResults, secretFindings, runId, woId } = opts;

  const missingReviewers = reviewerResults.filter(r => !r.ok);
  const hasMissingReviewers = missingReviewers.length > 0;
  const hasSecrets = secretFindings.length > 0;

  // Start with synthesizer output or fallback if it failed
  let body = synthesizerResult.ok ? synthesizerResult.text : buildFallbackBody(hasMissingReviewers);

  // Ensure all required sections exist
  for (const section of REQUIRED_SECTIONS) {
    if (!body.includes('## ' + section)) {
      body +=
        '\n\n## ' +
        section +
        '\n\n[Section not produced by synthesizer -- human review required]\n';
    }
  }

  // Enforce secret findings in Security section
  if (hasSecrets) {
    const securityHeader = '## Security / Tenant / PII Check';
    const findingBlock =
      '\n\n**REDACTED SECRET -- Secret Boundary Violations Detected:**\n' +
      secretFindings.map(f => '- ' + f).join('\n') +
      '\n\nThe above secrets were detected in the diff and REDACTED before sending to reviewers.\n' +
      'A secret committed to a diff is a P0 rotation finding -- investigate immediately.';

    if (!body.includes('REDACTED SECRET')) {
      body = body.replace(securityHeader, securityHeader + findingBlock);
    }
  }

  // Enforce conservative ruling when reviewers are missing
  if (hasMissingReviewers) {
    body = enforceConservativeRuling(body, missingReviewers);
  }

  const header = buildHeader(runId, woId, synthesizerResult, reviewerResults);
  return header + '\n\n' + body;
}

function buildHeader(
  runId: string,
  woId: string,
  synthesizerResult: SynthesizerResult,
  reviewerResults: ReviewerResult[]
): string {
  const missingCount = reviewerResults.filter(r => !r.ok).length;
  const totalCount = reviewerResults.length;
  const presentCount = totalCount - missingCount;
  const panelStatus =
    missingCount === 0
      ? 'Full panel (' + totalCount.toString() + '/' + totalCount.toString() + ' reviewers)'
      : 'REDUCED PANEL (' +
        presentCount.toString() +
        '/' +
        totalCount.toString() +
        ' reviewers -- ' +
        missingCount.toString() +
        ' MISSING)';

  const servedPart = synthesizerResult.servedModelId
    ? ' (served: ' + synthesizerResult.servedModelId + ')'
    : ' (served: unknown)';

  return (
    '# Cauldron Fusion -- PR Review Synthesis\n\n' +
    '**Run ID:** ' +
    runId +
    '\n' +
    '**WO:** ' +
    woId +
    '\n' +
    '**Mode:** pr-review\n' +
    '**Synthesizer:** ' +
    synthesizerResult.modelId +
    servedPart +
    '\n' +
    '**Panel:** ' +
    panelStatus +
    '\n' +
    '**ADVISORY ONLY -- Fusion does not merge, deploy, or edit repos.**'
  );
}

function buildFallbackBody(_hasMissingReviewers: boolean): string {
  return (
    '## Final Ruling\n\nHOLD\n\n' +
    '[Synthesizer failed to produce output -- defaulting to HOLD for human review]\n\n' +
    '## Consensus Findings\n\n[Not available -- synthesizer failed]\n\n' +
    '## Disagreements\n\n[Not available -- synthesizer failed]\n\n' +
    '## Highest Risk\n\n[Not available -- synthesizer failed]\n\n' +
    '## Must Fix Before Merge\n\n[Not available -- synthesizer failed]\n\n' +
    '## Nice To Have Later\n\n[Not available -- synthesizer failed]\n\n' +
    '## Scope Creep Warnings\n\n[Not available -- synthesizer failed]\n\n' +
    '## Doctrine Boundary Check\n\n[Not available -- synthesizer failed]\n\n' +
    '## Security / Tenant / PII Check\n\n[Not available -- synthesizer failed]\n\n' +
    '## QA / Evidence Requirements\n\n[Not available -- synthesizer failed]\n\n' +
    '## Suggested Builder Prompt\n\n[Not available -- synthesizer failed]\n\n' +
    '## John Approval Question\n\n[Synthesizer failed -- operator must review manually before approving]'
  );
}

const FINAL_RULING_RE = /## Final Ruling\s*\n+([^\n#]+)/;

function enforceConservativeRuling(body: string, missingReviewers: ReviewerResult[]): string {
  // Check if Final Ruling section contains a bare APPROVE (not "APPROVE WITH PATCH")
  const finalRulingMatch = FINAL_RULING_RE.exec(body);
  if (!finalRulingMatch) return body;

  const rawRuling = finalRulingMatch[1];
  if (!rawRuling) return body;

  const currentRuling = rawRuling.trim().toUpperCase();
  const isApproveOnly =
    currentRuling === 'APPROVE' ||
    (currentRuling.startsWith('APPROVE') && !currentRuling.includes('PATCH'));

  if (!isApproveOnly) return body;

  // Verify it matches a known ruling (sanity check)
  if (!VALID_RULINGS.some(r => currentRuling.startsWith(r))) {
    return body;
  }

  // Downgrade bare APPROVE to HOLD with annotation
  const missingList = missingReviewers.map(r => r.id).join(', ');
  const annotation =
    '\n\n> **INTEGRITY OVERRIDE:** Bare APPROVE not permitted with missing reviewers.\n' +
    '> Missing: ' +
    missingList +
    '. Ruling changed to HOLD -- reduced panel requires human verification.';

  return body.replace(FINAL_RULING_RE, '## Final Ruling\n\nHOLD' + annotation);
}
