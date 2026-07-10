export function normalizeGitHubRemote(remote: string): string {
  const trimmed = remote
    .trim()
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
  throw new Error(`canary_remote_unsupported: ${remote}`);
}
