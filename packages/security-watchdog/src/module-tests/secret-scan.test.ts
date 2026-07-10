import { describe, expect, test } from 'bun:test';
import { renderReportMarkdown } from '../report';
import { scanSecrets } from '../modules/secret-scan';

describe('scanSecrets', () => {
  test('redacts token values in findings and report output', async () => {
    const raw = 'sk-abcdefghijklmnopqrstuvwxyz123456';
    const findings = await scanSecrets({
      readTrackedFiles: async () => [{ path: 'tracked.env', content: `TOKEN=${raw}\n` }],
    });
    const serialized = JSON.stringify(findings);
    expect(serialized).not.toContain(raw);
    expect(serialized).toContain('[redacted:35]');
    const markdown = renderReportMarkdown({
      schemaVersion: 1,
      runId: 'run',
      generatedAt: new Date(0).toISOString(),
      verdict: 'CRITICAL',
      findings,
      reasonCodes: ['secret_material_detected'],
    });
    expect(markdown).not.toContain(raw);
  });
});
