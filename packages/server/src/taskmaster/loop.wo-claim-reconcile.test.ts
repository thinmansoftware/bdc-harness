import { describe, expect, mock, test } from 'bun:test';
import { reconcileTaskmasterWoClaims } from './loop';

describe('reconcileTaskmasterWoClaims', () => {
  test('calls the claim reconciler once and returns the released WO ids', async () => {
    const reconcile = mock(async () => ['WO-A-01', 'WO-B-02']);
    const released = await reconcileTaskmasterWoClaims({ reconcileWoClaims: reconcile });
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(released).toEqual(['WO-A-01', 'WO-B-02']);
  });

  test('a reconciler failure is contained and returns an empty list', async () => {
    const reconcile = mock(async (): Promise<string[]> => {
      throw new Error('db unavailable');
    });
    const released = await reconcileTaskmasterWoClaims({ reconcileWoClaims: reconcile });
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(released).toEqual([]);
  });

  test('nothing released returns an empty list', async () => {
    const released = await reconcileTaskmasterWoClaims({ reconcileWoClaims: async () => [] });
    expect(released).toEqual([]);
  });
});
