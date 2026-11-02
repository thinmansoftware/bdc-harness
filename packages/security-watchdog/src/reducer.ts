import {
  type Baseline,
  type Finding,
  type LegitimateAnonGrant,
  type ScanReport,
  findingSchema,
  maxSeverity,
  severityRank,
} from './types';

function anonGrantKey(value: Pick<LegitimateAnonGrant, 'instance' | 'schema' | 'table'>): string {
  return `${value.instance}:${value.schema}.${value.table}`;
}

/**
 * Read a single evidence field as a string. evidence is Record<string, unknown>,
 * so a bare `String(x ?? '')` still stringifies an object as '[object Object]'
 * (no-base-to-string). Coerce only genuine string/number/boolean primitives;
 * anything else (object, array, null, undefined) falls back to `fallback`.
 */
function evStr(evidence: Record<string, unknown>, key: string, fallback = ''): string {
  const raw = evidence[key];
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  return fallback;
}

function normalizeRlsFinding(finding: Finding, baseline: Baseline): Finding {
  const instance = evStr(finding.evidence, 'instance');
  const schema = evStr(finding.evidence, 'schema');
  const table = evStr(finding.evidence, 'table', finding.target);
  const rlsEnabled = finding.evidence.rls_enabled === true;
  const hasPolicy = finding.evidence.has_policy === true;
  const carriesAnonDml = finding.evidence.anon_dml_grant === true;
  const hasTenantId = finding.evidence.has_tenant_id === true;
  const baselined = new Set(baseline.legitimateAnonGrants.map(anonGrantKey)).has(
    anonGrantKey({ instance: instance as 'prod' | 'staging', schema, table })
  );

  if (baselined && rlsEnabled && hasPolicy && !carriesAnonDml) {
    return {
      ...finding,
      severity: 'CLEAN',
      reason_code: 'anon_grant_baselined',
    };
  }
  if (hasTenantId && (!rlsEnabled || !hasPolicy || carriesAnonDml) && !baselined) {
    return {
      ...finding,
      severity: 'HIGH',
      reason_code: !rlsEnabled ? 'rls_gap_off_baseline' : 'rls_gap_policy_or_grant_off_baseline',
    };
  }
  return finding;
}

function normalizePortFinding(finding: Finding, baseline: Baseline): Finding {
  const port = Number(finding.evidence.port);
  const protocol = evStr(finding.evidence, 'protocol', 'tcp');
  const expected = baseline.expectedOpenPorts.some(
    candidate => candidate.port === port && candidate.protocol === protocol
  );
  if (expected && finding.reason_code === 'public_port_open') {
    return { ...finding, severity: 'CLEAN', reason_code: 'open_port_baselined' };
  }
  if (!expected && finding.reason_code === 'public_port_open') {
    return { ...finding, severity: 'CRITICAL', reason_code: 'unexpected_public_port' };
  }
  return finding;
}

function normalizeWebhookFinding(finding: Finding, baseline: Baseline): Finding {
  const method = evStr(finding.evidence, 'method', 'GET').toUpperCase();
  const authorized = baseline.authorizedWebhooks.some(
    webhook =>
      webhook.path === finding.target &&
      webhook.methods.includes(method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE')
  );
  if (authorized && finding.reason_code === 'webhook_public_reachable') {
    return { ...finding, severity: 'CLEAN', reason_code: 'webhook_authorized' };
  }
  return finding;
}

export function reduceFindings(
  findings: readonly Finding[],
  baseline: Baseline,
  runId = 'security-watchdog'
): ScanReport {
  const normalized = findings.map(raw => {
    const finding = findingSchema.parse(raw);
    if (finding.module === 'rls-anon-sweep') return normalizeRlsFinding(finding, baseline);
    if (finding.module === 'port-exposure') return normalizePortFinding(finding, baseline);
    if (finding.module === 'webhook-probe') return normalizeWebhookFinding(finding, baseline);
    return finding;
  });
  const findingsPresent = normalized.filter(finding => severityRank[finding.severity] > 0);
  const verdict = maxSeverity(normalized.map(finding => finding.severity));
  return {
    schemaVersion: 1,
    runId,
    generatedAt: new Date().toISOString(),
    verdict,
    findings: normalized,
    reasonCodes: [...new Set(findingsPresent.map(finding => finding.reason_code))].sort(),
  };
}
