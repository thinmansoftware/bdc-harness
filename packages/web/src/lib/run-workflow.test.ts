/**
 * WO-MC-NEGAN-DIAGNOSTIC-GRAPH-01 — runWorkflow API contract.
 *
 * Pins the wire contract for `POST /api/workflows/:name/run`:
 *   - Always sends `conversationId` and `message`.
 *   - When `model` is supplied AND non-empty, includes a `model` field in
 *     the JSON body so the "Replay with alt model" affordance actually
 *     carries the operator's choice to the server instead of silently
 *     dropping it (which was the diff reviewer's HIGH-severity finding
 *     against the original implementation).
 *   - When `model` is omitted or empty, the body has NO `model` key (so
 *     the server schema does not see a phantom override on a normal run).
 *
 * The test mocks `globalThis.fetch` to capture the outbound body without
 * needing a server or React. The mock is restored in `afterEach`.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { runWorkflow } from './api';

interface CapturedCall {
  url: string;
  init: RequestInit | undefined;
}

describe('runWorkflow body', () => {
  const original: typeof globalThis.fetch = globalThis.fetch;
  let captured: CapturedCall[] = [];

  beforeEach(() => {
    captured = [];
    // window.location is referenced by the error path of fetchJSON but not
    // on the happy path; provide it defensively for safety.
    if (typeof globalThis.window === 'undefined') {
      (globalThis as unknown as { window: { location: { origin: string } } }).window = {
        location: { origin: 'http://localhost' },
      };
    }
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      captured.push({ url, init });
      return new Response(JSON.stringify({ accepted: true, status: 'queued' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = original;
  });

  it('includes only conversationId and message when no model override', async () => {
    await runWorkflow('feature-dev', 'conv-1', 'fix the bug');
    expect(captured.length).toBe(1);
    const body = JSON.parse(String(captured[0].init?.body)) as Record<string, unknown>;
    expect(body.conversationId).toBe('conv-1');
    expect(body.message).toBe('fix the bug');
    expect('model' in body).toBe(false);
  });

  it('forwards a non-empty model as a first-class body field', async () => {
    await runWorkflow('feature-dev', 'conv-2', '[model:gpt-5.5] fix the bug', 'gpt-5.5');
    expect(captured.length).toBe(1);
    const body = JSON.parse(String(captured[0].init?.body)) as Record<string, unknown>;
    expect(body.conversationId).toBe('conv-2');
    expect(body.message).toBe('[model:gpt-5.5] fix the bug');
    // Critical: the operator's model choice MUST appear on the wire. The
    // earlier implementation silently discarded this; sending it lets
    // server-side handlers consume it (and at minimum makes it visible
    // to network-level audit logging).
    expect(body.model).toBe('gpt-5.5');
  });

  it('omits an empty-string model so the server does not see a phantom override', async () => {
    await runWorkflow('feature-dev', 'conv-3', 'do the thing', '');
    expect(captured.length).toBe(1);
    const body = JSON.parse(String(captured[0].init?.body)) as Record<string, unknown>;
    expect('model' in body).toBe(false);
  });
});
