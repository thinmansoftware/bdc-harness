export type ReviewerStatus = 'PASS' | 'FAIL' | 'MISSING';

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface CallModelRequest {
  role: string;
  modelId: string;
  prompt: string;
}

export interface CallModelResult {
  text: string;
  servedModelId: string;
  usage: TokenUsage;
  ok: boolean;
  error?: string;
}

export type CallModel = (request: CallModelRequest) => Promise<CallModelResult>;

export interface ReviewerConfig {
  role: string;
  modelId: string;
}

export interface ReviewerArtifact {
  role: string;
  requested_model_id: string;
  served_model_id: string | null;
  ok: boolean;
  status: ReviewerStatus;
  prompt_path: string;
  output_path: string;
  error?: string;
  token_usage: TokenUsage;
  served_model_mismatch: boolean;
}

export interface ManifestV2 {
  schema_version: 2;
  run_id: string;
  slug: string;
  created_at: string;
  status: 'PASS' | 'NEEDS_REVISION';
  artifact_sha256: string;
  token_usage: TokenUsage;
  cost_estimate: {
    currency: 'USD';
    amount: number;
    note: string;
  };
  reviewers: ReviewerArtifact[];
  validation: {
    status: 'PASS' | 'FAIL';
    errors: string[];
  };
}

export interface FusionRunInput {
  slug: string;
  diff: string;
  workOrder: string;
  outputRoot?: string;
  runId?: string;
  reviewers?: ReviewerConfig[];
  callModel?: CallModel;
}

export interface FusionRunResult {
  runDir: string;
  synthesisPath: string;
  manifestPath: string;
  manifest: ManifestV2;
}
