import { describe, expect, test } from 'bun:test';
import { getMaintenanceWindow, isInMaintenanceWindow } from './maintenance-window';

describe('maintenance window', () => {
  test('afternoon_tick_does_nothing', () =>
    expect(isInMaintenanceWindow(new Date('2026-10-21T18:00:00Z'))).toBe(false));
  test('overnight_tick_runs_once window calculations are DST aware', () => {
    expect(isInMaintenanceWindow(new Date('2026-10-22T06:00:00Z'))).toBe(true);
    expect(isInMaintenanceWindow(new Date('2026-01-22T07:00:00Z'))).toBe(true);
    expect(isInMaintenanceWindow(new Date('2026-10-22T10:30:00Z'))).toBe(false);
  });
  test('wrapping windows use the preceding date after midnight', () => {
    const result = getMaintenanceWindow(new Date('2026-10-22T04:30:00Z'), {
      start: '23:00',
      end: '02:00',
    });
    expect(result.inside).toBe(true);
    expect(result.windowKey).toContain('2026-10-21');
  });
  test('boundaries are half open and invalid configuration fails closed', () => {
    expect(isInMaintenanceWindow(new Date('2026-10-22T05:00:00Z'))).toBe(true);
    expect(isInMaintenanceWindow(new Date('2026-10-22T09:00:00Z'))).toBe(false);
    expect(getMaintenanceWindow(new Date(), { start: '01:00', end: '01:00' }).inside).toBe(false);
    expect(getMaintenanceWindow(new Date(), { timeZone: 'Not/AZone' }).inside).toBe(false);
  });
});
