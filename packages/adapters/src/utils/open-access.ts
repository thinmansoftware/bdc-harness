/**
 * Explicit opt-in for chat adapters whose allowlist is empty.
 * Only the exact word "true" (trimmed, case-insensitive) enables open access.
 */
export function isOpenAccessEnabled(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true';
}
