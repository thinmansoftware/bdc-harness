import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const script = readFileSync(
  new URL('../../../../scripts/taskmaster/expect.ps1', import.meta.url),
  'utf8'
);

function registrationStatusIsRejected(status: string): boolean {
  const condition = script.match(
    /if \(\$status\s+(-notin)\s+@\(([^)]*)\)\)\s*\{\s*Write-Error\s+"Registration failed/
  );

  expect(condition, 'registration failure guard').not.toBeNull();
  expect(condition?.[1]).toBe('-notin');

  const acceptedStatuses = [...(condition?.[2].matchAll(/'([^']+)'/g) ?? [])].map(
    ([, acceptedStatus]) => acceptedStatus
  );
  return !acceptedStatuses.includes(status);
}

describe('taskmaster expectation registration script', () => {
  test.each([
    ['200', false],
    ['201', false],
    ['400', true],
    ['500', true],
  ])('HTTP %s rejection is %s', (status, rejected) => {
    expect(registrationStatusIsRejected(status)).toBe(rejected);
  });
});
