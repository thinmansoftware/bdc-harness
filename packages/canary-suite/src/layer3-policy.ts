import type { CanaryVerdict } from './types';

export function verdictForStaticOnly(): CanaryVerdict {
  return 'static_only';
}

export function isHealthyVerdict(verdict: CanaryVerdict): boolean {
  return verdict === 'probe_passed';
}
