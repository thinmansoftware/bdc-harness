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
    ['409', true],
    ['500', true],
  ])('HTTP %s rejection is %s', (status, rejected) => {
    expect(registrationStatusIsRejected(status)).toBe(rejected);
  });

  test('a 409 is a failure that prints the mismatch body', () => {
    expect(script).toContain("if ($status -eq '409')");
    expect(script).toContain('this key already watches different work');
  });

  test('a success prints the stored specification, not the requested parameters', () => {
    const printBlock = script.slice(script.indexOf('$result = $responseBody | ConvertFrom-Json'));
    expect(printBlock).toContain('$result.recipient');
    expect(printBlock).toContain('$result.evidence');
    expect(printBlock).toContain('$result.dispatch_ref');
    expect(printBlock).not.toContain('Write-Host "  recipient:  $Recipient"');
    expect(printBlock).not.toContain('Write-Host "  evidence:   $Evidence"');
  });
});
