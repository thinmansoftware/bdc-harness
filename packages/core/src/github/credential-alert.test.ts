import { afterEach, describe, expect, it } from 'bun:test';
import {
  alertCredentialFailure,
  resetCredentialAlertDedupe,
  CREDENTIAL_ALERT_DEDUPE_MS,
} from './credential-alert';
import type { CreateAuthenticatedMessageData, DispatchSenderContext } from '../db/dispatch';

afterEach(resetCredentialAlertDedupe);

describe('Test 6: credential alert dedupe', () => {
  it('queues exactly one operator message across 10 consecutive failing ticks within 6h', async () => {
    resetCredentialAlertDedupe();
    const sent: CreateAuthenticatedMessageData[] = [];
    const send = async (
      _context: DispatchSenderContext,
      data: CreateAuthenticatedMessageData
    ): Promise<unknown> => {
      sent.push(data);
      return {};
    };
    const base = 1_000_000_000_000;
    for (let tick = 0; tick < 10; tick += 1) {
      await alertCredentialFailure('app-1-2', {
        now: () => base + tick * 60_000, // one minute apart -> all inside 6h
        send,
      });
    }
    expect(sent.length).toBe(1);
    expect(sent[0]?.recipient).toBe('operator');
    expect(sent[0]?.subject_key).toBe('credential:app-1-2');
  });

  it('allows a second message only after the 6h window elapses', async () => {
    resetCredentialAlertDedupe();
    const sent: CreateAuthenticatedMessageData[] = [];
    const send = async (
      _context: DispatchSenderContext,
      data: CreateAuthenticatedMessageData
    ): Promise<unknown> => {
      sent.push(data);
      return {};
    };
    const base = 2_000_000_000_000;
    await alertCredentialFailure('pat', { now: () => base, send });
    // Still inside the window: suppressed.
    await alertCredentialFailure('pat', { now: () => base + CREDENTIAL_ALERT_DEDUPE_MS - 1, send });
    expect(sent.length).toBe(1);
    // Window elapsed: a second message is allowed.
    await alertCredentialFailure('pat', { now: () => base + CREDENTIAL_ALERT_DEDUPE_MS + 1, send });
    expect(sent.length).toBe(2);
  });

  it('does not consume the dedupe slot when the send throws', async () => {
    resetCredentialAlertDedupe();
    let attempts = 0;
    const failingSend = async (): Promise<unknown> => {
      attempts += 1;
      throw new Error('dispatch down');
    };
    const okSent: CreateAuthenticatedMessageData[] = [];
    const okSend = async (
      _context: DispatchSenderContext,
      data: CreateAuthenticatedMessageData
    ): Promise<unknown> => {
      okSent.push(data);
      return {};
    };
    const base = 3_000_000_000_000;
    const first = await alertCredentialFailure('xai', { now: () => base, send: failingSend });
    expect(first).toBe(false);
    expect(attempts).toBe(1);
    // Next tick retries because the failed send did not hold the slot.
    const second = await alertCredentialFailure('xai', { now: () => base + 60_000, send: okSend });
    expect(second).toBe(true);
    expect(okSent.length).toBe(1);
  });
});
