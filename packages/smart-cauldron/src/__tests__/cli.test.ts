import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { resolveFireAuth, statusToExitCode } from '../cli.js';
import type { CascadeStatus } from '../types.js';

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

describe('statusToExitCode', () => {
  test('won maps to success', () => {
    expect(statusToExitCode('won')).toBe(0);
  });

  test('blocked maps to 2', () => {
    expect(statusToExitCode('blocked')).toBe(2);
  });

  test('infra-alert maps to 3', () => {
    expect(statusToExitCode('infra-alert')).toBe(3);
  });

  test('spec-repair maps to distinct non-zero code 4', () => {
    expect(statusToExitCode('spec-repair')).toBe(4);
    expect(statusToExitCode('spec-repair')).not.toBe(statusToExitCode('won'));
  });

  test('cancelled maps to a distinct non-zero code', () => {
    const code = statusToExitCode('cancelled');
    // A cancelled cascade must not collapse to won (0) or reuse any other
    // assigned code -- otherwise an operator's cancel is indistinguishable
    // from a win or a climb outcome.
    expect(Number.isInteger(code)).toBe(true);
    expect(code).not.toBe(0);
    expect(code).not.toBe(statusToExitCode('blocked'));
    expect(code).not.toBe(statusToExitCode('infra-alert'));
    expect(code).not.toBe(statusToExitCode('spec-repair'));
    expect(code).not.toBe(statusToExitCode('running'));
  });

  test('every CascadeStatus maps to an integer exit code', () => {
    const statuses: CascadeStatus[] = [
      'planned',
      'running',
      'won',
      'blocked',
      'spec-repair',
      'infra-alert',
      'cancelled',
    ];
    for (const status of statuses) {
      expect(Number.isInteger(statusToExitCode(status))).toBe(true);
    }
  });
});
