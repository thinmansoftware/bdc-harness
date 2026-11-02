/**
 * M-27B: exclusive execution claims.
 *
 * An independent fenced claim ledger that lets exactly one current XO owner
 * proceed toward one canonically approved production action while blocking
 * stale owners and blind retries.
 *
 * This module is functionally independent of the M-27A notification/Dispatch
 * subsystem: it never imports notification modules and never queries Dispatch
 * tables. Action authority derives only from the foundation canonical approval
 * parser and the foundation XO lease singleton.
 */
import { createHash, randomUUID } from 'crypto';
import { getDatabase } from './connection';
import type { IDatabase } from './adapters/types';
import { appendBoardAuditEvent } from './board-authority';
import {
  freezeCanonicalBoardMotion,
  parseCanonicalBoardApproval,
  type ApprovedBoardAction,
} from '../workflows/canonical-board-source';

const DEFAULT_LEASE_DURATION_MS = 5 * 60 * 1000;
const ACTION_KIND = 'production_deploy';
const ENVIRONMENT = 'production';
export const RECOVERY_ACTION_KIND = 'overseer_repair_refire';
export const RECOVERY_ENVIRONMENT = 'recovery';

type TxQuery = Parameters<Parameters<IDatabase['withTransaction']>[0]>[0];

export type ClaimFailureCode =
  | 'validation_failed'
  | 'authority_rejected'
  | 'claim_conflict'
  | 'stale_fence'
  | 'reconciliation_required'
  | 'effect_attempt_mismatch'
  | 'not_found';

export type AcquireOutcome =
  | 'acquired'
  | 'taken_over'
  | 'reactivated'
  | 'existing_active'
  | 'existing_completed';

export interface ExecutionClaimResponse {
  readonly claim_id: string;
  readonly motion_id: string;
  readonly action_kind: string;
  readonly environment: string;
  readonly target_sha: string;
  readonly action_key: string;
  readonly motion_file_path: string;
  readonly motion_revision_sha: string;
  readonly claimant_principal: string;
  readonly claimant_xo_holder_id: string;
  readonly claimant_xo_lease_id: string;
  readonly claimant_xo_fencing_token: number;
  readonly execution_fencing_token: number;
  readonly status: 'active' | 'released' | 'completed';
  readonly reconciliation_status:
    | 'clear'
    | 'required'
    | 'resolved_retryable'
    | 'resolved_completed';
  readonly effect_attempt_id: string | null;
  readonly effect_attempt_state: 'none' | 'armed' | 'completed' | 'reconciled';
  readonly effect_armed_at: string | null;
  readonly acquired_at: string;
  readonly renewed_at: string | null;
  readonly expires_at: string;
  readonly released_at: string | null;
  readonly completed_at: string | null;
  readonly external_effect_reference: string | null;
  readonly completion_evidence: Record<string, unknown> | null;
  readonly reconciliation_evidence: Record<string, unknown> | null;
}

interface ClaimRow {
  readonly claim_id: string;
  readonly motion_id: string;
  readonly action_kind: string;
  readonly environment: string;
  readonly target_sha: string;
  readonly action_key: string;
  readonly idempotency_key: string;
  readonly motion_file_path: string;
  readonly motion_revision_sha: string;
  readonly claimant_principal: string;
  readonly claimant_xo_holder_id: string;
  readonly claimant_xo_lease_id: string;
  readonly claimant_xo_fencing_token: number | string;
  readonly execution_fencing_token: number | string;
  readonly status: 'active' | 'released' | 'completed';
  readonly reconciliation_status:
    | 'clear'
    | 'required'
    | 'resolved_retryable'
    | 'resolved_completed';
  readonly effect_attempt_id: string | null;
  readonly effect_attempt_state: 'none' | 'armed' | 'completed' | 'reconciled';
  readonly effect_armed_at: string | null;
  readonly acquired_at: string;
  readonly renewed_at: string | null;
  readonly expires_at: string;
  readonly released_at: string | null;
  readonly completed_at: string | null;
  readonly external_effect_reference: string | null;
  readonly completion_evidence_json: string | Record<string, unknown> | null;
  readonly reconciliation_evidence_json: string | Record<string, unknown> | null;
}

interface XoLeaseRow {
  readonly lease_id: string;
  readonly principal_id: string;
  readonly seat_id: string;
  readonly holder_id: string;
  readonly holder_token_hash: string;
  readonly fencing_token: number | string;
  readonly expires_at: string;
  readonly released_at: string | null;
}

export interface XoProof {
  readonly xo_holder_id: string;
  readonly xo_lease_id: string;
  readonly xo_fencing_token: number;
  readonly xo_holder_token: string;
}

export interface CompletionEvidence {
  readonly verified_target_sha: string;
  readonly active_work_count: number;
  readonly backup_ready: boolean;
  readonly rollback_ready: boolean;
  readonly deployment_health: string;
  readonly post_deploy_evidence: string;
}

export type ObservedState = 'not_started' | 'completed' | 'partial' | 'unknown';

export interface ReconciliationEvidence {
  readonly observed_at: string;
  readonly checked_by: string;
  readonly command_or_source: string;
  readonly observed_state: ObservedState;
  readonly evidence_reference: string;
}

export interface ExecutionClaimDependencies {
  readonly resolveApprovedAction?: (input: {
    readonly motion_file_path: string;
  }) => Promise<{ approved: ApprovedBoardAction; motion_revision_sha: string }>;
}

export interface AcquireInput extends XoProof {
  readonly motion_id: string;
  readonly action_kind: string;
  readonly environment: string;
  readonly target_sha: string;
  readonly motion_file_path: string;
  readonly initiator_principal_id: string;
  readonly initiator_seat_id: string;
  readonly lease_duration_ms?: number;
}

export interface ActionIdentity {
  readonly motion_id: string;
  readonly action_kind: string;
  readonly environment: string;
  readonly target_sha: string;
}

export type AcquireResult =
  | {
      readonly ok: true;
      readonly claim: ExecutionClaimResponse;
      readonly created: boolean;
      readonly outcome: AcquireOutcome;
    }
  | { readonly ok: false; readonly code: ClaimFailureCode; readonly message: string };

export interface RecoveryClaimIdentity {
  readonly repository: string;
  readonly wo_id: string;
  readonly execution_id: string;
  readonly target_digest: string;
}

export interface AcquireRecoveryExecutionClaimInput extends RecoveryClaimIdentity {
  readonly actor_principal: string;
  readonly lease_duration_ms?: number;
}

export type AcquireRecoveryExecutionClaimResult =
  | {
      readonly ok: true;
      readonly claim: ExecutionClaimResponse;
      readonly created: boolean;
      readonly outcome: AcquireOutcome;
    }
  | {
      readonly ok: false;
      readonly code: ClaimFailureCode;
      readonly message: string;
      readonly holder: ExecutionClaimResponse | null;
    };

export interface RecoveryFenceInput {
  readonly claim_id: string;
  readonly execution_fencing_token: number;
  readonly actor_principal: string;
}

export interface CompleteRecoveryExecutionClaimInput extends RecoveryFenceInput {
  readonly effect_attempt_id: string;
  readonly external_effect_reference: string;
  readonly evidence: Record<string, unknown>;
}

export type ClaimMutationResult =
  | { readonly ok: true; readonly claim: ExecutionClaimResponse }
  | { readonly ok: false; readonly code: ClaimFailureCode; readonly message: string };

export type PreEffectResult =
  | {
      readonly ok: true;
      readonly claim_id: string;
      readonly permitted: true;
      readonly effect_attempt_id: string;
      readonly execution_fencing_token: number;
      readonly motion_revision_sha: string;
    }
  | { readonly ok: false; readonly code: ClaimFailureCode; readonly message: string };

// ---------------------------------------------------------------------------
// Deterministic helpers
// ---------------------------------------------------------------------------

/**
 * The action identity key is the lowercase SHA-256 of the canonical JSON with
 * keys ordered motion_id, action_kind, environment, target_sha. Callers never
 * supply it; idempotency_key is the same value.
 */
export function computeActionKey(identity: ActionIdentity): string {
  const canonical = JSON.stringify({
    motion_id: identity.motion_id,
    action_kind: identity.action_kind,
    environment: identity.environment,
    target_sha: identity.target_sha,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function hashHolderToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
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

function normalizeClaim(row: ClaimRow): ExecutionClaimResponse {
  return {
    claim_id: row.claim_id,
    motion_id: row.motion_id,
    action_kind: row.action_kind,
    environment: row.environment,
    target_sha: row.target_sha,
    action_key: row.action_key,
    motion_file_path: row.motion_file_path,
    motion_revision_sha: row.motion_revision_sha,
    claimant_principal: row.claimant_principal,
    claimant_xo_holder_id: row.claimant_xo_holder_id,
    claimant_xo_lease_id: row.claimant_xo_lease_id,
    claimant_xo_fencing_token: toNumber(row.claimant_xo_fencing_token),
    execution_fencing_token: toNumber(row.execution_fencing_token),
    status: row.status,
    reconciliation_status: row.reconciliation_status,
    effect_attempt_id: row.effect_attempt_id,
    effect_attempt_state: row.effect_attempt_state,
    effect_armed_at: row.effect_armed_at,
    acquired_at: row.acquired_at,
    renewed_at: row.renewed_at,
    expires_at: row.expires_at,
    released_at: row.released_at,
    completed_at: row.completed_at,
    external_effect_reference: row.external_effect_reference,
    completion_evidence: parseJson(row.completion_evidence_json),
    reconciliation_evidence: parseJson(row.reconciliation_evidence_json),
  };
}

async function selectClaimByActionKey(
  query: TxQuery,
  actionKey: string
): Promise<ClaimRow | undefined> {
  const result = await query<ClaimRow>(
    'SELECT * FROM board_execution_claims WHERE action_key = $1',
    [actionKey]
  );
  return result.rows[0];
}

async function selectClaimById(query: TxQuery, claimId: string): Promise<ClaimRow | undefined> {
  const result = await query<ClaimRow>('SELECT * FROM board_execution_claims WHERE claim_id = $1', [
    claimId,
  ]);
  return result.rows[0];
}

interface VerifiedXo {
  readonly principal_id: string;
  readonly seat_id: string;
}

/**
 * Re-read the XO singleton by lease ID, holder ID, fence, holder-token proof,
 * and database-time expiry. A lease change between approval parsing and this
 * check fails closed with no claim owner assigned.
 */
async function verifyCurrentXo(
  query: TxQuery,
  proof: XoProof,
  now: string
): Promise<VerifiedXo | null> {
  const result = await query<XoLeaseRow>('SELECT * FROM board_xo_leases WHERE id = 1');
  const row = result.rows[0];
  if (!row) return null;
  const active = row.released_at === null && row.expires_at > now;
  if (!active) return null;
  if (row.lease_id !== proof.xo_lease_id) return null;
  if (row.holder_id !== proof.xo_holder_id) return null;
  if (toNumber(row.fencing_token) !== proof.xo_fencing_token) return null;
  if (row.holder_token_hash !== hashHolderToken(proof.xo_holder_token)) return null;
  return { principal_id: row.principal_id, seat_id: row.seat_id };
}

interface ClaimEventInput {
  readonly claim_id: string;
  readonly event_type: string;
  readonly actor_principal: string;
  readonly actor_kind: 'xo' | 'john' | 'system';
  readonly xo_lease_id?: string | null;
  readonly xo_fencing_token?: number | null;
  readonly execution_fencing_token?: number | null;
  readonly details?: Record<string, unknown>;
}

async function appendClaimEventWithQuery(
  query: TxQuery,
  input: ClaimEventInput,
  now: string
): Promise<void> {
  const seqResult = await query<{ next: number | string }>(
    'SELECT COALESCE(MAX(event_sequence), 0) + 1 AS next FROM board_execution_claim_events WHERE claim_id = $1',
    [input.claim_id]
  );
  const nextSeq = toNumber(seqResult.rows[0]?.next ?? 1);
  await query(
    `INSERT INTO board_execution_claim_events (
       event_id, claim_id, event_sequence, event_type, actor_principal, actor_kind,
       xo_lease_id, xo_fencing_token, execution_fencing_token, details_json, created_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      randomUUID(),
      input.claim_id,
      nextSeq,
      input.event_type,
      input.actor_principal,
      input.actor_kind,
      input.xo_lease_id ?? null,
      input.xo_fencing_token ?? null,
      input.execution_fencing_token ?? null,
      JSON.stringify(input.details ?? {}),
      now,
    ]
  );
}

/**
 * Append-only lifecycle event in the execution store (own transaction).
 */
export async function appendExecutionClaimEvent(input: ClaimEventInput): Promise<void> {
  const db = getDatabase();
  await db.withTransaction(async query => {
    const now = await txNow(query);
    await appendClaimEventWithQuery(query, input, now);
  });
}

// ---------------------------------------------------------------------------
// Pre-claim board audit evidence (independent of execution-claim rows)
// ---------------------------------------------------------------------------

async function boardAuditEventExists(eventType: string, eventKey: string): Promise<boolean> {
  const db = getDatabase();
  const detailsExpr = db.dialect === 'postgres' ? 'details::text' : 'details';
  const result = await db.query<{ present: number }>(
    `SELECT 1 AS present FROM board_audit_events WHERE event_type = $1 AND ${detailsExpr} LIKE $2 LIMIT 1`,
    [eventType, `%"event_key":${JSON.stringify(eventKey)}%`]
  );
  return result.rowCount > 0;
}

export type AuthorityRejectionReason =
  | 'canonical_approval_rejected'
  | 'action_identity_mismatch'
  | 'initiator_not_authorized'
  | 'xo_authority_invalid';

export interface AuthorityRejectionInput {
  readonly motion_id: string;
  readonly action_key: string;
  readonly motion_revision_sha: string | null;
  readonly reason_code: AuthorityRejectionReason;
  readonly actor_principal: string | null;
  readonly actor_seat: string | null;
  readonly xo_fencing_token: number | null;
  readonly requested_action_identity: ActionIdentity;
}

/**
 * Write the exact deduplicated board-audit authority-rejection event when a
 * syntactically valid acquire request fails authority before a claim row exists.
 * No fake claim row or claim event is created.
 */
export async function recordExecutionAuthorityRejection(
  input: AuthorityRejectionInput
): Promise<void> {
  const eventKey = [
    'execution-claim-authority-rejected',
    input.motion_id,
    input.action_key,
    input.motion_revision_sha ?? 'unavailable',
    input.reason_code,
    input.actor_principal ?? 'unavailable',
    String(input.xo_fencing_token ?? 0),
  ].join(':');

  if (await boardAuditEventExists('execution_claim_authority_rejected', eventKey)) {
    return;
  }

  await appendBoardAuditEvent({
    event_type: 'execution_claim_authority_rejected',
    actor_principal_id: input.actor_principal,
    actor_seat_id: normalizeSeat(input.actor_seat),
    motion_id: input.motion_id,
    motion_revision_sha: input.motion_revision_sha,
    xo_fencing_token: input.xo_fencing_token,
    details: {
      event_key: eventKey,
      reason_code: input.reason_code,
      requested_action_identity: input.requested_action_identity,
    },
  });
}

export interface ManualInitiationInput {
  readonly motion_id: string;
  readonly action_key: string;
  readonly motion_revision_sha: string;
  readonly john_principal_id: string;
  readonly requested_action_identity: ActionIdentity;
}

/**
 * Sole writer of the exact manual-initiation board audit event for an
 * authenticated John acquisition request. Deduplicated per action identity so
 * repeated John initiation writes exactly one event.
 */
export async function recordManualInitiation(input: ManualInitiationInput): Promise<void> {
  const eventKey = ['manual-initiation-recorded', input.motion_id, input.action_key].join(':');
  if (await boardAuditEventExists('manual_initiation_recorded', eventKey)) {
    return;
  }
  await appendBoardAuditEvent({
    event_type: 'manual_initiation_recorded',
    actor_principal_id: input.john_principal_id,
    actor_seat_id: 'john',
    motion_id: input.motion_id,
    motion_revision_sha: input.motion_revision_sha,
    details: {
      event_key: eventKey,
      requested_action_identity: input.requested_action_identity,
    },
  });
}

function normalizeSeat(seat: string | null): string | null {
  if (seat === 'john' || seat === 'general' || seat === 'xo') return seat;
  return null;
}

// ---------------------------------------------------------------------------
// Approval resolution
// ---------------------------------------------------------------------------

async function defaultResolveApprovedAction(input: {
  motion_file_path: string;
}): Promise<{ approved: ApprovedBoardAction; motion_revision_sha: string }> {
  const frozen = await freezeCanonicalBoardMotion(input.motion_file_path);
  const approved = parseCanonicalBoardApproval(frozen);
  return { approved, motion_revision_sha: frozen.blob_sha };
}

// ---------------------------------------------------------------------------
// Acquire
// ---------------------------------------------------------------------------

export async function acquireExecutionClaim(
  input: AcquireInput,
  deps: ExecutionClaimDependencies = {}
): Promise<AcquireResult> {
  const identity: ActionIdentity = {
    motion_id: input.motion_id,
    action_kind: input.action_kind,
    environment: input.environment,
    target_sha: input.target_sha,
  };
  const actionKey = computeActionKey(identity);
  const resolve = deps.resolveApprovedAction ?? defaultResolveApprovedAction;

  // 1. Parse the latest canonical approval before touching claim state.
  let approved: ApprovedBoardAction;
  let motionRevisionSha: string;
  try {
    const resolved = await resolve({ motion_file_path: input.motion_file_path });
    approved = resolved.approved;
    motionRevisionSha = resolved.motion_revision_sha;
  } catch {
    await recordExecutionAuthorityRejection({
      motion_id: input.motion_id,
      action_key: actionKey,
      motion_revision_sha: null,
      reason_code: 'canonical_approval_rejected',
      actor_principal: input.initiator_principal_id,
      actor_seat: input.initiator_seat_id,
      xo_fencing_token: input.xo_fencing_token,
      requested_action_identity: identity,
    });
    return { ok: false, code: 'authority_rejected', message: 'canonical_approval_rejected' };
  }

  // 2. The request identity must exactly match the approved production action.
  if (
    input.action_kind !== ACTION_KIND ||
    input.environment !== ENVIRONMENT ||
    approved.motion_id !== input.motion_id ||
    approved.environment !== input.environment ||
    approved.target_sha !== input.target_sha
  ) {
    await recordExecutionAuthorityRejection({
      motion_id: input.motion_id,
      action_key: actionKey,
      motion_revision_sha: motionRevisionSha,
      reason_code: 'action_identity_mismatch',
      actor_principal: input.initiator_principal_id,
      actor_seat: input.initiator_seat_id,
      xo_fencing_token: input.xo_fencing_token,
      requested_action_identity: identity,
    });
    return { ok: false, code: 'authority_rejected', message: 'action_identity_mismatch' };
  }

  // 3. Only XO (matching the slot) or John may initiate.
  if (input.initiator_seat_id !== 'xo' && input.initiator_seat_id !== 'john') {
    await recordExecutionAuthorityRejection({
      motion_id: input.motion_id,
      action_key: actionKey,
      motion_revision_sha: motionRevisionSha,
      reason_code: 'initiator_not_authorized',
      actor_principal: input.initiator_principal_id,
      actor_seat: input.initiator_seat_id,
      xo_fencing_token: input.xo_fencing_token,
      requested_action_identity: identity,
    });
    return { ok: false, code: 'authority_rejected', message: 'initiator_not_authorized' };
  }

  const db = getDatabase();
  const outcome = await db.withTransaction(async query => {
    const now = await txNow(query);
    const xo = await verifyCurrentXo(query, input, now);
    if (!xo) {
      return {
        ok: false as const,
        code: 'authority_rejected' as const,
        message: 'xo_authority_invalid',
        reject: true as const,
      };
    }
    if (input.initiator_seat_id === 'xo' && input.initiator_principal_id !== xo.principal_id) {
      return {
        ok: false as const,
        code: 'authority_rejected' as const,
        message: 'xo_authority_invalid',
        reject: true as const,
      };
    }

    const actorKind: 'xo' | 'john' = input.initiator_seat_id === 'john' ? 'john' : 'xo';
    const expiresAt = addMillisecondsIso(now, input.lease_duration_ms ?? DEFAULT_LEASE_DURATION_MS);

    const existing = await selectClaimByActionKey(query, actionKey);
    if (existing) {
      if (existing.status === 'completed') {
        return {
          ok: true as const,
          claim: normalizeClaim(existing),
          created: false as const,
          outcome: 'existing_completed' as const,
        };
      }
      if (existing.status === 'active') {
        if (existing.reconciliation_status === 'required') {
          return {
            ok: false as const,
            code: 'reconciliation_required' as const,
            message: 'reconciliation_required',
          };
        }
        if (existing.expires_at > now) {
          if (existing.claimant_xo_lease_id === input.xo_lease_id) {
            return {
              ok: true as const,
              claim: normalizeClaim(existing),
              created: false as const,
              outcome: 'existing_active' as const,
            };
          }
          return { ok: false as const, code: 'claim_conflict' as const, message: 'claim_conflict' };
        }
        // Expired active claim -> takeover with a strictly higher execution token.
        const nextToken = toNumber(existing.execution_fencing_token) + 1;
        await query(
          `UPDATE board_execution_claims
             SET claimant_principal = $1, claimant_xo_holder_id = $2, claimant_xo_lease_id = $3,
                 claimant_xo_fencing_token = $4, execution_fencing_token = $5,
                 motion_revision_sha = $6, motion_file_path = $7,
                 status = 'active', reconciliation_status = 'clear',
                 effect_attempt_id = NULL, effect_attempt_state = 'none', effect_armed_at = NULL,
                 acquired_at = $8, renewed_at = NULL, expires_at = $9,
                 released_at = NULL, completed_at = NULL, external_effect_reference = NULL,
                 completion_evidence_json = NULL, reconciliation_evidence_json = NULL
           WHERE action_key = $10 AND status = 'active'
             AND expires_at <= $8 AND reconciliation_status <> 'required'`,
          [
            xo.principal_id,
            input.xo_holder_id,
            input.xo_lease_id,
            input.xo_fencing_token,
            nextToken,
            motionRevisionSha,
            input.motion_file_path,
            now,
            expiresAt,
            actionKey,
          ]
        );
        const row = await selectClaimByActionKey(query, actionKey);
        if (
          row?.claimant_xo_lease_id !== input.xo_lease_id ||
          toNumber(row.execution_fencing_token) !== nextToken
        ) {
          return { ok: false as const, code: 'claim_conflict' as const, message: 'claim_conflict' };
        }
        await appendClaimEventWithQuery(
          query,
          {
            claim_id: row.claim_id,
            event_type: 'claim_taken_over',
            actor_principal: input.initiator_principal_id,
            actor_kind: actorKind,
            xo_lease_id: input.xo_lease_id,
            xo_fencing_token: input.xo_fencing_token,
            execution_fencing_token: nextToken,
            details: { outcome: 'taken_over' },
          },
          now
        );
        return {
          ok: true as const,
          claim: normalizeClaim(row),
          created: true as const,
          outcome: 'taken_over' as const,
        };
      }
      // Released -> reacquire same row with a higher token.
      const nextToken = toNumber(existing.execution_fencing_token) + 1;
      await query(
        `UPDATE board_execution_claims
           SET claimant_principal = $1, claimant_xo_holder_id = $2, claimant_xo_lease_id = $3,
               claimant_xo_fencing_token = $4, execution_fencing_token = $5,
               motion_revision_sha = $6, motion_file_path = $7,
               status = 'active', reconciliation_status = 'clear',
               effect_attempt_id = NULL, effect_attempt_state = 'none', effect_armed_at = NULL,
               acquired_at = $8, renewed_at = NULL, expires_at = $9,
               released_at = NULL, completed_at = NULL, external_effect_reference = NULL,
               completion_evidence_json = NULL, reconciliation_evidence_json = NULL
         WHERE action_key = $10 AND status = 'released'`,
        [
          xo.principal_id,
          input.xo_holder_id,
          input.xo_lease_id,
          input.xo_fencing_token,
          nextToken,
          motionRevisionSha,
          input.motion_file_path,
          now,
          expiresAt,
          actionKey,
        ]
      );
      const row = await selectClaimByActionKey(query, actionKey);
      if (
        row?.claimant_xo_lease_id !== input.xo_lease_id ||
        toNumber(row.execution_fencing_token) !== nextToken
      ) {
        return { ok: false as const, code: 'claim_conflict' as const, message: 'claim_conflict' };
      }
      await appendClaimEventWithQuery(
        query,
        {
          claim_id: row.claim_id,
          event_type: 'claim_acquired',
          actor_principal: input.initiator_principal_id,
          actor_kind: actorKind,
          xo_lease_id: input.xo_lease_id,
          xo_fencing_token: input.xo_fencing_token,
          execution_fencing_token: nextToken,
          details: { outcome: 'reactivated' },
        },
        now
      );
      return {
        ok: true as const,
        claim: normalizeClaim(row),
        created: true as const,
        outcome: 'reactivated' as const,
      };
    }

    // No existing row -> insert a fresh claim atomically.
    const claimId = randomUUID();
    await query(
      `INSERT INTO board_execution_claims (
         claim_id, motion_id, action_kind, environment, target_sha, action_key, idempotency_key,
         motion_file_path, motion_revision_sha, claimant_principal, claimant_xo_holder_id,
         claimant_xo_lease_id, claimant_xo_fencing_token, execution_fencing_token,
         status, reconciliation_status, effect_attempt_id, effect_attempt_state, effect_armed_at,
         acquired_at, renewed_at, expires_at, released_at, completed_at, external_effect_reference,
         completion_evidence_json, reconciliation_evidence_json
       )
       VALUES (
         $1, $2, $3, $4, $5, $6, $6, $7, $8, $9, $10, $11, $12, 1,
         'active', 'clear', NULL, 'none', NULL, $13, NULL, $14, NULL, NULL, NULL, NULL, NULL
       )
       ON CONFLICT (action_key) DO NOTHING`,
      [
        claimId,
        input.motion_id,
        ACTION_KIND,
        ENVIRONMENT,
        input.target_sha,
        actionKey,
        input.motion_file_path,
        motionRevisionSha,
        xo.principal_id,
        input.xo_holder_id,
        input.xo_lease_id,
        input.xo_fencing_token,
        now,
        expiresAt,
      ]
    );
    const row = await selectClaimByActionKey(query, actionKey);
    if (row?.claim_id === claimId) {
      await appendClaimEventWithQuery(
        query,
        {
          claim_id: claimId,
          event_type: 'claim_acquired',
          actor_principal: input.initiator_principal_id,
          actor_kind: actorKind,
          xo_lease_id: input.xo_lease_id,
          xo_fencing_token: input.xo_fencing_token,
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
    }
    // Lost the insert race: converge onto the winner's row.
    if (row) {
      if (row.status === 'completed') {
        return {
          ok: true as const,
          claim: normalizeClaim(row),
          created: false as const,
          outcome: 'existing_completed' as const,
        };
      }
      if (row.status === 'active' && row.reconciliation_status === 'required') {
        return {
          ok: false as const,
          code: 'reconciliation_required' as const,
          message: 'reconciliation_required',
        };
      }
      if (
        row.status === 'active' &&
        row.expires_at > now &&
        row.claimant_xo_lease_id === input.xo_lease_id
      ) {
        return {
          ok: true as const,
          claim: normalizeClaim(row),
          created: false as const,
          outcome: 'existing_active' as const,
        };
      }
    }
    return { ok: false as const, code: 'claim_conflict' as const, message: 'claim_conflict' };
  });

  if (!outcome.ok) {
    if ('reject' in outcome && outcome.reject) {
      await recordExecutionAuthorityRejection({
        motion_id: input.motion_id,
        action_key: actionKey,
        motion_revision_sha: motionRevisionSha,
        reason_code: 'xo_authority_invalid',
        actor_principal: input.initiator_principal_id,
        actor_seat: input.initiator_seat_id,
        xo_fencing_token: input.xo_fencing_token,
        requested_action_identity: identity,
      });
    }
    return { ok: false, code: outcome.code, message: outcome.message };
  }

  // Authenticated John initiation records a single manual-initiation event.
  if (input.initiator_seat_id === 'john') {
    await recordManualInitiation({
      motion_id: input.motion_id,
      action_key: actionKey,
      motion_revision_sha: motionRevisionSha,
      john_principal_id: input.initiator_principal_id,
      requested_action_identity: identity,
    });
  }

  return { ok: true, claim: outcome.claim, created: outcome.created, outcome: outcome.outcome };
}

// ---------------------------------------------------------------------------
// Renew
// ---------------------------------------------------------------------------

export interface RenewInput extends XoProof {
  readonly claim_id: string;
  readonly execution_fencing_token: number;
  readonly lease_duration_ms?: number;
}

export async function renewExecutionClaim(input: RenewInput): Promise<ClaimMutationResult> {
  const db = getDatabase();
  return db.withTransaction(async query => {
    const now = await txNow(query);
    const claim = await selectClaimById(query, input.claim_id);
    if (!claim) return { ok: false, code: 'not_found', message: 'claim_not_found' };
    if (claim.status !== 'active')
      return { ok: false, code: 'stale_fence', message: 'claim_not_active' };
    if (toNumber(claim.execution_fencing_token) !== input.execution_fencing_token) {
      return { ok: false, code: 'stale_fence', message: 'stale_execution_fence' };
    }
    const xo = await verifyCurrentXo(query, input, now);
    if (!xo) return { ok: false, code: 'authority_rejected', message: 'xo_authority_invalid' };

    const expiresAt = addMillisecondsIso(now, input.lease_duration_ms ?? DEFAULT_LEASE_DURATION_MS);
    await query(
      `UPDATE board_execution_claims
         SET renewed_at = $1, expires_at = $2
       WHERE claim_id = $3 AND status = 'active' AND execution_fencing_token = $4`,
      [now, expiresAt, input.claim_id, input.execution_fencing_token]
    );
    const row = await selectClaimById(query, input.claim_id);
    if (!row) return { ok: false, code: 'not_found', message: 'claim_not_found' };
    await appendClaimEventWithQuery(
      query,
      {
        claim_id: input.claim_id,
        event_type: 'claim_renewed',
        actor_principal: xo.principal_id,
        actor_kind: 'xo',
        xo_lease_id: input.xo_lease_id,
        xo_fencing_token: input.xo_fencing_token,
        execution_fencing_token: input.execution_fencing_token,
        details: { expires_at: expiresAt },
      },
      now
    );
    return { ok: true, claim: normalizeClaim(row) };
  });
}

// ---------------------------------------------------------------------------
// Pre-effect fence validation (atomic arm)
// ---------------------------------------------------------------------------

export interface PreEffectInput extends XoProof {
  readonly claim_id: string;
  readonly execution_fencing_token: number;
}

export async function validateExecutionFence(
  input: PreEffectInput,
  deps: ExecutionClaimDependencies = {}
): Promise<PreEffectResult> {
  const resolve = deps.resolveApprovedAction ?? defaultResolveApprovedAction;
  const db = getDatabase();

  // Read the claim identity first (outside the arm transaction) so the latest
  // canonical motion and John authorization can be re-verified before arming.
  const preClaim = await db.withTransaction(async query => selectClaimById(query, input.claim_id));
  if (!preClaim) return { ok: false, code: 'not_found', message: 'claim_not_found' };

  let approved: ApprovedBoardAction;
  let motionRevisionSha: string;
  try {
    const resolved = await resolve({ motion_file_path: preClaim.motion_file_path });
    approved = resolved.approved;
    motionRevisionSha = resolved.motion_revision_sha;
  } catch {
    return { ok: false, code: 'authority_rejected', message: 'canonical_approval_rejected' };
  }
  if (
    approved.motion_id !== preClaim.motion_id ||
    approved.environment !== preClaim.environment ||
    approved.target_sha !== preClaim.target_sha
  ) {
    return { ok: false, code: 'authority_rejected', message: 'action_identity_mismatch' };
  }

  return db.withTransaction(async query => {
    const now = await txNow(query);
    const claim = await selectClaimById(query, input.claim_id);
    if (!claim) return { ok: false, code: 'not_found', message: 'claim_not_found' };
    if (claim.status !== 'active')
      return { ok: false, code: 'stale_fence', message: 'claim_not_active' };
    if (toNumber(claim.execution_fencing_token) !== input.execution_fencing_token) {
      return { ok: false, code: 'stale_fence', message: 'stale_execution_fence' };
    }
    if (claim.reconciliation_status === 'required' || claim.effect_attempt_state !== 'none') {
      return { ok: false, code: 'reconciliation_required', message: 'reconciliation_required' };
    }
    const xo = await verifyCurrentXo(query, input, now);
    if (!xo) return { ok: false, code: 'authority_rejected', message: 'xo_authority_invalid' };

    const effectAttemptId = randomUUID();
    await query(
      `UPDATE board_execution_claims
         SET effect_attempt_id = $1, effect_attempt_state = 'armed', effect_armed_at = $2,
             reconciliation_status = 'required'
       WHERE claim_id = $3 AND status = 'active' AND execution_fencing_token = $4
         AND effect_attempt_state = 'none'`,
      [effectAttemptId, now, input.claim_id, input.execution_fencing_token]
    );
    const row = await selectClaimById(query, input.claim_id);
    if (row?.effect_attempt_id !== effectAttemptId || row.effect_attempt_state !== 'armed') {
      return { ok: false, code: 'reconciliation_required', message: 'arm_conflict' };
    }
    await appendClaimEventWithQuery(
      query,
      {
        claim_id: input.claim_id,
        event_type: 'claim_effect_armed',
        actor_principal: xo.principal_id,
        actor_kind: 'xo',
        xo_lease_id: input.xo_lease_id,
        xo_fencing_token: input.xo_fencing_token,
        execution_fencing_token: input.execution_fencing_token,
        details: { effect_attempt_id: effectAttemptId, motion_revision_sha: motionRevisionSha },
      },
      now
    );
    return {
      ok: true,
      claim_id: input.claim_id,
      permitted: true,
      effect_attempt_id: effectAttemptId,
      execution_fencing_token: input.execution_fencing_token,
      motion_revision_sha: motionRevisionSha,
    };
  });
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

export interface MarkReconciliationInput extends XoProof {
  readonly claim_id: string;
  readonly execution_fencing_token: number;
  readonly effect_attempt_id: string;
  readonly uncertainty: { readonly reported_at: string; readonly summary: string };
}

export async function markExecutionReconciliationRequired(
  input: MarkReconciliationInput
): Promise<ClaimMutationResult> {
  const db = getDatabase();
  return db.withTransaction(async query => {
    const now = await txNow(query);
    const claim = await selectClaimById(query, input.claim_id);
    if (!claim) return { ok: false, code: 'not_found', message: 'claim_not_found' };
    if (claim.status !== 'active')
      return { ok: false, code: 'stale_fence', message: 'claim_not_active' };
    if (toNumber(claim.execution_fencing_token) !== input.execution_fencing_token) {
      return { ok: false, code: 'stale_fence', message: 'stale_execution_fence' };
    }
    if (
      claim.effect_attempt_state !== 'armed' ||
      claim.effect_attempt_id !== input.effect_attempt_id
    ) {
      return { ok: false, code: 'effect_attempt_mismatch', message: 'effect_attempt_mismatch' };
    }
    const xo = await verifyCurrentXo(query, input, now);
    if (!xo) return { ok: false, code: 'authority_rejected', message: 'xo_authority_invalid' };

    // Arming already set reconciliation_status='required'; this records the
    // explicit uncertain-outcome evidence and keeps the claim blocked.
    const row = await selectClaimById(query, input.claim_id);
    if (!row) return { ok: false, code: 'not_found', message: 'claim_not_found' };
    await appendClaimEventWithQuery(
      query,
      {
        claim_id: input.claim_id,
        event_type: 'claim_reconciliation_required',
        actor_principal: xo.principal_id,
        actor_kind: 'xo',
        xo_lease_id: input.xo_lease_id,
        xo_fencing_token: input.xo_fencing_token,
        execution_fencing_token: input.execution_fencing_token,
        details: { effect_attempt_id: input.effect_attempt_id, uncertainty: input.uncertainty },
      },
      now
    );
    return { ok: true, claim: normalizeClaim(row) };
  });
}

export interface ResolveReconciliationInput extends XoProof {
  readonly claim_id: string;
  readonly execution_fencing_token: number;
  readonly effect_attempt_id: string;
  readonly resolution: 'retryable' | 'completed';
  readonly evidence: ReconciliationEvidence;
  readonly external_effect_reference?: string | null;
}

export async function resolveExecutionReconciliation(
  input: ResolveReconciliationInput
): Promise<ClaimMutationResult> {
  const db = getDatabase();
  return db.withTransaction(async query => {
    const now = await txNow(query);
    const claim = await selectClaimById(query, input.claim_id);
    if (!claim) return { ok: false, code: 'not_found', message: 'claim_not_found' };
    if (claim.status !== 'active' || claim.reconciliation_status !== 'required') {
      return { ok: false, code: 'reconciliation_required', message: 'not_in_reconciliation' };
    }
    if (toNumber(claim.execution_fencing_token) !== input.execution_fencing_token) {
      return { ok: false, code: 'stale_fence', message: 'stale_execution_fence' };
    }
    if (
      claim.effect_attempt_state !== 'armed' ||
      claim.effect_attempt_id !== input.effect_attempt_id
    ) {
      return { ok: false, code: 'effect_attempt_mismatch', message: 'effect_attempt_mismatch' };
    }
    const xo = await verifyCurrentXo(query, input, now);
    if (!xo) return { ok: false, code: 'authority_rejected', message: 'xo_authority_invalid' };

    const observed = input.evidence.observed_state;
    if (input.resolution === 'retryable') {
      if (observed !== 'not_started') {
        return { ok: false, code: 'validation_failed', message: 'retryable_requires_not_started' };
      }
      await query(
        `UPDATE board_execution_claims
           SET status = 'released', reconciliation_status = 'resolved_retryable',
               effect_attempt_state = 'reconciled', released_at = $1,
               reconciliation_evidence_json = $2
         WHERE claim_id = $3 AND status = 'active' AND execution_fencing_token = $4`,
        [now, JSON.stringify(input.evidence), input.claim_id, input.execution_fencing_token]
      );
      const row = await selectClaimById(query, input.claim_id);
      if (!row) return { ok: false, code: 'not_found', message: 'claim_not_found' };
      await appendClaimEventWithQuery(
        query,
        {
          claim_id: input.claim_id,
          event_type: 'claim_reconciled_retryable',
          actor_principal: xo.principal_id,
          actor_kind: 'xo',
          xo_lease_id: input.xo_lease_id,
          xo_fencing_token: input.xo_fencing_token,
          execution_fencing_token: input.execution_fencing_token,
          details: { effect_attempt_id: input.effect_attempt_id, evidence: input.evidence },
        },
        now
      );
      return { ok: true, claim: normalizeClaim(row) };
    }

    // resolution === 'completed'
    if (observed !== 'completed') {
      return {
        ok: false,
        code: 'validation_failed',
        message: 'completed_requires_completed_state',
      };
    }
    if (!input.external_effect_reference) {
      return {
        ok: false,
        code: 'validation_failed',
        message: 'external_effect_reference_required',
      };
    }
    await query(
      `UPDATE board_execution_claims
         SET status = 'completed', reconciliation_status = 'resolved_completed',
             effect_attempt_state = 'reconciled', completed_at = $1,
             external_effect_reference = $2, reconciliation_evidence_json = $3
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
        event_type: 'claim_reconciled_completed',
        actor_principal: xo.principal_id,
        actor_kind: 'xo',
        xo_lease_id: input.xo_lease_id,
        xo_fencing_token: input.xo_fencing_token,
        execution_fencing_token: input.execution_fencing_token,
        details: { effect_attempt_id: input.effect_attempt_id, evidence: input.evidence },
      },
      now
    );
    return { ok: true, claim: normalizeClaim(row) };
  });
}

// ---------------------------------------------------------------------------
// Release
// ---------------------------------------------------------------------------

export interface ReleaseInput extends XoProof {
  readonly claim_id: string;
  readonly execution_fencing_token: number;
}

export async function releaseExecutionClaim(input: ReleaseInput): Promise<ClaimMutationResult> {
  const db = getDatabase();
  return db.withTransaction(async query => {
    const now = await txNow(query);
    const claim = await selectClaimById(query, input.claim_id);
    if (!claim) return { ok: false, code: 'not_found', message: 'claim_not_found' };
    if (claim.status !== 'active')
      return { ok: false, code: 'stale_fence', message: 'claim_not_active' };
    if (claim.reconciliation_status === 'required') {
      return { ok: false, code: 'reconciliation_required', message: 'reconciliation_required' };
    }
    if (toNumber(claim.execution_fencing_token) !== input.execution_fencing_token) {
      return { ok: false, code: 'stale_fence', message: 'stale_execution_fence' };
    }
    const xo = await verifyCurrentXo(query, input, now);
    if (!xo) return { ok: false, code: 'authority_rejected', message: 'xo_authority_invalid' };

    await query(
      `UPDATE board_execution_claims
         SET status = 'released', reconciliation_status = 'clear',
             effect_attempt_state = 'none', effect_attempt_id = NULL, effect_armed_at = NULL,
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
        actor_principal: xo.principal_id,
        actor_kind: 'xo',
        xo_lease_id: input.xo_lease_id,
        xo_fencing_token: input.xo_fencing_token,
        execution_fencing_token: input.execution_fencing_token,
        details: { released_at: now },
      },
      now
    );
    return { ok: true, claim: normalizeClaim(row) };
  });
}

// ---------------------------------------------------------------------------
// Complete
// ---------------------------------------------------------------------------

export interface CompleteInput extends XoProof {
  readonly claim_id: string;
  readonly execution_fencing_token: number;
  readonly effect_attempt_id: string;
  readonly external_effect_reference: string;
  readonly evidence: CompletionEvidence;
}

export async function completeExecutionClaim(input: CompleteInput): Promise<ClaimMutationResult> {
  const db = getDatabase();
  return db.withTransaction(async query => {
    const now = await txNow(query);
    const claim = await selectClaimById(query, input.claim_id);
    if (!claim) return { ok: false, code: 'not_found', message: 'claim_not_found' };
    if (claim.status !== 'active' || claim.effect_attempt_state !== 'armed') {
      return { ok: false, code: 'effect_attempt_mismatch', message: 'claim_not_armed' };
    }
    if (claim.effect_attempt_id !== input.effect_attempt_id) {
      return { ok: false, code: 'effect_attempt_mismatch', message: 'effect_attempt_mismatch' };
    }
    if (toNumber(claim.execution_fencing_token) !== input.execution_fencing_token) {
      return { ok: false, code: 'stale_fence', message: 'stale_execution_fence' };
    }
    if (!input.external_effect_reference) {
      return {
        ok: false,
        code: 'validation_failed',
        message: 'external_effect_reference_required',
      };
    }
    if (input.evidence.verified_target_sha !== claim.target_sha) {
      return { ok: false, code: 'validation_failed', message: 'verified_target_sha_mismatch' };
    }
    const xo = await verifyCurrentXo(query, input, now);
    if (!xo) return { ok: false, code: 'authority_rejected', message: 'xo_authority_invalid' };

    await query(
      `UPDATE board_execution_claims
         SET status = 'completed', reconciliation_status = 'clear',
             effect_attempt_state = 'completed', completed_at = $1,
             external_effect_reference = $2, completion_evidence_json = $3
       WHERE claim_id = $4 AND status = 'active' AND effect_attempt_state = 'armed'
         AND execution_fencing_token = $5 AND effect_attempt_id = $6`,
      [
        now,
        input.external_effect_reference,
        JSON.stringify(input.evidence),
        input.claim_id,
        input.execution_fencing_token,
        input.effect_attempt_id,
      ]
    );
    const row = await selectClaimById(query, input.claim_id);
    if (row?.status !== 'completed') {
      return { ok: false, code: 'effect_attempt_mismatch', message: 'complete_conflict' };
    }
    await appendClaimEventWithQuery(
      query,
      {
        claim_id: input.claim_id,
        event_type: 'claim_completed',
        actor_principal: xo.principal_id,
        actor_kind: 'xo',
        xo_lease_id: input.xo_lease_id,
        xo_fencing_token: input.xo_fencing_token,
        execution_fencing_token: input.execution_fencing_token,
        details: {
          effect_attempt_id: input.effect_attempt_id,
          external_effect_reference: input.external_effect_reference,
        },
      },
      now
    );
    return { ok: true, claim: normalizeClaim(row) };
  });
}

// ---------------------------------------------------------------------------
// Recovery-scoped claims (Overseer repair/refire)
// ---------------------------------------------------------------------------

function recoveryActionIdentity(input: RecoveryClaimIdentity): ActionIdentity {
  return {
    motion_id: `overseer:${input.repository}:${input.wo_id}:${input.execution_id}`,
    action_kind: RECOVERY_ACTION_KIND,
    environment: RECOVERY_ENVIRONMENT,
    target_sha: input.target_digest,
  };
}

function assertRecoveryClaimInput(input: RecoveryClaimIdentity): void {
  if (input.repository.length === 0) throw new Error('repository is required');
  if (input.wo_id.length === 0) throw new Error('wo_id is required');
  if (input.execution_id.length === 0) throw new Error('execution_id is required');
  if (!/^[0-9a-f]{64}$/.test(input.target_digest)) {
    throw new Error('target_digest must be lower-case 64-hex');
  }
}

export function computeRecoveryExecutionActionKey(input: RecoveryClaimIdentity): string {
  assertRecoveryClaimInput(input);
  return computeActionKey(recoveryActionIdentity(input));
}

export async function acquireRecoveryExecutionClaim(
  input: AcquireRecoveryExecutionClaimInput
): Promise<AcquireRecoveryExecutionClaimResult> {
  assertRecoveryClaimInput(input);
  if (input.actor_principal.length === 0) throw new Error('actor_principal is required');

  const identity = recoveryActionIdentity(input);
  const actionKey = computeActionKey(identity);
  const db = getDatabase();

  return db.withTransaction(async query => {
    const now = await txNow(query);
    const expiresAt = addMillisecondsIso(now, input.lease_duration_ms ?? DEFAULT_LEASE_DURATION_MS);
    const existing = await selectClaimByActionKey(query, actionKey);

    if (existing) {
      if (existing.status === 'completed') {
        return {
          ok: true,
          claim: normalizeClaim(existing),
          created: false,
          outcome: 'existing_completed',
        };
      }

      if (existing.status === 'active') {
        if (existing.reconciliation_status === 'required') {
          return {
            ok: false,
            code: 'reconciliation_required',
            message: 'reconciliation_required',
            holder: normalizeClaim(existing),
          };
        }
        if (existing.expires_at > now) {
          return {
            ok: false,
            code: 'claim_conflict',
            message: 'claim_conflict',
            holder: normalizeClaim(existing),
          };
        }

        const nextToken = toNumber(existing.execution_fencing_token) + 1;
        await query(
          `UPDATE board_execution_claims
             SET claimant_principal = $1, claimant_xo_holder_id = $2, claimant_xo_lease_id = $3,
                 claimant_xo_fencing_token = $4, execution_fencing_token = $5,
                 status = 'active', reconciliation_status = 'clear',
                 effect_attempt_id = NULL, effect_attempt_state = 'none', effect_armed_at = NULL,
                 acquired_at = $6, renewed_at = NULL, expires_at = $7,
                 released_at = NULL, completed_at = NULL, external_effect_reference = NULL,
                 completion_evidence_json = NULL, reconciliation_evidence_json = NULL
           WHERE action_key = $8 AND status = 'active'
             AND expires_at <= $6 AND reconciliation_status <> 'required'`,
          [input.actor_principal, 'recovery', 'recovery', 1, nextToken, now, expiresAt, actionKey]
        );
        const row = await selectClaimByActionKey(query, actionKey);
        if (
          row?.claimant_principal !== input.actor_principal ||
          toNumber(row.execution_fencing_token) !== nextToken
        ) {
          return {
            ok: false,
            code: 'claim_conflict',
            message: 'claim_conflict',
            holder: row ? normalizeClaim(row) : null,
          };
        }
        await appendClaimEventWithQuery(
          query,
          {
            claim_id: row.claim_id,
            event_type: 'claim_taken_over',
            actor_principal: input.actor_principal,
            actor_kind: 'system',
            execution_fencing_token: nextToken,
            details: { outcome: 'taken_over', action_kind: RECOVERY_ACTION_KIND },
          },
          now
        );
        return { ok: true, claim: normalizeClaim(row), created: true, outcome: 'taken_over' };
      }

      const nextToken = toNumber(existing.execution_fencing_token) + 1;
      await query(
        `UPDATE board_execution_claims
           SET claimant_principal = $1, claimant_xo_holder_id = $2, claimant_xo_lease_id = $3,
               claimant_xo_fencing_token = $4, execution_fencing_token = $5,
               status = 'active', reconciliation_status = 'clear',
               effect_attempt_id = NULL, effect_attempt_state = 'none', effect_armed_at = NULL,
               acquired_at = $6, renewed_at = NULL, expires_at = $7,
               released_at = NULL, completed_at = NULL, external_effect_reference = NULL,
               completion_evidence_json = NULL, reconciliation_evidence_json = NULL
         WHERE action_key = $8 AND status = 'released'`,
        [input.actor_principal, 'recovery', 'recovery', 1, nextToken, now, expiresAt, actionKey]
      );
      const row = await selectClaimByActionKey(query, actionKey);
      if (
        row?.claimant_principal !== input.actor_principal ||
        toNumber(row.execution_fencing_token) !== nextToken
      ) {
        return {
          ok: false,
          code: 'claim_conflict',
          message: 'claim_conflict',
          holder: row ? normalizeClaim(row) : null,
        };
      }
      await appendClaimEventWithQuery(
        query,
        {
          claim_id: row.claim_id,
          event_type: 'claim_acquired',
          actor_principal: input.actor_principal,
          actor_kind: 'system',
          execution_fencing_token: nextToken,
          details: { outcome: 'reactivated', action_kind: RECOVERY_ACTION_KIND },
        },
        now
      );
      return { ok: true, claim: normalizeClaim(row), created: true, outcome: 'reactivated' };
    }

    const claimId = randomUUID();
    await query(
      `INSERT INTO board_execution_claims (
         claim_id, motion_id, action_kind, environment, target_sha, action_key, idempotency_key,
         motion_file_path, motion_revision_sha, claimant_principal, claimant_xo_holder_id,
         claimant_xo_lease_id, claimant_xo_fencing_token, execution_fencing_token,
         status, reconciliation_status, effect_attempt_id, effect_attempt_state, effect_armed_at,
         acquired_at, renewed_at, expires_at, released_at, completed_at, external_effect_reference,
         completion_evidence_json, reconciliation_evidence_json
       )
       VALUES (
         $1, $2, $3, $4, $5, $6, $6, $7, $8, $9, 'recovery', 'recovery', 1, 1,
         'active', 'clear', NULL, 'none', NULL, $10, NULL, $11, NULL, NULL, NULL, NULL, NULL
       )
       ON CONFLICT (action_key) DO NOTHING`,
      [
        claimId,
        identity.motion_id,
        identity.action_kind,
        identity.environment,
        identity.target_sha,
        actionKey,
        `overseer://${input.repository}/${input.wo_id}/${input.execution_id}`,
        '0'.repeat(40),
        input.actor_principal,
        now,
        expiresAt,
      ]
    );
    const row = await selectClaimByActionKey(query, actionKey);
    if (row?.claim_id !== claimId) {
      return {
        ok: false,
        code: 'claim_conflict',
        message: 'claim_conflict',
        holder: row ? normalizeClaim(row) : null,
      };
    }
    await appendClaimEventWithQuery(
      query,
      {
        claim_id: claimId,
        event_type: 'claim_acquired',
        actor_principal: input.actor_principal,
        actor_kind: 'system',
        execution_fencing_token: 1,
        details: { outcome: 'acquired', action_kind: RECOVERY_ACTION_KIND },
      },
      now
    );
    return { ok: true, claim: normalizeClaim(row), created: true, outcome: 'acquired' };
  });
}

export async function validateRecoveryExecutionFence(
  input: RecoveryFenceInput
): Promise<PreEffectResult> {
  const db = getDatabase();
  return db.withTransaction(async query => {
    const now = await txNow(query);
    const claim = await selectClaimById(query, input.claim_id);
    if (!claim) return { ok: false, code: 'not_found', message: 'claim_not_found' };
    if (claim.action_kind !== RECOVERY_ACTION_KIND || claim.environment !== RECOVERY_ENVIRONMENT) {
      return { ok: false, code: 'authority_rejected', message: 'not_recovery_claim' };
    }
    if (claim.status !== 'active')
      return { ok: false, code: 'stale_fence', message: 'claim_not_active' };
    if (claim.claimant_principal !== input.actor_principal) {
      return { ok: false, code: 'authority_rejected', message: 'claimant_mismatch' };
    }
    if (toNumber(claim.execution_fencing_token) !== input.execution_fencing_token) {
      return { ok: false, code: 'stale_fence', message: 'stale_execution_fence' };
    }
    if (claim.expires_at <= now) {
      return { ok: false, code: 'stale_fence', message: 'claim_expired' };
    }
    if (claim.reconciliation_status === 'required' || claim.effect_attempt_state !== 'none') {
      return { ok: false, code: 'reconciliation_required', message: 'reconciliation_required' };
    }

    const effectAttemptId = randomUUID();
    await query(
      `UPDATE board_execution_claims
         SET effect_attempt_id = $1, effect_attempt_state = 'armed', effect_armed_at = $2,
             reconciliation_status = 'required'
       WHERE claim_id = $3 AND status = 'active' AND execution_fencing_token = $4
         AND effect_attempt_state = 'none'`,
      [effectAttemptId, now, input.claim_id, input.execution_fencing_token]
    );
    const row = await selectClaimById(query, input.claim_id);
    if (row?.effect_attempt_id !== effectAttemptId || row.effect_attempt_state !== 'armed') {
      return { ok: false, code: 'reconciliation_required', message: 'arm_conflict' };
    }
    await appendClaimEventWithQuery(
      query,
      {
        claim_id: input.claim_id,
        event_type: 'claim_effect_armed',
        actor_principal: input.actor_principal,
        actor_kind: 'system',
        execution_fencing_token: input.execution_fencing_token,
        details: { effect_attempt_id: effectAttemptId, action_kind: RECOVERY_ACTION_KIND },
      },
      now
    );
    return {
      ok: true,
      claim_id: input.claim_id,
      permitted: true,
      effect_attempt_id: effectAttemptId,
      execution_fencing_token: input.execution_fencing_token,
      motion_revision_sha: row.motion_revision_sha,
    };
  });
}

export async function releaseRecoveryExecutionClaim(
  input: RecoveryFenceInput
): Promise<ClaimMutationResult> {
  const db = getDatabase();
  return db.withTransaction(async query => {
    const now = await txNow(query);
    const claim = await selectClaimById(query, input.claim_id);
    if (!claim) return { ok: false, code: 'not_found', message: 'claim_not_found' };
    if (claim.action_kind !== RECOVERY_ACTION_KIND || claim.environment !== RECOVERY_ENVIRONMENT) {
      return { ok: false, code: 'authority_rejected', message: 'not_recovery_claim' };
    }
    if (claim.status !== 'active')
      return { ok: false, code: 'stale_fence', message: 'claim_not_active' };
    if (claim.claimant_principal !== input.actor_principal) {
      return { ok: false, code: 'authority_rejected', message: 'claimant_mismatch' };
    }
    if (toNumber(claim.execution_fencing_token) !== input.execution_fencing_token) {
      return { ok: false, code: 'stale_fence', message: 'stale_execution_fence' };
    }
    await query(
      `UPDATE board_execution_claims
         SET status = 'released', reconciliation_status = 'clear',
             effect_attempt_state = 'none', effect_attempt_id = NULL, effect_armed_at = NULL,
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
        actor_principal: input.actor_principal,
        actor_kind: 'system',
        execution_fencing_token: input.execution_fencing_token,
        details: { released_at: now, action_kind: RECOVERY_ACTION_KIND },
      },
      now
    );
    return { ok: true, claim: normalizeClaim(row) };
  });
}

export async function completeRecoveryExecutionClaim(
  input: CompleteRecoveryExecutionClaimInput
): Promise<ClaimMutationResult> {
  const db = getDatabase();
  return db.withTransaction(async query => {
    const now = await txNow(query);
    const claim = await selectClaimById(query, input.claim_id);
    if (!claim) return { ok: false, code: 'not_found', message: 'claim_not_found' };
    if (claim.action_kind !== RECOVERY_ACTION_KIND || claim.environment !== RECOVERY_ENVIRONMENT) {
      return { ok: false, code: 'authority_rejected', message: 'not_recovery_claim' };
    }
    if (claim.status !== 'active' || claim.effect_attempt_state !== 'armed') {
      return { ok: false, code: 'effect_attempt_mismatch', message: 'claim_not_armed' };
    }
    if (claim.claimant_principal !== input.actor_principal) {
      return { ok: false, code: 'authority_rejected', message: 'claimant_mismatch' };
    }
    if (claim.effect_attempt_id !== input.effect_attempt_id) {
      return { ok: false, code: 'effect_attempt_mismatch', message: 'effect_attempt_mismatch' };
    }
    if (toNumber(claim.execution_fencing_token) !== input.execution_fencing_token) {
      return { ok: false, code: 'stale_fence', message: 'stale_execution_fence' };
    }
    if (!input.external_effect_reference) {
      return {
        ok: false,
        code: 'validation_failed',
        message: 'external_effect_reference_required',
      };
    }
    await query(
      `UPDATE board_execution_claims
         SET status = 'completed', reconciliation_status = 'clear',
             effect_attempt_state = 'completed', completed_at = $1,
             external_effect_reference = $2, completion_evidence_json = $3
       WHERE claim_id = $4 AND status = 'active' AND effect_attempt_state = 'armed'
         AND execution_fencing_token = $5 AND effect_attempt_id = $6`,
      [
        now,
        input.external_effect_reference,
        JSON.stringify(input.evidence),
        input.claim_id,
        input.execution_fencing_token,
        input.effect_attempt_id,
      ]
    );
    const row = await selectClaimById(query, input.claim_id);
    if (row?.status !== 'completed') {
      return { ok: false, code: 'effect_attempt_mismatch', message: 'complete_conflict' };
    }
    await appendClaimEventWithQuery(
      query,
      {
        claim_id: input.claim_id,
        event_type: 'claim_completed',
        actor_principal: input.actor_principal,
        actor_kind: 'system',
        execution_fencing_token: input.execution_fencing_token,
        details: {
          effect_attempt_id: input.effect_attempt_id,
          external_effect_reference: input.external_effect_reference,
          action_kind: RECOVERY_ACTION_KIND,
        },
      },
      now
    );
    return { ok: true, claim: normalizeClaim(row) };
  });
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function getExecutionClaim(
  identity: ActionIdentity
): Promise<ExecutionClaimResponse | null> {
  const actionKey = computeActionKey(identity);
  const result = await getDatabase().query<ClaimRow>(
    'SELECT * FROM board_execution_claims WHERE action_key = $1',
    [actionKey]
  );
  return result.rows[0] ? normalizeClaim(result.rows[0]) : null;
}
