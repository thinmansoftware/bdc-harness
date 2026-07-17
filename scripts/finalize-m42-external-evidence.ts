import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  canonicalJsonStringify,
  verifyWrittenActivationArtifactDigests,
  writeNonGovernanceActivationArtifacts,
} from '../packages/overseer/src/activation-package';
import {
  finalizeExternalEvidence,
  prepareExternalManifest,
  resolveExternalArtifactInput,
  resolveExternalArtifactRoot,
  type CompleteRollbackProof,
  type CompleteStagingProof,
  type ExternalSeedManifest,
} from '../packages/overseer/src/external-finalization';
import type { IndependentReviewArtifact } from '../packages/overseer/src/independent-review-evidence';
import { verifyM42ChildEvidence } from './verify-m42-child-evidence';

function argument(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`missing --${name}`);
  return value;
}

function json(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function livePrHead(prNumber: number): string {
  return execFileSync(
    'gh',
    ['pr', 'view', String(prNumber), '--json', 'headRefOid', '--jq', '.headRefOid'],
    { encoding: 'utf8' }
  ).trim();
}

function main(): void {
  const mode = argument('mode');
  const prNumber = Number(argument('pr-number'));
  const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim();
  const currentHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const remoteHead = livePrHead(prNumber);
  const root = resolveExternalArtifactRoot(argument('artifact-root'), repoRoot);
  const manifestPath = join(root, 'wo-harness-overseer-integration-activation-01.json');

  if (mode === 'prepare') {
    const seedPath = resolve(argument('seed-manifest'));
    const seed = json(seedPath) as ExternalSeedManifest;
    const registryPath = resolveExternalArtifactInput(
      argument('verifier-registry'),
      root,
      'verifier_registry'
    );
    const registryDigest = createHash('sha256').update(readFileSync(registryPath)).digest('hex');
    const prepared = prepareExternalManifest(
      seed,
      currentHead,
      remoteHead,
      prNumber,
      registryDigest
    );
    writeFileSync(manifestPath, `${canonicalJsonStringify(prepared)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify({ ok: true, mode, manifest_path: manifestPath })}\n`);
    return;
  }
  if (mode !== 'finalize') throw new Error('mode must be prepare or finalize');

  const seed = json(manifestPath) as ExternalSeedManifest;
  const childCheck = verifyM42ChildEvidence(seed);
  if (!childCheck.ok) throw new Error(`child evidence invalid: ${childCheck.errors.join('|')}`);
  const reviewPath = resolveExternalArtifactInput(
    argument('review-artifact'),
    root,
    'review_artifact'
  );
  const transcriptPath = resolveExternalArtifactInput(
    argument('review-transcript'),
    root,
    'review_transcript'
  );
  const stagingPath = resolveExternalArtifactInput(
    join(root, 'staging-proof.json'),
    root,
    'staging_proof'
  );
  const rollbackPath = resolveExternalArtifactInput(
    join(root, 'rollback-proof.json'),
    root,
    'rollback_proof'
  );

  const result = finalizeExternalEvidence({
    seed,
    current_head: currentHead,
    live_pr_head: remoteHead,
    pr_number: prNumber,
    staging_proof: json(stagingPath) as CompleteStagingProof,
    rollback_proof: json(rollbackPath) as CompleteRollbackProof,
    review_artifact: json(reviewPath) as IndependentReviewArtifact,
    raw_review_transcript: readFileSync(transcriptPath, 'utf8'),
  });
  const packets = writeNonGovernanceActivationArtifacts(result.activation_bundle, root, root);
  if (!verifyWrittenActivationArtifactDigests(packets)) {
    throw new Error('packet digest verification failed');
  }
  const manifest = {
    ...result.manifest,
    activation_artifacts: packets,
  };
  const manifestTemp = `${manifestPath}.tmp`;
  writeFileSync(manifestTemp, `${canonicalJsonStringify(manifest)}\n`, 'utf8');
  renameSync(manifestTemp, manifestPath);
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      mode,
      manifest_path: manifestPath,
      review_artifact_sha256: result.review_validation.artifact_sha256,
      raw_transcript_sha256: result.review_validation.raw_transcript_sha256,
      packets,
    })}\n`
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
