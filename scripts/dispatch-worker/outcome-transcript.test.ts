import { describe, expect, test } from 'bun:test';
import { readFile } from 'fs/promises';
import { spawn } from 'node:child_process';
import {
  classifyDispatchOutcome,
  runAgent,
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
    expect(result.resultBody).toContain('CLI leg cancelled; survivors=none');
  });
});
