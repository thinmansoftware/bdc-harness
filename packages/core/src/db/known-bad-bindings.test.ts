import { beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'crypto';
import { resetDatabase } from './connection';
import {
  clearKnownBadBinding,
  getActiveKnownBadBinding,
  upsertKnownBadBinding,
} from './known-bad-bindings';

const input = {
  binding_key: 'binding-1',
  provider_id: 'codex-opr',
  model_id: 'qwen/qwen3-coder',
  auth_context_id: 'codex:chatgpt-account',
  assistant_config_hash: 'assistant-hash',
  node_override_hash: '',
  error_class: 'structural_model_not_supported',
  http_status: 400,
  error_body_excerpt: 'The qwen/qwen3-coder model is not supported when using Codex with a ChatGPT account.',
  source: 'fire_time_probe',
};

function withKey(binding_key: string): typeof input {
  return { ...input, binding_key: `${binding_key}-${randomUUID()}` };
}

beforeEach(() => {
  resetDatabase();
});

describe('known bad bindings persistence', () => {
  test('inserts and looks up active rows', async () => {
    const data = withKey('binding-insert');
    const row = await upsertKnownBadBinding(data);
    expect(row.binding_key).toBe(data.binding_key);
    expect(row.hit_count).toBe(1);

    const active = await getActiveKnownBadBinding(data.binding_key);
    expect(active?.id).toBe(row.id);
  });

  test('upsert reactivates and increments an existing row', async () => {
    const data = withKey('binding-upsert');
    await upsertKnownBadBinding(data);
    const second = await upsertKnownBadBinding({ ...data, error_body_excerpt: 'still unsupported' });
    expect(second.hit_count).toBe(2);
    expect(second.cleared_at).toBeNull();
    expect(second.error_body_excerpt).toBe('still unsupported');
  });

  test('clears by operator reason', async () => {
    const data = withKey('binding-operator-clear');
    await upsertKnownBadBinding(data);
    const cleared = await clearKnownBadBinding(data.binding_key, 'operator');
    expect(cleared?.clear_reason).toBe('operator');
    expect(cleared?.cleared_at).toBeTruthy();
    expect(await getActiveKnownBadBinding(data.binding_key)).toBeNull();
  });

  test('clears by fire_reprobe reason', async () => {
    const data = withKey('binding-fire-clear');
    await upsertKnownBadBinding(data);
    const cleared = await clearKnownBadBinding(data.binding_key, 'fire_reprobe');
    expect(cleared?.clear_reason).toBe('fire_reprobe');
    expect(cleared?.cleared_at).toBeTruthy();
    expect(await getActiveKnownBadBinding(data.binding_key)).toBeNull();
  });
});
