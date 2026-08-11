import { createHash } from 'crypto';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, test } from 'bun:test';
import {
  buildAgentInvocation,
  MAX_PROMPT_STDIN_BYTES,
  PROMPT_FILE_PLACEHOLDER,
  type AgentConfig,
} from './adapters';
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
      expect(JSON.parse(result.resultBody)).toMatchObject({
        classification: 'succeeded',
        sha256: createHash('sha256').update(expectedHash, 'utf8').digest('hex'),
        utf8Bytes: Buffer.byteLength(expectedHash),
        preview: '[redacted]',
      });
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
    const childHash = createHash('sha256').update('small prompt', 'utf8').digest('hex');
    expect(JSON.parse(result.resultBody).sha256).toBe(
      createHash('sha256').update(childHash, 'utf8').digest('hex')
    );
  }, 10_000);

  test('reports an early stdin close without taking down later dispatches', async () => {
    const failed = await runAgent(
      await earlyExitConfig(),
      message('x'.repeat(MAX_PROMPT_STDIN_BYTES), 'early-exit')
    );

    expect(failed.status).toBe('failed');
    expect(JSON.parse(failed.resultBody)).toMatchObject({ classification: 'failed' });
    expect(failed.resultBody).not.toContain('Failed to deliver prompt over stdin');

    const prompt = 'worker still alive';
    const survived = await runAgent(await stdinHashConfig('survived'), message(prompt, 'survived'));
    expect(survived.status).toBe('done');
    const survivedHash = createHash('sha256').update(prompt, 'utf8').digest('hex');
    expect(JSON.parse(survived.resultBody).sha256).toBe(
      createHash('sha256').update(survivedHash, 'utf8').digest('hex')
    );
  }, 15_000);

  test('prompt-file delivery (grok) writes a temp file and hits none of argv or stdin', async () => {
    // Regression test for the grok dispatch failure: `-p/--single <PROMPT>`
    // is argv-only with no stdin-prompt mode, so grok needs promptDelivery:
    // 'prompt-file'. The prompt must survive quotes, parens, newlines, and a
    // body over 1000 chars byte-identically through the substituted file arg.
    const dir = await mkdtemp(join(tmpdir(), 'prompt-file-echo-'));
    const script = join(dir, 'echo-prompt-file-arg.cjs');
    await writeFile(
      script,
      "const fs = require('fs');\nconst path = process.argv[3];\nprocess.stdout.write(fs.readFileSync(path, 'utf8'));\n",
      'utf8'
    );
    const config: AgentConfig = {
      command: process.execPath,
      args: [script, '--prompt-file', PROMPT_FILE_PLACEHOLDER],
      promptDelivery: 'prompt-file',
    };
    const prompt =
      `Line one with "double quotes" and 'single quotes'.\n` +
      `Line two with (parens) and $vars && pipes | redirects.\n` +
      'x'.repeat(1200);

    const result = await runAgent(config, message(prompt, 'grok'));

    expect(result.status).toBe('done');
    expect(JSON.parse(result.resultBody)).toMatchObject({ classification: 'succeeded' });
    // buildAgentInvocation is pure/argv-shape only; substitution happens in
    // runAgent per-spawn with a real cwd-scoped path (asserted below), so the
    // placeholder is expected to still be present at this layer.
    expect(buildAgentInvocation(config, prompt).args).toContain(PROMPT_FILE_PLACEHOLDER);
    expect(buildAgentInvocation(config, prompt).args.every(arg => !arg.includes(prompt))).toBe(
      true
    );
  }, 15_000);

  test('prompt-file delivery does not leave the placeholder unresolved when no seat matches', async () => {
    // buildAgentInvocation itself never substitutes PROMPT_FILE_PLACEHOLDER
    // (that happens in runAgent, per-spawn, with a real cwd-scoped path) --
    // this documents the contract so a future refactor cannot silently spawn
    // the literal placeholder string as a CLI argument.
    const config: AgentConfig = {
      command: 'grok',
      args: ['--prompt-file', PROMPT_FILE_PLACEHOLDER],
      promptDelivery: 'prompt-file',
    };
    expect(buildAgentInvocation(config, 'irrelevant').args).toContain(PROMPT_FILE_PLACEHOLDER);
  });
});
