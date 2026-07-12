import { describe, expect, test } from 'bun:test';
import fixture from './fixtures/unsupported-model-400.codex-opr.json';
import { classifyProbeError } from './probe-classifier';

describe('probe classifier', () => {
  test('pins the 2026-07-11 qwen ChatGPT-account incident body', () => {
    const result = classifyProbeError({ httpStatus: fixture.httpStatus, body: fixture.body });
    expect(result.kind).toBe('structural');
    expect(result.errorClass).toBe(fixture.expectClass);
  });

  test('classifies structural model rejection', () => {
    const result = classifyProbeError({ httpStatus: 400, message: 'model abc is not supported' });
    expect(result.kind).toBe('structural');
  });

  test('classifies transient rejection distinctly', () => {
    const result = classifyProbeError({ httpStatus: 429, message: 'rate limit exceeded' });
    expect(result.kind).toBe('transient');
    expect(result.errorClass).toBe('transient_rate_limit');
  });

  test('classifies unknown 400 distinctly from transient', () => {
    const result = classifyProbeError({ httpStatus: 400, message: 'bad request: malformed input' });
    expect(result.kind).toBe('unknown');
    expect(result.errorClass).toBe('unknown_400');
  });
});
