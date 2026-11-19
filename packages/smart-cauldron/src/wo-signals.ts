/**
 * wo-signals.ts -- Routing signals the conductor reads from a WO itself.
 *
 * Why this exists (WO-HARNESS-CONDUCTOR-RISK-ROUTING-01): the conductor ruleset
 * routes on `--class` and `--tags`, and the caller supplies both. A supervised
 * fire with no tags therefore fell through to the plain-CODE rule and entered
 * the zero (open-model, no paid review seat) tier even when the WO touched
 * migrations, roles, RLS, auth or money -- exactly the work ladder.config.json
 * says must stay off zero. The WO already declares its own risk (Author.md Step
 * 2.6b `Rung classification:` field, labels, and the spec body), so the conductor
 * reads it instead of trusting a human to remember `-Tags`.
 *
 * Three signals, all optional, all derived without a model call:
 *   1. risk tags    -- money / auth / migration, from labels and the spec text
 *   2. rung field   -- the spec's `Rung classification:` declaration
 *   3. entry pin    -- the spec's `entry_tier:` / `Entry tier:` frontmatter, which
 *                      pins the entry tier exactly like `--entry` does
 *
 * Risk tags are fed into the existing ruleset (config/ruleset.config.json), so
 * where a risky WO enters stays a config edit, not a code edit.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** Repo that holds canonical WO specs (docs/work-orders/<WO-ID>.md on main). */
export const WO_SPEC_REPO = 'thinmansoftware/bdc-xo';

export interface WoSignals {
  /** Tags the ruleset should treat as if the caller had passed them. */
  readonly riskTags: readonly string[];
  /** Entry tier pinned by the spec frontmatter, or null. */
  readonly entryPin: string | null;
  /** Normalized `Rung classification:` value, or null. */
  readonly rungClassification: string | null;
  /** Human-readable reasons (one per signal) for the cascade log. */
  readonly reasons: readonly string[];
  /** True when a spec body was available to read. */
  readonly specRead: boolean;
}

export const EMPTY_WO_SIGNALS: WoSignals = {
  riskTags: [],
  entryPin: null,
  rungClassification: null,
  reasons: [],
  specRead: false,
};

/**
 * Spec-text patterns per risk tag. Deliberately biased toward false positives:
 * a false positive only moves a WO from the free zero tier to cursor, a false
 * negative runs migrations or money code on a tier with no paid review seat.
 */
const SPEC_RISK_PATTERNS: readonly { tag: string; label: string; pattern: RegExp }[] = [
  {
    tag: 'money',
    label: 'money/billing',
    pattern: /\b(stripe|billing|payments?|refunds?|invoices?|checkout|money)\b/i,
  },
  {
    tag: 'auth',
    label: 'auth/roles',
    pattern:
      /\b(auth|oauth|jwt|rbac|rls|row[- ]level security|credentials?|secrets?|permissions?|roles?)\b/i,
  },
  {
    tag: 'migration',
    label: 'migration/schema',
    pattern:
      /\b(migrations?|alter table|create table|drop table|create policy|grant|revoke)\b|supabase[\\/]migrations/i,
  },
];

const LABEL_RISK_PATTERNS: readonly { tag: string; pattern: RegExp }[] = [
  { tag: 'money', pattern: /billing|stripe|payment|money/i },
  { tag: 'auth', pattern: /auth|security|rls|roles?\b/i },
  { tag: 'migration', pattern: /migration|schema|database/i },
];

/** Risk tags implied by GitHub issue labels (e.g. `risk:billing`, `area:auth`). */
export function riskTagsFromLabels(labels: readonly string[]): string[] {
  const tags = new Set<string>();
  for (const label of labels) {
    for (const { tag, pattern } of LABEL_RISK_PATTERNS) {
      if (pattern.test(label)) tags.add(tag);
    }
  }
  return [...tags];
}

const ENTRY_PIN_RE = /^[\s>*-]*entry[_ -]?tier\s*:\s*[`'"]?([a-z0-9_-]+)[`'"]?\s*$/im;
const RUNG_RE = /^[\s>*-]*rung[_ ]classification\s*:\s*[`'"]?([^\n`'"]+)/im;

/** Pull signals out of a WO spec body. Pure; never throws. */
export function parseWoSpecSignals(specText: string): WoSignals {
  const tags = new Set<string>();
  const reasons: string[] = [];

  const pinMatch = ENTRY_PIN_RE.exec(specText);
  const entryPin = pinMatch ? pinMatch[1].toLowerCase() : null;
  if (entryPin) reasons.push(`spec pins entry tier "${entryPin}"`);

  // An unfilled template line lists every choice joined by "|" -- not a declaration.
  const rungMatch = RUNG_RE.exec(specText);
  const rungRaw = rungMatch ? rungMatch[1].trim().toLowerCase() : '';
  const rungClassification = rungRaw && !rungRaw.includes('|') ? rungRaw : null;
  if (rungClassification) {
    reasons.push(`spec declares Rung classification "${rungClassification}"`);
    if (/billing|auth|infra/.test(rungClassification)) {
      tags.add('money');
      tags.add('auth');
    }
    if (/feature|net-new|multi-surface/.test(rungClassification)) tags.add('feature');
  }

  // The Rung classification line (and its unfilled template form, which lists
  // "billing/auth/infra") is routing metadata, not WO content -- keep it out of
  // the risk scan or every WO that left the template line would look risky.
  const scanText = specText.replace(/^.*rung[_ ]classification.*$/gim, '');
  for (const { tag, label, pattern } of SPEC_RISK_PATTERNS) {
    const hit = pattern.exec(scanText);
    if (hit) {
      tags.add(tag);
      reasons.push(`spec mentions ${label} ("${hit[0].toLowerCase()}")`);
    }
  }

  return {
    riskTags: [...tags],
    entryPin,
    rungClassification,
    reasons,
    specRead: true,
  };
}

/** Merge label-derived and spec-derived signals. */
export function mergeWoSignals(labels: readonly string[], spec: WoSignals | null): WoSignals {
  const fromLabels = riskTagsFromLabels(labels);
  const tags = new Set<string>([...fromLabels, ...(spec?.riskTags ?? [])]);
  const reasons = [...(spec?.reasons ?? [])];
  if (fromLabels.length > 0) reasons.push(`labels imply risk tags: ${fromLabels.join(',')}`);
  return {
    riskTags: [...tags],
    entryPin: spec?.entryPin ?? null,
    rungClassification: spec?.rungClassification ?? null,
    reasons,
    specRead: spec?.specRead ?? false,
  };
}

/**
 * Read a WO spec from bdc-xo main through the GitHub API (the container's gh is
 * authenticated; Cauldron's own read-spec node uses the same path). Returns null
 * on any failure -- the caller logs it and keeps the ruleset pick. Hermetic mode
 * (SMART_CAULDRON_HERMETIC=1) makes no GitHub call, matching already-satisfied.ts.
 */
export async function fetchWoSpecText(woId: string): Promise<string | null> {
  if (process.env.SMART_CAULDRON_HERMETIC === '1') return null;
  if (!/^[A-Za-z0-9._-]+$/.test(woId)) return null;
  try {
    const { stdout } = await execFileAsync(
      'gh',
      [
        'api',
        '-H',
        'Accept: application/vnd.github.raw',
        `repos/${WO_SPEC_REPO}/contents/docs/work-orders/${woId}.md?ref=main`,
      ],
      { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 }
    );
    return stdout.length > 0 ? stdout : null;
  } catch {
    return null;
  }
}

export interface ResolveWoSignalsOptions {
  readonly woId: string;
  readonly labels?: readonly string[];
  /** Spec reader override (tests). Defaults to fetchWoSpecText. */
  readonly readSpec?: (woId: string) => Promise<string | null>;
}

/** Resolve all routing signals for a WO. Never throws. */
export async function resolveWoSignals(opts: ResolveWoSignalsOptions): Promise<WoSignals> {
  let specText: string | null = null;
  try {
    specText = await (opts.readSpec ?? fetchWoSpecText)(opts.woId);
  } catch {
    specText = null;
  }
  const spec = specText === null ? null : parseWoSpecSignals(specText);
  return mergeWoSignals(opts.labels ?? [], spec);
}
