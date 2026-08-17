/**
 * WO-HARNESS-OVERSEER-REVIEW-ROUTE-01: the extracted webhook signature helper.
 *
 * These tests pin the behavior the ORIGINAL private GitHubAdapter method had,
 * so the extraction is provably a refactor and not a rewrite. Network-free and
 * deterministic: HMAC over fixed inputs with a fixed secret.
 */
import { describe, expect, test } from 'bun:test';
import { createHmac } from 'crypto';
import { checkGitHubWebhookSignature, verifyGitHubWebhookSignature } from './webhook-signature';

const SECRET = 'test-webhook-secret';
const PAYLOAD = JSON.stringify({ action: 'opened', number: 7 });

function sign(payload: string, secret = SECRET): string {
  return 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex');
}

describe('checkGitHubWebhookSignature', () => {
  test('accepts a correct signature', () => {
    expect(checkGitHubWebhookSignature(PAYLOAD, sign(PAYLOAD), SECRET)).toEqual({ valid: true });
  });

  test('boolean wrapper accepts a correct signature', () => {
    expect(verifyGitHubWebhookSignature(PAYLOAD, sign(PAYLOAD), SECRET)).toBe(true);
  });

  test('rejects a signature computed with the wrong secret', () => {
    const result = checkGitHubWebhookSignature(PAYLOAD, sign(PAYLOAD, 'wrong-secret'), SECRET);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('digest_mismatch');
  });

  test('rejects a tampered payload (signature no longer matches)', () => {
    const signature = sign(PAYLOAD);
    const tampered = JSON.stringify({ action: 'opened', number: 8 });
    const result = checkGitHubWebhookSignature(tampered, signature, SECRET);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('digest_mismatch');
  });

  test('rejects a length mismatch WITHOUT throwing (timingSafeEqual would throw)', () => {
    const result = checkGitHubWebhookSignature(PAYLOAD, 'sha256=deadbeef', SECRET);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('length_mismatch');
  });

  test('rejects a missing signature', () => {
    expect(checkGitHubWebhookSignature(PAYLOAD, undefined, SECRET)).toEqual({
      valid: false,
      reason: 'missing_signature',
    });
    expect(checkGitHubWebhookSignature(PAYLOAD, '', SECRET)).toEqual({
      valid: false,
      reason: 'missing_signature',
    });
  });

  test('rejects an unprefixed hex digest (prefix is part of the contract)', () => {
    const bare = createHmac('sha256', SECRET).update(PAYLOAD).digest('hex');
    expect(checkGitHubWebhookSignature(PAYLOAD, bare, SECRET).valid).toBe(false);
  });

  test('failure diagnostics never leak the secret or a full digest', () => {
    const result = checkGitHubWebhookSignature(PAYLOAD, sign(PAYLOAD, 'other'), SECRET);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(SECRET);
    expect(result.computedPrefix?.endsWith('...')).toBe(true);
    expect((result.computedPrefix ?? '').length).toBeLessThan(25);
  });

  test('empty payload with a valid signature is accepted (empty != invalid)', () => {
    expect(checkGitHubWebhookSignature('', sign(''), SECRET).valid).toBe(true);
  });

  test('is byte-exact: whitespace-differing payloads do not cross-validate', () => {
    const signature = sign(PAYLOAD);
    expect(checkGitHubWebhookSignature(PAYLOAD + ' ', signature, SECRET).valid).toBe(false);
  });
});
