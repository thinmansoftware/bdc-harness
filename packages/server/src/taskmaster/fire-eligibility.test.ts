import { describe, expect, test } from 'bun:test';
import { checkFireEligibility } from './fire-eligibility';
const TITLE = 'P1: WO-HARNESS-EXAMPLE-01 needs building';
const SPEC = 'cauldron_compatible: true\ntarget_repo: thinmansoftware/bdc-harness\n';
const SHA = 'a'.repeat(40);
function response(body: unknown, status = 200, remaining = '100'): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'x-ratelimit-remaining': remaining },
  });
}
const TOKEN = 'ghp-test-token';
function deps(spec = SPEC, prs: unknown[] = []) {
  return {
    now: () => new Date('2026-08-24T10:00:00.000Z'),
    githubToken: TOKEN,
    codebases: async () => [
      { name: 'bdc-harness', repository_url: 'https://github.com/thinmansoftware/bdc-harness.git' },
    ],
    fetchImpl: (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/git/ref/')) return response({ object: { sha: SHA } });
      if (url.includes('/contents/'))
        return response({
          type: 'file',
          encoding: 'base64',
          content: Buffer.from(spec).toString('base64'),
        });
      return response(
        prs.map((pr, index) => ({
          number: index + 1,
          body: null,
          merged_at: null,
          ...(pr as object),
        }))
      );
    }) as typeof fetch,
  };
}
describe('checkFireEligibility', () => {
  test('uses current canonical precedence and carries immutable identity', async () => {
    const result = await checkFireEligibility(TITLE, deps());
    expect(result.eligible).toBe(true);
    expect(result.evidence?.expectedSpec?.specSource).toBe(
      'github:thinmansoftware/bdc-xo:docs/work-orders/WO-HARNESS-EXAMPLE-01.md'
    );
    expect(result.evidence?.expectedSpec?.specRevision).toBe(SHA);
    expect(result.evidence?.expectedSpec?.specHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
  test('falls back to the exact secondary committed path', async () => {
    const configured = deps();
    const original = configured.fetchImpl;
    configured.fetchImpl = async (url, init) =>
      String(url).includes('/contents/docs/work-orders/') ? response({}, 404) : original(url, init);
    const result = await checkFireEligibility(TITLE, configured);
    expect(result.eligible).toBe(true);
    expect(result.evidence?.specSource).toBe('repo-path');
    expect(result.evidence?.expectedSpec?.specSource).toEndWith(
      'docs/superpowers/specs/WO-HARNESS-EXAMPLE-01.md'
    );
  });
  test('issue-author fields cannot grant execution authority, including harness208 replay', async () => {
    const seen: string[] = [];
    const configured = deps();
    configured.fetchImpl = async input => {
      const url = String(input);
      seen.push(url);
      if (url.includes('/git/ref/')) return response({ object: { sha: SHA } });
      if (url.includes('/contents/')) return response({}, 404);
      return response({ items: [{ number: 208, title: TITLE }], body: SPEC });
    };
    for (const title of [TITLE, 'WO-SOCIAL-WIRE-ALL-META-PAGES-01']) {
      expect(await checkFireEligibility(title, configured)).toEqual({
        eligible: false,
        reason: 'spec_missing',
      });
    }
    expect(seen.some(url => url.includes('/search/') || url.includes('/issues/'))).toBe(false);
  });
  test('rejects missing revision', async () => {
    const configured = deps();
    configured.fetchImpl = async () => response({}, 404);
    expect(await checkFireEligibility(TITLE, configured)).toEqual({
      eligible: false,
      reason: 'spec_missing',
    });
  });
  test('preserves compatibility, target, registration and exact PR guards', async () => {
    expect((await checkFireEligibility(TITLE, deps('cauldron_compatible: false'))).reason).toBe(
      'cauldron_incompatible'
    );
    expect((await checkFireEligibility(TITLE, deps('cauldron_compatible: true'))).reason).toBe(
      'target_repo_missing'
    );
    const configured = deps();
    configured.codebases = async () => [];
    expect((await checkFireEligibility(TITLE, configured)).reason).toBe('project_not_registered');
    expect(
      (
        await checkFireEligibility(
          TITLE,
          deps(SPEC, [{ title: 'WO-HARNESS-EXAMPLE-01', state: 'open' }])
        )
      ).reason
    ).toBe('pr_exists');
    expect(
      (
        await checkFireEligibility(
          TITLE,
          deps(SPEC, [{ title: 'WO-HARNESS-EXAMPLE-010', state: 'open' }])
        )
      ).eligible
    ).toBe(true);
  });
  test('backs off at the shared GitHub rate-limit floor', async () => {
    const configured = deps();
    configured.fetchImpl = async () => response({}, 200, '4');
    await expect(checkFireEligibility(TITLE, configured)).rejects.toThrow('rate_limit_backoff');
  });
  test('authenticates the canonical ref and content reads, not just the PR search', async () => {
    const seen: { url: string; authorization: string | null }[] = [];
    const configured = deps();
    const original = configured.fetchImpl;
    configured.fetchImpl = async (url, init) => {
      seen.push({
        url: String(url),
        authorization: new Headers(init?.headers ?? {}).get('authorization'),
      });
      return original(url, init);
    };
    const result = await checkFireEligibility(TITLE, configured);
    expect(result.eligible).toBe(true);
    const canonical = seen.filter(
      call => call.url.includes('/git/ref/') || call.url.includes('/contents/')
    );
    expect(canonical.length).toBeGreaterThan(0);
    // The finding: canonical reads previously went out anonymous, breaking
    // private-repo access and dropping to the 60/hr unauthenticated limit.
    for (const call of canonical) expect(call.authorization).toBe(`Bearer ${TOKEN}`);
    expect(seen.every(call => call.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });
  test('fails closed when no GitHub token is resolvable instead of reading anonymously', async () => {
    const priorGithub = process.env.GITHUB_TOKEN;
    const priorGh = process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    try {
      const seen: string[] = [];
      const configured = deps();
      const original = configured.fetchImpl;
      configured.githubToken = undefined;
      configured.fetchImpl = async (url, init) => {
        seen.push(String(url));
        return original(url, init);
      };
      expect(await checkFireEligibility(TITLE, configured)).toEqual({
        eligible: false,
        reason: 'github_auth_missing',
      });
      expect(seen).toEqual([]);
    } finally {
      if (priorGithub === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = priorGithub;
      if (priorGh === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = priorGh;
    }
  });
  test('keeps spec-on-main policy: issue fields never grant when the spec is absent', async () => {
    const seen: string[] = [];
    const configured = deps();
    configured.fetchImpl = async input => {
      const url = String(input);
      seen.push(url);
      if (url.includes('/git/ref/')) return response({ object: { sha: SHA } });
      if (url.includes('/contents/')) return response({}, 404);
      return response({ items: [{ number: 208, title: TITLE, body: SPEC }] });
    };
    expect(await checkFireEligibility(TITLE, configured)).toEqual({
      eligible: false,
      reason: 'spec_missing',
    });
    expect(seen.some(url => url.includes('/issues/'))).toBe(false);
  });
});

describe('fire eligibility complete REST PR custody', () => {
  function pr(number: number, override: Record<string, unknown> = {}) {
    return {
      number,
      title: 'unrelated',
      body: null,
      state: 'closed',
      merged_at: null,
      ...override,
    };
  }
  function fixture(pages: unknown[]) {
    const configured = deps();
    const original = configured.fetchImpl;
    const seen: string[] = [];
    configured.fetchImpl = async (input, init) => {
      const url = String(input);
      seen.push(url);
      if (url.includes('/search/')) return response({ message: 'Search quota exhausted' }, 403);
      if (url.includes('/pulls?')) {
        const page = Number(new URL(url).searchParams.get('page'));
        const data = page <= pages.length ? pages[page - 1] : [];
        if (data instanceof Error) throw data;
        if (data instanceof Response) return data;
        return response(data);
      }
      return original(input, init);
    };
    return { configured, seen };
  }
  test.each(['open', 'merged'])(
    'later-page %s exact body claim refuses eligibility without Search',
    async mode => {
      const full = Array.from({ length: 100 }, (_, i) => pr(i + 1));
      const f = fixture([
        full,
        [
          pr(101, {
            body: 'WO-HARNESS-EXAMPLE-01',
            state: mode === 'open' ? 'open' : 'closed',
            merged_at: mode === 'merged' ? '2026-10-18T00:00:00Z' : null,
          }),
        ],
      ]);
      expect((await checkFireEligibility(TITLE, f.configured)).reason).toBe('pr_exists');
      expect(f.seen.some(url => url.includes('/search/'))).toBe(false);
      expect(f.seen.filter(url => url.includes('/pulls?'))).toHaveLength(2);
    }
  );
  test('closed unmerged and numeric/hyphen sibling claims do not grant ownership', async () => {
    const f = fixture([
      [
        pr(1, { title: 'WO-HARNESS-EXAMPLE-01' }),
        pr(2, { title: 'WO-HARNESS-EXAMPLE-010', state: 'open' }),
        pr(3, { title: 'WO-HARNESS-EXAMPLE-01-OTHER', state: 'open' }),
      ],
    ]);
    expect((await checkFireEligibility(TITLE, f.configured)).eligible).toBe(true);
    expect(f.seen.some(url => url.includes('/search/'))).toBe(false);
  });
  test.each([
    'null',
    'object',
    'number',
    'title',
    'body',
    'state',
    'merged',
    'late-error',
    'HTTP403',
    'JSON',
  ])('%s discovery cannot produce noOpenOrMergedPr authority', async mode => {
    const row = pr(1);
    const pages: unknown[] =
      mode === 'null'
        ? [null]
        : mode === 'object'
          ? [{}]
          : mode === 'late-error'
            ? [
                Array.from({ length: 100 }, (_, i) => pr(i + 1)),
                new Error('late discovery failure'),
              ]
            : mode === 'HTTP403'
              ? [response({}, 403)]
              : mode === 'JSON'
                ? [new Response('invalid-json')]
                : [
                    [
                      {
                        ...row,
                        [mode === 'merged' ? 'merged_at' : mode]:
                          mode === 'merged' ? 'invalid' : undefined,
                      },
                    ],
                  ];
    const f = fixture(pages);
    await expect(checkFireEligibility(TITLE, f.configured)).rejects.toThrow();
    expect(f.seen.some(url => url.includes('/search/'))).toBe(false);
  });
  test('identical duplicate rows preserve complete absence proof', async () => {
    const f = fixture([[pr(1), pr(1)]]);
    expect((await checkFireEligibility(TITLE, f.configured)).eligible).toBe(true);
  });
  test('open-and-merged contradiction remains unknown', async () => {
    const f = fixture([[pr(1, { state: 'open', merged_at: '2026-10-18T00:00:00Z' })]]);
    await expect(checkFireEligibility(TITLE, f.configured)).rejects.toThrow('invalid_row');
  });
  test('early matching claim does not hide a later malformed page', async () => {
    const full = Array.from({ length: 100 }, (_, i) => pr(i + 1));
    full[0] = pr(1, { title: 'WO-HARNESS-EXAMPLE-01', state: 'open' });
    const f = fixture([full, {}]);
    await expect(checkFireEligibility(TITLE, f.configured)).rejects.toThrow('invalid_page');
  });
  test('conflicting duplicate identity remains unknown', async () => {
    const f = fixture([[pr(1), pr(1, { state: 'open' })]]);
    await expect(checkFireEligibility(TITLE, f.configured)).rejects.toThrow();
  });
  test('complete history beyond1000 can prove absence', async () => {
    const pages = Array.from({ length: 11 }, (_, page) =>
      Array.from({ length: 100 }, (_, i) => pr(page * 100 + i + 1))
    );
    const f = fixture([...pages, []]);
    const result = await checkFireEligibility(TITLE, f.configured);
    expect(result.eligible).toBe(true);
    expect(result.evidence?.noOpenOrMergedPr).toBe(true);
    expect(f.seen.filter(url => url.includes('/pulls?'))).toHaveLength(12);
  });
  test('full bounded history remains unknown at the cap', async () => {
    const pages = Array.from({ length: 100 }, (_, page) =>
      Array.from({ length: 100 }, (_, i) => pr(page * 100 + i + 1))
    );
    const f = fixture(pages);
    await expect(checkFireEligibility(TITLE, f.configured)).rejects.toThrow('listing_incomplete');
  });
});

test('default service path meters paginated core reads while Search is exhausted', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { closeDatabase, resetDatabase, getDatabase } = await import('@archon/core/db/connection');
  const { removeTempDirWithRetry } = await import('@archon/core/test/temp-dir');
  const { recordGitHubApiCall, flushGitHubApiMeter, resetGitHubApiMeterForTests } =
    await import('@archon/core/github/metering');
  const keys = [
    'ARCHON_HOME',
    'DATABASE_URL',
    'GH_TOKEN',
    'GITHUB_TOKEN',
    ...Object.keys(process.env).filter(key => key.startsWith('GITHUB_APP_')),
  ];
  const prior = new Map(keys.map(key => [key, process.env[key]]));
  const home = mkdtempSync(join(tmpdir(), 'taskmaster-fire-rest-'));
  await closeDatabase();
  resetDatabase();
  resetGitHubApiMeterForTests();
  try {
    for (const key of keys) delete process.env[key];
    process.env.ARCHON_HOME = home;
    process.env.GITHUB_TOKEN = TOKEN;
    recordGitHubApiCall({
      service: 'taskmaster',
      poolId: 'user-pat',
      resource: 'search',
      status: 403,
      rateLimited: true,
      remaining: 0,
      reset: Math.floor(Date.now() / 1000) + 300,
    });
    await flushGitHubApiMeter();
    const configured = deps();
    const original = configured.fetchImpl;
    const pages: string[] = [];
    const result = await checkFireEligibility(TITLE, {
      ...configured,
      githubToken: undefined,
      fetchImpl: async (input, init) => {
        const url = String(input);
        expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
        if (url.includes('/pulls?')) {
          pages.push(url);
          return response(
            pages.length === 1
              ? Array.from({ length: 100 }, (_, i) => ({
                  number: i + 1,
                  title: 'unrelated',
                  body: null,
                  state: 'closed',
                  merged_at: null,
                }))
              : []
          );
        }
        if (url.includes('/search/')) throw new Error('Search must not run');
        return original(input, init);
      },
    });
    expect(result.eligible).toBe(true);
    expect(pages).toHaveLength(2);
    await flushGitHubApiMeter();
    const usage = await getDatabase().query<{ resource: string; calls: number }>(
      "SELECT resource,calls FROM github_api_usage WHERE service='taskmaster' ORDER BY resource"
    );
    expect(usage.rows).toEqual([
      { resource: 'core', calls: 2 },
      { resource: 'search', calls: 1 },
    ]);
  } finally {
    await closeDatabase();
    resetDatabase();
    resetGitHubApiMeterForTests();
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    removeTempDirWithRetry(home);
  }
});
