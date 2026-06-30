import type { ReviewerConfig, TokenUsage } from './types';

export const DEFAULT_REVIEWERS: ReviewerConfig[] = [
  { role: 'correctness', modelId: 'openai/gpt-5.1' },
  { role: 'security-pii', modelId: 'anthropic/claude-sonnet-4.5' },
  { role: 'qa-evidence', modelId: 'google/gemini-2.5-pro' },
  { role: 'scope-doctrine', modelId: 'x-ai/grok-4' },
];

export const EMPTY_USAGE: TokenUsage = {
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
};

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    prompt_tokens: a.prompt_tokens + b.prompt_tokens,
    completion_tokens: a.completion_tokens + b.completion_tokens,
    total_tokens: a.total_tokens + b.total_tokens,
  };
}

export function estimateCost(usage: TokenUsage): number {
  return Number(((usage.total_tokens / 1_000_000) * 5).toFixed(6));
}
