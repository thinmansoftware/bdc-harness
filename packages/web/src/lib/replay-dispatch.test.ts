/**
 * WO-MC-NEGAN-DIAGNOSTIC-GRAPH-01 Scenario 7 — replay request builder.
 */
import { describe, expect, it } from 'bun:test';
import { buildReplayRequest } from './replay-dispatch';

describe('buildReplayRequest', () => {
  it('passes through the original message verbatim when no altModel', () => {
    const r = buildReplayRequest('feature-dev', 'fix the bug');
    expect(r.message).toBe('fix the bug');
    expect(r.model).toBeUndefined();
  });

  it('prepends [model:<name>] and sets the model field when altModel is provided', () => {
    const r = buildReplayRequest('feature-dev', 'fix the bug', 'gpt-5.5');
    expect(r.message.startsWith('[model:gpt-5.5]')).toBe(true);
    expect(r.message).toContain('fix the bug');
    expect(r.model).toBe('gpt-5.5');
  });

  it('preserves the original message body when altModel is provided', () => {
    const original = 'review the diff, then write a manifest';
    const r = buildReplayRequest('feature-dev', original, 'claude-opus-4.7');
    expect(r.message).toContain(original);
  });

  it('treats empty altModel as no override (no [model:] prefix)', () => {
    const r = buildReplayRequest('feature-dev', 'do the thing', '');
    expect(r.message).toBe('do the thing');
    expect(r.model).toBeUndefined();
  });
});
