import { createLogger } from '@archon/paths';

const log = createLogger('overseer/merge-repo-policy');
const warnedLegacyEnvs = new Set<string>();

export const MERGE_MANAGER_REPO_POLICY_ENV = 'MERGE_MANAGER_REPO_POLICY' as const;
export const LEGACY_ALLOWED_BASES_ENV = 'MERGE_MANAGER_ALLOWED_BASES' as const;
export const LEGACY_REPO_CONFIG_ENV = 'OVERSEER_MERGE_REPO_CONFIG' as const;
export const DISCOVERY_REPOS_ENV = 'OVERSEER_MERGE_DISCOVERY_REPOS' as const;

export type DocsOnlyPolicy = 'merge' | 'skip';
export interface RepoBasePolicy {
  readonly unattended: boolean;
  readonly docsOnly: DocsOnlyPolicy;
}
export type MergeRepoPolicy = Readonly<Record<string, Readonly<Record<string, RepoBasePolicy>>>>;

// AGD The shipped policy declares candidacy per repo; production-effect classification remains separate.
export const DEFAULT_MERGE_REPO_POLICY: MergeRepoPolicy = Object.freeze({
  'thinmansoftware/bdc-harness': Object.freeze({
    dev: Object.freeze({ unattended: true, docsOnly: 'skip' }),
    staging: Object.freeze({ unattended: true, docsOnly: 'skip' }),
    main: Object.freeze({ unattended: false, docsOnly: 'skip' }),
  }),
  'thinmansoftware/shopops': Object.freeze({
    staging: Object.freeze({ unattended: true, docsOnly: 'skip' }),
    master: Object.freeze({ unattended: false, docsOnly: 'skip' }),
  }),
  'thinmansoftware/lspro-react': Object.freeze({
    dev: Object.freeze({ unattended: true, docsOnly: 'skip' }),
    staging: Object.freeze({ unattended: true, docsOnly: 'skip' }),
    main: Object.freeze({ unattended: false, docsOnly: 'skip' }),
    'release/ce': Object.freeze({ unattended: false, docsOnly: 'skip' }),
  }),
  'thinmansoftware/shopops-storefront': Object.freeze({
    staging: Object.freeze({ unattended: true, docsOnly: 'skip' }),
    master: Object.freeze({ unattended: false, docsOnly: 'skip' }),
  }),
  'thinmansoftware/bdc-xo': Object.freeze({
    main: Object.freeze({ unattended: true, docsOnly: 'merge' }),
  }),
  // Merging main deploys the Vercel production project shopops-pull-list (bdc-xo#5469).
  'thinmansoftware/bdc-shopify-app': Object.freeze({
    main: Object.freeze({ unattended: false, docsOnly: 'skip' }),
  }),
  // WO-HARNESS-MERGE-POLICY-PROVISIONER-AND-REPO-SKIP-LINE-01 (bdc-xo#5581). Merging main here deploys
  // ONLY the staging Vercel project comicstoreos-provisioner-staging (evidence: bdc-xo#5576, comment
  // 6810214724, read 2026-11-11 23:58Z: one linked project, "Production" deployments point at it, no
  // workflow runs vercel deploy, --prod, ssh or docker push). THIS ENTRY HOLDS ONLY WHILE THAT IS TRUE:
  // if a production provisioner project, domain or workflow ever deploys from main, move this base to
  // COVERED_PRODUCTION_BASES (m09-promotion-gate.ts) and set unattended to false BEFORE any further
  // unattended merge; the guard test production_bases_match_merge_policy fails when the tables disagree.
  'thinmansoftware/comicstoreos-provisioner': Object.freeze({
    main: Object.freeze({ unattended: true, docsOnly: 'skip' }),
  }),
});

export interface MergeRepoPolicyOptions {
  readonly rawPolicy?: string;
  readonly legacyAllowedBases?: readonly string[] | string;
  readonly legacyRepos?: readonly string[] | string;
  readonly legacyRepoConfig?: Readonly<Record<string, { readonly baseBranch: string }>>;
}

interface PolicyLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

function normalizeOwnerRepo(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  const slash = normalized.indexOf('/');
  return slash > 0 && slash === normalized.lastIndexOf('/') && slash < normalized.length - 1
    ? normalized
    : null;
}

function stringList(value: readonly string[] | string | undefined): readonly string[] {
  const entries = typeof value === 'string' ? value.split(',') : (value ?? []);
  return entries.map(entry => entry.trim().toLowerCase()).filter(Boolean);
}

// AGD Malformed policy always becomes an empty policy: configuration errors may never broaden merge authority.
export function parseMergeRepoPolicy(raw: string, logger: PolicyLogger = log): MergeRepoPolicy {
  return tryParseMergeRepoPolicy(raw, logger) ?? {};
}

/** The parsed policy, or null when the value is malformed (a warning is logged). */
export function tryParseMergeRepoPolicy(
  raw: string,
  logger: PolicyLogger = log
): MergeRepoPolicy | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('not_object');
    const policy: Record<string, Record<string, RepoBasePolicy>> = {};
    for (const [rawRepo, rawBases] of Object.entries(parsed)) {
      const repo = normalizeOwnerRepo(rawRepo);
      if (
        !repo ||
        rawRepo !== repo ||
        !rawBases ||
        typeof rawBases !== 'object' ||
        Array.isArray(rawBases)
      ) {
        throw new Error('invalid_repo_entry');
      }
      const bases: Record<string, RepoBasePolicy> = {};
      for (const [rawBase, rawRule] of Object.entries(rawBases)) {
        const base = rawBase.trim().toLowerCase();
        if (
          !base ||
          rawBase !== base ||
          !rawRule ||
          typeof rawRule !== 'object' ||
          Array.isArray(rawRule)
        ) {
          throw new Error('invalid_base_entry');
        }
        const rule = rawRule as { unattended?: unknown; docs_only?: unknown };
        if (
          typeof rule.unattended !== 'boolean' ||
          (rule.docs_only !== 'merge' && rule.docs_only !== 'skip')
        ) {
          throw new Error('invalid_base_rule');
        }
        bases[base] = { unattended: rule.unattended, docsOnly: rule.docs_only };
      }
      policy[repo] = bases;
    }
    return policy;
  } catch (error) {
    logger.warn(
      {
        env: MERGE_MANAGER_REPO_POLICY_ENV,
        err: error instanceof Error ? error.message : 'invalid',
      },
      'merge_manager.repo_policy_malformed -- failing closed with an empty policy'
    );
    return null;
  }
}

function legacyPolicy(options: MergeRepoPolicyOptions): MergeRepoPolicy {
  const allowedBases = stringList(
    options.legacyAllowedBases ?? process.env[LEGACY_ALLOWED_BASES_ENV]
  );
  const repos = stringList(options.legacyRepos ?? process.env[DISCOVERY_REPOS_ENV]);
  const policy: Record<string, Record<string, RepoBasePolicy>> = {};
  for (const rawRepo of repos) {
    const repo = normalizeOwnerRepo(rawRepo);
    if (!repo) continue;
    policy[repo] = Object.fromEntries(
      allowedBases.map(base => [base, { unattended: true, docsOnly: 'skip' as const }])
    );
  }
  for (const [rawRepo, config] of Object.entries(options.legacyRepoConfig ?? {})) {
    const repo = normalizeOwnerRepo(rawRepo);
    const base = config.baseBranch.trim().toLowerCase();
    if (repo && base) policy[repo] = { [base]: { unattended: true, docsOnly: 'skip' } };
  }
  return policy;
}

export function resolveMergeRepoPolicy(options: MergeRepoPolicyOptions = {}): MergeRepoPolicy {
  const rawPolicy = options.rawPolicy ?? process.env[MERGE_MANAGER_REPO_POLICY_ENV];
  if (rawPolicy !== undefined) {
    // ADDITIVE (WO-HARNESS-MERGE-POLICY-PROVISIONER-AND-REPO-SKIP-LINE-01, bdc-xo#5581): a parseable value
    // is merged OVER the in-code default per repository, so a repository added to the default ships with
    // the next rebuild without editing the host environment. A repository present in the value replaces
    // that repository's default entry (an empty object lists it with no bases: nothing is allowed). A
    // malformed value is still the EMPTY policy: a configuration error never broadens merge authority.
    const parsed = tryParseMergeRepoPolicy(rawPolicy);
    return parsed === null ? {} : { ...DEFAULT_MERGE_REPO_POLICY, ...parsed };
  }
  const legacyConfigured =
    options.legacyAllowedBases !== undefined ||
    options.legacyRepoConfig !== undefined ||
    process.env[LEGACY_ALLOWED_BASES_ENV] !== undefined ||
    process.env[LEGACY_REPO_CONFIG_ENV] !== undefined;
  return legacyConfigured ? legacyPolicy(options) : DEFAULT_MERGE_REPO_POLICY;
}

export function getRepoBasePolicy(
  ownerRepo: string,
  base: string,
  policy: MergeRepoPolicy = resolveMergeRepoPolicy()
): RepoBasePolicy | undefined {
  return policy[ownerRepo.trim().toLowerCase()]?.[base.trim().toLowerCase()];
}

export function hasRepoPolicyEntry(
  ownerRepo: string,
  policy: MergeRepoPolicy = resolveMergeRepoPolicy()
): boolean {
  return Object.hasOwn(policy, ownerRepo.trim().toLowerCase());
}

export function unattendedBasesForRepo(
  ownerRepo: string,
  policy: MergeRepoPolicy = resolveMergeRepoPolicy()
): readonly string[] {
  const bases = policy[ownerRepo.trim().toLowerCase()] ?? {};
  return Object.entries(bases)
    .filter(([, rule]) => rule.unattended)
    .map(([base]) => base);
}

export function warnLegacyMergePolicy(env: string): void {
  if (warnedLegacyEnvs.has(env)) return;
  warnedLegacyEnvs.add(env);
  log.warn(
    { env, replacement: MERGE_MANAGER_REPO_POLICY_ENV },
    'merge_manager.legacy_repo_policy_deprecated'
  );
}
