/**
 * Recovery-scoped execution claims.
 *
 * Additive sibling to the board production-deploy execution claim ledger. This
 * keeps the same fenced acquire/takeover/complete/release shape while using a
 * recovery actor model instead of XO lease and canonical board-motion authority.
 */
import { createHash, randomUUID } from 'crypto';
import { getDatabase } from './connection';
import type { IDatabase } from './adapters/types';

const DEFAULT_LEASE_DURATION_MS = 5 * 60 * 1000;

type TxQuery = Parameters<Parameters<IDatabase['withTransaction']>[0]>[0];

export type RecoveryExecutionActorKind = 'overseer' | 'conductor' | 'manual';
export type RecoveryExecutionClaimFailureCode =
  | 'validation_failed'
  | 'claim_conflict'
  | 'stale_fence'
  | 'not_found';
export type RecoveryExecutionClaimAcquireOutcome = 'acquired' | 'taken_over' | 'reactivated';

export interface RecoveryExecutionClaimIdentity {
  readonly repository: string;
  readonly wo_id: string;
  readonly source_run_id: string | null;
  readonly target_digest: string;
  readonly scope_digest: string;
}

export interface RecoveryExecutionClaimResponse extends RecoveryExecutionClaimIdentity {
  readonly claim_id: string;
  readonly action_key: string;
  readonly actor_id: string;
  readonly actor_kind: RecoveryExecutionActorKind;
  readonly execution_fencing_token: number;
  readonly status: 'active' | 'released' | 'completed';
  readonly effect_attempt_id: string | null;
  readonly effect_attempt_state: 'none' | 'armed' | 'completed' | 'released';
  readonly acquired_at: string;
  readonly renewed_at: string | null;
  readonly expires_at: string;
  readonly released_at: string | null;
  readonly completed_at: string | null;
  readonly external_effect_reference: string | null;
  readonly completion_evidence: Record<string, unknown> | null;
}

interface RecoveryExecutionClaimRow {
  readonly claim_id: string;
  readonly repository: string;
  readonly wo_id: string;
  readonly source_run_id: string | null;
  readonly target_digest: string;
  readonly scope_digest: string;
  readonly action_key: string;
  readonly actor_id: string;
  readonly actor_kind: RecoveryExecutionActorKind;
  readonly execution_fencing_token: number | string;
  readonly status: 'active' | 'released' | 'completed';
  readonly effect_attempt_id: string | null;
  readonly effect_attempt_state: 'none' | 'armed' | 'completed' | 'released';
  readonly acquired_at: string;
  readonly renewed_at: string | null;
  readonly expires_at: string;
  readonly released_at: string | null;
  readonly completed_at: string | null;
  readonly external_effect_reference: string | null;
  readonly completion_evidence_json: string | Record<string, unknown> | null;
}

export type AcquireRecoveryExecutionClaimResult =
  | {
      readonly ok: true;
      readonly claim: RecoveryExecutionClaimResponse;
      readonly created: boolean;
      readonly outcome: RecoveryExecutionClaimAcquireOutcome;
    }
  | {
      readonly ok: false;
      readonly code: RecoveryExecutionClaimFailureCode;
      readonly message: string;
      readonly holder: RecoveryExecutionClaimHolder | null;
    };

export interface RecoveryExecutionClaimHolder {
  readonly claim_id: string;
  readonly actor_id: string;
  readonly actor_kind: RecoveryExecutionActorKind;
  readonly execution_fencing_token: number;
  readonly expires_at: string;
}

export interface AcquireRecoveryExecutionClaimInput extends RecoveryExecutionClaimIdentity {
  readonly actor_id: string;
  readonly actor_kind: RecoveryExecutionActorKind;
  readonly lease_duration_ms?: number;
}

export type RecoveryExecutionClaimMutationResult =
  | { readonly ok: true; readonly claim: RecoveryExecutionClaimResponse }
  | { readonly ok: false; readonly code: RecoveryExecutionClaimFailureCode; readonly message: string };

export type ValidateRecoveryExecutionFenceResult =
  | {
      readonly ok: true;
      readonly claim_id: string;
      readonly effect_attempt_id: string;
      readonly execution_fencing_token: number;
    }
  | { readonly ok: false; readonly code: RecoveryExecutionClaimFailureCode; readonly message: string };

export interface RecoveryExecutionFenceInput {
  readonly claim_id: string;
  readonly execution_fencing_token: number;
  readonly actor_id: string;
  readonly actor_kind: RecoveryExecutionActorKind;
}

export interface CompleteRecoveryExecutionClaimInput extends RecoveryExecutionFenceInput {
  readonly effect_attempt_id: string;
  readonly external_effect_reference: string | null;
  readonly evidence: Record<string, unknown>;
}

export interface ReleaseRecoveryExecutionClaimInput extends RecoveryExecutionFenceInput {
  readonly reason: string;
}

interface RecoveryExecutionClaimEventInput {
  readonly claim_id: string;
  readonly event_type: string;
  readonly actor_id: string;
  readonly actor_kind: RecoveryExecutionActorKind;
  readonly execution_fencing_token?: number | null;
  readonly details?: Record<string, unknown>;
}

function toNumber(value: number | string): number {
  return typeof value === 'number' ? value : Number(value);
}

function parseJson(value: string | Record<string, unknown> | null): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function normalizeClaim(row: RecoveryExecutionClaimRow): RecoveryExecutionClaimResponse {
  return {
    claim_id: row.claim_id,
    repository: row.repository,
    wo_id: row.wo_id,
    source_run_id: row.source_run_id,
    target_digest: row.target_digest,
    scope_digest: row.scope_digest,
    action_key: row.action_key,
    actor_id: row.actor_id,
    actor_kind: row.actor_kind,
    execution_fencing_token: toNumber(row.execution_fencing_token),
    status: row.status,
    effect_attempt_id: row.effect_attempt_id,
    effect_attempt_state: row.effect_attempt_state,
    acquired_at: row.acquired_at,
    renewed_at: row.renewed_at,
    expires_at: row.expires_at,
    released_at: row.released_at,
    completed_at: row.completed_at,
    external_effect_reference: row.external_effect_reference,
    completion_evidence: parseJson(row.completion_evidence_json),
  };
}

function holder(row: RecoveryExecutionClaimRow): RecoveryExecutionClaimHolder {
  return {
    claim_id: row.claim_id,
    actor_id: row.actor_id,
    actor_kind: row.actor_kind,
    execution_fencing_token: toNumber(row.execution_fencing_token),
    expires_at: row.expires_at,
  };
}

async function txNow(query: TxQuery): Promise<string> {
  const dialect = getDatabase().dialect;
  const sql =
    dialect === 'sqlite'
      ? "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now"
      : 'SELECT to_char(clock_timestamp() AT TIME ZONE \'UTC\', \'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"\') AS now';
  const result = await query<{ now: string }>(sql);
  return result.rows[0]?.now ?? new Date().toISOString();
}

function addMillisecondsIso(baseIso: string, ms: number): string {
  return new Date(new Date(baseIso).getTime() + ms).toISOString();
}

function assertIdentity(input: RecoveryExecutionClaimIdentity): void {
  if (input.repository.length === 0) throw new Error('repository is required');
  if (input.wo_id.length === 0) throw new Error('wo_id is required');
  if (input.target_digest.length === 0) throw new Error('target_digest is required');
  if (input.scope_digest.length === 0) throw new Error('scope_digest is required');
}

export function computeRecoveryExecutionClaimKey(
  identity: RecoveryExecutionClaimIdentity
): string {
  assertIdentity(identity);
  const canonical = JSON.stringify({
    repository: identity.repository,
    wo_id: identity.wo_id,
    source_run_id: identity.source_run_id,
    target_digest: identity.target_digest,
    scope_digest: identity.scope_digest,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

async function selectClaimByActionKey(
  query: TxQuery,
  actionKey: string
): Promise<RecoveryExecutionClaimRow | undefined> {
  const result = await query<RecoveryExecutionClaimRow>(
    'SELECT * FROM remote_agent_recovery_execution_claims WHERE action_key = $1',
    [actionKey]
  );
  return result.rows[0];
}

async function selectClaimById(
  query: TxQuery,
  claimId: string
): Promise<RecoveryExecutionClaimRow | undefined> {
  const result = await query<RecoveryExecutionClaimRow>(
    'SELECT * FROM remote_agent_recovery_execution_claims WHERE claim_id = $1',
    [claimId]
  );
  return result.rows[0];
}

async function appendClaimEventWithQuery(
  query: TxQuery,
  input: RecoveryExecutionClaimEventInput,
  now: string
): Promise<void> {
  const seqResult = await query<{ next: number | string }>(
    'SELECT COALESCE(MAX(event_sequence), 0) + 1 AS next FROM remote_agent_recovery_execution_claim_events WHERE claim_id = $1',
    [input.claim_id]
  );
  const nextSeq = toNumber(seqResult.rows[0]?.next ?? 1);
  await query(
    `INSERT INTO remote_agent_recovery_execution_claim_events (
       event_id, claim_id, event_sequence, event_type, actor_id, actor_kind,
       execution_fencing_token, details_json, created_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      randomUUID(),
      input.claim_id,
      nextSeq,
      input.event_type,
      input.actor_id,
      input.actor_kind,
      input.execution_fencing_token ?? null,
      JSON.stringify(input.details ?? {}),
      now,
    ]
  );
}

export async function acquireRecoveryExecutionClaim(
  input: AcquireRecoveryExecutionClaimInput
): Promise<AcquireRecoveryExecutionClaimResult> {
  assertIdentity(input);
  if (input.actor_id.length === 0) throw new Error('actor_id is required');

  const actionKey = computeRecoveryExecutionClaimKey(input);
  const db = getDatabase();
  return db.withTransaction(async query => {
    const now = await txNow(query);
    const expiresAt = addMillisecondsIso(now, input.lease_duration_ms ?? DEFAULT_LEASE_DURATION_MS);
    const existing = await selectClaimByActionKey(query, actionKey);

    if (existing) {
      if (existing.status === 'completed') {
        return {
          ok: false as const,
          code: 'claim_conflict' as const,
          message: 'claim_completed',
          holder: holder(existing),
        };
      }

      if (existing.status === 'active' && existing.expires_at > now) {
        await appendClaimEventWithQuery(
          query,
          {
            claim_id: existing.claim_id,
            event_type: 'claim_conflict',
            actor_id: input.actor_id,
            actor_kind: input.actor_kind,
            execution_fencing_token: toNumber(existing.execution_fencing_token),
            details: { holder: holder(existing) },
          },
          now
        );
        return {
          ok: false as const,
          code: 'claim_conflict' as const,
          message: 'claim_conflict',
          holder: holder(existing),
        };
      }

      const nextToken = toNumber(existing.execution_fencing_token) + 1;
      const nextStatus = existing.status === 'released' ? 'reactivated' : 'taken_over';
      await query(
        `UPDATE remote_agent_recovery_execution_claims
           SET actor_id = $1, actor_kind = $2, execution_fencing_token = $3,
               status = 'active', effect_attempt_id = NULL, effect_attempt_state = 'none',
               acquired_at = $4, renewed_at = NULL, expires_at = $5,
               released_at = NULL, completed_at = NULL, external_effect_reference = NULL,
               completion_evidence_json = NULL
         WHERE action_key = $6 AND status IN ('active', 'released')
           AND (status = 'released' OR expires_at <= $4)`,
        [input.actor_id, input.actor_kind, nextToken, now, expiresAt, actionKey]
      );
      const row = await selectClaimByActionKey(query, actionKey);
      if (
        !row ||
        row.actor_id !== input.actor_id ||
        toNumber(row.execution_fencing_token) !== nextToken ||
        row.status !== 'active'
      ) {
        return {
          ok: false as const,
          code: 'claim_conflict' as const,
          message: 'claim_conflict',
          holder: row ? holder(row) : null,
        };
      }
      await appendClaimEventWithQuery(
        query,
        {
          claim_id: row.claim_id,
          event_type: nextStatus === 'reactivated' ? 'claim_reactivated' : 'claim_taken_over',
          actor_id: input.actor_id,
          actor_kind: input.actor_kind,
          execution_fencing_token: nextToken,
          details: { outcome: nextStatus },
        },
        now
      );
      return {
        ok: true as const,
        claim: normalizeClaim(row),
        created: true as const,
        outcome: nextStatus,
      };
    }

    const claimId = randomUUID();
    await query(
      `INSERT INTO remote_agent_recovery_execution_claims (
         claim_id, repository, wo_id, source_run_id, target_digest, scope_digest,
         action_key, actor_id, actor_kind, execution_fencing_token, status,
         effect_attempt_id, effect_attempt_state, acquired_at, renewed_at, expires_at,
         released_at, completed_at, external_effect_reference, completion_evidence_json
       )
       VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, 1, 'active',
         NULL, 'none', $10, NULL, $11, NULL, NULL, NULL, NULL
       )
       ON CONFLICT (action_key) DO NOTHING`,
      [
        claimId,
        input.repository,
        input.wo_id,
        input.source_run_id,
        input.target_digest,
        input.scope_digest,
        actionKey,
        input.actor_id,
        input.actor_kind,
        now,
        expiresAt,
      ]
    );
    const row = await selectClaimByActionKey(query, actionKey);
    if (row?.claim_id !== claimId) {
      return {
        ok: false as const,
        code: 'claim_conflict' as const,
        message: 'claim_conflict',
        holder: row ? holder(row) : null,
      };
    }
    await appendClaimEventWithQuery(
      query,
      {
        claim_id: claimId,
        event_type: 'claim_acquired',
        actor_id: input.actor_id,
        actor_kind: input.actor_kind,
        execution_fencing_token: 1,
        details: { outcome: 'acquired' },
      },
      now
    );
    return {
      ok: true as const,
      claim: normalizeClaim(row),
      created: true as const,
      outcome: 'acquired' as const,
    };
  });
}

export async function validateRecoveryExecutionFence(
  input: RecoveryExecutionFenceInput
): Promise<ValidateRecoveryExecutionFenceResult> {
  const db = getDatabase();
  return db.withTransaction(async query => {
    const now = await txNow(query);
    const claim = await selectClaimById(query, input.claim_id);
    if (!claim) return { ok: false, code: 'not_found', message: 'claim_not_found' };
    if (claim.status !== 'active') {
      return { ok: false, code: 'stale_fence', message: 'claim_not_active' };
    }
    if (claim.expires_at <= now) {
      return { ok: false, code: 'stale_fence', message: 'claim_expired' };
    }
    if (toNumber(claim.execution_fencing_token) !== input.execution_fencing_token) {
      return { ok: false, code: 'stale_fence', message: 'stale_execution_fence' };
    }
    if (claim.actor_id !== input.actor_id || claim.actor_kind !== input.actor_kind) {
      return { ok: false, code: 'stale_fence', message: 'actor_mismatch' };
    }
    if (claim.effect_attempt_state !== 'none') {
      return { ok: false, code: 'validation_failed', message: 'effect_already_armed' };
    }

    const effectAttemptId = randomUUID();
    await query(
      `UPDATE remote_agent_recovery_execution_claims
         SET effect_attempt_id = $1, effect_attempt_state = 'armed'
       WHERE claim_id = $2 AND status = 'active' AND execution_fencing_token = $3
         AND effect_attempt_state = 'none'`,
      [effectAttemptId, input.claim_id, input.execution_fencing_token]
    );
    const row = await selectClaimById(query, input.claim_id);
    if (row?.effect_attempt_id !== effectAttemptId || row.effect_attempt_state !== 'armed') {
      return { ok: false, code: 'validation_failed', message: 'arm_conflict' };
    }
    await appendClaimEventWithQuery(
      query,
      {
        claim_id: input.claim_id,
        event_type: 'claim_effect_armed',
        actor_id: input.actor_id,
        actor_kind: input.actor_kind,
        execution_fencing_token: input.execution_fencing_token,
        details: { effect_attempt_id: effectAttemptId },
      },
      now
    );
    return {
      ok: true,
      claim_id: input.claim_id,
      effect_attempt_id: effectAttemptId,
      execution_fencing_token: input.execution_fencing_token,
    };
  });
}

export async function completeRecoveryExecutionClaim(
  input: CompleteRecoveryExecutionClaimInput
): Promise<RecoveryExecutionClaimMutationResult> {
  const db = getDatabase();
  return db.withTransaction(async query => {
    const now = await txNow(query);
    const claim = await selectClaimById(query, input.claim_id);
    if (!claim) return { ok: false, code: 'not_found', message: 'claim_not_found' };
    if (claim.status !== 'active' || claim.effect_attempt_state !== 'armed') {
      return { ok: false, code: 'stale_fence', message: 'claim_not_armed' };
    }
    if (claim.effect_attempt_id !== input.effect_attempt_id) {
      return { ok: false, code: 'stale_fence', message: 'effect_attempt_mismatch' };
    }
    if (toNumber(claim.execution_fencing_token) !== input.execution_fencing_token) {
      return { ok: false, code: 'stale_fence', message: 'stale_execution_fence' };
    }
    if (claim.actor_id !== input.actor_id || claim.actor_kind !== input.actor_kind) {
      return { ok: false, code: 'stale_fence', message: 'actor_mismatch' };
    }

    await query(
      `UPDATE remote_agent_recovery_execution_claims
         SET status = 'completed', effect_attempt_state = 'completed',
             completed_at = $1, external_effect_reference = $2, completion_evidence_json = $3
       WHERE claim_id = $4 AND status = 'active' AND execution_fencing_token = $5`,
      [
        now,
        input.external_effect_reference,
        JSON.stringify(input.evidence),
        input.claim_id,
        input.execution_fencing_token,
      ]
    );
    const row = await selectClaimById(query, input.claim_id);
    if (!row) return { ok: false, code: 'not_found', message: 'claim_not_found' };
    await appendClaimEventWithQuery(
      query,
      {
        claim_id: input.claim_id,
        event_type: 'claim_completed',
        actor_id: input.actor_id,
        actor_kind: input.actor_kind,
        execution_fencing_token: input.execution_fencing_token,
        details: { effect_attempt_id: input.effect_attempt_id },
      },
      now
    );
    return { ok: true, claim: normalizeClaim(row) };
  });
}

export async function releaseRecoveryExecutionClaim(
  input: ReleaseRecoveryExecutionClaimInput
): Promise<RecoveryExecutionClaimMutationResult> {
  const db = getDatabase();
  return db.withTransaction(async query => {
    const now = await txNow(query);
    const claim = await selectClaimById(query, input.claim_id);
    if (!claim) return { ok: false, code: 'not_found', message: 'claim_not_found' };
    if (claim.status !== 'active') {
      return { ok: false, code: 'stale_fence', message: 'claim_not_active' };
    }
    if (toNumber(claim.execution_fencing_token) !== input.execution_fencing_token) {
      return { ok: false, code: 'stale_fence', message: 'stale_execution_fence' };
    }
    if (claim.actor_id !== input.actor_id || claim.actor_kind !== input.actor_kind) {
      return { ok: false, code: 'stale_fence', message: 'actor_mismatch' };
    }
    await query(
      `UPDATE remote_agent_recovery_execution_claims
         SET status = 'released', effect_attempt_state = 'released',
             released_at = $1
       WHERE claim_id = $2 AND status = 'active' AND execution_fencing_token = $3`,
      [now, input.claim_id, input.execution_fencing_token]
    );
    const row = await selectClaimById(query, input.claim_id);
    if (!row) return { ok: false, code: 'not_found', message: 'claim_not_found' };
    await appendClaimEventWithQuery(
      query,
      {
        claim_id: input.claim_id,
        event_type: 'claim_released',
        actor_id: input.actor_id,
        actor_kind: input.actor_kind,
        execution_fencing_token: input.execution_fencing_token,
        details: { reason: input.reason },
      },
      now
    );
    return { ok: true, claim: normalizeClaim(row) };
  });
}

export async function getRecoveryExecutionClaim(
  identity: RecoveryExecutionClaimIdentity
): Promise<RecoveryExecutionClaimResponse | null> {
  const actionKey = computeRecoveryExecutionClaimKey(identity);
  const db = getDatabase();
  const result = await db.query<RecoveryExecutionClaimRow>(
    'SELECT * FROM remote_agent_recovery_execution_claims WHERE action_key = $1',
    [actionKey]
  );
  const row = result.rows[0];
  return row ? normalizeClaim(row) : null;
}
