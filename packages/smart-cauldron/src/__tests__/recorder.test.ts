/**
 * recorder.test.ts -- Real writeRecord() coverage (no stubs).
 *
 * Rule 10 compliance: every test calls the REAL writeRecord() against the real
 * filesystem and asserts concrete outputs (file path, JSON content, slug structure).
 *
 * Stop condition 4 coverage: "a cascade-run record is written to
 * .archon/state/cascade-runs/" -- the path-construction and JSON-serialization
 * logic are verified here against real disk writes.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { writeRecord } from '../recorder.js';
import type { CascadeRunRecord } from '../types.js';
import { mkdir, rm, readFile, stat } from 'fs/promises';

const TEST_OUT_DIR = `/tmp/smart-cauldron-recorder-test-${Date.now()}`;

function makeRecord(overrides?: Partial<CascadeRunRecord>): CascadeRunRecord {
  return {
    cascadeId: 'abcd1234-efgh-5678-ijkl-000000000000',
    woId: 'WO-TEST-RECORDER-001',
    createdAt: '2026-06-30T12:00:00.000Z',
    status: 'won',
    winningTier: 'glm',
    attempts: [],
    totalCostUsd: null,
    telemetry: {
      entryTier: 'glm',
      climbed: false,
      climbCount: 0,
      wonCheap: true,
    },
    ...overrides,
  };
}

describe('writeRecord -- real filesystem writes', () => {
  beforeEach(async () => {
    await mkdir(TEST_OUT_DIR, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_OUT_DIR, { recursive: true, force: true });
  });

  test('returns a string path ending in cascade-record.json', async () => {
    const record = makeRecord();
    const path = await writeRecord(record, TEST_OUT_DIR);
    expect(typeof path).toBe('string');
    expect(path.endsWith('cascade-record.json')).toBe(true);
  });

  test('written file exists on disk (stat does not throw)', async () => {
    const record = makeRecord();
    const path = await writeRecord(record, TEST_OUT_DIR);
    const info = await stat(path);
    expect(info.isFile()).toBe(true);
  });

  test('written file contains valid JSON with correct cascadeId and woId', async () => {
    const record = makeRecord();
    const path = await writeRecord(record, TEST_OUT_DIR);
    const content = await readFile(path, 'utf8');
    const parsed = JSON.parse(content) as CascadeRunRecord;
    expect(parsed.cascadeId).toBe(record.cascadeId);
    expect(parsed.woId).toBe(record.woId);
  });

  test('written JSON preserves status, winningTier, and telemetry', async () => {
    const record = makeRecord({ status: 'blocked', winningTier: null });
    const path = await writeRecord(record, TEST_OUT_DIR);
    const content = await readFile(path, 'utf8');
    const parsed = JSON.parse(content) as CascadeRunRecord;
    expect(parsed.status).toBe('blocked');
    expect(parsed.winningTier).toBeNull();
    expect(parsed.telemetry.wonCheap).toBe(true);
  });

  test('written JSON ends with a newline character', async () => {
    const record = makeRecord();
    const path = await writeRecord(record, TEST_OUT_DIR);
    const content = await readFile(path, 'utf8');
    expect(content.endsWith('\n')).toBe(true);
  });

  test('slug embeds YYYY-MM-DD from createdAt', async () => {
    const record = makeRecord({ createdAt: '2026-06-30T12:00:00.000Z' });
    const path = await writeRecord(record, TEST_OUT_DIR);
    expect(path).toContain('2026-06-30');
  });

  test('slug embeds lowercased, slugified woId', async () => {
    const record = makeRecord({ woId: 'WO-TEST-RECORDER-001' });
    const path = await writeRecord(record, TEST_OUT_DIR);
    expect(path).toContain('wo-test-recorder-001');
  });

  test('slug embeds first 8 chars of cascadeId', async () => {
    const record = makeRecord({ cascadeId: 'abcd1234-xxxx-xxxx-xxxx-xxxxxxxxxxxx' });
    const path = await writeRecord(record, TEST_OUT_DIR);
    expect(path).toContain('abcd1234');
  });

  test('special characters in woId are replaced by dashes (no slashes, colons, spaces in slug)', async () => {
    const record = makeRecord({ woId: 'WO/SPEC:WEIRD CHARS 02' });
    const path = await writeRecord(record, TEST_OUT_DIR);
    // Extract just the slug directory name (second-to-last path component)
    const parts = path.split('/');
    const slugDir = parts[parts.length - 2] ?? '';
    // The slug itself must not contain raw special chars from the woId
    expect(slugDir).not.toContain('/');
    expect(slugDir).not.toContain(':');
    expect(slugDir).not.toContain(' ');
    // Verify it was lowercased and dashed
    expect(slugDir).toContain('wo');
    expect(slugDir).toContain('spec');
    expect(slugDir).toContain('weird');
  });

  test('two records with same woId but different cascadeId write to distinct paths', async () => {
    const r1 = makeRecord({ cascadeId: 'aaa11111-0000-0000-0000-000000000000' });
    const r2 = makeRecord({ cascadeId: 'bbb22222-0000-0000-0000-000000000000' });
    const p1 = await writeRecord(r1, TEST_OUT_DIR);
    const p2 = await writeRecord(r2, TEST_OUT_DIR);
    expect(p1).not.toBe(p2);
  });
});
