import { test, expect } from 'bun:test';
import { Codex } from '@openai/codex-sdk';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { restrictedClientOptions, restrictedThreadOptions } from './restricted-policy';

test('actual SDK serializes restricted options for initial and resumed turns', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'teetime-sdk-'));
  const fixture = join(dir, 'fixture.ts');
  const capture = join(dir, 'calls.jsonl');
  const executable = join(dir, process.platform === 'win32' ? 'fixture.exe' : 'fixture');
  const original = process.env.TEE_TIME_SYNTHETIC_SECRET;
  process.env.TEE_TIME_SYNTHETIC_SECRET = 'must-not-inherit';
  try {
    writeFileSync(
      fixture,
      `import {appendFileSync} from 'node:fs';
appendFileSync(${JSON.stringify(capture)}, JSON.stringify({args:process.argv.slice(1),env:process.env})+'\\n');
console.log(JSON.stringify({type:'thread.started',thread_id:'synthetic-thread'}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:0,output_tokens:0,cached_input_tokens:0}}));
`
    );
    const build = Bun.spawnSync([
      process.execPath,
      'build',
      fixture,
      '--compile',
      '--outfile',
      executable,
    ]);
    expect(build.exitCode).toBe(0);
    // Only the executable is substituted with a local synthetic event emitter.
    // No model endpoint or credential is used by this test.
    const client = new Codex({ ...restrictedClientOptions(), codexPathOverride: executable });
    await client.startThread(restrictedThreadOptions()).run('synthetic');
    await client.resumeThread('synthetic-thread', restrictedThreadOptions()).run('synthetic');
    const calls = readFileSync(capture, 'utf8')
      .trim()
      .split('\n')
      .map(
        line =>
          JSON.parse(line) as {
            args: string[];
            env: Record<string, string>;
          }
      );
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.args).not.toContain('--sandbox');
      expect(call.args).not.toContain('--add-dir');
      expect(call.args.some(arg => arg.startsWith('sandbox_workspace_write.'))).toBe(false);
      expect(call.args).toContain('default_permissions="tee-time"');
      expect(call.args).toContain('permissions.tee-time.network.enabled=false');
      expect(call.args).toContain('features.hooks=false');
      expect(call.args).toContain('features.plugins=false');
      for (const key of ['apps', 'remote_plugin', 'multi_agent', 'multi_agent_v2']) {
        expect(call.args).toContain(`features.${key}=false`);
      }
      expect(call.args).toContain('features.skip_host_skill_discovery=true');
      expect(call.args).toContain('agents.enabled=false');
      expect(call.args).toContain('skills.bundled.enabled=false');
      expect(call.args).toContain('skills.include_instructions=false');
      expect(call.args).toContain('notify=[]');
      expect(call.args).toContain('model_provider="openai"');
      expect(call.args).toContain(restrictedClientOptions().configOverrides![0]);
      expect(call.args[call.args.indexOf('--model') + 1]).toBe('gpt-5.6-sol');
      expect(call.args).toContain('approval_policy="never"');
      expect(call.args).toContain('web_search="disabled"');
      expect(call.env.TEE_TIME_SYNTHETIC_SECRET).toBeUndefined();
      expect(call.env.CODEX_HOME).toBe('/home/appuser/.codex');
      const allowedKeys = ['HOME', 'CODEX_HOME', 'PATH', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE'];
      // Windows adds these process bootstrap keys. The admitted worker is Linux;
      // its CI assertion retains the strict four-key set above.
      if (process.platform === 'win32')
        allowedKeys.push(
          'HOMEDRIVE',
          'HOMEPATH',
          'SYSTEMDRIVE',
          'SYSTEMROOT',
          'TEMP',
          'USERDOMAIN',
          'USERNAME',
          'USERPROFILE',
          'WINDIR'
        );
      expect(Object.keys(call.env).filter(key => !allowedKeys.includes(key))).toEqual([]);
    }
    expect(calls[0].args).not.toContain('resume');
    expect(calls[1].args).toContain('resume');
  } finally {
    if (original === undefined) delete process.env.TEE_TIME_SYNTHETIC_SECRET;
    else process.env.TEE_TIME_SYNTHETIC_SECRET = original;
    // Only the unique directory created by this test is removed.
    expect(dirname(resolve(dir))).toBe(resolve(tmpdir()));
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);
