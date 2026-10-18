import { expect, test } from 'bun:test';
import { firstRedactedErrorLine } from './node-failure-notify';

const cases = [
  'password="fixture-secret"',
  "password='fixture-secret'",
  '{"token":"fixture-secret","safe":"kept"}',
  "{'api_key':'fixture-secret'}",
  'Authorization: "Bearer fixture-secret"',
  'Authorization: Bearer fixture-secret',
  'Authorization Bearer fixture-secret',
  'token="fixture-secret with spaces" safe=kept',
  String.raw`token="fixture-secret \"escaped\" suffix" safe=kept`,
  String.raw`token="fixture-secret \\ suffix" safe=kept`,
  'password="fixture-secret unterminated',
  'token=fixture-secret; safe=kept',
];
for (const value of cases) {
  test(`redacts fixture assignment ${cases.indexOf(value)}`, () => {
    const line = firstRedactedErrorLine(value);
    expect(line).not.toContain('fixture-secret');
    expect(line).not.toContain('suffix');
    expect(line).toContain('[redacted]');
  });
}

test('redacts adjacent sensitive fields before truncation and preserves ordinary context', () => {
  const line = firstRedactedErrorLine(
    'safe=kept token="fixture-secret" password=second-fixture; ' + 'x'.repeat(600)
  );
  expect(line).toContain('safe=kept');
  expect(line).not.toContain('fixture-secret');
  expect(line).not.toContain('second-fixture');
  expect(line.length).toBeLessThanOrEqual(300);
});

test.each(['Authorization: Basic fixture+/tail==', 'Bearer fixture+/tail=='])(
  'redacts complete credential in %s',
  input => {
    const line = firstRedactedErrorLine(input);
    expect(line).not.toContain('fixture');
    expect(line).not.toContain('tail');
    expect(line).toContain('[redacted]');
  }
);
