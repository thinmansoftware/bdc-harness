import { createHash } from 'node:crypto';
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import {
  finalizeExternalEvidence,
  prepareExternalManifest,
  resolveExternalArtifactInput,
  resolveExternalArtifactRoot,
  type CompleteRollbackProof,
  type CompleteStagingProof,
  type ExternalSeedManifest,
} from '../external-finalization';
import { REQUIRED_M42_CHILD_WO_IDS } from '../integration-manifest';

const HEAD = 'a'.repeat(40);
const PRIOR = 'b'.repeat(40);
const TRANSCRIPT = 'fable independent exact-head review\n';
const digest = `sha256:${createHash('sha256').update(TRANSCRIPT).digest('hex')}`;
const temps: string[] = [];

afterEach(() => {
  for (const path of temps.splice(0)) rmSync(path, { recursive: true, force: true });
});

const seed: ExternalSeedManifest = {
  schema_version: 'm42-parent-manifest-v1',
  wo_id: 'WO-HARNESS-OVERSEER-INTEGRATION-ACTIVATION-01',
  builder: { provider: 'openai', model: 'codex-gpt-5' },
  prior_staging_sha: PRIOR,
  migrations: {
    '029': ['029_board_authority_foundation.sql', '029_known_bad_bindings.sql'],
    '035': ['035_overseer_escalation_briefing.sql'],
    '036': ['036_overseer_m31_target_contract_v2.sql'],
    '037': ['037_overseer_control_plane.sql'],
  },
  verifier_registry_digest: 'f'.repeat(64),
  children: REQUIRED_M42_CHILD_WO_IDS.map((woId, index) => ({
    wo_id: woId,
    base_sha: 'c'.repeat(40),
    pr_head: `${index + 1}`.repeat(40),
    reviewed_head: `${index + 1}`.repeat(40),
    merge_sha: 'd'.repeat(40),
    pr_number: 450 + index,
  })),
};

const staging: CompleteStagingProof = {
  schema_version: 'm42-staging-proof-v1',
  candidate_sha: HEAD,
  image_digest: `sha256:${'e'.repeat(64)}`,
  container_name: 'archon-m42-staging',
  host: 'LAPTOP-BQ6IEJNC',
  watcher_count: 1,
  adapter_mode: 'fake',
  emergency_stop: true,
  disabled_capabilities: ['repair', 'branch', 'merge', 'lifecycle', 'escalation'],
  receipt_count: 5,
  operator_card_count: 2,
  real_call_count: 0,
  credential_env_present: [],
  credential_files_present: [],
};

const rollback: CompleteRollbackProof = {
  schema_version: 'm42-rollback-proof-v1',
  candidate_sha: HEAD,
  prior_staging_sha: PRIOR,
  rollback_status: 'restored',
  active_sha: PRIOR,
  candidate_running: false,
  evidence_retained: true,
};

const review = {
  schema_version: 'm42-independent-review-v1' as const,
  candidate_sha: HEAD,
  child_heads: Object.fromEntries(seed.children.map(child => [child.wo_id, child.pr_head])),
  builder: seed.builder,
  reviewer: { provider: 'anthropic', model: 'claude-opus-4-1' },
  verdicts: {
    parent: 'APPROVED' as const,
    children: Object.fromEntries(seed.children.map(child => [child.wo_id, 'APPROVED' as const])),
  },
  raw_transcript_sha256: digest,
  reviewed_at: '2026-07-16T12:00:00.000Z',
  findings: [],
};

describe('M42 external evidence finalization', () => {
  test('rejects repository overlap and traversal before creating output', () => {
    const repo = mkdtempSync(join(tmpdir(), 'm42-finalizer-repo-'));
    const external = mkdtempSync(join(tmpdir(), 'm42-finalizer-external-'));
    temps.push(repo, external);
    const internalAttempt = join(repo, 'must-not-exist');

    expect(() => resolveExternalArtifactRoot(internalAttempt, repo)).toThrow(
      'artifact_root_repository_overlap'
    );
    expect(existsSync(internalAttempt)).toBe(false);
    expect(() => resolveExternalArtifactRoot(dirname(repo), repo)).toThrow(
      'artifact_root_repository_overlap'
    );
    expect(() => resolveExternalArtifactRoot(`${external}${sep}..${sep}escape`, repo)).toThrow(
      'artifact_root_traversal'
    );

    const resolved = resolveExternalArtifactRoot(join(external, 'approved'), repo);
    expect(existsSync(resolved)).toBe(true);
    const outsideInput = join(repo, 'outside.json');
    writeFileSync(outsideInput, '{}\n', 'utf8');
    expect(() => resolveExternalArtifactInput(outsideInput, resolved, 'review')).toThrow(
      'review_outside_artifact_root'
    );
  });

  test('rejects an existing junction ancestor that resolves into the repository', () => {
    const repo = mkdtempSync(join(tmpdir(), 'm42-finalizer-junction-repo-'));
    const external = mkdtempSync(join(tmpdir(), 'm42-finalizer-junction-external-'));
    temps.push(repo, external);
    const junction = join(external, 'repo-junction');
    symlinkSync(repo, junction, 'junction');
    try {
      expect(() => resolveExternalArtifactRoot(join(junction, 'evidence'), repo)).toThrow(
        'artifact_root_repository_overlap'
      );
      expect(existsSync(join(repo, 'evidence'))).toBe(false);
    } finally {
      unlinkSync(junction);
    }
  });

  test('prepares a post-head external BLOCKED manifest without changing source', () => {
    const prepared = prepareExternalManifest(seed, HEAD, HEAD, 484, 'f'.repeat(64));
    expect(prepared.head_sha).toBe(HEAD);
    expect(prepared.pr_number).toBe(484);
    expect(prepared.status).toBe('BLOCKED');
  });

  test('finalizes exact proof and review into READY manifest plus unsigned packets', () => {
    const result = finalizeExternalEvidence({
      seed,
      current_head: HEAD,
      live_pr_head: HEAD,
      pr_number: 484,
      staging_proof: staging,
      rollback_proof: rollback,
      review_artifact: review,
      raw_review_transcript: TRANSCRIPT,
    });
    expect(result.manifest.status).toBe('READY_FOR_SANDBOX_PROOF_REQUEST');
    expect(result.manifest.blockers).toEqual([]);
    expect(result.manifest.scenario_receipts).toEqual({
      receipt_count: 5,
      operator_card_count: 2,
      real_call_count: 0,
      adapter_mode: 'fake',
    });
    expect(result.activation_bundle.sandbox_proof_request.signed).toBe(false);
    expect(result.activation_bundle.deploy_activation_request.signed).toBe(false);
  });

  test('fails closed on PR-head, staging, rollback, or review drift', () => {
    expect(() => prepareExternalManifest(seed, HEAD, 'f'.repeat(40), 484, 'f'.repeat(64))).toThrow(
      'pr_head_mismatch'
    );
    expect(() =>
      finalizeExternalEvidence({
        seed,
        current_head: HEAD,
        live_pr_head: HEAD,
        pr_number: 484,
        staging_proof: { ...staging, real_call_count: 1 },
        rollback_proof: rollback,
        review_artifact: review,
        raw_review_transcript: TRANSCRIPT,
      })
    ).toThrow('staging_proof_invalid');
    expect(() =>
      finalizeExternalEvidence({
        seed,
        current_head: HEAD,
        live_pr_head: HEAD,
        pr_number: 484,
        staging_proof: staging,
        rollback_proof: { ...rollback, candidate_running: true },
        review_artifact: review,
        raw_review_transcript: TRANSCRIPT,
      })
    ).toThrow('rollback_proof_invalid');

    const duplicateChildren = [...seed.children];
    duplicateChildren[8] = duplicateChildren[0]!;
    expect(() =>
      finalizeExternalEvidence({
        seed: { ...seed, children: duplicateChildren },
        current_head: HEAD,
        live_pr_head: HEAD,
        pr_number: 484,
        staging_proof: staging,
        rollback_proof: rollback,
        review_artifact: review,
        raw_review_transcript: TRANSCRIPT,
      })
    ).toThrow('child_coverage_incomplete');
  });
});
