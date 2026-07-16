/**
 * Content-addressed Overseer action-policy registry (M-42 Slice 7).
 *
 * The registry is a versioned Git artifact whose entries authorize a single
 * exact (owner, repository, base_branch, resulting_deployment_effect,
 * allowed_action_kinds, credential_principal) tuple. Each entry carries a
 * non-self-referential `policy_digest`: the lower-case hex SHA-256 of the exact
 * UTF-8 domain bytes `BDC_OVERSEER_ACTION_POLICY_TUPLE_V1\n` prepended to the
 * RFC 8785 (JCS) serialization of the tuple object -- with `policy_digest`
 * itself OMITTED, `allowed_action_kinds` sorted and deduplicated.
 *
 * Loading fails closed: any malformed field, unknown field, unknown effect,
 * unsorted/duplicated action list, duplicate tuple, or digest that does not
 * exactly equal the recomputed value throws. The registry never performs I/O
 * beyond the caller-supplied raw text; the file bytes are read by the caller.
 *
 * The Git object format, Git blob OID, and raw-file SHA-256 are file-level
 * identities recorded OUTSIDE the registry (proposal + manifest). They are never
 * stored inside the file and never enter an entry tuple digest.
 */
import { createHash } from 'node:crypto';
import { M31_ACTION_KINDS, type M31ActionKind } from '@archon/core/db/merge-steward';

/** Exact UTF-8 domain separator prepended to the JCS tuple bytes before hashing. */
export const POLICY_TUPLE_DOMAIN = 'BDC_OVERSEER_ACTION_POLICY_TUPLE_V1\n';

/** Stable identifier for the tuple-digest algorithm, frozen in the manifest. */
export const POLICY_TUPLE_ALGORITHM = 'sha256-domain-jcs-rfc8785-v1' as const;

/** Exact schema tag the registry file must declare. */
export const POLICY_REGISTRY_SCHEMA_VERSION = 'overseer-action-policy-v1' as const;

const DEPLOYMENT_EFFECTS = ['none', 'staging', 'production', 'unknown'] as const;
export type OverseerDeploymentEffect = (typeof DEPLOYMENT_EFFECTS)[number];

const ACTION_KIND_SET: ReadonlySet<string> = new Set(M31_ACTION_KINDS as readonly string[]);
const EFFECT_SET: ReadonlySet<string> = new Set(DEPLOYMENT_EFFECTS as readonly string[]);
const HEX64_RE = /^[0-9a-f]{64}$/;

const ENTRY_KEYS = [
  'owner',
  'repository',
  'base_branch',
  'resulting_deployment_effect',
  'allowed_action_kinds',
  'credential_principal',
  'policy_digest',
] as const;

const REGISTRY_KEYS = ['schema_version', 'entries'] as const;

/** A single fully-validated policy entry. */
export interface OverseerActionPolicyEntry {
  readonly owner: string;
  readonly repository: string;
  readonly base_branch: string;
  readonly resulting_deployment_effect: OverseerDeploymentEffect;
  readonly allowed_action_kinds: readonly M31ActionKind[];
  readonly credential_principal: string;
  readonly policy_digest: string;
}

/** The validated registry. */
export interface OverseerActionPolicyRegistry {
  readonly schema_version: typeof POLICY_REGISTRY_SCHEMA_VERSION;
  readonly entries: readonly OverseerActionPolicyEntry[];
}

/** Content used to derive a tuple digest (the non-self-referential subset). */
export interface PolicyTupleFields {
  readonly owner: string;
  readonly repository: string;
  readonly base_branch: string;
  readonly resulting_deployment_effect: OverseerDeploymentEffect;
  readonly allowed_action_kinds: readonly string[];
  readonly credential_principal: string;
}

/** Thrown for every fail-closed validation error; `reason` is a stable code. */
export class PolicyRegistryError extends Error {
  readonly reason: string;
  constructor(reason: string, detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'PolicyRegistryError';
    this.reason = reason;
  }
}

/**
 * RFC 8785 (JCS) serialization restricted to the value shapes this registry uses
 * (strings, arrays of strings, and flat string-keyed objects). Object keys are
 * emitted in ascending UTF-16 code-unit order; strings use JSON.stringify, which
 * matches JCS minimal escaping for the ASCII content used here.
 */
export function jcsSerialize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new PolicyRegistryError('policy_tuple_non_finite_number');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(jcsSerialize).join(',')}]`;
  }
  if (typeof value === 'object') {
    const pairs = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0
    );
    return `{${pairs.map(([k, v]) => `${JSON.stringify(k)}:${jcsSerialize(v)}`).join(',')}}`;
  }
  throw new PolicyRegistryError('policy_tuple_uncanonicalizable');
}

/** Sort ascending by code unit and drop exact duplicates. */
function sortDedupe(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

/**
 * Compute the non-self-referential tuple digest: SHA-256 over the exact UTF-8
 * domain bytes prepended to the JCS serialization of the tuple object with
 * `policy_digest` omitted and `allowed_action_kinds` sorted + deduplicated.
 */
export function computePolicyTupleDigest(fields: PolicyTupleFields): string {
  const tuple = {
    owner: fields.owner,
    repository: fields.repository,
    base_branch: fields.base_branch,
    resulting_deployment_effect: fields.resulting_deployment_effect,
    allowed_action_kinds: sortDedupe(fields.allowed_action_kinds),
    credential_principal: fields.credential_principal,
  };
  const canonical = jcsSerialize(tuple);
  const bytes = Buffer.concat([
    Buffer.from(POLICY_TUPLE_DOMAIN, 'utf8'),
    Buffer.from(canonical, 'utf8'),
  ]);
  return createHash('sha256').update(bytes).digest('hex');
}

function assertString(value: unknown, reason: string, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new PolicyRegistryError(reason, field);
  }
  return value;
}

function validateEntry(raw: unknown, index: number): OverseerActionPolicyEntry {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PolicyRegistryError('policy_entry_not_object', `entries[${index}]`);
  }
  const entry = raw as Record<string, unknown>;
  for (const key of Object.keys(entry)) {
    if (!(ENTRY_KEYS as readonly string[]).includes(key)) {
      throw new PolicyRegistryError('policy_entry_unknown_field', `entries[${index}].${key}`);
    }
  }

  const owner = assertString(entry.owner, 'policy_entry_owner_invalid', `entries[${index}]`);
  const repository = assertString(
    entry.repository,
    'policy_entry_repository_invalid',
    `entries[${index}]`
  );
  const baseBranch = assertString(
    entry.base_branch,
    'policy_entry_base_branch_invalid',
    `entries[${index}]`
  );
  const effect = assertString(
    entry.resulting_deployment_effect,
    'policy_entry_effect_invalid',
    `entries[${index}]`
  );
  if (!EFFECT_SET.has(effect)) {
    throw new PolicyRegistryError('policy_entry_effect_unknown', `entries[${index}]:${effect}`);
  }
  const credentialPrincipal = assertString(
    entry.credential_principal,
    'policy_entry_credential_principal_invalid',
    `entries[${index}]`
  );

  const actionKinds = entry.allowed_action_kinds;
  if (!Array.isArray(actionKinds) || actionKinds.length === 0) {
    throw new PolicyRegistryError('policy_entry_action_kinds_invalid', `entries[${index}]`);
  }
  for (const kind of actionKinds) {
    if (typeof kind !== 'string' || !ACTION_KIND_SET.has(kind)) {
      throw new PolicyRegistryError(
        'policy_entry_action_kind_unknown',
        `entries[${index}]:${String(kind)}`
      );
    }
  }
  const kinds = actionKinds as string[];
  // Reject caller-preserved order or duplicates: the stored list must already be
  // sorted + deduplicated, matching the exact bytes the tuple digest is built on.
  const canonicalKinds = sortDedupe(kinds);
  if (
    canonicalKinds.length !== kinds.length ||
    canonicalKinds.some((value, position) => value !== kinds[position])
  ) {
    throw new PolicyRegistryError('policy_entry_action_kinds_unsorted', `entries[${index}]`);
  }

  const policyDigest = assertString(
    entry.policy_digest,
    'policy_entry_policy_digest_invalid',
    `entries[${index}]`
  );
  if (!HEX64_RE.test(policyDigest)) {
    throw new PolicyRegistryError('policy_entry_policy_digest_malformed', `entries[${index}]`);
  }

  const fields: PolicyTupleFields = {
    owner,
    repository,
    base_branch: baseBranch,
    resulting_deployment_effect: effect as OverseerDeploymentEffect,
    allowed_action_kinds: canonicalKinds,
    credential_principal: credentialPrincipal,
  };
  const expectedDigest = computePolicyTupleDigest(fields);
  if (expectedDigest !== policyDigest) {
    throw new PolicyRegistryError('policy_entry_digest_mismatch', `entries[${index}]`);
  }

  return {
    owner,
    repository,
    base_branch: baseBranch,
    resulting_deployment_effect: effect as OverseerDeploymentEffect,
    allowed_action_kinds: canonicalKinds as M31ActionKind[],
    credential_principal: credentialPrincipal,
    policy_digest: policyDigest,
  };
}

export interface LoadPolicyRegistryInput {
  /** Exact raw file bytes as UTF-8 text. */
  readonly text: string;
}

/**
 * Parse and fully validate the registry text. Throws {@link PolicyRegistryError}
 * on any schema, digest, ordering, or duplicate-tuple violation.
 */
export function loadOverseerActionPolicyRegistry(
  input: LoadPolicyRegistryInput
): OverseerActionPolicyRegistry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.text);
  } catch {
    throw new PolicyRegistryError('policy_registry_invalid_json');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PolicyRegistryError('policy_registry_not_object');
  }
  const registry = parsed as Record<string, unknown>;
  for (const key of Object.keys(registry)) {
    if (!(REGISTRY_KEYS as readonly string[]).includes(key)) {
      throw new PolicyRegistryError('policy_registry_unknown_field', key);
    }
  }
  if (registry.schema_version !== POLICY_REGISTRY_SCHEMA_VERSION) {
    throw new PolicyRegistryError('policy_registry_schema_version_invalid');
  }
  if (!Array.isArray(registry.entries)) {
    throw new PolicyRegistryError('policy_registry_entries_invalid');
  }

  const entries = registry.entries.map((entry, index) => validateEntry(entry, index));

  const digests = new Set<string>();
  for (const entry of entries) {
    if (digests.has(entry.policy_digest)) {
      throw new PolicyRegistryError('policy_registry_duplicate_tuple', entry.policy_digest);
    }
    digests.add(entry.policy_digest);
  }

  return {
    schema_version: POLICY_REGISTRY_SCHEMA_VERSION,
    entries,
  };
}

export interface FindMergePolicyTupleInput {
  readonly registry: OverseerActionPolicyRegistry;
  readonly owner: string;
  readonly repository: string;
  readonly base_branch: string;
  readonly resulting_deployment_effect: OverseerDeploymentEffect;
  readonly action_kind: M31ActionKind;
  readonly credential_principal: string;
}

/**
 * Resolve the single entry whose exact tuple authorizes this request, or null.
 * Match is exact on owner, repository, base_branch, effect, and credential
 * principal, and the requested action kind must be listed in the entry. Because
 * duplicate tuples are rejected at load time, at most one entry can match.
 */
export function findMergePolicyTuple(
  input: FindMergePolicyTupleInput
): OverseerActionPolicyEntry | null {
  const matches = input.registry.entries.filter(
    entry =>
      entry.owner === input.owner &&
      entry.repository === input.repository &&
      entry.base_branch === input.base_branch &&
      entry.resulting_deployment_effect === input.resulting_deployment_effect &&
      entry.credential_principal === input.credential_principal &&
      entry.allowed_action_kinds.includes(input.action_kind)
  );
  if (matches.length !== 1) return null;
  return matches[0] ?? null;
}
