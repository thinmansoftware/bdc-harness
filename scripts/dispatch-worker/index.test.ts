/**
 * Prompt-over-stdin regression tests -- WO-HARNESS-DISPATCH-STDIN-PROMPT-01
 * (M-126 disposition Q1/Q2/Q3, RATIFIED 3-0 2026-08-04).
 *
 * These drive the REAL runAgent() path against real stub child processes (not
 * mocks): the acceptance criteria are about actual process behavior -- does a
 * board-sized payload reach the child byte-identical over stdin, does an
 * oversize payload fail before any spawn, and does stdin get CLOSED so the
 * child sees EOF instead of hanging on read.
 *
 * All fixture strings use \uXXXX escapes (never literal glyphs) so this source
 * stays ASCII-only for the ascii-gate.
 */
import { existsSync } from 'fs';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { runAgent, type DispatchMessage } from './index';
import { MAX_PROMPT_STDIN_BYTES, type AgentConfig } from './adapters';

/**
 * Stub child that reads ALL of stdin to EOF, then echoes the sha256 and byte
 * length of exactly what it received. If stdin were not closed, the 'end'
 * event never fires and this process hangs -- which the bounded test timeout
 * turns into a loud failure.
 */
const ECHO_SHA_STUB = `
const crypto = require('crypto');
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const buf = Buffer.concat(chunks);
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  process.stdout.write('SHA256:' + hash + ' BYTES:' + buf.length);
  process.exit(0);
});
`;

/**
 * Stub child that only reads stdin to EOF, then exits 0. Proves stdin was
 * closed after the write (EOF observed) rather than left open (hang class:
 * the codex "Reading additional input from stdin..." banner).
 */
const EOF_STUB = `
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  process.stdout.write('EOF_SEEN');
  process.exit(0);
});
`;

/**
 * Stub child that writes a marker file next to itself the instant it runs. Used
 * to prove the oversize path never spawns a child at all.
 */
const SPAWN_MARKER_STUB = `
const fs = require('fs');
const path = require('path');
fs.writeFileSync(path.join(__dirname, 'SPAWN_MARKER'), 'spawned');
process.exit(0);
`;

async function writeStub(source: string): Promise<{ dir: string; script: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'dispatch-stdin-stub-'));
  const script = join(dir, 'stub.cjs');
  await writeFile(script, source, 'utf8');
  return { dir, script };
}

function promptMessage(id: string, body: string): DispatchMessage {
  // task_type 'agent_message' means promptFor() returns message.body verbatim,
  // so the child receives exactly these bytes.
  return {
    id,
    task_type: 'agent_message',
    sender: 'tester',
    recipient: 'stub',
    body,
    status: 'claimed',
    fencing_token: 1,
  };
}

function stubConfig(script: string): AgentConfig {
  // kind is undefined => prompt-kind seat => stdin delivery path.
  return { command: process.execPath, args: [script] };
}

describe('prompt-over-stdin delivery (runAgent)', () => {
  test('large unicode+CRLF prompt round-trips byte-identical over stdin', async () => {
    const { script } = await writeStub(ECHO_SHA_STUB);
    // Build a >= 64 KiB prompt with an em-dash (U+2014), CJK (U+4E2D U+6587)
    // and CRLF line endings, so the hash compare proves multibyte + CRLF
    // integrity. Escapes only -- no literal glyphs (ascii-gate).
    const unit = 'row \u2014 \u4e2d\u6587 payload\r\n';
    let prompt = '';
    while (Buffer.byteLength(prompt, 'utf8') < 65_536) prompt += unit;
    const promptBytes = Buffer.byteLength(prompt, 'utf8');
    expect(promptBytes).toBeGreaterThanOrEqual(65_536);

    const expectedHash = createHash('sha256').update(Buffer.from(prompt, 'utf8')).digest('hex');
    const config = stubConfig(script);

    const result = await runAgent(config, promptMessage('large', prompt));

    expect(result.status).toBe('done');
    expect(result.resultBody).toContain(`SHA256:${expectedHash}`);
    expect(result.resultBody).toContain(`BYTES:${promptBytes}`);
    // No argv element carries any prompt text -- prompt travels only over stdin.
    for (const arg of [config.command, ...config.args]) {
      expect(arg).not.toContain('payload');
      expect(arg).not.toContain(prompt.slice(0, 32));
    }
  }, 20_000);

  test('oversize payload fails honestly before any spawn', async () => {
    const { dir, script } = await writeStub(SPAWN_MARKER_STUB);
    const body = 'a'.repeat(MAX_PROMPT_STDIN_BYTES + 1);
    const byteLength = Buffer.byteLength(body, 'utf8');
    expect(byteLength).toBe(MAX_PROMPT_STDIN_BYTES + 1);

    const result = await runAgent(stubConfig(script), promptMessage('oversize', body));

    expect(result.status).toBe('failed');
    // Honest reason includes the measured byte count AND the 1 MiB limit.
    expect(result.resultBody).toContain(String(byteLength));
    expect(result.resultBody).toContain(String(MAX_PROMPT_STDIN_BYTES));
    // No child was spawned: the marker file must not exist.
    expect(existsSync(join(dir, 'SPAWN_MARKER'))).toBe(false);
  }, 20_000);

  test('stdin is closed so the child sees EOF and does not hang', async () => {
    const { script } = await writeStub(EOF_STUB);
    // A small prompt; if stdin were left open the child never reaches 'end' and
    // this test blows past the bounded timeout instead of passing quietly.
    const result = await runAgent(stubConfig(script), promptMessage('eof', 'ping'));
    expect(result.status).toBe('done');
    expect(result.resultBody).toContain('EOF_SEEN');
  }, 15_000);
});
