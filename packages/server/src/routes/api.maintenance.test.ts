import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';

describe('maintenance cleanup API wiring', () => {
  const source = readFileSync(new URL('./api.ts', import.meta.url), 'utf8');

  test('manual_trigger_bypasses_window through the atomic cleanup entry point', () => {
    expect(source).toContain("path: '/api/maintenance/cleanup'");
    expect(source).toContain("tryRunScheduledCleanup({ source: 'manual' })");
    expect(source).toContain("apiError(c, 409, 'Cleanup already in progress')");
  });

  test('route remains protected by the global private API middleware', () => {
    expect(source).not.toContain("pathname === '/api/maintenance/cleanup'");
    expect(source).toContain("app.use('/api/*', async (c, next) =>");
  });
});
