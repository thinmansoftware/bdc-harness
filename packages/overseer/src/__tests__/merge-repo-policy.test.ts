import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_MERGE_REPO_POLICY,
  getRepoBasePolicy,
  hasRepoPolicyEntry,
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
