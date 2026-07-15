import { expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { runCanary } from './runner';
import { baseSnapshot } from './test-fixtures';

test('proves the read-only Levels 0 and 1 foundation end to end', async () => {
  const token = 'integration-secret-token';
  const requests: Array<{ method: string; path: string }> = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requests.push({ method: request.method, path: url.pathname });
      if (request.headers.get('x-archon-operator-token') !== token) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }
      if (request.method !== 'GET' || url.pathname !== '/api/admin/canary/snapshot') {
        return Response.json({ error: 'not found' }, { status: 404 });
      }
      return Response.json(baseSnapshot);
    },
  });
  const root = await mkdtemp(join(tmpdir(), 'canary-foundation-'));
  try {
    const result = await runCanary({
      level: 1,
      manifestPath: join(
        import.meta.dir,
        '..',
        '..',
        '..',
        '.archon',
        'canaries',
        'smart-cauldron.yaml'
      ),
      apiBase: server.url.toString(),
      token,
      outputRoot: root,
      codebaseId: 'codebase-1',
    });
    expect(result.plan.directRoutes).toHaveLength(8);
    expect(result.plan.conductorRoutes).toHaveLength(4);
    expect(result.report.verdict).toBe('static_only');
    expect(requests).toEqual([{ method: 'GET', path: '/api/admin/canary/snapshot' }]);
    const files = (await readdir(join(root, result.report.suiteRunId))).sort();
    expect(files).toEqual(['plan.json', 'summary.json', 'summary.md']);
    const combined = (
      await Promise.all(result.artifactPaths.map(async path => readFile(path, 'utf8')))
    ).join('\n');
    expect(combined).not.toContain('integration-secret-token');
    expect(combined).not.toContain('workflowRun');
    expect(combined).not.toContain('providerAttempt');
  } finally {
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});
