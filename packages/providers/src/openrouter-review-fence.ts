/**
 * OpenRouter review fence (WO-HARNESS-OPENROUTER-REVIEW-DIFF-SCAN-01).
 *
 * Ruling M-20261027a round 6 item 6 (REPLACED): customer repos MAY use
 * OpenRouter review seats, behind two fences:
 *   (1) the transmitted content (repository diff + outgoing prompt) is scanned
 *       for secrets (gitleaks) and customer data (emails, phone numbers, Stripe
 *       ids, tenant slugs in fixtures) before send; a hit -- or a scan that
 *       cannot run -- reroutes that review to a Claude/Codex seat instead;
 *   (2) every OpenRouter request on a customer-repo run is pinned to providers
 *       with no-training / zero-retention terms (data_collection:deny + zdr).
 *
 * This module is the PURE, importable half: the customer-data patterns, the
 * gitleaks subprocess invocation, the OpenRouter route classifier, the
 * customer-repo list and slug normalizer, and the no-private-endpoint error
 * classifier. It has no database or executor dependency. The executor gate in
 * `@archon/workflows/dag-executor` builds the diff, reads the slug env, calls
 * `scanDiffForOpenRouter`, records the decision event, and chooses the route.
 *
 * Hits NEVER carry the matched value -- only a kind and a location -- so an
 * event that records a hit does not itself leak the customer datum.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OPENROUTER_BACKED_PROVIDER_IDS } from './openrouter-guard';

/** The paying-customer repositories (Rule 20 list). Only these are scanned. */
export const CUSTOMER_REPOS: readonly string[] = [
  'thinmansoftware/lspro-react',
  'thinmansoftware/shopops',
  'thinmansoftware/shopops-storefront',
];

/**
 * Provider ids whose requests are carried by OpenRouter and therefore subject
 * to the fence. `codex-opr` is included unconditionally (regardless of model):
 * it is a CodexProvider whose auth-failure failback is a GlmProvider pointed at
 * OpenRouter, so a customer-repo codex-opr node must be gated before Codex is
 * ever dispatched (per the spec scope-in bullet).
 */
const OPENROUTER_ROUTE_PROVIDER_IDS: ReadonlySet<string> = new Set<string>([
  ...OPENROUTER_BACKED_PROVIDER_IDS,
  'codex-opr',
]);

/** The repository-reading tool-loop seat (GrokAgentProvider.getType()). */
export const OPENROUTER_TOOL_LOOP_PROVIDER_ID = 'openrouter';

export type ScanKind = 'email' | 'phone' | 'stripe_id' | 'tenant_slug' | 'gitleaks';

export interface ScanHit {
  kind: ScanKind;
  /** File path for diff hits, or the literal string 'prompt' for prompt hits. */
  file: string;
  /** Line number for diff hits, or a character offset for prompt hits. */
  line: number;
  /** gitleaks RuleID when kind === 'gitleaks'; omitted otherwise. */
  ruleId?: string;
}

export type ScanVerdict = 'clean' | 'hit' | 'scan_unavailable';

export interface ScanResult {
  verdict: ScanVerdict;
  hits: ScanHit[];
  /** Set only when verdict === 'scan_unavailable': names the missing piece. */
  reason?: string;
}

/** What the gitleaks runner reports back to the scanner. */
export interface GitleaksResult {
  /** false when the binary is missing or exited with a non-finding error. */
  available: boolean;
  findings: { ruleId: string }[];
}

export interface ScanOptions {
  /** 'diff' parses a unified diff (prefixes stripped, per-file line numbers);
   *  'prompt' scans raw text and reports char offsets under file 'prompt'. */
  mode?: 'diff' | 'prompt';
  /** Tenant slugs from OPENROUTER_FENCE_TENANT_SLUGS. Empty/undefined is a
   *  fail-closed condition (scan_unavailable) -- the caller cannot prove the
   *  change is free of a real tenant slug without them. */
  tenantSlugs?: readonly string[];
  /** Worktree path -- used to honor .gitleaks.toml / .gitleaksignore. */
  cwd?: string;
  /** Injectable gitleaks runner (tests stub it). Default runs the real binary. */
  gitleaksRunner?: (text: string, cwd?: string) => Promise<GitleaksResult>;
  /** gitleaks binary name/path. Default 'gitleaks' (resolved from PATH). */
  gitleaksPath?: string;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Domains and the one address that are explicitly NOT customer data.
const EMAIL_IGNORED_DOMAINS: ReadonlySet<string> = new Set([
  'example.com',
  'example.org',
  'users.noreply.github.com',
]);
const EMAIL_IGNORED_ADDRESSES: ReadonlySet<string> = new Set(['noreply@anthropic.com']);

// US phone forms: (NNN) NNN-NNNN | NNN-NNN-NNNN | NNN.NNN.NNNN | +1NNNNNNNNNN
const PHONE_RE =
  /(?:\(\d{3}\)\s?\d{3}-\d{4}|\b\d{3}-\d{3}-\d{4}\b|\b\d{3}\.\d{3}\.\d{4}\b|\+1\d{10}\b)/g;

// Stripe key ids (sk_/pk_/rk_ + live_/test_ + 10+) and object ids (cus_/sub_ + 8+).
const STRIPE_KEY_RE = /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/g;
const STRIPE_OBJ_RE = /\b(?:cus|sub)_[A-Za-z0-9]{8,}/g;

// A file path is a "fixture" path when it contains any of these markers.
const FIXTURE_PATH_RE = /fixtures|__fixtures__|seed|\.fixture\./i;

/** Escape a user-supplied slug for safe use inside a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Normalize a git remote URL (or an already-bare owner/repo) to lowercase
 * `owner/repo`. Returns null when the remote is not a parseable GitHub remote.
 *
 * Local duplicate of the regex shape in
 * `packages/server/src/services/canonical-remote.ts`. Duplicated on purpose:
 * `@archon/providers` and `@archon/workflows` must never depend on
 * `@archon/server`, so the shape crosses a package boundary rather than a
 * same-package Rule-of-Three line. Unlike the server helper this returns null
 * instead of throwing (a non-customer remote is the common, non-error case).
 */
export function normalizeRepoSlug(remote: string | null | undefined): string | null {
  if (!remote) return null;
  const stripped = remote
    .trim()
    .replace(/^(https?:\/\/)[^/@\s]+@/i, '$1')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '');
  const candidates = [
    /^git@github\.com:([^/]+)\/([^/]+)$/i,
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)$/i,
    /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+)$/i,
    /^([^/:]+)\/([^/]+)$/,
  ];
  for (const candidate of candidates) {
    const match = candidate.exec(stripped);
    if (match?.[1] && match[2]) {
      return `${match[1].toLowerCase()}/${match[2].toLowerCase()}`;
    }
  }
  return null;
}

/** True when the normalized remote is one of the paying-customer repos. */
export function isCustomerRepo(remote: string | null | undefined): boolean {
  const slug = normalizeRepoSlug(remote);
  return slug !== null && CUSTOMER_REPOS.includes(slug);
}

/**
 * True when `provider` is carried by OpenRouter (text-only seats opr/opr-zero/
 * glm, the tool-loop seat openrouter, the deprecated grok alias) or is the
 * codex-opr seat (OpenRouter failback). `model` is accepted for signature
 * stability; provider identity alone decides.
 */
export function isOpenRouterRoute(provider: string | undefined, _model?: string): boolean {
  if (!provider) return false;
  return OPENROUTER_ROUTE_PROVIDER_IDS.has(provider);
}

/**
 * Classify an OpenRouter error string as "no endpoint satisfies the data
 * policy" (the zdr / data_collection:deny pin found no compliant provider).
 * The exact upstream text is [UNVERIFIED] in the spec; this matches the
 * documented data-policy / no-endpoints phrasings. A match means the request
 * MUST be rerouted to a non-OpenRouter seat -- never retried without the pin.
 */
export function isNoPrivateEndpointError(errorText: string | undefined): boolean {
  if (!errorText) return false;
  const t = errorText.toLowerCase();
  const mentionsNoEndpoint =
    t.includes('no endpoints') ||
    t.includes('no endpoint ') ||
    t.includes('no allowed providers') ||
    t.includes('no provider') ||
    t.includes('no providers');
  const mentionsPolicy =
    t.includes('data policy') ||
    t.includes('data collection') ||
    t.includes('data_collection') ||
    t.includes('zero data retention') ||
    t.includes('zdr');
  return (
    (mentionsNoEndpoint && mentionsPolicy) || t.includes('no endpoints found matching your data')
  );
}

interface DiffLine {
  file: string;
  /** Reported line number (new-side for +/context, old-side for removed). */
  line: number;
  /** Line content with the +/-/space prefix stripped. */
  content: string;
}

/**
 * Flatten a unified diff into scannable lines. EVERY transmitted line is
 * yielded -- added (+), removed (-), context ( ) and the raw header lines --
 * with the diff prefix stripped, so a secret on a removed or context line (or
 * in a header) is still caught (Overseer 0c58a282).
 */
function flattenUnifiedDiff(diffText: string): DiffLine[] {
  const out: DiffLine[] = [];
  let currentFile = '<diff>';
  // Old-side path from the most recent `--- a/path` header. A deleted file has
  // `+++ /dev/null`, so its removed lines must be attributed to this path or
  // the fixture-path tenant-slug check never sees them (Overseer f90adfec).
  let oldSideFile: string | null = null;
  let newLineNo = 0;
  let oldLineNo = 0;
  const hunkRe = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
  for (const raw of diffText.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      // diff --git a/old b/new -- start of a new file section.
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(raw);
      if (m?.[2]) currentFile = m[2];
      oldSideFile = null;
      out.push({ file: currentFile, line: 0, content: raw });
      continue;
    }
    if (raw.startsWith('+++ ')) {
      // +++ b/path/to/file  (or +++ /dev/null for a deleted file)
      const path = raw.slice(4).replace(/^b\//, '').trim();
      currentFile = path === '/dev/null' ? (oldSideFile ?? currentFile) : path;
      out.push({ file: currentFile, line: 0, content: raw });
      continue;
    }
    if (raw.startsWith('--- ')) {
      // --- a/path/to/file  (or --- /dev/null for an added file)
      const path = raw.slice(4).replace(/^a\//, '').trim();
      oldSideFile = path === '/dev/null' ? null : path;
      out.push({ file: oldSideFile ?? currentFile, line: 0, content: raw });
      continue;
    }
    const hunk = hunkRe.exec(raw);
    if (hunk) {
      oldLineNo = Number.parseInt(hunk[1] ?? '0', 10);
      newLineNo = Number.parseInt(hunk[2] ?? '0', 10);
      out.push({ file: currentFile, line: 0, content: raw });
      continue;
    }
    if (raw.startsWith('diff ') || raw.startsWith('index ') || raw.startsWith('\\ ')) {
      out.push({ file: currentFile, line: 0, content: raw });
      continue;
    }
    if (raw.startsWith('+')) {
      out.push({ file: currentFile, line: newLineNo, content: raw.slice(1) });
      newLineNo += 1;
    } else if (raw.startsWith('-')) {
      out.push({ file: currentFile, line: oldLineNo, content: raw.slice(1) });
      oldLineNo += 1;
    } else {
      // Context line (leading space) or a bare line.
      const content = raw.startsWith(' ') ? raw.slice(1) : raw;
      out.push({ file: currentFile, line: newLineNo, content });
      newLineNo += 1;
      oldLineNo += 1;
    }
  }
  return out;
}

/**
 * Collect customer-data pattern hits from a single text line.
 *
 * When `useMatchOffset` is true the recorded `line` is each match's actual
 * character offset within `content` -- this is what prompt mode needs to honor
 * the `prompt:<offset>` event-location contract (the whole outgoing text is
 * scanned as one string). When false (diff mode) the caller's per-file `line`
 * number is recorded verbatim; match offsets within a diff line are not part of
 * the `file:line` location.
 */
function scanLineForPatterns(
  content: string,
  file: string,
  line: number,
  tenantSlugs: readonly string[],
  allowTenantSlug: boolean,
  useMatchOffset = false
): ScanHit[] {
  const hits: ScanHit[] = [];
  const locOf = (index: number | undefined): number => (useMatchOffset ? (index ?? line) : line);

  for (const m of content.matchAll(EMAIL_RE)) {
    const address = m[0].toLowerCase();
    const domain = address.slice(address.indexOf('@') + 1);
    if (EMAIL_IGNORED_ADDRESSES.has(address) || EMAIL_IGNORED_DOMAINS.has(domain)) continue;
    hits.push({ kind: 'email', file, line: locOf(m.index) });
  }
  for (const m of content.matchAll(PHONE_RE)) {
    hits.push({ kind: 'phone', file, line: locOf(m.index) });
  }
  for (const m of content.matchAll(STRIPE_KEY_RE)) {
    hits.push({ kind: 'stripe_id', file, line: locOf(m.index) });
  }
  for (const m of content.matchAll(STRIPE_OBJ_RE)) {
    hits.push({ kind: 'stripe_id', file, line: locOf(m.index) });
  }
  if (allowTenantSlug) {
    for (const slug of tenantSlugs) {
      if (!slug) continue;
      const slugRe = new RegExp(escapeRegExp(slug), 'g');
      const m = slugRe.exec(content);
      if (m) {
        hits.push({ kind: 'tenant_slug', file, line: locOf(m.index) });
      }
    }
  }
  return hits;
}

/**
 * Default gitleaks runner: write `text` to a temp file and run the gitleaks
 * CLI against it. Honors a worktree .gitleaks.toml (via --config) and
 * .gitleaksignore (via --gitleaks-ignore-path) when present. Returns
 * available:false when the binary is missing or exits with an error other than
 * "findings present", so the caller fails closed.
 */
async function runGitleaks(
  text: string,
  cwd: string | undefined,
  gitleaksPath: string
): Promise<GitleaksResult> {
  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), 'orfence-'));
    const scanFile = join(dir, 'transmitted.txt');
    const reportFile = join(dir, 'report.json');
    await writeFile(scanFile, text, 'utf8');

    const args = [
      'detect',
      '--no-git',
      '--source',
      scanFile,
      '--report-format',
      'json',
      '--report-path',
      reportFile,
      '--redact',
      // Exit 0 even when leaks are found; findings are read from the report so
      // a non-zero exit always means a real binary/config error (fail closed).
      '--exit-code',
      '0',
    ];
    if (cwd) {
      const configPath = join(cwd, '.gitleaks.toml');
      if (await fileExists(configPath)) {
        args.push('--config', configPath);
      }
      const ignorePath = join(cwd, '.gitleaksignore');
      if (await fileExists(ignorePath)) {
        args.push('--gitleaks-ignore-path', ignorePath);
      }
    }

    const ok = await new Promise<boolean>(resolve => {
      execFile(gitleaksPath, args, { timeout: 60_000 }, error => {
        // With --exit-code 0, any error means the binary failed to run.
        resolve(!error);
      });
    });
    if (!ok) return { available: false, findings: [] };

    let reportRaw: string;
    try {
      reportRaw = await readFile(reportFile, 'utf8');
    } catch {
      // gitleaks omits the report file when there are zero findings.
      return { available: true, findings: [] };
    }
    const trimmed = reportRaw.trim();
    if (!trimmed) return { available: true, findings: [] };
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return { available: false, findings: [] };
    }
    if (!Array.isArray(parsed)) return { available: true, findings: [] };
    const findings = parsed.map(f => {
      const ruleIdRaw = (f as { RuleID?: unknown }).RuleID;
      return { ruleId: typeof ruleIdRaw === 'string' ? ruleIdRaw : 'unknown' };
    });
    return { available: true, findings };
  } catch {
    return { available: false, findings: [] };
  } finally {
    if (dir) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Scan transmitted text for secrets and customer data before it reaches an
 * OpenRouter review seat. `mode: 'diff'` parses a unified diff and reports
 * file:line locations; `mode: 'prompt'` scans raw prompt text and reports
 * prompt:<offset> locations. Returns scan_unavailable (fail closed) when the
 * tenant-slug env is empty or the gitleaks scan cannot run; hits never carry
 * the matched value.
 */
export async function scanDiffForOpenRouter(text: string, opts: ScanOptions): Promise<ScanResult> {
  const mode = opts.mode ?? 'diff';
  const tenantSlugs = opts.tenantSlugs ?? [];

  // Fail closed: without the tenant-slug list we cannot prove the change is
  // free of a real tenant slug (spec Test 7).
  if (tenantSlugs.length === 0) {
    return { verdict: 'scan_unavailable', hits: [], reason: 'tenant_slugs_unset' };
  }

  // Secret scan over the full transmitted text (fail closed on any error).
  const gitleaksRunner =
    opts.gitleaksRunner ??
    ((t: string, c?: string): Promise<GitleaksResult> =>
      runGitleaks(t, c, opts.gitleaksPath ?? 'gitleaks'));
  const gitleaks = await gitleaksRunner(text, opts.cwd);
  if (!gitleaks.available) {
    return { verdict: 'scan_unavailable', hits: [], reason: 'gitleaks_unavailable' };
  }

  const hits: ScanHit[] = [];
  for (const finding of gitleaks.findings) {
    hits.push({
      kind: 'gitleaks',
      file: mode === 'prompt' ? 'prompt' : '<diff>',
      line: 0,
      ruleId: finding.ruleId,
    });
  }

  if (mode === 'prompt') {
    // Tenant slugs are file-path gated, so they do not apply to free prompt
    // text (no fixture path context); email/phone/stripe do. Each hit records
    // the match's actual character offset (prompt:<offset>), not the text
    // length -- useMatchOffset=true derives the offset per match.
    hits.push(...scanLineForPatterns(text, 'prompt', 0, tenantSlugs, false, true));
  } else {
    for (const dl of flattenUnifiedDiff(text)) {
      const allowTenantSlug = FIXTURE_PATH_RE.test(dl.file);
      hits.push(...scanLineForPatterns(dl.content, dl.file, dl.line, tenantSlugs, allowTenantSlug));
    }
  }

  return { verdict: hits.length > 0 ? 'hit' : 'clean', hits };
}

/** Render a hit as the `file:line` location string recorded in the event. */
export function formatHitLocation(hit: ScanHit): string {
  return hit.file === 'prompt' ? `prompt:${hit.line}` : `${hit.file}:${hit.line}`;
}
