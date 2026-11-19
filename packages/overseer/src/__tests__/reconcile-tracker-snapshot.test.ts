// WO-HARNESS-RECONCILE-TRACKER-SNAPSHOT-INCREMENTAL-01 (bdc-xo#5701).
// The reconcile pass re-read the whole bdc-xo tracker (57 pages, 855 calls in 29 minutes) every pass and
// failed closed at 100 pages (10,000 issues and pull requests). The snapshot is now kept and refreshed with
// only what changed since the last refresh.
import { describe, expect, mock, test } from 'bun:test';
import {
  findTrackerIssueByStem,
  readTrackerIssueSnapshot,
  type OctokitLike,
  type TrackerSnapshotContext,
} from '../reconcile';

const ORG = 'thinmansoftware';
const REPO = 'bdc-xo';
const T = Date.parse('2026-11-12T20:00:00.000Z');
const HOUR = 60 * 60 * 1000;

interface Item {
  number: number;
  title: string;
  state: 'open' | 'closed';
  updated: number;
}

function restRow(item: Item): Record<string, unknown> {
  return {
    number: item.number,
    title: item.title,
    body: null,
    state: item.state,
    repository_url: `https://api.github.com/repos/${ORG}/${REPO}`,
    html_url: `https://github.com/${ORG}/${REPO}/issues/${String(item.number)}`,
    created_at: new Date(T - 86_400_000 + item.number).toISOString(),
    updated_at: new Date(item.updated).toISOString(),
  };
}

const stem = (n: number): string => `WO-GEN-${String(n).padStart(5, '0')}`;

function items(count: number): Item[] {
  return Array.from({ length: count }, (_unused, index) => ({
    number: index + 1,
    title: stem(index + 1),
    state: 'open' as const,
    // old: not touched since a day before the test clock
    updated: T - 86_400_000,
  }));
}

function fakeTracker(rows: Item[]): {
  octokit: OctokitLike;
  calls: Array<Record<string, unknown>>;
  rows: Item[];
} {
  const calls: Array<Record<string, unknown>> = [];
  const octokit = {
    issues: {
      listForRepo: async (input: Record<string, unknown>) => {
        calls.push(input);
        let selected = [...rows];
        if (input.since)
          selected = selected.filter(r => r.updated >= Date.parse(String(input.since)));
        selected.sort((a, b) =>
          input.sort === 'updated'
            ? a.updated - b.updated || a.number - b.number
            : a.number - b.number
        );
        const page = Number(input.page);
        const per = Number(input.per_page);
        return { data: selected.slice((page - 1) * per, page * per).map(restRow) };
      },
    },
  } as unknown as OctokitLike;
  return { octokit, calls, rows };
}

function context(clock: { now: number }): {
  ctx: TrackerSnapshotContext;
  alerts: Array<{ key: string; body: string }>;
} {
  const alerts: Array<{ key: string; body: string }> = [];
  const ctx: TrackerSnapshotContext = {
    cache: { current: undefined },
    nowMs: () => clock.now,
    alertOperator: mock(async (input: { key: string; body: string }) => {
      alerts.push(input);
    }),
    alertedAtMs: { near: Number.NEGATIVE_INFINITY, exceeded: Number.NEGATIVE_INFINITY },
  };
  return { ctx, alerts };
}

describe('reconcile tracker snapshot: incremental refresh', () => {
  test('Test 1: the second pass reads a handful of pages, not 57', async () => {
    const tracker = fakeTracker(items(5695));
    const clock = { now: T };
    const { ctx } = context(clock);

    const first = await readTrackerIssueSnapshot(tracker.octokit, ctx);
    expect(tracker.calls).toHaveLength(57);
    expect(tracker.calls[0]).toMatchObject({ sort: 'created', direction: 'asc', state: 'all' });

    tracker.calls.length = 0;
    clock.now = T + 120_000;
    const second = await readTrackerIssueSnapshot(tracker.octokit, ctx);

    expect(tracker.calls.length).toBeLessThanOrEqual(3);
    expect(tracker.calls[0]).toMatchObject({ sort: 'updated', direction: 'asc', state: 'all' });
    expect(typeof tracker.calls[0].since).toBe('string');
    expect(second.size).toBe(5695);
    expect(findTrackerIssueByStem(second, stem(4242))?.number).toBe(4242);
    expect(findTrackerIssueByStem(first, stem(4242))?.number).toBe(4242);
  });

  test('Test 2: a changed or closed issue is seen on the next pass', async () => {
    const tracker = fakeTracker(items(300));
    const clock = { now: T };
    const { ctx } = context(clock);
    await readTrackerIssueSnapshot(tracker.octokit, ctx);

    tracker.rows[9].title = 'WO-RENAMED-00010';
    tracker.rows[9].updated = T + 10_000;
    tracker.rows[19].state = 'closed';
    tracker.rows[19].updated = T + 20_000;
    clock.now = T + 60_000;
    const next = await readTrackerIssueSnapshot(tracker.octokit, ctx);

    expect(findTrackerIssueByStem(next, 'WO-RENAMED-00010')?.number).toBe(10);
    expect(findTrackerIssueByStem(next, stem(10))).toBeNull();
    expect(next.get(20)?.state).toBe('closed');
  });

  test('Test 3: a new issue is found by stem on the next pass', async () => {
    const tracker = fakeTracker(items(300));
    const clock = { now: T };
    const { ctx } = context(clock);
    await readTrackerIssueSnapshot(tracker.octokit, ctx);

    tracker.rows.push({ number: 301, title: 'WO-NEW-ONE-01', state: 'open', updated: T + 5_000 });
    clock.now = T + 60_000;
    const next = await readTrackerIssueSnapshot(tracker.octokit, ctx);

    expect(findTrackerIssueByStem(next, 'WO-NEW-ONE-01')?.number).toBe(301);
  });

  test('Test 4: the since cursor overlaps the previous refresh by 120 seconds', async () => {
    const tracker = fakeTracker(items(50));
    const clock = { now: T };
    const { ctx } = context(clock);
    await readTrackerIssueSnapshot(tracker.octokit, ctx);

    tracker.calls.length = 0;
    clock.now = T + 60_000;
    await readTrackerIssueSnapshot(tracker.octokit, ctx);
    expect(tracker.calls[0].since).toBe(new Date(T - 120_000).toISOString());

    // the cursor moves to the previous refresh start (T + 60 s), still with the overlap
    tracker.calls.length = 0;
    clock.now = T + 180_000;
    await readTrackerIssueSnapshot(tracker.octokit, ctx);
    expect(tracker.calls[0].since).toBe(new Date(T + 60_000 - 120_000).toISOString());
  });

  test('Test 5: a tracker larger than the old 100-page budget still reconciles', async () => {
    const tracker = fakeTracker(items(11_950));
    const clock = { now: T };
    const { ctx, alerts } = context(clock);

    const snapshot = await readTrackerIssueSnapshot(tracker.octokit, ctx);

    expect(tracker.calls).toHaveLength(120);
    expect(snapshot.size).toBe(11_950);
    expect(findTrackerIssueByStem(snapshot, stem(11_900))?.number).toBe(11_900);
    expect(alerts).toHaveLength(0);
  });

  test('Test 6a: a full refresh runs after 6 hours', async () => {
    const tracker = fakeTracker(items(450));
    const clock = { now: T };
    const { ctx } = context(clock);
    await readTrackerIssueSnapshot(tracker.octokit, ctx);

    tracker.calls.length = 0;
    clock.now = T + 6 * HOUR + 1000;
    await readTrackerIssueSnapshot(tracker.octokit, ctx);
    expect(tracker.calls).toHaveLength(5);
    expect(tracker.calls.every(call => call.sort === 'created')).toBe(true);

    // and the next pass is incremental again
    tracker.calls.length = 0;
    clock.now = T + 6 * HOUR + 61_000;
    await readTrackerIssueSnapshot(tracker.octokit, ctx);
    expect(tracker.calls.every(call => call.sort === 'updated')).toBe(true);
  });

  test('Test 6b: an incremental read that needs more than 20 pages falls back to one full scan', async () => {
    const tracker = fakeTracker(items(3000));
    const clock = { now: T };
    const { ctx } = context(clock);
    await readTrackerIssueSnapshot(tracker.octokit, ctx);

    // 2,100 issues changed since the cursor: 21 full pages of updates
    for (let i = 0; i < 2100; i += 1) tracker.rows[i].updated = T + 10_000 + i;
    tracker.rows[0].title = 'WO-CHANGED-00001';
    tracker.calls.length = 0;
    clock.now = T + 60_000;
    const next = await readTrackerIssueSnapshot(tracker.octokit, ctx);

    const incremental = tracker.calls.filter(call => call.sort === 'updated');
    const full = tracker.calls.filter(call => call.sort === 'created');
    expect(incremental).toHaveLength(20);
    expect(full).toHaveLength(31);
    expect(findTrackerIssueByStem(next, 'WO-CHANGED-00001')?.number).toBe(1);
  });

  test('Test 7: the budget alert is loud and names an observed count', async () => {
    const clock = { now: T };

    // 40,150 rows: 401 pages, more than the 400-page budget. The exact total is not observable.
    const big = fakeTracker(items(40_150));
    const exceeded = context(clock);
    await expect(readTrackerIssueSnapshot(big.octokit, exceeded.ctx)).rejects.toThrow(
      'exceeded its complete-page budget'
    );
    expect(big.calls).toHaveLength(400);
    expect(exceeded.alerts).toHaveLength(1);
    expect(exceeded.alerts[0].body).toContain('at least 40000 items read');
    expect(exceeded.alerts[0].body).toContain('budget 400 pages');
    expect(exceeded.alerts[0].body).not.toContain('40150');

    // a second pass inside 6 hours sends no second alert
    clock.now = T + HOUR;
    await expect(readTrackerIssueSnapshot(big.octokit, exceeded.ctx)).rejects.toThrow();
    expect(exceeded.alerts).toHaveLength(1);

    // 32,950 rows: 329 pages, the last one short: succeeds, and the near-budget alert names the exact count
    const near = fakeTracker(items(32_950));
    const nearContext = context({ now: T });
    const snapshot = await readTrackerIssueSnapshot(near.octokit, nearContext.ctx);
    expect(snapshot.size).toBe(32_950);
    expect(nearContext.alerts).toHaveLength(1);
    expect(nearContext.alerts[0].body).toContain('32950');
  });

  test('a read error during a refresh leaves the cache untouched and fails the pass closed', async () => {
    const tracker = fakeTracker(items(300));
    const clock = { now: T };
    const { ctx } = context(clock);
    await readTrackerIssueSnapshot(tracker.octokit, ctx);
    const before = ctx.cache.current?.rows.size;

    const failing = {
      issues: {
        listForRepo: async () => {
          throw new Error('github down');
        },
      },
    } as unknown as OctokitLike;
    clock.now = T + 60_000;
    await expect(readTrackerIssueSnapshot(failing, ctx)).rejects.toThrow('github down');
    expect(ctx.cache.current?.rows.size).toBe(before);

    // the next pass reads incrementally from the same cursor and succeeds
    clock.now = T + 120_000;
    const ok = await readTrackerIssueSnapshot(tracker.octokit, ctx);
    expect(ok.size).toBe(300);
  });
});
