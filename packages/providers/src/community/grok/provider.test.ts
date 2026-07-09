import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrokAgentProvider } from './provider';
import { executeGrokTool } from './tools';
import { registerGrokAgentProvider } from './registration';
import {
  clearRegistry,
  isRegisteredProvider,
  getAgentProvider,
  getProviderCapabilities,
  registerBuiltinProviders,
  registerCommunityProviders,
} from '../../registry';

describe('executeGrokTool', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'grok-tool-'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  test('write_file + read_file round trip', async () => {
    const w = await executeGrokTool(
      cwd,
      'write_file',
      JSON.stringify({ path: 'docs/a.md', content: 'hello\n' })
    );
    expect(w).toContain('OK wrote');
    const r = await executeGrokTool(cwd, 'read_file', JSON.stringify({ path: 'docs/a.md' }));
    expect(r).toBe('hello\n');
  });

  test('rejects path traversal', async () => {
    const r = await executeGrokTool(cwd, 'read_file', JSON.stringify({ path: '../outside.txt' }));
    expect(r).toContain('ERROR');
    expect(r.toLowerCase()).toContain('escape');
  });

  test('edit_file replaces string', async () => {
    writeFileSync(join(cwd, 'f.txt'), 'aaa bbb ccc', 'utf8');
    const e = await executeGrokTool(
      cwd,
      'edit_file',
      JSON.stringify({ path: 'f.txt', old_string: 'bbb', new_string: 'BBB' })
    );
    expect(e).toContain('OK edited');
    expect(readFileSync(join(cwd, 'f.txt'), 'utf8')).toBe('aaa BBB ccc');
  });

  test('list_dir lists files', async () => {
    writeFileSync(join(cwd, 'x.txt'), 'x', 'utf8');
    const out = await executeGrokTool(cwd, 'list_dir', JSON.stringify({ path: '.' }));
    expect(out).toContain('x.txt');
  });
});

describe('GrokAgentProvider', () => {
  const prevGlm = process.env.GLM_API_KEY;
  const prevOr = process.env.OPENROUTER_API_KEY;

  afterEach(() => {
    if (prevGlm === undefined) delete process.env.GLM_API_KEY;
    else process.env.GLM_API_KEY = prevGlm;
    if (prevOr === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prevOr;
  });

  test('fails closed without API key', async () => {
    delete process.env.GLM_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    const p = new GrokAgentProvider();
    await expect(async () => {
      const gen = p.sendQuery('hi', '/tmp');
      await gen.next();
    }).toThrow(/GLM_API_KEY|OPENROUTER_API_KEY/);
  });

  test('fails closed without cwd', async () => {
    process.env.GLM_API_KEY = 'test-key';
    const p = new GrokAgentProvider();
    await expect(async () => {
      const gen = p.sendQuery('hi', '');
      await gen.next();
    }).toThrow(/cwd/);
  });

  test('getType and capabilities', () => {
    const p = new GrokAgentProvider();
    expect(p.getType()).toBe('grok');
    const caps = p.getCapabilities();
    expect(caps.structuredOutput).toBe(true);
    expect(caps.sessionResume).toBe(false);
  });
});

describe('registerGrokAgentProvider', () => {
  beforeEach(() => {
    clearRegistry();
  });

  test('registers grok id idempotently', () => {
    registerGrokAgentProvider();
    registerGrokAgentProvider();
    expect(isRegisteredProvider('grok')).toBe(true);
    const p = getAgentProvider('grok');
    expect(p.getType()).toBe('grok');
    expect(getProviderCapabilities('grok').structuredOutput).toBe(true);
  });

  test('community bootstrap includes grok', () => {
    registerBuiltinProviders();
    registerCommunityProviders();
    expect(isRegisteredProvider('grok')).toBe(true);
    expect(isRegisteredProvider('opr')).toBe(true);
  });
});
