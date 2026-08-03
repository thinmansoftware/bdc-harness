import { createHash } from 'crypto';
import { describe, expect, test } from 'bun:test';
import {
  createBoardPrincipalResolver,
  isBoardPrincipalRegistryConfigured,
  parseBoardPrincipalRecords,
} from './board-principal-registry';

function digest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const XO_TOKEN = 'xo-secret-token-value';
const JOHN_TOKEN = 'john-secret-token-value';

function configJson(overrides?: { status?: string }): string {
  return JSON.stringify([
    {
      principal_id: 'xo-desktop-claude',
      seat_id: 'xo',
      roles: ['board'],
      token_sha256: digest(XO_TOKEN),
      status: overrides?.status ?? 'active',
    },
    {
      principal_id: 'john',
      seat_id: 'john',
      roles: ['board', 'human'],
      token_sha256: digest(JOHN_TOKEN),
      status: 'active',
    },
  ]);
}

describe('board principal registry', () => {
  test('resolves a principal from a matching holder token', async () => {
    const resolve = createBoardPrincipalResolver({ configJson: configJson() });
    const principal = await resolve({ holder_id: 'xo-desktop-claude', holder_token: XO_TOKEN });
    expect(principal?.principal_id).toBe('xo-desktop-claude');
    expect(principal?.seat_id).toBe('xo');
  });

  test('accepts principal_token as well as holder_token', async () => {
    const resolve = createBoardPrincipalResolver({ configJson: configJson() });
    const principal = await resolve({ principal_token: JOHN_TOKEN });
    expect(principal?.seat_id).toBe('john');
  });

  test('rejects a wrong token, a wrong holder_id, and a disabled record', async () => {
    const resolve = createBoardPrincipalResolver({ configJson: configJson() });
    expect(await resolve({ holder_id: 'xo-desktop-claude', holder_token: 'nope' })).toBeNull();
    // Right token, wrong identity claim -- must not resolve to another seat.
    expect(await resolve({ holder_id: 'john', holder_token: XO_TOKEN })).toBeNull();
    expect(await resolve({})).toBeNull();

    const disabled = createBoardPrincipalResolver({
      configJson: configJson({ status: 'disabled' }),
    });
    expect(await disabled({ holder_id: 'xo-desktop-claude', holder_token: XO_TOKEN })).toBeNull();
  });

  test('returns null when no registry is configured', async () => {
    const resolve = createBoardPrincipalResolver({ configJson: '' });
    expect(await resolve({ holder_token: XO_TOKEN })).toBeNull();
    expect(isBoardPrincipalRegistryConfigured('')).toBe(false);
    expect(isBoardPrincipalRegistryConfigured(configJson())).toBe(true);
  });

  test('rejects malformed config rather than silently trusting it', () => {
    expect(() => parseBoardPrincipalRecords('{"not":"an array"}')).toThrow(
      'board_principals_config_invalid'
    );
    expect(() => parseBoardPrincipalRecords('not json')).toThrow('board_principals_config_invalid');
    // Bad seat.
    expect(() =>
      parseBoardPrincipalRecords(
        JSON.stringify([
          {
            principal_id: 'x',
            seat_id: 'emperor',
            roles: [],
            token_sha256: digest('t'),
            status: 'active',
          },
        ])
      )
    ).toThrow('board_principals_config_invalid');
    // Non-hex digest (e.g. a raw token pasted in by mistake).
    expect(() =>
      parseBoardPrincipalRecords(
        JSON.stringify([
          {
            principal_id: 'x',
            seat_id: 'xo',
            roles: [],
            token_sha256: 'plaintext',
            status: 'active',
          },
        ])
      )
    ).toThrow('board_principals_config_invalid');
    // Duplicate principal ids.
    expect(() =>
      parseBoardPrincipalRecords(
        JSON.stringify([
          {
            principal_id: 'dup',
            seat_id: 'xo',
            roles: [],
            token_sha256: digest('a'),
            status: 'active',
          },
          {
            principal_id: 'dup',
            seat_id: 'xo',
            roles: [],
            token_sha256: digest('b'),
            status: 'active',
          },
        ])
      )
    ).toThrow('board_principals_config_invalid');
  });

  test('isBoardPrincipalRegistryConfigured is false for malformed config (fails closed)', () => {
    expect(isBoardPrincipalRegistryConfigured('not json')).toBe(false);
  });
});
