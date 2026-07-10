import { describe, expect, test } from 'bun:test';
import { reduceFindings } from '../reducer';
import { fixtureBaseline } from '../test-fixtures';
import { scanRlsAnonSweep } from '../modules/rls-anon-sweep';

describe('scanRlsAnonSweep', () => {
  test('emits structured RLS findings for both instances', async () => {
    const findings = await scanRlsAnonSweep(async instance => [
      {
        instance,
        schema: 'public',
        table: instance === 'prod' ? 'tenant_orders' : 'public_profiles',
        hasTenantId: true,
        rlsEnabled: instance !== 'prod',
        forceRls: false,
        hasPolicy: instance !== 'prod',
        anonDmlGrant: false,
      },
    ]);
    const report = reduceFindings(findings, fixtureBaseline);
    expect(report.findings.some(finding => finding.reason_code === 'rls_gap_off_baseline')).toBe(true);
  });
});
