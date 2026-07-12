import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createQueryResult, mockPostgresDialect } from '../test/mocks/database';

const mockQuery = mock(() => Promise.resolve(createQueryResult([])));

mock.module('./connection', () => ({
  pool: { query: mockQuery },
  getDialect: () => mockPostgresDialect,
}));

import {
  clearKnownBadBinding,
  findActiveByBindingKey,
  incrementKnownBadBindingHit,
  upsertKnownBadBinding,
  type KnownBadBindingRow,
} from './known-bad-bindings';

const row: KnownBadBindingRow = {
  id: 'id-1',
  binding_key: 'binding-1',
  provider_id: 'codex',
  model_id: 'qwen/qwen3-coder',
  auth_context_id: 'codex:chatgpt-account',
  assistant_config_hash: 'a',
  node_override_hash: 'n',
  error_class: 'structural_model_not_supported',
  http_status: 400,
  error_body_excerpt: 'not supported',
  first_seen_at: '2026-07-11T00:00:00.000Z',
  last_seen_at: '2026-07-11T00:00:00.000Z',
  hit_count: 1,
  source: 'fire_probe',
  cleared_at: null,
  clear_reason: null,
};

describe('known-bad-bindings db', () => {
  beforeEach(() => mockQuery.mockClear());

  test('upserts a structural rejection row', async () => {
    mockQuery.mockResolvedValueOnce(createQueryResult([row]));
    await expect(
      upsertKnownBadBinding({
        bindingKey: row.binding_key,
        providerId: row.provider_id,
        modelId: row.model_id,
        authContextId: row.auth_context_id,
        assistantConfigHash: row.assistant_config_hash,
        nodeOverrideHash: row.node_override_hash,
        errorClass: row.error_class,
        httpStatus: 400,
        errorBodyExcerpt: row.error_body_excerpt,
        source: 'fire_probe',
      })
    ).resolves.toEqual(row);
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('ON CONFLICT'), expect.any(Array));
  });

  test('finds an active binding', async () => {
    mockQuery.mockResolvedValueOnce(createQueryResult([row]));
    await expect(findActiveByBindingKey('binding-1')).resolves.toEqual(row);
  });

  test('clears by operator reason', async () => {
    mockQuery.mockResolvedValueOnce(createQueryResult([{ ...row, clear_reason: 'operator' }]));
    const cleared = await clearKnownBadBinding('binding-1', 'operator');
    expect(cleared?.clear_reason).toBe('operator');
  });

  test('clears by fire reprobe reason', async () => {
    mockQuery.mockResolvedValueOnce(createQueryResult([{ ...row, clear_reason: 'fire_reprobe' }]));
    const cleared = await clearKnownBadBinding('binding-1', 'fire_reprobe');
    expect(cleared?.clear_reason).toBe('fire_reprobe');
  });

  test('increments hit count for still-bad fire reprobe', async () => {
    mockQuery.mockResolvedValueOnce(createQueryResult([{ ...row, hit_count: 2 }]));
    const updated = await incrementKnownBadBindingHit('binding-1');
    expect(updated?.hit_count).toBe(2);
  });
});
