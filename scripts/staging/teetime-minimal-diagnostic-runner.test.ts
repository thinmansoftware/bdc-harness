import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MessageChunk } from '../../packages/providers/src/types';
import { markCodexFailureOrigin } from '../../packages/providers/src/codex/provider';
import { runMinimalDiagnostic, type DiagnosticClock } from './teetime-minimal-diagnostic-runner';

function clock() {
  let fire = (): void => {}, cleared = 0, delay = 0;
  const value: DiagnosticClock = { arm(callback, milliseconds) {
    fire = callback; delay = milliseconds; return () => { cleared++; };
  } };
  return { value, fire: () => fire(), cleared: () => cleared, delay: () => delay };
}
function validate(packet: unknown, passed: boolean) {
  const code = 'import sys;sys.path.insert(0,sys.argv[1]);from teetime_minimal_diagnostic import validate_minimal_diagnostic;validate_minimal_diagnostic(int(sys.argv[2]),sys.stdin.buffer.read())';
  const child = spawnSync(process.platform === 'win32' ? 'python' : 'python3',
    ['-I', '-c', code, fileURLToPath(new URL('./', import.meta.url)), passed ? '0' : '1'],
    { input: JSON.stringify(packet), encoding: 'utf8' });
  expect(child.status).toBe(0);
}

test('runner delegates fixed prompt once and clears fixed deadline after closed success', async () => {
  const time = clock(); let calls = 0;
  const packet = await runMinimalDiagnostic((prompt, signal) => (async function* () {
    expect(prompt).toBe('Reply with exactly OK.'); expect(signal.aborted).toBe(false);
    calls++; yield { type: 'assistant' as const, content: 'OK' }; yield { type: 'result' as const };
  })(), time.value);
  expect(calls).toBe(1); expect(time.delay()).toBe(90000); expect(time.cleared()).toBe(1);
  time.fire(); // A stale clock callback must not abort an already closed iterator.
  expect(packet.passed).toBe(true); validate(packet, true);
});

test('lazy initialization and unexpected chunks fail privately and clear deadline', async () => {
  for (const source of [
    () => (async function* (): AsyncGenerator<MessageChunk> { throw new Error('PRIVATE-INIT'); })(),
    () => (async function* (): AsyncGenerator<MessageChunk> { yield { type: 'tool', toolName: 'PRIVATE-TOOL' }; })(),
    () => (async function* (): AsyncGenerator<MessageChunk> { yield { type: 'assistant', content: 'PRIVATE-NOT-OK' }; yield { type: 'result' }; })(),
  ]) {
    const time = clock(); const packet = await runMinimalDiagnostic(source, time.value);
    expect(packet.passed).toBe(false); expect(time.cleared()).toBe(1);
    expect(JSON.stringify(packet)).not.toContain('PRIVATE'); validate(packet, false);
  }
});

test('cooperative deadline abort closes held iterator and emits strict failure', async () => {
  const time = clock(); let start!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  let stopped = false;
  const running = runMinimalDiagnostic((_prompt, signal) => (async function* (): AsyncGenerator<MessageChunk> {
    try { start(); await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); }
    finally { stopped = true; }
  })(), time.value);
  await started; time.fire(); const packet = await running;
  expect(stopped).toBe(true); expect(packet.aborted).toBe(true);
  expect(packet.passed).toBe(false); expect(time.cleared()).toBe(1); validate(packet, false);
});

test('tagged native failure and deadline cleanup exception retain closed primary evidence', async () => {
  let clears = 0;
  const brokenClock: DiagnosticClock = { arm() { return () => { clears++; throw new Error('PRIVATE-CLEANUP'); }; } };
  const failure = markCodexFailureOrigin(new Error('401 PRIVATE-NATIVE'), 'native_turn_failed');
  const packet = await runMinimalDiagnostic(() => (async function* (): AsyncGenerator<MessageChunk> { throw failure; })(), brokenClock);
  expect(clears).toBe(1); expect(packet.passed).toBe(false);
  expect(packet.failure?.code).toBe('provider_exception');
  expect(packet.failure?.cleanupFailure).toBe(true);
  expect(packet.failure?.provenance.origin).toBe('native_turn_failed');
  expect(JSON.stringify(packet)).not.toContain('PRIVATE'); validate(packet, false);
});

test('entry rejects extra argv without loading policy/provider or emitting diagnostics', () => {
  // Execute exact entry bytes outside the repo package.json (which currently
  // emits a duplicate-yaml warning before any entry code). A logger import
  // sentinel proves the invalid invocation never starts its guarded imports.
  const root = mkdtempSync(join(tmpdir(), 'teetime-entry-'));
  const directories = ['scripts', 'scripts/staging', 'packages', 'packages/paths', 'packages/paths/src'];
  const entry = join(root, 'scripts/staging/teetime-minimal-diagnostic-entry.ts');
  const logger = join(root, 'packages/paths/src/logger.ts');
  const marker = join(root, 'import-attempted');
  try {
    for (const dir of directories) mkdirSync(join(root, dir));
    const bytes = readFileSync(new URL('./teetime-minimal-diagnostic-entry.ts', import.meta.url));
    writeFileSync(entry, bytes);
    writeFileSync(logger, `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'PRIVATE');export const rootLogger={level:'info'};`);
    expect(readFileSync(entry).equals(bytes)).toBe(true);
    const child = spawnSync(process.execPath, ['--no-env-file', entry, 'PRIVATE-ARG'],
      { cwd: root, encoding: 'utf8', env: { ...process.env, CODEX_HOME: 'PRIVATE-UNUSED' } });
    expect(child.status).toBe(1); expect(child.stdout).toBe(''); expect(child.stderr).toBe('');
    expect(existsSync(marker)).toBe(false);
  } finally {
    for (const file of [marker, logger, entry]) if (existsSync(file)) unlinkSync(file);
    for (const dir of directories.reverse()) rmdirSync(join(root, dir));
    rmdirSync(root);
  }
});
