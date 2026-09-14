/**
 * Regression coverage for the hermetic GitHub PR search guard.
 * Kept isolated because Bun module mocks persist for the lifetime of a process.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

const execFileFake = mock(
  (
    _command: string,
    _args: readonly string[],
    _options: unknown,
    callback: (error: Error | null, result: { stdout: string; stderr: string }) => void
  ) => callback(null, { stdout: '[]', stderr: '' })
);

mock.module('child_process', () => ({ execFile: execFileFake }));

const { ghPrSearchDefault } = await import('../already-satisfied.js');

let originalHermetic: string | undefined;

beforeEach(() => {
  originalHermetic = process.env.SMART_CAULDRON_HERMETIC;
  execFileFake.mockClear();
});

afterEach(() => {
  if (originalHermetic === undefined) {
    delete process.env.SMART_CAULDRON_HERMETIC;
  } else {
    process.env.SMART_CAULDRON_HERMETIC = originalHermetic;
  }
});

describe('ghPrSearchDefault hermetic guard', () => {
  test('returns no claims without spawning gh in hermetic mode', async () => {
    process.env.SMART_CAULDRON_HERMETIC = '1';

    expect(await ghPrSearchDefault('thinmansoftware/bdc-harness', 'WO-TEST-001')).toEqual([]);
    expect(execFileFake).not.toHaveBeenCalled();
  });

  test('spawns gh with the production arguments outside hermetic mode', async () => {
    delete process.env.SMART_CAULDRON_HERMETIC;

    expect(await ghPrSearchDefault('thinmansoftware/bdc-harness', 'WO-TEST-001')).toEqual([]);
    expect(execFileFake).toHaveBeenCalledTimes(1);
    expect(execFileFake).toHaveBeenCalledWith(
      'gh',
      [
        'pr',
        'list',
        '--repo',
        'thinmansoftware/bdc-harness',
        '--state',
        'all',
        '--search',
        'WO-TEST-001',
        '--limit',
        '20',
        '--json',
        'number,state,title,url,headRefName,body',
      ],
      { timeout: 30000 },
      expect.any(Function)
    );
  });
});
