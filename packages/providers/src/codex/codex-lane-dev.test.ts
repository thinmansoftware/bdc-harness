/**
 * Dev-mode Codex construction must hand the SDK the lane launcher shim.
 * Separate bun test process: this file mocks BUNDLED_IS_BINARY=false while
 * binary-guard.test.ts mocks it true, and mock.module is process-global.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockLogger } from '../test/mocks/logger';

const mockLogger = createMockLogger();

mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  BUNDLED_IS_BINARY: false,
  getArchonHome: mock(() => '/tmp/test-archon'),
}));

let capturedOptions: { codexPathOverride?: string } | undefined;

const mockStartThread = mock(() => ({
  id: 'test-thread',
  runStreamed: mock(() =>
    Promise.resolve({
      events: (async function* () {
        yield {
          type: 'turn.completed',
          usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
        };
      })(),
    })
  ),
}));

const MockCodex = mock((opts?: { codexPathOverride?: string }) => {
  capturedOptions = opts;
  return {
    startThread: mockStartThread,
    resumeThread: mock(() => ({})),
  };
});
mock.module('@openai/codex-sdk', () => ({
  Codex: MockCodex,
}));

mock.module('../auth-refresh/index.js', () => ({
  ensureFreshAuth: mock(async () => {}),
  refreshIfAuthFailed: mock(async () => ({ refreshed: false, reason: 'no_creds' as const })),
  isTerminalRefreshReason: () => false,
  buildReauthMessage: (provider: string, reason: string) => `${provider} auth dead (${reason})`,
  AUTH_PATTERNS: [],
  isAuthErrorMessage: () => false,
}));

import { CodexProvider, resetCodexSingleton } from './provider';
import { resolveCodexBinaryPath } from './binary-resolver';
import { LANE_LAUNCHER, setLaneLauncherPathForTests } from '../../../core/src/github/lane-env';

const launcherDir = mkdtempSync(join(tmpdir(), 'codex-lane-launcher-'));
const launcherFile = join(launcherDir, 'archon-lane-exec');
writeFileSync(launcherFile, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

describe('codex dev mode lane isolation', () => {
  let savedIsolation: string | undefined;

  beforeEach(() => {
    resetCodexSingleton();
    MockCodex.mockClear();
    capturedOptions = undefined;
    savedIsolation = process.env.ARCHON_LANE_UID_ISOLATION;
    delete process.env.ARCHON_LANE_UID_ISOLATION;
    setLaneLauncherPathForTests(launcherFile);
  });

  afterEach(() => {
    setLaneLauncherPathForTests(undefined);
    resetCodexSingleton();
    if (savedIsolation === undefined) delete process.env.ARCHON_LANE_UID_ISOLATION;
    else process.env.ARCHON_LANE_UID_ISOLATION = savedIsolation;
  });

  test('codex_dev_mode_goes_through_the_launcher', async () => {
    const raw = await resolveCodexBinaryPath();
    expect(raw).toContain('@openai/codex/bin/codex.js');

    const client = new CodexProvider();
    const generator = client.sendQuery('test prompt', '/tmp/test');
    for await (const _chunk of generator) {
      // Drain until the SDK client is constructed.
    }

    const override = capturedOptions?.codexPathOverride;
    expect(override).toBeDefined();
    expect(override).not.toBe(raw);
    expect(override).not.toContain('codex.js');
    const shim = readFileSync(override ?? '', 'utf8');
    expect(shim).toContain(LANE_LAUNCHER);
    expect(shim).toContain(raw);
  });
});
