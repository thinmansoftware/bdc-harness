import { describe, expect, test } from 'bun:test';
import { scanLegacyTwelve } from '../modules/legacy-twelve';
import { fixtureBaseline } from '../test-fixtures';

describe('scanLegacyTwelve', () => {
  test('does not report clean checks against missing renamed containers', async () => {
    const findings = await scanLegacyTwelve(fixtureBaseline, {
      discover: async () => [{ name: 'lspro-static', image: 'image', status: 'Up' }],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].reason_code).toBe('target_not_found');
    expect(findings.some(finding => finding.severity === 'CLEAN')).toBe(false);
  });

  test('emits deterministic clean findings when expected container exists', async () => {
    const findings = await scanLegacyTwelve(fixtureBaseline, {
      discover: async () => [{ name: 'lspro-react', image: 'image', status: 'Up' }],
    });
    expect(findings.length).toBeGreaterThan(1);
    expect(findings.every(finding => finding.module === 'legacy-twelve')).toBe(true);
  });
});
