import type { ContainerInventoryEntry, Finding } from './types';

export interface DiscoveredContainer {
  readonly name: string;
  readonly image?: string;
  readonly status?: string;
}

export type ContainerDiscoverer = () => Promise<readonly DiscoveredContainer[]>;

export async function resolveContainers(
  expected: readonly ContainerInventoryEntry[],
  discover: ContainerDiscoverer
): Promise<{
  readonly containers: readonly DiscoveredContainer[];
  readonly findings: readonly Finding[];
}> {
  const live = await discover();
  const liveNames = new Set(live.map(container => container.name));
  const findings: Finding[] = [];
  for (const entry of expected) {
    if (entry.required && !liveNames.has(entry.name)) {
      findings.push({
        module: 'legacy-twelve',
        severity: 'HIGH',
        target: entry.name,
        evidence: {
          expected: entry.name,
          discovered: [...liveNames].sort(),
        },
        reason_code: 'target_not_found',
      });
    }
  }
  return { containers: live, findings };
}

export async function discoverContainersFromDocker(
  exec: (command: string) => Promise<string>
): Promise<readonly DiscoveredContainer[]> {
  const output = await exec('docker ps --format "{{.Names}}\\t{{.Image}}\\t{{.Status}}"');
  return output
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const [name, image, status] = line.split('\t');
      return { name, image, status };
    });
}
