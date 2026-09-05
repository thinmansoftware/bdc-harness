/**
 * wo-evidence.test.ts -- the shared "is this PR evidence for WO X" classifier,
 * exercised against the REAL PR bodies from the 2026-09-02 incident
 * (WO-LSPRO-M157-STREAM-STAYS-OPEN-UI-01 = bdc-xo #1889).
 *
 * Fixtures (gh pr view --json number,title,body,files ... captured 2026-09-02):
 *   bdc-xo #1898       the WO's own spec amendment, Reconcile-Skip, spec-only
 *   lspro-react #570   a different fix (B5/B8/B9), Reconcile-Skip, manifest WO: line
 *   lspro-react #568   the phone-gate pre-step, Reconcile-Skip, manifest WO: line
 *   shopops #662       the WO this one depends on; names the UI id in a finding
 *                      reply and carries NO Reconcile-Skip line
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import {
  branchClaimsWoId,
  classifyWoEvidence,
  extractReconcileSkipStems,
  isReconcileSkipped,
  manifestClaimsWoId,
  mentionsWoId,
  prClaimsWoId,
  titleClaimsWoId,
} from '../wo-evidence';

export const UI_WO = 'WO-LSPRO-M157-STREAM-STAYS-OPEN-UI-01';
export const SHOPOPS_WO = 'WO-SHOPOPS-M157-STREAM-STAYS-OPEN-01';

export interface PrFixture {
  number: number;
  title: string;
  url: string;
  mergedAt: string;
  baseRefName: string;
  files: string[];
  body: string;
}

export function loadPrFixture(name: string): PrFixture {
  const url = new URL(`./fixtures/reconcile-skip/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as PrFixture;
}

export const bdcXo1898 = loadPrFixture('bdc-xo-1898');
export const lsproReact570 = loadPrFixture('lspro-react-570');
export const lsproReact568 = loadPrFixture('lspro-react-568');
export const shopops662 = loadPrFixture('shopops-662');

/** The same body with every Reconcile-Skip line removed -- what it would say without the marker. */
function withoutSkipLines(body: string): string {
  return body
    .split('\n')
    .filter(line => !/^\s*reconcile-skip\s*:/i.test(line))
    .join('\n');
}

describe('extractReconcileSkipStems', () => {
  test('reads the marker from the three incident PRs that carry it', () => {
    expect(extractReconcileSkipStems(bdcXo1898.body)).toEqual(new Set([UI_WO]));
    expect(extractReconcileSkipStems(lsproReact570.body)).toEqual(new Set([UI_WO]));
    expect(extractReconcileSkipStems(lsproReact568.body)).toEqual(new Set([UI_WO]));
  });

  test('shopops #662 carries no marker (it named the UI WO in a finding reply only)', () => {
    expect(extractReconcileSkipStems(shopops662.body)).toEqual(new Set());
    expect(mentionsWoId(shopops662.body, UI_WO)).toBe(true);
  });

  test('label is case-insensitive and tolerates spaces around the colon', () => {
    expect(extractReconcileSkipStems('reconcile-skip: WO-A-01')).toEqual(new Set(['WO-A-01']));
    expect(extractReconcileSkipStems('RECONCILE-SKIP : WO-A-01')).toEqual(new Set(['WO-A-01']));
    expect(extractReconcileSkipStems('  Reconcile-Skip:WO-A-01  ')).toEqual(new Set(['WO-A-01']));
  });

  test('accepts a comma-separated list and upper-cases the ids', () => {
    expect(extractReconcileSkipStems('Reconcile-Skip: WO-A-01, wo-b-02,WO-C-03')).toEqual(
      new Set(['WO-A-01', 'WO-B-02', 'WO-C-03'])
    );
  });

  test('collects ids across multiple marker lines', () => {
    expect(
      extractReconcileSkipStems('Reconcile-Skip: WO-A-01\ntext\nReconcile-Skip: WO-B-02')
    ).toEqual(new Set(['WO-A-01', 'WO-B-02']));
  });

  test('prose that talks about the marker mid-line is not a marker', () => {
    expect(extractReconcileSkipStems('add a Reconcile-Skip: WO-A-01 line to the body')).toEqual(
      new Set()
    );
  });

  test('empty / null body yields an empty set', () => {
    expect(extractReconcileSkipStems('')).toEqual(new Set());
    expect(extractReconcileSkipStems(null)).toEqual(new Set());
    expect(extractReconcileSkipStems(undefined)).toEqual(new Set());
  });

  test('isReconcileSkipped is per-id: the PR still counts for ids it does not list', () => {
    const body = 'Reconcile-Skip: WO-A-01\n\nWO: WO-B-02';
    expect(isReconcileSkipped(body, 'WO-A-01')).toBe(true);
    expect(isReconcileSkipped(body, 'wo-a-01')).toBe(true);
    expect(isReconcileSkipped(body, 'WO-B-02')).toBe(false);
  });
});

describe('titleClaimsWoId', () => {
  test('a title that starts with the id claims it', () => {
    expect(titleClaimsWoId(shopops662.title, SHOPOPS_WO)).toBe(true);
    expect(titleClaimsWoId('  WO-A-01 -- do the thing', 'WO-A-01')).toBe(true);
    expect(titleClaimsWoId('wo-a-01: lower-cased', 'WO-A-01')).toBe(true);
  });

  test('a title that mentions the id later does NOT claim it', () => {
    expect(titleClaimsWoId('fix: WO-A-01 follow-up', 'WO-A-01')).toBe(false);
    expect(titleClaimsWoId('docs(m157): #1889 spec amendment', UI_WO)).toBe(false);
  });

  test('a sibling id sharing the prefix does not claim (WO-A-01 vs WO-A-010 / WO-A-01A)', () => {
    expect(titleClaimsWoId('WO-A-010 done', 'WO-A-01')).toBe(false);
    expect(titleClaimsWoId('WO-A-01A done', 'WO-A-01')).toBe(false);
  });
});

describe('manifestClaimsWoId', () => {
  test('the manifest v2 label line claims the WO (fenced or not)', () => {
    expect(manifestClaimsWoId(shopops662.body, SHOPOPS_WO)).toBe(true);
    expect(manifestClaimsWoId('```\nWO: WO-A-01\nBuilder: x\n```', 'WO-A-01')).toBe(true);
    expect(manifestClaimsWoId('WO: WO-A-01', 'WO-A-01')).toBe(true);
    expect(manifestClaimsWoId('wo: wo-a-01', 'WO-A-01')).toBe(true);
  });

  test('a WO: line naming a different id does not claim this one', () => {
    expect(manifestClaimsWoId(shopops662.body, UI_WO)).toBe(false);
  });

  test('the id inside prose on a WO: line with trailing text is not a manifest line', () => {
    expect(manifestClaimsWoId('WO: WO-A-01 (partial, see below)', 'WO-A-01')).toBe(false);
    expect(manifestClaimsWoId('the WO: WO-A-01 needs work', 'WO-A-01')).toBe(false);
  });
});

describe('branchClaimsWoId', () => {
  test('a Cauldron feat/wo-<id>-thread-<hash> branch claims the WO', () => {
    expect(
      branchClaimsWoId(
        'feat/wo-harness-dispatch-reply-text-persist-01-thread-9c8ee675',
        'WO-HARNESS-DISPATCH-REPLY-TEXT-PERSIST-01'
      )
    ).toBe(true);
    expect(branchClaimsWoId('wo/WO-A-01', 'WO-A-01')).toBe(true);
  });

  test('a branch that only contains the id later in the segment does not claim', () => {
    expect(branchClaimsWoId('feat/prestep-for-wo-a-01', 'WO-A-01')).toBe(false);
    expect(branchClaimsWoId('staging', 'WO-A-01')).toBe(false);
    expect(branchClaimsWoId(null, 'WO-A-01')).toBe(false);
  });
});

describe('classifyWoEvidence -- the incident, PR by PR', () => {
  test('bdc-xo #1898 (spec amendment) is EXCLUDED for the UI WO by its marker', () => {
    expect(classifyWoEvidence(bdcXo1898, UI_WO)).toBe('excluded');
  });

  test('lspro-react #570 (different fix) is EXCLUDED for the UI WO by its marker', () => {
    expect(classifyWoEvidence(lsproReact570, UI_WO)).toBe('excluded');
  });

  test('lspro-react #568 (phone-gate pre-step) is EXCLUDED for the UI WO by its marker', () => {
    expect(classifyWoEvidence(lsproReact568, UI_WO)).toBe('excluded');
  });

  test('shopops #662 (dependency) is a bare MENTION of the UI WO -- not evidence', () => {
    expect(classifyWoEvidence(shopops662, UI_WO)).toBe('mention');
    expect(prClaimsWoId(shopops662, UI_WO)).toBe(false);
  });

  test('shopops #662 CLAIMS its own WO (title prefix and manifest WO: line)', () => {
    expect(classifyWoEvidence(shopops662, SHOPOPS_WO)).toBe('claim');
    expect(prClaimsWoId(shopops662, SHOPOPS_WO)).toBe(true);
  });

  test('the marker wins over a manifest WO: line for the same id (#568, #570)', () => {
    // Both PRs carry `WO: <UI_WO>` in their manifest block AND Reconcile-Skip
    // for the same id. The marker is the author saying "not this one".
    expect(manifestClaimsWoId(lsproReact568.body, UI_WO)).toBe(true);
    expect(manifestClaimsWoId(lsproReact570.body, UI_WO)).toBe(true);
    expect(classifyWoEvidence(lsproReact568, UI_WO)).toBe('excluded');
    expect(classifyWoEvidence(lsproReact570, UI_WO)).toBe('excluded');
  });

  test('without their markers, #568 and #570 would be claims (manifest line) and #1898 a mention', () => {
    expect(
      classifyWoEvidence(
        { title: lsproReact568.title, body: withoutSkipLines(lsproReact568.body) },
        UI_WO
      )
    ).toBe('claim');
    expect(
      classifyWoEvidence(
        { title: lsproReact570.title, body: withoutSkipLines(lsproReact570.body) },
        UI_WO
      )
    ).toBe('claim');
    expect(
      classifyWoEvidence({ title: bdcXo1898.title, body: withoutSkipLines(bdcXo1898.body) }, UI_WO)
    ).toBe('mention');
  });

  test('a PR that never names the id is none', () => {
    expect(classifyWoEvidence({ title: 'chore: bump deps', body: 'nothing here' }, UI_WO)).toBe(
      'none'
    );
  });

  test('the marker is per-id: a PR excluded for one WO still claims another it names', () => {
    const body = 'Reconcile-Skip: WO-A-01\n\n```\nWO: WO-B-02\nVALIDATION: PASS\n```';
    expect(
      classifyWoEvidence({ title: 'BDC feature Work Order implementation', body }, 'WO-A-01')
    ).toBe('excluded');
    expect(
      classifyWoEvidence({ title: 'BDC feature Work Order implementation', body }, 'WO-B-02')
    ).toBe('claim');
  });
});
