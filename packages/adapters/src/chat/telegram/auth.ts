/**
 * Telegram user authorization utilities
 * Parses and validates user IDs for whitelist-based access control
 */

/**
 * Parse comma-separated user IDs from environment variable.
 * Returns an empty array when unset or invalid. An empty list denies every
 * sender unless the caller passes openAccess.
 */
export function parseAllowedUserIds(envValue: string | undefined): number[] {
  if (!envValue || envValue.trim() === '') {
    return [];
  }

  return envValue
    .split(',')
    .map(id => id.trim())
    .filter(id => id !== '')
    .map(id => parseInt(id, 10))
    .filter(id => !isNaN(id) && id > 0);
}

/**
 * Check if a user ID is authorized.
 * An empty allowlist denies everyone unless openAccess is true.
 */
export function isUserAuthorized(
  userId: number | undefined,
  allowedIds: number[],
  openAccess = false
): boolean {
  if (allowedIds.length === 0) {
    return openAccess;
  }

  if (userId === undefined) {
    return false;
  }

  return allowedIds.includes(userId);
}
