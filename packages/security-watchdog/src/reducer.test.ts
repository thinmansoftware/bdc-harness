import { describe, expect, test } from 'bun:test';
import { reduceFindings } from './reducer';
import { criticalFinding, fixtureBaseline } from './test-fixtures';

describe('reduceFindings', () => {
  test('uses baseline lookup instead of guessing for RLS anon grants', () => {
    const report = reduceFindings(
      [
        {
          module: 'rls-anon-sweep',
          severity: 'HIGH',
          target: 'public_profiles',
          evidence: {
            instance: 'prod',
            schema: 'public',
            table: 'public_profiles',
            has_tenant_id: true,
            rls_enabled: true,
            has_policy: true,
            anon_dml_grant: false,
          },
          reason_code: 'rls_suspect',
        },
      ],
      fixtureBaseline
    );

    expect(report.findings[0].severity).toBe('CLEAN');
    expect(report.findings[0].reason_code).toBe('anon_grant_baselined');
    expect(report.findings.some(finding => finding.reason_code.includes('revoke'))).toBe(false);
  });

  test('flags same table when RLS is off and off baseline', () => {
    const report = reduceFindings(
      [
        {
          module: 'rls-anon-sweep',
          severity: 'CLEAN',
          target: 'tenant_orders',
          evidence: {
            instance: 'prod',
            schema: 'public',
            table: 'tenant_orders',
            has_tenant_id: true,
            rls_enabled: false,
            has_policy: false,
            anon_dml_grant: false,
          },
          reason_code: 'rls_suspect',
        },
      ],
      fixtureBaseline
    );

    expect(report.findings[0].severity).toBe('HIGH');
    expect(report.findings[0].reason_code).toBe('rls_gap_off_baseline');
  });

  test('classifies unexpected public port as CRITICAL', () => {
    const report = reduceFindings([criticalFinding], fixtureBaseline);
    expect(report.verdict).toBe('CRITICAL');
    expect(report.reasonCodes).toContain('unexpected_public_port');
  });

  test('rejects loosen or open action strings in findings', () => {
    expect(() =>
      reduceFindings(
        [
          {
            ...criticalFinding,
            evidence: { command: 'ufw allow 11434' },
          },
        ],
        fixtureBaseline
      )
    ).toThrow();
  });
});
