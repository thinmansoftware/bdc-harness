import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createHash } from 'crypto';
import { unlinkSync } from 'fs';
import { join } from 'path';
import { SqliteAdapter } from './adapters/sqlite';

// Real SqliteAdapter behind a mocked getDatabase(). This file runs in its own
// `bun test` invocation (see packages/core/package.json), so the process-global
// mock.module here cannot pollute execution-claims.test.ts / board-authority.test.ts.
let db: SqliteAdapter;
let currentDbPath = '';

mock.module('./connection', () => ({
  getDatabase: () => db,
}));

import {
  appendM31Discrepancy,
  capabilityForActionKind,
  compareAndConsumeM31Proposal,
  createM31ActionProposal,
  getM31ActionProposal,
  getM31ChainAssessment,
  getM31Snapshot,
  M31_OBSERVATION_VALIDITY_MS,
  M31ProposalNotFoundError,
  registerM31Snapshot,
  type CreateM31ActionProposalInput,
  type M31ActionProposal,
  type M31LiveObservation,
  type M31SnapshotMemberInput,
  type RegisterM31SnapshotInput,
} from './merge-steward';

const REPO = 'bluedevilcollectibles/bdc-harness';
const T0 = '2026-07-14T00:00:00.000Z';

function hex(len: number, seed: string): string {
  return createHash('sha256').update(seed).digest('hex').slice(0, len);
}

function member(over: Partial<M31SnapshotMemberInput> = {}): M31SnapshotMemberInput {
  const pr = over.pr_number ?? 101;
  return {
    pr_number: pr,
    head_sha: hex(40, `head-${pr}`),
    base_branch: 'dev',
    base_sha: hex(40, 'base'),
    state: 'open',
    checks: { conclusion: 'success' },
    check_source_sha: hex(40, `head-${pr}`),
    checks_observed_at: T0,
    review_state: 'approved',
    mergeability: 'mergeable',
    merge_state_status: 'clean',
    linked_work_evidence: { wo: 'WO-1' },
    evidence_artifact_path: `artifacts/pr-${pr}.json`,
    git_object_format: 'sha1',
    evidence_git_blob: hex(40, `evidence-${pr}`),
    observed_at: T0,
    ...over,
  };
}

function snapshotInput(over: Partial<RegisterM31SnapshotInput> = {}): RegisterM31SnapshotInput {
  return {
    repository: REPO,
    capture_started_at: T0,
    capture_completed_at: T0,
    operator_actor: 'xo-model',
    operator_model: 'claude',
    read_only_query_method: 'gh api (read-only)',
    base_branch: 'dev',
    base_sha: hex(40, 'base'),
    artifact_path: 'artifacts/snapshot.json',
    git_object_format: 'sha1',
    evidence_git_blob: hex(40, `snapshot-${over.evidence_git_blob ?? 'a'}`),
    members: [member()],
    now: T0,
    ...over,
  };
}

function proposalInput(
  snapshotId: string,
  over: Partial<CreateM31ActionProposalInput> = {}
): CreateM31ActionProposalInput {
  return {
    repository: REPO,
    pr_number: 101,
    head_sha: hex(40, 'head-101'),
    base_branch: 'dev',
    base_sha: hex(40, 'base'),
    snapshot_id: snapshotId,
    evidence_path: 'artifacts/proposal.json',
    action_kind: 'MERGE',
    action_parameters: { merge_method: 'squash' },
    actor: 'xo-model',
    policy_digest: hex(64, 'policy'),
    verifier_registry_digest: hex(64, 'verifier'),
    now: T0,
    ...over,
  };
}

function observation(
  proposal: M31ActionProposal,
  over: Partial<M31LiveObservation> = {}
): M31LiveObservation {
  return {
    known: true,
    repository: proposal.repository,
    pr_number: proposal.pr_number,
    head_sha: proposal.head_sha,
    base_branch: proposal.base_branch,
    base_sha: proposal.base_sha,
    policy_digest: proposal.policy_digest,
    verifier_registry_digest: proposal.verifier_registry_digest,
    observed_at: T0,
    ...over,
  };
}

function cleanupDb(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(path + suffix);
    } catch {
      /* file may not exist */
    }
  }
}

async function receiptCount(): Promise<number> {
  const rows = await db.query<{ n: number }>(
    'SELECT COUNT(*) AS n FROM overseer_m31_execution_receipts'
  );
  return Number(rows.rows[0]?.n ?? 0);
}

async function proposalCount(): Promise<number> {
  const rows = await db.query<{ n: number }>(
    'SELECT COUNT(*) AS n FROM overseer_m31_action_proposals'
  );
  return Number(rows.rows[0]?.n ?? 0);
}

describe('m31 merge-steward substrate (sqlite)', () => {
  beforeEach(() => {
    currentDbPath = join(
      import.meta.dir,
      `.test-m31-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    );
    db = new SqliteAdapter(currentDbPath);
  });

  afterEach(async () => {
    await db.close();
    cleanupDb(currentDbPath);
  });

  // Test 1 -- valid snapshot and proposal success.
  test('registers a sorted snapshot and creates a proposal bound to the chain tip', async () => {
    const snap = await registerM31Snapshot(
      snapshotInput({
        members: [
          member({ pr_number: 205 }),
          member({ pr_number: 101 }),
          member({ pr_number: 150 }),
        ],
      })
    );

    expect(snap.schema_version).toBe('m31-substrate-v1');
    // Explicit sorted membership: ordinal follows ascending PR number.
    expect(snap.members.map(m => m.ordinal)).toEqual([0, 1, 2]);
    expect(snap.members.map(m => m.pr_number)).toEqual([101, 150, 205]);
    expect(snap.mutation_succeeded).toBe(false);
    expect(snap.fusion_calls_succeeded).toBe(0);

    const readBack = await getM31Snapshot(snap.snapshot_id);
    expect(readBack?.members.map(m => m.pr_number)).toEqual([101, 150, 205]);

    const created = await createM31ActionProposal(proposalInput(snap.snapshot_id));
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error('expected proposal');
    const p = created.value;
    // Proposal binds every required M-31 identity field.
    expect(p.repository).toBe(REPO);
    expect(p.pr_number).toBe(101);
    expect(p.head_sha).toBe(hex(40, 'head-101'));
    expect(p.base_branch).toBe('dev');
    expect(p.snapshot_id).toBe(snap.snapshot_id);
    expect(p.evidence_git_blob).toBe(hex(40, 'evidence-101'));
    expect(p.action_kind).toBe('MERGE');
    expect(p.capability).toBe(capabilityForActionKind('MERGE'));
    expect(p.policy_digest).toBe(hex(64, 'policy'));
    expect(p.verifier_registry_digest).toBe(hex(64, 'verifier'));
    expect(p.execution_id).toMatch(/[0-9a-f-]{36}/);
    expect(new Date(p.expires_at).getTime()).toBeGreaterThan(new Date(p.created_at).getTime());
  });

  // Test 3 (persistence side) -- final live comparison success writes exactly one receipt.
  test('compare-and-consume issues one permit and appends exactly one receipt', async () => {
    const snap = await registerM31Snapshot(snapshotInput());
    const created = await createM31ActionProposal(proposalInput(snap.snapshot_id));
    if (!created.ok) throw new Error('expected proposal');

    const result = await compareAndConsumeM31Proposal({
      proposal_id: created.value.proposal_id,
      observation: observation(created.value),
      now: T0,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected permit');
    expect(result.permit.execution_id).toBe(created.value.execution_id);
    expect(result.permit.capability).toBe(capabilityForActionKind('MERGE'));
    expect(result.receipt.compare_result).toBe('permit_issued');
    expect(result.receipt.provider_atomic_operation).toBeNull();
    expect(await receiptCount()).toBe(1);
    // Permit is pure data -- it exposes no mutation callback.
    for (const value of Object.values(result.permit)) {
      expect(typeof value).not.toBe('function');
    }
  });

  // Test 2 -- invalid evidence fails closed; no proposal row is created.
  test('rejects an unknown snapshot with snapshot_invalid', async () => {
    const result = await createM31ActionProposal(proposalInput('does-not-exist'));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unexpected');
    expect(result.failure).toBe('snapshot_invalid');
    expect(await proposalCount()).toBe(0);
  });

  test('rejects a proposal from a non-tip snapshot with snapshot_not_chain_tip', async () => {
    const genesis = await registerM31Snapshot(
      snapshotInput({ evidence_git_blob: hex(40, 'snap-genesis') })
    );
    // Successor snapshot continues the chain; genesis is no longer the tip.
    await registerM31Snapshot(
      snapshotInput({
        evidence_git_blob: hex(40, 'snap-tip'),
        predecessor_snapshot_id: genesis.snapshot_id,
        predecessor_evidence_git_blob: genesis.evidence_git_blob,
      })
    );

    const result = await createM31ActionProposal(proposalInput(genesis.snapshot_id));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unexpected');
    expect(result.failure).toBe('snapshot_not_chain_tip');
  });

  test('rejects a forked chain with snapshot_forked', async () => {
    await registerM31Snapshot(snapshotInput({ evidence_git_blob: hex(40, 'snap-fork-a') }));
    const b = await registerM31Snapshot(
      snapshotInput({ evidence_git_blob: hex(40, 'snap-fork-b') })
    );
    // Two genesis snapshots for one repository is a fork.
    const result = await createM31ActionProposal(proposalInput(b.snapshot_id));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unexpected');
    expect(result.failure).toBe('snapshot_forked');
  });

  test('rejects a predecessor digest mismatch with predecessor_digest_mismatch', async () => {
    const genesis = await registerM31Snapshot(
      snapshotInput({ evidence_git_blob: hex(40, 'snap-g2') })
    );
    const tip = await registerM31Snapshot(
      snapshotInput({
        evidence_git_blob: hex(40, 'snap-t2'),
        predecessor_snapshot_id: genesis.snapshot_id,
        // Wrong predecessor blob -- continuity is broken.
        predecessor_evidence_git_blob: hex(40, 'wrong-blob'),
      })
    );
    const result = await createM31ActionProposal(proposalInput(tip.snapshot_id));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unexpected');
    expect(result.failure).toBe('predecessor_digest_mismatch');
  });

  test('rejects an unresolved discrepancy with discrepancy_unresolved', async () => {
    const snap = await registerM31Snapshot(snapshotInput());
    await appendM31Discrepancy({
      snapshot_id: snap.snapshot_id,
      evidence_git_blob: hex(40, 'disc'),
      affected_rows: [{ pr_number: 101 }],
      observed_conflict: 'checks flipped after capture',
      recorder: 'xo-model',
      now: T0,
    });
    const result = await createM31ActionProposal(proposalInput(snap.snapshot_id));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unexpected');
    expect(result.failure).toBe('discrepancy_unresolved');
  });

  test('rejects a missing member with evidence_missing', async () => {
    const snap = await registerM31Snapshot(snapshotInput());
    const result = await createM31ActionProposal(
      proposalInput(snap.snapshot_id, { pr_number: 999, head_sha: hex(40, 'head-999') })
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unexpected');
    expect(result.failure).toBe('evidence_missing');
  });

  test('rejects a head mismatch with evidence_conflicting', async () => {
    const snap = await registerM31Snapshot(snapshotInput());
    const result = await createM31ActionProposal(
      proposalInput(snap.snapshot_id, { head_sha: hex(40, 'different-head') })
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unexpected');
    expect(result.failure).toBe('evidence_conflicting');
  });

  test('rejects stale evidence with evidence_stale', async () => {
    const snap = await registerM31Snapshot(snapshotInput());
    const result = await createM31ActionProposal(
      proposalInput(snap.snapshot_id, {
        now: '2026-07-14T01:00:00.000Z',
        max_evidence_age_ms: 60_000,
      })
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unexpected');
    expect(result.failure).toBe('evidence_stale');
  });

  test('fails closed on an unknown live state with live_state_unknown', async () => {
    const snap = await registerM31Snapshot(snapshotInput());
    const created = await createM31ActionProposal(proposalInput(snap.snapshot_id));
    if (!created.ok) throw new Error('expected proposal');
    const result = await compareAndConsumeM31Proposal({
      proposal_id: created.value.proposal_id,
      observation: observation(created.value, { known: false }),
      now: T0,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unexpected');
    expect(result.failure).toBe('live_state_unknown');
    expect(await receiptCount()).toBe(0);
  });

  test('fails closed on a live-state head mismatch with live_state_mismatch', async () => {
    const snap = await registerM31Snapshot(snapshotInput());
    const created = await createM31ActionProposal(proposalInput(snap.snapshot_id));
    if (!created.ok) throw new Error('expected proposal');
    const result = await compareAndConsumeM31Proposal({
      proposal_id: created.value.proposal_id,
      observation: observation(created.value, { head_sha: hex(40, 'moved-head') }),
      now: T0,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unexpected');
    expect(result.failure).toBe('live_state_mismatch');
    expect(await receiptCount()).toBe(0);
  });

  test('fails closed on a policy digest mismatch and a verifier registry mismatch', async () => {
    const snap = await registerM31Snapshot(snapshotInput());
    const created = await createM31ActionProposal(proposalInput(snap.snapshot_id));
    if (!created.ok) throw new Error('expected proposal');

    const polResult = await compareAndConsumeM31Proposal({
      proposal_id: created.value.proposal_id,
      observation: observation(created.value, { policy_digest: hex(64, 'other-policy') }),
      now: T0,
    });
    expect(polResult.ok).toBe(false);
    if (polResult.ok) throw new Error('unexpected');
    expect(polResult.failure).toBe('policy_digest_mismatch');

    const verResult = await compareAndConsumeM31Proposal({
      proposal_id: created.value.proposal_id,
      observation: observation(created.value, {
        verifier_registry_digest: hex(64, 'other-verifier'),
      }),
      now: T0,
    });
    expect(verResult.ok).toBe(false);
    if (verResult.ok) throw new Error('unexpected');
    expect(verResult.failure).toBe('verifier_registry_mismatch');
    expect(await receiptCount()).toBe(0);
  });

  test('fails closed on an expired proposal with proposal_expired', async () => {
    const snap = await registerM31Snapshot(snapshotInput());
    const created = await createM31ActionProposal(
      proposalInput(snap.snapshot_id, { now: T0, ttl_ms: 1_000 })
    );
    if (!created.ok) throw new Error('expected proposal');
    const result = await compareAndConsumeM31Proposal({
      proposal_id: created.value.proposal_id,
      observation: observation(created.value, { observed_at: '2026-07-14T00:00:30.000Z' }),
      now: '2026-07-14T00:00:30.000Z', // past the 1s TTL
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unexpected');
    expect(result.failure).toBe('proposal_expired');
    expect(await receiptCount()).toBe(0);
  });

  // Test 4 -- stale observation boundary (60s passes, 61s fails).
  test('accepts a 60-second-old observation and rejects a 61-second-old one', async () => {
    const snap = await registerM31Snapshot(snapshotInput());

    const pOk = await createM31ActionProposal(proposalInput(snap.snapshot_id));
    if (!pOk.ok) throw new Error('expected proposal');
    const ok60 = await compareAndConsumeM31Proposal({
      proposal_id: pOk.value.proposal_id,
      observation: observation(pOk.value, { observed_at: T0 }),
      now: '2026-07-14T00:01:00.000Z', // exactly 60s later
    });
    expect(ok60.ok).toBe(true);

    const pStale = await createM31ActionProposal(proposalInput(snap.snapshot_id));
    if (!pStale.ok) throw new Error('expected proposal');
    const stale61 = await compareAndConsumeM31Proposal({
      proposal_id: pStale.value.proposal_id,
      observation: observation(pStale.value, { observed_at: T0 }),
      now: '2026-07-14T00:01:01.000Z', // 61s later
    });
    expect(stale61.ok).toBe(false);
    if (stale61.ok) throw new Error('unexpected');
    expect(stale61.failure).toBe('observation_stale');

    expect(M31_OBSERVATION_VALIDITY_MS).toBe(60_000);
    // Only the 60s permit consumed an execution ID.
    expect(await receiptCount()).toBe(1);
  });

  // Test 5 -- replay and idempotency.
  test('consumes a proposal exactly once and rejects replays with proposal_replayed', async () => {
    const snap = await registerM31Snapshot(snapshotInput());
    const created = await createM31ActionProposal(proposalInput(snap.snapshot_id));
    if (!created.ok) throw new Error('expected proposal');

    const first = await compareAndConsumeM31Proposal({
      proposal_id: created.value.proposal_id,
      observation: observation(created.value),
      now: T0,
    });
    expect(first.ok).toBe(true);

    const replay = await compareAndConsumeM31Proposal({
      proposal_id: created.value.proposal_id,
      observation: observation(created.value),
      now: T0,
    });
    expect(replay.ok).toBe(false);
    if (replay.ok) throw new Error('unexpected');
    expect(replay.failure).toBe('proposal_replayed');
    expect(await receiptCount()).toBe(1);
  });

  test('throws M31ProposalNotFoundError when the proposal row is absent', async () => {
    const snap = await registerM31Snapshot(snapshotInput());
    const created = await createM31ActionProposal(proposalInput(snap.snapshot_id));
    if (!created.ok) throw new Error('expected proposal');
    const missingObs = observation(created.value);
    await expect(
      compareAndConsumeM31Proposal({
        proposal_id: 'no-such-proposal',
        observation: missingObs,
        now: T0,
      })
    ).rejects.toBeInstanceOf(M31ProposalNotFoundError);
  });

  // Test 6 -- lineage evidence remains non-operative.
  test('retains lineage evidence without admitting a successor into membership', async () => {
    const snap = await registerM31Snapshot(
      snapshotInput({
        members: [
          member({
            pr_number: 101,
            linked_work_evidence: {
              repository: REPO,
              predecessor_pr: 101,
              predecessor_head_sha: hex(40, 'head-101'),
              successor_pr: 202,
              successor_head_sha: hex(40, 'head-202'),
              evidence_timestamp: T0,
              proof_method: 'gh api (read-only)',
              proof_result: 'linked',
              linked_wo_evidence: 'WO-2',
              independent_reviewer: 'general-model',
            },
          }),
        ],
      })
    );

    const readBack = await getM31Snapshot(snap.snapshot_id);
    // Membership is exactly the one captured PR; the successor is NOT a member.
    expect(readBack?.members.map(m => m.pr_number)).toEqual([101]);
    const lineage = readBack?.members[0]?.linked_work_evidence as { successor_pr: number };
    expect(lineage.successor_pr).toBe(202);

    // The successor PR is ineligible: no member evidence exists for it.
    const result = await createM31ActionProposal(
      proposalInput(snap.snapshot_id, { pr_number: 202, head_sha: hex(40, 'head-202') })
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unexpected');
    expect(result.failure).toBe('evidence_missing');
  });

  test('chain assessment reports the single tip for a linear chain', async () => {
    const genesis = await registerM31Snapshot(
      snapshotInput({ evidence_git_blob: hex(40, 'snap-c1') })
    );
    const tip = await registerM31Snapshot(
      snapshotInput({
        evidence_git_blob: hex(40, 'snap-c2'),
        predecessor_snapshot_id: genesis.snapshot_id,
        predecessor_evidence_git_blob: genesis.evidence_git_blob,
      })
    );
    const assessment = await getM31ChainAssessment(REPO);
    expect(assessment.snapshot_count).toBe(2);
    expect(assessment.forked).toBe(false);
    expect(assessment.tip_snapshot_id).toBe(tip.snapshot_id);
    expect(assessment.unresolved_discrepancies).toBe(0);
  });

  // Append-only enforcement on every M-31 table.
  test('all five M-31 tables reject UPDATE and DELETE (append-only)', async () => {
    const snap = await registerM31Snapshot(snapshotInput());
    const created = await createM31ActionProposal(proposalInput(snap.snapshot_id));
    if (!created.ok) throw new Error('expected proposal');
    await compareAndConsumeM31Proposal({
      proposal_id: created.value.proposal_id,
      observation: observation(created.value),
      now: T0,
    });
    await appendM31Discrepancy({
      snapshot_id: snap.snapshot_id,
      evidence_git_blob: hex(40, 'disc-x'),
      affected_rows: [],
      observed_conflict: 'x',
      recorder: 'xo-model',
      now: T0,
    });

    const mutations: Array<[string, string]> = [
      ['UPDATE overseer_m31_snapshots SET repository = $1', 'DELETE FROM overseer_m31_snapshots'],
      [
        'UPDATE overseer_m31_snapshot_members SET state = $1',
        'DELETE FROM overseer_m31_snapshot_members',
      ],
      [
        'UPDATE overseer_m31_discrepancies SET recorder = $1',
        'DELETE FROM overseer_m31_discrepancies',
      ],
      [
        'UPDATE overseer_m31_action_proposals SET actor = $1',
        'DELETE FROM overseer_m31_action_proposals',
      ],
      [
        'UPDATE overseer_m31_execution_receipts SET compare_result = $1',
        'DELETE FROM overseer_m31_execution_receipts',
      ],
    ];
    for (const [updateSql, deleteSql] of mutations) {
      await expect(db.query(updateSql, ['tamper'])).rejects.toThrow(/append-only/);
      await expect(db.query(deleteSql)).rejects.toThrow(/append-only/);
    }
  });

  test('rejects duplicate snapshot membership for the same PR', async () => {
    // Explicit membership: a snapshot cannot list the same PR twice.
    await expect(
      registerM31Snapshot(
        snapshotInput({ members: [member({ pr_number: 101 }), member({ pr_number: 101 })] })
      )
    ).rejects.toThrow();
    expect(
      (await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM overseer_m31_snapshots')).rows[0]?.n
    ).toBe(0);
  });

  test('read helpers return null for absent ids', async () => {
    expect(await getM31Snapshot('nope')).toBeNull();
    expect(await getM31ActionProposal('nope')).toBeNull();
  });
});
