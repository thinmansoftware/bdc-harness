/**
 * Regression coverage for the hermetic GitHub PR search guard.
 * Uses an injected exec function so this remains order-independent in a
 * multi-file Bun process.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';

import { ghPrSearchDefault } from '../already-satisfied.js';
import { parseGitHubQuotaError } from '@archon/core/github/metering';

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

  test('retains only the strict wrapper quota record on request failure', async () => {
    const quota = {
      version: 1,
      kind: 'pool_backoff',
      poolId: 'app-1-2',
      resource: 'core',
      retryAtMs: Date.now() + 120_000,
    };
    let failure: unknown;
    try {
      await ghPrSearchDefault('thinmansoftware/bdc-harness', 'WO-TEST-001', async () => {
        throw Object.assign(new Error('synthetic credential must disappear'), {
          stderr: `ARCHON_GITHUB_QUOTA_V1:${JSON.stringify(quota)}\n`,
        });
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: 'request_failed',
      message: 'claim_discovery_request_failed',
      quota,
    });
    expect(JSON.stringify(failure)).not.toContain('credential');
  });

  test('malformed, duplicate and expired records remain sanitized request failures', async () => {
    const record = {
      version: 1,
      kind: 'pool_backoff',
      poolId: 'user-pat',
      resource: 'core',
      retryAtMs: Date.now() + 120_000,
    };
    const line = `ARCHON_GITHUB_QUOTA_V1:${JSON.stringify(record)}`;
    for (const stderr of [
      line + '\n' + line,
      'embedded ' + line,
      'synthetic-secret',
      `ARCHON_GITHUB_QUOTA_V1:${JSON.stringify({ ...record, version: 2 })}`,
      `ARCHON_GITHUB_QUOTA_V1:${JSON.stringify({ ...record, retryAtMs: 1 })}`,
      'ARCHON_GITHUB_QUOTA_V1:{',
    ]) {
      let failure: unknown;
      try {
        await ghPrSearchDefault('thinmansoftware/bdc-harness', 'WO-TEST-001', async () => {
          throw Object.assign(new Error('synthetic-secret'), { stderr });
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: 'request_failed', quota: undefined });
      expect(JSON.stringify(failure)).not.toContain('synthetic-secret');
    }
  });

  test('real wrapper stderr survives execFile rejection into discovery without provider diagnostics', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'quota-wrapper-discovery-'));
    const wrapper = resolve(import.meta.dir, '../../../../scripts/github-service-exec.ts');
    const exec = promisify(execFile);
    const env = {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      ARCHON_HOME: directory,
      DATABASE_URL: '',
      LOG_LEVEL: 'error',
      GH_TOKEN: 'synthetic-credential',
      GITHUB_TOKEN: 'synthetic-credential',
    };
    const child = `console.error('* Request at synthetic\\n< HTTP/2 429\\n< X-Ratelimit-Resource: core\\n< Retry-After: 120\\n* Request took synthetic\\nsynthetic-credential synthetic-provider-body'); process.exit(1);`;
    try {
      let failure: unknown;
      let captured = '';
      try {
        await ghPrSearchDefault(
          'thinmansoftware/bdc-harness',
          'WO-TEST-001',
          async (_command, _args, options) => {
            try {
              return await exec(
                process.execPath,
                [wrapper, 'smart_cauldron', process.execPath, '-e', child],
                { ...options, env }
              );
            } catch (error) {
              captured = (error as { stderr: string }).stderr;
              throw error;
            }
          }
        );
      } catch (error) {
        failure = error;
      }
      expect(captured).toContain('ARCHON_GITHUB_QUOTA_V1:');
      expect(failure).toMatchObject({
        code: 'request_failed',
        quota: { version: 1, kind: 'pool_backoff', poolId: 'user-pat', resource: 'core' },
      });
      expect(captured.split('ARCHON_GITHUB_QUOTA_V1:')).toHaveLength(2);
      expect(captured).not.toContain('synthetic');
      expect(JSON.stringify(failure)).not.toContain('synthetic');
      // A new wrapper process must refuse from persisted quota before launching.
      const cached = await exec(
        process.execPath,
        [wrapper, 'smart_cauldron', process.execPath, '-e', "throw new Error('MUST_NOT_LAUNCH')"],
        { env }
      ).then(
        () => 'unexpected success',
        error => error.stderr as string
      );
      expect(parseGitHubQuotaError(cached)).toEqual(parseGitHubQuotaError(captured));
    } finally {
      const withinTemp = relative(realpathSync(tmpdir()), realpathSync(directory));
      if (
        !withinTemp.startsWith('..') &&
        !isAbsolute(withinTemp) &&
        withinTemp.startsWith('quota-wrapper-discovery-')
      ) {
        rmSync(directory, { recursive: true, force: true });
      } else throw new Error('unsafe quota fixture cleanup');
    }
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
