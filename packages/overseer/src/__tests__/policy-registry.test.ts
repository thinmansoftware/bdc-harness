import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  computePolicyTupleDigest,
  findMergePolicyTuple,
  jcsSerialize,
  loadOverseerActionPolicyRegistry,
  POLICY_TUPLE_DOMAIN,
  PolicyRegistryError,
  type OverseerActionPolicyRegistry,
} from '../policy-registry';

const SYNTHETIC_PATH = fileURLToPath(
  new URL('./fixtures/overseer-action-policy.synthetic.json', import.meta.url)
);
const SHIPPED_PATH = fileURLToPath(
  new URL('../../../../.archon/policies/overseer-action-policy.json', import.meta.url)
);

interface TupleInput {
  owner: string;
  repository: string;
  base_branch: string;
  resulting_deployment_effect: string;
  allowed_action_kinds: string[];
  credential_principal: string;
}

const BASE_TUPLE: TupleInput = {
  owner: 'thinmansoftware',
  repository: 'bdc-harness',
  base_branch: 'dev',
  resulting_deployment_effect: 'none',
  allowed_action_kinds: ['MERGE'],
  credential_principal: 'overseer-fake-merge-principal',
};

function validDigest(tuple: TupleInput): string {
  return computePolicyTupleDigest({
    owner: tuple.owner,
    repository: tuple.repository,
    base_branch: tuple.base_branch,
    resulting_deployment_effect: tuple.resulting_deployment_effect as never,
    allowed_action_kinds: tuple.allowed_action_kinds,
    credential_principal: tuple.credential_principal,
  });
}

function entry(tuple: TupleInput, digest = validDigest(tuple)): Record<string, unknown> {
  return { ...tuple, policy_digest: digest };
}

function registryText(entries: Record<string, unknown>[]): string {
  return JSON.stringify({ schema_version: 'overseer-action-policy-v1', entries });
}

function reasonOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof PolicyRegistryError) return error.reason;
    return `unexpected:${(error as Error).message}`;
  }
  return 'did_not_throw';
}

describe('policy-registry loader', () => {
  test('shipped registry loads and validates its one live entry', () => {
    const text = readFileSync(SHIPPED_PATH, 'utf8');
    const registry = loadOverseerActionPolicyRegistry({ text });
    expect(registry.schema_version).toBe('overseer-action-policy-v1');
    // Populated 2026-07-20 with the first real entry (bdc-harness/dev, MERGE,
    // staging effect only) -- the registry is no longer intentionally empty.
    // If this assertion needs to change again, verify the new entry validates
    // (schema, digest, effect scope) rather than just bumping the count.
    expect(registry.entries).toHaveLength(1);
    const only = registry.entries[0];
    expect(only?.owner).toBe('thinmansoftware');
    expect(only?.repository).toBe('bdc-harness');
    expect(only?.resulting_deployment_effect).toBe('staging');
    expect(only?.allowed_action_kinds).toEqual(['MERGE']);
  });

  test('valid synthetic registry resolves exactly one allowed tuple', () => {
    const text = readFileSync(SYNTHETIC_PATH, 'utf8');
    const registry = loadOverseerActionPolicyRegistry({ text });
    expect(registry.entries).toHaveLength(1);
    const only = registry.entries[0];
    expect(only?.resulting_deployment_effect).toBe('none');
    expect(only?.allowed_action_kinds).toEqual(['MERGE']);
    // The stored digest equals the recomputed non-self-referential tuple digest.
    expect(only?.policy_digest).toBe(validDigest(BASE_TUPLE));
  });

  test('empty entries array is valid', () => {
    const registry = loadOverseerActionPolicyRegistry({ text: registryText([]) });
    expect(registry.entries).toHaveLength(0);
  });

  test('tuple digest equals SHA-256 of domain bytes plus JCS tuple excluding policy_digest', () => {
    const tuple = {
      owner: BASE_TUPLE.owner,
      repository: BASE_TUPLE.repository,
      base_branch: BASE_TUPLE.base_branch,
      resulting_deployment_effect: BASE_TUPLE.resulting_deployment_effect,
      allowed_action_kinds: ['MERGE'],
      credential_principal: BASE_TUPLE.credential_principal,
    };
    const jcs = jcsSerialize(tuple);
    const expected = createHash('sha256')
      .update(Buffer.concat([Buffer.from(POLICY_TUPLE_DOMAIN, 'utf8'), Buffer.from(jcs, 'utf8')]))
      .digest('hex');
    expect(validDigest(BASE_TUPLE)).toBe(expected);
    // The domain is prepended, not embedded: hashing the JCS alone differs.
    const withoutDomain = createHash('sha256').update(Buffer.from(jcs, 'utf8')).digest('hex');
    expect(validDigest(BASE_TUPLE)).not.toBe(withoutDomain);
  });

  test('malformed JSON fails closed', () => {
    expect(reasonOf(() => loadOverseerActionPolicyRegistry({ text: '{not json' }))).toBe(
      'policy_registry_invalid_json'
    );
  });

  test('unknown top-level field fails closed', () => {
    const text = JSON.stringify({
      schema_version: 'overseer-action-policy-v1',
      entries: [],
      extra: true,
    });
    expect(reasonOf(() => loadOverseerActionPolicyRegistry({ text }))).toBe(
      'policy_registry_unknown_field'
    );
  });

  test('wrong schema version fails closed', () => {
    const text = JSON.stringify({ schema_version: 'v2', entries: [] });
    expect(reasonOf(() => loadOverseerActionPolicyRegistry({ text }))).toBe(
      'policy_registry_schema_version_invalid'
    );
  });

  test('unknown deployment effect fails closed', () => {
    const tuple = { ...BASE_TUPLE, resulting_deployment_effect: 'canary' };
    const text = registryText([entry(tuple, validDigest(tuple))]);
    expect(reasonOf(() => loadOverseerActionPolicyRegistry({ text }))).toBe(
      'policy_entry_effect_unknown'
    );
  });

  test('unknown action kind fails closed', () => {
    const tuple = { ...BASE_TUPLE, allowed_action_kinds: ['LAUNCH_MISSILES'] };
    const text = registryText([entry(tuple, validDigest(tuple))]);
    expect(reasonOf(() => loadOverseerActionPolicyRegistry({ text }))).toBe(
      'policy_entry_action_kind_unknown'
    );
  });

  test('unknown entry field fails closed', () => {
    const raw = entry(BASE_TUPLE);
    raw.smuggled = 'x';
    const text = registryText([raw]);
    expect(reasonOf(() => loadOverseerActionPolicyRegistry({ text }))).toBe(
      'policy_entry_unknown_field'
    );
  });

  test('changed digest fails closed', () => {
    const good = validDigest(BASE_TUPLE);
    const tampered = `${good.slice(0, 63)}${good[63] === 'a' ? 'b' : 'a'}`;
    const text = registryText([entry(BASE_TUPLE, tampered)]);
    expect(reasonOf(() => loadOverseerActionPolicyRegistry({ text }))).toBe(
      'policy_entry_digest_mismatch'
    );
  });

  test('changed file byte in a hashed field fails closed', () => {
    // Digest computed for the base tuple, but a value byte is changed after.
    const text = registryText([
      entry(
        { ...BASE_TUPLE, credential_principal: 'overseer-fake-merge-principaX' },
        validDigest(BASE_TUPLE)
      ),
    ]);
    expect(reasonOf(() => loadOverseerActionPolicyRegistry({ text }))).toBe(
      'policy_entry_digest_mismatch'
    );
  });

  test('self-referential hash fails closed', () => {
    // Digest built over a tuple that (invalidly) includes a policy_digest field.
    const selfTuple = {
      owner: BASE_TUPLE.owner,
      repository: BASE_TUPLE.repository,
      base_branch: BASE_TUPLE.base_branch,
      resulting_deployment_effect: BASE_TUPLE.resulting_deployment_effect,
      allowed_action_kinds: ['MERGE'],
      credential_principal: BASE_TUPLE.credential_principal,
      policy_digest: '',
    };
    const selfDigest = createHash('sha256')
      .update(
        Buffer.concat([
          Buffer.from(POLICY_TUPLE_DOMAIN, 'utf8'),
          Buffer.from(jcsSerialize(selfTuple), 'utf8'),
        ])
      )
      .digest('hex');
    const text = registryText([entry(BASE_TUPLE, selfDigest)]);
    expect(reasonOf(() => loadOverseerActionPolicyRegistry({ text }))).toBe(
      'policy_entry_digest_mismatch'
    );
  });

  test('wrong domain separator fails closed', () => {
    const jcs = jcsSerialize({
      owner: BASE_TUPLE.owner,
      repository: BASE_TUPLE.repository,
      base_branch: BASE_TUPLE.base_branch,
      resulting_deployment_effect: BASE_TUPLE.resulting_deployment_effect,
      allowed_action_kinds: ['MERGE'],
      credential_principal: BASE_TUPLE.credential_principal,
    });
    const wrongDomainDigest = createHash('sha256')
      .update(Buffer.concat([Buffer.from('WRONG_DOMAIN_V9\n', 'utf8'), Buffer.from(jcs, 'utf8')]))
      .digest('hex');
    const text = registryText([entry(BASE_TUPLE, wrongDomainDigest)]);
    expect(reasonOf(() => loadOverseerActionPolicyRegistry({ text }))).toBe(
      'policy_entry_digest_mismatch'
    );
  });

  test('unsorted action kinds fail closed', () => {
    // Two valid kinds preserved in caller order rather than sorted.
    const tuple = { ...BASE_TUPLE, allowed_action_kinds: ['REPAIR', 'MERGE'] };
    const text = registryText([entry(tuple, validDigest(tuple))]);
    expect(reasonOf(() => loadOverseerActionPolicyRegistry({ text }))).toBe(
      'policy_entry_action_kinds_unsorted'
    );
  });

  test('duplicate tuple fails closed', () => {
    const text = registryText([entry(BASE_TUPLE), entry(BASE_TUPLE)]);
    expect(reasonOf(() => loadOverseerActionPolicyRegistry({ text }))).toBe(
      'policy_registry_duplicate_tuple'
    );
  });
});

describe('findMergePolicyTuple', () => {
  function loadSynthetic(): OverseerActionPolicyRegistry {
    return loadOverseerActionPolicyRegistry({ text: readFileSync(SYNTHETIC_PATH, 'utf8') });
  }

  test('resolves the single exact allowed tuple', () => {
    const registry = loadSynthetic();
    const found = findMergePolicyTuple({
      registry,
      owner: 'thinmansoftware',
      repository: 'bdc-harness',
      base_branch: 'dev',
      resulting_deployment_effect: 'none',
      action_kind: 'MERGE',
      credential_principal: 'overseer-fake-merge-principal',
    });
    expect(found).not.toBeNull();
    expect(found?.policy_digest).toBe(validDigest(BASE_TUPLE));
  });

  test('excluded: a non-matching request resolves no tuple', () => {
    const registry = loadSynthetic();
    for (const override of [
      { base_branch: 'main' },
      { resulting_deployment_effect: 'production' as const },
      { credential_principal: 'someone-else' },
      { action_kind: 'REPAIR' as const },
      { repository: 'bdc-xo' },
    ]) {
      const found = findMergePolicyTuple({
        registry,
        owner: 'thinmansoftware',
        repository: 'bdc-harness',
        base_branch: 'dev',
        resulting_deployment_effect: 'none',
        action_kind: 'MERGE',
        credential_principal: 'overseer-fake-merge-principal',
        ...override,
      });
      expect(found).toBeNull();
    }
  });

  test('empty registry resolves no tuple', () => {
    const registry = loadOverseerActionPolicyRegistry({ text: registryText([]) });
    const found = findMergePolicyTuple({
      registry,
      owner: 'thinmansoftware',
      repository: 'bdc-harness',
      base_branch: 'dev',
      resulting_deployment_effect: 'none',
      action_kind: 'MERGE',
      credential_principal: 'overseer-fake-merge-principal',
    });
    expect(found).toBeNull();
  });
});
