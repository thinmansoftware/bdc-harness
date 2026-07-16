import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { unlinkSync } from 'fs';
import { join } from 'path';
import { SqliteAdapter } from '@archon/core/db/adapters/sqlite';
import { installOverseerControlPlaneSqlite } from '@archon/core/db/overseer-control-plane-sqlite';
import { canonicalJson } from '@archon/core/db/overseer-control-plane';
import {
  createOverseerControlPlaneService,
  computeVerifierRegistryDigest,
  type OverseerControlPlaneService,
} from '../control-plane';

let db: SqliteAdapter;
let dbPath = '';
let service: OverseerControlPlaneService;

beforeEach(async () => {
  dbPath = join(process.cwd(), `.ocp-svc-${crypto.randomUUID()}.db`);
  db = new SqliteAdapter(dbPath);
  await installOverseerControlPlaneSqlite(db);
  service = createOverseerControlPlaneService(db);
});

afterEach(async () => {
  await db.close();
  for (const suffix of ['', '-wal', '-shm'])
    try {
      unlinkSync(dbPath + suffix);
    } catch {
      /* absent */
    }
});

const REVIEWER = 'REVIEWER' as const;

async function register(
  entries: Array<{
    verifier_id: string;
    provider: string;
    model_family: string;
    roles: Array<'REVIEWER' | 'RED_TEAM' | 'FUSION' | 'MERGE_STEWARD'>;
    enabled: boolean;
  }>,
  overrides: Partial<{
    registry_digest: string;
    source_git_blob: string;
    source_artifact_path: string;
  }> = {}
) {
  const digest = overrides.registry_digest ?? computeVerifierRegistryDigest(entries);
  return {
    digest,
    result: await service.registerVerifierRegistry({
      schema_version: 'overseer-verifier-registry-v1',
      registry_digest: digest,
      entries,
      source_artifact_path: overrides.source_artifact_path ?? 'docs/verifiers.json',
      source_git_blob: overrides.source_git_blob ?? 'blob-1',
      actor: 'xo',
    }),
  };
}

describe('overseer control-plane service', () => {
  test('verifier registry canonicalization and independence fail closed', async () => {
    const entries = [
      {
        verifier_id: 'gpt-5',
        provider: 'openai',
        model_family: 'gpt',
        roles: [REVIEWER],
        enabled: true,
      },
      {
        verifier_id: 'grok-4',
        provider: 'xai',
        model_family: 'grok',
        roles: [REVIEWER, 'RED_TEAM' as const],
        enabled: true,
      },
      {
        verifier_id: 'sonnet',
        provider: 'anthropic',
        model_family: 'claude',
        roles: ['MERGE_STEWARD' as const],
        enabled: false,
      },
    ];

    // Known-answer digest vector: independent of input order (entries sort by id).
    const shuffled = [entries[2]!, entries[0]!, entries[1]!];
    const expectedDigest = createHash('sha256')
      .update(
        `overseer-verifier-registry-v1\n${canonicalJson({
          schema_version: 'overseer-verifier-registry-v1',
          entries: [
            {
              enabled: true,
              model_family: 'gpt',
              provider: 'openai',
              roles: ['REVIEWER'],
              verifier_id: 'gpt-5',
            },
            {
              enabled: true,
              model_family: 'grok',
              provider: 'xai',
              roles: ['RED_TEAM', 'REVIEWER'],
              verifier_id: 'grok-4',
            },
            {
              enabled: false,
              model_family: 'claude',
              provider: 'anthropic',
              roles: ['MERGE_STEWARD'],
              verifier_id: 'sonnet',
            },
          ],
        })}`,
        'utf8'
      )
      .digest('hex');
    expect(computeVerifierRegistryDigest(shuffled)).toBe(expectedDigest);
    expect(computeVerifierRegistryDigest(entries)).toBe(expectedDigest);

    const { digest } = await register(entries);
    expect(digest).toBe(expectedDigest);

    // Provenance drift on the same digest -> conflict.
    const conflict = await register(entries, {
      registry_digest: digest,
      source_git_blob: 'other-blob',
    });
    expect(conflict.result).toEqual({ ok: false, code: 'registry_digest_conflict' });

    // Exact replay appends no second REGISTRY_FROZEN event.
    expect((await register(entries)).result.ok).toBe(true);
    const frozen = (
      await service.listControlEvents({ resource_kind: 'VERIFIER_REGISTRY', resource_key: digest })
    ).filter(e => e.event_kind === 'REGISTRY_FROZEN');
    expect(frozen).toHaveLength(1);

    // Missing registry -> verifier_registry_missing.
    expect(
      await service.assertIndependentVerifier({
        operator_provider: 'openai',
        operator_model_family: 'gpt',
        registry_digest: 'a'.repeat(64),
        verifier_id: 'grok-4',
        required_role: REVIEWER,
      })
    ).toEqual({ ok: false, code: 'verifier_registry_missing' });

    // Unknown verifier.
    expect(
      await service.assertIndependentVerifier({
        operator_provider: 'openai',
        operator_model_family: 'gpt',
        registry_digest: digest,
        verifier_id: 'nobody',
        required_role: REVIEWER,
      })
    ).toEqual({ ok: false, code: 'verifier_unknown' });

    // Disabled verifier fails closed.
    expect(
      await service.assertIndependentVerifier({
        operator_provider: 'openai',
        operator_model_family: 'gpt',
        registry_digest: digest,
        verifier_id: 'sonnet',
        required_role: 'MERGE_STEWARD',
      })
    ).toEqual({ ok: false, code: 'verifier_disabled' });

    // Role mismatch.
    expect(
      await service.assertIndependentVerifier({
        operator_provider: 'openai',
        operator_model_family: 'gpt',
        registry_digest: digest,
        verifier_id: 'grok-4',
        required_role: 'FUSION',
      })
    ).toEqual({ ok: false, code: 'verifier_role_mismatch' });

    // Grok verifying Grok: shared provider AND family -> not independent.
    expect(
      await service.assertIndependentVerifier({
        operator_provider: 'xai',
        operator_model_family: 'grok',
        registry_digest: digest,
        verifier_id: 'grok-4',
        required_role: REVIEWER,
      })
    ).toEqual({ ok: false, code: 'verifier_not_independent' });

    // Shared family only -> not independent.
    expect(
      await service.assertIndependentVerifier({
        operator_provider: 'openrouter',
        operator_model_family: 'grok',
        registry_digest: digest,
        verifier_id: 'grok-4',
        required_role: REVIEWER,
      })
    ).toEqual({ ok: false, code: 'verifier_not_independent' });

    // Different provider AND different family with the required role -> allowed.
    const allowed = await service.assertIndependentVerifier({
      operator_provider: 'openai',
      operator_model_family: 'gpt',
      registry_digest: digest,
      verifier_id: 'grok-4',
      required_role: REVIEWER,
    });
    expect(allowed.ok).toBe(true);
    if (allowed.ok) expect(allowed.value.allowed).toBe(true);
  });

  test('service binds parent admission and Fusion lifecycle to the injected database', async () => {
    const admitted = await service.admitParent({
      parent_id: 'svc-parent',
      owner_id: 'owner',
      correlation_id: 'corr',
      state: 'BUILDING',
      actor: 'xo',
    });
    expect(admitted.ok).toBe(true);
    if (admitted.ok) expect(admitted.value.fencing_token).toBe(1);

    const reserved = await service.reserveFusionBudget({
      reservation_id: 'svc-res',
      call_id: 'svc-call',
      proposal_id: 'p',
      execution_id: 'e',
      provider: 'xai',
      model: 'grok-4',
      call_kind: 'PRIMARY',
      requested_microusd: 1000,
      actor: 'xo',
    });
    expect(reserved.ok).toBe(true);
    // Over-cap release reason is rejected without touching the row.
    const badRelease = await service.releaseFusionBudgetReservation({
      reservation_id: 'svc-res',
      call_id: 'svc-call',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      release_reason: 'not_a_reason' as any,
      actor: 'xo',
    });
    expect(badRelease).toEqual({ ok: false, code: 'budget_transition_invalid' });
  });
});
