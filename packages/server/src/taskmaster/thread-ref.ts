/**
 * Shared thread-ref canonicalization. Lives in its own module (not loop.ts) so
 * rules.ts can consume it without a circular import -- loop.ts already imports
 * from rules.ts.
 */

/** Historical org rename (M-141, 2026-08-14): pre-rename journal rows still exist. */
export const THREAD_REF_ORG_ALIASES: Record<string, string> = {
  bluedevilcollectibles: 'thinmansoftware',
};

/**
 * Canonicalize a thread ref so pre- and post-rename org eras collapse.
 * Non-gh refs (digest:, dispatch:) return byte-identical.
 */
export function canonicalizeThreadRef(ref: string): string {
  const match = /^gh:([^/]+)\/([^#]+)#(\d+)$/.exec(ref);
  if (!match) return ref;
  const org = match[1];
  const repo = match[2];
  const num = match[3];
  const canonicalOrg = THREAD_REF_ORG_ALIASES[org] ?? org;
  return `gh:${canonicalOrg}/${repo}#${num}`;
}
