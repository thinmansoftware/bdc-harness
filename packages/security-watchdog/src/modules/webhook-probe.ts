import type { Baseline, Finding } from '../types';

export interface WebhookProbeResult {
  readonly path: string;
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly status: number;
  readonly bodySample?: string;
}

export type WebhookFetcher = (path: string, method: WebhookProbeResult['method']) => Promise<WebhookProbeResult>;

export async function scanWebhooks(
  baseline: Baseline,
  options: { readonly paths: readonly string[]; readonly fetcher: WebhookFetcher }
): Promise<readonly Finding[]> {
  const methods: WebhookProbeResult['method'][] = ['GET', 'POST'];
  const findings: Finding[] = [];
  for (const path of options.paths) {
    for (const method of methods) {
      const result = await options.fetcher(path, method);
      const authorized = baseline.authorizedWebhooks.some(
        webhook => webhook.path === path && webhook.methods.includes(method)
      );
      if (result.status < 400) {
        findings.push({
          module: 'webhook-probe',
          severity: authorized ? 'CLEAN' : 'HIGH',
          target: path,
          evidence: {
            method,
            status: result.status,
            body_sample: result.bodySample?.slice(0, 80) ?? '',
          },
          reason_code: 'webhook_public_reachable',
        });
      }
    }
  }
  return findings;
}
