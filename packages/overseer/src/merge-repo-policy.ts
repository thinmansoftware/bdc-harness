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
    main: Object.freeze({ unattended: false, docsOnly: 'skip' }),
  }),
  'thinmansoftware/bdc-xo': Object.freeze({
    main: Object.freeze({ unattended: true, docsOnly: 'merge' }),
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
    return {};
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
  if (rawPolicy !== undefined) return parseMergeRepoPolicy(rawPolicy);
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
