import { describe, expect, test } from 'bun:test';
import { scanPortExposure } from '../modules/port-exposure';
import { reduceFindings } from '../reducer';
import { fixtureBaseline } from '../test-fixtures';

describe('scanPortExposure', () => {
  test('uses an external public prober verdict for unexpected ports', async () => {
    const findings = await scanPortExposure(fixtureBaseline, {
      targetHost: '5.78.86.90',
      extraPorts: [11434],
      prober: async () => [
        {
          port: 11434,
          protocol: 'tcp',
          addressFamily: 'v4',
          open: true,
          vantage: 'third-party-public-prober',
        },
      ],
    });
    const report = reduceFindings(findings, fixtureBaseline);
    expect(report.findings[0]).toMatchObject({
      severity: 'CRITICAL',
      reason_code: 'unexpected_public_port',
    });
    expect(report.findings[0].evidence.vantage).toBe('third-party-public-prober');
  });
});
