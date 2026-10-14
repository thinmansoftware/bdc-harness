import { readFileSync } from 'node:fs';
import { createPrivateKey } from 'node:crypto';

export const GITHUB_SERVICES = [
  'overseer',
  'pr_discovery',
  'merge_manager',
  'taskmaster',
  'duty_officer',
  'smart_cauldron',
  'run_nodes',
] as const;
export type GitHubService = (typeof GITHUB_SERVICES)[number];

export const SERVICE_GITHUB_AUTH_PRECEDENCE: Record<GitHubService, readonly string[]> = {
  overseer: ['GITHUB_APP_OVERSEER', 'GITHUB_APP', 'PAT'],
  pr_discovery: ['GITHUB_APP_PR_DISCOVERY', 'GITHUB_APP', 'PAT'],
  merge_manager: ['GITHUB_APP_MERGE_MANAGER', 'MERGE_MANAGER_GH_TOKEN', 'NONE'],
  taskmaster: ['GITHUB_APP_TASKMASTER', 'PAT'],
  duty_officer: ['GITHUB_APP_DUTY_OFFICER', 'GITHUB_APP_TASKMASTER', 'PAT'],
  smart_cauldron: ['GITHUB_APP_SMART_CAULDRON', 'GITHUB_APP_TASKMASTER', 'PAT'],
  run_nodes: ['GITHUB_APP_RUN_NODES', 'GITHUB_APP_TASKMASTER', 'PAT'],
};

export type ServiceGitHubAuth =
  | {
      kind: 'app';
      appId: string;
      installationId: string;
      privateKey: string;
      poolId: string;
      distinct: true;
    }
  | { kind: 'pat'; token: string; poolId: 'user-pat' | 'merge-manager-pat'; distinct: boolean }
  | { kind: 'none'; poolId: 'none'; distinct: false };

export interface ResolveServiceGitHubAuthOptions {
  env?: Record<string, string | undefined>;
  readFile?: (path: string) => string;
}

function resolveApp(
  prefix: string,
  env: Record<string, string | undefined>,
  readFile: (path: string) => string
): ServiceGitHubAuth | null {
  const appId = env[`${prefix}_ID`]?.trim() ?? '';
  const installationId = env[`${prefix}_INSTALLATION_ID`]?.trim() ?? '';
  const inline = env[`${prefix}_PRIVATE_KEY`]?.trim() ?? '';
  const path = env[`${prefix}_PRIVATE_KEY_PATH`]?.trim() ?? '';
  if (!appId && !installationId && !inline && !path) return null;
  const missing: string[] = [];
  if (!appId) missing.push(`${prefix}_ID`);
  if (!installationId) missing.push(`${prefix}_INSTALLATION_ID`);
  if (!inline && !path) missing.push(`${prefix}_PRIVATE_KEY or ${prefix}_PRIVATE_KEY_PATH`);
  if (missing.length)
    throw new Error(`Incomplete GitHub App configuration: missing ${missing.join(', ')}`);
  let privateKey: string;
  try {
    privateKey = (inline || readFile(path)).replace(/\\n/g, '\n').trim();
  } catch {
    throw new Error(`Unable to read ${prefix}_PRIVATE_KEY_PATH`);
  }
  try {
    createPrivateKey(privateKey);
  } catch {
    throw new Error(`${prefix.toLowerCase()}_private_key_malformed`);
  }
  return {
    kind: 'app',
    appId,
    installationId,
    privateKey,
    poolId: `app-${appId}-${installationId}`,
    distinct: true,
  };
}

export function resolveServiceGitHubAuth(
  service: GitHubService,
  options: ResolveServiceGitHubAuthOptions = {}
): ServiceGitHubAuth {
  const env = options.env ?? process.env;
  const readFile = options.readFile ?? (path => readFileSync(path, 'utf8'));
  for (const source of SERVICE_GITHUB_AUTH_PRECEDENCE[service]) {
    if (source.startsWith('GITHUB_APP')) {
      const app = resolveApp(source, env, readFile);
      if (app) return app;
    } else if (source === 'MERGE_MANAGER_GH_TOKEN' && env.MERGE_MANAGER_GH_TOKEN?.trim()) {
      return {
        kind: 'pat',
        token: env.MERGE_MANAGER_GH_TOKEN.trim(),
        poolId: 'merge-manager-pat',
        distinct: true,
      };
    } else if (source === 'PAT') {
      const token =
        service === 'duty_officer'
          ? env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim()
          : env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim();
      if (token)
        return { kind: 'pat', token, poolId: 'user-pat', distinct: service !== 'merge_manager' };
    } else if (source === 'NONE') return { kind: 'none', poolId: 'none', distinct: false };
  }
  return { kind: 'none', poolId: 'none', distinct: false };
}

export function resolvePatFallback(
  env: Record<string, string | undefined> = process.env
): ServiceGitHubAuth {
  const token = env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim();
  return token
    ? { kind: 'pat', token, poolId: 'user-pat', distinct: true }
    : { kind: 'none', poolId: 'none', distinct: false };
}
