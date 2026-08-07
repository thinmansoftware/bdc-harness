import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => server?.stop(true));

describe('canonical dispatch shell wrapper', () => {
  test('preflights history and emits one durable receipt without printing the token', async () => {
    const requests: string[] = [];
    server = Bun.serve({
      port: 0,
      fetch: async request => {
        requests.push(`${request.method} ${new URL(request.url).pathname}`);
        if (request.method === 'GET') return Response.json([]);
        return Response.json({ id: 'message-1', subject_key: 'wo:WO-TEST-01', status: 'queued' });
      },
    });
    const dir = await mkdtemp(join(tmpdir(), 'dispatch-send-'));
    const token = join(dir, 'token');
    const body = join(dir, 'body');
    await writeFile(token, 'do-not-print');
    await writeFile(body, 'work body');
    const script = join(import.meta.dir, 'send.sh');
    await chmod(script, 0o755);
    const proc = Bun.spawn(
      [
        script,
        `http://127.0.0.1:${server.port}`,
        token,
        'sender',
        'xo',
        'agent_message',
        'key-1',
        'corr-1',
        'blocker',
        body,
        'wo:WO-TEST-01',
      ],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe(
      'DISPATCH_RECEIPT id=message-1 subject_key=wo:WO-TEST-01 status=queued repeat=false'
    );
    expect(`${stdout}${stderr}`).not.toContain('do-not-print');
    expect(requests).toEqual(['GET /api/dispatch/messages', 'POST /api/dispatch/messages']);
  });
});
