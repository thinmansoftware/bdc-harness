import { describe, expect, test } from 'bun:test';
import { parseM31ActionPermit, permitFromMetadata } from '../permit';

const VALID = {
  permit_id: 'permit-1',
  proposal_id: 'proposal-1',
  execution_id: 'execution-1',
  repository: 'thinmansoftware/bdc-harness',
  pr_number: 42,
  head_sha: 'a'.repeat(40),
  base_branch: 'dev',
  base_sha: 'b'.repeat(40),
  snapshot_id: 'snapshot-1',
  action_kind: 'MERGE',
  capability: 'overseer.m31.merge',
  issued_at: '2026-07-15T11:59:00.000Z',
  valid_until: '2026-07-15T12:01:00.000Z',
};

describe('M31 permit parsing', () => {
  test('accepts the exact canonical metadata slot', () => {
    expect(permitFromMetadata({ overseer_m31_permit: VALID })).toEqual(VALID);
  });

  test('rejects malformed and unknown action identities', () => {
    expect(parseM31ActionPermit({ ...VALID, pr_number: '42' })).toBeNull();
    expect(parseM31ActionPermit({ ...VALID, action_kind: 'READY' })).toBeNull();
    expect(permitFromMetadata({ permit: VALID })).toBeNull();
  });
});
