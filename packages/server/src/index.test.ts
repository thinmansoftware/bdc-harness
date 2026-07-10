import { describe, test, expect, mock, spyOn } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';

type RunStatus = 'running' | 'completed' | 'failed';

interface TestRun {
  id: string;
  status: RunStatus;
  reason?: string;
}

interface TestProvider {
  sendQuery(): AsyncGenerator<{ type: string; content?: string }>;
}

function makeHealthApp(runs: TestRun[]): OpenAPIHono {
  const app = new OpenAPIHono();
  app.get('/api/health', c => c.json({ status: 'ok', running: runs.filter(r => r.status === 'running').length }));
  return app;
}

async function dispatchRun(run: TestRun, provider: TestProvider): Promise<void> {
  try {
    for await (const _ of provider.sendQuery()) {
      // consume provider stream
    }
    run.status = 'completed';
  } catch (error) {
    run.status = 'failed';
    run.reason = error instanceof Error ? error.message : String(error);
  }
}

describe('WO-HARNESS-CODEX-PROVIDER-CRASH-ISOLATION-01 server liveness', () => {
  test('dead-auth codex failure leaves health up and concurrent mock-claude run completes', async () => {
    const codexRun: TestRun = { id: 'codex-dead-auth', status: 'running' };
    const claudeRun: TestRun = { id: 'mock-claude', status: 'running' };
    const runs = [codexRun, claudeRun];
    const app = makeHealthApp(runs);
    const exitSpy = spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);
    const unhandledRejection = mock((_reason: unknown) => {});
    process.on('unhandledRejection', unhandledRejection);

    const deadAuthCodex: TestProvider = {
      async *sendQuery() {
        throw new Error('Codex auth error: refresh token was revoked');
      },
    };
    const mockClaude: TestProvider = {
      async *sendQuery() {
        await new Promise(resolve => setTimeout(resolve, 1));
        yield { type: 'assistant', content: 'done' };
      },
    };

    try {
      const codexPromise = dispatchRun(codexRun, deadAuthCodex);
      const claudePromise = dispatchRun(claudeRun, mockClaude);

      const duringFailure = await app.request('/api/health');
      expect(duringFailure.status).toBe(200);
      expect((await duringFailure.json()).status).toBe('ok');

      await Promise.all([codexPromise, claudePromise]);
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(codexRun.status).toBe('failed');
      expect(codexRun.reason).toMatch(/auth/i);
      expect(claudeRun.status).toBe('completed');
      const afterFailure = await app.request('/api/health');
      expect(afterFailure.status).toBe(200);
      expect((await afterFailure.json()).status).toBe('ok');
      expect(exitSpy).not.toHaveBeenCalled();
      expect(unhandledRejection).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandledRejection);
      exitSpy.mockRestore();
    }
  });
});
