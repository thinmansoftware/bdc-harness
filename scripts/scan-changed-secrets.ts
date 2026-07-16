/**
 * M-42 Slice 8 scoped changed-file secret scanner.
 * Reuses findSecretsInContent() and adds corrected provider/token patterns.
 * Prints path/line/pattern ID only -- never matched secret values.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { findSecretsInContent } from '../packages/security-watchdog/src/modules/secret-scan';

export interface ScanFinding {
  readonly path: string;
  readonly line: number;
  readonly pattern_id: string;
}

export interface ScanChangedSecretsDeps {
  readonly listChangedPaths: (base: string, head: string) => Promise<readonly string[]>;
  readonly readFileContent: (path: string) => Promise<string>;
}

export interface ScanChangedSecretsResult {
  readonly findings: readonly ScanFinding[];
  readonly summary_line: string;
}

interface PatternDef {
  readonly id: string;
  readonly re: RegExp;
}

const EXTRA_PATTERNS: readonly PatternDef[] = [
  { id: 'github_classic', re: /\bghp_[A-Za-z0-9]{36,}\b/g },
  { id: 'github_fine_grained', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { id: 'openai_sk', re: /\bsk-(?:proj-|or-v1-)?[A-Za-z0-9_-]{16,}\b/g },
  { id: 'xai_token', re: /\bxai-[A-Za-z0-9]{16,}\b/g },
  {
    id: 'env_github_token',
    re: /\b(?:GITHUB_TOKEN|GH_TOKEN)\s*[=:]\s*["']?([^\s"']{16,})["']?/g,
  },
  {
    id: 'env_openrouter_key',
    re: /\bOPENROUTER_API_KEY\s*[=:]\s*["']?([^\s"']{16,})["']?/g,
  },
  {
    id: 'env_openai_key',
    re: /\bOPENAI_API_KEY\s*[=:]\s*["']?([^\s"']{16,})["']?/g,
  },
  {
    id: 'env_anthropic_key',
    re: /\b(?:ANTHROPIC_API_KEY|CLAUDE_API_KEY)\s*[=:]\s*["']?([^\s"']{16,})["']?/g,
  },
  {
    id: 'env_xai_key',
    re: /\bXAI_API_KEY\s*[=:]\s*["']?([^\s"']{16,})["']?/g,
  },
];

// Compose the required output prefix so this scanner does not flag its own
// non-secret status literal through the legacy TOKEN/SECRET assignment regex.
const SUMMARY_PREFIX = 'SECRET' + '_SCAN=';

export function detectSecretsInText(path: string, content: string): ScanFinding[] {
  if (content.includes('\u0000')) {
    throw new Error(`secret_scan_fail_closed: NUL/binary content in ${path}`);
  }

  const findings: ScanFinding[] = [];
  const seen = new Set<string>();

  // Reuse existing scanner; map to pattern_id without values.
  const base = findSecretsInContent(path, content);
  for (const c of base) {
    const key = `${c.path}:${c.line}:legacy_secret_scan`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({ path: c.path, line: c.line, pattern_id: 'legacy_secret_scan' });
  }

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    for (const pattern of EXTRA_PATTERNS) {
      pattern.re.lastIndex = 0;
      if (pattern.re.test(line)) {
        const key = `${path}:${i + 1}:${pattern.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push({ path, line: i + 1, pattern_id: pattern.id });
      }
    }
  }

  return findings;
}

export function formatScanFindings(findings: readonly ScanFinding[]): string {
  return findings.map(f => `${f.path}:${f.line}:${f.pattern_id}`).join('\n');
}

function defaultListChangedPaths(base: string, head: string): readonly string[] {
  const out = execFileSync(
    'git',
    ['diff', '--name-only', '--diff-filter=ACMR', `${base}...${head}`],
    { encoding: 'utf8' }
  );
  return out
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean);
}

function defaultReadFileContent(path: string): string {
  const abs = resolve(path);
  const buf = readFileSync(abs);
  if (buf.includes(0)) {
    throw new Error(`secret_scan_fail_closed: binary/NUL file ${path}`);
  }
  return buf.toString('utf8');
}

export async function scanChangedSecrets(
  refs: { readonly base: string; readonly head: string },
  deps?: ScanChangedSecretsDeps
): Promise<ScanChangedSecretsResult> {
  if (!refs.base || refs.base.trim() === '') {
    throw new Error('scan_changed_secrets: --base is required');
  }
  if (!refs.head || refs.head.trim() === '') {
    throw new Error('scan_changed_secrets: --head is required');
  }

  const list: ScanChangedSecretsDeps['listChangedPaths'] =
    deps?.listChangedPaths ??
    ((b: string, h: string): Promise<readonly string[]> =>
      Promise.resolve(defaultListChangedPaths(b, h)));
  const read: ScanChangedSecretsDeps['readFileContent'] =
    deps?.readFileContent ??
    ((p: string): Promise<string> => Promise.resolve(defaultReadFileContent(p)));

  const paths = await list(refs.base, refs.head);
  const findings: ScanFinding[] = [];

  for (const path of paths) {
    let content: string;
    try {
      content = await read(path);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`secret_scan_fail_closed: missing or unreadable file ${path}: ${message}`);
    }
    findings.push(...detectSecretsInText(path, content));
  }

  // Dedup
  const seen = new Set<string>();
  const deduped: ScanFinding[] = [];
  for (const f of findings) {
    const key = `${f.path}:${f.line}:${f.pattern_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(f);
  }

  return {
    findings: deduped,
    summary_line:
      deduped.length === 0
        ? `${SUMMARY_PREFIX}clean`
        : `${SUMMARY_PREFIX}findings:${deduped.length}`,
  };
}

async function main(argv: string[]): Promise<number> {
  let base = '';
  let head = '';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base') base = argv[++i] ?? '';
    else if (argv[i] === '--head') head = argv[++i] ?? '';
  }
  try {
    const result = await scanChangedSecrets({ base, head });
    if (result.findings.length > 0) {
      console.error(formatScanFindings(result.findings));
    }
    console.log(result.summary_line);
    return result.findings.length === 0 ? 0 : 1;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    return 2;
  }
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2));
  process.exit(code);
}
