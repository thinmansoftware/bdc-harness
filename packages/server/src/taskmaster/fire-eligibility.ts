import { listCodebases } from '@archon/core/db/codebases';

export interface FireEligibilityEvidence {
  woId: string;
  targetRepo: string;
  project: string;
  specVerifiedAt: string;
  noOpenOrMergedPr: true;
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
}

const WO_ID_RE = /\b(WO-[A-Z][A-Z0-9-]*-\d+)\b/;

function headers(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  return {
    accept: 'application/vnd.github+json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

function assertRateLimit(response: Response): void {
  const remaining = Number.parseInt(response.headers.get('x-ratelimit-remaining') ?? '', 10);
  if (Number.isInteger(remaining) && remaining < 5) {
    throw new Error(`taskmaster_github_rate_limit_backoff:${remaining}`);
  }
}

function normalizeRepo(value: string): string {
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
  const specResponse = await fetchImpl(
    `https://api.github.com/repos/thinmansoftware/bdc-xo/contents/docs/work-orders/${woId}.md?ref=main`,
    { headers: headers() }
  );
  assertRateLimit(specResponse);
  if (specResponse.status === 404) return { eligible: false, reason: 'spec_missing' };
  if (!specResponse.ok) throw new Error(`taskmaster_fire_spec_read_failed:${specResponse.status}`);
  const payload = (await specResponse.json()) as { content?: string; encoding?: string };
  const body =
    payload.encoding === 'base64' && payload.content
      ? Buffer.from(payload.content.replace(/\s/g, ''), 'base64').toString('utf8')
      : '';
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

  // Mirrors fire.ps1's `gh pr list --state all --search <WO>` gate, while
  // enforcing a WO token boundary to avoid generic-title substring matches.
  const searchResponse = await fetchImpl(
    `https://api.github.com/search/issues?q=${encodeURIComponent(`${woId} repo:${targetRepo} is:pr`)}`,
    { headers: headers() }
  );
  assertRateLimit(searchResponse);
  if (!searchResponse.ok)
    throw new Error(`taskmaster_fire_pr_search_failed:${searchResponse.status}`);
  const search = (await searchResponse.json()) as {
    items?: {
      title?: string;
      body?: string | null;
      state?: string;
      pull_request?: { merged_at?: string };
    }[];
  };
  const escaped = woId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const exactWo = new RegExp(`(?:^|[^A-Za-z0-9-])${escaped}(?:[^A-Za-z0-9-]|$)`);
  const satisfying = (search.items ?? []).some(
    pr =>
      exactWo.test(`${pr.title ?? ''}\n${pr.body ?? ''}`) &&
      (pr.state?.toLowerCase() === 'open' || Boolean(pr.pull_request?.merged_at))
  );
  if (satisfying) return { eligible: false, reason: 'pr_exists' };

  return {
    eligible: true,
    evidence: {
      woId,
      targetRepo,
      project,
      specVerifiedAt: (deps.now ?? ((): Date => new Date()))().toISOString(),
      noOpenOrMergedPr: true,
    },
  };
}
