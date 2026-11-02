/**
 * Redact userinfo (user, token, or user:token before the @) in any URL-shaped
 * string. Every error/log emission from this module must pass through this so
 * embedded credentials never land in server logs.
 */
export function redactRemoteCredentials(remote: string): string {
  return remote.replace(/\/\/[^/@\s]+@/g, '//***@');
}

/**
 * Strip userinfo credentials from an http(s) remote URL before normalization,
 * e.g. https://x-access-token:TOKEN@github.com/owner/repo.git (the production
 * remote shape). ssh://git@... is left intact -- "git" is a username, not a
 * credential, and the ssh matcher expects it.
 */
function stripHttpCredentials(remote: string): string {
  return remote.replace(/^(https?:\/\/)[^/@\s]+@/i, '$1');
}

export function normalizeGitHubRemote(remote: string): string {
  const trimmed = stripHttpCredentials(remote.trim())
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '');
  const candidates = [
    /^git@github\.com:([^/]+)\/([^/]+)$/i,
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)$/i,
    /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+)$/i,
    /^([^/:]+)\/([^/]+)$/,
  ];
  for (const candidate of candidates) {
    const match = candidate.exec(trimmed);
    if (match?.[1] && match[2]) {
      return `${match[1].toLowerCase()}/${match[2].toLowerCase()}`;
    }
  }
  throw new Error(`canary_remote_unsupported: ${redactRemoteCredentials(remote)}`);
}
