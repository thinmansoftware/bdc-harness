import { test, expect } from 'bun:test';
import { fileURLToPath } from 'node:url';

test('operational prepare rejects shared DB before imports and emits closed diagnostics', async () => {
  const env: Record<string, string> = { DATABASE_URL: '' };
  for (const key of ['SYSTEMROOT', 'WINDIR', 'PATH', 'USERPROFILE', 'HOME'])
    if (process.env[key]) env[key] = process.env[key]!;
  const child = Bun.spawn(
    [
      process.execPath,
      '--no-env-file',
      fileURLToPath(new URL('./teetime-supervised-controller.ts', import.meta.url)),
      '--prepare',
      '--input-sha256',
      '0'.repeat(64),
    ],
    { env, stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' }
  );
  const timer = setTimeout(() => child.kill(), 10000);
  try {
    const [raw, exit] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(exit).toBe(1);
    expect(JSON.parse(raw)).toEqual({
      kind: 'tee-time-supervised-prepare',
      passed: false,
      failureCategory: 'entry-rejected',
      accountProvided: false,
      modelInvocations: 0,
      operationalLaneReady: false,
    });
  } finally {
    clearTimeout(timer);
  }
});

for (const mode of ['--claim-model','--claim-successor','--claim-diagnostic-successor','--claim-transport-repair'])
test(`${mode} entry rejects shared DB without READY, account delivery or launcher output`, async () => {
  const env: Record<string, string> = { DATABASE_URL: '' };
  for (const key of ['SYSTEMROOT', 'WINDIR', 'PATH', 'USERPROFILE', 'HOME'])
    if (process.env[key]) env[key] = process.env[key]!;
  const child = Bun.spawn(
    [
      process.execPath,
      '--no-env-file',
      fileURLToPath(new URL('./teetime-supervised-controller.ts', import.meta.url)),
      mode,
      '--input-sha256',
      '0'.repeat(64),
    ],
    { env, stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' }
  );
  const [raw, exit] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  expect(exit).toBe(1);
  expect(raw).not.toContain('READY');
  expect(JSON.parse(raw)).toEqual({
    kind: 'tee-time-supervised-model',
    passed: false,
    failureCategory: 'entry-rejected',
    accountProvided: null,
    modelInvocations: null,
    operationalLaneReady: false,
  });
});
