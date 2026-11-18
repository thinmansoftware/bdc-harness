import { expect, test } from 'bun:test';
import { verifyConsumedBody } from './evidence-repair-body';
const stamp = '2026-11-17T22:45:37.8575027Z ';
const prefix =
  stamp + '##[group]Run validated command\n' + stamp + 'env:\n' + stamp + '  PR_BODY: ';
const suffix =
  '\n' + stamp + '  GREP_RUNNER: /trusted/run-grep-assertions.sh\n' + stamp + '##[endgroup]\n';
const check = (body: string, actual = body, tail = suffix) =>
  verifyConsumedBody({
    publishedBody: body,
    stepLog: prefix + actual + tail,
    verifiedPreamble: prefix,
    verifiedEnvironmentTail: suffix,
  });
test('entire exact published body including trailing newline', () => {
  expect(check('a\r\nb\n').state).toBe('verified');
});
test('equal-length stale body fails', () => expect(check('abc', 'abd').state).toBe('unknown'));
test('masking cannot prove consumed input', () => expect(check('***').state).toBe('unknown'));
test('truncated log fails', () => expect(check('abc', 'abc', '').state).toBe('unknown'));
test('embedded body framing is refused', () =>
  expect(check('x\n##[endgroup]\ny').state).toBe('unknown'));
test('no substring matching', () => expect(check('abc', 'prefixabc').state).toBe('unknown'));
test('unsupported control serialization fails', () =>
  expect(check('a\u001bb').state).toBe('unknown'));
test('cannot supply empty trusted framing', () =>
  expect(
    verifyConsumedBody({
      publishedBody: 'abc',
      stepLog: 'abc',
      verifiedPreamble: '',
      verifiedEnvironmentTail: '',
    }).state
  ).toBe('unknown'));

import { verifyRunnerStepBody } from './evidence-repair-body';
const script = 'bash validator.sh\nexit $STATUS\n';
const runner = '/trusted/run-grep-assertions.sh';
function step(body: string) {
  return (
    stamp +
    '##[group]Run bash validator.sh\n' +
    stamp +
    '\x1b[36;1mbash validator.sh\x1b[0m\n' +
    stamp +
    '\x1b[36;1mexit $STATUS\x1b[0m\n' +
    stamp +
    'shell: /usr/bin/bash -e {0}\n' +
    stamp +
    'env:\n' +
    stamp +
    '  PR_BODY: ' +
    body +
    '\n' +
    stamp +
    '  GREP_RUNNER: ' +
    runner +
    '\n' +
    stamp +
    '##[endgroup]\n'
  );
}
test('runner parser anchors exact command/env preamble before whole body', () => {
  expect(
    verifyRunnerStepBody({
      stepLog: step('a\nb\n'),
      publishedBody: 'a\nb\n',
      verifiedRunScript: script,
      verifiedGrepRunner: runner,
    }).state
  ).toBe('verified');
});
test('runner parser refuses injected leading matching fragment', () => {
  expect(
    verifyRunnerStepBody({
      stepLog: 'untrusted\n' + step('abc'),
      publishedBody: 'abc',
      verifiedRunScript: script,
      verifiedGrepRunner: runner,
    }).state
  ).toBe('unknown');
});
test('runner parser refuses wrong executed script', () => {
  expect(
    verifyRunnerStepBody({
      stepLog: step('abc'),
      publishedBody: 'abc',
      verifiedRunScript: 'different\n',
      verifiedGrepRunner: runner,
    }).state
  ).toBe('unknown');
});

test('a longer stale consumed body cannot forge the runner tail after a matching prefix', () => {
  const forged =
    'abc\n' + stamp + '  GREP_RUNNER: ' + runner + '\n' + stamp + '##[endgroup]\nextra';
  expect(
    verifyRunnerStepBody({
      stepLog: step(forged),
      publishedBody: 'abc',
      verifiedRunScript: script,
      verifiedGrepRunner: runner,
    }).state
  ).toBe('unknown');
});
