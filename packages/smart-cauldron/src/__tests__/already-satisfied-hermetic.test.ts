/**
 * Regression coverage for the hermetic GitHub PR search guard.
 * Command execution is injected so this remains reliable in Bun's combined test process.
 */

import { describe, expect, mock, test } from 'bun:test';

import { ghPrSearchDefault } from '../already-satisfied.js';

describe('ghPrSearchDefault hermetic guard', () => {
  test('returns no claims without spawning gh in hermetic mode', async () => {
    const execFake = mock(async () => ({ stdout: '[]' }));

    expect(
      await ghPrSearchDefault('thinmansoftware/bdc-harness', 'WO-TEST-001', {
        exec: execFake,
        hermetic: true,
      })
    ).toEqual([]);
    expect(execFake).not.toHaveBeenCalled();
  });

  test('spawns gh with the production arguments outside hermetic mode', async () => {
    const execFake = mock(async () => ({ stdout: '[]' }));

    expect(
      await ghPrSearchDefault('thinmansoftware/bdc-harness', 'WO-TEST-001', {
        exec: execFake,
        hermetic: false,
      })
    ).toEqual([]);
    expect(execFake).toHaveBeenCalledTimes(1);
    expect(execFake).toHaveBeenCalledWith(
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
      { timeout: 30000 }
    );
  });
});
