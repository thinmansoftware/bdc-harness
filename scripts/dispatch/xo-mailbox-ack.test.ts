import { spawnSync } from 'child_process';
import { readFileSync, realpathSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, test } from 'bun:test';

const scriptDir = dirname(realpathSync(fileURLToPath(import.meta.url)));
const scriptPath = join(scriptDir, 'xo-mailbox-ack.sh');
const messageId = '11111111-1111-1111-1111-111111111111';

function runScript(
  args: string[],
  env: Record<string, string>
): { status: number | null; stdout: string; stderr: string } {
  const childEnv: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TMP', 'TEMP', 'SYSTEMROOT']) {
    const value = process.env[key];
    if (value !== undefined) childEnv[key] = value;
  }
  for (const [key, value] of Object.entries(env)) {
    childEnv[key] = value;
  }
  delete childEnv.BOARD_PRINCIPAL_TOKEN;
  delete childEnv.XO_HOLDER_TOKEN;
  delete childEnv.ARCHON_OPERATOR_TOKEN;
  delete childEnv.XO_ACK_DRY_RUN;
  for (const [key, value] of Object.entries(env)) {
    childEnv[key] = value;
  }
  const result = spawnSync('bash', [scriptPath, ...args], {
    env: childEnv,
    encoding: 'utf8',
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('xo-mailbox-ack.sh', () => {
  test('dry-run prints the plan and never a secret', () => {
    const result = runScript(['ack', messageId], {
      BOARD_PRINCIPAL_TOKEN: 'bpt-TESTSECRET-1',
      XO_HOLDER_TOKEN: 'xht-TESTSECRET-2',
      XO_ACK_DRY_RUN: '1',
      ARCHON_URL: 'http://127.0.0.1:1',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('POST');
    expect(result.stdout).toContain(
      '/api/dispatch/messages/11111111-1111-1111-1111-111111111111/ack'
    );
    expect(result.stdout).toContain('x-board-principal-token');
    expect(result.stdout).toContain('x-xo-holder-token');
    expect(result.stdout).toContain('x-xo-lease-id');
    expect(result.stdout).toContain('x-xo-fencing-token');
    const combined = result.stdout + result.stderr;
    expect(combined).not.toContain('TESTSECRET-1');
    expect(combined).not.toContain('TESTSECRET-2');
  });

  test('missing holder token is refused before any request', () => {
    const result = runScript(['ack', messageId], {
      BOARD_PRINCIPAL_TOKEN: 'bpt-TESTSECRET-1',
      ARCHON_URL: 'http://127.0.0.1:1',
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('XO_HOLDER_TOKEN');
    expect(result.stdout + result.stderr).not.toContain('TESTSECRET');
  });

  test('bad verb or no ids is a usage error and the script never cancels', () => {
    const env = {
      BOARD_PRINCIPAL_TOKEN: 'bpt-TESTSECRET-1',
      XO_HOLDER_TOKEN: 'xht-TESTSECRET-2',
    };
    const cancel = runScript(['cancel', messageId], env);
    expect(cancel.status).toBe(2);
    expect(cancel.stderr + cancel.stdout).toContain('usage:');
    const missingIds = runScript(['ack'], env);
    expect(missingIds.status).toBe(2);
    expect(missingIds.stderr + missingIds.stdout).toContain('usage:');
    const source = readFileSync(scriptPath, 'utf8');
    expect(source.includes('/cancel')).toBe(false);
  });
});
