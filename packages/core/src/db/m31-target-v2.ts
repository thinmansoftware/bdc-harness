import { createHash, randomUUID } from 'crypto';
import { getDatabase } from './connection';
import type { IDatabase } from './adapters/types';
import { M31_ACTION_KINDS, type M31ActionKind, type M31TypedFailure } from './merge-steward';

export type { M31ActionKind } from './merge-steward';

export const M31_TARGET_V2_SCHEMA_VERSION = 'm31-target-v2' as const;
export const M31_TARGET_V2_OBSERVATION_VALIDITY_MS = 60_000;
export const M31_TARGET_V2_DEFAULT_PROPOSAL_TTL_MS = 900_000;

const DIGEST_RE = /^[0-9a-f]{64}$/;
const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type M31TargetV2TypedFailure = M31TypedFailure | 'target_invalid' | 'action_target_mismatch';

export interface M31WorkflowRunTargetV2 {
  readonly target_kind: 'workflow_run';
  readonly repository: string;
  readonly run_id: string;
  readonly wo_id: string;
  readonly workflow_name: string;
  readonly codebase_id: string | null;
  readonly status: string;
  readonly event_tip: string;
  readonly head_sha: string | null;
  readonly base_sha: string | null;
}
export interface M31IssueTargetV2 {
  readonly target_kind: 'issue';
  readonly repository: string;
  readonly issue_number: number;
  readonly provider_node_id: string;
  readonly state: string;
  readonly updated_at: string;
  readonly is_pull_request: false;
}
export interface M31WorkOrderTargetV2 {
  readonly target_kind: 'work_order';
  readonly repository: string;
  readonly wo_id: string;
  readonly spec_path: string;
  readonly spec_revision: string;
  readonly spec_hash: string;
  readonly tracker_issue_number: number;
  readonly tracker_provider_node_id: string;
  readonly tracker_state: string;
  readonly tracker_updated_at: string;
  readonly tracker_is_pull_request: false;
}
export interface M31PullRequestTargetV2 {
  readonly target_kind: 'pull_request';
  readonly repository: string;
  readonly pr_number: number;
  readonly provider_node_id: string;
  readonly head_sha: string;
  readonly base_branch: string;
  readonly base_sha: string;
  readonly state: string;
  readonly updated_at: string;
}
export type M31ActionTargetV2 =
  | M31WorkflowRunTargetV2
  | M31IssueTargetV2
  | M31WorkOrderTargetV2
  | M31PullRequestTargetV2;

export interface M31SnapshotMemberV2Input {
  readonly target: M31ActionTargetV2;
  readonly evidence_artifact_path: string;
  readonly git_object_format: 'sha1' | 'sha256';
  readonly evidence_git_blob: string;
  readonly observed_at: string;
}
export interface RegisterM31SnapshotV2Input {
  readonly snapshot_id?: string;
  readonly repository: string;
  readonly capture_started_at: string;
  readonly capture_completed_at: string;
  readonly operator_actor: string;
  readonly operator_model: string;
  readonly read_only_query_method: string;
  readonly evidence_artifact_path: string;
  readonly git_object_format: 'sha1' | 'sha256';
  readonly evidence_git_blob: string;
  readonly predecessor_snapshot_id?: string | null;
  readonly predecessor_evidence_git_blob?: string | null;
  readonly targets: readonly M31SnapshotMemberV2Input[];
  /** Test-only database clock seam. Never exposed by an HTTP schema. */
  readonly test_clock_now?: string;
}
export interface M31SnapshotMemberV2 extends M31SnapshotMemberV2Input {
  readonly snapshot_id: string;
  readonly ordinal: number;
  readonly target_key: string;
  readonly target_digest: string;
}
export interface M31SnapshotV2 {
  readonly snapshot_id: string;
  readonly schema_version: typeof M31_TARGET_V2_SCHEMA_VERSION;
  readonly repository: string;
  readonly capture_started_at: string;
  readonly capture_completed_at: string;
  readonly operator_actor: string;
  readonly operator_model: string;
  readonly read_only_query_method: string;
  readonly evidence_artifact_path: string;
  readonly git_object_format: 'sha1' | 'sha256';
  readonly evidence_git_blob: string;
  readonly predecessor_snapshot_id: string | null;
  readonly predecessor_evidence_git_blob: string | null;
  readonly created_at: string;
  readonly targets: readonly M31SnapshotMemberV2[];
}
export interface M31ChainAssessmentV2 {
  readonly repository: string;
  readonly snapshot_count: number;
  readonly tip_snapshot_id: string | null;
  readonly forked: boolean;
  readonly predecessor_missing: boolean;
  readonly predecessor_digest_mismatch: boolean;
  readonly unresolved_discrepancies: number;
}
export interface AppendM31DiscrepancyV2Input {
  readonly snapshot_id: string;
  readonly evidence_git_blob: string;
  readonly affected_targets: readonly string[];
  readonly conflict: unknown;
  readonly recorded_by: string;
  readonly resolution?: M31DiscrepancyResolutionV2;
  readonly resolved_by?: string;
  readonly predecessor_discrepancy_id?: string | null;
  /** Test-only database clock seam. Never exposed by an HTTP schema. */
  readonly test_clock_now?: string;
}
export interface M31DiscrepancyResolutionV2 {
  readonly resolves_discrepancy_id: string;
  readonly resolution_code: string;
  readonly evidence_digest: string;
}
export interface M31DiscrepancyV2 {
  readonly discrepancy_id: string;
  readonly snapshot_id: string;
  readonly affected_targets: readonly string[];
  readonly conflict: unknown;
  readonly recorded_by: string;
  readonly recorded_at: string;
  readonly resolution: M31DiscrepancyResolutionV2 | null;
  readonly resolved_by: string | null;
  readonly resolved_at: string | null;
  readonly predecessor_discrepancy_id: string | null;
}

export interface CreateM31ActionProposalV2Input {
  readonly proposal_id?: string;
  readonly repository: string;
  readonly target: M31ActionTargetV2;
  readonly snapshot_id: string;
  readonly evidence_path: string;
  readonly action_kind: M31ActionKind;
  readonly action_parameters: unknown;
  readonly actor: string;
  readonly policy_digest: string;
  readonly verifier_registry_digest: string;
  readonly ttl_ms?: number;
  readonly max_evidence_age_ms?: number;
  /** Test-only database clock seam. Never exposed by an HTTP schema. */
  readonly test_clock_now?: string;
}
export interface M31ActionProposalV2 {
  readonly proposal_id: string;
  readonly repository: string;
  readonly target: M31ActionTargetV2;
  readonly target_key: string;
  readonly target_digest: string;
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
export interface M31LiveObservationV2 {
  readonly known: boolean;
  readonly target: M31ActionTargetV2;
  readonly policy_digest: string;
  readonly verifier_registry_digest: string;
  readonly observed_at: string;
}
export interface M31ActionPermitV2 {
  readonly permit_id: string;
  readonly proposal_id: string;
  readonly execution_id: string;
  readonly repository: string;
  readonly target: M31ActionTargetV2;
  readonly target_key: string;
  readonly target_digest: string;
  readonly snapshot_id: string;
  readonly action_kind: M31ActionKind;
  readonly capability: string;
  readonly issued_at: string;
  readonly valid_until: string;
}
export type M31ReceiptEventTypeV2 =
  | 'permit_issued'
  | 'effect_reserved'
  | 'effect_succeeded'
  | 'effect_failed'
  | 'effect_indeterminate'
  | 'effect_reconciled_succeeded'
  | 'effect_reconciled_failed';
export interface M31ExecutionReceiptEventV2 {
  readonly receipt_event_id: string;
  readonly proposal_id: string;
  readonly execution_id: string;
  readonly event_sequence: number;
  readonly event_type: M31ReceiptEventTypeV2;
  readonly target_kind: M31ActionTargetV2['target_kind'];
  readonly target_key: string;
  readonly target_digest: string;
  readonly live_observation: unknown;
  readonly live_observation_digest: string | null;
  readonly revalidated_at: string | null;
  readonly valid_until: string | null;
  readonly adapter_name: string | null;
  readonly provider_operation: string | null;
  readonly external_effect_reference: string | null;
  readonly reason: string;
  readonly evidence: unknown;
  readonly previous_event_digest: string | null;
  readonly event_digest: string;
  readonly created_at: string;
}

type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: M31TargetV2TypedFailure };
export type M31PermitResultV2 =
  | {
      readonly ok: true;
      readonly permit: M31ActionPermitV2;
      readonly receipt: M31ExecutionReceiptEventV2;
    }
  | { readonly ok: false; readonly failure: M31TargetV2TypedFailure };
type TxQuery = Parameters<Parameters<IDatabase['withTransaction']>[0]>[0];

let sqliteTransactionTail: Promise<void> = Promise.resolve();

async function withV2Transaction<T>(
  fn: (query: TxQuery) => Promise<T>,
  serializable = false
): Promise<T> {
  const db = getDatabase();
  if (db.dialect === 'postgres') {
    return db.withTransaction(async query => {
      if (serializable) await query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
      return fn(query);
    });
  }

  const prior = sqliteTransactionTail;
  let release!: () => void;
  sqliteTransactionTail = new Promise<void>(resolve => {
    release = resolve;
  });
  await prior;
  await db.query('BEGIN IMMEDIATE');
  try {
    const result = await fn(db.query.bind(db));
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    release();
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonicalize(item)])
    );
  }
  return value;
}
export function canonicalJsonV2(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}
function digest(value: unknown): string {
  return createHash('sha256')
    .update(typeof value === 'string' ? value : canonicalJsonV2(value))
    .digest('hex');
}
function parseJson(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}
function isoValid(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}
function shaMatches(value: string, format: 'sha1' | 'sha256'): boolean {
  return SHA_RE.test(value) && value.length === (format === 'sha1' ? 40 : 64);
}

export function targetKeyV2(target: M31ActionTargetV2): string {
  switch (target.target_kind) {
    case 'workflow_run':
      return `${target.repository}#workflow_run:${target.run_id}`;
    case 'issue':
      return `${target.repository}#issue:${target.issue_number}`;
    case 'work_order':
      return `${target.repository}#work_order:${target.wo_id}`;
    case 'pull_request':
      return `${target.repository}#pull_request:${target.pr_number}`;
  }
}
export function targetDigestV2(target: M31ActionTargetV2): string {
  validateTarget(target);
  return digest(target);
}

function validateTarget(target: M31ActionTargetV2): void {
  if (!target?.repository?.trim()) throw new Error('target_invalid');
  const expectedKeys: Readonly<Record<M31ActionTargetV2['target_kind'], readonly string[]>> = {
    workflow_run: [
      'base_sha',
      'codebase_id',
      'event_tip',
      'head_sha',
      'repository',
      'run_id',
      'status',
      'target_kind',
      'wo_id',
      'workflow_name',
    ],
    issue: [
      'is_pull_request',
      'issue_number',
      'provider_node_id',
      'repository',
      'state',
      'target_kind',
      'updated_at',
    ],
    work_order: [
      'repository',
      'spec_hash',
      'spec_path',
      'spec_revision',
      'target_kind',
      'tracker_is_pull_request',
      'tracker_issue_number',
      'tracker_provider_node_id',
      'tracker_state',
      'tracker_updated_at',
      'wo_id',
    ],
    pull_request: [
      'base_branch',
      'base_sha',
      'head_sha',
      'pr_number',
      'provider_node_id',
      'repository',
      'state',
      'target_kind',
      'updated_at',
    ],
  };
  const expected = expectedKeys[target.target_kind];
  if (!expected || canonicalJsonV2(Object.keys(target).sort()) !== canonicalJsonV2(expected)) {
    throw new Error('target_invalid');
  }
  if (target.target_kind === 'workflow_run') {
    if (
      !UUID_RE.test(target.run_id) ||
      !target.wo_id ||
      !target.workflow_name ||
      !target.status ||
      !target.event_tip
    )
      throw new Error('target_invalid');
    if (
      (target.head_sha !== null && !SHA_RE.test(target.head_sha)) ||
      (target.base_sha !== null && !SHA_RE.test(target.base_sha))
    )
      throw new Error('target_invalid');
  } else if (target.target_kind === 'issue') {
    if (
      !Number.isInteger(target.issue_number) ||
      target.issue_number <= 0 ||
      !target.provider_node_id ||
      target.is_pull_request ||
      !isoValid(target.updated_at)
    )
      throw new Error('target_invalid');
  } else if (target.target_kind === 'work_order') {
    if (
      !target.wo_id ||
      !target.spec_path ||
      !target.spec_revision ||
      !DIGEST_RE.test(target.spec_hash) ||
      !Number.isInteger(target.tracker_issue_number) ||
      target.tracker_issue_number <= 0 ||
      !target.tracker_provider_node_id ||
      target.tracker_is_pull_request ||
      !isoValid(target.tracker_updated_at)
    )
      throw new Error('target_invalid');
  } else if (target.target_kind === 'pull_request') {
    if (
      !Number.isInteger(target.pr_number) ||
      target.pr_number <= 0 ||
      !target.provider_node_id ||
      !SHA_RE.test(target.head_sha) ||
      !SHA_RE.test(target.base_sha) ||
      !target.base_branch ||
      !isoValid(target.updated_at)
    )
      throw new Error('target_invalid');
  } else throw new Error('target_invalid');
}

const ACTIONS_BY_TARGET: Readonly<
  Record<M31ActionTargetV2['target_kind'], ReadonlySet<M31ActionKind>>
> = {
  workflow_run: new Set(['REPAIR', 'REFIRE']),
  issue: new Set(['CLOSE', 'REOPEN', 'COMMENT', 'LABEL', 'ASSIGN']),
  work_order: new Set(['CLOSE', 'REOPEN', 'COMMENT', 'LABEL', 'ASSIGN']),
  pull_request: new Set([
    'MERGE',
    'CLOSE',
    'REOPEN',
    'REFRESH',
    'REBASE',
    'REPAIR',
    'COMMENT',
    'LABEL',
    'ASSIGN',
  ]),
};
export function actionMatchesTargetV2(action: M31ActionKind, target: M31ActionTargetV2): boolean {
  return ACTIONS_BY_TARGET[target.target_kind].has(action);
}
function isAction(value: string): value is M31ActionKind {
  return (M31_ACTION_KINDS as readonly string[]).includes(value);
}
function capabilityFor(action: M31ActionKind): string {
  return `overseer.m31.${action.toLowerCase()}`;
}
function addMs(value: string, amount: number): string {
  const base = Date.parse(value);
  if (!Number.isFinite(base) || !Number.isInteger(amount) || amount <= 0) {
    throw new Error('m31_target_v2_invalid_time');
  }
  return new Date(base + amount).toISOString();
}
async function txNow(query: TxQuery, supplied?: string): Promise<string> {
  if (supplied !== undefined) {
    if (!isoValid(supplied)) throw new Error('m31_target_v2_invalid_test_clock');
    return supplied;
  }
  const db = getDatabase();
  const sql =
    db.dialect === 'sqlite'
      ? "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now"
      : 'SELECT to_char(clock_timestamp() AT TIME ZONE \'UTC\',\'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"\') AS now';
  const row = (await query<{ now: string }>(sql)).rows[0];
  if (!row?.now || !isoValid(row.now)) throw new Error('m31_target_v2_database_clock_unavailable');
  return row.now;
}

interface SnapshotRow {
  snapshot_id: string;
  schema_version: typeof M31_TARGET_V2_SCHEMA_VERSION;
  repository: string;
  capture_started_at: string;
  capture_completed_at: string;
  operator_actor: string;
  operator_model: string;
  read_only_query_method: string;
  evidence_artifact_path: string;
  git_object_format: 'sha1' | 'sha256';
  evidence_git_blob: string;
  predecessor_snapshot_id: string | null;
  predecessor_evidence_git_blob: string | null;
  created_at: string;
}
interface MemberRow {
  snapshot_id: string;
  ordinal: number;
  target_kind: M31ActionTargetV2['target_kind'];
  target_key: string;
  target_identity_json: unknown;
  target_digest: string;
  evidence_artifact_path: string;
  git_object_format: 'sha1' | 'sha256';
  evidence_git_blob: string;
  observed_at: string;
}
interface ProposalRow {
  proposal_id: string;
  repository: string;
  target_identity_json: unknown;
  target_key: string;
  target_digest: string;
  snapshot_id: string;
  evidence_path: string;
  evidence_git_blob: string;
  action_kind: M31ActionKind;
  action_parameters_json: unknown;
  actor: string;
  created_at: string;
  expires_at: string;
  execution_id: string;
  capability: string;
  policy_digest: string;
  verifier_registry_digest: string;
}
interface ReceiptRow {
  receipt_event_id: string;
  proposal_id: string;
  execution_id: string;
  event_sequence: number | string;
  event_type: M31ReceiptEventTypeV2;
  target_kind: M31ActionTargetV2['target_kind'];
  target_key: string;
  target_digest: string;
  live_observation_json: unknown;
  live_observation_digest: string | null;
  revalidated_at: string | null;
  valid_until: string | null;
  adapter_name: string | null;
  provider_operation: string | null;
  external_effect_reference: string | null;
  reason: string;
  evidence_json: unknown;
  previous_event_digest: string | null;
  event_digest: string;
  created_at: string;
}

function memberFromRow(row: MemberRow): M31SnapshotMemberV2 {
  return {
    snapshot_id: row.snapshot_id,
    ordinal: row.ordinal,
    target: parseJson(row.target_identity_json) as M31ActionTargetV2,
    target_key: row.target_key,
    target_digest: row.target_digest,
    evidence_artifact_path: row.evidence_artifact_path,
    git_object_format: row.git_object_format,
    evidence_git_blob: row.evidence_git_blob,
    observed_at: row.observed_at,
  };
}
function snapshotFromRows(row: SnapshotRow, members: readonly MemberRow[]): M31SnapshotV2 {
  return { ...row, targets: members.map(memberFromRow) };
}
function proposalFromRow(row: ProposalRow): M31ActionProposalV2 {
  return {
    proposal_id: row.proposal_id,
    repository: row.repository,
    target: parseJson(row.target_identity_json) as M31ActionTargetV2,
    target_key: row.target_key,
    target_digest: row.target_digest,
    snapshot_id: row.snapshot_id,
    evidence_path: row.evidence_path,
    evidence_git_blob: row.evidence_git_blob,
    action_kind: row.action_kind,
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
function receiptFromRow(row: ReceiptRow): M31ExecutionReceiptEventV2 {
  return {
    ...row,
    event_sequence: Number(row.event_sequence),
    live_observation:
      row.live_observation_json === null ? null : parseJson(row.live_observation_json),
    evidence: parseJson(row.evidence_json),
  };
}

async function selectSnapshot(query: TxQuery, id: string): Promise<SnapshotRow | undefined> {
  return (
    await query<SnapshotRow>('SELECT * FROM overseer_m31_snapshots_v2 WHERE snapshot_id = $1', [id])
  ).rows[0];
}
async function selectMembers(query: TxQuery, id: string): Promise<readonly MemberRow[]> {
  return (
    await query<MemberRow>(
      'SELECT * FROM overseer_m31_target_members_v2 WHERE snapshot_id = $1 ORDER BY ordinal',
      [id]
    )
  ).rows;
}

async function assess(query: TxQuery, repository: string): Promise<M31ChainAssessmentV2> {
  const rows = (
    await query<
      Pick<
        SnapshotRow,
        | 'snapshot_id'
        | 'predecessor_snapshot_id'
        | 'predecessor_evidence_git_blob'
        | 'evidence_git_blob'
      >
    >(
      'SELECT snapshot_id,predecessor_snapshot_id,predecessor_evidence_git_blob,evidence_git_blob FROM overseer_m31_snapshots_v2 WHERE repository = $1 ORDER BY created_at',
      [repository]
    )
  ).rows;
  const byId = new Map(rows.map(row => [row.snapshot_id, row]));
  const referenced = new Set<string>();
  const children = new Map<string, number>();
  let genesis = 0;
  let missing = false;
  let mismatch = false;
  for (const row of rows) {
    if (!row.predecessor_snapshot_id) {
      genesis++;
      continue;
    }
    referenced.add(row.predecessor_snapshot_id);
    children.set(row.predecessor_snapshot_id, (children.get(row.predecessor_snapshot_id) ?? 0) + 1);
    const predecessor = byId.get(row.predecessor_snapshot_id);
    if (!predecessor) missing = true;
    else if (predecessor.evidence_git_blob !== row.predecessor_evidence_git_blob) mismatch = true;
  }
  const tips = rows.filter(row => !referenced.has(row.snapshot_id));
  const resolvedId =
    getDatabase().dialect === 'sqlite'
      ? "json_extract(r.resolution_json, '$.resolves_discrepancy_id')"
      : "r.resolution_json->>'resolves_discrepancy_id'";
  const unresolved = await query<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM overseer_m31_discrepancies_v2 d JOIN overseer_m31_snapshots_v2 s ON s.snapshot_id=d.snapshot_id WHERE s.repository=$1 AND d.resolution_json IS NULL AND NOT EXISTS (SELECT 1 FROM overseer_m31_discrepancies_v2 r WHERE r.resolution_json IS NOT NULL AND ${resolvedId}=d.discrepancy_id)`,
    [repository]
  );
  const forked = genesis > 1 || [...children.values()].some(count => count > 1) || tips.length > 1;
  return {
    repository,
    snapshot_count: rows.length,
    tip_snapshot_id: !forked && tips.length === 1 ? tips[0].snapshot_id : null,
    forked,
    predecessor_missing: missing,
    predecessor_digest_mismatch: mismatch,
    unresolved_discrepancies: Number(unresolved.rows[0]?.n ?? 0),
  };
}

async function targetHasUnresolvedDiscrepancy(
  query: TxQuery,
  repository: string,
  targetKey: string
): Promise<boolean> {
  const rows = (
    await query<{
      discrepancy_id: string;
      affected_targets_json: unknown;
      resolution_json: unknown;
    }>(
      `SELECT d.discrepancy_id,d.affected_targets_json,d.resolution_json
         FROM overseer_m31_discrepancies_v2 d
         JOIN overseer_m31_snapshots_v2 s ON s.snapshot_id=d.snapshot_id
        WHERE s.repository=$1`,
      [repository]
    )
  ).rows;
  const resolved = new Set(
    rows
      .filter(row => row.resolution_json !== null)
      .map(
        row =>
          (parseJson(row.resolution_json) as M31DiscrepancyResolutionV2).resolves_discrepancy_id
      )
  );
  return rows.some(
    row =>
      row.resolution_json === null &&
      !resolved.has(row.discrepancy_id) &&
      (parseJson(row.affected_targets_json) as readonly string[]).includes(targetKey)
  );
}

export async function registerM31SnapshotV2(
  input: RegisterM31SnapshotV2Input
): Promise<M31SnapshotV2> {
  if (
    !input.repository ||
    !isoValid(input.capture_started_at) ||
    !isoValid(input.capture_completed_at) ||
    Date.parse(input.capture_completed_at) < Date.parse(input.capture_started_at) ||
    !shaMatches(input.evidence_git_blob, input.git_object_format) ||
    input.targets.length === 0
  )
    throw new Error('snapshot_invalid');
  const derived = input.targets
    .map(member => {
      validateTarget(member.target);
      if (
        member.target.repository !== input.repository ||
        !shaMatches(member.evidence_git_blob, member.git_object_format) ||
        !isoValid(member.observed_at)
      )
        throw new Error('target_invalid');
      return { ...member, key: targetKeyV2(member.target), digest: targetDigestV2(member.target) };
    })
    .sort((a, b) =>
      `${a.target.target_kind}:${a.key}:${a.digest}`.localeCompare(
        `${b.target.target_kind}:${b.key}:${b.digest}`
      )
    );
  if (
    new Set(derived.map(item => `${item.target.target_kind}:${item.key}`)).size !== derived.length
  )
    throw new Error('target_invalid');
  return withV2Transaction(async query => {
    if (getDatabase().dialect === 'postgres') {
      await query("SELECT pg_advisory_xact_lock(hashtextextended('m31v2:' || $1, 0))", [
        input.repository,
      ]);
    }
    const now = await txNow(query, input.test_clock_now);
    const chain = await assess(query, input.repository);
    const predecessorId = input.predecessor_snapshot_id ?? null;
    const predecessorBlob = input.predecessor_evidence_git_blob ?? null;
    if (chain.snapshot_count === 0 && (predecessorId || predecessorBlob))
      throw new Error('predecessor_missing');
    if (chain.snapshot_count > 0) {
      if (chain.forked) throw new Error('snapshot_forked');
      if (chain.tip_snapshot_id !== predecessorId) throw new Error('snapshot_not_chain_tip');
      const predecessor = predecessorId ? await selectSnapshot(query, predecessorId) : undefined;
      if (!predecessor) throw new Error('predecessor_missing');
      if (predecessor.evidence_git_blob !== predecessorBlob)
        throw new Error('predecessor_digest_mismatch');
    }
    const id = input.snapshot_id ?? `m31v2-snapshot-${randomUUID()}`;
    await query(
      'INSERT INTO overseer_m31_snapshots_v2 (snapshot_id,schema_version,repository,capture_started_at,capture_completed_at,operator_actor,operator_model,read_only_query_method,evidence_artifact_path,git_object_format,evidence_git_blob,predecessor_snapshot_id,predecessor_evidence_git_blob,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
      [
        id,
        M31_TARGET_V2_SCHEMA_VERSION,
        input.repository,
        input.capture_started_at,
        input.capture_completed_at,
        input.operator_actor,
        input.operator_model,
        input.read_only_query_method,
        input.evidence_artifact_path,
        input.git_object_format,
        input.evidence_git_blob,
        predecessorId,
        predecessorBlob,
        now,
      ]
    );
    for (let ordinal = 0; ordinal < derived.length; ordinal++) {
      const item = derived[ordinal];
      await query(
        'INSERT INTO overseer_m31_target_members_v2 (snapshot_id,ordinal,target_kind,target_key,target_identity_json,target_digest,evidence_artifact_path,git_object_format,evidence_git_blob,observed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [
          id,
          ordinal,
          item.target.target_kind,
          item.key,
          canonicalJsonV2(item.target),
          item.digest,
          item.evidence_artifact_path,
          item.git_object_format,
          item.evidence_git_blob,
          item.observed_at,
        ]
      );
    }
    const row = await selectSnapshot(query, id);
    if (!row) throw new Error('m31_target_v2_snapshot_insert_failed');
    return snapshotFromRows(row, await selectMembers(query, id));
  }, true);
}

export async function getM31SnapshotV2(id: string): Promise<M31SnapshotV2 | null> {
  const db = getDatabase();
  const row = (
    await db.query<SnapshotRow>('SELECT * FROM overseer_m31_snapshots_v2 WHERE snapshot_id=$1', [
      id,
    ])
  ).rows[0];
  return row
    ? snapshotFromRows(
        row,
        (
          await db.query<MemberRow>(
            'SELECT * FROM overseer_m31_target_members_v2 WHERE snapshot_id=$1 ORDER BY ordinal',
            [id]
          )
        ).rows
      )
    : null;
}
export async function getM31ChainAssessmentV2(repository: string): Promise<M31ChainAssessmentV2> {
  return withV2Transaction(query => assess(query, repository));
}

export async function appendM31DiscrepancyV2(
  input: AppendM31DiscrepancyV2Input
): Promise<M31DiscrepancyV2> {
  return withV2Transaction(async query => {
    const snapshot = await selectSnapshot(query, input.snapshot_id);
    if (!snapshot) throw new Error('snapshot_invalid');
    if (getDatabase().dialect === 'postgres') {
      await query("SELECT pg_advisory_xact_lock(hashtextextended('m31v2:' || $1, 0))", [
        snapshot.repository,
      ]);
    }

    if (
      !shaMatches(input.evidence_git_blob, snapshot.git_object_format) ||
      input.affected_targets.length === 0 ||
      new Set(input.affected_targets).size !== input.affected_targets.length ||
      input.affected_targets.some(target => !target)
    ) {
      throw new Error('discrepancy_invalid');
    }

    const rows = (
      await query<{
        discrepancy_id: string;
        snapshot_id: string;
        affected_targets_json: unknown;
        conflict_json: unknown;
        resolution_json: unknown;
        predecessor_discrepancy_id: string | null;
      }>(
        `SELECT d.discrepancy_id,d.snapshot_id,d.affected_targets_json,d.conflict_json,d.resolution_json,d.predecessor_discrepancy_id
           FROM overseer_m31_discrepancies_v2 d
           JOIN overseer_m31_snapshots_v2 s ON s.snapshot_id=d.snapshot_id
          WHERE s.repository=$1 ORDER BY d.recorded_at,d.discrepancy_id`,
        [snapshot.repository]
      )
    ).rows;
    const referenced = new Set(
      rows
        .map(row => row.predecessor_discrepancy_id)
        .filter((value): value is string => value !== null)
    );
    const tips = rows.filter(row => !referenced.has(row.discrepancy_id));
    if (tips.length > 1) throw new Error('discrepancy_chain_forked');
    const currentTip = tips[0]?.discrepancy_id ?? null;
    if ((input.predecessor_discrepancy_id ?? null) !== currentTip) {
      throw new Error('discrepancy_predecessor_stale');
    }

    const resolved = input.resolution !== undefined;
    if (resolved) {
      const keys = Object.keys(input.resolution).sort();
      if (
        canonicalJsonV2(keys) !==
          canonicalJsonV2(['evidence_digest', 'resolution_code', 'resolves_discrepancy_id']) ||
        !input.resolution.resolution_code ||
        !DIGEST_RE.test(input.resolution.evidence_digest) ||
        !input.resolved_by
      ) {
        throw new Error('discrepancy_resolution_invalid');
      }
      const open = rows.find(
        row => row.discrepancy_id === input.resolution?.resolves_discrepancy_id
      );
      if (!open) throw new Error('discrepancy_resolution_missing');
      if (open.resolution_json !== null) throw new Error('discrepancy_resolution_of_resolution');
      if (
        open.snapshot_id !== input.snapshot_id ||
        canonicalJsonV2(parseJson(open.affected_targets_json)) !==
          canonicalJsonV2(input.affected_targets) ||
        canonicalJsonV2(parseJson(open.conflict_json)) !== canonicalJsonV2(input.conflict)
      ) {
        throw new Error('discrepancy_resolution_mismatch');
      }
      const alreadyResolved = rows.some(row => {
        if (row.resolution_json === null) return false;
        const value = parseJson(row.resolution_json) as M31DiscrepancyResolutionV2;
        return value.resolves_discrepancy_id === input.resolution?.resolves_discrepancy_id;
      });
      if (alreadyResolved) throw new Error('discrepancy_already_resolved');
    } else if (input.resolved_by !== undefined) {
      throw new Error('discrepancy_resolution_invalid');
    }

    const now = await txNow(query, input.test_clock_now);
    const id = `m31v2-discrepancy-${randomUUID()}`;
    await query(
      'INSERT INTO overseer_m31_discrepancies_v2 (discrepancy_id,snapshot_id,evidence_git_blob,affected_targets_json,conflict_json,recorded_by,recorded_at,resolution_json,resolved_by,resolved_at,predecessor_discrepancy_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [
        id,
        input.snapshot_id,
        input.evidence_git_blob,
        canonicalJsonV2(input.affected_targets),
        canonicalJsonV2(input.conflict),
        input.recorded_by,
        now,
        resolved ? canonicalJsonV2(input.resolution) : null,
        resolved ? input.resolved_by : null,
        resolved ? now : null,
        input.predecessor_discrepancy_id ?? null,
      ]
    );
    return {
      discrepancy_id: id,
      snapshot_id: input.snapshot_id,
      affected_targets: [...input.affected_targets],
      conflict: input.conflict,
      recorded_by: input.recorded_by,
      recorded_at: now,
      resolution: resolved ? input.resolution : null,
      resolved_by: resolved ? (input.resolved_by ?? null) : null,
      resolved_at: resolved ? now : null,
      predecessor_discrepancy_id: input.predecessor_discrepancy_id ?? null,
    };
  }, true);
}

export interface ResolveM31DiscrepancyV2Input extends AppendM31DiscrepancyV2Input {
  readonly resolution: M31DiscrepancyResolutionV2;
  readonly resolved_by: string;
}

export async function resolveM31DiscrepancyV2(
  input: ResolveM31DiscrepancyV2Input
): Promise<M31DiscrepancyV2> {
  return appendM31DiscrepancyV2(input);
}

export async function createM31ActionProposalV2(
  input: CreateM31ActionProposalV2Input
): Promise<Result<M31ActionProposalV2>> {
  try {
    validateTarget(input.target);
  } catch {
    return { ok: false, failure: 'target_invalid' };
  }
  if (!isAction(input.action_kind) || !actionMatchesTargetV2(input.action_kind, input.target))
    return { ok: false, failure: 'action_target_mismatch' };
  if (
    input.target.repository !== input.repository ||
    !DIGEST_RE.test(input.policy_digest) ||
    !DIGEST_RE.test(input.verifier_registry_digest)
  )
    return { ok: false, failure: 'target_invalid' };
  return withV2Transaction(async query => {
    const now = await txNow(query, input.test_clock_now);
    const snapshot = await selectSnapshot(query, input.snapshot_id);
    if (snapshot?.repository !== input.repository)
      return { ok: false as const, failure: 'snapshot_invalid' as const };
    const chain = await assess(query, input.repository);
    if (chain.predecessor_missing)
      return { ok: false as const, failure: 'predecessor_missing' as const };
    if (chain.predecessor_digest_mismatch)
      return { ok: false as const, failure: 'predecessor_digest_mismatch' as const };
    if (chain.forked) return { ok: false as const, failure: 'snapshot_forked' as const };
    if (chain.tip_snapshot_id !== input.snapshot_id)
      return { ok: false as const, failure: 'snapshot_not_chain_tip' as const };
    const key = targetKeyV2(input.target);
    if (await targetHasUnresolvedDiscrepancy(query, input.repository, key)) {
      return { ok: false as const, failure: 'discrepancy_unresolved' as const };
    }
    const targetDigest = targetDigestV2(input.target);
    const member = (
      await query<MemberRow>(
        'SELECT * FROM overseer_m31_target_members_v2 WHERE snapshot_id=$1 AND target_kind=$2 AND target_key=$3',
        [input.snapshot_id, input.target.target_kind, key]
      )
    ).rows[0];
    if (!member) return { ok: false as const, failure: 'evidence_missing' as const };
    if (
      member.target_digest !== targetDigest ||
      canonicalJsonV2(parseJson(member.target_identity_json)) !== canonicalJsonV2(input.target)
    )
      return { ok: false as const, failure: 'evidence_conflicting' as const };
    if (
      input.max_evidence_age_ms !== undefined &&
      Date.parse(now) - Date.parse(member.observed_at) > input.max_evidence_age_ms
    )
      return { ok: false as const, failure: 'evidence_stale' as const };
    const id = input.proposal_id ?? `m31v2-proposal-${randomUUID()}`;
    const execution = `m31v2-execution-${randomUUID()}`;
    const expires = addMs(now, input.ttl_ms ?? M31_TARGET_V2_DEFAULT_PROPOSAL_TTL_MS);
    await query(
      'INSERT INTO overseer_m31_action_proposals_v2 (proposal_id,repository,target_kind,target_key,target_identity_json,target_digest,snapshot_id,evidence_path,evidence_git_blob,action_kind,action_parameters_json,actor,created_at,expires_at,execution_id,capability,policy_digest,verifier_registry_digest) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)',
      [
        id,
        input.repository,
        input.target.target_kind,
        key,
        canonicalJsonV2(input.target),
        targetDigest,
        input.snapshot_id,
        input.evidence_path,
        member.evidence_git_blob,
        input.action_kind,
        canonicalJsonV2(input.action_parameters),
        input.actor,
        now,
        expires,
        execution,
        capabilityFor(input.action_kind),
        input.policy_digest,
        input.verifier_registry_digest,
      ]
    );
    const row = (
      await query<ProposalRow>(
        'SELECT * FROM overseer_m31_action_proposals_v2 WHERE proposal_id=$1',
        [id]
      )
    ).rows[0];
    if (!row) throw new Error('m31_target_v2_proposal_insert_failed');
    return { ok: true as const, value: proposalFromRow(row) };
  });
}

export async function getM31ActionProposalV2(id: string): Promise<M31ActionProposalV2 | null> {
  const row = (
    await getDatabase().query<ProposalRow>(
      'SELECT * FROM overseer_m31_action_proposals_v2 WHERE proposal_id=$1',
      [id]
    )
  ).rows[0];
  return row ? proposalFromRow(row) : null;
}

async function insertEvent(
  query: TxQuery,
  proposal: M31ActionProposalV2,
  event: {
    sequence: number;
    type: M31ReceiptEventTypeV2;
    live?: unknown;
    liveDigest?: string;
    revalidatedAt?: string;
    validUntil?: string;
    adapter?: string;
    operation?: string;
    external?: string;
    reason: string;
    evidence: unknown;
    previous: string | null;
    now: string;
  }
): Promise<M31ExecutionReceiptEventV2 | null> {
  const id = `m31v2-receipt-${randomUUID()}`;
  const eventDigest = digest({
    receipt_event_id: id,
    proposal_id: proposal.proposal_id,
    execution_id: proposal.execution_id,
    event_sequence: event.sequence,
    event_type: event.type,
    target_kind: proposal.target.target_kind,
    target_key: proposal.target_key,
    target_digest: proposal.target_digest,
    live_observation: event.live ?? null,
    live_observation_digest: event.liveDigest ?? null,
    revalidated_at: event.revalidatedAt ?? null,
    valid_until: event.validUntil ?? null,
    adapter_name: event.adapter ?? null,
    provider_operation: event.operation ?? null,
    external_effect_reference: event.external ?? null,
    reason: event.reason,
    evidence: event.evidence,
    previous_event_digest: event.previous,
    created_at: event.now,
  });
  await query(
    'INSERT INTO overseer_m31_execution_receipts_v2 (receipt_event_id,proposal_id,execution_id,event_sequence,event_type,target_kind,target_key,target_digest,live_observation_json,live_observation_digest,revalidated_at,valid_until,adapter_name,provider_operation,external_effect_reference,reason,evidence_json,previous_event_digest,event_digest,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) ON CONFLICT DO NOTHING',
    [
      id,
      proposal.proposal_id,
      proposal.execution_id,
      event.sequence,
      event.type,
      proposal.target.target_kind,
      proposal.target_key,
      proposal.target_digest,
      event.live === undefined ? null : canonicalJsonV2(event.live),
      event.liveDigest ?? null,
      event.revalidatedAt ?? null,
      event.validUntil ?? null,
      event.adapter ?? null,
      event.operation ?? null,
      event.external ?? null,
      event.reason,
      canonicalJsonV2(event.evidence),
      event.previous,
      eventDigest,
      event.now,
    ]
  );
  const row = (
    await query<ReceiptRow>(
      'SELECT * FROM overseer_m31_execution_receipts_v2 WHERE receipt_event_id=$1',
      [id]
    )
  ).rows[0];
  return row ? receiptFromRow(row) : null;
}

export async function compareAndConsumeM31ProposalV2(input: {
  proposal_id: string;
  observation: M31LiveObservationV2;
  validity_window_ms?: number;
  /** Test-only database clock seam. Never exposed by an HTTP schema. */
  test_clock_now?: string;
}): Promise<M31PermitResultV2> {
  return withV2Transaction(async query => {
    const row = (
      await query<ProposalRow>(
        'SELECT * FROM overseer_m31_action_proposals_v2 WHERE proposal_id=$1',
        [input.proposal_id]
      )
    ).rows[0];
    if (!row) throw new Error(`m31_target_v2_proposal_not_found:${input.proposal_id}`);
    const proposal = proposalFromRow(row);
    const existing = (
      await query<ReceiptRow>(
        "SELECT * FROM overseer_m31_execution_receipts_v2 WHERE proposal_id=$1 AND event_type='permit_issued'",
        [proposal.proposal_id]
      )
    ).rows[0];
    if (existing) return { ok: false as const, failure: 'proposal_replayed' as const };
    const now = await txNow(query, input.test_clock_now);
    if (Date.parse(now) > Date.parse(proposal.expires_at))
      return { ok: false as const, failure: 'proposal_expired' as const };
    const obs = input.observation;
    if (!obs.known) return { ok: false as const, failure: 'live_state_unknown' as const };
    let observedDigest: string;
    try {
      observedDigest = targetDigestV2(obs.target);
    } catch {
      return { ok: false as const, failure: 'target_invalid' as const };
    }
    if (
      canonicalJsonV2(obs.target) !== canonicalJsonV2(proposal.target) ||
      observedDigest !== proposal.target_digest
    )
      return { ok: false as const, failure: 'live_state_mismatch' as const };
    if (obs.policy_digest !== proposal.policy_digest)
      return { ok: false as const, failure: 'policy_digest_mismatch' as const };
    if (obs.verifier_registry_digest !== proposal.verifier_registry_digest)
      return { ok: false as const, failure: 'verifier_registry_mismatch' as const };
    const validUntil = addMs(
      obs.observed_at,
      input.validity_window_ms ?? M31_TARGET_V2_OBSERVATION_VALIDITY_MS
    );
    if (Date.parse(now) > Date.parse(validUntil))
      return { ok: false as const, failure: 'observation_stale' as const };
    const liveDigest = digest(obs);
    const receipt = await insertEvent(query, proposal, {
      sequence: 1,
      type: 'permit_issued',
      live: obs,
      liveDigest,
      revalidatedAt: obs.observed_at,
      validUntil,
      reason: 'exact_target_revalidated',
      evidence: { no_provider_dependency: true },
      previous: null,
      now,
    });
    if (!receipt) return { ok: false as const, failure: 'proposal_replayed' as const };
    const permit: M31ActionPermitV2 = {
      permit_id: receipt.receipt_event_id,
      proposal_id: proposal.proposal_id,
      execution_id: proposal.execution_id,
      repository: proposal.repository,
      target: proposal.target,
      target_key: proposal.target_key,
      target_digest: proposal.target_digest,
      snapshot_id: proposal.snapshot_id,
      action_kind: proposal.action_kind,
      capability: proposal.capability,
      issued_at: now,
      valid_until: validUntil,
    };
    return { ok: true as const, permit, receipt };
  });
}

export async function reserveM31ExecutionEffectV2(input: {
  permit: M31ActionPermitV2;
  adapter_name: string;
  provider_operation: string;
  reason: string;
  evidence: unknown;
  /** Test-only database clock seam. Never exposed by an HTTP schema. */
  test_clock_now?: string;
}): Promise<Result<M31ExecutionReceiptEventV2>> {
  return withV2Transaction(async query => {
    const row = (
      await query<ProposalRow>(
        'SELECT * FROM overseer_m31_action_proposals_v2 WHERE proposal_id=$1',
        [input.permit.proposal_id]
      )
    ).rows[0];
    if (!row) return { ok: false as const, failure: 'evidence_missing' as const };
    const proposal = proposalFromRow(row);
    const now = await txNow(query, input.test_clock_now);
    if (
      proposal.execution_id !== input.permit.execution_id ||
      proposal.target_digest !== input.permit.target_digest ||
      canonicalJsonV2(proposal.target) !== canonicalJsonV2(input.permit.target)
    )
      return { ok: false as const, failure: 'live_state_mismatch' as const };
    if (Date.parse(now) > Date.parse(input.permit.valid_until))
      return { ok: false as const, failure: 'observation_stale' as const };
    const prior = (
      await query<ReceiptRow>(
        'SELECT * FROM overseer_m31_execution_receipts_v2 WHERE execution_id=$1 AND event_sequence=1',
        [proposal.execution_id]
      )
    ).rows[0];
    if (!prior) return { ok: false as const, failure: 'evidence_conflicting' as const };
    const receipt = await insertEvent(query, proposal, {
      sequence: 2,
      type: 'effect_reserved',
      adapter: input.adapter_name,
      operation: input.provider_operation,
      reason: input.reason,
      evidence: input.evidence,
      previous: prior.event_digest,
      now,
    });
    return receipt
      ? { ok: true as const, value: receipt }
      : { ok: false as const, failure: 'proposal_replayed' as const };
  });
}

export async function appendM31ExecutionOutcomeV2(input: {
  execution_id: string;
  outcome: 'effect_succeeded' | 'effect_failed' | 'effect_indeterminate';
  reason: string;
  evidence: unknown;
  external_effect_reference?: string | null;
  /** Test-only database clock seam. Never exposed by an HTTP schema. */
  test_clock_now?: string;
}): Promise<Result<M31ExecutionReceiptEventV2>> {
  return appendSequenced(input, 3, input.outcome);
}
export async function appendM31ExecutionReconciliationV2(input: {
  execution_id: string;
  outcome: 'effect_reconciled_succeeded' | 'effect_reconciled_failed';
  reason: string;
  evidence: unknown;
  external_effect_reference?: string | null;
  /** Test-only database clock seam. Never exposed by an HTTP schema. */
  test_clock_now?: string;
}): Promise<Result<M31ExecutionReceiptEventV2>> {
  return appendSequenced(input, 4, input.outcome);
}
async function appendSequenced(
  input: {
    execution_id: string;
    reason: string;
    evidence: unknown;
    external_effect_reference?: string | null;
    test_clock_now?: string;
  },
  sequence: 3 | 4,
  type: M31ReceiptEventTypeV2
): Promise<Result<M31ExecutionReceiptEventV2>> {
  return withV2Transaction(async query => {
    const proposalRow = (
      await query<ProposalRow>(
        'SELECT p.* FROM overseer_m31_action_proposals_v2 p WHERE p.execution_id=$1',
        [input.execution_id]
      )
    ).rows[0];
    if (!proposalRow) return { ok: false as const, failure: 'evidence_missing' as const };
    const proposal = proposalFromRow(proposalRow);
    const prior = (
      await query<ReceiptRow>(
        'SELECT * FROM overseer_m31_execution_receipts_v2 WHERE execution_id=$1 AND event_sequence=$2',
        [input.execution_id, sequence - 1]
      )
    ).rows[0];
    if (!prior || (sequence === 4 && prior.event_type !== 'effect_indeterminate'))
      return { ok: false as const, failure: 'evidence_conflicting' as const };
    const now = await txNow(query, input.test_clock_now);
    const receipt = await insertEvent(query, proposal, {
      sequence,
      type,
      external: input.external_effect_reference ?? undefined,
      reason: input.reason,
      evidence: input.evidence,
      previous: prior.event_digest,
      now,
    });
    return receipt
      ? { ok: true as const, value: receipt }
      : { ok: false as const, failure: 'proposal_replayed' as const };
  });
}
export async function listM31ExecutionReceiptEventsV2(
  executionId: string
): Promise<readonly M31ExecutionReceiptEventV2[]> {
  return (
    await getDatabase().query<ReceiptRow>(
      'SELECT * FROM overseer_m31_execution_receipts_v2 WHERE execution_id=$1 ORDER BY event_sequence',
      [executionId]
    )
  ).rows.map(receiptFromRow);
}
