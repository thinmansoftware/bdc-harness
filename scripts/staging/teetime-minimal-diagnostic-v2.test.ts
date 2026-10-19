import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { markCodexFailureOrigin } from '../../packages/providers/src/codex/provider';
import { collectMinimalDiagnostic, collectMinimalDiagnosticV2 } from './teetime-minimal-diagnostic';

function parse(packet: unknown, exit: number, version: number) {
  const script = ['import sys,json', 'sys.path.insert(0,sys.argv[1])',
    'from teetime_minimal_diagnostic import validate_minimal_diagnostic,validate_minimal_diagnostic_v2',
    'f=validate_minimal_diagnostic if sys.argv[3]=="1" else validate_minimal_diagnostic_v2',
    'print(json.dumps(f(int(sys.argv[2]),sys.stdin.buffer.read(4097))))'].join(';');
  return spawnSync(process.platform === 'win32' ? 'python' : 'python3',
    ['-I', '-B', '-c', script, resolve(import.meta.dir), String(exit), String(version)],
    {input: JSON.stringify(packet), encoding: 'utf8', timeout: 10000, maxBuffer: 8192});
}

test('explicit v2 success roundtrip does not upgrade or accept historical v1', async () => {
  const query = async function* () { yield {type: 'assistant' as const, content: 'OK'}; yield {type: 'result' as const}; };
  const one = await collectMinimalDiagnostic(query, new AbortController(), () => {});
  const two = await collectMinimalDiagnosticV2(query, new AbortController(), () => {});
  expect(one.version).toBe(1); expect(two.version).toBe(2);
  expect(parse(one, 0, 1).status).toBe(0); expect(parse(two, 0, 2).status).toBe(0);
  expect(parse(one, 0, 2).status).not.toBe(0); expect(parse(two, 0, 1).status).not.toBe(0);
});

test('primary SDK details survive cleanup failure and roundtrip without raw text', async () => {
  const original = markCodexFailureOrigin(new Error(
    'Codex Exec exited with code 1: Error loading config.toml: PRIVATE-PATH (os error 13)'), 'sdk_iterator_exception');
  const packet = await collectMinimalDiagnosticV2(async function* () { throw original; },
    new AbortController(), () => { throw new Error('PRIVATE-CLEANUP'); });
  expect(packet.failure?.cleanupFailure).toBe(true);
  expect(packet.failure?.sdkEvidence?.kind).toBe('cli-exit');
  expect(packet.failure?.sdkEvidence?.startupEvidence?.startupStages).toEqual(['config-load']);
  expect(JSON.stringify(packet)).not.toContain('PRIVATE');
  const parsed = parse(packet, 1, 2);
  expect(parsed.status).toBe(0);
  expect(JSON.parse(parsed.stdout)).toEqual(packet);
});

test('unknown SDK details remain explicit while forged caller properties grant none', async () => {
  for (const trusted of [true, false]) {
    const error = Object.assign(new Error('PRIVATE'), {sdkEvidence: {kind: 'cli-exit'}});
    if (trusted) markCodexFailureOrigin(error, 'sdk_iterator_exception');
    const packet = await collectMinimalDiagnosticV2(async function* () { throw error; }, new AbortController(), () => {});
    expect(packet.failure?.sdkEvidence).toEqual(trusted ? {version: 1, kind: 'other', exitCode: null,
      signal: null, stderrCategory: 'other', startupEvidence: null} : null);
    expect(parse(packet, 1, 2).status).toBe(0);
  }
});
