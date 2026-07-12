import type { CanaryVerdict } from './types';

export function staticOnlyVerdict(): CanaryVerdict {
  return 'static_only';
}

export function verdictForStaticCapability(status: 'passed' | 'failed' | 'missing' | 'duplicate'): CanaryVerdict {
  return status === 'passed' ? staticOnlyVerdict() : 'failed';
}
