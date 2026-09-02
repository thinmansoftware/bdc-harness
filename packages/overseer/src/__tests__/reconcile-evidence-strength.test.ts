/**
 * Reconcile must not close a WO tracker on a PR that merely MENTIONS the WO,
 * on a PR that carries `Reconcile-Skip: <WO-ID>`, or on a spec-only PR in the
 * tracker repo.
 *
 * Anchor (2026-09-02, bdc-xo #1889 = WO-LSPRO-M157-STREAM-STAYS-OPEN-UI-01):
 * reconcile closed the tracker (wo:done, 13:50:36Z) on three merged PRs --
 * bdc-xo #1898, lspro-react #570, shopops #662 -- none of which implemented the
 * WO; its stop-condition greps were 0 on staging. XO reopened it by hand. This
 * file replays those exact PR bodies through runReconcileOnce.
 */

import { describe, expect, mock, test } from 'bun:test';
import { runReconcileOnce, type ReconcileMergedPullRequest } from '../reconcile';
import { fakeDeps } from './reconcile.test';
import {
  bdcXo1898,
  lsproReact568,
  lsproReact570,
  shopops662,
  SHOPOPS_WO,
  UI_WO,
  type PrFixture,
} from './wo-evidence.test';

function fixturePr(fixture: PrFixture): ReconcileMergedPullRequest {
  const match = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)$/.exec(fixture.url);
  if (!match) throw new Error(`unexpected fixture url ${fixture.url}`);
  return {
    owner: match[1] ?? 'thinmansoftware',
    repo: match[2] ?? '',
    number: fixture.number,
    title: fixture.title,
    body: fixture.body,
    htmlUrl: fixture.url,
    state: 'closed',
    merged: true,
    mergeCommitSha: `merge-${fixture.number}`,
    mergedAt: fixture.mergedAt,
  };
}

const uiTracker = {
  owner: 'thinmansoftware',
  repo: 'bdc-xo',
  number: 1889,
  title: UI_WO,
  state: 'open' as const,
};

const shopopsTracker = {
  owner: 'thinmansoftware',
  repo: 'bdc-xo',
  number: 1887,
  title: SHOPOPS_WO,
  state: 'open' as const,
};

const fixtureFiles = new Map<string, string[]>([
  [bdcXo1898.url, bdcXo1898.files],
  [lsproReact570.url, lsproReact570.files],
  [lsproReact568.url, lsproReact568.files],
  [shopops662.url, shopops662.files],
]);

function incidentDeps(prs: ReconcileMergedPullRequest[]) {
  const deps = fakeDeps({ prs });
  deps.findTrackerIssueByStem = mock(async (candidate: string) => {
    if (candidate === UI_WO) return uiTracker;
    if (candidate === SHOPOPS_WO) return shopopsTracker;
    return null;
  });
  return {
    ...deps,
    listPullRequestFiles: mock(async (pr: ReconcileMergedPullRequest) => {
      const files = fixtureFiles.get(pr.htmlUrl);
      if (!files) throw new Error(`no fixture files for ${pr.htmlUrl}`);
      return files;
    }),
  };
}

describe('reconcile -- the 2026-09-02 #1889 replay', () => {
  test('the three merged PRs that closed #1889 no longer close it', async () => {
    const deps = incidentDeps([
      fixturePr(bdcXo1898),
      fixturePr(lsproReact570),
      fixturePr(shopops662),
    ]);

    const result = await runReconcileOnce({ deps });

    // #1889 (the UI tracker) is never closed or labelled.
    expect(deps.closes).not.toContain(uiTracker.number);
    const uiClose = deps.actions.find(a => a.woId === UI_WO && a.action === 'reconcile_close');
    expect(uiClose).toBeUndefined();
    // shopops #662 DOES close its own tracker (#1887): title prefix + manifest.
    expect(result.closed).toBe(1);
    expect(deps.closes).toEqual([shopopsTracker.number]);
    const closeActions = deps.actions.filter(a => a.action === 'reconcile_close');
    expect(closeActions.map(a => a.woId)).toEqual([SHOPOPS_WO]);
  });

  test('bdc-xo #1898 and lspro-react #570 (Reconcile-Skip) post the "noted" comment, no close', async () => {
    const deps = incidentDeps([fixturePr(bdcXo1898), fixturePr(lsproReact570)]);

    const result = await runReconcileOnce({ deps });

    expect(result.closed).toBe(0);
    expect(deps.closes).toEqual([]);
    expect(deps.comments).toHaveLength(2);
    for (const comment of deps.comments) {
      expect(comment).toContain(`Overseer reconcile noted merged PR evidence for ${UI_WO}.`);
      expect(comment).toContain('intentionally left open');
    }
    expect(deps.actions.map(a => a.action)).toEqual([
      'reconcile_skip_noted',
      'reconcile_skip_noted',
    ]);
  });

  test('shopops #662 (bare mention in a finding reply) leaves #1889 open with a warn, silently', async () => {
    const deps = incidentDeps([fixturePr(shopops662)]);

    await runReconcileOnce({ deps });

    const uiActions = deps.actions.filter(a => a.woId === UI_WO);
    expect(uiActions).toEqual([]);
    expect(deps.comments.some(c => c.includes(`closed tracker for ${UI_WO}`))).toBe(false);
    expect(deps.warnings).toContain('overseer.reconcile.bare_mention_tracker_left_open');
  });

  test('lspro-react #568 (the PR that fooled the conductor) also cannot close #1889', async () => {
    const deps = incidentDeps([fixturePr(lsproReact568)]);

    const result = await runReconcileOnce({ deps });

    expect(result.closed).toBe(0);
    expect(deps.closes).toEqual([]);
    expect(deps.actions.map(a => a.action)).toEqual(['reconcile_skip_noted']);
  });
});

describe('reconcile -- spec-only in the tracker repo is never evidence', () => {
  test('bdc-xo #1898 without its marker is still refused: spec-only change set', async () => {
    const stripped = fixturePr({
      ...bdcXo1898,
      // A title that would otherwise CLAIM the WO, so only the file guard stands.
      title: `${UI_WO}: spec amendment`,
      body: bdcXo1898.body.replace(/^\s*Reconcile-Skip:.*$/gim, ''),
    });
    const deps = incidentDeps([stripped]);

    const result = await runReconcileOnce({ deps });

    expect(result.closed).toBe(0);
    expect(deps.closes).toEqual([]);
    expect(deps.warnings).toContain('overseer.reconcile.spec_only_merge_tracker_left_open');
  });

  test('a claiming PR in the tracker repo with NO file list is left open, not closed on a guess', async () => {
    const deps = fakeDeps({
      prs: [
        {
          owner: 'thinmansoftware',
          repo: 'bdc-xo',
          number: 1898,
          title: `${UI_WO}: spec amendment`,
          body: `WO: ${UI_WO}`,
          htmlUrl: 'https://github.com/thinmansoftware/bdc-xo/pull/1898',
          state: 'closed',
          merged: true,
          mergeCommitSha: 'abc',
          mergedAt: '2026-09-02T13:13:37Z',
        },
      ],
    });
    deps.findTrackerIssueByStem = mock(async (candidate: string) =>
      candidate === UI_WO ? uiTracker : null
    );
    delete (deps as { listPullRequestFiles?: unknown }).listPullRequestFiles;

    const result = await runReconcileOnce({ deps });

    expect(result.closed).toBe(0);
    expect(deps.closes).toEqual([]);
    expect(deps.warnings).toContain('overseer.reconcile.tracker_repo_files_unverified_left_open');
  });

  test('a claiming PR in another repo with NO file list keeps the legacy close path', async () => {
    // Compatibility: only the tracker repo is held to the never-close rule when
    // the file list is unavailable; a build PR elsewhere still closes.
    const deps = fakeDeps({
      prs: [
        {
          owner: 'thinmansoftware',
          repo: 'lspro-react',
          number: 999,
          title: `${UI_WO}: implement`,
          body: `WO: ${UI_WO}`,
          htmlUrl: 'https://github.com/thinmansoftware/lspro-react/pull/999',
          state: 'closed',
          merged: true,
          mergeCommitSha: 'def',
          mergedAt: '2026-09-02T14:00:00Z',
        },
      ],
    });
    deps.findTrackerIssueByStem = mock(async (candidate: string) =>
      candidate === UI_WO ? uiTracker : null
    );

    const result = await runReconcileOnce({ deps });

    expect(result.closed).toBe(1);
    expect(deps.closes).toEqual([1889]);
  });
});

describe('reconcile -- what still closes', () => {
  test('a Cauldron PR with a generic title and a manifest WO: line closes the tracker', async () => {
    const deps = fakeDeps({
      prs: [
        {
          owner: 'thinmansoftware',
          repo: 'lspro-react',
          number: 600,
          title: 'BDC feature Work Order implementation',
          body: `Implements the stream-stays-open client.\n\n\`\`\`\nWO: ${UI_WO}\nBuilder: Smart Cauldron\nVALIDATION: PASS\n\`\`\``,
          htmlUrl: 'https://github.com/thinmansoftware/lspro-react/pull/600',
          state: 'closed',
          merged: true,
          mergeCommitSha: 'aaa',
          mergedAt: '2026-09-03T10:00:00Z',
        },
      ],
    });
    deps.findTrackerIssueByStem = mock(async (candidate: string) =>
      candidate === UI_WO ? uiTracker : null
    );
    const withFiles = {
      ...deps,
      listPullRequestFiles: mock(async () => ['src/pages/GradedScanMobilePage.tsx']),
    };

    const result = await runReconcileOnce({ deps: withFiles });

    expect(result.closed).toBe(1);
    expect(deps.closes).toEqual([1889]);
    expect(deps.labels).toEqual(['wo:done']);
  });

  test('a PR whose title starts with the id closes the tracker', async () => {
    const deps = fakeDeps({
      prs: [
        {
          owner: 'thinmansoftware',
          repo: 'lspro-react',
          number: 601,
          title: `${UI_WO}: stream stays open, one click per cert`,
          body: 'No manifest block on this one.',
          htmlUrl: 'https://github.com/thinmansoftware/lspro-react/pull/601',
          state: 'closed',
          merged: true,
          mergeCommitSha: 'bbb',
          mergedAt: '2026-09-03T10:00:00Z',
        },
      ],
    });
    deps.findTrackerIssueByStem = mock(async (candidate: string) =>
      candidate === UI_WO ? uiTracker : null
    );
    const withFiles = {
      ...deps,
      listPullRequestFiles: mock(async () => ['src/pages/GradedScanMobilePage.tsx']),
    };

    const result = await runReconcileOnce({ deps: withFiles });

    expect(result.closed).toBe(1);
    expect(deps.closes).toEqual([1889]);
  });
});
