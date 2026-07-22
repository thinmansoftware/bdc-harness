import { describe, expect, mock, test } from 'bun:test';
import * as overseerDb from '@archon/core/db/overseer';
import {
  createDefaultReconcileDeps,
  RECONCILE_ACTION,
  RECONCILE_SKIP_ACTION,
  runReconcileOnce,
} from '../reconcile';
import { fakeDeps, mergedPr, stem } from './reconcile.test';

const hasReconcileActionForPrCalls: unknown[] = [];
const hasReconcileActionForPr = mock(async (input: unknown) => {
  hasReconcileActionForPrCalls.push(input);
  return true;
});

mock.module('@archon/core/db/overseer', () => ({
  ...overseerDb,
  hasReconcileActionForPr,
  insertReconcileAction: mock(async () => undefined),
}));

describe('reconcile partial completion skip marker', () => {
  test('Reconcile-Skip marker suppresses close while posting evidence and recording skip action', async () => {
    const deps = fakeDeps({
      prs: [
        mergedPr({
          body: `Implements ${stem}.

Reconcile-Skip: ${stem}`,
        }),
      ],
    });

    const result = await runReconcileOnce({ deps });

    expect(result).toEqual({ scanned: 1, closed: 0, skipped: false });
    expect(deps.comments).toHaveLength(1);
    expect(deps.comments[0]).toContain('intentionally left open');
    expect(deps.comments[0]).toContain(`Reconcile-Skip: ${stem}`);
    expect(deps.labels).toEqual([]);
    expect(deps.closes).toEqual([]);
    expect(deps.actions).toMatchObject([
      {
        woId: stem,
        action: RECONCILE_SKIP_ACTION,
        result: 'https://github.com/bluedevilcollectibles/bdc-harness/pull/404:abc123merge',
      },
    ]);
  });

  test('Reconcile-Skip marker is recognized with CRLF line endings', async () => {
    const deps = fakeDeps({
      prs: [
        mergedPr({
          body: `Implements ${stem}.\r\n\r\nReconcile-Skip: ${stem}\r\n`,
        }),
      ],
    });

    const result = await runReconcileOnce({ deps });

    expect(result).toEqual({ scanned: 1, closed: 0, skipped: false });
    expect(deps.comments).toHaveLength(1);
    expect(deps.labels).toEqual([]);
    expect(deps.closes).toEqual([]);
    expect(deps.actions).toMatchObject([
      {
        woId: stem,
        action: RECONCILE_SKIP_ACTION,
      },
    ]);
  });

  test('merged PR without Reconcile-Skip keeps existing close behavior unchanged', async () => {
    const deps = fakeDeps({ prs: [mergedPr({ body: `Implements ${stem}.` })] });

    const result = await runReconcileOnce({ deps });

    expect(result).toEqual({ scanned: 1, closed: 1, skipped: false });
    expect(deps.comments).toHaveLength(1);
    expect(deps.comments[0]).toContain(`Overseer reconcile closed tracker for ${stem}.`);
    expect(deps.labels).toEqual(['wo:done']);
    expect(deps.closes).toEqual([1044]);
    expect(deps.actions).toMatchObject([
      {
        woId: stem,
        action: RECONCILE_ACTION,
        result: 'https://github.com/bluedevilcollectibles/bdc-harness/pull/404:abc123merge',
      },
    ]);
  });

  test('already noted Reconcile-Skip marker does not double-post or double-record action', async () => {
    const deps = fakeDeps({
      skipAlreadyNoted: true,
      prs: [
        mergedPr({
          body: `Implements ${stem}.

Reconcile-Skip: ${stem}`,
        }),
      ],
    });

    const result = await runReconcileOnce({ deps });

    expect(result).toEqual({ scanned: 1, closed: 0, skipped: false });
    expect(deps.comments).toEqual([]);
    expect(deps.labels).toEqual([]);
    expect(deps.closes).toEqual([]);
    expect(deps.actions).toEqual([]);
  });

  test('default deps wire skip-note lookup to reconcile skip action records', async () => {
    const originalGithubToken = process.env.GITHUB_TOKEN;
    const originalGhToken = process.env.GH_TOKEN;
    process.env.GITHUB_TOKEN = 'test-token';
    delete process.env.GH_TOKEN;
    hasReconcileActionForPrCalls.length = 0;

    try {
      const deps = createDefaultReconcileDeps();
      await expect(deps.hasSkipBeenNoted?.({ prRef: 'owner/repo#1219', woId: stem })).resolves.toBe(
        true
      );
    } finally {
      if (originalGithubToken === undefined) {
        delete process.env.GITHUB_TOKEN;
      } else {
        process.env.GITHUB_TOKEN = originalGithubToken;
      }
      if (originalGhToken === undefined) {
        delete process.env.GH_TOKEN;
      } else {
        process.env.GH_TOKEN = originalGhToken;
      }
    }

    expect(hasReconcileActionForPr).toHaveBeenCalledTimes(1);
    expect(hasReconcileActionForPrCalls).toEqual([
      {
        prRef: 'owner/repo#1219',
        woId: stem,
        action: RECONCILE_SKIP_ACTION,
      },
    ]);
  });
});
