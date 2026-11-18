import { createHash } from 'node:crypto';

export interface ConsumedBodyInput {
  readonly publishedBody: string;
  readonly stepLog: string;
  // These must come from separately verified runner/workflow serialization,
  // never from PR text or a model-generated receipt. This is only the byte
  // comparison seam, not producer, invocation or terminal authorization.
  readonly verifiedPreamble: string;
  readonly verifiedEnvironmentTail: string;
}

export type ConsumedBodyResult =
  | { readonly state: 'verified'; readonly utf8Bytes: number; readonly sha256: string }
  | { readonly state: 'unknown'; readonly reason: string };

/** Compare the complete input at its fixed position; never search body framing. */
export function verifyConsumedBody(input: ConsumedBodyInput): ConsumedBodyResult {
  const unknown = (reason: string): ConsumedBodyResult => ({ state: 'unknown', reason });
  if (!input.verifiedPreamble || !input.verifiedEnvironmentTail) {
    return unknown('runner_framing_unavailable');
  }
  if (!input.verifiedPreamble.endsWith('  PR_BODY: ')) {
    return unknown('runner_framing_unsupported');
  }
  const body = input.publishedBody;
  // Masked bytes cannot establish equality. Runner directives and control
  // bytes make this supported serialization ambiguous: explicitly hand off.
  if (
    body.includes('***') ||
    body.includes('##[') ||
    Array.from(body).some(character => {
      const code = character.charCodeAt(0);
      return (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127;
    })
  ) {
    return unknown('body_serialization_unsupported');
  }
  const expected = input.verifiedPreamble + body + input.verifiedEnvironmentTail;
  if (!input.stepLog.startsWith(expected)) return unknown('consumed_body_mismatch');
  return {
    state: 'verified',
    utf8Bytes: Buffer.byteLength(body, 'utf8'),
    sha256: createHash('sha256').update(body, 'utf8').digest('hex'),
  };
}

export interface RunnerStepBodyInput {
  readonly stepLog: string;
  readonly publishedBody: string;
  readonly verifiedRunScript: string;
  readonly verifiedGrepRunner: string;
}

/** Supported Linux ScriptHandler preamble, anchored at byte zero of step logs. */
export function verifyRunnerStepBody(input: RunnerStepBodyInput): ConsumedBodyResult {
  const unknown = (): ConsumedBodyResult => ({
    state: 'unknown',
    reason: 'runner_preamble_unsupported',
  });
  const lines = input.verifiedRunScript.replace(/\n$/, '').split('\n');
  if (!lines[0] || !input.verifiedGrepRunner || input.verifiedGrepRunner.includes('\n'))
    return unknown();
  let offset = 0;
  const line = (): string | null => {
    const end = input.stepLog.indexOf('\n', offset);
    if (end < 0) return null;
    const raw = input.stepLog.slice(offset, end);
    const match = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z (.*)$/.exec(raw);
    if (!match) return null;
    offset = end + 1;
    return (match[1] ?? '')
      .replaceAll(String.fromCharCode(27) + '[36;1m', '')
      .replaceAll(String.fromCharCode(27) + '[0m', '');
  };
  if (line() !== '##[group]Run ' + lines[0]) return unknown();
  for (const command of lines) if (line() !== command) return unknown();
  if (line() !== 'shell: /usr/bin/bash -e {0}' || line() !== 'env:') return unknown();
  const bodyLine = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z {3}PR_BODY: /.exec(
    input.stepLog.slice(offset)
  );
  if (!bodyLine) return unknown();
  offset += bodyLine[0].length;
  const prefix = input.stepLog.slice(0, offset);
  // Locate the suffix by expected input length, never by a delimiter in PR text.
  const suffixStart = offset + input.publishedBody.length;
  const tail = input.stepLog.slice(suffixStart);
  const stamp = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{7}Z ';
  const escapedRunner = input.verifiedGrepRunner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const framing = new RegExp(
    '^\\n' + stamp + '  GREP_RUNNER: ' + escapedRunner + '\\n' + stamp + '##\\[endgroup\\]\\n'
  ).exec(tail);
  if (!framing) return unknown();
  return verifyConsumedBody({
    publishedBody: input.publishedBody,
    stepLog: input.stepLog,
    verifiedPreamble: prefix,
    verifiedEnvironmentTail: framing[0],
  });
}
