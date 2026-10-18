/**
 * Source-byte guard for the unverified-approval composite key.
 *
 * The key needs a separator that cannot occur inside a run_id or a hex head_sha,
 * and NUL is the natural choice -- but writing it as a LITERAL 0x00 byte made
 * merge-execution-bridge.ts binary: grep reported only 'binary file matches',
 * diff/review tooling could not read it, and it violated the ASCII-only source
 * rule (policy Rule 13). The escape sequence yields the same runtime separator
 * from pure-ASCII source bytes. Assert BOTH properties so neither regresses.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MODULE_PATH = join(import.meta.dir, 'merge-execution-bridge.ts');

describe('merge-execution-bridge source bytes', () => {
  test('contains no NUL and no non-ASCII bytes', () => {
    const bytes = readFileSync(MODULE_PATH);
    const offending: { offset: number; byte: number }[] = [];
    for (let i = 0; i < bytes.length; i += 1) {
      const byte = bytes[i] as number;
      if (byte === 0 || byte > 0x7f) offending.push({ offset: i, byte });
    }
    expect(offending).toEqual([]);
  });

  test('the key separator is an escape in source, a NUL at runtime', () => {
    const text = readFileSync(MODULE_PATH, 'utf8');
    // Six ASCII characters (backslash u 0 0 0 0), not a raw byte.
    expect(text).toContain('${runId}\\u0000${headSha}');

    // The runtime separator is a real NUL, which cannot appear in a run_id or a
    // hex head_sha -- so no two distinct pairs can collide into one key.
    const nul = String.fromCharCode(0);
    const runId = 'pr-discovery:thinmansoftware/bdc-harness#1';
    const headSha = 'f'.repeat(40);
    const key = `${runId}${nul}${headSha}`;
    expect(key.split(nul)).toEqual([runId, headSha]);
    expect(runId.includes(nul)).toBe(false);
    expect(headSha.includes(nul)).toBe(false);
  });
});
