/** Trusted M-09 decision. No PR tree or executable input is accepted. */
export const COVERED_PRODUCTION_BASES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'thinmansoftware/shopops-storefront': ['master'],
  'thinmansoftware/shopops': ['master'],
  'thinmansoftware/lspro-react': ['main', 'release/ce'],
  'thinmansoftware/bdc-harness': ['main'],
  'thinmansoftware/bdc-shopify-app': ['main'],
});
export interface PromotionInput {
  repository: string;
  head: string;
  body: string;
  pinnedSha: string;
  truncated: boolean;
  paths: string[];
  motion: string;
  behindBy: number;
}
export function promotionBlock(body: string): { id: string; sha: string } | null {
  const clean = body
    .replace(/```[^\n]*\n[\s\S]*?(?:```|$)/g, '')
    .replace(/~~~[^\n]*\n[\s\S]*?(?:~~~|$)/g, '')
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/\r\n/g, '\n');
  const matches = [
    ...clean.matchAll(/^M-09 promotion:\nmotion_id: ([^\n]+)\napproved_sha: ([^\n]+)(?=\n|$)/gm),
  ];
  const match = matches[0];
  if (
    matches.length !== 1 ||
    !match?.[1] ||
    !match[2] ||
    (clean.match(/^M-09 promotion:/gm) ?? []).length !== 1
  )
    return null;
  return { id: match[1], sha: match[2] };
}
export function motionPaths(paths: string[], id: string): string[] {
  if (!/^M-\d{8}[a-z]?$/.test(id)) return [];
  return paths.filter(
    path =>
      path.startsWith(`docs/board/motions/${id}-`) && /^docs\/board\/motions\/[^/]+\.md$/.test(path)
  );
}
export interface PromotionResult {
  rules: { name: string; pass: boolean }[];
  pinnedSha: string;
  conclusion: 'success' | 'failure';
  reason: string;
}
export function evaluatePromotion(input: PromotionInput): PromotionResult {
  const block = promotionBlock(input.body);
  const fields: Record<string, string> = {};
  let malformed = false;
  const clean = input.motion
    .replace(/```[^\n]*\n[\s\S]*?(?:```|$)/g, '')
    .replace(/~~~[^\n]*\n[\s\S]*?(?:~~~|$)/g, '')
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '');
  for (const line of clean.replace(/\r\n/g, '\n').split('\n')) {
    const normalized = line.replace(/^\*\*Status:\*\*/, 'status:');
    if (!/^[ \t|`*]*(motion_id|governs|repository|approved_sha|status)\b/i.test(normalized))
      continue;
    const match = /^(motion_id|governs|repository|approved_sha|status):[ \t]*(\S+)[ \t]*$/.exec(
      normalized
    );
    if (!match?.[1] || !match[2] || Object.hasOwn(fields, match[1])) {
      malformed = true;
      continue;
    }
    fields[match[1]] = match[2];
  }
  const valid = !malformed;
  const checks: [string, boolean][] = [
    ['1 motion_id', !!block && /^M-\d{8}[a-z]?$/.test(block.id)],
    [
      '2 motion_lookup',
      !!block &&
        /^[a-f0-9]{40}$/i.test(input.pinnedSha) &&
        !input.truncated &&
        motionPaths(input.paths, block.id).length === 1 &&
        !!input.motion &&
        valid &&
        fields.motion_id === block.id,
    ],
    ['3 governs', valid && fields.governs === 'M-09'],
    ['4 repository', valid && fields.repository === input.repository],
    ['5 status', valid && ['RATIFIED', 'CARRIED'].includes(fields.status ?? '')],
    [
      '6 approved_sha',
      !!block &&
        /^[a-f0-9]{40}$/i.test(block.sha) &&
        block.sha === input.head &&
        fields.approved_sha === block.sha,
    ],
    ['7 ancestry', input.behindBy === 0],
  ];
  const rules = checks.map(([name, pass]) => ({ name, pass }));
  return {
    rules,
    pinnedSha: input.pinnedSha,
    conclusion: rules.every(r => r.pass) ? ('success' as const) : ('failure' as const),
    reason: block ? '' : 'no promotion block',
  };
}
