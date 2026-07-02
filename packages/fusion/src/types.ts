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

/**
 * Persona label -> Fusion reviewer id mapping.
 *
 * When present in fusion.config.json, overrides the code-level default map in
 * routing.ts. Placing this in config makes the "Adversarial Reviewer" -> reviewer
 * id choice (and every other label -> id mapping) an explicit operator commit
 * rather than a code assumption. A null value marks a symbolic-only label
 * (satisfied outside Fusion; not run as a Round-1 reviewer).
 */
export type PersonaMapping = Record<string, string | null>;

export interface FusionConfig {
  reviewers: ReviewerConfig[];
  synthesizer: SynthesizerConfig;
  enableRound2: boolean;
  personaMapping?: PersonaMapping;
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
