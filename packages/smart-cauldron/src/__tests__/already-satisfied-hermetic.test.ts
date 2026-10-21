/**
 * Regression coverage for the hermetic GitHub PR search guard.
 * Uses an injected exec function so this remains order-independent in a
 * multi-file Bun process.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { ghPrSearchDefault } from '../already-satisfied.js';

const execFileFake = mock(async () => ({ stdout: '[[]]', stderr: '' }));

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

    expect(
      await ghPrSearchDefault('thinmansoftware/bdc-harness', 'WO-TEST-001', execFileFake)
    ).toEqual([]);
    expect(execFileFake).not.toHaveBeenCalled();
  });

  test('spawns gh with the production arguments outside hermetic mode', async () => {
    delete process.env.SMART_CAULDRON_HERMETIC;

    expect(
      await ghPrSearchDefault('thinmansoftware/bdc-harness', 'WO-TEST-001', execFileFake)
    ).toEqual([]);
    expect(execFileFake).toHaveBeenCalledTimes(1);
    expect(execFileFake).toHaveBeenCalledWith(
      'gh',
      [
        'api',
        'repos/thinmansoftware/bdc-harness/pulls?state=all&per_page=100&sort=created&direction=asc',
        '--paginate',
        '--slurp',
      ],
      { timeout: 30000, maxBuffer: 16 * 1024 * 1024 }
    );
  });
});

const restRow = (number: number, overrides: Record<string, unknown> = {}) => ({
  number,
  state: 'open',
  merged_at: null,
  title: 'unrelated',
  body: null,
  head: { ref: 'unrelated' },
  html_url: `https://github.com/thinmansoftware/bdc-harness/pull/${number}`,
  ...overrides,
});

describe('complete REST claim discovery', () => {
  beforeEach(() => {
    delete process.env.SMART_CAULDRON_HERMETIC;
  });

  test('actual exec captures a complete response larger than the default buffer', async () => {
    const exec = promisify(execFile);
    const row = restRow(1, { title: 'WO-TEST-001' });
    const claims = await ghPrSearchDefault(
      'thinmansoftware/bdc-harness',
      'WO-TEST-001',
      async (_command, _args, options) =>
        exec(
          process.execPath,
          [
            '-e',
            `const row = ${JSON.stringify(row)}; row.body = 'x'.repeat(2 * 1024 * 1024); process.stdout.write(JSON.stringify([[row]]));`,
          ],
          options
        )
    );
    expect(claims.map(claim => claim.number)).toEqual([1]);
  });

  test('actual exec buffer overflow blocks without accepting a partial response', async () => {
    const exec = promisify(execFile);
    await expect(
      ghPrSearchDefault(
        'thinmansoftware/bdc-harness',
        'WO-TEST-001',
        async (_command, _args, options) =>
          exec(
            process.execPath,
            ['-e', "process.stdout.write('x'.repeat(17 * 1024 * 1024));"],
            options
          )
      )
    ).rejects.toThrow('claim_discovery_request_failed');
  });

  test('finds later-page branch and merged claims, deduplicates, and preserves exact exclusions', async () => {
    const open = restRow(101, { head: { ref: 'feat/wo-test-001-thread-abc' } });
    const pages = [
      Array.from({ length: 100 }, (_, index) => restRow(index + 1)),
      [
        open,
        restRow(102, { title: 'WO-TEST-0010 sibling' }),
        restRow(103, { body: '## Out of scope\nWO-TEST-001' }),
        restRow(104, { title: 'WO-TEST-001 closed', state: 'closed' }),
        restRow(105, {
          state: 'closed',
          merged_at: '2026-10-18T00:00:00Z',
          body: 'Implements WO-TEST-001',
        }),
        open,
      ],
    ];
    const result = await ghPrSearchDefault(
      'thinmansoftware/bdc-harness',
      'WO-TEST-001',
      mock(async () => ({ stdout: JSON.stringify(pages), stderr: '' }))
    );
    expect(result.map(({ number, state }) => ({ number, state }))).toEqual([
      { number: 101, state: 'OPEN' },
      { number: 105, state: 'MERGED' },
    ]);
  });

  for (const response of [
    '',
    '{',
    '{}',
    '[]',
    '[{}]',
    JSON.stringify([[restRow(1, { number: 0 })]]),
    JSON.stringify([[restRow(1, { number: 1.5 })]]),
    JSON.stringify([[restRow(1, { state: 'unknown' })]]),
    JSON.stringify([[restRow(1, { body: 12 })]]),
    JSON.stringify([[restRow(1, { head: null })]]),
    JSON.stringify([[restRow(1, { html_url: null })]]),
    JSON.stringify([[restRow(1, { merged_at: 'not-a-date' })]]),
    JSON.stringify([[restRow(1, { merged_at: '2026-10-18T00:00:00Z' })]]),
    JSON.stringify([[restRow(1)], [restRow(1, { title: 'changed during discovery' })]]),
    JSON.stringify([[restRow(1, { title: 'WO-TEST-001' })], [null]]),
  ]) {
    test(`invalid or incomplete response blocks rather than reports absence (${response.slice(0, 65)})`, async () => {
      await expect(
        ghPrSearchDefault(
          'thinmansoftware/bdc-harness',
          'WO-TEST-001',
          mock(async () => ({ stdout: response, stderr: '' }))
        )
      ).rejects.toThrow('claim_discovery_invalid_response');
    });
  }

  test('transport failure is sanitized and does not become an empty result', async () => {
    await expect(
      ghPrSearchDefault(
        'thinmansoftware/bdc-harness',
        'WO-TEST-001',
        mock(async () => {
          throw new Error('synthetic-sensitive-provider-detail');
        })
      )
    ).rejects.toThrow(/^claim_discovery_request_failed$/);
  });

  test('unsafe repository fails before spawning', async () => {
    const exec = mock(async () => ({ stdout: '[[]]', stderr: '' }));
    await expect(ghPrSearchDefault('owner/../search', 'WO-TEST-001', exec)).rejects.toThrow(
      'claim_discovery_invalid_repository'
    );
    expect(exec).not.toHaveBeenCalled();
  });
});
