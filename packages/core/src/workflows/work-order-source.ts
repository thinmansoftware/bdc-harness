import type { RunAuthorityPolicy } from '@archon/workflows/schemas/workflow';
import type { FrozenSpecSource } from '@archon/workflows/reliability/run-authority';

export interface WorkOrderSourceDependencies {
  readonly fetcher?: typeof fetch;
  readonly githubToken?: string;
}

function githubHeaders(token: string | undefined): Record<string, string> {
  return {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

function encodePath(path: string): string {
  return path
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/');
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) return {};
  const value: unknown = await response.json();
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

export async function freezeWorkOrderSource(
  policy: RunAuthorityPolicy,
  userMessage: string,
  dependencies: WorkOrderSourceDependencies = {}
): Promise<FrozenSpecSource> {
  if (policy.allow_issue_fallback) {
    throw new Error(
      'scope_authority_missing: issue fallback is not implemented; use a canonical git spec'
    );
  }
  const woId = /\bWO-[A-Z0-9-]+\b/.exec(userMessage)?.[0];
  if (!woId) throw new Error('scope_authority_missing: woId');

  const fetcher = dependencies.fetcher ?? fetch;
  const headers = githubHeaders(dependencies.githubToken ?? process.env.GITHUB_TOKEN);
  const repository = policy.spec_repository;
  const revisionResponse = await fetcher(
    `https://api.github.com/repos/${repository}/git/ref/heads/${encodeURIComponent(policy.spec_revision)}`,
    { headers }
  );
  const revisionJson = await readJson(revisionResponse);
  const object = revisionJson.object;
  const specRevision =
    typeof object === 'object' &&
    object !== null &&
    typeof (object as { sha?: unknown }).sha === 'string'
      ? (object as { sha: string }).sha
      : '';
  if (!specRevision) throw new Error('scope_authority_missing: specRevision');

  for (const template of policy.spec_paths) {
    const path = template.replaceAll('{WO_ID}', woId);
    const response = await fetcher(
      `https://api.github.com/repos/${repository}/contents/${encodePath(path)}?ref=${encodeURIComponent(specRevision)}`,
      { headers }
    );
    const json = await readJson(response);
    if (json.type !== 'file' || typeof json.content !== 'string') continue;
    const specBytes = Buffer.from(json.content.replace(/\s/g, ''), 'base64');
    if (specBytes.byteLength === 0) continue;
    return {
      woId,
      specSource: `github:${repository}:${path}`,
      specRevision,
      specBytes,
    };
  }

  throw new Error('scope_authority_missing: canonical spec');
}
