import { describe, test, expect, mock, beforeEach, afterAll } from 'bun:test';

// WO-HARNESS-CI-BASE-SUITE-RED-01: `mock.module` patches Bun's GLOBAL module
// registry for the whole test process, not just this file. These stubs
// previously REPLACED entire modules and were never restored, so every test
// file loaded afterwards (alphabetically: validator, script-*, etc.) silently
// received the hollow versions -- e.g. `findMarkdownFilesRecursive` always
// returning [] made `discoverAvailableCommands` report zero commands. That
// accounted for 12 of the 51 base-suite failures.
//
// Two rules now keep the blast radius inside this file:
//   1. SPREAD the real module and override only the specific exports needed,
//      so nothing else disappears from the surface.
//   2. Restore the registry in afterAll.
import * as realPaths from '@archon/paths';
import * as realBundledDefaults from './defaults/bundled-defaults';
import * as realCommandValidation from './command-validation';

// Mock @archon/git before importing the module under test
const mockExecFileAsync = mock(
  async (_cmd: string, _args: string[]): Promise<{ stdout: string; stderr: string }> => ({
    stdout: '/usr/bin/bun\n',
    stderr: '',
  })
);

mock.module('@archon/git', () => ({
  execFileAsync: mockExecFileAsync,
}));

// Mock @archon/paths logger ONLY. This file tests checkRuntimeAvailable, which
// uses none of the command-discovery exports; the previous stubs for
// getCommandFolderSearchPaths / getDefaultCommandsPath /
// findMarkdownFilesRecursive existed only to satisfy imports and were pure
// collateral damage to every later-loaded file (findMarkdownFilesRecursive
// returning [] is precisely why discoverAvailableCommands saw zero commands).
// Spreading the real module keeps the full surface intact.
mock.module('@archon/paths', () => ({
  ...realPaths,
  createLogger: mock(() => ({
    fatal: mock(() => undefined),
    error: mock(() => undefined),
    warn: mock(() => undefined),
    info: mock(() => undefined),
    debug: mock(() => undefined),
    trace: mock(() => undefined),
  })),
}));

// `./defaults/bundled-defaults` and `./command-validation` were stubbed for the
// same import-satisfying reason and are likewise unused by these tests. Their
// stubs (BUNDLED_COMMANDS: {} and isValidCommandName: () => true) broke the
// bundled-defaults and validateCommand groups downstream, so they are gone.
void realBundledDefaults;
void realCommandValidation;

afterAll(() => {
  mock.restore();
});

import { checkRuntimeAvailable, clearRuntimeCache } from './validator';

describe('checkRuntimeAvailable', () => {
  beforeEach(() => {
    mockExecFileAsync.mockClear();
    clearRuntimeCache();
  });

  test('returns true when binary is found (exit 0)', async () => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '/usr/bin/bun\n', stderr: '' });
    const result = await checkRuntimeAvailable('bun');
    expect(result).toBe(true);
    expect(mockExecFileAsync).toHaveBeenCalledWith('which', ['bun']);
  });

  test('returns false when binary is not found (non-zero exit)', async () => {
    mockExecFileAsync.mockRejectedValueOnce(
      Object.assign(new Error('Command failed: which uv'), { code: 1 })
    );
    const result = await checkRuntimeAvailable('uv');
    expect(result).toBe(false);
    expect(mockExecFileAsync).toHaveBeenCalledWith('which', ['uv']);
  });

  test('returns false when which itself throws', async () => {
    mockExecFileAsync.mockRejectedValueOnce(new Error('ENOENT: which not found'));
    const result = await checkRuntimeAvailable('bun');
    expect(result).toBe(false);
  });

  test('calls which with the runtime name', async () => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '/usr/local/bin/uv\n', stderr: '' });
    await checkRuntimeAvailable('uv');
    expect(mockExecFileAsync).toHaveBeenCalledWith('which', ['uv']);
  });

  test('returns true for bun when available', async () => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '/usr/bin/bun', stderr: '' });
    expect(await checkRuntimeAvailable('bun')).toBe(true);
  });

  test('returns true for uv when available', async () => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '/home/user/.cargo/bin/uv', stderr: '' });
    expect(await checkRuntimeAvailable('uv')).toBe(true);
  });
});
