/**
 * M-153 identity separation: merge mutations use MERGE_MANAGER_GH_TOKEN when
 * set (distinct PAT identity), and fall back to shared resolution when unset.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import {
  hasDistinctMergeIdentity,
  MERGE_MANAGER_GH_TOKEN_ENV,
} from '../adapters/github-real-deps.js';

const ORIGINAL = process.env[MERGE_MANAGER_GH_TOKEN_ENV];

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env[MERGE_MANAGER_GH_TOKEN_ENV];
  else process.env[MERGE_MANAGER_GH_TOKEN_ENV] = ORIGINAL;
});

describe('merge identity seam (M-153)', () => {
  test('distinct identity reported when MERGE_MANAGER_GH_TOKEN is set', () => {
    process.env[MERGE_MANAGER_GH_TOKEN_ENV] = 'ghp_test_distinct';
    expect(hasDistinctMergeIdentity()).toBe(true);
  });

  test('no distinct identity when unset -- single-identity condition', () => {
    delete process.env[MERGE_MANAGER_GH_TOKEN_ENV];
    expect(hasDistinctMergeIdentity()).toBe(false);
  });
});
