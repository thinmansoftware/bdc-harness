/**
 * WO-MC-NEGAN-DIAGNOSTIC-GRAPH-01 Scenario 2 — failure classification tests.
 */
import { describe, expect, it } from 'bun:test';
import { classifyFailure } from './failure-reason';

describe('classifyFailure', () => {
  it('classifies the codex 400 model-not-supported case (the WO anchor)', () => {
    const err = 'Provider returned 400: model gpt-5.3-codex is not supported for this account';
    const r = classifyFailure(err);
    expect(r.label).toBe('codex 400: model not supported');
    expect(r.detail).toBe(err);
  });

  it('classifies 401/unauthorized as auth', () => {
    expect(classifyFailure('Request failed with 401 Unauthorized').label).toBe(
      'auth: invalid token'
    );
    expect(classifyFailure('Invalid API key').label).toBe('auth: invalid token');
  });

  it('classifies 429/rate-limit', () => {
    expect(classifyFailure('429 Too Many Requests; rate limit exceeded').label).toBe('rate-limit');
    expect(classifyFailure('rate-limit hit').label).toBe('rate-limit');
  });

  it('classifies SIGKILL/crash/OOM', () => {
    expect(classifyFailure('Process exited via SIGKILL').label).toBe('crash');
    expect(classifyFailure('out of memory').label).toBe('crash');
    expect(classifyFailure('OOM killed worker').label).toBe('crash');
  });

  it('classifies timeouts', () => {
    expect(classifyFailure('ETIMEDOUT contacting upstream').label).toBe('timeout');
    expect(classifyFailure('request timed out after 30s').label).toBe('timeout');
  });

  it('falls through to unknown for opaque errors', () => {
    expect(classifyFailure('something weird happened').label).toBe('unknown');
  });

  it('preserves the original error text in detail', () => {
    const raw = 'Provider gpt-5.3-codex returned 400: model not supported';
    const r = classifyFailure(raw);
    expect(r.detail).toBe(raw);
    // Empty/undefined inputs do not crash.
    expect(classifyFailure(undefined).detail).toBe('');
    expect(classifyFailure(null).detail).toBe('');
    expect(classifyFailure(undefined).label).toBe('unknown');
  });
});
