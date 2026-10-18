import {
  getServiceGitHubToken,
  resolveServiceGitHubAuth,
  type GitHubService,
  type ServiceGitHubAuth,
} from '../packages/core/src/github/service-identity';

export interface QuotaProbeResult {
  identity: string;
  limit: number;
  remaining: number;
  resource: string;
  reset: number;
}

function headerNumber(response: Response, name: string): number {
  const value = Number(response.headers.get(name));
  return Number.isFinite(value) ? value : 0;
}

export async function probeIdentity(
  label: string,
  identity: ServiceGitHubAuth,
  options: { fetch?: typeof fetch; apiBaseUrl?: string } = {}
): Promise<QuotaProbeResult> {
  const fetchImpl = options.fetch ?? fetch;
  const token = await getServiceGitHubToken(identity, {
    fetch: fetchImpl,
    apiBaseUrl: options.apiBaseUrl,
  });
  const response = await fetchImpl(`${options.apiBaseUrl ?? 'https://api.github.com'}/rate_limit`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'bdc-harness-quota-probe',
    },
  });
  if (!response.ok) throw new Error(`github_quota_probe_failed:${label}:${response.status}`);
  return {
    identity: label,
    limit: headerNumber(response, 'x-ratelimit-limit'),
    remaining: headerNumber(response, 'x-ratelimit-remaining'),
    resource: response.headers.get('x-ratelimit-resource') ?? 'unknown',
    reset: headerNumber(response, 'x-ratelimit-reset'),
  };
}

export async function runQuotaProbe(
  env: Record<string, string | undefined> = process.env
): Promise<QuotaProbeResult[]> {
  const identities: [string, ServiceGitHubAuth][] = [];
  const userToken = env.GH_TOKEN ?? env.GITHUB_TOKEN;
  if (userToken)
    identities.push([
      'user-pat',
      { kind: 'pat', service: 'taskmaster', token: userToken, poolId: 'user-pat', distinct: false },
    ]);
  if (env.MERGE_MANAGER_GH_TOKEN)
    identities.push([
      'merge-manager-pat',
      {
        kind: 'pat',
        service: 'merge_manager',
        token: env.MERGE_MANAGER_GH_TOKEN,
        poolId: 'merge-manager-pat',
        distinct: true,
      },
    ]);

  const services: GitHubService[] = [
    'overseer',
    'pr_discovery',
    'merge_manager',
    'taskmaster',
    'duty_officer',
    'smart_cauldron',
    'run_nodes',
  ];
  const seenPools = new Set<string>();
  for (const service of services) {
    try {
      const identity = resolveServiceGitHubAuth(service, env);
      if (identity.kind !== 'app' || seenPools.has(identity.poolId)) continue;
      seenPools.add(identity.poolId);
      identities.push([`${service}-app`, identity]);
    } catch (error) {
      if (String(error).includes('github_auth_missing')) continue;
      throw error;
    }
  }
  return Promise.all(identities.map(([label, identity]) => probeIdentity(label, identity)));
}

if (import.meta.main) {
  runQuotaProbe()
    .then(results => {
      console.log(JSON.stringify(results));
    })
    .catch(error => {
      console.error(
        JSON.stringify({
          error: error instanceof Error ? error.message : 'github_quota_probe_failed',
        })
      );
      process.exitCode = 1;
    });
}
