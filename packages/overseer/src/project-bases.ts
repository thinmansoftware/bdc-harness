/**
 * Cauldron project base branches (the branch a project's real work merges into).
 *
 * The Overseer reconcile loop closes a WO tracker only when a merged PR carries a
 * closing keyword for it AND the PR merged into its project's base branch -- the
 * same branch GitHub would honour a closing keyword for if that branch were the
 * repository default. GitHub only auto-closes on a merge into the DEFAULT branch,
 * so projects whose Cauldron base is a non-default branch (staging, dev, bdc/main)
 * never get their trackers closed by GitHub; reconcile is what closes them.
 *
 * Source of truth: bdc-xo scripts/cauldron/cauldron-projects.json. This constant
 * is restated here (not fetched) so the overseer package has no runtime dependency
 * on bdc-xo; keep it in sync when a project's Cauldron base changes. All projects
 * are under owner `thinmansoftware`.
 *
 * Override at runtime with OVERSEER_PROJECT_BASES: a JSON object mapping
 * "owner/repo" -> "branch". Entries in the env override the constant; unknown
 * repos resolve to null (their merges close nothing).
 */
export const PROJECT_BASES: Readonly<Record<string, string>> = {
  'thinmansoftware/shopops': 'staging',
  'thinmansoftware/shopops-storefront': 'staging',
  'thinmansoftware/lspro-react': 'staging',
  'thinmansoftware/scout-service': 'staging',
  'thinmansoftware/receiving-shipping-desk': 'staging',
  'thinmansoftware/whats-that-tee-time': 'staging',
  'thinmansoftware/bdc-harness': 'dev',
  'thinmansoftware/bdc-xo': 'main',
  'thinmansoftware/bdc-ci': 'main',
  'thinmansoftware/bdc-crm': 'main',
  'thinmansoftware/model-tier-advisor': 'main',
  'thinmansoftware/shopops-comic-theme': 'main',
  'thinmansoftware/comicstoreos-site': 'main',
  'thinmansoftware/comicstoreos-infra': 'main',
  'thinmansoftware/comicstoreos-provisioner': 'main',
  'thinmansoftware/bdc-shopify-app': 'main',
  'thinmansoftware/shopops-woo-theme': 'main',
  'thinmansoftware/bdc-woo-app': 'main',
  'thinmansoftware/bdc-store-factory': 'main',
  'thinmansoftware/fuelglass': 'main',
  'thinmansoftware/ollama-librarian': 'main',
  'thinmansoftware/thinman-freight': 'master',
  'thinmansoftware/t3code-bdc': 'bdc/main',
};

export const OVERSEER_PROJECT_BASES_ENV = 'OVERSEER_PROJECT_BASES';

/**
 * Parse OVERSEER_PROJECT_BASES into a map. Returns an empty map (and logs a
 * warning) on malformed JSON or a non-string value, so a bad override degrades
 * to the built-in constant rather than crashing the reconcile loop. Only
 * string-valued entries are accepted.
 */
function readProjectBaseOverrides(): Record<string, string> {
  const raw = process.env[OVERSEER_PROJECT_BASES_ENV];
  if (!raw?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn(
      `[overseer/project-bases] ${OVERSEER_PROJECT_BASES_ENV} is not valid JSON; ignoring`
    );
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.warn(
      `[overseer/project-bases] ${OVERSEER_PROJECT_BASES_ENV} must be a JSON object of "owner/repo":"branch"; ignoring`
    );
    return {};
  }
  const overrides: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'string' && value.trim()) overrides[key] = value;
  }
  return overrides;
}

/**
 * Resolve the Cauldron base branch for a repository. The env override
 * (OVERSEER_PROJECT_BASES) wins over the built-in constant. An unknown repo
 * resolves to null -- its merges close no tracker.
 */
export function resolveProjectBase(owner: string, repo: string): string | null {
  const key = `${owner}/${repo}`;
  const overrides = readProjectBaseOverrides();
  if (Object.prototype.hasOwnProperty.call(overrides, key)) return overrides[key] ?? null;
  if (Object.prototype.hasOwnProperty.call(PROJECT_BASES, key)) return PROJECT_BASES[key] ?? null;
  return null;
}
