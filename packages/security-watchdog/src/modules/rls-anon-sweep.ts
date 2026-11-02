import type { Finding } from '../types';

export interface RlsTableSnapshot {
  readonly instance: 'prod' | 'staging';
  readonly schema: string;
  readonly table: string;
  readonly hasTenantId: boolean;
  readonly rlsEnabled: boolean;
  readonly forceRls: boolean;
  readonly hasPolicy: boolean;
  readonly anonDmlGrant: boolean;
}

export type RlsQueryClient = (instance: 'prod' | 'staging') => Promise<readonly RlsTableSnapshot[]>;

export async function scanRlsAnonSweep(query: RlsQueryClient): Promise<readonly Finding[]> {
  const rows = [...(await query('prod')), ...(await query('staging'))];
  return rows
    .filter(row => row.hasTenantId || row.anonDmlGrant || !row.rlsEnabled || !row.hasPolicy)
    .map(row => ({
      module: 'rls-anon-sweep',
      severity:
        row.hasTenantId && (!row.rlsEnabled || !row.hasPolicy || row.anonDmlGrant)
          ? 'HIGH'
          : 'CLEAN',
      target: row.table,
      evidence: {
        instance: row.instance,
        schema: row.schema,
        table: row.table,
        has_tenant_id: row.hasTenantId,
        rls_enabled: row.rlsEnabled,
        force_rls: row.forceRls,
        has_policy: row.hasPolicy,
        anon_dml_grant: row.anonDmlGrant,
      },
      reason_code: 'rls_suspect',
    }));
}
