/**
 * Shared `owner:<login>` label parsing.
 *
 * Moved verbatim from packages/server/src/taskmaster/escalation-delivery.ts
 * (WO-HARNESS-OVERSEER-OWNER-ROUTING-01) so the Overseer can read owner labels
 * without depending on @archon/server. The server module re-exports
 * isValidGithubLogin and parseOwnerLabel, so Taskmaster callers are unchanged.
 */

/**
 * A single GitHub login: 1-39 chars, ASCII alphanumerics or single hyphens,
 * not starting or ending with a hyphen.
 */
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/** True only for a string that is exactly one valid GitHub login. */
export function isValidGithubLogin(login: string | null | undefined): login is string {
  return typeof login === 'string' && GITHUB_LOGIN.test(login);
}

/**
 * The valid login suffix of one `owner:<login>` label, or null. The prefix is
 * matched case-insensitively; only surrounding spaces of the suffix are
 * trimmed, and the suffix must be exactly one valid GitHub login.
 */
function ownerLabelLogin(label: string): string | null {
  if (!label.toLowerCase().startsWith('owner:')) return null;
  const login = label.slice('owner:'.length).replace(/^ +| +$/g, '');
  return isValidGithubLogin(login) ? login : null;
}

/**
 * Extract a single owner login from an `owner:<login>` LABEL (not a GitHub
 * assignee). labelsJson is TmAdoptionRow.labels_json, a JSON array of strings.
 * The suffix (surrounding spaces only trimmed) must be exactly one valid GitHub
 * login; anything else -- `owner:user @team`, a suffix containing a newline,
 * punctuation, or over-length -- is ignored so it can never produce an
 * unintended mention. Returns the first valid login, or null when there is none
 * or the JSON is absent/malformed.
 */
export function parseOwnerLabel(labelsJson: string | null | undefined): string | null {
  if (!labelsJson) return null;
  let labels: unknown;
  try {
    labels = JSON.parse(labelsJson);
  } catch {
    return null;
  }
  if (!Array.isArray(labels)) return null;
  for (const label of labels) {
    if (typeof label !== 'string') continue;
    const login = ownerLabelLogin(label);
    if (login) return login;
  }
  return null;
}

/**
 * Every valid `owner:<login>` suffix in label order, deduplicated
 * case-insensitively (the first spelling wins). Invalid suffixes are dropped,
 * exactly as parseOwnerLabel drops them. Used where more than one owner label
 * must be detected rather than silently resolved to the first.
 */
export function listOwnerLabels(labels: readonly string[]): string[] {
  const seen = new Set<string>();
  const owners: string[] = [];
  for (const label of labels) {
    if (typeof label !== 'string') continue;
    const login = ownerLabelLogin(label);
    if (!login) continue;
    const key = login.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    owners.push(login);
  }
  return owners;
}
