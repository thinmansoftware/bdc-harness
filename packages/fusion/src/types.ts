/**
 * types.ts -- Core type definitions for Cauldron Fusion v0.1
 *
 * Fusion is an ADVISORY ONLY tool. It reads, reviews, and writes local files.
 * It does NOT: edit repos, comment on GitHub, approve PRs, merge, or deploy.
 */

// ---------------------------------------------------------------------------
// Model gateway seam
// ---------------------------------------------------------------------------

export interface ModelCallRequest {
  role: string;
  modelId: string;
  prompt: string;
}

export interface ModelCallResult {
  text: string;
  servedModelId: string | null;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  ok: boolean;
  error: string | null;
}

export type ModelGateway = (req: ModelCallRequest) => Promise<ModelCallResult>;

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

export interface ReviewerConfig {
  id: string;
  modelId: string;
  role: string;
  promptTemplate: string;
}

export interface SynthesizerConfig {
  modelId: string;
  promptTemplate: string;
}

export interface FusionConfig {
  reviewers: ReviewerConfig[];
  synthesizer: SynthesizerConfig;
  enableRound2: boolean;
}

// ---------------------------------------------------------------------------
// Run inputs
// ---------------------------------------------------------------------------

export interface FusionInputs {
  woId: string;
  woSpec: string;
  diff: string;
  tests: string;
  manifest: string;
  captainCi: string;
}

// ---------------------------------------------------------------------------
// Review results
// ---------------------------------------------------------------------------

export interface ReviewerResult {
  id: string;
  requestedModelId: string;
  servedModelId: string | null;
  ok: boolean;
  error: string | null;
  text: string;
  tokens: { inputTokens: number; outputTokens: number; totalTokens: number };
}

export interface SynthesizerResult {
  modelId: string;
  servedModelId: string | null;
  ok: boolean;
  text: string;
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export type RunStatus = 'completed' | 'completed-with-missing-reviewers' | 'failed';

export interface ManifestReviewer {
  id: string;
  requestedModelId: string;
  servedModelId: string | null;
  ok: boolean;
  error: string | null;
  tokens: { inputTokens: number; outputTokens: number; totalTokens: number };
}

export interface ManifestSynthesizer {
  modelId: string;
  servedModelId: string | null;
  ok: boolean;
}

export interface RunManifest {
  run_id: string;
  created_at: string;
  mode: 'pr-review';
  artifact_name: string;
  artifact_sha256: string;
  models: string[];
  reviewers: ManifestReviewer[];
  synthesizer: ManifestSynthesizer;
  token_usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  cost_estimate: null;
  status: RunStatus;
  output_files: string[];
}

// ---------------------------------------------------------------------------
// Secret redaction
// ---------------------------------------------------------------------------

export interface RedactResult {
  redacted: string;
  findings: string[];
}
