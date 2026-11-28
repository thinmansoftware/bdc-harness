import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_MERGE_REPO_POLICY,
  getRepoBasePolicy,
  hasRepoPolicyEntry,
  parseMergeRepoPolicy,
  resolveMergeRepoPolicy,
  unattendedBasesForRepo,
} from '../merge-repo-policy.ts';

// The policy is passed explicitly so MERGE_MANAGER_REPO_POLICY in the environment cannot change the result.
const policy = DEFAULT_MERGE_REPO_POLICY;

describe('default merge repo policy -- staging lineages', () => {
  test('lspro-react staging and shopops-storefront staging are unattended candidates', () => {
    expect(getRepoBasePolicy('thinmansoftware/lspro-react', 'staging', policy)).toEqual({
      unattended: true,
      docsOnly: 'skip',
    });
    expect(getRepoBasePolicy('thinmansoftware/shopops-storefront', 'staging', policy)).toEqual({
      unattended: true,
      docsOnly: 'skip',
    });
  });

  test('receiving-shipping-desk permits unattended code and docs merges only on staging', () => {
    const desk = 'thinmansoftware/receiving-shipping-desk';
    expect(getRepoBasePolicy(desk, 'staging', policy)).toEqual({
      unattended: true,
      docsOnly: 'merge',
    });
    expect(getRepoBasePolicy(desk, 'main', policy)).toBeUndefined();
    expect(unattendedBasesForRepo(desk, policy)).toEqual(['staging']);
  });

  test('lspro-react keeps dev unattended and shopops-storefront is a known repo', () => {
    expect(getRepoBasePolicy('thinmansoftware/lspro-react', 'dev', policy)?.unattended).toBe(true);
    expect(hasRepoPolicyEntry('thinmansoftware/shopops-storefront', policy)).toBe(true);
    expect([...unattendedBasesForRepo('thinmansoftware/shopops-storefront', policy)]).toEqual([
      'staging',
    ]);
    expect([...unattendedBasesForRepo('thinmansoftware/lspro-react', policy)].sort()).toEqual([
      'dev',
      'staging',
    ]);
  });
});

describe('default merge repo policy -- production bases stay closed', () => {
  test('main and master are never unattended', () => {
    expect(getRepoBasePolicy('thinmansoftware/lspro-react', 'main', policy)).toEqual({
      unattended: false,
      docsOnly: 'skip',
    });
    expect(getRepoBasePolicy('thinmansoftware/shopops-storefront', 'master', policy)).toEqual({
      unattended: false,
      docsOnly: 'skip',
    });
  });

  test('bdc-shopify-app main is a known production base and is never unattended (Tests 1, 2)', () => {
    expect(getRepoBasePolicy('thinmansoftware/bdc-shopify-app', 'main', policy)).toEqual({
      unattended: false,
      docsOnly: 'skip',
    });
    expect(hasRepoPolicyEntry('thinmansoftware/bdc-shopify-app', policy)).toBe(true);
    expect([...unattendedBasesForRepo('thinmansoftware/bdc-shopify-app', policy)]).toEqual([]);
  });

  test('release/lspro is absent and release/ce is explicitly production', () => {
    expect(
      getRepoBasePolicy('thinmansoftware/lspro-react', 'release/lspro', policy)
    ).toBeUndefined();
    expect(getRepoBasePolicy('thinmansoftware/lspro-react', 'release/ce', policy)).toEqual({
      unattended: false,
      docsOnly: 'skip',
    });
  });

  test('no release/* base is unattended on either repo', () => {
    for (const repo of ['thinmansoftware/lspro-react', 'thinmansoftware/shopops-storefront']) {
      for (const base of unattendedBasesForRepo(repo, policy)) {
        expect(base.startsWith('release/')).toBe(false);
        expect(base).not.toBe('main');
        expect(base).not.toBe('master');
      }
    }
  });
});

// WO-HARNESS-MERGE-POLICY-PROVISIONER-AND-REPO-SKIP-LINE-01 (bdc-xo#5581)
describe('provisioner main and the additive environment value', () => {
  const PROV = 'thinmansoftware/comicstoreos-provisioner';
  const quiet = { warn: (): void => undefined };

  test('1: the default policy lists the provisioner main as unattended, nothing else for it', () => {
    expect(getRepoBasePolicy(PROV, 'main', policy)).toEqual({ unattended: true, docsOnly: 'skip' });
    expect(getRepoBasePolicy(PROV, 'staging', policy)).toBeUndefined();
    expect(getRepoBasePolicy(PROV, 'release/x', policy)).toBeUndefined();
    // every other repository keeps exactly the entries it had
    expect(Object.keys(policy).sort()).toEqual(
      [
        'thinmansoftware/bdc-harness',
        'thinmansoftware/bdc-shopify-app',
        'thinmansoftware/bdc-xo',
        'thinmansoftware/comicstoreos-provisioner',
        'thinmansoftware/lspro-react',
        'thinmansoftware/receiving-shipping-desk',
        'thinmansoftware/shopops',
        'thinmansoftware/shopops-storefront',
      ].sort()
    );
  });

  test('7a: an environment value that omits the provisioner still lists it (additive)', () => {
    const live =
      '{"thinmansoftware/bdc-harness":{"dev":{"unattended":true,"docs_only":"skip"}},"thinmansoftware/bdc-ci":{"main":{"unattended":true,"docs_only":"merge"}}}';
    const resolved = resolveMergeRepoPolicy({ rawPolicy: live });
    expect(getRepoBasePolicy(PROV, 'main', resolved)?.unattended).toBe(true);
    // the value wins for the repositories it names (bdc-harness has only dev here) and adds bdc-ci
    expect(getRepoBasePolicy('thinmansoftware/bdc-harness', 'dev', resolved)?.unattended).toBe(
      true
    );
    expect(getRepoBasePolicy('thinmansoftware/bdc-harness', 'staging', resolved)).toBeUndefined();
    expect(hasRepoPolicyEntry('thinmansoftware/bdc-ci', resolved)).toBe(true);
  });

  test('7b: an empty object for a default repository lists it with nothing allowed; others unchanged', () => {
    const resolved = resolveMergeRepoPolicy({ rawPolicy: '{"thinmansoftware/shopops":{}}' });
    expect(hasRepoPolicyEntry('thinmansoftware/shopops', resolved)).toBe(true);
    expect([...unattendedBasesForRepo('thinmansoftware/shopops', resolved)]).toEqual([]);
    expect(getRepoBasePolicy('thinmansoftware/shopops', 'staging', resolved)).toBeUndefined();
    expect(getRepoBasePolicy(PROV, 'main', resolved)?.unattended).toBe(true);
    expect(getRepoBasePolicy('thinmansoftware/bdc-xo', 'main', resolved)).toEqual(
      DEFAULT_MERGE_REPO_POLICY['thinmansoftware/bdc-xo']?.main
    );
  });

  test('7c: a malformed environment value is still the EMPTY policy (fails closed)', () => {
    expect(resolveMergeRepoPolicy({ rawPolicy: 'not json' })).toEqual({});
    expect(resolveMergeRepoPolicy({ rawPolicy: '{"thinmansoftware/bdc-xo":{"main":nope' })).toEqual(
      {}
    );
    expect(quiet.warn).toBeDefined();
  });

  test('without the environment value the default policy is used unchanged', () => {
    const saved = process.env.MERGE_MANAGER_REPO_POLICY;
    delete process.env.MERGE_MANAGER_REPO_POLICY;
    try {
      expect(resolveMergeRepoPolicy({})).toEqual(DEFAULT_MERGE_REPO_POLICY);
    } finally {
      if (saved !== undefined) process.env.MERGE_MANAGER_REPO_POLICY = saved;
    }
  });
});

// SAFETY CHECK for making MERGE_MANAGER_REPO_POLICY additive (acting XO, 2026-11-12, bdc-harness #1579).
// Before this change the live environment value REPLACED the default. After it, any repository that is in
// the in-code default but NOT in the live value gains merge-manager eligibility at the next rebuild with no
// decision by John. LIVE_ENV_2026_11_12 is the value of MERGE_MANAGER_REPO_POLICY read inside archon-app-1 on
// 2026-11-12 (repositories and bases only; it holds no secret). This test fails when the default gains
// anything the live value does not already carry, so that difference is reviewed on purpose.
const LIVE_ENV_2026_11_12 =
  '{"thinmansoftware/bdc-harness":{"dev":{"unattended":true,"docs_only":"skip"},"staging":{"unattended":true,"docs_only":"skip"},"main":{"unattended":false,"docs_only":"skip"}},"thinmansoftware/shopops":{"staging":{"unattended":true,"docs_only":"skip"},"master":{"unattended":false,"docs_only":"skip"}},"thinmansoftware/lspro-react":{"dev":{"unattended":true,"docs_only":"skip"},"staging":{"unattended":true,"docs_only":"skip"},"main":{"unattended":false,"docs_only":"skip"},"lspro/comics-integration":{"unattended":true,"docs_only":"skip"}},"thinmansoftware/shopops-storefront":{"staging":{"unattended":true,"docs_only":"skip"},"master":{"unattended":false,"docs_only":"skip"}},"thinmansoftware/bdc-xo":{"main":{"unattended":true,"docs_only":"merge"}},"thinmansoftware/bdc-ci":{"main":{"unattended":false,"docs_only":"skip"}},"thinmansoftware/bdc-shopify-app":{"main":{"unattended":false,"docs_only":"skip"}}}';

describe('additive environment policy admits only the intended additional bases', () => {
  const PROV = 'thinmansoftware/comicstoreos-provisioner';
  const DESK = 'thinmansoftware/receiving-shipping-desk';
  const liveValue = JSON.parse(LIVE_ENV_2026_11_12) as Record<string, Record<string, unknown>>;
  const effective = resolveMergeRepoPolicy({ rawPolicy: LIVE_ENV_2026_11_12 });

  test('the default adds only provisioner main and desk staging to the historical environment', () => {
    const missing = Object.keys(DEFAULT_MERGE_REPO_POLICY)
      .filter(repo => !Object.hasOwn(liveValue, repo))
      .sort();
    expect(missing).toEqual([PROV, DESK]);
    expect(Object.keys(DEFAULT_MERGE_REPO_POLICY[PROV] ?? {})).toEqual(['main']);
    expect(DEFAULT_MERGE_REPO_POLICY[PROV]?.main).toEqual({ unattended: true, docsOnly: 'skip' });
  });

  test('the effective policy preserves every repository in the historical environment', () => {
    const asLive = JSON.parse(JSON.stringify(effective)) as Record<string, unknown>;
    delete asLive[PROV];
    delete asLive[DESK];
    // Re-express the live value in the parsed shape (docs_only -> docsOnly) and compare repo by repo.
    for (const [repo, bases] of Object.entries(liveValue)) {
      const expected = Object.fromEntries(
        Object.entries(bases).map(([base, rule]) => {
          const r = rule as { unattended: boolean; docs_only: string };
          return [base, { unattended: r.unattended, docsOnly: r.docs_only }];
        })
      );
      expect(asLive[repo]).toEqual(expected);
    }
    expect(Object.keys(asLive).sort()).toEqual(Object.keys(liveValue).sort());
  });

  test('no production base becomes an unattended candidate through the additive merge', () => {
    const production: [string, string][] = [
      ['thinmansoftware/shopops', 'master'],
      ['thinmansoftware/shopops-storefront', 'master'],
      ['thinmansoftware/lspro-react', 'main'],
      ['thinmansoftware/lspro-react', 'release/ce'],
      ['thinmansoftware/bdc-harness', 'main'],
      ['thinmansoftware/bdc-shopify-app', 'main'],
    ];
    for (const [repo, base] of production)
      expect(getRepoBasePolicy(repo, base, effective)?.unattended ?? false).toBe(false);
    // Only provisioner main and desk staging gain unattended coverage.
    const unattended = (policyToCheck: typeof effective): string[] =>
      Object.entries(policyToCheck)
        .flatMap(([repo, bases]) =>
          Object.entries(bases)
            .filter(([, rule]) => rule.unattended)
            .map(([base]) => `${repo}:${base}`)
        )
        .sort();
    const live = unattended(parseMergeRepoPolicy(LIVE_ENV_2026_11_12));
    expect(unattended(effective).filter(entry => !live.includes(entry))).toEqual([
      `${PROV}:main`,
      `${DESK}:staging`,
    ]);
  });
});
