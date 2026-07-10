import type { Baseline, Finding } from '../types';

export interface PublicPortProbeResult {
  readonly port: number;
  readonly protocol: 'tcp' | 'udp';
  readonly addressFamily: 'v4' | 'v6';
  readonly open: boolean;
  readonly vantage: string;
}

export type ExternalPortProber = (
  targetHost: string,
  ports: readonly number[]
) => Promise<readonly PublicPortProbeResult[]>;

export async function externalPublicPortCheckerProbe(
  targetHost: string,
  ports: readonly number[],
  fetcher: typeof fetch = fetch
): Promise<readonly PublicPortProbeResult[]> {
  const apiKey = process.env.SECURITY_WATCHDOG_PORT_PROBER_API_KEY;
  if (!apiKey) throw new Error('SECURITY_WATCHDOG_PORT_PROBER_API_KEY_required');
  const response = await fetcher('https://public-port-checker.example.invalid/api/v1/probe', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ host: targetHost, ports }),
  });
  if (!response.ok) throw new Error(`external_port_prober_failed:${response.status}`);
  return (await response.json()) as PublicPortProbeResult[];
}

export async function scanPortExposure(
  baseline: Baseline,
  options: {
    readonly targetHost: string;
    readonly prober: ExternalPortProber;
    readonly extraPorts?: readonly number[];
  }
): Promise<readonly Finding[]> {
  const ports = [
    ...new Set([
      ...baseline.expectedOpenPorts.map(port => port.port),
      ...(options.extraPorts ?? []),
    ]),
  ].sort((left, right) => left - right);
  const results = await options.prober(options.targetHost, ports);
  return results.map(result => ({
    module: 'port-exposure',
    severity: result.open ? 'HIGH' : 'CLEAN',
    target: `${options.targetHost}:${result.port}/${result.protocol}`,
    evidence: {
      port: result.port,
      protocol: result.protocol,
      address_family: result.addressFamily,
      public_prober: result.open ? 'open' : 'closed',
      vantage: result.vantage,
    },
    reason_code: result.open ? 'public_port_open' : 'public_port_closed',
  }));
}
