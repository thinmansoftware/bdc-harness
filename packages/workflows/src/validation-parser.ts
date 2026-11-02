export interface ValidationResult {
  check: string;
  result: 'pass' | 'fail' | 'warn' | 'unknown';
  error?: string;
}

const HEADER_REGEX = /^#\s+Validation Results\s*$/m;
const TABLE_HEADER_REGEX = /^\|\s*Check\s*\|\s*Result\s*\|$/;
const SEPARATOR_ROW_REGEX = /^\|?\s*[-:]+\s*\|\s*[-:]+\s*\|?/;

function normalizeCheckName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

// Status markers. The repo is ASCII-only in source (the ascii-gate scans this
// file), so the legacy emoji are referenced via \u escapes -- ASCII on disk,
// identical at runtime -- and the ASCII equivalents are accepted alongside them:
//   pass: [x]  or  U+2705 white-heavy-check / U+2714 heavy-check
//   fail: [ ]  or  U+274C cross-mark        / U+2716 heavy-multiplication
//   warn: !    or  U+26A0 warning-sign
//   skip: [-]  or  U+23ED skip-forward, or the "not run"/"skipped" keywords
//   U+FE0F is the emoji variation selector that trails some glyphs.
const PASS_MARK = /\[x\]|\u2705|\u2714/u;
const FAIL_MARK = /\[ \]|\u274C|\u2716/u;
const WARN_MARK = /!|\u26A0/u;
const SKIP_MARK = /\[-\]|\u23ED/u;
const ALL_MARKS = /\[x\]|\[ \]|\[-\]|!|\u2705|\u2714|\u274C|\u2716|\u26A0|\u23ED|\uFE0F/gu;

function parseResultCell(raw: string): { result: ValidationResult['result']; error?: string } {
  const trimmed = raw.trim();
  const hasPass = PASS_MARK.test(trimmed);
  const hasFail = FAIL_MARK.test(trimmed);
  const hasWarn = WARN_MARK.test(trimmed);
  const hasSkip = SKIP_MARK.test(trimmed) || /not run|skipped/i.test(trimmed);

  let result: ValidationResult['result'] = 'unknown';
  if (hasPass) result = 'pass';
  else if (hasFail) result = 'fail';
  else if (hasWarn || hasSkip) result = 'warn';

  // Strip every status marker, then surface any remaining text as the error.
  const cleaned = trimmed.replace(ALL_MARKS, '').trim();
  const error = cleaned ? cleaned.replace(/^(--|-)\s*/, '') : undefined;

  return { result, ...(error ? { error } : {}) };
}

export function parseValidationResults(content: string): ValidationResult[] {
  if (!HEADER_REGEX.test(content)) return [];

  const lines = content.split(/\r?\n/);
  const headerIndex = lines.findIndex(line => TABLE_HEADER_REGEX.test(line.trim()));
  if (headerIndex === -1) return [];

  const results: ValidationResult[] = [];
  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('|')) break;
    if (SEPARATOR_ROW_REGEX.test(line)) continue;

    const cells = line
      .split('|')
      .map(cell => cell.trim())
      .filter(Boolean);
    if (cells.length < 2) continue;

    const check = normalizeCheckName(cells[0]);
    if (!check) continue;

    const parsed = parseResultCell(cells[1]);
    results.push({ check, ...parsed });
  }

  return results;
}
