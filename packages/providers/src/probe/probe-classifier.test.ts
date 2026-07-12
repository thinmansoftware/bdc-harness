import { describe, expect, test } from 'bun:test';
import { classifyProbeError } from './probe-classifier';

const pinnedIncidentBody =
  'The qwen/qwen3-coder model is not supported when using Codex with a ChatGPT account.';

describe('classifyProbeError', () => {
  test('classifies the pinned 2026-07-11 codex-opr incident as structural', () => {
    const result = classifyProbeError({ httpStatus: 400, body: pinnedIncidentBody });
    expect(result.kind).toBe('structural');
    expect(result.errorClass).toBe('structural_model_not_supported');
  });

  test('classifies unsupported model 400s as structural model access failures', () => {
    const result = classifyProbeError({ httpStatus: 400, body: 'The selected model is not supported.' });
    expect(result.kind).toBe('structural');
    expect(result.errorClass).toBe('structural_model_not_supported');
  });

  test('classifies rate limits as transient', () => {
    const result = classifyProbeError({ httpStatus: 429, body: 'rate limit exceeded' });
    expect(result.kind).toBe('transient');
    expect(result.errorClass).toBe('transient_rate_limit');
  });

  test('keeps unclassified 400s fail-open as unknown', () => {
    const result = classifyProbeError({ httpStatus: 400, body: 'bad request: malformed payload' });
    expect(result.kind).toBe('unknown');
    expect(result.errorClass).toBe('unknown_400');
  });
});
