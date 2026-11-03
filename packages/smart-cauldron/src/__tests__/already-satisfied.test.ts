/**
 * already-satisfied.test.ts -- exact WO claim matching + findWoClaim.
 */

import { describe, expect, test } from 'bun:test';
import {
  findWoClaim,
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

  test('rejects ambiguous thread suffixes even in branch names', () => {
    expect(
      textClaimsWoId(
        'feat/wo-shopops-gary-support-visibility-01-thread-abc',
        'WO-SHOPOPS-GARY-SUPPORT-VISIBILITY-01'
      )
    ).toBe(false);
    expect(
      textClaimsWoId(
        'feat/WO-SHOPOPS-GARY-SUPPORT-VISIBILITY-01-thread-abc',
        'WO-SHOPOPS-GARY-SUPPORT-VISIBILITY-01'
      )
    ).toBe(false);
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
      ['WO-FOO-01-THREAD-ABC', 'wo-foo-01-thread-abc'],
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
    // Exercise branch matching independently of a matching body declaration.
    const branchOnly = await listOpenWoPullRequests({
      woId: 'wo-foo-01',
      project: 'bdc-harness',
      lookup: async () => rows.map(row => ({ ...row, body: 'WO: WO-OTHER-01' })),
    });
    expect(branchOnly.map(pr => pr.number)).toEqual([3]);
  });
});
