import { listCodebases } from '@archon/core/db/codebases';
import { createHash } from 'crypto';
import {
  getServiceGitHubToken,
  resolveServiceGitHubAuth,
} from '@archon/core/github/service-identity';
import { serviceGitHubFetchWithPermissionFallback } from '@archon/core/github/request';
import {
  freezeWorkOrderSource,
  type ExpectedSpecIdentity,
} from '@archon/core/workflows/work-order-source';

export interface FireEligibilityEvidence {
  woId: string;
  targetRepo: string;
  project: string;
  specVerifiedAt: string;
  noOpenOrMergedPr: true;
  /** Legacy source category; repo-path covers either exact committed path.
   * expectedSpec.specSource carries the full canonical path. */
  specSource?: 'repo-path' | 'date-glob' | 'issue-body';
  expectedSpec?: ExpectedSpecIdentity;
}

export interface FireEligibilityResult {
  eligible: boolean;
  evidence?: FireEligibilityEvidence;
  reason?: string;
}

export interface FireEligibilityDeps {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  codebases?: () => Promise<readonly { name: string; repository_url: string | null }[]>;
  /** Overrides GITHUB_TOKEN/GH_TOKEN resolution; canonical reads are never anonymous. */
  githubToken?: string;
}

const WO_ID_RE = /\b(WO-[A-Z][A-Z0-9-]*-\d+)\b/;

function headers(token: string): Record<string, string> {
  return {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
  };
}

function assertRateLimit(response: Response): void {
  const remaining = Number.parseInt(response.headers.get('x-ratelimit-remaining') ?? '', 10);
  if (Number.isInteger(remaining) && remaining < 5) {
    throw new Error(`taskmaster_github_rate_limit_backoff:${remaining}`);
  }
}

export function normalizeRepo(value: string): string {
  return value
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/^git@github\.com:/i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '')
    .toLowerCase();
}

export async function checkFireEligibility(
  issueTitle: string,
  deps: FireEligibilityDeps = {}
): Promise<FireEligibilityResult> {
  const woId = WO_ID_RE.exec(issueTitle)?.[1];
  if (!woId) return { eligible: false, reason: 'wo_id_missing' };
  const fetchImpl = deps.fetchImpl ?? fetch;
  // Injecting a fetcher bypasses the fail-closed authentication guard inside
  // resolveWorkOrderSource, so the token is resolved and asserted here instead.
  // Unauthenticated canonical reads would break private-repo access and burn
  // the 60/hr anonymous rate limit.
  const identity = resolveServiceGitHubAuth('taskmaster');
  const token = deps.githubToken ?? (await getServiceGitHubToken(identity));
  if (!token) return { eligible: false, reason: 'github_auth_missing' };
  let frozen;
  try {
    // Restrictive subset of the current lane authority policy. The runtime
    // resolves its own policy and must match this identity before worker creation.
    // XO1843 permits rejecting issue-only specs; issue content is not a grant.
    frozen = await freezeWorkOrderSource(
      {
        required: true,
        spec_repository: 'thinmansoftware/bdc-xo',
        spec_revision: 'main',
        spec_paths: ['docs/work-orders/{WO_ID}.md', 'docs/superpowers/specs/{WO_ID}.md'],
        allow_issue_fallback: false,
      },
      woId,
      {
        githubToken: token,
        fetcher: (async (input, init) => {
          const response = await fetchImpl(input, init);
          assertRateLimit(response);
          if (!response.ok && response.status !== 404)
            throw new Error(`taskmaster_fire_spec_read_failed:${response.status}`);
          return response;
        }) as typeof fetch,
      }
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('scope_authority_missing:')) {
      return { eligible: false, reason: 'spec_missing' };
    }
    throw error;
  }
  const body = Buffer.from(frozen.specBytes).toString('utf8');
  const expectedSpec: ExpectedSpecIdentity = {
    specSource: frozen.specSource,
    specRevision: frozen.specRevision,
    specHash: `sha256:${createHash('sha256').update(frozen.specBytes).digest('hex')}`,
  };
  if (!/^cauldron_compatible:\s*true\s*$/im.test(body)) {
    return { eligible: false, reason: 'cauldron_incompatible' };
  }
  const targetRepo = /^target_repo:\s*([^\s#]+)\s*$/im.exec(body)?.[1];
  if (!targetRepo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(targetRepo)) {
    return { eligible: false, reason: 'target_repo_missing' };
  }

  const codebases = await (deps.codebases ?? listCodebases)();
  const repoKey = normalizeRepo(targetRepo);
  const codebase = codebases.find(cb => normalizeRepo(cb.repository_url ?? cb.name) === repoKey);
  if (!codebase) return { eligible: false, reason: 'project_not_registered' };
  const project = codebase.name.includes('/') ? codebase.name.split('/').at(-1) : codebase.name;
  if (!project) return { eligible: false, reason: 'project_not_registered' };

  // Complete all-state history is required before asserting that this WO has
  // no open or merged PR. Search has an independent, scarce resource budget.
  const escaped = woId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const exactWo = new RegExp(`(?:^|[^A-Za-z0-9-])${escaped}(?:[^A-Za-z0-9-]|$)`);
  const identities = new Map<number, string>();
  let satisfying = false;
  let complete = false;
  const maxPages = 100;
  for (let page = 1; page <= maxPages; page++) {
    const url = `https://api.github.com/repos/${targetRepo}/pulls?state=all&per_page=100&sort=created&direction=asc&page=${page}`;
    const response = deps.githubToken
      ? await fetchImpl(url, { headers: headers(token) })
      : await serviceGitHubFetchWithPermissionFallback({
          service: 'taskmaster',
          fetch: fetchImpl,
          resource: 'core',
          identity,
          url,
        });
    assertRateLimit(response);
    if (!response.ok) throw new Error(`taskmaster_fire_pr_listing_failed:${response.status}`);
    const rows: unknown = await response.json();
    if (!Array.isArray(rows) || rows.length > 100)
      throw new Error('taskmaster_fire_pr_listing_invalid_page');
    for (const value of rows) {
      if (!value || typeof value !== 'object')
        throw new Error('taskmaster_fire_pr_listing_invalid_row');
      const pr = value as Record<string, unknown>;
      if (
        !Number.isSafeInteger(pr.number) ||
        (pr.number as number) <= 0 ||
        typeof pr.title !== 'string' ||
        !(pr.body === null || typeof pr.body === 'string') ||
        !['open', 'closed'].includes(pr.state as string) ||
        !(
          pr.merged_at === null ||
          (typeof pr.merged_at === 'string' && Number.isFinite(Date.parse(pr.merged_at)))
        ) ||
        (pr.state === 'open' && pr.merged_at !== null)
      )
        throw new Error('taskmaster_fire_pr_listing_invalid_row');
      const identity = JSON.stringify([pr.title, pr.body, pr.state, pr.merged_at]);
      const number = pr.number as number;
      if (identities.has(number) && identities.get(number) !== identity)
        throw new Error('taskmaster_fire_pr_listing_conflicting_duplicate');
      identities.set(number, identity);
      if (
        exactWo.test(`${pr.title}\n${pr.body ?? ''}`) &&
        (pr.state === 'open' || pr.merged_at !== null)
      )
        satisfying = true;
    }
    if (rows.length < 100) {
      complete = true;
      break;
    }
  }
  if (!complete) throw new Error('taskmaster_fire_pr_listing_incomplete');
  if (satisfying) return { eligible: false, reason: 'pr_exists' };

  return {
    eligible: true,
    evidence: {
      woId,
      targetRepo,
      project,
      specVerifiedAt: (deps.now ?? ((): Date => new Date()))().toISOString(),
      noOpenOrMergedPr: true,
      specSource: 'repo-path',
      expectedSpec,
    },
  };
}
