/**
 * M-31 Overseer merge-steward evidence, proposal, and permit substrate
 * (M-42 Slice 2).
 *
 * Append-only persistence for immutable live-state snapshots, explicit sorted PR
 * membership, discrepancies, exact expiring action proposals, and single-use
 * compare-and-consume execution receipts. The final `compareAndConsumeM31Proposal`
 * revalidates a live observation against the exact bound proposal inside the
 * M-31 60-second validity window and consumes one execution ID exactly once,
 * returning a short-lived, single-use action PERMIT.
 *
 * Boundary (M-42 Slice 2): this module performs NO provider mutation. Receipts
 * store no provider atomic operation, and no GitHub/Fusion/deploy client is
 * reachable from here. Permit issuance is preparation only; it authorizes
 * nothing on its own and activates no capability.
 *
 * Prior art reused (do not fork): `getDatabase()`/`IDatabase.withTransaction()`
 * in ./connection + ./adapters/types, the fenced single-use pattern in
 * ./execution-claims, and the append-only audit pattern in ./board-authority.
 */
import { createHash, randomUUID } from 'crypto';
import { getDatabase } from './connection';
import type { IDatabase } from './adapters/types';

type TxQuery = Parameters<Parameters<IDatabase['withTransaction']>[0]>[0];

/** Frozen contract schema version (see docs/contracts/overseer-m31-substrate-v1.md). */
export const M31_SCHEMA_VERSION = 'm31-substrate-v1';

/** Default final-observation validity window (M-31 60-second rule). */
export const M31_OBSERVATION_VALIDITY_MS = 60_000;

/** Default proposal time-to-live (proposal life, distinct from the 60s window). */
export const M31_DEFAULT_PROPOSAL_TTL_MS = 15 * 60_000;

/**
 * Closed action-kind vocabulary (M-31, verbatim). A disposition such as READY,
 * DUPLICATE, SUPERSEDED, or HOLD is never an action kind or authority.
 */
export const M31_ACTION_KINDS = [
  'MERGE',
  'CLOSE',
  'REOPEN',
  'REFRESH',
  'REBASE',
  'PUSH',
  'RETARGET',
  'REPAIR',
  'REFIRE',
  'COMMENT',
  'LABEL',
  'ASSIGN',
  'REVIEW',
  'STAGING_MUTATION',
  'PRODUCTION_MUTATION',
  'DEPLOY',
] as const;

export type M31ActionKind = (typeof M31_ACTION_KINDS)[number];

/** Required typed failures (M-31, verbatim closed set). */
export const M31_TYPED_FAILURES = [
  'snapshot_invalid',
  'snapshot_not_chain_tip',
  'snapshot_forked',
  'predecessor_missing',
  'predecessor_digest_mismatch',
  'discrepancy_unresolved',
  'evidence_missing',
  'evidence_conflicting',
  'evidence_stale',
  'proposal_expired',
  'proposal_replayed',
  'execution_id_conflict',
  'live_state_unknown',
  'live_state_mismatch',
  'observation_stale',
  'policy_digest_mismatch',
  'verifier_registry_mismatch',
] as const;

export type M31TypedFailure = (typeof M31_TYPED_FAILURES)[number];

/** Frozen capability mapping: one capability string per action kind. */
export function capabilityForActionKind(kind: M31ActionKind): string {
  return `overseer.m31.${kind.toLowerCase()}`;
}

export function isM31ActionKind(value: string): value is M31ActionKind {
  return (M31_ACTION_KINDS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Public data shapes
// ---------------------------------------------------------------------------

export interface M31SnapshotMemberInput {
  readonly pr_number: number;
  readonly head_sha: string;
  readonly base_branch: string;
  readonly base_sha: string;
  readonly state: string;
  readonly checks?: unknown;
  readonly check_source_sha: string;
  readonly checks_observed_at: string;
  readonly review_state: string;
  readonly mergeability: string;
  readonly merge_state_status: string;
  readonly linked_work_evidence?: unknown;
  readonly evidence_artifact_path: string;
  readonly git_object_format: 'sha1' | 'sha256';
  readonly evidence_git_blob: string;
  readonly observed_at: string;
}

export interface M31SnapshotMember extends Omit<
  M31SnapshotMemberInput,
  'checks' | 'linked_work_evidence'
> {
  readonly snapshot_id: string;
  readonly ordinal: number;
  readonly checks: unknown;
  readonly linked_work_evidence: unknown;
}

export interface RegisterM31SnapshotInput {
  readonly snapshot_id?: string;
  readonly repository: string;
  readonly capture_started_at: string;
  readonly capture_completed_at: string;
  readonly operator_actor: string;
  readonly operator_model: string;
  readonly read_only_query_method: string;
  readonly base_branch: string;
  readonly base_sha: string;
  readonly predecessor_snapshot_id?: string | null;
  readonly predecessor_evidence_git_blob?: string | null;
  readonly artifact_path: string;
  readonly git_object_format: 'sha1' | 'sha256';
  readonly evidence_git_blob: string;
  readonly mutation_attempted?: boolean;
  readonly fusion_calls_attempted?: number;
  readonly members: readonly M31SnapshotMemberInput[];
  readonly now?: string;
}

export interface M31Snapshot {
  readonly snapshot_id: string;
  readonly schema_version: string;
  readonly repository: string;
  readonly capture_started_at: string;
  readonly capture_completed_at: string;
  readonly operator_actor: string;
  readonly operator_model: string;
  readonly read_only_query_method: string;
  readonly base_branch: string;
  readonly base_sha: string;
  readonly predecessor_snapshot_id: string | null;
  readonly predecessor_evidence_git_blob: string | null;
  readonly artifact_path: string;
  readonly git_object_format: string;
  readonly evidence_git_blob: string;
  readonly mutation_attempted: boolean;
  readonly mutation_succeeded: boolean;
  readonly fusion_calls_attempted: number;
  readonly fusion_calls_succeeded: number;
  readonly created_at: string;
  readonly members: readonly M31SnapshotMember[];
}

export interface AppendM31DiscrepancyInput {
  readonly snapshot_id: string;
  readonly evidence_git_blob: string;
  readonly affected_rows: unknown;
  readonly observed_conflict: string;
  readonly recorder: string;
  readonly resolution?: string | null;
  readonly predecessor_discrepancy_id?: string | null;
  readonly now?: string;
}

export interface M31Discrepancy {
  readonly discrepancy_id: string;
  readonly snapshot_id: string;
  readonly evidence_git_blob: string;
  readonly affected_rows: unknown;
  readonly observed_conflict: string;
  readonly recorder: string;
  readonly recorded_at: string;
  readonly resolution: string | null;
  readonly predecessor_discrepancy_id: string | null;
}

export interface M31ChainAssessment {
  readonly repository: string;
  readonly snapshot_count: number;
  readonly tip_snapshot_id: string | null;
  readonly forked: boolean;
  readonly predecessor_missing: boolean;
  readonly predecessor_digest_mismatch: boolean;
  readonly unresolved_discrepancies: number;
}

export interface CreateM31ActionProposalInput {
  readonly proposal_id?: string;
  readonly repository: string;
  readonly pr_number: number;
  readonly head_sha: string;
  readonly base_branch: string;
  readonly base_sha: string;
  readonly snapshot_id: string;
  readonly evidence_path: string;
  readonly action_kind: M31ActionKind;
  readonly action_parameters: unknown;
  readonly actor: string;
  readonly policy_digest: string;
  readonly verifier_registry_digest: string;
  readonly ttl_ms?: number;
  readonly max_evidence_age_ms?: number;
  readonly now?: string;
}

export interface M31ActionProposal {
  readonly proposal_id: string;
  readonly repository: string;
  readonly pr_number: number;
  readonly head_sha: string;
  readonly base_branch: string;
  readonly base_sha: string;
  readonly snapshot_id: string;
  readonly evidence_path: string;
  readonly evidence_git_blob: string;
  readonly action_kind: M31ActionKind;
  readonly action_parameters: unknown;
  readonly actor: string;
  readonly created_at: string;
  readonly expires_at: string;
  readonly execution_id: string;
  readonly capability: string;
  readonly policy_digest: string;
  readonly verifier_registry_digest: string;
}

/**
 * Exact bound live observation obtained WITHOUT mutation. `known: false` maps to
 * the `live_state_unknown` typed failure.
 */
export interface M31LiveObservation {
  readonly known: boolean;
  readonly repository: string;
  readonly pr_number: number;
  readonly head_sha: string;
  readonly base_branch: string;
  readonly base_sha: string;
  readonly policy_digest: string;
  readonly verifier_registry_digest: string;
  readonly observed_at: string;
}

export interface M31ActionPermit {
  readonly permit_id: string;
  readonly proposal_id: string;
  readonly execution_id: string;
  readonly repository: string;
  readonly pr_number: number;
  readonly head_sha: string;
  readonly base_branch: string;
  readonly base_sha: string;
  readonly snapshot_id: string;
  readonly action_kind: M31ActionKind;
  readonly capability: string;
  readonly issued_at: string;
  readonly valid_until: string;
}

export interface M31ExecutionReceipt {
  readonly receipt_id: string;
  readonly proposal_id: string;
  readonly execution_id: string;
  readonly snapshot_id: string;
  readonly live_observation: unknown;
  readonly live_observation_digest: string;
  readonly revalidated_at: string;
  readonly valid_until: string;
  readonly compare_result: 'permit_issued';
  readonly provider_atomic_operation: null;
  readonly created_at: string;
}

export interface CompareAndConsumeM31Input {
  readonly proposal_id: string;
  readonly observation: M31LiveObservation;
  readonly validity_window_ms?: number;
  readonly now?: string;
}

export type M31Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: M31TypedFailure };

export type M31PermitResult =
  | { readonly ok: true; readonly permit: M31ActionPermit; readonly receipt: M31ExecutionReceipt }
  | { readonly ok: false; readonly failure: M31TypedFailure };

/** Thrown by compare-and-consume when the referenced proposal row is absent. */
export class M31ProposalNotFoundError extends Error {
  constructor(proposalId: string) {
    super(`m31_proposal_not_found:${proposalId}`);
    this.name = 'M31ProposalNotFoundError';
  }
}

// ---------------------------------------------------------------------------
// Deterministic helpers
// ---------------------------------------------------------------------------

function toNumber(value: number | string): number {
  return typeof value === 'number' ? value : Number(value);
}

function toBool(value: number | string | boolean): boolean {
  if (typeof value === 'boolean') return value;
  return toNumber(value) === 1;
}

function parseJson(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

/** Stable canonical JSON stringify with recursively sorted object keys. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0
    );
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) out[k] = sortValue(v);
    return out;
  }
  return value;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
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

function bit(value: boolean): number {
  return value ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface SnapshotRow {
  readonly snapshot_id: string;
  readonly schema_version: string;
  readonly repository: string;
  readonly capture_started_at: string;
  readonly capture_completed_at: string;
  readonly operator_actor: string;
  readonly operator_model: string;
  readonly read_only_query_method: string;
  readonly base_branch: string;
  readonly base_sha: string;
  readonly predecessor_snapshot_id: string | null;
  readonly predecessor_evidence_git_blob: string | null;
  readonly artifact_path: string;
  readonly git_object_format: string;
  readonly evidence_git_blob: string;
  readonly mutation_attempted: number | string | boolean;
  readonly mutation_succeeded: number | string | boolean;
  readonly fusion_calls_attempted: number | string;
  readonly fusion_calls_succeeded: number | string;
  readonly created_at: string;
}

interface MemberRow {
  readonly snapshot_id: string;
  readonly ordinal: number | string;
  readonly pr_number: number | string;
  readonly head_sha: string;
  readonly base_branch: string;
  readonly base_sha: string;
  readonly state: string;
  readonly checks_json: unknown;
  readonly check_source_sha: string;
  readonly checks_observed_at: string;
  readonly review_state: string;
  readonly mergeability: string;
  readonly merge_state_status: string;
  readonly linked_work_evidence_json: unknown;
  readonly evidence_artifact_path: string;
  readonly git_object_format: string;
  readonly evidence_git_blob: string;
  readonly observed_at: string;
}

interface ProposalRow {
  readonly proposal_id: string;
  readonly repository: string;
  readonly pr_number: number | string;
  readonly head_sha: string;
  readonly base_branch: string;
  readonly base_sha: string;
  readonly snapshot_id: string;
  readonly evidence_path: string;
  readonly evidence_git_blob: string;
  readonly action_kind: string;
  readonly action_parameters_json: unknown;
  readonly actor: string;
  readonly created_at: string;
  readonly expires_at: string;
  readonly execution_id: string;
  readonly capability: string;
  readonly policy_digest: string;
  readonly verifier_registry_digest: string;
}

interface ReceiptRow {
  readonly receipt_id: string;
  readonly proposal_id: string;
  readonly execution_id: string;
  readonly snapshot_id: string;
  readonly live_observation_json: unknown;
  readonly live_observation_digest: string;
  readonly revalidated_at: string;
  readonly valid_until: string;
  readonly compare_result: string;
  readonly provider_atomic_operation: string | null;
  readonly created_at: string;
}

function normalizeMember(row: MemberRow): M31SnapshotMember {
  return {
    snapshot_id: row.snapshot_id,
    ordinal: toNumber(row.ordinal),
    pr_number: toNumber(row.pr_number),
    head_sha: row.head_sha,
    base_branch: row.base_branch,
    base_sha: row.base_sha,
    state: row.state,
    checks: parseJson(row.checks_json),
    check_source_sha: row.check_source_sha,
    checks_observed_at: row.checks_observed_at,
    review_state: row.review_state,
    mergeability: row.mergeability,
    merge_state_status: row.merge_state_status,
    linked_work_evidence: parseJson(row.linked_work_evidence_json),
    evidence_artifact_path: row.evidence_artifact_path,
    git_object_format: row.git_object_format as 'sha1' | 'sha256',
    evidence_git_blob: row.evidence_git_blob,
    observed_at: row.observed_at,
  };
}

function normalizeSnapshot(row: SnapshotRow, members: readonly MemberRow[]): M31Snapshot {
  return {
    snapshot_id: row.snapshot_id,
    schema_version: row.schema_version,
    repository: row.repository,
    capture_started_at: row.capture_started_at,
    capture_completed_at: row.capture_completed_at,
    operator_actor: row.operator_actor,
    operator_model: row.operator_model,
    read_only_query_method: row.read_only_query_method,
    base_branch: row.base_branch,
    base_sha: row.base_sha,
    predecessor_snapshot_id: row.predecessor_snapshot_id,
    predecessor_evidence_git_blob: row.predecessor_evidence_git_blob,
    artifact_path: row.artifact_path,
    git_object_format: row.git_object_format,
    evidence_git_blob: row.evidence_git_blob,
    mutation_attempted: toBool(row.mutation_attempted),
    mutation_succeeded: toBool(row.mutation_succeeded),
    fusion_calls_attempted: toNumber(row.fusion_calls_attempted),
    fusion_calls_succeeded: toNumber(row.fusion_calls_succeeded),
    created_at: row.created_at,
    members: members.map(normalizeMember),
  };
}

function normalizeProposal(row: ProposalRow): M31ActionProposal {
  return {
    proposal_id: row.proposal_id,
    repository: row.repository,
    pr_number: toNumber(row.pr_number),
    head_sha: row.head_sha,
    base_branch: row.base_branch,
    base_sha: row.base_sha,
    snapshot_id: row.snapshot_id,
    evidence_path: row.evidence_path,
    evidence_git_blob: row.evidence_git_blob,
    action_kind: row.action_kind as M31ActionKind,
    action_parameters: parseJson(row.action_parameters_json),
    actor: row.actor,
    created_at: row.created_at,
    expires_at: row.expires_at,
    execution_id: row.execution_id,
    capability: row.capability,
    policy_digest: row.policy_digest,
    verifier_registry_digest: row.verifier_registry_digest,
  };
}

function normalizeReceipt(row: ReceiptRow): M31ExecutionReceipt {
  return {
    receipt_id: row.receipt_id,
    proposal_id: row.proposal_id,
    execution_id: row.execution_id,
    snapshot_id: row.snapshot_id,
    live_observation: parseJson(row.live_observation_json),
    live_observation_digest: row.live_observation_digest,
    revalidated_at: row.revalidated_at,
    valid_until: row.valid_until,
    compare_result: 'permit_issued',
    provider_atomic_operation: null,
    created_at: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// Snapshot registration + reads
// ---------------------------------------------------------------------------

async function selectSnapshotRow(
  query: TxQuery,
  snapshotId: string
): Promise<SnapshotRow | undefined> {
  const result = await query<SnapshotRow>(
    'SELECT * FROM overseer_m31_snapshots WHERE snapshot_id = $1',
    [snapshotId]
  );
  return result.rows[0];
}

async function selectMemberRows(query: TxQuery, snapshotId: string): Promise<MemberRow[]> {
  const result = await query<MemberRow>(
    'SELECT * FROM overseer_m31_snapshot_members WHERE snapshot_id = $1 ORDER BY ordinal ASC',
    [snapshotId]
  );
  return [...result.rows];
}

/** Deterministic membership order: ascending PR number, then head SHA. */
function sortMembers(
  members: readonly M31SnapshotMemberInput[]
): readonly M31SnapshotMemberInput[] {
  return [...members].sort((a, b) => {
    if (a.pr_number !== b.pr_number) return a.pr_number - b.pr_number;
    return a.head_sha < b.head_sha ? -1 : a.head_sha > b.head_sha ? 1 : 0;
  });
}

export async function registerM31Snapshot(input: RegisterM31SnapshotInput): Promise<M31Snapshot> {
  const db = getDatabase();
  return db.withTransaction(async query => {
    const now = input.now ?? (await txNow(query));
    const snapshotId = input.snapshot_id ?? randomUUID();
    const predecessorId = input.predecessor_snapshot_id ?? null;
    const predecessorBlob = input.predecessor_evidence_git_blob ?? null;

    await query(
      `INSERT INTO overseer_m31_snapshots (
         snapshot_id, schema_version, repository, capture_started_at, capture_completed_at,
         operator_actor, operator_model, read_only_query_method, base_branch, base_sha,
         predecessor_snapshot_id, predecessor_evidence_git_blob, artifact_path, git_object_format,
         evidence_git_blob, mutation_attempted, mutation_succeeded, fusion_calls_attempted,
         fusion_calls_succeeded, created_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 0, $17, 0, $18
       )`,
      [
        snapshotId,
        M31_SCHEMA_VERSION,
        input.repository,
        input.capture_started_at,
        input.capture_completed_at,
        input.operator_actor,
        input.operator_model,
        input.read_only_query_method,
        input.base_branch,
        input.base_sha,
        predecessorId,
        predecessorBlob,
        input.artifact_path,
        input.git_object_format,
        input.evidence_git_blob,
        bit(input.mutation_attempted ?? false),
        input.fusion_calls_attempted ?? 0,
        now,
      ]
    );

    const ordered = sortMembers(input.members);
    let ordinal = 0;
    for (const member of ordered) {
      await query(
        `INSERT INTO overseer_m31_snapshot_members (
           snapshot_id, ordinal, pr_number, head_sha, base_branch, base_sha, state, checks_json,
           check_source_sha, checks_observed_at, review_state, mergeability, merge_state_status,
           linked_work_evidence_json, evidence_artifact_path, git_object_format, evidence_git_blob,
           observed_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
        [
          snapshotId,
          ordinal,
          member.pr_number,
          member.head_sha,
          member.base_branch,
          member.base_sha,
          member.state,
          JSON.stringify(member.checks ?? null),
          member.check_source_sha,
          member.checks_observed_at,
          member.review_state,
          member.mergeability,
          member.merge_state_status,
          JSON.stringify(member.linked_work_evidence ?? null),
          member.evidence_artifact_path,
          member.git_object_format,
          member.evidence_git_blob,
          member.observed_at,
        ]
      );
      ordinal += 1;
    }

    const snapshotRow = await selectSnapshotRow(query, snapshotId);
    if (!snapshotRow) throw new Error('m31_snapshot_insert_failed');
    const memberRows = await selectMemberRows(query, snapshotId);
    return normalizeSnapshot(snapshotRow, memberRows);
  });
}

export async function getM31Snapshot(snapshotId: string): Promise<M31Snapshot | null> {
  const db = getDatabase();
  const snapshotResult = await db.query<SnapshotRow>(
    'SELECT * FROM overseer_m31_snapshots WHERE snapshot_id = $1',
    [snapshotId]
  );
  const snapshotRow = snapshotResult.rows[0];
  if (!snapshotRow) return null;
  const memberResult = await db.query<MemberRow>(
    'SELECT * FROM overseer_m31_snapshot_members WHERE snapshot_id = $1 ORDER BY ordinal ASC',
    [snapshotId]
  );
  return normalizeSnapshot(snapshotRow, memberResult.rows);
}

// ---------------------------------------------------------------------------
// Discrepancies
// ---------------------------------------------------------------------------

export async function appendM31Discrepancy(
  input: AppendM31DiscrepancyInput
): Promise<M31Discrepancy> {
  const db = getDatabase();
  return db.withTransaction(async query => {
    const now = input.now ?? (await txNow(query));
    const discrepancyId = randomUUID();
    await query(
      `INSERT INTO overseer_m31_discrepancies (
         discrepancy_id, snapshot_id, evidence_git_blob, affected_rows_json, observed_conflict,
         recorder, recorded_at, resolution, predecessor_discrepancy_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        discrepancyId,
        input.snapshot_id,
        input.evidence_git_blob,
        JSON.stringify(input.affected_rows ?? null),
        input.observed_conflict,
        input.recorder,
        now,
        input.resolution ?? null,
        input.predecessor_discrepancy_id ?? null,
      ]
    );
    const result = await query<{
      discrepancy_id: string;
      snapshot_id: string;
      evidence_git_blob: string;
      affected_rows_json: unknown;
      observed_conflict: string;
      recorder: string;
      recorded_at: string;
      resolution: string | null;
      predecessor_discrepancy_id: string | null;
    }>('SELECT * FROM overseer_m31_discrepancies WHERE discrepancy_id = $1', [discrepancyId]);
    const row = result.rows[0];
    if (!row) throw new Error('m31_discrepancy_insert_failed');
    return {
      discrepancy_id: row.discrepancy_id,
      snapshot_id: row.snapshot_id,
      evidence_git_blob: row.evidence_git_blob,
      affected_rows: parseJson(row.affected_rows_json),
      observed_conflict: row.observed_conflict,
      recorder: row.recorder,
      recorded_at: row.recorded_at,
      resolution: row.resolution,
      predecessor_discrepancy_id: row.predecessor_discrepancy_id,
    };
  });
}

// ---------------------------------------------------------------------------
// Chain assessment
// ---------------------------------------------------------------------------

async function assessChain(query: TxQuery, repository: string): Promise<M31ChainAssessment> {
  const snapshotsResult = await query<{
    snapshot_id: string;
    predecessor_snapshot_id: string | null;
    predecessor_evidence_git_blob: string | null;
    evidence_git_blob: string;
    created_at: string;
  }>(
    `SELECT snapshot_id, predecessor_snapshot_id, predecessor_evidence_git_blob,
            evidence_git_blob, created_at
       FROM overseer_m31_snapshots WHERE repository = $1 ORDER BY created_at ASC`,
    [repository]
  );
  const snapshots = snapshotsResult.rows;
  const byId = new Map(snapshots.map(s => [s.snapshot_id, s]));

  let predecessorMissing = false;
  let predecessorDigestMismatch = false;
  const childCountByPredecessor = new Map<string, number>();
  const referenced = new Set<string>();
  let genesisCount = 0;

  for (const snap of snapshots) {
    if (snap.predecessor_snapshot_id === null) {
      genesisCount += 1;
      continue;
    }
    referenced.add(snap.predecessor_snapshot_id);
    childCountByPredecessor.set(
      snap.predecessor_snapshot_id,
      (childCountByPredecessor.get(snap.predecessor_snapshot_id) ?? 0) + 1
    );
    const predecessor = byId.get(snap.predecessor_snapshot_id);
    if (!predecessor) {
      predecessorMissing = true;
      continue;
    }
    if (predecessor.evidence_git_blob !== snap.predecessor_evidence_git_blob) {
      predecessorDigestMismatch = true;
    }
  }

  const forkByPredecessor = [...childCountByPredecessor.values()].some(count => count > 1);
  const forked = forkByPredecessor || genesisCount > 1;

  const tips = snapshots.filter(s => !referenced.has(s.snapshot_id));
  const tipSnapshotId = tips.length === 1 ? (tips[0]?.snapshot_id ?? null) : null;

  const discrepancyResult = await query<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM overseer_m31_discrepancies d
       JOIN overseer_m31_snapshots s ON s.snapshot_id = d.snapshot_id
      WHERE s.repository = $1 AND d.resolution IS NULL`,
    [repository]
  );
  const unresolvedDiscrepancies = toNumber(discrepancyResult.rows[0]?.n ?? 0);

  return {
    repository,
    snapshot_count: snapshots.length,
    tip_snapshot_id: tips.length > 1 ? null : tipSnapshotId,
    forked,
    predecessor_missing: predecessorMissing,
    predecessor_digest_mismatch: predecessorDigestMismatch,
    unresolved_discrepancies: unresolvedDiscrepancies,
  };
}

export async function getM31ChainAssessment(repository: string): Promise<M31ChainAssessment> {
  const db = getDatabase();
  return db.withTransaction(query => assessChain(query, repository));
}

// ---------------------------------------------------------------------------
// Proposal creation + reads
// ---------------------------------------------------------------------------

export async function createM31ActionProposal(
  input: CreateM31ActionProposalInput
): Promise<M31Result<M31ActionProposal>> {
  if (!isM31ActionKind(input.action_kind)) {
    return { ok: false, failure: 'evidence_conflicting' };
  }
  const db = getDatabase();
  return db.withTransaction(async query => {
    const now = input.now ?? (await txNow(query));

    const snapshotRow = await selectSnapshotRow(query, input.snapshot_id);
    if (snapshotRow?.repository !== input.repository) {
      return { ok: false as const, failure: 'snapshot_invalid' as const };
    }

    const chain = await assessChain(query, snapshotRow.repository);
    if (chain.predecessor_missing) {
      return { ok: false as const, failure: 'predecessor_missing' as const };
    }
    if (chain.predecessor_digest_mismatch) {
      return { ok: false as const, failure: 'predecessor_digest_mismatch' as const };
    }
    if (chain.forked) {
      return { ok: false as const, failure: 'snapshot_forked' as const };
    }
    if (chain.tip_snapshot_id !== input.snapshot_id) {
      return { ok: false as const, failure: 'snapshot_not_chain_tip' as const };
    }
    if (chain.unresolved_discrepancies > 0) {
      return { ok: false as const, failure: 'discrepancy_unresolved' as const };
    }

    const memberResult = await query<MemberRow>(
      'SELECT * FROM overseer_m31_snapshot_members WHERE snapshot_id = $1 AND pr_number = $2',
      [input.snapshot_id, input.pr_number]
    );
    const member = memberResult.rows[0];
    if (!member?.evidence_git_blob) {
      return { ok: false as const, failure: 'evidence_missing' as const };
    }
    if (
      member.head_sha !== input.head_sha ||
      member.base_branch !== input.base_branch ||
      member.base_sha !== input.base_sha
    ) {
      return { ok: false as const, failure: 'evidence_conflicting' as const };
    }
    if (input.max_evidence_age_ms !== undefined) {
      const ageMs = new Date(now).getTime() - new Date(member.observed_at).getTime();
      if (ageMs > input.max_evidence_age_ms) {
        return { ok: false as const, failure: 'evidence_stale' as const };
      }
    }

    const proposalId = input.proposal_id ?? randomUUID();
    const executionId = randomUUID();
    const capability = capabilityForActionKind(input.action_kind);
    const expiresAt = addMillisecondsIso(now, input.ttl_ms ?? M31_DEFAULT_PROPOSAL_TTL_MS);

    await query(
      `INSERT INTO overseer_m31_action_proposals (
         proposal_id, repository, pr_number, head_sha, base_branch, base_sha, snapshot_id,
         evidence_path, evidence_git_blob, action_kind, action_parameters_json, actor,
         created_at, expires_at, execution_id, capability, policy_digest, verifier_registry_digest
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
      [
        proposalId,
        input.repository,
        input.pr_number,
        input.head_sha,
        input.base_branch,
        input.base_sha,
        input.snapshot_id,
        input.evidence_path,
        member.evidence_git_blob,
        input.action_kind,
        JSON.stringify(input.action_parameters ?? null),
        input.actor,
        now,
        expiresAt,
        executionId,
        capability,
        input.policy_digest,
        input.verifier_registry_digest,
      ]
    );

    const row = (
      await query<ProposalRow>(
        'SELECT * FROM overseer_m31_action_proposals WHERE proposal_id = $1',
        [proposalId]
      )
    ).rows[0];
    if (!row) throw new Error('m31_proposal_insert_failed');
    return { ok: true as const, value: normalizeProposal(row) };
  });
}

export async function getM31ActionProposal(proposalId: string): Promise<M31ActionProposal | null> {
  const result = await getDatabase().query<ProposalRow>(
    'SELECT * FROM overseer_m31_action_proposals WHERE proposal_id = $1',
    [proposalId]
  );
  return result.rows[0] ? normalizeProposal(result.rows[0]) : null;
}

// ---------------------------------------------------------------------------
// Final compare-and-consume (single-use permit issuance)
// ---------------------------------------------------------------------------

async function selectReceiptByProposal(
  query: TxQuery,
  proposalId: string
): Promise<ReceiptRow | undefined> {
  const result = await query<ReceiptRow>(
    'SELECT * FROM overseer_m31_execution_receipts WHERE proposal_id = $1',
    [proposalId]
  );
  return result.rows[0];
}

async function selectReceiptByExecution(
  query: TxQuery,
  executionId: string
): Promise<ReceiptRow | undefined> {
  const result = await query<ReceiptRow>(
    'SELECT * FROM overseer_m31_execution_receipts WHERE execution_id = $1',
    [executionId]
  );
  return result.rows[0];
}

/**
 * Transactionally compare the bound proposal against a fresh live observation
 * and consume its unique execution ID exactly once. Fails closed on every
 * unknown/stale/conflicting/expired/replayed condition BEFORE any receipt is
 * written. Never reaches an external provider dependency.
 */
export async function compareAndConsumeM31Proposal(
  input: CompareAndConsumeM31Input
): Promise<M31PermitResult> {
  const db = getDatabase();
  const validityMs = input.validity_window_ms ?? M31_OBSERVATION_VALIDITY_MS;
  return db.withTransaction(async query => {
    const now = input.now ?? (await txNow(query));

    const proposalRow = (
      await query<ProposalRow>(
        'SELECT * FROM overseer_m31_action_proposals WHERE proposal_id = $1',
        [input.proposal_id]
      )
    ).rows[0];
    if (!proposalRow) throw new M31ProposalNotFoundError(input.proposal_id);
    const proposal = normalizeProposal(proposalRow);

    // 1. Replay / single-use guard (fail closed before any comparison side effect).
    const existingByProposal = await selectReceiptByProposal(query, proposal.proposal_id);
    if (existingByProposal) return { ok: false, failure: 'proposal_replayed' };
    const existingByExecution = await selectReceiptByExecution(query, proposal.execution_id);
    if (existingByExecution) return { ok: false, failure: 'execution_id_conflict' };

    // 2. Proposal expiry.
    if (new Date(now).getTime() > new Date(proposal.expires_at).getTime()) {
      return { ok: false, failure: 'proposal_expired' };
    }

    // 3. Live observation must be known.
    const obs = input.observation;
    if (!obs.known) return { ok: false, failure: 'live_state_unknown' };

    // 4. Exact bound-identity comparison.
    if (
      obs.repository !== proposal.repository ||
      obs.pr_number !== proposal.pr_number ||
      obs.head_sha !== proposal.head_sha ||
      obs.base_branch !== proposal.base_branch ||
      obs.base_sha !== proposal.base_sha
    ) {
      return { ok: false, failure: 'live_state_mismatch' };
    }
    if (obs.policy_digest !== proposal.policy_digest) {
      return { ok: false, failure: 'policy_digest_mismatch' };
    }
    if (obs.verifier_registry_digest !== proposal.verifier_registry_digest) {
      return { ok: false, failure: 'verifier_registry_mismatch' };
    }

    // 5. M-31 60-second validity window on the bound observation.
    const revalidatedAt = obs.observed_at;
    const validUntil = addMillisecondsIso(revalidatedAt, validityMs);
    if (new Date(now).getTime() > new Date(validUntil).getTime()) {
      return { ok: false, failure: 'observation_stale' };
    }

    // 6. Consume exactly once. ON CONFLICT DO NOTHING is the atomic guard against
    // a concurrent duplicate; a no-op insert means someone else already consumed.
    const receiptId = randomUUID();
    const observationCanonical = canonicalJson(obs);
    const observationDigest = sha256Hex(observationCanonical);
    await query(
      `INSERT INTO overseer_m31_execution_receipts (
         receipt_id, proposal_id, execution_id, snapshot_id, live_observation_json,
         live_observation_digest, revalidated_at, valid_until, compare_result,
         provider_atomic_operation, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'permit_issued', NULL, $9)
       ON CONFLICT DO NOTHING`,
      [
        receiptId,
        proposal.proposal_id,
        proposal.execution_id,
        proposal.snapshot_id,
        observationCanonical,
        observationDigest,
        revalidatedAt,
        validUntil,
        now,
      ]
    );

    const written = (
      await query<ReceiptRow>(
        'SELECT * FROM overseer_m31_execution_receipts WHERE receipt_id = $1',
        [receiptId]
      )
    ).rows[0];
    if (!written) {
      const raced = await selectReceiptByProposal(query, proposal.proposal_id);
      if (raced) return { ok: false, failure: 'proposal_replayed' };
      const racedExec = await selectReceiptByExecution(query, proposal.execution_id);
      if (racedExec) return { ok: false, failure: 'execution_id_conflict' };
      return { ok: false, failure: 'proposal_replayed' };
    }

    const receipt = normalizeReceipt(written);
    const permit: M31ActionPermit = {
      permit_id: receipt.receipt_id,
      proposal_id: proposal.proposal_id,
      execution_id: proposal.execution_id,
      repository: proposal.repository,
      pr_number: proposal.pr_number,
      head_sha: proposal.head_sha,
      base_branch: proposal.base_branch,
      base_sha: proposal.base_sha,
      snapshot_id: proposal.snapshot_id,
      action_kind: proposal.action_kind,
      capability: proposal.capability,
      issued_at: now,
      valid_until: validUntil,
    };
    return { ok: true, permit, receipt };
  });
}
