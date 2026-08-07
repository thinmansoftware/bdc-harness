import { describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { classifyDispatchOutcome, summarizeTranscriptPayload } from './index';

describe('dispatch worker outcome and transcript hygiene', () => {
  test.each([
    [0, 'answer', 'done', 'succeeded', 'answer'],
    [0, '', 'done', null, ''],
    [1, 'partial\nDISPATCH_OUTCOME: blocked', 'failed', 'failed', 'partial'],
    [0, 'explanation\nDISPATCH_OUTCOME: blocked', 'failed', 'blocked', 'explanation'],
    [0, 'explanation\nDISPATCH_OUTCOME: failed', 'failed', 'failed', 'explanation'],
  ] as const)('classifies an honest outcome', (exit, output, status, outcome, body) => {
    expect(classifyDispatchOutcome(exit, output)).toEqual({ status, taskOutcome: outcome, resultBody: body });
  });

  test('stores bounded previews with hashes instead of full output', () => {
    const secretTail = 'NEVER_STORE_THIS_MARKER';
    const content = `${'x'.repeat(300)}${secretTail}`;
    const encoded = JSON.stringify(summarizeTranscriptPayload({ stdout: content }));
    expect(encoded).not.toContain(secretTail);
    expect(encoded).toContain(createHash('sha256').update(content).digest('hex'));
    expect(encoded).toContain(`"utf8_bytes":${Buffer.byteLength(content)}`);
  });
});
