import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const apiSource = readFileSync(join(import.meta.dir, 'api.ts'), 'utf8');

describe('Taskmaster register route wiring', () => {
  test('register: list and meta routes are mounted', () => {
    expect(apiSource).toContain('registerOpenApiRoute(getTaskmasterRegisterRoute');
    expect(apiSource).toContain('registerOpenApiRoute(getTaskmasterRegisterMetaRoute');
  });

  test('register: both route declarations advertise operator-token failures', () => {
    const declarations = apiSource.slice(
      apiSource.indexOf('const getTaskmasterRegisterRoute'),
      apiSource.indexOf('const postTaskmasterPauseRoute')
    );
    expect(
      declarations.match(/401: jsonError\('Missing or invalid operator token'\)/g)
    ).toHaveLength(2);
  });

  test('register: surface is strictly read-only', () => {
    expect(apiSource).not.toMatch(/(?:post|put|patch|delete)TaskmasterRegister/);
    const handlers = apiSource.slice(
      apiSource.indexOf('// GET /api/taskmaster/register -'),
      apiSource.indexOf('// POST /api/taskmaster/pause -')
    );
    expect(handlers).not.toMatch(/taskmasterDb\.(?:insert|update|delete|upsert|commit)/);
  });
});
