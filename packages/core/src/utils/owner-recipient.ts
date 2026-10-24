/**
 * Existing Taskmaster owner-login routing (M-155 WO 3), shared with failure
 * notices. Every entry and the unknown-owner fallback deliberately remain XO:
 * widening requires a documented, verified mailbox drain and its own WO.
 */
export const OWNER_RECIPIENT_MAP: Record<string, 'xo'> = {
  xo: 'xo',
  'major-build': 'xo',
  'captain-ci': 'xo',
  operator: 'xo',
};

export function resolveRecipient(ownerLogin: string | null | undefined): 'xo' {
  const key = (ownerLogin ?? '').trim().toLowerCase();
  return OWNER_RECIPIENT_MAP[key] ?? 'xo';
}
