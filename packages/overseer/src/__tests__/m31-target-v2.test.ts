import { describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { prepareM31ActionPermitV2, createFailClosedM31CapabilityGateV2 } from '../m31-target-v2';
import type { M31ActionProposalV2, M31LiveObservationV2 } from '@archon/core/db/m31-target-v2';

const H = (value: string): string => createHash('sha256').update(value).digest('hex');
const target = {
  target_kind: 'issue' as const,
  repository: 'org/repo',
  issue_number: 12,
  provider_node_id: 'I_12',
  state: 'open',
  updated_at: '2026-07-16T12:00:00.000Z',
  is_pull_request: false as const,
};
const proposal: M31ActionProposalV2 = {
  proposal_id: 'm31v2-proposal-123e4567-e89b-42d3-a456-426614174000',
  repository: 'org/repo',
  target,
  target_key: 'org/repo:issue:12',
  target_digest: H(JSON.stringify(target)),
  snapshot_id: 'm31v2-snapshot-123e4567-e89b-42d3-a456-426614174001',
  evidence_path: 'evidence.json',
  evidence_git_blob: 'a'.repeat(40),
  action_kind: 'CLOSE',
  action_parameters: {},
  actor: 'xo',
  created_at: '2026-07-16T12:00:00.000Z',
  expires_at: '2026-07-16T12:15:00.000Z',
  execution_id: 'm31v2-execution-123e4567-e89b-42d3-a456-426614174002',
  capability: 'overseer.m31.close',
  policy_digest: H('policy'),
  verifier_registry_digest: H('registry'),
};
const observation: M31LiveObservationV2 = {
  known: true,
  target,
  policy_digest: proposal.policy_digest,
  verifier_registry_digest: proposal.verifier_registry_digest,
  observed_at: '2026-07-16T12:00:00.000Z',
};

describe('prepareM31ActionPermitV2', () => {
  test('uses only injected read and compare dependencies and exposes no effect callback', async () => {
    let reads = 0;
    let compares = 0;
    const result = await prepareM31ActionPermitV2(
      { proposal_id: proposal.proposal_id },
      {
        getProposal: async () => proposal,
        liveStateReader: {
          readBoundState: async value => {
            expect(value).toEqual(proposal);
            reads++;
            return observation;
          },
        },
        capabilityGate: createFailClosedM31CapabilityGateV2(),
        compareAndConsume: async input => {
          compares++;
          expect(input.observation).toEqual(observation);
          return {
            ok: true,
            permit: {
              permit_id: 'receipt-1',
              proposal_id: proposal.proposal_id,
              execution_id: proposal.execution_id,
              repository: proposal.repository,
              target: proposal.target,
              target_key: proposal.target_key,
              target_digest: proposal.target_digest,
              snapshot_id: proposal.snapshot_id,
              action_kind: proposal.action_kind,
              capability: proposal.capability,
              issued_at: observation.observed_at,
              valid_until: '2026-07-16T12:01:00.000Z',
            },
            receipt: {} as never,
          };
        },
      }
    );
    expect(result.ok).toBe(true);
    expect(reads).toBe(1);
    expect(compares).toBe(1);
    if (result.ok) expect('execute' in result.permit).toBe(false);
  });

  test('fails before compare when the capability or digest is malformed', async () => {
    let compares = 0;
    const result = await prepareM31ActionPermitV2(
      { proposal_id: proposal.proposal_id },
      {
        getProposal: async () => ({ ...proposal, capability: 'overseer.m31.merge' }),
        liveStateReader: { readBoundState: async () => observation },
        capabilityGate: createFailClosedM31CapabilityGateV2(),
        compareAndConsume: async () => {
          compares++;
          throw new Error('must not run');
        },
      }
    );
    expect(result).toEqual({
      ok: false,
      denied: { capability: 'overseer.m31.merge', reason: 'capability_mismatch' },
    });
    expect(compares).toBe(0);
  });
});
