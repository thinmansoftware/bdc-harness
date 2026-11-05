/**
 * Shared WO-token boundary rule for PR bodies and head branch names.
 *
 * True when `text` contains `woId` as a complete token, case-insensitively.
 * - Before the id: start of text or any character that is not a letter or digit.
 * - After the id: end of text, any character that is not a letter, digit or
 *   hyphen, or the engine branch suffix `-thread` (as in `fix/wo-foo-01-thread-abc`).
 *   Any other hyphen continuation (`-010`, `-02`, `-extra`) names a longer id.
 *
 * So `WO-FOO-01` matches `fix/wo-foo-01-thread-def` and `fix/wo-foo-01`, but
 * never `fix/wo-foo-010-thread-abc` or `WO-FOO-01-02`.
 * Used by overseer reconcile (supersede sibling selection) and by
 * smart-cauldron already-satisfied (textClaimsWoId, repair-target selection).
 */
export function matchesWoToken(text: string, woId: string): boolean {
  if (!woId || !text) return false;
  const hay = text.toLowerCase();
  const needle = woId.toLowerCase();
  let from = 0;
  while (from <= hay.length) {
    const idx = hay.indexOf(needle, from);
    if (idx < 0) return false;
    const beforeOk = idx === 0 || /[^a-z0-9]/.test(hay.charAt(idx - 1));
    if (beforeOk && afterIsTokenBoundary(hay, idx + needle.length)) return true;
    from = idx + 1;
  }
  return false;
}

const THREAD_SUFFIX = '-thread';

function afterIsTokenBoundary(hay: string, afterIdx: number): boolean {
  if (afterIdx >= hay.length) return true;
  const after = hay.charAt(afterIdx);
  if (after !== '-') return /[^a-z0-9]/.test(after);
  if (!hay.startsWith(THREAD_SUFFIX, afterIdx)) return false;
  const tail = afterIdx + THREAD_SUFFIX.length;
  return tail >= hay.length || /[^a-z0-9]/.test(hay.charAt(tail));
}
