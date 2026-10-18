/**
 * GitHub user authorization utilities
 * Parses and validates GitHub usernames for whitelist-based access control
 */

/**
 * Parse comma-separated GitHub usernames from environment variable.
 * Returns an empty array when unset or invalid. An empty list denies every
 * sender unless the caller passes openAccess.
 * Normalizes usernames to lowercase for case-insensitive matching.
 */
export function parseAllowedUsers(envValue: string | undefined): string[] {
  if (!envValue || envValue.trim() === '') {
    return [];
  }

  return envValue
    .split(',')
    .map(user => user.trim().toLowerCase())
    .filter(user => user !== '');
}

/**
 * Check if a GitHub username is authorized.
 * An empty allowlist denies everyone unless openAccess is true.
 */
export function isGitHubUserAuthorized(
  username: string | undefined,
  allowedUsers: string[],
  openAccess = false
): boolean {
  if (allowedUsers.length === 0) {
    return openAccess;
  }

  if (username === undefined || username.trim() === '') {
    return false;
  }

  return allowedUsers.includes(username.toLowerCase());
}
