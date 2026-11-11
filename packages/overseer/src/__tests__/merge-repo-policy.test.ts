import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_MERGE_REPO_POLICY,
  getRepoBasePolicy,
  hasRepoPolicyEntry,
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
