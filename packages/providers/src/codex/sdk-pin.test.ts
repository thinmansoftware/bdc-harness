import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isAcceptableCodexSdkPin } from './sdk-pin';

const root = join(import.meta.dir, '../../../..');
const dependency = JSON.parse(readFileSync(join(root, 'packages/providers/package.json'), 'utf8'))
  .dependencies['@openai/codex-sdk'] as string;

describe('Codex SDK GPT-6 pin', () => {
  test('the actual dependency is an exact stable GPT-6 capable pin', () => {
    expect(isAcceptableCodexSdkPin(dependency)).toBe(true);
    expect(dependency).toBe('0.155.1');
  });

  test('rejects ranges, tags, prereleases, malformed and old versions', () => {
    for (const version of [
      '^0.155.1',
      '~0.155.1',
      'latest',
      '0.153.3',
      '0.155.0-alpha.16',
      '0.155',
      '0.154.99',
      '00.155.1',
      '0.155.1\n',
    ]) {
      expect(isAcceptableCodexSdkPin(version), version).toBe(false);
    }
    for (const version of ['0.155.0', '0.155.1', '0.162.0', '1.0.0']) {
      expect(isAcceptableCodexSdkPin(version), version).toBe(true);
    }
  });

  test('all SDK, CLI and platform lock entries agree with the exact pin', () => {
    const lock = readFileSync(join(root, 'bun.lock'), 'utf8');
    expect(lock).not.toContain('0.153.3');
    const entries = [
      ...lock.matchAll(
        /"@openai\/codex(?:-sdk|-darwin-arm64|-darwin-x64|-linux-arm64|-linux-x64|-win32-arm64|-win32-x64)?": \["@openai\/codex(?:-sdk)?@([^"\s]+)"/g
      ),
    ];
    expect(entries).toHaveLength(8);
    for (const [, version] of entries) {
      expect(version.replace(/-(darwin|linux|win32)-(arm64|x64)$/, '')).toBe(dependency);
    }
    expect(lock).toContain(`"dependencies": { "@openai/codex": "${dependency}" }`);
  });
});
