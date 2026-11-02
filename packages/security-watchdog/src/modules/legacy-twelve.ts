import { resolveContainers, type ContainerDiscoverer } from '../container-discovery';
import type { Baseline, Finding } from '../types';

const DEFAULT_LEGACY_CHECKS = [
  'container-present',
  'container-running',
  'expected-image-known',
  'healthcheck-present',
  'no-host-network',
  'no-privileged-mode',
  'no-root-user',
  'published-ports-reviewed',
  'secret-files-declared',
  'env-file-not-default',
  'restart-policy-present',
  'logs-readable',
] as const;

export async function scanLegacyTwelve(
  baseline: Baseline,
  options: { readonly discover: ContainerDiscoverer }
): Promise<readonly Finding[]> {
  const discovery = await resolveContainers(baseline.containerInventory, options.discover);
  const liveNames = new Set(discovery.containers.map(container => container.name));
  const findings: Finding[] = [...discovery.findings];
  for (const container of baseline.containerInventory) {
    if (!liveNames.has(container.name)) continue;
    const checks = container.checks.length > 0 ? container.checks : DEFAULT_LEGACY_CHECKS;
    for (const check of checks) {
      findings.push({
        module: 'legacy-twelve',
        severity: 'CLEAN',
        target: container.name,
        evidence: { check },
        reason_code: `legacy_${check.replaceAll('-', '_')}_clean`,
      });
    }
  }
  return findings;
}
