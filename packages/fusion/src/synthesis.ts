import { SYNTHESIS_SECTION_TITLES } from './templates/prompts';
import type { ReviewerArtifact } from './types';

export interface SynthesisInput {
  slug: string;
  workOrder: string;
  reviewers: ReviewerArtifact[];
  outputs: Record<string, string>;
}

function outputFor(role: string, outputs: Record<string, string>): string {
  const text = outputs[role]?.trim();
  return text && text.length > 0 ? text : 'MISSING reviewer output.';
}

export function buildSynthesis(input: SynthesisInput): string {
  const missing = input.reviewers.filter((reviewer) => reviewer.status === 'MISSING');
  const failed = input.reviewers.filter((reviewer) => !reviewer.ok);
  const finalRuling =
    failed.length === 0
      ? 'PASS: all reviewers returned usable output and integrity checks passed.'
      : `NEEDS_REVISION: ${failed.map((reviewer) => reviewer.role).join(', ')} require attention.`;

  const sections: Record<(typeof SYNTHESIS_SECTION_TITLES)[number], string> = {
    'Final Ruling': finalRuling,
    'Consensus Findings': input.reviewers
      .map((reviewer) => `- ${reviewer.role}: ${reviewer.status}`)
      .join('\n'),
    Disagreements:
      'Reviewer disagreements must be resolved by comparing the per-reviewer round-1 artifacts.',
    'Highest Risk':
      missing.length > 0
        ? `Missing reviewer output: ${missing.map((reviewer) => reviewer.role).join(', ')}.`
        : 'No missing reviewer output detected.',
    'Must Fix':
      failed.length > 0
        ? failed
            .map((reviewer) => {
              const reason = reviewer.error ?? 'reviewer reported failure or integrity mismatch';
              return `- ${reviewer.role}: ${reason}`;
            })
            .join('\n')
        : '- None.',
    'Nice To Have': '- Re-run with additional domain reviewers if the work order expands.',
    'Scope Creep': 'No scope creep identified from the automated synthesis inputs.',
    'Doctrine Boundary':
      'The builder should only address findings grounded in the supplied work order and diff.',
    'Security/PII': outputFor('security-pii', input.outputs),
    'QA/Evidence': outputFor('qa-evidence', input.outputs),
    'Builder Prompt': [
      `Repair the ${input.slug} diff according to the Must Fix section.`,
      'Preserve unrelated user changes and rerun the evidence requested by QA.',
    ].join('\n'),
    'John Approval Question':
      failed.length > 0
        ? 'John, do you approve pausing for the listed Must Fix items before commit?'
        : 'John, do you approve proceeding with the irreversible commit?',
  };

  const reviewerAppendix = input.reviewers
    .map((reviewer) => {
      return [
        `### ${reviewer.role}`,
        `requested_model_id: ${reviewer.requested_model_id}`,
        `served_model_id: ${reviewer.served_model_id ?? 'MISSING'}`,
        `ok: ${String(reviewer.ok)}`,
        '',
        outputFor(reviewer.role, input.outputs),
      ].join('\n');
    })
    .join('\n\n');

  return [
    `# Fusion Synthesis: ${input.slug}`,
    '',
    ...SYNTHESIS_SECTION_TITLES.flatMap((title) => [`## ${title}`, sections[title], '']),
    '## Reviewer Appendix',
    reviewerAppendix,
    '',
  ].join('\n');
}
