/**
 * already-satisfied.test.ts -- exact WO claim matching + findWoClaim.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import * as alreadySatisfied from '../already-satisfied.js';
import {
  findWoClaim,
  ghPrSearchDefault,
  listOpenWoPullRequests,
  resolveGithubRepo,
  textClaimsWoId,
  type WoClaim,
} from '../already-satisfied.js';

describe('textClaimsWoId', () => {
  test('matches exact WO token in title', () => {
    expect(
      textClaimsWoId(
        'feat: WO-SHOPOPS-GARY-SUPPORT-VISIBILITY-01',
        'WO-SHOPOPS-GARY-SUPPORT-VISIBILITY-01'
      )
    ).toBe(true);
  });

  test('rejects sibling ids that share a prefix (#1490 class)', () => {
    // Longer id that continues with a digit/letter must not match the shorter WO.
    expect(textClaimsWoId('WO-HARNESS-FOO-010 done', 'WO-HARNESS-FOO-01')).toBe(false);
    expect(textClaimsWoId('WO-HARNESS-FOO-01A', 'WO-HARNESS-FOO-01')).toBe(false);
  });

  test('matches branch names containing the WO (case-insensitive)', () => {
    expect(
      textClaimsWoId(
        'feat/wo-shopops-gary-support-visibility-01-thread-abc',
        'WO-SHOPOPS-GARY-SUPPORT-VISIBILITY-01'
      )
    ).toBe(true);
    expect(
      textClaimsWoId(
        'feat/WO-SHOPOPS-GARY-SUPPORT-VISIBILITY-01-thread-abc',
        'WO-SHOPOPS-GARY-SUPPORT-VISIBILITY-01'
      )
    ).toBe(true);
  });

  test('ignores a WO id listed under an "explicitly out of scope" heading (#1795)', () => {
    // Real text from shopops-comic-theme PR #62's body.
    const body = [
      '## Files explicitly out of scope',
      '- `sections/product.liquid` (PDP -- committed-intent, spec says out of scope)',
      '- `comic-card.liquid` body/actions block (owned by WO-COMICTHEME-CARD-MODERN-PARITY-01)',
      '- Locale/translation files -- none needed',
      '',
      '## Verification commands',
      'grep -c foo bar.liquid',
    ].join('\n');
    expect(textClaimsWoId(body, 'WO-COMICTHEME-CARD-MODERN-PARITY-01')).toBe(false);
  });

  test('still matches the same WO id when it appears OUTSIDE an exclusion section', () => {
    const body = [
      '## Summary',
      'Implements WO-COMICTHEME-CARD-MODERN-PARITY-01.',
      '',
      '## Files explicitly out of scope',
      '- none',
    ].join('\n');
    expect(textClaimsWoId(body, 'WO-COMICTHEME-CARD-MODERN-PARITY-01')).toBe(true);
  });

  test('exclusion applies only until the next heading, not to the rest of the doc', () => {
    const body = [
      '## Files explicitly out of scope',
      '- unrelated line',
      '',
      '## Files modified',
      '- WO-COMICTHEME-CARD-MODERN-PARITY-01 actually implemented here',
    ].join('\n');
    expect(textClaimsWoId(body, 'WO-COMICTHEME-CARD-MODERN-PARITY-01')).toBe(true);
  });

  test('recognizes "not in scope" and "explicitly excluded" heading variants', () => {
    expect(textClaimsWoId('## Not in scope\n- WO-FOO-BAR-01 (deferred)', 'WO-FOO-BAR-01')).toBe(
      false
    );
    expect(textClaimsWoId('### Explicitly Excluded\n- WO-FOO-BAR-01', 'WO-FOO-BAR-01')).toBe(false);
  });
});

describe('resolveGithubRepo', () => {
  test('prefixes bare shortnames with thinmansoftware', () => {
    expect(resolveGithubRepo('shopops')).toBe('thinmansoftware/shopops');
  });

  test('preserves owner/repo', () => {
    expect(resolveGithubRepo('thinmansoftware/lspro-react')).toBe('thinmansoftware/lspro-react');
  });
});

describe('findWoClaim', () => {
  test('prefers MERGED over OPEN', async () => {
    const claim = await findWoClaim({
      woId: 'WO-TEST-CLAIM-01',
      project: 'shopops',
      lookup: async () =>
        [
          {
            number: 1,
            state: 'OPEN',
            title: 'WO-TEST-CLAIM-01 open',
            url: 'https://example/1',
            repo: 'thinmansoftware/shopops',
          },
          {
            number: 2,
            state: 'MERGED',
            title: 'WO-TEST-CLAIM-01 merged',
            url: 'https://example/2',
            repo: 'thinmansoftware/shopops',
          },
        ] satisfies WoClaim[],
    });
    expect(claim?.number).toBe(2);
    expect(claim?.state).toBe('MERGED');
  });

  test('returns null when no exact claim', async () => {
    const claim = await findWoClaim({
      woId: 'WO-TEST-CLAIM-01',
      project: 'shopops',
      lookup: async () => [],
    });
    expect(claim).toBeNull();
  });
});

describe('findWoClaim spec-only PRs', () => {
  const woId = 'WO-TEST-CLAIM-01';
  const repo = 'thinmansoftware/bdc-xo';
  const specPath = 'docs/work-orders/WO-TEST-CLAIM-01.md';
  const specClaim: WoClaim = {
    number: 1,
    state: 'MERGED',
    title: 'WO: WO-TEST-CLAIM-01',
    url: 'https://example/1',
    repo,
  };
  const realClaim: WoClaim = {
    ...specClaim,
    number: 2,
    state: 'OPEN',
    title: 'Implement WO-TEST-CLAIM-01',
    url: 'https://example/2',
  };
  let originalHermetic: string | undefined;

  beforeEach(() => {
    originalHermetic = process.env.SMART_CAULDRON_HERMETIC;
    delete process.env.SMART_CAULDRON_HERMETIC;
  });

  afterEach(() => {
    if (originalHermetic === undefined) delete process.env.SMART_CAULDRON_HERMETIC;
    else process.env.SMART_CAULDRON_HERMETIC = originalHermetic;
  });

  function findWithFiles(stdout: string) {
    return findWoClaim({
      woId,
      project: repo,
      lookup: async () => [specClaim],
      execFn: async (file: string, args: readonly string[]) => {
        expect(file).toBe('gh');
        expect(args).toContain('api');
        expect(args).toContain(`repos/${repo}/pulls/1/files?per_page=100`);
        expect(args).toContain('--paginate');
        expect(args).toContain('--slurp');
        return { stdout, stderr: '' };
      },
    });
  }

  test('ignores the only claim when it changes only this WO spec', async () => {
    expect(await findWithFiles(JSON.stringify([[{ filename: specPath }]]))).toBeNull();
  });

  test('ignores a rename between this WO spec paths', async () => {
    expect(
      await findWithFiles(
        JSON.stringify([
          [
            {
              filename: specPath,
              previous_filename: 'docs/superpowers/specs/WO-TEST-CLAIM-01.md',
            },
          ],
        ])
      )
    ).toBeNull();
  });

  test('keeps a claim touching a product file', async () => {
    expect(
      await findWithFiles(
        JSON.stringify([[{ filename: specPath }, { filename: 'src/feature.ts' }]])
      )
    ).toEqual(specClaim);
  });

  test('keeps a claim when a later file page touches a product file', async () => {
    expect(
      await findWithFiles(
        JSON.stringify([[{ filename: specPath }], [{ filename: 'src/feature.ts' }]])
      )
    ).toEqual(specClaim);
  });

  test('keeps a claim for a different WO spec with a shared prefix', async () => {
    expect(
      await findWithFiles(JSON.stringify([[{ filename: 'docs/work-orders/WO-TEST-CLAIM-010.md' }]]))
    ).toEqual(specClaim);
  });

  test('keeps a rename into this WO spec from a product file', async () => {
    expect(
      await findWithFiles(
        JSON.stringify([[{ filename: specPath, previous_filename: 'src/feature.ts' }]])
      )
    ).toEqual(specClaim);
  });

  test('keeps the claim when the file read throws', async () => {
    expect(
      await findWoClaim({
        woId,
        project: repo,
        lookup: async () => [specClaim],
        execFn: async () => {
          throw new Error('file list unavailable');
        },
      })
    ).toEqual(specClaim);
  });

  test.each([
    ['invalid JSON', '{'],
    ['empty output', ''],
    ['non-array output', '{}'],
    ['missing pages', '[]'],
    ['empty file list', '[[]]'],
    ['non-array page', '[{}]'],
    ['malformed row', '[[null]]'],
    ['missing filename', '[[{}]]'],
    ['malformed rename', JSON.stringify([[{ filename: specPath, previous_filename: null }]])],
    ['malformed later page', JSON.stringify([[{ filename: specPath }], {}])],
  ])('keeps the claim on %s', async (_name, stdout) => {
    expect(await findWithFiles(stdout)).toEqual(specClaim);
  });

  test('returns an open real PR instead of a merged spec-only PR', async () => {
    expect(
      await findWoClaim({
        woId,
        project: repo,
        lookup: async () => [specClaim, realClaim],
        execFn: async (_file: string, args: readonly string[]) => ({
          stdout: JSON.stringify([
            [
              {
                filename: args.some(arg => arg.includes('/pulls/1/')) ? specPath : 'src/feature.ts',
              },
            ],
          ]),
          stderr: '',
        }),
      })
    ).toEqual(realClaim);
  });

  test('keeps MERGED preference among real claims', async () => {
    expect(
      await findWoClaim({
        woId,
        project: repo,
        lookup: async () => [realClaim, specClaim],
        execFn: async () => ({
          stdout: JSON.stringify([[{ filename: 'src/feature.ts' }]]),
          stderr: '',
        }),
      })
    ).toEqual(specClaim);
  });

  test('filters the real search results using the injected file read', async () => {
    // The row's only claim signal is its manifest `WO:` line (a title is not a
    // claim, WO-HARNESS-SATISFIED-GUARD-CLAIM-SIGNALS-ONLY-01 RC7), so the
    // spec-only filter is what drops it.
    const calls = { prList: 0, files: 0 };
    const row = {
      ...specClaim,
      headRefName: 'docs/spec-landing',
      body: 'WO: WO-TEST-CLAIM-01',
    };
    const execFnFor = (filename: string) => async (_file: string, args: readonly string[]) => {
      if (args[0] === 'pr') calls.prList++;
      else calls.files++;
      return {
        stdout: JSON.stringify(args[0] === 'pr' ? [row] : [[{ filename }]]),
        stderr: '',
      };
    };
    const specOnly = execFnFor(specPath);
    expect(
      await findWoClaim({
        woId,
        project: repo,
        lookup: (target, id) => ghPrSearchDefault(target, id, specOnly),
        execFn: specOnly,
      })
    ).toBeNull();
    expect(calls.prList).toBe(1);
    expect(calls.files).toBe(1);
    // Control: the same row touching a product file is a claim, so the null
    // above comes from the spec-only filter and not from the classifier.
    const product = execFnFor('src/feature.ts');
    expect(
      (
        await findWoClaim({
          woId,
          project: repo,
          lookup: (target, id) => ghPrSearchDefault(target, id, product),
          execFn: product,
        })
      )?.number
    ).toBe(1);
  });

  test('does not spawn a file read in hermetic mode even with an injected claim', async () => {
    process.env.SMART_CAULDRON_HERMETIC = '1';
    let calls = 0;
    expect(
      await findWoClaim({
        woId,
        project: repo,
        lookup: async () => [specClaim],
        execFn: async () => {
          calls++;
          return { stdout: JSON.stringify([[{ filename: specPath }]]), stderr: '' };
        },
      })
    ).toEqual(specClaim);
    expect(calls).toBe(0);
  });
});

describe('open WO repair selection', () => {
  test('excludes drafts from repair targets and SHA evidence', async () => {
    const row = {
      number: 1,
      body: 'WO: WO-FOO-01',
      head: {
        ref: 'fix/wo-foo-01',
        sha: 'a'.repeat(40),
        repo: { full_name: 'thinmansoftware/bdc-harness' },
      },
    };
    const prs = await listOpenWoPullRequests({
      woId: 'WO-FOO-01',
      project: 'bdc-harness',
      lookup: async () => [
        { ...row, draft: true },
        { ...row, number: 2, draft: false },
      ],
    });
    expect(prs.map(pr => pr.number)).toEqual([2]);
  });

  test('overlapping_wo_ids_do_not_match', async () => {
    const rows = [
      ['wo-foo-010', 'wo-foo-010-thread-abc'],
      ['wo-foo-01', 'wo-foo-01-thread-def'],
      ['WO-OTHER-01', 'WO-FOO-01'],
      ['WO-FOO-01A', 'wo-foo-01a'],
      ['OTHER', 'prefixwo-foo-01'],
      ['WO-FOO-01-EXTRA', 'wo-foo-01-extra'],
      ['WO-FOO-01-EXTRA', 'wo-foo-01-extra-thread-abc'],
      ['WO-FOO-01-02', 'wo-foo-01-02-thread-abc'],
    ].map(([id, branch], index) => ({
      number: index + 1,
      body: `WO: ${id}`,
      head: { ref: `fix/${branch}`, repo: { full_name: 'thinmansoftware/bdc-harness' } },
    }));
    const prs = await listOpenWoPullRequests({
      woId: 'WO-FOO-01',
      project: 'bdc-harness',
      lookup: async () => rows,
    });
    expect(prs.map(pr => pr.number)).toEqual([2, 3]);
    // Exercise branch matching independently of a matching body declaration:
    // fix/wo-foo-01-thread-def and fix/WO-FOO-01 match; wo-foo-010 never does.
    const branchOnly = await listOpenWoPullRequests({
      woId: 'wo-foo-01',
      project: 'bdc-harness',
      lookup: async () => rows.map(row => ({ ...row, body: 'WO: WO-OTHER-01' })),
    });
    expect(branchOnly.map(pr => pr.number)).toEqual([2, 3]);
    expect(textClaimsWoId('fix/wo-foo-010-thread-abc', 'WO-FOO-01')).toBe(false);
    expect(textClaimsWoId('fix/wo-foo-01-thread-def', 'WO-FOO-01')).toBe(true);
    expect(textClaimsWoId('WO: WO-FOO-01-02', 'WO-FOO-01')).toBe(false);
  });
});

/**
 * WO-HARNESS-SATISFIED-GUARD-CLAIM-SIGNALS-ONLY-01 (bdc-harness#1436, bdc-xo#6506).
 * A pull request claims a WO only by (a) a manifest `WO:` line, (b) a closing
 * keyword for the WO's own bdc-xo issue, or (c) the lane's or hand-build branch.
 * Every test goes through ghPrSearchDefault with a fake gh (hermetic mode off)
 * and asserts the fake `gh pr list` ran, so none can pass vacuously.
 */
describe('claim signals only (bdc-harness#1436)', () => {
  const fixture = (name: string): string =>
    readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');
  const PR254_BODY = fixture('satisfied-pr254-reconcile-skip.md');
  const PR77_BODY = fixture('satisfied-pr77-prose-mention.md');
  // lspro-react PR 895 body line 31: its only mention of the non-card WO (bdc-xo#6516).
  const PR895_LINE31 =
    'Do not change `ReceiptSummary.tsx`, tier packaging, non-card persistence or its failed-POST behavior, APIs, hardware integrations, credentials, Auth0, flags or deployment settings, pre-review gates, allowlists, or waivers. Do not make production requests, push to main, merge, or deploy. The non-card persistence gap is tracked separately as `WO-LSPRO-POS-NONCARD-SAVE-FAIL-CLOSED-01` / bdc-xo#6516.';

  interface Row {
    number: number;
    state: 'OPEN' | 'MERGED';
    title: string;
    headRefName: string;
    body: string;
  }

  interface Signals {
    woIssueNumber?: number;
    headBranches?: readonly string[];
  }

  let originalHermetic: string | undefined;
  beforeEach(() => {
    originalHermetic = process.env.SMART_CAULDRON_HERMETIC;
    delete process.env.SMART_CAULDRON_HERMETIC;
  });
  afterEach(() => {
    if (originalHermetic === undefined) delete process.env.SMART_CAULDRON_HERMETIC;
    else process.env.SMART_CAULDRON_HERMETIC = originalHermetic;
  });

  async function claimFor(
    woId: string,
    project: string,
    rows: readonly Row[],
    signals: Signals = {}
  ): Promise<number | null> {
    let prListCalls = 0;
    const execFn = async (_file: string, args: readonly string[]) => {
      if (args[0] === 'pr' && args[1] === 'list') {
        prListCalls++;
        // Honour the search the way GitHub does: `--search <term>` matches a PR's
        // title or body, never its head branch (Overseer App review on PR 1630).
        const term = args[args.indexOf('--search') + 1];
        expect(term).toBe(woId);
        const needle = (term ?? '').toLowerCase();
        const found = rows.filter(
          r => r.title.toLowerCase().includes(needle) || r.body.toLowerCase().includes(needle)
        );
        return {
          stdout: JSON.stringify(found.map(r => ({ ...r, url: `https://example/${r.number}` }))),
          stderr: '',
        };
      }
      // pulls/<n>/files: a product file, so the spec-only filter keeps every claim.
      return { stdout: JSON.stringify([[{ filename: 'src/feature.ts' }]]), stderr: '' };
    };
    const search = ghPrSearchDefault as (...args: unknown[]) => Promise<WoClaim[]>;
    const claim = await findWoClaim({
      woId,
      project,
      ...signals,
      lookup: (target: string, id: string, s?: unknown) => search(target, id, execFn, s),
      execFn,
    } as Parameters<typeof findWoClaim>[0]);
    expect(prListCalls).toBeGreaterThanOrEqual(1);
    return claim?.number ?? null;
  }

  const pr254: Row = {
    number: 254,
    state: 'MERGED',
    title:
      'Reconcile: merge production master into staging (M-09 promotion prerequisite, no content change)',
    headRefName: 'reconcile/master-into-staging-20261124',
    body: PR254_BODY,
  };
  // OPEN as it was at the 2026-11-03 refusal (it is CLOSED today).
  const pr77: Row = {
    number: 77,
    state: 'OPEN',
    title: 'BDC feature Work Order implementation',
    headRefName: 'feat/wo-csos-provisioner-gate2-lapsed-hold-release-01-thread-797d800e',
    body: PR77_BODY,
  };
  const pr895: Row = {
    number: 895,
    state: 'MERGED',
    title: 'BDC feature Work Order implementation',
    headRefName: 'feat/wo-lspro-pos-hardware-fail-closed-01-thread-d9fb1a80',
    body: PR895_LINE31,
  };

  test('Test 1: a Reconcile-Skip line is never a claim (shopops-storefront PR 254)', async () => {
    expect(PR254_BODY).toContain('Reconcile-Skip: WO-STOREFRONT-HOSTED-CART-API-CHECKOUT-01');
    for (const id of [
      'WO-STOREFRONT-HOSTED-CART-API-CHECKOUT-01',
      'WO-STOREFRONT-FACTORY-SHOP-OWN-BRAND-01',
      'WO-STOREFRONT-PROMO-TICKER-REMOVE-01',
    ]) {
      expect(await claimFor(id, 'shopops-storefront', [pr254])).toBeNull();
    }
  });

  test('Test 2: a bare prose mention is never a claim (PR 77, PR 895)', async () => {
    const reaper = 'WO-CSOS-LEDGER-RESERVATION-REAPER-01';
    expect(PR77_BODY).toContain(reaper);
    expect(await claimFor(reaper, 'comicstoreos-provisioner', [pr77])).toBeNull();
    expect(
      await claimFor(reaper, 'comicstoreos-provisioner', [pr77], { woIssueNumber: 4357 })
    ).toBeNull();
    expect(
      await claimFor('WO-LSPRO-POS-NONCARD-SAVE-FAIL-CLOSED-01', 'lspro-react', [pr895])
    ).toBeNull();
    // PR 77 still claims its own WO (its lane branch and its WO: line).
    expect(
      await claimFor(
        'WO-CSOS-PROVISIONER-GATE2-LAPSED-HOLD-RELEASE-01',
        'comicstoreos-provisioner',
        [pr77]
      )
    ).toBe(77);
  });

  test('Test 3: an id in the title alone is not a claim', async () => {
    const id = 'WO-TEST-TITLE-01';
    const base = { state: 'OPEN' as const, headRefName: 'chore/unrelated', body: 'No claim here.' };
    expect(
      await claimFor(id, 'shopops', [{ ...base, number: 1, title: `Implement ${id}` }])
    ).toBeNull();
    expect(
      await claimFor(id, 'shopops', [{ ...base, number: 2, title: `${id}: tidy the thing` }])
    ).toBeNull();
  });

  test('Test 4: a WO line, and a closing keyword for the WO issue, each claim', async () => {
    const id = 'WO-TEST-CLOSE-01';
    const row = (number: number, body: string): Row => ({
      number,
      state: 'OPEN',
      title: `Follow-up to ${id}`,
      headRefName: 'chore/unrelated',
      body,
    });
    expect(await claimFor(id, 'shopops', [row(1, `WO: ${id}`)])).toBe(1);
    expect(
      await claimFor(id, 'shopops', [row(2, 'Closes thinmansoftware/bdc-xo#4321')], {
        woIssueNumber: 4321,
      })
    ).toBe(2);
    expect(
      await claimFor(
        id,
        'shopops',
        [row(3, 'Fixes: https://github.com/thinmansoftware/bdc-xo/issues/4321')],
        { woIssueNumber: 4321 }
      )
    ).toBe(3);
    // Other keywords, and owner/repo in any case.
    expect(
      await claimFor(id, 'shopops', [row(10, 'resolved THINMANSOFTWARE/BDC-XO#4321')], {
        woIssueNumber: 4321,
      })
    ).toBe(10);
    expect(
      await claimFor(id, 'shopops', [row(11, 'close thinmansoftware/bdc-xo#4321.')], {
        woIssueNumber: 4321,
      })
    ).toBe(11);
    // Negatives.
    expect(
      await claimFor(id, 'shopops', [row(4, 'Closes thinmansoftware/bdc-xo#4321')])
    ).toBeNull();
    expect(
      await claimFor(id, 'shopops', [row(5, 'Closes thinmansoftware/bdc-xo#4321')], {
        woIssueNumber: 9999,
      })
    ).toBeNull();
    expect(
      await claimFor(id, 'shopops', [row(6, 'Closes #4321')], { woIssueNumber: 4321 })
    ).toBeNull();
    expect(
      await claimFor(id, 'shopops', [row(7, 'Closes thinmansoftware/bdc-xo#43210')], {
        woIssueNumber: 4321,
      })
    ).toBeNull();
    expect(
      await claimFor(id, 'shopops', [row(8, 'Refs thinmansoftware/bdc-xo#4321')], {
        woIssueNumber: 4321,
      })
    ).toBeNull();
  });

  test('Test 5: the lane branch and the hand-build branch claim', async () => {
    const id = 'WO-TEST-BRANCH-01';
    const row = (number: number, headRefName: string): Row => ({
      number,
      state: 'OPEN',
      title: `Follow-up to ${id}`,
      headRefName,
      body: '',
    });
    expect(
      await claimFor(id, 'bdc-harness', [row(1, 'feat/wo-test-branch-01-thread-2eb65e7b')])
    ).toBe(1);
    expect(
      await claimFor(id, 'bdc-harness', [row(2, 'chore/anything')], {
        headBranches: ['chore/anything'],
      })
    ).toBe(2);
    expect(await claimFor(id, 'bdc-harness', [row(3, 'wo/test-branch-01')])).toBe(3);
    expect(await claimFor(id, 'bdc-harness', [row(4, 'wo/test-branch-01-thread-abc')])).toBe(4);
    expect(await claimFor(id, 'bdc-harness', [row(5, 'FEAT/WO-TEST-BRANCH-01-thread-x')])).toBe(5);
    // Negatives: longer sibling ids, and an unrecorded branch named for nothing.
    expect(await claimFor(id, 'bdc-harness', [row(6, 'feat/wo-test-branch-010')])).toBeNull();
    expect(await claimFor(id, 'bdc-harness', [row(7, 'wo/test-branch-010')])).toBeNull();
    expect(await claimFor(id, 'bdc-harness', [row(8, 'wo/test-branch-01-02')])).toBeNull();
    expect(await claimFor(id, 'bdc-harness', [row(9, 'chore/anything')])).toBeNull();
  });

  test('known search limit: a PR whose id is in neither title nor body is never seen', async () => {
    // The gh search matches title and body only, and the spec leaves the query
    // unchanged (Scope OUT). A lane-branch-only PR is therefore not returned, so
    // the guard proceeds. This pins today's behavior; widening the fetch is a
    // separate work order (Overseer App review on PR 1630, bdc-xo#6506).
    const id = 'WO-TEST-SEARCH-01';
    expect(
      await claimFor(id, 'bdc-harness', [
        {
          number: 1,
          state: 'OPEN',
          title: 'BDC feature Work Order implementation',
          headRefName: 'feat/wo-test-search-01-thread-abc',
          body: 'No id here.',
        },
      ])
    ).toBeNull();
  });

  test('Test 7: prClaimsWo, findWoClaim and listOpenWoPullRequests agree', async () => {
    const prClaimsWo = (alreadySatisfied as Record<string, unknown>).prClaimsWo as
      | ((pr: { headRefName: string; body: string }, woId: string, signals?: Signals) => boolean)
      | undefined;
    expect(typeof prClaimsWo).toBe('function');
    if (!prClaimsWo) return;
    const id = 'WO-TEST-AGREE-01';
    const cases: { headRefName: string; body: string }[] = [
      { headRefName: 'wo/test-agree-01', body: '' },
      { headRefName: 'feat/wo-test-agree-01-thread-abc', body: '' },
      { headRefName: 'chore/x', body: `WO: ${id}` },
      { headRefName: 'chore/x', body: `Implements ${id} in prose only.` },
      { headRefName: 'chore/x', body: `Reconcile-Skip: ${id}` },
      { headRefName: 'wo/test-agree-010', body: '' },
    ];
    const repo = 'thinmansoftware/bdc-harness';
    for (const [index, c] of cases.entries()) {
      const number = index + 1;
      const viaClassifier = prClaimsWo(c, id, {});
      const viaFind =
        (await claimFor(id, 'bdc-harness', [
          {
            number,
            state: 'OPEN',
            title: `Follow-up to ${id}`,
            headRefName: c.headRefName,
            body: c.body,
          },
        ])) === number;
      const open = await listOpenWoPullRequests({
        woId: id,
        project: 'bdc-harness',
        lookup: async () => [
          {
            number,
            body: c.body,
            draft: false,
            head: { ref: c.headRefName, repo: { full_name: repo } },
          },
        ],
      });
      const viaOpen = open.some(pr => pr.number === number);
      expect([c.headRefName, c.body, viaFind, viaOpen]).toEqual([
        c.headRefName,
        c.body,
        viaClassifier,
        viaClassifier,
      ]);
    }
    // The hand-build branch is a claim through all three readers (the stated change, RC2).
    expect(prClaimsWo(cases[0]!, id, {})).toBe(true);
  });
});
