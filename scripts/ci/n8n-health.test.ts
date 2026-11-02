// Unit tests for the n8n-health alert-dedup + persistence logic.
// (WO-INFRA-N8N-HEALTH-ALERT-DEDUP-AND-DB-FIX-01)
//
// These cover the pure decision/persistence helpers exported by
// ./n8n-health.js -- no live host, network, or Supabase dependency. The
// health-check TEST_CASES themselves are unchanged by this WO and are not
// re-tested here.
//
// Run standalone (NOT picked up by `bun run test`, which is workspace-scoped
// to packages/*):
//   bun test scripts/ci/n8n-health.test.ts

import { test, expect, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeSignature,
  decideNotification,
  readState,
  writeState,
  appendResultLine,
} from './n8n-health.js';

const tmp = mkdtempSync(join(tmpdir(), 'n8nhealth-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const HOUR = 3_600_000;
const DAY = 86_400_000;
const T0 = Date.parse('2026-07-19T00:00:00.000Z');

const failA = [{ name: 'case A', ok: false, error: 'boom A' }];
const failAB = [
  { name: 'case A', ok: false, error: 'boom A' },
  { name: 'case B', ok: false, error: 'boom B' },
];

test('computeSignature: empty for all-passing, stable regardless of order', () => {
  expect(computeSignature([])).toBe('');
  expect(computeSignature(null as unknown as [])).toBe('');
  const sig1 = computeSignature(failAB);
  const sig2 = computeSignature([failAB[1], failAB[0]]);
  expect(sig1).toBe(sig2);
  expect(sig1).not.toBe(computeSignature(failA));
  expect(sig1.length).toBe(64); // sha256 hex
});

// Test 1: repeated identical failure does not re-alert every cycle.
test('Test 1: same failure set within re-alert window is suppressed on later runs', () => {
  const sigA = computeSignature(failA);

  // Run 1: all-passing -> failing => new-failure alert.
  const state0 = {};
  const d1 = decideNotification(sigA, state0, T0, DAY);
  expect(d1).toBe('new-failure');

  // Persisted state after run 1's alert.
  const state1 = { signature: sigA, lastAlertAt: new Date(T0).toISOString() };

  // Run 2 (+6h) and run 3 (+12h): same failing set, within 24h => suppressed.
  expect(decideNotification(sigA, state1, T0 + 6 * HOUR, DAY)).toBe('suppress');
  expect(decideNotification(sigA, state1, T0 + 12 * HOUR, DAY)).toBe('suppress');

  // At/after the re-alert window (24h) the SAME failure re-alerts once.
  expect(decideNotification(sigA, state1, T0 + DAY, DAY)).toBe('re-alert');
});

// Test 2: a change in WHICH test cases fail triggers a fresh alert.
test('Test 2: changed failing set re-alerts even inside the window', () => {
  const sigA = computeSignature(failA);
  const sigAB = computeSignature(failAB);
  const state1 = { signature: sigA, lastAlertAt: new Date(T0).toISOString() };

  // Run 2 fails A AND B (signature changed) 6h later => fresh alert.
  expect(decideNotification(sigAB, state1, T0 + 6 * HOUR, DAY)).toBe('changed-failure');
});

// Test 3: recovery after a prior failure sends exactly one recovery notice.
test('Test 3: recovery fires once, then stays silent on subsequent passes', () => {
  const sigA = computeSignature(failA);
  const state1 = { signature: sigA, lastAlertAt: new Date(T0).toISOString() };

  // Run 2 passes 5/5 while a failure was outstanding => recovery.
  expect(decideNotification('', state1, T0 + 6 * HOUR, DAY)).toBe('recovery');

  // After recovery the persisted signature is cleared; further passes => none.
  const stateRecovered = { signature: '', lastRecoveryAt: new Date(T0 + 6 * HOUR).toISOString() };
  expect(decideNotification('', stateRecovered, T0 + 12 * HOUR, DAY)).toBe('none');
});

test('readState/writeState round-trip; missing or corrupt file returns {}', () => {
  const p = join(tmp, 'state-roundtrip.json');
  expect(readState(p)).toEqual({}); // missing file
  const payload = {
    signature: 'abc',
    lastAlertAt: '2026-07-19T00:00:00.000Z',
    failingNames: ['x'],
  };
  writeState(p, payload);
  expect(readState(p)).toEqual(payload);

  // Corrupt (non-JSON) file degrades to {} rather than throwing.
  const bad = join(tmp, 'state-bad.json');
  writeFileSync(bad, 'not json at all {');
  expect(readState(bad)).toEqual({});
});

// Test 4: results persistence no longer silently fails -- write then read back.
test('Test 4: appendResultLine persists a readable JSON-lines record', async () => {
  const logPath = join(tmp, 'health-results.jsonl');
  const record1 = {
    ts: '2026-07-19T00:00:00.000Z',
    suite: 'n8n-health',
    total: 5,
    passed: 5,
    failed: 0,
  };
  const record2 = {
    ts: '2026-07-19T06:00:00.000Z',
    suite: 'n8n-health',
    total: 5,
    passed: 4,
    failed: 1,
  };

  await appendResultLine(logPath, record1);
  await appendResultLine(logPath, record2);

  const raw = await readFile(logPath, 'utf8');
  const lines = raw.trim().split('\n');
  expect(lines.length).toBe(2);

  const parsed1 = JSON.parse(lines[0]);
  const parsed2 = JSON.parse(lines[1]);
  expect(parsed1).toEqual(record1);
  expect(parsed2.failed).toBe(1);
  expect(parsed2.passed).toBe(4);
});
