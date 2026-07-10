import { describe, expect, test } from 'bun:test';
import { baselineSchema, findingSchema, scanReportSchema } from './types';
import { criticalFinding, fixtureBaseline } from './test-fixtures';

describe('security watchdog schemas', () => {
  test('parse valid baseline and finding fixtures', () => {
    expect(baselineSchema.parse(fixtureBaseline).schemaVersion).toBe(1);
    expect(findingSchema.parse(criticalFinding).reason_code).toBe('unexpected_public_port');
  });

  test('reject malformed findings and action strings', () => {
    expect(() => findingSchema.parse({ ...criticalFinding, severity: 'LOW' })).toThrow();
    expect(() =>
      findingSchema.parse({
        ...criticalFinding,
        evidence: { command: 'iptables -A INPUT -j ACCEPT' },
      })
    ).toThrow('phase1_finding_contains_action_string');
  });

  test('reject reports that carry action strings', () => {
    expect(() =>
      scanReportSchema.parse({
        schemaVersion: 1,
        runId: 'run-1',
        generatedAt: new Date(0).toISOString(),
        verdict: 'HIGH',
        findings: [{ ...criticalFinding, evidence: { note: 'chmod 777 secrets' } }],
        reasonCodes: ['bad'],
      })
    ).toThrow();
  });
});
