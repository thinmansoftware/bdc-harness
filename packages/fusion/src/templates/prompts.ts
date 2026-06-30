export function buildReviewerPrompt(input: {
  role: string;
  workOrder: string;
  diff: string;
}): string {
  return [
    `You are the ${input.role} reviewer in a fusion review round.`,
    '',
    'Judge only the supplied work order and diff. Do not assume files outside the diff.',
    'Return concise findings with severity, file references when available, and a final PASS or FAIL.',
    '',
    'Work order:',
    input.workOrder,
    '',
    'Diff:',
    input.diff,
  ].join('\n');
}

export const SYNTHESIS_SECTION_TITLES = [
  'Final Ruling',
  'Consensus Findings',
  'Disagreements',
  'Highest Risk',
  'Must Fix',
  'Nice To Have',
  'Scope Creep',
  'Doctrine Boundary',
  'Security/PII',
  'QA/Evidence',
  'Builder Prompt',
  'John Approval Question',
] as const;
