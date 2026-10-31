import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AdviceLedger } from './ledger';

const dirs: string[] = [];
const stores: AdviceLedger[] = [];
function open(file?: string): AdviceLedger {
  const dir = mkdtempSync(join(tmpdir(), 'xo-advice-test-'));
  dirs.push(dir);
  const store = new AdviceLedger(file ?? join(dir, 'pilot.sqlite'));
  stores.push(store);
  return store;
}
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const binding = { lease_id: 'lease-1', fencing_token: 1, principal_id: 'stage-xo' };

test('atomically reserves both legs and refuses a duplicate', () => {
  const s = open();
  s.admit('r1', 'hash1', binding, [300_000, 400_000]);
  expect(s.total()).toBe(700_000);
  expect(() => s.admit('r1', 'other-hash', binding, [1])).toThrow('duplicate_request');
  expect(() => s.admit('r2', 'hash2', binding, [400_000, 1])).toThrow('pilot_cap');
  expect(s.total()).toBe(700_000);
});
test('known charges settle; unsent reservations release; request stays non-replayable', () => {
  const s = open();
  s.admit('r1', 'h', binding, [300_000, 400_000]);
  s.started('r1', 0);
  s.settle('r1', 0, 10_000);
  s.finish('r1', { status: 'incomplete' });
  expect(s.total()).toBe(10_000);
  expect(() => s.admit('r1', 'h', binding, [1])).toThrow('duplicate_request');
});
test('unknown charges retain reserve and halt all requests across restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xo-advice-restart-'));
  dirs.push(dir);
  const file = join(dir, 'pilot.sqlite');
  const s = open(file);
  s.admit('r1', 'h', binding, [400_000]);
  s.started('r1', 0);
  s.settle('r1', 0, null);
  expect(() => s.started('r1', 0)).toThrow('campaign_halted');
  s.close();
  const reopened = open(file);
  expect(reopened.total()).toBe(400_000);
  expect(() => reopened.admit('r2', 'h2', binding, [1])).toThrow('campaign_halted');
});
test('a second ledger owner cannot run; crashed pending requests fail closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xo-advice-owner-'));
  dirs.push(dir);
  const file = join(dir, 'pilot.sqlite');
  const s = open(file);
  expect(() => new AdviceLedger(file)).toThrow();
  s.admit('r1', 'h', binding, [20_000]);
  s.close();
  const reopened = open(file);
  expect(() => reopened.admit('r2', 'h', binding, [1])).toThrow('campaign_halted');
});
test('refuses memory/relative storage and invalid monetary values', () => {
  expect(() => new AdviceLedger(':memory:')).toThrow();
  expect(() => new AdviceLedger('relative.sqlite')).toThrow();
  const s = open();
  expect(() => s.admit('r1', 'h', binding, [NaN])).toThrow();
  expect(() => s.admit('r1', 'h', binding, [-1])).toThrow();
});
