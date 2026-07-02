import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { resolveFireAuth } from '../cli.js';

let originalToken: string | undefined;

beforeEach(() => {
  originalToken = process.env.ARCHON_OPERATOR_TOKEN;
  delete process.env.ARCHON_OPERATOR_TOKEN;
});

afterEach(() => {
  if (originalToken === undefined) {
    delete process.env.ARCHON_OPERATOR_TOKEN;
  } else {
    process.env.ARCHON_OPERATOR_TOKEN = originalToken;
  }
});

describe('resolveFireAuth', () => {
  test('throws with ARCHON_OPERATOR_TOKEN in message when token is missing for live fire', () => {
    expect(() => resolveFireAuth({ dryRun: false, project: 'shopops' })).toThrow(
      /ARCHON_OPERATOR_TOKEN/
    );
  });

  test('throws with --project in message when project is missing for live fire', () => {
    process.env.ARCHON_OPERATOR_TOKEN = 'env-token';

    expect(() => resolveFireAuth({ dryRun: false })).toThrow(/--project/);
  });

  test('--token argument overrides ARCHON_OPERATOR_TOKEN env', () => {
    process.env.ARCHON_OPERATOR_TOKEN = 'env-token';

    expect(resolveFireAuth({ dryRun: false, token: 'flag-token', project: 'shopops' })).toEqual({
      token: 'flag-token',
      project: 'shopops',
    });
  });

  test('dry-run bypasses token and project checks', () => {
    expect(resolveFireAuth({ dryRun: true })).toBeNull();
  });
});
