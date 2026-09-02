/**
 * already-satisfied-evidence.test.ts -- the conductor satisfied-guard must only
 * treat a PR as satisfaction when the PR CLAIMS the WO (title prefix, manifest
 * `WO:` line, or head branch named after the id). A bare mention is not
 * satisfaction, and `Reconcile-Skip: <id>` excludes the PR for that id.
 *
 * Anchor (2026-09-02 13:54Z): the conductor logged
 *   "[smart-cauldron] ALREADY SATISFIED woId=WO-LSPRO-M157-STREAM-STAYS-OPEN-UI-01:
 *    PR #568 [MERGED] ... -- skipping cascade"
 * and wrote a cascade record with status won / attempts 0, because lspro-react
 * #568 (the merged phone-gate pre-step) mentioned the WO id. The WO had not
 * been built. Fixtures are the real PR bodies captured that day.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { findWoClaim, selectWoClaims, type GhPrRow } from '../already-satisfied.js';

const UI_WO = 'WO-LSPRO-M157-STREAM-STAYS-OPEN-UI-01';
const SHOPOPS_WO = 'WO-SHOPOPS-M157-STREAM-STAYS-OPEN-01';

interface PrFixture {
  number: number;
  title: string;
  url: string;
  body: string;
}

/** Shared incident fixtures live with the overseer reconcile tests (one copy). */
function loadFixture(name: string): PrFixture {
  const url = new URL(
    `../../../overseer/src/__tests__/fixtures/reconcile-skip/${name}.json`,
    import.meta.url
  );
  return JSON.parse(readFileSync(url, 'utf8')) as PrFixture;
}

function mergedRow(fixture: PrFixture, headRefName = 'staging-fix'): GhPrRow {
  return {
    number: fixture.number,
    state: 'MERGED',
    title: fixture.title,
    url: fixture.url,
    headRefName,
    body: fixture.body,
  };
}

const lsproReact568 = loadFixture('lspro-react-568');
const lsproReact570 = loadFixture('lspro-react-570');
const bdcXo1898 = loadFixture('bdc-xo-1898');
const shopops662 = loadFixture('shopops-662');

describe('selectWoClaims -- the incident PRs', () => {
  test('lspro-react #568 (merged pre-step, Reconcile-Skip) does NOT satisfy the UI WO', () => {
    expect(
      selectWoClaims([mergedRow(lsproReact568)], UI_WO, 'thinmansoftware/lspro-react')
    ).toEqual([]);
  });

  test('lspro-react #570 and bdc-xo #1898 (Reconcile-Skip) do NOT satisfy the UI WO', () => {
    expect(
      selectWoClaims(
        [mergedRow(lsproReact570), mergedRow(bdcXo1898)],
        UI_WO,
        'thinmansoftware/lspro-react'
      )
    ).toEqual([]);
  });

  test('shopops #662 (bare mention in a finding reply) does NOT satisfy the UI WO', () => {
    expect(selectWoClaims([mergedRow(shopops662)], UI_WO, 'thinmansoftware/shopops')).toEqual([]);
  });

  test('shopops #662 DOES satisfy its own WO (title prefix + manifest WO: line)', () => {
    const claims = selectWoClaims([mergedRow(shopops662)], SHOPOPS_WO, 'thinmansoftware/shopops');
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      number: 662,
      state: 'MERGED',
      repo: 'thinmansoftware/shopops',
    });
  });

  test('findWoClaim returns null for the UI WO across all four incident PRs', async () => {
    const rows = [
      mergedRow(lsproReact568),
      mergedRow(lsproReact570),
      mergedRow(bdcXo1898),
      mergedRow(shopops662),
    ];
    const claim = await findWoClaim({
      woId: UI_WO,
      project: 'lspro-react',
      lookup: async repo => selectWoClaims(rows, UI_WO, repo),
    });
    expect(claim).toBeNull();
  });
});

describe('selectWoClaims -- what still counts as a claim', () => {
  const repo = 'thinmansoftware/lspro-react';

  test('a Cauldron PR: generic title, manifest WO: line', () => {
    const row: GhPrRow = {
      number: 750,
      state: 'MERGED',
      title: 'BDC feature Work Order implementation',
      url: 'https://github.com/thinmansoftware/lspro-react/pull/750',
      headRefName: 'staging-x',
      body: '```\nWO: WO-A-01\nBuilder: Smart Cauldron\nVALIDATION: PASS\n```',
    };
    expect(selectWoClaims([row], 'WO-A-01', repo)).toHaveLength(1);
  });

  test('an OPEN Cauldron PR on a feat/wo-<id>-thread-<hash> branch (the #1546 dual-lane case)', () => {
    const row: GhPrRow = {
      number: 12,
      state: 'OPEN',
      title: 'BDC feature Work Order implementation',
      url: 'https://github.com/thinmansoftware/lspro-react/pull/12',
      headRefName: 'feat/wo-a-01-thread-9c8ee675',
      body: 'still building',
    };
    expect(selectWoClaims([row], 'WO-A-01', repo)).toHaveLength(1);
  });

  test('a PR whose title starts with the id', () => {
    const row: GhPrRow = {
      number: 13,
      state: 'OPEN',
      title: 'WO-A-01: implement the thing',
      url: 'https://github.com/thinmansoftware/lspro-react/pull/13',
      headRefName: 'fix/thing',
      body: '',
    };
    expect(selectWoClaims([row], 'WO-A-01', repo)).toHaveLength(1);
  });

  test('a bare mention in an OPEN PR is not a claim (mention != satisfaction)', () => {
    const row: GhPrRow = {
      number: 14,
      state: 'OPEN',
      title: 'fix: pre-step',
      url: 'https://github.com/thinmansoftware/lspro-react/pull/14',
      headRefName: 'fix/prestep',
      body: 'WO-A-01 builds on top of this.',
    };
    expect(selectWoClaims([row], 'WO-A-01', repo)).toEqual([]);
  });

  test('Reconcile-Skip is per id: excluded for WO-A-01, still a claim for WO-B-02', () => {
    const row: GhPrRow = {
      number: 15,
      state: 'MERGED',
      title: 'BDC feature Work Order implementation',
      url: 'https://github.com/thinmansoftware/lspro-react/pull/15',
      headRefName: 'staging-y',
      body: 'Reconcile-Skip: WO-A-01\n\n```\nWO: WO-B-02\n```',
    };
    expect(selectWoClaims([row], 'WO-A-01', repo)).toEqual([]);
    expect(selectWoClaims([row], 'WO-B-02', repo)).toHaveLength(1);
  });

  test('CLOSED (unmerged) rows are ignored regardless of evidence', () => {
    const row: GhPrRow = {
      number: 16,
      state: 'CLOSED',
      title: 'WO-A-01: abandoned',
      url: 'https://github.com/thinmansoftware/lspro-react/pull/16',
      headRefName: 'wo/WO-A-01',
      body: 'WO: WO-A-01',
    };
    expect(selectWoClaims([row], 'WO-A-01', repo)).toEqual([]);
  });
});
