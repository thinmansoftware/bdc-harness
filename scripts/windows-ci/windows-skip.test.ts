import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { skipOnWindows } from './windows-skip';

const FOLLOW_UP = /^thinmansoftware\/bdc-(harness|xo)#[0-9]+$/;
const NEGATIVE_TESTS = new Set([
  'throws when reason is shorter than 20 characters',
  'throws when followUp is not a harness or xo issue',
]);

test('throws when reason is shorter than 20 characters', () => {
  const reason = 'x';
  const followUp = 'thinmansoftware/bdc-harness#1234';
  expect(() => skipOnWindows({ reason, followUp })).toThrow();
});

test('throws when followUp is not a harness or xo issue', () => {
  const reason = 'Windows file lock prevents cleanup';
  const followUp = 'see issue';
  expect(() => skipOnWindows({ reason, followUp })).toThrow();
});

test('valid follow-up returns whether the platform is Windows', () => {
  const decision = skipOnWindows({
    reason: 'Windows file lock prevents cleanup',
    followUp: 'thinmansoftware/bdc-harness#1234',
  });
  expect(decision).toBe(process.platform === 'win32');
});

function lineNumber(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

function enclosingTestName(source: string, index: number): string | null {
  const matches = [...source.slice(0, index).matchAll(/\b(?:test|it)\(\s*(['"])(.*?)\1/g)];
  const name = matches.at(-1)?.[2];
  return name ?? null;
}

function literalFollowUp(source: string, index: number): string | null {
  const match = /followUp\s*:\s*(['"])(.*?)\1/.exec(source.slice(index, index + 800));
  return match?.[2] ?? null;
}

function listTestFiles(dir: string, found: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'coverage') {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) listTestFiles(full, found);
    else if (entry.isFile() && entry.name.endsWith('.test.ts')) found.push(full);
  }
}

test('every skipOnWindows call site has a literal follow-up issue', () => {
  const marker = 'skipOn' + 'Windows(';
  const files: string[] = [];
  listTestFiles(join(import.meta.dir, '../..'), files);
  const violations: string[] = [];
  let sites = 0;
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    let from = 0;
    while (from < source.length) {
      const index = source.indexOf(marker, from);
      if (index < 0) break;
      // A zero-argument local predicate is not the shared helper. Object calls,
      // and any file that imports the shared helper, stay in scope.
      const importsHelper =
        source.includes('windows-ci/windows-skip') ||
        source.includes("from './windows-skip'") ||
        source.includes('from "./windows-skip"');
      const objectArgument = /^\s*\{/.test(source.slice(index + marker.length));
      if (!importsHelper && !objectArgument) {
        from = index + marker.length;
        continue;
      }
      sites += 1;
      const testName = enclosingTestName(source, index);
      const negative = testName !== null && NEGATIVE_TESTS.has(testName);
      const followUp = literalFollowUp(source, index);
      if (!negative && (followUp === null || !FOLLOW_UP.test(followUp))) {
        violations.push(`${file}:${lineNumber(source, index)} followUp=${followUp ?? '<missing>'}`);
      }
      from = index + marker.length;
    }
  }
  expect(violations).toEqual([]);
  expect(sites).toBeGreaterThan(0);
});
