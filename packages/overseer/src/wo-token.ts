/**
 * Match a complete WO token, case-insensitively. Letters, digits, and hyphens continue
 * the token, including -thread-<id>, which can also be part of a longer WO.
 * Keep raw token matching separate from claim-text exclusion sections.
 */
export function matchesWoToken(text: string, woId: string): boolean {
  if (!woId || !text) return false;
  const hay = text.toLowerCase();
  const needle = woId.toLowerCase();
  let from = 0;
  while (from <= hay.length) {
    const idx = hay.indexOf(needle, from);
    if (idx < 0) return false;
    const before = idx === 0 ? '' : hay[idx - 1];
    const afterIdx = idx + needle.length;
    const after = afterIdx >= hay.length ? '' : hay[afterIdx];
    const beforeOk = idx === 0 || /[^a-z0-9-]/.test(before);
    const afterOk = after === '' || /[^a-z0-9-]/.test(after);
    if (beforeOk && afterOk) return true;
    from = idx + 1;
  }
  return false;
}
