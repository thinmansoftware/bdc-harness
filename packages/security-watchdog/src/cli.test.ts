import { describe, expect, test } from 'bun:test';
import { cliMain, exitCodeForResult, parseCliArgs } from './cli';
import { cleanFinding, criticalFinding } from './test-fixtures';
import type { RunScanResult } from './runner';

function result(verdict: 'CLEAN' | 'CRITICAL'): RunScanResult {
  const finding = verdict === 'CLEAN' ? cleanFinding : criticalFinding;
  return {
    report: {
      schemaVersion: 1,
      runId: 'run',
      generatedAt: new Date(0).toISOString(),
      verdict,
      findings: [finding],
      reasonCodes: [finding.reason_code],
    },
    artifactPaths: [],
    escalatedCriticals: verdict === 'CRITICAL' ? 1 : 0,
  };
}

describe('cli', () => {
  test('parses scoped module scans', () => {
    expect(parseCliArgs(['scan', '--module', 'secret-scan'])).toEqual({
      command: 'scan',
      module: 'secret-scan',
      baselineRoot: undefined,
      outputRoot: undefined,
    });
  });

  test('maps clean and finding verdicts to documented exit codes', () => {
    expect(exitCodeForResult(result('CLEAN'))).toBe(0);
    expect(exitCodeForResult(result('CRITICAL'))).toBe(2);
  });

  test('returns abort exit code on runner failure', async () => {
    const code = await cliMain(['scan'], async () => {
      throw new Error('boom');
    });
    expect(code).toBe(4);
  });
});
