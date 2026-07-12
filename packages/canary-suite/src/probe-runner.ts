export interface CanaryProbeRunnerResult {
  readonly verdict: 'probe_passed' | 'probe_failed';
  readonly reasonCodes: readonly string[];
}

export async function runCanaryProbe(
  runner: () => Promise<{ readonly status: 'pass' | 'warn' | 'block' }>
): Promise<CanaryProbeRunnerResult> {
  const result = await runner();
  if (result.status === 'block') {
    return { verdict: 'probe_failed', reasonCodes: ['probe_structural_block'] };
  }
  return { verdict: 'probe_passed', reasonCodes: result.status === 'warn' ? ['probe_warn'] : [] };
}
