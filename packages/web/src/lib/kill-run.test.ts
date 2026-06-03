/**
 * WO-MC-NEGAN-DIAGNOSTIC-GRAPH-01 Scenario 4 (/cancel integration) — KillButton.
 *
 * Asserts handleKillRun invokes the injected cancel function with the right
 * runId. The "headshot" path is the real /cancel; this test guards against
 * the regression where reject was bound to the kill action and looped.
 */
import { describe, expect, it, mock } from 'bun:test';
import { handleKillRun } from '@/components/workflows/KillButton';

describe('handleKillRun', () => {
  it('calls the injected cancel function exactly once with the supplied runId', async () => {
    const fn = mock(async (_id: string) => ({ success: true, message: 'cancelled' }));
    await handleKillRun('run-zombie-123', fn);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('run-zombie-123');
  });

  it('propagates rejections from the cancel function', async () => {
    const fn = mock(async (_id: string) => {
      throw new Error('cannot cancel terminal run');
    });
    let caught: Error | null = null;
    try {
      await handleKillRun('run-completed-456', fn);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught?.message).toBe('cannot cancel terminal run');
  });
});
