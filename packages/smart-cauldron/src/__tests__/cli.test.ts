import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { parseArgs, resolveAllowSatisfied, resolveFireAuth, statusToExitCode } from '../cli.js';
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

  test('drain-deferred maps to 11', () => {
    expect(statusToExitCode('drain-deferred')).toBe(11);
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
      'refused',
    ];
    for (const status of statuses) {
      expect(Number.isInteger(statusToExitCode(status))).toBe(true);
    }
  });

  test('refused maps to a distinct non-zero code (bdc-xo#2140: refusal is not a win)', () => {
    const code = statusToExitCode('refused');
    expect(code).not.toBe(0);
    expect(code).not.toBe(statusToExitCode('won'));
  });
});

describe('allow-satisfied resolution (bdc-xo#2140 / #865 Overseer finding)', () => {
  test('parseArgs leaves allowSatisfied undefined when the flag is absent', () => {
    const args = parseArgs(['bun', 'cli.ts', 'fire', 'WO-X', '--dry-run']);
    expect(args.allowSatisfied).toBeUndefined();
  });

  test('parseArgs sets allowSatisfied=true when --allow-satisfied is passed', () => {
    const args = parseArgs(['bun', 'cli.ts', 'fire', 'WO-X', '--allow-satisfied']);
    expect(args.allowSatisfied).toBe(true);
  });

  test('SMART_CAULDRON_ALLOW_CLAIMED=1 bypasses the guard through the CLI path with no flag', () => {
    const noFlag = parseArgs(['bun', 'cli.ts', 'fire', 'WO-X']);
    expect(
      resolveAllowSatisfied(noFlag.allowSatisfied, { SMART_CAULDRON_ALLOW_CLAIMED: '1' })
    ).toEqual({
      enabled: true,
      source: 'env',
    });
    expect(resolveAllowSatisfied(undefined, { SMART_CAULDRON_ALLOW_CLAIMED: 'true' }).enabled).toBe(
      true
    );
  });

  test('explicit --allow-satisfied works with the env var unset', () => {
    const withFlag = parseArgs(['bun', 'cli.ts', 'fire', 'WO-X', '--allow-satisfied']);
    expect(resolveAllowSatisfied(withFlag.allowSatisfied, {})).toEqual({
      enabled: true,
      source: 'flag',
    });
  });

  test('neither flag nor env leaves the guard armed', () => {
    expect(resolveAllowSatisfied(undefined, {})).toEqual({ enabled: false, source: 'none' });
    expect(resolveAllowSatisfied(undefined, { SMART_CAULDRON_ALLOW_CLAIMED: '0' }).enabled).toBe(
      false
    );
  });
});
