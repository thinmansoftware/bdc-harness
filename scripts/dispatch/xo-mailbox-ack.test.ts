import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, test } from 'bun:test';

const scriptDir = dirname(realpathSync(fileURLToPath(import.meta.url)));
const scriptPath = join(scriptDir, 'xo-mailbox-ack.sh');
const messageId = '11111111-1111-1111-1111-111111111111';
const secondId = '22222222-2222-2222-2222-222222222222';
const boardToken = 'bpt-TESTSECRET-1';
const holderToken = 'xht-TESTSECRET-2';
const holderDigest = createHash('sha256').update(holderToken).digest('hex');

const fakeCurl = `#!/usr/bin/env bash
set -euo pipefail
log="\${XO_ACK_CURL_LOG:?}"
fixture="\${XO_ACK_FIXTURE_DIR:?}"
printf '%s\\n' "$*" >> "$log"
out=""
url=""
prev=""
for arg in "$@"; do
  if [[ "$prev" == "-o" ]]; then
    out="$arg"
  fi
  case "$arg" in
    http://*|https://*) url="$arg" ;;
  esac
  prev="$arg"
done
if [[ -z "$out" || -z "$url" ]]; then
  printf 'fake_curl_missing_target\\n' >&2
  exit 9
fi
if [[ "$url" == */api/board/xo-lease/current ]]; then
  cat "$fixture/lease.body" > "$out"
  printf '%s' "$(cat "$fixture/lease.http")"
  exit 0
fi
id="$(printf '%s' "$url" | sed -n 's#.*/api/dispatch/messages/\\([^/]*\\)/[^/]*$#\\1#p')"
if [[ ! "$id" =~ ^[A-Za-z0-9-]+$ ]]; then
  printf 'fake_curl_bad_id\\n' >&2
  exit 9
fi
if [[ ! -f "$fixture/post-$id.http" || ! -f "$fixture/post-$id.body" ]]; then
  printf 'fake_curl_missing_post\\n' >&2
  exit 9
fi
cat "$fixture/post-$id.body" > "$out"
printf '%s' "$(cat "$fixture/post-$id.http")"
exit 0
`;

function runScript(
  args: string[],
  env: Record<string, string>
): { status: number | null; stdout: string; stderr: string } {
  const childEnv: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TMP', 'TEMP', 'SYSTEMROOT']) {
    const value = process.env[key];
    if (value !== undefined) childEnv[key] = value;
  }
  delete childEnv.BOARD_PRINCIPAL_TOKEN;
  delete childEnv.XO_HOLDER_TOKEN;
  delete childEnv.ARCHON_OPERATOR_TOKEN;
  delete childEnv.XO_ACK_DRY_RUN;
  delete childEnv.XO_ACK_CURL_LOG;
  delete childEnv.XO_ACK_FIXTURE_DIR;
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

function withCurlFixture(
  files: Record<string, string>,
  args: string[],
  extraEnv: Record<string, string> = {}
): { status: number | null; stdout: string; stderr: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), 'xo-ack-'));
  try {
    writeFileSync(join(dir, 'curl'), fakeCurl);
    chmodSync(join(dir, 'curl'), 0o755);
    for (const [name, contents] of Object.entries(files)) {
      writeFileSync(join(dir, name), contents);
    }
    const result = runScript(args, {
      PATH: `${dir}:${process.env.PATH ?? ''}`,
      XO_ACK_CURL_LOG: join(dir, 'curl.log'),
      XO_ACK_FIXTURE_DIR: dir,
      BOARD_PRINCIPAL_TOKEN: boardToken,
      XO_HOLDER_TOKEN: holderToken,
      ARCHON_URL: 'http://127.0.0.1:9',
      ...extraEnv,
    });
    let log = '';
    try {
      log = readFileSync(join(dir, 'curl.log'), 'utf8');
    } catch {
      log = '';
    }
    return { ...result, log };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function leaseFiles(body: string, http = '200'): Record<string, string> {
  return { 'lease.body': body, 'lease.http': http };
}

function postFiles(id: string, http: string, body: string): Record<string, string> {
  return { [`post-${id}.http`]: http, [`post-${id}.body`]: body };
}

function expectFourHeaders(logLine: string, leaseId: string, fencing: string): void {
  expect(logLine).toContain(`x-board-principal-token: ${boardToken}`);
  expect(logLine).toContain(`x-xo-holder-token: ${holderToken}`);
  expect(logLine).toContain(`x-xo-lease-id: ${leaseId}`);
  expect(logLine).toContain(`x-xo-fencing-token: ${fencing}`);
  expect(logLine).toContain('content-type: application/json');
  expect(logLine).toContain('--data-raw {}');
  expect(logLine).toContain('-X POST');
}

describe('xo-mailbox-ack.sh', () => {
  test('dry-run prints the plan and never a secret', () => {
    const result = runScript(['ack', messageId], {
      BOARD_PRINCIPAL_TOKEN: boardToken,
      XO_HOLDER_TOKEN: holderToken,
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
      BOARD_PRINCIPAL_TOKEN: boardToken,
      ARCHON_URL: 'http://127.0.0.1:1',
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('XO_HOLDER_TOKEN');
    expect(result.stdout + result.stderr).not.toContain('TESTSECRET');
  });

  test('bad verb or no ids is a usage error and the script never cancels', () => {
    const env = {
      BOARD_PRINCIPAL_TOKEN: boardToken,
      XO_HOLDER_TOKEN: holderToken,
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

  test('posts each id with the four lease headers and prints per-id status', () => {
    const result = withCurlFixture(
      {
        ...leaseFiles('{"lease_id":"lease-abc","fencing_token":9}\n'),
        ...postFiles(messageId, '200', '{}\n'),
        ...postFiles(secondId, '409', '{"error":"actor_mismatch"}\n'),
      },
      ['ack', messageId, secondId]
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe(`${messageId} 200 ok\n${secondId} 409 actor_mismatch\n`);
    const posts = result.log.split('\n').filter(line => line.includes('/api/dispatch/messages/'));
    expect(posts).toHaveLength(2);
    expect(posts[0]).toContain(`/api/dispatch/messages/${messageId}/ack`);
    expect(posts[1]).toContain(`/api/dispatch/messages/${secondId}/ack`);
    for (const line of posts) expectFourHeaders(line, 'lease-abc', '9');
    const combined = result.stdout + result.stderr;
    expect(combined).not.toContain(boardToken);
    expect(combined).not.toContain(holderToken);
    expect(combined).not.toContain(holderDigest);
  });

  test('every 200 returns exit 0', () => {
    const result = withCurlFixture(
      {
        ...leaseFiles('{"lease_id":"lease-abc","fencing_token":9}\n'),
        ...postFiles(messageId, '200', '{}\n'),
      },
      ['address', messageId],
      { ARCHON_OPERATOR_TOKEN: 'aot-TESTSECRET-9' }
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${messageId} 200 ok\n`);
    const posts = result.log.split('\n').filter(line => line.includes('/api/dispatch/messages/'));
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain(`/api/dispatch/messages/${messageId}/address`);
    expectFourHeaders(posts[0] ?? '', 'lease-abc', '9');
    expect(posts[0]).toContain('x-archon-operator-token: aot-TESTSECRET-9');
    const leaseLine = result.log
      .split('\n')
      .find(line => line.includes('/api/board/xo-lease/current'));
    expect(leaseLine).toContain('x-archon-operator-token: aot-TESTSECRET-9');
    const combined = result.stdout + result.stderr;
    expect(combined).not.toContain('TESTSECRET');
    expect(combined).not.toContain(holderDigest);
  });

  test('no live lease exits 3 and does not post', () => {
    const result = withCurlFixture({ ...leaseFiles('null\n') }, ['ack', messageId]);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('no_live_xo_lease');
    expect(result.stdout).toBe('');
    expect(result.log).toContain('/api/board/xo-lease/current');
    expect(result.log).not.toContain('/api/dispatch/messages/');
    expect(result.stdout + result.stderr).not.toContain('TESTSECRET');
  });

  test('lease non-200 exits 1 and does not post', () => {
    const result = withCurlFixture({ ...leaseFiles('{"error":"unavailable"}\n', '500') }, [
      'ack',
      messageId,
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('lease_fetch_failed');
    expect(result.log).not.toContain('/api/dispatch/messages/');
    expect(result.stdout + result.stderr).not.toContain('TESTSECRET');
  });

  test('holder token and its sha256 digest are redacted from error output', () => {
    const upperDigest = holderDigest.toUpperCase();
    const result = withCurlFixture(
      {
        ...leaseFiles('{"lease_id":"lease-abc","fencing_token":9}\n'),
        ...postFiles(messageId, '500', `{"error":"rejected ${upperDigest}"}\n`),
        ...postFiles(secondId, '500', `{"error":"rejected ${holderToken}"}\n`),
      },
      ['ack', messageId, secondId]
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe(`${messageId} 500 error\n${secondId} 500 error\n`);
    const combined = result.stdout + result.stderr;
    expect(combined).not.toContain(holderDigest);
    expect(combined).not.toContain(upperDigest);
    expect(combined).not.toContain(holderToken);
    expect(combined).not.toContain(boardToken);
  });
});
