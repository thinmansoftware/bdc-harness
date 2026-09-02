import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';
import { spawn } from 'node:child_process';
import {
  classifyDispatchOutcome,
  readConfig,
  runAgent,
  summarizePersistedOutcome,
  summarizeTranscriptPayload,
  writeTranscript,
} from './index';
import { enumerateProcessTree, killProcessTree, waitForTreeDeath } from './acp/kill-tree';
import { createCancelController } from './acp/session';

describe('dispatch outcome and transcript contract', () => {
  test.each([
    [0, 'ok', false, 'done', 'succeeded', 'ok'],
    [0, '', false, 'done', null, ''],
    [2, 'DISPATCH_OUTCOME: blocked', false, 'failed', 'failed', ''],
    [0, 'partial\nDISPATCH_OUTCOME: blocked', false, 'failed', 'blocked', 'partial'],
    [0, 'no', true, 'failed', 'blocked', 'no'],
  ] as const)(
    'classifies exit/refusal/sentinel evidence',
    (code, output, refusal, status, outcome, body) => {
      expect(classifyDispatchOutcome(code as number, output as string, refusal as boolean)).toEqual(
        { status, taskOutcome: outcome, resultBody: body }
      );
    }
  );

  test('redacts transcript content while retaining hash and byte count', async () => {
    const marker = `SECRET-BEFORE-PREVIEW-${'x'.repeat(600)}-SECRET-BEYOND-PREVIEW`;
    const summary = summarizeTranscriptPayload(marker);
    expect(summary.utf8Bytes).toBe(Buffer.byteLength(marker));
    expect(summary.preview).toBe('[redacted]');
    expect(summary.preview).not.toContain('SECRET-BEFORE-PREVIEW');
    expect(summary.preview).not.toContain('SECRET-BEYOND-PREVIEW');
    const path = await writeTranscript({
      stdout: marker,
      stderr: 'stderr-secret',
      prompt: 'prompt-secret',
      command: 'command-secret',
      args: ['argument-secret'],
      error: new Error('error-secret'),
      authMethodId: 'token-secret',
    });
    const persisted = await readFile(path, 'utf8');
    for (const forbidden of [
      'SECRET-BEFORE-PREVIEW',
      'SECRET-BEYOND-PREVIEW',
      'stderr-secret',
      'prompt-secret',
      'command-secret',
      'argument-secret',
      'error-secret',
      'token-secret',
    ])
      expect(persisted).not.toContain(forbidden);
    expect(persisted).toContain('sha256');
    expect(persisted).toContain('utf8Bytes');
  });

  test('redacts database outcome content while retaining classification, hash, and byte count', () => {
    const forbidden = 'stdout-secret command-secret token-secret';
    const persisted = summarizePersistedOutcome('failed', forbidden);
    expect(persisted).not.toContain(forbidden);
    expect(persisted).not.toContain('stdout-secret');
    expect(JSON.parse(persisted)).toMatchObject({
      classification: 'failed',
      utf8Bytes: Buffer.byteLength(forbidden),
      preview: '[redacted]',
    });
    expect(JSON.parse(persisted).sha256).toHaveLength(64);
  });

  test('persists agent message text with a matching sha256', () => {
    const reply = 'M-174 vote: YES';
    const persisted = summarizePersistedOutcome('succeeded', reply, {
      persistText: true,
      cap: 65_536,
    });
    expect(JSON.parse(persisted)).toEqual({
      classification: 'succeeded',
      sha256: createHash('sha256').update(Buffer.from(reply, 'utf8')).digest('hex'),
      utf8Bytes: Buffer.byteLength(reply),
      text: reply,
    });
  });

  test('omits oversized reply text and retains the local transcript pointer', () => {
    const reply = 'x'.repeat(70_000);
    const persisted = summarizePersistedOutcome('succeeded', reply, {
      persistText: true,
      cap: 65_536,
      localTranscriptPath: '/tmp/fake-path.json',
    });
    expect(JSON.parse(persisted)).toEqual({
      classification: 'succeeded',
      sha256: createHash('sha256').update(Buffer.from(reply, 'utf8')).digest('hex'),
      utf8Bytes: 70_000,
      text: null,
      local_transcript_path: '/tmp/fake-path.json',
    });
  });

  test('writes raw stdout_text while keeping stdout and message body summarized', async () => {
    const path = await writeTranscript({
      message: {
        id: 'reply-transcript',
        task_type: 'agent_message',
        sender: 'test',
        recipient: 'seat',
        body: 'message-secret',
        status: 'claimed',
        fencing_token: 1,
      },
      stdout: 'reply text',
      stdoutText: 'reply text',
    });
    const persisted = JSON.parse(await readFile(path, 'utf8'));
    expect(persisted.stdout_text).toBe('reply text');
    expect(persisted.stdout).toMatchObject({ preview: '[redacted]' });
    expect(persisted.message.body).toMatchObject({ preview: '[redacted]' });
    expect(JSON.stringify(persisted.message.body)).not.toContain('message-secret');
  });

  test('normalizes persist_reply_text false for config-only rollback', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dispatch-worker-config-'));
    const path = join(dir, 'config.json');
    await writeFile(
      path,
      JSON.stringify({ server_url: 'http://localhost:3000', persist_reply_text: false }),
      'utf8'
    );
    const config = await readConfig(path);
    expect(config.persist_reply_text).toBe(false);
  });

  test('kills a real CLI descendant tree and proves death', async () => {
    if (process.platform === 'win32') return;
    const child = spawn('sh', ['-c', 'sleep 30 & wait']);
    await new Promise(resolve => setTimeout(resolve, 100));
    const before = await enumerateProcessTree(child.pid!);
    expect(before.length).toBeGreaterThan(1);
    await killProcessTree(child.pid!);
    expect(
      await waitForTreeDeath(
        before.map(node => node.pid),
        2_000
      )
    ).toEqual([]);
  });

  test('awaits CLI cancellation and descendant death before returning a failed result', async () => {
    if (process.platform === 'win32') return;
    const cancel = createCancelController();
    const resultPromise = runAgent(
      { command: 'sh', args: ['-c', 'sleep 30 & wait'] },
      {
        id: 'cancel-contract',
        task_type: 'agent_message',
        sender: 'test',
        recipient: 'test',
        body: 'cancel me',
        status: 'claimed',
        fencing_token: 1,
      },
      cancel
    );
    await new Promise(resolve => setTimeout(resolve, 100));
    cancel.cancel();
    const result = await resultPromise;
    expect(result.status).toBe('failed');
    expect(result.resultBody).not.toContain('CLI leg cancelled');
    expect(JSON.parse(result.resultBody)).toMatchObject({ classification: 'failed' });
  });
});
