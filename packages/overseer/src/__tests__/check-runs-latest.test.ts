/**
 * Unit tests for reduceToLatestCheckRuns (WO-HARNESS-OVERSEER-LATEST-CHECK-RUN-01).
 *
 * Imports ONLY the pure reducer and the committed live fixture, so this file
 * runs standalone with `bun test <file>` even in lane worktrees that have no
 * dependencies installed (issue #882). No octokit/SDK modules are touched.
 */
import { describe, expect, test } from 'bun:test';
import { reduceToLatestCheckRuns, type LatestCheckRun } from '../check-runs-latest.ts';
import fixture from './fixtures/check-runs-latest.live-2026-09-29.json';

interface FixtureHead {
  repo: string;
  headSha: string;
  checkRuns: LatestCheckRun[];
}

function headRuns(headSha: string): LatestCheckRun[] {
  const head = (fixture.heads as FixtureHead[]).find(h => h.headSha === headSha);
  if (!head) throw new Error(`fixture missing head ${headSha}`);
  return head.checkRuns;
}

describe('reduceToLatestCheckRuns', () => {
  test('1 older failure then newer success reports success and supersedes the failure', () => {
    const runs: LatestCheckRun[] = [
      {
        id: 10,
        name: 'X',
        status: 'completed',
        conclusion: 'failure',
        completed_at: '2026-09-29T08:00:00Z',
      },
      {
        id: 11,
        name: 'X',
        status: 'completed',
        conclusion: 'success',
        completed_at: '2026-09-29T08:05:00Z',
      },
    ];
    for (const order of [runs, [...runs].reverse()]) {
      const { current, superseded } = reduceToLatestCheckRuns(order);
      expect(current).toHaveLength(1);
      expect(current[0]?.id).toBe(11);
      expect(current[0]?.conclusion).toBe('success');
      expect(superseded).toHaveLength(1);
      expect(superseded[0]?.id).toBe(10);
      expect(superseded[0]?.superseded_by).toBe(11);
    }
  });

  test('2 older success then newer failure reports failure', () => {
    const { current, superseded } = reduceToLatestCheckRuns([
      {
        id: 20,
        name: 'X',
        status: 'completed',
        conclusion: 'success',
        completed_at: '2026-09-29T08:00:00Z',
      },
      {
        id: 21,
        name: 'X',
        status: 'completed',
        conclusion: 'failure',
        completed_at: '2026-09-29T08:05:00Z',
      },
    ]);
    expect(current).toHaveLength(1);
    expect(current[0]?.id).toBe(21);
    expect(current[0]?.conclusion).toBe('failure');
    expect(superseded.map(r => r.id)).toEqual([20]);
  });

  test('3 equal completed_at breaks ties by higher id, not order or conclusion', () => {
    const at = '2026-09-29T08:00:00Z';
    const failFirst = reduceToLatestCheckRuns([
      { id: 30, name: 'X', status: 'completed', conclusion: 'failure', completed_at: at },
      { id: 31, name: 'X', status: 'completed', conclusion: 'success', completed_at: at },
    ]);
    expect(failFirst.current[0]?.id).toBe(31);
    expect(failFirst.current[0]?.conclusion).toBe('success');

    const swapped = reduceToLatestCheckRuns([
      { id: 30, name: 'X', status: 'completed', conclusion: 'success', completed_at: at },
      { id: 31, name: 'X', status: 'completed', conclusion: 'failure', completed_at: at },
    ]);
    expect(swapped.current[0]?.id).toBe(31);
    expect(swapped.current[0]?.conclusion).toBe('failure');
  });

  test('4 a newer in-progress rerun makes the check pending, not the older result', () => {
    const { current, superseded } = reduceToLatestCheckRuns([
      {
        id: 40,
        name: 'X',
        status: 'completed',
        conclusion: 'success',
        completed_at: '2026-09-29T08:00:00Z',
      },
      { id: 41, name: 'X', status: 'in_progress', conclusion: null },
    ]);
    expect(current).toHaveLength(1);
    expect(current[0]?.id).toBe(41);
    expect(current[0]?.status).toBe('in_progress');
    expect(superseded.map(r => r.id)).toEqual([40]);

    // summarizeChecks-equivalent tally over the reduced current list.
    const pending = current.filter(r => r.status !== 'completed').length;
    const passed = current.filter(
      r =>
        r.status === 'completed' && ['success', 'neutral', 'skipped'].includes(r.conclusion ?? '')
    ).length;
    expect(pending).toBe(1);
    expect(passed).toBe(0);
  });

  test('5 distinct names are untouched and first-seen order is preserved', () => {
    const { current, superseded } = reduceToLatestCheckRuns([
      {
        id: 1,
        name: 'A',
        status: 'completed',
        conclusion: 'success',
        completed_at: '2026-09-29T08:00:00Z',
      },
      {
        id: 2,
        name: 'B',
        status: 'completed',
        conclusion: 'success',
        completed_at: '2026-09-29T08:00:00Z',
      },
      {
        id: 3,
        name: 'C',
        status: 'completed',
        conclusion: 'success',
        completed_at: '2026-09-29T08:00:00Z',
      },
      {
        id: 4,
        name: 'D',
        status: 'completed',
        conclusion: 'failure',
        completed_at: '2026-09-29T08:00:00Z',
      },
      {
        id: 5,
        name: 'D',
        status: 'completed',
        conclusion: 'success',
        completed_at: '2026-09-29T08:05:00Z',
      },
    ]);
    expect(current.map(r => r.name)).toEqual(['A', 'B', 'C', 'D']);
    expect(current.find(r => r.name === 'D')?.id).toBe(5);
    expect(superseded).toHaveLength(1);
    expect(superseded[0]?.id).toBe(4);
  });

  test('6 legacy runs without id or timestamps are returned unchanged', () => {
    const input: LatestCheckRun[] = [
      { name: 'X', status: 'completed', conclusion: 'failure' },
      { name: 'X', status: 'completed', conclusion: 'success' },
    ];
    const { current, superseded } = reduceToLatestCheckRuns(input);
    expect(current).toEqual(input);
    expect(superseded).toHaveLength(0);
  });

  test('7 live 2026-09-29 replay over the committed fixture', () => {
    const shopops = reduceToLatestCheckRuns(headRuns('ba023dca82a7f41274a68a98bb05967531eac1a8'));
    const shopopsGate = shopops.current.find(
      r => r.name === 'manifest-validate / manifest-validate'
    );
    expect(shopopsGate?.id).toBe(109329769985);
    expect(shopopsGate?.conclusion).toBe('success');

    const lsproPass = reduceToLatestCheckRuns(headRuns('33579a2f493b33b7fa2037aa58443da0518184b3'));
    const passGate = lsproPass.current.find(r => r.name === 'CE Change Scope Gate');
    expect(passGate?.id).toBe(109292364884);
    expect(passGate?.conclusion).toBe('success');

    const lsproFail = reduceToLatestCheckRuns(headRuns('43f6e933efe51b59bdd38eac81ea00c328990fc7'));
    const failGate = lsproFail.current.find(r => r.name === 'CE Change Scope Gate');
    // Honest: the newest run of that name at that head is a failure.
    expect(failGate?.id).toBe(109340055390);
    expect(failGate?.conclusion).toBe('failure');
    const promoGate = lsproFail.current.find(r => r.name === 'CE Promotion Gate');
    expect(promoGate?.id).toBe(109340055172);
    expect(promoGate?.conclusion).toBe('success');
  });
});
