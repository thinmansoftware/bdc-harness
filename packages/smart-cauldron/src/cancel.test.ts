/**
 * cancelRun reason validation.
 *
 * Scope IN item 4 of WO-HARNESS-CONDUCTOR-STALL-DETECTOR-FIX-01: every conductor
 * cancel MUST record a non-empty reason so `run_cancelled.data.reason` is never
 * "". cancelRun fails closed on a missing/blank reason -- it returns
 * { ok: false } WITHOUT making the network call, so the forbidden empty reason
 * can never be persisted. These tests assert both the refusal and that a valid
 * reason is forwarded (trimmed) in the request body.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { cancelRun } from './cancel.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('cancelRun reason validation', () => {
  test('an empty reason is refused and no request is made', async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response('', { status: 200 });
    }) as typeof fetch;

    const result = await cancelRun({
      runId: 'r1',
      apiBaseUrl: 'http://x',
      token: 't',
      reason: '',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('empty reason');
    expect(called).toBe(false);
  });

  test('a whitespace-only reason is refused and no request is made', async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response('', { status: 200 });
    }) as typeof fetch;

    const result = await cancelRun({
      runId: 'r1',
      apiBaseUrl: 'http://x',
      token: 't',
      reason: '   \t  ',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('empty reason');
    expect(called).toBe(false);
  });

  test('a missing reason (undefined despite the required type) is refused', async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response('', { status: 200 });
    }) as typeof fetch;

    // JS caller that omits reason despite the required TS type -- must fail closed.
    const result = await cancelRun({
      runId: 'r1',
      apiBaseUrl: 'http://x',
      token: 't',
    } as unknown as Parameters<typeof cancelRun>[0]);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('empty reason');
    expect(called).toBe(false);
  });

  test('a non-empty reason is forwarded (trimmed) in the request body', async () => {
    let sentBody: unknown = null;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body));
      return new Response('', { status: 200 });
    }) as typeof fetch;

    const result = await cancelRun({
      runId: 'r1',
      apiBaseUrl: 'http://x',
      token: 't',
      reason: '  smart-cauldron stall: no new events; cascade abc  ',
    });

    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
    expect(sentBody).toEqual({ reason: 'smart-cauldron stall: no new events; cascade abc' });
  });
});
