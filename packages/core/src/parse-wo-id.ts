/**
 * Canonical WO id parser. One copy, inside the package, so the runtime image
 * can score a run without the scripts tree (the image does not copy scripts/).
 */
const WO_ID_ASSIGN_RE = /(?:^|\n)\s*WO_ID\s*=\s*(WO-[A-Z0-9-]+)/m;
const WO_ID_TOKEN_RE = /\bWO-[A-Z0-9-]+\b/;

export function parseWoId(userMessage: string | null | undefined): string | null {
  if (userMessage == null || userMessage === '') return null;
  const assigned = WO_ID_ASSIGN_RE.exec(userMessage);
  if (assigned?.[1]) return assigned[1];
  const bare = WO_ID_TOKEN_RE.exec(userMessage);
  return bare ? bare[0] : null;
}
