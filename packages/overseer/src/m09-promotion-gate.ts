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
  /** Git tree of the pull request head commit; read only when the block pins by tree. */
  headTree?: string;
}
const HEX40 = /^[a-f0-9]{40}$/i;
/** `sha` is set for an `approved_sha` block and `tree` for an `approved_tree` block, never both. */
export function promotionBlock(body: string): { id: string; sha: string; tree: string } | null {
  const clean = body
    .replace(/```[^\n]*\n[\s\S]*?(?:```|$)/g, '')
    .replace(/~~~[^\n]*\n[\s\S]*?(?:~~~|$)/g, '')
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/\r\n/g, '\n');
  const matches = [
    ...clean.matchAll(
      /^M-09 promotion:\nmotion_id: ([^\n]+)\n(approved_sha|approved_tree): ([^\n]+)(?=\n|$)(?!\n(?:approved_sha|approved_tree):)/gm
    ),
  ];
  const match = matches[0];
  if (
    matches.length !== 1 ||
    !match?.[1] ||
    !match[2] ||
    !match[3] ||
    (clean.match(/^M-09 promotion:/gm) ?? []).length !== 1
  )
    return null;
  return {
    id: match[1],
    sha: match[2] === 'approved_sha' ? match[3] : '',
    tree: match[2] === 'approved_tree' ? match[3] : '',
  };
}
export function motionPaths(paths: string[], id: string): string[] {
  if (!/^M-\d{8}[a-z]?$/.test(id)) return [];
  return paths.filter(
    path =>
      path.startsWith(`docs/board/motions/${id}-`) && /^docs\/board\/motions\/[^/]+\.md$/.test(path)
  );
}
/** Status tokens that pass rule 5. TABLED, DRAFT, NOT_CARRIED, PARKED and EXECUTED fail on purpose. */
export const PASSING_STATUSES: readonly string[] = [
  'RATIFIED',
  'CARRIED',
  'CARRIED_WITH_CONDITIONS',
];
const CONDITIONS_NOTE = 'carried with conditions: read the motion';
const SINGLE_TOKEN_KEYS = [
  'motion_id',
  'governs',
  'repository',
  'status',
  'approved_sha',
  'approved_tree',
];
export interface MotionRecord {
  fields: Record<string, string>;
  /** True when the record could not be read with confidence; every field rule then fails. */
  malformed: boolean;
  /** Why it is malformed (line numbers and key names only, never a value). Empty when readable. */
  problem: string;
  /** True when the record opened with a `---` block; false when the whole-file scan was used. */
  frontMatter: boolean;
}
/**
 * Reads a motion record. A record that opens with a line of three hyphens carries a front-matter
 * block, and only that block is read; prose, tables and headings outside it never count. A record
 * without one is read by the earlier whole-file scan, unchanged. Fenced code and HTML comments
 * are removed first in both modes.
 */
export function parseMotionRecord(text: string): MotionRecord {
  const lines = cleanRecord(text);
  const first = lines.findIndex(line => line.trim() !== '');
  const fields: Record<string, string> = {};
  if (first >= 0 && lines[first]?.replace(/[ \t]+$/, '') === '---') {
    const bad = (problem: string): MotionRecord => ({
      fields,
      malformed: true,
      problem,
      frontMatter: true,
    });
    for (let i = first + 1; i < lines.length; i++) {
      const line = (lines[i] ?? '').replace(/[ \t]+$/, '');
      if (line === '---') return { fields, malformed: false, problem: '', frontMatter: true };
      if (line.trim() === '' || line.startsWith('#')) continue;
      const where = `block line ${i - first + 1}`;
      const match = /^([a-z][a-z0-9_]*):[ \t]*(.*)$/.exec(line);
      if (!match?.[1]) return bad(`${where} is not key: value`);
      if (!SINGLE_TOKEN_KEYS.includes(match[1])) continue;
      if (!/^\S+$/.test(match[2] ?? ''))
        return bad(`${where}: ${match[1]} needs exactly one token`);
      if (Object.hasOwn(fields, match[1])) return bad(`${where}: ${match[1]} is repeated`);
      fields[match[1]] = match[2] ?? '';
    }
    return bad('the block has no closing line of three hyphens');
  }
  return scanLines(lines);
}
/** The whole-file scan on its own (what every record used before front matter), for tests. */
export function scanMotionFile(text: string): MotionRecord {
  return scanLines(cleanRecord(text));
}
function cleanRecord(text: string): string[] {
  return text
    .replace(/^\uFEFF/, '')
    .replace(/```[^\n]*\n[\s\S]*?(?:```|$)/g, '')
    .replace(/~~~[^\n]*\n[\s\S]*?(?:~~~|$)/g, '')
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/\r\n/g, '\n')
    .split('\n');
}
function scanLines(lines: string[]): MotionRecord {
  const fields: Record<string, string> = {};
  let problem = '';
  lines.forEach((line, index) => {
    const normalized = line.replace(/^\*\*Status:\*\*/, 'status:');
    if (!/^[ \t|`*]*(motion_id|governs|repository|approved_sha|status)\b/i.test(normalized)) return;
    const match = /^(motion_id|governs|repository|approved_sha|status):[ \t]*(\S+)[ \t]*$/.exec(
      normalized
    );
    if (!match?.[1] || !match[2] || Object.hasOwn(fields, match[1])) {
      problem ||= `line ${index + 1} starts with a field name but is not one "key: token" line, or repeats a field`;
      return;
    }
    fields[match[1]] = match[2];
  });
  return { fields, malformed: problem !== '', problem, frontMatter: false };
}
export interface PromotionResult {
  rules: { name: string; pass: boolean; detail?: string }[];
  pinnedSha: string;
  conclusion: 'success' | 'failure';
  reason: string;
}
function lookupHint(input: PromotionInput, id: string, record: MotionRecord): string {
  if (!/^M-\d{8}[a-z]?$/.test(id)) return '';
  const matches = motionPaths(input.paths, id);
  if (matches.length === 0)
    return `expected docs/board/motions/${id}-<slug>.md (a dot after the id, as in ${id}.votes.md, marks a companion and does not count)`;
  if (matches.length > 1)
    return `${matches.length} files match docs/board/motions/${id}-*.md; keep one canonical record and name companions ${id}.<what>.md`;
  if (!input.motion) return 'the record could not be read';
  if (record.malformed) return `the record is malformed: ${record.problem}`;
  if (record.fields.motion_id !== id)
    return `motion_id in the record is ${record.fields.motion_id ?? 'missing'}, expected ${id}`;
  return '';
}
export function evaluatePromotion(input: PromotionInput): PromotionResult {
  const block = promotionBlock(input.body);
  const record = parseMotionRecord(input.motion);
  const fields = record.fields;
  const valid = !record.malformed;
  const trees = (fields.approved_tree ?? '').split(',');
  const pinnedByTree = !!block && block.tree !== '';
  const lookup =
    !!block &&
    HEX40.test(input.pinnedSha) &&
    !input.truncated &&
    motionPaths(input.paths, block.id).length === 1 &&
    !!input.motion &&
    valid &&
    fields.motion_id === block.id;
  const approved = pinnedByTree
    ? valid &&
      HEX40.test(block.tree) &&
      !!input.headTree &&
      HEX40.test(input.headTree) &&
      block.tree.toLowerCase() === input.headTree.toLowerCase() &&
      trees.every(tree => HEX40.test(tree)) &&
      trees.some(tree => tree.toLowerCase() === block.tree.toLowerCase())
    : !!block &&
      HEX40.test(block.sha) &&
      block.sha === input.head &&
      fields.approved_sha === block.sha;
  const status = valid && PASSING_STATUSES.includes(fields.status ?? '');
  const hint =
    !lookup && block && HEX40.test(input.pinnedSha) && !input.truncated
      ? lookupHint(input, block.id, record)
      : '';
  const rules: PromotionResult['rules'] = [
    { name: '1 motion_id', pass: !!block && /^M-\d{8}[a-z]?$/.test(block.id) },
    { name: '2 motion_lookup', pass: lookup, ...(hint ? { detail: hint } : {}) },
    { name: '3 governs', pass: valid && fields.governs === 'M-09' },
    {
      name: '4 repository',
      pass: valid && (fields.repository ?? '').split(',').includes(input.repository),
    },
    { name: '5 status', pass: status },
    { name: pinnedByTree ? '6 approved_tree' : '6 approved_sha', pass: approved },
    { name: '7 ancestry', pass: input.behindBy === 0 },
  ];
  return {
    rules,
    pinnedSha: input.pinnedSha,
    conclusion: rules.every(r => r.pass) ? ('success' as const) : ('failure' as const),
    reason: [
      block ? '' : 'no promotion block',
      status && fields.status === 'CARRIED_WITH_CONDITIONS' ? CONDITIONS_NOTE : '',
    ]
      .filter(Boolean)
      .join('; '),
  };
}
