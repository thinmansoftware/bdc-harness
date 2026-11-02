/**
 * manifest.ts -- Build and write the run manifest (manifest.json)
 *
 * The manifest is the audit record for a Fusion run. It captures:
 *   - All reviewer results with served model IDs and ok flags
 *   - Token usage aggregated across all calls
 *   - Run status: 'completed' or 'completed-with-missing-reviewers'
 *   - SHA256 of input.md for integrity verification
 */

import { createHash, randomUUID } from 'crypto';
import type {
  ReviewerResult,
  SynthesizerResult,
  RunManifest,
  RunStatus,
  ManifestReviewer,
} from './types.js';

/**
 * buildManifest -- assemble a RunManifest from round results.
 */
export function buildManifest(opts: {
  woId: string;
  inputMdContents: string;
  reviewerResults: ReviewerResult[];
  synthesizerResult: SynthesizerResult;
  outputFiles: string[];
}): RunManifest {
  const { woId, inputMdContents, reviewerResults, synthesizerResult, outputFiles } = opts;

  const sha256 = createHash('sha256').update(inputMdContents, 'utf8').digest('hex');

  const hasAnyMissing = reviewerResults.some(r => !r.ok);
  const status: RunStatus = hasAnyMissing ? 'completed-with-missing-reviewers' : 'completed';

  const manifestReviewers: ManifestReviewer[] = reviewerResults.map(r => ({
    id: r.id,
    requestedModelId: r.requestedModelId,
    servedModelId: r.servedModelId,
    ok: r.ok,
    error: r.error,
    tokens: r.tokens,
  }));

  // Aggregate token usage across all calls
  const totalTokens = reviewerResults.reduce(
    (acc, r) => ({
      inputTokens: acc.inputTokens + r.tokens.inputTokens,
      outputTokens: acc.outputTokens + r.tokens.outputTokens,
      totalTokens: acc.totalTokens + r.tokens.totalTokens,
    }),
    { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  );

  const models = [...reviewerResults.map(r => r.requestedModelId), synthesizerResult.modelId];

  return {
    run_id: randomUUID(),
    created_at: new Date().toISOString(),
    mode: 'pr-review',
    artifact_name: woId,
    artifact_sha256: sha256,
    models,
    reviewers: manifestReviewers,
    synthesizer: {
      modelId: synthesizerResult.modelId,
      servedModelId: synthesizerResult.servedModelId,
      ok: synthesizerResult.ok,
    },
    token_usage: totalTokens,
    cost_estimate: null,
    status,
    output_files: outputFiles,
  };
}
