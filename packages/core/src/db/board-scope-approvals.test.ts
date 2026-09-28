import { afterEach, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'crypto';
import { unlinkSync } from 'fs';
import { join } from 'path';
import { SqliteAdapter } from './adapters/sqlite';
import { getScopeApprovalDecision, recordScopeApproval, revokeScopeApproval, type ScopeApprovalGitHub } from './board-scope-approvals';

const paths: string[] = [];
const now = '2026-06-01T12:00:00.000Z';
const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const principal = { principal_id: 'p-xo', seat_id: 'xo' as const, roles: [] };
const proof = { principal, holder_id: 'holder', holder_token: 'secret', fencing_token: 7 };

async function fixture() {
  const path = join(import.meta.dir, `.scope-${randomUUID()}.db`);
  paths.push(path);
  const db = new SqliteAdapter(path);
  await db.query(`INSERT INTO board_xo_leases
    (id,lease_id,principal_id,seat_id,holder_id,holder_token_hash,fencing_token,acquired_at,expires_at,released_at)
    VALUES (1,$1,$2,'xo',$3,$4,7,$5,$6,NULL)`, [
    'lease-1', principal.principal_id, proof.holder_id,
    createHash('sha256').update(proof.holder_token).digest('hex'), now, '2026-06-01T13:00:00.000Z',
  ]);
  const github: ScopeApprovalGitHub = { fetchPullRequest: async () => ({ state: 'open', head: { sha: head, ref: 'feature' }, base: { sha: base, ref: 'release/ce' } }) };
  return { db, github };
}

afterEach(() => {
  for (const path of paths.splice(0)) for (const suffix of ['', '-wal', '-shm']) {
    try { unlinkSync(path + suffix); } catch { /* absent */ }
  }
});

describe('CE scope approval store', () => {
  test('records server-owned fields, enforces proof, and is immutable/idempotent', async () => {
    const { db, github } = await fixture();
    const input = { ...proof, repo: 'thinmansoftware/lspro-react', pr_number: 12, head_sha: head, conditions: 'ten files reviewed', evidence_url: 'https://example.test/evidence' };
    const first = await recordScopeApproval(input, { db, github, now: async () => now });
    expect(first.ok && first.created).toBe(true);
    if (!first.ok) throw new Error('expected approval');
    expect(first.approval).toMatchObject({ authority: 'john', base_sha: base, target_branch: 'release/ce', recorded_by_principal_id: principal.principal_id });
    const second = await recordScopeApproval({ ...input, conditions: 'attempted rewrite' }, { db, github, now: async () => now });
    expect(second.ok && !second.created && second.approval.conditions).toBe('ten files reviewed');
    expect(await recordScopeApproval({ ...input, fencing_token: 8 }, { db, github, now: async () => now })).toEqual({ ok: false, reason: 'stale_xo_lease_token' });
    await db.close();
  });

  test('rejects repository, moved head, and closed PR', async () => {
    const { db, github } = await fixture();
    const input = { ...proof, repo: 'other/repo', pr_number: 12, head_sha: head, conditions: 'ok', evidence_url: 'https://example.test/e' };
    expect(await recordScopeApproval(input, { db, github })).toEqual({ ok: false, reason: 'repo_not_allowed' });
    const moved = { fetchPullRequest: async () => ({ state: 'open', head: { sha: 'c'.repeat(40), ref: 'feature' }, base: { sha: base, ref: 'release/ce' } }) };
    expect(await recordScopeApproval({ ...input, repo: 'thinmansoftware/lspro-react' }, { db, github: moved })).toEqual({ ok: false, reason: 'head_moved' });
    const closed = { fetchPullRequest: async () => ({ state: 'closed', head: { sha: head, ref: 'feature' }, base: { sha: base, ref: 'release/ce' } }) };
    expect(await recordScopeApproval({ ...input, repo: 'thinmansoftware/lspro-react' }, { db, github: closed })).toEqual({ ok: false, reason: 'pr_not_open' });
    await db.close();
  });

  test('revocation denies reads, paginates to newest trusted run, and never reruns twice', async () => {
    const { db, github } = await fixture();
    const input = { ...proof, repo: 'thinmansoftware/lspro-react', pr_number: 12, head_sha: head, conditions: 'ok', evidence_url: 'https://example.test/e' };
    const recorded = await recordScopeApproval(input, { db, github, now: async () => now });
    if (!recorded.ok) throw new Error('expected approval');
    const pages: number[] = [];
    const reruns: number[] = [];
    const run = (id: number, started: string) => ({ id, path: '.github/workflows/ce-change-scope-gate.yml', event: 'pull_request_target', head_sha: head, head_branch: 'feature', run_started_at: started });
    const revocationGithub: ScopeApprovalGitHub = { ...github,
      listWorkflowRuns: async (_repo, _sha, page) => { pages.push(page); return page === 1 ? { runs: [run(1, '2026-06-01T10:00:00Z')], hasNext: true } : { runs: [run(2, '2026-06-01T11:00:00Z')] }; },
      rerunWorkflow: async (_repo, id) => { reruns.push(id); },
    };
    const revokeInput = { ...proof, approval_id: recorded.approval.approval_id, reason: 'withdrawn' };
    expect(await revokeScopeApproval(revokeInput, { db, github: revocationGithub, now: async () => now })).toMatchObject({ ok: true, rerun: 'requested' });
    expect(pages).toEqual([1, 2]);
    expect(reruns).toEqual([2]);
    expect(await getScopeApprovalDecision({ repo: input.repo, pr_number: 12, head_sha: head, base_sha: base }, { db })).toEqual({ decision: 'deny', reason: 'revoked' });
    await revokeScopeApproval({ ...revokeInput, reason: 'again' }, { db, github: revocationGithub, now: async () => now });
    expect(reruns).toEqual([2]);
    await db.close();
  });

  test('fails closed when stored approval details do not match the indexed identity', async () => {
    const { db, github } = await fixture();
    const input = { ...proof, repo: 'thinmansoftware/lspro-react', pr_number: 12, head_sha: head, conditions: 'ok', evidence_url: 'https://example.test/e' };
    const recorded = await recordScopeApproval(input, { db, github, now: async () => now });
    if (!recorded.ok) throw new Error('expected approval');
    await db.query('DROP TRIGGER IF EXISTS board_audit_events_no_update');
    await db.query('DROP TRIGGER IF EXISTS trg_board_audit_events_no_update');
    await db.query("UPDATE board_audit_events SET details=$1 WHERE event_type='ce_scope_approval_recorded'", [
      JSON.stringify({ ...recorded.approval, head_sha: 'c'.repeat(40) }),
    ]);
    expect(await getScopeApprovalDecision({ repo: input.repo, pr_number: 12, head_sha: head, base_sha: base }, { db }))
      .toEqual({ decision: 'deny', reason: 'malformed' });
    await db.close();
  });
});
