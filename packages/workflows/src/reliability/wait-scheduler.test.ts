import { describe, expect, it, mock } from 'bun:test';
import type { IWorkflowStore } from '../store';
import type { ScheduledProviderWaitRecord } from './types';
import { processDueProviderWaits } from './wait-scheduler';

function wait(): ScheduledProviderWaitRecord {
  return {
    waitId: 'wait-1',
    runId: 'run-1',
    attemptId: 'attempt-1',
    provider: 'claude',
    reasonCode: 'provider_quota_wait',
    resumeAt: '2026-07-09T12:00:00.000Z',
    state: 'scheduled',
    claimOwnerId: null,
    claimToken: null,
    createdAt: '2026-07-09T11:00:00.000Z',
    claimedAt: null,
    cancelledAt: null,
    completedAt: null,
  };
}

function store(statuses: Array<'waiting_provider' | 'cancelled'>): IWorkflowStore {
  let statusIndex = 0;
  return {
    listDueProviderWaits: mock(async () => [wait()]),
    getWorkflowRunStatus: mock(async () => statuses[Math.min(statusIndex++, statuses.length - 1)]),
    claimProviderWait: mock(async () => true),
    completeProviderWait: mock(async () => true),
    cancelProviderWaits: mock(async () => 1),
    releaseProviderWaitClaim: mock(async () => true),
  } as unknown as IWorkflowStore;
}

describe('processDueProviderWaits', () => {
  it('claims and completes a due wait around the resume callback', async () => {
    const workflowStore = store(['waiting_provider', 'waiting_provider']);
    const resume = mock(async () => undefined);

    const result = await processDueProviderWaits(workflowStore, resume, {
      ownerId: 'scheduler-1',
      now: () => new Date('2026-07-09T13:00:00.000Z'),
    });

    expect(result).toEqual({ due: 1, resumed: 1, cancelled: 0, deferred: 0 });
    expect(workflowStore.claimProviderWait).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledWith(expect.objectContaining({ waitId: 'wait-1' }));
    expect(workflowStore.completeProviderWait).toHaveBeenCalledTimes(1);
  });

  it('lets cancellation before claim win without invoking resume', async () => {
    const workflowStore = store(['cancelled']);
    const resume = mock(async () => undefined);

    const result = await processDueProviderWaits(workflowStore, resume, {
      ownerId: 'scheduler-1',
      now: () => new Date('2026-07-09T13:00:00.000Z'),
    });

    expect(result.cancelled).toBe(1);
    expect(workflowStore.claimProviderWait).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });

  it('lets cancellation after claim win without invoking resume', async () => {
    const workflowStore = store(['waiting_provider', 'cancelled']);
    const resume = mock(async () => undefined);

    const result = await processDueProviderWaits(workflowStore, resume, {
      ownerId: 'scheduler-1',
      now: () => new Date('2026-07-09T13:00:00.000Z'),
    });

    expect(result.cancelled).toBe(1);
    expect(workflowStore.claimProviderWait).toHaveBeenCalledTimes(1);
    expect(resume).not.toHaveBeenCalled();
  });

  it('returns a failed wake claim to the durable queue', async () => {
    const workflowStore = store(['waiting_provider', 'waiting_provider']);
    const resume = mock(async () => {
      throw new Error('provider still unavailable');
    });

    const result = await processDueProviderWaits(workflowStore, resume, {
      ownerId: 'scheduler-1',
      now: () => new Date('2026-07-09T13:00:00.000Z'),
      retryDelayMs: 45_000,
    });

    expect(result.deferred).toBe(1);
    expect(workflowStore.releaseProviderWaitClaim).toHaveBeenCalledWith(
      expect.objectContaining({ waitId: 'wait-1', resumeAt: '2026-07-09T13:00:45.000Z' })
    );
    expect(workflowStore.completeProviderWait).not.toHaveBeenCalled();
  });
});
