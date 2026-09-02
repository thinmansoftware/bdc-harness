/**
 * Reconcile must NOT close a WO tracker on a SPEC-ONLY merge.
 *
 * `author-wo.sh` lands the WO spec document (`docs/work-orders/<WO-ID>.md`) on
 * bdc-xo main via its own PR. That PR mentions the WO stem, so reconcile matched
 * it and closed the tracker as `wo:done` -- while zero code had been written. The
 * WO was closed by the very PR that CREATED it.
 *
 * Anchor (2026-07-25): four WOs authored in one session were all falsely closed
 * within minutes. For WO-XO-CRM-MINIMUM-COMPLETE-JOURNEY-01, the target repository
 * `bdc-crm` did not exist at all -- so the WO could not possibly have been done.
 * Prior anchors: bdc-xo #1128, #1149.
 */

import { describe, expect, mock, test } from 'bun:test';
import { isSpecOnlyChangeSet, runReconcileOnce } from '../reconcile';
import { fakeDeps, mergedPr, stem } from './reconcile.test';

describe('isSpecOnlyChangeSet', () => {
  test('a WO spec document alone is spec-only', () => {
    expect(isSpecOnlyChangeSet([`docs/work-orders/${stem}.md`])).toBe(true);
  });

  test('a spec plus a board motion is still spec-only', () => {
    expect(
      isSpecOnlyChangeSet([
        `docs/work-orders/${stem}.md`,
        'docs/board/motions/M-20260725-99-example.md',
      ])
    ).toBe(true);
  });

  test('ONE source file anywhere makes it a real build', () => {
    expect(isSpecOnlyChangeSet([`docs/work-orders/${stem}.md`, 'packages/overseer/src/x.ts'])).toBe(
      false
    );
  });

  test('an empty change set is NOT treated as spec-only', () => {
    // No information is not evidence of paperwork. Defaulting to true here would
    // silently stop reconcile closing anything when the file list is unavailable.
    expect(isSpecOnlyChangeSet([])).toBe(false);
  });

  test('a docs change outside the paperwork paths is a real change', () => {
    expect(isSpecOnlyChangeSet(['docs/runbooks/deploy.md'])).toBe(false);
  });
});

describe('reconcile -- spec-only guard', () => {
  test('does NOT close a tracker when the merged PR is spec-only', async () => {
    const deps = fakeDeps();
    const result = await runReconcileOnce({
      deps: {
        ...deps,
        listPullRequestFiles: mock(async () => [`docs/work-orders/${stem}.md`]),
      },
    });

    expect(deps.closes).toEqual([]);
    expect(deps.labels).toEqual([]);
    expect(result.closed).toBe(0);
    expect(deps.warnings).toContain('overseer.reconcile.spec_only_merge_tracker_left_open');
  });

  test('DOES close a tracker when the merged PR contains real code', async () => {
    const deps = fakeDeps();
    const result = await runReconcileOnce({
      deps: {
        ...deps,
        listPullRequestFiles: mock(async () => [
          `docs/work-orders/${stem}.md`,
          'packages/overseer/src/reconcile.ts',
        ]),
      },
    });

    expect(deps.closes.length).toBe(1);
    expect(deps.labels).toContain('wo:done');
    expect(result.closed).toBe(1);
  });

  test('leaves the tracker OPEN when the file listing fails -- fails open, not closed', async () => {
    // A tracker left open is visible and fixable. One falsely closed is invisible.
    const deps = fakeDeps();
    const result = await runReconcileOnce({
      deps: {
        ...deps,
        listPullRequestFiles: mock(async () => {
          throw new Error('GitHub 502');
        }),
      },
    });

    expect(deps.closes).toEqual([]);
    expect(result.closed).toBe(0);
    expect(deps.warnings).toContain('overseer.reconcile.file_list_failed_leaving_tracker_open');
  });

  test('preserves prior behavior when listPullRequestFiles is not supplied', async () => {
    // Backward compatibility: a deps object predating this guard must still work
    // rather than silently blocking every close.
    const deps = fakeDeps();
    const result = await runReconcileOnce({ deps });

    expect(deps.closes.length).toBe(1);
    expect(result.closed).toBe(1);
  });

  test('the real anchor case: the spec PR that CREATED the WO does not close it', async () => {
    // Reproduces 2026-07-25 exactly -- author-wo.sh PR into bdc-xo, touching only
    // the spec it just landed, mentioning the stem in its title.
    const deps = fakeDeps({
      prs: [
        mergedPr({
          repo: 'bdc-xo',
          number: 1278,
          title: `${stem}: land spec`,
          body: `Lands the spec for ${stem}.\n\nWO: ${stem}`,
        }),
      ],
    });

    const result = await runReconcileOnce({
      deps: {
        ...deps,
        listPullRequestFiles: mock(async () => [`docs/work-orders/${stem}.md`]),
      },
    });

    expect(result.closed).toBe(0);
    expect(deps.closes).toEqual([]);
    expect(deps.labels).not.toContain('wo:done');
  });
});
