import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { stripCwdEnv } from './strip-cwd-env';

describe('stripCwdEnv', () => {
  const tmpDir = join(import.meta.dir, '__strip-cwd-env-test-tmp__');

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.TEST_STRIP_KEY;
    delete process.env.TEST_STRIP_KEY2;
    delete process.env.TEST_STRIP_KEY_A;
    delete process.env.TEST_STRIP_KEY_B;
    // Clean up nested-session marker test keys
    delete process.env.CLAUDECODE;
    delete process.env.CLAUDE_CODE_ENTRYPOINT;
    delete process.env.CLAUDE_CODE_EXECPATH;
    delete process.env.CLAUDE_CODE_NO_FLICKER;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.CLAUDE_CODE_USE_BEDROCK;
    delete process.env.CLAUDE_CODE_USE_VERTEX;
    delete process.env.NODE_OPTIONS;
    delete process.env.VSCODE_INSPECTOR_OPTIONS;
  });

  it('strips keys from single .env file', () => {
    writeFileSync(join(tmpDir, '.env'), 'TEST_STRIP_KEY=leaked\n');
    process.env.TEST_STRIP_KEY = 'leaked';
    stripCwdEnv(tmpDir);
    expect(process.env.TEST_STRIP_KEY).toBeUndefined();
  });

  it('strips keys from all four Bun-auto-loaded files', () => {
    for (const f of ['.env', '.env.local', '.env.development', '.env.production']) {
      writeFileSync(join(tmpDir, f), 'TEST_STRIP_KEY=leaked\n');
    }
    process.env.TEST_STRIP_KEY = 'leaked';
    stripCwdEnv(tmpDir);
    expect(process.env.TEST_STRIP_KEY).toBeUndefined();
  });

  it('does nothing when no CWD .env files exist', () => {
    process.env.TEST_STRIP_KEY = 'safe';
    stripCwdEnv(tmpDir);
    expect(process.env.TEST_STRIP_KEY).toBe('safe');
  });

  it('preserves keys not in CWD .env files', () => {
    writeFileSync(join(tmpDir, '.env'), 'TEST_STRIP_KEY=leaked\n');
    process.env.TEST_STRIP_KEY = 'leaked';
    process.env.TEST_STRIP_KEY2 = 'preserved';
    stripCwdEnv(tmpDir);
    expect(process.env.TEST_STRIP_KEY).toBeUndefined();
    expect(process.env.TEST_STRIP_KEY2).toBe('preserved');
  });

  it('tolerates malformed .env lines', () => {
    writeFileSync(join(tmpDir, '.env'), 'NOTAKEYVALUE\nTEST_STRIP_KEY=leaked\n');
    process.env.TEST_STRIP_KEY = 'leaked';
    stripCwdEnv(tmpDir);
    expect(process.env.TEST_STRIP_KEY).toBeUndefined();
  });

  it('does not delete key if it was not in process.env (no-op)', () => {
    writeFileSync(join(tmpDir, '.env'), 'TEST_STRIP_KEY=parsed\n');
    // Do NOT set process.env.TEST_STRIP_KEY -- simulate key parsed but not auto-loaded
    stripCwdEnv(tmpDir);
    expect(process.env.TEST_STRIP_KEY).toBeUndefined(); // still undefined, no error
  });

  it('strips distinct keys from different .env files', () => {
    writeFileSync(join(tmpDir, '.env'), 'TEST_STRIP_KEY_A=leaked\n');
    writeFileSync(join(tmpDir, '.env.local'), 'TEST_STRIP_KEY_B=leaked\n');
    process.env.TEST_STRIP_KEY_A = 'leaked';
    process.env.TEST_STRIP_KEY_B = 'leaked';
    stripCwdEnv(tmpDir);
    expect(process.env.TEST_STRIP_KEY_A).toBeUndefined();
    expect(process.env.TEST_STRIP_KEY_B).toBeUndefined();
  });
});

describe('stripCwdEnv -- operator logging (#1302)', () => {
  const tmpDir = join(import.meta.dir, '__strip-cwd-env-log-test-tmp__');
  let stderrSpy: ReturnType<typeof spyOn>;
  let stderrWrites: string[];

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
    stderrWrites = [];
    stderrSpy = spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderrWrites.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.TEST_STRIP_LOG_A;
    delete process.env.TEST_STRIP_LOG_B;
    delete process.env.TEST_STRIP_LOG_C;
  });

  it('emits [archon] stripped line with count and filename when keys are stripped', () => {
    writeFileSync(join(tmpDir, '.env'), 'TEST_STRIP_LOG_A=leaked\nTEST_STRIP_LOG_B=leaked\n');
    process.env.TEST_STRIP_LOG_A = 'leaked';
    process.env.TEST_STRIP_LOG_B = 'leaked';
    stripCwdEnv(tmpDir);
    const line = stderrWrites.find(s => s.startsWith('[archon] stripped'));
    expect(line).toBeDefined();
    expect(line).toContain('stripped 2 keys');
    expect(line).toContain(tmpDir);
    expect(line).toContain('(.env)');
  });

  it('lists every contributing filename when keys span multiple .env files', () => {
    writeFileSync(join(tmpDir, '.env'), 'TEST_STRIP_LOG_A=leaked\n');
    writeFileSync(join(tmpDir, '.env.local'), 'TEST_STRIP_LOG_B=leaked\n');
    process.env.TEST_STRIP_LOG_A = 'leaked';
    process.env.TEST_STRIP_LOG_B = 'leaked';
    stripCwdEnv(tmpDir);
    const line = stderrWrites.find(s => s.startsWith('[archon] stripped'));
    expect(line).toBeDefined();
    expect(line).toContain('(.env, .env.local)');
  });

  it('emits no [archon] stripped line when no CWD .env files exist', () => {
    stripCwdEnv(tmpDir);
    const line = stderrWrites.find(s => s.startsWith('[archon] stripped'));
    expect(line).toBeUndefined();
  });

  it('emits no [archon] stripped line when .env file is empty', () => {
    writeFileSync(join(tmpDir, '.env'), '');
    stripCwdEnv(tmpDir);
    const line = stderrWrites.find(s => s.startsWith('[archon] stripped'));
    expect(line).toBeUndefined();
  });
});

describe('stripCwdEnv -- nested Claude Code marker stripping', () => {
  const tmpDir = join(import.meta.dir, '__strip-markers-test-tmp__');

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.CLAUDECODE;
    delete process.env.CLAUDE_CODE_ENTRYPOINT;
    delete process.env.CLAUDE_CODE_EXECPATH;
    delete process.env.CLAUDE_CODE_NO_FLICKER;
    delete process.env.CLAUDE_CODE_HIDE_ACCOUNT_INFO;
    delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.CLAUDE_CODE_USE_BEDROCK;
    delete process.env.CLAUDE_CODE_USE_VERTEX;
    delete process.env.NODE_OPTIONS;
    delete process.env.VSCODE_INSPECTOR_OPTIONS;
  });

  it('strips CLAUDECODE from process.env', () => {
    process.env.CLAUDECODE = '1';
    stripCwdEnv(tmpDir);
    expect(process.env.CLAUDECODE).toBeUndefined();
  });

  it('strips CLAUDE_CODE_* session markers', () => {
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
    process.env.CLAUDE_CODE_EXECPATH = '/usr/local/bin/claude';
    process.env.CLAUDE_CODE_NO_FLICKER = '1';
    process.env.CLAUDE_CODE_HIDE_ACCOUNT_INFO = '1';
    process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';
    stripCwdEnv(tmpDir);
    expect(process.env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(process.env.CLAUDE_CODE_EXECPATH).toBeUndefined();
    expect(process.env.CLAUDE_CODE_NO_FLICKER).toBeUndefined();
    expect(process.env.CLAUDE_CODE_HIDE_ACCOUNT_INFO).toBeUndefined();
    expect(process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBeUndefined();
  });

  it('preserves CLAUDE_CODE_* auth vars', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-secret';
    process.env.CLAUDE_CODE_USE_BEDROCK = '1';
    process.env.CLAUDE_CODE_USE_VERTEX = '1';
    stripCwdEnv(tmpDir);
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-secret');
    expect(process.env.CLAUDE_CODE_USE_BEDROCK).toBe('1');
    expect(process.env.CLAUDE_CODE_USE_VERTEX).toBe('1');
  });

  it('strips NODE_OPTIONS and VSCODE_INSPECTOR_OPTIONS', () => {
    process.env.NODE_OPTIONS = '--inspect';
    process.env.VSCODE_INSPECTOR_OPTIONS = '{"port":9229}';
    stripCwdEnv(tmpDir);
    expect(process.env.NODE_OPTIONS).toBeUndefined();
    expect(process.env.VSCODE_INSPECTOR_OPTIONS).toBeUndefined();
  });

  // Node 26 defines a global localStorage that returns undefined; vitest DOM
  // environments then cannot install their own and every localStorage test
  // crashes. The builder image sets NODE_OPTIONS=--no-experimental-webstorage
  // to prevent that, and it must survive into lane bash nodes (bdc-xo, 2026-11-05).
  it('keeps NODE_OPTIONS when every flag is on the safe allowlist', () => {
    process.env.NODE_OPTIONS = '--no-experimental-webstorage';
    stripCwdEnv(tmpDir);
    expect(process.env.NODE_OPTIONS).toBe('--no-experimental-webstorage');
  });

  it('keeps an allowlisted NODE_OPTIONS with surrounding whitespace', () => {
    process.env.NODE_OPTIONS = '  --no-experimental-webstorage  ';
    stripCwdEnv(tmpDir);
    expect(process.env.NODE_OPTIONS).toBe('  --no-experimental-webstorage  ');
  });

  // One unknown flag must not take the safe flag down with it: an all-or-nothing
  // delete is how the localStorage fix vanished from every lane on 2026-11-05.
  it('keeps the allowlisted flags and drops only the unknown ones', () => {
    process.env.NODE_OPTIONS = '--no-experimental-webstorage --inspect';
    stripCwdEnv(tmpDir);
    expect(process.env.NODE_OPTIONS).toBe('--no-experimental-webstorage');
  });

  it('keeps the allowlisted flag when it is not first', () => {
    process.env.NODE_OPTIONS =
      '--max-old-space-size=4096 --no-experimental-webstorage --require=/tmp/x.js';
    stripCwdEnv(tmpDir);
    expect(process.env.NODE_OPTIONS).toBe('--no-experimental-webstorage');
  });

  it('strips NODE_OPTIONS that only looks like the allowlisted flag', () => {
    process.env.NODE_OPTIONS = '--no-experimental-webstorage=1';
    stripCwdEnv(tmpDir);
    expect(process.env.NODE_OPTIONS).toBeUndefined();
  });

  it('strips an empty NODE_OPTIONS', () => {
    process.env.NODE_OPTIONS = '   ';
    stripCwdEnv(tmpDir);
    expect(process.env.NODE_OPTIONS).toBeUndefined();
  });

  it('strips an allowlisted NODE_OPTIONS that came from a CWD .env file', () => {
    writeFileSync(join(tmpDir, '.env'), 'NODE_OPTIONS=--no-experimental-webstorage\n');
    process.env.NODE_OPTIONS = '--no-experimental-webstorage';
    stripCwdEnv(tmpDir);
    expect(process.env.NODE_OPTIONS).toBeUndefined();
  });

  it('handles combined CWD .env + nested session markers in one call', () => {
    writeFileSync(join(tmpDir, '.env'), 'TEST_STRIP_KEY=leaked\n');
    process.env.TEST_STRIP_KEY = 'leaked';
    process.env.CLAUDECODE = '1';
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'keep-me';
    stripCwdEnv(tmpDir);
    expect(process.env.TEST_STRIP_KEY).toBeUndefined();
    expect(process.env.CLAUDECODE).toBeUndefined();
    expect(process.env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('keep-me');
  });
});

describe('stripCwdEnv -- NODE_OPTIONS removals are reported, never silent', () => {
  const tmpDir = join(import.meta.dir, '__strip-nodeopts-log-tmp__');
  let stderrSpy: ReturnType<typeof spyOn>;
  let stderrWrites: string[];

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
    stderrWrites = [];
    stderrSpy = spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderrWrites.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.NODE_OPTIONS;
    delete process.env.VSCODE_INSPECTOR_OPTIONS;
  });

  it('names each removed flag and what was kept', () => {
    process.env.NODE_OPTIONS = '--no-experimental-webstorage --inspect --max-old-space-size=4096';
    stripCwdEnv(tmpDir);
    const line = stderrWrites.find(w => w.startsWith('[archon] NODE_OPTIONS: removed'));
    expect(line).toBeDefined();
    expect(line).toContain('removed 2 flag(s)');
    expect(line).toContain('--inspect');
    expect(line).toContain('--max-old-space-size');
    expect(line).toContain('kept --no-experimental-webstorage');
  });

  it('never prints a flag value', () => {
    process.env.NODE_OPTIONS = '--require=/home/secret/preload.js --inspect=0.0.0.0:9229';
    stripCwdEnv(tmpDir);
    const line = stderrWrites.find(w => w.startsWith('[archon] NODE_OPTIONS: removed'));
    expect(line).toBeDefined();
    expect(line).toContain('--require');
    expect(line).not.toContain('/home/secret/preload.js');
    expect(line).not.toContain('9229');
    expect(line).toContain('NODE_OPTIONS unset');
    expect(process.env.NODE_OPTIONS).toBeUndefined();
  });

  it('prints nothing when every flag is allowlisted', () => {
    process.env.NODE_OPTIONS = '--no-experimental-webstorage';
    stripCwdEnv(tmpDir);
    expect(stderrWrites.some(w => w.includes('NODE_OPTIONS'))).toBe(false);
  });

  it('reports a stripped VSCODE_INSPECTOR_OPTIONS', () => {
    process.env.VSCODE_INSPECTOR_OPTIONS = '{"port":9229}';
    stripCwdEnv(tmpDir);
    expect(stderrWrites.some(w => w.startsWith('[archon] stripped VSCODE_INSPECTOR_OPTIONS'))).toBe(
      true
    );
    expect(stderrWrites.some(w => w.includes('9229'))).toBe(false);
  });
});
