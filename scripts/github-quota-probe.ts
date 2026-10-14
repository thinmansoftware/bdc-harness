import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';

export interface QuotaProbeResult {
  identity: string;
  limit: number;
  remaining: number;
  resource: string;
  reset: number;
}

interface ProbeIdentity {
  label: string;
  token: () => Promise<string>;
}

interface ProbeOptions {
  env?: Record<string, string | undefined>;
  fetch?: typeof globalThis.fetch;
  readFile?: (path: string) => string;
  mintAppToken?: (config: {
    appId: string;
    installationId: string;
    privateKey: string;
  }) => Promise<string>;
  baseUrl?: string;
}

const APP_PREFIXES = [
  ['overseer-app', 'GITHUB_APP'],
  ['pr-discovery-app', 'GITHUB_APP_PR_DISCOVERY'],
  ['merge-manager-app', 'GITHUB_APP_MERGE_MANAGER'],
  ['taskmaster-app', 'GITHUB_APP_TASKMASTER'],
  ['duty-officer-app', 'GITHUB_APP_DUTY_OFFICER'],
  ['smart-cauldron-app', 'GITHUB_APP_SMART_CAULDRON'],
  ['run-nodes-app', 'GITHUB_APP_RUN_NODES'],
] as const;

function appIdentity(
  label: string,
  prefix: string,
  env: Record<string, string | undefined>,
  readFile: (path: string) => string,
  mintAppToken: NonNullable<ProbeOptions['mintAppToken']>
): ProbeIdentity | undefined {
  const appId = env[`${prefix}_ID`]?.trim() ?? '';
  const installationId = env[`${prefix}_INSTALLATION_ID`]?.trim() ?? '';
  const inlineKey = env[`${prefix}_PRIVATE_KEY`]?.trim() ?? '';
  const keyPath = env[`${prefix}_PRIVATE_KEY_PATH`]?.trim() ?? '';
  if (!appId && !installationId && !inlineKey && !keyPath) return undefined;

  const missing = [
    !appId && `${prefix}_ID`,
    !installationId && `${prefix}_INSTALLATION_ID`,
    !inlineKey && !keyPath && `${prefix}_PRIVATE_KEY or ${prefix}_PRIVATE_KEY_PATH`,
  ].filter(Boolean);
  if (missing.length > 0)
    throw new Error(`Incomplete ${label} configuration: missing ${missing.join(', ')}`);

  return {
    label,
    token: async () => {
      const privateKey = (inlineKey || readFile(keyPath)).replace(/\\n/g, '\n').trim();
      return mintAppToken({ appId, installationId, privateKey });
    },
  };
}

async function defaultMintAppToken(config: {
  appId: string;
  installationId: string;
  privateKey: string;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
    iat: now - 60,
    exp: now + 540,
    iss: config.appId,
  })}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  const jwt = `${unsigned}.${signer.sign(config.privateKey, 'base64url')}`;
  const response = await fetch(
    `https://api.github.com/app/installations/${encodeURIComponent(config.installationId)}/access_tokens`,
    {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${jwt}`,
        'user-agent': 'bdc-harness-quota-probe',
        'x-github-api-version': '2022-11-28',
      },
    }
  );
  if (!response.ok) throw new Error('GitHub App token mint failed');
  const body = (await response.json()) as { token?: unknown };
  if (typeof body.token !== 'string') throw new Error('GitHub App token mint returned no token');
  return body.token;
}

export async function probeGitHubQuotas(options: ProbeOptions = {}): Promise<QuotaProbeResult[]> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const readFile = options.readFile ?? (path => readFileSync(path, 'utf8'));
  const mintAppToken = options.mintAppToken ?? defaultMintAppToken;
  const identities: ProbeIdentity[] = [];
  const userPat = env.GH_TOKEN ?? env.GITHUB_TOKEN;
  if (userPat) identities.push({ label: 'user-pat', token: async () => userPat });
  if (env.MERGE_MANAGER_GH_TOKEN) {
    const mergePat = env.MERGE_MANAGER_GH_TOKEN;
    identities.push({ label: 'merge-manager-pat', token: async () => mergePat });
  }
  for (const [label, prefix] of APP_PREFIXES) {
    const identity = appIdentity(label, prefix, env, readFile, mintAppToken);
    if (identity) identities.push(identity);
  }

  const results: QuotaProbeResult[] = [];
  for (const identity of identities) {
    let response: Response;
    try {
      response = await fetchImpl(`${options.baseUrl ?? 'https://api.github.com'}/rate_limit`, {
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${await identity.token()}`,
          'user-agent': 'bdc-harness-quota-probe',
          'x-github-api-version': '2022-11-28',
        },
      });
    } catch {
      throw new Error(`Quota probe failed for ${identity.label}`);
    }
    if (!response.ok)
      throw new Error(`Quota probe failed for ${identity.label}: HTTP ${response.status}`);
    const header = (name: string) => response.headers.get(name) ?? '';
    results.push({
      identity: identity.label,
      limit: Number(header('x-ratelimit-limit')),
      remaining: Number(header('x-ratelimit-remaining')),
      resource: header('x-ratelimit-resource'),
      reset: Number(header('x-ratelimit-reset')),
    });
  }
  return results;
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(await probeGitHubQuotas()));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Quota probe failed');
    process.exitCode = 1;
  }
}
