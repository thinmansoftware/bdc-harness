import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { renderReportMarkdown, writeSecurityWatchdogArtifacts } from './report';
import { criticalFinding } from './test-fixtures';
import type { ScanReport } from './types';

let tempRoot: string | null = null;

afterEach(async () => {
  if (tempRoot !== null) await rm(tempRoot, { recursive: true, force: true });
  tempRoot = null;
});

function report(): ScanReport {
  return {
    schemaVersion: 1,
    runId: 'run-1',
    generatedAt: new Date(0).toISOString(),
    verdict: 'CRITICAL',
    findings: [criticalFinding],
    reasonCodes: ['unexpected_public_port'],
  };
}

describe('report artifacts', () => {
  test('renders redacted markdown', () => {
    const markdown = renderReportMarkdown(report());
    expect(markdown).toContain('Security Watchdog Report');
    expect(markdown).toContain('unexpected_public_port');
  });

  test('writes artifacts atomically and detects conflicts', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'security-watchdog-report-'));
    const paths = await writeSecurityWatchdogArtifacts(tempRoot, report());
    expect(paths).toHaveLength(2);
    expect(await readFile(paths[0], 'utf8')).toContain('"schemaVersion": 1');

    await expect(writeSecurityWatchdogArtifacts(tempRoot, report())).resolves.toHaveLength(2);
    await writeFile(paths[0], '{}\n');
    await expect(writeSecurityWatchdogArtifacts(tempRoot, report())).rejects.toThrow(
      'security_watchdog_artifact_conflict'
    );
  });

  test('rejects report fields that carry Phase 1 action strings', () => {
    expect(() =>
      renderReportMarkdown({
        ...report(),
        findings: [{ ...criticalFinding, evidence: { command: 'GRANT SELECT ON table TO anon' } }],
      })
    ).toThrow();
  });
});
