import {
  findActiveByBindingKey,
  type KnownBadBindingRow,
} from '@archon/core/db/known-bad-bindings';
import type { ProviderProbeBinding } from '@archon/providers/probe';

export async function findActiveLaneBlock(
  bindings: readonly ProviderProbeBinding[]
): Promise<KnownBadBindingRow | null> {
  for (const binding of bindings) {
    const bindingKey = binding.bindingKey;
    if (!bindingKey) continue;
    const row = await findActiveByBindingKey(bindingKey);
    if (row) return row;
  }
  return null;
}
