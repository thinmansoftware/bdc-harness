/**
 * Test 1 (WO-HARNESS-MERGE-SWEEP-LIVENESS-AND-PAGING-01): a throw in the
 * operator-card delivery scheduler (the 2026-11-04 SQLITE_BUSY) is isolated and
 * does not stop the watcher, the merge bridge or the reconcile loops.
 */
import { describe, expect, test } from 'bun:test';
import { runOverseerService } from '../service.ts';

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`waitFor timed out: ${label}`);
    await sleep(5);
  }
}

describe('operator-card delivery isolation', () => {
  test('Test 1: a throw in the delivery scheduler does not stop the watcher, merge bridge or reconcile', async () => {
    const controller = new AbortController();
    const isolatedLogs: string[] = [];
    let watcherPasses = 0;
    let drains = 0;
    let bridgeRuns = 0;
    let reconcileRuns = 0;
    let rejected: unknown;

    const deps = {
      listRunsForWatch: async () => {
        watcherPasses += 1;
        return [];
      },
      listRunEvents: async () => [],
      findPullRequest: async () => ({ exists: false as const }),
      mergePullRequest: async () => undefined,
      insertOverseerAction: async () => undefined,
    };

    const service = runOverseerService({
      enabled: true,
      adapterKind: 'fake',
      deps,
      signal: controller.signal,
      intervalMs: 5,
      deliveryEnabled: true,
      deliveryIntervalMs: 5,
      reconcileIntervalMs: 5,
      mergeBridgeEnabled: true,
      mergeBridgeIntervalMs: 5,
      logger: {
        error: (_obj, msg) => {
          isolatedLogs.push(msg);
        },
      },
      mergeBridgeRun: async () => {
        bridgeRuns += 1;
      },
      reconcileRun: async () => {
        reconcileRuns += 1;
      },
      deliveryDrain: async () => {
        drains += 1;
        // The 2026-11-04 failure: SQLITE_BUSY on the first drain, fine afterwards.
        if (drains === 1) {
          throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
        }
      },
    }).catch((error: unknown) => {
      rejected = error;
    });

    await waitFor(
      () => drains >= 3 && watcherPasses >= 4 && bridgeRuns >= 3 && reconcileRuns >= 3,
      'drain retries and every loop iterating after the drain error'
    );
    const watcherAtCheck = watcherPasses;
    const bridgeAtCheck = bridgeRuns;
    const reconcileAtCheck = reconcileRuns;
    await waitFor(
      () =>
        watcherPasses > watcherAtCheck &&
        bridgeRuns > bridgeAtCheck &&
        reconcileRuns > reconcileAtCheck,
      'all loops still advancing'
    );
    controller.abort();
    await service;

    expect(rejected).toBeUndefined();
    expect(
      isolatedLogs.filter(msg => msg === 'overseer.delivery.iteration_failed_isolated')
    ).toHaveLength(1);
    expect(drains).toBeGreaterThanOrEqual(3);
  });
});
