/**
 * Strict, non-executing decoder for the generated workflow bundle
 * (packages/workflows/src/defaults/bundled-defaults.generated.ts), WO-HARNESS-BUNDLE-REVIEW-01.
 *
 * The bundle is parsed as data only. Every non-record line must equal the generator's fixed template
 * byte for byte (scripts/generate-bundled-defaults.ts, renderFile and renderRecord); each record line
 * is `  "<key>": "<json string>",` and each string literal is decoded with JSON.parse on that
 * literal alone. Nothing from the pull request is executed or imported.
 */
import { BUNDLE_PATH } from './bundle-review-proof';
import type { IndependentReviewFinding } from './independent-review-evidence';

/** A rejected bundle. `reason` is a short [a-z0-9_] code, safe to publish after the colon. */
export class BundleRecordError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    const safe = /^[a-z0-9_]{1,40}$/.test(reason) ? reason : 'invalid_reason';
    super(`bundle_record_parse_failed:${safe}`);
    this.name = 'BundleRecordError';
    this.reason = safe;
  }
}

/** The four exports, in file order, with the comment text renderRecord writes for each. */
export const BUNDLE_EXPORTS = [
  { name: 'BUNDLED_COMMANDS', comment: 'Bundled default commands' },
  { name: 'BUNDLED_WORKFLOWS', comment: 'Bundled default workflows' },
  {
    name: 'BUNDLED_POLICIES',
    comment: 'Bundled agent-behavior policies (keyed by `policyFile:` path verbatim)',
  },
  {
    name: 'BUNDLED_LANE_SCRIPTS',
    comment:
      'Bundled lane shell scripts (keyed by filename; materialized into ARCHON_LANE_SCRIPTS_DIR)',
  },
] as const;
export type BundleExportName = (typeof BUNDLE_EXPORTS)[number]['name'];
export type ParsedBundle = Map<BundleExportName, Map<string, string>>;

/** The generator's fixed header (renderFile), one entry per line, ending with its blank line. */
const HEADER_LINES = [
  '/**',
  ' * AUTO-GENERATED -- DO NOT EDIT.',
  ' *',
  ' * Regenerate with: bun run generate:bundled',
  ' * Verify up-to-date:  bun run check:bundled',
  ' *',
  ' * Source of truth:',
  ' *   .archon/commands/defaults/*.md',
  ' *   .archon/workflows/defaults/*.{yaml,yml}',
  ' *   harness/policies/*.md',
  ' *   scripts/lane/*.sh',
  ' *',
  ' * Contents are inlined as plain string literals (JSON-escaped) so this',
  ' * module loads in both Bun and Node. Previous versions used',
  " * `import X from '...' with { type: 'text' }` which is Bun-specific.",
  ' */',
  '',
];

/**
 * The Overseer's own copy of the generator's normalizer. A test pins this function's text to the
 * generator's (bundle-change-review.test.ts, Test 6); change both or neither.
 */
export function normalizeBundledText(raw: string): string {
  return raw
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\u00A0/g, ' ')
    .replace(/[\u2010-\u2015]/g, '--')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/\u2026/g, '...')
    .replace(/\u00B7/g, '-')
    .replace(/\u2212/g, '-')
    .replace(/\u2192/g, '->')
    .replace(/\u2190/g, '<-')
    .replace(/\u21D2/g, '=>')
    .replace(/\u2264/g, '<=')
    .replace(/\u2265/g, '>=')
    .replace(/\u2260/g, '!=')
    .replace(/\u2713/g, 'PASS')
    .replace(/\u2717/g, 'FAIL')
    .split('')
    .filter(char => char.charCodeAt(0) <= 0x7f)
    .join('');
}

/** End index (exclusive) of the JSON string literal starting at `start`, or -1. */
function scanStringLiteral(line: string, start: number): number {
  if (line.charCodeAt(start) !== 0x22) return -1;
  for (let i = start + 1; i < line.length; i++) {
    const code = line.charCodeAt(i);
    if (code === 0x5c) i++;
    else if (code === 0x22) return i + 1;
  }
  return -1;
}

/** Decode one canonical JSON string literal (exactly what JSON.stringify writes). */
function decodeLiteral(literal: string): string {
  let value: unknown;
  try {
    value = JSON.parse(literal);
  } catch {
    throw new BundleRecordError('unknown_line');
  }
  if (typeof value !== 'string') throw new BundleRecordError('unknown_line');
  if (JSON.stringify(value) !== literal) throw new BundleRecordError('noncanonical_string');
  return value;
}

function parseRecordLine(line: string): [string, string] {
  if (!line.startsWith('  "') || !line.endsWith('",')) throw new BundleRecordError('unknown_line');
  const keyEnd = scanStringLiteral(line, 2);
  if (keyEnd < 0 || line.slice(keyEnd, keyEnd + 2) !== ': ') {
    throw new BundleRecordError('unknown_line');
  }
  const valueEnd = scanStringLiteral(line, keyEnd + 2);
  if (valueEnd !== line.length - 1) throw new BundleRecordError('unknown_line');
  return [decodeLiteral(line.slice(2, keyEnd)), decodeLiteral(line.slice(keyEnd + 2, valueEnd))];
}

/**
 * Parse one bundle blob. Rejects (BundleRecordError) any CR or non-ASCII byte, any line that is not
 * the generator's template or a record line, a duplicate key within an export, and a count comment
 * that does not match its records. Key order is not enforced; DEL (0x7f) is allowed.
 */
export function parseBundle(bytes: Uint8Array): ParsedBundle {
  for (const byte of bytes) {
    if (byte === 0x0d) throw new BundleRecordError('cr_byte');
    if (byte > 0x7f) throw new BundleRecordError('non_ascii_byte');
  }
  const lines = Buffer.from(bytes).toString('latin1').split('\n');
  let at = 0;
  const take = (expected: string): void => {
    if (lines[at] !== expected) throw new BundleRecordError('unknown_line');
    at++;
  };
  for (const line of HEADER_LINES) take(line);
  const parsed: ParsedBundle = new Map();
  for (const { name, comment } of BUNDLE_EXPORTS) {
    const head = `// ${comment} (`;
    const countLine = lines[at] ?? '';
    const digits = countLine.slice(head.length, -' total)'.length);
    if (
      !countLine.startsWith(head) ||
      !countLine.endsWith(' total)') ||
      !/^(0|[1-9][0-9]{0,8})$/.test(digits)
    ) {
      throw new BundleRecordError('unknown_line');
    }
    at++;
    take(`export const ${name}: Record<string, string> = {`);
    const records = new Map<string, string>();
    if (lines[at] === '' && lines[at + 1] === '};') {
      // renderRecord writes one empty line for an export with no records.
      at++;
    } else {
      while (lines[at] !== '};') {
        if (at >= lines.length) throw new BundleRecordError('unknown_line');
        const [key, value] = parseRecordLine(lines[at]);
        if (records.has(key)) throw new BundleRecordError('duplicate_key');
        records.set(key, value);
        at++;
      }
    }
    take('};');
    if (records.size !== Number(digits)) throw new BundleRecordError('count_mismatch');
    // The blank separator line; after the last export it is the empty tail of the final newline.
    take('');
    parsed.set(name, records);
  }
  if (at !== lines.length) throw new BundleRecordError('unknown_line');
  return parsed;
}

export interface BundleRecordChange {
  exportName: BundleExportName;
  key: string;
  kind: 'added' | 'removed' | 'changed';
  /** Decoded content at the merge base; absent for an added record. */
  before?: string;
  /** Decoded content at the head; absent for a removed record. */
  after?: string;
}

export interface BundleRecordDiff {
  /** Every added, removed and changed record, in export order, then key order. */
  changes: BundleRecordChange[];
  /** `<EXPORT>/<key>` for each change. */
  keys: string[];
  /** The finding scope string for each change. */
  scopes: string[];
  /** Unified diffs of the decoded text, with context, one section per change. */
  evidence: string;
}

/** Finding scope for one bundle record. */
export function bundleRecordScope(exportName: string, key: string): string {
  return `${BUNDLE_PATH}#${exportName}/${key}`;
}

/** Most line edits one record may need before the diff fails closed. */
const MAX_EDIT_DISTANCE = 2_000;
/** Total diff work (comparisons and steps) across all records before the diff fails closed. */
const MAX_DIFF_WORK = 50_000_000;
const CONTEXT_LINES = 3;

interface Op {
  kind: ' ' | '-' | '+';
  line: string;
}
interface Budget {
  remaining: number;
}

function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** Myers shortest edit script (the LCS of the two line lists), bounded in distance and work. */
function editScript(a: string[], b: string[], budget: Budget): Op[] {
  if (a.length === 0) return b.map(line => ({ kind: '+', line }));
  if (b.length === 0) return a.map(line => ({ kind: '-', line }));
  const n = a.length;
  const m = b.length;
  const maxD = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = maxD + 1;
  const v = new Int32Array(2 * maxD + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= maxD; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
          ? v[offset + k + 1]
          : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
        budget.remaining--;
      }
      if (--budget.remaining < 0) throw new BundleRecordError('diff_too_large');
      v[offset + k] = x;
      if (x >= n && y >= m) {
        trace.push(v.slice(offset - d, offset + d + 1));
        return backtrack(a, b, trace);
      }
    }
    trace.push(v.slice(offset - d, offset + d + 1));
  }
  throw new BundleRecordError('diff_too_large');
}

function backtrack(a: string[], b: string[], trace: Int32Array[]): Op[] {
  const ops: Op[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 1; d > 0; d--) {
    const previous = trace[d - 1];
    const k = x - y;
    const down = k === -d || (k !== d && previous[k - 1 + d - 1] < previous[k + 1 + d - 1]);
    const previousK = down ? k + 1 : k - 1;
    const previousX = previous[previousK + d - 1];
    const previousY = previousX - previousK;
    const midX = down ? previousX : previousX + 1;
    const midY = down ? previousY + 1 : previousY;
    while (x > midX && y > midY) {
      ops.push({ kind: ' ', line: a[x - 1] });
      x--;
      y--;
    }
    ops.push(down ? { kind: '+', line: b[midY - 1] } : { kind: '-', line: a[midX - 1] });
    x = previousX;
    y = previousY;
  }
  while (x > 0 && y > 0) {
    ops.push({ kind: ' ', line: a[x - 1] });
    x--;
    y--;
  }
  return ops.reverse();
}

function hunkRange(start: number, count: number): string {
  return `${count === 0 ? start : start + 1},${count}`;
}

/** Unified diff hunks of two decoded texts, with CONTEXT_LINES lines of context. */
function unifiedDiff(before: string, after: string, budget: Budget): string {
  const a = splitLines(before);
  const b = splitLines(after);
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }
  budget.remaining -= prefix + suffix;
  const ops: Op[] = [
    ...a.slice(0, prefix).map(line => ({ kind: ' ' as const, line })),
    ...editScript(a.slice(prefix, a.length - suffix), b.slice(prefix, b.length - suffix), budget),
    ...a.slice(a.length - suffix).map(line => ({ kind: ' ' as const, line })),
  ];
  const oldAt = new Int32Array(ops.length + 1);
  const newAt = new Int32Array(ops.length + 1);
  for (let i = 0; i < ops.length; i++) {
    oldAt[i + 1] = oldAt[i] + (ops[i].kind === '+' ? 0 : 1);
    newAt[i + 1] = newAt[i] + (ops[i].kind === '-' ? 0 : 1);
  }
  const changed = ops.flatMap((op, i) => (op.kind === ' ' ? [] : [i]));
  const groups: [number, number][] = [];
  for (const index of changed) {
    const last = groups.at(-1);
    if (last && index - last[1] - 1 <= 2 * CONTEXT_LINES) last[1] = index;
    else groups.push([index, index]);
  }
  const out: string[] = [];
  for (const [first, last] of groups) {
    const from = Math.max(0, first - CONTEXT_LINES);
    const to = Math.min(ops.length, last + 1 + CONTEXT_LINES);
    out.push(
      `@@ -${hunkRange(oldAt[from], oldAt[to] - oldAt[from])} +${hunkRange(newAt[from], newAt[to] - newAt[from])} @@\n`
    );
    for (let i = from; i < to; i++) {
      const { kind, line } = ops[i];
      out.push(
        line.endsWith('\n') ? kind + line : `${kind}${line}\n\\ No newline at end of file\n`
      );
    }
  }
  return out.join('');
}

function compareAscii(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Decode the merge-base and head bundle blobs and diff every changed record. Throws
 * BundleRecordError on any parse failure, when no record content changed, or when the diff work
 * exceeds its cap (`diff_too_large`); it never truncates.
 */
export function decodeBundleRecordDiff(before: Uint8Array, after: Uint8Array): BundleRecordDiff {
  const old = parseBundle(before);
  const next = parseBundle(after);
  const changes: BundleRecordChange[] = [];
  for (const { name } of BUNDLE_EXPORTS) {
    const was = old.get(name) ?? new Map<string, string>();
    const now = next.get(name) ?? new Map<string, string>();
    for (const key of [...new Set([...was.keys(), ...now.keys()])].sort(compareAscii)) {
      const beforeText = was.get(key);
      const afterText = now.get(key);
      if (beforeText === afterText) continue;
      changes.push({
        exportName: name,
        key,
        kind: beforeText === undefined ? 'added' : afterText === undefined ? 'removed' : 'changed',
        ...(beforeText === undefined ? {} : { before: beforeText }),
        ...(afterText === undefined ? {} : { after: afterText }),
      });
    }
  }
  if (changes.length === 0) throw new BundleRecordError('no_record_change');
  const budget: Budget = { remaining: MAX_DIFF_WORK };
  const sections = changes.map(change => {
    const scope = bundleRecordScope(change.exportName, change.key);
    return (
      `### ${change.kind} ${change.exportName}/${change.key}\n` +
      `--- ${change.before === undefined ? '/dev/null' : `a/${scope}`}\n` +
      `+++ ${change.after === undefined ? '/dev/null' : `b/${scope}`}\n` +
      unifiedDiff(change.before ?? '', change.after ?? '', budget)
    );
  });
  return {
    changes,
    keys: changes.map(change => `${change.exportName}/${change.key}`),
    scopes: changes.map(change => bundleRecordScope(change.exportName, change.key)),
    evidence: sections.join(''),
  };
}

const KEBAB = /^[a-z0-9][a-z0-9-]*$/;

/** The head source path(s) the generator reads for one record (scripts/generate-bundled-defaults.ts). */
export function sourcePathCandidates(exportName: BundleExportName, key: string): string[] {
  switch (exportName) {
    case 'BUNDLED_COMMANDS':
      return KEBAB.test(key) ? [`.archon/commands/defaults/${key}.md`] : [];
    case 'BUNDLED_WORKFLOWS':
      return KEBAB.test(key)
        ? [`.archon/workflows/defaults/${key}.yaml`, `.archon/workflows/defaults/${key}.yml`]
        : [];
    case 'BUNDLED_POLICIES':
      return /^harness\/policies\/[a-z0-9][a-z0-9-]*\.md$/.test(key) ? [key] : [];
    case 'BUNDLED_LANE_SCRIPTS':
      return /^[a-z0-9][a-z0-9-]*\.sh$/.test(key) ? [`scripts/lane/${key}`] : [];
  }
}

/**
 * Source-match gate. An added or changed record must equal its normalized head source; a removed
 * record's source must be absent. Each failure is one deterministic blocker finding scoped to the
 * record. `readSource` returns the authenticated head blob decoded as UTF-8.
 */
export async function bundleSourceMismatches(
  changes: readonly BundleRecordChange[],
  headPaths: ReadonlySet<string>,
  readSource: (path: string) => Promise<string>
): Promise<IndependentReviewFinding[]> {
  const findings: IndependentReviewFinding[] = [];
  for (const change of changes) {
    const label = `${change.exportName}/${change.key}`;
    const scope = bundleRecordScope(change.exportName, change.key);
    const candidates = sourcePathCandidates(change.exportName, change.key);
    const present = candidates.filter(path => headPaths.has(path));
    const blocker = (summary: string): void => {
      findings.push({ scope, severity: 'blocker', summary });
    };
    if (change.after === undefined) {
      if (present.length > 0) {
        blocker(
          `Bundle record ${label} was removed, but its head source ${present.join(' and ')} still exists; regenerate the bundle from source.`
        );
      }
      continue;
    }
    if (present.length !== 1) {
      blocker(
        present.length === 0
          ? `Bundle record ${label} has no head source (${candidates.join(' or ') || 'invalid key'}); regenerate the bundle from source.`
          : `Bundle record ${label} has more than one head source (${present.join(' and ')}).`
      );
      continue;
    }
    if (normalizeBundledText(await readSource(present[0])) !== change.after) {
      blocker(
        `Bundle record ${label} does not match its normalized head source ${present[0]}; regenerate the bundle from source.`
      );
    }
  }
  return findings;
}
