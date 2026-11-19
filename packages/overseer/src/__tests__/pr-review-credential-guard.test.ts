import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bodyHasCredentialShape, findCredentialInReviewBody } from '../pr-review-submit';

/** Random-looking token material, built the way the real ones look (no secret in the repo). */
function mix(length: number, alphabet: string, seed: number): string {
  // mulberry32: a small, well-mixed seeded generator (the real keys are random, not patterned)
  let state = seed >>> 0;
  let out = '';
  for (let i = 0; i < length; i += 1) {
    state = (state + 0x6d2b79f5) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    out += alphabet[((z ^ (z >>> 14)) >>> 0) % alphabet.length];
  }
  return out;
}
const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const B64U = `${B62}-_`;

describe('review body credential guard (bdc-xo#5550)', () => {
  test('real-looking tokens still block', () => {
    const tokens = [
      `ghp_${mix(36, B62, 1)}`,
      `gho_${mix(36, B62, 2)}`,
      `ghs_${mix(40, B62, 3)}`,
      `github_pat_${mix(82, B64U, 4)}`,
      `sk-${mix(48, B62, 5)}`,
      `sk-proj-${mix(100, B64U, 6)}`,
      `sk-ant-api03-${mix(90, B64U, 7)}`,
      `Bearer ${mix(60, B64U, 8)}`,
      `Bearer ${mix(32, '0123456789abcdef', 9)}`,
      `Authorization: Bearer eyJ${mix(40, B64U, 10)}.${mix(60, B64U, 11)}.${mix(43, B64U, 12)}`,
      `leaked ghp_${'x'.repeat(32)}`,
    ];
    for (const token of tokens) {
      expect(bodyHasCredentialShape(`The reviewer pasted this: ${token} and then more text.`)).toBe(
        true
      );
    }
  });

  // The tilde marks keep this file's own text from matching the old pattern when a reviewer quotes the diff.
  test('ordinary names and prose do not block (the five refused heads of bdc-xo PR 5518)', () => {
    const body = [
      'Independent review by the Overseer App at head `db7f98818`.',
      '',
      'The spec docs/work-orders/WO-DESK~-EBAY-BOX-RECIPIENT-01.md adds the box recipient step to the',
      'receiving-shipping desk (WO-DESK~-EBAY-BOX-RECIPIENT-01). No blocking findings.',
      'Branch archon/task~-web-worker-1794420438767-0s31w6 and risk~-assessment-of-the-whole-pipeline-is-low.',
      'A Bearer authentication-scheme-and-token-handling note and a desk~-checkout-webhook-paid-order id.',
    ].join('\n');
    expect(bodyHasCredentialShape(body)).toBe(false);
    for (const name of [
      'WO-DESK~-EBAY-BOX-RECIPIENT-01',
      'WO-TASK~-WEB-WORKER-CHECKOUT-WEBHOOK-PAID-ORDER-01',
      'desk~-ebay-box-recipient-01-thread-eb16a1bf',
    ])
      expect(bodyHasCredentialShape(name)).toBe(false);
  });

  test('a login-file secret in the body blocks and names the FIELD, never the value', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'overseer-login-'));
    try {
      const secret = mix(64, B64U, 21);
      const path = join(dir, 'auth.json');
      await writeFile(
        path,
        JSON.stringify({
          auth_mode: 'chatgpt',
          tokens: {
            access_token: secret,
            oauth_provenance: {
              issuer: 'https://auth.example.com/issuer',
              client_id: 'app_clientidentifier12345',
            },
            account_id: '11111111-2222-3333-4444-555555555555',
          },
          last_refresh: '2026-11-11T18:02:11.123456789Z',
        })
      );
      const hit = await findCredentialInReviewBody(`value ${secret} appeared`, path);
      expect(hit).toEqual({ kind: 'login_field', field: 'tokens.access_token' });
      expect(JSON.stringify(hit)).not.toContain(secret);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('identifiers in the login file (issuer, client id, account id, refresh time) do not block', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'overseer-login-'));
    try {
      const path = join(dir, 'auth.json');
      const identifiers = {
        issuer: 'https://auth.example.com/issuer',
        client_id: 'app_clientidentifier12345',
        account_id: '11111111-2222-3333-4444-555555555555',
        last_refresh: '2026-11-11T18:02:11.123456789Z',
      };
      await writeFile(
        path,
        JSON.stringify({
          tokens: {
            access_token: mix(64, B64U, 22),
            oauth_provenance: identifiers,
            account_id: identifiers.account_id,
          },
          last_refresh: identifiers.last_refresh,
        })
      );
      const body = `Quoted: ${Object.values(identifiers).join(' ')}`;
      expect(await findCredentialInReviewBody(body, path)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a JWT-shaped login value blocks even under an unexpected field name', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'overseer-login-'));
    try {
      const jwt = `eyJ${mix(30, B64U, 31)}.${mix(50, B64U, 32)}.${mix(43, B64U, 33)}`;
      const path = join(dir, 'auth.json');
      await writeFile(path, JSON.stringify({ session: { blob: jwt } }));
      expect(await findCredentialInReviewBody(`pasted ${jwt}`, path)).toEqual({
        kind: 'login_field',
        field: 'session.blob',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a missing login file leaves only the shape guard', async () => {
    expect(
      await findCredentialInReviewBody('plain text', join(tmpdir(), 'no-such-auth.json'))
    ).toBeNull();
    expect(
      await findCredentialInReviewBody(
        `ghp_${mix(36, B62, 41)}`,
        join(tmpdir(), 'no-such-auth.json')
      )
    ).toEqual({ kind: 'generic_shape' });
  });
});
