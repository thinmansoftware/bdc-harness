import { describe, expect, test } from 'bun:test';
import { routeOpsEvent, type OpsEventRoutingState } from './ops-event-routing';

describe('ops event routing', () => {
  test('routine, person and blocker events have exactly one destination', () => {
    expect(routeOpsEvent({ body: 'checks green' })).toMatchObject({ class: 'ROUTINE', destination: 'digest' });
    expect(routeOpsEvent({ body: 'decision needed: approve deploy' })).toMatchObject({ class: 'NEEDS_A_PERSON', destination: 'interrupt' });
    expect(routeOpsEvent({ body: 'service_role key leaked' })).toMatchObject({ class: 'BLOCKER', destination: 'interrupt' });
  });
  test('repeat blocker is routine for 24 hours and interrupts after the boundary', () => {
    const state: OpsEventRoutingState = {};
    const event = { body: 'service_role key', subject_key: 'gh:a/b#1' };
    expect(routeOpsEvent(event, { state, now: new Date('2026-01-01T00:00:00Z') }).class).toBe('BLOCKER');
    expect(routeOpsEvent(event, { state, now: new Date('2026-01-01T03:00:00Z') }).class).toBe('ROUTINE');
    expect(routeOpsEvent(event, { state, now: new Date('2026-01-02T01:00:00Z') }).class).toBe('BLOCKER');
  });
  test('expectation exhaustion is routine unless blocker priority', () => {
    const event = { sender: 'taskmaster', body: 'expectation EXHAUSTED: owner operator' };
    expect(routeOpsEvent(event).class).toBe('ROUTINE');
    expect(routeOpsEvent({ ...event, priority: 'blocker' }).class).toBe('BLOCKER');
  });
});
