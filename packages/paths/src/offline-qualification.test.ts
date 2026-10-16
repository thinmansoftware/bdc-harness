import { describe, expect, test } from 'bun:test';
import { resolve } from 'path';

function run(source: string, offline = '1') {
  return Bun.spawnSync([process.execPath, '--eval', source], {
    cwd: resolve(import.meta.dir, '../../server'),
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      ARCHON_OFFLINE_QUALIFICATION: offline,
      NODE_ENV: 'test',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

const prefix = `import { validateOfflineQualification, assertExecutionEnabled } from '@archon/paths/offline-qualification';
const env = {ARCHON_OFFLINE_QUALIFICATION:'1', ARCHON_OPERATOR_TOKEN:'test-only'};`;

describe('offline qualification process boundary', () => {
  test('empty provider environment is valid but execution remains disabled', () => {
    const result = run(`${prefix} validateOfflineQualification(env, '/empty', () => false);
      try { assertExecutionEnabled(); process.exit(2); } catch(e) { if(!e.message.includes('execution_disabled')) throw e; }`);
    expect(result.exitCode).toBe(0);
  });
  test.each([
    'ANTHROPIC_API_KEY',
    'CURSOR_API_KEY',
    'CODEX_ACCESS_TOKEN',
    'GITHUB_TOKEN',
    'SLACK_BOT_TOKEN',
    'CLAUDE_USE_GLOBAL_AUTH',
    'HTTP_PROXY',
  ])('refuses %s without emitting its value', key => {
    const result = run(
      `${prefix} validateOfflineQualification({...env, ${key}:'not-a-real-secret'}, '/empty', () => false);`
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain('forbidden_environment');
    // Bun prints the eval source on an uncaught error; production startup logs
    // only key names. Catch here to exercise the actual error payload.
    const caught = run(
      `${prefix} try { validateOfflineQualification({...env, ${key}:'not-a-real-secret'}, '/empty', () => false); } catch(e) { console.log(e.message); }`
    );
    expect(caught.stdout.toString()).not.toContain('not-a-real-secret');
  });
  test('rejects credential-bearing home and missing operator token', () => {
    expect(
      run(`${prefix} validateOfflineQualification(env, '/home', () => true);`).exitCode
    ).not.toBe(0);
    expect(
      run(
        `${prefix} validateOfflineQualification({ARCHON_OFFLINE_QUALIFICATION:'1'}, '/empty', () => false);`
      ).exitCode
    ).not.toBe(0);
  });
  test('provider registry refuses even an explicitly registered factory', () => {
    const result = run(`import {registerProvider,getAgentProvider} from '@archon/providers';
      registerProvider({id:'offline-spy',displayName:'Spy',capabilities:{},factory:()=>{ console.log('FACTORY_CALLED'); throw new Error('unsafe'); }});
      try { getAgentProvider('offline-spy'); process.exit(2); } catch(e) { if(!e.message.includes('execution_disabled')) throw e; }`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).not.toContain('FACTORY_CALLED');
  });
  test('mode cannot be weakened after process import', () => {
    expect(
      run(`${prefix} delete process.env.ARCHON_OFFLINE_QUALIFICATION; assertExecutionEnabled();`)
        .exitCode
    ).not.toBe(0);
    expect(
      run(
        `${prefix} validateOfflineQualification({...env,ARCHON_OFFLINE_QUALIFICATION:'false'},'/empty',()=>false);`
      ).exitCode
    ).not.toBe(0);
  });
});
