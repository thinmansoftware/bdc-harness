import { createHash } from 'crypto';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, test } from 'bun:test';
import { buildAgentInvocation, MAX_PROMPT_STDIN_BYTES, type AgentConfig } from './adapters';
import { runAgent } from './index';

function message(body: string, recipient: string) {
  return {
    id: `stdin-test-${recipient}-${Date.now()}`,
    task_type: 'agent_message' as const,
    sender: 'test',
    recipient,
    body,
    status: 'claimed' as const,
    fencing_token: 1,
  };
}

async function stdinHashConfig(seat: string): Promise<AgentConfig> {
  const dir = await mkdtemp(join(tmpdir(), `stdin-prompt-${seat}-`));
  const script = join(dir, 'hash-stdin.cjs');
  await writeFile(
    script,
    "const crypto = require('crypto');\nconst chunks = [];\nprocess.stdin.on('data', chunk => chunks.push(chunk));\nprocess.stdin.on('end', () => process.stdout.write(crypto.createHash('sha256').update(Buffer.concat(chunks)).digest('hex')));\n",
    'utf8'
  );

  if (process.platform === 'win32') {
    // The Windows CI leg validates the same .cmd-shim launch path used by seats.
    const shim = join(dir, `${seat}.cmd`);
    await writeFile(shim, `@"${process.execPath}" "${script}" %*\r\n`, 'utf8');
    return { command: shim, args: [] };
  }
  return { command: process.execPath, args: [script] };
}

async function earlyExitConfig(): Promise<AgentConfig> {
  const dir = await mkdtemp(join(tmpdir(), 'stdin-prompt-early-exit-'));
  const script = join(dir, 'exit-immediately.cjs');
  await writeFile(script, 'process.exit(0);\n', 'utf8');
  return { command: process.execPath, args: [script] };
}

function promptOfExactly65536Bytes(): string {
  const unicodeAndCrlf = '\u2014\u4e2d\u6587\r\n';
  const prefixBytes = Buffer.byteLength(unicodeAndCrlf, 'utf8');
  return unicodeAndCrlf + 'x'.repeat(65_536 - prefixBytes);
}

describe('prompt stdin delivery', () => {
  for (const seat of ['claude', 'codex']) {
    test(`${seat} round-trips a 64 KiB unicode and CRLF prompt byte-identically`, async () => {
      const prompt = promptOfExactly65536Bytes();
      const config = await stdinHashConfig(seat);
      const result = await runAgent(config, message(prompt, seat));
      const expectedHash = createHash('sha256').update(prompt, 'utf8').digest('hex');

      expect(Buffer.byteLength(prompt, 'utf8')).toBe(65_536);
      expect(result.status).toBe('done');
      expect(result.resultBody).toContain(expectedHash);
      expect(buildAgentInvocation(config, prompt).args.every(arg => !arg.includes(prompt))).toBe(
        true
      );
    }, 15_000);
  }

  test('rejects an oversize prompt honestly before spawn', async () => {
    const prompt = 'x'.repeat(MAX_PROMPT_STDIN_BYTES + 1);
    const config = { command: join(tmpdir(), 'must-not-spawn-missing-command'), args: [] };
    const result = await runAgent(config, message(prompt, 'oversize'));

    expect(result.status).toBe('failed');
    expect(result.resultBody).toContain(String(MAX_PROMPT_STDIN_BYTES + 1));
    expect(result.resultBody).toContain(String(MAX_PROMPT_STDIN_BYTES));
  });

  test('closes stdin so a child waiting for EOF completes', async () => {
    const config = await stdinHashConfig('eof');
    const result = await Promise.race([
      runAgent(config, message('small prompt', 'eof')),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('child did not receive stdin EOF')), 5_000)
      ),
    ]);

    expect(result.status).toBe('done');
    expect(result.resultBody).toContain(
      createHash('sha256').update('small prompt', 'utf8').digest('hex')
    );
  }, 10_000);

  test('reports an early stdin close without taking down later dispatches', async () => {
    const failed = await runAgent(
      await earlyExitConfig(),
      message('x'.repeat(MAX_PROMPT_STDIN_BYTES), 'early-exit')
    );

    expect(failed.status).toBe('failed');
    expect(failed.resultBody).toContain('Failed to deliver prompt over stdin');

    const prompt = 'worker still alive';
    const survived = await runAgent(await stdinHashConfig('survived'), message(prompt, 'survived'));
    expect(survived.status).toBe('done');
    expect(survived.resultBody).toContain(
      createHash('sha256').update(prompt, 'utf8').digest('hex')
    );
  }, 15_000);

  test('accepts the shared cancellation controller contract', async () => {
    const cancel = { cancelled: false, cancel() { this.cancelled = true; } };
    const result = await runAgent(await stdinHashConfig('cancelled'), message('cancel me', 'cancelled'), cancel);
    expect(result.status).toBe('done');
  }, 10_000);
});
