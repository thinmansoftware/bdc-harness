import { describe, expect, test } from 'bun:test';
import {
  registerListQuerySchema,
  registerListResponseSchema,
  registerMetaResponseSchema,
  registerRowSchema,
} from './taskmaster.schemas';

const row = {
  thread_ref: 'gh:thinmansoftware/bdc-xo#1',
  snapshot_id: 'snapshot-1',
  repo: 'thinmansoftware/bdc-xo',
  issue_number: 1,
  title: null,
  priority: 'P1',
  labels_json: '[]',
  owner_login: null,
  is_blocked: 0,
  blocked_reason: null,
  next_action: null,
  latest_marker_kind: null,
  latest_marker_at: null,
  state: 'open',
  last_movement_at: null,
  last_movement_kind: null,
  attempts_24h: 0,
  attempts_total: 0,
  evidence_observed_at: null,
  source_updated_at: '2026-08-20T00:00:00.000Z',
};

describe('taskmaster register schemas', () => {
  test('register: row preserves nullable fields as null', () => {
    const parsed = registerRowSchema.parse(row);
    expect(parsed.owner_login).toBeNull();
    expect(parsed.blocked_reason).toBeNull();
    expect(parsed.next_action).toBeNull();
  });

  test('register: list response includes rows total limit and offset', () => {
    const parsed = registerListResponseSchema.parse({
      rows: [row],
      total: 1,
      limit: 50,
      offset: 0,
    });
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.total).toBe(1);
  });

  test('register: query exposes three-state blocked filtering', () => {
    expect(registerListQuerySchema.parse({}).blocked).toBeUndefined();
    expect(registerListQuerySchema.parse({ blocked: 'true' }).blocked).toBe('true');
    expect(registerListQuerySchema.parse({ blocked: 'false' }).blocked).toBe('false');
  });

  test('register: unavailable freshness is represented as an array', () => {
    const parsed = registerMetaResponseSchema.parse({
      freshness: ['UNAVAILABLE'],
      rebuilt_at: null,
      row_count: 0,
      partial_count: 0,
      pause_state: 'PAUSED',
      unaddressed_xo: 0,
    });
    expect(parsed.freshness).toEqual(['UNAVAILABLE']);
  });

  test('register: scalar freshness is rejected', () => {
    expect(() =>
      registerMetaResponseSchema.parse({
        freshness: 'UNAVAILABLE',
        rebuilt_at: null,
        row_count: 0,
        partial_count: 0,
        pause_state: 'PAUSED',
        unaddressed_xo: 0,
      })
    ).toThrow();
  });

  test('register: stale and partial freshness may coexist', () => {
    const parsed = registerMetaResponseSchema.parse({
      freshness: ['STALE', 'PARTIAL'],
      rebuilt_at: '2026-08-20T00:00:00.000Z',
      row_count: 10,
      partial_count: 7,
      pause_state: 'HARD_PAUSE',
      unaddressed_xo: 3,
    });
    expect(parsed.freshness).toEqual(['STALE', 'PARTIAL']);
    expect(parsed.partial_count).toBe(7);
  });
});
