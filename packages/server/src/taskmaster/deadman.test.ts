import { beforeEach, describe, expect, test } from 'bun:test';
import {
  getLastHeartbeat,
  isTickStale,
  recordTickHeartbeat,
  resetHeartbeat,
  tickHealth,
} from './deadman';

const INTERVAL = 1000;

beforeEach(() => {
  resetHeartbeat();
});

describe('deadman heartbeat', () => {
  test('never-armed heartbeat is not stale', () => {
    expect(getLastHeartbeat()).toBeNull();
    expect(isTickStale(null, 999_999, INTERVAL)).toBe(false);
    expect(tickHealth(null, 999_999, INTERVAL)).toBe('healthy');
  });

  test('2 missed intervals is healthy, 3 missed intervals is degraded (fake clock)', () => {
    recordTickHeartbeat(0);
    // 2 missed intervals elapsed -> still healthy.
    expect(tickHealth(getLastHeartbeat(), 2 * INTERVAL, INTERVAL)).toBe('healthy');
    // 3 missed intervals elapsed -> degraded.
    expect(tickHealth(getLastHeartbeat(), 3 * INTERVAL, INTERVAL)).toBe('degraded');
  });

  test('recovery re-arms: a fresh heartbeat clears the degraded state', () => {
    recordTickHeartbeat(0);
    expect(tickHealth(getLastHeartbeat(), 5 * INTERVAL, INTERVAL)).toBe('degraded');
    // Loop recovers and beats again.
    recordTickHeartbeat(5 * INTERVAL);
    expect(tickHealth(getLastHeartbeat(), 5 * INTERVAL, INTERVAL)).toBe('healthy');
  });
});
