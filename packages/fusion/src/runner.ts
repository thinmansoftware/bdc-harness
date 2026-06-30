import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { DEFAULT_REVIEWERS, EMPTY_USAGE, addUsage, estimateCost } from './config';
import { callModel as defaultCallModel } from './gateway';
import { buildSynthesis } from './synthesis';
import { buildReviewerPrompt } from './templates/prompts';
import type {
  CallModelResult,
  FusionRunInput,
  FusionRunResult,
  ManifestV2,
  ReviewerArtifact,
  TokenUsage,
} from './types';
import { redactSecrets } from './redaction';

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function safeSlug(slug: string): string {
  return slug
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function reviewerStatus(result: CallModelResult, requestedModelId: string): ReviewerArtifact['status'] {
  if (!result.ok || result.text.trim().length === 0) {
    return 'MISSING';
  }
  return result.servedModelId === requestedModelId ? 'PASS' : 'FAIL';
}

function manifestValidation(reviewers: ReviewerArtifact[]): ManifestV2['validation'] {
  const errors = reviewers.flatMap((reviewer) => {
    const reviewerErrors: string[] = [];
    if (reviewer.status === 'MISSING') {
      reviewerErrors.push(`${reviewer.role} reviewer is MISSING`);
    }
    if (reviewer.served_model_mismatch) {
      reviewerErrors.push(
        `${reviewer.role} served model ${reviewer.served_model_id ?? 'MISSING'} did not match ${reviewer.requested_model_id}`
      );
    }
    return reviewerErrors;
  });

  return {
    status: errors.length === 0 ? 'PASS' : 'FAIL',
    errors,
  };
}

export async function runFusion(input: FusionRunInput): Promise<FusionRunResult> {
  const slug = safeSlug(input.slug);
  if (!slug) {
    throw new Error('Fusion run slug must include at least one alphanumeric character');
  }

  const outputRoot = input.outputRoot ?? 'fusion-runs';
  const runDir = join(outputRoot, slug);
  const roundDir = join(runDir, 'round-1');
  await mkdir(roundDir, { recursive: true });

  const redactedDiff = redactSecrets(input.diff);
  const diffPath = join(runDir, 'diff.patch');
  await writeFile(diffPath, redactedDiff);

  const gateway = input.callModel ?? defaultCallModel;
  const reviewers = input.reviewers ?? DEFAULT_REVIEWERS;
  const outputs: Record<string, string> = {};
  const reviewerArtifacts: ReviewerArtifact[] = [];
  let totalUsage: TokenUsage = EMPTY_USAGE;

  for (const reviewer of reviewers) {
    const prompt = buildReviewerPrompt({
      role: reviewer.role,
      workOrder: input.workOrder,
      diff: redactedDiff,
    });
    const promptPath = join(roundDir, `${reviewer.role}.prompt.md`);
    const outputPath = join(roundDir, `${reviewer.role}.md`);
    await writeFile(promptPath, prompt);

    const result = await gateway({
      role: reviewer.role,
      modelId: reviewer.modelId,
      prompt,
    });
    const status = reviewerStatus(result, reviewer.modelId);
    const servedModelMismatch =
      result.servedModelId.length > 0 && result.servedModelId !== reviewer.modelId;
    const outputText =
      status === 'MISSING'
        ? `MISSING reviewer: ${result.error ?? 'no usable response returned'}\n`
        : result.text;

    await writeFile(outputPath, outputText);
    outputs[reviewer.role] = outputText;
    totalUsage = addUsage(totalUsage, result.usage);

    reviewerArtifacts.push({
      role: reviewer.role,
      requested_model_id: reviewer.modelId,
      served_model_id: result.servedModelId || null,
      ok: result.ok && status === 'PASS',
      status,
      prompt_path: relative(runDir, promptPath),
      output_path: relative(runDir, outputPath),
      error: result.error,
      token_usage: result.usage,
      served_model_mismatch: servedModelMismatch,
    });
  }

  const synthesis = buildSynthesis({
    slug,
    workOrder: input.workOrder,
    reviewers: reviewerArtifacts,
    outputs,
  });
  const synthesisPath = join(runDir, 'synthesis.md');
  await writeFile(synthesisPath, synthesis);

  const validation = manifestValidation(reviewerArtifacts);
  const manifest: ManifestV2 = {
    schema_version: 2,
    run_id: input.runId ?? randomUUID(),
    slug,
    created_at: new Date().toISOString(),
    status: validation.status === 'PASS' ? 'PASS' : 'NEEDS_REVISION',
    artifact_sha256: sha256(`${redactedDiff}\n${synthesis}`),
    token_usage: totalUsage,
    cost_estimate: {
      currency: 'USD',
      amount: estimateCost(totalUsage),
      note: 'Approximate blended estimate for manifest accounting only.',
    },
    reviewers: reviewerArtifacts,
    validation,
  };
  const manifestPath = join(runDir, 'manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    runDir,
    synthesisPath,
    manifestPath,
    manifest,
  };
}
