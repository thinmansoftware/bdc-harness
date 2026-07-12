import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createMockLogger } from '../../test/mocks/logger';

const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

const softRefreshCodexMock = mock(async () => false);
mock.module('../../codex/soft-refresh.js', () => ({
  softRefreshCodex: softRefreshCodexMock,
}));

import { checkCodexDispatchGate } from '../dispatch-gate';

let tempHome: string;
let homedirSpy: ReturnType<typeof spyOn>;

function codexCredsPath(): string {
  return path.join(tempHome, '.codex', 'auth.json');
}

function placeholderJwt(payload: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.SIGNATURE_PLACEHOLDER`;
}

function writeCodexCreds(
  lastRefresh: string,
  refreshToken = 'eyJ_REFRESH_PLACEHOLDER',
  accessToken = 'eyJ_ACCESS_PLACEHOLDER'
): void {
  fs.mkdirSync(path.dirname(codexCredsPath()), { recursive: true });
  fs.writeFileSync(
    codexCredsPath(),
    JSON.stringify(
      {
        OPENAI_API_KEY: null,
        tokens: {
          id_token: 'eyJ_ID_PLACEHOLDER',
          access_token: accessToken,
          refresh_token: refreshToken,
          account_id: 'ACCT_PLACEHOLDER',
        },
        last_refresh: lastRefresh,
      },
      null,
      2
    ),
    { mode: 0o600 }
  );
}

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dispatch-gate-'));
  homedirSpy = spyOn(os, 'homedir').mockReturnValue(tempHome);
  softRefreshCodexMock.mockReset();
  softRefreshCodexMock.mockImplementation(async () => false);
  mockLogger.info.mockClear();
  mockLogger.error.mockClear();
  mockLogger.debug.mockClear();
  mockLogger.warn.mockClear();
});

afterEach(() => {
  homedirSpy.mockRestore();
  fs.rmSync(tempHome, { recursive: true, force: true });
});

describe('checkCodexDispatchGate', () => {
  test('passes a ten-day JWT without soft-refresh despite stale last_refresh', async () => {
    const accessToken = placeholderJwt({ exp: Math.floor(Date.now() / 1000) + 10 * 24 * 60 * 60 });
    writeCodexCreds(
      new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString(),
      'REFRESH_PLACEHOLDER',
      accessToken
    );

    const result = await checkCodexDispatchGate();

    expect(result).toEqual({ fresh: true, reason: 'fresh' });
    expect(softRefreshCodexMock).toHaveBeenCalledTimes(0);
  });

  test('soft-refreshes an expired JWT despite recent last_refresh', async () => {
    const accessToken = placeholderJwt({ exp: Math.floor(Date.now() / 1000) - 60 });
    writeCodexCreds(
      new Date(Date.now() - 60_000).toISOString(),
      'REFRESH_PLACEHOLDER',
      accessToken
    );

    const result = await checkCodexDispatchGate();

    expect(result).toEqual({ fresh: false, reason: 'stale' });
    expect(softRefreshCodexMock).toHaveBeenCalledTimes(1);
  });

  test('passes fresh auth without soft-refresh', async () => {
    writeCodexCreds(new Date(Date.now() - 60 * 60 * 1000).toISOString());

    const result = await checkCodexDispatchGate();

    expect(result).toEqual({ fresh: true, reason: 'fresh' });
    expect(softRefreshCodexMock).toHaveBeenCalledTimes(0);
  });

  test('passes when stale auth is advanced by soft-refresh', async () => {
    writeCodexCreds(new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString());
    softRefreshCodexMock.mockImplementationOnce(async () => {
      writeCodexCreds(new Date(Date.now()).toISOString());
      return true;
    });

    const result = await checkCodexDispatchGate();

    expect(result).toEqual({ fresh: true, reason: 'fresh' });
    expect(softRefreshCodexMock).toHaveBeenCalledTimes(1);
  });

  test('refuses when soft-refresh does not advance stale auth', async () => {
    writeCodexCreds(new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString());

    const result = await checkCodexDispatchGate();

    expect(result).toEqual({ fresh: false, reason: 'stale' });
    expect(softRefreshCodexMock).toHaveBeenCalledTimes(1);
  });

  test('refuses missing auth.json', async () => {
    const result = await checkCodexDispatchGate();

    expect(result).toEqual({ fresh: false, reason: 'missing_creds' });
    expect(softRefreshCodexMock).toHaveBeenCalledTimes(1);
  });

  test('does not return token-like fixture values', async () => {
    writeCodexCreds(new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString());

    const result = await checkCodexDispatchGate();

    expect(JSON.stringify(result)).not.toContain('eyJ');
  });
});
