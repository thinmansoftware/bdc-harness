import { createHash, randomUUID } from 'crypto';
import { getDatabase } from './connection';
import type { IDatabase } from './adapters/types';
import type { BoardPrincipal, BoardSeat } from './board-authority';

const ALLOWED_REPO = 'thinmansoftware/lspro-react';
const SHA40 = /^[0-9a-f]{40}$/;
type Query = Parameters<Parameters<IDatabase['withTransaction']>[0]>[0];

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

export interface ScopeApprovalProof {
  principal: BoardPrincipal;
  holder_id: string;
  holder_token: string;
  fencing_token: number;
}

export interface ScopeApprovalGitHub {
  fetchPullRequest(repo: string, prNumber: number): Promise<{
    state: string;
    head: { sha: string; ref: string };
    base: { sha: string; ref: string };
  }>;
  listWorkflowRuns?(repo: string, headSha: string): Promise<readonly {
    id: number;
    path: string;
    event: string;
    head_sha: string;
    head_branch: string;
    run_started_at: string;
  }[]>;
  rerunWorkflow?(repo: string, runId: number): Promise<void>;
  credentialClass?: string;
}

export interface ScopeApprovalDependencies {
  db?: IDatabase;
  github?: ScopeApprovalGitHub;
  now?: () => Promise<string>;
}

export type RecordScopeApprovalResult =
  | { ok: true; created: boolean; approval: ScopeApproval }
  | { ok: false; reason: 'repo_not_allowed' | 'invalid_request' | 'seat_not_permitted' | 'stale_xo_lease_token' | 'head_moved' | 'pr_not_open' };

interface AuditRow { details: string | ScopeApproval; created_at: string }
interface LeaseRow {
  lease_id: string; principal_id: string; holder_id: string; holder_token_hash: string;
  fencing_token: number | string; expires_at: string; released_at: string | null;
}

function parseDetails(value: string | ScopeApproval): ScopeApproval | null {
  try { return (typeof value === 'string' ? JSON.parse(value) : value) as ScopeApproval; }
  catch { return null; }
}

async function dbNow(db: IDatabase): Promise<string> {
  const sql = db.dialect === 'sqlite'
    ? "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now"
    : `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`;
  return (await db.query<{ now: string }>(sql)).rows[0]?.now ?? new Date().toISOString();
}

async function defaultFetchPullRequest(repo: string, prNumber: number) {
  const token = process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim();
  if (!token) throw new Error('github_credential_unavailable');
  const response = await fetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
  });
  if (!response.ok) throw new Error(`github_pr_fetch_${response.status}`);
  return await response.json() as {
    state: string; head: { sha: string; ref: string }; base: { sha: string; ref: string };
  };
}

function github(deps: ScopeApprovalDependencies): ScopeApprovalGitHub {
  return deps.github ?? { fetchPullRequest: defaultFetchPullRequest, credentialClass: 'github_token' };
}

async function insertEvent(query: Query, input: {
  type: string; subject?: string; principal: BoardPrincipal; lease?: LeaseRow; details: object; now: string;
}): Promise<number> {
  const result = await query(
    `INSERT INTO board_audit_events
     (id,event_type,actor_principal_id,actor_seat_id,xo_lease_id,xo_fencing_token,
      motion_id,motion_revision_sha,details,created_at,subject_key)
     VALUES ($1,$2,$3,$4,$5,$6,NULL,NULL,$7,$8,$9)
     ON CONFLICT(event_type, subject_key) WHERE subject_key IS NOT NULL DO NOTHING`,
    [randomUUID(), input.type, input.principal.principal_id, input.principal.seat_id,
      input.lease?.lease_id ?? null, input.lease ? Number(input.lease.fencing_token) : null,
      JSON.stringify(input.details), input.now, input.subject ?? null]
  );
  return result.rowCount;
}

async function verifyProof(query: Query, proof: ScopeApprovalProof, now: string) {
  const lease = (await query<LeaseRow>('SELECT * FROM board_xo_leases WHERE id = 1')).rows[0];
  const permitted = proof.principal.seat_id === 'xo' || proof.principal.seat_id === 'john';
  const valid = lease && lease.released_at === null && lease.expires_at > now &&
    lease.holder_id === proof.holder_id &&
    lease.holder_token_hash === createHash('sha256').update(proof.holder_token).digest('hex') &&
    Number(lease.fencing_token) === proof.fencing_token &&
    lease.principal_id === proof.principal.principal_id;
  return { lease, permitted, valid: Boolean(valid) };
}

export async function recordScopeApproval(input: ScopeApprovalProof & {
  repo: string; pr_number: number; head_sha: string; conditions: string; evidence_url: string;
}, deps: ScopeApprovalDependencies = {}): Promise<RecordScopeApprovalResult> {
  if (input.repo !== ALLOWED_REPO) return { ok: false, reason: 'repo_not_allowed' };
  if (!Number.isSafeInteger(input.pr_number) || input.pr_number <= 0 || !SHA40.test(input.head_sha) ||
      input.conditions.trim().length === 0 || input.conditions.length > 4000 ||
      !/^https:\/\//.test(input.evidence_url)) return { ok: false, reason: 'invalid_request' };
  const live = await github(deps).fetchPullRequest(input.repo, input.pr_number);
  if (live.state !== 'open') return { ok: false, reason: 'pr_not_open' };
  if (live.head.sha !== input.head_sha) return { ok: false, reason: 'head_moved' };
  const db = deps.db ?? getDatabase();
  const now = deps.now ? await deps.now() : await dbNow(db);
  const subject = `${input.repo}#${input.pr_number}@${input.head_sha}..${live.base.sha}`;
  return db.withTransaction(async query => {
    const proof = await verifyProof(query, input, now);
    if (!proof.permitted || !proof.valid) {
      const reason = !proof.permitted ? 'seat_not_permitted' : 'stale_xo_lease_token';
      await insertEvent(query, { type: 'ce_scope_approval_rejected', principal: input.principal,
        lease: proof.lease, details: { action: 'record', reason, repo: input.repo, pr_number: input.pr_number }, now });
      return { ok: false, reason } as RecordScopeApprovalResult;
    }
    const approval: ScopeApproval = {
      approval_id: randomUUID(), repo: input.repo, pr_number: input.pr_number,
      target_branch: live.base.ref, head_sha: live.head.sha, base_sha: live.base.sha,
      authority: 'john', recorded_by_principal_id: input.principal.principal_id,
      recorded_by_seat: input.principal.seat_id, xo_lease_id: proof.lease!.lease_id,
      xo_fencing_token: Number(proof.lease!.fencing_token), conditions: input.conditions,
      evidence_url: input.evidence_url, recorded_at: now,
    };
    const inserted = await insertEvent(query, { type: 'ce_scope_approval_recorded', subject,
      principal: input.principal, lease: proof.lease, details: approval, now });
    if (inserted) return { ok: true, created: true, approval };
    const existing = (await query<AuditRow>(
      `SELECT details,created_at FROM board_audit_events WHERE event_type='ce_scope_approval_recorded' AND subject_key=$1`, [subject]
    )).rows[0];
    const original = existing && parseDetails(existing.details);
    if (!original) throw new Error('scope_approval_malformed');
    return { ok: true, created: false, approval: original };
  });
}

export type ScopeApprovalDecision =
  | { decision: 'allow'; approval: ScopeApproval }
  | { decision: 'deny'; reason: 'no_record' | 'revoked' | 'empty_conditions' | 'malformed'; other_base?: boolean };

export async function getScopeApprovalDecision(input: {
  repo: string; pr_number: number; head_sha: string; base_sha: string;
}, deps: ScopeApprovalDependencies = {}): Promise<ScopeApprovalDecision> {
  const db = deps.db ?? getDatabase();
  const prefix = `${input.repo}#${input.pr_number}@${input.head_sha}..`;
  const row = (await db.query<AuditRow>(
    `SELECT details,created_at FROM board_audit_events WHERE event_type='ce_scope_approval_recorded'
     AND subject_key=$1 ORDER BY created_at DESC LIMIT 1`, [`${prefix}${input.base_sha}`]
  )).rows[0];
  if (!row) {
    const other = (await db.query<{ n: number | string }>(
      `SELECT COUNT(*) AS n FROM board_audit_events WHERE event_type='ce_scope_approval_recorded' AND subject_key LIKE $1`, [`${prefix}%`]
    )).rows[0];
    return { decision: 'deny', reason: 'no_record', other_base: Number(other?.n ?? 0) > 0 };
  }
  const approval = parseDetails(row.details);
  if (!approval) return { decision: 'deny', reason: 'malformed' };
  if (!approval.conditions?.trim()) return { decision: 'deny', reason: 'empty_conditions' };
  const revoked = (await db.query<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM board_audit_events WHERE event_type='ce_scope_approval_revoked' AND subject_key=$1`,
    [`revoke:${approval.approval_id}`]
  )).rows[0];
  if (Number(revoked?.n ?? 0) > 0) return { decision: 'deny', reason: 'revoked' };
  return { decision: 'allow', approval };
}

export async function revokeScopeApproval(input: ScopeApprovalProof & {
  approval_id: string; reason: string;
}, deps: ScopeApprovalDependencies = {}): Promise<
  { ok: true; rerun: 'requested' | 'unavailable' | 'failed'; credential_class: string } |
  { ok: false; reason: 'invalid_request' | 'not_found' | 'seat_not_permitted' | 'stale_xo_lease_token' }
> {
  if (!input.reason.trim()) return { ok: false, reason: 'invalid_request' };
  const db = deps.db ?? getDatabase();
  const now = deps.now ? await deps.now() : await dbNow(db);
  const tx = await db.withTransaction(async query => {
    const detailsText = db.dialect === 'sqlite' ? 'details' : 'details::text';
    const recordRow = (await query<AuditRow>(
      `SELECT details,created_at FROM board_audit_events WHERE event_type='ce_scope_approval_recorded'
       AND ${detailsText} LIKE $1 ORDER BY created_at DESC LIMIT 1`, [`%"approval_id":"${input.approval_id}"%`]
    )).rows[0];
    const approval = recordRow && parseDetails(recordRow.details);
    if (!approval) return { ok: false as const, reason: 'not_found' as const };
    const proof = await verifyProof(query, input, now);
    if (!proof.permitted || !proof.valid) {
      const reason = !proof.permitted ? 'seat_not_permitted' as const : 'stale_xo_lease_token' as const;
      await insertEvent(query, { type: 'ce_scope_approval_rejected', principal: input.principal,
        lease: proof.lease, details: { action: 'revoke', reason, approval_id: input.approval_id }, now });
      return { ok: false as const, reason };
    }
    await insertEvent(query, { type: 'ce_scope_approval_revoked', subject: `revoke:${input.approval_id}`,
      principal: input.principal, lease: proof.lease,
      details: { approval_id: input.approval_id, repo: approval.repo, pr_number: approval.pr_number,
        head_sha: approval.head_sha, reason: input.reason, revoked_at: now,
        credential_class: github(deps).credentialClass ?? 'github_token' }, now });
    return { ok: true as const, approval };
  });
  if (!tx.ok) return tx;
  const gh = github(deps);
  const credential_class = gh.credentialClass ?? 'github_token';
  if (!gh.listWorkflowRuns || !gh.rerunWorkflow) return { ok: true, rerun: 'unavailable', credential_class };
  try {
    const live = await gh.fetchPullRequest(tx.approval.repo, tx.approval.pr_number);
    const runs = (await gh.listWorkflowRuns(tx.approval.repo, tx.approval.head_sha))
      .filter(run => run.path === '.github/workflows/ce-change-scope-gate.yml' &&
        run.event === 'pull_request_target' && run.head_sha === tx.approval.head_sha &&
        run.head_branch === live.head.ref)
      .sort((a, b) => b.run_started_at.localeCompare(a.run_started_at));
    if (!runs[0]) return { ok: true, rerun: 'unavailable', credential_class };
    await gh.rerunWorkflow(tx.approval.repo, runs[0].id);
    return { ok: true, rerun: 'requested', credential_class };
  } catch (error) {
    const unavailable = (error as { status?: number }).status === 403;
    return { ok: true, rerun: unavailable ? 'unavailable' : 'failed', credential_class };
  }
}
