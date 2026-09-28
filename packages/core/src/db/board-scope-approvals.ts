import { createHash, randomUUID } from 'crypto';
import { getDatabase } from './connection';
import type { BoardPrincipal, BoardSeat } from './board-authority';
import type { IDatabase } from './adapters/types';

export const CE_SCOPE_REPOSITORY = 'thinmansoftware/lspro-react';

export interface ScopeApproval {
  approval_id: string;
  repo: string;
  pr_number: number;
  target_branch: string;
  head_sha: string;
  base_sha: string;
  authority: 'john';
  recorded_by_principal_id: string;
  recorded_by_seat: BoardSeat;
  xo_lease_id: string;
  xo_fencing_token: number;
  conditions: string;
  evidence_url: string;
  recorded_at: string;
}

export interface LeaseProof {
  holder_id: string;
  holder_token: string;
  fencing_token: number;
}

export interface PullRequestFacts {
  state: string;
  head: { sha: string; ref: string };
  base: { sha: string; ref: string };
}

export interface ScopeApprovalGitHub {
  getPullRequest(repo: string, prNumber: number): Promise<PullRequestFacts>;
}

type Tx = Parameters<Parameters<IDatabase['withTransaction']>[0]>[0];
interface ApprovalRow {
  details: string | ScopeApproval;
  created_at: string;
}
interface LeaseAuthorization {
  lease?: {
    lease_id: string;
    principal_id: string;
    holder_id: string;
    holder_token_hash: string;
    fencing_token: number;
    expires_at: string;
    released_at: string | null;
  };
  valid: boolean;
  seatAllowed: boolean;
}

function parseDetails<T>(value: string | T): T {
  return typeof value === 'string' ? (JSON.parse(value) as T) : value;
}

function jsonField(db: IDatabase, field: string): string {
  return db.dialect === 'sqlite' ? `json_extract(details, '$.${field}')` : `details->>'${field}'`;
}

function qualifiedJsonField(db: IDatabase, alias: string, field: string): string {
  return db.dialect === 'sqlite'
    ? `json_extract(${alias}.details, '$.${field}')`
    : `${alias}.details->>'${field}'`;
}

async function now(query: Tx, db: IDatabase): Promise<string> {
  const result = await query<{ value: string }>(
    db.dialect === 'sqlite'
      ? "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS value"
      : 'SELECT to_char(clock_timestamp() AT TIME ZONE \'UTC\', \'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"\') AS value'
  );
  return result.rows[0]?.value ?? new Date().toISOString();
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

async function append(
  query: Tx,
  input: {
    eventType: string;
    principal: BoardPrincipal;
    leaseId?: string | null;
    fencingToken?: number | null;
    subjectKey?: string | null;
    details: Record<string, unknown>;
    createdAt: string;
  }
): Promise<number> {
  const result = await query(
    `INSERT INTO board_audit_events
      (id,event_type,actor_principal_id,actor_seat_id,xo_lease_id,xo_fencing_token,
       motion_id,motion_revision_sha,details,created_at,subject_key)
     VALUES ($1,$2,$3,$4,$5,$6,NULL,NULL,$7,$8,$9)
     ON CONFLICT DO NOTHING`,
    [
      randomUUID(),
      input.eventType,
      input.principal.principal_id,
      input.principal.seat_id,
      input.leaseId ?? null,
      input.fencingToken ?? null,
      JSON.stringify(input.details),
      input.createdAt,
      input.subjectKey ?? null,
    ]
  );
  return result.rowCount;
}

async function authorize(
  query: Tx,
  principal: BoardPrincipal,
  proof: LeaseProof,
  at: string
): Promise<LeaseAuthorization> {
  const result = await query<{
    lease_id: string;
    principal_id: string;
    holder_id: string;
    holder_token_hash: string;
    fencing_token: number;
    expires_at: string;
    released_at: string | null;
  }>('SELECT * FROM board_xo_leases WHERE id = 1');
  const lease = result.rows[0];
  const valid =
    lease?.released_at === null &&
    lease.expires_at > at &&
    lease.holder_id === proof.holder_id &&
    lease.holder_token_hash === tokenHash(proof.holder_token) &&
    lease.fencing_token === proof.fencing_token &&
    lease.principal_id === principal.principal_id;
  return {
    lease,
    valid,
    seatAllowed: principal.seat_id === 'xo' || principal.seat_id === 'john',
  };
}

export async function recordScopeApproval(input: {
  principal: BoardPrincipal;
  proof: LeaseProof;
  repo: string;
  pr_number: number;
  head_sha: string;
  conditions: string;
  evidence_url: string;
  github: ScopeApprovalGitHub;
  database?: IDatabase;
}): Promise<
  { ok: true; created: boolean; approval: ScopeApproval } | { ok: false; reason: string }
> {
  if (input.repo !== CE_SCOPE_REPOSITORY) return { ok: false, reason: 'repo_not_allowed' };
  if (
    !input.conditions.trim() ||
    input.conditions.length > 4000 ||
    !input.evidence_url.startsWith('https://') ||
    !/^[0-9a-f]{40}$/i.test(input.head_sha)
  )
    return { ok: false, reason: 'invalid_request' };
  const pr = await input.github.getPullRequest(input.repo, input.pr_number);
  if (pr.state !== 'open') return { ok: false, reason: 'pr_not_open' };
  if (pr.head.sha !== input.head_sha) return { ok: false, reason: 'head_moved' };
  const db = input.database ?? getDatabase();
  const subject = `${input.repo}#${input.pr_number}@${input.head_sha}..${pr.base.sha}`;
  return db.withTransaction(async query => {
    const at = await now(query, db);
    const auth = await authorize(query, input.principal, input.proof, at);
    const lease = auth.lease;
    if (!auth.seatAllowed || !auth.valid || !lease) {
      const reason = auth.seatAllowed ? 'stale_xo_lease_token' : 'seat_not_permitted';
      await append(query, {
        eventType: 'ce_scope_approval_rejected',
        principal: input.principal,
        leaseId: auth.lease?.lease_id,
        fencingToken: auth.lease?.fencing_token,
        details: { reason, repo: input.repo, pr_number: input.pr_number },
        createdAt: at,
      });
      return { ok: false as const, reason };
    }
    const approval: ScopeApproval = {
      approval_id: randomUUID(),
      repo: input.repo,
      pr_number: input.pr_number,
      target_branch: pr.base.ref,
      head_sha: input.head_sha,
      base_sha: pr.base.sha,
      authority: 'john',
      recorded_by_principal_id: input.principal.principal_id,
      recorded_by_seat: input.principal.seat_id,
      xo_lease_id: lease.lease_id,
      xo_fencing_token: input.proof.fencing_token,
      conditions: input.conditions,
      evidence_url: input.evidence_url,
      recorded_at: at,
    };
    const inserted = await append(query, {
      eventType: 'ce_scope_approval_recorded',
      principal: input.principal,
      leaseId: lease.lease_id,
      fencingToken: input.proof.fencing_token,
      subjectKey: subject,
      details: approval as unknown as Record<string, unknown>,
      createdAt: at,
    });
    if (inserted) return { ok: true as const, created: true, approval };
    const existing = await query<ApprovalRow>(
      'SELECT details,created_at FROM board_audit_events WHERE event_type=$1 AND subject_key=$2',
      ['ce_scope_approval_recorded', subject]
    );
    return {
      ok: true as const,
      created: false,
      approval: parseDetails<ScopeApproval>(existing.rows[0].details),
    };
  });
}

export async function revokeScopeApproval(input: {
  principal: BoardPrincipal;
  proof: LeaseProof;
  approval_id: string;
  reason: string;
  database?: IDatabase;
}): Promise<
  { ok: true; created: boolean; approval: ScopeApproval } | { ok: false; reason: string }
> {
  if (!input.reason.trim() || input.reason.length > 4000)
    return { ok: false, reason: 'invalid_request' };
  const db = input.database ?? getDatabase();
  return db.withTransaction(async query => {
    const at = await now(query, db);
    const auth = await authorize(query, input.principal, input.proof, at);
    const lease = auth.lease;
    if (!auth.seatAllowed || !auth.valid || !lease) {
      const reason = auth.seatAllowed ? 'stale_xo_lease_token' : 'seat_not_permitted';
      await append(query, {
        eventType: 'ce_scope_approval_rejected',
        principal: input.principal,
        leaseId: auth.lease?.lease_id,
        fencingToken: auth.lease?.fencing_token,
        details: { reason, approval_id: input.approval_id },
        createdAt: at,
      });
      return { ok: false as const, reason };
    }
    const found = await query<ApprovalRow>(
      `SELECT details,created_at FROM board_audit_events WHERE event_type=$1 AND ${jsonField(db, 'approval_id')}=$2 LIMIT 1`,
      ['ce_scope_approval_recorded', input.approval_id]
    );
    if (!found.rows[0]) return { ok: false as const, reason: 'approval_not_found' };
    const approval = parseDetails<ScopeApproval>(found.rows[0].details);
    const created = await append(query, {
      eventType: 'ce_scope_approval_revoked',
      principal: input.principal,
      leaseId: lease.lease_id,
      fencingToken: input.proof.fencing_token,
      subjectKey: `revoke:${input.approval_id}`,
      details: {
        approval_id: input.approval_id,
        repo: approval.repo,
        pr_number: approval.pr_number,
        head_sha: approval.head_sha,
        base_sha: approval.base_sha,
        reason: input.reason,
        revoked_at: at,
      },
      createdAt: at,
    });
    return { ok: true as const, created: Boolean(created), approval };
  });
}

export async function getScopeApprovalDecision(input: {
  repo: string;
  pr_number: number;
  head_sha: string;
  base_sha: string;
  database?: IDatabase;
}): Promise<
  | { decision: 'allow'; approval: ScopeApproval }
  | { decision: 'deny'; reason: 'no_record' | 'revoked' | 'empty_conditions' }
> {
  const db = input.database ?? getDatabase();
  const subject = `${input.repo}#${input.pr_number}@${input.head_sha}..${input.base_sha}`;
  const found = await db.query<ApprovalRow>(
    'SELECT details,created_at FROM board_audit_events WHERE event_type=$1 AND subject_key=$2 LIMIT 1',
    ['ce_scope_approval_recorded', subject]
  );
  if (!found.rows[0]) return { decision: 'deny', reason: 'no_record' };
  let approval: ScopeApproval;
  try {
    approval = parseDetails<ScopeApproval>(found.rows[0].details);
  } catch {
    return { decision: 'deny', reason: 'empty_conditions' };
  }
  if (!approval.conditions?.trim()) return { decision: 'deny', reason: 'empty_conditions' };
  const revoked = await db.query(
    `SELECT 1 FROM board_audit_events WHERE event_type=$1 AND ${jsonField(db, 'approval_id')}=$2 LIMIT 1`,
    ['ce_scope_approval_revoked', approval.approval_id]
  );
  if (revoked.rowCount) return { decision: 'deny', reason: 'revoked' };
  return { decision: 'allow', approval };
}

export async function getScopeApprovalMetadata(input: {
  repo: string;
  pr_number: number;
  head_sha: string;
  database?: IDatabase;
}): Promise<{ hasOtherBase: boolean; newestRevokedAt: string | null }> {
  const db = input.database ?? getDatabase();
  const approvals = await db.query(
    `SELECT 1 FROM board_audit_events recorded WHERE recorded.event_type=$1
      AND ${qualifiedJsonField(db, 'recorded', 'repo')}=$2
      AND ${qualifiedJsonField(db, 'recorded', 'pr_number')}=$3
      AND ${qualifiedJsonField(db, 'recorded', 'head_sha')}=$4
      AND NOT EXISTS (
        SELECT 1 FROM board_audit_events revoked WHERE revoked.event_type='ce_scope_approval_revoked'
          AND ${qualifiedJsonField(db, 'revoked', 'approval_id')}=${qualifiedJsonField(db, 'recorded', 'approval_id')}
      ) LIMIT 1`,
    ['ce_scope_approval_recorded', input.repo, input.pr_number, input.head_sha]
  );
  const revoked = await db.query<{ created_at: string }>(
    `SELECT created_at FROM board_audit_events WHERE event_type=$1 AND ${jsonField(db, 'repo')}=$2
      AND ${jsonField(db, 'pr_number')}=$3 ORDER BY created_at DESC LIMIT 1`,
    ['ce_scope_approval_revoked', input.repo, input.pr_number]
  );
  return {
    hasOtherBase: approvals.rowCount > 0,
    newestRevokedAt: revoked.rows[0]?.created_at ?? null,
  };
}
