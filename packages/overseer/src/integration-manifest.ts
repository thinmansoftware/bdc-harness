/**
 * M-42 Slice 8 parent evidence ledger and manifest assembly.
 *
 * Honest three-state evidence only: satisfied | unsatisfied | indeterminate.
 * Never fabricates retroactive reviews. Missing or incomplete child evidence
 * yields BLOCKED with no readiness packet.
 */

export type EvidenceState = 'satisfied' | 'unsatisfied' | 'indeterminate';

export const REQUIRED_M42_CHILD_WO_IDS = [
  'WO-HARNESS-OVERSEER-SAFETY-GATES-STAGING-01',
  'WO-HARNESS-OVERSEER-M31-SUBSTRATE-01',
  'WO-HARNESS-OVERSEER-ESCALATION-BRIEFING-01',
  'WO-HARNESS-OVERSEER-M31-CONTRACT-V2-01',
  'WO-HARNESS-OVERSEER-CONTROL-PLANE-01',
  'WO-HARNESS-OVERSEER-REPAIR-REFIRE-01',
  'WO-HARNESS-OVERSEER-REFRESH-REBASE-01',
  'WO-HARNESS-OVERSEER-LIFECYCLE-SALVAGE-01',
  'WO-HARNESS-OVERSEER-QUALIFIED-MERGE-01',
] as const;

export type M42ChildWoId = (typeof REQUIRED_M42_CHILD_WO_IDS)[number];

const CHILD_SLICE_KEY: Record<M42ChildWoId, string> = {
  'WO-HARNESS-OVERSEER-SAFETY-GATES-STAGING-01': 's1',
  'WO-HARNESS-OVERSEER-M31-SUBSTRATE-01': 's2',
  'WO-HARNESS-OVERSEER-ESCALATION-BRIEFING-01': 's3',
  'WO-HARNESS-OVERSEER-M31-CONTRACT-V2-01': 's2b',
  'WO-HARNESS-OVERSEER-CONTROL-PLANE-01': 'control_plane',
  'WO-HARNESS-OVERSEER-REPAIR-REFIRE-01': 's4',
  'WO-HARNESS-OVERSEER-REFRESH-REBASE-01': 's5',
  'WO-HARNESS-OVERSEER-LIFECYCLE-SALVAGE-01': 's6',
  'WO-HARNESS-OVERSEER-QUALIFIED-MERGE-01': 's7',
};

const SHA1_RE = /^[0-9a-f]{40}$/;
const SHA256_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

export interface ChildReviewEvidence {
  readonly state: EvidenceState;
  readonly reviewer_login?: string;
  readonly commit_id?: string;
}

export interface ChildEvidenceRecord {
  readonly wo_id: string;
  readonly base_sha: string;
  readonly pr_head: string;
  readonly reviewed_head: string;
  readonly merge_sha: string;
  readonly pr_number: number;
  readonly review: ChildReviewEvidence;
}

export interface ParentEvidenceInput {
  readonly children: readonly ChildEvidenceRecord[];
  readonly migrations?: Readonly<Record<string, readonly string[]>>;
  readonly contract_blobs?: Readonly<Record<string, string>>;
  readonly candidate_sha?: string;
  readonly image_digest?: string;
  readonly prior_staging_sha?: string;
}

export interface SliceEvidenceSummary {
  readonly wo_id: string;
  readonly review: ChildReviewEvidence;
  readonly identity_ok: boolean;
  readonly merge_sha: string | null;
}

export interface ReducedParentEvidence {
  readonly slices: Readonly<Record<string, SliceEvidenceSummary>>;
  readonly overall: EvidenceState;
  readonly missing: readonly string[];
  readonly blockers: readonly string[];
}

export interface ParentReadinessPacket {
  readonly candidate_sha: string;
  readonly image_digest: string;
  readonly children: readonly ChildEvidenceRecord[];
  readonly status: 'READY_FOR_SANDBOX_PROOF_REQUEST';
}

export interface OverseerParentManifest {
  readonly status: 'BLOCKED' | 'READY_FOR_SANDBOX_PROOF_REQUEST';
  readonly blockers: readonly string[];
  readonly slices: Readonly<Record<string, SliceEvidenceSummary>>;
  readonly children: readonly ChildEvidenceRecord[];
  readonly migrations_ok: boolean;
  readonly readiness_packet: ParentReadinessPacket | null;
  readonly candidate_sha: string | null;
  readonly image_digest: string | null;
}

function isHex40(value: string): boolean {
  return SHA1_RE.test(value);
}

function validateChildIdentity(child: ChildEvidenceRecord): string[] {
  const blockers: string[] = [];
  if (!isHex40(child.base_sha)) {
    blockers.push(`${child.wo_id}: invalid or empty base_sha`);
  }
  if (!isHex40(child.pr_head)) {
    blockers.push(`${child.wo_id}: invalid or empty pr_head`);
  }
  if (!isHex40(child.reviewed_head)) {
    blockers.push(`${child.wo_id}: invalid or empty reviewed_head`);
  }
  if (!isHex40(child.merge_sha)) {
    blockers.push(`${child.wo_id}: invalid or empty merge_sha`);
  }
  if (
    isHex40(child.pr_head) &&
    isHex40(child.reviewed_head) &&
    child.pr_head !== child.reviewed_head
  ) {
    blockers.push(`${child.wo_id}: reviewed_head must equal pr_head`);
  }
  if (!Number.isInteger(child.pr_number) || child.pr_number <= 0) {
    blockers.push(`${child.wo_id}: invalid pr_number`);
  }
  return blockers;
}

/**
 * Reduce child records into a three-state parent evidence ledger.
 * Missing reviews stay unsatisfied; merge SHAs never imply approval.
 */
export function reduceParentEvidence(input: {
  readonly children: readonly ChildEvidenceRecord[];
}): ReducedParentEvidence {
  const byId = new Map<string, ChildEvidenceRecord>();
  const blockers: string[] = [];
  const seen = new Set<string>();

  for (const child of input.children) {
    if (seen.has(child.wo_id)) {
      blockers.push(`duplicate child id: ${child.wo_id}`);
      continue;
    }
    seen.add(child.wo_id);
    byId.set(child.wo_id, child);
  }

  const missing: string[] = [];
  const slices: Record<string, SliceEvidenceSummary> = {};
  let overall: EvidenceState = 'satisfied';

  for (const woId of REQUIRED_M42_CHILD_WO_IDS) {
    const key = CHILD_SLICE_KEY[woId];
    const child = byId.get(woId);
    if (!child) {
      missing.push(woId);
      slices[key] = {
        wo_id: woId,
        review: { state: 'unsatisfied' },
        identity_ok: false,
        merge_sha: null,
      };
      overall = 'unsatisfied';
      continue;
    }

    const identityBlockers = validateChildIdentity(child);
    const identityOk = identityBlockers.length === 0;
    if (!identityOk) {
      blockers.push(...identityBlockers);
      if (overall === 'satisfied') overall = 'unsatisfied';
    }

    const reviewState = child.review.state;
    if (reviewState === 'unsatisfied' && overall === 'satisfied') overall = 'unsatisfied';
    if (reviewState === 'indeterminate' && overall === 'satisfied') overall = 'indeterminate';
    if (reviewState === 'indeterminate' && overall === 'unsatisfied') {
      // unsatisfied dominates
    }

    slices[key] = {
      wo_id: woId,
      review: { ...child.review },
      identity_ok: identityOk,
      merge_sha: isHex40(child.merge_sha) ? child.merge_sha : null,
    };
  }

  if (missing.length > 0 && overall === 'satisfied') overall = 'unsatisfied';
  if (blockers.length > 0 && overall === 'satisfied') overall = 'unsatisfied';

  return {
    slices,
    overall,
    missing,
    blockers,
  };
}

function validateMigrations(migrations: Readonly<Record<string, readonly string[]>> | undefined): {
  ok: boolean;
  blockers: string[];
} {
  const blockers: string[] = [];
  if (!migrations) {
    return { ok: false, blockers: ['migrations inventory missing'] };
  }

  const m029 = migrations['029'] ?? [];
  if (m029.length !== 2) {
    blockers.push(`029 baseline must be exactly 2 files, got ${m029.length}`);
  } else {
    const expected = new Set(['029_board_authority_foundation.sql', '029_known_bad_bindings.sql']);
    for (const name of m029) {
      if (!expected.has(name)) blockers.push(`unexpected 029 migration: ${name}`);
    }
  }

  for (const prefix of ['035', '036', '037'] as const) {
    const files = migrations[prefix] ?? [];
    if (files.length !== 1) {
      blockers.push(`migration prefix ${prefix} must have exactly one file, got ${files.length}`);
    }
  }

  return { ok: blockers.length === 0, blockers };
}

/**
 * Assemble the parent integration manifest. Rejects missing/indeterminate
 * child evidence and never invents review satisfaction.
 */
export function buildOverseerParentManifest(input: ParentEvidenceInput): OverseerParentManifest {
  const reduced = reduceParentEvidence({ children: input.children });
  const blockers = [...reduced.blockers];

  for (const woId of reduced.missing) {
    blockers.push(`missing child evidence: ${woId}`);
  }

  for (const slice of Object.values(reduced.slices)) {
    if (slice.review.state === 'unsatisfied') {
      blockers.push(`unsatisfied review evidence: ${slice.wo_id}`);
    }
    if (slice.review.state === 'indeterminate') {
      blockers.push(`indeterminate review evidence: ${slice.wo_id}`);
    }
  }

  const migrationCheck = validateMigrations(input.migrations);
  blockers.push(...migrationCheck.blockers);

  if (input.candidate_sha !== undefined && !isHex40(input.candidate_sha)) {
    blockers.push('invalid candidate_sha');
  }
  if (input.image_digest !== undefined && !SHA256_DIGEST_RE.test(input.image_digest)) {
    blockers.push('invalid image_digest');
  }

  const allReviewsSatisfied = Object.values(reduced.slices).every(
    s => s.review.state === 'satisfied' && s.identity_ok
  );
  const candidateSha = input.candidate_sha;
  const imageDigest = input.image_digest;
  const candidateOk = typeof candidateSha === 'string' && isHex40(candidateSha);
  const imageOk = typeof imageDigest === 'string' && SHA256_DIGEST_RE.test(imageDigest);
  const ready =
    reduced.missing.length === 0 &&
    allReviewsSatisfied &&
    migrationCheck.ok &&
    candidateOk &&
    imageOk &&
    blockers.length === 0;

  if (
    !ready ||
    !candidateOk ||
    !imageOk ||
    candidateSha === undefined ||
    imageDigest === undefined
  ) {
    return {
      status: 'BLOCKED',
      blockers,
      slices: reduced.slices,
      children: [...input.children],
      migrations_ok: migrationCheck.ok,
      readiness_packet: null,
      candidate_sha: input.candidate_sha ?? null,
      image_digest: input.image_digest ?? null,
    };
  }

  return {
    status: 'READY_FOR_SANDBOX_PROOF_REQUEST',
    blockers: [],
    slices: reduced.slices,
    children: [...input.children],
    migrations_ok: true,
    readiness_packet: {
      candidate_sha: candidateSha,
      image_digest: imageDigest,
      children: [...input.children],
      status: 'READY_FOR_SANDBOX_PROOF_REQUEST',
    },
    candidate_sha: candidateSha,
    image_digest: imageDigest,
  };
}
