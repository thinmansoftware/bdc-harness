/**
 * already-satisfied.test.ts -- exact WO claim matching + findWoClaim.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
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
    const execFn = async (_file: string, args: readonly string[]) => ({
      stdout: JSON.stringify(args[0] === 'pr' ? [specClaim] : [[{ filename: specPath }]]),
      stderr: '',
    });
    expect(
      await findWoClaim({
        woId,
        project: repo,
        lookup: (target, id) => ghPrSearchDefault(target, id, execFn),
        execFn,
      })
    ).toBeNull();
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
