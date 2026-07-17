import { describe, expect, test } from 'bun:test';
import { assessM42Slice8BProcessHealth } from '../m42-slice8b-process-health';

describe('M-42 Slice 8B process health and runtime honesty', () => {
  test('no healthy Overseer process emits BUILD_READY_NOT_RUNTIME_READY', () => {
    const receipt = assessM42Slice8BProcessHealth({
      audited_host: 'audited-host-1',
      before: { observed_at_ms: 0, processes: [] },
      action_execution_ids: [],
    });
    expect(receipt.verdict).toBe('BUILD_READY_NOT_RUNTIME_READY');
    expect(receipt.recovered).toBe(false);
  });

  test('Overseer process restart mid-workload recovers without double action', () => {
    const receipt = assessM42Slice8BProcessHealth({
      audited_host: 'audited-host-1',
      before: {
        observed_at_ms: 0,
        processes: [{ pid: 100, started_at_ms: 0, healthy: true, command: 'overseer:serve' }],
      },
      after: {
        observed_at_ms: 1,
        processes: [{ pid: 101, started_at_ms: 1, healthy: true, command: 'overseer:serve' }],
      },
      action_execution_ids: ['exec:REFIRE', 'exec:REFRESH', 'exec:CLOSE', 'exec:MERGE'],
    });
    expect(receipt.verdict).toBe('RUNTIME_HEALTHY');
    expect(receipt.restart_detected).toBe(true);
    expect(receipt.recovered).toBe(true);
    expect(receipt.no_double_action).toBe(true);
  });

  test('restart recovery fails if an action execution ID is repeated', () => {
    const receipt = assessM42Slice8BProcessHealth({
      audited_host: 'audited-host-1',
      before: {
        observed_at_ms: 0,
        processes: [{ pid: 100, started_at_ms: 0, healthy: true, command: 'overseer:serve' }],
      },
      after: {
        observed_at_ms: 1,
        processes: [{ pid: 101, started_at_ms: 1, healthy: true, command: 'overseer:serve' }],
      },
      action_execution_ids: ['exec:REFIRE', 'exec:REFIRE'],
    });
    expect(receipt.restart_detected).toBe(true);
    expect(receipt.no_double_action).toBe(false);
    expect(receipt.recovered).toBe(false);
  });
});
